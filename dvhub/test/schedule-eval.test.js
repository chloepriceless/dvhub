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
      // SoC present + above the T-0075 hard floor so the universal discharge floor
      // (added to applyControlTarget) does not clamp these D-18 setpoints.
      soc: 50,
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

// --- T-0075 Teil 2b: stale-telemetry fail-safes (D-18 + stop-SoC) -------------
// batteryDischargeW is DERIVED from batteryPowerW, so D-18 freshness must key on
// the real polled field batteryPowerW (else the check is a no-op). stop-SoC must
// latch off on stale SoC rather than trusting a frozen-but-above-threshold value.

test('T-0075 2b: D-18 stale batteryPowerW fails safe (finite discharge, stale source)', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ state }) => {
      // A finite discharge above the limit would normally BIND the clamp; but its
      // source field batteryPowerW is stale → must hit the fail-safe path instead.
      state.victron.batteryDischargeW = AKKU_HARD_LIMIT_W + HYSTERESIS_W + 4000;
      state.victron.fieldUpdatedAt = { batteryPowerW: Date.now() - 200000 };
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  const tm = findLog(logs, 'stage2_akku_telemetry_missing');
  assert.equal(tm.length, 1, 'stale battery telemetry must hit the fail-safe path');
  assert.equal(tm[0].payload.reason, 'stale', 'reason distinguishes stale from missing');
  assert.equal(findLog(logs, 'stage2_akku_hard_limit_exceeded').length, 0,
    'clamp must NOT bind on stale telemetry — fail safe instead');
  assert.equal(Number(state.schedule.active.gridSetpointW.value), -16000,
    'stale telemetry holds the setpoint, never an unbounded discharge');
});

test('T-0075 2b: stop-SoC rule latched OFF on stale SoC despite frozen value above threshold', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ state }) => {
      state.schedule.rules = [{
        id: 'stopsoc-1', enabled: true, target: 'gridSetpointW',
        start: '00:00', end: '23:59', value: -8000, source: 'manual', stopSocPct: 30
      }];
      state.victron.soc = 50;            // frozen ABOVE stopSocPct → would normally stay active
      state.victron.batteryDischargeW = 0;
      state.victron.fieldUpdatedAt = { soc: Date.now() - 200000 }; // stale
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  assert.equal(state.schedule.rules[0].enabled, false,
    'stale SoC latches the in-window stop-SoC rule off (fail-safe)');
  const ev = findLog(logs, 'schedule_stop_soc_reached');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.reason, 'soc_stale');
});

test('T-0075 2b: stop-SoC rule stays active when SoC is fresh + above threshold (regression)', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ state }) => {
      state.schedule.rules = [{
        id: 'stopsoc-1', enabled: true, target: 'gridSetpointW',
        start: '00:00', end: '23:59', value: -8000, source: 'manual', stopSocPct: 30
      }];
      state.victron.soc = 50;
      state.victron.fieldUpdatedAt = { soc: Date.now() }; // fresh
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  assert.equal(state.schedule.rules[0].enabled, true,
    'fresh SoC above threshold keeps the stop-SoC rule active');
  assert.equal(findLog(logs, 'schedule_stop_soc_reached').length, 0);
});

// --- T-0118 sell-price floor ---

test('T-0118: forced grid export is suppressed (held) when the spot price is below minSellPriceCtKwh', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ cfg, ctx }) => {
      cfg.optimizer.minSellPriceCtKwh = 13;
      ctx.epexNowNext = () => ({ current: { ct_kwh: 6, eur_mwh: 60 }, next: null });
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  const written = state.schedule.active.gridSetpointW;
  assert.ok(written, 'a gridSetpointW write must be recorded');
  assert.equal(Number(written.value), -100,
    'below the floor the -16000 export must be held at the default self-consumption setpoint (-100)');
  assert.equal(written.source, 'sell_price_floor', 'the hold must be tagged sell_price_floor');
  assert.equal(findLog(logs, 'sell_price_floor_hold').length, 1,
    'sell_price_floor_hold must be logged once when the floor binds');
});

test('T-0118: forced grid export proceeds when the spot price is at/above minSellPriceCtKwh', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ cfg, ctx }) => {
      cfg.optimizer.minSellPriceCtKwh = 13;
      ctx.epexNowNext = () => ({ current: { ct_kwh: 14, eur_mwh: 140 }, next: null });
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  const written = state.schedule.active.gridSetpointW;
  assert.ok(written, 'a gridSetpointW write must be recorded');
  assert.equal(Number(written.value), -16000,
    'above the floor the arbitrage export proceeds unchanged');
  assert.equal(findLog(logs, 'sell_price_floor_hold').length, 0,
    'no sell_price_floor_hold must be logged above the floor');
});

test('T-0118: with no floor configured, a cheap-price export is NOT suppressed (backward compatible)', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ ctx }) => {
      // minSellPriceCtKwh left unset (null/undefined) -> floor OFF
      ctx.epexNowNext = () => ({ current: { ct_kwh: 6, eur_mwh: 60 }, next: null });
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  const written = state.schedule.active.gridSetpointW;
  assert.equal(Number(written.value), -16000,
    'with the floor unset, the prior export behavior is preserved');
  assert.equal(findLog(logs, 'sell_price_floor_hold').length, 0,
    'no floor log when the floor is unset');
});

// --- T-0118: sell-price floor is source-aware (EOS owns the decision) ---
// EOS deliberately empties at cheap prices before a curtailment window to free
// room for otherwise-curtailed PV. A flat floor would block that valid prep, so
// the floor must NOT apply to EOS-sourced rules — but the negative-price guard
// (never PAY to export) still must.
function eosExportRule() {
  return {
    id: 'opt-eos-1', enabled: true, target: 'gridSetpointW',
    start: '00:00', end: '23:59', value: -16000,
    source: 'forecast_optimizer', optimizer: 'eos', autoManaged: true,
  };
}

test('T-0118: an EOS-sourced cheap export is NOT held by the sell-price floor', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ cfg, ctx, state }) => {
      cfg.optimizer.enabled = true; // EOS-primary world: optimizer rules are live
      cfg.optimizer.minSellPriceCtKwh = 13;
      ctx.epexNowNext = () => ({ current: { ct_kwh: 6, eur_mwh: 60 }, next: null });
      state.schedule.rules = [eosExportRule()];
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  const written = state.schedule.active.gridSetpointW;
  assert.ok(written, 'a gridSetpointW write must be recorded');
  assert.equal(Number(written.value), -16000,
    'EOS export bypasses the floor — curtailment-prep emptying must not be blocked');
  assert.notEqual(written.source, 'sell_price_floor', 'EOS export is not a floor hold');
  assert.equal(findLog(logs, 'sell_price_floor_hold').length, 0,
    'no sell_price_floor_hold for an EOS rule');
});

test('T-0118: an EOS-sourced export is STILL blocked at a negative spot price (never pay to export)', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ cfg, ctx, state }) => {
      cfg.optimizer.enabled = true; // EOS-primary world: optimizer rules are live
      cfg.optimizer.minSellPriceCtKwh = 13;
      // negativePriceProtection is read from cfg.dvControl.* by the evaluator.
      cfg.dvControl = { enabled: false, negativePriceProtection: { enabled: true, gridSetpointW: -40 } };
      ctx.epexNowNext = () => ({ current: { ct_kwh: -2, eur_mwh: -20 }, next: null });
      state.schedule.rules = [eosExportRule()];
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  const written = state.schedule.active.gridSetpointW;
  assert.ok(written, 'a gridSetpointW write must be recorded');
  assert.equal(Number(written.value), -40,
    'negative-price protection clamps even EOS exports to the npp limit (-40)');
  assert.equal(findLog(logs, 'negative_price_protection_on').length, 1,
    'negative_price_protection_on must fire regardless of source');
});

// --- T-0107: volatile reg-2716 Passthru guard ---
// Reg 2716 (volatile RAM ESS setpoint) reverts the Multi to Passthru if not
// re-asserted within 60 s. Writing it without a valid keepalive must be refused,
// never silently arming Passthru. Prod pins controlKeepaliveMs=0, so a naive
// default flip would hit exactly this case — the guard makes it impossible.

function makeModbusCapture() {
  const writes = [];
  return {
    writes,
    transport: {
      type: 'modbus',
      mbWriteSingle: async (a) => { writes.push({ fc: 6, ...a }); },
      mbWriteMultiple: async (a) => { writes.push({ fc: 16, ...a }); }
    }
  };
}

test('T-0107: gridSetpointW write to volatile reg 2716 is refused when keepalive is disabled (no silent Passthru)', async () => {
  const cap = makeModbusCapture();
  const { ctx, logs } = makeCtx({
    mutate: ({ cfg, ctx }) => {
      ctx.transport = cap.transport;
      cfg.controlWrite.gridSetpointW = {
        enabled: true, fc: 16, address: 2716, writeType: 'int32',
        signed: true, scale: 1, offset: 0, wordOrder: 'be'
      };
      cfg.schedule.controlKeepaliveMs = 0; // prod's pinned value → must block
      cfg.optimizer = { enabled: false, allowGridCharge: false, allowGridDischarge: true };
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  assert.equal(cap.writes.length, 0,
    'no Modbus write may reach reg 2716 without a valid keepalive');
  const blocked = findLog(logs, 'control_write_blocked');
  assert.ok(blocked.length >= 1, 'a control_write_blocked event must be logged');
  assert.equal(blocked[0].payload.reason, 'volatile_setpoint_requires_keepalive');
});

test('T-0107: gridSetpointW write to reg 2716 proceeds via fc16 int32 big-endian when keepalive is valid', async () => {
  const cap = makeModbusCapture();
  const { ctx } = makeCtx({
    mutate: ({ cfg, ctx }) => {
      ctx.transport = cap.transport;
      cfg.controlWrite.gridSetpointW = {
        enabled: true, fc: 16, address: 2716, writeType: 'int32',
        signed: true, scale: 1, offset: 0, wordOrder: 'be'
      };
      cfg.schedule.controlKeepaliveMs = 30000; // valid (<= 60 s)
      cfg.optimizer = { enabled: false, allowGridCharge: false, allowGridDischarge: true };
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  assert.equal(cap.writes.length, 1, 'exactly one Modbus write to reg 2716');
  const w = cap.writes[0];
  assert.equal(w.fc, 16, 'must use fc16 (write multiple) for the 32-bit value');
  assert.equal(w.address, 2716, 'must write the volatile override register');
  // -16000 W as signed int32, big-endian word order: 0xFFFFC180 → [0xFFFF, 0xC180]
  assert.deepEqual(w.values, [0xFFFF, 0xC180],
    'int32 big-endian: high word 0xFFFF (2716), low word 0xC180 (2717) = -16000 W');
});

// --- T-0121: EOS closed-loop export (live-PV recompute + battery cap) ---

function eosClosedLoopRule(batteryShareW = 16000) {
  return {
    id: 'eos-cl', enabled: true, target: 'gridSetpointW',
    start: '00:00', end: '23:59', value: -batteryShareW,
    optimizer: 'eos', closedLoopExport: true, batteryShareW,
    source: 'forecast_optimizer', autoManaged: true
  };
}

test('T-0121: EOS closed-loop recomputes gridSetpointW = -(B + live PV surplus)', async () => {
  const { ctx, state } = makeCtx({
    mutate: ({ state, cfg }) => {
      state.victron.soc = 50;
      state.victron.pvTotalW = 4000;
      state.victron.selfConsumptionW = 1000; // → live PV surplus 3000 W
      state.schedule.rules = [eosClosedLoopRule(16000)];
      cfg.optimizer = { enabled: true, allowGridCharge: false, allowGridDischarge: true };
      cfg.controlWrite.maxDischargeW = { enabled: true, address: 2704 };
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  const gp = state.schedule.active.gridSetpointW;
  assert.ok(gp, 'a gridSetpointW write must be recorded');
  // B 16000 + live PV surplus (4000-1000=3000) → -19000 W export
  assert.equal(Number(gp.value), -19000, 'live PV rides on top of the battery share B');
  // T-0122: the closed-loop must NOT touch the operator-owned maxDischargeW cap
  assert.ok(!state.schedule.active.maxDischargeW,
    'closed-loop leaves maxDischargeW to the operator (no automatic cap)');
});

test('T-0121: a PV dip lowers the export, it does NOT drain more battery (no over-drain)', async () => {
  const { ctx, state } = makeCtx({
    mutate: ({ state, cfg }) => {
      state.victron.soc = 50;
      state.victron.pvTotalW = 0;        // sun gone
      state.victron.selfConsumptionW = 0;
      state.schedule.rules = [eosClosedLoopRule(16000)];
      cfg.optimizer = { enabled: true, allowGridCharge: false, allowGridDischarge: true };
      cfg.controlWrite.maxDischargeW = { enabled: true, address: 2704 };
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  // PV=0 → setpoint collapses to just the battery share B, not the PV-inflated plan value.
  assert.equal(Number(state.schedule.active.gridSetpointW.value), -16000,
    'no live PV → export = B only; battery is not asked to backfill missing PV');
});

test('T-0122: closed-loop never writes maxDischargeW (operator/evcc owns it)', async () => {
  const { ctx, state } = makeCtx({
    mutate: ({ state, cfg }) => {
      state.victron.soc = 50;
      state.victron.pvTotalW = 2000;
      state.victron.selfConsumptionW = 0;
      state.schedule.rules = [eosClosedLoopRule(16000)];
      // operator's manual cap (prod: 20000 = full battery for house+EV) must survive
      state.schedule.lastWrite = { maxDischargeW: { value: 20000, source: 'manual', at: 1 } };
      cfg.optimizer = { enabled: true, allowGridCharge: false, allowGridDischarge: true };
      cfg.controlWrite.maxDischargeW = { enabled: true, address: 2704 };
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  assert.equal(Number(state.schedule.lastWrite.maxDischargeW.value), 20000,
    'the operator-set maxDischargeW cap is untouched by the closed-loop');
  assert.equal(state.schedule.lastWrite.maxDischargeW.source, 'manual',
    'the closed-loop does not take ownership of maxDischargeW');
});

// B == 0: charge / self-consumption slot. EOS feeds in only the planned amount and
// charges the REST of the PV surplus into the battery. The closed-loop must NOT dump
// the full live PV to the grid (the 2026-06-08 "voller PV ins Netz statt Akku laden"
// bug), and must NOT cap discharge (house+EV draw the full battery).
function eosChargeSlotRule(plannedExportW = 5000) {
  return {
    id: 'eos-cl-b0', enabled: true, target: 'gridSetpointW',
    start: '00:00', end: '23:59', value: -plannedExportW,
    optimizer: 'eos', closedLoopExport: true, batteryShareW: 0,
    source: 'forecast_optimizer', autoManaged: true
  };
}

test('T-0122: B=0 charge slot exports only the planned amount, NOT the full live PV', async () => {
  const { ctx, state } = makeCtx({
    mutate: ({ state, cfg }) => {
      state.victron.soc = 50;
      state.victron.pvTotalW = 20000;       // big midday surplus
      state.victron.selfConsumptionW = 1000; // live PV surplus 19000 W
      state.schedule.rules = [eosChargeSlotRule(5000)];
      // operator's manual cap must survive — the closed-loop does not touch it
      state.schedule.lastWrite = { maxDischargeW: { value: 20000, source: 'manual', at: 1 } };
      cfg.optimizer = { enabled: true, allowGridCharge: false, allowGridDischarge: true };
      cfg.controlWrite.maxDischargeW = { enabled: true, address: 2704 };
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  // export = min(plannedExport 5000, livePV 19000) = 5000 — the rest of the PV charges the battery
  assert.equal(Number(state.schedule.active.gridSetpointW.value), -5000,
    'B=0: export capped at the EOS plan, surplus PV charges the battery instead of dumping to grid');
  // the operator's manual discharge cap is left intact (full battery for house+EV)
  assert.equal(Number(state.schedule.lastWrite.maxDischargeW.value), 20000,
    'B=0: operator maxDischargeW untouched — house+EV keep the full battery');
});

test('T-0122: B=0 charge slot — a PV dip lowers the export, battery is not drained', async () => {
  const { ctx, state } = makeCtx({
    mutate: ({ state, cfg }) => {
      state.victron.soc = 50;
      state.victron.pvTotalW = 2000;        // PV underdelivers vs the -5000 plan
      state.victron.selfConsumptionW = 0;
      state.schedule.rules = [eosChargeSlotRule(5000)];
      cfg.optimizer = { enabled: true, allowGridCharge: false, allowGridDischarge: true };
      cfg.controlWrite.maxDischargeW = { enabled: true, address: 2704 };
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  await evaluator.evaluateSchedule();

  // export follows the live PV (2000), it does NOT hold the -5000 plan by draining the battery
  assert.equal(Number(state.schedule.active.gridSetpointW.value), -2000,
    'B=0 + PV dip: export = live PV surplus; battery is not asked to backfill the planned export');
});

// --- Review 2026-06-10 (A1): dcExportMode SoC guard scope ---
// The guard must keep protecting MANUALLY scheduled "100 % Einspeisung" rules
// (battery still needs to charge before the evening peak) but must NOT fire on
// EOS-planned dcExportMode slots (autoManaged) — EOS already planned around the
// battery, guarding those just blocked planned PV feed-in revenue.
// Guard window is forced always-on via chargeDeadlineHour/GuardHours so the
// tests are independent of the wall-clock hour they run at.

function makeDcExportCtx({ autoManaged }) {
  return makeCtx({
    mutate: ({ state, cfg }) => {
      state.schedule.rules = [{
        id: autoManaged ? 'opt-dc-1' : 'manual-dc-1',
        enabled: true,
        target: 'dcExportMode',
        value: 1,
        start: '00:00',
        end: '23:59',
        source: autoManaged ? 'forecast_optimizer' : 'schedule',
        ...(autoManaged ? { autoManaged: true, optimizer: 'eos' } : {})
      }];
      state.victron.soc = 50;          // below targetSocPct → guard condition met
      state.victron.pvTotalW = 5000;   // real PV surplus → a write would happen
      state.victron.selfConsumptionW = 0;
      // Window [deadline-guard, …) = [0, …) → guard hour-condition ALWAYS true.
      cfg.dcExportMode = { targetSocPct: 90, chargeDeadlineHour: 23, chargeGuardHours: 23, bufferW: 100 };
      // The autoManaged rule carries source 'forecast_optimizer' — evaluateSchedule
      // purges those when the optimizer is off, so enable it (matches prod).
      if (autoManaged) cfg.optimizer.enabled = true;
    }
  });
}

test('A1: manual dcExportMode rule is still suppressed by the SoC guard', async () => {
  const { ctx, logs, writes } = makeDcExportCtx({ autoManaged: false });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  assert.ok(findLog(logs, 'dc_export_soc_guard').length >= 1, 'guard log expected for manual rule');
  assert.equal(findLog(logs, 'dc_export_mode_active').length, 0, 'no active export under guard');
  assert.ok(!writes.some((w) => w.target === 'gridSetpointW' && w.value < 0),
    'no negative setpoint written while guarded');
});

test('A1: EOS autoManaged dcExportMode rule bypasses the SoC guard and exports', async () => {
  const { ctx, logs, writes } = makeDcExportCtx({ autoManaged: true });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  assert.equal(findLog(logs, 'dc_export_soc_guard').length, 0, 'guard must not fire for EOS slot');
  assert.ok(findLog(logs, 'dc_export_mode_active').length >= 1, 'EOS slot exports');
  // exportW = -(pv 5000 − load 0 − buffer 100) = -4900
  assert.ok(writes.some((w) => w.target === 'gridSetpointW' && w.value === -4900),
    `expected -4900 write, got ${JSON.stringify(writes)}`);
});
