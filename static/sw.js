/* Sign & Send — service worker (installable app + offline shell) */
"use strict";

const CACHE = "sign-and-send-v9";
const SHELL = [
  "/",
  "/static/styles.css?v=9",
  "/static/app.js?v=9",
  "/static/vendor/pdf.min.js",
  "/static/vendor/pdf.worker.min.js",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/manifest.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API, uploads and generated files always go to the network
  if (e.request.method !== "GET" ||
      url.pathname.startsWith("/api/") || url.pathname.startsWith("/files/")) return;

  // network-first: fresh when online, cached copy when offline
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("/")))
  );
});
