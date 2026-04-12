// services/optimizer/milp-battery-optimizer.js -- Tier 2+ MILP battery optimizer (D-03).
// Produces globally optimal 48h battery schedule using HiGHS solver with native 15min resolution.
// Preserves individual 15min price peaks for optimal slot selection.
// Uses importCtKwh from cost-model enrichment (falls back to ctKwh for backward compat).

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
 * Formulates a linear program with native 15min resolution:
 * - Decision variables: charge_t, discharge_t per 15min slot
 * - State variable: soc_t tracking battery energy
 * - Objective: Minimize total grid cost over the horizon
 * - Constraints: SOC dynamics, SOC bounds, power limits, grid permissions
 *
 * @param {object} params
 * @param {Array<{ts: number, endTs: number, ctKwh: number, confidence: number}>} params.priceSlots - 15min price slots
 * @param {Array<{ts: number, endTs: number, powerW: number, confidence: number}>} params.pvSlots - 15min PV slots
 * @param {Array<{ts: number, endTs: number, powerW: number, confidence: number}>} params.loadSlots - 1h load slots (interpolated to 15min)
 * @param {object} params.batteryModel - Battery parameters
 * @param {object} params.confidenceGate - Confidence-adjusted parameters
 * @returns {Promise<Array<{ts: number, endTs: number, powerW: number, confidence: number}>|null>}
 *   Array of 15min slots or null if HiGHS unavailable
 */
export async function buildMilpSchedule({ priceSlots, pvSlots, loadSlots, batteryModel, confidenceGate, allowGridCharge = false, allowGridDischarge = false }) {
  const solver = await getHiGHS();
  if (!solver) return null;

  if (!priceSlots || priceSlots.length === 0) return [];

  // Native 15min resolution — no aggregation, preserves individual price peaks
  const N = Math.min(priceSlots.length, 192); // Max 48h × 4 = 192 quarter-hour slots
  if (N === 0) return [];

  // Battery parameters
  const { capacityWh, maxSocPct, maxChargeW, maxDischargeW, currentSocPct } = batteryModel;
  const minSocPct = confidenceGate.minSocPct;
  const eff = Math.sqrt(0.92); // sqrt of round-trip efficiency
  const dt = 0.25; // 0.25 hours per 15min slot

  const minSocWh = (minSocPct / 100) * capacityWh;
  const maxSocWh = (maxSocPct / 100) * capacityWh;
  const currentSocWh = (currentSocPct / 100) * capacityWh;

  // Helper: find matching PV slot by timestamp overlap
  function getPv(t) {
    const ts = priceSlots[t]?.ts;
    if (ts == null) return 0;
    const slot = pvSlots.find(s => s.ts <= ts && s.endTs > ts);
    return slot ? slot.powerW : 0;
  }

  // Helper: find matching load for a 15min price slot.
  // Load slots are 1h — all 15min slots within the same hour share the load value.
  function getLoad(t) {
    const ts = priceSlots[t]?.ts;
    if (ts == null) return 0;
    const slot = loadSlots.find(s => s.ts <= ts && (s.endTs || (s.ts + 3_600_000)) > ts);
    return slot ? slot.powerW : 0;
  }

  // Step 1: Build LP string (CPLEX format for HiGHS)
  // Variables: charge_t, discharge_t (continuous, bounded)
  //            soc_t (continuous, bounded)
  // Objective: Minimize SUM_t [ charge_t * importPrice_t * dt - discharge_t * feedInPrice_t * dt ]
  // Import price = cost of buying from grid (for charging decisions)
  // FeedIn price = revenue from selling to grid (for discharge decisions)
  // Using separate prices ensures the solver maximizes sell revenue at the
  // highest feed-in price, not just at times when import would be expensive.

  const objTerms = [];
  for (let t = 0; t < N; t++) {
    const importPrice = priceSlots[t].importCtKwh ?? priceSlots[t].ctKwh;
    const feedInPrice = priceSlots[t].feedInCtKwh ?? priceSlots[t].ctKwh;

    // charge_t: +importPrice * dt (cost of buying from grid to charge)
    // discharge_t: -feedInPrice * dt (revenue from selling to grid)
    const chargeCoeff = Math.round(importPrice * dt * 10000) / 10000;
    const dischargeCoeff = Math.round(-feedInPrice * dt * 10000) / 10000;

    if (chargeCoeff !== 0) objTerms.push(`${chargeCoeff >= 0 ? '+' : ''}${chargeCoeff} charge_${t}`);
    if (dischargeCoeff !== 0) objTerms.push(`${dischargeCoeff >= 0 ? '+' : ''}${dischargeCoeff} discharge_${t}`);
  }

  let lp = `Minimize\n obj: ${objTerms.join(' ')}\n`;
  lp += 'Subject To\n';

  // SOC dynamics constraints (15min resolution):
  // soc_0 = currentSocWh + charge_0 * dt * eff - discharge_0 * dt / eff
  // soc_t = soc_{t-1} + charge_t * dt * eff - discharge_t * dt / eff
  const effCharge = Math.round(eff * dt * 10000) / 10000;
  const effDischarge = Math.round(dt / eff * 10000) / 10000;

  // Initial SOC constraint
  lp += ` soc_init: soc_0 - ${effCharge} charge_0 + ${effDischarge} discharge_0 = ${currentSocWh}\n`;

  // SOC dynamics for t >= 1
  for (let t = 1; t < N; t++) {
    lp += ` soc_dyn_${t}: soc_${t} - soc_${t - 1} - ${effCharge} charge_${t} + ${effDischarge} discharge_${t} = 0\n`;
  }

  // Grid permission constraints
  if (!allowGridCharge) {
    for (let t = 0; t < N; t++) {
      const pv = getPv(t);
      const load = getLoad(t);
      const pvSurplus = Math.max(0, pv - load);
      // Charge limited to PV surplus (no grid charging)
      lp += ` grid_charge_${t}: charge_${t} <= ${Math.round(pvSurplus)}\n`;
    }
  }
  if (!allowGridDischarge) {
    for (let t = 0; t < N; t++) {
      const load = getLoad(t);
      // Discharge limited to load (self-consume only, no grid export)
      lp += ` grid_discharge_${t}: discharge_${t} <= ${Math.round(Math.max(0, load))}\n`;
    }
  }

  // Variable bounds
  lp += 'Bounds\n';
  for (let t = 0; t < N; t++) {
    lp += ` 0 <= charge_${t} <= ${maxChargeW}\n`;
    lp += ` 0 <= discharge_${t} <= ${confidenceGate.maxDischargeW}\n`;
    lp += ` ${minSocWh} <= soc_${t} <= ${maxSocWh}\n`;
  }

  lp += 'End\n';

  // Step 2: Solve with HiGHS (15s time limit — 4x more variables than 1h version)
  let solution;
  try {
    solution = solver.solve(lp, { time_limit: 15 });
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

  // Step 3: Extract results — already native 15min, no expansion needed
  const columns = solution.Columns || {};
  const result = [];

  for (let t = 0; t < N; t++) {
    const chargeW = columns[`charge_${t}`]?.Primal || 0;
    const dischargeW = columns[`discharge_${t}`]?.Primal || 0;

    // Net power: positive = charge, negative = discharge
    let powerW = 0;
    if (chargeW > 1) powerW = Math.round(chargeW);
    if (dischargeW > 1) powerW = -Math.round(dischargeW);

    // Skip near-zero slots
    if (Math.abs(powerW) < 1) continue;

    result.push({
      ts: priceSlots[t].ts,
      endTs: priceSlots[t].endTs,
      powerW,
      confidence: priceSlots[t].confidence
    });
  }

  return result;
}
