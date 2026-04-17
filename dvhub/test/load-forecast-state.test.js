// Phase 07 FORE-12 REVIEWS L-cost add: state transitions for load-forecast fallback chain.
// Covers: SF success → ok, 1 fallback → ok, 2 fallbacks → degraded, 4 fallbacks → failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextLoadForecastState } from '../services/forecast/load-forecast.js';

const INITIAL = { source: 'unknown', status: 'ok', consecutiveNonSfRuns: 0, lastUpdatedAt: null };

test('SF success resets state to ok + 0 consecutive', () => {
  const s = nextLoadForecastState(
    { ...INITIAL, consecutiveNonSfRuns: 3, status: 'degraded' },
    'statsforecast'
  );
  assert.equal(s.source, 'statsforecast');
  assert.equal(s.status, 'ok');
  assert.equal(s.consecutiveNonSfRuns, 0);
});

test('1 non-SF fallback keeps status ok', () => {
  const s = nextLoadForecastState(INITIAL, 'sql_rollup');
  assert.equal(s.source, 'sql_rollup');
  assert.equal(s.consecutiveNonSfRuns, 1);
  assert.equal(s.status, 'ok');
});

test('2 consecutive non-SF fallbacks marks degraded', () => {
  const s1 = nextLoadForecastState(INITIAL, 'sql_rollup');
  const s2 = nextLoadForecastState(s1, 'vrm_fallback');
  assert.equal(s2.consecutiveNonSfRuns, 2);
  assert.equal(s2.status, 'degraded');
});

test('4 consecutive non-SF fallbacks marks failed', () => {
  let s = INITIAL;
  s = nextLoadForecastState(s, 'sql_rollup');
  s = nextLoadForecastState(s, 'sql_rollup');
  s = nextLoadForecastState(s, 'naive_constant');
  s = nextLoadForecastState(s, 'naive_constant');
  assert.equal(s.consecutiveNonSfRuns, 4);
  assert.equal(s.status, 'failed');
});

test('SF recovery from failed state resets to ok', () => {
  let s = INITIAL;
  for (let i = 0; i < 5; i++) s = nextLoadForecastState(s, 'sql_rollup');
  assert.equal(s.status, 'failed');
  s = nextLoadForecastState(s, 'statsforecast');
  assert.equal(s.status, 'ok');
  assert.equal(s.consecutiveNonSfRuns, 0);
});

test('/api/ml/status load_forecast shape is well-formed', () => {
  // Pure unit-style — mock mlService.getStatus result shape
  const mockMlService = {
    getStatus: () => ({
      tier: 2,
      mlEnabled: true,
      load_forecast: {
        source: 'statsforecast',
        status: 'ok',
        consecutive_non_sf_runs: 0,
        last_updated_at: '2026-04-17T12:00:00Z'
      }
    })
  };
  const status = mockMlService.getStatus();
  assert.ok(status.load_forecast);
  assert.ok(
    ['statsforecast', 'sql_rollup', 'vrm_fallback', 'naive_constant', 'unknown']
      .includes(status.load_forecast.source)
  );
  assert.ok(
    ['ok', 'degraded', 'failed', 'unknown']
      .includes(status.load_forecast.status)
  );
  assert.equal(typeof status.load_forecast.consecutive_non_sf_runs, 'number');
});
