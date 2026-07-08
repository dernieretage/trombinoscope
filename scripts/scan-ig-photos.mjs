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
import { join } from 'node:path';

const CLOUD_DIR = join(process.cwd(), 'data', 'cloud');
const MANIFEST = join(CLOUD_DIR, 'trombinoscope.json');
const CHUNK_BYTES = 700_000;         // même seuil que l'app (cloud.js pushCloud)
const MAX_PER_RUN = 25;              // limite par exécution (rate-limit IG)
const DELAY_MS = 2500;               // pause entre deux profils
const IG_APP_ID = '936619743392459'; // App-ID public du web Instagram
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function fetchProfilePicUrl(handle) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`;
  // IMPORTANT : Instagram applique une "SecFetch Policy". Node/undici envoie des
  // en-têtes Sec-Fetch-* interprétés comme cross-site → 400. On simule une
  // requête XHR same-origin depuis la page du profil (Referer + Sec-Fetch-Site).
  const res = await fetch(url, {
    headers: {
      'X-IG-App-ID': IG_APP_ID,
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': `https://www.instagram.com/${handle}/`,
      'X-Requested-With': 'XMLHttpRequest',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    },
  });
  if (!res.ok) throw new Error(`web_profile_info ${res.status}`);
  const json = await res.json();
  const user = json?.data?.user;
  if (!user) throw new Error('pas de user dans la réponse');
  const pic = user.profile_pic_url_hd || user.profile_pic_url;
  if (!pic || isGenericUrl(pic)) throw new Error('pas de photo exploitable');
  return { pic, fullName: user.full_name || '' };
}

async function downloadAsDataUri(picUrl) {
  const res = await fetch(picUrl, { headers: { 'User-Agent': UA } });
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
  const { images: allImages, files: oldChunkFiles } = readAllImages();

  const hasImage = new Set(allImages.map((im) => im.profileId));
  const candidates = profiles.filter((p) => p && p.id && p.instagram && !hasImage.has(p.id));

  console.log(`Profils : ${profiles.length} | avec photo : ${hasImage.size} | sans photo & avec IG : ${candidates.length}`);
  if (!candidates.length) { console.log('Rien à faire.'); return; }

  const todo = candidates.slice(0, MAX_PER_RUN);
  let added = 0;
  for (const p of todo) {
    const h = cleanHandle(p.instagram);
    if (!h) continue;
    try {
      const { pic, fullName } = await fetchProfilePicUrl(h);
      const { dataUri, type } = await downloadAsDataUri(pic);
      allImages.push({ key: `${p.id}::0`, profileId: p.id, index: 0, type, data: dataUri });
      added++;
      console.log(`  ✓ @${h} (${p.name || fullName}) — photo récupérée`);
    } catch (e) {
      console.log(`  ✗ @${h} (${p.name || ''}) — ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  if (added > 0) {
    writeCloud(manifest, allImages, oldChunkFiles);
    console.log(`\n${added} photo(s) ajoutée(s). Cloud réécrit : ${manifest.imageChunks} chunks, ${manifest.totalImages} images.`);
  } else {
    console.log('\nAucune photo récupérée cette fois (comptes privés/introuvables ou rate-limit). Nouvelle tentative au prochain passage.');
  }
}

main().catch((e) => { console.error('Erreur robot:', e); process.exit(1); });
