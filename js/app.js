// Orchestrateur principal du Trombinoscope
import {
  getAllProfiles, saveProfile, patchProfile, deleteProfile, bulkSaveProfiles,
  saveImage, getProfileImages, deleteImage, deleteProfileImages,
  exportAll, importAll, getMeta, setMeta, estimateUsage, uid,
  cleanupOrphanImages, clearAllProfilesAndImages, clearAllPending, sameValue,
} from './store.js';
import { SEED_PROFILES, PROFESSIONS, STATUSES } from './seed.js';
import {
  $, $$, debounce, downscaleImage, fmtBytes, fuzzyMatch, normalizeForSearch,
  parseInstagramHandle, guessNameFromHandle, isTypingContext,
  objectURLFor, revokeObjectURL,
} from './utils.js';
import {
  renderCard, renderRow, renderProfileDetail, applyAvatar,
  toast, confirmDialog,
} from './ui.js';
import { fetchInstagramProfilePic, resetMicrolinkRateLimit } from './ig.js';
import { ensureAuthGate, getSpaceId, migrateLegacyUnlock, lock as lockDevice } from './auth.js';
import {
  getAiKey, setAiKey, getAiModel, setAiModel,
  isAiConfigured, scanProfileWithAi, testAiConnection,
} from './ai.js';
import { applyEnrichmentIfNew } from './enrichment.js';

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
  // ===== THÈME ADAPTATIF (suit le système par défaut) =====
  // Migration one-shot : on efface l'ancien thème forcé pour repasser en "auto"
  // (l'utilisateur peut toujours forcer clair/sombre via le menu ensuite).
  if (!(await getMeta('theme_adaptive_v1'))) {
    await setMeta('theme', null);
    await setMeta('theme_adaptive_v1', true);
  }
  const savedTheme = await getMeta('theme'); // null = mode auto (suit le système)
  const systemDark = !matchMedia('(prefers-color-scheme: light)').matches;
  document.body.dataset.theme = savedTheme || (systemDark ? 'dark' : 'light');
  // Suivre les changements système en direct TANT QUE l'utilisateur n'a pas forcé.
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async (e) => {
      if (await getMeta('theme')) return; // override manuel actif → ne pas toucher
      document.body.dataset.theme = e.matches ? 'dark' : 'light';
    });
  } catch {}
  STATE.view = await getMeta('view') || 'grid';
  STATE.filters.sort = await getMeta('sort') || 'favoris';
  STATE.filters.profession = await getMeta('profession') || 'all';

  // Ancien système de synchronisation : un appareil déjà déverrouillé rejoint
  // l'espace partagé sans ressaisir le mot de passe ; ses vieilles clés sont purgées.
  await migrateLegacyUnlock();

  // Nettoyage des images orphelines (profileId qui n'existe plus) AVANT que la
  // synchronisation ne démarre, pour ne jamais envoyer une photo fantôme.
  await cleanupOrphanImages().catch(() => {});

  STATE.profiles = await getAllProfiles();

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

  // File de scan photos IG : reprise auto au boot puis toutes les 10 min
  // (couvre le retour de quota des services de récupération).
  setTimeout(() => processIgPics().catch(() => {}), 12_000);
  setInterval(() => processIgPics().catch(() => {}), 10 * 60_000);

  // Synchronisation temps réel (porte mot de passe si l'appareil est nouveau).
  updateSyncUi();
  startSync();

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

// ============= SYNCHRONISATION TEMPS RÉEL =============

let RT = null;            // module realtime.js (chargé dynamiquement : l'app
                          // reste utilisable hors-ligne même si le SDK ne charge pas)
let syncNote = '';        // raison pour laquelle la sync n'est pas active

async function startSync() {
  let spaceId = await getSpaceId();
  if (!spaceId) {
    const r = await ensureAuthGate({
      onUnlocked: () => toast('✓ Accès déverrouillé — connexion à l\'espace partagé…', { type: 'ok', timeout: 3500 }),
    }).catch(() => null);
    spaceId = r?.spaceId || await getSpaceId();
    if (!spaceId) return;
  }
  try {
    RT = await import('./realtime.js');
  } catch (e) {
    console.warn('[Sync] module temps réel indisponible :', e.message);
    syncNote = 'Hors ligne au premier chargement — la synchronisation démarrera au prochain lancement connecté.';
    updateSyncUi();
    return;
  }
  const cfg = await RT.loadRealtimeConfig();
  if (!RT.isConfigured(cfg)) {
    syncNote = 'Espace temps réel non configuré sur ce site (js/firebase-config.js).';
    updateSyncUi();
    return;
  }
  RT.onRealtimeStatus(updateSyncUi);
  try {
    await RT.startRealtime({ spaceId, onChange: ({ ids }) => refreshFromLocal(ids) });
  } catch (e) {
    console.warn('[Sync] démarrage échoué :', e.message);
    syncNote = 'Démarrage de la synchronisation échoué : ' + e.message;
    updateSyncUi();
  }
}

let __detailRefreshPending = null;
/**
 * Recharge l'état depuis le miroir local (après des changements venus d'un
 * autre appareil) et redessine. `ids` = profils touchés (tous si absent).
 */
async function refreshFromLocal(ids) {
  STATE.profiles = await getAllProfiles();
  const known = new Set(STATE.profiles.map(p => p.id));
  const wanted = ids && ids.size ? [...ids] : [...known];
  for (const id of wanted) {
    if (!known.has(id)) { STATE.imagesByProfile.delete(id); continue; }
    const imgs = await getProfileImages(id);
    if (imgs.length) STATE.imagesByProfile.set(id, imgs); else STATE.imagesByProfile.delete(id);
  }
  for (const id of [...STATE.imagesByProfile.keys()]) if (!known.has(id)) STATE.imagesByProfile.delete(id);

  if (STATE.current) {
    const fresh = STATE.profiles.find(p => p.id === STATE.current.id);
    const dlg = $('#profile-dialog');
    if (!fresh) {
      if (dlg?.open) { dlg.close(); toast('Ce profil vient d\'être supprimé depuis un autre appareil.', { type: 'info', timeout: 4000 }); }
      STATE.current = null;
    } else {
      Object.assign(STATE.current, fresh);
      if (dlg?.open && (!ids || ids.has(fresh.id))) scheduleDetailRefresh(fresh.id);
    }
  }
  buildFilterChips();
  buildProfessionDatalist();
  render();
  window.__updateIgBulkCount?.();
}

/** Redessine la fiche ouverte, mais jamais pendant que l'on y tape (notes…). */
function scheduleDetailRefresh(id) {
  const dlg = $('#profile-dialog');
  const typing = dlg?.open && isTypingContext() && dlg.contains(document.activeElement);
  if (!typing) { if (STATE.current?.id === id) openProfileDialog(id); return; }
  if (__detailRefreshPending) return;
  __detailRefreshPending = id;
  document.activeElement.addEventListener('blur', () => {
    const pid = __detailRefreshPending; __detailRefreshPending = null;
    if (pid && STATE.current?.id === pid && $('#profile-dialog').open) openProfileDialog(pid);
  }, { once: true });
}

/** Met à jour STATE après une écriture locale (patchProfile renvoie le profil frais). */
function applySaved(saved) {
  if (!saved) return;
  const i = STATE.profiles.findIndex(p => p.id === saved.id);
  if (i >= 0) Object.assign(STATE.profiles[i], saved); else STATE.profiles.push(saved);
  if (STATE.current && STATE.current.id === saved.id && STATE.current !== STATE.profiles[i]) Object.assign(STATE.current, saved);
}

/** Bouton « Rafraîchir » / scan IG : relecture complète depuis le serveur. */
async function resyncAndRefresh({ quiet = false } = {}) {
  if (!RT) { if (!quiet) toast('Synchronisation non active sur cet appareil.', { type: 'warn' }); return null; }
  const r = await RT.resyncRealtime().catch((e) => ({ ok: false, error: e.message }));
  await refreshFromLocal();
  if (!quiet) {
    if (r?.ok) toast(`↻ À jour : ${r.remoteCount} profils sur l'espace partagé.`, { type: 'ok', timeout: 3000 });
    else toast('Relecture impossible : ' + (r?.error || 'hors ligne'), { type: 'warn', timeout: 4000 });
  }
  return r;
}

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

// Recompte direct (O(n), négligeable pour des centaines de profils).
// PAS de mémoïsation : elle causait un bug où ajouter un métier à un profil
// non-dernier n'apparaissait pas dans les chips (la clé de cache length+
// lastUpdatedAt ne changeait pas).
function professionCounts() {
  const c = {};
  for (const p of STATE.profiles) {
    for (const pro of profileProfessions(p)) {
      if (pro) c[pro] = (c[pro] || 0) + 1;
    }
  }
  return c;
}

function profileProfessions(p) {
  return p.professions || (p.profession ? [p.profession] : []);
}

// ============= UI HOOKS =============

function hookUI() {
  // Verrou de scroll de fond : pose .modal-open sur <html> dès qu'un <dialog>
  // est ouvert (filet de sécurité en plus de la règle CSS :has). Empêche le
  // geste tactile de scroller la page derrière la fiche profil / les modales.
  try {
    const applyModalLock = () => {
      const anyOpen = !!document.querySelector('dialog[open]');
      document.documentElement.classList.toggle('modal-open', anyOpen);
    };
    new MutationObserver(applyModalLock).observe(document.body, {
      attributes: true, attributeFilter: ['open'], subtree: true,
    });
    applyModalLock();
  } catch {}

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
  // Entrée dans la recherche : si un métier correspond, on y va directement.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = matchProfessions(input.value)[0];
    if (!first) return;
    e.preventDefault();
    showProfession(first.pro);
    input.blur();
  });
  $('#pro-suggest')?.addEventListener('click', (e) => {
    const b = e.target.closest('.pro-suggest__chip');
    if (b) showProfession(b.dataset.profession);
  });

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
    if (a === 'bulk-ig-photos' || a === 'bulk-ig-fast') return fetchMissingProfilePics({ manual: true });
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

  // bouton « Synchronisé » — tout est automatique ; un clic force l'envoi
  // de ce qui attend et relit l'espace partagé.
  $('#save-btn').addEventListener('click', onSaveButtonClick);

  // bouton « ↻ Rafraîchir » — relecture complète depuis l'espace partagé
  $('#refresh-btn')?.addEventListener('click', async () => {
    const btn = $('#refresh-btn');
    btn.classList.add('is-spinning');
    try { await resyncAndRefresh(); }
    finally { btn.classList.remove('is-spinning'); }
  });

  // bouton « Photos Instagram » — relit l'espace partagé (le robot y dépose
  // les photos) puis tente depuis cet appareil ce qui manque encore.
  const igBulkBtn = $('#ig-bulk-btn');
  igBulkBtn.addEventListener('click', () => onIgBulkClick());
  // Mettre à jour le badge avec le nombre de profils sans photo
  const updateIgBulkCount = () => {
    const without = profilesWithoutPic().length;
    const countEl = $('#ig-bulk-count');
    if (countEl) countEl.textContent = without > 0 ? String(without) : '';
    igBulkBtn.title = without === 0
      ? 'Tous les profils Instagram ont leur photo — clic pour vérifier quand même.'
      : `${without} profil${without > 1 ? 's' : ''} Instagram sans photo — clic pour les récupérer`;
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
  renderProSuggest();

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
      applySaved(await patchProfile(profile.id, { status: st }));
      render();
    },
    onNotesChange: async (notes) => {
      applySaved(await patchProfile(profile.id, { notes }));
    },
    onProjectsChange: async (projects) => {
      applySaved(await patchProfile(profile.id, { projects }));
    },
    onUploadImages: async (files) => {
      await addImagesToProfile(profile, files);
      const imgs = await getProfileImages(profile.id);
      STATE.imagesByProfile.set(profile.id, imgs);
      openProfileDialog(profile.id);
      render();
    },
    onFetchIg: async () => {
      await refetchProfilePic(profile);
    },
    onProfession: (pro) => {
      dlg.close();
      showProfession(pro);
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

  const wasOpen = dlg.open;
  if (!wasOpen) dlg.showModal();
  // Toujours (ré)ouvrir la fiche EN HAUT : showModal() donne le focus au 1er
  // élément et le navigateur y défilait (fiche ouverte à ~mi-hauteur). On force
  // aussi le reset après un re-render (upload/suppression d'image, nav ◀▶).
  inner.scrollTop = 0;
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
  toast('Profil supprimé.', { type: 'ok' });
}

// ============= EDIT FORM =============

let pendingFiles = []; // images en attente avant save
let editBase = null;   // copie du profil à l'ouverture : seuls les champs que
                       // l'utilisateur change sont enregistrés (fusion fine)

function openEditDialog(profile = null) {
  const dlg = $('#edit-dialog');
  const form = $('#edit-form');
  form.reset();
  pendingFiles = [];
  editBase = profile ? JSON.parse(JSON.stringify(profile)) : null;
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
    const oldHandle = existing?.instagram || '';
    const values = {
      name: data.name.trim(),
      professions,
      status: data.status || '',
      instagram: parseInstagramHandle(data.instagram),
      phone: (data.phone || '').trim(),
      email: (data.email || '').trim(),
      website: (data.website || '').trim(),
      location: (data.location || '').trim(),
      rate: (data.rate || '').trim(),
      agency: (data.agency || '').trim(),
      lastContact: data.lastContact || '',
      tags: (data.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      projects: data.projects || '',
      notes: data.notes || '',
    };
    let profile;
    if (existing) {
      // N'enregistrer QUE ce que l'utilisateur a changé depuis l'ouverture du
      // formulaire : une modification faite entre-temps sur un autre appareil
      // (autre champ) n'est pas écrasée.
      const base = editBase && editBase.id === id ? editBase : existing;
      const patch = {};
      for (const [k, v] of Object.entries(values)) if (!sameValue(v, base[k])) patch[k] = v;
      if (existing.profession !== undefined) patch.profession = ''; // ancien champ
      profile = Object.keys(patch).length ? (await patchProfile(id, patch)) || existing : existing;
      applySaved(profile);
      profile = STATE.profiles.find(p => p.id === id) || profile;
    } else {
      profile = { id, ...values };
      await saveProfile(profile);
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
    if ($('#profile-dialog').open && STATE.current?.id === profile.id) openProfileDialog(profile.id);
    toast(existing ? 'Profil mis à jour.' : 'Profil créé.', { type: 'ok' });

    // SCAN PHOTOS AUTO : nouveau profil avec IG → en file immédiatement.
    // Handle CORRIGÉ sur un profil existant (cas « mauvais insta ») → on purge
    // les anciennes photos (celles du mauvais compte) et on re-scanne.
    if (!existing && profile.instagram) {
      requestIgPic(profile.id);
    } else if (existing && profile.instagram && profile.instagram !== oldHandle) {
      await deleteProfileImages(profile.id);
      STATE.imagesByProfile.delete(profile.id);
      render();
      requestIgPic(profile.id);
      toast(`Handle corrigé → anciennes photos (mauvais compte) retirées ; la photo du bon compte est recherchée.`, { type: 'info', timeout: 6000 });
    }
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

// ============= PHOTO DE PROFIL INSTAGRAM (automatique) =============
// Objectif : toute fiche avec un handle Instagram est illustrée par la photo
// de profil de ce compte, sans rien faire. Règle simple et partagée : « un
// profil avec handle et sans photo » = à récupérer. Chaque appareil essaie
// avec sa propre IP (relais publics à quota journalier), le robot cloud
// (session Instagram) complète ; la photo obtenue se synchronise partout, et
// les autres appareils arrêtent d'essayer puisqu'elle est là.
const IG_TRIES_KEY = 'ig_pic_tries';   // par appareil : { profileId: { n, nextAt } }
const IG_PAUSE_KEY = 'ig_pic_pause_until';
let igRunning = false;

function profilesWithoutPic() {
  return STATE.profiles.filter(p => p.instagram && !STATE.imagesByProfile.get(p.id)?.length);
}

/** Récupère et enregistre la photo de profil d'une fiche. */
async function fetchProfilePicFor(profile) {
  const { blob: raw, source } = await fetchInstagramProfilePic(profile.instagram);
  const blob = await downscaleImage(raw, { maxDim: 1080, quality: 0.82 }).catch(() => raw);
  await deleteProfileImages(profile.id);
  await saveImage(profile.id, 0, blob);
  STATE.imagesByProfile.set(profile.id, await getProfileImages(profile.id));
  return source;
}

/** Un nouveau profil (ou un handle corrigé) : on tente tout de suite. */
function requestIgPic(profileId) {
  getMeta(IG_TRIES_KEY).then(async (tries) => {
    const t = tries || {};
    delete t[profileId];
    await setMeta(IG_TRIES_KEY, t);
    processIgPics().catch(() => {});
  }).catch(() => {});
}

async function igQueueCount() {
  return profilesWithoutPic().length;
}

/**
 * Passe sur les profils sans photo (les plus récents d'abord), dans la limite
 * des quotas. Rejoué au démarrage, toutes les 10 min, et à chaque création.
 */
async function processIgPics({ manual = false, onProgress } = {}) {
  if (igRunning) return { skipped: true };
  igRunning = true;
  const result = { done: 0, ok: 0, rateLimited: false, errors: [] };
  try {
    const now = Date.now();
    if (!manual && now < ((await getMeta(IG_PAUSE_KEY)) || 0)) return result;
    const tries = (await getMeta(IG_TRIES_KEY)) || {};
    const targets = profilesWithoutPic()
      .filter(p => manual || !tries[p.id] || (tries[p.id].nextAt || 0) <= now)
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
      .slice(0, manual ? 200 : 12);
    for (const p of targets) {
      if (!STATE.profiles.includes(p) || STATE.imagesByProfile.get(p.id)?.length) continue; // arrivée entre-temps (autre appareil / robot)
      const card = document.querySelector(`.card[data-id="${p.id}"]`);
      card?.classList.add('is-importing');
      try {
        await fetchProfilePicFor(p);
        delete tries[p.id];
        result.ok++;
        render();
      } catch (e) {
        if (e?.code === 'RATE_LIMITED') {
          result.rateLimited = true;
          await setMeta(IG_PAUSE_KEY, Date.now() + 3 * 3600 * 1000);
          card?.classList.remove('is-importing');
          break;
        }
        const n = ((tries[p.id] && tries[p.id].n) || 0) + 1;
        // Compte privé, inexistant ou relais capricieux : on réessaie de moins
        // en moins souvent (30 min → 24 h), sans jamais abandonner tout à fait.
        tries[p.id] = { n, nextAt: Date.now() + Math.min(24 * 3600, 1800 * 2 ** Math.min(n, 6)) * 1000 };
        result.errors.push(`@${p.instagram} : ${e.message}`);
      } finally {
        card?.classList.remove('is-importing');
      }
      result.done++;
      onProgress?.(result, targets.length);
      await new Promise(r => setTimeout(r, 400));
    }
    await setMeta(IG_TRIES_KEY, tries);
    window.__updateIgBulkCount?.();
  } finally {
    igRunning = false;
  }
  return result;
}

/** Bouton / menu : relit l'espace partagé puis tente ce qui manque, avec retour visible. */
async function fetchMissingProfilePics({ manual = true } = {}) {
  const before = profilesWithoutPic().length;
  const t = toast('Vérification des photos sur l\'espace partagé…', { type: 'info', timeout: 0 });
  await resyncAndRefresh({ quiet: true });
  t.dismiss();
  const missing = profilesWithoutPic().length;
  if (missing === 0) {
    toast(before > missing ? `✓ ${before - missing} photo(s) récupérée(s) de l\'espace partagé — tous les profils ont leur photo.` : '✓ Tous les profils Instagram ont déjà leur photo.', { type: 'ok', timeout: 5000 });
    return;
  }
  if (igRunning) { toast('Récupération déjà en cours…', { type: 'info' }); return; }
  $('#ig-bulk-btn')?.classList.add('is-running');
  let progress = toast(`Photos Instagram : 0 / ${missing}…`, { type: 'info', timeout: 0 });
  const r = await processIgPics({
    manual,
    onProgress: (res, total) => { progress.dismiss(); progress = toast(`Photos Instagram : ${res.done} / ${total} (${res.ok} trouvée${res.ok > 1 ? 's' : ''})`, { type: 'info', timeout: 0 }); },
  });
  progress.dismiss();
  $('#ig-bulk-btn')?.classList.remove('is-running');
  render();
  if (r.rateLimited) {
    toast(`Quota des relais Instagram atteint pour aujourd\'hui depuis cet appareil (${r.ok} photo${r.ok > 1 ? 's' : ''} récupérée${r.ok > 1 ? 's' : ''}). Reprise automatique plus tard ; le robot cloud complète aussi. Astuce : une clé Microlink gratuite dans Réglages augmente le quota.`, { type: 'warn', timeout: 10000, action: { label: 'Réglages', onClick: () => openSettingsDialog() } });
  } else if (r.ok) {
    toast(`✓ ${r.ok} photo${r.ok > 1 ? 's' : ''} de profil récupérée${r.ok > 1 ? 's' : ''}${r.errors.length ? ` — ${r.errors.length} compte(s) introuvable(s) ou privé(s)` : ''}.`, { type: 'ok', timeout: 7000 });
  } else {
    toast(`Aucune photo trouvée (${r.errors.length} compte(s) privés, introuvables ou relais indisponibles). Le robot cloud réessaie toutes les 3 h.`, { type: 'warn', timeout: 8000 });
    if (r.errors.length) console.log('[IG]', r.errors);
  }
}

async function onIgBulkClick() { return fetchMissingProfilePics({ manual: true }); }

/** Fiche ouverte → « Re-scanner Instagram » : remplace la photo par celle du handle actuel. */
async function refetchProfilePic(profile) {
  if (!profile.instagram) { toast('Ce profil n\'a pas de handle Instagram.', { type: 'warn' }); return; }
  const t = toast(`@${profile.instagram} : recherche de la photo de profil…`, { type: 'info', timeout: 0 });
  try {
    const source = await fetchProfilePicFor(profile);
    t.dismiss();
    if ($('#profile-dialog').open && STATE.current?.id === profile.id) openProfileDialog(profile.id);
    render();
    toast(`✓ Photo de profil de @${profile.instagram} mise à jour (${source}).`, { type: 'ok', timeout: 4000 });
  } catch (e) {
    t.dismiss();
    if (e?.code === 'RATE_LIMITED') {
      toast(`Quota des relais atteint depuis cet appareil — réessai automatique plus tard (ou via le robot cloud). Tu peux aussi glisser une photo directement sur la fiche.`, { type: 'warn', timeout: 8000 });
    } else {
      toast(`@${profile.instagram} : photo introuvable (${e.message}). Compte privé ou inexistant ? Tu peux glisser une photo sur la fiche.`, { type: 'warn', timeout: 8000 });
    }
  }
}

if (typeof window !== 'undefined') {
  window.__fetchMissingProfilePics = fetchMissingProfilePics;
  window.__igProgress = () => ({ running: igRunning, withoutPic: profilesWithoutPic().length, total: STATE.profiles.length });
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
        professions: profession ? [profession] : [],
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
      if (newProfiles.some(np => np.instagram)) processIgPics().catch(() => {});
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
      await refreshFromLocal();
      toast('Import terminé — les profils se synchronisent sur tous les appareils.', { type: 'ok', timeout: 4000 });
    } catch (err) {
      console.error(err);
      toast('Import impossible (fichier invalide).', { type: 'err' });
    }
  });
  input.click();
}

async function doDiagnoseSync() {
  const t = toast('Diagnostic en cours…', { type: 'info', timeout: 0 });
  let localImages = 0;
  for (const imgs of STATE.imagesByProfile.values()) localImages += imgs.length;
  const lines = [];
  if (!RT) {
    lines.push('Synchronisation : inactive sur cet appareil');
    if (syncNote) lines.push(syncNote);
    lines.push(`Profils locaux : ${STATE.profiles.length} — images : ${localImages}`);
  } else {
    const r = await RT.realtimeDiagnose();
    const etat = { synced: 'connecté, tout est à jour', saving: 'connecté, envoi en cours', connecting: 'connexion…', offline: 'hors ligne', error: 'erreur', off: 'inactive' }[r.state] || r.state;
    lines.push(`Synchronisation : ${etat}${r.error ? ' (' + r.error + ')' : ''}`);
    lines.push(`Espace partagé : ${r.space || '?'} — projet ${r.projectId || '?'}`);
    lines.push(`Profils sur l'espace : ${r.remoteProfiles} — local : ${r.localProfiles} (images locales : ${localImages})`);
    lines.push(`Modifications en attente d'envoi : ${r.pending}`);
    lines.push(r.roundTripMs != null ? `Aller-retour serveur : ${r.roundTripMs} ms` : `Aller-retour serveur : échec (${r.roundTripError || '?'})`);
    console.log('[Diagnostic sync]', r);
  }
  lines.push(`Version de l'app : ${document.getElementById('app-version')?.textContent || '?'}`);
  t.dismiss();
  window.prompt('Diagnostic synchronisation (Cmd+C pour copier) :', lines.join('\n'));
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
      professions: s.professions || (s.profession ? [s.profession] : []),
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
    title: 'Réinitialiser cet appareil ?',
    text: 'Efface les données stockées sur CET appareil puis les recharge depuis l\'espace partagé. Les données partagées ne sont pas supprimées (utilisez la suppression profil par profil pour ça).',
    okLabel: 'Réinitialiser',
  });
  if (!ok) return;
  // Réinitialisation LOCALE uniquement : on vide le journal d'envoi AVANT de
  // vider les données, pour qu'aucune suppression ne parte vers le serveur.
  await clearAllPending();
  await setMeta(IG_TRIES_KEY, {});
  await clearAllProfilesAndImages();
  STATE.profiles = [];
  STATE.imagesByProfile.clear();
  buildFilterChips();
  render();
  toast('Appareil réinitialisé — rechargement depuis l\'espace partagé…', { type: 'info', timeout: 3000 });
  if (RT) await resyncAndRefresh({ quiet: true });
  else location.reload();
  render();
  window.__updateIgBulkCount?.();
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
      const next = STATE.current.status === 'favori' ? '' : 'favori';
      patchProfile(STATE.current.id, { status: next }).then((saved) => {
        applySaved(saved);
        openProfileDialog(STATE.current.id);
        render();
        toast(next === 'favori' ? '⭐ Ajouté aux favoris' : 'Retiré des favoris', { type: 'ok' });
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

// ============= SYNC : INDICATEURS =============

const SYNC_LABELS = {
  off:        { pill: null,         pillCls: 'off',     btn: 'is-unconfigured', label: 'Déverrouiller', title: 'Entre le mot de passe pour rejoindre l\'espace partagé.' },
  connecting: { pill: 'Connexion…', pillCls: 'syncing', btn: 'is-syncing',      label: 'Connexion…',    title: 'Connexion à l\'espace partagé…' },
  offline:    { pill: 'Hors ligne', pillCls: 'err',     btn: 'is-dirty',        label: 'Hors ligne',    title: 'Hors ligne — les modifications partiront automatiquement au retour du réseau.' },
  saving:     { pill: 'Sync ↑',     pillCls: 'syncing', btn: 'is-syncing',      label: 'Enregistrement…', title: 'Envoi des modifications…' },
  synced:     { pill: 'Sync',       pillCls: 'ok',      btn: 'is-saved',        label: 'Synchronisé',   title: 'Tout est synchronisé en temps réel sur tous les appareils.' },
  error:      { pill: 'Sync ✗',     pillCls: 'err',     btn: 'is-error',        label: 'Erreur',        title: 'Erreur de synchronisation' },
};

/** Reflète l'état de la synchronisation sur la pastille et le bouton de la barre. */
function updateSyncUi(status) {
  const s = status || (RT ? RT.getRealtimeStatus() : { state: 'off' });
  const d = SYNC_LABELS[s.state] || SYNC_LABELS.off;
  const pill = $('#sync-pill');
  if (pill) {
    pill.className = 'sync-pill ' + d.pillCls;
    pill.textContent = d.pill || '';
    pill.title = d.title;
  }
  const btn = $('#save-btn');
  if (!btn) return;
  btn.hidden = false;
  btn.classList.remove('is-dirty', 'is-syncing', 'is-error', 'is-saved', 'is-unconfigured');
  btn.classList.add(d.btn);
  const label = btn.querySelector('.savebtn__label');
  let text = d.label;
  let title = d.title;
  if (s.state === 'off' && syncNote) { text = 'Hors sync'; title = syncNote; }
  if (s.state === 'connecting' && s.pending) {
    // Serveur injoignable (réseau coupé sans que le navigateur le sache) :
    // on montre ce qui attend plutôt qu'un « Connexion… » muet.
    btn.classList.remove('is-syncing'); btn.classList.add('is-dirty');
    text = 'En attente'; title = `Serveur injoignable — ${s.pending} modification(s) partiront dès que la connexion revient.`;
  }
  if ((s.state === 'offline' || s.state === 'saving' || s.state === 'connecting') && s.pending) text += ` (${s.pending})`;
  if (s.state === 'error') title += ' : ' + humanSyncError(s.error);
  if (label) label.textContent = text;
  btn.title = title;
}

function humanSyncError(code) {
  if (!code) return 'inconnue';
  if (code === 'permission' || /permission-denied/.test(code)) return 'accès refusé par le serveur (règles Firestore à vérifier)';
  if (/operation-not-allowed/.test(code)) return 'connexion anonyme désactivée sur le projet Firebase';
  if (/api-key|app-not-authorized/.test(code)) return 'configuration Firebase invalide';
  if (/unavailable|network/.test(code)) return 'serveur injoignable';
  return code;
}

async function onSaveButtonClick() {
  const btn = $('#save-btn');
  if (!RT) { startSync(); return; }
  btn.classList.add('is-syncing');
  try {
    const s = await RT.flushRealtime();
    if (s.state === 'synced') {
      await resyncAndRefresh({ quiet: true });
      toast('✓ Tout est synchronisé sur tous les appareils.', { type: 'ok', timeout: 3000 });
    } else if (s.state === 'offline') {
      toast(`Hors ligne — ${s.pending || 0} modification(s) partiront automatiquement au retour du réseau.`, { type: 'info', timeout: 5000 });
    } else if (s.state === 'error') {
      toast('Synchronisation en erreur : ' + humanSyncError(s.error), { type: 'err', timeout: 7000 });
    } else {
      toast(`Envoi en cours… ${s.pending || 0} modification(s) restante(s).`, { type: 'info', timeout: 4000 });
    }
  } finally {
    updateSyncUi();
  }
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

  // SYNCHRONISATION (automatique — zéro configuration)
  $('#cloud-sync-now').addEventListener('click', async () => {
    const out = $('#cloud-sync-result');
    out.textContent = 'Synchronisation…';
    out.className = 'settings__small';
    if (!RT) {
      out.textContent = syncNote || 'Appareil verrouillé — entre le mot de passe pour rejoindre l\'espace partagé.';
      out.className = 'settings__small err';
      if (!syncNote) { $('#settings-dialog').close(); startSync(); }
      return;
    }
    try {
      const s = await RT.flushRealtime();
      await resyncAndRefresh({ quiet: true });
      out.textContent = s.state === 'synced' ? '✓ Tout est synchronisé.' : `État : ${s.state}${s.pending ? ` — ${s.pending} en attente` : ''}${s.error ? ' — ' + humanSyncError(s.error) : ''}`;
      out.className = 'settings__small ' + (s.state === 'synced' ? 'ok' : 'err');
      refreshSettingsView();
    } catch (e) {
      out.textContent = '✗ ' + e.message;
      out.className = 'settings__small err';
    }
  });

  $('#cloud-diagnose-btn').addEventListener('click', () => doDiagnoseSync());

  // Identifiant de l'espace (secret dérivé du mot de passe) : à mettre dans le
  // secret GitHub TROMBI_SPACE_ID pour que le robot photos écrive dans l'espace.
  $('#cloud-copy-space')?.addEventListener('click', async () => {
    const id = await getSpaceId();
    if (!id) { toast('Appareil verrouillé — entre d\'abord le mot de passe.', { type: 'warn' }); return; }
    const ok = await safeCopy(id);
    toast(ok ? 'Identifiant copié. Colle-le dans le secret GitHub « TROMBI_SPACE_ID » (dépôt → Settings → Secrets → Actions).' : 'Copie impossible — ouvre le Diagnostic pour le lire.', { type: ok ? 'ok' : 'warn', timeout: 7000 });
  });

  $('#cloud-lock-btn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Verrouiller cet appareil ?',
      text: 'Il faudra ressaisir le mot de passe pour retrouver l\'espace partagé. Les données locales sont conservées.',
      okLabel: 'Verrouiller',
    });
    if (!ok) return;
    await lockDevice();
    location.reload();
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

  // Synchronisation (statut)
  const st = RT ? RT.getRealtimeStatus() : { state: 'off' };
  const badge = $('#cloud-status-badge');
  const badgeText = { synced: 'Connecté', saving: 'Envoi…', connecting: 'Connexion…', offline: 'Hors ligne', error: 'Erreur', off: (await getSpaceId()) ? 'Inactif' : 'Verrouillé' };
  badge.textContent = badgeText[st.state] || st.state;
  badge.classList.toggle('ok', st.state === 'synced');
  const igPending = await igQueueCount();
  const info = [];
  if (st.state === 'off') info.push(syncNote || 'Entre le mot de passe pour rejoindre l\'espace partagé.');
  else if (st.state === 'error') info.push('Erreur : ' + humanSyncError(st.error));
  else info.push(st.pending ? `${st.pending} modification(s) en attente d'envoi.` : 'Toutes les modifications sont synchronisées.');
  if (igPending) info.push(`Photos Instagram en file : ${igPending}`);
  $('#cloud-last-info').textContent = info.join(' · ');
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
    const prevIgHandle = lastAiProfile.instagram || '';
    applySaved(await patchProfile(lastAiProfile.id, updates));
    if (updates.instagram && updates.instagram !== prevIgHandle) {
      await deleteProfileImages(lastAiProfile.id);
      STATE.imagesByProfile.delete(lastAiProfile.id);
      requestIgPic(lastAiProfile.id);
    }
    buildFilterChips();
    buildProfessionDatalist();
    render();
    if ($('#profile-dialog').open && STATE.current?.id === lastAiProfile.id) {
      openProfileDialog(lastAiProfile.id);
    }
    dlg.close();
    toast(`${Object.keys(updates).length} champ${Object.keys(updates).length > 1 ? 's' : ''} mis à jour depuis le scan IA.`, { type: 'ok' });
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

// ============= RECHERCHE → MÉTIER =============
// Quand la recherche ressemble à un métier (nom, abréviation ou jargon de
// plateau), on propose directement la catégorie : un clic (ou Entrée) affiche
// TOUT le monde de ce métier — sans dépendre de ce que les tags contiennent.
const PRO_ALIASES = [
  [/^(ar|1er ar|2nd ar|ass\.? ?r[ée]al|assistant r[ée]al)/, ['Assistant réalisateur', 'Second assistant réalisateur']],
  [/^(ac|1er ac|2nd ac|ass\.? ?cam|assistant cam)/, ['Premier assistant caméra', 'Second assistant caméra']],
  [/^(chef ?op|dop|dp|directeur photo|direction photo)/, ['Directeur de la photographie']],
  [/^(elec|élec|electro|électro|electricien|électricien)/, ['Électro', 'Chef électro']],
  [/^(machino|machiniste)/, ['Machiniste', 'Chef machiniste']],
  [/^(regie|régie|regisseur|régisseur)/, ['Régisseur général', 'Support régie']],
  [/^(montage|monteur|monteuse)/, ['Monteur']],
  [/^(etalo|étalo|colorist|color|grading)/, ['Étalonneur']],
  [/^(maquill|mua|make ?up)/, ['Maquilleur']],
  [/^(coiff|hair)/, ['Coiffeur']],
  [/^(deco|déco)/, ['Chef décorateur', 'Assistant décorateur', 'Décorateur·rice']],
  [/^(son|ingé|inge|sound)/, ['Ingénieur du son', 'Assistant son', 'Mixeur son']],
  [/^(photo)/, ['Photographe', 'Assistant photo']],
  [/^(real|réal|realisat|réalisat|filmmaker)/, ['Réalisateur']],
  [/^(prod)/, ['Producteur', 'Directeur de production', 'Coordinateur de production', 'Assistant de production', 'Post-producteur']],
  [/^(steadi)/, ['Opérateur steadicam']],
  [/^(drone)/, ['Pilote de drone', 'Cadreur']],
  [/^(styl)/, ['Styliste', 'Assistant styliste']],
  [/^(da|dir\.? ?art|direction artistique)/, ['Directeur artistique']],
  [/^(costum)/, ['Costumier', 'Modiste']],
  [/^(vfx|effets)/, ['VFX Artist']],
  [/^(rigg|artific)/, ['Rigger', 'Artificier']],
  [/^(chapeau|modiste)/, ['Modiste']],
];

function matchProfessions(query) {
  const nq = normalizeForSearch(query).trim();
  if (nq.length < 2) return [];
  const counts = professionCounts();
  const out = new Set();
  for (const pro of Object.keys(counts)) if (normalizeForSearch(pro).includes(nq)) out.add(pro);
  for (const [re, pros] of PRO_ALIASES) if (re.test(nq)) for (const p of pros) if (counts[p]) out.add(p);
  return [...out].sort((x, y) => counts[y] - counts[x] || x.localeCompare(y, 'fr')).map((pro) => ({ pro, n: counts[pro] }));
}

function renderProSuggest() {
  const bar = $('#pro-suggest');
  if (!bar) return;
  const list = STATE.filters.query ? matchProfessions(STATE.filters.query).slice(0, 6) : [];
  bar.querySelectorAll('.pro-suggest__chip').forEach((b) => b.remove());
  if (!list.length) { bar.hidden = true; return; }
  for (const { pro, n } of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag-bar__chip pro-suggest__chip';
    b.dataset.profession = pro;
    b.innerHTML = `${escapeHtmlBasic(pro)} <span class="pro-suggest__count">${n}</span>`;
    b.title = `Voir les ${n} profil${n > 1 ? 's' : ''} « ${pro} »`;
    bar.appendChild(b);
  }
  bar.hidden = false;
}

/** Affiche tous les profils d'un métier (depuis une fiche) : filtre + retour en haut. */
function showProfession(pro) {
  if (!pro) return;
  STATE.filters = { ...STATE.filters, profession: pro, status: '', query: '', tag: '' };
  $('#search-input').value = '';
  $('#search-clear').hidden = true;
  setMeta('profession', pro);
  buildFilterChips();
  buildStatusFilters();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const n = STATE.filtered.length;
  toast(`${n} profil${n > 1 ? 's' : ''} « ${pro} »`, { type: 'info', timeout: 2500 });
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
      applySaved(await patchProfile(p.id, { status: p.status === 'favori' ? '' : 'favori' }));
      render();
      toast(p.status === 'favori' ? 'Ajouté aux favoris.' : 'Retiré des favoris.', { type: 'ok' });
    }
    else if (act === 'collab') {
      applySaved(await patchProfile(p.id, { status: p.status === 'collabore' ? '' : 'collabore' }));
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
