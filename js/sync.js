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

// État du quota GitHub : timestamp (ms) jusqu'auquel on s'abstient de pousser
// Permet d'éviter de spammer l'API quand le rate limit est atteint.
let quotaResetAt = 0;
export function isQuotaExhausted() { return Date.now() < quotaResetAt; }
export function getQuotaResetAt() { return quotaResetAt; }
export function getQuotaWaitSec() { return Math.max(0, Math.ceil((quotaResetAt - Date.now()) / 1000)); }

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

/**
 * Génère un lien d'invitation contenant le PAT et le Gist ID en base64,
 * que l'utilisateur peut ouvrir sur un autre appareil pour auto-configurer
 * la sync sans re-coller le token.
 */
export async function generateInviteLink() {
  const token = await getMeta(META_TOKEN);
  const gistId = await getMeta(META_GIST_ID);
  if (!token) throw new Error('Sync non configurée — activez-la d\'abord.');
  const payload = btoa(JSON.stringify({ t: token, g: gistId, ts: Date.now() }));
  const url = new URL(window.location.href);
  url.searchParams.set('activate', payload);
  url.hash = '';
  return url.toString();
}

/**
 * À appeler au démarrage : si l'URL contient ?activate=xxx, configure
 * automatiquement la sync et pull immédiatement les données du Gist.
 * @returns null si pas de paramètre, sinon { activated: true, pulled: {...} }
 */
export async function consumeActivateParam() {
  try {
    const url = new URL(window.location.href);
    const activate = url.searchParams.get('activate');
    if (!activate) return null;
    const payload = JSON.parse(atob(activate));
    if (!payload.t) return null;
    await setMeta(META_TOKEN, payload.t);
    if (payload.g) await setMeta(META_GIST_ID, payload.g);
    await setMeta(META_AUTOSYNC, true);
    // Nettoyer l'URL pour ne pas garder le PAT en historique
    url.searchParams.delete('activate');
    history.replaceState(null, '', url.toString());
    isReady = true;
    // Pull immédiat
    const pulled = await pullNow({ replace: true });
    return { activated: true, pulled };
  } catch (e) {
    console.error('[Sync] consumeActivateParam failed:', e.message);
    return { activated: false, error: e.message };
  }
}
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

async function ghFetch(path, opts = {}, retryAttempt = 0) {
  const cfg = await getSyncConfig();
  if (!cfg.token) throw new Error('Aucun token GitHub configuré');
  let res;
  try {
    res = await fetch(`${GH_API}${path}`, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
  } catch (e) {
    // Network error : retry 1x après pause
    if (retryAttempt < 2) {
      await new Promise(r => setTimeout(r, 1500));
      return ghFetch(path, opts, retryAttempt + 1);
    }
    throw new Error('Réseau injoignable: ' + e.message);
  }
  if (res.status === 401) throw new Error('Token GitHub invalide ou expiré.');
  if (res.status === 403) {
    // Peut être un rate limit (X-RateLimit-Remaining: 0)
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining === '0' && reset) {
      const resetMs = parseInt(reset, 10) * 1000;
      const wait = Math.max(0, resetMs - Date.now());
      // Mémoriser le reset pour faire taire les pushes auto pendant ce délai
      quotaResetAt = resetMs + 1000; // +1s buffer
      if (wait < 60000 && retryAttempt < 2) {
        await new Promise(r => setTimeout(r, wait + 500));
        return ghFetch(path, opts, retryAttempt + 1);
      }
      const err = new Error(`Quota GitHub atteint, reset dans ${Math.round(wait / 1000)}s.`);
      err.code = 'QUOTA';
      err.resetAt = resetMs;
      err.waitSec = Math.round(wait / 1000);
      throw err;
    }
    throw new Error('Quota dépassé ou scope manquant (besoin de "gist").');
  }
  if (res.status === 422) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Payload trop gros ou invalide (422): ${txt.slice(0, 200)}`);
  }
  if (res.status >= 500 && retryAttempt < 2) {
    await new Promise(r => setTimeout(r, 1500 * (retryAttempt + 1)));
    return ghFetch(path, opts, retryAttempt + 1);
  }
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
    const exported = await exportAllChunked({ chunkBytes: 700_000 });
    const fileNames = Object.keys(exported.files);
    console.log(`[Sync] Push: ${fileNames.length} fichiers, ${Math.round(exported.totalSize / 1024)} Ko total`);

    // Récupérer la liste des fichiers actuels pour suppression chunks orphelins
    let existingChunkFiles = [];
    try {
      const current = await ghFetch(`/gists/${id}`);
      existingChunkFiles = Object.keys(current.files || {}).filter(n => /^trombinoscope-images-\d+\.json$/.test(n));
    } catch (e) { console.warn('[Sync] Impossible de lister les chunks existants:', e.message); }

    // Push manifest en premier (petit et critique)
    emit({ status: 'pushing', message: `Push manifest…` });
    await ghFetch(`/gists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ files: { 'trombinoscope.json': { content: exported.files['trombinoscope.json'] } } }),
    });
    console.log('[Sync] Manifest pushé OK');

    // Push chaque chunk individuellement (1 PATCH par chunk = pas de payload géant)
    const chunkNames = fileNames.filter(n => n !== 'trombinoscope.json');
    for (let i = 0; i < chunkNames.length; i++) {
      const name = chunkNames[i];
      const content = exported.files[name];
      emit({ status: 'pushing', message: `Push images ${i + 1}/${chunkNames.length} (${Math.round(content.length / 1024)} Ko)…` });
      try {
        await ghFetch(`/gists/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ files: { [name]: { content } } }),
        });
        console.log(`[Sync] ${name} pushé OK (${Math.round(content.length / 1024)} Ko)`);
      } catch (e) {
        console.error(`[Sync] Échec push ${name}:`, e.message);
        throw new Error(`Échec push ${name}: ${e.message}`);
      }
      // throttle léger pour respecter GitHub
      await new Promise(r => setTimeout(r, 200));
    }

    // Supprimer les chunks orphelins
    const newChunkNames = new Set(chunkNames);
    const toDelete = existingChunkFiles.filter(n => !newChunkNames.has(n));
    if (toDelete.length) {
      emit({ status: 'pushing', message: `Suppression de ${toDelete.length} chunks obsolètes…` });
      const deletePayload = {};
      for (const n of toDelete) deletePayload[n] = null;
      await ghFetch(`/gists/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ files: deletePayload }),
      });
      console.log(`[Sync] ${toDelete.length} chunks supprimés`);
    }

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
      chunks: chunkNames.length,
      gistId: id,
      sizeKb: Math.round(exported.totalSize / 1024),
    };
  } catch (e) {
    console.error('[Sync] Push erreur:', e.message);
    emit({ status: 'error', error: e.message });
    throw e;
  } finally {
    isSyncing = false;
  }
}

// Diagnostic : retourne l'état réel du Gist (utile pour vérifier que les images sont bien là)
export async function diagnoseSync() {
  const cfg = await getSyncConfig();
  if (!cfg.token) return { configured: false };
  try {
    const id = await findOrCreateGist();
    const gist = await ghFetch(`/gists/${id}`);
    const files = Object.entries(gist.files || {}).map(([name, f]) => ({
      name,
      size: f.size,
      truncated: f.truncated,
    }));
    const chunkFiles = files.filter(f => /^trombinoscope-images-\d+\.json$/.test(f.name));
    const manifestFile = files.find(f => f.name === 'trombinoscope.json');
    let manifestContent = manifestFile ? gist.files[manifestFile.name].content : null;
    if (manifestFile?.truncated && gist.files['trombinoscope.json']?.raw_url) {
      manifestContent = await fetch(gist.files['trombinoscope.json'].raw_url).then(r => r.text());
    }
    let manifest = null;
    try { manifest = JSON.parse(manifestContent); } catch {}
    return {
      configured: true,
      gistId: id,
      gistUrl: gist.html_url,
      gistUpdated: gist.updated_at,
      totalFiles: files.length,
      totalSize: files.reduce((s, f) => s + (f.size || 0), 0),
      manifestProfiles: manifest?.profiles?.length || 0,
      manifestTotalImages: manifest?.totalImages || manifest?.imageChunks * 10 || 0,
      chunkFilesCount: chunkFiles.length,
      chunkSizes: chunkFiles.map(f => ({ name: f.name, sizeKb: Math.round((f.size || 0) / 1024), truncated: f.truncated })),
      lastSync: cfg.lastSync,
    };
  } catch (e) {
    return { configured: true, error: e.message };
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

  // Si on est dans une fenêtre de quota épuisé, repousser jusqu'au reset
  // au lieu de spammer l'API et de générer des erreurs visibles à l'user.
  let effectiveDelay = delayMs;
  if (isQuotaExhausted()) {
    const wait = quotaResetAt - Date.now();
    effectiveDelay = Math.max(delayMs, wait);
    console.log(`[Sync] Push reporté de ${Math.round(effectiveDelay / 1000)}s (quota Gist atteint).`);
  }

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
      console.warn('[Sync] Auto-push failed:', e.message);
      // Si quota encore atteint, replanifier silencieusement après le reset
      if (e.code === 'QUOTA' || isQuotaExhausted()) {
        const retryDelay = Math.max(5000, quotaResetAt - Date.now() + 2000);
        console.log(`[Sync] Replanification dans ${Math.round(retryDelay / 1000)}s.`);
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => schedulePush(0), retryDelay);
      }
    }
  }, effectiveDelay);
}
