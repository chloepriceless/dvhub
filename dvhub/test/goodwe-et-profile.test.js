// GoodWe ET/EH/BT/BH (Hybrid) — mitgeliefertes Nur-Lese-Profil hersteller/goodwe-et.json.
// Echter Ladeweg (loadConfigFile), echter Poller gegen ein Schein-Gerät (Slave-ID 247, FC 3, High-Wort zuerst),
// echter Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Register: .planning/docs/research/2026-11-15-goodwe-modbus-control-spec.md §2 [SPEC], Vorzeichen nach evcc
// goodwe-hybrid.yaml [COMM] (36025 scale −1, 35182 unverändert bei evcc-Konvention Akku + = Entladen).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import {
  TEST_HOST, readShippedProfile, setupProfile, loadProfile, writeTargets, evaluatorWrites, writableVariant, dropdown, readSet,
} from './helpers/read-only-profile-rig.js';

const ID = 'goodwe-et';
const UNIT = 247;

// Rohbild: SoC 1 %, Leistungen S32/U32 in W, High-Wort zuerst. battery: Rohwert (+ = Entladen), meter: Rohwert
// (+ = Einspeisung).
function device({ soc = 68, battery = -2000, pv = [2600, 2400, 0, 0], meter = 1000 } = {}) {
  const dev = createRegisterDevice({ defaultUnitId: UNIT })
    .set(37007, soc)
    .set32(35182, battery)
    .set32(36025, meter);
  [35105, 35109, 35113, 35117].forEach((a, i) => dev.set32(a, pv[i]));
  return dev;
}

function effective() {
  return loadProfile(ID).effectiveConfig;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('goodwe-et.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /GoodWe ET\/EH\/BT\/BH/);
  assert.match(raw.label, /— nur Anzeige$/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /^Nur Anzeige, keine Steuerung, am Gerät ungeprüft\./);
  assert.match(raw.help, /docs\/hersteller\/goodwe-et\.md/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus TCP 502, Slave-ID 247, Zähler als int32-Punkt 36025 ohne fremde Phasen', () => {
  const loaded = loadProfile(ID);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', 502, UNIT]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.address, cfg.meter.readType, cfg.meter.sign, cfg.meter.phases],
    ['point', 3, 36025, 'int32', -1, undefined]
  );
  assert.equal(cfg.meter.unitId, UNIT);
  assert.deepEqual(Object.keys(cfg.points).sort(), ['batteryPowerW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    if (!p.enabled) continue;
    assert.equal(p.fc, 3, 'GoodWe: FC 03');
    assert.equal(p.host, TEST_HOST);
    assert.equal(p.unitId, UNIT);
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

test('Poller (Tag): Einspeisung (36025 positiv) → Netz negativ, 35182 negativ → Laden positiv, PV = 4 Strings', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -1000, '36025 +1000 = Einspeisung → DVhub −1000');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.gridExportW, 1000);
  assert.equal(state.victron.soc, 68);
  assert.equal(state.victron.batteryPowerW, 2000, '35182 −2000 (evcc: + = Entladen) → DVhub +2000 Laden');
  assert.equal(state.victron.batteryChargeW, 2000);
  assert.equal(state.victron.pvPowerW, 5000, '2600 + 2400 + 0 + 0');
  // 5000 PV + 0 Bezug − 1000 Einspeisung − 2000 Laden
  assert.equal(state.victron.selfConsumptionW, 2000);
  assert.equal(state.victron.selfConsumptionDerived, true);

  assert.deepEqual(readSet(dev.requests), [
    `3:${UNIT}:35105x2`, `3:${UNIT}:35109x2`, `3:${UNIT}:35113x2`, `3:${UNIT}:35117x2`,
    `3:${UNIT}:35182x2`, `3:${UNIT}:36025x2`, `3:${UNIT}:37007x1`,
  ]);
  assert.ok(dev.requests.every((r) => r.host === TEST_HOST && r.port === 502));
  assert.deepEqual(dev.writes, []);
});

test('Poller (Nacht, zweiter Takt): Bezug (36025 negativ) → Netz positiv, Entladen negativ, Last folgt', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 2000);

  dev.set(37007, 41).set32(35182, 1800).set32(36025, -600);
  [35105, 35109].forEach((a) => dev.set32(a, 0));
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 600);
  assert.equal(state.victron.gridImportW, 600);
  assert.equal(state.victron.batteryPowerW, -1800);
  assert.equal(state.victron.batteryDischargeW, 1800);
  assert.equal(state.victron.soc, 41);
  assert.equal(state.victron.pvPowerW, 0);
  // 0 PV + 600 Bezug + 1800 Entladen (E6: folgt jedem Takt)
  assert.equal(state.victron.selfConsumptionW, 2400);
});

test('Poller: U32-Strings über 65 535 W (C&I) und ein fehlender String macht PV unbekannt statt zu klein', async () => {
  const cfg = effective();
  const big = device({ pv: [70000, 0, 0, 0] });
  const r1 = createPollerRig(cfg, big);
  await r1.poller.requestPoll();
  assert.equal(r1.state.victron.pvPowerW, 70000);

  const dev = createRegisterDevice({ defaultUnitId: UNIT }).set(37007, 50).set32(35182, 0).set32(36025, 0)
    .set32(35105, 1000).set32(35109, 1000).set32(35113, 0); // 35117 fehlt
  const r2 = createPollerRig(effective(), dev);
  await r2.poller.requestPoll();
  assert.match(r2.state.victron.errors.pvPowerW, /exception 2/);
  assert.equal(r2.state.victron.selfConsumptionW ?? null, null, 'ohne gültige PV keine Bilanz');
});

test('Poller: „kein Wert“ (SoC 0xFFFF, PV-String 0xFFFFFFFF wie evcc *nan) → leer statt 6553 % bzw. 4,3 GW', async () => {
  const cfg = effective();
  const dev = device();
  dev.set(37007, 0xffff).setWords(35113, [0xffff, 0xffff]);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.soc, null);
  assert.equal(state.victron.pvPowerW, null, 'ein String ohne Wert macht die Summe unbekannt');
  assert.equal(state.victron.selfConsumptionW ?? null, null, 'ohne PV keine Bilanz');
  assert.equal(state.meter.ok, true, 'Netz bleibt gültig');
});

// --- Beta-Gate -------------------------------------------------------------------------------------------------

test('Dropdown: im Stable-Kanal ausgeblendet, im Bleeding-Edge-Kanal sichtbar, aktiv immer sichtbar', () => {
  const configPath = setupProfile(ID);
  const values = (list) => list.map((o) => o.value);
  assert.ok(!values(dropdown(configPath, 'stable')).includes(ID), 'stable: ausgeblendet');
  const dev = dropdown(configPath, 'dev').find((o) => o.value === ID);
  assert.ok(dev, 'dev: sichtbar');
  assert.equal(dev.beta, true);
  assert.match(dev.label, /GoodWe.*nur Anzeige/);
  assert.ok(values(dropdown(configPath, 'stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
