function toFiniteNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

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
