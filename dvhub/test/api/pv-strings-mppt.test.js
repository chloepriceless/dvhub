// test/api/pv-strings-mppt.test.js — T-MPPT-TELEMETRY Endpoint-Vertrag.
// Prueft die Auth-Haltung der beiden neuen Routen:
//   GET /api/pv-strings/mppt             → checkAuth (LAN-ok): Leitstand/Anzeige
//   GET /api/pv-strings/mppt-export.csv  → BEARER-pflichtig (externer pvnode-
//                                          Datenabzug, auch im LAN Token noetig)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../../routes-api.js';
import { buildVictronSnapshot } from '../../runtime-state.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3
const LAN_IP = '192.168.1.66';   // RFC1918
const API_TOKEN = 'mppt-test-token-xxxxxxxxxxxxxxxxxxxx';

function mockRes() {
  const cap = { status: 0, headers: {}, body: '' };
  return {
    _cap: cap,
    writeHead(code, headers) { cap.status = code; Object.assign(cap.headers, headers || {}); },
    setHeader(k, v) { cap.headers[k] = v; },
    write(c) { cap.body += c == null ? '' : String(c); return true; },
    end(p) { if (p != null) cap.body += String(p); cap.closed = true; },
    on() {}, once() {},
  };
}
function makeReq(pathname, { token = null, ip = LAN_IP } = {}) {
  const headers = { host: 'dvhub.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method: 'GET', url: pathname, headers, socket: { remoteAddress: ip }, on() {}, once() {} };
}

function mockCtx() {
  const cfg = {
    apiToken: API_TOKEN,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false },
    security: { lanTrust: 'open', lanCidrs: [], lanSafeGroups: ['status', 'dashboard', 'history', 'forecast', 'integrations'], trustedClientIps: [] },
    pvStrings: { mppt: { labels: { 1: 'Süd' }, kwp: { 1: 9 } } },
    family: {}, gridPositiveMeans: 'grid_import', keepalivePulseSec: 30,
    corsAllowedOrigins: [], allowedHosts: [], notifications: { enabled: false, providers: {} },
    integrations: { tesla: { enabled: false } }, mqtt: {},
  };
  const slotRows = [
    { seriesKey: 'pv_mppt_1_w', ts: '2026-03-09T11:00:00.000Z', sourceKind: 'local_live', kWh: 1, unit: 'kWh' }
  ];
  return {
    state: {
      meter: { ok: true, updatedAt: Date.now(), grid_total_w: 100 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 0, updatedAt: 0, mppt: [{ n: 1, w: 3000, v: null }] },
      epex: { ok: false, data: [], updatedAt: 0 },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: false }, keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0 },
      ctrl: { forcedOff: false }, log: [], forecast: null,
    },
    getCfg: () => cfg, getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigPath: () => '/tmp/config.json', getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '0.9.0-test' }), getTransportType: () => 'modbus',
    getAppDir: () => '/tmp', getRepoRoot: () => '/tmp', getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub', getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: true }), controlValue: () => 'off',
    pushLog: () => {}, telemetrySafeWrite: () => {}, needsSetup: () => false,
    epexNowNext: () => null, expireLeaseIfNeeded: () => {},
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
    healthTracker: { snapshot: () => ({}), recordSample: () => {}, persistSnapshot: async () => {}, loadSnapshot: async () => {}, close: () => {} },
    telemetryStore: {}, db: {},
    pvStrings: {
      mpptOverview: async () => ([{ n: 1, seriesKey: 'pv_mppt_1_w', label: 'Süd', kwp: 9, slots: 1, firstTs: slotRows[0].ts, lastTs: slotRows[0].ts, coverageDays: 1, windowDays: 90, dailyKwh: [{ day: '2026-03-09', kwh: 1 }] }]),
      readMpptSeries: async (n) => (Number(n) === 1 ? { n: 1, seriesKey: 'pv_mppt_1_w', rows: slotRows } : null),
    },
  };
}

async function dispatch(ctx, req) {
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res;
}

describe('T-MPPT-TELEMETRY endpoint auth', () => {
  it('GET /api/pv-strings/mppt ist im LAN ohne Token erreichbar (Tracking)', async () => {
    const res = await dispatch(mockCtx(), makeReq('/api/pv-strings/mppt', { token: null, ip: LAN_IP }));
    assert.equal(res._cap.status, 200, res._cap.body);
    const data = JSON.parse(res._cap.body);
    assert.equal(data.ok, true);
    assert.equal(data.sources[0].n, 1);
    assert.equal(data.sources[0].liveW, 3000);
  });

  // Codex Integration 24.11. (P2): im getrennten Betrieb (DVHUB_ENABLE_RUNTIME_WORKER=1) liest der Poller im
  // Runtime-Prozess; die Web-Seite kennt die Live-Werte nur aus dem Status-Schnappschuss.
  it('getrennter Betrieb: Live-Werte je String kommen aus dem Runtime-Schnappschuss', async () => {
    const ctx = mockCtx();
    delete ctx.state.victron.mppt;
    const worker = buildVictronSnapshot({ soc: 50, mppt: [{ n: 1, w: 2500, v: 410 }] });
    assert.deepEqual(worker.mppt, [{ n: 1, w: 2500, v: 410 }], 'Schnappschuss trägt mppt');
    ctx.getCachedRuntimeStatusPayload = () => ({ victron: worker });
    const res = await dispatch(ctx, makeReq('/api/pv-strings/mppt', { token: null, ip: LAN_IP }));
    assert.equal(res._cap.status, 200, res._cap.body);
    const data = JSON.parse(res._cap.body);
    assert.equal(data.enabled, true);
    assert.equal(data.sources[0].liveW, 2500);
    assert.equal(data.sources[0].liveV, 410);
  });

  it('pvnode-Export verlangt Bearer AUCH im LAN (ohne Token → 401)', async () => {
    const res = await dispatch(mockCtx(), makeReq('/api/pv-strings/mppt-export.csv?n=1', { token: null, ip: LAN_IP }));
    assert.equal(res._cap.status, 401, `erwartet 401, bekam ${res._cap.status}: ${res._cap.body}`);
  });

  it('pvnode-Export mit Token liefert CSV (W je 15-min-Slot)', async () => {
    const res = await dispatch(mockCtx(), makeReq('/api/pv-strings/mppt-export.csv?n=1', { token: API_TOKEN, ip: LAN_IP }));
    assert.equal(res._cap.status, 200, res._cap.body);
    const hdrs = {};
    for (const [k, v] of Object.entries(res._cap.headers)) hdrs[k.toLowerCase()] = v;
    assert.match(String(hdrs['content-type'] || ''), /text\/csv/i);
    assert.match(String(hdrs['content-disposition'] || ''), /filename="pvnode-mppt-1\.csv"/);
    const lines = res._cap.body.trim().split('\n');
    assert.equal(lines[0], 'timestamp;pv_power');
    assert.ok(lines[1].endsWith(';4000'), `1 kWh/900s = 4000 W, bekam: ${lines[1]}`);
  });

  it('pvnode-Export mit Token von extern (remote) ebenfalls erlaubt', async () => {
    const res = await dispatch(mockCtx(), makeReq('/api/pv-strings/mppt-export.csv?n=1', { token: API_TOKEN, ip: REMOTE_IP }));
    assert.equal(res._cap.status, 200, res._cap.body);
  });

  it('ungueltige Modulnummer n=0 → 400', async () => {
    const res = await dispatch(mockCtx(), makeReq('/api/pv-strings/mppt-export.csv?n=0', { token: API_TOKEN, ip: LAN_IP }));
    assert.equal(res._cap.status, 400, res._cap.body);
  });
});
