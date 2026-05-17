// test/api/family-tesla-history.test.js
//
// Plan 11-06 round 10 — integration tests for the new
// GET /api/family/tesla-history read route.
//
// Mirrors test/api/family-tile-history.test.js (Plan 11-03 Task 2). The
// tesla-history route is a sibling of tile-history: a LAN-safe, GET-only read
// route over the Tesla series Plan 11-06 round 8 historises into
// timeseries_samples (source 'teslamate', keys tesla_<field>).
//
// CONTEXT verified by this file:
//   the EV detail-panel charge-history chart is fed by a dedicated
//   /api/family/* read route, mirroring the MQTT-tile "Verlauf heute" chart.
//
// Security coverage:
//   - the series keys are a FIXED server-side allowlist
//     (tesla_charger_power, tesla_battery_level) — no request-controlled
//     series key, so there is no enumeration surface.
//   - the only request input `days` is parsed + clamped to 1..31; the window
//     is server-computed Date objects, passed only to the parameterised
//     querySeries() (no SQL concat).
//   - external read without auth — route joins LAN_SAFE_ENDPOINTS
//     (GET-only LAN bypass; verified in family-routes.test.js).
//
// Test mode: invokes the routes-api dispatch handler directly via a mocked
// req/res (the family-tile-history.test.js pattern), with a mock ctx whose
// telemetryStore.querySeries is a stub.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../../routes-api.js';

const LAN_IP = '127.0.0.1'; // loopback — counts as local network

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

// A tesla-history-shaped row as querySeries returns it.
const SAMPLE_ROWS = [
  { key: 'tesla_charger_power', ts: '2026-05-15T18:15:00.000Z', value: 11, unit: 'kW', resolution: 1 },
  { key: 'tesla_battery_level', ts: '2026-05-15T18:15:00.000Z', value: 62, unit: '%', resolution: 1 },
];

function mockCtx(overrides = {}) {
  const ctx = {
    state: { log: [] },
    getCfg: () => ({
      epex: { enabled: false, timezone: 'Europe/Berlin' },
      optimizer: { enabled: false },
      schedule: { timezone: 'Europe/Berlin' },
      telemetry: { enabled: true },
      family: {},
      apiToken: '',
      gridPositiveMeans: 'grid_import',
      keepalivePulseSec: 30,
    }),
    getRawCfg: () => ({ family: {} }),
    pushLog: () => {},
    telemetryStore: {
      _lastQuery: null,
      async querySeries(arg) {
        this._lastQuery = arg;
        return SAMPLE_ROWS;
      },
    },
    needsSetup: () => false,
    getConfigPath: () => '/tmp/config.json',
  };
  Object.assign(ctx, overrides);
  return ctx;
}

async function callRoute(ctx, search, ip = LAN_IP) {
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  const pathname = '/api/family/tesla-history' + search;
  const url = new URL('http://localhost' + pathname);
  await routes.handleRequest(
    { method: 'GET', url: pathname, headers: { host: 'localhost' }, socket: { remoteAddress: ip } },
    res,
    url,
  );
  return res._captured;
}

describe('GET /api/family/tesla-history', () => {
  it('default window returns the tesla_* series (200, ok:true, 7-day default, data rows)', async () => {
    const ctx = mockCtx();
    const cap = await callRoute(ctx, '');
    assert.equal(cap.status, 200);
    const body = JSON.parse(cap.body);
    assert.equal(body.ok, true);
    assert.equal(body.days, 7, 'days defaults to 7');
    assert.ok(Array.isArray(body.data), 'data must be an array');
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0].key, 'tesla_charger_power');
    // querySeries must be invoked with the FIXED tesla series keys.
    assert.deepEqual(ctx.telemetryStore._lastQuery.seriesKeys,
      ['tesla_charger_power', 'tesla_battery_level']);
  });

  it('a valid days param is honoured', async () => {
    const ctx = mockCtx();
    const cap = await callRoute(ctx, '?days=3');
    assert.equal(cap.status, 200);
    const body = JSON.parse(cap.body);
    assert.equal(body.days, 3);
    // window must span exactly 3 days.
    const span = new Date(body.end).getTime() - new Date(body.start).getTime();
    assert.equal(span, 3 * 86400000);
  });

  it('days is clamped to 1..31 (an out-of-range value never reaches a huge window)', async () => {
    const ctx = mockCtx();
    const capHi = await callRoute(ctx, '?days=999');
    assert.equal(JSON.parse(capHi.body).days, 31, 'days clamps high to 31');
    const ctx2 = mockCtx();
    const capLo = await callRoute(ctx2, '?days=0');
    assert.equal(JSON.parse(capLo.body).days, 1, 'days clamps low to 1');
  });

  it('a non-numeric days param falls back to the 7-day default', async () => {
    const ctx = mockCtx();
    const cap = await callRoute(ctx, '?days=' + encodeURIComponent("7;DROP TABLE"));
    assert.equal(cap.status, 200);
    assert.equal(JSON.parse(cap.body).days, 7);
  });

  it('telemetry store unavailable returns 503 (ok:false)', async () => {
    const ctx = mockCtx({ telemetryStore: undefined });
    const cap = await callRoute(ctx, '');
    assert.equal(cap.status, 503);
    const body = JSON.parse(cap.body);
    assert.equal(body.ok, false);
  });

  it('empty history returns 200 with an empty data array (the no-data case)', async () => {
    const ctx = mockCtx({
      telemetryStore: { async querySeries() { return []; } },
    });
    const cap = await callRoute(ctx, '');
    assert.equal(cap.status, 200);
    const body = JSON.parse(cap.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data, []);
  });
});
