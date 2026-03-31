// market-automation-builder.js -- SMA rule generation factory + shared constants.
// Extracted from server.js (Phase 4, Plan 01).
// Imports: small-market-automation.js, milp-optimizer.js, sun-times-cache.js, server-utils.js

import { berlinDateString } from './server-utils.js';
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
import { readSunTimesForDate } from './sun-times-cache.js';

// --- Named exports (shared constants + helper) ---

export const SMALL_MARKET_AUTOMATION_SOURCE = 'small_market_automation';
export const SMALL_MARKET_AUTOMATION_DISPLAY_TONE = 'yellow';
export const SMA_ID_PREFIX = 'sma-';
export const SLOT_DURATION_MS = 15 * 60 * 1000;

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

    // Current PV feed-in: if PV is active it covers part of the grid export target,
    // so the battery drain per slot is reduced → same battery budget supports more slots.
    const pvFeedInW = Math.max(0, Number(state.victron?.pvTotalW ?? state.victron?.pvPowerW ?? 0));

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

      if (todaySunriseMs != null && now < todaySunriseMs) {
        // Pre-sunrise: we're in the tail of last night's discharge window
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

    // Overall energy budget: use the most generous (latest/sunrise) budget
    let effectiveMinSocPct = automationConfig?.minSocPct ?? 30;
    if (batteryCapacityKwh > 0 && currentSocPct != null) {
      if (perSlotBudgets?.length) {
        availableEnergyKwh = perSlotBudgets[perSlotBudgets.length - 1].budgetKwh;
        // Compute the effective dynamic min SOC for the last (most generous) slot
        const lastSlotTs = Math.max(...perSlotBudgets.map(b => b.ts));
        effectiveMinSocPct = Math.round(computeDynamicAutomationMinSocPct({
          automationMinSocPct: automationConfig?.minSocPct,
          globalMinSocPct: state.victron?.minSocPct ?? 10,
          sunsetTs: sunsetMsForPlanning,
          sunriseTs: sunriseMsForPlanning,
          nowTs: lastSlotTs
        }) * 10) / 10;
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
          availableKwh: availableForPlanning,
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

    const expandedBestChain = expandChainSlots(plan.chain);

    const rules = (plan.selectedSlotTimestamps || []).map((slotTs, index) => {
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
    // Attach planning metadata for the plan summary
    rules._planMeta = {
      availableEnergyKwh,
      effectiveMinSocPct,
      pvFeedInW,
      sunriseTs: sunriseMsForPlanning,
      sunsetTs: sunsetMsForPlanning
    };
    return rules;
  }

  async function regenerateSmallMarketAutomationRules({ now = Date.now() } = {}) {
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
    const planHasFutureSlots = previousAutomationRules.some((rule) => {
      const slotTs = Number(rule?.slotTs);
      return Number.isFinite(slotTs) && slotTs > now;
    });
    const planIsLocked = planIsExecuting || (planHasFutureSlots && previousAutomationRules.some((rule) => {
      const slotEndTs = Number(rule?.slotEndTs);
      return Number.isFinite(slotEndTs) && now >= slotEndTs && (now - slotEndTs) < 30 * 60 * 1000;
    }));

    const needsRegeneration = buildNeedsRegeneration({
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
      // Plan is locked — defer regeneration until current execution completes
      return;
    }

    if (!needsRegeneration) return;

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
      availableEnergyKwh: effectiveAvailableEnergyKwh,
      lastSocPct: currentSocPct,
      selectedSlotTimestamps,
      plan: planSummary
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
