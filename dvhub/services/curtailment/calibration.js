// services/curtailment/calibration.js -- empirical PV power <-> global irradiance
// calibration engine. PURE + DETERMINISTIC (no Date.now, no randomness, fixed
// summation order) so re-running over the same samples yields byte-identical
// slopes — the idempotency contract of the curtailment estimator.
//
// Method (see .planning/T-CURTAIL-IRRADIANCE-DESIGN.md §4):
//   - Calibrate on CLEAN samples (caller restricts to days with no negative-price
//     slot = unthrottled). Fit a zero-intercept line  y_norm = slope * GHI  per
//     (array, month, elevation-band) bin. Zero intercept is physical (no sun ->
//     no power) and stabilises small bins.
//   - Exclude inverter-CLIPPED samples from the fit (they sit on the AC plateau
//     and bias the slope down); cap estimates at P_ac_rated when applying.
//   - Per-kWp + temperature normalisation so bins with different module temps /
//     plant sizes are comparable.
//   - One deterministic MAD outlier pass (partial cloud / soiling), no iterative
//     RANSAC.

// --- tunable knobs (fixed constants, never time-derived) ---
export const MIN_SLOTS_PER_BIN = 20;   // below this a bin is "untrusted" -> caller falls back
export const GHI_MIN_FIT = 50;         // W/m² — ignore near-dark slots in the fit
export const CLIP_FRACTION = 0.98;     // actualW >= CLIP_FRACTION*P_ac_rated => treated as clipped
export const CLIP_PERCENTILE = 0.99;   // P_ac_rated estimate = 99th pct of clean actualW
export const TEMP_REF_C = 25;          // STC cell temperature
export const TEMP_COEFF = -0.004;      // /°C — crystalline-Si power temp coefficient
export const MAD_K = 3;                // outlier cut at K * median-absolute-deviation
// --- upper-envelope fit (T-CURTAIL fix 2026-06-14) ------------------------
// The clean-day reference is NOT truly unthrottled: the plant is curtailed by
// the Direktvermarkter / §51 / battery-full self-limiting on many days that
// carry no negative EPEX spot price, AND the plant grew ~4x over the data
// window — so a least-squares MEAN fit converges on the throttled/small-plant
// majority and the MAD pass discards the few full-output slots as "outliers",
// collapsing the slope (summer bins fell to 0.07–0.35 vs a healthy ~0.8). We
// instead fit the slope to the UPPER ENVELOPE of the per-slot ratios
// actualW/(GHI·kWp·derate) — the plant's demonstrated CAPABILITY — which is
// robust to both throttling and the size change (the high ratios are the
// recent full-size unthrottled slots). See .planning/T-CURTAIL-IRRADIANCE-DESIGN.md.
export const ENV_PERCENTILE = 0.85;    // slope = this percentile of per-slot ratios
export const ENV_GHI_MIN = 200;        // W/m² floor for ratio points (low-GHI ratios are diffuse-inflated)
export const SLOPE_MAX = 1.0;          // physical ceiling — AC power / (GHI·kWp_DC) cannot exceed ~1

/** Deterministic median of a numeric array (does not mutate input). */
export function median(arr) {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Nearest-rank percentile p in [0,1] of a numeric array. Deterministic. */
export function percentile(arr, p) {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[idx];
}

/** NOCT-proxy cell temperature from ambient + irradiance. */
export function cellTempC(ambientC, ghi) {
  return ambientC + 25 * (ghi / 1000);
}

/**
 * Power temperature-derate factor (<=1 when hot). Returns 1 when ambient is
 * unknown. Clamped to a sane band so a bad reading can't blow up an estimate.
 */
export function tempDerate(ambientC, ghi) {
  if (!Number.isFinite(ambientC)) return 1;
  const d = 1 + TEMP_COEFF * (cellTempC(ambientC, ghi) - TEMP_REF_C);
  return Math.max(0.5, Math.min(1.2, d));
}

/**
 * Fit y = slope*x (zero intercept) with one MAD outlier-removal pass.
 * Summation is over ts-sorted points so the float result is reproducible.
 * @param {Array<{ts:number,x:number,y:number}>} pts
 * @returns {{slope:number|null, n:number}}
 */
export function fitZeroIntercept(pts) {
  if (!Array.isArray(pts) || pts.length === 0) return { slope: null, n: 0 };
  const s = pts.slice().sort((a, b) => (a.ts - b.ts) || (a.x - b.x) || (a.y - b.y));
  let sxx = 0, sxy = 0;
  for (const p of s) { sxx += p.x * p.x; sxy += p.x * p.y; }
  if (sxx === 0) return { slope: null, n: s.length };
  const slope1 = sxy / sxx;

  // MAD outlier cut on residuals.
  const resids = s.map(p => p.y - slope1 * p.x);
  const medR = median(resids);
  const mad = median(resids.map(r => Math.abs(r - medR)));
  let survivors = s;
  if (Number.isFinite(mad) && mad > 0) {
    survivors = s.filter((p, i) => Math.abs(resids[i] - medR) <= MAD_K * mad);
  }
  if (survivors.length === 0) return { slope: slope1, n: 0 };

  let sxx2 = 0, sxy2 = 0;
  for (const p of survivors) { sxx2 += p.x * p.x; sxy2 += p.x * p.y; }
  if (sxx2 === 0) return { slope: slope1, n: survivors.length };
  return { slope: sxy2 / sxx2, n: survivors.length };
}

/**
 * Fit y = slope*x to the UPPER ENVELOPE of per-point ratios y/x (each point is
 * its own slope estimate; the high percentile = the plant's demonstrated
 * capability, ignoring throttled/under-sized low points). Deterministic.
 * Points below ENV_GHI_MIN are excluded from the ratio (low-GHI ratios are
 * diffuse-inflated) but still count toward n (bin trust). Falls back to all
 * positive-x points if the GHI floor leaves too few.
 * @param {Array<{ts:number,x:number,y:number}>} pts
 * @param {object} [opts] - { pEnv, ghiMin, slopeMax }
 * @returns {{slope:number|null, n:number}}
 */
export function fitUpperEnvelope(pts, opts = {}) {
  if (!Array.isArray(pts) || pts.length === 0) return { slope: null, n: 0 };
  const pEnv = opts.pEnv ?? ENV_PERCENTILE;
  const ghiMin = opts.ghiMin ?? ENV_GHI_MIN;
  const slopeMax = opts.slopeMax ?? SLOPE_MAX;
  let ratios = [];
  for (const p of pts) {
    if (p.x >= ghiMin && p.x > 0 && Number.isFinite(p.y) && p.y >= 0) ratios.push(p.y / p.x);
  }
  if (ratios.length < 5) {
    ratios = [];
    for (const p of pts) { if (p.x > 0 && Number.isFinite(p.y) && p.y >= 0) ratios.push(p.y / p.x); }
  }
  if (ratios.length === 0) return { slope: null, n: pts.length };
  let slope = percentile(ratios, pEnv);
  if (!Number.isFinite(slope)) return { slope: null, n: pts.length };
  if (slope > slopeMax) slope = slopeMax;
  return { slope, n: pts.length };
}

/** Stable bin key. */
export function binKeyFor(arrayId, month, elevBand) {
  return `${arrayId}|${month}|${elevBand}`;
}

/**
 * Calibrate per-(array, month, elevation-band) slopes from clean samples.
 * @param {Array<{ts:number,arrayId:string,ghi:number,actualW:number,kWp:number,ambientC:number|null,month:number,elevBand:number}>} samples
 * @param {object} [opts]
 * @returns {{bins: Map<string,{arrayId,month,elevBand,slope,n,trusted,pAcRated}>, pAcRatedByArray: Map<string,number>}}
 */
export function calibrate(samples, opts = {}) {
  const minSlots = opts.minSlotsPerBin ?? MIN_SLOTS_PER_BIN;
  const ghiMin = opts.ghiMinFit ?? GHI_MIN_FIT;
  const clipFrac = opts.clipFraction ?? CLIP_FRACTION;
  const clipPct = opts.clipPercentile ?? CLIP_PERCENTILE;
  const envPercentile = opts.envPercentile ?? ENV_PERCENTILE;

  // 1) P_ac_rated per array = high percentile of clean actualW (empirical AC cap).
  const byArray = new Map();
  for (const s of samples) {
    if (!byArray.has(s.arrayId)) byArray.set(s.arrayId, []);
    byArray.get(s.arrayId).push(s);
  }
  const pAcRatedByArray = new Map();
  for (const [arrayId, arr] of byArray) {
    pAcRatedByArray.set(arrayId, percentile(arr.map(s => s.actualW), clipPct));
  }

  // 2) bucket normalised points per bin, excluding clipped + near-dark.
  const buckets = new Map();
  for (const s of samples) {
    if (!Number.isFinite(s.ghi) || s.ghi < ghiMin) continue;
    if (!Number.isFinite(s.actualW) || !Number.isFinite(s.kWp) || s.kWp <= 0) continue;
    if (!Number.isFinite(s.elevBand) || s.elevBand < 0) continue;
    const pAc = pAcRatedByArray.get(s.arrayId);
    if (Number.isFinite(pAc) && pAc > 0 && s.actualW >= clipFrac * pAc) continue; // clipped
    const derate = tempDerate(s.ambientC, s.ghi);
    const yNorm = (s.actualW / s.kWp) / derate;
    const key = binKeyFor(s.arrayId, s.month, s.elevBand);
    if (!buckets.has(key)) buckets.set(key, { arrayId: s.arrayId, month: s.month, elevBand: s.elevBand, pts: [] });
    buckets.get(key).pts.push({ ts: s.ts, x: s.ghi, y: yNorm });
  }

  // 3) fit each bin to the upper envelope (demonstrated capability, robust to
  // throttling + the plant's size growth over the data window).
  const bins = new Map();
  for (const [key, b] of buckets) {
    const fit = fitUpperEnvelope(b.pts, { pEnv: envPercentile });
    bins.set(key, {
      arrayId: b.arrayId,
      month: b.month,
      elevBand: b.elevBand,
      slope: fit.slope,
      n: fit.n,
      trusted: fit.slope != null && fit.n >= minSlots,
      pAcRated: pAcRatedByArray.get(b.arrayId) ?? null,
    });
  }
  return { bins, pAcRatedByArray };
}

/**
 * Estimate the AC power the plant WOULD have produced at a given irradiance,
 * with temperature derate and an inverter-clipping cap. Returns null if inputs
 * are unusable; clamps to >= 0.
 * @param {{ghi:number, slope:number, kWp:number, ambientC?:number|null, pAcRated?:number|null}} args
 * @returns {number|null} watts
 */
export function estimateWouldHaveW({ ghi, slope, kWp, ambientC = null, pAcRated = null }) {
  if (!Number.isFinite(ghi) || !Number.isFinite(slope) || !Number.isFinite(kWp) || kWp <= 0) return null;
  let w = slope * ghi * kWp * tempDerate(ambientC, ghi);
  if (!Number.isFinite(w)) return null;
  if (w < 0) w = 0;
  if (Number.isFinite(pAcRated) && pAcRated > 0) w = Math.min(w, pAcRated);
  return w;
}
