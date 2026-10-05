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

// ---- Session Instagram (optionnelle mais désormais INDISPENSABLE) ----
// Depuis l'automne 2026, l'endpoint web_profile_info exige une session
// (401 anonyme, partout). Le cookie est lu depuis $IG_SESSION ou le fichier
// local ~/Library/Application Support/trombinoscope/ig-session.txt
// (format : la ligne Cookie complète, au minimum « sessionid=…; csrftoken=… »).
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
function loadIgSession() {
  let raw = (process.env.IG_SESSION || '').trim();
  if (!raw) {
    const f = join(homedir(), 'Library', 'Application Support', 'trombinoscope', 'ig-session.txt');
    if (existsSync(f)) { try { raw = readFileSync(f, 'utf8').trim(); } catch {} }
  }
  if (!raw) return null;
  const csrf = (raw.match(/csrftoken=([^;\s]+)/) || [])[1] || '';
  return { cookie: raw, csrf };
}
const IG_SESSION = loadIgSession();
// Avec session : UA desktop FIXE (une session liée à un UA stable = moins de flags)
const SESSION_UA = UAS[1];


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
// 44884218_345707102882519… = l'avatar gris « compte sans photo » d'Instagram.
function isGenericUrl(url) {
  if (!url) return true;
  return /\/rsrc\.php|static\.cdninstagram\.com\/r[\/.]|instagram\.com\/static\/|44884218_345707102882519/i.test(url);
}

// --- Source 2 : page « embed » du profil (instagram.com/{handle}/embed/) ---
// Conçue pour être intégrée sur des sites tiers, elle est servie SANS compte
// et contient profile_pic_url (vignette 100×100 signée). Résolution modeste,
// mais c'est la seule voie publique encore ouverte en anonyme (oct. 2026).
async function fetchEmbedPage(handle) {
  // UA Safari obligatoire : avec un UA Firefox/Chrome-Android, Instagram sert
  // la coquille complète du site (sans aucune donnée de profil).
  const res = await fetchT(`https://www.instagram.com/${encodeURIComponent(handle)}/embed/`, {
    headers: { 'User-Agent': SESSION_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
  }, 20000);
  if (!res.ok) throw new HttpError(res.status, `embed ${res.status}`);
  return res.text();
}

function igEmbedPicUrl(html) {
  const m = html.match(/profile_pic_url\\?":\\?"(.*?)\\?"/);
  if (!m) throw new Error('embed : pas de profile_pic_url (compte privé/inexistant ?)');
  // La valeur est une chaîne JSON elle-même échappée dans une chaîne JS :
  // on la décode jusqu'à deux fois (\\/ → /, \\u00253D → %3D, etc.).
  let url = m[1];
  for (let i = 0; i < 2 && url.includes('\\'); i++) {
    try { url = JSON.parse('"' + url + '"'); } catch { break; }
  }
  if (!/^https:\/\//.test(url) || url.includes('\\') || isGenericUrl(url)) throw new Error('embed : pas de photo exploitable');
  return url;
}

// --- Source 3 : point d'accès « app mobile » (i.instagram.com) ---
// Avec l'identifiant numérique du compte (lu dans la page embed) et un UA de
// l'application Instagram, il répond encore en anonyme et donne une vignette
// 150×150 (au lieu de 100×100), parfois la version HD. On vérifie que le
// compte renvoyé est bien le handle demandé (jamais la photo de quelqu'un d'autre).
const APP_UA = 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)';
async function igAppInfoPicUrl(handle, html) {
  const m = html.match(/owner\\?":\{\\?"id\\?":\\?"(\d+)/);
  if (!m) throw new Error('info : identifiant introuvable');
  const res = await fetchT(`https://i.instagram.com/api/v1/users/${m[1]}/info/`, { headers: { 'User-Agent': APP_UA, 'Accept': '*/*' } }, 20000);
  if (!res.ok) throw new HttpError(res.status, `info ${res.status}`);
  const u = (await res.json())?.user;
  if (!u || String(u.username || '').toLowerCase() !== handle) throw new Error('info : compte différent');
  const url = (u.hd_profile_pic_url_info && u.hd_profile_pic_url_info.url) || u.profile_pic_url;
  if (!url || isGenericUrl(url)) throw new Error('info : pas de photo exploitable');
  return url;
}

// --- Source 1 : API web publique d'Instagram (meilleure qualité, _hd) ---
// IMPORTANT : Instagram applique une "SecFetch Policy". Node/undici envoie des
// en-têtes Sec-Fetch-* interprétés comme cross-site → 400. On simule une
// requête XHR same-origin depuis la page du profil (Referer + Sec-Fetch-Site).
async function igApiPicUrl(handle) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`;
  const headers = {
    'X-IG-App-ID': IG_APP_ID,
    'User-Agent': IG_SESSION ? SESSION_UA : pickUA(),
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `https://www.instagram.com/${handle}/`,
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
  if (IG_SESSION) {
    headers['Cookie'] = IG_SESSION.cookie;
    if (IG_SESSION.csrf) headers['X-CSRFToken'] = IG_SESSION.csrf;
  }
  const res = await fetchT(url, { headers });
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
  const errors = [];
  // Avec session : l'API d'abord (photo HD). Sans session elle répond 401 :
  // inutile de la solliciter, on passe directement à la page embed.
  if (IG_SESSION) {
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
        errors.push('api : ' + e.message);
        break;
      }
    }
  }
  let html;
  try { html = await fetchEmbedPage(handle); }
  catch (e) { if (e.status === 429) state.consec429++; errors.push(e.message); throw new Error(errors.join(' · ')); }
  // D'abord la meilleure résolution anonyme (150×150 / HD), sinon la vignette embed (100×100).
  try { const url = await igAppInfoPicUrl(handle, html); state.consec429 = 0; return { url, via: 'info' }; }
  catch (e) { errors.push(e.message); }
  try { const url = igEmbedPicUrl(html); state.consec429 = 0; return { url, via: 'embed' }; }
  catch (e) { errors.push(e.message); }
  throw new Error(errors.join(' · '));
}

async function downloadAsDataUri(picUrl) {
  const res = await fetchT(picUrl, { headers: { 'User-Agent': pickUA() } }, 20000);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const ct = res.headers.get('content-type') || 'image/jpeg';
  if (!ct.startsWith('image/')) throw new Error(`pas une image (${ct})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1200) throw new Error('image trop petite (placeholder ?)');
  const type = ct.split(';')[0];
  return { dataUri: `data:${type};base64,${buf.toString('base64')}`, type, buf };
}

// Agrandit ×4 par IA les vignettes (< 400 px) — voir scripts/upscale.mjs.
let upscaler = null;
async function enhance(buf, type) {
  if (process.env.NO_UPSCALE) return { dataUri: `data:${type};base64,${buf.toString('base64')}`, type, width: 0, upscaled: false };
  if (!upscaler) {
    try { upscaler = await import(pathToFileURL(join(process.cwd(), 'scripts', 'upscale.mjs')).href); }
    catch (e) { upscaler = { upscaleIfSmall: async (b, t) => ({ buffer: b, type: t, width: 0, upscaled: false, reason: e.message }) }; }
  }
  const r = await upscaler.upscaleIfSmall(buf, type);
  return { dataUri: `data:${r.type};base64,${r.buffer.toString('base64')}`, type: r.type, width: r.width, upscaled: r.upscaled, reason: r.reason };
}

// Recharge tous les records d'images depuis les chunks existants.
// DÉDUPLIQUE par clé (des pushs concurrents d'appareils peuvent laisser le
// même record dans deux chunks) : la dernière occurrence gagne (chunks lus
// dans l'ordre). L'app fait pareil (put par clé) — on garde le cloud honnête.
function readAllImages() {
  const files = readdirSync(CLOUD_DIR).filter((f) => /^trombinoscope-images-\d+\.json$/.test(f)).sort();
  const byKey = new Map();
  let total = 0;
  for (const f of files) {
    try {
      const chunk = JSON.parse(readFileSync(join(CLOUD_DIR, f), 'utf8'));
      if (Array.isArray(chunk.images)) {
        for (const im of chunk.images) {
          if (!im || !im.key) continue;
          total++;
          byKey.set(im.key, im);
        }
      }
    } catch (e) { console.warn(`[warn] chunk illisible ${f}: ${e.message}`); }
  }
  const images = [...byKey.values()];
  const deduped = total - images.length;
  if (deduped) console.log(`Doublons retirés (même clé dans plusieurs chunks) : ${deduped}`);
  return { images, files, deduped };
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
  console.log(IG_SESSION
    ? '🔐 Session Instagram chargée (mode authentifié).'
    : '⚠ AUCUNE session Instagram : depuis fin 2026 l\'API répond 401 en anonyme. Dépose le cookie dans ~/Library/Application Support/trombinoscope/ig-session.txt');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const profiles = manifest.profiles || [];
  let { images: allImages, files: oldChunkFiles, deduped } = readAllImages();

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

  // FORCE_HANDLES="at.alia,autre" : purge les images existantes de ces
  // handles (cas « mauvais compte scanné ») → re-fetch propre ci-dessous.
  const forced = new Set(String(process.env.FORCE_HANDLES || '')
    .split(',').map((x) => cleanHandle(x)).filter(Boolean));
  if (forced.size) {
    const forcedIds = new Set(profiles.filter((p) => forced.has(cleanHandle(p.instagram))).map((p) => p.id));
    const b4 = allImages.length;
    allImages = allImages.filter((im) => !forcedIds.has(im.profileId));
    console.log(`Re-scan forcé : ${forced.size} handle(s), ${b4 - allImages.length} ancienne(s) image(s) purgée(s).`);
  }

  const hasImage = new Set(allImages.map((im) => im.profileId));
  const candidates = profiles.filter((p) => p && p.id && p.instagram && !hasImage.has(p.id));

  console.log(`Profils : ${profiles.length} | avec vraie photo : ${hasImage.size} | à récupérer : ${candidates.length}`);
  if (!candidates.length && !removed && !deduped) { console.log('Rien à faire.'); return; }

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

  if (added > 0 || removed > 0 || deduped > 0) {
    writeCloud(manifest, allImages, oldChunkFiles);
    console.log(`\n${removed} logo(s) retiré(s), ${added} photo(s) ajoutée(s), ${deduped} doublon(s) purgé(s). Cloud : ${manifest.imageChunks} chunks, ${manifest.totalImages} images.`);
  } else {
    console.log('\nAucun changement (comptes privés/introuvables ou rate-limit). Nouvelle tentative au prochain passage.');
  }
}

// ============================================================================
// MODE ESPACE PARTAGÉ (Firestore) — utilisé dès que js/firebase-config.js est
// renseigné. Le robot lit les profils de l'espace, récupère la photo de ceux
// qui n'en ont pas, et l'écrit dans l'espace : elle apparaît en direct sur
// tous les appareils. L'identifiant de l'espace (secret, dérivé du mot de
// passe) vient de la variable TROMBI_SPACE_ID (Réglages → « Copier
// l'identifiant pour le robot »).
// ============================================================================

async function loadAppFirebaseConfig() {
  // Lecture textuelle (pas d'import ESM) : sans package.json « type: module »
  // dans le checkout, Node refuserait l'import d'un .js avec `export`.
  try {
    const src = readFileSync(join(process.cwd(), 'js', 'firebase-config.js'), 'utf8');
    const m = src.match(/FIREBASE_CONFIG\s*=\s*(\{[\s\S]*?\n\});/);
    if (!m) return null;
    const c = new Function('return (' + m[1] + ');')();
    if (c && c.apiKey && c.projectId && !/^REMPLACER/.test(c.apiKey)) return c;
  } catch (e) { console.log('Config Firebase illisible :', e.message); }
  return null;
}

async function mainSpace(cfg, spaceId) {
  const { initializeApp } = await import('firebase/app');
  const { getFirestore, collection, doc, getDocs, setDoc, deleteDoc, runTransaction, query, where } = await import('firebase/firestore');
  const { getAuth, signInAnonymously } = await import('firebase/auth');
  const app = initializeApp(cfg);
  const db = getFirestore(app);
  const auth = getAuth(app);
  if (cfg.emulator) { // tests locaux contre l'émulateur Firebase
    const { connectFirestoreEmulator } = await import('firebase/firestore');
    const { connectAuthEmulator } = await import('firebase/auth');
    connectFirestoreEmulator(db, cfg.emulator.host || '127.0.0.1', cfg.emulator.firestore || 8080);
    connectAuthEmulator(auth, `http://${cfg.emulator.host || '127.0.0.1'}:${cfg.emulator.auth || 9099}`, { disableWarnings: true });
  }
  await signInAnonymously(auth);
  const col = (name) => collection(db, 'spaces', spaceId, name);
  const newVersion = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  console.log(IG_SESSION
    ? '🔐 Session Instagram chargée (mode authentifié).'
    : '⚠ AUCUNE session Instagram : depuis fin 2026 l\'API répond 401 en anonyme.');
  let snap = await getDocs(col('profiles'));
  let profiles = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => !p.deleted);

  // --- IMPORT : data/robot-import.json (déposé sur gh-pages) → espace partagé ---
  const importFile = join(process.cwd(), 'data', 'robot-import.json');
  if (existsSync(importFile)) {
    let incoming = [];
    try { incoming = JSON.parse(readFileSync(importFile, 'utf8')).profiles || []; }
    catch (e) { console.log('Fichier d\'import illisible :', e.message); }
    if (incoming.length) {
      const { importIntoSpace } = await import(pathToFileURL(join(process.cwd(), 'scripts', 'space-import.mjs')).href);
      console.log(`Import de ${incoming.length} profil(s) depuis data/robot-import.json…`);
      const r = await importIntoSpace(db, spaceId, profiles, incoming);
      for (const l of r.lines) console.log(l);
      snap = await getDocs(col('profiles'));
      profiles = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => !p.deleted);
    }
    unlinkSync(importFile); // consommé : la publication (git add data) retire le fichier
    console.log('Fichier d\'import consommé.');
  }
  // Handles à re-traiter : variable FORCE_HANDLES et/ou fichier
  // data/robot-force-handles.txt (un handle par ligne, vidé après traitement).
  const forceFile = join(process.cwd(), 'data', 'robot-force-handles.txt');
  const fromFile = existsSync(forceFile) ? readFileSync(forceFile, 'utf8').split(/\r?\n/) : [];
  const forced = new Set([...String(process.env.FORCE_HANDLES || '').split(','), ...fromFile].map((x) => cleanHandle(x)).filter(Boolean));
  // Mémoire des échecs (data/robot-ig-attempts.json, publiée avec les données) :
  // un compte privé ou introuvable est réessayé de plus en plus rarement
  // (6 h, 12 h, 24 h… jusqu'à 7 jours) pour laisser la place aux autres.
  const attemptsFile = join(process.cwd(), 'data', 'robot-ig-attempts.json');
  let attempts = {};
  try { attempts = JSON.parse(readFileSync(attemptsFile, 'utf8')) || {}; } catch {}
  const nowMs = Date.now();
  const wanted = profiles.filter((p) => p.instagram && (forced.has(cleanHandle(p.instagram)) || !Object.keys(p.imgs || {}).length));
  const candidates = wanted.filter((p) => forced.has(cleanHandle(p.instagram)) || !(attempts[cleanHandle(p.instagram)]?.nextAt > nowMs));
  console.log(`Espace ${spaceId.slice(0, 6)}… — profils : ${profiles.length} | sans photo : ${wanted.length} | à tenter maintenant : ${candidates.length}${forced.size ? ` (dont ${forced.size} forcé(s))` : ''}`);
  const saveAttempts = () => {
    for (const h of Object.keys(attempts)) if (attempts[h].nextAt < nowMs - 30 * 86400000) delete attempts[h]; // ménage
    writeFileSync(attemptsFile, JSON.stringify(attempts, null, 1) + '\n');
  };
  if (!candidates.length) { console.log('Rien à faire.'); saveAttempts(); return; }

  const todo = shuffle(candidates).slice(0, MAX_PER_RUN);
  let added = 0;
  const state = { consec429: 0 };
  for (const p of todo) {
    if (state.consec429 >= MAX_CONSEC_429) {
      console.log('\n⚠ Instagram limite cette IP GitHub (429 en série) — arrêt anticipé, nouvelle tentative au prochain passage.');
      break;
    }
    const h = cleanHandle(p.instagram);
    if (!h) continue;
    try {
      let buf, type, via;
      if (process.env.ROBOT_TEST_IMAGE) { // test : image locale au lieu d'Instagram
        buf = readFileSync(process.env.ROBOT_TEST_IMAGE); type = 'image/jpeg'; via = 'test';
      } else {
        const r = await resolvePicUrl(h, state);
        via = r.via;
        ({ buf, type } = await downloadAsDataUri(r.url));
      }
      const e = await enhance(buf, type);
      if (e.upscaled) via += ` → IA ×4 (${e.width} px)`;
      else if (e.reason) via += ` (IA indisponible : ${e.reason})`;
      const { dataUri } = e;
      type = e.type;
      if (dataUri.length > 900_000) throw new Error('photo trop lourde pour un document');
      const v = newVersion();
      await setDoc(doc(db, 'spaces', spaceId, 'images', `${p.id}::0::${v}`), { profileId: p.id, index: 0, type, data: dataUri, v, at: Date.now(), w: e.width || null });
      const now = Date.now();
      const applied = await runTransaction(db, async (tx) => {
        const ref = doc(db, 'spaces', spaceId, 'profiles', p.id);
        const cur = await tx.get(ref);
        if (!cur.exists() || cur.data().deleted) return false;
        const d = cur.data();
        // Quelqu'un a mis une photo entre-temps : on ne l'écrase que si re-scan forcé.
        if (Object.keys(d.imgs || {}).length && !forced.has(h)) return false;
        tx.set(ref, { ...d, imgs: { 0: v }, _f: { ...(d._f || {}), imgs: now }, updatedAt: new Date(now).toISOString() });
        return true;
      });
      if (!applied) {
        await deleteDoc(doc(db, 'spaces', spaceId, 'images', `${p.id}::0::${v}`)).catch(() => {});
        console.log(`  · @${h} (${p.name || ''}) — déjà illustré entre-temps, ignoré`);
      } else {
        // Anciennes versions (re-scan forcé) : ménage.
        const olds = await getDocs(query(col('images'), where('profileId', '==', p.id)));
        for (const o of olds.docs) if (o.data().v !== v) await deleteDoc(o.ref).catch(() => {});
        added++;
        console.log(`  ✓ @${h} (${p.name || ''}) — photo déposée dans l\'espace [${via}]`);
      }
      delete attempts[h];
    } catch (e) {
      const n = (attempts[h]?.n || 0) + 1;
      attempts[h] = { n, nextAt: Date.now() + Math.min(7 * 86400000, 6 * 3600000 * 2 ** (n - 1)), last: e.message.slice(0, 80) };
      console.log(`  ✗ @${h} (${p.name || ''}) — ${e.message} (réessai dans ${Math.round((attempts[h].nextAt - Date.now()) / 3600000)} h)`);
    }
    await sleep(jitter(DELAY_MS));
  }
  saveAttempts();
  console.log(`\n${added} photo(s) ajoutée(s) à l\'espace partagé.`);
  if (fromFile.some((x) => cleanHandle(x))) {
    const left = fromFile.map(cleanHandle).filter((h) => h && !todo.some((p) => cleanHandle(p.instagram) === h));
    writeFileSync(forceFile, left.join('\n') + (left.length ? '\n' : ''));
    console.log(left.length ? `${left.length} handle(s) forcé(s) restant(s) pour le prochain passage.` : 'Liste des handles forcés vidée.');
  }
}

(async () => {
  const cfg = await loadAppFirebaseConfig();
  if (cfg) {
    const spaceId = (process.env.TROMBI_SPACE_ID || '').trim();
    if (!(cfg.emulator ? /^(test-)?[a-f0-9-]{27,64}$/ : /^[a-f0-9]{64}$/).test(spaceId)) {
      console.log('L\'app utilise l\'espace partagé mais TROMBI_SPACE_ID est absent ou invalide (secret GitHub à renseigner depuis Réglages → « Copier l\'identifiant pour le robot »). Rien à faire.');
      return;
    }
    await mainSpace(cfg, spaceId);
    process.exit(0); // ferme les connexions Firestore
  }
  await main(); // ancien stockage (data/cloud) tant que l'app n'a pas basculé
})().catch((e) => { console.error('Erreur robot:', e); process.exit(1); });
