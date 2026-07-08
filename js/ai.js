// Mode "Scan IA" — utilise l'API Claude (Anthropic) pour extraire les infos publiques.
//
// Stratégie en 2 étapes (plus fiable que d'utiliser web_search côté Anthropic
// qui n'est pas toujours dispo en mode browser direct) :
//   1) Recherche DuckDuckGo via r.jina.ai pour trouver site, mentions publiques
//   2) Récupération du contenu des pages trouvées via r.jina.ai
//   3) Envoi du contenu à Claude pour extraction JSON structurée
//
// La clé API Anthropic est stockée localement, jamais envoyée ailleurs que
// vers api.anthropic.com.

import { getMeta, setMeta } from './store.js';

const META_KEY = 'ai_anthropic_key';
const META_MODEL = 'ai_model';
const DEFAULT_MODEL = 'claude-sonnet-5'; // ID valide (l'ancien 'claude-sonnet-4-6' n'existe pas → scan IA en erreur)
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const JINA_BASE = 'https://r.jina.ai/';

export async function getAiKey() { return await getMeta(META_KEY); }
export async function setAiKey(key) { await setMeta(META_KEY, key || null); }
const VALID_MODELS = new Set(['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']);
export async function getAiModel() {
  const m = await getMeta(META_MODEL);
  // Un modèle périmé stocké (ex. 'claude-sonnet-4-6' d'une version passée) est
  // invalide sur l'API → on retombe sur un ID valide.
  return (m && VALID_MODELS.has(m)) ? m : DEFAULT_MODEL;
}
export async function setAiModel(m) { await setMeta(META_MODEL, VALID_MODELS.has(m) ? m : DEFAULT_MODEL); }

export async function isAiConfigured() {
  const k = await getAiKey();
  return !!k;
}

// ============= ÉTAPE 1 : RECHERCHE WEB (côté navigateur) =============

async function jinaGet(url) {
  const r = await fetch(JINA_BASE + url, { headers: { 'X-Return-Format': 'markdown' } });
  if (!r.ok) throw new Error(`Jina ${r.status}`);
  return r.text();
}

async function searchWebForProfile({ name, instagram, professions }) {
  const queries = [
    `${name} ${instagram ? '@' + instagram : ''} ${professions.join(' ')}`,
    `${name} contact email site web`,
    instagram ? `instagram.com/${instagram} site personnel` : null,
  ].filter(Boolean);

  const findings = [];
  for (const q of queries.slice(0, 2)) { // max 2 requêtes pour garder vite
    try {
      const md = await jinaGet(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web`);
      // Extraire les URLs de résultats
      const urls = [...new Set(md.match(/https?:\/\/[^\s\)\]"<>]{8,200}/g) || [])]
        .filter(u => !/duckduckgo|yandex|bing|google|youtube|instagram\.com\/p|instagram\.com\/reel|instagram\.com\/p\//i.test(u))
        .filter(u => !/\.png|\.jpg|\.gif|\.webp|\.svg|\.ico/i.test(u))
        .slice(0, 3);
      findings.push({ query: q, urls });
    } catch (e) { /* skip */ }
  }
  return findings;
}

async function fetchPagesContent(urls, maxChars = 2000) {
  const out = [];
  for (const u of urls.slice(0, 5)) {
    try {
      const md = await jinaGet(u);
      out.push({ url: u, content: md.substring(0, maxChars) });
    } catch (e) { /* skip */ }
  }
  return out;
}

// ============= ÉTAPE 2 : ANALYSE PAR CLAUDE =============

export async function scanProfileWithAi(profile, onProgress = () => {}) {
  const key = await getAiKey();
  if (!key) throw new Error('Clé API Anthropic non configurée. Ouvrez Réglages.');
  const model = await getAiModel();

  const fullName = profile.name || '';
  const handle = profile.instagram || '';
  const knownPros = (profile.professions || []).join(', ');

  // Étape 1 : recherche web
  onProgress({ message: 'Recherche web…' });
  const findings = await searchWebForProfile({ name: fullName, instagram: handle, professions: profile.professions || [] });

  // Étape 2 : récupérer le contenu des meilleures URLs
  const allUrls = [...new Set(findings.flatMap(f => f.urls))];
  onProgress({ message: `Lecture de ${Math.min(allUrls.length, 4)} pages…` });
  const pages = await fetchPagesContent(allUrls, 1800);

  // Étape 3 : Demander à Claude d'extraire
  onProgress({ message: 'Analyse par Claude…' });

  let context = '';
  if (handle) context += `Instagram: https://www.instagram.com/${handle}/\n`;
  for (const p of pages) {
    context += `\n--- SOURCE: ${p.url} ---\n${p.content}\n`;
  }

  const prompt = `Tu es un assistant de recherche pour un répertoire de production audiovisuelle.

PROFIL CIBLE :
- Nom : ${fullName}
- Instagram : @${handle || '(inconnu)'}
- Métier(s) connu(s) : ${knownPros || 'inconnu'}

CONTENU TROUVÉ EN LIGNE (extraits de pages publiques) :
${context || '(aucun résultat trouvé)'}

OBJECTIF : extraire UNIQUEMENT les informations publiques vérifiables sur cette personne.

INSTRUCTIONS STRICTES :
1. N'invente JAMAIS. Si tu n'es pas certain à 90%+, mets null.
2. Vérifie que les infos correspondent BIEN à cette personne (pas un homonyme).
3. Pour la bio : 1 à 3 phrases factuelles SEULEMENT (pas de remplissage).
4. Pour les sources : cite seulement les URLs qui ont vraiment fourni l'info.

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans texte autour, dans ce format exact :

{
  "website": "https://... ou null",
  "email": "..@.. ou null",
  "phone": "+33... ou null",
  "location": "Ville, Pays ou null",
  "bio": "phrase factuelle ou null",
  "professions": ["...", "..."],
  "tags": ["mot-clé1", "mot-clé2"],
  "confidence": "low|medium|high",
  "sources": ["url1", "url2"]
}`;

  const body = {
    model,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
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
  if (res.status === 400) {
    const txt = await res.text();
    throw new Error('Requête invalide : ' + txt.substring(0, 200));
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Erreur API ${res.status} : ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  // Anthropic stop_reason : 'end_turn' (OK), 'max_tokens' (tronqué), 'stop_sequence', etc.
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Réponse IA tronquée (max_tokens atteint). Le profil est trop long ou le modèle a beaucoup détaillé. Réessayez avec un autre modèle.');
  }
  const blocks = data.content || [];
  if (!blocks.length) {
    throw new Error('Réponse IA vide (stop_reason=' + (data.stop_reason || 'inconnu') + ').');
  }
  let text = '';
  for (const b of blocks) if (b.type === 'text') text += b.text + '\n';

  if (!text.trim()) throw new Error('Réponse IA sans contenu texte.');

  // Trouver le dernier bloc JSON équilibré (l'IA peut écrire du texte avant/après)
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Réponse IA non parsable (pas de JSON trouvé). Réessayez.');
  let result;
  try {
    result = JSON.parse(match[0]);
  } catch (e) {
    throw new Error(`JSON invalide retourné par l\'IA : ${e.message.slice(0, 100)}. Réessayez.`);
  }

  // Nettoyer null littéraux
  for (const k of Object.keys(result)) {
    if (result[k] === 'null' || result[k] === '') result[k] = null;
  }

  // Ajouter les sources des findings au cas où l'IA ne les liste pas
  if (!result.sources?.length && pages.length) {
    result.sources = pages.map(p => p.url).slice(0, 3);
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
