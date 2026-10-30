import { DEFAULT_CONFIG } from "./config.js";
const SNAPSHOT_EVERY = 32;
const SNAPSHOT_KEEP = 16;
const RATE_MIN_N = 24;
export class Tracker {
    corpus;
    table;
    cfg;
    surah;
    firstWord;
    endWord;
    len;
    surahStart;
    ref;
    wordStarts;
    ayahAtStart;
    localWordOfPos;
    startLocal;
    jumpExtra;
    column;
    cursorCell;
    cursorLocalWord;
    cursorCost;
    revision = 0;
    trail = [];
    costs = [];
    heard = [];
    lost = false;
    snapshots = [];
    constructor(corpus, table, surah, startWordIndex, cfg = DEFAULT_CONFIG, window = null){
        this.corpus = corpus;
        this.table = table;
        this.cfg = cfg;
        this.surah = surah;
        const rec = corpus.surahs[surah - 1];
        this.firstWord = rec.firstWord;
        this.endWord = rec.endWord;
        this.surahStart = corpus.wordStart[rec.firstWord];
        const surahEnd = corpus.wordStart[rec.endWord];
        this.len = surahEnd - this.surahStart;
        this.ref = table.encode(corpus.text.slice(this.surahStart, surahEnd));
        const nWords = rec.endWord - rec.firstWord;
        this.wordStarts = new Int32Array(nWords);
        this.ayahAtStart = new Int32Array(nWords);
        for(let i = 0; i < nWords; i++){
            const w = rec.firstWord + i;
            this.wordStarts[i] = corpus.wordStart[w] - this.surahStart;
            this.ayahAtStart[i] = corpus.wordAyah[w];
        }
        this.localWordOfPos = new Int32Array(this.len);
        for(let i = 0; i < nWords; i++){
            const a = this.wordStarts[i];
            const b = i + 1 < nWords ? this.wordStarts[i + 1] : this.len;
            for(let p = a; p < b; p++)this.localWordOfPos[p] = i;
        }
        this.jumpExtra = new Float32Array(nWords);
        if (window && cfg.outsideJumpCost > 0) {
            for(let i = 0; i < nWords; i++){
                const w = rec.firstWord + i;
                if (w < window.firstWord || w >= window.endWord) this.jumpExtra[i] = cfg.outsideJumpCost;
            }
        }
        this.startLocal = Math.max(0, corpus.wordStart[startWordIndex] - this.surahStart);
        this.column = new Float32Array(this.len + 1);
        this.column.fill(Number.POSITIVE_INFINITY);
        const jump = cfg.jumpCost;
        for(let i = 0; i < nWords; i++){
            const m = this.wordStarts[i];
            this.column[m] = m === this.startLocal ? 0 : jump + this.jumpExtra[i];
        }
        for(let m = 1; m <= this.len; m++){
            this.column[m] = Math.min(this.column[m], this.column[m - 1] + 1);
        }
        this.cursorCell = this.startLocal;
        this.cursorLocalWord = -1;
        this.cursorCost = 0;
    }
    get cursorWordIndex() {
        return this.firstWord + Math.max(0, this.cursorLocalWord);
    }
    get reachedEnd() {
        return this.cursorCell >= this.len - 1;
    }
    feed(chars) {
        for (const h of chars)this.feedOne(h);
    }
    costRate(window = this.cfg.lostWindow) {
        const n = this.costs.length;
        if (n < RATE_MIN_N) return null;
        const w = Math.min(window, n);
        const before = n - w > 0 ? this.costs[n - w - 1] : 0;
        return (this.costs[n - 1] - before) / w;
    }
    retract(n) {
        if (n <= 0) return;
        this.revision++;
        const target = Math.max(0, this.heard.length - n);
        const snap = [
            ...this.snapshots
        ].reverse().find((s)=>s.length <= target);
        if (!snap) this.resetColumn();
        else this.restore(snap);
        const replay = this.heard.slice(snap ? snap.length : 0, target);
        this.heard.length = snap ? snap.length : 0;
        this.trail.length = this.heard.length;
        this.costs.length = this.heard.length;
        this.feed(replay);
        this.heard.length = target;
    }
    resetColumn() {
        const jump = this.cfg.jumpCost;
        this.column.fill(Number.POSITIVE_INFINITY);
        for(let i = 0; i < this.wordStarts.length; i++){
            const m = this.wordStarts[i];
            this.column[m] = m === this.startLocal ? 0 : jump + this.jumpExtra[i];
        }
        for(let m = 1; m <= this.len; m++){
            this.column[m] = Math.min(this.column[m], this.column[m - 1] + 1);
        }
        this.cursorCell = this.startLocal;
        this.cursorLocalWord = -1;
        this.cursorCost = 0;
        this.lost = false;
        this.snapshots.length = 0;
    }
    restore(snap) {
        this.column = snap.column.slice();
        this.cursorCell = snap.cursorCell;
        this.cursorLocalWord = snap.cursorLocalWord;
        this.cursorCost = snap.cursorCost;
        this.lost = snap.lost;
        this.snapshots.length = this.snapshots.findIndex((s)=>s === snap) + 1;
    }
    feedOne(h) {
        const prev = this.column;
        const next = new Float32Array(this.len + 1);
        let colMin = prev[0];
        for(let m = 1; m <= this.len; m++)if (prev[m] < colMin) colMin = prev[m];
        const jump = colMin + this.cfg.jumpCost;
        const repeat = colMin + this.cfg.repeatCost;
        const cursorAyah = this.cursorLocalWord < 0 ? -1 : this.corpus.wordAyah[this.firstWord + this.cursorLocalWord];
        const cursorPos = this.cursorCell;
        const hid = this.table.id(h.ch);
        next[0] = prev[0] + 1;
        if (this.wordStarts[0] === 0) {
            const r = this.ayahAtStart[0] === cursorAyah ? repeat : jump + this.jumpExtra[0];
            if (r < next[0]) next[0] = r;
        }
        for(let m = 1; m <= this.len; m++){
            next[m] = prev[m - 1] + this.table.cost(hid, this.ref[m - 1]);
            const ins = prev[m] + 1;
            const del = next[m - 1] + 1;
            if (ins < next[m]) next[m] = ins;
            if (del < next[m]) next[m] = del;
        }
        for(let i = 0; i < this.wordStarts.length; i++){
            const m = this.wordStarts[i];
            const restart = m <= cursorPos && this.ayahAtStart[i] === cursorAyah ? repeat : jump + this.jumpExtra[i];
            if (restart < next[m]) {
                next[m] = restart;
                for(let j = m + 1; j <= this.len && next[j - 1] + 1 < next[j]; j++){
                    next[j] = next[j - 1] + 1;
                }
            }
        }
        let bestCell = 0;
        let bestCost = next[0];
        let bestDist = Math.abs(0 - cursorPos);
        for(let m = 1; m <= this.len; m++){
            const c = next[m];
            const d = Math.abs(m - cursorPos);
            if (c < bestCost || c === bestCost && d < bestDist) {
                bestCost = c;
                bestCell = m;
                bestDist = d;
            }
        }
        this.column = next;
        this.cursorCell = bestCell;
        this.cursorLocalWord = bestCell === 0 ? 0 : this.localWordOfPos[Math.min(bestCell, this.len) - 1];
        this.cursorCost = bestCost;
        this.trail.push(bestCell);
        this.costs.push(bestCost);
        this.heard.push(h);
        const rate = this.costRate(this.cfg.lostWindow);
        this.lost = rate !== null && rate >= this.cfg.lostRate;
        if (this.heard.length % SNAPSHOT_EVERY === 0) {
            this.snapshots.push({
                length: this.heard.length,
                column: this.column.slice(),
                cursorCell: this.cursorCell,
                cursorLocalWord: this.cursorLocalWord,
                cursorCost: this.cursorCost,
                lost: this.lost
            });
            if (this.snapshots.length > SNAPSHOT_KEEP) this.snapshots.shift();
        }
    }
}


//# sourceURL=recitation/tracker.ts