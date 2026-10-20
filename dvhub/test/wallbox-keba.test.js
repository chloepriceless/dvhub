// KEBA KeContact P30/P40 (Christin 2026-10-20, Wallbox-Liste Punkt 5).
// Quelle: KEBA „KeContact P30 Modbus TCP Programmers Guide“ V1.07: Unit 255,
// FC3 lesen (je Register UINT32 = 2 Wörter, einzeln), FC6 schreiben (UINT16);
// höchstens alle 5 s schreiben. P30: DIP DSW1.3 = ON; P40: Modbus in der App an.
//   1000 Zustand (0 Start · 1 nicht bereit · 2 bereit · 3 lädt · 4 Fehler · 5 unterbrochen)
//   1004 Kabel (5/7 = mit Auto verbunden) · 1020 Leistung (mW) · 1036 Energie (0,1 Wh)
//   1110 Hardware-Höchststrom (mA)
//   5004 Strom (mA) · 5014 Freigabe 0/1 · 5016 Failsafe-Strom (mA) · 5018 Failsafe-Zeit (s, 0 = aus)
import test from 'node:test';
import assert from 'node:assert/strict';

import { createKebaAdapter } from '../services/wallbox/keba.js';
import { WALLBOX_TYPES, directWallboxConfigured } from '../services/wallbox/types.js';
import { WALLBOX_LABELS } from '../services/wallbox/main-wallbox.js';

function fakeKeba(over = {}) {
  const u32 = { 1000: 3, 1004: 7, 1020: 7_245_000, 1036: 1_234_567, 1110: 32000, ...over };
  const writes = [];
  return {
    writes,
    transport: {
      type: 'modbus',
      mbRequest: async ({ unitId, fc, address, quantity }) => {
        assert.equal(unitId, 255); assert.equal(fc, 3); assert.equal(quantity, 2, 'KEBA: einzeln, 2 Wörter');
        if (!(address in u32)) throw new Error('modbus exception 2');
        const v = u32[address];
        return [Math.floor(v / 0x10000), v & 0xffff];
      },
      mbWriteSingle: async ({ unitId, address, value }) => { assert.equal(unitId, 255); writes.push([address, value]); return { addr: address, value }; },
    },
  };
}
let t = 1_000_000;
const keba = (box, s = {}) => createKebaAdapter(() => ({ host: '192.0.2.30', model: 'p30', ...s }), { getTransport: () => box.transport, now: () => t });

test('Typ keba wählbar', () => {
  assert.ok(WALLBOX_TYPES.includes('keba'));
  assert.equal(WALLBOX_LABELS.keba, 'KEBA KeContact');
  assert.equal(directWallboxConfigured({ wallbox: { type: 'keba', keba: { host: '192.0.2.30' } } }), true);
});

test('Status: lädt, Auto verbunden, Leistung W, Energie Wh', async () => {
  const st = await keba(fakeKeba()).status();
  assert.deepEqual([st.ok, st.connected, st.charging, st.powerW], [true, true, true, 7245]);
  assert.equal(st.raw.energyWh, 123456.7);
  const idle = await keba(fakeKeba({ 1000: 1, 1004: 0 })).status();
  assert.deepEqual([idle.connected, idle.charging], [false, false]);
  assert.equal((await keba(fakeKeba({ 1000: 4 })).status()).carState, 'error');
});

test('P30 Laden: Failsafe (6 A, 300 s), Strom mA, Freigabe; gleiche Werte nicht erneut schreiben', async () => {
  const box = fakeKeba();
  const a = keba(box);
  assert.equal((await a.charge(10.6)).ok, true);
  assert.deepEqual(box.writes, [[5016, 6000], [5018, 300], [5004, 10000], [5014, 1]]);
  t += 15_000;
  await a.charge(10.2);
  assert.equal(box.writes.length, 4, 'nichts geändert → nichts geschrieben (KEBA: höchstens alle 5 s)');
  t += 15_000;
  await a.charge(16);
  assert.deepEqual(box.writes.slice(4), [[5004, 16000]]);
  t += 15_000;
  await a.stop();
  assert.deepEqual(box.writes.at(-1), [5014, 0]);
});

test('P40 Stopp = Strom 0 (5014 erst mit späterer Software); Freigeben = Failsafe aus, Höchststrom', async () => {
  const box = fakeKeba();
  const a = keba(box, { model: 'p40' });
  await a.stop();
  assert.deepEqual(box.writes.at(-1), [5004, 0]);
  t += 15_000;
  await a.release();
  assert.deepEqual(box.writes.slice(-2), [[5018, 0], [5004, 32000]]);
});
