import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryProfile, dbBudgetMb, desiredSettings, applyDbTuning } from '../services/db-tuning.js';

test('Footprint: klein für alle, winzig nur bei sehr wenig RAM', () => {
  assert.equal(memoryProfile(160).name, 'winzig');
  assert.equal(memoryProfile(256).name, 'klein');
  assert.equal(memoryProfile(4096).name, 'klein', 'große Boxen werden nicht hochskaliert');
  assert.equal(memoryProfile(4096).shared_buffers, '64MB');
});

test('Budget: Container-Limit oder 25 % RAM', () => {
  assert.equal(dbBudgetMb({ env: { DVHUB_DB_MEM_LIMIT: '160m' } }), 160);
  assert.equal(dbBudgetMb({ env: { DVHUB_DB_MEM_LIMIT: '1g' } }), 1024);
  assert.equal(dbBudgetMb({ env: {}, totalMemBytes: 512 * 1024 * 1024 }), 128);
  assert.equal(memoryProfile(dbBudgetMb({ env: {}, totalMemBytes: 512 * 1024 * 1024 })).name, 'winzig', '512-MB-Board');
});

function fakePg(rows) {
  const state = Object.fromEntries(rows.map((r) => [r.name, { ...r }]));
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(sql);
      if (sql.startsWith('SELECT name, setting')) return { rows: params[0].filter((n) => state[n]).map((n) => state[n]) };
      if (sql.startsWith('ALTER SYSTEM')) { const n = /SET "?([a-z_.]+)"?/.exec(sql)[1]; state[n].pending_restart = ['shared_buffers'].includes(n); return { rows: [] }; }
      if (sql.includes('pending_restart')) return { rows: Object.values(state).filter((r) => r.pending_restart) };
      return { rows: [] };
    },
  };
}

test('Anwenden: nur Abweichendes, Kommandozeile bleibt, Neustart-Bedarf gemeldet', async () => {
  const pg = fakePg([
    { name: 'synchronous_commit', setting: 'on', unit: null, source: 'default' },
    { name: 'wal_compression', setting: 'pglz', unit: null, source: 'configuration file' },
    { name: 'checkpoint_timeout', setting: '900', unit: 's', source: 'configuration file' },
    { name: 'wal_writer_delay', setting: '1000', unit: 'ms', source: 'configuration file' },
    { name: 'shared_buffers', setting: '16384', unit: '8kB', source: 'configuration file' },
    { name: 'work_mem', setting: '2048', unit: 'kB', source: 'command line' },
    { name: 'maintenance_work_mem', setting: '16384', unit: 'kB', source: 'default' },
  ]);
  const r = await applyDbTuning((q, p) => pg.query(q, p), { budgetMb: 160 * 4 });
  assert.equal(r.profile, 'klein');
  assert.deepEqual(r.changed.sort(), ['shared_buffers', 'synchronous_commit']);
  assert.deepEqual(r.skippedCommandLine, ['work_mem']);
  assert.deepEqual(r.pendingRestart, ['shared_buffers']);
  assert.ok(pg.calls.includes('SELECT pg_reload_conf()'));
  // zweiter Lauf ändert nichts mehr (idempotent)
});

test('Schreibwerte auch ohne Speicherprofil', () => {
  const { settings } = desiredSettings({ includeMemory: false });
  assert.deepEqual(Object.keys(settings).sort(), ['checkpoint_timeout', 'synchronous_commit', 'wal_compression', 'wal_writer_delay']);
});
