import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageGuard, storageLevel, nextKeepDays } from '../services/storage-guard.js';

test('Stufen und Aufbewahrungsschritte', () => {
  assert.equal(storageLevel(50), 'ok');
  assert.equal(storageLevel(15), 'knapp');
  assert.equal(storageLevel(8), 'wenig');
  assert.equal(storageLevel(3), 'kritisch');
  assert.equal(nextKeepDays(500), 365);
  assert.equal(nextKeepDays(200), 180);
  assert.equal(nextKeepDays(45), 30);
  assert.equal(nextKeepDays(25), null, 'die letzten 30 Tage bleiben immer');
});

function fakeDb({ ts = true, oldestDays = 500, aggUntil = '2026-09-30T00:00:00Z' } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, p) {
      calls.push([sql.replace(/\s+/g, ' ').trim(), p]);
      if (sql.includes('pg_database_size')) return { rows: [{ b: 2 * 1048576 * 1024 }] };
      if (sql.includes('pg_extension')) return { rows: ts ? [{}] : [] };
      if (sql.includes('compress_chunk')) return { rows: [{ n: 3 }] };
      if (sql.includes('oldest_days')) return { rows: [{ oldest_days: oldestDays, agg_until: aggUntil }] };
      return { rows: [], rowCount: 0 };
    },
  };
}
const stat = (freePct) => () => ({ blocks: 1000, bsize: 1048576 * 3, bavail: Math.round(10 * freePct) });

test('Genug Platz: nichts anfassen, kein Hinweis', async () => {
  const db = fakeDb(); const warn = {};
  const g = createStorageGuard({ getDb: () => db, statfs: stat(40), setWarning: (id, m) => { warn[id] = m; } });
  const r = await g.check();
  assert.equal(r.level, 'ok');
  assert.ok(!db.calls.some(([s]) => /compress_chunk|drop_chunks|DELETE/.test(s)));
  assert.equal(warn.storage, null);
});

test('Knapp: nur früher komprimieren', async () => {
  const db = fakeDb(); const warn = {};
  const r = await createStorageGuard({ getDb: () => db, statfs: stat(15), setWarning: (id, m) => { warn[id] = m; } }).check();
  assert.deepEqual(r.actions.map((a) => a.action), ['compress']);
  assert.ok(!db.calls.some(([s]) => /drop_chunks/.test(s)));
  assert.match(warn.storage, /knapp/);
});

test('Wenig: eine Stufe Rohwerte weg, nie jünger als die 15-min-Werte', async () => {
  const db = fakeDb({ oldestDays: 500, aggUntil: '2025-01-01T00:00:00Z' }); const warn = {};
  const NOW = Date.parse('2026-10-01T12:00:00Z');
  const r = await createStorageGuard({ getDb: () => db, statfs: stat(8), now: () => NOW, setWarning: (id, m) => { warn[id] = m; } }).check();
  const drop = r.actions.find((a) => a.action === 'drop_raw');
  assert.equal(drop.keepDays, 365);
  assert.equal(drop.before, '2025-01-01T00:00:00.000Z', 'begrenzt durch den letzten verdichteten Slot');
  assert.match(warn.storage, /älter als 365 Tage/);
  const seq = db.calls.map(([q]) => q.split(' ').slice(0, 3).join(' '));
  const b = seq.indexOf('BEGIN');
  assert.ok(seq[b + 1].startsWith('CREATE TEMP TABLE'), 'Preise/Altdaten zuerst sichern');
  assert.match(db.calls[b + 1][0], /scope <> 'live' OR series_key LIKE 'price%'/);
  assert.ok(seq[b + 2].startsWith('SELECT drop_chunks'));
  assert.ok(seq[b + 3].startsWith('INSERT INTO timeseries_samples'));
  assert.equal(seq[b + 4], 'COMMIT');
});

test('Ohne TimescaleDB: in Portionen löschen', async () => {
  const db = fakeDb({ ts: false, oldestDays: 100 });
  await createStorageGuard({ getDb: () => db, statfs: stat(3), now: () => Date.parse('2026-10-01T00:00:00Z') }).check();
  assert.ok(db.calls.some(([s]) => /DELETE FROM timeseries_samples WHERE ctid IN/.test(s)));
  assert.ok(!db.calls.some(([s]) => /compress_chunk/.test(s)));
});
