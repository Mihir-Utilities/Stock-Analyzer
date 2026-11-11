// Service worker: caches the app shell only (docs/06 section 1). It never stores an API response,
// an HTML page or anything that carries owner data; those always go to the network. What it keeps:
//   - the offline fallback page and the icons (precached);
//   - Next's content-hashed static files under /_next/static/ (immutable; cache first).
// A failed page navigation shows /offline.html. The cache name carries the build id (the page
// registers /sw.js?v=<build id>), so a new deploy opens a new cache and `activate` deletes every
// other one: files of old builds never pile up. Kill switch: docs/RUNBOOK.md section 80.
const BUILD = (new URLSearchParams(self.location.search || "").get("v") || "dev").replace(
  /[^A-Za-z0-9._-]/g,
  "",
);
const VERSION = `shell-${BUILD || "dev"}`;
const PRECACHE = ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png"];

const OFFLINE_FALLBACK = () =>
  new Response("You are offline. Not investment advice.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** True for requests the worker may answer from its cache. */
function isShellAsset(url) {
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cached, never intercepted

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match("/offline.html").then((hit) => hit || OFFLINE_FALLBACK()),
      ),
    );
    return;
  }
  if (isShellAsset(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
