// Tests de la fusion champ par champ (node --test test/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProfiles, stampChanges, stampsOf, maxStamp, sameValue, profileFields } from '../js/merge.js';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function profile(over = {}, f = {}) {
  const base = { id: 'p1', name: 'Alice', professions: ['DOP'], notes: '', status: 'a_contacter', createdAt: iso(T0), updatedAt: iso(T0) };
  const p = { ...base, ...over };
  const stamps = {};
  for (const k of profileFields(p)) stamps[k] = T0;
  stamps.imgs = T0;
  p._f = { ...stamps, ...f };
  return p;
}

test('sameValue : vide, null, undefined et [] sont équivalents', () => {
  assert.ok(sameValue('', undefined));
  assert.ok(sameValue(null, ''));
  assert.ok(sameValue([], undefined));
  assert.ok(sameValue(['a', 'b'], ['a', 'b']));
  assert.ok(!sameValue(['a', 'b'], ['b', 'a']));
  assert.ok(!sameValue('x', ''));
  assert.ok(sameValue({ a: 1, b: [1] }, { b: [1], a: 1 }));
});

test('stampChanges : seuls les champs modifiés reçoivent un nouvel horodatage', () => {
  const prev = profile();
  const next = { ...prev, notes: 'rappeler lundi' };
  delete next._f;
  const changed = stampChanges(next, prev, T0 + 1000);
  assert.deepEqual(changed, ['notes']);
  assert.equal(next._f.notes, T0 + 1000);
  assert.equal(next._f.name, T0);
  assert.equal(next._f.imgs, T0);
});

test('stampChanges : une sauvegarde identique ne change rien', () => {
  const prev = profile();
  const next = { ...prev, notes: undefined };
  delete next._f;
  assert.deepEqual(stampChanges(next, prev, T0 + 5), []);
});

test('données anciennes sans _f : repli sur updatedAt', () => {
  const p = { id: 'x', name: 'Bob', updatedAt: iso(T0 + 50) };
  assert.equal(stampsOf(p).name, T0 + 50);
  assert.equal(stampsOf(p).imgs, T0 + 50);
  assert.equal(maxStamp(p), T0 + 50);
});

test('deux appareils modifient deux champs différents : les deux modifications survivent', () => {
  const local = profile({ notes: 'note du téléphone' }, { notes: T0 + 100 });
  const remote = profile({ status: 'favori' }, { status: T0 + 200 });
  const m = mergeProfiles(local, remote);
  assert.equal(m.result.notes, 'note du téléphone');
  assert.equal(m.result.status, 'favori');
  assert.ok(m.pushNeeded, 'le serveur doit recevoir la note');
  assert.ok(m.localChanged, 'le local doit recevoir le statut');
  assert.equal(m.result._f.notes, T0 + 100);
  assert.equal(m.result._f.status, T0 + 200);
  assert.equal(m.result.updatedAt, iso(T0 + 200));
});

test('même champ : le plus récent gagne, dans les deux sens', () => {
  const a = profile({ name: 'Alice A' }, { name: T0 + 10 });
  const b = profile({ name: 'Alice B' }, { name: T0 + 20 });
  assert.equal(mergeProfiles(a, b).result.name, 'Alice B');
  assert.equal(mergeProfiles(b, a).result.name, 'Alice B');
  assert.ok(!mergeProfiles(a, b).pushNeeded);
  assert.ok(mergeProfiles(b, a).pushNeeded);
});

test('égalité d\'horodatage avec valeurs différentes : le serveur gagne (convergence)', () => {
  const local = profile({ name: 'L' });
  const remote = profile({ name: 'R' });
  const m = mergeProfiles(local, remote);
  assert.equal(m.result.name, 'R');
  assert.ok(m.localChanged);
  assert.ok(!m.pushNeeded);
});

test('fusion idempotente : refusionner le résultat ne change plus rien', () => {
  const local = profile({ notes: 'n' }, { notes: T0 + 100 });
  const remote = profile({ status: 'favori' }, { status: T0 + 200 });
  const first = mergeProfiles(local, remote).result;
  const again = mergeProfiles(first, { ...first, imgs: {}, deleted: false });
  assert.ok(!again.localChanged);
  assert.ok(!again.pushNeeded);
});

test('suppression serveur sans modification locale postérieure : supprimé', () => {
  const local = profile();
  const remote = { id: 'p1', deleted: true, deletedAt: iso(T0 + 500), updatedAt: iso(T0 + 500) };
  const m = mergeProfiles(local, remote);
  assert.ok(m.deleted);
  assert.equal(m.result, null);
  assert.ok(m.localChanged);
});

test('suppression serveur mais modifié ici après : le profil revit et repart', () => {
  const local = profile({ notes: 'vivant' }, { notes: T0 + 900 });
  const remote = { id: 'p1', deleted: true, deletedAt: iso(T0 + 500), updatedAt: iso(T0 + 500) };
  const m = mergeProfiles(local, remote);
  assert.ok(!m.deleted);
  assert.ok(m.pushNeeded);
  assert.equal(m.result.notes, 'vivant');
});

test('profil absent du serveur : il part', () => {
  const m = mergeProfiles(profile(), null);
  assert.ok(m.pushNeeded && !m.localChanged && !m.deleted);
});

test('profil absent en local (nouveau venu d\'ailleurs) : adopté', () => {
  const m = mergeProfiles(null, { ...profile(), imgs: { 0: 'v1' }, deleted: false });
  assert.ok(m.localChanged && !m.pushNeeded);
  assert.equal(m.imgs, 'remote');
  assert.equal(m.result.imgs, undefined);
});

test('supprimé ici, puis modifié ailleurs après : il revit', () => {
  const remote = profile({ notes: 'modif après' }, { notes: T0 + 1000 });
  const m = mergeProfiles(null, remote, { pendingDeleteAt: T0 + 500 });
  assert.ok(!m.deleted && m.localChanged);
});

test('supprimé ici après la dernière modif distante : la suppression part', () => {
  const remote = profile();
  const m = mergeProfiles(null, remote, { pendingDeleteAt: T0 + 500 });
  assert.ok(m.deleted && m.pushNeeded);
});

test('photos : le jeu le plus récent fait foi', () => {
  const local = profile({}, { imgs: T0 + 300 });
  const remote = profile({}, { imgs: T0 + 100 });
  assert.equal(mergeProfiles(local, remote).imgs, 'local');
  assert.ok(mergeProfiles(local, remote).pushNeeded);
  assert.equal(mergeProfiles(remote, local).imgs, 'remote');
  assert.ok(mergeProfiles(remote, local).localChanged);
  assert.equal(mergeProfiles(local, local).imgs, 'same');
});

test('champ retiré d\'un côté plus récemment : il disparaît', () => {
  const local = profile({ email: 'a@b.c' });
  const remote = profile({ email: '' }, { email: T0 + 10 });
  const m = mergeProfiles(local, remote);
  assert.ok(sameValue(m.result.email, ''));
});

test('commutativité : A⊕B et B⊕A donnent le même contenu', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const fields = ['name', 'notes', 'status', 'email', 'tags'];
  for (let i = 0; i < 300; i++) {
    const mk = () => {
      const p = { id: 'p', updatedAt: iso(T0) };
      const f = {};
      for (const k of fields) {
        if (rnd() < 0.8) { p[k] = k === 'tags' ? ['t' + Math.floor(rnd() * 3)] : k + Math.floor(rnd() * 3); }
        f[k] = T0 + Math.floor(rnd() * 5) * 10;
      }
      f.imgs = T0 + Math.floor(rnd() * 3) * 10;
      p._f = f;
      return p;
    };
    const a = mk(), b = mk();
    const ab = mergeProfiles(a, b).result;
    const ba = mergeProfiles(b, a).result;
    for (const k of fields) {
      if (ab._f[k] !== ba._f[k]) assert.fail(`horodatage ${k} divergent`);
      // à égalité d'horodatage le « distant » gagne : seul cas où le contenu peut différer
      if (a._f[k] !== b._f[k]) assert.ok(sameValue(ab[k], ba[k]), `champ ${k} divergent (${ab[k]} vs ${ba[k]})`);
    }
  }
});
