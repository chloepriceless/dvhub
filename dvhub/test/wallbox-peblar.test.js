// Peblar Home / Home Plus (Christin 2026-10-20). Quelle: Peblars offizieller
// Modbus-Client github.com/Peblar/py-modbus-api-client (MIT) — Adressen wörtlich:
//   FC4 30000 Energie gesamt (Int64, Wh) · 30014 Leistung gesamt (Int32, W)
//       30022–30027 Strom L1–L3 (Int32, mA) · 30110 CP-Zustand (ASCII „A“…„F“)
//   FC16 40000 Ladestrom (UInt32, mA; 0 = Pause — Peblar: höchstens 3 Pausen je 10 min)
// Watchdog-Register stehen dort nicht → DVhub schreibt keine.
// Mennekes AMTRON 4You 500 / 4Business 700 (Bender ICC, Register v1.5): wie
// Bender, aber Strom über Register 2000 (A); HEMS-Modus in der App auf „lesen und schreiben“.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPeblarAdapter } from '../services/wallbox/peblar.js';
import { createBenderAdapter } from '../services/wallbox/bender.js';
import { WALLBOX_TYPES } from '../services/wallbox/types.js';

function fakePeblar(over = {}) {
  const r = { 30000: 0, 30001: 0, 30002: 0, 30003: 54321, 30014: 0, 30015: 6900, 30022: 0, 30023: 10000, 30024: 0, 30025: 10100, 30026: 0, 30027: 9900, 30110: 0x4300, ...over };
  const writes = [];
  return {
    writes,
    transport: {
      type: 'modbus',
      mbRequest: async ({ fc, address, quantity }) => {
        assert.equal(fc, 4);
        return Array.from({ length: quantity }, (_, i) => { if (!((address + i) in r)) throw new Error('modbus exception 2'); return r[address + i]; });
      },
      mbWriteMultiple: async ({ address, values }) => { writes.push([address, values]); return { addr: address, quantity: values.length }; },
    },
  };
}
const peblar = (b) => createPeblarAdapter(() => ({ host: '192.0.2.70' }), { getTransport: () => b.transport, now: () => 1 });

test('Typ peblar wählbar', () => { assert.ok(WALLBOX_TYPES.includes('peblar')); });

test('Peblar Status: CP C = lädt, Leistung, Energie (Int64), Strom', async () => {
  const st = await peblar(fakePeblar()).status();
  assert.deepEqual([st.ok, st.connected, st.charging, st.powerW, st.currentA], [true, true, true, 6900, 10.1]);
  assert.equal(st.raw.energyWh, 54321);
  assert.equal((await peblar(fakePeblar({ 30110: 0x4100 })).status()).connected, false);
});

test('Peblar Laden = 40000 in mA als UInt32 (FC16); Stopp = 0; Freigeben = 32 A', async () => {
  const b = fakePeblar();
  const a = peblar(b);
  await a.charge(10.5);
  await a.stop();
  await a.release();
  assert.deepEqual(b.writes, [[40000, [0, 10000]], [40000, [0, 0]], [40000, [0, 32000]]]);
});

test('Mennekes 4You: Bender-Treiber mit Strom über Register 2000', async () => {
  const writes = [];
  const t = { type: 'modbus', mbRequest: async () => [0], mbWriteSingle: async ({ address, value }) => { writes.push([address, value]); } };
  const a = createBenderAdapter(() => ({ host: 'x', variant: '4you' }), { getTransport: () => t, now: () => 1 });
  await a.charge(10);
  assert.deepEqual(writes.at(-1), [2000, 10]);
  await a.stop();
  assert.deepEqual(writes.at(-1), [2000, 0]);
});
