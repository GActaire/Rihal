// Rihal — reconnaissance vocale de la récitation (modèle Whisper entraîné sur le Coran par Tarteel),
// entièrement dans le navigateur : rien n'est envoyé sur un serveur. Puis recherche du passage dans tout le Coran.
import "./search.js?v=7";
const R = self.RihalSearch;
const MODEL = "omartariq612/tarteel-ai-whisper-tiny-ar-quran-onnx";
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";

let asr = null, loading = null, useLang = true, ix = null, ixLoading = null, busy = false;

function index() {
  if (ix) return Promise.resolve(ix);
  if (!ixLoading) ixLoading = fetch("quran.txt?v=7").then(r => { if (!r.ok) throw new Error("texte"); return r.text(); }).then(t => (ix = R.build(t)));
  return ixLoading;
}

async function load(pref) {
  const { pipeline, env } = await import(LIB);
  env.allowLocalModels = false;
  const seen = {};
  const progress_callback = p => {
    if (p.status === "progress" && p.file) { seen[p.file] = [p.loaded || 0, p.total || 0]; }
    else if (p.status === "done" && p.file && seen[p.file]) seen[p.file][0] = seen[p.file][1];
    else return;
    let l = 0, t = 0; for (const k in seen) { l += seen[k][0]; t += seen[k][1]; }
    postMessage({ t: "progress", loaded: l, total: t });
  };
  const tries = [];
  if (pref !== "wasm" && self.navigator && navigator.gpu) {
    try {
      const ad = await navigator.gpu.requestAdapter();
      if (ad) tries.push(["webgpu", ad.features && ad.features.has("shader-f16") ? { encoder_model: "fp16", decoder_model_merged: "fp16" } : { encoder_model: "fp32", decoder_model_merged: "q4" }]);
    } catch (_) {}
  }
  tries.push(["wasm", { encoder_model: "q8", decoder_model_merged: "q8" }]);
  let lastErr = null;
  for (const [device, dtype] of tries) {
    try {
      const p = await pipeline("automatic-speech-recognition", MODEL, { device, dtype, progress_callback });
      asr = p;
      const t0 = performance.now();
      await transcribe(new Float32Array(16000)); // préchauffage
      return { device, warm: Math.round(performance.now() - t0) };
    } catch (e) { lastErr = e; asr = null; }
  }
  throw lastErr || new Error("modèle");
}

async function transcribe(x) {
  const opts = { max_new_tokens: 120 };
  if (useLang) {
    try { return (await asr(x, { ...opts, language: "arabic", task: "transcribe" })).text || ""; }
    catch (e) { useLang = false; }
  }
  return (await asr(x, opts)).text || "";
}

// emplacement (sourate, verset) -> plage d'indices de mots dans tout le Coran
function rangeOf(s0, s1) {
  let v = 0;
  for (let s = 0; s < s0 - 1; s++) v += R.COUNTS[s];
  let v1 = v;
  for (let s = s0 - 1; s < s1; s++) v1 += R.COUNTS[s];
  return [ix.vstart[v], ix.vstart[v1] - 1];
}
function flatOf(s, v, w) {
  let k = 0; for (let x = 0; x < s - 1; x++) k += R.COUNTS[x];
  return ix.vstart[k + v - 1] + (w || 0);
}
function withWords(loc) {
  if (!loc) return loc;
  const a = ix.vstart[loc.vi], b = ix.vstart[loc.vi + 1];
  loc.vwords = ix.words.slice(a, b);
  if (loc.start) { const sa = ix.vstart[loc.start.vi], sb = ix.vstart[loc.start.vi + 1]; loc.start.vwords = ix.words.slice(sa, sb); }
  return loc;
}

self.onmessage = async e => {
  const m = e.data;
  if (m.t === "init") {
    if (!loading) loading = load(m.pref).then(r => { postMessage({ t: "ready", ...r }); return r; }, err => { loading = null; postMessage({ t: "error", msg: String(err && err.message || err) }); });
    index().catch(() => {});
    return;
  }
  if (m.t === "run") {
    // un seul calcul à la fois : si on est occupé, on répond tout de suite « occupé » (le prochain extrait suivra)
    if (busy) { postMessage({ t: "result", id: m.id, busy: true }); return; }
    busy = true;
    try {
      const t0 = performance.now();
      await index();
      let text = m.mockText;
      if (text == null) { if (!asr) throw new Error("modèle non chargé"); text = await transcribe(m.x); }
      const ms = Math.round(performance.now() - t0);
      let loc = null, global = null;
      if (m.surah) {
        const range = rangeOf(m.surah, m.surah);
        const near = m.near ? flatOf(m.surah, m.near.v, m.near.w) : null;
        loc = R.search(ix, text, { range, near });
        if (m.globalToo && (!loc || !loc.sure)) global = R.search(ix, text);
      } else loc = R.search(ix, text);
      postMessage({ t: "result", id: m.id, text, ms, loc: withWords(loc), global: withWords(global) });
    } catch (err) {
      postMessage({ t: "result", id: m.id, error: String(err && err.message || err) });
    } finally { busy = false; }
  }
};
