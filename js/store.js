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
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onsuccess = () => {
      const db = req.result;
      // Si le navigateur ferme la connexion de force (Safari sous pression
      // mémoire) ou qu'une autre tab upgrade la base, on invalide le cache
      // pour rouvrir à la prochaine opération (sinon InvalidStateError à vie).
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch {} dbPromise = null; };
      resolve(db);
    };
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

/**
 * Nettoyage one-shot : retire de l'IDB les images dont le profileId
 * n'existe plus dans la table profiles. Évite de garder des images
 * orphelines qui peuvent réapparaître à la suite d'un import buggé.
 * À appeler au boot après chargement initial des profils.
 */
export async function cleanupOrphanImages() {
  try {
    const profiles = await getAllProfiles();
    const validIds = new Set(profiles.map(p => p.id).filter(Boolean));
    const db = await openDB();
    const t = db.transaction(STORE_IMAGES, 'readwrite');
    const store = t.objectStore(STORE_IMAGES);
    let removed = 0;
    await new Promise((resolve) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const v = cursor.value;
          // Pas de profileId OU profileId pas dans les profils → orphelin
          if (!v.profileId || !validIds.has(v.profileId)) {
            cursor.delete();
            removed++;
          }
          cursor.continue();
        } else resolve();
      };
      req.onerror = () => resolve();
    });
    if (removed > 0) console.warn(`[store] ${removed} images orphelines nettoyées de l'IDB.`);
    return removed;
  } catch (e) {
    console.warn('[store] cleanupOrphanImages erreur:', e.message);
    return 0;
  }
}

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
  // Tombstone AVANT tout : la suppression doit se propager aux autres devices
  // même si la suite échoue à mi-chemin.
  await addTombstone(id).catch(() => {});
  // Récupérer les keys d'images pour révoquer les objectURL avant suppression
  const imgs = await getProfileImages(id).catch(() => []);
  const store = await tx(STORE_PROFILES, 'readwrite');
  await reqToPromise(store.delete(id));
  memoryImages.delete(id); // purge le cache mémoire (fallback quota)
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
    req.onerror = () => resolve(); // ne jamais laisser l'await pendant à vie
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
  // Purger aussi le cache mémoire (fallback quota Safari privé), sinon
  // getProfileImages refusionne la copie mémoire → l'image « supprimée »
  // réapparaît et est re-poussée au cloud.
  const pid = String(key).split('::')[0];
  const list = memoryImages.get(pid);
  if (list) {
    const filtered = list.filter(it => it.key !== key);
    if (filtered.length) memoryImages.set(pid, filtered); else memoryImages.delete(pid);
  }
}

export async function deleteProfileImages(profileId) {
  memoryImages.delete(profileId); // purge le cache mémoire (voir deleteImage)
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
    req.onerror = () => resolve(); // ne jamais laisser l'await pendant à vie
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

/**
 * Vide entièrement les profils ET les images (sans toucher aux préférences/meta).
 * Utilisé par la migration one-shot de dédoublonnage. Ne crée PAS de tombstones
 * (ce n'est pas une suppression volontaire de profils, juste une réadoption cloud).
 */
export async function clearAllProfilesAndImages() {
  memoryImages.clear(); // purge le cache mémoire (fallback quota)
  const db = await openDB();
  const t = db.transaction([STORE_PROFILES, STORE_IMAGES], 'readwrite');
  t.objectStore(STORE_PROFILES).clear();
  t.objectStore(STORE_IMAGES).clear();
  await new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('clear abort'));
  });
  try {
    const u = await import('./utils.js');
    u.clearObjectURLs?.();
  } catch {}
}

// ============= TOMBSTONES (propagation des suppressions) =============
// Quand un profil est supprimé, on garde une trace {id, deletedAt} qui voyage
// dans le manifest cloud. Sans ça, un device qui a encore le profil le
// "ressusciterait" à son prochain push (les push sont des snapshots complets).

const TOMBSTONE_TTL_MS = 60 * 24 * 3600 * 1000; // 60 jours puis purge

export async function getTombstones() {
  const list = (await getMeta('tombstones')) || [];
  return Array.isArray(list) ? list : [];
}

export async function addTombstone(id) {
  const list = await getTombstones();
  const now = new Date().toISOString();
  const filtered = list.filter(t => t.id !== id);
  filtered.push({ id, deletedAt: now });
  await setMeta('tombstones', pruneTombstones(filtered));
}

export function pruneTombstones(list) {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  return (list || []).filter(t => (Date.parse(t.deletedAt) || 0) > cutoff);
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
  const tombstones = pruneTombstones(await getTombstones());
  const manifest = {
    version: 3,
    exportedAt: new Date().toISOString(),
    profiles,
    tombstones,
    imageChunks: chunks.length,
    totalImages: allImages.length,
  };
  // Pretty-print pour le manifest (lisible si l'user inspecte le repo GitHub).
  result.files['trombinoscope.json'] = JSON.stringify(manifest, null, 2);
  result.totalSize += result.files['trombinoscope.json'].length;

  // Fichiers de chunks (pas de pretty-print : ils sont volumineux et binaires-lookalike)
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
    // On convertit TOUS les blobs AVANT d'ouvrir la transaction : base64ToBlob
    // fait un `await fetch(dataURL)` (frontière de tâche) qui ferait s'auto-
    // commit une transaction IDB ouverte trop tôt → TransactionInactiveError
    // dès le 1er put (l'import d'images d'un backup ne marchait jamais).
    const records = [];
    for (const img of data.images) {
      try {
        const blob = await base64ToBlob(img.data, img.type);
        records.push({ key: img.key, profileId: img.profileId, index: img.index, blob, type: img.type, size: blob.size, addedAt: Date.now() });
      } catch (e) { console.warn('[store] image backup illisible, ignorée:', img.key, e.message); }
    }
    if (records.length) {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const t = db.transaction(STORE_IMAGES, 'readwrite');
        const store = t.objectStore(STORE_IMAGES);
        for (const rec of records) store.put(rec);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('tx abort'));
      });
    }
  }
}

/**
 * Import "chunked" : prend un objet { 'trombinoscope.json': string, 'trombinoscope-images-NNN.json': string, ... }
 * et restaure tout. Compatible avec l'ancien format si un seul fichier "trombinoscope.json" est fourni.
 */
export async function importAllChunked(filesByName, { replace = true, mergeByUpdatedAt = true } = {}) {
  const manifestStr = filesByName['trombinoscope.json'];
  if (!manifestStr) throw new Error('trombinoscope.json manquant');
  const manifest = JSON.parse(manifestStr);
  let totalProfiles = 0, totalImages = 0;
  // Stats de convergence : si le local a des données plus récentes ou des
  // profils que le distant n'a pas, l'appelant DOIT re-pusher (sinon ces
  // données n'atteindront jamais les autres appareils).
  const stats = { localNewer: 0, localOnly: 0, remoteApplied: 0, deletedByTombstone: 0 };

  // Mode destructif explicite (import manuel "Remplacer tout") uniquement.
  if (replace && !mergeByUpdatedAt) {
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

  if (mergeByUpdatedAt) {
    // ===== MERGE PAR PROFIL (last-write-wins sur updatedAt) + TOMBSTONES =====
    const localProfiles = await getAllProfiles();
    const localById = new Map(localProfiles.map(p => [p.id, p]));
    const remoteProfiles = (manifest.profiles || []).filter(p => p && p.id);
    const remoteById = new Map(remoteProfiles.map(p => [p.id, p]));

    // 1. Fusion des tombstones (union, deletedAt le plus récent par id)
    const localTombs = await getTombstones();
    const remoteTombs = Array.isArray(manifest.tombstones) ? manifest.tombstones : [];
    const tombById = new Map();
    for (const t of [...localTombs, ...remoteTombs]) {
      if (!t || !t.id) continue;
      const prev = tombById.get(t.id);
      if (!prev || (Date.parse(t.deletedAt) || 0) > (Date.parse(prev.deletedAt) || 0)) {
        tombById.set(t.id, t);
      }
    }

    // 2. Appliquer les tombstones : un profil modifié APRÈS sa suppression
    //    ailleurs ressuscite (on retire la pierre tombale) ; sinon il meurt
    //    partout. C'est ce qui fait qu'une suppression sur l'appareil A ne
    //    revient pas par le push snapshot de l'appareil B.
    for (const [id, tomb] of [...tombById]) {
      const ts = Date.parse(tomb.deletedAt) || 0;
      const local = localById.get(id);
      const remote = remoteById.get(id);
      const localTs = local ? (Date.parse(local.updatedAt) || 0) : -1;
      const remoteTs = remote ? (Date.parse(remote.updatedAt) || 0) : -1;
      if (localTs > ts || remoteTs > ts) {
        tombById.delete(id); // résurrection : édition postérieure à la suppression
        continue;
      }
      if (local) {
        // Suppression directe (ne PAS repasser par deleteProfile, qui
        // re-tamponnerait le tombstone à maintenant).
        const store = await tx(STORE_PROFILES, 'readwrite');
        await reqToPromise(store.delete(id)).catch(() => {});
        await deleteProfileImages(id).catch(() => {});
        localById.delete(id);
        stats.deletedByTombstone++;
      }
      // Le cloud contient encore ce profil supprimé → il faut re-pousser pour
      // l'en retirer (sinon un autre appareil le verrait toujours).
      if (remote) stats.localNewer++;
      remoteById.delete(id); // ne pas réimporter un profil supprimé
    }
    // #11 : re-lire les tombstones juste avant d'écrire — une suppression
    // concurrente (addTombstone) survenue PENDANT ce long merge serait sinon
    // écrasée par cette écriture (le profil ressusciterait au prochain pull).
    const freshTombs = await getTombstones().catch(() => []);
    for (const t of freshTombs) {
      if (!t || !t.id) continue;
      const prev = tombById.get(t.id);
      if (!prev || (Date.parse(t.deletedAt) || 0) > (Date.parse(prev.deletedAt) || 0)) tombById.set(t.id, t);
      // ne pas réimporter un profil fraîchement supprimé pendant ce merge
      remoteById.delete(t.id);
      localById.delete(t.id);
    }
    await setMeta('tombstones', pruneTombstones([...tombById.values()]));

    // 3. Merge des profils : le updatedAt distant est PRÉSERVÉ tel quel.
    //    (Surtout pas bulkSaveProfiles ici : il écrase updatedAt avec "now",
    //    ce qui faisait croire à ce device qu'il avait la version la plus
    //    récente de TOUT → son push suivant écrasait les modifs des autres.)
    const toSave = [];
    for (const [id, remote] of remoteById) {
      const local = localById.get(id);
      if (!local) {
        toSave.push(remote);
        stats.remoteApplied++;
      } else {
        const remoteTs = Date.parse(remote.updatedAt) || 0;
        const localTs = Date.parse(local.updatedAt) || 0;
        if (remoteTs > localTs) {
          toSave.push(remote);
          stats.remoteApplied++;
        } else if (localTs > remoteTs) {
          stats.localNewer++;
        } else if (JSON.stringify(remote) !== JSON.stringify(local)) {
          // updatedAt ÉGAUX mais contenus différents (deux édits dans la même
          // ms, ou updatedAt manquant/invalide → 0 des deux côtés) : sans
          // départage, chaque appareil gardait sa version À VIE (divergence
          // silencieuse). On tranche déterministiquement pour le DISTANT →
          // tous convergent (et localNewer non incrémenté : pas de push inutile).
          toSave.push(remote);
          stats.remoteApplied++;
        }
      }
    }
    // Profils locaux absents du distant (et non tombstonés) = ajouts locaux
    // pas encore pushés → on les GARDE et on signale qu'un push est requis.
    for (const [id] of localById) {
      if (!remoteById.has(id) && !tombById.has(id)) stats.localOnly++;
    }
    if (toSave.length) {
      const db = await openDB();
      const t = db.transaction(STORE_PROFILES, 'readwrite');
      const store = t.objectStore(STORE_PROFILES);
      for (const p of toSave) store.put(p);
      await new Promise((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('tx abort'));
      });
    }
    totalProfiles = remoteProfiles.length;
  } else if (manifest.profiles?.length) {
    await bulkSaveProfiles(manifest.profiles);
    totalProfiles = manifest.profiles.length;
  }

  // VALIDATION IMAGES : on retient les profileId valides du manifest pour
  // ignorer les images orphelines (chunks corrompus d'un push partiel passé).
  // Évite la cross-contamination de photos entre profils.
  const validProfileIds = new Set(
    (manifest.profiles || []).map(p => p.id).filter(Boolean)
  );
  // Aussi accepter les profileId locaux non encore pushés
  try {
    const allLocal = await getAllProfiles();
    for (const p of allLocal) if (p.id) validProfileIds.add(p.id);
  } catch {}

  // Helper qui save une liste d'images. Robuste aux quotas IndexedDB
  // (Safari Privée : ~1MB de limite). Sur quota, fallback en mémoire pour
  // que les photos s'affichent quand même (mais perdues à la fermeture).
  async function saveImageBatch(rawImgs) {
    if (!rawImgs.length) return 0;
    let savedCount = 0;
    let memoryFallbackCount = 0;
    let quotaHit = false;
    let droppedOrphans = 0;
    // Convertir tous les blobs en parallèle (parsing CPU)
    const records = await Promise.all(rawImgs.map(async (img) => {
      try {
        // ANTI-CONTAMINATION : refuser les images dont le profileId n'est ni
        // dans le manifest ni dans les profils locaux. Évite les chunks
        // corrompus d'écrire des photos sur des id orphelins (qui pouvaient
        // cross-contaminer après merge).
        if (img.profileId && !validProfileIds.has(img.profileId)) {
          droppedOrphans++;
          return null;
        }
        // Validation cohérence key === profileId::index
        if (img.key && img.profileId && img.key !== `${img.profileId}::${img.index}`) {
          console.warn('[store] image clé incohérente, skip:', img.key);
          droppedOrphans++;
          return null;
        }
        const blob = await base64ToBlob(img.data, img.type);
        return { key: img.key, profileId: img.profileId, index: img.index, blob, type: img.type, size: blob.size, addedAt: Date.now() };
      } catch (e) {
        console.warn('[store] base64 decode échoué:', img.key, e.message);
        return null;
      }
    }));
    if (droppedOrphans) console.warn(`[store] ${droppedOrphans} images orphelines/incohérentes ignorées (anti-contamination).`);
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

  return { profiles: totalProfiles, images: totalImages, ...stats };
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
