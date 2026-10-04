#!/usr/bin/env node
// Scelle le coffre d'écriture du Trombinoscope dans js/auth.js.
//
// Le coffre = le token GitHub d'écriture, chiffré (PBKDF2-SHA256 310k + AES-256-GCM)
// avec le mot de passe du site. Tout appareil qui connaît le mot de passe
// dérive le token ; re-sceller avec un token frais répare TOUS les appareils
// au prochain chargement (aucune re-saisie si le mot de passe ne change pas).
//
// Usage (depuis le dossier trombinoscope/) :
//   GH_TOKEN=$(gh auth token) node scripts/seal-vault.mjs
//   → demande le mot de passe (saisie masquée), vérifie le token contre le
//     repo, chiffre, réécrit le bloc VAULT de js/auth.js. N'affiche JAMAIS
//     le token ni le mot de passe.
//
// Variante : node scripts/seal-vault.mjs   (demande aussi le token, masqué)

import { webcrypto as crypto } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const AUTH_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'auth.js');
const REPO = 'dernieretage/trombinoscope';
const ITER = 310000;

// Saisie : en TTY, readline unique avec masquage par étoiles ; en entrée pipée
// (tests/automation), on lit TOUT stdin d'avance et on distribue ligne à ligne
// (readline droppe les lignes arrivées entre deux questions).
const IS_TTY = !!process.stdin.isTTY;
let RL = null;
let PIPED = null; // file de lignes pour l'entrée non-TTY

if (IS_TTY) {
  RL = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
} else {
  const raw = readFileSync(0, 'utf8');
  PIPED = raw.split('\n');
}

function promptHidden(question) {
  if (!IS_TTY) {
    process.stdout.write(question + '\n');
    const line = PIPED.length ? PIPED.shift() : '';
    return Promise.resolve(line.trim());
  }
  return new Promise((resolve) => {
    const onData = () => {
      // réécrit la ligne avec des étoiles (saisie masquée)
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write(question + '*'.repeat(RL.line.length));
    };
    process.stdin.on('data', onData);
    RL.question(question, (answer) => {
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function verifyToken(token) {
  const res = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 401) throw new Error('Token invalide (401).');
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status}.`);
  const data = await res.json();
  if (!data.permissions?.push) throw new Error('Ce token n\'a PAS le droit d\'écriture sur ' + REPO + '.');
  return data.full_name;
}

function b64(u8) { return Buffer.from(u8).toString('base64'); }

async function seal(password, token) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(token)));
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

const src = readFileSync(AUTH_PATH, 'utf8');
const verMatch = src.match(/const VAULT = \{\s*\n\s*ver:\s*(\d+)/);
if (!verMatch) { console.error('✗ Bloc VAULT introuvable dans js/auth.js'); process.exit(1); }
const newVer = parseInt(verMatch[1], 10) + 1;

const token = (process.env.GH_TOKEN || '').trim() || await promptHidden('Token GitHub (écriture sur ' + REPO + ') : ');
if (!token) { console.error('✗ Aucun token fourni.'); process.exit(1); }

process.stdout.write('Vérification du token… ');
const repoName = await verifyToken(token);
console.log(`✓ écriture OK sur ${repoName}`);

const pw = await promptHidden('Mot de passe du site : ');
const pw2 = await promptHidden('Confirme le mot de passe : ');
if (!pw || pw !== pw2) { console.error('✗ Les mots de passe ne correspondent pas.'); process.exit(1); }

const v = await seal(pw, token);
const newBlock = `const VAULT = {
  ver: ${newVer},
  salt: '${v.salt}',
  iv: '${v.iv}',
  ct: '${v.ct}',
  iter: ${ITER},
};`;
const out = src.replace(/const VAULT = \{[\s\S]*?\};/, newBlock);
if (out === src) { console.error('✗ Remplacement du bloc VAULT échoué.'); process.exit(1); }
writeFileSync(AUTH_PATH, out);
if (RL) RL.close();
console.log(`✓ Coffre scellé (ver ${newVer}) dans js/auth.js — rien de sensible affiché.`);
console.log('  Prochaine étape : committer js/auth.js et déployer (main + cherry-pick gh-pages).');
