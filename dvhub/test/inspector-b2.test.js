// test/inspector-b2.test.js — Phase 19 Plan 19-03 (RED until plan 19-03 lands).
//
// Scaffold contract for the B2 Load-Forecast comparison. Asserts:
//   - getLoad surfaces 'sql_weekday' AND 'sql_weekday_fallback' as SEPARATE model entries
//   - calls telemetryStore.listLoadActualSlots (Pitfall 2 — fallback distinct from real)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../services/forecast/inspector.js';

function makeCtx() {
  return {
    state: { forecast: { load: {} } },
    getCfg: () => ({}),
    pushLog: () => {},
  };
}

test('B2 getLoad surfaces sql_weekday AND sql_weekday_fallback as separate model entries', async () => {
  const from = '2026-05-20T00:00:00Z';
  const to = '2026-05-21T00:00:00Z';
  const store = {
    getLatestLoadForecast: async () => ([
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'sql_weekday', power_w: 1200 },
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'sql_weekday_fallback', power_w: 800 },
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'statsforecast', power_w: 1150 },
    ]),
  };
  let actualCalled = false;
  const telemetryStore = {
    listLoadActualSlots: async ({ start, end }) => { actualCalled = true; return [{ start, powerW: 1180 }]; },
  };
  const inspector = createInspector(makeCtx(), { store, telemetryStore });
  const out = await inspector.getLoad({ from, to });
  // RED — Plan 19-03 implements the body. Until then this fails on the stub.
  assert.ok(out && out.models, 'models object expected');
  assert.ok(out.models.sql_weekday, 'sql_weekday model expected');
  assert.ok(out.models.sql_weekday_fallback, 'sql_weekday_fallback model expected (distinct from sql_weekday)');
  assert.ok(out.models.statsforecast, 'statsforecast model expected');
  assert.ok(out.actual, 'actual slot list expected');
  assert.equal(actualCalled, true, 'telemetryStore.listLoadActualSlots must be called');
});
