// Rihal — tout le calcul en arrière-plan : l'écran reste fluide.
importScripts("engine.js?v=6");
const E = self.MiroirEngine, SR = E.SR;
const refs = new Map(); // "récitateur|verset" -> référence préparée
let S = null;           // séance d'enregistrement en cours

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

self.onmessage = e => {
  const m = e.data;
  switch (m.t) {
    case "prep":
      try {
        const ref = E.prepareRef(m.x16, E.detectMadds(m.words), m.segs, m.words.length);
        refs.set(m.key, ref);
        if (refs.size > 40) refs.delete(refs.keys().next().value);
        postMessage({ t: "prepped", key: m.key });
        if (S && !S.tracker && !S.silence && S.keys[S.i] === m.key) startTracker();
      } catch (err) { postMessage({ t: "prepFail", key: m.key }); }
      break;
    case "start":
      S = {
        keys: m.keys, extra: m.extra || [], i: m.i, from: 0, rate: m.rate, rs: resampler(m.rate),
        profile: m.calib ? null : m.profile, bias: m.calib ? null : m.bias, calib: !!m.calib,
        u16: [], native: [], tracker: null, samplesIn: 0, nearEnd: 0, located: !m.locate,
        lastPos: 0, voicedAt: 0, relockAt: 0,
        silence: m.calib ? { buf: [], need: 3 * SR, got: 0 } : null, silStats: null,
        all16: m.calib ? [] : null, ratios: { tabii: [], long: [], arid: [] }, reach: [], verses: 0
      };
      if (m.port) m.port.onmessage = ev => audio(ev.data);
      if (S.silence) postMessage({ t: "calibSilence", left: 3 });
      else startTracker();
      break;
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
  if (ev.type === "pos") postMessage({ t: "pos", i, w: ev.w, f: ev.wf, frac: ev.frac });
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
  if (!S || !native || !native.length) return;
  const r = S.rs(native);
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

function locate() {
  const cands = [S.i, S.i + 1, S.i + 2];
  if (S.i > 0) cands.unshift(S.i - 1);
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
function endVerse(advance, cut) {
  const i = S.i, ref = refs.get(S.keys[i]);
  const all16 = concat(S.u16), allNat = concat(S.native);
  let u16 = all16, native = allNat, carry16 = null, carryNat = null;
  if (cut != null && cut > 0 && cut < all16.length) {
    const cn = Math.min(allNat.length, Math.round(cut * S.rate / SR));
    u16 = all16.subarray(0, cut); carry16 = all16.slice(cut);
    native = allNat.slice(0, cn); carryNat = allNat.slice(cn);
  }
  if (S.tracker) S.reach.push(S.tracker.frac);
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
  if (!S) { postMessage({ t: "finished" }); return; }
  if (!S.silence && S.tracker && S.tracker.started && S.u16.reduce((s, a) => s + a.length, 0) > SR * 0.8) endVerse(false);
  finish();
}
