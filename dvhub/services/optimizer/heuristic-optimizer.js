// services/optimizer/heuristic-optimizer.js -- Tier 1 rule-based greedy optimizer (D-03).
// Charges during cheapest hours, discharges during most expensive hours.
// Uses normalized forecast slots with { ts, endTs, ctKwh/powerW, confidence }.
// Uses appliedPowerW from simulateSoc for feasibility adjustment.
// Uses importCtKwh from cost-model enrichment (falls back to ctKwh for backward compat).

import { simulateSoc } from './battery-model.js';

/**
 * Build a heuristic (greedy) battery schedule from normalized forecast data.
 *
 * Algorithm:
 * 1. Find cheap slots (price < 70% of average) -- charge candidates
 * 2. Find expensive slots (price > 130% of average) -- discharge candidates (if allowSell)
 * 3. Skip charge slots where PV surplus > 500W (battery charges from PV naturally)
 * 4. Generate charge/discharge rules respecting battery model limits
 * 5. Validate with simulateSoc, adjust clipped slots using appliedPowerW
 *
 * @param {object} params
 * @param {Array<{ts: number, endTs: number, ctKwh: number, importCtKwh?: number, feedInCtKwh?: number, confidence: number}>} params.priceSlots - Normalized price slots (enriched with cost-model when available)
 * @param {Array<{ts: number, endTs: number, powerW: number, confidence: number}>} params.pvSlots - Normalized PV slots
 * @param {Array<{ts: number, endTs: number, powerW: number, confidence: number}>} params.loadSlots - Normalized load slots
 * @param {object} params.batteryModel - Battery parameters
 * @param {number} params.batteryModel.capacityWh - Battery capacity in Wh
 * @param {number} params.batteryModel.minSocPct - Min SOC %
 * @param {number} params.batteryModel.maxSocPct - Max SOC %
 * @param {number} params.batteryModel.maxChargeW - Max charge power in W
 * @param {number} params.batteryModel.maxDischargeW - Max discharge power in W
 * @param {number} params.batteryModel.currentSocPct - Current SOC %
 * @param {object} params.confidenceGate - Output of applyConfidenceGating()
 * @param {number} params.confidenceGate.minSocPct - Adjusted min SOC %
 * @param {number} params.confidenceGate.maxDischargeW - Adjusted max discharge W
 * @param {boolean} params.confidenceGate.allowSell - Whether discharge/sell is allowed
 * @param {number} params.confidenceGate.chargeWindowMultiplier - Charge window scaling factor
 * @param {boolean} [params.allowGridCharge=false] - Allow charging from grid (Netzladen)
 * @param {boolean} [params.allowGridDischarge=false] - Allow discharging to grid (Pauschaloption)
 * @returns {Array<{ts: number, endTs: number, powerW: number, confidence: number}>}
 */
export function buildHeuristicSchedule({ priceSlots, pvSlots, loadSlots, batteryModel, confidenceGate, allowGridCharge = false, allowGridDischarge = false }) {
  if (!priceSlots || priceSlots.length === 0) return [];

  // 1. Calculate average price (using importCtKwh from cost-model enrichment, fallback to ctKwh)
  let priceSum = 0;
  for (const s of priceSlots) priceSum += s.importCtKwh ?? s.ctKwh;
  const avgPrice = priceSum / priceSlots.length;

  // 2. Find cheap slots (< 70% of average), sorted cheapest first
  const cheapSlots = priceSlots
    .filter(s => (s.importCtKwh ?? s.ctKwh) < avgPrice * 0.7)
    .sort((a, b) => (a.importCtKwh ?? a.ctKwh) - (b.importCtKwh ?? b.ctKwh));

  // 3. Find expensive slots (> 130% of average), sorted most expensive first
  //    Grid discharge (Batterie→Netz) requires allowGridDischarge AND confidence gate
  //    Self-consume discharge (Batterie→Eigenverbrauch) is always allowed
  //    For feed-in revenue, use feedInCtKwh from cost-model enrichment (fallback to ctKwh)
  const canGridDischarge = allowGridDischarge && confidenceGate.allowSell;
  const expensiveSlots = priceSlots
    .filter(s => (s.importCtKwh ?? s.ctKwh) > avgPrice * 1.3)
    .sort((a, b) => {
      // For discharge sorting, use feedInCtKwh when available (feed-in tariff determines revenue)
      const aRevenue = canGridDischarge ? (a.feedInCtKwh ?? a.ctKwh) : (a.importCtKwh ?? a.ctKwh);
      const bRevenue = canGridDischarge ? (b.feedInCtKwh ?? b.ctKwh) : (b.importCtKwh ?? b.ctKwh);
      return bRevenue - aRevenue;
    });

  // Helper: find corresponding PV slot by matching ts range
  function findPvSlot(ts) {
    return pvSlots.find(pv => pv.ts <= ts && pv.endTs > ts);
  }

  const schedule = [];

  // 4. Generate charge rules for cheap slots
  //    Only create grid-charge rules if allowGridCharge is true
  //    PV-charge rules are never needed (Victron ESS handles PV→Battery natively)
  if (allowGridCharge) {
    const chargeW = Math.round(batteryModel.maxChargeW * confidenceGate.chargeWindowMultiplier);
    for (const slot of cheapSlots) {
      const pvSlot = findPvSlot(slot.ts);
      // Skip if PV surplus > 500W (battery charges from PV naturally)
      if (pvSlot && pvSlot.powerW > 500) continue;

      schedule.push({
        ts: slot.ts,
        endTs: slot.endTs,
        powerW: chargeW,  // Positive = charge from grid
        confidence: slot.confidence
      });
    }
  }

  // 5. Generate discharge rules for expensive slots
  for (const slot of expensiveSlots) {
    // Find expected load to cap discharge at self-consumption level
    const loadSlot = loadSlots.find(l => l.ts <= slot.ts && l.endTs > slot.ts);
    const expectedLoadW = loadSlot ? loadSlot.powerW : 0;

    if (canGridDischarge) {
      // Pauschaloption: discharge full power to grid (arbitrage)
      schedule.push({
        ts: slot.ts,
        endTs: slot.endTs,
        powerW: -confidenceGate.maxDischargeW,
        confidence: slot.confidence
      });
    } else if (expectedLoadW > 100) {
      // No Pauschaloption: discharge only for self-consumption (capped at load)
      const selfConsumeW = Math.min(confidenceGate.maxDischargeW, expectedLoadW);
      schedule.push({
        ts: slot.ts,
        endTs: slot.endTs,
        powerW: -selfConsumeW,  // Discharge capped at expected load
        confidence: slot.confidence
      });
    }
    // If no load expected and no grid discharge allowed: skip (no discharge)
  }

  // 6. Sort schedule by timestamp for SOC simulation
  schedule.sort((a, b) => a.ts - b.ts);

  if (schedule.length === 0) return [];

  // 7. Validate with simulateSoc -- use appliedPowerW for feasibility adjustment
  const simSchedule = schedule.map(s => ({
    ts: s.ts,
    powerW: s.powerW,
    dtHours: (s.endTs - s.ts) / 3600000
  }));

  const trajectory = simulateSoc({
    initialSocPct: batteryModel.currentSocPct,
    capacityWh: batteryModel.capacityWh,
    maxChargeW: batteryModel.maxChargeW,
    maxDischargeW: batteryModel.maxDischargeW,
    minSocPct: confidenceGate.minSocPct,
    maxSocPct: batteryModel.maxSocPct,
    schedule: simSchedule
  });

  // 8. Adjust clipped slots using appliedPowerW from enriched simulateSoc return
  const result = [];
  for (let i = 0; i < schedule.length; i++) {
    const sim = trajectory[i];
    const slot = schedule[i];

    // Use appliedPowerW if simulation clipped the power
    const adjustedPowerW = sim.clipReason != null ? sim.appliedPowerW : slot.powerW;

    // Skip slots where power was clipped to effectively zero
    if (Math.abs(adjustedPowerW) < 1) continue;

    result.push({
      ts: slot.ts,
      endTs: slot.endTs,
      powerW: Math.round(adjustedPowerW),
      confidence: slot.confidence
    });
  }

  return result;
}
