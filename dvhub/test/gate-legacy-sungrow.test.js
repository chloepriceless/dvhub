// Schreibtor Phase 2 (VCL-Vertrag v6 D.1/D.2): das Legacy-Tor für den Sungrow-Pfad — Senken nachträglich anschließen
// und die Entscheidungstabelle je Aktionsklasse (command / keepalive / haltNeutralize / manualForceRelease) in den
// Lagen normal, Not-Halt, Lese-Modus, Profil ungültig. Die Bit-Gleichheit des verdrahteten Pfads zeigt
// test/gate-sungrow-parity.test.js; hier steht, was das Tor selbst entscheidet.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate } from '../services/gate/index.js';
import { createLegacyGate, legacyModbusReadOnlyWhat, modbusLegacySink, sungrowLegacyPolicies, SUNGROW_GATE_DEVICES } from '../services/gate/legacy.js';

const M = SUNGROW_GATE_DEVICES.master;

function legacyRig() {
  const flags = { halt: false, readOnly: false };
  const calls = [];
  const transport = {
    mbWriteSingle: async (a) => { calls.push(['fc6', a]); return { addr: a.address, value: a.value }; },
    mbWriteMultiple: async (a) => { calls.push(['fc16', a]); return undefined; },
  };
  const gate = createLegacyGate({ isHalted: () => flags.halt, isReadOnly: () => flags.readOnly, onReadOnlyBlock: () => {} });
  gate.attachSink(M, modbusLegacySink(transport));
  gate.setRelease(M, 'open');
  let seq = 0;
  const op = (point, value, action, extra = {}) => {
    seq += 1;
    return {
      device: M, point, value, source: 'sungrow-ems', kind: action === 'command' ? 'write' : 'neutralize', action, lease: null,
      constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null, tick: { loop: 'eval', seq }, step: 0,
      legacy: { sink: M, fn: 'mbWriteSingle', args: [{ host: 'h', port: 502, unitId: 1, address: 13050, value }] },
      ...extra,
    };
  };
  return { gate, flags, calls, op };
}

test('attachSink: Senke nachträglich anschließen — Name nur einmal, Art geprüft, Objekt des Aufrufers unberührt', async () => {
  const given = {};
  const gate = createGate({ sinks: given, policies: sungrowLegacyPolicies(), released: ['battery_grid'] });
  const args = { host: 'h', port: 502, unitId: 1, address: 13050, value: 204 };
  const ack = { addr: 13050, value: 204 };
  gate.attachSink(M, { kind: 'modbus', legacy: { mbWriteSingle: async (a) => (a === args ? ack : null) } });
  assert.deepEqual(Object.keys(given), [], 'das übergebene sinks-Objekt wird nicht verändert');
  assert.throws(() => gate.attachSink(M, { kind: 'modbus', legacy: {} }), /schon angeschlossen/);
  assert.throws(() => gate.attachSink('x', { kind: 'socket' }), TypeError);
  assert.throws(() => gate.attachSink('', { kind: 'modbus' }), TypeError);
  gate.setRelease(M, 'open');
  const res = await gate.submit({
    device: M, point: 'emsCmd', value: 204, source: 't', kind: 'write', action: 'command', lease: null,
    constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null, tick: { loop: 'eval', seq: 1 }, step: 0,
    legacy: { sink: M, fn: 'mbWriteSingle', args: [args] },
  });
  assert.equal(res.result, ack, 'dieselbe Rückgabe über die nachträglich angeschlossene Senke');
});

test('modbusLegacySink: dieselben Argument-Objekte an den Transport, dieselbe Rückgabe zurück', async () => {
  const a = { host: 'h', port: 502, unitId: 1, address: 13079, values: [30] };
  const back = {};
  const seen = [];
  const sink = modbusLegacySink({ mbWriteSingle: async (x) => { seen.push(x); return back; }, mbWriteMultiple: async (x) => { seen.push(x); return back; } });
  assert.equal(sink.kind, 'modbus');
  assert.equal(await sink.legacy.mbWriteMultiple(a), back);
  assert.equal(seen[0], a);
});

test('Sungrow-Richtlinien: Grundzustand 13051=0xCC/13050=0, Leistung/Herzschlag ohne Literal, kein Min-SoC-Punkt (H-8)', () => {
  const pol = sungrowLegacyPolicies();
  for (const dev of [SUNGROW_GATE_DEVICES.master, SUNGROW_GATE_DEVICES.slave]) {
    assert.deepEqual(Object.keys(pol[dev]).sort(), ['emsCmd', 'emsMode', 'emsPower', 'heartbeat']);
    assert.deepEqual(pol[dev].emsCmd.neutralValues, [204]);
    assert.deepEqual(pol[dev].emsMode.neutralValues, [0]);
    assert.equal(pol[dev].emsPower.neutralValues, undefined);
    assert.equal(pol[dev].heartbeat.neutral.kind, 'never');
    for (const p of Object.values(pol[dev])) assert.equal(p.resource, 'batteryControl');
  }
});

// Entscheidungstabelle des Tors für die vier Aktionsklassen des Sungrow-Pfads (Phase 2). In sungrow.js laufen die
// Bestandsprüfungen (C2, Not-Halt) VOR dem Tor; das Tor sieht deshalb nur, was sie durchlassen — und lässt genau das
// wieder durch (Spalten „normal" und „Not-Halt" für neutralize/manual). Was das Tor zusätzlich sperren würde (Befehl im
// Not-Halt, alles bei profileInvalid außer Rücknahme/Zwangsfreigabe), sperrt die Bestandsprüfung schon davor.
test('Entscheidungstabelle: Aktionsklasse × Lage → Ergebnis des Tors', async () => {
  const cases = [
    // [Punkt, Wert, Aktion, Zusatz]
    ['emsCmd', 187, 'command'],
    ['heartbeat', 30, 'keepalive'],
    ['emsCmd', 204, 'haltNeutralize'],
    ['emsMode', 0, 'haltNeutralize'],
    ['emsCmd', 204, 'manualForceRelease', { confirmedBy: 'operator:manual_release' }],
    ['emsMode', 0, 'manualForceRelease', { confirmedBy: 'operator:manual_release' }],
  ];
  const lage = {
    normal: () => {},
    notHalt: (r) => { r.flags.halt = true; },
    leseModus: (r) => { r.flags.readOnly = true; },
    profilUngueltig: (r) => { r.gate.setRelease(M, 'profileInvalid'); },
  };
  const table = {};
  for (const [name, set] of Object.entries(lage)) {
    const r = legacyRig();
    set(r);
    table[name] = [];
    for (const [point, value, action, extra] of cases) {
      const res = await r.gate.submit(r.op(point, value, action, extra));
      table[name].push(`${action}:${point}=${value} → ${res.outcome}${res.detail ? ` (${res.detail})` : ''}`);
    }
  }
  assert.deepEqual(table, {
    normal: [
      'command:emsCmd=187 → ok', 'keepalive:heartbeat=30 → ok',
      'haltNeutralize:emsCmd=204 → ok', 'haltNeutralize:emsMode=0 → ok',
      'manualForceRelease:emsCmd=204 → ok', 'manualForceRelease:emsMode=0 → ok',
    ],
    notHalt: [
      'command:emsCmd=187 → blocked_nothalt (not_halt)', 'keepalive:heartbeat=30 → blocked_nothalt (not_halt)',
      'haltNeutralize:emsCmd=204 → ok', 'haltNeutralize:emsMode=0 → ok',
      'manualForceRelease:emsCmd=204 → ok', 'manualForceRelease:emsMode=0 → ok',
    ],
    leseModus: cases.map(([point, value, action]) => `${action}:${point}=${value} → blocked_readonly (read_only)`),
    profilUngueltig: [
      'command:emsCmd=187 → blocked_gate (profile_invalid)', 'keepalive:heartbeat=30 → blocked_gate (profile_invalid)',
      'haltNeutralize:emsCmd=204 → ok', 'haltNeutralize:emsMode=0 → ok',
      'manualForceRelease:emsCmd=204 → ok', 'manualForceRelease:emsMode=0 → ok',
    ],
  });
});

test('Zwangsfreigabe (H-7) im Not-Halt nur bestätigt und nur mit Grundzustands-Literal; Min-SoC ist kein Ziel (H-8)', async () => {
  const r = legacyRig();
  r.flags.halt = true;
  const unconfirmed = await r.gate.submit(r.op('emsCmd', 204, 'manualForceRelease'));
  assert.deepEqual([unconfirmed.outcome, unconfirmed.detail], ['blocked_nothalt', 'force_release_unconfirmed']);
  const setpoint = await r.gate.submit(r.op('emsCmd', 0xaa, 'manualForceRelease', { confirmedBy: 'operator:x' }));
  assert.deepEqual([setpoint.outcome, setpoint.detail], ['blocked_nothalt', 'force_release_not_neutral']);
  const notNeutral = await r.gate.submit(r.op('emsMode', 2, 'haltNeutralize'));
  assert.deepEqual([notNeutral.outcome, notNeutral.detail], ['blocked_nothalt', 'neutralize_not_neutral']);
  const hb = await r.gate.submit(r.op('heartbeat', 30, 'haltNeutralize'));
  assert.deepEqual([hb.outcome, hb.detail], ['skipped_not_owned', 'never_neutralized']);
  r.flags.halt = false;
  const minSoc = await r.gate.submit(r.op('minSocPct', 100, 'command'));
  assert.deepEqual([minSoc.outcome, minSoc.detail], ['blocked_gate', 'unknown_target']);
  assert.equal(r.calls.length, 0, 'keiner dieser Fälle erreicht den Transport');
});

test('Lese-Modus: das Legacy-Tor meldet dieselbe Zeile wie transport-modbus.js (Modbus fc=<fc> an <host>:<port>)', async () => {
  const op = (fn, a) => ({ legacy: { sink: M, fn, args: [a] } });
  assert.equal(legacyModbusReadOnlyWhat(op('mbWriteSingle', { host: '192.0.2.50', port: 502, address: 13050, value: 204 })), 'Modbus fc=6 an 192.0.2.50:502');
  assert.equal(legacyModbusReadOnlyWhat(op('mbWriteMultiple', { host: 'h', port: 1502, address: 13079, values: [30] })), 'Modbus fc=16 an h:1502');
  assert.equal(legacyModbusReadOnlyWhat(op('mqttWrite', {})), null);
  assert.equal(legacyModbusReadOnlyWhat({}), null);
  const seen = [];
  const gate = createLegacyGate({ isReadOnly: () => true });
  const prev = console.warn;
  console.warn = (line) => seen.push(String(line));
  try {
    gate.attachSink(M, modbusLegacySink({ mbWriteSingle: async () => assert.fail('Transport darf nicht gerufen werden') }));
    gate.setRelease(M, 'open');
    const res = await gate.submit({
      device: M, point: 'emsCmd', value: 204, source: 't', kind: 'write', action: 'command', lease: null,
      constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null, tick: { loop: 'eval', seq: 1 }, step: 0,
      legacy: { sink: M, fn: 'mbWriteSingle', args: [{ host: '192.0.2.50', port: 502, unitId: 1, address: 13050, value: 204 }] },
    });
    assert.equal(res.outcome, 'blocked_readonly');
  } finally {
    console.warn = prev;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\[READ-ONLY\] Schreibzugriff blockiert: Modbus fc=6 an 192\.0\.2\.50:502 \(bisher \d+\)$/);
});
