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

    // Generate multiple chain variants (1-stage, 2-stage, ... N-stage prefixes),
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
