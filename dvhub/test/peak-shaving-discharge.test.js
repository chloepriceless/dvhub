// test/peak-shaving-discharge.test.js — Peak Shaving (GitHub #28), Hebel 2:
// Akku-Sperre (Victron 2704 MaxDischargePower = 0) bei Bezugsspitze aufheben.
//
// Grenze 10 000 W, Abstand 300 W → Ziel 9 700 W, Rückschalt-Abstand 500 W
// (PEAK_ON). Einstieg nach 2 Takten über der Grenze, Rückkehr zur Sperre nach
// 6 Takten mit Bedarf (Bezug + Akku-Entladung) unter 9 700 − 500 = 9 200 W.
// 2704 zählt in 10-W-Schritten (scale 10); die Freigabe wird auf 100 W
// aufgerundet.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadVictronConfig, PEAK_ON, makeTelemetryState, makeEvaluator, maxDischargeWrites
} from './helpers/peak-shaving-harness.js';

const ENTER_TICKS = 2;
const RELEASE_TICKS = 6;

async function ticks(evaluator, n) {
  for (let i = 0; i < n; i += 1) await evaluator.evaluateSchedule();
}

/** Akku über DVhub gesperrt (wie Leitstand/API), Bezug 14 kW, SoC 60 %. */
async function blockedHarness({ persisted = PEAK_ON, telemetry = {}, extraCtx = {} } = {}) {
  const cfg = loadVictronConfig(persisted);
  const state = makeTelemetryState({ soc: 60, loadW: 14000, importW: 14000, ...telemetry });
  const h = makeEvaluator({ cfg, state, extraCtx });
  const r = await h.evaluator.applyControlTarget('maxDischargeW', 0, 'api_manual_write');
  assert.equal(r.ok, true, JSON.stringify(r));
  return h;
}

function setFlow(state, { importW, batteryDischargeW = 0 }) {
  state.victron.gridImportW = importW;
  state.victron.batteryPowerW = -batteryDischargeW;
  state.victron.batteryDischargeW = batteryDischargeW;
  state.victron.batteryChargeW = 0;
  state.meter.updatedAt = Date.now();
  state.meter.ok = true;
}

// --- Einstieg -----------------------------------------------------------------

test('gesperrt + Bezug 14 kW: nach 2 Takten Freigabe 4 300 W (14 000 − 9 700)', async () => {
  const { evaluator, transport, state, logs } = await blockedHarness();
  await ticks(evaluator, ENTER_TICKS - 1);
  assert.deepEqual(maxDischargeWrites(transport), [0], 'ein Takt über der Grenze reicht nicht');
  await ticks(evaluator, 1);
  assert.deepEqual(maxDischargeWrites(transport), [0, 4300]);
  assert.equal(state.ctrl._peakShaving.discharge.phase, 'lifted');
  assert.equal(state.ctrl._peakShaving.discharge.liftedW, 4300);
  assert.ok(logs.some((l) => l.event === 'peak_shaving_discharge_release' && l.payload.liftedW === 4300));
});

test('Freigabe wird auf 100 W aufgerundet (Bezug 12 345 W → 2 700 W)', async () => {
  // 12 345 − 9 700 = 2 645 → 2 700 W
  const { evaluator, transport } = await blockedHarness({ telemetry: { importW: 12345 } });
  await ticks(evaluator, ENTER_TICKS);
  assert.deepEqual(maxDischargeWrites(transport), [0, 2700]);
});

test('Freigabe nie über der Wechselrichter-Leistung (10 kW Standard)', async () => {
  // 25 000 − 9 700 = 15 300 → gedeckelt auf 10 000 W
  const { evaluator, transport } = await blockedHarness({ telemetry: { importW: 25000 } });
  await ticks(evaluator, ENTER_TICKS);
  assert.deepEqual(maxDischargeWrites(transport), [0, 10000]);
});

test('frisch zurückgelesene Sperre (2704 = 0) genügt, auch ohne eigenen Write', async () => {
  const cfg = loadVictronConfig(PEAK_ON);
  const state = makeTelemetryState({ soc: 60, importW: 14000, maxDischargeW: 0, maxDischargeAgeMs: 1000 });
  const { evaluator, transport } = makeEvaluator({ cfg, state });
  await ticks(evaluator, ENTER_TICKS);
  assert.deepEqual(maxDischargeWrites(transport), [4300]);
});

// --- kein Einstieg ------------------------------------------------------------

test('Sperre unbekannt (kein Write, kein Rücklesewert): nichts', async () => {
  const cfg = loadVictronConfig(PEAK_ON);
  const state = makeTelemetryState({ soc: 60, importW: 14000 });
  const { evaluator, transport } = makeEvaluator({ cfg, state });
  await ticks(evaluator, 4);
  assert.deepEqual(maxDischargeWrites(transport), []);
});

test('Rücklesewert veraltet: zählt nicht als Sperre', async () => {
  const cfg = loadVictronConfig(PEAK_ON);
  const state = makeTelemetryState({ soc: 60, importW: 14000, maxDischargeW: 0, maxDischargeAgeMs: 200000 });
  const { evaluator, transport } = makeEvaluator({ cfg, state });
  await ticks(evaluator, 4);
  assert.deepEqual(maxDischargeWrites(transport), []);
});

test('frischer Rücklesewert schlägt den alten eigenen Write (am GX wieder freigegeben)', async () => {
  const { evaluator, transport, state } = await blockedHarness();
  state.victron.maxDischargeW = 20000;
  state.victron.fieldUpdatedAt.maxDischargeW = Date.now();
  await ticks(evaluator, 4);
  assert.deepEqual(maxDischargeWrites(transport), [0]);
});

test('nicht gesperrt (eigener Write 20 000 W): nichts', async () => {
  const cfg = loadVictronConfig(PEAK_ON);
  const state = makeTelemetryState({ soc: 60, importW: 14000 });
  const { evaluator, transport } = makeEvaluator({ cfg, state });
  await evaluator.applyControlTarget('maxDischargeW', 20000, 'api_manual_write');
  await ticks(evaluator, 4);
  assert.deepEqual(maxDischargeWrites(transport), [20000]);
});

test('Bezug an/unter der Grenze (10 000 W): keine Freigabe', async () => {
  const { evaluator, transport } = await blockedHarness({ telemetry: { importW: 10000 } });
  await ticks(evaluator, 4);
  assert.deepEqual(maxDischargeWrites(transport), [0]);
});

test('Spitze nur einen Takt lang: keine Freigabe (Entprellung)', async () => {
  const { evaluator, transport, state } = await blockedHarness();
  await ticks(evaluator, 1);
  setFlow(state, { importW: 8000 });
  await ticks(evaluator, 1);
  setFlow(state, { importW: 14000 });
  await ticks(evaluator, 1);
  assert.deepEqual(maxDischargeWrites(transport), [0]);
});

test('(d) Zähler veraltet / ungültig / NaN: keine Freigabe', async () => {
  for (const mutate of [
    (s) => { s.meter.updatedAt = Date.now() - 60000; },
    (s) => { s.meter.ok = false; },
    (s) => { s.victron.gridImportW = NaN; }
  ]) {
    const { evaluator, transport, state } = await blockedHarness();
    mutate(state);
    await ticks(evaluator, 4);
    assert.deepEqual(maxDischargeWrites(transport), [0]);
  }
});

test('(c) SoC veraltet oder am Boden: keine Freigabe', async () => {
  for (const telemetry of [{ socAgeMs: 200000 }, { soc: 5 }, { socAgeMs: null }]) {
    const { evaluator, transport } = await blockedHarness({ telemetry });
    await ticks(evaluator, 4);
    assert.deepEqual(maxDischargeWrites(transport), [0], JSON.stringify(telemetry));
  }
});

test('(c) Not-Halt: keine Freigabe', async () => {
  const { evaluator, transport, state } = await blockedHarness();
  state.ctrl.discretionaryWritesPaused = true;
  await ticks(evaluator, 4);
  assert.deepEqual(maxDischargeWrites(transport), [0]);
});

// --- während der Freigabe -------------------------------------------------------

async function liftedHarness(opts) {
  const h = await blockedHarness(opts);
  await ticks(h.evaluator, ENTER_TICKS);
  assert.deepEqual(maxDischargeWrites(h.transport), [0, 4300]);
  // Der Akku deckt jetzt 4 300 W, der Bezug liegt auf dem Ziel.
  setFlow(h.state, { importW: 9700, batteryDischargeW: 4300 });
  return h;
}

test('Freigabe wächst mit, wenn der Bezug trotzdem über der Grenze liegt', async () => {
  // Bezug 10 600 W bei 4 300 W Akku → Bedarf 10 600 + 4 300 − 9 700 = 5 200 W
  const { evaluator, transport, state } = await liftedHarness();
  setFlow(state, { importW: 10600, batteryDischargeW: 4300 });
  await ticks(evaluator, 1);
  assert.deepEqual(maxDischargeWrites(transport), [0, 4300, 5200]);
});

test('Rückkehr zur Sperre erst nach 6 Takten mit Bedarf < 9 200 W (Hysterese)', async () => {
  const { evaluator, transport, state, logs } = await liftedHarness();
  // Bedarf 9 300 W (Bezug 5 000 + Akku 4 300) liegt im Hysterese-Band → bleibt frei.
  setFlow(state, { importW: 5000, batteryDischargeW: 4300 });
  await ticks(evaluator, RELEASE_TICKS + 2);
  assert.deepEqual(maxDischargeWrites(transport), [0, 4300]);
  // Bedarf 9 100 W < 9 200 W → nach 6 Takten zurück auf 0.
  setFlow(state, { importW: 4800, batteryDischargeW: 4300 });
  await ticks(evaluator, RELEASE_TICKS - 1);
  assert.deepEqual(maxDischargeWrites(transport), [0, 4300]);
  await ticks(evaluator, 1);
  assert.deepEqual(maxDischargeWrites(transport), [0, 4300, 0]);
  assert.equal(state.ctrl._peakShaving.discharge.phase, 'idle');
  assert.ok(logs.some((l) => l.event === 'peak_shaving_discharge_restore' && l.payload.reason === 'below_limit'));
});

test('ein Takt über dem Band setzt den Rückkehr-Zähler zurück', async () => {
  const { evaluator, transport, state } = await liftedHarness();
  setFlow(state, { importW: 3000, batteryDischargeW: 4300 });
  await ticks(evaluator, RELEASE_TICKS - 1);
  setFlow(state, { importW: 6000, batteryDischargeW: 4300 });
  await ticks(evaluator, 1);
  setFlow(state, { importW: 3000, batteryDischargeW: 4300 });
  await ticks(evaluator, RELEASE_TICKS - 1);
  assert.deepEqual(maxDischargeWrites(transport), [0, 4300]);
});

for (const [name, mutate, reason] of [
  ['SoC am Boden', (s) => { s.victron.soc = 5; }, 'soc_floor'],
  ['SoC veraltet', (s) => { s.victron.fieldUpdatedAt.soc = Date.now() - 200000; }, 'soc_unknown'],
  ['Zähler veraltet', (s) => { s.meter.updatedAt = Date.now() - 60000; }, 'meter_stale'],
  ['Telemetrie eingefroren', (s) => { s.victron.freeze = { active: true }; }, 'telemetry_frozen']
]) {
  test(`(c)/(d) ${name}: sofort zurück zur Sperre (0)`, async () => {
    const { evaluator, transport, logs, state } = await liftedHarness();
    mutate(state);
    await ticks(evaluator, 1);
    assert.deepEqual(maxDischargeWrites(transport), [0, 4300, 0]);
    assert.equal(logs.find((l) => l.event === 'peak_shaving_discharge_restore')?.payload.reason, reason);
  });
}

test('Peak Shaving ausgeschaltet: sofort zurück zur Sperre (0)', async () => {
  const { evaluator, transport, cfg } = await liftedHarness();
  cfg.peakShaving.enabled = false;
  await ticks(evaluator, 1);
  assert.deepEqual(maxDischargeWrites(transport), [0, 4300, 0]);
});

test('(c) Not-Halt während der Freigabe: Sperre (0) wird trotzdem zurückgeschrieben, sonst nichts', async () => {
  const { evaluator, transport, state, logs } = await liftedHarness();
  state.ctrl.discretionaryWritesPaused = true;
  await ticks(evaluator, 1);
  assert.deepEqual(maxDischargeWrites(transport), [0, 4300, 0]);
  assert.equal(logs.find((l) => l.event === 'peak_shaving_discharge_restore')?.payload.reason, 'emergency_stop');
  // Die Ausnahme gilt nur für genau diesen Rückweg: eine neue Freigabe bleibt geblockt.
  const r = await evaluator.applyControlTarget('maxDischargeW', 4300, 'peak_shaving');
  assert.equal(r.blocked, true);
  const r2 = await evaluator.applyControlTarget('maxDischargeW', 4300, 'peak_shaving_restore');
  assert.equal(r2.blocked, true, 'nur der Wert 0 darf durch den Not-Halt');
  const r3 = await evaluator.applyControlTarget('gridSetpointW', 0, 'peak_shaving_restore');
  assert.equal(r3.blocked, true, 'nur 2704 darf durch den Not-Halt');
});

test('Betreiber schreibt 2704 selbst während der Freigabe: DVhub schreibt nicht zurück', async () => {
  const { evaluator, transport, state, logs } = await liftedHarness();
  await evaluator.applyControlTarget('maxDischargeW', 8000, 'api_manual_write');
  setFlow(state, { importW: 1000, batteryDischargeW: 0 });
  await ticks(evaluator, RELEASE_TICKS + 2);
  assert.deepEqual(maxDischargeWrites(transport), [0, 4300, 8000]);
  assert.equal(state.ctrl._peakShaving.discharge.phase, 'idle');
  assert.ok(logs.some((l) => l.event === 'peak_shaving_lift_superseded'));
});

test('Neustart während der Freigabe: Merker in der Datei, erster Takt ohne Bedarf schreibt 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-peak-lift-'));
  const liftPath = path.join(dir, 'peak_shaving_lift.json');
  const first = await liftedHarness({ extraCtx: { peakShavingLiftPath: liftPath } });
  const saved = JSON.parse(fs.readFileSync(liftPath, 'utf8'));
  assert.equal(saved.liftedW, 4300);

  // Neuer Prozess: Zustand weg, Merker da, Peak Shaving inzwischen aus.
  const cfg = loadVictronConfig({ ...PEAK_ON, peakShaving: { ...PEAK_ON.peakShaving, enabled: false } });
  const state = makeTelemetryState({ soc: 60, importW: 1000 });
  const second = makeEvaluator({ cfg, state, extraCtx: { peakShavingLiftPath: liftPath } });
  await ticks(second.evaluator, 1);
  assert.deepEqual(maxDischargeWrites(second.transport), [0]);
  assert.equal(fs.existsSync(liftPath) ? JSON.parse(fs.readFileSync(liftPath, 'utf8')) : null, null);
  void first;
});
