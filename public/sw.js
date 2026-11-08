/*
 * Uravu service worker: makes the app open fast and work as an installed app.
 *
 * It only caches the app's own files (pages, scripts, icons). Family data from
 * Neon is never cached here: it always comes fresh from the database, so
 * nothing private is left on the phone by this file.
 */
const CACHE = "uravu-v1";
const SHELL = ["/", "/auth.html", "/manifest.webmanifest", "/favicon.svg",
               "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// /login, /signup and /join/<token> are all auth.html (see render.yaml)
const pageKey = path => (/^\/(login|signup)\/?$/.test(path) || path.startsWith("/join/") ? "/auth.html" : "/");

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;   // Neon calls go straight through

  // Pages: always try the network first so new versions show up; fall back offline
  if (req.mode === "navigate") {
    const key = pageKey(url.pathname);
    event.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
        return res;
      }).catch(() => caches.match(key)));
    return;
  }

  // Built files have a content hash in their name, so a cached copy is always right
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Icons, manifest: use the cached copy, refresh it in the background
  event.respondWith(caches.match(req).then(hit => {
    const fresh = fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
