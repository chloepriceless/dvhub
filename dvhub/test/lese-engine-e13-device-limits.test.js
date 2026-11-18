// E13 (Lese-Engine, 18.11.2026): Lesepunkte für Gerätegrenzen — BMS-/WR-Grenzen für Laden/Entladen in W oder A.
// Nur lesen und anzeigen (state.victron, /api/status über den IPC-Schnappschuss), KEINE Begrenzung im Steuerpfad.
//   deviceMaxChargeW, deviceMaxDischargeW  (z. B. AlphaESS 0x012C/0x012D U16 W, SolarEdge E144/E146 Float32)
//   deviceMaxChargeA, deviceMaxDischargeA  (z. B. Deye 212/213 1 A, Solis 33143/33144 0,1 A, SolaX 0x24/0x25 0,1 A)
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVictronSnapshot } from '../runtime-state.js';
import { liveSnapshotStale } from '../telemetry-runtime.js';
import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';

const p = (address, extra = {}) => ({ enabled: true, fc: 3, unitId: 1, address, quantity: 1, scale: 1, offset: 0, ...extra });

function rig(points, image) {
  const dev = createRegisterDevice();
  image(dev);
  dev.setWords(900, [0, 0, 0]);
  return { dev, ...createPollerRig({ meter: { fc: 3, address: 900, quantity: 3, unitId: 1 }, points }, dev) };
}

test('E13: Gerätegrenzen in W und A werden gelesen und stehen in state.victron', async () => {
  const { state, poller } = rig({
    deviceMaxChargeW: p(0x012c),
    deviceMaxDischargeW: p(0xe146, { readType: 'float32', wordOrder: 'le', quantity: 2 }),
    deviceMaxChargeA: p(33143, { scale: 0.1 }),
    deviceMaxDischargeA: p(213),
  }, (d) => d.set(0x012c, 5000).setFloat32(0xe146, 4800.5, { wordOrder: 'le' }).set(33143, 1000).set(213, 120));
  await poller.requestPoll();
  assert.equal(state.victron.deviceMaxChargeW, 5000);
  assert.equal(state.victron.deviceMaxDischargeW, 4800.5);
  assert.equal(state.victron.deviceMaxChargeA, 100);
  assert.equal(state.victron.deviceMaxDischargeA, 120);
  assert.ok(state.victron.fieldUpdatedAt.deviceMaxChargeW > 0);
});

test('E13: pollEveryMs drosselt die Grenzen-Register; Profile ohne die Punkte lesen nichts zusätzlich', async () => {
  const { state, poller, dev } = rig({ deviceMaxChargeA: p(212, { pollEveryMs: 60000 }) }, (d) => d.set(212, 150));
  await poller.requestPoll();
  dev.set(212, 180);
  await poller.requestPoll();
  assert.equal(state.victron.deviceMaxChargeA, 150, 'zweiter Takt liest 212 nicht neu');
  assert.equal(dev.requests.filter((r) => r.address === 212).length, 1);

  const plain = rig({}, () => {});
  await plain.poller.requestPoll();
  assert.deepEqual(plain.dev.requests.map((r) => r.address), [900], 'nur der Zähler');
  assert.equal('deviceMaxChargeW' in plain.state.victron, false);
});

test('E13: Grenzen gehen durch den IPC-Schnappschuss; ein Lesefehler macht die Live-Probe nicht veraltet', async () => {
  const { state, poller } = rig({ deviceMaxChargeW: p(0x012c), deviceMaxDischargeW: p(0x012d) }, (d) => d.set(0x012c, 5000));
  await poller.requestPoll();
  assert.ok(state.victron.errors.deviceMaxDischargeW, '0x012D fehlt → Lesefehler');
  const snap = buildVictronSnapshot(state.victron);
  assert.equal(snap.deviceMaxChargeW, 5000);
  assert.equal(liveSnapshotStale({ ts: new Date().toISOString(), meter: state.meter, victron: state.victron }), false,
    'Gerätegrenzen sind keine Energiefelder — kein Messausfall');
});
