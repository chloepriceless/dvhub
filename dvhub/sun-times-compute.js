// sun-times-compute.js -- NOAA Solar Calculator: deterministic sunrise/sunset
// computation from latitude/longitude + Julian date. No external dependencies.
//
// Formulas: NOAA "General Solar Position Calculations"
//   https://gml.noaa.gov/grad/solcalc/solareqns.PDF
// Accuracy: ±1 minute for temperate latitudes (|lat| < 60°), good for years 1900–2100.
// Refraction: zenith = 90.833° accounts for sun's apparent radius (16′)
// and atmospheric refraction at horizon (~34′).
//
// Returns ISO-UTC timestamps that the SMA planner consumes via Date.parse.

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const ZENITH_RAD = 90.833 * DEG_TO_RAD;

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function dayOfYearUTC(year, month, day) {
  const start = Date.UTC(year, 0, 1);
  const target = Date.UTC(year, month - 1, day);
  return Math.round((target - start) / 86400000) + 1;
}

/**
 * Compute sunrise and sunset (ISO-UTC strings) for a single calendar date and location.
 * Returns { sunriseTs, sunsetTs, polar } where polar is 'night' | 'day' | null.
 * For polar night/day (latitude > ~66.5° at solstices) the timestamps are null.
 */
export function computeSunriseSunset({ year, month, day, latitude, longitude }) {
  const N = dayOfYearUTC(year, month, day);
  const daysInYear = isLeapYear(year) ? 366 : 365;

  // Fractional year (radians), evaluated at solar noon (12:00 UT) for stability.
  const gamma = (2 * Math.PI / daysInYear) * (N - 1 + 0.5);

  // Equation of time (minutes) — Spencer (1971) Fourier series via NOAA.
  const eqtime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );

  // Solar declination (radians).
  const decl =
    0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma);

  const latRad = latitude * DEG_TO_RAD;

  // Hour angle for sun at zenith 90.833° (apparent horizon).
  const cosHa = (Math.cos(ZENITH_RAD) - Math.sin(latRad) * Math.sin(decl)) /
                (Math.cos(latRad) * Math.cos(decl));

  if (cosHa > 1)  return { sunriseTs: null, sunsetTs: null, polar: 'night' };
  if (cosHa < -1) return { sunriseTs: null, sunsetTs: null, polar: 'day' };

  const haDeg = Math.acos(cosHa) * RAD_TO_DEG;

  // Solar noon UTC, in minutes since midnight UTC of the requested date.
  const solarNoonMin = 720 - 4 * longitude - eqtime;
  const sunriseMin = solarNoonMin - 4 * haDeg;
  const sunsetMin = solarNoonMin + 4 * haDeg;

  const baseUTC = Date.UTC(year, month - 1, day);
  return {
    sunriseTs: new Date(baseUTC + Math.round(sunriseMin * 60000)).toISOString(),
    sunsetTs:  new Date(baseUTC + Math.round(sunsetMin  * 60000)).toISOString(),
    polar: null
  };
}

/**
 * Build a full-year (365/366 entries) sunrise/sunset cache for one location.
 * Keys are 'YYYY-MM-DD' UTC date strings; values are { sunriseTs, sunsetTs }.
 *
 * Note: the SMA planner looks up by Berlin-local date string. For Germany this
 * matches UTC date because sunrise/sunset never cross midnight UTC at
 * mid-latitudes — relevant only at extreme longitudes (irrelevant here).
 */
export function buildSunTimesYearCache({ year, latitude, longitude }) {
  const cache = {};
  const daysInYear = isLeapYear(year) ? 366 : 365;
  for (let n = 1; n <= daysInYear; n++) {
    const date = new Date(Date.UTC(year, 0, n));
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const key = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const sun = computeSunriseSunset({ year, month: m, day: d, latitude, longitude });
    cache[key] = { sunriseTs: sun.sunriseTs, sunsetTs: sun.sunsetTs };
  }
  return cache;
}
