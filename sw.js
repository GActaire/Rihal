// Rihal — fonctionne hors ligne une fois ouvert
const CACHE = "rihal-v8";
const MODELS = "rihal-models-v1"; // modèle de reconnaissance (géré par reco.js) + moteur onnxruntime
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.2/";
const SHELL = ["./", "index.html", "app.js?v=8", "worker.js?v=8", "engine.js?v=8", "search.js?v=8", "reco.js?v=8", "manifest.json", "favicon.svg", "logo192.png", "logo512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => {
  // on garde le modèle ; l'ancien modèle (v7, transformers) et les anciennes versions sont supprimés pour libérer de la place
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== MODELS).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  // moteur de calcul (onnxruntime) : gardé sur l'appareil pour marcher hors ligne
  if (u.href.startsWith(ORT)) {
    e.respondWith(caches.open(MODELS).then(c => c.match(e.request).then(m => m || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }))));
    return;
  }
  if (u.origin !== location.origin) return;
  if (u.pathname.includes("/models/")) return; // gros fichiers : reco.js s'en occupe (cache dédié)
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); } return r; })
      .catch(() => caches.match(e.request).then(m => m || caches.match("index.html")))
  );
});
