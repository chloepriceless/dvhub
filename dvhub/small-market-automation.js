import { toFiniteNumber } from './util.js';
import { parseHHMM } from './schedule-runtime.js';

export const SLOT_DURATION_HOURS = 0.25; // 15 minutes

export function expandChainSlots(chain = []) {
  const expanded = [];
  for (const entry of chain) {
    const slots = Math.max(0, toFiniteNumber(entry?.slots, 0));
    const powerW = toFiniteNumber(entry?.powerW, 0);
    for (let index = 0; index < slots; index += 1) {
      expanded.push({ powerW });
    }
  }
  return expanded;
}

function estimateSlotRevenueCt(slot, powerW) {
  const priceCtKwh = toFiniteNumber(slot?.ct_kwh, 0);
  return (Math.abs(toFiniteNumber(powerW, 0)) / 1000) * SLOT_DURATION_HOURS * priceCtKwh;
}

function ensureNegative(value, fallback) {
  const num = toFiniteNumber(value, fallback);
  if (num == null) return fallback;
  return -Math.abs(num);
}

export function computeAvailableEnergyKwh({
  batteryCapacityKwh,
  currentSocPct,
  minSocPct,
  inverterEfficiencyPct = 85,
  safetyMarginPct = 5
} = {}) {
  const capacity = toFiniteNumber(batteryCapacityKwh, null);
  if (capacity == null || capacity <= 0) return null;
  const currentSoc = Math.max(0, Math.min(100, toFiniteNumber(currentSocPct, 0)));
  const minSoc = Math.max(0, Math.min(100, toFiniteNumber(minSocPct, 0)));
  const efficiency = Math.max(1, Math.min(100, toFiniteNumber(inverterEfficiencyPct, 85)));
  const safety = Math.max(0, Math.min(50, toFiniteNumber(safetyMarginPct, 5)));

  const usableCapacity = capacity * (1 - safety / 100);
  const socDelta = Math.max(0, currentSoc - minSoc);
  const dcEnergy = usableCapacity * (socDelta / 100);
  const acEnergy = dcEnergy * (efficiency / 100);
  return Math.round(acEnergy * 100) / 100;
}

export function computeEnergyBasedSlotAllocation({
  availableKwh,
  maxDischargeW,
  slotDurationH = SLOT_DURATION_HOURS
} = {}) {
  const energy = toFiniteNumber(availableKwh, 0);
  const maxW = Math.abs(toFiniteNumber(maxDischargeW, 0));
  if (energy <= 0 || maxW <= 0) return { fullSlots: 0, partialSlotW: 0, totalSlots: 0 };

  const energyPerFullSlot = (maxW / 1000) * slotDurationH;
  const fullSlots = Math.floor(energy / energyPerFullSlot);
  const remainingKwh = energy - fullSlots * energyPerFullSlot;
  const partialSlotW = Math.round((remainingKwh / slotDurationH) * 1000);
  const totalSlots = partialSlotW > 0 ? fullSlots + 1 : fullSlots;

  return { fullSlots, partialSlotW: partialSlotW > 0 ? -partialSlotW : 0, totalSlots };
}

export function buildAutomationRuleChain({ maxDischargeW, stages = [] }) {
  const cappedMaxW = ensureNegative(maxDischargeW, 0);
  if (!Array.isArray(stages)) return [];

  return stages.flatMap((stage) => {
    const entries = [];
    const dischargeSlots = Math.max(0, toFiniteNumber(stage?.dischargeSlots, 0));
    const rawDischargeW = ensureNegative(stage?.dischargeW, cappedMaxW);
    const dischargeW = Math.max(rawDischargeW, cappedMaxW);
    if (dischargeSlots > 0) {
      entries.push({ powerW: dischargeW, slots: dischargeSlots });
    }

    const cooldownSlots = Math.max(0, toFiniteNumber(stage?.cooldownSlots, 0));
    const rawCooldownW = ensureNegative(stage?.cooldownW, cappedMaxW);
    const cooldownW = Math.max(rawCooldownW, cappedMaxW);
    if (cooldownSlots > 0) {
      entries.push({ powerW: cooldownW, slots: cooldownSlots });
    }
    return entries;
  });
}

/**
 * Generate progressive chain variants by taking 1-stage, 2-stage, … N-stage prefixes.
 * Each variant is a chain produced by buildAutomationRuleChain with that prefix of stages.
 * Optionally truncates chains to fit within an energy budget (kWh).
 */
export function buildChainVariants({ maxDischargeW, stages = [], availableKwh = null, slotDurationH = SLOT_DURATION_HOURS }) {
  if (!Array.isArray(stages) || !stages.length) return [];

  const variants = [];
  for (let count = 1; count <= stages.length; count++) {
    const chain = buildAutomationRuleChain({
      maxDischargeW,
      stages: stages.slice(0, count)
    });
    if (!chain.length) continue;

    if (availableKwh != null && availableKwh > 0) {
      const truncated = truncateChainToEnergy(chain, availableKwh, slotDurationH);
      if (truncated.length) variants.push(truncated);
    } else {
      variants.push(chain);
    }
  }

  return variants;
}

/**
 * Truncate a chain so its total energy consumption does not exceed availableKwh.
 * Preserves entries in order; reduces the last entry's slot count if partial.
 */
function truncateChainToEnergy(chain, availableKwh, slotDurationH = SLOT_DURATION_HOURS) {
  if (!Array.isArray(chain) || availableKwh <= 0) return [];

  const result = [];
  let remainingKwh = availableKwh;

  for (const entry of chain) {
    const powerW = Math.abs(toFiniteNumber(entry?.powerW, 0));
    const slots = Math.max(0, toFiniteNumber(entry?.slots, 0));
    if (!slots || !powerW) continue;

    const energyPerSlot = (powerW / 1000) * slotDurationH;
    const maxSlots = Math.floor(remainingKwh / energyPerSlot);
    if (maxSlots <= 0) break;

    const usedSlots = Math.min(slots, maxSlots);
    result.push({ powerW: entry.powerW, slots: usedSlots });
    remainingKwh -= usedSlots * energyPerSlot;
    if (remainingKwh <= 0) break;
  }

  return result;
}

export function computeDynamicAutomationMinSocPct({
  automationMinSocPct,
  globalMinSocPct,
  sunsetTs,
  sunriseTs,
  nowTs
}) {
  const automationMin = toFiniteNumber(automationMinSocPct, 0);
  const globalMin = toFiniteNumber(globalMinSocPct, automationMin);
  const sunset = toFiniteNumber(sunsetTs, null);
  const sunrise = toFiniteNumber(sunriseTs, null);
  const now = toFiniteNumber(nowTs, null);

  if (sunset == null || sunrise == null || now == null || sunrise <= sunset) {
    return automationMin;
  }
  if (now <= sunset) return automationMin;
  if (now >= sunrise) return globalMin;

  const progress = (now - sunset) / (sunrise - sunset);
  return automationMin - ((automationMin - globalMin) * progress);
}

export function filterFreeAutomationSlots({ slots = [], occupiedWindows = [] }) {
  if (!Array.isArray(slots)) return [];

  return slots.filter((slot) => !occupiedWindows.some((window) => {
    const startTs = toFiniteNumber(window?.startTs, null);
    const endTs = toFiniteNumber(window?.endTs, null);
    const slotTs = toFiniteNumber(slot?.ts, null);
    if (slotTs == null || startTs == null || endTs == null) return false;
    return slotTs >= startTs && slotTs < endTs;
  }));
}

export function filterSlotsByTimeWindow({
  slots = [],
  searchWindowStart,
  searchWindowEnd,
  timeZone = 'Europe/Berlin'
} = {}) {
  const startMin = parseHHMM(searchWindowStart);
  const endMin = parseHHMM(searchWindowEnd);
  if (startMin == null || endMin == null) return [];

  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  return (Array.isArray(slots) ? slots : []).filter((slot) => {
    const ts = Number(slot?.ts);
    if (!Number.isFinite(ts)) return false;
    const minuteOfDay = dtf.formatToParts(new Date(ts));
    const hours = Number(minuteOfDay.find((part) => part.type === 'hour')?.value);
    const minutes = Number(minuteOfDay.find((part) => part.type === 'minute')?.value);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false;
    const slotMin = hours * 60 + minutes;
    if (startMin <= endMin) return slotMin >= startMin && slotMin < endMin;
    return slotMin >= startMin || slotMin < endMin;
  });
}

/**
 * Compute the absolute timestamp bounds [startTs, endTs) of the next search period
 * relative to `now`. For an overnight window like 14:00→09:00, this returns
 * today 14:00 → tomorrow 09:00 if now < today 09:00 or now >= today 14:00,
 * otherwise tomorrow 14:00 → day-after 09:00.
 * For a same-day window like 09:00→14:00, it returns the next occurrence of that window.
 */
export function computeNextPeriodBounds({
  now,
  searchWindowStart,
  searchWindowEnd,
  timeZone = 'Europe/Berlin'
} = {}) {
  const startMin = parseHHMM(searchWindowStart);
  const endMin = parseHHMM(searchWindowEnd);
  if (startMin == null || endMin == null || !Number.isFinite(now)) return null;

  // Get the local date components for `now`
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const parts = dtf.formatToParts(new Date(now));
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if ([year, month, day, hour, minute].some((v) => !Number.isFinite(v))) return null;
  const nowMin = hour * 60 + minute;

  // Helper: create a timestamp for a given local date + minutes-of-day
  function localToTs(y, m, d, minuteOfDay) {
    const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
    const mm = String(minuteOfDay % 60).padStart(2, '0');
    // Build a date string and compute offset for the timezone
    const refDate = new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${hh}:${mm}:00Z`);
    const localParts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    }).format(refDate);
    const [dPart, tPart] = localParts.split(', ');
    const [dd, mm2, yyyy] = dPart.split('/');
    const localRef = new Date(`${yyyy}-${mm2}-${dd}T${tPart}Z`);
    const offsetMs = localRef.getTime() - refDate.getTime();
    return refDate.getTime() - offsetMs;
  }

  function addDays(y, m, d, count) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + count);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  const isOvernight = startMin > endMin;

  if (isOvernight) {
    // Window spans midnight, e.g. 14:00 → 09:00
    // Period A: today startMin → tomorrow endMin
    // Period B: tomorrow startMin → day-after endMin
    // We're in period A if now >= startMin today OR now < endMin today (which means period started yesterday)
    if (nowMin >= startMin) {
      // Period starts today at startMin, ends tomorrow at endMin
      const next = addDays(year, month, day, 1);
      return {
        startTs: localToTs(year, month, day, startMin),
        endTs: localToTs(next.y, next.m, next.d, endMin)
      };
    }
    if (nowMin < endMin) {
      // We're in the tail end of a period that started yesterday
      const prev = addDays(year, month, day, -1);
      return {
        startTs: localToTs(prev.y, prev.m, prev.d, startMin),
        endTs: localToTs(year, month, day, endMin)
      };
    }
    // now is between endMin and startMin — next period starts today at startMin
    const next = addDays(year, month, day, 1);
    return {
      startTs: localToTs(year, month, day, startMin),
      endTs: localToTs(next.y, next.m, next.d, endMin)
    };
  }

  // Same-day window, e.g. 09:00 → 14:00
  if (nowMin < endMin) {
    return {
      startTs: localToTs(year, month, day, startMin),
      endTs: localToTs(year, month, day, endMin)
    };
  }
  // Next occurrence is tomorrow
  const next = addDays(year, month, day, 1);
  return {
    startTs: localToTs(next.y, next.m, next.d, startMin),
    endTs: localToTs(next.y, next.m, next.d, endMin)
  };
}

/**
 * Split chronologically sorted slots into contiguous segments.
 * Two slots are contiguous when their timestamps differ by exactly slotDurationMs.
 */
export function splitIntoContiguousSegments(sortedSlots, slotDurationMs) {
  if (!Array.isArray(sortedSlots) || !sortedSlots.length) return [];
  const segments = [[sortedSlots[0]]];
  for (let i = 1; i < sortedSlots.length; i++) {
    const prevTs = toFiniteNumber(sortedSlots[i - 1]?.ts, 0);
    const curTs = toFiniteNumber(sortedSlots[i]?.ts, 0);
    if (curTs - prevTs === slotDurationMs) {
      segments[segments.length - 1].push(sortedSlots[i]);
    } else {
      segments.push([sortedSlots[i]]);
    }
  }
  return segments;
}

/**
 * Find the best contiguous window of exactly `chainLength` slots.
 * Slides each expanded chain over every contiguous segment, scores revenue
 * in chronological order (index-aligned), and picks the highest-revenue window.
 * This guarantees discharge/cooldown patterns stay intact.
 */
export function pickBestAutomationPlan({ slots = [], targetSlotCount = 0, chainOptions = [], slotDurationMs = 15 * 60 * 1000 }) {
  const ordered = (Array.isArray(slots) ? [...slots] : [])
    .filter((s) => s && toFiniteNumber(s?.ts, null) != null)
    .sort((a, b) => toFiniteNumber(a.ts, 0) - toFiniteNumber(b.ts, 0));

  const segments = splitIntoContiguousSegments(ordered, slotDurationMs);

  let bestPlan = {
    selectedSlotTimestamps: [],
    totalRevenueCt: -Infinity,
    chain: [],
    peakDischargeW: Infinity
  };

  for (const chainOption of Array.isArray(chainOptions) ? chainOptions : []) {
    const expanded = expandChainSlots(chainOption);
    const len = expanded.length;
    if (!len) continue;

    for (const segment of segments) {
      for (let i = 0; i + len <= segment.length; i++) {
        const window = segment.slice(i, i + len);

        const totalRevenueCt = window.reduce((sum, slot, index) => (
          sum + estimateSlotRevenueCt(slot, expanded[index]?.powerW)
        ), 0);
        const peakDischargeW = expanded.reduce((peak, entry) => (
          Math.max(peak, Math.abs(toFiniteNumber(entry?.powerW, 0)))
        ), 0);

        if (
          totalRevenueCt > bestPlan.totalRevenueCt
          || (totalRevenueCt === bestPlan.totalRevenueCt && peakDischargeW < bestPlan.peakDischargeW)
        ) {
          bestPlan = {
            selectedSlotTimestamps: window
              .map((slot) => slot?.ts)
              .filter((ts) => ts != null),
            totalRevenueCt,
            chain: cloneChain(chainOption),
            peakDischargeW
          };
        }
      }
    }
  }

  return bestPlan;
}

function cloneChain(chain = []) {
  return chain.map((entry) => ({
    powerW: toFiniteNumber(entry?.powerW, 0),
    slots: Math.max(0, toFiniteNumber(entry?.slots, 0))
  }));
}
