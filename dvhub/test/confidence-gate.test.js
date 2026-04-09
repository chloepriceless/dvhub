import test from 'node:test';
import assert from 'node:assert/strict';

import { applyConfidenceGating, lerp } from '../services/optimizer/confidence-gate.js';

const BASE_PARAMS = {
  minSocPct: 10,
  maxSocPct: 100,
  maxChargeW: 3000,
  maxDischargeW: 3000
};

// --- Test 9: confidence 0.3 (below 0.5) returns fully conservative ---
test('applyConfidenceGating: confidence 0.3 returns fully conservative params', () => {
  const result = applyConfidenceGating(BASE_PARAMS, 0.3);

  assert.equal(result.minSocPct, 30);
  assert.equal(result.maxDischargeW, 3000 * 0.6);
  assert.equal(result.allowSell, false);
  assert.equal(result.chargeWindowMultiplier, 0.7);
});

// --- Test 10: confidence 0.8 (above 0.7) returns fully aggressive ---
test('applyConfidenceGating: confidence 0.8 returns fully aggressive params', () => {
  const result = applyConfidenceGating(BASE_PARAMS, 0.8);

  assert.equal(result.minSocPct, BASE_PARAMS.minSocPct);
  assert.equal(result.maxDischargeW, BASE_PARAMS.maxDischargeW);
  assert.equal(result.allowSell, true);
  assert.equal(result.chargeWindowMultiplier, 1.0);
});

// --- Test 11: confidence 0.6 (midpoint) returns interpolated params ---
test('applyConfidenceGating: confidence 0.6 returns interpolated params', () => {
  // t = (0.6 - 0.5) / 0.2 = 0.5
  const result = applyConfidenceGating(BASE_PARAMS, 0.6);

  // minSocPct: lerp(30, 10, 0.5) = 20
  assert.equal(result.minSocPct, 20);
  // maxDischargeW: lerp(3000*0.6, 3000, 0.5) = lerp(1800, 3000, 0.5) = 2400
  assert.equal(result.maxDischargeW, 2400);
  // allowSell: t > 0.3 => 0.5 > 0.3 => true
  assert.equal(result.allowSell, true);
  // chargeWindowMultiplier: lerp(0.7, 1.0, 0.5) = 0.85
  assert.ok(Math.abs(result.chargeWindowMultiplier - 0.85) < 0.001);
});

// --- Test 12: confidence 0.0 returns fully conservative (clamped) ---
test('applyConfidenceGating: confidence 0.0 returns fully conservative', () => {
  const result = applyConfidenceGating(BASE_PARAMS, 0.0);

  assert.equal(result.minSocPct, 30);
  assert.equal(result.maxDischargeW, 3000 * 0.6);
  assert.equal(result.allowSell, false);
  assert.equal(result.chargeWindowMultiplier, 0.7);
});

// --- Test 13: confidence 1.0 returns fully aggressive (clamped) ---
test('applyConfidenceGating: confidence 1.0 returns fully aggressive', () => {
  const result = applyConfidenceGating(BASE_PARAMS, 1.0);

  assert.equal(result.minSocPct, BASE_PARAMS.minSocPct);
  assert.equal(result.maxDischargeW, BASE_PARAMS.maxDischargeW);
  assert.equal(result.allowSell, true);
  assert.equal(result.chargeWindowMultiplier, 1.0);
});

// --- Test 14: chargeWindowMultiplier interpolates from 0.7 to 1.0 ---
test('applyConfidenceGating: chargeWindowMultiplier interpolates from 0.7 to 1.0', () => {
  // t=0 (confidence < 0.5): multiplier = 0.7
  const conservative = applyConfidenceGating(BASE_PARAMS, 0.4);
  assert.equal(conservative.chargeWindowMultiplier, 0.7);

  // t=1 (confidence > 0.7): multiplier = 1.0
  const aggressive = applyConfidenceGating(BASE_PARAMS, 0.75);
  assert.equal(aggressive.chargeWindowMultiplier, 1.0);

  // t=0.25 (confidence = 0.55): multiplier = lerp(0.7, 1.0, 0.25) = 0.775
  const mid = applyConfidenceGating(BASE_PARAMS, 0.55);
  assert.ok(Math.abs(mid.chargeWindowMultiplier - 0.775) < 0.001);
});

// --- lerp helper test ---
test('lerp: correctly interpolates between two values', () => {
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(lerp(100, 200, 0.25), 125);
});
