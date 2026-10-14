// test/pricing-periods-live.test.js — laufende Kosten und Preisübersicht
// beachten die Preis-Zeiträume (Audit 2026-10-14, Befund 3).
//
// Vorher rechneten die laufenden Tageskosten (polling.js) und die Preisübersicht
// (/api/integration/home-assistant, /api/status) nur mit dem Grundtarif —
// ein gültiger Zeitraum (userEnergyPricing.periods) blieb unbeachtet. Die
// Historie nutzte ihn schon (resolveUserImportPriceCtKwhForSlot).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPoller } from '../polling.js';
import { createApiRoutes } from '../routes-api.js';

// Grundtarif 30 ct, im November 40 ct (eigene PV-Kosten 8 ct).
const pricing = {
  mode: 'fixed',
  fixedGrossImportCtKwh: 30,
  costs: { pvCtKwh: 5 },
  periods: [{ id: 'nov', label: 'November', startDate: '2026-11-01', endDate: '2026-11-30', mode: 'fixed', fixedGrossImportCtKwh: 40, costs: { pvCtKwh: 8 } }],
};

test('laufende Kosten: 1 kWh Bezug im November kostet 0,40 € (nicht 0,30 €)', () => {
  const t0 = Date.parse('2026-11-02T10:00:00Z');
  const state = {
    meter: {}, victron: {}, ctrl: {},
    energy: { day: '2026-11-02', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: t0 },
  };
  const cfg = { epex: { timezone: 'Europe/Berlin' }, schedule: { timezone: 'Europe/Berlin' }, gridPositiveMeans: 'grid_import', userEnergyPricing: pricing };
  const poller = createPoller({ state, getCfg: () => cfg, transport: {}, pushLog: () => {}, epexNowNext: () => ({ current: { ct_kwh: 10 } }) });
  poller.updateEnergyIntegrals(t0 + 3_600_000, 1000);   // 1000 W Bezug über 1 h
  assert.equal(Number(state.energy.importWh.toFixed(6)), 1000);
  assert.equal(Number(state.energy.costEur.toFixed(6)), 0.4);
});

test('laufende Kosten: außerhalb des Zeitraums gilt der Grundtarif', () => {
  const t0 = Date.parse('2026-10-31T10:00:00Z');
  const state = { meter: {}, victron: {}, ctrl: {}, energy: { day: '2026-10-31', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: t0 } };
  const cfg = { epex: { timezone: 'Europe/Berlin' }, schedule: { timezone: 'Europe/Berlin' }, gridPositiveMeans: 'grid_import', userEnergyPricing: pricing };
  const poller = createPoller({ state, getCfg: () => cfg, transport: {}, pushLog: () => {}, epexNowNext: () => ({ current: { ct_kwh: 10 } }) });
  poller.updateEnergyIntegrals(t0 + 3_600_000, 1000);
  assert.equal(Number(state.energy.costEur.toFixed(6)), 0.3);
});

test('Preisübersicht: Slots und aktueller Preis je nach gültigem Zeitraum', async () => {
  const oct = { ts: Date.parse('2026-10-31T12:00:00Z'), ct_kwh: 10, eur_mwh: 100 };
  const nov = { ts: Date.parse('2026-11-02T12:00:00Z'), ct_kwh: 10, eur_mwh: 100 };
  const cfg = {
    apiToken: '', schedule: { timezone: 'Europe/Berlin' }, epex: { timezone: 'Europe/Berlin' },
    gridPositiveMeans: 'grid_import', userEnergyPricing: pricing, corsAllowedOrigins: [], allowedHosts: [],
  };
  const ctx = {
    state: {
      meter: { grid_total_w: 0 }, victron: {}, ctrl: { forcedOff: false },
      epex: { ok: true, data: [oct, nov] },
      energy: { day: '2026-11-02', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {} },
      keepalive: { appPulse: {} }, telemetry: {}, log: [],
    },
    getCfg: () => cfg, getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getAppVersion: () => ({ version: '0.0.0-test' }),
    controlValue: () => 'off', pushLog: () => {}, telemetrySafeWrite: () => {},
    needsSetup: () => false, expireLeaseIfNeeded: () => {},
    epexNowNext: () => ({ current: nov, next: null }),
  };
  const res = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b; } };
  const req = Readable.from([]);
  Object.assign(req, { method: 'GET', url: '/api/integration/home-assistant', headers: { host: 'dvhub.test' }, socket: { remoteAddress: '192.168.1.20' } });
  await createApiRoutes(ctx).handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
  assert.equal(res.status, 200, res.body);
  const out = JSON.parse(res.body);
  const p = out.userEnergyPricing;
  assert.deepEqual(p.slots.map((s) => s.importPriceCtKwh), [30, 40]);
  assert.equal(p.slots[1].pvMarginCtKwh, 2);          // 10 − 8 (Kosten des Zeitraums)
  assert.equal(p.current.importPriceCtKwh, 40);
  assert.equal(p.fixedGrossImportCtKwh, 40);
  assert.equal(p.costs.pvCtKwh, 8);
  assert.equal(out.costs.userImportPriceNowCtKwh, 40);
});
