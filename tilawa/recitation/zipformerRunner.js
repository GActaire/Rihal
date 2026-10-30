export function defaultExecutionProviders(ort) {
    const runtime = ort;
    const listed = runtime?.listSupportedBackends?.();
    if (Array.isArray(listed) && listed.length > 0) {
        const names = new Set(listed.map((b)=>b.name));
        if (names.has("wasm")) return [
            "wasm"
        ];
        if (names.has("cpu")) return [
            "cpu"
        ];
    }
    return runtime?.env?.wasm != null ? [
        "wasm"
    ] : [
        "cpu"
    ];
}
export function prepareOrtWasm(ort) {
    const wasm = ort?.env?.wasm;
    if (!wasm) return;
    if (typeof wasm.numThreads !== "number" || !Number.isInteger(wasm.numThreads) || wasm.numThreads <= 0) {
        wasm.numThreads = 1;
    }
}
function numel(dims) {
    let n = 1;
    for (const d of dims)n *= d;
    return n;
}
function int64Zeros(n) {
    if (typeof BigInt64Array === "undefined") {
        throw new Error("BigInt64Array is unavailable, so the model's int64 cache states cannot " + "be built. On React Native this means Hermes without BigInt support — " + "upgrade to React Native >= 0.70 or enable BigInt in the Hermes build.");
    }
    return new BigInt64Array(n);
}
export class ZipformerRunner {
    io;
    leftoverFrames = 0;
    processedLens = 0n;
    session;
    Tensor;
    buffer = [];
    states = new Map();
    stateNames = [];
    constructor(session, io, Tensor){
        this.session = session;
        this.io = io;
        this.Tensor = Tensor;
        for (const inp of io.inputs){
            if (inp.name === "x") continue;
            this.stateNames.push(inp.name);
        }
        this.initStates();
    }
    static async create(ort, model, io, executionProviders) {
        const runtime = ort;
        prepareOrtWasm(runtime);
        const session = await runtime.InferenceSession.create(model, {
            executionProviders: executionProviders ?? defaultExecutionProviders(runtime),
            graphOptimizationLevel: "all"
        });
        const runner = new ZipformerRunner(session, io, runtime.Tensor);
        return runner;
    }
    static fromSession(session, io, Tensor) {
        return new ZipformerRunner(session, io, Tensor);
    }
    reset() {
        this.buffer.length = 0;
        this.leftoverFrames = 0;
        this.processedLens = 0n;
        this.initStates();
    }
    async accept(frames) {
        for (const f of frames)this.buffer.push(f);
        const T = this.io.T;
        const hop = this.io.hop;
        const dim = this.io.featureDim;
        const vocab = this.io.vocabSize;
        const encName = this.io.encoderFrames;
        const chunks = [];
        const encChunks = [];
        let encDim = 0;
        while(this.buffer.length >= T){
            const x = new Float32Array(T * dim);
            for(let t = 0; t < T; t++)x.set(this.buffer[t], t * dim);
            const feeds = {
                x: new this.Tensor("float32", x, [
                    1,
                    T,
                    dim
                ])
            };
            for (const name of this.stateNames)feeds[name] = this.states.get(name);
            const out = await this.session.run(feeds);
            const lp = out.log_probs;
            if (!lp) throw new Error("model output missing log_probs");
            const data = lp.data instanceof Float32Array ? lp.data : new Float32Array(lp.data);
            const F = lp.dims.length >= 2 ? Number(lp.dims[1]) : data.length / vocab;
            chunks.push(data.slice(0, F * vocab));
            if (encName && out[encName]) {
                const enc = out[encName];
                const raw = enc.data instanceof Float32Array ? enc.data : new Float32Array(enc.data);
                const width = enc.dims.length >= 3 ? Number(enc.dims[enc.dims.length - 1]) : 0;
                const rows = enc.dims.length >= 2 ? Number(enc.dims[1]) : width > 0 ? raw.length / width : 0;
                if (width > 0 && rows > 0) {
                    encDim = width;
                    encChunks.push(raw.slice(0, rows * width));
                }
            }
            for (const name of this.stateNames){
                const neu = out[`new_${name}`];
                if (!neu) throw new Error(`model missing new_${name}`);
                this.states.set(name, neu);
            }
            const pl = this.states.get("processed_lens");
            if (pl && pl.data instanceof BigInt64Array) this.processedLens = pl.data[0] ?? 0n;
            else if (pl) this.processedLens = BigInt(Number(pl.data[0]));
            this.buffer.splice(0, hop);
        }
        this.leftoverFrames = this.buffer.length;
        if (chunks.length === 0) return {
            logProbs: new Float32Array(0),
            frames: 0
        };
        let total = 0;
        for (const c of chunks)total += c.length;
        const logProbs = new Float32Array(total);
        let o = 0;
        for (const c of chunks){
            logProbs.set(c, o);
            o += c.length;
        }
        const got = {
            logProbs,
            frames: total / vocab
        };
        if (encChunks.length && encDim > 0) {
            let n = 0;
            for (const c of encChunks)n += c.length;
            const encoder = new Float32Array(n);
            let e = 0;
            for (const c of encChunks){
                encoder.set(c, e);
                e += c.length;
            }
            got.encoder = encoder;
            got.encoderFrames = n / encDim;
        }
        return got;
    }
    initStates() {
        this.states.clear();
        for (const inp of this.io.inputs){
            if (inp.name === "x") continue;
            const n = numel(inp.dims);
            if (inp.dtype === "int64") {
                this.states.set(inp.name, new this.Tensor("int64", int64Zeros(n), inp.dims));
            } else {
                this.states.set(inp.name, new this.Tensor("float32", new Float32Array(n), inp.dims));
            }
        }
    }
}


//# sourceURL=recitation/zipformerRunner.ts