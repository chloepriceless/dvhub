// test/family-ev-stop.test.js — „Aus“ im Familien-Dashboard nutzt „Laden
// stoppen“ (2026-10-15, Christin: „stelle den dortigen Stop auf die neue
// Variante um“). Vorher setzte „Aus“ nur den Lademodus — der hielt nicht gegen
// den EOS-Plan (die Brücke stellte evcc im nächsten Takt zurück).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

function makeCtx({ stopActive = false, bridge = true } = {}) {
  const calls = [];
  let override = stopActive ? { kind: 'stop' } : null;
  const ctx = {
    calls,
    state: { meter: {}, victron: {}, epex: { data: [] }, energy: {}, telemetry: {}, keepalive: { appPulse: {} }, log: [],
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {} }, ctrl: {} },
    getCfg: () => ({ apiToken: null, corsAllowedOrigins: [], allowedHosts: [], gridPositiveMeans: 'grid_import' }),
    getRawCfg: () => ({}),
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getAppVersion: () => ({ version: '0.0.0-test' }),
    controlValue: () => 'off', pushLog: () => {}, telemetrySafeWrite: () => {}, needsSetup: () => false,
    expireLeaseIfNeeded: () => {}, epexNowNext: () => null,
    licenseService: { requirePro: () => true, isProActive: () => true },
    mainWallbox: { setMode: async (mode, lp) => { calls.push(['setMode', mode, lp]); return { ok: true, mode }; } },
  };
  if (bridge) {
    ctx.eosEvccBridge = {
      getOverride: () => override,
      setOverride: async (o) => { calls.push(['setOverride', o]); override = { kind: o.kind }; return { ok: true, override, result: { ok: true } }; },
      clearOverride: async () => { calls.push(['clearOverride']); override = null; return { ok: true, override: null }; },
    };
  }
  return ctx;
}

async function post(ctx, body) {
  const routes = createApiRoutes(ctx);
  const req = {
    method: 'POST', url: '/api/family/evcc/mode', headers: { host: 'dvhub.test', 'content-type': 'application/json' },
    socket: { remoteAddress: '192.168.1.20' },
    on(ev, cb) { if (ev === 'data') setTimeout(() => cb(Buffer.from(JSON.stringify(body))), 0); if (ev === 'end') setTimeout(() => cb(), 1); return req; },
    destroy() {},
  };
  const out = { status: 0, body: '' };
  const res = { writeHead(c) { out.status = c; }, setHeader() {}, end(b) { out.body = b == null ? '' : String(b); } };
  await routes.handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
  return { status: out.status, body: out.body ? JSON.parse(out.body) : null };
}

describe('Familien-Dashboard: Lademodus', () => {
  it('„Aus“ → Laden stoppen (Override der Brücke), kein bloßer Moduswechsel', async () => {
    const ctx = makeCtx();
    const r = await post(ctx, { loadpoint: 1, mode: 'off' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ctx.calls, [['setOverride', { kind: 'stop' }]]);
  });

  it('anderer Modus bei laufendem Stopp → Stopp beenden, dann Modus setzen', async () => {
    const ctx = makeCtx({ stopActive: true });
    const r = await post(ctx, { loadpoint: 1, mode: 'pv' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ctx.calls, [['clearOverride'], ['setMode', 'pv', 1]]);
  });

  it('anderer Modus ohne Stopp → nur Modus setzen', async () => {
    const ctx = makeCtx();
    await post(ctx, { loadpoint: 1, mode: 'now' });
    assert.deepEqual(ctx.calls, [['setMode', 'now', 1]]);
  });

  it('ohne Brücke bleibt „Aus“ der Moduswechsel', async () => {
    const ctx = makeCtx({ bridge: false });
    await post(ctx, { loadpoint: 1, mode: 'off' });
    assert.deepEqual(ctx.calls, [['setMode', 'off', 1]]);
  });

  it('Beenden im Not-Halt abgelehnt → Fehler, Modus bleibt', async () => {
    const ctx = makeCtx({ stopActive: true });
    ctx.eosEvccBridge.clearOverride = async () => { ctx.calls.push(['clearOverride']); return { ok: false, error: 'emergency_stop_active' }; };
    const r = await post(ctx, { loadpoint: 1, mode: 'pv' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'emergency_stop_active');
    assert.deepEqual(ctx.calls, [['clearOverride']]);
  });
});
