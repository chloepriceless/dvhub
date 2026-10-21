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
    if (sql.includes("current_setting('timescaledb.license'")) return { rows: [{ lic: 'timescale' }] };
    if (sql.includes('compression_enabled')) return { rows: [{ on: true }] };
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

// 21.10.2026 (Feldbox 9753e9e5): unter Apache installiert, auf Community
// nachgerüstet → 014 hat die Kompression nie eingeschaltet, die Regel scheiterte
// bei jedem Start mit „columnstore not enabled on hypertable“.
function fakeTs({ lic = 'timescale', compression = false, after = null, lockBusy = false } = {}) {
  const st = { compression, after, calls: [] };
  st.q = async (sql) => {
    st.calls.push(sql);
    if (sql.includes('pg_extension')) return { rows: [{ 1: 1 }] };
    if (sql.includes('dimensions')) return { rows: [{ s: 86400 }] };
    if (sql.includes("current_setting('timescaledb.license'")) return { rows: [{ lic }] };
    if (sql.includes('compression_enabled')) return { rows: [{ on: st.compression }] };
    if (sql.includes('timescaledb.compress,')) {
      if (lockBusy) { const e = new Error('canceling statement due to lock timeout'); e.code = '55P03'; throw e; }
      st.compression = true; return { rows: [] };
    }
    if (sql.includes("config->>'compress_after'")) return { rows: st.after ? [{ after: st.after }] : [] };
    if (sql.includes('add_compression_policy')) {
      if (!st.compression) throw new Error('columnstore not enabled on hypertable "timeseries_samples"');
      st.after = '2 days'; return { rows: [] };
    }
    return { rows: [] };
  };
  return st;
}

test('Timescale: Community ohne Kompression → einschalten (wie 014), dann Regel', async () => {
  const st = fakeTs();
  const r = await tuneTimescale(st.q);
  assert.deepEqual(r.changed, ['compression_enabled', 'compress_after']);
  const iAlter = st.calls.findIndex((c) => c.includes('timescaledb.compress,'));
  const iPolicy = st.calls.findIndex((c) => c.includes('add_compression_policy'));
  assert.ok(iAlter >= 0 && iAlter < iPolicy, 'ALTER vor der Regel');
  const alter = st.calls[iAlter];
  assert.match(alter, /SET LOCAL lock_timeout = '10s';/);
  assert.match(alter, /compress_segmentby = 'series_key,scope,source'/);
  assert.match(alter, /compress_orderby = 'ts_utc desc'/);
  const again = await tuneTimescale(st.q);
  assert.deepEqual(again.changed, [], 'zweiter Lauf ändert nichts');
});

test('Timescale: Kompression schon an → kein ALTER', async () => {
  const st = fakeTs({ compression: true, after: '2 days' });
  const r = await tuneTimescale(st.q);
  assert.deepEqual(r.changed, []);
  assert.ok(!st.calls.some((c) => c.includes('timescaledb.compress,')));
});

test('Timescale: Apache → keine Kompression, keine Regel, kein Fehler', async () => {
  const st = fakeTs({ lic: 'apache' });
  const r = await tuneTimescale(st.q);
  assert.equal(r.skipped, 'apache');
  assert.ok(!st.calls.some((c) => c.includes('timescaledb.compress,') || c.includes('compression_policy')));
});

test('Timescale: Hypertable gesperrt → aufgeschoben, kein Fehler, keine Regel', async () => {
  const st = fakeTs({ lockBusy: true });
  const r = await tuneTimescale(st.q);
  assert.equal(r.deferred, 'compression_lock_timeout');
  assert.ok(!st.calls.some((c) => c.includes('add_compression_policy')));
});
