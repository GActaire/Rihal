import BUNDLED from "./slip-weights.json.js";
export const ENCODER_DIM = 512;
export const SLIP_PAD = 1;
export const SLIP_SPAN_CAP = 80;
export class EncoderFrames {
    dim;
    capacity;
    data;
    start = 0;
    end = 0;
    constructor(dim = ENCODER_DIM, capacity = 20000){
        this.dim = dim;
        this.capacity = capacity;
        this.data = new Float32Array(dim * capacity);
    }
    get firstFrame() {
        return this.start;
    }
    get endFrame() {
        return this.end;
    }
    push(rows, frames, firstFrame) {
        if (firstFrame !== this.end) this.clear(firstFrame);
        const d = this.dim;
        for(let t = 0; t < frames; t++){
            const slot = this.end % this.capacity;
            const base = slot * d;
            const src = t * d;
            for(let k = 0; k < d; k++)this.data[base + k] = rows[src + k] ?? 0;
            this.end++;
            if (this.end - this.start > this.capacity) this.start = this.end - this.capacity;
        }
    }
    clear(at = 0) {
        this.start = at;
        this.end = at;
    }
    has(from, to) {
        return from >= this.start && to <= this.end && from <= to;
    }
    row(frame, into, offset) {
        const base = frame % this.capacity * this.dim;
        for(let k = 0; k < this.dim; k++)into[offset + k] = this.data[base + k];
    }
}
export function slipHeadFromJson(raw) {
    const n = ENCODER_DIM * 2;
    if (raw.mu.length !== n || raw.sd.length !== n || raw.coef.length !== n) {
        throw new Error(`slip head expects ${n} features, got mu ${raw.mu.length}`);
    }
    return {
        mu: Float32Array.from(raw.mu),
        sd: Float32Array.from(raw.sd),
        coef: Float32Array.from(raw.coef),
        intercept: raw.intercept,
        strict: raw.thresholds.strict,
        high: raw.thresholds.high
    };
}
export const A0W_SLIP_HEAD = slipHeadFromJson(BUNDLED);
export function slipThreshold(head, sensitivity) {
    return sensitivity === "high" ? head.high : head.strict;
}
export function poolEncoderSpan(enc, a, b, pad = SLIP_PAD) {
    if (b < a) {
        const t = a;
        a = b;
        b = t;
    }
    if (b - a > SLIP_SPAN_CAP) {
        const mid = a + b >> 1;
        a = mid - SLIP_SPAN_CAP / 2;
        b = mid + SLIP_SPAN_CAP / 2;
    }
    const lo = Math.max(0, a - pad);
    const hi = Math.min(enc.endFrame, Math.max(lo + 1, b + pad));
    if (hi <= lo || !enc.has(lo, hi)) return null;
    const dim = enc.dim;
    const mean = new Float32Array(dim);
    const max = new Float32Array(dim);
    max.fill(-Infinity);
    const row = new Float32Array(dim);
    const n = hi - lo;
    for(let t = lo; t < hi; t++){
        enc.row(t, row, 0);
        for(let k = 0; k < dim; k++){
            const v = row[k];
            mean[k] += v;
            if (v > max[k]) max[k] = v;
        }
    }
    for(let k = 0; k < dim; k++)mean[k] /= n;
    return {
        mean,
        max
    };
}
export function slipProbability(head, mean, max) {
    let logit = head.intercept;
    const n = mean.length;
    for(let i = 0; i < n; i++){
        const sd = head.sd[i];
        logit += (mean[i] - head.mu[i]) / (sd === 0 ? 1 : sd) * head.coef[i];
    }
    for(let i = 0; i < n; i++){
        const j = n + i;
        const sd = head.sd[j];
        logit += (max[i] - head.mu[j]) / (sd === 0 ? 1 : sd) * head.coef[j];
    }
    if (logit >= 0) return 1 / (1 + Math.exp(-logit));
    const z = Math.exp(logit);
    return z / (1 + z);
}
export function wordSpansFromTrail(tracker) {
    const words = new Map();
    const n = Math.min(tracker.heard.length, tracker.trail.length);
    for(let i = 0; i < n; i++){
        const cell = tracker.trail[i];
        const local = cell <= 0 ? 0 : tracker.localWordOfPos[Math.min(cell, tracker.len) - 1];
        const w = tracker.firstWord + local;
        let fs = words.get(w);
        if (!fs) words.set(w, fs = []);
        fs.push(tracker.heard[i].frame);
    }
    const order = [
        ...words.keys()
    ].sort((p, q)=>{
        const fp = words.get(p);
        const fq = words.get(q);
        return Math.min(...fp) - Math.min(...fq);
    });
    const c = tracker.corpus;
    const span = (w, a, b, skipped)=>({
            surah: c.wordSurah[w],
            ayah: c.wordAyah[w],
            word: c.wordInAyah[w],
            wordIndex: w,
            a,
            b,
            skipped
        });
    const out = [];
    for(let i = 0; i < order.length; i++){
        const w = order[i];
        const fs = words.get(w);
        let a = Infinity;
        let b = -Infinity;
        for (const fr of fs){
            if (fr < a) a = fr;
            if (fr > b) b = fr;
        }
        b += 1;
        out.push(span(w, a, b, false));
        if (i + 1 >= order.length) continue;
        const nxt = order[i + 1];
        if (c.wordSurah[nxt] !== c.wordSurah[w] || c.wordAyah[nxt] !== c.wordAyah[w]) continue;
        const nskip = c.wordInAyah[nxt] - c.wordInAyah[w] - 1;
        if (nskip <= 0 || nxt !== w + nskip + 1) continue;
        const gapA = b;
        const nfs = words.get(nxt);
        let gapB = Infinity;
        for (const fr of nfs)if (fr < gapB) gapB = fr;
        const width = Math.max(nskip, gapB - gapA);
        for(let j = 0; j < nskip; j++){
            let sa = gapA + Math.floor(width * j / nskip);
            let sb = gapA + Math.floor(width * (j + 1) / nskip);
            if (sb <= sa) sb = sa + 1;
            out.push(span(w + 1 + j, sa, sb, true));
        }
    }
    return out;
}


//# sourceURL=recitation/slipHead.ts