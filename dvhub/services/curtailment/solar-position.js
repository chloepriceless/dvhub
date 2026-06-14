// services/curtailment/solar-position.js -- deterministic closed-form solar
// elevation (NOAA algorithm). Pure: takes (lat, lon, Date) -> elevation in
// degrees. No Date.now, no iteration, no randomness — same input always yields
// the same output, which the curtailment calibration relies on for idempotency.
// Accuracy ~0.1-0.5°, far better than the elevation-band granularity needs.
// See .planning/T-CURTAIL-IRRADIANCE-DESIGN.md STEP 2.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;

/**
 * Solar elevation angle (degrees above the horizon) for a UTC instant.
 * Negative below the horizon (night). lon is +East.
 * @param {number} lat - latitude in degrees
 * @param {number} lon - longitude in degrees (+East)
 * @param {Date|number|string} when - UTC instant
 * @returns {number} elevation in degrees
 */
export function solarElevationDeg(lat, lon, when) {
  const date = when instanceof Date ? when : new Date(when);
  const t = date.getTime();
  if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) return NaN;

  // Day-of-year (1-based) and fractional UTC hour.
  const yearStartUtc = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((t - yearStartUtc) / DAY_MS) + 1;
  const hourUtc = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;

  // Fractional year (radians) — NOAA solar-calc formulation.
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (hourUtc - 12) / 24);

  // Equation of time (minutes).
  const eqTime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );

  // Solar declination (radians).
  const decl = 0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.001480 * Math.sin(3 * gamma);

  // True solar time (minutes). hourUtc is UTC, so the longitude term alone
  // shifts to local apparent time (no timezone offset).
  const timeOffset = eqTime + 4 * lon;
  const tst = hourUtc * 60 + timeOffset;

  // Hour angle (radians).
  const ha = (tst / 4 - 180) * RAD;

  const latR = lat * RAD;
  const cosZenith = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
  return 90 - zenith / RAD;
}

// Elevation-band boundaries (degrees). A sample's band is the index of the
// highest boundary it meets-or-exceeds. Bands keep angle-of-incidence + air-mass
// roughly constant within a (month, band) calibration bucket.
export const ELEV_BANDS = [0, 10, 20, 30, 40, 50];

/**
 * Band index (0..ELEV_BANDS.length-1) for an elevation; -1 if below the horizon.
 */
export function elevationBand(elevDeg) {
  if (!Number.isFinite(elevDeg) || elevDeg < ELEV_BANDS[0]) return -1;
  let band = 0;
  for (let i = 0; i < ELEV_BANDS.length; i++) {
    if (elevDeg >= ELEV_BANDS[i]) band = i;
  }
  return band;
}
