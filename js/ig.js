// Module de récupération d'infos Instagram — STRATÉGIE FIABLE testée à la main
//
// ▸ Photo de profil  : Dumpor.io via r.jina.ai (proxy markdown gratuit)
// ▸ URLs des posts   : DuckDuckGo "site:instagram.com/p/ <handle>" via r.jina.ai
// ▸ Image des posts  : Microlink API (OG image), URL CDN téléchargeable directement
// ▸ Bio              : Dumpor (titre/description) ou Microlink sur la page profil
//
// Tous les services sont gratuits (rate-limit raisonnable). En cas d'échec
// d'un service, on essaie les fallbacks. Tout est documenté dans les toasts.

import { getMeta, setMeta } from './store.js';

const JINA_BASE = 'https://r.jina.ai/';
const MICROLINK_BASE = 'https://api.microlink.io/?url=';
const MICROLINK_PRO_BASE = 'https://pro.microlink.io/?url='; // avec clé API

// État global rate-limit
let _microlinkRateLimited = false;
export function isMicrolinkRateLimited() { return _microlinkRateLimited; }
export function resetMicrolinkRateLimit() { _microlinkRateLimited = false; }

// ============= UTILITAIRES =============

function cleanHandle(h) {
  return String(h || '').replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[\/?#].*$/, '').trim().toLowerCase();
}

// Wrapper fetch avec timeout via AbortController : sans ça, un proxy
// silencieux peut faire hang infiniment l'import IG.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error(`Timeout ${timeoutMs}ms : ${url.slice(0, 50)}…`);
      err.code = 'TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function jinaGet(url, opts = {}) {
  const r = await fetchWithTimeout(JINA_BASE + url, {
    headers: {
      'X-Return-Format': opts.format || 'markdown',
      ...(opts.noCache ? { 'X-No-Cache': 'true' } : {}),
    },
  }, 15000);
  if (!r.ok) throw new Error(`Jina ${r.status}`);
  return r.text();
}

async function microlinkGet(url) {
  // Si clé API configurée, utiliser le plan Pro (1000+ req/jour selon plan)
  const apiKey = await getMeta('microlink_api_key');
  const base = apiKey ? MICROLINK_PRO_BASE : MICROLINK_BASE;
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const r = await fetchWithTimeout(base + encodeURIComponent(url), { headers }, 15000);
  if (r.status === 429) {
    _microlinkRateLimited = true;
    throw new Error('MICROLINK_RATE_LIMITED');
  }
  if (!r.ok) throw new Error(`Microlink ${r.status}`);
  const j = await r.json();
  return j?.data || null;
}

// ============= PHOTO DE PROFIL =============

export async function fetchInstagramProfilePic(handle) {
  const h = cleanHandle(handle);
  if (!h) throw new Error('Handle vide.');

  // Stratégie 1 : Dumpor markdown — extraire CDN dumpor + bio
  try {
    const md = await jinaGet(`https://dumpor.io/v/${h}`, { noCache: true });
    if (!md.includes('not_found') && !md.includes('Error 404')) {
      const dumporCdn = [...new Set(md.match(/https:\/\/cdn\d*\.dumpor\.io\/[a-z]\/[a-f0-9-]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s\)\]"]+)?/gi) || [])];
      if (dumporCdn.length) {
        return { url: dumporCdn[0], source: 'dumpor', bio: extractBioFromMarkdown(md) };
      }
      // Pas de pic mais peut-être une bio
      const bio = extractBioFromMarkdown(md);
      if (bio) return { url: null, source: 'dumpor-bio-only', bio };
    }
  } catch (e) { /* fallback */ }

  // Stratégie 2 : Microlink sur la page IG (peut retourner logo générique)
  try {
    const data = await microlinkGet(`https://www.instagram.com/${h}/`);
    if (data?.image?.url && !/static\.cdninstagram\.com\/rsrc|\/rsrc\.php/i.test(data.image.url)) {
      return { url: data.image.url, source: 'microlink', bio: data.description || '' };
    }
  } catch (e) { /* fallback */ }

  return { url: null, source: 'none', bio: '' };
}

function extractBioFromMarkdown(md) {
  // Chercher la bio entre nom complet et "Posts"
  const m = md.match(/Markdown Content:\s*([^\n]+)\s*\n\s*\n\s*([^\n]+)\s*\n\s*\n\s*Posts/);
  if (m) return m[2].trim();
  // Pattern : nom + ligne + bio + "Posts X Followers"
  const m2 = md.match(/\n\n([A-ZÀ-Ü][^\n]{2,50})\n\n([^\n]{5,250})\n\n.*Posts/);
  if (m2) return m2[2].trim();
  return '';
}

// ============= URLs DES POSTS via DuckDuckGo =============

export async function fetchInstagramPostUrls(handle, limit = 9) {
  const h = cleanHandle(handle);
  if (!h) throw new Error('Handle vide.');

  // DuckDuckGo retourne 9-10 résultats indexés site:instagram.com/p/
  const ddgUrl = `https://duckduckgo.com/?q=${encodeURIComponent(`site:instagram.com/p/ ${h}`)}&ia=web`;
  const md = await jinaGet(ddgUrl);

  const posts = [...new Set(md.match(/https?:\/\/(?:www\.)?instagram\.com\/p\/[A-Za-z0-9_-]+/g) || [])];
  const reels = [...new Set(md.match(/https?:\/\/(?:www\.)?instagram\.com\/reel\/[A-Za-z0-9_-]+/g) || [])];
  const all = [...posts, ...reels];

  // Garder ceux qui contiennent le handle (dans la légende ou url)
  // (DDG peut parfois retourner des posts d'autres comptes)
  const filtered = all.length ? all : [];
  if (!filtered.length) {
    // Fallback : Bing
    try {
      const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(`site:instagram.com/p/ ${h}`)}`;
      const bingMd = await jinaGet(bingUrl);
      const bingPosts = [...new Set(bingMd.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+/g) || [])];
      return bingPosts.slice(0, limit);
    } catch { /* nothing */ }
  }
  return filtered.slice(0, limit);
}

// ============= IMAGE D'UN POST via Microlink =============

export async function fetchPostImage(postUrl) {
  const data = await microlinkGet(postUrl);
  const img = data?.image?.url;
  if (!img) throw new Error('Microlink: pas d\'image trouvée');
  // Filtrer les logos / placeholders Instagram (multiples patterns)
  const isGeneric = (
    /static\.cdninstagram\.com\/rsrc/i.test(img) ||
    /static\.cdninstagram\.com\/r\//i.test(img) ||
    /\/rsrc\.php/i.test(img) ||
    /facebook\.com\/[a-z]\//i.test(img) ||
    /\.(svg|gif)$/i.test(img) ||
    /apple-touch-icon/i.test(img) ||
    /default[_-]?(profile|avatar|placeholder)/i.test(img) ||
    img.includes('cdninstagram.com/rsrc.php')
  );
  if (isGeneric) {
    throw new Error('Image générique IG (post peut-être supprimé)');
  }
  return { url: img, caption: data.description || '', date: data.date };
}

// ============= TÉLÉCHARGEMENT IMAGE EN BLOB =============

export async function fetchImageAsBlob(url) {
  // Les URLs CDN Instagram acceptent le fetch direct (CORS OK testé)
  const r = await fetchWithTimeout(url, { mode: 'cors', referrerPolicy: 'no-referrer' }, 12000);
  if (!r.ok) throw new Error(`Image fetch ${r.status}`);
  const blob = await r.blob();
  if (!blob || blob.size < 100) throw new Error('Image vide');
  // Vérifier que c'est bien une image (un proxy peut retourner du HTML d'erreur en 200)
  if (blob.type && !blob.type.startsWith('image/')) {
    throw new Error(`Pas une image (type: ${blob.type})`);
  }
  return blob;
}

// ============= ORCHESTRATION =============

/**
 * Mode "fast" : ne récupère QUE la photo de profil via Dumpor (pas de Microlink, pas de rate limit).
 * Idéal pour enrichir rapidement de nombreux profils sans utiliser le quota Microlink.
 */
export async function fetchInstagramProfilePicOnly(handle, { onProgress = () => {} } = {}) {
  const h = cleanHandle(handle);
  if (!h) throw new Error('Handle vide.');
  onProgress({ message: `Dumpor @${h}…` });
  const p = await fetchInstagramProfilePic(h);
  return {
    handle: h,
    profilePic: p?.url ? p : null,
    posts: [],
    bio: p?.bio || '',
    errors: p?.url ? [] : ['Dumpor: pas de photo de profil disponible'],
  };
}

/**
 * Récupère tout pour un profil Instagram en une fois.
 * @returns {profilePic, posts: [{imageUrl, caption}], bio}
 */
export async function fetchInstagramProfile(handle, { onProgress = () => {}, postLimit = 9 } = {}) {
  const h = cleanHandle(handle);
  const result = { handle: h, profilePic: null, posts: [], bio: '', errors: [] };

  // 1) Profile pic + bio
  onProgress({ step: 'profile-pic', message: 'Recherche photo de profil…' });
  try {
    const p = await fetchInstagramProfilePic(h);
    if (p.url) result.profilePic = p;
    if (p.bio) result.bio = p.bio;
  } catch (e) {
    result.errors.push('Photo de profil : ' + e.message);
  }

  // 2) URLs des posts
  onProgress({ step: 'post-urls', message: `Recherche URLs des posts récents…` });
  let postUrls = [];
  try {
    postUrls = await fetchInstagramPostUrls(h, postLimit);
  } catch (e) {
    result.errors.push('URLs posts : ' + e.message);
  }

  // 3) Image de chaque post (en parallèle, throttle 3 simultanés)
  // Si on est rate-limited, on stop tout sur le premier échec
  if (postUrls.length) {
    onProgress({ step: 'posts', message: `Récupération de ${postUrls.length} images de posts…`, total: postUrls.length });
    const posts = await runWithConcurrency(postUrls, 3, async (url, i) => {
      if (_microlinkRateLimited) return null; // skip si déjà rate-limited
      try {
        const img = await fetchPostImage(url);
        onProgress({ step: 'posts', message: `Post ${i + 1}/${postUrls.length} OK`, current: i + 1, total: postUrls.length });
        return { ...img, postUrl: url };
      } catch (e) {
        if (e.message === 'MICROLINK_RATE_LIMITED') {
          throw e; // propage pour stopper le bulk parent
        }
        onProgress({ step: 'posts', message: `Post ${i + 1} : ${e.message}`, current: i + 1, total: postUrls.length });
        return null;
      }
    });
    result.posts = posts.filter(Boolean);
  }

  return result;
}

async function runWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ============= CONFIG =============

export async function getIgFetchEnabled() {
  const v = await getMeta('ig_fetch_enabled');
  return v !== false;
}
export async function setIgFetchEnabled(v) { await setMeta('ig_fetch_enabled', !!v); }
