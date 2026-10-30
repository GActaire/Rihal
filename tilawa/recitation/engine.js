import { BUFFER_CAP, DEFAULT_CONFIG } from "./config.js";
import { expandTokens } from "./ctcDecoder.js";
import { alignSemiGlobal } from "./alignment.js";
import { preamblePending, stripPreambles } from "./search.js";
import { Tracker } from "./tracker.js";
import { VerdictTracer } from "./verdicts.js";
export class RecitationEngine {
    corpus;
    index;
    cfg;
    state = "searching";
    tracker = null;
    tracer = null;
    framesDecoded = 0;
    heardTotal = 0;
    buffer = [];
    hint = null;
    stay = false;
    searchStartFrame = 0;
    lastSearchFrame = 0;
    lastSearchHeard = 0;
    lastRelocateFrame = 0;
    lastProgressFrame = 0;
    lastCharFrame = 0;
    locateFailedEmitted = false;
    lostEmitted = false;
    completedEmitted = false;
    struggles = 0;
    relocateCandidate = null;
    lastCursorWord = -1;
    lastStates = new Map();
    prevSettled = false;
    lastStruggleChars = 0;
    onBeforeRelocate = null;
    posteriors = null;
    encoder = null;
    slipHead = null;
    correction = false;
    expected = null;
    expectedLocked = false;
    constructor(corpus, index, cfg = DEFAULT_CONFIG){
        this.corpus = corpus;
        this.index = index;
        this.cfg = cfg;
    }
    setHint(hint) {
        this.hint = hint;
    }
    setPosteriors(posteriors) {
        this.posteriors = posteriors;
        if (this.tracer) this.tracer.posteriors = posteriors;
    }
    setSlip(encoder, head) {
        this.encoder = encoder;
        this.slipHead = head;
        if (this.tracer) {
            this.tracer.encoder = encoder;
            this.tracer.slipHead = head;
        }
    }
    setCorrection(on) {
        this.correction = on;
        if (this.tracer) this.tracer.anchorAyahEnd = on ? this.cfg.anchorAyahEnd : 0;
    }
    setExpected(p) {
        this.expectedLocked = false;
        if (!p || !this.corpus.hasAyah(p.surah, p.ayah)) {
            this.expected = null;
            return;
        }
        const end = Math.max(p.ayah, Math.min(p.ayahEnd ?? p.ayah, this.corpus.surahs[p.surah - 1].ayahCount));
        this.expected = {
            surah: p.surah,
            ayah: p.ayah,
            firstWord: this.corpus.ayahFirstWord(p.surah, p.ayah),
            endWord: this.corpus.ayahFirstWord(p.surah, end) + this.corpus.ayahWordCount(p.surah, end)
        };
    }
    get window() {
        return this.correction ? this.expected : null;
    }
    setStayOnSurah(stay) {
        this.stay = stay;
    }
    startSearch() {
        this.state = "searching";
        this.tracker = null;
        this.tracer = null;
        this.buffer = [];
        this.heardTotal = 0;
        this.searchStartFrame = this.framesDecoded;
        this.lastSearchFrame = this.framesDecoded;
        this.lastSearchHeard = 0;
        this.lastRelocateFrame = this.framesDecoded;
        this.lastProgressFrame = this.framesDecoded;
        this.lastCharFrame = this.framesDecoded;
        this.locateFailedEmitted = false;
        this.lostEmitted = false;
        this.completedEmitted = false;
        this.struggles = 0;
        this.relocateCandidate = null;
        this.lastCursorWord = -1;
        this.lastStates.clear();
        this.prevSettled = false;
        this.lastStruggleChars = 0;
    }
    track(surah, ayah, word = 0) {
        const wordIndex = this.corpus.wordIndex(surah, ayah, word);
        return this.lock(wordIndex, [], "located");
    }
    feed(tokens, framesDecoded) {
        if (framesDecoded < this.framesDecoded) {
            this.searchStartFrame = framesDecoded;
            this.lastSearchFrame = framesDecoded;
            this.lastRelocateFrame = framesDecoded;
            this.lastProgressFrame = framesDecoded;
            this.lastCharFrame = framesDecoded;
        }
        this.framesDecoded = framesDecoded;
        const chars = expandTokens(tokens);
        if (chars.length) {
            this.lastCharFrame = framesDecoded;
            this.heardTotal += chars.length;
            this.buffer.push(...chars);
            if (this.buffer.length > BUFFER_CAP) {
                this.buffer.splice(0, this.buffer.length - BUFFER_CAP);
            }
        }
        if (this.state === "searching") return this.feedSearching();
        return this.feedTracking(chars);
    }
    lock(wordIndex, replay, how, from) {
        if (how === "relocated") this.onBeforeRelocate?.();
        const surah = this.corpus.wordSurah[wordIndex];
        const ayah = this.corpus.wordAyah[wordIndex];
        const word = this.corpus.wordInAyah[wordIndex];
        const prev = this.tracker ? {
            surah: this.tracker.surah,
            ayah: this.corpus.wordAyah[this.tracker.cursorWordIndex]
        } : from;
        const win = this.window;
        this.tracker = new Tracker(this.corpus, this.index.table, surah, wordIndex, this.cfg, win && win.surah === surah ? win : null);
        this.tracer = new VerdictTracer(this.tracker, this.index.table, this.cfg);
        this.tracer.anchorAyahEnd = this.correction ? this.cfg.anchorAyahEnd : 0;
        if (win) this.expectedLocked = true;
        this.tracer.posteriors = this.posteriors;
        this.tracer.encoder = this.encoder;
        this.tracer.slipHead = this.slipHead;
        this.state = "tracking";
        this.lostEmitted = false;
        this.completedEmitted = false;
        this.struggles = 0;
        this.relocateCandidate = null;
        this.lastCursorWord = -1;
        this.lastStates.clear();
        this.prevSettled = false;
        this.lastRelocateFrame = this.framesDecoded;
        this.lastStruggleChars = this.heardTotal;
        const events = [];
        if (how === "relocated" && prev) {
            events.push({
                type: "relocated",
                from: prev,
                to: {
                    surah,
                    ayah,
                    word
                }
            });
        } else {
            events.push({
                type: "located",
                surah,
                ayah,
                word,
                replayed: replay.length
            });
        }
        if (replay.length) this.tracker.feed(replay);
        events.push(...this.trackingEvents(false));
        return events;
    }
    feedSearching() {
        const win = this.window;
        if (win && !this.expectedLocked) {
            const start = this.expectedStart();
            if (start >= 0) return this.lock(win.firstWord, this.buffer.slice(start), "located");
        }
        const events = [];
        const minC = this.cfg.searchMinChars;
        const due = this.buffer.length >= minC && (this.heardTotal - this.lastSearchHeard >= this.cfg.searchEveryChars || this.heardTotal - this.lastSearchHeard > 0 && this.framesDecoded - this.lastSearchFrame >= this.cfg.searchEveryFrames);
        if (due) {
            this.lastSearchFrame = this.framesDecoded;
            this.lastSearchHeard = this.heardTotal;
            const qLen = Math.min(this.cfg.searchQueryChars, this.buffer.length);
            const qStart = this.buffer.length - qLen;
            const query = this.buffer.slice(qStart).map((c)=>c.ch).join("");
            const result = this.index.search(query, win ?? this.hint);
            const inWindow = !win || result.hits[0] && result.hits[0].wordIndex >= win.firstWord && result.hits[0].wordIndex < win.endWord;
            if (result.decisive && result.hits[0] && inWindow) {
                const hit = result.hits[0];
                const at = qStart + hit.queryStart;
                const back = this.correction ? this.backfill(hit, at) : null;
                if (back) return this.lock(back.wordIndex, this.buffer.slice(back.from), "located");
                return this.lock(hit.wordIndex, this.buffer.slice(at), "located");
            }
        }
        if (!this.locateFailedEmitted && this.framesDecoded - this.searchStartFrame >= this.cfg.locateFailedFrames) {
            this.locateFailedEmitted = true;
            events.push({
                type: "locateFailed"
            });
        }
        return events;
    }
    feedTracking(chars) {
        if (!this.tracker || !this.tracer) return [];
        if (chars.length) this.tracker.feed(chars);
        const events = this.trackingEvents(chars.length > 0);
        if (this.tracker.lost) {
            if (!this.lostEmitted) {
                this.lostEmitted = true;
                events.push({
                    type: "lost"
                });
            }
        } else {
            this.lostEmitted = false;
        }
        if (this.framesDecoded - this.lastRelocateFrame >= this.cfg.relocateEveryFrames) {
            this.lastRelocateFrame = this.framesDecoded;
            const heardSinceTick = this.heardTotal - this.lastStruggleChars;
            this.lastStruggleChars = this.heardTotal;
            if (this.stay || this.window) {
                this.struggles = 0;
            } else {
                const moved = this.maybeRelocate();
                if (moved) return [
                    ...events,
                    ...moved
                ];
                if (heardSinceTick > 0) {
                    const held = this.isHeld();
                    this.struggles = this.tracker.lost || held ? this.struggles + 1 : 0;
                    if (this.cfg.maxStruggles > 0 && this.struggles >= this.cfg.maxStruggles) {
                        events.push({
                            type: "idle",
                            reason: "lost"
                        });
                        this.struggles = 0;
                        this.lastProgressFrame = this.framesDecoded;
                    }
                }
            }
        }
        if (this.framesDecoded - this.lastProgressFrame >= this.cfg.idleFrames) {
            events.push({
                type: "idle",
                reason: "silent"
            });
            this.lastProgressFrame = this.framesDecoded;
        }
        return events;
    }
    maybeRelocate() {
        if (!this.tracker || this.buffer.length < this.cfg.searchMinChars) return null;
        const qLen = Math.min(this.cfg.relocateQueryChars, this.buffer.length);
        const qStart = this.buffer.length - qLen;
        const query = this.buffer.slice(qStart).map((c)=>c.ch).join("");
        const result = this.index.search(query, null, 1);
        const hit = result.hits[0];
        const rate = this.tracker.costRate();
        const candidate = hit ? {
            surah: hit.surah,
            ayah: hit.ayah
        } : null;
        const agrees = !!candidate && !!this.relocateCandidate && candidate.surah === this.relocateCandidate.surah && candidate.ayah === this.relocateCandidate.ayah;
        this.relocateCandidate = candidate;
        if (hit && rate !== null && rate >= this.cfg.lostRate && hit.surah !== this.tracker.surah && hit.distance <= this.cfg.relocateMaxDistance && hit.distance + this.cfg.relocateRateMargin <= rate && agrees) {
            const from = {
                surah: this.tracker.surah,
                ayah: this.corpus.wordAyah[this.tracker.cursorWordIndex]
            };
            const replay = this.buffer.slice(qStart + hit.queryStart);
            return this.lock(hit.wordIndex, replay, "relocated", from);
        }
        return null;
    }
    expectedStart() {
        const win = this.window;
        if (this.buffer.length < this.cfg.searchMinChars) return -1;
        const text = this.buffer.map((c)=>c.ch).join("");
        const opensWithBasmala = win.ayah === 1 && win.surah === 1;
        const offset = opensWithBasmala ? 0 : stripPreambles(text, this.index.table).offset;
        const rest = text.slice(offset);
        if (rest.length < this.cfg.searchMinChars) return -1;
        if (!opensWithBasmala && preamblePending(rest, this.index.table)) return -1;
        return offset;
    }
    backfill(hit, at) {
        const ratio = this.cfg.backfillRatio;
        if (!(ratio > 0)) return null;
        const first = this.corpus.ayahFirstWord(hit.surah, hit.ayah);
        const before = this.corpus.wordStart[hit.wordIndex] - this.corpus.wordStart[first];
        if (before <= 0) return null;
        const floor = stripPreambles(this.buffer.slice(0, at).map((c)=>c.ch).join(""), this.index.table).offset;
        const from = Math.max(floor, at - Math.ceil(before * ratio));
        return from < at ? {
            wordIndex: first,
            from
        } : null;
    }
    alignBuffer() {
        const maxD = this.cfg.stopAlignDistance;
        const win = this.window;
        if (!this.correction || this.state !== "searching" || !(maxD > 0 || win)) return null;
        if (this.buffer.length < this.cfg.searchMinChars) return null;
        const qLen = Math.min(this.cfg.searchQueryChars, this.buffer.length);
        const qStart = this.buffer.length - qLen;
        const query = this.buffer.slice(qStart).map((c)=>c.ch).join("");
        if (win && !this.expectedLocked) {
            const text = this.buffer.map((c)=>c.ch).join("");
            const from = win.ayah === 1 && win.surah === 1 ? 0 : stripPreambles(text, this.index.table).offset;
            return this.detachedTracer(win.surah, win.firstWord, this.buffer.slice(from));
        }
        const hit = this.index.search(query, win ?? this.hint).hits[0];
        if (!hit || !(hit.distance <= (maxD > 0 ? maxD : this.cfg.searchDecisiveDistance))) return null;
        if (win && (hit.wordIndex < win.firstWord || hit.wordIndex >= win.endWord)) return null;
        const at = qStart + hit.queryStart;
        const back = this.backfill(hit, at) ?? {
            wordIndex: hit.wordIndex,
            from: at
        };
        return this.detachedTracer(hit.surah, back.wordIndex, this.buffer.slice(back.from));
    }
    skippedAyah(tracker = this.tracker) {
        const win = this.window;
        const min = this.cfg.skipMinChars;
        if (!win || !tracker || !(min > 0) || tracker.surah !== win.surah) return null;
        const c = this.corpus;
        const n = tracker.heard.length;
        const ayahOf = (g)=>{
            const cell = tracker.trail[g];
            return c.wordAyah[tracker.firstWord + (cell <= 0 ? 0 : tracker.localWordOfPos[Math.min(cell, tracker.len) - 1])];
        };
        if (n < min) return null;
        const a = ayahOf(n - 1);
        const firstAyah = c.wordAyah[win.firstWord];
        const lastAyah = c.wordAyah[win.endWord - 1];
        if (a <= firstAyah || a >= lastAyah) return null;
        let from = n - 1;
        while(from > 0 && ayahOf(from - 1) === a)from--;
        if (from === 0 || ayahOf(from - 1) !== a - 1 || n - from < min) return null;
        const table = this.index.table;
        const ids = table.encode(tracker.heard.slice(from).map((h)=>h.ch).join(""));
        const text = (ayah)=>{
            const w0 = c.ayahFirstWord(win.surah, ayah);
            return table.encode(c.text.slice(c.wordStart[w0], c.wordStart[w0 + c.ayahWordCount(win.surah, ayah)]));
        };
        const here = text(a);
        const next = text(a + 1);
        const dHere = alignSemiGlobal(ids, here, 0, here.length, table).distance;
        const fit = alignSemiGlobal(ids, next, 0, next.length, table);
        if (fit.distance > this.cfg.skipMaxDistance || dHere - fit.distance < this.cfg.skipMargin) return null;
        if (fit.queryStart > this.cfg.skipMaxHead * ids.length) return null;
        return {
            surah: win.surah,
            ayah: a
        };
    }
    detachedTracer(surah, wordIndex, chars) {
        const win = this.window;
        const tracker = new Tracker(this.corpus, this.index.table, surah, wordIndex, this.cfg, win && win.surah === surah ? win : null);
        tracker.feed(chars);
        const tracer = new VerdictTracer(tracker, this.index.table, this.cfg);
        tracer.posteriors = this.posteriors;
        tracer.anchorAyahEnd = this.cfg.anchorAyahEnd;
        return tracer;
    }
    isHeld() {
        if (!this.tracker) return false;
        const rate = this.tracker.costRate(this.cfg.holdWindow);
        return rate !== null && rate >= this.cfg.holdRate;
    }
    settled() {
        return this.framesDecoded - this.lastCharFrame >= this.cfg.settleFrames;
    }
    trackingEvents(gotChars) {
        if (!this.tracker || !this.tracer) return [];
        if (this.isHeld()) return [];
        const events = [];
        const cursorIdx = this.tracker.cursorWordIndex;
        if (cursorIdx !== this.lastCursorWord) {
            this.lastCursorWord = cursorIdx;
            this.lastProgressFrame = this.framesDecoded;
            events.push({
                type: "cursor",
                surah: this.corpus.wordSurah[cursorIdx],
                ayah: this.corpus.wordAyah[cursorIdx],
                word: this.corpus.wordInAyah[cursorIdx],
                wordIndex: cursorIdx
            });
        }
        const settled = this.settled();
        const silenceSettle = !gotChars && settled && !this.prevSettled;
        const vs = this.tracer.verdicts(settled);
        const changes = [];
        const refreshPending = gotChars && this.prevSettled;
        for (const v of vs){
            const key = `${v.state}:${v.distance}:${v.heardRatio}:${v.margin}`;
            const prev = this.lastStates.get(v.wordIndex);
            if (prev === key) continue;
            const wasPending = prev?.startsWith("pending:") ?? false;
            if (wasPending && v.state === "pending" && !refreshPending) continue;
            changes.push(v);
            this.lastStates.set(v.wordIndex, key);
            if (v.state !== "pending" && !silenceSettle) {
                this.lastProgressFrame = this.framesDecoded;
            }
        }
        if (changes.length) events.push({
            type: "verdicts",
            changes
        });
        for (const key of this.lastStates.keys()){
            if (!vs.some((v)=>v.wordIndex === key)) this.lastStates.delete(key);
        }
        this.prevSettled = settled;
        if (!this.completedEmitted && this.tracker.reachedEnd) {
            const lastW = this.tracker.endWord - 1;
            const lastV = vs.find((v)=>v.wordIndex === lastW);
            if (lastV && lastV.state !== "pending") {
                this.completedEmitted = true;
                events.push({
                    type: "completed",
                    surah: this.tracker.surah
                });
            }
        }
        return events;
    }
}


//# sourceURL=recitation/engine.ts