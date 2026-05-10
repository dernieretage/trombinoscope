// Auto-application des infos enrichies par recherche web (data/enrichment.json)
// Au démarrage, on charge le fichier d'enrichissement et on merge avec les profils
// existants. L'utilisateur peut désactiver via getMeta('enrichment_disabled').

import { getAllProfiles, saveProfile, getMeta, setMeta } from './store.js';

const ENRICHMENT_URL = './data/enrichment.json';
const META_LAST_VERSION = 'enrichment_last_version';

export async function applyEnrichmentIfNew() {
  if (await getMeta('enrichment_disabled')) return { skipped: true };
  let manifest;
  try {
    const r = await fetch(ENRICHMENT_URL + '?v=' + Date.now());
    if (!r.ok) return { skipped: true, reason: 'no manifest' };
    manifest = await r.json();
  } catch (e) {
    return { skipped: true, reason: 'fetch failed: ' + e.message };
  }
  if (!manifest?.version) return { skipped: true };

  const lastVersion = await getMeta(META_LAST_VERSION);
  if (lastVersion === manifest.version) return { skipped: true, reason: 'already applied' };

  const profiles = await getAllProfiles();
  let updated = 0;
  for (const p of profiles) {
    const handle = (p.instagram || '').toLowerCase();
    const enrich = manifest.profiles?.[handle];
    if (!enrich) continue;
    let changed = false;
    // Champs : appliquer SEULEMENT si vide / pas modifié par l'user
    if (enrich.website && !p.website) { p.website = enrich.website; changed = true; }
    if (enrich.email && !p.email) { p.email = enrich.email; changed = true; }
    if (enrich.phone && !p.phone) { p.phone = enrich.phone; changed = true; }
    if (enrich.location && !p.location) { p.location = enrich.location; changed = true; }
    if (enrich.bio && !p.bio) { p.bio = enrich.bio; changed = true; }
    if (enrich.professions?.length) {
      // Merger les métiers (sans doublon)
      const existing = new Set((p.professions || []).map(x => x.toLowerCase()));
      const toAdd = enrich.professions.filter(x => !existing.has(x.toLowerCase()));
      if (toAdd.length) {
        p.professions = [...(p.professions || []), ...toAdd];
        changed = true;
      }
    }
    if (enrich.tags?.length) {
      const existing = new Set((p.tags || []).map(x => x.toLowerCase()));
      const toAdd = enrich.tags.filter(x => !existing.has(x.toLowerCase()));
      if (toAdd.length) {
        p.tags = [...(p.tags || []), ...toAdd];
        changed = true;
      }
    }
    if (enrich.agency && !p.agency) { p.agency = enrich.agency; changed = true; }
    if (changed) {
      await saveProfile(p);
      updated++;
    }
  }
  await setMeta(META_LAST_VERSION, manifest.version);
  return { applied: true, version: manifest.version, updated, total: profiles.length };
}
