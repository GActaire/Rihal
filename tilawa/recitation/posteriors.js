import { BLANK_ID, TOKENS } from "./tokens.js";
export class FramePosteriors {
    classes;
    capacity;
    data;
    best;
    bestId;
    start = 0;
    end = 0;
    constructor(classes, capacity = 1500){
        this.classes = classes;
        this.capacity = capacity;
        this.data = new Float32Array(classes * capacity);
        this.best = new Float32Array(capacity);
        this.bestId = new Int32Array(capacity);
    }
    push(logProbs, frames, firstFrame) {
        if (firstFrame !== this.end) this.clear(firstFrame);
        const c = this.classes;
        for(let t = 0; t < frames; t++){
            const slot = this.end % this.capacity;
            let mx = -Infinity;
            let arg = 0;
            for(let k = 0; k < c; k++){
                const v = logProbs[t * c + k];
                this.data[slot * c + k] = v;
                if (v > mx) {
                    mx = v;
                    arg = k;
                }
            }
            this.best[slot] = mx;
            this.bestId[slot] = arg;
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
    get firstFrame() {
        return this.start;
    }
    get endFrame() {
        return this.end;
    }
    logp(frame, id) {
        return this.data[frame % this.capacity * this.classes + id];
    }
    bestLogp(frame) {
        return this.best[frame % this.capacity];
    }
    argmax(frame) {
        return this.bestId[frame % this.capacity];
    }
}
const TOKEN_ID = new Map(TOKENS.map((t, i)=>[
        t,
        i
    ]));
const MAX_TOKEN = Math.max(...TOKENS.filter((t)=>t !== "<blank>").map((t)=>[
        ...t
    ].length));
export function encodePhonemes(text) {
    return encodePhonemeSpan(text, 0, text.length);
}
export function encodePhonemeSpan(text, from, to) {
    const chars = [
        ...text
    ];
    const ids = [];
    let i = 0;
    while(i < chars.length){
        let hit = -1;
        let len = 0;
        for(let L = Math.min(MAX_TOKEN, chars.length - i); L > 0; L--){
            const id = TOKEN_ID.get(chars.slice(i, i + L).join(""));
            if (id !== undefined) {
                hit = id;
                len = L;
                break;
            }
        }
        if (hit < 0) return null;
        if (i < to && i + len > from) ids.push(hit);
        i += len;
    }
    return ids;
}
export function forcedLogLik(post, ids, from, to, blank = BLANK_ID) {
    const L = ids.length;
    const S = 2 * L + 1;
    if (to <= from) return L === 0 ? 0 : -Infinity;
    const ext = new Int32Array(S);
    for(let s = 0; s < S; s++)ext[s] = s % 2 === 1 ? ids[s - 1 >> 1] : blank;
    let prev = new Float64Array(S).fill(-Infinity);
    let next = new Float64Array(S);
    prev[0] = post.logp(from, ext[0]);
    if (S > 1) prev[1] = post.logp(from, ext[1]);
    for(let t = from + 1; t < to; t++){
        for(let s = 0; s < S; s++){
            let m = prev[s];
            if (s >= 1 && prev[s - 1] > m) m = prev[s - 1];
            if (s >= 2 && ext[s] !== blank && ext[s] !== ext[s - 2] && prev[s - 2] > m) m = prev[s - 2];
            next[s] = m === -Infinity ? -Infinity : m + post.logp(t, ext[s]);
        }
        [prev, next] = [
            next,
            prev
        ];
    }
    return L === 0 ? prev[0] : Math.max(prev[S - 1], prev[S - 2]);
}
export function freeLogLik(post, from, to) {
    let s = 0;
    for(let t = from; t < to; t++)s += post.bestLogp(t);
    return s;
}
export const GOP_FLOOR = -20;
const floor = (x)=>Number.isFinite(x) ? Math.max(GOP_FLOOR, x) : GOP_FLOOR;
export function pairScores(post, wordTokens, once, twice, from, to) {
    if (!wordTokens || !once.length || !post.has(from, to)) return null;
    const free = freeLogLik(post, from, to);
    const one = forcedLogLik(post, once, from, to);
    const two = forcedLogLik(post, twice, from, to);
    const clamp = (x)=>Math.max(GOP_FLOOR, Math.min(-GOP_FLOOR, x));
    const repGain = !Number.isFinite(two) ? GOP_FLOOR : !Number.isFinite(one) ? -GOP_FLOOR : clamp((two - one) / wordTokens);
    return {
        repGain,
        pairGop: floor((one - free) / wordTokens)
    };
}
export function wordGop(post, ids, from, to) {
    if (!ids.length || !post.has(from, to)) return null;
    const free = freeLogLik(post, from, to);
    const n = ids.length;
    return {
        gop: floor((forcedLogLik(post, ids, from, to) - free) / n),
        gopTwice: floor((forcedLogLik(post, [
            ...ids,
            ...ids
        ], from, to) - free) / n),
        gopNone: floor((forcedLogLik(post, [], from, to) - free) / n)
    };
}


//# sourceURL=recitation/posteriors.ts