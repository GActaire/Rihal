// Rihal — « Apprendre ma voix » : la reconnaissance s'adapte à ta voix et à ton micro, entièrement sur l'appareil.
// Principe : tu récites des versets connus ; pour chacun on garde ce que le modèle a entendu (ses probabilités et sa
// représentation interne du son). On apprend ensuite une petite correction personnelle (adaptateur de rang 16, environ
// 12 000 nombres) posée sur la sortie du modèle, avec la même fonction d'erreur que pour l'entraînement du modèle (CTC).
// La durée des madd et des ghunna n'est PAS adaptée : la correction ne doit jamais apprendre à cacher un madd trop court.
import { TOKENS, BLANK_ID } from "./tilawa/recitation/tokens.js";
import { KaldiFbank } from "./tilawa/recitation/fbank.js";

export const NV = TOKENS.length, ND = 512, NR = 16;
const VOWELS = "َُِ";

// versets de l'étalonnage : Al-Fatiha puis 62 versets choisis pour couvrir les lettres, voyelles, chadda et madd (≈ 560 mots, ≈ 10 min)
export const CAL_VERSES = [[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[1,7],[2,15],[3,96],[4,21],[4,49],[6,105],[7,55],[7,124],[7,130],[7,202],[11,41],[11,67],[12,39],[16,58],[17,21],[18,80],[19,25],[19,72],[19,83],[20,135],[21,45],[22,1],[22,29],[23,41],[23,53],[23,97],[23,110],[25,25],[26,28],[27,17],[28,34],[31,24],[33,45],[36,13],[36,14],[36,49],[36,50],[36,55],[36,68],[37,22],[37,105],[38,14],[38,18],[38,66],[39,61],[39,64],[39,70],[43,8],[43,62],[47,27],[54,2],[54,7],[54,42],[55,54],[55,56],[67,21],[67,22],[72,2],[83,14],[83,17],[91,14],[103,3],[106,4]];

/* ---------- découpage du texte en unités du modèle (plus long morceau d'abord, comme à l'entraînement) ---------- */
const TID = new Map(); TOKENS.forEach((t, i) => { if (i !== BLANK_ID) TID.set(t, i); });
const MAXL = Math.max(...TOKENS.map(t => t.length));
export function tokenize(s, starts) {
  const ids = [];
  for (let i = 0; i < s.length;) {
    let L = Math.min(MAXL, s.length - i);
    for (; L > 0; L--) { const id = TID.get(s.slice(i, i + L)); if (id != null) { ids.push(id); if (starts) starts.push(i); break; } }
    i += L > 0 ? L : 1;
  }
  return ids;
}
// unités du modèle d'un verset (mots en écriture phonétique du corpus) + le mot de chaque unité
export function verseUnits(words) {
  const text = words.join(""), starts = [], ids = tokenize(text, starts), wb = [];
  let o = 0; for (const w of words) { wb.push(o); o += w.length; }
  const word = starts.map(c => { let k = 0; while (k + 1 < wb.length && wb[k + 1] <= c) k++; return k; });
  return { ids, word };
}

/* ---------- groupes « durée » : madd (ا ۥ ۦ و ي) et ghunna (م ن ں ۾) de longueurs différentes ---------- */
const PROT = new Set("اۥۦويمنں۾");
export const GRP = new Int32Array(NV).map((_, i) => i);
{
  const by = new Map();
  TOKENS.forEach((t, i) => {
    if (i === BLANK_ID) return;
    let b = t; while (b && VOWELS.includes(b[b.length - 1])) b = b.slice(0, -1);
    const v = t.slice(b.length);
    if (b && new Set(b).size === 1 && PROT.has(b[0])) { const k = b[0] + "|" + v; if (!by.has(k)) by.set(k, []); by.get(k).push(i); }
  });
  for (const ids of by.values()) if (ids.length > 1) for (const i of ids) GRP[i] = ids[0];
}
const GLIST = [...new Set(GRP)].sort((a, b) => a - b);
const GIDX = new Map(GLIST.map((g, j) => [g, j]));
export const GMAP = Int32Array.from(GRP, g => GIDX.get(g));
export const NG = GLIST.length;
const GBLANK = GMAP[BLANK_ID];

/* ---------- petites briques de calcul ---------- */
const lse2 = (a, b) => a === -Infinity ? b : b === -Infinity ? a : a > b ? a + Math.log1p(Math.exp(b - a)) : b + Math.log1p(Math.exp(a - b));
function groupLse(row, o, out) { // row[o..o+NV) -> out[NG] (log-somme par groupe)
  out.fill(-Infinity);
  for (let v = 0; v < NV; v++) { const g = GMAP[v]; out[g] = lse2(out[g], row[o + v]); }
}

/* ---------- l'adaptateur ---------- */
export function newAdapter(seed = 7) {
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const A = new Float32Array(NR * ND); for (let i = 0; i < A.length; i++) A[i] = gauss() / Math.sqrt(ND);
  return { A, U: new Float32Array(NV * NR), c: new Float32Array(NV), mu: new Float32Array(ND), sd: new Float32Array(ND).fill(1) };
}

// applique l'adaptateur sur des trames du modèle (en place) : lp [T×NV] log-probabilités, enc [T×ND]
export function applyAdapter(ad, lp, enc, T) {
  const x = new Float32Array(ND), h = new Float32Array(NR), z = new Float64Array(NV), ga = new Float64Array(NG), gb = new Float64Array(NG);
  for (let t = 0; t < T; t++) {
    const o = t * NV, e = t * ND;
    for (let d = 0; d < ND; d++) x[d] = (enc[e + d] - ad.mu[d]) / ad.sd[d];
    for (let r = 0; r < NR; r++) { let s = 0; const ar = r * ND; for (let d = 0; d < ND; d++) s += ad.A[ar + d] * x[d]; h[r] = s; }
    let m = -Infinity;
    for (let v = 0; v < NV; v++) { let s = lp[o + v] + ad.c[v]; const uv = v * NR; for (let r = 0; r < NR; r++) s += ad.U[uv + r] * h[r]; z[v] = s; if (s > m) m = s; }
    let sum = 0; for (let v = 0; v < NV; v++) sum += Math.exp(z[v] - m);
    const lz = m + Math.log(sum);
    for (let v = 0; v < NV; v++) z[v] -= lz;
    // la durée (madd, ghunna) reste jugée par le modèle d'origine
    groupLse(z, 0, ga); groupLse(lp, o, gb);
    for (let v = 0; v < NV; v++) { const g = GMAP[v]; lp[o + v] = ga[g] + lp[o + v] - gb[g]; }
  }
}

/* ---------- CTC (dans l'espace des groupes) : vraisemblance + occupation de chaque groupe à chaque trame ---------- */
function ctc(lg, T, tg) { // lg : Float64Array T×NG (log-probas par groupe) ; tg : ids de groupes
  const S = 2 * tg.length + 1, L = new Int32Array(S).fill(GBLANK);
  for (let i = 0; i < tg.length; i++) L[2 * i + 1] = tg[i];
  if (T < tg.length) return null;
  const a = new Float64Array(T * S).fill(-Infinity), b = new Float64Array(T * S).fill(-Infinity);
  a[0] = lg[L[0]]; if (S > 1) a[1] = lg[L[1]];
  for (let t = 1; t < T; t++) {
    const p = (t - 1) * S, q = t * S, r = t * NG;
    for (let s = 0; s < S; s++) {
      let v = a[p + s];
      if (s > 0) v = lse2(v, a[p + s - 1]);
      if (s > 1 && L[s] !== GBLANK && L[s] !== L[s - 2]) v = lse2(v, a[p + s - 2]);
      a[q + s] = v + lg[r + L[s]];
    }
  }
  const lt = (T - 1) * S;
  b[lt + S - 1] = lg[(T - 1) * NG + L[S - 1]]; if (S > 1) b[lt + S - 2] = lg[(T - 1) * NG + L[S - 2]];
  for (let t = T - 2; t >= 0; t--) {
    const n = (t + 1) * S, q = t * S, r = t * NG;
    for (let s = 0; s < S; s++) {
      let v = b[n + s];
      if (s + 1 < S) v = lse2(v, b[n + s + 1]);
      if (s + 2 < S && L[s] !== GBLANK && L[s] !== L[s + 2]) v = lse2(v, b[n + s + 2]);
      b[q + s] = v + lg[r + L[s]];
    }
  }
  const ll = S > 1 ? lse2(a[lt + S - 1], a[lt + S - 2]) : a[lt];
  if (!isFinite(ll)) return null;
  const gam = new Float64Array(T * NG);
  for (let t = 0; t < T; t++) {
    const q = t * S, r = t * NG;
    for (let s = 0; s < S; s++) { const w = a[q + s] + b[q + s] - lg[r + L[s]] - ll; if (w > -30) gam[r + L[s]] += Math.exp(w); }
  }
  return { nll: -ll, gam };
}

/* ---------- entraînement ---------- */
// data : [{ lp: Float32Array, enc: Float32Array, T, tgt: Int32Array }]
function forward(ad, d, keep) {
  const { T } = d, x = new Float32Array(T * ND), h = new Float32Array(T * NR), out = new Float64Array(T * NV), lg = new Float64Array(T * NG);
  for (let t = 0; t < T; t++) {
    const e = t * ND, o = t * NV;
    for (let k = 0; k < ND; k++) x[e + k] = (d.enc[e + k] - ad.mu[k]) / ad.sd[k];
    for (let r = 0; r < NR; r++) { let s = 0; const ar = r * ND; for (let k = 0; k < ND; k++) s += ad.A[ar + k] * x[e + k]; h[t * NR + r] = s; }
    let m = -Infinity;
    for (let v = 0; v < NV; v++) { let s = d.lp[o + v] + ad.c[v]; const uv = v * NR; for (let r = 0; r < NR; r++) s += ad.U[uv + r] * h[t * NR + r]; out[o + v] = s; if (s > m) m = s; }
    let sum = 0; for (let v = 0; v < NV; v++) sum += Math.exp(out[o + v] - m);
    const lz = m + Math.log(sum);
    for (let v = 0; v < NV; v++) out[o + v] -= lz;
    groupLse(out, o, lg.subarray(t * NG, (t + 1) * NG));
  }
  return keep ? { x, h, out, lg } : { lg };
}
const groupTargets = tgt => Int32Array.from(tgt, v => GMAP[v]);
function valNll(ad, data) {
  let tot = 0, n = 0;
  for (const d of data) { const { lg } = forward(ad, d, false); const r = ctc(lg, d.T, groupTargets(d.tgt)); if (r) { tot += r.nll; n += d.tgt.length; } }
  return n ? tot / n : Infinity;
}
export async function trainAdapter(train, val, { epochs = 15, lr = 3e-3, wd = 1e-3, onEpoch } = {}) {
  const ad = newAdapter();
  // normalisation des représentations sur tes enregistrements
  let n = 0; const s1 = new Float64Array(ND), s2 = new Float64Array(ND);
  for (const d of train) for (let t = 0; t < d.T; t++) for (let k = 0; k < ND; k++) { const v = d.enc[t * ND + k]; s1[k] += v; s2[k] += v * v; n++; }
  n /= ND;
  for (let k = 0; k < ND; k++) { ad.mu[k] = s1[k] / n; ad.sd[k] = Math.sqrt(Math.max(1e-6, s2[k] / n - ad.mu[k] * ad.mu[k])) + 1e-3; }
  const P = [ad.A, ad.U, ad.c], M = P.map(p => new Float64Array(p.length)), Vv = P.map(p => new Float64Array(p.length));
  const snap = () => P.map(p => p.slice());
  let best = { w: snap(), v: val.length ? valNll(ad, val) : Infinity, ep: -1 }, step = 0;
  const base = best.v;
  for (let ep = 0; ep < epochs; ep++) {
    const order = train.map((_, i) => i); let seed = ep + 1;
    for (let i = order.length - 1; i > 0; i--) { seed = (seed * 16807) % 2147483647; const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    for (const di of order) {
      const d = train[di], tg = groupTargets(d.tgt), { x, h, out, lg } = forward(ad, d, true), r = ctc(lg, d.T, tg);
      if (!r) continue;
      const T = d.T, nt = tg.length, gA = new Float64Array(NR * ND), gU = new Float64Array(NV * NR), gc = new Float64Array(NV), gh = new Float64Array(NR);
      for (let t = 0; t < T; t++) {
        const o = t * NV, q = t * NG; gh.fill(0);
        for (let v = 0; v < NV; v++) {
          const p = Math.exp(out[o + v]), g = GMAP[v], pg = Math.exp(lg[q + g]);
          const gz = (p - (pg > 1e-30 ? r.gam[q + g] * p / pg : 0)) / nt;
          if (gz === 0) continue;
          gc[v] += gz; const uv = v * NR;
          for (let k = 0; k < NR; k++) { gU[uv + k] += gz * h[t * NR + k]; gh[k] += gz * ad.U[uv + k]; }
        }
        for (let k = 0; k < NR; k++) { const g = gh[k]; if (g === 0) continue; const ak = k * ND, e = t * ND; for (let j = 0; j < ND; j++) gA[ak + j] += g * x[e + j]; }
      }
      step++;
      const G = [gA, gU, gc], dec = [wd * 0.1, wd, wd];
      for (let pi = 0; pi < 3; pi++) {
        const p = P[pi], g = G[pi], m = M[pi], vv = Vv[pi], b1 = 1 - Math.pow(0.9, step), b2 = 1 - Math.pow(0.999, step);
        for (let i = 0; i < p.length; i++) { const gi = g[i] + dec[pi] * p[i]; m[i] = 0.9 * m[i] + 0.1 * gi; vv[i] = 0.999 * vv[i] + 0.001 * gi * gi; p[i] -= lr * (m[i] / b1) / (Math.sqrt(vv[i] / b2) + 1e-8); }
      }
    }
    const v = val.length ? valNll(ad, val) : 0;
    if (v < best.v) best = { w: snap(), v, ep };
    if (onEpoch) await onEpoch(ep + 1, epochs);
  }
  best.w.forEach((w, i) => P[i].set(w));
  return { ad, baseNll: base, nll: best.v, epoch: best.ep };
}

/* ---------- lecture « gloutonne » de ce que le modèle a entendu + mesure d'erreur ---------- */
export function greedy(lp, T) {
  const out = [], frames = []; let prev = BLANK_ID;
  for (let t = 0; t < T; t++) {
    let best = 0, bv = -Infinity; const o = t * NV;
    for (let v = 0; v < NV; v++) if (lp[o + v] > bv) { bv = lp[o + v]; best = v; }
    if (best !== BLANK_ID && best !== prev) { out.push(best); frames.push(t); }
    prev = best;
  }
  return { ids: out, frames };
}
export function editDistance(a, b) {
  let d = new Int32Array(b.length + 1).map((_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const nd = new Int32Array(b.length + 1); nd[0] = i;
    for (let j = 1; j <= b.length; j++) nd[j] = Math.min(d[j] + 1, nd[j - 1] + 1, d[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    d = nd;
  }
  return d[b.length];
}
// erreurs hors durée (les madd et ghunna comptent comme justes quelle que soit leur longueur)
export function errorRate(data, ad) {
  let e = 0, n = 0;
  for (const d of data) {
    let lp = d.lp;
    if (ad) { lp = d.lp.slice(); applyAdapter(ad, lp, d.enc, d.T); }
    const h = greedy(lp, d.T).ids.map(v => GMAP[v]), r = Array.from(d.tgt, v => GMAP[v]);
    e += editDistance(h, r); n += r.length;
  }
  return n ? e / n : 0;
}

/* ---------- passage du son au modèle pour un verset entier (étalonnage) ---------- */
export async function runVerse(runner, samples) {
  const fb = new KaldiFbank();
  const tail = new Float32Array(16000 * 1.5);
  const frames = [...fb.acceptWaveform(samples), ...fb.acceptWaveform(tail), ...fb.inputFinished()];
  runner.reset(); // (1,5 s de silence en fin de verset : la dernière fenêtre du modèle contient tout le verset)
  const lps = [], encs = []; let T = 0;
  for (let i = 0; i < frames.length; i += 200) {
    const r = await runner.accept(frames.slice(i, i + 200));
    if (r.frames) { lps.push(r.logProbs); T += r.frames; if (r.encoder) encs.push(r.encoder); }
  }
  runner.reset();
  const lp = new Float32Array(T * NV), enc = new Float32Array(T * ND);
  let o = 0; for (const a of lps) { lp.set(a, o); o += a.length; }
  o = 0; for (const a of encs) { enc.set(a.subarray(0, Math.min(a.length, enc.length - o)), o); o += a.length; }
  return { lp, enc, T };
}

/* ---------- stockage sur l'appareil (IndexedDB) ---------- */
const DB = "rihal-voix", ST = "versets", AD = "adaptateur";
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(ST)) d.createObjectStore(ST); if (!d.objectStoreNames.contains(AD)) d.createObjectStore(AD); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store, mode), s = t.objectStore(store); const out = fn(s); t.oncomplete = () => res(typeof IDBRequest !== "undefined" && out instanceof IDBRequest ? out.result : out); t.onerror = () => rej(t.error); });
}
// compression : représentation interne en entiers 8 bits (une échelle par dimension), probabilités en 16 bits
export function pack(v) {
  const { T } = v, sc = new Float32Array(ND);
  for (let t = 0; t < T; t++) for (let k = 0; k < ND; k++) { const a = Math.abs(v.enc[t * ND + k]); if (a > sc[k]) sc[k] = a; }
  for (let k = 0; k < ND; k++) sc[k] = sc[k] / 127 || 1e-6;
  const e8 = new Int8Array(T * ND); for (let t = 0; t < T; t++) for (let k = 0; k < ND; k++) e8[t * ND + k] = Math.round(v.enc[t * ND + k] / sc[k]);
  const l16 = new Int16Array(T * NV); for (let i = 0; i < l16.length; i++) l16[i] = Math.max(-32768, Math.round(Math.max(v.lp[i], -65) * 500));
  return { T, e8, sc, l16, tgt: Int32Array.from(v.tgt), key: v.key, dur: v.dur, date: v.date, audio: v.audio || null, ok: v.ok !== false, per: v.per, issues: v.issues || [] };
}
export function unpack(p) {
  const { T } = p, enc = new Float32Array(T * ND), lp = new Float32Array(T * NV);
  for (let t = 0; t < T; t++) for (let k = 0; k < ND; k++) enc[t * ND + k] = p.e8[t * ND + k] * p.sc[k];
  for (let i = 0; i < lp.length; i++) lp[i] = p.l16[i] / 500;
  return { T, enc, lp, tgt: p.tgt, key: p.key, dur: p.dur, date: p.date, audio: p.audio, ok: p.ok !== false, per: p.per, issues: p.issues };
}
export const saveVerse = v => tx(ST, "readwrite", s => s.put(pack(v), v.key));
export const deleteVerse = key => tx(ST, "readwrite", s => s.delete(key));
export const loadVerses = async () => (await tx(ST, "readonly", s => s.getAll())).map(unpack);
export const listVerses = async () => (await tx(ST, "readonly", s => s.getAll())).map(p => ({ key: p.key, dur: p.dur, date: p.date, ok: p.ok !== false, per: p.per }));
export const clearVoice = async () => { await tx(ST, "readwrite", s => s.clear()); await tx(AD, "readwrite", s => s.clear()); };
export const saveAdapter = ad => tx(AD, "readwrite", s => s.put(ad, "voix"));
export const loadAdapter = () => tx(AD, "readonly", s => s.get("voix"));

/* ---------- diagnostic : quel mot, quelle lettre, quelle voyelle ---------- */
const stemOf = t => { let b = t; while (b && VOWELS.includes(b[b.length - 1])) b = b.slice(0, -1); return b; };
const vowelOf = t => VOWELS.includes(t[t.length - 1]) ? t[t.length - 1] : "";
// alignement entendu / attendu (une voyelle changée coûte moins qu'une lettre changée : l'alignement reste juste)
function alignUnits(h, e) {
  const n = h.length, m = e.length, D = new Float64Array((n + 1) * (m + 1)), W = m + 1;
  const sub = (a, b) => a === b ? 0 : GMAP[a] === GMAP[b] ? 0.2 : stemOf(TOKENS[a]) === stemOf(TOKENS[b]) ? 0.5 : 1;
  for (let i = 0; i <= n; i++) D[i * W] = i; for (let j = 0; j <= m; j++) D[j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i * W + j] = Math.min(D[(i - 1) * W + j] + 1, D[i * W + j - 1] + 1, D[(i - 1) * W + j - 1] + sub(h[i - 1], e[j - 1]));
  const ops = []; let i = n, j = m;
  while (i || j) {
    if (i && j && Math.abs(D[i * W + j] - D[(i - 1) * W + j - 1] - sub(h[i - 1], e[j - 1])) < 1e-9) { ops.push([i - 1, j - 1]); i--; j--; }
    else if (i && Math.abs(D[i * W + j] - D[(i - 1) * W + j] - 1) < 1e-9) { ops.push([i - 1, -1]); i--; }
    else { ops.push([-1, j - 1]); j--; }
  }
  return ops.reverse();
}
// lp : probabilités du modèle (T×NV) ; units : verseUnits(...) ; renvoie les écarts sûrs, mot par mot
export function diagnose(lp, T, units, { margin = 2.3 } = {}) {
  const { ids: heard, frames } = greedy(lp, T), exp = units.ids, ops = alignUnits(heard, exp);
  const out = [];
  const conf = (f, a, b) => lp[f * NV + a] - lp[f * NV + b];
  // on ne juge que la partie du verset réellement récitée (début tardif, arrêt avant la fin : pas des oublis)
  const same = ([hi, ej]) => hi >= 0 && ej >= 0 && GMAP[heard[hi]] === GMAP[exp[ej]], pair = o => o && o[0] >= 0 && o[1] >= 0;
  let k0 = ops.findIndex(same), k1 = -1;
  for (let k = ops.length - 1; k >= 0; k--) if (same(ops[k])) { k1 = k; break; }
  if (k0 > 0 && pair(ops[k0 - 1])) k0--; // une première syllabe changée juste avant reste jugée
  if (k1 >= 0 && pair(ops[k1 + 1])) k1++;
  if (k0 < 0) return { heard: heard.map(v => TOKENS[v]).join(""), words: [], units: heard.length };
  let lastWord = 0;
  for (let k = k0; k <= k1; k++) {
    const [hi, ej] = ops[k];
    if (ej >= 0) lastWord = units.word[ej];
    if (hi >= 0 && ej >= 0) {
      const h = heard[hi], e = exp[ej];
      if (h === e || GMAP[h] === GMAP[e]) continue; // identique, ou seulement la durée (jugée ailleurs)
      if (ej >= exp.length - 2 && stemOf(TOKENS[h]) === stemOf(TOKENS[e])) continue; // fin de verset : à l'arrêt, la dernière voyelle tombe (waqf)
      const c = conf(frames[hi], h, e);
      if (c < margin) continue; // le modèle hésite : on ne dit rien plutôt que de se tromper
      const th = TOKENS[h], te = TOKENS[e], vowel = stemOf(th) === stemOf(te);
      out.push({ w: units.word[ej], kind: vowel ? "voyelle" : "lettre", heard: th, expected: te, letter: stemOf(te).slice(-1), from: vowelOf(te), to: vowelOf(th), sure: +c.toFixed(1), u: ej });
    } else if (ej >= 0) {
      out.push({ w: units.word[ej], kind: "oubli", expected: TOKENS[exp[ej]], u: ej, weak: true });
    } else {
      out.push({ w: lastWord, kind: "ajout", heard: TOKENS[heard[hi]], weak: true });
    }
  }
  // par mot : beaucoup d'écarts -> c'est sans doute un autre mot
  const byWord = new Map();
  for (const it of out) { if (!byWord.has(it.w)) byWord.set(it.w, []); byWord.get(it.w).push(it); }
  const words = [];
  for (const [w, list] of byWord) {
    const n = units.word.filter(x => x === w).length, strong = list.filter(x => !x.weak).length, weak = list.length - strong;
    const span = [];
    for (const [hi, ej] of ops) if (hi >= 0 && ((ej >= 0 && units.word[ej] === w) || (ej < 0 && false))) span.push(heard[hi]);
    const changed = strong >= 2 || (strong + weak) / Math.max(1, n) >= 0.5;
    words.push({ w, items: list.filter(x => !x.weak || changed), changed, heardUnits: span.map(v => TOKENS[v]).join("") });
  }
  return { heard: heard.map(v => TOKENS[v]).join(""), words: words.filter(x => x.items.length), units: heard.length };
}
