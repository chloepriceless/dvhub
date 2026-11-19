// AlphaESS SMILE (SMILE5/B3/G3) — mitgeliefertes Nur-Lese-Profil hersteller/alphaess-smile.json.
// Echter Ladeweg (loadConfigFile), echter Poller gegen ein Schein-Gerät (Unit 85, FC 3, High-Wort zuerst), echter
// Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Register: AlphaESS Modbus-Protokoll V1.17 [SPEC] (SoC 0x102, Akku 0x126 „−: Charge, +: Discharge“, PV 0x41F/0x423/
// 0x427, Grenzen 0x12C/0x12D) und die neuere Registerliste bzw. evcc alpha-ess-smile.yaml [COMM] (Netz 0x21 int32).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import { createModbusTransport, modbusPacingFromConfig, normalizeModbusPacing } from '../transport-modbus.js';
import { installFakeModbusSockets, advance, flush, enableFakeClock, disableFakeClock } from './helpers/fake-modbus-socket.js';
import {
  TEST_HOST, readShippedProfile, setupProfile, loadProfile, writeTargets, evaluatorWrites, writableVariant, dropdown, readSet,
} from './helpers/read-only-profile-rig.js';

const ID = 'alphaess-smile';
const UNIT = 85;
const PV = [0x41f, 0x423, 0x427];

// Rohbild: Netz S32 1 W (+ = Bezug), SoC 0,1 %, Akku S16 1 W (− = Laden), PV je U32 1 W, Grenzen U16 1 W.
function device({ meter = -900, soc = 655, battery = -1800, pv = [2500, 2000, 0], maxCharge = 5000, maxDischarge = 4600 } = {}) {
  const dev = createRegisterDevice({ defaultUnitId: UNIT })
    .set32(0x21, meter)
    .set(0x102, soc)
    .set(0x126, battery)
    .set(0x12c, maxCharge)
    .set(0x12d, maxDischarge);
  PV.forEach((a, i) => dev.set32(a, pv[i]));
  return dev;
}

function effective() {
  return loadProfile(ID).effectiveConfig;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('alphaess-smile.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen (auch den Anfrage-Abstand)', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /AlphaESS SMILE/);
  assert.match(raw.label, /— nur Anzeige$/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /^Nur Anzeige, keine Steuerung, am Gerät ungeprüft\./);
  assert.match(raw.help, /300 ms.*400 ms/, 'Hilfetext nennt Herstellerregel und gehaltenen Abstand (E7)');
  assert.match(raw.help, /docs\/hersteller\/alphaess-smile\.md/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus TCP 502, Unit 85, Zähler als int32-Punkt 0x21 ohne fremde Phasen', () => {
  const loaded = loadProfile(ID);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId], ['modbus', 502, UNIT]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.address, cfg.meter.readType, cfg.meter.sign, cfg.meter.phases],
    ['point', 3, 0x21, 'int32', undefined, undefined]
  );
  assert.equal(cfg.meter.unitId, UNIT);
  assert.deepEqual(Object.keys(cfg.points).sort(),
    ['batteryPowerW', 'deviceMaxChargeW', 'deviceMaxDischargeW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    if (!p.enabled) continue;
    assert.equal(p.fc, 3, 'AlphaESS: Holding-Register');
    assert.equal(p.host, TEST_HOST);
    assert.equal(p.unitId, UNIT);
  }
  assert.deepEqual(cfg.points.pvPowerW.combine.map((t) => t.address), PV, 'nur PV1–PV3 (in V1.17 und neu gleich)');
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

test('Poller (Tag): Einspeisung (0x21 negativ) → Netz negativ, 0x126 negativ → Laden positiv, PV = 3 MPPT', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -900, '0x21 −900 = Einspeisung, DVhub-Konvention ohne Drehung');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.gridExportW, 900);
  assert.equal(state.victron.soc, 65.5);
  assert.equal(state.victron.batteryPowerW, 1800, '0x126 −1800 („−: Charge“) → DVhub +1800 Laden');
  assert.equal(state.victron.batteryChargeW, 1800);
  assert.equal(state.victron.pvPowerW, 4500, '2500 + 2000 + 0');
  // 4500 PV + 0 Bezug − 900 Einspeisung − 1800 Laden
  assert.equal(state.victron.selfConsumptionW, 1800);
  assert.equal(state.victron.selfConsumptionDerived, true);
  assert.equal(state.victron.deviceMaxChargeW, 5000);
  assert.equal(state.victron.deviceMaxDischargeW, 4600);

  // Gelesen werden genau die Profilregister — kein V1.17-Netzregister 0x06, kein PV4–6, kein Victron-Register.
  assert.deepEqual(readSet(dev.requests), [
    `3:${UNIT}:1055x2`, `3:${UNIT}:1059x2`, `3:${UNIT}:1063x2`,
    `3:${UNIT}:258x1`, `3:${UNIT}:294x1`, `3:${UNIT}:300x1`, `3:${UNIT}:301x1`, `3:${UNIT}:33x2`,
  ]);
  assert.ok(dev.requests.every((r) => r.host === TEST_HOST && r.port === 502));
  assert.equal(dev.requests.length, 8, 'ein Takt: 6 Messwerte + 2 Grenzen — ohne Abstand (E7 fehlt)');
  assert.deepEqual(dev.writes, []);
});

test('Poller (Nacht, zweiter Takt): Bezug (0x21 positiv) → Netz positiv, Entladen negativ, Last folgt', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 1800);

  dev.set32(0x21, 450).set(0x102, 312).set(0x126, 1300);
  PV.forEach((a) => dev.set32(a, 0));
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 450);
  assert.equal(state.victron.gridImportW, 450);
  assert.equal(state.victron.batteryPowerW, -1300);
  assert.equal(state.victron.batteryDischargeW, 1300);
  assert.equal(state.victron.soc, 31.2);
  assert.equal(state.victron.pvPowerW, 0);
  // 0 PV + 450 Bezug + 1300 Entladen (E6: folgt jedem Takt)
  assert.equal(state.victron.selfConsumptionW, 1750);
  for (const a of [0x12c, 0x12d]) assert.equal(dev.requests.filter((r) => r.address === a).length, 1, 'Grenzen nur einmal je Minute');
});

test('Poller: Gerät mit alter V1.17-Belegung (kein 0x21) → Zählerfehler, keine erfundene Hauslast', async () => {
  const cfg = effective();
  const dev = createRegisterDevice({ defaultUnitId: UNIT })
    .set32(0x06, -900) // V1.17: Summe an 0x0006 — das Profil liest es bewusst nicht
    .set(0x102, 500).set(0x126, 0).set(0x12c, 5000).set(0x12d, 5000);
  PV.forEach((a) => dev.set32(a, 1000));
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false);
  assert.match(state.meter.error, /exception 2/);
  assert.equal(state.victron.pvPowerW, 3000, 'PV1–3 liegen in beiden Fassungen gleich');
  assert.equal(state.victron.selfConsumptionW ?? null, null, 'ohne Netz keine Bilanz');
  assert.ok(!dev.requests.some((r) => r.address === 0x06));
});

test('Poller: „kein Wert“ (SoC 0xFFFF, Akku 0x8000, PV-String 0xFFFFFFFF) → leer statt Extremwert', async () => {
  const cfg = effective();
  const dev = device();
  dev.set(0x102, 0xffff).set(0x126, 0x8000).setWords(0x427, [0xffff, 0xffff]);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.soc, null);
  assert.equal(state.victron.batteryPowerW, null);
  assert.equal(state.victron.pvPowerW, null, 'ein String ohne Wert macht die Summe unbekannt');
  assert.equal(state.victron.selfConsumptionW ?? null, null);
  assert.equal(state.meter.ok, true, 'Netz bleibt gültig');

  const second = device();
  second.setWords(0x21, [0x7fff, 0xffff]);
  const r2 = createPollerRig(effective(), second);
  await r2.poller.requestPoll();
  assert.equal(r2.state.meter.ok, false, 'Netz 0x7FFFFFFF ist kein Bezug von 2,1 GW');
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
  assert.match(dev.label, /AlphaESS SMILE.*nur Anzeige/);
  assert.ok(values(dropdown(configPath, 'stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});

// --- E7: Abstand zwischen den Anfragen ------------------------------------------------------------------------------

// AlphaESS „Instruction interval > 300 ms“ [SPEC V1.17]; DVhub hält wie bei Solis 400 ms ab Antwortende. Echter
// Transport mit Taktung aus der wirksamen Config, falsche Uhr.
test('E7: 400 ms ab Antwortende zwischen zwei Anfragen, kein Registerdeckel, Poll-Takt bleibt beim Betreiber', async () => {
  const cfg = effective();
  assert.deepEqual(normalizeModbusPacing(cfg.victron.requestPacing), { minRequestGapMs: 400, connectDelayMs: 0, maxRegistersPerRequest: 0 });
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
    assert.ok(sockets.wire.length >= 6, `ein ganzer Takt (${sockets.wire.length} Anfragen)`);
    assert.ok(gaps.every((g) => g >= 400), `nie unter 400 ms: ${gaps}`);
    assert.ok(sockets.wire.every((f) => f.fc === 3 && f.quantity <= 2), JSON.stringify(sockets.wire));
  } finally {
    await transport.destroy();
    await flush();
    sockets.restore();
    disableFakeClock();
  }
});
