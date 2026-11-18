// SolarEdge StorEdge (SunSpec + Akku) — mitgeliefertes Nur-Lese-Profil hersteller/solaredge-storedge.json.
// Echter Ladeweg (loadConfigFile), echter Poller mit echtem SunSpec-Scan gegen ein Schein-Gerät (Port 1502, Unit 1,
// FC 3; SunSpec High-Wort zuerst, Akku-Bank Float32 Low-Wort zuerst), echter Evaluator, echtes Hersteller-Dropdown.
// Register: .planning/docs/research/2026-11-15-solaredge-modbus-control-spec.md §2 [SPEC]; Vorzeichen und PV-Rechenweg
// nach evcc solaredge-hybrid.yaml [COMM] (Netz 203:W scale −1, PV = DCW + 0xE174, Akku 0xE174 scale −1).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import {
  TEST_HOST, readShippedProfile, setupProfile, loadProfile, writeTargets, evaluatorWrites, writableVariant, dropdown, readSet,
} from './helpers/read-only-profile-rig.js';

const ID = 'solaredge-storedge';
const PORT = 1502;
const sf = (n) => n & 0xffff; // SunSpec-Skalenfaktor als Registerwort (int16)

// SolarEdge-Kette ab 40000: Common, Wechselrichter 103, (Synergy: 160), Zähler-Common, Zähler 203. Gibt die
// Datenadressen zurück. Ohne Synergy liegt der Zähler-Wert wie in der Tech-Note an 40206 (SF 40210).
function device({ meterModel = 203, synergy = false } = {}) {
  const dev = createRegisterDevice({ defaultUnitId: 1 });
  const models = [{ id: 1, length: 65 }, { id: 103, length: 50 }];
  if (synergy) models.push({ id: 160, length: 48 });
  models.push({ id: 1, length: 65 }, { id: meterModel, length: 105 });
  const at = dev.setSunspecChain(40000, models);
  return { dev, inv: at[103][0], meter: at[meterModel][0] };
}

// Messbild setzen: W/SF des Zählers (Rohwert + = Einspeisung), DCW/SF, Akku (+ = Laden), SoE, Grenzen.
function setValues(dev, at, { meterW, meterSf, dcw, dcwSf, battery, soe, maxCharge = 5000, maxDischarge = 4800 }) {
  dev.set(at.meter + 16, meterW).set(at.meter + 20, sf(meterSf));
  dev.set(at.inv + 29, dcw).set(at.inv + 30, sf(dcwSf));
  dev.setFloat32(57716, battery, { wordOrder: 'le' });
  dev.setFloat32(57732, soe, { wordOrder: 'le' });
  dev.setFloat32(57668, maxCharge, { wordOrder: 'le' });
  dev.setFloat32(57670, maxDischarge, { wordOrder: 'le' });
  return dev;
}

// Tag: 350 W Einspeisung (3500 × 10^−1), DC 4800 W, Akku lädt 2000 W → PV 6800 W.
const DAY = { meterW: 3500, meterSf: -1, dcw: 4800, dcwSf: 0, battery: 2000, soe: 81.5 };

function effective() {
  return loadProfile(ID).effectiveConfig;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('solaredge-storedge.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /SolarEdge StorEdge/);
  assert.match(raw.label, /— nur Anzeige$/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /^Nur Anzeige, keine Steuerung, am Gerät ungeprüft\./);
  assert.match(raw.help, /docs\/hersteller\/solaredge-storedge\.md/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus TCP 1502, Unit 1, Zähler als SunSpec-203-Punkt mit Laufzeit-Skalenfaktor', () => {
  const loaded = loadProfile(ID);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', PORT, 1]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.signed, cfg.meter.sign, cfg.meter.address, cfg.meter.phases],
    ['point', 3, true, -1, undefined, undefined]
  );
  assert.deepEqual(cfg.meter.sunspec, { model: 203, offset: 16, sfOffset: 20 });
  assert.deepEqual([cfg.meter.host, cfg.meter.port, cfg.meter.unitId], [TEST_HOST, PORT, 1]);
  assert.deepEqual(Object.keys(cfg.points).sort(),
    ['batteryPowerW', 'deviceMaxChargeW', 'deviceMaxDischargeW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    if (!p.enabled) continue;
    assert.equal(p.fc, 3, 'SolarEdge: Holding-Register');
    assert.equal(p.host, TEST_HOST);
    assert.equal(p.unitId, 1);
    assert.equal(p.port, PORT);
  }
  assert.deepEqual(cfg.points.pvPowerW.combine.map((t) => [t.address, t.readType ?? 'int16', t.sfAddress ?? null]),
    [[40100, 'int16', 40101], [57716, 'float32', null]]);
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

test('Poller (Tag): Scan löst 203 auf 40206/SF 40210 auf; Einspeisung mit W_SF −1, PV = DCW + Akku, Float LE', async () => {
  const cfg = effective();
  const { dev, ...at } = device();
  setValues(dev, at, DAY);
  const { state, poller, logs } = createPollerRig(cfg, dev);
  await poller.requestPoll();

  assert.ok(logs.some((l) => l.event === 'sunspec_scan_ok'), 'SunSpec-Scan gelaufen');
  assert.deepEqual([cfg.meter.address, cfg.meter.sfAddress], [40206, 40210], 'Tech-Note-Lage aus dem Scan');
  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -350, '203:W +3500 × 10^−1 = Einspeisung → DVhub −350');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.gridExportW, 350);
  assert.equal(state.victron.soc, 81.5, 'SoE Float32 Low-Wort zuerst');
  assert.equal(state.victron.batteryPowerW, 2000, '0xE174 +2000 = Laden, DVhub-Konvention ohne Drehung');
  assert.equal(state.victron.batteryChargeW, 2000);
  assert.equal(state.victron.pvPowerW, 6800, 'DCW 4800 + Akku 2000');
  // 6800 PV + 0 Bezug − 350 Einspeisung − 2000 Laden = DCW + Netz
  assert.equal(state.victron.selfConsumptionW, 4450);
  assert.equal(state.victron.selfConsumptionDerived, true);
  assert.equal(state.victron.deviceMaxChargeW, 5000);
  assert.equal(state.victron.deviceMaxDischargeW, 4800);

  // Scan (Marke + Modellköpfe), dann genau die Profilregister — Wert und SF je in EINER Anfrage.
  assert.deepEqual(readSet(dev.requests), [
    '3:1:40000x2', '3:1:40002x2', '3:1:40069x2', '3:1:40100x2', '3:1:40121x2', '3:1:40188x2', '3:1:40206x5',
    '3:1:40295x2', '3:1:57668x2', '3:1:57670x2', '3:1:57716x2', '3:1:57732x2',
  ]);
  assert.ok(dev.requests.every((r) => r.host === TEST_HOST && r.port === PORT));
  assert.deepEqual(dev.writes, []);
});

test('Poller (Nacht, zweiter Takt): SF wechseln (W_SF −1 → +2, DCW_SF 0 → −1), Bezug positiv, Entladen negativ', async () => {
  const cfg = effective();
  const { dev, ...at } = device();
  setValues(dev, at, DAY);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 4450);
  const firstCycle = dev.requests.length;

  // Bezug 800 W (−8 × 10^2), DC 1500 W (15000 × 10^−1) aus dem Akku, Akku entlädt 1500 W → PV 0.
  setValues(dev, at, { meterW: -8, meterSf: 2, dcw: 15000, dcwSf: -1, battery: -1500, soe: 40.25 });
  await poller.requestPoll();
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, 800);
  assert.equal(state.victron.gridImportW, 800);
  assert.equal(state.victron.batteryPowerW, -1500);
  assert.equal(state.victron.batteryDischargeW, 1500);
  assert.equal(state.victron.soc, 40.25);
  assert.equal(state.victron.pvPowerW, 0, 'DCW 1500 − Entladen 1500');
  // 0 PV + 800 Bezug + 1500 Entladen (E6: folgt jedem Takt)
  assert.equal(state.victron.selfConsumptionW, 2300);
  const second = dev.requests.slice(firstCycle);
  assert.ok(!second.some((r) => r.address === 40000), 'kein neuer Scan im zweiten Takt');
  assert.equal(second.filter((r) => r.address === 57668).length, 0, 'Gerätegrenzen nur einmal je Minute');
});

test('Poller: Synergy (Modell 160 vor dem Zähler) verschiebt den Zähler — der Scan findet ihn, PV bleibt 40100', async () => {
  const cfg = effective();
  const { dev, ...at } = device({ synergy: true });
  setValues(dev, at, DAY);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(at.meter + 16, 40256, '+50 Register wie in der Spec');
  assert.equal(cfg.meter.address, 40256);
  assert.equal(state.meter.grid_total_w, -350);
  assert.equal(state.victron.pvPowerW, 6800);
  assert.ok(dev.requests.some((r) => r.address === 40256 && r.quantity === 5));
});

test('Poller: 1-phasiger Zähler (Modell 201) → Zähler unaufgelöst = Zählerfehler, nie ein Wert von fremder Adresse', async () => {
  const cfg = effective();
  const { dev, ...at } = device({ meterModel: 201 });
  setValues(dev, at, DAY);
  const { state, poller, logs } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false);
  assert.match(state.meter.error, /SunSpec-Zähler nicht aufgelöst/);
  assert.deepEqual(logs.find((l) => l.event === 'sunspec_scan_ok')?.data.missing, [{ name: 'meter', model: 203 }]);
  assert.ok(!dev.requests.some((r) => r.address >= at.meter && r.address < at.meter + 105), 'kein Lesen im 201-Block');
  assert.equal(state.victron.pvPowerW, 6800, 'PV und Akku laufen weiter');
  assert.equal(state.victron.selfConsumptionW ?? null, null, 'ohne Netz keine Bilanz');
});

test('Poller: Akku nicht freigeschaltet (NaN) → Akku, SoC und PV leer, keine erfundene Hauslast', async () => {
  const cfg = effective();
  const { dev, ...at } = device();
  setValues(dev, at, DAY);
  dev.setWords(57716, [0xffff, 0xffff]).setWords(57732, [0xffff, 0xffff]);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, true, 'Netz bleibt gültig');
  assert.equal(state.victron.batteryPowerW, null);
  assert.equal(state.victron.soc, null);
  assert.equal(state.victron.pvPowerW, null, 'ein Summand ohne Wert macht PV unbekannt, nie DCW allein');
  assert.equal(state.victron.selfConsumptionW ?? null, null);
});

test('Poller: SunSpec „nicht implementiert“ (W_SF 0x8000, DCW 0x8000) → Zählerfehler bzw. PV leer', async () => {
  const cfg = effective();
  const { dev, ...at } = device();
  setValues(dev, at, DAY);
  dev.set(at.meter + 20, 0x8000).set(at.inv + 29, 0x8000);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false, 'ohne Skalenfaktor kein Netzwert');
  assert.match(state.meter.error, /keinen Gesamtwert/);
  assert.equal(state.victron.pvPowerW, null);
  assert.equal(state.victron.batteryPowerW, 2000, 'Akku unabhängig davon');

  // Funk-Zähler melden laut Community W = 0x8000 bei gültigem SF: das ist kein Bezug von 3277 W.
  const second = device();
  setValues(second.dev, second, DAY);
  second.dev.set(second.meter + 16, 0x8000);
  const r2 = createPollerRig(effective(), second.dev);
  await r2.poller.requestPoll();
  assert.equal(r2.state.meter.ok, false, 'W 0x8000 ist „nicht implementiert“, kein −32768 × 10^−1');
  assert.match(r2.state.meter.error, /keinen Gesamtwert/);
});

// --- Beta-Gate -------------------------------------------------------------------------------------------------

test('Dropdown: im Stable-Kanal ausgeblendet, im Bleeding-Edge-Kanal sichtbar, aktiv immer sichtbar', () => {
  const configPath = setupProfile(ID);
  const values = (list) => list.map((o) => o.value);
  assert.ok(!values(dropdown(configPath, 'stable')).includes(ID), 'stable: ausgeblendet');
  const dev = dropdown(configPath, 'dev').find((o) => o.value === ID);
  assert.ok(dev, 'dev: sichtbar');
  assert.equal(dev.beta, true);
  assert.match(dev.label, /SolarEdge StorEdge.*nur Anzeige/);
  assert.ok(values(dropdown(configPath, 'stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
