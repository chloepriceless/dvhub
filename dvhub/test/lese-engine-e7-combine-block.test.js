// E7 (18.11.2026): `combineBlock: true` — alle combine-Einträge eines Punkts aus EINER Anfrage über ihre Spanne.
// Anlass SMA: zwischen zwei Anfragen müssen ≥ 10 s liegen. Netz = Bezug (30865) − Einspeisung (30867) aus zwei
// Lesungen 10 s auseinander ergäbe bei einem Richtungswechsel einen Wert, den es nie gab. Plexlog liest 30865 mit
// 4 Registern in einer Anfrage. Ohne den Schlüssel bleibt combine, wie es war (eine Anfrage je Eintrag).
import test from 'node:test';
import assert from 'node:assert/strict';

import { readPointValue } from '../services/inverter/point-read.js';
import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';

const read = (dev) => (c) => dev.mbRequest(c);
const smaGrid = (block) => ({
  fc: 3, unitId: 3, readType: 'int32', notAvailableRaw: [2147483648],
  combine: [{ address: 30865 }, { address: 30867, sign: -1 }],
  ...(block ? { combineBlock: true } : {}),
});

test('combineBlock: eine Anfrage über die Spanne, gleiches Ergebnis wie einzeln gelesen', async () => {
  const dev = createRegisterDevice({ defaultUnitId: 3 }).set32(30865, 0).set32(30867, 1300);
  assert.equal(await readPointValue(smaGrid(true), read(dev)), -1300);
  assert.deepEqual(dev.requests.map((r) => [r.unitId, r.fc, r.address, r.quantity]), [[3, 3, 30865, 4]]);
  dev.requests.length = 0;
  assert.equal(await readPointValue(smaGrid(false), read(dev)), -1300, 'ohne combineBlock dasselbe Ergebnis');
  assert.deepEqual(dev.requests.map((r) => [r.address, r.quantity]), [[30865, 2], [30867, 2]], 'ohne combineBlock wie bisher je Eintrag');
});

test('combineBlock: ein Messzeitpunkt — ein Richtungswechsel zwischen zwei Anfragen erfindet keinen Wert', async () => {
  // Das Gerät wechselt nach JEDER Anfrage von 2000 W Bezug auf 500 W Einspeisung.
  const dev = createRegisterDevice({ defaultUnitId: 3 }).set32(30865, 2000).set32(30867, 0);
  const flip = (c) => dev.mbRequest(c).then((regs) => { dev.set32(30865, 0).set32(30867, 500); return regs; });
  assert.equal(await readPointValue(smaGrid(false), flip), 1500, 'einzeln: Bezug von vorher − Einspeisung von nachher');
  dev.set32(30865, 2000).set32(30867, 0);
  assert.equal(await readPointValue(smaGrid(true), flip), 2000, 'Block: der Wert der einen Probe');
});

test('combineBlock: Lücke zwischen den Einträgen wird mitgelesen, Typen und Vorzeichen je Eintrag', async () => {
  const dev = createRegisterDevice({ defaultUnitId: 3 })
    .set32(31393, 2400).setWords(31395, [0, 0]).set(31397, 77).set32(31398, 100);
  const conf = {
    fc: 3, unitId: 3, readType: 'uint32', combineBlock: true,
    combine: [{ address: 31393 }, { address: 31398, sign: -1 }, { address: 31397, readType: 'uint16', quantity: 1, scale: 0 }],
  };
  assert.equal(await readPointValue(conf, read(dev)), 2300);
  assert.deepEqual(dev.requests.map((r) => [r.address, r.quantity]), [[31393, 7]]);
});

test('combineBlock: „kein Wert“ in einem Eintrag macht die Summe leer; Fehler der Anfrage bleibt ein Lesefehler', async () => {
  const dev = createRegisterDevice({ defaultUnitId: 3 }).set32(30865, 300).setWords(30867, [0x8000, 0x0000]);
  assert.equal(await readPointValue(smaGrid(true), read(dev)), null);
  const missing = createRegisterDevice({ defaultUnitId: 3 }).set32(30865, 300);
  await assert.rejects(() => readPointValue(smaGrid(true), read(missing)), /exception 2/);
  const short = async () => [0, 300];
  await assert.rejects(() => readPointValue(smaGrid(true), short), /combineBlock @30865: unvollständige Antwort/);
});

test('combineBlock: Einträge mit eigener Verbindung, split oder Skalenfaktor und zu große Spannen werden abgewiesen', async () => {
  const dev = createRegisterDevice({ defaultUnitId: 3 });
  const reject = async (conf, re) => assert.rejects(() => readPointValue(conf, read(dev)), re);
  await reject({ ...smaGrid(true), combine: [{ address: 30865 }, { address: 30867, unitId: 4 }] }, /eigenem unitId/);
  await reject({ ...smaGrid(true), combine: [{ address: 30865 }, { address: 30867, fc: 4 }] }, /eigenem fc/);
  await reject({ ...smaGrid(true), combine: [{ address: 30865 }, { split: { low: 1, high: 2 } }] }, /ohne split/);
  await reject({ ...smaGrid(true), combine: [{ address: 30865 }, { address: 30867, sfAddress: 30869 }] }, /ohne split, sfAddress/);
  await reject({ ...smaGrid(true), combine: [{ address: 30773 }, { address: 30961 }] }, /Spanne 190 Register/);
  assert.equal(dev.requests.length, 0, 'nichts gelesen');
  // Gleiche Verbindung ausdrücklich wiederholt ist erlaubt.
  dev.set32(30865, 10).set32(30867, 0);
  assert.equal(await readPointValue({ ...smaGrid(true), combine: [{ address: 30865, unitId: 3 }, { address: 30867, sign: -1, fc: 3 }] }, read(dev)), 10);
});

test('combineBlock im Zähler (layout point) und als Akku-Punkt über den echten Poller: je eine Anfrage', async () => {
  const dev = createRegisterDevice({ defaultUnitId: 3 })
    .set32(30865, 800).set32(30867, 0).set32(31393, 0).set32(31395, 1500);
  const cfg = {
    meter: { layout: 'point', ...smaGrid(true) },
    points: {
      batteryPowerW: {
        enabled: true, fc: 3, unitId: 3, readType: 'uint32', combineBlock: true, notAvailableRaw: [4294967295],
        combine: [{ address: 31393 }, { address: 31395, sign: -1 }],
      },
    },
  };
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, 800);
  assert.equal(state.victron.batteryPowerW, -1500);
  assert.deepEqual(dev.requests.map((r) => [r.address, r.quantity]).sort(), [[30865, 4], [31393, 4]]);
});
