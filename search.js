// Rihal — retrouve un passage dans tout le Coran à partir de quelques mots, même mal reconnus.
(function (root) {
  const COUNTS = [7,286,200,176,120,165,206,75,129,109,123,111,43,52,99,128,111,110,98,135,112,78,118,64,77,227,93,88,69,60,34,30,73,54,45,83,182,88,75,85,54,53,89,59,37,35,38,29,18,45,60,49,62,55,78,96,29,22,24,13,14,11,11,18,12,12,30,52,52,44,28,28,20,56,40,31,50,40,46,42,29,19,36,25,22,17,19,26,30,20,15,21,11,8,8,19,5,8,8,11,11,8,3,9,5,4,7,3,6,3,5,4,5,6];

  // même écriture pour le texte du Coran et pour ce que la reconnaissance vocale entend
  function norm(s) {
    return String(s || "")
      .replace(/[ً-ٰٟۖ-ۭـࣰ-ࣿ]/g, "")
      .replace(/[أإآٱٲٳ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/ء/g, "")
      .replace(/[^ء-ي\s]/g, " ")
      .split(/\s+/).filter(Boolean);
  }

  // distance d'édition bornée (au-delà de max, on arrête)
  function lev(a, b, max) {
    const n = a.length, m = b.length;
    if (Math.abs(n - m) > max) return max + 1;
    let prev = new Array(m + 1), cur = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      cur[0] = i; let best = cur[0];
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const c = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      const t = prev; prev = cur; cur = t;
    }
    return prev[m];
  }
  function sim(a, b) {
    if (a === b) return 1;
    const L = Math.max(a.length, b.length);
    const max = Math.max(1, Math.floor(L * 0.4));
    const d = lev(a, b, max);
    return d > max ? 0 : 1 - d / L;
  }

  function build(text) {
    const lines = text.split("\n").filter(l => l.length);
    const words = [], wv = [], vstart = new Int32Array(lines.length + 1), vref = [];
    let s = 0, v = 0;
    lines.forEach((l, i) => {
      vstart[i] = words.length;
      while (v >= COUNTS[s]) { s++; v = 0; }
      vref.push([s + 1, v + 1]); v++;
      for (const w of l.split(" ")) { words.push(w); wv.push(i); }
    });
    vstart[lines.length] = words.length;
    const vocab = new Map(), forms = [], post = [];
    words.forEach((w, p) => {
      let id = vocab.get(w);
      if (id == null) { id = forms.length; vocab.set(w, id); forms.push(w); post.push([]); }
      post[id].push(p);
    });
    const N = words.length;
    const idf = post.map(p => Math.log(1 + N / p.length));
    const wid = Int32Array.from(words, w => vocab.get(w));
    return { words, wid, wv: Int32Array.from(wv), vstart, vref, vocab, forms, post: post.map(p => Int32Array.from(p)), idf, N, cache: new Map() };
  }

  // formes du Coran qui ressemblent au mot entendu
  function candidates(ix, t) {
    if (ix.cache.has(t)) return ix.cache.get(t);
    const out = [];
    const exact = ix.vocab.get(t);
    if (exact != null) out.push([exact, 1]);
    if (t.length >= 3) {
      for (let id = 0; id < ix.forms.length; id++) {
        if (id === exact) continue;
        const f = ix.forms[id];
        if (Math.abs(f.length - t.length) > Math.max(1, Math.floor(t.length * 0.4))) continue;
        const s = sim(t, f);
        if (s >= 0.66) out.push([id, s]);
      }
    }
    out.sort((a, b) => b[1] * ix.idf[b[0]] - a[1] * ix.idf[a[0]]);
    const res = out.slice(0, 30);
    if (ix.cache.size > 5000) ix.cache.clear();
    ix.cache.set(t, res);
    return res;
  }

  // alignement local mots entendus <-> texte du Coran autour d'une position
  function align(ix, T, sims, lo, hi) {
    const n = T.length, m = hi - lo;
    const H = new Float32Array((n + 1) * (m + 1));
    const back = new Uint8Array((n + 1) * (m + 1));
    let best = 0, bi = 0, bj = 0;
    const GAP = 0.55;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const p = lo + j - 1;
        const sv = sims[i - 1].get(ix.wid[p]) || 0;
        const w = Math.min(ix.idf[ix.wid[p]], 6) / 6;
        const diag = H[(i - 1) * (m + 1) + j - 1] + (sv > 0 ? sv * (0.45 + 0.55 * w) * 1.6 : -0.45);
        const up = H[(i - 1) * (m + 1) + j] - GAP, left = H[i * (m + 1) + j - 1] - GAP;
        let h = 0, b = 0;
        if (diag > h) { h = diag; b = 1; }
        if (up > h) { h = up; b = 2; }
        if (left > h) { h = left; b = 3; }
        H[i * (m + 1) + j] = h; back[i * (m + 1) + j] = b;
        if (h > best) { best = h; bi = i; bj = j; }
      }
    }
    let i = bi, j = bj, matched = 0, si = bi, sj = bj;
    const pairs = [];
    while (i > 0 && j > 0) {
      const b = back[i * (m + 1) + j];
      if (b === 0) break;
      si = i; sj = j;
      if (b === 1) { if ((sims[i - 1].get(ix.wid[lo + j - 1]) || 0) > 0) { matched++; pairs.push([i - 1, lo + j - 1]); } i--; j--; }
      else if (b === 2) i--; else j--;
    }
    return { score: best, end: lo + bj - 1, start: lo + sj - 1, tEnd: bi - 1, tStart: si - 1, matched, pairs: pairs.reverse() };
  }

  // opts.range = [premier mot, dernier mot] (indices globaux) ; opts.near = indice global privilégié
  function search(ix, text, opts) {
    opts = opts || {};
    const T = Array.isArray(text) ? text : norm(text);
    if (T.length < 2) return null;
    const lo = opts.range ? opts.range[0] : 0, hi = opts.range ? opts.range[1] : ix.N - 1;
    const sims = T.map(t => new Map(candidates(ix, t)));
    const off = T.length + 2;
    const votes = new Float32Array(ix.N + off + 2);
    T.forEach((t, j) => {
      for (const [id, s] of sims[j]) {
        const w = s * s * ix.idf[id];
        const P = ix.post[id];
        for (let k = 0; k < P.length; k++) { const p = P[k]; if (p < lo || p > hi) continue; votes[p - j + off] += w; }
      }
    });
    // diagonales les plus soutenues (tolère les mots en plus ou en moins)
    const sm = new Float32Array(votes.length);
    for (let d = 1; d < votes.length - 1; d++) sm[d] = votes[d] + 0.7 * (votes[d - 1] + votes[d + 1]);
    const top = [];
    for (let d = 1; d < sm.length - 1; d++) {
      const v = sm[d];
      if (v <= 0 || v < sm[d - 1] || v < sm[d + 1]) continue;
      if (top.length < 40) { top.push([d, v]); if (top.length === 40) top.sort((a, b) => b[1] - a[1]); }
      else if (v > top[39][1]) { top[39] = [d, v]; top.sort((a, b) => b[1] - a[1]); }
    }
    const res = [];
    for (const [d] of top) {
      const st = d - off;
      const a = Math.max(lo, st - 4), b = Math.min(hi + 1, st + T.length + 6);
      if (b - a < 2) continue;
      const r = align(ix, T, sims, a, b);
      if (r.matched < 2) continue;
      let sc = r.score;
      if (opts.near != null) { const dist = Math.abs(r.end - opts.near); sc += 1.2 * Math.exp(-dist / 60); }
      r.final = sc;
      if (!res.some(x => Math.abs(x.end - r.end) <= 2)) res.push(r);
    }
    if (!res.length) return null;
    res.sort((a, b) => b.final - a.final);
    const best = res[0], second = res[1];
    const loc = p => { const vi = ix.wv[p]; const [s, v] = ix.vref[vi]; return { vi, s, v, w: p - ix.vstart[vi] }; };
    const cover = best.matched / T.length;
    const margin = second ? best.final - second.final : best.final;
    const strong = best.matched >= 3 && cover >= 0.4 && best.score >= 2.2;
    const out = {
      ...loc(best.end), start: loc(best.start), matched: best.matched, heard: T.length, score: best.score, margin,
      // « sûr » : assez de mots reconnus, et aucun autre passage du Coran presque aussi bon
      sure: strong && margin >= 0.9,
      end: best.end, startFlat: best.start, tEnd: best.tEnd,
      alts: res.slice(0, 4).map(r => ({ ...loc(r.end), score: r.final, matched: r.matched }))
    };
    return out;
  }

  // retrouve, dans les mots affichés (texte uthmani de quran.com), le mot qui correspond au mot k du texte simple
  function mapWord(simpleWords, shownWords, k) {
    const A = simpleWords.map(w => norm(w).join("")), B = shownWords.map(w => norm(w).join(""));
    const n = A.length, m = B.length;
    if (!n || !m) return Math.min(k, m - 1);
    const D = [];
    for (let i = 0; i <= n; i++) { D.push(new Float32Array(m + 1)); D[i][0] = i; }
    for (let j = 0; j <= m; j++) D[0][j] = j;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const s = sim(A[i - 1], B[j - 1]);
      D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (1 - s) * 1.5);
    }
    let i = n, j = m, map = new Array(n).fill(-1);
    while (i > 0 && j > 0) {
      const s = sim(A[i - 1], B[j - 1]);
      if (Math.abs(D[i][j] - (D[i - 1][j - 1] + (1 - s) * 1.5)) < 1e-4) { map[i - 1] = j - 1; i--; j--; }
      else if (Math.abs(D[i][j] - (D[i - 1][j] + 1)) < 1e-4) { map[i - 1] = j - 1; i--; }
      else j--;
    }
    if (k === "all") return map.map((r, i) => r >= 0 ? r : Math.round(i * (m - 1) / Math.max(1, n - 1)));
    const r = map[Math.max(0, Math.min(n - 1, k))];
    return r >= 0 ? r : Math.round(k * (m - 1) / Math.max(1, n - 1));
  }

  root.RihalSearch = { norm, sim, build, search, mapWord, COUNTS };
})(typeof self !== "undefined" ? self : globalThis);
