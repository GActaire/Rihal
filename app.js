// Rihal — interface (le calcul se fait dans worker.js)
(function () {
if (window.__miroirApp) return;
window.__miroirApp = true;
const SR = 16000, HOP = 160;
const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const pad3 = n => String(n).padStart(3, "0");
const fmtS = t => (Math.round(t * 10) / 10).toFixed(1).replace(".", ",") + " s";
const fsec = f => (f * HOP + 200) / SR;
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} } };

const RULES = {
  tabii: "Madd naturel · 2 temps",
  arid: "Madd ʿāriḍ, fin de verset · 2, 4 ou 6 temps",
  lazim: "Madd lāzim · 6 temps",
  muttasil: "Madd muttaṣil · 4 à 5 temps",
  munfasil: "Madd munfaṣil · 4 à 5 temps",
  gen: "Voyelle longue",
  extra: "Voyelle qui doit rester courte",
  diff: ""
};
const COUNTS = [7,286,200,176,120,165,206,75,129,109,123,111,43,52,99,128,111,110,98,135,112,78,118,64,77,227,93,88,69,60,34,30,73,54,45,83,182,88,75,85,54,53,89,59,37,35,38,29,18,45,60,49,62,55,78,96,29,22,24,13,14,11,11,18,12,12,30,52,52,44,28,28,20,56,40,31,50,40,46,42,29,19,36,25,22,17,19,26,30,20,15,21,11,8,8,19,5,8,8,11,11,8,3,9,5,4,7,3,6,3,5,4,5,6];
const API = "https://api.quran.com/api/v4";
// Récitateurs de référence, reconnus pour la rigueur de leur tajwid (minutage mot à mot fourni par quran.com)
const RECITERS = [
  { id: 6, name: "Mahmoud Khalil al-Husary", short: "al-Husary", folder: "Husary_64kbps" },
  { id: 12, name: "al-Husary, version enseignement (lente)", short: "al-Husary lent", folder: "Husary_Muallim_128kbps" },
  { id: 9, name: "Muhammad Siddiq al-Minshawi (murattal)", short: "al-Minshawi", folder: "Minshawy_Murattal_128kbps" },
  { id: 2, name: "Abdul Basit Abdus Samad (murattal)", short: "Abdul Basit", folder: "Abdul_Basit_Murattal_64kbps" }
];
const recInfo = id => RECITERS.find(r => r.id === id) || RECITERS[0];
const settings = () => ({ rec: 6, multi: true, ...store.get("settings", {}) });
const saveSettings = p => store.set("settings", { ...settings(), ...p });

let chapters = [], S = null, cur = 0, ctx = null, playing = null, calibMode = false;
let wordEls = [], veEls = [], results = [], usrBufs = [];
let rec = null, listen = null;
const worker = new Worker("worker.js?v=5");

/* ---------- petite base locale (IndexedDB) ---------- */
let dbp = null;
function idb() {
  if (dbp) return dbp;
  dbp = new Promise(res => {
    try { const r = indexedDB.open("husary", 1); r.onupgradeneeded = () => r.result.createObjectStore("ayat"); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }
    catch (e) { res(null); }
  });
  return dbp;
}
async function dbOp(mode, fn) {
  const db = await idb(); if (!db) return null;
  return new Promise(res => {
    try { const tx = db.transaction("ayat", mode), rq = fn(tx.objectStore("ayat")); tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => res(null); }
    catch (e) { res(null); }
  });
}
const dbGet = k => dbOp("readonly", st => st.get(k));
const dbPut = (k, v) => dbOp("readwrite", st => st.put(v, k));

/* ---------- texte du Coran et minutage (quran.com), gardés sur l'appareil ---------- */
async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r.json(); }
async function loadChapters() {
  const hit = await dbGet("chapters"); if (hit) return hit;
  let list = null;
  try {
    const d = await getJSON(`${API}/chapters?language=fr`);
    list = d.chapters.map(c => ({ id: c.id, n: c.name_simple, a: c.name_arabic, fr: c.translated_name.name, c: c.verses_count }));
  } catch (e) {
    try {
      const d = await getJSON("https://api.alquran.cloud/v1/surah");
      list = d.data.map(c => ({ id: c.number, n: c.englishName, a: c.name.replace(/^سُورَةُ\s*/, ""), fr: c.englishNameTranslation, c: c.numberOfAyahs }));
    } catch (e2) { return null; }
  }
  dbPut("chapters", list);
  return list;
}
async function loadText(id) {
  const hit = await dbGet("t5:" + id); if (hit) return hit;
  let data = null;
  try {
    const verses = []; let page = 1;
    for (;;) {
      const d = await getJSON(`${API}/verses/by_chapter/${id}?words=true&word_fields=text_uthmani,line_number,page_number&fields=page_number&per_page=50&page=${page}`);
      verses.push(...d.verses);
      if (!d.pagination || !d.pagination.next_page) break;
      page = d.pagination.next_page;
    }
    data = { id, v: verses.map(x => {
      const words = x.words.filter(w => w.char_type_name === "word"), end = x.words.find(w => w.char_type_name === "end");
      return { k: pad3(id) + pad3(x.verse_number), n: x.verse_number, p: x.page_number, w: words.map(w => [w.text_uthmani, w.page_number, w.line_number]), e: end ? [end.text_uthmani, end.page_number, end.line_number] : null };
    }) };
  } catch (e) {
    // secours : texte seul (sans les lignes du mushaf)
    try {
      const d = await getJSON(`https://api.alquran.cloud/v1/surah/${id}/quran-uthmani`);
      const basm = /^بِسْمِ\s+ٱللَّهِ\s+ٱلرَّحْمَٰنِ\s+ٱلرَّحِيمِ\s*/;
      data = { id, v: d.data.ayahs.map((a, k) => {
        const txt = (k === 0 && id !== 1) ? a.text.replace(basm, "") : a.text;
        return { k: pad3(id) + pad3(a.numberInSurah), n: a.numberInSurah, p: a.page, w: txt.split(/\s+/).filter(Boolean).map(t => [t, a.page, null]), e: [String(a.numberInSurah), a.page, null] };
      }) };
    } catch (e2) { return null; }
  }
  if (data && data.v.length) dbPut("t5:" + id, data);
  return data;
}
// minutage mot à mot + adresse de l'audio, pour un récitateur
async function loadRec(id, rec) {
  const hit = await dbGet(`r5:${rec}:${id}`); if (hit) return hit;
  const out = {}; let sp = 1;
  try {
    for (;;) {
      const d = await getJSON(`${API}/recitations/${rec}/by_chapter/${id}?fields=segments&per_page=50&page=${sp}`);
      for (const a of d.audio_files) {
        let u = a.url || "";
        if (u.startsWith("//")) u = "https:" + u; else if (u && !/^https?:/.test(u)) u = "https://verses.quran.com/" + u;
        out[a.verse_key] = { s: (a.segments || []).map(x => [x[0], x[1], x[2], x[3]]), u };
      }
      if (!d.pagination || !d.pagination.next_page) break;
      sp = d.pagination.next_page;
    }
  } catch (e) { if (!Object.keys(out).length) return null; }
  dbPut(`r5:${rec}:${id}`, out);
  return out;
}
async function ensureRec(rec) {
  if (!S) return;
  S.recs = S.recs || {};
  if (S.recs[rec]) return S.recs[rec];
  S.recs[rec] = (async () => {
    for (const sid of S.sur) {
      const d = await loadRec(sid, rec);
      for (const V of S.v) if (+V.k.slice(0, 3) === sid) {
        V.r = V.r || {};
        const x = d && d[`${sid}:${V.n}`];
        V.r[rec] = { s: x ? x.s : [], u: x ? x.u : "" };
      }
    }
  })();
  return S.recs[rec];
}

/* ---------- audio d'al-Husary (64 kb/s : même minutage que quran.com) ---------- */
async function getAudio(rec, k, url) {
  const id = `a:${rec}:${k}`;
  const hit = await dbGet(id);
  if (hit) return hit;
  const folder = recInfo(rec).folder;
  const urls = [url, `https://everyayah.com/data/${folder}/${k}.mp3`, `https://mirrors.quranicaudio.com/everyayah/${folder}/${k}.mp3`].filter(Boolean);
  for (const u of urls) {
    try { const r = await fetch(u, { mode: "cors" }); if (r.ok) { const b = await r.blob(); if (b.size > 1500) { dbPut(id, b); return b; } } } catch (e) {}
  }
  return null;
}
function audioCtx() { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); return ctx; }
async function decode(blob) {
  const c = audioCtx();
  const arr = await blob.arrayBuffer();
  const buf = await new Promise((res, rej) => { const p = c.decodeAudioData(arr, res, rej); if (p && p.catch) p.catch(rej); });
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * SR)), SR);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const r = await off.startRendering();
  return { buf, x16: r.getChannelData(0) };
}

// minutage des mots (en trames de 10 ms), pour la lumière pendant l'écoute
function wordTimes(V, rec) {
  const wt = [], n = V.w.length, segs = (V.r && V.r[rec] && V.r[rec].s) || [];
  for (const [w0, w1, m0, m1] of segs) { const k = Math.max(1, w1 - w0); for (let w = w0; w < w1; w++) wt[w] = [m0 / 10 + (m1 - m0) / 10 * (w - w0) / k, m0 / 10 + (m1 - m0) / 10 * (w - w0 + 1) / k]; }
  for (let w = 0; w < n; w++) if (!wt[w]) { const p = wt[w - 1] || [0, 0]; wt[w] = [p[1], p[1] + 30]; }
  return wt;
}
function wordAtT(wt, f, total) {
  if (!wt.length) return { w: -1, f: 0 };
  if (!(wt[wt.length - 1][1] > 0) && total) { const w = Math.min(wt.length - 1, Math.floor(f / total * wt.length)); return { w, f: (f / total * wt.length) % 1 }; }
  if (f < wt[0][0]) return { w: 0, f: 0 };
  for (let w = 0; w < wt.length; w++) {
    const [s, e] = wt[w];
    if (f <= e) return { w, f: Math.max(0, Math.min(1, (f - s) / Math.max(1, e - s))) };
    if (w + 1 < wt.length && f < wt[w + 1][0]) return { w, f: 1 };
  }
  return { w: wt.length - 1, f: 1 };
}

/* préparation des versets : audio décodé ici, référence calculée dans le worker */
const prep = new Map(), bufs = new Map();
const keyOf = (vi, rec) => `${rec || settings().rec}|${S.v[vi].k}`;
function prepVerse(vi, rec) {
  rec = rec || settings().rec;
  if (!S || vi < 0 || vi >= S.v.length) return Promise.resolve(null);
  const key = keyOf(vi, rec);
  if (prep.has(key)) return prep.get(key);
  const V = S.v[vi];
  const p = (async () => {
    await ensureRec(rec);
    const R = (V.r && V.r[rec]) || { s: [], u: "" };
    const blob = await getAudio(rec, V.k, R.u); if (!blob) return null;
    const { buf, x16 } = await decode(blob);
    bufs.set(key, buf);
    const copy = new Float32Array(x16);
    worker.postMessage({ t: "prep", key, x16: copy, words: V.w.map(x => x[0]), segs: R.s }, [copy.buffer]);
    return { buf, wt: wordTimes(V, rec) };
  })().catch(() => null);
  prep.set(key, p);
  p.then(v => { if (!v) prep.delete(key); });
  return p;
}
// verset courant + suivants, pour le récitateur principal (et les autres si bilan croisé)
function prepAround(vi) {
  const st = settings();
  for (let k = 0; k <= 2; k++) prepVerse(vi + k, st.rec);
  if (st.multi) RECITERS.filter(r => r.id !== st.rec && r.id !== 12).forEach(r => { prepVerse(vi, r.id); prepVerse(vi + 1, r.id); });
}

/* ---------- accueil ---------- */
function tile(c) {
  const b = el("button", "tile");
  if (store.get("done", {})[c.id]) b.classList.add("done");
  b.appendChild(el("span", "star", String(c.id)));
  const nm = el("span", "tile-name");
  nm.appendChild(el("b", null, c.n));
  nm.appendChild(el("span", null, `${c.fr} · ${c.c} versets`));
  b.appendChild(nm);
  b.appendChild(el("span", "ar-name", c.a || ""));
  b.onclick = () => { location.hash = "s" + c.id; };
  return b;
}
function renderHome() {
  const q = $("q").value.trim().toLowerCase();
  const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ'ʿʾ-]/g, "");
  const nq = norm(q);
  const grid = $("grid"); grid.textContent = "";
  chapters.filter(c => !q || String(c.id) === q || norm(c.n).includes(nq) || norm(c.fr).includes(nq) || (c.a || "").includes(q)).forEach(c => grid.appendChild(tile(c)));
  if (!grid.children.length) grid.appendChild(el("p", "empty", "Aucune sourate ne correspond."));
  const last = store.get("last", null), r = $("resume");
  if (last && chapters[last.s - 1]) {
    const c = chapters[last.s - 1];
    r.hidden = false; r.textContent = "";
    const t = el("span"); t.appendChild(el("span", null, "Reprendre ")); t.appendChild(el("b", null, `${c.n}, verset ${last.v + 1}`));
    r.appendChild(t); r.appendChild(el("span", "ar-name", c.a || ""));
    r.onclick = () => { location.hash = "s" + c.id; };
  } else r.hidden = true;
  const st = settings(), sel = $("recSel");
  if (!sel.options.length) RECITERS.forEach(r => { const o = el("option", null, r.name); o.value = r.id; sel.appendChild(o); });
  sel.value = st.rec; $("multi").checked = !!st.multi;
  const v = store.get("voice", null), cs = $("calibState");
  cs.textContent = v ? `Voix étalonnée le ${new Date(v.profile.date).toLocaleDateString("fr-FR")}` : "Pas encore étalonnée";
  $("calibBtn").textContent = v ? "Refaire" : "Étalonner";
  $("calibCard").classList.toggle("done", !!v);
}

/* ---------- lecture d'une sourate ---------- */
async function openSurah(id, calib) {
  stopAll();
  calibMode = !!calib;
  const sur = calibMode ? [1, 108] : [id];
  const c = calibMode ? { id: 0, n: "Étalonnage de ta voix", a: "" } : (chapters[id - 1] || { id, n: "Sourate " + id, a: "", c: COUNTS[id - 1] });
  $("home").hidden = true; $("surah").hidden = false; $("dock").hidden = false;
  $("sName").textContent = calibMode ? c.n : `${c.id}. ${c.n}`; $("sAr").textContent = c.a || "";
  $("calibBanner").hidden = !calibMode;
  $("pages").textContent = ""; $("pages").appendChild(el("p", "empty", "Chargement du texte…"));
  S = null; prep.clear(); bufs.clear();
  const parts = [];
  for (const sid of sur) { const t = await loadText(sid); if (!t) { $("pages").textContent = ""; $("pages").appendChild(el("p", "empty", "Impossible de charger le texte. Vérifie ta connexion internet.")); return; } parts.push(t); }
  S = { id: calibMode ? 0 : id, sur, c, v: parts.flatMap(t => t.v.map(V => ({ ...V }))), recs: {} };
  results = new Array(S.v.length).fill(null); usrBufs = [];
  const last = store.get("last", null);
  cur = calibMode ? 0 : (last && last.s === id ? Math.min(last.v, S.v.length - 1) : 0);
  renderPages();
  updateRecChip();
  selectVerse(cur, !calibMode);
  setStatus(calibMode ? "Étape 1 sur 2 : touche le micro, puis reste silencieux 3 secondes." : "Touche un mot pour choisir le verset de départ, puis le micro.");
}
function updateRecChip() { $("recLbl").textContent = recInfo(settings().rec).short; }

function renderPages() {
  const box = $("pages"); box.textContent = "";
  wordEls = S.v.map(v => new Array(v.w.length)); veEls = new Array(S.v.length);
  const hasLines = S.v.every(V => V.w.every(w => w[2] != null));
  const pages = new Map();
  const put = (p, l, node) => { if (!pages.has(p)) pages.set(p, new Map()); const P = pages.get(p); if (!P.has(l)) P.set(l, []); P.get(l).push(node); };
  S.v.forEach((V, vi) => {
    V.w.forEach(([txt, p, l], wi) => {
      const w = el("span", "w"); w.dataset.v = vi; w.dataset.w = wi;
      w.appendChild(el("span", "t", txt));
      wordEls[vi][wi] = w; put(p, hasLines ? l : 0, w);
    });
    const ve = el("span", "ve", V.e ? V.e[0] : String(vi + 1)); ve.dataset.v = vi;
    veEls[vi] = ve;
    const last = V.w[V.w.length - 1];
    const [p, l] = V.e ? [V.e[1], V.e[2]] : [last[1], last[2]];
    put(p, hasLines ? l : 0, ve);
  });
  let first = true;
  for (const [p, lines] of [...pages.entries()].sort((a, b) => a[0] - b[0])) {
    const pg = el("section", "page");
    const firstK = [...lines.values()][0][0];
    const fv = firstK && firstK.dataset ? S.v[+firstK.dataset.v] : null;
    if (fv && fv.n === 1 && !["001", "009"].includes(fv.k.slice(0, 3)) && +firstK.dataset.w === 0) pg.appendChild(el("div", "basmala", "بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ"));
    first = false;
    const keys = [...lines.keys()].sort((a, b) => a - b);
    keys.forEach((l, i) => {
      const ln = el("div", "line" + (hasLines ? "" : " flow"));
      const nodes = lines.get(l);
      if (hasLines && (nodes.length < 5 || (i === keys.length - 1 && nodes.length < 8))) ln.classList.add("short");
      nodes.forEach((n, k) => { ln.appendChild(n); if (k < nodes.length - 1) ln.appendChild(document.createTextNode(" ")); });
      pg.appendChild(ln);
    });
    pg.appendChild(el("div", "page-no", `— page ${p} —`));
    box.appendChild(pg);
  }
  updateProg();
}

function selectVerse(vi, scroll) {
  if (!S) return;
  wordEls.forEach(ws => ws.forEach(w => w.classList.remove("cv")));
  cur = Math.max(0, Math.min(S.v.length - 1, vi));
  wordEls[cur].forEach(w => w.classList.add("cv"));
  if (!calibMode) store.set("last", { s: S.id, v: cur });
  if (scroll) wordEls[cur][0].scrollIntoView({ block: "center", behavior: "smooth" });
  updateProg();
  prepAround(cur);
}

function updateProg() {
  if (!S) return;
  const n = results.filter(Boolean).length;
  $("sProg").textContent = n ? `${n}/${S.v.length} récités` : `verset ${cur + 1}/${S.v.length}`;
}
function setStatus(t, kind) { const s = $("status"); s.textContent = t; s.className = "status-line" + (kind ? " k-" + kind : ""); }

/* ---------- lumière fluide : la cible vient du worker, l'affichage la rejoint à chaque image ---------- */
const lit = { tv: -1, tw: -1, tf: 0, dv: -1, dw: -1, df: 0, raf: 0 };
function setTarget(vi, wi, f) {
  if (vi === lit.tv && wi < lit.tw) return; // jamais en arrière dans un verset
  lit.tv = vi; lit.tw = wi; lit.tf = f;
  if (!lit.raf) lit.raf = requestAnimationFrame(frameLight);
}
function frameLight() {
  lit.raf = 0;
  if (lit.tv < 0) return;
  if (lit.dv !== lit.tv || lit.dw !== lit.tw) {
    if (lit.dv !== lit.tv) {
      if (lit.dv >= 0) (wordEls[lit.dv] || []).forEach(w => { w.classList.remove("on"); w.style.removeProperty("--f"); });
      lit.dv = lit.tv;
    }
    const ws = wordEls[lit.dv]; if (!ws) return;
    for (let k = 0; k < ws.length; k++) { ws[k].classList.toggle("done", k < lit.tw); ws[k].classList.toggle("on", k === lit.tw); }
    lit.dw = lit.tw; lit.df = 0;
    const w = ws[lit.dw], r = w.getBoundingClientRect();
    if (r.top < 70 || r.bottom > innerHeight - 200) w.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  lit.df += (lit.tf - lit.df) * 0.3;
  const w = wordEls[lit.dv] && wordEls[lit.dv][lit.dw];
  if (w) w.style.setProperty("--f", lit.df.toFixed(3));
  if (Math.abs(lit.tf - lit.df) > 0.004) lit.raf = requestAnimationFrame(frameLight);
}
function finishLight(vi) { (wordEls[vi] || []).forEach(w => { w.classList.remove("on"); w.classList.add("done"); w.style.removeProperty("--f"); }); if (lit.tv === vi) { lit.tv = -1; lit.dv = -1; } }
function clearLight(keepTarget) {
  wordEls.forEach(ws => ws.forEach(w => { w.classList.remove("on", "done"); w.style.removeProperty("--f"); }));
  lit.dv = -1; lit.dw = -1; lit.df = 0;
  if (!keepTarget) { lit.tv = -1; lit.tw = -1; }
}

/* ---------- écoute d'al-Husary avec la lumière ---------- */
async function playFrom(vi) {
  stopAll();
  const c = audioCtx(); if (c.resume) c.resume();
  listen = { stop: false };
  setListenUi(true);
  const L = listen;
  for (let v = vi; v < S.v.length && !L.stop; v++) {
    selectVerse(v, false);
    setStatus(`${recInfo(settings().rec).short} · verset ${S.v[v].n}`);
    const p = await prepVerse(v);
    if (L.stop) break;
    if (!p) { setStatus("Impossible de charger l'audio du récitateur. Vérifie ta connexion internet."); break; }
    const src = c.createBufferSource(); src.buffer = p.buf; src.connect(c.destination);
    const t0 = c.currentTime + 0.05; src.start(t0); playing = src;
    const total = p.buf.duration * 100;
    await new Promise(res => {
      src.onended = res;
      const tick = () => {
        if (L.stop) return res();
        const f = (c.currentTime - t0) * 100;
        if (f >= 0) { const wp = wordAtT(p.wt, f, total); if (wp.w >= 0) setTarget(v, wp.w, wp.f); }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    finishLight(v);
  }
  if (listen === L) { listen = null; setListenUi(false); clearLight(); setStatus("Touche le micro pour réciter."); }
}
function setListenUi(on) {
  $("listenIco").setAttribute("d", on ? "M7 5h4v14H7zm6 0h4v14h-4z" : "M8 5v14l11-7z");
  $("listenLbl").textContent = on ? "Pause" : "Écouter";
}
function stopListen() { if (listen) { listen.stop = true; listen = null; } if (playing) { try { playing.stop(); } catch (_) {} playing = null; } setListenUi(false); }

/* ---------- récitation : micro -> worker ---------- */
const CAPTURE = `class C extends AudioWorkletProcessor{constructor(){super();this.out=null;this.b=new Float32Array(1024);this.n=0;this.port.onmessage=e=>{if(e.data&&e.data.port)this.out=e.data.port};}
process(inp){const ch=inp[0]&&inp[0][0];if(ch){for(let i=0;i<ch.length;i++){this.b[this.n++]=ch[i];if(this.n===1024){const o=this.out||this.port;o.postMessage(this.b,[this.b.buffer]);this.b=new Float32Array(1024);this.n=0;}}}return true;}}
registerProcessor('miroir-capture',C);`;
let workletReady = null;

async function startRec() {
  stopListen();
  if (!S) return;
  const c = audioCtx(); if (c.resume) c.resume();
  const btn = $("mic");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStatus("Ce navigateur ne donne pas accès au micro."); return; }
  btn.classList.add("busy"); setStatus("Préparation…");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 } }); }
  catch (e) { btn.classList.remove("busy"); setStatus("Le micro est refusé. Autorise-le pour ce site dans les réglages du navigateur."); return; }
  const src = c.createMediaStreamSource(stream);
  const mute = c.createGain(); mute.gain.value = 0; mute.connect(c.destination);
  let node = null, port = null;
  try {
    if (c.audioWorklet && window.AudioWorkletNode) {
      workletReady = workletReady || c.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE], { type: "application/javascript" })));
      await workletReady;
      node = new AudioWorkletNode(c, "miroir-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      const ch = new MessageChannel();
      node.port.postMessage({ port: ch.port1 }, [ch.port1]);
      port = ch.port2;
    }
  } catch (e) { node = null; port = null; }
  if (!node) {
    node = c.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = ev => { if (!rec) return; const d = new Float32Array(ev.inputBuffer.getChannelData(0)); worker.postMessage({ t: "audio", data: d }, [d.buffer]); };
  }
  src.connect(node); node.connect(mute);
  btn.classList.remove("busy");
  rec = { stream, src, node, mute, vi: cur };
  clearLight();
  const voice = calibMode ? null : store.get("voice", null);
  const st = settings();
  prepAround(cur);
  const others = st.multi && !calibMode ? RECITERS.filter(r => r.id !== st.rec && r.id !== 12).map(r => r.id) : [];
  const msg = { t: "start", keys: S.v.map((_, i) => keyOf(i, st.rec)), extra: S.v.map((_, i) => others.map(r => keyOf(i, r))), i: cur, rate: c.sampleRate, profile: voice && voice.profile, bias: voice && voice.bias, calib: calibMode, locate: !calibMode };
  if (port) { msg.port = port; worker.postMessage(msg, [port]); } else worker.postMessage(msg);
  btn.classList.add("rec"); $("micIco").hidden = true; $("stopIco").hidden = false;
  $("restart").disabled = false;
}

function stopRec(fromWorker) {
  if (!rec) return;
  const r = rec; rec = null;
  try { r.src.disconnect(); r.node.disconnect(); r.mute.disconnect(); } catch (_) {}
  r.stream.getTracks().forEach(t => t.stop());
  if (!fromWorker) worker.postMessage({ t: "stop" });
  $("mic").classList.remove("rec"); $("micIco").hidden = false; $("stopIco").hidden = true;
  $("restart").disabled = true;
  veEls.forEach(v => v && v.classList.remove("st-run"));
  if (!calibMode) setStatus("Arrêté. Touche « Bilan » pour voir tes corrections.");
}
function stopAll() { stopListen(); if (rec) stopRec(); }

worker.onmessage = e => {
  const m = e.data;
  if (!S) return;
  switch (m.t) {
    case "verse": {
      if (!rec) return;
      rec.vi = m.i;
      selectVerse(m.i, true);
      veEls.forEach(v => v && v.classList.remove("st-run"));
      if (veEls[m.i]) veEls[m.i].classList.add("st-run");
      prepAround(m.i);
      if (!(calibMode && !rec.calibGo)) setStatus(m.ready ? `Verset ${S.v[m.i].n} : récite…` : "Préparation du verset…");
      break;
    }
    case "prepped":
      if (rec && keyOf(rec.vi) === m.key && !(calibMode && !rec.calibGo)) setStatus(`Verset ${S.v[rec.vi].n} : récite…`);
      break;
    case "calibSilence":
      setStatus(`Étape 1 sur 2 : reste silencieux… ${m.left}`);
      break;
    case "calibGo":
      if (rec) rec.calibGo = true;
      setStatus(m.noise && m.noise.floor > -42 ? "Étape 2 sur 2 : récite Al-Fatiha puis Al-Kawthar. (Il y a un peu de bruit autour de toi.)" : "Étape 2 sur 2 : récite Al-Fatiha puis Al-Kawthar, calmement.", "ok");
      break;
    case "goto":
      clearLight();
      setStatus(m.w ? `Reprise au mot touché, verset ${S.v[m.i].n}.` : `On reprend le verset ${S.v[m.i].n} depuis le début.`, "ok");
      break;
    case "relock":
      setStatus(m.next ? `Recalé : tu es au verset ${S.v[m.i].n}.` : m.back ? `Recalé : tu as repris plus haut dans le verset ${S.v[m.i].n}.` : "Recalé sur ta voix.", "ok");
      break;
    case "pos":
      if (rec && m.i === rec.vi && m.w >= 0) setTarget(m.i, m.w, m.f);
      break;
    case "madd": {
      if (!rec || m.i !== rec.vi) return;
      const strong = (m.kind === "court" && m.ratio < 0.45) || (m.kind === "long" && m.ratio > 2.2);
      if (!strong || calibMode) return;
      const it = { type: m.type, kind: m.kind };
      setStatus(`${m.kind === "court" ? "Trop court" : "Trop long"} : ${wordText(m.i, m.w)}. ${advice(it)}`, m.kind);
      break;
    }
    case "jump":
      setStatus(`Recalé : tu récites le verset ${S.v[m.i].n}.`, "ok");
      break;
    case "verseEnd": {
      if (veEls[m.i]) veEls[m.i].classList.remove("st-run");
      finishLight(m.i);
      if (m.native && m.native.length) {
        const c = audioCtx(), b = c.createBuffer(1, m.native.length, m.rate);
        b.getChannelData(0).set(m.native);
        usrBufs[m.i] = b;
      }
      break;
    }
    case "result": {
      const res = m.res;
      res.refBuf = bufs.get(keyOf(m.i)); res.usrBuf = usrBufs[m.i];
      res.recName = recInfo(settings().rec).short;
      results[m.i] = res;
      markVerse(m.i);
      updateProg();
      const bad = res.items.filter(isBad).length;
      if (rec && bad && !calibMode) setStatus(`Verset ${S.v[m.i].n} : ${bad} correction${bad > 1 ? "s" : ""}. Touche son numéro pour voir.`, "court");
      if (!calibMode && results.every(Boolean)) { const d = store.get("done", {}); d[S.id] = 1; store.set("done", d); }
      break;
    }
    case "calib": {
      if (m.ok) {
        store.set("voice", { profile: m.profile, bias: m.bias });
        showCalib(m);
      } else showCalib(m);
      break;
    }
    case "finished":
      if (rec) stopRec(true);
      if (!calibMode) setTimeout(() => { if (results.some(Boolean)) openReport(); }, 300);
      break;
  }
};

/* ---------- corrections ---------- */
const isBad = i => i.kind === "court" || i.kind === "long" || i.kind === "diff";
const wordText = (vi, w) => (S && S.v[vi] && S.v[vi].w[w]) ? S.v[vi].w[w][0] : "";
function markVerse(vi) {
  const res = results[vi]; if (!res) return;
  (wordEls[vi] || []).forEach(w => { w.classList.remove("k-court", "k-long", "k-diff"); const s = w.querySelector("sup"); if (s) s.remove(); });
  let n = 0;
  res.items.filter(isBad).forEach(it => {
    n++;
    const w = wordEls[vi][it.w]; if (!w) return;
    w.classList.add("k-" + it.kind);
    if (!w.querySelector("sup")) w.appendChild(el("sup", null, String(n)));
  });
  const ve = veEls[vi];
  ve.classList.remove("st-ok", "st-warn"); ve.classList.add(n ? "st-warn" : "st-ok");
}
function headline(it) {
  if (it.kind === "diff") return "Passage différent";
  if (it.type === "extra") return "Voyelle allongée en trop";
  return it.kind === "court" ? "Trop court" : it.kind === "long" ? "Trop long" : "Bien tenu";
}
function advice(it) {
  if (it.kind === "diff") return "Vérifie qu'aucun mot n'est sauté ou changé, puis réécoute al-Husary sur ce passage.";
  if (it.type === "extra") return "Cette voyelle doit rester courte : ne la tiens pas.";
  if (it.kind === "ok") return "Comme al-Husary.";
  const c = it.kind === "court";
  switch (it.type) {
    case "tabii": return c ? "Allonge cette voyelle : 2 temps, comme deux battements réguliers." : "Raccourcis : 2 temps suffisent.";
    case "lazim": return c ? "Tiens-la sur 6 temps : ce madd est obligatoire et le plus long." : "Raccourcis un peu : 6 temps, pas plus.";
    case "muttasil": case "munfasil": return c ? "Tiens-la plus longtemps : 4 à 5 temps, comme al-Husary." : "Raccourcis : 4 à 5 temps suffisent.";
    case "arid": return c ? "En fin de verset, tiens-la plus longtemps, comme al-Husary." : "En fin de verset, al-Husary la tient moins longtemps.";
    default: return c ? "Allonge cette voyelle, comme al-Husary." : "Raccourcis cette voyelle, comme al-Husary.";
  }
}
function play(buf, s, e) {
  if (!buf) return 0;
  const c = audioCtx(); if (playing) { try { playing.stop(); } catch (_) {} } if (c.resume) c.resume();
  const t0 = Math.max(0, s), t1 = Math.min(buf.duration, e);
  const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
  src.start(0, t0, Math.max(0.05, t1 - t0)); playing = src;
  return t1 - t0;
}
const playSeg = (buf, seg) => play(buf, fsec(seg[0]) - 0.35, fsec(seg[1]) + 0.35);

function card(vi, it, num, res) {
  const c = el("article", "card k-" + it.kind);
  const top = el("div", "card-top"), left = el("div", "card-id");
  left.appendChild(el("span", "num", String(num)));
  const tt = el("div"); tt.appendChild(el("div", "verdict", headline(it)));
  const rule = RULES[it.type] || RULES.gen;
  if (rule) { const r = el("div", "rule", rule); if (it.syl) { r.appendChild(document.createTextNode(" · ")); const b = el("bdi", null, it.syl); b.dir = "rtl"; r.appendChild(b); } tt.appendChild(r); }
  left.appendChild(tt); top.appendChild(left);
  top.appendChild(el("div", "word", wordText(vi, it.w)));
  c.appendChild(top);
  if (it.kind !== "diff" && it.refS != null) {
    const bars = el("div", "bars"), max = Math.max(it.refS, it.usrS || 0, 0.3);
    const row = (label, val, cls) => { const r = el("div", "bar-row"); r.appendChild(el("span", "bar-label", label)); const tr = el("div", "bar-track"), f = el("div", "bar-fill " + cls); f.style.width = Math.max(4, 100 * val / max) + "%"; tr.appendChild(f); r.appendChild(tr); r.appendChild(el("span", "bar-val", fmtS(val))); return r; };
    bars.appendChild(row(res.recName || "Repère", it.refS, "ref")); bars.appendChild(row("Toi", it.usrS || 0, "usr"));
    let note = `Repère : ${res.recName || "le récitateur"}, ajusté à ton rythme${store.get("voice", null) ? " et à ta voix étalonnée" : ""}.`;
    if (it.compared > 1 && it.kind !== "ok") note += ` Écart confirmé avec ${it.compared} récitateurs sur ${it.compared}.`;
    bars.appendChild(el("div", "bar-note", note));
    c.appendChild(bars);
  }
  const fix = el("p", "fix"); if (it.kind !== "ok") fix.appendChild(el("strong", null, "À corriger : ")); fix.appendChild(document.createTextNode(advice(it))); c.appendChild(fix);
  if (it.ref) {
    const acts = el("div", "acts");
    const b1 = el("button", "btn", "▶ " + (res.recName || "Récitateur")), b2 = el("button", "btn", "▶ Toi"), b3 = el("button", "btn primary", "▶ Lui puis toi");
    b1.onclick = () => playSeg(res.refBuf, it.ref);
    b2.onclick = () => { if (it.usr) playSeg(res.usrBuf, it.usr); };
    b3.onclick = () => { const d = playSeg(res.refBuf, it.ref); setTimeout(() => { if (it.usr) playSeg(res.usrBuf, it.usr); }, (d + 0.5) * 1000); };
    if (!it.usr || !res.usrBuf) b2.disabled = true;
    if (!res.refBuf) b1.disabled = true;
    acts.append(b1, b2, b3); c.appendChild(acts);
  }
  return c;
}

function openRecPicker() {
  const body = openSheet("Récitateur de référence");
  const st = settings();
  body.appendChild(el("p", "fix", "Ta récitation est comparée à ce récitateur. Tous les quatre sont reconnus pour la rigueur de leur tajwid."));
  RECITERS.forEach(r => {
    const b = el("button", "vrow" + (r.id === st.rec ? " sel" : ""));
    b.appendChild(el("span", null, r.name));
    b.appendChild(el("span", "pill " + (r.id === st.rec ? "ok" : ""), r.id === st.rec ? "✓ Choisi" : "Choisir"));
    b.onclick = () => { if (rec) return; saveSettings({ rec: r.id }); prep.clear(); updateRecChip(); prepAround(cur); openRecPicker(); };
    body.appendChild(b);
  });
  const lab = el("label", "vrow");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = !!st.multi;
  cb.onchange = () => saveSettings({ multi: cb.checked });
  const t = el("span", null, "Bilan croisé : ne compter un madd faux que s'il s'écarte de tous les récitateurs");
  lab.append(t, cb); body.appendChild(lab);
  if (rec) body.appendChild(el("p", "bar-note", "Arrête l'enregistrement pour changer de récitateur."));
}

function openSheet(title) { $("sheetTitle").textContent = title; $("sheetBody").textContent = ""; $("sheet").hidden = false; return $("sheetBody"); }
function closeSheet() { $("sheet").hidden = true; }

function openVerse(vi) {
  const res = results[vi];
  const body = openSheet(`Verset ${S.v[vi].n}`);
  if (!res) { body.appendChild(el("p", "empty", "Ce verset n'a pas encore été récité.")); return; }
  const bad = res.items.filter(isBad), good = res.items.filter(i => i.kind === "ok");
  const sc = el("div", "score " + (bad.length ? "warn" : "good"));
  sc.appendChild(el("div", "score-main", bad.length ? `${bad.length} correction${bad.length > 1 ? "s" : ""} à faire` : "Rien à corriger"));
  const nM = res.items.filter(i => i.type !== "extra" && i.type !== "diff" && i.kind !== "nf").length;
  if (nM) sc.appendChild(el("div", "score-sub", `${good.length} madd sur ${nM} bien tenu${good.length > 1 ? "s" : ""} · ${res.nRefs > 1 ? `comparé à ${res.nRefs} récitateurs` : `comparé à ${res.recName}`}, en tenant compte de ton rythme`));
  body.appendChild(sc);
  bad.forEach((it, i) => body.appendChild(card(vi, it, i + 1, res)));
  if (good.length) {
    const d = el("details"); d.appendChild(el("summary", "btn", `Voir les ${good.length} madd bien tenu${good.length > 1 ? "s" : ""}`));
    good.forEach(it => d.appendChild(card(vi, it, "✓", res)));
    body.appendChild(d);
  }
}

function openReport() {
  if (!S) return;
  const body = openSheet(`Bilan · ${S.c.n}`);
  const done = results.map((r, i) => [r, i]).filter(([r]) => r);
  if (!done.length) { body.appendChild(el("p", "empty", "Récite au moins un verset pour voir ton bilan.")); return; }
  const totBad = done.reduce((s, [r]) => s + r.items.filter(isBad).length, 0);
  const sc = el("div", "score " + (totBad ? "warn" : "good"));
  sc.appendChild(el("div", "score-main", totBad ? `${totBad} correction${totBad > 1 ? "s" : ""} sur ${done.length} verset${done.length > 1 ? "s" : ""}` : `${done.length} verset${done.length > 1 ? "s" : ""} sans erreur`));
  body.appendChild(sc);
  done.forEach(([r, i]) => {
    const n = r.items.filter(isBad).length;
    const b = el("button", "vrow"); b.appendChild(el("span", null, `Verset ${S.v[i].n}`));
    b.appendChild(el("span", "pill " + (n ? "warn" : "ok"), n ? `${n} correction${n > 1 ? "s" : ""}` : "✓ Bien"));
    b.onclick = () => openVerse(i);
    body.appendChild(b);
  });
}

function showCalib(m) {
  const body = openSheet(m.ok ? "Ta voix est étalonnée" : "Étalonnage incomplet");
  if (!m.ok) {
    body.appendChild(el("p", "fix", `L'application n'a pu analyser que ${m.verses} verset${m.verses > 1 ? "s" : ""} sur ${m.total}. Récite au moins 3 versets en entier, calmement et dans un endroit calme, puis recommence.`));
    const b = el("button", "btn primary", "Recommencer"); b.onclick = () => { closeSheet(); openSurah(0, true); };
    body.appendChild(b);
    return;
  }
  const row = (label, value, good) => { const r = el("div", "vrow"); r.appendChild(el("span", null, label)); r.appendChild(el("span", "pill " + (good ? "ok" : "warn"), value)); body.appendChild(r); };
  const sc = el("div", "score good");
  sc.appendChild(el("div", "score-main", "C'est enregistré"));
  sc.appendChild(el("div", "score-sub", `${m.verses} versets analysés. L'application connaît maintenant ton timbre, ton volume, ton rythme et ta façon de tenir les madds.`));
  body.appendChild(sc);
  body.appendChild(el("h3", "sub-h", "Qualité de l'enregistrement"));
  const q = m.snr >= 35 ? ["Excellente", true] : m.snr >= 25 ? ["Bonne", true] : ["Trop de bruit", false];
  row("Ta voix par rapport au bruit ambiant", q[0], q[1]);
  const f = m.reached ? m.followed / m.reached : 0;
  row("Suivi de ta voix", `${m.followed} verset${m.followed > 1 ? "s" : ""} sur ${m.reached} suivis jusqu'au bout`, f >= 0.7);
  body.appendChild(el("h3", "sub-h", "Ta façon de tenir les madds"));
  const pct = (v, n) => { if (n < 2) return ["pas assez d'exemples", true]; const p = Math.round((v - 1) * 100); return [p === 0 ? "comme le récitateur" : p > 0 ? `${p} % plus long` : `${-p} % plus court`, Math.abs(p) <= 30]; };
  [["Madds naturels (2 temps)", m.bias.tabii, m.counts.tabii], ["Madds longs (4 à 6 temps)", m.bias.long, m.counts.long], ["Fins de verset", m.bias.arid, m.counts.arid]].forEach(([l, v, n]) => { const [t, g] = pct(v, n); row(l, t, g); });
  body.appendChild(el("p", "fix", "Ces petits écarts sont maintenant considérés comme ta façon normale de réciter : seules les vraies erreurs seront signalées."));
  if (!q[1]) body.appendChild(el("p", "fix", "Conseil : refais l'étalonnage dans une pièce plus calme, le téléphone ou la tablette à 20 à 30 cm de ta bouche."));
  if (f < 0.7) body.appendChild(el("p", "fix", "Conseil : le suivi a décroché sur certains versets. Pendant la récitation, tu peux toucher un mot pour te recaler, ou « Reprendre » pour recommencer le verset."));
  const b = el("button", "btn primary", "Retour à l'accueil"); b.onclick = () => { closeSheet(); location.hash = ""; };
  body.appendChild(b);
}

/* ---------- navigation ---------- */
function route() {
  const m = location.hash.match(/^#s(\d+)$/);
  if (m) openSurah(+m[1]);
  else if (location.hash === "#etalonnage") openSurah(1, true);
  else { stopAll(); S = null; calibMode = false; $("surah").hidden = true; $("dock").hidden = true; closeSheet(); $("home").hidden = false; renderHome(); window.scrollTo(0, 0); }
}

$("q").addEventListener("input", renderHome);
$("back").addEventListener("click", () => { location.hash = ""; });
$("calibBtn").addEventListener("click", () => { location.hash = "etalonnage"; });
$("pages").addEventListener("click", e => {
  const ve = e.target.closest(".ve");
  if (ve) { const vi = +ve.dataset.v; if (results[vi]) openVerse(vi); else if (rec) worker.postMessage({ t: "goto", i: vi, w: 0 }); else selectVerse(vi); return; }
  const w = e.target.closest(".w");
  if (!w) return;
  if (rec && !(calibMode && !rec.calibGo)) { worker.postMessage({ t: "goto", i: +w.dataset.v, w: +w.dataset.w }); return; }
  if (!listen && !calibMode) { selectVerse(+w.dataset.v); setStatus(`Départ : verset ${S.v[+w.dataset.v].n}. Touche le micro ou Écouter.`); }
});
$("mic").addEventListener("click", () => rec ? stopRec() : startRec());
$("listen").addEventListener("click", () => listen ? stopListen() : (S && playFrom(cur)));
$("report").addEventListener("click", openReport);
$("restart").addEventListener("click", () => { if (rec) worker.postMessage({ t: "restart" }); });
$("recBtn").addEventListener("click", openRecPicker);
$("recSel").addEventListener("change", e => { saveSettings({ rec: +e.target.value }); });
$("multi").addEventListener("change", e => { saveSettings({ multi: e.target.checked }); });
$("sheetClose").addEventListener("click", closeSheet);
$("sheet").addEventListener("click", e => { if (e.target === $("sheet")) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
window.addEventListener("hashchange", route);

loadChapters().then(c => {
  chapters = c || COUNTS.map((n, i) => ({ id: i + 1, n: "Sourate " + (i + 1), a: "", fr: "", c: n }));
  if (!c) setTimeout(() => { const g = $("grid"); if (g) g.prepend(el("p", "empty", "Noms des sourates indisponibles hors ligne pour l'instant.")); }, 0);
  route();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
