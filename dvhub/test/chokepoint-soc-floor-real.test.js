// Befund 1.4-2 (Christin 16.11.2026): der Chokepoint-Entlade-Boden verglich den von Sungrow gemeldeten,
// FENSTERRELATIVEN SoC mit dem REALEN harten Boden. Gemeldet 1 % (real ~11 % bei Fenster 10–100) sperrte den Boden
// also fälschlich. Fix: am Boden den ECHTEN SoC verwenden (floorSocPct, konsistent zum Zeitplan-Fix planningSocPct).

import test from 'node:test';
import assert from 'node:assert/strict';

import { floorSocPct } from '../services/multi-gx/planning.js';
import { createScheduleEvaluator } from '../schedule-eval.js';

// --- Teil 1: floorSocPct (rein) ---------------------------------------------------------------------------

function sungrowCtx({ reported, min = 10, max = 100 } = {}) {
  return {
    getCfg: () => ({ manufacturer: 'sungrow', sungrow: {} }),
    state: { victron: { soc: reported, device: { minSocPctDevice: min, maxSocPctDevice: max } } }
  };
}

test('floorSocPct: Sungrow gemeldet 1 % (Fenster 10–100) → real ~11 %, nicht 1 %', () => {
  const v = floorSocPct(sungrowCtx({ reported: 1 }));
  assert.ok(Math.abs(v - 10.9) < 1e-9, `erwartet ~10,9, bekam ${v}`);
});

test('floorSocPct: ohne gelesenes Fenster bleibt der gemeldete Wert stehen (rückwärtskompatibel)', () => {
  const v = floorSocPct(sungrowCtx({ reported: 30, min: null, max: null }));
  assert.equal(v, 30);
});

test('floorSocPct: non-Sungrow nutzt unverändert socFloorPct ?? soc', () => {
  const ctx = { getCfg: () => ({ manufacturer: 'victron' }), state: { victron: { soc: 42 } } };
  assert.equal(floorSocPct(ctx), 42);
  const ctx2 = { getCfg: () => ({ manufacturer: 'victron' }), state: { victron: { soc: 42, socFloorPct: 20 } } };
  assert.equal(floorSocPct(ctx2), 20, 'socFloorPct (Multi-GX) hat Vorrang');
});

test('floorSocPct: unbekannter SoC → null (Aufrufer hält fail-safe)', () => {
  assert.equal(floorSocPct(sungrowCtx({ reported: null })), null);
});

// --- Teil 2: der Chokepoint-Boden sperrt bei gemeldet 1 % (real 11 %) NICHT fälschlich ---------------------

function makeTransport() {
  return {
    type: 'modbus', writes: [],
    async mbWriteSingle({ address, value }) { this.writes.push({ fc: 6, address, value }); },
    async mbWriteMultiple({ address, values }) { this.writes.push({ fc: 16, address, values }); }
  };
}

function rig({ reportedSoc, min = 10, max = 100 }) {
  const cfg = {
    manufacturer: 'sungrow',
    sungrow: {},
    optimizer: { hardFloorSocPct: 5 },
    victron: { telemetryMaxAgeMs: 90000 },
    controlWrite: { maxDischargeW: { enabled: true, fc: 6, address: 2704, writeType: 'uint16', scale: 1, offset: 0 } }
  };
  const now = Date.now();
  const state = {
    victron: { soc: reportedSoc, device: { minSocPctDevice: min, maxSocPctDevice: max }, fieldUpdatedAt: { soc: now } },
    ctrl: {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
  const logs = [];
  const transport = makeTransport();
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: (event, details) => logs.push({ event, details }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => null
  });
  return { evaluator, state, transport, logs };
}

test('Chokepoint-Boden: Sungrow gemeldet 1 % (real ~11 %) sperrt die Entladung NICHT fälschlich', async () => {
  const { evaluator, transport, logs } = rig({ reportedSoc: 1 });
  const res = await evaluator.applyControlTarget('maxDischargeW', 5000, 'eos_optimization');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(transport.writes, [{ fc: 6, address: 2704, value: 5000 }], 'volle Entladung geschrieben, nicht auf 0 gehalten');
  assert.ok(!logs.some((l) => l.event === 'control_discharge_floor'), 'kein fälschlicher Boden-Halt');
});

test('Chokepoint-Boden: Sungrow real unter dem Boden hält weiterhin (gemeldet 0 %, Fenster 0–100 → real 0 %)', async () => {
  const { evaluator, transport, logs } = rig({ reportedSoc: 0, min: 0, max: 100 });
  const res = await evaluator.applyControlTarget('maxDischargeW', 5000, 'eos_optimization');
  assert.equal(res.ok, true);
  assert.deepEqual(transport.writes, [{ fc: 6, address: 2704, value: 0 }], 'am realen Boden auf 0 gehalten');
  assert.ok(logs.some((l) => l.event === 'control_discharge_floor' && l.details.reason === 'below_hard_floor'));
});
