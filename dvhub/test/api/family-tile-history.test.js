// test/api/family-tile-history.test.js
//
// Plan 11-03 Task 2 (RED → GREEN) — integration tests for the new
// GET /api/family/tile-history read route.
//
// CONTEXT.md decision verified by this file:
//   D-14: the detail-panel "Verlauf heute" chart is fed by a dedicated
//         /api/family/* read route (not the generic /api/telemetry/series).
//
// Threat-model coverage (11-03-PLAN.md <threat_model>):
//   T-11-07: SQL injection — id is .slice(0,64).replace(/[^a-zA-Z0-9_-]/g,'')
//            then passed only to the parameterised querySeries().
//   T-11-08: series_key enumeration — id is validated against the configured
//            tiles; an unconfigured id never reaches querySeries (404).
//   T-11-09: external read without auth — route joins LAN_SAFE_ENDPOINTS
//            (GET-only LAN bypass; verified in family-routes.test.js).
//
// Test mode: invokes the routes-api dispatch handler directly via a mocked
// req/res (the family-routes.test.js pattern), with a mock ctx whose
// telemetryStore.querySeries is a stub and getRawCfg returns one tile.

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

// A tile-history-shaped row as querySeries returns it.
const SAMPLE_ROW = {
  key: 'mqtt_tile_plug1',
  ts: '2026-05-16T10:15:00.000Z',
  value: 1234,
  unit: 'W',
  resolution: 1,
};

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
    // The route validates id against getRawCfg().family.mqttTiles.
    getRawCfg: () => ({
      family: {
        mqttTiles: [
          { id: 'plug1', label: 'Steckdose', topic: 'zigbee2mqtt/Steckdose_Geblaese', field: 'energy', unit: 'W' },
        ],
      },
    }),
    pushLog: () => {},
    // telemetryStore with a querySeries stub that records its arg.
    telemetryStore: {
      _lastQuery: null,
      async querySeries(arg) {
        this._lastQuery = arg;
        return [SAMPLE_ROW];
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
  const pathname = '/api/family/tile-history' + search;
  const url = new URL('http://localhost' + pathname);
  await routes.handleRequest(
    { method: 'GET', url: pathname, headers: { host: 'localhost' }, socket: { remoteAddress: ip } },
    res,
    url,
  );
  return res._captured;
}

describe('GET /api/family/tile-history', () => {
  it('known id returns today\'s series (200, ok:true, id, data row)', async () => {
    const ctx = mockCtx();
    const cap = await callRoute(ctx, '?id=plug1');
    assert.equal(cap.status, 200);
    const body = JSON.parse(cap.body);
    assert.equal(body.ok, true);
    assert.equal(body.id, 'plug1');
    assert.ok(Array.isArray(body.data), 'data must be an array');
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].value, 1234);
    assert.equal(body.data[0].key, 'mqtt_tile_plug1');
    // querySeries must be invoked with the mqtt_tile_<id> series key.
    assert.deepEqual(ctx.telemetryStore._lastQuery.seriesKeys, ['mqtt_tile_plug1']);
  });

  it('unknown id returns 404 (ok:false) and never queries the store', async () => {
    const ctx = mockCtx();
    const cap = await callRoute(ctx, '?id=ghost');
    assert.equal(cap.status, 404);
    const body = JSON.parse(cap.body);
    assert.equal(body.ok, false);
    assert.equal(ctx.telemetryStore._lastQuery, null,
      'querySeries must NOT be called for an unconfigured id');
  });

  it('missing id returns 400 (ok:false)', async () => {
    const ctx = mockCtx();
    const cap = await callRoute(ctx, '');
    assert.equal(cap.status, 400);
    const body = JSON.parse(cap.body);
    assert.equal(body.ok, false);
  });

  it('telemetry store unavailable returns 503 (ok:false)', async () => {
    const ctx = mockCtx({ telemetryStore: undefined });
    const cap = await callRoute(ctx, '?id=plug1');
    assert.equal(cap.status, 503);
    const body = JSON.parse(cap.body);
    assert.equal(body.ok, false);
  });

  it('malformed id with special chars is sanitised then validated → 404', async () => {
    // "plug1';DROP" → after .replace(/[^a-zA-Z0-9_-]/g,'') becomes "plug1DROP",
    // which is not a configured tile → 404, never reaching querySeries.
    const ctx = mockCtx();
    const cap = await callRoute(ctx, '?id=' + encodeURIComponent("plug1';DROP"));
    assert.equal(cap.status, 404);
    assert.equal(ctx.telemetryStore._lastQuery, null);
  });
});
