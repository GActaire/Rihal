// Rihal — tout le calcul en arrière-plan : l'écran reste fluide.
importScripts("engine.js?v=4");
const E = self.MiroirEngine, SR = E.SR;
const refs = new Map(); // clé du verset -> référence préparée
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

self.onmessage = e => {
  const m = e.data;
  if (m.t === "prep") {
    try {
      const ref = E.prepareRef(m.x16, E.detectMadds(m.words), m.segs, m.words.length);
      refs.set(m.key, ref);
      if (refs.size > 12) refs.delete(refs.keys().next().value);
      postMessage({ t: "prepped", key: m.key, targets: ref.targets.filter(t => t.seg).length });
      if (S && !S.tracker && S.keys[S.i] === m.key) startTracker();
    } catch (err) { postMessage({ t: "prepFail", key: m.key }); }
  } else if (m.t === "start") {
    S = {
      keys: m.keys, i: m.i, first: true, rate: m.rate, rs: resampler(m.rate),
      profile: m.calib ? null : m.profile, bias: m.calib ? null : m.bias, calib: !!m.calib,
      u16: [], native: [], tracker: null, samplesIn: 0, nearEnd: 0, located: false,
      all16: m.calib ? [] : null, ratios: { tabii: [], long: [], arid: [] }, verses: 0
    };
    if (m.port) m.port.onmessage = ev => audio(ev.data);
    startTracker();
  } else if (m.t === "audio") audio(m.data);
  else if (m.t === "stop") stop();
};

function startTracker() {
  const ref = refs.get(S.keys[S.i]);
  S.tracker = null; S.located = false; S.nearEnd = 0;
  postMessage({ t: "verse", i: S.i, ready: !!ref });
  if (!ref) return;
  const i = S.i;
  S.tracker = E.LiveTracker(ref, ev => onEv(i, ev), S.profile, S.bias);
  for (const c of S.u16) S.tracker.push(c);
}

function onEv(i, ev) {
  if (!S || S.i !== i) return;
  if (ev.type === "pos") postMessage({ t: "pos", i, w: ev.w, f: ev.wf, frac: ev.frac });
  else if (ev.type === "madd") postMessage({ t: "madd", i, kind: ev.kind, ratio: ev.ratio, w: ev.target.w, type: ev.target.type, syl: ev.target.syl });
}

function audio(native) {
  if (!S || !native || !native.length) return;
  S.native.push(native);
  const r = S.rs(native);
  S.u16.push(r); S.samplesIn += r.length;
  if (S.all16) S.all16.push(r);
  const t = S.tracker;
  if (!t) return;
  t.push(r);
  // recalage : après ~1,5 s de voix, vérifier qu'on suit bien le bon verset
  if (!S.located && t.voicedFrames >= 150) { S.located = true; locate(); if (S.tracker !== t) return; }
  // fin du verset : une pause après la fin, ou l'élève enchaîne déjà le suivant
  const fr = t.frac, sil = t.silentFrames;
  if (fr >= 0.97 && !S.nearEnd) S.nearEnd = S.samplesIn;
  const flowed = S.nearEnd && S.samplesIn - S.nearEnd > SR * 0.9;
  if ((fr >= 0.9 && sil >= 35) || (fr >= 0.8 && sil >= 55) || (fr >= 0.985 && sil >= 15) || flowed) endVerse(true);
}

function locate() {
  const cands = [S.i, S.i + 1, S.i + 2];
  if (S.first && S.i > 0) cands.unshift(S.i - 1);
  const list = cands.filter(k => k >= 0 && k < S.keys.length);
  const res = E.locate(list.map(k => refs.get(S.keys[k]) || null), concat(S.u16));
  if (res.best < 0) return;
  const best = list[res.best], curCost = res.costs[list.indexOf(S.i)];
  S.first = false;
  if (best !== S.i && res.costs[res.best] < curCost * 0.85) {
    S.i = best;
    postMessage({ t: "jump", i: best });
    startTracker();
    S.located = true;
  }
}

function endVerse(advance) {
  const i = S.i, ref = refs.get(S.keys[i]);
  const u16 = concat(S.u16), native = concat(S.native);
  postMessage({ t: "verseEnd", i, native, rate: S.rate }, [native.buffer]);
  if (ref && u16.length > SR * 0.5) {
    try {
      const res = E.analyzeFull(ref, u16, S.bias);
      if (!res.empty) {
        const flagged = new Set(res.items.filter(x => x.kind === "court" || x.kind === "long").map(x => x.w));
        res.items = res.items.filter(x => !(x.kind === "diff" && flagged.has(x.w)));
        postMessage({ t: "result", i, res });
        S.verses++;
        if (S.calib) for (const it of res.items) if (it.raw > 0.15 && it.raw < 4) S.ratios[E.groupOf(it.type)].push(it.raw);
      }
    } catch (err) {}
  }
  S.u16 = []; S.native = [];
  if (!advance) return;
  S.i++; S.first = false;
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
    const ok = st.voiced > 300 && S.verses >= 2;
    postMessage({ t: "calib", ok, profile: ok ? { mu: st.mu, sd: st.sd, floor: st.floor, peak: st.peak, date: Date.now() } : null, bias, counts: { tabii: S.ratios.tabii.length, long: S.ratios.long.length, arid: S.ratios.arid.length }, verses: S.verses });
  }
  postMessage({ t: "finished" });
  S = null;
}

function stop() {
  if (!S) { postMessage({ t: "finished" }); return; }
  if (S.tracker && S.tracker.started && S.u16.reduce((s, a) => s + a.length, 0) > SR * 0.8) endVerse(false);
  finish();
}
