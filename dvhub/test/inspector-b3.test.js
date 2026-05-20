// test/inspector-b3.test.js — Phase 19 Plan 19-04 (RED until plan 19-04 lands).
//
// Scaffold contract for the B3 ML Shadow Correction inspector. Asserts:
//   - getMlCorrection invokes mlService.correct with {shadow:true, forecastVersion}
//   - 60s cache: second call with same forecastVersion → spawn count stays 1
//   - mlEnabled=false + shadow=true + model loaded → applied:true
//   - model=null + shadow=true → applied:false, reason:'no_model'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../services/forecast/inspector.js';

function makeCtx() {
  return {
    state: { forecast: { pv: { data: [{ ts: '2026-05-20T10:00:00Z', powerW: 2000 }] } } },
    getCfg: () => ({ ml: { enabled: false } }),
    pushLog: () => {},
  };
}

function makeMlStub({ model = { name: 'lightgbm', version: 1 }, mlEnabled = false } = {}) {
  let spawnCount = 0;
  return {
    correct: async (slots, opts) => {
      spawnCount++;
      if (!opts.shadow && !mlEnabled) return { applied: false, corrected: slots, model: null };
      if (model === null) return { applied: false, corrected: slots, model: null, reason: 'no_model' };
      return {
        applied: true,
        corrected: slots.map(s => ({ ...s, powerW: s.powerW * 0.95 })),
        model: `${model.name} v${model.version}`,
      };
    },
    _getSpawnCount: () => spawnCount,
  };
}

test('B3 getMlCorrection invokes ml.correct with shadow:true', async () => {
  const ml = makeMlStub({ mlEnabled: false });
  const inspector = createInspector(makeCtx(), { mlService: ml });
  const out = await inspector.getMlCorrection({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z' });
  // RED — Plan 19-04 implements body. Stub returns {ok:false,error:'not_implemented'}.
  assert.ok(out && out.applied === true, 'applied:true expected when model present + shadow:true');
});

test('B3 cache hit — same forecastVersion within 60s → spawn count stays 1', async () => {
  const ml = makeMlStub();
  const inspector = createInspector(makeCtx(), { mlService: ml });
  await inspector.getMlCorrection({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z', forecastVersion: 'v1' });
  await inspector.getMlCorrection({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z', forecastVersion: 'v1' });
  // RED — Plan 19-04 implements cache.
  assert.equal(ml._getSpawnCount(), 1, 'cache should prevent second spawn for same forecastVersion');
});

test('B3 model=null + shadow=true → applied:false, reason:no_model', async () => {
  const ml = makeMlStub({ model: null });
  const inspector = createInspector(makeCtx(), { mlService: ml });
  const out = await inspector.getMlCorrection({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z' });
  // RED — Plan 19-04 implements.
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'no_model');
});
