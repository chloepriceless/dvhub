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

// --- 5. T-0075 universal discharge floor in applyControlTarget (chokepoint) -----

test('T-0075: fresh SoC above hard floor -> discharge applied', async () => {
  const { evaluator, state, writes } = makeCtx();
  state.victron.soc = 50;
  state.victron.fieldUpdatedAt = { soc: Date.now() };
  const r = await evaluator.applyControlTarget('gridSetpointW', -3000, 'test');
  assert.equal(r.ok, true);
  assert.equal(gridWrites(writes).pop().value, -3000, 'discharge not clamped');
});

test('T-0075: SoC at/below hard floor -> clamped to 0', async () => {
  const { evaluator, state, writes, logs } = makeCtx();
  state.victron.soc = 3; // <= 5 default hard floor
  state.victron.fieldUpdatedAt = { soc: Date.now() };
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'test');
  assert.equal(gridWrites(writes).pop().value, 0, 'clamped to hold');
  assert.equal(countLogs(logs, 'control_discharge_floor'), 1);
});

test('T-0075: STALE finite SoC (old success timestamp) -> clamped (fail-safe)', async () => {
  const { evaluator, state, writes, logs } = makeCtx();
  state.victron.soc = 50; // finite + above floor, but frozen/stale
  state.victron.fieldUpdatedAt = { soc: Date.now() - 200000 }; // > 90s maxAge
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'test');
  assert.equal(gridWrites(writes).pop().value, 0, 'frozen-but-finite SoC fails safe');
  assert.equal(logs.filter((l) => l.event === 'control_discharge_floor' && l.payload.reason === 'soc_stale').length, 1);
});

test('T-0075: unknown SoC (null) -> clamped (fail-safe)', async () => {
  const { evaluator, state, writes } = makeCtx();
  state.victron.soc = null;
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'test');
  assert.equal(gridWrites(writes).pop().value, 0, 'unknown SoC fails safe');
});

// --- 6. T-0075 Teil 2b: floor extended to maxDischargeW + chargeCurrentA --------
// The "discharge direction" is per-target and NOT uniform:
//   gridSetpointW / chargeCurrentA: discharge = value < 0
//   maxDischargeW: 0 = no discharge, positive = cap in W, -1 = unlimited → any != 0 enables.

const targetWrites = (writes, t) => writes.filter((w) => w.target === t);
const enableTargets = ({ cfg }) => {
  cfg.controlWrite.maxDischargeW = { enabled: true, address: 104 };
  cfg.controlWrite.chargeCurrentA = { enabled: true, address: 101 };
};

test('T-0075 2b: maxDischargeW cap applied when SoC fresh + above floor', async () => {
  const { evaluator, state, writes } = makeCtx({ mutate: enableTargets });
  state.victron.soc = 50;
  state.victron.fieldUpdatedAt = { soc: Date.now() };
  await evaluator.applyControlTarget('maxDischargeW', 4000, 'test');
  assert.equal(targetWrites(writes, 'maxDischargeW').pop().value, 4000, 'cap not clamped when safe');
});

test('T-0075 2b: maxDischargeW positive cap clamped to 0 on STALE SoC', async () => {
  const { evaluator, state, writes, logs } = makeCtx({ mutate: enableTargets });
  state.victron.soc = 50; // finite but frozen
  state.victron.fieldUpdatedAt = { soc: Date.now() - 200000 };
  await evaluator.applyControlTarget('maxDischargeW', 4000, 'test');
  assert.equal(targetWrites(writes, 'maxDischargeW').pop().value, 0, 'stale → no discharge cap');
  assert.equal(logs.filter((l) => l.event === 'control_discharge_floor' && l.payload.reason === 'soc_stale').length, 1);
});

test('T-0075 2b: maxDischargeW UNLIMITED (-1) clamped to 0 below hard floor', async () => {
  const { evaluator, state, writes } = makeCtx({ mutate: enableTargets });
  state.victron.soc = 3; // <= 5 default hard floor
  state.victron.fieldUpdatedAt = { soc: Date.now() };
  await evaluator.applyControlTarget('maxDischargeW', -1, 'test');
  assert.equal(targetWrites(writes, 'maxDischargeW').pop().value, 0, 'unlimited discharge suppressed at floor');
});

test('T-0075 2b: maxDischargeW=0 (no discharge) is NOT a discharge write -> untouched, no floor log', async () => {
  const { evaluator, state, writes, logs } = makeCtx({ mutate: enableTargets });
  state.victron.soc = null; // would clamp a real discharge, but 0 enables none
  await evaluator.applyControlTarget('maxDischargeW', 0, 'test');
  assert.equal(targetWrites(writes, 'maxDischargeW').pop().value, 0, 'hold passes through');
  assert.equal(logs.filter((l) => l.event === 'control_discharge_floor').length, 0, 'no spurious floor log');
});

test('T-0075 2b: negative chargeCurrentA (discharge dir) clamped to 0 on stale SoC', async () => {
  const { evaluator, state, writes } = makeCtx({ mutate: enableTargets });
  state.victron.soc = 50;
  state.victron.fieldUpdatedAt = { soc: Date.now() - 200000 }; // stale
  await evaluator.applyControlTarget('chargeCurrentA', -50, 'test');
  assert.equal(targetWrites(writes, 'chargeCurrentA').pop().value, 0, 'discharge-direction current suppressed');
});

test('T-0075 2b: positive chargeCurrentA (charge) is NOT floored even below SoC floor', async () => {
  const { evaluator, state, writes } = makeCtx({ mutate: enableTargets });
  state.victron.soc = 3; // below floor, but charging is never an over-drain risk
  state.victron.fieldUpdatedAt = { soc: Date.now() };
  await evaluator.applyControlTarget('chargeCurrentA', 20, 'test');
  assert.equal(targetWrites(writes, 'chargeCurrentA').pop().value, 20, 'charge current unaffected by discharge floor');
});

// --- 7. T-0076 DV feed-in writer: cache state only after a successful write ----
// _lastDvFeedIn must advance ONLY after the hardware write succeeds, else a failed
// "block feed-in" on a negative price is never retried (keeps exporting).

const dvFeedInCtx = (mqttWrite) => makeCtx({ mutate: ({ cfg, ctx }) => {
  cfg.dvControl = { enabled: true, feedExcessDcPv: { enabled: true, address: 2707 } };
  ctx.transport.mqttWrite = mqttWrite;
} });

test('T-0076: a failed DV feed-in write is NOT cached and is retried next cycle', async () => {
  let attempts = 0;
  const { evaluator, state } = dvFeedInCtx(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('modbus timeout'); // first write fails
  });

  await evaluator.applyDvVictronControl(false); // block feed-in (negative price) — write fails
  assert.equal(state.ctrl._lastDvFeedIn, undefined, 'failed write must NOT advance the cache');

  await evaluator.applyDvVictronControl(false); // same desired state → must retry, not short-circuit
  assert.equal(attempts, 2, 'identical feedIn after a failed write retries the write');
  assert.equal(state.ctrl._lastDvFeedIn, false, 'successful retry advances the cache');
});

test('T-0076: after a successful write an identical feedIn short-circuits (no re-write)', async () => {
  let attempts = 0;
  const { evaluator, state } = dvFeedInCtx(async () => { attempts += 1; });

  await evaluator.applyDvVictronControl(false); // writes once
  await evaluator.applyDvVictronControl(false); // unchanged + last write ok → short-circuit
  assert.equal(attempts, 1, 'no redundant re-write after a successful identical state');
  assert.equal(state.ctrl._lastDvFeedIn, false);
});
