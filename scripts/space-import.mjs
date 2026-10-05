// Import de profils dans l'espace partagé (Firestore) — utilisé par le robot
// quand data/robot-import.json est présent sur gh-pages.
//
// Format du fichier : { profiles: [ { name, professions[], instagram, phone,
// email, tags[], projects, notes, status, website, location, agency } ] }.
//
// Règles de fusion avec un profil déjà présent (trouvé par handle Instagram,
// sinon par nom) : on COMPLÈTE, on n'écrase jamais — champs vides remplis,
// métiers/tags réunis, collaboration ajoutée au texte, statut passé à
// « déjà collaboré » s'il était vide ou « à contacter ». Un nom généré
// automatiquement depuis le handle (ex. « Pierreloysjbrtdop ») est remplacé
// par le vrai nom. Un profil supprimé auparavant n'est pas recréé.
// Chaque champ modifié reçoit son horodatage (_f) comme dans l'app.

import { doc, runTransaction } from 'firebase/firestore';

const META = new Set(['id', '_f', 'imgs', 'deleted', 'deletedAt', 'updatedAt']);
const ARRAY_FIELDS = new Set(['professions', 'tags']);

export function cleanHandle(h) {
  return String(h || '').replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?#].*$/, '').trim().toLowerCase();
}
export function normName(n) {
  return String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function uid() { return 'p_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36); }
function empty(v) { return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length); }
function unionCI(a, b) {
  const out = [...(a || [])];
  const seen = new Set(out.map((x) => String(x).toLowerCase()));
  for (const x of b || []) { const k = String(x).toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
/** Nom auto-généré par l'app depuis le handle (« Pierreloysjbrtdop ») ? */
function looksAutoNamed(name, handle) {
  if (!name || !handle) return false;
  const a = normName(name).replace(/\s/g, '');
  const b = handle.replace(/[._-]/g, '');
  return a === b || a === handle.replace(/[._-]/g, ' ').replace(/\s/g, '');
}

/** Calcule le profil fusionné ; retourne { next, changed[] } (changed vide = rien à écrire). */
export function mergeIncoming(existing, inc) {
  const next = { ...existing };
  const changed = [];
  const set = (k, v) => { next[k] = v; changed.push(k); };
  const handle = cleanHandle(inc.instagram || existing.instagram);
  if (!empty(inc.name) && (empty(existing.name) || looksAutoNamed(existing.name, handle))) set('name', inc.name);
  for (const k of ['instagram', 'phone', 'email', 'website', 'location', 'agency', 'rate']) {
    if (!empty(inc[k]) && empty(existing[k])) set(k, k === 'instagram' ? cleanHandle(inc[k]) : inc[k]);
  }
  for (const k of ARRAY_FIELDS) {
    if (!empty(inc[k])) { const u = unionCI(existing[k], inc[k]); if (u.length !== (existing[k] || []).length) set(k, u); }
  }
  if (!empty(inc.projects)) {
    const cur = String(existing.projects || '');
    const parts = String(inc.projects).split(' · ').map((s) => s.trim()).filter((s) => s && !cur.toLowerCase().includes(s.toLowerCase()));
    if (parts.length) set('projects', cur ? cur + ' · ' + parts.join(' · ') : parts.join(' · '));
  }
  if (!empty(inc.notes)) {
    const cur = String(existing.notes || '');
    const lines = String(inc.notes).split('\n').filter((l) => l.trim() && !cur.includes(l.trim()));
    if (lines.length) set('notes', cur ? cur + '\n' + lines.join('\n') : lines.join('\n'));
  }
  if (!empty(inc.status) && (empty(existing.status) || existing.status === 'a_contacter') && existing.status !== inc.status) set('status', inc.status);
  // `replace` : champs à REMPLACER explicitement (ex. recatégorisation décidée
  // par l'utilisateur) — seule exception à la règle « on n'écrase jamais ».
  for (const [k, v] of Object.entries(inc.replace || {})) {
    if (META.has(k)) continue;
    const same = Array.isArray(v) ? JSON.stringify((existing[k] || []).map(String)) === JSON.stringify(v.map(String)) : String(existing[k] ?? '') === String(v ?? '');
    if (!same) { next[k] = v; if (!changed.includes(k)) changed.push(k); }
  }
  return { next, changed };
}

/**
 * @param db Firestore ; spaceId ; existing = profils de l'espace (avec id) ;
 * incoming = profils du fichier. Retourne { created, merged, skipped, lines }.
 */
export async function importIntoSpace(db, spaceId, existing, incoming, { log = console.log } = {}) {
  const byHandle = new Map();
  const byName = new Map();
  for (const p of existing) {
    const h = cleanHandle(p.instagram);
    if (h && !byHandle.has(h)) byHandle.set(h, p);
    const n = normName(p.name);
    if (n) byName.set(n, byName.has(n) ? null : p); // null = ambigu
  }
  const res = { created: 0, merged: 0, skipped: 0, unchanged: 0, lines: [] };
  const now0 = Date.now();
  for (const inc of incoming) {
    if (!inc || empty(inc.name)) { res.skipped++; continue; }
    const h = cleanHandle(inc.instagram);
    let target = (h && byHandle.get(h)) || byName.get(normName(inc.name)) || null;
    const ref = doc(db, 'spaces', spaceId, 'profiles', target ? target.id : uid());
    const outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists() ? snap.data() : null;
      const now = Date.now();
      if (cur && cur.deleted) return 'deleted';
      if (!cur) {
        const p = { id: ref.id, createdAt: new Date(now).toISOString() };
        for (const k of ['name', 'professions', 'instagram', 'phone', 'email', 'website', 'location', 'agency', 'rate', 'tags', 'projects', 'notes', 'status', 'bio']) {
          if (!empty(inc[k])) p[k] = k === 'instagram' ? h : inc[k];
        }
        for (const [k, v] of Object.entries(inc.replace || {})) if (!META.has(k)) p[k] = v;
        const f = {};
        for (const k of Object.keys(p)) if (!META.has(k)) f[k] = now;
        f.imgs = now;
        tx.set(ref, { ...p, _f: f, imgs: {}, deleted: false, updatedAt: new Date(now).toISOString() });
        return 'created';
      }
      const { next, changed } = mergeIncoming(cur, inc);
      if (!changed.length) return 'unchanged';
      const f = { ...(cur._f || {}) };
      for (const k of changed) f[k] = now;
      tx.set(ref, { ...next, _f: f, updatedAt: new Date(now).toISOString() });
      return 'merged:' + changed.join(',');
    });
    if (outcome === 'created') {
      res.created++;
      const p = { id: ref.id, ...inc, instagram: h };
      if (h) byHandle.set(h, p);
      byName.set(normName(inc.name), p);
      res.lines.push(`  + ${inc.name}${h ? ' (@' + h + ')' : ''} — créé`);
    } else if (outcome === 'deleted') { res.skipped++; res.lines.push(`  · ${inc.name} — supprimé auparavant dans l'app, non recréé`); }
    else if (outcome === 'unchanged') { res.unchanged++; res.lines.push(`  = ${inc.name} — déjà à jour`); }
    else { res.merged++; res.lines.push(`  ~ ${inc.name} — fusionné avec le profil existant (${outcome.slice(7)})`); }
  }
  log(`Import : ${res.created} créé(s), ${res.merged} fusionné(s), ${res.unchanged} inchangé(s), ${res.skipped} ignoré(s) en ${Math.round((Date.now() - now0) / 1000)} s`);
  return res;
}
