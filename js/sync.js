// Sync cross-device via GitHub Gist
// L'utilisateur fournit un Personal Access Token avec scope `gist`.
// L'app crée un gist privé "trombinoscope-data" et y stocke un dump JSON.
// Sync auto au démarrage (pull) et après chaque modif (push, debouncé).

import { exportAll, importAll, getMeta, setMeta, getAllProfiles } from './store.js';

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
  // Chercher un gist existant
  const gists = await ghFetch('/gists?per_page=100');
  const found = gists.find(g => g.description === GIST_DESCRIPTION || (g.files && g.files[GIST_FILENAME]));
  if (found) {
    await setMeta(META_GIST_ID, found.id);
    return found.id;
  }
  // Créer
  const created = await ghFetch('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify({ profiles: [], images: [], version: 2, exportedAt: new Date().toISOString() }) } },
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
    const data = await exportAll();
    const content = JSON.stringify(data);
    const hash = await computeHash(content);
    await ghFetch(`/gists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content } } }),
    });
    await setMeta(META_LAST_SYNC, new Date().toISOString());
    await setMeta(META_LAST_REMOTE_HASH, hash);
    emit({ status: 'idle', lastSync: new Date().toISOString() });
    return { success: true, profiles: data.profiles?.length };
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
  emit({ status: 'pulling' });
  try {
    const id = await findOrCreateGist();
    const gist = await ghFetch(`/gists/${id}`);
    const file = gist.files?.[GIST_FILENAME];
    if (!file) {
      emit({ status: 'idle' });
      return { success: true, empty: true };
    }
    let content = file.content;
    if (file.truncated && file.raw_url) {
      content = await fetch(file.raw_url).then(r => r.text());
    }
    const data = JSON.parse(content);
    if (!data.profiles?.length && !data.images?.length) {
      emit({ status: 'idle' });
      return { success: true, empty: true };
    }
    await importAll(data, { replace });
    const hash = await computeHash(content);
    await setMeta(META_LAST_SYNC, new Date().toISOString());
    await setMeta(META_LAST_REMOTE_HASH, hash);
    emit({ status: 'idle', lastSync: new Date().toISOString() });
    return { success: true, profiles: data.profiles?.length };
  } catch (e) {
    emit({ status: 'error', error: e.message });
    throw e;
  } finally {
    isSyncing = false;
  }
}

// ============= AUTO-SYNC =============

export async function setupAutoSync() {
  const cfg = await getSyncConfig();
  if (!cfg.token) { isReady = false; return false; }
  isReady = true;

  // Pull au démarrage si data distante plus récente
  if (cfg.autoSync) {
    try {
      const localProfiles = await getAllProfiles();
      const id = await findOrCreateGist();
      const gist = await ghFetch(`/gists/${id}`);
      const remoteUpdated = gist.updated_at;
      const lastSync = cfg.lastSync;
      // Si pas de last sync, ou si remote > last sync, pull
      const remoteIsNewer = !lastSync || new Date(remoteUpdated) > new Date(lastSync);
      if (remoteIsNewer) {
        const file = gist.files?.[GIST_FILENAME];
        if (file && file.size > 100) {
          // Si local n'est pas vide, demander confirmation (laissé à l'app)
          if (localProfiles.length > 0) {
            emit({ status: 'remote-newer', remoteUpdated, gistId: id });
          } else {
            await pullNow({ replace: true });
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

export function schedulePush(delayMs = 4000) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try {
      const cfg = await getSyncConfig();
      if (cfg.token && cfg.autoSync) await pushNow();
    } catch (e) {
      console.warn('Auto-push failed:', e.message);
    }
  }, delayMs);
}
