// Couche de stockage : IndexedDB pour les profils et images, localStorage pour les préférences UI
// Conçue pour scaler à plusieurs milliers de profils avec images en base64

import { profileFields, sameValue, stampsOf, maxStamp, stampChanges } from './merge.js';
export { profileFields, sameValue, stampsOf, maxStamp };

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

// ============= JOURNAL DES MODIFICATIONS LOCALES =============
// Chaque écriture locale (profil, image, suppression) est consignée dans un
// journal PERSISTANT (meta 'rt_pending') AVANT toute tentative d'envoi, puis
// signalée à la couche temps réel. Une entrée n'est retirée qu'après accusé
// de réception du serveur. Conséquence : une modification ne peut plus rester
// coincée sur un appareil — app fermée, hors-ligne, crash : elle repart au
// prochain lancement.

const changeListeners = new Set();
export function onLocalChange(cb) { changeListeners.add(cb); return () => changeListeners.delete(cb); }
function emitLocalChange(evt) {
  for (const cb of changeListeners) { try { cb(evt); } catch {} }
}

let pendingCache = null;
let pendingChain = Promise.resolve();
async function loadPending() {
  if (!pendingCache) {
    const v = await getMeta('rt_pending');
    pendingCache = (v && typeof v === 'object') ? v : {};
  }
  return pendingCache;
}

/** Consigne une modification locale de profil à envoyer ('upsert' | 'delete'). */
export function markPending(id, op = 'upsert') {
  if (!id) return pendingChain;
  pendingChain = pendingChain.then(async () => {
    const p = await loadPending();
    p[id] = { op, at: Date.now() };
    await setMeta('rt_pending', p);
  }).catch(() => {});
  return pendingChain;
}

export async function getPending() {
  await pendingChain;
  return { ...(await loadPending()) };
}

/** Retire une entrée, sauf si une modification plus récente est arrivée entre-temps. */
export function clearPending(id, at) {
  pendingChain = pendingChain.then(async () => {
    const p = await loadPending();
    if (p[id] && (at === undefined || p[id].at <= at)) {
      delete p[id];
      await setMeta('rt_pending', p);
    }
  }).catch(() => {});
  return pendingChain;
}

function noteLocalChange(id, op = 'upsert') {
  markPending(id, op);
  emitLocalChange({ id, op });
}

// ============= HORODATAGE PAR CHAMP =============
// Voir merge.js : chaque profil porte `_f` (horodatage de chaque champ, plus
// `imgs` pour le jeu de photos). La fusion entre appareils se fait champ par
// champ, le plus récent gagne.

/** Lecture-modification-écriture atomique d'un profil (une seule transaction IDB). */
function rmwProfile(id, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE_PROFILES, 'readwrite');
    const s = t.objectStore(STORE_PROFILES);
    let out;
    const g = s.get(id);
    g.onsuccess = () => {
      out = fn(g.result);
      if (out && out.write) s.put(out.write);
    };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction annulée'));
  }));
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

/**
 * Enregistre un profil complet. Seuls les champs réellement modifiés sont
 * horodatés ; une sauvegarde sans changement n'écrit rien (et ne synchronise rien).
 */
export async function saveProfile(profile) {
  if (!profile.id) profile.id = uid();
  if (!profile.createdAt) profile.createdAt = new Date().toISOString();
  delete profile.imgs; delete profile.deleted; delete profile.deletedAt;
  const res = await rmwProfile(profile.id, (prev) => {
    const now = Date.now();
    const next = { ...profile };
    const changed = stampChanges(next, prev, now);
    if (prev && !changed.length) return { saved: prev, changed };
    next.updatedAt = new Date(now).toISOString();
    return { write: next, saved: next, changed };
  });
  profile._f = res.saved._f;
  profile.updatedAt = res.saved.updatedAt;
  if (res.write) noteLocalChange(profile.id, 'upsert');
  return profile;
}

/**
 * Modifie QUELQUES champs d'un profil en partant de sa version la plus
 * récente en base (jamais d'une copie périmée en mémoire). Retourne le profil
 * à jour, ou null s'il n'existe plus.
 */
export async function patchProfile(id, patch) {
  const res = await rmwProfile(id, (prev) => {
    if (!prev) return { saved: null };
    const now = Date.now();
    const next = { ...prev, ...patch, id };
    const changed = stampChanges(next, prev, now);
    if (!changed.length) return { saved: prev };
    next.updatedAt = new Date(now).toISOString();
    return { write: next, saved: next };
  });
  if (res.write) noteLocalChange(id, 'upsert');
  return res.saved;
}

/** Note que le jeu de photos d'un profil a changé (horodatage `imgs`). */
async function touchImages(profileId) {
  await rmwProfile(profileId, (prev) => {
    if (!prev) return null;
    const now = Date.now();
    const next = { ...prev, _f: { ...stampsOf(prev), imgs: now }, updatedAt: new Date(now).toISOString() };
    return { write: next };
  }).catch(() => {});
}
async function noteImagesChange(profileId) {
  await touchImages(profileId);
  noteLocalChange(profileId, 'upsert');
}

export async function deleteProfile(id) {
  // Journal AVANT tout : la suppression doit partir vers les autres appareils
  // même si la suite échoue à mi-chemin.
  await markPending(id, 'delete');
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
  noteLocalChange(id, 'delete');
}

export async function bulkSaveProfiles(profiles) {
  const db = await openDB();
  const written = [];
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_PROFILES, 'readwrite');
    const store = t.objectStore(STORE_PROFILES);
    const now = Date.now();
    const iso = new Date(now).toISOString();
    for (const p of profiles) {
      if (!p.id) p.id = uid();
      if (!p.createdAt) p.createdAt = iso;
      delete p.imgs; delete p.deleted; delete p.deletedAt;
      const g = store.get(p.id);
      g.onsuccess = () => {
        const prev = g.result;
        const changed = stampChanges(p, prev, now);
        if (prev && !changed.length) return;
        p.updatedAt = iso;
        store.put(p);
        written.push(p.id);
      };
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction annulée'));
  });
  for (const id of written) noteLocalChange(id, 'upsert');
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
  await noteImagesChange(profileId);
  return key;
}

export async function getImage(key) {
  const store = await tx(STORE_IMAGES);
  return reqToPromise(store.get(key));
}

// Fallback in-memory image cache (utilisé quand IDB est plein/refuse,
// notamment en navigation privée Safari). Vit le temps de la session.
const memoryImages = new Map(); // profileId -> [imgRecord, ...]
export function setMemoryImage(profileId, index, blob, type, v) {
  const key = `${profileId}::${index}`;
  const list = memoryImages.get(profileId) || [];
  const filtered = list.filter(it => it.key !== key);
  filtered.push({ key, profileId, index, blob, type, size: blob.size, addedAt: Date.now(), inMemory: true, v });
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
  await noteImagesChange(pid);
}

export async function deleteProfileImages(profileId) {
  const had = memoryImages.delete(profileId); // purge le cache mémoire (voir deleteImage)
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
  if (keys.length || had) await noteImagesChange(profileId);
}

// ============= APPLICATION DES MODIFICATIONS DISTANTES =============
// Écritures venues du serveur : elles NE sont PAS consignées dans le journal
// et NE déclenchent PAS d'envoi (sinon boucle d'écho infinie entre appareils).

/** Écrit un profil tel quel (conserve ses horodatages d'origine). */
export async function putProfileRaw(profile) {
  const store = await tx(STORE_PROFILES, 'readwrite');
  await reqToPromise(store.put(profile));
}

/** Aligne l'horodatage du jeu de photos local sur celui du serveur. */
export async function setImagesStampRaw(id, stamp) {
  await rmwProfile(id, (prev) => {
    if (!prev) return null;
    return { write: { ...prev, _f: { ...stampsOf(prev), imgs: stamp } } };
  });
}

/** Supprime un profil et toutes ses images, sans journal ni tombstone. */
export async function deleteProfileRaw(id) {
  const store = await tx(STORE_PROFILES, 'readwrite');
  await reqToPromise(store.delete(id));
  memoryImages.delete(id);
  const imgStore = await tx(STORE_IMAGES, 'readwrite');
  const range = IDBKeyRange.bound(`${id}::`, `${id}::\uffff`);
  const keys = [];
  await new Promise((resolve) => {
    const req = imgStore.openCursor(range);
    req.onsuccess = () => {
      const c = req.result;
      if (c) { keys.push(c.value.key); c.delete(); c.continue(); } else resolve();
    };
    req.onerror = () => resolve();
  });
  try {
    const u = await import('./utils.js');
    for (const k of keys) u.revokeObjectURL(k);
  } catch {}
}

/** Écrit une image reçue du serveur (avec sa version v). Repli mémoire si quota. */
export async function putImageRaw(rec) {
  try {
    const store = await tx(STORE_IMAGES, 'readwrite');
    await reqToPromise(store.put(rec));
  } catch (e) {
    if (e?.name === 'QuotaExceededError') {
      setMemoryImage(rec.profileId, rec.index, rec.blob, rec.type, rec.v);
    } else {
      throw e;
    }
  }
  try {
    const u = await import('./utils.js');
    u.revokeObjectURL(rec.key);
  } catch {}
}

export async function deleteImageRaw(key) {
  const store = await tx(STORE_IMAGES, 'readwrite');
  await reqToPromise(store.delete(key));
  const pid = String(key).split('::')[0];
  const list = memoryImages.get(pid);
  if (list) {
    const filtered = list.filter(it => it.key !== key);
    if (filtered.length) memoryImages.set(pid, filtered); else memoryImages.delete(pid);
  }
  try {
    const u = await import('./utils.js');
    u.revokeObjectURL(key);
  } catch {}
}

/** Enregistre la version serveur d'une image locale (après envoi ou adoption). */
export async function setImageVersion(key, v) {
  const store = await tx(STORE_IMAGES, 'readwrite');
  const rec = await reqToPromise(store.get(key));
  if (rec) {
    rec.v = v;
    await reqToPromise(store.put(rec));
    return;
  }
  const pid = String(key).split('::')[0];
  const mem = memoryImages.get(pid);
  const m = mem?.find(it => it.key === key);
  if (m) m.v = v;
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

// ============= TOMBSTONES (ancien système) =============
// Les suppressions passent désormais par le journal (rt_pending) puis une
// pierre tombale côté serveur. On ne lit plus les anciennes tombstones locales
// qu'une fois, pour la migration vers le temps réel.

export async function getTombstones() {
  const list = (await getMeta('tombstones')) || [];
  return Array.isArray(list) ? list : [];
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

export async function importAll(data, { replace = false } = {}) {
  const incoming = (data.profiles || []).filter((p) => p && p.id);
  const incomingIds = new Set(incoming.map((p) => p.id));
  if (replace) {
    // « Remplacer » = l'état du fichier devient l'état partagé : les profils
    // absents du fichier sont supprimés (sur tous les appareils).
    for (const p of await getAllProfiles()) {
      if (!incomingIds.has(p.id)) await deleteProfile(p.id);
    }
  }
  if (incoming.length) {
    for (const p of incoming) delete p._f; // les champs importés sont des modifications d'aujourd'hui
    await bulkSaveProfiles(incoming);
  }
  if (data.images?.length) {
    // On convertit TOUS les blobs AVANT d'ouvrir la transaction : base64ToBlob
    // fait un `await fetch(dataURL)` (frontière de tâche) qui ferait s'auto-
    // commit une transaction IDB ouverte trop tôt → TransactionInactiveError.
    const records = [];
    for (const img of data.images) {
      if (!img?.profileId || !incomingIds.has(img.profileId)) continue;
      try {
        const blob = await base64ToBlob(img.data, img.type);
        records.push({ key: `${img.profileId}::${img.index}`, profileId: img.profileId, index: img.index, blob, type: img.type || blob.type, size: blob.size, addedAt: Date.now() });
      } catch (e) { console.warn('[store] image de sauvegarde illisible, ignorée :', img.key, e.message); }
    }
    const pids = new Set(records.map((r) => r.profileId));
    if (replace) for (const pid of pids) await deleteProfileImages(pid);
    if (records.length) {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const t = db.transaction(STORE_IMAGES, 'readwrite');
        const store = t.objectStore(STORE_IMAGES);
        for (const rec of records) store.put(rec);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction annulée'));
      });
      for (const pid of pids) await noteImagesChange(pid);
    }
  }
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
