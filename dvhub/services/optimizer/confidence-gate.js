// services/optimizer/confidence-gate.js -- Confidence-based parameter adjustment (D-10).
// Linear interpolation between conservative and aggressive optimizer parameters
// based on forecast confidence level.

/**
 * Linear interpolation between two values.
 *
 * @param {number} a - Start value (t=0)
 * @param {number} b - End value (t=1)
 * @param {number} t - Interpolation factor 0.0-1.0
 * @returns {number} Interpolated value
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Apply confidence gating to optimizer parameters.
 * Adjusts battery parameters based on forecast confidence level:
 *   - confidence < 0.5: fully conservative (t=0)
 *   - confidence > 0.7: fully aggressive (t=1)
 *   - between: linear interpolation
 *
 * Conservative params protect against inaccurate forecasts:
 *   - Higher minSocPct (30% floor)
 *   - Reduced maxDischargeW (60% of base)
 *   - No grid selling
 *   - Smaller charge windows (70% multiplier)
 *
 * @param {object} baseParams - Base battery parameters from config
 * @param {number} baseParams.minSocPct - Configured minimum SOC %
 * @param {number} baseParams.maxSocPct - Configured maximum SOC %
 * @param {number} baseParams.maxChargeW - Configured max charge power W
 * @param {number} baseParams.maxDischargeW - Configured max discharge power W
 * @param {number} confidence - Average forecast confidence 0.0-1.0
 * @returns {{ minSocPct: number, maxDischargeW: number, allowSell: boolean, chargeWindowMultiplier: number }}
 */
export function applyConfidenceGating(baseParams, confidence) {
  // Linear interpolation factor: 0.5-0.7 range maps to 0-1
  const t = Math.max(0, Math.min(1, (confidence - 0.5) / 0.2));

  return {
    minSocPct: lerp(30, baseParams.minSocPct, t),
    maxDischargeW: lerp(baseParams.maxDischargeW * 0.6, baseParams.maxDischargeW, t),
    allowSell: t > 0.3,
    chargeWindowMultiplier: lerp(0.7, 1.0, t)
  };
}
