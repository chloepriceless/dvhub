// services/optimizer/battery-model.js -- Linear SOC simulation per D-05/D-06/D-07.
// Provides enriched return shape with appliedPowerW and clipReason for downstream
// feasibility adjustment (schedule-eval integration).

/**
 * Simulate SOC trajectory over a time horizon.
 *
 * Positive powerW = charge, negative powerW = discharge.
 * Round-trip efficiency is split equally between charge and discharge:
 *   effCharge = sqrt(roundTripEfficiency)
 *   effDischarge = sqrt(roundTripEfficiency)
 *
 * @param {object} params
 * @param {number} params.initialSocPct - Current battery SOC (0-100)
 * @param {number} params.capacityWh - Battery capacity in Wh (e.g. 10000)
 * @param {number} [params.roundTripEfficiency=0.92] - 0.0-1.0 (e.g. 0.92 for LiFePO4)
 * @param {number} [params.maxChargeW=3000] - Max charge power in W
 * @param {number} [params.maxDischargeW=3000] - Max discharge power in W (positive value)
 * @param {number} [params.minSocPct=10] - Minimum allowed SOC %
 * @param {number} [params.maxSocPct=100] - Maximum allowed SOC %
 * @param {Array<{ts: number, powerW: number, dtHours: number}>} [params.schedule=[]] - Schedule steps
 * @returns {Array<{ts: number, socPct: number, powerW: number, appliedPowerW: number, clipReason: string|null}>}
 *   Per time step: ts, socPct (rounded 1 decimal), powerW (requested after power clipping),
 *   appliedPowerW (actual power after ALL clipping), clipReason (null | 'power_max' | 'soc_min' | 'soc_max')
 */
export function simulateSoc({
  initialSocPct,
  capacityWh,
  roundTripEfficiency = 0.92,
  maxChargeW = 3000,
  maxDischargeW = 3000,
  minSocPct = 10,
  maxSocPct = 100,
  schedule = []
} = {}) {
  const effCharge = Math.sqrt(roundTripEfficiency);
  const effDischarge = Math.sqrt(roundTripEfficiency);

  let socWh = (initialSocPct / 100) * capacityWh;
  const trajectory = [];

  for (const step of schedule) {
    let powerW = step.powerW;
    let clipReason = null;

    // Step 1: Clip powerW to [-maxDischargeW, maxChargeW]
    if (powerW > maxChargeW) {
      powerW = maxChargeW;
      clipReason = 'power_max';
    }
    if (powerW < -maxDischargeW) {
      powerW = -maxDischargeW;
      clipReason = 'power_max';
    }

    // Step 2: Apply efficiency to compute energy delta
    let energyWh;
    if (powerW > 0) {
      energyWh = powerW * step.dtHours * effCharge;     // Charging
    } else if (powerW < 0) {
      energyWh = powerW * step.dtHours / effDischarge;  // Discharging (powerW is negative)
    } else {
      energyWh = 0;
    }

    let newSocWh = socWh + energyWh;

    // Step 3: Clip to SOC bounds
    const minWh = (minSocPct / 100) * capacityWh;
    const maxWh = (maxSocPct / 100) * capacityWh;

    let appliedPowerW = powerW;

    if (newSocWh > maxWh) {
      // Step 4: Back-calculate appliedPowerW from actual delta SOC
      const actualDeltaWh = maxWh - socWh;
      if (step.dtHours > 0 && effCharge > 0) {
        appliedPowerW = actualDeltaWh / (step.dtHours * effCharge);
      }
      newSocWh = maxWh;
      clipReason = 'soc_max';
    }

    if (newSocWh < minWh) {
      // Step 4: Back-calculate appliedPowerW from actual delta SOC (discharge)
      const actualDeltaWh = minWh - socWh; // negative value
      if (step.dtHours > 0 && effDischarge > 0) {
        appliedPowerW = actualDeltaWh * effDischarge / step.dtHours;
      }
      newSocWh = minWh;
      clipReason = 'soc_min';
    }

    socWh = newSocWh;

    trajectory.push({
      ts: step.ts,
      socPct: Math.round((socWh / capacityWh) * 1000) / 10,
      powerW,
      appliedPowerW,
      clipReason
    });
  }

  return trajectory;
}
