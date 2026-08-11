import test from 'node:test';
import assert from 'node:assert/strict';

// These imports will fail until the module is created (TDD RED phase)
import { detectRamTier, computeTier } from '../services/forecast/ram-tier.js';

test('computeTier returns 1 for totalMB < 2048', () => {
  assert.equal(computeTier(1024), 1);
  assert.equal(computeTier(1999), 1);
  assert.equal(computeTier(0), 1);
  assert.equal(computeTier(2047), 1);
});

test('computeTier returns 2 for totalMB between 2048 and 4095', () => {
  assert.equal(computeTier(2048), 2);
  assert.equal(computeTier(3000), 2);
  assert.equal(computeTier(4095), 2);
});

test('computeTier returns 3 for totalMB >= 4096', () => {
  assert.equal(computeTier(4096), 3);
  assert.equal(computeTier(8192), 3);
  assert.equal(computeTier(65536), 3);
});

test('detectRamTier returns object with tier and totalMB properties', () => {
  const result = detectRamTier();
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.tier, 'number');
  assert.equal(typeof result.totalMB, 'number');
  assert.ok(result.tier >= 1 && result.tier <= 3, `tier must be 1, 2, or 3 but got ${result.tier}`);
  assert.ok(result.totalMB > 0, 'totalMB must be positive');
  assert.equal(result.totalMB, Math.floor(result.totalMB), 'totalMB must be an integer');
});

test('detectRamTier tier matches computeTier for same totalMB', () => {
  const result = detectRamTier();
  assert.equal(result.tier, computeTier(result.totalMB));
});
