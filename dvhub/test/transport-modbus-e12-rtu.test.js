// E12 (19.11.2026): Modbus RTU über TCP (transparentes RS485-Gateway) im echten Modbus-Transport, mit falscher Uhr.
//
// Ohne Rahmen-Einstellung (jedes Profil, das sie nicht setzt) muss der Transport auf dem Draht, in den Zeitpunkten und in
// den Ergebnissen genau so laufen wie die eingefrorene Fassung 1c168de4 (test/fixtures/transport-modbus-1c168de4.js):
// gleicher Schein-Socket, gleiche falsche Uhr, alte gegen neue Fassung, Byte für Byte.
//
// Mit `rtu-over-tcp` gehen Anfragen als RTU-Rahmen (Unit-ID + PDU + CRC-16/Modbus, Low-Byte zuerst) ohne MBAP-Kopf
// raus. Ohne Transaktions-ID muss jede Antwort in Unit-ID, Funktionscode, Länge, CRC (und bei Writes im Echo) zur
// Anfrage passen; sonst ein Fehler — nie ein Wert —, die Verbindung wird verworfen und eine Ruhezeit verwirft späte
// Bytes, bevor die nächste Anfrage rausgeht.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as current from '../transport-modbus.js';
import * as frozen from './fixtures/transport-modbus-1c168de4.js';
import { classifyModbusError } from '../services/gate/index.js';
import {
  installFakeModbusSockets, advance, flush, enableFakeClock, disableFakeClock, rtuFrame, crc16ModbusBitwise,
} from './helpers/fake-modbus-socket.js';

const HOST = '192.0.2.81';
const OTHER = '192.0.2.82';
const RTU = 'rtu-over-tcp';
const base = (extra = {}) => ({ host: HOST, port: 502, unitId: 1, timeoutMs: 1000, ...extra });
const onlyHost = (value) => (host, port) => (host === HOST && Number(port) === 502 ? value : null);

// Ein Prüfstand je Test: falsche Uhr, Schein-Sockets, Transport (aktuelle oder eingefrorene Fassung).
function rig({ mod = current, framingFor, pacingFor, socket, transport } = {}) {
  enableFakeClock();
  const sockets = installFakeModbusSockets(socket);
  const opts = {
    ...(framingFor !== undefined ? { framingFor } : {}),
    ...(pacingFor !== undefined ? { pacingFor } : {}),
    ...(transport || {}),
  };
  const t = mod.createModbusTransport(opts);
  const t0 = Date.now();
  const settled = [];
  const track = (label, p) => p.then(
    (v) => { settled.push({ label, ok: true, t: Date.now() - t0, v }); return v; },
    (e) => { settled.push({ label, ok: false, t: Date.now() - t0, error: e.message }); return e; },
  );
  return {
    sockets, t, settled, track, mod,
    async done() {
      await t.destroy();
      await flush();
      sockets.restore();
      disableFakeClock();
    },
  };
}

// Transparentes Gateway an HOST:502, Transport mit Rahmen-Einstellung für genau diese Verbindung.
const rtuRig = (extra = {}) => rig({
  framingFor: onlyHost(RTU),
  ...extra,
  socket: { framing: (host, port) => (host === HOST && Number(port) === 502 ? 'rtu' : 'tcp'), ...(extra.socket || {}) },
});

const hexOf = (buf) => Buffer.from(buf).toString('hex');
const corruptLast = (frame) => { const b = Buffer.from(frame); b[b.length - 1] ^= 0xff; return b; };

// --- CRC und Einstellungen -----------------------------------------------------------------------------------------

test('crc16Modbus: RevEng-Prüfwert 0x4B37, bekannte Rahmen, und gleich der bitweisen Rechnung für beliebige Bytes', () => {
  assert.equal(typeof current.crc16Modbus, 'function');
  assert.equal(current.crc16Modbus(Buffer.from('123456789')), 0x4b37);
  // 01 03 00 00 00 0A → CRC C5 CD auf dem Draht (Low-Byte zuerst) = 0xCDC5; 01 06 00 01 00 03 → 98 0B.
  assert.equal(current.crc16Modbus(Buffer.from([1, 3, 0, 0, 0, 10])), 0xcdc5);
  assert.equal(current.crc16Modbus(Buffer.from([1, 6, 0, 1, 0, 3])), 0x0b98);
  assert.equal(current.crc16Modbus(Buffer.alloc(0)), 0xffff);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let n = 0; n < 300; n += 1) {
    const buf = Buffer.from(Array.from({ length: rnd() % 260 }, () => rnd() & 0xff));
    assert.equal(current.crc16Modbus(buf), crc16ModbusBitwise(buf), buf.toString('hex'));
  }
});

test('normalizeModbusFraming: nur "rtu-over-tcp" schaltet um, alles andere ist Modbus TCP', () => {
  assert.equal(typeof current.normalizeModbusFraming, 'function');
  for (const v of ['rtu-over-tcp', 'RTU-over-TCP', ' rtu-over-tcp ']) assert.equal(current.normalizeModbusFraming(v), RTU, v);
  for (const v of [undefined, null, '', 'tcp', 'TCP', 'rtu', 'RTU over TCP', 'rtu_over_tcp', 'rtuovertcp', 'solarman', 42, true, {}, [RTU]]) {
    assert.equal(current.normalizeModbusFraming(v), 'tcp', JSON.stringify(v));
  }
});

test('modbusFramingFromConfig: nur victron.host:victron.port des Profils, nie MQTT, liest die Config live', () => {
  assert.equal(typeof current.modbusFramingFromConfig, 'function');
  let cfg = { victron: { transport: 'modbus', host: HOST, port: 502, framing: RTU } };
  const framingFor = current.modbusFramingFromConfig(() => cfg);
  assert.equal(framingFor(HOST, 502), RTU);
  assert.equal(framingFor(HOST, '502'), RTU, 'Port als Text');
  assert.equal(framingFor(HOST, 1502), null, 'anderer Port = andere Verbindung');
  assert.equal(framingFor(OTHER, 502), null, 'Wallbox, Zähler an anderer Adresse');
  cfg = { victron: { ...cfg.victron, transport: 'mqtt' } };
  assert.equal(framingFor(HOST, 502), null);
  cfg = { victron: { transport: 'modbus', host: HOST, port: 502 } };
  assert.equal(framingFor(HOST, 502), null, 'Profil ohne framing');
  cfg = null;
  assert.equal(framingFor(HOST, 502), null);
});

// --- Null-Änderung ohne Einstellung: alte gegen neue Fassung --------------------------------------------------------

// Mischung aus allem, was auf dem Draht passieren kann: Reads FC 1–4, Writes FC 5/6/16, Not-Halt-Sperre, langer
// Block, Zeitüberschreitung mit später Antwort (A4), Ausnahme, kurze Antwort, Echo-Abweichungen, Bytes ohne Anfrage,
// Auflegen der Gegenstelle, dropConnections. Hält Draht (zerlegt UND roh), Verbindungsereignisse und Ergebnisse fest.
async function goldenScenario(r) {
  const { t, sockets, track, mod } = r;
  for (let i = 0; i < 40; i += 1) sockets.set(1, 100 + i, 0x1000 + i * 7);
  sockets.silence(130);
  sockets.mutate(170, (res) => [{ bytes: res, delayMs: 700 }]); // späte Antwort nach Zeitüberschreitung
  sockets.mutate(150, (res) => { const e = Buffer.from(res.subarray(0, 9)); e.writeUInt16BE(3, 4); e[7] |= 0x80; e[8] = 2; return e; });
  sockets.mutate(160, (res) => { const s = Buffer.from(res.subarray(0, res.length - 2)); s.writeUInt16BE(s.readUInt16BE(4) - 2, 4); s[8] -= 2; return s; });
  sockets.mutate(240, (res) => { const b = Buffer.from(res); b.writeUInt16BE(0x1234, 10); return b; }); // Wert maskiert
  sockets.mutate(250, (res) => { const b = Buffer.from(res); b.writeUInt16BE(999, 8); return b; }); // falsche Adresse
  track('r1', t.mbRequest(base({ fc: 3, address: 100, quantity: 2 })));
  track('w1', t.mbWriteSingle(base({ address: 200, value: 1 })));
  track('r2', t.mbRequest(base({ fc: 4, address: 110, quantity: 1 })));
  track('w2', t.mbWriteMultiple(base({ address: 210, values: [1, 2] })));
  mod.fenceModbusWrites();
  track('w3', t.mbWriteSingle(base({ address: 220, value: 0 })));
  track('r3', t.mbRequest(base({ fc: 3, address: 100, quantity: 30 })));
  track('r4', t.mbRequest(base({ fc: 3, address: 130, quantity: 1, timeoutMs: 500 })));
  track('r5', t.mbRequest(base({ fc: 3, address: 140, quantity: 1 })));
  track('x1', t.mbRequest(base({ fc: 3, address: 150, quantity: 2 })));
  track('s1', t.mbRequest(base({ fc: 3, address: 160, quantity: 2 })));
  track('c1', t.mbRequest(base({ fc: 1, address: 300, quantity: 24 })));
  track('c2', t.mbRequest(base({ fc: 2, address: 310, quantity: 5 })));
  track('w4', t.mbWriteCoil(base({ address: 230, value: true })));
  track('w5', t.mbWriteSingle(base({ address: 240, value: 7 })));
  track('w6', t.mbWriteSingle(base({ address: 250, value: 8 })));
  track('w7', t.mbWriteMultiple(base({ address: 260, values: [3, 4, 5] })));
  track('l1', t.mbRequest(base({ fc: 3, address: 170, quantity: 1, timeoutMs: 400 })));
  track('l2', t.mbRequest(base({ fc: 3, address: 171, quantity: 1 })));
  await advance(2000);
  sockets.inject([0, 1, 2]);
  track('g1', t.mbRequest(base({ fc: 3, address: 180, quantity: 1, timeoutMs: 300 })));
  await advance(1000);
  sockets.silence(181);
  track('h1', t.mbRequest(base({ fc: 3, address: 181, quantity: 1 })));
  await flush();
  sockets.hangUp();
  await flush();
  track('h2', t.mbRequest(base({ fc: 3, address: 182, quantity: 1 })));
  await advance(500);
  sockets.silence(190);
  track('d1', t.mbRequest(base({ fc: 3, address: 190, quantity: 1 })));
  await advance(100);
  t.dropConnections();
  track('d2', t.mbRequest(base({ fc: 3, address: 191, quantity: 1 })));
  track('o1', t.mbRequest(base({ host: OTHER, fc: 3, address: 100, quantity: 2 })));
  await advance(2000);
  return {
    wire: sockets.wire.map((f) => ({ ...f })),
    bytes: sockets.bytes.map(({ t: tt, host, port, hex }) => `${tt}:${host}:${port}:${hex}`),
    events: sockets.events.map(({ t: tt, ev, host }) => `${tt}:${ev}:${host}`),
    settled: r.settled.map(({ label, ok, t: tt, v, error }) => `${label}@${tt}:${ok ? JSON.stringify(v) : error}`),
  };
}

const NO_FRAMING_VARIANTS = [
  ['kein framingFor', undefined],
  ['Resolver liefert null', () => null],
  ['Resolver liefert undefined', () => undefined],
  ['ausdrücklich tcp', () => 'tcp'],
  ['ungültig: rtu', () => 'rtu'],
  ['ungültig: RTU over TCP', () => 'RTU over TCP'],
  ['ungültig: rtu_over_tcp', () => 'rtu_over_tcp'],
  ['ungültig: Zahl', () => 42],
  ['ungültig: Objekt', () => ({ framing: RTU })],
  ['ungültig: Liste', () => [RTU]],
  ['Resolver wirft', () => { throw new Error('kaputt'); }],
  ['RTU nur für eine andere Adresse', (host) => (host === '192.0.2.99' ? RTU : null)],
  ['RTU nur für einen anderen Port', (host, port) => (Number(port) === 4196 ? RTU : null)],
  ['Config ohne framing', current.modbusFramingFromConfig?.(() => ({ victron: { transport: 'modbus', host: HOST, port: 502 } }))],
  ['Config framing ungültig', current.modbusFramingFromConfig?.(() => ({ victron: { transport: 'modbus', host: HOST, port: 502, framing: 'rtu' } }))],
  ['Config framing tcp', current.modbusFramingFromConfig?.(() => ({ victron: { transport: 'modbus', host: HOST, port: 502, framing: 'tcp' } }))],
  ['Config RTU an anderer Anlagenadresse', current.modbusFramingFromConfig?.(() => ({ victron: { transport: 'modbus', host: '192.0.2.99', port: 502, framing: RTU } }))],
  ['Config RTU an anderem Port', current.modbusFramingFromConfig?.(() => ({ victron: { transport: 'modbus', host: HOST, port: 4196, framing: RTU } }))],
  ['Config RTU, aber MQTT', current.modbusFramingFromConfig?.(() => ({ victron: { transport: 'mqtt', host: HOST, port: 502, framing: RTU } }))],
];

async function compareAgainstFrozen(pacingFor, needles = []) {
  const ref = rig({ mod: frozen, pacingFor });
  let expected;
  try {
    expected = await goldenScenario(ref);
  } finally {
    await ref.done();
  }
  // Der Maßstab selbst muss die Szenerie abdecken (sonst vergliche der Test Leere mit Leere).
  const labels = expected.settled.join(' ');
  for (const needle of needles) {
    assert.ok(labels.includes(needle), `Maßstab deckt ab: ${needle}\n${expected.settled.join('\n')}`);
  }
  for (const [name, framingFor] of NO_FRAMING_VARIANTS) {
    if (name.startsWith('Config') && typeof framingFor !== 'function') assert.fail(`${name}: modbusFramingFromConfig fehlt`);
    const r = rig({ mod: current, framingFor, pacingFor });
    try {
      assert.deepEqual(await goldenScenario(r), expected, name);
    } finally {
      await r.done();
    }
  }
  return expected;
}

test('ohne Einstellung: Draht (Byte für Byte), Zeitpunkte, Verbindungen und Ergebnisse wie 1c168de4 — jede Form von „kein RTU“', async () => {
  const expected = await compareAgainstFrozen(undefined, ['r1@0:[', 'w1@0:modbus write verworfen', 'r4@500:modbus timeout',
    'x1@500:modbus exception 2', 's1@500:modbus short response', 'c1@500:[0]', 'w5@500:{"addr":240,"value":4660,"echoMismatch":true}',
    'w6@500:invalid write ack (address 999', 'l1@900:modbus timeout', 'g1@2000:invalid modbus frame length', 'h1@3000:connection closed',
    'h2@3000:[0]', 'd1@3600:pool cleanup', 'd2@3600:[0]', 'o1@3600:[4096,4103]']);
  assert.ok(expected.bytes.length >= 20, `genug Verkehr verglichen (${expected.bytes.length} Rahmen)`);
  assert.ok(expected.bytes.every((b) => b.split(':')[3].slice(4, 8) === '0000'), 'jeder Rahmen trägt den MBAP-Kopf (Protokoll-ID 0)');
});

test('ohne Einstellung, mit E7-Taktung: Draht und Zeitpunkte wie 1c168de4 mit derselben Taktung', async () => {
  await compareAgainstFrozen(() => ({ minRequestGapMs: 150, connectDelayMs: 40, maxRegistersPerRequest: 10 }));
});

// --- RTU-Rahmen auf dem Draht ----------------------------------------------------------------------------------------

test('RTU Lesen FC 3/4/1/2: Unit-ID + PDU + CRC (Low-Byte zuerst), kein MBAP-Kopf; Werte wie über Modbus TCP', async () => {
  const requests = [
    ['fc3', { unitId: 85, fc: 3, address: 0x21, quantity: 2 }, '55030021000299d5'],
    ['fc4', { unitId: 1, fc: 4, address: 33057, quantity: 2 }, hexOf(rtuFrame(1, [4, 0x81, 0x21, 0, 2]))],
    ['fc1', { unitId: 1, fc: 1, address: 300, quantity: 24 }, hexOf(rtuFrame(1, [1, 1, 44, 0, 24]))],
    ['fc2', { unitId: 1, fc: 2, address: 310, quantity: 5 }, hexOf(rtuFrame(1, [2, 1, 54, 0, 5]))],
    ['fc3-lang', { unitId: 1, fc: 3, address: 0, quantity: 125 }, hexOf(rtuFrame(1, [3, 0, 0, 0, 125]))],
  ];
  const image = (s) => { s.set(85, 0x21, 0xffff).set(85, 0x22, 0xfc7c).set(1, 33057, 1).set(1, 33058, 0x2345); for (let i = 0; i < 125; i += 1) s.set(1, i, i * 3); };
  const results = {};
  for (const mode of ['tcp', 'rtu']) {
    const r = mode === 'rtu' ? rtuRig() : rig();
    try {
      image(r.sockets);
      for (const [label, req] of requests) r.track(label, r.t.mbRequest(base(req)));
      await advance(100);
      results[mode] = r.settled.map((s) => [s.label, s.ok, s.v ?? s.error]);
      if (mode === 'rtu') {
        assert.deepEqual(r.sockets.bytes.map((b) => b.hex), requests.map(([, , hex]) => hex));
        assert.deepEqual(r.sockets.wire.map((f) => f.badCrc), requests.map(() => undefined), 'jede Anfrage-CRC stimmt');
      }
    } finally {
      await r.done();
    }
  }
  assert.ok(results.rtu.every(([, ok]) => ok), JSON.stringify(results.rtu));
  assert.deepEqual(results.rtu, results.tcp, 'dieselben Register über RTU und TCP');
  assert.deepEqual(results.rtu[0][2], [0xffff, 0xfc7c]);
});

test('RTU Schreiben FC 6/16/5: Rahmen Byte für Byte, Bestätigung wie über Modbus TCP', async () => {
  const results = {};
  for (const mode of ['tcp', 'rtu']) {
    const r = mode === 'rtu' ? rtuRig() : rig();
    try {
      r.track('w6', r.t.mbWriteSingle(base({ address: 1, value: 3 })));
      r.track('w16', r.t.mbWriteMultiple(base({ address: 2716, values: [0xffff, 0x8ad0] })));
      r.track('w5', r.t.mbWriteCoil(base({ address: 400, value: true })));
      r.track('w5off', r.t.mbWriteCoil(base({ address: 400, value: false })));
      r.track('w6neg', r.t.mbWriteSingle(base({ unitId: 100, address: 2716, value: -500 })));
      await advance(100);
      results[mode] = r.settled.map((s) => [s.label, s.ok, s.v ?? s.error]);
      if (mode === 'rtu') {
        assert.deepEqual(r.sockets.bytes.map((b) => b.hex), [
          '010600010003980b',
          hexOf(rtuFrame(1, [16, 0x0a, 0x9c, 0, 2, 4, 0xff, 0xff, 0x8a, 0xd0])),
          hexOf(rtuFrame(1, [5, 0x01, 0x90, 0xff, 0x00])),
          hexOf(rtuFrame(1, [5, 0x01, 0x90, 0x00, 0x00])),
          hexOf(rtuFrame(100, [6, 0x0a, 0x9c, 0xfe, 0x0c])),
        ]);
      }
    } finally {
      await r.done();
    }
  }
  assert.ok(results.rtu.every(([, ok]) => ok), JSON.stringify(results.rtu));
  assert.deepEqual(results.rtu, results.tcp);
});

test('RTU gilt nur für die eingestellte Verbindung: andere Adresse und anderer Port bleiben Modbus TCP', async () => {
  const r = rig({
    framingFor: current.modbusFramingFromConfig?.(() => ({ victron: { transport: 'modbus', host: HOST, port: 502, framing: RTU } })),
    socket: { framing: (host, port) => (host === HOST && Number(port) === 502 ? 'rtu' : 'tcp') },
  });
  try {
    r.sockets.set(1, 10, 42);
    r.track('anlage', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    r.track('wallbox', r.t.mbRequest(base({ host: OTHER, fc: 3, address: 10, quantity: 1 })));
    r.track('port', r.t.mbRequest(base({ port: 1502, fc: 3, address: 10, quantity: 1 })));
    await advance(100);
    assert.deepEqual(r.settled.map((s) => [s.label, s.v]), [['anlage', [42]], ['wallbox', [42]], ['port', [42]]]);
    const byConn = Object.fromEntries(r.sockets.bytes.map((b) => [`${b.host}:${b.port}`, b.hex]));
    assert.equal(byConn[`${HOST}:502`], hexOf(rtuFrame(1, [3, 0, 10, 0, 1])));
    assert.match(byConn[`${OTHER}:502`], /^[0-9a-f]{4}000000060103000a0001$/, 'MBAP: Transaktions-ID, Protokoll 0, Länge 6');
    assert.match(byConn[`${HOST}:1502`], /^[0-9a-f]{4}000000060103000a0001$/);
  } finally {
    await r.done();
  }
});

test('Config live: framing einschalten wirkt ab der nächsten Anfrage, ausschalten ebenso', async () => {
  let cfg = { victron: { transport: 'modbus', host: HOST, port: 502 } };
  let gw = 'tcp';
  const r = rig({ framingFor: current.modbusFramingFromConfig?.(() => cfg), socket: { framing: () => gw } });
  try {
    r.sockets.set(1, 10, 42);
    r.track('a', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    await advance(100);
    cfg = { victron: { ...cfg.victron, framing: RTU } };
    gw = 'rtu';
    r.track('b', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    await advance(100);
    cfg = { victron: { ...cfg.victron, framing: 'tcp' } };
    gw = 'tcp';
    r.track('c', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    await advance(100);
    assert.deepEqual(r.settled.map((s) => [s.label, s.v]), [['a', [42]], ['b', [42]], ['c', [42]]]);
    assert.deepEqual(r.sockets.bytes.map((b) => b.hex.length), [24, 16, 24], 'MBAP 12 Byte, RTU 8 Byte, MBAP');
  } finally {
    await r.done();
  }
});

// --- Fehlerfälle: nie ein falscher Wert --------------------------------------------------------------------------------

test('Ausnahme (FC|0x80): „modbus exception N“ wie über TCP, das Schreibtor wertet sie wie bisher, Verbindung bleibt', async () => {
  const r = rtuRig();
  try {
    r.sockets.mutate(2716, () => rtuFrame(1, [0x86, 0x02]));
    r.sockets.mutate(30, () => rtuFrame(1, [0x83, 0x04]));
    const w = r.track('w', r.t.mbWriteSingle(base({ address: 2716, value: 100 })));
    r.track('x', r.t.mbRequest(base({ fc: 3, address: 30, quantity: 1 })));
    r.track('ok', r.t.mbRequest(base({ fc: 3, address: 31, quantity: 1 })));
    await advance(100);
    const err = await w;
    assert.equal(err.message, 'modbus exception 2');
    assert.equal(classifyModbusError(err).delivery, 'rejected', 'Ausnahme 2 = abgelehnt, nichts geschrieben');
    assert.deepEqual(r.settled.map((s) => `${s.label}@${s.t}:${s.ok ? 'ok' : s.error}`), ['w@0:modbus exception 2', 'x@0:modbus exception 4', 'ok@0:ok']);
    assert.deepEqual(r.sockets.events.map((e) => e.ev), ['connect'], 'eine gültige Ausnahme ist eine ganze Antwort: kein Neuaufbau');
  } finally {
    await r.done();
  }
});

test('falsche CRC: Fehler statt Wert, Verbindung verworfen, Ruhezeit, danach wieder richtige Werte', async () => {
  const r = rtuRig();
  try {
    r.sockets.set(1, 100, 4321).set(1, 101, 777);
    let bad = true;
    r.sockets.mutate(100, (res) => (bad ? corruptLast(res) : res));
    r.track('r1', r.t.mbRequest(base({ fc: 3, address: 100, quantity: 1 })));
    r.track('r2', r.t.mbRequest(base({ fc: 3, address: 101, quantity: 1 })));
    await advance(3000);
    bad = false;
    r.track('r3', r.t.mbRequest(base({ fc: 3, address: 100, quantity: 1 })));
    await advance(100);
    assert.deepEqual(r.settled.map((s) => `${s.label}@${s.t}:${s.ok ? s.v : s.error}`),
      ['r1@0:modbus rtu: CRC falsch', 'r2@1000:777', 'r3@3000:4321']);
    assert.deepEqual(r.sockets.events.map((e) => `${e.ev}@${e.t}`), ['connect@0', 'close@0', 'connect@0'], 'Neuaufbau sofort, Senden erst nach der Ruhezeit');
    assert.deepEqual(r.sockets.wire.map((f) => `${f.address}@${f.t}`), ['100@0', '101@1000', '100@3000']);
  } finally {
    await r.done();
  }
});

test('falsche CRC auf einer Schreib-Bestätigung: Fehler, das Schreibtor wertet „womöglich angekommen“ (nicht „nicht gesendet“)', async () => {
  const r = rtuRig();
  try {
    r.sockets.mutate(2716, (res) => corruptLast(res));
    const p = r.track('w', r.t.mbWriteSingle(base({ address: 2716, value: 100 })));
    await advance(10);
    const err = await p;
    assert.ok(err instanceof Error, `Fehler statt Bestätigung (bekam ${JSON.stringify(err)})`);
    assert.equal(err.message, 'modbus rtu: CRC falsch');
    assert.equal(classifyModbusError(err).delivery, 'unknown');
    assert.equal(r.sockets.wire.filter((f) => f.fc === 6).length, 1, 'der Write ging auf den Draht');
  } finally {
    await r.done();
  }
});

test('fremde Unit-ID, fremder Funktionscode, Ausnahme zu einem anderen Funktionscode: Fehler statt Wert', async () => {
  const r = rtuRig();
  try {
    r.sockets.set(1, 10, 5).set(2, 10, 6);
    r.sockets.mutate(10, (res) => rtuFrame(2, res.subarray(1, res.length - 2))); // Antwort von Unit 2
    r.sockets.mutate(20, () => rtuFrame(1, [4, 2, 0, 9])); // FC 4 auf eine FC-3-Anfrage
    r.sockets.mutate(2716, () => rtuFrame(1, [0x83, 0x02])); // Ausnahme zu FC 3 auf einen FC-6-Write
    r.track('unit', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    r.track('fc', r.t.mbRequest(base({ fc: 3, address: 20, quantity: 1 })));
    const w = r.track('exc', r.t.mbWriteSingle(base({ address: 2716, value: 1 })));
    await advance(5000);
    assert.deepEqual(r.settled.map((s) => [s.label, s.ok, s.error]), [
      ['unit', false, 'modbus rtu: Antwort von Unit-ID 2, erwartet 1'],
      ['fc', false, 'modbus rtu: Funktionscode 4 in der Antwort, erwartet 3'],
      ['exc', false, 'modbus rtu: Funktionscode 131 in der Antwort, erwartet 6'],
    ]);
    const e = await w;
    assert.equal(classifyModbusError(e).delivery, 'unknown', 'eine fremde Ausnahme ist keine Ablehnung DIESES Writes');
    assert.equal(r.sockets.events.filter((x) => x.ev === 'close').length, 3, 'jedes Mal verworfen');
  } finally {
    await r.done();
  }
});

test('kurze Antwort: zu wenig Datenbytes (gültige CRC) → Fehler; abgeschnittener Rahmen → Zeitüberschreitung; nie ein Wert', async () => {
  const r = rtuRig();
  try {
    r.sockets.set(1, 10, 11).set(1, 11, 12).set(1, 20, 21).set(1, 21, 22);
    r.sockets.mutate(10, () => rtuFrame(1, [3, 2, 0, 11])); // 1 statt 2 Register, CRC stimmt
    r.sockets.mutate(20, (res) => res.subarray(0, res.length - 3)); // Bytes fehlen
    r.track('kurz', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 2 })));
    r.track('abgeschnitten', r.t.mbRequest(base({ fc: 3, address: 20, quantity: 2, timeoutMs: 500 })));
    await advance(5000);
    assert.deepEqual(r.settled.map((s) => [s.label, s.ok, s.error]), [
      ['kurz', false, 'modbus rtu: 2 Datenbytes in der Antwort, erwartet 4'],
      ['abgeschnitten', false, 'modbus timeout'],
    ]);
  } finally {
    await r.done();
  }
});

test('Echo eines Writes passt nicht (Adresse, Anzahl): Fehler statt Bestätigung', async () => {
  const r = rtuRig();
  try {
    r.sockets.mutate(2716, () => rtuFrame(1, [6, 0x0a, 0x9d, 0, 1]));
    r.sockets.mutate(2900, () => rtuFrame(1, [16, 0x0b, 0x54, 0, 1]));
    r.track('w6', r.t.mbWriteSingle(base({ address: 2716, value: 1 })));
    r.track('w16', r.t.mbWriteMultiple(base({ address: 2900, values: [1, 2] })));
    await advance(5000);
    assert.deepEqual(r.settled.map((s) => [s.label, s.ok, s.error]), [
      ['w6', false, 'modbus rtu: Bestätigung für Register 2717, erwartet 2716'],
      ['w16', false, 'modbus rtu: Bestätigung für 1 Register, erwartet 2'],
    ]);
  } finally {
    await r.done();
  }
});

test('Bytes nach dem Ende der Antwort im selben Paket: Fehler statt Wert', async () => {
  const r = rtuRig();
  try {
    r.sockets.set(1, 10, 11);
    r.sockets.mutate(10, (res) => Buffer.concat([res, Buffer.from([0x00])]));
    r.track('r', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    await advance(100);
    assert.deepEqual(r.settled.map((s) => [s.ok, s.error]), [[false, 'modbus rtu: 1 Byte nach dem Ende der Antwort']]);
  } finally {
    await r.done();
  }
});

test('Antwort in Stücken (Gateway-Pakete, auch einzelne Bytes): richtig zusammengesetzt', async () => {
  const r = rtuRig();
  try {
    for (let i = 0; i < 10; i += 1) r.sockets.set(1, 50 + i, 1000 + i);
    r.sockets.mutate(50, (res) => [...res].map((b, i) => ({ bytes: [b], delayMs: i * 20 })));
    r.sockets.mutate(2716, (res) => [{ bytes: res.subarray(0, 1) }, { bytes: res.subarray(1), delayMs: 300 }]);
    r.track('r', r.t.mbRequest(base({ fc: 3, address: 50, quantity: 10 })));
    r.track('w', r.t.mbWriteSingle(base({ address: 2716, value: 9 })));
    await advance(2000, 10);
    assert.deepEqual(r.settled.map((s) => [s.label, s.ok, s.v]), [
      ['r', true, Array.from({ length: 10 }, (_, i) => 1000 + i)],
      ['w', true, { addr: 2716, value: 9, echoMismatch: false }],
    ]);
    assert.deepEqual(r.sockets.events.map((e) => e.ev), ['connect']);
  } finally {
    await r.done();
  }
});

test('späte Antwort nach Zeitüberschreitung, vom Gateway auch an die NEUE Verbindung geschickt: verworfen, nie der nächsten Anfrage zugeordnet', async () => {
  const r = rtuRig();
  try {
    r.sockets.set(1, 100, 111);
    let first = true;
    // Erste Anfrage: das Gerät antwortet nach 1500 ms (Zeitlimit 1000). Ein transparentes Gateway gibt serielle Bytes an
    // jede verbundene TCP-Verbindung (USR-TCP232-410S: „sent to all TCP Client devices … simultaneously“).
    r.sockets.mutate(100, (res) => {
      if (!first) return res;
      first = false;
      return [{ bytes: res, delayMs: 1500, toLive: true }];
    });
    r.track('a', r.t.mbRequest(base({ fc: 3, address: 100, quantity: 1 })));
    r.track('b', r.t.mbRequest(base({ fc: 3, address: 100, quantity: 1 })));
    await flush();
    r.sockets.set(1, 100, 222); // neuer Messwert für die zweite Anfrage
    await advance(4000);
    assert.deepEqual(r.settled.map((s) => `${s.label}@${s.t}:${s.ok ? s.v : s.error}`), ['a@1000:modbus timeout', 'b@2000:222']);
    assert.ok(!r.settled.some((s) => JSON.stringify(s.v) === '[111]'), 'der alte Wert taucht nirgends auf');
    assert.deepEqual(r.sockets.wire.map((f) => f.t), [0, 2000], 'zweite Anfrage erst nach der Ruhezeit (Zeitlimit, mind. 1 s)');
  } finally {
    await r.done();
  }
});

test('Bytes ohne offene Anfrage werden verworfen; die nächste Anfrage wartet die Ruhezeit ab und bekommt ihren eigenen Wert', async () => {
  const r = rtuRig();
  try {
    r.sockets.set(1, 10, 5).set(1, 11, 6);
    r.track('r1', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 2 })));
    await advance(100);
    // Ein vollständiger, gültiger Rahmen mit derselben Form (Unit 1, FC 3, 2 Register) ohne Anfrage dazu.
    assert.ok(r.sockets.inject(rtuFrame(1, [3, 4, 0, 1, 0, 2])));
    r.track('r2', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 2 })));
    await advance(3000);
    assert.deepEqual(r.settled.map((s) => `${s.label}@${s.t}:${JSON.stringify(s.v ?? s.error)}`), ['r1@0:[5,6]', 'r2@1100:[5,6]']);
  } finally {
    await r.done();
  }
});

test('dropConnections (Einfrier-Wächter) und Auflegen mitten in einer RTU-Anfrage: späte Bytes danach verworfen', async () => {
  const r = rtuRig();
  try {
    r.sockets.set(1, 10, 1);
    // Antworten auf die 1. und 3. Anfrage kommen 200 ms spät — nach dem Abbau — und das Gateway gibt sie an die
    // dann aktuelle Verbindung. Die Folgeanfragen antworten nach 300 ms: ginge eine sofort raus, läge die späte Antwort
    // vor ihrer eigenen im Puffer.
    let call = 0;
    r.sockets.mutate(10, (res) => {
      const n = call++;
      return (n === 0 || n === 2) ? [{ bytes: res, delayMs: 200, toLive: true }] : [{ bytes: res, delayMs: 300 }];
    });
    r.track('d', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    await advance(100);
    r.t.dropConnections();
    r.sockets.set(1, 10, 2);
    r.track('d2', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    await advance(3000);
    r.track('h', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    await advance(100);
    r.sockets.hangUp();
    await flush();
    r.sockets.set(1, 10, 3);
    r.track('h2', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    await advance(3000);
    assert.deepEqual(r.settled.map((s) => `${s.label}:${JSON.stringify(s.v ?? s.error)}`),
      ['d:"pool cleanup"', 'd2:[2]', 'h:"connection closed"', 'h2:[3]']);
    // Folgeanfragen erst nach der Ruhezeit (1 s ab dem Abbruch), nicht direkt auf der neuen Verbindung.
    const sent = r.sockets.wire.map((f) => f.t);
    assert.deepEqual([sent[1] - 100, sent[3] - sent[2] - 100], [1000, 1000], JSON.stringify(sent));
    assert.ok(!r.settled.some((s) => s.ok && JSON.stringify(s.v) === '[1]'), 'kein alter Wert');
  } finally {
    await r.done();
  }
});

// --- Warteschlange, Not-Halt, Lese-Modus, E7 ---------------------------------------------------------------------------

test('RTU mit E7-Taktung: Lesen und Schreiben in Reihenfolge der Warteschlange, jeder Transfer im Abstand', async () => {
  const r = rtuRig({ pacingFor: onlyHost({ minRequestGapMs: 400, connectDelayMs: 100 }) });
  try {
    const t = r.t;
    r.track('r1', t.mbRequest(base({ fc: 3, address: 1, quantity: 1 })));
    r.track('w1', t.mbWriteSingle(base({ address: 500, value: 11 })));
    r.track('r2', t.mbRequest(base({ fc: 4, address: 2, quantity: 1 })));
    r.track('w2', t.mbWriteMultiple(base({ address: 501, values: [22, 23] })));
    r.track('w3', t.mbWriteCoil(base({ address: 503, value: true })));
    await advance(5000);
    assert.deepEqual(r.sockets.wire.map((f) => `${f.fc}:${f.address}@${f.t}`), ['3:1@100', '6:500@500', '4:2@900', '16:501@1300', '5:503@1700']);
    assert.deepEqual(r.sockets.bytes.map((b) => b.hex), [
      hexOf(rtuFrame(1, [3, 0, 1, 0, 1])),
      hexOf(rtuFrame(1, [6, 0x01, 0xf4, 0, 11])),
      hexOf(rtuFrame(1, [4, 0, 2, 0, 1])),
      hexOf(rtuFrame(1, [16, 0x01, 0xf5, 0, 2, 4, 0, 22, 0, 23])),
      hexOf(rtuFrame(1, [5, 0x01, 0xf7, 0xff, 0])),
    ]);
    assert.ok(r.settled.every((s) => s.ok), JSON.stringify(r.settled));
  } finally {
    await r.done();
  }
});

test('RTU: Fehler-Ruhezeit und E7-Abstand zusammen — es gilt der spätere Zeitpunkt', async () => {
  const r = rtuRig({ pacingFor: onlyHost({ minRequestGapMs: 1500 }) });
  try {
    r.sockets.mutate(1, (res) => corruptLast(res));
    r.track('a', r.t.mbRequest(base({ fc: 3, address: 1, quantity: 1, timeoutMs: 400 })));
    r.track('b', r.t.mbRequest(base({ fc: 3, address: 2, quantity: 1 })));
    await advance(3000);
    // Ruhezeit max(1000, 400) = 1000 < Abstand 1500 → b bei 1500.
    assert.deepEqual(r.sockets.wire.map((f) => `${f.address}@${f.t}`), ['1@0', '2@1500']);
  } finally {
    await r.done();
  }
});

test('Not-Halt, während ein Write in der Ruhezeit bzw. auf seinen Abstand wartet: er geht nicht raus, die Rücknahme danach als RTU', async () => {
  for (const [name, pacingFor] of [['Ruhezeit nach CRC-Fehler', undefined], ['E7-Abstand', onlyHost({ minRequestGapMs: 3000 })]]) {
    const r = rtuRig({ pacingFor });
    try {
      if (!pacingFor) r.sockets.mutate(10, (res) => corruptLast(res));
      r.track('read', r.t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
      const stale = r.track('stale', r.t.mbWriteSingle(base({ address: 2716, value: 5000 })));
      await advance(500);
      assert.deepEqual(r.sockets.wire.map((f) => f.address), [10], `${name}: der Write wartet noch`);
      current.fenceModbusWrites();
      r.track('neutral', r.t.mbWriteSingle(base({ address: 2716, value: 0 })));
      await advance(5000);
      const err = await stale;
      assert.match(err.message, /Not-Halt/, name);
      assert.equal(classifyModbusError(err).delivery, 'notSent', `${name}: nie gesendet`);
      const writes = r.sockets.bytes.filter((b) => b.hex.slice(2, 4) === '06').map((b) => b.hex);
      assert.deepEqual(writes, [hexOf(rtuFrame(1, [6, 0x0a, 0x9c, 0, 0]))], `${name}: nur die Rücknahme, als RTU-Rahmen`);
    } finally {
      await r.done();
    }
  }
});

test('Lese-Modus (DVHUB_READ_ONLY=1): Writes sofort abgelehnt, auch über RTU; Reads gehen als RTU-Rahmen', async () => {
  const before = process.env.DVHUB_READ_ONLY;
  process.env.DVHUB_READ_ONLY = '1';
  const warn = console.warn;
  console.warn = () => {};
  const r = rtuRig();
  try {
    r.track('w6', r.t.mbWriteSingle(base({ address: 2716, value: 1 })));
    r.track('w16', r.t.mbWriteMultiple(base({ address: 2716, values: [1, 2] })));
    r.track('w5', r.t.mbWriteCoil(base({ address: 400, value: true })));
    r.track('r', r.t.mbRequest(base({ fc: 3, address: 1, quantity: 1 })));
    await advance(100);
    assert.deepEqual(r.settled.map((s) => [s.label, s.ok, s.t]), [['w6', false, 0], ['w16', false, 0], ['w5', false, 0], ['r', true, 0]]);
    assert.ok(r.settled.filter((s) => !s.ok).every((s) => /Lese-Modus/.test(s.error)));
    assert.deepEqual(r.sockets.bytes.map((b) => b.hex), [hexOf(rtuFrame(1, [3, 0, 1, 0, 1]))]);
  } finally {
    await r.done();
    console.warn = warn;
    if (before === undefined) delete process.env.DVHUB_READ_ONLY; else process.env.DVHUB_READ_ONLY = before;
  }
});

test('Registerdeckel (E7) über RTU: Teil-Anfragen als eigene RTU-Rahmen, Ergebnis zusammengesetzt', async () => {
  const r = rtuRig({ pacingFor: onlyHost({ maxRegistersPerRequest: 4 }) });
  try {
    for (let i = 0; i < 10; i += 1) r.sockets.set(1, 200 + i, i + 1);
    const p = r.track('block', r.t.mbRequest(base({ fc: 3, address: 200, quantity: 10 })));
    await advance(100);
    assert.deepEqual(await p, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(r.sockets.wire.map((f) => `${f.address}x${f.quantity}`), ['200x4', '204x4', '208x2']);
  } finally {
    await r.done();
  }
});

test('Unit-ID 0 über RTU (Broadcast an jedes Gerät am Bus) geht nie raus; über Modbus TCP unverändert', async () => {
  const r = rtuRig({ transport: { idleMs: 300 } });
  try {
    r.sockets.set(1, 5, 55);
    r.track('w0', r.t.mbWriteSingle(base({ unitId: 0, address: 2716, value: 1 })));
    r.track('r0', r.t.mbRequest(base({ unitId: 0, fc: 3, address: 5, quantity: 1 })));
    r.track('r1', r.t.mbRequest(base({ fc: 3, address: 5, quantity: 1 })));
    await advance(100);
    assert.deepEqual(r.settled.map((s) => [s.label, s.ok, s.v ?? s.error]), [
      ['w0', false, 'modbus rtu: Unit-ID 0 wäre am RS485-Bus ein Broadcast an jedes Gerät — nicht gesendet'],
      ['r0', false, 'modbus rtu: Unit-ID 0 wäre am RS485-Bus ein Broadcast an jedes Gerät — nicht gesendet'],
      ['r1', true, [55]],
    ]);
    assert.deepEqual(r.sockets.bytes.map((b) => b.hex), [hexOf(rtuFrame(1, [3, 0, 5, 0, 1]))], 'nur die Anfrage an Unit 1');
    // Nur eine Unit-0-Anfrage auf einer frischen Verbindung: abgewiesen, die Verbindung baut nach Leerlauf trotzdem ab.
    r.t.dropConnections();
    await flush();
    const seen = r.sockets.events.length;
    r.track('w0b', r.t.mbWriteSingle(base({ unitId: 0, address: 2716, value: 2 })));
    await advance(1000);
    assert.deepEqual(r.sockets.events.slice(seen).map((e) => `${e.ev}@${e.t}`), ['connect@100', 'close@400']);
  } finally {
    await r.done();
  }
  const tcp = rig();
  try {
    tcp.track('w0', tcp.t.mbWriteSingle(base({ unitId: 0, address: 2716, value: 1 })));
    await advance(100);
    assert.equal(tcp.settled[0].ok, true, 'Modbus TCP: Unit 0 adressiert das Gateway/Gerät selbst — wie bisher');
  } finally {
    await tcp.done();
  }
});

// Verdrahtung: nur der Haupt-Transport (Anlagen-Verbindung) bekommt den Rahmen-Resolver. Register-Scan, zweiter
// Sungrow-WR und zweite GX sind eigene Pools; eine zweite Verbindung zum selben transparenten Gateway bekäme dessen
// serielle Bytes ebenfalls und würde Antworten fremder Anfragen sehen — deshalb dort kein RTU.
test('server.js: Haupt-Transport mit framingFor aus der Config, alle anderen Modbus-Transporte ohne', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const creations = [...src.matchAll(/createModbusTransport\(\{([^}]*)\}\)/g)].map((m) => m[1]);
  assert.ok(creations.length >= 5, `alle Transporte gefunden (${creations.length})`);
  const withFraming = creations.filter((c) => /framingFor/.test(c));
  assert.equal(withFraming.length, 1, 'genau ein Transport mit Rahmen-Resolver');
  assert.match(withFraming[0], /pacingFor: modbusPacingFromConfig\(\(\) => cfg\)/, 'der mit der Anlagen-Taktung');
  assert.match(withFraming[0], /framingFor: modbusFramingFromConfig\(\(\) => cfg\)/);
  assert.match(src, /import \{[^}]*modbusFramingFromConfig[^}]*\} from '\.\/transport-modbus\.js'/);
});
