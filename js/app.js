// Orchestrateur principal du Trombinoscope
import {
  getAllProfiles, saveProfile, deleteProfile, bulkSaveProfiles,
  saveImage, getProfileImages, deleteImage, deleteProfileImages,
  exportAll, importAll, getMeta, setMeta, estimateUsage, uid,
  cleanupOrphanImages,
} from './store.js';
import { SEED_PROFILES, PROFESSIONS, STATUSES } from './seed.js';
import {
  $, $$, debounce, downscaleImage, fmtBytes, fuzzyMatch,
  parseInstagramHandle, guessNameFromHandle, isTypingContext,
  objectURLFor, revokeObjectURL,
} from './utils.js';
import {
  renderCard, renderRow, renderProfileDetail, applyAvatar,
  toast, confirmDialog,
} from './ui.js';
import { fetchInstagramProfile, fetchInstagramProfilePicOnly, fetchImageAsBlob, isMicrolinkRateLimited, resetMicrolinkRateLimit } from './ig.js';
import {
  getSyncConfig, setSyncToken, setSyncAutoSync, clearSyncConfig,
  testConnection as testSyncConnection,
  pushNow as syncPushNow, pullNow as syncPullNow,
  setupAutoSync, schedulePush, onSyncStateChange, isSyncReady, diagnoseSync,
  generateInviteLink, consumeActivateParam,
} from './sync.js';
import {
  getCloudConfig, setCloudToken, setCloudAuto, clearCloudConfig,
  testCloudConnection, pushCloud, pullCloud, setupCloudAutoPull,
  scheduleCloudPush, onCloudStateChange, diagnoseCloud, markCloudDirty,
  generateCloudInviteLink, consumeCloudActivateParam, syncCloud, cloudProfileCount,
} from './cloud.js';
import { ensureAuthGate } from './auth.js';
import {
  getAiKey, setAiKey, getAiModel, setAiModel,
  isAiConfigured, scanProfileWithAi, testAiConnection,
} from './ai.js';
import { applyEnrichmentIfNew } from './enrichment.js';
import { renderQRToCanvas } from './qr.js';

// ============= STATE =============

const STATE = {
  profiles: [],
  imagesByProfile: new Map(),  // profileId -> [imgRecord]
  filters: {
    query: '',
    profession: 'all',  // 'all' ou nom de métier
    status: '',         // '' ou id de statut
    tag: '',            // '' ou tag
    sort: 'favoris',    // 'favoris' | 'name' | 'recent' | 'created' | 'profession' | 'status'
  },
  view: 'grid',         // 'grid' | 'list'
  current: null,        // profile ouvert dans modal
  filtered: [],
  recentlyViewed: [],   // ids des derniers profils ouverts
};

// ============= INIT =============

(async function init() {
  // restore prefs
  const theme = await getMeta('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.body.dataset.theme = theme;
  STATE.view = await getMeta('view') || 'grid';
  STATE.filters.sort = await getMeta('sort') || 'favoris';
  STATE.filters.profession = await getMeta('profession') || 'all';

  // PORTE D'ENTRÉE : mot de passe → déverrouille la clé d'écriture pour CET
  // appareil (plus aucun token à configurer, sur aucun appareil). Le boot
  // (pull public en lecture) continue en dessous pendant la saisie.
  ensureAuthGate({
    onUnlocked: () => {
      updateSyncPill();
      updateSaveButton();
      toast('✓ Accès déverrouillé — cet appareil peut maintenant modifier le trombinoscope.', { type: 'ok', timeout: 4500 });
      // Pousser d'éventuelles données locales en attente (profil ajouté avant
      // le déverrouillage, par exemple).
      syncCloud({ reason: 'unlock' }).catch(() => {});
    },
  }).catch((e) => console.warn('[Auth] gate error:', e.message));

  // ===== REMISE À ZÉRO UNIQUE (incident doublons du 08/07/2026) =====
  // Certains appareils avaient accumulé le seed EN PLUS du cloud (doublons).
  // Cette migration, exécutée UNE SEULE FOIS par appareil, vide le local et
  // force une réadoption propre du cloud. Après ça, plus aucun doublon ne
  // peut être re-poussé.
  const RESET_FLAG = 'hard_reset_dupfix_20260708';
  if (!(await getMeta(RESET_FLAG))) {
    try {
      const localForReset = await getAllProfiles();
      const remoteN = await cloudProfileCount();
      // On ne réinitialise que si le cloud est joignable ET non-vide, pour ne
      // pas effacer un appareil hors-ligne qui aurait les seules données.
      if (remoteN && remoteN > 0) {
        const bootMark = document.querySelector('.boot__mark');
        if (bootMark) bootMark.innerHTML = '<span style="font-size:10px; letter-spacing:.04em">MAJ…</span>';
        const { clearAllProfilesAndImages } = await import('./store.js');
        await clearAllProfilesAndImages();
        await setMeta('seeded', true);        // ne jamais re-semer
        await setMeta(RESET_FLAG, true);
        await setMeta('cloud_last_hash', null); // forcer un vrai pull
        await setMeta('cloud_chunk_state', null);
        console.log(`[Reset] Doublons purgés (local avait ${localForReset.length}, cloud=${remoteN}). Réadoption propre.`);
      } else {
        // Cloud injoignable : on repousse la migration au prochain boot.
        console.log('[Reset] Cloud injoignable, migration reportée.');
      }
    } catch (e) {
      console.warn('[Reset] migration échouée (reportée):', e.message);
    }
  }

  // PRIORITÉ #1 : si DB vide, tenter d'abord le cloud AVANT de seed
  // (sinon en navigation privée / nouveau device, on flash le seed obsolète
  // pendant 5-10s, ce qui masque les vraies données).
  let profiles = await getAllProfiles();
  if (!profiles.length) {
    // Boot veil: indiquer "Chargement…" pendant l'attente du cloud
    const bootMark = document.querySelector('.boot__mark');
    if (bootMark) {
      bootMark.innerHTML = '<span style="font-size:11px; letter-spacing:.05em">CLOUD…</span>';
    }
    let cloudOk = false;
    // ÉTAPE 1 : vérification RAPIDE (manifest seul) — le cloud a-t-il des données ?
    // On décide de semer ou non SANS attendre les 15 Mo d'images (sinon le seed
    // se chargeait sur timeout, puis le cloud fusionnait → doublons).
    let remoteCount = null;
    try { remoteCount = await cloudProfileCount(); } catch {}

    if (remoteCount && remoteCount > 0) {
      // Le cloud a des profils → on télécharge tout (images incluses), SANS
      // timeout qui déclencherait le seed. On attend la fin réelle du pull.
      try {
        const r = await setupCloudAutoPull();
        if (r?.autoPulled) {
          profiles = await getAllProfiles();
          cloudOk = profiles.length > 0;
          console.log(`[Boot] Cloud chargé : ${r.profiles} profils + ${r.images} images`);
        }
      } catch (e) {
        console.warn('[Boot] Cloud pull au démarrage échoué:', e.message);
      }
      // Filet : même si le pull a partiellement échoué, on NE sème PAS quand le
      // cloud est connu non-vide (éviter les doublons seed+cloud à tout prix).
      if (!cloudOk) {
        await setMeta('seeded', true); // empêcher tout seed ultérieur
        console.warn('[Boot] Cloud non-vide mais pull incomplet — seed bloqué pour éviter les doublons.');
      }
    }
    // ÉTAPE 2 : cloud vide OU injoignable → seed de démarrage (une seule fois)
    if (!cloudOk && !profiles.length && remoteCount === 0 && !(await getMeta('seeded'))) {
      const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const seeded = SEED_PROFILES.map(p => ({
        id: uid(),
        name: p.name,
        professions: p.professions || (p.profession ? [p.profession] : []),
        instagram: p.instagram,
        phone: '',
        email: '',
        website: '',
        location: '',
        rate: '',
        lastContact: '',
        bio: '',
        tags: [],
        notes: '',
        status: 'a_contacter',
        createdAt: past,
        updatedAt: past,
      }));
      await bulkSaveProfiles(seeded);
      await setMeta('seeded', true);
      profiles = await getAllProfiles();
    }
  }
  // Migration: profession (string) → professions (array)
  // On migre si professions est absent OU vide ET qu'on a profession à récupérer
  // (sinon edge case : professions=[] + profession="X" → on perdait "X")
  const needsMigration = profiles.some(p => p.profession && (!p.professions || p.professions.length === 0));
  if (needsMigration) {
    for (const p of profiles) {
      if (p.profession && (!p.professions || p.professions.length === 0)) {
        p.professions = [p.profession];
        delete p.profession;
        await saveProfile(p);
      } else if (p.profession !== undefined) {
        // Cas mixte : profession + professions tous deux présents → garder professions, nettoyer
        delete p.profession;
        await saveProfile(p);
      }
    }
  }
  STATE.profiles = profiles;

  // Application de l'enrichissement (data/enrichment.json) si nouvelle version
  try {
    const enrichResult = await applyEnrichmentIfNew();
    if (enrichResult.applied && enrichResult.updated > 0) {
      // Recharger les profils
      STATE.profiles = await getAllProfiles();
      console.log(`Enrichment v${enrichResult.version} appliqué : ${enrichResult.updated} profils enrichis.`);
      setTimeout(() => {
        toast(`✨ ${enrichResult.updated} profils enrichis automatiquement (sites, e-mails, bios trouvés en ligne).`, {
          type: 'ok', timeout: 6000,
        });
      }, 1000);
    }
  } catch (e) {
    console.warn('Enrichment skipped:', e.message);
  }

  // Nettoyage one-shot des images orphelines (profileId qui n'existe plus
  // dans la table profiles) — répare les corruptions de chunks anciennes.
  cleanupOrphanImages().catch(() => {});

  // Précharge les premières images de chaque profil pour les vignettes,
  // en parallèle par batches de 25 (évite la latence séquentielle IDB
  // qui plombe le boot quand il y a 50+ profils).
  for (let i = 0; i < STATE.profiles.length; i += 25) {
    const batch = STATE.profiles.slice(i, i + 25);
    await Promise.all(batch.map(p =>
      getProfileImages(p.id).then(imgs => {
        if (imgs.length) STATE.imagesByProfile.set(p.id, imgs);
      })
    ));
  }

  buildFilterChips();
  buildStatusFilters();
  buildProfessionDatalist();
  buildSortSelect();
  hookUI();
  applyView();

  render();

  // remove boot veil (setTimeout fallback for unreliable rAF environments)
  setTimeout(() => document.body.classList.add('is-ready'), 50);

  // Sync init (en arrière-plan, ne bloque pas l'UI)
  setupSyncListeners();
  setupCloudListeners();

  // Lien magique CLOUD : ?cloud=xxx → configure le token cloud auto
  consumeCloudActivateParam().then(async (r) => {
    if (r?.activated) {
      toast('✓ Cloud public activé : vous pouvez désormais sauvegarder vos modifications depuis cet appareil.', { type: 'ok', timeout: 6000 });
      updateSyncPill();
      updateSaveButton();
    }
  });

  // Cloud public : auto-pull au démarrage si manifest existe en ligne
  // (PRIORITÉ #1 — pas de configuration nécessaire sur les nouveaux appareils)
  doCloudPullAndRefresh({ silent: false, source: 'boot' }).catch((e) => console.warn('[Boot] Cloud auto-pull skipped:', e.message));

  // Helper : ne JAMAIS pull si un dialog d'édition/profile est ouvert (le pull
  // overwrite STATE.profiles → les modifs en cours seraient perdues).
  function canPullSafely() {
    if (dirtyState) return false;
    const editDlg = $('#edit-dialog');
    const profileDlg = $('#profile-dialog');
    if (editDlg?.open || profileDlg?.open) return false;
    return true;
  }

  // Polling toutes les 60s : si quelqu'un push depuis un autre appareil, on récupère
  setInterval(() => {
    if (document.hidden) return; // ne pas poll si tab inactive
    if (!canPullSafely()) return;
    doCloudPullAndRefresh({ silent: false, source: 'poll' }).catch(() => {});
  }, 60_000);

  // Pull forcé quand la tab redevient visible (mobile : très important — l'app
  // peut rester en arrière-plan plusieurs minutes sans polling).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!canPullSafely()) return;
    // Throttle : pas plus d'un pull toutes les 5 secondes
    const now = Date.now();
    if (window.__lastVisibilityPull && now - window.__lastVisibilityPull < 5000) return;
    window.__lastVisibilityPull = now;
    doCloudPullAndRefresh({ silent: true, source: 'visibility' }).catch(() => {});
  });

  // Pull au focus de la fenêtre (desktop : alt-tab, etc.)
  window.addEventListener('focus', () => {
    if (!canPullSafely()) return;
    const now = Date.now();
    if (window.__lastFocusPull && now - window.__lastFocusPull < 5000) return;
    window.__lastFocusPull = now;
    doCloudPullAndRefresh({ silent: true, source: 'focus' }).catch(() => {});
  });

  // Si l'URL contient ?activate=xxx, auto-config sync (lien magique)
  consumeActivateParam().then(async (r) => {
    if (r?.activated && r.pulled) {
      STATE.profiles = await getAllProfiles();
      STATE.imagesByProfile.clear();
      for (const p of STATE.profiles) {
        const imgs = await getProfileImages(p.id);
        if (imgs.length) STATE.imagesByProfile.set(p.id, imgs);
      }
      buildFilterChips();
      buildProfessionDatalist();
      render();
      window.__updateIgBulkCount?.();
      updateSyncPill();
      updateSaveButton();
      toast(`✓ Sync activée automatiquement : ${r.pulled.profiles} profils + ${r.pulled.images} images chargés.`, { type: 'ok', timeout: 7000 });
    } else if (r?.activated === false) {
      toast('Lien d\'invitation invalide : ' + (r.error || 'erreur'), { type: 'err', timeout: 5000 });
    }
  });

  setupAutoSync().then(async (ready) => {
    updateSyncPill();
    updateSaveButton();
  }).catch(() => {});
  // PWA — enregistre le SW et reload auto quand une nouvelle version active
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // Quand le SW actif change (nouveau deployé), force un reload pour récupérer
    // les nouveaux CSS/JS. Évite que l'user reste sur l'ancien code après deploy.
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      // Petit délai pour laisser les modifs en cours se terminer
      setTimeout(() => window.location.reload(), 500);
    });
  }

  // (L'ancien banner d'onboarding QR est remplacé par la porte mot de passe.)
})();

async function maybeShowOnboardingBanner() {
  try {
    const cloudCfg = await getCloudConfig();
    if (cloudCfg.token) return; // déjà configuré
    const dismissed = await getMeta('onboarding_dismissed_at');
    if (dismissed && Date.now() - dismissed < 24 * 3600 * 1000) return; // pas plus d'1x/jour
    if (STATE.profiles.length === 0) return; // app vide, rien à protéger
    showOnboardingBanner();
  } catch {}
}

function showOnboardingBanner() {
  if (document.getElementById('onboarding-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'onboarding-banner';
  banner.className = 'onboarding';
  banner.innerHTML = `
    <div class="onboarding__inner">
      <div class="onboarding__icon">📱</div>
      <div class="onboarding__body">
        <div class="onboarding__title">Activer la sauvegarde sur cet appareil</div>
        <div class="onboarding__text">Tu lis les profils en temps réel mais tu ne peux pas encore enregistrer tes modifs ici. Sur un appareil déjà configuré, ouvre <strong>Réglages → QR</strong>, scanne-le → cet appareil pourra modifier en 2 sec.</div>
      </div>
      <div class="onboarding__actions">
        <button type="button" class="btn btn--primary" id="onboarding-open">Comment faire ?</button>
        <button type="button" class="btn btn--ghost" id="onboarding-dismiss" aria-label="Masquer">×</button>
      </div>
    </div>`;
  document.body.appendChild(banner);
  document.getElementById('onboarding-open').addEventListener('click', () => {
    openOnboardingHelp();
  });
  document.getElementById('onboarding-dismiss').addEventListener('click', async () => {
    banner.classList.add('onboarding--out');
    setTimeout(() => banner.remove(), 250);
    await setMeta('onboarding_dismissed_at', Date.now());
  });
  requestAnimationFrame(() => banner.classList.add('onboarding--in'));
}

function openOnboardingHelp() {
  const dlgId = 'onboarding-help-dialog';
  let dlg = document.getElementById(dlgId);
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = dlgId;
    dlg.className = 'dialog';
    dlg.innerHTML = `
      <div class="dialog__inner" style="max-width: 460px;">
        <header class="dialog__head">
          <h2>Activer cet appareil en 2 sec</h2>
          <button type="button" class="iconbtn" data-close aria-label="Fermer">×</button>
        </header>
        <div class="dialog__body" style="padding: 8px 4px;">
          <ol style="line-height: 1.6; padding-left: 22px; margin: 0;">
            <li>Sur un appareil <strong>déjà configuré</strong> (où tu peux sauvegarder), ouvre le menu <strong>⋯ → Réglages</strong>.</li>
            <li>Va dans <strong>☁︎ Cloud public auto</strong> → clic sur <strong>📱 QR + lien</strong>.</li>
            <li>Pointe l'appareil de cette page vers le QR ; clique sur le lien qui s'affiche → cloud activé instantanément.</li>
          </ol>
          <p style="margin: 14px 0 0; font-size: 13px; color: var(--text-muted);">Astuce : pas d'autre appareil configuré ? <a href="#" id="onboarding-config-here">Configure le cloud directement ici</a> (un PAT GitHub sera demandé une seule fois).</p>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
    dlg.querySelector('#onboarding-config-here').addEventListener('click', (e) => {
      e.preventDefault();
      dlg.close();
      openSettingsDialog();
      setTimeout(() => {
        const cloudInput = $('#cloud-token-input');
        cloudInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        cloudInput?.focus();
      }, 300);
    });
  }
  dlg.showModal();
}

// ============= CLOUD PULL HELPER =============

let __cloudPullInFlight = false;

/**
 * Tente un pull cloud + recharge l'état local + redessine si quelque chose a changé.
 * @param {Object} opts
 * @param {boolean} opts.silent - true = pas de toast (sauf changement détecté).
 * @param {boolean} opts.force - true = force le pull même si déjà fait récemment.
 * @param {string} opts.source - 'boot' | 'poll' | 'visibility' | 'focus' | 'manual'.
 */
async function doCloudPullAndRefresh({ silent = false, force = false, source = 'manual' } = {}) {
  if (__cloudPullInFlight && !force) return { skipped: true, reason: 'in-flight' };
  __cloudPullInFlight = true;
  try {
    const r = await setupCloudAutoPull();
    // CONVERGENCE : si le merge a détecté du contenu local plus récent ou
    // absent du cloud (profil ajouté ici, modif locale plus fraîche), on
    // re-pousse automatiquement pour que les AUTRES appareils le voient.
    if (r && ((r.localNewer || 0) > 0 || (r.localOnly || 0) > 0)) {
      const cfg = await getCloudConfig();
      if (cfg.token) {
        console.log(`[Sync] Push-back requis (localNewer=${r.localNewer}, localOnly=${r.localOnly})`);
        scheduleCloudPush(1500);
      }
    }
    if (r?.autoPulled && r.profiles > 0) {
      STATE.profiles = await getAllProfiles();
      STATE.imagesByProfile.clear();
      for (const p of STATE.profiles) {
        const imgs = await getProfileImages(p.id);
        if (imgs.length) STATE.imagesByProfile.set(p.id, imgs);
      }
      buildFilterChips();
      buildProfessionDatalist();
      render();
      window.__updateIgBulkCount?.();
      updateSyncPill();
      updateSaveButton();
      window.__lastCloudPullAt = Date.now();
      updateRefreshIndicator();
      const prefix = source === 'boot' ? '✓ Cloud' : '↻ Cloud mis à jour';
      // Si on a hit le quota IDB (Safari Privée), prévenir l'user que c'est session-only
      if (window.__idbQuotaHit) {
        toast(`${prefix} : ${r.profiles} profils + ${r.images} images (mode navigation privée — photos visibles cette session uniquement).`, { type: 'info', timeout: 7000 });
      } else {
        toast(`${prefix} : ${r.profiles} profils + ${r.images} images.`, { type: 'ok', timeout: 4000 });
      }
      return r;
    }
    // Pas de changement détecté : juste mettre à jour le timestamp
    window.__lastCloudPullAt = Date.now();
    updateRefreshIndicator();
    if (!silent && source === 'manual') {
      toast('Cloud à jour — rien à rafraîchir.', { type: 'info', timeout: 2500 });
    }
    return r || { skipped: true };
  } finally {
    __cloudPullInFlight = false;
  }
}

// Met à jour l'indicateur "vu il y a Xs" sur le bouton refresh
function updateRefreshIndicator() {
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;
  const last = window.__lastCloudPullAt;
  if (!last) {
    btn.title = 'Rafraîchir depuis le cloud';
    btn.removeAttribute('data-fresh-ago');
    return;
  }
  const sec = Math.round((Date.now() - last) / 1000);
  let label;
  if (sec < 5) label = 'à l\'instant';
  else if (sec < 60) label = `il y a ${sec}s`;
  else if (sec < 3600) label = `il y a ${Math.round(sec / 60)} min`;
  else label = `il y a ${Math.round(sec / 3600)} h`;
  btn.title = `Rafraîchir depuis le cloud (vu ${label})`;
  btn.dataset.freshAgo = label;
}
// Rafraîchir l'indicateur toutes les 30s
setInterval(updateRefreshIndicator, 30_000);

// ============= BUILD UI ELEMENTS =============

function buildFilterChips() {
  const el = $('#profession-chips');
  el.innerHTML = '';

  const counts = professionCounts();
  const all = document.createElement('button');
  const allActive = STATE.filters.profession === 'all';
  all.className = 'chip' + (allActive ? ' is-active' : '');
  all.dataset.profession = 'all';
  all.setAttribute('role', 'tab');
  all.setAttribute('aria-selected', allActive ? 'true' : 'false');
  if (allActive) all.setAttribute('aria-current', 'true');
  all.innerHTML = `Tous <span class="chip__count">${STATE.profiles.length}</span>`;
  el.appendChild(all);

  // tri par effectif décroissant pour les pros existantes
  const presentPros = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  for (const pro of presentPros) {
    const c = document.createElement('button');
    const active = STATE.filters.profession === pro;
    c.className = 'chip' + (active ? ' is-active' : '');
    c.dataset.profession = pro;
    c.setAttribute('role', 'tab');
    c.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) c.setAttribute('aria-current', 'true');
    c.innerHTML = `${pro} <span class="chip__count">${counts[pro]}</span>`;
    el.appendChild(c);
  }

  el.addEventListener('click', onFilterChipClick, { once: true });
}

function onFilterChipClick(e) {
  const btn = e.target.closest('.chip');
  if (!btn) return rebindFilterChips();
  STATE.filters.profession = btn.dataset.profession;
  setMeta('profession', STATE.filters.profession);
  buildFilterChips();
  render();
}
function rebindFilterChips() { $('#profession-chips').addEventListener('click', onFilterChipClick, { once: true }); }

function buildStatusFilters() {
  const el = $('#status-filters');
  el.innerHTML = '';
  for (const s of STATUSES) {
    const b = document.createElement('button');
    const active = STATE.filters.status === s.id;
    b.className = 'status-pill' + (active ? ' is-active' : '');
    b.style.setProperty('--c', s.color);
    b.dataset.status = s.id;
    b.textContent = s.label;
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    b.setAttribute('aria-label', `Filtrer par statut : ${s.label}`);
    el.appendChild(b);
  }
  el.onclick = (e) => {
    const btn = e.target.closest('.status-pill');
    if (!btn) return;
    STATE.filters.status = STATE.filters.status === btn.dataset.status ? '' : btn.dataset.status;
    buildStatusFilters();
    render();
  };
}

function buildProfessionDatalist() {
  const dl = $('#profession-list');
  dl.innerHTML = '';
  const set = new Set(PROFESSIONS);
  STATE.profiles.forEach(p => profileProfessions(p).forEach(pr => set.add(pr)));
  for (const p of [...set].sort()) {
    const opt = document.createElement('option');
    opt.value = p;
    dl.appendChild(opt);
  }
  // remplir le select status du form
  const ss = document.querySelector('#edit-form select[name="status"]');
  if (ss && !ss.options.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '— Aucun —';
    ss.appendChild(empty);
    for (const s of STATUSES) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.label;
      ss.appendChild(o);
    }
  }
}

function allKnownProfessions() {
  const set = new Set(PROFESSIONS);
  STATE.profiles.forEach(p => profileProfessions(p).forEach(pr => set.add(pr)));
  return [...set].sort();
}

function buildSortSelect() {
  const sel = $('#sort-select');
  sel.value = STATE.filters.sort;
  sel.addEventListener('change', () => {
    STATE.filters.sort = sel.value;
    setMeta('sort', sel.value);
    render();
  });
}

// Memoized : invalidé si la longueur ou un updatedAt récent change.
let _profCountCache = null, _profCountKey = null;
function professionCounts() {
  // Clé de cache : longueur + concat des updatedAt (cheap signature)
  const key = STATE.profiles.length + ':' + (STATE.profiles[STATE.profiles.length - 1]?.updatedAt || '');
  if (_profCountKey === key && _profCountCache) return _profCountCache;
  const c = {};
  for (const p of STATE.profiles) {
    for (const pro of (p.professions || [])) {
      c[pro] = (c[pro] || 0) + 1;
    }
  }
  _profCountCache = c;
  _profCountKey = key;
  return c;
}
// À appeler si on modifie un profil (force recompte)
function invalidateProfessionCountsCache() { _profCountCache = null; _profCountKey = null; }

function profileProfessions(p) {
  return p.professions || (p.profession ? [p.profession] : []);
}

// ============= UI HOOKS =============

function hookUI() {
  // search input
  const input = $('#search-input');
  const clear = $('#search-clear');
  const onQuery = debounce(() => {
    STATE.filters.query = input.value.trim();
    clear.hidden = !STATE.filters.query;
    render();
  }, 220);
  input.addEventListener('input', onQuery);
  clear.addEventListener('click', () => { input.value = ''; STATE.filters.query = ''; clear.hidden = true; render(); input.focus(); });

  // theme toggle
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
    document.body.dataset.theme = next;
    setMeta('theme', next);
  });

  // brand back to top + reset filters
  $('#brand-btn').addEventListener('click', () => {
    if (STATE.filters.profession !== 'all' || STATE.filters.status || STATE.filters.query) {
      STATE.filters = { ...STATE.filters, profession: 'all', status: '', query: '' };
      input.value = '';
      clear.hidden = true;
      buildFilterChips();
      buildStatusFilters();
      render();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // view toggle
  $$('.viewtoggle__btn').forEach(b => {
    b.addEventListener('click', () => {
      STATE.view = b.dataset.view;
      setMeta('view', STATE.view);
      applyView();
      render();
    });
  });

  // add buttons (le empty-add est rebindé selon le contexte dans render())
  $('#add-btn').addEventListener('click', () => openEditDialog());

  // menu
  const menuBtn = $('#menu-toggle');
  const menu = $('#menu');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && !menuBtn.contains(e.target)) closeMenu();
  });
  menu.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (!a) return;
    closeMenu();
    if (a === 'export') return doExport();
    if (a === 'export-csv') return doExportCsv();
    if (a === 'import') return triggerImport();
    if (a === 'bulk-import') return openBulkDialog();
    if (a === 'bulk-ig-photos') return bulkImportInstagramPhotos();
    if (a === 'bulk-ig-fast') return bulkImportProfilePicsOnly();
    if (a === 'copy-emails') return copyEmailsOfFiltered();
    if (a === 'copy-handles') return copyHandlesOfFiltered();
    if (a === 'seed') return doReSeed();
    if (a === 'reapply-enrichment') return reapplyEnrichment();
    if (a === 'diagnose-sync') return doDiagnoseSync();
    if (a === 'backup-local') return doBackupLocal();
    if (a === 'toggle-theme') return $('#theme-toggle').click();
    if (a === 'settings') return openSettingsDialog();
    if (a === 'shortcuts') return openDialog('shortcuts-dialog');
    if (a === 'reset') return doReset();
  });

  // edit form
  hookEditForm();

  // bulk dialog
  hookBulkDialog();

  // close-on-data-close for any dialog
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-close]');
    if (!t) return;
    const dlg = t.closest('dialog');
    dlg?.close();
  });

  // Click sur backdrop (hors .dialog__inner) → ferme le dialog
  document.addEventListener('click', (e) => {
    const dlg = e.target.closest('dialog[open]');
    if (!dlg) return;
    // Si on clique sur le dialog lui-même (pas sur un de ses enfants),
    // c'est qu'on a cliqué sur le backdrop ou hors du contenu .dialog__inner.
    if (e.target === dlg) {
      dlg.close();
    }
  });

  // grid card click delegation (avec quick actions)
  $('#grid').addEventListener('click', (e) => {
    const quick = e.target.closest('[data-quick]');
    const tagEl = e.target.closest('.tag:not(.tag--more)');
    const card = e.target.closest('.card, .row');
    if (!card) return;
    if (quick) {
      e.stopPropagation();
      handleQuickAction(card.dataset.id, quick.dataset.quick);
      return;
    }
    if (tagEl && tagEl.dataset.tag) {
      e.stopPropagation();
      setTagFilter(tagEl.dataset.tag);
      return;
    }
    openProfileDialog(card.dataset.id);
  });

  // tag bar
  $('#tag-bar-clear').addEventListener('click', () => { STATE.filters.tag = ''; render(); });
  $('#tag-bar-active').addEventListener('click', () => { STATE.filters.tag = ''; render(); });
  $('#grid').addEventListener('keydown', (e) => {
    const card = e.target.closest('.card, .row');
    if (!card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openProfileDialog(card.dataset.id);
      return;
    }
    // Navigation au clavier dans la grille (Tab fonctionne déjà mais c'est lent)
    if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const cards = Array.from(document.querySelectorAll('#grid .card, #grid .row'));
      const idx = cards.indexOf(card);
      if (idx === -1) return;
      // Calcule le nombre de colonnes en regardant la position X
      const cardRect = card.getBoundingClientRect();
      const firstRowCount = cards.filter(c => Math.abs(c.getBoundingClientRect().top - cards[0].getBoundingClientRect().top) < 5).length;
      const cols = Math.max(1, firstRowCount);
      let next = idx;
      if (e.key === 'ArrowRight') next = Math.min(idx + 1, cards.length - 1);
      else if (e.key === 'ArrowLeft') next = Math.max(idx - 1, 0);
      else if (e.key === 'ArrowDown') next = Math.min(idx + cols, cards.length - 1);
      else if (e.key === 'ArrowUp') next = Math.max(idx - cols, 0);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = cards.length - 1;
      cards[next]?.focus();
    }
  });
  // context menu (right-click)
  $('#grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card, .row');
    if (!card) return;
    e.preventDefault();
    showContextMenu(card.dataset.id, e.clientX, e.clientY);
  });

  // stats clear button
  $('#stat-clear').addEventListener('click', resetFilters);

  // paste images globally (when not typing in a non-image field)
  document.addEventListener('paste', onPaste);

  // Drop d'images globales : si profile-dialog ouvert → ajoute au profil courant.
  // Sinon, prévient l'user qu'il faut ouvrir un profil ou créer un nouveau.
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      document.body.classList.add('is-drag-global');
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (e.target === document.documentElement || !e.relatedTarget) {
      document.body.classList.remove('is-drag-global');
    }
  });
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    document.body.classList.remove('is-drag-global');
    // Si le drop arrive dans le edit-dialog dropzone, laisser le handler local gérer
    if (e.target.closest('#dropzone')) return;
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    if (STATE.current && $('#profile-dialog').open) {
      // Ajoute au profil ouvert
      await addImagesToProfile(STATE.current, files);
      const imgs = await getProfileImages(STATE.current.id);
      STATE.imagesByProfile.set(STATE.current.id, imgs);
      openProfileDialog(STATE.current.id);
      render();
      toast(`✓ ${files.length} image${files.length > 1 ? 's' : ''} ajoutée${files.length > 1 ? 's' : ''} au profil.`, { type: 'ok' });
    } else {
      toast(`Glissez les images directement sur un profil ouvert, ou utilisez le formulaire d'ajout.`, { type: 'info', timeout: 4500 });
    }
  });

  // bouton "Sauvegarder" — cycle complet pull→merge→push
  $('#save-btn').addEventListener('click', async () => {
    const cloudCfg = await getCloudConfig();
    const syncCfg = await getSyncConfig();

    // Cas 1 : appareil déverrouillé → sync complète (intègre les modifs des
    // autres appareils PUIS pousse les nôtres — zéro écrasement croisé)
    if (cloudCfg.token) {
      try {
        const r = await syncCloud({ reason: 'save-button' });
        if (r.pushed && r.push) {
          toast(`✓ Synchronisé : ${r.push.profiles} profils + ${r.push.images} images (${r.push.chunksPushed ?? r.push.chunks} fichier(s) envoyés). Visible sur tous les appareils.`, { type: 'ok', timeout: 5000 });
        } else if (r.skipped) {
          toast('Synchronisation déjà en cours…', { type: 'info', timeout: 2500 });
        } else {
          toast('✓ Tout est déjà synchronisé.', { type: 'ok', timeout: 3000 });
        }
        // Recharger l'affichage (le pull a pu ramener des modifs distantes)
        STATE.profiles = await getAllProfiles();
        render();
      } catch (e) {
        if (e.code === 'QUOTA' || /Quota GitHub/.test(e.message)) {
          const wait = e.waitSec || 60;
          const min = Math.max(1, Math.round(wait / 60));
          toast(`⏳ Sauvegarde différée — quota GitHub atteint, réessai auto dans ${min}min.`, {
            type: 'info', timeout: 6000,
          });
          scheduleCloudPush(wait * 1000 + 2000);
        } else {
          toast('Sync échouée : ' + e.message, { type: 'err', timeout: 6000 });
        }
      }
      return;
    }

    // Cas 2 : Gist configuré (legacy)
    if (syncCfg.token) {
      try {
        const r = await syncPushNow();
        const imgMsg = r.images ? ` + ${r.images} images (${r.chunks} fichiers)` : '';
        toast(`✓ Sauvegarde Gist : ${r.profiles} profils${imgMsg} (${r.sizeKb} Ko).`, { type: 'ok', timeout: 4500 });
      } catch (e) {
        // Quota atteint : non-bloquant, l'auto-retry s'en occupera
        if (e.code === 'QUOTA' || /Quota GitHub/.test(e.message)) {
          const wait = e.waitSec || 60;
          const min = Math.max(1, Math.round(wait / 60));
          toast(`⏳ Sauvegarde différée — quota Gist atteint, réessai auto dans ${min}min. Astuce : configurez le Cloud public (Réglages) pour éviter ce souci.`, {
            type: 'info', timeout: 7000,
          });
          schedulePush(wait * 1000 + 2000);
        } else {
          toast('Sauvegarde Gist échouée : ' + e.message, { type: 'err', timeout: 6000 });
        }
      }
      return;
    }

    // Cas 3 : appareil verrouillé → re-proposer le mot de passe
    ensureAuthGate({
      onUnlocked: () => {
        updateSyncPill();
        updateSaveButton();
        syncCloud({ reason: 'unlock-from-save' }).catch(() => {});
      },
    }).catch(() => {});
  });

  // bouton "↻ Rafraîchir" — pull manuel depuis le cloud
  $('#refresh-btn')?.addEventListener('click', async () => {
    const btn = $('#refresh-btn');
    btn.classList.add('is-spinning');
    try {
      await doCloudPullAndRefresh({ silent: false, force: true, source: 'manual' });
    } catch (e) {
      toast('Pull cloud échoué : ' + e.message, { type: 'err', timeout: 5000 });
    } finally {
      btn.classList.remove('is-spinning');
    }
  });

  // bouton "Scanner photos IG" en évidence — mode rapide par défaut (Dumpor, sans rate-limit)
  const igBulkBtn = $('#ig-bulk-btn');
  igBulkBtn.addEventListener('click', () => bulkImportProfilePicsOnly());
  // Mettre à jour le badge avec le nombre de profils sans images
  const updateIgBulkCount = () => {
    const without = STATE.profiles.filter(p => p.instagram && !STATE.imagesByProfile.get(p.id)?.length).length;
    const countEl = $('#ig-bulk-count');
    if (countEl) countEl.textContent = without > 0 ? String(without) : '';
    igBulkBtn.disabled = without === 0;
    igBulkBtn.title = without === 0
      ? 'Tous les profils Instagram ont des images.'
      : `${without} profil${without > 1 ? 's' : ''} Instagram sans image — clic pour scanner`;
  };
  // exposer pour appel après sync/import
  window.__updateIgBulkCount = updateIgBulkCount;
  setInterval(updateIgBulkCount, 2000);
  setTimeout(updateIgBulkCount, 500);

  // raccourci clavier ⌘S / Ctrl+S
  // Si edit-dialog ouvert : sauvegarde le profil édité (form submit).
  // Sinon : push cloud (save-btn topbar).
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      const editDlg = $('#edit-dialog');
      if (editDlg?.open) {
        $('#edit-save')?.click();
      } else {
        $('#save-btn')?.click();
      }
    }
  });

  // back-to-top
  const totop = $('#totop');
  totop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  let totopShown = false;
  window.addEventListener('scroll', () => {
    const should = window.scrollY > 400;
    if (should !== totopShown) {
      totopShown = should;
      if (should) {
        totop.hidden = false;
        setTimeout(() => totop.classList.add('is-show'), 16);
      } else {
        totop.classList.remove('is-show');
        setTimeout(() => { if (!totopShown) totop.hidden = true; }, 250);
      }
    }
  }, { passive: true });

  // raccourcis clavier globaux
  document.addEventListener('keydown', onKeydown);
}

function applyView() {
  $('#grid').dataset.view = STATE.view;
  $$('.viewtoggle__btn').forEach(b => b.classList.toggle('is-active', b.dataset.view === STATE.view));
}

function toggleMenu() {
  const m = $('#menu');
  const open = m.classList.contains('is-open');
  if (open) return closeMenu();
  m.hidden = false;
  // position relative au bouton
  const r = $('#menu-toggle').getBoundingClientRect();
  m.style.top = (r.bottom + 6) + 'px';
  m.style.right = (window.innerWidth - r.right) + 'px';
  m.style.left = 'auto';
  setTimeout(() => m.classList.add('is-open'), 16);
  $('#menu-toggle').setAttribute('aria-expanded', 'true');
  // usage
  estimateUsage().then(({ usage, quota }) => {
    if (quota) {
      $('#menu-usage').textContent = `Stockage : ${fmtBytes(usage)} / ${fmtBytes(quota)}`;
    } else {
      $('#menu-usage').textContent = '';
    }
  });
}
function closeMenu() {
  const m = $('#menu');
  if (!m.classList.contains('is-open')) return;
  m.classList.remove('is-open');
  $('#menu-toggle').setAttribute('aria-expanded', 'false');
  setTimeout(() => { m.hidden = true; }, 180);
}

// ============= RENDU =============

function applyFilters() {
  const { query, profession, status, sort } = STATE.filters;
  const q = query.toLowerCase();
  let list = STATE.profiles;

  if (profession !== 'all') list = list.filter(p => profileProfessions(p).includes(profession));
  if (status) list = list.filter(p => p.status === status);
  if (STATE.filters.tag) {
    const t = STATE.filters.tag.toLowerCase();
    list = list.filter(p => (p.tags || []).some(x => x.toLowerCase() === t));
  }
  if (q) {
    list = list.filter(p => {
      const blob = [
        p.name, ...(profileProfessions(p)), p.instagram, p.email, p.phone,
        p.location, p.website, p.bio, p.notes, ...(p.tags || []),
      ].filter(Boolean).join(' ');
      return fuzzyMatch(q, blob);
    });
  }

  const STATUS_RANK = { favori: 0, en_cours: 1, collabore: 2, a_contacter: 3, '': 4 };
  // Collator FR optimisé : usage:'sort' pour ordre déterministe, caseFirst:'lower'
  // pour stabilité, ignorePunctuation pour ignorer les tirets/apostrophes parasites.
  const FR_COLLATOR = new Intl.Collator('fr', {
    usage: 'sort',
    sensitivity: 'base',
    caseFirst: 'lower',
    ignorePunctuation: true,
    numeric: true, // "Profil 2" avant "Profil 10"
  });
  const byName = (a, b) => FR_COLLATOR.compare(a.name || '', b.name || '');
  const cmp = {
    name: byName,
    favoris: (a, b) => {
      const ra = a.status === 'favori' ? 0 : 1;
      const rb = b.status === 'favori' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return byName(a, b);
    },
    recent: (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
    created: (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
    profession: (a, b) => FR_COLLATOR.compare(profileProfessions(a)[0] || '', profileProfessions(b)[0] || '') || byName(a, b),
    status: (a, b) => (STATUS_RANK[a.status ?? ''] ?? 4) - (STATUS_RANK[b.status ?? ''] ?? 4) || byName(a, b),
  };
  list = [...list].sort(cmp[sort] || cmp.name);
  STATE.filtered = list;
  return list;
}

function render() {
  try { return _renderImpl(); }
  catch (e) {
    console.error('[render] crash:', e);
    try {
      toast('Erreur d\'affichage : ' + (e?.message || 'inconnue') + '. Rechargez la page.', { type: 'err', timeout: 6000 });
    } catch {}
  }
}

function _renderImpl() {
  const list = applyFilters();
  const grid = $('#grid');
  const empty = $('#empty');
  $('#brand-count').textContent = STATE.profiles.length;

  renderStats(list);
  renderTagBar();

  // empty state
  if (!list.length) {
    grid.innerHTML = '';
    empty.hidden = false;
    const filtersActive = STATE.filters.profession !== 'all' || STATE.filters.status || STATE.filters.query || STATE.filters.tag;
    if (!STATE.profiles.length) {
      $('#empty-title').textContent = 'Aucun profil';
      $('#empty-text').textContent = 'Commencez en ajoutant un nouveau profil ou en important une liste Instagram.';
      $('#empty-add').textContent = '+ Ajouter un profil';
      $('#empty-add').onclick = () => openEditDialog();
    } else if (filtersActive) {
      $('#empty-title').textContent = 'Aucun résultat';
      $('#empty-text').textContent = 'Aucun profil ne correspond à vos filtres actuels.';
      $('#empty-add').textContent = 'Réinitialiser les filtres';
      $('#empty-add').onclick = () => resetFilters();
    } else {
      $('#empty-title').textContent = 'Aucun profil';
      $('#empty-text').textContent = 'Commencez en ajoutant un nouveau profil.';
      $('#empty-add').textContent = '+ Ajouter un profil';
      $('#empty-add').onclick = () => openEditDialog();
    }
    return;
  }
  empty.hidden = true;

  // diff render: rebuild la grille (ok jusqu'à plusieurs milliers)
  // On animate uniquement le PREMIER render (au boot). Sinon, chaque filtre/tri
  // déclenche l'anim ce qui est jankant et désorientant.
  const animate = !STATE._firstRenderDone;
  const frag = document.createDocumentFragment();
  list.forEach((p, i) => {
    const imgs = STATE.imagesByProfile.get(p.id);
    const first = imgs?.[0];
    const node = STATE.view === 'list'
      ? renderRow(p, { firstImage: first, query: STATE.filters.query, index: i })
      : renderCard(p, { firstImage: first, query: STATE.filters.query, index: i });
    if (!animate) node.classList.add('no-anim');
    frag.appendChild(node);
  });
  grid.replaceChildren(frag);
  STATE._firstRenderDone = true;
}

// ============= PROFIL : OUVRIR / NAV / EDIT =============

async function openProfileDialog(id) {
  const profile = STATE.profiles.find(p => p.id === id);
  if (!profile) return;
  STATE.current = profile;
  const dlg = $('#profile-dialog');
  const inner = $('#profile-inner');

  const images = await getProfileImages(profile.id);
  STATE.imagesByProfile.set(profile.id, images);

  renderProfileDetail(inner, profile, images, {
    onClose: () => dlg.close(),
    onEdit: () => { dlg.close(); openEditDialog(profile); },
    onDelete: () => { dlg.close(); confirmDelete(profile); },
    onPrev: () => navigateProfile(-1),
    onNext: () => navigateProfile(+1),
    onStatusChange: async (st) => {
      profile.status = st;
      await saveProfile(profile);
      maybeSchedulePush();
      render();
    },
    onNotesChange: async (notes) => {
      profile.notes = notes;
      await saveProfile(profile);
      maybeSchedulePush();
    },
    onProjectsChange: async (projects) => {
      profile.projects = projects;
      await saveProfile(profile);
      maybeSchedulePush();
    },
    onUploadImages: async (files) => {
      await addImagesToProfile(profile, files);
      const imgs = await getProfileImages(profile.id);
      STATE.imagesByProfile.set(profile.id, imgs);
      openProfileDialog(profile.id);
      render();
    },
    onFetchIg: async () => {
      await importInstagramForProfile(profile);
    },
    onAiScan: async () => {
      await aiScanProfile(profile);
    },
    onDeleteImage: async (key) => {
      await deleteImage(key);
      revokeObjectURL(key);
      const imgs = await getProfileImages(profile.id);
      STATE.imagesByProfile.set(profile.id, imgs);
      openProfileDialog(profile.id);
      render();
    },
  });

  if (!dlg.open) dlg.showModal();
}

function navigateProfile(direction) {
  if (!STATE.current) return;
  const list = STATE.filtered;
  if (!list.length) {
    // Plus aucun profil dans la liste filtrée → fermer le dialog
    const dlg = $('#profile-dialog');
    if (dlg?.open) dlg.close();
    STATE.current = null;
    return;
  }
  const idx = list.findIndex(p => p.id === STATE.current.id);
  if (idx === -1) {
    // Le profil courant n'existe plus dans la liste filtrée (supprimé ou
    // filtré) → on saute sur le voisin selon la direction
    const fallbackIdx = direction > 0 ? 0 : list.length - 1;
    openProfileDialog(list[fallbackIdx].id);
    return;
  }
  const nextIdx = (idx + direction + list.length) % list.length;
  openProfileDialog(list[nextIdx].id);
}

async function duplicateProfile(p) {
  const dup = {
    ...p,
    id: uid(),
    name: p.name + ' (copie)',
    instagram: '',
    createdAt: undefined,
    updatedAt: undefined,
  };
  await saveProfile(dup);
  STATE.profiles.push(dup);
  buildFilterChips();
  render();
  toast('Profil dupliqué — pensez à le renommer.', { type: 'ok' });
}

async function confirmDelete(profile) {
  const ok = await confirmDialog({
    title: 'Supprimer ce profil ?',
    text: `« ${profile.name || profile.instagram} » sera supprimé définitivement, ainsi que ses images.`,
    okLabel: 'Supprimer',
  });
  if (!ok) return;
  await deleteProfile(profile.id);
  STATE.profiles = STATE.profiles.filter(p => p.id !== profile.id);
  STATE.imagesByProfile.delete(profile.id);
  // Si le profil supprimé était ouvert dans la modal, fermer + reset STATE.current
  // pour éviter des actions sur un fantôme (save → recrée le profil supprimé !).
  if (STATE.current?.id === profile.id) {
    STATE.current = null;
    const dlg = $('#profile-dialog');
    if (dlg?.open) dlg.close();
    const editDlg = $('#edit-dialog');
    if (editDlg?.open) editDlg.close();
  }
  buildFilterChips();
  render();
  maybeSchedulePush();
  toast('Profil supprimé.', { type: 'ok' });
}

// ============= EDIT FORM =============

let pendingFiles = []; // images en attente avant save

function openEditDialog(profile = null) {
  const dlg = $('#edit-dialog');
  const form = $('#edit-form');
  form.reset();
  pendingFiles = [];
  $('#dropzone-list').replaceChildren();
  $('#dropzone-list').hidden = true;
  $('#edit-delete').hidden = !profile;
  $('#edit-title').textContent = profile ? 'Éditer le profil' : 'Nouveau profil';

  // Reset multi-chip professions
  setMultichipValues('profession-multichip', profile ? profileProfessions(profile) : []);
  if (profile) {
    form.elements.id.value = profile.id;
    form.elements.name.value = profile.name || '';
    form.elements.status.value = profile.status || '';
    form.elements.instagram.value = profile.instagram || '';
    form.elements.phone.value = profile.phone || '';
    form.elements.email.value = profile.email || '';
    form.elements.website.value = profile.website || '';
    form.elements.location.value = profile.location || '';
    form.elements.rate.value = profile.rate || '';
    if (form.elements.agency) form.elements.agency.value = profile.agency || '';
    form.elements.lastContact.value = profile.lastContact || '';
    form.elements.tags.value = (profile.tags || []).join(', ');
    form.elements.projects.value = profile.projects || '';
    form.elements.notes.value = profile.notes || '';
  }
  if (!dlg.open) dlg.showModal();
  setTimeout(() => form.elements.name.focus(), 50);
}

function hookEditForm() {
  const form = $('#edit-form');
  const dz = $('#dropzone');
  const fileInput = $('#file-input');
  const list = $('#dropzone-list');

  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }});

  fileInput.addEventListener('change', (e) => addFiles(Array.from(e.target.files || [])));

  ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('is-drag'); }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('is-drag'); }));
  dz.addEventListener('drop', e => {
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
    if (files.length) addFiles(files);
  });

  // auto-suggérer un nom depuis le handle Instagram s'il n'y en a pas
  form.elements.instagram.addEventListener('blur', () => {
    const handle = parseInstagramHandle(form.elements.instagram.value);
    form.elements.instagram.value = handle;
    if (handle && !form.elements.name.value.trim()) {
      form.elements.name.value = guessNameFromHandle(handle);
    }
  });

  // Hook multichip pour professions
  hookMultichip('profession-multichip', () => allKnownProfessions());

  // submit
  $('#edit-save').addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    // Anti double-click : ignorer si déjà en cours
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    try {
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.name?.trim()) {
      toast('Le nom est requis.', { type: 'warn' });
      form.elements.name.focus();
      return;
    }
    // Récupérer les professions du multichip
    const professions = getMultichipValues('profession-multichip');
    if (!professions.length) {
      toast('Au moins un métier est requis.', { type: 'warn' });
      $('#profession-multichip .multichip__input').focus();
      return;
    }
    const id = data.id || uid();
    const existing = STATE.profiles.find(p => p.id === id);
    const profile = {
      ...(existing || {}),
      id,
      name: data.name.trim(),
      professions,
      status: data.status || '',
      instagram: parseInstagramHandle(data.instagram),
      phone: data.phone.trim(),
      email: data.email.trim(),
      website: data.website.trim(),
      location: data.location.trim(),
      rate: (data.rate || '').trim(),
      agency: (data.agency || '').trim(),
      lastContact: data.lastContact || '',
      tags: (data.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      projects: data.projects || '',
      notes: data.notes,
    };
    delete profile.profession; // nettoyer ancien champ
    await saveProfile(profile);

    if (existing) {
      Object.assign(existing, profile);
    } else {
      STATE.profiles.push(profile);
    }

    if (pendingFiles.length) {
      await addImagesToProfile(profile, pendingFiles);
      pendingFiles = [];
    }
    const imgs = await getProfileImages(profile.id);
    STATE.imagesByProfile.set(profile.id, imgs);

    buildFilterChips();
    buildProfessionDatalist();
    render();
    $('#edit-dialog').close();
    maybeSchedulePush();
    toast(existing ? 'Profil mis à jour.' : 'Profil créé.', { type: 'ok' });
    } finally {
      btn.dataset.busy = '';
      btn.disabled = false;
    }
  });

  $('#edit-delete').addEventListener('click', async () => {
    const id = form.elements.id.value;
    const profile = STATE.profiles.find(p => p.id === id);
    if (!profile) return;
    $('#edit-dialog').close();
    confirmDelete(profile);
  });

  function addFiles(files) {
    for (const f of files) pendingFiles.push(f);
    refreshDropzonePreview();
  }
}

async function importInstagramProfilePicOnly(profile, { silent = false } = {}) {
  if (!profile.instagram) return { added: 0, errors: ['No handle'] };
  try {
    const result = await fetchInstagramProfilePicOnly(profile.instagram);
    if (!result.profilePic?.url) {
      return { added: 0, errors: result.errors };
    }
    let blob;
    try {
      const raw = await fetchImageAsBlob(result.profilePic.url);
      if (raw.size < 2000) throw new Error('image trop petite (< 2KB)');
      blob = await downscaleImage(raw, { maxDim: 1080, quality: 0.82 }).catch(() => raw);
    } catch (e) {
      return { added: 0, errors: ['blob: ' + e.message] };
    }
    await deleteProfileImages(profile.id);
    await saveImage(profile.id, 0, blob);
    if (result.bio && !profile.bio) profile.bio = result.bio;
    profile.updatedAt = new Date().toISOString();
    await saveProfile(profile);
    const imgs = await getProfileImages(profile.id);
    STATE.imagesByProfile.set(profile.id, imgs);
    return { added: 1, errors: [] };
  } catch (e) {
    return { added: 0, errors: [e.message] };
  }
}

let bulkFastRunning = false;
async function bulkImportProfilePicsOnly({ skipConfirm = false } = {}) {
  if (bulkFastRunning) {
    toast('Un bulk est déjà en cours.', { type: 'warn' });
    return;
  }
  const targets = STATE.profiles.filter(p => p.instagram && !STATE.imagesByProfile.get(p.id)?.length);
  if (!targets.length) {
    toast('Tous les profils Instagram ont déjà au moins une image.', { type: 'ok' });
    return;
  }
  if (!skipConfirm) {
    const ok = await confirmDialog({
      title: `Mode rapide : photo de profil seule pour ${targets.length} profils ?`,
      text: `Ce mode utilise UNIQUEMENT Dumpor (pas de Microlink, pas de rate limit). ` +
            `Vous obtiendrez la photo de profil et la bio de chaque profil. ` +
            `Pour avoir aussi les 9 derniers posts, utilisez "Scanner photos IG" plus tard ` +
            `(quand votre quota Microlink sera reset).`,
      okLabel: 'Lancer',
      danger: false,
    });
    if (!ok) return;
  }
  bulkFastRunning = true;
  $('#ig-bulk-btn')?.classList.add('is-running');
  const persist = toast(`Mode rapide : 0 / ${targets.length}…`, { type: 'info', timeout: 0 });
  let done = 0, success = 0;
  for (const p of targets) {
    const card = document.querySelector(`.card[data-id="${p.id}"]`);
    card?.classList.add('is-importing');
    try {
      const r = await importInstagramProfilePicOnly(p, { silent: true });
      if (r.added > 0) success++;
    } catch (e) { /* continue */ }
    card?.classList.remove('is-importing');
    done++;
    persist.dismiss();
    const t = toast(`Mode rapide : ${done} / ${targets.length} (${success} OK)`, { type: 'info', timeout: 0 });
    persist.dismiss = t.dismiss;
    render();
    await new Promise(r => setTimeout(r, 350)); // throttle léger
  }
  persist.dismiss();
  bulkFastRunning = false;
  $('#ig-bulk-btn')?.classList.remove('is-running');
  window.__updateIgBulkCount?.();
  render();
  toast(`Mode rapide terminé : ${success}/${targets.length} photos de profil ajoutées.`, { type: 'ok', timeout: 8000 });
  maybeSchedulePush();
  return { success, totalTargets: targets.length };
}

if (typeof window !== 'undefined') {
  window.__bulkProfilePicsOnly = bulkImportProfilePicsOnly;
}

async function importInstagramForProfile(profile, { silent = false } = {}) {
  if (!profile.instagram) {
    if (!silent) toast('Ce profil n’a pas de handle Instagram.', { type: 'warn' });
    return { added: 0, errors: ['No handle'] };
  }
  let progressToast = null;
  if (!silent) {
    progressToast = toast(`@${profile.instagram} : démarrage…`, { type: 'info', timeout: 0 });
  }
  try {
    let added = 0;
    const result = await fetchInstagramProfile(profile.instagram, {
      onProgress: ({ message }) => {
        if (progressToast && message) {
          progressToast.dismiss();
          progressToast = toast(`@${profile.instagram} : ${message}`, { type: 'info', timeout: 0 });
        }
      },
    });

    // Téléchargement + compression des blobs (profile pic en premier si dispo, puis posts)
    const newImgsToInsert = [];
    async function downloadAndCompress(url) {
      const raw = await fetchImageAsBlob(url);
      // Filtre robuste : rejeter blobs trop petits (probablement un logo ou icône générique)
      if (raw.size < 12000) throw new Error('Image trop petite (probable logo/placeholder)');
      // Compresser à 1080px max pour économiser le stockage IndexedDB
      try {
        return await downscaleImage(raw, { maxDim: 1080, quality: 0.82 });
      } catch { return raw; }
    }
    if (result.profilePic?.url) {
      try {
        const blob = await downloadAndCompress(result.profilePic.url);
        newImgsToInsert.push(blob);
      } catch (e) { result.errors.push('blob profile-pic : ' + e.message); }
    }
    for (const post of result.posts) {
      try {
        const blob = await downloadAndCompress(post.url);
        newImgsToInsert.push(blob);
      } catch (e) { /* skip */ }
    }

    if (newImgsToInsert.length) {
      // Remplacer toutes les images existantes (on est en mode "import")
      await deleteProfileImages(profile.id);
      for (let i = 0; i < newImgsToInsert.length; i++) {
        await saveImage(profile.id, i, newImgsToInsert[i]);
        added++;
      }
    } else {
      result.errors.push('aucune image téléchargée');
    }

    // Mise à jour bio si vide
    if (result.bio && !profile.bio) profile.bio = result.bio;

    progressToast?.dismiss();
    const imgs = await getProfileImages(profile.id);
    STATE.imagesByProfile.set(profile.id, imgs);

    if (added) {
      profile.updatedAt = new Date().toISOString();
      await saveProfile(profile);
      if (!silent) {
        if ($('#profile-dialog').open && STATE.current?.id === profile.id) openProfileDialog(profile.id);
        render();
        const errMsg = result.errors.length ? ` (${result.errors.length} avertissement${result.errors.length > 1 ? 's' : ''})` : '';
        toast(`@${profile.instagram} : ${added} image${added > 1 ? 's' : ''} importée${added > 1 ? 's' : ''}${errMsg}.`, { type: 'ok', timeout: 5000 });
      }
      maybeSchedulePush();
    } else if (!silent) {
      toast(`@${profile.instagram} : aucune image récupérée. ${result.errors.join(' ; ')}`, { type: 'err', timeout: 6000 });
    }
    return { added, errors: result.errors };
  } catch (e) {
    progressToast?.dismiss();
    if (!silent) toast(`@${profile.instagram} : ${e.message}`, { type: 'err' });
    return { added: 0, errors: [e.message] };
  }
}

let bulkRunning = false;
async function bulkImportInstagramPhotos({ skipConfirm = false } = {}) {
  if (bulkRunning) {
    toast('Un bulk est déjà en cours.', { type: 'warn' });
    return;
  }
  // Profils avec handle IG mais sans image
  const targets = STATE.profiles.filter(p => p.instagram && !STATE.imagesByProfile.get(p.id)?.length);
  if (!targets.length) {
    toast('Tous les profils Instagram ont déjà au moins une image. Rien à faire.', { type: 'ok' });
    return;
  }

  if (!skipConfirm) {
    const ok = await confirmDialog({
      title: `Importer les photos Instagram pour ${targets.length} profil${targets.length > 1 ? 's' : ''} ?`,
      text: `Cela prend environ 5 à 10 secondes par profil (~${Math.ceil(targets.length * 7 / 60)} minutes au total). ` +
            `Vous pouvez continuer à utiliser l'app. Si Microlink atteint son quota gratuit (50 req/jour), ` +
            `relancez plus tard.`,
      okLabel: 'Lancer',
      danger: false,
    });
    if (!ok) return;
  }

  bulkRunning = true;
  $('#ig-bulk-btn')?.classList.add('is-running');

  const persist = toast(`Bulk IG : 0 / ${targets.length}…`, { type: 'info', timeout: 0 });
  let done = 0, success = 0, totalImages = 0;

  let rateLimitHit = false;
  for (const p of targets) {
    if (rateLimitHit) break;
    const card = document.querySelector(`.card[data-id="${p.id}"]`);
    card?.classList.add('is-importing');
    try {
      const r = await importInstagramForProfile(p, { silent: true });
      if (r.added > 0) {
        success++;
        totalImages += r.added;
      }
      // Vérifier si on a hit le rate limit pendant ce profil
      if (isMicrolinkRateLimited()) {
        rateLimitHit = true;
      }
    } catch (e) {
      if (e.message === 'MICROLINK_RATE_LIMITED' || isMicrolinkRateLimited()) {
        rateLimitHit = true;
      }
    }
    card?.classList.remove('is-importing');
    done++;
    persist.dismiss();
    const t = toast(`Bulk IG : ${done} / ${targets.length} (${success} OK, ${totalImages} images)`, { type: 'info', timeout: 0 });
    persist.dismiss = t.dismiss;
    render();
    if (rateLimitHit) break;
    // throttle pour éviter rate-limiting
    await new Promise(r => setTimeout(r, 800));
  }

  persist.dismiss();
  render();
  bulkRunning = false;
  $('#ig-bulk-btn')?.classList.remove('is-running');
  window.__updateIgBulkCount?.();
  if (rateLimitHit) {
    toast(`Bulk arrêté : Microlink rate-limit atteint (50 req/jour anonyme). ` +
          `${success} profil${success > 1 ? 's' : ''} ajouté${success > 1 ? 's' : ''} (${totalImages} images). ` +
          `Réessayez demain ou ajoutez une clé API Microlink dans Réglages.`, {
      type: 'warn', timeout: 12000,
      action: { label: 'Réglages', onClick: () => openSettingsDialog() },
    });
  } else {
    toast(`Bulk IG terminé : ${success}/${targets.length} profils enrichis, ${totalImages} images au total.`, { type: 'ok', timeout: 8000 });
  }
  maybeSchedulePush();
  return { success, totalImages, totalTargets: targets.length, rateLimitHit };
}

// Exposer pour tests externes / pilotage
if (typeof window !== 'undefined') {
  window.__bulkImportIG = bulkImportInstagramPhotos;
  window.__getBulkProgress = () => ({
    running: bulkRunning,
    withImages: STATE.profiles.filter(p => STATE.imagesByProfile.get(p.id)?.length).length,
    total: STATE.profiles.length,
    withoutImages: STATE.profiles.filter(p => p.instagram && !STATE.imagesByProfile.get(p.id)?.length).length,
  });
}

async function addImagesToProfile(profile, files) {
  const existing = await getProfileImages(profile.id);
  let nextIdx = existing.length;
  let quotaHit = false;
  let saved = 0;
  for (const f of files) {
    try {
      const blob = await downscaleImage(f, { maxDim: 1400, quality: 0.85 });
      await saveImage(profile.id, nextIdx++, blob);
      saved++;
    } catch (err) {
      console.warn('Erreur image', err);
      if (err?.code === 'QUOTA_LOCAL') {
        quotaHit = true;
        break; // inutile de continuer
      }
    }
  }
  if (quotaHit) {
    toast(`Stockage local plein. ${saved}/${files.length} images sauvegardées. Supprimez d'anciennes images puis réessayez.`, {
      type: 'err', timeout: 7000,
    });
  }
}

// ============= BULK IMPORT =============

function hookBulkDialog() {
  const ta = $('#bulk-input');
  const preview = $('#bulk-preview');
  ta.addEventListener('input', () => {
    const items = parseBulk(ta.value);
    preview.textContent = items.length
      ? `${items.length} profil${items.length > 1 ? 's' : ''} détecté${items.length > 1 ? 's' : ''}.`
      : 'Aucun profil détecté pour l’instant.';
  });
  $('#bulk-confirm').addEventListener('click', async () => {
    const profession = $('#bulk-profession').value.trim();
    const items = parseBulk(ta.value);
    if (!items.length) {
      toast('Aucun profil à importer.', { type: 'warn' });
      return;
    }
    const now = new Date().toISOString();
    const newProfiles = [];
    const existingHandles = new Set(STATE.profiles.map(p => (p.instagram || '').toLowerCase()));
    let skipped = 0;
    for (const handle of items) {
      if (existingHandles.has(handle)) { skipped++; continue; }
      newProfiles.push({
        id: uid(),
        name: guessNameFromHandle(handle),
        profession,
        instagram: handle,
        phone: '', email: '', website: '', location: '',
        tags: [], notes: '',
        status: 'a_contacter',
        createdAt: now, updatedAt: now,
      });
    }
    if (newProfiles.length) {
      await bulkSaveProfiles(newProfiles);
      STATE.profiles.push(...newProfiles);
    }
    $('#bulk-dialog').close();
    ta.value = '';
    $('#bulk-profession').value = '';
    preview.textContent = '0 profils détectés.';
    buildFilterChips();
    render();
    toast(`${newProfiles.length} profils importés${skipped ? ` (${skipped} déjà existants ignorés)` : ''}.`, { type: 'ok' });
  });
}

function openBulkDialog() {
  const dlg = $('#bulk-dialog');
  if (!dlg.open) dlg.showModal();
}

function parseBulk(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = new Set();
  for (const l of lines) {
    const h = parseInstagramHandle(l);
    if (h) out.add(h);
  }
  return [...out];
}

// ============= EXPORT / IMPORT =============

// ============= MULTICHIP =============

const _multichipState = new Map();

function getMultichipValues(id) {
  return [..._multichipState.get(id) || []];
}

function setMultichipValues(id, values) {
  _multichipState.set(id, [...new Set(values)]);
  renderMultichip(id);
}

function renderMultichip(id) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  const chipsEl = wrap.querySelector('.multichip__chips');
  chipsEl.innerHTML = '';
  const values = _multichipState.get(id) || [];
  for (const v of values) {
    const chip = document.createElement('span');
    chip.className = 'multichip__chip';
    chip.innerHTML = `${escapeHtmlBasic(v)}<button type="button" aria-label="Retirer ${escapeHtmlBasic(v)}" data-remove="${escapeHtmlBasic(v)}">×</button>`;
    chipsEl.appendChild(chip);
  }
}

function escapeHtmlBasic(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hookMultichip(id, getSuggestions) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  const input = wrap.querySelector('.multichip__input');

  function addValue(v) {
    v = (v || '').trim();
    if (!v) return;
    const cur = _multichipState.get(id) || [];
    if (cur.some(x => x.toLowerCase() === v.toLowerCase())) return;
    _multichipState.set(id, [...cur, v]);
    renderMultichip(id);
    input.value = '';
    // Restaurer le focus sur l'input après le rebuild (sinon UX cassée :
    // l'user devait recliquer pour ajouter le tag suivant).
    input.focus();
  }

  function removeLast() {
    const cur = _multichipState.get(id) || [];
    if (!cur.length) return;
    _multichipState.set(id, cur.slice(0, -1));
    renderMultichip(id);
    input.focus();
  }

  wrap.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const v = rm.dataset.remove;
      _multichipState.set(id, (_multichipState.get(id) || []).filter(x => x !== v));
      renderMultichip(id);
      input.focus();
      return;
    }
    input.focus();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      addValue(input.value);
    } else if (e.key === 'Backspace' && !input.value) {
      removeLast();
    }
  });

  input.addEventListener('blur', () => {
    if (input.value) addValue(input.value);
  });

  input.addEventListener('input', () => {
    // datalist remplie automatiquement par le navigateur
    const dl = document.getElementById('profession-list');
    if (dl) {
      dl.innerHTML = '';
      for (const s of getSuggestions()) {
        const opt = document.createElement('option');
        opt.value = s;
        dl.appendChild(opt);
      }
    }
  });
}

async function safeCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback: textarea
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

async function copyEmailsOfFiltered() {
  const list = STATE.filtered.length ? STATE.filtered : applyFilters();
  const emails = list.map(p => p.email).filter(Boolean);
  if (!emails.length) {
    toast('Aucun e-mail dans la sélection actuelle.', { type: 'warn' });
    return;
  }
  const ok = await safeCopy(emails.join(', '));
  toast(`${emails.length} e-mail${emails.length > 1 ? 's' : ''} ${ok ? 'copié' : 'préparé (copie manuelle)'}${emails.length > 1 ? 's' : ''}.`, { type: ok ? 'ok' : 'warn' });
}

async function copyHandlesOfFiltered() {
  const list = STATE.filtered.length ? STATE.filtered : applyFilters();
  const handles = list.map(p => p.instagram).filter(Boolean).map(h => '@' + h);
  if (!handles.length) {
    toast('Aucun handle Instagram dans la sélection actuelle.', { type: 'warn' });
    return;
  }
  const ok = await safeCopy(handles.join('\n'));
  toast(`${handles.length} handle${handles.length > 1 ? 's' : ''} ${ok ? 'copié' : 'préparé (copie manuelle)'}${handles.length > 1 ? 's' : ''}.`, { type: ok ? 'ok' : 'warn' });
}

async function doExport() {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `trombinoscope_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Export téléchargé (avec images).', { type: 'ok' });
}

async function doExportCsv() {
  const profiles = STATE.profiles;
  if (!profiles.length) { toast('Aucun profil à exporter.', { type: 'warn' }); return; }
  const cols = ['name', 'professions', 'instagram', 'phone', 'email', 'website', 'location', 'agency', 'rate', 'tags', 'status', 'projects', 'notes', 'createdAt', 'updatedAt'];
  const escapeCsv = (v) => {
    if (v == null) return '';
    const s = Array.isArray(v) ? v.join(', ') : String(v);
    // Inclut \r et \n (Mac/Windows/Unix line endings)
    if (/[",\n\r;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const rows = [cols.join(',')];
  for (const p of profiles) {
    // CRLF est le séparateur de lignes RFC 4180 (compat Excel)
    rows.push(cols.map(c => escapeCsv(p[c])).join(','));
  }
  const csv = '﻿' + rows.join('\r\n'); // BOM for Excel + CRLF RFC 4180
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `trombinoscope_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`CSV exporté (${profiles.length} profils).`, { type: 'ok' });
}

function triggerImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      // Strip BOM UTF-8 si présent (export Excel/Notepad ajoute souvent ﻿)
      const text = (await f.text()).replace(/^﻿/, '');
      const data = JSON.parse(text);
      if (!data.profiles || !Array.isArray(data.profiles)) throw new Error('Format invalide');
      const replace = await confirmDialog({
        title: `Importer ${data.profiles.length} profils ?`,
        text: 'Voulez-vous remplacer entièrement les données existantes (annule la suppression possible) ou fusionner avec les profils actuels ?',
        okLabel: 'Remplacer',
      });
      await importAll(data, { replace });
      // recharge
      STATE.profiles = await getAllProfiles();
      STATE.imagesByProfile.clear();
      for (const p of STATE.profiles) {
        const imgs = await getProfileImages(p.id);
        if (imgs.length) STATE.imagesByProfile.set(p.id, imgs);
      }
      buildFilterChips();
      render();
      toast('Import terminé.', { type: 'ok' });
    } catch (err) {
      console.error(err);
      toast('Import impossible (fichier invalide).', { type: 'err' });
    }
  });
  input.click();
}

async function doDiagnoseSync() {
  toast('Diagnostic en cours…', { type: 'info', timeout: 0 });
  const r = await diagnoseSync();
  // Build a readable summary
  let html = '';
  if (!r.configured) {
    html = 'La sync n\'est pas configurée.';
  } else if (r.error) {
    html = `Erreur : ${r.error}`;
  } else {
    html = [
      `Gist : ${r.gistId}`,
      `URL : ${r.gistUrl}`,
      `Mis à jour : ${new Date(r.gistUpdated).toLocaleString('fr-FR')}`,
      `Fichiers totaux : ${r.totalFiles}`,
      `Taille totale : ${Math.round(r.totalSize / 1024)} Ko`,
      `Profils dans le manifest : ${r.manifestProfiles}`,
      `Total images annoncé : ${r.manifestTotalImages}`,
      `Chunks d'images sur le Gist : ${r.chunkFilesCount}`,
      r.chunkFilesCount > 0 ? `Tailles : ${r.chunkSizes.map(c => c.sizeKb + ' Ko' + (c.truncated ? '⚠tronqué' : '')).join(', ')}` : '',
      `Dernière sync locale : ${r.lastSync ? new Date(r.lastSync).toLocaleString('fr-FR') : 'jamais'}`,
    ].filter(Boolean).join('\n');
  }
  // Trouver tous les toasts existants info et les fermer
  document.querySelectorAll('.toast').forEach(t => { if (t.textContent.includes('Diagnostic en cours')) t.remove(); });
  // Affichage dans une modale alert simple pour copier
  const result = window.prompt('Diagnostic sync GitHub (Cmd+C pour copier) :', html);
  console.log('[Diagnostic Sync]', r);
  if (r.chunkFilesCount === 0 && r.manifestProfiles > 0) {
    toast('⚠ AUCUN chunk d\'images sur le Gist ! Cliquez Sauvegarder pour les pusher.', { type: 'warn', timeout: 8000 });
  } else if (r.chunkSizes?.some(c => c.truncated)) {
    toast('⚠ Certains chunks sont tronqués côté GitHub. Re-sauvegardez.', { type: 'warn', timeout: 8000 });
  }
}

async function doBackupLocal() {
  const tt = toast('Préparation du backup complet…', { type: 'info', timeout: 0 });
  try {
    const data = await exportAll();
    const totalImages = data.images?.length || 0;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `trombinoscope-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    tt.dismiss();
    toast(`✓ Backup téléchargé : ${data.profiles?.length || 0} profils + ${totalImages} images (${Math.round(blob.size / 1024)} Ko).`, { type: 'ok', timeout: 6000 });
  } catch (e) {
    tt.dismiss();
    toast('Backup échoué : ' + e.message, { type: 'err' });
  }
}

async function reapplyEnrichment() {
  const ok = await confirmDialog({
    title: 'Ré-appliquer les infos web ?',
    text: `Cela ré-appliquera les infos publiques trouvées en ligne (site, e-mail, bio, agence) ` +
          `aux profils dont CES champs sont vides. Vos modifications personnelles ne seront PAS écrasées.`,
    okLabel: 'Appliquer',
    danger: false,
  });
  if (!ok) return;
  await setMeta('enrichment_last_version', null);
  const result = await applyEnrichmentIfNew();
  if (result.applied) {
    STATE.profiles = await getAllProfiles();
    buildFilterChips();
    buildProfessionDatalist();
    render();
    toast(`✨ ${result.updated} profils enrichis (v${result.version}).`, { type: 'ok', timeout: 5000 });
    maybeSchedulePush();
  } else {
    toast('Aucune nouvelle info à appliquer.', { type: 'info', timeout: 3000 });
  }
}

async function doReSeed() {
  const ok = await confirmDialog({
    title: 'Recharger les profils initiaux ?',
    text: 'Les profils initiaux fournis seront ajoutés. Les profils existants ne seront pas dupliqués (basé sur le handle Instagram).',
    okLabel: 'Ajouter',
    danger: false,
  });
  if (!ok) return;
  const existing = new Set(STATE.profiles.map(p => (p.instagram || '').toLowerCase()));
  const now = new Date().toISOString();
  const newOnes = SEED_PROFILES
    .filter(s => !existing.has(s.instagram.toLowerCase()))
    .map(s => ({
      id: uid(),
      name: s.name,
      profession: s.profession,
      instagram: s.instagram,
      phone: '', email: '', website: '', location: '',
      tags: [], notes: '', status: 'a_contacter',
      createdAt: now, updatedAt: now,
    }));
  if (newOnes.length) {
    await bulkSaveProfiles(newOnes);
    STATE.profiles.push(...newOnes);
    buildFilterChips();
    render();
  }
  toast(`${newOnes.length} profils ajoutés.`, { type: 'ok' });
}

async function doReset() {
  const ok = await confirmDialog({
    title: 'Effacer toutes les données ?',
    text: 'Tous les profils, images et notes seront supprimés définitivement. Cette action est irréversible.',
    okLabel: 'Tout effacer',
  });
  if (!ok) return;
  for (const p of STATE.profiles) {
    await deleteProfile(p.id);
  }
  await setMeta('seeded', false);
  STATE.profiles = [];
  STATE.imagesByProfile.clear();
  buildFilterChips();
  render();
  toast('Toutes les données ont été effacées.', { type: 'warn' });
}

// ============= KEYBOARD =============

function onKeydown(e) {
  // dans modal → flèches naviguent + F bascule favori
  const profileOpen = $('#profile-dialog').open;
  if (e.key === 'Escape') {
    closeMenu();
    closeContextMenu();
    // Fermer le premier dialog ouvert (le natif Esc est parfois capricieux selon
    // l'élément qui a le focus, ex. un <textarea> à l'intérieur du dialog)
    const openDlg = document.querySelector('dialog[open]');
    if (openDlg) {
      try { openDlg.close(); } catch {}
    }
    return;
  }
  if (profileOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    navigateProfile(e.key === 'ArrowLeft' ? -1 : +1);
    return;
  }
  if (profileOpen && e.key.toLowerCase() === 'f' && !isTypingContext()) {
    e.preventDefault();
    if (STATE.current) {
      STATE.current.status = STATE.current.status === 'favori' ? '' : 'favori';
      saveProfile(STATE.current).then(() => {
        openProfileDialog(STATE.current.id);
        render();
        toast(STATE.current.status === 'favori' ? '⭐ Ajouté aux favoris' : 'Retiré des favoris', { type: 'ok' });
      });
    }
    return;
  }
  if (isTypingContext()) return;

  // raccourcis
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#search-input').focus();
    $('#search-input').select();
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    $('#search-input').focus();
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    openDialog('shortcuts-dialog');
    return;
  }
  if (e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openEditDialog();
    return;
  }
  if (e.key.toLowerCase() === 't') {
    e.preventDefault();
    $('#theme-toggle').click();
    return;
  }
  if (e.key.toLowerCase() === 'g') {
    STATE.view = 'grid'; setMeta('view', 'grid'); applyView(); render(); return;
  }
  if (e.key.toLowerCase() === 'l') {
    STATE.view = 'list'; setMeta('view', 'list'); applyView(); render(); return;
  }
  if (/^[1-9]$/.test(e.key)) {
    const chips = $$('#profession-chips .chip');
    const idx = +e.key;
    if (chips[idx]) {
      chips[idx].click();
    }
  }
}

function openDialog(id) {
  const dlg = document.getElementById(id);
  if (dlg && !dlg.open) dlg.showModal();
}

// ============= SYNC =============

let __unsubSyncListener = null;
function setupSyncListeners() {
  // Idempotent : si déjà setup, on retire l'ancien listener pour éviter les
  // doubles notifications (peut arriver lors de hot-reload ou boot multiple).
  if (__unsubSyncListener) { try { __unsubSyncListener(); } catch {} }
  __unsubSyncListener = onSyncStateChange(async (s) => {
    updateSyncPill(s);
    const btn = $('#save-btn');
    if (btn) {
      btn.classList.remove('is-dirty', 'is-syncing', 'is-error', 'is-saved');
      const label = btn.querySelector('.savebtn__label');
      // Si aucun token Gist NI cloud configuré → on n'affiche pas d'erreur,
      // même si une opération échoue. C'est juste un état "pas configuré".
      const cloudCfg = await getCloudConfig();
      const syncCfg = await getSyncConfig();
      const noConfig = !cloudCfg.token && !syncCfg.token;

      if (s.status === 'pushing') {
        btn.classList.add('is-syncing');
        if (label) label.textContent = 'Sauvegarde…';
      } else if (s.status === 'pulling') {
        btn.classList.add('is-syncing');
        if (label) label.textContent = 'Réception…';
      } else if (s.status === 'error') {
        if (noConfig) {
          updateSaveButton();
          return;
        }
        // Erreur de quota = transitoire, auto-retry → on n'affiche pas "Erreur"
        if (s.error && /Quota GitHub/.test(s.error)) {
          btn.classList.add('is-dirty');
          if (label) label.textContent = 'En attente';
          btn.title = 'Quota Gist atteint — réessai automatique. Astuce : Cloud public sans quota dans Réglages.';
        } else {
          btn.classList.add('is-error');
          if (label) label.textContent = 'Erreur';
          btn.title = 'Erreur : ' + s.error;
        }
      } else if (s.status === 'idle' && s.lastSync) {
        markClean();
        btn.classList.add('is-saved');
        if (label) label.textContent = 'Sauvegardé';
        // Retour à l'état "saved" puis fade out
        setTimeout(() => {
          if (!dirtyState) updateSaveButton();
        }, 3000);
      }
    }
    if (s.status === 'pulled-silent') {
      // Pull silencieux réussi (nouveau device qui a chargé les data du Gist)
      STATE.profiles = await getAllProfiles();
      STATE.imagesByProfile.clear();
      for (const p of STATE.profiles) {
        const imgs = await getProfileImages(p.id);
        if (imgs.length) STATE.imagesByProfile.set(p.id, imgs);
      }
      buildFilterChips();
      buildProfessionDatalist();
      render();
      window.__updateIgBulkCount?.();
      const imgMsg = s.images ? ` + ${s.images} images` : '';
      toast(`✓ Synchro cloud : ${s.profiles} profils${imgMsg} chargés.`, { type: 'ok', timeout: 5000 });
    }
    if (s.status === 'remote-newer') {
      toast(`Conflit : ${s.remoteProfiles} profils distants vs vos modifs locales. Que faire ?`, {
        type: 'warn', timeout: 0,
        action: { label: 'Récupérer le cloud', onClick: async () => {
          try {
            await syncPullNow({ replace: true });
            STATE.profiles = await getAllProfiles();
            STATE.imagesByProfile.clear();
            for (const p of STATE.profiles) {
              const imgs = await getProfileImages(p.id);
              if (imgs.length) STATE.imagesByProfile.set(p.id, imgs);
            }
            buildFilterChips();
            render();
            window.__updateIgBulkCount?.();
            toast('Sync : profils mis à jour depuis le cloud.', { type: 'ok' });
          }
          catch (e) { toast('Sync échec : ' + e.message, { type: 'err' }); }
        }},
      });
    }
  });
}

async function updateSyncPill(s) {
  const pill = $('#sync-pill');
  if (!pill) return;
  const cfg = await getSyncConfig();
  if (!cfg.token) {
    pill.classList.add('off');
    pill.classList.remove('ok', 'syncing', 'err');
    return;
  }
  pill.classList.remove('off');
  pill.classList.remove('ok', 'syncing', 'err');
  const status = s?.status || 'idle';
  if (status === 'pushing' || status === 'pulling') {
    pill.classList.add('syncing');
    pill.textContent = status === 'pushing' ? 'Sync ↑' : 'Sync ↓';
  } else if (status === 'error') {
    pill.classList.add('err');
    pill.textContent = 'Sync ✗';
    pill.title = s.error;
  } else {
    pill.classList.add('ok');
    pill.textContent = 'Sync';
    pill.title = cfg.lastSync ? 'Dernière sync : ' + new Date(cfg.lastSync).toLocaleString('fr-FR') : 'Synchronisation activée';
  }
}

function maybeSchedulePush() {
  // Priorité au cloud public si configuré
  getCloudConfig().then(cfg => {
    if (cfg.token) {
      scheduleCloudPush(2500);
      markDirty();
    } else if (isSyncReady()) {
      schedulePush(2500);
      markDirty();
    }
  });
}

let __unsubCloudListener = null;
function setupCloudListeners() {
  if (__unsubCloudListener) { try { __unsubCloudListener(); } catch {} }
  __unsubCloudListener = onCloudStateChange(async (s) => {
    const btn = $('#save-btn');
    if (!btn) return;
    btn.classList.remove('is-dirty', 'is-syncing', 'is-error', 'is-saved', 'is-unconfigured');
    const label = btn.querySelector('.savebtn__label');
    // Pas de token → l'app fait juste de la lecture anonyme. Erreurs = silencieuses.
    const cloudCfg = await getCloudConfig();
    const syncCfg = await getSyncConfig();
    const noConfig = !cloudCfg.token && !syncCfg.token;

    if (s.status === 'pushing') {
      btn.classList.add('is-syncing');
      if (label) label.textContent = s.message || 'Push cloud…';
    } else if (s.status === 'pulling') {
      btn.classList.add('is-syncing');
      if (label) label.textContent = s.message || 'Récupération…';
    } else if (s.status === 'error') {
      if (noConfig) {
        // Lecture anonyme qui échoue → on ne dérange pas l'utilisateur,
        // on retombe sur l'état "non configuré" (gris discret).
        updateSaveButton();
        return;
      }
      // Quota ou erreur réseau temporaire = transitoire, on n'alarme pas
      if (s.error && /Quota GitHub|Réseau injoignable/.test(s.error)) {
        btn.classList.add('is-dirty');
        if (label) label.textContent = 'En attente';
        btn.title = 'Sauvegarde différée — réessai automatique.';
      } else {
        btn.classList.add('is-error');
        if (label) label.textContent = 'Erreur';
        btn.title = 'Erreur : ' + s.error;
      }
    } else if (s.status === 'idle' && s.lastSync) {
      markClean();
      btn.classList.add('is-saved');
      if (label) label.textContent = 'Sauvegardé';
      setTimeout(() => { if (!dirtyState) updateSaveButton(); }, 3000);
    }
  });
}

// ============= SAVE BUTTON STATE =============

let dirtyState = false;

function markDirty() {
  dirtyState = true;
  updateSaveButton();
}
function markClean() {
  dirtyState = false;
  updateSaveButton();
}
async function updateSaveButton() {
  const btn = $('#save-btn');
  if (!btn) return;
  btn.hidden = false;
  const cloudCfg = await getCloudConfig();
  const syncCfg = await getSyncConfig();
  const hasAnySync = cloudCfg.token || syncCfg.token;
  btn.classList.remove('is-dirty', 'is-syncing', 'is-error', 'is-saved', 'is-unconfigured');
  const label = btn.querySelector('.savebtn__label');
  if (!hasAnySync) {
    btn.classList.add('is-unconfigured');
    if (label) label.textContent = 'Déverrouiller';
    btn.title = 'Entrez le mot de passe pour pouvoir modifier depuis cet appareil.';
    return;
  }
  const lastSync = cloudCfg.lastSync || syncCfg.lastSync;
  const sourceName = cloudCfg.token ? 'cloud public' : 'Gist';
  if (dirtyState) { btn.classList.add('is-dirty'); if (label) label.textContent = 'Sauvegarder'; btn.title = `Modifications en attente — clic pour pusher vers le ${sourceName} (⌘S)`; }
  else if (lastSync) { btn.classList.add('is-saved'); if (label) label.textContent = 'Sauvegardé'; btn.title = `Tout est sauvegardé sur le ${sourceName}. Dernière sync : ` + new Date(lastSync).toLocaleString('fr-FR'); }
  else { if (label) label.textContent = 'Sauvegarder'; btn.title = `Push vers ${sourceName} (⌘S)`; }
}

// ============= SETTINGS DIALOG =============

let settingsHooked = false;
async function openSettingsDialog() {
  const dlg = $('#settings-dialog');
  if (!settingsHooked) hookSettingsDialog();
  await refreshSettingsView();
  if (!dlg.open) dlg.showModal();
}

function hookSettingsDialog() {
  settingsHooked = true;
  const dlg = $('#settings-dialog');

  // Auto-trim token inputs : un copier-coller depuis Slack/Notion ramène souvent
  // un espace ou un saut de ligne à la fin → erreurs de connexion confuses.
  for (const id of ['#cloud-token-input', '#sync-token-input']) {
    const inp = dlg.querySelector(id);
    if (inp) {
      inp.addEventListener('blur', () => { inp.value = inp.value.trim(); });
      inp.addEventListener('paste', () => {
        // Le paste fire AVANT que la valeur soit insérée → wait next tick
        setTimeout(() => { inp.value = inp.value.trim(); }, 0);
      });
    }
  }

  // CLOUD PUBLIC (RECOMMANDÉ)
  $('#cloud-test-btn').addEventListener('click', async () => {
    const token = $('#cloud-token-input').value.trim();
    const out = $('#cloud-test-result');
    if (!token) { out.textContent = 'Saisissez un token.'; out.className = 'settings__small err'; return; }
    out.textContent = 'Test en cours…'; out.className = 'settings__small';
    try {
      const u = await testCloudConnection(token);
      out.textContent = `✓ Token OK (${u.repo}). Push initial vers le cloud public…`;
      out.className = 'settings__small ok';
      await setCloudToken(token);
      try {
        const r = await pushCloud();
        out.textContent = `✓ Cloud activé : ${r.profiles} profils + ${r.images} images (${r.chunks} fichiers, ${r.sizeKb} Ko). Tout autre appareil verra ces données automatiquement.`;
      } catch (pushErr) {
        out.textContent = `⚠ Cloud activé mais push initial échoué : ${pushErr.message}`;
        out.className = 'settings__small err';
      }
      updateSyncPill();
      updateSaveButton();
      refreshSettingsView();
    } catch (e) {
      out.textContent = '✗ ' + e.message;
      out.className = 'settings__small err';
    }
  });
  $('#cloud-auto-toggle').addEventListener('change', async (e) => {
    await setCloudAuto(e.target.checked);
  });
  $('#cloud-pull-btn').addEventListener('click', async () => {
    try {
      const ok = await confirmDialog({
        title: 'Récupérer du cloud public ?',
        text: 'Cela remplacera vos données locales par celles du cloud.',
        okLabel: 'Récupérer',
      });
      if (!ok) return;
      const r = await pullCloud({ replace: true });
      STATE.profiles = await getAllProfiles();
      STATE.imagesByProfile.clear();
      for (const p of STATE.profiles) {
        const imgs = await getProfileImages(p.id);
        if (imgs.length) STATE.imagesByProfile.set(p.id, imgs);
      }
      buildFilterChips();
      render();
      window.__updateIgBulkCount?.();
      toast(`✓ ${r.profiles} profils + ${r.images} images chargés du cloud.`, { type: 'ok' });
      refreshSettingsView();
    } catch (e) { toast('Pull cloud échoué : ' + e.message, { type: 'err' }); }
  });
  $('#cloud-push-btn').addEventListener('click', async () => {
    try {
      const r = await pushCloud();
      toast(`✓ ${r.profiles} profils + ${r.images} images poussés vers le cloud (${r.sizeKb} Ko).`, { type: 'ok', timeout: 5000 });
      refreshSettingsView();
    } catch (e) { toast('Push cloud échoué : ' + e.message, { type: 'err' }); }
  });
  $('#cloud-invite-btn').addEventListener('click', async () => {
    try {
      const link = await generateCloudInviteLink();
      const out = $('#cloud-invite-out');
      const help = $('#cloud-invite-help');
      const qrWrap = $('#cloud-qr-wrap');
      const qrCanvas = $('#cloud-qr-canvas');
      const shareBtn = $('#cloud-share-btn');
      out.value = link;
      out.style.display = 'block';
      help.style.display = 'block';
      help.textContent = '✓ Scanne le QR depuis l\'autre appareil → cloud activé. Ou copie le lien.';
      help.className = 'settings__small ok';
      // Rendu QR
      try {
        renderQRToCanvas(qrCanvas, link, { scale: 8, margin: 3 });
        qrWrap.style.display = 'block';
      } catch (e) {
        console.warn('QR render failed:', e.message);
        qrWrap.style.display = 'none';
      }
      // Bouton partager natif si dispo (iOS, macOS Safari, Android Chrome)
      if (navigator.share) {
        shareBtn.hidden = false;
        shareBtn.onclick = async () => {
          try {
            await navigator.share({
              title: 'Trombinoscope — activer le cloud',
              text: 'Ouvre ce lien sur ce téléphone pour activer la sauvegarde cloud du Trombinoscope.',
              url: link,
            });
          } catch (e) {
            if (e.name !== 'AbortError') console.warn('Share failed:', e);
          }
        };
      }
      // Copie auto
      try {
        await navigator.clipboard.writeText(link);
      } catch {}
    } catch (e) {
      const help = $('#cloud-invite-help');
      help.style.display = 'block';
      help.textContent = '✗ ' + e.message;
      help.className = 'settings__small err';
    }
  });

  $('#cloud-disconnect-btn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Déconnecter le cloud ?',
      text: 'Vos données restent en local et sur le cloud public. Le token sera oublié sur cet appareil.',
      okLabel: 'Déconnecter',
    });
    if (!ok) return;
    await clearCloudConfig();
    refreshSettingsView();
    toast('Cloud déconnecté sur cet appareil.', { type: 'ok' });
  });

  // SYNC GIST (legacy)
  $('#sync-test-btn').addEventListener('click', async () => {
    const token = $('#sync-token-input').value.trim();
    const out = $('#sync-test-result');
    if (!token) { out.textContent = 'Saisissez un token.'; out.className = 'settings__small err'; return; }
    out.textContent = 'Test en cours…'; out.className = 'settings__small';
    try {
      const u = await testSyncConnection(token);
      out.textContent = `✓ Connecté en tant que @${u.login}. Push initial vers le cloud…`;
      out.className = 'settings__small ok';
      await setSyncToken(token);
      await setSyncToken(token);
      // Vérifier si Gist existe déjà avec données → proposer pull au lieu de push
      try {
        const diag = await diagnoseSync();
        if (diag.manifestProfiles > 0 && diag.chunkFilesCount > 0) {
          // Gist contient déjà des data → pull plutôt que push
          out.textContent = `✓ @${u.login} — Gist trouvé avec ${diag.manifestProfiles} profils + ${diag.chunkFilesCount} chunks d'images. Récupération…`;
          const r = await syncPullNow({ replace: true });
          out.textContent = `✓ Synchro réussie : ${r.profiles} profils + ${r.images} images chargés depuis le cloud.`;
          // Recharger les profils dans STATE
          STATE.profiles = await getAllProfiles();
          STATE.imagesByProfile.clear();
          for (const p of STATE.profiles) {
            const imgs = await getProfileImages(p.id);
            if (imgs.length) STATE.imagesByProfile.set(p.id, imgs);
          }
          buildFilterChips();
          buildProfessionDatalist();
          render();
          window.__updateIgBulkCount?.();
        } else if (diag.manifestProfiles > 0) {
          // Gist a manifest mais pas de chunks
          out.textContent = `⚠ Gist trouvé mais 0 chunks d'images. Push initial complet…`;
          const r = await syncPushNow();
          const imgMsg = r.images ? ` + ${r.images} images sur ${r.chunks} fichiers` : ' (sans images)';
          out.textContent = `✓ @${u.login} — ${r.profiles} profils${imgMsg} sauvegardés (${r.sizeKb} Ko).`;
        } else {
          // Gist vide ou nouveau → push tout
          out.textContent = `✓ @${u.login} — Push initial vers le cloud…`;
          const r = await syncPushNow();
          const imgMsg = r.images ? ` + ${r.images} images sur ${r.chunks} fichiers` : ' (sans images)';
          out.textContent = `✓ @${u.login} — ${r.profiles} profils${imgMsg} sauvegardés (${r.sizeKb} Ko). Sync auto activée.`;
        }
      } catch (syncErr) {
        out.textContent = `✓ @${u.login} connecté — mais sync initiale échouée : ${syncErr.message}`;
      }
      await setupAutoSync();
      updateSyncPill();
      updateSaveButton();
      refreshSettingsView();
    } catch (e) {
      out.textContent = '✗ ' + e.message;
      out.className = 'settings__small err';
    }
  });

  $('#sync-auto-toggle').addEventListener('change', async (e) => {
    await setSyncAutoSync(e.target.checked);
    if (e.target.checked) await setupAutoSync();
  });

  $('#sync-pull-btn').addEventListener('click', async () => {
    try {
      const ok = await confirmDialog({
        title: 'Récupérer les données du cloud ?',
        text: 'Cela remplacera vos profils locaux par ceux du Gist GitHub.',
        okLabel: 'Récupérer',
      });
      if (!ok) return;
      await syncPullNow({ replace: true });
      STATE.profiles = await getAllProfiles();
      STATE.imagesByProfile.clear();
      for (const p of STATE.profiles) {
        const imgs = await getProfileImages(p.id);
        if (imgs.length) STATE.imagesByProfile.set(p.id, imgs);
      }
      buildFilterChips();
      render();
      toast('Profils récupérés depuis le cloud.', { type: 'ok' });
      refreshSettingsView();
    } catch (e) { toast('Pull échec : ' + e.message, { type: 'err' }); }
  });

  $('#sync-push-btn').addEventListener('click', async () => {
    try {
      const r = await syncPushNow();
      toast(`${r.profiles ?? '?'} profils envoyés vers le cloud.`, { type: 'ok' });
      refreshSettingsView();
    } catch (e) { toast('Push échec : ' + e.message, { type: 'err' }); }
  });

  $('#sync-invite-btn').addEventListener('click', async () => {
    try {
      const link = await generateInviteLink();
      const out = $('#sync-invite-out');
      const help = $('#sync-invite-help');
      out.value = link;
      out.style.display = 'block';
      help.style.display = 'block';
      help.textContent = '✓ Copiez ce lien et ouvrez-le sur l\'autre appareil. Il configurera tout automatiquement (token + récupération des photos).';
      help.className = 'settings__small ok';
      // Auto-select pour copier facilement
      out.focus();
      out.select();
      try {
        await navigator.clipboard.writeText(link);
        help.textContent = '✓ Lien copié dans le presse-papier ! Ouvrez-le sur l\'autre appareil.';
      } catch {}
    } catch (e) {
      const help = $('#sync-invite-help');
      help.style.display = 'block';
      help.textContent = '✗ ' + e.message;
      help.className = 'settings__small err';
    }
  });

  $('#sync-disconnect-btn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Déconnecter la synchronisation ?',
      text: 'Vos données locales restent en place. Le token sera supprimé du navigateur.',
      okLabel: 'Déconnecter',
    });
    if (!ok) return;
    await clearSyncConfig();
    updateSyncPill();
    refreshSettingsView();
    toast('Sync déconnectée.', { type: 'ok' });
  });

  // AI
  $('#ai-test-btn').addEventListener('click', async () => {
    const key = $('#ai-key-input').value.trim();
    const model = $('#ai-model-select').value;
    const out = $('#ai-test-result');
    if (!key) { out.textContent = 'Saisissez une clé.'; out.className = 'settings__small err'; return; }
    out.textContent = 'Test en cours…'; out.className = 'settings__small';
    try {
      await testAiConnection(key, model);
      await setAiKey(key);
      await setAiModel(model);
      out.textContent = `✓ Connexion réussie (modèle ${model}). Clé enregistrée.`;
      out.className = 'settings__small ok';
      refreshSettingsView();
    } catch (e) {
      out.textContent = '✗ ' + e.message;
      out.className = 'settings__small err';
    }
  });

  $('#ai-model-select').addEventListener('change', async (e) => {
    await setAiModel(e.target.value);
  });

  // Microlink key
  $('#microlink-save-btn').addEventListener('click', async () => {
    const key = $('#microlink-key-input').value.trim();
    if (!key) { $('#microlink-key-status').textContent = 'Saisissez une clé.'; $('#microlink-key-status').className = 'settings__small err'; return; }
    await setMeta('microlink_api_key', key);
    resetMicrolinkRateLimit();
    $('#microlink-key-status').textContent = '✓ Clé enregistrée. Le quota est désormais celui de votre plan Microlink.';
    $('#microlink-key-status').className = 'settings__small ok';
  });
  $('#microlink-clear-btn').addEventListener('click', async () => {
    await setMeta('microlink_api_key', null);
    $('#microlink-key-input').value = '';
    $('#microlink-key-status').textContent = 'Clé effacée. Mode anonyme (50 req/jour).';
    $('#microlink-key-status').className = 'settings__small';
  });

  $('#ai-disconnect-btn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Effacer la clé API Anthropic ?',
      text: 'La fonction de scan IA sera désactivée. Vos profils restent intacts.',
      okLabel: 'Effacer',
    });
    if (!ok) return;
    await setAiKey(null);
    refreshSettingsView();
    toast('Clé IA effacée.', { type: 'ok' });
  });
}

async function refreshSettingsView() {
  const cfg = await getSyncConfig();
  $('#sync-token-input').value = cfg.token || '';
  $('#sync-auto-toggle').checked = cfg.autoSync;
  const badge = $('#sync-status-badge');
  badge.textContent = cfg.token ? 'Activée' : 'Désactivée';
  badge.classList.toggle('ok', !!cfg.token);
  $('#sync-last-info').textContent = cfg.lastSync ? `Dernière sync : ${new Date(cfg.lastSync).toLocaleString('fr-FR')}` : '';

  const aiKey = await getAiKey();
  const aiModel = await getAiModel();
  $('#ai-key-input').value = aiKey || '';
  $('#ai-model-select').value = aiModel;
  const aiBadge = $('#ai-status-badge');
  aiBadge.textContent = aiKey ? 'Configuré' : 'Désactivé';
  aiBadge.classList.toggle('ok', !!aiKey);

  const mlKey = await getMeta('microlink_api_key');
  $('#microlink-key-input').value = mlKey || '';
  $('#microlink-key-status').textContent = mlKey ? '✓ Clé active.' : 'Mode anonyme (50 req/jour).';
  $('#microlink-key-status').className = mlKey ? 'settings__small ok' : 'settings__small';

  // Cloud public
  const cloudCfg = await getCloudConfig();
  $('#cloud-token-input').value = cloudCfg.token || '';
  $('#cloud-auto-toggle').checked = cloudCfg.auto;
  const cloudBadge = $('#cloud-status-badge');
  cloudBadge.textContent = cloudCfg.token ? 'Activé' : 'Désactivé';
  cloudBadge.classList.toggle('ok', !!cloudCfg.token);
  $('#cloud-last-info').textContent = cloudCfg.lastSync ? `Dernière sync cloud : ${new Date(cloudCfg.lastSync).toLocaleString('fr-FR')}` : '';
}

// ============= AI SCAN ON PROFILE =============

let lastAiResult = null;
let lastAiProfile = null;

async function aiScanProfile(profile) {
  if (!await isAiConfigured()) {
    toast('Configurez votre clé API Anthropic dans les Réglages d’abord.', { type: 'warn',
      action: { label: 'Réglages', onClick: () => openSettingsDialog() } });
    return;
  }
  const dlg = $('#ai-scan-dialog');
  const body = $('#ai-scan-body');
  $('#ai-scan-title').textContent = `Scan IA — ${profile.name || profile.instagram}`;
  body.innerHTML = `
    <div class="ai-scan__loading">
      <div class="spinner"></div>
      <div>Recherche d'informations publiques en cours…</div>
      <small style="color: var(--text-faint); margin-top: 8px; display: block;">L'IA effectue jusqu'à 5 recherches web. Cela prend 10 à 30 secondes.</small>
    </div>`;
  if (!dlg.open) dlg.showModal();

  try {
    const result = await scanProfileWithAi(profile, ({ message }) => {
      const mEl = body.querySelector('.ai-scan__loading > div:last-of-type');
      if (mEl) mEl.textContent = message;
    });
    lastAiResult = result;
    lastAiProfile = profile;
    renderAiResult(profile, result);
  } catch (e) {
    body.innerHTML = `<div class="ai-scan__loading"><div style="color: var(--danger); font-weight: 500;">Erreur</div><div style="color: var(--text-muted); margin-top: 8px;">${escapeHtmlBasic(e.message)}</div></div>`;
  }
}

function renderAiResult(profile, result) {
  const body = $('#ai-scan-body');
  const fields = [
    { key: 'website', label: 'Site / Portfolio', current: profile.website },
    { key: 'email', label: 'E-mail', current: profile.email },
    { key: 'phone', label: 'Téléphone', current: profile.phone },
    { key: 'location', label: 'Localisation', current: profile.location },
    { key: 'bio', label: 'Bio', current: profile.bio },
    { key: 'professions', label: 'Métier(s)', current: (profile.professions || []).join(', '), isArray: true },
    { key: 'tags', label: 'Tags', current: (profile.tags || []).join(', '), isArray: true },
  ];
  const conf = (result.confidence || 'low').toLowerCase();
  let html = `<div style="margin-bottom: 12px; font-size: 13px; color: var(--text-muted);">Confiance : <span class="ai-scan__confidence ${conf}">${conf}</span></div>`;
  for (const f of fields) {
    const val = result[f.key];
    const valStr = f.isArray ? (Array.isArray(val) ? val.join(', ') : (val || '')) : (val || '');
    const isEmpty = !valStr || valStr === 'null';
    const isDifferent = !isEmpty && valStr !== f.current;
    const checked = isDifferent ? 'checked' : '';
    html += `
      <div class="ai-scan__field">
        <input type="checkbox" class="ai-scan__check" data-field="${f.key}" data-value="${escapeHtmlBasic(valStr)}" ${checked} ${isEmpty ? 'disabled' : ''} />
        <div class="ai-scan__label">${f.label}</div>
        <div class="ai-scan__value ${isEmpty ? 'empty' : ''}">${isEmpty ? '— rien trouvé —' : escapeHtmlBasic(valStr)}${f.current ? `<br><small style="color: var(--text-faint);">Actuel : ${escapeHtmlBasic(f.current)}</small>` : ''}</div>
      </div>`;
  }
  if (result.sources?.length) {
    html += `<div class="ai-scan__sources">Sources : ${result.sources.map(s => `<a href="${s}" target="_blank" rel="noopener">${new URL(s).hostname.replace('www.', '')}</a>`).join('')}</div>`;
  }
  body.innerHTML = html;
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'ai-scan-apply') {
    if (!lastAiProfile || !lastAiResult) return;
    const dlg = $('#ai-scan-dialog');
    const checks = dlg.querySelectorAll('.ai-scan__check:checked');
    const updates = {};
    for (const c of checks) {
      const f = c.dataset.field;
      const v = c.dataset.value;
      if (f === 'professions' || f === 'tags') {
        updates[f] = v.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        updates[f] = v;
      }
    }
    Object.assign(lastAiProfile, updates);
    await saveProfile(lastAiProfile);
    buildFilterChips();
    buildProfessionDatalist();
    render();
    if ($('#profile-dialog').open && STATE.current?.id === lastAiProfile.id) {
      openProfileDialog(lastAiProfile.id);
    }
    dlg.close();
    toast(`${Object.keys(updates).length} champ${Object.keys(updates).length > 1 ? 's' : ''} mis à jour depuis le scan IA.`, { type: 'ok' });
    maybeSchedulePush();
  }
});

// ============= STATS =============

function renderStats(filtered) {
  const bar = $('#statbar');
  if (!STATE.profiles.length) { bar.hidden = true; return; }
  bar.hidden = false;
  animateNumber($('#stat-total'), STATE.profiles.length);
  animateNumber($('#stat-shown'), filtered.length);
  // Compter UNIQUEMENT les professions du nouveau schéma (array). L'ancien
  // champ 'profession' (string) est nettoyé par la migration au boot.
  const pros = new Set();
  for (const p of STATE.profiles) {
    for (const pr of (p.professions || [])) if (pr) pros.add(pr);
    if (p.profession && (!p.professions || !p.professions.length)) pros.add(p.profession);
  }
  animateNumber($('#stat-pros'), pros.size);
  const fav = STATE.profiles.filter(p => p.status === 'favori').length;
  animateNumber($('#stat-fav'), fav);
  // Pluralization
  const setLabel = (id, count, singular, plural) => {
    const el = document.querySelector(`#${id} + .stat__label`);
    if (el) el.textContent = count > 1 ? plural : singular;
  };
  setLabel('stat-total', STATE.profiles.length, 'profil', 'profils');
  setLabel('stat-shown', filtered.length, 'affiché', 'affichés');
  setLabel('stat-pros', pros.size, 'métier', 'métiers');
  setLabel('stat-fav', fav, 'favori', 'favoris');
  const filtered_active = STATE.filters.profession !== 'all' || STATE.filters.status || STATE.filters.query;
  $('#stat-clear').hidden = !filtered_active;
}
function animateNumber(el, target) {
  if (!el) return;
  const cur = parseInt(el.textContent, 10);
  const from = Number.isFinite(cur) ? cur : 0;
  if (from === target) return; // pas de flicker quand rien n'a changé
  // Anim simple depuis from vers target (pas de double-write target/from qui flickait)
  const dur = 450;
  const steps = 18;
  const stepMs = dur / steps;
  let i = 0;
  const tick = () => {
    i++;
    const p = Math.min(1, i / steps);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(from + (target - from) * eased));
    if (p < 1) setTimeout(tick, stepMs);
    else el.textContent = String(target); // valeur exacte finale
  };
  setTimeout(tick, stepMs);
}

function resetFilters() {
  STATE.filters = { ...STATE.filters, profession: 'all', status: '', query: '', tag: '' };
  $('#search-input').value = '';
  $('#search-clear').hidden = true;
  setMeta('profession', 'all');
  buildFilterChips();
  buildStatusFilters();
  render();
}

function renderTagBar() {
  const bar = $('#tag-bar');
  if (STATE.filters.tag) {
    bar.hidden = false;
    $('#tag-bar-active').textContent = '#' + STATE.filters.tag;
  } else {
    bar.hidden = true;
  }
}

function setTagFilter(tag) {
  STATE.filters.tag = STATE.filters.tag === tag ? '' : tag;
  render();
}

// ============= QUICK ACTIONS =============

function handleQuickAction(profileId, action) {
  const p = STATE.profiles.find(x => x.id === profileId);
  if (!p) return;
  // tel: et mailto: → location.href pour rester dans l'app PWA standalone
  // (window.open ouvre une tab système même en PWA, ce qui sort de l'app).
  if (action === 'ig' && p.instagram)    window.open(`https://instagram.com/${p.instagram}`, '_blank', 'noopener');
  else if (action === 'phone' && p.phone) location.href = 'tel:' + p.phone.replace(/\s+/g, '');
  else if (action === 'mail' && p.email)  location.href = 'mailto:' + p.email;
  else if (action === 'edit')             openEditDialog(p);
}

// ============= CONTEXT MENU =============

function showContextMenu(profileId, x, y) {
  closeContextMenu();
  const p = STATE.profiles.find(x => x.id === profileId);
  if (!p) return;
  const m = $('#ctx-menu');
  const items = [
    { label: 'Ouvrir la fiche', action: 'open', kbd: '↵' },
    { label: 'Éditer', action: 'edit', kbd: 'E' },
  ];
  if (p.instagram) items.push({ label: 'Ouvrir Instagram ↗', action: 'ig' });
  if (p.email)     items.push({ label: 'Envoyer un e-mail', action: 'mail' });
  if (p.phone)     items.push({ label: 'Appeler', action: 'phone' });
  items.push({ separator: true });
  items.push({ label: p.status === 'favori' ? 'Retirer des favoris' : 'Marquer comme favori', action: 'fav' });
  items.push({ label: p.status === 'collabore' ? 'Retirer "Déjà collaboré"' : 'Marquer "Déjà collaboré"', action: 'collab' });
  items.push({ separator: true });
  items.push({ label: 'Copier l’e-mail', action: 'copy-email', disabled: !p.email });
  items.push({ label: 'Copier le téléphone', action: 'copy-phone', disabled: !p.phone });
  items.push({ label: 'Copier le handle Instagram', action: 'copy-ig', disabled: !p.instagram });
  items.push({ label: 'Dupliquer', action: 'duplicate' });
  items.push({ separator: true });
  items.push({ label: 'Supprimer', action: 'delete', danger: true });

  m.innerHTML = '';
  for (const it of items) {
    if (it.separator) {
      const hr = document.createElement('hr');
      hr.className = 'menu__sep';
      m.appendChild(hr);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'menu__item' + (it.danger ? ' menu__item--danger' : '');
    b.disabled = !!it.disabled;
    if (it.disabled) b.style.opacity = '.4';
    b.dataset.action = it.action;
    b.innerHTML = `<span>${it.label}</span>${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}`;
    m.appendChild(b);
  }
  m.hidden = false;
  // position smart : mesurer après reveal, flip si dépasse
  m.style.left = '0px'; m.style.top = '0px';
  const rect = m.getBoundingClientRect();
  const w = rect.width || 220;
  const h = rect.height || 320;
  let px = x;
  let py = y;
  if (px + w > window.innerWidth - 8) px = Math.max(8, x - w);
  if (py + h > window.innerHeight - 8) py = Math.max(8, y - h);
  m.style.left = px + 'px';
  m.style.top = py + 'px';
  m.style.right = 'auto';
  setTimeout(() => m.classList.add('is-open'), 16);

  m.onclick = async (e) => {
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (!act) return;
    closeContextMenu();
    if (act === 'open') openProfileDialog(p.id);
    else if (act === 'edit') openEditDialog(p);
    else if (act === 'ig')   window.open(`https://instagram.com/${p.instagram}`, '_blank', 'noopener');
    else if (act === 'mail') location.href = 'mailto:' + p.email;
    else if (act === 'phone')location.href = 'tel:' + p.phone.replace(/\s+/g, '');
    else if (act === 'fav') {
      p.status = p.status === 'favori' ? '' : 'favori';
      await saveProfile(p);
      render();
      toast(p.status === 'favori' ? 'Ajouté aux favoris.' : 'Retiré des favoris.', { type: 'ok' });
    }
    else if (act === 'collab') {
      p.status = p.status === 'collabore' ? '' : 'collabore';
      await saveProfile(p);
      render();
      toast(p.status === 'collabore' ? 'Marqué "Déjà collaboré".' : 'Statut retiré.', { type: 'ok' });
    }
    else if (act === 'copy-email') {
      const ok = await safeCopy(p.email);
      toast(ok ? 'E-mail copié.' : 'Copie échouée.', { type: ok ? 'ok' : 'err' });
    }
    else if (act === 'copy-phone') {
      const ok = await safeCopy(p.phone);
      toast(ok ? 'Téléphone copié.' : 'Copie échouée.', { type: ok ? 'ok' : 'err' });
    }
    else if (act === 'copy-ig') {
      const ok = await safeCopy('@' + p.instagram);
      toast(ok ? 'Handle copié.' : 'Copie échouée.', { type: ok ? 'ok' : 'err' });
    }
    else if (act === 'duplicate') duplicateProfile(p);
    else if (act === 'delete') confirmDelete(p);
  };
}
function closeContextMenu() {
  const m = $('#ctx-menu');
  if (!m.classList.contains('is-open')) return;
  m.classList.remove('is-open');
  setTimeout(() => { m.hidden = true; }, 180);
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctx-menu')) closeContextMenu();
});
window.addEventListener('scroll', closeContextMenu, true);

// ============= PASTE IMAGE =============

async function onPaste(e) {
  const items = Array.from(e.clipboardData?.items || []);
  const imgItem = items.find(it => it.type.startsWith('image/'));
  if (!imgItem) return;
  // Si on est dans un input texte mais pas dans la dropzone, ignore
  const inEdit = $('#edit-dialog').open;
  const inProfile = $('#profile-dialog').open;
  if (!inEdit && !inProfile && isTypingContext()) return;

  const file = imgItem.getAsFile();
  if (!file) return;
  e.preventDefault();

  // si la modal d'édition est ouverte → ajoute aux fichiers en attente
  if (inEdit) {
    pendingFiles.push(file);
    refreshDropzonePreview();
    toast('Image collée. Enregistrez pour l’ajouter au profil.', { type: 'ok' });
    return;
  }
  // si la modal détail est ouverte → ajoute au profil courant
  if (inProfile && STATE.current) {
    await addImagesToProfile(STATE.current, [file]);
    const imgs = await getProfileImages(STATE.current.id);
    STATE.imagesByProfile.set(STATE.current.id, imgs);
    openProfileDialog(STATE.current.id);
    render();
    toast('Image ajoutée au profil.', { type: 'ok' });
    return;
  }
  toast('Pour coller une image, ouvrez d’abord un profil ou son éditeur.', { type: 'warn' });
}

function refreshDropzonePreview() {
  const list = $('#dropzone-list');
  if (!pendingFiles.length) { list.hidden = true; list.innerHTML = ''; return; }
  list.hidden = false;
  list.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'dropzone__item';
    const url = URL.createObjectURL(f);
    item.style.backgroundImage = `url("${url}")`;
    const rm = document.createElement('button');
    rm.className = 'dropzone__rm';
    rm.title = 'Retirer';
    rm.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      URL.revokeObjectURL(url);
      pendingFiles.splice(i, 1);
      refreshDropzonePreview();
    });
    item.appendChild(rm);
    list.appendChild(item);
  });
}
