import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';

// makeCtx — a fake ctx matching the real createScheduleEvaluator destructure:
//   { state, getCfg, transport, pushLog, telemetrySafeWrite, persistConfig }
// plus the extra ctx members evaluateSchedule reads (epexNowNext, telemetryStore).
function makeCtx(overrides = {}) {
  const logs = [];
  const writes = [];

  const baseRule = {
    id: 'sma-1',
    enabled: true,
    target: 'gridSetpointW',
    start: '00:00',
    end: '23:59',
    value: -16000,
    source: 'small_market_automation',
    autoManaged: true,
    mode: 'aggressiveExport'
  };

  const state = {
    victron: {
      // SoC present + above the T-0075 hard floor so the universal discharge floor
      // (added to applyControlTarget) does not clamp these setpoints.
      soc: 50,
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
    // register packing).
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
        enabled: true
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

// --- T-0075 Teil 2b: stop-SoC stale-telemetry fail-safe ----------------------
// stop-SoC must latch off on stale SoC rather than trusting a frozen-but-above-
// threshold value.

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

// --- T-CURTAIL-CHARGE (Christin 2026-06-25): a dcExportMode slot may carry a
// chargeReserveW (the EOS-planned battery charge). schedule-eval must subtract it
// from live PV BEFORE exporting, so "100 % Einspeisung" feeds in only the surplus
// ABOVE the charge (live PV − Haus − Reserve − Puffer) instead of dumping the power
// EOS wanted to store. Without the reserve the slot exports all surplus (unchanged).
function makeChargeReserveCtx({
  chargeReserveW, selfConsumptionW = 0, pvTotalW = 5000, batteryEfficiencyPct,
  targetSocPct, liveSocPct = 50, liveSocCfg, batteryCapacityWh, maxChargeW
} = {}) {
  return makeCtx({
    mutate: ({ state, cfg }) => {
      state.schedule.rules = [{
        id: 'opt-dc-charge-1', enabled: true, target: 'dcExportMode', value: 1,
        start: '00:00', end: '23:59', source: 'forecast_optimizer',
        autoManaged: true, optimizer: 'eos',
        ...(chargeReserveW != null ? { chargeReserveW } : {}),
        ...(targetSocPct != null ? { targetSocPct } : {})
      }];
      state.victron.soc = liveSocPct;
      state.victron.pvTotalW = pvTotalW;             // live PV
      state.victron.selfConsumptionW = selfConsumptionW;  // live house load → liveLoadW
      // Guard window forced always-on so the assertion is wall-clock independent;
      // the autoManaged EOS slot bypasses the SoC guard anyway.
      cfg.dcExportMode = {
        targetSocPct: 90, chargeDeadlineHour: 23, chargeGuardHours: 23, bufferW: 100,
        ...(batteryEfficiencyPct != null ? { batteryEfficiencyPct } : {})
      };
      cfg.optimizer.enabled = true;
      if (liveSocCfg != null) cfg.optimizer.liveSocChargeReserve = liveSocCfg;
      if (batteryCapacityWh != null) cfg.optimizer.batteryCapacityWh = batteryCapacityWh;
      if (maxChargeW != null) cfg.optimizer.maxChargeW = maxChargeW;
    }
  });
}

test('T-CURTAIL-CHARGE: dcExportMode subtracts chargeReserveW before exporting', async () => {
  const { ctx, logs, writes } = makeChargeReserveCtx({ chargeReserveW: 2000 });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();

  // export = -(live PV 5000 − Haus 0 − Reserve 2000 − Puffer 100) = -2900.
  // Without the reserve it would be -4900 → the 2000 W charge would be exported.
  assert.ok(writes.some((w) => w.target === 'gridSetpointW' && w.value === -2900),
    `expected -2900 (charge reserved), got ${JSON.stringify(writes)}`);
  const active = findLog(logs, 'dc_export_mode_active');
  assert.ok(active.length >= 1, 'dc_export_mode_active logged');
  assert.equal(active[0].payload.chargeReserveW, 2000, 'log carries the reserved charge');
});

test('T-CURTAIL-CHARGE: a dcExportMode slot WITHOUT chargeReserveW still exports all surplus', async () => {
  const { ctx, writes } = makeChargeReserveCtx({ chargeReserveW: null });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  // -(live PV 5000 − Haus 0 − Puffer 100) = -4900 (legacy pure-surplus behaviour;
  // Haus 0 ⇒ dynamischer Batterie-Effizienz-Aufschlag = 0)
  assert.ok(writes.some((w) => w.target === 'gridSetpointW' && w.value === -4900),
    `pure surplus unchanged: expected -4900, got ${JSON.stringify(writes)}`);
});

// --- Batterie-Effizienz-Aufschlag (Christin 2026-06-26): bei VOLLeinspeisung
// zieht der Eigenverbrauch real noch Leistung aus dem Akku (DC-AC-Wandlungs-
// verlust). Der Aufschlag ist DYNAMISCH = Hausverbrauch × (1 − Wirkungsgrad/100)
// und wird ZUSÄTZLICH vom Export zurückgehalten — aber NUR bei Volleinspeisung
// (kein chargeReserve) und mit aktivem Hausverbrauch-Abzug.
test('Batterie-Effizienz-Aufschlag: dynamischer Abzug bei Volleinspeisung (92% → 8% vom Verbrauch)', async () => {
  const { ctx, logs, writes } = makeChargeReserveCtx({ chargeReserveW: null, pvTotalW: 10000, selfConsumptionW: 5000 });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  // surcharge = round(5000 × 0.08) = 400; reserve = Haus 5000 + Puffer 100 + 400 = 5500
  // export = -(10000 − 5500) = -4500
  assert.ok(writes.some((w) => w.target === 'gridSetpointW' && w.value === -4500),
    `expected -4500 (dyn. Aufschlag 400), got ${JSON.stringify(writes)}`);
  const active = findLog(logs, 'dc_export_mode_active');
  assert.equal(active[0].payload.battEffSurchargeW, 400, 'log carries the dynamic surcharge');
});

test('Batterie-Effizienz-Aufschlag: skaliert mit dem Verbrauch (halber Verbrauch → halber Aufschlag)', async () => {
  const { ctx, logs } = makeChargeReserveCtx({ chargeReserveW: null, pvTotalW: 10000, selfConsumptionW: 2500 });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  // surcharge = round(2500 × 0.08) = 200 (half of the 5 kW case)
  assert.equal(findLog(logs, 'dc_export_mode_active')[0].payload.battEffSurchargeW, 200,
    'surcharge halves with half the consumption');
});

test('Batterie-Effizienz-Aufschlag: greift NICHT bei Teileinspeisung (chargeReserveW>0)', async () => {
  const { ctx, logs, writes } = makeChargeReserveCtx({ chargeReserveW: 2000, pvTotalW: 10000, selfConsumptionW: 5000 });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  // Teileinspeisung: surcharge 0; reserve = Haus 5000 + Puffer 100 + Reserve 2000 = 7100
  // export = -(10000 − 7100) = -2900
  assert.ok(writes.some((w) => w.target === 'gridSetpointW' && w.value === -2900),
    `expected -2900 (kein Aufschlag bei Teileinspeisung), got ${JSON.stringify(writes)}`);
  assert.equal(findLog(logs, 'dc_export_mode_active')[0].payload.battEffSurchargeW, 0,
    'no surcharge while the battery is charging');
});

test('Batterie-Effizienz-Aufschlag: 100% Wirkungsgrad → kein Aufschlag', async () => {
  const { ctx, logs } = makeChargeReserveCtx({ chargeReserveW: null, pvTotalW: 10000, selfConsumptionW: 5000, batteryEfficiencyPct: 100 });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  assert.equal(findLog(logs, 'dc_export_mode_active')[0].payload.battEffSurchargeW, 0,
    '100% efficiency disables the surcharge');
});

// --- T-LIVESOC-RESERVE (Variante B, Christin 2026-07-22): mit Flag AN und einem
// Plan-SoC-Ziel auf der Regel wird die Ladereserve pro Zyklus aus dem LIVE-SoC
// neu hergeleitet (reserveW = (targetSoc − liveSoc) × capWh / slotH) statt der
// Plan-Trajektorie zu trauen — selbstkorrigierend in beide Richtungen. Ohne
// Flag/Ziel/SoC/Kapazität gilt exakt der Plan-Wert (Variante-A-Verhalten).
test('T-LIVESOC-RESERVE: Akku hinter Plan → Live-Reserve ersetzt Plan-Reserve (0) und drosselt den Export', async () => {
  const { ctx, logs, writes } = makeChargeReserveCtx({
    chargeReserveW: null, pvTotalW: 10000, targetSocPct: 100, liveSocPct: 98,
    liveSocCfg: { enabled: true, logDeltaW: 1000 }, batteryCapacityWh: 60000
  });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  // liveReserve = (100−98)/100 × 60000 / 0.25h = 4800 W (Regel ohne slotTs → 15-min-Default)
  // export = −(10000 − 4800 − Puffer 100) = −5100 statt −9900 (Plan-Reserve war 0)
  assert.ok(writes.some((w) => w.target === 'gridSetpointW' && w.value === -5100),
    `expected -5100 (Live-Reserve 4800), got ${JSON.stringify(writes)}`);
  const lr = findLog(logs, 'live_soc_charge_reserve');
  assert.equal(lr.length, 1, 'Abweichung ≥ logDeltaW → genau ein Log pro Slot');
  assert.equal(lr[0].payload.liveReserveW, 4800);
  assert.equal(lr[0].payload.planChargeReserveW, 0);
  assert.equal(lr[0].payload.targetSocPct, 100);
  assert.equal(lr[0].payload.liveSocPct, 98);
  assert.equal(findLog(logs, 'dc_export_mode_active')[0].payload.chargeReserveW, 4800,
    'dc_export_mode_active trägt die LIVE-Reserve');
});

test('T-LIVESOC-RESERVE: Akku vor Plan → Live-Reserve 0 überstimmt Plan-Reserve, Export startet früher', async () => {
  const { ctx, writes } = makeChargeReserveCtx({
    chargeReserveW: 3000, pvTotalW: 10000, targetSocPct: 90, liveSocPct: 95,
    liveSocCfg: { enabled: true }, batteryCapacityWh: 60000
  });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  // (90−95) < 0 → Live-Reserve 0 → voller Überschuss −(10000 − 100) = −9900,
  // obwohl der Plan noch 3000 W zurückhalten wollte.
  assert.ok(writes.some((w) => w.target === 'gridSetpointW' && w.value === -9900),
    `expected -9900 (Akku ist schon voll genug), got ${JSON.stringify(writes)}`);
});

test('T-LIVESOC-RESERVE: Live-Reserve wird auf optimizer.maxChargeW geklemmt', async () => {
  const { ctx, writes } = makeChargeReserveCtx({
    chargeReserveW: null, pvTotalW: 10000, targetSocPct: 100, liveSocPct: 50,
    liveSocCfg: { enabled: true }, batteryCapacityWh: 60000, maxChargeW: 6000
  });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  // roh (100−50)/100 × 60000 / 0.25 = 120000 W → Klemme 6000 → export −(10000−6000−100) = −3900
  assert.ok(writes.some((w) => w.target === 'gridSetpointW' && w.value === -3900),
    `expected -3900 (Klemme maxChargeW 6000), got ${JSON.stringify(writes)}`);
});

test('T-LIVESOC-RESERVE: Flag AUS → Plan-Reserve gilt unverändert (Variante A)', async () => {
  const { ctx, logs, writes } = makeChargeReserveCtx({
    chargeReserveW: 2000, targetSocPct: 100, liveSocPct: 50,
    liveSocCfg: { enabled: false }, batteryCapacityWh: 60000
  });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  // wie der bestehende T-CURTAIL-CHARGE-Fall: −(5000 − 2000 − 100) = −2900
  assert.ok(writes.some((w) => w.target === 'gridSetpointW' && w.value === -2900),
    `expected -2900 (Plan-Reserve, Flag aus), got ${JSON.stringify(writes)}`);
  assert.equal(findLog(logs, 'live_soc_charge_reserve').length, 0, 'kein Live-Log ohne Flag');
});

test('T-LIVESOC-RESERVE: Flag AN aber Regel ohne targetSocPct → Fallback auf Plan-Reserve', async () => {
  const { ctx, writes } = makeChargeReserveCtx({
    chargeReserveW: 2000, liveSocPct: 50,
    liveSocCfg: { enabled: true }, batteryCapacityWh: 60000
  });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  assert.ok(writes.some((w) => w.target === 'gridSetpointW' && w.value === -2900),
    `expected -2900 (kein SoC-Ziel auf der Regel), got ${JSON.stringify(writes)}`);
});

test('T-LIVESOC-RESERVE: Log dedupliziert pro Slot (zweiter Zyklus loggt nicht erneut)', async () => {
  const { ctx, logs } = makeChargeReserveCtx({
    chargeReserveW: null, pvTotalW: 10000, targetSocPct: 100, liveSocPct: 98,
    liveSocCfg: { enabled: true, logDeltaW: 1000 }, batteryCapacityWh: 60000
  });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  await evaluator.evaluateSchedule();
  assert.equal(findLog(logs, 'live_soc_charge_reserve').length, 1,
    'gleicher Slot → nur ein live_soc_charge_reserve-Eintrag');
});

// --- 25-01/25-02: EEG/§14a-Gate-Verfeinerung (Self-Consumption + dc_export) ----
// Befund 1+2: Das EEG-Gate (schedule-eval.js EEG-Block) lehnt heute JEDEN
// gridSetpointW < 0 bei allowGridDischarge=false als grid_discharge_not_allowed
// ab — auch den legalen Idle-Default (-40, source='default') und die PV-
// Überschuss-Einspeisung (dc_export_mode). Nach der Verfeinerung darf das Gate
// nur noch eine ECHTE erzwungene Netzentladung (value <= FORCED_EXPORT_THRESHOLD_W
// = -1000, aus diskretionärer Nicht-dc_export-Quelle) blockieren. SoC ist hier
// frisch + über dem Hardfloor gesetzt, damit der nachgelagerte T-0075-Floor die
// Gate-Aussage nicht verfälscht — die Assertion zielt gezielt auf die An-/
// Abwesenheit von reason='grid_discharge_not_allowed'.

test('25-01: Idle-Default (-40, source=default) passiert das EEG-Gate bei allowGridDischarge=false', async () => {
  const { ctx, state, logs, writes } = makeCtx({
    mutate: ({ cfg, state }) => {
      cfg.optimizer = { enabled: false, allowGridCharge: false, allowGridDischarge: false };
      state.victron.soc = 50;
      state.victron.fieldUpdatedAt = { soc: Date.now() }; // frisch → T-0075 greift nicht
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  const r = await evaluator.applyControlTarget('gridSetpointW', -40, 'default');

  assert.equal(r.ok, true, 'der legale Self-Consumption-Idle-Setpoint muss passieren');
  assert.notEqual(r.error, 'grid_discharge_not_allowed',
    'kein grid_discharge_not_allowed für einen -40 Idle-Setpoint');
  assert.equal(
    logs.filter((l) => l.event === 'control_write_rejected' && l.payload.reason === 'grid_discharge_not_allowed').length,
    0,
    'das EEG-Gate darf den Idle-Default nicht als Netzentladung ablehnen'
  );
  assert.equal(writes.filter((w) => w.target === 'gridSetpointW' && w.value === -40).length, 1,
    'der -40 Setpoint erreicht die Hardware');
});

test('25-02: dc_export_mode (-3000) passiert das EEG-Gate bei allowGridDischarge=false', async () => {
  const { ctx, state, logs } = makeCtx({
    mutate: ({ cfg, state }) => {
      cfg.optimizer = { enabled: false, allowGridCharge: false, allowGridDischarge: false };
      state.victron.soc = 50;
      state.victron.fieldUpdatedAt = { soc: Date.now() }; // frisch → T-0075 greift nicht
    }
  });
  const evaluator = createScheduleEvaluator(ctx);

  const r = await evaluator.applyControlTarget('gridSetpointW', -3000, 'dc_export_mode');

  // dc_export_mode ist PV-Überschuss-Einspeisung (eigene legale Klasse, Befund 2),
  // KEIN Akku→Netz-Verkauf. Das EEG-Gate darf es NICHT als Netzentladung ablehnen.
  // Ein anderer Floor/Bounds darf greifen — nur grid_discharge_not_allowed nicht.
  assert.notEqual(r.error, 'grid_discharge_not_allowed',
    'dc_export_mode darf nicht als grid_discharge_not_allowed abgelehnt werden');
  assert.equal(
    logs.filter((l) => l.event === 'control_write_rejected' && l.payload.reason === 'grid_discharge_not_allowed').length,
    0,
    'kein grid_discharge_not_allowed-Reject für dc_export_mode'
  );
});

// --- Pro-Gating (Task #11): forecast_optimizer (EOS/optimizer dispatch) gate ---

test('Pro-Gating: forecast_optimizer rule actuates when the licence is active', async () => {
  const { ctx, state } = makeCtx({
    mutate: ({ state, cfg, ctx }) => {
      state.schedule.rules = [{
        id: 'opt-1', enabled: true, target: 'gridSetpointW',
        start: '00:00', end: '23:59', value: -5000,
        source: 'forecast_optimizer', autoManaged: true
      }];
      cfg.optimizer = { enabled: true, allowGridCharge: false, allowGridDischarge: true };
      ctx.licenseService = { isProActive: () => true };   // Pro active → not gated
    }
  });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  assert.equal(Number(state.schedule.active.gridSetpointW?.value), -5000,
    'with an active licence the forecast_optimizer setpoint must actuate');
});

test('Pro-Gating: forecast_optimizer rule is skipped without a licence (Stage 1/2 fallback)', async () => {
  const { ctx, state } = makeCtx({
    mutate: ({ state, cfg, ctx }) => {
      state.schedule.rules = [{
        id: 'opt-1', enabled: true, target: 'gridSetpointW',
        start: '00:00', end: '23:59', value: -5000,
        source: 'forecast_optimizer', autoManaged: true
      }];
      cfg.optimizer = { enabled: true, allowGridCharge: false, allowGridDischarge: true };
      ctx.licenseService = { isProActive: () => false };  // Pro gate closed
    }
  });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.evaluateSchedule();
  assert.notEqual(Number(state.schedule.active.gridSetpointW?.value), -5000,
    'without a licence the forecast_optimizer setpoint must NOT actuate (EOS gated → Stage 1/2)');
});

// --- Issue #8: Not-Halt gibt die diskretionäre PV-Abregelung frei ------------
// Regression: der Not-Halt (state.ctrl.discretionaryWritesPaused) stoppte bisher
// nur applyControlTarget (gridSetpoint), NICHT die diskretionäre PV-Abregelung
// über applyDvVictronControl. Gemeldet von FrodoVDR (GH #8): PV wurde trotz
// Not-Halt weiter runtergeregelt. Jetzt gibt der Schedule-Pfad die PV frei.
test('Issue #8: Not-Halt gibt die PV frei (emergency_stop_release), ohne Not-Halt bleibt Abregelung', async () => {
  const build = (paused) => makeCtx({
    mutate: ({ state, cfg }) => {
      state.schedule.rules = [];                          // nur der DV-Pfad ist relevant
      state.ctrl.discretionaryWritesPaused = paused;
      state.schedule.config.defaultFeedExcessDcPv = 0;    // normal: NICHT einspeisen -> abregeln
      cfg.dvControl = {
        enabled: true,
        feedExcessDcPv: { enabled: true, address: 2707 },
        dontFeedExcessAcPv: { enabled: true, address: 2708 },
        negativePriceProtection: { enabled: true, gridSetpointW: -40 }
      };
    }
  });

  // Ohne Not-Halt: Default 0 -> PV wird abgeregelt (feedIn=false).
  const off = build(false);
  await createScheduleEvaluator(off.ctx).evaluateSchedule();
  assert.equal(off.state.schedule.active.feedExcessDcPv.value, 0, 'ohne Not-Halt bleibt die Abregelung');
  assert.ok(off.writes.some((w) => w.target === 'feedExcessDcPv' && w.value === 0), 'feedExcessDcPv=0 geschrieben');

  // Mit Not-Halt: PV wird freigegeben (feedIn=true) trotz Default 0.
  const on = build(true);
  await createScheduleEvaluator(on.ctx).evaluateSchedule();
  assert.equal(on.state.schedule.active.feedExcessDcPv.source, 'emergency_stop_release', 'Quelle = emergency_stop_release');
  assert.equal(on.state.schedule.active.feedExcessDcPv.value, 1, 'Not-Halt gibt die PV frei');
  assert.ok(on.writes.some((w) => w.target === 'feedExcessDcPv' && w.value === 1), 'feedExcessDcPv=1 (einspeisen)');
  assert.ok(on.writes.some((w) => w.target === 'dontFeedExcessAcPv' && w.value === 0), 'dontFeedExcessAcPv=0 (nicht sperren)');
});

// --- T-VERIFY: Read-after-Write-Verifikation (Christin 2026-07-20) -----------
// Der Regelkreis: echter Write → readPointSince → Soll-Ist-Vergleich.
// Match → still (lastOkAt). Mismatch → control_write_unconfirmed + lastWrite
// verworfen (nächster Assert schreibt neu). 3× in Folge → verify_failed.
// Lese-Fehler → verify_error, lastWrite bleibt (Lese-Schwäche ≠ Schreib-Fehler).

function makeVerifyCtx({ readBack } = {}) {
  const readCalls = [];
  return makeCtx({
    mutate: ({ state, cfg, ctx }) => {
      state.victron.fieldUpdatedAt = { soc: Date.now() }; // T-0075-Floor: SoC frisch
      cfg.schedule.controlWriteVerify = { enabled: true, delayMs: 20, minIntervalMs: 25, toleranceAbs: 0 };
      ctx.transport = {
        type: 'mqtt',
        mqttWrite: async () => {},
        readPointSince: async (name, sinceTs) => {
          readCalls.push({ name, sinceTs });
          return readBack(name, sinceTs);
        }
      };
      ctx._readCalls = readCalls;
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('T-VERIFY: match → kein Event, lastWrite bleibt, lastOkAt gesetzt', async () => {
  const { ctx, state, logs } = makeVerifyCtx({
    readBack: async () => ({ mqttValue: -3000, ts: Date.now() })
  });
  const evaluator = createScheduleEvaluator(ctx);
  const res = await evaluator.applyControlTarget('gridSetpointW', -3000, 'test');
  assert.equal(res.ok, true);
  await sleep(80);
  assert.equal(ctx._readCalls.length, 1, 'genau ein Verify-Read');
  assert.equal(findLog(logs, 'control_write_unconfirmed').length, 0);
  assert.ok(state.schedule.lastWrite.gridSetpointW, 'lastWrite bleibt bestehen');
  assert.ok(state.schedule._verify.gridSetpointW.lastOkAt > 0, 'Erfolg verbucht');
});

test('T-VERIFY: mismatch → unconfirmed + lastWrite verworfen (Re-Write-Pfad frei)', async () => {
  const { ctx, state, logs } = makeVerifyCtx({
    readBack: async () => ({ mqttValue: 0, ts: Date.now() }) // Gerät hat NICHT übernommen
  });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'test');
  await sleep(80);
  const ev = findLog(logs, 'control_write_unconfirmed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.expected, -3000);
  assert.equal(ev[0].payload.actual, 0);
  assert.equal(state.schedule.lastWrite.gridSetpointW, undefined,
    'lastWrite verworfen → Unchanged-Short-Circuit greift nicht mehr, nächster Assert schreibt neu');
  assert.equal(state.schedule._verify.gridSetpointW.mismatches, 1);
});

test('T-VERIFY: 3 Mismatches in Folge eskalieren zu verify_failed', async () => {
  const { ctx, logs } = makeVerifyCtx({
    readBack: async () => ({ mqttValue: 0, ts: Date.now() })
  });
  const evaluator = createScheduleEvaluator(ctx);
  for (let i = 0; i < 3; i++) {
    await evaluator.applyControlTarget('gridSetpointW', -3000, 'test');
    await sleep(90); // > delayMs + minIntervalMs
  }
  assert.equal(findLog(logs, 'control_write_unconfirmed').length, 3);
  assert.equal(findLog(logs, 'control_write_verify_failed').length, 1, 'Eskalation beim 3.');
});

test('T-VERIFY: Lese-Fehler → verify_error, lastWrite bleibt (kein Verwerfen)', async () => {
  const { ctx, state, logs } = makeVerifyCtx({
    readBack: async () => { throw new Error('Kein Nach-Write-Wert empfangen für: gridSetpointW'); }
  });
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'test');
  await sleep(80);
  assert.equal(findLog(logs, 'control_write_verify_error').length, 1);
  assert.equal(findLog(logs, 'control_write_unconfirmed').length, 0);
  assert.ok(state.schedule.lastWrite.gridSetpointW, 'lastWrite bleibt — Gerät nicht für Lese-Schwäche strafen');
});

test('T-VERIFY: Flag OFF (default) → kein Verify-Read', async () => {
  const { ctx } = makeVerifyCtx({
    readBack: async () => ({ mqttValue: -3000, ts: Date.now() })
  });
  ctx.getCfg().schedule.controlWriteVerify.enabled = false;
  const evaluator = createScheduleEvaluator(ctx);
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'test');
  await sleep(80);
  assert.equal(ctx._readCalls.length, 0, 'default OFF: Verhalten unverändert');
});
