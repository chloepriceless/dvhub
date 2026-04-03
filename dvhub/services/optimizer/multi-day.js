// services/optimizer/multi-day.js -- Multi-day awareness for battery optimizer.
// Evaluates whether to hold battery energy for tomorrow based on PV forecast.
// Decision logic per D-31 (30% threshold) and D-32 (avoided cost vs feed-in).

/**
 * Assess whether to hold battery energy for tomorrow based on PV forecast.
 * Pure function -- no side effects, no external dependencies.
 *
 * Decision flow:
 *   1. Filter PV/load slots for tomorrow's time window
 *   2. If no tomorrow PV data: return no_tomorrow_data (can't decide)
 *   3. Confidence guard (Pitfall 11): if avg PV confidence < 0.5, don't hold
 *   4. Low PV threshold (D-31): tomorrowPvKwh < 30% of battery capacity
 *   5. D-32 formula: compare avoided grid cost vs feed-in revenue
 *
 * @param {Array<{ts: number, endTs: number, powerW: number, confidence: number}>} pvSlots
 *   Normalized PV forecast slots (48h, epoch-ms timestamps)
 * @param {Array<{ts: number, endTs: number, powerW: number, confidence: number}>} loadSlots
 *   Normalized load forecast slots (48h, epoch-ms timestamps)
 * @param {number} batteryCapacityWh - Battery capacity in Wh
 * @param {number} feedInCtKwh - Current feed-in revenue in ct/kWh
 * @param {number} importCtKwh - Current grid import cost in ct/kWh
 * @param {number} roundTripEfficiency - Battery round-trip efficiency (e.g. 0.92)
 * @returns {{ holdBattery: boolean, reason: string, tomorrowPvKwh: number, tomorrowDeficitKwh: number }}
 */
export function assessMultiDayHold(pvSlots, loadSlots, batteryCapacityWh, feedInCtKwh, importCtKwh, roundTripEfficiency) {
  // Compute tomorrow's time window using Berlin timezone for day boundaries
  const now = new Date();
  // Get today's date string in Berlin timezone to derive correct day boundary
  const berlinDate = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }); // YYYY-MM-DD
  const todayBerlin = new Date(berlinDate + 'T00:00:00+01:00'); // approximate -- used for day boundary

  // More robust: compute end of today and start of tomorrow in local machine time
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  const tomorrowStart = todayEnd.getTime() + 1;
  const tomorrowEnd = tomorrowStart + 86_400_000;

  // Filter PV slots for tomorrow
  const tomorrowPvSlots = (pvSlots || []).filter(s => s.ts >= tomorrowStart && s.ts < tomorrowEnd);

  // No tomorrow PV data -- can't make a decision
  if (tomorrowPvSlots.length === 0) {
    return { holdBattery: false, reason: 'no_tomorrow_data', tomorrowPvKwh: 0, tomorrowDeficitKwh: 0 };
  }

  // Confidence guard (Pitfall 11): average confidence of tomorrow's PV slots
  let confidenceSum = 0;
  for (const s of tomorrowPvSlots) {
    confidenceSum += s.confidence;
  }
  const avgConfidence = confidenceSum / tomorrowPvSlots.length;

  // Sum PV energy for tomorrow
  let tomorrowPvWh = 0;
  for (const s of tomorrowPvSlots) {
    tomorrowPvWh += s.powerW * ((s.endTs - s.ts) / 3_600_000);
  }
  const tomorrowPvKwh = tomorrowPvWh / 1000;

  if (avgConfidence < 0.5) {
    return { holdBattery: false, reason: 'confidence_too_low', tomorrowPvKwh, tomorrowDeficitKwh: 0 };
  }

  // Sum load energy for tomorrow
  const tomorrowLoadSlots = (loadSlots || []).filter(s => s.ts >= tomorrowStart && s.ts < tomorrowEnd);
  let tomorrowLoadWh = 0;
  for (const s of tomorrowLoadSlots) {
    tomorrowLoadWh += s.powerW * ((s.endTs - s.ts) / 3_600_000);
  }
  const tomorrowLoadKwh = tomorrowLoadWh / 1000;

  const batteryCapacityKwh = batteryCapacityWh / 1000;

  // D-31: Low PV threshold -- < 30% of battery capacity
  const isLowPvDay = tomorrowPvKwh < batteryCapacityKwh * 0.3;

  if (!isLowPvDay) {
    return { holdBattery: false, reason: 'tomorrow_has_pv', tomorrowPvKwh, tomorrowDeficitKwh: 0 };
  }

  // Tomorrow's deficit: load that PV cannot cover
  const tomorrowDeficitKwh = Math.max(0, tomorrowLoadKwh - tomorrowPvKwh);

  // D-32: Compare avoided grid cost vs feed-in revenue
  // P(need) = probability battery energy will be needed tomorrow
  const pNeedTomorrow = Math.min(1, tomorrowDeficitKwh / batteryCapacityKwh);

  // avoidedCost = what we save by NOT importing from grid tomorrow
  // Factor in round-trip losses: energy stored -> discharged loses (1 - RT_eff)
  const avoidedCostPerKwh = importCtKwh * roundTripEfficiency * pNeedTomorrow;

  // Hold when avoided cost exceeds feed-in revenue
  const holdBattery = avoidedCostPerKwh > feedInCtKwh;

  return {
    holdBattery,
    reason: holdBattery ? 'tomorrow_low_pv_hold' : 'feed_in_more_profitable',
    tomorrowPvKwh,
    tomorrowDeficitKwh
  };
}
