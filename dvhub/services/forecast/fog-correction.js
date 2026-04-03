// fog-correction.js -- Nebel-Korrektur for Donau region (Riedlingen).
// Reduces PV forecast based on visibility from weather data.
// Thresholds based on Donau valley fog patterns.

/**
 * Apply fog correction for Donau region (Riedlingen).
 * Reduces PV forecast based on visibility from weather data.
 * @param {number} powerW - Forecasted PV power in watts
 * @param {number|null} visibilityM - Visibility in meters
 * @param {number|null} humidityPct - Relative humidity percentage
 * @returns {{ correctedW: number, fogFactor: number }}
 */
export function applyFogCorrection(powerW, visibilityM, humidityPct) {
  if (visibilityM == null || !Number.isFinite(visibilityM)) {
    return { correctedW: powerW, fogFactor: 1.0 };
  }

  let fogFactor = 1.0;

  if (visibilityM < 1000) {
    fogFactor = 0.2;  // -80%: dense fog
  } else if (visibilityM < 3000) {
    fogFactor = 0.5;  // -50%: moderate fog
  } else if (visibilityM < 5000 && humidityPct > 90) {
    fogFactor = 0.75; // -25%: light fog/mist with high humidity
  }

  return { correctedW: Math.round(powerW * fogFactor), fogFactor };
}
