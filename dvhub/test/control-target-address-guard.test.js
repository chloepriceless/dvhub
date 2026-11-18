// Kein Register-Write ohne gültige Adresse (Befund 18.11.2026). applyControlTarget(target) für ein Ziel, dessen Config
// keine Adresse trägt — z. B. Deyes dontFeedExcessAcPv, ein Sequenz-Punkt —, fiel in den Einzelregister-Write mit
// `address: undefined`, den der Transport als Register 0 kodiert (Buffer.writeUInt16BE); der Schutz prüfte nur
// `Number(conf.address) === 0`. Soll: jeder generische Modbus-Write, dessen Adresse keine endliche ganze Zahl ≥ 0 ist,
// wird mit klarer Meldung abgelehnt; eine echte 0 erlaubt weiter allowAddressZero. MQTT, der Sungrow-EMS (emulate) und
// die feedExcessDcPv-Delegation tragen keine eigene Adresse und bleiben unberührt. Kein Produktiv-Aufrufer sendet
// dieses Ziel heute (runtime-commands.js CONTROL_TARGETS) — das Verhalten im Feld ändert sich nicht.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig } from './helpers/gate-golden.js';

const NO_ADDRESS = /^no valid register address for /;
const writes = (rig) => rig.transport.ops.filter((o) => /^W(6|16) /.test(o));

test('Deye: Sequenz-Flagge dontFeedExcessAcPv ohne eigenes Register schreibt NICHT auf Register 0', async (t) => {
  fixClock(t);
  const cfg = loadProfileConfig('deye-lv', { victron: { host: HOST } });
  const rig = evaluatorRig({ cfg, transport: recordingModbus({ holding: { 142: 1 } }), state: baseState() });
  const res = await rig.ev.applyControlTarget('dontFeedExcessAcPv', 1, 'api_manual_write');
  assert.deepEqual(writes(rig), [], `kein Write (war: W6 @0=1) — ${JSON.stringify(rig.transport.ops)}`);
  assert.equal(res.ok, false);
  assert.match(res.error, NO_ADDRESS);
  assert.match(res.error, /dontFeedExcessAcPv/);
  // Work-Mode mit Adresse 142 schreibt weiter.
  const wm = await rig.ev.applyControlTarget('workMode', 2, 'api_manual_write');
  assert.equal(wm.ok, true);
  assert.deepEqual(writes(rig), ['W6 gx/u1 @142=2']);
});

test('ungültige Adressen (fehlt, null, Text, negativ, gebrochen) sperren; Zahl und Zahlentext schreiben', async (t) => {
  fixClock(t);
  const cases = [
    ['fehlt', undefined, false],
    ['null mit allowAddressZero', null, false, true],
    ['leerer Text mit allowAddressZero', '', false, true],
    ['Text', 'abc', false],
    ['negativ', -5, false],
    ['gebrochen', 2705.5, false],
    ['NaN', Number.NaN, false],
    ['Zahl', 2705, true],
    ['Zahlentext', '2705', true],
  ];
  for (const [label, address, writesExpected, allowAddressZero] of cases) {
    const cfg = loadProfileConfig('victron', { victron: { host: HOST } });
    if (address === undefined) delete cfg.controlWrite.chargeCurrentA.address;
    else cfg.controlWrite.chargeCurrentA.address = address;
    if (allowAddressZero) cfg.controlWrite.chargeCurrentA.allowAddressZero = true;
    const rig = evaluatorRig({ cfg, transport: recordingModbus(), state: baseState() });
    const res = await rig.ev.applyControlTarget('chargeCurrentA', 20, 'api_manual_write');
    if (writesExpected) {
      assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
      assert.deepEqual(writes(rig), ['W6 gx/u100 @2705=20'], label);
    } else {
      assert.equal(res.ok, false, label);
      assert.match(res.error, NO_ADDRESS, `${label}: ${res.error}`);
      assert.deepEqual(rig.transport.ops, [], `${label}: nichts auf dem Draht (auch kein abgewiesener Rahmen)`);
    }
  }
});

test('echte Adresse 0: weiter nur mit allowAddressZero (Bestandsschutz unverändert)', async (t) => {
  fixClock(t);
  for (const allow of [false, true]) {
    const cfg = loadProfileConfig('victron', { victron: { host: HOST } });
    cfg.controlWrite.chargeCurrentA.address = 0;
    if (allow) cfg.controlWrite.chargeCurrentA.allowAddressZero = true;
    const rig = evaluatorRig({ cfg, transport: recordingModbus(), state: baseState() });
    const res = await rig.ev.applyControlTarget('chargeCurrentA', 20, 'api_manual_write');
    if (allow) {
      assert.equal(res.ok, true);
      assert.deepEqual(writes(rig), ['W6 gx/u100 @0=20']);
    } else {
      assert.equal(res.ok, false);
      assert.match(res.error, /^unsafe address 0 blocked/);
      assert.deepEqual(writes(rig), []);
    }
  }
});

test('ohne eigene Adresse unberührt: MQTT-Brücke und die feedExcessDcPv-Delegation (Sequenz)', async (t) => {
  fixClock(t);
  const mcfg = loadProfileConfig('bridge-mqtt', { victron: { host: HOST } });
  const sent = [];
  const mqtt = { type: 'mqtt', async mqttWrite(name, value) { sent.push([name, value]); return { ok: true }; } };
  const m = evaluatorRig({ cfg: mcfg, transport: mqtt, state: baseState() });
  const r = await m.ev.applyControlTarget('chargeCurrentA', 20, 'api_manual_write');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(sent, [['chargeCurrentA', 20]]);

  const fcfg = loadProfileConfig('fronius', { victron: { host: HOST } });
  fcfg.controlWrite.storCtlMod.address = 40191;
  fcfg.controlWrite.outWRte.address = 40198;
  const f = evaluatorRig({ cfg: fcfg, transport: recordingModbus({ holding: { 40191: 1, 40198: 0xec78 } }), state: baseState() });
  const fr = await f.ev.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(fr.ok, true, JSON.stringify(fr));
  assert.ok(writes(f).length > 0, 'Sequenz läuft über ihre eigenen Punkte');
});
