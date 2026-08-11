// test/inspector-b2.test.js — Phase 19 Plan 19-03 (RED→GREEN once Plan 19-03 lands).
//
// Asserts the B2 Load-Forecast inspector contract:
//   - getLoad surfaces 'sql_weekday' AND 'sql_weekday_fallback' as SEPARATE
//     model keys (Phase 18-01k distinction — fallback is NOT real weekday data)
//   - statsforecast surfaces as a separate model key
//   - actual[] is populated from telemetryStore.listLoadActualSlots
//   - meta.sqlWeekdayFallbackActive reflects presence of fallback rows
//   - graceful degrade when telemetryStore missing
//   - error envelopes: store_unavailable / query_failed

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../services/forecast/inspector.js';

function makeCtx() {
  return {
    state: { forecast: { load: {} } },
    getCfg: () => ({}),
    pushLog: () => {},
  };
}

test('B2 getLoad surfaces sql_weekday, sql_weekday_fallback, statsforecast as separate model keys', async () => {
  let actualCalledWith = null;
  const store = {
    getLatestLoadForecast: async ({ start, end }) => [
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'sql_weekday', power_w: 1200 },
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'sql_weekday_fallback', power_w: 800 },
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'statsforecast', power_w: 1150 },
    ],
  };
  const telemetryStore = {
    listLoadActualSlots: async (opts) => { actualCalledWith = opts; return [{ start: '2026-05-20T10:00:00.000Z', powerW: 1180 }]; },
  };
  const inspector = createInspector(makeCtx(), { store, telemetryStore });
  const out = await inspector.getLoad({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z' });
  assert.ok(out.models, 'models object expected');
  assert.ok(out.models.sql_weekday, 'sql_weekday key exists');
  assert.ok(out.models.sql_weekday_fallback, 'sql_weekday_fallback key exists (distinct from sql_weekday)');
  assert.ok(out.models.statsforecast, 'statsforecast key exists');
  assert.equal(out.models.sql_weekday_fallback[0].power_w, 800);
  assert.equal(out.meta.sqlWeekdayFallbackActive, true);
  assert.equal(out.actual.length, 1);
  assert.deepEqual(actualCalledWith, { start: '2026-05-20T00:00:00Z', end: '2026-05-21T00:00:00Z' });
});

test('B2 getLoad sqlWeekdayFallbackActive=false when no fallback rows', async () => {
  const store = {
    getLatestLoadForecast: async () => [{ ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'sql_weekday', power_w: 1200 }],
  };
  const telemetryStore = { listLoadActualSlots: async () => [] };
  const inspector = createInspector(makeCtx(), { store, telemetryStore });
  const out = await inspector.getLoad({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z' });
  assert.equal(out.meta.sqlWeekdayFallbackActive, false);
});

test('B2 getLoad returns store_unavailable when store missing', async () => {
  const inspector = createInspector(makeCtx(), { store: null });
  const out = await inspector.getLoad({ from: 'a', to: 'b' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'store_unavailable');
});

test('B2 getLoad still returns models when telemetryStore.listLoadActualSlots is absent (graceful degrade)', async () => {
  const store = {
    getLatestLoadForecast: async () => [{ ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'sql_weekday', power_w: 1200 }],
  };
  const inspector = createInspector(makeCtx(), { store, telemetryStore: null });
  const out = await inspector.getLoad({ from: 'a', to: 'b' });
  assert.ok(out.models.sql_weekday);
  assert.equal(out.actual.length, 0);
});

test('B2 getLoad returns query_failed when store throws', async () => {
  const store = { getLatestLoadForecast: async () => { throw new Error('db down'); } };
  const telemetryStore = { listLoadActualSlots: async () => [] };
  const inspector = createInspector(makeCtx(), { store, telemetryStore });
  const out = await inspector.getLoad({ from: 'a', to: 'b' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'query_failed');
});
