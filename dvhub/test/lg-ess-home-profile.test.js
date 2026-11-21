// LG ESS Home 8/10 — mitgeliefertes Nur-Lese-Profil hersteller/lg-ess-home.json.
// Echter Ladeweg (loadConfigFile), echter Poller gegen ein Schein-Gerät (Port 6502, Unit 255, FC 3, High-Wort
// zuerst), echter Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Register: .planning/docs/research/2026-11-15-lgess-modbus-control-spec.md §2 (Port/Unit [HINT]) und die dort
// genannte Plexlog-Referenz [DECOMP] (feste Modellbasen: 103 ab 70, Modell 802 ab 238, LG-Zähler ab 302, feste
// Skalenfaktoren). Akku und SoC aus Modell 802 in der SunSpec-Standardlage (SoC Kopf+11 = 249, W Kopf+47 = 285) —
// Christins Entscheidung 19.11.2026: aufnehmen, als ungeprüft kennzeichnen. Vorzeichen des Akkus aus der Referenz
// abgeleitet (Rohwert + = Entladen), am Gerät ungeprüft.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import {
  TEST_HOST, readShippedProfile, setupProfile, loadProfile, writeTargets, evaluatorWrites, writableVariant, dropdown, readSet,
} from './helpers/read-only-profile-rig.js';

const ID = 'lg-ess-home';
const UNIT = 255;
const PORT = 6502;

// Rohbild: Zähler I32 in 0,01 W (304–305, High-Wort zuerst), PV I16 in W (101), SoC U16 in 0,1 % (249), Akku I16 in
// W (285). meter: Rohwert, + = Bezug. Akku: Rohwert, + = Entladen (Annahme aus der Referenz), − = Laden.
function device({ meter = 150000, pv = 4200, soc = 655, battery = 0 } = {}) {
  return createRegisterDevice({ defaultUnitId: UNIT })
    .set32(304, meter)
    .set(101, pv)
    .set(249, soc)
    .set(285, battery);
}

function effective() {
  return loadProfile(ID).effectiveConfig;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('lg-ess-home.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen (auch dass der Akku ungeprüft ist)', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /LG ESS Home 8\/10/);
  assert.match(raw.label, /— nur Anzeige$/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /^Nur Anzeige, keine Steuerung, am Gerät ungeprüft\./);
  assert.match(raw.help, /Akku-Leistung und Ladestand/);
  assert.match(raw.help, /Hauslast aus der Energiebilanz/);
  assert.doesNotMatch(raw.help, /noch nicht an/, 'der Hilfetext behauptet keine fehlenden Werte mehr');
  assert.match(raw.help, /Vorzeichen von Netz und Akku/, 'beide unbelegten Vorzeichen offen genannt');
  assert.match(raw.help, /docs\/hersteller\/lg-ess-home\.md/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
  // Jede Annahme steht im Kommentar des Punkts — mit der Gegenlesart und woran man sie am Gerät erkennt.
  assert.match(raw.points.batteryPowerW._comment, /UNSICHER/);
  assert.match(raw.points.batteryPowerW._comment, /sign/);
  assert.match(raw.points.soc._comment, /UNSICHER/);
});

test('Laden: Akku und SoC aus Modell 802 (Basis 238) mit fester Skala, Akku gedreht, Hauslast aus Energiebilanz', () => {
  const cfg = effective();
  const soc = cfg.points.soc;
  assert.equal(soc.enabled, true);
  assert.deepEqual(
    [soc.fc, soc.address, soc.quantity, soc.signed, soc.scale, soc.sign, soc.readType, soc.sfAddress, soc.sunspec],
    [3, 238 + 11, 1, false, 0.1, undefined, undefined, undefined, undefined],
    'SoC U16 an Kopf+11, SoC_SF fest −1 (Referenz), keine Geräte-SF'
  );
  assert.deepEqual(soc.notAvailableRaw, [0xffff], 'SunSpec U16 „nicht implementiert“');
  assert.deepEqual([soc.host, soc.port, soc.unitId], [TEST_HOST, PORT, UNIT]);
  const bat = cfg.points.batteryPowerW;
  assert.equal(bat.enabled, true);
  assert.deepEqual(
    [bat.fc, bat.address, bat.quantity, bat.signed, bat.scale, bat.sign, bat.readType, bat.sfAddress, bat.sunspec],
    [3, 238 + 47, 1, true, 1, -1, undefined, undefined, undefined],
    'W I16 an Kopf+47, W_SF fest 0 (Referenz), Rohwert + = Entladen → sign −1'
  );
  assert.deepEqual(bat.notAvailableRaw, [0x8000], 'SunSpec I16 „nicht implementiert“');
  assert.deepEqual([bat.host, bat.port, bat.unitId], [TEST_HOST, PORT, UNIT]);
  assert.equal(cfg.points.selfConsumptionW.enabled, false, 'kein Lastregister');
  assert.equal(cfg.points.selfConsumptionW.derive, 'energy_balance');
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
  const enabled = Object.entries(cfg.points).filter(([, p]) => p.enabled).map(([k]) => k).sort();
  assert.deepEqual(enabled, ['batteryPowerW', 'pvPowerW', 'soc'], 'PV, Akku und SoC werden gelesen, die Last abgeleitet');
  const pv = cfg.points.pvPowerW;
  assert.deepEqual([pv.fc, pv.address, pv.signed, pv.scale, pv.host, pv.port, pv.unitId], [3, 101, true, 1, TEST_HOST, PORT, UNIT]);
  assert.equal(cfg.points.selfConsumptionW.address, undefined, 'Hauslast: keine Adresse');
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

test('Poller (Tag, Akku lädt): 802 W −1800 → Laden +1800, SoC 65,5 %, Einspeisung, Hauslast aus der Bilanz', async () => {
  const cfg = effective();
  const dev = device({ meter: -30000, pv: 4200, soc: 655, battery: -1800 });
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -300, '304 Rohwert −30000 × 0,01 W, + = Bezug ohne Drehung');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.gridExportW, 300);
  assert.equal(state.victron.gridImportW, 0);
  assert.equal(state.victron.pvPowerW, 4200);
  assert.equal(state.victron.soc, 65.5, '249 Rohwert 655 × 0,1 %');
  assert.equal(state.victron.batteryPowerW, 1800, '285 Rohwert −1800 (− = Laden) → DVhub +1800 Laden');
  assert.equal(state.victron.batteryChargeW, 1800);
  assert.equal(state.victron.batteryDischargeW, 0);
  // 4200 PV + 0 Bezug − 300 Einspeisung − 1800 Laden
  assert.equal(state.victron.selfConsumptionW, 2100);
  assert.equal(state.victron.selfConsumptionDerived, true);

  // Gelesen werden genau die vier Profilregister — kein SunSpec-Scan (40000/50000/0), kein Kopf von 802, kein Victron.
  assert.deepEqual(readSet(dev.requests), [`3:${UNIT}:101x1`, `3:${UNIT}:249x1`, `3:${UNIT}:285x1`, `3:${UNIT}:304x2`]);
  assert.equal(dev.requests.length, 4, 'ein Takt: vier Anfragen');
  assert.ok(dev.requests.every((r) => r.host === TEST_HOST && r.port === PORT));
  assert.deepEqual(dev.writes, []);
});

test('Poller (Nacht, zweiter Takt): Bezug, 802 W +1300 → Entladen −1300, SoC 31,2 %, Hauslast folgt dem Takt', async () => {
  const cfg = effective();
  const dev = device({ meter: -30000, pv: 4200, soc: 655, battery: -1800 });
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 2100);

  dev.set32(304, 150000).set(101, 0).set(249, 312).set(285, 1300);
  await poller.requestPoll();
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, 1500, '150000 × 0,01 W');
  assert.equal(state.victron.gridImportW, 1500);
  assert.equal(state.victron.gridExportW, 0);
  assert.equal(state.victron.pvPowerW, 0);
  assert.equal(state.victron.soc, 31.2);
  assert.equal(state.victron.batteryPowerW, -1300, '285 Rohwert +1300 (+ = Entladen) → DVhub −1300');
  assert.equal(state.victron.batteryDischargeW, 1300);
  assert.equal(state.victron.batteryChargeW, 0);
  // 0 PV + 1500 Bezug + 1300 Entladen (E6: folgt jedem Takt, nicht der Wert des ersten)
  assert.equal(state.victron.selfConsumptionW, 2800);
  assert.equal(dev.requests.length, 8, 'vier Register je Takt, sonst nichts');
});

test('Poller: Einspeisung (I32 negativ) → Netz negativ, PV I16 vorzeichenbehaftet', async () => {
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
});

test('Poller: „nicht implementiert“ (SunSpec I32 0x80000000, I16 0x8000) → Zählerfehler bzw. leer', async () => {
  const cfg = effective();
  const dev = createRegisterDevice({ defaultUnitId: UNIT }).setWords(304, [0x8000, 0x0000]).set(101, 0x8000)
    .set(249, 500).set(285, 0);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false, 'Netz ohne Wert ist ein Zählerfehler, nie −21 474 836 W');
  assert.match(state.meter.error, /keinen Gesamtwert/);
  assert.equal(state.victron.pvPowerW, null, '0x8000 ist kein −32 768 W');
  assert.equal(state.victron.selfConsumptionW ?? null, null, 'ohne Netz und PV keine Bilanz');
});

test('Poller: Akku „kein Wert“ (SoC U16 0xFFFF, W I16 0x8000) → leer statt 6553,5 % bzw. +32 768 W, keine Hauslast', async () => {
  const cfg = effective();
  const dev = device({ soc: 0xffff, battery: 0x8000 });
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.soc, null, '0xFFFF ist kein Ladestand von 6553,5 %');
  assert.equal(state.victron.batteryPowerW, null, '0x8000 ist kein Laden mit 32 768 W (nach sign −1)');
  assert.equal(state.victron.selfConsumptionW ?? null, null, 'Akku konfiguriert, aber ohne Wert → keine erfundene Last');
  assert.equal(state.meter.ok, true, 'Netz bleibt gültig');
  assert.equal(state.meter.grid_total_w, 1500);
  assert.equal(state.victron.pvPowerW, 4200, 'PV bleibt gültig');
});

test('Poller: Gerät ohne Modell 802 an 238 (Lesefehler) → Akku/SoC leer, keine Hauslast, Netz und PV bleiben', async () => {
  const cfg = effective();
  const dev = createRegisterDevice({ defaultUnitId: UNIT }).set32(304, 150000).set(101, 4200);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.match(String(state.victron.errors.soc), /exception 2/);
  assert.match(String(state.victron.errors.batteryPowerW), /exception 2/);
  assert.equal(state.victron.soc ?? null, null);
  assert.equal(state.victron.batteryPowerW ?? null, null);
  assert.equal(state.victron.selfConsumptionW ?? null, null, 'ohne Akku keine Bilanz — auch nicht mit Akku = 0 W');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, 1500);
  assert.equal(state.victron.pvPowerW, 4200);
  assert.deepEqual(dev.writes, []);
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
