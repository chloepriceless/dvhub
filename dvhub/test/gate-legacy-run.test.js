// Schreibtor Phase 3 (VCL-Vertrag v6 D.1/D.2): Lauf-Zulassung für die Abregel-Pfade, Gerätetabelle je Gerät und die
// Lese-Modus-Zeile der Senke. Die Bit-Gleichheit der verdrahteten Pfade zeigt test/gate-dv-parity.test.js; hier
// steht, was das Tor selbst entscheidet.
//
// Lauf-Zulassung: die Pfade 2–5 entscheiden den Not-Halt heute EINMAL am Laufeingang und schreiben die Folge zu Ende.
// Vorprüfung 1 urteilt für die Operationen eines zugelassenen Laufs mit dem Not-Halt-Stand am Eingang — ein Befehl
// oder Lebenszeichen bleibt im Not-Halt aber immer gesperrt, auch in einem im Not-Halt zugelassenen Lauf.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate } from '../services/gate/index.js';
import {
  createLegacyGate, inverterLegacyPolicy, inverterLegacySink, legacyModbusReadOnlyWhat, legacyReadOnlyError, unwrapLegacyWrite,
  INVERTER_GATE_DEVICE, SUNGROW_GATE_DEVICES,
} from '../services/gate/legacy.js';

const INV = INVERTER_GATE_DEVICE;

function invRig({ readOnly = false } = {}) {
  const flags = { halt: false, readOnly, haltThrows: false };
  const calls = [];
  const lines = [];
  const events = [];
  const transport = {
    type: 'modbus',
    mbWriteSingle: async (a) => { calls.push(a); return { addr: a.address, value: a.value }; },
    mbWriteMultiple: async (a) => { calls.push(a); return { addr: a.address, quantity: a.values.length }; },
  };
  const gate = createLegacyGate({
    isHalted: () => { if (flags.haltThrows) throw new Error('unlesbar'); return flags.halt; },
    isReadOnly: () => flags.readOnly,
    // wie die Voreinstellung von createLegacyGate, nur mitgeschrieben statt gemeldet
    onReadOnlyBlock: (what, o) => lines.push(legacyModbusReadOnlyWhat(o) ?? what),
    onEvent: (ev) => events.push(ev),
  });
  gate.attachSink(INV, inverterLegacySink(transport));
  gate.setDevicePolicies(INV, {
    feedExcessDcPv: inverterLegacyPolicy('feedExcessDcPv'),
    storCtlMod: inverterLegacyPolicy('storCtlMod'),
    minSocPct: { ...inverterLegacyPolicy('minSocPct'), neutral: { kind: 'never' } },
  });
  gate.setRelease(INV, 'open');
  let seq = 0;
  const op = (action, { point = 'storCtlMod', value = 2, device = INV } = {}) => {
    seq += 1;
    return {
      device, point, value, source: 'test', kind: action === 'haltNeutralize' ? 'restore' : 'sequenceStep', action, lease: null,
      constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null, tick: { loop: 'eval', seq }, step: 0,
      legacy: { sink: INV, fn: 'mbWriteSingle', args: [{ host: '192.0.2.10', port: 502, unitId: 1, address: 40191, value }] },
    };
  };
  return { gate, flags, calls, lines, events, op };
}

const verdict = (res) => [res.outcome, res.detail ?? null];

test('Lauf außerhalb des Not-Halts zugelassen: schreibt zu Ende, auch wenn der Not-Halt mitten drin beginnt', async () => {
  const r = invRig();
  const run = r.gate.admitLegacyRun(INV);
  r.flags.halt = true;
  for (const action of ['command', 'protectiveLimit', 'autoRestore', 'keepalive']) {
    assert.deepEqual(verdict(await r.gate.submit(r.op(action), { run })), ['ok', null], `${action} im zugelassenen Lauf`);
    assert.deepEqual(verdict(await r.gate.submit(r.op(action))), ['blocked_nothalt', 'not_halt'], `${action} ohne Zulassung`);
  }
  r.flags.halt = false;
  assert.deepEqual(verdict(await r.gate.submit(r.op('command'), { run })), ['ok', null], 'auch nach dem Aufheben');
  assert.equal(r.calls.length, 5);
});

test('Lauf im Not-Halt zugelassen (inHalt): Rücknahme und Schutz-Begrenzung ja, Befehl und Lebenszeichen nie', async () => {
  const r = invRig();
  r.flags.halt = true;
  const run = r.gate.admitLegacyRun(INV, { inHalt: 'emergency_stop_release' });
  for (const action of ['protectiveLimit', 'autoRestore', 'safetyRelease']) {
    assert.deepEqual(verdict(await r.gate.submit(r.op(action), { run })), ['ok', null], action);
  }
  // Rücknahme auf die Sicherung des Pfads: kein Literal (Kundenwert 1) — im Legacy-Modus hält der Pfad den Wert.
  assert.deepEqual(verdict(await r.gate.submit(r.op('haltNeutralize', { value: 1 }), { run })), ['ok', null]);
  assert.deepEqual(verdict(await r.gate.submit(r.op('command'), { run })), ['blocked_nothalt', 'not_halt']);
  assert.deepEqual(verdict(await r.gate.submit(r.op('keepalive'), { run })), ['blocked_nothalt', 'not_halt']);
  // H-8 bleibt: was nie neutralisiert wird, schreibt auch der Durchgang nicht.
  assert.deepEqual(verdict(await r.gate.submit(r.op('haltNeutralize', { point: 'minSocPct', value: 10 }), { run })), ['skipped_not_owned', 'never_neutralized']);
  // Der Lauf bleibt ein Not-Halt-Lauf, auch wenn der Not-Halt währenddessen aufgehoben wird: der Befehl bleibt gesperrt.
  r.flags.halt = false;
  assert.deepEqual(verdict(await r.gate.submit(r.op('command'), { run })), ['blocked_nothalt', 'not_halt']);
  assert.deepEqual(verdict(await r.gate.submit(r.op('protectiveLimit'), { run })), ['ok', null]);
  assert.equal(r.calls.length, 5);
});

test('Lauf im Not-Halt ohne inHalt: wie ohne Zulassung — nur das Freigabe-Literal', async () => {
  const r = invRig();
  r.flags.halt = true;
  const run = r.gate.admitLegacyRun(INV);
  assert.deepEqual(verdict(await r.gate.submit(r.op('protectiveLimit'), { run })), ['blocked_nothalt', 'not_halt']);
  assert.deepEqual(verdict(await r.gate.submit(r.op('haltNeutralize', { value: 1 }), { run })), ['blocked_nothalt', 'neutralize_not_neutral']);
  assert.deepEqual(verdict(await r.gate.submit(r.op('haltNeutralize', { point: 'feedExcessDcPv', value: 1 }), { run })), ['ok', null], 'Literal 2707 = 1');
  r.flags.halt = false;
  assert.deepEqual(verdict(await r.gate.submit(r.op('protectiveLimit'), { run })), ['blocked_nothalt', 'not_halt'], 'im Not-Halt begonnen bleibt im Not-Halt');
});

test('Not-Halt-Zustand am Laufeingang unlesbar: keine Ausnahme (fail-closed)', async () => {
  const r = invRig();
  r.flags.haltThrows = true;
  const run = r.gate.admitLegacyRun(INV, { inHalt: 'negative_price_protection' });
  r.flags.haltThrows = false;
  assert.deepEqual(verdict(await r.gate.submit(r.op('protectiveLimit'), { run })), ['blocked_nothalt', 'halt_state_unknown']);
  assert.equal(r.calls.length, 0);
});

test('Zulassung gilt nur für das ausgebende Tor, das genannte Gerät und Legacy-Operationen', async () => {
  const r = invRig();
  const other = invRig();
  const foreign = other.gate.admitLegacyRun(INV);
  const forged = Object.freeze({ device: INV, halted: false, unknown: false, inHalt: null });
  const wrongDevice = r.gate.admitLegacyRun(SUNGROW_GATE_DEVICES.master);
  r.flags.halt = true;
  for (const run of [foreign, forged, wrongDevice]) {
    assert.deepEqual(verdict(await r.gate.submit(r.op('command'), { run })), ['blocked_nothalt', 'not_halt']);
  }
  assert.throws(() => r.gate.admitLegacyRun(''), TypeError);
  // Vertragsoperation: die Zulassung wird übergangen (dort gilt die Lease/Sperrmarke).
  const contract = { ...r.op('command'), legacy: undefined };
  delete contract.legacy;
  const run = r.gate.admitLegacyRun(INV);
  r.flags.halt = true;
  assert.equal((await r.gate.submit(contract, { run })).outcome, 'blocked_nothalt');
  assert.equal(r.calls.length, 0);
});

test('Zugelassener Lauf: Lese-Modus und Schreibfreigabe gelten unverändert', async () => {
  const r = invRig();
  const run = r.gate.admitLegacyRun(INV);
  r.gate.setRelease(INV, 'profileInvalid');
  assert.deepEqual(verdict(await r.gate.submit(r.op('protectiveLimit'), { run })), ['blocked_gate', 'profile_invalid']);
  r.gate.setRelease(INV, 'open');
  r.flags.readOnly = true;
  assert.deepEqual(verdict(await r.gate.submit(r.op('protectiveLimit'), { run })), ['blocked_readonly', 'read_only']);
  assert.deepEqual(r.lines, ['Modbus fc=6 an 192.0.2.10:502']);
  assert.equal(r.calls.length, 0);
});

test('setDevicePolicies: ersetzt nur das eine Gerät, die übrigen (Sungrow) bleiben; Epoche nur bei Änderung', async () => {
  const gate = createLegacyGate();
  const genM = gate.releaseGeneration(SUNGROW_GATE_DEVICES.master);
  gate.setDevicePolicies(INV, { feedExcessDcPv: inverterLegacyPolicy('feedExcessDcPv') });
  const genInv = gate.releaseGeneration(INV);
  gate.setDevicePolicies(INV, { feedExcessDcPv: inverterLegacyPolicy('feedExcessDcPv') });
  assert.equal(gate.releaseGeneration(INV), genInv, 'gleiche Tabelle → keine neue Epoche');
  gate.setDevicePolicies(INV, { feedExcessDcPv: inverterLegacyPolicy('feedExcessDcPv'), storCtlMod: inverterLegacyPolicy('storCtlMod') });
  assert.equal(gate.releaseGeneration(INV), genInv + 1, 'neuer Punkt → neue Epoche des Geräts');
  assert.equal(gate.releaseGeneration(SUNGROW_GATE_DEVICES.master), genM, 'Sungrow unberührt');
  // Sungrow-Punkte stehen weiter: ein Master-Write ist kein unbekanntes Ziel.
  const calls = [];
  gate.attachSink(SUNGROW_GATE_DEVICES.master, { kind: 'modbus', legacy: { mbWriteSingle: async (a) => { calls.push(a); return {}; } } });
  gate.setRelease(SUNGROW_GATE_DEVICES.master, 'open');
  const res = await gate.submit({
    device: SUNGROW_GATE_DEVICES.master, point: 'emsCmd', value: 204, source: 't', kind: 'write', action: 'command', lease: null,
    constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null, tick: { loop: 'eval', seq: 1 }, step: 0,
    legacy: { sink: SUNGROW_GATE_DEVICES.master, fn: 'mbWriteSingle', args: [{ address: 13050, value: 204 }] },
  });
  assert.equal(res.outcome, 'ok');
  assert.throws(() => gate.setDevicePolicies('', {}), TypeError);
});

test('setDevicePolicies: ein Gerät namens __proto__ bleibt ein eigener Eintrag (Codex 135fdc22 P3)', async () => {
  const pol = { class: 'dv_curtail', resource: 'pvExport', sink: '__proto__', neutral: { kind: 'never' } };
  const gate = createGate({ policies: { ['__proto__']: { p: pol } }, released: ['dv_curtail'] });
  gate.attachSink('__proto__', { kind: 'modbus', legacy: { mbWriteSingle: async () => ({}) } });
  gate.setRelease('__proto__', 'open');
  const op = {
    device: '__proto__', point: 'p', value: 1, source: 't', kind: 'write', action: 'command', lease: null,
    constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null, tick: { loop: 'eval', seq: 1 }, step: 0,
    legacy: { sink: '__proto__', fn: 'mbWriteSingle', args: [{}] },
  };
  const gen = gate.releaseGeneration('__proto__');
  gate.setDevicePolicies(INV, { feedExcessDcPv: inverterLegacyPolicy('feedExcessDcPv') });
  assert.equal(gate.releaseGeneration('__proto__'), gen, 'ein anderes Gerät ändert __proto__ nicht');
  assert.equal((await gate.submit(op)).outcome, 'ok', 'Richtlinie von __proto__ steht noch');
  gate.setDevicePolicies('__proto__', { p: pol, q: pol });
  assert.equal((await gate.submit({ ...op, point: 'q' })).outcome, 'ok', 'auch über setDevicePolicies anmeldbar');
});

test('Richtlinie am Gerät inverter: Ressource pvExport, Stufe dv_curtail, Freigabe-Literale nur für die Einzelflaggen', () => {
  assert.deepEqual(inverterLegacyPolicy('feedExcessDcPv', 'mqtt'), {
    class: 'dv_curtail', resource: 'pvExport', sink: INV, targetKind: 'mqtt', neutral: { kind: 'sequence', use: 'release' }, neutralValues: [1],
  });
  assert.deepEqual(inverterLegacyPolicy('dontFeedExcessAcPv').neutralValues, [0]);
  assert.deepEqual(inverterLegacyPolicy('wMaxLimEna').neutralValues, [0]);
  assert.deepEqual(inverterLegacyPolicy('dvFeedInLimitW'), {
    class: 'dv_curtail', resource: 'pvExport', sink: INV, targetKind: 'modbus', unit: 'W', neutral: { kind: 'restoreBefore' },
  });
  // Prototyp-Namen sind keine Literale.
  assert.equal(inverterLegacyPolicy('constructor').neutralValues, undefined);
});

test('inverterLegacySink: dieselben Argumente an den Transport, dieselbe Rückgabe; Art folgt dem Transport', async () => {
  const back = {};
  const seen = [];
  const t = {
    type: 'mqtt',
    mbWriteSingle: async (a) => { seen.push(a); return back; },
    mbWriteMultiple: async (a) => { seen.push(a); return back; },
    mqttWrite: async (n, v) => { seen.push([n, v]); return back; },
    _writeTopics: () => ({ feedExcessDcPv: 'W/abc/settings/0/Settings/CGwacs/OvervoltageFeedIn' }),
  };
  const sink = inverterLegacySink(t);
  assert.equal(sink.kind, 'mqtt');
  assert.equal(inverterLegacySink({ type: 'modbus' }).kind, 'modbus');
  assert.equal(inverterLegacySink(undefined).kind, 'modbus');
  const a = { host: 'h', port: 502, unitId: 1, address: 2707, value: 0, timeoutMs: 1000 };
  assert.equal(await sink.legacy.mbWriteSingle(a), back);
  assert.equal(await sink.legacy.mqttWrite('feedExcessDcPv', 0), back);
  assert.equal(seen[0], a, 'gleiche Referenz');
  assert.deepEqual(seen[1], ['feedExcessDcPv', 0]);
  const mq = (name) => ({ legacy: { sink: INV, fn: 'mqttWrite', args: [name, 0] } });
  assert.equal(sink.readOnlyWhat(mq('feedExcessDcPv')), 'MQTT W/abc/settings/0/Settings/CGwacs/OvervoltageFeedIn');
  assert.equal(sink.readOnlyWhat(mq('dontFeedExcessAcPv')), null, 'ohne Topic keine eigene Zeile');
  assert.equal(sink.readOnlyWhat({ legacy: { fn: 'mbWriteSingle', args: [a] } }), null);
});

test('Lese-Modus: die Senke liefert ihre Zeile (MQTT-Topic), der Fehler gleicht dem des Transports', async () => {
  const lines = [];
  const gate = createGate({
    policies: { [INV]: { feedExcessDcPv: inverterLegacyPolicy('feedExcessDcPv', 'mqtt') } },
    released: ['dv_curtail'],
    isReadOnly: () => true,
    onReadOnlyBlock: (what) => lines.push(what),
  });
  gate.attachSink(INV, inverterLegacySink({ type: 'mqtt', mqttWrite: async () => ({}), _writeTopics: () => ({ feedExcessDcPv: 'W/x/OvervoltageFeedIn' }) }));
  gate.setRelease(INV, 'open');
  const op = {
    device: INV, point: 'feedExcessDcPv', value: 0, source: 't', kind: 'write', action: 'protectiveLimit', lease: null,
    constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null, tick: { loop: 'eval', seq: 1 }, step: 0,
    legacy: { sink: INV, fn: 'mqttWrite', args: ['feedExcessDcPv', 0] },
  };
  const res = await gate.submit(op);
  assert.equal(res.outcome, 'blocked_readonly');
  assert.deepEqual(lines, ['MQTT W/x/OvervoltageFeedIn']);
  assert.throws(() => unwrapLegacyWrite(res, op), (e) => e.name === 'ReadOnlyViolation' && e.code === 'DVHUB_READ_ONLY'
    && e.message === 'Schreibzugriff im Lese-Modus abgelehnt (MQTT feedExcessDcPv)');
  assert.equal(legacyReadOnlyError({ legacy: { fn: 'mbWriteSingle' } }).message, 'Schreibzugriff im Lese-Modus abgelehnt (Modbus fc=6)');
  assert.equal(legacyReadOnlyError({ legacy: { fn: 'mbWriteMultiple' } }).message, 'Schreibzugriff im Lese-Modus abgelehnt (Modbus fc=16)');
});

test('unwrapLegacyWrite: Rückgabe und Fehler gleiche Referenz; jede andere Sperre laut als gate_blocked', () => {
  const result = {};
  const error = new Error('modbus exception 4');
  assert.equal(unwrapLegacyWrite({ outcome: 'ok', result }, {}), result);
  assert.throws(() => unwrapLegacyWrite({ outcome: 'error', error }, {}), (e) => e === error);
  assert.throws(() => unwrapLegacyWrite({ outcome: 'blocked_gate', detail: 'unknown_target' }, { device: INV, point: 'x' }),
    (e) => e.name === 'GateBlockedError' && e.code === 'gate_blocked' && e.detail === 'unknown_target');
});
