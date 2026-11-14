// Rihal — reconnaissance de la récitation, entièrement sur l'appareil : ta voix n'est jamais envoyée sur internet.
// Modèle : Zipformer2-CTC de Quran-Lab, affiné par le projet Tilawa sur des dizaines de milliers de récitations
// (studio, téléphone, débutants) — licence NPL-1.2, voir models/NOTICE.txt.
// Moteur de recherche et de suivi mot à mot : @tilawa/core (licence MIT), compilé dans tilawa/.
import { createZipformerSession } from "./tilawa/recitation/session.js";
import * as VX from "./voix.js?v=13";

const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.2/dist/";
const MODEL = "models/zipformer_a0w_ep1_a05.int8.onnx", CORPUS = "models/zipformer_quran.json";
const SIZES = { [MODEL]: 69246033, [CORPUS]: 5453439 };
const CACHE = "rihal-models-v1";
const FRAME = 640;   // une trame du modèle = 40 ms = 640 échantillons à 16 kHz
const LAT = 0;       // décalage trame -> instant réel (échantillons), mesuré sur des récitations alignées
// Réglages du suivi : en mémorisation on répète souvent un verset ou un bout de verset, la reprise doit coûter peu.
const CFG = Object.assign({ repeatCost: 2 }, self.__recoCfg || {});

let sess = null, raw = null, loading = null, port = null;
let q = [], qn = 0, busy = false, on = false;
let DBG = false;
let ADP = null, rawAccept = null; // adaptateur de ta voix (voix.js)
// ce que le modèle a entendu, trame par trame (≈ 90 s), pour dire précisément quelle voyelle ou quel mot a changé
const RING = { cap: 2250, lp: null, g: new Float64Array(2250), n: 0, t0: 0, idx: 0 };
function ringPush(lp, T) {
  if (!T) return; if (!RING.lp) RING.lp = new Float32Array(RING.cap * 251);
  for (let t = 0; t < T; t++) { const k = RING.n % RING.cap; RING.lp.set(lp.subarray(t * 251, (t + 1) * 251), k * 251); RING.g[k] = RING.t0 + RING.idx * FRAME; RING.idx++; RING.n++; }
}
let VCUR = null; // verset en cours : { s, a, ga }
let perfAudio = 0, perfMs = 0;
let fed = 0, base = 0, evs = [], lastSent = "", aySent = "", hint = null, searchHeard = 0;

const post = m => postMessage(m);
self.__reco = { idle: () => !busy && qn < 4800 }; // pour les tests automatiques

// fichier du modèle : depuis le cache de l'appareil, sinon téléchargé une fois (avec avancement)
async function getBytes(url, prog) {
  let c = null;
  try { c = await caches.open(CACHE); } catch (_) {}
  let r = c ? await c.match(url).catch(() => null) : null;
  if (r) { const b = await r.arrayBuffer(); prog(b.byteLength); return b; }
  r = await fetch(url);
  if (!r.ok) throw new Error("téléchargement impossible (" + r.status + ")");
  let buf;
  const rd = r.body && r.body.getReader ? r.body.getReader() : null;
  if (!rd) buf = new Uint8Array(await r.arrayBuffer());
  else {
    const parts = []; let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; prog(n); }
    buf = new Uint8Array(n); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  }
  prog(buf.length);
  if (c) await c.put(url, new Response(buf, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
  return buf.buffer;
}

async function load(ortUrl) {
  const got = {}, total = SIZES[MODEL] + SIZES[CORPUS];
  const prog = k => n => { got[k] = n; let s = 0; for (const v of Object.values(got)) s += v; post({ t: "progress", loaded: Math.min(s, total), total }); };
  const ortP = import(ortUrl || ORT_CDN + "ort.wasm.min.mjs");
  const [mb, cb] = await Promise.all([getBytes(MODEL, prog(MODEL)), getBytes(CORPUS, prog(CORPUS))]);
  raw = JSON.parse(new TextDecoder().decode(cb));
  post({ t: "progress", loaded: total, total, step: "engine" });
  const ort = await ortP;
  if (!ortUrl && ort.env && ort.env.wasm) { ort.env.wasm.wasmPaths = ORT_CDN; ort.env.wasm.numThreads = 1; }
  const t0 = performance.now();
  sess = await createZipformerSession({ ort, model: new Uint8Array(mb), corpus: raw, structural: false, enableFallback: false, debug: true, config: CFG, onEvent: m => { if (m.type === "debug") evs.push(m); } });
  // ta voix : la petite correction apprise à l'étalonnage s'applique à chaque trame du modèle
  const runner = sess.runner;
  rawAccept = runner.accept.bind(runner);
  runner.accept = async f => { const r = await rawAccept(f); if (ADP && ADP.on && r.frames && r.encoder) VX.applyAdapter(ADP, r.logProbs, r.encoder, r.frames); ringPush(r.logProbs, r.frames); return r; };
  const rawReset = runner.reset.bind(runner);
  runner.reset = () => { rawReset(); RING.t0 = fed; RING.idx = 0; };
  try { ADP = (await VX.loadAdapter()) || null; } catch (_) { ADP = null; }
  // petit essai à vide : le premier calcul est toujours plus lent
  await sess.feed(new Float32Array(16000)); sess.reset();
  return { ms: Math.round(performance.now() - t0), voice: voiceInfo() };
}

const toG = f => base + f * FRAME + LAT;
const ayahWords = (s, a) => { try { return raw.surahs[s - 1].ayahs[a - 1].w.map(x => x[2]); } catch (_) { return []; } };

function begin() {
  if (!sess) return;
  sess.reset();
  if (hint) sess.engine.setHint(hint);
  q = []; qn = 0; fed = 0; base = 0; on = true; lastSent = ""; aySent = ""; searchHeard = 0; VCUR = null; RING.n = 0; RING.t0 = 0; RING.idx = 0;
}

function onPort(e) {
  const m = e.data;
  if (m.t === "begin") { begin(); return; }
  if (m.t === "end") { on = false; q = []; qn = 0; if (VCUR) { diagVerse(VCUR, VCUR.gl); VCUR = null; } return; }
  if (!on || !sess || !m.x) return;
  let x = m.x;
  const expect = fed + qn;
  if (m.g > expect) { // trou dans le son : on comble par du silence (au plus 1 s), sinon on repart de là
    const gap = m.g - expect;
    if (gap > 16000 && !q.length) { fed = m.g; base = m.g; sess.reset(); if (hint) sess.engine.setHint(hint); }
    else { const z = new Float32Array(Math.min(gap, 16000)); q.push(z); qn += z.length; }
  } else if (m.g < expect) { // déjà entendu (reprise) : on saute la partie commune
    const skip = expect - m.g; if (skip >= x.length) return; x = x.subarray(skip);
  }
  q.push(x); qn += x.length;
  pump();
}

async function pump() {
  if (busy || !sess) return;
  busy = true;
  try {
    while (on && qn >= 4800) {
      if (qn > 16000 * 12) { // l'appareil n'arrive pas à suivre : on lâche le retard et on repart sur le son récent
        let drop = qn - 16000 * 2; while (drop > 0 && q.length) { const a = q[0]; if (a.length <= drop) { q.shift(); qn -= a.length; fed += a.length; drop -= a.length; } else { q[0] = a.subarray(drop); qn -= drop; fed += drop; drop = 0; } }
        base = fed; sess.reset(); if (hint) sess.engine.setHint(hint); lastSent = ""; post({ t: "slow" });
      }
      const n = Math.min(qn, 32000), x = new Float32Array(n);
      let o = 0;
      while (o < n) { const a = q[0], k = Math.min(a.length, n - o); x.set(a.subarray(0, k), o); o += k; if (k === a.length) q.shift(); else q[0] = a.subarray(k); }
      qn -= n; fed += n; // compté tout de suite : le son qui arrive pendant le calcul suit sans trou
      evs = [];
      const t0 = performance.now();
      await sess.feed(x);
      perfMs += performance.now() - t0; perfAudio += n;
      if (perfAudio >= 16000 * 10) { post({ t: "perf", x: +(perfAudio / 16 / Math.max(1, perfMs)).toFixed(1) }); perfAudio = 0; perfMs = 0; } // combien de fois plus vite que la voix
      after();
    }
  } catch (err) { post({ t: "fail", msg: String(err && err.message || err) }); on = false; }
  busy = false;
}

function after() {
  const eng = sess.engine;
  for (const ev of evs) {
    const d = ev.data || {};
    if (ev.event === "idle" || ev.event === "completed") { base = fed; lastSent = ""; } // le décodeur repart de zéro
    else if (ev.event === "located" || ev.event === "relocated") {
      const tr = eng.tracker;
      const s = d.surah != null ? d.surah : d.to && d.to.surah, a = d.ayah != null ? d.ayah : d.to && d.to.ayah, w = d.word != null ? d.word : d.to ? d.to.word : 0;
      const g0 = tr && tr.heard.length ? toG(tr.heard[0].frame) : fed;
      post({ t: "loc", how: ev.event, s, a, w, g0, at: fed, aw: ayahWords(s, a) });
      if (DBG) console.log("RECO loc", ev.event, s + ":" + a + ":" + w, "g0", (g0 / 16000).toFixed(2), "at", (fed / 16000).toFixed(2), "entendu:", sess.transcript.slice(-80));
      aySent = s + ":" + a;
    }
  }
  if (eng.state !== "tracking") {
    const n = eng.heardTotal || 0;
    if (n !== searchHeard) { searchHeard = n; post({ t: "search", chars: n, at: fed }); }
    return;
  }
  const p = position(eng);
  if (!p) return;
  const key = `${p.s}:${p.a}:${p.w}:${Math.round(p.cf * 4)}:${p.lost ? 1 : 0}`;
  if (key === lastSent) return;
  lastSent = key;
  const ak = p.s + ":" + p.a;
  if (ak !== aySent) { p.aw = ayahWords(p.s, p.a); aySent = ak; }
  // fin d'un verset = dernier son entendu DANS ce verset (pas le début du suivant : le suivi peut sauter en avance)
  if (!VCUR || VCUR.s !== p.s || VCUR.a !== p.a) { if (VCUR) diagVerse(VCUR, VCUR.gl); VCUR = { s: p.s, a: p.a, ga: p.ga, gl: p.g }; }
  else VCUR.gl = Math.max(VCUR.gl, p.g);
  post({ t: "pos", ...p, at: fed });
}

// où en est le récitant : dernier son reconnu -> mot (et part du mot) dans le texte, et à quel instant
function position(eng) {
  const tr = eng.tracker;
  if (!tr || !tr.heard.length) return null;
  const C = sess.corpus, k = tr.heard.length - 1, cell = tr.trail[k];
  const wordOf = c => c <= 0 ? 0 : tr.localWordOfPos[Math.min(c, tr.len) - 1];
  const lw = wordOf(cell), wi = tr.firstWord + lw;
  const s = C.wordSurah[wi], a = C.wordAyah[wi], w = C.wordInAyah[wi];
  const ws = tr.wordStarts[lw], we = lw + 1 < tr.wordStarts.length ? tr.wordStarts[lw + 1] : tr.len;
  const cf = Math.max(0, Math.min(1, (cell - ws) / Math.max(1, we - ws)));
  // début (entendu) du verset en cours
  let j = k;
  while (j > 0 && k - j < 800 && C.wordAyah[tr.firstWord + wordOf(tr.trail[j - 1])] === a) j--;
  return { s, a, w, cf, g: toG(tr.heard[k].frame), ga: toG(tr.heard[j].frame), lost: !!tr.lost, n: tr.heard.length };
}

self.onmessage = e => {
  const m = e.data;
  if (m.t === "init") {
    DBG = !!m.ortUrl;
    if (!loading) loading = load(m.ortUrl).then(r => post({ t: "ready", ...r }), err => { loading = null; post({ t: "error", msg: String(err && err.message || err) }); });
  } else if (m.t === "port") {
    port = m.port; port.onmessage = onPort;
  } else if (m.t && m.t.startsWith("cal")) { calMsg(m);
  } else if (m.t === "hint") {
    hint = m.s ? { surah: m.s, ayah: m.a || 1 } : null;
    if (sess) sess.engine.setHint(hint);
  }
};

/* ---------- « Apprendre ma voix » : enregistrement des versets d'étalonnage et apprentissage ---------- */
function voiceInfo() { return ADP && ADP.A ? { on: !!ADP.on, base: ADP.base, after: ADP.after, n: ADP.n, min: ADP.min, date: ADP.date } : null; }
function resampler(rate) { // même passage au 16 kHz que worker.js (filtre passe-bas puis interpolation)
  const SR = 16000, step = rate / SR; let t = 0, last = 0;
  const fc = 0.45 * SR / rate, N = rate > SR * 1.05 ? 32 : 0, h = new Float32Array(2 * N + 1);
  if (N) { let sum = 0; for (let k = -N; k <= N; k++) { const x = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k); const w = 0.42 + 0.5 * Math.cos(Math.PI * k / (N + 1)) + 0.08 * Math.cos(2 * Math.PI * k / (N + 1)); h[k + N] = x * w; sum += x * w; } for (let k = 0; k < h.length; k++) h[k] /= sum; }
  let hist = new Float32Array(2 * N);
  const lp = input => { if (!N) return input; const x = new Float32Array(hist.length + input.length); x.set(hist); x.set(input, hist.length); const out = new Float32Array(input.length); for (let i = 0; i < input.length; i++) { let acc = 0; for (let k = 0; k < h.length; k++) acc += h[k] * x[i + k]; out[i] = acc; } hist = x.slice(x.length - 2 * N); return out; };
  return raw => { const input = lp(raw); const out = new Float32Array(Math.max(0, Math.ceil((input.length - 1 - t) / step) + 1)); let n = 0; while (t + 1 < input.length) { const i = Math.floor(t), fr = t - i; const a = i < 0 ? last : input[i], b = input[i + 1]; out[n++] = a + (b - a) * fr; t += step; } t -= input.length; last = input[input.length - 1]; return out.subarray(0, n); };
}
let CALV = null; // (tests automatiques : autre liste de versets)
const CAL = { rs: null, on: false, buf: [], n: 0, key: null, floor: -60, hist: [], histN: 0, speech: 0, sil: 0, first: -1, lastSp: -1, lvl: 0, busy: false };
function calAudio(raw) {
  if (!CAL.rs) return;
  const x = CAL.rs(raw); if (!x.length) return;
  let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  const db = 10 * Math.log10(e / x.length + 1e-10);
  // bruit de fond : niveau bas habituel des 8 dernières secondes (le 10e centile)
  CAL.hist.push(db); CAL.histN += x.length; while (CAL.histN > 16000 * 8 && CAL.hist.length > 10) { CAL.hist.shift(); CAL.histN -= x.length; }
  const srt = CAL.hist.slice().sort((p, q) => p - q); CAL.floor = srt[Math.floor(srt.length * 0.1)];
  const sp = db > Math.max(CAL.floor + 9, -58);
  const dur = x.length / 16000;
  if (CAL.on) {
    CAL.buf.push(x.slice()); CAL.n += x.length;
    if (sp) { CAL.speech += dur; CAL.sil = 0; if (CAL.first < 0) CAL.first = CAL.n - x.length; CAL.lastSp = CAL.n; } else CAL.sil += dur;
    if (CAL.speech > 0.8 && CAL.sil > 1.2 && !CAL.autoSent && !CAL.checking) checkEnd(CAL.sil > 8);
  }
  CAL.lvl += dur;
  if (CAL.lvl > 0.08) { CAL.lvl = 0; post({ t: "calLvl", db: Math.round(db), floor: Math.round(CAL.floor), sp }); }
}
async function listMsg() {
  return { t: "calList", verses: await VX.listVerses(), voice: voiceInfo(), cal: (CALV || VX.CAL_VERSES).map(([s, a]) => ({ key: s + ":" + a, w: verseWords(s, a).map(z => z[2]) })) };
}
// silence après la voix : fin du verset, ou simple respiration au milieu ? on vérifie que tout le verset a été entendu
async function checkEnd(force) {
  const key = CAL.key; CAL.checking = true;
  try {
    let done = force;
    if (!done) {
      const all = new Float32Array(CAL.n); let o = 0; for (const b of CAL.buf) { all.set(b, o); o += b.length; }
      const [s, a] = keyParts(key), units = VX.verseUnits(verseWords(s, a).map(z => z[1]));
      const v = await runCal(all.subarray(Math.max(0, CAL.first - 6400)));
      const h = VX.greedy(v.lp, v.T).ids.map(z => VX.GMAP[z]), r = Array.from(units.ids, z => VX.GMAP[z]);
      // part du verset entendue : 1 - (unités manquantes / unités attendues)
      const miss = Math.max(0, VX.editDistance(h, r) - Math.max(0, h.length - r.length));
      done = h.length >= r.length * 0.8 && miss / r.length < 0.35;
    }
    if (done && CAL.on && CAL.key === key && !CAL.autoSent) { CAL.autoSent = true; post({ t: "calAuto", key }); }
    else if (CAL.on && CAL.key === key) { CAL.sil = 0; if (!done) post({ t: "calMore" }); }
  } finally { CAL.checking = false; }
}
const keyParts = k => k.split(":").map(Number);
const verseWords = (s, a) => raw.surahs[s - 1].ayahs[a - 1].w;
// un seul passage à la fois dans le modèle (vérification de fin de verset et analyse du verset)
let runLock = Promise.resolve();
const runCal = x => { const p = runLock.then(() => VX.runVerse(calRunner(), x)); runLock = p.catch(() => {}); return p; };
function calRunner() { const r = sess.runner; return { io: r.io, reset: () => r.reset(), accept: rawAccept }; }
async function calMsg(m) {
  try {
    if (m.t === "calMic") { CAL.rs = resampler(m.rate); m.port.onmessage = e => calAudio(e.data); return; }
    if (m.t === "calStart") { Object.assign(CAL, { on: true, buf: [], n: 0, key: m.key, speech: 0, sil: 0, first: -1, lastSp: -1, autoSent: false, checking: false }); return; }
    if (m.t === "calSet") { CALV = m.list; post(await listMsg()); return; }
    if (m.t === "calAudio") { calAudio(m.data); return; }
    if (m.t === "calCancel") { CAL.on = false; CAL.buf = []; CAL.n = 0; return; }
    if (m.t === "calStop") {
      CAL.on = false;
      const key = CAL.key, all = new Float32Array(CAL.n); let o = 0; for (const b of CAL.buf) { all.set(b, o); o += b.length; }
      CAL.buf = []; CAL.n = 0;
      if (CAL.first < 0 || CAL.speech < 0.6) { post({ t: "calVerse", key, empty: true }); return; }
      const a0 = Math.max(0, CAL.first - 6400), a1 = Math.min(all.length, CAL.lastSp + 8000), x = all.slice(a0, a1);
      await processVerse(key, x); return;
    }
    if (m.t === "calList") { post(await listMsg()); return; }
    if (m.t === "calForget") { await VX.deleteVerse(m.key); post(await listMsg()); return; }
    if (m.t === "calClear") { await VX.clearVoice(); ADP = null; post(await listMsg()); return; }
    if (m.t === "calToggle") { if (ADP) { ADP.on = !!m.on; await VX.saveAdapter(ADP); } post(await listMsg()); return; }
    if (m.t === "calTrain") { await trainVoice(); return; }
    if (m.t === "calExport") { post({ t: "calZip", zip: await exportZip() }); return; }
  } catch (err) { post({ t: "calError", msg: String(err && err.message || err) }); }
}
async function processVerse(key, x) {
  const [s, a] = keyParts(key), w = verseWords(s, a), units = VX.verseUnits(w.map(z => z[1]));
  const t0 = performance.now();
  const v = await runCal(x);
  if (sess) sess.reset();
  const ms = performance.now() - t0;
  const hd = VX.greedy(v.lp, v.T).ids.map(z => VX.GMAP[z]), rf = Array.from(units.ids, z => VX.GMAP[z]);
  const per = VX.editDistance(hd, rf) / Math.max(1, rf.length);
  const dg = VX.diagnose(v.lp, v.T, units);
  const strong = dg.words.filter(z => z.items.some(i => !i.weak && i.sure >= 8));
  // un verset mal lu ou couvert par le bruit apprendrait de travers : on le garde de côté et on te le dit
  const ok = per <= 0.3 && strong.length === 0;
  const pcm = new Int16Array(x.length); for (let i = 0; i < x.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
  await VX.saveVerse({ ...v, tgt: units.ids, key, dur: x.length / 16000, date: Date.now(), audio: pcm, ok, per, issues: dg.words });
  post({ t: "calVerse", key, dur: x.length / 16000, per, ok, speed: +(x.length / 16 / Math.max(1, ms)).toFixed(1), words: dg.words.map(z => ({ ...z, text: w[z.w] && w[z.w][2] })) });
}
async function trainVoice() {
  const all = (await VX.loadVerses()).filter(v => v.ok !== false).sort((p, q) => p.key < q.key ? -1 : 1);
  const min = all.reduce((t, v) => t + v.dur, 0) / 60;
  if (min < 2.5 || all.length < 8) { post({ t: "calDone", ok: false, why: "court", min }); return; }
  const val = all.filter((_, i) => i % 6 === 3), tr = all.filter((_, i) => i % 6 !== 3);
  post({ t: "calProgress", step: 0, of: 8 });
  const r = await VX.trainAdapter(tr, val, { epochs: 8, onEpoch: async (i, n) => { post({ t: "calProgress", step: i, of: n }); await new Promise(z => setTimeout(z, 0)); } });
  const base = VX.errorRate(val), after = VX.errorRate(val, r.ad);
  // on ne l'active que si elle aide vraiment sur des versets qu'elle n'a pas appris
  const on = r.epoch >= 0 && after <= base;
  ADP = { ...r.ad, on, base, after, n: all.length, min, date: Date.now(), nll0: r.baseNll, nll: r.nll };
  await VX.saveAdapter(ADP);
  post({ t: "calDone", ok: true, on, base, after, n: all.length, min, val: val.length });
}
// tes enregistrements d'étalonnage, pour les garder ou les envoyer (fichier .zip : un .wav par verset + rapport)
async function exportZip() {
  const P = await new Promise((res, rej) => { const r = indexedDB.open("rihal-voix", 1); r.onsuccess = () => { const t = r.result.transaction("versets", "readonly").objectStore("versets").getAll(); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }; r.onerror = () => rej(r.error); });
  const files = [], info = { app: "Rihal v13", date: new Date().toISOString(), voice: voiceInfo(), verses: [] };
  for (const p of P) {
    if (p.audio) files.push({ name: p.key.replace(":", "_") + ".wav", data: wav(p.audio) });
    info.verses.push({ key: p.key, dur: +p.dur.toFixed(2), ok: p.ok, per: p.per != null ? +p.per.toFixed(3) : null, issues: p.issues || [] });
  }
  files.push({ name: "rapport.json", data: new TextEncoder().encode(JSON.stringify(info, null, 1)) });
  return zip(files);
}
function wav(pcm) {
  const b = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(b), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(b, 44).set(pcm); return new Uint8Array(b);
}
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = d => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) { // archive .zip sans compression
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), c = crc32(f.data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, c, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, f.data);
    const e = new DataView(new ArrayBuffer(46));
    e.setUint32(0, 0x02014b50, true); e.setUint16(4, 20, true); e.setUint16(6, 20, true); e.setUint32(16, c, true); e.setUint32(20, f.data.length, true); e.setUint32(24, f.data.length, true); e.setUint16(28, nm.length, true); e.setUint32(42, off, true);
    cen.push(new Uint8Array(e.buffer), nm); off += 30 + nm.length + f.data.length;
  }
  const cs = cen.reduce((t, a) => t + a.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cs, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(end.buffer)], { type: "application/zip" });
}

/* ---------- diagnostic en direct : à la fin de chaque verset, quelle voyelle / quelle lettre / quel mot ---------- */
let LEX = null, MORPHO = null, morphoP = null;
function lexicon() { // tous les mots du Coran (forme prononcée) -> première occurrence
  if (LEX) return LEX;
  LEX = new Map();
  raw.surahs.forEach(S => S.ayahs.forEach(A => A.w.forEach((w, i) => { if (!LEX.has(w[1])) LEX.set(w[1], [S.n, A.n, i]); })));
  return LEX;
}
async function morpho() {
  if (MORPHO) return MORPHO;
  if (!morphoP) morphoP = fetch("data/morpho.json?v=13").then(r => r.ok ? r.json() : null).catch(() => null);
  MORPHO = await morphoP; return MORPHO;
}
const morphOf = (M, s, a, w) => { try { const x = M[s - 1][a - 1]; return x ? x[w] : null; } catch (_) { return null; } };
async function diagVerse(V, gEnd) {
  try {
    const g0 = V.ga - 3200, g1 = gEnd + 8000, from = Math.max(0, RING.n - RING.cap), idx = [];
    for (let n = from; n < RING.n; n++) { const k = n % RING.cap; if (RING.g[k] >= g0 && RING.g[k] <= g1) idx.push(k); }
    if (idx.length < 10) return;
    const T = idx.length, lp = new Float32Array(T * 251);
    idx.forEach((k, t) => lp.set(RING.lp.subarray(k * 251, (k + 1) * 251), t * 251));
    const W = verseWords(V.s, V.a), units = VX.verseUnits(W.map(z => z[1]));
    const d = VX.diagnose(lp, T, units);
    // les « en trop » viennent surtout du verset voisin ou d'une reprise : on ne les signale pas
    const words = d.words.map(z => ({ w: z.w, text: W[z.w] && W[z.w][2], changed: z.changed, heard: z.heardUnits, items: (z.changed ? z.items : z.items.filter(i => !i.weak)).filter(i => i.kind !== "ajout") })).filter(z => z.items.length);
    // plusieurs mots manquants d'affilée : c'est un saut de passage (ou le suivi qui s'est avancé), pas une faute de mot
    const allOm = z => z.items.every(i => i.kind === "oubli"), om = new Set(words.filter(allOm).map(z => z.w)), drop = new Set();
    for (const w of om) { let a = w, b = w; while (om.has(a - 1)) a--; while (om.has(b + 1)) b++; if (b - a + 1 >= 3) for (let k = a - 1; k <= b + 1; k++) drop.add(k); }
    if (drop.size) for (let i = words.length - 1; i >= 0; i--) if (drop.has(words[i].w)) words.splice(i, 1);
    if (!words.length) { post({ t: "diag", s: V.s, a: V.a, words: [] }); return; }
    // un autre mot du Coran ? (souvent : un verset qui ressemble)
    const L = lexicon(), M = words.some(z => z.changed) ? await morpho() : null;
    for (const z of words) {
      if (!z.changed || !z.heard) continue;
      let hit = L.get(z.heard);
      if (!hit) { // le plus proche, s'il est vraiment proche
        let best = null, bd = 3;
        for (const [k, v] of L) { if (Math.abs(k.length - z.heard.length) > 2) continue; const e = VX.editDistance(k, z.heard); if (e < bd) { bd = e; best = v; } }
        if (best && bd <= 1) hit = best;
      }
      if (hit && !(hit[0] === V.s && hit[1] === V.a && hit[2] === z.w)) {
        const hw = verseWords(hit[0], hit[1])[hit[2]];
        if (hw && hw[1] !== W[z.w][1]) z.alt = { s: hit[0], a: hit[1], w: hit[2], text: hw[2], m: M ? morphOf(M, hit[0], hit[1], hit[2]) : null, m0: M ? morphOf(M, V.s, V.a, z.w) : null };
      }
    }
    post({ t: "diag", s: V.s, a: V.a, words });
  } catch (err) { if (DBG) console.log("RECO diag", err); }
}
