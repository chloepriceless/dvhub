import path from 'node:path';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  collectChangedPaths,
  detectRestartRequired,
  getConfigDefinition,
  loadConfigFile,
  saveConfigFile
} from './config-model.js';
import { createTelemetryStorePg, ensurePgSchema } from './telemetry-store-pg.js';
import { createPool } from './db-client.js';
import {
  buildLiveTelemetrySamples
} from './telemetry-runtime.js';
import {
  createTelemetryWriteBuffer
} from './runtime-performance.js';
import { createRuntimeCommandRequest, validateRuntimeCommand } from './runtime-commands.js';
import {
  buildRuntimeSnapshot
} from './runtime-state.js';
import { RUNTIME_MESSAGE_TYPES, startRuntimeWorker } from './runtime-worker-protocol.js';
import { createHistoryApiHandlers, createHistoryRuntime } from './history-runtime.js';
import { createEnergyChartsMarketValueService } from './energy-charts-market-values.js';
import { createBundesnetzagenturApplicableValueService } from './bundesnetzagentur-applicable-values.js';
import { readAppVersionInfo } from './app-version.js';
import {
  createMarketAutomationBuilder
} from './market-automation-builder.js';
import { createScheduleEvaluator } from './schedule-eval.js';
import {
  buildSunTimesCacheKey,
  isSunTimesCacheStale,
  readSunTimesCacheStore
} from './sun-times-cache.js';
import {
  sanitizePersistedScheduleRules
} from './schedule-runtime.js';
import { createHistoryImportManager } from './history-import.js';
import { createModbusTransport } from './transport-modbus.js';
import { createMqttTransport } from './transport-mqtt.js';
import { discoverSystems as discoverConfiguredSystems } from './system-discovery.js';
import {
  nowIso,
  gridDirection
} from './server-utils.js';
import { createModbusServer } from './modbus-server.js';
import { createEpexFetcher } from './epex-fetch.js';
import { createPoller, loadEnergy } from './polling.js';
import { createApiRoutes, SECURITY_HEADERS } from './routes-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = process.env.DV_APP_CONFIG || path.join(__dirname, 'config.json');
const execFileAsync = promisify(execFile);
const CONFIG_DEFINITION = getConfigDefinition();
let loadedConfig = loadConfigFile(CONFIG_PATH);
let rawCfg = loadedConfig.rawConfig;
let cfg = loadedConfig.effectiveConfig;
const SERVICE_ACTIONS_ENABLED = process.env.DV_ENABLE_SERVICE_ACTIONS === '1';
const SERVICE_NAME = process.env.DV_SERVICE_NAME || 'dvhub.service';
const SERVICE_USE_SUDO = process.env.DV_SERVICE_USE_SUDO !== '0';
const DATA_DIR = process.env.DV_DATA_DIR || '';
const APP_VERSION = readAppVersionInfo({ appDir: __dirname });
const APPLICABLE_VALUES_CACHE_PATH = path.join(
  DATA_DIR || __dirname,
  'reference-data',
  'bundesnetzagentur-applicable-values.json'
);
const SUN_TIMES_CACHE_PATH = path.join(
  DATA_DIR || __dirname,
  'reference-data',
  'sun-times-cache.json'
);
const LIVE_TELEMETRY_FLUSH_MS = 5000;
const MARKET_VALUE_BACKFILL_INTERVAL_MS = 30 * 60 * 1000;
const MARKET_VALUE_BACKFILL_MAX_YEARS_PER_RUN = 2;
const RUNTIME_WORKER_ENABLED = process.env.DVHUB_ENABLE_RUNTIME_WORKER === '1';
const PROCESS_ROLE = process.env.DVHUB_PROCESS_ROLE || (RUNTIME_WORKER_ENABLED ? 'web' : 'monolith');
const IS_WEB_PROCESS = PROCESS_ROLE === 'web' || PROCESS_ROLE === 'monolith';
const IS_RUNTIME_PROCESS = PROCESS_ROLE === 'runtime-worker' || PROCESS_ROLE === 'monolith';

const state = {
  dvRegs: { 0: 0, 1: 0, 3: 0, 4: 0 },
  ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: Date.now(), _dcExportLastWriteAt: 0, _dcExportLogged: false, _dcExportPriceBlockLogged: false },
  keepalive: {
    modbusLastQuery: null,
    appPulse: { periodSec: cfg.keepalivePulseSec }
  },
  meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
  victron: {
    updatedAt: 0,
    soc: null,
    batteryPowerW: null,
    pvPowerW: null,
    acPvL1W: null,
    acPvL2W: null,
    acPvL3W: null,
    pvAcW: null,
    pvTotalW: null,
    gridSetpointW: null,
    minSocPct: null,
    feedExcessDcPv: null,
    dontFeedExcessAcPv: null,
    gridImportW: null,
    gridExportW: null,
    selfConsumptionW: null,
    batteryChargeW: null,
    batteryDischargeW: null,
    solarDirectUseW: null,
    solarToBatteryW: null,
    solarToGridW: null,
    gridDirectUseW: null,
    gridToBatteryW: null,
    batteryDirectUseW: null,
    batteryToGridW: null,
    errors: {}
  },
  scan: { running: false, updatedAt: 0, params: null, rows: [], error: null },
  schedule: {
    rules: Array.isArray(cfg.schedule.rules) ? cfg.schedule.rules : [],
    config: {
      defaultGridSetpointW: cfg.schedule.defaultGridSetpointW,
      defaultChargeCurrentA: cfg.schedule.defaultChargeCurrentA,
      defaultFeedExcessDcPv: cfg.schedule.defaultFeedExcessDcPv ?? 1
    },
    active: { gridSetpointW: null, chargeCurrentA: null, feedExcessDcPv: null },
    lastWrite: { gridSetpointW: null, chargeCurrentA: null, feedExcessDcPv: null },
    manualOverride: {},
    lastEvalAt: 0,
    smallMarketAutomation: {
      lastRunDate: null,
      lastOutcome: 'idle',
      generatedRuleCount: 0
    }
  },
  energy: {
    day: null,
    importWh: 0,
    exportWh: 0,
    costEur: 0,
    revenueEur: 0,
    lastTs: 0
  },
  epex: { ok: false, date: null, nextDate: null, updatedAt: 0, data: [], error: null },
  telemetry: {
    enabled: !!cfg.telemetry?.enabled,
    dbPath: null,
    ok: false,
    lastWriteAt: null,
    lastRollupAt: null,
    lastCleanupAt: null,
    lastError: null
  },
  log: []
};

// ── Transport erstellen (Modbus oder MQTT) ──────────────────────────
const transport = cfg.victron?.transport === 'mqtt'
  ? createMqttTransport(cfg.victron)
  : createModbusTransport();

// Separate Modbus-Instanz für Scan-Tool (funktioniert immer über Modbus)
const scanTransport = createModbusTransport();
let telemetryStore = null;
let historyImportManager = null;
let historyRuntime = null;
let historyApi = null;
let energyChartsMarketValueService = null;
const applicableValueService = createBundesnetzagenturApplicableValueService({
  cachePath: APPLICABLE_VALUES_CACHE_PATH
});
let liveTelemetryBuffer = null;
let runtimeWorker = null;
let runtimeWorkerSnapshot = null;
let runtimeWorkerStatusPayload = null;
let runtimeWorkerHeartbeatAt = 0;
let sunTimesCacheState = null;
let runtimeWorkerState = {
  ready: false,
  lastError: null
};
function getSmallMarketAutomationLocation(config = cfg) {
  return config?.schedule?.smallMarketAutomation?.location || null;
}

function getSunTimesCacheForPlanning({ now = new Date(), config = cfg } = {}) {
  const location = getSmallMarketAutomationLocation(config);
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const year = new Date(now).getUTCFullYear();
  const requestedLocation = { latitude, longitude };
  const cachedEntry = sunTimesCacheState?.entry || null;
  const cacheIsStale = isSunTimesCacheStale({
    cachedLocation: cachedEntry?.location,
    requestedLocation,
    cachedYear: cachedEntry?.year,
    requestedYear: year
  });
  if (cachedEntry && !cacheIsStale) return cachedEntry;

  const store = readSunTimesCacheStore(SUN_TIMES_CACHE_PATH);
  const cacheKey = buildSunTimesCacheKey({ latitude, longitude, year });
  const nextEntry = {
    key: cacheKey,
    year,
    location: requestedLocation,
    cachePath: SUN_TIMES_CACHE_PATH,
    cache: store?.entries?.[cacheKey]?.cache || {}
  };
  sunTimesCacheState = { entry: nextEntry, loadedAt: Date.now() };
  return nextEntry;
}
function applyLoadedConfig(nextLoadedConfig) {
  loadedConfig = nextLoadedConfig;
  rawCfg = nextLoadedConfig.rawConfig;
  cfg = nextLoadedConfig.effectiveConfig;
  state.keepalive.appPulse.periodSec = cfg.keepalivePulseSec;
  state.schedule.rules = Array.isArray(cfg.schedule.rules) ? cfg.schedule.rules : [];
  state.schedule.config.defaultGridSetpointW = cfg.schedule.defaultGridSetpointW;
  state.schedule.config.defaultChargeCurrentA = cfg.schedule.defaultChargeCurrentA;
  state.schedule.config.defaultFeedExcessDcPv = cfg.schedule.defaultFeedExcessDcPv ?? 1;
  // Hot-reload monitoring heartbeat if function exists
  if (typeof startMonitoringHeartbeat === 'function') startMonitoringHeartbeat();
}

function saveAndApplyConfig(nextRawConfig) {
  const previousRaw = rawCfg;
  const saved = saveConfigFile(CONFIG_PATH, nextRawConfig);
  applyLoadedConfig(saved);
  const changedPaths = collectChangedPaths(previousRaw, rawCfg);
  const restart = detectRestartRequired(changedPaths);
  return {
    ok: true,
    changedPaths,
    restartRequired: restart.required,
    restartRequiredPaths: restart.paths,
    loadedConfig: saved
  };
}

function persistConfig() {
  try {
    const current = JSON.parse(JSON.stringify(rawCfg || {}));
    current.schedule = current.schedule || {};
    current.schedule.rules = sanitizePersistedScheduleRules(state.schedule.rules);
    current.schedule.defaultGridSetpointW = state.schedule.config.defaultGridSetpointW;
    current.schedule.defaultChargeCurrentA = state.schedule.config.defaultChargeCurrentA;
    current.schedule.defaultFeedExcessDcPv = state.schedule.config.defaultFeedExcessDcPv;
    saveAndApplyConfig(current);
    telemetrySafeWrite(() => telemetryStore.writeScheduleSnapshot({
      ts: new Date(),
      rules: current.schedule.rules,
      defaultGridSetpointW: state.schedule.config.defaultGridSetpointW,
      defaultChargeCurrentA: state.schedule.config.defaultChargeCurrentA,
      defaultFeedExcessDcPv: state.schedule.config.defaultFeedExcessDcPv,
      source: 'config_persist'
    }));
  } catch (e) {
    pushLog('config_persist_error', { error: e.message });
  }
}

// -- DI Context -----------------------
// ctx is defined after all injected functions exist (after controlValue).
// See ctx definition below for the full shape.
// Init order = dependency order: utils (pure imports), pricing (pure imports),
// then epex -> poller -> scheduler -> modbus-server -> routes.

async function createTelemetryStoreIfEnabled() {
  if (!cfg.telemetry?.enabled) return null;
  try {
    const dbConfig = cfg.telemetry.database || {};
    const pool = createPool(dbConfig);
    // Connectivity check + schema init — fail fast if DB is unreachable
    await pool.query('SELECT 1');
    await ensurePgSchema(pool);
    const store = createTelemetryStorePg(pool, {
      rawRetentionDays: Number(cfg.telemetry.rawRetentionDays || 45)
    });
    state.telemetry.enabled = true;
    state.telemetry.dbPath = `postgresql://${dbConfig.host || 'localhost'}:${dbConfig.port || 5432}/${dbConfig.name || 'dvhub'}`;
    state.telemetry.ok = true;
    state.telemetry.lastError = null;
    return store;
  } catch (error) {
    state.telemetry.enabled = true;
    state.telemetry.ok = false;
    state.telemetry.lastError = error.message;
    pushLog('telemetry_store_init_error', { error: error.message });
    return null;
  }
}

async function refreshTelemetryStatus() {
  if (!telemetryStore) {
    state.telemetry.enabled = !!cfg.telemetry?.enabled;
    state.telemetry.ok = false;
    return;
  }
  try {
    const status = await telemetryStore.getStatus();
    state.telemetry.enabled = !!cfg.telemetry?.enabled;
    state.telemetry.dbPath = status.dbPath;
    state.telemetry.ok = true;
    state.telemetry.lastWriteAt = status.lastWriteAt;
  } catch (error) {
    state.telemetry.enabled = !!cfg.telemetry?.enabled;
    state.telemetry.ok = false;
    state.telemetry.lastError = error.message;
  }
}

function buildCurrentRuntimeSnapshot() {
  return buildRuntimeSnapshot({
    now: Date.now(),
    meter: {
      ...state.meter,
      l1Dir: gridDirection(state.meter.grid_l1_w, cfg.gridPositiveMeans),
      l2Dir: gridDirection(state.meter.grid_l2_w, cfg.gridPositiveMeans),
      l3Dir: gridDirection(state.meter.grid_l3_w, cfg.gridPositiveMeans),
      totalDir: gridDirection(state.meter.grid_total_w, cfg.gridPositiveMeans),
      semantics: { positiveMeans: cfg.gridPositiveMeans }
    },
    victron: state.victron,
    schedule: state.schedule,
    telemetry: state.telemetry,
    historyImport: historyImportManager ? historyImportManager.getStatus() : null
  });
}

function buildCurrentStatusPayload({ now = Date.now(), runtimeSnapshot = buildCurrentRuntimeSnapshot() } = {}) {
  return {
    now: Number(now),
    dvControlValue: controlValue(),
    dcExportMode: { enabled: cfg.dcExportMode?.enabled === true, priceThresholdCtKwh: cfg.dcExportMode?.priceThresholdCtKwh ?? null, pvTotalW: Number(state.victron.pvTotalW || 0), pvDcW: Number(state.victron.pvPowerW || 0) },
    dvRegs: state.dvRegs,
    ctrl: { ...state.ctrl, dvControl: state.ctrl.dvControl || null },
    keepalive: state.keepalive,
    meter: runtimeSnapshot.meter,
    victron: runtimeSnapshot.victron,
    scan: state.scan,
    schedule: runtimeSnapshot.schedule,
    costs: ctx.costSummary(),
    userEnergyPricing: ctx.userEnergyPricingSummary(),
    epex: { ...state.epex, summary: epex.epexNowNext() },
    telemetry: {
      ...runtimeSnapshot.telemetry,
      historyImport: runtimeSnapshot.historyImport
    }
  };
}

function buildRuntimeRouteMeta(now = Date.now()) {
  const snapshotCapturedAt = runtimeWorkerSnapshot?.capturedAt ? Date.parse(runtimeWorkerSnapshot.capturedAt) : Number.NaN;
  return {
    ready: RUNTIME_WORKER_ENABLED ? runtimeWorkerState.ready : true,
    busy: false,
    queueDepth: 0,
    snapshotAgeMs: Number.isFinite(snapshotCapturedAt) ? Math.max(0, now - snapshotCapturedAt) : null,
    heartbeatAgeMs: runtimeWorkerHeartbeatAt ? Math.max(0, now - runtimeWorkerHeartbeatAt) : null,
    mode: RUNTIME_WORKER_ENABLED ? 'worker' : 'in_process',
    lastError: runtimeWorkerState.lastError
  };
}

function getCachedRuntimeStatusPayload() {
  if (!IS_WEB_PROCESS || !RUNTIME_WORKER_ENABLED) return null;
  return runtimeWorkerStatusPayload;
}

function historicalMarketValueBackfillYears({ bounds, now = new Date() } = {}) {
  const currentYear = new Date(now).getUTCFullYear();
  const earliestYear = Number(String(bounds?.earliest || '').slice(0, 4));
  const latestYear = Number(String(bounds?.latest || '').slice(0, 4));
  if (!Number.isInteger(earliestYear) || !Number.isInteger(latestYear)) return [];
  const endYear = Math.min(latestYear, currentYear - 1);
  if (endYear < earliestYear) return [];
  return Array.from({ length: endYear - earliestYear + 1 }, (_, index) => earliestYear + index);
}

async function startAutomaticMarketValueBackfill() {
  if (!IS_RUNTIME_PROCESS || !telemetryStore || !energyChartsMarketValueService?.backfillMissingSolarMarketValues) {
    return;
  }
  try {
    const bounds = await telemetryStore.getTelemetryBounds();
    const years = historicalMarketValueBackfillYears({ bounds });
    if (!years.length) return;
    await energyChartsMarketValueService.backfillMissingSolarMarketValues({
      years,
      maxYearsPerRun: MARKET_VALUE_BACKFILL_MAX_YEARS_PER_RUN
    });
  } catch (error) {
    pushLog('market_value_backfill_error', { error: error.message });
  }
}

function publishRuntimeSnapshot() {
  if (!IS_RUNTIME_PROCESS || typeof process.send !== 'function') return;
  const now = Date.now();
  const snapshot = buildCurrentRuntimeSnapshot();
  process.send({
    type: RUNTIME_MESSAGE_TYPES.RUNTIME_SNAPSHOT,
    snapshot,
    status: buildCurrentStatusPayload({ now, runtimeSnapshot: snapshot })
  });
}

function assertValidRuntimeCommand(type, payload) {
  const request = createRuntimeCommandRequest(type, payload);
  const validation = validateRuntimeCommand(request);
  if (!validation.ok) {
    const error = new Error(validation.error);
    error.statusCode = 400;
    throw error;
  }
  return request;
}

function startDedicatedRuntimeWorker() {
  const worker = startRuntimeWorker({
    cwd: __dirname,
    env: {
      DVHUB_PROCESS_ROLE: 'runtime-worker'
    }
  });

  worker.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === RUNTIME_MESSAGE_TYPES.RUNTIME_READY) {
      runtimeWorkerState.ready = true;
      runtimeWorkerState.lastError = null;
      return;
    }
    if (message.type === RUNTIME_MESSAGE_TYPES.RUNTIME_SNAPSHOT) {
      runtimeWorkerSnapshot = message.snapshot;
      runtimeWorkerStatusPayload = message.status || null;
      runtimeWorkerHeartbeatAt = Date.now();
      return;
    }
    if (message.type === RUNTIME_MESSAGE_TYPES.RUNTIME_ERROR) {
      runtimeWorkerState.lastError = message.error || 'runtime worker error';
    }
  });

  worker.on('exit', (code, signal) => {
    runtimeWorkerState.ready = false;
    runtimeWorkerState.lastError = `runtime worker exited (code=${code}, signal=${signal})`;
    runtimeWorkerHeartbeatAt = 0;
  });

  return worker;
}

async function telemetrySafeWrite(action, { updateRollup = false, updateCleanup = false } = {}) {
  if (!telemetryStore) return null;
  try {
    const result = await action();
    await refreshTelemetryStatus();
    if (updateRollup) state.telemetry.lastRollupAt = Date.now();
    if (updateCleanup) state.telemetry.lastCleanupAt = Date.now();
    return result;
  } catch (error) {
    state.telemetry.ok = false;
    state.telemetry.lastError = error.message;
    pushLog('telemetry_store_error', { error: error.message });
    return null;
  }
}

const ENERGY_PATH = path.join(DATA_DIR || __dirname, 'energy_state.json');

function pushLog(event, details = {}) {
  const row = { ts: nowIso(), event, ...details };
  state.log.push(row);
  if (state.log.length > 1000) state.log.shift();
}

function expireLeaseIfNeeded() {
  if (state.ctrl.forcedOff && Date.now() > state.ctrl.offUntil) {
    state.ctrl.forcedOff = false;
    state.ctrl.offUntil = 0;
    state.ctrl.lastSignal = 'lease_expired';
    state.ctrl.updatedAt = Date.now();
    pushLog('ctrl_lease_expired');
    telemetrySafeWrite(() => telemetryStore.writeControlEvent({
      eventType: 'ctrl_lease_expired',
      target: 'dv_control',
      reason: 'lease_expired',
      source: 'direktvermarkter'
    }));
    // feedExcessDcPv: nächster evaluateSchedule()-Lauf setzt den Schedule-Zustand
  }
}

function setForcedOff(reason) {
  state.ctrl.forcedOff = true;
  state.ctrl.offUntil = Date.now() + cfg.offLeaseMs;
  state.ctrl.lastSignal = reason;
  state.ctrl.updatedAt = Date.now();
  pushLog('ctrl_off', { reason, offUntil: new Date(state.ctrl.offUntil).toISOString() });
  telemetrySafeWrite(() => telemetryStore.writeControlEvent({
    eventType: 'ctrl_off',
    target: 'dv_control',
    reason,
    source: 'direktvermarkter',
    meta: { offUntil: new Date(state.ctrl.offUntil).toISOString(), leaseMs: cfg.offLeaseMs }
  }));
  ctx.applyDvVictronControl(false);
}

function clearForcedOff(reason) {
  state.ctrl.forcedOff = false;
  state.ctrl.offUntil = 0;
  state.ctrl.lastSignal = reason;
  state.ctrl.updatedAt = Date.now();
  pushLog('ctrl_on', { reason });
  telemetrySafeWrite(() => telemetryStore.writeControlEvent({
    eventType: 'ctrl_on',
    target: 'dv_control',
    reason,
    source: 'direktvermarkter'
  }));
  // feedExcessDcPv: nächster evaluateSchedule()-Lauf setzt den Schedule-Zustand
}

function controlValue() {
  expireLeaseIfNeeded();
  return state.ctrl.forcedOff ? 0 : 1;
}

// -- DI Context (activated in Phase 2) ---------------------------------------
// Every create* factory receives this ctx object. Modules use what they need.
// getCfg() is a GETTER -- never pass cfg directly (prevents stale closure on hot-reload).
// After each createXxx(ctx), extend ctx with the new module's public methods.
const ctx = {
  state,
  getCfg: () => cfg,
  transport,
  pushLog,
  telemetrySafeWrite,
  persistConfig,
  setForcedOff,
  clearForcedOff,
  expireLeaseIfNeeded
};

const modbus = createModbusServer(ctx);
const epex = createEpexFetcher(ctx);
ctx.epexNowNext = epex.epexNowNext;
ctx.energyPath = ENERGY_PATH;
const poller = createPoller(ctx);
ctx.requestPoll = poller.requestPoll;
ctx.getSunTimesCacheForPlanning = getSunTimesCacheForPlanning;
const mab = createMarketAutomationBuilder(ctx);
ctx.buildSmallMarketAutomationRules = mab.buildSmallMarketAutomationRules;
ctx.regenerateSmallMarketAutomationRules = mab.regenerateSmallMarketAutomationRules;
const scheduler = createScheduleEvaluator(ctx);
ctx.applyDvVictronControl = scheduler.applyDvVictronControl;
ctx.applyControlTarget = scheduler.applyControlTarget;

// -- ctx extensions for routes-api.js ---
ctx.controlValue = controlValue;
ctx.needsSetup = () => loadedConfig.needsSetup;
ctx.getConfigPath = () => CONFIG_PATH;
ctx.getRawCfg = () => rawCfg;
ctx.getLoadedConfig = () => loadedConfig;
ctx.getConfigDefinition = () => CONFIG_DEFINITION;
ctx.getAppVersion = () => APP_VERSION;
ctx.getTransportType = () => transport.type;
ctx.getAppDir = () => __dirname;
ctx.getRepoRoot = () => path.resolve(__dirname, '..');
ctx.scanTransport = scanTransport;
ctx.fetchEpexDay = () => epex.fetchEpexDay();
ctx.fetchVrmForecast = () => epex.fetchVrmForecast();
ctx.getCachedRuntimeStatusPayload = getCachedRuntimeStatusPayload;
ctx.buildRuntimeRouteMeta = buildRuntimeRouteMeta;
ctx.buildFallbackStatusPayload = (now) => buildCurrentStatusPayload({ now });
ctx.buildSystemDiscoveryPayload = buildSystemDiscoveryPayload;

// -- ctx extensions for admin/mutation routes (Plan 2) ---
ctx.saveAndApplyConfig = (incomingConfig) => {
  return saveAndApplyConfig(restoreRedactedValues(incomingConfig, rawCfg));
};
ctx.scheduleServiceRestart = () => scheduleServiceRestart();
ctx.runServiceCommand = (args) => runServiceCommand(args);
ctx.getServiceActionsEnabled = () => SERVICE_ACTIONS_ENABLED;
ctx.getServiceName = () => SERVICE_NAME;
ctx.getServiceUseSudo = () => SERVICE_USE_SUDO;
ctx.assertValidRuntimeCommand = (type, payload) => assertValidRuntimeCommand(type, payload);

const routes = createApiRoutes(ctx);
// After createApiRoutes returns, ctx.costSummary and ctx.userEnergyPricingSummary
// are set by the factory (ctx mutation pattern).

// REDACTED_PATHS shared between routes-api.js (redactConfig) and server.js (restoreRedactedValues)
const REDACTED_PATHS = ['apiToken', 'telemetry.historyImport.vrmToken', 'telemetry.database.password'];

function restoreRedactedValues(incoming, current) {
  const copy = JSON.parse(JSON.stringify(incoming));
  for (const dotPath of REDACTED_PATHS) {
    const parts = dotPath.split('.');
    let target = copy;
    let source = current;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target?.[parts[i]];
      source = source?.[parts[i]];
      if (!target || !source) break;
    }
    const key = parts[parts.length - 1];
    if (target && source && target[key] === '***' && key in source) {
      target[key] = source[key];
    }
  }
  return copy;
}

export async function buildSystemDiscoveryPayload({
  query = {},
  discoverSystems = discoverConfiguredSystems,
  now = () => Date.now()
} = {}) {
  const manufacturer = String(query?.manufacturer || '').trim().toLowerCase();
  const startedAt = now();

  if (!manufacturer) {
    return {
      ok: false,
      manufacturer: '',
      systems: [],
      error: 'manufacturer query required',
      meta: {
        durationMs: Math.max(0, now() - startedAt),
        cached: false
      }
    };
  }

  try {
    const systems = await discoverSystems({ manufacturer });
    return {
      ok: true,
      manufacturer,
      systems,
      meta: {
        durationMs: Math.max(0, now() - startedAt),
        cached: false
      }
    };
  } catch (error) {
    return {
      ok: false,
      manufacturer,
      systems: [],
      error: error?.message || 'system discovery failed',
      meta: {
        durationMs: Math.max(0, now() - startedAt),
        cached: false
      }
    };
  }
}

function serviceCommandParts(args) {
  if (SERVICE_USE_SUDO) return { command: 'sudo', args: ['-n', 'systemctl', ...args] };
  return { command: 'systemctl', args };
}

async function runServiceCommand(args) {
  const parts = serviceCommandParts(args);
  try {
    const result = await execFileAsync(parts.command, parts.args, { timeout: 8000 });
    return {
      ok: true,
      command: `${parts.command} ${parts.args.join(' ')}`,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim()
    };
  } catch (error) {
    return {
      ok: false,
      command: `${parts.command} ${parts.args.join(' ')}`,
      error: String(error.stderr || error.stdout || error.message || 'command failed').trim()
    };
  }
}

function scheduleServiceRestart() {
  const parts = serviceCommandParts(['restart', SERVICE_NAME]);
  const helperScript = `
    const { spawn } = require('node:child_process');
    setTimeout(() => {
      const child = spawn(${JSON.stringify(parts.command)}, ${JSON.stringify(parts.args)}, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    }, 1200);
  `;
  const helper = spawn(process.execPath, ['-e', helperScript], {
    detached: true,
    stdio: 'ignore'
  });
  helper.unref();
}

const web = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // CORS: restrict cross-origin API access to same origin only (defense-in-depth, stays in orchestrator)
    const origin = req.headers.origin;
    if (origin && url.pathname.startsWith('/api/')) {
      const host = req.headers.host;
      const allowedOrigins = [`http://${host}`, `https://${host}`];
      if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', '3600');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(allowedOrigins.includes(origin) ? 204 : 403, SECURITY_HEADERS);
        res.end();
        return;
      }
    }

    // All routes handled by routes-api.js
    const handled = await routes.handleRequest(req, res, url);
    if (handled !== false) return;

    // Static file fallback
    return routes.serveStatic(req, res);
  } catch (e) {
    console.error('HTTP handler error:', e);
    if (!res.headersSent) {
      res.writeHead(Number.isInteger(e?.statusCode) ? e.statusCode : 500,
        { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e?.statusCode ? e.message : 'internal server error' }));
    }
  }
});

(async () => {
  telemetryStore = await createTelemetryStoreIfEnabled();
  ctx.telemetryStore = telemetryStore;
  ctx.publishRuntimeSnapshot = publishRuntimeSnapshot;
  ctx.onEvalComplete = () => publishRuntimeSnapshot();
  ctx.onPollComplete = ({ ts, resolutionSeconds, meter, victron }) => {
    liveTelemetryBuffer?.capture({ ts, resolutionSeconds, meter, victron });
    liveTelemetryBuffer?.flush();
    publishRuntimeSnapshot();
  };
  energyChartsMarketValueService = createEnergyChartsMarketValueService({
    marketValueStore: telemetryStore
  });
  liveTelemetryBuffer = IS_RUNTIME_PROCESS && telemetryStore ? createTelemetryWriteBuffer({
    flushIntervalMs: LIVE_TELEMETRY_FLUSH_MS,
    buildSamples: (snapshot) => buildLiveTelemetrySamples(snapshot),
    writeSamples: (rows) => telemetrySafeWrite(() => telemetryStore.writeSamples(rows))
  }) : null;
  historyImportManager = telemetryStore ? createHistoryImportManager({
    store: telemetryStore,
    telemetryConfig: cfg.telemetry || {}
  }) : null;
  ctx.historyImportManager = historyImportManager;
  if (IS_RUNTIME_PROCESS && historyImportManager) historyImportManager.startAutomaticBackfill();
  historyRuntime = telemetryStore ? createHistoryRuntime({
    store: telemetryStore,
    getPricingConfig: () => cfg.userEnergyPricing || {},
    getApplicableValueSummary: ({ year, pvPlants }) => applicableValueService.getApplicableValueSummary({ year, pvPlants })
  }) : null;
  historyApi = createHistoryApiHandlers({
    historyRuntime,
    historyImportManager,
    telemetryEnabled: !!telemetryStore,
    defaultBzn: cfg.epex?.bzn || 'DE-LU',
    appVersion: APP_VERSION,
    getSolarMarketValueSummary: ({ year }) => energyChartsMarketValueService.getSolarMarketValueSummary({ year })
  });
  ctx.historyApi = historyApi;
  await refreshTelemetryStatus();
  if (IS_RUNTIME_PROCESS) {
    applicableValueService.refresh().catch((error) => {
      pushLog('applicable_value_refresh_error', { error: error.message });
    });
    startAutomaticMarketValueBackfill();
  }
})().catch(e => pushLog('telemetry_init_error', { error: e.message }));

if (IS_WEB_PROCESS && RUNTIME_WORKER_ENABLED) {
  runtimeWorker = startDedicatedRuntimeWorker();
}

if (IS_WEB_PROCESS) {
  web.listen(cfg.httpPort, () => {
    console.log(`Web server listening on :${cfg.httpPort}`);
  });
}

if (IS_RUNTIME_PROCESS) {
  loadEnergy(state, ENERGY_PATH, cfg.epex.timezone);
  modbus.start();
  setInterval(expireLeaseIfNeeded, 1000);
  setInterval(() => {
    liveTelemetryBuffer?.flush();
  }, 1000);
  setInterval(() => {
    publishRuntimeSnapshot();
  }, 1000);
}

if (PROCESS_ROLE === 'runtime-worker' && typeof process.send === 'function') {
  process.send({
    type: RUNTIME_MESSAGE_TYPES.RUNTIME_READY,
    pid: process.pid
  });
  publishRuntimeSnapshot();
}

if (IS_RUNTIME_PROCESS) {
  // Transport initialisieren (bei MQTT: Verbindung aufbauen, bei Modbus: no-op)
  let transportRetryDelayMs = 5000;
  function scheduleTransportRetry() {
    const retryDelayMs = transportRetryDelayMs;
    setTimeout(() => {
      initTransport();
    }, retryDelayMs);
    transportRetryDelayMs = Math.min(60000, transportRetryDelayMs * 2);
  }
  function initTransport() {
    transport.init().then(() => {
      transportRetryDelayMs = 5000;
      console.log(`Transport initialisiert: ${transport.type}`);
    }).catch((e) => {
      console.error('Transport init fehlgeschlagen:', e.message);
      scheduleTransportRetry();
    });
  }
  initTransport();
  poller.start();
  scheduler.start();
  epex.start();
  // Rollups and retention are handled by TimescaleDB continuous aggregates and retention policies
  setInterval(startAutomaticMarketValueBackfill, MARKET_VALUE_BACKFILL_INTERVAL_MS);

  // Remote monitoring heartbeat (hot-reloadable)
  let monitoringTimerId = null;
  function startMonitoringHeartbeat() {
    if (monitoringTimerId) { clearInterval(monitoringTimerId); monitoringTimerId = null; }
    const pushUrl = cfg.monitoring?.pushUrl || '';
    const intervalMs = (Number(cfg.monitoring?.pushIntervalSec) || 240) * 1000;
    if (!pushUrl) return;
    const sendHeartbeat = async (msg) => {
      try {
        const sep = pushUrl.includes('?') ? '&' : '?';
        await fetch(pushUrl + sep + 'status=up&msg=' + encodeURIComponent(msg) + '&ping=', { signal: AbortSignal.timeout(10000) });
      } catch (e) { /* silent */ }
    };
    monitoringTimerId = setInterval(() => sendHeartbeat('DVhub OK | SOC ' + (state.victron?.soc ?? '?') + '%'), intervalMs);
    setTimeout(() => sendHeartbeat('DVhub started'), 5000);
    console.log('  Monitoring heartbeat -> ' + pushUrl.substring(0, 60) + '...');
  }
  startMonitoringHeartbeat();
}

async function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  poller.stop();
  scheduler.stop();
  liveTelemetryBuffer?.flush({ force: true });
  epex.stop();
  if (runtimeWorker) runtimeWorker.kill();
  // Close Modbus TCP connections gracefully (FIN, not RST)
  await Promise.all([transport.destroy(), scanTransport.destroy()]);
  if (telemetryStore) telemetryStore.close();
  modbus.close();
  if (IS_WEB_PROCESS) web.close();
  // Short delay to let TCP FIN packets flush before exiting
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  pushLog('unhandled_rejection', { error: String(reason?.message || reason) });
  try { poller.stop(); } catch {}
  liveTelemetryBuffer?.flush({ force: true });
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  try { poller.stop(); } catch {}
  try { liveTelemetryBuffer?.flush({ force: true }); } catch {}
  process.exit(1);
});

console.log('Config loaded:', {
  processRole: PROCESS_ROLE,
  httpPort: cfg.httpPort,
  modbusListenPort: cfg.modbusListenPort,
  meterPollMs: cfg.meterPollMs,
  meterAddress: `${cfg.meter.host}:${cfg.meter.port} uid=${cfg.meter.unitId} reg=${cfg.meter.address}`,
  apiTokenSet: !!cfg.apiToken,
  epexEnabled: cfg.epex.enabled,
  scheduleRules: cfg.schedule.rules.length,
  telemetryEnabled: cfg.telemetry?.enabled,
  telemetryDbPath: state.telemetry.dbPath,
  configPath: CONFIG_PATH,
  configExists: loadedConfig.exists,
  configValid: loadedConfig.valid,
  needsSetup: loadedConfig.needsSetup
});

if (loadedConfig.parseError) {
  console.error(`Config parse error in ${CONFIG_PATH}: ${loadedConfig.parseError}`);
}
if (loadedConfig.needsSetup) {
  console.log(`No valid config available at ${CONFIG_PATH}. Root URL will open the setup wizard.`);
}
