// test/inspector-b3.test.js — Phase 19 Plan 19-04 (B3 ML Shadow Correction).
//
// GREEN once Plan 19-04 lands getMlCorrection() body. Asserts:
//   - shadow:true bypasses mlEnabled=false (operator can preview ML before toggling)
//   - 60s sliding cache keyed on forecastVersion (prevents redundant Python spawns)
//   - forecastVersion bump → cache miss
//   - currentModel=null → reason:'no_model' propagates
//   - input-model selection per modelRank: combined > solcast > forecast_solar > pvnode > open_meteo_solar > vrm
//   - no_input when store returns []

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../services/forecast/inspector.js';

function makeMlStub({ model = 'lightgbm v1', mlEnabled = false, modelNull = false } = {}) {
  let spawnCount = 0;
  return {
    correct: async (slots, opts) => {
      spawnCount++;
      if (!opts.shadow && !mlEnabled) {
        return { applied: false, corrected: slots, model: null };
      }
      if (modelNull) {
        return { applied: false, corrected: slots, model: null, reason: 'no_model' };
      }
      return {
        applied: true,
        corrected: slots.map(s => ({ start: s.start, powerW: Number(s.powerW) * 0.95 })),
        model,
      };
    },
    _getSpawnCount: () => spawnCount,
  };
}

function makeCtx({ mlEnabled = false } = {}) {
  return {
    state: { forecast: { pv: {} } },
    getCfg: () => ({ ml: { mlEnabled } }),
    pushLog: () => {},
  };
}

function makeStore(rows) {
  return { getLatestPvForecast: async () => rows };
}

test('B3 getMlCorrection bypasses mlEnabled=false via shadow:true', async () => {
  const store = makeStore([
    { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'combined', power_w: 1000, confidence: 0.5 },
  ]);
  const mlService = makeMlStub({ mlEnabled: false });
  const forecastService = { forecastVersion: 42 };
  const inspector = createInspector(makeCtx({ mlEnabled: false }), { store, mlService, forecastService });
  const out = await inspector.getMlCorrection({ from: 'a', to: 'b' });
  assert.equal(out.applied, true, 'shadow:true should make ML correction apply even when mlEnabled=false');
  assert.equal(out.model, 'lightgbm v1');
  assert.equal(out.mlEnabled, false, 'payload.mlEnabled mirrors cfg.ml.mlEnabled (false here)');
  assert.equal(out.meta.inputModel, 'combined');
  assert.ok(Array.isArray(out.corrected), 'corrected slots array present');
  assert.ok(Array.isArray(out.delta), 'delta array present when applied');
});

test('B3 cache: two calls within 60s + same forecastVersion → 1 spawn', async () => {
  const store = makeStore([
    { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'combined', power_w: 1000, confidence: 0.5 },
  ]);
  const mlService = makeMlStub({ mlEnabled: false });
  const forecastService = { forecastVersion: 77 };
  const inspector = createInspector(makeCtx(), { store, mlService, forecastService });
  await inspector.getMlCorrection({ from: 'a', to: 'b' });
  const second = await inspector.getMlCorrection({ from: 'a', to: 'b' });
  assert.equal(mlService._getSpawnCount(), 1, 'cache should prevent second Python spawn');
  assert.equal(second.meta.cacheHit, true, 'second call should report cacheHit:true');
});

test('B3 cache miss on forecastVersion bump', async () => {
  const store = makeStore([
    { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'combined', power_w: 1000, confidence: 0.5 },
  ]);
  const mlService = makeMlStub({ mlEnabled: false });
  const forecastService = { forecastVersion: 1 };
  const inspector = createInspector(makeCtx(), { store, mlService, forecastService });
  await inspector.getMlCorrection({ from: 'a', to: 'b' });
  forecastService.forecastVersion = 2;
  await inspector.getMlCorrection({ from: 'a', to: 'b' });
  assert.equal(mlService._getSpawnCount(), 2, 'forecastVersion change invalidates cache');
});

test('B3 returns applied:false reason:no_model when model not loaded', async () => {
  const store = makeStore([
    { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'combined', power_w: 1000, confidence: 0.5 },
  ]);
  const mlService = makeMlStub({ mlEnabled: false, modelNull: true });
  const inspector = createInspector(makeCtx(), { store, mlService, forecastService: { forecastVersion: 1 } });
  const out = await inspector.getMlCorrection({ from: 'a', to: 'b' });
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'no_model');
  assert.equal(out.corrected, null, 'corrected null when not applied');
});

test('B3 input-model selection: combined > solcast', async () => {
  const store = makeStore([
    { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'solcast', power_w: 1500, confidence: 0.6 },
    { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'combined', power_w: 1400, confidence: 0.5 },
  ]);
  const inspector = createInspector(makeCtx(), {
    store,
    mlService: makeMlStub(),
    forecastService: { forecastVersion: 1 },
  });
  const out = await inspector.getMlCorrection({ from: 'a', to: 'b' });
  assert.equal(out.meta.inputModel, 'combined', 'modelRank prefers combined over solcast');
});

test('B3 falls back to solcast when combined absent', async () => {
  const store = makeStore([
    { ts_utc: new Date('2026-05-20T10:00:00Z'), model: 'solcast', power_w: 1500, confidence: 0.6 },
  ]);
  const inspector = createInspector(makeCtx(), {
    store,
    mlService: makeMlStub(),
    forecastService: { forecastVersion: 1 },
  });
  const out = await inspector.getMlCorrection({ from: 'a', to: 'b' });
  assert.equal(out.meta.inputModel, 'solcast');
});

test('B3 returns reason:no_input when no rows in any preferred model', async () => {
  const store = makeStore([]);
  const inspector = createInspector(makeCtx(), {
    store,
    mlService: makeMlStub(),
    forecastService: { forecastVersion: 1 },
  });
  const out = await inspector.getMlCorrection({ from: 'a', to: 'b' });
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'no_input');
});
