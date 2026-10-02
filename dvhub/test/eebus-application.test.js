// §14a/EEBUS: Umsetzung der Grenzen in DVhubs Steuerpfaden.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFeedInLimitArbiter } from '../services/feed-in-limit-arbiter.js';
import { applyGridCap, resolveEvccBridgeConfig } from '../services/optimizer/eos-evcc-bridge.js';
import { createScheduleEvaluator } from '../schedule-eval.js';

// --- Einspeisegrenze: mehrere Quellen ----------------------------------------

test('Arbiter: kleinste Grenze gilt, Aufheben schreibt den alten Wert zurück (null)', async () => {
  const writes = [];
  const a = createFeedInLimitArbiter({ applyLimit: async (w) => { writes.push(w); } });
  await a.set('dv', 20000);
  await a.set('eebus_lpp', 8000);
  await a.set('dv', 12000);           // 8000 bleibt die kleinste → kein neuer Schreibvorgang
  await a.set('eebus_lpp', null);     // jetzt gilt 12000
  await a.set('dv', null);            // keine Quelle mehr → zurückschreiben
  assert.deepEqual(writes, [20000, 8000, 12000, null]);
  assert.equal(a.effective(), null);
});

test('Arbiter: ohne vorherige Grenze wird beim Aufheben nichts geschrieben', async () => {
  const writes = [];
  const a = createFeedInLimitArbiter({ applyLimit: async (w) => { writes.push(w); } });
  await a.set('eebus_lpp', null);
  assert.deepEqual(writes, []);
});

test('Arbiter: Schreibfehler wird an den Aufrufer gemeldet, der nächste Versuch schreibt erneut', async () => {
  let fail = true;
  const writes = [];
  const a = createFeedInLimitArbiter({ applyLimit: async (w) => { writes.push(w); if (fail) throw new Error('modbus'); } });
  await assert.rejects(a.set('eebus_lpp', 5000), /modbus/);
  fail = false;
  await a.set('eebus_lpp', 5000);
  assert.deepEqual(writes, [5000, 5000]);
});

// --- Wallbox -------------------------------------------------------------------

test('Wallbox: §14a-Anteil kappt den Ladestrom, unter dem Mindeststrom wird gestoppt', () => {
  const bc = resolveEvccBridgeConfig({ optimizer: { evMaxChargeW: 11000, evMinCurrentA: 6 } });
  const charge = { action: 'charge', currentA: 16 };
  assert.equal(applyGridCap(charge, bc, null), charge, 'ohne Grenze unverändert');
  assert.equal(applyGridCap(charge, bc, 6900).currentA, 10, '6900 W / (230 V × 3) = 10 A');
  const stop = applyGridCap(charge, bc, 3000);
  assert.equal(stop.action, 'stop', '3000 W < 6 A × 230 V × 3');
  assert.equal(applyGridCap(charge, bc, 20000), charge, 'Grenze über dem Plan: unverändert');
  assert.equal(applyGridCap({ action: 'stop', currentA: null }, bc, 1000).action, 'stop');
});

// --- Akku: Netzladen unter §14a nur bis zum Anteil -----------------------------

function evalCtx(limitW, batteryGridW = 0) {
  const writes = [];
  const logs = [];
  const state = {
    victron: { soc: 50, batteryDischargeW: 0, batteryChargeW: 0, batteryPowerW: 0, pvTotalW: 0, pvPowerW: 0 },
    schedule: {
      rules: [{ id: 'r1', enabled: true, target: 'gridSetpointW', start: '00:00', end: '23:59', value: 3000, source: 'manual' }],
      active: {}, lastWrite: {}, manualOverride: {},
      config: { defaultGridSetpointW: -40, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 },
      lastEvalAt: 0,
    },
    ctrl: { negativePriceActive: false, forcedOff: false, p14aBatteryGridW: limitW == null ? null : batteryGridW },
    p14a: { active: limitW != null, limitW, source: 'eebus' },
    epex: { data: [] },
  };
  const cfg = {
    controlWrite: { gridSetpointW: { enabled: true, address: 100 }, chargeCurrentA: { enabled: false } },
    dvControl: { enabled: false, negativePriceProtection: { enabled: true } },
    optimizer: { enabled: false, allowGridCharge: true, allowGridDischarge: true, hardFloorSocPct: 5 },
    dcExportMode: {},
    schedule: { timezone: 'Europe/Berlin', manualOverrideTtlMs: 300000, controlKeepaliveMs: 0, defaultGridSetpointW: -100, smallMarketAutomation: { enabled: false } },
  };
  const ctx = {
    state,
    getCfg: () => cfg,
    transport: { type: 'mqtt', mqttWrite: async (target, value) => { writes.push({ target, value }); } },
    pushLog: (event, payload) => { logs.push({ event, payload }); },
    telemetrySafeWrite: (fn) => { try { fn?.(); } catch { /* */ } },
    persistConfig: async () => {},
    telemetryStore: null,
    epexNowNext: () => ({ current: { ct_kwh: 12, eur_mwh: 120 }, next: null }),
    regenerateSmallMarketAutomationRules: async () => {},
    onEvalComplete: () => {},
  };
  return { evaluator: createScheduleEvaluator(ctx), writes, logs };
}

test('Akku: unter §14a-Bezugsgrenze ohne Anteil kein Netzladen — Sollwert bleibt beim Eigenverbrauch', async () => {
  const limited = evalCtx(4200, 0);
  await limited.evaluator.evaluateSchedule();
  const grid = limited.writes.filter((w) => w.target === 'gridSetpointW');
  assert.ok(grid.length > 0, 'Sollwert wird geschrieben');
  assert.ok(grid.every((w) => w.value <= 0), `kein positiver Sollwert: ${JSON.stringify(grid)}`);
  assert.ok(limited.logs.some((l) => l.event === 'paragraph14a_grid_charge_capped'));

  const free = evalCtx(null);
  await free.evaluator.evaluateSchedule();
  const g2 = free.writes.filter((w) => w.target === 'gridSetpointW');
  assert.equal(g2.at(-1)?.value, 3000, 'ohne Grenze lädt der Akku wie geplant');
});

test('Akku: mit §14a-Anteil lädt er bis zum Anteil aus dem Netz', async () => {
  const capped = evalCtx(7560, 2000);
  await capped.evaluator.evaluateSchedule();
  const grid = capped.writes.filter((w) => w.target === 'gridSetpointW');
  assert.equal(grid.at(-1)?.value, 2000, 'Plan 3000 W → Anteil 2000 W');

  const enough = evalCtx(7560, 5000);
  await enough.evaluator.evaluateSchedule();
  assert.equal(enough.writes.filter((w) => w.target === 'gridSetpointW').at(-1)?.value, 3000, 'Plan unter dem Anteil: unverändert');
});
