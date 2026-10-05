// Porte d'entrée du Trombinoscope.
//
// Le mot de passe est demandé UNE fois par nouvel appareil. Il sert à deux
// choses, sans jamais être stocké :
//  1. le vérifier : il doit déchiffrer le coffre ci-dessous (PBKDF2 +
//     AES-256-GCM) — déchiffrement réussi = bon mot de passe ;
//  2. en dériver l'identifiant (secret) de l'espace partagé dans la base temps
//     réel. Sans le mot de passe, impossible de trouver ou de lire les données.
// Tous les appareils qui saisissent le même mot de passe rejoignent le même
// espace. Changer le mot de passe = re-sceller le coffre (scripts/seal-vault.mjs).

import { getMeta, setMeta } from './store.js';

// Coffre scellé par scripts/seal-vault.mjs — ne pas éditer à la main.
const VAULT = {
  ver: 2,
  salt: 'iULmGkJaAYT09SUd39I4iw==',
  iv: '1PkHLaffewXsuuEY',
  ct: 'yRTFN3U7CRBnaAM6MZV2+8ld5OEUwX069TxslxYG9oCJy+jEsfQ25ctctBFbL/ZlD3T8xkrQFgU=',
  iter: 310000,
};

const META_SPACE = 'rt_space';
const SPACE_SALT = 'trombinoscope/espace-partage/v1';
const SPACE_ITER = 150000;
const IS_DEV_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

function b64ToU8(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function pbkdf2Bits(password, salt, iterations) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, baseKey, 256);
}

/** true si le mot de passe déchiffre le coffre. Le contenu déchiffré est jeté. */
async function passwordIsValid(password) {
  if (!password) return false;
  try {
    const bits = await pbkdf2Bits(password, b64ToU8(VAULT.salt), VAULT.iter);
    const key = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt']);
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToU8(VAULT.iv) }, key, b64ToU8(VAULT.ct));
    return true;
  } catch {
    return false;
  }
}

async function deriveSpaceId(password) {
  const bits = await pbkdf2Bits(password, new TextEncoder().encode(SPACE_SALT), SPACE_ITER);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Essaie un mot de passe ; en cas de succès, l'appareil rejoint l'espace partagé. */
async function unlockWith(password) {
  const pw = String(password || '').trim();
  if (!(await passwordIsValid(pw))) return null;
  const id = await deriveSpaceId(pw);
  await setMeta(META_SPACE, { id, vault: VAULT.salt });
  return id;
}

/**
 * Identifiant de l'espace partagé de cet appareil, ou null s'il faut saisir
 * le mot de passe. (Sur un serveur de développement local, `?space=test-…`
 * permet de tester dans un espace isolé.)
 */
export async function getSpaceId() {
  if (IS_DEV_HOST) {
    const dev = new URLSearchParams(location.search).get('space');
    if (dev && /^test-[a-z0-9-]{27,}$/.test(dev)) return dev;
  }
  const v = await getMeta(META_SPACE);
  // Coffre re-scellé depuis (nouveau mot de passe) → il faut le ressaisir.
  if (v && v.id && v.vault === VAULT.salt) return v.id;
  return null;
}

export async function isUnlocked() {
  return !!(await getSpaceId());
}

export async function lock() {
  await setMeta(META_SPACE, null);
}

/**
 * Appareils déjà déverrouillés avec l'ancienne version : le mot de passe
 * qu'elle avait retenu permet de rejoindre l'espace sans rien ressaisir.
 * Il est ensuite effacé, ainsi que tout ce que l'ancien système stockait.
 */
export async function migrateLegacyUnlock() {
  try {
    if (!(await getSpaceId())) {
      const old = await getMeta('gate_pw');
      if (old) await unlockWith(old);
    }
  } catch {}
  for (const k of ['gate_pw', 'cloud_repo_token', 'gate_vault_ver', 'auth_ok_v1', 'cloud_auto', 'sync_token', 'sync_gist_id']) {
    try { if ((await getMeta(k)) != null) await setMeta(k, null); } catch {}
  }
}

/**
 * Affiche la porte si l'appareil n'est pas encore déverrouillé.
 * onUnlocked(spaceId) n'est appelé que lors d'un NOUVEAU déverrouillage.
 */
export async function ensureAuthGate({ onUnlocked, message } = {}) {
  if (await getSpaceId()) return { alreadyUnlocked: true };
  if (document.getElementById('auth-gate')) return { alreadyShowing: true };

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'auth-gate';
    overlay.className = 'authgate';
    overlay.innerHTML = `
      <div class="authgate__box" role="dialog" aria-modal="true" aria-labelledby="authgate-title">
        <div class="authgate__mark">T</div>
        <h1 id="authgate-title" class="authgate__title">Trombinoscope</h1>
        <p class="authgate__sub">Facteur Humain — accès réservé</p>
        ${message ? `<p class="authgate__msg">${message}</p>` : ''}
        <form class="authgate__form" autocomplete="off">
          <input type="password" class="authgate__input" placeholder="Mot de passe"
                 autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false"
                 aria-label="Mot de passe" />
          <button type="submit" class="authgate__btn">Entrer</button>
        </form>
        <p class="authgate__err" hidden>Mot de passe incorrect</p>
      </div>`;
    document.body.appendChild(overlay);

    const form = overlay.querySelector('form');
    const input = overlay.querySelector('input');
    const btn = overlay.querySelector('button');
    const err = overlay.querySelector('.authgate__err');
    setTimeout(() => input.focus(), 100);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = 'Vérification…';
      const spaceId = await unlockWith(input.value).catch(() => null);
      if (spaceId) {
        overlay.classList.add('authgate--out');
        setTimeout(() => overlay.remove(), 350);
        try { onUnlocked?.(spaceId); } catch {}
        resolve({ unlocked: true, spaceId });
      } else {
        btn.disabled = false;
        btn.textContent = 'Entrer';
        err.hidden = false;
        input.value = '';
        input.focus();
        const box = overlay.querySelector('.authgate__box');
        box.classList.remove('authgate__box--shake');
        requestAnimationFrame(() => box.classList.add('authgate__box--shake'));
      }
    });
  });
}
