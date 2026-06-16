// test/family-routes.test.js -- Unit tests for /api/family/* route branches
// and LAN_SAFE_ENDPOINTS membership. Uses file-level regex assertions for
// LAN allowlist + handler branch structure (no full HTTP server spin-up).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_API_PATH = path.resolve(__dirname, '..', 'routes-api.js');
const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

describe('family routes file integration (static checks)', () => {
  it('LAN_SAFE_ENDPOINTS contains /api/family/status', () => {
    const src = readFile(ROUTES_API_PATH);
    const match = src.match(/const\s+LAN_SAFE_ENDPOINTS\s*=\s*new Set\(\[([\s\S]*?)\]\s*\)/);
    assert.ok(match, 'LAN_SAFE_ENDPOINTS declaration must exist');
    const body = match[1];
    assert.match(body, /'\/api\/family\/status'/, 'allowlist must include /api/family/status');
  });

  it('LAN_SAFE_ENDPOINTS contains /api/family/presence (GET)', () => {
    const src = readFile(ROUTES_API_PATH);
    const match = src.match(/const\s+LAN_SAFE_ENDPOINTS\s*=\s*new Set\(\[([\s\S]*?)\]\s*\)/);
    assert.ok(match);
    assert.match(match[1], /'\/api\/family\/presence'/);
  });

  it('LAN_SAFE_ENDPOINTS contains /api/family/tile-history (Plan 11-03 D-14)', () => {
    // The token-less kiosk panel chart fetches tile history; the GET-only LAN
    // bypass is mandatory. The POST /api/family/mqtt-tiles stays OUT.
    const src = readFile(ROUTES_API_PATH);
    const match = src.match(/const\s+LAN_SAFE_ENDPOINTS\s*=\s*new Set\(\[([\s\S]*?)\]\s*\)/);
    assert.ok(match, 'LAN_SAFE_ENDPOINTS declaration must exist');
    assert.match(match[1], /'\/api\/family\/tile-history'/,
      'allowlist must include /api/family/tile-history');
  });

  it('registers a GET /api/family/tile-history branch querying mqtt_tile_<id>', () => {
    const src = readFile(ROUTES_API_PATH);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/family\/tile-history['"][\s\S]{0,120}req\.method\s*===\s*['"]GET['"]/);
    // Series-key convention from Plan 02: 'mqtt_tile_' + id.
    assert.match(src, /seriesKeys:\s*\[\s*'mqtt_tile_'\s*\+\s*id\s*\]/);
    // V5 input clip — id pattern-restricted before use.
    assert.match(src, /\.replace\(\/\[\^a-zA-Z0-9_-\]\/g,\s*''\)/);
  });

  it('LAN_SAFE_ENDPOINTS contains /api/family/tesla-history (Plan 11-06 round 10)', () => {
    // The token-less kiosk EV-panel charge-history chart fetches tesla history;
    // the GET-only LAN bypass is mandatory — a sibling of tile-history.
    const src = readFile(ROUTES_API_PATH);
    const match = src.match(/const\s+LAN_SAFE_ENDPOINTS\s*=\s*new Set\(\[([\s\S]*?)\]\s*\)/);
    assert.ok(match, 'LAN_SAFE_ENDPOINTS declaration must exist');
    assert.match(match[1], /'\/api\/family\/tesla-history'/,
      'allowlist must include /api/family/tesla-history');
  });

  it('registers a GET /api/family/tesla-history branch querying the fixed tesla_* series', () => {
    const src = readFile(ROUTES_API_PATH);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/family\/tesla-history['"][\s\S]{0,120}req\.method\s*===\s*['"]GET['"]/);
    // Fixed server-side series allowlist — no request-controlled series key.
    assert.match(src, /seriesKeys\s*=\s*\[\s*'tesla_charger_power'\s*,\s*'tesla_battery_level'\s*\]/);
    // `days` is parsed + clamped to a bounded 1..31 window.
    assert.match(src, /Math\.max\(1,\s*Math\.min\(31,\s*rawDays\)\)/);
  });

  it('registers a GET /api/family/status branch that calls familyService.buildFamilyStatus', () => {
    const src = readFile(ROUTES_API_PATH);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/family\/status['"]/);
    assert.match(src, /familyService\.buildFamilyStatus/);
  });

  it('family/status handler uses ctx.familyService null-check (503 fallback)', () => {
    const src = readFile(ROUTES_API_PATH);
    assert.match(src, /ctx\.familyService/);
    // Must reference 503 and a "not available" message in the handler
    assert.match(src, /503[\s\S]{0,200}family service not available/);
  });

  it('family/status handler catches errors and logs family_api_error', () => {
    const src = readFile(ROUTES_API_PATH);
    assert.match(src, /family_api_error/);
    assert.match(src, /family status failed/);
  });

  it('registers a GET /api/family/presence branch returning getPresence', () => {
    const src = readFile(ROUTES_API_PATH);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/family\/presence['"][\s\S]{0,120}req\.method\s*===\s*['"]GET['"]/);
    assert.match(src, /familyService\.getPresence/);
  });

  it('registers a POST /api/family/presence branch calling setPresence with parseBody', () => {
    const src = readFile(ROUTES_API_PATH);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/family\/presence['"][\s\S]{0,120}req\.method\s*===\s*['"]POST['"]/);
    assert.match(src, /familyService\.setPresence/);
    // Must use parseBody to read the JSON body (already imported from server-utils)
    assert.match(src, /parseBody\s*\(\s*req\s*\)/);
  });

  it('POST /api/family/presence is NOT added to LAN allowlist (only GET is)', () => {
    // This is enforced by isLanSafeRequest rejecting non-GET — we assert the
    // allowlist Set contains the path (which only matters for GET) and trust
    // the existing isLanSafeRequest logic. No POST-specific allowlist exists.
    const src = readFile(ROUTES_API_PATH);
    assert.match(src, /if \(req\.method !== 'GET'\) return false/);
  });
});

// --- Plan 11-03: per-tile icon/color allowlist (D-01/D-03) ---------------
// The POST /api/family/mqtt-tiles normaliser must accept + allowlist-clip a
// per-tile `icon` (curated emoji grid) and `color` (8-hex swatch palette).
// Keys are ADDITIVE OPTIONAL — written only when present AND on-allowlist, so
// an unset/off-allowlist value leaves the key absent and the client
// auto-derives (D-02/D-04). See 11-UI-SPEC.md for the fixed value sets.
// Phase 11-04 (checkpoint feedback) expanded the emoji grid from 28 to 48
// glyphs (8×6); ICONS below is the updated set and MUST stay byte-identical to
// FAMILY_TILE_ICON_ALLOWLIST (routes-api.js) and MTE_EMOJIS (integrations.js).

describe('mqtt-tiles POST normaliser — icon/color allowlists (D-01/D-03)', () => {
  const ICONS = [
    '⚡', '🔋', '☀️', '🔌', '💡', '🏠', '🌡️', '🪫',
    '💧', '🔥', '❄️', '💨', '🌬️', '☁️', '🌧️', '🌀',
    '🪭', '🔆', '🕯️', '🌫️', '🌪️', '🫧', '♻️', '🧯',
    '🛋️', '🛏️', '🚪', '🚿', '🍳', '🧺', '🪟', '🛁',
    '🚰', '🚽', '☕', '🍽️', '🧊', '🧴', '🔔', '🪥',
    '🚗', '📡', '🖥️', '📺', '🔊', '🌿', '🐾', '💻',
  ];
  const COLORS = [
    '#F7B731', '#26de81', '#4b7bec', '#22d3ee',
    '#a55eea', '#fd9644', '#ff6b6b', '#78909c',
  ];

  it('declares FAMILY_TILE_ICON_ALLOWLIST (declaration + use)', () => {
    const src = readFile(ROUTES_API_PATH);
    const count = (src.match(/FAMILY_TILE_ICON_ALLOWLIST/g) || []).length;
    assert.ok(count >= 2, `FAMILY_TILE_ICON_ALLOWLIST must appear >=2 times (got ${count})`);
  });

  it('declares FAMILY_TILE_COLOR_ALLOWLIST (declaration + use)', () => {
    const src = readFile(ROUTES_API_PATH);
    const count = (src.match(/FAMILY_TILE_COLOR_ALLOWLIST/g) || []).length;
    assert.ok(count >= 2, `FAMILY_TILE_COLOR_ALLOWLIST must appear >=2 times (got ${count})`);
  });

  it('contains all 48 curated emoji from 11-UI-SPEC (Phase 11-04 expansion)', () => {
    const src = readFile(ROUTES_API_PATH);
    assert.equal(ICONS.length, 48, 'the curated emoji set is 48 glyphs');
    for (const ic of ICONS) {
      assert.ok(src.includes(ic), `routes-api.js must contain icon ${ic}`);
    }
  });

  it('contains all 8 curated colour hexes from 11-UI-SPEC (case-exact)', () => {
    const src = readFile(ROUTES_API_PATH);
    for (const col of COLORS) {
      assert.ok(src.includes(col), `routes-api.js must contain colour ${col}`);
    }
  });

  it('assigns tile.icon only when guarded by an ICON_ALLOWLIST membership check', () => {
    const src = readFile(ROUTES_API_PATH);
    // The additive idiom: `if (icon && FAMILY_TILE_ICON_ALLOWLIST.has(icon)) tile.icon = icon;`
    assert.match(
      src,
      /if\s*\(\s*icon\s*&&\s*FAMILY_TILE_ICON_ALLOWLIST\.has\(icon\)\s*\)\s*tile\.icon\s*=\s*icon/,
      'tile.icon must be conditionally assigned behind an allowlist .has() guard',
    );
  });

  it('assigns tile.color only when guarded by a COLOR_ALLOWLIST membership check', () => {
    const src = readFile(ROUTES_API_PATH);
    assert.match(
      src,
      /if\s*\(\s*color\s*&&\s*FAMILY_TILE_COLOR_ALLOWLIST\.has\(color\)\s*\)\s*tile\.color\s*=\s*color/,
      'tile.color must be conditionally assigned behind an allowlist .has() guard',
    );
  });

  it('does NOT introduce a partial POST /api/config in the mqtt-tiles handler', () => {
    const src = readFile(ROUTES_API_PATH);
    // The mqtt-tiles POST handler section must persist via saveAndApplyConfig,
    // not via a /api/config POST. Slice the handler region and assert.
    const start = src.indexOf("'/api/family/mqtt-tiles' && req.method === 'POST'");
    assert.ok(start > 0, 'mqtt-tiles POST handler must exist');
    // 4200-char window — widened from 3200 by Phase 11-04 (the 48-emoji
    // allowlist + its comment grew the handler region; saveAndApplyConfig must
    // still fall inside the slice). Same fragility 11-03 fixed once before.
    const region = src.slice(start, start + 4200);
    assert.ok(!/url\.pathname\s*===\s*['"]\/api\/config['"]/.test(region),
      'mqtt-tiles handler must not POST to /api/config');
    assert.match(region, /saveAndApplyConfig/, 'must persist via saveAndApplyConfig');
  });
});

describe('family service wiring in server.js', () => {
  it('imports createFamilyService from services/family', () => {
    const src = readFile(SERVER_PATH);
    assert.match(src, /import\s*{\s*createFamilyService\s*}\s*from\s*['"]\.\/services\/family\/index\.js['"]/);
  });

  it('wires ctx.familyService via createFamilyService(ctx)', () => {
    const src = readFile(SERVER_PATH);
    assert.match(src, /createFamilyService\(\s*ctx\s*\)/);
    assert.match(src, /ctx\.familyService\s*=/);
  });

  it('calls familyService.start() during bootstrap', () => {
    const src = readFile(SERVER_PATH);
    assert.match(src, /familyService\.start\(\)/);
  });

  it('calls familyService.close() during shutdown', () => {
    const src = readFile(SERVER_PATH);
    assert.match(src, /familyService\.close\(\)/);
  });
});

// --- Route handler smoke test using a synthesized req/res ---
//
// We invoke createApiRoutes(ctx) with a mock ctx and drive handleRequest
// directly to exercise the /api/family/status branch end-to-end.

import { createApiRoutes } from '../routes-api.js';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured
  };
}

function mockCtx(overrides = {}) {
  return {
    // Phase 17 Plan 04: license-gate requires ctx.licenseService.requirePro.
    // Default to an always-allow stub so the pre-existing /api/family/*
    // integration tests below keep exercising the GREEN-path business logic
    // (gate is covered by license-routes.test.js). Tests that need to assert
    // the 403 gate can override with a 403-returning stub.
    licenseService: { requirePro: () => true },
    state: {
      meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 0, gridImportW: 0, gridExportW: 0, updatedAt: 0 },
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
      family: { screensaver: { enabled: true, defaultTimeoutSec: 120, windows: [], dimOpacity: 0.3 }, presence: { pollIntervalMs: 2000, webhookEnabled: true } },
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
    getRawCfg: () => ({}),
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigDefinition: () => [],
    getAppVersion: () => '1.0.0-test',
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
    saveAndApplyConfig: () => ({ ok: true }),
    scheduleServiceRestart: () => {},
    runServiceCommand: async () => ({ ok: true }),
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    assertValidRuntimeCommand: () => {},
    epexNowNext: () => null,
    ...overrides
  };
}

describe('handleRequest /api/family/status integration', () => {
  it('returns 200 { ok: true, ...payload } when familyService present', async () => {
    const fakePayload = {
      now: 1234567890,
      energy: { solarKw: 1.2, homeKw: 0.8, gridKw: -0.4, feedingToGrid: true, surplus: true, batteryKw: 0, evKw: 0 },
      battery: { socPct: 50, powerKw: 0, mode: 'idle', capacityKwh: 10, runtimeHours: null, strings: [] },
      ev: { powerKw: 0, socPct: null, mode: 'idle', finishEstIso: null, vehicles: [] },
      devices: [],
      forecast: null,
      price: { nowCtKwh: null, nextHourCtKwh: null, todayMinCtKwh: null, todayMaxCtKwh: null, slots: [] },
      optimizer: { enabled: false },
      savings: { todayEur: '0.00', monthEur: '0', feedInRevenueEur: '0.00', avoidedCostEur: '0.00' },
      greeting: { hello: 'Guten Tag', message: '', mood: 'good', moodLabel: '', time: '12:00', date: '' },
      presence: { detected: false, source: null, updatedAt: 0 },
      config: { screensaver: null, presence: null }
    };
    const ctx = mockCtx({
      familyService: {
        buildFamilyStatus: () => fakePayload,
        getPresence: () => ({ detected: false, source: null, updatedAt: 0 }),
        setPresence: () => {}
      }
    });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/family/status');
    await routes.handleRequest({ method: 'GET', url: '/api/family/status', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }, res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, true);
    assert.equal(body.now, 1234567890);
    assert.ok(body.energy);
    assert.ok('presence' in body);
  });

  it('returns 503 when familyService is missing', async () => {
    const ctx = mockCtx({ familyService: null });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/family/status');
    await routes.handleRequest({ method: 'GET', url: '/api/family/status', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }, res, url);
    assert.equal(res._captured.status, 503);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /family service not available/);
  });

  it('returns 500 and logs family_api_error when buildFamilyStatus throws', async () => {
    const logs = [];
    const ctx = mockCtx({
      pushLog: (t, d) => logs.push({ t, d }),
      familyService: {
        buildFamilyStatus: () => { throw new Error('boom'); },
        getPresence: () => ({ detected: false, source: null, updatedAt: 0 }),
        setPresence: () => {}
      }
    });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/family/status');
    await routes.handleRequest({ method: 'GET', url: '/api/family/status', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }, res, url);
    assert.equal(res._captured.status, 500);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /family status failed/);
    const errLog = logs.find(l => l.t === 'family_api_error');
    assert.ok(errLog, 'pushLog family_api_error must be called');
  });

  it('GET /api/family/presence returns { ok: true, ...snapshot }', async () => {
    const snapshot = { detected: true, source: 'loxone', updatedAt: 12345 };
    const ctx = mockCtx({
      familyService: {
        buildFamilyStatus: () => ({}),
        getPresence: () => snapshot,
        setPresence: () => {}
      }
    });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    const url = new URL('http://localhost/api/family/presence');
    await routes.handleRequest({ method: 'GET', url: '/api/family/presence', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }, res, url);
    assert.equal(res._captured.status, 200);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, true);
    assert.equal(body.detected, true);
    assert.equal(body.source, 'loxone');
    assert.equal(body.updatedAt, 12345);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 17 Plan 04 — Option B coverage: LAN-source-IP + no Bearer + license
// !== 'active' must STILL produce 403 from each LAN_SAFE_ENDPOINTS family
// endpoint, AND license === 'active' with the same LAN-no-Bearer request must
// produce 200 (preserves D-14's token-less kiosk flow for activated boxes).
//
// Proves both halves of the design:
//   (1) the gate inside the handler runs AFTER LAN-bypass already accepted
//       the request — so a kiosk without licence still sees 403;
//   (2) once licence is active, the LAN kiosk works exactly as today (no
//       Bearer required from LAN).
// ─────────────────────────────────────────────────────────────────────────────

// Build a licenseService stub whose requirePro mimics the real 403 contract
// (status='active' → return true; else write 403 pro_required body and
// return false). Mirrors services/license/index.js requirePro semantics.
function makeLicenseStub(status) {
  return {
    requirePro(req, res, featureName) {
      if (status === 'active') return true;
      const body = JSON.stringify({ error: 'pro_required', feature: featureName });
      res.writeHead(403, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body, 'utf8')
      });
      res.end(body);
      return false;
    }
  };
}

// makeReqLanNoBearer simulates the kiosk shape: a private-range remoteAddress,
// NO Authorization header. checkAuth's isLocalNetworkRequest path accepts it
// (192.168.0.0/16 — RFC 1918), and the family handler is then where the
// requirePro gate fires.
function makeReqLanNoBearer(method, pathname, body) {
  const rawBody = body ? JSON.stringify(body) : '';
  const req = {
    method,
    url: pathname,
    headers: { host: 'localhost' }, // NO Authorization
    socket: { remoteAddress: '192.168.1.50' }, // LAN — RFC 1918
    _body: rawBody,
    _listeners: {},
    on(event, cb) {
      if (event === 'data' && req._body) {
        setTimeout(() => cb(Buffer.from(req._body)), 0);
        setTimeout(() => { const endCb = req._listeners['end']; if (endCb) endCb(); }, 1);
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

describe('Family LAN-bypass + license gate (Option B / CONTEXT Amendment)', () => {
  // Only the GET endpoints that join LAN_SAFE_ENDPOINTS are exercised here —
  // POST endpoints don't get LAN-bypass (isLanSafeRequest enforces method='GET')
  // so a no-Bearer POST hits 401 before requirePro. The 4 LAN-safe Family GETs:
  const lanEndpoints = [
    '/api/family/status',
    '/api/family/presence',
    '/api/family/tile-history?id=plug1',
    '/api/family/tesla-history',
  ];

  for (const path of lanEndpoints) {
    for (const status of ['none', 'invalid', 'expired', 'suspended']) {
      it(`${path} with LAN source + no Bearer + status=${status} → 403`, async () => {
        const ctx = mockCtx({
          licenseService: makeLicenseStub(status),
          familyService: {
            buildFamilyStatus: () => ({}),
            getPresence: () => ({ detected: false, source: null, updatedAt: 0 }),
            setPresence: () => {}
          },
          // tile-history/tesla-history reach into ctx.telemetryStore + getRawCfg
          // — handlers return 403 BEFORE they get there, but stubs are safe.
          telemetryStore: { querySeries: async () => [] },
          getRawCfg: () => ({ family: { mqttTiles: [{ id: 'plug1', topic: 't/plug1', label: 'Plug 1' }] } })
        });
        const routes = createApiRoutes(ctx);
        const res = mockRes();
        const pathname = path.split('?')[0];
        await routes.handleRequest(
          makeReqLanNoBearer('GET', path),
          res,
          new URL('http://localhost' + path)
        );
        assert.equal(res._captured.status, 403,
          `${path}@${status}: expected 403, got ${res._captured.status} body=${res._captured.body}`);
        const body = JSON.parse(res._captured.body);
        assert.equal(body.error, 'pro_required');
        assert.equal(body.feature, 'family-dashboard');
      });
    }

    it(`${path} with LAN source + no Bearer + status=active → 200 (D-14 kiosk flow preserved)`, async () => {
      const ctx = mockCtx({
        licenseService: makeLicenseStub('active'),
        familyService: {
          buildFamilyStatus: () => ({ now: 1, energy: {}, presence: {} }),
          getPresence: () => ({ detected: false, source: null, updatedAt: 0 }),
          setPresence: () => {}
        },
        telemetryStore: { querySeries: async () => [] },
        getRawCfg: () => ({ family: { mqttTiles: [{ id: 'plug1', topic: 't/plug1', label: 'Plug 1' }] } })
      });
      const routes = createApiRoutes(ctx);
      const res = mockRes();
      await routes.handleRequest(
        makeReqLanNoBearer('GET', path),
        res,
        new URL('http://localhost' + path)
      );
      assert.equal(res._captured.status, 200,
        `${path}@active: expected 200, got ${res._captured.status} body=${res._captured.body}`);
      const body = JSON.parse(res._captured.body);
      assert.equal(body.ok, true);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 24 Plan 04 — /family.html static-shell Pro-Gate (T-24-PRO-SHELL)
//
// /family (no .html) is gated via requirePro('family-dashboard'), but a direct
// GET /family.html previously matched NO route in handleRequest → fell through
// to serveStatic → served public/family.html RAW (path/MIME check only, no
// gate). That is a Pro-gate bypass via the static shell. This plan adds an
// explicit '/family.html' route with the SAME requirePro guard BEFORE the
// static fallback. The inert assets /family.js + /family.css stay UNGATED
// (T-24-ASSET-OVERGATE: source-only, no shell → accept).
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 24-04 /family.html shell behind the Pro-gate (T-24-PRO-SHELL)', () => {
  it('registers an explicit GET /family.html branch in handleRequest', () => {
    const src = readFile(ROUTES_API_PATH);
    assert.match(
      src,
      /url\.pathname\s*===\s*['"]\/family\.html['"][\s\S]{0,120}req\.method\s*===\s*['"]GET['"]/,
      'an explicit /family.html GET branch must exist (before the static fallback)',
    );
  });

  it('gates the /family.html branch with requirePro(req, res, \'family-dashboard\')', () => {
    const src = readFile(ROUTES_API_PATH);
    // Slice the region from the /family.html branch and assert the requirePro
    // guard fires inside it, in front of the servePage call.
    const start = src.indexOf("'/family.html'");
    assert.ok(start > 0, '/family.html branch must exist');
    const region = src.slice(start, start + 300);
    assert.match(
      region,
      /requirePro\(\s*req\s*,\s*res\s*,\s*['"]family-dashboard['"]\s*\)/,
      'the /family.html branch must call requirePro(req,res,\'family-dashboard\') before serving',
    );
    assert.match(
      region,
      /servePage\(\s*res\s*,\s*['"]family\.html['"]\s*\)/,
      'the /family.html branch must serve family.html via servePage after the gate',
    );
  });

  it('does NOT gate /family.js or /family.css (inert assets stay ungated — T-24-ASSET-OVERGATE)', () => {
    const src = readFile(ROUTES_API_PATH);
    // Negative assertion: no requirePro-gated explicit route is added for the
    // static asset paths. There must be NO '/family.js' or '/family.css'
    // pathname branch carrying a requirePro guard.
    assert.doesNotMatch(
      src,
      /url\.pathname\s*===\s*['"]\/family\.js['"][\s\S]{0,200}requirePro/,
      '/family.js must stay ungated (inert source without the shell)',
    );
    assert.doesNotMatch(
      src,
      /url\.pathname\s*===\s*['"]\/family\.css['"][\s\S]{0,200}requirePro/,
      '/family.css must stay ungated (inert source without the shell)',
    );
  });
});
