// REVIEWS H8 — unit tests for splitDateRange + expandChunkDays.
//
// Covers: 1-day range, exact 30-day chunk, month-crossing 61-day range that splits into
// 30+30+1 inclusive-inclusive chunks. Plus expandChunkDays inclusive enumeration +
// a 30-day expand count check. 5 tests total.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitDateRange,
  expandChunkDays
} from '../services/forecast/pvnode-backfill.js';

test('splitDateRange 1-day range returns single inclusive chunk', () => {
  const chunks = splitDateRange('2026-04-01', '2026-04-01', 30);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], { startDate: '2026-04-01', endDate: '2026-04-01' });
});

test('splitDateRange full 30-day chunk is inclusive (Apr 1 to Apr 30)', () => {
  const chunks = splitDateRange('2026-04-01', '2026-04-30', 30);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], { startDate: '2026-04-01', endDate: '2026-04-30' });
});

test('splitDateRange month-crossing 61-day range splits into 3 chunks with no overlap or gap', () => {
  // Mar 15 .. May 14 = 61 days inclusive-inclusive → 30 + 30 + 1
  const chunks = splitDateRange('2026-03-15', '2026-05-14', 30);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], { startDate: '2026-03-15', endDate: '2026-04-13' });
  assert.deepEqual(chunks[1], { startDate: '2026-04-14', endDate: '2026-05-13' });
  assert.deepEqual(chunks[2], { startDate: '2026-05-14', endDate: '2026-05-14' });

  // No overlap + no gap: consecutive chunks meet exactly (endDate+1 === nextStartDate).
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = new Date(chunks[i - 1].endDate + 'T00:00:00Z');
    prevEnd.setUTCDate(prevEnd.getUTCDate() + 1);
    assert.equal(prevEnd.toISOString().slice(0, 10), chunks[i].startDate);
  }
});

test('expandChunkDays inclusive-inclusive enumeration', () => {
  const days = expandChunkDays({ startDate: '2026-04-01', endDate: '2026-04-03' });
  assert.deepEqual(days, ['2026-04-01', '2026-04-02', '2026-04-03']);
});

test('expandChunkDays for 30-day chunk yields 30 days', () => {
  const days = expandChunkDays({ startDate: '2026-04-01', endDate: '2026-04-30' });
  assert.equal(days.length, 30);
  assert.equal(days[0], '2026-04-01');
  assert.equal(days[29], '2026-04-30');
});
