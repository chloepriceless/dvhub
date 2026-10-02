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
