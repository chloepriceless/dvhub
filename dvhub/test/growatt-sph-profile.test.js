// Growatt SPH (Speicher-Block 1000+) — mitgeliefertes Nur-Lese-Profil hersteller/growatt-sph.json.
// Echter Ladeweg (loadConfigFile), echter Poller gegen ein Schein-Gerät (Unit 1, FC 4 Input, High-Wort zuerst,
// Leistungen 0,1 W), echter Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Register: .planning/docs/research/2026-11-15-growatt-modbus-control-spec.md §2 [DECOMP]/[COMM] und evcc
// growatt-hybrid.yaml [COMM] (Netz 1021 − 1029, Akku 1009 − 1011 bei evcc + = Entladen, PV Input 1, SoC 1014).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import {
  TEST_HOST, readShippedProfile, setupProfile, loadProfile, writeTargets, evaluatorWrites, writableVariant, dropdown, readSet,
} from './helpers/read-only-profile-rig.js';

const ID = 'growatt-sph';
const FC4 = { fc: 4 };

// Rohbild in 0,1 W (U32, High-Wort zuerst), SoC in %. Alle Beträge ≥ 0 — das Vorzeichen entsteht aus der Differenz.
function device({ pv = 52000, toUser = 0, toGrid = 9000, charge = 18000, discharge = 0, soc = 66, load = 25000 } = {}) {
  const dev = createRegisterDevice({ defaultUnitId: 1 })
    .set32(1, pv, FC4)
    .set32(1021, toUser, FC4)
    .set32(1029, toGrid, FC4)
    .set32(1011, charge, FC4)
    .set32(1009, discharge, FC4)
    .set(1014, soc, FC4);
  if (load != null) dev.set32(1037, load, FC4);
  return dev;
}

function effective() {
  return loadProfile(ID).effectiveConfig;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('growatt-sph.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /Growatt SPH/);
  assert.match(raw.label, /— nur Anzeige$/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /^Nur Anzeige, keine Steuerung, am Gerät ungeprüft\./);
  assert.match(raw.help, /Community-Quellen/, 'Hilfetext nennt die schwache Beleglage');
  assert.match(raw.help, /docs\/hersteller\/growatt-sph\.md/);
  assert.equal(raw.identify, undefined, 'keine Geräte-/Familienerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus TCP 502, Unit 1, Zähler = Differenz zweier U32 (FC 4), alle Punkte Input-Register', () => {
  const loaded = loadProfile(ID);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', 502, 1]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.readType, cfg.meter.scale, cfg.meter.sign, cfg.meter.phases],
    ['point', 4, 'uint32', 0.1, undefined, undefined]
  );
  assert.deepEqual(cfg.meter.combine, [{ address: 1021 }, { address: 1029, sign: -1 }]);
  assert.deepEqual(Object.keys(cfg.points).sort(), ['batteryPowerW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    assert.equal(p.enabled, true);
    assert.equal(p.fc, 4, 'Growatt: Input-Register (Holding 1037 wäre der CT-Modus)');
    assert.equal(p.host, TEST_HOST);
    assert.equal(p.unitId, 1);
  }
  assert.deepEqual(cfg.points.batteryPowerW.combine, [{ address: 1011 }, { address: 1009, sign: -1 }]);
  assert.equal(cfg.points.selfConsumptionW.address, 1037);
  assert.equal(cfg.points.selfConsumptionW.derive, 'energy_balance', 'Rückfall, wenn 1037 keinen Wert liefert');
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

test('Poller (Tag): Einspeisung 1029 → Netz negativ, Laden 1011 → Akku positiv, 0,1-W-Skala, Last aus 1037', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -900, '(0 − 9000) × 0,1 W');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.gridExportW, 900);
  assert.equal(state.victron.gridImportW, 0);
  assert.equal(state.victron.soc, 66);
  assert.equal(state.victron.batteryPowerW, 1800, '(18000 − 0) × 0,1 W = Laden');
  assert.equal(state.victron.batteryChargeW, 1800);
  assert.equal(state.victron.pvPowerW, 5200);
  assert.equal(state.victron.selfConsumptionW, 2500, 'gemessen (1037), nicht abgeleitet');
  assert.notEqual(state.victron.selfConsumptionDerived, true);

  // Gelesen werden genau die Profilregister per FC 04 — kein Holding-Register (FC 03 1037 = CT-Modus), kein Victron.
  assert.deepEqual(readSet(dev.requests), [
    '4:1:1009x2', '4:1:1011x2', '4:1:1014x1', '4:1:1021x2', '4:1:1029x2', '4:1:1037x2', '4:1:1x2',
  ]);
  assert.ok(dev.requests.every((r) => r.host === TEST_HOST && r.port === 502));
  assert.deepEqual(dev.writes, []);
});

test('Poller (Nacht, zweiter Takt): Bezug 1021 → Netz positiv, Entladen 1009 → Akku negativ, Last folgt', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 2500);

  dev.set32(1, 0, FC4).set32(1021, 6000, FC4).set32(1029, 0, FC4).set32(1011, 0, FC4).set32(1009, 15000, FC4)
    .set(1014, 35, FC4).set32(1037, 21000, FC4);
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 600);
  assert.equal(state.victron.gridImportW, 600);
  assert.equal(state.victron.batteryPowerW, -1500);
  assert.equal(state.victron.batteryDischargeW, 1500);
  assert.equal(state.victron.soc, 35);
  assert.equal(state.victron.pvPowerW, 0);
  assert.equal(state.victron.selfConsumptionW, 2100);
});

test('Poller: 1037 fehlt (Fehler) oder meldet „kein Wert“ → Hauslast aus der Energiebilanz, in jedem Takt neu', async () => {
  const cfg = effective();
  const dev = device({ load: null }); // 1037 fehlt → Ausnahme 2
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.ok(dev.requests.some((r) => r.fc === 4 && r.address === 1037), '1037 wurde versucht');
  assert.equal(state.victron.errors.selfConsumptionW, undefined, 'die gelungene Bilanz ersetzt den Lesefehler');
  // 5200 PV + 0 Bezug − 900 Einspeisung − 1800 Laden
  assert.equal(state.victron.selfConsumptionW, 2500);
  assert.equal(state.victron.selfConsumptionDerived, true);

  dev.set32(1, 30000, FC4).set32(1029, 4000, FC4);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 800, '3000 − 400 − 1800: folgt dem zweiten Takt (E6)');

  const nan = device();
  nan.setWords(1037, [0xffff, 0xffff], FC4);
  const r2 = createPollerRig(effective(), nan);
  await r2.poller.requestPoll();
  assert.equal(r2.state.victron.selfConsumptionW, 2500, '0xFFFFFFFF ist keine Last von 429 MW');
  assert.equal(r2.state.victron.selfConsumptionDerived, true);
});

test('Poller: „kein Wert“ (U32 0xFFFFFFFF, U16 0xFFFF) → Zählerfehler bzw. leer, keine erfundene Hauslast', async () => {
  const cfg = effective();
  const dev = device({ load: null });
  dev.setWords(1029, [0xffff, 0xffff], FC4).setWords(1009, [0xffff, 0xffff], FC4)
    .setWords(1, [0xffff, 0xffff], FC4).set(1014, 0xffff, FC4);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false, 'ein Netz-Summand ohne Wert ist ein Zählerfehler');
  assert.match(state.meter.error, /keinen Gesamtwert/);
  assert.equal(state.victron.batteryPowerW, null);
  assert.equal(state.victron.pvPowerW, null);
  assert.equal(state.victron.soc, null);
  assert.equal(state.victron.selfConsumptionW ?? null, null);
});

// --- Beta-Gate -------------------------------------------------------------------------------------------------

test('Dropdown: im Stable-Kanal ausgeblendet, im Bleeding-Edge-Kanal sichtbar, aktiv immer sichtbar', () => {
  const configPath = setupProfile(ID);
  const values = (list) => list.map((o) => o.value);
  assert.ok(!values(dropdown(configPath, 'stable')).includes(ID), 'stable: ausgeblendet');
  const dev = dropdown(configPath, 'dev').find((o) => o.value === ID);
  assert.ok(dev, 'dev: sichtbar');
  assert.equal(dev.beta, true);
  assert.match(dev.label, /Growatt SPH.*nur Anzeige/);
  assert.ok(values(dropdown(configPath, 'stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
