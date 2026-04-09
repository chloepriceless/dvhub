import test from 'node:test';
import assert from 'node:assert/strict';

import { applyFogCorrection } from '../services/forecast/fog-correction.js';

test('dense fog: visibility < 1000m reduces PV by 80%', () => {
  const result = applyFogCorrection(1000, 500, 95);
  assert.deepStrictEqual(result, { correctedW: 200, fogFactor: 0.2 });
});

test('moderate fog: visibility 1000-3000m reduces PV by 50%', () => {
  const result = applyFogCorrection(1000, 2000, 85);
  assert.deepStrictEqual(result, { correctedW: 500, fogFactor: 0.5 });
});

test('light fog: visibility 3000-5000m with high humidity reduces PV by 25%', () => {
  const result = applyFogCorrection(1000, 4000, 95);
  assert.deepStrictEqual(result, { correctedW: 750, fogFactor: 0.75 });
});

test('clear: visibility >= 5000m returns full power', () => {
  const result = applyFogCorrection(1000, 10000, 50);
  assert.deepStrictEqual(result, { correctedW: 1000, fogFactor: 1.0 });
});

test('null visibility returns full power', () => {
  const result = applyFogCorrection(1000, null, 50);
  assert.deepStrictEqual(result, { correctedW: 1000, fogFactor: 1.0 });
});

test('undefined visibility returns full power', () => {
  const result = applyFogCorrection(1000, undefined, 50);
  assert.deepStrictEqual(result, { correctedW: 1000, fogFactor: 1.0 });
});

test('NaN visibility returns full power', () => {
  const result = applyFogCorrection(1000, NaN, 50);
  assert.deepStrictEqual(result, { correctedW: 1000, fogFactor: 1.0 });
});

test('visibility 3000-5000m with low humidity returns full power (no fog correction)', () => {
  // humidity 85 is <= 90, so no light fog correction
  const result = applyFogCorrection(1000, 4000, 85);
  assert.deepStrictEqual(result, { correctedW: 1000, fogFactor: 1.0 });
});

test('boundary: visibility exactly 1000m triggers moderate fog', () => {
  const result = applyFogCorrection(1000, 1000, 50);
  assert.deepStrictEqual(result, { correctedW: 500, fogFactor: 0.5 });
});

test('boundary: visibility exactly 3000m with high humidity triggers light fog', () => {
  const result = applyFogCorrection(1000, 3000, 95);
  assert.deepStrictEqual(result, { correctedW: 750, fogFactor: 0.75 });
});

test('boundary: visibility exactly 5000m returns full power', () => {
  const result = applyFogCorrection(1000, 5000, 95);
  assert.deepStrictEqual(result, { correctedW: 1000, fogFactor: 1.0 });
});

test('zero power input returns zero corrected', () => {
  const result = applyFogCorrection(0, 500, 95);
  assert.deepStrictEqual(result, { correctedW: 0, fogFactor: 0.2 });
});

test('rounds corrected power to nearest integer', () => {
  // 333 * 0.5 = 166.5 -> 167
  const result = applyFogCorrection(333, 2000, 50);
  assert.equal(result.correctedW, Math.round(333 * 0.5));
  assert.equal(result.fogFactor, 0.5);
});
