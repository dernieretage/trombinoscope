// Utilitaires partagés

// Hash déterministe pour générer une couleur depuis une chaîne
export function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Génère un dégradé déterministe + initiales pour un profil sans photo
export function avatarFor(name, instagram) {
  const seed = hashStr((name || instagram || 'x').toLowerCase());
  const h1 = seed % 360;
  const h2 = (h1 + 35 + (seed % 50)) % 360;
  const sat1 = 55 + (seed % 25);
  const sat2 = 60 + ((seed >> 8) % 20);
  const lig1 = 38 + ((seed >> 16) % 14);
  const lig2 = 26 + ((seed >> 24) % 14);
  const angle = (seed >> 4) % 360;
  return {
    bg: `hsl(${h1} ${sat1}% ${lig1}%)`,
    gradient: `linear-gradient(${angle}deg, hsl(${h1} ${sat1}% ${lig1}%), hsl(${h2} ${sat2}% ${lig2}%))`,
    initials: getInitials(name || instagram || ''),
  };
}

export function getInitials(name) {
  if (!name) return '?';
  const cleaned = name.replace(/[^A-Za-zÀ-ÿ\s'-]/g, '').trim();
  if (!cleaned) return name.slice(0, 2).toUpperCase();
  const parts = cleaned.split(/[\s'-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Slug-friendly handle depuis URL ou texte
export function parseInstagramHandle(input) {
  if (!input) return '';
  let s = String(input).trim();
  s = s.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '');
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/^@/, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/.*$/, '');
  return s.toLowerCase();
}

// Devine un nom à partir d'un handle
export function guessNameFromHandle(handle) {
  if (!handle) return '';
  let s = handle.replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim();
  if (!s) return handle;
  return s.split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Levenshtein-lite pour fuzzy search (court-circuit si trop éloigné)
export function fuzzyMatch(needle, haystack) {
  if (!needle) return true;
  needle = needle.toLowerCase();
  haystack = haystack.toLowerCase();
  if (haystack.includes(needle)) return true;
  if (needle.length < 3) return false;
  // tokenisation simple
  const tokens = needle.split(/\s+/);
  return tokens.every(t => haystack.includes(t));
}

export function highlight(text, query) {
  if (!query || !text) return escapeHTML(text || '');
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return escapeHTML(text);
  const escaped = escapeHTML(text);
  let out = escaped;
  for (const t of tokens) {
    const re = new RegExp('(' + escapeRegex(t) + ')', 'gi');
    out = out.replace(re, '<mark class="hl">$1</mark>');
  }
  return out;
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Debounce utilitaire
export function debounce(fn, ms = 180) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, a), ms);
  };
}

// Format file size
export function fmtBytes(b) {
  if (!b) return '0 o';
  const u = ['o','Ko','Mo','Go'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i];
}

export function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

// Redimensionne / compresse une image (avant stockage)
export async function downscaleImage(file, { maxDim = 1400, quality = 0.85 } = {}) {
  const bmp = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * ratio);
    const h = Math.round(bmp.height * ratio);
    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const type = (file.type === 'image/png' || file.type === 'image/webp') ? 'image/webp' : 'image/jpeg';
    if (canvas.convertToBlob) return await canvas.convertToBlob({ type, quality });
    return await new Promise((res) => canvas.toBlob(res, type, quality));
  } finally {
    bmp.close && bmp.close();
  }
}

export function blobToObjectURL(blob) {
  return URL.createObjectURL(blob);
}

// Petit gestionnaire d'objet URL avec cache pour éviter les fuites
const urlCache = new Map();
export function objectURLFor(key, blob) {
  if (urlCache.has(key)) return urlCache.get(key);
  const u = URL.createObjectURL(blob);
  urlCache.set(key, u);
  return u;
}
export function revokeObjectURL(key) {
  if (urlCache.has(key)) {
    URL.revokeObjectURL(urlCache.get(key));
    urlCache.delete(key);
  }
}
export function clearObjectURLs() {
  for (const u of urlCache.values()) URL.revokeObjectURL(u);
  urlCache.clear();
}

// Détection de focus dans un input/textarea/contenteditable
export function isTypingContext(el = document.activeElement) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

// Helper DOM
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
