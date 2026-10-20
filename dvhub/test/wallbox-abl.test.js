// ABL eM4 Single/Twin (Christin 2026-10-20). Quelle: ABL „Schnittstellenbeschreibung
// Modbus TCP Wallbox eM4 Controller/Extender“ R01 (19.12.2023): Unit 0xFF, FC3 lesen,
// FC16 schreiben, mehrregistrige Werte big endian. Standalone: Produkt 0x01xx,
// Outlet links/einzeln 0x30xx, rechts (Twin) 0x31xx:
//   0x0124 Idefault (0,1 A) · Outlet +0x01 Strom 3×uint32 (0,1 A) · +0x0D Leistung uint32 (W)
//   +0x0F Energie uint32 (0,01 kWh) · +0x31 Status (A1 wartet · B0–B3 EV erkannt · C2 lädt · Fx Fehler)
//   +0x32 Icmax (0,1 A; 0 = keine Ladung) — kein Watchdog dokumentiert
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAblAdapter } from '../services/wallbox/abl.js';
import { WALLBOX_TYPES } from '../services/wallbox/types.js';

function fakeAbl(base = 0x3000, over = {}) {
  const r = { 0x0124: 160 };
  [0, 104, 0, 101, 0, 99].forEach((v, i) => { r[base + 1 + i] = v; });
  r[base + 0x0d] = 0; r[base + 0x0e] = 6950;
  r[base + 0x0f] = 0; r[base + 0x10] = 123456;
  r[base + 0x31] = 0xc2;
  Object.assign(r, over);
  const writes = [];
  return {
    writes,
    transport: {
      type: 'modbus',
      mbRequest: async ({ unitId, fc, address, quantity }) => {
        assert.equal(unitId, 255); assert.equal(fc, 3);
        return Array.from({ length: quantity }, (_, i) => { if (!((address + i) in r)) throw new Error('modbus exception 2'); return r[address + i]; });
      },
      mbWriteMultiple: async ({ unitId, address, values }) => { assert.equal(unitId, 255); writes.push([address, values]); return { addr: address, quantity: values.length }; },
    },
  };
}
const abl = (b, s = {}) => createAblAdapter(() => ({ host: '192.0.2.80', ...s }), { getTransport: () => b.transport });

test('Typ abl wählbar', () => { assert.ok(WALLBOX_TYPES.includes('abl')); });

test('Status: C2 lädt, Leistung, Strom, Energie in Wh', async () => {
  const st = await abl(fakeAbl()).status();
  assert.deepEqual([st.ok, st.connected, st.charging, st.powerW, st.currentA], [true, true, true, 6950, 10.4]);
  assert.equal(st.raw.energyWh, 1234560);
  assert.deepEqual([(await abl(fakeAbl(0x3000, { 0x3031: 0xa1 })).status()).connected], [false]);
  assert.equal((await abl(fakeAbl(0x3000, { 0x3031: 0xf3 })).status()).carState, 'error');
});

test('Laden: Icmax in 0,1 A (höchstens Idefault) per FC16; Stopp 0; Freigeben = Idefault; Twin rechts = 0x31xx', async () => {
  const b = fakeAbl();
  await abl(b).charge(20);
  await abl(b).charge(10.6);
  await abl(b).stop();
  await abl(b).release();
  assert.deepEqual(b.writes, [[0x3032, [160]], [0x3032, [100]], [0x3032, [0]], [0x3032, [160]]]);
  const r = fakeAbl(0x3100);
  await abl(r, { outlet: 2 }).stop();
  assert.deepEqual(r.writes, [[0x3132, [0]]]);
});
