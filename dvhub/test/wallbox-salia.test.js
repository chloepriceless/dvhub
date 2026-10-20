// Hardy Barth Salia cPH2/cPμ2 (Christin 2026-10-20, Wallbox-Liste Punkt 5).
// Quelle: docs.echarge.de/modbus-tcp/documentation (MapVersion 2.1.0): Unit 1,
// PDU-Adressen 0-basiert (Doku „30001“ = Input 0, „40107“ = Holding 106).
//   FC4 0 Zustand (0 nicht bereit · 1 bereit · 2 lädt · 3 unterbrochen · 4 Fehler · 7 Phasenwechsel)
//       1014/1015 Leistung (Float32, W, hohes Wort zuerst) · 1022/1023 Energie (Float32, kWh)
//   FC6 106 Modus (2 = MANUAL; danach Strom neu schreiben) · 201 Strom (A) · 202 Start 1/Stopp 0
//       203 Failsafe-Timeout (s, 0 = aus) · 205 Failsafe-Strom (A) · 207 Lebenszeichen (≤ Timeout/2)
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSaliaAdapter } from '../services/wallbox/salia.js';
import { WALLBOX_TYPES } from '../services/wallbox/types.js';

const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return [b.readUInt16BE(0), b.readUInt16BE(2)]; };
function fakeSalia(over = {}) {
  const [p0, p1] = f32(7123.4);
  const [e0, e1] = f32(4321.5);
  const input = { 0: 2, 1014: p0, 1015: p1, 1022: e0, 1023: e1, ...over };
  const writes = [];
  return {
    writes,
    transport: {
      type: 'modbus',
      mbRequest: async ({ unitId, fc, address, quantity }) => {
        assert.equal(unitId, 1); assert.equal(fc, 4);
        return Array.from({ length: quantity }, (_, i) => { if (!((address + i) in input)) throw new Error('modbus exception 2'); return input[address + i]; });
      },
      mbWriteSingle: async ({ address, value }) => { writes.push([address, value]); return { addr: address, value }; },
    },
  };
}
let t = 20_000_000;
const salia = (b) => createSaliaAdapter(() => ({ host: '192.0.2.60' }), { getTransport: () => b.transport, now: () => t });

test('Typ salia wählbar', () => { assert.ok(WALLBOX_TYPES.includes('salia')); });

test('Status: lädt, Leistung und Energie aus Float32', async () => {
  const st = await salia(fakeSalia()).status();
  assert.deepEqual([st.ok, st.charging, st.connected, st.powerW], [true, true, true, 7123]);
  assert.equal(Math.round(st.raw.energyKwh * 10) / 10, 4321.5);
  assert.equal((await salia(fakeSalia({ 0: 4 })).status()).carState, 'error');
});

test('Laden: Failsafe (300 s, 6 A), Modus MANUAL, dann Strom und Start; Stopp; Lebenszeichen beim Status', async () => {
  const b = fakeSalia();
  const a = salia(b);
  await a.charge(10.8);
  assert.deepEqual(b.writes, [[203, 300], [205, 6], [106, 2], [201, 10], [202, 1]]);
  t += 15_000;
  await a.charge(10.1);
  assert.equal(b.writes.length, 5, 'unverändert → nichts schreiben');
  await a.stop();
  assert.deepEqual(b.writes.at(-1), [202, 0]);
  await a.status();
  assert.equal(b.writes.at(-1)[0], 207, 'Lebenszeichen, solange DVhub steuert');
});

test('Freigeben: Failsafe aus, Modus POWER; danach kein Lebenszeichen mehr', async () => {
  const b = fakeSalia();
  const a = salia(b);
  await a.charge(16);
  await a.release();
  assert.deepEqual(b.writes.slice(-2), [[203, 0], [106, 1]]);
  const n = b.writes.length;
  await a.status();
  assert.equal(b.writes.length, n);
});
