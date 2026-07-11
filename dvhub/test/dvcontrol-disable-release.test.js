// GH #10 (FrodoVDR): Wird die aktive Anlagensteuerung deaktiviert
// (`dvControl.enabled=false`, Volleinspeiser / „nur beobachten"), darf DVhub keine
// eigene Abregelung am Gerät stehen lassen. Steuer-Register sind persistent
// (Victron CGwacs reg 2707 OvervoltageFeedIn / 2708 PreventFeedback überleben
// DVhub-Aus), sonst bleibt die PV abgeregelt, obwohl DVhub „aus" ist.
// Prinzip: was DVhub setzt, setzt es beim Deaktivieren wieder auf „frei" zurück —
// aber es darf bei deaktivierter Steuerung NIE sperren.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';

function makeEvaluator(enabled) {
  const state = {
    victron: { soc: 50 },
    ctrl: {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
  const cfg = {
    dvControl: {
      enabled,
      feedExcessDcPv:     { enabled: true, fc: 6, address: 2707, writeType: 'uint16', signed: false, scale: 1, offset: 0 },
      dontFeedExcessAcPv: { enabled: true, fc: 6, address: 2708, writeType: 'uint16', signed: false, scale: 1, offset: 0 }
    }
  };
  const transport = {
    type: 'modbus',
    writes: [],
    async mbWriteSingle({ address, value }) { this.writes.push({ fc: 6, address, value }); },
    async mbWriteMultiple({ address, values }) { this.writes.push({ fc: 16, address, values }); }
  };
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => null
  });
  return { evaluator, state, transport };
}

test('#10: disabled control REFUSES a curtailment (feedIn=false → no write, no cache)', async () => {
  const { evaluator, state, transport } = makeEvaluator(false);
  await evaluator.applyDvVictronControl(false);
  assert.equal(transport.writes.length, 0, 'disabled control must never write a block');
  assert.equal(state.ctrl._lastDvFeedIn, undefined, 'no state change on a refused write');
});

test('#10: disabled control RELEASES feed-in once (2707:=1, 2708:=0) then is idempotent', async () => {
  const { evaluator, state, transport } = makeEvaluator(false);
  // Neutralisierung einer evtl. persistenten Sperre: reg 2707=1 (Einspeisung frei),
  // reg 2708=0 (keine AC-Sperre).
  await evaluator.applyDvVictronControl(true);
  assert.deepEqual(transport.writes, [
    { fc: 6, address: 2707, value: 1 },
    { fc: 6, address: 2708, value: 0 }
  ]);
  assert.equal(state.ctrl._lastDvFeedIn, true);
  // Zweiter Aufruf: change-detected → kein weiterer Write (kein Dauer-Schreiben).
  transport.writes.length = 0;
  await evaluator.applyDvVictronControl(true);
  assert.equal(transport.writes.length, 0, 'release is idempotent');
});

test('control still curtails normally when ENABLED (feedIn=false → 2707:=0, 2708:=1)', async () => {
  const { evaluator, transport } = makeEvaluator(true);
  await evaluator.applyDvVictronControl(false);
  assert.deepEqual(transport.writes, [
    { fc: 6, address: 2707, value: 0 },
    { fc: 6, address: 2708, value: 1 }
  ]);
});
