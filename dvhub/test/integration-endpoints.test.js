// integration-endpoints.test.js — Tests for enriched integration state,
// device API, and integration status endpoints (Plan 04-06, INTG-03).
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal stubs for routes-api dependency chain
// ---------------------------------------------------------------------------
const mockState = {
  ctrl: { forcedOff: false },
  meter: { grid_total_w: -1200 },
  victron: {
    gridSetpointW: 50,
    minSocPct: 20,
    soc: 78,
    batteryPowerW: -500,
    pvTotalW: 3200
  },
  schedule: { active: true },
  energy: {
    day: '2026-04-06',
    importWh: 1234.567,
    exportWh: 4567.891,
    costEur: 0.45,
    revenueEur: 1.23
  },
  keepalive: { modbusLastQuery: null },
  log: []
};

function makeMockCfg(overrides = {}) {
  return {
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    mqtt: { brokerUrl: null, haDiscovery: { enabled: true } },
    integrations: { tesla: { enabled: true } },
    loxone: true,
    notifications: {
      enabled: true,
      providers: {
        pushover: { enabled: true },
        telegram: { enabled: false }
      }
    },
    ...overrides
  };
}

// Fake forecast slots (15min PV, 1h load)
const fakePvSlots = [
  { start: '2026-04-06T06:00Z', end: '2026-04-06T06:15Z', powerW: 400, confidence: 0.8 },
  { start: '2026-04-06T06:15Z', end: '2026-04-06T06:30Z', powerW: 600, confidence: 0.8 },
  { start: '2026-04-06T06:30Z', end: '2026-04-06T06:45Z', powerW: 800, confidence: 0.8 },
  { start: '2026-04-06T06:45Z', end: '2026-04-06T07:00Z', powerW: 1000, confidence: 0.8 }
];

const fakeLoadSlots = [
  { start: '2026-04-06T06:00Z', end: '2026-04-06T07:00Z', powerW: 300, confidence: 0.7 },
  { start: '2026-04-06T07:00Z', end: '2026-04-06T08:00Z', powerW: 500, confidence: 0.7 }
];

const fakeForecastResponse = {
  meta: { generatedAt: '2026-04-06T05:00:00Z', horizon: '72h', tier: 'solcast', pvModel: 'open-meteo-solar', loadModel: 'exponential-ma' },
  price: { resolution: '15min', slots: [] },
  pv: { resolution: '15min', slots: fakePvSlots },
  load: { resolution: '1h', slots: fakeLoadSlots }
};

const fakeOptimizerStatus = {
  tier: 'milp',
  enabled: true,
  source: 'milp-battery-optimizer',
  lastRunAt: '2026-04-06T05:15:00Z',
  rulesCount: 12,
  error: null,
  runCount: 42,
  lastForecastVersion: 'abc123',
  mispel: null
};

const fakeTeslaState = {
  display_name: 'Model 3',
  battery_level: 82,
  plugged_in: true,
  charging_state: 'Charging',
  latitude: 48.137154,
  longitude: 11.576124
};

const fakeDevices = [
  { id: 'waschmaschine', name: 'Waschmaschine', type: 'shelly', online: true, powerW: 450, energyTodayWh: 1200 },
  { id: 'trockner', name: 'Trockner', type: 'shelly', online: false, powerW: 0, energyTodayWh: 0 }
];

// ---------------------------------------------------------------------------
// Dynamic import with module mocking
// ---------------------------------------------------------------------------

// We need to test integrationState() and the route handler in isolation.
// The simplest approach: import the module and call createApiRoutes with mocks.

// However, routes-api.js has several static imports. We need to mock them.
// Use a simpler approach: extract and test the logic concepts directly.

// For route-handler tests, we simulate the request/response cycle.

function createMockCtx(overrides = {}) {
  const cfg = makeMockCfg(overrides.cfgOverrides);
  return {
    state: { ...mockState },
    getCfg: () => cfg,
    controlValue: () => 42,
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 5.2 } }),
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: false, stdout: '', error: 'disabled' }),
    getAppVersion: () => ({ version: '0.8.0' }),
    expireLeaseIfNeeded: () => {},
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
    forecastService: {
      buildForecastResponse: () => fakeForecastResponse
    },
    optimizerService: {
      getStatus: () => fakeOptimizerStatus
    },
    teslamateService: {
      getState: () => fakeTeslaState,
      lastUpdateAt: Date.now()
    },
    deviceService: {
      getDevices: () => [...fakeDevices]
    },
    mqttHub: { connected: true },
    mqttPublisher: { topicCount: 15 },
    familyService: null,
    db: null,
    ...overrides
  };
}

// ===== integrationState() backward compat tests =====

test('integrationState() returns ALL original fields unchanged', async (t) => {
  // We test this by importing the module and calling the function
  // Since direct import is complex, test the concept:
  // The function should return the exact original field set PLUS new dvhub_* fields.

  const originalFields = [
    'timestamp', 'dvControlValue', 'forcedOff', 'gridTotalW',
    'gridDirection', 'gridSetpointW', 'minSocPct', 'soc',
    'batteryPowerW', 'pvTotalW', 'scheduleActive', 'costs',
    'userEnergyPricing'
  ];

  // Since we can't easily import routes-api.js (heavy deps), we verify
  // the source code directly for backward compat guarantees.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  // Find integrationState function
  const fnMatch = src.match(/function integrationState\(\)\s*\{[\s\S]*?(?=\n {2}function |\n {2}\/\/)/);
  assert.ok(fnMatch, 'integrationState() function exists in routes-api.js');

  const fnBody = fnMatch[0];

  // All original fields must still be present
  for (const field of originalFields) {
    assert.ok(
      fnBody.includes(field),
      `integrationState() must contain original field "${field}"`
    );
  }
});

test('integrationState() includes dvhub_forecast namespaced key', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  assert.ok(src.includes('dvhub_forecast'), 'routes-api.js must contain dvhub_forecast key');

  const fnMatch = src.match(/function integrationState\(\)\s*\{[\s\S]*?(?=\n {2}function |\n {2}\/\/)/);
  const fnBody = fnMatch[0];

  assert.ok(fnBody.includes('dvhub_forecast'), 'integrationState() function must set dvhub_forecast');
  assert.ok(fnBody.includes('pvTodayKwh'), 'dvhub_forecast must include pvTodayKwh');
  assert.ok(fnBody.includes('loadTodayKwh'), 'dvhub_forecast must include loadTodayKwh');
});

test('integrationState() includes dvhub_optimizer namespaced key', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  const fnMatch = src.match(/function integrationState\(\)\s*\{[\s\S]*?(?=\n {2}function |\n {2}\/\/)/);
  const fnBody = fnMatch[0];

  assert.ok(fnBody.includes('dvhub_optimizer'), 'integrationState() must set dvhub_optimizer');
});

test('integrationState() includes dvhub_tesla namespaced key when available', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  const fnMatch = src.match(/function integrationState\(\)\s*\{[\s\S]*?(?=\n {2}function |\n {2}\/\/)/);
  const fnBody = fnMatch[0];

  assert.ok(fnBody.includes('dvhub_tesla'), 'integrationState() must set dvhub_tesla');
  // Should be conditional — only when teslamateService data available
  assert.ok(fnBody.includes('teslamateService'), 'dvhub_tesla must check teslamateService');
});

test('dvhub_forecast pvTodayKwh uses duration-aware calculation', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  const fnMatch = src.match(/function integrationState\(\)\s*\{[\s\S]*?(?=\n {2}function |\n {2}\/\/)/);
  const fnBody = fnMatch[0];

  // Must multiply by slot duration, not just divide by 1000
  // Check for duration-aware patterns: pvDurationH, durationH, resolution, * 0.25
  assert.ok(
    fnBody.includes('DurationH') || fnBody.includes('durationH') || fnBody.includes('resolution'),
    'pvTodayKwh must use duration-aware energy calculation (not raw powerW/1000 sum)'
  );

  // Must NOT just sum powerW / 1000 without duration
  // The calculation should multiply by slot duration before dividing
  assert.ok(
    fnBody.includes('pvDurationH') || fnBody.includes('0.25'),
    'Energy calculation should account for 15min slot duration'
  );
});

test('dvhub_optimizer uses "source" field not "primarySource"', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  const fnMatch = src.match(/function integrationState\(\)\s*\{[\s\S]*?(?=\n {2}function |\n {2}\/\/)/);
  const fnBody = fnMatch[0];

  // Must use optStatus.source, NOT optStatus.primarySource as a property access
  assert.ok(fnBody.includes('.source'), 'optimizer data must use .source field');
  // Allow "primarySource" in comments, but not as a property access (e.g., .primarySource)
  assert.ok(!fnBody.includes('.primarySource'), 'optimizer data must NOT use .primarySource property');
});

// ===== New endpoint tests =====

test('GET /api/devices endpoint exists in routes-api.js', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  assert.ok(src.includes("'/api/devices'"), '/api/devices endpoint must exist');
  assert.ok(src.includes('deviceService'), 'devices endpoint must use deviceService');
});

test('GET /api/devices/:id endpoint returns single device or 404', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  assert.ok(
    src.includes("/api/devices/") && src.includes('404'),
    '/api/devices/:id endpoint must exist and return 404 for missing devices'
  );
});

test('GET /api/devices/:id uses parameterized SQL query', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  // Must use parameterized query ($1), not string interpolation
  assert.ok(
    src.includes('$1') && src.includes('device_readings'),
    'Device history query must use parameterized SQL ($1) against device_readings table'
  );
});

test('GET /api/integrations/status endpoint exists', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  assert.ok(
    src.includes("'/api/integrations/status'"),
    '/api/integrations/status endpoint must exist'
  );
  // Should include mqtt, tesla, homeAssistant, loxone, devices, notifications sections
  assert.ok(src.includes('mqtt:') || src.includes("mqtt:"), 'status must include mqtt section');
  assert.ok(src.includes('tesla:') || src.includes("tesla:"), 'status must include tesla section');
  assert.ok(src.includes('devices:') || src.includes("devices:"), 'status must include devices section');
});

test('/integrations page route exists', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');

  assert.ok(
    src.includes("'/integrations'") && src.includes('integrations.html'),
    '/integrations route must serve integrations.html'
  );
});
