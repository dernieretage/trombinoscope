// Service worker — network-first pour les pages HTML (évite les ghost old data
// après déploiement), cache-first pour CSS/JS statiques avec version-busting.
const VERSION = 'trombinoscope-v42';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/store.js',
  './js/seed.js',
  './js/ui.js',
  './js/utils.js',
  './js/ig.js',
  './js/sync.js',
  './js/cloud.js',
  './js/ai.js',
  './js/enrichment.js',
  './js/qr.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS).catch(() => null)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // bypass pour autres origines (Google Fonts, GitHub API, etc.) — réseau direct
  if (url.origin !== location.origin) return;

  // Navigations (HTML) → network-first : évite les "ghost old UI" après deploy.
  // Si offline, fallback sur le cache.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Assets statiques (CSS/JS/manifest) : cache-first avec MAJ en background.
  // ignoreSearch:false → respecte ?v=xxx pour bust le cache.
  e.respondWith(
    caches.match(req, { ignoreSearch: false }).then(cached => {
      if (cached) {
        // Stale-while-revalidate : revalider en background sans bloquer
        fetch(req).then(res => {
          if (res.ok) caches.open(VERSION).then(c => c.put(req, res));
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then(res => {
        if (res.ok && (req.destination === 'script' || req.destination === 'style' || req.destination === 'manifest')) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
