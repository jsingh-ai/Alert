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
 * It also shows call notifications (Web Push): the server encrypts each one for this device,
 * and tapping it opens the app on the page it names.
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

/* ---------- Call notifications ---------- */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const silent = Boolean(data.silent);
  event.waitUntil(
    self.registration.showNotification(data.title || "ProcessGuard", {
      body: data.body || "",
      // One notification per call: a later update (accepted) replaces it instead of stacking
      tag: data.tag || undefined,
      renotify: Boolean(data.tag) && !silent,
      silent,
      vibrate: silent ? undefined : [200, 100, 200, 100, 200],
      icon: "/icons/icon-192.png",
      timestamp: Date.now(),
      data: { url: data.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const ours = windows.filter((client) => new URL(client.url).origin === self.location.origin);
      // Already on that page: just bring it forward. Otherwise use an open window, or open one.
      const exact = ours.find((client) => new URL(client.url).pathname === target.pathname);
      if (exact) return exact.focus();
      if (ours[0]) {
        const client = await ours[0].focus();
        return client && "navigate" in client ? client.navigate(target.href).catch(() => undefined) : undefined;
      }
      return self.clients.openWindow(target.href);
    })()
  );
});
