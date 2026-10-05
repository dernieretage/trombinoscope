// Fusion de profils entre appareils — logique PURE (aucune dépendance au
// navigateur, testée en Node : `node --test test/`).
//
// Chaque profil porte `_f` : { champ: horodatage ms de sa dernière modif },
// plus `_f.imgs` pour son jeu de photos. La fusion se fait CHAMP PAR CHAMP :
// le plus récent gagne. Deux personnes qui modifient deux champs différents
// du même profil au même moment gardent toutes les deux leur modification,
// comme dans un document partagé.

const META_KEYS = new Set(['id', '_f', 'imgs', 'deleted', 'deletedAt', 'updatedAt']);

export const ts = (x) => (typeof x === 'number' ? x : Date.parse(x || '')) || 0;

export function profileFields(p) {
  return p ? Object.keys(p).filter((k) => !META_KEYS.has(k) && typeof p[k] !== 'function') : [];
}

function norm(v) {
  if (v === undefined || v === null || v === '') return null;
  if (Array.isArray(v) && !v.length) return null;
  return v;
}
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** Égalité « métier » : '' / null / undefined / [] sont équivalents. */
export function sameValue(a, b) {
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  if (x === null || y === null) return false;
  if (typeof x !== 'object' || typeof y !== 'object') return false;
  return stable(x) === stable(y);
}

/** Horodatage effectif de chaque champ (repli : updatedAt pour les données anciennes). */
export function stampsOf(p) {
  const base = ts(p?.updatedAt);
  const f = (p && p._f) || {};
  const out = {};
  for (const k of profileFields(p)) out[k] = Number.isFinite(f[k]) ? f[k] : base;
  for (const [k, v] of Object.entries(f)) if (!(k in out) && Number.isFinite(v)) out[k] = v;
  out.imgs = Number.isFinite(f.imgs) ? f.imgs : base;
  return out;
}

/** Instant de la modification la plus récente du profil (champs et photos). */
export function maxStamp(p) {
  if (!p) return 0;
  const vals = Object.values(stampsOf(p)).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : ts(p.updatedAt);
}

/**
 * Pose `_f` sur `next` en comparant à `prev` (version précédente en base).
 * Retourne la liste des champs réellement modifiés. Les champs inchangés
 * conservent leur horodatage d'origine.
 */
export function stampChanges(next, prev, now) {
  const prevStamps = prev ? stampsOf(prev) : {};
  const keys = new Set([...profileFields(next), ...profileFields(prev)]);
  const f = {};
  const changed = [];
  for (const k of keys) {
    if (prev && sameValue(next[k], prev[k])) f[k] = prevStamps[k] || now;
    else { f[k] = now; changed.push(k); }
  }
  f.imgs = prev ? (prevStamps.imgs || now) : now;
  next._f = f;
  return changed;
}

/** Copie d'un profil sans les métadonnées de synchronisation serveur. */
export function stripRemoteMeta(p) {
  const out = { ...p };
  delete out.imgs; delete out.deleted; delete out.deletedAt;
  return out;
}

/**
 * Fusionne la version locale et la version serveur d'un profil.
 *
 * Retour :
 *  - result       : profil fusionné (sans `imgs`/`deleted`), ou null si supprimé
 *  - localChanged : le local doit être réécrit avec `result`
 *  - pushNeeded   : le serveur doit recevoir `result` (il contient du local plus récent)
 *  - imgs         : 'local' | 'remote' | 'same' — quel jeu de photos fait foi
 *  - deleted      : true si la fusion conclut à la suppression
 *
 * Cas de la suppression serveur : le profil ne revit que si une modification
 * locale (champ ou photos) est POSTÉRIEURE à la suppression.
 * Égalité d'horodatage avec valeurs différentes : le serveur gagne
 * (départage déterministe → tous les appareils convergent).
 */
export function mergeProfiles(local, remote, { pendingDeleteAt = 0 } = {}) {
  if (remote && remote.deleted) {
    const delAt = ts(remote.deletedAt) || ts(remote.updatedAt);
    if (!local) return { result: null, localChanged: false, pushNeeded: false, imgs: 'same', deleted: true };
    if (maxStamp(local) > delAt) {
      return { result: stripRemoteMeta(local), localChanged: false, pushNeeded: true, imgs: 'local', deleted: false };
    }
    return { result: null, localChanged: true, pushNeeded: false, imgs: 'same', deleted: true };
  }
  if (!remote) {
    return { result: stripRemoteMeta(local), localChanged: false, pushNeeded: true, imgs: 'local', deleted: false };
  }
  if (!local) {
    // Supprimé ici, modifié là-bas après coup → il revit ; sinon notre suppression l'emporte.
    if (pendingDeleteAt && maxStamp(remote) <= pendingDeleteAt) {
      return { result: null, localChanged: false, pushNeeded: true, imgs: 'same', deleted: true };
    }
    return { result: stripRemoteMeta(remote), localChanged: true, pushNeeded: false, imgs: 'remote', deleted: false };
  }

  const ls = stampsOf(local);
  const rs = stampsOf(remote);
  const keys = new Set([...profileFields(local), ...profileFields(remote)]);
  const result = { id: local.id || remote.id };
  const f = {};
  let localChanged = false;
  let pushNeeded = false;
  for (const k of keys) {
    const lv = local[k], rv = remote[k];
    const lt = ls[k] || 0, rt = rs[k] || 0;
    let v, t;
    if (lt > rt) { v = lv; t = lt; if (!sameValue(lv, rv)) pushNeeded = true; }
    else if (rt > lt) { v = rv; t = rt; if (!sameValue(lv, rv)) localChanged = true; }
    else { v = rv; t = rt; if (!sameValue(lv, rv)) localChanged = true; }
    if (v !== undefined) result[k] = v;
    f[k] = t;
  }
  let imgs = 'same';
  if (ls.imgs > rs.imgs) { imgs = 'local'; pushNeeded = true; f.imgs = ls.imgs; }
  else if (rs.imgs > ls.imgs) { imgs = 'remote'; localChanged = true; f.imgs = rs.imgs; }
  else f.imgs = rs.imgs;
  result._f = f;
  const all = Object.values(f).filter(Number.isFinite);
  result.updatedAt = new Date(all.length ? Math.max(...all) : Date.now()).toISOString();
  if (!localChanged && (result.updatedAt !== local.updatedAt || stable(local._f || {}) !== stable(f))) localChanged = true;
  return { result, localChanged, pushNeeded, imgs, deleted: false };
}
