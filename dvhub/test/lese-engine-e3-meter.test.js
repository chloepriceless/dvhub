// E3 (Lese-Engine, 18.11.2026): Netzzähler für die neuen Hersteller.
//  (a) `scale` und `sign` auf allen Modbus-Layouts (Standard 3×s16, float32, int32 samt Ersatzregister). Bisher galt
//      der Rohwert immer als „Bezug positiv“, ohne Skala; gridPositiveMeans dreht nur die AUSGABE.
//  (b) `layout: "point"`: der Zähler ist ein gewöhnlicher Lesepunkt (derselbe Decoder wie points.*: u16/s16/int32/
//      uint32/float32, combine, split, sfAddress). Phasen fehlen (null) oder stehen einzeln in `phases`. Der feste
//      8-Register-Block [Summe, L1, L2, L3] las bei Huawei/E3DC/Kostal/Solis/SolaX/GoodWe fremde Register als Phasen.
//  (c) SunSpec-Auflösung für `meter` (und seine Phasen), inkl. Skalenfaktor (sfOffset).
// Konvention im Zustand unverändert: grid_total_w nach gridPositiveMeans, gridImportW/gridExportW ≥ 0.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';

async function poll(meter, image, { gridPositiveMeans = 'grid_import', victron } = {}) {
  const dev = createRegisterDevice();
  image(dev);
  const cfg = { meter, gridPositiveMeans, ...(victron ? { victron } : {}) };
  const rig = createPollerRig(cfg, dev);
  await rig.poller.requestPoll();
  return { ...rig, dev, cfg };
}

// ── (a) Skala und Vorzeichen auf den bestehenden Layouts ────────────────────────────────────────────────────────

test('E3a: Standard-Layout mit scale und sign (SOFAR 0x0488: I16, 0,01 kW, + = Einspeisung)', async () => {
  const { state } = await poll({ fc: 3, address: 0x0488, quantity: 1, unitId: 1, scale: 10, sign: -1 }, (d) => d.set(0x0488, 150));
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -1500);
  assert.equal(state.victron.gridExportW, 1500, '150 × 10 W, Gerät meldet Einspeisung positiv');
  assert.equal(state.victron.gridImportW, 0);
});

test('E3a: Standard-Layout mit gebrochener Skala rundet auf ganze Watt; feed_in-Ausgabe dreht wie bisher', async () => {
  const { state } = await poll({ fc: 3, address: 10, quantity: 3, unitId: 1, scale: 0.1 }, (d) => d.setWords(10, [1235, 1000, -2000]), { gridPositiveMeans: 'feed_in' });
  assert.equal(state.meter.grid_l1_w, -124, '123,5 W Bezug → feed_in negativ');
  assert.equal(state.meter.grid_total_w, -24, 'Summe 23,5 W Bezug: erst runden, dann Ausgabe-Konvention');
  assert.equal(state.victron.gridImportW, 24, 'gleich viel Bezug wie bei grid_import');
});

test('E3a: float32-Layout mit sign −1 (Gerät: + = Einspeisung)', async () => {
  const { state } = await poll({ fc: 3, address: 100, quantity: 8, readType: 'float32', unitId: 1, sign: -1 }, (d) => {
    [2400, 800, 800, 800].forEach((w, i) => d.setFloat32(100 + i * 2, w));
  });
  assert.equal(state.meter.grid_total_w, -2400);
  assert.equal(state.meter.grid_l2_w, -800);
  assert.equal(state.victron.gridExportW, 2400);
});

test('E3a: int32-Layout mit scale 0,1 und sign −1; Ersatzregister mit eigener Skala/Vorzeichen', async () => {
  const { state } = await poll({ fc: 4, address: 200, quantity: 8, readType: 'int32', unitId: 1, scale: 0.1, sign: -1 }, (d) => {
    [30000, 10000, 10000, 10000].forEach((w, i) => d.set32(200 + i * 2, w, { fc: 4 }));
  });
  assert.equal(state.meter.grid_total_w, -3000);
  assert.equal(state.meter.grid_l1_w, -1000);

  const fb = await poll({ fc: 4, address: 200, quantity: 8, readType: 'int32', unitId: 1, sign: -1, fallback: { fc: 4, address: 300, scale: 2, sign: -1 } },
    (d) => d.set32(300, 600, { fc: 4 }));
  assert.equal(fb.state.meter.ok, true, fb.state.meter.error);
  assert.equal(fb.state.meter.source, 'fallback');
  assert.equal(fb.state.meter.grid_total_w, -1200, 'Ersatzregister: 600 × 2 × (−1), meter.sign gilt dort nicht');
});

test('E3a: ungültige Zähler-Skala ist ein Lesefehler (kein NaN im Steuerpfad)', async () => {
  const { state } = await poll({ fc: 3, address: 10, quantity: 1, unitId: 1, scale: 'zehn' }, (d) => d.set(10, 5));
  assert.equal(state.meter.ok, false);
  assert.match(state.meter.error, /meter\.scale/);
});

// ── (b) Zähler als Lesepunkt ────────────────────────────────────────────────────────────────────────────────────

test('E3b: layout point — int32 nur Summe (E3/DC 40074, + = Bezug), Phasen null statt fremder Register', async () => {
  const { state, dev } = await poll({ layout: 'point', fc: 3, address: 40074, readType: 'int32', unitId: 1 }, (d) => {
    d.set32(40074, -2750).set32(40076, 1111).set32(40078, 2222).set32(40080, 3333);
  });
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -2750);
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.deepEqual(dev.requests.map((r) => [r.address, r.quantity]), [[40074, 2]], 'nur die Summe gelesen');
});

test('E3b: layout point — Summe und einzeln adressierte Phasen (Huawei 37113 / 37132–37136), sign −1 gilt für alle', async () => {
  const meter = {
    layout: 'point', fc: 3, address: 37113, readType: 'int32', unitId: 1, sign: -1,
    phases: [{ address: 37132 }, { address: 37134 }, { address: 37136 }],
  };
  const { state } = await poll(meter, (d) => {
    d.set32(37113, 1800).set32(37132, 600).set32(37134, 500).set32(37136, 700);
  });
  assert.equal(state.meter.grid_total_w, -1800, 'Gerät: + = Einspeisung');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [-600, -500, -700]);
  assert.equal(state.victron.gridExportW, 1800);
});

test('E3b: layout point — float32 CDAB (Kostal 0xFC, wordOrder le) und S32 Low-Wort zuerst (SolaX 0x46, + = Einspeisung)', async () => {
  const kostal = await poll({ layout: 'point', fc: 3, address: 0xfc, readType: 'float32', wordOrder: 'le', unitId: 71 }, (d) => {
    d.setFloat32(0xfc, 812.6, { wordOrder: 'le', unitId: 71 });
  });
  assert.equal(kostal.state.meter.grid_total_w, 813);
  const solax = await poll({ layout: 'point', fc: 4, address: 0x46, readType: 'int32', wordOrder: 'le', sign: -1, unitId: 1 }, (d) => {
    d.set32(0x46, -950, { wordOrder: 'le', fc: 4 });
  });
  assert.equal(solax.state.meter.grid_total_w, 950, 'SolaX −950 (Bezug) mit sign −1 → +950 Bezug');
  assert.equal(solax.state.victron.gridImportW, 950);
});

test('E3b: layout point mit combine (SMA 30865 Bezug − 30867 Einspeisung, Unit 3)', async () => {
  const meter = { layout: 'point', fc: 3, unitId: 3, readType: 'int32', combine: [{ address: 30865 }, { address: 30867, sign: -1 }] };
  const { state } = await poll(meter, (d) => d.set32(30865, 0, { unitId: 3 }).set32(30867, 4200, { unitId: 3 }));
  assert.equal(state.meter.grid_total_w, -4200);
  assert.equal(state.victron.gridExportW, 4200);
});

test('E3b: Summe ohne Wert → Zählerfehler; Phasenfehler → Phase null, Zähler bleibt gültig', async () => {
  const na = await poll({ layout: 'point', fc: 3, address: 10, readType: 'int32', unitId: 1, notAvailableRaw: [0x7fffffff] }, (d) => d.set32(10, 0x7fffffff));
  assert.equal(na.state.meter.ok, false);
  assert.match(na.state.meter.error, /keinen Gesamtwert/);

  const ph = await poll({ layout: 'point', fc: 3, address: 10, unitId: 1, signed: true, phases: [{ address: 11 }, { address: 12 }, { address: 13 }] },
    (d) => d.set(10, -300).set(11, -100).set(13, -100)); // 12 fehlt
  assert.equal(ph.state.meter.ok, true, ph.state.meter.error);
  assert.equal(ph.state.meter.grid_total_w, -300);
  assert.deepEqual([ph.state.meter.grid_l1_w, ph.state.meter.grid_l2_w, ph.state.meter.grid_l3_w], [-100, null, -100]);
  assert.ok(ph.logs.some((l) => l.event === 'meter_phase_read_error'));

  const noAddr = await poll({ layout: 'point', fc: 3, unitId: 1 }, () => {});
  assert.equal(noAddr.state.meter.ok, false);
  assert.match(noAddr.state.meter.error, /Registeradresse fehlt/);
});

test('E3b: layout point mit split (Deye HP3 Netz 622 low / 687 high)', async () => {
  const { state } = await poll({ layout: 'point', fc: 3, unitId: 1, readType: 'int32', split: { low: 622, high: 687 } }, (d) => {
    const raw = -40000 + 0x100000000;
    d.set(622, raw & 0xffff).set(687, Math.floor(raw / 0x10000));
  });
  assert.equal(state.meter.grid_total_w, -40000);
});

// ── (c) SunSpec-Zähler ──────────────────────────────────────────────────────────────────────────────────────────

const V = { host: '192.0.2.1', port: 502, unitId: 1, timeoutMs: 1000 };

test('E3c: SunSpec-Zähler (Modell 203, int+SF): W @16, Phasen @17–19, W_SF @20 — aufgelöst per Scan', async () => {
  const dev = createRegisterDevice();
  const at = dev.setSunspecChain(40000, [{ id: 1, length: 66 }, { id: 101, length: 50 }, { id: 203, length: 105 }]);
  const b = at[203][0];
  dev.setWords(b + 16, [-23456 & 0xffff, -7000 & 0xffff, -8000 & 0xffff, -8456 & 0xffff, -1 & 0xffff]);
  const cfg = {
    victron: V,
    meter: {
      layout: 'point', fc: 3, unitId: 1, signed: true, sign: -1,
      sunspec: { model: 203, offset: 16, sfOffset: 20 },
      phases: [{ sunspec: { model: 203, offset: 17 } }, { sunspec: { model: 203, offset: 18 } }, { sunspec: { model: 203, offset: 19 } }],
    },
  };
  const { state, poller, logs } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(cfg.meter.address, b + 16);
  assert.equal(cfg.meter.sfAddress, b + 20);
  assert.equal(state.meter.grid_total_w, 2346, '−23456 × 0,1 × (−1) → Bezug 2345,6 W');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [700, 800, 846]);
  assert.ok(logs.some((l) => l.event === 'sunspec_scan_ok'));
});

test('E3c: SunSpec-Zähler vor/ohne Auflösung liest nie mit Adresse null (Zählerfehler statt Müll)', async () => {
  const dev = createRegisterDevice(); // kein SunS-Marker
  const cfg = { victron: V, meter: { layout: 'point', fc: 3, unitId: 1, sunspec: { model: 203, offset: 16 } } };
  const { state, poller, logs } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false);
  assert.match(state.meter.error, /SunSpec/);
  assert.ok(logs.some((l) => l.event === 'sunspec_scan_error'));
  assert.ok(dev.requests.every((r) => typeof r.address === 'number'));

  // Modell fehlt am Gerät: bleibt unaufgelöst, Zählerfehler.
  const dev2 = createRegisterDevice();
  dev2.setSunspecChain(40000, [{ id: 1, length: 66 }]);
  const rig2 = createPollerRig({ victron: V, meter: { fc: 3, readType: 'float32', unitId: 1, sunspec: { model: 213, offset: 16 } } }, dev2);
  await rig2.poller.requestPoll();
  assert.equal(rig2.state.meter.ok, false);
  assert.match(rig2.state.meter.error, /SunSpec/);
});

test('E3c: SunSpec-Auflösung auch für das float32-Layout (Modell 213: W, WphA–C je Float32 hintereinander)', async () => {
  const dev = createRegisterDevice();
  const at = dev.setSunspecChain(40000, [{ id: 1, length: 66 }, { id: 213, length: 124 }]);
  const b = at[213][0];
  [1500, 400, 500, 600].forEach((w, i) => dev.setFloat32(b + 16 + i * 2, w));
  const cfg = { victron: V, meter: { fc: 3, quantity: 8, readType: 'float32', unitId: 1, sunspec: { model: 213, offset: 16 } } };
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, 1500);
  assert.equal(state.meter.grid_l3_w, 600);
});
