import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSolcastClient,
  computeSolcastConfidence,
  parseSolcastResponse
} from '../services/forecast/solcast-client.js';

// --- computeSolcastConfidence ---

test('computeSolcastConfidence returns value between 0.3 and 1.0', () => {
  const c = computeSolcastConfidence({
    pv_estimate: 5.0,
    pv_estimate10: 3.0,
    pv_estimate90: 7.0
  });
  assert.ok(c >= 0.3 && c <= 1.0, `confidence ${c} should be between 0.3 and 1.0`);
});

test('computeSolcastConfidence returns higher value for narrow prediction interval', () => {
  const narrow = computeSolcastConfidence({
    pv_estimate: 5.0,
    pv_estimate10: 4.5,
    pv_estimate90: 5.5
  });
  const wide = computeSolcastConfidence({
    pv_estimate: 5.0,
    pv_estimate10: 1.0,
    pv_estimate90: 9.0
  });
  assert.ok(narrow > wide, `narrow ${narrow} should be greater than wide ${wide}`);
});

test('computeSolcastConfidence clamps to min 0.3', () => {
  // Huge spread -> should not go below 0.3
  const c = computeSolcastConfidence({
    pv_estimate: 0.01,
    pv_estimate10: 0,
    pv_estimate90: 100
  });
  assert.equal(c, 0.3);
});

test('computeSolcastConfidence returns 1.0 for zero spread', () => {
  const c = computeSolcastConfidence({
    pv_estimate: 5.0,
    pv_estimate10: 5.0,
    pv_estimate90: 5.0
  });
  assert.equal(c, 1.0);
});

// --- parseSolcastResponse ---

test('parseSolcastResponse maps kW to W and extracts timestamps', () => {
  const forecasts = [
    { period_end: '2026-04-03T10:00:00Z', pv_estimate: 3.5, pv_estimate10: 2.5, pv_estimate90: 4.5 },
    { period_end: '2026-04-03T11:00:00Z', pv_estimate: 5.0, pv_estimate10: 4.0, pv_estimate90: 6.0 }
  ];
  const rows = parseSolcastResponse(forecasts);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, '2026-04-03T10:00:00Z');
  assert.equal(rows[0].powerW, 3500); // 3.5 kW * 1000
  assert.equal(typeof rows[0].confidence, 'number');
  assert.equal(rows[1].ts, '2026-04-03T11:00:00Z');
  assert.equal(rows[1].powerW, 5000); // 5.0 kW * 1000
});

test('parseSolcastResponse handles empty array', () => {
  const rows = parseSolcastResponse([]);
  assert.equal(rows.length, 0);
});

// --- createSolcastClient ---

test('createSolcastClient returns object with fetchPvForecast and getRemainingCalls', () => {
  const state = { forecast: { pv: {} } };
  const ctx = {
    state,
    getCfg: () => ({ forecast: { solcast: { apiKey: '', siteId: '' } } }),
    pushLog: () => {}
  };
  const store = { insertPvForecast: async () => {} };
  const client = createSolcastClient(ctx, { store });
  assert.equal(typeof client.fetchPvForecast, 'function');
  assert.equal(typeof client.getRemainingCalls, 'function');
});

test('fetchPvForecast returns null when no apiKey configured', async () => {
  const state = { forecast: { pv: {} } };
  const ctx = {
    state,
    getCfg: () => ({ forecast: { solcast: { apiKey: '', siteId: 'test-site' } } }),
    pushLog: () => {}
  };
  const store = { insertPvForecast: async () => {} };
  const client = createSolcastClient(ctx, { store });
  const result = await client.fetchPvForecast();
  assert.equal(result, null);
});

test('fetchPvForecast returns null when no siteId configured', async () => {
  const state = { forecast: { pv: {} } };
  const ctx = {
    state,
    getCfg: () => ({ forecast: { solcast: { apiKey: 'test-key', siteId: '' } } }),
    pushLog: () => {}
  };
  const store = { insertPvForecast: async () => {} };
  const client = createSolcastClient(ctx, { store });
  const result = await client.fetchPvForecast();
  assert.equal(result, null);
});

test('rate limiter blocks after 10 calls in same day', async () => {
  const logs = [];
  const state = { forecast: { pv: {} } };
  const ctx = {
    state,
    getCfg: () => ({ forecast: { solcast: { apiKey: 'test-key', siteId: 'test-site' } } }),
    pushLog: (key, data) => logs.push({ key, data })
  };
  const store = { insertPvForecast: async () => {} };
  const client = createSolcastClient(ctx, { store });

  // Simulate 10 calls by incrementing internal counter
  for (let i = 0; i < 10; i++) {
    client._incrementCallCount();
  }

  const result = await client.fetchPvForecast();
  assert.equal(result, null);
  assert.ok(logs.some(l => l.key === 'solcast_rate_limit'), 'should log rate limit');
});

test('rate limiter resets on new day', () => {
  const state = { forecast: { pv: {} } };
  const ctx = {
    state,
    getCfg: () => ({ forecast: { solcast: { apiKey: 'test-key', siteId: 'test-site' } } }),
    pushLog: () => {}
  };
  const store = { insertPvForecast: async () => {} };
  const client = createSolcastClient(ctx, { store });

  // Simulate 10 calls
  for (let i = 0; i < 10; i++) {
    client._incrementCallCount();
  }
  assert.equal(client.getRemainingCalls(), 0);

  // Simulate day change
  client._resetForNewDay();
  assert.equal(client.getRemainingCalls(), 10);
});
