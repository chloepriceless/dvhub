// services/optimizer/index.js -- Optimizer service factory per D-01.
// Wires all optimizer components: battery model, confidence gating, forecast normalizer,
// heuristic/MILP optimizer, EOS adapter, schedule builder.
// Hot-reload safe: start() does NOT exit if !enabled -- service stays running, gates per run.
// Event-triggered: polls forecastVersion for change detection + 30min fallback timer.

import { detectRamTier } from '../forecast/ram-tier.js';
import { applyConfidenceGating } from './confidence-gate.js';
import { normalizeForecast, averageSlotConfidence } from './forecast-normalizer.js';
import { buildHeuristicSchedule } from './heuristic-optimizer.js';
import { buildMilpSchedule } from './milp-battery-optimizer.js';
import { buildScheduleRules, insertOptimizerRules } from './schedule-builder.js';
import { createEosAdapter } from './eos-adapter.js';

/**
 * Estimate net grid cost over the horizon for a given schedule.
 * Used by 'best' primarySource selector to compare internal vs EOS schedule.
 * Lower cost = better schedule (addresses review issue #9: NOT abs(powerW * price)).
 *
 * @param {Array<{ts: number, endTs: number, powerW: number}>} schedule - Optimizer output slots
 * @param {Array<{ts: number, endTs: number, ctKwh: number}>} priceSlots - Normalized price slots
 * @param {Array<{ts: number, endTs: number, powerW: number}>} pvSlots - Normalized PV slots
 * @param {Array<{ts: number, endTs: number, powerW: number}>} loadSlots - Normalized load slots
 * @returns {number} Estimated total cost in ct over the horizon
 */
export function estimateNetCost(schedule, priceSlots, pvSlots, loadSlots) {
  let totalCostCt = 0;
  const FEED_IN_FACTOR = 0.8; // Feed-in tariff is ~80% of spot price (conservative)

  for (const slot of schedule) {
    const dtHours = (slot.endTs - slot.ts) / 3_600_000;
    if (dtHours <= 0) continue;

    // Find matching price slot
    const price = priceSlots.find(p => p.ts <= slot.ts && p.endTs > slot.ts);
    if (!price) continue;

    // Find matching PV and load slots
    const pv = pvSlots.find(p => p.ts <= slot.ts && p.endTs > slot.ts);
    const load = loadSlots.find(l => l.ts <= slot.ts && l.endTs > slot.ts);
    const pvW = pv ? pv.powerW : 0;
    const loadW = load ? load.powerW : 0;

    if (slot.powerW > 0) {
      // Charging: grid imports more
      const gridImportW = Math.max(0, loadW - pvW + slot.powerW);
      totalCostCt += gridImportW * price.ctKwh * dtHours / 1000;
    } else {
      // Discharging: battery offsets load or exports surplus
      const dischW = Math.abs(slot.powerW);
      const netLoad = loadW - pvW - dischW;
      if (netLoad > 0) {
        // Still importing from grid but less
        totalCostCt += netLoad * price.ctKwh * dtHours / 1000;
      } else {
        // Exporting surplus
        const exportW = Math.abs(netLoad);
        totalCostCt -= exportW * price.ctKwh * FEED_IN_FACTOR * dtHours / 1000;
      }
    }
  }

  return totalCostCt;
}

/**
 * DV sell-vs-self-consume logic per D-16/D-17 (OPTI-05).
 * Looks at next 4 hours of PV vs load forecast. If PV surplus expected,
 * produces self-consume rules (grid setpoint 0). If deficit, no extra rules needed.
 *
 * @param {object} normalized - Normalized forecast from normalizeForecast()
 * @param {object} state - Application state
 * @param {function} getCfg - Config getter
 * @returns {Array<{ts: number, endTs: number, powerW: number, confidence: number}>}
 */
export function applyDvForecastLogic(normalized, state, getCfg) {
  if (!normalized?.pv?.slots?.length || !normalized?.load?.slots?.length) {
    return [];
  }

  const now = Date.now();
  const horizon = 4 * 3_600_000; // 4 hours ahead

  // Filter PV and load slots for the next 4 hours
  const pvNext4h = normalized.pv.slots.filter(s => s.ts >= now && s.ts < now + horizon);
  const loadNext4h = normalized.load.slots.filter(s => s.ts >= now && s.ts < now + horizon);

  if (pvNext4h.length === 0) return [];

  // Sum PV and load energy over next 4h
  let pvSumWh = 0;
  for (const s of pvNext4h) {
    const dtH = (s.endTs - s.ts) / 3_600_000;
    pvSumWh += s.powerW * dtH;
  }

  let loadSumWh = 0;
  for (const s of loadNext4h) {
    const dtH = (s.endTs - s.ts) / 3_600_000;
    loadSumWh += s.powerW * dtH;
  }

  // If PV surplus expected: self-consume (set grid setpoint to 0 -- charge from PV, no export)
  if (pvSumWh > loadSumWh) {
    const rules = [];
    for (const slot of pvNext4h) {
      // Only create rules for slots where PV exceeds load
      const loadSlot = loadNext4h.find(l => l.ts <= slot.ts && l.endTs > slot.ts);
      const loadW = loadSlot ? loadSlot.powerW : 0;
      if (slot.powerW > loadW) {
        rules.push({
          ts: slot.ts,
          endTs: slot.endTs,
          powerW: 0, // Grid setpoint 0 = self-consume
          confidence: slot.confidence
        });
      }
    }
    return rules;
  }

  // PV deficit: no additional rules needed, current surplus can be sold
  return [];
}

/**
 * Create the optimizer service. Factory pattern per D-01.
 * Hot-reload safe: start() always starts timers, runOptimization() gates on enabled.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog, forecastService }
 * @returns {{ start: Function, close: Function, getSchedule: Function, getStatus: Function }}
 */
export function createOptimizerService(ctx) {
  const { state, getCfg, pushLog } = ctx;

  // Detect hardware tier
  const { tier } = detectRamTier();

  // Initialize optimizer state
  state.optimizer = {
    tier,
    enabled: false,
    lastRunAt: null,
    lastSchedule: null,
    lastEosSchedule: null,
    source: null,
    rulesCount: 0,
    error: null,
    runCount: 0,
    lastForecastVersion: -1
  };

  // EOS adapter (created once, used when enabled)
  const eosAdapter = createEosAdapter(ctx);

  // Run mutex and generation guard
  let runGeneration = 0;
  let isRunning = false;

  /**
   * Core optimization run. Gates on optimizer.enabled per run (NOT in start()).
   * Uses forecastVersion for change detection and generation guard for supersession.
   */
  async function runOptimization() {
    if (isRunning) return; // Skip if already running

    const cfg = getCfg();
    if (!cfg.optimizer?.enabled) return; // Gate per run, NOT in start()

    isRunning = true;
    const thisGeneration = ++runGeneration;

    try {
      // 1. Get forecast via forecastService
      const forecastResponse = ctx.forecastService.buildForecastResponse();

      // 2. Normalize forecast (ISO -> epoch-ms)
      const normalized = normalizeForecast(forecastResponse);
      const priceSlots = normalized.price.slots;
      const pvSlots = normalized.pv.slots;
      const loadSlots = normalized.load.slots;

      if (priceSlots.length === 0) {
        state.optimizer.error = 'No price data available';
        return;
      }

      // 3. Per-slot confidence average (NOT state.forecast.pv.confidence -- issue #7)
      const confidence = averageSlotConfidence([...pvSlots, ...priceSlots]);

      // 4. Battery params from config + confidence gating
      const batteryParams = {
        minSocPct: cfg.optimizer.minSocPct ?? 10,
        maxSocPct: cfg.optimizer.maxSocPct ?? 100,
        maxChargeW: cfg.optimizer.maxChargeW ?? 3000,
        maxDischargeW: cfg.optimizer.maxDischargeW ?? 3000
      };
      const gate = applyConfidenceGating(batteryParams, confidence);

      // 5. Battery model params
      const batteryModel = {
        capacityWh: cfg.optimizer.batteryCapacityWh ?? 10000,
        maxSocPct: batteryParams.maxSocPct,
        maxChargeW: batteryParams.maxChargeW,
        maxDischargeW: batteryParams.maxDischargeW,
        currentSocPct: state.victron?.soc ?? 50 // D-06: anchor to reality
      };

      // 6. Grid permission flags from config
      const allowGridCharge = cfg.optimizer.allowGridCharge ?? false;
      const allowGridDischarge = cfg.optimizer.allowGridDischarge ?? false;

      // 7. Choose optimizer based on tier and strategy
      const strategy = cfg.optimizer.strategy ?? 'auto';
      let internalSchedule;

      if (strategy === 'heuristic' || (strategy === 'auto' && tier === 1)) {
        internalSchedule = buildHeuristicSchedule({
          priceSlots, pvSlots, loadSlots,
          batteryModel, confidenceGate: gate,
          allowGridCharge, allowGridDischarge
        });
      } else {
        // Tier 2+: try MILP, fall back to heuristic
        internalSchedule = await buildMilpSchedule({
          priceSlots, pvSlots, loadSlots,
          batteryModel, confidenceGate: gate,
          allowGridCharge, allowGridDischarge
        });
        if (internalSchedule === null) {
          // MILP unavailable (Tier 1 or HiGHS missing), fall back
          internalSchedule = buildHeuristicSchedule({
            priceSlots, pvSlots, loadSlots,
            batteryModel, confidenceGate: gate,
            allowGridCharge, allowGridDischarge
          });
        }
      }

      // 7. EOS adapter (when enabled on Tier 2+)
      let eosSchedule = null;
      if (cfg.optimizer.eosProxy?.enabled && tier >= 2) {
        try {
          const forecastResp = ctx.forecastService.buildForecastResponse();
          await eosAdapter.pushForecast(forecastResp);
          eosSchedule = await eosAdapter.pullSchedule();
        } catch (err) {
          pushLog('optimizer_eos_error', { error: err.message });
        }
      }

      // 8. Check generation guard before applying results
      if (thisGeneration !== runGeneration) return;

      // 9. Resolve primarySource (per D-15)
      const primarySource = cfg.optimizer.primarySource ?? 'internal';
      let winningSchedule;
      let source;

      if (primarySource === 'internal') {
        winningSchedule = internalSchedule;
        source = 'internal';
      } else if (primarySource === 'eos') {
        if (eosSchedule && eosSchedule.length > 0) {
          winningSchedule = eosSchedule;
          source = 'eos';
        } else {
          winningSchedule = internalSchedule;
          source = 'internal'; // fallback
        }
      } else if (primarySource === 'best') {
        // Estimate net-cost delta over horizon for each schedule
        if (eosSchedule && eosSchedule.length > 0) {
          const internalCost = estimateNetCost(internalSchedule, priceSlots, pvSlots, loadSlots);
          const eosCost = estimateNetCost(eosSchedule, priceSlots, pvSlots, loadSlots);
          if (eosCost < internalCost) {
            winningSchedule = eosSchedule;
            source = 'eos';
          } else {
            winningSchedule = internalSchedule;
            source = 'internal';
          }
        } else {
          winningSchedule = internalSchedule;
          source = 'internal';
        }
      } else {
        winningSchedule = internalSchedule;
        source = 'internal';
      }

      // 10. Apply DV forecast logic (sell-vs-self-consume)
      const dvRules = applyDvForecastLogic(normalized, state, getCfg);
      if (dvRules.length > 0) {
        winningSchedule = [...winningSchedule, ...dvRules];
      }

      // 11. Convert to schedule rules
      const newRules = buildScheduleRules({
        slots: winningSchedule,
        source: 'forecast_optimizer',
        optimizer: source,
        getCfg
      });

      // 12. Check generation guard again before applying
      if (thisGeneration !== runGeneration) return;

      // 13. Atomic replacement
      state.schedule.rules = insertOptimizerRules(
        state.schedule.rules, newRules, 'forecast_optimizer'
      );

      // 14. Update optimizer state
      const currentVersion = ctx.forecastService.forecastVersion;
      state.optimizer.lastRunAt = new Date().toISOString();
      state.optimizer.lastSchedule = winningSchedule;
      state.optimizer.lastEosSchedule = eosSchedule;
      state.optimizer.source = source;
      state.optimizer.rulesCount = newRules.length;
      state.optimizer.error = null;
      state.optimizer.runCount++;
      state.optimizer.lastForecastVersion = currentVersion;

      // 15. Log
      pushLog('optimizer_run', {
        source,
        rulesCount: newRules.length,
        tier,
        confidence,
        runCount: state.optimizer.runCount,
        forecastVersion: currentVersion
      });

    } catch (err) {
      state.optimizer.error = err.message;
      pushLog('optimizer_error', { error: err.message });
    } finally {
      isRunning = false;
    }
  }

  // --- Timers ---
  let pollTimer = null;
  let fallbackTimer = null;

  function startTimers() {
    // Poll for forecast changes every 60s (D-02)
    pollTimer = setInterval(() => {
      const currentVersion = ctx.forecastService.forecastVersion;
      if (currentVersion !== state.optimizer.lastForecastVersion) {
        runOptimization().catch(err => pushLog('optimizer_error', { error: err.message }));
      }
    }, 60_000);

    // Fallback: re-optimize every 30min regardless (D-02)
    fallbackTimer = setInterval(() => {
      runOptimization().catch(err => pushLog('optimizer_error', { error: err.message }));
    }, 30 * 60 * 1000);
  }

  // --- Lifecycle ---

  /**
   * Start optimizer service. Does NOT exit if !enabled -- timers start unconditionally.
   * getCfg().optimizer.enabled is checked per-run in runOptimization().
   */
  async function start() {
    state.optimizer.enabled = getCfg().optimizer?.enabled ?? false;
    startTimers(); // Always start timers -- runOptimization gates on enabled

    // Initial run (if enabled)
    if (getCfg().optimizer?.enabled) {
      runOptimization().catch(err => pushLog('optimizer_error', { error: err.message }));
    }
  }

  /**
   * Graceful shutdown. Clear all timers.
   */
  async function close() {
    if (pollTimer) clearInterval(pollTimer);
    if (fallbackTimer) clearInterval(fallbackTimer);
    pollTimer = null;
    fallbackTimer = null;
  }

  return {
    start,
    close,
    getSchedule: () => state.optimizer.lastSchedule,
    getStatus: () => state.optimizer
  };
}
