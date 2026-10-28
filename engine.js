// Rihal — moteur d'analyse (16 kHz mono). Fonctionne dans la page et dans un worker.
(function () {
const SR = 16000, WIN = 400, HOP = 160, NFFT = 512, NMEL = 26, NCEP = 13, D = NCEP - 1;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

let MELFB = null, HAM = null, DCT = null;
function setup() {
  if (MELFB) return;
  const hz2mel = h => 2595 * Math.log10(1 + h / 700), mel2hz = m => 700 * (10 ** (m / 2595) - 1);
  const lo = hz2mel(80), hi = hz2mel(7600), pts = [];
  for (let i = 0; i < NMEL + 2; i++) pts.push(Math.floor((NFFT + 1) * mel2hz(lo + (hi - lo) * i / (NMEL + 1)) / SR));
  MELFB = [];
  for (let m = 1; m <= NMEL; m++) {
    const f = new Float32Array(NFFT / 2 + 1);
    for (let k = pts[m - 1]; k < pts[m]; k++) f[k] = (k - pts[m - 1]) / Math.max(1, pts[m] - pts[m - 1]);
    for (let k = pts[m]; k <= pts[m + 1]; k++) f[k] = (pts[m + 1] - k) / Math.max(1, pts[m + 1] - pts[m]);
    MELFB.push(f);
  }
  HAM = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) HAM[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (WIN - 1));
  DCT = [];
  for (let q = 1; q < NCEP; q++) { const r = new Float32Array(NMEL); for (let m = 0; m < NMEL; m++) r[m] = Math.cos(Math.PI * q * (m + 0.5) / NMEL); DCT.push(r); }
}

const _re = new Float64Array(NFFT), _im = new Float64Array(NFFT);
function frameAt(x, off) {
  setup();
  _re.fill(0); _im.fill(0);
  let e = 0;
  for (let i = 0; i < WIN; i++) {
    const s = x[off + i] || 0, p = off + i > 0 ? (x[off + i - 1] || 0) : 0;
    _re[i] = (s - 0.97 * p) * HAM[i]; e += s * s;
  }
  fft(_re, _im);
  const lm = new Float32Array(NMEL);
  for (let m = 0; m < NMEL; m++) {
    let s = 0; const f = MELFB[m];
    for (let k = 0; k <= NFFT / 2; k++) if (f[k]) s += f[k] * (_re[k] * _re[k] + _im[k] * _im[k]);
    lm[m] = Math.log(s + 1e-8);
  }
  const c = new Float32Array(D);
  for (let q = 0; q < D; q++) { let s = 0; const r = DCT[q]; for (let m = 0; m < NMEL; m++) s += lm[m] * r[m]; c[q] = s; }
  return { e: 10 * Math.log10(e / WIN + 1e-10), lm, c };
}

function percentile(arr, p) {
  const a = Array.from(arr).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}
const actThr = (floor, peak) => Math.max(Math.min(floor + 12, peak - 25), peak - 40);

function features(x) {
  const n = Math.max(1, Math.floor((x.length - WIN) / HOP) + 1);
  const energy = new Float32Array(n), logmel = [], cep = [];
  for (let t = 0; t < n; t++) { const f = frameAt(x, t * HOP); energy[t] = f.e; logmel.push(f.lm); cep.push(f.c); }
  const thr = actThr(percentile(energy, 0.05), percentile(energy, 0.98));
  const active = new Uint8Array(n);
  for (let t = 0; t < n; t++) active[t] = energy[t] > thr ? 1 : 0;
  const mu = new Float32Array(D), sd = new Float32Array(D);
  let cnt = 0;
  for (let t = 0; t < n; t++) if (active[t]) { cnt++; for (let d = 0; d < D; d++) mu[d] += cep[t][d]; }
  for (let d = 0; d < D; d++) mu[d] /= Math.max(1, cnt);
  for (let t = 0; t < n; t++) if (active[t]) for (let d = 0; d < D; d++) sd[d] += (cep[t][d] - mu[d]) ** 2;
  for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d] / Math.max(1, cnt)) + 1e-6;
  for (let t = 0; t < n; t++) for (let d = 0; d < D; d++) cep[t][d] = (cep[t][d] - mu[d]) / sd[d];
  const flux = new Float32Array(n);
  for (let t = 1; t < n - 1; t++) { let s = 0; for (let m = 0; m < NMEL; m++) s += Math.abs(logmel[t + 1][m] - logmel[t - 1][m]); flux[t] = s / NMEL; }
  const sm = new Float32Array(n);
  for (let t = 0; t < n; t++) { let s = 0, c = 0; for (let k = -2; k <= 2; k++) if (t + k >= 0 && t + k < n) { s += flux[t + k]; c++; } sm[t] = s / c; }
  let a0 = 0, a1 = n - 1;
  while (a0 < n && !active[a0]) a0++;
  while (a1 > a0 && !active[a1]) a1--;
  a0 = Math.max(0, a0 - 5); a1 = Math.min(n - 1, a1 + 5);
  return { n, energy, active, cep, flux: sm, a0, a1 };
}

function maskBelow(f, a, b, p) {
  const act = [];
  for (let t = a; t <= b; t++) if (f.active[t]) act.push(f.flux[t]);
  const thr = percentile(act, p);
  const m = new Uint8Array(f.n);
  for (let t = a; t <= b; t++) m[t] = f.active[t] && f.flux[t] <= thr ? 1 : 0;
  return m;
}

// Plus longue tenue dans [lo, hi], en tolérant de petites coupures (vibrato, souffle).
function runIn(mask, lo, hi, gapMax) {
  let best = 0, st = -1, last = -1, bs = -1, be = -1;
  for (let t = Math.max(0, lo); t <= Math.min(mask.length - 1, hi); t++) {
    if (!mask[t]) continue;
    if (st < 0 || t - last > gapMax + 1) st = t;
    last = t;
    if (last - st + 1 > best) { best = last - st + 1; bs = st; be = last; }
  }
  return { len: best, seg: best ? [bs, be] : null };
}

function segmentsOf(mask, a, b, minLen) {
  const segs = []; let s = -1, gap = 0;
  for (let t = a; t <= b + 1; t++) {
    const ok = t <= b && mask[t];
    if (ok) { if (s < 0) s = t; gap = 0; }
    else if (s >= 0) {
      gap++;
      if (gap > 3 || t > b) { const e = t - gap; if (e - s + 1 >= minLen) segs.push([s, e]); s = -1; gap = 0; }
    }
  }
  return segs;
}

function cdist(x, y) { let s = 0; for (let d = 0; d < D; d++) { const v = x[d] - y[d]; s += v * v; } return Math.sqrt(s / D); }

function dtwCore(A, B) {
  const n = A.length, m = B.length;
  const band = Math.max(80, Math.floor(0.3 * Math.max(n, m)));
  const cost = new Float32Array(n * m).fill(Infinity), back = new Uint8Array(n * m);
  for (let i = 0; i < n; i++) {
    const jc = Math.round(i * (m - 1) / Math.max(1, n - 1));
    for (let j = Math.max(0, jc - band); j <= Math.min(m - 1, jc + band); j++) {
      const d = cdist(A[i], B[j]);
      if (i === 0 && j === 0) { cost[0] = d; continue; }
      let best = Infinity, bk = 0;
      if (i > 0 && j > 0 && cost[(i - 1) * m + j - 1] < best) { best = cost[(i - 1) * m + j - 1]; bk = 0; }
      if (i > 0 && cost[(i - 1) * m + j] + 0.1 < best) { best = cost[(i - 1) * m + j] + 0.1; bk = 1; }
      if (j > 0 && cost[i * m + j - 1] + 0.1 < best) { best = cost[i * m + j - 1] + 0.1; bk = 2; }
      cost[i * m + j] = best + d; back[i * m + j] = bk;
    }
  }
  const path = []; let i = n - 1, j = m - 1;
  while (i >= 0 && j >= 0) {
    path.push([i, j, cdist(A[i], B[j])]);
    if (i === 0 && j === 0) break;
    const bk = back[i * m + j];
    if (i === 0) j--; else if (j === 0) i--; else if (bk === 0) { i--; j--; } else if (bk === 1) i--; else j--;
  }
  return path.reverse();
}

// DTW où A (référence) peut commencer et finir n'importe où dans B (élève).
function dtwSub(A, B) {
  const n = A.length, m = B.length;
  const cost = new Float32Array(n * m), back = new Uint8Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const d = cdist(A[i], B[j]);
    if (i === 0) { cost[j] = d; continue; }
    let best = cost[(i - 1) * m + j] + 0.1, bk = 1;
    if (j > 0 && cost[(i - 1) * m + j - 1] < best) { best = cost[(i - 1) * m + j - 1]; bk = 0; }
    if (j > 0 && cost[i * m + j - 1] + 0.1 < best) { best = cost[i * m + j - 1] + 0.1; bk = 2; }
    cost[i * m + j] = best + d; back[i * m + j] = bk;
  }
  let j = 0, bv = Infinity;
  for (let q = 0; q < m; q++) if (cost[(n - 1) * m + q] < bv) { bv = cost[(n - 1) * m + q]; j = q; }
  const path = []; let i = n - 1;
  while (i >= 0 && j >= 0) {
    path.push([i, j, cdist(A[i], B[j])]);
    if (i === 0) break;
    const bk = back[i * m + j];
    if (bk === 0) { i--; j--; } else if (bk === 1) i--; else j--;
  }
  return path.reverse();
}

// DTW sur [a0..a1] x [b0..b1], sous-échantillonné pour les longs versets.
function dtw(A, B, a0, a1, b0, b1) {
  const n = a1 - a0 + 1, m = b1 - b0 + 1;
  const k = Math.max(1, Math.ceil(Math.sqrt(n * m / 5e6)));
  const pool = (X, s, e) => {
    const out = [];
    for (let t = s; t <= e; t += k) {
      const v = new Float32Array(D); let c = 0;
      for (let q = t; q < Math.min(e + 1, t + k); q++) { for (let d = 0; d < D; d++) v[d] += X[q][d]; c++; }
      for (let d = 0; d < D; d++) v[d] /= c;
      out.push(v);
    }
    return out;
  };
  const P = dtwCore(pool(A, a0, a1), pool(B, b0, b1));
  if (k === 1) return P.map(([i, j, d]) => [a0 + i, b0 + j, d]);
  const path = [];
  for (let q = 0; q < P.length; q++) {
    const [i, j, d] = P[q], nx = P[q + 1];
    const di = nx ? nx[0] - i : 1, dj = nx ? nx[1] - j : 1;
    for (let s = 0; s < k; s++) {
      const fi = Math.min(a1, a0 + i * k + (di ? s : 0)), fj = Math.min(b1, b0 + j * k + (dj ? s : 0));
      path.push([fi, fj, d]);
    }
  }
  return path;
}

function pathTempo(path, a0, a1) {
  const span = a1 - a0, lo = a0 + 0.1 * span, hi = a0 + 0.9 * span;
  let jl = null, jh = null;
  for (const [i, j] of path) { if (jl === null && i >= lo) jl = j; if (i <= hi) jh = j; }
  if (jl === null || jh === null || hi - lo < 10) return 1;
  return Math.min(2.5, Math.max(0.4, (jh - jl) / (hi - lo)));
}

// ===== Repérage des madds dans le texte uthmani =====
const isMark = c => { const x = c.codePointAt(0); return (x >= 0x064B && x <= 0x065F) || x === 0x0670 || (x >= 0x06D6 && x <= 0x06ED); };
const FATHA = "َ", DAMMA = "ُ", KASRA = "ِ", SUKUN = "ْ", SUKUN2 = "ۡ", SHADDA = "ّ", MADDAH = "ٓ", DAGGER = "ٰ", SILENT = "۟";
const VOWELS = /[ً-ْۡ]/;
const HAMZA = /[ءأإؤئ]/;
function letters(word) {
  const out = [];
  for (const c of word) {
    if (isMark(c) && out.length) out[out.length - 1].m += c;
    else out.push({ c, m: "" });
  }
  return out;
}
// Retourne [{w, type, at, syl}] pour un verset (mots sans le numéro de fin).
function detectMadds(words) {
  const res = [];
  words.forEach((word, wi) => {
    const L = letters(word), nb = L.length;
    const nextStartsWasl = wi + 1 < words.length && words[wi + 1][0] === "ٱ";
    for (let i = 0; i < nb; i++) {
      const { c, m } = L[i], prev = L[i - 1];
      let madd = false;
      if (m.includes(DAGGER)) madd = true;
      else if (prev && !VOWELS.test(m) && !m.includes(SILENT) && !m.includes(SHADDA)) {
        if (c === "ا" && prev.m.includes(FATHA)) madd = true;
        else if (c === "و" && prev.m.includes(DAMMA)) madd = true;
        else if ((c === "ي" || c === "ى") && prev.m.includes(KASRA)) madd = true;
      }
      // alif caché du nom d'Allah (لَّه)
      if (!madd && c === "ل" && m.includes(SHADDA) && m.includes(FATHA) && L[i + 1] && L[i + 1].c === "ه" && i >= 1 && L[i - 1].c === "ل") madd = true;
      if (!madd) continue;
      const hasMaddah = m.includes(MADDAH) || (prev && prev.m.includes(MADDAH));
      let type = "tabii";
      if (hasMaddah) {
        const nx = L[i + 1];
        if (nx && (nx.m.includes(SHADDA) || nx.m.includes(SUKUN) || nx.m.includes(SUKUN2))) type = "lazim";
        else if (!nx) type = "munfasil";
        else type = "muttasil";
      }
      // madd en fin de mot suivi d'une hamzat wasl : il tombe à la liaison
      if (i === nb - 1 && nextStartsWasl && type === "tabii") continue;
      const syl = (prev ? prev.c + prev.m : "") + c + m;
      res.push({ w: wi, type, at: (i + 0.5) / nb, syl, idx: i, nb });
    }
  });
  // madd ʿāriḍ : dernière voyelle longue du verset, suivie d'une seule lettre
  const lw = words.length - 1;
  const last = res.filter(r => r.w === lw).pop();
  if (last && last.type === "tabii" && last.nb - last.idx <= 2) last.type = "arid";
  return res.map(({ w, type, at, syl }) => ({ w, type, at, syl }));
}

// ===== Préparation de la référence =====
// wordTimes : [[w0, w1, ms0, ms1], ...] (minutage d'al-Husary, mots 0-based, w1 exclusif)
function prepareRef(x, madds, wordTimes, nWords) {
  const F = features(x);
  const { a0, a1 } = F;
  const mask = maskBelow(F, a0, a1, 0.6), soft = maskBelow(F, a0, a1, 0.75);
  const segs = segmentsOf(mask, a0, a1, 7);
  const lens = segs.map(([s, e]) => e - s + 1);
  const unit = lens.length >= 5 ? Math.max(8, percentile(lens, 0.35)) : 15;
  const wt = [];
  if (wordTimes && wordTimes.length) {
    for (const [w0, w1, m0, m1] of wordTimes) {
      const k = Math.max(1, w1 - w0);
      for (let w = w0; w < w1; w++) wt[w] = [m0 / 10 + (m1 - m0) / 10 * (w - w0) / k, m0 / 10 + (m1 - m0) / 10 * (w - w0 + 1) / k];
    }
    for (let w = 0; w < (nWords || wt.length); w++) if (!wt[w]) { const p = wt[w - 1] || [a0, a0]; wt[w] = [p[1], p[1] + 20]; }
  } else if (nWords) {
    for (let w = 0; w < nWords; w++) wt[w] = [a0 + (a1 - a0) * w / nWords, a0 + (a1 - a0) * (w + 1) / nWords];
  }
  let targets = [];
  if (madds && madds.length && wt.length) {
    const cand = segs.filter(([s, e]) => e - s + 1 >= 1.3 * unit).map(([s, e]) => ({ s, e, len: e - s + 1, c: (s + e) / 2 }));
    const expect = madds.map(md => { const t = wt[md.w] || [a0, a1]; return t[0] + (t[1] - t[0]) * (md.at != null ? md.at : 0.6); });
    const M = madds.length, K = cand.length;
    const S = [], B = [];
    for (let m = 0; m <= M; m++) { S.push(new Float64Array(K + 1)); B.push(new Int8Array(K + 1)); }
    for (let m = 1; m <= M; m++) for (let k = 1; k <= K; k++) {
      let best = S[m - 1][k], b = 1;
      if (S[m][k - 1] > best) { best = S[m][k - 1]; b = 2; }
      const cd = cand[k - 1], md = madds[m - 1];
      const t = wt[md.w] || [a0, a1];
      const inside = cd.c >= t[0] - 8 && cd.c <= t[1] + 8;
      const cap = md.type === "tabii" ? 3 : 8;
      const sc = (inside ? 1 : 0) + Math.min(cd.len / unit, cap) - 0.06 * Math.abs(cd.c - expect[m - 1]);
      if (sc > 0.8 && S[m - 1][k - 1] + sc > best) { best = S[m - 1][k - 1] + sc; b = 3; }
      S[m][k] = best; B[m][k] = b;
    }
    const match = new Array(M).fill(null);
    let m = M, k = K;
    while (m > 0 && k > 0) { const b = B[m][k]; if (b === 3) { match[m - 1] = [cand[k - 1].s, cand[k - 1].e]; m--; k--; } else if (b === 1) m--; else k--; }
    targets = madds.map((md, i) => ({ ...md, seg: match[i] }));
  } else {
    targets = segs.filter(([s, e]) => e - s + 1 >= 2.1 * unit).map(seg => ({ w: -1, type: "gen", seg }));
  }
  for (const t of targets) if (t.seg) t.rLen = runIn(soft, t.seg[0] - 6, t.seg[1] + 6, 6).len;
  const ref = { F, mask, soft, segs, unit, targets, wt, nWords: nWords || wt.length };
  for (const t of targets) if ((t.w == null || t.w < 0) && t.seg) t.w = wordAt(ref, (t.seg[0] + t.seg[1]) / 2).w;
  return ref;
}

// Mot prononcé à la trame f de la référence, et avancement dans ce mot (0..1).
function wordAt(ref, f) {
  const wt = ref.wt;
  if (!wt || !wt.length) return { w: -1, f: 0 };
  if (f < wt[0][0]) return { w: 0, f: 0 };
  for (let w = 0; w < wt.length; w++) {
    const [s, e] = wt[w];
    if (f <= e) return { w, f: Math.max(0, Math.min(1, (f - s) / Math.max(1, e - s))) };
    if (w + 1 < wt.length && f < wt[w + 1][0]) return { w, f: 1 };
  }
  return { w: wt.length - 1, f: 1 };
}

// Le madd ʿāriḍ accepte 2, 4 ou 6 temps : on ne signale que les grands écarts.
function judge(ratio, type) {
  if (type === "arid") return ratio < 0.4 ? "court" : ratio > 2 ? "long" : "ok";
  return ratio < 0.6 ? "court" : ratio > 1.75 ? "long" : "ok";
}
// Correction personnelle apprise à l'étalonnage
function groupOf(type) { return type === "arid" ? "arid" : (type === "lazim" || type === "muttasil" || type === "munfasil") ? "long" : "tabii"; }
function biasOf(bias, type) { const b = bias && bias[groupOf(type)]; return b && isFinite(b) ? b : 1; }
const sec = f => f * HOP / SR;

// ===== Analyse complète d'un verset =====
function analyzeFull(ref, usr, bias) {
  const F = ref.F, G = features(usr);
  if (G.a1 - G.a0 < 20) return { items: [], tempo: 1, empty: true };
  const path = dtw(F.cep, G.cep, F.a0, F.a1, G.a0, G.a1);
  const r2u = new Map(), u2r = new Map();
  for (const [i, j] of path) {
    if (!r2u.has(i)) r2u.set(i, [j, j]); else r2u.get(i)[1] = j;
    if (!u2r.has(j)) u2r.set(j, [i, i]); else u2r.get(j)[1] = i;
  }
  const R = pathTempo(path, F.a0, F.a1);
  const softU = maskBelow(G, G.a0, G.a1, 0.75);
  const mapR = (s, e) => { let lo = Infinity, hi = -1; for (let i = s; i <= e; i++) { const v = r2u.get(i); if (v) { lo = Math.min(lo, v[0]); hi = Math.max(hi, v[1]); } } return [lo, hi]; };
  const mapU = (s, e) => { let lo = Infinity, hi = -1; for (let j = s; j <= e; j++) { const v = u2r.get(j); if (v) { lo = Math.min(lo, v[0]); hi = Math.max(hi, v[1]); } } return [lo, hi]; };
  const items = [];
  for (const t of ref.targets) {
    if (!t.seg || !t.rLen) { items.push({ w: t.w, type: t.type, syl: t.syl, kind: "nf" }); continue; }
    const [s, e] = t.seg;
    const [lo, hi] = mapR(s, e);
    if (hi < 0) { items.push({ w: t.w, type: t.type, syl: t.syl, kind: "nf" }); continue; }
    const u = runIn(softU, lo - 6, hi + 6, 6);
    const raw = u.len / (t.rLen * R), ratio = raw / biasOf(bias, t.type);
    items.push({ w: t.w, type: t.type, syl: t.syl, ref: [s, e], usr: u.seg || [lo, hi], refS: sec(t.rLen * R * biasOf(bias, t.type)), usrS: sec(u.len), raw, ratio, kind: judge(ratio, t.type) });
  }
  // voyelles tenues alors qu'al-Husary ne les tient pas
  const segU = segmentsOf(softU, G.a0, G.a1, 10);
  for (const [s, e] of segU) {
    const len = e - s + 1;
    if (len < 50 || s < G.a0 + 30) continue;
    if (items.some(x => x.usr && Math.max(x.usr[0], s - 10) <= Math.min(x.usr[1], e + 10))) continue;
    const [lo, hi] = mapU(s, e); if (hi < 0) continue;
    const r = runIn(ref.soft, lo - 6, hi + 6, 6);
    const ratio = len / Math.max(1, r.len * R) / biasOf(bias, "tabii");
    if (ratio > 2.2) items.push({ w: wordAt(ref, (lo + hi) / 2).w, type: "extra", ref: r.seg || [lo, hi], usr: [s, e], refS: sec(r.len * R), usrS: sec(len), ratio, kind: "long" });
  }
  // passages très différents (mot oublié ou changé ?)
  const dl = path.map(p => p[2]);
  const med = percentile(dl, 0.5), mad = percentile(dl.map(v => Math.abs(v - med)), 0.5) + 1e-6;
  const W = 15, sm = dl.map((_, k) => { let s = 0, c = 0; for (let q = k - W; q <= k + W; q++) if (q >= 0 && q < dl.length) { s += dl[q]; c++; } return s / c; });
  let st = -1;
  for (let k = 0; k <= sm.length; k++) {
    const bad = k < sm.length && sm[k] > med + 5 * mad;
    if (bad && st < 0) st = k;
    if (!bad && st >= 0) {
      const p0 = path[st], p1 = path[k - 1];
      const inside = p0[0] > F.a0 + 40 && p1[0] < F.a1 - 40;
      if (inside && (p1[0] - p0[0] >= 50 || p1[1] - p0[1] >= 50)) items.push({ w: wordAt(ref, (p0[0] + p1[0]) / 2).w, type: "diff", ref: [p0[0], p1[0]], usr: [p0[1], p1[1]], kind: "diff" });
      st = -1;
    }
  }
  items.sort((x, y) => (x.ref ? x.ref[0] : 1e9) - (y.ref ? y.ref[0] : 1e9));
  return { items, tempo: R };
}

// ===== Suivi en direct d'un verset =====
function LiveTracker(ref, onEvent, profile, bias) {
  const F = ref.F, a0 = F.a0, a1 = F.a1, n = a1 - a0 + 1;
  let prev = new Float32Array(n).fill(Infinity), cur = new Float32Array(n).fill(Infinity);
  let buf = new Float32Array(0), off = 0, total = 0;
  const fr = [], kAt = new Int32Array(n).fill(-1), chunks = [];
  let started = -1, pos = 0, j = 0, peak = -200, floor = null, lastAct = -1, voiced = 0;
  const mu = new Float32Array(D), m2 = new Float32Array(D); let nAct = 0;
  const done = new Set();
  const calibrated = !!(profile && profile.mu);
  if (calibrated) {
    nAct = 300;
    for (let d = 0; d < D; d++) { mu[d] = profile.mu[d]; m2[d] = profile.sd[d] * profile.sd[d] * nAct; }
    floor = profile.floor; peak = profile.peak - 6;
  }

  // alignement en ligne : la référence avance de 0, 1 ou 2 trames par trame de l'élève
  function step(c) {
    nAct++;
    for (let d = 0; d < D; d++) { const dl = c[d] - mu[d]; mu[d] += dl / nAct; m2[d] += dl * (c[d] - mu[d]); }
    const u = new Float32Array(D);
    for (let d = 0; d < D; d++) { const sd = nAct > 20 ? Math.sqrt(m2[d] / nAct) + 1e-6 : 1; u[d] = (c[d] - mu[d]) / sd; }
    const lo = Math.max(0, pos - 60), hi = Math.min(n - 1, pos + 40);
    cur.fill(Infinity);
    for (let i = lo; i <= hi; i++) {
      const d = cdist(F.cep[a0 + i], u);
      let best;
      if (j === 0) best = i <= 30 ? 0.05 * i : Infinity;
      else {
        best = prev[i] + 0.3;
        if (i > 0 && prev[i - 1] < best) best = prev[i - 1];
        if (i > 1 && prev[i - 2] + 0.3 < best) best = prev[i - 2] + 0.3;
      }
      cur[i] = best + d;
    }
    let bi = pos, bv = Infinity;
    for (let i = lo; i <= hi; i++) if (cur[i] < bv) { bv = cur[i]; bi = i; }
    if (bi > pos) { const np = Math.min(bi, pos + 2); for (let i = pos + 1; i <= np; i++) kAt[i] = fr.length - 1; pos = np; }
    const t = prev; prev = cur; cur = t;
    j++;
  }

  function tail(fromSample) {
    const len = total - fromSample, x = new Float32Array(Math.max(0, len));
    let o = 0, base = 0;
    for (const c of chunks) {
      const s = Math.max(0, fromSample - base), e = c.length;
      if (s < e) { x.set(c.subarray(s, e), o); o += e - s; }
      base += c.length;
    }
    return x;
  }

  // vérifie chaque madd déjà passé, sur une fenêtre autour de lui
  function checkMadds(final) {
    for (let idx = 0; idx < ref.targets.length; idx++) {
      const t = ref.targets[idx];
      if (!t.seg || !t.rLen || done.has(idx)) continue;
      if (!final && a0 + pos < t.seg[1] + 60) continue;
      done.add(idx);
      const [s, e] = t.seg;
      const rs = Math.max(a0, s - 100), re = Math.min(a1, e + 30);
      const kr = kAt[rs - a0] >= 0 ? kAt[rs - a0] : started;
      const ks = Math.max(0, kr - 100);
      const G = features(tail(0));
      if (G.n - ks < 30 || re - rs < 20) continue;
      const path = dtwSub(F.cep.slice(rs, re + 1), G.cep.slice(ks)).map(([i, jj, d]) => [rs + i, ks + jj, d]);
      const r2u = new Map();
      for (const [i, jj] of path) { if (!r2u.has(i)) r2u.set(i, [jj, jj]); else r2u.get(i)[1] = jj; }
      const R = pathTempo(path, rs, re);
      G.a0 = path[0][1]; G.a1 = path[path.length - 1][1];
      const softU = maskBelow(G, G.a0, G.a1, 0.75);
      let lo = Infinity, hi = -1;
      for (let i = s; i <= e; i++) { const v = r2u.get(i); if (v) { lo = Math.min(lo, v[0]); hi = Math.max(hi, v[1]); } }
      if (hi < 0) continue;
      const rw = runIn(maskBelow(F, rs, re, 0.75), s - 6, e + 6, 6).len || t.rLen;
      const u = runIn(softU, lo - 6, hi + 6, 6).len, ratio = u / (rw * R) / biasOf(bias, t.type);
      onEvent({ type: "madd", idx, target: t, ratio, kind: judge(ratio, t.type), refS: sec(rw * R), usrS: sec(u) });
    }
  }

  function onFrame(f) {
    peak = Math.max(peak, f.e);
    if (fr.length < 25 && !calibrated) floor = floor === null ? f.e : Math.min(floor, f.e);
    const thr = calibrated ? actThr(floor, peak) : Math.max((floor === null ? -100 : floor) + 12, peak - 38);
    f.act = f.e > thr && fr.length >= 5;
    const k = fr.length;
    fr.push({ act: f.act });
    if (f.act) { lastAct = k; voiced++; if (started < 0) started = k; }
    if (started >= 0 && f.act) step(f.c);
    if (started < 0) return;
    if (k % 2 === 0) {
      const wp = wordAt(ref, a0 + pos);
      onEvent({ type: "pos", frame: a0 + pos, frac: pos / Math.max(1, n - 1), w: wp.w, wf: wp.f });
    }
    checkMadds(false);
  }

  return {
    push(chunk) {
      chunks.push(chunk); total += chunk.length;
      const nb = new Float32Array(buf.length - off + chunk.length);
      nb.set(buf.subarray(off)); nb.set(chunk, buf.length - off);
      buf = nb; off = 0;
      while (off + WIN <= buf.length) { onFrame(frameAt(buf, off)); off += HOP; }
    },
    get frac() { return pos / Math.max(1, n - 1); },
    get started() { return started >= 0; },
    get voicedFrames() { return voiced; },
    get silentFrames() { return started < 0 ? 0 : fr.length - 1 - lastAct; }
  };
}

// ===== Profil de voix (étalonnage) =====
function voiceStats(x) {
  const n = Math.max(1, Math.floor((x.length - WIN) / HOP) + 1);
  const En = new Float32Array(n), C = [];
  for (let t = 0; t < n; t++) { const f = frameAt(x, t * HOP); En[t] = f.e; C.push(f.c); }
  const floor = percentile(En, 0.05), peak = percentile(En, 0.98), thr = actThr(floor, peak);
  const mu = new Array(D).fill(0), sd = new Array(D).fill(0); let cnt = 0;
  for (let t = 0; t < n; t++) if (En[t] > thr) { cnt++; for (let d = 0; d < D; d++) mu[d] += C[t][d]; }
  for (let d = 0; d < D; d++) mu[d] /= Math.max(1, cnt);
  for (let t = 0; t < n; t++) if (En[t] > thr) for (let d = 0; d < D; d++) sd[d] += (C[t][d] - mu[d]) ** 2;
  for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d] / Math.max(1, cnt)) + 1e-6;
  return { mu, sd, floor, peak, voiced: cnt };
}

// Quel verset l'élève commence-t-il ? Compare le début de sa voix au début de chaque verset candidat.
function locate(refs, x) {
  const G = features(x);
  const s = G.a0, e = Math.min(G.a1, G.a0 + 150);
  if (e - s < 60) return { best: -1, costs: [] };
  const A = G.cep.slice(s, e + 1);
  const costs = refs.map(r => {
    if (!r) return Infinity;
    const F = r.F, B = F.cep.slice(F.a0, Math.min(F.a1 + 1, F.a0 + Math.round((e - s) * 2.2) + 40));
    if (B.length < 20) return Infinity;
    const p = dtwSub(A, B);
    return p.reduce((q, v) => q + v[2], 0) / p.length;
  });
  let best = -1, bv = Infinity;
  costs.forEach((c, k) => { if (c < bv) { bv = c; best = k; } });
  return { best, costs };
}

(typeof self !== "undefined" ? self : window).MiroirEngine = { SR, HOP, features, detectMadds, prepareRef, analyzeFull, LiveTracker, wordAt, voiceStats, locate, groupOf, percentile };
})();
