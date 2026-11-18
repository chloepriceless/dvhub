// E4 (Lese-Engine, 18.11.2026): kombinierte Punkte — Summe/Differenz über eine Liste beliebiger Register, jedes mit
// eigener Adresse, eigenem Typ, eigener Wortreihenfolge, Skala und Vorzeichen.
//   FoxESS PV 31002 + 31005 (nicht benachbart), SMA Akku 31393 Laden − 31395 Entladen (U32),
//   Growatt Akku 1011–12 Laden − 1009–10 Entladen (U32, 0,1 W), AlphaESS PV1–3 je U32.
// Profil: `"combine": [{ "address", "readType"?, "wordOrder"?, "scale"?, "sign"?, … }]`; Skala/Vorzeichen/Offset des
// Punkts gelten für die Summe.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';

function rig(points, image, meter = { fc: 3, address: 900, quantity: 3, unitId: 1 }) {
  const dev = createRegisterDevice();
  image(dev);
  if (meter.address === 900) dev.setWords(900, [0, 0, 0]);
  return { dev, ...createPollerRig({ meter, points }, dev) };
}

test('E4: Summe nicht benachbarter 16-bit-Register (FoxESS PV 31002 + 31005)', async () => {
  const { state, poller, dev } = rig({
    pvPowerW: { enabled: true, fc: 3, unitId: 1, combine: [{ address: 31002 }, { address: 31005 }] },
  }, (d) => d.set(31002, 2100).set(31005, 1900).set(31003, 9999).set(31004, 9999));
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, 4000);
  assert.deepEqual(dev.requests.filter((r) => r.address >= 31000).map((r) => [r.address, r.quantity]), [[31002, 1], [31005, 1]]);
});

test('E4: Differenz zweier U32 mit Vorzeichen je Eintrag (SMA Akku Laden − Entladen), + = Laden', async () => {
  const points = {
    batteryPowerW: {
      enabled: true, fc: 3, unitId: 3, readType: 'uint32',
      combine: [{ address: 31393 }, { address: 31395, sign: -1 }],
    },
  };
  const { state, poller } = rig(points, (d) => d.set32(31393, 0, { unitId: 3 }).set32(31395, 2500, { unitId: 3 }));
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, -2500, 'entlädt 2,5 kW → negativ');
});

test('E4: gemischte Typen, Wortreihenfolge und Skala je Eintrag; Skala/Vorzeichen des Punkts auf die Summe', async () => {
  const points = {
    // Growatt-Stil: Laden (U32, 0,1 W, High-Wort zuerst) − Entladen (U32, 0,1 W, Low-Wort zuerst), dazu ein s16-Term.
    batteryPowerW: {
      enabled: true, fc: 4, unitId: 1,
      combine: [
        { address: 1011, readType: 'uint32', scale: 0.1 },
        { address: 1009, readType: 'uint32', wordOrder: 'le', scale: 0.1, sign: -1 },
        { address: 1100, signed: true },
      ],
    },
    // Punkt-Vorzeichen: Gerät meldet „+ = Entladen“ als Summe → sign −1 auf dem Punkt, Offset danach.
    pvPowerW: {
      enabled: true, fc: 4, unitId: 1, sign: -1, scale: 2, offset: 5,
      combine: [{ address: 1200, signed: true }, { address: 1201, signed: true }],
    },
  };
  const { state, poller } = rig(points, (d) => {
    d.set32(1011, 30000, { fc: 4 });                 // 3000,0 W Laden
    d.set32(1009, 12345, { fc: 4, wordOrder: 'le' }); // 1234,5 W Entladen
    d.set(1100, -100, { fc: 4 });
    d.set(1200, -300, { fc: 4 }).set(1201, -200, { fc: 4 });
  });
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, 1665.5, '3000 − 1234,5 − 100');
  assert.equal(state.victron.pvPowerW, 1005, '(−300 − 200) × 2 × (−1) + 5');
});

test('E4: ein Summand ohne Wert (notAvailableRaw/NaN) macht die Summe unbekannt — kein stilles 0-W-Teil', async () => {
  const { state, poller } = rig({
    pvPowerW: {
      enabled: true, fc: 3, unitId: 1, readType: 'uint32', notAvailableRaw: [0xffffffff],
      combine: [{ address: 10 }, { address: 12 }],
    },
    selfConsumptionW: { enabled: true, fc: 3, unitId: 1, combine: [{ address: 20, readType: 'float32' }, { address: 22 }] },
  }, (d) => d.set32(10, 1000).setWords(12, [0xffff, 0xffff]).setWords(20, [0x7fc0, 0]).set(22, 5));
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, null, 'vererbtes notAvailableRaw auf Term 2');
  assert.equal(state.victron.selfConsumptionW, null, 'Float-NaN in Term 1');
});

test('E4: Lesefehler eines Summanden = Lesefehler des Punkts; ungültige Liste wird abgewiesen', async () => {
  const { state, poller } = rig({
    pvPowerW: { enabled: true, fc: 3, unitId: 1, combine: [{ address: 10 }, { address: 11 }] },
    batteryPowerW: { enabled: true, fc: 3, unitId: 1, combine: [] },
    selfConsumptionW: { enabled: true, fc: 3, unitId: 1, combine: [{ address: 10, combine: [{ address: 10 }] }] },
    soc: { enabled: true, fc: 3, unitId: 1, combine: [{ readType: 'uint32' }] },
  }, (d) => d.set(10, 100));
  await poller.requestPoll();
  assert.match(state.victron.errors.pvPowerW, /modbus exception 2/);
  assert.match(state.victron.errors.batteryPowerW, /mindestens einen Eintrag/);
  assert.match(state.victron.errors.selfConsumptionW, /ohne verschachteltes combine/);
  assert.match(state.victron.errors.soc, /Registeradresse fehlt/);
});

test('E4: Einträge erben Verbindung/FC/Unit vom Punkt, eigene unitId gewinnt', async () => {
  const { state, poller, dev } = rig({
    pvPowerW: { enabled: true, fc: 4, unitId: 7, port: 1502, host: '192.0.2.9', combine: [{ address: 50 }, { address: 60, unitId: 8, fc: 3 }] },
  }, (d) => d.set(50, 10, { unitId: 7, fc: 4 }).set(60, 20, { unitId: 8, fc: 3 }));
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, 30);
  const reqs = dev.requests.filter((r) => r.address === 50 || r.address === 60);
  assert.deepEqual(reqs.map((r) => [r.address, r.unitId, r.fc, r.port, r.host]), [[50, 7, 4, 1502, '192.0.2.9'], [60, 8, 3, 1502, '192.0.2.9']]);
});
