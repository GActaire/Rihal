export const SHORT_VOWEL_ORDER = [
    "\u064e",
    "\u064f",
    "\u0650"
];
export class GreedyCtcDecoder {
    symbols;
    blank;
    siblings;
    previousBest;
    frameIndex = 0;
    run = null;
    constructor(symbols, blank){
        this.symbols = symbols;
        this.blank = blank;
        this.previousBest = blank;
        const byText = new Map(symbols.map((s, i)=>[
                s,
                i
            ]));
        this.siblings = symbols.map((sym)=>{
            const last = sym[sym.length - 1] ?? "";
            if (!SHORT_VOWEL_ORDER.includes(last)) return null;
            const stem = sym.slice(0, -1);
            const ids = new Int32Array(3);
            for(let k = 0; k < 3; k++)ids[k] = byText.get(stem + SHORT_VOWEL_ORDER[k]) ?? -1;
            return ids;
        });
    }
    get framesDecoded() {
        return this.frameIndex;
    }
    get pendingFrame() {
        return this.run ? this.run.frame : null;
    }
    reset() {
        this.previousBest = this.blank;
        this.frameIndex = 0;
        this.run = null;
    }
    consume(logProbs, frames, classes) {
        const out = [];
        for(let t = 0; t < frames; t++){
            const row = t * classes;
            let best = 0;
            let p1 = logProbs[row];
            let p2 = -Infinity;
            for(let c = 1; c < classes; c++){
                const p = logProbs[row + c];
                if (p > p1) {
                    p2 = p1;
                    p1 = p;
                    best = c;
                } else if (p > p2) {
                    p2 = p;
                }
            }
            const sib = best !== this.blank ? this.siblings[best] : null;
            let vowels = null;
            if (sib) {
                vowels = [
                    0,
                    0,
                    0
                ];
                for(let k = 0; k < 3; k++){
                    const id = sib[k];
                    vowels[k] = id >= 0 ? Math.exp(logProbs[row + id]) : 0;
                }
            }
            this.step(best, p1, p2, vowels, out);
        }
        return out;
    }
    flush() {
        const out = [];
        if (this.run) {
            out.push(this.emit(this.run));
            this.run = null;
        }
        this.previousBest = this.blank;
        return out;
    }
    step(best, p1, p2, vowels, out) {
        const blank = this.blank;
        if (best !== blank && best !== this.previousBest) {
            if (this.run) out.push(this.emit(this.run));
            this.run = {
                id: best,
                frame: this.frameIndex,
                p1,
                p2,
                vowels
            };
        } else if (best !== blank && best === this.previousBest && this.run && p1 > this.run.p1) {
            this.run.p1 = p1;
            this.run.p2 = p2;
            this.run.vowels = vowels;
        } else if (best === blank && this.run) {
            out.push(this.emit(this.run));
            this.run = null;
        }
        this.previousBest = best;
        this.frameIndex++;
    }
    emit(run) {
        const token = {
            sym: this.symbols[run.id] ?? "",
            frame: run.frame,
            margin: Math.exp(run.p1) - Math.exp(run.p2)
        };
        if (run.vowels) token.vowels = run.vowels;
        return token;
    }
}
export function expandTokens(tokens) {
    const out = [];
    for (const t of tokens){
        const chars = [
            ...t.sym
        ];
        for(let i = 0; i < chars.length; i++){
            const hc = {
                ch: chars[i],
                frame: t.frame,
                margin: t.margin
            };
            if (t.vowels && i === chars.length - 1) hc.vowels = t.vowels;
            out.push(hc);
        }
    }
    return out;
}


//# sourceURL=recitation/ctcDecoder.ts