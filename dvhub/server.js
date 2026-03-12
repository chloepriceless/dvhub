import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
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
import { createTelemetryStore } from './telemetry-store.js';
import {
  buildLiveTelemetrySamples,
  buildOptimizerRunPayload,
  buildPriceTelemetrySamples,
  resolveTelemetryDbPath
} from './telemetry-runtime.js';
import {
  createSerialTaskRunner,
  createTelemetryWriteBuffer,
  normalizePollIntervalMs
} from './runtime-performance.js';
import { createRuntimeCommandRequest, validateRuntimeCommand } from './runtime-commands.js';
import {
  buildHistoryImportStatusResponse,
  buildRuntimeSnapshot,
  buildWorkerBackedStatusResponse
} from './runtime-state.js';
import { RUNTIME_MESSAGE_TYPES, startRuntimeWorker } from './runtime-worker-protocol.js';
import { createHistoryApiHandlers, createHistoryRuntime } from './history-runtime.js';
import { createEnergyChartsMarketValueService } from './energy-charts-market-values.js';
import { createBundesnetzagenturApplicableValueService } from './bundesnetzagentur-applicable-values.js';
import { readAppVersionInfo } from './app-version.js';
import {
  buildAutomationRuleChain,
  filterFreeAutomationSlots,
  pickBestAutomationPlan
} from './small-market-automation.js';
import {
  buildSunTimesCacheKey,
  isSunTimesCacheStale,
  readSunTimesCacheStore
} from './sun-times-cache.js';
import {
  autoDisableStopSocScheduleRules,
  autoDisableExpiredScheduleRules,
  parseHHMM,
  sanitizePersistedScheduleRules,
  scheduleMatch
} from './schedule-runtime.js';
import { createHistoryImportManager } from './history-import.js';
import { createModbusTransport } from './transport-modbus.js';
import { createMqttTransport } from './transport-mqtt.js';
import { discoverSystems as discoverConfiguredSystems } from './system-discovery.js';

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
const MIN_POLL_INTERVAL_MS = 1000;
const MARKET_VALUE_BACKFILL_INTERVAL_MS = 30 * 60 * 1000;
const MARKET_VALUE_BACKFILL_MAX_YEARS_PER_RUN = 2;
const SMALL_MARKET_AUTOMATION_SOURCE = 'small_market_automation';
const SMALL_MARKET_AUTOMATION_DISPLAY_TONE = 'yellow';
const SLOT_DURATION_MS = 15 * 60 * 1000;
const RUNTIME_WORKER_ENABLED = process.env.DVHUB_ENABLE_RUNTIME_WORKER === '1';
const PROCESS_ROLE = process.env.DVHUB_PROCESS_ROLE || (RUNTIME_WORKER_ENABLED ? 'web' : 'monolith');
const IS_WEB_PROCESS = PROCESS_ROLE === 'web' || PROCESS_ROLE === 'monolith';
const IS_RUNTIME_PROCESS = PROCESS_ROLE === 'runtime-worker' || PROCESS_ROLE === 'monolith';

const state = {
  dvRegs: { 0: 0, 1: 0, 3: 0, 4: 0 },
  ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: Date.now() },
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
      defaultChargeCurrentA: cfg.schedule.defaultChargeCurrentA
    },
    active: { gridSetpointW: null, chargeCurrentA: null },
    lastWrite: { gridSetpointW: null, chargeCurrentA: null },
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
const effectivePollIntervalMs = () => normalizePollIntervalMs(cfg.meterPollMs, MIN_POLL_INTERVAL_MS);

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

function buildDefaultAutomationChain(automationConfig = {}) {
  const stages = Array.isArray(automationConfig?.stages) && automationConfig.stages.length
    ? automationConfig.stages
    : [{
      dischargeW: automationConfig?.maxDischargeW,
      dischargeSlots: automationConfig?.targetSlotCount,
      cooldownSlots: 0
    }];
  return buildAutomationRuleChain({
    maxDischargeW: automationConfig?.maxDischargeW,
    stages
  });
}

function buildSearchWindowBounds({ data = [], automationConfig = {}, timeZone = cfg.schedule?.timezone || 'Europe/Berlin' } = {}) {
  const startMin = parseHHMM(automationConfig?.searchWindowStart);
  const endMin = parseHHMM(automationConfig?.searchWindowEnd);
  if (startMin == null || endMin == null) return [];

  return (Array.isArray(data) ? data : []).filter((slot) => {
    const minuteOfDay = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(slot.ts));
    const hours = Number(minuteOfDay.find((part) => part.type === 'hour')?.value);
    const minutes = Number(minuteOfDay.find((part) => part.type === 'minute')?.value);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false;
    const slotMin = hours * 60 + minutes;
    if (startMin <= endMin) return slotMin >= startMin && slotMin < endMin;
    return slotMin >= startMin || slotMin < endMin;
  });
}

function buildSmallMarketAutomationRules({
  now = Date.now(),
  automationConfig = cfg.schedule?.smallMarketAutomation,
  priceSlots = state.epex?.data,
  occupiedRules = state.schedule.rules,
  sunTimesCache = getSunTimesCacheForPlanning({ now })
} = {}) {
  if (!automationConfig?.enabled || !sunTimesCache) return [];

  const filteredPriceSlots = buildSearchWindowBounds({
    data: priceSlots,
    automationConfig
  });
  const timeZone = cfg.schedule?.timezone || 'Europe/Berlin';
  const dateStr = berlinDateString(new Date(now));
  const refDate = new Date(`${dateStr}T12:00:00Z`);
  const utcMs = refDate.getTime();
  const localStr = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).format(refDate);
  const [dPart, tPart] = localStr.split(', ');
  const [dd, mm, yyyy] = dPart.split('/');
  const localRef = new Date(`${yyyy}-${mm}-${dd}T${tPart}Z`);
  const offsetMs = localRef.getTime() - utcMs;
  const offsetSign = offsetMs >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMs);
  const offsetH = String(Math.floor(absOffset / 3600000)).padStart(2, '0');
  const offsetM = String(Math.floor((absOffset % 3600000) / 60000)).padStart(2, '0');
  const tzSuffix = `${offsetSign}${offsetH}:${offsetM}`;
  const occupiedWindows = (Array.isArray(occupiedRules) ? occupiedRules : [])
    .filter((rule) => rule?.source !== SMALL_MARKET_AUTOMATION_SOURCE)
    .map((rule) => ({
      startTs: Date.parse(`${dateStr}T${rule.start || '00:00'}:00${tzSuffix}`),
      endTs: Date.parse(`${dateStr}T${rule.end || '00:00'}:00${tzSuffix}`),
      source: rule?.source || 'manual'
    }))
    .filter((window) => Number.isFinite(window.startTs) && Number.isFinite(window.endTs));

  const freeSlots = filterFreeAutomationSlots({
    slots: filteredPriceSlots,
    occupiedWindows
  });
  const chain = buildDefaultAutomationChain(automationConfig);
  const plan = pickBestAutomationPlan({
    slots: freeSlots,
    targetSlotCount: Number(automationConfig?.targetSlotCount || chain.length || 0),
    chainOptions: [chain]
  });

  return (plan.selectedSlotTimestamps || []).map((slotTs, index) => {
    const slot = freeSlots.find((entry) => Number(entry?.ts) === Number(slotTs));
    if (!slot) return null;
    const start = new Date(slot.ts);
    const end = new Date(slot.ts + SLOT_DURATION_MS);
    return {
      id: `sma-${slotTs}-${index + 1}`,
      enabled: true,
      target: 'gridSetpointW',
      start: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }),
      end: end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }),
      value: Number(chain[index]?.powerW ?? automationConfig?.maxDischargeW ?? -40),
      activeDate: berlinDateString(new Date(now)),
      source: SMALL_MARKET_AUTOMATION_SOURCE,
      autoManaged: true,
      displayTone: SMALL_MARKET_AUTOMATION_DISPLAY_TONE
    };
  }).filter(Boolean);
}

function regenerateSmallMarketAutomationRules({ now = Date.now() } = {}) {
  const automationConfig = cfg.schedule?.smallMarketAutomation;
  const runDate = berlinDateString(new Date(now));
  const manualRules = state.schedule.rules.filter((rule) => rule?.source !== SMALL_MARKET_AUTOMATION_SOURCE);
  const previousAutomationRules = state.schedule.rules.filter((rule) => rule?.source === SMALL_MARKET_AUTOMATION_SOURCE);

  if (!automationConfig?.enabled) {
    state.schedule.smallMarketAutomation = {
      lastRunDate: runDate,
      lastOutcome: 'disabled',
      generatedRuleCount: 0
    };
    if (previousAutomationRules.length) {
      state.schedule.rules = manualRules;
      persistConfig();
    }
    return;
  }

  const lastState = state.schedule.smallMarketAutomation;
  const priceSlotCount = Array.isArray(state.epex?.data) ? state.epex.data.length : 0;
  const priceDataChanged = priceSlotCount !== (lastState?.lastPriceSlotCount || 0);
  if (lastState?.lastRunDate === runDate && previousAutomationRules.length && !priceDataChanged) return;

  const sunTimesCache = getSunTimesCacheForPlanning({ now });
  const generatedRules = buildSmallMarketAutomationRules({
    now,
    automationConfig,
    priceSlots: state.epex?.data,
    occupiedRules: manualRules,
    sunTimesCache
  });
  state.schedule.rules = [...manualRules, ...generatedRules];
  state.schedule.smallMarketAutomation = {
    lastRunDate: runDate,
    lastOutcome: sunTimesCache ? (generatedRules.length ? 'generated' : 'no_slots') : 'missing_sun_times_cache',
    generatedRuleCount: generatedRules.length,
    lastPriceSlotCount: priceSlotCount
  };
  persistConfig();
}

function applyLoadedConfig(nextLoadedConfig) {
  loadedConfig = nextLoadedConfig;
  rawCfg = nextLoadedConfig.rawConfig;
  cfg = nextLoadedConfig.effectiveConfig;
  state.keepalive.appPulse.periodSec = cfg.keepalivePulseSec;
  state.schedule.rules = Array.isArray(cfg.schedule.rules) ? cfg.schedule.rules : [];
  state.schedule.config.defaultGridSetpointW = cfg.schedule.defaultGridSetpointW;
  state.schedule.config.defaultChargeCurrentA = cfg.schedule.defaultChargeCurrentA;
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
    saveAndApplyConfig(current);
    telemetrySafeWrite(() => telemetryStore.writeScheduleSnapshot({
      ts: new Date(),
      rules: current.schedule.rules,
      defaultGridSetpointW: state.schedule.config.defaultGridSetpointW,
      defaultChargeCurrentA: state.schedule.config.defaultChargeCurrentA,
      source: 'config_persist'
    }));
  } catch (e) {
    pushLog('config_persist_error', { error: e.message });
  }
}

function createTelemetryStoreIfEnabled() {
  if (!cfg.telemetry?.enabled) return null;
  try {
    const dbPath = resolveTelemetryDbPath({
      configPath: CONFIG_PATH,
      telemetryConfig: cfg.telemetry,
      dataDir: DATA_DIR
    });
    const store = createTelemetryStore({
      dbPath,
      rawRetentionDays: Number(cfg.telemetry.rawRetentionDays || 45),
      rollupIntervals: Array.isArray(cfg.telemetry.rollupIntervals) ? cfg.telemetry.rollupIntervals : [300, 900, 3600]
    });
    state.telemetry.enabled = true;
    state.telemetry.dbPath = dbPath;
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

function refreshTelemetryStatus() {
  if (!telemetryStore) {
    state.telemetry.enabled = !!cfg.telemetry?.enabled;
    state.telemetry.ok = false;
    return;
  }
  const status = telemetryStore.getStatus();
  state.telemetry.enabled = !!cfg.telemetry?.enabled;
  state.telemetry.dbPath = status.dbPath;
  state.telemetry.ok = true;
  state.telemetry.lastWriteAt = status.lastWriteAt;
}

function buildCurrentRuntimeSnapshot() {
  return buildRuntimeSnapshot({
    now: Date.now(),
    meter: {
      ...state.meter,
      l1Dir: gridDirection(state.meter.grid_l1_w),
      l2Dir: gridDirection(state.meter.grid_l2_w),
      l3Dir: gridDirection(state.meter.grid_l3_w),
      totalDir: gridDirection(state.meter.grid_total_w),
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
    dvRegs: state.dvRegs,
    ctrl: { ...state.ctrl, dvControl: state.ctrl.dvControl || null },
    keepalive: state.keepalive,
    meter: runtimeSnapshot.meter,
    victron: runtimeSnapshot.victron,
    scan: state.scan,
    schedule: runtimeSnapshot.schedule,
    costs: costSummary(),
    userEnergyPricing: userEnergyPricingSummary(),
    epex: { ...state.epex, summary: epexNowNext() },
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

function buildApiStatusResponse(now = Date.now()) {
  const runtimeSnapshot = buildCurrentRuntimeSnapshot();
  return buildWorkerBackedStatusResponse({
    cachedStatus: getCachedRuntimeStatusPayload(),
    fallbackStatus: buildCurrentStatusPayload({ now, runtimeSnapshot }),
    setup: configMetaPayload(),
    runtime: buildRuntimeRouteMeta(now)
  });
}

function buildApiHistoryImportStatusResponse() {
  const runtimeSnapshot = buildCurrentRuntimeSnapshot();
  return buildHistoryImportStatusResponse({
    cachedStatus: getCachedRuntimeStatusPayload(),
    fallbackTelemetryEnabled: !!cfg.telemetry?.enabled,
    fallbackHistoryImport: runtimeSnapshot.historyImport
  });
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

function startAutomaticMarketValueBackfill() {
  if (!IS_RUNTIME_PROCESS || !telemetryStore || !energyChartsMarketValueService?.backfillMissingSolarMarketValues) {
    return;
  }
  const years = historicalMarketValueBackfillYears({
    bounds: telemetryStore.getTelemetryBounds()
  });
  if (!years.length) return;
  energyChartsMarketValueService.backfillMissingSolarMarketValues({
    years,
    maxYearsPerRun: MARKET_VALUE_BACKFILL_MAX_YEARS_PER_RUN
  }).catch((error) => {
    pushLog('market_value_backfill_error', { error: error.message });
  });
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

function telemetrySafeWrite(action, { updateRollup = false, updateCleanup = false } = {}) {
  if (!telemetryStore) return null;
  try {
    const result = action();
    refreshTelemetryStatus();
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

const ENERGY_PATH = path.join(__dirname, 'energy_state.json');

function persistEnergy() {
  try {
    const data = {
      day: state.energy.day,
      importWh: state.energy.importWh,
      exportWh: state.energy.exportWh,
      costEur: state.energy.costEur,
      revenueEur: state.energy.revenueEur,
      lastTs: state.energy.lastTs,
      savedAt: Date.now()
    };
    fs.writeFileSync(ENERGY_PATH, JSON.stringify(data) + '\n', 'utf8');
  } catch (e) {
    // silent - avoid recursive log if pushLog triggers persist
  }
}

function loadEnergy() {
  try {
    if (!fs.existsSync(ENERGY_PATH)) return;
    const data = JSON.parse(fs.readFileSync(ENERGY_PATH, 'utf8'));
    const today = berlinDateString();
    if (data.day === today) {
      state.energy.day = data.day;
      state.energy.importWh = Number(data.importWh) || 0;
      state.energy.exportWh = Number(data.exportWh) || 0;
      state.energy.costEur = Number(data.costEur) || 0;
      state.energy.revenueEur = Number(data.revenueEur) || 0;
      state.energy.lastTs = Number(data.lastTs) || 0;
      console.log(`Energy state restored for ${data.day}: import=${(state.energy.importWh / 1000).toFixed(2)}kWh export=${(state.energy.exportWh / 1000).toFixed(2)}kWh`);
    } else {
      console.log(`Energy state file is from ${data.day}, today is ${today} - starting fresh`);
    }
  } catch (e) {
    console.error('Failed to load energy state:', e.message);
  }
}

function nowIso() { return new Date().toISOString(); }
function fmtTs(ts) { return ts ? new Date(ts).toISOString() : '-'; }
function pushLog(event, details = {}) {
  const row = { ts: nowIso(), event, ...details };
  state.log.push(row);
  if (state.log.length > 1000) state.log.shift();
}

function resolveLogLimit(rawLimit, defaultLimit = 20, maxLimit = 200) {
  const limit = Number(rawLimit);
  if (!Number.isFinite(limit) || limit <= 0) return defaultLimit;
  return Math.min(Math.floor(limit), maxLimit);
}

function u16(v) {
  let x = Math.trunc(Number(v) || 0);
  if (x < 0) x += 0x10000;
  return x & 0xffff;
}
function s16(v) {
  const x = Number(v) & 0xffff;
  return x >= 0x8000 ? x - 0x10000 : x;
}

const MAX_BODY_BYTES = 256 * 1024; // 256 KB

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('body too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function berlinDateString(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: cfg.epex.timezone }).format(d);
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function localMinutesOfDay(date = new Date()) {
  const hh = Number(date.toLocaleString('en-GB', { timeZone: cfg.schedule.timezone, hour: '2-digit', hour12: false }));
  const mm = Number(date.toLocaleString('en-GB', { timeZone: cfg.schedule.timezone, minute: '2-digit', hour12: false }));
  return hh * 60 + mm;
}

function gridDirection(value) {
  const v = Number(value) || 0;
  const positiveFeedIn = cfg.gridPositiveMeans !== 'grid_import';
  if (v === 0) return { mode: 'neutral', label: 'neutral' };
  const exporting = positiveFeedIn ? v > 0 : v < 0;
  return exporting ? { mode: 'feed_in', label: 'Einspeisung' } : { mode: 'grid_import', label: 'Netzbezug' };
}

function expireLeaseIfNeeded() {
  if (state.ctrl.forcedOff && Date.now() > state.ctrl.offUntil) {
    state.ctrl.forcedOff = false;
    state.ctrl.offUntil = 0;
    state.ctrl.lastSignal = 'lease_expired';
    state.ctrl.updatedAt = Date.now();
    pushLog('ctrl_lease_expired');
    applyDvVictronControl(true);
  }
}

function setForcedOff(reason) {
  state.ctrl.forcedOff = true;
  state.ctrl.offUntil = Date.now() + cfg.offLeaseMs;
  state.ctrl.lastSignal = reason;
  state.ctrl.updatedAt = Date.now();
  pushLog('ctrl_off', { reason, offUntil: new Date(state.ctrl.offUntil).toISOString() });
  applyDvVictronControl(false);
}

function clearForcedOff(reason) {
  state.ctrl.forcedOff = false;
  state.ctrl.offUntil = 0;
  state.ctrl.lastSignal = reason;
  state.ctrl.updatedAt = Date.now();
  pushLog('ctrl_on', { reason });
  applyDvVictronControl(true);
}

async function applyDvVictronControl(feedIn) {
  const dc = cfg.dvControl;
  if (!dc?.enabled) return;
  const results = {};

  // Feed excess DC-coupled PV into grid: 1 = feed, 0 = block
  if (dc.feedExcessDcPv?.enabled) {
    const val = feedIn ? 1 : 0;
    try {
      if (transport.type === 'mqtt') {
        await transport.mqttWrite('feedExcessDcPv', val);
      } else {
        await transport.mbWriteSingle({
          host: dc.feedExcessDcPv.host, port: dc.feedExcessDcPv.port,
          unitId: dc.feedExcessDcPv.unitId, address: dc.feedExcessDcPv.address,
          value: val, timeoutMs: dc.feedExcessDcPv.timeoutMs
        });
      }
      results.feedExcessDcPv = { ok: true, value: val };
      pushLog('dv_victron_write', { register: 'feedExcessDcPv', address: dc.feedExcessDcPv.address, value: val, feedIn });
    } catch (e) {
      results.feedExcessDcPv = { ok: false, error: e.message };
      pushLog('dv_victron_write_error', { register: 'feedExcessDcPv', error: e.message });
    }
  }

  // Don't feed excess AC-coupled PV into grid: 1 = block, 0 = allow
  if (dc.dontFeedExcessAcPv?.enabled) {
    const val = feedIn ? 0 : 1;
    try {
      if (transport.type === 'mqtt') {
        await transport.mqttWrite('dontFeedExcessAcPv', val);
      } else {
        await transport.mbWriteSingle({
          host: dc.dontFeedExcessAcPv.host, port: dc.dontFeedExcessAcPv.port,
          unitId: dc.dontFeedExcessAcPv.unitId, address: dc.dontFeedExcessAcPv.address,
          value: val, timeoutMs: dc.dontFeedExcessAcPv.timeoutMs
        });
      }
      results.dontFeedExcessAcPv = { ok: true, value: val };
      pushLog('dv_victron_write', { register: 'dontFeedExcessAcPv', address: dc.dontFeedExcessAcPv.address, value: val, feedIn });
    } catch (e) {
      results.dontFeedExcessAcPv = { ok: false, error: e.message };
      pushLog('dv_victron_write_error', { register: 'dontFeedExcessAcPv', error: e.message });
    }
  }

  state.ctrl.dvControl = { feedIn, ...results, at: Date.now() };
}

function controlValue() {
  expireLeaseIfNeeded();
  return state.ctrl.forcedOff ? 0 : 1;
}

function setReg(addr, value) { state.dvRegs[addr] = u16(value); }
function getReg(addr) { return u16(state.dvRegs[addr] ?? 0); }

function buildException(tid, unit, fc, code) {
  const b = Buffer.alloc(9);
  b.writeUInt16BE(tid, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(3, 4);
  b.writeUInt8(unit, 6);
  b.writeUInt8((fc | 0x80) & 0xff, 7);
  b.writeUInt8(code, 8);
  return b;
}

function buildReadResp(tid, unit, fc, addr, qty) {
  const byteCount = qty * 2;
  const out = Buffer.alloc(9 + byteCount);
  out.writeUInt16BE(tid, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(3 + byteCount, 4);
  out.writeUInt8(unit, 6);
  out.writeUInt8(fc, 7);
  out.writeUInt8(byteCount, 8);
  const regs = [];
  for (let i = 0; i < qty; i++) {
    const v = getReg(addr + i);
    regs.push(v);
    out.writeUInt16BE(v, 9 + i * 2);
  }
  return { out, regs };
}

function handleWriteSignal(addr, values) {
  if (addr === 0 && values.length >= 2) {
    if (values[0] === 0 && values[1] === 0) return setForcedOff('fc16_addr0_0000');
    if (values[0] === 0xffff && values[1] === 0xffff) return clearForcedOff('fc16_addr0_ffff');
  }
  if (addr === 3 && values.length >= 1) {
    if (values[0] === 1) return setForcedOff('fc16_addr3_0001');
    if (values[0] === 0) return clearForcedOff('fc16_addr3_0000');
  }
}

function rememberModbusQuery({ remote, fc, addr, qty, sample }) {
  state.keepalive.modbusLastQuery = {
    ts: Date.now(),
    remote,
    fc,
    addr,
    qty,
    sample
  };
}

function processModbusFrame(frame, remote) {
  if (frame.length < 8) return null;
  const tid = frame.readUInt16BE(0);
  const pid = frame.readUInt16BE(2);
  const len = frame.readUInt16BE(4);
  if (pid !== 0 || len < 2 || frame.length < 6 + len) return null;
  const unit = frame.readUInt8(6);
  const fc = frame.readUInt8(7);

  expireLeaseIfNeeded();

  if (fc === 3 || fc === 4) {
    if (len < 6) return buildException(tid, unit, fc, 3);
    const addr = frame.readUInt16BE(8);
    const qty = frame.readUInt16BE(10);
    if (qty < 1 || qty > 125) return buildException(tid, unit, fc, 3);
    const { out, regs } = buildReadResp(tid, unit, fc, addr, qty);
    rememberModbusQuery({ remote, fc, addr, qty, sample: regs.slice(0, 8) });
    return out;
  }

  if (fc === 6) {
    if (len < 6) return buildException(tid, unit, fc, 3);
    const addr = frame.readUInt16BE(8);
    const val = frame.readUInt16BE(10);
    setReg(addr, val);
    handleWriteSignal(addr, [val]);
    pushLog('modbus_fc6', { remote, addr, value: val, forcedOff: state.ctrl.forcedOff });
    return frame.subarray(0, 12);
  }

  if (fc === 16) {
    if (len < 7) return buildException(tid, unit, fc, 3);
    const addr = frame.readUInt16BE(8);
    const qty = frame.readUInt16BE(10);
    const bc = frame.readUInt8(12);
    if (bc !== qty * 2) return buildException(tid, unit, fc, 3);
    if (13 + bc > 6 + len) return buildException(tid, unit, fc, 3);

    const values = [];
    for (let i = 0; i < qty; i++) {
      const v = frame.readUInt16BE(13 + i * 2);
      values.push(v);
      setReg(addr + i, v);
    }
    handleWriteSignal(addr, values);
    pushLog('modbus_fc16', { remote, addr, qty, values, forcedOff: state.ctrl.forcedOff });

    const ack = Buffer.alloc(12);
    ack.writeUInt16BE(tid, 0);
    ack.writeUInt16BE(0, 2);
    ack.writeUInt16BE(6, 4);
    ack.writeUInt8(unit, 6);
    ack.writeUInt8(16, 7);
    ack.writeUInt16BE(addr, 8);
    ack.writeUInt16BE(qty, 10);
    return ack;
  }

  return buildException(tid, unit, fc, 1);
}

let mbServer = null;
function startModbusServer() {
  const server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 7) {
        const len = buffer.readUInt16BE(4);
        const total = 6 + len;
        if (buffer.length < total) break;

        const frame = buffer.subarray(0, total);
        buffer = buffer.subarray(total);
        const resp = processModbusFrame(frame, remote);
        if (resp) socket.write(resp);
      }
    });
    socket.on('error', () => {});
  });

  server.listen(cfg.modbusListenPort, cfg.modbusListenHost, () => {
    console.log(`Modbus server listening on ${cfg.modbusListenHost}:${cfg.modbusListenPort}`);
  });
  mbServer = server;
}

// Modbus-Client-Funktionen sind jetzt in transport-modbus.js / transport-mqtt.js

function pointFromRegs(regs, conf) {
  if (!regs || !regs.length) return null;
  const scale = Number(conf.scale ?? 1);
  const offset = Number(conf.offset ?? 0);
  if (conf.quantity > 1 && conf.sumRegisters) {
    let sum = 0;
    for (const r of regs) sum += conf.signed ? s16(r) : r;
    const v = sum * scale + offset;
    return Number(v.toFixed(3));
  }
  let v = regs[0];
  if (conf.signed) v = s16(v);
  v = Number(v) * scale + offset;
  return Number(v.toFixed(3));
}

function toRawForWrite(value, conf) {
  const scale = Number(conf.scale ?? 1);
  const offset = Number(conf.offset ?? 0);
  if (!Number.isFinite(scale) || scale === 0) throw new Error('invalid write scale');
  const engineeringValue = Number(value);
  if (!Number.isFinite(engineeringValue)) throw new Error('invalid write value');

  const writeTypeRaw = String(conf.writeType || (conf.signed ? 'int16' : 'uint16')).toLowerCase();
  const writeType = writeTypeRaw === 'signed' || writeTypeRaw === 's16'
    ? 'int16'
    : writeTypeRaw === 'unsigned' || writeTypeRaw === 'u16'
      ? 'uint16'
      : writeTypeRaw;
  const wordOrderRaw = String(conf.wordOrder || 'be').toLowerCase();
  const wordOrder = (wordOrderRaw === 'le' || wordOrderRaw === 'little' || wordOrderRaw === 'swapped' || wordOrderRaw === 'swap') ? 'le' : 'be';
  const scaled = Math.round((engineeringValue - offset) / scale);

  if (writeType === 'int16') {
    if (scaled < -32768 || scaled > 32767) throw new Error(`int16 range exceeded: ${scaled}`);
    const b = Buffer.allocUnsafe(2);
    b.writeInt16BE(scaled, 0);
    const raw = b.readUInt16BE(0);
    return { raw, words: [raw], scaled, writeType, wordOrder: 'be' };
  }

  if (writeType === 'uint16') {
    if (scaled < 0 || scaled > 65535) throw new Error(`uint16 range exceeded: ${scaled}`);
    const raw = scaled & 0xffff;
    return { raw, words: [raw], scaled, writeType, wordOrder: 'be' };
  }

  if (writeType === 'int32') {
    if (scaled < -2147483648 || scaled > 2147483647) throw new Error(`int32 range exceeded: ${scaled}`);
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(scaled, 0);
    const words = [b.readUInt16BE(0), b.readUInt16BE(2)];
    if (wordOrder === 'le') words.reverse();
    return { raw: words[0], words, scaled, writeType, wordOrder };
  }

  if (writeType === 'uint32') {
    if (scaled < 0 || scaled > 4294967295) throw new Error(`uint32 range exceeded: ${scaled}`);
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(scaled, 0);
    const words = [b.readUInt16BE(0), b.readUInt16BE(2)];
    if (wordOrder === 'le') words.reverse();
    return { raw: words[0], words, scaled, writeType, wordOrder };
  }

  throw new Error(`unsupported writeType: ${conf.writeType}`);
}

async function pollPoint(name, conf) {
  if (!conf?.enabled) return;
  try {
    if (transport.type === 'mqtt') {
      const result = await transport.readPoint(name);
      state.victron[name] = result.mqttValue;
    } else {
      const regs = await transport.mbRequest(conf);
      state.victron[name] = pointFromRegs(regs, conf);
    }
    delete state.victron.errors[name];
    state.victron.updatedAt = Date.now();
  } catch (e) {
    state.victron.errors[name] = e.message;
    state.victron.updatedAt = Date.now();
  }
}

function buildDvControlReadbackPollConfig(conf, victronConf) {
  const address = Number(conf?.address);
  if (!conf?.enabled || !Number.isFinite(address) || address <= 0) return null;
  return {
    enabled: true,
    fc: 3,
    address,
    quantity: 1,
    signed: false,
    scale: 1,
    offset: 0,
    host: conf.host || victronConf?.host,
    port: conf.port || victronConf?.port,
    unitId: conf.unitId ?? victronConf?.unitId,
    timeoutMs: conf.timeoutMs || victronConf?.timeoutMs
  };
}

function buildDvControlReadbackPolls(cfg) {
  return [
    ['feedExcessDcPv', buildDvControlReadbackPollConfig(cfg?.dvControl?.feedExcessDcPv, cfg?.victron)],
    ['dontFeedExcessAcPv', buildDvControlReadbackPollConfig(cfg?.dvControl?.dontFeedExcessAcPv, cfg?.victron)]
  ].filter(([, conf]) => !!conf);
}

async function pollDvControlReadback(name, conf) {
  if (transport.type !== 'modbus' || !conf?.enabled) return;
  try {
    const regs = await transport.mbRequest(conf);
    state.victron[name] = pointFromRegs(regs, conf);
    delete state.victron.errors[name];
    state.victron.updatedAt = Date.now();
  } catch (e) {
    state.victron.errors[name] = e.message;
    state.victron.updatedAt = Date.now();
  }
}

function updateEnergyIntegrals(nowMs, totalW) {
  const day = berlinDateString(new Date(nowMs));
  if (state.energy.day !== day) {
    if (state.energy.day) {
      pushLog('energy_day_end', {
        day: state.energy.day,
        importKwh: Number((state.energy.importWh / 1000).toFixed(4)),
        exportKwh: Number((state.energy.exportWh / 1000).toFixed(4)),
        costEur: Number(state.energy.costEur.toFixed(4)),
        revenueEur: Number(state.energy.revenueEur.toFixed(4))
      });
    }
    state.energy.day = day;
    state.energy.importWh = 0;
    state.energy.exportWh = 0;
    state.energy.costEur = 0;
    state.energy.revenueEur = 0;
    state.energy.lastTs = nowMs;
    persistEnergy();
    return;
  }
  if (!state.energy.lastTs) {
    state.energy.lastTs = nowMs;
    return;
  }
  const dtH = Math.max(0, (nowMs - state.energy.lastTs) / 3600000);
  state.energy.lastTs = nowMs;
  if (dtH <= 0) return;

  const dir = gridDirection(totalW);
  const pAbs = Math.abs(Number(totalW) || 0);
  const importW = dir.mode === 'grid_import' ? pAbs : 0;
  const exportW = dir.mode === 'feed_in' ? pAbs : 0;
  state.energy.importWh += importW * dtH;
  state.energy.exportWh += exportW * dtH;

  const priceCt = Number(epexNowNext()?.current?.ct_kwh ?? 0);
  const priceEurKwh = priceCt / 100;
  state.energy.costEur += (importW / 1000) * dtH * priceEurKwh;
  state.energy.revenueEur += (exportW / 1000) * dtH * priceEurKwh;
}

let influxBuffer = [];
const INFLUX_FLUSH_MS = 10000;

async function flushInflux() {
  if (!cfg.influx.enabled || !influxBuffer.length) return;
  const lines = influxBuffer.splice(0);
  try {
    const base = cfg.influx.url.replace(/\/+$/, '');
    const body = lines.join('\n');
    const headers = { 'content-type': 'text/plain; charset=utf-8' };
    let url;

    if (cfg.influx.apiVersion === 'v2') {
      // InfluxDB v2: /api/v2/write?org=...&bucket=...&precision=s
      const qp = new URLSearchParams({ org: cfg.influx.org || '', bucket: cfg.influx.bucket || cfg.influx.db || '', precision: 's' });
      url = `${base}/api/v2/write?${qp.toString()}`;
      if (cfg.influx.token) headers.Authorization = `Token ${cfg.influx.token}`;
    } else {
      // InfluxDB v3 (Default): /api/v3/write_lp?db=...&precision=second
      const qp = new URLSearchParams({ db: cfg.influx.db || cfg.influx.bucket || '', precision: 'second' });
      url = `${base}/api/v3/write_lp?${qp.toString()}`;
      if (cfg.influx.token) headers.Authorization = `Bearer ${cfg.influx.token}`;
    }

    const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    pushLog('influx_error', { error: e.message });
  }
}

function bufferInflux(lines) {
  if (!cfg.influx.enabled || !lines.length) return;
  influxBuffer.push(...lines);
}

function buildInfluxLines(nowSec) {
  const m = cfg.influx.measurement;
  const lines = [];
  const meter = state.meter;
  const vic = state.victron;
  lines.push(`${m},source=meter grid_l1_w=${Number(meter.grid_l1_w || 0)},grid_l2_w=${Number(meter.grid_l2_w || 0)},grid_l3_w=${Number(meter.grid_l3_w || 0)},grid_total_w=${Number(meter.grid_total_w || 0)} ${nowSec}`);
  lines.push(`${m},source=ctrl dv_control=${Number(controlValue())},forced_off=${state.ctrl.forcedOff ? 1 : 0} ${nowSec}`);
  const f = [];
  for (const [k, v] of Object.entries(vic)) {
    if (k === 'errors' || k === 'updatedAt') continue;
    if (v == null || Number.isNaN(Number(v))) continue;
    f.push(`${k}=${Number(v)}`);
  }
  if (f.length) lines.push(`${m},source=victron ${f.join(',')} ${nowSec}`);
  lines.push(`${m},source=energy import_wh=${state.energy.importWh.toFixed(3)},export_wh=${state.energy.exportWh.toFixed(3)},cost_eur=${state.energy.costEur.toFixed(6)},revenue_eur=${state.energy.revenueEur.toFixed(6)} ${nowSec}`);
  return lines;
}

async function pollMeter() {
  try {
    let l1, l2, l3, total;
    if (transport.type === 'mqtt') {
      // MQTT: Werte aus Cache lesen (Venus OS: positiv = Import, negativ = Export)
      const ml1 = transport.getCached('meter_l1') ?? 0;
      const ml2 = transport.getCached('meter_l2') ?? 0;
      const ml3 = transport.getCached('meter_l3') ?? 0;
      const posImport = cfg.gridPositiveMeans === 'grid_import';
      // Venus MQTT: positiv = Import → bei feed_in-Konvention invertieren
      const sign = posImport ? 1 : -1;
      l1 = ml1 * sign;
      l2 = ml2 * sign;
      l3 = ml3 * sign;
      total = (ml1 + ml2 + ml3) * sign;
      state.meter = {
        ok: true, updatedAt: Date.now(), raw: [ml1, ml2, ml3],
        grid_l1_w: l1, grid_l2_w: l2, grid_l3_w: l3, grid_total_w: total,
        error: null
      };
    } else {
      // Modbus: Register lesen und signed interpretieren
      const regs = await transport.mbRequest(cfg.meter);
      const rawL1 = regs.length > 0 ? s16(regs[0]) : 0;
      const rawL2 = regs.length > 1 ? s16(regs[1]) : 0;
      const rawL3 = regs.length > 2 ? s16(regs[2]) : 0;
      const rawTotal = rawL1 + rawL2 + rawL3;

      const posImport = cfg.gridPositiveMeans === 'grid_import';
      const sign = posImport ? 1 : -1;
      l1 = rawL1 * sign;
      l2 = rawL2 * sign;
      l3 = rawL3 * sign;
      total = rawTotal * sign;
      state.meter = {
        ok: true, updatedAt: Date.now(), raw: regs,
        grid_l1_w: l1, grid_l2_w: l2, grid_l3_w: l3, grid_total_w: total,
        error: null
      };
    }

    setReg(0, u16(total));
    setReg(1, total < 0 ? 0xffff : 0x0000);
    setReg(3, 0);
    setReg(4, 0);

    updateEnergyIntegrals(state.meter.updatedAt, total);
  } catch (e) {
    state.meter.ok = false;
    state.meter.error = e.message;
    state.meter.updatedAt = Date.now();
  }

  await Promise.all([
    pollPoint('soc', cfg.points.soc),
    pollPoint('batteryPowerW', cfg.points.batteryPowerW),
    pollPoint('pvPowerW', cfg.points.pvPowerW),
    pollPoint('acPvL1W', cfg.points.acPvL1W),
    pollPoint('acPvL2W', cfg.points.acPvL2W),
    pollPoint('acPvL3W', cfg.points.acPvL3W),
    pollPoint('gridSetpointW', cfg.points.gridSetpointW),
    pollPoint('minSocPct', cfg.points.minSocPct),
    pollPoint('selfConsumptionW', cfg.points.selfConsumptionW),
    ...buildDvControlReadbackPolls(cfg).map(([name, conf]) => pollDvControlReadback(name, conf))
  ]);

  const pvDc = Number(state.victron.pvPowerW || 0);
  const pvAc = Number(state.victron.acPvL1W || 0) + Number(state.victron.acPvL2W || 0) + Number(state.victron.acPvL3W || 0);
  state.victron.pvTotalW = Number((pvDc + pvAc).toFixed(3));

  const gridW = state.meter.grid_total_w || 0;
  const posImport = cfg.gridPositiveMeans === 'grid_import';
  state.victron.gridImportW = Math.max(0, posImport ? gridW : -gridW);
  state.victron.gridExportW = Math.max(0, posImport ? -gridW : gridW);

  const batP = Number(state.victron.batteryPowerW || 0);
  state.victron.batteryChargeW = Math.max(0, batP);
  state.victron.batteryDischargeW = Math.max(0, -batP);

  const loadW = Math.max(0, Number(state.victron.selfConsumptionW || 0));
  const pvTotalW = Math.max(0, Number(state.victron.pvTotalW || 0));
  const gridImportW = Math.max(0, Number(state.victron.gridImportW || 0));
  const gridExportW = Math.max(0, Number(state.victron.gridExportW || 0));
  const batteryChargeW = Math.max(0, Number(state.victron.batteryChargeW || 0));
  const batteryDischargeW = Math.max(0, Number(state.victron.batteryDischargeW || 0));

  const solarToBatteryW = Math.max(0, Math.min(pvTotalW, batteryChargeW));
  const gridToBatteryW = Math.max(0, batteryChargeW - solarToBatteryW);
  const batteryToGridW = Math.max(0, Math.min(batteryDischargeW, gridExportW));
  const batteryDirectUseW = Math.max(0, batteryDischargeW - batteryToGridW);
  const gridDirectUseW = Math.max(0, gridImportW - gridToBatteryW);
  const solarToGridW = Math.max(0, gridExportW - batteryToGridW);
  const solarDirectUseW = Math.max(0, Math.min(pvTotalW, Math.max(0, loadW - gridDirectUseW - batteryDirectUseW)));

  state.victron.solarDirectUseW = solarDirectUseW;
  state.victron.solarToBatteryW = solarToBatteryW;
  state.victron.solarToGridW = solarToGridW;
  state.victron.gridDirectUseW = gridDirectUseW;
  state.victron.gridToBatteryW = gridToBatteryW;
  state.victron.batteryDirectUseW = batteryDirectUseW;
  state.victron.batteryToGridW = batteryToGridW;

  liveTelemetryBuffer?.capture({
    ts: new Date(state.meter.updatedAt || Date.now()).toISOString(),
    resolutionSeconds: Math.max(1, Math.round(effectivePollIntervalMs() / 1000)),
    meter: { ...state.meter },
    victron: { ...state.victron }
  });
  liveTelemetryBuffer?.flush();

  bufferInflux(buildInfluxLines(Math.floor(Date.now() / 1000)));
  publishRuntimeSnapshot();
}

async function fetchEpexDay() {
  if (!cfg.epex.enabled) return;
  const day = berlinDateString();
  const day2 = addDays(day, 1);
  const url = `https://api.energy-charts.info/price?bzn=${encodeURIComponent(cfg.epex.bzn)}&start=${day}&end=${day2}`;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const p = await r.json();
    const unix = Array.isArray(p?.unix_seconds) ? p.unix_seconds : [];
    const prices = Array.isArray(p?.price) ? p.price : [];
    const n = Math.min(unix.length, prices.length);
    const data = [];

    for (let i = 0; i < n; i++) {
      const sec = Number(unix[i]);
      const eur = Number(prices[i]);
      if (!Number.isFinite(sec) || !Number.isFinite(eur)) continue;
      const ts = sec * 1000;
      const ds = berlinDateString(new Date(ts));
      if (ds !== day && ds !== day2) continue;
      data.push({ ts, day: ds, eur_mwh: eur, ct_kwh: Number((eur / 10).toFixed(3)) });
    }

    data.sort((a, b) => a.ts - b.ts);
    state.epex = { ok: true, date: day, nextDate: day2, updatedAt: Date.now(), data, error: null };
    telemetrySafeWrite(() => telemetryStore.writeSamples(buildPriceTelemetrySamples(data, {
      source: 'price_api',
      scope: 'forecast',
      resolutionSeconds: 3600
    })));
    pushLog('epex_refresh_ok', { count: data.length });
  } catch (e) {
    state.epex.ok = false;
    state.epex.error = e.message;
    state.epex.updatedAt = Date.now();
    pushLog('epex_refresh_err', { error: e.message });
  }
  publishRuntimeSnapshot();
}

function epexNowNext() {
  const rec = state.epex;
  if (!rec.ok || !Array.isArray(rec.data) || rec.data.length === 0) return null;
  const now = Date.now();
  let current = rec.data[0];
  let next = null;
  for (const row of rec.data) {
    if (row.ts <= now) current = row;
    else { next = row; break; }
  }

  const tomorrowRows = rec.data.filter((r) => r.day === rec.nextDate);
  const todayRows = rec.data.filter((r) => r.day === rec.date);
  const hasFutureNegative = todayRows.some((r) => r.ts > now && Number(r.eur_mwh) < 0);

  return {
    current,
    next,
    hasFutureNegative,
    today: rec.date,
    tomorrow: rec.nextDate,
    todayMin: todayRows.length ? Math.min(...todayRows.map((r) => Number(r.eur_mwh))) : null,
    todayMax: todayRows.length ? Math.max(...todayRows.map((r) => Number(r.eur_mwh))) : null,
    tomorrowNegative: tomorrowRows.some((r) => Number(r.eur_mwh) < 0),
    tomorrowMin: tomorrowRows.length ? Math.min(...tomorrowRows.map((r) => Number(r.eur_mwh))) : null,
    tomorrowMax: tomorrowRows.length ? Math.max(...tomorrowRows.map((r) => Number(r.eur_mwh))) : null
  };
}

function roundCtKwh(value) {
  return Number(Number(value || 0).toFixed(2));
}

function configuredModule3Windows(pricing = cfg.userEnergyPricing || {}) {
  if (!pricing?.usesParagraph14aModule3) return [];
  return Object.entries(pricing.module3Windows || {})
    .map(([id, window]) => {
      const start = parseHHMM(window?.start);
      const end = parseHHMM(window?.end);
      const priceCtKwh = Number(window?.priceCtKwh);
      if (window?.enabled !== true || start == null || end == null || !Number.isFinite(priceCtKwh)) return null;
      return {
        id,
        label: window?.label ? String(window.label) : id,
        start,
        end,
        priceCtKwh: roundCtKwh(priceCtKwh)
      };
    })
    .filter(Boolean);
}

function slotMinuteMatchesWindow(minuteOfDay, window) {
  if (!window) return false;
  if (window.start <= window.end) return minuteOfDay >= window.start && minuteOfDay < window.end;
  return minuteOfDay >= window.start || minuteOfDay < window.end;
}

function computeDynamicGrossImportCtKwh(marketCtKwh, components = {}) {
  const base =
    Number(marketCtKwh || 0)
    + Number(components.energyMarkupCtKwh || 0)
    + Number(components.gridChargesCtKwh || 0)
    + Number(components.leviesAndFeesCtKwh || 0);
  return roundCtKwh(base * (1 + (Number(components.vatPct || 0) / 100)));
}

function effectiveBatteryCostCtKwh(costs = {}) {
  const pvCtKwh = Number(costs?.pvCtKwh);
  const base = Number(costs?.batteryBaseCtKwh);
  if (!Number.isFinite(base) && !Number.isFinite(pvCtKwh)) return null;
  const markup = Number(costs?.batteryLossMarkupPct || 0);
  const combinedBase =
    (Number.isFinite(pvCtKwh) ? pvCtKwh : 0)
    + (Number.isFinite(base) ? base : 0);
  return roundCtKwh(combinedBase * (1 + markup / 100));
}

function mixedCostCtKwh(costs = {}) {
  const pvCtKwh = Number(costs?.pvCtKwh);
  const batteryCtKwh = effectiveBatteryCostCtKwh(costs);
  if (Number.isFinite(pvCtKwh) && Number.isFinite(batteryCtKwh)) return roundCtKwh((pvCtKwh + batteryCtKwh) / 2);
  if (Number.isFinite(pvCtKwh)) return roundCtKwh(pvCtKwh);
  if (Number.isFinite(batteryCtKwh)) return roundCtKwh(batteryCtKwh);
  return null;
}

function resolveImportPriceCtKwhForSlot(row, pricing = cfg.userEnergyPricing || {}) {
  if (!row) return null;
  const minuteOfDay = localMinutesOfDay(new Date(row.ts));
  for (const window of configuredModule3Windows(pricing)) {
    if (slotMinuteMatchesWindow(minuteOfDay, window)) return window.priceCtKwh;
  }

  if (pricing?.mode === 'fixed') {
    const fixed = Number(pricing?.fixedGrossImportCtKwh);
    return Number.isFinite(fixed) ? roundCtKwh(fixed) : null;
  }

  return computeDynamicGrossImportCtKwh(Number(row.ct_kwh || 0), pricing?.dynamicComponents || {});
}

function slotComparison(row, pricing = cfg.userEnergyPricing || {}) {
  if (!row) return null;
  const importPriceCtKwh = resolveImportPriceCtKwhForSlot(row, pricing);
  const pvCtKwh = Number(pricing?.costs?.pvCtKwh);
  const batteryCtKwh = effectiveBatteryCostCtKwh(pricing?.costs || {});
  const mixedCt = mixedCostCtKwh(pricing?.costs || {});
  const exportPriceCtKwh = roundCtKwh(Number(row.ct_kwh || 0));

  const margins = [
    Number.isFinite(pvCtKwh) ? { source: 'pv', marginCtKwh: roundCtKwh(exportPriceCtKwh - pvCtKwh) } : null,
    Number.isFinite(batteryCtKwh) ? { source: 'battery', marginCtKwh: roundCtKwh(exportPriceCtKwh - batteryCtKwh) } : null,
    Number.isFinite(mixedCt) ? { source: 'mixed', marginCtKwh: roundCtKwh(exportPriceCtKwh - mixedCt) } : null
  ].filter(Boolean);
  const best = margins.length
    ? margins.reduce((winner, entry) => (winner == null || entry.marginCtKwh > winner.marginCtKwh ? entry : winner), null)
    : null;

  return {
    ts: row.ts,
    exportPriceCtKwh,
    importPriceCtKwh,
    spreadToImportCtKwh: Number.isFinite(importPriceCtKwh) ? roundCtKwh(exportPriceCtKwh - importPriceCtKwh) : null,
    pvMarginCtKwh: Number.isFinite(pvCtKwh) ? roundCtKwh(exportPriceCtKwh - pvCtKwh) : null,
    batteryMarginCtKwh: Number.isFinite(batteryCtKwh) ? roundCtKwh(exportPriceCtKwh - batteryCtKwh) : null,
    mixedMarginCtKwh: Number.isFinite(mixedCt) ? roundCtKwh(exportPriceCtKwh - mixedCt) : null,
    bestSource: best?.source || null,
    bestMarginCtKwh: best?.marginCtKwh ?? null
  };
}

function userEnergyPricingSummary() {
  const pricing = cfg.userEnergyPricing || {};
  const costs = pricing.costs || {};
  const slots = Array.isArray(state.epex.data) ? state.epex.data.map((row) => slotComparison(row, pricing)) : [];
  const currentTs = epexNowNext()?.current?.ts;
  const current = slots.find((row) => row?.ts === currentTs) || null;
  const configured =
    (pricing.mode === 'fixed' && Number.isFinite(Number(pricing.fixedGrossImportCtKwh)))
    || pricing.mode === 'dynamic';

  return {
    configured,
    mode: pricing.mode || 'fixed',
    usesParagraph14aModule3: pricing.usesParagraph14aModule3 === true,
    dynamicComponents: {
      energyMarkupCtKwh: roundCtKwh(Number(pricing?.dynamicComponents?.energyMarkupCtKwh || 0)),
      gridChargesCtKwh: roundCtKwh(Number(pricing?.dynamicComponents?.gridChargesCtKwh || 0)),
      leviesAndFeesCtKwh: roundCtKwh(Number(pricing?.dynamicComponents?.leviesAndFeesCtKwh || 0)),
      vatPct: roundCtKwh(Number(pricing?.dynamicComponents?.vatPct || 0))
    },
    fixedGrossImportCtKwh: Number.isFinite(Number(pricing.fixedGrossImportCtKwh))
      ? roundCtKwh(Number(pricing.fixedGrossImportCtKwh))
      : null,
    module3Windows: configuredModule3Windows(pricing).map((window) => ({
      id: window.id,
      label: window.label,
      start: window.start,
      end: window.end,
      priceCtKwh: window.priceCtKwh
    })),
    costs: {
      pvCtKwh: Number.isFinite(Number(costs.pvCtKwh)) ? roundCtKwh(Number(costs.pvCtKwh)) : null,
      batteryBaseCtKwh: Number.isFinite(Number(costs.batteryBaseCtKwh)) ? roundCtKwh(Number(costs.batteryBaseCtKwh)) : null,
      batteryLossMarkupPct: roundCtKwh(Number(costs.batteryLossMarkupPct || 0)),
      batteryEffectiveCtKwh: effectiveBatteryCostCtKwh(costs),
      mixedCtKwh: mixedCostCtKwh(costs)
    },
    current,
    slots
  };
}

async function runMeterScan(params = {}) {
  if (state.scan.running) throw new Error('scan already running');
  const p = { ...cfg.scan, ...params };
  p.start = Number(p.start);
  p.end = Number(p.end);
  p.step = Math.max(1, Number(p.step));
  p.quantity = Math.max(1, Math.min(125, Number(p.quantity)));

  state.scan.running = true;
  state.scan.updatedAt = Date.now();
  state.scan.params = p;
  state.scan.rows = [];
  state.scan.error = null;
  pushLog('scan_start', p);

  const rows = [];
  try {
    for (let addr = p.start; addr <= p.end; addr += p.step) {
      try {
        const regs = await scanTransport.mbRequest({
          host: p.host,
          port: p.port,
          unitId: p.unitId,
          fc: p.fc,
          address: addr,
          quantity: p.quantity,
          timeoutMs: p.timeoutMs
        });
        const hasNonZero = regs.some((x) => Number(x) !== 0);
        if (!p.onlyNonZero || hasNonZero) rows.push({ addr, regs, s16: regs.map((v) => s16(v)) });
      } catch (e) {
        rows.push({ addr, error: e.message });
      }
      if (rows.length >= 1000) break;
    }
    state.scan.rows = rows;
    pushLog('scan_done', { rows: rows.length });
  } catch (e) {
    state.scan.error = e.message;
    pushLog('scan_error', { error: e.message });
  } finally {
    state.scan.running = false;
    state.scan.updatedAt = Date.now();
  }
}

function effectiveTargetValue(target) {
  const now = Date.now();
  const mod = localMinutesOfDay(new Date(now));

  const hit = state.schedule.rules.find((r) => r.target === target && scheduleMatch(r, mod));
  if (hit) { hit._wasActive = true; delete state.schedule.manualOverride[target]; return { value: Number(hit.value), source: `rule:${hit.id || 'unnamed'}`, rule: hit }; }

  const mo = state.schedule.manualOverride[target];
  if (mo && (Date.now() - mo.at) < (cfg.schedule.manualOverrideTtlMs || 300000)) {
    return { value: Number(mo.value), source: 'manual_override', rule: null };
  }
  delete state.schedule.manualOverride[target];

  if (target === 'gridSetpointW' && state.schedule.config.defaultGridSetpointW != null) return { value: Number(state.schedule.config.defaultGridSetpointW), source: 'default', rule: null };
  if (target === 'chargeCurrentA' && state.schedule.config.defaultChargeCurrentA != null) return { value: Number(state.schedule.config.defaultChargeCurrentA), source: 'default', rule: null };
  return { value: null, source: 'none', rule: null };
}

async function applyControlTarget(target, value, source) {
  const conf = cfg.controlWrite[target];
  if (!conf?.enabled) return { ok: false, error: 'write target not enabled in config' };
  if (Number(conf.address) === 0 && conf.allowAddressZero !== true) return { ok: false, error: 'unsafe address 0 blocked (set allowAddressZero=true to override)' };

  const prev = state.schedule.lastWrite[target];
  if (prev != null && Number(prev.value) === Number(value)) {
    state.schedule.active[target] = { value, source, at: Date.now(), skipped: true };
    return { ok: true, skipped: true };
  }

  try {
    let encoded, words, fc;
    if (transport.type === 'mqtt') {
      // MQTT: Engineering-Wert direkt schreiben (kein Register-Encoding)
      await transport.mqttWrite(target, value);
      encoded = { raw: value, scaled: value, writeType: 'mqtt', wordOrder: 'n/a' };
      words = [value];
      fc = 0;
    } else {
      // Modbus: Wert in Register-Format kodieren
      encoded = toRawForWrite(value, conf);
      words = Array.isArray(encoded.words) && encoded.words.length ? encoded.words : [encoded.raw];
      fc = Number(conf.fc || (words.length > 1 ? 16 : 6));

      if (fc === 6) {
        if (words.length !== 1) throw new Error(`fc6 only supports one register, got ${words.length}`);
        await transport.mbWriteSingle({ host: conf.host, port: conf.port, unitId: conf.unitId, address: conf.address, value: words[0], timeoutMs: conf.timeoutMs });
      } else if (fc === 16) {
        await transport.mbWriteMultiple({ host: conf.host, port: conf.port, unitId: conf.unitId, address: conf.address, values: words, timeoutMs: conf.timeoutMs });
      } else {
        throw new Error(`unsupported write fc: ${fc}`);
      }
    }

    state.schedule.lastWrite[target] = {
      value,
      source,
      raw: encoded.raw,
      words,
      scaled: encoded.scaled,
      writeType: encoded.writeType,
      fc,
      address: conf.address,
      at: Date.now()
    };
    state.schedule.active[target] = { value, source, at: Date.now() };
    pushLog('control_write', {
      target,
      value,
      raw: encoded.raw,
      words,
      scaled: encoded.scaled,
      writeType: encoded.writeType,
      wordOrder: encoded.wordOrder,
      fc,
      address: conf.address,
      source
    });
    telemetrySafeWrite(() => telemetryStore.writeControlEvent({
      eventType: 'control_write',
      target,
      valueNum: Number(value),
      reason: source,
      source: source.includes('optimization') ? 'optimizer' : 'runtime',
      meta: {
        raw: encoded.raw,
        words,
        scaled: encoded.scaled,
        writeType: encoded.writeType,
        fc,
        address: conf.address
      }
    }));
    return { ok: true, raw: encoded.raw, words, scaled: encoded.scaled, writeType: encoded.writeType, wordOrder: encoded.wordOrder, fc, address: conf.address };
  } catch (e) {
    pushLog('control_write_error', { target, value, source, error: e.message });
    telemetrySafeWrite(() => telemetryStore.writeControlEvent({
      eventType: 'control_write_error',
      target,
      valueNum: Number.isFinite(Number(value)) ? Number(value) : null,
      reason: source,
      source: 'runtime',
      meta: { error: e.message }
    }));
    return { ok: false, error: e.message };
  }
}

async function evaluateSchedule() {
  const now = Date.now();
  const nowMin = localMinutesOfDay(new Date(now));
  regenerateSmallMarketAutomationRules({ now });
  state.schedule.lastEvalAt = now;

  const stopSocDisable = autoDisableStopSocScheduleRules({
    rules: state.schedule.rules,
    nowMin,
    batterySocPct: state.victron.soc
  });
  if (stopSocDisable.changed) {
    state.schedule.rules = stopSocDisable.rules;
    for (const ruleId of stopSocDisable.disabledRuleIds) {
      pushLog('schedule_stop_soc_reached', { id: ruleId, target: 'gridSetpointW', soc: state.victron.soc });
    }
    persistConfig();
  }

  const npp = cfg.dvControl?.negativePriceProtection;
  const priceNow = epexNowNext()?.current;
  const priceNegative = npp?.enabled && priceNow && Number(priceNow.ct_kwh) < 0;

  for (const target of ['gridSetpointW', 'chargeCurrentA']) {
    const eff = effectiveTargetValue(target);
    if (eff.value == null) continue;

    // Bei negativen Preisen: DC/AC Einspeisung blockieren + Grid Setpoint begrenzen
    if (target === 'gridSetpointW' && priceNegative) {
      const limit = Number(npp.gridSetpointW ?? -40);
      const prev = state.ctrl.negativePriceActive;
      if (!prev) pushLog('negative_price_protection_on', { price: priceNow.ct_kwh, limit });
      state.ctrl.negativePriceActive = true;
      // Victron DC/AC Abregelung immer bei negativen Preisen
      if (cfg.dvControl?.enabled && !state.ctrl.forcedOff) {
        applyDvVictronControl(false);
      }
      if (eff.value < limit) {
        await applyControlTarget(target, limit, 'negative_price_protection');
        continue;
      }
    }

    await applyControlTarget(target, eff.value, eff.source);
  }

  // Auto-Deaktivierung: Regeln die aktiv waren aber deren Zeitfenster abgelaufen ist
  const autoDisable = autoDisableExpiredScheduleRules(state.schedule.rules, nowMin);
  if (autoDisable.changed) {
    for (const rule of state.schedule.rules) {
      if (!rule?._wasActive || rule.enabled === false || scheduleMatch(rule, nowMin)) continue;
      pushLog('schedule_auto_disabled', { id: rule.id, target: rule.target });
    }
    state.schedule.rules = autoDisable.rules;
    persistConfig();
  }

  // Negative-Preis-Schutz aufheben wenn Preis wieder positiv
  if (state.ctrl.negativePriceActive && !priceNegative) {
    state.ctrl.negativePriceActive = false;
    pushLog('negative_price_protection_off', { price: priceNow?.ct_kwh });
    if (cfg.dvControl?.enabled && !state.ctrl.forcedOff) {
      applyDvVictronControl(true);
    }
  }

  publishRuntimeSnapshot();
}

function keepaliveModbusPayload() {
  return {
    ok: !!state.keepalive.modbusLastQuery,
    lastQuery: state.keepalive.modbusLastQuery,
    now: Date.now()
  };
}

function keepalivePulsePayload() {
  const now = Date.now();
  const slot = Math.floor(now / (cfg.keepalivePulseSec * 1000));
  const slotTs = slot * cfg.keepalivePulseSec * 1000;
  return {
    ok: true,
    periodSec: cfg.keepalivePulseSec,
    pulseSlot: slot,
    pulseTimestamp: slotTs,
    now
  };
}

function costSummary() {
  return {
    day: state.energy.day,
    importWh: Number(state.energy.importWh.toFixed(3)),
    exportWh: Number(state.energy.exportWh.toFixed(3)),
    importKwh: Number((state.energy.importWh / 1000).toFixed(4)),
    exportKwh: Number((state.energy.exportWh / 1000).toFixed(4)),
    costEur: Number(state.energy.costEur.toFixed(4)),
    revenueEur: Number(state.energy.revenueEur.toFixed(4)),
    netEur: Number((state.energy.revenueEur - state.energy.costEur).toFixed(4)),
    priceNowCtKwh: Number(epexNowNext()?.current?.ct_kwh ?? 0),
    userImportPriceNowCtKwh: Number(userEnergyPricingSummary()?.current?.importPriceCtKwh ?? 0)
  };
}

function integrationState() {
  return {
    timestamp: Date.now(),
    dvControlValue: controlValue(),
    forcedOff: state.ctrl.forcedOff,
    gridTotalW: state.meter.grid_total_w,
    gridDirection: gridDirection(state.meter.grid_total_w).mode,
    gridSetpointW: state.victron.gridSetpointW,
    minSocPct: state.victron.minSocPct,
    soc: state.victron.soc,
    batteryPowerW: state.victron.batteryPowerW,
    pvTotalW: state.victron.pvTotalW,
    scheduleActive: state.schedule.active,
    costs: costSummary(),
    userEnergyPricing: userEnergyPricingSummary()
  };
}

// ── EOS (Akkudoktor) Integration ─────────────────────────────────────
function eosState() {
  const now = new Date();
  const soc = Number(state.victron.soc ?? 0);
  const gridTotal = Number(state.meter.grid_total_w ?? 0);
  const posImport = cfg.gridPositiveMeans === 'grid_import';
  const gridImportW = Math.max(0, posImport ? gridTotal : -gridTotal);
  const gridExportW = Math.max(0, posImport ? -gridTotal : gridTotal);

  return {
    // Messwerte im EOS-Format (PUT /v1/measurement/data)
    measurement: {
      start_datetime: now.toISOString(),
      interval: `${cfg.meterPollMs / 1000} seconds`,
      battery_soc: [soc / 100],
      battery_power: [Number(state.victron.batteryPowerW ?? 0)],
      grid_import_w: [gridImportW],
      grid_export_w: [gridExportW],
      pv_power: [Number(state.victron.pvTotalW ?? 0)],
      load_power: [Number(state.victron.selfConsumptionW ?? 0)],
      power_l1_w: [Number(state.meter.grid_l1_w ?? 0)],
      power_l2_w: [Number(state.meter.grid_l2_w ?? 0)],
      power_l3_w: [Number(state.meter.grid_l3_w ?? 0)]
    },
    // Aktuelle Systeminfo
    system: {
      timestamp: now.toISOString(),
      soc_pct: soc,
      battery_power_w: Number(state.victron.batteryPowerW ?? 0),
      pv_total_w: Number(state.victron.pvTotalW ?? 0),
      grid_total_w: gridTotal,
      grid_import_w: gridImportW,
      grid_export_w: gridExportW,
      grid_setpoint_w: Number(state.victron.gridSetpointW ?? 0),
      min_soc_pct: Number(state.victron.minSocPct ?? 0),
      self_consumption_w: Number(state.victron.selfConsumptionW ?? 0)
    },
    // EPEX-Preise (fuer EOS prediction import)
    prices: epexPriceArray()
  };
}

// ── EMHASS Integration ───────────────────────────────────────────────
function emhassState() {
  const soc = Number(state.victron.soc ?? 0);
  const prices = epexPriceArray();

  return {
    // Aktuelle Werte fuer soc_init
    soc_init: soc / 100,
    battery_power_w: Number(state.victron.batteryPowerW ?? 0),
    pv_power_w: Number(state.victron.pvTotalW ?? 0),
    load_power_w: Number(state.victron.selfConsumptionW ?? 0),
    grid_power_w: Number(state.meter.grid_total_w ?? 0),
    // EPEX-Preise als Array (EUR/kWh) fuer load_cost_forecast
    load_cost_forecast: prices.map((p) => p.eur_kwh),
    // Timestamps dazu
    price_timestamps: prices.map((p) => p.ts_iso),
    // Preise als prod_price_forecast (Einspeiseverguetung, hier identisch)
    prod_price_forecast: prices.map((p) => p.eur_kwh),
    // System-Metadaten
    timestamp: new Date().toISOString(),
    grid_setpoint_w: Number(state.victron.gridSetpointW ?? 0),
    min_soc_pct: Number(state.victron.minSocPct ?? 0)
  };
}

// ── EPEX-Preise als Array (fuer EOS + EMHASS) ───────────────────────
function epexPriceArray() {
  if (!state.epex.ok || !Array.isArray(state.epex.data)) return [];
  return state.epex.data.map((row) => ({
    ts: row.ts,
    ts_iso: new Date(row.ts).toISOString(),
    eur_mwh: Number(row.eur_mwh ?? 0),
    eur_kwh: Number((row.eur_mwh ?? 0) / 1000),
    ct_kwh: Number(row.ct_kwh ?? 0)
  }));
}

function checkAuth(req, res) {
  if (!cfg.apiToken) return true;
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${cfg.apiToken}`) return true;
  const urlToken = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
  if (urlToken === cfg.apiToken) return true;
  res.writeHead(401, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};

function json(res, code, payload) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function text(res, code, payload) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(String(payload));
}

function downloadJson(res, filename, payload) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`
  });
  res.end(JSON.stringify(payload, null, 2));
}

function configMetaPayload() {
  return {
    path: CONFIG_PATH,
    exists: loadedConfig.exists,
    valid: loadedConfig.valid,
    parseError: loadedConfig.parseError,
    needsSetup: loadedConfig.needsSetup,
    warnings: loadedConfig.warnings || []
  };
}

function configApiPayload() {
  return {
    ok: true,
    meta: configMetaPayload(),
    config: rawCfg,
    effectiveConfig: cfg,
    definition: CONFIG_DEFINITION
  };
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

async function adminHealthPayload() {
  const service = {
    enabled: SERVICE_ACTIONS_ENABLED,
    name: SERVICE_NAME,
    useSudo: SERVICE_USE_SUDO,
    status: 'disabled',
    detail: 'Service-Aktionen sind per ENV deaktiviert.'
  };

  if (SERVICE_ACTIONS_ENABLED) {
    const activeCheck = await runServiceCommand(['is-active', SERVICE_NAME]);
    const showCheck = await runServiceCommand(['show', SERVICE_NAME, '--property=ActiveState,SubState,UnitFileState', '--value']);
    service.status = activeCheck.ok ? (activeCheck.stdout || 'unknown') : 'unavailable';
    service.detail = activeCheck.ok ? 'systemctl erreichbar' : activeCheck.error;
    service.show = showCheck.ok ? showCheck.stdout : showCheck.error;
  }

  return {
    ok: true,
    checkedAt: Date.now(),
    app: APP_VERSION,
    service,
    runtime: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      pid: process.pid,
      transport: transport.type,
      uptimeSec: Math.round(process.uptime())
    },
    checks: [
      {
        id: 'config',
        label: 'Config Datei',
        ok: loadedConfig.exists && loadedConfig.valid,
        detail: loadedConfig.exists
          ? (loadedConfig.valid ? `gueltig unter ${CONFIG_PATH}` : `ungueltig: ${loadedConfig.parseError}`)
          : `fehlt: ${CONFIG_PATH}`
      },
      {
        id: 'setup',
        label: 'Setup Status',
        ok: !loadedConfig.needsSetup,
        detail: loadedConfig.needsSetup ? 'Setup noch nicht abgeschlossen' : 'Setup abgeschlossen'
      },
      {
        id: 'meter',
        label: 'Live Meter Daten',
        ok: state.meter.ok,
        detail: state.meter.ok
          ? `letztes Update ${fmtTs(state.meter.updatedAt)}`
          : (state.meter.error || 'noch keine erfolgreichen Meter-Daten')
      },
      {
        id: 'epex',
        label: 'EPEX Feed',
        ok: !cfg.epex.enabled || state.epex.ok,
        detail: !cfg.epex.enabled
          ? 'deaktiviert'
          : state.epex.ok
            ? `letztes Update ${fmtTs(state.epex.updatedAt)}`
            : (state.epex.error || 'noch keine Preisdaten')
      },
      {
        id: 'service_actions',
        label: 'Restart Aktion',
        ok: SERVICE_ACTIONS_ENABLED && service.status !== 'unavailable',
        detail: SERVICE_ACTIONS_ENABLED
          ? `Service ${SERVICE_NAME}: ${service.status}`
          : 'per ENV deaktiviert'
      },
      {
        id: 'telemetry',
        label: 'Interne Historie',
        ok: !cfg.telemetry?.enabled || state.telemetry.ok,
        detail: !cfg.telemetry?.enabled
          ? 'deaktiviert'
          : state.telemetry.dbPath
            ? `DB ${state.telemetry.dbPath}, letztes Schreiben ${fmtTs(state.telemetry.lastWriteAt)}`
            : (state.telemetry.lastError || 'noch keine Telemetrie-Initialisierung')
      }
    ]
  };
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

function servePage(res, filename) {
  const publicDir = path.resolve(__dirname, 'public');
  const file = path.resolve(publicDir, filename);
  if (!file.startsWith(publicDir + path.sep) && file !== publicDir) return text(res, 400, 'bad path');
  if (!fs.existsSync(file)) return text(res, 404, 'not found');
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res) {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  const reqPath = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  const publicDir = path.resolve(__dirname, 'public');
  const file = path.resolve(publicDir, reqPath.replace(/^\/+/, ''));
  if (!file.startsWith(publicDir + path.sep) && file !== publicDir) return text(res, 400, 'bad path');
  if (!fs.existsSync(file)) return text(res, 404, 'not found');
  const ext = path.extname(file).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': mime });
  fs.createReadStream(file).pipe(res);
}

const web = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' && req.method === 'GET') {
    return servePage(res, loadedConfig.needsSetup ? 'setup.html' : 'index.html');
  }

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dv/')) {
    if (!checkAuth(req, res)) return;
  }

  if (url.pathname === '/dv/control-value' && req.method === 'GET') return text(res, 200, controlValue());

  if (url.pathname === '/api/keepalive/modbus' && req.method === 'GET') return json(res, 200, keepaliveModbusPayload());
  if (url.pathname === '/api/keepalive/pulse' && req.method === 'GET') return json(res, 200, keepalivePulsePayload());
  if (url.pathname === '/api/setup/status' && req.method === 'GET') return json(res, 200, configMetaPayload());

  if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, configApiPayload());

  if ((url.pathname === '/api/config' || url.pathname === '/api/config/import') && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
      return json(res, 400, { ok: false, error: 'config object required' });
    }
    const result = saveAndApplyConfig(body.config);
    pushLog('config_saved', {
      changedPaths: result.changedPaths.length,
      restartRequired: result.restartRequired,
      source: url.pathname.endsWith('/import') ? 'import' : 'settings'
    });
    return json(res, 200, {
      ok: true,
      meta: configMetaPayload(),
      config: rawCfg,
      effectiveConfig: cfg,
      changedPaths: result.changedPaths,
      restartRequired: result.restartRequired,
      restartRequiredPaths: result.restartRequiredPaths
    });
  }

  if (url.pathname === '/api/config/export' && req.method === 'GET') {
    return downloadJson(res, 'dvhub-config.json', rawCfg);
  }

  if (url.pathname === '/api/discovery/systems' && req.method === 'GET') {
    const payload = await buildSystemDiscoveryPayload({
      query: Object.fromEntries(url.searchParams)
    });
    return json(res, payload.ok ? 200 : 400, payload);
  }

  if (url.pathname === '/api/admin/health' && req.method === 'GET') {
    return json(res, 200, await adminHealthPayload());
  }

  if (url.pathname === '/api/admin/service/restart' && req.method === 'POST') {
    if (!SERVICE_ACTIONS_ENABLED) {
      return json(res, 403, { ok: false, error: 'service actions disabled' });
    }
    const check = await runServiceCommand(['show', SERVICE_NAME, '--property=Id', '--value']);
    if (!check.ok) {
      return json(res, 500, { ok: false, error: check.error, command: check.command });
    }
    scheduleServiceRestart();
    pushLog('service_restart_scheduled', { service: SERVICE_NAME });
    return json(res, 202, {
      ok: true,
      accepted: true,
      service: SERVICE_NAME,
      message: 'Service restart scheduled'
    });
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    expireLeaseIfNeeded();
    return json(res, 200, buildApiStatusResponse(Date.now()));
  }

  if (url.pathname === '/api/costs' && req.method === 'GET') return json(res, 200, costSummary());

  if (url.pathname === '/api/integration/home-assistant' && req.method === 'GET') return json(res, 200, integrationState());

  if (url.pathname === '/api/integration/loxone' && req.method === 'GET') {
    const s = integrationState();
    const lines = Object.entries(s).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    return text(res, 200, lines.join('\n'));
  }

  // EOS (Akkudoktor) — Messwerte + Preise abrufen
  if (url.pathname === '/api/integration/eos' && req.method === 'GET') return json(res, 200, eosState());

  // EOS — Optimierungsergebnis empfangen und als Schedule-Regeln anwenden
  if (url.pathname === '/api/integration/eos/apply' && req.method === 'POST') {
    const body = await parseBody(req);
    const results = [];
    if (body.gridSetpointW !== undefined && Number.isFinite(Number(body.gridSetpointW))) {
      results.push(await applyControlTarget('gridSetpointW', Number(body.gridSetpointW), 'eos_optimization'));
    }
    if (body.chargeCurrentA !== undefined && Number.isFinite(Number(body.chargeCurrentA))) {
      results.push(await applyControlTarget('chargeCurrentA', Number(body.chargeCurrentA), 'eos_optimization'));
    }
    if (body.minSocPct !== undefined && Number.isFinite(Number(body.minSocPct))) {
      results.push(await applyControlTarget('minSocPct', Number(body.minSocPct), 'eos_optimization'));
    }
    pushLog('eos_apply', { targets: results.length, body });
    telemetrySafeWrite(() => telemetryStore.writeOptimizerRun(buildOptimizerRunPayload({
      optimizer: 'eos',
      body,
      source: 'eos_apply'
    })));
    return json(res, 200, { ok: true, results });
  }

  // EMHASS — Messwerte + Preise abrufen
  if (url.pathname === '/api/integration/emhass' && req.method === 'GET') return json(res, 200, emhassState());

  // EMHASS — Optimierungsergebnis empfangen und anwenden
  if (url.pathname === '/api/integration/emhass/apply' && req.method === 'POST') {
    const body = await parseBody(req);
    const results = [];
    if (body.gridSetpointW !== undefined && Number.isFinite(Number(body.gridSetpointW))) {
      results.push(await applyControlTarget('gridSetpointW', Number(body.gridSetpointW), 'emhass_optimization'));
    }
    if (body.chargeCurrentA !== undefined && Number.isFinite(Number(body.chargeCurrentA))) {
      results.push(await applyControlTarget('chargeCurrentA', Number(body.chargeCurrentA), 'emhass_optimization'));
    }
    if (body.minSocPct !== undefined && Number.isFinite(Number(body.minSocPct))) {
      results.push(await applyControlTarget('minSocPct', Number(body.minSocPct), 'emhass_optimization'));
    }
    pushLog('emhass_apply', { targets: results.length, body });
    telemetrySafeWrite(() => telemetryStore.writeOptimizerRun(buildOptimizerRunPayload({
      optimizer: 'emhass',
      body,
      source: 'emhass_apply'
    })));
    return json(res, 200, { ok: true, results });
  }

  if (url.pathname === '/api/log' && req.method === 'GET') {
    const limit = resolveLogLimit(url.searchParams.get('limit'));
    return json(res, 200, { rows: state.log.slice(-limit) });
  }

  if (url.pathname === '/api/history/import/status' && req.method === 'GET') {
    return json(res, 200, buildApiHistoryImportStatusResponse());
  }

  if (url.pathname === '/api/history/import' && req.method === 'POST') {
    if (!historyImportManager) return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
    const body = await parseBody(req);
    if (body.mode === 'backfill') {
      assertValidRuntimeCommand('history_backfill', { mode: 'gap', requestedBy: 'history_import_endpoint' });
      const result = await historyImportManager.backfillHistoryFromConfiguredSource({ mode: 'gap' });
      return json(res, result.ok ? 200 : 400, result);
    }
    const provider = String(body.provider || cfg.telemetry?.historyImport?.provider || 'vrm');
    assertValidRuntimeCommand('history_import', {
      provider,
      requestedFrom: body.requestedFrom ?? body.start ?? null,
      requestedTo: body.requestedTo ?? body.end ?? null,
      interval: body.interval || '15mins'
    });
    const result = Array.isArray(body.rows) && body.rows.length
      ? historyImportManager.importSamples({
        provider,
        requestedFrom: body.requestedFrom ?? null,
        requestedTo: body.requestedTo ?? null,
        sourceAccount: body.sourceAccount ?? null,
        rows: body.rows
      })
      : await historyImportManager.importFromConfiguredSource({
        start: body.requestedFrom ?? body.start,
        end: body.requestedTo ?? body.end,
        interval: body.interval || '15mins'
      });
    return json(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/history/backfill/vrm' && req.method === 'POST') {
    if (!historyImportManager) return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
    const body = await parseBody(req);
    const requestedMode = body?.mode === 'full' ? 'full' : 'gap';
    assertValidRuntimeCommand('history_backfill', {
      mode: requestedMode,
      requestedBy: 'history_backfill_endpoint'
    });
    const result = await historyImportManager.backfillHistoryFromConfiguredSource({ ...body, mode: requestedMode });
    return json(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/history/summary' && req.method === 'GET') {
    if (!historyApi || typeof historyApi.getSummary !== 'function') {
      return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
    }
    const result = await historyApi.getSummary({
      view: url.searchParams.get('view'),
      date: url.searchParams.get('date')
    });
    return json(res, result.status, result.body);
  }

  if (url.pathname === '/api/history/backfill/prices' && req.method === 'POST') {
    if (!historyApi || typeof historyApi.postPriceBackfill !== 'function') {
      return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
    }
    const body = await parseBody(req);
    const result = await historyApi.postPriceBackfill(body || {});
    return json(res, result.status, result.body);
  }

  if (url.pathname === '/api/epex/refresh' && req.method === 'POST') {
    await fetchEpexDay();
    return json(res, 200, { ok: state.epex.ok, error: state.epex.error });
  }

  if (url.pathname === '/api/meter/scan' && req.method === 'POST') {
    const body = await parseBody(req);
    runMeterScan(body).catch((e) => {
      state.scan.running = false;
      state.scan.error = e.message;
    });
    return json(res, 200, { ok: true, running: true });
  }

  if (url.pathname === '/api/meter/scan' && req.method === 'GET') return json(res, 200, state.scan);

  if (url.pathname === '/api/schedule' && req.method === 'GET') {
    return json(res, 200, {
      config: state.schedule.config,
      rules: state.schedule.rules,
      active: state.schedule.active,
      lastWrite: state.schedule.lastWrite
    });
  }

  if (url.pathname === '/api/schedule/rules' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!Array.isArray(body.rules)) return json(res, 400, { ok: false, error: 'rules array required' });
    state.schedule.rules = body.rules;
    pushLog('schedule_rules_updated', { count: body.rules.length });
    persistConfig();
    return json(res, 200, { ok: true, count: body.rules.length });
  }

  if (url.pathname === '/api/schedule/config' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.defaultGridSetpointW !== undefined) {
      const v = Number(body.defaultGridSetpointW);
      if (!Number.isFinite(v)) return json(res, 400, { ok: false, error: 'defaultGridSetpointW invalid' });
      state.schedule.config.defaultGridSetpointW = v;
    }
    if (body.defaultChargeCurrentA !== undefined) {
      const v = Number(body.defaultChargeCurrentA);
      if (!Number.isFinite(v)) return json(res, 400, { ok: false, error: 'defaultChargeCurrentA invalid' });
      state.schedule.config.defaultChargeCurrentA = v;
    }
    pushLog('schedule_config_updated', { config: state.schedule.config });
    persistConfig();
    return json(res, 200, { ok: true, config: state.schedule.config });
  }

  // GET /api/schedule/automation/config
  if (url.pathname === '/api/schedule/automation/config' && req.method === 'GET') {
    return json(res, 200, { ok: true, config: cfg.schedule?.smallMarketAutomation || {} });
  }

  // POST /api/schedule/automation/config
  if (url.pathname === '/api/schedule/automation/config' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'invalid body' });

    // Merge automation config into raw config and persist
    const current = JSON.parse(JSON.stringify(rawCfg || {}));
    current.schedule = current.schedule || {};
    current.schedule.smallMarketAutomation = {
      ...current.schedule.smallMarketAutomation,
      ...body
    };
    saveAndApplyConfig(current);
    regenerateSmallMarketAutomationRules();

    return json(res, 200, { ok: true, config: cfg.schedule.smallMarketAutomation });
  }

  if (url.pathname === '/api/control/write' && req.method === 'POST') {
    const body = await parseBody(req);
    const target = String(body.target || '');
    const value = Number(body.value);
    assertValidRuntimeCommand('control_write', { target, value });
    state.schedule.manualOverride[target] = { value, at: Date.now() };
    const result = await applyControlTarget(target, value, 'api_manual_write');
    return json(res, result.ok ? 200 : 500, result);
  }

  return serveStatic(req, res);
  } catch (e) {
    console.error('HTTP handler error:', e);
    if (!res.headersSent) {
      json(res, Number.isInteger(e?.statusCode) ? e.statusCode : 500, {
        error: e?.statusCode ? e.message : 'internal server error'
      });
    }
  }
});

telemetryStore = createTelemetryStoreIfEnabled();
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
refreshTelemetryStatus();
if (IS_RUNTIME_PROCESS) {
  applicableValueService.refresh().catch((error) => {
    pushLog('applicable_value_refresh_error', { error: error.message });
  });
  startAutomaticMarketValueBackfill();
}

if (IS_WEB_PROCESS && RUNTIME_WORKER_ENABLED) {
  runtimeWorker = startDedicatedRuntimeWorker();
}

if (IS_WEB_PROCESS) {
  web.listen(cfg.httpPort, () => {
    console.log(`Web server listening on :${cfg.httpPort}`);
  });
}

if (IS_RUNTIME_PROCESS) {
  loadEnergy();
  startModbusServer();
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

const pollMeterRunner = createSerialTaskRunner({
  queueWhileRunning: false,
  task: () => pollMeter()
});

function requestPollMeter() {
  return pollMeterRunner.run();
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
  function schedulePollLoop() {
    setTimeout(() => {
      requestPollMeter().catch((e) => pushLog('poll_meter_error', { error: e.message })).finally(() => {
        schedulePollLoop();
      });
    }, effectivePollIntervalMs());
  }
  function scheduleEvaluateLoop() {
    setTimeout(() => {
      evaluateSchedule().catch((e) => pushLog('schedule_eval_error', { error: e.message })).finally(() => {
        scheduleEvaluateLoop();
      });
    }, Math.max(5000, Number(cfg.schedule.evaluateMs || 15000)));
  }
  initTransport();
  requestPollMeter().catch((e) => console.error('Initial pollMeter error:', e));
  schedulePollLoop();
  scheduleEvaluateLoop();
  fetchEpexDay();
  setInterval(() => {
    const mustRefresh = !state.epex.date || state.epex.date !== berlinDateString();
    if (mustRefresh || (Date.now() - state.epex.updatedAt) > 6 * 60 * 60 * 1000) fetchEpexDay();
  }, 5 * 60 * 1000);
  setInterval(() => {
    flushInflux().catch((e) => pushLog('influx_flush_error', { error: e.message }));
  }, INFLUX_FLUSH_MS);
  setInterval(persistEnergy, 60000);
  setInterval(() => {
    telemetrySafeWrite(() => telemetryStore.buildRollups({ now: new Date() }), { updateRollup: true });
  }, 5 * 60 * 1000);
  setInterval(() => {
    telemetrySafeWrite(() => telemetryStore.cleanupRawSamples({ now: new Date() }), { updateCleanup: true });
  }, 6 * 60 * 60 * 1000);
  setInterval(startAutomaticMarketValueBackfill, MARKET_VALUE_BACKFILL_INTERVAL_MS);
}

function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  persistEnergy();
  liveTelemetryBuffer?.flush({ force: true });
  if (runtimeWorker) runtimeWorker.kill();
  transport.destroy();
  scanTransport.destroy();
  if (telemetryStore) telemetryStore.close();
  if (mbServer) mbServer.close();
  if (IS_WEB_PROCESS) web.close();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

console.log('Config loaded:', {
  processRole: PROCESS_ROLE,
  httpPort: cfg.httpPort,
  modbusListenPort: cfg.modbusListenPort,
  meterPollMs: cfg.meterPollMs,
  meterAddress: `${cfg.meter.host}:${cfg.meter.port} uid=${cfg.meter.unitId} reg=${cfg.meter.address}`,
  apiTokenSet: !!cfg.apiToken,
  influxEnabled: cfg.influx.enabled,
  influxApiVersion: cfg.influx.apiVersion || 'v3',
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
