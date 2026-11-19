// SolaX X1/X3-Hybrid G4 — mitgeliefertes Nur-Lese-Profil hersteller/solax-g4.json.
// Echter Ladeweg (loadConfigFile), echter Poller gegen ein Schein-Gerät (Unit 1, Input-Register FC 4, 32 bit
// Low-Wort zuerst), echter Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Register: .planning/docs/research/2026-11-15-solax-modbus-control-spec.md §3 (V3.21 [SPEC]), Vorzeichen nach evcc
// solax.yaml [COMM] (0x46 int32s scale −1, 0x16 int16 scale −1 bei evcc-Konvention Akku + = Entladen).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import {
  TEST_HOST, readShippedProfile, setupProfile, loadProfile, writeTargets, evaluatorWrites, writableVariant, dropdown, readSet,
} from './helpers/read-only-profile-rig.js';

const ID = 'solax-g4';
const INPUT = { fc: 4 };

// Rohbild (Input-Register). meter: feedin_power (+ = Einspeisung), battery: Batpower_Charge1 (+ = Laden).
function device({ meter = 1500, pv = [3100, 2900], battery = 2500, soc = 82, maxChargeA = 250, maxDischargeA = 300 } = {}) {
  return createRegisterDevice({ defaultUnitId: 1 })
    .set32(0x46, meter, { wordOrder: 'le', ...INPUT })
    .setWords(0x0a, pv, INPUT)
    .set(0x16, battery, INPUT)
    .set(0x1c, soc, INPUT)
    .set(0x24, maxChargeA, INPUT)
    .set(0x25, maxDischargeA, INPUT);
}

function effective() {
  return loadProfile(ID).effectiveConfig;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('solax-g4.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /SolaX X1\/X3-Hybrid G4/);
  assert.match(raw.label, /— nur Anzeige$/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /^Nur Anzeige, keine Steuerung, am Gerät ungeprüft\./);
  assert.match(raw.help, /docs\/hersteller\/solax-g4\.md/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

// E8 gibt es, das Profil schaltet es bewusst NICHT ein: keine Integration nutzt BDCStatus 0x19, und ob 0x19 im
// Ruhezustand weitere Werte meldet, ist unbelegt — ein unbekannter Wert ließe Akku und Hauslast leer.
test('E8: Akku ohne Richtungsregister (0x16 vorzeichenbehaftet wie evcc); _doc nennt den Weg über 0x19', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.points.batteryPowerW.direction, undefined);
  assert.equal(raw.points.batteryPowerW.signed, true);
  assert.match(raw._doc.join('\n'), /BDCStatus 0x19.*bewusst nicht/s);
  assert.doesNotMatch(raw._doc.join('\n'), /nicht aus einem Statusregister/);
});

test('Laden: gültig, Modbus TCP 502, Unit 1, Zähler als int32-Punkt 0x46 (FC 4, Low-Wort zuerst) ohne fremde Phasen', () => {
  const loaded = loadProfile(ID);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', 502, 1]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.address, cfg.meter.readType, cfg.meter.wordOrder, cfg.meter.sign, cfg.meter.phases],
    ['point', 4, 0x46, 'int32', 'le', -1, undefined]
  );
  assert.deepEqual(Object.keys(cfg.points).sort(),
    ['batteryPowerW', 'deviceMaxChargeA', 'deviceMaxDischargeA', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    if (!p.enabled) continue;
    assert.equal(p.fc, 4, 'SolaX: Telemetrie in Input-Registern');
    assert.deepEqual([p.host, p.unitId], [TEST_HOST, 1]);
  }
  assert.equal(cfg.points.selfConsumptionW.enabled, false);
  assert.equal(cfg.points.selfConsumptionW.derive, 'energy_balance');
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

test('Poller (Tag): Einspeisung (0x46 positiv, LSW zuerst) → Netz negativ, Laden positiv, PV = MPPT1 + MPPT2', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -1500, '0x46 +1500 = Einspeisung → DVhub −1500');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.gridExportW, 1500);
  assert.equal(state.victron.pvPowerW, 6000);
  assert.equal(state.victron.batteryPowerW, 2500, '0x16 +2500 = Laden, DVhub-Konvention ohne Drehung');
  assert.equal(state.victron.batteryChargeW, 2500);
  assert.equal(state.victron.soc, 82);
  // 6000 PV + 0 Bezug − 1500 Einspeisung − 2500 Laden
  assert.equal(state.victron.selfConsumptionW, 2000);
  assert.equal(state.victron.selfConsumptionDerived, true);
  assert.equal(state.victron.deviceMaxChargeA, 25);
  assert.equal(state.victron.deviceMaxDischargeA, 30);

  assert.deepEqual(readSet(dev.requests), ['4:1:10x2', '4:1:22x1', '4:1:28x1', '4:1:36x1', '4:1:37x1', '4:1:70x2']);
  assert.ok(dev.requests.every((r) => r.host === TEST_HOST && r.port === 502));
  assert.deepEqual(dev.writes, []);
});

test('Poller (Nacht, zweiter Takt): Bezug (0x46 negativ) → Netz positiv, Entladen (0x16 int16 negativ), Last folgt', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 2000);

  dev.set32(0x46, -700, { wordOrder: 'le', ...INPUT }).setWords(0x0a, [0, 0], INPUT).set(0x16, -1100, INPUT).set(0x1c, 60, INPUT);
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 700);
  assert.equal(state.victron.gridImportW, 700);
  assert.equal(state.victron.batteryPowerW, -1100);
  assert.equal(state.victron.batteryDischargeW, 1100);
  assert.equal(state.victron.soc, 60);
  // 0 PV + 700 Bezug + 1100 Entladen (E6: folgt jedem Takt)
  assert.equal(state.victron.selfConsumptionW, 1800);
});

test('Poller: dieselben Register als Holding (FC 3) gibt es nicht — das Profil liest Input-Register', async () => {
  const cfg = effective();
  const dev = createRegisterDevice({ defaultUnitId: 1 })
    .set32(0x46, 1500, { wordOrder: 'le' }).setWords(0x0a, [3100, 2900]).set(0x16, 2500).set(0x1c, 82);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false, 'FC 3 statt FC 4 darf nicht still gelingen');
  assert.match(state.victron.errors.soc, /exception 2/);
});

test('Poller: Typ-Extremwerte gelten als „kein Wert“ — Zählerfehler, leere Werte, keine erfundene Hauslast', async () => {
  const cfg = effective();
  const dev = device();
  dev.setWords(0x46, [0xffff, 0x7fff], INPUT) // 0x7FFFFFFF, Low-Wort zuerst
    .setWords(0x0a, [3100, 0xffff], INPUT)
    .set(0x16, 0x8000, INPUT)
    .set(0x1c, 0xffff, INPUT)
    .set(0x24, 0xffff, INPUT)
    .set(0x25, 0xffff, INPUT);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false, 'Netz ohne Wert ist ein Zählerfehler, nie ±2 147 483 647 W');
  assert.equal(state.victron.pvPowerW, null, 'ein MPPT ohne Wert macht die Summe unbekannt');
  assert.equal(state.victron.batteryPowerW, null);
  assert.equal(state.victron.soc, null);
  assert.equal(state.victron.deviceMaxChargeA, null);
  assert.equal(state.victron.deviceMaxDischargeA, null);
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
  assert.match(dev.label, /SolaX.*nur Anzeige/);
  assert.ok(values(dropdown(configPath, 'stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
