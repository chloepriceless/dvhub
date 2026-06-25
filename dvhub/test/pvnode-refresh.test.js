import test from 'node:test';
import assert from 'node:assert/strict';

import { createPvForecast } from '../services/forecast/pv-forecast.js';

// T-PVNODE-REFRESH (Christin 2026-06-25): a dedicated pvnode refresh pulls pvnode
// on its own (plan-gated) cadence and re-merges the ensemble against the LAST known
// other-provider slots — WITHOUT re-fetching Solcast / pvlib / vrm.

function makeStore() {
  const storedRows = [];
  return {
    storedRows,
    insertPvForecast: async (row) => { storedRows.push(row); },
    insertPvForecastBatch: async (rows) => { if (Array.isArray(rows)) for (const r of rows) storedRows.push(r); },
    getLatestWeather: async () => [],
    getForecastAccuracyRow: async () => null // uniform-weight merge
  };
}

function makeCtx(state) {
  return {
    state,
    getCfg: () => ({
      forecast: {
        location: { latitude: 48.15, longitude: 9.48 },
        pv: { configLevel: 'simple', totalKwp: 10, tiltDeg: 35, azimuthDeg: 180, strings: [], model: 'auto' },
        solcast: {},
        pvnode: { plan: 'plus' } // 15-min window so the client never throttles the test fetch
      }
    }),
    pushLog: () => {},
    bumpForecastVersion: () => {}
  };
}

test('refreshPvnodeOnly re-merges fresh pvnode WITHOUT re-fetching Solcast', async () => {
  const store = makeStore();
  const state = { forecast: { pv: {} } };
  let pvnodeData = [
    { ts_utc: '2026-04-03T12:00:00Z', power_w: 2000 },
    { ts_utc: '2026-04-03T12:15:00Z', power_w: 2100 },
  ];
  let solcastCalls = 0;

  const pv = createPvForecast(makeCtx(state), {
    tier: 1,
    store,
    pythonBridge: { call: async () => [] },
    solcastClient: { fetchPvForecast: async () => { solcastCalls++; return []; } },
    forecastSolar: { fetchForecast: async () => [
      { ts_utc: '2026-04-03T12:00:00Z', power_w: 3000 },
      { ts_utc: '2026-04-03T12:15:00Z', power_w: 3200 },
    ] },
    vrmForecast: { isAvailable: () => true, readPvForecast: async () => [
      { ts_utc: '2026-04-03T12:00:00Z', power_w: 5000 },
      { ts_utc: '2026-04-03T12:15:00Z', power_w: 5400 },
    ] },
    openMeteoSolar: { generateForecast: async () => [] },
    pvnodeClient: { isConfigured: true, fetchForecast: async () => pvnodeData },
  });

  await pv.runForecast(); // sets the provider baseline + first combined merge
  assert.equal(state.forecast.pv.model, 'combined');
  const solcastAfterFull = solcastCalls;

  // pvnode delivers a fresh (much higher) nowcast
  pvnodeData = [
    { ts_utc: '2026-04-03T12:00:00Z', power_w: 9000 },
    { ts_utc: '2026-04-03T12:15:00Z', power_w: 9100 },
  ];
  store.storedRows.length = 0;
  await pv.refreshPvnodeOnly();

  const combined = store.storedRows.filter((r) => r.model === 'combined');
  assert.ok(combined.length > 0, 'fresh pvnode triggers a combined re-merge');
  assert.equal(solcastCalls, solcastAfterFull, 'Solcast is NOT re-fetched by the pvnode refresh');
  assert.ok(combined.some((r) => r.power_w > 3200), 'the high fresh pvnode value moved the ensemble up');
  assert.ok(store.storedRows.some((r) => r.model === 'pvnode'), 'pvnode rows persisted for accuracy tracking');

  pv.close();
});

test('refreshPvnodeOnly is a no-op when pvnode data is unchanged', async () => {
  const store = makeStore();
  const state = { forecast: { pv: {} } };
  const pvnodeData = [
    { ts_utc: '2026-04-03T12:00:00Z', power_w: 2000 },
    { ts_utc: '2026-04-03T12:15:00Z', power_w: 2100 },
  ];
  const pv = createPvForecast(makeCtx(state), {
    tier: 1, store,
    pythonBridge: { call: async () => [] },
    solcastClient: { fetchPvForecast: async () => [] },
    forecastSolar: { fetchForecast: async () => [
      { ts_utc: '2026-04-03T12:00:00Z', power_w: 3000 },
      { ts_utc: '2026-04-03T12:15:00Z', power_w: 3200 },
    ] },
    vrmForecast: { isAvailable: () => true, readPvForecast: async () => [
      { ts_utc: '2026-04-03T12:00:00Z', power_w: 5000 },
      { ts_utc: '2026-04-03T12:15:00Z', power_w: 5400 },
    ] },
    openMeteoSolar: { generateForecast: async () => [] },
    pvnodeClient: { isConfigured: true, fetchForecast: async () => pvnodeData },
  });

  await pv.runForecast();
  store.storedRows.length = 0;
  await pv.refreshPvnodeOnly(); // same pvnode data → unchanged signature
  assert.equal(store.storedRows.filter((r) => r.model === 'combined').length, 0,
    'unchanged pvnode data must NOT re-merge');
  pv.close();
});

test('refreshPvnodeOnly is a no-op before the first full run (no baseline)', async () => {
  const store = makeStore();
  const pv = createPvForecast(makeCtx({ forecast: { pv: {} } }), {
    tier: 1, store,
    pythonBridge: { call: async () => [] },
    solcastClient: { fetchPvForecast: async () => [] },
    forecastSolar: { fetchForecast: async () => [] },
    vrmForecast: { isAvailable: () => false, readPvForecast: async () => [] },
    openMeteoSolar: { generateForecast: async () => [] },
    pvnodeClient: { isConfigured: true, fetchForecast: async () => [{ ts_utc: '2026-04-03T12:00:00Z', power_w: 5000 }] },
  });
  await pv.refreshPvnodeOnly(); // no runForecast() yet
  assert.equal(store.storedRows.length, 0, 'no baseline → refresh is a no-op');
  pv.close();
});
