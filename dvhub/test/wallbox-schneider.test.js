// Schneider EVlink Pro AC (Christin 2026-10-20). Quelle: „EVlink Pro AC Modbus
// Connectivity Guide“ GEX1969300–06 (03/2026, se.com, im sichtbaren Browser geladen).
// Server-ID 255. 1 EV-Zustand (IEC 61851, 8/9 = lädt) · 150 OCPP-Status ·
// 2999/3001/3003 Strom float32 A · 3059 Leistung float32 kW · 3203 Energie int64 Wh ·
// 4000 Lifebit (1 = Lebenszeichen, die Box setzt 0 zurück; 2 = aus) · 4004 Vorgabe A (0–32).
// Praxis laut evcc (charger/schneider-v3.go, MIT): Gleitkomma/64 Bit mit niederwertigem
// Wort zuerst; je nach Firmware Holding+FC6 oder Input+FC16; Vorgabe 0 = aus.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSchneiderAdapter } from '../services/wallbox/schneider.js';
import { WALLBOX_TYPES, directWallboxConfigured } from '../services/wallbox/types.js';
import { WALLBOX_LABELS } from '../services/wallbox/main-wallbox.js';

const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return [b.readUInt16BE(2), b.readUInt16BE(0)]; }; // LSW zuerst
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return [6, 4, 2, 0].map((o) => b.readUInt16BE(o)); };

function fakeBox({ inputOnly = false } = {}) {
  const reg = { 1: 8, 150: 3, 4000: 0, 4004: 99 };
  [[2999, 15.9], [3001, 16.1], [3003, 15.8]].forEach(([a, v]) => { [reg[a], reg[a + 1]] = f32(v); });
  [reg[3059], reg[3060]] = f32(11.04);
  u64(1234567).forEach((w, i) => { reg[3203 + i] = w; });
  const calls = [];
  const transport = {
    type: 'modbus',
    mbRequest: async ({ fc, address, quantity, unitId }) => {
      calls.push(['r', fc, address, unitId]);
      if (inputOnly ? fc !== 4 : fc !== 3) throw new Error('Modbus exception 1');
      return Array.from({ length: quantity }, (_, i) => reg[address + i] ?? 0);
    },
    mbWriteSingle: async ({ address, value }) => {
      if (inputOnly) throw new Error('Modbus exception 1');
      calls.push(['w6', address, value]); reg[address] = value; return {};
    },
    mbWriteMultiple: async ({ address, values }) => {
      if (!inputOnly) throw new Error('Modbus exception 1');
      calls.push(['w16', address, values[0]]); reg[address] = values[0]; return {};
    },
  };
  return { reg, calls, transport, writes: () => calls.filter((c) => c[0] !== 'r').map((c) => [c[1], c[2]]) };
}
const se = (b, over = {}) => createSchneiderAdapter(() => ({ host: '192.0.2.40', ...over }), { getTransport: () => b.transport });

test('Typ schneider wählbar, eingerichtet mit Adresse', () => {
  assert.ok(WALLBOX_TYPES.includes('schneider'));
  assert.equal(WALLBOX_LABELS.schneider, 'Schneider EVlink Pro AC');
  assert.equal(directWallboxConfigured({ wallbox: { type: 'schneider', schneider: { host: '192.0.2.40' } } }), true);
  assert.equal(directWallboxConfigured({ wallbox: { type: 'schneider', schneider: { host: ' ' } } }), false);
});

test('Status: lädt (C2), Leistung kW → W, Strom max. Phase, Energie Wh; Unit 255; liest ohne zu schreiben', async () => {
  const b = fakeBox();
  const st = await se(b).status();
  assert.deepEqual([st.ok, st.connected, st.charging, st.carState], [true, true, true, 'charging']);
  assert.equal(st.powerW, 11040);
  assert.equal(st.currentA, 16.1);
  assert.equal(st.raw.energyWh, 1234567);
  assert.ok(b.calls.every((c) => c[0] !== 'r' || c[3] === 255));
  assert.deepEqual(b.writes(), []);
});

test('Laden: Lifebit 1 und Vorgabe in A (FC6); Stopp = Vorgabe 0; Freigeben = 32 A und Lifebit aus (2)', async () => {
  const b = fakeBox();
  const a = se(b);
  assert.equal((await a.charge(10.7)).ok, true);
  assert.equal((await a.charge(40)).ok, true);
  assert.equal((await a.stop()).ok, true);
  assert.equal((await a.release()).ok, true);
  assert.deepEqual(b.writes(), [[4000, 1], [4004, 10], [4000, 1], [4004, 32], [4000, 1], [4004, 0], [4004, 32], [4000, 2]]);
});

test('Lebenszeichen: Status erneuert Lifebit nur, solange DVhub steuert', async () => {
  const b = fakeBox();
  const a = se(b);
  await a.status();
  assert.deepEqual(b.writes(), []);
  await a.charge(8);
  b.reg[4000] = 0; // die Box setzt das Lifebit zurück
  await a.status();
  assert.deepEqual(b.writes().at(-1), [4000, 1]);
  await a.release();
  const n = b.writes().length;
  await a.status();
  assert.equal(b.writes().length, n);
});

test('Firmware mit Input-Registern: liest FC4, schreibt FC16', async () => {
  const b = fakeBox({ inputOnly: true });
  const a = se(b);
  assert.equal((await a.charge(12)).ok, true);
  assert.deepEqual(b.writes(), [[4000, 1], [4004, 12]]);
  assert.equal((await a.status()).powerW, 11040);
});

test('Zustände: angesteckt ohne Laden (B2) wartet, Fehler (CP ungültig), kein Auto (A2)', async () => {
  const b = fakeBox();
  const a = se(b);
  b.reg[1] = 7; b.reg[150] = 5;
  let st = await a.status();
  assert.deepEqual([st.connected, st.charging, st.carState], [true, false, 'waiting']);
  b.reg[1] = 10; b.reg[150] = 9;
  st = await a.status();
  assert.deepEqual([st.connected, st.charging, st.carState], [null, false, 'error']);
  b.reg[1] = 6; b.reg[150] = 1;
  st = await a.status();
  assert.deepEqual([st.connected, st.charging, st.carState], [false, false, null]);
});
