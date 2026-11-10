import test from 'node:test';
import assert from 'node:assert/strict';

import { createTelemetryStorePg, STREAM_BUCKET_SECONDS } from '../telemetry-store-pg.js';

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(params);
      const [keys, bucketSec, from] = params;
      return { rows: keys.map((k) => ({ series_key: k, bucket_ts: new Date(from), value: '1.5', unit: 'W' })), bucketSec };
    },
  };
}

test('iterateSeriesBuckets walks 6-h windows on the bucket grid without gaps', async () => {
  const pool = fakePool();
  const store = createTelemetryStorePg(pool);
  const chunks = [];
  for await (const rows of store.iterateSeriesBuckets({
    seriesKeys: ['pv_total_w', 'load_power_w'],
    start: '2026-09-25T01:30:00.000Z',
    end: '2026-09-26T00:00:00.000Z',
    bucketSec: 5,
  })) chunks.push(rows);
  const windows = pool.calls.map((p) => [p[2], p[3]]);
  assert.deepEqual(windows, [
    ['2026-09-25T01:30:00.000Z', '2026-09-25T06:00:00.000Z'],
    ['2026-09-25T06:00:00.000Z', '2026-09-25T12:00:00.000Z'],
    ['2026-09-25T12:00:00.000Z', '2026-09-25T18:00:00.000Z'],
    ['2026-09-25T18:00:00.000Z', '2026-09-26T00:00:00.000Z'],
  ]);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks[0][0], { key: 'pv_total_w', ts: '2026-09-25T01:30:00.000Z', value: 1.5, unit: 'W', resolution: 5 });
});

test('iterateSeriesBuckets rejects resolutions outside the streaming set', async () => {
  const store = createTelemetryStorePg(fakePool());
  assert.ok(STREAM_BUCKET_SECONDS.has(300) && !STREAM_BUCKET_SECONDS.has(900));
  await assert.rejects(async () => {
    for await (const _ of store.iterateSeriesBuckets({ seriesKeys: ['a'], start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z', bucketSec: 7 })) { /* */ }
  }, /unsupported bucketSec/);
});

// Strix H-0003: mit bucketSec fasst die Datenbank zusammen (eine Zeile je
// Reihe und Fenster) — der Web-Prozess lädt nicht mehr jede Rohzeile.
test('querySeries mit bucketSec: DISTINCT ON je Reihe und Fenster in SQL, Ergebnis nach Zeit', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [
        { series_key: 'b', ts_utc: new Date('2026-10-01T00:15:00Z'), resolution_seconds: 1, value_num: '2', unit: '%' },
        { series_key: 'a', ts_utc: new Date('2026-10-01T00:00:00Z'), resolution_seconds: 1, value_num: '1', unit: '%' },
      ] };
    },
  };
  const store = createTelemetryStorePg(pool);
  const rows = await store.querySeries({ seriesKeys: ['a', 'b'], start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z', maxResolution: 900, bucketSec: 900 });
  assert.match(calls[0].sql, /DISTINCT ON \(series_key, bucket_ts\)/);
  assert.match(calls[0].sql, /date_bin\(make_interval\(secs => \$\d+\)/);
  assert.ok(calls[0].params.includes(900));
  assert.deepEqual(rows.map((r) => r.key), ['a', 'b'], 'nach Zeit sortiert');
  assert.equal(rows[0].value, 1);
});

test('querySeries ohne bucketSec: bisheriges Verhalten (interne Aufrufer)', async () => {
  const calls = [];
  const store = createTelemetryStorePg({ async query(sql, params) { calls.push(sql); return { rows: [] }; } });
  await store.querySeries({ seriesKeys: ['a'], start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' });
  assert.doesNotMatch(calls[0], /DISTINCT ON/);
});

// Gegenprüfung 8e7bb8ef (P2): die zusammenfassende Abfrage liest alle Rohzeilen
// des Zeitraums; ohne Laufzeitgrenze blockierte eine Jahresabfrage den Pool.
test('querySeries mit bucketSec: eigene Verbindung mit statement_timeout (SET LOCAL)', async () => {
  const seen = [];
  const client = { async query(sql) { seen.push(typeof sql === 'string' ? sql.trim().split(/\s+/).slice(0, 3).join(' ') : sql); return { rows: [] }; }, release() { seen.push('release'); } };
  const pool = { async connect() { return client; }, async query() { throw new Error('nicht direkt'); } };
  const store = createTelemetryStorePg(pool);
  await store.querySeries({ seriesKeys: ['a'], start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z', maxResolution: 900, bucketSec: 900 });
  assert.equal(seen[0], 'BEGIN');
  assert.match(seen[1], /^SET LOCAL statement_timeout/);
  assert.equal(seen.at(-2), 'COMMIT');
  assert.equal(seen.at(-1), 'release');
});

// Codex aabaca15 (P2) zu Fable R3, P2-1: Übertrag-Stempel (5,3-s-Zyklus → 5 und
// 6 s) dürfen eine Live-Probe nicht aus der feinen Ansicht werfen.
test('iterateSeriesBuckets/querySeries: Auflösungsgrenze lässt Übertrag-Stempel (+1 s) zu, grobe Reihen nicht', async () => {
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  const store = createTelemetryStorePg(pool);
  for await (const _ of store.iterateSeriesBuckets({ seriesKeys: ['a'], start: '2026-10-01T00:00:00Z', end: '2026-10-01T01:00:00Z', bucketSec: 5 })) { /* */ }
  assert.match(calls[0].sql, /resolution_seconds <= \$5/);
  assert.equal(calls[0].params[1], 5, 'Fenster bleibt 5 s');
  assert.equal(calls[0].params[4], 6, 'Grenze 5 s + 1 s Übertrag');
  calls.length = 0;
  await store.querySeries({ seriesKeys: ['a'], start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z', maxResolution: 10 });
  assert.ok(calls[0].params.includes(11), 'flach: 10 s + 1 s');
  calls.length = 0;
  await store.querySeries({ seriesKeys: ['a'], start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z', maxResolution: 900 });
  assert.ok(calls[0].params.includes(900) && !calls[0].params.includes(901), 'Viertelstunden-Grenze unverändert');
});
