// T-0079 (P0-5): energyKwhForSample caps a sample's resolution at one materialized
// slot (900s). buildMaterializedEnergySlotWrites buckets a whole sample into ONE
// 15-min slot, so a sample stamped with a resolution longer than the slot (a gap
// artifact) would over-fill that slot. The cap bounds the per-sample contribution.
// Pure-function test (no DB).

import test from 'node:test';
import assert from 'node:assert/strict';

import { energyKwhForSample, buildMaterializedEnergySlotWrites } from '../telemetry-store-pg.js';

const kwh = (w, s) => (w * s) / 3600000;

// Two live samples in the SAME 15-min slot (10:00 and 10:05 → 10:00 bucket).
const liveRow = (ts, w) => ({
  seriesKey: 'grid_import_w', scope: 'live', source: 'local_poll',
  ts, value: w, resolutionSeconds: 900
});
// vrm_import rows use the replace path.
const vrmRow = (ts, w) => ({
  seriesKey: 'vrm_grid_import_ref_w', scope: 'history', source: 'vrm_import',
  ts, value: w, resolutionSeconds: 900, quality: 'backfilled'
});
const slotVal = (writes) => writes.length === 1 ? writes[0].valueNum : writes.map((w) => w.valueNum);

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

// --- T-0079 part 2: replay idempotency of the accumulate slot writes ----------

const rows = [liveRow('2026-06-05T10:00:00Z', 3600), liveRow('2026-06-05T10:05:00Z', 3600)];

test('T-0079 p2: default predicate counts every sample (backward-compatible)', () => {
  const w = buildMaterializedEnergySlotWrites(rows);
  assert.equal(w.length, 1, 'both samples land in one slot');
  assert.equal(w[0].writeMode, 'accumulate');
  assert.equal(slotVal(w), kwh(3600, 900) * 2, 'both accumulate (0.9 + 0.9 kWh)');
});

test('T-0079 p2: accumulate counts ONLY newly-inserted samples (replay no double-count)', () => {
  // Replay: the 2nd sample already existed (not new) → must NOT be re-added.
  const w = buildMaterializedEnergySlotWrites(rows, (row, i) => i === 0);
  assert.equal(slotVal(w), kwh(3600, 900), 'only the new sample accumulates (0.9 kWh)');
});

test('T-0079 p2: a full replay (no new samples) accumulates NOTHING', () => {
  const w = buildMaterializedEnergySlotWrites(rows, () => false);
  assert.equal(w.length, 0, 'all-conflict replay writes no accumulate slot');
});

test('T-0079 p2: the REPLACE path (vrm_import) ignores new-ness — always full total', () => {
  const vrm = [vrmRow('2026-06-05T10:00:00Z', 3600), vrmRow('2026-06-05T10:05:00Z', 3600)];
  // Even with isNewSample=false for all, replace must still set the full slot total
  // (it SETs, not ADDs → idempotent regardless).
  const w = buildMaterializedEnergySlotWrites(vrm, () => false);
  assert.equal(w.length, 1);
  assert.equal(w[0].writeMode, 'replace');
  assert.equal(slotVal(w), kwh(3600, 900) * 2, 'replace uses every row');
});
