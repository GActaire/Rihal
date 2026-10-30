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
const settings = () => ({ rec: 6, multi: true, asr: false, ...store.get("settings", {}) });
const saveSettings = p => store.set("settings", { ...settings(), ...p });

let chapters = [], S = null, cur = 0, ctx = null, playing = null, calibMode = false;
let wordEls = [], veEls = [], results = [], usrBufs = [];
let rec = null, listen = null, pendingStart = false;
const worker = new Worker("worker.js?v=8");

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
  for (let k = 0; k <= 3; k++) prepVerse(vi + k, st.rec);
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
  hifzCard(); asrUi();
  const v = store.get("voice", null), cs = $("calibState");
  cs.textContent = v ? `Voix étalonnée le ${new Date(v.profile.date).toLocaleDateString("fr-FR")}` : "Pas encore étalonnée";
  $("calibBtn").textContent = v ? "Refaire" : "Étalonner";
  $("calibCard").classList.toggle("done", !!v);
}

/* ---------- lecture d'une sourate ---------- */
async function openSurah(id, calib) {
  const keep = !calib && rec && rec.located && rec.located.s === id;
  if (keep) stopListen(); else stopAll();
  $("suggest").hidden = true;
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
  H = !calibMode && pendingH && pendingH.s === id ? pendingH : null; pendingH = null;
  if (H) { H.to = Math.min(H.to, S.v.length - 1); H.t0 = Date.now(); }
  const last = store.get("last", null);
  cur = calibMode ? 0 : H ? (H.step === 2 ? H.link : H.from) : (last && last.s === id ? Math.min(last.v, S.v.length - 1) : 0);
  renderPages();
  markRange(); hifzBar();
  updateRecChip();
  selectVerse(cur, !calibMode);
  setStatus(calibMode ? "Étape 1 sur 2 : touche le micro, puis reste silencieux 3 secondes." : H ? (H.step === 0 ? "Touche « Écouter »." : "Touche le micro quand tu es prêt.") : asrReady() ? "Touche le micro et récite : Rihal reconnaît le verset tout seul." : "Touche un mot pour choisir le verset de départ, puis le micro.");
  if (keep && rec) beginLocated();
  else if (pendingStart && !calibMode) { pendingStart = false; startRec(); }
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
  if (!calibMode && !H) store.set("last", { s: S.id, v: cur });
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
const lit = { tv: -1, tw: -1, tf: 0, tl: -1, tlf: 0, dv: -1, dw: -1, da: 0, db: 0, raf: 0 };
function setTarget(vi, wi, f, l, lf) {
  if (vi === lit.tv && wi < lit.tw) return; // jamais en arrière dans un verset
  lit.tv = vi; lit.tw = wi; lit.tf = f; lit.tl = l == null ? -1 : l; lit.tlf = lf || 0;
  if (!lit.raf) lit.raf = requestAnimationFrame(frameLight);
}
// une « lettre » = la lettre de base et ses signes (voyelles, sukun, chadda, madda…), comme dans le moteur
const isMk = ch => { const x = ch.charCodeAt(0); return (x >= 0x64B && x <= 0x65F) || x === 0x670 || (x >= 0x6D6 && x <= 0x6ED) || (x >= 0x8F0 && x <= 0x8FF); };
function clusters(s) { const out = []; for (let i = 0; i < s.length; i++) { if (isMk(s[i]) && out.length) out[out.length - 1][1] = i + 1; else out.push([i, i + 1]); } return out; }
// position de chaque lettre à l'écran, en fraction de la largeur du mot depuis la droite (le texte reste d'un seul tenant : les liaisons arabes sont intactes)
function glyphs(w) {
  const t = w.firstChild; if (!t || !t.firstChild) return null;
  const R = t.getBoundingClientRect(); if (!R.width) return null;
  if (w._g && Math.abs(w._gw - R.width) < 0.5) return w._g;
  const node = t.firstChild, s = node.textContent, rg = document.createRange(), out = [];
  const cl = (x) => Math.max(0, Math.min(1, x));
  for (const [a, b] of clusters(s)) {
    rg.setStart(node, a); rg.setEnd(node, b);
    const r = rg.getBoundingClientRect();
    let x0 = r.width ? cl((R.right - r.right) / R.width) : null, x1 = r.width ? cl((R.right - r.left) / R.width) : null;
    out.push([x0, x1]);
  }
  for (let k = 0; k < out.length; k++) {
    const p = k ? out[k - 1] : [0, 0];
    if (out[k][0] == null) out[k] = [p[1], p[1]];
    out[k][0] = Math.max(out[k][0], p[0]); out[k][1] = Math.max(out[k][1], out[k][0] + 0.01);
  }
  if (out.length) out[out.length - 1][1] = 1;
  w._g = out; w._gw = R.width;
  return out;
}
function letterIn(lt, w, f) {
  const B = lt && lt[w]; if (!B || B.length < 2) return { l: -1, lf: 0 };
  let k = 0; while (k < B.length - 2 && f >= B[k + 1]) k++;
  return { l: k, lf: Math.max(0, Math.min(1, (f - B[k]) / Math.max(1, B[k + 1] - B[k]))) };
}
const ltMap = new Map();
const unlight = w => { w.classList.remove("on"); w.style.removeProperty("--a"); w.style.removeProperty("--b"); };
function frameLight() {
  lit.raf = 0;
  if (lit.tv < 0) return;
  const ws = wordEls[lit.tv]; if (!ws) return;
  if (lit.dv !== lit.tv || lit.dw !== lit.tw) {
    if (lit.dv >= 0 && lit.dv !== lit.tv) (wordEls[lit.dv] || []).forEach(unlight);
    for (let k = 0; k < ws.length; k++) { ws[k].classList.toggle("done", k < lit.tw); if (k === lit.tw) ws[k].classList.add("on"); else unlight(ws[k]); }
    lit.dv = lit.tv; lit.dw = lit.tw; lit.da = 0; lit.db = 0;
    const w = ws[lit.dw], r = w && w.getBoundingClientRect();
    if (r && (r.top < 70 || r.bottom > innerHeight - 200)) w.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const w = ws[lit.dw]; if (!w) return;
  // a = partie déjà prononcée, b = fin de la lettre en cours (qui brille)
  let A, B;
  const g = lit.tl >= 0 ? glyphs(w) : null;
  if (g && g[lit.tl]) { const [x0, x1] = g[lit.tl]; A = x0 + (x1 - x0) * lit.tlf; B = x1; }
  else { A = lit.tf; B = Math.min(1, lit.tf + 0.15); }
  lit.da += (A - lit.da) * 0.35; lit.db += (B - lit.db) * 0.35;
  w.style.setProperty("--a", (lit.da * 100).toFixed(1) + "%");
  w.style.setProperty("--b", (Math.max(lit.da, lit.db) * 100).toFixed(1) + "%");
  if (Math.abs(A - lit.da) > 0.003 || Math.abs(B - lit.db) > 0.003) lit.raf = requestAnimationFrame(frameLight);
}
function finishLight(vi) { (wordEls[vi] || []).forEach(w => { unlight(w); w.classList.add("done"); }); if (lit.tv === vi) { lit.tv = -1; lit.dv = -1; } }
function clearLight(keepTarget) {
  wordEls.forEach(ws => ws.forEach(w => { unlight(w); w.classList.remove("done"); }));
  lit.dv = -1; lit.dw = -1; lit.da = 0; lit.db = 0;
  if (!keepTarget) { lit.tv = -1; lit.tw = -1; }
}

/* ---------- écoute d'al-Husary avec la lumière ---------- */
async function playFrom(vi) {
  stopAll();
  const c = audioCtx(); if (c.resume) c.resume();
  listen = { stop: false };
  setListenUi(true);
  const L = listen;
  const endV = H ? H.to : S.v.length - 1;
  for (let v = vi; v <= endV && !L.stop; v++) {
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
        if (f >= 0) { const wp = wordAtT(p.wt, f, total); if (wp.w >= 0) { const lt = letterIn(ltMap.get(keyOf(v)), wp.w, f); setTarget(v, wp.w, wp.f, lt.l, lt.lf); } }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    finishLight(v);
  }
  if (listen === L) {
    listen = null; setListenUi(false); clearLight();
    if (H && H.step === 0) { H.listens++; hifzBar(); setStatus(H.listens >= 3 ? "Bien écouté ✓. Passe à « Répéter » quand tu veux." : `Écoute ${H.listens}/3 terminée. Encore une fois ?`, "ok"); }
    else setStatus("Touche le micro pour réciter.");
  }
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

// ouvre le micro ; renvoie de quoi le brancher au worker
async function openMic(say) {
  const c = audioCtx(); if (c.resume) c.resume();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say("Ce navigateur ne donne pas accès au micro."); return null; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } }); }
  catch (e) { say("Le micro est refusé. Autorise-le pour ce site dans les réglages du navigateur."); return null; }
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
  return { stream, src, node, mute, port, rate: c.sampleRate };
}
function closeMic(cap) { try { cap.src.disconnect(); cap.node.disconnect(); cap.mute.disconnect(); } catch (_) {} cap.stream.getTracks().forEach(t => t.stop()); }
function sendToWorker(cap, msg) {
  if (cap.port && !cap.portSent) { msg.port = cap.port; cap.portSent = true; worker.postMessage(msg, [cap.port]); }
  else worker.postMessage(msg);
}
function micOn() { $("mic").classList.add("rec"); $("micIco").hidden = true; $("stopIco").hidden = false; }

async function startRec() {
  stopListen();
  if (!S) return;
  const btn = $("mic");
  btn.classList.add("busy"); setStatus("Préparation…");
  const cap = await openMic(setStatus);
  btn.classList.remove("busy");
  if (!cap) return;
  if (!S || rec) { closeMic(cap); return; }
  // reconnaissance vocale prête : on écoute d'abord, elle trouve le passage, puis la lumière te suit
  if (asrReady() && !calibMode && !H) { beginScan(cap, true); return; }
  if (H && !inRange(cur)) cur = H.step === 2 ? H.link : H.from;
  startSession(cap, { i: cur });
}

function startSession(cap, o) {
  if (H) resetRange();
  if (!S.t0) S.t0 = Date.now();
  rec = cap; rec.vi = o.i; rec.scanning = false; rec.busy = false;
  cur = o.i;
  clearLight();
  const voice = calibMode ? null : store.get("voice", null);
  const st = settings();
  prepAround(o.i);
  const others = st.multi && !calibMode ? RECITERS.filter(r => r.id !== st.rec && r.id !== 12).map(r => r.id) : [];
  const lim = H ? H.to + 1 : S.v.length;
  const msg = { t: "start", wc: S.v.slice(0, lim).map(V => V.w.length), keys: S.v.slice(0, lim).map((_, i) => keyOf(i, st.rec)), extra: S.v.slice(0, lim).map((_, i) => others.map(r => keyOf(i, r))), i: o.i, rate: cap.rate, profile: voice && voice.profile, bias: voice && voice.bias, calib: calibMode, locate: !calibMode && !o.fromScan && !asrReady(), asr: asrReady() && !calibMode, dbg: !!window.__RIHAL_ORT_URL };
  if (o.fromScan) msg.fromScan = o.fromScan;
  if (msg.asr) recoHint(S.id, o.i);
  sendToWorker(cap, msg);
  micOn();
  $("restart").disabled = false;
}

// écoute sans savoir encore où il récite : les extraits partent à la reconnaissance vocale
function beginScan(cap, inSurah) {
  rec = cap; Object.assign(rec, { scanning: true, inSurah, vi: cur });
  recoHint(inSurah && S ? S.id : 0, cur);
  const voice = store.get("voice", null);
  sendToWorker(cap, { t: "scan", rate: cap.rate, floor: voice && voice.profile ? voice.profile.floor : null });
  micOn();
  scanSay(inSurah ? "Récite : je reconnais où tu en es…" : "Je t'écoute… récite quelques mots.");
}
function scanSay(t, kind) { const a = $("autoStatus"); if (rec && !rec.inSurah && a) a.textContent = t; else setStatus(t, kind); }

// la reconnaissance vocale a trouvé où il récite
function onLocated(m) {
  if (rec.scanning) {
    rec.scanning = false;
    rec.located = { s: m.s, v: m.a, w: m.w, aw: m.aw, at: Math.max(0, m.g0 - Math.round(0.25 * SR)) };
    if (S && S.id === m.s && !calibMode) beginLocated();
    else { scanSay(`Trouvé : ${surName(m.s)}, verset ${m.a}.`, "ok"); closeSheet(); location.hash = "s" + m.s; }
    return;
  }
  if (S && S.id && m.s !== S.id && !H && !calibMode) suggestSurah(m.s, m.a);
}
// pendant l'écoute : s'il n'est toujours pas reconnu après un moment
function onScanVoiced(sec) {
  if (!rec || !rec.scanning) return;
  if (rec.inSurah && S && sec >= 14) { setStatus("Passage pas encore reconnu : je pars du verset choisi, et je me recalerai dès que je te reconnais."); startSession(rec, { i: cur, fromScan: { w: 0, at: 0 } }); return; }
  if (!rec.inSurah && sec >= 24) { scanFail("Je n'ai pas reconnu le passage."); return; }
  if (sec === 7) scanSay("Continue, j'écoute encore un peu…");
  else if (sec === 15) scanSay("Encore quelques mots…");
}
async function beginLocated() {
  const L = rec && rec.located; if (!S || !L) return;
  const vi = Math.max(0, Math.min(S.v.length - 1, L.v - 1));
  const shown = S.v[vi].w.map(x => x[0]);
  const w = L.w > 0 && L.aw && L.aw.length ? RihalSearch.mapWord(L.aw, shown, L.w) : 0;
  rec.located = null; rec.vi = vi;
  selectVerse(vi, true);
  setStatus(`Trouvé : ${S.c.n}, verset ${S.v[vi].n}. Je te suis…`, "ok");
  const st = settings(), others = st.multi ? RECITERS.filter(r => r.id !== st.rec && r.id !== 12).map(r => prepVerse(vi, r.id)) : [];
  await Promise.race([Promise.all([prepVerse(vi), prepVerse(vi + 1), ...others]), new Promise(r => setTimeout(r, 9000))]);
  if (!rec || !S) return;
  startSession(rec, { i: vi, fromScan: { w, at: L.at } });
}
function scanFail(msg) {
  const fromHome = rec && !rec.inSurah;
  stopRec();
  if (!fromHome) { setStatus(msg); return; }
  const body = openSheet("Passage non reconnu");
  body.appendChild(el("p", "fix", msg + " Récite un peu plus fort ou plus près de la tablette, ou choisis la sourate dans la liste."));
  const again = el("button", "btn primary", "Réessayer"); again.onclick = () => { closeSheet(); startAuto(); }; body.appendChild(again);
}
// pendant la récitation : la reconnaissance dit où il en est (avec ~0,7 s de retard) ; le suivi s'y recale si besoin
const wmaps = new Map();
function wordMap(s, a) {
  const k = s + ":" + a; if (wmaps.has(k)) return wmaps.get(k);
  const aw = awCache.get(k), V = S && S.id === s ? S.v[a - 1] : null;
  if (!aw || !aw.length || !V) return null;
  const mp = RihalSearch.mapWord(aw, V.w.map(x => x[0]), "all");
  wmaps.set(k, mp); return mp;
}
function onRecoPos(m) {
  if (rec.scanning || rec.located || !S || !S.id || calibMode || m.lost) return;
  if (m.s !== S.id) { if (!H) suggestSurah(m.s, m.a); return; }
  $("suggest").hidden = true;
  const vi = m.a - 1; if (vi < 0 || vi >= S.v.length) return;
  if (H && !inRange(vi)) return;
  const mp = wordMap(m.s, m.a);
  const w = mp ? mp[Math.min(m.w, mp.length - 1)] : Math.min(m.w, S.v[vi].w.length - 1);
  prepVerse(vi).then(() => { if (rec && !rec.scanning && S && S.id === m.s) worker.postMessage({ t: "asrPos", i: vi, w, cf: m.cf, end: m.g, ga: m.ga }); });
}
function suggestSurah(s, a) {
  const b = $("suggest");
  b.textContent = `Tu récites ${surName(s)}, verset ${a} ? Y aller`;
  b.hidden = false;
  b.onclick = () => { b.hidden = true; stopRec(); store.set("last", { s, v: a - 1 }); pendingStart = true; location.hash = "s" + s; };
}

// depuis l'accueil : appuyer, réciter, Rihal trouve la sourate et le verset
async function startAuto() {
  if (rec) { stopRec(); return; }
  if (!asrReady()) { openAsrSheet(); return; }
  const body = openSheet("Réciter");
  const live = el("div", "auto-live"); live.innerHTML = '<span class="auto-ring"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V5.5a3.5 3.5 0 1 0-7 0V11a3.5 3.5 0 0 0 3.5 3.5Zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V19H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.09A6 6 0 0 0 18 11Z"/></svg></span>';
  body.appendChild(live);
  const p = el("p", "auto-status", "Préparation du micro…"); p.id = "autoStatus"; body.appendChild(p);
  body.appendChild(el("p", "h-note", "Récite normalement, à partir de n'importe quel verset. Dès que Rihal reconnaît le passage, la page s'ouvre et la lumière te suit."));
  const stop = el("button", "btn", "Arrêter"); stop.onclick = () => { stopRec(); closeSheet(); }; body.appendChild(stop);
  const cap = await openMic(t => { const a = $("autoStatus"); if (a) a.textContent = t; });
  if (!cap) return;
  if ($("sheet").hidden || rec) { closeMic(cap); return; }
  beginScan(cap, false);
}
function meter(db) {
  const v = Math.max(0, Math.min(1, (db + 62) / 42)).toFixed(2);
  $("mic").style.setProperty("--lvl", v);
  const r = document.querySelector(".auto-ring"); if (r) r.style.setProperty("--lvl", v);
}

function stopRec(fromWorker) {
  if (!rec) return;
  const r = rec; rec = null;
  closeMic(r);
  if (!fromWorker) worker.postMessage({ t: "stop" });
  $("mic").classList.remove("rec"); $("micIco").hidden = false; $("stopIco").hidden = true; $("mic").style.removeProperty("--lvl");
  if (r.scanning && !r.inSurah) { const a = $("autoStatus"); if (a) closeSheet(); }
  $("restart").disabled = true;
  veEls.forEach(v => v && v.classList.remove("st-run"));
  if (!calibMode && !H) setStatus("Arrêté. Touche « Bilan » pour voir tes corrections.");
}
function stopAll() { stopListen(); if (rec) stopRec(); }

worker.onmessage = e => {
  const m = e.data;
  if (m.t === "lvl") { if (rec) meter(m.db); return; }
  if (m.t === "voiced") { onScanVoiced(m.s); return; }
  if (m.t === "prepped" && m.lt) ltMap.set(m.key, m.lt);
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
      if (rec) rec.vi = m.i;
      if (m.asr) { selectVerse(m.i, true); setStatus(`Tu récites le verset ${S.v[m.i].n} : je te suis.`, "ok"); }
      else setStatus(m.w ? `Reprise au mot touché, verset ${S.v[m.i].n}.` : `On reprend le verset ${S.v[m.i].n} depuis le début.`, "ok");
      break;
    case "skipped":
      setStatus(`Tu es passé au verset ${S.v[m.to].n} : je te suis.`, "ok");
      if (rec) rec.vi = m.to;
      break;
    case "caught":
      setStatus(`Verset ${S.v[m.i].n} : je te suis.`, "ok");
      break;
    case "relock":
      if (m.asr) { if (m.next && S.v[m.i]) setStatus(`Verset ${S.v[m.i].n} : je te suis.`, "ok"); break; }
      if (S.v[m.i]) setStatus(m.next ? `Recalé : tu es au verset ${S.v[m.i].n}.` : m.back ? `Recalé : tu as repris plus haut dans le verset ${S.v[m.i].n}.` : m.asr ? "Recalé grâce à la reconnaissance de ta voix." : "Recalé sur ta voix.", "ok");
      break;
    case "pos":
      if (rec && m.i === rec.vi && m.w >= 0) setTarget(m.i, m.w, m.f, m.l, m.lf);
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
      if (rec && bad && !calibMode && !(H && H.step === 2)) setStatus(`Verset ${S.v[m.i].n} : ${bad} correction${bad > 1 ? "s" : ""}. Touche son numéro pour voir.`, "court");
      if (!calibMode && !H && results.every(Boolean)) { const d = store.get("done", {}); d[S.id] = 1; store.set("done", d); }
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
      if (H) setTimeout(hifzFinished, 300);
      else if (!calibMode) { logFree(); setTimeout(() => { if (results.some(Boolean)) openReport(); }, 300); }
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
function closeSheet() { $("sheet").hidden = true; if (rec && rec.scanning && !rec.inSurah) stopRec(); }

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

/* ---------- mémorisation (hifz) : nouveau / révision récente / révision ancienne + répétition espacée ---------- */
const DAY = 864e5;
const dstr = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const dnum = s => { const [y, m, d] = s.split("-").map(Number); return Math.round(new Date(y, m - 1, d).getTime() / DAY); };
const addDays = (n, from) => dstr((from ? new Date(from.replace(/-/g, "/")).getTime() : Date.now()) + n * DAY + 3600e3);
const LADDER = [1, 2, 4, 7];
const GRADES = [["Oublié", "Je n'y arrivais pas sans aide"], ["Difficile", "Avec des hésitations"], ["Bien", "Quelques petites hésitations"], ["Facile", "Fluide, sans réfléchir"]];
const hz = () => { const h = store.get("hifz", null) || {}; h.units = h.units || {}; h.log = h.log || []; return h; };
const saveHz = h => { if (h.log.length > 2000) h.log = h.log.slice(-2000); store.set("hifz", h); };
let H = null, pendingH = null;
const surName = s => (chapters[s - 1] && chapters[s - 1].n) || "Sourate " + s;
const unitLabel = u => `${surName(u.s)} · ${u.a === u.b ? "v. " + u.a : `v. ${u.a}–${u.b}`}`;
const KIND = { learn: "Nouveau", queue: "À apprendre", sabqi: "Révision récente", manzil: "Révision ancienne" };

async function addSurah(s, known) {
  const t = await loadText(s); if (!t) return false;
  const h = hz(); const groups = [];
  t.v.forEach(V => { const g = groups[groups.length - 1]; if (g && g.p === V.p && g.vs.length < 20) g.vs.push(V.n); else groups.push({ p: V.p, vs: [V.n] }); });
  const base = Date.now();
  groups.forEach((g, i) => {
    const id = `${s}-${g.vs[0]}`; if (h.units[id]) return;
    const u = { id, s, a: g.vs[0], b: g.vs[g.vs.length - 1], p: g.p, step: 0, iv: 0, ease: 2, reps: 0, lapses: 0, added: dstr() };
    if (known) Object.assign(u, { status: "manzil", iv: 14, due: addDays(1 + (Object.keys(h.units).length % 10)) });
    else Object.assign(u, { status: "queue", order: base + i });
    h.units[id] = u;
  });
  saveHz(h); return true;
}

function schedule(u, g) {
  const fuzz = n => Math.max(1, Math.round(n * (0.92 + 0.16 * Math.random())));
  u.reps++; u.last = dstr();
  if (u.status === "learn" || u.status === "sabqi") {
    if (g === 0) { u.status = u.status === "learn" ? "learn" : "sabqi"; u.step = 0; u.iv = 1; if (u.status === "sabqi") u.lapses++; }
    else {
      if (u.status === "learn") { u.status = "sabqi"; u.step = g === 3 ? 1 : 0; }
      else if (g >= 2) u.step += g === 3 ? 2 : 1;
      if (u.step >= LADDER.length) { u.status = "manzil"; u.iv = g === 3 ? 21 : 14; }
      else u.iv = LADDER[u.step];
    }
  } else {
    if (g === 0) { u.status = "sabqi"; u.step = 0; u.iv = 1; u.lapses++; u.ease = Math.max(1.3, u.ease - 0.2); }
    else if (g === 1) { u.iv = Math.max(3, fuzz(u.iv * 1.2)); u.ease = Math.max(1.3, u.ease - 0.15); }
    else if (g === 2) u.iv = fuzz(u.iv * u.ease);
    else { u.iv = fuzz(u.iv * u.ease * 1.3); u.ease = Math.min(3, u.ease + 0.1); }
    u.iv = Math.min(60, u.iv); // révision ancienne : tout repasse au moins tous les 2 mois
  }
  u.due = addDays(u.iv);
  return u;
}
function previewIv(u, g) { const c = schedule(JSON.parse(JSON.stringify(u)), g); return c.iv; }

function plan() {
  const h = hz(), today = dstr(), us = Object.values(h.units);
  const due = us.filter(u => (u.status === "sabqi" || u.status === "manzil") && u.due && u.due <= today).sort((a, b) => a.due < b.due ? -1 : a.due > b.due ? 1 : a.s - b.s || a.a - b.a);
  const sabqi = due.filter(u => u.status === "sabqi"), manzil = due.filter(u => u.status === "manzil");
  let fresh = us.find(u => u.status === "learn" && (!u.due || u.due <= today)) || null;
  const learnedToday = h.log.some(e => e.mode === "nouveau" && dstr(e.t) === today && e.g > 0);
  let held = false;
  if (!fresh && !learnedToday && !us.some(u => u.status === "learn")) {
    const q = us.filter(u => u.status === "queue").sort((a, b) => a.order - b.order)[0];
    if (q) { if (due.length > 15) held = true; else fresh = q; }
  }
  return { fresh, sabqi, manzil, held, learnedToday, h };
}

function stats(h) {
  const us = Object.values(h.units), mem = us.filter(u => u.status === "sabqi" || u.status === "manzil");
  const verses = mem.reduce((s, u) => s + u.b - u.a + 1, 0);
  const days = new Set(h.log.map(e => dstr(e.t)));
  let streak = 0, d = dstr(); if (!days.has(d)) d = addDays(-1);
  while (days.has(d)) { streak++; d = addDays(-1, d); }
  const wk = h.log.filter(e => Date.now() - e.t < 7 * DAY).reduce((s, e) => s + (e.min || 0), 0);
  return { verses, units: mem.length, streak, wk: Math.round(wk), pages: new Set(mem.map(u => u.p)).size };
}

function hifzCard() {
  const box = $("hifzCard"); if (!box) return;
  const { fresh, sabqi, manzil } = plan(), st = stats(hz());
  box.textContent = "";
  const t = el("div"); t.appendChild(el("b", null, "Mon hifz"));
  const todo = sabqi.length + manzil.length + (fresh ? 1 : 0);
  t.appendChild(el("span", null, todo ? `Aujourd'hui : ${todo} portion${todo > 1 ? "s" : ""} à réciter` : st.units ? "Rien à réviser aujourd'hui ✓" : "Commence ton programme de mémorisation"));
  box.appendChild(t);
  const r = el("div", "hc-stats");
  r.appendChild(el("span", null, `🔥 ${st.streak} j`)); r.appendChild(el("span", null, `${st.verses} versets`));
  box.appendChild(r);
  box.onclick = () => { location.hash = "hifz"; };
}

function heat(h) {
  const per = {}; h.log.forEach(e => { const k = dstr(e.t); per[k] = (per[k] || 0) + (e.min || 1); });
  const g = el("div", "heat"); const today = new Date(); const offset = (today.getDay() + 6) % 7;
  const n = 7 * 12 + offset + 1;
  for (let i = n - 1; i >= 0; i--) {
    const k = dstr(Date.now() - i * DAY), v = per[k] || 0;
    const c = el("i", "lv" + (v === 0 ? 0 : v < 10 ? 1 : v < 25 ? 2 : v < 45 ? 3 : 4)); c.title = `${k} : ${Math.round(v)} min`;
    g.appendChild(c);
  }
  return g;
}

function renderHifz() {
  const v = $("hifz"); v.textContent = "";
  const bar = el("header", "bar");
  const back = el("button", "icon-btn"); back.setAttribute("aria-label", "Accueil"); back.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg>'; back.onclick = () => { location.hash = ""; };
  bar.appendChild(back); const tt = el("div", "bar-title"); tt.appendChild(el("span", "h-title", "Mon hifz")); tt.appendChild(el("span", "ar-name", "حِفْظ")); bar.appendChild(tt); bar.appendChild(el("span"));
  v.appendChild(bar);
  const P = plan(), h = P.h, st = stats(h);
  const sr = el("div", "h-stats");
  [[`${st.streak}`, "jours d'affilée"], [`${st.verses}`, "versets mémorisés"], [`${st.pages}`, "pages"], [`${st.wk} min`, "cette semaine"]].forEach(([a, b]) => { const c = el("div", "h-stat"); c.appendChild(el("b", null, a)); c.appendChild(el("span", null, b)); sr.appendChild(c); });
  v.appendChild(sr);
  const pr = el("div", "h-prog"); const fill = el("i"); fill.style.width = Math.max(0.5, st.verses / 6236 * 100).toFixed(2) + "%"; pr.appendChild(fill);
  v.appendChild(pr); v.appendChild(el("p", "h-note", `${(st.verses / 6236 * 100).toFixed(1).replace(".", ",")} % du Coran · ${st.verses} / 6236 versets`));

  v.appendChild(el("h3", "sub-h", "Aujourd'hui"));
  const row = (u, mode, note) => {
    const b = el("button", "h-task m-" + mode);
    const l = el("span", "h-task-l"); l.appendChild(el("span", "h-kind", mode === "nouveau" ? "1 · Nouveau" : mode === "sabqi" ? "2 · Révision récente" : "3 · Révision ancienne"));
    l.appendChild(el("b", null, unitLabel(u))); l.appendChild(el("span", "h-sub", note));
    b.appendChild(l); b.appendChild(el("span", "h-go", "Commencer"));
    b.onclick = () => startHifz(u.id, mode);
    v.appendChild(b);
  };
  if (P.fresh) row(P.fresh, "nouveau", `page ${P.fresh.p} · écouter, répéter, puis réciter de mémoire`);
  else if (P.held) v.appendChild(el("p", "h-tip", "Pas de nouvelle portion aujourd'hui : tu as beaucoup de révisions en retard. Les maîtres du hifz le disent : on n'ajoute pas tant que l'ancien n'est pas solide."));
  else if (P.learnedToday) v.appendChild(el("p", "h-tip", "Nouvelle portion du jour apprise ✓. La suivante sera proposée demain."));
  P.sabqi.forEach(u => row(u, "sabqi", `revue n° ${u.step + 1} · récite de mémoire`));
  P.manzil.forEach(u => row(u, "manzil", `tous les ${u.iv} jours environ · récite de mémoire`));
  if (!P.fresh && !P.sabqi.length && !P.manzil.length && !P.held && !P.learnedToday) v.appendChild(el("p", "h-tip", Object.keys(h.units).length ? "Tout est à jour. Tu peux réciter librement ou ajouter une sourate." : "Ajoute une première sourate ci-dessous. Commence petit : une sourate courte de Juz ʿAmma, par exemple."));

  v.appendChild(el("h3", "sub-h", "Ajouter une sourate"));
  const add = el("div", "settings");
  const sel = el("select"); chapters.forEach(c => { const o = el("option", null, `${c.id}. ${c.n}`); o.value = c.id; sel.appendChild(o); }); sel.value = 114;
  const lab = el("label", "field"); lab.appendChild(el("span", null, "Sourate")); lab.appendChild(sel); add.appendChild(lab);
  const acts = el("div", "acts");
  const b1 = el("button", "btn primary", "À apprendre"), b2 = el("button", "btn", "Je la connais déjà");
  const go = async known => { b1.disabled = b2.disabled = true; const ok = await addSurah(+sel.value, known); if (!ok) { b1.disabled = b2.disabled = false; alertMsg(add, "Impossible de charger cette sourate. Vérifie ta connexion."); return; } renderHifz(); };
  b1.onclick = () => go(false); b2.onclick = () => go(true);
  acts.appendChild(b1); acts.appendChild(b2); add.appendChild(acts);
  add.appendChild(el("p", "h-note", "« Je la connais déjà » la place directement en révision ancienne, étalée sur les prochains jours."));
  v.appendChild(add);

  const us = Object.values(h.units);
  if (us.length) {
    v.appendChild(el("h3", "sub-h", "Mon programme"));
    const bySur = new Map(); us.forEach(u => { if (!bySur.has(u.s)) bySur.set(u.s, []); bySur.get(u.s).push(u); });
    const list = el("div", "h-list");
    [...bySur.entries()].sort((a, b) => a[0] - b[0]).forEach(([s, arr]) => {
      arr.sort((a, b) => a.a - b.a);
      const d = el("details", "h-sur"); const sm = el("summary");
      const memd = arr.filter(u => u.status === "sabqi" || u.status === "manzil").length;
      sm.appendChild(el("b", null, `${s}. ${surName(s)}`)); sm.appendChild(el("span", "pill " + (memd === arr.length ? "ok" : "warn"), `${memd}/${arr.length} portion${arr.length > 1 ? "s" : ""}`));
      d.appendChild(sm);
      arr.forEach(u => {
        const r = el("div", "vrow h-unit"); const l = el("span"); l.appendChild(el("b", null, u.a === u.b ? `v. ${u.a}` : `v. ${u.a}–${u.b}`)); l.appendChild(el("span", "h-sub", ` · ${KIND[u.status]}${u.due && u.status !== "queue" ? " · prochaine : " + fmtDay(u.due) : ""}`));
        r.appendChild(l);
        const bt = el("button", "btn", u.status === "queue" ? "Apprendre" : "Réciter");
        bt.onclick = e => { e.stopPropagation(); startHifz(u.id, u.status === "queue" || u.status === "learn" ? "nouveau" : u.status); };
        r.appendChild(bt); d.appendChild(r);
      });
      const rm = el("button", "btn ghost", "Retirer cette sourate du programme");
      rm.onclick = () => { if (!confirm(`Retirer ${surName(s)} du programme ? Ton journal est conservé.`)) return; const hh = hz(); Object.keys(hh.units).forEach(k => { if (hh.units[k].s === s) delete hh.units[k]; }); saveHz(hh); renderHifz(); };
      d.appendChild(rm);
      list.appendChild(d);
    });
    v.appendChild(list);
  }

  v.appendChild(el("h3", "sub-h", "Journal"));
  v.appendChild(heat(h));
  const jl = el("div", "h-journal");
  const recent = h.log.slice(-60).reverse();
  if (!recent.length) jl.appendChild(el("p", "empty", "Ton activité apparaîtra ici après ta première séance."));
  let lastDay = "";
  recent.forEach(e => {
    const dd = dstr(e.t);
    if (dd !== lastDay) { jl.appendChild(el("div", "h-day", fmtDay(dd, true))); lastDay = dd; }
    const r = el("div", "h-entry");
    const lbl = { nouveau: "Nouveau", sabqi: "Révision récente", manzil: "Révision ancienne", libre: "Récitation libre" }[e.mode] || e.mode;
    r.appendChild(el("span", "h-dot m-" + e.mode));
    const c = el("span", "h-e-main"); c.appendChild(el("b", null, `${lbl} · ${surName(e.s)} ${e.a === e.b ? e.a : e.a + "–" + e.b}`));
    const bits = [`${Math.max(1, Math.round(e.min || 0))} min`];
    if (e.hints != null) bits.push(e.hints ? `${e.hints} indice${e.hints > 1 ? "s" : ""}` : "sans indice");
    if (e.madd) bits.push(`${e.madd} madd à corriger`);
    if (e.diff) bits.push(`${e.diff} passage${e.diff > 1 ? "s" : ""} hésitant${e.diff > 1 ? "s" : ""}`);
    if (e.g != null) bits.push(GRADES[e.g][0]);
    c.appendChild(el("span", "h-sub", bits.join(" · "))); r.appendChild(c);
    jl.appendChild(r);
  });
  v.appendChild(jl);

  v.appendChild(el("h3", "sub-h", "La méthode"));
  const m = el("details", "h-method"); m.appendChild(el("summary", null, "Comment Rihal t'aide à mémoriser"));
  [
    ["Chaque jour, trois parts (méthode des écoles coraniques)", "1. Nouveau (sabaq) : une petite portion, souvent une page ou une sourate courte. 2. Révision récente (sabqi) : ce que tu as appris ces derniers jours. 3. Révision ancienne (manzil) : tout le reste, en boucle. La révision passe avant l'ajout : si elle prend du retard, Rihal met le nouveau en pause."],
    ["Écouter avant de réciter", "On apprend d'abord à l'oreille, auprès d'un récitateur fiable (c'est l'idée du talaqqi). Écoute la portion au moins 3 fois en suivant le texte des yeux."],
    ["Répéter jusqu'à une lecture sans faute", "Récite avec le texte jusqu'à obtenir une lecture propre : Rihal vérifie tes madds à chaque passage. La répétition fixe la portion, le tajwid correct dès le début évite d'apprendre une erreur."],
    ["Réciter de mémoire (rappel actif)", "Le texte se cache. Le mot n'apparaît que quand tu l'as dit. Bloqué ? Touche le mot caché : c'est un indice, compté dans le bilan. Chercher dans sa mémoire, même avec effort, ancre bien mieux que relire (c'est l'effet de test, très utilisé en médecine)."],
    ["Relier les portions (rabt)", "Pour une nouvelle portion, la récitation de mémoire reprend le dernier verset de la portion précédente, pour que les pages s'enchaînent."],
    ["Revoir au bon moment (répétition espacée)", "Après chaque récitation, dis comment ça s'est passé. Rihal programme la prochaine révision : le lendemain, puis à 2, 4 et 7 jours, puis de plus en plus espacée selon ta réussite, sans jamais dépasser 2 mois. Une portion oubliée revient en révision quotidienne."],
    ["Conseils des maîtres", "Toujours le même mushaf (la mémoire visuelle de la page aide), un moment fixe (beaucoup conseillent après Fajr), réciter ce qu'on a appris dans ses prières, comprendre le sens des versets, et faire vérifier sa récitation par un professeur quand c'est possible."]
  ].forEach(([a, b]) => { m.appendChild(el("b", "h-m-t", a)); m.appendChild(el("p", "h-m-p", b)); });
  v.appendChild(m);

  v.appendChild(el("h3", "sub-h", "Sauvegarde"));
  const sv = el("div", "settings");
  sv.appendChild(el("p", "h-note", "Ton programme est enregistré sur cet appareil seulement. Exporte-le de temps en temps pour ne pas le perdre, ou pour le transférer sur un autre appareil."));
  const sa = el("div", "acts");
  const ex = el("button", "btn", "Exporter"), im = el("button", "btn", "Importer");
  const fi = el("input"); fi.type = "file"; fi.accept = "application/json,.json"; fi.hidden = true;
  ex.onclick = () => { const blob = new Blob([JSON.stringify({ app: "rihal", v: 1, hifz: hz() })], { type: "application/json" }); const a = el("a"); a.href = URL.createObjectURL(blob); a.download = `rihal-hifz-${dstr()}.json`; document.body.appendChild(a); a.click(); a.remove(); };
  im.onclick = () => fi.click();
  fi.onchange = async () => {
    const f = fi.files[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()); const d = j.hifz || j; if (!d.units || !d.log) throw 0; if (!confirm("Remplacer ton programme actuel par cette sauvegarde ?")) return; saveHz(d); renderHifz(); }
    catch (_) { alertMsg(sv, "Ce fichier n'est pas une sauvegarde Rihal."); }
  };
  sa.appendChild(ex); sa.appendChild(im); sv.appendChild(sa); sv.appendChild(fi);
  v.appendChild(sv);
}
function alertMsg(box, t) { const p = el("p", "h-tip warn", t); box.appendChild(p); setTimeout(() => p.remove(), 5000); }
function fmtDay(d, long) {
  const t = dstr(), diff = dnum(d) - dnum(t);
  if (diff === 0) return "aujourd'hui"; if (diff === 1) return "demain"; if (diff === -1) return "hier";
  const dt = new Date(d.replace(/-/g, "/"));
  return dt.toLocaleDateString("fr-FR", long ? { weekday: "long", day: "numeric", month: "long" } : { day: "numeric", month: "short" });
}

function startHifz(id, mode) {
  const h = hz(), u = h.units[id]; if (!u) return;
  const isNew = mode === "nouveau";
  let link = u.a;
  if (isNew) {
    const prev = Object.values(h.units).filter(x => x.s === u.s && x.b === u.a - 1 && (x.status === "sabqi" || x.status === "manzil"))[0];
    if (prev) link = u.a - 1;
  }
  pendingH = { id, s: u.s, mode, from: u.a - 1, to: u.b - 1, link: link - 1, step: isNew ? 0 : 2, listens: 0, passes: 0, clean: 0, hints: new Set(), t0: Date.now() };
  if (location.hash === "#s" + u.s) openSurah(u.s); else location.hash = "s" + u.s;
}

const STEPS_NEW = ["Écouter", "Répéter", "De mémoire"];
function hifzBar() {
  const b = $("hifzBar"); if (!H) { b.hidden = true; $("pages").classList.remove("masked"); return; }
  b.hidden = false; b.textContent = "";
  const top = el("div", "hb-top");
  top.appendChild(el("b", null, `${H.mode === "nouveau" ? "Nouveau" : H.mode === "sabqi" ? "Révision récente" : "Révision ancienne"} · v. ${H.from + 1}–${H.to + 1}`));
  if (H.mode === "nouveau") { const st = el("div", "hb-steps"); STEPS_NEW.forEach((s, i) => st.appendChild(el("span", "hb-step" + (i === H.step ? " on" : i < H.step ? " done" : ""), `${i + 1}. ${s}`))); top.appendChild(st); }
  b.appendChild(top);
  const txt = H.step === 0 ? `Touche « Écouter » et suis le texte des yeux. Écoute au moins 3 fois (${H.listens}/3).`
    : H.step === 1 ? `Récite avec le texte sous les yeux. Objectif : une lecture sans faute (${H.passes} lecture${H.passes > 1 ? "s" : ""}, ${H.clean} sans faute).`
    : `Texte caché : récite de mémoire${H.link < H.from ? `, en commençant par le verset ${H.link + 1} pour relier à la portion d'avant` : ""}. Bloqué ? Touche le mot caché pour le voir.`;
  b.appendChild(el("p", "hb-text", txt));
  const acts = el("div", "acts");
  if (H.mode === "nouveau" && H.step > 0) { const p = el("button", "btn", "← Étape précédente"); p.onclick = () => setHStep(H.step - 1); acts.appendChild(p); }
  if (H.step < 2) { const n = el("button", "btn primary", H.step === 0 ? "J'ai écouté → Répéter" : "Je suis prêt → De mémoire"); n.onclick = () => setHStep(H.step + 1); acts.appendChild(n); }
  else { const pk = el("button", "btn", "Tout montrer un instant"); pk.onclick = () => { $("pages").classList.remove("masked"); H.peeked = true; setTimeout(() => { if (H && H.step === 2) $("pages").classList.add("masked"); }, 2500); }; acts.appendChild(pk); }
  b.appendChild(acts);
  $("pages").classList.toggle("masked", H.step === 2);
}
function setHStep(n) {
  if (!H) return; stopAll();
  H.step = n; H.hints = new Set(); resetRange(); clearLight(); hifzBar();
  selectVerse(n === 2 ? H.link : H.from, true);
  setStatus(n === 0 ? "Touche « Écouter »." : "Touche le micro quand tu es prêt.");
}
function inRange(vi) { return H && vi >= Math.min(H.link, H.from) && vi <= H.to; }
function markRange() {
  wordEls.forEach((ws, vi) => ws.forEach(w => w.classList.toggle("out", !!H && !inRange(vi))));
  veEls.forEach((v, vi) => v && v.classList.toggle("out", !!H && !inRange(vi)));
}
function resetRange() {
  if (!H) return;
  for (let vi = Math.min(H.link, H.from); vi <= H.to; vi++) {
    results[vi] = null; usrBufs[vi] = null;
    (wordEls[vi] || []).forEach(w => { w.classList.remove("k-court", "k-long", "k-diff", "peek"); const s = w.querySelector("sup"); if (s) s.remove(); });
    if (veEls[vi]) veEls[vi].classList.remove("st-ok", "st-warn");
  }
  updateProg();
}
function rangeStats() {
  let madd = 0, diff = 0, done = 0, n = 0;
  for (let vi = Math.min(H.link, H.from); vi <= H.to; vi++) { n++; const r = results[vi]; if (!r) continue; done++; r.items.forEach(it => { if (it.kind === "diff") diff++; else if (it.kind === "court" || it.kind === "long") madd++; }); }
  return { madd, diff, done, n };
}
function logEntry(e) { const h = hz(); h.log.push({ t: Date.now(), ...e }); saveHz(h); }

function hifzFinished() {
  if (!H) return;
  const r = rangeStats();
  if (H.step === 1) {
    if (!r.done) return;
    H.passes++; if (!r.madd && !r.diff && r.done === r.n) H.clean++;
    hifzBar();
    setStatus(r.madd || r.diff ? `Lecture ${H.passes} : ${r.madd + r.diff} point${r.madd + r.diff > 1 ? "s" : ""} à corriger. Regarde les mots colorés, puis recommence.` : r.done < r.n ? `Lecture ${H.passes} : ${r.done} verset${r.done > 1 ? "s" : ""} sur ${r.n}. Va jusqu'au bout de la portion.` : `Lecture ${H.passes} sans faute ✓. Encore une fois, ou passe à « De mémoire ».`, r.madd || r.diff ? "court" : "ok");
    return;
  }
  if (H.step !== 2 || !r.done) return;
  const hints = H.hints.size + (H.peeked ? 3 : 0);
  const sug = hints >= Math.max(3, r.n) || r.done < r.n * 0.5 ? 0 : hints || r.diff ? 1 : 2;
  const h = hz(), u = h.units[H.id]; if (!u) return;
  const body = openSheet("Comment ça s'est passé ?");
  const sc = el("div", "score " + (sug >= 2 ? "good" : "warn"));
  sc.appendChild(el("div", "score-main", `${r.done}/${r.n} versets récités de mémoire`));
  const bits = [hints ? `${hints} indice${hints > 1 ? "s" : ""}` : "aucun indice", r.diff ? `${r.diff} passage${r.diff > 1 ? "s" : ""} hésitant${r.diff > 1 ? "s" : ""} ou sauté${r.diff > 1 ? "s" : ""}` : "aucun passage sauté", r.madd ? `${r.madd} madd à corriger` : "madds bien tenus"];
  sc.appendChild(el("div", "score-sub", bits.join(" · ")));
  body.appendChild(sc);
  body.appendChild(el("p", "fix", `Note ta récitation honnêtement : Rihal s'en sert pour choisir le jour de la prochaine révision. Suggestion : « ${GRADES[sug][0]} ».`));
  const g = el("div", "h-grades");
  GRADES.forEach(([lab, sub], k) => {
    const b = el("button", "h-grade g" + k + (k === sug ? " sug" : ""));
    if (u.status === "queue") u.status = "learn";
    const iv = previewIv(u, k);
    b.appendChild(el("b", null, lab)); b.appendChild(el("span", null, sub)); b.appendChild(el("em", null, iv <= 1 ? "revient demain" : `revient dans ${iv} j`));
    b.onclick = () => {
      const hh = hz(), uu = hh.units[H.id]; if (uu.status === "queue") uu.status = "learn";
      schedule(uu, k); saveHz(hh);
      logEntry({ s: H.s, a: H.from + 1, b: H.to + 1, mode: H.mode, min: Math.min(120, (Date.now() - H.t0) / 6e4), hints, madd: r.madd, diff: r.diff, g: k });
      closeSheet(); H = null; if (S) S.t0 = 0; location.hash = "hifz";
    };
    g.appendChild(b);
  });
  body.appendChild(g);
  const again = el("button", "btn", "Recommencer de mémoire"); again.onclick = () => { closeSheet(); H.peeked = false; setHStep(2); };
  body.appendChild(again);
}

function logFree() {
  if (!S || H || calibMode || !S.t0) return;
  const done = results.map((r, i) => r ? i : -1).filter(i => i >= 0 && !(S.logged || new Set()).has(i));
  if (!done.length) return;
  S.logged = S.logged || new Set(); done.forEach(i => S.logged.add(i));
  let madd = 0, diff = 0; done.forEach(i => results[i].items.forEach(it => { if (it.kind === "diff") diff++; else if (it.kind === "court" || it.kind === "long") madd++; }));
  logEntry({ s: S.id, a: S.v[done[0]].n, b: S.v[done[done.length - 1]].n, mode: "libre", min: Math.min(120, (Date.now() - S.t0) / 6e4), madd, diff });
  S.t0 = Date.now();
}

/* ---------- reconnaissance vocale (reco.js) : modèle entraîné sur des dizaines de milliers de récitations, sur l'appareil ---------- */
const AS = { w: null, state: "off", loaded: 0, total: 0, err: "", step: "" };
const asrReady = () => AS.state === "ready";
const awCache = new Map(); // "sourate:verset" -> mots du verset tels que le modèle les connaît
function asrInit() {
  if (AS.w) return;
  try { AS.w = new Worker("reco.js?v=8", { type: "module" }); }
  catch (e) { AS.state = "error"; AS.err = "ce navigateur ne permet pas la reconnaissance vocale"; asrUi(); return; }
  AS.state = "loading"; AS.loaded = 0; AS.total = 0; AS.step = ""; asrUi();
  // le son part directement du fil d'analyse vers la reconnaissance, sans passer par l'écran
  const ch = new MessageChannel();
  worker.postMessage({ t: "asrPort", port: ch.port1 }, [ch.port1]);
  AS.w.postMessage({ t: "port", port: ch.port2 }, [ch.port2]);
  AS.w.onmessage = e => onReco(e.data);
  AS.w.onerror = ev => { if (AS.state === "ready") return; AS.state = "error"; AS.err = (ev && ev.message) || "chargement impossible"; if (AS.w) AS.w.terminate(); AS.w = null; asrUi(); };
  AS.w.postMessage({ t: "init", ortUrl: window.__RIHAL_ORT_URL || null });
}
function asrOff() { if (AS.w) AS.w.terminate(); AS.w = null; AS.state = "off"; worker.postMessage({ t: "asrPort" }); }
function recoHint(s, vi) { if (AS.w) AS.w.postMessage({ t: "hint", s: s || 0, a: (vi || 0) + 1 }); }
function onReco(m) {
  if (m.t === "progress") { AS.loaded = m.loaded; AS.total = m.total; AS.step = m.step || ""; asrUi(); return; }
  if (m.t === "ready") { AS.state = "ready"; asrUi(); return; }
  if (m.t === "error") { asrOff(); AS.state = "error"; AS.err = m.msg; asrUi(); return; }
  if (m.t === "perf") { AS.speed = m.x; asrUi(); return; }
  if (m.t === "slow") { if (rec) setStatus("Ta tablette a du mal à suivre la reconnaissance : je me recale sur le son récent.", "court"); return; }
  if (m.t === "fail") { if (rec && rec.scanning) scanFail("La reconnaissance vocale s'est arrêtée (" + m.msg + ")."); return; }
  if (m.aw && m.aw.length) awCache.set(m.s + ":" + m.a, m.aw);
  if (!rec) return;
  if (m.t === "loc") onLocated(m);
  else if (m.t === "pos") onRecoPos(m);
}
const mb = n => Math.round(n / 1e6);
function asrUi() {
  const box = $("asrCard"); if (!box) return;
  box.textContent = "";
  const t = el("div", "asr-t");
  t.appendChild(el("b", null, "Reconnaissance automatique"));
  const sub = el("span");
  const acts = el("div", "acts");
  if (AS.state === "ready") {
    sub.textContent = "Prête ✓ — appuie sur « Réciter » ou sur le micro : Rihal trouve la sourate et le verset, puis te suit mot à mot." + (AS.speed ? ` (Calcul ${AS.speed}× plus rapide que ta voix sur cet appareil.)` : "");
    const off = el("button", "btn ghost", "Désactiver"); off.onclick = () => { saveSettings({ asr: false }); asrOff(); asrUi(); }; acts.appendChild(off);
  } else if (AS.state === "loading") {
    sub.textContent = AS.step === "engine" ? "Mise en route du moteur de reconnaissance…" : AS.total ? `Téléchargement du modèle : ${mb(AS.loaded)} / ${mb(AS.total)} Mo. Laisse la page ouverte, ça ne se fait qu'une fois.` : "Préparation du modèle…";
    const bar = el("div", "h-prog"); const f = el("i"); f.style.width = (AS.total ? Math.max(2, AS.loaded / AS.total * 100) : 3).toFixed(1) + "%"; bar.appendChild(f); t.appendChild(sub); t.appendChild(bar);
    box.appendChild(t); updateAutoBtn(); return;
  } else if (AS.state === "error") {
    sub.textContent = "Le modèle n'a pas pu se charger (" + AS.err + "). Vérifie ta connexion et réessaie. Le reste de l'application fonctionne normalement.";
    const b = el("button", "btn primary", "Réessayer"); b.onclick = () => { AS.state = "off"; asrInit(); }; acts.appendChild(b);
  } else {
    sub.textContent = "Récite sans rien choisir : Rihal reconnaît la sourate, le verset et le mot, puis vérifie en continu qu'il te suit bien. Tout se passe sur ta tablette. Un seul téléchargement d'environ 85 Mo (Wi-Fi conseillé).";
    const b = el("button", "btn primary", "Activer"); b.onclick = enableAsr; acts.appendChild(b);
  }
  t.appendChild(sub); box.appendChild(t); box.appendChild(acts);
  box.classList.toggle("done", AS.state === "ready");
  updateAutoBtn();
}
function enableAsr() { saveSettings({ asr: true }); asrInit(); asrUi(); }
function openAsrSheet() {
  const body = openSheet("Réciter sans choisir");
  body.appendChild(el("p", "fix", "Pour reconnaître tout seul la sourate et le verset, Rihal utilise un modèle de reconnaissance entraîné sur des dizaines de milliers de récitations : récitateurs connus, mais aussi débutants enregistrés au téléphone. Il fonctionne directement sur ta tablette, sans envoyer ta voix sur internet."));
  body.appendChild(el("p", "fix", AS.state === "loading" ? "Il est en cours de téléchargement : tu peux suivre l'avancement sur l'accueil." : "Il faut le télécharger une seule fois (environ 85 Mo, Wi-Fi conseillé). Ensuite, il marche même hors connexion."));
  body.appendChild(el("p", "h-note", "Modèle : Quran-Lab, affiné par le projet libre Tilawa (licence NPL-1.2, usage gratuit)."));
  if (AS.state !== "loading") { const b = el("button", "btn primary", AS.state === "error" ? "Réessayer le téléchargement" : "Télécharger et activer"); b.onclick = () => { closeSheet(); if (AS.state === "error") AS.state = "off"; enableAsr(); }; body.appendChild(b); }
}
function updateAutoBtn() {
  const s = $("autoSub"); if (!s) return;
  s.textContent = asrReady() ? "Appuie et récite : Rihal trouve la sourate et le verset." : AS.state === "loading" ? "Préparation de la reconnaissance vocale…" : "Active la reconnaissance automatique pour réciter sans choisir.";
}

/* ---------- navigation ---------- */
function route() {
  logFree();
  const m = location.hash.match(/^#s(\d+)$/);
  $("hifz").hidden = true;
  if (m) openSurah(+m[1]);
  else if (location.hash === "#etalonnage") { pendingH = null; openSurah(1, true); }
  else {
    stopAll(); S = null; H = null; calibMode = false; $("surah").hidden = true; $("dock").hidden = true; closeSheet(); $("hifzBar").hidden = true;
    if (location.hash === "#hifz") { $("home").hidden = true; $("hifz").hidden = false; renderHifz(); }
    else { $("home").hidden = false; renderHome(); }
    window.scrollTo(0, 0);
  }
}

$("q").addEventListener("input", renderHome);
$("back").addEventListener("click", () => { location.hash = ""; });
$("calibBtn").addEventListener("click", () => { location.hash = "etalonnage"; });
$("pages").addEventListener("click", e => {
  const ve = e.target.closest(".ve");
  if (ve) { const vi = +ve.dataset.v; if (results[vi]) openVerse(vi); else if (rec) worker.postMessage({ t: "goto", i: vi, w: 0 }); else selectVerse(vi); return; }
  const w = e.target.closest(".w");
  if (!w) return;
  if (H && H.step === 2 && !w.classList.contains("done") && !w.classList.contains("on") && !w.classList.contains("peek") && inRange(+w.dataset.v)) {
    w.classList.add("peek"); H.hints.add(w.dataset.v + ":" + w.dataset.w);
    if (!rec) return;
  }
  if (rec && !(calibMode && !rec.calibGo)) { worker.postMessage({ t: "goto", i: +w.dataset.v, w: +w.dataset.w }); return; }
  if (!listen && !calibMode) { selectVerse(+w.dataset.v); setStatus(`Départ : verset ${S.v[+w.dataset.v].n}. Touche le micro ou Écouter.`); }
});
$("mic").addEventListener("click", () => rec ? stopRec() : startRec());
$("autoBtn").addEventListener("click", startAuto);
$("listen").addEventListener("click", () => listen ? stopListen() : (S && playFrom(H ? (cur >= H.from && cur <= H.to ? cur : H.from) : cur)));
$("report").addEventListener("click", openReport);
$("restart").addEventListener("click", () => { if (rec) worker.postMessage({ t: "restart" }); });
$("recBtn").addEventListener("click", openRecPicker);
$("recSel").addEventListener("change", e => { saveSettings({ rec: +e.target.value }); });
$("multi").addEventListener("change", e => { saveSettings({ multi: e.target.checked }); });
$("sheetClose").addEventListener("click", closeSheet);
$("sheet").addEventListener("click", e => { if (e.target === $("sheet")) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
window.addEventListener("hashchange", route);

if (settings().asr || window.__RIHAL_ORT_URL) asrInit(); else asrUi();
loadChapters().then(c => {
  chapters = c || COUNTS.map((n, i) => ({ id: i + 1, n: "Sourate " + (i + 1), a: "", fr: "", c: n }));
  if (!c) setTimeout(() => { const g = $("grid"); if (g) g.prepend(el("p", "empty", "Noms des sourates indisponibles hors ligne pour l'instant.")); }, 0);
  route();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
