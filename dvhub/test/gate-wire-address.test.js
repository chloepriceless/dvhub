// Kein Modbus-Write ohne ganzzahlige Adresse — für ALLE Pfade hinter dem Schreibtor (Fable-Review 18.11.2026).
//
// Vorher prüfte nur Pfad 1 (applyControlTargetCore) die Adresse. Die DV-Direktregister (Pfad 3), die Sequenzen samt
// 2706 (Pfade 2/4) und zfiWrite (Pfad 5) schrieben eine fehlende, null- oder Text-Adresse still als Register 0
// (Buffer.writeUInt16BE) und meldeten Erfolg — eine Abregelung, die nie an 2707 ankam. Jetzt lehnt die Modbus-Senke
// des Tors das ab; der Pfad sieht einen Modbus-Fehler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertWireAddress, modbusLegacySink, inverterLegacySink } from '../services/gate/legacy.js';
import { HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig } from './helpers/gate-golden.js';

const writes = (rig) => rig.transport.ops.filter((o) => /^W(6|16) /.test(o));

test('assertWireAddress: fehlend/null/Text/Bruch → Fehler; ganze Zahl (auch Ziffern-Text) → durch', () => {
  for (const bad of [undefined, null, 'abc', '', ' ', 2707.5, NaN, Infinity, {}, []]) {
    assert.throws(() => assertWireAddress({ address: bad }), /unsafe modbus write address/, String(bad));
  }
  assert.throws(() => assertWireAddress(undefined), /unsafe modbus write address/);
  for (const ok of [0, 2707, '2707', ' 2716 ', 70000, -1]) assert.doesNotThrow(() => assertWireAddress({ address: ok }), String(ok));
});

test('Modbus-Senken des Tors rufen den Transport bei ungültiger Adresse nicht auf', async () => {
  const calls = [];
  const transport = { type: 'modbus', mbWriteSingle: (a) => { calls.push(['fc6', a.address]); return { ok: true }; }, mbWriteMultiple: (a) => { calls.push(['fc16', a.address]); return { ok: true }; }, mqttWrite: () => ({ ok: true }) };
  for (const sink of [modbusLegacySink(transport), inverterLegacySink(transport)]) {
    assert.throws(() => sink.legacy.mbWriteSingle({ address: undefined, value: 1 }), /unsafe modbus write address/);
    assert.throws(() => sink.legacy.mbWriteMultiple({ address: 'abc', values: [1] }), /unsafe modbus write address/);
    await sink.legacy.mbWriteSingle({ address: 2707, value: 0 });
  }
  assert.deepEqual(calls, [['fc6', 2707], ['fc6', 2707]]);
});

test('Pfad 3: DV-Direktregister ohne gültige Adresse schreibt nichts an Register 0 und meldet keinen Erfolg', async (t) => {
  fixClock(t);
  for (const addr of [undefined, null, 'abc', 2707.5]) {
    const cfg = loadProfileConfig('victron', { victron: { host: HOST } });
    if (addr === undefined) delete cfg.dvControl.feedExcessDcPv.address; else cfg.dvControl.feedExcessDcPv.address = addr;
    const rig = evaluatorRig({ cfg, transport: recordingModbus(), state: baseState() });
    const res = await rig.ev.applyDvVictronControl(false, { reason: 'negative_price_protection' });
    assert.ok(!writes(rig).some((w) => / @0=/.test(w)), `addr=${addr}: ${JSON.stringify(writes(rig))}`);
    assert.notEqual(res?.ok, true, `addr=${addr}: Abregelung darf nicht als erledigt gelten (${JSON.stringify(res)})`);
  }
});

test('Pfad 4: Einspeisegrenze 2706 mit Text-Adresse schreibt nicht an Register 0', async (t) => {
  fixClock(t);
  const cfg = loadProfileConfig('victron', { victron: { host: HOST } });
  cfg.controlWrite.dvFeedInLimitW.address = 'abc';
  const rig = evaluatorRig({ cfg, transport: recordingModbus(), state: baseState() });
  try { await rig.ev.applyDvFeedInLimit(500); } catch { /* Fehler ist hier erlaubt — nur kein Write an 0 */ }
  assert.ok(!writes(rig).some((w) => / @0=/.test(w)), JSON.stringify(writes(rig)));
});

test('Pfad 5: Nulleinspeisung (Fronius) mit Text-Adressen schreibt nicht an Register 0', async (t) => {
  fixClock(t);
  const cfg = loadProfileConfig('fronius', { victron: { host: HOST } });
  for (const k of ['wMaxLimPct', 'wMaxLimEna', 'wMaxLimPctRvrtTms', 'outWRte', 'storCtlMod']) if (cfg.controlWrite[k]) cfg.controlWrite[k].address = 'abc';
  const rig = evaluatorRig({ cfg, transport: recordingModbus(), state: baseState({ ctrl: { _lastDvFeedIn: false, _dvBlockReason: 'negative_price_protection' }, victron: { gridExportW: 3000, gridImportW: 0, pvTotalW: 5000, selfConsumptionW: 500 }, meter: { ok: true, updatedAt: Date.now(), grid_total_w: 3000 } }) });
  for (let i = 0; i < 6; i++) await rig.ev.zeroFeedInTick();
  assert.ok(!writes(rig).some((w) => / @0=/.test(w)), JSON.stringify(writes(rig)));
});
