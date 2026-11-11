// Sungrow (T-0422): jede EOS-Betriebsart und DVhub-Funktion aus der Tabelle in docs/SUNGROW-BETA.md gegen
// Mock-Modbus — über DVhubs vorhandene Schiedsrichter (applyControlTarget mit EEG-Tor, Netzanschluss-/
// Schwellen-/§14a-Decke über ctx.gridConnection.batteryCeilingW, SoC-Boden, DV-Sequenz, Einspeisegrenze).
// Der Sungrow-Aktuator sitzt hinter diesen Toren; geprüft wird, was am Ende in 13050–13052/13074–13088 steht.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';
import { enforcementPath } from '../services/feed-in-cap/index.js';
import { resolveBatteryLever } from '../services/grid-connection/index.js';
import { EMS_CMD, EMS_MODE, wire } from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const MODE = wire(13050);
const CMD = wire(13051);
const POWER = wire(13052);
const HB = wire(13080);

/**
 * Echter Evaluator mit ausgeliefertem Profil (Standard External EMS). Telemetrie: Haus `loadW`, PV `pvW`,
 * Akku `batteryW` (Laden +), Netz daraus (Bezug +). ceilingW = Decke von Netzanschluss/§14a/EOS-Schwelle.
 */
function rig({ persisted = {}, loadW = 800, pvW = 0, batteryW = null, ceilingW = null, soc = 60 } = {}) {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', ...persisted });
  const image = sungrowImage();
  const t = mockSungrow(image);
  const now = Date.now();
  const bat = batteryW ?? Math.max(-10000, pvW - loadW);
  const state = {
    victron: {
      soc, batteryPowerW: bat, pvPowerW: pvW, selfConsumptionW: loadW, errors: {},
      fieldUpdatedAt: { soc: now, batteryPowerW: now, pvPowerW: now, selfConsumptionW: now },
      device: sungrowDevice()
    },
    meter: { ok: true, updatedAt: now, grid_total_w: Math.round(loadW - pvW + bat) },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: {}
  };
  const logs = [];
  const ctx = {
    state, getCfg: () => cfg, transport: t, pushLog: (event, data) => logs.push({ event, data }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => ({ current: { ct_kwh: 10 } })
  };
  if (ceilingW != null) ctx.gridConnection = { batteryCeilingW: () => ceilingW, summary: () => null };
  const evaluator = createScheduleEvaluator(ctx);
  const ems = () => state.ctrl.sungrowEms;
  const forcedWrites = () => t.writes.filter((w) => w.address === MODE).map((w) => w.value);
  return { cfg, image, t, state, evaluator, logs, ems, forcedWrites };
}

// --- EOS-Betriebsarten -----------------------------------------------------------------------

test('EOS SELF_CONSUMPTION / keine Regel: Standard-Puffer −40 W → Wechselrichter regelt selbst (Modus 0)', async () => {
  const r = rig();
  const res = await r.evaluator.applyControlTarget('gridSetpointW', -40, 'default');
  assert.equal(res.ok, true);
  assert.equal(r.ems().decision.mode, 'self');
  assert.deepEqual(r.t.writes, [], 'steht schon in Self-consumption');
});

test('EOS NON_EXPORT / IDLE (Akku halten, Netz deckt die Last): nie aus dem Netz laden, auch ohne Netzlade-Freigabe', async () => {
  // Haus 1500 W, PV 0, Akku entlädt 1500 → Sollwert Last − PV − Puffer = 1400 (schedule-eval, eos_grid_hold).
  const r = rig({ loadW: 1500, batteryW: -1500 });
  const res = await r.evaluator.applyControlTarget('gridSetpointW', 1400, 'eos_grid_hold');
  assert.equal(res.ok, true, 'eos_grid_hold ist vom Netzlade-Tor ausgenommen');
  // P = −1500 + 0,7 · (1400 − 0) = −520 → Entladen 520 W, External EMS
  assert.deepEqual([r.ems().decision.command, r.ems().decision.powerW], ['discharge', 520]);
  assert.deepEqual(r.forcedWrites(), [EMS_MODE.EXTERNAL]);
  assert.ok(!r.t.writes.some((w) => w.address === CMD && w.value === EMS_CMD.CHARGE));
});

test('EOS FORCED_CHARGE / GRID_SUPPORT_IMPORT (Netzladen mit Faktor): nur mit Freigabe, sonst Self-consumption', async () => {
  const blocked = rig();
  const no = await blocked.evaluator.applyControlTarget('gridSetpointW', 3000, 'eos_grid_charge');
  assert.equal(no.error, 'grid_charge_not_allowed');
  assert.deepEqual(blocked.t.writes, []);
  const r = rig({ persisted: { optimizer: { allowGridCharge: true } } });
  const res = await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'eos_grid_charge');
  assert.equal(res.ok, true);
  // Haus 800 aus dem Akku: P = −800 + 0,7 · 3000 = 1300 → Laden 1300 W (wächst im Takt zum Ziel)
  assert.deepEqual([r.ems().decision.command, r.ems().decision.powerW], ['charge', 1300]);
});

test('EOS GRID_SUPPORT_EXPORT (Akku ins Netz): nur mit Freigabe Netzentladung; begrenzt auf die BDC-Leistung', async () => {
  const blocked = rig();
  const no = await blocked.evaluator.applyControlTarget('gridSetpointW', -4000, 'eos_optimization');
  assert.equal(no.error, 'grid_discharge_not_allowed');
  assert.deepEqual(blocked.t.writes, []);
  const r = rig({ persisted: { optimizer: { allowGridDischarge: true } } });
  await r.evaluator.applyControlTarget('gridSetpointW', -20000, 'eos_optimization');
  assert.equal(r.ems().decision.command, 'discharge');
  assert.equal(r.ems().decision.powerW, 10000, 'BDC 10 kW');
});

test('EOS PV-Überschuss einspeisen (dcExportMode): Laden nur aus PV, kein Akku ins Netz', async () => {
  // PV 6 kW, Haus 1 kW, Akku lädt 5 kW. Sollwert −(PV − Puffer) ≈ −4900 (Quelle dc_export_mode).
  const r = rig({ loadW: 1000, pvW: 6000, batteryW: 5000 });
  await r.evaluator.applyControlTarget('gridSetpointW', -4900, 'dc_export_mode');
  // P = 5000 + 0,7 · (−4900 − 0) = 1570 → Laden 1570 W (≤ PV-Überschuss 5000), Rest geht ins Netz.
  assert.deepEqual([r.ems().decision.command, r.ems().decision.powerW], ['charge', 1570]);
});

test('EOS PEAK_SHAVING mit peak_shaving_threshold_w / Netzanschluss / §14a: Decke senkt den Netzbezug, Akku deckt den Rest', async () => {
  // Netzladen 6 kW gewünscht, Decke (Schwelle bzw. Netzanschluss bzw. §14a-Budget) 4 kW.
  const r = rig({ persisted: { optimizer: { allowGridCharge: true } }, ceilingW: 4000 });
  const res = await r.evaluator.applyControlTarget('gridSetpointW', 6000, 'eos_grid_charge');
  assert.equal(res.ok, true);
  assert.equal(r.ems().target.setpointW, 4000, 'Aktuator bekommt den gedeckelten Wert');
  assert.ok(r.logs.some((l) => l.event === 'grid_connection_clamp'));
  // „Akku halten“ unter der Schwelle: Last 7 kW, Decke 4 kW → der Akku entlädt den Überschuss über 4 kW.
  const h = rig({ loadW: 7000, batteryW: 0, ceilingW: 4000 });
  await h.evaluator.applyControlTarget('gridSetpointW', 6900, 'eos_grid_hold');
  assert.equal(h.ems().target.setpointW, 4000);
  // Netz jetzt 7000: P = 0 + 0,7 · (4000 − 7000) = −2100 → Entladen 2100 W (nähert sich 3000 W im Takt)
  assert.deepEqual([h.ems().decision.command, h.ems().decision.powerW], ['discharge', 2100]);
  // Der Netzanschluss-Wächter erkennt den nachgebildeten Sollwert als Akku-Hebel („Akku zuerst“).
  assert.equal(resolveBatteryLever(h.cfg).setpoint, true);
});

// --- DVhub-Funktionen ----------------------------------------------------------------------

test('DV-Abregelung (Direktvermarkter) und §51 bei negativem Preis: Einspeisebegrenzung 0, Akku-Steuerung bleibt', async () => {
  for (const reason of ['dv_forced_off', 'negative_price_protection']) {
    const r = rig({ persisted: { optimizer: { allowGridDischarge: true } } });
    await r.evaluator.applyControlTarget('gridSetpointW', -40, reason === 'negative_price_protection' ? reason : 'default');
    await r.evaluator.applyDvVictronControl(false, { reason });
    assert.equal(r.state.ctrl._lastDvFeedIn, false, reason);
    assert.equal(r.image.holding.get(wire(13074)), 0);
    assert.equal(r.image.holding.get(wire(13087)), 0xaa);
    assert.equal(r.image.holding.get(MODE), EMS_MODE.SELF, 'Sollwert −40 → Self-consumption');
  }
});

test('Feste Einspeisegrenze (60/70 %/W) und DV-Teilvorgabe/EEBUS LPP: kein Begrenzer im Profil → Gerät-Einstellung gilt, DVhub überwacht', () => {
  const cfg = loadSungrowConfig();
  assert.equal(enforcementPath(cfg, 'modbus'), 'unsupported', 'feedInCap: Grenze im Wechselrichter, DVhub überwacht');
  assert.equal(cfg.controlWrite.dvFeedInLimitW, undefined, 'Teilvorgaben fallen auf die volle Sperre zurück (sichere Seite)');
});

test('SoC-Boden: unbekannter/alter SoC hält jede Entladung an (0 W → Self-consumption)', async () => {
  const r = rig({ persisted: { optimizer: { allowGridDischarge: true } }, soc: 3 });
  await r.evaluator.applyControlTarget('gridSetpointW', -4000, 'eos_optimization');
  assert.ok(r.logs.some((l) => l.event === 'control_discharge_floor'));
  assert.equal(r.ems().decision.mode, 'self');
  assert.deepEqual(r.t.writes, []);
});

test('Not-Halt im laufenden EOS-Export: einmal Self-consumption, danach weder Sollwert noch Herzschlag', async () => {
  const r = rig({ persisted: { optimizer: { allowGridDischarge: true } } });
  await r.evaluator.applyControlTarget('gridSetpointW', -4000, 'eos_optimization');
  assert.equal(r.image.holding.get(MODE), EMS_MODE.EXTERNAL);
  r.t.writes.length = 0;
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 31;
  await r.evaluator.sungrowEms.emergencyStop();
  assert.deepEqual(r.t.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  r.t.writes.length = 0;
  assert.equal((await r.evaluator.applyControlTarget('gridSetpointW', -4000, 'eos_optimization')).blocked, true);
  await r.evaluator.sungrowEms.tick();
  assert.ok(!r.t.writes.some((w) => w.address === HB || w.address === MODE));
});

test('E-Auto/Geräte: eigene Stellglieder; ihre Last zieht der Regler beim nächsten Takt mit (kein eigener Eingriff)', async () => {
  // Netzladen 3 kW läuft; Wallbox startet mit 7 kW → Netz 3000 + 7000. Der Regler nimmt die Ladung zurück
  // und entlädt für die Wallbox, bis das Netz wieder beim Sollwert ist — Wallbox selbst wird nicht berührt.
  const r = rig({ persisted: { optimizer: { allowGridCharge: true } }, loadW: 7800, batteryW: 2200 });
  r.state.meter.grid_total_w = 10000;
  await r.evaluator.applyControlTarget('gridSetpointW', 3000, 'eos_grid_charge');
  // P = 2200 + 0,7 · (3000 − 10000) = −2700 → Entladen 2700 W (Netto-Last 7800 erlaubt)
  assert.deepEqual([r.ems().decision.command, r.ems().decision.powerW], ['discharge', 2700]);
  assert.ok(r.t.writes.every((w) => [POWER, CMD, MODE, HB].includes(w.address)), 'nur Sungrow-EMS-Register');
});
