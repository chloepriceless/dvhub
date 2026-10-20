// Phoenix Contact EV Charge Control (EV-CC-AC1-M3-…; auch in Wallbe, Compleo Pro, E3/DC
// Easy Connect, ESL Walli) (Christin 2026-10-20). Quelle: Anwenderhandbuch 108191_de_04
// (2020-09-17), Kap. 9: Unit 255, Port 502; 32-Bit-Werte niederwertiges Wort zuerst.
//   Input 100 Zustand IEC 61851 als ASCII (A–F) · 101 Kabel-Stromtragfähigkeit (A) ·
//   104 DIP-Schalter (DIP 1 = Bit 0) · 107 Fehlerbits · 114/116/118 Strom I1–I3 (A, 32 Bit) ·
//   120 Wirkleistung (W, 32 Bit) · Holding 904 Energiezähler (Wh, 32 Bit) ·
//   Holding 528 Vorgabe Ladestrom (A) · Coil 400 Ladevorgang freigeben (nur bei DIP 10 = 1)
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPhoenixAdapter } from '../services/wallbox/phoenix.js';
import { WALLBOX_TYPES } from '../services/wallbox/types.js';

function fakePhoenix({ state = 'C', dip10 = true } = {}) {
  const input = { 100: state.charCodeAt(0), 101: 32, 104: dip10 ? 1 << 9 : 0, 107: 0, 114: 16, 115: 0, 116: 15, 117: 0, 118: 16, 119: 0, 120: 11040 & 0xffff, 121: 11040 >>> 16 };
  const holding = { 904: 123456 & 0xffff, 905: 123456 >>> 16 };
  const writes = [];
  let t = 0;
  return {
    writes, input,
    clock: { now: () => t, advance: (ms) => { t += ms; } },
    transport: {
      type: 'modbus',
      mbRequest: async ({ unitId, fc, address, quantity }) => {
        assert.equal(unitId, 255);
        const src = fc === 4 ? input : holding;
        return Array.from({ length: quantity }, (_, i) => src[address + i] ?? 0);
      },
      mbWriteSingle: async ({ address, value }) => { writes.push(['hr', address, value]); return {}; },
      mbWriteCoil: async ({ address, value }) => { writes.push(['coil', address, value]); return {}; },
    },
  };
}
const px = (b) => createPhoenixAdapter(() => ({ host: '192.0.2.92' }), { getTransport: () => b.transport, now: b.clock.now });

test('Typ phoenix wählbar', () => { assert.ok(WALLBOX_TYPES.includes('phoenix')); });

test('Status: C = lädt, Leistung 32 Bit (Low-Wort zuerst), Energie Wh, Strom max. Phase', async () => {
  const st = await px(fakePhoenix()).status();
  assert.deepEqual([st.ok, st.connected, st.charging, st.powerW, st.currentA], [true, true, true, 11040, 16]);
  assert.equal(st.raw.energyWh, 123456);
  assert.deepEqual(await px(fakePhoenix({ state: 'A' })).status().then((s) => [s.connected, s.charging]), [false, false]);
  assert.equal((await px(fakePhoenix({ state: 'F' })).status()).carState, 'error');
  const hi = fakePhoenix(); hi.input[100] = 'B'.charCodeAt(0) << 8; // ASCII im oberen Byte
  assert.equal((await px(hi).status()).carState, 'waiting');
});

test('Laden: Vorgabe 528 (A) + Coil 400 ein; Stopp: Coil aus; Freigeben: Kabelgrenze + Coil ein; ohne Änderung kein Neuschreiben', async () => {
  const b = fakePhoenix();
  const a = px(b);
  await a.charge(10.8);
  assert.deepEqual(b.writes, [['hr', 528, 10], ['coil', 400, true]]);
  await a.charge(10);
  assert.equal(b.writes.length, 2);
  await a.stop();
  assert.deepEqual(b.writes.at(-1), ['coil', 400, false]);
  await a.release();
  assert.deepEqual(b.writes.slice(-2), [['hr', 528, 32], ['coil', 400, true]]);
});

test('DIP 10 aus → klare Meldung statt wirkungslosem Schreiben', async () => {
  const b = fakePhoenix({ dip10: false });
  const r = await px(b).charge(10);
  assert.equal(r.ok, false);
  assert.match(r.error, /DIP 10/);
  assert.equal(b.writes.length, 0);
});
