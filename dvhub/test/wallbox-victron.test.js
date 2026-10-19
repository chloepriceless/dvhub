// Victron-Wallbox (EVCS) als Hauptwallbox (Christin 2026-10-20). DVhub steuert
// sie über den Modbus-TCP-Server des GX (com.victronenergy.evcharger):
//   3815 Mode (0 Manuell, 1 Automatisch, 2 Zeitplan)
//   3825 SetCurrent (A, nur im Modus Manuell wirksam)
//   3826 StartStop (0 Stopp, 1 Start, nur im Modus Manuell)
//   3814 Maximalstrom der Box (nie überschreiten)
import test from 'node:test';
import assert from 'node:assert/strict';

import { createVictronEvcsAdapter } from '../services/wallbox/adapters.js';
import { WALLBOX_TYPES, WALLBOX_LABELS, directModeFromRaw } from '../services/wallbox/main-wallbox.js';
import { DIRECT_CHARGERS } from '../services/wallbox/charger-status.js';

function fakeEvcs(regs = {}) {
  const r = { 3800: 0xc025, 3814: 16, 3815: 1, 3816: 0, 3817: 0, 3818: 0, 3819: 0, 3820: 0, 3821: 0, 3822: 0, 3823: 0, 3824: 1, 3825: 6, 3826: 0, 3827: 0, 3828: 0, 3829: 0, ...regs };
  const writes = [];
  return {
    regs: r, writes,
    mbRequest: async ({ unitId, fc, address, quantity }) => {
      assert.equal(unitId, 40);
      assert.equal(fc, 3);
      const out = [];
      for (let a = address; a < address + quantity; a++) {
        if (!(a in r)) throw new Error('modbus exception 2');
        out.push(r[a]);
      }
      return out;
    },
    mbWriteSingle: async ({ unitId, address, value }) => {
      assert.equal(unitId, 40);
      writes.push([address, value]);
      r[address] = value;
      return { addr: address, value };
    }
  };
}

function adapter(box, settings = {}) {
  return createVictronEvcsAdapter(() => settings, {
    getVictron: () => ({ host: 'gx', port: 502 }),
    getTransport: () => ({ type: 'modbus', mbRequest: box.mbRequest, mbWriteSingle: box.mbWriteSingle }),
    findUnit: () => 40
  });
}

test('Typ „victron“ ist eine wählbare, direkt abgefragte Wallbox', () => {
  assert.ok(WALLBOX_TYPES.includes('victron'));
  assert.equal(WALLBOX_LABELS.victron, 'Victron EV Charging Station');
  assert.ok(DIRECT_CHARGERS.includes('victron'));
});

test('Laden: Modus Manuell, Strom (ganze A, höchstens Maximalstrom), Start', async () => {
  const box = fakeEvcs();
  const res = await adapter(box).charge(20.7);
  assert.equal(res.ok, true);
  assert.deepEqual(box.writes, [[3815, 0], [3825, 16], [3826, 1]]);
});

test('Laden unter 6 A wird 6 A; schon Manuell → Modus nicht neu schreiben', async () => {
  const box = fakeEvcs({ 3815: 0 });
  await adapter(box).charge(3);
  assert.deepEqual(box.writes, [[3825, 6], [3826, 1]]);
});

test('Stopp: Manuell + StartStop 0; Freigeben: zurück auf Automatisch', async () => {
  const box = fakeEvcs();
  assert.equal((await adapter(box).stop()).ok, true);
  assert.deepEqual(box.writes, [[3815, 0], [3826, 0]]);
  box.writes.length = 0;
  assert.equal((await adapter(box).release()).ok, true);
  assert.deepEqual(box.writes, [[3815, 1]]);
});

test('Status: angesteckt/lädt, Leistung, Strom, Lademodus wie bei go-e', async () => {
  const box = fakeEvcs({ 3815: 0, 3821: 3680, 3823: 16, 3824: 2, 3826: 1 });
  const st = await adapter(box).status();
  assert.equal(st.ok, true);
  assert.equal(st.connected, true);
  assert.equal(st.charging, true);
  assert.equal(st.powerW, 3680);
  assert.equal(st.currentA, 16);
  assert.equal(st.vehicleSocPct, null);
  assert.equal(directModeFromRaw(st.raw), 'now');
  assert.equal(directModeFromRaw((await adapter(fakeEvcs({ 3815: 1 })).status()).raw), 'pv');
  assert.equal(directModeFromRaw((await adapter(fakeEvcs({ 3815: 0, 3826: 0 })).status()).raw), 'off');
});

test('Nicht angesteckt / Fehlerzustand', async () => {
  assert.equal((await adapter(fakeEvcs({ 3824: 0 })).status()).connected, false);
  const err = await adapter(fakeEvcs({ 3824: 14 })).status();
  assert.equal(err.connected, null);
  assert.equal(err.carState, 'error');
});

test('Feste Unit-ID aus den Einstellungen geht vor der Suche', async () => {
  const box = fakeEvcs();
  let asked = 0;
  const a = createVictronEvcsAdapter(() => ({ unitId: 40 }), {
    getVictron: () => ({ host: 'gx' }),
    getTransport: () => ({ type: 'modbus', mbRequest: box.mbRequest, mbWriteSingle: box.mbWriteSingle }),
    findUnit: () => { asked++; return 99; }
  });
  assert.equal((await a.status()).ok, true);
  assert.equal(asked, 0);
});

test('Ohne gefundene Wallbox oder ohne Victron-Modbus: klare Meldung, kein Schreiben', async () => {
  const none = createVictronEvcsAdapter(() => ({}), { getVictron: () => ({ host: 'gx' }), getTransport: () => ({ type: 'modbus', mbRequest: async () => [], mbWriteSingle: async () => assert.fail('schreibt') }), findUnit: () => null });
  assert.equal(none.isConfigured(), false);
  assert.match((await none.charge(10)).error, /keine Victron-Wallbox/i);
  const mqtt = createVictronEvcsAdapter(() => ({}), { getVictron: () => ({ host: 'gx' }), getTransport: () => ({ type: 'mqtt' }), findUnit: () => 40 });
  assert.equal(mqtt.isConfigured(), false);
});

test('Heizstab-Pause „solange das E-Auto lädt“ fragt auch die Victron-Wallbox', async () => {
  const { createEvChargingProbe } = await import('../services/wallbox/ev-charging.js');
  const box = fakeEvcs({ 3815: 0, 3821: 3680, 3823: 16, 3824: 2, 3826: 1 });
  const probe = createEvChargingProbe({ getCfg: () => ({ wallbox: { type: 'victron' } }), getAdapter: () => adapter(box) });
  assert.equal(await probe(), true);
});
