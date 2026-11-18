// E3/DC S10 (Simple-Mode) — mitgeliefertes Nur-Lese-Profil hersteller/e3dc.json.
// Echter Ladeweg (loadConfigFile), echter Poller (Zähler als Lesepunkt, int32 Low-Wort zuerst) gegen ein Schein-Gerät
// nach E3/DC V1.6, echter Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Registerwerte: .planning/docs/research/2026-11-15-e3dc-modbus-control-spec.md §2.3 (V1.6 [SPEC]); Drahtadresse =
// Dokumentregister − 1, Wortreihenfolge Low-Wort zuerst (Plexlog-Treiber, openHAB modbus.e3dc).
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfigFile } from '../config-model.js';
import { listManufacturerProfiles } from '../routes-api.js';
import { createRegisterDevice } from './helpers/fake-modbus-device.js';
import {
  setupProfile, shippedProfile, writeTargets, wireWrites, withWriteTargets, pollProfile, readAddresses,
} from './helpers/readonly-profile-rig.js';

const ID = 'e3dc';
const HOST = '192.0.2.73';
const setup = (opts = {}) => setupProfile(ID, { host: HOST, ...opts });
const load = (opts) => loadConfigFile(setup(opts)).effectiveConfig;

// Schein-S10 auf Unit 1, FC 3: Drahtadressen 40000 ff. (= Dok. 40001 ff.), 32-bit Low-Wort zuerst.
function s10({ pv = 6420, batt = 2150, house = 1730, grid = -2540, soc = 57 } = {}) {
  const dev = createRegisterDevice({ defaultUnitId: 1 });
  const le = { wordOrder: 'le' };
  dev.set(40000, 0xe3dc);           // Magicbyte (Dok. 40001) — nicht gelesen, nur Kulisse
  dev.set32(40067, pv, le);         // Dok. 40068 PV
  dev.set32(40069, batt, le);       // Dok. 40070 Batterie (+ = Laden)
  dev.set32(40071, house, le);      // Dok. 40072 Haus
  dev.set32(40073, grid, le);       // Dok. 40074 Netz (− = Einspeisung)
  dev.set32(40075, 0, le);          // Dok. 40076 zusätzliche Einspeiser
  dev.set32(40077, 0, le);          // Dok. 40078 Wallbox
  dev.set32(40079, 0, le);          // Dok. 40080 Wallbox-Solar
  dev.set(40081, (88 << 8) | 61);   // Dok. 40082 Autarkie | Eigenverbrauch (je 1 Byte)
  dev.set(40082, soc);              // Dok. 40083 SoC
  return dev;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('e3dc.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = shippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /E3\/DC/);
  assert.match(raw.label, /nur Anzeige/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /nur Anzeige, keine Steuerung, am Gerät ungeprüft/i);
  assert.match(raw.help, /Simple-Mode/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus TCP 502/Unit 1, Zähler als int32-Lesepunkt, Verbindung aus dem Profil', () => {
  const loaded = loadConfigFile(setup());
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', 502, 1]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.address, cfg.meter.readType, cfg.meter.wordOrder, cfg.meter.sign],
    ['point', 3, 40073, 'int32', 'le', undefined],
  );
  assert.equal(cfg.meter.phases, undefined, 'Simple-Mode hat keine Phasenleistungen');
  assert.deepEqual([cfg.meter.host, cfg.meter.unitId], [HOST, 1]);
  assert.deepEqual(Object.keys(cfg.points).sort(), ['batteryPowerW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    assert.equal(p.fc, 3, 'E3/DC: nur FC 03');
    assert.equal(p.host, HOST);
    assert.equal(p.unitId, 1);
    assert.ok(p.address >= 40067 && p.address <= 40082, `Simple-Mode-Leistungsblock (Draht), nicht ${p.address}`);
    assert.equal(p.sign, undefined, 'E3/DC meldet schon in DVhub-Konvention');
  }
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

test('Poller: Low-Wort zuerst, Laden positiv, Einspeisung negativ, SoC an Dok. 40083 (Draht 40082)', async () => {
  const cfg = load();
  const dev = s10();
  const { state } = await pollProfile(cfg, dev);

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Geräts');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.victron.soc, 57, 'nicht Autarkie/Eigenverbrauch (Draht 40081)');
  assert.equal(state.victron.pvPowerW, 6420);
  assert.equal(state.victron.batteryPowerW, 2150);
  assert.equal(state.victron.batteryChargeW, 2150);
  assert.equal(state.victron.batteryDischargeW, 0);
  assert.equal(state.victron.selfConsumptionW, 1730);
  assert.equal(state.meter.grid_total_w, -2540);
  assert.equal(state.victron.gridExportW, 2540);
  assert.equal(state.victron.gridImportW, 0);
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);

  // Genau die Profilregister (FC 3, Unit 1, eigene IP) — kein Victron-Register, keine Wallbox, keine Kennung.
  assert.deepEqual(readAddresses(dev), [40067, 40069, 40071, 40073, 40082]);
  assert.ok(dev.requests.every((r) => r.fc === 3 && r.unitId === 1 && r.host === HOST));
});

test('Poller: Entladen und Bezug (negatives Int32 über beide Wörter), Leistung über 65 535 W', async () => {
  const cfg = load();
  const { state } = await pollProfile(cfg, s10({ pv: 81234, batt: -4321, house: 3100, grid: 1250 }));
  assert.equal(state.victron.pvPowerW, 81234, 'High-Wort zählt (Low-Wort allein wäre 15 698)');
  assert.equal(state.victron.batteryPowerW, -4321);
  assert.equal(state.victron.batteryDischargeW, 4321);
  assert.equal(state.meter.grid_total_w, 1250);
  assert.equal(state.victron.gridImportW, 1250);
  assert.equal(state.victron.gridExportW, 0);
});

test('Poller: Ausgabe-Konvention gridPositiveMeans=feed_in dreht nur die Ausgabe, nicht die Lesart', async () => {
  const cfg = load({ config: { gridPositiveMeans: 'feed_in' } });
  const { state } = await pollProfile(cfg, s10({ grid: -2540 }));
  assert.equal(state.meter.grid_total_w, 2540);
  assert.equal(state.victron.gridExportW, 2540, 'Einspeisung bleibt Einspeisung');
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
  assert.match(dev.label, /E3\/DC.*nur Anzeige/);
  assert.ok(values(ctx('stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
