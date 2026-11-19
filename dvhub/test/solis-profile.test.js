// Solis Hybrid (ESINV-Karte 33000 ff.) — mitgeliefertes Nur-Lese-Profil hersteller/solis.json.
// Echter Ladeweg (loadConfigFile), echter Poller (Input-Register FC 04, Zähler als int32-Lesepunkt mit Phasen und
// gedrehtem Vorzeichen) gegen ein Schein-Gerät, echter Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Registerwerte: .planning/docs/research/2026-11-15-solis-modbus-control-spec.md §2 ([SPEC] 2018) und evcc
// solis-hybrid.yaml [COMM].
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfigFile } from '../config-model.js';
import { listManufacturerProfiles } from '../routes-api.js';
import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import { createModbusTransport, modbusPacingFromConfig, normalizeModbusPacing } from '../transport-modbus.js';
import { installFakeModbusSockets, advance, flush, enableFakeClock, disableFakeClock } from './helpers/fake-modbus-socket.js';
import {
  setupProfile, shippedProfile, writeTargets, wireWrites, withWriteTargets, pollProfile, readAddresses,
} from './helpers/readonly-profile-rig.js';

const ID = 'solis';
const HOST = '192.0.2.74';
const setup = (opts = {}) => setupProfile(ID, { host: HOST, ...opts });
const load = (opts) => loadConfigFile(setup(opts)).effectiveConfig;

// Schein-Hybrid auf Unit 1, nur Input-Register (FC 4), 32 bit High-Wort zuerst. `newMeterBlock: false` = ältere
// Firmware ohne Zählerblock 33250 ff. `magnitude: true` = 33149 liefert nur den Betrag (Lesart solis-modbus/Plexlog);
// `direction` überschreibt 33135; `gaps: true` = Register zwischen 33135 und 33149 fehlen (Block-Lesung scheitert).
// Sonst ist der Block 33135–33150 lückenlos belegt — Plexlog liest 33000–33299 in 50er-Blöcken [DECOMP].
function hybrid({
  pv = 7350, meter = 2600, phases = [900, 800, 900], batt = 3100, load: house = 1650, soc = 64,
  chargeA = 500, dischargeA = 740, newMeterBlock = true, magnitude = false, direction, gaps = false,
} = {}) {
  const dev = createRegisterDevice({ defaultUnitId: 1 });
  const fc4 = { fc: 4 };
  if (!gaps) for (let a = 33136; a <= 33148; a += 1) dev.set(a, 0, fc4);
  dev.set(33000, 0x2030, fc4);            // Modelltyp — nicht gelesen, nur Kulisse
  dev.set32(33057, pv, fc4);              // PV gesamt U32
  dev.set32(33130, meter, fc4);           // Zähler S32, + = Export
  dev.set(33132, 1, fc4);                 // Mode-Spiegel — darf nie als Phase gelesen werden
  dev.set(33135, direction ?? (batt >= 0 ? 0 : 1), fc4); // Richtung 0 laden / 1 entladen
  dev.set(33139, soc, fc4);
  dev.set(33143, chargeA, fc4);           // BMS-Grenze Laden, 0,1 A
  dev.set(33144, dischargeA, fc4);        // BMS-Grenze Entladen, 0,1 A
  dev.set(33147, house, fc4);             // Hauslast U16
  dev.set(33148, 0, fc4);                 // Backup-Last
  dev.set32(33149, magnitude ? Math.abs(batt) : batt, fc4); // Akku S32 (evcc-Lesart: + = Laden) bzw. Betrag
  if (newMeterBlock) {
    dev.set32(33257, phases[0], fc4);
    dev.set32(33259, phases[1], fc4);
    dev.set32(33261, phases[2], fc4);
    dev.set32(33263, meter, fc4);
  }
  return dev;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('solis.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = shippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /Solis/);
  assert.match(raw.label, /nur Anzeige/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /nur Anzeige, keine Steuerung, am Gerät ungeprüft/i);
  assert.match(raw.points.batteryPowerW._comment, /strittig.*direction \(E8\)/is, 'umstrittenes Akku-Vorzeichen und der Weg über 33135 stehen am Punkt');
  assert.match(raw.help, /Richtungsregister/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus TCP 502/Unit 1, alles FC 04, Zähler 33130 mit gedrehtem Vorzeichen', () => {
  const loaded = loadConfigFile(setup());
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', 502, 1]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.address, cfg.meter.readType, cfg.meter.sign],
    ['point', 4, 33130, 'int32', -1],
  );
  assert.deepEqual(cfg.meter.phases.map((p) => p.address), [33257, 33259, 33261]);
  assert.deepEqual([cfg.meter.host, cfg.meter.unitId], [HOST, 1]);
  assert.deepEqual(Object.keys(cfg.points).sort(),
    ['batteryPowerW', 'deviceMaxChargeA', 'deviceMaxDischargeA', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    assert.equal(p.fc, 4, 'Solis: Telemetrie nur als Input-Register (FC 04)');
    assert.equal(p.host, HOST);
    assert.equal(p.unitId, 1);
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

test('Poller: Export positiv am Gerät → Einspeisung in DVhub, Phasen aus dem Zählerblock, FC 04, BMS-Grenzen in A', async () => {
  const cfg = load();
  const dev = hybrid();
  const { state } = await pollProfile(cfg, dev);

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Geräts');
  assert.equal(state.meter.ok, true, state.meter.error);
  // 33130 roh +2600 = Export → DVhub −2600 (Bezug positiv)
  assert.equal(state.meter.grid_total_w, -2600);
  assert.equal(state.victron.gridExportW, 2600);
  assert.equal(state.victron.gridImportW, 0);
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [-900, -800, -900]);
  assert.equal(state.victron.pvPowerW, 7350);
  assert.equal(state.victron.batteryPowerW, 3100);
  assert.equal(state.victron.batteryChargeW, 3100);
  assert.equal(state.victron.soc, 64);
  assert.equal(state.victron.selfConsumptionW, 1650);
  assert.equal(state.victron.deviceMaxChargeA, 50);
  assert.equal(state.victron.deviceMaxDischargeA, 74);

  // Genau die Profilregister, alle FC 4 auf Unit 1 — nie 33132 (Mode-Spiegel) als Phase, nie 33263. Akku und
  // Richtung (E8) aus EINER Anfrage 33135–33150.
  assert.deepEqual(readAddresses(dev), [33057, 33130, 33135, 33139, 33143, 33144, 33147, 33257, 33259, 33261]);
  assert.deepEqual(dev.requests.filter((r) => r.address === 33135).map((r) => r.quantity), [16]);
  assert.ok(dev.requests.every((r) => r.fc === 4 && r.unitId === 1 && r.host === HOST));
});

test('Poller: Bezug (Zähler negativ) und Entladen (33149 negativ), PV über 65 535 W (U32)', async () => {
  const cfg = load();
  const { state } = await pollProfile(cfg, hybrid({ meter: -4200, phases: [-1400, -1400, -1400], batt: -2800, pv: 70100 }));
  assert.equal(state.meter.grid_total_w, 4200);
  assert.equal(state.victron.gridImportW, 4200);
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [1400, 1400, 1400]);
  assert.equal(state.victron.batteryPowerW, -2800);
  assert.equal(state.victron.batteryDischargeW, 2800);
  assert.equal(state.victron.pvPowerW, 70100);
});

test('Poller: ältere Firmware ohne Zählerblock 33250 ff. — Netzsumme aus 33130 gilt, Phasen bleiben leer', async () => {
  const cfg = load();
  const { state, logs } = await pollProfile(cfg, hybrid({ newMeterBlock: false }));
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -2600);
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.ok(logs.some((l) => l.event === 'meter_phase_read_error'), 'fehlende Phasen werden einmal gemeldet');
});

// --- E8: Akku-Vorzeichen aus 33135 -----------------------------------------------------------------------------------

test('E8: Profil nimmt das Akku-Vorzeichen aus 33135 (0 = Laden +, 1 = Entladen −) [SPEC]', () => {
  const raw = shippedProfile(ID);
  assert.deepEqual(raw.points.batteryPowerW.direction, { address: 33135, values: { 0: 1, 1: -1 } });
  assert.equal(raw.points.batteryPowerW.sign, undefined, 'kein sign neben direction');
  assert.deepEqual(load().points.batteryPowerW.direction, { address: 33135, values: { 0: 1, 1: -1 } }, 'kommt in der wirksamen Config an');
});

test('E8: liefert 33149 nur den Betrag, zeigt DVhub Entladen trotzdem negativ (früher positiv)', async () => {
  const { state } = await pollProfile(load(), hybrid({ batt: -2800, magnitude: true }));
  assert.equal(state.victron.batteryPowerW, -2800);
  assert.equal(state.victron.batteryDischargeW, 2800);
  const charging = await pollProfile(load(), hybrid({ batt: 1900, magnitude: true }));
  assert.equal(charging.state.victron.batteryPowerW, 1900);
});

test('E8: unbekannter Wert in 33135 → Akku leer mit Grund, kein geratenes Vorzeichen; Rest unberührt', async () => {
  const { state } = await pollProfile(load(), hybrid({ batt: 1200, direction: 2 }));
  assert.equal(state.victron.batteryPowerW, null);
  assert.match(state.victron.errors.batteryPowerW, /Richtungsregister @33135 meldet 2/);
  assert.equal(state.victron.soc, 64);
  assert.equal(state.victron.selfConsumptionW, 1650);
  assert.equal(state.meter.ok, true);
});

test('E8: kennt das Gerät Register zwischen 33135 und 33149 nicht → Richtung vorher/nachher einzeln, gleicher Wert', async () => {
  const { state } = await pollProfile(load(), hybrid({ batt: -900, gaps: true }));
  assert.equal(state.victron.batteryPowerW, -900);
  assert.equal(state.victron.errors.batteryPowerW, undefined);
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
  assert.match(dev.label, /Solis.*nur Anzeige/);
  assert.ok(values(ctx('stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});

// --- E7: Abstand zwischen den Anfragen ------------------------------------------------------------------------------

// Solis verlangt laut Community > 300 ms zwischen zwei Frames, das Add-on Solis-Local nutzt 400 ms; höchstens 50
// Register je Lesung (Spec §1). Echter Transport mit Taktung aus der Config, falsche Uhr.
test('E7: 400 ms ab Antwortende zwischen zwei Anfragen, höchstens 50 Register je Lesung, Poll-Takt bleibt beim Betreiber', async () => {
  const cfg = load();
  assert.deepEqual(normalizeModbusPacing(cfg.victron.requestPacing), { minRequestGapMs: 400, connectDelayMs: 0, maxRegistersPerRequest: 50 });
  assert.equal(cfg.victron.requestPacing.minPollIntervalMs, undefined);
  enableFakeClock();
  const sockets = installFakeModbusSockets();
  const transport = createModbusTransport({ pacingFor: modbusPacingFromConfig(() => cfg) });
  const { poller } = createPollerRig(cfg, transport);
  try {
    const p = poller.requestPoll();
    await advance(10000, 10);
    await p;
    const gaps = sockets.wire.slice(1).map((f, i) => f.t - sockets.wire[i].t);
    assert.ok(sockets.wire.length >= 7, `ein ganzer Takt (${sockets.wire.length} Anfragen)`);
    assert.ok(gaps.every((g) => g >= 400), `nie unter 400 ms: ${gaps}`);
    assert.ok(sockets.wire.every((f) => f.fc === 4 && f.quantity <= 50));
  } finally {
    await transport.destroy();
    await flush();
    sockets.restore();
    disableFakeClock();
  }
});
