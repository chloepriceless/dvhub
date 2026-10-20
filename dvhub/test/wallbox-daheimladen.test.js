// DaheimLaden (Christin 2026-10-20). Quelle: „DaheimLader Modbus/TCP-Spezifikation“ vom
// 28.07.2026 (DaheimLadenModbus0726.pdf, www.daheimladen.de/post/modbus-api), für Smart
// (V1+V2), Touch, Smart PRO, Touch PRO, Business PRO. Port 502, Unit-ID 255, FC03/FC16.
// Belegung wie EM2GO: 0 Zustand · 2 Kabel · 4 Fehler · 6–10 Strom · 12 Leistung UInt32 ·
// 28 Zähler · 32 EVSE-Höchststrom · 87 Ausfallstrom · 89 Timeout · 91 Strombegrenzung ·
// 93 Lademodus · 95 Ladebefehl. 87/89 „nicht für PRO“.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDaheimladenAdapter } from '../services/wallbox/em2go.js';
import { WALLBOX_TYPES, directWallboxConfigured } from '../services/wallbox/types.js';
import { WALLBOX_LABELS } from '../services/wallbox/main-wallbox.js';

function fakeBox({ pro = false, state = 2, mode = 1 } = {}) {
  const reg = { 0: state, 2: 1, 4: 0, 6: 0, 8: 0, 10: 0, 12: 0, 13: 0, 32: 160, 93: mode };
  const writes = [], units = new Set();
  return {
    reg, writes, units,
    transport: {
      type: 'modbus',
      mbRequest: async ({ fc, address, quantity, unitId }) => {
        units.add(unitId); assert.equal(fc, 3);
        return Array.from({ length: quantity }, (_, i) => reg[address + i] ?? 0);
      },
      mbWriteMultiple: async ({ address, values, unitId }) => {
        units.add(unitId);
        if (pro && (address === 87 || address === 89)) throw new Error('modbus exception 2');
        writes.push([address, ...values]); reg[address] = values[0]; return {};
      },
    },
  };
}
const dl = (b, over = {}) => createDaheimladenAdapter(() => ({ host: '192.0.2.95', ...over }), { getTransport: () => b.transport });

test('Typ daheimladen wählbar, eingerichtet mit Adresse', () => {
  assert.ok(WALLBOX_TYPES.includes('daheimladen'));
  assert.equal(WALLBOX_LABELS.daheimladen, 'DaheimLaden');
  assert.equal(directWallboxConfigured({ wallbox: { type: 'daheimladen', daheimladen: { host: '192.0.2.95' } } }), true);
  assert.equal(directWallboxConfigured({ wallbox: { type: 'daheimladen', daheimladen: { host: '' } } }), false);
});

test('Smart/Touch: Unit 255, Ausfallstrom 6 A, Timeout, Strom in 0,1 A, Start bei verbundenem Auto', async () => {
  const b = fakeBox();
  const a = dl(b);
  assert.equal(a.type, 'daheimladen');
  assert.equal((await a.charge(10)).ok, true);
  assert.deepEqual([...b.units], [255]);
  assert.deepEqual(b.writes, [[87, 60], [89, 600], [91, 100], [95, 1]]);
});

test('PRO ohne 87/89: Laden klappt trotzdem, kein zweiter Versuch, Status meldet fehlenden Rückfall', async () => {
  const b = fakeBox({ pro: true, state: 4 });
  const a = dl(b);
  assert.equal((await a.charge(12)).ok, true);
  assert.equal((await a.charge(13)).ok, true);
  assert.deepEqual(b.writes, [[91, 120], [91, 130]]);
  const st = await a.status();
  assert.equal(st.ok, true);
  assert.equal(st.raw.fallback, false);
});

test('Eigene Unit-ID und Fehlertexte mit Herstellernamen', async () => {
  const b = fakeBox();
  await dl(b, { unitId: 7 }).status();
  assert.deepEqual([...b.units], [7]);
  const none = createDaheimladenAdapter(() => ({ host: '' }), { getTransport: () => b.transport });
  assert.match((await none.charge(10)).error, /^DaheimLaden:/);
});

test('Zeitüberschreitung beim Rückfall ist kein PRO: Fehler melden, beim nächsten Mal wieder schreiben', async () => {
  const b = fakeBox();
  let fail = true;
  const write = b.transport.mbWriteMultiple;
  b.transport.mbWriteMultiple = async (req) => {
    if (fail && req.address === 87) throw new Error('Modbus timeout');
    return write(req);
  };
  const a = dl(b);
  assert.equal((await a.charge(10)).ok, false);
  fail = false;
  assert.equal((await a.charge(10)).ok, true);
  assert.deepEqual(b.writes.slice(0, 2), [[87, 60], [89, 600]]);
  assert.notEqual((await a.status()).raw.fallback, false);
});
