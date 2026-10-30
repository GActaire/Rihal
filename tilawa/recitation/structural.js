import { costTable, TABLE_SIZE } from "./phonemeCost.js";
import { BASMALA, ISTIADHA } from "./search.js";
export const AYAH_ORDER_PARAMS = {
    gap: 12,
    minChars: 3,
    garbage: 0.5,
    wcost: 0.5,
    restart: 2.0,
    jump: 0.5,
    back: 1,
    ahead: 4
};
export const AYAH_ORDER_RULE = {
    margin: 99,
    rel: 0.04,
    fit: 0.3,
    between: 8,
    minPost: 0,
    noIdent: true
};
export const AYAH_ORDER_RULE_GUARDED = {
    ...AYAH_ORDER_RULE,
    noRestartPre: true,
    restartAlt: 0.3,
    betweenRel: 0.2
};
export const SIMILAR_VERSE_RULE = {
    lookalike: 3.5,
    drop: 10,
    maxSpan: 1,
    loc: 0.25,
    ayahFit: 0.5
};
const PREAMBLES = [
    ISTIADHA,
    BASMALA,
    ISTIADHA + BASMALA
];
const REPLACE = 0;
const INSERT = 2;
const SKIP = 0.5;
const COST = costTable().matrix;
export function pyRound(x, nd) {
    if (!Number.isFinite(x)) return x;
    const exact = Math.abs(x).toFixed(30);
    const dot = exact.indexOf(".");
    const tail = exact.slice(dot + 1 + nd);
    let r = Number(Math.abs(x).toFixed(nd));
    if (tail[0] === "5" && /^50*$/.test(tail)) {
        const digits = exact.slice(0, dot) + exact.slice(dot + 1, dot + 1 + nd);
        const even = Number(digits[digits.length - 1]) % 2 === 0;
        r = (Number(digits) + (even ? 0 : 1)) / 10 ** nd;
    }
    return x < 0 ? -r : r;
}
const encode = (text)=>costTable().encode(text);
export function spanCosts(q, ref, ws, maxRatio = 2.0, slack = 12.0) {
    const nw = ws.length - 1;
    const n = q.length;
    const out = new Float64Array(nw * nw).fill(Infinity);
    const prev = new Float64Array(ref.length + 1);
    const cur = new Float64Array(ref.length + 1);
    const lim = Math.trunc(n * maxRatio + slack);
    for(let i = 0; i < nw; i++){
        const r0 = ws[i];
        const m = Math.min(ref.length - r0, lim);
        if (m <= 0) continue;
        for(let j = 0; j <= m; j++)prev[j] = j;
        for(let a = 1; a <= n; a++){
            cur[0] = a;
            const row = q[a - 1] * TABLE_SIZE;
            for(let j = 1; j <= m; j++){
                let c = prev[j - 1] + COST[row + ref[r0 + j - 1]];
                const u = prev[j] + 1;
                if (u < c) c = u;
                const lf = cur[j - 1] + 1;
                if (lf < c) c = lf;
                cur[j] = c;
            }
            for(let j = 0; j <= m; j++)prev[j] = cur[j];
        }
        for(let e = i; e < nw; e++){
            const L = ws[e + 1] - r0;
            if (L > m) break;
            out[i * nw + e] = prev[L];
        }
    }
    return out;
}
export function globalCost(q, r) {
    const m = r.length;
    let prev = new Float64Array(m + 1);
    let cur = new Float64Array(m + 1);
    for(let j = 0; j <= m; j++)prev[j] = j;
    for(let a = 1; a <= q.length; a++){
        cur[0] = a;
        const row = q[a - 1] * TABLE_SIZE;
        for(let j = 1; j <= m; j++){
            let c = prev[j - 1] + COST[row + r[j - 1]];
            const u = prev[j] + 1;
            if (u < c) c = u;
            const lf = cur[j - 1] + 1;
            if (lf < c) c = lf;
            cur[j] = c;
        }
        [prev, cur] = [
            cur,
            prev
        ];
    }
    return prev[m];
}
export function segmentTokens(tokens, gap, minChars) {
    const toks = [
        ...tokens
    ].sort((a, b)=>a.frame - b.frame);
    const segs = [];
    for (const { sym, frame, t } of toks){
        const last = segs[segs.length - 1];
        if (last && frame - last.f1 < gap) {
            last.text += sym;
            last.f1 = frame;
            last.t = Math.max(last.t, t);
        } else segs.push({
            text: sym,
            f0: frame,
            f1: frame,
            t
        });
    }
    const out = [];
    for (const s of segs){
        const last = out[out.length - 1];
        if (last && s.text.length < minChars) {
            last.text += s.text;
            last.f1 = s.f1;
            last.t = Math.max(last.t, s.t);
        } else out.push(s);
    }
    if (out.length > 1 && out[0].text.length < minChars) {
        out[1].text = out[0].text + out[1].text;
        out[1].f0 = out[0].f0;
        out.shift();
    }
    return out;
}
function chain(inp, free) {
    const { costs, pre, segLen, wordsAyah, wlenCum, ayahFirst, ayahLast, p } = inp;
    const nw = wordsAyah.length;
    const T = new Float64Array((nw + 1) * nw).fill(Infinity);
    for(let i = 0; i < nw; i++)T[nw * nw + i] = 0;
    const skipped = new Map();
    for(let pe = 0; pe < nw; pe++){
        const nxt = pe + 1;
        for(let i = 0; i < nw; i++){
            if (i <= pe) {
                T[pe * nw + i] = p.restart;
                continue;
            }
            const full = [];
            for(let x = 0; x < ayahFirst.length; x++)if (ayahFirst[x] >= nxt && ayahLast[x] < i) full.push(x);
            const gapChars = wlenCum[i] - wlenCum[nxt];
            if (!full.length) T[pe * nw + i] = p.wcost * gapChars;
            else if (free) {
                let fullChars = 0;
                for (const x of full)fullChars += wlenCum[ayahLast[x] + 1] - wlenCum[ayahFirst[x]];
                T[pe * nw + i] = p.jump + p.wcost * (gapChars - fullChars);
                skipped.set(pe * nw + i, full);
            }
        }
    }
    let cur = new Float64Array(nw + 1).fill(Infinity);
    cur[nw] = 0;
    const back = [];
    const A = new Float64Array(nw);
    const Aarg = new Int32Array(nw);
    for(let k = 0; k < costs.length; k++){
        const C = costs[k];
        for(let i = 0; i < nw; i++){
            let best = cur[0] + T[i];
            let arg = 0;
            for(let s = 1; s <= nw; s++){
                const v = cur[s] + T[s * nw + i];
                if (v < best) {
                    best = v;
                    arg = s;
                }
            }
            A[i] = best;
            Aarg[i] = arg;
        }
        const next = new Float64Array(nw + 1).fill(Infinity);
        const bp = new Array(nw + 1).fill(null);
        for(let e = 0; e < nw; e++){
            let best = A[0] + C[e];
            let bi = 0;
            for(let i = 1; i < nw; i++){
                const v = A[i] + C[i * nw + e];
                if (v < best) {
                    best = v;
                    bi = i;
                }
            }
            next[e] = best;
            if (Number.isFinite(best)) bp[e] = {
                k: "m",
                i: bi,
                s: Aarg[bi]
            };
        }
        const g = p.garbage * segLen[k];
        for(let s = 0; s <= nw; s++){
            if (cur[s] + g < next[s]) {
                next[s] = cur[s] + g;
                bp[s] = {
                    k: "g",
                    s
                };
            }
        }
        if (cur[nw] + pre[k] < next[nw]) {
            next[nw] = cur[nw] + pre[k];
            bp[nw] = {
                k: "p",
                s: nw
            };
        }
        back.push(bp);
        cur = next;
    }
    let end = 0;
    for(let s = 1; s <= nw; s++)if (cur[s] < cur[end]) end = s;
    const best = cur[end];
    const path = [];
    let s = end;
    for(let k = costs.length - 1; k >= 0; k--){
        const b = back[k][s];
        if (!b) return {
            best,
            path: [],
            skipped
        };
        if (b.k === "m") {
            path.push({
                kind: "m",
                i: b.i,
                e: s
            });
            s = b.s;
        } else {
            path.push({
                kind: b.k
            });
            s = b.s;
        }
    }
    path.reverse();
    return {
        best,
        path,
        skipped
    };
}
export class StructuralRules {
    corpus;
    looks = new Map();
    ident;
    phCache = new Map();
    segCache = new Map();
    constructor(corpus, index){
        this.corpus = corpus;
        for (const [key, rows] of Object.entries(index.pairs)){
            this.looks.set(key, rows.map((r)=>{
                const regions = [];
                for(let x = 2; x + 4 < r.length; x += 5)regions.push([
                    r[x],
                    r[x + 1],
                    r[x + 2],
                    r[x + 3],
                    r[x + 4]
                ]);
                return {
                    m: [
                        r[0],
                        r[1]
                    ],
                    regions
                };
            }));
        }
        this.ident = new Set(index.ident);
    }
    has(s, a) {
        return this.corpus.hasAyah(s, a);
    }
    ph(s, a) {
        const key = `${s}:${a}`;
        let w = this.phCache.get(key);
        if (!w) {
            const first = this.corpus.ayahFirstWord(s, a);
            const n = this.corpus.ayahWordCount(s, a);
            w = Array.from({
                length: n
            }, (_, i)=>this.corpus.wordPhonemes(first + i));
            this.phCache.set(key, w);
        }
        return w;
    }
    lookalikes(s, a) {
        return this.looks.get(`${s}:${a}`) ?? [];
    }
    identGuarded(s, a) {
        return this.ident.has(`${s}:${a}`);
    }
    ayahOrderWindow(expected, firstVerse, p = AYAH_ORDER_PARAMS) {
        if (expected) {
            const s = expected.surah;
            const out = [];
            for(let a = expected.ayah; a <= (expected.ayahEnd ?? expected.ayah); a++)if (this.has(s, a)) out.push([
                s,
                a
            ]);
            return out;
        }
        if (!firstVerse) return [];
        const [s, a] = firstVerse;
        const out = [];
        for(let x = Math.max(1, a - p.back); x <= a + p.ahead; x++)if (this.has(s, x)) out.push([
            s,
            x
        ]);
        return out;
    }
    ayahOrderCandidate(tokens, win, p = AYAH_ORDER_PARAMS) {
        if (win.length < 3 || tokens.length < 4) return null;
        const segs = segmentTokens(tokens, p.gap, p.minChars);
        if (segs.length < 2) return null;
        const words = [];
        const wordsAyah = [];
        const ayahFirst = [];
        const ayahLast = [];
        win.forEach(([s, a], x)=>{
            ayahFirst.push(words.length);
            for (const w of this.ph(s, a)){
                words.push(w);
                wordsAyah.push(x);
            }
            ayahLast.push(words.length - 1);
        });
        const wlenCum = [
            0
        ];
        for (const w of words)wlenCum.push(wlenCum[wlenCum.length - 1] + w.length);
        const ws = Int32Array.from(wlenCum);
        const winKey = win.map(([s, a])=>`${s}:${a}`).join(",");
        let ref = null;
        const costs = [];
        const pre = [];
        const segLen = [];
        for (const s of segs){
            const key = `${winKey}|${s.text}`;
            let hit = this.segCache.get(key);
            if (!hit) {
                const q = encode(s.text);
                ref ??= encode(words.join(""));
                let best = Infinity;
                for (const ph of PREAMBLES)best = Math.min(best, globalCost(q, encode(ph)));
                hit = {
                    costs: spanCosts(q, ref, ws),
                    pre: best,
                    len: q.length
                };
                if (this.segCache.size > 4096) this.segCache.clear();
                this.segCache.set(key, hit);
            }
            costs.push(hit.costs);
            pre.push(hit.pre);
            segLen.push(hit.len);
        }
        const inp = {
            costs,
            pre,
            segLen,
            wordsAyah,
            wlenCum,
            ayahFirst,
            ayahLast,
            p
        };
        const cIn = chain(inp, false).best;
        const { best: cFree, path, skipped } = chain(inp, true);
        const out = {
            margin: pyRound(cIn - cFree, 3),
            jumps: [],
            segs: segs.length
        };
        if (!path.length || !Number.isFinite(cFree)) return out;
        const nw = words.length;
        const matched = [];
        path.forEach((st, k)=>{
            if (st.kind === "m") matched.push({
                k,
                i: st.i,
                e: st.e
            });
        });
        for(let n = 0; n + 1 < matched.length; n++){
            const { k: k0, i: i0, e: e0 } = matched[n];
            const { k: k1, i: i1, e: e1 } = matched[n + 1];
            const full = skipped.get(e0 * nw + i1);
            if (!full) continue;
            let preRestart = false;
            for(let x = 0; x < n; x++)if (matched[x].e >= i0) preRestart = true;
            preRestart &&= e0 === ayahLast[wordsAyah[e0]];
            let between = 0;
            for(let k = k0 + 1; k < k1; k++)between += segLen[k];
            const later = new Set();
            for (const m of matched)if (m.k >= k1) for(let w = m.i; w <= m.e; w++)later.add(wordsAyah[w]);
            const fit0 = costs[k0][i0 * nw + e0] / Math.max(1, segLen[k0]);
            const fit1 = costs[k1][i1 * nw + e1] / Math.max(1, segLen[k1]);
            for (const x of full){
                let onSkipped = Infinity;
                for(let i = ayahFirst[x]; i <= ayahLast[x]; i++)onSkipped = Math.min(onSkipped, costs[k0][i * nw + ayahLast[x]]);
                const [s, a] = win[x];
                out.jumps.push({
                    surah: s,
                    ayah: a,
                    fit0: pyRound(fit0, 3),
                    fit1: pyRound(fit1, 3),
                    between,
                    readLater: later.has(x),
                    at: pyRound(segs[k1].t, 2),
                    postChars: segLen[k1],
                    preChars: segLen[k0],
                    preRestart,
                    preOnSkipped: pyRound(onSkipped / Math.max(1, segLen[k0]), 3),
                    skipChars: wlenCum[ayahLast[x] + 1] - wlenCum[ayahFirst[x]],
                    ident: this.identGuarded(s, a)
                });
            }
        }
        return out;
    }
    similarVerseCandidates(tokens, passageIn, known, durationS, timesFor) {
        const passage = passageIn.filter(([s, a])=>this.has(s, a));
        const chars = [];
        const times = [];
        for (const tok of tokens)for (const c of tok.sym){
            chars.push(c);
            times.push(tok.t);
        }
        if (!passage.length || chars.length < 8) return [];
        const q = encode(chars.join(""));
        const n = q.length;
        const slotWords = passage.map(([s, a])=>this.ph(s, a));
        const slotChars = slotWords.map((ws)=>ws.join(""));
        const ref = encode(slotChars.join(""));
        const slotStart = [
            0
        ];
        for (const c of slotChars)slotStart.push(slotStart[slotStart.length - 1] + c.length);
        const fwdAt = new Map();
        let col = forwardInit(n);
        fwdAt.set(0, col);
        for(let j = 0; j < ref.length; j++){
            col = forwardStep(col, q, ref[j]);
            if (slotStart.includes(j + 1)) fwdAt.set(j + 1, col);
        }
        let base = col[0] + n * SKIP;
        for(let i = 1; i <= n; i++){
            const tail = col[i] + (n - i) * SKIP;
            if (tail < base) base = tail;
        }
        const bwdAt = new Map();
        let bcol = backwardInit(n);
        bwdAt.set(ref.length, bcol);
        for(let j = ref.length - 1; j >= 0; j--){
            bcol = backwardStep(bcol, q, ref[j], ref.length - j);
            if (slotStart.includes(j)) bwdAt.set(j, bcol);
        }
        const out = [];
        const meta = [];
        passage.forEach(([ks, ka], t)=>{
            const k = `${ks}:${ka}`;
            const F = fwdAt.get(slotStart[t]);
            const B = bwdAt.get(slotStart[t + 1]);
            const postLen = ref.length - slotStart[t + 1];
            const alts = known ? [
                [
                    ks,
                    ka
                ]
            ] : [
                [
                    ks,
                    ka
                ],
                ...this.lookalikes(ks, ka).map((c)=>c.m)
            ];
            const bounds = new Map();
            const boundsOf = (e)=>{
                const key = `${e[0]}:${e[1]}`;
                let hit = bounds.get(key);
                if (hit) return hit;
                const ws = this.ph(e[0], e[1]);
                const f = [
                    F
                ];
                let c = F;
                for (const w of ws){
                    for (const id of encode(w))c = forwardStep(c, q, id);
                    f.push(c);
                }
                const b = new Array(ws.length + 1);
                b[ws.length] = B;
                let bc = B;
                let after = postLen;
                for(let wi = ws.length - 1; wi >= 0; wi--){
                    const ids = encode(ws[wi]);
                    for(let x = ids.length - 1; x >= 0; x--)bc = backwardStep(bc, q, ids[x], ++after);
                    b[wi] = bc;
                }
                hit = {
                    f,
                    b
                };
                bounds.set(key, hit);
                return hit;
            };
            const pureCost = (e)=>{
                const { f, b } = boundsOf(e);
                return combine(f[f.length - 1], b[b.length - 1]);
            };
            const pure = new Map([
                [
                    k,
                    base
                ]
            ]);
            for (const a of alts){
                const key = `${a[0]}:${a[1]}`;
                if (!pure.has(key)) pure.set(key, pureCost(a));
            }
            for (const e of alts){
                const ek = `${e[0]}:${e[1]}`;
                const looks = this.lookalikes(e[0], e[1]);
                if (!known) {
                    for (const c of looks){
                        const mk = `${c.m[0]}:${c.m[1]}`;
                        if (!pure.has(mk)) pure.set(mk, pureCost(c.m));
                    }
                }
                const vs = [];
                for (const c of looks)vs.push(...this.variantsFor(e, c));
                if (known || ek === k) vs.push(...this.dropVariants(e));
                const refE = pure.get(ek);
                let floor = refE;
                if (!known) {
                    for (const v of pure.values())if (v < floor) floor = v;
                }
                const { f, b } = boundsOf(e);
                for (const v of vs){
                    let c = f[v.i1];
                    for (const w of v.mid)for (const id of encode(w))c = forwardStep(c, q, id);
                    const cv = combine(c, b[v.i2]);
                    out.push({
                        slot: t,
                        surah: e[0],
                        ayah: e[1],
                        word: v.word,
                        kind: v.kind,
                        family: v.family,
                        span: v.span,
                        from: v.from,
                        margin: pyRound(refE - cv, 3),
                        marginAll: pyRound(floor - cv, 3),
                        known,
                        at: null,
                        loc: null,
                        ayahD: null
                    });
                    meta.push({
                        words: v.words,
                        end: v.end
                    });
                }
            }
        });
        const dur = durationS + 2.0;
        out.forEach((c, x)=>{
            if (!(c.margin > 0 && c.marginAll > 0)) return;
            if (timesFor && !timesFor(c)) return;
            const { words: vw, end } = meta[x];
            const words = [];
            slotWords.forEach((sw, t)=>words.push(...t === c.slot ? vw : sw));
            const starts = [
                0
            ];
            for (const w of words)starts.push(starts[starts.length - 1] + w.length);
            let w0 = 0;
            for(let t = 0; t < c.slot; t++)w0 += slotWords[t].length;
            const wi = w0 + end;
            const { last, rc } = alignPath(q, encode(words.join("")));
            if (wi < words.length) {
                const qi = last[starts[wi + 1] - 1];
                c.at = qi >= 0 ? pyRound(times[qi], 2) : pyRound(dur, 2);
            } else c.at = pyRound(dur, 2);
            const lo = starts[Math.max(w0, w0 + c.word - 1)];
            const hi = starts[Math.min(w0 + vw.length, wi + 1)];
            let sum = 0;
            for(let j = lo; j < hi; j++)sum += rc[j];
            c.loc = pyRound(sum / Math.max(1, hi - lo), 3);
            const a0 = starts[w0];
            const a1 = starts[w0 + vw.length];
            sum = 0;
            for(let j = a0; j < a1; j++)sum += rc[j];
            c.ayahD = pyRound(sum / Math.max(1, a1 - a0), 3);
        });
        return out;
    }
    variantsFor(e, look) {
        const m = look.m;
        const ew = this.ph(e[0], e[1]);
        const mw = this.ph(m[0], m[1]);
        const regs = look.regions.filter((r)=>r[0] !== INSERT);
        const runs = [];
        for (const r of look.regions){
            const last = runs[runs.length - 1];
            if (last && last[2] === r[1] && last[4] === r[3]) runs[runs.length - 1] = [
                "run",
                last[1],
                r[2],
                last[3],
                r[4]
            ];
            else runs.push([
                ...r
            ]);
        }
        const seen = new Set();
        const out = [];
        for (const [tag, i1, i2, j1, j2] of [
            ...regs,
            ...runs.filter((r)=>r[0] === "run")
        ]){
            if (i2 <= i1) continue;
            const mid = mw.slice(j1, j2);
            const key = `${i1},${i2},${mid.join("\u0001")}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                words: [
                    ...ew.slice(0, i1),
                    ...mid,
                    ...ew.slice(i2)
                ],
                word: i1,
                end: i1 + (j2 - j1),
                kind: j2 <= j1 ? "possible_omission" : "possible_substitution",
                from: [
                    m[0],
                    m[1]
                ],
                family: "lookalike",
                span: i2 - i1,
                i1,
                i2,
                mid
            });
            if (tag === REPLACE && i2 - i1 === j2 - j1 && i2 - i1 > 1) {
                for(let d = 0; d < i2 - i1; d++){
                    const one = [
                        mw[j1 + d]
                    ];
                    const key1 = `${i1 + d},${i1 + d + 1},${one[0]}`;
                    if (seen.has(key1)) continue;
                    seen.add(key1);
                    out.push({
                        words: [
                            ...ew.slice(0, i1 + d),
                            ...one,
                            ...ew.slice(i1 + d + 1)
                        ],
                        word: i1 + d,
                        end: i1 + d + 1,
                        kind: "possible_substitution",
                        from: [
                            m[0],
                            m[1]
                        ],
                        family: "lookalike",
                        span: 1,
                        i1: i1 + d,
                        i2: i1 + d + 1,
                        mid: one
                    });
                }
            }
        }
        return out;
    }
    dropVariants(e, maxDrop = 2) {
        const ph = this.ph(e[0], e[1]);
        const out = [];
        for(let i = 1; i < ph.length - 1; i++){
            for(let d = 1; d <= maxDrop; d++){
                if (i + d < ph.length) {
                    out.push({
                        words: [
                            ...ph.slice(0, i),
                            ...ph.slice(i + d)
                        ],
                        word: i,
                        end: i,
                        kind: "possible_omission",
                        from: [
                            e[0],
                            e[1]
                        ],
                        family: "drop",
                        span: d,
                        i1: i,
                        i2: i + d,
                        mid: []
                    });
                }
            }
        }
        return out;
    }
}
export function ayahOrderFlags(cand, rule = AYAH_ORDER_RULE) {
    if (!cand || !(cand.margin > 0)) return [];
    const out = [];
    for (const j of cand.jumps){
        if (cand.margin < rule.margin && cand.margin / Math.max(1, j.postChars) < rule.rel) continue;
        if (j.readLater || j.between > rule.between) continue;
        if (Math.max(j.fit0, j.fit1) > rule.fit) continue;
        if (j.postChars < rule.minPost) continue;
        if (rule.noRestartPre && j.preRestart && j.preOnSkipped <= (rule.restartAlt ?? 99)) continue;
        if (rule.betweenRel !== undefined && j.between > rule.betweenRel * j.skipChars) continue;
        if (rule.noIdent && j.ident) continue;
        out.push({
            kind: "possible_skipped_ayah",
            surah: j.surah,
            ayah: j.ayah,
            word: 0,
            atSeconds: j.at,
            source: "ayah_order"
        });
    }
    return out;
}
export function similarVerseEligible(c, rule = SIMILAR_VERSE_RULE) {
    const m = c.known ? c.margin : c.marginAll;
    return m >= (c.family === "drop" ? rule.drop : rule.lookalike) && c.span <= rule.maxSpan && !(c.family === "drop" && c.span > 2);
}
export function similarVersePick(cands, rule = SIMILAR_VERSE_RULE) {
    const best = new Map();
    for (const c of cands){
        if (c.at === null || !similarVerseEligible(c, rule)) continue;
        if (c.loc === null || c.loc > rule.loc) continue;
        if (c.ayahD === null || c.ayahD > rule.ayahFit) continue;
        const m = c.known ? c.margin : c.marginAll;
        const cur = best.get(c.slot);
        if (!cur || m > cur.m) best.set(c.slot, {
            c,
            m
        });
    }
    return [
        ...best.values()
    ].map((b)=>b.c);
}
function forwardInit(n) {
    const col = new Float64Array(n + 1);
    for(let i = 0; i <= n; i++)col[i] = i * SKIP;
    return col;
}
function forwardStep(col, q, r) {
    const n = q.length;
    const next = new Float64Array(n + 1);
    next[0] = col[0] + 1;
    for(let i = 1; i <= n; i++){
        let c = col[i - 1] + COST[q[i - 1] * TABLE_SIZE + r];
        const u = next[i - 1] + 1;
        if (u < c) c = u;
        const lf = col[i] + 1;
        if (lf < c) c = lf;
        next[i] = c;
    }
    return next;
}
function backwardInit(n) {
    const col = new Float64Array(n + 1);
    for(let i = 0; i <= n; i++)col[i] = (n - i) * SKIP;
    return col;
}
function backwardStep(col, q, r, refLeft) {
    const n = q.length;
    const next = new Float64Array(n + 1);
    next[n] = refLeft;
    for(let i = n - 1; i >= 0; i--){
        let c = col[i + 1] + COST[q[i] * TABLE_SIZE + r];
        const u = next[i + 1] + 1;
        if (u < c) c = u;
        const lf = col[i] + 1;
        if (lf < c) c = lf;
        next[i] = c;
    }
    return next;
}
function combine(f, b) {
    let best = Infinity;
    for(let i = 0; i < f.length; i++){
        const v = f[i] + b[i];
        if (v < best) best = v;
    }
    return best;
}
export function alignPath(q, r) {
    const n = q.length;
    const m = r.length;
    const W = m + 1;
    const D = new Float64Array((n + 1) * W);
    const T = new Int8Array((n + 1) * W);
    for(let j = 0; j <= m; j++){
        D[j] = j;
        T[j] = 2;
    }
    for(let i = 1; i <= n; i++){
        D[i * W] = i * SKIP;
        T[i * W] = 3;
        const row = q[i - 1] * TABLE_SIZE;
        for(let j = 1; j <= m; j++){
            let c = D[(i - 1) * W + j - 1] + COST[row + r[j - 1]];
            let t = 0;
            const u = D[(i - 1) * W + j] + 1;
            if (u < c) {
                c = u;
                t = 1;
            }
            const lf = D[i * W + j - 1] + 1;
            if (lf < c) {
                c = lf;
                t = 2;
            }
            D[i * W + j] = c;
            T[i * W + j] = t;
        }
    }
    let bi = 0;
    let bc = D[m] + n * SKIP;
    for(let i = 1; i <= n; i++){
        const v = D[i * W + m] + (n - i) * SKIP;
        if (v < bc) {
            bc = v;
            bi = i;
        }
    }
    const last = new Int32Array(m).fill(-1);
    const rc = new Float64Array(m);
    let i = bi;
    let j = m;
    while(j > 0){
        let t = T[i * W + j];
        if (i === 0) t = 2;
        if (t === 0) {
            last[j - 1] = i - 1;
            rc[j - 1] += COST[q[i - 1] * TABLE_SIZE + r[j - 1]];
            i--;
            j--;
        } else if (t === 1) {
            rc[j - 1] += 1;
            i--;
        } else if (t === 2) {
            last[j - 1] = i > 0 ? i - 1 : -1;
            rc[j - 1] += 1;
            j--;
        } else break;
    }
    return {
        last,
        rc
    };
}


//# sourceURL=recitation/structural.ts