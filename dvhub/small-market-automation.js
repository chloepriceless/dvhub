function toFiniteNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

export const SLOT_DURATION_HOURS = 0.25; // 15 minutes

function expandChainSlots(chain = []) {
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

export function pickBestAutomationPlan({ slots = [], targetSlotCount = 0, chainOptions = [] }) {
  const normalizedTargetSlotCount = Math.max(0, toFiniteNumber(targetSlotCount, 0));
  const rankedSlots = Array.isArray(slots)
    ? [...slots].sort((left, right) => toFiniteNumber(right?.ct_kwh, 0) - toFiniteNumber(left?.ct_kwh, 0))
    : [];
  const candidateSlots = rankedSlots.slice(0, normalizedTargetSlotCount);
  const slotValueScore = candidateSlots.reduce((sum, slot) => sum + toFiniteNumber(slot?.ct_kwh, 0), 0);

  let bestPlan = {
    selectedSlotTimestamps: candidateSlots
      .map((slot) => slot?.ts)
      .filter((slotTs) => slotTs != null)
      .sort((left, right) => left - right),
    totalRevenueCt: -Infinity,
    chain: [],
    peakDischargeW: Infinity
  };

  for (const chainOption of Array.isArray(chainOptions) ? chainOptions : []) {
    const expandedChain = expandChainSlots(chainOption);
    if (!expandedChain.length || expandedChain.length !== candidateSlots.length) continue;

    const totalRevenueCt = candidateSlots.reduce((sum, slot, index) => (
      sum + estimateSlotRevenueCt(slot, expandedChain[index]?.powerW)
    ), 0);
    const peakDischargeW = expandedChain.reduce((peak, entry) => (
      Math.max(peak, Math.abs(toFiniteNumber(entry?.powerW, 0)))
    ), 0);

    if (
      totalRevenueCt > bestPlan.totalRevenueCt
      || (totalRevenueCt === bestPlan.totalRevenueCt && peakDischargeW < bestPlan.peakDischargeW)
    ) {
      bestPlan = {
        selectedSlotTimestamps: candidateSlots
          .map((slot) => slot?.ts)
          .filter((slotTs) => slotTs != null)
          .sort((left, right) => left - right),
        totalRevenueCt,
        chain: cloneChain(chainOption),
        peakDischargeW
      };
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
