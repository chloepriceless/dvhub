import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';

// T-0002 Control-Path-Hardening contract:
//   1. Reg-2700 keepalive — identical-value writes are normally short-circuited
//      (held). With keepaliveMs > 0 an identical value is RE-ASSERTED once that
//      long has elapsed since the last real write, so a Venus-side watchdog reset
//      cannot silently drop the ESS grid setpoint. Default-OFF (0) = old behaviour.
//   2. Persistent manual override — `persistent:true` overrides never expire and
//      survive a transient scheduled-rule window; normal overrides still expire.
//   3. Transparent applied/skipped — held writes emit a throttled
//      control_write_skipped event and carry skipped/heldSinceMs/keepalive flags.

function makeCtx(overrides = {}) {
  const logs = [];
  const writes = [];

  const state = {
    victron: {
      soc: 50,
      batteryDischargeW: 0,
      batteryChargeW: 0,
      batteryPowerW: 0,
      pvTotalW: 0,
      pvPowerW: 0
    },
    schedule: {
      rules: [],
      active: {},
      lastWrite: {},
      manualOverride: {},
      config: { defaultGridSetpointW: -40, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 },
      lastEvalAt: 0
    },
    ctrl: { negativePriceActive: false, forcedOff: false },
    epex: { data: [] }
  };

  const cfg = {
    // mqtt write target encodes the engineering value directly (no register packing).
    controlWrite: {
      gridSetpointW: { enabled: true, address: 100 },
      chargeCurrentA: { enabled: false }
    },
    dvControl: { enabled: false, negativePriceProtection: { enabled: true, gridSetpointW: -40 } },
    // allowGridDischarge:true so negative (export) setpoints pass the EEG/§14a gate.
    optimizer: { enabled: false, allowGridCharge: false, allowGridDischarge: true },
    dcExportMode: {},
    schedule: {
      timezone: 'Europe/Berlin',
      manualOverrideTtlMs: 300000,
      controlKeepaliveMs: 0,
      smallMarketAutomation: { enabled: false }
    }
  };

  const ctx = {
    state,
    getCfg: () => cfg,
    transport: {
      type: 'mqtt',
      mqttWrite: async (target, value) => { writes.push({ target, value }); }
    },
    pushLog: (event, payload) => { logs.push({ event, payload: payload || {} }); },
    telemetrySafeWrite: (fn) => { try { fn?.(); } catch { /* no-op */ } },
    persistConfig: async () => {},
    telemetryStore: null,
    epexNowNext: () => ({ current: { ct_kwh: 12, eur_mwh: 120 }, next: null }),
    regenerateSmallMarketAutomationRules: async () => {},
    onEvalComplete: () => {}
  };

  if (typeof overrides.mutate === 'function') overrides.mutate({ state, cfg, ctx });

  const evaluator = createScheduleEvaluator(ctx);
  return { evaluator, state, cfg, logs, writes };
}

const countLogs = (logs, event) => logs.filter((l) => l.event === event).length;
const gridWrites = (writes) => writes.filter((w) => w.target === 'gridSetpointW');

// --- 1. Keepalive --------------------------------------------------------------

test('keepalive OFF (default): identical value is held, not re-written', async () => {
  const { evaluator, state, writes } = makeCtx();
  // Seed a prior real write far in the past — keepalive is off so age is irrelevant.
  state.schedule.lastWrite.gridSetpointW = { value: -5000, at: Date.now() - 10 * 60 * 1000 };

  const r = await evaluator.applyControlTarget('gridSetpointW', -5000, 'test');

  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'unchanged');
  assert.equal(gridWrites(writes).length, 0, 'no hardware write on a held setpoint');
});

test('keepalive ON + due: identical value is re-asserted (keepalive write)', async () => {
  const { evaluator, state, cfg, writes } = makeCtx();
  cfg.schedule.controlKeepaliveMs = 5000;
  // Last real write 6s ago > 5s keepalive → due.
  state.schedule.lastWrite.gridSetpointW = { value: -5000, at: Date.now() - 6000 };

  const r = await evaluator.applyControlTarget('gridSetpointW', -5000, 'test');

  assert.equal(r.ok, true);
  assert.notEqual(r.skipped, true, 'keepalive must not skip');
  assert.equal(r.keepalive, true);
  assert.equal(gridWrites(writes).length, 1, 'identical value re-written for keepalive');
  assert.equal(state.schedule.active.gridSetpointW.keepalive, true);
});

test('keepalive ON + not due: identical value still held', async () => {
  const { evaluator, state, cfg, writes } = makeCtx();
  cfg.schedule.controlKeepaliveMs = 5000;
  // Last real write 1s ago < 5s keepalive → not due.
  state.schedule.lastWrite.gridSetpointW = { value: -5000, at: Date.now() - 1000 };

  const r = await evaluator.applyControlTarget('gridSetpointW', -5000, 'test');

  assert.equal(r.skipped, true);
  assert.equal(gridWrites(writes).length, 0);
});

test('keepalive scoped to gridSetpointW only via global key (chargeCurrentA unaffected)', async () => {
  const { evaluator, state, cfg, writes } = makeCtx();
  cfg.schedule.controlKeepaliveMs = 5000;
  cfg.controlWrite.chargeCurrentA = { enabled: true, address: 101 };
  state.schedule.lastWrite.chargeCurrentA = { value: 10, at: Date.now() - 10 * 60 * 1000 };

  const r = await evaluator.applyControlTarget('chargeCurrentA', 10, 'test');

  // Global keepalive applies to gridSetpointW only; chargeCurrentA is a persistent
  // setting → held despite age (no per-target keepaliveMs set).
  assert.equal(r.skipped, true);
  assert.equal(writes.filter((w) => w.target === 'chargeCurrentA').length, 0);
});

// --- 2. Transparent skip logging ----------------------------------------------

test('held write logs control_write_skipped once per (target,value) transition', async () => {
  const { evaluator, state, logs } = makeCtx();
  state.schedule.lastWrite.gridSetpointW = { value: -5000, at: Date.now() };

  await evaluator.applyControlTarget('gridSetpointW', -5000, 'test'); // skip → log #1
  await evaluator.applyControlTarget('gridSetpointW', -5000, 'test'); // skip → throttled
  assert.equal(countLogs(logs, 'control_write_skipped'), 1, 'throttled to one log');

  await evaluator.applyControlTarget('gridSetpointW', -3000, 'test'); // real write resets throttle
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'test'); // skip → log #2
  assert.equal(countLogs(logs, 'control_write_skipped'), 2, 'new transition logs again');
});

// --- 3. Persistent override ----------------------------------------------------

test('persistent override survives past manualOverrideTtlMs', async () => {
  const { evaluator, state, writes } = makeCtx();
  // 400s old > 300s TTL, but persistent → must still apply.
  state.schedule.manualOverride.gridSetpointW = { value: -8000, at: Date.now() - 400000, persistent: true };

  await evaluator.evaluateSchedule();

  const gw = gridWrites(writes);
  assert.ok(gw.length >= 1, 'a setpoint was written');
  assert.equal(gw[gw.length - 1].value, -8000, 'persistent override applied despite age');
});

test('non-persistent override expires after TTL (regression)', async () => {
  const { evaluator, state, writes } = makeCtx();
  state.schedule.manualOverride.gridSetpointW = { value: -8000, at: Date.now() - 400000 };

  await evaluator.evaluateSchedule();

  const gw = gridWrites(writes);
  assert.ok(gw.length >= 1, 'a setpoint was written');
  assert.equal(gw[gw.length - 1].value, -40, 'expired override falls back to default, not stale value');
  assert.equal(state.schedule.manualOverride.gridSetpointW, undefined, 'expired override deleted');
});

test('persistent override is NOT erased by a transient rule and resumes after it', async () => {
  const { evaluator, state, writes } = makeCtx();
  state.schedule.manualOverride.gridSetpointW = { value: -8000, at: Date.now() - 400000, persistent: true };
  state.schedule.rules = [
    { id: 'r1', target: 'gridSetpointW', enabled: true, start: '00:00', end: '23:59', value: -16000, source: 'manual' }
  ];

  await evaluator.evaluateSchedule(); // rule active → writes -16000
  let gw = gridWrites(writes);
  assert.equal(gw[gw.length - 1].value, -16000, 'active rule wins over override');
  assert.ok(state.schedule.manualOverride.gridSetpointW, 'persistent override not deleted by rule');
  assert.equal(state.schedule.manualOverride.gridSetpointW.persistent, true);

  state.schedule.rules = []; // rule window ends
  await evaluator.evaluateSchedule(); // override resumes
  gw = gridWrites(writes);
  assert.equal(gw[gw.length - 1].value, -8000, 'persistent override resumes after rule');
});

// --- 4. Persistent-override SoC floor (safety, closes adversarial finding C) ----

test('persistent discharge override is suppressed below the SoC floor', async () => {
  const { evaluator, state, writes, logs } = makeCtx();
  state.victron.soc = 8; // below default floor (10%)
  state.schedule.manualOverride.gridSetpointW = { value: -16000, at: Date.now() - 400000, persistent: true };

  await evaluator.evaluateSchedule();

  const gw = gridWrites(writes);
  assert.equal(gw[gw.length - 1].value, 0, 'discharge override held at 0 below SoC floor');
  assert.equal(countLogs(logs, 'manual_override_soc_floor'), 1);
});

test('persistent discharge override applies above the SoC floor', async () => {
  const { evaluator, state, writes } = makeCtx();
  state.victron.soc = 50; // above floor
  state.schedule.manualOverride.gridSetpointW = { value: -16000, at: Date.now() - 400000, persistent: true };

  await evaluator.evaluateSchedule();

  const gw = gridWrites(writes);
  assert.equal(gw[gw.length - 1].value, -16000, 'override applied above floor');
});

test('persistent discharge override fail-safe holds when SoC is unknown', async () => {
  const { evaluator, state, writes } = makeCtx();
  state.victron.soc = undefined; // telemetry missing
  state.schedule.manualOverride.gridSetpointW = { value: -16000, at: Date.now() - 400000, persistent: true };

  await evaluator.evaluateSchedule();

  const gw = gridWrites(writes);
  assert.equal(gw[gw.length - 1].value, 0, 'fail-safe hold when SoC unknown');
});

test('persistent CHARGE override (positive) is not touched by the discharge floor', async () => {
  const { evaluator, state, cfg, writes } = makeCtx();
  cfg.optimizer.allowGridCharge = true; // positive setpoint needs charge permission
  state.victron.soc = 5; // below floor, but this is a charge, not a discharge
  state.schedule.manualOverride.gridSetpointW = { value: 5000, at: Date.now() - 400000, persistent: true };

  await evaluator.evaluateSchedule();

  const gw = gridWrites(writes);
  assert.equal(gw[gw.length - 1].value, 5000, 'charge override unaffected by discharge SoC floor');
});
