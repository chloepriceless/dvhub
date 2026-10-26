// test/peak-shaving-setpoint.test.js — Peak Shaving (GitHub #28), Hebel 1:
// Deckel auf DVhubs eigenen positiven Netz-Sollwert (Victron 2716).
//
// Bei Victron ESS ist ein positiver gridSetpointW der gewünschte Netzbezug am
// Zähler. Regelziel = Grenze − Abstand = 10 000 − 300 = 9 700 W (PEAK_ON).
// Die Rechnungen stehen jeweils am Test.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadVictronConfig, PEAK_ON, makeTelemetryState, makeEvaluator, gridSetpointWrites
} from './helpers/peak-shaving-harness.js';
import { activeWindow } from './helpers/active-window.js';

const GRID_CHARGE_ON = { optimizer: { allowGridCharge: true, allowGridDischarge: true } };

function harness({ persisted = {}, telemetry = {} } = {}) {
  const cfg = loadVictronConfig({ ...GRID_CHARGE_ON, ...persisted });
  const state = makeTelemetryState(telemetry);
  return makeEvaluator({ cfg, state });
}

// --- (a) eigenes Netzladen ----------------------------------------------------

test('(a) Netzladen 12 kW, Last 3 kW: Deckel auf 9 700 W (reine Lademinderung)', async () => {
  // Netto-Last 3 000 W < Ziel 9 700 W → der Akku lädt mit 9 700 − 3 000 = 6 700 W
  // statt 9 000 W; er entlädt nie. Bezug am Zähler = 9 700 W ≤ 10 000 W.
  const { evaluator, transport, logs, state } = harness({ persisted: PEAK_ON });
  const r = await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
  const log = logs.find((l) => l.event === 'peak_shaving_clamp');
  assert.ok(log, 'Deckel wird geloggt');
  assert.equal(log.payload.requestedW, 12000);
  assert.equal(log.payload.valueW, 9700);
  assert.equal(log.payload.mode, 'target');
  assert.equal(state.ctrl._peakShaving.clamp.mode, 'target');
});

test('(a) Sollwert unter dem Ziel bleibt unverändert (8 000 W)', async () => {
  const { evaluator, transport, logs } = harness({ persisted: PEAK_ON });
  await evaluator.applyControlTarget('gridSetpointW', 8000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [8000]);
  assert.equal(logs.some((l) => l.event === 'peak_shaving_clamp'), false);
});

test('(a) genau auf dem Ziel (9 700 W) bleibt unverändert', async () => {
  const { evaluator, transport } = harness({ persisted: PEAK_ON });
  await evaluator.applyControlTarget('gridSetpointW', 9700, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

test('(a) Einspeisung/negative Sollwerte bleiben unberührt', async () => {
  const { evaluator, transport } = harness({ persisted: PEAK_ON });
  await evaluator.applyControlTarget('gridSetpointW', -5000, 'rule:sell');
  assert.deepEqual(gridSetpointWrites(transport), [-5000]);
});

test('(a) manueller Dauer-Sollwert 15 kW wird ebenso gedeckelt', async () => {
  const { evaluator, transport } = harness({ persisted: PEAK_ON });
  await evaluator.applyControlTarget('gridSetpointW', 15000, 'manual_override_persistent');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

// --- (b) „Akku halten“ (EOS) ------------------------------------------------

function eosHoldRule() {
  const now = Date.now();
  return {
    id: 'eos-hold', enabled: true, target: 'gridSetpointW', ...activeWindow(),
    value: 1400, source: 'forecast_optimizer', optimizer: 'eos', closedLoopHold: true,
    slotTs: now - 60000, slotEndTs: now + 600000
  };
}

test('(b) EOS „Akku halten“ bei 15 kW Last: Bezug 9 700 W, Akku deckt 5 300 W', async () => {
  // Halte-Sollwert ohne Peak Shaving = Last − PV − Puffer = 15 000 − 0 − 300 = 14 700 W.
  // Gedeckelt auf 9 700 W → der Akku entlädt 15 000 − 9 700 = 5 300 W (SoC 60 %, frisch).
  const cfg = loadVictronConfig({ ...PEAK_ON, optimizer: { enabled: true, allowGridCharge: false, allowGridDischarge: true } });
  const state = makeTelemetryState({ soc: 60, loadW: 15000 });
  state.schedule.rules = [eosHoldRule()];
  const { evaluator, transport } = makeEvaluator({ cfg, state });
  await evaluator.evaluateSchedule();
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

test('(b) ohne Peak Shaving bleibt „Akku halten“ bei 14 700 W (heutiges Verhalten)', async () => {
  const cfg = loadVictronConfig({ optimizer: { enabled: true, allowGridCharge: false, allowGridDischarge: true } });
  const state = makeTelemetryState({ soc: 60, loadW: 15000 });
  state.schedule.rules = [eosHoldRule()];
  const { evaluator, transport } = makeEvaluator({ cfg, state });
  await evaluator.evaluateSchedule();
  assert.deepEqual(gridSetpointWrites(transport), [14700]);
});

// --- (c)/(d) Ladestand-Boden, veraltete Werte -------------------------------

test('(d) SoC veraltet, Last bekannt: nur bis zur Netto-Last deckeln (kein Entladen)', async () => {
  // Netzladen 12 000 W, Last 11 000 W, PV 0 → Netto-Last 11 000 W > Ziel 9 700 W.
  // Ohne frischen SoC darf der Deckel den Akku nicht entladen: max(9 700, 11 000) = 11 000 W.
  const { evaluator, transport, logs } = harness({ persisted: PEAK_ON, telemetry: { loadW: 11000, socAgeMs: 200000 } });
  await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [11000]);
  assert.equal(logs.find((l) => l.event === 'peak_shaving_clamp')?.payload.mode, 'net_load');
});

test('(d) SoC veraltet, Netto-Last klein: Lademinderung bis aufs Ziel bleibt erlaubt', async () => {
  // Netto-Last 3 000 W < 9 700 W → Deckel 9 700 W entlädt nicht, braucht keinen SoC.
  const { evaluator, transport } = harness({ persisted: PEAK_ON, telemetry: { loadW: 3000, socAgeMs: 200000 } });
  await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

test('(d) SoC und Last veraltet: Peak Shaving tut nichts Neues (12 000 W)', async () => {
  const { evaluator, transport, state } = harness({ persisted: PEAK_ON, telemetry: { socAgeMs: 200000, loadAgeMs: 200000 } });
  await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [12000]);
  assert.equal(state.ctrl._peakShaving.clamp.mode, 'held');
});

test('(d) SoC nie gelesen (kein Zeitstempel) zählt als unbekannt', async () => {
  const { evaluator, transport } = harness({ persisted: PEAK_ON, telemetry: { loadW: 11000, socAgeMs: null } });
  await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [11000]);
});

test('(d) Last NaN/fehlend + SoC unbekannt: unverändert', async () => {
  for (const loadW of [NaN, null, 'abc', 'missing']) {
    const { evaluator, transport, state } = harness({ persisted: PEAK_ON, telemetry: { socAgeMs: null } });
    if (loadW === 'missing') delete state.victron.selfConsumptionW;
    else state.victron.selfConsumptionW = loadW;
    await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
    assert.deepEqual(gridSetpointWrites(transport), [12000], String(loadW));
  }
});

test('(d) veraltete PV zählt nicht: Netto-Last = Last', async () => {
  // Last 11 000 W, PV 4 000 W aber veraltet → PV gilt als 0 → Netto-Last 11 000 W.
  // (Mit frischer PV wären es 7 000 W und der Deckel ginge bis 9 700 W.)
  const stale = harness({ persisted: PEAK_ON, telemetry: { loadW: 11000, pvW: 4000, pvAgeMs: 200000, socAgeMs: 200000 } });
  await stale.evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(stale.transport), [11000]);
  const fresh = harness({ persisted: PEAK_ON, telemetry: { loadW: 11000, pvW: 4000, socAgeMs: 200000 } });
  await fresh.evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(fresh.transport), [9700]);
});

test('(c) SoC am harten Boden (5 %): kein Entladen für Spitzen', async () => {
  const { evaluator, transport } = harness({ persisted: PEAK_ON, telemetry: { soc: 5, loadW: 11000 } });
  await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [11000]);
});

test('(c) eigener Mindest-Ladestand 40 %: bei 35 % kein Entladen, bei 45 % schon', async () => {
  const persisted = { ...PEAK_ON, peakShaving: { ...PEAK_ON.peakShaving, minSocPct: 40 } };
  const low = harness({ persisted, telemetry: { soc: 35, loadW: 11000 } });
  await low.evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(low.transport), [11000]);
  const ok = harness({ persisted, telemetry: { soc: 45, loadW: 11000 } });
  await ok.evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(ok.transport), [9700]);
});

test('(c) eingefrorene Telemetrie / Quellen-Widerspruch: alle Werte unsicher → unverändert', async () => {
  // Der Einfrier-Wächter bzw. die MQTT-Kreuzprobe erklären ALLE Live-Werte für
  // unzuverlässig — auch die Last. Peak Shaving tut dann nichts Neues.
  for (const flag of ['freeze', 'sourceMismatch']) {
    const { evaluator, transport, state } = harness({ persisted: PEAK_ON, telemetry: { loadW: 11000 } });
    state.victron[flag] = { active: true };
    await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
    assert.deepEqual(gridSetpointWrites(transport), [12000], flag);
  }
});

// --- (c) Vorrang der Schutzschichten ----------------------------------------

test('(c) Not-Halt: nichts wird geschrieben, auch kein gedeckelter Wert', async () => {
  const { evaluator, transport, state } = harness({ persisted: PEAK_ON });
  state.ctrl.discretionaryWritesPaused = true;
  const r = await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.equal(r.blocked, true);
  assert.deepEqual(gridSetpointWrites(transport), []);
});

test('(c) Netzlade-Verbot: 12 kW wird abgelehnt, nicht gedeckelt geschrieben', async () => {
  const cfg = loadVictronConfig({ ...PEAK_ON, optimizer: { allowGridCharge: false } });
  const { evaluator, transport } = makeEvaluator({ cfg, state: makeTelemetryState() });
  const r = await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.equal(r.error, 'grid_charge_not_allowed');
  assert.deepEqual(gridSetpointWrites(transport), []);
});

test('(c) §14a deckelt zuerst (4 000 W) — Peak Shaving ändert daran nichts', async () => {
  const cfg = loadVictronConfig({ ...PEAK_ON, ...GRID_CHARGE_ON });
  const state = makeTelemetryState();
  state.p14a = { active: true, limitW: 4200, source: 'eebus' };
  state.ctrl.p14aBatteryGridW = 4000;
  state.schedule.rules = [{ id: 'charge', enabled: true, target: 'gridSetpointW', ...activeWindow(), value: 12000, source: 'manual' }];
  const { evaluator, transport } = makeEvaluator({ cfg, state });
  await evaluator.evaluateSchedule();
  assert.deepEqual(gridSetpointWrites(transport), [4000]);
});

test('(c) Reg-2716-Schutz: ohne Keepalive wird auch ein gedeckelter Wert nicht geschrieben', async () => {
  const cfg = loadVictronConfig({ ...PEAK_ON, ...GRID_CHARGE_ON, schedule: { controlKeepaliveMs: 0 } });
  const { evaluator, transport } = makeEvaluator({ cfg, state: makeTelemetryState() });
  const r = await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.equal(r.ok, false);
  assert.match(r.error, /2716/);
  assert.deepEqual(gridSetpointWrites(transport), []);
});

test('(c) Keepalive frischt den gedeckelten Wert nach, statt den Rohwert zu schreiben', async () => {
  const { evaluator, transport, state } = harness({ persisted: PEAK_ON });
  await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  // Gleicher Wunsch vor Ablauf des Keepalive (5 s): nichts Neues auf dem Draht.
  await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
  // Keepalive fällig → derselbe gedeckelte Wert wird erneut gesetzt.
  state.schedule.lastWrite.gridSetpointW.at -= 6000;
  const r = await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.equal(r.keepalive, true);
  assert.deepEqual(gridSetpointWrites(transport), [9700, 9700]);
});

// --- Herstellergate ------------------------------------------------------------

test('anderer Hersteller: Sollwert unverändert (kein Raten fremder Register)', async () => {
  const cfg = loadVictronConfig({ ...PEAK_ON, ...GRID_CHARGE_ON });
  cfg.manufacturer = 'deye-lv'; // Registerkarte bleibt Victron — geprüft wird nur das Gate
  const { evaluator, transport } = makeEvaluator({ cfg, state: makeTelemetryState() });
  await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [12000]);
});

// --- Codex-Gegenprüfung zu 8b5a0a55 ----------------------------------------------

test('[P1] zweite GX lädt: Boden ohne Entladen aus der GEMESSENEN Last (inkl. Ladung der zweiten Anlage)', async () => {
  // polling.js zieht die Ladung der zweiten GX (2 kW) von der Hauslast ab:
  // selfConsumptionW = 11 000, gemessen 13 000. Der Hauptakku entlädt nicht,
  // solange Sollwert >= gemessene Last − PV = 13 000 W. SoC veraltet → Boden 13 000 W.
  const { evaluator, transport, state } = harness({ persisted: PEAK_ON, telemetry: { loadW: 11000, socAgeMs: 200000 } });
  state.victron.selfConsumptionMeasuredW = 13000;
  await evaluator.applyControlTarget('gridSetpointW', 15000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [13000]);
});

test('[P1] zweite GX entlädt: gemessene Last kleiner → Boden entsprechend tiefer', async () => {
  // Zweite GX entlädt 2 kW ins Hausnetz: gemessen 9 000, korrigiert 11 000.
  // Boden = max(Ziel 9 700, 9 000) = 9 700 W — der Hauptakku lädt dabei noch 700 W.
  const { evaluator, transport, state } = harness({ persisted: PEAK_ON, telemetry: { loadW: 11000, socAgeMs: 200000 } });
  state.victron.selfConsumptionMeasuredW = 9000;
  await evaluator.applyControlTarget('gridSetpointW', 15000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

test('[P2] reine AC-Kopplung: frische AC-PV zählt, obwohl DC-PV abgeschaltet ist', async () => {
  // pvCoupling 'ac' schaltet points.pvPowerW ab (nie ein Zeitstempel). Last 11 000,
  // AC-PV 4 000 frisch → Netto-Last 7 000 → Boden max(9 700, 7 000) = 9 700 W.
  const cfg = loadVictronConfig({ ...PEAK_ON, ...GRID_CHARGE_ON, pvCoupling: 'ac' });
  assert.equal(cfg.points.pvPowerW.enabled, false);
  const state = makeTelemetryState({ loadW: 11000, socAgeMs: 200000 });
  Object.assign(state.victron, { pvPowerW: null, acPvL1W: 4000, pvTotalW: 4000 });
  delete state.victron.fieldUpdatedAt.pvPowerW;
  const { evaluator, transport } = makeEvaluator({ cfg, state });
  await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

test('[P2] eingeschalteter AC-PV-Punkt ohne frischen Wert: PV zählt nicht (Boden = Last)', async () => {
  const { evaluator, transport, state } = harness({ persisted: PEAK_ON, telemetry: { loadW: 11000, pvW: 4000, socAgeMs: 200000 } });
  state.victron.fieldUpdatedAt.acPvL2W = Date.now() - 200000;
  await evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [11000]);
});

test('[P3] abgeschalteter PV-Punkt mit altem Wert zählt nicht mit (Umstellung ohne Neustart)', async () => {
  // Umstellung ac_dc → ac ohne Neustart: im Zustand steht noch DC-PV 5 000 W,
  // pvTotalW enthält sie. Zählen darf nur die AC-PV (je L 1 000 = 3 000 W).
  // Last 13 000 − 3 000 = 10 000 → Boden max(9 700, 10 000) = 10 000 W (SoC veraltet).
  const cfg = loadVictronConfig({ ...PEAK_ON, ...GRID_CHARGE_ON, pvCoupling: 'ac' });
  const state = makeTelemetryState({ loadW: 13000, socAgeMs: 200000 });
  Object.assign(state.victron, { pvPowerW: 5000, acPvL1W: 1000, acPvL2W: 1000, acPvL3W: 1000, pvTotalW: 8000 });
  const { evaluator, transport } = makeEvaluator({ cfg, state });
  await evaluator.applyControlTarget('gridSetpointW', 15000, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [10000]);
});
