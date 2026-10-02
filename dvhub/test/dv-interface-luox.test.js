import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  dvInterfaceProfile, luoxInputRegisters, luoxHoldingRegisters, luoxApplyWrite, luoxReferencePowerW,
  wordsToU32, createDvLimitController, LUOX_WATCHDOG_MS,
} from '../dv-interface-luox.js';
import { createModbusServer } from '../modbus-server.js';

const i32 = (lo, hi) => (wordsToU32(lo, hi) | 0);

test('Profil: Standard ist Plexlog, nur bekannte Werte gelten', () => {
  assert.equal(dvInterfaceProfile({}), 'plexlog');
  assert.equal(dvInterfaceProfile({ dvInterface: { profile: 'luox' } }), 'luox');
  assert.equal(dvInterfaceProfile({ dvInterface: { profile: 'quatsch' } }), 'plexlog');
});

test('Input-Register nach LUOX-Belegung, 32 Bit niederwertiges Wort zuerst', () => {
  const cfg = { gridPositiveMeans: 'feed_in', userEnergyPricing: { pvPlants: [{ kwp: 30 }, { kwp: 10.5 }] } };
  const regs = luoxInputRegisters({ meter: { grid_total_w: 70123 }, victron: { pvTotalW: 81234.4 } }, cfg);
  assert.equal(regs.length, 7);
  assert.equal(i32(regs[0], regs[1]), 70123, 'Einspeisung positiv');
  assert.equal(wordsToU32(regs[2], regs[3]), 81234, 'Produktion');
  assert.equal(regs[4], 100, 'keine Netzbetreiber-Vorgabe bekannt → 100 %');
  assert.equal(wordsToU32(regs[5], regs[6]), 40500, 'Referenzleistung aus kWp');

  const bezug = luoxInputRegisters({ meter: { grid_total_w: -1500 }, victron: {} }, cfg);
  assert.equal(i32(bezug[0], bezug[1]), -1500, 'Bezug negativ');
  assert.deepEqual(bezug.slice(0, 2), [0xfa24, 0xffff]);

  // Zähler mit „positiv = Bezug": Vorzeichen wird für LUOX umgedreht.
  const umgekehrt = luoxInputRegisters({ meter: { grid_total_w: 800 }, victron: {} }, { gridPositiveMeans: 'grid_import' });
  assert.equal(i32(umgekehrt[0], umgekehrt[1]), -800);
});

test('Referenzleistung: feste Angabe hat Vorrang', () => {
  assert.equal(luoxReferencePowerW({ dvInterface: { luox: { referencePowerW: 39000 } }, userEnergyPricing: { pvPlants: [{ kwp: 40 }] } }), 39000);
  assert.equal(luoxReferencePowerW({}), 0);
});

test('Holding-Register: Vorgabe 0–100, Watchdog über 2 Register, >100 abgelehnt', () => {
  assert.deepEqual(luoxHoldingRegisters({ setpointPct: 60, watchdog: [7, 1] }), [0, 0, 60, 7, 1]);
  assert.deepEqual(luoxApplyWrite({}, 2, [0]), { setpointPct: 0 });
  assert.deepEqual(luoxApplyWrite({}, 2, [101]), { error: 3 });
  assert.deepEqual(luoxApplyWrite({ watchdog: [5, 5] }, 3, [9]), { watchdog: [9, 5] });
  assert.deepEqual(luoxApplyWrite({}, 2, [40, 1, 2]), { setpointPct: 40, watchdog: [1, 2] });
  assert.deepEqual(luoxApplyWrite({}, 0, [1, 1]), {}, 'unbelegte Register ohne Wirkung');
});

function controller({ cfg = {}, applyFails = false } = {}) {
  let t = 1_000_000;
  const calls = [];
  const state = { ctrl: { forcedOff: false, offUntil: 0 } };
  const c = createDvLimitController({
    state,
    getCfg: () => ({ controlWrite: { dvFeedInLimitW: { enabled: true } }, dvInterface: { luox: { referencePowerW: 40000 } }, ...cfg }),
    setForcedOff: (reason, opts) => { calls.push(['off', reason, opts.until]); state.ctrl.forcedOff = true; state.ctrl.offUntil = opts.until; },
    clearForcedOff: (reason) => { calls.push(['on', reason]); state.ctrl.forcedOff = false; },
    applyDvFeedInLimit: async (w) => { calls.push(['limit', w]); if (applyFails && w != null) throw new Error('modbus timeout'); },
    now: () => t,
  });
  return { c, state, calls, advance: (ms) => { t += ms; } };
}

test('Vorgabe 0 % = volle Abregelung bis 15 min nach dem letzten Watchdog', () => {
  const { c, state, calls, advance } = controller();
  c.watchdogRefresh();
  c.setDvLimitPct(0, 'r0');
  assert.deepEqual(calls[0].slice(0, 2), ['off', 'r0']);
  assert.equal(state.ctrl.offUntil, 1_000_000 + LUOX_WATCHDOG_MS);
  advance(10 * 60_000);
  c.watchdogRefresh();
  assert.equal(state.ctrl.offUntil, 1_000_000 + 10 * 60_000 + LUOX_WATCHDOG_MS, 'Watchdog verlängert');
});

test('Teilvorgabe 60 % = Einspeisegrenze 24 kW, 100 % stellt den alten Wert wieder her', async () => {
  const { c, state, calls } = controller();
  const r = c.setDvLimitPct(60, 'r60');
  await r.done;
  assert.equal(r.limitW, 24000);
  assert.deepEqual(calls.at(-1), ['limit', 24000]);
  assert.equal(state.ctrl.dvLimitPct, 60);
  assert.equal(state.ctrl.forcedOff, false);
  c.setDvLimitPct(100, 'r100');
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(calls.at(-1), ['limit', null], 'Restore des gesicherten Werts');
  assert.equal(state.ctrl.dvLimitPct, null);
});

test('von 0 % auf Teilvorgabe: Sperre wird aufgehoben, Grenze gesetzt', async () => {
  const { c, state, calls } = controller();
  c.setDvLimitPct(0, 'r0');
  await c.setDvLimitPct(50, 'r50').done;
  assert.ok(calls.some((x) => x[0] === 'on'));
  assert.equal(state.ctrl.forcedOff, false);
  assert.deepEqual(calls.at(-1), ['limit', 20000]);
});

test('Teilvorgabe ohne Steuerpunkt oder Referenzleistung → sicherheitshalber ganz abregeln', () => {
  const ohnePunkt = controller({ cfg: { controlWrite: {} } });
  assert.equal(ohnePunkt.c.setDvLimitPct(50, 'r').fallback, true);
  assert.equal(ohnePunkt.state.ctrl.forcedOff, true);
  const ohneRef = controller({ cfg: { dvInterface: { luox: { referencePowerW: 0 } } } });
  assert.equal(ohneRef.c.setDvLimitPct(50, 'r').fallback, true);
});

test('Schreibfehler an der Einspeisegrenze → ganz abregeln', async () => {
  const { c, state } = controller({ applyFails: true });
  await c.setDvLimitPct(30, 'r30').done;
  assert.equal(state.ctrl.forcedOff, true);
  assert.equal(state.ctrl.dvLimitPct, null);
});

test('Watchdog abgelaufen → Teilvorgabe zurück auf 100 %', async () => {
  const { c, state, calls, advance } = controller();
  c.watchdogRefresh();
  await c.setDvLimitPct(40, 'r40').done;
  advance(LUOX_WATCHDOG_MS - 1);
  c.expireIfNeeded();
  assert.equal(state.ctrl.dvLimitPct, 40);
  advance(2);
  c.expireIfNeeded();
  await new Promise((res) => setImmediate(res));
  assert.equal(state.ctrl.dvLimitPct, null);
  assert.equal(state.dvLuox.setpointPct, 100);
  assert.deepEqual(calls.at(-1), ['limit', null]);
});

// --- Modbus-TCP-Ende-zu-Ende ------------------------------------------------

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
const readPdu = (fc, addr, qty) => { const b = Buffer.alloc(5); b.writeUInt8(fc, 0); b.writeUInt16BE(addr, 1); b.writeUInt16BE(qty, 3); return b; };
const writeSinglePdu = (addr, v) => { const b = Buffer.alloc(5); b.writeUInt8(6, 0); b.writeUInt16BE(addr, 1); b.writeUInt16BE(v, 3); return b; };
const writeMultiPdu = (addr, values) => {
  const b = Buffer.alloc(6 + values.length * 2);
  b.writeUInt8(16, 0); b.writeUInt16BE(addr, 1); b.writeUInt16BE(values.length, 3); b.writeUInt8(values.length * 2, 5);
  values.forEach((v, i) => b.writeUInt16BE(v, 6 + i * 2));
  return b;
};
const regsOf = (resp) => { const n = resp.readUInt8(8) / 2; return Array.from({ length: n }, (_, i) => resp.readUInt16BE(9 + i * 2)); };

async function withServer(profile, fn) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const events = [];
  const state = {
    dvRegs: { 0: 130, 1: 0, 3: 0, 4: 0 },
    keepalive: {},
    ctrl: { forcedOff: false },
    meter: { grid_total_w: -1500 },
    victron: { pvTotalW: 5000 },
  };
  const cfg = {
    modbusListenHost: '127.0.0.1', modbusListenPort: port, gridPositiveMeans: 'feed_in',
    dvInterface: { profile, luox: { referencePowerW: 40000 } },
  };
  const ctx = {
    state, getCfg: () => cfg, pushLog: (e, d) => events.push([e, d]),
    expireLeaseIfNeeded: () => {},
    setForcedOff: (r) => { events.push(['setForcedOff', r]); state.ctrl.forcedOff = true; },
    clearForcedOff: (r) => { events.push(['clearForcedOff', r]); state.ctrl.forcedOff = false; },
    setDvLimitPct: (p, r) => events.push(['setDvLimitPct', p, r]),
    luoxWatchdogRefresh: () => events.push(['watchdog']),
  };
  const server = createModbusServer(ctx);
  server.start();
  await new Promise((r) => setTimeout(r, 50));
  try { await fn({ port, events, state, cfg }); } finally { server.close(); }
}

test('Modbus: Plexlog bleibt unverändert (ein Registerbereich, Reg 0 = 0000 sperrt)', async () => {
  await withServer('plexlog', async ({ port, events }) => {
    assert.deepEqual(regsOf(await request(port, readPdu(4, 0, 2))), [130, 0]);
    await request(port, writeMultiPdu(0, [0, 0]));
    assert.ok(events.some((e) => e[0] === 'setForcedOff' && e[1] === 'fc16_addr0_0000'));
  });
});

test('Modbus: LUOX liest Input- und Holding-Bereich getrennt', async () => {
  await withServer('luox', async ({ port }) => {
    const input = regsOf(await request(port, readPdu(4, 0, 7)));
    assert.equal(i32(input[0], input[1]), -1500);
    assert.equal(wordsToU32(input[2], input[3]), 5000);
    assert.equal(input[4], 100);
    assert.equal(wordsToU32(input[5], input[6]), 40000);
    // Bisheriger DV-Abruf (FC4 ab 3, 2 Register) bekommt jetzt die LUOX-Werte.
    assert.deepEqual(regsOf(await request(port, readPdu(4, 3, 2))), [input[3], 100]);
    assert.deepEqual(regsOf(await request(port, readPdu(3, 2, 3))), [100, 0, 0]);
  });
});

test('Modbus: LUOX-Schreibvorgänge — Watchdog vor Vorgabe, >100 % abgelehnt', async () => {
  await withServer('luox', async ({ port, events, state }) => {
    await request(port, writeMultiPdu(2, [0, 0x0001, 0x0002]));
    const order = events.filter((e) => e[0] === 'watchdog' || e[0] === 'setDvLimitPct').map((e) => e[0]);
    assert.deepEqual(order, ['watchdog', 'setDvLimitPct']);
    assert.deepEqual(events.find((e) => e[0] === 'setDvLimitPct').slice(1, 2), [0]);
    assert.deepEqual(regsOf(await request(port, readPdu(3, 2, 3))), [0, 1, 2]);

    const rej = await request(port, writeSinglePdu(2, 150));
    assert.equal(rej.readUInt8(7), 0x86, 'Exception auf FC6');
    assert.equal(rej.readUInt8(8), 3);
    assert.equal(state.dvLuox.setpointPct, 0, 'abgelehnter Wert ändert nichts');

    const ok = await request(port, writeSinglePdu(2, 55));
    assert.equal(ok.readUInt8(7), 6);
    assert.deepEqual(events.filter((e) => e[0] === 'setDvLimitPct').at(-1).slice(1, 2), [55]);
    // In LUOX darf ein Schreibvorgang auf Register 3 NICHT mehr sperren (Plexlog-Semantik).
    assert.ok(!events.some((e) => e[0] === 'setForcedOff'));
  });
});
