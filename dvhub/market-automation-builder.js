// market-automation-builder.js -- SMA rule generation factory + shared constants.
// Extracted from server.js (Phase 4, Plan 01).
// Imports: small-market-automation.js, milp-optimizer.js, sun-times-cache.js, server-utils.js

import { berlinDateString } from './server-utils.js';
import { toFiniteNumber } from './util.js';
import {
  buildAutomationRuleChain,
  buildChainVariants,
  computeAvailableEnergyKwh,
  computeDynamicAutomationMinSocPct,
  computeEnergyBasedSlotAllocation,
  computeForecastReserveSocPct,
  computeNextPeriodBounds,
  expandChainSlots,
  filterSlotsByTimeWindow,
  filterFreeAutomationSlots,
  pickBestAutomationPlan,
  pickMultiBlockPlan,
  SLOT_DURATION_HOURS
} from './small-market-automation.js';
import { pickMilpPlan } from './milp-optimizer.js';
import { readSunTimesForDate } from './sun-times-cache.js';
import { sumForecastSlotsKwh } from './small-market-automation.js';
import {
  detectQualifyingWindow,
  estimateWindowPvKwh,
  computePreEmptyTargetSoc,
  preEmptySlotSetpointW,
  resolveStage2Phase
} from './predictive-pre-empty.js';

// --- Named exports (shared constants + helper) ---

export const SMALL_MARKET_AUTOMATION_SOURCE = 'small_market_automation';
export const SMALL_MARKET_AUTOMATION_DISPLAY_TONE = 'yellow';
export const SMA_ID_PREFIX = 'sma-';
export const SLOT_DURATION_MS = 15 * 60 * 1000;

// --- Stage-2 (predictive pre-empty) integration constants ---
// Non-zero baseload used when state.forecast.load.data is empty/missing. A zero
// house load would under-estimate the implied battery discharge in the dual-limit
// clamp (RESEARCH.md Environment Availability) — NEVER fall back to 0.
const STAGE2_BASELOAD_FALLBACK_W = 400;
// SOC tolerance when checking whether the pre-empty target has been reached.
const STAGE2_TARGET_TOLERANCE_PCT = 1;

export function isSmallMarketAutomationRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  return rule.source === SMALL_MARKET_AUTOMATION_SOURCE
    || (typeof rule.id === 'string' && rule.id.startsWith(SMA_ID_PREFIX));
}

/**
 * Scale available battery energy upward to reflect reduced per-slot battery drain when PV
 * is simultaneously feeding in. The inverter's total export target (maxDischargeW) remains
 * unchanged; PV covers part of it, so the battery only needs to provide (maxAbs - pvW) per
 * slot. Scaling availableKwh by (maxAbs / batteryDrain) makes the chain truncation logic
 * (which uses powerW = maxDischargeW) yield the correct higher slot count.
 */
function pvAdjustedKwh(kwh, maxDischargeW, pvFeedInW) {
  if (!pvFeedInW || pvFeedInW <= 0 || kwh == null || kwh <= 0 || !maxDischargeW) return kwh;
  const maxAbs = Math.abs(maxDischargeW);
  const batteryDrain = Math.max(1, maxAbs - pvFeedInW);
  if (batteryDrain >= maxAbs) return kwh;
  return Math.round(kwh * (maxAbs / batteryDrain) * 100) / 100;
}

export function buildNeedsRegeneration({ runDate, lastState, priceSlotCount, currentSocPct, previousAutomationRules, batteryCapacityKwh, planIsLocked = false }) {
  const priceDataChanged = priceSlotCount !== (lastState?.lastPriceSlotCount || 0);
  const socChanged = !planIsLocked
    && batteryCapacityKwh > 0
    && currentSocPct != null
    && lastState?.lastSocPct != null
    && Math.abs(currentSocPct - lastState.lastSocPct) >= 5;
  const neverPlannedToday = !lastState?.lastRunDate || lastState.lastRunDate !== runDate;
  const missingRules = !previousAutomationRules.length && lastState?.lastOutcome !== 'no_slots';
  return neverPlannedToday || missingRules || priceDataChanged || socChanged;
}

// --- Factory ---

export function createMarketAutomationBuilder(ctx) {
  const { state, getCfg, pushLog } = ctx;

  // --- Private helpers (closure-scoped) ---

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

  // Normalize state.forecast.{pv,load}.data rows (shape varies per source —
  // ts vs ts_utc, powerW vs power_w) to a uniform {start, end, powerW, confidence}
  // so sumForecastSlotsKwh / computeForecastReserveSocPct can consume them.
  // Factory-scoped: shared by buildSmallMarketAutomationRules (Stage 1) and the
  // Stage-2 pre-pass (D-01 — both read the SAME normalized forecast rows).
  function normalizeForecastRows(rows, baselineConfidence, slotMin) {
    if (!Array.isArray(rows)) return [];
    const slotMs = slotMin * 60000;
    return rows.map((row) => {
      const startMs = row.ts ? new Date(row.ts).getTime()
                     : row.ts_utc ? new Date(row.ts_utc).getTime()
                     : null;
      if (!Number.isFinite(startMs)) return null;
      return {
        start: new Date(startMs).toISOString(),
        end: new Date(startMs + slotMs).toISOString(),
        powerW: Number(row.powerW ?? row.power_w ?? row.expected_w ?? 0),
        confidence: Number(row.confidence ?? baselineConfidence ?? 0.3)
      };
    }).filter(Boolean);
  }

  // --- Stage-2 (predictive pre-empty) pre-pass ---
  //
  // The stateful glue around the pure planning core in predictive-pre-empty.js.
  // Runs AFTER the Stage-1 hoarding gate (D-14): detects a qualifying EPEX
  // window, sizes a forecast-confidence-gated target SOC, emits the morning
  // LEEREN discharge rules (dual-limit-clamped gridSetpointW, per-slot stopSocPct
  // at the hard floor) plus the HALTEN dcExportMode rule, drives the
  // LEEREN/HALTEN/FREIGEBEN phase machine, persists the day-plan state, and
  // returns a stage2 summary object for planSummary.
  //
  // D-01: this NEVER touches computeForecastReserveSocPct /
  // computeDynamicAutomationMinSocPct. When predictivePreEmpty.enabled is OFF
  // (the default) it returns { rules: [], stage2: null } before doing anything.
  function runStage2PrePass({
    now,
    automationConfig,
    forecastReserve,
    currentSocPct,
    batteryCapacityKwh,
    sunTimesCache
  } = {}) {
    const idle = (reason) => ({ rules: [], stage2: reason ? { phase: 'IDLE', reason } : null });

    // D-15: the sub-switch is only effective when forecastAware is also on.
    if (!automationConfig?.forecastAware || !automationConfig?.predictivePreEmpty?.enabled) {
      return idle(null);
    }
    // D-14: Stage 1's hoarding gate has absolute priority — Stage 2 stays idle.
    if (forecastReserve?.hoardingActive) {
      return idle('hoarding_active');
    }

    const pp = automationConfig.predictivePreEmpty;
    const cfg = getCfg();
    const timeZone = cfg.schedule?.timezone || 'Europe/Berlin';

    const pvGenerationCostCtKwh = toFiniteNumber(pp.pvGenerationCostCtKwh, null);
    // D-05: the operator MUST configure the PV generation cost — there is no safe
    // generic default. Without it Stage 2 cannot detect a below-PV-cost window.
    if (pvGenerationCostCtKwh == null) {
      return idle('no_pv_cost_configured');
    }
    const akkuHardLimitW = toFiniteNumber(pp.akkuHardLimitW, 20000);
    const pvHeadroomFracW = toFiniteNumber(pp.pvHeadroomFracW, 1000);
    const confidenceFactorLow = toFiniteNumber(pp.confidenceFactorLow, 0.24);
    const confidenceFactorHigh = toFiniteNumber(pp.confidenceFactorHigh, 0.30);
    const haltenAbortDropPct = toFiniteNumber(pp.haltenAbortDropPct, 25);

    // D-06: sun-derived day bounds. Stage 2 computes its own daytime window and
    // does NOT inherit the SMA searchWindow config (10-WAVE0-FINDINGS decision).
    const nowDateStr = berlinDateString(new Date(now), cfg.epex?.timezone || timeZone);
    const todaySun = readSunTimesForDate({ cache: sunTimesCache?.cache, dateKey: nowDateStr });
    const sunriseMs = todaySun?.sunriseTs ? new Date(todaySun.sunriseTs).getTime() : null;
    const sunsetMs = todaySun?.sunsetTs ? new Date(todaySun.sunsetTs).getTime() : null;
    if (sunriseMs == null || sunsetMs == null) {
      return idle('no_sun_times');
    }
    const dayBounds = { startTs: sunriseMs, endTs: sunsetMs };

    // D-04 / D-07: detect the qualifying negative/below-PV-cost EPEX window.
    const window = detectQualifyingWindow(state.epex?.data, pvGenerationCostCtKwh, dayBounds);
    if (!window) {
      return idle('no_qualifying_window');
    }

    // D-08: estimate the PV the window will produce + its forecast confidence.
    const pvSlots = normalizeForecastRows(
      state.forecast?.pv?.data,
      state.forecast?.pv?.confidence,
      15
    );
    const pvEstimate = estimateWindowPvKwh({ pvSlots, window });

    // D-08 / D-09 / D-10: size the forecast-confidence-gated target SOC.
    const hardFloorSocPct = state.victron?.minSocPct ?? 5;
    const targetSoc = computePreEmptyTargetSoc({
      windowPvKwh: pvEstimate.totalKwh,
      confidence: pvEstimate.avgConfidence,
      batteryCapacityKwh,
      currentSocPct,
      hardFloorSocPct,
      inverterEfficiencyPct: automationConfig?.inverterEfficiencyPct,
      confidenceFactorLow,
      confidenceFactorHigh
    });
    const targetSocPct = targetSoc.targetSocPct;

    // D-11: the LEEREN deadline (holdStartTs) — the time by which the target SOC
    // must be reached. Compute the energy that must be discharged, divide by the
    // achievable per-slot battery share, and stretch the LEEREN phase over that
    // many 15-min slots so the target is guaranteed by the deadline. If the
    // target is already reached there are zero LEEREN slots and holdStartTs=now.
    const deltaSocPct = Math.max(0, toFiniteNumber(currentSocPct, 0) - targetSocPct);
    const acKwhPer100Pct = computeAvailableEnergyKwh({
      batteryCapacityKwh,
      currentSocPct: 100,
      minSocPct: 0,
      inverterEfficiencyPct: automationConfig?.inverterEfficiencyPct,
      safetyMarginPct: 0
    });
    const dischargeEnergyKwh = (toFiniteNumber(acKwhPer100Pct, 0) / 100) * deltaSocPct;
    const maxDischargeAbsW = Math.abs(toFiniteNumber(automationConfig?.maxDischargeW, -12000));
    const perSlotKwh = (maxDischargeAbsW / 1000) * (SLOT_DURATION_MS / 3600000);
    const slotsNeeded = perSlotKwh > 0
      ? Math.ceil(dischargeEnergyKwh / perSlotKwh)
      : 0;
    // The LEEREN phase ends slotsNeeded slots from now, but never past the window.
    let holdStartTs = Math.min(now + slotsNeeded * SLOT_DURATION_MS, window.startTs);
    if (!Number.isFinite(holdStartTs)) holdStartTs = now;

    // D-13: compare a fresh window PV estimate against the persisted plan's
    // estimate — a relative drop beyond haltenAbortDropPct flags the forecast as
    // degraded, which resolveStage2Phase turns into a HALTEN abort. On the first
    // plan of the day there is no prior estimate -> forecastDegraded = false.
    const persisted = state.schedule?.smallMarketAutomation?.stage2 || null;
    const priorWindowPvKwh = (persisted && persisted.planDate === nowDateStr)
      ? toFiniteNumber(persisted.plannedWindowPvKwh, null)
      : null;
    let forecastDegraded = false;
    if (priorWindowPvKwh != null && priorWindowPvKwh > 0) {
      const relDropPct = ((priorWindowPvKwh - pvEstimate.totalKwh) / priorWindowPvKwh) * 100;
      forecastDegraded = relDropPct > haltenAbortDropPct;
    }

    const targetReached = toFiniteNumber(currentSocPct, 0) <= targetSocPct + STAGE2_TARGET_TOLERANCE_PCT;

    // D-13: resolve the phase from the clock + plan inputs.
    const resolved = resolveStage2Phase({
      nowTs: now,
      windowStartTs: window.startTs,
      holdStartTs,
      targetReached,
      forecastDegraded
    });
    const phase = resolved.phase;

    // --- Per-phase rule emission ---
    const rules = [];
    const summarySlots = [];

    // House-load forecast (W) for the dual-limit clamp — averaged over a slot.
    // NEVER zero: an empty load forecast falls back to a non-zero baseload.
    const loadSlots = normalizeForecastRows(
      state.forecast?.load?.data,
      state.forecast?.load?.confidence,
      60
    );
    const slotHours = SLOT_DURATION_MS / 3600000;
    const expectedHouseLoadForSlot = (slotStartTs) => {
      const summed = sumForecastSlotsKwh({
        slots: loadSlots,
        fromTs: slotStartTs,
        toTs: slotStartTs + SLOT_DURATION_MS,
        defaultDurationMin: 60
      });
      const avgW = summed.slotsCounted > 0 ? (summed.totalKwh / slotHours) * 1000 : 0;
      return avgW > 0 ? avgW : STAGE2_BASELOAD_FALLBACK_W;
    };
    const pvForecastForSlot = (slotStartTs) => {
      const summed = sumForecastSlotsKwh({
        slots: pvSlots,
        fromTs: slotStartTs,
        toTs: slotStartTs + SLOT_DURATION_MS,
        defaultDurationMin: 15
      });
      return summed.slotsCounted > 0 ? (summed.totalKwh / slotHours) * 1000 : 0;
    };

    if (phase === 'LEEREN') {
      // One gridSetpointW discharge rule per morning slot in [now, holdStartTs].
      for (let slotTs = now; slotTs < holdStartTs; slotTs += SLOT_DURATION_MS) {
        const setpoint = preEmptySlotSetpointW({
          pvForecastW: pvForecastForSlot(slotTs),
          expectedHouseLoadW: expectedHouseLoadForSlot(slotTs),
          maxDischargeW: automationConfig?.maxDischargeW,
          akkuHardLimitW,
          pvHeadroomFracW
        });
        // Pitfall 1 / defence-in-depth: a Stage-2 gridSetpointW rule MUST never
        // carry a positive value (which would be an illegal grid charge).
        if (!(setpoint.gridSetpointW <= 0)) continue;
        const start = new Date(slotTs);
        const end = new Date(slotTs + SLOT_DURATION_MS);
        rules.push({
          id: `sma-stage2-leeren-${slotTs}`,
          enabled: true,
          target: 'gridSetpointW',
          start: formatLocalHHMM(start, timeZone),
          end: formatLocalHHMM(end, timeZone),
          value: setpoint.gridSetpointW,
          activeDate: nowDateStr,
          slotTs,
          slotEndTs: slotTs + SLOT_DURATION_MS,
          source: SMALL_MARKET_AUTOMATION_SOURCE,
          autoManaged: true,
          displayTone: SMALL_MARKET_AUTOMATION_DISPLAY_TONE,
          // D-10 / Pitfall 4: per-slot stop floor is the global HARD floor, NOT
          // the static minSocPct — Stage 2 is allowed to drain to the hard floor.
          stopSocPct: hardFloorSocPct,
          stage2Phase: 'LEEREN'
        });
        summarySlots.push({
          ts: slotTs,
          gridSetpointW: setpoint.gridSetpointW,
          impliedBatteryDischargeW: setpoint.impliedBatteryDischargeW,
          mode: setpoint.mode
        });
      }
    } else if (phase === 'HALTEN') {
      // D-02 / D-03: ONE dcExportMode rule holds the battery empty until the
      // qualifying window opens — reuses the existing dc_export_mode runtime.
      rules.push({
        id: `sma-stage2-hold-${holdStartTs}`,
        enabled: true,
        target: 'dcExportMode',
        value: 1,
        start: formatLocalHHMM(new Date(holdStartTs), timeZone),
        end: formatLocalHHMM(new Date(window.startTs), timeZone),
        activeDate: nowDateStr,
        source: SMALL_MARKET_AUTOMATION_SOURCE,
        autoManaged: true,
        displayTone: SMALL_MARKET_AUTOMATION_DISPLAY_TONE,
        stage2Phase: 'HALTEN'
      });
    }
    // FREIGEBEN / IDLE: emit no Stage-2 rules.

    // D-16: the stage2 summary object surfaced via planSummary.
    const stage2 = {
      phase,
      reason: resolved.reason,
      window: { startTs: window.startTs, endTs: window.endTs },
      targetSocPct,
      depthFactor: targetSoc.depthFactor,
      plannedWindowPvKwh: pvEstimate.totalKwh,
      windowPvConfidence: pvEstimate.avgConfidence,
      forecastDegraded,
      holdStartTs,
      slots: summarySlots
    };

    // Persist the day-plan state so a mid-day restart recomputes the phase
    // idempotently from `now` (Open Question 3).
    const prevPhase = persisted?.phase ?? null;
    if (state.schedule) {
      if (!state.schedule.smallMarketAutomation) state.schedule.smallMarketAutomation = {};
      state.schedule.smallMarketAutomation.stage2 = {
        phase,
        windowStartTs: window.startTs,
        holdStartTs,
        targetSocPct,
        planDate: nowDateStr,
        plannedWindowPvKwh: pvEstimate.totalKwh
      };
    }

    // D-16: pushLog on every phase change.
    if (prevPhase !== phase) {
      pushLog('stage2_phase_change', {
        from: prevPhase,
        to: phase,
        windowStartTs: window.startTs,
        targetSocPct
      });
    }

    return { rules, stage2 };
  }

  // Pitfall 5 carve-out: re-evaluate ONLY the Stage-2 phase decision (and the
  // HALTEN dcExportMode rule) without re-planning the plan-locked LEEREN
  // discharge slots. Called on the cycles where regeneration is skipped (plan
  // locked or no regeneration needed) so the phase machine keeps evolving and a
  // degraded forecast can still abort HALTEN. Reads Stage 1 read-only (D-01).
  function reevaluateStage2PhaseOnly({ now, automationConfig, currentSocPct, batteryCapacityKwh } = {}) {
    if (!automationConfig?.forecastAware || !automationConfig?.predictivePreEmpty?.enabled) return;

    // Compute the Stage-1 hoarding gate read-only (D-01 — never mutates Stage 1).
    const forecastReserve = computeForecastReserveSocPct({
      pvSlots: normalizeForecastRows(state.forecast?.pv?.data, state.forecast?.pv?.confidence, 15),
      loadSlots: normalizeForecastRows(state.forecast?.load?.data, state.forecast?.load?.confidence, 60),
      nowTs: now,
      horizonHours: 24,
      currentSocPct,
      batteryCapacityKwh,
      configuredMinSocPct: automationConfig?.minSocPct,
      globalMinSocPct: state.victron?.minSocPct ?? 5,
      safetyMarginKwh: 1.5,
      confidenceThreshold: 0.25
    });

    const sunTimesCache = ctx.getSunTimesCacheForPlanning({ now });
    const result = runStage2PrePass({
      now,
      automationConfig,
      forecastReserve,
      currentSocPct,
      batteryCapacityKwh,
      sunTimesCache
    });

    // Only touch the HALTEN dcExportMode rule — never the locked LEEREN slots.
    const rules = Array.isArray(state.schedule?.rules) ? state.schedule.rules : [];
    const existingHold = rules.filter((r) => r?.stage2Phase === 'HALTEN');
    const desiredHold = result.rules.filter((r) => r?.stage2Phase === 'HALTEN');
    let changed = false;
    // Drop a stale HALTEN rule when the phase is no longer HALTEN (abort/release).
    if (existingHold.length && !desiredHold.length) {
      state.schedule.rules = rules.filter((r) => r?.stage2Phase !== 'HALTEN');
      changed = true;
    } else if (desiredHold.length) {
      // (Re)install the HALTEN rule — replace any existing one.
      state.schedule.rules = [
        ...rules.filter((r) => r?.stage2Phase !== 'HALTEN'),
        ...desiredHold
      ];
      changed = true;
    }
    // Refresh the surfaced stage2 summary on the plan object.
    const sma = state.schedule?.smallMarketAutomation;
    if (sma?.plan) sma.plan.stage2 = result.stage2 ?? null;
    if (changed) ctx.persistConfig();
  }

  // --- Public methods ---

  async function buildSmallMarketAutomationRules({
    now = Date.now(),
    automationConfig,
    priceSlots,
    occupiedRules,
    sunTimesCache
  } = {}) {
    const cfg = getCfg();
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

    // Raw PV reading — adjusted below after sunset time is known
    const rawPvW = Math.max(0, Number(state.victron?.pvTotalW ?? state.victron?.pvPowerW ?? 0));

    // Forecast-aware reserve (toggle: schedule.smallMarketAutomation.forecastAware).
    // When enabled, replaces the static automationMinSocPct with a dynamic value derived
    // from PV + load forecast for the next 24h. Forecast can only RELAX the configured
    // floor (it acts as a CEILING on conservatism). Also surfaces a hoarding-gate that
    // suppresses discharge entirely when the 24h energy balance is negative.
    // state.forecast.{pv,load}.data are the raw forecast subsystems' rows. Shape varies
    // per source (ts vs ts_utc, powerW vs power_w). normalizeForecastRows (factory-scoped)
    // maps them to {start, end, powerW, confidence} so sumForecastSlotsKwh can consume
    // either uniformly.
    const forecastReserve = automationConfig?.forecastAware
      ? computeForecastReserveSocPct({
          pvSlots: normalizeForecastRows(state.forecast?.pv?.data, state.forecast?.pv?.confidence, 15),
          loadSlots: normalizeForecastRows(state.forecast?.load?.data, state.forecast?.load?.confidence, 60),
          nowTs: now,
          horizonHours: 24,
          currentSocPct,
          batteryCapacityKwh,
          configuredMinSocPct: automationConfig?.minSocPct,
          globalMinSocPct: state.victron?.minSocPct ?? 5,
          safetyMarginKwh: 1.5,
          // Ensemble forecast confidences on prod sit at 0.25-0.30 (PV baseline, load baseline).
          // 0.25 is the lowest meaningful threshold that lets the forecast actually drive the
          // reserve; tighter values silently fall back to the configured static floor.
          confidenceThreshold: 0.25
        })
      : null;
    const baseMinSocPct = forecastReserve?.effectiveMinSocPct ?? automationConfig?.minSocPct ?? 30;

    // Hoarding-Gate: forecast says 24h energy budget is negative — preserve all stored
    // energy for self-consumption rather than selling it cheap and re-importing at retail.
    if (forecastReserve?.hoardingActive) {
      const skip = [];
      skip._planMeta = {
        availableEnergyKwh: 0,
        effectiveMinSocPct: baseMinSocPct,
        pvFeedInW: 0,
        sunriseTs: null,
        sunsetTs: null,
        forecastReserve
      };
      return skip;
    }

    // Dynamic SOC floor: sunrise/sunset-aware energy budgeting.
    // Each slot gets a time-dependent energy budget — morning slots near sunrise
    // can access more battery energy because the SOC floor is lower then.
    // perSlotBudgets: array of { ts, budgetKwh } sorted chronologically.
    let perSlotBudgets = null;
    let sunsetMsForPlanning = null;
    let sunriseMsForPlanning = null;

    if (sunTimesCache?.cache && freeSlots.length) {
      // Determine the active overnight window based on now (not latestSlotTs).
      // Using latestSlotTs caused the wrong window for same-day search windows: today's
      // sunrise (already past) was used, making every slot return globalMin.
      // Correct logic: before today's sunrise → last-night window; otherwise → tonight window.
      const nowDateStr = berlinDateString(new Date(now), cfg.epex.timezone);
      const prevDateStr = berlinDateString(new Date(now - 86400000), cfg.epex.timezone);
      const nextDateStr = berlinDateString(new Date(now + 86400000), cfg.epex.timezone);

      const todaySunTimes = readSunTimesForDate({ cache: sunTimesCache.cache, dateKey: nowDateStr });
      const prevDaySunTimes = readSunTimesForDate({ cache: sunTimesCache.cache, dateKey: prevDateStr });
      const nextDaySunTimes = readSunTimesForDate({ cache: sunTimesCache.cache, dateKey: nextDateStr });

      const todaySunriseMs = todaySunTimes?.sunriseTs ? new Date(todaySunTimes.sunriseTs).getTime() : null;
      const todaySunsetMs = todaySunTimes?.sunsetTs ? new Date(todaySunTimes.sunsetTs).getTime() : null;
      const prevSunsetMs = prevDaySunTimes?.sunsetTs ? new Date(prevDaySunTimes.sunsetTs).getTime() : null;
      const tomorrowSunriseMs = nextDaySunTimes?.sunriseTs ? new Date(nextDaySunTimes.sunriseTs).getTime() : null;

      // Also treat as pre-sunrise if we're still in the morning tail of last night's
      // discharge window (periodBounds ends within 3h after today's sunrise).
      // Without this, slots at e.g. 07:15–08:45 would switch to tonight's window and
      // receive automationMinSocPct instead of the lower globalMinSocPct, shrinking
      // the energy budget right when the battery should still be available.
      const inMorningTail = periodBounds?.endTs != null
        && todaySunriseMs != null
        && periodBounds.endTs <= todaySunriseMs + 3 * 3600000;

      if (todaySunriseMs != null && (now < todaySunriseMs || inMorningTail)) {
        // Pre-sunrise or still in the morning tail of last night's discharge window
        sunriseMsForPlanning = todaySunriseMs;
        sunsetMsForPlanning = prevSunsetMs ?? (todaySunriseMs - 12 * 3600000);
      } else if (todaySunsetMs != null && tomorrowSunriseMs != null) {
        // Daytime or after tonight's sunset: use tonight→tomorrow window
        sunsetMsForPlanning = todaySunsetMs;
        sunriseMsForPlanning = tomorrowSunriseMs;
      }

      if (batteryCapacityKwh > 0 && currentSocPct != null
          && sunsetMsForPlanning != null && sunriseMsForPlanning != null) {
        perSlotBudgets = freeSlots
          .map(s => Number(s?.ts) || 0)
          .sort((a, b) => a - b)
          .map(ts => {
            const dynamicMin = computeDynamicAutomationMinSocPct({
              automationMinSocPct: baseMinSocPct,
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

    // Overall energy budget: use the most generous (latest/sunrise) budget
    let effectiveMinSocPct = baseMinSocPct;
    if (batteryCapacityKwh > 0 && currentSocPct != null) {
      if (perSlotBudgets?.length) {
        availableEnergyKwh = perSlotBudgets[perSlotBudgets.length - 1].budgetKwh;
        // Compute the effective dynamic min SOC for the last (most generous) slot
        const lastSlotTs = Math.max(...perSlotBudgets.map(b => b.ts));
        effectiveMinSocPct = Math.round(computeDynamicAutomationMinSocPct({
          automationMinSocPct: baseMinSocPct,
          globalMinSocPct: state.victron?.minSocPct ?? 10,
          sunsetTs: sunsetMsForPlanning,
          sunriseTs: sunriseMsForPlanning,
          nowTs: lastSlotTs
        }) * 10) / 10;
      } else {
        availableEnergyKwh = computeAvailableEnergyKwh({
          batteryCapacityKwh,
          currentSocPct,
          minSocPct: baseMinSocPct,
          inverterEfficiencyPct: automationConfig?.inverterEfficiencyPct
        });
      }
    }

    // Hard energy gate: if battery capacity is known and no energy available, skip planning
    if (availableEnergyKwh != null && availableEnergyKwh <= 0) return [];

    // PV feed-in for planning: only count PV if we're well before sunset.
    // After sunset (or within 1h), PV=0 — prevents inflating evening slot budgets
    // with daytime PV that won't exist when the slots actually execute.
    const pvFeedInW = (sunsetMsForPlanning && now < sunsetMsForPlanning - 3600000) ? rawPvW : 0;

    // PV-adjusted energy for chain planning: if PV is feeding in, the battery drain per slot
    // is (maxDischargeW - pvFeedInW), so the same battery energy supports more discharge slots.
    // We scale up availableKwh proportionally so the truncation logic (which uses powerW =
    // maxDischargeW) yields the correct higher slot count. The rule values themselves remain
    // at maxDischargeW (the inverter handles the PV/battery split at runtime).
    const availableForPlanning = pvAdjustedKwh(availableEnergyKwh, automationConfig?.maxDischargeW, pvFeedInW);

    // Generate multiple chain variants (1-stage, 2-stage, ... N-stage prefixes),
    // each energy-truncated to the available battery budget.
    const chainVariants = buildChainVariants({
      maxDischargeW: automationConfig?.maxDischargeW,
      stages: Array.isArray(automationConfig?.stages) && automationConfig.stages.length
        ? automationConfig.stages
        : [{ dischargeW: automationConfig?.maxDischargeW, dischargeSlots: computeDefaultDischargeSlots(automationConfig, availableForPlanning), cooldownSlots: 0 }],
      availableKwh: availableForPlanning,
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
          availableKwh: availableEnergyKwh, // actual battery energy, not PV-adjusted (PV scaling only applies to greedy chain truncation)
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
        availableKwh: availableForPlanning,
        slotDurationMs: SLOT_DURATION_MS,
        slotDurationH: SLOT_DURATION_HOURS
      });

      plan = (multiBlockPlan.totalRevenueCt > singleBlockPlan.totalRevenueCt)
        ? multiBlockPlan
        : singleBlockPlan;
      plan.engine = 'greedy';
    }

    // --- Partial remainder slot ---
    // After the main plan uses N full slots, place any leftover energy at the most
    // profitable free slot that comes AFTER the last planned slot ends.
    // E.g. plan uses 18 kWh of 22 kWh available → 4 kWh left → best slot at -16000 W.
    {
      const maxAbsW = Math.abs(automationConfig?.maxDischargeW ?? 0);
      if (maxAbsW > 0 && availableEnergyKwh != null && availableEnergyKwh > 0
          && plan.selectedSlotTimestamps.length > 0) {
        const planExpanded = expandChainSlots(plan.chain);
        const planEnergyKwh = plan.selectedSlotTimestamps.reduce((sum, _ts, idx) => {
          const pw = Math.abs(toFiniteNumber(planExpanded[idx]?.powerW, maxAbsW));
          return sum + (pw / 1000) * SLOT_DURATION_HOURS;
        }, 0);
        const remainingKwh = Math.max(0, availableEnergyKwh - planEnergyKwh);
        const partialW = remainingKwh > 0 ? Math.round((remainingKwh / SLOT_DURATION_HOURS) * 1000) : 0;

        if (partialW >= 500) {
          const lastSlotTs = Math.max(...plan.selectedSlotTimestamps.map(Number));
          const selectedSet = new Set(plan.selectedSlotTimestamps.map(Number));
          let bestSlot = null;
          let bestCtKwh = -Infinity;
          for (const s of freeSlots) {
            const ts = Number(s?.ts);
            if (selectedSet.has(ts) || ts <= lastSlotTs) continue;
            const ctKwh = Number(s?.ct_kwh ?? -Infinity);
            if (ctKwh > bestCtKwh) { bestCtKwh = ctKwh; bestSlot = s; }
          }
          // Only add if profitable (positive revenue at partial power)
          if (bestSlot != null && (partialW / 1000) * SLOT_DURATION_HOURS * bestCtKwh > 0) {
            plan = {
              ...plan,
              selectedSlotTimestamps: [...plan.selectedSlotTimestamps, Number(bestSlot.ts)],
              chain: [...plan.chain, { powerW: -partialW, slots: 1 }]
            };
          }
        }
      }
    }

    const expandedBestChain = expandChainSlots(plan.chain);

    const rules = (plan.selectedSlotTimestamps || []).map((slotTs, index) => {
      const slot = freeSlots.find((entry) => Number(entry?.ts) === Number(slotTs));
      if (!slot) return null;
      const start = new Date(slot.ts);
      const end = new Date(slot.ts + SLOT_DURATION_MS);
      // Per-slot SOC safety floor: schedule-runtime.js:57-59 stops execution when SOC < stopSocPct.
      // Anchored on the static automationConfig.minSocPct (NOT the forecast-relaxed baseMinSocPct) so
      // an optimistic forecast cannot lower the per-slot stop floor and drain the battery overnight.
      const slotFloorSocPct = (sunsetMsForPlanning != null && sunriseMsForPlanning != null)
        ? Math.round(computeDynamicAutomationMinSocPct({
            automationMinSocPct: automationConfig?.minSocPct ?? 30,
            globalMinSocPct: state.victron?.minSocPct ?? 10,
            sunsetTs: sunsetMsForPlanning,
            sunriseTs: sunriseMsForPlanning,
            nowTs: slot.ts
          }) * 10) / 10
        : null;
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
        displayTone: SMALL_MARKET_AUTOMATION_DISPLAY_TONE,
        stopSocPct: slotFloorSocPct ?? undefined
      };
    }).filter(Boolean);

    // ── Post-plan recomputation of the displayed/enforced SOC floor ──
    // The pre-plan `effectiveMinSocPct` was based on the LATEST slot in the
    // entire search window (which often sits past sunrise → falls all the way
    // to globalMin = 5%). When the actual plan only uses evening slots, that
    // display value lies and — if the greedy fallback path was taken — the
    // global `availableEnergyKwh` cap was also wrong-sized for those slots.
    // Recompute both based on the last *selected* slot, and trim trailing
    // low-revenue slots if the plan exceeds the actual budget at that ts.
    if (rules.length && batteryCapacityKwh > 0 && currentSocPct != null
        && sunsetMsForPlanning != null && sunriseMsForPlanning != null) {
      const lastSelectedTs = Math.max(...rules.map((r) => Number(r.slotTs) || 0));
      const dynMin = computeDynamicAutomationMinSocPct({
        automationMinSocPct: baseMinSocPct,
        globalMinSocPct: state.victron?.minSocPct ?? 10,
        sunsetTs: sunsetMsForPlanning,
        sunriseTs: sunriseMsForPlanning,
        nowTs: lastSelectedTs
      });
      effectiveMinSocPct = Math.round(dynMin * 10) / 10;
      const budgetAtLastSlot = computeAvailableEnergyKwh({
        batteryCapacityKwh,
        currentSocPct,
        minSocPct: dynMin,
        inverterEfficiencyPct: automationConfig?.inverterEfficiencyPct
      });
      availableEnergyKwh = budgetAtLastSlot;

      // Safety: if the planner over-allocated (e.g. greedy fallback ran
      // against a too-large `availableEnergyKwh`), trim trailing low-revenue
      // slots so cumulative energy at lastSelectedTs ≤ budgetAtLastSlot.
      const slotEnergyKwh = (Math.abs(automationConfig?.maxDischargeW ?? 0) / 1000) * SLOT_DURATION_HOURS;
      let totalEnergyKwh = rules.reduce((sum, r) => {
        const w = Math.abs(Number(r.value) || 0);
        return sum + (w / 1000) * SLOT_DURATION_HOURS;
      }, 0);
      if (totalEnergyKwh > budgetAtLastSlot + 0.001 && slotEnergyKwh > 0) {
        // Drop slots with the lowest price (least lost revenue) first.
        const priceFor = (r) => {
          const slot = (state.epex?.data || []).find((s) => Number(s?.ts) === Number(r.slotTs));
          return Number(slot?.ct_kwh ?? 0);
        };
        const sortedByPriceAsc = [...rules].sort((a, b) => priceFor(a) - priceFor(b));
        const drop = new Set();
        for (const r of sortedByPriceAsc) {
          if (totalEnergyKwh <= budgetAtLastSlot + 0.001) break;
          drop.add(r.id);
          const w = Math.abs(Number(r.value) || 0);
          totalEnergyKwh -= (w / 1000) * SLOT_DURATION_HOURS;
        }
        const before = rules.length;
        for (let i = rules.length - 1; i >= 0; i--) if (drop.has(rules[i].id)) rules.splice(i, 1);
        pushLog?.('sma_plan_trimmed_to_budget', {
          droppedCount: before - rules.length,
          budgetKwh: Math.round(budgetAtLastSlot * 100) / 100,
          finalEnergyKwh: Math.round(totalEnergyKwh * 100) / 100,
          effectiveMinSocPct
        });
      }
    }

    // Attach planning metadata for the plan summary
    rules._planMeta = {
      availableEnergyKwh,
      effectiveMinSocPct,
      pvFeedInW,
      sunriseTs: sunriseMsForPlanning,
      sunsetTs: sunsetMsForPlanning,
      forecastReserve
    };
    return rules;
  }

  async function regenerateSmallMarketAutomationRules({ now = Date.now(), force = false } = {}) {
    const cfg = getCfg();
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
        ctx.persistConfig();
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
    // force=true skips the gap lock (manual replan) but still respects active execution.
    const planHasFutureSlots = previousAutomationRules.some((rule) => {
      const slotTs = Number(rule?.slotTs);
      return Number.isFinite(slotTs) && slotTs > now;
    });
    const planIsLocked = planIsExecuting || (!force && planHasFutureSlots && previousAutomationRules.some((rule) => {
      const slotEndTs = Number(rule?.slotEndTs);
      return Number.isFinite(slotEndTs) && now >= slotEndTs && (now - slotEndTs) < 30 * 60 * 1000;
    }));

    const needsRegeneration = force || buildNeedsRegeneration({
      runDate,
      lastState,
      priceSlotCount,
      currentSocPct,
      previousAutomationRules,
      batteryCapacityKwh: automationConfig?.batteryCapacityKwh,
      planIsLocked
    });

    // Even if regeneration is needed, skip it while a plan is actively running
    if (planIsLocked && needsRegeneration && !priceDataChanged) {
      // Plan is locked — defer the discharge-slot regeneration until the current
      // execution completes. BUT the Stage-2 phase decision (Pitfall 5) is NOT
      // plan-locked: re-evaluate the LEEREN/HALTEN/FREIGEBEN phase + the HALTEN
      // abort every cycle so a degraded forecast can expire the dcExportMode rule
      // without re-planning the locked discharge slots.
      reevaluateStage2PhaseOnly({ now, automationConfig, currentSocPct, batteryCapacityKwh });
      return;
    }

    if (!needsRegeneration) {
      // Same — no full regeneration needed, but the Stage-2 phase still evolves.
      reevaluateStage2PhaseOnly({ now, automationConfig, currentSocPct, batteryCapacityKwh });
      return;
    }

    const sunTimesCache = ctx.getSunTimesCacheForPlanning({ now });

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
        ctx.persistConfig();
      }
      return;
    }

    const generatedRules = await buildSmallMarketAutomationRules(planInput);
    const planMeta = generatedRules._planMeta || {};
    delete generatedRules._planMeta;
    const effectiveAvailableEnergyKwh = planMeta.availableEnergyKwh ?? availableEnergyKwh;

    // --- Stage-2 (predictive pre-empty) pre-pass ---
    // Runs AFTER the Stage-1 hoarding gate: buildSmallMarketAutomationRules
    // returns its forecastReserve in _planMeta; when hoardingActive is true
    // runStage2PrePass itself sees it and emits nothing (D-14). The Stage-2
    // rules (morning LEEREN slots + the HALTEN dcExportMode rule) are PREPENDED
    // to the SMA rules — they own their own slots and never double-emit.
    const stage2Result = runStage2PrePass({
      now,
      automationConfig,
      forecastReserve: planMeta.forecastReserve,
      currentSocPct,
      batteryCapacityKwh,
      sunTimesCache
    });

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
      availableEnergyKwh: effectiveAvailableEnergyKwh,
      currentSocPct,
      minSocPct: automationConfig?.minSocPct,
      effectiveMinSocPct: planMeta.effectiveMinSocPct ?? automationConfig?.minSocPct ?? 30,
      dynamicSocFloor: (planMeta.effectiveMinSocPct ?? automationConfig?.minSocPct ?? 30) !== (automationConfig?.minSocPct ?? 30),
      pvFeedInW: planMeta.pvFeedInW ?? 0,
      sunriseTs: planMeta.sunriseTs ? new Date(planMeta.sunriseTs).toISOString() : null,
      sunsetTs: planMeta.sunsetTs ? new Date(planMeta.sunsetTs).toISOString() : null,
      maxDischargeW: automationConfig?.maxDischargeW,
      forecastAware: !!automationConfig?.forecastAware,
      forecastReserve: planMeta.forecastReserve ?? null,
      stage2: stage2Result.stage2 ?? null,
      estimatedRevenueCt: generatedRules.reduce((sum, r) => {
        const slot = state.epex?.data?.find((s) => {
          const match = r?.id?.match(/^sma-(\d+)-/);
          return match && Number(s.ts) === Number(match[1]);
        });
        if (!slot) return sum;
        return sum + (Math.abs(Number(r.value)) / 1000) * SLOT_DURATION_HOURS * Number(slot.ct_kwh || 0) / 100;
      }, 0)
    };

    // Apply rules — Stage-2 rules prepended ahead of the Stage-1 SMA rules.
    state.schedule.rules = [...manualRules, ...stage2Result.rules, ...generatedRules];
    // runStage2PrePass persisted its day-plan state into
    // state.schedule.smallMarketAutomation.stage2; capture it before the object
    // is reassigned so a mid-day restart can recompute the phase idempotently.
    const stage2DayPlan = state.schedule.smallMarketAutomation?.stage2 ?? null;
    state.schedule.smallMarketAutomation = {
      lastRunDate: runDate,
      lastOutcome: generatedRules.length ? 'generated' : 'no_slots',
      generatedRuleCount: generatedRules.length,
      lastPriceSlotCount: priceSlotCount,
      availableEnergyKwh: effectiveAvailableEnergyKwh,
      lastSocPct: currentSocPct,
      selectedSlotTimestamps,
      plan: planSummary,
      stage2: stage2DayPlan
    };
    ctx.persistConfig();

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

  return { buildSmallMarketAutomationRules, regenerateSmallMarketAutomationRules };
}
