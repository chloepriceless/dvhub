// SOFAR HYD (Registerkarte „General“, 0x0400 ff.) — mitgeliefertes Nur-Lese-Profil hersteller/sofar.json.
// Echter Ladeweg (loadConfigFile), echter Poller (Zähler als s16-Lesepunkt mit Skala 10 und gedrehtem Vorzeichen,
// Phasen, PV über combine aus getrennten Registern) gegen ein Schein-Gerät, echter Evaluator für die Schreibwege,
// echtes Hersteller-Dropdown.
// Registerwerte: .planning/docs/research/2026-11-15-sofar-modbus-control-spec.md §3 ([SPEC] General 2020).
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfigFile } from '../config-model.js';
import { listManufacturerProfiles } from '../routes-api.js';
import { createRegisterDevice } from './helpers/fake-modbus-device.js';
import {
  setupProfile, shippedProfile, writeTargets, wireWrites, withWriteTargets, pollProfile, readAddresses,
} from './helpers/readonly-profile-rig.js';

const ID = 'sofar';
const HOST = '192.0.2.75';
const setup = (opts = {}) => setupProfile(ID, { host: HOST, ...opts });
const load = (opts) => loadConfigFile(setup(opts)).effectiveConfig;

// Schein-HYD-3PH auf Unit 1, FC 3, Rohwerte in 0,01 kW (bzw. % und 0,01 A).
function hyd({
  pcc = 312, phases = [104, 104, 104], pv1 = 412, pv2 = 389, batt = -215, soc = 72, load: house = 168,
  chargeA = 5000, dischargeA = 6000,
} = {}) {
  const dev = createRegisterDevice({ defaultUnitId: 1 });
  dev.set(0x0404, 2);                               // SysState OnGrid — nicht gelesen
  dev.set(0x0485, 999);                             // ActivePower_Output_Total — Vorzeichen widersprüchlich, nie lesen
  dev.set(0x0488, pcc);                             // PCC gesamt, + = Einspeisung
  dev.set(0x0493, phases[0]);
  dev.set(0x049E, phases[1]);
  dev.set(0x04A9, phases[2]);
  dev.set(0x04AF, house);                           // Load_Sys
  dev.set(0x0504, 777);                             // Off-Grid/EPS gesamt — nicht die Hauslast
  dev.setWords(0x0584, [3600, 1144, pv1, 3550, 1096, pv2]); // PV1 U/I/P, PV2 U/I/P
  dev.set(0x05C4, 80);                              // PV gesamt 0,1 kW — nicht gelesen
  dev.setWords(0x0604, [5120, 0xffff, batt, 25, soc, 99]); // Bat1 U/I/P/Temp/SoC/SoH
  dev.set(0x104B, chargeA);
  dev.set(0x104C, dischargeA);
  return dev;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('sofar.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = shippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /SOFAR/);
  assert.match(raw.label, /nur Anzeige/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /nur Anzeige, keine Steuerung, am Gerät ungeprüft/i);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus TCP 502/Unit 1, FC 03, Zähler 0x0488 mit Skala 10 und gedrehtem Vorzeichen', () => {
  const loaded = loadConfigFile(setup());
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', 502, 1]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.address, cfg.meter.signed, cfg.meter.scale, cfg.meter.sign],
    ['point', 3, 0x0488, true, 10, -1],
  );
  assert.deepEqual(cfg.meter.phases.map((p) => p.address), [0x0493, 0x049E, 0x04A9]);
  assert.deepEqual([cfg.meter.host, cfg.meter.unitId], [HOST, 1]);
  assert.deepEqual(Object.keys(cfg.points).sort(),
    ['batteryPowerW', 'deviceMaxChargeA', 'deviceMaxDischargeA', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    assert.equal(p.fc, 3, 'SOFAR: Lesen nur FC 03');
    assert.equal(p.host, HOST);
    assert.equal(p.unitId, 1);
  }
  assert.deepEqual(cfg.points.pvPowerW.combine.map((t) => t.address), [0x0586, 0x0589]);
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

test('Poller: Einspeisung (0x0488 positiv) → negativ, 0,01 kW → W, PV1+PV2, Akku entlädt, Last 0x04AF', async () => {
  const cfg = load();
  const dev = hyd();
  const { state } = await pollProfile(cfg, dev);

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Geräts');
  assert.equal(state.meter.ok, true, state.meter.error);
  // 0x0488 roh +312 × 0,01 kW = 3120 W eingespeist → DVhub −3120 (Bezug positiv)
  assert.equal(state.meter.grid_total_w, -3120);
  assert.equal(state.victron.gridExportW, 3120);
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [-1040, -1040, -1040]);
  assert.equal(state.victron.pvPowerW, 8010, '(412 + 389) × 10 W');
  // 0x0606 roh −215 (I16) × 10 W, + = Laden → −2150 = Entladen
  assert.equal(state.victron.batteryPowerW, -2150);
  assert.equal(state.victron.batteryDischargeW, 2150);
  assert.equal(state.victron.soc, 72);
  assert.equal(state.victron.selfConsumptionW, 1680, '0x04AF, nicht 0x0504 (EPS)');
  assert.equal(state.victron.deviceMaxChargeA, 50);
  assert.equal(state.victron.deviceMaxDischargeA, 60);

  // Genau die Profilregister: kein 0x0485 (Vorzeichen widersprüchlich), kein 0x0504, kein 0x05C4, kein PV3.
  assert.deepEqual(readAddresses(dev), [0x0488, 0x0493, 0x049E, 0x04A9, 0x04AF, 0x0586, 0x0589, 0x0606, 0x0608, 0x104B, 0x104C]);
  assert.ok(dev.requests.every((r) => r.fc === 3 && r.unitId === 1 && r.host === HOST && r.quantity === 1));
});

test('Poller: Bezug (0x0488 negativ) und Laden (0x0606 positiv); 1-phasiges EP-Gerät mit S/T = 0', async () => {
  const cfg = load();
  const { state } = await pollProfile(cfg, hyd({ pcc: -250, phases: [-250, 0, 0], batt: 300 }));
  assert.equal(state.meter.grid_total_w, 2500);
  assert.equal(state.victron.gridImportW, 2500);
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [2500, 0, 0]);
  assert.equal(state.victron.batteryPowerW, 3000);
  assert.equal(state.victron.batteryChargeW, 3000);
});

test('Poller: fehlt ein PV-Register, ist die PV-Summe ein Lesefehler statt einer halben Summe', async () => {
  const cfg = load();
  const dev = createRegisterDevice({ defaultUnitId: 1 });
  dev.set(0x0488, 0).set(0x0493, 0).set(0x049E, 0).set(0x04A9, 0).set(0x04AF, 100).set(0x0586, 300)
    .set(0x0606, 0).set(0x0608, 50).set(0x104B, 0).set(0x104C, 0);
  const { state } = await pollProfile(cfg, dev);
  assert.equal(state.victron.pvPowerW, undefined, 'kein erfundener Wert aus PV1 allein');
  assert.match(state.victron.errors.pvPowerW, /exception 2/);
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
  assert.match(dev.label, /SOFAR.*nur Anzeige/);
  assert.ok(values(ctx('stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
