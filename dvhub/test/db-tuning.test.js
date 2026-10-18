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
  assert.deepEqual(Object.keys(settings).sort(), ['checkpoint_timeout', 'min_wal_size', 'synchronous_commit', 'wal_compression', 'wal_writer_delay']);
});

import { tuneTimescale } from '../services/db-tuning.js';

test('Timescale: Tagesblöcke + Kompression nach 2 Tagen, idempotent', async () => {
  let interval = 7 * 86400; let after = '7 days'; const calls = [];
  const q = async (sql) => {
    calls.push(sql);
    if (sql.includes('pg_extension')) return { rows: [{ 1: 1 }] };
    if (sql.includes('dimensions')) return { rows: [{ s: interval }] };
    if (sql.includes('set_chunk_time_interval')) { interval = 86400; return { rows: [] }; }
    if (sql.includes("config->>'compress_after'")) return { rows: after ? [{ after }] : [] };
    if (sql.includes('remove_compression_policy')) { after = null; return { rows: [] }; }
    if (sql.includes('add_compression_policy')) { after = '2 days'; return { rows: [] }; }
    return { rows: [] };
  };
  const r1 = await tuneTimescale(q);
  assert.deepEqual(r1.changed, ['chunk_interval', 'compress_after']);
  const r2 = await tuneTimescale(q);
  assert.deepEqual(r2.changed, []);
  assert.equal(interval, 86400);
  assert.equal(after, '2 days');
});

test('Timescale: ohne Extension nichts tun', async () => {
  const r = await tuneTimescale(async () => ({ rows: [] }));
  assert.equal(r.skipped, 'no_timescaledb');
});

import { dbPoolMax } from '../services/db-tuning.js';
test('DB-Verbindungen nach Profil begrenzt', () => {
  assert.equal(dbPoolMax(160), 3);
  assert.equal(dbPoolMax(512), 5);
  assert.equal(dbPoolMax(4096), 5);
});

// 2026-10-18: timescaledb-tune setzt min_wal_size = 512MB — der Schreibpuffer
// belegte damit auf jeder Box dauerhaft 512 MB (A7S: pg_wal 512 MB). 64 MB
// reichen bei schreibarmem Betrieb (checkpoint_timeout 15 min).
test('Schreibpuffer: min_wal_size 512MB aus timescaledb-tune wird auf 64MB gesetzt', async () => {
  const pg = fakePg([
    { name: 'min_wal_size', setting: '512', unit: 'MB', source: 'configuration file' },
    { name: 'synchronous_commit', setting: 'off', unit: null, source: 'configuration file' },
  ]);
  const r = await applyDbTuning((q, p) => pg.query(q, p), { includeMemory: false });
  assert.deepEqual(r.changed, ['min_wal_size']);
  assert.ok(pg.calls.includes("ALTER SYSTEM SET min_wal_size = '64MB'"));
  const again = fakePg([{ name: 'min_wal_size', setting: '64', unit: 'MB', source: 'configuration file' }]);
  assert.deepEqual((await applyDbTuning((q, p) => again.query(q, p), { includeMemory: false })).changed, [], 'idempotent');
});
