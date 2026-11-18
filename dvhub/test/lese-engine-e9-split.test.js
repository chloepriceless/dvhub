// E9 (Lese-Engine, 18.11.2026): 32-bit-Wert aus zwei NICHT benachbarten Registern (Low- und High-Wort getrennt).
// Deye HP3 > 32 kW: Netz 604/700, Last 653/659 … (Spec deye :63 „Low-Word zuerst, High-Word getrennt“).
// Profil: `"readType": "int32" | "uint32", "split": { "low": <Adresse>, "high": <Adresse> }`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';

function rig(points, image) {
  const dev = createRegisterDevice();
  image(dev);
  dev.setWords(900, [0, 0, 0]);
  const cfg = { meter: { fc: 3, address: 900, quantity: 3, unitId: 1 }, points };
  return { dev, ...createPollerRig(cfg, dev) };
}
const split = (low, high, extra = {}) => ({ enabled: true, fc: 3, unitId: 1, split: { low, high }, scale: 1, offset: 0, ...extra });
const hiLo = (v) => {
  const raw = v < 0 ? v + 0x100000000 : v;
  return [Math.floor(raw / 0x10000) & 0xffff, raw & 0xffff];
};

test('E9: uint32 aus Low-Wort 653 und High-Wort 659 (Last über 65 kW)', async () => {
  const [hi, lo] = hiLo(70123);
  const { state, poller, dev } = rig({ selfConsumptionW: split(653, 659, { readType: 'uint32' }) }, (d) => d.set(653, lo).set(659, hi));
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 70123);
  const reads = dev.requests.filter((r) => r.address === 653 || r.address === 659);
  assert.deepEqual(reads.map((r) => [r.address, r.quantity]), [[653, 1], [659, 1]], 'je ein Wort, kein Block über die Lücke');
});

test('E9: int32 mit Vorzeichen und Skala (HV ×10, Einspeisung negativ), notAvailableRaw auf dem Doppelwort', async () => {
  const [hi, lo] = hiLo(-4567);
  const { state, poller } = rig({
    batteryPowerW: split(590, 700, { readType: 'int32', scale: 10 }),
    pvPowerW: split(600, 701, { readType: 'uint32', notAvailableRaw: [0xffffffff] }),
  }, (d) => d.set(590, lo).set(700, hi).set(600, 0xffff).set(701, 0xffff));
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, -45670);
  assert.equal(state.victron.pvPowerW, null, '0xFFFFFFFF = kein Wert');
});

test('E9: split ohne 32-bit-Typ oder ohne Adressen ist ein Lesefehler (kein Müllwert)', async () => {
  const { state, poller } = rig({
    pvPowerW: split(10, 20),
    selfConsumptionW: { enabled: true, fc: 3, unitId: 1, readType: 'uint32', split: { low: 10 } },
  }, (d) => d.set(10, 1).set(20, 2));
  await poller.requestPoll();
  assert.match(state.victron.errors.pvPowerW, /split braucht readType int32 oder uint32/);
  assert.match(state.victron.errors.selfConsumptionW, /split braucht die Registeradressen/);
  assert.equal(state.victron.pvPowerW, undefined);
});
