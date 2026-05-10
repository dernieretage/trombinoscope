// Cloud public automatique : stockage dans le repo GitHub `dernieretage/trombinoscope`
// (branche gh-pages), accessible en lecture publique sans token sur tout appareil.
//
// Push : API GitHub Contents (PUT) — nécessite un PAT avec scope `repo` ou `public_repo`
//        sur l'appareil propriétaire uniquement.
// Pull : fetch direct via raw.githubusercontent.com — INSTANT, sans cache, sans token,
//        depuis n'importe quel appareil.
//
// Architecture identique au mode Gist : 1 manifest + N chunks d'images,
// mais stocké dans data/cloud/ du repo au lieu d'un Gist.

import { exportAllChunked, importAllChunked, getMeta, setMeta, getAllProfiles } from './store.js';

const REPO_OWNER = 'dernieretage';
const REPO_NAME = 'trombinoscope';
const BRANCH = 'gh-pages';
const PATH_PREFIX = 'data/cloud';
const MANIFEST_FILE = 'trombinoscope.json';

const META_TOKEN = 'cloud_repo_token';
const META_LAST_SYNC = 'cloud_last_sync';
const META_LAST_HASH = 'cloud_last_hash';
const META_LOCAL_DIRTY = 'cloud_local_dirty';
const META_AUTO = 'cloud_auto';

let isSyncing = false;
let listeners = new Set();
let pushTimer = null;

export function onCloudStateChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emit(state) { for (const cb of listeners) try { cb(state); } catch {} }

// ============= CONFIG =============

export async function getCloudConfig() {
  return {
    token: await getMeta(META_TOKEN),
    enabled: !!(await getMeta(META_TOKEN)),
    auto: (await getMeta(META_AUTO)) !== false,
    lastSync: await getMeta(META_LAST_SYNC),
  };
}

export async function setCloudToken(token) { await setMeta(META_TOKEN, token || null); }
export async function setCloudAuto(v) { await setMeta(META_AUTO, !!v); }
export async function clearCloudConfig() {
  await setMeta(META_TOKEN, null);
  await setMeta(META_LAST_SYNC, null);
  await setMeta(META_LAST_HASH, null);
  await setMeta(META_LOCAL_DIRTY, false);
  await setMeta(META_AUTO, false);
}
export async function markCloudDirty() { await setMeta(META_LOCAL_DIRTY, true); }

// ============= UTILS =============

function utf8ToBase64(str) {
  // base64 encode safely for any UTF-8 content
  return btoa(unescape(encodeURIComponent(str)));
}

async function computeHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

// ============= GITHUB API (write) =============

async function ghApiCall(path, opts = {}, retry = 0) {
  const cfg = await getCloudConfig();
  if (!cfg.token) throw new Error('Cloud non configuré');
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/${path}`;
  let res;
  try {
    res = await fetch(url, {
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
    if (retry < 2) {
      await new Promise(r => setTimeout(r, 1500));
      return ghApiCall(path, opts, retry + 1);
    }
    throw new Error('Réseau injoignable: ' + e.message);
  }
  if (res.status === 401) throw new Error('Token GitHub invalide.');
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining === '0' && reset) {
      const wait = Math.max(0, parseInt(reset, 10) * 1000 - Date.now());
      throw new Error(`Quota GitHub atteint (reset dans ${Math.round(wait / 1000)}s).`);
    }
    throw new Error('403 — votre token a-t-il le scope "repo" ou "public_repo" ?');
  }
  if (res.status >= 500 && retry < 2) {
    await new Promise(r => setTimeout(r, 1500 * (retry + 1)));
    return ghApiCall(path, opts, retry + 1);
  }
  return res;
}

async function getFileSha(filePath) {
  try {
    const res = await ghApiCall(`contents/${filePath}?ref=${BRANCH}`);
    if (res.ok) {
      const data = await res.json();
      return data.sha;
    }
  } catch {}
  return null;
}

async function putFile(filePath, content, message) {
  const sha = await getFileSha(filePath);
  const body = {
    message: message || `update ${filePath}`,
    content: utf8ToBase64(content),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await ghApiCall(`contents/${filePath}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`PUT ${filePath} → ${res.status} : ${txt.slice(0, 200)}`);
  }
  return await res.json();
}

async function deleteFile(filePath) {
  const sha = await getFileSha(filePath);
  if (!sha) return; // n'existe pas
  const res = await ghApiCall(`contents/${filePath}`, {
    method: 'DELETE',
    body: JSON.stringify({
      message: `delete ${filePath}`,
      sha,
      branch: BRANCH,
    }),
  });
  if (!res.ok && res.status !== 404) {
    const txt = await res.text().catch(() => '');
    console.warn(`DELETE ${filePath} → ${res.status} : ${txt.slice(0, 200)}`);
  }
}

async function listChunkFilesOnRemote() {
  try {
    const res = await ghApiCall(`contents/${PATH_PREFIX}?ref=${BRANCH}`);
    if (!res.ok) return [];
    const items = await res.json();
    return items
      .filter(it => /^trombinoscope-images-\d+\.json$/.test(it.name))
      .map(it => it.name);
  } catch { return []; }
}

// ============= TEST CONNECTION =============

export async function testCloudConnection(token) {
  // Vérifier que le token a accès au repo en écriture
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
  });
  if (res.status === 401) throw new Error('Token invalide.');
  if (res.status === 404) throw new Error('Repo introuvable ou pas d\'accès.');
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  const data = await res.json();
  if (!data.permissions?.push) {
    throw new Error('Le token n\'a pas le droit d\'écriture (besoin du scope "repo" ou "public_repo").');
  }
  // Vérifier branch gh-pages
  const branchRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/branches/${BRANCH}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
  });
  if (!branchRes.ok) throw new Error(`Branche ${BRANCH} introuvable.`);
  return { repo: data.full_name, branch: BRANCH, scopes: res.headers.get('x-oauth-scopes') };
}

// ============= PUSH =============

export async function pushCloud() {
  if (isSyncing) return { skipped: true };
  isSyncing = true;
  emit({ status: 'pushing', message: 'Préparation…' });
  try {
    const exported = await exportAllChunked({ chunkBytes: 700_000 });
    const fileNames = Object.keys(exported.files);
    console.log(`[Cloud] Push: ${fileNames.length} fichiers (${Math.round(exported.totalSize / 1024)} Ko)`);

    // Push manifest en premier
    const manifestPath = `${PATH_PREFIX}/${MANIFEST_FILE}`;
    emit({ status: 'pushing', message: `Push manifest…` });
    await putFile(manifestPath, exported.files[MANIFEST_FILE], `Cloud sync — ${exported.totalImages} images`);
    console.log('[Cloud] Manifest pushé OK');

    // Push chaque chunk individuellement
    const chunkNames = fileNames.filter(n => n !== MANIFEST_FILE);
    for (let i = 0; i < chunkNames.length; i++) {
      const name = chunkNames[i];
      const content = exported.files[name];
      const path = `${PATH_PREFIX}/${name}`;
      emit({ status: 'pushing', message: `Push images ${i + 1}/${chunkNames.length}…` });
      try {
        await putFile(path, content, `Cloud sync — ${name}`);
        console.log(`[Cloud] ${name} pushé OK (${Math.round(content.length / 1024)} Ko)`);
      } catch (e) {
        console.error(`[Cloud] Échec push ${name}:`, e.message);
        throw new Error(`Échec push ${name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 250)); // throttle
    }

    // Cleanup chunks orphelins
    const newChunkNames = new Set(chunkNames);
    const remoteChunks = await listChunkFilesOnRemote();
    const toDelete = remoteChunks.filter(n => !newChunkNames.has(n));
    if (toDelete.length) {
      emit({ status: 'pushing', message: `Suppression de ${toDelete.length} fichiers obsolètes…` });
      for (const name of toDelete) {
        await deleteFile(`${PATH_PREFIX}/${name}`);
        console.log(`[Cloud] ${name} supprimé`);
        await new Promise(r => setTimeout(r, 200));
      }
    }

    const manifestStr = exported.files[MANIFEST_FILE];
    const hash = await computeHash(manifestStr + ':' + exported.totalImages);
    await setMeta(META_LAST_SYNC, new Date().toISOString());
    await setMeta(META_LAST_HASH, hash);
    await setMeta(META_LOCAL_DIRTY, false);
    emit({ status: 'idle', lastSync: new Date().toISOString() });

    return {
      success: true,
      profiles: JSON.parse(manifestStr).profiles?.length || 0,
      images: exported.totalImages,
      chunks: chunkNames.length,
      sizeKb: Math.round(exported.totalSize / 1024),
    };
  } catch (e) {
    console.error('[Cloud] Push erreur:', e.message);
    emit({ status: 'error', error: e.message });
    throw e;
  } finally {
    isSyncing = false;
  }
}

// ============= PULL (lecture publique sans token) =============

function rawUrl(name) {
  return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/${PATH_PREFIX}/${name}?v=${Date.now()}`;
}

/**
 * Pull les données du cloud public. Aucun token requis (lecture publique).
 * Utilisable depuis n'importe quel appareil.
 */
export async function pullCloud({ replace = true } = {}) {
  emit({ status: 'pulling', message: 'Connexion au cloud…' });

  // 1. Fetch le manifest
  let manifest;
  try {
    const res = await fetch(rawUrl(MANIFEST_FILE), { cache: 'no-store' });
    if (!res.ok) {
      emit({ status: 'idle' });
      return { success: false, empty: true, reason: `manifest ${res.status}` };
    }
    manifest = await res.json();
  } catch (e) {
    emit({ status: 'error', error: 'Lecture manifest échouée: ' + e.message });
    return { success: false, error: e.message };
  }

  if (!manifest?.profiles?.length) {
    emit({ status: 'idle' });
    return { success: true, empty: true };
  }

  const filesByName = { [MANIFEST_FILE]: JSON.stringify(manifest) };
  const expectedChunks = manifest.imageChunks || 0;
  let downloadedChunks = 0;

  // 2. Fetch tous les chunks d'images en parallèle (par groupes de 4)
  if (expectedChunks > 0) {
    emit({ status: 'pulling', message: `Téléchargement ${expectedChunks} fichiers d'images…` });
    const chunkNames = Array.from({ length: expectedChunks }, (_, i) =>
      `trombinoscope-images-${String(i + 1).padStart(3, '0')}.json`
    );
    const concurrency = 4;
    for (let i = 0; i < chunkNames.length; i += concurrency) {
      const batch = chunkNames.slice(i, i + concurrency);
      await Promise.all(batch.map(async (name) => {
        try {
          const res = await fetch(rawUrl(name), { cache: 'no-store' });
          if (res.ok) {
            filesByName[name] = await res.text();
            downloadedChunks++;
            emit({ status: 'pulling', message: `Téléchargement ${downloadedChunks}/${expectedChunks}…` });
          } else {
            console.warn(`[Cloud] ${name} → ${res.status}`);
          }
        } catch (e) {
          console.warn(`[Cloud] ${name} échoué:`, e.message);
        }
      }));
    }
  }

  // 3. Restaurer en local
  emit({ status: 'pulling', message: `Restauration locale…` });
  const result = await importAllChunked(filesByName, { replace });

  const hash = await computeHash(filesByName[MANIFEST_FILE] + ':' + (result.images || 0));
  await setMeta(META_LAST_SYNC, new Date().toISOString());
  await setMeta(META_LAST_HASH, hash);
  emit({ status: 'idle', lastSync: new Date().toISOString() });

  return {
    success: true,
    profiles: result.profiles,
    images: result.images,
    expectedChunks,
    downloadedChunks,
  };
}

// ============= AUTO-PULL AU DÉMARRAGE =============

/**
 * Pull silencieux au démarrage : si un manifest existe en ligne et qu'on n'a pas
 * de modifs locales, on charge tout depuis le cloud. ZÉRO configuration nécessaire
 * sur le nouvel appareil.
 */
export async function setupCloudAutoPull() {
  const cfg = await getCloudConfig();
  const localDirty = await getMeta(META_LOCAL_DIRTY);

  // Tenter la lecture publique du manifest, sans token
  let manifest;
  try {
    const res = await fetch(rawUrl(MANIFEST_FILE), { cache: 'no-store' });
    if (!res.ok) return { skipped: true, reason: `no manifest (${res.status})` };
    manifest = await res.json();
  } catch (e) {
    return { skipped: true, reason: 'fetch failed: ' + e.message };
  }

  if (!manifest?.profiles?.length) return { skipped: true, reason: 'manifest empty' };

  const remoteHash = await computeHash(JSON.stringify(manifest) + ':' + (manifest.totalImages || 0));
  const lastHash = await getMeta(META_LAST_HASH);
  const localProfiles = await getAllProfiles();

  // Cas 1 : appareil vierge ou seul le seed est chargé → pull silencieux
  // Cas 2 : remote hash différent du dernier connu → pull silencieux si pas dirty
  // Cas 3 : on a des modifs locales non-pushées → ne touche pas, demande à l'user
  const isFreshDevice = !cfg.lastSync && localProfiles.length > 0; // a juste le seed
  const remoteChanged = remoteHash !== lastHash;

  if (isFreshDevice || (remoteChanged && !localDirty)) {
    emit({ status: 'pulling', message: `Récupération depuis le cloud (${manifest.profiles.length} profils + ${manifest.totalImages || 0} images)…` });
    try {
      const result = await pullCloud({ replace: true });
      if (result.success && result.profiles > 0) {
        return { autoPulled: true, ...result };
      }
    } catch (e) {
      console.warn('[Cloud] Auto-pull failed:', e.message);
      emit({ status: 'error', error: e.message });
    }
  } else if (remoteChanged && localDirty) {
    emit({ status: 'remote-newer', remoteProfiles: manifest.profiles.length, remoteImages: manifest.totalImages });
  }
  return { skipped: true };
}

// ============= AUTO-PUSH (debounced) =============

export function scheduleCloudPush(delayMs = 4000) {
  setMeta(META_LOCAL_DIRTY, true);
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try {
      const cfg = await getCloudConfig();
      if (cfg.token && cfg.auto) await pushCloud();
    } catch (e) {
      console.warn('[Cloud] Auto-push failed:', e.message);
    }
  }, delayMs);
}

// ============= LIEN D'INVITATION (partager le token entre devices) =============

/**
 * Génère un lien d'invitation contenant le PAT cloud public en base64.
 * À ouvrir sur tout autre appareil → configure auto le cloud → permet
 * non seulement la lecture (déjà publique) mais aussi l'écriture
 * de modifications depuis ce device.
 */
export async function generateCloudInviteLink() {
  const token = await getMeta(META_TOKEN);
  if (!token) throw new Error('Cloud non configuré — activez-le d\'abord.');
  const payload = btoa(JSON.stringify({ ct: token, ts: Date.now() }));
  const url = new URL(window.location.href);
  url.searchParams.set('cloud', payload);
  url.hash = '';
  return url.toString();
}

/**
 * Au démarrage : si l'URL contient ?cloud=xxx, configure le cloud token
 * automatiquement. Le device pourra ensuite lire ET écrire le cloud public.
 */
export async function consumeCloudActivateParam() {
  try {
    const url = new URL(window.location.href);
    const param = url.searchParams.get('cloud');
    if (!param) return null;
    const payload = JSON.parse(atob(param));
    if (!payload.ct) return null;
    await setMeta(META_TOKEN, payload.ct);
    await setMeta(META_AUTO, true);
    url.searchParams.delete('cloud');
    history.replaceState(null, '', url.toString());
    return { activated: true };
  } catch (e) {
    console.error('[Cloud] consumeCloudActivateParam failed:', e.message);
    return { activated: false, error: e.message };
  }
}

// ============= DIAGNOSTIC =============

export async function diagnoseCloud() {
  const cfg = await getCloudConfig();
  const out = { configured: cfg.enabled, lastSync: cfg.lastSync };

  // Test lecture publique
  try {
    const res = await fetch(rawUrl(MANIFEST_FILE), { cache: 'no-store' });
    out.publicReadOk = res.ok;
    out.publicReadStatus = res.status;
    if (res.ok) {
      const m = await res.json();
      out.remoteProfiles = m.profiles?.length || 0;
      out.remoteImageChunks = m.imageChunks || 0;
      out.remoteTotalImages = m.totalImages || 0;
      out.remoteExportedAt = m.exportedAt;
    }
  } catch (e) {
    out.publicReadOk = false;
    out.publicReadError = e.message;
  }

  // Lister les chunks réellement présents (avec token si dispo, sinon via raw)
  if (cfg.token) {
    try {
      const remoteChunks = await listChunkFilesOnRemote();
      out.actualChunkFiles = remoteChunks.length;
      out.chunkNames = remoteChunks.slice(0, 5);
    } catch (e) { out.listError = e.message; }
  }

  return out;
}
