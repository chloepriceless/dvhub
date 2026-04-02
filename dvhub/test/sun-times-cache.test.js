import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSunTimesCacheKey, isSunTimesCacheStale, readSunTimesForDate } from '../sun-times-cache.js';

test('buildSunTimesCacheKey uses location and year', () => {
  assert.equal(buildSunTimesCacheKey({ latitude: 52.52, longitude: 13.405, year: 2026 }), '52.52:13.405:2026');
});

test('readSunTimesForDate returns the cached sunrise/sunset pair for one day', () => {
  const result = readSunTimesForDate({
    cache: {
      '2026-06-02': {
        sunriseTs: '2026-06-02T04:45:00.000Z',
        sunsetTs: '2026-06-02T19:21:00.000Z'
      }
    },
    dateKey: '2026-06-02'
  });

  assert.equal(result.sunriseTs, '2026-06-02T04:45:00.000Z');
  assert.equal(result.sunsetTs, '2026-06-02T19:21:00.000Z');
});

test('isSunTimesCacheStale reports stale cache when the configured location changed', () => {
  assert.equal(
    isSunTimesCacheStale({
      cachedLocation: { latitude: 52.52, longitude: 13.405 },
      requestedLocation: { latitude: 48.14, longitude: 11.58 },
      cachedYear: 2026,
      requestedYear: 2026
    }),
    true
  );
});
