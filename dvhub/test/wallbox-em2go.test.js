// EM2GO (Christin 2026-10-20). Quelle: EM2GO „Programmieren von EV-Wallboxen ModBus TCP“
// V5 01/2023 (media.elv.com/file/252210_modbus_tcp_register.pdf), gilt für EM011/EM022
// (OCPP/ONC) und alle „Pro Power“. Port 502, FC03 lesen (höchstens 3 Register je Anfrage,
// sonst Ausnahme 0xFF), FC16 schreiben, Big Endian.
//   0 Zustand (1 Standby · 2 Verbunden · 3 Starte · 4 Lädt · 5 Start fehlgeschlagen ·
//     6 Laden beendet · 7 Systemfehler · 8 geplant) · 2 Kabel · 4 Fehlercode
//   6/8/10 Strom L1–L3 (0,1 A) · 12 Leistung UInt32 W · 28 Zähler UInt32 (0,1 kWh) · 32 EVSE-Höchststrom
//   87 Rückfallstrom (0,1 A) · 89 Kommunikations-Timeout (s) · 91 Strombegrenzung (0,1 A)
//   93 Lademodus (0 Plug & Charge · 1 auf Befehl) · 95 Ladebefehl (1 Start · 2 Stopp, nur bei 93 = 1)
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEm2goAdapter } from '../services/wallbox/em2go.js';
import { WALLBOX_TYPES } from '../services/wallbox/types.js';

function fakeEm2go({ state = 4, mode = 1, error = 0 } = {}) {
  const reg = { 0: state, 2: 1, 4: error, 6: 160, 8: 158, 10: 161, 12: 0, 13: 11040, 28: 0, 29: 2500, 32: 160, 93: mode };
  const writes = [];
  let t = 0;
  return {
    reg, writes,
    clock: { now: () => t, advance: (ms) => { t += ms; } },
    transport: {
      type: 'modbus',
      mbRequest: async ({ fc, address, quantity }) => {
        assert.equal(fc, 3);
        if (quantity > 3) throw new Error('Modbus exception 255');
        return Array.from({ length: quantity }, (_, i) => reg[address + i] ?? 0);
      },
      mbWriteMultiple: async ({ address, values }) => { writes.push([address, ...values]); reg[address] = values[0]; return {}; },
    },
  };
}
const em = (b, over = {}) => createEm2goAdapter(() => ({ host: '192.0.2.91', ...over }), { getTransport: () => b.transport, now: b.clock.now });

test('Typ em2go wählbar', () => { assert.ok(WALLBOX_TYPES.includes('em2go')); });

test('Status: lädt, Leistung UInt32, Zähler 0,1 kWh, Strom max. Phase — nie mehr als 3 Register je Anfrage', async () => {
  const st = await em(fakeEm2go()).status();
  assert.deepEqual([st.ok, st.connected, st.charging, st.powerW, st.currentA], [true, true, true, 11040, 16.1]);
  assert.equal(st.raw.energyWh, 250000);
  assert.equal((await em(fakeEm2go({ state: 7 })).status()).carState, 'error');
  assert.equal((await em(fakeEm2go({ state: 4, error: 23 })).status()).carState, 'error');
});

test('Laden: Rückfall 6 A, Timeout 600 s (> 5-min-Neuschreibtakt, falls nur Schreiben zählt), Begrenzung; im Befehlsmodus Start; unveränderte Werte erst nach 5 min neu', async () => {
  const b = fakeEm2go({ state: 2, mode: 1 });
  const a = em(b);
  await a.charge(10.6);
  assert.deepEqual(b.writes, [[87, 60], [89, 600], [91, 100], [95, 1]]);
  b.reg[0] = 4;
  await a.charge(10);
  assert.equal(b.writes.length, 4, 'nichts geändert, lädt schon → kein Schreiben');
  b.clock.advance(5 * 60_000 + 1);
  await a.charge(10);
  assert.deepEqual(b.writes.slice(4).map(([r]) => r), [87, 89, 91]);
});

test('Stopp: Befehlsmodus → Ladebefehl 2; Plug & Charge → auf Befehlsmodus schalten, Stopp; Freigeben stellt Modus und Höchststrom zurück', async () => {
  const b = fakeEm2go({ state: 4, mode: 0 });
  const a = em(b);
  await a.stop();
  assert.deepEqual(b.writes, [[93, 1], [95, 2]]);
  await a.release();
  assert.deepEqual(b.writes.slice(2), [[87, 160], [91, 160], [93, 0]]);
});

test('Befehlsmodus: „Laden beendet“ (Auto voll) ohne eigenen Stopp → kein Startbefehl alle 15 s', async () => {
  const b = fakeEm2go({ state: 6, mode: 1 });
  const a = em(b);
  await a.charge(10);
  await a.charge(10);
  assert.equal(b.writes.filter(([r]) => r === 95).length, 0);
});
