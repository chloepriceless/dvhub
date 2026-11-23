import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageGuard, storageLevel, nextKeepDays, compressionWarningText, tuningCompressionIssue, COMPRESSION_WARNING_ID } from '../services/storage-guard.js';

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

// Attrappe einer Community-Box (Standard) bzw. — per Option — Apache, ohne Kompression usw.
function fakeDb({ ts = true, oldestDays = 500, aggUntil = '2026-09-30T00:00:00Z', license = 'timescale', hypertable = true,
  compressionOn = true, policies = 1, failing = null, compressThrows = null, dropThrows = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, p) {
      calls.push([sql.replace(/\s+/g, ' ').trim(), p]);
      if (sql.includes('pg_database_size')) return { rows: [{ b: 2 * 1048576 * 1024 }] };
      if (sql.includes('pg_extension')) return { rows: ts ? [{}] : [] };
      if (sql.includes("current_setting('timescaledb.license'")) return { rows: [{ lic: license }] };
      if (sql.includes('timescaledb_information.hypertables')) {
        return { rows: hypertable ? [{ on: compressionOn, policies: String(policies), failing }] : [] };
      }
      if (sql.includes('compress_chunk')) {
        if (compressThrows) throw new Error(compressThrows);
        return { rows: [{ n: 3 }] };
      }
      if (sql.includes('drop_chunks') && dropThrows) throw new Error(dropThrows);
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

test('6c: storage_guard_error wird gedrosselt (gleicher Fehler nicht in jedem Zyklus)', async () => {
  const logs = [];
  let t = 1_000_000;
  const g = createStorageGuard({
    getDb: () => { throw new Error('TimescaleDB-Apache nicht erreichbar'); },
    statfs: () => ({ bsize: 4096, blocks: 1000, bavail: 500 }),
    pushLog: (event, data, level) => logs.push({ event, data, level }),
    now: () => t,
  });
  await g.check();
  await g.check(); // gleicher Fehler, gleiche Zeit → nur einmal
  t += 10 * 60_000; // 10 min später → immer noch gedrosselt (<1 h)
  await g.check();
  assert.equal(logs.filter((l) => l.event === 'storage_guard_error').length, 1);
  t += 3600_001; // über 1 h → wieder einmal
  await g.check();
  assert.equal(logs.filter((l) => l.event === 'storage_guard_error').length, 2);
});

// ── 23.11.2026: Kundenfall 12-GB-Platte, Apache-Edition (S12/S13) ──────────────
const APACHE_ERR = 'function "compress_chunk" is not supported under the current "apache" license';

test('Apache, wenig Platz: kein compress_chunk-Abbruch — Hinweis steht und eine Stufe Rohwerte geht per drop_chunks', async () => {
  // Echte Apache-Box: compress_chunk wirft genau diesen Fehler (im Image timescale/timescaledb:2.30.2-pg17
  // mit timescaledb.license=apache nachgestellt), drop_chunks geht.
  const db = fakeDb({ license: 'apache', compressThrows: APACHE_ERR, oldestDays: 500, aggUntil: '2026-09-30T00:00:00Z' });
  const warn = {}; const sev = {}; const logs = [];
  const NOW = Date.parse('2026-11-23T12:00:00Z');
  const r = await createStorageGuard({
    getDb: () => db, statfs: stat(8), now: () => NOW,
    setWarning: (id, m, s) => { warn[id] = m; sev[id] = s; },
    pushLog: (e, d, l) => logs.push({ e, d, l }),
  }).check();
  assert.equal(r.level, 'wenig');
  assert.ok(!db.calls.some(([s]) => /compress_chunk/.test(s)), 'unter Apache nicht komprimieren');
  const drop = r.actions.find((a) => a.action === 'drop_raw');
  assert.ok(drop && !drop.error, `Rohwerte entfernt: ${JSON.stringify(r.actions)}`);
  assert.equal(drop.keepDays, 365);
  assert.ok(db.calls.some(([s]) => /SELECT drop_chunks/.test(s)), 'drop_chunks geht auch unter Apache');
  assert.match(warn.storage, /Speicher wenig/);
  assert.match(warn.storage, /älter als 365 Tage/);
  assert.match(warn[COMPRESSION_WARNING_ID], /Datenbank ohne Kompression/);
  assert.match(warn[COMPRESSION_WARNING_ID], /Apache/);
  assert.equal(sev[COMPRESSION_WARNING_ID], 'error', 'rot');
  assert.equal(r.compression.ok, false);
  assert.equal(r.compression.reason, 'apache');
  assert.ok(logs.some((l) => l.e === 'storage_compression_failed'), 'Eintrag fürs Installateur-Portal (…_failed)');
});

test('compress_chunk wirft (auch wenn eingeschaltet): Löschstufe und Hinweise laufen trotzdem', async () => {
  const db = fakeDb({ compressThrows: 'kaputt', oldestDays: 200 });
  const warn = {};
  const r = await createStorageGuard({
    getDb: () => db, statfs: stat(3), now: () => Date.parse('2026-11-23T12:00:00Z'),
    setWarning: (id, m) => { warn[id] = m; },
  }).check();
  assert.equal(r.level, 'kritisch');
  assert.ok(r.actions.find((a) => a.action === 'compress')?.error, 'Fehler steht in den Maßnahmen');
  assert.ok(r.actions.find((a) => a.action === 'drop_raw' && !a.error), 'trotzdem gelöscht');
  assert.match(warn.storage, /Speicher kritisch/);
  assert.match(warn[COMPRESSION_WARNING_ID], /Komprimieren ist gescheitert/);
});

test('compress_chunk-Fehler bleibt stehen, bis es wieder klappt (kein Flattern alle 30 min)', async () => {
  let throws = 'kaputt';
  const db = fakeDb({ oldestDays: 20 });
  const orig = db.query.bind(db);
  db.query = async (sql, p) => { if (sql.includes('compress_chunk') && throws) throw new Error(throws); return orig(sql, p); };
  const warn = {}; const logs = [];
  const g = createStorageGuard({ getDb: () => db, statfs: stat(15), setWarning: (id, m) => { warn[id] = m; }, pushLog: (e) => logs.push(e) });
  await g.check();
  await g.check();
  assert.match(warn[COMPRESSION_WARNING_ID], /gescheitert/);
  assert.equal(logs.filter((e) => e === 'storage_compression_failed').length, 1, 'nur einmal gemeldet');
  assert.ok(!logs.includes('storage_compression_ok'));
  throws = null;
  await g.check();
  assert.equal(warn[COMPRESSION_WARNING_ID], null, 'nach Erfolg weg');
});

test('drop_chunks scheitert: Hinweis steht trotzdem, Fehler in den Maßnahmen', async () => {
  const db = fakeDb({ dropThrows: 'Sperre', oldestDays: 500 });
  const warn = {};
  const r = await createStorageGuard({
    getDb: () => db, statfs: stat(8), now: () => Date.parse('2026-11-23T12:00:00Z'),
    setWarning: (id, m) => { warn[id] = m; },
  }).check();
  assert.ok(r.actions.find((a) => a.action === 'drop_raw')?.error);
  assert.match(warn.storage, /Speicher wenig/);
  assert.ok(db.calls.some(([s]) => s === 'ROLLBACK'));
});

test('Ohne Kompression bei genug Platz: roter Hinweis trotzdem, nichts gelöscht', async () => {
  for (const [opts, re] of [
    [{ ts: false }, /TimescaleDB ist nicht installiert/],
    [{ license: 'apache' }, /Apache-Edition/],
    [{ hypertable: false }, /nicht für TimescaleDB eingerichtet/],
    [{ compressionOn: false }, /Kompression ist für die Messwerte ausgeschaltet/],
    [{ policies: 0 }, /keine automatische Kompression/],
    [{ failing: true }, /scheitert seit mehreren Tagen/],
  ]) {
    const db = fakeDb(opts); const warn = {};
    const r = await createStorageGuard({ getDb: () => db, statfs: stat(60), setWarning: (id, m) => { warn[id] = m; } }).check();
    assert.equal(r.level, 'ok');
    assert.match(warn[COMPRESSION_WARNING_ID] || '', re, JSON.stringify(opts));
    assert.match(warn[COMPRESSION_WARNING_ID], /110–230 MB pro Tag/);
    assert.equal(warn.storage, null);
    assert.ok(!db.calls.some(([s]) => /compress_chunk|drop_chunks|DELETE/.test(s)));
  }
});

test('Community mit Kompression: kein Hinweis „ohne Kompression“', async () => {
  const db = fakeDb(); const warn = {}; const logs = [];
  const r = await createStorageGuard({ getDb: () => db, statfs: stat(60), setWarning: (id, m) => { warn[id] = m; }, pushLog: (e) => logs.push(e) }).check();
  assert.equal(warn[COMPRESSION_WARNING_ID], null);
  assert.equal(r.compression.ok, true);
  assert.ok(!logs.includes('storage_compression_failed'));
});

test('Portal-Eintrag nur bei Änderung und höchstens einmal am Tag', async () => {
  let t = Date.parse('2026-11-23T00:00:00Z');
  const db = fakeDb({ license: 'apache' }); const logs = [];
  const g = createStorageGuard({ getDb: () => db, statfs: stat(60), now: () => t, pushLog: (e) => logs.push(e) });
  await g.check(); t += 30 * 60_000; await g.check();
  assert.equal(logs.filter((e) => e === 'storage_compression_failed').length, 1);
  t += 24 * 3600_000; await g.check();
  assert.equal(logs.filter((e) => e === 'storage_compression_failed').length, 2);
});

test('checkCompression: Ergebnis von tuneTimescale wird nicht mehr verschluckt', async () => {
  const db = fakeDb({ compressionOn: false }); const warn = {};
  const g = createStorageGuard({
    getDb: () => db, statfs: stat(60), setWarning: (id, m) => { warn[id] = m; },
    getTuning: () => ({ error: 'permission denied for table timeseries_samples' }),
  });
  await g.checkCompression();
  assert.match(warn[COMPRESSION_WARNING_ID], /ausgeschaltet \(permission denied/);
  // Probe nicht möglich → der von tuneTimescale gemeldete Grund gilt.
  const broken = { query: async () => { throw new Error('weg'); } }; const w2 = {};
  await createStorageGuard({ getDb: () => broken, setWarning: (id, m) => { w2[id] = m; }, getTuning: () => ({ skipped: 'apache' }) }).checkCompression();
  assert.match(w2[COMPRESSION_WARNING_ID], /Apache/);
});

test('tuningCompressionIssue und Hinweistext', () => {
  assert.equal(tuningCompressionIssue({ changed: [], compressAfter: '2 days' }), null);
  assert.equal(tuningCompressionIssue({ skipped: 'apache' }).reason, 'apache');
  assert.equal(tuningCompressionIssue({ deferred: 'compression_lock_timeout' }).reason, 'not_enabled');
  assert.equal(tuningCompressionIssue({ error: 'x' }).reason, 'tuning_error');
  const nativ = compressionWarningText({ reason: 'apache', provision: { result: 'apache', at: '2026-11-20T03:00:00Z', error: 'Community-Paket nicht installierbar' } });
  assert.match(nativ, /bei jedem Update und Neustart automatisch, auf die TimescaleDB-Community-Edition umzustellen/);
  assert.match(nativ, /Der letzte Versuch am 20\.11\.2026 ist gescheitert: Community-Paket nicht installierbar/);
  assert.match(nativ, /Support/);
  const docker = compressionWarningText({ reason: 'no_hypertable', container: true });
  assert.doesNotMatch(docker, /Update und Neustart/);
  assert.match(docker, /Support/);
});

test('Statusdatei der Nachrüstung (nativ) fließt in den Hinweis ein', async () => {
  const db = fakeDb({ license: 'apache' }); const warn = {};
  await createStorageGuard({
    getDb: () => db, statfs: stat(60), getDataDir: () => '/daten', setWarning: (id, m) => { warn[id] = m; },
    readFile: (p) => {
      assert.equal(p, '/daten/timescale-status.json');
      return JSON.stringify({ edition: 'apache', provision: { result: 'apache', at: '2026-11-22T01:00:00Z', error: 'kein Paket für forky' } });
    },
  }).check();
  assert.match(warn[COMPRESSION_WARNING_ID], /am 22\.11\.2026 ist gescheitert: kein Paket für forky/);
});
