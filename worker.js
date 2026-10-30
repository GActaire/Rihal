// Rihal — tout le calcul en arrière-plan : l'écran reste fluide.
importScripts("engine.js?v=7");
const E = self.MiroirEngine, SR = E.SR;
const refs = new Map(); // "récitateur|verset" -> référence préparée
let S = null;           // séance d'enregistrement en cours
let SC = null;          // écoute avant de savoir où l'élève récite (le passage est cherché par la reconnaissance vocale)

function resampler(rate) {
  const step = rate / SR; let t = 0, last = 0;
  return input => {
    const out = new Float32Array(Math.max(0, Math.ceil((input.length - 1 - t) / step) + 1));
    let n = 0;
    while (t + 1 < input.length) {
      const i = Math.floor(t), fr = t - i;
      const a = i < 0 ? last : input[i], b = input[i + 1];
      out[n++] = a + (b - a) * fr;
      t += step;
    }
    t -= input.length; last = input[input.length - 1];
    return out.subarray(0, n);
  };
}
const concat = arr => { const n = arr.reduce((s, a) => s + a.length, 0), x = new Float32Array(n); let o = 0; for (const a of arr) { x.set(a, o); o += a.length; } return x; };
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const tailOf = (arr, n) => { const x = concat(arr); return x.subarray(Math.max(0, x.length - n)); };

// détection de voix légère (énergie par trame de 10 ms), pour savoir quand on a assez de voix à reconnaître
function vadNew(floor) { return { floor: floor != null ? floor : null, hist: [], peak: -200, carry: new Float32Array(0), voiced: 0, first: -1, frames: 0 }; }
function vadFeed(V, r, g0) {
  const x = V.carry.length ? concat([V.carry, r]) : r;
  let o = 0, add = 0;
  for (; o + 400 <= x.length; o += 160) {
    let s = 0; for (let k = 0; k < 400; k++) s += x[o + k] * x[o + k];
    const e = 10 * Math.log10(s / 400 + 1e-10);
    V.frames++; V.hist.push(e); if (V.hist.length > 600) V.hist.shift();
    if (V.frames % 25 === 0 || V.frames < 25) {
      const p10 = E.percentile(V.hist, 0.1);
      V.fl = V.floor != null ? Math.min(V.floor + 6, Math.max(V.floor, p10)) : p10;
      V.pk = E.percentile(V.hist, 0.98);
    }
    const thr = V.pk - V.fl > 18 ? Math.max(V.fl + 10, V.pk - 35) : V.fl + 12;
    if (e > thr && V.frames > 5) { add++; V.voiced++; if (V.first < 0) V.first = g0 - V.carry.length + o; }
  }
  V.carry = x.slice(o);
  return add;
}
// morceau [from, to[ (indices globaux à 16 kHz) d'une liste de blocs qui commence à l'indice start
function sliceChunks(c16, cn, start, from, to, rate) {
  const o16 = [], on = []; let g = start;
  for (let k = 0; k < c16.length; k++) {
    const a = c16[k], b = g + a.length;
    if (b > from && g < to) {
      const s = Math.max(0, from - g), e = Math.min(a.length, to - g);
      o16.push(a.subarray(s, e));
      if (cn) { const n = cn[k], f = n.length / Math.max(1, a.length); on.push(n.subarray(Math.round(s * f), Math.round(e * f))); }
    }
    g = b;
  }
  return { a16: concat(o16), an: cn ? concat(on) : null };
}
let lvlAt = 0;
function level(native) {
  const now = Date.now(); if (now - lvlAt < 90) return; lvlAt = now;
  let s = 0; for (let k = 0; k < native.length; k++) s += native[k] * native[k];
  postMessage({ t: "lvl", db: 10 * Math.log10(s / Math.max(1, native.length) + 1e-10) });
}

self.onmessage = e => {
  const m = e.data;
  switch (m.t) {
    case "prep":
      try {
        const ref = E.prepareRef(m.x16, E.detectMadds(m.words), m.segs, m.words.length, m.words);
        refs.set(m.key, ref);
        if (refs.size > 40) refs.delete(refs.keys().next().value);
        postMessage({ t: "prepped", key: m.key, lt: ref.lt });
        if (S && !S.tracker && !S.silence && S.keys[S.i] === m.key) startTracker(true);
      } catch (err) { postMessage({ t: "prepFail", key: m.key }); }
      break;
    case "scan":
      S = null;
      SC = { rate: m.rate, rs: resampler(m.rate), c16: [], cn: [], start: 0, g: 0, vad: vadNew(m.floor), next: 230 };
      if (m.port) m.port.onmessage = ev => audio(ev.data);
      break;
    case "start": {
      const sc = m.fromScan && SC ? SC : null;
      SC = null;
      S = {
        keys: m.keys, extra: m.extra || [], i: m.i, from: 0, rate: m.rate, rs: sc ? sc.rs : resampler(m.rate),
        profile: m.calib ? null : m.profile, bias: m.calib ? null : m.bias, calib: !!m.calib,
        u16: [], native: [], tracker: null, samplesIn: 0, nearEnd: 0, located: !m.locate,
        lastPos: 0, voicedAt: 0, relockAt: 0,
        silence: m.calib ? { buf: [], need: 3 * SR, got: 0 } : null, silStats: null,
        all16: m.calib ? [] : null, ratios: { tabii: [], long: [], arid: [] }, reach: [], verses: 0,
        asr: !!m.asr && !m.calib, ring: { c: [], start: 0 }, hist: [], wc: m.wc || null, vad: vadNew(m.profile ? m.profile.floor : null), snipAt: 320
      };
      if (m.port) m.port.onmessage = ev => audio(ev.data);
      if (S.silence) { postMessage({ t: "calibSilence", left: 3 }); break; }
      if (sc) {
        // on reprend tout ce qu'il a déjà récité pendant qu'on cherchait le passage, sans rien perdre
        const at = Math.max(sc.start, Math.min(sc.g, Math.round(m.fromScan.at)));
        const ref = refs.get(S.keys[S.i]);
        const w = m.fromScan.w || 0;
        S.from = ref && w > 0 && ref.wt[w] ? Math.max(0, ref.wt[w][0] - 5) : 0;
        S.samplesIn = at; S.ring.start = at; S.vad = sc.vad; S.vad.voiced = 0;
        startTracker(true);
        const k0 = sc.c16.length;
        let g = sc.start;
        for (let k = 0; k < k0; k++) {
          const a = sc.c16[k], b = g + a.length;
          if (b > at) { const s = Math.max(0, at - g), f = sc.cn[k].length / Math.max(1, a.length); feed(a.subarray(s), sc.cn[k].subarray(Math.round(s * f)), true); if (!S) break; }
          g = b;
        }
        if (S) postMessage({ t: "caught", i: S.i });
      } else startTracker();
      break;
    }
    case "asrPos": asrPos(m); break;
    case "audio": audio(m.data); break;
    case "goto": gotoVerse(m.i, m.w); break;
    case "restart": if (S) gotoVerse(S.i, 0); break;
    case "stop": stop(); break;
  }
};

function startTracker(keepAudio) {
  const ref = refs.get(S.keys[S.i]);
  if (S.tracker && S.tracker.levels) S.levels = S.tracker.levels;
  S.tracker = null; S.nearEnd = 0; S.lastPos = 0; S.voicedAt = 0; S.relockAt = 0;
  if (!keepAudio) S.from = 0;
  postMessage({ t: "verse", i: S.i, ready: !!ref });
  if (!ref) return;
  const i = S.i;
  S.tracker = E.LiveTracker(ref, ev => onEv(i, ev), S.profile, S.bias, S.levels);
  if (S.from > 0) S.tracker.jumpTo(S.from);
  for (const c of S.u16) S.tracker.push(c);
}

function onEv(i, ev) {
  if (!S || S.i !== i) return;
  if (ev.type === "pos") {
    postMessage({ t: "pos", i, w: ev.w, f: ev.wf, l: ev.l, lf: ev.lf, frac: ev.frac });
    S.hist.push([S.samplesIn, i, ev.w]); if (S.hist.length > 600) S.hist.splice(0, 100);
  }
  else if (ev.type === "madd") postMessage({ t: "madd", i, kind: ev.kind, ratio: ev.ratio, w: ev.target.w, type: ev.target.type, syl: ev.target.syl });
}

// l'élève choisit lui-même où reprendre (mot touché, ou « recommencer le verset »)
function gotoVerse(i, w) {
  if (!S || i < 0 || i >= S.keys.length) return;
  S.i = i; S.u16 = []; S.native = []; S.located = true;
  const ref = refs.get(S.keys[i]);
  S.from = (ref && w > 0 && ref.wt[w]) ? Math.max(0, ref.wt[w][0] - 5) : 0;
  startTracker(true);
  postMessage({ t: "goto", i, w: w || 0 });
}

function audio(native) {
  if (!native || !native.length) return;
  level(native);
  if (!S && SC) return scanAudio(native);
  if (!S) return;
  feed(S.rs(native), native);
}

function scanAudio(native) {
  const r = SC.rs(native);
  const g0 = SC.g;
  SC.c16.push(r); SC.cn.push(native); SC.g += r.length;
  while (SC.c16.length > 1 && SC.g - SC.start - SC.c16[0].length > 25 * SR) { SC.start += SC.c16[0].length; SC.c16.shift(); SC.cn.shift(); }
  vadFeed(SC.vad, r, g0);
  if (SC.vad.voiced >= SC.next && SC.vad.first >= 0) {
    SC.next += 170;
    const from = Math.max(SC.start, SC.vad.first - Math.round(0.25 * SR), SC.g - 14 * SR);
    const { a16 } = sliceChunks(SC.c16, null, SC.start, from, SC.g);
    const x = new Float32Array(a16);
    postMessage({ t: "snippet", scan: true, x, from, end: SC.g, voiced: SC.vad.voiced }, [x.buffer]);
  }
}

// un bloc de voix (déjà à 16 kHz) entre dans la séance ; replay = audio déjà enregistré qu'on rattrape
function feed(r, native, replay) {
  const g0 = S.samplesIn;
  if (S.silence) { // étape 1 de l'étalonnage : mesurer le bruit ambiant
    S.silence.buf.push(r); S.silence.got += r.length;
    const left = Math.ceil((S.silence.need - S.silence.got) / SR);
    if (left !== S.silence.left) { S.silence.left = left; if (left > 0) postMessage({ t: "calibSilence", left }); }
    if (S.silence.got >= S.silence.need) {
      const st = E.voiceStats(concat(S.silence.buf));
      const en = []; const x = concat(S.silence.buf);
      for (let o = 0; o + 400 <= x.length; o += 160) { let s = 0; for (let k = 0; k < 400; k++) s += x[o + k] * x[o + k]; en.push(10 * Math.log10(s / 400 + 1e-10)); }
      S.silStats = { floor: E.percentile(en, 0.5), loud: E.percentile(en, 0.95) };
      S.silence = null;
      postMessage({ t: "calibGo", noise: S.silStats });
      startTracker();
    }
    return;
  }
  S.native.push(native);
  S.u16.push(r); S.samplesIn += r.length;
  if (S.all16) S.all16.push(r);
  S.ring.c.push(r);
  { let tot = 0; for (const c of S.ring.c) tot += c.length; while (S.ring.c.length > 1 && tot - S.ring.c[0].length > 16 * SR) { tot -= S.ring.c[0].length; S.ring.start += S.ring.c[0].length; S.ring.c.shift(); } }
  // de temps en temps, on envoie les dernières secondes à la reconnaissance vocale pour vérifier le suivi
  if (S.asr && !replay) {
    vadFeed(S.vad, r, g0);
    if (S.vad.voiced >= S.snipAt) {
      S.snipAt = S.vad.voiced + 240;
      const from = Math.max(S.ring.start, S.samplesIn - 8 * SR);
      const { a16 } = sliceChunks(S.ring.c, null, S.ring.start, from, S.samplesIn);
      const x = new Float32Array(a16);
      postMessage({ t: "snippet", x, from, end: S.samplesIn, i: S.i }, [x.buffer]);
    }
  }
  const t = S.tracker;
  if (!t) return;
  t.push(r);
  if (S.tracker !== t) return;
  // 1) au début : vérifier qu'on suit bien le bon verset
  if (!S.located && t.voicedFrames >= 150) { S.located = true; locate(); if (S.tracker !== t) return; }
  // 2) la voix n'avance plus depuis ~2 s : se recaler automatiquement
  const pf = t.posFrame;
  if (pf > S.lastPos + 3) { S.lastPos = pf; S.voicedAt = t.voicedFrames; }
  else if (t.voicedFrames - S.voicedAt > 130 && t.voicedFrames - S.relockAt > 110 && t.frac < 0.95) {
    S.relockAt = t.voicedFrames;
    autoRelock();
    if (S.tracker !== t) return;
  }
  // 3) fin du verset : une pause après la fin, ou l'élève enchaîne déjà le suivant
  const fr = t.frac, sil = t.silentFrames;
  if (fr >= 0.97 && !S.nearEnd) S.nearEnd = S.samplesIn;
  const flowed = S.nearEnd && S.samplesIn - S.nearEnd > SR * 0.9;
  const paused = (fr >= 0.9 && sil >= 35) || (fr >= 0.8 && sil >= 55) || (fr >= 0.985 && sil >= 15);
  if (paused) { S.pend = null; endVerse(true); return; }
  if (flowed) { if (confirmEnd()) { S.pend = null; endVerse(true); } else S.nearEnd = 0; return; }
  // pause plus tôt dans le verset : arrêt (waqf) ou fin de verset mal suivie ? On décide quand la voix reprend.
  const len = bufLen();
  if (!S.pend && fr >= 0.55 && sil >= 45 && S.i + 1 < S.keys.length) S.pend = { cut: Math.max(0, len - sil * 160 + Math.round(0.15 * SR)), resume: 0 };
  if (S.pend) {
    if (sil > 3) return;
    if (!S.pend.resume) S.pend.resume = Math.max(S.pend.cut, len - Math.round(0.1 * SR));
    if (len - S.pend.resume < 1.3 * SR) return;
    const x = concat(S.u16).subarray(S.pend.resume);
    const cur = refs.get(S.keys[S.i]), nxt = refs.get(S.keys[S.i + 1]);
    const r1 = cur && E.relock(cur, x), r2 = nxt && E.relock(nxt, x);
    const nlen = nxt ? nxt.F.a1 - nxt.F.a0 : 1;
    const cut = S.pend.cut; S.pend = null;
    if (r2 && (!r1 || r2.cost < r1.cost * 0.95) && r2.start < nxt.F.a0 + 0.35 * nlen) { endVerse(true, cut); postMessage({ t: "relock", i: S.i, next: true }); }
    else if (r1 && r1.end > t.posFrame + 15) { t.jumpTo(r1.end); S.lastPos = r1.end; }
  }
}
const bufLen = () => S.u16.reduce((s, a) => s + a.length, 0);

// ===== Corrections venues de la reconnaissance vocale =====
// m = { i: verset, w: dernier mot entendu, end: échantillon (global) où ce mot se termine }
function asrPos(m) {
  if (!S || S.silence || !S.tracker) return;
  const ref = refs.get(S.keys[m.i]);
  if (!ref || !ref.wt[m.w]) return;
  let h = null;
  for (let k = S.hist.length - 1; k >= 0; k--) if (S.hist[k][0] <= m.end) { h = S.hist[k]; break; }
  // écart en mots (d'un verset à l'autre) entre le suivi et la reconnaissance, au même instant
  const gpos = (i, w) => { if (!S.wc) return null; let k = 0; for (let x = 0; x < i; x++) k += S.wc[x] || 0; return k + w; };
  if (h) {
    const a = gpos(h[1], h[2]), b = gpos(m.i, m.w);
    if (a != null && b != null) { if (a - b >= -1 && a - b <= 2) return; }
    else if (h[1] === m.i && Math.abs(h[2] - m.w) <= 1) return;
  }
  if (m.i < S.i && h && h[1] === m.i) return; // résultat arrivé trop tard : le suivi est déjà plus loin
  if (m.i === S.i) {
    reanchor(m.w, m.end);
  } else if (m.i === S.i + 1) {
    // il est déjà dans le verset suivant : on clôt celui-ci à l'endroit estimé où le suivant a commencé
    const dur = (ref.wt[m.w][1] - ref.wt[0][0]) * 160 * 1.15;
    const vb = S.samplesIn - bufLen();
    const cut = Math.round(m.end - dur - vb);
    if (cut < SR * 0.8) return;
    endVerse(true, cut);
    postMessage({ t: "relock", i: S ? S.i : m.i, next: true, asr: true });
    if (S && S.i === m.i && S.tracker) reanchor(m.w, m.end, true);
  } else {
    // ailleurs dans la sourate (retour en arrière, verset sauté) : on repart de là
    jumpVerse(m.i, m.w, m.end);
  }
}
// relance le suivi du verset en cours : à l'échantillon endG, l'élève finissait le mot w
function reanchor(w, endG, quiet) {
  const ref = refs.get(S.keys[S.i]); if (!ref) return;
  const vb = S.samplesIn - bufLen();
  const off = Math.max(0, Math.round(endG - vb - 0.3 * SR));
  const lv = S.tracker && S.tracker.levels; if (lv) S.levels = lv;
  const i = S.i;
  S.tracker = E.LiveTracker(ref, ev => onEv(i, ev), S.profile, S.bias, S.levels);
  S.tracker.jumpTo(Math.max(ref.wt[w][0], ref.wt[w][1] - 30));
  S.tracker.push(concat(S.u16).subarray(off));
  S.lastPos = S.tracker.posFrame; S.voicedAt = S.tracker.voicedFrames; S.relockAt = S.tracker.voicedFrames; S.nearEnd = 0; S.pend = null;
  if (!quiet) postMessage({ t: "relock", i: S.i, asr: true });
}
function jumpVerse(i, w, endG) {
  if (i < 0 || i >= S.keys.length) return;
  const ref = refs.get(S.keys[i]); if (!ref) return;
  const from = Math.max(S.ring.start, Math.round(endG - 0.3 * SR));
  const { a16 } = sliceChunks(S.ring.c, null, S.ring.start, from, S.samplesIn);
  S.i = i; S.u16 = [new Float32Array(a16)]; S.native = []; S.located = true;
  S.from = Math.max(0, Math.max(ref.wt[w][0], ref.wt[w][1] - 30) - 5);
  startTracker(true);
  postMessage({ t: "goto", i, w, asr: true });
}

function locate() {
  const cands = [S.i, S.i + 1, S.i + 2, S.i + 3];
  if (S.i > 0 && !S.reach.length) cands.unshift(S.i - 1); // revenir en arrière : seulement au tout début
  const list = cands.filter(k => k >= 0 && k < S.keys.length);
  const res = E.locate(list.map(k => refs.get(S.keys[k]) || null), concat(S.u16));
  if (res.best < 0) return;
  const best = list[res.best], curCost = res.costs[list.indexOf(S.i)];
  if (best !== S.i && res.costs[res.best] < curCost * 0.85) {
    S.i = best; S.from = 0;
    postMessage({ t: "jump", i: best });
    startTracker(true);
    S.located = true;
  }
}

function autoRelock() {
  const x = tailOf(S.u16, Math.round(2.5 * SR));
  const cands = [S.i, S.i + 1].filter(k => k < S.keys.length);
  let best = null;
  for (const k of cands) {
    const ref = refs.get(S.keys[k]); if (!ref) continue;
    const r = E.relock(ref, x);
    if (r && (!best || r.cost < best.cost * (k === S.i ? 1 : 0.9))) best = { ...r, k };
  }
  if (!best) return;
  const t = S.tracker;
  if (best.k !== S.i) {
    // il est déjà au verset suivant : on clôt celui-ci et on reprend la suite là où il en est
    endVerse(false);
    S.i = best.k; S.u16 = [x]; S.native = []; S.from = best.start;
    startTracker(true);
    if (S.tracker) S.tracker.jumpTo(best.end);
    postMessage({ t: "relock", i: S.i, next: true });
  } else if (restarted(refs.get(S.keys[S.i]), best)) {
    // il a recommencé le verset depuis le début : on repart de là
    S.u16 = [x]; S.native = []; S.from = best.start;
    startTracker(true);
    if (S.tracker) S.tracker.jumpTo(best.end);
    postMessage({ t: "relock", i: S.i, back: true });
  } else if (best.end > t.posFrame + 15) {
    t.jumpTo(best.end); S.lastPos = best.end; S.voicedAt = t.voicedFrames;
    postMessage({ t: "relock", i: S.i });
  }
}

// A-t-il clairement recommencé le verset depuis le début ?
function restarted(ref, r) {
  const F = ref.F, len = F.a1 - F.a0;
  return r.start < F.a0 + 0.25 * len && S.lastPos > F.a0 + 0.6 * len;
}

// L'élève enchaîne sans pause : vérifier qu'il est bien passé au verset suivant,
// et pas revenu en arrière dans celui-ci (le suivi aurait pris de l'avance).
function confirmEnd() {
  const x = tailOf(S.u16, Math.round(1.6 * SR));
  const cur = refs.get(S.keys[S.i]), nxt = refs.get(S.keys[S.i + 1]);
  const r1 = cur && E.relock(cur, x), r2 = nxt && E.relock(nxt, x);
  if (r2 && (!r1 || r2.cost < r1.cost)) return true;
  if (!r1) return false;
  // il est encore dans ce verset : on attend, en le recalant là où il en est vraiment
  if (restarted(cur, r1)) { S.u16 = [x]; S.native = []; S.from = r1.start; startTracker(true); if (S.tracker) S.tracker.jumpTo(r1.end); postMessage({ t: "relock", i: S.i, back: true }); }
  else if (S.tracker && r1.end < S.tracker.posFrame - 10) { S.tracker.jumpTo(r1.end); S.lastPos = r1.end; }
  return false;
}

// cut : échantillon (16 kHz) où s'arrête ce verset ; la suite appartient au verset suivant
// Ce qu'il vient de réciter est-il bien ce verset, ou a-t-il sauté plus loin ? (compare le début de sa voix aux débuts des versets suivants)
function whichVerse(u16, i) {
  const cands = [i, i + 1, i + 2, i + 3].filter(k => k < S.keys.length && refs.get(S.keys[k]));
  if (cands.length < 2 || u16.length < SR * 1.2) return i;
  const x = u16.subarray(0, Math.min(u16.length, Math.round(3 * SR)));
  let ci = Infinity, best = i, bc = Infinity;
  for (const k of cands) {
    const ref = refs.get(S.keys[k]), r = E.relock(ref, x);
    if (!r) continue;
    const L = ref.F.a1 - ref.F.a0;
    if (k === i) ci = r.cost;
    else if (r.start < ref.F.a0 + 0.2 * L && r.cost < bc) { bc = r.cost; best = k; }
  }
  return bc < 0.8 * ci ? best : i;
}

function endVerse(advance, cut) {
  let i = S.i, ref = refs.get(S.keys[i]);
  const all16 = concat(S.u16), allNat = concat(S.native);
  let u16 = all16, native = allNat, carry16 = null, carryNat = null;
  if (cut != null && cut > 0 && cut < all16.length) {
    const cn = Math.min(allNat.length, Math.round(cut * S.rate / SR));
    u16 = all16.subarray(0, cut); carry16 = all16.slice(cut);
    native = allNat.slice(0, cn); carryNat = allNat.slice(cn);
  }
  if (S.tracker) S.reach.push(S.tracker.frac);
  if (!S.from && !S.calib && advance) {
    const k = whichVerse(u16, i);
    if (k !== i) { postMessage({ t: "skipped", from: i, to: k }); S.i = i = k; ref = refs.get(S.keys[k]); }
  }
  postMessage({ t: "verseEnd", i, native, rate: S.rate }, [native.buffer]);
  if (ref && u16.length > SR * 0.5) {
    try {
      let x = u16;
      if (!S.from) { const cut = E.lastStart(ref, u16); if (cut > 0) { x = u16.subarray(cut); postMessage({ t: "trimmed", i, s: cut / SR }); } }
      let res = E.analyzeFull(ref, x, S.bias, S.from);
      if (!res.empty) {
        const raws = res.items.filter(x => x.raw > 0.15 && x.raw < 4);
        const others = S.from ? [] : (S.extra[i] || []).map(k => refs.get(k)).filter(Boolean).map(r => E.analyzeFull(r, x, S.bias, 0)).filter(r => !r.empty);
        res = E.combine(res, others);
        const flagged = new Set(res.items.filter(x => x.kind === "court" || x.kind === "long").map(x => x.w));
        res.items = res.items.filter(x => !(x.kind === "diff" && flagged.has(x.w)));
        postMessage({ t: "result", i, res });
        S.verses++;
        if (S.calib) for (const it of raws) S.ratios[E.groupOf(it.type)].push(it.raw);
      }
    } catch (err) {}
  }
  S.u16 = carry16 ? [carry16] : []; S.native = carryNat ? [carryNat] : []; S.from = 0; S.pend = null;
  if (!advance) return;
  S.i++;
  if (!S.calib) S.located = false; // au début de chaque verset : vérifier qu'il n'en a pas sauté
  if (S.i >= S.keys.length) finish();
  else startTracker();
}

function finish() {
  if (!S) return;
  if (S.calib) {
    const x = concat(S.all16);
    const st = E.voiceStats(x);
    const clamp = v => v == null ? 1 : Math.min(1.45, Math.max(0.7, v));
    const pick = a => a.length >= 2 ? clamp(median(a)) : 1;
    const bias = { tabii: pick(S.ratios.tabii), long: pick(S.ratios.long), arid: pick(S.ratios.arid) };
    const floor = S.silStats ? S.silStats.floor : st.floor;
    const ok = st.voiced > 300 && S.verses >= 3;
    postMessage({
      t: "calib", ok,
      profile: ok ? { mu: st.mu, sd: st.sd, floor: Math.min(floor, st.floor), peak: st.peak, date: Date.now() } : null,
      bias, counts: { tabii: S.ratios.tabii.length, long: S.ratios.long.length, arid: S.ratios.arid.length },
      verses: S.verses, total: S.keys.length,
      snr: st.peak - floor, followed: S.reach.filter(f => f >= 0.85).length, reached: S.reach.length
    });
  }
  postMessage({ t: "finished" });
  S = null;
}

function stop() {
  SC = null;
  if (!S) { postMessage({ t: "finished" }); return; }
  if (!S.silence && S.tracker && S.tracker.started && S.u16.reduce((s, a) => s + a.length, 0) > SR * 0.8) endVerse(false);
  finish();
}
