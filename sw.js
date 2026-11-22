// Service worker: versioned, atomic, immutable shell cache.
// - install stages every allowlisted shell URL via one atomic addAll; a single
//   failed fetch aborts the whole install and any previous version keeps
//   serving.
// - fetches are served cache-first from THIS worker's cache only, and only for
//   exact scope-resolved allowlisted URLs. Nothing is ever written into the
//   cache at fetch time, so an old HTML can never mix with new JS.
// - activation waits for the app's explicit SKIP_WAITING message (the app
//   gates that on user confirmation outside an active quiz).
// - imported textbook packages are never requested or cached over HTTP.

const VERSION = "836b339a150e";
const CACHE = `agri-shell-${VERSION}`;
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "dom.js",
  "core.js",
  "storage.js",
  "package.js",
  "timer.js",
  "sw.js",
  "style.css",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
];
const SHELL_URLS = new Set(SHELL.map(s => new URL(s, self.registration.scope).href));
const INDEX_URL = new URL("index.html", self.registration.scope).href;

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll([...SHELL_URLS]))
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k.startsWith("agri-shell-") && k !== CACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (req.mode === "navigate") {
    // Offline-first navigation: own cache only, never revalidated.
    e.respondWith(
      caches.open(CACHE).then(c => c.match(INDEX_URL)).then(hit => hit || fetch(req))
    );
    return;
  }
  if (!SHELL_URLS.has(req.url)) return; // not our shell — leave to network
  e.respondWith(caches.open(CACHE).then(c => c.match(req)).then(hit => hit || fetch(req)));
});

self.addEventListener("message", e => {
  const data = e.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "CHECK_CACHE") {
    const port = e.ports[0];
    (async () => {
      const cache = await caches.open(CACHE);
      const results = await Promise.all([...SHELL_URLS].map(async u => !!(await cache.match(u))));
      port?.postMessage({ ok: results.every(Boolean) });
    })();
  }
});
