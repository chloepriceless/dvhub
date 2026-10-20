// Amperfied (Heidelberg) connect, Elli Gen 2 (VW Charger 2, Cupra/Škoda) — ein
// Registerlayout (Christin 2026-10-20, Wallbox-Liste Punkt 5).
// Quellen: Amperfied „Modbus Register Layout connect series“ (04/2025), Elli
// „Modbus Registerliste v1.0“ (15.10.2025, ab FW R03.004.045.121-elli).
//   FC4: 5 Zustand (2 A1, 3 A2, 4 B1, 5 B2, 6 C1, 7 C2, 8 Derating, 9 E, 10 F, 11 Fehler)
//        6–8 Strom L1–L3 (0,1 A) · 14 Leistung (VA) · 17/18 Energie seit Installation (VAh, hoch/niedrig)
//        100 Hardware-Höchststrom (A)
//   FC3/FC6: 257 Watchdog (ms, 0 = aus) · 261 Höchststrom (0,1 A, 0 = Stopp) · 262 Rückfallstrom (0,1 A)
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHeidelbergAdapter } from '../services/wallbox/heidelberg.js';
import { WALLBOX_TYPES, directWallboxConfigured } from '../services/wallbox/types.js';

function fakeBox(over = {}) {
  const input = { 5: 7, 6: 104, 7: 103, 8: 105, 14: 7130, 17: 0x0001, 18: 0x2345, 100: 16, ...over };
  const writes = [];
  return {
    writes,
    transport: {
      type: 'modbus',
      mbRequest: async ({ fc, address, quantity }) => {
        assert.equal(fc, 4, 'Messwerte sind Input-Register');
        return Array.from({ length: quantity }, (_, i) => {
          if (!((address + i) in input)) throw new Error('modbus exception 2');
          return input[address + i];
        });
      },
      mbWriteSingle: async ({ address, value }) => { writes.push([address, value]); return { addr: address, value }; },
    },
  };
}
let t = 5_000_000;
const box = (b, s = {}) => createHeidelbergAdapter(() => ({ host: '192.0.2.40', ...s }), { getTransport: () => b.transport, now: () => t });

test('Typ heidelberg wählbar', () => {
  assert.ok(WALLBOX_TYPES.includes('heidelberg'));
  assert.equal(directWallboxConfigured({ wallbox: { type: 'heidelberg', heidelberg: { host: 'x' } } }), true);
});

test('Status: C2 = lädt, Leistung, Strom, Energie aus zwei Registern', async () => {
  const st = await box(fakeBox()).status();
  assert.deepEqual([st.ok, st.connected, st.charging, st.powerW, st.currentA], [true, true, true, 7130, 10.5]);
  assert.equal(st.raw.energyWh, 0x12345);
  const a1 = await box(fakeBox({ 5: 2 })).status();
  assert.deepEqual([a1.connected, a1.charging], [false, false]);
  assert.equal((await box(fakeBox({ 5: 9 })).status()).carState, 'error');
  assert.equal((await box(fakeBox({ 5: 5 })).status()).carState, 'waiting');
});

test('Laden: Watchdog 60 s + Rückfall 6 A, Strom in 0,1 A (höchstens Hardware); Stopp = 0; nur bei Änderung', async () => {
  const b = fakeBox();
  const a = box(b);
  assert.equal((await a.charge(20)).ok, true);
  assert.deepEqual(b.writes, [[262, 60], [257, 60000], [261, 160]]);
  t += 15_000;
  await a.charge(16);
  assert.equal(b.writes.length, 3, 'unverändert');
  await a.stop();
  assert.deepEqual(b.writes.at(-1), [261, 0]);
});

test('Freigeben: Watchdog aus, Strom auf Hardware-Höchstwert', async () => {
  const b = fakeBox();
  await box(b).release();
  assert.deepEqual(b.writes, [[257, 0], [261, 160]]);
});
