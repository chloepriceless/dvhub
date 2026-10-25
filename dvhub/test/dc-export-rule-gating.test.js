// Review Regelung 25.10. (P3): dcExportMode-Regeln (EOS „eos_pv_export“)
// wurden nur über HH:MM gematcht — ohne slotTs/slotEndTs und ohne Pro-Gate.
// Eine liegengebliebene EOS-Regel von gestern feuerte so heute zur selben
// Uhrzeit wieder, auch nach Ablauf der Lizenz. Jetzt gilt dieselbe Prüfung wie
// für Optimierer-gridSetpointW-Regeln (effectiveTargetValue).
// ECHTES Victron-Profil, echter Evaluator.
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
const DAY = 24 * 3600 * 1000;

function victronCfg() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-dcgate-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', 'victron.json'), path.join(rootDir, 'hersteller', 'victron.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'victron', victron: { host: '192.0.2.10' } }));
  const cfg = loadConfigFile(configPath).effectiveConfig;
  cfg.dvControl = { ...cfg.dvControl, enabled: false };
  cfg.optimizer = { ...cfg.optimizer, enabled: true, allowGridCharge: false, allowGridDischarge: true, hardFloorSocPct: 5 };
  cfg.dcExportMode = { targetSocPct: 90, chargeDeadlineHour: 23, chargeGuardHours: 23, bufferW: 100 };
  cfg.schedule = { ...cfg.schedule, timezone: 'Europe/Berlin', smallMarketAutomation: { enabled: false } };
  return cfg;
}

async function dcWrites(rule, { proActive = null, socPct = 50 } = {}) {
  const cfg = victronCfg();
  const writes = [];
  const state = {
    victron: { soc: socPct, pvTotalW: 5000, pvPowerW: 5000, selfConsumptionW: 0, fieldUpdatedAt: { soc: Date.now() } },
    schedule: {
      rules: [rule], active: {}, lastWrite: {}, manualOverride: {},
      config: { defaultGridSetpointW: null, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 }, lastEvalAt: 0
    },
    ctrl: { negativePriceActive: false, forcedOff: false },
    epex: { data: [] }
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg,
    transport: {
      type: 'modbus',
      mbWriteMultiple: async ({ address, values }) => { writes.push({ address, values }); },
      mbWriteSingle: async ({ address, value }) => { writes.push({ address, values: [value] }); }
    },
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null,
    epexNowNext: () => ({ current: { ct_kwh: 12 }, next: null }),
    regenerateSmallMarketAutomationRules: async () => {}, onEvalComplete: () => {},
    ...(proActive == null ? {} : { licenseService: { isProActive: () => proActive } })
  });
  await ev.evaluateSchedule();
  return writes.filter((w) => w.address === 2716).map((w) => (w.values[0] << 16) | w.values[1]);
}

const eosRule = (over = {}) => ({
  id: 'opt-dc-1', enabled: true, target: 'dcExportMode', value: 1, ...activeWindow(),
  source: 'forecast_optimizer', autoManaged: true, optimizer: 'eos', planAction: 'eos_pv_export',
  slotTs: Date.now() - 60000, slotEndTs: Date.now() + 14 * 60000, ...over
});

test('EOS-dcExport-Regel im aktuellen Slot: exportiert wie bisher', async () => {
  assert.deepEqual(await dcWrites(eosRule()), [-4900]);
});

test('EOS-dcExport-Regel von gestern (slotTs abgelaufen): kein Export, obwohl HH:MM passt', async () => {
  const rule = eosRule({ slotTs: Date.now() - DAY - 60000, slotEndTs: Date.now() - DAY + 14 * 60000 });
  assert.deepEqual(await dcWrites(rule), []);
});

test('EOS-dcExport-Regel für morgen: kein Export heute', async () => {
  const rule = eosRule({ slotTs: Date.now() + DAY - 60000, slotEndTs: Date.now() + DAY + 14 * 60000 });
  assert.deepEqual(await dcWrites(rule), []);
});

test('Pro-Lizenz abgelaufen: EOS-dcExport-Regel feuert nicht', async () => {
  assert.deepEqual(await dcWrites(eosRule(), { proActive: false }), []);
  assert.deepEqual(await dcWrites(eosRule(), { proActive: true }), [-4900], 'mit Lizenz unverändert');
});

test('manuelle dcExport-Regel (Nutzer, kein Optimierer): unverändert aktiv, auch ohne Pro', async () => {
  const rule = { id: 'user-dc', enabled: true, target: 'dcExportMode', value: 1, ...activeWindow() };
  // SoC über dem Ziel, damit die Lade-Sicherung manueller Regeln nicht greift.
  assert.deepEqual(await dcWrites(rule, { proActive: false, socPct: 95 }), [-4900]);
});
