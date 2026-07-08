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
let cloudQuotaResetAt = 0;
export function isCloudQuotaExhausted() { return Date.now() < cloudQuotaResetAt; }
export function getCloudQuotaWaitSec() { return Math.max(0, Math.ceil((cloudQuotaResetAt - Date.now()) / 1000)); }
export function isCloudSyncBusy() { return isSyncing; }

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
  // Force unsigned int32 pour éviter les hash négatifs qui rendent les
  // comparaisons string instables (ex: '-3qbuat' vs '6gtvhg' pour le même contenu).
  return (h >>> 0).toString(36);
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
      const resetMs = parseInt(reset, 10) * 1000;
      const wait = Math.max(0, resetMs - Date.now());
      cloudQuotaResetAt = resetMs + 1000;
      const err = new Error(`Quota GitHub atteint (reset dans ${Math.round(wait / 1000)}s).`);
      err.code = 'QUOTA';
      err.resetAt = resetMs;
      err.waitSec = Math.round(wait / 1000);
      throw err;
    }
    throw new Error('403 — le token n\'a pas le droit d\'écriture (fine-grained : permission « Contents : Read and write » requise).');
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

/**
 * PUT un fichier. `knownSha` évite le GET préalable (2x moins de requêtes).
 * Si le sha est périmé (un autre appareil a pushé entre-temps → 409/422),
 * on re-fetch le sha et on retente UNE fois.
 */
async function putFile(filePath, content, message, knownSha) {
  const sha = knownSha !== undefined ? knownSha : await getFileSha(filePath);
  const doPut = async (shaToUse) => {
    const body = {
      message: message || `update ${filePath}`,
      content: utf8ToBase64(content),
      branch: BRANCH,
    };
    if (shaToUse) body.sha = shaToUse;
    return ghApiCall(`contents/${filePath}`, { method: 'PUT', body: JSON.stringify(body) });
  };
  let res = await doPut(sha);
  if (res.status === 409 || res.status === 422) {
    // sha périmé (push concurrent) → refetch + retry
    const freshSha = await getFileSha(filePath);
    res = await doPut(freshSha);
  }
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

export async function pushCloud({ allowEmpty = false } = {}) {
  if (isSyncing) return { skipped: true };
  isSyncing = true;
  emit({ status: 'pushing', message: 'Préparation…' });
  try {
    const exported = await exportAllChunked({ chunkBytes: 700_000 });
    const manifestObj = JSON.parse(exported.files[MANIFEST_FILE]);
    // SAFEGUARD : ne JAMAIS push un manifest vide sans confirmation explicite.
    // Empêche un bug local (suppression de tout, ou IDB vidée par Safari Privée)
    // de wipe les données partagées avec d'autres devices.
    if (!allowEmpty && (!manifestObj.profiles || manifestObj.profiles.length === 0)) {
      isSyncing = false;
      emit({ status: 'idle' });
      const err = new Error('Push annulé : aucun profil local. Pour vraiment vider le cloud, utilisez pushCloud({allowEmpty:true}).');
      err.code = 'EMPTY_BLOCKED';
      throw err;
    }
    const fileNames = Object.keys(exported.files);
    console.log(`[Cloud] Push: ${fileNames.length} fichiers (${Math.round(exported.totalSize / 1024)} Ko)`);

    // Cache d'état des chunks : { [name]: { hash, sha } }. Un chunk dont le
    // hash n'a pas bougé depuis le dernier push est SKIPPÉ (ni GET ni PUT).
    // Une modif de profil sans nouvelle photo = 1 seul PUT (manifest) ≈ 1-2s.
    const chunkState = (await getMeta('cloud_chunk_state')) || {};
    const newState = {};

    // Manifest EN PREMIER : si le push plante à mi-chunks, l'ancien manifest
    // resterait sinon actif en pointant sur des chunks déjà écrasés →
    // incohérence. Avec manifest first + safety threshold 50% au pull, un
    // push partiel est simplement ignoré par les lecteurs.
    const manifestPath = `${PATH_PREFIX}/${MANIFEST_FILE}`;
    emit({ status: 'pushing', message: `Push manifest…` });
    const manifestRes = await putFile(
      manifestPath, exported.files[MANIFEST_FILE],
      `Cloud sync — ${exported.totalImages} images`,
      chunkState.__manifest?.sha,
    );
    newState.__manifest = { sha: manifestRes?.content?.sha || null };
    console.log('[Cloud] Manifest pushé OK');

    // Push uniquement les chunks modifiés
    const chunkNames = fileNames.filter(n => n !== MANIFEST_FILE);
    let pushed = 0, skipped = 0;
    for (let i = 0; i < chunkNames.length; i++) {
      const name = chunkNames[i];
      const content = exported.files[name];
      const contentHash = await computeHash(content);
      const prev = chunkState[name];
      if (prev && prev.hash === contentHash && prev.sha) {
        newState[name] = prev;
        skipped++;
        continue;
      }
      const path = `${PATH_PREFIX}/${name}`;
      emit({ status: 'pushing', message: `Push images ${i + 1}/${chunkNames.length}…` });
      try {
        const r = await putFile(path, content, `Cloud sync — ${name}`, prev?.sha);
        newState[name] = { hash: contentHash, sha: r?.content?.sha || null };
        pushed++;
        console.log(`[Cloud] ${name} pushé (${Math.round(content.length / 1024)} Ko)`);
      } catch (e) {
        console.error(`[Cloud] Échec push ${name}:`, e.message);
        throw new Error(`Échec push ${name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 120)); // throttle léger
    }
    console.log(`[Cloud] Chunks : ${pushed} pushés, ${skipped} inchangés (skippés)`);

    // Cleanup chunks orphelins — seulement si le nombre de chunks a diminué
    // (évite un LIST à chaque push).
    const prevChunkCount = Object.keys(chunkState).filter(k => k !== '__manifest').length;
    if (chunkNames.length < prevChunkCount) {
      const newChunkNames = new Set(chunkNames);
      const remoteChunks = await listChunkFilesOnRemote();
      const toDelete = remoteChunks.filter(n => !newChunkNames.has(n));
      for (const name of toDelete) {
        await deleteFile(`${PATH_PREFIX}/${name}`);
        console.log(`[Cloud] ${name} supprimé`);
        await new Promise(r => setTimeout(r, 150));
      }
    }
    await setMeta('cloud_chunk_state', newState);

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
      chunksPushed: pushed,
      chunksSkipped: skipped,
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
  // Cache busting + raw.githubusercontent.com (peut cacher jusqu'à 5 min)
  return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/${PATH_PREFIX}/${name}?v=${Date.now()}`;
}

/**
 * Vérification RAPIDE (manifest seul, sans les images) : combien de profils
 * le cloud contient-il ? Sert à décider s'il faut semer (seed) au démarrage,
 * SANS attendre le téléchargement des ~15 Mo d'images (qui, s'il dépasse le
 * timeout, laissait le seed se charger PUIS le cloud fusionner par-dessus →
 * profils en double).
 */
export async function cloudProfileCount() {
  try {
    let manifestStr = await fetchFileViaApi(`${PATH_PREFIX}/${MANIFEST_FILE}`);
    if (!manifestStr) {
      const res = await fetch(rawUrl(MANIFEST_FILE), { cache: 'no-store' });
      if (!res.ok) return null; // cloud injoignable → null (distinct de 0)
      manifestStr = await res.text();
    }
    const m = JSON.parse(manifestStr);
    return Array.isArray(m.profiles) ? m.profiles.length : 0;
  } catch {
    return null;
  }
}

/**
 * Fetch un fichier du repo via l'API GitHub Contents (toujours FRAIS, pas de cache CDN).
 * Utilise le token si disponible (raise rate limit), sinon API publique (60 req/h).
 */
async function fetchFileViaApi(path) {
  const cfg = await getCloudConfig();
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${BRANCH}&v=${Date.now()}`;
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
  const res = await fetch(url, { cache: 'no-store', headers });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.content) return null;
  // base64 → utf-8
  return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
}

/**
 * Pull les données du cloud public. Aucun token requis (lecture publique).
 * Utilisable depuis n'importe quel appareil.
 */
export async function pullCloud({ replace = true } = {}) {
  if (isSyncing) return { skipped: true, reason: 'sync busy' };
  isSyncing = true;
  emit({ status: 'pulling', message: 'Connexion au cloud…' });

  try {
    // 1. Fetch le manifest via API GitHub (toujours frais), fallback raw
    let manifest;
    try {
      let manifestStr = await fetchFileViaApi(`${PATH_PREFIX}/${MANIFEST_FILE}`);
      if (!manifestStr) {
        const res = await fetch(rawUrl(MANIFEST_FILE), { cache: 'no-store' });
        if (!res.ok) {
          emit({ status: 'idle' });
          return { success: false, empty: true, reason: `manifest ${res.status}` };
        }
        manifestStr = await res.text();
      }
      manifest = JSON.parse(manifestStr);
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
    let failedChunks = 0;

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
              failedChunks++;
              console.warn(`[Cloud] ${name} → ${res.status}`);
            }
          } catch (e) {
            failedChunks++;
            console.warn(`[Cloud] ${name} échoué:`, e.message);
          }
        }));
      }
    }

    // Sécurité : si > 50% des chunks ont échoué, on n'écrase PAS le local
    // (mieux vaut garder l'ancienne version complète qu'une version trompeuse à moitié
    // pleine). Sous 50%, on importe et on signale.
    if (expectedChunks > 0 && downloadedChunks < Math.ceil(expectedChunks / 2)) {
      emit({ status: 'error', error: `Pull annulé : seulement ${downloadedChunks}/${expectedChunks} fichiers d'images téléchargés.` });
      return { success: false, partialFailure: true, downloadedChunks, expectedChunks };
    }

    // 3. Restaurer en local
    emit({ status: 'pulling', message: `Restauration locale…` });
    let result;
    try {
      result = await importAllChunked(filesByName, { replace });
    } catch (e) {
      emit({ status: 'error', error: 'Restauration locale échouée: ' + e.message });
      return { success: false, error: e.message };
    }

    const hash = await computeHash(filesByName[MANIFEST_FILE] + ':' + (result.images || 0));
    await setMeta(META_LAST_SYNC, new Date().toISOString());
    await setMeta(META_LAST_HASH, hash);
    emit({ status: 'idle', lastSync: new Date().toISOString() });

    // Si certains chunks ont échoué (mais < 50%), avertir l'utilisateur
    if (failedChunks > 0) {
      console.warn(`[Cloud] Pull partiel : ${failedChunks}/${expectedChunks} chunks d'images manquants.`);
    }

    return {
      success: true,
      profiles: result.profiles,
      images: result.images,
      expectedChunks,
      downloadedChunks,
      failedChunks,
      // Stats de convergence remontées du merge : l'appelant re-push si > 0
      localNewer: result.localNewer || 0,
      localOnly: result.localOnly || 0,
      remoteApplied: result.remoteApplied || 0,
      deletedByTombstone: result.deletedByTombstone || 0,
    };
  } finally {
    isSyncing = false;
  }
}

// ============= CYCLE COMPLET PULL → MERGE → PUSH =============

let syncCycleQueued = false;
let lastPushFailAt = 0; // cooldown anti-boucle si le push échoue (403, réseau…)

/**
 * LE point d'entrée pour sauvegarder : pull (merge intelligent, hash-aware —
 * ne télécharge les images que si le distant a changé) puis push.
 * Le pull d'abord évite d'écraser les modifs des autres appareils faites
 * entre-temps ; le push propage les nôtres. Si un cycle tourne déjà, on en
 * re-planifie un — jamais de perte silencieuse.
 */
export async function syncCloud({ reason = 'manual' } = {}) {
  const cfg = await getCloudConfig();
  if (!cfg.token) return { skipped: true, reason: 'no token' };
  if (isSyncing) {
    if (!syncCycleQueued) {
      syncCycleQueued = true;
      setTimeout(() => { syncCycleQueued = false; syncCloud({ reason: reason + '+requeue' }); }, 2000);
    }
    return { skipped: true, reason: 'busy, requeued' };
  }
  // Cooldown : un push qui vient d'échouer (token sans droit, réseau HS)
  // ne doit pas boucler toutes les 2s. Les déclenchements auto respectent
  // 60s de pause ; un clic manuel sur Sauvegarder retente immédiatement.
  const isAuto = reason !== 'manual' && reason !== 'save-button';
  if (isAuto && Date.now() - lastPushFailAt < 60_000) {
    return { skipped: true, reason: 'cooldown après échec push' };
  }
  console.log(`[Cloud] syncCloud (${reason})`);
  // CONVERGENCE GARANTIE : on fusionne TOUJOURS le cloud dans le local AVANT de
  // pousser (pull inconditionnel, pas hash-conditionnel). Sinon un appareil aux
  // données périmées écrasait les modifs fraîches d'un autre (guerre de sync,
  // ex. renommage « Thomas Porchez » perdu). Après ce merge, le local = union
  // des deux états → le push ne peut plus rien faire régresser.
  const pull = await pullCloud({ replace: true });
  const dirty = await getMeta(META_LOCAL_DIRTY);
  const needPush = dirty
    || (pull && ((pull.localNewer || 0) > 0 || (pull.localOnly || 0) > 0));
  let push = null;
  if (needPush) {
    try {
      push = await pushCloud();
      lastPushFailAt = 0;
    } catch (e) {
      lastPushFailAt = Date.now();
      throw e;
    }
  }
  return { pull, push, pushed: !!push };
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

  // Tenter d'abord l'API GitHub (TOUJOURS frais), puis fallback raw
  let manifest, manifestStr;
  try {
    manifestStr = await fetchFileViaApi(`${PATH_PREFIX}/${MANIFEST_FILE}`);
    if (!manifestStr) {
      const res = await fetch(rawUrl(MANIFEST_FILE), { cache: 'no-store' });
      if (!res.ok) return { skipped: true, reason: `no manifest (${res.status})` };
      manifestStr = await res.text();
    }
    manifest = JSON.parse(manifestStr);
  } catch (e) {
    return { skipped: true, reason: 'fetch failed: ' + e.message };
  }

  if (!manifest?.profiles?.length) return { skipped: true, reason: 'manifest empty' };

  const remoteHash = await computeHash(JSON.stringify(manifest) + ':' + (manifest.totalImages || 0));
  const lastHash = await getMeta(META_LAST_HASH);
  const localProfiles = await getAllProfiles();

  // Cas 1 : appareil vierge ou seul le seed est chargé → pull (merge)
  // Cas 2 : remote a changé depuis le dernier pull → pull (merge)
  // Cas 3 : hash identique MAIS désaccord sur le nombre de profils → un
  //         ajout/suppression local n'a jamais été poussé (app tuée avant le
  //         push, etc.) → pull (merge) pour déclencher la détection
  //         localOnly/localNewer et le push-back de convergence.
  // NOTE : le pull est désormais un MERGE par profil (jamais destructif),
  // donc le faire même avec des modifs locales "dirty" est SAFE — les modifs
  // locales plus récentes gagnent toujours.
  const isFreshDevice = !cfg.lastSync && localProfiles.length > 0;
  const remoteChanged = remoteHash !== lastHash;
  const countMismatch = localProfiles.length !== (manifest.profiles?.length || 0);

  if (isFreshDevice || remoteChanged || countMismatch || localDirty) {
    emit({ status: 'pulling', message: `Récupération depuis le cloud (${manifest.profiles.length} profils + ${manifest.totalImages || 0} images)…` });
    try {
      const result = await pullCloud({ replace: true });
      if (result.success) {
        return { autoPulled: true, ...result };
      }
    } catch (e) {
      console.warn('[Cloud] Auto-pull failed:', e.message);
      emit({ status: 'error', error: e.message });
    }
  }
  return { skipped: true };
}

// ============= AUTO-PUSH (debounced) =============

export async function scheduleCloudPush(delayMs = 4000) {
  // Attendre que le flag dirty soit persisté AVANT de planifier le push.
  // Sinon, si une 2e modif arrive juste après et déclenche le push avant
  // que le 1er setMeta soit complete, le flag dirty pourrait ne pas refléter
  // les modifs en cours.
  await setMeta(META_LOCAL_DIRTY, true);
  if (pushTimer) clearTimeout(pushTimer);

  // Repousser jusqu'au reset si le quota est épuisé
  let effectiveDelay = delayMs;
  if (isCloudQuotaExhausted()) {
    const wait = cloudQuotaResetAt - Date.now();
    effectiveDelay = Math.max(delayMs, wait);
    console.log(`[Cloud] Push reporté de ${Math.round(effectiveDelay / 1000)}s (quota atteint).`);
  }

  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try {
      const cfg = await getCloudConfig();
      // Cycle complet pull→merge→push : intègre d'abord les modifs des autres
      // appareils, puis propage les nôtres. syncCloud gère lui-même le "busy".
      if (cfg.token && cfg.auto) await syncCloud({ reason: 'auto-save' });
    } catch (e) {
      console.warn('[Cloud] Auto-sync failed:', e.message);
      // Replanifier si quota encore atteint, silencieusement
      if (e.code === 'QUOTA' || isCloudQuotaExhausted()) {
        const retryDelay = Math.max(5000, cloudQuotaResetAt - Date.now() + 2000);
        console.log(`[Cloud] Replanification dans ${Math.round(retryDelay / 1000)}s.`);
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => scheduleCloudPush(0), retryDelay);
      }
    }
  }, effectiveDelay);
}

// ============= LIEN D'INVITATION (partager le token entre devices) =============

/**
 * Génère un lien d'invitation contenant le PAT cloud public en base64.
 * À ouvrir sur tout autre appareil → configure auto le cloud → permet
 * non seulement la lecture (déjà publique) mais aussi l'écriture
 * de modifications depuis ce device.
 */
// Durée de validité d'un lien d'invitation magique (24h)
const INVITE_LINK_TTL_MS = 24 * 60 * 60 * 1000;

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
 * Le lien expire après 24h pour limiter les fuites accidentelles via historique.
 */
export async function consumeCloudActivateParam() {
  try {
    const url = new URL(window.location.href);
    const param = url.searchParams.get('cloud');
    if (!param) return null;
    // Nettoyer l'URL D'ABORD pour éviter que le PAT reste visible si on est
    // interrompu par une erreur de parse (sécurité défensive).
    url.searchParams.delete('cloud');
    history.replaceState(null, '', url.toString());

    const payload = JSON.parse(atob(param));
    if (!payload.ct) return null;
    // Vérifier l'expiration (24h)
    if (payload.ts && Date.now() - payload.ts > INVITE_LINK_TTL_MS) {
      const ageH = Math.round((Date.now() - payload.ts) / 3600000);
      return { activated: false, error: `Lien expiré (${ageH}h). Demandez un nouveau lien depuis l'appareil source.` };
    }
    await setMeta(META_TOKEN, payload.ct);
    await setMeta(META_AUTO, true);
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
