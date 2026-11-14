// sw.js (served at /apps/sw.js): lets the Engine & Vehicle Logbook and the
// Project Tracker open with no signal, out in the garage. Registered by those
// two pages (scripts/import-logbook.mjs). The records themselves are kept
// offline by Firestore (window.__gtOfflineCache); this keeps the pages.
//
//   - The two pages: network first, saved copy when offline.
//   - /assets/* (the site's built code, named by content so never stale):
//     saved copy first.
//   - /__/firebase/init.json (the site's Firebase settings): network first,
//     saved copy when offline, so sign-in and the database can start.
// Every other request, and every other page under /apps/, passes straight through.
//
// Bump CACHE whenever this file changes so old copies are cleared.
const CACHE = 'gt-apps-v1';
const PAGES = ['/apps/logbook', '/apps/project-tracker'];
const pageKey = (path) => PAGES.find((p) => path === p || path === p + '/' || path === p + '/index.html');

/** Saves a page and the /assets/ files it uses. */
async function savePage(cache, path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put(path, res);
  const assets = [...new Set(html.match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g) || [])];
  await Promise.all(assets.map((a) => cache.add(a).catch(() => {})));
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all([...PAGES.map((p) => savePage(c, p).catch(() => {})), c.add('/__/firebase/init.json').catch(() => {})]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('gt-apps-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function networkFirst(request, key) {
  return fetch(request)
    .then((res) => {
      if (res.ok && !res.redirected) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    })
    .catch(() => caches.match(key).then((hit) => hit || new Response("You're offline, and this page hasn't been saved for offline use yet.", {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })));
}

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;

  if (r.mode === 'navigate') {
    const key = pageKey(u.pathname);
    if (key) e.respondWith(networkFirst(r, key));
    return;
  }
  if (u.pathname === '/__/firebase/init.json') {
    e.respondWith(networkFirst(r, u.pathname));
    return;
  }
  if (u.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(r).then((hit) => hit || fetch(r).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); }
      return res;
    })));
  }
});
