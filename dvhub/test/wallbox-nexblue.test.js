// Nexblue Edge 2 / Edge Max / Point 2 / Delta (Christin 2026-10-20). Quelle:
// nexblue.com/pages/nexblue-modbus-technical-doc: Unit 200, FC4/FC3/FC16; 32-Bit-
// Werte „full Little-Endian (DCBA)“: Bytes je Register vertauscht, niederwertiges Wort zuerst.
//   IR 100 Zustand (0 Available · 1 Preparing · 2 Charging · 3 SuspendedEVSE · 4 SuspendedEV ·
//          5 Finishing · 7 Unavailable · 8 Faulted) · IR 126 Leistung FLOAT32 W · IR 130 Energie UINT64 Wh
//   HR 1000 Strom FLOAT32 A (0–32; regelmäßig schreiben = Lebenszeichen) · HR 1002 Rückfallstrom FLOAT32
//   (≤ 16 A) · HR 1004 Rückfall-Timeout UINT32 s (30–1800)
import test from 'node:test';
import assert from 'node:assert/strict';

import { createNexblueAdapter, encodeDcba32, decodeDcbaFloat } from '../services/wallbox/nexblue.js';
import { WALLBOX_TYPES } from '../services/wallbox/types.js';

test('DCBA-Kodierung: Float und UInt32 hin und zurück', () => {
  const r = encodeDcba32('float', 10);
  assert.equal(decodeDcbaFloat(r[0], r[1]), 10);
  const b = Buffer.alloc(4); b.writeFloatLE(10);
  assert.deepEqual(r, [b.readUInt16BE(0), b.readUInt16BE(2)]);
  const u = encodeDcba32('uint', 300);
  assert.deepEqual(u, [0x2c01, 0x0000], '300 = 0x0000012C → LE-Bytes 2C 01 00 00');
});

function fakeNexblue(state = 2) {
  const p = encodeDcba32('float', 7300.5);
  const e = Buffer.alloc(8); e.writeBigUInt64LE(123456n);
  const input = { 100: state, 126: p[0], 127: p[1], 130: e.readUInt16BE(0), 131: e.readUInt16BE(2), 132: e.readUInt16BE(4), 133: e.readUInt16BE(6) };
  const writes = [];
  return {
    writes,
    transport: {
      type: 'modbus',
      mbRequest: async ({ unitId, fc, address, quantity }) => {
        assert.equal(unitId, 200); assert.equal(fc, 4);
        return Array.from({ length: quantity }, (_, i) => input[address + i]);
      },
      mbWriteMultiple: async ({ unitId, address, values }) => { assert.equal(unitId, 200); writes.push([address, values]); return {}; },
    },
  };
}
const nb = (b) => createNexblueAdapter(() => ({ host: '192.0.2.90' }), { getTransport: () => b.transport });

test('Typ nexblue wählbar', () => { assert.ok(WALLBOX_TYPES.includes('nexblue')); });

test('Status: Charging, Leistung (Float DCBA), Energie (UInt64 DCBA)', async () => {
  const st = await nb(fakeNexblue()).status();
  assert.deepEqual([st.ok, st.connected, st.charging, st.powerW], [true, true, true, 7301]);
  assert.equal(st.raw.energyWh, 123456);
  assert.equal((await nb(fakeNexblue(0)).status()).connected, false);
  assert.equal((await nb(fakeNexblue(8)).status()).carState, 'error');
});

test('Laden: Timeout 300 s, Rückfall 6 A, Strom; Stopp = Strom 0; Lebenszeichen = Strom erneut beim Status', async () => {
  const b = fakeNexblue();
  const a = nb(b);
  await a.charge(10.5);
  assert.deepEqual(b.writes.map(([ad]) => ad), [1004, 1002, 1000]);
  assert.equal(decodeDcbaFloat(...b.writes[2][1]), 10);
  await a.stop();
  assert.equal(decodeDcbaFloat(...b.writes.at(-1)[1]), 0);
  const n = b.writes.length;
  await a.status();
  assert.equal(b.writes.length, n + 1);
  assert.equal(b.writes.at(-1)[0], 1000, 'Lebenszeichen schreibt den letzten Strom');
});
