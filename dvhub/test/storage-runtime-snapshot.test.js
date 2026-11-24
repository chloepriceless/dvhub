// test/storage-runtime-snapshot.test.js — Platz-Wache im getrennten Betrieb
// (DVHUB_ENABLE_RUNTIME_WORKER=1): Die Wache läuft im Runtime-Prozess; ihr
// Stand und ihre Hinweise müssen im Web-Prozess ankommen (Codex 949b20f2, P2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeSnapshot, applyRuntimeStorage, STORAGE_WARNING_IDS } from '../runtime-state.js';

test('Schnappschuss trägt Stand, Kompression, tuneTimescale und nur die Speicher-Hinweise', () => {
  const snap = buildRuntimeSnapshot({
    storage: {
      status: { level: 'wenig', freePct: 8 },
      compression: { ok: false, reason: 'apache' },
      timescaleTuning: { skipped: 'apache' },
      warnings: [
        { id: 'db_compression', message: 'Datenbank ohne Kompression …', severity: 'error' },
        { id: 'storage', message: 'Speicher wenig' },
        { id: 'tls', message: 'kein Zertifikat' },
      ],
    },
  });
  assert.equal(snap.storage.status.level, 'wenig');
  assert.equal(snap.storage.compression.reason, 'apache');
  assert.deepEqual(snap.storage.warnings.map((w) => w.id), ['db_compression', 'storage']);
  assert.equal(snap.storage.warnings[0].severity, 'error');
  assert.ok(!('storage' in buildRuntimeSnapshot({})), 'ohne Wache kein Feld');
});

test('Web-Prozess übernimmt die Hinweise (ersetzt nur die Speicher-Hinweise)', () => {
  const state = { systemWarnings: [{ id: 'tls', message: 'x' }, { id: 'storage', message: 'alt' }] };
  applyRuntimeStorage(state, buildRuntimeSnapshot({
    storage: { status: { level: 'ok' }, compression: { ok: false }, warnings: [{ id: 'db_compression', message: 'rot', severity: 'error' }] },
  }));
  assert.deepEqual(state.systemWarnings.map((w) => w.id), ['tls', 'db_compression']);
  assert.equal(state.storageRuntime.compression.ok, false);
  applyRuntimeStorage(state, buildRuntimeSnapshot({ storage: { status: null, warnings: [] } }));
  assert.deepEqual(state.systemWarnings.map((w) => w.id), ['tls'], 'Hinweis verschwindet auch im Web-Prozess');
  applyRuntimeStorage(state, buildRuntimeSnapshot({}));
  assert.deepEqual(state.systemWarnings.map((w) => w.id), ['tls'], 'Schnappschuss ohne Feld ändert nichts');
  assert.deepEqual([...STORAGE_WARNING_IDS], ['storage', 'storage_other', 'db_compression']);
});

import { validateRuntimeCommand } from '../runtime-commands.js';
test('Worker-Befehl storage_profile_choose: nur bekannte Wahl', () => {
  assert.equal(validateRuntimeCommand({ type: 'storage_profile_choose', payload: { choice: 'auto' } }).ok, true);
  assert.equal(validateRuntimeCommand({ type: 'storage_profile_choose', payload: { choice: 'winzig' } }).ok, true);
  assert.equal(validateRuntimeCommand({ type: 'storage_profile_choose', payload: { choice: 'rm -rf' } }).ok, false);
});
