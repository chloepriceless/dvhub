// Victron device-alarm banner — pure decode/build/payload + poller integration.
//
// Read-only DISPLAY feature: VE.Bus + Battery/BMS alarm registers → sticky GUI
// banner. The control/telemetry path must be untouched. Register semantics are
// from the official victronenergy/dbus_modbustcp attributes.csv (verified at the
// live Cerbo 2026-06-18: VE.Bus=unit229, Battery=unit225, all alarms 0).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decodeAlarmValue,
  buildActiveAlarms,
  buildVictronAlarmsPayload,
  maxSeverity,
  VEBUS_BLOCK,
  BATTERY_BLOCK
} from '../victron-alarms.js';
import { createPoller } from '../polling.js';
import { loadConfigFile } from '../config-model.js';
import { buildVictronSnapshot } from '../runtime-state.js';

// ── helpers ──────────────────────────────────────────────────────────────────
function vebusBlock(overrides = {}) {
  const b = new Array(VEBUS_BLOCK.count).fill(0);
  for (const [addr, val] of Object.entries(overrides)) b[Number(addr) - VEBUS_BLOCK.start] = val;
  return b;
}
function batteryBlock(overrides = {}) {
  const b = new Array(BATTERY_BLOCK.count).fill(0);
  for (const [addr, val] of Object.entries(overrides)) b[Number(addr) - BATTERY_BLOCK.start] = val;
  return b;
}

// ── decodeAlarmValue ─────────────────────────────────────────────────────────
test('decodeAlarmValue: ova maps 0/1/2 → sev 0/1/2', () => {
  const e = { kind: 'ova' };
  assert.deepEqual(decodeAlarmValue(e, 0), { severity: 0, active: false, text: null });
  assert.deepEqual(decodeAlarmValue(e, 1), { severity: 1, active: true, text: null });
  assert.deepEqual(decodeAlarmValue(e, 2), { severity: 2, active: true, text: null });
});

test('decodeAlarmValue: na is 0=ok / non-zero=alarm(sev2)', () => {
  const e = { kind: 'na' };
  assert.equal(decodeAlarmValue(e, 0).severity, 0);
  assert.equal(decodeAlarmValue(e, 2).severity, 2);
});

test('decodeAlarmValue: pre maps 1→warn(sev1), 2→alarm(sev2)', () => {
  const e = { kind: 'pre' };
  assert.equal(decodeAlarmValue(e, 1).severity, 1);
  assert.equal(decodeAlarmValue(e, 2).severity, 2);
});

test('decodeAlarmValue: bool non-zero → alarm(sev2)', () => {
  assert.equal(decodeAlarmValue({ kind: 'bool' }, 1).severity, 2);
  assert.equal(decodeAlarmValue({ kind: 'bool' }, 0).severity, 0);
});

test('decodeAlarmValue: vebusError 0=ok, known code → sev2 + text, unknown → generic text', () => {
  assert.deepEqual(decodeAlarmValue({ kind: 'vebusError' }, 0), { severity: 0, active: false, text: null });
  const known = decodeAlarmValue({ kind: 'vebusError' }, 5);
  assert.equal(known.severity, 2);
  assert.equal(known.text, 'Überspannung an AC-Ausgang');
  const unknown = decodeAlarmValue({ kind: 'vebusError' }, 99);
  assert.equal(unknown.severity, 2);
  assert.equal(unknown.text, 'Fehler-Code 99');
});

// ── buildActiveAlarms ────────────────────────────────────────────────────────
test('buildActiveAlarms: all-zero blocks → no active alarms (healthy plant)', () => {
  const out = buildActiveAlarms({ vebus: vebusBlock(), battery: batteryBlock() }, [], 1_000_000);
  assert.deepEqual(out, []);
});

test('buildActiveAlarms: VE.Bus HighTemperature(34)=2 → one sev2 alarm, correct index/label/unit', () => {
  const now = 1_700_000_000_000;
  const out = buildActiveAlarms({ vebus: vebusBlock({ 34: 2 }), battery: batteryBlock() }, [], now);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'vebus.highTemp');
  assert.equal(out[0].severity, 2);
  assert.equal(out[0].unit, 'vebus');
  assert.equal(out[0].label, 'Wechselrichter: Übertemperatur');
  assert.equal(out[0].since, new Date(now).toISOString());
});

test('buildActiveAlarms: index correctness for far register GridLost(64) + battery Alarm(267)', () => {
  const out = buildActiveAlarms({ vebus: vebusBlock({ 64: 2 }), battery: batteryBlock({ 267: 2 }) }, [], 1);
  const keys = out.map((a) => a.key).sort();
  assert.deepEqual(keys, ['batt.alarm', 'vebus.gridLost']);
});

test('buildActiveAlarms: severity sort — alarm(sev2) before warning(sev1)', () => {
  // BmsPreAlarm(94)=1 (warn) + Overload(36)=2 (alarm)
  const out = buildActiveAlarms({ vebus: vebusBlock({ 94: 1, 36: 2 }), battery: null }, [], 1);
  assert.equal(out[0].severity, 2);
  assert.equal(out[1].severity, 1);
});

test('buildActiveAlarms: null block contributes nothing (read failure / absent unit)', () => {
  const out = buildActiveAlarms({ vebus: null, battery: batteryBlock({ 274: 2 }) }, [], 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].unit, 'battery');
});

test('buildActiveAlarms: `since` latches across polls (first-seen timestamp preserved)', () => {
  const oldSince = '2020-01-01T00:00:00.000Z';
  const prev = [{ key: 'vebus.highTemp', since: oldSince }];
  const out = buildActiveAlarms({ vebus: vebusBlock({ 34: 2 }), battery: null }, prev, 1_700_000_000_000);
  assert.equal(out[0].since, oldSince, 'existing alarm keeps its first-seen timestamp');
});

// ── buildVictronAlarmsPayload (read-side staleness) ──────────────────────────
test('buildVictronAlarmsPayload: not configured → no banner, not "OK"', () => {
  const p = buildVictronAlarmsPayload({ configured: false }, Date.now(), 30000);
  assert.equal(p.configured, false);
  assert.deepEqual(p.active, []);
  assert.equal(p.stale, false);
  assert.equal(p.severity, 0);
});

test('buildVictronAlarmsPayload: fresh read → not stale, severity from active', () => {
  const now = 1_700_000_000_000;
  const p = buildVictronAlarmsPayload(
    { configured: true, active: [{ key: 'x', severity: 2 }], updatedAt: new Date(now).toISOString() },
    now, 30000
  );
  assert.equal(p.stale, false);
  assert.equal(p.severity, 2);
});

test('buildVictronAlarmsPayload: old updatedAt (> 3× interval) → stale', () => {
  const now = 1_700_000_000_000;
  const old = new Date(now - 200000).toISOString(); // 200 s > max(90s, 90s)
  const p = buildVictronAlarmsPayload({ configured: true, active: [], updatedAt: old }, now, 30000);
  assert.equal(p.stale, true);
});

test('buildVictronAlarmsPayload: missing updatedAt → stale (never successfully read)', () => {
  const p = buildVictronAlarmsPayload({ configured: true, active: [], updatedAt: null }, Date.now(), 30000);
  assert.equal(p.stale, true);
});

test('maxSeverity: picks the highest', () => {
  assert.equal(maxSeverity([{ severity: 1 }, { severity: 2 }, { severity: 0 }]), 2);
  assert.equal(maxSeverity([]), 0);
});

// ── poller integration ───────────────────────────────────────────────────────
function makePoller(alarmsCfg, logs = []) {
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null, consecutiveErrors: 0 },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-06-18', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  const transport = {
    type: 'modbus',
    failMeter: false,
    failAlarms: false,
    vebus: vebusBlock(),
    battery: batteryBlock(),
    mbRequest: async function ({ address, quantity }) {
      if (address === VEBUS_BLOCK.start && quantity === VEBUS_BLOCK.count) {
        if (this.failAlarms) throw new Error('vebus alarm read timeout');
        return this.vebus;
      }
      if (address === BATTERY_BLOCK.start && quantity === BATTERY_BLOCK.count) {
        if (this.failAlarms) throw new Error('battery alarm read timeout');
        return this.battery;
      }
      if (this.failMeter) throw new Error('meter timeout');
      return [50, 50, 50];
    }
  };
  const cfg = {
    pollMs: 500,
    gridPositiveMeans: 'feed_in',
    meter: { host: '127.0.0.1', port: 502, unitId: 1, fc: 3, address: 0, quantity: 3 },
    points: { soc: { enabled: true, fc: 4, address: 843, quantity: 1, signed: false, scale: 1, offset: 0 } },
    epex: { timezone: 'UTC' },
    userEnergyPricing: {},
    dvControl: {},
    victron: { host: '127.0.0.1', port: 502, alarms: alarmsCfg }
  };
  const poller = createPoller({
    state, getCfg: () => cfg, transport,
    pushLog: (event, payload) => { logs.push({ event, payload }); },
    energyPath: '/tmp/victron-alarms-test.json', onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } })
  });
  return { state, poller, transport, logs };
}

test('poller: configured + active alarm → state.victron.alarms populated', async () => {
  const { state, poller, transport } = makePoller({ enabled: true, pollIntervalMs: 30000, timeoutMs: 1500, vebusUnitId: 229, batteryUnitId: 225 });
  transport.vebus = vebusBlock({ 35: 2 }); // LowBattery alarm
  await poller.requestPoll();
  assert.equal(state.victron.alarms.configured, true);
  assert.equal(state.victron.alarms.active.length, 1);
  assert.equal(state.victron.alarms.active[0].key, 'vebus.lowBattery');
  assert.ok(state.victron.alarms.updatedAt, 'updatedAt stamped on successful read');
});

test('poller: throttle — a second immediate poll does NOT re-read alarms', async () => {
  const { state, poller, transport } = makePoller({ enabled: true, pollIntervalMs: 30000, timeoutMs: 1500, vebusUnitId: 229, batteryUnitId: 225 });
  transport.vebus = vebusBlock(); // healthy
  await poller.requestPoll();
  assert.deepEqual(state.victron.alarms.active, []);
  // change the device state, then poll again immediately — throttle must skip the read
  transport.vebus = vebusBlock({ 36: 2 });
  await poller.requestPoll();
  assert.deepEqual(state.victron.alarms.active, [], 'throttled: alarms unchanged within pollIntervalMs');
});

test('poller: ISOLATION — alarm-read failure never touches control telemetry', async () => {
  const { state, poller, transport } = makePoller({ enabled: true, pollIntervalMs: 30000, timeoutMs: 1500, vebusUnitId: 229, batteryUnitId: 225 });
  transport.failAlarms = true; // alarm block reads throw; meter + soc succeed
  await poller.requestPoll();
  assert.equal(state.meter.ok, true, 'meter read unaffected by alarm failure');
  assert.equal(state.victron.soc, 50, 'soc point unaffected');
  assert.equal(state.meter.consecutiveErrors, 0, 'alarm failure does NOT bump control backoff');
  assert.equal(state.victron.alarms.configured, true);
  assert.ok(!state.victron.alarms.updatedAt, 'failed alarm cycle does NOT stamp updatedAt (→ read-side flags stale)');
});

test('poller: not configured (null unit ids) → alarms.configured=false (no banner, not OK)', async () => {
  const { state, poller } = makePoller({ enabled: true, pollIntervalMs: 30000, timeoutMs: 1500, vebusUnitId: null, batteryUnitId: null });
  await poller.requestPoll();
  assert.equal(state.victron.alarms.configured, false);
  assert.deepEqual(state.victron.alarms.active, []);
});

test('poller: MQTT transport → alarm poll guarded out (no block reads attempted)', async () => {
  const { state, poller, transport } = makePoller({ enabled: true, pollIntervalMs: 30000, timeoutMs: 1500, vebusUnitId: 229, batteryUnitId: 225 });
  transport.type = 'mqtt';
  transport.getCached = () => 0;
  transport.readPoint = async () => ({ mqttValue: 50 });
  await poller.requestPoll();
  assert.equal(state.victron.alarms, undefined, 'MQTT transport: pollVictronAlarms returns before touching state');
});

// ── T-ALARM-POLL-V2 (2026-07-22): adaptive Kadenz ────────────────────────────
// Die VE.Bus/BMS-Blockreads laufen über das single-threaded dbus-modbustcp des
// GX — auf einem beschäftigten Venus können sie den CONTROL-Pfad aushungern
// (Root Cause der Modbus-Burst-Regression ab 12.07. auf der Operator-Box).
// Alarm-Banner sind Minuten-Information und müssen IMMER nachgeben.
test('T-ALARM-POLL-V2 Health-Gate: laufende Control-Fehler → Alarm-Reads komplett ausgesetzt', async () => {
  const { state, poller, transport } = makePoller({ enabled: true, pollIntervalMs: 30000, timeoutMs: 1500, vebusUnitId: 229, batteryUnitId: 225 });
  transport.failMeter = true; // Control-Telemetrie scheitert → consecutiveErrors > 0
  transport.vebus = vebusBlock({ 35: 2 }); // Alarm läge an — darf aber nicht gelesen werden
  await poller.requestPoll();
  assert.ok(state.meter.consecutiveErrors > 0, 'Vorbedingung: Control-Poll ist am Fehlern');
  assert.equal(state.victron.alarms, undefined,
    'Health-Gate: kein Alarm-Read solange der Control-Pfad leidet');
  // Das Gate zählt das Fenster als bedient: auch nach Erholung ist der nächste
  // Versuch ein volles Intervall entfernt (kein Sofort-Nachholen als Burst).
  transport.failMeter = false;
  await poller.requestPoll();
  assert.equal(state.victron.alarms, undefined,
    'nach Erholung kein Sofort-Read — volles Intervall Abstand');
});

test('T-ALARM-POLL-V2 Failure-Backoff: fehlgeschlagener Zyklus eskaliert das Intervall + loggt EINMAL', async () => {
  const { state, poller, transport, logs } = makePoller({ enabled: true, pollIntervalMs: 30000, timeoutMs: 1500, vebusUnitId: 229, batteryUnitId: 225 });
  transport.failAlarms = true;
  await poller.requestPoll();
  const backoff = logs.filter((l) => l.event === 'victron_alarm_poll_backoff');
  assert.equal(backoff.length, 1, 'genau eine Backoff-Logzeile pro Eskalationsstufe');
  // Basis = max(60 s, konfigurierte 30 s) = 60 s; erste Stufe = +5 min Floor.
  assert.equal(backoff[0].payload.nextIntervalMs, 60000 + 300000,
    'erste Stufe: Basis 60 s + Floor 5 min');
  assert.equal(state.victron.alarms.configured, true, 'Fehlzyklus markiert configured, stampt aber kein updatedAt');
  assert.ok(!state.victron.alarms.updatedAt, 'kein stale "all clear"');
});

// ── full config-load path (manufacturer profile merge) ───────────────────────
// Regression for the live-deploy gap: victron config is rebuilt from the
// manufacturer profile (hersteller/victron.json); only operator-settable parts
// (host, alarms) are carried from the persisted config. The earlier poller tests
// hand-build cfg.victron.alarms and would NOT catch alarms being dropped by the
// profile merge — so assert it through loadConfigFile().
function withProfileFixture(persistedVictron, profileAlarms) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-victron-alarms-cfg-'));
  const manuDir = path.join(rootDir, 'hersteller');
  fs.mkdirSync(manuDir, { recursive: true });
  const profileVictron = { transport: 'modbus', port: 502, unitId: 100, timeoutMs: 1000 };
  if (profileAlarms !== undefined) profileVictron.alarms = profileAlarms;
  fs.writeFileSync(path.join(manuDir, 'victron.json'), JSON.stringify({
    victron: profileVictron,
    meter: { fc: 4, address: 820, quantity: 3 },
    points: { soc: { enabled: true, fc: 4, address: 843, quantity: 1, signed: false, scale: 1, offset: 0 } }
  }));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'victron', victron: persistedVictron }));
  return loadConfigFile(configPath).effectiveConfig;
}

test('loadConfigFile: persisted victron.alarms unit-ids SURVIVE the profile merge (live-deploy gap)', () => {
  const eff = withProfileFixture(
    { host: 'cerbo.local', alarms: { vebusUnitId: 229, batteryUnitId: 225 } },
    { enabled: true, pollIntervalMs: 30000, timeoutMs: 1500, vebusUnitId: null, batteryUnitId: null }
  );
  assert.equal(eff.victron.alarms.vebusUnitId, 229, 'persisted vebusUnitId must survive applyManufacturerProfile');
  assert.equal(eff.victron.alarms.batteryUnitId, 225);
  assert.equal(eff.victron.alarms.enabled, true, 'profile default fills the rest');
  assert.equal(eff.victron.alarms.pollIntervalMs, 30000);
});

test('loadConfigFile: no persisted alarms → profile default (feature present but inactive)', () => {
  const eff = withProfileFixture(
    { host: 'cerbo.local' },
    { enabled: true, pollIntervalMs: 30000, timeoutMs: 1500, vebusUnitId: null, batteryUnitId: null }
  );
  assert.equal(eff.victron.alarms.enabled, true);
  assert.equal(eff.victron.alarms.vebusUnitId, null, 'no unit-ids → inactive (no banner), safe default');
});

// ── IPC snapshot whitelist (split-process) ───────────────────────────────────
// The poller runs in a separate runtime-worker process; state.victron crosses to
// the web process via buildVictronSnapshot (a field whitelist). `alarms` MUST be
// whitelisted or payload.victron.alarms is dropped and the banner is permanently
// empty in split-process mode — the live-deploy gap.
test('buildVictronSnapshot: carries state.victron.alarms across the IPC snapshot', () => {
  const snap = buildVictronSnapshot({
    soc: 50,
    alarms: { configured: true, active: [{ key: 'vebus.highTemp', severity: 2, since: '2026-06-18T00:00:00.000Z' }], updatedAt: '2026-06-18T00:00:01.000Z' }
  });
  assert.ok(snap.alarms, 'alarms must survive the victron snapshot whitelist');
  assert.equal(snap.alarms.configured, true);
  assert.equal(snap.alarms.active[0].key, 'vebus.highTemp');
  assert.equal(snap.alarms.active[0].severity, 2);
});
