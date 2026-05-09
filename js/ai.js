// Mode "Scan IA" expérimental — utilise l'API Claude pour rechercher
// automatiquement les infos publiques d'une personne (site, mail pro, bio).
//
// IMPORTANT : la clé API Anthropic est stockée localement dans IndexedDB.
// Elle n'est JAMAIS envoyée à un autre service que api.anthropic.com.
// Toutes les requêtes vont directement du navigateur vers Anthropic.

import { getMeta, setMeta } from './store.js';

const META_KEY = 'ai_anthropic_key';
const META_MODEL = 'ai_model';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export async function getAiKey() { return await getMeta(META_KEY); }
export async function setAiKey(key) { await setMeta(META_KEY, key || null); }
export async function getAiModel() { return (await getMeta(META_MODEL)) || DEFAULT_MODEL; }
export async function setAiModel(m) { await setMeta(META_MODEL, m || DEFAULT_MODEL); }

export async function isAiConfigured() {
  const k = await getAiKey();
  return !!k;
}

// ============= APPEL CLAUDE AVEC WEB SEARCH =============

export async function scanProfileWithAi(profile) {
  const key = await getAiKey();
  if (!key) throw new Error('Clé API Anthropic non configurée.');
  const model = await getAiModel();

  const fullName = profile.name || '';
  const handle = profile.instagram || '';
  const knownPros = (profile.professions || []).join(', ');

  const prompt = `Je cherche les coordonnées professionnelles publiques de cette personne pour un répertoire de production audiovisuelle.

PERSONNE :
- Nom : ${fullName}
- Instagram : @${handle}
- Métier(s) connu(s) : ${knownPros || 'inconnu'}

OBJECTIF : utilise web_search pour trouver les informations PUBLIQUES suivantes (uniquement si tu les trouves de façon vérifiable et non spéculative) :
- Site web personnel ou portfolio (URL complète)
- E-mail professionnel public
- Téléphone professionnel public (rare, ne pas inventer)
- Localisation (ville/pays)
- Bio courte (1-3 phrases factuelles)
- Métier(s) confirmés (par exemple ajouter "Directeur·rice artistique" si trouvé)
- Tags pertinents (ex: "mode", "clip", "documentaire")

CONSIGNES STRICTES :
1. N'invente JAMAIS de données. Si tu ne trouves pas, écris null.
2. Vérifie via plusieurs sources si possible.
3. Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, dans ce format :
{
  "website": "https://... ou null",
  "email": "..@.. ou null",
  "phone": "... ou null",
  "location": "Ville, Pays ou null",
  "bio": "phrase factuelle ou null",
  "professions": ["...", "..."],
  "tags": ["...", "..."],
  "confidence": "low|medium|high",
  "sources": ["url1", "url2"]
}`;

  const body = {
    model,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) throw new Error('Clé API invalide.');
  if (res.status === 429) throw new Error('Quota dépassé — réessayez dans quelques minutes.');
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Erreur API ${res.status} : ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  // Extraction du dernier bloc texte
  const blocks = data.content || [];
  let text = '';
  for (const b of blocks) {
    if (b.type === 'text') text += b.text + '\n';
  }

  // Parser le JSON de la réponse
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Réponse IA non parsable. Réessayez.');
  let result;
  try {
    result = JSON.parse(match[0]);
  } catch (e) {
    throw new Error('JSON invalide retourné par l’IA.');
  }

  // Nettoyer les valeurs null littérales
  for (const k of Object.keys(result)) {
    if (result[k] === 'null' || result[k] === '') result[k] = null;
  }

  return result;
}

export async function testAiConnection(key, model = DEFAULT_MODEL) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Réponds simplement "ok"' }],
    }),
  });
  if (res.status === 401) throw new Error('Clé invalide.');
  if (res.status === 404) throw new Error(`Modèle "${model}" introuvable.`);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Erreur ${res.status} : ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return { model: data.model, ok: true };
}
