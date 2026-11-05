/*
 * ProcessGuard service worker.
 *
 * Makes the app installable and lets an installed window open while the server is briefly
 * unreachable (restart, deploy, Wi-Fi blip). It caches only the app's own files:
 *   - page loads: network first, falling back to the last good copy of the app shell
 *   - /assets/*  : cache first (Vite fingerprints these, so a name never changes content)
 *   - /icons/*, manifest: served from cache, refreshed in the background
 * Live data is never cached: /api and /socket.io always go straight to the network.
 *
 * Bump VERSION to drop every cache from the previous version on the next visit.
 */
const VERSION = "pg-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const SHELL_KEY = "/";
const MAX_ASSETS = 80;
const NAVIGATION_TIMEOUT_MS = 5000;

const PRECACHE = [
  SHELL_KEY,
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/favicon-32.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(`${VERSION}-`)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request, event));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirstAsset(request));
  } else if (url.pathname.startsWith("/icons/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});

/** Every route serves the same index.html, so one cached copy covers /operator, /queue, /floor... */
async function networkFirstShell(request, event) {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok && (response.headers.get("content-type") || "").includes("text/html")) {
      event.waitUntil(cache.put(SHELL_KEY, response.clone()));
    }
    return response;
  });

  const cached = await cache.match(SHELL_KEY);
  if (!cached) return network;

  // Prefer the server, but don't leave a station on a blank or error screen while it is down or slow.
  const fromNetwork = network.then(
    (response) => (response.status >= 500 ? cached : response),
    () => cached
  );
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NAVIGATION_TIMEOUT_MS));
  return Promise.race([fromNetwork, timeout]);
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    trimCache(cache, MAX_ASSETS);
  }
  return response;
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return refresh;
}

/** Old fingerprinted bundles pile up across deploys; keep only the most recent ones. */
async function trimCache(cache, max) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((key) => cache.delete(key)));
}
