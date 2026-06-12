// test/schedule-rules-toggle.test.js
//
// Operator slot-disable (2026-06-12):
//   1. POST /api/schedule/rules/toggle flips `enabled` in-place by id and
//      persists (optimizer slots are server-managed — the frontend cannot
//      round-trip them through the rules POST).
//   2. POST /api/schedule/rules (manual save) keeps forecast_optimizer rules
//      server-side like SMA rules — they must NOT be dropped or replaced by
//      frontend-reconstructed rules (the pre-2026-06-12 bug stripped
//      slotTs/closedLoopExport on every manual save).
//
// Harness: minimal-ctx pattern from test/metrics-endpoint.test.js + the
// POST-body req mock from test/smoke-phase05.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

const LAN_IP = '192.168.1.5';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) {
      captured.status = code;
      Object.assign(captured.headers, headers);
    },
    setHeader(k, v) { captured.headers[k] = v; },
    end(payload) { captured.body = payload == null ? '' : String(payload); },
    _captured: captured,
  };
}

function makeReq(method, urlPath, body) {
  const rawBody = body ? JSON.stringify(body) : '';
  const req = {
    method,
    url: urlPath,
    headers: { host: 'dvhub.test', 'content-type': 'application/json' },
    socket: { remoteAddress: LAN_IP },
    _body: rawBody,
    _listeners: {},
    on(event, cb) {
      if (event === 'data' && req._body) {
        setTimeout(() => cb(Buffer.from(req._body)), 0);
        setTimeout(() => {
          const endCb = req._listeners['end'];
          if (endCb) endCb();
        }, 1);
      } else if (event === 'end' && !req._body) {
        setTimeout(() => cb(), 0);
      } else {
        req._listeners[event] = cb;
      }
      return req;
    },
    destroy() { req._destroyed = true; }
  };
  return req;
}

function mockCtx(rules) {
  const cfg = {
    apiToken: null,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: true },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false },
    family: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
  };
  const persisted = [];
  return {
    persisted,
    state: {
      meter: { ok: false, updatedAt: 0, grid_total_w: 0 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 0, updatedAt: 0 },
      epex: { ok: false, data: [] },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: false, ok: false },
      keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      schedule: { rules, config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0 },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: 0, dvControl: null },
      log: [],
      forecast: null,
    },
    getCfg: () => cfg,
    getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigPath: () => '/tmp/config.json',
    getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '0.9.0-test' }),
    getTransportType: () => 'modbus',
    getAppDir: () => '/tmp',
    getRepoRoot: () => '/tmp',
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: true }),
    controlValue: () => 'off',
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    persistConfig: (reason) => { persisted.push(reason); },
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
  };
}

async function call(ctx, method, urlPath, body) {
  const routes = createApiRoutes(ctx);
  const req = makeReq(method, urlPath, body);
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  const parsed = res._captured.body ? JSON.parse(res._captured.body) : null;
  return { status: res._captured.status, body: parsed };
}

const optimizerRule = (slotTs, value, extra = {}) => ({
  id: `opt-${slotTs}-0`,
  enabled: true,
  target: 'gridSetpointW',
  start: '18:30',
  end: '18:45',
  slotTs,
  slotEndTs: slotTs + 900000,
  source: 'forecast_optimizer',
  autoManaged: true,
  displayTone: 'blue',
  value,
  ...extra,
});

describe('POST /api/schedule/rules/toggle (operator slot-disable)', () => {
  it('flips enabled on matching rules and persists', async () => {
    const rules = [optimizerRule(111, -3000), optimizerRule(222, -2000)];
    const ctx = mockCtx(rules);
    const out = await call(ctx, 'POST', '/api/schedule/rules/toggle', { ids: ['opt-111-0'], enabled: false });

    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.toggled, 1);
    assert.equal(ctx.state.schedule.rules.find((r) => r.id === 'opt-111-0').enabled, false);
    assert.equal(ctx.state.schedule.rules.find((r) => r.id === 'opt-222-0').enabled, true);
    assert.deepEqual(ctx.persisted, ['operator_manual'], 'toggle persists as operator_manual');
  });

  it('rejects missing ids / missing enabled / unknown ids', async () => {
    const ctx = mockCtx([optimizerRule(111, -3000)]);
    assert.equal((await call(ctx, 'POST', '/api/schedule/rules/toggle', { ids: [], enabled: false })).status, 400);
    assert.equal((await call(ctx, 'POST', '/api/schedule/rules/toggle', { ids: ['opt-111-0'] })).status, 400);
    assert.equal((await call(ctx, 'POST', '/api/schedule/rules/toggle', { ids: ['nope'], enabled: false })).status, 404);
    assert.equal(ctx.persisted.length, 0, 'failed toggles must not persist');
  });
});

describe('POST /api/schedule/rules keeps optimizer rules server-side', () => {
  it('manual save preserves forecast_optimizer rules byte-identical (incl. slotTs/closedLoopExport)', async () => {
    const optRule = optimizerRule(111, -3000, { closedLoopExport: true, batteryShareW: 2500 });
    const ctx = mockCtx([optRule, { id: 'grid_1', enabled: true, target: 'gridSetpointW', start: '06:00', end: '07:00', value: -40 }]);

    // Frontend saves ONLY manual rules (the redesigned collectScheduleRows
    // filters automation rows out).
    const out = await call(ctx, 'POST', '/api/schedule/rules', {
      rules: [{ id: 'grid_9', enabled: true, target: 'gridSetpointW', start: '08:00', end: '09:00', value: -500 }]
    });

    assert.equal(out.status, 200);
    const kept = ctx.state.schedule.rules.find((r) => r.id === 'opt-111-0');
    assert.ok(kept, 'optimizer rule must survive a manual save');
    assert.equal(kept.slotTs, 111, 'slotTs preserved');
    assert.equal(kept.closedLoopExport, true, 'closedLoopExport preserved');
    assert.equal(kept.batteryShareW, 2500, 'batteryShareW preserved');
    assert.ok(ctx.state.schedule.rules.find((r) => r.id === 'grid_9'), 'new manual rule stored');
    assert.ok(!ctx.state.schedule.rules.find((r) => r.id === 'grid_1'), 'old manual rules replaced');
  });

  it('a frontend-reconstructed optimizer rule in the payload is ignored (no duplicate/degraded copy)', async () => {
    const ctx = mockCtx([optimizerRule(111, -3000)]);
    const out = await call(ctx, 'POST', '/api/schedule/rules', {
      rules: [{ id: 'grid_1', enabled: true, target: 'gridSetpointW', start: '18:30', end: '18:45', value: -3000, source: 'forecast_optimizer', autoManaged: true }]
    });

    assert.equal(out.status, 200);
    const optRules = ctx.state.schedule.rules.filter((r) => r.source === 'forecast_optimizer');
    assert.equal(optRules.length, 1, 'exactly the server-side optimizer rule remains');
    assert.equal(optRules[0].id, 'opt-111-0', 'the server-side rule, not the degraded frontend copy');
    assert.equal(optRules[0].slotTs, 111);
  });
});
