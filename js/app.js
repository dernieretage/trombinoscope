// Orchestrateur principal du Trombinoscope
import {
  getAllProfiles, saveProfile, deleteProfile, bulkSaveProfiles,
  saveImage, getProfileImages, deleteImage, deleteProfileImages,
  exportAll, importAll, getMeta, setMeta, estimateUsage, uid,
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

  // seed initial si DB vide — on antidate la création pour ne pas marquer "Nouveau"
  let profiles = await getAllProfiles();
  if (!profiles.length && !(await getMeta('seeded'))) {
    const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const seeded = SEED_PROFILES.map(p => ({
      id: uid(),
      name: p.name,
      profession: p.profession,
      instagram: p.instagram,
      phone: '',
      email: '',
      website: '',
      location: '',
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
  STATE.profiles = profiles;

  // précharge les premières images de chaque profil pour les vignettes
  for (const p of STATE.profiles) {
    const imgs = await getProfileImages(p.id);
    if (imgs.length) STATE.imagesByProfile.set(p.id, imgs);
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
  // PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

// ============= BUILD UI ELEMENTS =============

function buildFilterChips() {
  const el = $('#profession-chips');
  el.innerHTML = '';

  const counts = professionCounts();
  const all = document.createElement('button');
  all.className = 'chip' + (STATE.filters.profession === 'all' ? ' is-active' : '');
  all.dataset.profession = 'all';
  all.innerHTML = `Tous <span class="chip__count">${STATE.profiles.length}</span>`;
  el.appendChild(all);

  // tri par effectif décroissant pour les pros existantes
  const presentPros = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  for (const pro of presentPros) {
    const c = document.createElement('button');
    c.className = 'chip' + (STATE.filters.profession === pro ? ' is-active' : '');
    c.dataset.profession = pro;
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
    b.className = 'status-pill' + (STATE.filters.status === s.id ? ' is-active' : '');
    b.style.setProperty('--c', s.color);
    b.dataset.status = s.id;
    b.textContent = s.label;
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
  STATE.profiles.forEach(p => p.profession && set.add(p.profession));
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

function buildSortSelect() {
  const sel = $('#sort-select');
  sel.value = STATE.filters.sort;
  sel.addEventListener('change', () => {
    STATE.filters.sort = sel.value;
    setMeta('sort', sel.value);
    render();
  });
}

function professionCounts() {
  const c = {};
  for (const p of STATE.profiles) {
    if (p.profession) c[p.profession] = (c[p.profession] || 0) + 1;
  }
  return c;
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
  }, 120);
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
    if (a === 'copy-emails') return copyEmailsOfFiltered();
    if (a === 'copy-handles') return copyHandlesOfFiltered();
    if (a === 'seed') return doReSeed();
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
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.card, .row');
    if (!card) return;
    e.preventDefault();
    openProfileDialog(card.dataset.id);
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

  if (profession !== 'all') list = list.filter(p => p.profession === profession);
  if (status) list = list.filter(p => p.status === status);
  if (STATE.filters.tag) {
    const t = STATE.filters.tag.toLowerCase();
    list = list.filter(p => (p.tags || []).some(x => x.toLowerCase() === t));
  }
  if (q) {
    list = list.filter(p => {
      const blob = [
        p.name, p.profession, p.instagram, p.email, p.phone,
        p.location, p.website, p.notes, ...(p.tags || []),
      ].filter(Boolean).join(' ');
      return fuzzyMatch(q, blob);
    });
  }

  const STATUS_RANK = { favori: 0, en_cours: 1, collabore: 2, a_contacter: 3, '': 4 };
  const cmp = {
    name: (a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' }),
    favoris: (a, b) => {
      const ra = a.status === 'favori' ? 0 : 1;
      const rb = b.status === 'favori' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' });
    },
    recent: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    created: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
    profession: (a, b) => (a.profession || '').localeCompare(b.profession || '', 'fr') || (a.name || '').localeCompare(b.name || '', 'fr'),
    status: (a, b) => (STATUS_RANK[a.status ?? ''] ?? 4) - (STATUS_RANK[b.status ?? ''] ?? 4) || (a.name || '').localeCompare(b.name || '', 'fr'),
  };
  list = [...list].sort(cmp[sort] || cmp.name);
  STATE.filtered = list;
  return list;
}

function render() {
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
  const frag = document.createDocumentFragment();
  list.forEach((p, i) => {
    const imgs = STATE.imagesByProfile.get(p.id);
    const first = imgs?.[0];
    const node = STATE.view === 'list'
      ? renderRow(p, { firstImage: first, query: STATE.filters.query, index: i })
      : renderCard(p, { firstImage: first, query: STATE.filters.query, index: i });
    frag.appendChild(node);
  });
  grid.replaceChildren(frag);
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
      render();
    },
    onNotesChange: async (notes) => {
      profile.notes = notes;
      await saveProfile(profile);
    },
    onUploadImages: async (files) => {
      await addImagesToProfile(profile, files);
      const imgs = await getProfileImages(profile.id);
      STATE.imagesByProfile.set(profile.id, imgs);
      openProfileDialog(profile.id);
      render();
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
  if (!list.length) return;
  const idx = list.findIndex(p => p.id === STATE.current.id);
  if (idx === -1) return;
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
  buildFilterChips();
  render();
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

  if (profile) {
    form.elements.id.value = profile.id;
    form.elements.name.value = profile.name || '';
    form.elements.profession.value = profile.profession || '';
    form.elements.status.value = profile.status || '';
    form.elements.instagram.value = profile.instagram || '';
    form.elements.phone.value = profile.phone || '';
    form.elements.email.value = profile.email || '';
    form.elements.website.value = profile.website || '';
    form.elements.location.value = profile.location || '';
    form.elements.rate.value = profile.rate || '';
    form.elements.lastContact.value = profile.lastContact || '';
    form.elements.tags.value = (profile.tags || []).join(', ');
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

  // submit
  $('#edit-save').addEventListener('click', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.name?.trim()) {
      toast('Le nom est requis.', { type: 'warn' });
      form.elements.name.focus();
      return;
    }
    const id = data.id || uid();
    const existing = STATE.profiles.find(p => p.id === id);
    const profile = {
      ...(existing || {}),
      id,
      name: data.name.trim(),
      profession: data.profession.trim(),
      status: data.status || '',
      instagram: parseInstagramHandle(data.instagram),
      phone: data.phone.trim(),
      email: data.email.trim(),
      website: data.website.trim(),
      location: data.location.trim(),
      rate: (data.rate || '').trim(),
      lastContact: data.lastContact || '',
      tags: (data.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      notes: data.notes,
    };
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
    toast(existing ? 'Profil mis à jour.' : 'Profil créé.', { type: 'ok' });
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

async function addImagesToProfile(profile, files) {
  const existing = await getProfileImages(profile.id);
  let nextIdx = existing.length;
  for (const f of files) {
    try {
      const blob = await downscaleImage(f, { maxDim: 1400, quality: 0.85 });
      await saveImage(profile.id, nextIdx++, blob);
    } catch (err) {
      console.warn('Erreur image', err);
    }
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
  const cols = ['name', 'profession', 'instagram', 'phone', 'email', 'website', 'location', 'tags', 'status', 'notes', 'createdAt', 'updatedAt'];
  const escapeCsv = (v) => {
    if (v == null) return '';
    const s = Array.isArray(v) ? v.join(', ') : String(v);
    if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const rows = [cols.join(',')];
  for (const p of profiles) {
    rows.push(cols.map(c => escapeCsv(p[c])).join(','));
  }
  const csv = '﻿' + rows.join('\n'); // BOM for Excel
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
      const text = await f.text();
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
    return; // dialog gère son close
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

// ============= STATS =============

function renderStats(filtered) {
  const bar = $('#statbar');
  if (!STATE.profiles.length) { bar.hidden = true; return; }
  bar.hidden = false;
  animateNumber($('#stat-total'), STATE.profiles.length);
  animateNumber($('#stat-shown'), filtered.length);
  const pros = new Set(STATE.profiles.map(p => p.profession).filter(Boolean));
  animateNumber($('#stat-pros'), pros.size);
  const fav = STATE.profiles.filter(p => p.status === 'favori').length;
  animateNumber($('#stat-fav'), fav);
  const filtered_active = STATE.filters.profession !== 'all' || STATE.filters.status || STATE.filters.query;
  $('#stat-clear').hidden = !filtered_active;
}
function animateNumber(el, target) {
  if (!el) return;
  const cur = parseInt(el.textContent, 10);
  const from = Number.isFinite(cur) ? cur : 0;
  if (from === target) return;
  // Anim avec setTimeout pour fiabilité maximale
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
  };
  // si déjà en cours, on annule pas — on laisse converger via le state final
  el.textContent = String(target); // valeur définitive immédiate (les rendus suivants ne ré-animent pas)
  // mais faire l'animation visuellement quand même : si on veut animer, on revert puis tick
  if (Math.abs(target - from) > 0) {
    el.textContent = String(from);
    setTimeout(tick, stepMs);
  }
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
  if (action === 'ig' && p.instagram)    window.open(`https://instagram.com/${p.instagram}`, '_blank', 'noopener');
  else if (action === 'phone' && p.phone) window.open('tel:' + p.phone.replace(/\s+/g, ''));
  else if (action === 'mail' && p.email)  window.open('mailto:' + p.email);
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
    else if (act === 'mail') window.open('mailto:' + p.email);
    else if (act === 'phone')window.open('tel:' + p.phone.replace(/\s+/g, ''));
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
