// Mint service worker: app shell cached up front, network first with cache
// fallback so the shell opens offline. API data is cached by the page itself
// (localStorage), so /api is left alone here. The version is stamped by the
// server from the asset contents, so each deploy installs a fresh worker.
const CACHE = 'mint-__V__';
// Merchant logos live in their own cache, so a deploy does not throw them away.
// Each URL carries ?v=<hash of the image>, so a cached copy is never stale; the
// cap drops the oldest once there are more than LOGO_MAX.
const LOGOS = 'mint-logos';
const LOGO_MAX = 400;
const SHELL = ['/', '/style.css?v=__V__', '/kit/kit.css?v=__V__', '/kit-boot.js?v=__V__', '/kit/kit.js?v=__V__', '/kit/fonts/geist-latin.woff2', '/kit/icons.svg', __SHELL_SCRIPTS__, '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];
const TABS = __TAB_PATHS__;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== LOGOS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
async function logoFirst(request) {
  const cache = await caches.open(LOGOS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Only a real image from this origin: never a gate redirect or an error page.
  if (res.ok && !res.redirected && res.type === 'basic' && /^image\//.test(res.headers.get('content-type') ?? '')) {
    await cache.put(request, res.clone());
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - LOGO_MAX)).map((k) => cache.delete(k)));
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && url.origin === location.origin && url.pathname.startsWith('/api/logo/')) {
    e.respondWith(logoFirst(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const isTab = e.request.mode === 'navigate' && TABS.includes(url.pathname);
  e.respondWith(
    fetch(e.request).then((res) => {
      // Never cache a gate redirect or error page in place of the app.
      if (res.ok && !res.redirected && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(isTab ? '/' : e.request, copy));
      }
      return res;
    }).catch(() => caches.match(isTab ? '/' : e.request))
  );
});
