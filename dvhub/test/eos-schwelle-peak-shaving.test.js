// test/eos-schwelle-peak-shaving.test.js — Gegenseite zu EOS-PR D
// (Schwellen-Peak-Shaving, Zweig pr/grid-peak-shaving-threshold): Jede
// Akku-Instruktion von GET /v1/energy-management/plan trägt optional
// `peak_shaving_threshold_w` (W, null = aus). In Slots, in denen der Plan den
// Akku hält, soll der Akku trotzdem genau den Netzbezug über der Schwelle decken.
//
// DVhub hält den Akku über einen POSITIVEN Netz-Sollwert (Regel closedLoopHold,
// schedule-eval „Akku halten“), nicht über 2704 = 0 oder den ESS-Min-SoC. Die
// Schwelle wirkt deshalb als Akku-Hilfe ctx.batteryAssist.request({ source:
// 'eos-threshold', maxImportW }) = Decke des positiven Sollwerts — Victron und
// jedes Profil mit schreibbarem Netz-Sollwert regeln dann den Rest aus dem Akku.
// Echte Bausteine: ausgelieferte Profile, echter Schedule-Evaluator, Wächter.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createScheduleEvaluator } from '../schedule-eval.js';
import { createGridConnectionGuard } from '../services/grid-connection/index.js';
import {
  EOS_PEAK_SHAVING_THRESHOLD_FIELD, peakShavingThresholdW, detectPlanCapabilities
} from '../services/optimizer/eos-capabilities.js';
import { createEosAdapter } from '../services/optimizer/eos-adapter.js';
import { buildScheduleRules } from '../services/optimizer/schedule-builder.js';
import { EOS_THRESHOLD_SOURCE, eosThresholdForRule } from '../services/optimizer/eos-threshold-assist.js';
import { activeWindow } from './helpers/active-window.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

// --- Fähigkeit und Feld ------------------------------------------------------

test('Feldname wie in EOS-PR D', () => {
  assert.equal(EOS_PEAK_SHAVING_THRESHOLD_FIELD, 'peak_shaving_threshold_w');
});

test('peakShavingThresholdW: Zahl ≥ 0 gilt, null/fehlend/ungültig/„aus“ (1 GW) = keine Schwelle', () => {
  assert.equal(peakShavingThresholdW({ peak_shaving_threshold_w: 27600 }), 27600);
  assert.equal(peakShavingThresholdW({ peak_shaving_threshold_w: 8000.4 }), 8000);
  assert.equal(peakShavingThresholdW({ peak_shaving_threshold_w: 0 }), 0);
  assert.equal(peakShavingThresholdW({ peak_shaving_threshold_w: null }), null);
  assert.equal(peakShavingThresholdW({}), null);
  assert.equal(peakShavingThresholdW({ peak_shaving_threshold_w: -1 }), null);
  assert.equal(peakShavingThresholdW({ peak_shaving_threshold_w: 'x' }), null);
  assert.equal(peakShavingThresholdW({ peak_shaving_threshold_w: '' }), null);
  // DVhub hebt EOS' Grenze mit 1 GW auf (EOS_GRID_IMPORT_OFF_W) — das ist aus.
  assert.equal(peakShavingThresholdW({ peak_shaving_threshold_w: 1_000_000_000 }), null);
  assert.equal(peakShavingThresholdW(null), null);
});

test('detectPlanCapabilities: Schlüssel an einer Akku-Instruktion (auch null) = EOS kennt die Schwelle', () => {
  const bat = (extra = {}) => ({ type: 'FRBCInstruction', actuator_id: 'battery1', execution_time: '2026-11-10T12:00:00Z', operation_mode_id: 'IDLE', operation_mode_factor: 1, ...extra });
  assert.equal(detectPlanCapabilities([bat({ peak_shaving_threshold_w: null })]).peakShavingThreshold, true);
  assert.equal(detectPlanCapabilities([bat({ peak_shaving_threshold_w: 8000 })]).peakShavingThreshold, true);
  assert.equal(detectPlanCapabilities([bat()]).peakShavingThreshold, false, 'Vanilla v0.4.0rc3');
  assert.equal(detectPlanCapabilities([{ ...bat({ peak_shaving_threshold_w: 8000 }), actuator_id: 'ev1' }]).peakShavingThreshold, false, 'nur Akku-Instruktionen');
  assert.equal(detectPlanCapabilities(null).peakShavingThreshold, false);
});

// --- Adapter: Plan → Slots → Regeln ----------------------------------------

function mockEos(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = routes[req.url.split('?')[0]];
      if (body === undefined) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

const T0 = Date.parse('2026-11-10T18:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const Q = 15 * 60_000;

function plan({ threshold } = {}) {
  const extra = threshold === undefined ? {} : { peak_shaving_threshold_w: threshold };
  return {
    id: 'plan-d', valid_until: iso(T0 + 4 * Q),
    instructions: [
      { type: 'FRBCInstruction', actuator_id: 'battery1', execution_time: iso(T0), operation_mode_id: 'IDLE', operation_mode_factor: 1, ...extra },
      { type: 'FRBCInstruction', actuator_id: 'battery1', execution_time: iso(T0 + 2 * Q), operation_mode_id: 'GRID_SUPPORT_EXPORT', operation_mode_factor: 1, ...extra },
    ]
  };
}

function solution() {
  const row = (extra) => ({ battery1_soc_factor: 0.6, grid_feedin_energy_wh: 0, ...extra });
  return {
    generated_at: iso(T0 - Q),
    solution: {
      data: {
        // Halten mit Netzbezug 3 kWh/15 min = 12 kW (Haus + E-Auto)
        [iso(T0)]: row({ grid_consumption_energy_wh: 3000, genetic_discharge_allowed_factor: 0, genetic_ac_charge_factor: 0, genetic_ev_charge_factor: 1 }),
        // Netzladen
        [iso(T0 + Q)]: row({ grid_consumption_energy_wh: 2000, genetic_discharge_allowed_factor: 0, genetic_ac_charge_factor: 1 }),
        // Verkauf aus dem Akku
        [iso(T0 + 2 * Q)]: row({ grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 2500, genetic_discharge_allowed_factor: 1, genetic_ac_charge_factor: 0 }),
      }
    },
    prediction: { data: {} }
  };
}

async function adapterRun({ threshold, optimizer = {} } = {}) {
  const m = await mockEos({ '/v1/energy-management/plan': plan({ threshold }), '/v1/energy-management/optimization/solution': solution() });
  const state = { optimizer: {} };
  try {
    const adapter = createEosAdapter({
      state,
      getCfg: () => ({ optimizer: { eosProxy: { url: `http://127.0.0.1:${m.port}` }, eosGridHoldEnabled: true, allowGridCharge: true, gridStorageOnly: true, ruleHorizonHours: 1e6, ...optimizer } }),
      pushLog: () => {}
    });
    const sol = await adapter.getOptimizationSolution(8 * 24 * 4);
    const schedule = await adapter.pullSchedule({ solution: sol });
    const setpoints = await adapter.pullGridSetpoints(undefined, { solution: sol, planSlots: schedule });
    return { schedule, setpoints, state };
  } finally {
    await m.close();
  }
}

test('Adapter: Plan mit Schwelle → jeder Akku-Slot trägt sie, Halte- und Ladeslot bekommen sie mit, Verkauf nicht', async () => {
  const { schedule, setpoints, state } = await adapterRun({ threshold: 11000 });
  assert.ok(schedule.length >= 3);
  assert.ok(schedule.every((s) => s.peakShavingThresholdW === 11000));
  assert.equal(state.optimizer.eosPlan.peakShavingThreshold, true, 'Fähigkeit aus dem Plan erkannt');
  const by = Object.fromEntries(setpoints.map((s) => [s.planAction, s]));
  assert.equal(by.eos_grid_hold.peakShavingThresholdW, 11000);
  assert.equal(by.eos_grid_charge.peakShavingThresholdW, 11000);
  assert.equal(by.eos_grid_export.peakShavingThresholdW, undefined, 'freigegebener Slot unverändert');
});

test('Adapter: Vanilla-EOS (ohne Feld) und Schwelle null → keine Schwelle, Regeln wie bisher', async () => {
  for (const threshold of [undefined, null]) {
    const { schedule, setpoints, state } = await adapterRun({ threshold });
    assert.ok(schedule.every((s) => !('peakShavingThresholdW' in s)));
    assert.ok(setpoints.every((s) => !('peakShavingThresholdW' in s)));
    assert.equal(state.optimizer.eosPlan.peakShavingThreshold, threshold === null);
  }
});

test('Regel: Schwelle landet nur an Sollwert-Regeln im Zeitplan', () => {
  const rules = buildScheduleRules({
    slots: [
      { ts: T0, endTs: T0 + Q, lever: 'gridSetpointW', powerW: 12000, closedLoopHold: true, evPlanned: true, peakShavingThresholdW: 11000, confidence: 0.7 },
      { ts: T0 + Q, endTs: T0 + 2 * Q, lever: 'gridSetpointW', powerW: 8000, confidence: 0.7 },
    ],
    optimizer: 'eos', getCfg: () => ({ schedule: { timezone: 'Europe/Berlin' } })
  });
  assert.equal(rules[0].peakShavingThresholdW, 11000);
  assert.equal('peakShavingThresholdW' in rules[1], false);
});

test('eosThresholdForRule: nur EOS-Regeln, die den Akku halten oder aus dem Netz laden', () => {
  const base = { source: 'forecast_optimizer', optimizer: 'eos', target: 'gridSetpointW', peakShavingThresholdW: 8000 };
  assert.equal(eosThresholdForRule({ ...base, closedLoopHold: true, value: 12000 }), 8000);
  assert.equal(eosThresholdForRule({ ...base, value: 12000 }), 8000, 'Netzladen: Ladung wird bis zur Schwelle zurückgenommen');
  assert.equal(eosThresholdForRule({ ...base, closedLoopExport: true, value: -5000 }), null, 'freigegeben / Verkauf');
  assert.equal(eosThresholdForRule({ ...base, optimizer: 'internal', closedLoopHold: true, value: 12000 }), null);
  assert.equal(eosThresholdForRule({ ...base, source: 'manual', closedLoopHold: true, value: 12000 }), null);
  assert.equal(eosThresholdForRule({ ...base, peakShavingThresholdW: undefined, closedLoopHold: true, value: 12000 }), null);
  assert.equal(eosThresholdForRule(null), null);
});

// --- Steuerung: echter Evaluator + Wächter ------------------------------------

function loadProfileConfig(manufacturer, persisted = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-eos-schwelle-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', `${manufacturer}.json`), path.join(rootDir, 'hersteller', `${manufacturer}.json`));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, updateChannel: 'dev', victron: { host: '192.0.2.10' }, ...persisted }));
  const loaded = loadConfigFile(configPath);
  if (loaded.manufacturerProfileError) throw new Error(loaded.manufacturerProfileError);
  return loaded.effectiveConfig;
}

function holdRule(opts = {}) {
  // „threshold: undefined“ heißt: Regel ohne Feld (Vanilla) — nicht der Standard.
  const { evPlanned = true, closedLoopHold = true, value = 12000 } = opts;
  const threshold = 'threshold' in opts ? opts.threshold : 8000;
  const t = Date.now();
  return {
    id: 'opt-hold', enabled: true, target: 'gridSetpointW', ...activeWindow(), value,
    slotTs: t - 60_000, slotEndTs: t + 14 * 60_000,
    source: 'forecast_optimizer', optimizer: 'eos', autoManaged: true,
    ...(closedLoopHold ? { closedLoopHold: true, evPlanned } : {}),
    ...(threshold === undefined ? {} : { peakShavingThresholdW: threshold })
  };
}

function rig(manufacturer = 'victron', { persisted = {}, rule = holdRule(), load = 12500, pv = 0 } = {}) {
  const cfg = loadProfileConfig(manufacturer, {
    optimizer: { enabled: true, allowGridCharge: true, allowGridDischarge: true, eosGridHoldEnabled: true },
    ...persisted
  });
  const t = Date.now();
  const logs = [];
  const state = {
    victron: {
      soc: 60, batteryPowerW: 0, batteryChargeW: 0, batteryDischargeW: 0, maxDischargeW: -1,
      selfConsumptionW: load, pvTotalW: pv,
      fieldUpdatedAt: { soc: t, batteryPowerW: t, maxDischargeW: t, selfConsumptionW: t, pvTotalW: t }
    },
    meter: { ok: true, updatedAt: t, grid_total_w: -load },
    schedule: { rules: rule ? [rule] : [], active: {}, lastWrite: {}, manualOverride: {}, config: { defaultGridSetpointW: null, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 }, lastEvalAt: 0 },
    ctrl: { negativePriceActive: false, forcedOff: false }
  };
  const transport = manufacturer === 'victron'
    ? { type: 'modbus', writes: [], async mbWriteSingle(w) { this.writes.push({ fc: 6, ...w }); }, async mbWriteMultiple(w) { this.writes.push({ fc: 16, ...w }); }, async mbRequest() { throw new Error('no read'); } }
    : { type: 'mqtt', writes: [], async mqttWrite(target, value) { this.writes.push({ target, value }); return {}; } };
  const pushLog = (event, data) => logs.push({ event, ...data });
  const ctx = { getCfg: () => cfg, state, pushLog };
  const guard = createGridConnectionGuard(ctx);
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport, pushLog, telemetrySafeWrite: () => {},
    persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null,
    regenerateSmallMarketAutomationRules: async () => {}, onEvalComplete: () => {},
    gridConnection: guard, batteryAssist: guard.batteryAssist
  });
  ctx.applyControlTarget = evaluator.applyControlTarget;
  // Netz-Sollwert, wie er geschrieben wurde (Victron Reg. 2716 int32, MQTT gridSetpointW).
  const setpoints = () => (manufacturer === 'victron'
    ? transport.writes.filter((w) => w.address === 2716).map((w) => {
      const [hi, lo] = w.values;
      return ((hi << 16) | lo) | 0;
    })
    : transport.writes.filter((w) => w.target === 'gridSetpointW').map((w) => Number(w.value)));
  return { cfg, state, guard, assist: guard.batteryAssist, evaluator, setpoints, logs, transport };
}

const eosSource = (h) => h.assist.status(EOS_THRESHOLD_SOURCE).sources.find((q) => q.source === EOS_THRESHOLD_SOURCE) || null;

test('Victron: gehaltener Slot mit Schwelle → Akku-Hilfe maxImportW, Sollwert auf die Schwelle gedeckelt', async () => {
  const h = rig('victron');
  await h.evaluator.evaluateSchedule();
  await settle();
  const q = eosSource(h);
  assert.ok(q, 'Anforderung eos-threshold steht');
  assert.equal(q.maxImportW, 8000);
  assert.equal(q.expiresAt, h.state.schedule.rules[0].slotEndTs, 'gilt bis zum Slot-Ende');
  // Ohne Schwelle: 12 500 − 1 000 (E-Auto-Puffer) = 11 500 W Bezug. Mit: 8 000 —
  // die ESS-Regelung holt die übrigen 4,5 kW aus dem Akku.
  assert.deepEqual(h.setpoints(), [8000]);
  assert.equal(h.state.ctrl.eosThreshold.thresholdW, 8000);
  assert.equal(h.state.ctrl.eosThreshold.requested, true);
  // Kachel ohne Netzanschluss-Grenze: Akku-Hilfe für die EOS-Schwelle.
  const sum = h.guard.summary();
  assert.equal(sum.assistOnly, true);
  assert.deepEqual(sum.assistSources, ['eos-threshold']);
  assert.equal(sum.eosThreshold.thresholdW, 8000);
  assert.equal(sum.eosThreshold.requested, true);
  // Keine Writes auf 2714/2715 (AcInputLimit, AlwaysPeakShave) oder 2704.
  assert.deepEqual(h.transport.writes.filter((w) => [2704, 2714, 2715].includes(w.address)), []);
});

test('Vanilla-EOS (Regel ohne Schwelle): keine Anforderung, Halten wie bisher', async () => {
  const h = rig('victron', { rule: holdRule({ threshold: undefined }) });
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.equal(eosSource(h), null);
  assert.deepEqual(h.setpoints(), [11500]);
  assert.equal(h.state.ctrl.eosThreshold ?? null, null);
});

test('Freigegebener Slot (kein Halten, Verkauf): keine Anforderung', async () => {
  const h = rig('victron', { rule: { ...holdRule({ closedLoopHold: false, value: -5000 }), closedLoopExport: true, batteryShareW: 5000 } });
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.equal(eosSource(h), null);
});

test('Not-Halt: keine Anforderung, eine stehende wird zurückgenommen, kein Write', async () => {
  const h = rig('victron');
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.ok(eosSource(h));
  const before = h.transport.writes.length;
  h.state.ctrl.discretionaryWritesPaused = true;
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.equal(eosSource(h), null);
  assert.equal(h.assist.status().sources.length, 0);
  assert.equal(h.transport.writes.length, before, 'im Not-Halt kein Write');
  assert.equal(h.state.ctrl.eosThreshold.requested, false);
  assert.equal(h.state.ctrl.eosThreshold.reason, 'emergency_stop');
});

test('Slot vorbei / Regel weg: Anforderung wird freigegeben', async () => {
  const h = rig('victron');
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.ok(eosSource(h));
  h.state.schedule.rules = [];
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.equal(eosSource(h), null);
  assert.equal(h.state.ctrl.eosThreshold ?? null, null);
});

test('Netzanschluss-Wächter mit gleicher Grenze: keine eigene Anforderung (keine Doppelarbeit), Decke vom Wächter', async () => {
  // DVhub-Grenze 9,0 kW, Abstand 1 kW → Ziel 8 000 W = die Schwelle, die EOS
  // aus eosGridImportLimitW bekommen hat.
  const h = rig('victron', { persisted: { gridConnection: { limitKw: 9 } } });
  h.guard.tick();
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.equal(eosSource(h), null, 'der Wächter deckt dieselbe Grenze schon in jedem Slot');
  assert.deepEqual(h.setpoints(), [8000]);
  assert.equal(h.state.ctrl.eosThreshold.thresholdW, 8000);
  assert.equal(h.state.ctrl.eosThreshold.requested, false);
  assert.equal(h.state.ctrl.eosThreshold.coveredBy, 'grid-connection');
  const sum = h.guard.summary();
  assert.deepEqual(sum.assistSources, []);
  assert.equal(sum.eosThreshold.coveredBy, 'grid-connection');
  // Im Not-Halt zeigt die Kachel keine EOS-Zeile.
  h.state.ctrl.discretionaryWritesPaused = true;
  assert.equal(h.guard.summary().eosThreshold, null);
});

test('Netzanschluss-Wächter lockerer als die Plan-Schwelle: Schwelle gilt (strengstes Ziel)', async () => {
  const h = rig('victron', { persisted: { gridConnection: { limitKw: 20 } } });
  h.guard.tick();
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.equal(eosSource(h)?.maxImportW, 8000);
  assert.deepEqual(h.setpoints(), [8000]);
});

test('§14a-Akku-Hilfe gleichzeitig: strengstes Ziel gewinnt, beide Quellen bleiben getrennt', async () => {
  const h = rig('victron');
  h.assist.request({ source: 'p14a', maxImportW: 6000 });
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.deepEqual(h.assist.status().sources.map((q) => q.source).sort(), ['eos-threshold', 'p14a']);
  assert.deepEqual(h.setpoints(), [6000]);
  h.state.schedule.rules = [];
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.deepEqual(h.assist.status().sources.map((q) => q.source), ['p14a'], 'Freigabe nimmt nur die eigene Anforderung zurück');
});

test('Nicht-Victron mit Netz-Sollwert (bridge-mqtt): gleiche Decke über den Sollwert', async () => {
  const h = rig('bridge-mqtt');
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.equal(eosSource(h)?.maxImportW, 8000);
  assert.deepEqual(h.setpoints(), [8000]);
});

test('Profil ohne steuerbaren Akku (Fronius): keine Anforderung — DVhub kann dort nicht halten', async () => {
  const h = rig('fronius');
  await h.evaluator.evaluateSchedule();
  await settle();
  assert.equal(eosSource(h), null);
  assert.equal(h.state.ctrl.eosThreshold?.requested ?? false, false);
});

// --- Leitstand ---------------------------------------------------------------

test('Leitstand: „EOS: Akku deckt über X kW“', async () => {
  const file = path.join(__dirname, '..', 'public', 'grid-connection-view.js');
  const sandbox = { window: {}, document: undefined };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'grid-connection-view.js' });
  const { view } = sandbox.window.DVhubGridConnection;
  const base = { enabled: true, active: true, limitW: 9000, targetW: 8000, importW: 8000, battery: { text: 'x' }, text: null };
  const v = view({ ...base, eosThreshold: { thresholdW: 8000, requested: false, coveredBy: 'grid-connection' } });
  assert.equal(v.eosThreshold, 'EOS: Akku deckt über 8,0 kW');
  assert.match(v.detail, /EOS: Akku deckt über 8,0 kW/);
  const off = view(base);
  assert.equal(off.eosThreshold, null);
  assert.equal(off.detail, 'Keine Begrenzung nötig.');
  // Nur die EOS-Schwelle fordert an (keine Netzanschluss-Grenze): eine Zeile, kein Doppel.
  const only = view({ enabled: true, assistOnly: true, assist: null, assistSources: ['eos-threshold'], battery: { text: 'x' },
    text: 'EOS-Schwelle: Akku-Hilfe angefordert', eosThreshold: { thresholdW: 8000, requested: true } });
  assert.equal(only.detail, 'EOS: Akku deckt über 8,0 kW');
  const helping = view({ enabled: true, assistOnly: true, assist: { helpW: 4500 }, assistSources: ['eos-threshold'], battery: { text: 'x' },
    text: 'EOS-Schwelle: Akku hilft mit 4,5 kW (über den Netz-Sollwert)', eosThreshold: { thresholdW: 8000, requested: true } });
  assert.equal(helping.detail, 'EOS-Schwelle: Akku hilft mit 4,5 kW (über den Netz-Sollwert) · EOS: Akku deckt über 8,0 kW');
  // Im Not-Halt keine EOS-Zeile.
  assert.equal(view({ ...base, paused: true, eosThreshold: { thresholdW: 8000, requested: false } }).eosThreshold, null);
});
