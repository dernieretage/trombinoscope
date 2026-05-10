// Couche de stockage : IndexedDB pour les profils et images, localStorage pour les préférences UI
// Conçue pour scaler à plusieurs milliers de profils avec images en base64

const DB_NAME = 'trombinoscope';
const DB_VERSION = 1;
const STORE_PROFILES = 'profiles';
const STORE_IMAGES = 'images'; // image blobs séparées des profils pour ne charger que ce qui est visible
const STORE_META = 'meta';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        const s = db.createObjectStore(STORE_PROFILES, { keyPath: 'id' });
        s.createIndex('profession', 'profession', { unique: false });
        s.createIndex('status', 'status', { unique: false });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        // clé = profileId + index, valeur = { blob, type, width, height }
        db.createObjectStore(STORE_IMAGES, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
  });
  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ============= PROFILS =============

export async function getAllProfiles() {
  const store = await tx(STORE_PROFILES);
  return reqToPromise(store.getAll());
}

export async function getProfile(id) {
  const store = await tx(STORE_PROFILES);
  return reqToPromise(store.get(id));
}

export async function saveProfile(profile) {
  if (!profile.id) profile.id = uid();
  if (!profile.createdAt) profile.createdAt = new Date().toISOString();
  profile.updatedAt = new Date().toISOString();
  const store = await tx(STORE_PROFILES, 'readwrite');
  await reqToPromise(store.put(profile));
  return profile;
}

export async function deleteProfile(id) {
  // Récupérer les keys d'images pour révoquer les objectURL avant suppression
  const imgs = await getProfileImages(id).catch(() => []);
  const store = await tx(STORE_PROFILES, 'readwrite');
  await reqToPromise(store.delete(id));
  // nettoyer les images associées
  const imgStore = await tx(STORE_IMAGES, 'readwrite');
  const range = IDBKeyRange.bound(`${id}::`, `${id}::￿`);
  const req = imgStore.openCursor(range);
  await new Promise((resolve) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
  });
  // Révoquer tous les objectURL en cache pour ces images
  try {
    const u = await import('./utils.js');
    for (const img of imgs) u.revokeObjectURL(img.key);
  } catch {}
}

export async function bulkSaveProfiles(profiles) {
  const db = await openDB();
  const t = db.transaction(STORE_PROFILES, 'readwrite');
  const store = t.objectStore(STORE_PROFILES);
  const now = new Date().toISOString();
  for (const p of profiles) {
    if (!p.id) p.id = uid();
    if (!p.createdAt) p.createdAt = now;
    p.updatedAt = now;
    store.put(p);
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ============= IMAGES =============

export async function saveImage(profileId, index, blob) {
  const key = `${profileId}::${index}`;
  const store = await tx(STORE_IMAGES, 'readwrite');
  try {
    await reqToPromise(store.put({ key, profileId, index, blob, type: blob.type, size: blob.size, addedAt: Date.now() }));
  } catch (e) {
    if (e?.name === 'QuotaExceededError') {
      const err = new Error('Stockage local plein — supprimez quelques images anciennes ou fichiers volumineux.');
      err.code = 'QUOTA_LOCAL';
      throw err;
    }
    throw e;
  }
  // Invalider le cache d'objectURL pour cette clé (utile en cas de remplacement)
  try {
    const u = await import('./utils.js');
    u.revokeObjectURL(key);
  } catch {}
  return key;
}

export async function getImage(key) {
  const store = await tx(STORE_IMAGES);
  return reqToPromise(store.get(key));
}

// Fallback in-memory image cache (utilisé quand IDB est plein/refuse,
// notamment en navigation privée Safari). Vit le temps de la session.
const memoryImages = new Map(); // profileId -> [imgRecord, ...]
export function setMemoryImage(profileId, index, blob, type) {
  const key = `${profileId}::${index}`;
  const list = memoryImages.get(profileId) || [];
  const filtered = list.filter(it => it.key !== key);
  filtered.push({ key, profileId, index, blob, type, size: blob.size, addedAt: Date.now(), inMemory: true });
  filtered.sort((a, b) => a.index - b.index);
  memoryImages.set(profileId, filtered);
}
export function clearMemoryImages() { memoryImages.clear(); }

export async function getProfileImages(profileId) {
  const store = await tx(STORE_IMAGES);
  const range = IDBKeyRange.bound(`${profileId}::`, `${profileId}::￿`);
  const req = store.openCursor(range);
  const items = [];
  const idbResult = await new Promise((resolve) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.continue();
      } else {
        items.sort((a, b) => a.index - b.index);
        resolve(items);
      }
    };
    req.onerror = () => resolve([]);
  });
  // Fusionner avec le cache mémoire (si une image n'est qu'en mémoire, on l'ajoute)
  const mem = memoryImages.get(profileId);
  if (mem?.length) {
    const idbKeys = new Set(idbResult.map(it => it.key));
    for (const m of mem) {
      if (!idbKeys.has(m.key)) idbResult.push(m);
    }
    idbResult.sort((a, b) => a.index - b.index);
  }
  return idbResult;
}

export async function deleteImage(key) {
  const store = await tx(STORE_IMAGES, 'readwrite');
  await reqToPromise(store.delete(key));
}

export async function deleteProfileImages(profileId) {
  const imgStore = await tx(STORE_IMAGES, 'readwrite');
  const range = IDBKeyRange.bound(`${profileId}::`, `${profileId}::￿`);
  const req = imgStore.openCursor(range);
  const keys = [];
  await new Promise((resolve) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        keys.push(cursor.value.key);
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
  });
  // Invalider les objectURLs en cache
  try {
    const u = await import('./utils.js');
    for (const k of keys) u.revokeObjectURL(k);
  } catch {}
}

// ============= META =============

export async function getMeta(key) {
  const store = await tx(STORE_META);
  const r = await reqToPromise(store.get(key));
  return r ? r.value : null;
}

export async function setMeta(key, value) {
  const store = await tx(STORE_META, 'readwrite');
  return reqToPromise(store.put({ key, value }));
}

// ============= EXPORT / IMPORT JSON =============

// Export "single file" (legacy) — utilisé pour download local et backward compat
export async function exportAll() {
  const profiles = await getAllProfiles();
  const out = {
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles,
    images: [],
  };
  for (const p of profiles) {
    const imgs = await getProfileImages(p.id);
    for (const img of imgs) {
      const b64 = await blobToBase64(img.blob);
      out.images.push({ key: img.key, profileId: img.profileId, index: img.index, type: img.type, data: b64 });
    }
  }
  return out;
}

/**
 * Export "chunked" pour Gist GitHub :
 * - Fichier `trombinoscope.json` = metadata + profils (sans images)
 * - Fichiers `trombinoscope-images-NN.json` = chunks d'images en base64 (~600 KB chacun)
 * Cela permet de dépasser la limite recommandée Gist (~1 MB par fichier).
 */
export async function exportAllChunked({ chunkBytes = 600_000 } = {}) {
  const profiles = await getAllProfiles();
  const result = {
    files: {},
    totalImages: 0,
    totalSize: 0,
  };

  // Collecte de toutes les images en base64
  const allImages = [];
  for (const p of profiles) {
    const imgs = await getProfileImages(p.id);
    for (const img of imgs) {
      const b64 = await blobToBase64(img.blob);
      allImages.push({ key: img.key, profileId: img.profileId, index: img.index, type: img.type, data: b64 });
    }
  }
  result.totalImages = allImages.length;

  // Découpe en chunks
  const chunks = [];
  let current = [];
  let currentSize = 0;
  for (const img of allImages) {
    const sz = img.data.length;
    if (currentSize + sz > chunkBytes && current.length > 0) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(img);
    currentSize += sz;
  }
  if (current.length) chunks.push(current);

  // Manifest principal (metadata + profils, pas d'images)
  const manifest = {
    version: 2,
    exportedAt: new Date().toISOString(),
    profiles,
    imageChunks: chunks.length,
    totalImages: allImages.length,
  };
  result.files['trombinoscope.json'] = JSON.stringify(manifest);
  result.totalSize += result.files['trombinoscope.json'].length;

  // Fichiers de chunks
  chunks.forEach((chunk, i) => {
    const fname = `trombinoscope-images-${String(i + 1).padStart(3, '0')}.json`;
    result.files[fname] = JSON.stringify({ chunk: i + 1, of: chunks.length, images: chunk });
    result.totalSize += result.files[fname].length;
  });

  return result;
}

export async function importAll(data, { replace = false } = {}) {
  if (replace) {
    const db = await openDB();
    const t = db.transaction([STORE_PROFILES, STORE_IMAGES], 'readwrite');
    t.objectStore(STORE_PROFILES).clear();
    t.objectStore(STORE_IMAGES).clear();
    await new Promise((r) => (t.oncomplete = r));
  }
  if (data.profiles?.length) {
    await bulkSaveProfiles(data.profiles);
  }
  if (data.images?.length) {
    const store = await tx(STORE_IMAGES, 'readwrite');
    for (const img of data.images) {
      const blob = await base64ToBlob(img.data, img.type);
      store.put({ key: img.key, profileId: img.profileId, index: img.index, blob, type: img.type, size: blob.size, addedAt: Date.now() });
    }
  }
}

/**
 * Import "chunked" : prend un objet { 'trombinoscope.json': string, 'trombinoscope-images-NNN.json': string, ... }
 * et restaure tout. Compatible avec l'ancien format si un seul fichier "trombinoscope.json" est fourni.
 */
export async function importAllChunked(filesByName, { replace = true } = {}) {
  const manifestStr = filesByName['trombinoscope.json'];
  if (!manifestStr) throw new Error('trombinoscope.json manquant');
  const manifest = JSON.parse(manifestStr);
  let totalProfiles = 0, totalImages = 0;

  if (replace) {
    const db = await openDB();
    const t = db.transaction([STORE_PROFILES, STORE_IMAGES], 'readwrite');
    t.objectStore(STORE_PROFILES).clear();
    t.objectStore(STORE_IMAGES).clear();
    await new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(new Error('Transaction abortée pendant le clear'));
    });
  }

  if (manifest.profiles?.length) {
    await bulkSaveProfiles(manifest.profiles);
    totalProfiles = manifest.profiles.length;
  }

  // Helper qui save une liste d'images. Robuste aux quotas IndexedDB
  // (Safari Privée : ~1MB de limite). Sur quota, fallback en mémoire pour
  // que les photos s'affichent quand même (mais perdues à la fermeture).
  async function saveImageBatch(rawImgs) {
    if (!rawImgs.length) return 0;
    let savedCount = 0;
    let memoryFallbackCount = 0;
    let quotaHit = false;
    // Convertir tous les blobs en parallèle (parsing CPU)
    const records = await Promise.all(rawImgs.map(async (img) => {
      try {
        const blob = await base64ToBlob(img.data, img.type);
        return { key: img.key, profileId: img.profileId, index: img.index, blob, type: img.type, size: blob.size, addedAt: Date.now() };
      } catch (e) {
        console.warn('[store] base64 decode échoué:', img.key, e.message);
        return null;
      }
    }));
    const validRecords = records.filter(Boolean);
    if (!validRecords.length) return 0;

    // Save par lots de 5 pour limiter l'impact d'une transaction qui dépasse
    // le quota (Safari Privée plante TOUTE la transaction sur quota).
    const BATCH = 5;
    const db = await openDB();
    for (let i = 0; i < validRecords.length; i += BATCH) {
      const slice = validRecords.slice(i, i + BATCH);
      if (quotaHit) {
        // Une fois le quota atteint, on stocke uniquement en mémoire
        // (pas la peine de réessayer chaque batch).
        for (const rec of slice) setMemoryImage(rec.profileId, rec.index, rec.blob, rec.type);
        memoryFallbackCount += slice.length;
        continue;
      }
      try {
        await new Promise((resolve, reject) => {
          let t;
          try { t = db.transaction(STORE_IMAGES, 'readwrite'); }
          catch (e) { return reject(e); }
          const store = t.objectStore(STORE_IMAGES);
          try { for (const rec of slice) store.put(rec); }
          catch (e) { try { t.abort(); } catch {} ; return reject(e); }
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error('Transaction abortée'));
        });
        savedCount += slice.length;
      } catch (e) {
        const isQuota = e?.name === 'QuotaExceededError' || /quota/i.test(e?.message || '');
        if (isQuota) {
          console.warn(`[store] Quota IDB atteint après ${savedCount} images. Fallback mémoire.`);
          quotaHit = true;
          if (typeof window !== 'undefined') window.__idbQuotaHit = true;
          // Stocker ce slice + suivants en mémoire
          for (const rec of slice) setMemoryImage(rec.profileId, rec.index, rec.blob, rec.type);
          memoryFallbackCount += slice.length;
        } else {
          console.warn('[store] saveImageBatch erreur (continue, mémoire):', e.message);
          for (const rec of slice) setMemoryImage(rec.profileId, rec.index, rec.blob, rec.type);
          memoryFallbackCount += slice.length;
        }
      }
    }
    if (memoryFallbackCount > 0) {
      console.log(`[store] ${memoryFallbackCount} images en mémoire (non persistantes).`);
    }
    return savedCount + memoryFallbackCount;
  }

  // Format legacy : images dans le manifest
  if (manifest.images?.length) {
    totalImages += await saveImageBatch(manifest.images);
  }

  // Format chunked : lire tous les fichiers trombinoscope-images-*.json
  const chunkFiles = Object.keys(filesByName).filter(n => /^trombinoscope-images-\d+\.json$/.test(n)).sort();
  for (const fname of chunkFiles) {
    try {
      const chunk = JSON.parse(filesByName[fname]);
      if (chunk.images?.length) {
        totalImages += await saveImageBatch(chunk.images);
      }
    } catch (e) { console.warn(`Chunk ${fname} invalide:`, e.message); }
  }

  return { profiles: totalProfiles, images: totalImages };
}

// ============= UTILS =============

export function uid() {
  return 'p_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export async function base64ToBlob(b64, type) {
  const res = await fetch(b64);
  return res.blob();
}

// Nombre approximatif d'octets utilisés (utile pour l'UI "stockage")
export async function estimateUsage() {
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
  }
  return { usage: 0, quota: 0 };
}
