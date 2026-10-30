// Rihal — reconnaissance de la récitation, entièrement sur l'appareil : ta voix n'est jamais envoyée sur internet.
// Modèle : Zipformer2-CTC de Quran-Lab, affiné par le projet Tilawa sur des dizaines de milliers de récitations
// (studio, téléphone, débutants) — licence NPL-1.2, voir models/NOTICE.txt.
// Moteur de recherche et de suivi mot à mot : @tilawa/core (licence MIT), compilé dans tilawa/.
import { createZipformerSession } from "./tilawa/recitation/session.js";

const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.2/dist/";
const MODEL = "models/zipformer_a0w_ep1_a05.int8.onnx", CORPUS = "models/zipformer_quran.json";
const SIZES = { [MODEL]: 69246033, [CORPUS]: 5453439 };
const CACHE = "rihal-models-v1";
const FRAME = 640;   // une trame du modèle = 40 ms = 640 échantillons à 16 kHz
const LAT = 0;       // décalage trame -> instant réel (échantillons), mesuré sur des récitations alignées

let sess = null, raw = null, loading = null, port = null;
let q = [], qn = 0, busy = false, on = false;
let DBG = false;
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
  sess = await createZipformerSession({ ort, model: new Uint8Array(mb), corpus: raw, structural: false, enableFallback: false, debug: true, onEvent: m => { if (m.type === "debug") evs.push(m); } });
  // petit essai à vide : le premier calcul est toujours plus lent
  await sess.feed(new Float32Array(16000)); sess.reset();
  return { ms: Math.round(performance.now() - t0) };
}

const toG = f => base + f * FRAME + LAT;
const ayahWords = (s, a) => { try { return raw.surahs[s - 1].ayahs[a - 1].w.map(x => x[2]); } catch (_) { return []; } };

function begin() {
  if (!sess) return;
  sess.reset();
  if (hint) sess.engine.setHint(hint);
  q = []; qn = 0; fed = 0; base = 0; on = true; lastSent = ""; aySent = ""; searchHeard = 0;
}

function onPort(e) {
  const m = e.data;
  if (m.t === "begin") { begin(); return; }
  if (m.t === "end") { on = false; q = []; qn = 0; return; }
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
  } else if (m.t === "hint") {
    hint = m.s ? { surah: m.s, ayah: m.a || 1 } : null;
    if (sess) sess.engine.setHint(hint);
  }
};
