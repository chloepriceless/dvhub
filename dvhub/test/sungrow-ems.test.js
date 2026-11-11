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

test('emsMatches: Self = Modus 0 + Stopp; Zwang mit Leistungstoleranz', () => {
  assert.equal(emsMatches({ mode: 0, cmd: 0xcc, powerW: 999 }, { mode: 'self' }), true);
  assert.equal(emsMatches({ mode: 0, cmd: 0xaa, powerW: 0 }, { mode: 'self' }), false);
  assert.equal(emsMatches({ mode: 2, cmd: 0xaa, powerW: 2350 }, { mode: 'forced', command: 'charge', powerW: 2300 }, 100), true);
  assert.equal(emsMatches({ mode: 2, cmd: 0xaa, powerW: 2450 }, { mode: 'forced', command: 'charge', powerW: 2300 }, 100), false);
  assert.equal(emsMatches({ mode: 2, cmd: 0xbb, powerW: 2300 }, { mode: 'forced', command: 'charge', powerW: 2300 }, 100), false);
});

// --- Aktuator ------------------------------------------------------------------------

function rig({ over = {}, device = sungrowDevice(), mockOpts = {}, controlMode = 'forced', heartbeatTimeoutS = 30, statePath = null } = {}) {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode, heartbeatTimeoutS } });
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
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, pushLog: (event, data) => logs.push({ event, data }), now, statePath });
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
  assert.deepEqual(resolveSungrowControl({}), { mode: 'external', modeValue: EMS_MODE.EXTERNAL, heartbeatTimeoutS: 30 });
  assert.equal(resolveSungrowControl({ sungrow: { controlMode: 'forced' } }).modeValue, EMS_MODE.FORCED);
  assert.equal(resolveSungrowControl({ sungrow: { heartbeatTimeoutS: 5 } }).heartbeatTimeoutS, 20);
  assert.equal(resolveSungrowControl({ sungrow: { heartbeatTimeoutS: 1000 } }).heartbeatTimeoutS, 300);
  assert.equal(resolveSungrowControl({ sungrow: { controlMode: 'quatsch' } }).mode, 'external');
  // Ausgeliefert: Profil + Default-Config → External EMS
  assert.equal(resolveSungrowControl(loadSungrowConfig()).mode, 'external');
});

test('External EMS: Leistung → Befehl → Herzschlag (Frist) → Modus 3, Rücklesen inkl. Herzschlag', async () => {
  const r = rig({ controlMode: 'external' });
  const res = await r.ems.applySetpoint(4000, 'rule:netzladen');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [
    [POWER, 2300], [CMD, EMS_CMD.CHARGE], [HB, 30], [MODE, EMS_MODE.EXTERNAL]
  ]);
  assert.deepEqual(r.t.reads.map((x) => [x.fc, x.address]), [[3, HB], [3, MODE], [3, MODE], [3, HB]]);
  assert.equal(r.state.ctrl.sungrowEms.ownMode, EMS_MODE.EXTERNAL);
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
  assert.deepEqual(r.t.reads, [], 'Herzschlag ohne zyklisches Lesen');
  // Sollwert zurück ins Band → Self-consumption (Modus 0), danach kein Herzschlag mehr.
  r.t.writes.length = 0;
  await r.ems.applySetpoint(-40, 'default');
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  r.t.writes.length = 0;
  for (let i = 0; i < 3; i += 1) { r.advance(10_000); r.telemetry(); await r.ems.tick(); }
  assert.deepEqual(r.t.writes, []);
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
    assert.deepEqual(r.t.writes.map((w) => w.address), [POWER, CMD, HB, MODE], 'alles neu, auch was gleich aussieht');
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
  assert.deepEqual(r.t.writes.map((w) => w.address), [POWER, CMD, HB, MODE], 'voller Wiedereintritt');
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
      const r = rig({ controlMode });
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

test('Codex R2: gleichzeitig abgelehnter und angenommener Sollwert — der angenommene bleibt wirksam', async () => {
  const r = evaluatorRig({ optimizer: { allowGridDischarge: true } });
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
  assert.ok(r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.FORCED));
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
    // Standard External EMS: Herzschlag-Register prüfen, Zustand lesen, Leistung → Befehl → Herzschlag 30 s →
    // Modus 3, dann Block und Herzschlag zurücklesen.
    assert.deepEqual(frames.map((f) => [f.fc, f.address, f.arg]), [
      [3, 13079, 1],
      [3, 13049, 3],
      [6, 13051, 310], [6, 13050, 0xaa], [6, 13079, 30], [6, 13049, 3],
      [3, 13049, 3],
      [3, 13079, 1]
    ]);
    assert.deepEqual([image.holding.get(13049), image.holding.get(13050), image.holding.get(13051), image.holding.get(13079)], [3, 0xaa, 310, 30]);
  } finally {
    await transport.destroy();
    await new Promise((r) => server.close(r));
  }
});
