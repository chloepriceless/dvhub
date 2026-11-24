// test/dv-plexlog-lease.test.js — Lease des Direktvermarkters nach der echten Schreibfolge aus Prod
// (control_events, Replay 24.11.2026):
//   Aus: FC16 Holding 0 [0,0], 10 ms später Holding 3 [1], alle 240 s wiederholt.
//   Ein: Holding 0 [255,255] zusammen mit Holding 3 [0].
// Fehler vorher: die Lease lief ab dem letzten Holding-3-Schreiben. Beim ersten „Aus“ einer Abregelung lag das
// Stunden zurück (das letzte „Ein“), die Lease war schon abgelaufen; der Holding-3-Frame 10 ms später ließ sie vor
// dem Auswerten verfallen, und erst die Wiederholung nach 4 min griff (101 von 115 Abregelungen, 6,75 h).
// Jetzt: ein gesetzter Sollwert gilt ab JETZT 15 min; jedes Schreiben auf Holding 0 oder 3 ist ein Lebenszeichen.
//
// Echter Modbus-Server über TCP, echter createDvLimitController; setForcedOff/clearForcedOff/expireLeaseIfNeeded
// verhalten sich wie in server.js (Frist monoton gestempelt, vor jedem Frame Ablauf prüfen).

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createDvLimitController, ctrlDeadlinePassed, LUOX_WATCHDOG_MS } from '../dv-interface-luox.js';
import { createModbusServer } from '../modbus-server.js';
import { stampMono } from '../services/mono-clock.js';

const MIN = 60_000;
const H = 60 * MIN;

function request(port, pdu, unit = 1) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const mbap = Buffer.alloc(7);
    mbap.writeUInt16BE(0x1234, 0);
    mbap.writeUInt16BE(0, 2);
    mbap.writeUInt16BE(pdu.length + 1, 4);
    mbap.writeUInt8(unit, 6);
    sock.on('connect', () => sock.write(Buffer.concat([mbap, pdu])));
    sock.once('data', (d) => { sock.destroy(); resolve(d); });
    sock.on('error', reject);
  });
}
const writeMultiPdu = (addr, values) => {
  const b = Buffer.alloc(6 + values.length * 2);
  b.writeUInt8(16, 0); b.writeUInt16BE(addr, 1); b.writeUInt16BE(values.length, 3); b.writeUInt8(values.length * 2, 5);
  values.forEach((v, i) => b.writeUInt16BE(v, 6 + i * 2));
  return b;
};

async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

async function withRig(profile, fn) {
  const port = await freePort();
  let t = Date.parse('2026-10-25T07:15:06Z');
  const clock = () => t;
  const log = [];
  const state = {
    systemWarnings: [], keepalive: {}, dvRegs: { 0: 0, 1: 0, 3: 0, 4: 0 },
    ctrl: { forcedOff: false, offUntil: 0 }, meter: { grid_total_w: -2000 }, victron: { pvTotalW: 20000 },
  };
  const cfg = {
    modbusListenHost: '127.0.0.1', modbusListenPort: port, gridPositiveMeans: 'feed_in', offLeaseMs: 8 * MIN,
    dvInterface: { profile }, userEnergyPricing: { pvPlants: [{ kwp: 29.7 }] },
    controlWrite: { dvFeedInLimitW: { enabled: true } },
  };
  // wie server.js setForcedOff/clearForcedOff (Frist monoton gestempelt, stampLease)
  function setForcedOff(reason, { until } = {}) {
    state.ctrl.forcedOff = true;
    state.ctrl.offUntil = Number.isFinite(until) ? until : t + cfg.offLeaseMs;
    stampMono(state.ctrl, 'offUntil', { clock, wallNow: t });
    state.ctrl.lastSignal = reason;
    log.push(['off', reason, t]);
  }
  function clearForcedOff(reason) {
    state.ctrl.forcedOff = false;
    state.ctrl.offUntil = 0;
    state.ctrl.lastSignal = reason;
    log.push(['on', reason, t]);
  }
  const dvLimit = createDvLimitController({
    state, getCfg: () => cfg, setForcedOff, clearForcedOff, applyDvFeedInLimit: async () => {}, now: clock,
  });
  // wie server.js expireLeaseIfNeeded
  function expireLeaseIfNeeded() {
    if (state.ctrl.forcedOff && ctrlDeadlinePassed(state.ctrl, 'offUntil', t, clock)) {
      state.ctrl.forcedOff = false;
      state.ctrl.offUntil = 0;
      state.ctrl.lastSignal = 'lease_expired';
      log.push(['lease_expired', t]);
      if (state.dvLuox) state.dvLuox.setpointPct = 100;
    }
    dvLimit.expireIfNeeded();
  }
  const server = createModbusServer({
    state, getCfg: () => cfg, pushLog: () => {},
    expireLeaseIfNeeded, setForcedOff, clearForcedOff,
    setDvLimitPct: dvLimit.setDvLimitPct, setDvLimitW: dvLimit.setDvLimitW, luoxWatchdogRefresh: dvLimit.watchdogRefresh,
  });
  server.start();
  await new Promise((r) => setTimeout(r, 50));
  const write = (addr, values) => request(port, writeMultiPdu(addr, values));
  // Zeit vorrücken und dabei wie der Regeltakt (controlValue) alle 2 s den Ablauf prüfen; zählt die Zeit,
  // in der DVhub NICHT abgeregelt hatte.
  async function advance(ms, { step = 2000 } = {}) {
    let onMs = 0;
    for (let done = 0; done < ms;) {
      const d = Math.min(step, ms - done);
      t += d; done += d;
      expireLeaseIfNeeded();
      if (!state.ctrl.forcedOff) onMs += d;
    }
    return onMs;
  }
  try {
    await fn({ write, advance, state, log, now: () => t });
  } finally {
    server.close();
  }
}

test('Plexlog: erstes „Aus“ Stunden nach dem letzten „Ein“ greift sofort (Holding 0 [0,0], 10 ms später Holding 3 [1])', async () => {
  await withRig('plexlog', async ({ write, advance, state, log, now }) => {
    // Ende der letzten Abregelung: Ein-Befehl
    await write(0, [255, 255]);
    await write(3, [0]);
    assert.equal(state.ctrl.forcedOff, false);
    await advance(3 * H, { step: 60_000 });
    // negativer Preis: der DV schaltet ab
    await write(0, [0, 0]);
    assert.equal(state.ctrl.forcedOff, true, 'Holding 0 [0,0] schaltet ab');
    assert.ok(state.ctrl.offUntil >= now() + LUOX_WATCHDOG_MS - 1, 'Lease läuft ab JETZT 15 min');
    await advance(10, { step: 10 });
    await write(3, [1]);
    assert.equal(state.ctrl.forcedOff, true, 'der Holding-3-Frame 10 ms später lässt die Abregelung nicht verfallen');
    assert.ok(!log.some((e) => e[0] === 'lease_expired'), 'kein lease_expired beim ersten Aus');
    // bis zur Wiederholung nach 240 s durchgehend abgeregelt
    const lostMs = await advance(240_000 - 10);
    assert.equal(lostMs, 0, 'keine Einspeisung bis zur Wiederholung');
    await write(0, [0, 0]);
    await advance(10, { step: 10 });
    await write(3, [1]);
    assert.equal(state.ctrl.forcedOff, true);
    // Ein-Befehl hebt die Abregelung auf
    await advance(60_000);
    await write(0, [255, 255]);
    await write(3, [0]);
    assert.equal(state.ctrl.forcedOff, false);
  });
});

test('Plexlog: ein DV, der nur Holding 0 schreibt, hält die Abregelung; ohne Schreiben endet sie 15 min danach', async () => {
  await withRig('plexlog', async ({ write, advance, state, log }) => {
    await write(0, [255, 255]);
    await write(3, [0]);
    await advance(3 * H, { step: 60_000 });
    let lostMs = 0;
    for (let i = 0; i < 15; i++) { // 1 h lang alle 4 min nur Holding 0 [0,0]
      await write(0, [0, 0]);
      assert.equal(state.ctrl.forcedOff, true, `Aus-Befehl ${i + 1} greift`);
      lostMs += await advance(240_000);
    }
    assert.equal(lostMs, 0, 'Holding 0 allein frischt die Lease auf');
    assert.ok(!log.some((e) => e[0] === 'lease_expired'));
    // DV verstummt: letzte Vorgabe war vor 4 min, Lease endet 15 min nach dem letzten Schreiben
    await advance(LUOX_WATCHDOG_MS - 240_000 - 2000);
    assert.equal(state.ctrl.forcedOff, true, 'kurz vor Ablauf noch abgeregelt');
    await advance(4000);
    assert.equal(state.ctrl.forcedOff, false, '15 min ohne Lebenszeichen → wieder frei');
  });
});

test('Plexlog: Holding 3 allein (Watchdog) verlängert eine bestehende Abregelung', async () => {
  await withRig('plexlog', async ({ write, advance, state }) => {
    await write(0, [0, 0]);
    let lostMs = 0;
    for (let i = 0; i < 6; i++) { await write(3, [1]); lostMs += await advance(10 * MIN); }
    assert.equal(lostMs, 0);
    assert.equal(state.ctrl.forcedOff, true);
  });
});

test('LUOX-Profil: Sollwert 0 % Stunden nach dem letzten Watchdog, Watchdog-Frame 10 ms später → bleibt abgeregelt', async () => {
  await withRig('luox', async ({ write, advance, state, log, now }) => {
    await write(3, [1, 0]);
    await write(2, [100]);
    await advance(3 * H, { step: 60_000 });
    await write(2, [0]);
    assert.equal(state.ctrl.forcedOff, true);
    assert.ok(state.ctrl.offUntil >= now() + LUOX_WATCHDOG_MS - 1, 'Vorgabe gilt ab JETZT 15 min');
    await advance(10, { step: 10 });
    await write(3, [2, 0]);
    assert.equal(state.ctrl.forcedOff, true);
    assert.ok(!log.some((e) => e[0] === 'lease_expired'));
    assert.equal(await advance(10 * MIN), 0);
  });
});
