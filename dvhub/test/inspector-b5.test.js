// test/inspector-b5.test.js — Phase 19 Plan 19-06 (Stage-2 Backtest).
//
// Asserts the GREEN behaviour of getStage2({date}) on top of the helpers shipped
// in Plan 19-01 (partitionRulesByStage2 + classifyStage2Slot) and the new
// telemetry-store method querySnapshotsForDate (Plan 19-06 Task 1).
//
// Contract:
//   - getStage2 calls telemetryStore.querySnapshotsForDate(date) + listBatteryActualSlots
//   - {ok:false, error:'no_snapshot', date} when snapshot is null
//   - {ok:false, error:'telemetry_unavailable', date} when querySnapshotsForDate missing
//   - {ok:false, error:'query_failed', date} when telemetryStore throws
//   - {ok:true, slots:[…], summary:{plannedCount, matchedCount, overrideCount,
//     deviationCount, matchedPct}, snapshot:{id, ts}, date} on success
//   - Slots sorted ascending by ts_utc
//   - Status: MATCHED / OVERRIDE / DEVIATION / NEUTRAL per UI-SPEC §B5

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../services/forecast/inspector.js';

function makeCtx() {
  return { state: {}, getCfg: () => ({}), pushLog: () => {} };
}

const SLOT1_TS_MS = Date.parse('2026-05-19T19:45:00Z');
const SLOT2_TS_MS = SLOT1_TS_MS + 900_000;
const SLOT1_TS = new Date(SLOT1_TS_MS).toISOString();
const SLOT2_TS = new Date(SLOT2_TS_MS).toISOString();

function makeSnap(rules) {
  return { id: 1, ts: '2026-05-19T23:50:00Z', rules, source: 'small_market_automation' };
}

function makeTelemetryStub({ snapshot = null, batterySlots = [] } = {}) {
  let qsCalls = 0;
  let bsCalls = 0;
  return {
    querySnapshotsForDate: async (_date) => { qsCalls++; return snapshot; },
    listBatteryActualSlots: async ({ start, end }) => { bsCalls++; return batterySlots; },
    _counts: () => ({ qsCalls, bsCalls }),
  };
}

test('getStage2 returns no_snapshot when none in DB', async () => {
  const telemetryStore = makeTelemetryStub({ snapshot: null });
  const inspector = createInspector(makeCtx(), { telemetryStore });
  const out = await inspector.getStage2({ date: '2026-05-19' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_snapshot');
  assert.equal(out.date, '2026-05-19');
});

test('getStage2 partitions Stage-2 rules and identifies overrides', async () => {
  const rules = [
    { id: 'sma-stage2-leeren-' + SLOT1_TS_MS, source: 'small_market_automation', stage2Phase: 'LEEREN', powerW: -3200, startTs: SLOT1_TS_MS },
    { id: 'sma-stage2-hold-' + SLOT2_TS_MS, source: 'small_market_automation', stage2Phase: 'HALTEN', powerW: 0, startTs: SLOT2_TS_MS },
    { id: 'custom-grid-charge-' + SLOT1_TS_MS, source: 'operator', powerW: 1100, startTs: SLOT1_TS_MS },
  ];
  const batterySlots = [
    { start: SLOT1_TS, powerW: 1100 },   // matches the OVERRIDE not the plan
    { start: SLOT2_TS, powerW: -50 },    // close to HALTEN (matched via floor)
  ];
  const telemetryStore = makeTelemetryStub({ snapshot: makeSnap(rules), batterySlots });
  const inspector = createInspector(makeCtx(), { telemetryStore });
  const out = await inspector.getStage2({ date: '2026-05-19' });
  assert.equal(out.ok, true);
  assert.equal(out.slots.length, 2);
  assert.equal(out.summary.plannedCount, 2);
  assert.equal(out.summary.overrideCount, 1);
  assert.equal(out.summary.matchedCount, 1);
  // Slot1 has override (planAction=LEEREN, override present)
  assert.equal(out.slots[0].status, 'OVERRIDE');
  // Slot2 HALTEN matched via 100W floor
  assert.equal(out.slots[1].status, 'MATCHED');
});

test('getStage2 returns DEVIATION when actual differs >15% AND no override', async () => {
  const rules = [
    { id: 'sma-stage2-leeren-' + SLOT1_TS_MS, source: 'small_market_automation', stage2Phase: 'LEEREN', powerW: -3200, startTs: SLOT1_TS_MS },
  ];
  const telemetryStore = makeTelemetryStub({
    snapshot: makeSnap(rules),
    batterySlots: [{ start: SLOT1_TS, powerW: 0 }],
  });
  const inspector = createInspector(makeCtx(), { telemetryStore });
  const out = await inspector.getStage2({ date: '2026-05-19' });
  assert.equal(out.slots[0].status, 'DEVIATION');
  assert.equal(out.summary.deviationCount, 1);
});

test('getStage2 returns telemetry_unavailable when querySnapshotsForDate missing', async () => {
  const inspector = createInspector(makeCtx(), { telemetryStore: { listBatteryActualSlots: async () => [] } });
  const out = await inspector.getStage2({ date: '2026-05-19' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'telemetry_unavailable');
});

test('getStage2 returns query_failed when telemetryStore throws', async () => {
  const telemetryStore = {
    querySnapshotsForDate: async () => { throw new Error('db down'); },
    listBatteryActualSlots: async () => [],
  };
  const inspector = createInspector(makeCtx(), { telemetryStore });
  const out = await inspector.getStage2({ date: '2026-05-19' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'query_failed');
});

test('getStage2 returns ok with empty slots when snapshot has no Stage-2 rules', async () => {
  const telemetryStore = makeTelemetryStub({
    snapshot: makeSnap([{ id: 'custom', source: 'operator', powerW: 500, startTs: SLOT1_TS_MS }]),
    batterySlots: [],
  });
  const inspector = createInspector(makeCtx(), { telemetryStore });
  const out = await inspector.getStage2({ date: '2026-05-19' });
  assert.equal(out.ok, true);
  assert.equal(out.summary.plannedCount, 0);
  assert.equal(out.slots.length, 0);
});

test('getStage2 sorts slots ascending by ts_utc', async () => {
  const rules = [
    { id: 'sma-stage2-leeren-2', source: 'small_market_automation', stage2Phase: 'LEEREN', powerW: -3200, startTs: SLOT2_TS_MS },
    { id: 'sma-stage2-leeren-1', source: 'small_market_automation', stage2Phase: 'LEEREN', powerW: -3200, startTs: SLOT1_TS_MS },
  ];
  const telemetryStore = makeTelemetryStub({ snapshot: makeSnap(rules), batterySlots: [] });
  const inspector = createInspector(makeCtx(), { telemetryStore });
  const out = await inspector.getStage2({ date: '2026-05-19' });
  assert.equal(out.slots[0].ts_utc, SLOT1_TS);
  assert.equal(out.slots[1].ts_utc, SLOT2_TS);
});
