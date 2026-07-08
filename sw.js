// Service worker — network-first pour les pages HTML (évite les ghost old data
// après déploiement), cache-first pour CSS/JS statiques avec version-busting.
const VERSION = 'trombinoscope-v58';
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
  './js/auth.js',
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

  // HTML + JS + CSS + manifest → NETWORK-FIRST : on prend toujours la version
  // fraîche du serveur, le cache ne sert que de secours hors-ligne. Ça élimine
  // définitivement le risque de "modules JS incompatibles servis depuis le
  // cache" (nouveau app.js + ancien cloud.js caché = page blanche).
  const isCode = req.mode === 'navigate' || req.destination === 'document'
    || req.destination === 'script' || req.destination === 'style'
    || req.destination === 'manifest'
    || /\.(?:js|mjs|css|webmanifest)(?:\?|$)/.test(url.pathname + url.search);

  if (isCode) {
    // cache:'reload' → on court-circuite le cache HTTP du navigateur (GitHub
    // Pages met max-age=600) : sinon un nouvel app.js pouvait charger un ancien
    // cloud.js/store.js resté en cache HTTP jusqu'à 10 min → modules ES
    // incompatibles = page blanche. On veut TOUJOURS la version réseau fraîche.
    const isNav = req.mode === 'navigate' || req.destination === 'document';
    let fresh;
    try { fresh = new Request(req, { cache: 'reload' }); } catch { fresh = req; }
    e.respondWith(
      fetch(fresh).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(async () => {
        // Hors-ligne : match exact (URL versionnée ?v=NN, cache runtime), puis
        // en ignorant la query (precache non versionné). Pour un JS/CSS on ne
        // renvoie JAMAIS index.html (HTML pour un module = « MIME text/html »
        // → page blanche) : on renvoie une vraie erreur. index.html n'est un
        // repli que pour une navigation.
        const hit = (await caches.match(req)) || (await caches.match(req, { ignoreSearch: true }));
        if (hit) return hit;
        if (isNav) return (await caches.match('./index.html')) || Response.error();
        return new Response('/* offline */', { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain' } });
      })
    );
    return;
  }

  // Autres (images, etc.) : cache-first, simple.
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
