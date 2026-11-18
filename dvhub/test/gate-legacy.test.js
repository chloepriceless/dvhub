// Node-Schreibtor, Legacy-Modus (VCL-Vertrag v6 D.2, B.5): der heutige, schon kodierte Transport-Aufruf geht
// UNVERÄNDERT an die Senke, die Rückgabe kommt UNVERÄNDERT zurück (gleiche Referenz) — plus Zusatzfelder. Damit kann
// ein Pfad in Phase 2 bit-gleich verdrahtet werden (Golden-Master D.4).

import test from 'node:test';
import assert from 'node:assert/strict';

import { unwrapLegacy, GateBlockedError } from '../services/gate/index.js';
import { ReadOnlyViolation } from '../read-only-guard.js';
import { rig, DEVICE } from './helpers/gate-rig.js';

const mbArgs = (over = {}) => ({ host: '192.168.68.84', port: 502, unitId: 1, address: 13050, value: 2, timeoutMs: 1000, ...over });
const legacyOp = (r, legacy, over = {}) => r.op({ lease: null, point: 'emsMode', value: 2, legacy, ...over });

test('Legacy Modbus: dieselben Argument-Objekte an die Senke, dieselbe Rückgabe zurück — unverändert', async () => {
  const ack = Object.freeze({ addr: 13050, value: 2, echoMismatch: false });
  const r = rig({ legacy: { mbWriteSingle: async () => ack } });
  const args = mbArgs();
  const snapshot = structuredClone(args);
  const res = await r.gate.submit(legacyOp(r, { sink: 'inv', fn: 'mbWriteSingle', args: [args] }));
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].args.length, 1, 'kein zusätzliches Argument');
  assert.equal(r.calls[0].args[0], args, 'dasselbe Objekt');
  assert.deepEqual(args, snapshot, 'Argumente nicht verändert');
  assert.equal(res.result, ack, 'dieselbe Rückgabe (Referenz)');
  assert.equal(unwrapLegacy(res), ack);
  assert.deepEqual(
    { outcome: res.outcome, delivery: res.delivery, trust: res.trust, delivered: res.delivered, pickup: res.pickup, possiblyEffective: res.possiblyEffective },
    { outcome: 'ok', delivery: 'acked', trust: 'legacy', delivered: true, pickup: false, possiblyEffective: true },
  );
});

test('Legacy MQTT: Positionsargumente unverändert; ohne Broker (pushOnly) bleibt ok:true, Zusatz pickupPending', async () => {
  const sent = { ok: true, topic: 'W/x/settings/0/Settings/CGwacs/AcPowerSetPoint', value: -500 };
  const pushOnly = { ok: true, topic: null, value: -500, pushOnly: true };
  let next = sent;
  const r = rig({ sinkKind: 'mqtt', legacy: { mqttWrite: async () => next } });
  const op = legacyOp(r, { sink: 'inv', fn: 'mqttWrite', args: ['gridSetpointW', -500] }, { point: 'gridSetpointW', value: -500, lease: null });
  const a = await r.gate.submit(op);
  assert.deepEqual(r.calls[0].args, ['gridSetpointW', -500]);
  assert.equal(a.result, sent);
  assert.deepEqual([a.delivery, a.pickup, a.delivered], ['acked', false, true]);
  next = pushOnly;
  const b = await r.gate.submit(op);
  assert.equal(b.result, pushOnly);
  assert.equal(b.result.ok, true, 'ok bleibt wie heute (B.5) — nichts umgedeutet');
  assert.deepEqual(
    { outcome: b.outcome, delivery: b.delivery, detail: b.detail, delivered: b.delivered, pickup: b.pickup, possiblyEffective: b.possiblyEffective },
    { outcome: 'ok', delivery: 'unknown', detail: 'pickupPending', delivered: false, pickup: true, possiblyEffective: true },
  );
});

test('Legacy Fehler: derselbe Fehler kommt zurück, unwrapLegacy wirft ihn unverändert; Zustellung nach H-6', async () => {
  const exc2 = new Error('modbus exception 2');
  const exc4 = new Error('modbus exception 4');
  const timeout = new Error('modbus timeout');
  let err = exc2;
  const r = rig({ legacy: { mbWriteSingle: async () => { throw err; } } });
  const op = legacyOp(r, { sink: 'inv', fn: 'mbWriteSingle', args: [mbArgs()] });
  const a = await r.gate.submit(op);
  assert.equal(a.error, exc2);
  assert.throws(() => unwrapLegacy(a), (e) => e === exc2);
  assert.deepEqual([a.outcome, a.delivery, a.exceptionCode, a.possiblyEffective], ['error', 'rejected', 2, false]);
  err = exc4;
  const b = await r.gate.submit(op);
  assert.deepEqual([b.outcome, b.delivery, b.exceptionCode, b.possiblyEffective], ['error', 'unknown', 4, true]);
  err = timeout;
  const c = await r.gate.submit(op);
  assert.deepEqual([c.delivery, c.possiblyEffective], ['unknown', true]);
  assert.equal(r.events.at(-1).error, 'modbus timeout');
});

test('Legacy: kein „unverändert“ und keine Lease-Pflicht — der Pfad entscheidet wie heute', async () => {
  const r = rig({ legacy: { mbWriteSingle: async (a) => ({ addr: a.address, value: a.value }) } });
  const op = legacyOp(r, { sink: 'inv', fn: 'mbWriteSingle', args: [mbArgs()] });
  const a = await r.gate.submit(op);
  const b = await r.gate.submit(op);
  assert.deepEqual([a.outcome, b.outcome], ['ok', 'ok']);
  assert.equal(r.calls.length, 2, 'derselbe Wert zweimal: Legacy schreibt wie heute zweimal');
});

test('Legacy gesperrt: Lese-Modus wirft ReadOnlyViolation wie der Transport, sonst GateBlockedError; Senke nie gerufen', async () => {
  const r = rig({ legacy: { mbWriteSingle: async () => ({}) } });
  const op = legacyOp(r, { sink: 'inv', fn: 'mbWriteSingle', args: [mbArgs()] });
  r.flags.readOnly = true;
  const ro = await r.gate.submit(op);
  assert.equal(ro.outcome, 'blocked_readonly');
  assert.throws(() => unwrapLegacy(ro, op), ReadOnlyViolation);
  assert.deepEqual(r.readOnlyBlocks, [`Tor ${DEVICE}/emsMode`], 'Lese-Modus-Zähler wie im Transport');
  r.flags.readOnly = false;
  r.gate.setRelease(DEVICE, 'profileInvalid');
  const inv = await r.gate.submit(op);
  assert.throws(() => unwrapLegacy(inv, op), (e) => e instanceof GateBlockedError && e.outcome === 'blocked_gate' && e.detail === 'profile_invalid');
  assert.equal(r.calls.length, 0);
});

test('Legacy: unbekannte Senke oder Funktion → blocked_gate no_sink, nicht versucht', async () => {
  const r = rig({ legacy: { mbWriteSingle: async () => ({}) } });
  for (const legacy of [{ sink: 'inv', fn: 'mbWriteCoil', args: [] }, { sink: 'nirgends', fn: 'mbWriteSingle', args: [] }]) {
    const res = await r.gate.submit(legacyOp(r, legacy));
    assert.deepEqual([res.outcome, res.detail, res.blockedBy, res.delivery], ['blocked_gate', 'no_sink', 'dispatch', null]);
  }
  assert.equal(r.calls.length, 0);
});

test('Legacy-Ereignis: dvhub.write/1 mit Vertrauensklasse legacy und Zustellung', async () => {
  const r = rig({ legacy: { mbWriteSingle: async () => ({}) } });
  const res = await r.gate.submit(legacyOp(r, { sink: 'inv', fn: 'mbWriteSingle', args: [mbArgs()] }, { tick: { loop: 'eval', seq: 42 }, step: 3 }));
  const ev = r.events.at(-1);
  assert.equal(ev.schema, 'dvhub.write/1');
  assert.equal(ev.trust, 'legacy');
  assert.equal(ev.delivery, 'acked');
  assert.equal(ev.op_id, res.opId);
  assert.equal(ev.decision_id, 'eval-42-emsMode', 'Rust-Form loop-seq-point');
  assert.equal(ev.target.kind, 'modbus');
});
