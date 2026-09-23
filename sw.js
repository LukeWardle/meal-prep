/* Service worker: the app opens in a shop with no signal.
 *
 * Everything you save lives in localStorage, not here. This only caches the
 * app's own files. Network first, but only for a couple of seconds, then the
 * cached copy. Bump CACHE when the files change.
 */

const CACHE = "mealprep-9f68ae9a33";
const SHELL = [
  "./",
  "./index.html",
  "./logic.js",
  "./meals-data.json",
  "./app.js",
  "./style.css",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];
const NETWORK_WAIT_MS = 2500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("slow")), NETWORK_WAIT_MS);
    // "no-cache" asks GitHub whether the file changed, instead of reusing the
    // browser's copy for up to 10 minutes after an update.
    // A page load (mode "navigate") can't be copied with new options, so rebuild it from its URL.
    const fresh = request.mode === "navigate"
      ? new Request(request.url, { cache: "no-cache" })
      : new Request(request, { cache: "no-cache" });
    fetch(fresh).then((res) => {
      clearTimeout(timer);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      resolve(res);
    }, (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fromNetwork(event.request).catch(() =>
      caches.match(event.request, { ignoreSearch: true })
        .then((hit) => hit || caches.match("./index.html")))
  );
});
