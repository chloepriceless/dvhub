// Feldtest 554bbdfd (2026-07-18): POST /api/control/write {target:feedExcessDcPv}
// antwortete auf Sequenz-Profilen (Fronius M124-Force-Charge) mit
// {"ok":false,"error":"modbus exception 2"}, obwohl der Eval die Sperr-Sequenz
// korrekt schrieb — applyControlTarget kannte den Sequenz-Dialekt nicht und
// schrieb naiv auf dvControl.feedExcessDcPv.address (= undefined). Der Fix
// delegiert an applyDvVictronControl; die API-Antwort muss den ECHTEN
// Sequenz-Ausgang widerspiegeln (Handover-Punkt 2, HANDOVER-FRONIUS-RELEASE).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';

function makeState() {
  return {
    victron: { soc: 50 },
    ctrl: {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
}

function makeTransport({ failWrites = false } = {}) {
  return {
    type: 'modbus',
    writes: [],
    async mbWriteSingle({ address, value }) {
      if (failWrites) throw new Error('modbus exception 2');
      this.writes.push({ fc: 6, address, value });
    },
    async mbWriteMultiple({ address, values }) { this.writes.push({ fc: 16, address, values }); }
  };
}

// Minimalform des Fronius-Profils: Flag NUR mit sequence (keine address),
// Sequenz-Punkte in controlWrite mit aufgelösten SunSpec-Adressen.
function makeFroniusEvaluator({ enabled = true, failWrites = false } = {}) {
  const state = makeState();
  const cfg = {
    controlWrite: {
      storCtlMod: { enabled: true, fc: 6, address: 40358, writeType: 'uint16', scale: 1, offset: 0 },
      outWRte:    { enabled: true, fc: 6, address: 40365, writeType: 'int16', scale: 0.01, offset: 0 }
    },
    dvControl: {
      enabled,
      feedExcessDcPv: {
        enabled: true,
        sequence: {
          '0': [{ point: 'storCtlMod', value: 2 }, { point: 'outWRte', value: -100 }],
          '1': [{ point: 'storCtlMod', value: 0 }, { point: 'outWRte', value: 100 }]
        }
      }
    }
  };
  const transport = makeTransport({ failWrites });
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => null
  });
  return { evaluator, state, transport };
}

test('Sequenz-Flag: Sperren antwortet ok und schreibt die M124-Sequenz', async () => {
  const { evaluator, state, transport } = makeFroniusEvaluator();
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  assert.equal(res.ok, true);
  assert.equal(res.writeType, 'sequence');
  // StorCtl_Mod:=2 (discharge limit aktiv), OutWRte:=-100 % → raw 55536 (int16 -10000)
  assert.deepEqual(transport.writes, [
    { fc: 6, address: 40358, value: 2 },
    { fc: 6, address: 40365, value: 55536 }
  ]);
  assert.equal(state.ctrl._lastDvFeedIn, false);
  assert.equal(state.schedule.lastWrite.feedExcessDcPv.writeType, 'sequence');
});

test('Sequenz-Flag: Freigeben antwortet ok (StorCtl_Mod:=0, OutWRte:=+100 %)', async () => {
  const { evaluator, state, transport } = makeFroniusEvaluator();
  state.ctrl._lastDvFeedIn = false; // Anlage ist gesperrt
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');
  assert.equal(res.ok, true);
  assert.deepEqual(transport.writes, [
    { fc: 6, address: 40358, value: 0 },
    { fc: 6, address: 40365, value: 10000 }
  ]);
  assert.equal(state.ctrl._lastDvFeedIn, true);
});

test('Sequenz-Flag: identische Wiederholung ist ein gehaltener No-op (skipped, kein Write)', async () => {
  const { evaluator, transport } = makeFroniusEvaluator();
  await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  transport.writes.length = 0;
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.equal(transport.writes.length, 0);
});

test('Sequenz-Flag: ECHTER Write-Fehler wird ehrlich gemeldet (ok:false, Retry bleibt scharf)', async () => {
  const { evaluator, state } = makeFroniusEvaluator({ failWrites: true });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /exception 2/);
  assert.equal(state.ctrl._lastDvFeedIn, undefined, 'fehlgeschlagener Write darf den Change-Cache nicht setzen (T-0076)');
});

test('Sequenz-Flag: unaufgelöster SunSpec-Punkt → ok:false mit Klartext, kein Garbage-Write', async () => {
  // Scan noch nicht gelaufen: Punkt-Adressen fehlen (Zustand vor pollSunspecScan)
  const state = makeState();
  const transport = makeTransport();
  const cfg = {
    controlWrite: { storCtlMod: { enabled: true, address: null }, outWRte: { enabled: true, address: null } },
    dvControl: {
      enabled: true,
      feedExcessDcPv: { enabled: true, sequence: { '0': [{ point: 'storCtlMod', value: 2 }], '1': [{ point: 'storCtlMod', value: 0 }] } }
    }
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => null
  });
  const res = await ev.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /unresolved/);
  assert.equal(transport.writes.length, 0);
});

test('#10: deaktivierte Steuerung verweigert Sequenz-SPERREN, erlaubt aber die Freigabe', async () => {
  const { evaluator, transport } = makeFroniusEvaluator({ enabled: false });
  const block = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  assert.equal(block.ok, false);
  assert.equal(block.error, 'dv_control_disabled');
  assert.equal(transport.writes.length, 0, 'deaktivierte Steuerung darf nie sperren');
  const release = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');
  assert.equal(release.ok, true);
  assert.deepEqual(transport.writes[0], { fc: 6, address: 40358, value: 0 });
});

test('Victron-Direktregister (keine sequence) nimmt unverändert den generischen Pfad', async () => {
  const state = makeState();
  const cfg = {
    controlWrite: {},
    dvControl: {
      enabled: true,
      feedExcessDcPv: { enabled: true, fc: 6, address: 2707, writeType: 'uint16', signed: false, scale: 1, offset: 0 }
    }
  };
  const transport = makeTransport();
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => null
  });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  assert.equal(res.ok, true);
  assert.equal(res.address, 2707);
  assert.deepEqual(transport.writes, [{ fc: 6, address: 2707, value: 0 }]);
});
