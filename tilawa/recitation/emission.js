export const MIN_WORD_FRACTION = 0.5;
export const FALLBACK_MAX_DISTANCE = 0.5;
export function ayahKey(t) {
    return `${t.surah}:${t.ayah}`;
}
export function ayahConfidence(t) {
    if (t.words <= 0) return 0;
    return (t.ok + t.unsure) / t.words;
}
export function ayahMeetsGate(t, minWordFraction = MIN_WORD_FRACTION) {
    return t.ok + t.unsure >= Math.max(1, minWordFraction * t.words) && t.wrong <= t.ok + t.unsure;
}
export function snapshotTallies(verdicts, wordCount) {
    const order = new Map();
    for (const v of verdicts){
        const key = ayahKey(v);
        let t = order.get(key);
        if (!t) {
            t = {
                surah: v.surah,
                ayah: v.ayah,
                ok: 0,
                unsure: 0,
                wrong: 0,
                skipped: 0,
                pending: 0,
                words: wordCount(v.surah, v.ayah),
                firstSeen: order.size
            };
            order.set(key, t);
        }
        t[v.state]++;
    }
    return order;
}
export function accumulateSnapshot(dest, src) {
    for (const [key, s] of src){
        const existing = dest.get(key);
        if (!existing) {
            dest.set(key, {
                ...s,
                firstSeen: dest.size
            });
            continue;
        }
        existing.ok += s.ok;
        existing.unsure += s.unsure;
        existing.wrong += s.wrong;
        existing.skipped += s.skipped;
        existing.pending += s.pending;
        existing.words = Math.max(existing.words, s.words);
    }
}
export function mergeTallies(accumulated, current) {
    const out = new Map();
    for (const [key, t] of accumulated)out.set(key, {
        ...t
    });
    accumulateSnapshot(out, current);
    return out;
}
export function newlyEligibleAyahs(tallies, alreadyEmitted, minWordFraction = MIN_WORD_FRACTION) {
    const values = tallies instanceof Map ? [
        ...tallies.values()
    ] : [
        ...tallies
    ];
    return values.filter((t)=>ayahMeetsGate(t, minWordFraction) && !alreadyEmitted.has(ayahKey(t))).sort((a, b)=>a.firstSeen - b.firstSeen);
}
export function shouldRunFallback(emitted) {
    return emitted.length === 0;
}
export const GAP_MAX_WORDS = 3;
export function bridgeGapAyahs(accepted, tallies, gapMaxWords = GAP_MAX_WORDS) {
    const have = new Set(accepted.map(ayahKey));
    const extra = [];
    for (const t of tallies){
        const key = ayahKey(t);
        if (have.has(key)) continue;
        if (t.words > gapMaxWords) continue;
        if (t.ok + t.unsure < 1) continue;
        if (t.wrong > t.ok + t.unsure) continue;
        if (!have.has(`${t.surah}:${t.ayah - 1}`)) continue;
        if (!have.has(`${t.surah}:${t.ayah + 1}`)) continue;
        extra.push({
            ...t,
            bridged: true
        });
        have.add(key);
    }
    if (!extra.length) return [
        ...accepted
    ];
    return [
        ...accepted,
        ...extra
    ].sort((a, b)=>a.firstSeen - b.firstSeen);
}
export function fallbackConfidence(distance) {
    if (!Number.isFinite(distance)) return 0;
    return Math.min(1, Math.max(0, 1 - distance));
}
export function buildFinalSequence(tallies, fallback, minWordFraction = MIN_WORD_FRACTION) {
    const gated = [
        ...tallies
    ].filter((t)=>ayahMeetsGate(t, minWordFraction)).sort((a, b)=>a.firstSeen - b.firstSeen).map((t)=>({
            surah: t.surah,
            ayah: t.ayah,
            confidence: ayahConfidence(t)
        }));
    if (gated.length > 0) {
        const confidence = gated.reduce((s, v)=>s + v.confidence, 0) / gated.length;
        return {
            verses: gated,
            confidence
        };
    }
    if (fallback) {
        const confidence = fallbackConfidence(fallback.distance);
        return {
            verses: [
                {
                    surah: fallback.surah,
                    ayah: fallback.ayah,
                    confidence
                }
            ],
            confidence
        };
    }
    return {
        verses: [],
        confidence: 0
    };
}
export function wordProgressFromCursor(cursor, verdicts, totalWords) {
    const matched_indices = verdicts.filter((v)=>v.surah === cursor.surah && v.ayah === cursor.ayah && (v.state === "ok" || v.state === "unsure")).map((v)=>v.word).sort((a, b)=>a - b);
    return {
        type: "word_progress",
        surah: cursor.surah,
        ayah: cursor.ayah,
        word_index: cursor.word,
        total_words: totalWords,
        matched_indices
    };
}


//# sourceURL=recitation/emission.ts