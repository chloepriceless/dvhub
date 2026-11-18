// FoxESS H1/AC1 (Holding-Block 31000) — mitgeliefertes Nur-Lese-Profil hersteller/foxess-h1.json.
// Echter Ladeweg (loadConfigFile), echter Poller (Zähler als s16-Lesepunkt mit gedrehtem Vorzeichen, PV über combine,
// Unit 247) gegen ein Schein-Gerät, echter Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Registerwerte: .planning/docs/research/2026-11-15-foxess-modbus-control-spec.md §2.1; Vorzeichen nach
// nathanmarlor/foxess_modbus (grid_ct „Negative = import“, invbatpower + = Entladen) und dem Plexlog-Treiber.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfigFile } from '../config-model.js';
import { listManufacturerProfiles } from '../routes-api.js';
import { createRegisterDevice } from './helpers/fake-modbus-device.js';
import {
  setupProfile, shippedProfile, writeTargets, wireWrites, withWriteTargets, pollProfile, readAddresses,
} from './helpers/readonly-profile-rig.js';

const ID = 'foxess-h1';
const HOST = '192.0.2.76';
const setup = (opts = {}) => setupProfile(ID, { host: HOST, ...opts });
const load = (opts) => loadConfigFile(setup(opts)).effectiveConfig;

// Schein-H1 auf Unit 247, Holding-Block 31000 (FC 3), Leistungen in 1 W (0,001 kW).
function h1({ pv1 = 2850, pv2 = 2410, gridCt = 1900, load: house = 1100, batt = 2200, soc = 46 } = {}) {
  const dev = createRegisterDevice({ defaultUnitId: 247 });
  const words = new Array(40).fill(0);
  words[0] = 3450; words[1] = 83; words[2] = pv1;   // PV1 U (0,1 V) / I (0,1 A) / P
  words[3] = 3380; words[4] = 71; words[5] = pv2;   // PV2
  words[6] = 2310;                                  // Netzspannung
  words[8] = 3120;                                  // WR-Ausgang — nicht gelesen
  words[14] = gridCt;                               // 31014 Grid CT, + = Einspeisung
  words[15] = 0;                                    // 31015 CT2
  words[16] = house;                                // 31016 Load
  words[22] = batt;                                 // 31022 Akku, + = Entladen
  words[24] = soc;                                  // 31024 SoC
  dev.setWords(31000, words);
  return dev;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('foxess-h1.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen, Familie im Namen', () => {
  const raw = shippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /FoxESS/);
  assert.match(raw.label, /H1/);
  assert.match(raw.label, /nur Anzeige/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /nur Anzeige, keine Steuerung, am Gerät ungeprüft/i);
  assert.match(raw.help, /nicht für H1 G2, KH oder H3/);
  assert.match(raw.meter._comment, /STRITTIG/, 'Widerspruch zur Spec steht am Zähler');
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus TCP 502/Unit 247, FC 03 im Block 31000, Netz und Akku gedreht', () => {
  const loaded = loadConfigFile(setup());
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', 502, 247]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.address, cfg.meter.signed, cfg.meter.sign, cfg.meter.phases],
    ['point', 3, 31014, true, -1, undefined],
  );
  assert.deepEqual([cfg.meter.host, cfg.meter.unitId], [HOST, 247]);
  assert.deepEqual(Object.keys(cfg.points).sort(), ['batteryPowerW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    assert.equal(p.fc, 3, 'Block 31000 sind Holding-Register');
    assert.equal(p.host, HOST);
    assert.equal(p.unitId, 247);
  }
  assert.equal(cfg.points.batteryPowerW.sign, -1);
  assert.deepEqual(cfg.points.pvPowerW.combine.map((t) => t.address), [31002, 31005]);
  assert.equal(cfg.identify, undefined);
});

test('Schreiben: null Schreibziele und null Abregel-Ziele, auch mit dvControl.enabled:true in config.json', () => {
  const cfg = load();
  assert.deepEqual(writeTargets(cfg), []);
  assert.deepEqual(cfg.controlWrite, {});
  assert.equal(cfg.dvControl.enabled, false, 'config.json schaltet die Abregelung nicht ein');
  assert.equal(cfg.dvControl.negativePriceProtection.enabled, false);
});

test('Draht: alle Schreibwege des Evaluators (Sollwerte, Abregelung, Negativpreis) → kein einziger Modbus-Write', async () => {
  assert.deepEqual(await wireWrites(load()), []);
});

test('Draht-Gegenprobe: dasselbe Profil OHNE readOnly und mit Schreibzielen schreibt — der Prüfstand sieht Writes', async () => {
  const addrs = new Set((await wireWrites(load({ editProfile: withWriteTargets }))).map(([address]) => address));
  assert.ok(addrs.has(1111), `Netz-Sollwert muss auf dem Draht landen (gesehen: ${[...addrs]})`);
  assert.ok(addrs.has(40010), `Abregel-Flag muss auf dem Draht landen (gesehen: ${[...addrs]})`);
});

// --- Dekodieren über den echten Poller ------------------------------------------------------------------------------

test('Poller: Grid-CT positiv = Einspeisung → negativ, Akku positiv = Entladen → negativ, PV1+PV2, Unit 247', async () => {
  const cfg = load();
  const dev = h1();
  const { state } = await pollProfile(cfg, dev);

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Geräts');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -1900);
  assert.equal(state.victron.gridExportW, 1900);
  assert.equal(state.victron.gridImportW, 0);
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.pvPowerW, 5260);
  assert.equal(state.victron.batteryPowerW, -2200);
  assert.equal(state.victron.batteryDischargeW, 2200);
  assert.equal(state.victron.soc, 46);
  assert.equal(state.victron.selfConsumptionW, 1100);

  assert.deepEqual(readAddresses(dev), [31002, 31005, 31014, 31016, 31022, 31024]);
  assert.ok(dev.requests.every((r) => r.fc === 3 && r.unitId === 247 && r.host === HOST && r.quantity === 1));
});

test('Poller: Bezug (Grid-CT negativ) und Laden (31022 negativ, I16), kleine negative PV bleibt vorzeichenrichtig', async () => {
  const cfg = load();
  const { state } = await pollProfile(cfg, h1({ gridCt: -3400, batt: -2500, pv1: -3, pv2: 0, load: 900 }));
  assert.equal(state.meter.grid_total_w, 3400);
  assert.equal(state.victron.gridImportW, 3400);
  assert.equal(state.victron.batteryPowerW, 2500);
  assert.equal(state.victron.batteryChargeW, 2500);
  assert.equal(state.victron.pvPowerW, -3, 'nachts −3 W statt 65 533 W');
});

test('Poller: an Unit 1 (falsche Slave-ID) gibt es keine Werte — Lesefehler statt fremder Zahlen', async () => {
  const cfg = load();
  const dev = createRegisterDevice({ defaultUnitId: 1 });
  dev.setWords(31000, new Array(40).fill(7), { unitId: 1 });
  const { state } = await pollProfile(cfg, dev);
  assert.equal(state.meter.ok, false);
  assert.equal(state.victron.soc, undefined);
  assert.ok(state.victron.errors.soc);
});

// --- Beta-Gate -------------------------------------------------------------------------------------------------

test('Dropdown: im Stable-Kanal ausgeblendet, im Bleeding-Edge-Kanal sichtbar, aktiv immer sichtbar', () => {
  const configPath = setup();
  const ctx = (updateChannel, manufacturer = 'victron') => ({
    getConfigPath: () => configPath,
    getRawCfg: () => ({ updateChannel, manufacturer }),
  });
  const values = (c) => listManufacturerProfiles(c).map((o) => o.value);
  assert.ok(!values(ctx('stable')).includes(ID), 'stable: ausgeblendet');
  const dev = listManufacturerProfiles(ctx('dev')).find((o) => o.value === ID);
  assert.ok(dev, 'dev: sichtbar');
  assert.equal(dev.beta, true);
  assert.match(dev.label, /FoxESS.*nur Anzeige/);
  assert.ok(values(ctx('stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
