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
import {
  decideEmsCommand, createSungrowEms, emsMatches, EMS_CMD, EMS_MODE, wire
} from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const MODE = wire(13050);
const CMD = wire(13051);
const POWER = wire(13052);

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

test('emsMatches: Self = Modus 0 + Stopp; Zwang mit Leistungstoleranz', () => {
  assert.equal(emsMatches({ mode: 0, cmd: 0xcc, powerW: 999 }, { mode: 'self' }), true);
  assert.equal(emsMatches({ mode: 0, cmd: 0xaa, powerW: 0 }, { mode: 'self' }), false);
  assert.equal(emsMatches({ mode: 2, cmd: 0xaa, powerW: 2350 }, { mode: 'forced', command: 'charge', powerW: 2300 }, 100), true);
  assert.equal(emsMatches({ mode: 2, cmd: 0xaa, powerW: 2450 }, { mode: 'forced', command: 'charge', powerW: 2300 }, 100), false);
  assert.equal(emsMatches({ mode: 2, cmd: 0xbb, powerW: 2300 }, { mode: 'forced', command: 'charge', powerW: 2300 }, 100), false);
});

// --- Aktuator ------------------------------------------------------------------------

function rig({ over = {}, device = sungrowDevice(), mockOpts = {} } = {}) {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import' });
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
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, pushLog: (event, data) => logs.push({ event, data }), now });
  return { cfg, image, t, state, ems, logs, telemetry, advance: (ms) => { clock += ms; }, now };
}

test('Aktuator: Netzladen → Leistung, Befehl, Modus (in dieser Reihenfolge), dann Rücklesen', async () => {
  const r = rig();
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

test('Aktuator: gleicher Sollwert im Takt nur nachgeführt, kleine Änderung (< 100 W) ohne Write', async () => {
  const r = rig();
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

test('Aktuator: Sollwert zurück auf −40 W → Befehl Stopp, dann Self-consumption', async () => {
  const r = rig();
  await r.ems.applySetpoint(-5000, 'rule:abend');
  r.t.writes.length = 0;
  await r.ems.applySetpoint(-40, 'default');
  assert.deepEqual(r.t.writes, [
    { fc: 6, address: CMD, value: EMS_CMD.STOP },
    { fc: 6, address: MODE, value: EMS_MODE.SELF }
  ]);
  assert.equal(r.state.ctrl.sungrowEms.owns, false);
  // Steht schon so: kein weiterer Write.
  r.t.writes.length = 0;
  r.advance(30_000);
  await r.ems.applySetpoint(-40, 'default');
  assert.deepEqual(r.t.writes, []);
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
  const r = rig();
  await r.ems.applySetpoint(4000, 'rule:netzladen');
  r.t.writes.length = 0;
  // 30 s keine frischen Werte (Zähler/Akku älter als 20 s)
  r.advance(30_000);
  await r.ems.tick();
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'telemetry_missing');
  // Wieder frisch, Sollwert läuft aber ohne Auffrischung ab (2 min) → bleibt Self-consumption.
  const r2 = rig();
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

// --- Integration: echter Evaluator, ausgeliefertes Profil -------------------------------

function evaluatorRig(persisted = {}) {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', ...persisted });
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

test('Evaluator: Netzladen ohne Freigabe (EEG/MiSpeL-Tor) → abgelehnt, kein Write', async () => {
  const r = evaluatorRig();
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
  await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'api_manual_write');
  assert.ok(r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.FORCED));
  r.t.writes.length = 0;
  r.cfg.optimizer.allowGridCharge = false;
  const res = await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'api_manual_write');
  assert.equal(res.error, 'grid_charge_not_allowed');
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  assert.equal(r.state.ctrl.sungrowEms.target, null);
  r.t.writes.length = 0;
  await r.evaluator.sungrowEms.tick();
  assert.deepEqual(r.t.writes, [], 'kein Nachladen aus dem gemerkten Sollwert');
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

test('Modbus TCP: Poll liest nur FC 4 an Doku−1-Adressen; Sollwert schreibt FC 6 auf 13050–13052 und liest per FC 3 zurück', async () => {
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
    assert.ok(frames.every((f) => f.fc === 4), 'Poll: nur Input-Register');
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
    assert.deepEqual(frames.map((f) => [f.fc, f.address, f.arg]), [
      [3, 13049, 3],
      [6, 13051, 310], [6, 13050, 0xaa], [6, 13049, 2],
      [3, 13049, 3]
    ]);
    assert.deepEqual([image.holding.get(13049), image.holding.get(13050), image.holding.get(13051)], [2, 0xaa, 310]);
  } finally {
    await transport.destroy();
    await new Promise((r) => server.close(r));
  }
});
