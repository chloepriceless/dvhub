// Entlade-Wächter, Gegenprüfung 01f4558b (P2): Hat DVhub selbst 2704 = 0
// (Entladung sperren) geschrieben, darf die gewollte Sperre nicht nach ~2 min
// als Fehler gelten. Das Victron-Profil pollt 2704 bewusst nicht
// (Peak-Shaving-Entscheidung eb2f1a26) — die Auswertung liest das Register
// deshalb selbst zurück, solange der eigene letzte Schreibwert eine Sperre ist.
// So sieht der Wächter auch, wenn die Sperre an der GX wieder aufgehoben wird.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadVictronConfig, makeTelemetryState, makeEvaluator, makeModbusTransport } from './helpers/peak-shaving-harness.js';
import { knownDischargeCapW } from '../services/setpoint-follow-watchdog.js';

function blockedByDvhub(registers) {
  const cfg = loadVictronConfig({});
  const state = makeTelemetryState({ soc: 70, importW: 1800 });
  state.schedule.lastWrite.maxDischargeW = { value: 0, source: 'api', at: Date.now() - 3 * 3600000 };
  const transport = makeModbusTransport(registers);
  const { evaluator } = makeEvaluator({ cfg, state, transport });
  return { cfg, state, transport, evaluator };
}

test('eigene Sperre 2704 = 0: Auswertung liest 2704 zurück, die Sperre bleibt gültig', async () => {
  const { cfg, state, transport, evaluator } = blockedByDvhub({ 2704: 0 });
  await evaluator.evaluateSchedule();
  assert.ok(transport.reads.some((r) => r.address === 2704), '2704 wurde nicht gelesen');
  assert.equal(knownDischargeCapW(state, cfg, Date.now()), 0);
});

test('eigene Sperre an der GX aufgehoben (2704 = unbegrenzt): keine Entschuldigung mehr', async () => {
  const { cfg, state, evaluator } = blockedByDvhub({ 2704: 32767 });
  await evaluator.evaluateSchedule();
  assert.equal(knownDischargeCapW(state, cfg, Date.now()), -1);
});

test('ohne eigene Sperre und ohne Peak Shaving: 2704 wird nicht gelesen', async () => {
  const cfg = loadVictronConfig({});
  const state = makeTelemetryState({ soc: 70, importW: 1800 });
  const transport = makeModbusTransport({ 2704: 0 });
  const { evaluator } = makeEvaluator({ cfg, state, transport });
  await evaluator.evaluateSchedule();
  assert.deepEqual(transport.reads.filter((r) => r.address === 2704), []);
});
