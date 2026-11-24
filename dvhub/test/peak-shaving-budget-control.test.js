// test/peak-shaving-budget-control.test.js — Peak Shaving P1 am echten Steuerpfad (Victron).
//
// Der Dienst (services/peak-shaving createPeakShaving) führt das Viertelstunden-Budget aus den Zählerabfragen
// (pollTick); der Evaluator holt sich je Write das wirksame Regelziel (ctx.peakShaving.control). Geprüft wird, was
// auf dem Draht landet (2716 Netz-Sollwert, 2704 Entladegrenze), mit dem ausgelieferten Victron-Profil.
//
// Grenze 10 000 W, Abstand 300 W → Augenblicks-Ziel 9 700 W. Entladeleistung eingetragen 10 000 W.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadVictronConfig, PEAK_ON, makeTelemetryState, makeEvaluator, gridSetpointWrites, maxDischargeWrites
} from './helpers/peak-shaving-harness.js';
import { createPeakShaving } from '../services/peak-shaving/index.js';
import { quarterHourSlot } from '../services/peak-shaving/budget.js';

const POWER = { system: { power: { batteryMaxDischargeDcW: 10000 } } };

// Virtuelle Uhr: Anfang einer Viertelstunde mindestens 20 min in der Vergangenheit. Die Messwerte tragen echte
// (jüngere) Stempel — für den Dienst sind sie damit frisch.
function clockAtSlotStart() {
  const start = quarterHourSlot(Date.now() - 20 * 60_000, 'Europe/Berlin').startMs;
  return { wall: start, mono: 1_000_000 };
}

function setImport(state, cfg, importW) {
  // gridPositiveMeans 'feed_in' (Vorgabe): positiv = Einspeisung → Bezug negativ zählen.
  const sign = cfg.gridPositiveMeans === 'grid_import' ? 1 : -1;
  state.meter.grid_total_w = sign * importW;
  state.meter.ok = true;
  state.meter.updatedAt = Date.now();
  state.victron.gridImportW = importW;
}

function rig({ persisted = {}, telemetry = {} } = {}) {
  const cfg = loadVictronConfig({ ...PEAK_ON, ...POWER, optimizer: { allowGridCharge: true, allowGridDischarge: true }, ...persisted });
  const state = makeTelemetryState({ soc: 60, loadW: 15000, ...telemetry });
  // Akku-Leistung frisch gemessen (das Budget verlangt sie).
  if (!telemetry.noBatteryStamp) state.victron.fieldUpdatedAt.batteryPowerW = Date.now();
  const clock = clockAtSlotStart();
  const logs = [];
  const ps = createPeakShaving({ state, getCfg: () => cfg, pushLog: (e, p) => logs.push({ event: e, payload: p }) },
    { now: () => clock.wall, monoNow: () => clock.mono });
  const h = makeEvaluator({ cfg, state, extraCtx: { peakShaving: ps } });
  const advance = (ms, importW) => {
    for (let t = 0; t < ms; t += 2000) {
      clock.wall += 2000;
      clock.mono += 2000;
      setImport(state, cfg, importW);
      ps.pollTick();
    }
  };
  return { ...h, cfg, state, ps, clock, advance, psLogs: logs };
}

test('Budget: nach 5 min mit 5 kW darf ein 14,7-kW-Sollwert bis 12 kW (statt 9,7 kW) — Akku wird weniger gebraucht', async () => {
  // verbraucht 5 000 W × 300 s = 1 500 000 Ws; erlaubt (9 700 × 900 − 1 500 000) / 600 s = 12 050 W → 12 000 W.
  const { evaluator, transport, advance, state, cfg, ps } = rig();
  advance(300_000, 5000);
  setImport(state, cfg, 15000);
  const ctl = ps.control(cfg);
  assert.equal(ctl.budget.mode, 'budget', JSON.stringify(ctl.budget));
  assert.equal(ctl.targetW, 12000);
  await evaluator.applyControlTarget('gridSetpointW', 14700, 'rule:hold');
  assert.deepEqual(gridSetpointWrites(transport), [12000]);
});

test('Einstellung „Abrechnung nach 15-min-Mittelwert“ aus: Deckel auf den Augenblickswert (9 700 W) wie bisher', async () => {
  const { evaluator, transport, advance, state, cfg } = rig({ persisted: { peakShaving: { ...PEAK_ON.peakShaving, billing15min: false } } });
  advance(300_000, 5000);
  setImport(state, cfg, 15000);
  await evaluator.applyControlTarget('gridSetpointW', 14700, 'rule:hold');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

test('Akku nahe am Boden (8 %, Boden 5 %): sofort Augenblickswert 9 700 W', async () => {
  const { evaluator, transport, advance, state, cfg, ps } = rig({ telemetry: { soc: 8 } });
  advance(300_000, 5000);
  setImport(state, cfg, 15000);
  assert.equal(ps.control(cfg).budget.reason, 'soc_near_floor');
  await evaluator.applyControlTarget('gridSetpointW', 14700, 'rule:hold');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

test('Entladeleistung nicht eingetragen: Augenblickswert (DVhub weiß nicht, ob der Akku zurückholen kann)', async () => {
  const cfg0 = { system: { power: {} } };
  const { evaluator, transport, advance, state, cfg, ps } = rig({ persisted: cfg0 });
  advance(300_000, 5000);
  setImport(state, cfg, 15000);
  assert.equal(ps.control(cfg).budget.reason, 'discharge_unknown');
  await evaluator.applyControlTarget('gridSetpointW', 14700, 'rule:hold');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

test('Dauerspitze von Anfang an: Budget greift sofort mit ≤ 9 700 W', async () => {
  const { evaluator, transport, advance, state, cfg } = rig();
  advance(4000, 15000);
  setImport(state, cfg, 15000);
  await evaluator.applyControlTarget('gridSetpointW', 14700, 'rule:hold');
  const [w] = gridSetpointWrites(transport);
  assert.ok(w <= 9700, `geschrieben ${w}`);
});

test('kurze Spitze bei gesperrtem Akku (2704 = 0): keine Freigabe, solange die Hochrechnung unter dem Budget bleibt', async () => {
  // Augenblickswert hätte nach 2 Takten über 10 kW freigegeben (test/peak-shaving-discharge.test.js).
  const { evaluator, transport, advance, state, cfg } = rig({ telemetry: { loadW: 12000 } });
  const r = await evaluator.applyControlTarget('maxDischargeW', 0, 'api_manual_write');
  assert.equal(r.ok, true);
  advance(300_000, 5000);
  advance(4000, 12000);
  setImport(state, cfg, 12000);
  for (let i = 0; i < 3; i += 1) await evaluator.evaluateSchedule();
  assert.deepEqual(maxDischargeWrites(transport), [0], 'keine Freigabe: 12 kW < erlaubte 12,05 kW');
});

test('dieselbe Lage ohne Budget (Einstellung aus): Freigabe nach 2 Takten (heutiges Verhalten)', async () => {
  const { evaluator, transport, advance, state, cfg } = rig({
    telemetry: { loadW: 12000 }, persisted: { peakShaving: { ...PEAK_ON.peakShaving, billing15min: false } }
  });
  await evaluator.applyControlTarget('maxDischargeW', 0, 'api_manual_write');
  advance(300_000, 5000);
  advance(4000, 12000);
  setImport(state, cfg, 12000);
  for (let i = 0; i < 2; i += 1) await evaluator.evaluateSchedule();
  assert.deepEqual(maxDischargeWrites(transport), [0, 2300], '12 000 − 9 700 = 2 300 W');
});

test('Status zeigt das Budget (Modus, verbraucht/Budget, Restzeit)', () => {
  const { advance, state, cfg, ps } = rig();
  advance(300_000, 5000);
  setImport(state, cfg, 15000);
  const s = ps.summary();
  assert.equal(s.billing15min, true);
  assert.equal(s.budget.mode, 'budget');
  assert.equal(s.budget.budgetWh, 2500, '10 kW × 15 min');
  assert.ok(s.budget.usedWh >= 416 && s.budget.usedWh <= 420, `verbraucht ${s.budget.usedWh}`);
  assert.equal(s.budget.controlTargetW, 12000);
  assert.ok(s.budget.remainingS > 590 && s.budget.remainingS <= 600);
});

test('Peak Shaving aus: Dienst rechnet nichts, Evaluator unverändert', async () => {
  const { evaluator, transport, advance, state, cfg, ps } = rig({ persisted: { updateChannel: 'stable' } });
  advance(10_000, 15000);
  assert.equal(ps._budget.lastMono, null);
  setImport(state, cfg, 15000);
  await evaluator.applyControlTarget('gridSetpointW', 14700, 'rule:hold');
  assert.deepEqual(gridSetpointWrites(transport), [14700]);
});

test('Akku-Leistung nicht frisch gemessen: Augenblickswert (Codex d7dcce9c P2)', async () => {
  const { evaluator, transport, advance, state, cfg, ps } = rig({ telemetry: { noBatteryStamp: true } });
  advance(300_000, 5000);
  setImport(state, cfg, 15000);
  assert.equal(ps.control(cfg).budget.reason, 'battery_power_unknown');
  await evaluator.applyControlTarget('gridSetpointW', 14700, 'rule:hold');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

test('Entladegrenze im Gerät unter der Nennleistung zählt mit (Codex d7dcce9c P1)', async () => {
  // 2704 liest 1 000 W (Fremdwert, nicht von DVhub): Luft 1 000 − 500 Reserve = 500 W < 15 000 − 9 700 → Augenblickswert.
  const { advance, state, cfg, ps } = rig({ telemetry: { maxDischargeW: 1000, maxDischargeAgeMs: 1000 } });
  advance(300_000, 5000);
  setImport(state, cfg, 15000);
  assert.equal(ps.control(cfg).budget.reason, 'discharge_limited');
  // 9 000 W Bezug: Ziel höchstens 9 700 + 500 = 10 200 W statt 12 000 W
  setImport(state, cfg, 9000);
  const c = ps.control(cfg);
  assert.equal(c.budget.mode, 'budget');
  assert.equal(c.targetW, 10200);
});
