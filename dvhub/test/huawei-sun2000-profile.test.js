// Huawei SUN2000 + LUNA2000 (direkt) — mitgeliefertes Nur-Lese-Profil hersteller/huawei-sun2000.json.
// Echter Ladeweg (loadConfigFile), echter Poller gegen ein Schein-Gerät (Unit 1, FC 3, High-Wort zuerst), echter
// Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Register: .planning/docs/research/2026-11-15-huawei-modbus-control-spec.md §3 [SPEC], Vorzeichen nach evcc
// huawei-sun2000-hybrid.yaml [COMM] (37113 und 37765 je scale −1 bei evcc-Konvention).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import {
  TEST_HOST, readShippedProfile, setupProfile, loadProfile, writeTargets, evaluatorWrites, writableVariant, dropdown, readSet,
} from './helpers/read-only-profile-rig.js';

const ID = 'huawei-sun2000';

// Rohbild: SoC 0,1 %, alles andere I32/U32 in W, High-Wort zuerst.
function device({ soc = 734, battery = 2000, pv = 5200, meter = 1300, maxCharge = 5000, maxDischarge = 4500 } = {}) {
  return createRegisterDevice({ defaultUnitId: 1 })
    .set(37760, soc)
    .set32(37765, battery)
    .set32(32064, pv)
    .set32(37113, meter)
    .set32(47075, maxCharge)
    .set32(47077, maxDischarge);
}

function effective() {
  return loadProfile(ID).effectiveConfig;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('huawei-sun2000.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /Huawei SUN2000/);
  assert.match(raw.label, /— nur Anzeige$/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /^Nur Anzeige, keine Steuerung, am Gerät ungeprüft\./);
  assert.match(raw.help, /docs\/hersteller\/huawei-sun2000\.md/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus TCP 502, Unit 1, Zähler als int32-Punkt 37113 ohne fremde Phasen', () => {
  const loaded = loadProfile(ID);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId, cfg.victron.timeoutMs], ['modbus', 502, 1, 5000]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.address, cfg.meter.readType, cfg.meter.sign, cfg.meter.phases],
    ['point', 3, 37113, 'int32', -1, undefined]
  );
  assert.equal(cfg.meter.host, TEST_HOST);
  assert.deepEqual(Object.keys(cfg.points).sort(),
    ['batteryPowerW', 'deviceMaxChargeW', 'deviceMaxDischargeW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    if (!p.enabled) continue;
    assert.equal(p.fc, 3, 'Huawei: Holding-Register');
    assert.equal(p.host, TEST_HOST);
    assert.equal(p.unitId, 1);
  }
  assert.deepEqual(cfg.points.selfConsumptionW, {
    _comment: cfg.points.selfConsumptionW._comment, enabled: false, derive: 'energy_balance',
    host: TEST_HOST, port: 502, unitId: 1, timeoutMs: 5000,
  });
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

test('Poller (Tag): Einspeisung (37113 positiv) → Netz negativ, Laden positiv, SoC 0,1 %, Last aus der Bilanz', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -1300, '37113 +1300 = Einspeisung → DVhub −1300');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.gridExportW, 1300);
  assert.equal(state.victron.gridImportW, 0);
  assert.equal(state.victron.soc, 73.4);
  assert.equal(state.victron.batteryPowerW, 2000, '37765 +2000 = Laden, DVhub-Konvention ohne Drehung');
  assert.equal(state.victron.batteryChargeW, 2000);
  assert.equal(state.victron.pvPowerW, 5200);
  // 5200 PV + 0 Bezug − 1300 Einspeisung − 2000 Laden
  assert.equal(state.victron.selfConsumptionW, 1900);
  assert.equal(state.victron.selfConsumptionDerived, true);
  assert.equal(state.victron.deviceMaxChargeW, 5000);
  assert.equal(state.victron.deviceMaxDischargeW, 4500);

  // Gelesen werden genau die Profilregister — kein Victron-Register, keine Phase, keine Gerätekennung.
  assert.deepEqual(readSet(dev.requests), [
    '3:1:32064x2', '3:1:37113x2', '3:1:37760x1', '3:1:37765x2', '3:1:47075x2', '3:1:47077x2',
  ]);
  assert.ok(dev.requests.every((r) => r.host === TEST_HOST && r.port === 502));
  assert.deepEqual(dev.writes, []);
});

test('Poller (Nacht, zweiter Takt): Bezug (37113 negativ, I32) → Netz positiv, Entladen negativ, Last folgt', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 1900);

  dev.set(37760, 512).set32(37765, -1500).set32(32064, 0).set32(37113, -800);
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 800);
  assert.equal(state.victron.gridImportW, 800);
  assert.equal(state.victron.batteryPowerW, -1500);
  assert.equal(state.victron.batteryDischargeW, 1500);
  assert.equal(state.victron.soc, 51.2);
  // 0 PV + 800 Bezug + 1500 Entladen — die Ableitung friert nicht beim ersten Takt ein (E6)
  assert.equal(state.victron.selfConsumptionW, 2300);
  // Gerätegrenzen nur einmal je Minute
  assert.equal(dev.requests.filter((r) => r.address === 47075).length, 1);
});

test('Poller: Akku ohne Antwort → keine erfundene Hauslast', async () => {
  const cfg = effective();
  const dev = createRegisterDevice({ defaultUnitId: 1 }).set(37760, 500).set32(32064, 3000).set32(37113, 0);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.match(state.victron.errors.batteryPowerW, /exception 2/);
  assert.equal(state.victron.selfConsumptionW ?? null, null, 'konfigurierter Akku muss gelesen sein, sonst keine Bilanz');
});

// Codex e29df149: Huawei meldet „kein Wert“ mit dem Höchstwert des Typs (wlcrs number.py: I32 0x7FFFFFFF,
// U16 0xFFFF, U32 0xFFFFFFFF; evcc int32nan zusätzlich 0x80000000). Ohne notAvailableRaw wurde daraus ein gesunder
// Zähler mit −2 147 483 647 W, ein SoC von 6553,5 % und eine erfundene Hauslast.
test('Poller: „kein Wert“-Sentinels → Zählerfehler bzw. leere Werte, keine erfundene Hauslast', async () => {
  const cfg = effective();
  const dev = createRegisterDevice({ defaultUnitId: 1 })
    .set(37760, 0xffff)
    .setWords(37765, [0x7fff, 0xffff])
    .setWords(32064, [0x8000, 0x0000])
    .setWords(37113, [0x7fff, 0xffff])
    .setWords(47075, [0xffff, 0xffff])
    .setWords(47077, [0xffff, 0xffff]);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false, 'Netz ohne Wert ist ein Zählerfehler, nie ein gesunder Extremwert');
  assert.match(state.meter.error, /keinen Gesamtwert/);
  assert.equal(state.victron.soc, null);
  assert.equal(state.victron.batteryPowerW, null);
  assert.equal(state.victron.pvPowerW, null, '0x80000000 (evcc int32nan) ebenso');
  assert.equal(state.victron.deviceMaxChargeW, null);
  assert.equal(state.victron.deviceMaxDischargeW, null);
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
  assert.match(dev.label, /Huawei SUN2000.*nur Anzeige/);
  assert.ok(values(dropdown(configPath, 'stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
