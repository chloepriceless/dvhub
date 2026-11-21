// SMA Speedwire (SMA-Modbus-Profil, Unit 3) — mitgeliefertes Nur-Lese-Profil hersteller/sma-speedwire.json.
// Echter Ladeweg (loadConfigFile), echter Poller gegen ein Schein-Gerät (Unit 3, FC 3, High-Wort zuerst), echter
// Evaluator für die Schreibwege, echtes Hersteller-Dropdown — und die E7-Taktung über den echten Transport mit
// falscher Uhr: SMA verlangt ≥ 10 s zwischen zwei Modbus-Transfers und höchstens 5 Werte je Transfer
// (SMA-Modbus-general-TI-en-10 §3.7).
// Register: .planning/docs/research/2026-11-15-sma-modbus-control-spec.md §3.2 [COMM], evcc sma-hybrid.yaml /
// sma-datamanager.yaml, Plexlog SMAInverterStorage (30865 mit 4 Registern, Bezug − Einspeisung) [DECOMP].
import test from 'node:test';
import assert from 'node:assert/strict';

import { createModbusTransport, modbusPacingFromConfig, normalizeModbusPacing } from '../transport-modbus.js';
import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import { installFakeModbusSockets, advance, flush, enableFakeClock, disableFakeClock } from './helpers/fake-modbus-socket.js';
import {
  TEST_HOST, readShippedProfile, setupProfile, loadProfile, writeTargets, evaluatorWrites, writableVariant, dropdown, readSet,
} from './helpers/read-only-profile-rig.js';

const ID = 'sma-speedwire';
const UNIT = 3;

// Rohbild (Tag): Einspeisung 1300 W, Akku lädt 2000 W, PV A 3000 + B 2200, SoC 73 %. Alle Werte 32 bit, High-Wort zuerst.
const DAY = { import: 0, export: 1300, charge: 2000, discharge: 0, pvA: 3000, pvB: 2200, soc: 73 };
function device(v = DAY) {
  return createRegisterDevice({ defaultUnitId: UNIT })
    .set32(30865, v.import).set32(30867, v.export)
    .set32(31393, v.charge).set32(31395, v.discharge)
    .set32(30773, v.pvA).set32(30961, v.pvB)
    .set32(30845, v.soc);
}

function effective() {
  return loadProfile(ID).effectiveConfig;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('sma-speedwire.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = readShippedProfile(ID);
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /^SMA /);
  assert.match(raw.label, /— nur Anzeige$/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /^Nur Anzeige, keine Steuerung, am Gerät ungeprüft\./);
  assert.match(raw.help, /10 Sekunden/);
  assert.match(raw.help, /docs\/hersteller\/sma-speedwire\.md/);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
  // Zweite Sicherung neben readOnly: das Profil selbst trägt kein Schreib- und kein Abregel-Ziel.
  assert.deepEqual(raw.controlWrite, {});
  assert.deepEqual(Object.keys(raw.dvControl).sort(), ['_comment', 'enabled']);
  assert.equal(raw.dvControl.enabled, false);
});

test('E7 nach SMA-Regel: ≥ 10 s zwischen Anfragen, ≤ 5 Werte (10 Register) je Anfrage, Poll-Takt ≥ 10 s', () => {
  const pacing = effective().victron.requestPacing;
  const n = normalizeModbusPacing(pacing);
  assert.ok(n, 'die Taktung ist gültig, nicht still „aus“');
  assert.ok(n.minRequestGapMs >= 10000, `Abstand ${n.minRequestGapMs}`);
  assert.ok(n.maxRegistersPerRequest > 0 && n.maxRegistersPerRequest <= 10, `Deckel ${n.maxRegistersPerRequest}`);
  assert.equal(n.maxRegistersPerRequest % 2, 0, 'gerade: kein 32-bit-Wert über zwei Anfragen');
  assert.ok(pacing.minPollIntervalMs >= 10000);
});

test('Laden: gültig, Modbus TCP 502, Unit 3, Zähler = Bezug − Einspeisung in einer Anfrage, keine fremden Phasen', () => {
  const loaded = loadProfile(ID);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.deepEqual([cfg.victron.transport, cfg.victron.port, cfg.victron.unitId, cfg.victron.timeoutMs], ['modbus', 502, 3, 5000]);
  assert.deepEqual(
    [cfg.meter.layout, cfg.meter.fc, cfg.meter.readType, cfg.meter.combineBlock, cfg.meter.combine, cfg.meter.phases],
    ['point', 3, 'int32', true, [{ address: 30865 }, { address: 30867, sign: -1 }], undefined]
  );
  assert.deepEqual([cfg.meter.host, cfg.meter.port, cfg.meter.unitId], [TEST_HOST, 502, 3]);
  assert.deepEqual(Object.keys(cfg.points).sort(), ['batteryPowerW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    if (!p.enabled) continue;
    assert.equal(p.fc, 3);
    assert.equal(p.host, TEST_HOST);
    assert.equal(p.unitId, UNIT);
  }
  assert.equal(cfg.points.selfConsumptionW.derive, 'energy_balance');
  assert.equal(cfg.points.selfConsumptionW.enabled, false);
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

test('Poller (Tag): Einspeisung → Netz negativ, Laden positiv, PV A + B, SoC, Last aus der Bilanz; 5 Anfragen à ≤ 2 Werte', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, -1300, '30865 0 − 30867 1300 → Einspeisung');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null]);
  assert.equal(state.victron.gridExportW, 1300);
  assert.equal(state.victron.gridImportW, 0);
  assert.equal(state.victron.soc, 73);
  assert.equal(state.victron.batteryPowerW, 2000, '31393 2000 − 31395 0 → Laden positiv');
  assert.equal(state.victron.batteryChargeW, 2000);
  assert.equal(state.victron.pvPowerW, 5200);
  // 5200 PV + 0 Bezug − 1300 Einspeisung − 2000 Laden
  assert.equal(state.victron.selfConsumptionW, 1900);
  assert.equal(state.victron.selfConsumptionDerived, true);

  // Genau diese fünf Anfragen — kein Victron-Register, kein SunSpec-Scan, keine Phase, keine Gerätekennung.
  assert.deepEqual(readSet(dev.requests), ['3:3:30773x2', '3:3:30845x2', '3:3:30865x4', '3:3:30961x2', '3:3:31393x4']);
  assert.equal(dev.requests.length, 5);
  assert.ok(dev.requests.every((r) => r.quantity <= 4), 'höchstens zwei 32-bit-Werte je Anfrage (SMA: ≤ 5)');
  assert.ok(dev.requests.every((r) => r.host === TEST_HOST && r.port === 502));
  assert.deepEqual(dev.writes, []);
});

test('Poller (Nacht, zweiter Takt): Bezug → Netz positiv, Entladen negativ, Last folgt', async () => {
  const cfg = effective();
  const dev = device();
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 1900);

  dev.set32(30865, 800).set32(30867, 0).set32(31393, 0).set32(31395, 1500).set32(30773, 0).set32(30961, 0).set32(30845, 51);
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 800);
  assert.equal(state.victron.gridImportW, 800);
  assert.equal(state.victron.batteryPowerW, -1500);
  assert.equal(state.victron.batteryDischargeW, 1500);
  assert.equal(state.victron.soc, 51);
  assert.equal(state.victron.pvPowerW, 0);
  // 0 PV + 800 Bezug + 1500 Entladen
  assert.equal(state.victron.selfConsumptionW, 2300);
});

test('Poller: SMA-„kein Wert“ (S32 0x80000000, U32 0xFFFFFFFF) → Zählerfehler bzw. leere Werte, keine erfundene Hauslast', async () => {
  const cfg = effective();
  const NAN_S32 = [0x8000, 0x0000];
  const NAN_U32 = [0xffff, 0xffff];
  const dev = createRegisterDevice({ defaultUnitId: UNIT })
    .setWords(30865, NAN_S32).set32(30867, 0)
    .setWords(31393, NAN_U32).set32(31395, 0)
    .set32(30773, 1000).setWords(30961, NAN_S32)
    .setWords(30845, NAN_U32);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false, 'Netz ohne Wert ist ein Zählerfehler, nie ein gesunder Extremwert');
  assert.match(state.meter.error, /keinen Gesamtwert/);
  assert.equal(state.victron.soc, null, 'nicht 4 294 967 295 %');
  assert.equal(state.victron.batteryPowerW, null);
  assert.equal(state.victron.pvPowerW, null, 'Eingang B ohne Wert (ein MPPT) → PV-Summe leer, nicht 1000 − 2 147 483 648');
  assert.equal(state.victron.selfConsumptionW ?? null, null);
});

test('Poller: Gerät ohne Akku (SB/STP) antwortet mit Ausnahme 2 → keine erfundene Hauslast', async () => {
  const cfg = effective();
  const dev = createRegisterDevice({ defaultUnitId: UNIT }).set32(30865, 400).set32(30867, 0).set32(30773, 900).set32(30961, 0);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 400);
  assert.equal(state.victron.pvPowerW, 900);
  assert.match(state.victron.errors.batteryPowerW, /exception 2/);
  assert.equal(state.victron.selfConsumptionW ?? null, null, 'konfigurierter Akku muss gelesen sein, sonst keine Bilanz');
});

// --- E7 am echten Transport -------------------------------------------------------------------------------------------

test('E7 am Draht (falsche Uhr): echter Transport mit Taktung aus der Config — jede Anfrage 10 s nach der vorigen', async () => {
  const cfg = effective();
  assert.equal(cfg.meterPollMs, 2000, 'Werks-Poll-Intervall 2 s');
  enableFakeClock();
  const t0 = Date.now();
  const sockets = installFakeModbusSockets();
  const transport = createModbusTransport({ pacingFor: modbusPacingFromConfig(() => cfg) });
  const { state, poller } = createPollerRig(cfg, transport);
  delete cfg.pollMs; // createPollerRig setzt den Testtakt 500 ms; hier gilt der echte (meterPollMs) — angehoben auf 10 s
  try {
    for (const [a, v] of [[30865, 0], [30867, 1300], [31393, 2000], [31395, 0], [30773, 3000], [30961, 2200], [30845, 73]]) {
      sockets.set32(UNIT, a, v);
    }
    poller.start();
    await advance(45000);
    const cycle1 = sockets.wire.map((f) => `${f.address}x${f.quantity}@${f.t}`);
    assert.deepEqual(cycle1, ['30865x4@0', '30845x2@10000', '31393x4@20000', '30773x2@30000', '30961x2@40000'],
      'ein Takt: fünf Anfragen, je 10 s nach dem Ende der vorigen');
    assert.ok(sockets.wire.every((f) => f.fc === 3 && f.unitId === UNIT && f.quantity <= 10));
    assert.equal(state.meter.grid_total_w, -1300);
    assert.equal(state.victron.selfConsumptionW, 1900);
    assert.equal(state.meter.nextRetryAt - t0, 40000 + 10000,
      'nächster Takt 10 s (minPollIntervalMs) nach dem Ende des ersten, nicht nach meterPollMs (2 s)');
    await advance(15000);
    const gaps = sockets.wire.slice(1).map((f, i) => f.t - sockets.wire[i].t);
    assert.ok(sockets.wire.length >= 6, 'der zweite Takt hat begonnen');
    assert.ok(gaps.every((g) => g >= 10000), `nie zwei Anfragen in weniger als 10 s: ${gaps}`);
    assert.deepEqual(sockets.events.map((e) => e.ev), ['connect'], 'eine Verbindung, kein Neuaufbau');
  } finally {
    poller.stop();
    await transport.destroy();
    await flush();
    sockets.restore();
    disableFakeClock();
  }
});

// Codex 6ab2b78e (P2): mit Taktung liegen ~40 s zwischen der Zählerlesung (Takt-Anfang) und den Punkten. Bezug und
// Einspeisung (victron.gridImportW/gridExportW) müssen zum neuen meter.updatedAt passen, sobald der stempelt — der
// my-PV-Heizstab prüft die Frische am Zählerstempel und regelte sonst 40 s lang auf alter Einspeisung bei Netzbezug.
test('Codex 6ab2b78e: Bezug/Einspeisung passen sofort zum neuen Zählerstempel, nicht erst nach den Punkten', async () => {
  const cfg = effective();
  enableFakeClock();
  const t0 = Date.now();
  const sockets = installFakeModbusSockets();
  const transport = createModbusTransport({ pacingFor: modbusPacingFromConfig(() => cfg) });
  const { state, poller } = createPollerRig(cfg, transport);
  delete cfg.pollMs;
  try {
    for (const [a, v] of [[30865, 0], [30867, 3000], [31393, 0], [31395, 0], [30773, 3500], [30961, 0], [30845, 50]]) sockets.set32(UNIT, a, v);
    poller.start();
    await advance(45000);
    assert.deepEqual([state.victron.gridExportW, state.victron.gridImportW], [3000, 0]);
    // Wolke: aus 3000 W Einspeisung werden 2000 W Bezug. Der zweite Takt liest den Zähler bei 50 s.
    sockets.set32(UNIT, 30865, 2000).set32(UNIT, 30867, 0);
    await advance(6000);
    assert.equal(sockets.wire.at(-1).address, 30865, 'zweiter Takt: Zähler gelesen, Punkte stehen noch aus');
    assert.equal(state.meter.updatedAt - t0, 50000);
    assert.equal(state.meter.grid_total_w, 2000, 'Zähler: 2000 W Bezug (+ = Bezug)');
    assert.deepEqual([state.victron.gridImportW, state.victron.gridExportW], [2000, 0],
      'abgeleitete Werte gehören zur selben Zählerlesung wie meter.updatedAt');
  } finally {
    poller.stop();
    await transport.destroy();
    await flush();
    sockets.restore();
    disableFakeClock();
  }
});

test('E7: die Taktung gilt nur für die Anlagen-Verbindung — eine andere Adresse am selben Transport wartet nicht', () => {
  const cfg = effective();
  const pacingFor = modbusPacingFromConfig(() => cfg);
  assert.ok(normalizeModbusPacing(pacingFor(TEST_HOST, 502)));
  assert.equal(pacingFor('192.0.2.99', 502), null, 'z. B. eine Modbus-Wallbox');
  assert.equal(pacingFor(TEST_HOST, 1502), null);
});

// --- Beta-Gate -------------------------------------------------------------------------------------------------

test('Dropdown: im Stable-Kanal ausgeblendet, im Bleeding-Edge-Kanal sichtbar, aktiv immer sichtbar', () => {
  const configPath = setupProfile(ID);
  const values = (list) => list.map((o) => o.value);
  assert.ok(!values(dropdown(configPath, 'stable')).includes(ID), 'stable: ausgeblendet');
  const dev = dropdown(configPath, 'dev').find((o) => o.value === ID);
  assert.ok(dev, 'dev: sichtbar');
  assert.equal(dev.beta, true);
  assert.match(dev.label, /SMA.*nur Anzeige/);
  assert.ok(values(dropdown(configPath, 'stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
