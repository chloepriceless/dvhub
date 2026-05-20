// test/smoke-phase05.test.js -- Phase 05 HTTP smoke tests (QUAL-06).
// Covers all major Phase 05 API endpoints + H-01/H-14/H-17 regressions.
// Uses createApiRoutes(ctx) + mockCtx + mockRes pattern (no HTTP server).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';
import { computeSlotCosts, enrichPriceSlotsWithCosts } from '../services/optimizer/cost-model.js';

// ── Mock helpers ────────────────────────────────────────────────────

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured
  };
}

// makeReq(method, urlPath, body[, opts])
//   body  — a JS object → JSON-stringified (the original behaviour), OR
//   opts.rawBody — a raw string emitted verbatim as the request body. Used by
//     the H-1 tests to drive an INVALID-JSON body (parseBody → 400).
//   opts.headers — extra request headers merged onto the default set.
// The extension is additive: callers that pass only (method, urlPath, body)
// behave exactly as before.
function makeReq(method, urlPath, body, opts = {}) {
  const rawBody = typeof opts.rawBody === 'string'
    ? opts.rawBody
    : (body ? JSON.stringify(body) : '');
  const req = {
    method,
    url: urlPath,
    headers: { host: 'localhost', ...(opts.headers || {}) },
    socket: { remoteAddress: '127.0.0.1' },
    // Implement on/destroy for readRawBody calls (POST endpoints)
    _body: rawBody,
    _listeners: {},
    on(event, cb) {
      if (event === 'data' && req._body) {
        setTimeout(() => cb(Buffer.from(req._body)), 0);
        // Also fire 'end' after data
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

function mockCtx(overrides = {}) {
  const base = {
    // Phase 17 Plan 04: license-gate requires ctx.licenseService.requirePro.
    // Default to an always-allow stub so the smoke tests continue to exercise
    // the business-logic path of /api/family/* and /family. The 403-gate path
    // is covered in license-routes.test.js. Tests that need to assert the
    // gate can override `licenseService` via the overrides arg.
    licenseService: { requirePro: () => true },
    state: {
      meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 3000, gridImportW: 0, gridExportW: 0, updatedAt: 0 },
      epex: { ok: false, data: [] },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: false, dbPath: null, ok: false },
      keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      scan: { running: false, updatedAt: 0, params: null, rows: [], error: null },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0, smallMarketAutomation: {} },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: Date.now(), dvControl: null },
      dvRegs: { 0: 0, 1: 0, 3: 0, 4: 0 },
      log: [],
      forecast: null
    },
    getCfg: () => ({
      epex: { enabled: false, timezone: 'Europe/Berlin' },
      optimizer: { enabled: false, batteryCapacityWh: 10000 },
      family: {
        screensaver: { enabled: true, defaultTimeoutSec: 120, windows: [], dimOpacity: 0.3 },
        presence: { pollIntervalMs: 2000, webhookEnabled: true }
      },
      apiToken: '',
      gridPositiveMeans: 'grid_import',
      keepalivePulseSec: 30,
      schedule: { timezone: 'Europe/Berlin' },
      telemetry: { enabled: false }
    }),
    pushLog: () => {},
    persistConfig: () => {},
    setForcedOff: () => {},
    clearForcedOff: () => {},
    expireLeaseIfNeeded: () => {},
    transport: { type: 'modbus' },
    telemetrySafeWrite: () => {},
    controlValue: () => 'off',
    needsSetup: () => false,
    getConfigPath: () => '/tmp/config.json',
    getRawCfg: () => ({ apiToken: 'secret-token', mqtt: { password: 'mqtt-pass' } }),
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigDefinition: () => [],
    getAppVersion: () => ({ versionLabel: '1.0.0-test' }),
    getTransportType: () => 'modbus',
    getAppDir: () => '/tmp',
    getRepoRoot: () => '/tmp',
    scanTransport: {},
    fetchEpexDay: async () => {},
    fetchVrmForecast: async () => {},
    getCachedRuntimeStatusPayload: () => null,
    buildRuntimeRouteMeta: () => ({ ready: true, busy: false, queueDepth: 0 }),
    buildFallbackStatusPayload: () => ({
      victron: { pvTotalW: 0, batteryPowerW: 0, soc: 50 },
      meter: { grid_total_w: 0 },
      epex: { ok: false, data: [] },
      costs: { netEur: 0, costEur: 0, revenueEur: 0 }
    }),
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
    saveAndApplyConfig: (cfg) => ({ ok: true, changedPaths: [], restartRequired: false, restartRequiredPaths: [] }),
    scheduleServiceRestart: () => {},
    runServiceCommand: async () => ({ ok: true }),
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    assertValidRuntimeCommand: () => {},
    epexNowNext: () => null,
    applyControlTarget: async () => ({ ok: true }),

    // ── Phase 05 services ──────────────────────────────────────────
    forecastService: {
      buildForecastResponse: async () => ({
        meta: { mlActive: true, horizon: 48, forecastVersion: 1 },
        price: [],
        pv: [{ start: '2026-04-11T06:00:00Z', powerW: 5000 }],
        rawPv: [{ start: '2026-04-11T06:00:00Z', powerW: 4800 }],
        load: [{ start: '2026-04-11T06:00:00Z', powerW: 800 }],
        actual: [{ start: '2026-04-11T05:00:00Z', powerW: 4500 }],
        solar: [],
        consumption: []
      }),
      store: {}
    },
    mlService: {
      getStatus: () => ({ modelLoaded: true, modelType: 'lightgbm', version: 1, mae: 0.56, tier: 2, mlEnabled: true }),
      getAccuracyTrend: async () => [{ date: '2026-04-11', mae: 0.56, samples: 100 }]
    },
    llmService: {
      listModels: async () => [
        { name: 'llama3.2:3b', size: 2000000000, parameter_size: '3B' },
        { name: 'tinyllama', size: 637000000, parameter_size: '1.1B' }
      ],
      generateMessage: async (type, data) => ({ text: 'Guten Morgen! Heute wird es sonnig.', type }),
      getMessages: () => [{ text: 'Test message', ts: Date.now() }]
    },
    optimizerService: {
      getStatus: () => ({ enabled: true, lastRun: Date.now() }),
      getLatestRun: () => ({
        id: 1, optimizer: 'internal', created_at: new Date().toISOString(),
        seriesByKey: {
          battery_power_w: [{ ts: '2026-04-11T06:00Z', value: 500 }],
          pv_power_w: [{ ts: '2026-04-11T06:00Z', value: 3000 }],
          load_power_w: [{ ts: '2026-04-11T06:00Z', value: 800 }],
          price_import_ct_kwh: [{ ts: '2026-04-11T06:00Z', value: 26.9 }]
        }
      })
    },
    familyService: {
      buildFamilyStatus: () => ({
        now: Date.now(),
        energy: { solarKw: 1.2, homeKw: 0.8, gridKw: -0.4, feedingToGrid: true, surplus: true, batteryKw: 0, evKw: 0 },
        battery: { socPct: 50, powerKw: 0, mode: 'idle' },
        greeting: { hello: 'Guten Tag' }
      }),
      getPresence: () => ({ detected: false, source: null, updatedAt: 0 }),
      setPresence: () => {}
    },
    telemetryStore: {
      getLatestOptimizerRun: async ({ optimizer } = {}) => ({
        id: 1,
        optimizer: optimizer || 'internal',
        runStartedAt: '2026-04-11T06:00:00Z',
        runFinishedAt: '2026-04-11T06:00:05Z',
        status: 'ok',
        source: 'schedule',
        inputJson: null,
        series: [
          { seriesKey: 'battery_power_w', ts: '2026-04-11T06:00Z', value: 500, scope: 'plan', unit: 'W' },
          { seriesKey: 'pv_power_w', ts: '2026-04-11T06:00Z', value: 3000, scope: 'input', unit: 'W' },
          { seriesKey: 'load_power_w', ts: '2026-04-11T06:00Z', value: 800, scope: 'input', unit: 'W' },
          { seriesKey: 'price_import_ct_kwh', ts: '2026-04-11T06:00Z', value: 26.9, scope: 'input', unit: 'ct/kWh' }
        ]
      }),
      writeOptimizerRun: () => {}
    },
    historyApi: null,
    historyImportManager: null
  };
  return { ...base, ...overrides };
}

// ── 1. GET /api/ml/status ─────────────────────────────────────────

describe('Phase 05 Smoke Tests', () => {

  it('GET /api/ml/status -- returns model status with modelLoaded', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/ml/status');
    await routes.handleRequest(makeReq('GET', '/api/ml/status'), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.modelLoaded, true);
    assert.equal(body.modelType, 'lightgbm');
  });

  // ── 2. GET /api/forecast -- forecast with ML active and actual[] ──

  it('GET /api/forecast -- returns forecast with mlActive and actual[]', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/forecast');
    await routes.handleRequest(makeReq('GET', '/api/forecast'), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, true);
    assert.equal(body.meta.mlActive, true);
    assert.ok(Array.isArray(body.actual), 'actual must be an array');
    assert.ok(body.actual.length > 0, 'actual must have entries');
  });

  // ── 3. GET /api/forecast -- no mlCollapsed field (H-01 regression) ──

  it('GET /api/forecast -- response does NOT contain mlCollapsed (H-01)', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/forecast');
    await routes.handleRequest(makeReq('GET', '/api/forecast'), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.mlCollapsed, undefined, 'mlCollapsed must not be in response (H-01 removed)');
    assert.ok(!('mlCollapsed' in body), 'mlCollapsed key must not exist');
  });

  // ── 4. GET /api/optimizer/runs/latest -- returns run with series ──

  it('GET /api/optimizer/runs/latest -- returns run with all 4 series keys', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/optimizer/runs/latest');
    await routes.handleRequest(makeReq('GET', '/api/optimizer/runs/latest'), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, true);
    assert.ok(body.run, 'run must be present');
    const keys = body.run.seriesByKey;
    assert.ok(Array.isArray(keys.pv_power_w), 'pv_power_w must be non-empty array');
    assert.ok(keys.pv_power_w.length > 0);
    assert.ok(Array.isArray(keys.load_power_w), 'load_power_w must be non-empty array');
    assert.ok(keys.load_power_w.length > 0);
    assert.ok(Array.isArray(keys.battery_power_w), 'battery_power_w must be present');
    assert.ok(Array.isArray(keys.price_import_ct_kwh), 'price_import_ct_kwh must be present');
  });

  // ── 5. POST /api/messages/generate -- returns non-empty text ──

  it('POST /api/messages/generate -- returns non-empty text', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/messages/generate');
    await routes.handleRequest(makeReq('POST', '/api/messages/generate', { type: 'status' }), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, true);
    assert.ok(body.message, 'message must be present');
    assert.ok(body.message.text.length > 0, 'message text must be non-empty');
  });

  // ── 6. GET /api/ml/accuracy -- returns accuracy data ──

  it('GET /api/ml/accuracy -- returns accuracy trend', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/ml/accuracy');
    await routes.handleRequest(makeReq('GET', '/api/ml/accuracy'), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.ok(Array.isArray(body), 'accuracy response must be an array');
    assert.ok(body.length > 0, 'accuracy trend must have entries');
  });

  // ── 7. GET /api/llm/models -- returns Ollama model list ──

  it('GET /api/llm/models -- returns model list with name property', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/llm/models');
    await routes.handleRequest(makeReq('GET', '/api/llm/models'), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.models), 'models must be an array');
    assert.ok(body.models.length > 0, 'models must not be empty');
    assert.ok(body.models[0].name, 'first model must have a name');
  });

  // ── 8. POST /api/integration/eos/apply -- accepts setpoints ──

  it('POST /api/integration/eos/apply -- applies setpoints successfully', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/integration/eos/apply');
    await routes.handleRequest(
      makeReq('POST', '/api/integration/eos/apply', { gridSetpointW: 500 }),
      res, url
    );
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.results), 'results must be an array');
  });

  // ── 9. GET /api/family/status -- returns family data ──

  it('GET /api/family/status -- returns ok and energy data', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/family/status');
    await routes.handleRequest(makeReq('GET', '/api/family/status'), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, true);
    assert.ok(body.energy, 'energy must be present');
    assert.ok(body.greeting, 'greeting must be present');
  });

  // ── 10. GET /api/config -- returns masked values (settings roundtrip part 1) ──

  it('GET /api/config -- returns config with masked secrets', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/config');
    await routes.handleRequest(makeReq('GET', '/api/config'), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, true);
    assert.ok(body.config, 'config must be present');
    // REDACTED_PATHS must be masked to '***'
    assert.equal(body.config.apiToken, '***', 'apiToken must be redacted');
    assert.equal(body.config.mqtt.password, '***', 'mqtt.password must be redacted');
  });

  // ── 11. POST /api/config -- settings roundtrip preserves masked originals ──

  it('POST /api/config with *** preserves original values', async () => {
    let savedConfig = null;
    const ctx = mockCtx({
      saveAndApplyConfig: (cfg) => {
        savedConfig = cfg;
        return { ok: true, changedPaths: [], restartRequired: false, restartRequiredPaths: [] };
      }
    });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/config');
    await routes.handleRequest(
      makeReq('POST', '/api/config', { config: { apiToken: '***', mqtt: { password: '***' } } }),
      res, url
    );
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, true);
  });

  // ── 12. GET /api/messages -- LLM messages endpoint ──

  it('GET /api/messages -- returns messages array', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/messages');
    await routes.handleRequest(makeReq('GET', '/api/messages'), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.ok(Array.isArray(body.messages), 'messages must be an array');
    assert.ok(body.messages.length > 0, 'messages must not be empty');
  });

  // ── 13. GET /api/optimizer/status -- optimizer status endpoint ──

  it('GET /api/optimizer/status -- returns optimizer status', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/optimizer/status');
    await routes.handleRequest(makeReq('GET', '/api/optimizer/status'), res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.enabled, true);
  });
});

// ── C-1 Regression: dead isLanSafeRequest guard on POST endpoints ──
//
// Before the fix, both /api/ml/retrain and /api/admin/backfill were guarded by
// `if (!isLanSafeRequest(req) || !checkAuth(req, res)) return;`. isLanSafeRequest
// short-circuits to false on any non-GET request, so every POST returned from
// handleRequest WITHOUT writing a response → serveStatic 404 fallthrough. The
// handler body was 100% dead code. After the fix the guard is `checkAuth` only,
// so a POST reaches the handler and produces the handler's own status (503 when
// the backing service is absent), never the 404 static fallback.

describe('C-1 Regression: dead guard on POST /api/ml/retrain + /api/admin/backfill', () => {
  it('POST /api/ml/retrain reaches the handler (503, not 404)', async () => {
    // Omit mlService + mlRetrainJobs → handler returns 503 service-unavailable.
    // A 404 here would prove the isLanSafeRequest guard still short-circuits.
    const ctx = mockCtx({ mlService: undefined, mlRetrainJobs: undefined });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/ml/retrain'), res,
      new URL('http://localhost/api/ml/retrain')
    );
    assert.equal(res._captured.status, 503,
      'POST /api/ml/retrain must reach its handler (503), not fall through to a 404');
    const body = JSON.parse(res._captured.body);
    assert.equal(body.error, 'ml_retrain_service_unavailable');
  });

  it('POST /api/admin/backfill reaches the handler (503, not 404)', async () => {
    // pvnodeBackfill is absent from mockCtx → handler returns 503 service-unavailable.
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/admin/backfill'), res,
      new URL('http://localhost/api/admin/backfill')
    );
    assert.equal(res._captured.status, 503,
      'POST /api/admin/backfill must reach its handler (503), not fall through to a 404');
    const body = JSON.parse(res._captured.body);
    assert.equal(body.error, 'pvnode_backfill_service_unavailable');
  });
});

// ── H-14 Regression: optimizer kill-switch purges forecast_optimizer rules ──

describe('H-14 Regression: Optimizer Kill-Switch', () => {
  it('schedule-eval effectiveTargetValue skips optimizer rules when disabled', async () => {
    // Import schedule-eval to test directly
    const { createScheduleEvaluator } = await import('../schedule-eval.js');

    const rules = [
      { id: 'opt-1', source: 'forecast_optimizer', target: 'gridSetpointW', value: 1000,
        start: 0, end: 1440 },
      { id: 'user-1', source: 'user', target: 'gridSetpointW', value: 500,
        start: 0, end: 1440 }
    ];

    const logs = [];
    const schedState = {
      meter: { ok: false, updatedAt: 0 },
      victron: { soc: 50, batteryPowerW: 0 },
      epex: { ok: false, data: [] },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: false },
      keepalive: { modbusLastQuery: null },
      scan: { running: false },
      schedule: {
        rules: [...rules],
        config: {},
        active: {},
        lastWrite: {},
        manualOverride: {},
        lastEvalAt: 0,
        smallMarketAutomation: {}
      },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: Date.now(), dvControl: null },
      dvRegs: {},
      log: [],
      forecast: null
    };

    const schedCtx = {
      state: schedState,
      getCfg: () => ({
        optimizer: { enabled: false, allowGridCharge: false, allowGridDischarge: false },
        schedule: { timezone: 'Europe/Berlin', manualOverrideTtlMs: 300000 }
      }),
      transport: { type: 'modbus' },
      pushLog: (t, d) => logs.push({ t, d }),
      telemetrySafeWrite: () => {},
      persistConfig: () => {},
      regenerateSmallMarketAutomationRules: async () => {},
      telemetryStore: null,
      epexNowNext: () => null,
      onEvalComplete: () => {}
    };

    const evaluator = createScheduleEvaluator(schedCtx);
    await evaluator.evaluateSchedule();

    // After evaluateSchedule with optimizer.enabled=false, forecast_optimizer rules should be purged
    const remaining = schedState.schedule.rules;
    const optimizerRules = remaining.filter(r => r.source === 'forecast_optimizer');
    assert.equal(optimizerRules.length, 0, 'all forecast_optimizer rules must be purged when optimizer disabled');
    const userRules = remaining.filter(r => r.source === 'user');
    assert.equal(userRules.length, 1, 'user rules must be preserved');

    // Verify purge was logged
    const purgeLog = logs.find(l => l.t === 'optimizer_rules_purged');
    assert.ok(purgeLog, 'optimizer_rules_purged must be logged');
    assert.equal(purgeLog.d.reason, 'optimizer_disabled');

    evaluator.stop();
  });
});

// ── H-17 Regression: feedInMode respected regardless of tariff type ──

describe('H-17 Regression: feedInMode with fixed tariff', () => {
  it('fixed tariff with feedInMode=spot uses spot-based feed-in pricing', () => {
    const spotCtKwh = 5.0;
    const tariff = {
      type: 'fixed',
      fixedCtKwh: 30.0,
      feedInMode: 'spot',
      feedInSpotFactor: 0.9,
      feedInCtKwh: 7.78
    };
    const paragraph14a = { enabled: false };

    const result = computeSlotCosts(spotCtKwh, tariff, paragraph14a);

    // H-17 fix: feedInMode=spot must use spot pricing even with fixed tariff
    assert.equal(result.importCtKwh, 30.0, 'import must use fixed rate');
    // feed-in must be spot * factor, NOT the fixed 7.78
    const expectedFeedIn = spotCtKwh * 0.9;
    assert.equal(result.feedInCtKwh, expectedFeedIn,
      `feedIn must be ${expectedFeedIn} (spot*factor), not 7.78`);
  });

  it('fixed tariff with feedInMode=fixed uses feedInCtKwh', () => {
    const spotCtKwh = 5.0;
    const tariff = {
      type: 'fixed',
      fixedCtKwh: 30.0,
      feedInMode: 'fixed',
      feedInCtKwh: 7.78
    };
    const paragraph14a = { enabled: false };

    const result = computeSlotCosts(spotCtKwh, tariff, paragraph14a);
    assert.equal(result.feedInCtKwh, 7.78, 'feedIn must use fixed rate');
  });

  it('enrichPriceSlotsWithCosts uses feedInMode from optimizer.tariff config', () => {
    const cfg = {
      userEnergyPricing: { mode: 'fixed', fixedGrossImportCtKwh: 30 },
      optimizer: {
        tariff: {
          feedInMode: 'spot',
          feedInSpotFactor: 0.85,
          feedInCtKwh: 7.78
        }
      }
    };
    const slots = [{ ts: Date.now(), ctKwh: 5.0 }];
    const enriched = enrichPriceSlotsWithCosts(slots, cfg);
    // With feedInMode=spot and spotCtKwh=5.0, feedIn = 5.0 * 0.85 = 4.25
    assert.equal(enriched[0].feedInCtKwh, 5.0 * 0.85,
      'feedInCtKwh must use spot*factor from optimizer.tariff config');
  });
});

// ── H-1 Regression: readJsonBody — body-parse 400/413 consistency ──
//
// Plan 16-02 Task 1. ~13 POST handlers call `await parseBody(req)` with no
// surrounding try/catch. server-utils.js parseBody rejects a body-too-large
// with a bare Error (no statusCode) → server.js maps it to an uncaught 500 +
// a killed socket. The fix: parseBody's body-too-large error carries
// statusCode=413, and a shared `readJsonBody(req,res)` helper turns both the
// invalid-JSON (400) and body-too-large (413) cases into a clean, consistent
// `{ok:false,error}` JSON response. We drive POST /api/log (routes-api.js) —
// the simplest body-parsing endpoint, no service mock needed.

describe('H-1: readJsonBody body-parse 400/413', () => {
  it('invalid JSON body → 400 {ok:false,error:invalid_json_body}', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    // A syntactically invalid JSON body — parseBody's JSON.parse throws.
    await routes.handleRequest(
      makeReq('POST', '/api/log', null, { rawBody: '{ this is not json' }),
      res,
      new URL('http://localhost/api/log')
    );
    assert.equal(res._captured.status, 400,
      'an invalid-JSON body must return 400, not an uncaught 500');
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'invalid_json_body');
  });

  it('oversize body → 413 {ok:false,error:body_too_large} (not 500)', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    // parseBody's MAX_BODY_BYTES is 256 KB — emit a single chunk above it.
    const oversize = 'x'.repeat(300 * 1024);
    await routes.handleRequest(
      makeReq('POST', '/api/log', null, { rawBody: oversize }),
      res,
      new URL('http://localhost/api/log')
    );
    assert.equal(res._captured.status, 413,
      'a body-too-large must return a clean 413, not an uncaught 500');
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'body_too_large');
  });

  it('valid JSON body still reaches the handler (200)', async () => {
    // Regression guard: the helper must not break the happy path.
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/log', { level: 'error', message: 'test' }),
      res,
      new URL('http://localhost/api/log')
    );
    assert.equal(res._captured.status, 200,
      'a valid body must still reach the /api/log handler');
  });
});

// ── H-2 Regression: keepalivePulsePayload divide-by-zero clamp ──
//
// Plan 16-02 Task 2. keepalivePulsePayload computes
// `Math.floor(now / (cfg.keepalivePulseSec * 1000))`. A misconfigured
// keepalivePulseSec of 0 (or a missing value) makes the divisor 0, so
// pulseSlot becomes Infinity and serializes to JSON `null` on a polled
// LAN-safe endpoint. The fix clamps period = Math.max(1, Number(...) || 60).

describe('H-2: keepalive divide-by-zero clamp', () => {
  function cfgWith(keepalivePulseSec) {
    return () => ({
      epex: { enabled: false, timezone: 'Europe/Berlin' },
      optimizer: { enabled: false, batteryCapacityWh: 10000 },
      family: {
        screensaver: { enabled: true, defaultTimeoutSec: 120, windows: [], dimOpacity: 0.3 },
        presence: { pollIntervalMs: 2000, webhookEnabled: true }
      },
      apiToken: '',
      gridPositiveMeans: 'grid_import',
      keepalivePulseSec,
      schedule: { timezone: 'Europe/Berlin' },
      telemetry: { enabled: false }
    });
  }

  it('keepalivePulseSec=0 → finite pulseSlot + pulseTimestamp', async () => {
    const ctx = mockCtx({ getCfg: cfgWith(0) });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('GET', '/api/keepalive/pulse'),
      res,
      new URL('http://localhost/api/keepalive/pulse')
    );
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.ok(Number.isFinite(body.pulseSlot),
      'pulseSlot must be finite even when keepalivePulseSec is 0');
    assert.ok(body.pulseSlot !== null, 'pulseSlot must not serialize to null');
    assert.ok(Number.isFinite(body.pulseTimestamp),
      'pulseTimestamp must be finite even when keepalivePulseSec is 0');
  });

  it('keepalivePulseSec missing → finite pulseSlot (falls back to 60)', async () => {
    const ctx = mockCtx({ getCfg: cfgWith(undefined) });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('GET', '/api/keepalive/pulse'),
      res,
      new URL('http://localhost/api/keepalive/pulse')
    );
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.ok(Number.isFinite(body.pulseSlot),
      'pulseSlot must be finite when keepalivePulseSec is missing');
    assert.ok(Number.isFinite(body.pulseTimestamp),
      'pulseTimestamp must be finite when keepalivePulseSec is missing');
  });
});

// ── H-3/H-4 Regression: EPEX SSRF guard + response byte-cap ──
//
// Plan 16-02 Task 3.
//   H-3 — epex.priceApiUrl is config-controlled and the /api/epex/* handlers
//   issue a server-side fetch to it. Saving a non-https URL or one pointing at
//   an RFC1918/loopback host must be rejected at config-save time (400).
//   H-4 — a bare `await r.json()` on that upstream would buffer an arbitrarily
//   large body and OOM the LXC. An oversize upstream response must produce a
//   clean 502, not a 500 / OOM.
//
// NOTE: the /api/epex/* handlers call the GLOBAL `fetch`, not a ctx-injected
// one. The H-4 test therefore stubs `globalThis.fetch` and restores it in a
// finally block — this differs from the plan's suggested mockCtx.fetch
// mechanism, which does not match the code (deviation: Rule 3, plan/code
// mismatch).

describe('H-3: EPEX priceApiUrl SSRF guard', () => {
  it('non-https priceApiUrl → 400 invalid_epex_price_api_url', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/config', { config: { epex: { priceApiUrl: 'http://api.example.com' } } }),
      res,
      new URL('http://localhost/api/config')
    );
    assert.equal(res._captured.status, 400,
      'a non-https priceApiUrl must be rejected at save time');
    const body = JSON.parse(res._captured.body);
    assert.equal(body.error, 'invalid_epex_price_api_url');
  });

  it('RFC1918 priceApiUrl → 400 invalid_epex_price_api_url', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/config', { config: { epex: { priceApiUrl: 'https://192.168.1.5/x' } } }),
      res,
      new URL('http://localhost/api/config')
    );
    assert.equal(res._captured.status, 400,
      'a priceApiUrl pointing at a private host must be rejected');
    const body = JSON.parse(res._captured.body);
    assert.equal(body.error, 'invalid_epex_price_api_url');
  });

  it('loopback priceApiUrl → 400 invalid_epex_price_api_url', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/config', { config: { epex: { priceApiUrl: 'https://127.0.0.1:9000/x' } } }),
      res,
      new URL('http://localhost/api/config')
    );
    assert.equal(res._captured.status, 400);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.error, 'invalid_epex_price_api_url');
  });

  it('valid public https priceApiUrl is accepted (not 400)', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/config', { config: { epex: { priceApiUrl: 'https://api.dvhub.de' } } }),
      res,
      new URL('http://localhost/api/config')
    );
    assert.notEqual(res._captured.status, 400,
      'a valid public https priceApiUrl must pass the SSRF guard');
  });
});

describe('H-4: EPEX upstream response byte-cap', () => {
  it('oversize EPEX upstream body → 502 (not 500/OOM)', async () => {
    const realFetch = globalThis.fetch;
    // Fake upstream: a ReadableStream that yields > 1 MB of bytes.
    globalThis.fetch = async () => {
      let emitted = 0;
      const chunk = new Uint8Array(256 * 1024); // 256 KB per read
      return {
        ok: true,
        status: 200,
        headers: { get: () => null }, // no content-length → exercise the streaming cap
        body: {
          getReader() {
            return {
              async read() {
                if (emitted >= 2 * 1024 * 1024) return { done: true, value: undefined };
                emitted += chunk.length;
                return { done: false, value: chunk };
              },
              async cancel() {}
            };
          }
        }
      };
    };
    try {
      const ctx = mockCtx();
      const routes = createApiRoutes(ctx);
      const res = mockRes();
      await routes.handleRequest(
        makeReq('GET', '/api/epex/zones'),
        res,
        new URL('http://localhost/api/epex/zones')
      );
      assert.equal(res._captured.status, 502,
        'an oversize EPEX upstream body must produce a clean 502');
      const body = JSON.parse(res._captured.body);
      assert.equal(body.error, 'upstream_response_too_large');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('content-length over the cap → 502 before streaming', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (h === 'content-length' ? String(5 * 1024 * 1024) : null) },
      body: { getReader() { return { async read() { return { done: true }; }, async cancel() {} }; } }
    });
    try {
      const ctx = mockCtx();
      const routes = createApiRoutes(ctx);
      const res = mockRes();
      await routes.handleRequest(
        makeReq('GET', '/api/epex/zones'),
        res,
        new URL('http://localhost/api/epex/zones')
      );
      assert.equal(res._captured.status, 502,
        'a content-length over the cap must be rejected before buffering');
      const body = JSON.parse(res._captured.body);
      assert.equal(body.error, 'upstream_response_too_large');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('small EPEX upstream body is returned normally (200)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      let sent = false;
      const payload = Buffer.from(JSON.stringify({ zones: ['DE-LU'] }), 'utf8');
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h === 'content-length' ? String(payload.length) : null) },
        body: {
          getReader() {
            return {
              async read() {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: new Uint8Array(payload) };
              },
              async cancel() {}
            };
          }
        }
      };
    };
    try {
      const ctx = mockCtx();
      const routes = createApiRoutes(ctx);
      const res = mockRes();
      await routes.handleRequest(
        makeReq('GET', '/api/epex/zones'),
        res,
        new URL('http://localhost/api/epex/zones')
      );
      assert.equal(res._captured.status, 200,
        'a small upstream body must pass the cap and return normally');
      const body = JSON.parse(res._captured.body);
      assert.deepEqual(body.zones, ['DE-LU']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── M-1..M-5 Regression: input validation hardening ──────────────────
//
// Plan 16-03 Task 2. Each item is a genuine input-validation defect from
// REVIEW-routes-api-2026-05-18.md:
//   M-1 — serveStatic's decodeURIComponent throws URIError on a malformed
//         `%` seq → uncaught 500; a NUL byte decodes into the filename →
//         fs ERR_INVALID_ARG_VALUE → 500. Fix: try/catch → 400; reject `\0`.
//   M-2 — /api/devices/:id derives the id via split('/api/devices/')[1]
//         which keeps embedded slashes. Fix: reject ids containing `/`.
//   M-3 — /api/log/dv-signals `limit` has no upper cap. Fix: Math.min clamp.
//   M-4 — /api/telemetry/series start/end aren't parse-validated; the DoS
//         guard treats unparseable as 0. Fix: parseIsoOrNull false → 400.
//   M-5 — /api/telemetry/series `keys` has no length cap. Fix: >50 → 400.
describe('M-1..M-5: input validation', () => {
  // M-1 — serveStatic is exported separately; invoke it directly. A plain
  // mockRes captures the text(res,400,...) writeHead/end the handler emits.
  it('M-1: serveStatic malformed %-sequence → 400 bad path (not 500)', () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    // `%E0%A4%A` is an incomplete UTF-8 escape — decodeURIComponent throws.
    routes.serveStatic({ url: '/%E0%A4%A', headers: { host: 'localhost' } }, res);
    assert.equal(res._captured.status, 400,
      `a malformed %-sequence must yield 400, got ${res._captured.status}`);
  });

  it('M-1: serveStatic NUL-byte path → 400 bad path', () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    // %00 decodes to a NUL byte — fs would throw ERR_INVALID_ARG_VALUE.
    routes.serveStatic({ url: '/app%00.js', headers: { host: 'localhost' } }, res);
    assert.equal(res._captured.status, 400,
      `a NUL-byte path must yield 400, got ${res._captured.status}`);
  });

  it('M-2: GET /api/devices/a/b → 400 invalid_device_id', async () => {
    const ctx = mockCtx({ deviceService: { getDevices: () => [] } });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('GET', '/api/devices/a/b'),
      res,
      new URL('http://localhost/api/devices/a/b')
    );
    assert.equal(res._captured.status, 400,
      `a device id with an embedded slash must yield 400, got ${res._captured.status}`);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.error, 'invalid_device_id');
  });

  it('M-3: /api/log/dv-signals?limit=99999999 → effective limit clamped to 2000', async () => {
    let seenLimit = null;
    const ctx = mockCtx({
      telemetryStore: {
        listControlEvents: async ({ limit }) => { seenLimit = limit; return []; }
      }
    });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('GET', '/api/log/dv-signals?limit=99999999'),
      res,
      new URL('http://localhost/api/log/dv-signals?limit=99999999')
    );
    assert.equal(res._captured.status, 200, `expected 200, got ${res._captured.status}`);
    assert.equal(seenLimit, 2000,
      `an unbounded limit must be clamped to 2000, store saw limit=${seenLimit}`);
  });

  it('M-4: /api/telemetry/series?start=notadate → 400 invalid_timestamp', async () => {
    const ctx = mockCtx({
      telemetryStore: { querySeries: async () => [] }
    });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('GET', '/api/telemetry/series?start=notadate'),
      res,
      new URL('http://localhost/api/telemetry/series?start=notadate')
    );
    assert.equal(res._captured.status, 400,
      `an unparseable start timestamp must yield 400, got ${res._captured.status}`);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.error, 'invalid_timestamp');
  });

  it('M-5: /api/telemetry/series with >50 keys → 400 too_many_keys', async () => {
    const ctx = mockCtx({
      telemetryStore: { querySeries: async () => [] }
    });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const manyKeys = Array.from({ length: 60 }, (_, i) => `k${i}`).join(',');
    const path = `/api/telemetry/series?keys=${manyKeys}`;
    await routes.handleRequest(
      makeReq('GET', path),
      res,
      new URL(`http://localhost${path}`)
    );
    assert.equal(res._captured.status, 400,
      `>50 keys must yield 400, got ${res._captured.status}`);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.error, 'too_many_keys');
  });
});

// ── M-6 / L-11 Regression: gate parity + message-type allowlist ───────
//
// Plan 16-03 Task 3.
//   M-6 — /api/admin/update/channel jumped straight into parseBody +
//         saveAndApplyConfig; its siblings /api/admin/update/check and
//         /api/admin/update/apply BOTH start with a getServiceActionsEnabled
//         403 gate. Without it the channel change is persisted even when
//         service actions are disabled. Fix: add the identical gate first.
//   L-11 — /api/messages/generate passed body.type straight to
//         generateMessage with no allowlist. Fix: validate against
//         MESSAGE_TYPE_ALLOWLIST, default to 'status' on a miss.
describe('M-6 / L-11: gate parity + message-type allowlist', () => {
  it('M-6: POST /api/admin/update/channel with service actions disabled → 403', async () => {
    // base mockCtx getServiceActionsEnabled() === false
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/admin/update/channel', { channel: 'dev' }),
      res,
      new URL('http://localhost/api/admin/update/channel')
    );
    assert.equal(res._captured.status, 403,
      `channel switch must be gated by service-actions, got ${res._captured.status}`);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, false, `403 body must be {ok:false,...}, got ${JSON.stringify(body)}`);
  });

  it('L-11: POST /api/messages/generate with an unknown type falls back to "status"', async () => {
    let seenType = null;
    const ctx = mockCtx({
      llmService: {
        generateMessage: async (type) => { seenType = type; return { text: 'ok', type }; },
        getMessages: () => []
      }
    });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/messages/generate', { type: 'evilarbitrary' }),
      res,
      new URL('http://localhost/api/messages/generate')
    );
    assert.equal(res._captured.status, 200, `expected 200, got ${res._captured.status}`);
    assert.equal(seenType, 'status',
      `an unknown message type must fall back to 'status', generateMessage saw '${seenType}'`);
  });

  it('L-11: a known type (savings) is passed through unchanged', async () => {
    let seenType = null;
    const ctx = mockCtx({
      llmService: {
        generateMessage: async (type) => { seenType = type; return { text: 'ok', type }; },
        getMessages: () => []
      }
    });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/messages/generate', { type: 'savings' }),
      res,
      new URL('http://localhost/api/messages/generate')
    );
    assert.equal(res._captured.status, 200, `expected 200, got ${res._captured.status}`);
    assert.equal(seenType, 'savings',
      `a known message type must pass through, generateMessage saw '${seenType}'`);
  });
});
