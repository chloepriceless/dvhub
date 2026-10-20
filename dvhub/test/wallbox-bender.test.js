// Bender-Laderegler CC612/613/ICC (Christin 2026-10-20, Wallbox-Liste Punkt 5):
// steckt in Mennekes AMTRON Professional/AMEDIO, SMA EV Charger Business, Webasto
// Live, Optec, Ebee, CUBOS, Ensto. Quelle: bender.de/docs/charge-controller/APIs/Modbus-API
// (Registersatz „OMCCI“ in der Weboberfläche wählen; Holding-Register, 32-Bit-Werte
// hohes Wort zuerst, 0xFFFFFFFF = nicht verfügbar):
//   122 Fahrzeugzustand (A=1 B=2 C=3 D=4 E=5) · 212–217 Strom L1–L3 (mA)
//   218/219 Energie gesamt (Wh) · 220/221 Leistung gesamt (W) · 706 signalisierter Strom
//   1000 HEMS-Stromgrenze (A, 0 = Pause) · 131 Strom bei Kommunikationsausfall · 132 Timeout (s)
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBenderAdapter } from '../services/wallbox/bender.js';
import { WALLBOX_TYPES, directWallboxConfigured } from '../services/wallbox/types.js';

function fakeBender(over = {}) {
  const r = { 122: 3, 212: 0, 213: 10200, 214: 0, 215: 10100, 216: 0, 217: 10300, 218: 0, 219: 54321, 220: 0, 221: 7050, 706: 10, ...over };
  const writes = [];
  return {
    writes,
    transport: {
      type: 'modbus',
      mbRequest: async ({ fc, address, quantity }) => {
        assert.equal(fc, 3);
        return Array.from({ length: quantity }, (_, i) => { if (!((address + i) in r)) throw new Error('modbus exception 2'); return r[address + i]; });
      },
      mbWriteSingle: async ({ address, value }) => { writes.push([address, value]); return { addr: address, value }; },
    },
  };
}
let t = 9_000_000;
const bender = (b, s = {}) => createBenderAdapter(() => ({ host: '192.0.2.50', ...s }), { getTransport: () => b.transport, now: () => t });

test('Typ bender wählbar', () => {
  assert.ok(WALLBOX_TYPES.includes('bender'));
  assert.equal(directWallboxConfigured({ wallbox: { type: 'bender', bender: { host: 'x' } } }), true);
});

test('Status: C = lädt, Leistung/Energie/Strom', async () => {
  const st = await bender(fakeBender()).status();
  assert.deepEqual([st.ok, st.connected, st.charging, st.powerW, st.currentA], [true, true, true, 7050, 10.3]);
  assert.equal(st.raw.energyWh, 54321);
  assert.deepEqual([(await bender(fakeBender({ 122: 1 })).status()).connected], [false]);
  assert.equal((await bender(fakeBender({ 122: 5 })).status()).carState, 'error');
  const na = await bender(fakeBender({ 220: 0xffff, 221: 0xffff })).status();
  assert.equal(na.powerW, null, '0xFFFFFFFF = nicht verfügbar');
});

test('Laden: Rückfall 6 A / 300 s, dann Grenze in A; Stopp = 0; Freigeben = 32 A und Rückfall 32 A', async () => {
  const b = fakeBender();
  const a = bender(b);
  await a.charge(10.9);
  assert.deepEqual(b.writes, [[131, 6], [132, 300], [1000, 10]]);
  t += 15_000;
  await a.charge(10.2);
  assert.equal(b.writes.length, 3, 'unverändert → nichts schreiben');
  await a.stop();
  assert.deepEqual(b.writes.at(-1), [1000, 0]);
  await a.release();
  assert.deepEqual(b.writes.slice(-2), [[131, 32], [1000, 32]]);
});
