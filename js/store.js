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
  const store = await tx(STORE_PROFILES, 'readwrite');
  await reqToPromise(store.delete(id));
  // nettoyer les images associées
  const imgStore = await tx(STORE_IMAGES, 'readwrite');
  const range = IDBKeyRange.bound(`${id}::`, `${id}::￿`);
  const req = imgStore.openCursor(range);
  return new Promise((resolve) => {
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
  await reqToPromise(store.put({ key, profileId, index, blob, type: blob.type, size: blob.size, addedAt: Date.now() }));
  return key;
}

export async function getImage(key) {
  const store = await tx(STORE_IMAGES);
  return reqToPromise(store.get(key));
}

export async function getProfileImages(profileId) {
  const store = await tx(STORE_IMAGES);
  const range = IDBKeyRange.bound(`${profileId}::`, `${profileId}::￿`);
  const req = store.openCursor(range);
  const items = [];
  return new Promise((resolve) => {
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
  });
}

export async function deleteImage(key) {
  const store = await tx(STORE_IMAGES, 'readwrite');
  await reqToPromise(store.delete(key));
}

export async function deleteProfileImages(profileId) {
  const imgStore = await tx(STORE_IMAGES, 'readwrite');
  const range = IDBKeyRange.bound(`${profileId}::`, `${profileId}::￿`);
  const req = imgStore.openCursor(range);
  return new Promise((resolve) => {
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

export async function exportAll() {
  const profiles = await getAllProfiles();
  const out = {
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles,
    images: [],
  };
  // exporter les images en base64
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
