import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
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
import { createTelemetryStorePg, ensurePgSchema, runPendingMigrations } from './telemetry-store-pg.js';
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
// Phase 09.3-01: history-viz aggregator factory (per-card endpoints under
// /api/history/viz/*). Wired into ctx after telemetryStore + db are available.
import { createHistoryVizAggregator } from './services/history-viz/aggregator.js';
import { createEnergyChartsMarketValueService } from './energy-charts-market-values.js';
import { createBundesnetzagenturApplicableValueService } from './bundesnetzagentur-applicable-values.js';
import { REDACTED_PATHS, restoreRedacted, redactUrlCreds } from './config-redaction.js';
import { readAppVersionInfo } from './app-version.js';
import {
  createMarketAutomationBuilder
} from './market-automation-builder.js';
import { createScheduleEvaluator } from './schedule-eval.js';
import {
  buildSunTimesCacheKey,
  isSunTimesCacheStale,
  readSunTimesCacheStore,
  writeSunTimesCacheStore
} from './sun-times-cache.js';
import { buildSunTimesYearCache } from './sun-times-compute.js';
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
// Phase 09.2 D-01..D-05 — per-system health tracker (factory wired in
// telemetry IIFE below; persistSnapshot hook lives in gracefulShutdown).
import { createIntegrationsHealthTracker } from './services/integrations-health-tracker.js';
import {
  createApiRoutes,
  SECURITY_HEADERS,
  getRequestHost,
  isHostAllowed,
  resolveCorsAllowedOrigin,
  // Plan 09-06 (D-06): metric instrument hooks — call sites in server.js
  // (pushLog audit branch) + polling.js use these to record dvhub_* counters.
  auditLogEntriesTotal,
  isAllowedAuditMetricEvent,
  meterPollDurationSeconds,
  meterPollErrorsTotal
} from './routes-api.js';
import { createVpnManager } from './vpn-manager.js';
// Plan 09-06 (D-08): services/log.js wrapper around console.* — the in-server.js
// monitoring-heartbeat block (~startMonitoringHeartbeat) is the 6th D-08 heavy
// hitter (the 5 standalone modules are polling.js, services/forecast/index.js,
// vpn-manager.js, transport-modbus.js — see CONTEXT.md D-08).
import { info as logInfo, warn as logWarn, logger as appLogger } from './services/log.js';
// Plan 09-07: Shared safeInterval helper. configureSafeAsync({logger, pushLog})
// is called once below, after pushLog is in scope, BEFORE any service.start()
// fires its first interval tick. No console.error fallback — the helper throws
// loudly if misordered. Hard dep on 09-06 (services/log.js).
import { configureSafeAsync } from './services/safe-async.js';
// Plan 09-06 (D-06): prom-client is the SINGLE QUAL-03 exception for Phase 9.
// Battle-tested Prometheus client (~30KB minified) — preferred over hand-rolling
// the exposition format. No other Phase 9 plan adds dependencies. Imported here
// only so the dependency is exercised at server boot (the active instrumentation
// lives in routes-api.js, which owns the Registry + instruments).
// eslint-disable-next-line no-unused-vars
import promClient from 'prom-client';
import { createForecastService } from './services/forecast/index.js';
// Phase 07 Plan 07-04: Wave-2 forecast services wired directly in server.js so routes-api.js
// can consume them via ctx.forecastSnapshots / ctx.pvnodeBackfill / ctx.pvnodeQuota.
import { createForecastSnapshots } from './services/forecast/forecast-snapshots.js';
import { createPvnodeBackfill } from './services/forecast/pvnode-backfill.js';
import { createPvnodeQuota } from './services/forecast/pvnode-quota.js';
import { createOptimizerService } from './services/optimizer/index.js';
import { createFamilyService } from './services/family/index.js';
import { createMqttHub } from './services/mqtt/index.js';
import { createMqttPublisher } from './services/mqtt/publisher.js';
import { createMqttTopicObserver } from './services/mqtt/topic-observer.js';
import { publishHaDiscoveryTopics } from './services/mqtt/ha-discovery.js';
import { createTeslamateSubscriber } from './services/mqtt/teslamate.js';
import { createFamilyMqttTiles } from './services/mqtt/family-tiles.js';
import { createDeviceService } from './services/devices/index.js';
import { createNotificationService } from './services/notifications/index.js';
import { createMlService } from './services/ml/index.js';
import { createRetrainJobs } from './services/ml/ml-retrain-jobs.js';
import { createLlmService } from './services/llm/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = process.env.DV_APP_CONFIG || path.join(__dirname, 'config.json');
const execFileAsync = promisify(execFile);
import { runMigrations, checkSystemRequirements } from './migration-runner.js';

// Run config migrations before loading config
const migrationResult = await runMigrations(CONFIG_PATH);
if (migrationResult.applied.length > 0) {
  console.log(`Config migrated: v${migrationResult.fromVersion} → v${migrationResult.toVersion}`);
}
const systemWarnings = checkSystemRequirements();
if (systemWarnings.length > 0) {
  for (const w of systemWarnings) console.warn(`System: ${w.message}`);
}

const CONFIG_DEFINITION = getConfigDefinition();
let loadedConfig = loadConfigFile(CONFIG_PATH);
let rawCfg = loadedConfig.rawConfig;
let cfg = loadedConfig.effectiveConfig;
const SERVICE_ACTIONS_ENABLED = process.env.DV_ENABLE_SERVICE_ACTIONS === '1';

// Plan 08-01 Task 1 (CRITICAL #1): refuse to start with service actions enabled
// but no real apiToken configured — that combination is remote root via /api/admin/*.
// Log only the condition, never the token itself.
if (SERVICE_ACTIONS_ENABLED && (!cfg.apiToken || typeof cfg.apiToken !== 'string' || cfg.apiToken.length < 16)) {
  console.error('[FATAL] apiToken missing or too short (<16 chars) while DV_ENABLE_SERVICE_ACTIONS=1 — refusing to start');
  process.exit(1);
}
if (!cfg.apiToken || cfg.apiToken === '') {
  console.warn('[WARN] apiToken is empty — all authenticated endpoints will return 503 until token is configured');
}

const SERVICE_NAME = process.env.DV_SERVICE_NAME || 'dvhub.service';
const SERVICE_USE_SUDO = process.env.DV_SERVICE_USE_SUDO !== '0';
const DATA_DIR = process.env.DV_DATA_DIR || '';

// Plan 08-06 Task 2 Step 2: setup wizard one-shot bootstrap token.
// On first boot with no apiToken, generate a random token and write it to
// ${DATA_DIR}/bootstrap.token (mode 0600). The legitimate operator reads this
// via SSH and supplies it as `x-bootstrap-token` when POSTing to /api/config to
// set the initial apiToken. /api/config (routes-api.js) deletes the file after
// a successful setup save, closing the takeover window. Without this gate, any
// LAN client could race to set apiToken because LAN bypasses checkAuth.
const BOOTSTRAP_TOKEN_PATH = path.join(DATA_DIR || __dirname, 'bootstrap.token');
if (!cfg.apiToken || cfg.apiToken === '') {
  if (!fs.existsSync(BOOTSTRAP_TOKEN_PATH)) {
    try {
      const bootstrap = crypto.randomBytes(24).toString('hex');
      fs.writeFileSync(BOOTSTRAP_TOKEN_PATH, bootstrap + '\n', { mode: 0o600 });
      console.log(`[setup] bootstrap.token written to ${BOOTSTRAP_TOKEN_PATH} (mode 0600).`);
      console.log('[setup] read it via SSH and pass as `x-bootstrap-token` header to POST /api/config when setting apiToken.');
    } catch (e) {
      console.error('[setup] could not write bootstrap.token:', e.message);
    }
  } else {
    console.warn(`[setup] bootstrap.token already present at ${BOOTSTRAP_TOKEN_PATH} — supply that value as x-bootstrap-token`);
  }
}
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
// ── Plan 08-05 Task 1: TLS hardening ──────────────────────────────────────
// Minimum TLS version: TLSv1.2 (rejects SSLv3 / TLSv1.0 / TLSv1.1 downgrades).
// The cipher allowlist is the intersection of Mozilla "intermediate" profile
// and Node.js v18+ OpenSSL defaults — all AEAD, all ECDHE, no CBC / 3DES / RC4.
const TLS_MIN_VERSION = 'TLSv1.2';
const TLS_ALLOWED_CIPHERS = [
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_128_GCM_SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256'
].join(':');
const RUNTIME_WORKER_ENABLED = process.env.DVHUB_ENABLE_RUNTIME_WORKER === '1';
const PROCESS_ROLE = process.env.DVHUB_PROCESS_ROLE || (RUNTIME_WORKER_ENABLED ? 'web' : 'monolith');
const IS_WEB_PROCESS = PROCESS_ROLE === 'web' || PROCESS_ROLE === 'monolith';
const IS_RUNTIME_PROCESS = PROCESS_ROLE === 'runtime-worker' || PROCESS_ROLE === 'monolith';

const state = {
  systemWarnings,
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
  // 0,0 is Null Island (Gulf of Guinea) — treat as unconfigured, use German default
  if (latitude === 0 && longitude === 0) {
    return getSunTimesCacheForPlanning({ now, config: { ...config, schedule: { ...config.schedule, smallMarketAutomation: { ...config.schedule?.smallMarketAutomation, location: { label: 'Deutschland', latitude: 51.1657, longitude: 10.4515 } } } } });
  }

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

  let store = readSunTimesCacheStore(SUN_TIMES_CACHE_PATH);
  const cacheKey = buildSunTimesCacheKey({ latitude, longitude, year });

  // Lazy-populate: sunrise/sunset are deterministic per (lat,lng,year).
  // First call for a given key computes the full year via NOAA formulas
  // and persists to disk; subsequent calls hit the cache.
  let cache = store?.entries?.[cacheKey]?.cache;
  if (!cache || !Object.keys(cache).length) {
    cache = buildSunTimesYearCache({ year, latitude, longitude });
    const nextStore = {
      ...(store || {}),
      entries: {
        ...(store?.entries || {}),
        [cacheKey]: { location: requestedLocation, year, cache }
      }
    };
    // Pre-populate next year in Q4 to cover overnight slots crossing into January.
    if (new Date(now).getUTCMonth() >= 9) {
      const nextYearKey = buildSunTimesCacheKey({ latitude, longitude, year: year + 1 });
      if (!store?.entries?.[nextYearKey]?.cache) {
        nextStore.entries[nextYearKey] = {
          location: requestedLocation,
          year: year + 1,
          cache: buildSunTimesYearCache({ year: year + 1, latitude, longitude })
        };
      }
    }
    try {
      writeSunTimesCacheStore(SUN_TIMES_CACHE_PATH, nextStore);
    } catch (e) {
      console.error('[sun-times] persist failed:', e.message);
    }
    store = nextStore;
  }

  const nextEntry = {
    key: cacheKey,
    year,
    location: requestedLocation,
    cachePath: SUN_TIMES_CACHE_PATH,
    cache
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

// Plan 08-09 Task 1: persistConfig delegates to saveAndApplyConfig →
// saveConfigFile (config-model.js), where backup-on-write writes a
// timestamped `config.backup-YYYY-MM-DDTHH-MM-SS.json` sibling before each
// overwrite (10-file retention). Operators can roll back a bad save without
// git access. See config-model.js saveConfigFile for the implementation.
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
    pushLog('config_persist_error', { error: e.message }, 'error');
  }
}

// -- DI Context -----------------------
// ctx is defined after all injected functions exist (after controlValue).
// See ctx definition below for the full shape.
// Init order = dependency order: utils (pure imports), pricing (pure imports),
// then epex -> poller -> scheduler -> modbus-server -> routes.

let dbPool = null; // raw pg pool — shared between telemetry store and forecast services

async function createTelemetryStoreIfEnabled() {
  if (!cfg.telemetry?.enabled) return null;
  try {
    const dbConfig = cfg.telemetry.database || {};
    const pool = createPool(dbConfig);
    // Connectivity check + schema init — fail fast if DB is unreachable
    await pool.query('SELECT 1');
    await ensurePgSchema(pool);
    // Plan 08-01 Task 3: apply any pending SQL migrations under dvhub/db/migrations/
    // directly after ensurePgSchema so schema is always brought up to date before
    // the rest of startup (market-value backfill, forecast services, etc.) runs.
    // This is the single canonical call site for runPendingMigrations.
    await runPendingMigrations(pool, cfg);
    const store = createTelemetryStorePg(pool, {
      rawRetentionDays: Number(cfg.telemetry.rawRetentionDays || 45)
    });
    state.telemetry.enabled = true;
    state.telemetry.dbPath = `postgresql://${dbConfig.host || 'localhost'}:${dbConfig.port || 5432}/${dbConfig.name || 'dvhub'}`;
    state.telemetry.ok = true;
    state.telemetry.lastError = null;
    dbPool = pool; // save reference for ctx.db
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
    historyImport: historyImportManager ? historyImportManager.getStatus() : null,
    vpn: state.vpn
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
    },
    forecast: state.forecast ? {
      tier: state.forecast.tier,
      totalMB: state.forecast.totalMB,
      workerReady: state.forecast.workerReady,
      pvModel: state.forecast.pv?.model || null,
      pvLastFetchAt: state.forecast.pv?.lastFetchAt || null,
      loadLastFetchAt: state.forecast.load?.lastFetchAt || null,
      weatherLastFetchAt: state.forecast.weather?.lastFetchAt || null,
      weatherError: state.forecast.weather?.error || null
    } : null
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

let runtimeWorkerRestartCount = 0;
let runtimeWorkerStableTimer = null;
let shuttingDown = false;

function startDedicatedRuntimeWorker() {
  const worker = startRuntimeWorker({
    cwd: __dirname,
    env: {
      DVHUB_PROCESS_ROLE: 'runtime-worker'
    }
  });

  // Reset restart count after >5 minutes of stable operation.
  // Prevents a slow leak (one crash every 10min) from staying in long-backoff forever.
  if (runtimeWorkerStableTimer) clearTimeout(runtimeWorkerStableTimer);
  runtimeWorkerStableTimer = setTimeout(() => {
    runtimeWorkerRestartCount = 0;
  }, 5 * 60 * 1000);
  runtimeWorkerStableTimer.unref?.();

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

  worker.on('error', (err) => {
    pushLog('runtime_worker_error', { error: err?.message ?? String(err) });
  });

  worker.on('exit', (code, signal) => {
    runtimeWorkerState.ready = false;
    runtimeWorkerState.lastError = `runtime worker exited (code=${code}, signal=${signal})`;
    runtimeWorkerHeartbeatAt = 0;
    pushLog('runtime_worker_exit', { code, signal });

    if (shuttingDown) return;

    // Exponential backoff capped at 60s, reset to 0 after sustained operation (timer above).
    const delayMs = Math.min(60_000, 1000 * Math.pow(2, runtimeWorkerRestartCount++));
    setTimeout(() => {
      if (shuttingDown) return;
      pushLog('runtime_worker_respawn', { attempt: runtimeWorkerRestartCount, delayMs });
      runtimeWorker = startDedicatedRuntimeWorker();
    }, delayMs).unref?.();
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
    pushLog('telemetry_store_error', { error: error.message }, 'error');
    return null;
  }
}

const ENERGY_PATH = path.join(DATA_DIR || __dirname, 'energy_state.json');

// Plan 09-06 (D-08, D-09): pushLog gains a `level` field on every ring-buffer
// entry. The new level threads through to audit_log.severity (column already
// exists from migration 015; BLOCKER 3 fix — no new migration).
//
// Signature is backward-compat: the 3rd argument may be either
//   (a) a string ('info'|'warn'|'error'|'debug') — convenience shorthand, OR
//   (b) an options object { actor_ip, actor_ua, actor_session, severity, level }
//       — the existing Phase 08-09 shape stays untouched.
// When omitted, level defaults to 'info'. Callers that pass options.severity
// keep working (severity wins over level when both are present).
const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'critical']);
function pushLog(event, details = {}, levelOrOptions = {}) {
  // Plan 09-06: accept 3rd arg as a level shorthand OR the existing options object.
  let options;
  let level;
  if (typeof levelOrOptions === 'string') {
    level = levelOrOptions;
    options = {};
  } else {
    options = levelOrOptions || {};
    // severity wins over level if both provided (Phase 09-01 callers pass severity).
    level = options.severity || options.level || 'info';
  }
  if (!VALID_LOG_LEVELS.has(level)) level = 'info';

  const row = { ts: nowIso(), event, level: level, ...details };
  state.log.push(row);
  if (state.log.length > 1000) state.log.shift();
  // Plan 08-09 Task 1: durable mirror to audit_log (ring buffer is now a
  // cache, no longer the source of truth). Fire-and-forget — never block the
  // caller and never throw out. options.actor_ip / actor_ua / actor_session
  // come from routes-api.js actorContext(req) at every mutation boundary;
  // older callers that still pass two args get NULL actor columns and the
  // event is still durably persisted.
  if (telemetryStore?.writeAuditEntry) {
    telemetryStore.writeAuditEntry({
      eventType: event,
      payload: details,
      actor_ip: options.actor_ip,
      actor_ua: options.actor_ua,
      actor_session: options.actor_session,
      // Plan 09-06: severity routes the level into audit_log.severity (column
      // from migration 015). Falls back to the resolved `level` so 3rd-arg
      // shorthand callers also get a non-null severity.
      severity: options.severity || level,
    }).catch(() => { /* writeAuditEntry already logs internally */ });
    // Plan 09-06 (D-06): bump the audit metric for the allowlisted event
    // types. Anything outside the allowlist still hits audit_log — it just
    // doesn't expand the metrics cardinality.
    try {
      if (isAllowedAuditMetricEvent(event)) {
        auditLogEntriesTotal.inc({ event_type: event });
      }
    } catch { /* metric must never break pushLog */ }
  }
}

// Plan 09-07: Wire the shared safe-async helper with the logger (09-06) and
// pushLog (above). MUST be called before any service.start() fires its first
// safeInterval tick. Throws TypeError if logger or pushLog is missing — fail
// fast at boot rather than silently swallowing interval errors.
configureSafeAsync({ logger: appLogger, pushLog });

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
  expireLeaseIfNeeded,
  get db() { return dbPool; }, // lazy getter — dbPool set during createTelemetryStoreIfEnabled()
};

const modbus = createModbusServer(ctx);
const vpnManager = createVpnManager(ctx);
ctx.vpnManager = vpnManager;
const epex = createEpexFetcher(ctx);
ctx.epexNowNext = epex.epexNowNext;
ctx.energyPath = ENERGY_PATH;
const poller = createPoller(ctx);
ctx.requestPoll = poller.requestPoll;
ctx.getSunTimesCacheForPlanning = getSunTimesCacheForPlanning;
const mab = createMarketAutomationBuilder(ctx);
ctx.regenerateSmallMarketAutomationRules = mab.regenerateSmallMarketAutomationRules;
const scheduler = createScheduleEvaluator(ctx);
ctx.applyDvVictronControl = scheduler.applyDvVictronControl;
ctx.applyControlTarget = scheduler.applyControlTarget;
const forecast = createForecastService(ctx);
ctx.forecastService = forecast;

// Phase 07 Plan 07-04: Wave-2 forecast services wired for routes-api.js consumption.
// - pvnodeQuota: single quota authority (REVIEWS L2). Backs /api/forecast/pvnode/quota.
// - pvnodeBackfill: admin-triggered 6-month history backfill (Plan 07-03). Backs
//   POST /api/admin/backfill + GET /api/admin/backfill/status.
// - forecastSnapshots: event-driven authoritative + 00:05 recovery-fallback scheduler
//   (REVIEWS L3). writeSnapshot fired by pv-forecast.js after each successful forecastVersion
//   bump with source='forecast_version_bump'.
const pvnodeQuota = createPvnodeQuota(ctx, { store: forecast.store });
const pvnodeBackfill = createPvnodeBackfill(ctx, {
  pvnodeClient: forecast.pvnodeClient,
  quota: pvnodeQuota,
  store: forecast.store,
  forecastService: forecast
});
const forecastSnapshots = createForecastSnapshots(ctx, {
  store: forecast.store,
  forecastService: forecast
});
ctx.pvnodeQuota = pvnodeQuota;
ctx.pvnodeBackfill = pvnodeBackfill;
ctx.forecastSnapshots = forecastSnapshots;
const optimizer = createOptimizerService(ctx);
ctx.optimizerService = optimizer;
// buildFallbackStatusPayload is assigned later (line ~622) -- family service uses
// it lazily via ctx at call time, so wiring order here is safe.
const familyService = createFamilyService(ctx);
ctx.familyService = familyService;

// Phase 04: Integrations (v0.8)
// Created unconditionally so routes-api.js can access them via ctx.
// Started conditionally in IS_RUNTIME_PROCESS block below.
const mqttHub = createMqttHub(ctx);
ctx.mqttHub = mqttHub;
const mqttPublisher = createMqttPublisher(mqttHub, ctx);
ctx.mqttPublisher = mqttPublisher;
const mqttTopicObserver = createMqttTopicObserver(mqttHub, ctx);
ctx.mqttTopicObserver = mqttTopicObserver;
const teslamateService = createTeslamateSubscriber(mqttHub, ctx);
ctx.teslamateService = teslamateService;
const familyMqttTiles = createFamilyMqttTiles(mqttHub, ctx);
ctx.familyMqttTiles = familyMqttTiles;
const deviceService = createDeviceService(ctx, mqttHub);
ctx.deviceService = deviceService;
const notificationService = createNotificationService(ctx);
ctx.notificationService = notificationService;

// Phase 09.4 gap-closure (Gap 3 step 3): Uptime Kuma alert-push hook. The
// notification service calls ctx.monitoringAlertPush(status, msg) whenever it
// dispatches a notification; that routes through the SAME signed/SSRF-guarded
// send path as the monitoring heartbeat. `monitoringHeartbeatSend` is (re)set
// by startMonitoringHeartbeat() — null when no/blocked pushUrl, in which case
// the hook is a safe no-op. A stable wrapper on ctx survives heartbeat reloads.
let monitoringHeartbeatSend = null;
ctx.monitoringAlertPush = (status, msg) => {
  if (typeof monitoringHeartbeatSend !== 'function') return Promise.resolve();
  try { return Promise.resolve(monitoringHeartbeatSend(msg, status)); }
  catch { return Promise.resolve(); }
};

// Phase 05: ML & Edge-AI (v0.9)
const mlService = createMlService(ctx);
ctx.mlService = mlService;
// Phase 07 MLAI-08 REVIEWS H12: async retrain job registry — POST /api/ml/retrain
// returns 202 + jobId and the heavy work runs in a background Promise tracked here.
const mlRetrainJobs = createRetrainJobs(ctx);
ctx.mlRetrainJobs = mlRetrainJobs;
const llmService = createLlmService(ctx);
ctx.llmService = llmService;

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
  return saveAndApplyConfig(restoreRedacted(incomingConfig, rawCfg));
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

// SEC-01: REDACTED_PATHS + restoreRedacted imported from config-redaction.js (shared module)

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

    const reqStart = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - reqStart;
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
    });

    // Plan 08-04 Task 2 Step 5: CORS allowlist + Host-header guard.
    // Previous implementation echoed any same-Host origin back — which made
    // a cross-origin request from http://<lan-ip>:port (attacker-controlled
    // DNS rebind / same-Host redirect) appear trusted. Now we only emit
    // ACAO when the origin is in cfg.corsAllowedOrigins (explicit operator
    // opt-in). Host header is already re-checked inside routes.handleRequest
    // but we short-circuit OPTIONS here to avoid routing preflights into auth.
    const cfgForCors = ctx.getCfg();
    const originHeader = String(req.headers.origin || '');
    const allowedOrigin = originHeader
      ? resolveCorsAllowedOrigin(originHeader, cfgForCors)
      : null;

    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      // If an Origin was sent, it MUST be on the allowlist — otherwise 403.
      // If no Origin was sent, it's a same-origin preflight quirk; 204 with no
      // ACAO is safe.
      if (originHeader && !allowedOrigin) {
        res.writeHead(403, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'cors_origin_not_allowed' }));
        return;
      }
      const preflightHeaders = { ...SECURITY_HEADERS };
      if (allowedOrigin) {
        preflightHeaders['Access-Control-Allow-Origin'] = allowedOrigin;
        preflightHeaders['Vary'] = 'Origin';
        preflightHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        preflightHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Session-Id';
        preflightHeaders['Access-Control-Max-Age'] = '600';
      }
      res.writeHead(204, preflightHeaders);
      res.end();
      return;
    }

    // For non-OPTIONS requests, set ACAO only when the origin is explicitly
    // allowed. Never echo unlisted origins — that would re-open the flaw.
    if (allowedOrigin && url.pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
    }

    // All routes handled by routes-api.js
    const handled = await routes.handleRequest(req, res, url);
    if (handled !== false) return;

    // Static file fallback
    return routes.serveStatic(req, res);
  } catch (e) {
    console.error('HTTP handler error:', e);
    pushLog('route_dispatch_error', {
      path: req.url,
      method: req.method,
      error: e?.message ?? String(e),
      statusCode: Number.isInteger(e?.statusCode) ? e.statusCode : 500
    });
    if (!res.headersSent) {
      res.writeHead(Number.isInteger(e?.statusCode) ? e.statusCode : 500,
        { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e?.statusCode ? e.message : 'internal server error' }));
    }
  }
});

const telemetryReady = (async () => {
  telemetryStore = await createTelemetryStoreIfEnabled();
  ctx.telemetryStore = telemetryStore;
  // dbPool already set inside createTelemetryStoreIfEnabled() — ctx.db getter reads it
  // Phase 09.2 D-01: per-system health tracker. Pool comes from dbPool (shared
  // pg.Pool used by telemetryStore); recordSample hooks fire from polling.js,
  // epex-fetch.js, and services/mqtt/publisher.js. Tracker is created here so
  // that ctx.healthTracker is available before forecast.start() / scheduler
  // ticks reference ctx via getCfg-aware closures. Hook callers use optional
  // chaining (`ctx.healthTracker?.recordSample(...)`) to defend against the
  // window between poller.start() (line ~1244) and this assignment.
  const healthTracker = createIntegrationsHealthTracker({
    pool: dbPool,
    getCfg: ctx.getCfg,
    pushLog: ctx.pushLog
  });
  ctx.healthTracker = healthTracker;
  // D-02: rehydrate from integration_health_snapshots. Failures are logged
  // internally (no throw) — empty state is a safe fallback.
  await healthTracker.loadSnapshot();
  ctx.publishRuntimeSnapshot = publishRuntimeSnapshot;
  ctx.onEvalComplete = () => publishRuntimeSnapshot();
  ctx.onPollComplete = ({ ts, resolutionSeconds, meter, victron }) => {
    liveTelemetryBuffer?.capture({ ts, resolutionSeconds, meter, victron });
    liveTelemetryBuffer?.flush();
    publishRuntimeSnapshot();
    // Phase 04: Fire-and-forget notification evaluation on each poll cycle
    notificationService.evaluate(state, Date.now()).catch(err =>
      pushLog('notification_eval_error', { error: err.message })
    );
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
    telemetryConfig: cfg.telemetry || {},
    getEpexConfig: () => cfg.epex || {}
  }) : null;
  ctx.historyImportManager = historyImportManager;
  if (IS_RUNTIME_PROCESS && historyImportManager) historyImportManager.startAutomaticBackfill();
  historyRuntime = telemetryStore ? createHistoryRuntime({
    store: telemetryStore,
    getPricingConfig: () => cfg.userEnergyPricing || {},
    getOptimizerConfig: () => cfg.optimizer || {},
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
  // Phase 09.3-01: history-viz aggregator (per-card endpoints under
  // /api/history/viz/*). Read-only PG aggregation with 5min in-process cache.
  // Factory is synchronous (no schema bootstrap per D-10) — reads ctx.db /
  // ctx.telemetryStore lazily on first request, by which time both are wired.
  ctx.historyVizApi = createHistoryVizAggregator(ctx);
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

  // HTTPS with self-signed cert (optional)
  const httpsPort = cfg.httpsPort || null;
  const configDir = path.dirname(CONFIG_PATH);
  const tlsCert = cfg.tlsCertPath || path.join(configDir, 'tls', 'cert.pem');
  const tlsKey = cfg.tlsKeyPath || path.join(configDir, 'tls', 'key.pem');
  if (httpsPort) {
    try {
      const certData = fs.readFileSync(tlsCert);
      const keyData = fs.readFileSync(tlsKey);
      // Plan 08-05 Task 1: TLS floor at 1.2 + AEAD-only cipher allowlist +
      // server-honoured cipher order. Blocks SSLv3/TLSv1.0/TLSv1.1 downgrades
      // and weak-cipher negotiation (3DES/RC4/CBC-SHA1).
      const webTls = https.createServer({
        cert: certData,
        key: keyData,
        minVersion: TLS_MIN_VERSION,
        ciphers: TLS_ALLOWED_CIPHERS,
        honorCipherOrder: true
      }, web.listeners('request')[0]);
      webTls.listen(httpsPort, () => {
        console.log(`HTTPS server listening on :${httpsPort}`);
      });
      webTls.on('error', (err) => {
        console.error(`HTTPS server error: ${err.message}`);
      });
    } catch (e) {
      console.warn(`HTTPS disabled: ${e.message}`);
    }
  }
}

if (IS_RUNTIME_PROCESS) {
  loadEnergy(state, ENERGY_PATH, cfg.epex.timezone);
  modbus.start();
  // Phase 04: Start integration services (runtime-only — MQTT connections, device polling, notifications)
  mqttHub.start().then(() => {
    mqttPublisher.start().catch(err => console.error('MQTT Publisher start error:', err.message));
    mqttTopicObserver.start();   // sync — registers the '#' subscription (Phase 09.4 D-05)
    teslamateService.start().catch(err => console.error('TeslaMate start error:', err.message));
    familyMqttTiles.start().catch(err => console.error('Family MQTT tiles start error:', err.message));
    try {
      publishHaDiscoveryTopics(mqttHub, ctx.getCfg);
    } catch (err) {
      console.error('HA Discovery error:', err.message);
    }
  }).catch(err => console.error('MQTT Hub start error:', err.message));
  deviceService.start().catch(err => console.error('Device service start error:', err.message));
  notificationService.start().catch(err => console.error('Notification service start error:', err.message));
  mlService.start().catch(err => console.error('ML service start error:', err.message));
  llmService.start().catch(err => console.error('LLM service start error:', err.message));
  if (cfg.vpn?.enabled && cfg.vpn?.autoConnect) {
    vpnManager.start().catch(err => {
      pushLog('vpn_start_error', { error: err.message }, 'error');
    });
  }
  setInterval(() => {
    try { expireLeaseIfNeeded(); }
    catch (err) { pushLog('expire_lease_interval_error', { error: err?.message ?? String(err) }); }
  }, 1000);
  setInterval(() => {
    try { liveTelemetryBuffer?.flush(); }
    catch (err) { pushLog('live_telemetry_flush_error', { error: err?.message ?? String(err) }); }
  }, 1000);
  setInterval(() => {
    try { publishRuntimeSnapshot(); }
    catch (err) { pushLog('runtime_snapshot_publish_error', { error: err?.message ?? String(err) }); }
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
  // forecast.start() needs dbPool — wait for telemetry IIFE to finish first
  telemetryReady.then(() => {
    forecast.start().catch(err => console.error('Forecast service start error:', err.message));
    // Phase 07 Plan 07-04: REVIEWS L3 recovery-fallback scheduler (00:05 local daily).
    // The authoritative event-driven path fires from pv-forecast.js after each bumpForecastVersion.
    forecastSnapshots.start();
  });
  optimizer.start().catch(err => console.error('Optimizer service start error:', err.message));
  familyService.start().catch(err => console.error('Family service start error:', err.message));
  // Rollups and retention are handled by TimescaleDB continuous aggregates and retention policies
  setInterval(() => {
    startAutomaticMarketValueBackfill().catch(err => {
      pushLog('market_value_backfill_error', { error: err?.message ?? String(err) });
    });
  }, MARKET_VALUE_BACKFILL_INTERVAL_MS);

  // Remote monitoring heartbeat (hot-reloadable)
  let monitoringTimerId = null;
  // Plan 08-04 Task 2 Step 4: SSRF guard for monitoring.pushUrl. The heartbeat
  // is a legitimate outbound call (Uptime Kuma / hosted monitor), but the URL
  // comes from config and could be weaponised to pivot into internal networks
  // from the Pi. Require https:, reject loopback / RFC1918 / link-local so the
  // heartbeat can ONLY leave the LAN.
  function isAllowedHeartbeatUrl(raw) {
    try {
      const u = new URL(String(raw || ''));
      if (u.protocol !== 'https:') return false;
      const host = u.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
      const parts = host.split('.').map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        if (parts[0] === 10) return false;                                      // 10.0.0.0/8
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false; // 172.16.0.0/12
        if (parts[0] === 192 && parts[1] === 168) return false;                 // 192.168.0.0/16
        if (parts[0] === 169 && parts[1] === 254) return false;                 // 169.254.0.0/16 (link-local)
      }
      return true;
    } catch { return false; }
  }
  function startMonitoringHeartbeat() {
    if (monitoringTimerId) { clearInterval(monitoringTimerId); monitoringTimerId = null; }
    // Phase 09.4 gap-closure: clear the alert-push hook up front. It is only
    // re-armed below once an allowed pushUrl is confirmed — so a removed or
    // blocked URL leaves ctx.monitoringAlertPush as a safe no-op.
    monitoringHeartbeatSend = null;
    const pushUrl = cfg.monitoring?.pushUrl || '';
    const intervalMs = (Number(cfg.monitoring?.pushIntervalSec) || 240) * 1000;
    if (!pushUrl) return;
    // Plan 08-04 Task 2 Step 4: refuse to start the heartbeat at all when the
    // configured URL is not an allowed external HTTPS target. A misconfigured
    // URL just means "no heartbeat" — never "silently pivot to internal host".
    if (!isAllowedHeartbeatUrl(pushUrl)) {
      const safe = redactUrlCreds(pushUrl);
      // Plan 09-06 (D-08): heartbeat block is the 6th D-08 heavy-hitter — routed through services/log.js wrapper.
      logWarn('Monitoring heartbeat disabled — pushUrl blocked (https+external only)', { url: safe.substring(0, 80) });
      pushLog('monitoring_heartbeat_blocked', { reason: 'host_not_allowed', url: safe }, 'warn');
      return;
    }
    // Plan 08-05 Task 1: HMAC-SHA256 sign the outbound heartbeat so the
    // monitoring endpoint can verify origin (prevents LAN attackers from
    // forging "DVhub OK" pings to silence a compromised appliance). The
    // Uptime-Kuma push API is GET-based, so we sign the canonical payload
    // `${event}|${ts}|${host}|${version}` and ship the signature in a
    // request header. Endpoints that ignore the header still work (backward
    // compat); endpoints that know the shared signingKey can verify.
    const signingKey = cfg.monitoring?.signingKey || '';
    const hostname = os.hostname();
    const appVersion = APP_VERSION?.version || '';
    // Phase 09.4 gap-closure (Gap 3 step 3): `status` is now a parameter so the
    // same signed/SSRF-guarded send path serves BOTH the periodic heartbeat
    // (status='up') and notification alert-pushes (status='up'|'down'). Default
    // 'up' keeps every existing caller byte-identical.
    const sendHeartbeat = async (msg, status = 'up') => {
      try {
        const ts = Date.now();
        const payload = `${msg}|${ts}|${hostname}|${appVersion}`;
        const sig = signingKey
          ? 'sha256=' + crypto.createHmac('sha256', signingKey).update(payload).digest('hex')
          : 'unsigned';
        const sep = pushUrl.includes('?') ? '&' : '?';
        const kumaStatus = status === 'down' ? 'down' : 'up';
        await fetch(pushUrl + sep + 'status=' + kumaStatus + '&msg=' + encodeURIComponent(msg) + '&ping=', {
          signal: AbortSignal.timeout(10000),
          headers: {
            'x-dvhub-signature': sig,
            'x-dvhub-ts': String(ts),
            'x-dvhub-host': hostname,
            'x-dvhub-version': appVersion
          }
        });
      } catch (e) {
        pushLog('heartbeat_send_error', { error: e?.message ?? String(e) });
      }
    };
    // Arm the alert-push hook — ctx.monitoringAlertPush() now routes here.
    monitoringHeartbeatSend = sendHeartbeat;
    monitoringTimerId = setInterval(() => sendHeartbeat('DVhub OK | SOC ' + (state.victron?.soc ?? '?') + '%'), intervalMs);
    setTimeout(() => sendHeartbeat('DVhub started'), 5000);
    // Plan 08-03 Task 2: run through redactUrlCreds before any logging/exposure so that
    // `https://user:token@push.example/uk` never appears in journalctl or systemd logs.
    const safePushUrl = redactUrlCreds(pushUrl);
    // Plan 09-06 (D-08): heartbeat block is the 6th D-08 heavy-hitter — routed through services/log.js wrapper.
    logInfo('Monitoring heartbeat configured', { url: safePushUrl.substring(0, 60) });
  }
  startMonitoringHeartbeat();
}

async function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  // Tell the runtime-worker exit handler not to respawn while we tear down.
  shuttingDown = true;

  const safeSync = (step, fn) => {
    try { fn(); }
    catch (err) { pushLog('shutdown_step_error', { step, error: err?.message ?? String(err) }); }
  };
  const safeAsync = (step, fn) =>
    Promise.resolve()
      .then(() => fn())
      .catch(err => pushLog('shutdown_step_error', { step, error: err?.message ?? String(err) }));

  // 1. Sync best-effort stops — pollers/timers must stop before async closes
  //    so they don't re-enter into a tearing-down store.
  safeSync('poller.stop', () => poller.stop());
  safeSync('scheduler.stop', () => scheduler.stop());
  safeSync('liveTelemetryBuffer.flush', () => liveTelemetryBuffer?.flush({ force: true }));
  safeSync('epex.stop', () => epex.stop());
  // Phase 07 Plan 07-04: stop Wave-2 recovery scheduler before forecast.close() tears down the store.
  safeSync('forecastSnapshots.close', () => forecastSnapshots.close());

  // 2. Parallel async closes — one rejection must NOT block the others.
  //    Order-of-init is preserved only where needed (forecastSnapshots before forecast above).
  await Promise.all([
    safeAsync('forecast.close', () => forecast.close()),
    safeAsync('optimizer.close', () => optimizer.close()),
    safeAsync('familyService.close', () => familyService.close()),
    safeAsync('llmService.close', () => llmService.close()),
    safeAsync('mlService.close', () => mlService.close()),
    safeAsync('notificationService.close', () => notificationService.close()),
    safeAsync('deviceService.close', () => deviceService.close()),
    safeAsync('teslamateService.close', () => teslamateService.close()),
    safeAsync('familyMqttTiles.close', () => familyMqttTiles.close()),
    safeAsync('mqttTopicObserver.close', () => mqttTopicObserver.close()),
    safeAsync('mqttPublisher.close', () => mqttPublisher.close()),
    safeAsync('mqttHub.close', () => mqttHub.close()),
    // Close Modbus TCP connections gracefully (FIN, not RST)
    safeAsync('transport.destroy', () => transport.destroy()),
    safeAsync('scanTransport.destroy', () => scanTransport.destroy()),
    safeAsync('vpnManager.close', () => vpnManager.close()),
    // Phase 09.2 D-02: persist health-tracker snapshots BEFORE pool teardown.
    // Lives inside Promise.all (section 2) so the pg.Pool used by UPSERT is
    // still alive — telemetryStore.close() runs in section 3 below.
    safeAsync('healthTracker.persistSnapshot', () => ctx.healthTracker?.persistSnapshot())
  ]);

  // 3. Sync teardown of remaining handles
  if (runtimeWorker) safeSync('runtimeWorker.kill', () => runtimeWorker.kill());
  if (telemetryStore) safeSync('telemetryStore.close', () => telemetryStore.close());
  safeSync('modbus.close', () => modbus.close());
  if (IS_WEB_PROCESS) safeSync('web.close', () => web.close());

  // Short delay to let TCP FIN packets flush before exiting
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  pushLog('unhandled_rejection', { error: String(reason?.message || reason) }, 'error');
  try { poller.stop(); } catch {}
  liveTelemetryBuffer?.flush({ force: true });
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  pushLog('uncaught_exception', { error: String(err?.message || err) }, 'error');
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
