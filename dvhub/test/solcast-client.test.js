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

test('parseSolcastResponse maps kW to W and normalizes ts to period-START (15-min-aligned)', () => {
  // 26-03: Solcast emits the interval END as period_end; the ts must be normalized
  // to the period START (= period_end - period duration), floored to the 15-min axis,
  // so it collides with pvnode/pvlib slots in ensemble.mergeForecasts (exact ts_utc match).
  const forecasts = [
    { period_end: '2026-04-03T10:30:00Z', period: 'PT30M', pv_estimate: 3.5, pv_estimate10: 2.5, pv_estimate90: 4.5 },
    { period_end: '2026-04-03T11:30:00Z', period: 'PT30M', pv_estimate: 5.0, pv_estimate10: 4.0, pv_estimate90: 6.0 }
  ];
  const { rows } = parseSolcastResponse(forecasts);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, '2026-04-03T10:00:00.000Z'); // START = 10:30 - 30min
  assert.equal(rows[0].powerW, 3500); // 3.5 kW * 1000 — unchanged
  assert.equal(typeof rows[0].confidence, 'number');
  assert.equal(rows[1].ts, '2026-04-03T11:00:00.000Z'); // START = 11:30 - 30min
  assert.equal(rows[1].powerW, 5000); // 5.0 kW * 1000 — unchanged
});

// --- 26-03: period-START normalization (period_end -> period_start, 15-min-aligned) ---
//
// Fix #3 (Welle 4): parseSolcastResponse set ts: f.period_end. Solcast delivers the
// interval END as the timestamp; in ensemble.mergeForecasts (exact ts_utc string match)
// this caused a 15-/30-min offset against pvnode/pvlib (which use the period START), so
// Solcast slots NEVER collided with pvnode/pvlib slots -> Solcast got its own slots with
// Solcast-only weight (a co-cause of the quality drift). Fix: ts on the period START
// = period_end - interval duration, duration derived from the (previously unused) `period`
// field (PT30M/PT15M), plus quarter-flooring onto the 15-min axis.

test('26-03 (A): PT30M — ts is period-START = period_end - 30min, 15-min-aligned', () => {
  const { rows } = parseSolcastResponse([
    { period_end: '2026-04-03T10:30:00Z', period: 'PT30M', pv_estimate: 3.5, pv_estimate10: 2.5, pv_estimate90: 4.5 }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts, '2026-04-03T10:00:00.000Z');
  assert.equal(rows[0].powerW, 3500); // W-conversion unchanged
});

test('26-03 (B): PT15M — ts is period-START = period_end - 15min', () => {
  const { rows } = parseSolcastResponse([
    { period_end: '2026-04-03T10:15:00Z', period: 'PT15M', pv_estimate: 3.5, pv_estimate10: 2.5, pv_estimate90: 4.5 }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts, '2026-04-03T10:00:00.000Z');
  assert.equal(rows[0].powerW, 3500);
});

test('26-03 (C): missing period field -> 30-min fallback', () => {
  const { rows } = parseSolcastResponse([
    { period_end: '2026-04-03T10:30:00Z', pv_estimate: 3.5, pv_estimate10: 2.5, pv_estimate90: 4.5 }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts, '2026-04-03T10:00:00.000Z'); // 30-min default
  assert.equal(rows[0].powerW, 3500);
});

test('26-03 (D): quarter-flooring — off-axis START floored onto the 15-min axis', () => {
  // period_end 10:37, PT30M -> START 10:07 -> floored to 10:00 (pvnode axis).
  const { rows } = parseSolcastResponse([
    { period_end: '2026-04-03T10:37:00Z', period: 'PT30M', pv_estimate: 3.5, pv_estimate10: 2.5, pv_estimate90: 4.5 }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts, '2026-04-03T10:00:00.000Z');
  assert.equal(rows[0].powerW, 3500);
});

test('parseSolcastResponse handles empty array', () => {
  const { rows } = parseSolcastResponse([]);
  assert.equal(rows.length, 0);
});

// --- 18-01i: persist=0 regression ---
//
// Prod live-snapshot 2026-05-20T16:45 showed `solcast_fetch_ok { count: 145 }`
// but every row in `pv_forecasts WHERE model='solcast'` had power_w=0. Root
// cause: forecast-store.js insertPvForecast NaN-guard silently coerces
// undefined/null/NaN power_w to 0 — so a Solcast response whose pv_estimate
// field is missing (or has a drifted name) persists 145 zero rows without an
// error. These tests pin the new behavior: missing/non-finite pv_estimate rows
// MUST be dropped (not silently zeroed), and the caller MUST surface a
// diagnostic in pushLog so the operator can see the raw shape.

test('18-01i: parseSolcastResponse returns non-zero powerW for realistic pv_estimate', () => {
  const forecasts = [
    { period_end: '2026-05-21T12:00:00Z', pv_estimate: 4.2, pv_estimate10: 3.5, pv_estimate90: 4.8 }
  ];
  const { rows } = parseSolcastResponse(forecasts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].powerW, 4200);
});

test('18-01i: parseSolcastResponse drops rows where pv_estimate AND pv_estimate_period are missing', () => {
  // Row 1: valid point-endpoint shape — survives.
  // Row 2: NaN pv_estimate — dropped (NaN-guard would have silently zeroed it).
  // Row 3: no pv field at all (future API drift past both known shapes) — dropped.
  // 26-03: period_end must be a parseable ISO timestamp now (period-START
  // derivation drops rows with an unparseable period_end — threat T-26-03-01).
  // The drop-logic-under-test here is the pv_estimate fallback chain.
  const forecasts = [
    { period_end: '2026-04-03T10:30:00Z', period: 'PT30M', pv_estimate: 3.0, pv_estimate10: 2.5, pv_estimate90: 3.5 },
    { period_end: '2026-04-03T11:00:00Z', period: 'PT30M', pv_estimate: NaN },
    { period_end: '2026-04-03T11:30:00Z', period: 'PT30M', unknown_field: 5.0 }
  ];
  const { rows, dropped, firstRawKeys } = parseSolcastResponse(forecasts);
  assert.equal(rows.length, 1, 'only the row with valid pv_estimate survives');
  assert.equal(rows[0].powerW, 3000);
  assert.equal(dropped, 2, `dropped should be 2, got ${dropped}`);
  assert.ok(Array.isArray(firstRawKeys), 'firstRawKeys should be an array');
  assert.ok(firstRawKeys.includes('period_end'), 'firstRawKeys should include period_end');
});

test('18-01i: parseSolcastResponse maps pv_estimate_period (period endpoint shape) to powerW', () => {
  // Solcast period endpoint exposes pv_estimate_period instead of pv_estimate.
  // Fall back chain in pickEstimate must persist this as non-zero power.
  const forecasts = [
    { period_end: '2026-05-21T12:00:00Z', pv_estimate_period: 3.7 }
  ];
  const { rows, dropped } = parseSolcastResponse(forecasts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].powerW, 3700);
  assert.equal(dropped, 0);
});

test('18-01i: computeSolcastConfidence returns 0.5 when prediction interval bounds are missing', () => {
  // Period-endpoint shape has only pv_estimate / pv_estimate_period, no p10/p90.
  // Must return mid-confidence (0.5), not NaN.
  const c = computeSolcastConfidence({ pv_estimate: 4.0 });
  assert.equal(c, 0.5);
});

test('18-01i: fetchPvForecast logs solcast_persist_diag when API field-drift causes all-zero parse', async () => {
  const logs = [];
  const state = { forecast: { pv: {} } };
  const ctx = {
    state,
    getCfg: () => ({ forecast: { solcast: { apiKey: 'test-key', siteId: 'test-site' } } }),
    pushLog: (key, data) => logs.push({ key, data })
  };
  const store = { insertPvForecast: async () => {} };
  const client = createSolcastClient(ctx, { store });

  // Mock fetch to return forecasts with an unknown field name (not in the
  // fallback chain) — simulates future Solcast API drift past the two known
  // shapes. All rows must be dropped and the diag pushLog must fire with the
  // raw firstRawKeys so the operator can see which field actually arrived.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      forecasts: [
        { period_end: '2026-05-21T12:00:00Z', pv_estimate_kw: 4.2 },
        { period_end: '2026-05-21T13:00:00Z', pv_estimate_kw: 3.8 }
      ]
    })
  });

  try {
    await client.fetchPvForecast();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const diag = logs.find(l => l.key === 'solcast_persist_diag');
  assert.ok(diag, `pushLog should have fired solcast_persist_diag, logs: ${JSON.stringify(logs.map(l => l.key))}`);
  assert.ok(Array.isArray(diag.data.firstRawKeys), 'diag should include firstRawKeys array');
  assert.ok(diag.data.firstRawKeys.includes('period_end'), 'firstRawKeys should contain period_end');
  assert.ok(diag.data.firstRawKeys.includes('pv_estimate_kw'), 'firstRawKeys should contain pv_estimate_kw (the unknown drifted field)');
  assert.ok(diag.data.dropped >= 2, `dropped should reflect skipped rows, got ${diag.data.dropped}`);
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
