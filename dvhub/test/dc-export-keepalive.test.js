// Review Regelung 25.10. (P2): Im dcExportMode schrieb DVhub den Netz-Sollwert
// nur bei > 50 W Änderung oder nach 60 s neu; der Keepalive der normalen
// Schleife (schedule.controlKeepaliveMs, Standard 5 s) wurde übersprungen.
// Reg 2716 ist flüchtig — Victron fällt ohne Auffrischung binnen 60 s auf
// Passthru zurück. Bei gleichmäßiger PV kam die Auffrischung erst nach ~65 s.
// Fahren: ECHTES Victron-Profil (loadConfigFile) + echter Evaluator.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createScheduleEvaluator } from '../schedule-eval.js';
import { activeWindow } from './helpers/active-window.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function victronCfg() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-dcka-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', 'victron.json'), path.join(rootDir, 'hersteller', 'victron.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'victron', victron: { host: '192.0.2.10' } }));
  const cfg = loadConfigFile(configPath).effectiveConfig;
  cfg.dvControl = { ...cfg.dvControl, enabled: false };
  cfg.optimizer = { ...cfg.optimizer, enabled: true, allowGridCharge: false, allowGridDischarge: true, hardFloorSocPct: 5 };
  cfg.dcExportMode = { targetSocPct: 90, chargeDeadlineHour: 23, chargeGuardHours: 23, bufferW: 100 };
  cfg.schedule = { ...cfg.schedule, timezone: 'Europe/Berlin', evaluateMs: 5000, smallMarketAutomation: { enabled: false } };
  return cfg;
}

async function run(cfg, { pvSeries = null, evals = 15 } = {}) {
  const writes = [];
  const state = {
    victron: { soc: 50, pvTotalW: 5000, pvPowerW: 5000, selfConsumptionW: 0, fieldUpdatedAt: { soc: Date.now() } },
    schedule: {
      rules: [{ id: 'opt-dc-1', enabled: true, target: 'dcExportMode', value: 1, ...activeWindow(), source: 'forecast_optimizer', autoManaged: true, optimizer: 'eos' }],
      active: {}, lastWrite: {}, manualOverride: {},
      config: { defaultGridSetpointW: null, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 }, lastEvalAt: 0
    },
    ctrl: { negativePriceActive: false, forcedOff: false },
    epex: { data: [] }
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg,
    transport: {
      type: 'modbus',
      mbWriteMultiple: async ({ address, values }) => { writes.push({ t: Date.now(), address, values }); },
      mbWriteSingle: async ({ address, value }) => { writes.push({ t: Date.now(), address, values: [value] }); }
    },
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null,
    epexNowNext: () => ({ current: { ct_kwh: 12 }, next: null }),
    regenerateSmallMarketAutomationRules: async () => {}, onEvalComplete: () => {}
  });
  const realNow = Date.now;
  const t0 = realNow();
  let fake = t0;
  Date.now = () => fake;
  try {
    for (let i = 0; i < evals; i += 1) {
      fake = t0 + i * 5000;
      state.victron.fieldUpdatedAt.soc = fake;
      if (pvSeries) state.victron.pvTotalW = state.victron.pvPowerW = pvSeries[i % pvSeries.length];
      await ev.evaluateSchedule();
    }
  } finally { Date.now = realNow; }
  const sp = writes.filter((w) => w.address === cfg.controlWrite.gridSetpointW.address);
  return { sp: sp.map((w) => ({ s: (w.t - t0) / 1000, v: (w.values[0] << 16) | w.values[1] })), state };
}

test('dcExportMode, gleichmäßige PV: 2716 wird im Keepalive-Takt (5 s) aufgefrischt', async () => {
  const cfg = victronCfg();
  assert.equal(cfg.controlWrite.gridSetpointW.address, 2716);
  assert.equal(cfg.schedule.controlKeepaliveMs, 5000);
  const { sp } = await run(cfg);
  const at = sp.map((w) => w.s);
  assert.deepEqual(at, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70], `Write-Zeitpunkte ${JSON.stringify(at)}`);
  assert.ok(sp.every((w) => w.v === -4900), 'immer derselbe Export-Sollwert (PV 5000 − Puffer 100)');
});

test('dcExportMode, PV schwankt < 50 W: der gehaltene Sollwert wird im Keepalive-Takt neu bestätigt', async () => {
  const cfg = victronCfg();
  const { sp } = await run(cfg, { pvSeries: [5000, 5020, 4990, 5010], evals: 6 });
  assert.deepEqual(sp.map((w) => w.s), [0, 5, 10, 15, 20, 25]);
  assert.ok(sp.every((w) => w.v === -4900), `gehaltener Wert, keine 50-W-Zappelei: ${JSON.stringify(sp)}`);
});

test('ohne Keepalive (persistentes Reg 2700, controlKeepaliveMs 0): Schreibbild unverändert (ein Write, danach gehalten)', async () => {
  const cfg = victronCfg();
  cfg.controlWrite.gridSetpointW = { ...cfg.controlWrite.gridSetpointW, address: 2700, fc: 6, writeType: 'int16' };
  cfg.schedule.controlKeepaliveMs = 0;
  const { sp } = await run(cfg);
  assert.deepEqual(sp.map((w) => w.s), [0], 'wie bisher: ein Write, der gleiche Wert wird ohne Keepalive gehalten');
});
