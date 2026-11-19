// Sungrow-EMS (T-0422, Beta): DVhubs Netz-Sollwert über EMS-Modus/Befehl/Leistung (Doku 13050–13052).
// Rein: Regler-Entscheidung mit von Hand gerechneten Zahlen. Aktuator: Writes + Rücklesen gegen ein
// Register-Abbild, Not-Halt, fremder EMS-Modus, Ablauf. Integration: echter Evaluator mit dem
// ausgelieferten Profil (EEG-Tor, SoC-Boden, Not-Halt-Tor) und ein Durchlauf über echtes Modbus TCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createScheduleEvaluator } from '../schedule-eval.js';
import { createPoller } from '../polling.js';
import { createModbusTransport } from '../transport-modbus.js';
import { setEmergencyStop } from '../services/control-commands.js';
import fs from 'node:fs';
import {
  decideEmsCommand, createSungrowEms, emsMatches, resolveSungrowControl, EMS_CMD, EMS_MODE, wire
} from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const MODE = wire(13050);
const CMD = wire(13051);
const POWER = wire(13052);
const HB = wire(13080);

// --- Regler (rein) ---------------------------------------------------------------

const base = { maxChargeW: 10000, maxDischargeW: 10000, bandW: 300, gain: 0.7, minPowerW: 50 };

test('Regler: Sollwert im Band (Puffer −40 W, 0, +300) → Self-consumption', () => {
  for (const s of [-40, 0, 300, -300]) {
    assert.deepEqual(decideEmsCommand({ ...base, setpointW: s, gridImportW: 0, batteryW: 0 }), { mode: 'self', reason: 'band' });
  }
  assert.equal(decideEmsCommand({ ...base, setpointW: null }).reason, 'no_setpoint');
});

test('Regler: Netzladen 4 kW nachts — Schritt 1 und 2 von Hand gerechnet', () => {
  // Haus 500 W aus dem Akku (Self-consumption): Akku −500, Netz 0.
  // P = −500 + 0,7 · (4000 − 0) = 2300 → Laden 2300 W
  assert.deepEqual(decideEmsCommand({ ...base, setpointW: 4000, gridImportW: 0, batteryW: -500, pvW: 0, loadW: 500 }),
    { mode: 'forced', command: 'charge', powerW: 2300, reason: 'regulate' });
  // Danach Netz 500 + 2300 = 2800, Akku +2300: P = 2300 + 0,7 · 1200 = 3140
  assert.equal(decideEmsCommand({ ...base, setpointW: 4000, gridImportW: 2800, batteryW: 2300, pvW: 0, loadW: 500 }).powerW, 3140);
});

test('Regler: Einspeisen 5 kW aus dem Akku, begrenzt auf die BDC-Leistung', () => {
  // P = −500 + 0,7 · (−5000 − 0) = −4000 → Entladen 4000 W
  assert.deepEqual(decideEmsCommand({ ...base, setpointW: -5000, gridImportW: 0, batteryW: -500, pvW: 0, loadW: 500 }),
    { mode: 'forced', command: 'discharge', powerW: 4000, reason: 'regulate' });
  assert.equal(decideEmsCommand({ ...base, maxDischargeW: 3000, setpointW: -5000, gridImportW: 0, batteryW: -500, pvW: 0, loadW: 500 }).powerW, 3000);
});

test('Regler: angefragt ≠ geliefert — liefert der Akku weniger, wächst die Vorgabe nicht über die Grenze', () => {
  // Vorgabe war 5000 W Entladen, der Akku liefert nur 3000 W (BMS-Grenze): Netz = 500 − 3000 = −2500.
  // P = −3000 + 0,7 · (−6000 + 2500) = −5450 → auf 5000 begrenzt, nicht weiter hochgezählt.
  const d = decideEmsCommand({ ...base, maxDischargeW: 5000, setpointW: -6000, gridImportW: -2500, batteryW: -3000, pvW: 0, loadW: 500 });
  assert.deepEqual([d.command, d.powerW], ['discharge', 5000]);
  // Zehn Takte mit demselben Messbild: gleiche Vorgabe (Messung statt Vorgabe als Basis → kein Aufziehen).
  for (let i = 0; i < 10; i += 1) {
    assert.equal(decideEmsCommand({ ...base, maxDischargeW: 5000, setpointW: -6000, gridImportW: -2500, batteryW: -3000, pvW: 0, loadW: 500 }).powerW, 5000);
  }
});

test('Regler: kein Netzbezug gewünscht → Laden nur aus dem PV-Überschuss', () => {
  // Einspeisen 2 kW mittags, PV 6 kW, Haus 1 kW, Akku lädt 5 kW: P = 5000 + 0,7 · (−2000) = 3600 (≤ Überschuss 5000)
  assert.deepEqual(decideEmsCommand({ ...base, setpointW: -2000, gridImportW: 0, batteryW: 5000, pvW: 6000, loadW: 1000 }),
    { mode: 'forced', command: 'charge', powerW: 3600, reason: 'regulate' });
  // Wolke: PV 2 kW, Netz +1500: P = 3600 + 0,7 · (−3500) = 1150 → Überschuss nur 1000 → 1000 W
  assert.deepEqual(decideEmsCommand({ ...base, setpointW: -2000, gridImportW: 1500, batteryW: 3600, pvW: 2000, loadW: 1000 }),
    { mode: 'forced', command: 'charge', powerW: 1000, reason: 'charge_pv_only' });
  // PV/Last unbekannt → kein Laden (Stopp statt Netzladen)
  assert.deepEqual(decideEmsCommand({ ...base, setpointW: -2000, gridImportW: 0, batteryW: 5000 }),
    { mode: 'forced', command: 'stop', powerW: 0, reason: 'charge_pv_only' });
});

test('Regler: keine Einspeisung gewünscht → Entladen höchstens die Netto-Last', () => {
  // S = +400, Netz −1600, Akku −2000, PV 0, Last 400: P = −2000 + 0,7 · 2000 = −600 → Netto-Last 400 → 400 W
  assert.deepEqual(decideEmsCommand({ ...base, setpointW: 400 + 1, gridImportW: -1600, batteryW: -2000, pvW: 0, loadW: 400 }),
    { mode: 'forced', command: 'discharge', powerW: 400, reason: 'discharge_load_only' });
  // EOS „Akku halten“ (S = Last − PV − Puffer = 1400): Akku deckt bisher 1500 W
  // P = −1500 + 0,7 · (1400 − 0) = −520 → Entladen 520 W (Puffer-Anteil), Netz ≈ 980 W
  assert.equal(decideEmsCommand({ ...base, setpointW: 1400, gridImportW: 0, batteryW: -1500, pvW: 0, loadW: 1500 }).powerW, 520);
});

test('Regler: EOS „Akku halten“ (Netz nur für die Last) lädt nie aus dem Netz', () => {
  // Last fällt von 1500 auf 200 W, der alte Sollwert 1400 steht noch, Akku entlädt 520 W → Netz −320.
  // P = −520 + 0,7 · (1400 + 320) = 684 → ohne Sperre Laden 680 W aus dem Netz,
  // mit noGridCharge nur aus dem PV-Überschuss (PV 0 − Last 200 → 0) → Stopp.
  const args = { ...base, setpointW: 1400, gridImportW: -320, batteryW: -520, pvW: 0, loadW: 200 };
  assert.deepEqual(decideEmsCommand(args), { mode: 'forced', command: 'charge', powerW: 680, reason: 'regulate' });
  assert.deepEqual(decideEmsCommand({ ...args, noGridCharge: true }), { mode: 'forced', command: 'stop', powerW: 0, reason: 'charge_pv_only' });
});

test('Regler: ohne Messung oder ohne Leistungsgrenze keine Zwangsvorgabe; kleiner Rest → Stopp', () => {
  assert.equal(decideEmsCommand({ ...base, setpointW: 4000, gridImportW: null, batteryW: 0 }).reason, 'telemetry_missing');
  assert.equal(decideEmsCommand({ ...base, setpointW: 4000, gridImportW: 0, batteryW: null }).reason, 'telemetry_missing');
  assert.equal(decideEmsCommand({ ...base, maxChargeW: null, setpointW: 4000, gridImportW: 0, batteryW: 0 }).reason, 'power_limit_unknown');
  // P = 20 + 0,7 · (1000 − 1000) = 20 < 50 → Stopp
  assert.deepEqual(decideEmsCommand({ ...base, setpointW: 1000, gridImportW: 1000, batteryW: 20, pvW: 0, loadW: 980 }),
    { mode: 'forced', command: 'stop', powerW: 0, reason: 'regulate' });
});

test('BUG1 Forced: kein Band-Ruhezustand — Sollwert 0 wird geregelt (ohne forced bleibt Band)', () => {
  // Ohne forced-Flag (External/Default): Sollwert 0 liegt im Band → Self-consumption.
  assert.equal(decideEmsCommand({ ...base, setpointW: 0, gridImportW: -1000, batteryW: 0, pvW: 2000, loadW: 500 }).reason, 'band');
  // Im Forced mode (forced:true): KEIN Band. P = 0 + 0,7·(0 − (−1000)) = 700 → Laden (PV-Überschuss 1500 ≥ 700).
  assert.deepEqual(
    decideEmsCommand({ ...base, forced: true, setpointW: 0, gridImportW: -1000, batteryW: 0, pvW: 2000, loadW: 500 }),
    { mode: 'forced', command: 'charge', powerW: 700, reason: 'regulate' });
});

test('BUG1 Forced: Entlade-Boden (SoC < hardFloor) sperrt NUR Entladen, Laden aus PV bleibt erlaubt', () => {
  // SoC 3 < Boden 5, Sollwert 0, Netzbezug 800 (Defizit) → p<0 → Entladen gesperrt (0xCC nur diesen Takt).
  assert.deepEqual(
    decideEmsCommand({ ...base, forced: true, setpointW: 0, gridImportW: 800, batteryW: 0, pvW: 0, loadW: 800, socPct: 3, floorSocPct: 5 }),
    { mode: 'forced', command: 'stop', powerW: 0, reason: 'discharge_floor' });
  // Gleicher Boden, aber PV-Überschuss (Einspeisung −1200) → Laden ERLAUBT. P = 0 + 0,7·1200 = 840 (≤ Überschuss 1500).
  assert.deepEqual(
    decideEmsCommand({ ...base, forced: true, setpointW: 0, gridImportW: -1200, batteryW: 0, pvW: 2000, loadW: 500, socPct: 3, floorSocPct: 5 }),
    { mode: 'forced', command: 'charge', powerW: 840, reason: 'regulate' });
});

test('emsMatches: Self = Modus 0 + Stopp; Zwang mit Leistungstoleranz', () => {
  assert.equal(emsMatches({ mode: 0, cmd: 0xcc, powerW: 999 }, { mode: 'self' }), true);
  assert.equal(emsMatches({ mode: 0, cmd: 0xaa, powerW: 0 }, { mode: 'self' }), false);
  assert.equal(emsMatches({ mode: 2, cmd: 0xaa, powerW: 2350 }, { mode: 'forced', command: 'charge', powerW: 2300 }, 100), true);
  assert.equal(emsMatches({ mode: 2, cmd: 0xaa, powerW: 2450 }, { mode: 'forced', command: 'charge', powerW: 2300 }, 100), false);
  assert.equal(emsMatches({ mode: 2, cmd: 0xbb, powerW: 2300 }, { mode: 'forced', command: 'charge', powerW: 2300 }, 100), false);
});

// --- Aktuator ------------------------------------------------------------------------

function rig({ over = {}, device = sungrowDevice(), mockOpts = {}, controlMode = 'forced', heartbeatTimeoutS = 30, statePath = null, forcedHeartbeatPath = null, allowGridCharge = false } = {}) {
  // Netzladen ist am Aktuator standardmäßig verboten (D, rechtlich): Tests, die aus dem Netz laden, geben es
  // ausdrücklich frei (optimizer.allowGridCharge).
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode, heartbeatTimeoutS }, ...(allowGridCharge ? { optimizer: { allowGridCharge: true } } : {}) });
  const image = sungrowImage(over);
  const t = mockSungrow(image, mockOpts);
  let clock = 1_000_000;
  const now = () => clock;
  const state = {
    victron: { errors: {}, fieldUpdatedAt: {}, device },
    meter: { ok: true, updatedAt: clock, grid_total_w: 0 },
    ctrl: {}
  };
  const telemetry = ({ gridW = 0, batteryW = -500, pvW = 0, loadW = 500 } = {}) => {
    state.meter = { ok: true, updatedAt: clock, grid_total_w: gridW };
    Object.assign(state.victron, { batteryPowerW: batteryW, pvPowerW: pvW, selfConsumptionW: loadW });
    for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) state.victron.fieldUpdatedAt[f] = clock;
  };
  telemetry();
  const logs = [];
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, pushLog: (event, data) => logs.push({ event, data }), now, statePath, forcedHeartbeatPath });
  return { cfg, image, t, state, ems, logs, telemetry, advance: (ms) => { clock += ms; }, now };
}

// Zwei-WR-Forced-Split: Master und Slave an GETRENNTEN Transports/Abbildern (ein WiNet-S je WR). Der Slave bekommt
// NUR 13051/13052 (Feld #5: 13050-Writes am Slave werden verworfen, der Slave folgt dem Master-Modus).
const SLAVE_HOST = '192.168.68.83';
function splitRig({ masterOver = {}, slaveOver = {}, second = { batteryPowerW: -500, pvPowerW: 0, socPct: 50, bdcRatedW: 10000 },
  masterBattW = -1000, gridW = 0, strategyCharge = 'soc-balance', strategyDischarge = 'soc-balance',
  maxChargeW = 5000, maxDischargeW = 5000, batteryCapacityWh = 10000, optimizer = { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 } } = {}) {
  const secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, strategyCharge, strategyDischarge, maxChargeW, maxDischargeW, batteryCapacityWh };
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter }, optimizer });
  const masterImage = sungrowImage(masterOver);
  const slaveImage = sungrowImage(slaveOver);
  const masterT = mockSungrow(masterImage);
  const slaveT = mockSungrow(slaveImage);
  let clock = 1_000_000;
  const now = () => clock;
  const state = {
    victron: { errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice({ bdcRatedW: 10000 }), batteryPowerW: masterBattW, pvPowerW: 0, selfConsumptionW: 500, soc: 50, sungrowMasterSocPct: 50 },
    meter: { ok: true, updatedAt: clock, grid_total_w: gridW },
    ctrl: {},
    sungrowSecond: { online: true, updatedAt: clock, host: SLAVE_HOST, aggregate: true, ...second },
  };
  const logs = [];
  const slaveEms = createSungrowEms({
    state, getCfg: () => cfg, transport: slaveT, pushLog: (e, d) => logs.push({ event: e, data: d }), now,
    statusKey: 'sungrowEmsSlave', isSlave: true, connOverride: () => ({ host: SLAVE_HOST, port: 502, unitId: 1, timeoutMs: 1500 }),
  });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: masterT, pushLog: (e, d) => logs.push({ event: e, data: d }), now, slaveActuator: slaveEms });
  return { cfg, state, ems, slaveEms, masterT, slaveT, masterImage, slaveImage, logs, advance: (ms) => { clock += ms; }, now };
}

test('Forced-Split B2: Eintritt — Slave bekommt NUR Leistung+Befehl (kein 13050), Master Leistung+Befehl+Modus 2', async () => {
  // System-Akku −1000, Netz 0, Sollwert −6000 → P = −1000 + 0,7·(−6000) = −5200 → Entladen, 50/50 → je ~2600.
  const r = splitRig();
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  // Slave: NUR 13052 (Leistung) + 13051 (Befehl Entladen) — NIE 13050 (Feld #5).
  assert.deepEqual(r.slaveT.writes.map((w) => w.address).sort(), [CMD, POWER].sort());
  assert.ok(!r.slaveT.writes.some((w) => w.address === MODE), 'Slave bekommt KEINEN Modus-Write');
  assert.ok(r.slaveT.writes.some((w) => w.address === CMD && w.value === EMS_CMD.DISCHARGE));
  // Master: Leistung + Befehl + Modus 2.
  assert.ok(r.masterT.writes.some((w) => w.address === MODE && w.value === EMS_MODE.FORCED), 'Master Modus 2');
  assert.ok(r.masterT.writes.some((w) => w.address === CMD && w.value === EMS_CMD.DISCHARGE));
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
  // Beide Leistungen ~2600 (50/50), Summe ~5200.
  const mp = r.masterImage.holding.get(POWER); const sp = r.slaveImage.holding.get(POWER);
  assert.ok(Math.abs(mp - 2600) <= 60 && Math.abs(sp - 2600) <= 60, `master ${mp} slave ${sp}`);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_split_write'));
});

test('Forced-Split B3: gelesene Slave-Gerätegrenze (33048) kappt die Slave-Entladeleistung, Überlauf an den Master', async () => {
  // Slave meldet eine Entlade-Gerätegrenze von 1500 W (33048) — kleiner als das 5-kW-Feld. Der Slave bekommt
  // höchstens 1500 W, der Rest geht an den Master (Laden erbt diese Entladegrenze NICHT).
  const r = splitRig({ second: { batteryPowerW: -500, pvPowerW: 0, socPct: 50, bdcRatedW: 10000, maxDischargeWDevice: 1500 } });
  await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.ok(r.slaveImage.holding.get(POWER) <= 1500, `Slave ≤ 1500: ${r.slaveImage.holding.get(POWER)}`);
  assert.ok(r.masterImage.holding.get(POWER) > r.slaveImage.holding.get(POWER), 'Master übernimmt den Überlauf');
});

test('F1a Forced-Split: gelesene MASTER-Gerätegrenze (33048) kappt die Master-Entladeleistung, Überlauf an den Slave', async () => {
  // Gegenstück zu B3 für den Master: die im Poll gelesene Entlade-Gerätegrenze (state.victron.device.maxDischargeWDevice)
  // begrenzt den Master-Anteil — vorher hing er auf der BDC-Nennleistung (Grenzen-Vertauschung im Feld).
  const r = splitRig();
  r.state.victron.device.maxDischargeWDevice = 1500; // 33048 am Master, kleiner als das 5-kW-Feld
  await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.ok(r.masterImage.holding.get(POWER) <= 1500, `Master ≤ 1500: ${r.masterImage.holding.get(POWER)}`);
  assert.ok(r.slaveImage.holding.get(POWER) > r.masterImage.holding.get(POWER), 'Slave übernimmt den Überlauf');
});

test('Forced-Split B2: Slave-Rücklesung prüft NUR Befehl/Leistung (Modus folgt dem Master) — Eintritt scheitert nicht, obwohl Slave-Modus noch 0 ist', async () => {
  // Der Slave-Modus bleibt im Abbild 0 (folgt in echt dem Master; der Mock koppelt das nicht). Mit der Modus-
  // Prüfung am Slave würde der Eintritt fälschlich scheitern — er darf NICHT.
  const r = splitRig();
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.slaveImage.holding.get(MODE), EMS_MODE.SELF, 'Slave-Modus im Abbild unverändert (nie geschrieben)');
  assert.equal(r.state.ctrl.sungrowEmsSlave?.owns, true, 'DVhub merkt sich den Slave-Besitz (für Not-Halt)');
});

test('Absicherung C: releaseControl (Shutdown) nimmt den Einzel-WR sicher zurück — Modus 0 + Befehl 0xCC', async () => {
  const r = rig({ controlMode: 'forced' });
  await r.ems.applySetpoint(-5000, 'rule:abend'); // Entladen, Modus 2, owns
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  r.t.writes.length = 0;
  const res = await r.ems.releaseControl('shutdown');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.image.holding.get(MODE), EMS_MODE.SELF, 'Modus 0');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.STOP, 'Befehl 0xCC');
  assert.equal(r.state.ctrl.sungrowEms.owns, false, 'Besitz abgegeben');
});

test('Absicherung C: releaseControl schreibt auch im Not-Halt (sichere Rücknahme hat Vorrang)', async () => {
  const r = rig({ controlMode: 'forced' });
  await r.ems.applySetpoint(-5000, 'rule:abend');
  r.state.ctrl.discretionaryWritesPaused = true; // Not-Halt aktiv
  r.t.writes.length = 0;
  const res = await r.ems.releaseControl('shutdown');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.image.holding.get(MODE), EMS_MODE.SELF, 'auch im Not-Halt zurückgenommen');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.STOP);
});

// P5 / C3.2 Schreibklassen-Matrix (Christin 16.11.2026): Der Not-Halt sperrt DVhubs EIGENE Regel-Writes; aber
// releaseControl (geordnetes Beenden) und der Box-Watchdog (neutralize) dürfen den Forced-WR EINMAL neutralisieren
// — der Forced-WR hat keinen geräteeigenen Rückfall, sonst hinge er im Zwangsmodus. Das ist eine AUSDRÜCKLICHE,
// benannte Ausnahme. Dieser Test nagelt beide Seiten der Matrix fest (keine Verhaltensänderung).
test('P5 Schreibklassen-Matrix: Not-Halt sperrt eigene Writes, erlaubt aber releaseControl — genau EINE Neutralisierung', async () => {
  const r = rig({ controlMode: 'forced' });
  await r.ems.applySetpoint(-5000, 'rule:abend'); // Forced, owns
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  r.state.ctrl.discretionaryWritesPaused = true; // Not-Halt aktiv
  r.t.writes.length = 0;

  // (1) DVhub-eigener Regel-Write ist im Not-Halt gesperrt — keine Modbus-Anfrage.
  const regel = await r.ems.applySetpoint(-3000, 'rule:abend');
  assert.notEqual(regel.ok, true, 'eigener Regel-Write muss im Not-Halt scheitern');
  assert.equal(r.t.writes.length, 0, 'kein eigener Write im Not-Halt');

  // (2) releaseControl (Beenden) DARF neutralisieren — die benannte Ausnahme.
  const rel = await r.ems.releaseControl('shutdown');
  assert.equal(rel.ok, true, JSON.stringify(rel));
  assert.equal(r.image.holding.get(MODE), EMS_MODE.SELF, 'Modus 0 (neutralisiert)');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.STOP, 'Befehl 0xCC');
  assert.equal(r.state.ctrl.sungrowEms.owns, false, 'Besitz abgegeben');
  const writesAfterRelease = r.t.writes.length;
  assert.ok(writesAfterRelease > 0, 'die Neutralisierung schreibt');

  // (3) auf EINEN neutralisierenden Write begrenzt: ein zweites releaseControl schreibt nichts mehr.
  r.t.writes.length = 0;
  const again = await r.ems.releaseControl('shutdown');
  assert.equal(again.skipped, true, 'zweites releaseControl ist ein No-op (Besitz bereits abgegeben)');
  assert.equal(r.t.writes.length, 0, 'keine zweite Neutralisierung');
});

test('P5 Schreibklassen-Matrix: der Box-Watchdog (neutralize) darf im Not-Halt ebenfalls einmal neutralisieren', async () => {
  const r = rig({ controlMode: 'forced' });
  await r.ems.applySetpoint(-5000, 'rule:abend');
  r.state.ctrl.discretionaryWritesPaused = true;
  r.t.writes.length = 0;
  const res = await r.ems.neutralize('watchdog');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.image.holding.get(MODE), EMS_MODE.SELF, 'auch der Watchdog-Pfad neutralisiert im Not-Halt');
  assert.ok(r.t.writes.length > 0, 'die Watchdog-Neutralisierung schreibt');
});

test('Absicherung C: releaseControl nimmt im Split BEIDE WR zurück (Slave 0xCC, Master Modus 0)', async () => {
  const r = splitRig();
  await r.ems.applySetpoint(-6000, 'rule:abend'); // Split-Entladen, beide gefahren
  r.masterT.writes.length = 0; r.slaveT.writes.length = 0;
  const res = await r.ems.releaseControl('shutdown');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF, 'Master Modus 0');
  assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.STOP, 'Master Befehl 0xCC');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.STOP, 'Slave Befehl 0xCC');
  assert.ok(!r.slaveT.writes.some((w) => w.address === MODE), 'Slave bekommt KEINEN Modus-Write');
  assert.equal(r.state.ctrl.sungrowEms.owns, false, 'Master-Besitz abgegeben');
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, false, 'Slave-Besitz abgegeben');
});

test('Aufgabe 7 (Frische-Wächter): veralteter Sollwert im Split → BEIDE WR sicher zurück (Modus 0 / 0xCC)', async () => {
  const r = splitRig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
  r.advance(130000); // > targetMaxAgeMs (120 s): Sollwert veraltet → Rückgabe an den WR (Absicherung C)
  await r.ems.tick();
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF, 'Master Modus 0');
  assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.STOP, 'Master 0xCC');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.STOP, 'Slave 0xCC');
});

test('Aufgabe 7 (Frische-Wächter): veraltete Master-Messwerte im Split → BEIDE WR sicher zurück', async () => {
  const r = splitRig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.advance(30000); // > telemetryMaxAgeMs (20 s): Messwerte veraltet → telemetry_missing → Self
  await r.ems.tick();
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF, 'Master Modus 0');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.STOP, 'Slave 0xCC');
});

test('Review-Befund 1: Slave-Telemetrie fällt mitten in der Vorgabe aus → Slave-Befehl wird sicher angehalten (0xCC)', async () => {
  const r = splitRig();
  await r.ems.applySetpoint(-6000, 'rule:abend'); // Split-Entladen, Slave bekam Befehl
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, true, 'Slave wurde gefahren');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE);
  // Slave geht offline → secondInverterTelemetry liefert null → Einzel-WR-Zweig. Der Slave darf seinen
  // Entladebefehl NICHT unbeaufsichtigt weiterfahren (Forced ohne Rückfall).
  r.state.sungrowSecond.online = false;
  r.slaveT.writes.length = 0;
  r.advance(6000);
  await r.ems.tick();
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.STOP, 'Slave-Befehl auf 0xCC angehalten');
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, false, 'Slave-Besitz abgegeben');
});

// M27 (Christin 19.11., ersetzt den Slave-Stopp aus M16): Bei einer Sperre (Negativpreis, Direktvermarkter, Test-Knopf →
// _lastDvFeedIn=false) läuft der Slave NICHT mehr auf 0xCC. Feldbeleg: mit Slave-Stopp kam die Hauslast aus dem Netz,
// als der Master leer war. Beide WR laden/entladen weiter nach soc-balance, DVhub regelt die Summe auf den Sollwert
// (Negativpreis −40 W). Die Einspeisegrenze bleibt nur am Master (13074/13087/13088/31222, DV-Sequenz).
function m27Telemetry(r, { gridW, systemBattW, loadW, pvW = 0 }) {
  r.state.meter = { ok: true, updatedAt: r.now(), grid_total_w: gridW };
  Object.assign(r.state.victron, { batteryPowerW: systemBattW, pvPowerW: pvW, selfConsumptionW: loadW });
  for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) r.state.victron.fieldUpdatedAt[f] = r.now();
  r.state.sungrowSecond.updatedAt = r.now();
}

test('M27 Forced-Split: Sperre aktiv (_lastDvFeedIn=false) → BEIDE WR entladen weiter nach soc-balance (kein Slave-Stopp)', async () => {
  const r = splitRig();
  r.state.ctrl._lastDvFeedIn = false; // Negativpreis-/DV-Sperre aktiv (Einspeisegrenze am Master)
  // Haus 1500 W, PV 0, Netz +1000 W Bezug, Akku-System −500 W. Sollwert −40 (Negativpreis-Puffer):
  // P = −500 + 0,7·(−40 − 1000) = −1228 → Entladen 1230 W, gleicher SoC (50/50) → je ~615 W.
  m27Telemetry(r, { gridW: 1000, systemBattW: -500, loadW: 1500 });
  const res = await r.ems.applySetpoint(-40, 'negative_price_protection');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE, 'Slave entlädt mit (kein 0xCC wegen Sperre)');
  assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.DISCHARGE, 'Master entlädt');
  const mp = r.masterImage.holding.get(POWER); const sp = r.slaveImage.holding.get(POWER);
  assert.ok(Math.abs(mp - 615) <= 20 && Math.abs(sp - 615) <= 20, `soc-balance 50/50: Master ${mp} Slave ${sp}`);
  assert.ok(!r.slaveT.writes.some((w) => w.address === MODE), 'Slave bekommt KEINEN Modus-Write');
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_slave_curtail_hold'), 'kein Slave-Stopp-Log mehr');
  const split = r.state.ctrl.sungrowEms.decision.split;
  assert.equal(split.slaveCurtailHold, undefined, 'Split-Detail kennt keinen Slave-Stopp mehr');
  assert.equal(split.masterW + split.slaveW, 1230, 'Summe = Reglerleistung');
});

test('M27 Forced-Split: Sperre aktiv und Master leer → der Slave deckt die Hauslast (Feldbeleg: sonst Netzbezug)', async () => {
  // Master an seiner Grenze (real 10 % = Gerätemin 10 %, Puffer 0), Slave 50 %. Mit dem alten Slave-Stopp bekam
  // KEINER etwas (Master leer, Slave 0xCC) → Hauslast aus dem Netz. Jetzt übernimmt der Slave.
  const r = splitRig();
  r.cfg.sungrow.socFloorBufferPct = 0;
  r.state.victron.device.minSocPctDevice = 10; r.state.victron.device.maxSocPctDevice = 100;
  r.state.victron.sungrowMasterSocPct = 0; // gemeldet 0 % = real 10 % (Fenster 10…100)
  r.state.ctrl._lastDvFeedIn = false;
  m27Telemetry(r, { gridW: 1000, systemBattW: -500, loadW: 1500 });
  await r.ems.applySetpoint(-40, 'negative_price_protection');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE, 'Slave entlädt');
  assert.equal(r.slaveImage.holding.get(POWER), 1230, 'Slave übernimmt den ganzen Bedarf');
  assert.notEqual(r.masterImage.holding.get(CMD), EMS_CMD.DISCHARGE, 'Master (leer) entlädt nicht');
});

test('M27 Forced-Split: Sperre aktiv → ein zuvor stehender Slave-Befehl wird nach soc-balance nachgeführt, nicht auf 0xCC gesetzt', async () => {
  const r = splitRig();
  r.state.ctrl._lastDvFeedIn = false;
  r.slaveImage.holding.set(CMD, EMS_CMD.CHARGE); // z. B. aus einem früheren Lauf
  m27Telemetry(r, { gridW: 1000, systemBattW: -500, loadW: 1500 });
  await r.ems.applySetpoint(-40, 'negative_price_protection');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE, 'Slave folgt dem Split (Entladen), kein 0xCC');
});

// M25 / Codex 4c624dcd (P1): Während einer Sperre (Einspeisung gesperrt) entlädt DVhub nur fürs Haus — höchstens die
// Netto-Last (Last − PV). Unter der Einspeisegrenze lehnt der Master zu große Entladebefehle mit exception 4 ab, und
// ohne Slave-Stopp (M27) würde ein Export-Sollwert (EOS/Regel) sonst den Slave ins Netz entladen lassen.
test('M25 Regler: dischargeLoadOnly deckelt das Entladen auch bei Einspeise-Sollwert auf die Netto-Last', () => {
  // S = −6000 (Export), Haus 500 W, PV 0: ohne Sperre Entladen 4700 W; mit Sperre höchstens 500 W.
  const args = { ...base, setpointW: -6000, gridImportW: 0, batteryW: -500, pvW: 0, loadW: 500 };
  assert.equal(decideEmsCommand(args).powerW, 4700);
  assert.deepEqual(decideEmsCommand({ ...args, dischargeLoadOnly: true }), { mode: 'forced', command: 'discharge', powerW: 500, reason: 'discharge_load_only' });
  // PV deckt die Last schon → kein Entladen (Netto-Last 0).
  assert.equal(decideEmsCommand({ ...args, pvW: 800, dischargeLoadOnly: true }).command, 'stop');
});

test('Codex 4c624dcd P1: DV-Sperre während einer Export-Vorgabe → beide WR zusammen höchstens die Hauslast (kein Slave-Export)', async () => {
  const r = splitRig(); // Haus 500 W, PV 0
  r.state.ctrl._lastDvFeedIn = false; // DV-Abregelung aktiv (Einspeisegrenze nur am Master)
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const sum = (r.masterImage.holding.get(CMD) === EMS_CMD.DISCHARGE ? r.masterImage.holding.get(POWER) : 0)
    + (r.slaveImage.holding.get(CMD) === EMS_CMD.DISCHARGE ? r.slaveImage.holding.get(POWER) : 0);
  assert.ok(sum <= 500, `Entladen nur fürs Haus: ${sum} W`);
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'discharge_load_only');
});

test('M25: auch ohne geschriebene Sperre (DV-Abschaltung forcedOff / Negativpreis) wird nur fürs Haus entladen', async () => {
  for (const flag of [{ forcedOff: true }, { negativePriceActive: true }, { _dvPartialBlock: true }]) {
    const r = splitRig();
    Object.assign(r.state.ctrl, flag);
    await r.ems.applySetpoint(-6000, 'rule:abend');
    assert.equal(r.state.ctrl.sungrowEms.decision.powerW <= 500, true, `${JSON.stringify(flag)}: ${r.state.ctrl.sungrowEms.decision.powerW}`);
  }
});

test('M25: Einzel-WR unter Sperre — Entladen höchstens die Netto-Last', async () => {
  const r = rig({ controlMode: 'forced' });
  r.state.ctrl._lastDvFeedIn = false;
  r.telemetry({ gridW: 0, batteryW: -500, pvW: 0, loadW: 500 });
  await r.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.DISCHARGE);
  assert.ok(r.image.holding.get(POWER) <= 500, `Einzel-WR: ${r.image.holding.get(POWER)}`);
});

test('M25: ohne Sperre bleibt die Export-Vorgabe wirksam (keine Deckelung)', async () => {
  const r = splitRig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.ok(r.state.ctrl.sungrowEms.decision.powerW > 4000);
});

// M25 (MUSS): „Akku nicht laden" am Test-Knopf sperrt NUR das Laden. Feld: beide WR standen auf 0xCC, die Hauslast kam
// aus dem Netz, obwohl der Sollwert −40 W war und die Akkus 13–15 % hatten. Jetzt: Laden 0, Entladen fürs Haus bleibt
// (höchstens die Netto-Last), beide WR nach soc-balance; wäre Laden nötig → Stopp (Modus 2 bleibt).
function chargeHoldTest(r) {
  // Negativpreis-Test mit „Akku nicht laden": Lease läuft, Sperre geschrieben (wie der echte Pfad).
  r.state.ctrl.curtailmentTest = { active: true, mode: 'negativePrice', blockCharge: true, until: r.now() + 600000 };
  r.state.ctrl.negativePriceActive = true;
  r.state.ctrl._lastDvFeedIn = false;
}
// Wie auf der Feldbox: DVhub fährt schon Dauer-Forced (besitzt Modus 2), dann startet der Test-Knopf.
async function ownedThenHold(r, telemetry) {
  m27Telemetry(r, { gridW: 0, systemBattW: -1000, loadW: 1000 });
  await r.ems.applySetpoint(-40, 'default');
  assert.equal(r.state.ctrl.sungrowEms.owns, true, 'DVhub besitzt Forced');
  chargeHoldTest(r);
  r.advance(6000);
  m27Telemetry(r, telemetry);
  await r.ems.applySetpoint(-40, 'negative_price_protection');
}

test('M25 Test-Knopf „Akku nicht laden": die Hauslast kommt aus beiden Akkus (soc-balance), nicht aus dem Netz', async () => {
  const r = splitRig();
  // Haus 1500 W, PV 0, Netz +1000, Akku −500: P = −500 + 0,7·(−1040) = −1228 → 1230 W ≤ Netto-Last 1500 → je 615 W.
  await ownedThenHold(r, { gridW: 1000, systemBattW: -500, loadW: 1500 });
  assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.DISCHARGE, 'Master entlädt fürs Haus');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE, 'Slave entlädt fürs Haus');
  // Summe der Anteile = Reglerleistung (am Gerät kann je WR bis zur Schreibschwelle 100 W abweichen).
  const sp = r.state.ctrl.sungrowEms.decision.split;
  assert.equal(sp.masterW + sp.slaveW, 1230);
  assert.ok(sp.masterW > 0 && sp.slaveW > 0, 'beide tragen');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED, 'Modus 2 bleibt');
});

test('M25 Test-Knopf: Entladen höchstens die Hauslast (Netto-Last)', async () => {
  const r = splitRig();
  // Haus 600 W, PV 0, Netz +1500 (Lastsprung), Akku 0: P = 0,7·(−1540) = −1078 → gedeckelt auf 600 W.
  await ownedThenHold(r, { gridW: 1500, systemBattW: 0, loadW: 600 });
  assert.equal(r.masterImage.holding.get(POWER) + r.slaveImage.holding.get(POWER), 600);
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'discharge_load_only');
});

test('M25 Test-Knopf: wäre Laden nötig (PV-Überschuss), stehen beide auf Stopp — kein Laden, Modus 2 bleibt', async () => {
  const r = splitRig();
  // PV 3000, Haus 1000, Netz −2000 (Einspeisung) → der Regler wollte laden → gesperrt → Stopp.
  await ownedThenHold(r, { gridW: -2000, systemBattW: 0, loadW: 1000, pvW: 3000 });
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'charge_blocked');
  assert.notEqual(r.masterImage.holding.get(CMD), EMS_CMD.CHARGE, 'Master lädt nicht');
  assert.notEqual(r.slaveImage.holding.get(CMD), EMS_CMD.CHARGE, 'Slave lädt nicht');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED, 'Modus 2 bleibt (kein Moduswechsel)');
});

test('M25 Test-Knopf Einzel-WR: Laden gesperrt, Entladen fürs Haus', async () => {
  const r = rig({ controlMode: 'forced' });
  r.telemetry({ gridW: 0, batteryW: -1000, pvW: 0, loadW: 1000 });
  await r.ems.applySetpoint(-40, 'default'); // DVhub fährt Dauer-Forced
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  r.state.ctrl.curtailmentTest = { active: true, mode: 'dv', blockCharge: true, until: r.now() + 600000 };
  r.state.ctrl.forcedOff = true; r.state.ctrl._lastDvFeedIn = false;
  r.advance(6000);
  r.telemetry({ gridW: 1000, batteryW: -500, pvW: 0, loadW: 1500 });
  await r.ems.applySetpoint(-40, 'dv');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.DISCHARGE);
  assert.equal(r.image.holding.get(POWER), 1230);
  r.advance(6000);
  r.telemetry({ gridW: -2000, batteryW: 0, pvW: 3000, loadW: 1000 });
  await r.ems.tick();
  assert.notEqual(r.image.holding.get(CMD), EMS_CMD.CHARGE, 'kein Laden');
});

test('Codex cd9b71c6 P2: Test-Knopf „Akku nicht laden" + Absicherungsfall (Messwerte veraltet / Sollwert abgelaufen) → Modus 2 + Stopp, kein Modus 0', async () => {
  for (const variant of ['telemetry_stale', 'target_expired']) {
    const r = splitRig();
    await ownedThenHold(r, { gridW: 1000, systemBattW: -500, loadW: 1500 });
    if (variant === 'telemetry_stale') {
      r.advance(30000); // > telemetryMaxAgeMs: Messwerte veraltet, Sollwert noch frisch
      await r.ems.applySetpoint(-40, 'negative_price_protection');
    } else {
      r.advance(130000); // > targetMaxAgeMs: Sollwert abgelaufen
      m27Telemetry(r, { gridW: 1000, systemBattW: -500, loadW: 1500 });
      r.state.ctrl.curtailmentTest.until = r.now() + 600000;
      await r.ems.tick();
    }
    // Mit Modus 0 würde der WR den PV-Überschuss selbst laden, obwohl der Test „Laden gesperrt" meldet.
    assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED, `${variant}: Modus 2 bleibt`);
    assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.STOP, `${variant}: Master Stopp`);
    assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.STOP, `${variant}: Slave Stopp`);
  }
});

test('Codex f0967031 P2: Test-Knopf + Absicherungsfall, Slave nicht erreichbar → Modus 0 (gibt auch den Slave frei), kein Modus 2', async () => {
  const r = splitRig();
  await ownedThenHold(r, { gridW: 1000, systemBattW: -500, loadW: 1500 });
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE, 'Slave entlädt vor dem Ausfall');
  // Slave-Verbindung weg, Messwerte veraltet: ein Stopp am Slave ist nicht bestätigbar.
  const down = async () => { throw Object.assign(new Error('connect ECONNREFUSED 192.168.68.83:502'), { code: 'ECONNREFUSED' }); };
  r.slaveT.mbRequest = down; r.slaveT.mbWriteSingle = down;
  r.advance(30000);
  await r.ems.applySetpoint(-40, 'negative_price_protection');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF, 'Master Modus 0 — der Slave folgt und lässt seinen alten Befehl fallen');
});

test('Codex 85c8309c P2: Test-Knopf + Absicherungsfall, fremdes EMS hat übernommen (Modus 3) → kein Write an den Slave', async () => {
  const r = splitRig();
  await ownedThenHold(r, { gridW: 1000, systemBattW: -500, loadW: 1500 });
  // Ein anderes EMS schaltet beide WR auf Modus 3; Messwerte veralten, der Gerätezustand wird neu gelesen (> 60 s).
  r.masterImage.holding.set(MODE, EMS_MODE.EXTERNAL); r.slaveImage.holding.set(MODE, EMS_MODE.EXTERNAL);
  r.masterT.writes.length = 0; r.slaveT.writes.length = 0;
  r.advance(61000);
  const res = await r.ems.applySetpoint(-40, 'negative_price_protection');
  assert.match(String(res.error || ''), /foreign/, JSON.stringify(res));
  assert.deepEqual(r.slaveT.writes, [], 'kein Write an einen fremd gesteuerten Slave');
  assert.deepEqual(r.masterT.writes, [], 'kein Write an den fremd gesteuerten Master');
});

test('M25 echter Negativpreis, Akkus voll: Laden aus (an der Decke), Entladen fürs Haus an', async () => {
  const r = splitRig();
  r.state.ctrl.negativePriceActive = true; r.state.ctrl._lastDvFeedIn = false; // ohne Test-Knopf
  r.state.victron.sungrowMasterSocPct = 100; r.state.sungrowSecond.socPct = 100;
  m27Telemetry(r, { gridW: -2000, systemBattW: 0, loadW: 1000, pvW: 3000 });
  await r.ems.applySetpoint(-40, 'negative_price_protection');
  assert.notEqual(r.masterImage.holding.get(CMD), EMS_CMD.CHARGE);
  assert.notEqual(r.slaveImage.holding.get(CMD), EMS_CMD.CHARGE);
  // Abends: PV 200, Haus 1500 → Entladen fürs Haus (höchstens 1300 W Netto-Last).
  r.advance(6000);
  m27Telemetry(r, { gridW: 1300, systemBattW: 0, loadW: 1500, pvW: 200 });
  await r.ems.tick();
  const sum = r.masterImage.holding.get(POWER) + r.slaveImage.holding.get(POWER);
  assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.DISCHARGE);
  assert.ok(sum > 0 && sum <= 1300, `Entladen fürs Haus: ${sum}`);
});

// M28 (MUSS): ein WR, der seinen Anteil nicht liefert, gibt ihn ab — der andere übernimmt. Feldbeleg 12:28:
// Entladen 1200 W, Master 416 / Slave 784, Master lieferte 0 W, Slave 790 W, Netz +552 W statt −40 W (15 s stabil).
function m28Telemetry(r, { masterBattW, slaveBattW, gridW, loadW = 1342, pvW = 0 }) {
  const t = r.now();
  r.state.meter = { ok: true, updatedAt: t, grid_total_w: gridW };
  Object.assign(r.state.victron, { sungrowMasterBatteryW: masterBattW, batteryPowerW: masterBattW + slaveBattW, pvPowerW: pvW, selfConsumptionW: loadW });
  for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) r.state.victron.fieldUpdatedAt[f] = t;
  Object.assign(r.state.sungrowSecond, { batteryPowerW: slaveBattW, updatedAt: t });
}

test('M28 liefert nicht: Master liefert ~10 s keine 50 % seines Anteils → Slave übernimmt den vollen Bedarf, Probe nach 60 s', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000; // Takt 1 s wie auf der Feldbox
  r.state.victron.sungrowMasterSocPct = 30; r.state.sungrowSecond.socPct = 40; // kein Fenster → real = gemeldet
  // P = −790 + 0,7·(−40 − 552) = −1204 → Entladen 1200 W; soc-balance 30/40 → Master 300, Slave 900.
  m28Telemetry(r, { masterBattW: 0, slaveBattW: -790, gridW: 552 });
  await r.ems.applySetpoint(-40, 'default');
  assert.equal(r.masterImage.holding.get(POWER), 300, 'Master-Anteil 300 W');
  assert.equal(r.slaveImage.holding.get(POWER), 900, 'Slave-Anteil 900 W');
  // Der Master liefert 0 W (an der Grenze), der Zustand bleibt stehen.
  let stalledAtTick = null;
  for (let i = 1; i <= 12; i += 1) {
    r.advance(1000);
    m28Telemetry(r, { masterBattW: 0, slaveBattW: -790, gridW: 552 });
    await r.ems.tick();
    if (stalledAtTick == null && r.state.ctrl.sungrowEms.decision?.split?.masterOut === 'stalled') stalledAtTick = i;
  }
  // ~10 s Messzeit ab der ersten Messung nach dem Einschwingen (1,5 s nach dem Befehl, Codex 402a3df9) → Takt 12.
  assert.ok(stalledAtTick != null && stalledAtTick >= 10 && stalledAtTick <= 12, `erkannt nach ~10 s (Takt ${stalledAtTick})`);
  const split = r.state.ctrl.sungrowEms.decision.split;
  assert.deepEqual([split.masterW, split.slaveW], [0, 1200], 'Slave übernimmt den vollen Bedarf');
  assert.equal(split.takeover, 'slave');
  assert.equal(r.slaveImage.holding.get(POWER), 1200);
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE);
  assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.STOP, 'Master auf Stopp (Modus 2 bleibt)');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
  const stalledLogs = r.logs.filter((l) => l.event === 'sungrow_ems_share_stalled');
  assert.equal(stalledLogs.length, 1, 'genau ein Log beim Erkennen');
  assert.deepEqual([stalledLogs[0].data.wr, stalledLogs[0].data.direction, stalledLogs[0].data.takeover], ['master', 'discharge', 'slave']);

  // Probe: bis 60 s nach dem Erkennen bleibt der Master draußen, danach bekommt er seinen Anteil wieder.
  for (let i = 0; i < 58; i += 1) {
    r.advance(1000);
    m28Telemetry(r, { masterBattW: 0, slaveBattW: -1200, gridW: -40 });
    await r.ems.tick();
    assert.equal(r.state.ctrl.sungrowEms.decision.split.masterW, 0, `Master bleibt draußen (Sekunde ${i + 1})`);
  }
  let probed = false;
  for (let i = 0; i < 4 && !probed; i += 1) {
    r.advance(1000);
    m28Telemetry(r, { masterBattW: 0, slaveBattW: -1200, gridW: -40 });
    await r.ems.tick();
    probed = r.state.ctrl.sungrowEms.decision.split.masterW > 0;
  }
  assert.ok(probed, 'Probe: nach ~60 s bekommt der Master wieder einen Anteil');
  // Liefert der Master jetzt, ist die Lage aufgehoben (ein Log), kein erneutes Stall-Log. Beurteilt wird erst eine
  // Messung ≥ 1,5 s nach dem neuen Befehl (Einschwingen) → zwei Takte.
  const share = r.state.ctrl.sungrowEms.decision.split.masterW;
  for (let i = 0; i < 2; i += 1) {
    r.advance(1000);
    m28Telemetry(r, { masterBattW: -share, slaveBattW: -(1200 - share), gridW: -40 });
    await r.ems.tick();
  }
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_share_recovered' && l.data.wr === 'master'), 'Erholung geloggt');
  assert.equal(r.logs.filter((l) => l.event === 'sungrow_ems_share_stalled').length, 1, 'kein zweites Stall-Log');
  assert.equal(r.state.ctrl.sungrowEms.decision.split.takeover, null);
});

test('M28 liefert nicht: scheitert die Probe, bleibt der Master erneut 60 s draußen (ohne neues Log)', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  r.state.victron.sungrowMasterSocPct = 30; r.state.sungrowSecond.socPct = 40;
  m28Telemetry(r, { masterBattW: 0, slaveBattW: -790, gridW: 552 });
  await r.ems.applySetpoint(-40, 'default');
  const outTicks = [];
  for (let i = 1; i <= 100; i += 1) {
    r.advance(1000);
    m28Telemetry(r, { masterBattW: 0, slaveBattW: -790, gridW: 552 }); // Master liefert nie
    await r.ems.tick();
    outTicks.push(r.state.ctrl.sungrowEms.decision.split.masterOut === 'stalled');
  }
  // Erkannt nach ~10 s, 60 s draußen, Probe ~10 s, wieder draußen.
  const firstOut = outTicks.indexOf(true);
  const backIn = outTicks.indexOf(false, firstOut);
  const outAgain = outTicks.indexOf(true, backIn);
  // Fristen in Messzeit, erste Messung 1,5 s nach dem (neuen) Befehl (Codex 402a3df9).
  assert.ok(firstOut >= 9 && firstOut <= 12, `erstes Erkennen ${firstOut}`);
  assert.ok(backIn - firstOut >= 59 && backIn - firstOut <= 61, `Probe nach ~60 s (${backIn - firstOut})`);
  assert.ok(outAgain - backIn >= 9 && outAgain - backIn <= 13, `Probe scheitert nach ~10 s (${outAgain - backIn})`);
  assert.equal(r.logs.filter((l) => l.event === 'sungrow_ems_share_stalled').length, 1, 'eine Lage = ein Log');
});

test('M28 Marge im Split (Feldzahlen): Master real 10,6 % bei Grenze 10 % → kein Entlade-Anteil, Slave liefert alles', async () => {
  const r = splitRig();
  r.cfg.sungrow.socFloorBufferPct = 0;
  Object.assign(r.state.victron.device, { minSocPctDevice: 10, maxSocPctDevice: 100 });
  Object.assign(r.state.sungrowSecond, { minSocPctDevice: 10, maxSocPctDevice: 100 });
  r.state.victron.sungrowMasterSocPct = (10.6 - 10) / 0.9; // gemeldet → real 10,6 %
  r.state.sungrowSecond.socPct = (14.9 - 10) / 0.9;        // gemeldet → real 14,9 %
  m28Telemetry(r, { masterBattW: 0, slaveBattW: -790, gridW: 552 });
  await r.ems.applySetpoint(-40, 'default');
  const split = r.state.ctrl.sungrowEms.decision.split;
  assert.deepEqual([split.masterW, split.slaveW], [0, 1200], `Master 0, Slave voll (war 416/784): ${split.masterW}/${split.slaveW}`);
  assert.equal(split.masterOut, 'soc');
  assert.equal(split.takeover, 'slave');
  assert.equal(r.slaveImage.holding.get(POWER), 1200);
});

// M28 Grundsatz 0 (Christin 19.11., Nachtrag 12:45): „Der andere Akku muss auf jeden Fall mehr entladen … man merkt,
// der eine liefert nichts mehr, und der andere zieht nach." Die Aufteilung rechnet mit der GEMESSENEN Leistung je WR:
// das Fehlende eines WR (Anteil − Ist) geht an den anderen, bis dieser an seiner Grenze ist (SoC, Leistung, liefert
// nicht). Ein WR, der teilweise liefert, trägt weiter seinen Ist-Anteil. Kein Ping-Pong, Netzbezug erst, wenn beide
// nicht mehr können.
async function g0Ticks(r, n, telemetryFn, onTick = () => {}) {
  for (let i = 1; i <= n; i += 1) {
    r.advance(1000);
    m28Telemetry(r, telemetryFn(i));
    await r.ems.tick();
    onTick(i, r.state.ctrl.sungrowEms.decision.split);
  }
}

// Codex 402a3df9 (P2): Laden zwischendurch darf die laufende Entlade-Messung nicht „mitzählen" — und eine stehende
// (alte) Messung darf nicht Takt für Takt als neuer Beleg gelten.
function followTelemetry(r, { loadW, pvW = 0, masterDischargeCap = Infinity }) {
  // Jeder WR liefert seinen Befehl; der Master beim Entladen höchstens masterDischargeCap.
  const act = (img, dischargeCapW) => {
    const cmd = img.holding.get(CMD); const p = img.holding.get(POWER);
    return cmd === EMS_CMD.CHARGE ? p : (cmd === EMS_CMD.DISCHARGE ? -Math.min(p, dischargeCapW) : 0);
  };
  const m = act(r.masterImage, masterDischargeCap); const s = act(r.slaveImage, Infinity);
  m28Telemetry(r, { masterBattW: m, slaveBattW: s, gridW: loadW - pvW + m + s, loadW, pvW });
}

test('Codex 402a3df9 P2: Richtungswechsel setzt die Liefert-nicht-Messung zurück (Entladen → Laden → Entladen)', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  r.state.victron.sungrowMasterSocPct = 30; r.state.sungrowSecond.socPct = 40;
  followTelemetry(r, { loadW: 1342, masterDischargeCap: 0 });
  await r.ems.applySetpoint(-40, 'default');
  const tick = async (opts) => { r.advance(1000); followTelemetry(r, opts); await r.ems.tick(); return r.state.ctrl.sungrowEms.decision.split; };
  for (let i = 0; i < 5; i += 1) await tick({ loadW: 1342, masterDischargeCap: 0 }); // 5 s: Master liefert beim Entladen nichts
  for (let i = 0; i < 15; i += 1) {                                                 // 15 s: PV-Überschuss, beide laden wie befohlen
    const sp = await tick({ loadW: 1000, pvW: 3000, masterDischargeCap: 0 });
    if (i >= 2) assert.equal(sp.charge, true, 'Laden-Phase');
  }
  // Wieder Entladen (Haus 3000 W → Master-Anteil sofort > 200 W), der Master liefert wieder nichts: neu messen, nicht
  // nach 1 s herausnehmen.
  let outAt = null;
  for (let i = 1; i <= 14 && outAt == null; i += 1) {
    const sp = await tick({ loadW: 3000, masterDischargeCap: 0 });
    if (sp.charge === false && sp.masterOut === 'stalled') outAt = i;
  }
  assert.ok(outAt == null || outAt >= 10, `frühestens nach ~10 s neuer Messung (Takt ${outAt})`);
});

test('Codex 402a3df9 P2: eine stehende Master-Messung (kein neuer Poll) zählt nicht als Liefert-nicht-Beleg', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  r.state.victron.sungrowMasterSocPct = 30; r.state.sungrowSecond.socPct = 40;
  m28Telemetry(r, { masterBattW: 0, slaveBattW: -790, gridW: 552 });
  const frozenAt = r.now();
  await r.ems.applySetpoint(-40, 'default');
  for (let i = 1; i <= 15; i += 1) {
    r.advance(1000);
    m28Telemetry(r, { masterBattW: 0, slaveBattW: -790, gridW: 552 });
    r.state.victron.fieldUpdatedAt.batteryPowerW = frozenAt; // Master-Akku-Wert kommt nicht neu (noch < 20 s alt)
    await r.ems.tick();
    const sp = r.state.ctrl.sungrowEms.decision.split;
    assert.notEqual(sp?.masterOut, 'stalled', `Takt ${i}: ohne neue Messung kein „liefert nicht"`);
    assert.equal(sp?.masterLimitW ?? null, null, `Takt ${i}: ohne neue Messung keine Begrenzung`);
  }
});

// Codex e5b5fffe (P2): zwei weitere Zeitfehler der Liefert-nicht-Messung.
async function stallTimeline(r, steps) {
  const outTicks = [];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    r.advance(1000);
    m28Telemetry(r, s);
    if (s.masterStampAt != null) r.state.victron.fieldUpdatedAt.batteryPowerW = s.masterStampAt; // Master-Poll steht
    await r.ems.tick();
    if (r.state.ctrl.sungrowEms.decision?.split?.masterOut === 'stalled') outTicks.push(i + 1);
  }
  return outTicks;
}

test('Codex e5b5fffe P2: Befehlserhöhung + volle Lieferung beendet eine laufende Messung (kein Zusammenrechnen zweier Lücken)', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  // Gleicher SoC → je Hälfte. Takt 1–7: Bedarf 1000 W, Master liefert 0 von 500. Takt 8: Bedarf 2000 W (Master 1000).
  // Takt 9: Master liefert voll. Ab Takt 10 wieder 0 → frühestens ~10 s danach „liefert nicht", nicht in Takt 12.
  m28Telemetry(r, { masterBattW: 0, slaveBattW: -500, gridW: 674 });
  await r.ems.applySetpoint(-40, 'default');
  const steps = [];
  for (let i = 1; i <= 7; i += 1) steps.push({ masterBattW: 0, slaveBattW: -500, gridW: 674 });
  steps.push({ masterBattW: 0, slaveBattW: -500, gridW: 2103 });
  steps.push({ masterBattW: -1000, slaveBattW: -1000, gridW: -40 });
  for (let i = 10; i <= 19; i += 1) steps.push({ masterBattW: 0, slaveBattW: -1000, gridW: 960 });
  const out = await stallTimeline(r, steps);
  assert.ok(!out.some((i) => i <= 19), `nicht vor ~10 s neuer Lücke herausgenommen: ${out.join(',')}`);
});

test('Codex e5b5fffe P2: Rückkehr in eine Richtung beginnt neu — ein alter Lade-Messwert zählt nicht als Entlade-Lücke', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  r.state.victron.sungrowMasterSocPct = 30; r.state.sungrowSecond.socPct = 40; // → 300/900 bei 1200 W
  // Akku-System −1200, Netz −40 → P = −1200 (Gleichstand).
  m28Telemetry(r, { masterBattW: -300, slaveBattW: -900, gridW: -40 });
  await r.ems.applySetpoint(-40, 'default');
  const steps = [];
  for (let i = 1; i <= 2; i += 1) steps.push({ masterBattW: -300, slaveBattW: -900, gridW: -40 });          // Entladen, alles gut
  const lastDischargePoll = r.now() + 2000;                                                                 // Master-Poll Takt 2
  const chargeAt = r.now() + 4000;                                                                          // nächster Master-Poll: Takt 4 (Laden)
  // Takt 3–5: Laden. Der Master-Poll von Takt 3 fällt aus, der von Takt 4 zeigt das Laden und bleibt dann stehen.
  steps.push({ masterBattW: 500, slaveBattW: 500, gridW: -1000, pvW: 3000, loadW: 1000, masterStampAt: lastDischargePoll });
  steps.push({ masterBattW: 500, slaveBattW: 500, gridW: -1000, pvW: 3000, loadW: 1000 });
  steps.push({ masterBattW: 500, slaveBattW: 500, gridW: -1000, pvW: 3000, loadW: 1000, masterStampAt: chargeAt });
  // Takt 6–7: wieder Entladen mit demselben Master-Anteil (300 W), der Master-Poll steht noch auf dem Lade-Wert.
  // Akku-System (+500 − 900), Netz +1103 → P = −400 + 0,7·(−1143) = −1200.
  steps.push({ masterBattW: 500, slaveBattW: -900, gridW: 1103, masterStampAt: chargeAt });
  steps.push({ masterBattW: 500, slaveBattW: -900, gridW: 1103, masterStampAt: chargeAt });
  // Ab Takt 8 neue Master-Messungen: 0 W (Akku-System −900, Netz +389 → P = −1200).
  for (let i = 8; i <= 17; i += 1) steps.push({ masterBattW: 0, slaveBattW: -900, gridW: 389 });
  const out = await stallTimeline(r, steps);
  assert.ok(!out.some((i) => i <= 17), `frühestens ~10 s nach dem Wiederbeginn: ${out.join(',')}`);
});

test('M28 Grundsatz 0 (Feldbeleg 12:28): Master liefert 0 von 417 W → sein Anteil geht nach wenigen Sekunden an den Slave', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  r.state.victron.sungrowMasterSocPct = 30; r.state.sungrowSecond.socPct = 34.4; // soc-balance → 417/783 wie im Feld
  // Feld: Bedarf 1200 W, Master 0 W, Slave 790 W, Netz +552 W.
  const field = () => ({ masterBattW: 0, slaveBattW: -790, gridW: 552 });
  m28Telemetry(r, field());
  await r.ems.applySetpoint(-40, 'default');
  assert.deepEqual([r.masterImage.holding.get(POWER), r.slaveImage.holding.get(POWER)], [417, 783]);
  let movedAt = null;
  await g0Ticks(r, 5, field, (i, sp) => { if (movedAt == null && sp.slaveW === 1200) movedAt = i; });
  assert.ok(movedAt != null && movedAt <= 5, `Slave zieht nach (Takt ${movedAt})`);
  let sp = r.state.ctrl.sungrowEms.decision.split;
  assert.equal(sp.transferW, 417, 'das Fehlende des Masters geht an den Slave');
  assert.equal(sp.masterW, 417, 'der Master behält seinen Anteil (Befehl), liefert aber nichts');
  assert.deepEqual([sp.takeover, sp.takeoverReason], ['slave', 'partial']);
  assert.equal(r.slaveImage.holding.get(POWER), 1200);
  // Der Slave liefert jetzt 1200 W, das Netz steht auf −40 W: der Zustand bleibt ruhig (kein Ping-Pong).
  const slaveCmds = [];
  await g0Ticks(r, 4, () => ({ masterBattW: 0, slaveBattW: -1200, gridW: -40 }), (i, s) => slaveCmds.push(s.slaveW));
  assert.deepEqual(slaveCmds, [1200, 1200, 1200, 1200], 'Slave-Befehl bleibt stehen');
  sp = r.state.ctrl.sungrowEms.decision.split;
  assert.equal(sp.masterW + sp.slaveW - sp.transferW, 1200, 'Summe der Anteile = Reglerleistung');
});

test('M28 Grundsatz 0 (Feldbeleg 12:31): Master 0 von 389 W, Slave 602 von 731 W → nichts zu verschieben, kein Ping-Pong; nach der Erkennung bekommt der Slave alles', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  r.state.victron.sungrowMasterSocPct = 30; r.state.sungrowSecond.socPct = 34.4; // → 389/731 bei 1120 W
  // Feld: Bedarf 1120 W, Master 0 W, Slave 602 W (BMS-Strombegrenzung), Netz +700 W.
  const field = () => ({ masterBattW: 0, slaveBattW: -602, gridW: 700 });
  m28Telemetry(r, field());
  await r.ems.applySetpoint(-40, 'default');
  assert.deepEqual([r.masterImage.holding.get(POWER), r.slaveImage.holding.get(POWER)], [389, 731]);
  const trace = [];
  await g0Ticks(r, 60, field, (i, sp) => trace.push({ i, m: sp.masterW, s: sp.slaveW, tr: sp.transferW, out: sp.masterOut }));
  // Beide liefern weniger als befohlen → keiner kann das Fehlende des anderen tragen (kein Hin- und Herschieben).
  for (const x of trace.filter((x) => x.out !== 'stalled')) assert.equal(x.tr, 0, `Takt ${x.i}: keine Verschiebung zwischen zwei begrenzten WR`);
  // Liefert-nicht-Erkennung (~10 s): Master raus, der Slave bekommt den ganzen Bedarf (er zieht nach, so weit er kann).
  const firstOut = trace.find((x) => x.out === 'stalled');
  assert.ok(firstOut && firstOut.i <= 12, `Master raus nach ~10 s Messzeit (Takt ${firstOut && firstOut.i})`);
  const after = trace.filter((x) => x.i > firstOut.i && x.i <= 60);
  assert.ok(after.every((x) => x.m === 0 && x.s === 1120), `danach ruhig: Master 0, Slave 1120 (${JSON.stringify(after.slice(0, 3))})`);
  const sp = r.state.ctrl.sungrowEms.decision.split;
  assert.equal(sp.slaveLimitW, 600, 'gemessene Lieferfähigkeit des Slave (602 W, auf 10 W)');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE);
  assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.STOP);
});

test('M28 Grundsatz 0: Teil-Lieferung — Master 300 von 600 W, der Slave trägt das Fehlende; stabil, und zurück, wenn der Master wieder liefert', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  // Gleicher SoC → 600/600 bei 1200 W. Master liefert nur 300 W (BMS), Slave liefert, was er soll.
  m28Telemetry(r, { masterBattW: -300, slaveBattW: -600, gridW: 389 });
  await r.ems.applySetpoint(-40, 'default');
  assert.deepEqual([r.masterImage.holding.get(POWER), r.slaveImage.holding.get(POWER)], [600, 600]);
  await g0Ticks(r, 5, () => ({ masterBattW: -300, slaveBattW: -600, gridW: 389 }));
  let sp = r.state.ctrl.sungrowEms.decision.split;
  assert.deepEqual([sp.masterW, sp.slaveW, sp.transferW], [600, 900, 300], 'Slave trägt die fehlenden 300 W');
  assert.equal(sp.masterLimitW, 300);
  // 30 s Gleichlauf: Slave liefert 900, Netz −40 → kein Aufschaukeln, Befehle stehen.
  const cmds = [];
  await g0Ticks(r, 30, () => ({ masterBattW: -300, slaveBattW: -900, gridW: -40 }), (i, s) => cmds.push(`${s.masterW}/${s.slaveW}`));
  assert.deepEqual([...new Set(cmds)], ['600/900'], `stabil: ${[...new Set(cmds)].join(', ')}`);
  // Master liefert wieder voll → die Verschiebung fällt weg.
  await g0Ticks(r, 3, () => ({ masterBattW: -600, slaveBattW: -600, gridW: -40 }));
  sp = r.state.ctrl.sungrowEms.decision.split;
  assert.equal(sp.transferW, 0, 'Master liefert wieder → nichts mehr zu verschieben');
  assert.equal(sp.masterLimitW, null);
});

test('M28 Grundsatz 0: liefert ein WR unter 50 % und kann der andere den Rest nicht tragen, bleibt er drin (sein Ist-Anteil zählt)', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  // Gleicher SoC. Master kann nur 240 W (BMS), Slave nur 900 W. Haus 1240 W, PV 0 → geschlossener Regelkreis.
  const cap = { m: 240, s: 900 };
  const loadW = 1240;
  let act = { m: 0, s: 0 };
  m28Telemetry(r, { masterBattW: 0, slaveBattW: 0, gridW: loadW, loadW });
  await r.ems.applySetpoint(-40, 'default');
  const totals = [];
  for (let i = 1; i <= 90; i += 1) {
    r.advance(1000);
    m28Telemetry(r, { masterBattW: -act.m, slaveBattW: -act.s, gridW: loadW - act.m - act.s, loadW });
    await r.ems.tick();
    // Gerät folgt dem Befehl im nächsten Takt bis zu seiner Grenze.
    const mCmd = r.masterImage.holding.get(CMD) === EMS_CMD.DISCHARGE ? r.masterImage.holding.get(POWER) : 0;
    const sCmd = r.slaveImage.holding.get(CMD) === EMS_CMD.DISCHARGE ? r.slaveImage.holding.get(POWER) : 0;
    act = { m: Math.min(mCmd, cap.m), s: Math.min(sCmd, cap.s) };
    totals.push(act.m + act.s);
  }
  // Am Ende liefern beide, was sie können (240 + 900): der Master wird nicht dauerhaft herausgenommen.
  const tail = totals.slice(-20);
  assert.ok(tail.every((x) => x === 1140), `beide liefern ihr Mögliches: ${tail.join(',')}`);
});

test('Codex 07041019 P2: die Probe über der gemessenen Grenze geht wirklich ans Gerät (größer als die Schreibschwelle)', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  // Gleicher SoC → 600/600 bei 1200 W. Lage: der Slave war bei 600 W begrenzt und steht am Gerät auf 600 W, der Master
  // liefert nur 200 W. Das Fehlende des Masters darf der Slave bis zu seiner Grenze + Probe bekommen.
  // Akku −800 W, Netz +531 W → P = −800 + 0,7·(−40 − 531) = −1200 → 600/600.
  m28Telemetry(r, { masterBattW: -200, slaveBattW: -600, gridW: 531 });
  await r.ems.applySetpoint(-40, 'default');
  const t = r.now();
  r.ems._st.limit['master:discharge'] = { limited: true, limitW: 200, underSince: 0, cmdW: 600, cmdRaisedAt: 0, lastSampleAt: t, judgedAt: t };
  r.ems._st.limit['slave:discharge'] = { limited: true, limitW: 600, underSince: 0, cmdW: 600, cmdRaisedAt: 0, lastSampleAt: t, judgedAt: t };
  r.slaveImage.holding.set(POWER, 600); r.slaveImage.holding.set(CMD, EMS_CMD.DISCHARGE);
  r.advance(1000);
  m28Telemetry(r, { masterBattW: -200, slaveBattW: -600, gridW: 531 });
  await r.ems.tick();
  const sp = r.state.ctrl.sungrowEms.decision.split;
  assert.deepEqual([sp.masterBaseW, sp.slaveBaseW], [600, 600]);
  assert.ok(sp.transferW > 100, `Probe größer als die Schreibschwelle 100 W: ${sp.transferW}`);
  assert.ok(r.slaveImage.holding.get(POWER) > 700, `Probe am Gerät angekommen: ${r.slaveImage.holding.get(POWER)}`);
});

test('Codex 07041019 P2: eine Lücke kurz vor einer Befehlserhöhung bestätigt beim Hochfahren keine falsche Grenze', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  m28Telemetry(r, { masterBattW: -600, slaveBattW: -600, gridW: -40, loadW: 1160 });
  await r.ems.applySetpoint(-40, 'default');
  // Master-Messung je Takt; der Slave liefert, was am Gerät steht. In Takt 2 zeigt der Master kurz eine Lücke
  // (400 von 600 W), zugleich springt die Hauslast auf 2000 W (Befehl ~1000 W). Danach fährt er normal hoch.
  const masterSeen = [600, 400, 600, 800, 1000, 1000, 1000, 1000];
  for (let i = 1; i <= masterSeen.length; i += 1) {
    r.advance(1000);
    const loadW = i >= 2 ? 2000 : 1160;
    const s = r.slaveImage.holding.get(CMD) === EMS_CMD.DISCHARGE ? r.slaveImage.holding.get(POWER) : 0;
    const m = masterSeen[i - 1];
    m28Telemetry(r, { masterBattW: -m, slaveBattW: -s, gridW: loadW - m - s, loadW });
    await r.ems.tick();
    const sp = r.state.ctrl.sungrowEms.decision.split;
    assert.equal(sp.transferW, 0, `Takt ${i}: keine Übernahme beim normalen Hochfahren`);
    assert.equal(sp.masterLimitW, null, `Takt ${i}: keine falsche Grenze`);
  }
});

test('M28 Grundsatz 0: Sprung im Bedarf, beide WR fahren gleichzeitig hoch → keine Verschiebung, kein Überschwingen', async () => {
  const r = splitRig();
  r.cfg.sungrow.regulateEveryMs = 1000;
  m28Telemetry(r, { masterBattW: 0, slaveBattW: 0, gridW: 0, loadW: 0 });
  await r.ems.applySetpoint(-40, 'default');
  // Last springt auf 2000 W; beide WR folgen ihrem Befehl erst nach 2 s (Rampe), dann voll.
  const shares = [];
  const cmdAt = [];
  for (let i = 1; i <= 15; i += 1) {
    r.advance(1000);
    const m = cmdAt[i - 3]?.m ?? 0; const s = cmdAt[i - 3]?.s ?? 0; // 2 Takte Verzug
    m28Telemetry(r, { masterBattW: -m, slaveBattW: -s, gridW: 2000 - m - s, loadW: 2000 });
    await r.ems.tick();
    const sp = r.state.ctrl.sungrowEms.decision.split;
    if (sp) { shares.push(sp.transferW); cmdAt[i - 1] = { m: sp.masterW, s: sp.slaveW }; } else cmdAt[i - 1] = { m: 0, s: 0 };
  }
  assert.ok(shares.every((x) => x === 0), `keine Verschiebung beim gemeinsamen Hochfahren: ${shares.join(',')}`);
});

test('M24: Status nennt den wirksamen Puffer über der Geräte-Untergrenze (Standard 0)', async () => {
  const r = rig({ controlMode: 'forced' });
  assert.equal(r.ems.status().socFloorBufferPct, 0);
  r.cfg.sungrow.socFloorBufferPct = 2;
  assert.equal(r.ems.status().socFloorBufferPct, 2);
});

// M22 (Christin 19.11.): Modbus-Fehler je WR ins Log; split_aborted / Slave-Fallback mit Register (Doku) und Wert.
function rejectWrite(t, wireAddr, msg = 'modbus exception 4') {
  const orig = t.mbWriteSingle.bind(t);
  t.mbWriteSingle = async (a) => { if (a.address === wireAddr) { t.writes.push({ fc: 6, address: a.address, value: a.value, rejected: true }); throw new Error(msg); } return orig(a); };
}

test('M22: Master lehnt die Leistung ab (exception 4) → sungrow_ems_split_aborted nennt Register 13052 (Doku), Draht 13051 und Wert', async () => {
  const r = splitRig();
  rejectWrite(r.masterT, POWER);
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const ab = r.logs.find((l) => l.event === 'sungrow_ems_split_aborted');
  assert.ok(ab, 'split_aborted geloggt');
  assert.equal(ab.data.register, 13052, 'Doku-Register (Leistung)');
  assert.equal(ab.data.wireAddress, 13051, 'Draht-Adresse');
  assert.ok(Number(ab.data.value) > 0, `Wert: ${ab.data.value}`);
  assert.equal(ab.data.kind, 'exception');
  assert.equal(ab.data.code, 4);
  // Und der Modbus-Fehler selbst steht je WR im Log.
  const me = r.logs.find((l) => l.event === 'sungrow_modbus_error' && l.data.wr === 'master');
  assert.ok(me, 'sungrow_modbus_error (Master) geloggt');
  assert.deepEqual([me.data.kind, me.data.code, me.data.fc, me.data.register], ['exception', 4, 6, 13052]);
});

test('M22: Slave lehnt die Leistung ab → Fallback-Log mit Register und Wert, Modbus-Fehler mit wr=slave', async () => {
  const r = splitRig();
  rejectWrite(r.slaveT, POWER);
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const fb = r.logs.find((l) => l.event === 'sungrow_ems_split_slave_fallback');
  assert.ok(fb, 'Slave-Fallback geloggt');
  assert.equal(fb.data.register, 13052);
  assert.equal(fb.data.wireAddress, 13051);
  assert.ok(Number(fb.data.value) > 0);
  const me = r.logs.find((l) => l.event === 'sungrow_modbus_error' && l.data.wr === 'slave');
  assert.ok(me, 'sungrow_modbus_error (Slave) geloggt');
  assert.equal(me.data.source, 'ems');
});

test('Absicherung C4: Master frischt das Lebenszeichen für den Box-Watchdog auf, solange er Forced fährt', async () => {
  const hbPath = path.join(os.tmpdir(), `dvhub-forced-hb-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const r = rig({ controlMode: 'forced', forcedHeartbeatPath: hbPath });
    await r.ems.applySetpoint(-5000, 'rule:abend'); // Forced-Entladen
    const at1 = JSON.parse(fs.readFileSync(hbPath, 'utf8')).at;
    assert.ok(Number.isFinite(at1), 'Lebenszeichen nach dem ersten Forced-Takt geschrieben');
    // Auch ein ausgeregelter Takt (kein Write ans Gerät) frischt das Lebenszeichen auf (DVhub lebt).
    r.advance(10_000);
    r.telemetry({ gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 });
    await r.ems.tick();
    const at2 = JSON.parse(fs.readFileSync(hbPath, 'utf8')).at;
    assert.ok(at2 >= at1, 'Lebenszeichen im Takt aufgefrischt');
  } finally { try { fs.rmSync(hbPath, { force: true }); } catch { /* ignore */ } }
});

test('Aktuator: Netzladen → Leistung, Befehl, Modus (in dieser Reihenfolge), dann Rücklesen', async () => {
  const r = rig({ allowGridCharge: true });
  const res = await r.ems.applySetpoint(4000, 'rule:netzladen');
  assert.equal(res.ok, true);
  assert.deepEqual(r.t.writes, [
    { fc: 6, address: POWER, value: 2300 },
    { fc: 6, address: CMD, value: EMS_CMD.CHARGE },
    { fc: 6, address: MODE, value: EMS_MODE.FORCED }
  ]);
  // Gerät erst gelesen (Ausgangslage), nach den Writes zurückgelesen — beides Block 13050–13052.
  assert.deepEqual(r.t.reads.map((x) => [x.fc, x.address, x.quantity]), [[3, MODE, 3], [3, MODE, 3]]);
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_write' && l.data.powerW === 2300));
});

// --- Dauer-Forced-Split (Christin 14.11.): Modus dauerhaft 2, ohne Vorgabe regelt DVhub den Eigenverbrauch ---

test('Netzlade-Verbot D: ohne Freigabe lädt KEIN Ziel aus dem Netz (auch manual_override), mit Freigabe schon', async () => {
  // Ohne optimizer.allowGridCharge: ein positiver Sollwert (Netzladen) ohne PV darf NICHT aus dem Netz laden —
  // das Verbot hängt am Aktuator, nicht am durchgereichten Flag (Ref d54a3fab). PV 0, Last 500 → Überschuss 0 → Stopp.
  const blocked = rig({ controlMode: 'forced' }); // allowGridCharge default false
  await blocked.ems.applySetpoint(4000, 'manual_override');
  assert.equal(blocked.image.holding.get(CMD), EMS_CMD.STOP, 'kein Netzladen ohne Freigabe (auch manual_override)');
  assert.equal(blocked.state.ctrl.sungrowEms.decision.reason, 'charge_pv_only');
  // Mit ausdrücklicher Freigabe lädt es wie gehabt.
  const ok = rig({ controlMode: 'forced', allowGridCharge: true });
  await ok.ems.applySetpoint(4000, 'manual_override');
  assert.equal(ok.image.holding.get(CMD), EMS_CMD.CHARGE, 'mit Freigabe lädt es aus dem Netz');
});

test('Aufgabe 8 (D): Netzlade-Riegel greift für JEDES Ziel und JEDEN Takt (allowGridCharge=false)', async () => {
  // Der Riegel hängt am Aktuator (noGridChargeForce), nicht an einem durchgereichten Flag — er gilt für jede Quelle
  // (EOS, Regel, Hand) und in jedem Takt, solange der Nutzer das Netzladen nicht freigegeben hat.
  const r = rig({ controlMode: 'forced' }); // allowGridCharge default false
  r.telemetry({ gridW: 0, batteryW: 0, pvW: 0, loadW: 500 }); // kein PV-Überschuss
  await r.ems.applySetpoint(6000, 'eos'); // EOS-Ziel: wollte 6 kW Netzbezug zum Laden
  assert.equal(r.image.holding.get(CMD), EMS_CMD.STOP, 'kein Netzladen (eos)');
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'charge_pv_only');
  // Nächster Takt, gleiches Ziel, frische Messwerte → weiter kein Netzladen.
  r.advance(6000);
  r.telemetry({ gridW: 0, batteryW: 0, pvW: 0, loadW: 500 });
  await r.ems.tick();
  assert.notEqual(r.image.holding.get(CMD), EMS_CMD.CHARGE, 'auch im nächsten Takt kein Netzladen');
  // Mit PV-Überschuss lädt es (nur aus PV, nicht aus dem Netz) — der Riegel sperrt NICHT das PV-Laden.
  r.advance(6000);
  r.telemetry({ gridW: -3000, batteryW: 0, pvW: 4000, loadW: 500 });
  await r.ems.applySetpoint(6000, 'eos');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.CHARGE, 'PV-Überschuss wird geladen (charge_pv_only)');
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'charge_pv_only');
});

test('Dauer-Forced B1: Leerlauf (Default-Puffer −40) mit PV-Überschuss regelt (Laden), fällt NICHT in Modus 0', async () => {
  const r = rig({ controlMode: 'forced' });
  // Leerlauf mittags: PV 6 kW, Haus 800 W, Netz −5200 (Einspeisung), Akku 0. Ziel Netz ≈ −40 → DVhub lädt den
  // Überschuss in den Akku (statt ihn einzuspeisen). decideEmsCommand(band 0): p = 0 + 0,7·(−40+5200) = 3612.
  r.telemetry({ gridW: -5200, batteryW: 0, pvW: 6000, loadW: 800 });
  const res = await r.ems.applySetpoint(-40, 'default');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.image.holding.get(MODE), EMS_MODE.FORCED, 'Forced mode 2 (nicht Modus 0)');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.CHARGE, 'lädt den PV-Überschuss');
  assert.ok(r.image.holding.get(POWER) >= 3500 && r.image.holding.get(POWER) <= 3700, `Leistung ${r.image.holding.get(POWER)}`);
  // 13050 genau einmal geschrieben (Eintritt); danach bleibt der Modus stehen.
  assert.equal(r.t.writes.filter((w) => w.address === MODE).length, 1);
});

test('Dauer-Forced B1: nach dem Eintritt bleibt der Modus 2 — ein Takt im Band schreibt NIE Modus 0', async () => {
  const r = rig({ controlMode: 'forced' });
  r.telemetry({ gridW: -5200, batteryW: 0, pvW: 6000, loadW: 800 });
  await r.ems.applySetpoint(-40, 'default');
  r.t.writes.length = 0;
  // Perfekt ausgeglichen: PV = Last, kein Netz, Akku 0 → Regler < minPowerW → Stopp (0xCC), aber Modus BLEIBT 2.
  r.advance(10_000);
  r.telemetry({ gridW: 0, batteryW: 0, pvW: 800, loadW: 800 });
  await r.ems.tick();
  assert.equal(r.image.holding.get(MODE), EMS_MODE.FORCED, 'Modus bleibt 2');
  assert.ok(!r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.SELF), 'nie Modus 0 geschrieben');
  assert.equal(r.state.ctrl.sungrowEms.owns, true, 'DVhub behält die Steuerung');
});

test('Absicherung C3: Start mit Forced-Merker → erster Takt setzt den Akku-Befehl auf 0xCC (Modus 2 bleibt), dann regelt es', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-c3-'));
  const statePath = path.join(dir, 'sungrow_ems_state.json');
  fs.writeFileSync(statePath, JSON.stringify({ ownMode: EMS_MODE.FORCED, endpointKey: '192.0.2.50:502:1', at: Date.now() }));
  // Gerät hält noch einen alten Entladebefehl (Modus 2) aus der Zeit vor dem Neustart.
  const r = rig({ controlMode: 'forced', statePath, over: { holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 4000 } } });
  assert.equal(r.state.ctrl ? r.ems._st.startupResetPending : null, true, 'Merker geladen → Start-Reset steht aus');
  await r.ems.applySetpoint(-5000, 'rule:abend'); // würde sonst sofort entladen
  assert.equal(r.image.holding.get(MODE), EMS_MODE.FORCED, 'Modus 2 bleibt (kein Flap)');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.STOP, 'alter Befehl zuerst auf 0xCC zurückgesetzt');
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_startup_reset'));
  // Nächster Takt regelt frisch → Entladen.
  r.advance(6000);
  r.telemetry({ gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 });
  await r.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.DISCHARGE, 'danach regelt es normal (Entladen)');
  fs.rmSync(dir, { recursive: true, force: true });
});

// A2 (Christin 16.11.2026): das 13050-Tagesbudget (Moduswechsel) überlebt jetzt einen Neustart — in einer EIGENEN
// Datei neben dem Besitz-Merker, der Watchdog-Schlüssel bleibt unberührt.
test('A2: 13050-Schreibzähler wird persistiert und überlebt den Neustart (eigene Datei, Merker unberührt)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-writeday-'));
  const statePath = path.join(dir, 'sungrow_ems_state.json');
  const writeDayPath = path.join(dir, 'sungrow_ems_writeday.json');

  // Lauf 1: Eintritt in Forced → genau EIN Moduswechsel (13050), Budget 20 → 19, persistiert.
  const r1 = rig({ controlMode: 'forced', statePath });
  await r1.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(r1.t.writes.filter((w) => w.address === MODE).length, 1, 'ein Moduswechsel');
  assert.equal(r1.ems.status().modeBudgetLeft, 19);
  assert.ok(fs.existsSync(writeDayPath), 'eigene Zähler-Datei geschrieben');
  const persisted = JSON.parse(fs.readFileSync(writeDayPath, 'utf8'));
  assert.equal(persisted.regs[String(MODE)], 1, '13050-Zähler auf der Platte');
  // Watchdog-Merker (Besitz) ist eine ANDERE Datei mit exakt seinen Schlüsseln.
  const marker = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(marker.ownMode, EMS_MODE.FORCED);
  assert.equal(typeof marker.endpointKey, 'string');
  assert.equal(marker.regs, undefined, 'der Zähler verschmutzt den Watchdog-Merker nicht');

  // Lauf 2 (Neustart, selbe Dateien, selber Tag): der Zähler ist wiederhergestellt — das Budget bleibt bei 19.
  const r2 = rig({ controlMode: 'forced', statePath });
  assert.equal(r2.ems.status().modeBudgetLeft, 19, 'Budget überlebt den Neustart (nicht wieder 20)');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('BUG1 Forced: Sollwert gelöscht + PV-Überschuss → GELADEN (Standard-Puffer), kein 0xCC-Dauer-Stopp, bleibt Modus 2', async () => {
  const r = rig({ controlMode: 'forced' });
  await r.ems.applySetpoint(-5000, 'rule:abend'); // DVhub besitzt Forced (Modus 2)
  r.ems._st.target = null; // Scheduler liefert keinen Sollwert mehr (gelöscht) → Standard-Puffer −40
  r.t.writes.length = 0;
  r.advance(6000); // Regeltakt fällig
  // Mittags-Leerlauf, SoC niedrig (3 %): PV 3000, Last 500, Netz −1500 (Einspeisung), Akku 0.
  r.state.victron.soc = 3;
  r.telemetry({ gridW: -1500, batteryW: 0, pvW: 3000, loadW: 500 });
  await r.ems.tick();
  assert.equal(r.image.holding.get(MODE), EMS_MODE.FORCED, 'bleibt Modus 2 (kein Rückfall in Modus 0)');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.CHARGE, 'lädt den PV-Überschuss statt ihn einzuspeisen (kein 0xCC)');
  assert.ok(r.image.holding.get(POWER) > 0, `Leistung > 0 (${r.image.holding.get(POWER)})`);
  assert.equal(r.state.ctrl.sungrowEms.owns, true, 'DVhub behält die Steuerung');
});

test('BUG1 Absicherung C: Forced besessen, Messwerte veraltet → Rückgabe an den WR (Modus 0), kein Dauer-Stopp in Modus 2', async () => {
  const r = rig({ controlMode: 'forced' });
  await r.ems.applySetpoint(-5000, 'rule:abend'); // besitzt Forced, Modus 2
  r.t.writes.length = 0;
  r.advance(6000); // Regeltakt fällig
  // Messwerte veralten (kein frischer Zähler / keine frischen Felder) → telemetry_missing.
  r.state.meter = { ok: false, updatedAt: 0, grid_total_w: 0 };
  r.state.victron.fieldUpdatedAt = {};
  await r.ems.tick();
  assert.equal(r.image.holding.get(MODE), EMS_MODE.SELF, 'zurück in Modus 0 (Absicherung C), nicht Stopp in Modus 2');
  assert.equal(r.state.ctrl.sungrowEms.owns, false, 'Besitz abgegeben — der WR regelt selbst weiter');
});

test('Dauer-Forced B3: Wiedereintritt nach Selbst-Rückfall; >6/Stunde → Modus 0 lassen (13050-Budget), Warnung', async () => {
  const r = rig({ controlMode: 'forced' });
  await r.ems.applySetpoint(-5000, 'rule:abend'); // Forced-Entladen, owns
  for (let i = 1; i <= 7; i += 1) {
    // Der WR fällt von selbst auf Modus 0 zurück.
    r.image.holding.set(MODE, EMS_MODE.SELF);
    r.image.holding.set(CMD, EMS_CMD.STOP);
    r.advance(61_000); // > deviceRecheckMs → frisch lesen; Takt fällig
    r.telemetry({ gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 });
    await r.ems.applySetpoint(-5000, 'rule:abend'); // Scheduler-Keepalive hält den Sollwert frisch
    if (i <= 6) assert.equal(r.image.holding.get(MODE), EMS_MODE.FORCED, `Wiedereintritt ${i} tritt neu ein`);
  }
  assert.equal(r.image.holding.get(MODE), EMS_MODE.SELF, '7. Rückfall: DVhub tritt nicht mehr ein, Modus 0 bleibt');
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_reentry_rate'), 'Warnung zur Wiedereintritt-Rate');
});

test('Dauer-Forced B1: fremder Modus 2 (DVhub besitzt ihn nicht) wird nicht übersteuert', async () => {
  const r = rig({ controlMode: 'forced', over: { holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 } } });
  const res = await r.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(res.ok, false);
  assert.deepEqual(r.t.writes, [], 'kein Write auf ein fremdes EMS');
  assert.equal(r.image.holding.get(MODE), EMS_MODE.FORCED);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_foreign_mode'));
  assert.equal(r.state.ctrl.sungrowEms.owns, false);
});

test('Aktuator: gleicher Sollwert im Takt nur nachgeführt, kleine Änderung (< 100 W) ohne Write', async () => {
  const r = rig({ allowGridCharge: true });
  await r.ems.applySetpoint(4000, 'rule:netzladen');
  r.t.writes.length = 0;
  // Auffrischen vor Ablauf des Takts: nichts geschrieben.
  assert.equal((await r.ems.applySetpoint(4000, 'rule:netzladen')).refreshed, true);
  await r.ems.tick();
  assert.deepEqual(r.t.writes, []);
  // 10 s später: Netz 2800, Akku +2300 → 3140 W, nur die Leistung neu.
  r.advance(10_000);
  r.telemetry({ gridW: 2800, batteryW: 2300 });
  await r.ems.tick();
  assert.deepEqual(r.t.writes, [{ fc: 6, address: POWER, value: 3140 }]);
  // Fast eingeregelt: Netz 3950, Akku 3140 → 3105 W (Δ 35 W < 100 W) → kein Write.
  r.t.writes.length = 0;
  r.advance(10_000);
  r.telemetry({ gridW: 3950, batteryW: 3140 });
  await r.ems.tick();
  assert.deepEqual(r.t.writes, []);
});

test('Aktuator: Quelle eos_grid_hold reicht noGridCharge an den Regler durch', async () => {
  const r = rig();
  r.telemetry({ gridW: -320, batteryW: -520, pvW: 0, loadW: 200 });
  await r.ems.applySetpoint(1400, 'eos_grid_hold');
  assert.equal(r.state.ctrl.sungrowEms.decision.command, 'stop');
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'charge_pv_only');
  assert.ok(!r.t.writes.some((w) => w.address === CMD && w.value === EMS_CMD.CHARGE), 'kein Lade-Befehl');
});

test('Aktuator: Wechselrichter-Neustart (zurück in Self-consumption) fällt nach spätestens 60 s auf', async () => {
  const r = rig();
  await r.ems.applySetpoint(-5000, 'rule:abend');
  r.t.reads.length = 0;
  r.t.writes.length = 0;
  // Gerät startet neu: Modus 0, Befehl Stopp.
  r.image.holding.set(MODE, EMS_MODE.SELF);
  r.image.holding.set(CMD, EMS_CMD.STOP);
  // Eingeregelt (Netz = Sollwert, Akku = Vorgabe 4000 W): P = −4000 + 0,7 · 0 → keine Änderung, kein Write.
  const steady = { gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 };
  for (let i = 0; i < 5; i += 1) {
    r.advance(10_000);
    r.telemetry(steady);
    await r.ems.tick();
  }
  assert.deepEqual(r.t.reads, [], 'innerhalb von 60 s kein zyklisches Holding-Lesen');
  r.advance(10_000);
  r.telemetry(steady);
  await r.ems.tick();
  assert.equal(r.t.reads.filter((x) => x.fc === 3).length, 2, 'einmal lesen, einmal zurücklesen');
  assert.ok(r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.FORCED), 'Zwangsbetrieb wieder gesetzt');
});

test('Dauer-Forced B1: Sollwert zurück auf −40 W → regelt den Eigenverbrauch (klein), BLEIBT Modus 2', async () => {
  const r = rig({ controlMode: 'forced' });
  await r.ems.applySetpoint(-5000, 'rule:abend'); // Entladen 4000, Modus 2
  r.t.writes.length = 0;
  // Zurück auf den Default-Puffer: kein Rückfall in Modus 0, sondern weiter in Modus 2 auf Netz ≈ −40 regeln
  // (deckt die Last 500 W aus dem Akku → Entladen ~530 W). So fährt DVhub den Eigenverbrauch selbst.
  await r.ems.applySetpoint(-40, 'default');
  assert.equal(r.image.holding.get(MODE), EMS_MODE.FORCED, 'bleibt Modus 2');
  assert.ok(!r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.SELF), 'nie Modus 0');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.DISCHARGE, 'entlädt weiter, um die Last zu decken');
  assert.ok(r.image.holding.get(POWER) >= 400 && r.image.holding.get(POWER) <= 700, `Leistung ${r.image.holding.get(POWER)}`);
  assert.equal(r.state.ctrl.sungrowEms.owns, true, 'DVhub behält die Steuerung');
});

test('Aktuator: Gerät übernimmt den Modus nicht → Fehler mit Rücklesung, nächster Takt neu', async () => {
  const r = rig({ mockOpts: { ignoreWriteAt: MODE } });
  const res = await r.ems.applySetpoint(4000, 'rule:netzladen');
  assert.equal(res.ok, false);
  assert.match(res.error, /Rücklesung weicht ab/);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_readback_mismatch'));
  // Nicht als erledigt gemerkt: der nächste Takt schreibt den Modus erneut.
  r.t.writes.length = 0;
  r.advance(10_000);
  await r.ems.tick();
  assert.ok(r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.FORCED));
});

test('Aktuator: fremdes EMS (Modus 3/4) → DVhub schreibt nichts', async () => {
  for (const mode of [EMS_MODE.EXTERNAL, EMS_MODE.VPP]) {
    const r = rig({ over: { holding: { [MODE]: mode } } });
    const res = await r.ems.applySetpoint(4000, 'rule:netzladen');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'sungrow_foreign_ems_mode');
    assert.deepEqual(r.t.writes, []);
  }
});

test('Aktuator: alte Messwerte oder abgelaufener Sollwert → zurück in Self-consumption', async () => {
  const r = rig({ allowGridCharge: true });
  await r.ems.applySetpoint(4000, 'rule:netzladen');
  r.t.writes.length = 0;
  // 30 s keine frischen Werte (Zähler/Akku älter als 20 s)
  r.advance(30_000);
  await r.ems.tick();
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'telemetry_missing');
  // Wieder frisch, Sollwert läuft aber ohne Auffrischung ab (2 min) → bleibt Self-consumption.
  const r2 = rig({ allowGridCharge: true });
  await r2.ems.applySetpoint(4000, 'rule:netzladen');
  r2.t.writes.length = 0;
  r2.advance(121_000);
  r2.telemetry({ gridW: 4000, batteryW: 3500 });
  await r2.ems.tick();
  assert.equal(r2.state.ctrl.sungrowEms.decision.reason, 'target_expired');
  assert.deepEqual(r2.t.writes.map((w) => w.address), [CMD, MODE]);
});

test('Aktuator: ohne erkanntes Hybrid-Gerät kein Write', async () => {
  for (const device of [null, sungrowDevice({ supported: false })]) {
    const r = rig({ device });
    const res = await r.ems.applySetpoint(4000, 'rule:netzladen');
    assert.equal(res.ok, false);
    assert.match(res.error, /sungrow_device_not_(identified|supported)/);
    assert.deepEqual(r.t.writes, []);
    assert.deepEqual(r.t.reads, []);
  }
});

test('Not-Halt: eigener Zwangsbetrieb genau einmal zurück, danach keinerlei Writes', async () => {
  const r = rig();
  await r.ems.applySetpoint(-5000, 'rule:abend');
  r.t.writes.length = 0;
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 5;
  assert.equal((await r.ems.emergencyStop()).ok, true);
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  r.t.writes.length = 0;
  // Zweiter Aufruf, Takte und neue Sollwerte im Not-Halt: still.
  assert.equal((await r.ems.emergencyStop()).skipped, true);
  r.advance(60_000);
  r.telemetry();
  await r.ems.tick();
  assert.equal((await r.ems.applySetpoint(-5000, 'rule:abend')).blocked, true);
  assert.deepEqual(r.t.writes, []);
});

test('Not-Halt: nicht von DVhub gesetzt (Self-consumption oder nach Neustart unbekannt) → nichts senden', async () => {
  const r = rig({ over: { holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 } } });
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 7;
  assert.equal((await r.ems.emergencyStop()).reason, 'not_owned');
  assert.deepEqual(r.t.writes, []);
  assert.deepEqual(r.t.reads, [], 'nicht einmal gelesen');
});

// --- Codex b8aa8e70 -----------------------------------------------------------------------

test('Codex P1: Bestätigung des Modus-Writes geht verloren → Besitz bleibt, Not-Halt nimmt zurück', async () => {
  const r = rig({ mockOpts: { applyThenFailAt: MODE } });
  const res = await r.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(res.ok, false);
  assert.equal(r.image.holding.get(MODE), EMS_MODE.FORCED, 'Gerät steht trotzdem im Zwangsbetrieb');
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  r.t.writes.length = 0;
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 11;
  assert.equal((await r.ems.emergencyStop()).ok, true);
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
});

test('Codex P1: Not-Halt beginnt während des Lesens → kein einziger Write danach', async () => {
  const r = rig({ mockOpts: { onRead: ({ fc }) => { if (fc === 3) r.state.ctrl.discretionaryWritesPaused = true; } } });
  const res = await r.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.deepEqual(r.t.writes, []);
});

test('Codex P2: fremdes EMS übernimmt nach DVhubs Zwangsbetrieb → Besitz weg, nichts übersteuert', async () => {
  const r = rig();
  await r.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  r.image.holding.set(MODE, EMS_MODE.VPP); // z. B. ein Stromanbieter-Programm
  r.t.writes.length = 0;
  for (let i = 0; i < 7; i += 1) {
    r.advance(10_000);
    r.telemetry({ gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 });
    await r.ems.tick();
  }
  assert.deepEqual(r.t.writes, [], 'VPP-Modus nicht überschrieben');
  assert.equal(r.state.ctrl.sungrowEms.owns, false);
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 12;
  assert.equal((await r.ems.emergencyStop()).reason, 'not_owned');
  assert.deepEqual(r.t.writes, []);
});

test('Codex P2: Adresswechsel → Erkennung und Besitz gelten nicht mehr', async () => {
  const r = rig();
  await r.ems.applySetpoint(-5000, 'rule:abend');
  r.t.writes.length = 0;
  r.cfg.victron.host = '192.0.2.99';
  r.cfg.controlWrite.gridSetpointW.host = '192.0.2.99';
  r.advance(10_000);
  const res = await r.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'sungrow_device_not_identified');
  assert.deepEqual(r.t.writes, []);
  assert.equal(r.state.ctrl.sungrowEms.owns, false);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_endpoint_changed'));
});

// --- Codex 28317bd5 -----------------------------------------------------------------------

test('Codex R2: Widerruf liest frisch — ein inzwischen übernommenes VPP wird nicht überschrieben', async () => {
  const r = rig();
  await r.ems.applySetpoint(-5000, 'rule:abend');
  r.image.holding.set(MODE, EMS_MODE.VPP); // innerhalb des 60-s-Fensters, Cache zeigt noch Zwangsbetrieb
  r.t.writes.length = 0;
  await r.ems.revoke('grid_discharge_not_allowed');
  assert.deepEqual(r.t.writes, []);
  assert.equal(r.state.ctrl.sungrowEms.owns, false);
});

test('Codex R2: Not-Halt während des Lesens → fremder Zwangsbetrieb wird nicht zu DVhubs Besitz', async () => {
  const r = rig({
    over: { holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 } },
    mockOpts: { onRead: ({ fc }) => { if (fc === 3) r.state.ctrl.discretionaryWritesPaused = true; } }
  });
  await r.ems.applySetpoint(4000, 'rule:netzladen');
  assert.deepEqual(r.t.writes, []);
  assert.equal(r.state.ctrl.sungrowEms.owns, false);
  r.state.ctrl.pausedAt = 13;
  assert.equal((await r.ems.emergencyStop()).reason, 'not_owned');
  assert.deepEqual(r.t.writes, []);
});

// --- External EMS (Standard) -------------------------------------------------------------

test('Steuermodus: Standard External EMS, Frist 30 s, Grenzen 20–300 s', () => {
  assert.deepEqual(resolveSungrowControl({}), { mode: 'external', modeValue: EMS_MODE.EXTERNAL, heartbeatTimeoutS: 30, heartbeatAfterMode: true, heartbeatWriteFc: null, acceptDeviceHeartbeatS: 0, keepaliveRegister: '13080' });
  assert.equal(resolveSungrowControl({ sungrow: { controlMode: 'forced' } }).modeValue, EMS_MODE.FORCED);
  assert.equal(resolveSungrowControl({ sungrow: { heartbeatTimeoutS: 5 } }).heartbeatTimeoutS, 20);
  assert.equal(resolveSungrowControl({ sungrow: { heartbeatTimeoutS: 1000 } }).heartbeatTimeoutS, 300);
  assert.equal(resolveSungrowControl({ sungrow: { controlMode: 'quatsch' } }).mode, 'external');
  // Ausgeliefert: Profil + Default-Config (ein WR) → External EMS (Modus 3, geräteeigener Rückfall).
  assert.equal(resolveSungrowControl(loadSungrowConfig()).mode, 'external');
  // Christin 14.11.: Standard bei ZWEI WR ist Forced-Split (Dauer-Modus 2). Ein ausdrückliches 'external' gewinnt.
  assert.equal(resolveSungrowControl({ sungrow: { secondInverter: { host: '192.0.2.83' } } }).mode, 'forced');
  assert.equal(resolveSungrowControl({ sungrow: { controlMode: 'external', secondInverter: { host: '192.0.2.83' } } }).mode, 'external');
  assert.equal(resolveSungrowControl({ sungrow: { secondInverter: { host: '  ' } } }).mode, 'external');
});

test('External EMS: Leistung → Befehl → Modus 3 → Herzschlag (nach Moduswechsel), Rücklesen inkl. Herzschlag', async () => {
  const r = rig({ controlMode: 'external', allowGridCharge: true });
  const res = await r.ems.applySetpoint(4000, 'rule:netzladen');
  assert.equal(res.ok, true, JSON.stringify(res));
  // Punkt 1: Herzschlag NACH dem Moduswechsel (der WR setzt 13080 beim Eintritt in Modus 3 selbst).
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [
    [POWER, 2300], [CMD, EMS_CMD.CHARGE], [MODE, EMS_MODE.EXTERNAL], [HB, 30]
  ]);
  // Lesen: Herzschlag-Vorhandensein, Gerätezustand, Herzschlag-Rücklesung (applyHeartbeat), Gerätezustand-Rücklesung.
  assert.deepEqual(r.t.reads.map((x) => [x.fc, x.address]), [[3, HB], [3, MODE], [3, HB], [3, MODE]]);
  assert.equal(r.state.ctrl.sungrowEms.ownMode, EMS_MODE.EXTERNAL);
});

test('Herzschlag 13080 (Feld #3): Menge 1 liefert Festwert 600, erst Menge 2 den echten Countdown; External EMS hält > 60 s', async () => {
  const r = rig({ controlMode: 'external', heartbeatTimeoutS: 30 });
  await r.ems.applySetpoint(-5000, 'rule:abend');
  // Der Aktuator liest 13080 nur mit Menge 2 (sonst käme der falsche Festwert 600, und der Herzschlag-
  // Vergleich schlüge immer fehl). Jede 13080-Lesung geht mit Menge ≥ 2 raus.
  for (const rd of r.t.reads.filter((x) => x.fc === 3 && x.address === HB)) {
    assert.ok(rd.quantity >= 2, `13080 mit Menge ${rd.quantity} gelesen — muss ≥ 2 sein (Feld #3)`);
  }
  assert.equal(r.image.holding.get(MODE), EMS_MODE.EXTERNAL, 'Herzschlag übernommen → External EMS');
  // Über 60 s (12 Takte à 5 s) bleibt der WR in Modus 3, der Herzschlag wird je Takt neu geschrieben.
  const steady = { gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 };
  let hbWrites = 0;
  for (let i = 0; i < 13; i += 1) {
    r.advance(5000); r.telemetry(steady);
    const before = r.t.writes.length;
    await r.ems.tick();
    if (r.t.writes.slice(before).some((w) => w.address === HB)) hbWrites += 1;
    assert.equal(r.image.holding.get(MODE), EMS_MODE.EXTERNAL, `Takt ${i}: hält External EMS`);
  }
  assert.ok(hbWrites >= 6, `mindestens 6 Herzschläge über 65 s, waren ${hbWrites}`);
});

test('Herzschlag 13080: Rücklese-Toleranz — Ist in [Soll−3, Soll] akzeptiert, darunter (Countdown zu weit) = nicht übernommen', async () => {
  // Der WR zählt sofort herunter: direkt nach dem Schreiben liest man etwas unter dem Soll. 2 s weniger ist ok.
  const ok = rig({ controlMode: 'external', heartbeatTimeoutS: 30, mockOpts: { hbReadDelta: 2 } });
  assert.equal((await ok.ems.applySetpoint(-5000, 'rule:abend')).ok, true);
  assert.equal(ok.image.holding.get(MODE), EMS_MODE.EXTERNAL, 'Soll−2 noch in Toleranz → External EMS');
  // Fällt der Rücklesewert zu weit ab (Soll−5), gilt der Herzschlag als nicht übernommen → sofort sicher Self.
  const bad = rig({ controlMode: 'external', heartbeatTimeoutS: 30, mockOpts: { hbReadDelta: 5 } });
  const res = await bad.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(res.ok, false);
  assert.equal(bad.image.holding.get(MODE), EMS_MODE.SELF, 'Herzschlag nicht übernommen → Self-consumption');
  assert.ok(bad.logs.some((l) => l.event === 'sungrow_ems_heartbeat_unsupported'));
});

test('External EMS: Herzschlag in jedem Takt, auch wenn sich sonst nichts ändert; nie im Self-consumption', async () => {
  const r = rig({ controlMode: 'external' });
  await r.ems.applySetpoint(-5000, 'rule:abend');
  const steady = { gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 };
  r.t.writes.length = 0;
  r.t.reads.length = 0;
  for (let i = 0; i < 3; i += 1) {
    r.advance(10_000);
    r.telemetry(steady);
    await r.ems.tick();
  }
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[HB, 30], [HB, 30], [HB, 30]]);
  // Punkt 3b: solange DVhub External EMS besitzt, in jedem Takt den Gerätemodus frisch lesen (Rückfall-Erkennung).
  assert.deepEqual(r.t.reads.map((x) => [x.fc, x.address]), [[3, MODE], [3, MODE], [3, MODE]], 'Gerätemodus je Takt gelesen');
  // Sollwert zurück ins Band = kurzes Loch: Übergangs-Prinzip (Punkt 1) → in External EMS BLEIBEN, Akku auf 0 W
  // (Stopp), KEIN Moduswechsel. So kein Mode-Flattern, wenn gleich wieder eine Vorgabe kommt.
  r.t.writes.length = 0;
  await r.ems.applySetpoint(-40, 'default');
  assert.equal(r.image.holding.get(MODE), EMS_MODE.EXTERNAL, 'bleibt in External EMS (überbrückt)');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.STOP, 'Akku gestoppt (0 W)');
  assert.ok(!r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.SELF), 'kein Wechsel in Modus 0');
  // Nach längerem Eigenverbrauch (> 15 min Band) → zurück in Modus 0, der Akku folgt wieder dem Eigenverbrauch.
  r.advance(15 * 60 * 1000 + 1000);
  await r.ems.applySetpoint(-40, 'default');
  assert.equal(r.image.holding.get(MODE), EMS_MODE.SELF, 'nach langem Band zurück in Modus 0');
});

test('Übergang (Punkt 1): kurzes Loch zwischen zwei Vorgaben bleibt in External EMS; Widerruf geht sofort in Modus 0', async () => {
  const r = rig({ controlMode: 'external' });
  await r.ems.applySetpoint(-5000, 'rule:abend'); // Entladen, External EMS
  assert.equal(r.image.holding.get(MODE), EMS_MODE.EXTERNAL);
  // Kurzes Loch (Sollwert ins Band), dann gleich wieder eine Vorgabe → durchweg External EMS, kein Modus 0.
  r.advance(60_000); r.telemetry({ gridW: -40, batteryW: 0, pvW: 0, loadW: 300 });
  await r.ems.applySetpoint(-40, 'default'); // Band → überbrückt (0 W), bleibt External
  assert.equal(r.image.holding.get(MODE), EMS_MODE.EXTERNAL, 'kurzes Loch bleibt External EMS');
  assert.equal(r.image.holding.get(CMD), EMS_CMD.STOP, 'Akku 0 W im Loch');
  r.advance(60_000); r.telemetry({ gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 });
  await r.ems.applySetpoint(-5000, 'rule:abend'); // neue Vorgabe → wieder entladen, nie Modus 0
  assert.equal(r.image.holding.get(MODE), EMS_MODE.EXTERNAL);
  assert.equal(r.image.holding.get(CMD), EMS_CMD.DISCHARGE, 'neue Vorgabe fährt sofort wieder');
  // Widerruf ist KEIN überbrückbares Loch → sofort zurück in Modus 0.
  r.t.writes.length = 0;
  await r.ems.revoke('grid_discharge_not_allowed');
  assert.equal(r.image.holding.get(MODE), EMS_MODE.SELF, 'Widerruf sofort Modus 0');
  assert.equal(r.state.ctrl.sungrowEms.owns, false);
});

for (const [timeoutS, everyS] of [[20, 5], [30, 10], [60, 10]]) {
  test(`External EMS: Frist ${timeoutS} s → Herzschlag alle ${everyS} s beim echten 5-s-Aufruftakt (Zittern ±200 ms)`, async () => {
    const r = rig({ controlMode: 'external', heartbeatTimeoutS: timeoutS });
    await r.ems.applySetpoint(-5000, 'rule:abend');
    r.t.writes.length = 0;
    const at = [];
    let elapsed = 0;
    for (let i = 1; i <= 12; i += 1) {
      const step = 5000 + (i % 2 ? -200 : 200); // Intervall-Timer zittert
      r.advance(step);
      elapsed += step;
      r.telemetry({ gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 });
      const before = r.t.writes.length;
      await r.ems.tick();
      if (r.t.writes.slice(before).some((w) => w.address === HB)) at.push(elapsed);
    }
    const gaps = at.map((x, i) => (i ? x - at[i - 1] : x));
    assert.ok(gaps.every((g) => g <= everyS * 1000 + 400), `Abstände ${gaps}`);
    assert.ok(Math.max(...gaps) * 3 <= timeoutS * 1000 + 1200, 'mindestens drei Herzschläge je Frist');
  });
}

for (const variant of ['Register fällt auf 0', 'Register bleibt 3']) {
  test(`External EMS: DVhub hängt länger als die Frist (${variant}) → beim Wiederanlauf ganzer Befehl neu`, async () => {
    const r = rig({ controlMode: 'external' });
    await r.ems.applySetpoint(-5000, 'rule:abend');
    // DVhub hängt 40 s (> 30 s Frist). Der Wechselrichter fällt laut Doku in Self-consumption zurück;
    // ob 13050 dabei auf 0 springt, sagt die Doku nicht — beide Fälle.
    r.advance(40_000);
    if (variant === 'Register fällt auf 0') { r.image.holding.set(MODE, EMS_MODE.SELF); r.image.holding.set(CMD, EMS_CMD.STOP); }
    r.telemetry({ gridW: 0, batteryW: -500, pvW: 0, loadW: 500 });
    r.t.writes.length = 0;
    await r.ems.tick();
    assert.deepEqual(r.t.writes.map((w) => w.address), [POWER, CMD, MODE, HB], 'alles neu, auch was gleich aussieht');
    assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_heartbeat_gap'));
    assert.equal(r.image.holding.get(MODE), EMS_MODE.EXTERNAL);
  });
}

test('External EMS: Firmware ohne Herzschlag-Register → kein Write, klare Meldung; Forced mode geht weiter', async () => {
  for (const over of [{ dropHolding: [HB] }, { holding: { [HB]: 0xffff } }]) {
    const r = rig({ controlMode: 'external', over });
    const res = await r.ems.applySetpoint(4000, 'rule:netzladen');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'sungrow_heartbeat_unsupported');
    assert.deepEqual(r.t.writes, []);
    assert.equal(r.logs.filter((l) => l.event === 'sungrow_ems_heartbeat_unsupported').length, 1);
    r.advance(10_000);
    await r.ems.tick();
    assert.equal(r.logs.filter((l) => l.event === 'sungrow_ems_heartbeat_unsupported').length, 1, 'nur einmal gemeldet');
    // Bewusst Forced mode gewählt → steuert.
    r.cfg.sungrow.controlMode = 'forced';
    r.advance(10_000);
    await r.ems.tick();
    assert.ok(r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.FORCED));
  }
});

test('Codex R4: liegengebliebener Zwangsbetrieb ohne Merker + Firmware ohne 13080 → Sollwert im Band gibt ihn frei', async () => {
  const r = rig({ controlMode: 'external', over: { dropHolding: [HB], holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 4000 } } });
  const res = await r.ems.applySetpoint(-40, 'default');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  // Ein Lade-/Entladewunsch bleibt dagegen ohne Herzschlag gesperrt.
  r.t.writes.length = 0;
  assert.equal((await r.ems.applySetpoint(-5000, 'rule:abend')).error, 'sungrow_heartbeat_unsupported');
  assert.deepEqual(r.t.writes, []);
});

test('Codex R4: Frist erhöht, bevor ein Hänger auffällt → Lücke gegen die im Gerät geltende alte Frist', async () => {
  const r = rig({ controlMode: 'external', heartbeatTimeoutS: 30 });
  await r.ems.applySetpoint(-5000, 'rule:abend');
  r.cfg.sungrow.heartbeatTimeoutS = 300; // Betreiber ändert die Frist
  r.advance(40_000);                      // DVhub hing 40 s — im Gerät galten noch 30 s
  r.telemetry({ gridW: 0, batteryW: -500, pvW: 0, loadW: 500 });
  r.t.writes.length = 0;
  await r.ems.tick();
  assert.deepEqual(r.t.writes.map((w) => w.address), [POWER, CMD, MODE, HB], 'voller Wiedereintritt');
  assert.equal(r.t.writes.find((w) => w.address === HB).value, 300, 'neue Frist geht dabei raus');
});

test('Moduswechsel zur Laufzeit: erst Self-consumption bestätigt, dann der neue Modus', async () => {
  const r = rig({ controlMode: 'external' });
  await r.ems.applySetpoint(-5000, 'rule:abend');
  const steady = { gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 };
  r.t.writes.length = 0;
  r.cfg.sungrow.controlMode = 'forced';
  r.advance(10_000);
  r.telemetry(steady);
  await r.ems.tick();
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  assert.equal(r.state.ctrl.sungrowEms.owns, false);
  r.t.writes.length = 0;
  r.advance(10_000);
  r.telemetry(steady);
  await r.ems.tick();
  // Leistung steht noch im Register (Self-consumption setzt sie nicht zurück) → nur Befehl und Modus 2.
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.DISCHARGE], [MODE, EMS_MODE.FORCED]]);
  assert.equal(r.image.holding.get(MODE), EMS_MODE.FORCED);
  assert.ok(!r.t.writes.some((w) => w.address === HB), 'Forced mode ohne Herzschlag');
});

test('Not-Halt im External EMS: einmal Stopp + Modus 0, danach auch kein Herzschlag mehr', async () => {
  const r = rig({ controlMode: 'external' });
  await r.ems.applySetpoint(-5000, 'rule:abend');
  r.t.writes.length = 0;
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 21;
  assert.equal((await r.ems.emergencyStop()).ok, true);
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  r.t.writes.length = 0;
  for (let i = 0; i < 6; i += 1) { r.advance(10_000); r.telemetry(); await r.ems.tick(); }
  assert.deepEqual(r.t.writes, []);
});

test('External EMS: fremdes Modus 3 wird nicht übersteuert, das eigene nach Neustart (Merker) schon', async () => {
  const foreign = rig({ controlMode: 'external', over: { holding: { [MODE]: EMS_MODE.EXTERNAL } } });
  assert.equal((await foreign.ems.applySetpoint(4000, 'rule:netzladen')).error, 'sungrow_foreign_ems_mode');
  assert.deepEqual(foreign.t.writes, []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-ems-state-'));
  const statePath = path.join(dir, 'sungrow_ems_state.json');
  const a = rig({ controlMode: 'external', statePath });
  await a.ems.applySetpoint(-5000, 'rule:abend');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).ownMode, EMS_MODE.EXTERNAL);
  // Neustart: neuer Prozess, gleiches Gerät (Modus 3 steht noch), Merker liegt.
  const b = rig({ controlMode: 'external', statePath, over: { holding: { [MODE]: EMS_MODE.EXTERNAL, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 4000 } } });
  assert.equal(b.state.ctrl.sungrowEms, undefined);
  const res = await b.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(b.t.writes.some((w) => w.address === HB), 'eigenes External EMS: Herzschlag weiter');
  // Not-Halt nach dem Neustart nimmt den eigenen Betrieb zurück; danach ist der Merker weg.
  b.t.writes.length = 0;
  b.state.ctrl.discretionaryWritesPaused = true;
  b.state.ctrl.pausedAt = 22;
  await b.ems.emergencyStop();
  assert.deepEqual(b.t.writes.map((w) => w.address), [CMD, MODE]);
  assert.equal(fs.existsSync(statePath), false);
});

// --- Regelgüte: Anlagen-Simulation mit Lastsprüngen ------------------------------------------
// Physik: Netz = Last − PV + Akku (Laden +). Im Zwangs-/EMS-Betrieb folgt der Akku dem Befehl mit Verzögerung
// `lag` je Takt (1 = sofort, 0,5 = halber Weg), begrenzt auf 10 kW; in Self-consumption deckt er die Netto-Last.
function plant(r, { loadW, pvW = 0, batteryW = -loadW, lag = 1 }) {
  const p = { loadW, pvW, batteryW, lag };
  p.target = () => {
    const mode = r.image.holding.get(MODE);
    const cmd = r.image.holding.get(CMD);
    const pw = r.image.holding.get(POWER);
    if (mode === EMS_MODE.SELF) return Math.max(-10000, Math.min(10000, p.pvW - p.loadW));
    return cmd === EMS_CMD.CHARGE ? pw : cmd === EMS_CMD.DISCHARGE ? -pw : 0;
  };
  p.settle = () => {
    p.batteryW += p.lag * (p.target() - p.batteryW);
    r.telemetry({ gridW: Math.round(p.loadW - p.pvW + p.batteryW), batteryW: Math.round(p.batteryW), pvW: p.pvW, loadW: p.loadW });
    return p.loadW - p.pvW + p.batteryW;
  };
  p.settle();
  return p;
}

async function runSteps(r, p, setpointW, n, source = 'rule:test') {
  const errors = [];
  for (let i = 0; i < n; i += 1) {
    r.advance(10_000);
    // Wie im Betrieb: der Evaluator frischt den Sollwert auf (Keepalive), der Takt regelt nach.
    await r.ems.applySetpoint(setpointW, source);
    await r.ems.tick();
    errors.push(Math.round(p.settle() - setpointW));
  }
  return errors;
}

for (const controlMode of ['external', 'forced']) {
  for (const lag of [1, 0.5]) {
    test(`Regelgüte (${controlMode}, Akku-Verzögerung ${lag}): Netzladen 3 kW, Lastsprung +3 kW und −3 kW`, async () => {
      const r = rig({ controlMode, allowGridCharge: true }); // Netzladen 3 kW ausdrücklich freigegeben (D)
      const p = plant(r, { loadW: 500, lag });
      await r.ems.applySetpoint(3000, 'rule:test');
      const e1 = await runSteps(r, p, 3000, 10);
      // Einschwingen: |Fehler| < 150 W nach höchstens 4 Takten (40 s) bei sofortigem Akku, 9 (90 s) bei halber Verzögerung.
      const settleBy = lag === 1 ? 4 : 9;
      assert.ok(e1.slice(settleBy - 1).every((e) => Math.abs(e) < 150), `eingeschwungen: ${e1}`);
      // Lastsprung: Wärmepumpe +3 kW → der Regler nimmt die Ladung zurück und entlädt notfalls für die Last.
      p.loadW = 3500;
      const e2 = await runSteps(r, p, 3000, 12);
      assert.ok(e2.slice(settleBy).every((e) => Math.abs(e) < 150), `nach +3 kW: ${e2}`);
      // Kein Aufschwingen: das Vorzeichen des Fehlers wechselt höchstens einmal.
      const flips = (es) => es.filter((e, i) => i > 0 && Math.sign(e) !== 0 && Math.sign(es[i - 1]) !== 0 && Math.sign(e) !== Math.sign(es[i - 1])).length;
      assert.ok(flips(e1) <= 1 && flips(e2) <= 1, `kein Pendeln: ${e1} / ${e2}`);
      p.loadW = 500;
      const e3 = await runSteps(r, p, 3000, 12);
      assert.ok(e3.slice(settleBy).every((e) => Math.abs(e) < 150), `nach −3 kW: ${e3}`);
    });
  }
}

test('Regelgüte: Einspeisen 4 kW bei leerem Akku-Limit — Grenze 10 kW BDC wird nie überschritten', async () => {
  const r = rig({ controlMode: 'external' });
  const p = plant(r, { loadW: 8000 });
  await r.ems.applySetpoint(-4000, 'rule:test');
  await runSteps(r, p, -4000, 8);
  const powers = r.t.writes.filter((w) => w.address === POWER).map((w) => w.value);
  assert.ok(powers.length > 0 && powers.every((w) => w <= 10000), `Leistungen: ${powers}`);
  assert.equal(r.image.holding.get(POWER), 10000, 'an der BDC-Grenze');
});

// --- Integration: echter Evaluator, ausgeliefertes Profil -------------------------------

function evaluatorRig(persisted = {}) {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced' }, ...persisted });
  const image = sungrowImage();
  const t = mockSungrow(image);
  const now = Date.now();
  const state = {
    victron: {
      soc: 60, batteryPowerW: -500, pvPowerW: 0, selfConsumptionW: 500, errors: {},
      fieldUpdatedAt: { soc: now, batteryPowerW: now, pvPowerW: now, selfConsumptionW: now },
      device: sungrowDevice()
    },
    meter: { ok: true, updatedAt: now, grid_total_w: 0 },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: {}
  };
  const logs = [];
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport: t, pushLog: (event, data) => logs.push({ event, data }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null
  });
  return { cfg, t, state, evaluator, logs };
}

test('Evaluator: Netzladen ohne Freigabe + Last unbekannt (EEG/MiSpeL-Tor) → abgelehnt, kein Write', async () => {
  // Punkt 1: ein positiver Sollwert wird bei bekannter Last auf die Hauslast gedeckelt; ist die Last
  // unbekannt/veraltet, lehnt das Tor wie bisher ab.
  const r = evaluatorRig();
  r.state.victron.fieldUpdatedAt.selfConsumptionW = 1; // Last unbekannt
  const res = await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'rule:netzladen');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'grid_charge_not_allowed');
  assert.deepEqual(r.t.writes, []);
});

test('Evaluator: Netzladen mit Freigabe → Zwangsbetrieb Laden über den Aktuator', async () => {
  const r = evaluatorRig({ optimizer: { allowGridCharge: true } });
  const res = await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'api_manual_write');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.writeType, 'sungrow-ems');
  // P = −500 + 0,7 · (3000 − 0) = 1600
  assert.deepEqual(r.t.writes, [
    { fc: 6, address: POWER, value: 1600 },
    { fc: 6, address: CMD, value: EMS_CMD.CHARGE },
    { fc: 6, address: MODE, value: EMS_MODE.FORCED }
  ]);
  assert.equal(r.state.schedule.lastWrite.gridSetpointW.writeType, 'sungrow-ems');
});

test('Codex P1: Netzladen-Freigabe zurückgenommen → abgelehnter Sollwert beendet den Zwangsbetrieb sofort', async () => {
  const r = evaluatorRig({ optimizer: { allowGridCharge: true } });
  r.state.victron.fieldUpdatedAt.selfConsumptionW = 1; // Last unbekannt → Rücknahme lehnt ab (statt zu deckeln)
  await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'api_manual_write');
  assert.ok(r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.FORCED));
  r.t.writes.length = 0;
  r.cfg.optimizer.allowGridCharge = false;
  const res = await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'api_manual_write');
  assert.equal(res.error, 'grid_charge_not_allowed');
  // Dauer-Forced (Christin 15.11.): der abgelehnte Ladesollwert fällt weg → DVhub regelt wieder den Standard-Puffer
  // (neutrale Self-consumption), lädt dabei NIE aus dem Netz. Der Modus BLEIBT 2 (kein Rückfall in 0), kein Dauer-Stopp.
  assert.ok(!r.t.writes.some((w) => w.address === CMD && w.value === EMS_CMD.CHARGE), 'kein Netz-Ladebefehl mehr');
  assert.ok(!r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.SELF), 'kein Rückfall in Modus 0');
  assert.equal(r.state.ctrl.sungrowEms.target, null);
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'regulate', 'regelt den Standard-Puffer');
  r.t.writes.length = 0;
  await r.evaluator.sungrowEms.tick();
  assert.deepEqual(r.t.writes, [], 'kein Nachladen aus dem gemerkten Sollwert');
});

test('Codex R2: gleichzeitig abgelehnter und angenommener Sollwert — der angenommene bleibt wirksam', async () => {
  const r = evaluatorRig({ optimizer: { allowGridDischarge: true } });
  r.state.victron.fieldUpdatedAt.selfConsumptionW = 1; // Last unbekannt → positiver Sollwert wird abgelehnt
  const [a, b] = await Promise.all([
    r.evaluator.applyControlTarget('gridSetpointW', 3000, 'api_manual_write'),   // Netzladen nicht erlaubt
    r.evaluator.applyControlTarget('gridSetpointW', -4000, 'api_manual_write')
  ]);
  assert.equal(a.error, 'grid_charge_not_allowed');
  assert.equal(b.ok, true);
  assert.equal(r.state.ctrl.sungrowEms.target?.setpointW, -4000);
  assert.ok(r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.FORCED));
  assert.ok(!r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.SELF), 'nicht zurück in Self-consumption');
});

test('Codex R2: nach Widerruf erreicht derselbe, wieder erlaubte Sollwert den Aktuator', async () => {
  const r = evaluatorRig({ optimizer: { allowGridCharge: true } });
  await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'api_manual_write');
  r.cfg.optimizer.allowGridCharge = false;
  await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'api_manual_write');
  r.t.writes.length = 0;
  r.cfg.optimizer.allowGridCharge = true;
  const res = await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'api_manual_write');
  assert.equal(res.ok, true);
  assert.notEqual(res.skipped, true, 'nicht als unverändert übersprungen');
  // Dauer-Forced: der Modus bleibt 2; der wieder erlaubte Sollwert erreicht den Aktuator als Lade-Befehl.
  assert.ok(r.t.writes.some((w) => w.address === CMD && w.value === EMS_CMD.CHARGE), 'lädt wieder');
  assert.ok(!r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.SELF), 'kein Rückfall in Modus 0');
});

test('Codex P2: Evaluator schreibt nicht an eine Verbindung, an der nicht erkannt wurde', async () => {
  const r = evaluatorRig({ optimizer: { allowGridDischarge: true } });
  r.state.victron.device = sungrowDevice({ endpointKey: '192.0.2.99:502:1' });
  const res = await r.evaluator.applyControlTarget('gridSetpointW', -4000, 'api_manual_write');
  assert.equal(res.error, 'device_not_identified');
  await r.evaluator.applyDvVictronControl(false, { reason: 'dv_forced_off' });
  assert.deepEqual(r.t.writes, []);
});

test('Evaluator: Entladen bei unbekanntem SoC → SoC-Boden hält auf 0 → Self-consumption', async () => {
  const r = evaluatorRig({ optimizer: { allowGridDischarge: true } });
  r.state.victron.soc = null;
  const res = await r.evaluator.applyControlTarget('gridSetpointW', -4000, 'api_manual_write');
  assert.equal(res.ok, true);
  assert.ok(r.logs.some((l) => l.event === 'control_discharge_floor'));
  assert.deepEqual(r.t.writes, [], 'Gerät steht schon in Self-consumption');
  assert.equal(r.state.ctrl.sungrowEms.decision.mode, 'self');
});

test('Evaluator: Not-Halt über setEmergencyStop nimmt eigenen Zwangsbetrieb einmal zurück, Tor blockt danach', async () => {
  const r = evaluatorRig({ optimizer: { allowGridDischarge: true } });
  await r.evaluator.applyControlTarget('gridSetpointW', -4000, 'api_manual_write');
  assert.ok(r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.FORCED));
  r.t.writes.length = 0;
  const ctx = { state: r.state, pushLog: () => {}, sungrowEms: r.evaluator.sungrowEms, persistControlState: () => true };
  const out = await setEmergencyStop(ctx, { on: true });
  assert.equal(out.ok, true);
  assert.equal(out.devices.batteryEms.ok, true);
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  r.t.writes.length = 0;
  const res = await r.evaluator.applyControlTarget('gridSetpointW', -4000, 'api_manual_write');
  assert.equal(res.blocked, true);
  await r.evaluator.sungrowEms.tick();
  assert.deepEqual(r.t.writes, []);
});

// --- Echtes Modbus TCP (Transport, Poller, Evaluator) ------------------------------------

function startSungrowServer(image) {
  const frames = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 7) {
        const len = buf.readUInt16BE(4);
        if (buf.length < 6 + len) break;
        const req = buf.subarray(0, 6 + len);
        buf = buf.subarray(6 + len);
        const fc = req.readUInt8(7);
        const address = req.readUInt16BE(8);
        const arg = req.readUInt16BE(10);
        frames.push({ fc, address, arg });
        const head = (pduLen) => { const b = Buffer.alloc(7 + pduLen); req.copy(b, 0, 0, 4); b.writeUInt16BE(1 + pduLen, 4); b.writeUInt8(req.readUInt8(6), 6); return b; };
        const exception = (code) => { const b = head(2); b.writeUInt8(fc | 0x80, 7); b.writeUInt8(code, 8); socket.write(b); };
        if (fc === 3 || fc === 4) {
          const img = fc === 4 ? image.input : image.holding;
          const words = [];
          for (let i = 0; i < arg; i += 1) {
            if (!img.has(address + i)) { words.length = 0; break; }
            words.push(img.get(address + i));
          }
          if (words.length !== arg) { exception(2); continue; }
          const b = head(2 + arg * 2);
          b.writeUInt8(fc, 7); b.writeUInt8(arg * 2, 8);
          words.forEach((w, i) => b.writeUInt16BE(w & 0xffff, 9 + i * 2));
          socket.write(b);
        } else if (fc === 6) {
          if (!image.holding.has(address)) { exception(2); continue; }
          image.holding.set(address, arg);
          const b = head(5);
          b.writeUInt8(6, 7); b.writeUInt16BE(address, 8); b.writeUInt16BE(arg, 10);
          socket.write(b);
        } else {
          exception(1);
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, frames, port: server.address().port })));
}

test('Modbus TCP: Poll liest nur FC 4 an Doku−1-Adressen; Sollwert (External EMS) schreibt FC 6 auf 13050–13052 + Herzschlag 13080 und liest per FC 3 zurück', async () => {
  const image = sungrowImage();
  const { server, frames, port } = await startSungrowServer(image);
  const transport = createModbusTransport();
  try {
    const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', optimizer: { allowGridDischarge: true } });
    // Profil auf den Testserver umbiegen (Adresse/Port der Anlage).
    const retarget = (o) => { if (o && typeof o === 'object' && 'host' in o) { o.host = '127.0.0.1'; o.port = port; } };
    cfg.victron.host = '127.0.0.1'; cfg.victron.port = port;
    retarget(cfg.meter);
    for (const block of [cfg.points, cfg.controlWrite]) for (const c of Object.values(block)) retarget(c);
    cfg.epex = { timezone: 'UTC' };
    cfg.userEnergyPricing = {};
    const state = {
      meter: { ok: false, updatedAt: 0, grid_total_w: 0 },
      victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
      schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
      ctrl: {}, dvRegs: new Array(8).fill(0),
      energy: { day: '2026-11-11', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
    };
    const poller = createPoller({
      state, getCfg: () => cfg, transport, pushLog: () => {},
      energyPath: path.join(os.tmpdir(), `sungrow-tcp-${process.pid}.json`), onPollComplete: () => {}, epexNowNext: () => null
    });
    await poller.requestPoll();
    assert.equal(state.victron.device.model, 'SH10RT');
    assert.equal(state.victron.soc, 57.3);
    assert.equal(state.victron.pvPowerW, 70000);
    assert.equal(state.meter.grid_total_w, -2300);
    // Zyklische Messwerte nur über Input-Register (FC 4); die einzigen Holding-Lesevorgänge (FC 3) sind die
    // Master-Gerätegrenzen + Min-/Max-SoC als BLÖCKE (N3): 33047+3 (Laden/Entladen/Kapazität) und 13057+4
    // (Max-SoC 13058, Min-SoC 13059). Fehlt 13057–13060 im Abbild → Modbus-Ausnahme → Rückfall auf Einzellesen
    // 13058/13059. Nur im langsamen Info-Takt.
    const limitAddrs = new Set([wire(33047), wire(13057), wire(13058), wire(13059)]);
    assert.ok(frames.every((f) => f.fc === 4 || (f.fc === 3 && limitAddrs.has(f.address))), 'Poll: nur Input-Register + Gerätegrenzen (FC 3)');
    const readAddrs = new Set(frames.map((f) => f.address));
    for (const doc of [5000, 4990, 5628, 13000, 5601, 13023, 5214, 5017, 13008]) assert.ok(readAddrs.has(doc - 1), `Doku ${doc} → ${doc - 1}`);

    frames.length = 0;
    const evaluator = createScheduleEvaluator({
      state, getCfg: () => cfg, transport, pushLog: () => {},
      telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null
    });
    // Einspeisen 4 kW: Akku lädt gerade 1500 W, Netz −2300 → P = 1500 + 0,7 · (−4000 + 2300) = 310 → Laden 310 W
    // (PV-Überschuss 70 000 − 850 reicht).
    const res = await evaluator.applyControlTarget('gridSetpointW', -4000, 'api_manual_write');
    assert.equal(res.ok, true, JSON.stringify(res));
    // Standard External EMS (Punkt 1): Herzschlag-Register prüfen, Zustand lesen, Leistung → Befehl → Modus 3 →
    // Herzschlag 30 s (NACH dem Moduswechsel, per FC 06), Herzschlag zurücklesen, dann Block zurücklesen.
    assert.deepEqual(frames.map((f) => [f.fc, f.address, f.arg]), [
      [3, 13079, 2],
      [3, 13049, 3],
      [6, 13051, 310], [6, 13050, 0xaa], [6, 13049, 3], [6, 13079, 30],
      [3, 13079, 2],
      [3, 13049, 3]
    ]);
    assert.deepEqual([image.holding.get(13049), image.holding.get(13050), image.holding.get(13051), image.holding.get(13079)], [3, 0xaa, 310, 30]);
  } finally {
    await transport.destroy();
    await new Promise((r) => server.close(r));
  }
});

// --- Punkt 2: adaptiver Regeltakt + Schreibbudget ------------------------------------------
test('Punkt 2: Tages-Schreibzähler je Register + regulateEveryMs/responseMs in /api/status', async () => {
  const r = rig({ controlMode: 'external' });
  await r.ems.applySetpoint(-5000, 'rule:abend'); // schreibt Leistung, Befehl, Modus, Herzschlag
  const s = r.state.ctrl.sungrowEms;
  assert.ok(s.writesToday.mode13050 >= 1 && s.writesToday.cmd13051 >= 1 && s.writesToday.power13052 >= 1, JSON.stringify(s.writesToday));
  assert.equal(typeof s.regulateEveryMs, 'number');
  assert.ok('responseMs' in s && 'modeBudgetLeft' in s);
});

test('Punkt 2 / E: fester sungrow.regulateEveryMs hat Vorrang, wählbar bis 0,25 s, Deckel 5 s', async () => {
  const r = rig({ controlMode: 'external' });
  r.cfg.sungrow.regulateEveryMs = 2000;
  assert.equal(r.ems.status().regulateEveryMs, 2000);
  r.cfg.sungrow.regulateEveryMs = 250;   // 0,25-s-Option (wählbar)
  assert.equal(r.ems.status().regulateEveryMs, 250);
  r.cfg.sungrow.regulateEveryMs = 50;    // unter der 0,25-s-Grenze → 250
  assert.equal(r.ems.status().regulateEveryMs, 250);
  r.cfg.sungrow.regulateEveryMs = 99999; // über Maximum → 5 s
  assert.equal(r.ems.status().regulateEveryMs, 5000);
});

test('E: Auto-Strecken — hält die gemessene Antwortzeit den kurzen Takt nicht, streckt es auf die Rate', async () => {
  const r = rig({ controlMode: 'external' });
  r.cfg.sungrow.regulateEveryMs = 250;   // Wunsch 0,25 s
  r.ems._st.responseMs = 480;            // gemessen: ein Takt dauert 480 ms (beide WR) → 250 nicht haltbar
  assert.equal(r.ems.status().regulateEveryMs, 480, 'auf die gemessene Rate gestreckt');
  r.ems._st.responseMs = 120;            // schnell genug → gewünschte 250 ms
  assert.equal(r.ems.status().regulateEveryMs, 250);
});

test('Punkt 2: ohne festen Wert adaptiv aus der Antwortzeit (×2, geklemmt), sonst langsamster Takt', async () => {
  const r = rig({ controlMode: 'external' });
  assert.equal(r.ems.status().regulateEveryMs, 5000); // ohne Messung konservativ
  r.ems._st.responseMs = 400;
  assert.equal(r.ems.status().regulateEveryMs, 1000); // 800 → auf 1 s angehoben
  r.ems._st.responseMs = 1800;
  assert.equal(r.ems.status().regulateEveryMs, 3600);
  r.ems._st.responseMs = 9000;
  assert.equal(r.ems.status().regulateEveryMs, 5000); // geklemmt
});

test('Punkt 2: 13050-Tagesbudget erschöpft → kein neuer Moduswechsel (bleibt im Eigenverbrauch), Warnung', async () => {
  const r = rig({ controlMode: 'external' });
  r.ems._st.writeDay = { key: new Date(r.now()).toDateString(), regs: { [MODE]: 20 } };
  r.t.writes.length = 0;
  await r.ems.applySetpoint(-5000, 'rule:abend'); // würde sonst External EMS verlangen
  assert.ok(!r.t.writes.some((x) => x.address === MODE && x.value === EMS_MODE.EXTERNAL), 'kein Moduswechsel nach External');
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'mode_budget');
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_mode_budget'));
});
