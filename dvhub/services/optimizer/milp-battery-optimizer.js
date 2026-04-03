// services/optimizer/milp-battery-optimizer.js -- Tier 2+ MILP battery optimizer (D-03).
// Produces globally optimal 48h battery schedule using HiGHS solver with 1h resolution.
// Aggregates 15min price/PV to 1h via aggregateTo1h, load slots pass through as-is.
// Results expanded back to 15min slots for schedule-builder compatibility.

import { aggregateTo1h } from './forecast-normalizer.js';

const QUARTER_MS = 15 * 60 * 1000;

let _highs = null;

/**
 * Lazy-init HiGHS solver. Returns null if unavailable (Tier 1 fallback).
 * @returns {Promise<object|null>}
 */
async function getHiGHS() {
  if (_highs) return _highs;
  try {
    const mod = await import('highs');
    _highs = await mod.default();
    return _highs;
  } catch (e) {
    console.error('HiGHS solver not available:', e.message);
    return null;
  }
}

/**
 * Build optimal battery schedule using MILP (Mixed Integer Linear Programming).
 *
 * Formulates a linear program with 1h resolution:
 * - Decision variables: charge_t, discharge_t per time slot
 * - State variable: soc_t tracking battery energy
 * - Objective: Minimize total grid cost over the horizon
 * - Constraints: SOC dynamics, SOC bounds, power limits
 *
 * @param {object} params
 * @param {Array<{ts: number, endTs: number, ctKwh: number, confidence: number}>} params.priceSlots - 15min price slots
 * @param {Array<{ts: number, endTs: number, powerW: number, confidence: number}>} params.pvSlots - 15min PV slots
 * @param {Array<{ts: number, endTs: number, powerW: number, confidence: number}>} params.loadSlots - 1h load slots
 * @param {object} params.batteryModel - Battery parameters
 * @param {object} params.confidenceGate - Confidence-adjusted parameters
 * @returns {Promise<Array<{ts: number, endTs: number, powerW: number, confidence: number}>|null>}
 *   Array of 15min slots or null if HiGHS unavailable
 */
export async function buildMilpSchedule({ priceSlots, pvSlots, loadSlots, batteryModel, confidenceGate }) {
  const solver = await getHiGHS();
  if (!solver) return null;

  if (!priceSlots || priceSlots.length === 0) return [];

  // Step 1: Aggregate 15min slots to 1h for MILP resolution
  const priceHourly = aggregateTo1h(priceSlots, 'ctKwh');
  const pvHourly = aggregateTo1h(pvSlots, 'powerW');
  // Load: already 1h, pass through
  const loadHourly = loadSlots;

  const N = Math.min(priceHourly.length, 48); // Max 48h horizon
  if (N === 0) return [];

  // Battery parameters
  const { capacityWh, maxSocPct, maxChargeW, maxDischargeW, currentSocPct } = batteryModel;
  const minSocPct = confidenceGate.minSocPct;
  const eff = Math.sqrt(0.92); // sqrt of round-trip efficiency
  const dt = 1; // 1 hour per slot

  const minSocWh = (minSocPct / 100) * capacityWh;
  const maxSocWh = (maxSocPct / 100) * capacityWh;
  const currentSocWh = (currentSocPct / 100) * capacityWh;

  // Helper: get hourly value with fallback
  function getLoad(t) {
    const slot = loadHourly.find(s => s.ts === priceHourly[t]?.ts);
    return slot ? slot.powerW : 0;
  }
  function getPv(t) {
    const slot = pvHourly.find(s => s.ts === priceHourly[t]?.ts);
    return slot ? slot.powerW : 0;
  }

  // Step 2: Build LP string (CPLEX format for HiGHS)
  // Variables: charge_t, discharge_t (continuous, bounded)
  //            soc_t (continuous, bounded)
  // Objective: Minimize SUM_t [ (load_t - pv_t + charge_t - discharge_t) * price_t * dt ]

  // Build objective
  const objTerms = [];
  for (let t = 0; t < N; t++) {
    const price = priceHourly[t].ctKwh;
    const load = getLoad(t);
    const pv = getPv(t);
    const netLoadCost = (load - pv) * price * dt; // Constant term (ignored by solver)

    // charge_t contributes +price * dt to cost (buying more from grid)
    // discharge_t contributes -price * dt to cost (selling/offsetting grid)
    const chargeCoeff = Math.round(price * dt * 1000) / 1000;
    const dischargeCoeff = Math.round(-price * dt * 1000) / 1000;

    if (chargeCoeff !== 0) objTerms.push(`${chargeCoeff >= 0 ? '+' : ''}${chargeCoeff} charge_${t}`);
    if (dischargeCoeff !== 0) objTerms.push(`${dischargeCoeff >= 0 ? '+' : ''}${dischargeCoeff} discharge_${t}`);
  }

  let lp = `Minimize\n obj: ${objTerms.join(' ')}\n`;
  lp += 'Subject To\n';

  // SOC dynamics constraints:
  // soc_0 = currentSocWh + charge_0 * dt * eff - discharge_0 * dt / eff
  // soc_t = soc_{t-1} + charge_t * dt * eff - discharge_t * dt / eff
  //
  // Rearranged as linear constraints:
  // soc_0 - eff*dt * charge_0 + (dt/eff) * discharge_0 = currentSocWh
  // soc_t - soc_{t-1} - eff*dt * charge_t + (dt/eff) * discharge_t = 0

  const effCharge = Math.round(eff * dt * 10000) / 10000;
  const effDischarge = Math.round(dt / eff * 10000) / 10000;

  // Initial SOC constraint
  lp += ` soc_init: soc_0 - ${effCharge} charge_0 + ${effDischarge} discharge_0 = ${currentSocWh}\n`;

  // SOC dynamics for t >= 1
  for (let t = 1; t < N; t++) {
    lp += ` soc_dyn_${t}: soc_${t} - soc_${t - 1} - ${effCharge} charge_${t} + ${effDischarge} discharge_${t} = 0\n`;
  }

  // Variable bounds
  lp += 'Bounds\n';
  for (let t = 0; t < N; t++) {
    lp += ` 0 <= charge_${t} <= ${maxChargeW}\n`;
    lp += ` 0 <= discharge_${t} <= ${confidenceGate.maxDischargeW}\n`;
    lp += ` ${minSocWh} <= soc_${t} <= ${maxSocWh}\n`;
  }

  lp += 'End\n';

  // Step 3: Solve with HiGHS (10s time limit per research pitfall 5)
  let solution;
  try {
    solution = solver.solve(lp, { time_limit: 10 });
  } catch (e) {
    console.error('MILP solve error:', e.message);
    return [];
  }

  // Check solution status
  const status = solution?.Status;
  if (status !== 'Optimal' && status !== 'Time') {
    // No feasible solution found
    return [];
  }

  // Step 4: Extract results from solution columns
  const columns = solution.Columns || {};
  const hourlyResults = [];

  for (let t = 0; t < N; t++) {
    const chargeW = columns[`charge_${t}`]?.Primal || 0;
    const dischargeW = columns[`discharge_${t}`]?.Primal || 0;

    // Net power: positive = charge, negative = discharge
    let powerW = 0;
    if (chargeW > 1) powerW = Math.round(chargeW);
    if (dischargeW > 1) powerW = -Math.round(dischargeW);

    // Skip near-zero slots
    if (Math.abs(powerW) < 1) continue;

    hourlyResults.push({
      ts: priceHourly[t].ts,
      endTs: priceHourly[t].endTs,
      powerW,
      confidence: priceHourly[t].confidence
    });
  }

  // Step 5: Expand 1h results to 15min slots
  const result = [];
  for (const hourSlot of hourlyResults) {
    for (let q = 0; q < 4; q++) {
      const quarterTs = hourSlot.ts + q * QUARTER_MS;
      result.push({
        ts: quarterTs,
        endTs: quarterTs + QUARTER_MS,
        powerW: hourSlot.powerW,
        confidence: hourSlot.confidence
      });
    }
  }

  return result;
}
