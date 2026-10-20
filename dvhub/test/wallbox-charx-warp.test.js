// Wallbox-Liste Punkt 4 (Christin 2026-10-20): Phoenix Contact CHARX und
// TinkerForge WARP — beide mit offener Hersteller-Dokumentation.
//
// CHARX SEC-3xxx (Handbuch 109999_en_04, Anhang B 3): Modbus TCP, Unit 1,
// Port 502; Register je Ladepunkt x000…x999 (x = Nummer des Ladepunkts):
//   x101 Höchststrom laut Konfiguration (A) · x244/245 Wirkleistung (mW, MSW zuerst)
//   x250…x253 Energie (Wh) · x297 aktueller Ladestrom (A) · x299 Status (ASCII „C2“)
//   x300 Ladefreigabe (Freigabemodus „Modbus“) · x301 Höchststrom (6–80 A)
//   x306 Strom bei abgelaufenem Watchdog · x307 Watchdog (s, 65535 = aus)
// WARP (docs.warp-charger.com, HTTP-API): evse/state (charger_state 0–4),
//   evse/external_enabled, evse/external_current (mA, 0 = gesperrt), meter/values.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createCharxAdapter } from '../services/wallbox/charx.js';
import { createWarpAdapter } from '../services/wallbox/warp.js';
import { WALLBOX_TYPES, directWallboxConfigured } from '../services/wallbox/types.js';
import { WALLBOX_LABELS } from '../services/wallbox/main-wallbox.js';

test('Typen charx und warp wählbar und mit Adresse eingerichtet', () => {
  assert.ok(WALLBOX_TYPES.includes('charx'));
  assert.ok(WALLBOX_TYPES.includes('warp'));
  assert.equal(WALLBOX_LABELS.charx, 'Phoenix Contact CHARX');
  assert.equal(WALLBOX_LABELS.warp, 'TinkerForge WARP');
  assert.equal(directWallboxConfigured({ wallbox: { type: 'charx', charx: { host: '192.0.2.1' } } }), true);
  assert.equal(directWallboxConfigured({ wallbox: { type: 'warp', warp: { host: '' } } }), false);
});

// ── CHARX ──
const ascii = (s) => (s.charCodeAt(0) << 8) | s.charCodeAt(1);
function fakeCharx(cp = 1, over = {}) {
  const b = cp * 1000;
  const r = {
    [b + 101]: 16, [b + 244]: 0, [b + 245]: 7360 * 1000 & 0xffff, [b + 297]: 10, [b + 299]: ascii('C2'),
    [b + 300]: 1, [b + 301]: 10, [b + 306]: 6, [b + 307]: 65535, ...over,
  };
  // 7 360 000 mW = 0x0070 4E80 → MSW 0x70, LSW 0x4E80
  r[b + 244] = 0x70; r[b + 245] = 0x4e80;
  r[b + 250] = 0; r[b + 251] = 0; r[b + 252] = 0; r[b + 253] = 123456;
  Object.assign(r, over);
  const writes = [];
  return {
    regs: r, writes,
    transport: {
      type: 'modbus',
      mbRequest: async ({ unitId, address, quantity, fc }) => {
        assert.equal(unitId, 1); assert.ok(fc === 3 || fc === 4);
        return Array.from({ length: quantity }, (_, i) => {
          if (!((address + i) in r)) throw new Error('modbus exception 2');
          return r[address + i];
        });
      },
      mbWriteSingle: async ({ unitId, address, value }) => { assert.equal(unitId, 1); writes.push([address, value]); r[address] = value; return { addr: address, value }; },
    },
  };
}
const charx = (box, s = {}) => createCharxAdapter(() => ({ host: '192.0.2.1', chargePoint: 1, ...s }), { getTransport: () => box.transport });

test('CHARX: Status aus x299/x244/x250/x297', async () => {
  const st = await charx(fakeCharx()).status();
  assert.equal(st.ok, true);
  assert.equal(st.connected, true);
  assert.equal(st.charging, true);
  assert.equal(st.powerW, 7360);
  assert.equal(st.currentA, 10);
  assert.equal(st.raw.iecState, 'C2');
  assert.equal(st.raw.energyWh, 123456);
  const a1 = await charx(fakeCharx(1, { 1299: ascii('A1') })).status();
  assert.deepEqual([a1.connected, a1.charging], [false, false]);
  const f0 = await charx(fakeCharx(1, { 1299: ascii('F0') })).status();
  assert.equal(f0.carState, 'error');
});

test('CHARX: Laden = Watchdog (Rückfall 6 A, 300 s), Strom (höchstens x101), Freigabe; Stopp = Freigabe 0', async () => {
  const box = fakeCharx();
  assert.equal((await charx(box).charge(20)).ok, true);
  assert.deepEqual(box.writes, [[1306, 6], [1307, 300], [1301, 16], [1300, 1]]);
  box.writes.length = 0;
  await charx(box).charge(3.7);
  assert.deepEqual(box.writes.slice(-2), [[1301, 6], [1300, 1]]);
  box.writes.length = 0;
  assert.equal((await charx(box).stop()).ok, true);
  assert.deepEqual(box.writes.slice(-1), [[1300, 0]]);
});

test('CHARX: Freigeben = Watchdog aus, Höchststrom zurück, Freigabe an; Ladepunkt 2 → 2xxx', async () => {
  const box = fakeCharx();
  await charx(box).release();
  assert.deepEqual(box.writes, [[1307, 65535], [1301, 16], [1300, 1]]);
  const b2 = fakeCharx(2);
  await charx(b2, { chargePoint: 2 }).stop();
  assert.deepEqual(b2.writes.at(-1), [2300, 0]);
});

// ── WARP ──
function fakeWarp(over = {}) {
  const state = {
    'evse/state': { iec61851_state: 2, charger_state: 3, allowed_charging_current: 16000, error_state: 0 },
    'evse/external_enabled': { enabled: false },
    'evse/external_current': { current: 32000 },
    'meter/values': { power: 3680.5, energy_rel: 2.1, energy_abs: 1234.5 },
    ...over,
  };
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const key = req.url.replace(/^\//, '');
      if (req.method === 'POST') {
        posts.push([key, JSON.parse(body)]);
        res.writeHead(200); return res.end();
      }
      if (!(key in state)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state[key]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, posts, host: `127.0.0.1:${server.address().port}` })));
}

test('WARP: Status aus evse/state und meter/values', async () => {
  const box = await fakeWarp();
  try {
    const st = await createWarpAdapter(() => ({ host: box.host })).status();
    assert.deepEqual([st.ok, st.connected, st.charging, st.powerW, st.currentA], [true, true, true, 3681, 16]);
  } finally { box.server.close(); }
});

test('WARP: Laden schaltet externe Steuerung an und setzt mA; Stopp = 0; Freigeben schaltet sie aus', async () => {
  const box = await fakeWarp();
  try {
    const a = createWarpAdapter(() => ({ host: box.host }));
    assert.equal((await a.charge(10.6)).ok, true);
    assert.equal((await a.stop()).ok, true);
    assert.equal((await a.release()).ok, true);
    assert.deepEqual(box.posts, [
      ['evse/external_enabled', { enabled: true }],
      ['evse/external_current', { current: 10000 }],
      ['evse/external_current', { current: 0 }],
      ['evse/external_enabled', { enabled: false }],
    ]);
  } finally { box.server.close(); }
});
