// Porte d'entrée du Trombinoscope — v2 « clé auto-réparante ».
//
// Le mot de passe saisi sert de clé : il déchiffre (PBKDF2 + AES-256-GCM) le
// token d'écriture GitHub embarqué ci-dessous. Mot de passe correct = le
// déchiffrement réussit (le tag GCM valide) = l'appareil peut lire ET écrire.
// Aucun token à coller, aucune configuration par appareil.
//
// v2 : le mot de passe est retenu sur l'appareil (outil interne). À chaque
// lancement, le token est RE-DÉRIVÉ depuis le coffre courant. Conséquence :
// quand la clé GitHub est renouvelée (scripts/seal-vault.mjs → nouveau coffre
// déployé), tous les appareils récupèrent la nouvelle clé silencieusement,
// sans re-saisie. Si le mot de passe change, la porte se re-présente.

import { getMeta, setMeta } from './store.js';

// Coffre scellé par scripts/seal-vault.mjs — ne pas éditer à la main.
const VAULT = {
  ver: 2,
  salt: 'iULmGkJaAYT09SUd39I4iw==',
  iv: '1PkHLaffewXsuuEY',
  ct: 'yRTFN3U7CRBnaAM6MZV2+8ld5OEUwX069TxslxYG9oCJy+jEsfQ25ctctBFbL/ZlD3T8xkrQFgU=',
  iter: 310000,
};

const AUTH_FLAG = 'auth_ok_v1';
const META_PW = 'gate_pw';            // mot de passe retenu (outil interne)
const META_VAULT_VER = 'gate_vault_ver'; // version du coffre au dernier déverrouillage

function b64ToU8(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveKey(password) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToU8(VAULT.salt), iterations: VAULT.iter, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

/** Tente le déchiffrement. Retourne le token si le mot de passe est bon, sinon null. */
export async function tryUnlock(password) {
  if (!password) return null;
  try {
    const key = await deriveKey(password.trim());
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToU8(VAULT.iv) }, key, b64ToU8(VAULT.ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function isUnlocked() {
  return !!(await getMeta(AUTH_FLAG)) && !!(await getMeta('cloud_repo_token'));
}

export async function lock() {
  await setMeta(AUTH_FLAG, null);
  await setMeta(META_PW, null);
  await setMeta(META_VAULT_VER, null);
  await setMeta('cloud_repo_token', null);
}

async function storeUnlock(password, token) {
  await setMeta('cloud_repo_token', token);
  await setMeta('cloud_auto', true);
  await setMeta(AUTH_FLAG, true);
  await setMeta(META_PW, password.trim());
  await setMeta(META_VAULT_VER, VAULT.ver);
}

/**
 * Auto-réparation : re-dérive le token depuis le coffre COURANT avec le mot de
 * passe retenu. À appeler au boot (silencieux) et quand une écriture échoue en
 * 401/403 (`force: true`).
 *
 * Retours :
 *  - { ok:true, changed:boolean }  → token frais en place
 *  - { locked:true }               → pas de mot de passe retenu, ou mot de passe
 *                                    devenu invalide (coffre rescellé avec un
 *                                    autre mot de passe) → appareil verrouillé,
 *                                    il faut re-présenter la porte.
 */
export async function ensureFreshToken({ force = false } = {}) {
  const pw = await getMeta(META_PW);
  const curToken = await getMeta('cloud_repo_token');
  const unlockedVer = await getMeta(META_VAULT_VER);

  if (!pw) {
    // Appareils d'avant v2 : un token hérité traîne mais pas de mot de passe
    // retenu. Tant que le token marche, on ne dérange personne ; s'il meurt
    // (force=true), on verrouille pour re-demander le mot de passe.
    if (force) { await lock(); return { locked: true }; }
    return curToken ? { ok: true, changed: false } : { locked: true };
  }

  if (!force && curToken && unlockedVer === VAULT.ver) {
    return { ok: true, changed: false }; // rien à faire
  }

  const token = await tryUnlock(pw);
  if (!token) {
    // Le coffre a été rescellé avec un AUTRE mot de passe → re-saisie requise.
    await lock();
    return { locked: true };
  }
  const changed = token !== curToken;
  await storeUnlock(pw, token);
  return { ok: true, changed };
}

/**
 * Affiche la porte mot de passe si l'appareil n'est pas déjà déverrouillé.
 * Résout quand l'accès est acquis. onUnlocked est appelé uniquement lors d'un
 * NOUVEAU déverrouillage (pas si le token était déjà en place).
 * `message` : ligne d'explication optionnelle (ex. après expiration de la clé).
 */
export async function ensureAuthGate({ onUnlocked, message } = {}) {
  if (await isUnlocked()) return { alreadyUnlocked: true };
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
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = 'Vérification…';
      const token = await tryUnlock(input.value);
      if (token) {
        await storeUnlock(input.value, token);
        overlay.classList.add('authgate--out');
        setTimeout(() => overlay.remove(), 350);
        try { onUnlocked?.(); } catch {}
        resolve({ unlocked: true });
      } else {
        btn.disabled = false;
        btn.textContent = 'Entrer';
        err.hidden = false;
        input.value = '';
        input.focus();
        overlay.querySelector('.authgate__box').classList.remove('authgate__box--shake');
        requestAnimationFrame(() => overlay.querySelector('.authgate__box').classList.add('authgate__box--shake'));
      }
    });
  });
}
