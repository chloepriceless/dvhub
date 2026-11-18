// LG ESS Home 8/10 — mitgeliefertes Nur-Lese-Profil hersteller/lg-ess-home.json.
// Echter Ladeweg (loadConfigFile), echter Poller gegen ein Schein-Gerät (Port 6502, Unit 255, FC 3, High-Wort
// zuerst), echter Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Register: .planning/docs/research/2026-11-15-lgess-modbus-control-spec.md §2 (Port/Unit [HINT]) und die dort
// genannte Plexlog-Referenz [DECOMP] (feste Modellbasen: 103 ab 70, LG-Zähler ab 302, feste Skalenfaktoren).
// Akku und SoC (Modell 802) liest das Profil bewusst nicht: die Spec nennt keine Feldlage.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import {
  TEST_HOST, readShippedProfile, setupProfile, loadProfile, writeTargets, evaluatorWrites, writableVariant, dropdown, readSet,
} from './helpers/read-only-profile-rig.js';

const ID = 'lg-ess-home';
const UNIT = 255;
const PORT = 6502;

// Rohbild: Zähler I32 in 0,01 W (304–305, High-Wort zuerst), PV I16 in W (101). meter: Rohwert, + = Bezug.
function device({ meter = 150000, pv = 4200 } = {}) {
  return createRegisterDevice({ defaultUnitId: UNIT })
    .set32(304, meter)
    .set(101, pv);
}

function effective() {
  return loadProfile(ID).effectiveConfig;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('lg-ess-home.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen (auch was fehlt)', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /LG ESS Home 8\/10/);
  assert.match(raw.label, /— nur Anzeige$/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /^Nur Anzeige, keine Steuerung, am Gerät ungeprüft\./);
  assert.match(raw.help, /Akku-Leistung, Ladestand und Hauslast zeigt dieses Profil noch nicht an/);
  assert.match(raw.help, /docs\/hersteller\/lg-ess-home\.md/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus TCP 6502, Unit 255, Zähler als int32-Punkt 304 mit fester Skala, keine SunSpec-Auflösung', () => {
  const loaded = loadProfile(ID);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', PORT, UNIT]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.address, cfg.meter.readType, cfg.meter.scale, cfg.meter.sign, cfg.meter.phases],
    ['point', 3, 304, 'int32', 0.01, undefined, undefined]
  );
  assert.equal(cfg.meter.sunspec, undefined, 'LG-Zähler ist kein SunSpec-20x-Modell — feste Adresse');
  assert.equal(cfg.meter.sfAddress, undefined, 'Geräte-SF unzuverlässig — feste Skala');
  assert.deepEqual([cfg.meter.host, cfg.meter.port, cfg.meter.unitId], [TEST_HOST, PORT, UNIT]);
  assert.deepEqual(Object.keys(cfg.points).sort(), ['batteryPowerW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  const enabled = Object.entries(cfg.points).filter(([, p]) => p.enabled).map(([k]) => k);
  assert.deepEqual(enabled, ['pvPowerW'], 'nur PV wird gelesen');
  const pv = cfg.points.pvPowerW;
  assert.deepEqual([pv.fc, pv.address, pv.signed, pv.scale, pv.host, pv.port, pv.unitId], [3, 101, true, 1, TEST_HOST, PORT, UNIT]);
  for (const name of ['soc', 'batteryPowerW', 'selfConsumptionW']) {
    assert.equal(cfg.points[name].derive, undefined, `${name}: keine Ableitung (Akku fehlt)`);
    assert.equal(cfg.points[name].address, undefined, `${name}: keine Adresse`);
  }
  assert.equal(cfg.identify, undefined);
});

test('Schreiben: null Schreibziele und null Abregel-Ziele, auch mit dvControl.enabled:true in config.json', () => {
  const cfg = effective();
  assert.deepEqual(writeTargets(cfg), []);
  assert.deepEqual(cfg.controlWrite, {});
  assert.equal(cfg.dvControl.enabled, false, 'config.json schaltet die Abregelung nicht ein');
  assert.equal(cfg.dvControl.negativePriceProtection.enabled, false);
});

test('Draht: alle Schreibwege des Evaluators (Sollwerte, Abregelung, Negativpreis) → kein einziger Modbus-Write', async () => {
  assert.deepEqual(await evaluatorWrites(effective()), []);
});

test('Draht-Gegenprobe: dasselbe Profil OHNE readOnly und mit Schreibzielen schreibt — der Prüfstand sieht Writes', async () => {
  const cfg = loadProfile(ID, { editProfile: writableVariant }).effectiveConfig;
  const addrs = new Set((await evaluatorWrites(cfg)).map(([address]) => address));
  assert.ok(addrs.has(1111), `Netz-Sollwert muss auf dem Draht landen (gesehen: ${[...addrs]})`);
  assert.ok(addrs.has(40010), `Abregel-Flag muss auf dem Draht landen (gesehen: ${[...addrs]})`);
});

// --- Dekodieren über den echten Poller ------------------------------------------------------------------------------

test('Poller (Tag): Bezug 150000 × 0,01 → +1500 W, PV 4200 W, kein Akku/SoC/Hauslast, nur zwei Register', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, 1500, '304 Rohwert 150000 × 0,01 W, + = Bezug ohne Drehung');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.gridImportW, 1500);
  assert.equal(state.victron.gridExportW, 0);
  assert.equal(state.victron.pvPowerW, 4200);
  assert.equal(state.victron.soc, undefined, 'SoC wird nicht gelesen');
  assert.equal(state.victron.batteryPowerW, undefined, 'Akku wird nicht gelesen');
  assert.equal(state.victron.selfConsumptionW ?? null, null, 'keine Hauslast ohne Akku');

  // Gelesen werden genau die zwei Profilregister — kein SunSpec-Scan (40000/50000/0), kein Modell 802, kein Victron.
  assert.deepEqual(readSet(dev.requests), [`3:${UNIT}:101x1`, `3:${UNIT}:304x2`]);
  assert.ok(dev.requests.every((r) => r.host === TEST_HOST && r.port === PORT));
  assert.deepEqual(dev.writes, []);
});

test('Poller (Nacht, zweiter Takt): Einspeisung (I32 negativ) → Netz negativ, PV I16 vorzeichenbehaftet', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 1500);

  dev.set32(304, -320000).set(101, 0xfffd);
  await poller.requestPoll();
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -3200, '−320000 × 0,01 W');
  assert.equal(state.victron.gridExportW, 3200);
  assert.equal(state.victron.gridImportW, 0);
  assert.equal(state.victron.pvPowerW, -3, '0xFFFD = −3 W (I16)');
  assert.equal(dev.requests.length, 4, 'zwei Register je Takt, sonst nichts');
});

test('Poller: „nicht implementiert“ (SunSpec I32 0x80000000, I16 0x8000) → Zählerfehler bzw. leer', async () => {
  const cfg = effective();
  const dev = createRegisterDevice({ defaultUnitId: UNIT }).setWords(304, [0x8000, 0x0000]).set(101, 0x8000);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false, 'Netz ohne Wert ist ein Zählerfehler, nie −21 474 836 W');
  assert.match(state.meter.error, /keinen Gesamtwert/);
  assert.equal(state.victron.pvPowerW, null, '0x8000 ist kein −32 768 W');
});

// --- Beta-Gate -------------------------------------------------------------------------------------------------

test('Dropdown: im Stable-Kanal ausgeblendet, im Bleeding-Edge-Kanal sichtbar, aktiv immer sichtbar', () => {
  const configPath = setupProfile(ID);
  const values = (list) => list.map((o) => o.value);
  assert.ok(!values(dropdown(configPath, 'stable')).includes(ID), 'stable: ausgeblendet');
  const dev = dropdown(configPath, 'dev').find((o) => o.value === ID);
  assert.ok(dev, 'dev: sichtbar');
  assert.equal(dev.beta, true);
  assert.match(dev.label, /LG ESS Home.*nur Anzeige/);
  assert.ok(values(dropdown(configPath, 'stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
