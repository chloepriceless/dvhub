// Tor-Schema als geprüfte Datei (VCL-Vertrag v6 §0.4, H-11 — Anfang): GateOp, SubmitResult, WriteEvent.
//
// 1. Hash: jede Änderung an services/gate/gate.schema.json bricht hier. Eine Änderung ist ein Vertragssprung —
//    Hash nur bewusst nachziehen, und dieselbe Änderung in Rust (dvhub-record) nachführen.
// 2. Code und Schema laufen nicht auseinander: Wertemengen und Schlüsselmengen stimmen überein.
// 3. Was das Tor wirklich zurückgibt und als Ereignis ausgibt, passt zum Schema.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  OUTCOMES, DELIVERIES, KINDS, ACTIONS, TRUST, LOOPS, RELEASE_STATES, PRE_CHECKS, GATE_OP_KEYS,
} from '../services/gate/index.js';
import { validate } from './helpers/mini-json-schema.js';
import { rig, DEVICE } from './helpers/gate-rig.js';

const SCHEMA_PATH = path.resolve(import.meta.dirname, '..', 'services', 'gate', 'gate.schema.json');
const SCHEMA_SHA256 = 'df5eea18f32d8221021c3090a6b5fd87425a38b143ecef8d1bdfa44f76c0910b';
const raw = fs.readFileSync(SCHEMA_PATH);
const schema = JSON.parse(raw.toString('utf8'));
const check = (def, value) => validate(schema, { $ref: `#/$defs/${def}` }, value);

test('Tor-Schema: Hash unverändert (Änderung = Vertragssprung, Rust nachziehen)', () => {
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  assert.equal(sha, SCHEMA_SHA256,
    'gate.schema.json wurde geändert. Ist das gewollt, ist es ein Vertragssprung (§0.4): Rust-Seite nachziehen, dann '
    + `SCHEMA_SHA256 auf ${sha} setzen.`);
});

test('Tor-Schema: Wertemengen = Konstanten im Code', () => {
  const d = schema.$defs;
  assert.deepEqual(d.Outcome.enum, [...OUTCOMES]);
  assert.deepEqual(d.Delivery.enum, [...DELIVERIES]);
  assert.deepEqual(d.Kind.enum, [...KINDS]);
  assert.deepEqual(d.Action.enum, [...ACTIONS]);
  assert.deepEqual(d.Trust.enum, [...TRUST]);
  assert.deepEqual(d.Loop.enum, [...LOOPS]);
  assert.deepEqual(d.ReleaseState.enum, [...RELEASE_STATES]);
  assert.deepEqual(d.PreCheck.enum, ['shape', ...PRE_CHECKS, 'dispatch']);
  assert.deepEqual(Object.keys(d.GateOp.properties).sort(), [...GATE_OP_KEYS].sort());
});

test('Tor-Schema: Rust-Ereignisfelder (dvhub.write/1) sind alle Pflicht im Node-Ereignis', () => {
  // Pflichtfelder aus dvhub-rs crates/dvhub-record/schema/dvhub.write-1.schema.json (Stand 10.11.2026).
  const rustRequired = ['schema', 'impl', 'mode', 'ts_ms', 'tick', 'decision_id', 'layer', 'target', 'point', 'value', 'cause', 'kind', 'outcome', 'state_flags'];
  for (const k of rustRequired) assert.ok(schema.$defs.WriteEvent.required.includes(k), k);
});

test('Tor-Schema: Beispiel-Operationen — Schema und Torprüfung urteilen gleich', async () => {
  const r = rig({ legacy: { mbWriteSingle: async () => ({}) } });
  const good = [
    r.op(),
    r.op({ requested: 175, ruleId: 'r1', validUntilMs: 1, 'x-trace': 'a' }),
    r.op({ action: 'manualForceRelease', lease: null, confirmedBy: 'christin', value: 204 }),
    r.op({ lease: null, legacy: { sink: 'inv', fn: 'mbWriteSingle', args: [{ address: 13050, value: 2 }] } }),
    r.op({ constraints: { set: { noGridCharge: true, maxChargeW: null }, caps: { chargeW: 1800 }, enforcedBy: ['chargeAtMostPvSurplus'] } }),
  ];
  const bad = [
    { ...r.op(), action: 'gridSetpoint' },
    { ...r.op(), unknownKey: 1 },
    { ...r.op(), step: -1 },
    { ...r.op(), lease: { resource: 'batteryControl' } },
    { ...r.op(), tick: { loop: 'eval' } },
    { ...r.op(), constraints: { set: { foo: true }, caps: {}, enforcedBy: [] } },
    { ...r.op(), value: { obj: 1 } },
    { ...r.op(), constructor: 1 },                  // Prototyp-Namen sind keine erlaubten Schlüssel
    { ...r.op(), toString: 1 },
    { ...r.op(), hasOwnProperty: 1 },
  ];
  for (const op of good) {
    assert.deepEqual(check('GateOp', op), [], JSON.stringify(op));
    assert.notEqual((await r.gate.submit(op)).detail, 'invalid_op', JSON.stringify(op));
  }
  for (const op of bad) {
    assert.notDeepEqual(check('GateOp', op), [], JSON.stringify(op));
    assert.equal((await r.gate.submit(op)).detail, 'invalid_op', JSON.stringify(op));
  }
});

test('Tor-Schema: echte SubmitResults und Ereignisse aus allen Ausgängen passen zum Schema', async () => {
  let fail = null;
  let mqttResult = { ok: true, topic: null, value: 1, pushOnly: true };
  const r = rig({
    sinkWrite: async () => { if (fail) throw fail; return { ok: true }; },
    // Eigene MQTT-Senke: nur dort gilt die MQTT-Einordnung (pushOnly → pickupPending, ohne Quittung → no_ack).
    sinks: { mq: { kind: 'mqtt', legacy: { mqttWrite: async () => mqttResult } } },
  });
  const mqttOp = () => r.op({ point: 'gridSetpointW', value: 1, lease: null, legacy: { sink: 'mq', fn: 'mqttWrite', args: ['gridSetpointW', 1] } });
  const results = [];
  results.push(await r.gate.submit(r.op()));                                   // ok / acked
  results.push(await r.gate.submit(r.op()));                                   // skipped_unchanged
  fail = new Error('modbus exception 2');
  results.push(await r.gate.submit(r.op({ value: 187 })));                     // error / rejected + exceptionCode
  fail = null;
  const pickup = await r.gate.submit(mqttOp());                                // HTTP-Abholung (kein Broker)
  assert.deepEqual([pickup.outcome, pickup.delivery, pickup.detail, pickup.pickup, pickup.delivered], ['ok', 'unknown', 'pickupPending', true, false]);
  results.push(pickup);
  mqttResult = { ok: true, topic: 'W/x', value: 1 };
  const noAck = await r.gate.submit(mqttOp());                                 // Broker, QoS 0, keine Quittung
  assert.deepEqual([noAck.delivery, noAck.detail, noAck.pickup], ['unknown', 'no_ack', false]);
  results.push(noAck);
  results.push(await r.gate.submit(r.op({ constraints: { set: { noGridCharge: true }, caps: {}, enforcedBy: [] } }))); // constraint + reason
  results.push(await r.gate.submit({ device: DEVICE }));                       // invalid_op (kein Ereignis)
  r.flags.halt = true;
  results.push(await r.gate.submit(r.op()));                                   // blocked_nothalt
  results.push(await r.gate.submit(r.op({ point: 'minSocPct', action: 'haltNeutralize', kind: 'neutralize', lease: null }))); // skipped_not_owned
  r.flags.readOnly = true;
  results.push(await r.gate.submit(r.op({ action: 'manualForceRelease', lease: null, confirmedBy: 'c', value: 204 })));      // blocked_readonly
  const outcomes = new Set(results.map((x) => x.outcome));
  for (const o of ['ok', 'error', 'skipped_unchanged', 'skipped_not_owned', 'blocked_readonly', 'blocked_nothalt', 'blocked_gate']) {
    assert.ok(outcomes.has(o), `Ausgang ${o} nicht abgedeckt`);
  }
  for (const res of results) assert.deepEqual(check('SubmitResult', res), [], JSON.stringify(res));
  assert.equal(r.events.length, results.length - 1, 'ein Ereignis je gültiger Operation');
  for (const ev of r.events) assert.deepEqual(check('WriteEvent', JSON.parse(JSON.stringify(ev))), [], JSON.stringify(ev));
  assert.ok(r.events.some((ev) => ev.detail === 'pickupPending' && ev.target.kind === 'mqtt'), 'Abhol-Ereignis geprüft');
});
