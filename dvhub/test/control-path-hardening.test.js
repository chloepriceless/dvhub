import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createScheduleEvaluator } from '../schedule-eval.js';
// Item 25-03: NOT-HALT-Persistenz muss atomar sein (tmp+rename), damit ein
// Crash/Stromausfall mitten im Write keine halbe control_state.json hinterlässt,
// die loadControlState() in den Normalbetrieb fallen lässt (= stilles Aufheben
// des aktiven NOT-HALT). Der reine Helper lebt in einem eigenen Modul, das KEINEN
// HTTP-Server bootet (server.js würde web.listen() auslösen).
import { atomicWriteControlState } from '../control-state-io.js';

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

test('keepalive re-writes are aggregated in the log (no per-cycle control_write spam)', async () => {
  const { evaluator, state, cfg, logs, writes } = makeCtx();
  cfg.schedule.controlKeepaliveMs = 5000;
  state.schedule.lastWrite.gridSetpointW = { value: -5000, at: Date.now() - 6000 };

  // First keepalive re-write: the hardware is still re-asserted, but the operator
  // log is NOT spammed — no control_write line, and the control_keepalive summary
  // is still inside its throttle window.
  const r1 = await evaluator.applyControlTarget('gridSetpointW', -5000, 'test');
  assert.equal(r1.keepalive, true);
  assert.equal(gridWrites(writes).length, 1, 'keepalive still re-writes the hardware');
  assert.equal(countLogs(logs, 'control_write'), 0, 'keepalive must not log control_write');
  assert.equal(countLogs(logs, 'control_keepalive'), 0, 'first keepalive is within the throttle window');

  // Backdate the aggregation window + re-arm keepalive → the next keepalive emits
  // exactly ONE summary line carrying the suppressed count.
  state.schedule._kaAgg.gridSetpointW.lastLogAt = Date.now() - 3600000;
  state.schedule.lastWrite.gridSetpointW.at = Date.now() - 6000;
  await evaluator.applyControlTarget('gridSetpointW', -5000, 'test');
  assert.equal(countLogs(logs, 'control_keepalive'), 1, 'one aggregated summary after the window');
  const ka = logs.find((l) => l.event === 'control_keepalive');
  assert.equal(ka.payload.keepalive, true);
  assert.ok(ka.payload.count >= 2, 'summary carries the suppressed keepalive count');

  // A real (changed-value) write is still surfaced immediately and clears the
  // keepalive aggregation for that target.
  state.schedule.lastWrite.gridSetpointW.at = Date.now() - 6000;
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'test');
  assert.equal(countLogs(logs, 'control_write'), 1, 'changed value logs control_write');
  assert.equal(state.schedule._kaAgg.gridSetpointW, undefined, 'real write resets keepalive aggregation');
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

test('a scheduled rule ENDS a persistent override — no resume after the rule window', async () => {
  // Operator semantics (Christin 2026-06-12): a persistent override holds
  // "until a time slot writes the target again". The original T-0002
  // resume-after-rule behaviour is retired — the slot consumes the override.
  const { evaluator, state, writes, logs } = makeCtx();
  state.schedule.manualOverride.gridSetpointW = { value: -8000, at: Date.now() - 400000, persistent: true };
  state.schedule.rules = [
    { id: 'r1', target: 'gridSetpointW', enabled: true, start: '00:00', end: '23:59', value: -16000, source: 'manual' }
  ];

  await evaluator.evaluateSchedule(); // rule active → writes -16000, ends the override
  let gw = gridWrites(writes);
  assert.equal(gw[gw.length - 1].value, -16000, 'active rule wins over override');
  assert.equal(state.schedule.manualOverride.gridSetpointW, undefined, 'persistent override ended by the rule');
  assert.ok(
    logs.some((l) => l.event === 'manual_override_ended_by_rule'),
    'override end is surfaced in the log ring'
  );

  state.schedule.rules = []; // rule window ends
  await evaluator.evaluateSchedule();
  gw = gridWrites(writes);
  assert.equal(gw[gw.length - 1].value, -40, 'after the rule the DEFAULT applies — the override does NOT resume');
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

// --- T-0080: write-layer bounds at the applyControlTarget chokepoint -----------
// EOS/EMHASS/evcc call applyControlTarget DIRECTLY (bypassing the
// /api/control/write route bounds). The chokepoint now enforces the SAME sanity
// bounds for every caller + clamps minSocPct to the hard floor.

test('T-0080: chokepoint rejects an out-of-range gridSetpointW (EOS/EMHASS bypass closed)', async () => {
  const { evaluator, writes, logs } = makeCtx();
  const r = await evaluator.applyControlTarget('gridSetpointW', -200000, 'eos_optimization');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'value_out_of_range');
  assert.equal(gridWrites(writes).length, 0, 'no hardware write for an absurd value');
  assert.equal(countLogs(logs, 'control_write_rejected'), 1);
});

test('T-0080: chokepoint rejects a non-finite value', async () => {
  const { evaluator, writes } = makeCtx();
  const r = await evaluator.applyControlTarget('gridSetpointW', Number('nope'), 'test');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'value_not_finite');
  assert.equal(gridWrites(writes).length, 0);
});

test('T-0080: chokepoint rejects an out-of-range maxDischargeW but allows the -1 unlimited sentinel', async () => {
  const { evaluator, cfg, writes } = makeCtx();
  cfg.controlWrite.maxDischargeW = { enabled: true, address: 103 };
  const bad = await evaluator.applyControlTarget('maxDischargeW', 50000, 'eos_optimization');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'max_discharge_out_of_range');
  assert.equal(writes.filter((w) => w.target === 'maxDischargeW').length, 0);
  // -1 sentinel passes bounds (SoC 50 is fresh > floor, so no discharge-floor hold either).
  const ok = await evaluator.applyControlTarget('maxDischargeW', -1, 'test');
  assert.equal(ok.ok, true, '-1 unlimited sentinel is allowed');
});

test('T-0080: chokepoint CLAMPS minSocPct below the hard floor (optimizer cannot drop the SoC floor)', async () => {
  const { evaluator, cfg, writes, logs } = makeCtx();
  cfg.controlWrite.minSocPct = { enabled: true, address: 102 };
  cfg.optimizer.hardFloorSocPct = 5;
  const r = await evaluator.applyControlTarget('minSocPct', 2, 'eos_optimization');
  assert.equal(r.ok, true);
  const w = writes.filter((x) => x.target === 'minSocPct');
  assert.equal(w.length, 1);
  assert.equal(w[0].value, 5, 'minSoc 2 raised to the hard floor 5 before the hardware write');
  assert.equal(countLogs(logs, 'control_minsoc_clamped'), 1);
});

test('T-0080: a valid value still writes (no regression)', async () => {
  const { evaluator, writes } = makeCtx();
  const r = await evaluator.applyControlTarget('gridSetpointW', -5000, 'test');
  assert.equal(r.ok, true);
  assert.notEqual(r.skipped, true);
  assert.equal(gridWrites(writes).length, 1);
});

// --- 8. 25-03: atomare NOT-HALT-Persistenz (tmp+rename, kein .tmp-Rest) --------
// persistControlState() schrieb control_state.json bisher direkt mit
// fs.writeFileSync (server.js:783). Ein abgebrochener Write konnte eine halbe/
// korrupte Datei hinterlassen; loadControlState() FÄLLT bei Parse-Fehler in den
// Normalbetrieb → ein aktiver NOT-HALT würde stillschweigend aufgehoben. Der
// atomare Helper (writeFileSync(tmp) + renameSync(tmp, ziel)) macht das unmöglich:
// loadControlState sieht nie eine halbe Datei. KEIN echtes /var/lib, kein EOS/PG —
// nur ein temporäres Verzeichnis.

const mkTmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dvctrl-'));

test('25-03: atomicWriteControlState schreibt valide JSON, keinen .tmp-Rest, round-trip', () => {
  const dir = mkTmpDir();
  try {
    const filePath = path.join(dir, 'control_state.json');
    const stateObj = {
      discretionaryWritesPaused: true,
      pausedAt: 1718660000000,
      pausedBy: 'operator'
    };

    atomicWriteControlState(filePath, stateObj);

    // 1. Zieldatei existiert + ist VALIDE JSON mit dem NOT-HALT-State.
    assert.ok(fs.existsSync(filePath), 'Zieldatei wurde geschrieben');
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw); // wirft bei korrupter/halber Datei
    assert.equal(parsed.discretionaryWritesPaused, true);
    assert.equal(parsed.pausedAt, 1718660000000);
    assert.equal(parsed.pausedBy, 'operator');

    // 2. KEINE .tmp-Leiche im Verzeichnis (rename hat die tmp-Datei konsumiert).
    const entries = fs.readdirSync(dir);
    assert.ok(
      !entries.some((e) => e.endsWith('.tmp')),
      `kein .tmp-Rest erwartet, gefunden: ${entries.join(', ')}`
    );
    assert.deepEqual(entries.sort(), ['control_state.json']);

    // 3. Round-trip: das Wieder-Laden ergibt denselben State (atomar geschriebene
    //    Datei wird korrekt restauriert).
    assert.deepEqual(parsed, stateObj);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('25-03: ein zweiter Write überschreibt atomar (keine .tmp-Leiche, neuer State)', () => {
  const dir = mkTmpDir();
  try {
    const filePath = path.join(dir, 'control_state.json');

    atomicWriteControlState(filePath, { discretionaryWritesPaused: true, pausedAt: 1, pausedBy: 'a' });
    atomicWriteControlState(filePath, { discretionaryWritesPaused: false, pausedAt: 0, pausedBy: null });

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(parsed.discretionaryWritesPaused, false);
    assert.equal(parsed.pausedBy, null);

    const entries = fs.readdirSync(dir);
    assert.ok(!entries.some((e) => e.endsWith('.tmp')), 'kein .tmp-Rest nach Re-Write');
    assert.deepEqual(entries.sort(), ['control_state.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 9. 25-01: EEG-Gate Legal-Regression — echte Akku→Netz-Entladung bleibt gesperrt ---
// Rechts-Sicherung (Pitfall 1 / Threat T-25-01-01): Die Gate-Verfeinerung darf die
// echte Akku→Netz-Sperre NICHT aufweichen. Ein diskretionärer Setpoint
// (value <= FORCED_EXPORT_THRESHOLD_W = -1000) aus einer Nicht-Mandatory-,
// Nicht-dc_export-Quelle (z. B. eos_optimization) MUSS bei allowGridDischarge=false
// WEITERHIN mit grid_discharge_not_allowed abgelehnt werden (§14a EnWG). Dieser
// Test ist heute schon GREEN und MUSS auch nach der Gate-Verfeinerung GREEN bleiben.

test('25-01: echte erzwungene Netzentladung (-5000, eos_optimization) bleibt bei allowGridDischarge=false abgelehnt', async () => {
  const { evaluator, writes, logs } = makeCtx({
    mutate: ({ cfg, state }) => {
      cfg.optimizer.allowGridDischarge = false; // legale Sperre aktiv
      state.victron.soc = 50;
      state.victron.fieldUpdatedAt = { soc: Date.now() }; // frisch — Reject kommt aus dem EEG-Gate, nicht T-0075
    }
  });

  const r = await evaluator.applyControlTarget('gridSetpointW', -5000, 'eos_optimization');

  assert.equal(r.ok, false, 'die echte Akku→Netz-Entladung muss abgelehnt werden');
  assert.equal(r.error, 'grid_discharge_not_allowed',
    'ein diskretionärer <=-1000 Verkauf bleibt rechtlich gesperrt');
  assert.equal(gridWrites(writes).length, 0, 'keine Hardware-Entladung bei gesperrtem Verkauf');
  assert.equal(
    logs.filter((l) => l.event === 'control_write_rejected' && l.payload.reason === 'grid_discharge_not_allowed').length,
    1,
    'der Reject wird einmal als control_write_rejected geloggt'
  );
});
