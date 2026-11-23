// A26 (Christin 24.11.2026, „A26 a“): die übrigen Verbraucher, die noch eigene Wanduhr-Alter oder -Fristen rechneten,
// messen Abstände monoton — mit den Erzeuger-Marken aus A24, wo es um die Frische eines Messwerts geht. Zeitpunkte
// (Anzeige, Historie, Datenbank, API) bleiben Systemzeit. Jeder Test hier war vor A26 rot (Wanduhrsprung ±3 h zwischen
// Messung/Start und Prüfung änderte das Ergebnis).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { monoNow, stampMono } from '../services/mono-clock.js';
import { createGridShareTracker, gridShareBatteryUncertain } from '../services/optimizer/grid-share.js';
import { createGridSharePollTick } from '../services/optimizer/grid-share-poll.js';
import { createScheduleEvaluator } from '../schedule-eval.js';
import { fileURLToPath } from 'node:url';
import { loadConfigFile } from '../config-model.js';
import {
  createGridConnectionGuard, victronLimitExtra, phaseVoltagesFromState, ASSIST_REQUEST_MAX_AGE_MS,
} from '../services/grid-connection/index.js';
import { meterImport } from '../services/import-limit/core.js';
import { createFreezeWatchdog } from '../services/telemetry-freeze-watchdog.js';
import { monoStampAge, monoStampOf, monoDeadlinePassed } from '../services/mono-clock.js';
import { compareSources, resolveCrossCheckOptions } from '../services/mqtt-crosscheck.js';
import { createMypvRegulator } from '../services/devices/mypv-regulator.js';
import { computeManagedLoad } from '../managed-load.js';
import { createTeslamateSubscriber } from '../services/mqtt/teslamate.js';
import { buildDataflow } from '../services/dataflow.js';
import { liveSnapshotStale } from '../telemetry-runtime.js';
import { createTelemetryWriteBuffer } from '../runtime-performance.js';
import { createGridVoltagePoller } from '../services/grid-voltage.js';
import { createMqttTransport } from '../transport-mqtt.js';
import { createDvLimitController, LUOX_WATCHDOG_MS } from '../dv-interface-luox.js';
import { activeDischargeHold } from '../services/setpoint-follow-watchdog.js';
import { createEvChargingProbe } from '../services/wallbox/ev-charging.js';

const H3 = 3 * 3_600_000;

function clocks(wall0 = 1_800_000_000_000, mono0 = 10_000) {
  const c = { wall: wall0, mono: mono0 };
  c.now = () => c.wall;
  c.monoNow = () => c.mono;
  c.tick = (ms) => { c.wall += ms; c.mono += ms; };
  c.jump = (ms) => { c.wall += ms; };
  return c;
}

// Wanduhr global verstellen (Date.now), die echte monotone Uhr läuft weiter.
async function withWallOffset(offsetMs, fn) {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  try { return await fn(); } finally { Date.now = real; }
}

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-a26-'));

// --- Netzstrom-Zähler (services/optimizer/grid-share.js) ------------------------------------------------------------

const GS_CFG = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } };
const CHARGE = { gridToBatteryW: 12_000, gridImportW: 12_000 };

function gsRun(jumpMs) {
  const dir = mkDir();
  try {
    const c = clocks(Date.parse('2026-11-24T10:00:00Z'));
    const t = createGridShareTracker({ getCfg: () => GS_CFG, pushLog: () => {}, dataDir: dir, monoNow: c.monoNow });
    const step = () => t.tick({ nowMs: c.wall, monoMs: c.mono, victron: CHARGE, socPct: 50, capacityWh: 77_000 });
    step();
    for (let i = 0; i < 6; i += 1) { c.tick(10_000); step(); } // 60 s Netzladung mit 12 kW
    c.jump(jumpMs); c.tick(10_000); step();                      // Uhrsprung, dann 10 s weiter
    return t.summary(c.wall).gridWh;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Netzstrom-Zähler: Sprung vorwärts (+3 h) bucht keine 60 s Phantom-Netzladung', () => {
  assert.ok(Math.abs(gsRun(H3) - 12_000 * 70 / 3600) < 0.5, `70 s × 12 kW = 233 Wh, nicht 400 Wh: ${gsRun(H3)}`);
});

test('Netzstrom-Zähler: Rücksprung (−3 h) verschluckt den Schritt nicht', () => {
  assert.ok(Math.abs(gsRun(-H3) - 12_000 * 70 / 3600) < 0.5, `70 s × 12 kW = 233 Wh, nicht 200 Wh: ${gsRun(-H3)}`);
});

test('Netzstrom-Zähler (Poll-Pfad ohne Zeitangabe): Sprung vorwärts zwischen zwei Abfragen bucht nur die Laufzeit', async () => {
  const dir = mkDir();
  try {
    const t = createGridShareTracker({ getCfg: () => GS_CFG, pushLog: () => {}, dataDir: dir });
    const pollTick = createGridSharePollTick({ gridShare: t, getCfg: () => ({ ...GS_CFG, optimizer: { ...GS_CFG.optimizer, batteryCapacityWh: 77_000 } }), state: { victron: { soc: 50 } } });
    pollTick({ ...CHARGE, soc: 50 });
    const before = t.summary().gridWh;
    await withWallOffset(H3, async () => {
      await new Promise((r) => setTimeout(r, 20));
      pollTick({ ...CHARGE, soc: 50 });
    });
    assert.ok(t.summary().gridWh - before < 5, `nur ~20 ms Laufzeit gezählt, nicht 60 s (200 Wh): ${t.summary().gridWh - before}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Netzstrom-Zähler: Akkuwerte-Alter aus der Erzeuger-Marke — Rücksprung macht einen stehenden SoC unsicher', () => {
  const v = { fieldUpdatedAt: { soc: Date.now() + H3, batteryPowerW: Date.now() + H3 } };
  stampMono(v.fieldUpdatedAt, 'soc', { at: monoNow() - 120_000 });
  stampMono(v.fieldUpdatedAt, 'batteryPowerW');
  assert.deepEqual(gridShareBatteryUncertain(v, { maxAgeMs: 90_000 }), ['soc_stale']);
});

test('Netzstrom-Zähler: Empfangsalter (fieldSourceAt) aus der Marke — Sprung vorwärts lässt frische Werte sicher', () => {
  const v = { fieldUpdatedAt: {}, fieldSourceAt: { soc: Date.now() - H3, batteryPowerW: Date.now() - H3 } };
  stampMono(v.fieldSourceAt, 'soc');
  stampMono(v.fieldSourceAt, 'batteryPowerW');
  assert.deepEqual(gridShareBatteryUncertain(v, { maxAgeMs: 90_000 }), []);
});

// --- Deckel bei gesperrtem Akku: Empfangsprüfung sourceStale (schedule-eval gridShareLiveCapW) ----------------------

function capCtx(mutate, { locked = true, cfgMutate, transportExtra = {} } = {}) {
  const writes = [];
  const now = Date.now();
  const state = {
    victron: {
      soc: 60, batteryDischargeW: 0, batteryChargeW: 0, batteryPowerW: 0, pvTotalW: 6_000, pvPowerW: 0, selfConsumptionW: 1_000,
      fieldUpdatedAt: { soc: now, pvTotalW: now, pvPowerW: now, selfConsumptionW: now },
    },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: { defaultGridSetpointW: -100 }, lastEvalAt: 0 },
    ctrl: { negativePriceActive: false, forcedOff: false },
    epex: { data: [] },
  };
  const cfg = {
    controlWrite: { gridSetpointW: { enabled: true, address: 100 }, chargeCurrentA: { enabled: false } },
    dvControl: { enabled: false, negativePriceProtection: { enabled: true } },
    optimizer: { enabled: true, allowGridCharge: true, gridChargeWithoutMispel: true, allowGridDischarge: true },
    dcExportMode: {},
    schedule: { timezone: 'Europe/Berlin', manualOverrideTtlMs: 300000, controlKeepaliveMs: 0, defaultGridSetpointW: -100, smallMarketAutomation: { enabled: false } },
  };
  mutate(state);
  cfgMutate?.(cfg);
  const ctx = {
    state, getCfg: () => cfg,
    transport: { type: 'mqtt', mqttWrite: async (target, value) => { writes.push({ target, value }); }, ...transportExtra },
    pushLog: () => {}, telemetrySafeWrite: (fn) => { try { fn?.(); } catch { /* no-op */ } }, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => ({ current: { ct_kwh: 12, eur_mwh: 120 }, next: null }),
    regenerateSmallMarketAutomationRules: async () => {}, onEvalComplete: () => {},
    gridShare: { isLocked: () => locked },
  };
  return { evaluator: createScheduleEvaluator(ctx), writes, state };
}
const gridWrites = (writes) => writes.filter((w) => w.target === 'gridSetpointW').map((w) => w.value);

test('Deckel (gesperrter Akku): Rücksprung — ein vor 120 s empfangener PV-Wert gilt als alt, nur der Puffer', async () => {
  const { evaluator, writes } = capCtx((state) => {
    state.victron.fieldSourceAt = { pvTotalW: Date.now() + H3 }; // Empfang vor dem Rücksprung
    stampMono(state.victron.fieldSourceAt, 'pvTotalW', { at: monoNow() - 120_000 });
  });
  await evaluator.applyControlTarget('gridSetpointW', -5000, 'eos_optimization');
  assert.deepEqual(gridWrites(writes), [-100]);
});

test('Deckel (gesperrter Akku): Sprung vorwärts — ein eben empfangener PV-Wert bleibt frisch, Überschuss darf raus', async () => {
  const { evaluator, writes } = capCtx((state) => {
    state.victron.fieldSourceAt = { pvTotalW: Date.now() - H3, selfConsumptionW: Date.now() - H3 }; // Empfang vor dem Sprung
    stampMono(state.victron.fieldSourceAt, 'pvTotalW');
    stampMono(state.victron.fieldSourceAt, 'selfConsumptionW');
  });
  await evaluator.applyControlTarget('gridSetpointW', -5000, 'eos_optimization');
  const [w] = gridWrites(writes);
  assert.ok(w < -1000, `PV-Überschuss statt nur Puffer: ${w}`);
});

// --- Keepalive des Netz-Sollwerts (schedule-eval applyControlTarget) ------------------------------------------------
// 2716 hat einen Venus-Watchdog: bleibt der Keepalive aus, fällt der Multi in Passthru. Vor A26 rechnete der Abstand
// mit der Wanduhr — nach einem Rücksprung (−3 h) setzte der Keepalive drei Stunden lang aus.

test('Keepalive: Rücksprung (−3 h) — derselbe Sollwert wird nach keepaliveMs Laufzeit trotzdem neu geschrieben', async () => {
  const { evaluator, writes } = capCtx(() => {}, { locked: false, cfgMutate: (cfg) => { cfg.schedule.controlKeepaliveMs = 30; } });
  await evaluator.applyControlTarget('gridSetpointW', 500, 'eos_optimization');
  assert.equal(gridWrites(writes).length, 1);
  await withWallOffset(-H3, async () => {
    await new Promise((r) => setTimeout(r, 60));
    await evaluator.applyControlTarget('gridSetpointW', 500, 'eos_optimization');
  });
  assert.deepEqual(gridWrites(writes), [500, 500], 'Keepalive geschrieben');
});

test('Keepalive: Sprung vorwärts (+3 h) — kein vorzeitiger Keepalive vor keepaliveMs Laufzeit', async () => {
  const { evaluator, writes } = capCtx(() => {}, { locked: false, cfgMutate: (cfg) => { cfg.schedule.controlKeepaliveMs = 60_000; } });
  await evaluator.applyControlTarget('gridSetpointW', 500, 'eos_optimization');
  await withWallOffset(H3, () => evaluator.applyControlTarget('gridSetpointW', 500, 'eos_optimization'));
  assert.deepEqual(gridWrites(writes), [500], 'gehalten, kein zweiter Write');
});

// --- Netzanschluss-Wächter (services/grid-connection, import-limit/core meterImport) --------------------------------

test('Victron-Grenze 2714: Rücksprung — eine vor 6 min gelesene Grenze gilt nicht mehr (5 min Frist, Laufzeit)', () => {
  const state = { victron: { acInputLimitA: 40, fieldUpdatedAt: { acInputLimitA: Date.now() + H3 } } };
  stampMono(state.victron.fieldUpdatedAt, 'acInputLimitA', { at: monoNow() - 6 * 60_000 });
  assert.equal(victronLimitExtra(state, Date.now(), { manufacturer: 'victron' }).victronPhaseLimitA, null);
});

test('Victron-Grenze 2714: Sprung vorwärts — eine eben gelesene Grenze gilt weiter, Alter ≈ 0', () => {
  const state = { victron: { acInputLimitA: 40, fieldUpdatedAt: { acInputLimitA: Date.now() - H3 } } };
  stampMono(state.victron.fieldUpdatedAt, 'acInputLimitA');
  const x = victronLimitExtra(state, Date.now(), { manufacturer: 'victron' });
  assert.equal(x.victronPhaseLimitA, 40);
  assert.ok(x.victronLimitAgeMs < 1000, `Alter ${x.victronLimitAgeMs}`);
});

test('Phasenspannung: Rücksprung — eine vor 3 min gemessene Spannung gilt nicht mehr (2 min Frist)', () => {
  const gv = { l1: 235, l2: 236, l3: 237, updatedAt: Date.now() + H3 };
  stampMono(gv, 'updatedAt', { at: monoNow() - 3 * 60_000 });
  assert.equal(phaseVoltagesFromState({ victron: { gridVoltage: gv } }), null);
  const gv2 = { l1: 235, l2: 236, l3: 237, updatedAt: Date.now() - H3 };
  stampMono(gv2, 'updatedAt');
  assert.deepEqual(phaseVoltagesFromState({ victron: { gridVoltage: gv2 } }), [235, 236, 237], 'Sprung vorwärts: frisch');
});

test('Zähler (meterImport): Rücksprung — ein 100 s alter Netzwert ist veraltet, Sprung vorwärts — ein frischer nicht', () => {
  const old = { meter: { ok: true, updatedAt: Date.now() + H3, grid_total_w: 1000 } };
  stampMono(old.meter, 'updatedAt', { at: monoNow() - 100_000 });
  assert.equal(meterImport(old, {}, { maxAgeMs: 90_000 }).reason, 'meter_stale');
  const fresh = { meter: { ok: true, updatedAt: Date.now() - H3, sourceAt: Date.now() - H3, grid_total_w: 1000 } };
  stampMono(fresh.meter, 'updatedAt');
  stampMono(fresh.meter, 'sourceAt', { at: monoNow() - 5000 });
  const m = meterImport(fresh, {}, { maxAgeMs: 90_000 });
  assert.equal(m.fresh, true);
  assert.ok(m.ageMs >= 5000 && m.ageMs < 6000, 'älterer Stempel (Empfang) zählt');
});

const here = path.dirname(fileURLToPath(import.meta.url));
function profileCfg(manufacturer) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-a26-gc-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(here, '..', 'hersteller', `${manufacturer}.json`), path.join(rootDir, 'hersteller', `${manufacturer}.json`));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, updateChannel: 'dev', victron: { host: '192.0.2.10' }, optimizer: { allowGridCharge: true } }));
  return loadConfigFile(configPath).effectiveConfig;
}

function assistGuard(c) {
  const cfg = profileCfg('bridge-mqtt');
  const state = { victron: {}, meter: {}, schedule: { lastWrite: {}, active: {} }, ctrl: {} };
  return createGridConnectionGuard({ getCfg: () => cfg, state, pushLog: () => {} }, { now: c.now, monoNow: c.monoNow });
}

test('Akku-Hilfe-Anforderung: Rücksprung — verfällt nach 120 s Laufzeit ohne Erneuerung', () => {
  const c = clocks();
  const g = assistGuard(c);
  assert.equal(g.batteryAssist.request({ source: 'p14a', maxImportW: 4000 }).ok, true);
  c.jump(-H3); c.tick(ASSIST_REQUEST_MAX_AGE_MS + 1000);
  assert.deepEqual(g.batteryAssist.status().sources, []);
});

test('Akku-Hilfe-Anforderung: Sprung vorwärts — untilMs gilt nach Restzeit, nicht nach Wanduhr', () => {
  const c = clocks();
  const g = assistGuard(c);
  assert.equal(g.batteryAssist.request({ source: 'p14a', maxImportW: 4000, untilMs: c.wall + 600_000 }).ok, true);
  c.jump(H3); c.tick(1000);
  assert.equal(g.batteryAssist.status().sources.length, 1, 'noch 599 s Restzeit');
  c.tick(600_000);
  assert.deepEqual(g.batteryAssist.status().sources, []);
});

// --- Einfrier-Wächter (services/telemetry-freeze-watchdog.js) -------------------------------------------------------

function freezeRig(c) {
  const state = { meter: { ok: true, updatedAt: 0, grid_total_w: -1000 }, victron: { soc: 60, batteryPowerW: 2000, pvTotalW: 3000, fieldUpdatedAt: {} } };
  const logs = [];
  let dropped = 0;
  const wd = createFreezeWatchdog({
    state, monoNow: c.monoNow,
    getCfg: () => ({ updateChannel: 'dev', victron: { freezeWatchdog: { enabled: true, freezeMs: 60_000, minSamples: 10, reconnectMs: 30_000 } }, optimizer: { batteryCapacityWh: 60000 } }),
    transport: { type: 'modbus', dropConnections: () => { dropped += 1; return 1; } },
    pushLog: (event, details, level) => logs.push({ event, details, level }),
    notificationService: { sendDirect: async () => ({ sent: 1 }) }, monitoringAlertPush: () => Promise.resolve(),
  });
  let i = 0;
  const poll = (frozen) => {
    i += 1;
    state.meter.ok = true;
    state.meter.updatedAt = c.wall;
    state.meter.grid_total_w = frozen ? -1000 : -1000 - i;
    state.victron.batteryPowerW = frozen ? 2000 : 2000 + i;
    state.victron.pvTotalW = frozen ? 3000 : 3000 + i;
    state.victron.fieldUpdatedAt = { soc: c.wall, batteryPowerW: c.wall, pvPowerW: c.wall };
    for (const f of ['soc', 'batteryPowerW', 'pvPowerW']) stampMono(state.victron.fieldUpdatedAt, f, { clock: c.monoNow });
    wd.tick(c.wall, c.mono);
  };
  return { state, logs, poll, dropped: () => dropped };
}

test('Einfrier-Wächter: Sprung vorwärts (+3 h) mitten in 30 s gleicher Werte → kein Fehlalarm', () => {
  const c = clocks();
  const r = freezeRig(c);
  for (let k = 0; k < 20; k += 1) { r.poll(false); c.tick(1000); }
  for (let k = 0; k < 15; k += 1) { r.poll(true); c.tick(1000); }
  c.jump(H3);
  for (let k = 0; k < 15; k += 1) { r.poll(true); c.tick(1000); }
  assert.equal(r.state.victron.freeze, null, '30 s Laufzeit < freezeMs 60 s');
  assert.equal(r.logs.filter((l) => l.level === 'critical').length, 0);
});

test('Einfrier-Wächter: Rücksprung (−3 h) — eingefrorene Werte werden nach 60 s Laufzeit erkannt und monoton zurückdatiert', () => {
  const c = clocks();
  const r = freezeRig(c);
  for (let k = 0; k < 20; k += 1) { r.poll(false); c.tick(1000); }
  r.poll(true); c.tick(1000);
  c.jump(-H3);
  for (let k = 0; k < 80; k += 1) { r.poll(true); c.tick(1000); }
  assert.equal(r.state.victron.freeze?.active, true, 'erkannt trotz Rücksprung');
  assert.ok(r.state.victron.freeze.stalledForMs >= 60_000 && r.state.victron.freeze.stalledForMs < 120_000, `${r.state.victron.freeze.stalledForMs}`);
  const age = monoStampAge(r.state.victron.fieldUpdatedAt, 'batteryPowerW', c.monoNow);
  assert.ok(age >= 60_000, `zurückdatierter Stempel ist monoton alt: ${age}`);
  assert.equal(r.dropped(), 1, 'ein Neuaufbau');
});

// --- Kreuzprobe MQTT ↔ Modbus (services/mqtt-crosscheck.js compareSources) ------------------------------------------

test('Kreuzprobe: Sprung vorwärts (+3 h) — 5 s Widerspruch sind kein anhaltender (sustainMs 180 s)', () => {
  const opts = resolveCrossCheckOptions({});
  const c = clocks();
  const mem = { fields: {}, active: false, since: null };
  const run = () => compareSources({ soc: 50 }, { soc: 70 }, mem, opts, c.wall, c.mono);
  run();
  c.jump(H3); c.tick(5000);
  assert.deepEqual(run().mismatches, []);
});

test('Kreuzprobe: Rücksprung (−3 h) — ein anhaltender Widerspruch meldet nach 180 s Laufzeit', () => {
  const opts = resolveCrossCheckOptions({});
  const c = clocks();
  const mem = { fields: {}, active: false, since: null };
  const run = () => compareSources({ soc: 50 }, { soc: 70 }, mem, opts, c.wall, c.mono);
  run();
  c.jump(-H3); c.tick(181_000);
  const r = run();
  assert.equal(r.transition, 'mismatch');
  assert.equal(r.mismatches[0].seitMs, 181_000);
});

// --- my-PV-Heizstab (services/devices/mypv-regulator.js) ------------------------------------------------------------

function heaterRig(c) {
  const writes = [];
  const state = { meter: { ok: true, updatedAt: c.wall }, victron: { gridExportW: 9000, gridImportW: 0, batteryDischargeW: 0, soc: 60 }, ctrl: {}, optimizer: {} };
  const cfg = { devices: [{ id: 'heizstab', name: 'Heizstab', kind: 'modulating', schedulable: true, plan: { maxPowerW: 9000, intervalS: 5 }, endpoint: { type: 'mypv', host: '192.0.2.20' } }] };
  const reg = createMypvRegulator({
    getCfg: () => cfg, state, now: c.now, monoNow: c.monoNow,
    createClient: () => ({ read: async () => ({ powerW: 0, deviceOn: true }), writePower: async (w) => { writes.push(w); return w; }, close() {} }),
  });
  return { reg, writes, state };
}

test('my-PV: Rücksprung (−3 h) — der Regeltakt läuft nach intervalS Laufzeit weiter (Power-Timeout des Geräts)', async () => {
  const c = clocks();
  const h = heaterRig(c);
  await h.reg.tick();
  const n = h.writes.length;
  c.jump(-H3); c.tick(5000); h.state.meter.updatedAt = c.wall;
  await h.reg.tick();
  assert.equal(h.writes.length, n + 1, 'nächster Takt geschrieben');
});

test('my-PV: Messwert-Alter aus der Poller-Marke — Rücksprung, Zählerwert 60 s alt → Heizstab aus', async () => {
  const c = clocks();
  const h = heaterRig(c);
  h.state.meter.updatedAt = c.wall + H3; // vor dem Rücksprung gelesen
  stampMono(h.state.meter, 'updatedAt', { clock: c.monoNow, at: c.mono - 60_000 });
  await h.reg.tick();
  assert.deepEqual(h.writes, [0], 'keine aktuellen Messwerte → 0 W');
});

// --- TeslaMate / Lastbereinigung (services/mqtt/teslamate.js, managed-load.js) --------------------------------------

test('TeslaMate: Empfangsstempel tragen die monotone Marke (nur live empfangene Felder)', async () => {
  let handler = null;
  const hub = { subscribe: (_t, fn) => { handler = fn; }, unsubscribe() {} };
  const sub = createTeslamateSubscriber(hub, { getCfg: () => ({ integrations: { tesla: { enabled: true } } }), pushLog: () => {} });
  await sub.start();
  const before = monoNow();
  handler('teslamate/cars/1/charger_power', Buffer.from('10.7'));
  const stamps = sub.getFieldUpdatedAt();
  const m = monoStampOf(stamps, 'chargerPower');
  assert.ok(m != null && m >= before, 'monotone Empfangsmarke');
  assert.doesNotMatch(JSON.stringify(stamps), /mono/i);
  sub.close?.();
});

test('Lastbereinigung: Sprung vorwärts (+3 h) — eben empfangene Ladedaten gelten als frisch', () => {
  const at = new Date(Date.now() - H3); // vor dem Sprung empfangen
  const stamps = { chargingState: at, geofence: at, chargerPower: at };
  for (const k of Object.keys(stamps)) stampMono(stamps, k);
  const r = computeManagedLoad({
    loadW: 12_000, tesla: { chargingState: 'Charging', geofence: 'Zuhause', chargerPower: 10.7 }, teslaUpdatedAt: stamps,
    nowMs: Date.now(), monoNow,
  });
  assert.equal(r.applied, true, r.reason);
  assert.equal(r.evW, 10_700);
});

test('Lastbereinigung: Rücksprung (−3 h) — 10 s vor dem Sprung empfangene Ladedaten gelten weiter, 10 min alte nicht', () => {
  const tesla = { chargingState: 'Charging', geofence: 'Zuhause', chargerPower: 10.7 };
  const at = new Date(Date.now() + H3); // vor dem Rücksprung empfangen: Stempel liegt jetzt „in der Zukunft“
  const stamps = (agoMs) => {
    const s = { chargingState: at, geofence: at, chargerPower: at };
    for (const k of Object.keys(s)) stampMono(s, k, { at: monoNow() - agoMs });
    return s;
  };
  const fresh = computeManagedLoad({ loadW: 12_000, tesla, teslaUpdatedAt: stamps(10_000), nowMs: Date.now(), monoNow });
  assert.equal(fresh.applied, true, `frisch trotz Stempel in der Zukunft: ${fresh.reason}`);
  const old = computeManagedLoad({ loadW: 12_000, tesla, teslaUpdatedAt: stamps(600_000), nowMs: Date.now(), monoNow });
  assert.equal(old.reason, 'ev_charging_state_stale');
});

// --- Datenfluss-Anzeige (services/dataflow.js) und Historie (telemetry-runtime liveSnapshotStale) --------------------

test('Datenfluss: Alter der Messpunkte aus der Poller-Marke — Rücksprung zeigt 120 s und „veraltet“', () => {
  const state = { victron: { soc: 55, fieldUpdatedAt: { soc: Date.now() + H3 } }, meter: { ok: true, updatedAt: Date.now() + H3, grid_total_w: 100 } };
  stampMono(state.victron.fieldUpdatedAt, 'soc', { at: monoNow() - 120_000 });
  stampMono(state.meter, 'updatedAt', { at: monoNow() - 120_000 });
  const df = buildDataflow({ cfg: { points: { soc: { enabled: true } } }, state, transport: { type: 'modbus' }, now: Date.now() });
  const soc = df.in.inputs.find((r) => r.key === 'soc');
  const meter = df.in.inputs.find((r) => r.key === 'meter');
  assert.ok(soc.ageMs >= 120_000 && soc.ageMs < 125_000, `soc ${soc.ageMs}`);
  assert.equal(soc.fresh, false);
  assert.ok(meter.ageMs >= 120_000, `meter ${meter.ageMs}`);
});

test('Historie (liveSnapshotStale): Rücksprung zwischen Feld- und Zählerstempel — 100 s alter Akkuwert ist veraltet', () => {
  const meterAt = Date.now();
  const meter = { ok: true, updatedAt: meterAt };
  stampMono(meter, 'updatedAt');
  const victron = { fieldUpdatedAt: { batteryPowerW: meterAt + H3 } }; // vor dem Rücksprung gelesen
  stampMono(victron.fieldUpdatedAt, 'batteryPowerW', { at: monoNow() - 100_000 });
  assert.equal(liveSnapshotStale({ ts: new Date(meterAt).toISOString(), meter, victron }), true);
});

test('Historie (liveSnapshotStale): Sprung vorwärts — eben gelesener Akkuwert bleibt frisch', () => {
  const meterAt = Date.now();
  const meter = { ok: true, updatedAt: meterAt };
  stampMono(meter, 'updatedAt');
  const victron = { fieldUpdatedAt: { batteryPowerW: meterAt - H3 } };
  stampMono(victron.fieldUpdatedAt, 'batteryPowerW');
  assert.equal(liveSnapshotStale({ ts: new Date(meterAt).toISOString(), meter, victron }), false);
});

test('Historie (Schreibpuffer): Sprung vorwärts — der Probenabstand bleibt die Laufzeit, nicht 3 h', () => {
  const c = clocks();
  const rows = [];
  const buf = createTelemetryWriteBuffer({
    flushIntervalMs: 5000, now: c.now, monoNow: c.monoNow,
    buildSamples: (snap) => [{ ts: snap.ts, resolutionSeconds: snap.resolutionSeconds }],
    writeSamples: (r) => rows.push(...r),
  });
  buf.capture({ ts: c.wall, resolutionSeconds: 5 }); buf.flush();
  c.jump(H3); c.tick(5000);
  buf.capture({ ts: c.wall, resolutionSeconds: 5 }); buf.flush();
  assert.deepEqual(rows.map((r) => r.resolutionSeconds), [5, 5]);
});

// --- Netzspannung (services/grid-voltage.js, transport-mqtt Spannungs-/Alarm-Zwischenspeicher) ----------------------

const GRID_REGS = { 2616: 2382, 2617: 142, 2618: 2371, 2619: 139, 2620: 2374, 2644: 4998 };
function gxRegs() {
  let reads = 0;
  const mbRequest = async ({ address, quantity }) => {
    reads += 1;
    return Array.from({ length: quantity }, (_, i) => GRID_REGS[address + i] ?? 0);
  };
  return { mbRequest, reads: () => reads };
}

test('Netzspannung (Modbus): Rücksprung (−3 h) setzt die Abfrage nicht aus — nächster Lesetakt nach Laufzeit', async () => {
  const c = clocks();
  const gx = gxRegs();
  const st = { meter: { consecutiveErrors: 0 }, victron: { errors: {} } };
  const poller = createGridVoltagePoller({ state: st, getTransport: () => ({ type: 'modbus', mbRequest: gx.mbRequest }), now: c.now, monoNow: c.monoNow, firstDelayMs: 0 });
  const cfg = { manufacturer: 'victron', victron: { host: 'gx', port: 502, unitId: 100 }, meter: {} };
  await poller.onPoll(cfg);
  const n = gx.reads();
  assert.ok(n > 0);
  c.jump(-H3); c.tick(10 * 60_000);
  await poller.onPoll(cfg);
  assert.ok(gx.reads() > n, 'erneut gelesen');
  assert.equal(monoStampOf(st.victron.gridVoltage, 'updatedAt', c.monoNow), c.mono, 'Messzeit monoton markiert');
});

function venus(staleMaxAgeMs = 90_000) {
  return createMqttTransport({ host: 'gx', mqtt: { portalId: 'p1', staleMaxAgeMs } }, { connectFn: () => ({ on() {}, end() {} }) });
}
const mqttMsg = (t, topic, v) => t._onMessage(topic, Buffer.from(JSON.stringify({ value: v })), { retain: false });

test('MQTT-Netzspannung: Sprung vorwärts (+3 h) — eben empfangene Spannung bleibt frisch, Marke reist mit', async () => {
  const t = venus();
  mqttMsg(t, 'N/p1/grid/30/Ac/L1/Voltage', 231);
  await withWallOffset(H3, () => {
    const g = t.readGridVoltage();
    assert.equal(g?.l1, 231);
    assert.ok(Number.isFinite(g.monoTs) && !Object.keys(g).includes('monoTs'));
  });
});

test('MQTT-Alarme: Sprung vorwärts (+3 h) — eben empfangene Alarmwerte gelten weiter', async () => {
  const t = venus();
  mqttMsg(t, 'N/p1/vebus/276/Alarms/HighTemperature', 0);
  await withWallOffset(H3, () => {
    assert.ok(t.getAlarmValues(90_000), 'nicht veraltet');
  });
});

test('MQTT-Alarme: Rücksprung (−3 h) — stehende Alarmwerte veralten nach maxAgeMs Laufzeit', async () => {
  const t = venus();
  mqttMsg(t, 'N/p1/vebus/276/Alarms/HighTemperature', 0);
  await withWallOffset(-H3, async () => {
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(t.getAlarmValues(20), null);
  });
});

// --- LUOX-Watchdog (dv-interface-luox.js) -------------------------------------------------------------------------

test('LUOX: Rücksprung nach dem Watchdog — volle Abregelung endet 15 min nach dem Watchdog (Laufzeit), nicht 3 h später', () => {
  const c = clocks();
  const state = { ctrl: { forcedOff: false, offUntil: 0 } };
  const dv = createDvLimitController({
    state, getCfg: () => ({ dvInterface: { profile: 'luox' }, optimizer: { inverterMaxPowerW: 10000 }, controlWrite: { dvFeedInLimitW: { enabled: true } }, userEnergyPricing: { pvPlants: [{ kwp: 10 }] } }),
    setForcedOff: (_r, { until }) => { state.ctrl.forcedOff = true; state.ctrl.offUntil = until; stampMono(state.ctrl, 'offUntil', { clock: c.monoNow, wallNow: c.wall }); },
    clearForcedOff: () => { state.ctrl.forcedOff = false; }, applyDvFeedInLimit: async () => {},
    now: c.now, monoNow: c.monoNow,
  });
  dv.watchdogRefresh();
  c.jump(-H3); c.tick(60_000);
  dv.setDvLimitPct(0, 'luox');
  c.tick(LUOX_WATCHDOG_MS - 60_000 + 1000);
  assert.equal(monoDeadlinePassed(state.ctrl, 'offUntil', c.monoNow), true, '15 min nach dem Watchdog abgelaufen');
});

// --- Halte-/Deckel-Signale (setpoint-follow-watchdog activeDischargeHold) -------------------------------------------

test('Halte-Signal eosGridHold: Sprung vorwärts (+3 h) — ein eben gesetztes Signal gilt weiter', () => {
  const hold = { at: Date.now() - H3, known: true, valueW: 0 };
  stampMono(hold, 'at');
  assert.equal(activeDischargeHold({ ctrl: { eosGridHold: hold } }, Date.now(), {}, monoNow), 'eos_grid_hold');
});

test('Deckel-Signal (Peak Shaving): Sprung vorwärts — ein eben gesetzter Deckel auf den Halte-Wert hebt das Halten auf', () => {
  const hold = { at: Date.now(), known: true, valueW: 0 };
  stampMono(hold, 'at');
  const clamp = { source: 'eos_grid_hold', requestedW: 2000, valueW: 1000, at: Date.now() - H3 };
  stampMono(clamp, 'at');
  assert.equal(activeDischargeHold({ ctrl: { eosGridHold: hold, _peakShaving: { clamp } } }, Date.now(), {}, monoNow), null);
});

// --- evcc-Frische (ev-charging; dieselbe Marke nutzen Netzanschluss-Wächter und §14a) ------------------------------

test('evcc: Sprung vorwärts (+3 h) — eine eben empfangene Antwort ist frisch (Wallbox lädt)', async () => {
  const status = { url: 'http://evcc', lastPolledAt: Date.now() - H3, loadpoints: [{ charging: true, chargePowerW: 7400 }] };
  stampMono(status, 'lastPolledAt');
  const probe = createEvChargingProbe({ getCfg: () => ({ wallbox: { type: 'evcc' } }), evccIntegration: { getStatus: () => status } });
  assert.equal(await probe(), true);
});

// --- Rücklese-Prüfung (schedule-eval controlWriteVerify lastRunAt) --------------------------------------------------

test('Rücklese-Prüfung: Rücksprung (−3 h) — der nächste Verify kommt nach minIntervalMs Laufzeit, nicht 3 h später', async () => {
  let verifies = 0;
  const { evaluator, state } = capCtx(() => {}, {
    locked: false,
    cfgMutate: (cfg) => { cfg.schedule.controlWriteVerify = { enabled: true, delayMs: 5, minIntervalMs: 60 }; },
    transportExtra: { readPointSince: async () => { verifies += 1; return { mqttValue: state.schedule.lastWrite.gridSetpointW?.value }; } },
  });
  await evaluator.applyControlTarget('gridSetpointW', 500, 'eos_optimization');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(verifies, 1);
  await withWallOffset(-H3, async () => {
    await evaluator.applyControlTarget('gridSetpointW', 600, 'eos_optimization');
    await new Promise((r) => setTimeout(r, 150));
  });
  assert.equal(verifies, 2, 'zweiter Verify nach Laufzeit');
});
