// test/curtailment-calibration.test.js -- T-CURTAIL Increment 2a.
// Pure-math tests for the solar-position + calibration engine. No DB, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solarElevationDeg, elevationBand, ELEV_BANDS } from '../services/curtailment/solar-position.js';
import {
  calibrate, estimateWouldHaveW, fitZeroIntercept, fitUpperEnvelope, percentile, median, tempDerate, binKeyFor,
} from '../services/curtailment/calibration.js';

// --- solar position ---

test('solarElevationDeg: equator equinox solar-noon ~ 90°', () => {
  // 2025-03-20 (equinox), local solar noon at lon 0 ≈ 12:00 UTC.
  const elev = solarElevationDeg(0, 0, new Date('2025-03-20T12:00:00Z'));
  assert.ok(elev > 87 && elev <= 90.001, `expected ~90, got ${elev}`);
});

test('solarElevationDeg: 48.13°N summer-solstice noon ≈ 90-(lat-23.44)', () => {
  // Plant location (Baden-Württemberg). Solar noon ≈ 11:00 UTC at lon 9.43.
  const elev = solarElevationDeg(48.125611, 9.432794, new Date('2025-06-21T11:00:00Z'));
  const expected = 90 - (48.125611 - 23.44); // ≈ 65.3
  assert.ok(Math.abs(elev - expected) < 2, `expected ~${expected.toFixed(1)}, got ${elev.toFixed(1)}`);
});

test('solarElevationDeg: night is below horizon', () => {
  const elev = solarElevationDeg(48.13, 9.43, new Date('2025-06-21T00:00:00Z'));
  assert.ok(elev < 0, `expected night < 0, got ${elev}`);
});

test('solarElevationDeg: deterministic — same input, same output', () => {
  const a = solarElevationDeg(48.13, 9.43, new Date('2025-06-21T11:00:00Z'));
  const b = solarElevationDeg(48.13, 9.43, new Date('2025-06-21T11:00:00Z'));
  assert.equal(a, b);
});

test('elevationBand: boundaries map to the right band; night -> -1', () => {
  assert.equal(elevationBand(-5), -1);
  assert.equal(elevationBand(0), 0);
  assert.equal(elevationBand(9.9), 0);
  assert.equal(elevationBand(10), 1);
  assert.equal(elevationBand(55), ELEV_BANDS.length - 1);
  assert.equal(elevationBand(89), ELEV_BANDS.length - 1);
});

// --- helpers ---

test('median / percentile: deterministic, non-mutating', () => {
  const arr = [5, 1, 3, 2, 4];
  assert.equal(median(arr), 3);
  assert.equal(percentile(arr, 0.99), 5);
  assert.equal(percentile(arr, 0.5), 3);
  assert.deepEqual(arr, [5, 1, 3, 2, 4]); // input untouched
});

test('tempDerate: 1 when ambient unknown; <1 when hot; clamped', () => {
  assert.equal(tempDerate(null, 800), 1);
  assert.ok(tempDerate(35, 1000) < 1);   // hot cell -> derate below 1
  assert.ok(tempDerate(35, 1000) >= 0.5);
});

// --- fit ---

test('fitZeroIntercept: exact line y=5x -> slope 5', () => {
  const pts = [];
  for (let x = 50; x <= 1000; x += 50) pts.push({ ts: x, x, y: 5 * x });
  const { slope, n } = fitZeroIntercept(pts);
  assert.ok(Math.abs(slope - 5) < 1e-9, `slope ${slope}`);
  assert.equal(n, pts.length);
});

test('fitZeroIntercept: a gross outlier is removed by the MAD pass', () => {
  const pts = [];
  for (let x = 50; x <= 1000; x += 25) pts.push({ ts: x, x, y: 5 * x });
  pts.push({ ts: 9999, x: 500, y: 50000 }); // wild outlier (y=100x)
  const { slope } = fitZeroIntercept(pts);
  assert.ok(Math.abs(slope - 5) < 0.1, `outlier not rejected, slope ${slope}`);
});

test('fitUpperEnvelope: throttled MAJORITY + unthrottled minority -> recovers the capability slope', () => {
  // 70% of clean-day slots are throttled (ratio ~0.2); 30% ran at full output
  // (ratio 0.8 — the "what the plant would have produced" we want to recover).
  const pts = [];
  for (let i = 0; i < 70; i++) { const x = 300 + i * 8; pts.push({ ts: i, x, y: 0.2 * x }); }       // throttled
  for (let i = 0; i < 30; i++) { const x = 300 + i * 8; pts.push({ ts: 100 + i, x, y: 0.8 * x }); }  // full output
  // A MEAN fit would land near 0.2*0.7 + 0.8*0.3 ≈ 0.38 and the MAD pass would
  // discard the 0.8 cluster as outliers; the envelope keeps it.
  const env = fitUpperEnvelope(pts);
  assert.ok(env.slope > 0.7, `envelope slope too low: ${env.slope}`);
  const mean = fitZeroIntercept(pts);
  assert.ok(mean.slope < 0.5, `control: mean fit should sit low, got ${mean.slope}`);
});

test('fitUpperEnvelope: caps the slope at SLOPE_MAX (diffuse-inflated low-GHI ratios)', () => {
  const pts = [];
  for (let i = 0; i < 30; i++) { const x = 250 + i * 10; pts.push({ ts: i, x, y: 1.6 * x }); } // ratio 1.6
  const env = fitUpperEnvelope(pts);
  assert.ok(env.slope <= 1.0 + 1e-9, `slope not capped: ${env.slope}`);
});

// --- calibrate / estimate ---

function makeCleanSamples({ slope = 0.8, kWp = 10, month = 6, elevBand = 4, n = 40, pAc = 8200 }) {
  // Realistic units: y_norm = actualW/kWp ≈ slope*GHI with slope ~0.8 (≈ a plant
  // performance ratio). actualW = slope*GHI*kWp, capped at the inverter pAc.
  const out = [];
  for (let i = 0; i < n; i++) {
    const ghi = 100 + (i * 900) / n; // 100..1000
    let actualW = slope * ghi * kWp;
    if (actualW > pAc) actualW = pAc; // simulate inverter clipping
    out.push({ ts: i, arrayId: 'a', ghi, actualW, kWp, ambientC: null, month, elevBand });
  }
  return out;
}

test('calibrate: recovers the slope in a populated bin; bin is trusted', () => {
  const samples = makeCleanSamples({ slope: 0.8, kWp: 10, n: 40 });
  const { bins, pAcRatedByArray } = calibrate(samples);
  const bin = bins.get(binKeyFor('a', 6, 4));
  assert.ok(bin, 'bin exists');
  assert.equal(bin.trusted, true);
  assert.ok(Math.abs(bin.slope - 0.8) < 0.05, `slope ${bin.slope}`);
  assert.ok(pAcRatedByArray.get('a') > 0);
});

test('calibrate: a sparse bin is untrusted (< MIN_SLOTS_PER_BIN)', () => {
  const samples = makeCleanSamples({ n: 5 });
  const { bins } = calibrate(samples);
  const bin = bins.get(binKeyFor('a', 6, 4));
  assert.equal(bin.trusted, false);
});

test('calibrate: DETERMINISTIC — two runs give identical slopes', () => {
  const samples = makeCleanSamples({ n: 40 });
  const r1 = calibrate(samples);
  const r2 = calibrate(samples);
  const k = binKeyFor('a', 6, 4);
  assert.equal(r1.bins.get(k).slope, r2.bins.get(k).slope);
  assert.equal(r1.pAcRatedByArray.get('a'), r2.pAcRatedByArray.get('a'));
});

test('estimateWouldHaveW: linear below the cap, clamped at P_ac_rated', () => {
  const slope = 0.8, kWp = 10, pAcRated = 5000;
  // low irradiance -> linear (0.8*100*10 = 800)
  assert.ok(Math.abs(estimateWouldHaveW({ ghi: 100, slope, kWp, pAcRated }) - 800) < 1);
  // high irradiance -> clipped at cap (0.8*1000*10 = 8000 -> capped to 5000)
  assert.equal(estimateWouldHaveW({ ghi: 1000, slope, kWp, pAcRated }), 5000);
  // negative/garbage guards
  assert.equal(estimateWouldHaveW({ ghi: NaN, slope, kWp, pAcRated }), null);
});
