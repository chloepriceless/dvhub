// test/inspector-b5.test.js — Phase 19 Plan 19-06 (RED until plan 19-06 lands).
//
// Scaffold contract for the B5 Stage-2-Backtest inspector. Asserts:
//   - getStage2 calls telemetryStore.querySnapshotsForDate(date) + listBatteryActualSlots
//   - partitions rules by source==='small_market_automation' OR id LIKE 'sma-stage2-%'
//   - classifies slots as MATCHED / OVERRIDE / DEVIATION / NEUTRAL per UI-SPEC §B5
//   - date < today-30 → snapshot=null → returns {ok:false, error:'no_snapshot'}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../services/forecast/inspector.js';

function makeCtx() {
  return {
    state: { schedule: { rules: [] } },
    getCfg: () => ({}),
    pushLog: () => {},
  };
}

function makeTelemetryStub({ snapshot = null, batterySlots = [] } = {}) {
  return {
    querySnapshotsForDate: async (_date) => snapshot,
    listBatteryActualSlots: async ({ start, end }) => batterySlots,
  };
}

test('B5 getStage2 — partitions plan vs override rules by sma-stage2- prefix', async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const snapshot = {
    rules_json: [
      { id: 'sma-stage2-leeren-1', stage2Phase: 'LEEREN', source: 'small_market_automation', start: '19:45', powerW: -3200 },
      { id: 'sma-stage2-leeren-2', stage2Phase: 'LEEREN', source: 'small_market_automation', start: '20:00', powerW: -3200 },
      { id: 'sma-stage2-hold-1', stage2Phase: 'HALTEN', source: 'small_market_automation', start: '02:00', powerW: 0 },
      { id: 'sma-stage2-leeren-3', stage2Phase: 'LEEREN', source: 'small_market_automation', start: '18:00', powerW: -3000 },
      { id: 'custom-grid-charge-1', source: 'operator', start: '19:45', powerW: 1100 },
      { id: 'custom-grid-charge-2', source: 'operator', start: '20:00', powerW: 1500 },
    ],
  };
  const telemetryStore = makeTelemetryStub({ snapshot, batterySlots: [] });
  const inspector = createInspector(makeCtx(), { telemetryStore });
  const out = await inspector.getStage2({ date: yesterday });
  // RED — Plan 19-06 implements body. Stub returns {ok:false,error:'not_implemented'}.
  assert.ok(out && out.planRules, 'planRules expected');
  assert.equal(out.planRules.length, 4, '4 Stage-2 plan rules expected');
  assert.equal(out.overrideRules.length, 2, '2 operator override rules expected');
});

test('B5 getStage2 — returns no_snapshot when telemetry query returns null', async () => {
  const telemetryStore = makeTelemetryStub({ snapshot: null });
  const inspector = createInspector(makeCtx(), { telemetryStore });
  const out = await inspector.getStage2({ date: '2020-01-01' });
  // RED — Plan 19-06 implements.
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_snapshot');
});

test('B5 getStage2 — classifies MATCHED slot (planned vs actual within tolerance)', async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const snapshot = {
    rules_json: [
      { id: 'sma-stage2-leeren-1', stage2Phase: 'LEEREN', source: 'small_market_automation', start: '20:00', powerW: -3200 },
    ],
  };
  const batterySlots = [{ start: '20:00', actualPowerW: -2950 }]; // within ±15% of -3200 → MATCHED
  const telemetryStore = makeTelemetryStub({ snapshot, batterySlots });
  const inspector = createInspector(makeCtx(), { telemetryStore });
  const out = await inspector.getStage2({ date: yesterday });
  // RED — Plan 19-06 implements classification.
  assert.ok(out && Array.isArray(out.slots), 'slots array expected');
  const matched = out.slots.find(s => s.status === 'MATCHED');
  assert.ok(matched, 'at least one MATCHED slot expected');
});
