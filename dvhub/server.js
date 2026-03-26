import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
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
} from './config-model.js';
import { createTelemetryStorePg, ensurePgSchema } from './telemetry-store-pg.js';
import { createPool } from './db-client.js';
import {
  buildLiveTelemetrySamples,
  buildOptimizerRunPayload
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
  buildChainVariants,
  computeAvailableEnergyKwh,
  computeDynamicAutomationMinSocPct,
  computeEnergyBasedSlotAllocation,
  computeNextPeriodBounds,
  expandChainSlots,
  filterSlotsByTimeWindow,
  filterFreeAutomationSlots,
  pickBestAutomationPlan,
  pickMultiBlockPlan,
  SLOT_DURATION_HOURS
} from './small-market-automation.js';
import { pickMilpPlan } from './milp-optimizer.js';
import {
  buildSunTimesCacheKey,
  isSunTimesCacheStale,
  readSunTimesForDate,
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
import {
  nowIso, fmtTs, resolveLogLimit, u16, s16, parseBody,
  roundCtKwh, berlinDateString, addDays, localMinutesOfDay,
  gridDirection, MAX_BODY_BYTES
} from './server-utils.js';
import {
  effectiveBatteryCostCtKwh,
  mixedCostCtKwh,
  slotComparison,
  resolveImportPriceCtKwhForSlot,
  configuredModule3Windows
} from './user-energy-pricing.js';
import { createModbusServer } from './modbus-server.js';
import { createEpexFetcher } from './epex-fetch.js';

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

/**
 * Compute discharge slot count from available energy when no custom stages are configured.
 * Falls back to targetSlotCount (manual cap) or a sensible default.
 */
function computeDefaultDischargeSlots(automationConfig, availableEnergyKwh) {
  const maxDischargeW = automationConfig?.maxDischargeW;
  // Energy-based: compute how many slots the battery can serve at the configured power
  if (availableEnergyKwh != null && availableEnergyKwh > 0 && maxDischargeW) {
    const { totalSlots } = computeEnergyBasedSlotAllocation({
      availableKwh: availableEnergyKwh,
      maxDischargeW
    });
    // If a manual targetSlotCount is set, use it as an upper cap
    const cap = automationConfig?.targetSlotCount;
    return (cap != null && cap > 0) ? Math.min(totalSlots, cap) : totalSlots;
  }
  // Fallback: use manual targetSlotCount (legacy behaviour)
  return automationConfig?.targetSlotCount || 4;
}

function buildDefaultAutomationChain(automationConfig = {}, availableEnergyKwh = null) {
  const stages = Array.isArray(automationConfig?.stages) && automationConfig.stages.length
    ? automationConfig.stages
    : [{
      dischargeW: automationConfig?.maxDischargeW,
      dischargeSlots: computeDefaultDischargeSlots(automationConfig, availableEnergyKwh),
      cooldownSlots: 0
    }];
  return buildAutomationRuleChain({
    maxDischargeW: automationConfig?.maxDischargeW,
    engine: automationConfig?.engine || 'greedy',
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

async function buildSmallMarketAutomationRules({
  now = Date.now(),
  automationConfig = cfg.schedule?.smallMarketAutomation,
  priceSlots = state.epex?.data,
  occupiedRules = state.schedule.rules,
  sunTimesCache = getSunTimesCacheForPlanning({ now })
} = {}) {
  if (!automationConfig?.enabled || !sunTimesCache) return [];

  const timeZoneForFilter = cfg.schedule?.timezone || 'Europe/Berlin';
  const periodBounds = computeNextPeriodBounds({
    now,
    searchWindowStart: automationConfig?.searchWindowStart,
    searchWindowEnd: automationConfig?.searchWindowEnd,
    timeZone: timeZoneForFilter
  });
  const filteredPriceSlots = filterSlotsByTimeWindow({
    slots: priceSlots,
    searchWindowStart: automationConfig?.searchWindowStart,
    searchWindowEnd: automationConfig?.searchWindowEnd,
    timeZone: timeZoneForFilter
  }).filter((slot) => {
    const ts = Number(slot?.ts);
    if (ts < now) return false;
    // Constrain to the next period only (not subsequent periods)
    if (periodBounds) {
      return ts >= periodBounds.startTs && ts < periodBounds.endTs;
    }
    return true;
  });
  const timeZone = cfg.schedule?.timezone || 'Europe/Berlin';
  const dateStr = berlinDateString(new Date(now), cfg.epex.timezone);
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
    .filter((rule) => !isSmallMarketAutomationRule(rule) && rule.enabled !== false)
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

  // Dynamic SOC floor: sunrise/sunset-aware energy budgeting.
  // Each slot gets a time-dependent energy budget — morning slots near sunrise
  // can access more battery energy because the SOC floor is lower then.
  // perSlotBudgets: array of { ts, budgetKwh } sorted chronologically.
  let perSlotBudgets = null;
  let sunsetMsForPlanning = null;
  let sunriseMsForPlanning = null;

  if (sunTimesCache?.cache && freeSlots.length) {
    // Find sunrise for the latest slot date and sunset from the previous day
    const latestSlotTs = Math.max(...freeSlots.map(s => Number(s?.ts) || 0));
    const latestSlotDate = berlinDateString(new Date(latestSlotTs), cfg.epex.timezone);
    const sunTimes = readSunTimesForDate({ cache: sunTimesCache.cache, dateKey: latestSlotDate });
    if (sunTimes?.sunriseTs && sunTimes?.sunsetTs) {
      sunriseMsForPlanning = new Date(sunTimes.sunriseTs).getTime();
      const prevDate = berlinDateString(new Date(latestSlotTs - 86400000), cfg.epex.timezone);
      const prevSunTimes = readSunTimesForDate({ cache: sunTimesCache.cache, dateKey: prevDate });
      sunsetMsForPlanning = prevSunTimes?.sunsetTs
        ? new Date(prevSunTimes.sunsetTs).getTime()
        : sunriseMsForPlanning - 12 * 3600000;

      if (batteryCapacityKwh > 0 && currentSocPct != null) {
        perSlotBudgets = freeSlots
          .map(s => Number(s?.ts) || 0)
          .sort((a, b) => a - b)
          .map(ts => {
            const dynamicMin = computeDynamicAutomationMinSocPct({
              automationMinSocPct: automationConfig?.minSocPct,
              globalMinSocPct: state.victron?.minSocPct ?? 10,
              sunsetTs: sunsetMsForPlanning,
              sunriseTs: sunriseMsForPlanning,
              nowTs: ts
            });
            return {
              ts,
              budgetKwh: computeAvailableEnergyKwh({
                batteryCapacityKwh,
                currentSocPct,
                minSocPct: dynamicMin,
                inverterEfficiencyPct: automationConfig?.inverterEfficiencyPct
              })
            };
          });
      }
    }
  }

  // Overall energy budget: use the most generous (latest/sunrise) budget
  if (batteryCapacityKwh > 0 && currentSocPct != null) {
    if (perSlotBudgets?.length) {
      availableEnergyKwh = perSlotBudgets[perSlotBudgets.length - 1].budgetKwh;
    } else {
      availableEnergyKwh = computeAvailableEnergyKwh({
        batteryCapacityKwh,
        currentSocPct,
        minSocPct: automationConfig?.minSocPct,
        inverterEfficiencyPct: automationConfig?.inverterEfficiencyPct
      });
    }
  }

  // Hard energy gate: if battery capacity is known and no energy available, skip planning
  if (availableEnergyKwh != null && availableEnergyKwh <= 0) return [];

  // Generate multiple chain variants (1-stage, 2-stage, … N-stage prefixes),
  // each energy-truncated to the available battery budget.
  const chainVariants = buildChainVariants({
    maxDischargeW: automationConfig?.maxDischargeW,
    stages: Array.isArray(automationConfig?.stages) && automationConfig.stages.length
      ? automationConfig.stages
      : [{ dischargeW: automationConfig?.maxDischargeW, dischargeSlots: computeDefaultDischargeSlots(automationConfig, availableEnergyKwh), cooldownSlots: 0 }],
    availableKwh: availableEnergyKwh,
    slotDurationH: SLOT_DURATION_HOURS
  });

  // Fall back to legacy single-chain if no stages are configured.
  // IMPORTANT: Do NOT use the fallback when energy budget is known — the budget
  // already truncated all variants to empty, meaning the battery does not have
  // enough energy for even a single slot at the configured power.  Bypassing the
  // budget here would create many rules the battery cannot actually serve.
  if (!chainVariants.length && !(availableEnergyKwh != null && availableEnergyKwh > 0)) {
    const fallback = buildDefaultAutomationChain(automationConfig, availableEnergyKwh);
    if (fallback.length) chainVariants.push(fallback);
  }

  // --- Engine selection: greedy (legacy) vs MILP (optimal) ---
  const engine = automationConfig?.engine || 'greedy';
  let plan;

  if (engine === 'milp') {
    // MILP: mathematisch optimale Block-Platzierung via HiGHS
    // When no custom stages are configured, use single-slot stages so the MILP
    // can place each slot independently at the most profitable time (non-contiguous).
    const hasCustomStages = Array.isArray(automationConfig?.stages) && automationConfig.stages.length > 0;
    const milpStages = hasCustomStages
      ? automationConfig.stages
      : [{ dischargeW: automationConfig?.maxDischargeW, dischargeSlots: 1, cooldownSlots: 0 }];
    try {
      plan = await pickMilpPlan({
        slots: freeSlots,
        stages: milpStages,
        maxDischargeW: automationConfig?.maxDischargeW,
        availableKwh: availableEnergyKwh,
        perSlotBudgets: perSlotBudgets || null,
        slotDurationMs: SLOT_DURATION_MS,
        slotDurationH: SLOT_DURATION_HOURS
      });
      if (plan.totalRevenueCt <= 0 || !plan.selectedSlotTimestamps.length) {
        plan = null; // Fallback to greedy
      }
    } catch (e) {
      pushLog('milp_error', { error: e.message });
      plan = null;
    }
  }

  if (!plan) {
    // Greedy: Legacy-Algorithmus (auch als Fallback wenn MILP fehlschlaegt)
    const singleBlockPlan = pickBestAutomationPlan({
      slots: freeSlots,
      chainOptions: chainVariants,
      slotDurationMs: SLOT_DURATION_MS
    });

    const multiBlockPlan = pickMultiBlockPlan({
      slots: freeSlots,
      stages: Array.isArray(automationConfig?.stages) ? automationConfig.stages : [],
      maxDischargeW: automationConfig?.maxDischargeW,
      availableKwh: availableEnergyKwh,
      slotDurationMs: SLOT_DURATION_MS,
      slotDurationH: SLOT_DURATION_HOURS
    });

    plan = (multiBlockPlan.totalRevenueCt > singleBlockPlan.totalRevenueCt)
      ? multiBlockPlan
      : singleBlockPlan;
    plan.engine = 'greedy';
  }

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
      activeDate: berlinDateString(new Date(now), cfg.epex.timezone),
      slotTs: slot.ts,
      slotEndTs: slot.ts + SLOT_DURATION_MS,
      source: SMALL_MARKET_AUTOMATION_SOURCE,
      autoManaged: true,
      displayTone: SMALL_MARKET_AUTOMATION_DISPLAY_TONE
    };
  }).filter(Boolean);
}

async function regenerateSmallMarketAutomationRules({ now = Date.now() } = {}) {
  const automationConfig = cfg.schedule?.smallMarketAutomation;
  const runDate = berlinDateString(new Date(now), cfg.epex.timezone);
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

  // --- Plan lock: never re-plan while a slot is actively executing ---
  // Once a plan is committed, it must run to completion. Re-planning during
  // discharge causes the optimizer to see reduced SoC, compute fewer slots,
  // and abort the running feed-in mid-slot.
  const planIsExecuting = previousAutomationRules.some((rule) => {
    const slotTs = Number(rule?.slotTs);
    const slotEndTs = Number(rule?.slotEndTs);
    if (!Number.isFinite(slotTs) || !Number.isFinite(slotEndTs)) return false;
    return now >= slotTs && now < slotEndTs;
  });

  // Also lock the plan if we're between scheduled slots (gap < 30 min)
  // to prevent re-planning during cooldown phases between discharge bursts.
  const planHasFutureSlots = previousAutomationRules.some((rule) => {
    const slotTs = Number(rule?.slotTs);
    return Number.isFinite(slotTs) && slotTs > now;
  });
  const planIsLocked = planIsExecuting || (planHasFutureSlots && previousAutomationRules.some((rule) => {
    const slotEndTs = Number(rule?.slotEndTs);
    return Number.isFinite(slotEndTs) && now >= slotEndTs && (now - slotEndTs) < 30 * 60 * 1000;
  }));

  // Regenerate when SOC changed significantly (>5%) — energy budget may have shifted
  // BUT only when the plan is NOT currently executing or locked.
  const socChanged = !planIsLocked
    && automationConfig?.batteryCapacityKwh > 0
    && currentSocPct != null
    && lastState?.lastSocPct != null
    && Math.abs(currentSocPct - lastState.lastSocPct) >= 5;
  // Only treat "no automation rules" as needing regeneration if we haven't
  // already planned today.  When the outcome is 'no_slots', an empty rule
  // list is expected and does NOT mean we need to re-plan every 15 seconds.
  const neverPlannedToday = !lastState?.lastRunDate || lastState.lastRunDate !== runDate;
  const missingRules = !previousAutomationRules.length && lastState?.lastOutcome !== 'no_slots';
  const needsRegeneration = neverPlannedToday
    || missingRules
    || priceDataChanged
    || socChanged;

  // Even if regeneration is needed, skip it while a plan is actively running
  if (planIsLocked && needsRegeneration && !priceDataChanged) {
    // Plan is locked — defer regeneration until current execution completes
    return;
  }

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

  const generatedRules = await buildSmallMarketAutomationRules(planInput);

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

  // Only log when the plan actually changed (different slots or slot count)
  const prevSlots = lastState?.selectedSlotTimestamps || [];
  const planChanged = selectedSlotTimestamps.length !== prevSlots.length
    || selectedSlotTimestamps.some((ts, i) => ts !== prevSlots[i]);
  if (planChanged) {
    pushLog('sma_plan_applied', {
      slots: planSummary.futureSlots,
      energyKwh: availableEnergyKwh,
      estimatedRevenueEur: Math.round(planSummary.estimatedRevenueCt) / 100
    });
  }
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
    costs: costSummary(),
    userEnergyPricing: userEnergyPricingSummary(),
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
    // Atomic write: temp file + rename prevents corruption on crash/power loss
    const tmpPath = ENERGY_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data) + '\n', 'utf8');
    fs.renameSync(tmpPath, ENERGY_PATH);
  } catch (e) {
    // silent - avoid recursive log if pushLog triggers persist
  }
}

function loadEnergy() {
  try {
    if (!fs.existsSync(ENERGY_PATH)) return;
    const data = JSON.parse(fs.readFileSync(ENERGY_PATH, 'utf8'));
    const today = berlinDateString(new Date(), cfg.epex.timezone);
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

function pushLog(event, details = {}) {
  const row = { ts: nowIso(), event, ...details };
  state.log.push(row);
  if (state.log.length > 1000) state.log.shift();
}

function validateScheduleRule(rule) {
  if (typeof rule !== 'object' || rule === null) return false;
  if (typeof rule.target !== 'string') return false;
  if (rule.value !== undefined && !Number.isFinite(Number(rule.value))) return false;
  return true;
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
  applyDvVictronControl(false);
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
  const day = berlinDateString(new Date(nowMs), cfg.epex.timezone);
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

  const dir = gridDirection(totalW, cfg.gridPositiveMeans);
  const pAbs = Math.abs(Number(totalW) || 0);
  const importW = dir.mode === 'grid_import' ? pAbs : 0;
  const exportW = dir.mode === 'feed_in' ? pAbs : 0;
  state.energy.importWh += importW * dtH;
  state.energy.exportWh += exportW * dtH;

  const currentEpex = epex.epexNowNext()?.current;
  const epexCtKwh = Number(currentEpex?.ct_kwh ?? 0);

  // Import cost: use the user's configured electricity price (Bezugspreis),
  // not the raw EPEX price. resolveImportPriceCtKwhForSlot handles fixed,
  // dynamic, and Paragraph 14a Module 3 pricing modes.
  const importSlot = { ts: nowMs, ct_kwh: epexCtKwh };
  const importCtKwh = resolveImportPriceCtKwhForSlot(importSlot, cfg.userEnergyPricing || {}, cfg.schedule?.timezone) ?? epexCtKwh;
  state.energy.costEur += (importW / 1000) * dtH * (importCtKwh / 100);

  // Export revenue: EPEX price is the actual feed-in compensation
  state.energy.revenueEur += (exportW / 1000) * dtH * (epexCtKwh / 100);
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

    state.dvRegs[0] = u16(total);
    state.dvRegs[1] = total < 0 ? 0xffff : 0x0000;
    state.dvRegs[3] = 0;
    state.dvRegs[4] = 0;

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
  state.victron.pvAcW = Number(pvAc.toFixed(3));
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

  publishRuntimeSnapshot();
}

function userEnergyPricingSummary() {
  const pricing = cfg.userEnergyPricing || {};
  const costs = pricing.costs || {};
  const slots = Array.isArray(state.epex.data) ? state.epex.data.map((row) => slotComparison(row, pricing, cfg.schedule?.timezone)) : [];
  const currentTs = epex.epexNowNext()?.current?.ts;
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
  const mod = localMinutesOfDay(new Date(now), cfg.schedule.timezone);

  const hit = state.schedule.rules.find((r) => {
    if (r.target !== target || !scheduleMatch(r, mod)) return false;
    // SMA rules carry absolute slot timestamps — enforce them so a rule
    // generated for "tomorrow 03:00" does not accidentally fire today at 03:00.
    if (isSmallMarketAutomationRule(r) && r.slotTs != null) {
      const slotTs = Number(r.slotTs);
      const slotEndTs = Number(r.slotEndTs) || (slotTs + SLOT_DURATION_MS);
      if (Number.isFinite(slotTs) && (now < slotTs || now >= slotEndTs)) return false;
    }
    return true;
  });
  if (hit) { hit._wasActive = true; delete state.schedule.manualOverride[target]; return { value: Number(hit.value), source: `rule:${hit.id || 'unnamed'}`, rule: hit }; }

  const mo = state.schedule.manualOverride[target];
  if (mo && (Date.now() - mo.at) < (cfg.schedule.manualOverrideTtlMs || 300000)) {
    return { value: Number(mo.value), source: 'manual_override', rule: null };
  }
  delete state.schedule.manualOverride[target];

  if (target === 'gridSetpointW' && state.schedule.config.defaultGridSetpointW != null) return { value: Number(state.schedule.config.defaultGridSetpointW), source: 'default', rule: null };
  if (target === 'chargeCurrentA' && state.schedule.config.defaultChargeCurrentA != null) return { value: Number(state.schedule.config.defaultChargeCurrentA), source: 'default', rule: null };
  if (target === 'feedExcessDcPv') return { value: Number(state.schedule.config.defaultFeedExcessDcPv ?? 1), source: 'default', rule: null };
  return { value: null, source: 'none', rule: null };
}

async function applyControlTarget(target, value, source) {
  const conf = cfg.controlWrite[target] || cfg.dvControl?.[target];
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
  const nowMin = localMinutesOfDay(new Date(now), cfg.schedule.timezone);
  await regenerateSmallMarketAutomationRules({ now });
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
  const priceNow = epex.epexNowNext()?.current;
  const priceNegative = npp?.enabled && priceNow && Number(priceNow.ct_kwh) < 0;

  // --- DC Export Mode: dynamischer Grid Setpoint = -(DC-PV - Puffer) ---
  // Nur fuer DC-gekoppelte PV (MPPT auf DC-Seite). Setzt den Grid Setpoint
  // so, dass der Multi die gesamte DC-PV-Produktion einspeist.
  // Netto-Batteriestrom bleibt bei ca. 0A.
  //
  // dcExportMode: NUR aktiv wenn eine Schedule-Regel target='dcExportMode', value=1 matcht.
  // Config-Flags (enabled, priceThresholdCtKwh) werden nur als Parameter genutzt,
  // nicht zur Aktivierung. Ohne aktive Schedule-Regel bleibt dcExportMode AUS.
  const dcScheduleRule = state.schedule.rules.find(r => r.target === 'dcExportMode' && r.enabled !== false && scheduleMatch(r, nowMin));
  let dcExportActive = dcScheduleRule != null && Number(dcScheduleRule.value) === 1;
  // SOC-Sicherung: Wenn Akku unter Ziel-SOC UND weniger als X Stunden bis Abend-Peak,
  // DC-Export deaktivieren damit der Akku noch laden kann.
  const dcTargetSoc = Number(cfg.dcExportMode?.targetSocPct ?? 90);
  const dcDeadlineHour = Number(cfg.dcExportMode?.chargeDeadlineHour ?? 17);
  const currentSoc = Number(state.victron.soc ?? 0);
  const currentHour = new Date(now).getHours();
  if (dcExportActive && currentSoc < dcTargetSoc && currentHour >= (dcDeadlineHour - 2)) {
    // Weniger als 2 Stunden bis Deadline und SOC noch nicht erreicht -> laden lassen
    dcExportActive = false;
    if (!state.ctrl._dcSocGuardLogged) {
      pushLog('dc_export_soc_guard', { currentSoc, dcTargetSoc, dcDeadlineHour, currentHour });
      state.ctrl._dcSocGuardLogged = true;
    }
  } else {
    state.ctrl._dcSocGuardLogged = false;
  }
  if (dcExportActive) {
    // Negativpreis-Schutz: bei Preis < 0 ct/kWh Export pausieren (0 ct/kWh = weiter exportieren)
    const currentPrice = priceNow ? Number(priceNow.ct_kwh) : null;
    const priceBlocked = currentPrice !== null && currentPrice < 0;

    if (priceBlocked) {
      // Export pausiert wegen negativem Preis — kein Setpoint schreiben
      if (!state.ctrl._dcExportPriceBlockLogged) {
        pushLog('pv_export_price_blocked', { currentPrice });
        state.ctrl._dcExportPriceBlockLogged = true;
      }
    } else {
      state.ctrl._dcExportPriceBlockLogged = false;
      const pvW = Math.max(0, Number(state.victron.pvTotalW || state.victron.pvPowerW || 0));
      const bufferW = Number(cfg.dcExportMode?.bufferW ?? 100);
      if (pvW > 50) {
        // Negativer Setpoint = Einspeisung. Export = Gesamt-PV minus Puffer.
        const exportW = Math.round(-(pvW - bufferW));
        const prev = state.schedule.active.gridSetpointW;
        const prevVal = prev?.value;
        // Nur schreiben wenn sich der Wert merklich aendert (>50W Differenz) oder alle 60s
        const timeSinceLastWrite = now - (state.ctrl._dcExportLastWriteAt || 0);
        if (prevVal == null || Math.abs(exportW - prevVal) > 50 || timeSinceLastWrite > 60000) {
          await applyControlTarget('gridSetpointW', exportW, 'dc_export_mode');
          state.ctrl._dcExportLastWriteAt = now;
          if (!state.ctrl._dcExportLogged) {
            pushLog('dc_export_mode_active', { pvW, exportW, bufferW, currentPrice });
            state.ctrl._dcExportLogged = true;
          }
        }
      } else {
        // Kein PV: Zurueck zum Default Setpoint
        if (state.ctrl._dcExportLogged) {
          pushLog('dc_export_mode_idle', { pvW });
          state.ctrl._dcExportLogged = false;
        }
      }
    }
  } else if (state.ctrl._dcExportLogged) {
    pushLog('dc_export_mode_off', {});
    state.ctrl._dcExportLogged = false;
  }

  for (const target of ['gridSetpointW', 'chargeCurrentA']) {
    const eff = effectiveTargetValue(target);
    if (eff.value == null) continue;

    // Bei negativen Preisen: DC/AC Einspeisung blockieren + Grid Setpoint begrenzen
    if (target === 'gridSetpointW' && priceNegative) {
      const limit = Number(npp.gridSetpointW ?? -40);
      const prev = state.ctrl.negativePriceActive;
      if (!prev) {
        pushLog('negative_price_protection_on', { price: priceNow.ct_kwh, limit });
        telemetrySafeWrite(() => telemetryStore.writeControlEvent({
          eventType: 'negative_price_protection_on',
          target: 'dv_control',
          valueNum: priceNow.ct_kwh,
          reason: 'negative_price',
          source: 'runtime',
          meta: { price: priceNow.ct_kwh, limit }
        }));
      }
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

    // Skip gridSetpointW if export mode is actively controlling it
    if (target === 'gridSetpointW' && dcExportActive && Math.max(0, Number(state.victron.pvTotalW || state.victron.pvPowerW || 0)) > 50) {
      continue;
    }
    await applyControlTarget(target, eff.value, eff.source);
  }

  // feedExcessDcPv: schedule-gesteuerte DC-Einspeisung (+ dontFeedExcessAcPv invers)
  if (cfg.dvControl?.enabled) {
    let dcFeedIn = false;
    let dcSource = 'default_off';
    // DV forcedOff und negative Preise blockieren DC-Einspeisung immer
    if (state.ctrl.forcedOff) {
      dcSource = 'dv_forced_off';
    } else if (priceNegative) {
      dcSource = 'negative_price_protection';
    } else {
      const eff = effectiveTargetValue('feedExcessDcPv');
      dcFeedIn = eff.value != null && Number(eff.value) === 1;
      dcSource = eff.source;
    }
    await applyDvVictronControl(dcFeedIn);
    state.schedule.active.feedExcessDcPv = { value: dcFeedIn ? 1 : 0, source: dcSource, at: Date.now() };
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
    telemetrySafeWrite(() => telemetryStore.writeControlEvent({
      eventType: 'negative_price_protection_off',
      target: 'dv_control',
      valueNum: priceNow?.ct_kwh,
      reason: 'price_positive',
      source: 'runtime',
      meta: { price: priceNow?.ct_kwh }
    }));
    // feedExcessDcPv: wird oben im feedExcessDcPv-Block schedule-basiert gesetzt
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
    priceNowCtKwh: Number(epex.epexNowNext()?.current?.ct_kwh ?? 0),
    userImportPriceNowCtKwh: Number(userEnergyPricingSummary()?.current?.importPriceCtKwh ?? 0)
  };
}

function integrationState() {
  return {
    timestamp: Date.now(),
    dvControlValue: controlValue(),
    forcedOff: state.ctrl.forcedOff,
    gridTotalW: state.meter.grid_total_w,
    gridDirection: gridDirection(state.meter.grid_total_w, cfg.gridPositiveMeans).mode,
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

function isLocalNetworkRequest(req) {
  const raw = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const addr = raw.replace(/^::ffff:/, '');
  // Localhost
  if (addr === '127.0.0.1' || addr === '::1') return true;
  // Private/LAN ranges (RFC 1918)
  const parts = addr.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 10) return true;                                    // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;               // 192.168.0.0/16
  }
  // IPv6 link-local
  if (addr.startsWith('fe80:')) return true;
  return false;
}

// Sensitive endpoints that always require token auth, even from LAN
const SENSITIVE_ENDPOINTS = new Set([
  '/api/admin/update/check', '/api/admin/update/apply', '/api/admin/restart',
  '/api/admin/health', '/api/config', '/api/config/import',
  '/api/control/write', '/api/integration/eos/apply', '/api/integration/emhass/apply'
]);

function isSensitiveRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (SENSITIVE_ENDPOINTS.has(url.pathname)) return req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
  if (url.pathname === '/api/config' && req.method === 'POST') return true;
  if (url.pathname.startsWith('/api/admin/')) return true;
  return false;
}

// --- Rate Limiting (in-memory, per IP) ---
const rateLimitBuckets = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120; // 120 req/min per IP (2/s avg)
const RATE_LIMIT_ADMIN_MAX = 10;     // stricter for admin/mutation endpoints

function getRateLimitKey(req) {
  const raw = req.socket?.remoteAddress || '';
  return raw.replace(/^::ffff:/, '');
}

function checkRateLimit(req, res) {
  const ip = getRateLimitKey(req);
  const now = Date.now();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isAdmin = url.pathname.startsWith('/api/admin/');
  const limit = isAdmin ? RATE_LIMIT_ADMIN_MAX : RATE_LIMIT_MAX_REQUESTS;

  let bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateLimitBuckets.set(ip, bucket);
  }
  bucket.count++;

  if (bucket.count > limit) {
    res.writeHead(429, { ...SECURITY_HEADERS, 'Retry-After': '60', 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return false;
  }
  return true;
}

// Clean up stale buckets every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [ip, bucket] of rateLimitBuckets) {
    if (bucket.windowStart < cutoff) rateLimitBuckets.delete(ip);
  }
}, 300_000).unref();

function checkAuth(req, res) {
  if (!cfg.apiToken) return true;
  // LAN requests bypass token check for read-only/non-sensitive endpoints
  if (isLocalNetworkRequest(req) && !isSensitiveRequest(req)) return true;
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
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://dvhub.de https://*.tile.openstreetmap.org; connect-src 'self' https://api.dvhub.de"
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

const REDACTED_PATHS = ['apiToken', 'telemetry.historyImport.vrmToken', 'telemetry.database.password'];

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

  // CORS: restrict cross-origin API access to same origin only
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

  if (url.pathname === '/' && req.method === 'GET') {
    return servePage(res, loadedConfig.needsSetup ? 'setup.html' : 'index.html');
  }

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dv/')) {
    if (!checkRateLimit(req, res)) return;
    if (!checkAuth(req, res)) return;
  }

  if (url.pathname === '/dv/control-value' && req.method === 'GET') return text(res, 200, controlValue());

  if (url.pathname === '/api/keepalive/modbus' && req.method === 'GET') return json(res, 200, keepaliveModbusPayload());
  if (url.pathname === '/api/keepalive/pulse' && req.method === 'GET') return json(res, 200, keepalivePulsePayload());
  if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, configApiPayload());

  if ((url.pathname === '/api/config' || url.pathname === '/api/config/import') && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
      return json(res, 400, { ok: false, error: 'config object required' });
    }
    const result = saveAndApplyConfig(restoreRedactedValues(body.config, rawCfg));
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

  // --- Software Update ---
  if (url.pathname === '/api/admin/update/check' && req.method === 'GET') {
    if (!SERVICE_ACTIONS_ENABLED) return json(res, 403, { ok: false, error: 'service actions disabled' });
    try {
      const repoRoot = path.resolve(__dirname, '..');
      const channel = rawCfg.updateChannel || 'stable';
      await execFileAsync('git', ['fetch', '--tags', '--quiet', 'origin'], { cwd: repoRoot, timeout: 15000 });
      const localRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();

      if (channel === 'stable') {
        // Tag-based update check
        let currentTag = null;
        try {
          currentTag = (await execFileAsync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
        } catch { /* not on a tag */ }
        let latestTag = null;
        try {
          latestTag = (await execFileAsync('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout.trim().split('\n')[0] || null;
        } catch { /* no tags */ }
        let changelog = '';
        if (currentTag && latestTag && currentTag !== latestTag) {
          try { changelog = (await execFileAsync('git', ['log', '--oneline', `${currentTag}..${latestTag}`], { cwd: repoRoot, timeout: 5000 })).stdout.trim(); } catch { /* */ }
        } else if (!currentTag && latestTag) {
          try { changelog = (await execFileAsync('git', ['log', '--oneline', `HEAD..${latestTag}`], { cwd: repoRoot, timeout: 5000 })).stdout.trim(); } catch { /* */ }
        }
        const updateAvailable = latestTag != null && latestTag !== currentTag;
        return json(res, 200, {
          ok: true, channel,
          current: { version: APP_VERSION.versionLabel, tag: currentTag, revision: localRev.slice(0, 7) },
          latest: { tag: latestTag, revision: null },
          updateAvailable,
          changelog: changelog ? changelog.split('\n').filter(Boolean) : []
        });
      } else {
        // Dev: commit-based update check (original logic)
        const remoteRev = (await execFileAsync('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
        const behind = Number((await execFileAsync('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim());
        const ahead = Number((await execFileAsync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim());
        let changelog = '';
        if (behind > 0) {
          changelog = (await execFileAsync('git', ['log', '--oneline', 'HEAD..origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
        }
        return json(res, 200, {
          ok: true, channel,
          current: { version: APP_VERSION.versionLabel, tag: null, revision: localRev.slice(0, 7) },
          latest: { tag: null, revision: remoteRev.slice(0, 7) },
          behind, ahead,
          updateAvailable: behind > 0,
          changelog: changelog ? changelog.split('\n').filter(Boolean) : []
        });
      }
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/admin/update/apply' && req.method === 'POST') {
    if (!SERVICE_ACTIONS_ENABLED) return json(res, 403, { ok: false, error: 'service actions disabled' });
    try {
      const repoRoot = path.resolve(__dirname, '..');
      const channel = rawCfg.updateChannel || 'stable';
      let gitOutput = '';

      // Save rollback point before any changes
      const rollbackRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();

      // Stash local modifications instead of discarding them
      const stashResult = await execFileAsync('git', ['stash', '--include-untracked'], { cwd: repoRoot, timeout: 10000 }).catch(() => ({ stdout: 'No local changes' }));
      const hasStash = !stashResult.stdout.includes('No local changes');

      if (channel === 'stable') {
        await execFileAsync('git', ['fetch', '--tags', 'origin'], { cwd: repoRoot, timeout: 15000 });
        const latestTag = (await execFileAsync('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout.trim().split('\n')[0];
        if (!latestTag) throw new Error('No release tags found');
        const checkout = await execFileAsync('git', ['checkout', latestTag], { cwd: repoRoot, timeout: 15000 });
        gitOutput = `Checked out ${latestTag}: ${checkout.stderr.trim()}`;
      } else {
        await execFileAsync('git', ['fetch', 'origin'], { cwd: repoRoot, timeout: 15000 });
        await execFileAsync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoRoot, timeout: 15000 });
        const pull = await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: repoRoot, timeout: 30000 });
        gitOutput = pull.stdout.trim();
      }

      // npm install + smoke test with automatic rollback on failure
      try {
        const npmInstall = await execFileAsync('npm', ['install', '--omit=dev'], { cwd: __dirname, timeout: 60000 });
        await execFileAsync('node', ['--check', 'server.js'], { cwd: __dirname, timeout: 5000 });
        pushLog('update_applied', {
          channel,
          gitOutput: gitOutput.split('\n').slice(0, 5).join('\n'),
          npmOutput: npmInstall.stdout.trim().split('\n').slice(-3).join('\n')
        });
      } catch (installErr) {
        // Rollback: restore previous revision and dependencies
        pushLog('update_rollback', { reason: installErr.message, rollbackTo: rollbackRev.slice(0, 7) });
        await execFileAsync('git', ['checkout', rollbackRev], { cwd: repoRoot, timeout: 15000 });
        await execFileAsync('npm', ['install', '--omit=dev'], { cwd: __dirname, timeout: 60000 }).catch(() => {});
        if (hasStash) await execFileAsync('git', ['stash', 'pop'], { cwd: repoRoot, timeout: 10000 }).catch(() => {});
        throw new Error(`Update rolled back (npm/syntax failed): ${installErr.message}`);
      }

      if (hasStash) {
        pushLog('update_stash_discarded', { note: 'local changes were stashed before update and not restored' });
      }

      scheduleServiceRestart();
      pushLog('service_restart_scheduled', { service: SERVICE_NAME, reason: 'update' });
      return json(res, 200, {
        ok: true, channel,
        gitOutput,
        rolledBackFrom: rollbackRev.slice(0, 7),
        message: 'Update applied, service restart scheduled'
      });
    } catch (e) {
      pushLog('update_error', { error: e.message });
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/admin/update/channel' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const channel = body?.channel;
      if (channel !== 'stable' && channel !== 'dev') {
        return json(res, 400, { ok: false, error: 'channel must be "stable" or "dev"' });
      }

      // Always save channel preference to config (works even without service actions)
      const next = JSON.parse(JSON.stringify(rawCfg || {}));
      next.updateChannel = channel;
      saveAndApplyConfig(next);

      // If service actions are enabled, also switch git ref and restart
      if (SERVICE_ACTIONS_ENABLED) {
        const repoRoot = path.resolve(__dirname, '..');
        let gitOutput = '';

        // Save rollback point before any changes
        const rollbackRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();

        // Stash local modifications instead of discarding them
        const stashResult = await execFileAsync('git', ['stash', '--include-untracked'], { cwd: repoRoot, timeout: 10000 }).catch(() => ({ stdout: 'No local changes' }));
        const hasStash = !stashResult.stdout.includes('No local changes');

        await execFileAsync('git', ['fetch', '--tags', 'origin'], { cwd: repoRoot, timeout: 15000 });
        if (channel === 'stable') {
          const latestTag = (await execFileAsync('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout.trim().split('\n')[0];
          if (!latestTag) throw new Error('No release tags found');
          await execFileAsync('git', ['checkout', latestTag], { cwd: repoRoot, timeout: 15000 });
          gitOutput = `Switched to stable: ${latestTag}`;
        } else {
          await execFileAsync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoRoot, timeout: 15000 });
          gitOutput = 'Switched to dev: origin/main';
        }

        // npm install + smoke test with automatic rollback on failure
        try {
          await execFileAsync('npm', ['install', '--omit=dev'], { cwd: __dirname, timeout: 60000 });
          await execFileAsync('node', ['--check', 'server.js'], { cwd: __dirname, timeout: 5000 });
        } catch (installErr) {
          pushLog('channel_switch_rollback', { reason: installErr.message, rollbackTo: rollbackRev.slice(0, 7) });
          await execFileAsync('git', ['checkout', rollbackRev], { cwd: repoRoot, timeout: 15000 });
          await execFileAsync('npm', ['install', '--omit=dev'], { cwd: __dirname, timeout: 60000 }).catch(() => {});
          if (hasStash) await execFileAsync('git', ['stash', 'pop'], { cwd: repoRoot, timeout: 10000 }).catch(() => {});
          throw new Error(`Channel switch rolled back (npm/syntax failed): ${installErr.message}`);
        }

        if (hasStash) {
          pushLog('channel_switch_stash_discarded', { note: 'local changes were stashed before switch and not restored' });
        }

        pushLog('update_channel_changed', { channel, gitOutput });
        scheduleServiceRestart();
        pushLog('service_restart_scheduled', { service: SERVICE_NAME, reason: 'channel_switch' });
        return json(res, 200, {
          ok: true, channel, gitOutput,
          message: `Channel switched to ${channel}, service restart scheduled`
        });
      }

      // Without service actions: channel saved, next update check will use it
      pushLog('update_channel_changed', { channel, note: 'config-only, service actions disabled' });
      return json(res, 200, {
        ok: true, channel,
        message: `Channel preference saved to ${channel}. Git switch will happen on next update.`
      });
    } catch (e) {
      pushLog('update_channel_error', { error: e.message });
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // --- Telemetry Series Query API ---
  if (url.pathname === '/api/telemetry/series' && req.method === 'GET') {
    if (!telemetryStore?.querySeries) return json(res, 503, { ok: false, error: 'telemetry store not available' });
    const keys = (url.searchParams.get('keys') || 'battery_soc_pct').split(',').map(k => k.trim()).filter(Boolean);
    const now = new Date();
    const start = url.searchParams.get('start') || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = url.searchParams.get('end') || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const maxRes = Number(url.searchParams.get('maxResolution')) || 900;
    try {
      const rows = await telemetryStore.querySeries({ seriesKeys: keys, start, end, maxResolution: maxRes });
      return json(res, 200, { ok: true, keys, start, end, total: rows.length, data: rows });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // --- VRM Forecast API ---
  if (url.pathname === '/api/forecast' && req.method === 'GET') {
    if (!telemetryStore?.listForecasts) return json(res, 503, { ok: false, error: 'telemetry store not available' });
    const now = new Date();
    const startParam = url.searchParams.get('start');
    const endParam = url.searchParams.get('end');
    const start = startParam || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = endParam || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3).toISOString();
    const forecastType = url.searchParams.get('type') || null;
    try {
      const rows = await telemetryStore.listForecasts({ start, end, forecastType });
      return json(res, 200, {
        ok: true,
        start,
        end,
        solar: rows.filter(r => r.type === 'solar_yield').map(r => ({ ts: r.ts, w: r.valueW })),
        consumption: rows.filter(r => r.type === 'consumption').map(r => ({ ts: r.ts, w: r.valueW })),
        lastFetchAt: state.forecast?.lastFetchAt || null,
        total: rows.length
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/forecast/refresh' && req.method === 'POST') {
    epex.fetchVrmForecast().catch(e => pushLog('vrm_forecast_manual_error', { error: e.message }));
    return json(res, 202, { ok: true, message: 'Forecast refresh started' });
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

  // Persistent DV signal log from database
  if (url.pathname === '/api/log/dv-signals' && req.method === 'GET') {
    if (!telemetryStore?.listControlEvents) return json(res, 503, { ok: false, error: 'telemetry store not available' });
    const limit = Number(url.searchParams.get('limit')) || 200;
    const eventType = url.searchParams.get('type') || null;
    try {
      const rows = await telemetryStore.listControlEvents({ limit, eventType });
      return json(res, 200, { ok: true, rows, total: rows.length });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
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
    await epex.fetchEpexDay();
    return json(res, 200, { ok: state.epex.ok, error: state.epex.error });
  }

  if (url.pathname === '/api/epex/zones' && req.method === 'GET') {
    try {
      const baseUrl = cfg.epex.priceApiUrl || 'https://api.dvhub.de';
      const r = await fetch(`${baseUrl}/api/zones`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      return json(res, 200, data);
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (url.pathname === '/api/epex/gaps' && req.method === 'GET') {
    try {
      const baseUrl = cfg.epex.priceApiUrl || 'https://api.dvhub.de';
      const zone = url.searchParams.get('zone') || cfg.epex.bzn || 'DE-LU';
      const r = await fetch(`${baseUrl}/api/prices/gaps?zone=${encodeURIComponent(zone)}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      return json(res, 200, data);
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (url.pathname === '/api/epex/backfill' && req.method === 'POST') {
    try {
      const baseUrl = cfg.epex.priceApiUrl || 'https://api.dvhub.de';
      const body = await parseBody(req);
      const zone = body?.zone || cfg.epex.bzn || 'DE-LU';
      const start = body?.start || '2020-01-01';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || isNaN(Date.parse(start))) {
        return json(res, 400, { error: 'Invalid start date, expected YYYY-MM-DD' });
      }
      if (!/^[A-Z]{2}(-[A-Z]{2,4})?$/.test(zone)) {
        return json(res, 400, { error: 'Invalid zone format' });
      }
      const r = await fetch(`${baseUrl}/api/backfill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone, start }),
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      return json(res, 200, data);
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
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
    const validRules = body.rules.filter(validateScheduleRule);
    if (validRules.length !== body.rules.length) return json(res, 400, { ok: false, error: 'invalid rule structure' });
    // Preserve automation-managed and feedExcessDcPv rules — dashboard save only replaces grid/charge rules
    const incomingManualRules = validRules.filter((r) => !isSmallMarketAutomationRule(r));
    const existingAutomationRules = state.schedule.rules.filter((r) => isSmallMarketAutomationRule(r));
    const existingDcFeedRules = state.schedule.rules.filter((r) => r.target === 'feedExcessDcPv' && !isSmallMarketAutomationRule(r));
    const incomingDcFeedRules = incomingManualRules.filter((r) => r.target === 'feedExcessDcPv');
    const incomingOtherRules = incomingManualRules.filter((r) => r.target !== 'feedExcessDcPv');
    // If no feedExcessDcPv rules are sent, preserve existing ones (dashboard doesn't manage them)
    const dcFeedRules = incomingDcFeedRules.length ? incomingDcFeedRules : existingDcFeedRules;
    state.schedule.rules = [...incomingOtherRules, ...dcFeedRules, ...existingAutomationRules];
    pushLog('schedule_rules_updated', { manual: incomingOtherRules.length, dcFeed: dcFeedRules.length, automation: existingAutomationRules.length });
    persistConfig();
    return json(res, 200, { ok: true, count: state.schedule.rules.length });
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
    if (body.defaultFeedExcessDcPv !== undefined) {
      const v = Number(body.defaultFeedExcessDcPv);
      if (v !== 0 && v !== 1) return json(res, 400, { ok: false, error: 'defaultFeedExcessDcPv must be 0 or 1' });
      state.schedule.config.defaultFeedExcessDcPv = v;
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(res, 400, { ok: false, error: 'invalid body' });
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

    // Merge automation config into raw config and persist
    const current = JSON.parse(JSON.stringify(rawCfg || {}));
    current.schedule = current.schedule || {};
    current.schedule.smallMarketAutomation = {
      ...current.schedule.smallMarketAutomation,
      ...filteredBody
    };
    saveAndApplyConfig(current);
    regenerateSmallMarketAutomationRules().catch(e => pushLog('sma_regen_error', { error: e.message }));

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

(async () => {
  telemetryStore = await createTelemetryStoreIfEnabled();
  ctx.telemetryStore = telemetryStore;
  ctx.publishRuntimeSnapshot = publishRuntimeSnapshot;
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
  loadEnergy();
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
  epex.start();
  setInterval(persistEnergy, 60000);
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
  persistEnergy();
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
  persistEnergy();
  liveTelemetryBuffer?.flush({ force: true });
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  try { persistEnergy(); } catch {}
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
