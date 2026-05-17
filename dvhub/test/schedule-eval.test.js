import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';

// RED scaffolding (Phase 10 Wave 0, TDD gate).
// The D-18 live Akku-Hard-Limit clamp does NOT exist in schedule-eval.js yet —
// plan 10-04 adds it to the gridSetpointW write loop. The four tests below
// describe the intended D-18 contract and therefore fail RED today: no clamp
// runs, so the trimmed setpoint and the stage2_akku_hard_limit_exceeded /
// stage2_akku_telemetry_missing log events never appear. Do NOT modify
// schedule-eval.js in this plan.

const AKKU_HARD_LIMIT_W = 20000;
// D-18 hysteresis margin — must match the value plan 10-04 wires into the clamp.
const HYSTERESIS_W = 500;

// makeCtx — a fake ctx matching the real createScheduleEvaluator destructure:
//   { state, getCfg, transport, pushLog, telemetrySafeWrite, persistConfig }
// plus the extra ctx members evaluateSchedule reads (epexNowNext, telemetryStore).
function makeCtx(overrides = {}) {
  const logs = [];
  const writes = [];

  const baseRule = {
    id: 'sma-stage2-leeren-1',
    enabled: true,
    target: 'gridSetpointW',
    start: '00:00',
    end: '23:59',
    value: -16000,
    source: 'small_market_automation',
    autoManaged: true,
    // Stage-2 marker fields so the D-18 clamp can identify a Stage-2 LEEREN rule.
    stage2Phase: 'LEEREN',
    mode: 'aggressiveExport'
  };

  const state = {
    victron: {
      // measured DC battery discharge (positive W) — the D-18 clamp input.
      batteryDischargeW: 0,
      batteryChargeW: 0,
      batteryPowerW: 0,
      pvTotalW: 0,
      pvPowerW: 0
    },
    schedule: {
      rules: [baseRule],
      active: {},
      lastWrite: {},
      manualOverride: {},
      config: { defaultGridSetpointW: null, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 },
      lastEvalAt: 0
    },
    ctrl: {
      negativePriceActive: false,
      forcedOff: false
    },
    epex: { data: [] }
  };

  const cfg = {
    // The mqtt write target encodes the engineering value directly (no Modbus
    // register packing), which keeps this harness focused on the D-18 clamp.
    controlWrite: {
      gridSetpointW: { enabled: true, address: 100 },
      chargeCurrentA: { enabled: false }
    },
    dvControl: { enabled: false },
    optimizer: { enabled: false, allowGridCharge: false, allowGridDischarge: true },
    negativePriceProtection: { enabled: true, gridSetpointW: -40 },
    schedule: {
      timezone: 'Europe/Berlin',
      smallMarketAutomation: {
        enabled: true,
        predictivePreEmpty: {
          enabled: true,
          akkuHardLimitW: AKKU_HARD_LIMIT_W
        }
      }
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
    // No-op stub — Stage-2 rule (re)generation is exercised by 10-03/10-04, not here.
    regenerateSmallMarketAutomationRules: async () => {},
    onEvalComplete: () => {}
  };

  // Allow tests to mutate the fixture before constructing the evaluator.
  if (typeof overrides.mutate === 'function') overrides.mutate({ state, cfg, ctx });

  return { ctx, state, cfg, logs, writes };
}

function findLog(logs, event) {
  return logs.filter((l) => l.event === event);
}

// --- D-18 live Akku-Hard-Limit clamp ---

test('D-18: Stage-2 LEEREN setpoint is trimmed toward 0 when battery discharge exceeds the hard limit', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ state }) => {
      // Measured battery discharge well above akkuHardLimitW + hysteresis.
      state.victron.batteryDischargeW = AKKU_HARD_LIMIT_W + HYSTERESIS_W + 4000;
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  const written = state.schedule.active.gridSetpointW;
  assert.ok(written, 'a gridSetpointW write must be recorded');
  // The clamp must trim the -16000 W setpoint toward 0 (a less-negative value).
  assert.ok(Number(written.value) > -16000,
    `setpoint must be trimmed toward 0 (less negative than -16000), got ${written.value}`);
  // And the clamp must log the binding episode exactly once per the hysteresis idiom.
  assert.equal(findLog(logs, 'stage2_akku_hard_limit_exceeded').length, 1,
    'stage2_akku_hard_limit_exceeded must be logged when the clamp binds');
});

test('D-18: setpoint is left unchanged when battery discharge is within the hysteresis margin (no flapping)', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ state }) => {
      // Just inside the hysteresis margin — the clamp must NOT engage.
      state.victron.batteryDischargeW = AKKU_HARD_LIMIT_W - 100;
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  const written = state.schedule.active.gridSetpointW;
  assert.ok(written, 'a gridSetpointW write must be recorded');
  assert.equal(Number(written.value), -16000,
    'within hysteresis the Stage-2 setpoint is left unchanged (no flapping)');
  assert.equal(findLog(logs, 'stage2_akku_hard_limit_exceeded').length, 0,
    'no clamp event must be logged within the hysteresis margin');
});

test('D-18: a non-Stage-2 gridSetpointW rule is never touched by the clamp', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ state }) => {
      // A plain manual gridSetpointW rule with no Stage-2 marker fields.
      state.schedule.rules = [{
        id: 'manual-1',
        enabled: true,
        target: 'gridSetpointW',
        start: '00:00',
        end: '23:59',
        value: -16000,
        source: 'manual'
      }];
      // Battery discharge above the limit — but this rule is NOT Stage-2.
      state.victron.batteryDischargeW = AKKU_HARD_LIMIT_W + HYSTERESIS_W + 4000;
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  const written = state.schedule.active.gridSetpointW;
  assert.ok(written, 'a gridSetpointW write must be recorded');
  assert.equal(Number(written.value), -16000,
    'a non-Stage-2 rule must pass through the clamp untouched');
  assert.equal(findLog(logs, 'stage2_akku_hard_limit_exceeded').length, 0,
    'the clamp must not fire for a non-Stage-2 rule');
});

test('D-18: missing batteryDischargeW telemetry fails safe — setpoint held, stage2_akku_telemetry_missing logged', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ state }) => {
      // Telemetry is null/missing — the clamp must fail safe, never default to
      // an unbounded discharge.
      state.victron.batteryDischargeW = null;
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  assert.equal(findLog(logs, 'stage2_akku_telemetry_missing').length, 1,
    'stage2_akku_telemetry_missing must be logged when batteryDischargeW is null/missing');
  const written = state.schedule.active.gridSetpointW;
  assert.ok(written, 'a gridSetpointW write must be recorded');
  // Fail-safe: hold the setpoint, do not let an unbounded discharge through.
  assert.equal(Number(written.value), -16000,
    'missing telemetry must hold the current Stage-2 setpoint, not no-op into an unbounded discharge');
});
