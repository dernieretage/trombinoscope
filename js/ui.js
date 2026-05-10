// Rendu UI : cards, rows, modals, toasts
import { avatarFor, escapeHTML, fmtBytes, fmtDate, getInitials, highlight, objectURLFor, revokeObjectURL } from './utils.js';
import { STATUSES } from './seed.js';

const STATUS_BY_ID = Object.fromEntries(STATUSES.map(s => [s.id, s]));

function professionsOf(p) {
  return p.professions || (p.profession ? [p.profession] : []);
}

// =================================================================
// AVATAR / IMAGE
// =================================================================

// Met à jour le style avatar/image d'un élément
export function applyAvatar(el, profile, firstImage) {
  const a = avatarFor(profile.name, profile.instagram);
  el.style.setProperty('--avatar-bg', a.bg);
  el.style.setProperty('--avatar-gradient', a.gradient);
  if (firstImage) {
    const url = objectURLFor(firstImage.key, firstImage.blob);
    el.style.backgroundImage = `url("${url}")`;
    el.style.setProperty('--avatar-gradient', 'none');
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = a.initials;
  }
}

// =================================================================
// CARD (grille)
// =================================================================

export function renderCard(profile, { firstImage, query, index = 0 } = {}) {
  const tpl = document.getElementById('tpl-card');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = profile.id;
  node.style.setProperty('--delay', Math.min(index * 8, 160) + 'ms');

  const avatarEl = node.querySelector('.card__avatar');
  applyAvatar(avatarEl, profile, firstImage);

  // statut
  const statusEl = node.querySelector('.card__status');
  if (profile.status && STATUS_BY_ID[profile.status]) {
    const s = STATUS_BY_ID[profile.status];
    if (profile.status === 'favori') {
      statusEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:11px;height:11px"><path d="M12 17l-6.18 3.7 1.64-7.03L2 8.97l7.19-.62L12 2l2.81 6.35L22 8.97l-5.46 4.7 1.64 7.03L12 17z" fill="currentColor"/></svg> ' + s.label;
      statusEl.classList.add('card__status--fav');
    } else {
      statusEl.textContent = s.label;
    }
    statusEl.style.setProperty('--c', s.color);
  } else {
    statusEl.remove();
  }

  // texte
  node.querySelector('.card__name').innerHTML = highlight(profile.name || profile.instagram || 'Sans nom', query);
  const pros = professionsOf(profile);
  const proStr = pros.length ? (pros.length > 2 ? pros.slice(0, 2).join(' · ') + ` +${pros.length - 2}` : pros.join(' · ')) : '';
  const meta = [proStr, profile.location].filter(Boolean).join(' · ');
  node.querySelector('.card__meta').innerHTML = highlight(meta || '—', query);

  // tags
  const tagsEl = node.querySelector('.card__tags');
  const tags = (profile.tags || []).slice(0, 3);
  for (const t of tags) {
    const span = document.createElement('span');
    span.className = 'tag';
    span.dataset.tag = t;
    span.title = `Filtrer par #${t}`;
    span.innerHTML = highlight(t, query);
    tagsEl.appendChild(span);
  }
  if ((profile.tags || []).length > 3) {
    const more = document.createElement('span');
    more.className = 'tag tag--more';
    more.textContent = `+${profile.tags.length - 3}`;
    tagsEl.appendChild(more);
  }

  // foot : handle + icônes contact
  const handleEl = node.querySelector('.card__handle');
  if (profile.instagram) handleEl.textContent = profile.instagram;
  else handleEl.remove();

  const icons = node.querySelector('.card__icons');
  const contactIcons = [];
  if (profile.phone) contactIcons.push(svgIcon('phone'));
  if (profile.email) contactIcons.push(svgIcon('mail'));
  if (profile.website) contactIcons.push(svgIcon('link'));
  icons.innerHTML = contactIcons.join('');

  // hover quick actions: only show enabled ones
  if (profile.instagram) node.querySelector('[data-quick="ig"]').hidden = false;
  if (profile.phone) node.querySelector('[data-quick="phone"]').hidden = false;
  if (profile.email) node.querySelector('[data-quick="mail"]').hidden = false;

  // "Nouveau" badge si profil créé il y a moins de 1h (et pas par le seed)
  const newEl = node.querySelector('.card__new');
  if (profile.createdAt && Date.now() - new Date(profile.createdAt).getTime() < 3600000) {
    newEl.hidden = false;
  }

  return node;
}

// =================================================================
// ROW (vue liste)
// =================================================================

export function renderRow(profile, { firstImage, query, index = 0 } = {}) {
  const tpl = document.getElementById('tpl-row');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = profile.id;
  node.style.setProperty('--delay', Math.min(index * 6, 120) + 'ms');

  const avatarEl = node.querySelector('.row__avatar');
  applyAvatar(avatarEl, profile, firstImage);

  node.querySelector('.row__name').innerHTML = highlight(profile.name || profile.instagram || 'Sans nom', query);
  const meta = [professionsOf(profile).join(' · '), profile.location, profile.instagram ? '@' + profile.instagram : ''].filter(Boolean).join(' · ');
  node.querySelector('.row__meta').innerHTML = highlight(meta, query);

  const tagsEl = node.querySelector('.row__tags');
  for (const t of (profile.tags || []).slice(0, 4)) {
    const span = document.createElement('span');
    span.className = 'tag';
    span.innerHTML = highlight(t, query);
    tagsEl.appendChild(span);
  }

  const contactEl = node.querySelector('.row__contact');
  if (profile.email) {
    const sp = document.createElement('span'); sp.textContent = profile.email; contactEl.appendChild(sp);
  }
  if (profile.phone) {
    const sp = document.createElement('span'); sp.textContent = profile.phone; contactEl.appendChild(sp);
  }

  const statusEl = node.querySelector('.row__status');
  if (profile.status && STATUS_BY_ID[profile.status]) {
    const s = STATUS_BY_ID[profile.status];
    const pill = document.createElement('span');
    pill.className = 'status-pill';
    pill.textContent = s.label;
    pill.style.setProperty('--c', s.color);
    statusEl.appendChild(pill);
  }

  return node;
}

// =================================================================
// PROFILE DETAIL DIALOG
// =================================================================

export function renderProfileDetail(container, profile, images, { onEdit, onDelete, onClose, onPrev, onNext, onStatusChange, onNotesChange, onUploadImages, onDeleteImage, onFetchIg, onAiScan } = {}) {
  // Replace innerHTML with a fresh root to clear any prior delegated listener
  container.innerHTML = '';
  // remove any previous listener by creating a fresh delegated handler each time
  if (container.__delHandler) container.removeEventListener('click', container.__delHandler);

  const wrap = document.createElement('div');
  wrap.className = 'profile';
  wrap.id = 'profile-name';

  // ----- Media side -----
  const media = document.createElement('div');
  media.className = 'profile__media';

  const cover = document.createElement('div');
  cover.className = 'profile__cover';
  applyAvatar(cover, profile, images?.[0]);
  media.appendChild(cover);

  // navigation prev/next
  const nav = document.createElement('div');
  nav.className = 'profile__nav';
  nav.innerHTML = `
    <button class="iconbtn" data-act="prev" title="Profil précédent (←)" aria-label="Profil précédent">
      <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="iconbtn" data-act="next" title="Profil suivant (→)" aria-label="Profil suivant">
      <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;
  media.appendChild(nav);

  // outils (fetch ig, ai scan, upload, edit, close)
  const tools = document.createElement('div');
  tools.className = 'profile__tools';
  const igBtn = profile.instagram ? `
    <button class="iconbtn" data-act="fetch-ig" title="Importer photo & posts Instagram" aria-label="Importer Instagram">
      <svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" stroke="currentColor" stroke-width="1.7" fill="none"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.7" fill="none"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor"/><path d="M5 19l4-3 3 2 5-4 2 1.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".6"/></svg>
    </button>` : '';
  const aiBtn = profile.instagram || profile.name ? `
    <button class="iconbtn" data-act="ai-scan" title="Scan IA : compléter automatiquement (expérimental)" aria-label="Scan IA">
      <svg viewBox="0 0 24 24"><path d="M12 2l1.7 4.5L18 8l-4.3 2L12 14l-1.7-4L6 8l4.3-1.5L12 2zM5 16l1 2.5L8.5 19 6 20l-1 2.5L4 20 1.5 19 4 18 5 16zM18 14l1.4 3.4L23 18l-3.6 1L18 22l-1.4-3-3.6-1 3.6-1.6L18 14z" fill="currentColor"/></svg>
    </button>` : '';
  tools.innerHTML = `
    ${igBtn}
    ${aiBtn}
    <label class="iconbtn" title="Ajouter des images" aria-label="Ajouter des images">
      <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>
      <input type="file" accept="image/*" multiple hidden data-act="upload" />
    </label>
    <button class="iconbtn" data-act="edit" title="Éditer le profil" aria-label="Éditer le profil">
      <svg viewBox="0 0 24 24"><path d="M4 17v3h3l11-11-3-3L4 17zM14 6l3 3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="iconbtn" data-act="close" title="Fermer (Esc)" aria-label="Fermer">
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>`;
  media.appendChild(tools);

  // gallery thumbs
  if (images && images.length > 1) {
    const gallery = document.createElement('div');
    gallery.className = 'profile__gallery';
    images.forEach((img, i) => {
      const t = document.createElement('button');
      t.className = 'profile__thumb' + (i === 0 ? ' is-active' : '');
      t.style.backgroundImage = `url("${objectURLFor(img.key, img.blob)}")`;
      t.dataset.idx = String(i);
      t.title = `Image ${i + 1}`;
      gallery.appendChild(t);
    });
    media.appendChild(gallery);

    gallery.addEventListener('click', (e) => {
      const btn = e.target.closest('.profile__thumb');
      if (!btn) return;
      const idx = +btn.dataset.idx;
      gallery.querySelectorAll('.profile__thumb').forEach(t => t.classList.remove('is-active'));
      btn.classList.add('is-active');
      applyAvatar(cover, profile, images[idx]);
    });
  }

  wrap.appendChild(media);

  // ----- Body side -----
  const body = document.createElement('div');
  body.className = 'profile__body';

  // head
  const head = document.createElement('div');
  head.className = 'profile__head';
  const h2 = document.createElement('h2');
  h2.className = 'profile__name';
  h2.textContent = profile.name || profile.instagram || 'Sans nom';
  head.appendChild(h2);

  const sub = document.createElement('div');
  sub.className = 'profile__sub';
  for (const pro of professionsOf(profile)) {
    const pTag = document.createElement('span');
    pTag.className = 'tag';
    pTag.textContent = pro;
    sub.appendChild(pTag);
  }
  if (profile.location) {
    sub.appendChild(textChip(profile.location, 'pin'));
  }
  if (profile.instagram) {
    sub.appendChild(textChip('@' + profile.instagram, 'ig'));
  }
  head.appendChild(sub);

  body.appendChild(head);

  const content = document.createElement('div');
  content.className = 'profile__content';

  // status bar
  const statSection = section('Statut');
  const statBar = document.createElement('div');
  statBar.className = 'profile__statusbar';
  for (const s of STATUSES) {
    const p = document.createElement('button');
    p.className = 'status-pill' + (profile.status === s.id ? ' is-active' : '');
    p.style.setProperty('--c', s.color);
    p.textContent = s.label;
    p.dataset.status = s.id;
    statBar.appendChild(p);
  }
  statBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.status-pill');
    if (!btn) return;
    const newStatus = profile.status === btn.dataset.status ? '' : btn.dataset.status;
    statBar.querySelectorAll('.status-pill').forEach(p => p.classList.toggle('is-active', p.dataset.status === newStatus));
    profile.status = newStatus;
    onStatusChange?.(newStatus);
  });
  statSection.appendChild(statBar);
  content.appendChild(statSection);

  // contacts
  const contacts = [];
  if (profile.phone) {
    contacts.push({ icon: 'phone', label: profile.phone, href: 'tel:' + profile.phone.replace(/\s+/g, '') });
    const cleanPhone = profile.phone.replace(/\D/g, '');
    if (cleanPhone.length >= 8) {
      contacts.push({ icon: 'wa', label: 'WhatsApp', href: 'https://wa.me/' + cleanPhone.replace(/^0/, '33') });
    }
  }
  if (profile.email) contacts.push({ icon: 'mail', label: profile.email, href: 'mailto:' + profile.email });
  if (profile.instagram) contacts.push({ icon: 'ig', label: '@' + profile.instagram, href: 'https://instagram.com/' + profile.instagram });
  if (profile.website) contacts.push({ icon: 'link', label: profile.website.replace(/^https?:\/\//, ''), href: profile.website });
  if (contacts.length) {
    const cs = section('Contacts');
    const grid = document.createElement('div');
    grid.className = 'profile__contacts';
    for (const c of contacts) {
      const a = document.createElement('a');
      a.className = 'profile__contact';
      a.href = c.href;
      if (c.href.startsWith('http')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.innerHTML = svgIcon(c.icon) + `<span>${escapeHTML(c.label)}</span>`;
      grid.appendChild(a);
    }
    cs.appendChild(grid);
    content.appendChild(cs);
  }

  // bio
  if (profile.bio) {
    const bioSec = section('Bio');
    const bioEl = document.createElement('div');
    bioEl.className = 'profile__notes';
    bioEl.style.fontStyle = 'italic';
    bioEl.textContent = profile.bio;
    bioSec.appendChild(bioEl);
    content.appendChild(bioSec);
  }

  // tarif & dernier contact & agence
  if (profile.rate || profile.lastContact || profile.agency) {
    const inf = section('Infos pratiques');
    const grid = document.createElement('div');
    grid.className = 'profile__contacts';
    if (profile.agency) {
      const a = document.createElement('div');
      a.className = 'profile__contact';
      a.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 9l9-6 9 6v12H3V9z M9 21V12h6v9" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Représenté·e par : <strong>' + escapeHTML(profile.agency) + '</strong></span>';
      grid.appendChild(a);
    }
    if (profile.rate) {
      const a = document.createElement('div');
      a.className = 'profile__contact';
      a.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2v20M17 5H10c-1.7 0-3 1.3-3 3s1.3 3 3 3h4c1.7 0 3 1.3 3 3s-1.3 3-3 3H7" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + escapeHTML(profile.rate) + '</span>';
      grid.appendChild(a);
    }
    if (profile.lastContact) {
      const a = document.createElement('div');
      a.className = 'profile__contact';
      const d = new Date(profile.lastContact);
      const days = Math.round((Date.now() - d.getTime()) / 86400000);
      const since = days <= 0 ? 'aujourd\'hui' : days === 1 ? 'hier' : days < 30 ? `il y a ${days} j` : days < 365 ? `il y a ${Math.round(days / 30)} mois` : `il y a ${Math.round(days / 365)} an${days >= 730 ? 's' : ''}`;
      a.innerHTML = `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><span>Dernier contact : ${escapeHTML(fmtDate(profile.lastContact))} (${since})</span>`;
      grid.appendChild(a);
    }
    inf.appendChild(grid);
    content.appendChild(inf);
  }

  // tags
  if ((profile.tags || []).length) {
    const ts = section('Tags');
    const list = document.createElement('div');
    list.className = 'profile__taglist';
    for (const t of profile.tags) {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t;
      list.appendChild(span);
    }
    ts.appendChild(list);
    content.appendChild(ts);
  }

  // notes éditables
  const notesSec = section('Notes');
  const notes = document.createElement('div');
  notes.className = 'profile__notes';
  notes.dataset.placeholder = 'Cliquez pour ajouter des notes…';
  notes.contentEditable = 'true';
  notes.spellcheck = true;
  notes.textContent = profile.notes || '';
  let notesTimer;
  notes.addEventListener('input', () => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => onNotesChange?.(notes.textContent), 350);
  });
  notesSec.appendChild(notes);
  content.appendChild(notesSec);

  // images mini delete
  if (images && images.length) {
    const imSec = section('Images');
    const list = document.createElement('div');
    list.className = 'dropzone__list';
    list.style.display = 'grid';
    images.forEach((img) => {
      const item = document.createElement('div');
      item.className = 'dropzone__item';
      item.style.backgroundImage = `url("${objectURLFor(img.key, img.blob)}")`;
      const rm = document.createElement('button');
      rm.className = 'dropzone__rm';
      rm.title = 'Retirer cette image';
      rm.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        onDeleteImage?.(img.key);
      });
      item.appendChild(rm);
      list.appendChild(item);
    });
    imSec.appendChild(list);
    content.appendChild(imSec);
  }

  // meta
  const meta = document.createElement('div');
  meta.className = 'profile__meta';
  meta.innerHTML = `
    <span>Créé le ${escapeHTML(fmtDate(profile.createdAt))}</span>
    <span>Modifié le ${escapeHTML(fmtDate(profile.updatedAt))}</span>
  `;
  content.appendChild(meta);

  body.appendChild(content);

  // foot actions
  const foot = document.createElement('div');
  foot.className = 'dialog__foot';
  foot.innerHTML = `
    <button class="btn btn--danger" data-act="delete">Supprimer</button>
    <button class="btn btn--ghost" data-act="close">Fermer</button>
    <button class="btn btn--primary" data-act="edit">Éditer en détail</button>
  `;
  body.appendChild(foot);

  wrap.appendChild(body);
  container.appendChild(wrap);

  // events (delegated, with single-listener guarantee)
  const handler = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'edit') onEdit?.();
    else if (act === 'delete') onDelete?.();
    else if (act === 'close') onClose?.();
    else if (act === 'prev') onPrev?.();
    else if (act === 'next') onNext?.();
    else if (act === 'fetch-ig') onFetchIg?.();
    else if (act === 'ai-scan') onAiScan?.();
  };
  container.__delHandler = handler;
  container.addEventListener('click', handler);

  // upload images depuis le profil
  const uploadInput = container.querySelector('[data-act="upload"]');
  uploadInput?.addEventListener('change', (e) => {
    onUploadImages?.(Array.from(e.target.files || []));
    e.target.value = '';
  });
}

// =================================================================
// HELPERS
// =================================================================

function section(title) {
  const s = document.createElement('section');
  s.className = 'profile__section';
  const h = document.createElement('h3');
  h.textContent = title;
  s.appendChild(h);
  return s;
}

function textChip(text, icon) {
  const span = document.createElement('span');
  span.className = 'tag';
  span.innerHTML = (icon ? svgIcon(icon) + ' ' : '') + escapeHTML(text);
  return span;
}

export function svgIcon(name) {
  const icons = {
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/></svg>',
    mail:  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M3 7l9 6 9-6" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>',
    link:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M15 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>',
    ig:    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor"/></svg>',
    pin:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-7 7-13a7 7 0 0 0-14 0c0 6 7 13 7 13z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="9" r="2.5" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
    wa:    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 11.4c0 4.7-3.8 8.5-8.6 8.5-1.5 0-3-.4-4.3-1.1L3 20l1.3-4.4c-.8-1.4-1.3-3-1.3-4.7 0-4.7 3.8-8.5 8.6-8.5s8.9 4.4 8.9 9zm-9-7c-3.6 0-6.6 2.9-6.6 6.6 0 1.5.5 2.9 1.4 4l-.9 2.5 2.6-.8c1.1.6 2.3.9 3.5.9 3.6 0 6.6-2.9 6.6-6.6 0-3.7-3-6.6-6.6-6.6zm3.7 8.4c-.1-.1-.2-.2-.4-.3-.2-.1-1.2-.6-1.4-.6-.2-.1-.3-.1-.4.1-.1.2-.5.6-.6.7-.1.1-.2.1-.4 0-.2-.1-.8-.3-1.5-.9-.6-.5-1-1.1-1.1-1.3-.1-.2 0-.3.1-.4.1-.1.2-.2.3-.3.1-.1.1-.2.2-.3 0-.1 0-.2 0-.3 0-.1-.4-.9-.5-1.2-.1-.3-.3-.3-.4-.3h-.3c-.1 0-.3 0-.5.2-.2.2-.6.6-.6 1.5s.7 1.7.7 1.8c.1.1 1.4 2.1 3.4 2.9 1.7.7 1.9.6 2.3.5.4-.1 1.2-.5 1.3-.9.2-.5.2-.9.1-.9z" fill="currentColor"/></svg>',
  };
  return icons[name] || '';
}

// =================================================================
// TOASTS
// =================================================================

let toastSeq = 0;
export function toast(message, { type = 'info', timeout = 3500, action } = {}) {
  const c = document.getElementById('toasts');
  const id = 'tst-' + (++toastSeq);
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.id = id;
  el.innerHTML = `
    <svg class="toast__icon" viewBox="0 0 24 24" aria-hidden="true">${
      type === 'ok' ? '<path d="M5 12l4 4 10-10" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' :
      type === 'err' ? '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' :
      type === 'warn' ? '<path d="M12 3l10 18H2L12 3z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M12 10v4M12 17v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' :
      '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    }</svg>
    <span>${escapeHTML(message)}</span>
  `;

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost';
    btn.style.cssText = 'height:28px;padding:0 12px;font-size:12px;';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.onClick?.(); dismiss(); });
    el.appendChild(btn);
  }

  const close = document.createElement('button');
  close.className = 'toast__close';
  close.setAttribute('aria-label', 'Fermer');
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  close.addEventListener('click', dismiss);
  el.appendChild(close);

  c.appendChild(el);

  let t;
  function dismiss() {
    if (!el.parentNode) return;
    clearTimeout(t);
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 250);
  }
  if (timeout) t = setTimeout(dismiss, timeout);

  return { dismiss };
}

// =================================================================
// CONFIRM DIALOG (promesse)
// =================================================================

export function confirmDialog({ title = 'Confirmer', text = '', okLabel = 'Confirmer', danger = true } = {}) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('confirm-dialog');
    dlg.querySelector('#confirm-title').textContent = title;
    dlg.querySelector('#confirm-text').textContent = text;
    const okBtn = dlg.querySelector('[data-confirm="ok"]');
    okBtn.textContent = okLabel;
    okBtn.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
    function onClick(e) {
      const v = e.target.closest('[data-confirm]')?.dataset.confirm;
      if (!v) return;
      cleanup();
      resolve(v === 'ok');
    }
    function onCancel() { cleanup(); resolve(false); }
    function cleanup() {
      dlg.removeEventListener('click', onClick);
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
    }
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}
