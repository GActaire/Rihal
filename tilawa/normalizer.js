const DIACRITICS_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DE\u06DF-\u06ED\u0640]/g;
const NORM_MAP = {
    "\u0623": "\u0627",
    "\u0625": "\u0627",
    "\u0622": "\u0627",
    "\u0671": "\u0627",
    "\u0629": "\u0647",
    "\u0649": "\u064A"
};
export function normalizeArabic(text) {
    text = text.replace(/\ufeff/g, "");
    text = text.replace(DIACRITICS_RE, "");
    text = text.replace(/./g, (ch)=>NORM_MAP[ch] ?? ch);
    text = text.split(/\s+/).filter(Boolean).join(" ");
    return text;
}


//# sourceURL=normalizer.ts