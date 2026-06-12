// test/eeg-extension.test.js — §51a EEG Förderzeitraum-Verlängerung (T-0004).
// Mechanics verified against https://www.gesetze-im-internet.de/eeg_2014/__51a.html
// (EEG 2023 i.d.F. Solarspitzengesetz, fetched 2026-06-13).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VLVS_MONTH_TABLE,
  vollastViertelstunden,
  legacyExtensionDays,
  extensionFromVollast,
  countNegativeQuarterSlots
} from '../eeg-extension.js';

test('§51a Abs. 2 S. 3 month table matches the statute (Jan 87 … Dez 73, total 3800)', () => {
  assert.deepEqual(VLVS_MONTH_TABLE, [87, 189, 340, 442, 490, 508, 498, 453, 371, 231, 118, 73]);
  assert.equal(VLVS_MONTH_TABLE.reduce((a, b) => a + b, 0), 3800);
});

test('vollastViertelstunden: ×0.5 rounded UP to the next full quarter-hour', () => {
  assert.equal(vollastViertelstunden(0), 0);
  assert.equal(vollastViertelstunden(1), 1, 'ceil(0.5) = 1');
  assert.equal(vollastViertelstunden(2), 1);
  assert.equal(vollastViertelstunden(3), 2, 'ceil(1.5) = 2');
  assert.equal(vollastViertelstunden(304), 152); // Mai 2026: 76 h = 304 slots
  assert.equal(vollastViertelstunden(-5), 0);
  assert.equal(vollastViertelstunden(NaN), 0);
});

test('legacyExtensionDays (Abs. 1): quarter-hours rounded UP to full calendar days', () => {
  assert.equal(legacyExtensionDays(0), 0);
  assert.equal(legacyExtensionDays(1), 1);
  assert.equal(legacyExtensionDays(96), 1);
  assert.equal(legacyExtensionDays(97), 2);
});

test('extensionFromVollast: consumption starts with January (87 VLVS = exactly 1 month)', () => {
  const exactJan = extensionFromVollast(87);
  assert.equal(exactJan.fullMonths, 1);
  assert.equal(exactJan.accruedMonths, 1);
  assert.equal(exactJan.legalMonths, 1);
  assert.equal(exactJan.lastMonthName, 'Januar');

  // 88 VLVS: January full + 1/189 of February. Legal extension runs to the
  // END of the started month → 2 legal months.
  const intoFeb = extensionFromVollast(88);
  assert.equal(intoFeb.fullMonths, 1);
  assert.equal(intoFeb.legalMonths, 2);
  assert.equal(intoFeb.lastMonthName, 'Februar');
  assert.ok(Math.abs(intoFeb.accruedMonths - (1 + 1 / 189)) < 0.01);

  // Partial January only.
  const half = extensionFromVollast(44);
  assert.equal(half.fullMonths, 0);
  assert.equal(half.legalMonths, 1);
  assert.ok(Math.abs(half.accruedMonths - 44 / 87) < 0.01);

  assert.deepEqual(extensionFromVollast(0), { fullMonths: 0, accruedMonths: 0, legalMonths: 0, lastMonthName: null });
});

test('extensionFromVollast: a full table year (3800) = 12 months; wraps into year 2', () => {
  const year = extensionFromVollast(3800);
  assert.equal(year.fullMonths, 12);
  assert.equal(year.legalMonths, 12);
  assert.equal(year.lastMonthName, 'Dezember');

  const wrapped = extensionFromVollast(3800 + 87);
  assert.equal(wrapped.fullMonths, 13);
  assert.equal(wrapped.legalMonths, 13);
  assert.equal(wrapped.lastMonthName, 'Januar');
});

test('countNegativeQuarterSlots: counts price<0 rows, tracks coverage window', () => {
  const rows = [
    { ts: '2026-06-01T10:00:00Z', value: 5.2 },
    { ts: '2026-06-01T12:00:00Z', value: -0.01 },
    { ts: '2026-06-01T12:15:00Z', value: -3 },
    { ts: '2026-06-01T12:30:00Z', value: 0 },     // exactly 0 → NOT negative
    { ts: '2026-06-01T13:00:00Z', value: NaN },   // unparseable → ignored
  ];
  const out = countNegativeQuarterSlots(rows);
  assert.equal(out.count, 2);
  assert.equal(out.firstTs, '2026-06-01T10:00:00Z');
  assert.equal(out.lastTs, '2026-06-01T12:30:00Z');
  assert.deepEqual(countNegativeQuarterSlots([]), { count: 0, firstTs: null, lastTs: null });
});

// ── Endpoint /api/eeg/extension (minimal-ctx harness) ───────────────────────

import { createApiRoutes } from '../routes-api.js';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    setHeader(k, v) { captured.headers[k] = v; },
    end(payload) { captured.body = payload == null ? '' : String(payload); },
    _captured: captured,
  };
}

function makeCtx({ pvPlants = [], priceRows = [] } = {}) {
  const cfg = {
    apiToken: null,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: true },
    family: {},
    userEnergyPricing: { pvPlants },
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
  };
  return {
    state: {
      meter: { ok: false, updatedAt: 0, grid_total_w: 0 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 0, updatedAt: 0 },
      epex: { ok: false, data: [] },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: true, ok: true },
      keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0 },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: 0, dvControl: null },
      log: [],
      forecast: null,
    },
    telemetryStore: {
      querySeries: async () => priceRows,
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
    persistConfig: () => {},
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
  };
}

async function callExtension(ctx) {
  const routes = createApiRoutes(ctx);
  const req = { method: 'GET', url: '/api/eeg/extension', headers: { host: 'dvhub.test' }, socket: { remoteAddress: '192.168.1.5' } };
  const res = mockRes();
  await routes.handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
  return { status: res._captured.status, body: res._captured.body ? JSON.parse(res._captured.body) : null };
}

test('GET /api/eeg/extension: 15-min plant → counts, VLVS and month conversion', async () => {
  // 3 negative slots → ceil(1.5) = 2 VLVS → 2/87 months accrued, 1 legal month.
  const priceRows = [
    { key: 'price_ct_kwh', ts: '2026-06-01T11:00:00Z', value: 4 },
    { key: 'price_ct_kwh', ts: '2026-06-01T12:00:00Z', value: -1 },
    { key: 'price_ct_kwh', ts: '2026-06-01T12:15:00Z', value: -2 },
    { key: 'price_ct_kwh', ts: '2026-06-01T12:30:00Z', value: -0.5 },
  ];
  const ctx = makeCtx({ pvPlants: [{ kwp: 30, commissionedAt: '2025-06-01' }], priceRows });
  const out = await callExtension(ctx);
  assert.equal(out.status, 200);
  assert.equal(out.body.applicable, true);
  assert.equal(out.body.rule, '15min');
  assert.equal(out.body.negQuarterSlots, 3);
  assert.equal(out.body.vollastViertelstunden, 2);
  assert.equal(out.body.extension.legalMonths, 1);
  assert.ok(Math.abs(out.body.extension.accruedMonths - 2 / 87) < 0.01);
});

test('GET /api/eeg/extension: no commissioning date → applicable:false with reason', async () => {
  const ctx = makeCtx({ pvPlants: [] });
  const out = await callExtension(ctx);
  assert.equal(out.status, 200);
  assert.equal(out.body.applicable, false);
  assert.match(out.body.reason, /Inbetriebnahmedatum/);
});

test('GET /api/eeg/extension: pre-2025-02-25 plant (hour rule) → applicable:false, rule surfaced', async () => {
  const ctx = makeCtx({ pvPlants: [{ kwp: 30, commissionedAt: '2024-01-01' }] });
  const out = await callExtension(ctx);
  assert.equal(out.status, 200);
  assert.equal(out.body.applicable, false);
  assert.notEqual(out.body.rule, '15min');
});

test('countNegativeQuarterSlots: one row = one quarter-hour regardless of resolution stamp', () => {
  // Prod data verified 2026-06-13: rows stamped resolution=3600 ARE 15-min
  // slots (96/day, :00/:15/:30/:45 — ingest mis-stamp since 2026-03-26).
  // Weighing by the stamp would overcount 4×; the counter must ignore it.
  const rows = [
    { ts: '2026-04-10T12:00:00Z', value: -1, resolution: 3600 },
    { ts: '2026-04-10T12:15:00Z', value: 2, resolution: 3600 },
    { ts: '2026-04-09T12:00:00Z', value: -1, resolution: 900 },
  ];
  const out = countNegativeQuarterSlots(rows);
  assert.equal(out.count, 2);
});
