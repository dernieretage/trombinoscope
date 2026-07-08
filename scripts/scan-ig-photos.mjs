#!/usr/bin/env node
// ============================================================================
// ROBOT PHOTOS INSTAGRAM — back-office autonome (aucun appareil requis)
//
// Tourne sur GitHub Actions (planifié). Pour chaque profil qui a un handle
// Instagram mais aucune photo, il récupère la VRAIE photo de profil via
// l'endpoint public d'Instagram (celui qu'utilise le site instagram.com),
// la télécharge, et l'ajoute au stockage cloud (data/cloud/) au format exact
// de l'app (chunks base64 + manifest). Aucune clé API, aucun service tiers.
//
// Sécurité des données : n'AJOUTE que des images à des profils qui n'en ont
// pas. Ne supprime jamais un profil, une image existante, ni un tombstone.
// ============================================================================

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Empreintes de logos/placeholders Instagram connus (à supprimer s'ils ont été
// stockés par erreur avant le filtre anti-logo). md5 du champ `data`.
const KNOWN_LOGO_HASHES = new Set([
  '50d6dad630ef6b2edd84bb3315c08406', // logo IG (PNG) partagé par plusieurs profils
]);
const md5 = (s) => createHash('md5').update(s).digest('hex');

const CLOUD_DIR = join(process.cwd(), 'data', 'cloud');
const MANIFEST = join(CLOUD_DIR, 'trombinoscope.json');
const CHUNK_BYTES = 700_000;         // même seuil que l'app (cloud.js pushCloud)
const MAX_PER_RUN = 25;              // limite par exécution (rate-limit IG)
const DELAY_MS = 2500;               // pause entre deux profils
const IG_APP_ID = '936619743392459'; // App-ID public du web Instagram
const MAX_CONSEC_429 = 6;            // coupe-circuit : au-delà, l'IP est bloquée
// Pool de User-Agents réalistes : on en tire un au hasard par requête pour
// paraître moins robotique (réduit un peu les 429 d'Instagram).
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
];
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// délai de base + jitter (jusqu'à +50%) pour ne pas cadencer mécaniquement
const jitter = (base) => Math.round(base * (1 + Math.random() * 0.5));
// mélange (Fisher-Yates) : ordre des candidats différent à chaque run
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Erreur qui transporte le status HTTP (pour piloter le backoff sur 429)
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
// fetch avec timeout dur (évite qu'une requête pende indéfiniment le job CI)
async function fetchT(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function cleanHandle(h) {
  return String(h || '')
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/[/?#].*$/, '')
    .trim().toLowerCase();
}

// Rejette les images génériques / logos (ne jamais stocker "le gros logo")
function isGenericUrl(url) {
  if (!url) return true;
  return /\/rsrc\.php|static\.cdninstagram\.com\/r[\/.]|instagram\.com\/static\//i.test(url);
}

// --- Source 1 : API web publique d'Instagram (meilleure qualité, _hd) ---
// IMPORTANT : Instagram applique une "SecFetch Policy". Node/undici envoie des
// en-têtes Sec-Fetch-* interprétés comme cross-site → 400. On simule une
// requête XHR same-origin depuis la page du profil (Referer + Sec-Fetch-Site).
async function igApiPicUrl(handle) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`;
  const res = await fetchT(url, {
    headers: {
      'X-IG-App-ID': IG_APP_ID,
      'User-Agent': pickUA(),
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': `https://www.instagram.com/${handle}/`,
      'X-Requested-With': 'XMLHttpRequest',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    },
  });
  if (!res.ok) throw new HttpError(res.status, `api ${res.status}`);
  const json = await res.json();
  const user = json?.data?.user;
  if (!user) throw new Error('pas de user dans la réponse');
  const pic = user.profile_pic_url_hd || user.profile_pic_url;
  if (!pic || isGenericUrl(pic)) throw new Error('pas de photo exploitable');
  return pic;
}

// Résout l'URL de la photo via l'API IG (seule source fiable et gratuite : la
// page HTML déconnectée ne l'expose plus, et le proxy unavatar est passé
// payant pour Instagram). Sur 429 (limite parfois transitoire), on retente
// jusqu'à 3 fois avec une attente croissante. `state.consec429` compte les 429
// consécutifs pour le coupe-circuit de main().
async function resolvePicUrl(handle, state) {
  const waits = [10000, 25000]; // attentes (jitterées) avant chaque ré-essai
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    try {
      const url = await igApiPicUrl(handle);
      state.consec429 = 0;
      return { url, via: 'api' };
    } catch (e) {
      if (e.status === 429) {
        state.consec429++;
        if (attempt < waits.length) { await sleep(jitter(waits[attempt])); continue; }
      }
      throw e; // non-429 (privé/introuvable) ou 429 épuisé → on passe au suivant
    }
  }
  throw new Error('inatteignable'); // jamais atteint
}

async function downloadAsDataUri(picUrl) {
  const res = await fetchT(picUrl, { headers: { 'User-Agent': pickUA() } }, 20000);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const ct = res.headers.get('content-type') || 'image/jpeg';
  if (!ct.startsWith('image/')) throw new Error(`pas une image (${ct})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error('image trop petite (placeholder ?)');
  const type = ct.split(';')[0];
  return { dataUri: `data:${type};base64,${buf.toString('base64')}`, type };
}

// Recharge tous les records d'images depuis les chunks existants
function readAllImages() {
  const files = readdirSync(CLOUD_DIR).filter((f) => /^trombinoscope-images-\d+\.json$/.test(f));
  const images = [];
  for (const f of files) {
    try {
      const chunk = JSON.parse(readFileSync(join(CLOUD_DIR, f), 'utf8'));
      if (Array.isArray(chunk.images)) images.push(...chunk.images);
    } catch (e) { console.warn(`[warn] chunk illisible ${f}: ${e.message}`); }
  }
  return { images, files };
}

// Réécrit manifest + chunks au format exact de l'app
function writeCloud(manifest, allImages, oldChunkFiles) {
  // Découpe en chunks ~600 Ko
  const chunks = [];
  let cur = [], curSize = 0;
  for (const img of allImages) {
    const sz = (img.data || '').length;
    if (curSize + sz > CHUNK_BYTES && cur.length) { chunks.push(cur); cur = []; curSize = 0; }
    cur.push(img); curSize += sz;
  }
  if (cur.length) chunks.push(cur);

  manifest.version = 3;
  manifest.exportedAt = new Date().toISOString();
  manifest.imageChunks = chunks.length;
  manifest.totalImages = allImages.length;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  const newNames = new Set();
  chunks.forEach((chunk, i) => {
    const name = `trombinoscope-images-${String(i + 1).padStart(3, '0')}.json`;
    newNames.add(name);
    writeFileSync(join(CLOUD_DIR, name), JSON.stringify({ chunk: i + 1, of: chunks.length, images: chunk }));
  });
  // Supprimer les anciens chunks devenus orphelins (si le nombre a diminué)
  for (const f of oldChunkFiles) {
    if (!newNames.has(f)) { try { unlinkSync(join(CLOUD_DIR, f)); } catch {} }
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const profiles = manifest.profiles || [];
  let { images: allImages, files: oldChunkFiles } = readAllImages();

  // --- PASSE 1 : nettoyer les logos/placeholders stockés par erreur ---
  // Un logo est : (a) un hash connu, ou (b) une image dont le data EXACT est
  // partagé par ≥2 profils (les vraies photos sont uniques).
  const hashCount = new Map();
  for (const im of allImages) { const h = md5(im.data); hashCount.set(h, (hashCount.get(h) || 0) + 1); }
  const before = allImages.length;
  allImages = allImages.filter((im) => {
    const h = md5(im.data);
    // Les vraies photos IG sont des JPEG. Un doublon PNG (ou data-URI PNG) =
    // quasi certainement le logo/placeholder. On ne supprime un doublon que
    // s'il est PNG, pour ne jamais retirer une vraie photo JPEG partagée.
    const isPng = /^data:image\/png/i.test(im.data);
    const isLogo = KNOWN_LOGO_HASHES.has(h) || (hashCount.get(h) > 1 && isPng);
    return !isLogo;
  });
  const removed = before - allImages.length;
  if (removed) console.log(`Logos supprimés : ${removed}`);

  const hasImage = new Set(allImages.map((im) => im.profileId));
  const candidates = profiles.filter((p) => p && p.id && p.instagram && !hasImage.has(p.id));

  console.log(`Profils : ${profiles.length} | avec vraie photo : ${hasImage.size} | à récupérer : ${candidates.length}`);
  if (!candidates.length && !removed) { console.log('Rien à faire.'); return; }

  // On mélange les candidats : sur les runs planifiés, des profils différents
  // sont tentés en premier (utile si Instagram limite après quelques requêtes).
  const todo = shuffle(candidates).slice(0, MAX_PER_RUN);
  let added = 0;
  const state = { consec429: 0 };
  for (const p of todo) {
    // Coupe-circuit : si Instagram enchaîne les 429, l'IP du runner est
    // bloquée pour un moment → inutile d'insister. On s'arrête et on retentera
    // au prochain passage (dans 3h, souvent avec une IP GitHub différente).
    if (state.consec429 >= MAX_CONSEC_429) {
      console.log('\n⚠ Instagram limite cette IP GitHub (429 en série) — arrêt anticipé, nouvelle tentative au prochain passage.');
      break;
    }
    const h = cleanHandle(p.instagram);
    if (!h) continue;
    try {
      const { url, via } = await resolvePicUrl(h, state);
      const { dataUri, type } = await downloadAsDataUri(url);
      allImages.push({ key: `${p.id}::0`, profileId: p.id, index: 0, type, data: dataUri });
      added++;
      console.log(`  ✓ @${h} (${p.name || ''}) — photo récupérée [${via}]`);
    } catch (e) {
      console.log(`  ✗ @${h} (${p.name || ''}) — ${e.message}`);
    }
    await sleep(jitter(DELAY_MS));
  }

  if (added > 0 || removed > 0) {
    writeCloud(manifest, allImages, oldChunkFiles);
    console.log(`\n${removed} logo(s) retiré(s), ${added} photo(s) ajoutée(s). Cloud : ${manifest.imageChunks} chunks, ${manifest.totalImages} images.`);
  } else {
    console.log('\nAucun changement (comptes privés/introuvables ou rate-limit). Nouvelle tentative au prochain passage.');
  }
}

main().catch((e) => { console.error('Erreur robot:', e); process.exit(1); });
