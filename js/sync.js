// Sync cross-device via GitHub Gist
// L'utilisateur fournit un Personal Access Token avec scope `gist`.
// L'app crée un gist privé "trombinoscope-data" et y stocke un dump JSON.
// Sync auto au démarrage (pull) et après chaque modif (push, debouncé).

import { exportAll, exportAllChunked, importAll, importAllChunked, getMeta, setMeta, getAllProfiles } from './store.js';

const GIST_DESCRIPTION = 'Trombinoscope — données privées (sync cross-device)';
const GIST_FILENAME = 'trombinoscope.json';
const GH_API = 'https://api.github.com';

// Conserve la version locale pour détecter les conflits
const META_TOKEN = 'sync_token';
const META_GIST_ID = 'sync_gist_id';
const META_LAST_SYNC = 'sync_last_at';
const META_LAST_REMOTE_HASH = 'sync_last_remote_hash';
const META_AUTOSYNC = 'sync_auto';

let pushTimer = null;
let isSyncing = false;
let isReady = false;
let listeners = new Set();

export function onSyncStateChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emit(state) { for (const cb of listeners) try { cb(state); } catch {} }

// ============= CONFIG =============

export async function getSyncConfig() {
  return {
    token: await getMeta(META_TOKEN),
    gistId: await getMeta(META_GIST_ID),
    autoSync: (await getMeta(META_AUTOSYNC)) !== false,
    lastSync: await getMeta(META_LAST_SYNC),
  };
}

export async function setSyncToken(token) { await setMeta(META_TOKEN, token || null); }
export async function setSyncAutoSync(v) { await setMeta(META_AUTOSYNC, !!v); }
export async function clearSyncConfig() {
  await setMeta(META_TOKEN, null);
  await setMeta(META_GIST_ID, null);
  await setMeta(META_LAST_SYNC, null);
  await setMeta(META_LAST_REMOTE_HASH, null);
  await setMeta(META_AUTOSYNC, false);
  isReady = false;
}

export function isSyncReady() { return isReady; }

// ============= API GITHUB =============

async function ghFetch(path, opts = {}) {
  const cfg = await getSyncConfig();
  if (!cfg.token) throw new Error('Aucun token GitHub configuré');
  const res = await fetch(`${GH_API}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('Token GitHub invalide ou expiré.');
  if (res.status === 403) throw new Error('Quota dépassé ou scope manquant (besoin de "gist").');
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function findOrCreateGist() {
  let cfg = await getSyncConfig();
  if (cfg.gistId) {
    try {
      // Vérifier que le gist existe encore
      await ghFetch(`/gists/${cfg.gistId}`);
      return cfg.gistId;
    } catch (e) {
      if (e.message.includes('404')) {
        await setMeta(META_GIST_ID, null);
      } else { throw e; }
    }
  }
  // Chercher un gist existant (limite à 100 par page, on peut paginer si besoin)
  let foundId = null;
  for (let page = 1; page <= 5 && !foundId; page++) {
    const gists = await ghFetch(`/gists?per_page=100&page=${page}`);
    if (!gists.length) break;
    const found = gists.find(g => g.description === GIST_DESCRIPTION || (g.files && g.files[GIST_FILENAME]));
    if (found) foundId = found.id;
    if (gists.length < 100) break;
  }
  if (foundId) {
    await setMeta(META_GIST_ID, foundId);
    return foundId;
  }
  // Créer
  const created = await ghFetch('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify({ profiles: [], imageChunks: 0, version: 2, exportedAt: new Date().toISOString() }) } },
    }),
  });
  await setMeta(META_GIST_ID, created.id);
  return created.id;
}

// ============= TEST CONNECTION =============

export async function testConnection(token) {
  // test direct sans changer les meta
  const res = await fetch(`${GH_API}/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
  });
  if (res.status === 401) throw new Error('Token invalide.');
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  const user = await res.json();
  // vérifier scope gist
  const scopes = (res.headers.get('x-oauth-scopes') || '').split(',').map(s => s.trim());
  if (!scopes.includes('gist')) throw new Error('Le token n’a pas le scope "gist".');
  return { login: user.login, avatar: user.avatar_url };
}

// ============= PUSH / PULL =============

async function computeHash(str) {
  // crc32-ish simple
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

export async function pushNow() {
  if (isSyncing) return { skipped: true };
  isSyncing = true;
  emit({ status: 'pushing' });
  try {
    const id = await findOrCreateGist();
    // Format chunked : profil + manifeste dans trombinoscope.json, images dans trombinoscope-images-NNN.json
    const exported = await exportAllChunked({ chunkBytes: 700_000 });

    // Récupérer la liste des fichiers actuels du Gist pour supprimer les anciens chunks orphelins
    let existingChunkFiles = [];
    try {
      const current = await ghFetch(`/gists/${id}`);
      existingChunkFiles = Object.keys(current.files || {}).filter(n => /^trombinoscope-images-\d+\.json$/.test(n));
    } catch {}

    // Construire le payload PATCH : nouveaux fichiers + suppression des chunks orphelins
    const filesPayload = {};
    for (const [name, content] of Object.entries(exported.files)) {
      filesPayload[name] = { content };
    }
    // Supprimer les chunks anciens qui n'existent plus
    const newChunkNames = new Set(Object.keys(exported.files));
    for (const oldName of existingChunkFiles) {
      if (!newChunkNames.has(oldName)) {
        filesPayload[oldName] = null; // null = suppression dans l'API Gist
      }
    }

    await ghFetch(`/gists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ files: filesPayload }),
    });

    // Hash basé sur le contenu du manifest (profils + version)
    const manifestStr = exported.files['trombinoscope.json'];
    const hash = await computeHash(manifestStr + ':' + exported.totalImages);

    await setMeta(META_LAST_SYNC, new Date().toISOString());
    await setMeta(META_LAST_REMOTE_HASH, hash);
    await setMeta(META_LOCAL_DIRTY, false);
    emit({ status: 'idle', lastSync: new Date().toISOString() });
    return {
      success: true,
      profiles: JSON.parse(manifestStr).profiles?.length,
      images: exported.totalImages,
      chunks: Object.keys(exported.files).length - 1,
      gistId: id,
      sizeKb: Math.round(exported.totalSize / 1024),
    };
  } catch (e) {
    emit({ status: 'error', error: e.message });
    throw e;
  } finally {
    isSyncing = false;
  }
}

export async function pullNow({ replace = true } = {}) {
  if (isSyncing) return { skipped: true };
  isSyncing = true;
  emit({ status: 'pulling', message: 'Connexion à GitHub…' });
  try {
    const id = await findOrCreateGist();
    const gist = await ghFetch(`/gists/${id}`);
    const allFiles = gist.files || {};
    const manifestFile = allFiles[GIST_FILENAME];
    if (!manifestFile) {
      emit({ status: 'idle' });
      return { success: true, empty: true };
    }

    // Lire le contenu de tous les fichiers (manifest + chunks)
    const filesByName = {};
    const allNames = Object.keys(allFiles);
    for (let i = 0; i < allNames.length; i++) {
      const name = allNames[i];
      const f = allFiles[name];
      let content = f.content;
      if (f.truncated && f.raw_url) {
        emit({ status: 'pulling', message: `Téléchargement ${i + 1}/${allNames.length}…` });
        content = await fetch(f.raw_url).then(r => r.text());
      }
      filesByName[name] = content;
    }

    // Vérifier qu'on a au moins un profil
    let manifest;
    try { manifest = JSON.parse(filesByName[GIST_FILENAME]); } catch { manifest = null; }
    if (!manifest?.profiles?.length && !manifest?.images?.length) {
      emit({ status: 'idle' });
      return { success: true, empty: true };
    }

    emit({ status: 'pulling', message: `Restauration ${manifest.profiles?.length || 0} profils + images…` });
    const result = await importAllChunked(filesByName, { replace });

    // Hash basé sur le manifest + total images (cohérent avec push)
    const totalImages = result.images || 0;
    const hash = await computeHash(filesByName[GIST_FILENAME] + ':' + totalImages);

    await setMeta(META_LAST_SYNC, new Date().toISOString());
    await setMeta(META_LAST_REMOTE_HASH, hash);
    emit({ status: 'idle', lastSync: new Date().toISOString() });
    return { success: true, profiles: result.profiles, images: result.images };
  } catch (e) {
    emit({ status: 'error', error: e.message });
    throw e;
  } finally {
    isSyncing = false;
  }
}

// ============= AUTO-SYNC =============

const META_LOCAL_DIRTY = 'sync_local_dirty';

export async function markLocalDirty() {
  await setMeta(META_LOCAL_DIRTY, true);
}

export async function setupAutoSync() {
  const cfg = await getSyncConfig();
  if (!cfg.token) { isReady = false; return false; }
  isReady = true;

  // Pull au démarrage si data distante plus récente
  if (cfg.autoSync) {
    try {
      const id = await findOrCreateGist();
      const gist = await ghFetch(`/gists/${id}`);
      const remoteUpdated = gist.updated_at;
      const lastSync = cfg.lastSync;
      const file = gist.files?.[GIST_FILENAME];
      const localDirty = await getMeta(META_LOCAL_DIRTY);

      // Récupérer le contenu remote du manifest
      if (file && file.size > 100) {
        let remoteContent = file.content;
        if (file.truncated && file.raw_url) {
          remoteContent = await fetch(file.raw_url).then(r => r.text());
        }
        let remoteData;
        try { remoteData = JSON.parse(remoteContent); } catch { remoteData = null; }

        if (remoteData?.profiles?.length) {
          // Compter le nombre total d'images dans tous les chunks
          let totalImages = remoteData.totalImages || (remoteData.images?.length || 0);
          const chunkFiles = Object.keys(gist.files || {}).filter(n => /^trombinoscope-images-\d+\.json$/.test(n));
          if (chunkFiles.length && !remoteData.totalImages) {
            // Approximation rapide sans télécharger les chunks
            totalImages = chunkFiles.length * 10; // ordre de grandeur
          }
          const remoteHash = await computeHash(remoteContent + ':' + totalImages);
          const lastRemoteHash = await getMeta(META_LAST_REMOTE_HASH);
          const needsPull = !lastSync || (remoteHash !== lastRemoteHash);

          if (needsPull) {
            if (!localDirty) {
              emit({ status: 'pulling', message: `Récupération de ${remoteData.profiles.length} profils + ${totalImages} images…` });
              await pullNow({ replace: true });
              await setMeta(META_LOCAL_DIRTY, false);
              emit({ status: 'pulled-silent', profiles: remoteData.profiles.length, images: totalImages });
            } else {
              emit({ status: 'remote-newer', remoteUpdated, gistId: id, remoteProfiles: remoteData.profiles.length });
            }
          }
        }
      }
    } catch (e) {
      console.warn('Auto-pull skipped:', e.message);
      emit({ status: 'error', error: e.message });
    }
  }
  return true;
}

export async function schedulePush(delayMs = 4000) {
  // Marquer local comme dirty AVANT le push (pour gérer les conflits)
  await setMeta(META_LOCAL_DIRTY, true);
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try {
      const cfg = await getSyncConfig();
      if (cfg.token && cfg.autoSync) {
        await pushNow();
        // Une fois pushé, plus dirty
        await setMeta(META_LOCAL_DIRTY, false);
      }
    } catch (e) {
      console.warn('Auto-push failed:', e.message);
    }
  }, delayMs);
}
