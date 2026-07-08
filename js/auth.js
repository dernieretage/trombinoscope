// Porte d'entrée du Trombinoscope.
//
// Le mot de passe saisi sert de clé : il déchiffre (PBKDF2 + AES-256-GCM) le
// token d'écriture GitHub embarqué ci-dessous. Mot de passe correct = le
// déchiffrement réussit (le tag GCM valide) = l'appareil peut lire ET écrire.
// Aucun token à coller, aucune configuration par appareil.

import { getMeta, setMeta } from './store.js';

const VAULT = {
  salt: 'ZXh6Y/Rdc1TVjqb1d4bUdg==',
  iv: '+noXWbMnTEEAg/tv',
  ct: '9YbM6AwfDa0dXORihO4aDXYwaHe2PCR3Ie8J4vlkU7gLKcCEpwjgCVJBjNx9ZlXfuD+/omXTKk/c2GjuBQIt4jbel8Hk1JdJ4X0lUqxEaqW5k3MuFnWEnBuVmiVrMRzTNMjFJpXcCE1cDGL0GA==',
  iter: 310000,
};

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
  return !!(await getMeta('cloud_repo_token'));
}

export async function lock() {
  await setMeta('cloud_repo_token', null);
}

/**
 * Affiche la porte mot de passe si l'appareil n'est pas déjà déverrouillé.
 * Résout quand l'accès est acquis. onUnlocked est appelé uniquement lors d'un
 * NOUVEAU déverrouillage (pas si le token était déjà en place).
 */
export async function ensureAuthGate({ onUnlocked } = {}) {
  if (await isUnlocked()) return { alreadyUnlocked: true };

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'auth-gate';
    overlay.className = 'authgate';
    overlay.innerHTML = `
      <div class="authgate__box" role="dialog" aria-modal="true" aria-labelledby="authgate-title">
        <div class="authgate__mark">T</div>
        <h1 id="authgate-title" class="authgate__title">Trombinoscope</h1>
        <p class="authgate__sub">Facteur Humain — accès réservé</p>
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
        await setMeta('cloud_repo_token', token);
        await setMeta('cloud_auto', true);
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
