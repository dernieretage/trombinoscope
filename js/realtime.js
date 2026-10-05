// Synchronisation TEMPS RÉEL du Trombinoscope — Firebase Firestore.
//
// Modèle :
//  - Firestore est la source de vérité partagée. IndexedDB (store.js) est le
//    miroir local que l'interface lit ; ce module tient les deux alignés.
//  - Tout vit dans un ESPACE : spaces/{spaceId}/… — spaceId est un secret
//    dérivé du mot de passe d'entrée (auth.js). Sans lui, rien n'est lisible.
//  - spaces/{s}/profiles/{id} : champs du profil + `_f` (horodatage par champ)
//    + `imgs` ({index: version}) + `deleted` (suppression douce : un appareil
//    hors-ligne l'apprend à sa reconnexion).
//  - spaces/{s}/images/{profileId::index::version} : une photo en base64.
//  - Distant → local : écoute en direct des profils ; une photo n'est
//    téléchargée que si sa version change.
//  - Local → distant : chaque écriture locale est consignée dans le journal
//    persistant de store.js, envoyée dans une TRANSACTION qui fusionne avec la
//    version serveur (merge.js, champ par champ), puis retirée du journal à
//    l'accusé du serveur. Rien ne peut rester coincé sur un appareil.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  initializeFirestore, memoryLocalCache, connectFirestoreEmulator,
  collection, doc, onSnapshot, setDoc, deleteDoc, getDoc, getDocs, getDocsFromServer,
  query, where, runTransaction, waitForPendingWrites, disableNetwork, enableNetwork,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getAuth, signInAnonymously, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { FIREBASE_CONFIG } from './firebase-config.js';
import {
  getAllProfiles, getProfile, getProfileImages, putProfileRaw, deleteProfileRaw,
  putImageRaw, deleteImageRaw, setImageVersion, onLocalChange, getPending, clearPending,
  markPending, blobToBase64, base64ToBlob,
} from './store.js';
import { mergeProfiles, stampsOf, maxStamp, ts } from './merge.js';
import { downscaleImage } from './utils.js';

const IS_DEV_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const MAX_IMAGE_B64 = 900_000;   // marge sous la limite Firestore d'1 Mio par document
const WRITE_TIMEOUT_MS = 90_000;

// ============= CONFIGURATION =============

let configPromise = null;
/** Config Firebase : en développement local, js/firebase-config.local.js (non versionné) a priorité. */
export function loadRealtimeConfig() {
  if (!configPromise) {
    configPromise = (async () => {
      if (IS_DEV_HOST) {
        try {
          const m = await import('./firebase-config.local.js');
          if (m?.FIREBASE_CONFIG?.projectId) return m.FIREBASE_CONFIG;
        } catch {}
      }
      return FIREBASE_CONFIG || {};
    })();
  }
  return configPromise;
}
export function isConfigured(cfg) {
  return !!(cfg && cfg.apiKey && cfg.projectId && !/^REMPLACER/.test(cfg.apiKey));
}

// ============= ÉTAT =============

let db = null;
let auth = null;
let spaceId = null;
let started = false;
let signedIn = false;
let connected = false;          // le dernier instantané vient du serveur (pas du cache)
let firstServerSyncDone = false;
let lastError = null;
let pendingCount = 0;
const remote = new Map();       // id -> dernier document profil connu du serveur

const newVersion = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const col = (name) => collection(db, 'spaces', spaceId, name);
const profileRef = (id) => doc(db, 'spaces', spaceId, 'profiles', id);
const imageRef = (profileId, idx, v) => doc(db, 'spaces', spaceId, 'images', `${profileId}::${idx}::${v}`);

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`délai dépassé (${label})`)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ============= STATUT =============

const statusListeners = new Set();
export function onRealtimeStatus(cb) {
  statusListeners.add(cb);
  try { cb(getRealtimeStatus()); } catch {}
  return () => statusListeners.delete(cb);
}
export function getRealtimeStatus() {
  if (!started) return { state: 'off', pending: pendingCount };
  if (lastError) return { state: 'error', error: lastError, pending: pendingCount };
  if (!connected) return { state: navigator.onLine === false ? 'offline' : 'connecting', pending: pendingCount };
  return { state: pendingCount ? 'saving' : 'synced', pending: pendingCount };
}
function emitStatus() {
  const s = getRealtimeStatus();
  for (const cb of statusListeners) { try { cb(s); } catch {} }
}
async function refreshPendingCount() {
  const n = Object.keys(await getPending()).length;
  if (n !== pendingCount) { pendingCount = n; emitStatus(); }
}

// ============= NOTIFICATION DE L'INTERFACE =============

let changeCb = null;
let changedIds = new Set();
let changeTimer = null;
function notifyChanged(id) {
  if (id) changedIds.add(id);
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const ids = changedIds;
    changedIds = new Set();
    try { changeCb?.({ ids }); } catch (e) { console.warn('[RT] onChange', e); }
  }, 120);
}

// ============= IMAGES : PRÉPARATION À L'ENVOI =============

/** Base64 d'une photo, réduite si nécessaire pour tenir dans un document Firestore. */
async function imageForUpload(img) {
  let blob = img.blob;
  let data = await blobToBase64(blob);
  const steps = [[1080, 0.8], [800, 0.7], [600, 0.6]];
  for (const [maxDim, quality] of steps) {
    if (data.length <= MAX_IMAGE_B64) break;
    blob = await downscaleImage(blob, { maxDim, quality });
    data = await blobToBase64(blob);
  }
  if (data.length > MAX_IMAGE_B64) throw new Error('photo trop lourde');
  if (blob !== img.blob) {
    // On garde localement la même version que celle envoyée.
    await putImageRaw({ ...img, blob, type: blob.type, size: blob.size });
  }
  return { data, type: blob.type || img.type || 'image/jpeg' };
}

// ============= LOCAL → DISTANT =============

const pushTimers = new Map();
const preparing = new Set();
const attempts = new Map();
function schedulePush(id, delay = 350) {
  if (!id) return;
  clearTimeout(pushTimers.get(id));
  pushTimers.set(id, setTimeout(() => { pushTimers.delete(id); pushProfile(id); }, delay));
}
function retryLater(id, e) {
  const n = (attempts.get(id) || 0) + 1;
  attempts.set(id, n);
  const delay = Math.min(60_000, 4000 * 2 ** Math.min(n, 4));
  console.warn('[RT] envoi différé', id, e?.code || e?.message, `(réessai dans ${Math.round(delay / 1000)} s)`);
  if (/permission-denied/i.test(e?.code || '')) { lastError = 'permission'; emitStatus(); }
  else if (/unauthenticated/i.test(e?.code || '')) { signedIn = false; ensureSignedIn(); }
  schedulePush(id, delay);
}

const MAX_CONCURRENT_PUSH = 3;
let activePush = 0;
const pushWaiting = [];
function acquirePush() {
  if (activePush < MAX_CONCURRENT_PUSH) { activePush++; return Promise.resolve(); }
  return new Promise((r) => pushWaiting.push(r));
}
function releasePush() {
  const next = pushWaiting.shift();
  if (next) next(); else activePush--;
}

async function pushProfile(id) {
  if (!db || !signedIn) { schedulePush(id, 3000); return; }
  if (navigator.onLine === false) return; // repart sur l'événement 'online'
  if (preparing.has(id)) { schedulePush(id, 500); return; }
  preparing.add(id);
  await acquirePush();
  try {
    const pend = (await getPending())[id];
    if (!pend) return;
    const local = await getProfile(id);
    let known = remote.get(id) || null;
    if (!known) {
      // Profil jamais vu dans l'écoute : on lit le serveur AVANT d'envoyer des
      // photos (sinon un appareil qui démarre ré-enverrait tout en double).
      const snap = await withTimeout(getDoc(profileRef(id)), WRITE_TIMEOUT_MS, 'lecture');
      if (snap.exists()) { known = snap.data(); remote.set(id, known); }
    }

    // ----- Suppression (uniquement si explicitement demandée) -----
    if (pend.op !== 'delete' && !local) { await clearPending(id, pend.at); return; }
    if (pend.op === 'delete') {
      const pre = mergeProfiles(null, known, { pendingDeleteAt: pend.at });
      if (known && !known.deleted && !pre.deleted) {
        // Modifié ailleurs APRÈS notre suppression → il revit ici.
        await clearPending(id, pend.at);
        await applyRemote(id, known);
        return;
      }
      const iso = new Date(pend.at).toISOString();
      const outcome = await withTimeout(runTransaction(db, async (tx) => {
        const snap = await tx.get(profileRef(id));
        const r = snap.exists() ? snap.data() : null;
        if (r && !r.deleted && maxStamp(r) > pend.at) return { revive: r };
        tx.set(profileRef(id), { id, deleted: true, deletedAt: iso, updatedAt: iso, _f: {}, imgs: {} });
        return { oldImgs: (r && r.imgs) || {} };
      }), WRITE_TIMEOUT_MS, 'suppression');
      if (outcome.revive) {
        await clearPending(id, pend.at);
        await applyRemote(id, outcome.revive);
        return;
      }
      for (const [idx, v] of Object.entries(outcome.oldImgs)) deleteDoc(imageRef(id, idx, v)).catch(() => {});
      await clearPending(id, pend.at);
      attempts.delete(id);
      return;
    }

    // ----- Création / modification -----
    // 1) Photos d'abord : le document profil ne doit référencer que des photos
    //    déjà sur le serveur. Inutile si le serveur a un jeu plus récent.
    const localImgsStamp = stampsOf(local).imgs;
    const serverImgs = (known && !known.deleted && known.imgs) || {};
    const serverImgsStamp = known && !known.deleted ? stampsOf(known).imgs : -1;
    const localImgs = (await getProfileImages(id)).filter((i) => i.blob);
    const imgsMap = {};
    const uploaded = [];
    if (localImgsStamp > serverImgsStamp) {
      for (const img of localImgs) {
        const idx = String(img.index);
        let v = img.v;
        if (!(v && serverImgs[idx] === v)) {
          if (!v) v = newVersion();
          const { data, type } = await imageForUpload(img);
          await withTimeout(setDoc(imageRef(id, idx, v), { profileId: id, index: img.index, type, data, v }), WRITE_TIMEOUT_MS, 'photo');
          uploaded.push([idx, v]);
        }
        imgsMap[idx] = v;
      }
    }

    // 2) Le profil, fusionné avec la version serveur dans une transaction.
    const outcome = await withTimeout(runTransaction(db, async (tx) => {
      const snap = await tx.get(profileRef(id));
      const r = snap.exists() ? snap.data() : null;
      const m = mergeProfiles(local, r);
      if (m.deleted) return { m, r };
      if (m.imgs === 'local' && localImgsStamp <= serverImgsStamp) return { m, r, redo: true };
      const out = { ...m.result, deleted: false, imgs: m.imgs === 'local' ? imgsMap : ((r && r.imgs) || imgsMap) };
      if (m.pushNeeded || !r || r.deleted) tx.set(profileRef(id), out);
      return { m, r, out };
    }), WRITE_TIMEOUT_MS, 'profil');

    if (outcome.redo) { schedulePush(id, 200); return; }
    const { m, r, out } = outcome;
    if (m.deleted) { // supprimé sur le serveur après nos modifications → on suit
      await deleteProfileRaw(id);
      await clearPending(id, pend.at);
      notifyChanged(id);
      return;
    }
    remote.set(id, out);
    if (m.localChanged) { await putProfileRaw(m.result); notifyChanged(id); }
    // Versions locales = ce que le document profil référence désormais
    // (adoption si le jeu est identique ; téléchargement si le serveur a gagné).
    if (m.imgs === 'remote') {
      queueImages(id, false);
    } else {
      for (const img of localImgs) {
        const v = out.imgs[String(img.index)];
        if (v && img.v !== v) await setImageVersion(img.key, v);
      }
    }
    // Ménage : toute photo de ce profil non référencée (ancienne version, envoi
    // devenu inutile, reste d'un envoi interrompu) est supprimée.
    if (uploaded.length || (r && r.imgs && Object.entries(r.imgs).some(([i, v]) => out.imgs[i] !== v))) {
      cleanupImageDocs(id, out.imgs).catch(() => {});
    }
    await clearPending(id, pend.at);
    attempts.delete(id);
  } catch (e) {
    retryLater(id, e);
  } finally {
    releasePush();
    preparing.delete(id);
    refreshPendingCount();
  }
}

/** Supprime les documents photos d'un profil qui ne sont plus référencés. */
async function cleanupImageDocs(id, referenced) {
  const snap = await getDocs(query(col('images'), where('profileId', '==', id)));
  for (const d of snap.docs) {
    const x = d.data();
    if (referenced[String(x.index)] !== x.v) await deleteDoc(d.ref).catch(() => {});
  }
}

// ============= DISTANT → LOCAL =============

/** Applique un document profil reçu du serveur (fusion champ par champ). */
async function applyRemote(id, data) {
  const [local, pendAll] = await Promise.all([getProfile(id), getPending()]);
  if (pendAll[id]) { schedulePush(id, 100); return; } // l'envoi en attente fusionnera
  const m = mergeProfiles(local, data);
  if (m.deleted) {
    if (local) { await deleteProfileRaw(id); notifyChanged(id); }
    return;
  }
  if (m.pushNeeded) { await markPending(id); schedulePush(id); }
  if (m.localChanged) { await putProfileRaw(m.result); notifyChanged(id); }
  if (!m.pushNeeded) queueImages(id, m.imgs === 'same');
}

// ----- Photos : file de téléchargement à concurrence limitée -----
const imgQueue = [];
const imgQueued = new Set();
let imgActive = 0;
function queueImages(id, adopt) {
  if (imgQueued.has(id)) return;
  imgQueued.add(id);
  imgQueue.push({ id, adopt });
  pumpImages();
}
function pumpImages() {
  while (imgActive < 4 && imgQueue.length) {
    const job = imgQueue.shift();
    imgQueued.delete(job.id);
    imgActive++;
    syncImages(job.id, job.adopt)
      .then((changed) => { if (changed) notifyChanged(job.id); })
      .catch((e) => console.warn('[RT] photos', job.id, e?.message))
      .finally(() => { imgActive--; pumpImages(); });
  }
}

/**
 * Aligne les photos locales d'un profil sur le serveur.
 * `adopt` : même jeu de photos des deux côtés → une photo locale sans version
 * est celle du serveur ; on adopte sa version sans la re-télécharger.
 */
async function syncImages(id, adopt) {
  const r = remote.get(id);
  if (!r || r.deleted) return false;
  if ((await getPending())[id]) return false; // modifs locales non envoyées : l'envoi tranchera
  const remoteImgs = r.imgs || {};
  const local = await getProfileImages(id);
  const byIdx = new Map(local.map((i) => [String(i.index), i]));
  let changed = false;
  for (const [idx, v] of Object.entries(remoteImgs)) {
    const li = byIdx.get(idx);
    if (li && li.v === v) continue;
    if (li && !li.v && adopt) { await setImageVersion(li.key, v); continue; }
    try {
      const snap = await getDoc(imageRef(id, idx, v));
      if (!snap.exists()) continue; // envoi encore en cours ailleurs : le prochain passage l'aura
      const d = snap.data();
      const blob = await base64ToBlob(d.data, d.type);
      await putImageRaw({
        key: `${id}::${idx}`, profileId: id, index: Number(idx), blob,
        type: d.type || blob.type, size: blob.size, addedAt: Date.now(), v,
      });
      changed = true;
    } catch (e) {
      console.warn('[RT] photo', `${id}::${idx}`, e?.message);
    }
  }
  for (const li of local) {
    if (!(String(li.index) in remoteImgs)) { await deleteImageRaw(li.key); changed = true; }
  }
  return changed;
}

// ============= ÉCOUTE EN DIRECT =============

let snapChain = Promise.resolve();
let unsubscribe = null;
function listen() {
  if (unsubscribe) return;
  unsubscribe = onSnapshot(col('profiles'), { includeMetadataChanges: true }, (snap) => {
    snapChain = snapChain.then(() => processSnapshot(snap)).catch((e) => console.warn('[RT] instantané', e));
  }, (err) => {
    lastError = err?.code || err?.message || 'erreur';
    unsubscribe = null;
    emitStatus();
    if (/unauthenticated/i.test(lastError)) { signedIn = false; ensureSignedIn(); }
    else setTimeout(() => { if (started) listen(); }, 10_000);
  });
}

async function processSnapshot(snap) {
  const wasConnected = connected;
  connected = !snap.metadata.fromCache;
  if (connected && lastError && lastError !== 'permission') lastError = null;
  for (const ch of snap.docChanges({ includeMetadataChanges: true })) {
    const id = ch.doc.id;
    if (ch.type === 'removed') { // supprimé en dur (console Firebase)
      remote.delete(id);
      if (!ch.doc.metadata.hasPendingWrites && !(await getPending())[id] && await getProfile(id)) {
        await deleteProfileRaw(id);
        notifyChanged(id);
      }
      continue;
    }
    const data = ch.doc.data();
    remote.set(id, data);
    if (ch.doc.metadata.hasPendingWrites) continue; // notre propre écriture, déjà en local
    await applyRemote(id, data);
  }
  if (connected && !firstServerSyncDone) {
    firstServerSyncDone = true;
    await reconcileAll();
    notifyChanged();
  } else if (connected && !wasConnected) {
    // Retour du serveur après une coupure : on renvoie tout de suite ce qui attend.
    attempts.clear();
    await reconcileAll();
  }
  if (wasConnected !== connected || !wasConnected) emitStatus();
}

/**
 * Filet de sécurité : tout profil local absent du serveur, plus récent que
 * lui sur un champ, ou présent dans le journal → envoyé. Rejoué au premier
 * contact serveur, au retour du réseau, au retour au premier plan et toutes
 * les 60 s.
 */
async function reconcileAll() {
  if (!firstServerSyncDone) return; // sans la carte serveur, tout profil local passerait pour nouveau
  const [local, pend] = await Promise.all([getAllProfiles(), getPending()]);
  for (const p of local) {
    if (pend[p.id]) continue;
    const r = remote.get(p.id) || null;
    const m = mergeProfiles(p, r);
    if (m.deleted) { await deleteProfileRaw(p.id); notifyChanged(p.id); continue; }
    if (m.pushNeeded) { await markPending(p.id); schedulePush(p.id, 50); }
    if (m.localChanged) { await putProfileRaw(m.result); notifyChanged(p.id); }
    if (!m.pushNeeded && r) queueImages(p.id, m.imgs === 'same');
  }
  for (const id of Object.keys(pend)) schedulePush(id, 50);
  refreshPendingCount();
}

// ============= CONNEXION =============

let signInTimer = null;
async function ensureSignedIn() {
  if (signedIn || !auth) return;
  clearTimeout(signInTimer);
  try {
    await signInAnonymously(auth);
    signedIn = true;
    if (lastError && /auth/.test(lastError)) lastError = null;
    emitStatus();
    listen(); // le premier instantané serveur déclenche reconcileAll()
  } catch (e) {
    const code = e?.code || e?.message || '';
    // Erreur de configuration (fournisseur anonyme désactivé, clé invalide) :
    // on le dit ; erreur réseau : on réessaie en silence.
    if (/operation-not-allowed|api-key|app-not-authorized|invalid/i.test(code)) lastError = 'auth:' + code;
    emitStatus();
    signInTimer = setTimeout(ensureSignedIn, 8000);
  }
}

// ============= API PUBLIQUE =============

export async function startRealtime({ spaceId: space, onChange } = {}) {
  if (started) return;
  const cfg = await loadRealtimeConfig();
  if (!isConfigured(cfg)) throw new Error('Firebase non configuré');
  if (!space) throw new Error('espace inconnu');
  started = true;
  spaceId = space;
  changeCb = onChange;
  const app = initializeApp(cfg);
  db = initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
  auth = getAuth(app);
  if (cfg.emulator) {
    connectFirestoreEmulator(db, cfg.emulator.host || '127.0.0.1', cfg.emulator.firestore || 8080);
    connectAuthEmulator(auth, `http://${cfg.emulator.host || '127.0.0.1'}:${cfg.emulator.auth || 9099}`, { disableWarnings: true });
  }
  onLocalChange(({ id }) => { schedulePush(id); refreshPendingCount(); });
  window.addEventListener('online', () => { emitStatus(); attempts.clear(); if (signedIn) reconcileAll(); else ensureSignedIn(); });
  window.addEventListener('offline', () => emitStatus());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && connected) reconcileAll(); });
  setInterval(() => { if (connected && !document.hidden) reconcileAll(); }, 60_000);
  if (IS_DEV_HOST) {
    // Outils de test (serveur de développement uniquement) : simuler une coupure réseau.
    window.__rtTest = { offline: () => disableNetwork(db), online: () => enableNetwork(db), remote };
  }
  emitStatus();
  refreshPendingCount();
  await ensureSignedIn();
}

/** Bouton « Synchroniser » : renvoie tout ce qui attend et attend l'accusé serveur. */
export async function flushRealtime({ timeoutMs = 20000 } = {}) {
  if (!db) return getRealtimeStatus();
  await reconcileAll();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await refreshPendingCount();
    if (!pendingCount) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await Promise.race([waitForPendingWrites(db).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  await refreshPendingCount();
  return getRealtimeStatus();
}

/** Rafraîchissement forcé : relit tout depuis le serveur et réaligne. */
export async function resyncRealtime() {
  if (!db || !signedIn) return { ok: false };
  const snap = await getDocsFromServer(col('profiles'));
  const seen = new Set();
  for (const d of snap.docs) {
    seen.add(d.id);
    remote.set(d.id, d.data());
    await applyRemote(d.id, d.data());
  }
  for (const id of [...remote.keys()]) if (!seen.has(id)) remote.delete(id);
  await reconcileAll();
  connected = true;
  emitStatus();
  return { ok: true, remoteCount: snap.docs.filter((d) => !d.data().deleted).length };
}

/** Mesure un aller-retour réel avec le serveur (diagnostic). */
export async function realtimeDiagnose() {
  const local = await getAllProfiles();
  const cfg = await loadRealtimeConfig();
  const out = {
    configured: isConfigured(cfg),
    projectId: cfg?.projectId || '',
    space: spaceId ? spaceId.slice(0, 6) + '…' : '',
    state: getRealtimeStatus().state,
    error: lastError,
    pending: Object.keys(await getPending()).length,
    localProfiles: local.length,
    remoteProfiles: [...remote.values()].filter((d) => !d.deleted).length,
  };
  if (db && signedIn) {
    try {
      const t0 = performance.now();
      const ref = doc(db, 'spaces', spaceId, '_selftest', 'ping-' + Math.random().toString(36).slice(2, 8));
      await withTimeout(setDoc(ref, { at: new Date().toISOString() }), 15000, 'ping');
      out.roundTripMs = Math.round(performance.now() - t0);
      deleteDoc(ref).catch(() => {});
    } catch (e) {
      out.roundTripError = e?.code || e?.message;
    }
  }
  return out;
}
