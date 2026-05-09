// Module de récupération d'infos Instagram côté client
// Sources / proxys testés (par ordre de fiabilité) :
//   - Microlink (free) : 50 req/jour, retourne OG image (= profile pic) + meta
//   - r.jina.ai          : proxy markdown, peut extraire les liens d'images
//   - corsproxy.io       : proxy générique
//   - allorigins.win     : proxy générique
// Instagram bloque le scraping authentifié — on fait au mieux avec ce qui est public.

import { getMeta, setMeta } from './store.js';

const MICROLINK_BASE = 'https://api.microlink.io/';
const PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

// ============= PROFILE PIC =============

export async function fetchInstagramProfilePic(handle) {
  if (!handle) throw new Error('Handle vide');
  const cleanHandle = handle.replace(/^@/, '').trim();
  if (!cleanHandle) throw new Error('Handle invalide');

  const profileUrl = `https://www.instagram.com/${cleanHandle}/`;

  // 1) Microlink (gratuit, fiable, rate-limit 50/jour anonyme)
  try {
    const res = await fetch(`${MICROLINK_BASE}?url=${encodeURIComponent(profileUrl)}&meta=true`, {
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      const img = data?.data?.image?.url || data?.data?.logo?.url;
      if (img) return { url: img, source: 'microlink' };
    }
  } catch (e) { /* try next */ }

  // 2) Proxy + parse OG meta tag
  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy(profileUrl), { headers: { 'Accept': 'text/html' } });
      if (!res.ok) continue;
      const html = await res.text();
      const match = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
        || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
      if (match) return { url: match[1], source: proxy.name || 'proxy' };
    } catch (e) { /* try next */ }
  }

  throw new Error('Impossible de récupérer la photo de profil. Le profil est peut-être privé ou inaccessible.');
}

// ============= 9 DERNIÈRES IMAGES =============

export async function fetchInstagramRecentPosts(handle, limit = 9) {
  if (!handle) throw new Error('Handle vide');
  const cleanHandle = handle.replace(/^@/, '').trim();
  const profileUrl = `https://www.instagram.com/${cleanHandle}/`;

  // Essai des proxys pour récupérer le HTML / JSON de la page
  let html = null;
  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy(profileUrl));
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.length > 1000) {
        html = text;
        break;
      }
    } catch (e) { /* try next */ }
  }
  if (!html) throw new Error('Aucun proxy n’a pu récupérer le HTML du profil. Réessayez plus tard.');

  // Instagram embarque parfois un JSON-LD ou un objet Preloaded
  const images = [];

  // Méthode 1 : tags <meta property="og:image"> additionnels
  const ogImages = [...html.matchAll(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/gi)].map(m => m[1]);
  if (ogImages.length) images.push(...ogImages);

  // Méthode 2 : extraire les URLs d'images CDN Instagram (scontent.cdninstagram, instagram.fxxx-...)
  const cdnRegex = /https:\/\/(?:scontent|instagram)[a-z0-9.\-]*\.cdninstagram\.com\/[^"'<>\s]+\.(?:jpg|jpeg|webp|png)/gi;
  const cdnMatches = [...new Set(html.match(cdnRegex) || [])];
  if (cdnMatches.length) images.push(...cdnMatches);

  // Dédup
  const unique = [...new Set(images)].filter(u => !u.includes('s150x150') && !u.includes('s320x320'));
  if (!unique.length) throw new Error('Aucune image trouvée — le profil est peut-être privé, vide, ou Instagram bloque le proxy.');

  return unique.slice(0, limit).map(url => ({ url, source: 'proxy-html' }));
}

// ============= TÉLÉCHARGER UNE IMAGE EN BLOB =============

export async function fetchImageAsBlob(url) {
  // Tenter direct, puis via proxy si CORS bloque
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (res.ok) return await res.blob();
  } catch (e) { /* fallback */ }

  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy(url));
      if (res.ok) {
        const blob = await res.blob();
        if (blob && blob.size > 0) return blob;
      }
    } catch (e) { /* try next */ }
  }
  throw new Error('Impossible de télécharger l’image (CORS ou bloquée).');
}

// ============= VÉRIFIER LA CONFIG =============

export async function getIgFetchEnabled() {
  const v = await getMeta('ig_fetch_enabled');
  return v !== false; // par défaut activé
}

export async function setIgFetchEnabled(v) {
  await setMeta('ig_fetch_enabled', !!v);
}
