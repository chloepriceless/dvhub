// T-0079 (P0-5): energyKwhForSample caps a sample's resolution at one materialized
// slot (900s). buildMaterializedEnergySlotWrites buckets a whole sample into ONE
// 15-min slot, so a sample stamped with a resolution longer than the slot (a gap
// artifact) would over-fill that slot. The cap bounds the per-sample contribution.
// Pure-function test (no DB).

import test from 'node:test';
import assert from 'node:assert/strict';

import { energyKwhForSample } from '../telemetry-store-pg.js';

const kwh = (w, s) => (w * s) / 3600000;

test('T-0079: a normal-resolution live sample is not capped', () => {
  // 4000 W over 15 s
  assert.ok(Math.abs(energyKwhForSample(4000, 15) - kwh(4000, 15)) < 1e-12);
});

test('T-0079: a sample with resolution beyond one slot (>900s) is capped to 900s', () => {
  // 4000 W stamped with 3600 s (1h) resolution → contributes at most 900 s worth.
  assert.equal(energyKwhForSample(4000, 3600), kwh(4000, 900));
  assert.ok(energyKwhForSample(4000, 3600) < kwh(4000, 3600), 'capped < uncapped');
});

test('T-0079: resolution exactly at the slot bound (900s) is unchanged', () => {
  assert.equal(energyKwhForSample(4000, 900), kwh(4000, 900));
});

test('T-0079: negative power keeps its sign through the cap', () => {
  assert.equal(energyKwhForSample(-4000, 3600), kwh(-4000, 900));
});

test('T-0079: non-positive / non-finite resolution still returns null (unchanged contract)', () => {
  assert.equal(energyKwhForSample(4000, 0), null);
  assert.equal(energyKwhForSample(4000, -5), null);
  assert.equal(energyKwhForSample('x', 15), null);
});

test('T-0079: a null power value coerces to 0 kWh (pre-existing contract, unchanged)', () => {
  // Number(null) === 0 (finite) → a missing reading contributes 0, not null.
  assert.equal(energyKwhForSample(null, 15), 0);
});

test('T-0079: explicit maxSeconds overrides the default slot cap', () => {
  assert.equal(energyKwhForSample(4000, 3600, 1800), kwh(4000, 1800));
});
