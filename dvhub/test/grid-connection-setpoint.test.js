// test/grid-connection-setpoint.test.js — Netzanschluss im Steuerpfad:
// jeder positive Netz-Sollwert (Victron 2716 = Bezug am Zähler) wird auf
// Grenze − Abstand gedeckelt, egal aus welcher Quelle. Echte Bausteine: das
// ausgelieferte Victron-Profil, der echte Schedule-Evaluator, ein Modbus-
// Transport, der die Rohwörter mitschreibt (test/helpers/peak-shaving-harness.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadVictronConfig, makeTelemetryState, makeEvaluator, gridSetpointWrites, PEAK_ON
} from './helpers/peak-shaving-harness.js';
import { createGridConnectionGuard } from '../services/grid-connection/index.js';

const GRID_CHARGE_ON = { optimizer: { allowGridCharge: true, allowGridDischarge: true } };
const GC_29 = { gridConnection: { limitKw: 29 } }; // Regelziel 28 000 W

function harness(persisted = {}, telemetry = {}) {
  const cfg = loadVictronConfig({ ...GRID_CHARGE_ON, ...persisted });
  const state = makeTelemetryState(telemetry);
  const guard = createGridConnectionGuard({ getCfg: () => cfg, state, pushLog: () => {} });
  const h = makeEvaluator({ cfg, state, extraCtx: { gridConnection: guard } });
  return { ...h, guard };
}

test('EOS-Netzladen 34,4 kW wird auf 28 kW gedeckelt (Anlass 06.11.2026)', async () => {
  const { evaluator, transport, logs, state } = harness(GC_29);
  const r = await evaluator.applyControlTarget('gridSetpointW', 34400, 'rule:eos-grid-charge');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(gridSetpointWrites(transport), [28000]);
  const log = logs.find((l) => l.event === 'grid_connection_clamp');
  assert.ok(log, 'Deckel wird geloggt');
  assert.equal(log.payload.requestedW, 34400);
  assert.equal(log.payload.valueW, 28000);
  assert.equal(state.ctrl._gridConnection.clamp.valueW, 28000);
  assert.equal(state.ctrl._gridConnection.request.requestedW, 34400);
});

test('jede Quelle wird gedeckelt: manuell, §14a-Pfad, Akku halten', async () => {
  for (const source of ['manual_override_persistent', 'api_manual_write', 'paragraph14a_limit', 'eos_grid_hold', 'rule:sma']) {
    const { evaluator, transport } = harness(GC_29);
    await evaluator.applyControlTarget('gridSetpointW', 40000, source);
    assert.deepEqual(gridSetpointWrites(transport), [28000], source);
  }
});

test('Sollwerte unter der Grenze und Einspeisung bleiben unverändert', async () => {
  const { evaluator, transport } = harness(GC_29);
  await evaluator.applyControlTarget('gridSetpointW', 20000, 'rule:charge');
  await evaluator.applyControlTarget('gridSetpointW', -8000, 'rule:sell');
  assert.deepEqual(gridSetpointWrites(transport), [20000, -8000]);
});

test('ohne Grenze: Verhalten bitgenau wie vorher', async () => {
  const { evaluator, transport, logs } = harness({});
  await evaluator.applyControlTarget('gridSetpointW', 34400, 'rule:eos');
  assert.deepEqual(gridSetpointWrites(transport), [34400]);
  assert.equal(logs.some((l) => l.event === 'grid_connection_clamp'), false);
});

test('kleinste gilt: Peak Shaving (9,7 kW) unter dem Netzanschluss (28 kW)', async () => {
  const { evaluator, transport } = harness({ ...PEAK_ON, ...GC_29 }, { soc: 60 });
  await evaluator.applyControlTarget('gridSetpointW', 34400, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [9700]);
});

test('kleinste gilt: Netzanschluss (8 kW) unter Peak Shaving (9,7 kW)', async () => {
  const { evaluator, transport } = harness({ ...PEAK_ON, gridConnection: { limitKw: 9, marginW: 1000 } }, { soc: 60 });
  await evaluator.applyControlTarget('gridSetpointW', 34400, 'rule:charge');
  assert.deepEqual(gridSetpointWrites(transport), [8000]);
});

test('Not-Halt bleibt Not-Halt: geblockter Write wird nicht als Deckel doch geschrieben', async () => {
  const { evaluator, transport, state } = harness(GC_29);
  state.ctrl.discretionaryWritesPaused = true;
  const r = await evaluator.applyControlTarget('gridSetpointW', 34400, 'rule:eos');
  assert.equal(r.blocked, true);
  assert.deepEqual(gridSetpointWrites(transport), []);
});

test('Netzlade-Verbot bleibt Verbot: abgelehnt, nicht gedeckelt', async () => {
  const cfg = loadVictronConfig({ ...GC_29, optimizer: { allowGridCharge: false } });
  const state = makeTelemetryState({});
  const guard = createGridConnectionGuard({ getCfg: () => cfg, state, pushLog: () => {} });
  const { evaluator, transport } = makeEvaluator({ cfg, state, extraCtx: { gridConnection: guard } });
  const r = await evaluator.applyControlTarget('gridSetpointW', 34400, 'rule:eos');
  assert.equal(r.error, 'grid_charge_not_allowed');
  assert.deepEqual(gridSetpointWrites(transport), []);
});

test('Decke sinkt (Phase/Fail-safe): Wächter schickt den laufenden Sollwert sofort neu durch', async () => {
  const persisted = { ...GC_29 };
  const cfg = loadVictronConfig({ ...GRID_CHARGE_ON, ...persisted });
  const state = makeTelemetryState({ importW: 20000 });
  const ctx = { getCfg: () => cfg, state, pushLog: () => {} };
  const guard = createGridConnectionGuard(ctx);
  const { evaluator, transport } = makeEvaluator({ cfg, state, extraCtx: { gridConnection: guard } });
  ctx.applyControlTarget = evaluator.applyControlTarget;
  await evaluator.applyControlTarget('gridSetpointW', 34400, 'rule:eos');
  assert.deepEqual(gridSetpointWrites(transport), [28000]);
  // Zähler fällt aus → Fail-safe: Decke 28 000 − 1 000 Grundlast = 27 000 W.
  state.meter.ok = false;
  guard.tick();
  guard.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(guard.batteryCeilingW(), 27000);
  assert.deepEqual(gridSetpointWrites(transport), [28000, 27000]);
});

test('anderer Hersteller: kein Sollwert-Deckel (Sollwert ist dort kein Bezug am Zähler)', () => {
  const guard = createGridConnectionGuard({ getCfg: () => ({ manufacturer: 'fronius', ...GC_29 }), state: {}, pushLog: () => {} });
  assert.equal(guard.batteryCeilingW(), null);
});
