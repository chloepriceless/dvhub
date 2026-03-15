import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import * as crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  collectChangedPaths,
  detectRestartRequired,
  getConfigDefinition,
  loadConfigFile,
  saveConfigFile
} from '../../config-model.js';
import { createTelemetryStore } from '../../telemetry-store.js';
import {
  buildLiveTelemetrySamples,
  buildOptimizerRunPayload,
  buildPriceTelemetrySamples,
  resolveTelemetryDbPath
} from '../../telemetry-runtime.js';
import {
  createSerialTaskRunner,
  createTelemetryWriteBuffer,
  normalizePollIntervalMs
} from '../../runtime-performance.js';
import { createRuntimeCommandRequest, validateRuntimeCommand } from '../../runtime-commands.js';
import {
  buildHistoryImportStatusResponse,
  buildRuntimeSnapshot,
  buildWorkerBackedStatusResponse
} from '../../runtime-state.js';
import { RUNTIME_MESSAGE_TYPES, startRuntimeWorker } from '../../runtime-worker-protocol.js';
import { createHistoryApiHandlers, createHistoryRuntime } from '../../history-runtime.js';
import { createEnergyChartsMarketValueService } from '../../energy-charts-market-values.js';
import { createBundesnetzagenturApplicableValueService } from '../../bundesnetzagentur-applicable-values.js';
import { readAppVersionInfo } from '../../app-version.js';
import {
  buildAutomationRuleChain,
  buildChainVariants,
  computeAvailableEnergyKwh,
  expandChainSlots,
  filterSlotsByTimeWindow,
  filterFreeAutomationSlots,
  pickBestAutomationPlan,
  SLOT_DURATION_HOURS
} from '../../small-market-automation.js';
import {
  buildSunTimesCacheKey,
  isSunTimesCacheStale,
  readSunTimesCacheStore
} from '../../sun-times-cache.js';
import {
  autoDisableStopSocScheduleRules,
  autoDisableExpiredScheduleRules,
  parseHHMM,
  sanitizePersistedScheduleRules,
  scheduleMatch
} from '../../schedule-runtime.js';
import { createHistoryImportManager } from '../../history-import.js';
import { createModbusTransport } from '../../transport-modbus.js';
import { createMqttTransport } from '../../transport-mqtt.js';
import { discoverSystems as discoverConfiguredSystems } from '../../system-discovery.js';
import { createDeviceHal } from './device-hal.js';
import { createModbusProxy } from './modbus-proxy.js';
import { createTelemetryStreams } from './telemetry.js';
import createGatewayPlugin from './plugin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const CONFIG_PATH = process.env.DV_APP_CONFIG || path.join(APP_ROOT, 'config.json');
const execFileAsync = promisify(execFile);
const CONFIG_DEFINITION = getConfigDefinition();
let loadedConfig = loadConfigFile(CONFIG_PATH);
let rawCfg = loadedConfig.rawConfig;
let cfg = loadedConfig.effectiveConfig;
const SERVICE_ACTIONS_ENABLED = process.env.DV_ENABLE_SERVICE_ACTIONS === '1';
const SERVICE_NAME = process.env.DV_SERVICE_NAME || 'dvhub.service';
const SERVICE_USE_SUDO = process.env.DV_SERVICE_USE_SUDO !== '0';
const DATA_DIR = process.env.DV_DATA_DIR || '';
const APP_VERSION = readAppVersionInfo({ appDir: APP_ROOT });
const APPLICABLE_VALUES_CACHE_PATH = path.join(
  DATA_DIR || APP_ROOT,
  'reference-data',
  'bundesnetzagentur-applicable-values.json'
);
const SUN_TIMES_CACHE_PATH = path.join(
  DATA_DIR || APP_ROOT,
  'reference-data',
  'sun-times-cache.json'
);
const LIVE_TELEMETRY_FLUSH_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const MARKET_VALUE_BACKFILL_INTERVAL_MS = 30 * 60 * 1000;
const MARKET_VALUE_BACKFILL_MAX_YEARS_PER_RUN = 2;
const SMALL_MARKET_AUTOMATION_SOURCE = 'small_market_automation';
const SMALL_MARKET_AUTOMATION_DISPLAY_TONE = 'yellow';
const SMA_ID_PREFIX = 'sma-';
function isSmallMarketAutomationRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  return rule.source === SMALL_MARKET_AUTOMATION_SOURCE
    || (typeof rule.id === 'string' && rule.id.startsWith(SMA_ID_PREFIX));
}
const SLOT_DURATION_MS = 15 * 60 * 1000;
const RUNTIME_WORKER_ENABLED = process.env.DVHUB_ENABLE_RUNTIME_WORKER === '1';
const PROCESS_ROLE = process.env.DVHUB_PROCESS_ROLE || (RUNTIME_WORKER_ENABLED ? 'web' : 'monolith');
const IS_WEB_PROCESS = PROCESS_ROLE === 'web' || PROCESS_ROLE === 'monolith';
const IS_RUNTIME_PROCESS = PROCESS_ROLE === 'runtime-worker' || PROCESS_ROLE === 'monolith';

const state = {
  // DV state extracted to dvhub/modules/dv/ (Plan 03-03)
  ctrl: { negativePriceActive: false },
  keepalive: {
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
    active: { gridSetpointW: null, chargeCurrentA: null, minSocPct: null },
    lastWrite: { gridSetpointW: null, chargeCurrentA: null, minSocPct: null },
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
let transport = null;

// Separate Modbus-Instanz für Scan-Tool (funktioniert immer über Modbus)
let scanTransport = null;
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
let hal = null;
let modbusProxy = null;
let telemetryStreams = null;
let gatewayPluginInstance = null;
let fastifyRef = null;
const runtimeTimers = new Set();
let runtimeStopping = false;
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

function formatLocalHHMM(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const hours = parts.find((part) => part.type === 'hour')?.value || '00';
  const minutes = parts.find((part) => part.type === 'minute')?.value || '00';
  return `${hours}:${minutes}`;
}

function buildSmallMarketAutomationRules({
  now = Date.now(),
  automationConfig = cfg.schedule?.smallMarketAutomation,
  priceSlots = state.epex?.data,
  occupiedRules = state.schedule.rules,
  sunTimesCache = getSunTimesCacheForPlanning({ now })
} = {}) {
  if (!automationConfig?.enabled || !sunTimesCache) return [];

  const filteredPriceSlots = filterSlotsByTimeWindow({
    slots: priceSlots,
    searchWindowStart: automationConfig?.searchWindowStart,
    searchWindowEnd: automationConfig?.searchWindowEnd,
    timeZone: cfg.schedule?.timezone || 'Europe/Berlin'
  }).filter((slot) => Number(slot?.ts) >= now);
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
    .filter((rule) => !isSmallMarketAutomationRule(rule))
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
  // Energy-based slot allocation (if battery capacity is configured)
  const batteryCapacityKwh = automationConfig?.batteryCapacityKwh;
  const currentSocPct = state.victron?.soc;
  let availableEnergyKwh = null;

  if (batteryCapacityKwh > 0 && currentSocPct != null) {
    availableEnergyKwh = computeAvailableEnergyKwh({
      batteryCapacityKwh,
      currentSocPct,
      minSocPct: automationConfig?.minSocPct,
      inverterEfficiencyPct: automationConfig?.inverterEfficiencyPct
    });
  }

  // Hard energy gate: if battery capacity is known and no energy available, skip planning
  if (availableEnergyKwh != null && availableEnergyKwh <= 0) return [];

  // Generate multiple chain variants (1-stage, 2-stage, … N-stage prefixes),
  // each energy-truncated to the available battery budget.
  const chainVariants = buildChainVariants({
    maxDischargeW: automationConfig?.maxDischargeW,
    stages: Array.isArray(automationConfig?.stages) && automationConfig.stages.length
      ? automationConfig.stages
      : [{ dischargeW: automationConfig?.maxDischargeW, dischargeSlots: automationConfig?.targetSlotCount, cooldownSlots: 0 }],
    availableKwh: availableEnergyKwh,
    slotDurationH: SLOT_DURATION_HOURS
  });

  // Fall back to legacy single-chain if no stages are configured
  if (!chainVariants.length) {
    const fallback = buildDefaultAutomationChain(automationConfig);
    if (fallback.length) chainVariants.push(fallback);
  }

  const plan = pickBestAutomationPlan({
    slots: freeSlots,
    chainOptions: chainVariants,
    slotDurationMs: SLOT_DURATION_MS
  });

  const expandedBestChain = expandChainSlots(plan.chain);

  return (plan.selectedSlotTimestamps || []).map((slotTs, index) => {
    const slot = freeSlots.find((entry) => Number(entry?.ts) === Number(slotTs));
    if (!slot) return null;
    const start = new Date(slot.ts);
    const end = new Date(slot.ts + SLOT_DURATION_MS);
    return {
      id: `sma-${slotTs}-${index + 1}`,
      enabled: true,
      target: 'gridSetpointW',
      start: formatLocalHHMM(start, timeZone),
      end: formatLocalHHMM(end, timeZone),
      value: Number(expandedBestChain[index]?.powerW ?? automationConfig?.maxDischargeW ?? -40),
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
  const manualRules = state.schedule.rules.filter((rule) => !isSmallMarketAutomationRule(rule));
  const previousAutomationRules = state.schedule.rules.filter((rule) => isSmallMarketAutomationRule(rule));
  const batteryCapacityKwh = automationConfig?.batteryCapacityKwh;
  const currentSocPct = state.victron?.soc;
  const availableEnergyKwh = (batteryCapacityKwh > 0 && currentSocPct != null)
    ? computeAvailableEnergyKwh({
      batteryCapacityKwh,
      currentSocPct,
      minSocPct: automationConfig?.minSocPct,
      inverterEfficiencyPct: automationConfig?.inverterEfficiencyPct
    })
    : null;

  if (!automationConfig?.enabled) {
    state.schedule.smallMarketAutomation = {
      lastRunDate: runDate,
      lastOutcome: 'disabled',
      generatedRuleCount: 0,
      availableEnergyKwh,
      lastSocPct: currentSocPct
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
  // Regenerate when SOC changed significantly (>5%) — energy budget may have shifted
  const socChanged = automationConfig?.batteryCapacityKwh > 0
    && currentSocPct != null
    && lastState?.lastSocPct != null
    && Math.abs(currentSocPct - lastState.lastSocPct) >= 5;
  const needsRegeneration = !lastState?.lastRunDate
    || lastState.lastRunDate !== runDate
    || !previousAutomationRules.length
    || priceDataChanged
    || socChanged;
  if (!needsRegeneration) return;

  const sunTimesCache = getSunTimesCacheForPlanning({ now });

  // --- Planning phase: compute plan first, then apply ---
  const planInput = {
    now,
    automationConfig,
    priceSlots: state.epex?.data,
    occupiedRules: manualRules,
    sunTimesCache
  };

  if (!sunTimesCache) {
    state.schedule.smallMarketAutomation = {
      lastRunDate: runDate,
      lastOutcome: 'missing_sun_times_cache',
      generatedRuleCount: 0,
      lastPriceSlotCount: priceSlotCount,
      availableEnergyKwh,
      lastSocPct: currentSocPct,
      plan: null
    };
    // Remove stale automation rules when planning fails
    if (previousAutomationRules.length) {
      state.schedule.rules = manualRules;
      persistConfig();
    }
    return;
  }

  const generatedRules = buildSmallMarketAutomationRules(planInput);

  // Build transparent plan summary for the UI
  const selectedSlotTimestamps = generatedRules
    .map((r) => {
      const match = r?.id?.match(/^sma-(\d+)-/);
      return match ? Number(match[1]) : null;
    })
    .filter((ts) => ts != null);

  const planSummary = {
    computedAt: new Date(now).toISOString(),
    slotsConsidered: Array.isArray(state.epex?.data) ? state.epex.data.length : 0,
    futureSlots: generatedRules.length > 0 ? selectedSlotTimestamps.length : 0,
    selectedSlots: selectedSlotTimestamps.map((ts, index) => ({
      ts,
      time: new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }),
      priceCtKwh: state.epex?.data?.find((s) => Number(s.ts) === ts)?.ct_kwh ?? null,
      powerW: generatedRules[index]?.value ?? null
    })),
    availableEnergyKwh,
    currentSocPct,
    minSocPct: automationConfig?.minSocPct,
    maxDischargeW: automationConfig?.maxDischargeW,
    estimatedRevenueCt: generatedRules.reduce((sum, r) => {
      const slot = state.epex?.data?.find((s) => {
        const match = r?.id?.match(/^sma-(\d+)-/);
        return match && Number(s.ts) === Number(match[1]);
      });
      if (!slot) return sum;
      return sum + (Math.abs(Number(r.value)) / 1000) * SLOT_DURATION_HOURS * Number(slot.ct_kwh || 0) / 100;
    }, 0)
  };

  // Apply rules
  state.schedule.rules = [...manualRules, ...generatedRules];
  state.schedule.smallMarketAutomation = {
    lastRunDate: runDate,
    lastOutcome: generatedRules.length ? 'generated' : 'no_slots',
    generatedRuleCount: generatedRules.length,
    lastPriceSlotCount: priceSlotCount,
    availableEnergyKwh,
    lastSocPct: currentSocPct,
    selectedSlotTimestamps,
    plan: planSummary
  };
  persistConfig();
  pushLog('sma_plan_applied', {
    slots: planSummary.futureSlots,
    energyKwh: availableEnergyKwh,
    estimatedRevenueEur: Math.round(planSummary.estimatedRevenueCt) / 100
  });
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
  const dvState = typeof dvStateProvider === 'function' ? dvStateProvider() : null;
  return {
    now: Number(now),
    dvControlValue: dvState?.controlValue ?? 1,
    dvRegs: dvState?.dvRegs ?? { 0: 0, 1: 0, 3: 0, 4: 0 },
    ctrl: dvState?.ctrl ?? { ...state.ctrl },
    keepalive: {
      ...state.keepalive,
      modbusLastQuery: dvState?.keepalive?.modbusLastQuery ?? state.keepalive?.modbusLastQuery ?? null
    },
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

const ENERGY_PATH = path.join(APP_ROOT, 'energy_state.json');

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

// u16() has been extracted to dvhub/modules/dv/dv-state.js
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

function validateScheduleRule(rule) {
  if (typeof rule !== 'object' || rule === null) return false;
  if (typeof rule.target !== 'string') return false;
  if (rule.value !== undefined && !Number.isFinite(Number(rule.value))) return false;
  return true;
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

// DV functions extracted to dvhub/modules/dv/ (Plan 03-03)

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

  const currentEpex = epexNowNext()?.current;
  const epexCtKwh = Number(currentEpex?.ct_kwh ?? 0);

  // Import cost: use the user's configured electricity price (Bezugspreis),
  // not the raw EPEX price. resolveImportPriceCtKwhForSlot handles fixed,
  // dynamic, and Paragraph 14a Module 3 pricing modes.
  const importSlot = { ts: nowMs, ct_kwh: epexCtKwh };
  const importCtKwh = resolveImportPriceCtKwhForSlot(importSlot) ?? epexCtKwh;
  state.energy.costEur += (importW / 1000) * dtH * (importCtKwh / 100);

  // Export revenue: EPEX price is the actual feed-in compensation
  state.energy.revenueEur += (exportW / 1000) * dtH * (epexCtKwh / 100);
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
  // DV control metrics are now emitted by the DV module when enabled
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
    const halReading = hal?.readMeter ? await hal.readMeter() : null;
    const halGridPower = Number(halReading?.gridPower);

    if (Number.isFinite(halGridPower)) {
      const posImport = cfg.gridPositiveMeans === 'grid_import';
      const sign = posImport ? 1 : -1;
      total = halGridPower * sign;
      l1 = s16(Number(halReading?.raw?.meter?.[0] ?? 0)) * sign;
      l2 = s16(Number(halReading?.raw?.meter?.[1] ?? 0)) * sign;
      l3 = s16(Number(halReading?.raw?.meter?.[2] ?? 0)) * sign;
      state.meter = {
        ok: true,
        updatedAt: Number(halReading?.timestamp || Date.now()),
        raw: Array.isArray(halReading?.raw?.meter) ? halReading.raw.meter : [],
        grid_l1_w: Number.isFinite(l1) ? l1 : 0,
        grid_l2_w: Number.isFinite(l2) ? l2 : 0,
        grid_l3_w: Number.isFinite(l3) ? l3 : 0,
        grid_total_w: total,
        error: null
      };
      if (Number.isFinite(Number(halReading?.soc))) state.victron.soc = Number(halReading.soc);
      if (Number.isFinite(Number(halReading?.batteryPower))) state.victron.batteryPowerW = Number(halReading.batteryPower);
      if (Number.isFinite(Number(halReading?.pvPower))) state.victron.pvPowerW = Number(halReading.pvPower);
    } else if (transport.type === 'mqtt') {
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

    // DV register updates (setReg) now handled by DV module via telemetry stream subscription

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

  telemetryStreams?.update({
    meter: state.meter,
    victron: state.victron,
    schedule: state.schedule,
    epex: state.epex
  });

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

  for (const target of ['gridSetpointW', 'chargeCurrentA', 'minSocPct']) {
    const eff = effectiveTargetValue(target);
    if (eff.value == null) continue;

    // If no controlWrite config for this target, just track the active value
    if (!cfg.controlWrite?.[target]?.enabled) {
      state.schedule.active[target] = { value: eff.value, source: eff.source, at: Date.now() };
      continue;
    }

    // Bei negativen Preisen: DC/AC Einspeisung blockieren + Grid Setpoint begrenzen
    if (target === 'gridSetpointW' && priceNegative) {
      const limit = Number(npp.gridSetpointW ?? -40);
      const prev = state.ctrl.negativePriceActive;
      if (!prev) pushLog('negative_price_protection_on', { price: priceNow.ct_kwh, limit });
      state.ctrl.negativePriceActive = true;
      // Victron DC/AC curtailment during negative prices is now handled
      // by DV module via control intents (Phase 6 arbitration will consume these)
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
    // DV curtailment release during price recovery is now handled by DV module
  }

  publishRuntimeSnapshot();
}

function keepaliveModbusPayload() {
  // Modbus keepalive tracking has moved to DV module (modbus-slave.js)
  return {
    ok: false,
    lastQuery: null,
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
    // DV control value provided by DV module when enabled
    dvControlValue: 1,
    forcedOff: false,
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
  const expected = Buffer.from(cfg.apiToken);
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const token = Buffer.from(auth.slice(7));
    if (token.length === expected.length && crypto.timingSafeEqual(token, expected)) return true;
  }
  const urlToken = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
  if (urlToken) {
    const urlBuf = Buffer.from(urlToken);
    if (urlBuf.length === expected.length && crypto.timingSafeEqual(urlBuf, expected)) return true;
  }
  res.writeHead(401, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
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

const REDACTED_PATHS = ['apiToken', 'influx.token', 'telemetry.historyImport.vrmToken'];

function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const dotPath of REDACTED_PATHS) {
    const parts = dotPath.split('.');
    let obj = copy;
    for (let i = 0; i < parts.length - 1; i++) { obj = obj?.[parts[i]]; if (!obj) break; }
    if (obj && parts[parts.length - 1] in obj) obj[parts[parts.length - 1]] = '***';
  }
  return copy;
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
    config: redactConfig(rawCfg),
    effectiveConfig: redactConfig(cfg),
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

function trackTimer(timer) {
  runtimeTimers.add(timer);
  return timer;
}

function clearRuntimeTimers() {
  for (const timer of runtimeTimers) {
    clearInterval(timer);
    clearTimeout(timer);
  }
  runtimeTimers.clear();
}

function applyRuntimeConfig(rawConfig, config) {
  loadedConfig = {
    ...loadedConfig,
    rawConfig,
    effectiveConfig: config,
    valid: true,
    parseError: null,
    exists: true,
    needsSetup: false
  };
  applyLoadedConfig({ rawConfig, effectiveConfig: config });
}

function serializeLoxoneState(payload) {
  return Object.entries(payload)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join('\n');
}

function buildVersionPayload() {
  return {
    ok: true,
    version: APP_VERSION.version,
    revision: APP_VERSION.revision,
    versionLabel: APP_VERSION.versionLabel,
    app: APP_VERSION
  };
}

function getCurrentRuntimeSnapshot() {
  return telemetryStreams?.getSnapshot?.() || {
    meter: state.meter,
    soc: state.victron.soc,
    gridPower: state.meter.grid_total_w,
    pvPower: state.victron.pvTotalW,
    batteryPower: state.victron.batteryPowerW,
    victron: state.victron,
    schedule: state.schedule,
    epex: state.epex
  };
}

function buildGatewayRouteApi() {
  return {
    getRootPage() {
      return loadedConfig.needsSetup ? 'setup.html' : 'index.html';
    },

    getPublicDir() {
      return PUBLIC_DIR;
    },

    getStatus() {
      expireLeaseIfNeeded();
      return buildApiStatusResponse(Date.now());
    },

    getVersion() {
      return buildVersionPayload();
    },

    getConfig() {
      return configApiPayload();
    },

    postConfig(body, source = 'settings') {
      if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
        return { status: 400, body: { ok: false, error: 'config object required' } };
      }

      const result = saveAndApplyConfig(body.config);
      pushLog('config_saved', {
        changedPaths: result.changedPaths.length,
        restartRequired: result.restartRequired,
        source
      });

      return {
        status: 200,
        body: {
          ok: true,
          meta: configMetaPayload(),
          config: rawCfg,
          effectiveConfig: cfg,
          changedPaths: result.changedPaths,
          restartRequired: result.restartRequired,
          restartRequiredPaths: result.restartRequiredPaths
        }
      };
    },

    getConfigExport() {
      return rawCfg;
    },

    async getSystemDiscovery(query) {
      const payload = await buildSystemDiscoveryPayload({ query });
      return { status: payload.ok ? 200 : 400, body: payload };
    },

    async getAdminHealth() {
      return adminHealthPayload();
    },

    async restartService() {
      if (!SERVICE_ACTIONS_ENABLED) {
        return { status: 403, body: { ok: false, error: 'service actions disabled' } };
      }

      const check = await runServiceCommand(['show', SERVICE_NAME, '--property=Id', '--value']);
      if (!check.ok) {
        return { status: 500, body: { ok: false, error: check.error, command: check.command } };
      }

      scheduleServiceRestart();
      pushLog('service_restart_scheduled', { service: SERVICE_NAME });
      return {
        status: 202,
        body: {
          ok: true,
          accepted: true,
          service: SERVICE_NAME,
          message: 'Service restart scheduled'
        }
      };
    },

    getLog(limit) {
      const resolvedLimit = resolveLogLimit(limit);
      return { rows: state.log.slice(-resolvedLimit) };
    },

    getKeepaliveModbus() {
      return keepaliveModbusPayload();
    },

    getKeepalivePulse() {
      return keepalivePulsePayload();
    },

    getCosts() {
      return costSummary();
    },

    getIntegrationState() {
      return integrationState();
    },

    getLoxoneState() {
      return serializeLoxoneState(integrationState());
    },

    getEosState() {
      return eosState();
    },

    async postEosApply(body = {}) {
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

      return { ok: true, results };
    },

    getEmhassState() {
      return emhassState();
    },

    async postEmhassApply(body = {}) {
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

      return { ok: true, results };
    },

    getHistoryImportStatus() {
      return buildApiHistoryImportStatusResponse();
    },

    async postHistoryImport(body = {}) {
      if (!historyImportManager) {
        return { status: 503, body: { ok: false, error: 'internal telemetry store disabled' } };
      }

      if (body.mode === 'backfill') {
        assertValidRuntimeCommand('history_backfill', { mode: 'gap', requestedBy: 'history_import_endpoint' });
        const result = await historyImportManager.backfillHistoryFromConfiguredSource({ mode: 'gap' });
        return { status: result.ok ? 200 : 400, body: result };
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

      return { status: result.ok ? 200 : 400, body: result };
    },

    async postHistoryBackfillVrm(body = {}) {
      if (!historyImportManager) {
        return { status: 503, body: { ok: false, error: 'internal telemetry store disabled' } };
      }

      const requestedMode = body?.mode === 'full' ? 'full' : 'gap';
      assertValidRuntimeCommand('history_backfill', {
        mode: requestedMode,
        requestedBy: 'history_backfill_endpoint'
      });
      const result = await historyImportManager.backfillHistoryFromConfiguredSource({ ...body, mode: requestedMode });
      return { status: result.ok ? 200 : 400, body: result };
    },

    async getHistorySummary(query) {
      if (!historyApi || typeof historyApi.getSummary !== 'function') {
        return { status: 503, body: { ok: false, error: 'internal telemetry store disabled' } };
      }

      const result = await historyApi.getSummary({
        view: query.view,
        date: query.date
      });

      return { status: result.status, body: result.body };
    },

    async postHistoryBackfillPrices(body = {}) {
      if (!historyApi || typeof historyApi.postPriceBackfill !== 'function') {
        return { status: 503, body: { ok: false, error: 'internal telemetry store disabled' } };
      }

      const result = await historyApi.postPriceBackfill(body || {});
      return { status: result.status, body: result.body };
    },

    async postEpexRefresh() {
      await fetchEpexDay();
      return { ok: state.epex.ok, error: state.epex.error };
    },

    async postMeterScan(body = {}) {
      runMeterScan(body).catch((error) => {
        state.scan.running = false;
        state.scan.error = error.message;
      });
      return { ok: true, running: true };
    },

    getMeterScan() {
      return state.scan;
    },

    getMeterValues() {
      return {
        meter: state.meter,
        victron: state.victron,
        snapshot: getCurrentRuntimeSnapshot()
      };
    },

    // getControlValue and postControlLease have been moved to DV module routes
    // (dvhub/modules/dv/routes/dv-routes.js)

    getControlTarget() {
      return {
        ok: true,
        active: state.schedule.active,
        lastWrite: state.schedule.lastWrite,
        manualOverride: state.schedule.manualOverride
      };
    },

    async postControlWrite(body = {}) {
      const target = String(body.target || '');
      const value = Number(body.value);
      assertValidRuntimeCommand('control_write', { target, value });
      state.schedule.manualOverride[target] = { value, at: Date.now() };
      const result = await applyControlTarget(target, value, 'api_manual_write');
      return { status: result.ok ? 200 : 500, body: result };
    },

    getSchedule() {
      return {
        config: state.schedule.config,
        rules: state.schedule.rules,
        active: state.schedule.active,
        lastWrite: state.schedule.lastWrite
      };
    },

    getScheduleStatus() {
      return {
        ok: true,
        lastEvalAt: state.schedule.lastEvalAt,
        active: state.schedule.active,
        config: state.schedule.config,
        smallMarketAutomation: state.schedule.smallMarketAutomation
      };
    },

    postScheduleRules(body = {}) {
      if (!Array.isArray(body.rules)) {
        return { status: 400, body: { ok: false, error: 'rules array required' } };
      }
      const validRules = body.rules.filter(validateScheduleRule);
      if (validRules.length !== body.rules.length) {
        return { status: 400, body: { ok: false, error: 'invalid rule structure' } };
      }

      const incomingManualRules = validRules.filter((rule) => !isSmallMarketAutomationRule(rule));
      const existingAutomationRules = state.schedule.rules.filter((rule) => isSmallMarketAutomationRule(rule));
      state.schedule.rules = [...incomingManualRules, ...existingAutomationRules];
      pushLog('schedule_rules_updated', { manual: incomingManualRules.length, automation: existingAutomationRules.length });
      persistConfig();

      return { status: 200, body: { ok: true, count: state.schedule.rules.length } };
    },

    postScheduleConfig(body = {}) {
      if (body.defaultGridSetpointW !== undefined) {
        const value = Number(body.defaultGridSetpointW);
        if (!Number.isFinite(value)) {
          return { status: 400, body: { ok: false, error: 'defaultGridSetpointW invalid' } };
        }
        state.schedule.config.defaultGridSetpointW = value;
      }

      if (body.defaultChargeCurrentA !== undefined) {
        const value = Number(body.defaultChargeCurrentA);
        if (!Number.isFinite(value)) {
          return { status: 400, body: { ok: false, error: 'defaultChargeCurrentA invalid' } };
        }
        state.schedule.config.defaultChargeCurrentA = value;
      }

      pushLog('schedule_config_updated', { config: state.schedule.config });
      persistConfig();
      return { status: 200, body: { ok: true, config: state.schedule.config } };
    },

    getAutomationConfig() {
      return { ok: true, config: cfg.schedule?.smallMarketAutomation || {} };
    },

    postAutomationConfig(body = {}) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 400, body: { ok: false, error: 'invalid body' } };
      }

      const allowedKeys = new Set([
        'enabled',
        'searchWindowStart',
        'searchWindowEnd',
        'targetSlotCount',
        'maxDischargeW',
        'batteryCapacityKwh',
        'inverterEfficiencyPct',
        'minSocPct',
        'aggressivePremiumPct',
        'location',
        'stages'
      ]);
      const filteredBody = Object.fromEntries(
        Object.entries(body).filter(([key]) => allowedKeys.has(key))
      );

      const current = JSON.parse(JSON.stringify(rawCfg || {}));
      current.schedule = current.schedule || {};
      current.schedule.smallMarketAutomation = {
        ...current.schedule.smallMarketAutomation,
        ...filteredBody
      };

      saveAndApplyConfig(current);
      regenerateSmallMarketAutomationRules();
      return { status: 200, body: { ok: true, config: cfg.schedule.smallMarketAutomation } };
    },

    getRawConfig() {
      return rawCfg;
    },

    getEffectiveConfig() {
      return cfg;
    },

    getState() {
      return state;
    },

    getRuntimeSnapshot() {
      return getCurrentRuntimeSnapshot();
    }
  };
}

const pollMeterRunner = createSerialTaskRunner({
  queueWhileRunning: false,
  task: () => pollMeter()
});

function requestPollMeter() {
  return pollMeterRunner.run();
}

function startRuntimeLoops() {
  if (!IS_RUNTIME_PROCESS) return;

  let transportRetryDelayMs = 5000;

  const scheduleTransportRetry = () => {
    const retryDelayMs = transportRetryDelayMs;
    trackTimer(setTimeout(() => {
      if (runtimeStopping) return;
      initTransport();
    }, retryDelayMs));
    transportRetryDelayMs = Math.min(60000, transportRetryDelayMs * 2);
  };

  const initTransport = () => {
    transport.init().then(() => {
      transportRetryDelayMs = 5000;
      fastifyRef?.log?.info({ transport: transport.type }, 'Transport initialisiert');
    }).catch((error) => {
      fastifyRef?.log?.error({ err: error }, 'Transport init fehlgeschlagen');
      scheduleTransportRetry();
    });
  };

  const schedulePollLoop = () => {
    trackTimer(setTimeout(() => {
      if (runtimeStopping) return;
      requestPollMeter().catch((error) => pushLog('poll_meter_error', { error: error.message })).finally(() => {
        if (!runtimeStopping) schedulePollLoop();
      });
    }, effectivePollIntervalMs()));
  };

  const scheduleEvaluateLoop = () => {
    trackTimer(setTimeout(() => {
      if (runtimeStopping) return;
      evaluateSchedule().catch((error) => pushLog('schedule_eval_error', { error: error.message })).finally(() => {
        if (!runtimeStopping) scheduleEvaluateLoop();
      });
    }, Math.max(5000, Number(cfg.schedule.evaluateMs || 15000))));
  };

  loadEnergy();
  trackTimer(setInterval(expireLeaseIfNeeded, 1000));
  trackTimer(setInterval(() => liveTelemetryBuffer?.flush(), 1000));
  trackTimer(setInterval(() => publishRuntimeSnapshot(), 1000));

  initTransport();
  requestPollMeter().catch((error) => {
    fastifyRef?.log?.error({ err: error }, 'Initial pollMeter error');
  });
  schedulePollLoop();
  scheduleEvaluateLoop();

  fetchEpexDay().catch((error) => {
    fastifyRef?.log?.error({ err: error }, 'Initial EPEX fetch failed');
  });

  trackTimer(setInterval(() => {
    const mustRefresh = !state.epex.date || state.epex.date !== berlinDateString();
    if (mustRefresh || (Date.now() - state.epex.updatedAt) > 6 * 60 * 60 * 1000) {
      fetchEpexDay().catch((error) => pushLog('epex_refresh_err', { error: error.message }));
    }
  }, 5 * 60 * 1000));

  trackTimer(setInterval(() => {
    flushInflux().catch((error) => pushLog('influx_flush_error', { error: error.message }));
  }, INFLUX_FLUSH_MS));

  trackTimer(setInterval(persistEnergy, 60000));

  trackTimer(setInterval(() => {
    telemetrySafeWrite(() => telemetryStore.buildRollups({ now: new Date() }), { updateRollup: true });
  }, 5 * 60 * 1000));

  trackTimer(setInterval(() => {
    telemetrySafeWrite(() => telemetryStore.cleanupRawSamples({ now: new Date() }), { updateCleanup: true });
  }, 6 * 60 * 60 * 1000));

  trackTimer(setInterval(startAutomaticMarketValueBackfill, MARKET_VALUE_BACKFILL_INTERVAL_MS));
}

async function initializeGatewayRuntime(ctx) {
  fastifyRef = ctx.fastify;
  runtimeStopping = false;

  const configFromDisk = loadConfigFile(CONFIG_PATH);
  loadedConfig = configFromDisk;
  applyRuntimeConfig(ctx.rawConfig, ctx.config);

  transport = cfg.victron?.transport === 'mqtt'
    ? createMqttTransport(cfg.victron)
    : createModbusTransport();
  scanTransport = createModbusTransport();

  telemetryStreams = createTelemetryStreams(ctx.eventBus);

  hal = await createDeviceHal({
    manufacturer: cfg.manufacturer || 'victron',
    ...(cfg.victron || {})
  }, transport).catch((error) => {
    pushLog('hal_init_error', { error: error.message });
    return null;
  });

  modbusProxy = createModbusProxy({ config: cfg, eventBus: ctx.eventBus, log: ctx.fastify.log });
  // Frame handler is set by the DV module during its init (modbusProxy.setFrameHandler)
  await modbusProxy.start();

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

  if (IS_RUNTIME_PROCESS && historyImportManager) {
    historyImportManager.startAutomaticBackfill();
  }

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

  if (PROCESS_ROLE === 'runtime-worker' && typeof process.send === 'function') {
    process.send({
      type: RUNTIME_MESSAGE_TYPES.RUNTIME_READY,
      pid: process.pid
    });
    publishRuntimeSnapshot();
  }

  startRuntimeLoops();

  telemetryStreams.update({
    meter: state.meter,
    victron: state.victron,
    schedule: state.schedule,
    epex: state.epex
  });

  const routeApi = buildGatewayRouteApi();
  gatewayPluginInstance = createGatewayPlugin({
    api: routeApi,
    config: cfg,
    rawConfig: rawCfg,
    getConfig: () => cfg,
    getRawConfig: () => rawCfg,
    getSnapshot: () => routeApi.getRuntimeSnapshot(),
    getState: () => state,
    state,
    configPath: CONFIG_PATH,
    logBuffer: state.log,
    appVersion: APP_VERSION,
    onConfigSaved: () => {
      // Sync gateway runtime state with newly saved config
      state.schedule.config.defaultGridSetpointW = cfg.schedule.defaultGridSetpointW;
      state.schedule.config.defaultChargeCurrentA = cfg.schedule.defaultChargeCurrentA;
      state.schedule.rules = Array.isArray(cfg.schedule.rules) ? cfg.schedule.rules : [];
      state.keepalive.appPulse.periodSec = cfg.keepalivePulseSec;
    },
    hal,
    eventBus: ctx.eventBus,
    // controlValue has been moved to DV module (curtailment.js)
    assertValidRuntimeCommand,
    applyControlTarget,
    validateScheduleRule,
    isSmallMarketAutomationRule,
    pushLog,
    persistConfig,
    saveAndApplyConfig,
    regenerateSmallMarketAutomationRules,
    integrationState,
    eosState,
    emhassState,
    telemetrySafeWrite,
    getTelemetryStore: () => telemetryStore,
    telemetryStore,
    buildOptimizerRunPayload,
    fetchEpexDay,
    runMeterScan,
    buildApiHistoryImportStatusResponse,
    getHistoryImportManager: () => historyImportManager,
    historyImportManager,
    getHistoryApi: () => historyApi,
    historyApi,
    scheduleRuntime: {
      evaluateSchedule,
      regenerateSmallMarketAutomationRules
    }
  });
}

async function destroyGatewayRuntime() {
  runtimeStopping = true;
  clearRuntimeTimers();
  persistEnergy();

  liveTelemetryBuffer?.flush({ force: true });
  if (runtimeWorker) {
    runtimeWorker.kill();
    runtimeWorker = null;
  }

  if (modbusProxy) {
    await modbusProxy.stop().catch(() => {});
    modbusProxy = null;
  }

  await transport?.destroy?.().catch(() => {});
  await scanTransport?.destroy?.().catch(() => {});

  if (telemetryStore) {
    telemetryStore.close();
    telemetryStore = null;
  }

  transport = null;
  scanTransport = null;
  hal = null;
  historyImportManager = null;
  historyRuntime = null;
  historyApi = null;
  energyChartsMarketValueService = null;
  liveTelemetryBuffer = null;
  telemetryStreams = null;
  runtimeWorkerSnapshot = null;
  runtimeWorkerStatusPayload = null;
  runtimeWorkerHeartbeatAt = 0;
  runtimeWorkerState = {
    ready: false,
    lastError: null
  };
  gatewayPluginInstance = null;
  fastifyRef = null;
  refreshTelemetryStatus();
}

let dvStateProvider = null;

export function createGatewayModule() {
  return {
    name: 'gateway',
    requires: [],
    plugin: null,
    modbusProxy: null,
    hal: null,

    /**
     * Called by the DV module after its init to inject DV state into /api/status.
     * @param {function} provider - Returns { dvRegs, ctrl, controlValue }
     */
    setDvStateProvider(provider) {
      dvStateProvider = typeof provider === 'function' ? provider : null;
    },

    async init(ctx) {
      await initializeGatewayRuntime(ctx);
      this.plugin = gatewayPluginInstance;
      this.modbusProxy = modbusProxy;
      this.hal = hal;
    },

    async destroy() {
      dvStateProvider = null;
      await destroyGatewayRuntime();
      this.plugin = null;
      this.modbusProxy = null;
      this.hal = null;
    }
  };
}
