// test/inspector-b1.test.js — Phase 19 Plan 19-02 (RED until plan 19-02 lands).
//
// Scaffold contract for the B1 PV-Provider pivot. Asserts:
//   - getPvProviders pivots store.getLatestPvForecast rows by `model` key
//   - vrm-forecast.readPvForecast is NEVER invoked (Pitfall 1 guardrail —
//     write-amplification mirror)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../services/forecast/inspector.js';

function makeCtx() {
  return {
    state: { forecast: { pv: { ensembleWeights: { solcast: 0.6, forecast_solar: 0.4 } } } },
    getCfg: () => ({}),
    pushLog: () => {},
  };
}

test('B1 getPvProviders pivots rows by model', async () => {
  const store = {
    getLatestPvForecast: async () => ([
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'solcast', power_w: 2500, confidence: 0.6 },
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'combined', power_w: 2400, confidence: 0.5 },
    ]),
  };
  const vrmSpy = { readPvForecast: () => { throw new Error('B1 must NOT call vrm-forecast read path'); } };
  const inspector = createInspector(makeCtx(), { store, vrmForecast: vrmSpy });
  const out = await inspector.getPvProviders({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z' });
  // RED — Plan 19-02 implements the body. Until then this assertion fails on the stub envelope.
  assert.ok(out && out.providers && out.providers.solcast, 'providers.solcast expected');
  assert.ok(out.providers.combined, 'providers.combined expected');
  assert.equal(out.ensembleActive, true);
});

test('B1 does NOT call vrm-forecast.readPvForecast', async () => {
  let vrmCalled = false;
  const store = { getLatestPvForecast: async () => [] };
  const vrmSpy = { readPvForecast: () => { vrmCalled = true; return []; } };
  const inspector = createInspector(makeCtx(), { store, vrmForecast: vrmSpy });
  try {
    await inspector.getPvProviders({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z' });
  } catch (_) { /* stub may throw — still assert vrm wasn't called */ }
  assert.equal(vrmCalled, false, 'vrm-forecast.readPvForecast must NOT be invoked (Pitfall 1)');
});
