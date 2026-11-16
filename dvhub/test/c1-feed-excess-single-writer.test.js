// C1/A10 (Christin 16.11.2026): feedExcessDcPv hat nur EINEN Schreibweg (applyDvVictronControl) und eine
// Handvorgabe (Freigabe) darf eine Pflicht-Sperre NICHT aufheben.
//
// Vorher (Blocker C1): der Chokepoint delegierte feedExcessDcPv nur bei Sequenz-Profilen an applyDvVictronControl;
// das Victron-Direktregister nahm den generischen Einzelregister-Pfad → ZWEI Schreiber auf dasselbe Flag. Und eine
// manuelle Freigabe (feedIn=1) konnte eine §51-/forcedOff-/§14a-Pflicht-Sperre übersteuern (A10).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';

function makeTransport() {
  return {
    type: 'modbus',
    writes: [],
    async mbWriteSingle({ address, value }) { this.writes.push({ fc: 6, address, value }); },
    async mbWriteMultiple({ address, values }) { this.writes.push({ fc: 16, address, values }); }
  };
}

function makeEvaluator(cfg, ctrl = {}) {
  const state = {
    victron: { soc: 50 },
    ctrl,
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

// Victron-Direktregister (keine Sequenz)
function victronDirectCfg() {
  return {
    controlWrite: {},
    dvControl: { enabled: true, feedExcessDcPv: { enabled: true, fc: 6, address: 2707, writeType: 'uint16', scale: 1, offset: 0 } }
  };
}

// --- C1: EIN Schreibweg ------------------------------------------------------------------------------------

test('C1: Victron-Direktregister feedExcessDcPv geht über applyDvVictronControl (ein Schreibweg, nicht generisch)', async () => {
  const { evaluator, state, transport } = makeEvaluator(victronDirectCfg());
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  assert.equal(res.ok, true);
  assert.equal(res.writeType, 'dv_control', 'ein Schreibweg (applyDvVictronControl), kein generischer Register-Write');
  assert.equal(res.address, undefined, 'die Antwort stammt vom Aktuator, nicht vom generischen Pfad');
  assert.deepEqual(transport.writes, [{ fc: 6, address: 2707, value: 0 }]);
  assert.equal(state.ctrl._lastDvFeedIn, false, 'Change-Cache des EINEN Schreibwegs geführt');
});

test('C1: identische Wiederholung ist ein gehaltener No-op (ein Schreibweg, kein zweiter Writer)', async () => {
  const { evaluator, transport } = makeEvaluator(victronDirectCfg());
  await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  transport.writes.length = 0;
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.equal(transport.writes.length, 0);
});

// --- A10: Freigabe während Pflicht-Sperre abgelehnt --------------------------------------------------------

test('A10: Freigabe (feedIn=1) gegen aktive §51-Sperre (negative Preise) wird abgelehnt, kein Write', async () => {
  const { evaluator, transport, logs } = makeEvaluator(victronDirectCfg(), { negativePriceActive: true });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');
  assert.equal(res.ok, false, 'Handvorgabe darf die Pflicht-Sperre nicht aufheben');
  assert.match(String(res.error), /feed_in_blocked_negative_price_protection/);
  assert.equal(transport.writes.length, 0, 'kein Freigabe-Write gegen die Pflicht-Sperre');
  assert.ok(logs.some((l) => l.event === 'control_write_rejected'));
});

test('A10: Freigabe gegen DV-forcedOff abgelehnt', async () => {
  const { evaluator, transport } = makeEvaluator(victronDirectCfg(), { forcedOff: true });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /feed_in_blocked_dv_forced_off/);
  assert.equal(transport.writes.length, 0);
});

test('A10: Freigabe gegen §14a-Produktionssperre abgelehnt', async () => {
  const { evaluator, transport } = makeEvaluator(victronDirectCfg(), { eebusProductionBlock: true });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /feed_in_blocked_paragraph14a_production_block/);
  assert.equal(transport.writes.length, 0);
});

test('A10: eine SPERRE (feedIn=0) während einer Pflicht-Sperre bleibt erlaubt (verstärkt nur)', async () => {
  const { evaluator, transport } = makeEvaluator(victronDirectCfg(), { negativePriceActive: true });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  assert.equal(res.ok, true, 'eine Sperr-Vorgabe widerspricht der Pflicht-Sperre nicht');
  assert.deepEqual(transport.writes, [{ fc: 6, address: 2707, value: 0 }]);
});

test('A10: ohne Pflicht-Sperre ist die Freigabe normal erlaubt', async () => {
  const { evaluator, state, transport } = makeEvaluator(victronDirectCfg(), { _lastDvFeedIn: false });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');
  assert.equal(res.ok, true);
  assert.equal(state.ctrl._lastDvFeedIn, true);
  assert.deepEqual(transport.writes, [{ fc: 6, address: 2707, value: 1 }]);
});
