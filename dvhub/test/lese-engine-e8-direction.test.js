// E8 (Lese-Engine, 19.11.2026): Vorzeichen aus einem Richtungsregister.
// Solis liefert die Akku-Leistung 33149 „mit Vorzeichen aus 33135“ (0 = Laden, 1 = Entladen) [SPEC], SolaX 0x16 mit
// der Richtung in BDCStatus 0x19 (0 = Entladen, 1 = Laden) [SPEC]. Ob das Leistungsregister selbst ein Vorzeichen
// trägt, ist strittig. Profil: `"direction": { "address": <Register>, "values": { "<Rohwert>": 1 | -1 } }`.
// Wert = Betrag des fertig dekodierten Werts × Faktor der gemeldeten Richtung — richtig, ob das Gerät einen Betrag oder
// einen vorzeichenbehafteten Wert liefert. Ein Rohwert, der nicht in `values` steht, macht den Punkt leer (nie geraten).
// Wert und Richtung gehören zu EINER Probe: nah beieinander ein Block (atomar), sonst Richtung vorher/nachher.
import test from 'node:test';
import assert from 'node:assert/strict';

import { readPointValue } from '../services/inverter/point-read.js';
import { createModbusTransport } from '../transport-modbus.js';
import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import { installFakeModbusSockets, advance, flush, enableFakeClock, disableFakeClock } from './helpers/fake-modbus-socket.js';

const METER = { fc: 3, address: 900, quantity: 3, unitId: 1 };
const FC4 = { fc: 4 };
const SOLIS_DIR = { address: 33135, values: { 0: 1, 1: -1 } };
const solisBattery = (extra = {}) => ({
  enabled: true, fc: 4, unitId: 1, address: 33149, quantity: 2, readType: 'int32', scale: 1, offset: 0,
  direction: SOLIS_DIR, ...extra,
});

function rig(points, image, extraCfg = {}) {
  const dev = createRegisterDevice();
  image(dev);
  dev.setWords(900, [0, 0, 0]);
  return { dev, ...createPollerRig({ meter: METER, points, ...extraCfg }, dev) };
}
// Solis-Kulisse: der zusammenhängende Block 33135–33150 (alle Register belegt, wie im 33000er-Block des Geräts).
function solisImage(d, { dir, batt }) {
  for (let a = 33135; a <= 33150; a += 1) d.set(a, 0, FC4);
  d.set(33135, dir, FC4);
  d.set32(33149, batt, FC4);
}
const read = (dev) => (c, o) => dev.mbRequest(c, o);

// --- Wert und Vorzeichen -----------------------------------------------------------------------------------------

test('E8: Betrag + Richtung „Entladen“ → negativ, „Laden“ → positiv; ein Block über Wert und Richtung (FC 4)', async () => {
  const { state, poller, dev } = rig({ batteryPowerW: solisBattery() }, (d) => solisImage(d, { dir: 1, batt: 2800 }));
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, -2800, 'Betrag 2800, Richtung 1 = Entladen');
  assert.equal(state.victron.batteryDischargeW, 2800);
  assert.equal(state.victron.errors.batteryPowerW, undefined);
  assert.deepEqual(dev.requests.filter((r) => r.address !== 900).map((r) => [r.fc, r.address, r.quantity]),
    [[4, 33135, 16]], 'eine Anfrage 33135–33150, Richtung und Wert aus derselben Probe');

  solisImage(dev, { dir: 0, batt: 3100 });
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, 3100, 'Richtung 0 = Laden');
});

test('E8: liefert das Gerät schon ein Vorzeichen, bleibt das Ergebnis richtig (Betrag × Richtung)', async () => {
  const { state, poller } = rig({ batteryPowerW: solisBattery() }, (d) => solisImage(d, { dir: 1, batt: -2800 }));
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, -2800, 'vorzeichenbehaftet −2800 mit Richtung Entladen bleibt −2800');
  assert.equal(await readPointValue(solisBattery({ direction: { address: 33135, values: { 0: 1, 1: -1 } } }),
    read(createRegisterDevice().set(33135, 0, FC4).setWords(33136, Array(13).fill(0), FC4).set32(33149, -3100, FC4))), 3100);
});

test('E8: SolaX-Belegung (0 = Entladen, 1 = Laden), int16 mit Sentinel; Richtung nach dem Wert im Block', async () => {
  const conf = {
    enabled: true, fc: 4, unitId: 1, address: 22, quantity: 1, signed: true, scale: 1, offset: 0,
    notAvailableRaw: [32767, 32768], direction: { address: 25, values: { 0: -1, 1: 1 } },
  };
  const dev = createRegisterDevice().setWords(22, [1500, 0, 0, 0], FC4);
  assert.equal(await readPointValue(conf, read(dev)), -1500, 'BDCStatus 0 = Entladen');
  dev.set(25, 1, FC4);
  assert.equal(await readPointValue(conf, read(dev)), 1500, 'BDCStatus 1 = Laden');
  dev.set(22, 0x8000, FC4);
  assert.equal(await readPointValue(conf, read(dev)), null, 'Sentinel des Werts bleibt „kein Wert“');
  assert.deepEqual(dev.requests.map((r) => [r.address, r.quantity]), [[22, 4], [22, 4], [22, 4]]);
});

test('E8: Skala, Offset und Skalenfaktor gelten für den Betrag; 0 W bleibt 0 (kein −0)', async () => {
  const dev = createRegisterDevice().setWords(10, [250, 1], FC4);
  const conf = { fc: 4, address: 10, quantity: 1, scale: 10, direction: { address: 11, values: { 0: 1, 1: -1 } } };
  assert.equal(await readPointValue(conf, read(dev)), -2500);
  dev.set(10, 0, FC4);
  assert.ok(Object.is(await readPointValue(conf, read(dev)), 0), 'kein −0');
});

// --- Unbekannte Richtung -----------------------------------------------------------------------------------------

test('E8: unbekannter Richtungswert → Punkt leer mit Grund, auch wenn vorher ein Wert stand (nie geraten)', async () => {
  const { state, poller, dev } = rig({ batteryPowerW: solisBattery() }, (d) => solisImage(d, { dir: 0, batt: 1200 }));
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, 1200);
  dev.set(33135, 2, FC4);
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, null, 'kein gehaltener Altwert, kein geratenes Vorzeichen');
  assert.match(state.victron.errors.batteryPowerW, /Richtung.*33135.*2/);
  assert.equal(state.victron.batteryChargeW, 0);
  dev.set(33135, 0xffff, FC4);
  await assert.rejects(() => readPointValue(solisBattery(), read(dev)), /Richtung/);
  dev.set(33135, 1, FC4);
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, -1200, 'mit bekannter Richtung sofort wieder da');
  assert.equal(state.victron.errors.batteryPowerW, undefined);
});

// --- Ein Messzeitpunkt -------------------------------------------------------------------------------------------

// Gerät wechselt nach der ersten Anfrage, die `address` mit abdeckt, von Laden auf Entladen.
function flipAfterFirstRead(dev, address, apply) {
  let done = false;
  dev.mbRequest = ((orig) => async (conf, opts) => {
    const out = await orig(conf, opts);
    if (!done && conf.address <= address && address < conf.address + conf.quantity) { done = true; apply(); }
    return out;
  })(dev.mbRequest);
}

test('E8: Richtungswechsel zwischen zwei Lesungen erfindet kein Vorzeichen — weit entfernt: Richtung vorher/nachher', async () => {
  const dev = createRegisterDevice().set(100, 2000, FC4).set(500, 0, FC4);
  flipAfterFirstRead(dev, 500, () => dev.set(100, 700, FC4).set(500, 1, FC4));
  const conf = { fc: 4, address: 100, quantity: 1, direction: { address: 500, values: { 0: 1, 1: -1 } } };
  assert.equal(await readPointValue(conf, read(dev)), -700, 'früher 700 (Richtung „Laden“ von vorher mit neuem Betrag)');
  assert.deepEqual(dev.requests.map((r) => r.address), [500, 100, 500, 100, 500], 'Richtung, Wert, Richtung — zweiter Versuch passt');
});

test('E8: Richtung ändert sich bei jeder Lesung → Lesefehler nach drei Versuchen statt eines Mischwerts', async () => {
  const dev = createRegisterDevice().set(100, 2000, FC4).set(500, 0, FC4);
  dev.mbRequest = ((orig) => async (conf, opts) => {
    const out = await orig(conf, opts);
    if (conf.address === 100) dev.set(500, (await orig({ fc: 4, unitId: 1, address: 500, quantity: 1 }))[0] ? 0 : 1, FC4);
    return out;
  })(dev.mbRequest);
  const conf = { fc: 4, address: 100, quantity: 1, direction: { address: 500, values: { 0: 1, 1: -1 } } };
  await assert.rejects(() => readPointValue(conf, read(dev)), /Richtung @500 änderte sich bei jeder Lesung/);
});

test('E8: kennt das Gerät Register zwischen Wert und Richtung nicht (Ausnahme 2) → einzeln, Block je Poller nicht wieder', async () => {
  // Nur 33135 und 33149/33150 belegt: der Block 33135–33150 scheitert mit „illegal address“.
  const { state, poller, dev } = rig({ batteryPowerW: solisBattery() },
    (d) => d.set(33135, 1, FC4).set32(33149, 900, FC4));
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, -900);
  assert.equal(state.victron.errors.batteryPowerW, undefined);
  const first = dev.requests.filter((r) => r.address !== 900).map((r) => [r.address, r.quantity]);
  assert.deepEqual(first, [[33135, 16], [33135, 1], [33149, 2], [33135, 1]]);
  dev.requests.length = 0;
  await poller.requestPoll();
  assert.deepEqual(dev.requests.filter((r) => r.address !== 900).map((r) => [r.address, r.quantity]),
    [[33135, 1], [33149, 2], [33135, 1]], 'zweiter Takt ohne Block-Versuch');
});

test('E8: Zeitüberschreitung des Blocks bleibt ein Lesefehler (kein stiller Rückfall)', async () => {
  const dev = createRegisterDevice().setWords(10, [5, 0], FC4);
  const timeout = async () => { throw new Error('modbus timeout'); };
  await assert.rejects(() => readPointValue({ fc: 4, address: 10, quantity: 1, direction: { address: 11, values: { 0: 1 } } }, timeout),
    /modbus timeout/);
  assert.equal(dev.requests.length, 0);
});

// --- Kombinationen ---------------------------------------------------------------------------------------------

test('E8: combine-Eintrag mit eigener Richtung; combineBlock weist Richtungen ab; Richtung auf der Summe', async () => {
  const dev = createRegisterDevice().setWords(40, [300, 1, 200, 0], FC4);
  const sum = { fc: 4, combine: [{ address: 40, direction: { address: 41, values: { 0: 1, 1: -1 } } }, { address: 42 }] };
  assert.equal(await readPointValue(sum, read(dev)), -100, '−300 + 200');
  await assert.rejects(() => readPointValue({ ...sum, combineBlock: true }, read(dev)), /combineBlock: Einträge ohne split, sfAddress, sunspec und direction/);
  const onSum = { fc: 4, combine: [{ address: 40 }, { address: 42 }], direction: { address: 43, values: { 0: -1, 1: 1 } } };
  assert.equal(await readPointValue(onSum, read(dev)), -500, '|300 + 200| × Richtung 0 → −1');
});

test('E8: Zähler mit layout "point" nimmt die Richtung für die Summe; Phasen erben sie nicht; feste Layouts lehnen ab', async () => {
  const dev = createRegisterDevice().setWords(70, [1800, 0, 1], FC4).setWords(80, [600, 600, 600], FC4);
  const cfg = {
    gridPositiveMeans: 'grid_import',
    meter: {
      layout: 'point', fc: 4, unitId: 1, address: 70, quantity: 1, direction: { address: 72, values: { 0: 1, 1: -1 } },
      phases: [{ address: 80 }, { address: 81 }, { address: 82 }],
    },
  };
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -1800);
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [600, 600, 600],
    'Phasen ohne eigene Richtung: so gelesen, wie sie sind');

  const fixed = createRegisterDevice().setWords(900, [10, 20, 30]).set(905, 1);
  const r2 = createPollerRig({ meter: { fc: 3, address: 900, quantity: 3, unitId: 1, direction: { address: 905, values: { 1: -1 } } } }, fixed);
  await r2.poller.requestPoll();
  assert.equal(r2.state.meter.ok, false);
  assert.match(r2.state.meter.error, /meter\.direction.*layout "point"/);
});

test('E8: Wert mit Skalenfaktor (E5) und Richtung — Skalenfaktor-Block innen, Richtung vorher/nachher', async () => {
  const dev = createRegisterDevice().setWords(40083, [1234, 0xffff], FC4).set(40200, 1, FC4);
  const conf = { fc: 4, address: 40083, quantity: 1, sfAddress: 40084, direction: { address: 40200, values: { 0: 1, 1: -1 } } };
  assert.equal(await readPointValue(conf, read(dev)), -123.4);
  assert.deepEqual(dev.requests.map((r) => [r.address, r.quantity]), [[40200, 1], [40083, 2], [40200, 1]]);
});

// --- Profilfehler ------------------------------------------------------------------------------------------------

test('E8: ungültige Richtungs-Angaben sind Lesefehler mit klarer Meldung; nichts wird gelesen', async () => {
  const dev = createRegisterDevice().setWords(10, [5, 0], FC4);
  const reject = (direction, re, extra = {}) => assert.rejects(
    () => readPointValue({ fc: 4, address: 10, quantity: 1, direction, ...extra }, read(dev)), re);
  await reject({ values: { 0: 1 } }, /direction\.address/);
  await reject({ address: 'x', values: { 0: 1 } }, /direction\.address/);
  await reject({ address: 11 }, /direction\.values/);
  await reject({ address: 11, values: {} }, /direction\.values/);
  await reject({ address: 11, values: { 0: 2 } }, /direction\.values.*1 oder -1/);
  await reject({ address: 11, values: { 0: '1' } }, /direction\.values.*1 oder -1/);
  await reject({ address: 11, values: { a: 1 } }, /direction\.values.*Rohwert/);
  await reject({ address: 11, values: { 70000: 1 } }, /direction\.values.*Rohwert/);
  await reject([11], /direction/);
  await reject({ address: 11, values: { 0: 1 } }, /direction und sign/, { sign: -1 });
  assert.equal(dev.requests.length, 0);
});

// --- Null-Änderung -----------------------------------------------------------------------------------------------

test('E8: ohne `direction` genau ein read mit demselben conf-Objekt wie bisher', async () => {
  const seen = [];
  const conf = { fc: 3, address: 10, quantity: 1, signed: true, scale: 1, offset: 0 };
  const v = await readPointValue(conf, async (c, o) => { seen.push([c, o]); return [0xfff6]; });
  assert.equal(v, -10);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], conf, 'dasselbe Objekt');
});

// --- Echter Transport mit Registerdeckel (E7) --------------------------------------------------------------------

test('E8 + E7: Spanne über maxRegistersPerRequest → kein Lesefehler, sondern Richtung vorher/nachher auf dem Draht', async () => {
  enableFakeClock();
  const sockets = installFakeModbusSockets();
  const transport = createModbusTransport({ pacingFor: () => ({ maxRegistersPerRequest: 8 }) });
  try {
    sockets.set32(1, 33149, 2800).set(1, 33135, 1);
    const conf = { host: '192.0.2.91', port: 502, unitId: 1, timeoutMs: 1000, ...solisBattery() };
    const ctx = { sfBlockUnsupported: new Set() };
    const p = readPointValue(conf, (c, o) => transport.mbRequest(c, o), ctx).then((v) => v, (e) => e);
    await advance(100);
    assert.equal(await p, -2800);
    assert.deepEqual(sockets.wire.map((f) => `${f.address}x${f.quantity}`), ['33135x1', '33149x2', '33135x1'],
      'der 16er-Block geht nie auf den Draht, und nie in Teilen');
    const q = readPointValue(conf, (c, o) => transport.mbRequest(c, o), ctx);
    await advance(100);
    assert.equal(await q, -2800);
    assert.equal(sockets.wire.length, 6, 'zweite Lesung ohne Block-Versuch');
  } finally {
    await transport.destroy();
    await flush();
    sockets.restore();
    disableFakeClock();
  }
});
