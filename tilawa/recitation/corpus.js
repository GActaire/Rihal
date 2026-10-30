export class QuranCorpus {
    text;
    wordStart;
    wordSurah;
    wordAyah;
    wordInAyah;
    mushaf;
    plain;
    ayahFirst;
    ayahWords;
    markers;
    surahs;
    wordCount;
    constructor(data){
        const raw = data;
        if (!raw || raw.v !== 2) throw new Error("quran.json must be v2");
        if (!Array.isArray(raw.surahs) || raw.surahs.length !== 114) {
            throw new Error("quran.json must contain 114 surahs");
        }
        const chunks = [];
        const wordStart = [];
        const wordSurah = [];
        const wordAyah = [];
        const wordInAyah = [];
        const mushaf = [];
        const plain = [];
        const ayahFirst = [];
        const ayahWords = [];
        const markers = [];
        const surahs = [];
        let offset = 0;
        let w = 0;
        for(let si = 0; si < raw.surahs.length; si++){
            const s = raw.surahs[si];
            const firstWord = w;
            const firstArr = new Int32Array(s.ayahs.length);
            const countArr = new Int32Array(s.ayahs.length);
            const marks = [];
            for(let ai = 0; ai < s.ayahs.length; ai++){
                const a = s.ayahs[ai];
                if (a.n !== ai + 1) {
                    throw new Error(`surah ${s.n} ayah index ${ai} has n=${a.n}`);
                }
                firstArr[ai] = w;
                const words = a.w;
                countArr[ai] = words.length;
                marks.push(a.m);
                for(let wi = 0; wi < words.length; wi++){
                    const triple = words[wi];
                    const gly = triple[0];
                    const ph = triple[1];
                    const pl = triple[2];
                    wordStart.push(offset);
                    wordSurah.push(s.n);
                    wordAyah.push(a.n);
                    wordInAyah.push(wi);
                    mushaf.push(gly);
                    plain.push(pl);
                    chunks.push(ph);
                    offset += ph.length;
                    w++;
                }
            }
            ayahFirst.push(firstArr);
            ayahWords.push(countArr);
            markers.push(marks);
            surahs.push({
                n: s.n,
                name: s.name,
                nameEn: s.nameEn,
                ayahCount: s.ayahs.length,
                firstWord,
                endWord: w
            });
        }
        wordStart.push(offset);
        this.text = chunks.join("");
        this.wordStart = Int32Array.from(wordStart);
        this.wordSurah = Int32Array.from(wordSurah);
        this.wordAyah = Int32Array.from(wordAyah);
        this.wordInAyah = Int32Array.from(wordInAyah);
        this.mushaf = mushaf;
        this.plain = plain;
        this.ayahFirst = ayahFirst;
        this.ayahWords = ayahWords;
        this.markers = markers;
        this.surahs = surahs;
        this.wordCount = w;
    }
    wordAt(offset) {
        if (offset < 0) return 0;
        if (offset >= this.text.length) return this.wordCount - 1;
        const starts = this.wordStart;
        let lo = 0;
        let hi = this.wordCount;
        while(lo < hi){
            const mid = lo + hi + 1 >> 1;
            if (starts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }
    wordIndex(surah, ayah, word) {
        if (!this.hasAyah(surah, ayah)) {
            throw new RangeError(`no ayah ${surah}:${ayah}`);
        }
        const count = this.ayahWordCount(surah, ayah);
        if (word < 0 || word >= count) {
            throw new RangeError(`word ${word} out of range for ${surah}:${ayah}`);
        }
        return this.ayahFirstWord(surah, ayah) + word;
    }
    hasAyah(surah, ayah) {
        if (surah < 1 || surah > 114) return false;
        const s = this.surahs[surah - 1];
        return !!s && ayah >= 1 && ayah <= s.ayahCount;
    }
    ayahFirstWord(surah, ayah) {
        return this.ayahFirst[surah - 1][ayah - 1];
    }
    ayahWordCount(surah, ayah) {
        return this.ayahWords[surah - 1][ayah - 1];
    }
    ayahPhonemes(surah, ayah) {
        const first = this.ayahFirstWord(surah, ayah);
        const end = first + this.ayahWordCount(surah, ayah);
        return this.text.slice(this.wordStart[first], this.wordStart[end]);
    }
    wordPhonemes(wordIndex) {
        return this.text.slice(this.wordStart[wordIndex], this.wordStart[wordIndex + 1]);
    }
}


//# sourceURL=recitation/corpus.ts