// Photo de profil Instagram — uniquement pour illustrer la fiche.
//
// Depuis fin 2026, Instagram ne montre plus rien sans compte (mur de connexion,
// og:image = logo). Les seules voies gratuites utilisables DEPUIS UN NAVIGATEUR
// (CORS) sont des relais :
//  ▸ unavatar.io  : renvoie directement l'image (quota anonyme journalier par IP)
//  ▸ Microlink    : og:image de la page (50 req/jour anonyme, plus avec une clé)
// Chaque appareil tente avec sa propre IP ; le robot cloud (scripts/
// scan-ig-photos.mjs, session Instagram) complète ce qui manque.

import { getMeta, setMeta } from './store.js';

const MICROLINK_BASE = 'https://api.microlink.io/?url=';
const MICROLINK_PRO_BASE = 'https://pro.microlink.io/?url='; // avec clé API
const UNAVATAR_BLOCK_KEY = 'unavatar_block_until';

// État rate-limit (session) + persistance de la fenêtre de blocage
let _microlinkRateLimited = false;
export function isMicrolinkRateLimited() { return _microlinkRateLimited; }
export function resetMicrolinkRateLimit() { _microlinkRateLimited = false; }

export class RateLimitError extends Error {
  constructor(source) { super(`${source}: quota atteint`); this.code = 'RATE_LIMITED'; this.source = source; }
}

// ============= UTILITAIRES =============

export function cleanHandle(h) {
  return String(h || '').replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[\/?#].*$/, '').trim().toLowerCase();
}

// Wrapper fetch avec timeout via AbortController : sans ça, un relais
// silencieux peut bloquer indéfiniment la récupération.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error(`Délai dépassé : ${url.slice(0, 50)}…`);
      err.code = 'TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function microlinkGet(url) {
  const apiKey = await getMeta('microlink_api_key');
  const base = apiKey ? MICROLINK_PRO_BASE : MICROLINK_BASE;
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const r = await fetchWithTimeout(base + encodeURIComponent(url), { headers }, 15000);
  if (r.status === 429) {
    _microlinkRateLimited = true;
    throw new RateLimitError('microlink');
  }
  if (!r.ok) throw new Error(`Microlink ${r.status}`);
  const j = await r.json();
  return j?.data || null;
}

// ============= DÉTECTION IMAGE GÉNÉRIQUE / LOGO =============
// Instagram sert un mur de connexion dont l'og:image est le LOGO Instagram
// (parfois en data:image base64). On refuse ces images : mieux vaut l'avatar
// dégradé + initiales que « le gros logo ».
export function isGenericIgImage(url) {
  if (!url) return true;
  if (/^data:/i.test(url)) return true;
  return (
    /static\.cdninstagram\.com\/rsrc/i.test(url) ||
    /static\.cdninstagram\.com\/r\//i.test(url) ||
    /\/rsrc\.php/i.test(url) ||
    /facebook\.com\/[a-z]\//i.test(url) ||
    /\.(svg|gif)(\?|$)/i.test(url) ||
    /apple-touch-icon|favicon/i.test(url) ||
    /instagram\.com\/static\//i.test(url) ||
    /default[_-]?(profile|avatar|placeholder)/i.test(url)
  );
}

// ============= TÉLÉCHARGEMENT IMAGE EN BLOB =============

export async function fetchImageAsBlob(url) {
  const r = await fetchWithTimeout(url, { mode: 'cors', referrerPolicy: 'no-referrer' }, 12000);
  if (!r.ok) throw new Error(`Image ${r.status}`);
  const blob = await r.blob();
  if (!blob || blob.size < 100) throw new Error('Image vide');
  if (blob.type && !blob.type.startsWith('image/')) throw new Error(`Pas une image (${blob.type})`);
  return blob;
}

// ============= PHOTO DE PROFIL =============

/**
 * Récupère la photo de profil d'un compte Instagram.
 * @returns {{ blob: Blob, source: string }}
 * @throws RateLimitError quand toutes les voies sont en quota ; Error sinon.
 */
export async function fetchInstagramProfilePic(handle) {
  const h = cleanHandle(handle);
  if (!h) throw new Error('Handle vide.');
  const errors = [];
  let rateLimited = false;

  // Voie 1 : unavatar.io — renvoie l'image elle-même ; fallback=false → une
  // vraie erreur (404) plutôt qu'un avatar générique quand le compte est
  // introuvable ou privé.
  const blockedUntil = (await getMeta(UNAVATAR_BLOCK_KEY)) || 0;
  if (Date.now() >= blockedUntil) {
    try {
      const r = await fetchWithTimeout(`https://unavatar.io/instagram/${encodeURIComponent(h)}?fallback=false`, { mode: 'cors', redirect: 'follow' }, 15000);
      if (r.status === 429) {
        await setMeta(UNAVATAR_BLOCK_KEY, Date.now() + 6 * 3600 * 1000);
        rateLimited = true;
        errors.push('unavatar : quota du jour atteint');
      } else if (r.ok) {
        const ct = r.headers.get('content-type') || '';
        if (ct.startsWith('image/') && !isGenericIgImage(r.url)) {
          const blob = await r.blob();
          if (blob.size >= 2000) return { blob, source: 'unavatar' };
          errors.push('unavatar : image trop petite');
        } else {
          errors.push(`unavatar : réponse inattendue (${ct || r.status})`);
        }
      } else {
        errors.push(`unavatar : ${r.status}`);
      }
    } catch (e) { errors.push('unavatar : ' + e.message); }
  } else {
    rateLimited = true;
    errors.push('unavatar : en pause (quota)');
  }

  // Voie 2 : Microlink sur la page du profil — l'og:image est la photo de
  // profil quand Instagram la montre encore, le logo sinon (refusé).
  if (!_microlinkRateLimited) {
    try {
      const data = await microlinkGet(`https://www.instagram.com/${h}/`);
      const url = data?.image?.url;
      if (url && !isGenericIgImage(url)) {
        const blob = await fetchImageAsBlob(url);
        if (blob.size >= 2000) return { blob, source: 'microlink' };
        errors.push('microlink : image trop petite');
      } else {
        errors.push('microlink : pas de photo (mur de connexion)');
      }
    } catch (e) {
      if (e?.code === 'RATE_LIMITED') rateLimited = true;
      errors.push('microlink : ' + e.message);
    }
  } else {
    rateLimited = true;
    errors.push('microlink : en pause (quota)');
  }

  if (rateLimited) { const e = new RateLimitError('instagram'); e.details = errors; throw e; }
  const e = new Error(errors.join(' · ') || 'pas de photo');
  e.details = errors;
  throw e;
}

export async function unavatarBlockedUntil() {
  return (await getMeta(UNAVATAR_BLOCK_KEY)) || 0;
}
