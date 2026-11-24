import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createModbusServer } from '../modbus-server.js';

// Christin 20.11.2026 (Frage 1 im Abgleich Rust 1.1 ↔ Node): Im Not-Halt
// quittiert der DV-Modbus-Server Schreibbefehle des Direktvermarkters nicht mehr
// mit Erfolg. „Mit Fehler antworten – oder gar nicht“: Jeder Schreib-FC (5, 6,
// 15, 16, 22, 23) bekommt die Modbus-Ausnahme 0x04 (Server Device Failure). Der
// Befehl wird nicht übernommen: kein forcedOff, kein Register, keine LUOX-
// Vorgabe, kein Watchdog. Lesen bleibt unverändert. Nach dem Not-Halt gilt
// wieder das normale Verhalten.

function request(port, pdu, unit = 1) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const mbap = Buffer.alloc(7);
    mbap.writeUInt16BE(0x4242, 0);
    mbap.writeUInt16BE(0, 2);
    mbap.writeUInt16BE(pdu.length + 1, 4);
    mbap.writeUInt8(unit, 6);
    sock.on('connect', () => sock.write(Buffer.concat([mbap, pdu])));
    sock.once('data', (d) => { sock.destroy(); resolve(d); });
    sock.on('error', reject);
  });
}
const readPdu = (fc, addr, qty) => { const b = Buffer.alloc(5); b.writeUInt8(fc, 0); b.writeUInt16BE(addr, 1); b.writeUInt16BE(qty, 3); return b; };
const writeSinglePdu = (addr, v) => { const b = Buffer.alloc(5); b.writeUInt8(6, 0); b.writeUInt16BE(addr, 1); b.writeUInt16BE(v, 3); return b; };
const writeMultiPdu = (addr, values) => {
  const b = Buffer.alloc(6 + values.length * 2);
  b.writeUInt8(16, 0); b.writeUInt16BE(addr, 1); b.writeUInt16BE(values.length, 3); b.writeUInt8(values.length * 2, 5);
  values.forEach((v, i) => b.writeUInt16BE(v, 6 + i * 2));
  return b;
};
// FC5 Write Single Coil: Adresse, Wert 0xFF00 = an.
const writeCoilPdu = (addr, on) => { const b = Buffer.alloc(5); b.writeUInt8(5, 0); b.writeUInt16BE(addr, 1); b.writeUInt16BE(on ? 0xff00 : 0, 3); return b; };
// FC15 Write Multiple Coils: Adresse, Anzahl, Bytezahl, Bits.
const writeCoilsPdu = (addr, n) => { const b = Buffer.alloc(7); b.writeUInt8(15, 0); b.writeUInt16BE(addr, 1); b.writeUInt16BE(n, 3); b.writeUInt8(1, 5); b.writeUInt8(0xff, 6); return b; };
// FC22 Mask Write Register: Adresse, AND-Maske, OR-Maske.
const maskWritePdu = (addr) => { const b = Buffer.alloc(7); b.writeUInt8(22, 0); b.writeUInt16BE(addr, 1); b.writeUInt16BE(0, 3); b.writeUInt16BE(1, 5); return b; };
// FC23 Read/Write Multiple: Lesen ab 0 (1 Reg), Schreiben ab 3 (1 Reg) = 1.
const readWritePdu = () => { const b = Buffer.alloc(12); b.writeUInt8(23, 0); b.writeUInt16BE(0, 1); b.writeUInt16BE(1, 3); b.writeUInt16BE(3, 5); b.writeUInt16BE(1, 7); b.writeUInt8(2, 9); b.writeUInt16BE(1, 10); return b; };
const regsOf = (resp) => { const n = resp.readUInt8(8) / 2; return Array.from({ length: n }, (_, i) => resp.readUInt16BE(9 + i * 2)); };

async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

async function withServer(profile, fn, { notHalt = true, forcedOff = false } = {}) {
  const port = await freePort();
  const events = [];
  const logs = [];
  const state = {
    systemWarnings: [],
    dvRegs: { 0: 130, 1: 0, 3: 0, 4: 0 },
    keepalive: {},
    ctrl: { forcedOff, discretionaryWritesPaused: notHalt },
    meter: { grid_total_w: -1500 },
    victron: { pvTotalW: 5000 },
  };
  const cfg = {
    modbusListenHost: '127.0.0.1', modbusListenPort: port, gridPositiveMeans: 'feed_in',
    dvInterface: { profile, luox: { referencePowerW: 40000 } },
  };
  const ctx = {
    state, getCfg: () => cfg, pushLog: (e, d, level) => logs.push([e, d, level]),
    expireLeaseIfNeeded: () => {},
    setForcedOff: (r) => { events.push(['setForcedOff', r]); state.ctrl.forcedOff = true; },
    clearForcedOff: (r) => { events.push(['clearForcedOff', r]); state.ctrl.forcedOff = false; },
    setDvLimitPct: (p, r) => events.push(['setDvLimitPct', p, r]),
    // Plexlog Holding 0 = Watt-Sollwert (0 = aus), wie dv-interface-luox.js setDvLimitW
    setDvLimitW: (w, r) => { events.push(['setDvLimitW', w, r]); state.ctrl.forcedOff = w === 0; },
    luoxWatchdogRefresh: () => events.push(['watchdog']),
  };
  const server = createModbusServer(ctx);
  server.start();
  const end = Date.now() + 2000;
  while (state.modbusListen?.ok !== true) {
    if (Date.now() > end) throw new Error('Modbus-Server lauscht nicht');
    await new Promise((r) => setTimeout(r, 10));
  }
  try { await fn({ port, events, logs, state, cfg }); } finally { server.close(); }
}

function assertException04(resp, fc, label) {
  assert.equal(resp.readUInt16BE(0), 0x4242, `${label}: Transaktions-ID zurück`);
  assert.equal(resp.readUInt16BE(4), 3, `${label}: Länge einer Ausnahme`);
  assert.equal(resp.readUInt8(7), (fc | 0x80) & 0xff, `${label}: Ausnahme-FC`);
  assert.equal(resp.readUInt8(8), 0x04, `${label}: Ausnahme 0x04 (Server Device Failure)`);
}

test('DV-Server Not-Halt (Plexlog): jeder Schreib-FC → Ausnahme 0x04, nichts übernommen', async () => {
  await withServer('plexlog', async ({ port, events, logs, state }) => {
    const regsBefore = { ...state.dvRegs };
    assertException04(await request(port, writeMultiPdu(0, [0, 0])), 16, 'FC16 Adresse 0 = aus');
    assertException04(await request(port, writeMultiPdu(3, [1])), 16, 'FC16 Adresse 3 = 1');
    assertException04(await request(port, writeSinglePdu(3, 1)), 6, 'FC6 Adresse 3 = 1');
    assertException04(await request(port, writeCoilPdu(0, true)), 5, 'FC5');
    assertException04(await request(port, writeCoilsPdu(0, 8)), 15, 'FC15');
    assertException04(await request(port, maskWritePdu(3)), 22, 'FC22');
    assertException04(await request(port, readWritePdu()), 23, 'FC23');

    assert.equal(state.ctrl.forcedOff, false, 'kein forcedOff');
    assert.deepEqual(events, [], 'weder setForcedOff noch clearForcedOff noch LUOX-Aufrufe');
    assert.deepEqual(state.dvRegs, regsBefore, 'kein Register geändert');
    // Jede Ablehnung steht im Protokoll (wer, welcher FC), keine Erfolgsmeldung.
    const rejected = logs.filter((l) => l[0] === 'modbus_write_rejected_nothalt');
    assert.deepEqual(rejected.map((l) => l[1].fc), [16, 16, 6, 5, 15, 22, 23]);
    assert.ok(rejected.every((l) => typeof l[1].remote === 'string' && l[1].exception === 4));
    assert.ok(!logs.some((l) => l[0] === 'modbus_fc6' || l[0] === 'modbus_fc16'), 'keine Erfolgs-Protokollzeile');
  });
});

test('DV-Server Not-Halt (Plexlog): Freigabe-Befehl wird ebenfalls nicht übernommen', async () => {
  await withServer('plexlog', async ({ port, events, state }) => {
    assertException04(await request(port, writeMultiPdu(0, [0xffff, 0xffff])), 16, 'FC16 Adresse 0 = an');
    assertException04(await request(port, writeMultiPdu(3, [0])), 16, 'FC16 Adresse 3 = 0');
    assert.equal(state.ctrl.forcedOff, true, 'Zustand bleibt, wie er vor dem Befehl war');
    assert.deepEqual(events, []);
  }, { forcedOff: true });
});

test('DV-Server Not-Halt: Lesen bleibt unverändert (FC3 und FC4, Plexlog und LUOX)', async () => {
  const reads = async (profile, notHalt) => {
    let out;
    await withServer(profile, async ({ port, state }) => {
      out = {
        fc3: regsOf(await request(port, readPdu(3, profile === 'luox' ? 2 : 0, 3))),
        fc4: regsOf(await request(port, readPdu(4, 0, 7))),
        last: state.keepalive.modbusLastQuery?.fc,
      };
    }, { notHalt });
    return out;
  };
  for (const profile of ['plexlog', 'luox']) {
    assert.deepEqual(await reads(profile, true), await reads(profile, false), `${profile}: Lesen im Not-Halt wie sonst`);
  }
});

test('DV-Server Not-Halt (LUOX): Vorgabe und Watchdog → Ausnahme 0x04, nichts übernommen', async () => {
  await withServer('luox', async ({ port, events, state }) => {
    assertException04(await request(port, writeMultiPdu(2, [0, 1, 2])), 16, 'FC16 Vorgabe 0 % + Watchdog');
    assertException04(await request(port, writeSinglePdu(2, 40)), 6, 'FC6 Vorgabe 40 %');
    assertException04(await request(port, writeSinglePdu(3, 7)), 6, 'FC6 Watchdog');
    assert.deepEqual(events, [], 'kein setDvLimitPct, kein Watchdog');
    assert.equal(state.ctrl.forcedOff, false);
    assert.ok(state.dvLuox == null || (state.dvLuox.setpointPct === 100 && state.dvLuox.watchdog.every((w) => w === 0)),
      'LUOX-Holding unverändert');
    // Holding-Lesen zeigt weiter 100 % und den alten Watchdog.
    assert.deepEqual(regsOf(await request(port, readPdu(3, 2, 3))), [100, 0, 0]);
  });
});

test('DV-Server: nach dem Not-Halt gilt wieder das normale Schreiben', async () => {
  await withServer('plexlog', async ({ port, events, state }) => {
    assertException04(await request(port, writeMultiPdu(0, [0, 0])), 16, 'im Not-Halt');
    assert.equal(state.ctrl.forcedOff, false);

    state.ctrl.discretionaryWritesPaused = false;
    const ack = await request(port, writeMultiPdu(0, [0, 0]));
    assert.equal(ack.readUInt8(7), 16, 'normale FC16-Quittung');
    assert.equal(ack.readUInt16BE(8), 0);
    assert.equal(ack.readUInt16BE(10), 2);
    assert.deepEqual(events, [['setDvLimitW', 0, 'plexlog_holding0_0']]);
    assert.equal(state.ctrl.forcedOff, true);

    // Holding 3 ist der Watchdog (Lebenszeichen), kein Schalten.
    const ack6 = await request(port, writeSinglePdu(3, 0));
    assert.equal(ack6.readUInt8(7), 6, 'normale FC6-Quittung (Echo)');
    assert.deepEqual(events.at(-1), ['watchdog']);
    assert.equal(state.ctrl.forcedOff, true);
  });
  await withServer('luox', async ({ port, events, state }) => {
    assertException04(await request(port, writeSinglePdu(2, 40)), 6, 'im Not-Halt');
    state.ctrl.discretionaryWritesPaused = false;
    const ok = await request(port, writeMultiPdu(2, [0, 1, 2]));
    assert.equal(ok.readUInt8(7), 16);
    assert.deepEqual(events.map((e) => e[0]), ['watchdog', 'setDvLimitPct']);
    assert.equal(state.dvLuox.setpointPct, 0);
  });
});

test('DV-Server ohne Not-Halt: unbekannte Schreib-FC bleiben Ausnahme 0x01 wie bisher', async () => {
  await withServer('plexlog', async ({ port }) => {
    for (const [pdu, fc] of [[writeCoilPdu(0, true), 5], [writeCoilsPdu(0, 8), 15], [maskWritePdu(3), 22], [readWritePdu(), 23]]) {
      const r = await request(port, pdu);
      assert.equal(r.readUInt8(7), (fc | 0x80) & 0xff);
      assert.equal(r.readUInt8(8), 0x01, `FC${fc} ohne Not-Halt: Illegal Function`);
    }
  }, { notHalt: false });
});
