// E5 (Lese-Engine, 18.11.2026): SunSpec-Skalenfaktor (sunssf) zur Laufzeit, im selben Poll-Takt gelesen.
// SolarEdge: AC-Leistung 40083 mit SF 40084, DC 40100 mit SF 40101; der SF kann sich zwischen zwei Takten ändern.
// Profil: `"sfAddress": <Adresse>` (absolut) oder SunSpec-relativ `"sunspec": { "model", "offset", "sfOffset" }`.
// Wert = Rohwert × 10^SF × scale × sign + offset; SF 0x8000 („nicht implementiert“) → Wert unbekannt (null).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';

const METER = { fc: 3, address: 900, quantity: 3, unitId: 1 };
function rig(points, image) {
  const dev = createRegisterDevice();
  image(dev);
  dev.setWords(900, [0, 0, 0]);
  return { dev, ...createPollerRig({ meter: METER, points }, dev) };
}
const p = (address, extra = {}) => ({ enabled: true, fc: 3, unitId: 1, address, quantity: 1, scale: 1, offset: 0, ...extra });

test('E5: sfAddress wird je Takt gelesen — SF-Wechsel wirkt sofort', async () => {
  const { state, poller, dev } = rig({ pvPowerW: p(40083, { sfAddress: 40084 }) }, (d) => d.set(40083, 12345).set(40084, -1));
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, 1234.5);
  dev.set(40083, 12345).set(40084, -2);
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, 123.45);
  dev.set(40083, 25).set(40084, 2);
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, 2500);
});

test('E5: SF mit Vorzeichen-Wert (int16), scale und sign; Sentinel des Werts bleibt null', async () => {
  const { state, poller } = rig({
    batteryPowerW: p(100, { signed: true, sfAddress: 101, sign: -1 }),       // Gerät: + = Entladen
    selfConsumptionW: p(102, { signed: true, sfAddress: 101, notAvailableRaw: [0x8000] }),
  }, (d) => d.set(100, -1500).set(101, -1).set(102, 0x8000));
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, 150, '−1500 × 0,1 × (−1)');
  assert.equal(state.victron.selfConsumptionW, null);
});

test('E5: SF „nicht implementiert“ (0x8000) → Wert unbekannt; SF außerhalb −10…10 → Lesefehler', async () => {
  const { state, poller } = rig({
    pvPowerW: p(10, { sfAddress: 11 }),
    batteryPowerW: p(20, { signed: true, sfAddress: 21 }),
  }, (d) => d.set(10, 500).set(11, 0x8000).set(20, 500).set(21, 50));
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, null);
  assert.equal(state.victron.errors.pvPowerW, undefined);
  assert.match(state.victron.errors.batteryPowerW, /außerhalb −10…10/);
});

test('E5: gemeinsamer SF wird je Takt nur einmal gelesen', async () => {
  const { state, poller, dev } = rig({
    pvPowerW: p(40083, { sfAddress: 40084 }),
    selfConsumptionW: p(40085, { sfAddress: 40084 }),
  }, (d) => d.set(40083, 100).set(40085, 200).set(40084, 1));
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, 1000);
  assert.equal(state.victron.selfConsumptionW, 2000);
  assert.equal(dev.requests.filter((r) => r.address === 40084).length, 1);
  await poller.requestPoll();
  assert.equal(dev.requests.filter((r) => r.address === 40084).length, 2, 'nächster Takt liest neu');
});

test('E5: SF auf einem kombinierten Punkt gilt für die Summe', async () => {
  const { state, poller } = rig({
    pvPowerW: { enabled: true, fc: 3, unitId: 1, sfAddress: 50, combine: [{ address: 40 }, { address: 41 }] },
  }, (d) => d.set(40, 120).set(41, 80).set(50, -1));
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, 20);
});

test('E5: SunSpec-relativ — sfOffset im Modell wird beim Scan zu sfAddress aufgelöst', async () => {
  const dev = createRegisterDevice();
  // Modell 1 (Common, 66) und 103 (Drehstrom-WR, 50): W @ +14, W_SF @ +15; DCW @ +31, DCW_SF @ +32.
  const at = dev.setSunspecChain(40000, [{ id: 1, length: 66 }, { id: 103, length: 50 }]);
  const base103 = at[103][0];
  dev.set(base103 + 14, 4321).set(base103 + 15, -1).set(base103 + 31, 500).set(base103 + 32, 1);
  dev.setWords(900, [0, 0, 0]);
  const cfg = {
    meter: METER,
    victron: { host: '192.0.2.1', port: 502, unitId: 1, timeoutMs: 1000 },
    points: {
      selfConsumptionW: { enabled: true, fc: 3, unitId: 1, quantity: 1, signed: true, sunspec: { model: 103, offset: 14, sfOffset: 15 } },
      pvPowerW: { enabled: true, fc: 3, unitId: 1, quantity: 1, sunspec: { model: 103, offset: 31, sfOffset: 32 } },
    },
  };
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(cfg.points.pvPowerW.address, base103 + 31);
  assert.equal(cfg.points.pvPowerW.sfAddress, base103 + 32);
  assert.equal(state.victron.selfConsumptionW, 432.1);
  assert.equal(state.victron.pvPowerW, 5000);
});
