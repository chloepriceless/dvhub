// test/inspector-b1.test.js — Phase 19 Plan 19-02 (GREEN).
//
// B1 PV-Provider pivot contract:
//   - getPvProviders pivots store.getLatestPvForecast rows by `model` key
//   - vrm-forecast.readPvForecast is NEVER invoked (Pitfall 1 — write-amp guard)
//   - ensembleWeights from ctx.state.forecast.pv passed through verbatim
//   - ensembleActive=true iff weights present (PIPELINE state, not data presence)
//   - per-provider oldestFetchedAt computed from MAX(fetched_at)
//   - store_unavailable / query_failed error envelopes on infra failure

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../services/forecast/inspector.js';

function makeCtx({ ensembleWeights = null } = {}) {
  return {
    state: { forecast: { pv: { ensembleWeights } } },
    getCfg: () => ({}),
    pushLog: () => {},
  };
}

// vrm-forecast trap: any access to readPvForecast throws — guards the Pitfall-1
// write-amplification path. If B1 ever calls it, the test fails loudly.
function vrmTrapSpy() {
  return {
    readPvForecast: () => {
      throw new Error('B1 must NOT call vrm-forecast.readPvForecast (Pitfall 1)');
    },
  };
}

test('B1 getPvProviders pivots rows by model', async () => {
  const store = {
    getLatestPvForecast: async () => ([
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'solcast', power_w: 2500, confidence: 0.6, fetched_at: new Date('2026-05-20T09:00:00Z') },
      { ts_utc: new Date('2026-05-20T10:15:00Z'), model: 'solcast', power_w: 2700, confidence: 0.6, fetched_at: new Date('2026-05-20T09:00:00Z') },
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'combined', power_w: 2400, confidence: 0.5, fetched_at: new Date('2026-05-20T09:30:00Z') },
    ]),
  };
  const inspector = createInspector(
    makeCtx({ ensembleWeights: { solcast: 0.6, combined: 1 } }),
    { store, vrmForecast: vrmTrapSpy() }
  );
  const out = await inspector.getPvProviders({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z' });
  assert.ok(out.providers, 'providers object exists');
  assert.ok(out.providers.solcast, 'providers.solcast expected');
  assert.equal(out.providers.solcast.length, 2);
  assert.ok(out.providers.combined, 'providers.combined expected');
  assert.equal(out.providers.combined.length, 1);
  assert.equal(out.providers.solcast[0].ts_utc, '2026-05-20T10:00:00.000Z');
  assert.equal(out.providers.solcast[0].power_w, 2500);
  assert.equal(out.providers.solcast[0].confidence, 0.6);
  assert.equal(out.meta.rowCount, 3);
  assert.equal(out.meta.modelCount, 2);
});

test('B1 getPvProviders sets ensembleActive=true when weights present', async () => {
  const store = { getLatestPvForecast: async () => [] };
  const inspector = createInspector(
    makeCtx({ ensembleWeights: { solcast: 0.6 } }),
    { store, vrmForecast: vrmTrapSpy() }
  );
  const out = await inspector.getPvProviders({ from: 'a', to: 'b' });
  assert.equal(out.ensembleActive, true);
  assert.deepEqual(out.ensembleWeights, { solcast: 0.6 });
});

test('B1 getPvProviders sets ensembleActive=false when weights null', async () => {
  const store = { getLatestPvForecast: async () => [] };
  const inspector = createInspector(
    makeCtx({ ensembleWeights: null }),
    { store, vrmForecast: vrmTrapSpy() }
  );
  const out = await inspector.getPvProviders({ from: 'a', to: 'b' });
  assert.equal(out.ensembleActive, false);
  assert.equal(out.ensembleWeights, null);
});

test('B1 does NOT call vrm-forecast.readPvForecast (Pitfall 1 trap)', async () => {
  const store = {
    getLatestPvForecast: async () => [
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'vrm', power_w: 1234, confidence: 0.6, fetched_at: new Date('2026-05-20T08:00:00Z') },
    ],
  };
  const trap = vrmTrapSpy();
  const inspector = createInspector(makeCtx(), { store, vrmForecast: trap });
  // Must NOT throw — trap throws ONLY if readPvForecast is invoked.
  const out = await inspector.getPvProviders({ from: 'a', to: 'b' });
  assert.ok(out.providers.vrm, 'vrm rows read via store, not via vrmForecast');
  assert.equal(out.providers.vrm[0].power_w, 1234);
});

test('B1 getPvProviders returns store_unavailable when store missing', async () => {
  const inspector = createInspector(makeCtx(), { store: null });
  const out = await inspector.getPvProviders({ from: 'a', to: 'b' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'store_unavailable');
});

test('B1 getPvProviders returns query_failed when store throws', async () => {
  const store = { getLatestPvForecast: async () => { throw new Error('db down'); } };
  const inspector = createInspector(makeCtx(), { store });
  const out = await inspector.getPvProviders({ from: 'a', to: 'b' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'query_failed');
});

test('B1 getPvProviders computes oldestFetchedAt per model (MAX(fetched_at))', async () => {
  const store = {
    getLatestPvForecast: async () => [
      { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'solcast', power_w: 100, confidence: 0.6, fetched_at: new Date('2026-05-20T08:00:00Z') },
      { ts_utc: new Date('2026-05-20T10:15:00Z'), model: 'solcast', power_w: 110, confidence: 0.6, fetched_at: new Date('2026-05-20T09:00:00Z') },
    ],
  };
  const inspector = createInspector(makeCtx(), { store, vrmForecast: vrmTrapSpy() });
  const out = await inspector.getPvProviders({ from: 'a', to: 'b' });
  // MAX fetched_at across the two rows is 09:00:00Z (latest = "oldest" in semantics:
  // the latest snapshot we have; the field is "latest fetched_at per model").
  assert.equal(out.oldestFetchedAt.solcast, '2026-05-20T09:00:00.000Z');
});
