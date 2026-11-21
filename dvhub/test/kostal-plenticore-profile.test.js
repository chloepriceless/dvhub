// Kostal PLENTICORE / PIKO IQ — mitgeliefertes Nur-Lese-Profil hersteller/kostal-plenticore.json.
// Echter Ladeweg (loadConfigFile), echter Poller gegen ein Schein-Gerät (Port 1502, Unit 71, FC 3, Float CDAB =
// Low-Wort zuerst), echter Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Register: .planning/docs/research/2026-11-15-kostal-modbus-control-spec.md §1–2, §4 (KOSTAL Rev. 2.9 [SPEC]).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import {
  TEST_HOST, readShippedProfile, setupProfile, loadProfile, writeTargets, evaluatorWrites, writableVariant, dropdown, readSet,
} from './helpers/read-only-profile-rig.js';

const ID = 'kostal-plenticore';
const UNIT = 71;
const CDAB = { wordOrder: 'le' };

// Rohbild wie ab Werk (Register 0x05 = 0 → Float CDAB). battery: Rohwert 582 (KOSTAL: + = Entladen). byteOrder:
// Register 0x05 (Kennungsprobe E10); null = Register fehlt.
function device({ meter = -1234.4, pv = 6120.7, battery = -2500, soc = 77, maxCharge = 6000, maxDischarge = 5000, byteOrder = 0 } = {}) {
  const dev = createRegisterDevice({ defaultUnitId: UNIT });
  if (byteOrder != null) dev.set(5, byteOrder);
  return dev
    .setFloat32(252, meter, CDAB)
    .setFloat32(1066, pv, CDAB)
    .set(582, battery)
    .set(514, soc)
    .setFloat32(1076, maxCharge, CDAB)
    .setFloat32(1078, maxDischarge, CDAB);
}

function effective() {
  return loadProfile(ID).effectiveConfig;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('kostal-plenticore.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /Kostal PLENTICORE/);
  assert.match(raw.label, /— nur Anzeige$/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /^Nur Anzeige, keine Steuerung, am Gerät ungeprüft\./);
  assert.match(raw.help, /docs\/hersteller\/kostal-plenticore\.md/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Port 1502, Unit 71, Zähler als Float-Punkt 252 (CDAB) ohne fremde Phasen', () => {
  const loaded = loadProfile(ID);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', 1502, UNIT]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.address, cfg.meter.readType, cfg.meter.wordOrder, cfg.meter.sign, cfg.meter.phases],
    ['point', 3, 252, 'float32', 'le', undefined, undefined]
  );
  assert.deepEqual([cfg.meter.port, cfg.meter.unitId], [1502, UNIT]);
  assert.deepEqual(Object.keys(cfg.points).sort(),
    ['batteryPowerW', 'deviceMaxChargeW', 'deviceMaxDischargeW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    if (!p.enabled) continue;
    assert.equal(p.fc, 3, 'KOSTAL: nur FC 03');
    assert.deepEqual([p.host, p.port, p.unitId], [TEST_HOST, 1502, UNIT]);
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

test('Poller (Tag): Float CDAB; Einspeisung (252 negativ) bleibt negativ, 582 negativ → Laden positiv', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -1234, '252: −1234,4 W (KOSTAL: − = Einspeisung), auf ganze Watt');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.gridExportW, 1234);
  assert.equal(state.victron.pvPowerW, 6120.7);
  assert.equal(state.victron.batteryPowerW, 2500, '582 −2500 (KOSTAL: − = Laden) → DVhub +2500');
  assert.equal(state.victron.batteryChargeW, 2500);
  assert.equal(state.victron.soc, 77);
  // 6120,7 PV + 0 Bezug − 1234 Einspeisung − 2500 Laden
  assert.equal(state.victron.selfConsumptionW, 2386.7);
  assert.equal(state.victron.selfConsumptionDerived, true);
  assert.equal(state.victron.deviceMaxChargeW, 6000);
  assert.equal(state.victron.deviceMaxDischargeW, 5000);

  assert.deepEqual(readSet(dev.requests), [
    `3:${UNIT}:1066x2`, `3:${UNIT}:1076x2`, `3:${UNIT}:1078x2`, `3:${UNIT}:252x2`, `3:${UNIT}:514x1`, `3:${UNIT}:582x1`, `3:${UNIT}:5x1`,
  ]);
  assert.equal(state.victron.identityProbe.status, 'ok', 'Register 0x05 = 0 → Kennungsprobe bestanden');
  assert.ok(dev.requests.every((r) => r.host === TEST_HOST && r.port === 1502));
  assert.deepEqual(dev.writes, []);
});

test('Poller (Nacht, zweiter Takt): Bezug positiv, Entladen negativ, Last folgt', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 2386.7);

  dev.setFloat32(252, 845.2, CDAB).setFloat32(1066, 0, CDAB).set(582, 1200).set(514, 54);
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 845);
  assert.equal(state.victron.gridImportW, 845);
  assert.equal(state.victron.batteryPowerW, -1200);
  assert.equal(state.victron.batteryDischargeW, 1200);
  assert.equal(state.victron.soc, 54);
  // 0 PV + 845 Bezug + 1200 Entladen (E6: folgt jedem Takt)
  assert.equal(state.victron.selfConsumptionW, 2045);
});

test('Poller: Gerät in ABCD (Register 0x05 = 1) liefert sichtbar andere Werte — das Profil liest CDAB', async () => {
  const cfg = effective();
  const dev = device({ byteOrder: null }); // ohne Register 0x05: Probe nicht lesbar, Werte ungeprüft
  dev.setFloat32(252, 500, { wordOrder: 'be' });
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'unreadable');
  assert.notEqual(state.meter.grid_total_w, 500, 'ABCD-Wörter dürfen nicht zufällig als 500 W durchgehen');
});

// E10: Register 0x05 = 1 (ABCD) → alle Float-Werte wären falsch. DVhub zeigt Netz, PV, die Float-Grenzen und die
// daraus gerechnete Hauslast nicht an (und liest sie nicht); Akku 582 und SoC 514 (16 bit) bleiben.
test('E10: Register 0x05 = 1 (ABCD) → Float-Werte leer statt falsch, 16-bit-Werte bleiben, Hinweis nennt den Grund', async () => {
  const raw = readShippedProfile(ID);
  assert.deepEqual(raw.victron.identityProbe.checks.map((c) => [c.fc, c.address, c.equals]), [[3, 5, [0]]]);
  const cfg = effective();
  assert.deepEqual(cfg.victron.identityProbe.hideOnMismatch,
    ['meter', 'pvPowerW', 'deviceMaxChargeW', 'deviceMaxDischargeW', 'selfConsumptionW'], 'kommt in der wirksamen Config an');
  const dev = device({ byteOrder: 1 });
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  const id = state.victron.identityProbe;
  assert.equal(id.status, 'mismatch');
  assert.match(id.text, /Byte-Reihenfolge \(Register 0x05, 0 = CDAB\): Register 5 = 1 \(0x0001\), erwartet 0 \(0x0000\)/);
  assert.equal(state.meter.ok, false);
  assert.equal(state.meter.grid_total_w, null);
  for (const k of ['pvPowerW', 'deviceMaxChargeW', 'deviceMaxDischargeW', 'selfConsumptionW']) assert.equal(state.victron[k], null, k);
  assert.equal(state.victron.batteryPowerW, 2500);
  assert.equal(state.victron.soc, 77);
  assert.deepEqual(readSet(dev.requests), [`3:${UNIT}:514x1`, `3:${UNIT}:582x1`, `3:${UNIT}:5x1`], 'keine Float-Register gelesen');
  assert.deepEqual(dev.writes, []);
});

test('Poller: Akku meldet keine Grenze (Float-NaN) → Grenze leer, kein Fehler', async () => {
  const cfg = effective();
  const dev = device();
  dev.setWords(1076, [0x0000, 0x7fc0]); // NaN in CDAB
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.deviceMaxChargeW, null);
  assert.equal(state.victron.errors.deviceMaxChargeW, undefined);
});

test('Poller: Ganzzahl-Extremwerte (SoC 0xFFFF, Akku 0x8000) gelten als „kein Wert“, keine erfundene Hauslast', async () => {
  const cfg = effective();
  const dev = device();
  dev.set(514, 0xffff).set(582, 0x8000);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.soc, null, 'nicht 65535 %');
  assert.equal(state.victron.batteryPowerW, null, 'nicht +32 768 W');
  assert.equal(state.victron.selfConsumptionW ?? null, null);
  assert.equal(state.meter.ok, true);
});

// --- Beta-Gate -------------------------------------------------------------------------------------------------

test('Dropdown: im Stable-Kanal ausgeblendet, im Bleeding-Edge-Kanal sichtbar, aktiv immer sichtbar', () => {
  const configPath = setupProfile(ID);
  const values = (list) => list.map((o) => o.value);
  assert.ok(!values(dropdown(configPath, 'stable')).includes(ID), 'stable: ausgeblendet');
  const dev = dropdown(configPath, 'dev').find((o) => o.value === ID);
  assert.ok(dev, 'dev: sichtbar');
  assert.equal(dev.beta, true);
  assert.match(dev.label, /Kostal.*nur Anzeige/);
  assert.ok(values(dropdown(configPath, 'stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
