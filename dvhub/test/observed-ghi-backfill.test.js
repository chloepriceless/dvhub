// test/observed-ghi-backfill.test.js -- T-CURTAIL Increment 1.
// Pure-logic tests for the Open-Meteo Archive observed-GHI backfill. No DB,
// no network — fetch + store are faked. Verifies parsing, deterministic date
// chunking, gap computation, and idempotency of the backfill upsert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArchiveUrl,
  parseArchiveResponse,
  addDaysUtc,
  chunkDateRange,
  computeBackfillWindows,
  backfillObservedGhi,
  ARCHIVE_SOURCE,
} from '../services/forecast/open-meteo-archive.js';

test('buildArchiveUrl: archive host, unixtime, hourly GHI+temp, inclusive window', () => {
  const url = buildArchiveUrl({ lat: 51.16, lon: 10.45, startDate: '2025-06-01', endDate: '2025-06-30' });
  assert.match(url, /^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?/);
  assert.match(url, /latitude=51\.16/);
  assert.match(url, /longitude=10\.45/);
  assert.match(url, /start_date=2025-06-01/);
  assert.match(url, /end_date=2025-06-30/);
  assert.match(url, /hourly=shortwave_radiation%2Ctemperature_2m/);
  assert.match(url, /timeformat=unixtime/);
});

test('parseArchiveResponse: maps unixtime rows, source tag, null-safe', () => {
  const data = {
    hourly: {
      time: [1748736000, 1748739600], // 2025-06-01T00:00Z, 01:00Z
      shortwave_radiation: [0, 123.5],
      temperature_2m: [9.1, null],
    },
  };
  const rows = parseArchiveResponse(data);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, ARCHIVE_SOURCE);
  assert.equal(rows[0].ts_utc, '2025-06-01T00:00:00.000Z');
  assert.equal(rows[0].ghi_wm2, 0);
  assert.equal(rows[0].temperature_c, 9.1);
  assert.equal(rows[1].ghi_wm2, 123.5);
  assert.equal(rows[1].temperature_c, null); // null temp survives as null
  assert.equal(rows[0].resolution_seconds, 3600);
});

test('parseArchiveResponse: empty/garbage input -> []', () => {
  assert.deepEqual(parseArchiveResponse(null), []);
  assert.deepEqual(parseArchiveResponse({}), []);
  assert.deepEqual(parseArchiveResponse({ hourly: {} }), []);
});

test('addDaysUtc: pure UTC date arithmetic across month/DST boundaries', () => {
  assert.equal(addDaysUtc('2025-06-30', 1), '2025-07-01');
  assert.equal(addDaysUtc('2025-03-30', 1), '2025-03-31'); // CEST switch is irrelevant in UTC
  assert.equal(addDaysUtc('2025-01-01', -1), '2024-12-31');
});

test('chunkDateRange: contiguous, non-overlapping, <= chunkDays each', () => {
  const chunks = chunkDateRange('2025-01-01', '2025-12-31', 92);
  // covers the whole window with no gaps
  assert.equal(chunks[0].startDate, '2025-01-01');
  assert.equal(chunks[chunks.length - 1].endDate, '2025-12-31');
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].startDate, addDaysUtc(chunks[i - 1].endDate, 1)); // contiguous
  }
  // single-day window
  assert.deepEqual(chunkDateRange('2025-05-10', '2025-05-10', 92), [{ startDate: '2025-05-10', endDate: '2025-05-10' }]);
  // inverted window -> []
  assert.deepEqual(chunkDateRange('2025-05-10', '2025-05-01'), []);
});

test('computeBackfillWindows: empty coverage -> whole window', () => {
  assert.deepEqual(
    computeBackfillWindows(null, '2025-01-01', '2025-12-31'),
    [{ startDate: '2025-01-01', endDate: '2025-12-31' }]
  );
});

test('computeBackfillWindows: only head + tail gaps, not the covered middle', () => {
  const cov = { min_ts: '2025-03-01T00:00:00Z', max_ts: '2025-09-30T23:00:00Z' };
  const windows = computeBackfillWindows(cov, '2025-01-01', '2025-12-31');
  assert.deepEqual(windows, [
    { startDate: '2025-01-01', endDate: '2025-02-28' }, // head
    { startDate: '2025-10-01', endDate: '2025-12-31' }, // tail
  ]);
});

test('computeBackfillWindows: fully covered -> no windows', () => {
  const cov = { min_ts: '2024-12-01T00:00:00Z', max_ts: '2026-01-01T00:00:00Z' };
  assert.deepEqual(computeBackfillWindows(cov, '2025-01-01', '2025-12-31'), []);
});

test('backfillObservedGhi: idempotent — second run upserts identical rows, no growth', async () => {
  // Fake store backed by a Map keyed (source, ts_utc) — mirrors ON CONFLICT semantics.
  const db = new Map();
  const store = {
    async insertObservedWeatherBatch(rows) {
      for (const r of rows) db.set(`${r.source}|${r.ts_utc}`, r);
      return { written: rows.length };
    },
  };
  // Fake fetch: returns 2 hourly samples regardless of window.
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      hourly: { time: [1748736000, 1748739600], shortwave_radiation: [0, 200], temperature_2m: [10, 11] },
    }),
  });
  const ctx = { pushLog: () => {} };
  const opts = { store, lat: 51, lon: 10, startDate: '2025-06-01', endDate: '2025-06-01', fetchImpl: fakeFetch };

  const r1 = await backfillObservedGhi(ctx, opts);
  assert.equal(r1.failed, 0);
  assert.equal(r1.written, 2);
  const sizeAfterFirst = db.size;

  const r2 = await backfillObservedGhi(ctx, opts);
  assert.equal(r2.written, 2);
  assert.equal(db.size, sizeAfterFirst, 'second identical run must not grow the store');
});

test('backfillObservedGhi: a failing chunk is counted + skipped, not thrown', async () => {
  const store = { async insertObservedWeatherBatch() { return { written: 0 }; } };
  const fakeFetch = async () => ({ ok: false, status: 503 });
  const ctx = { pushLog: () => {} };
  const r = await backfillObservedGhi(ctx, { store, lat: 1, lon: 2, startDate: '2025-06-01', endDate: '2025-06-02', fetchImpl: fakeFetch });
  assert.equal(r.failed, 1);
  assert.equal(r.written, 0);
});
