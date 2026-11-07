// AEGIS Wallet Service Worker v1.8 — offline PWA (app shell cache)
const CACHE = "aegis-wallet-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/index.html", "/manifest.webmanifest"])));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return; // mutating (POST RPC) — network only
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html"))));
});
