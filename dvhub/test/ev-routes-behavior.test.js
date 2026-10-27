// test/ev-routes-behavior.test.js — POST /api/ev und /api/ev/override am
// Endpunkt (2026-10-15, Wartung: bisher nur Quelltext-Prüfungen).
//
// /api/ev ändert nur optimizer.* (Mitplanen, nur eingesteckt, Abfahrt/Ziel) und
// stößt bei geänderter Mitplanung einen EOS-Lauf an. /api/ev/override ist
// „Sofort laden“ über die EOS→evcc-Brücke; Beenden geht auch ohne Pro.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

function license(active) {
  return {
    requirePro(req, res, feature) {
      if (active) return true;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'pro_required', feature }));
      return false;
    },
  };
}

function makeCtx({ pro = true, saveThrows = false } = {}) {
  const raw = { optimizer: { enabled: true, eosOptimizeEv: false }, evcc: { enabled: true, url: 'http://evcc' }, wallbox: { kind: 'x' } };
  const saved = [];
  const replans = [];
  const bridgeCalls = [];
  const logs = [];
  const ctx = {
    saved, replans, bridgeCalls, logs,
    state: {
      meter: { grid_total_w: 0 }, victron: {}, epex: { ok: false, data: [] }, energy: { day: null },
      telemetry: {}, keepalive: { appPulse: {} }, log: [],
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {} },
      ctrl: { forcedOff: false },
    },
    getCfg: () => ({ ...raw, apiToken: null, corsAllowedOrigins: [], allowedHosts: [], gridPositiveMeans: 'grid_import' }),
    getRawCfg: () => raw,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getAppVersion: () => ({ version: '0.0.0-test' }),
    controlValue: () => 'off',
    pushLog: (event, payload) => logs.push({ event, payload }),
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    expireLeaseIfNeeded: () => {},
    epexNowNext: () => null,
    licenseService: license(pro),
    saveAndApplyConfig: (next) => {
      if (saveThrows) throw new Error('disk full');
      saved.push(JSON.parse(JSON.stringify(next)));
      return { ok: true, changedPaths: [] };
    },
    optimizerService: { requestEosReplan: (why) => replans.push(why) },
    eosEvccBridge: {
      setOverride: async (o) => { bridgeCalls.push(['set', o]); return Number(o.powerW) > 0 ? { ok: true, override: { powerW: Number(o.powerW), until: o.untilMs } } : { ok: false, error: 'powerW must be > 0' }; },
      clearOverride: async () => { bridgeCalls.push(['clear']); return { ok: true }; },
    },
  };
  return ctx;
}

async function call(ctx, method, path, body) {
  const routes = createApiRoutes(ctx);
  const req = {
    method, url: path,
    headers: { host: 'dvhub.test', 'content-type': 'application/json' },
    socket: { remoteAddress: '192.168.1.20' },
    on(ev, cb) {
      if (ev === 'data' && body !== undefined) setTimeout(() => cb(Buffer.from(JSON.stringify(body))), 0);
      if (ev === 'end') setTimeout(() => cb(), 1);
      return req;
    },
    destroy() {},
  };
  const out = { status: 0, body: '' };
  const res = { writeHead(c) { out.status = c; }, setHeader() {}, end(b) { out.body = b == null ? '' : String(b); } };
  await routes.handleRequest(req, res, new URL(path, 'http://dvhub.test'));
  return { status: out.status, body: out.body ? JSON.parse(out.body) : null };
}

describe('POST /api/ev', () => {
  it('Mitplanen an → nur optimizer.eosOptimizeEv geändert, EOS-Lauf angestoßen', async () => {
    const ctx = makeCtx();
    const r = await call(ctx, 'POST', '/api/ev', { optimizeEv: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.patch, { eosOptimizeEv: true });
    const saved = ctx.saved.at(-1);
    assert.equal(saved.optimizer.eosOptimizeEv, true);
    assert.deepEqual(saved.evcc, { enabled: true, url: 'http://evcc' }, 'evcc unberührt');
    assert.deepEqual(saved.wallbox, { kind: 'x' }, 'Wallbox unberührt');
    assert.deepEqual(ctx.replans, ['ev_config']);
  });

  it('nur Abfahrt geändert → gespeichert, KEIN Sofort-Lauf', async () => {
    const ctx = makeCtx();
    const r = await call(ctx, 'POST', '/api/ev', { departure: { enabled: true, time: '7:30', days: [5, 1, 1, 9], targetMode: 'percent', targetValue: 80 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // „7:30“ → „07:30“, Tage entdoppelt + sortiert, 9 verworfen.
    assert.deepEqual(r.body.patch, { evDepartureEnabled: true, evDepartureTime: '07:30', evDepartureDays: [1, 5], evWeeklyPlan: null, evTargetMode: 'percent', evTargetValue: 80 });
    assert.deepEqual(ctx.replans, []);
  });

  for (const [name, body, error] of [
    ['nichts zu ändern', {}, 'nothing to change'],
    ['Uhrzeit ungültig', { departure: { time: '25:00' } }, 'departure.time must be HH:MM'],
    ['Ziel außerhalb 0..2000', { departure: { targetValue: 2500 } }, 'departure.targetValue must be 0..2000'],
    ['Zielart unbekannt', { departure: { targetMode: 'liter' } }, 'departure.targetMode must be percent|kwh|km'],
  ]) {
    it(`400: ${name}`, async () => {
      const ctx = makeCtx();
      const r = await call(ctx, 'POST', '/api/ev', body);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, error);
      assert.equal(ctx.saved.length, 0);
    });
  }

  it('Speichern scheitert → 500, kein EOS-Lauf', async () => {
    const ctx = makeCtx({ saveThrows: true });
    const r = await call(ctx, 'POST', '/api/ev', { optimizeEv: true });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'save failed');
    assert.deepEqual(ctx.replans, []);
  });
});

describe('/api/ev/override („Sofort laden“)', () => {
  it('POST mit Dauer 30 min → Brücke bekommt powerW und Ende = jetzt + 30 min', async () => {
    const ctx = makeCtx();
    const t0 = Date.now();
    const r = await call(ctx, 'POST', '/api/ev/override', { powerW: 7400, durationMin: 30 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [kind, o] = ctx.bridgeCalls[0];
    assert.equal(kind, 'set');
    assert.equal(o.powerW, 7400);
    assert.ok(o.untilMs >= t0 + 30 * 60_000 && o.untilMs <= Date.now() + 30 * 60_000);
  });

  it('POST ohne Ende → bis zum Abstecken (untilMs null)', async () => {
    const ctx = makeCtx();
    await call(ctx, 'POST', '/api/ev/override', { powerW: 3700 });
    assert.equal(ctx.bridgeCalls[0][1].untilMs, null);
  });

  it('POST Dauer 0 → 400, Brücke nicht gerufen', async () => {
    const ctx = makeCtx();
    const r = await call(ctx, 'POST', '/api/ev/override', { powerW: 3700, durationMin: 0 });
    assert.equal(r.status, 400);
    assert.deepEqual(ctx.bridgeCalls, []);
  });

  it('POST mit ungültiger Leistung → 400 von der Brücke durchgereicht', async () => {
    const ctx = makeCtx();
    const r = await call(ctx, 'POST', '/api/ev/override', { powerW: 0 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'powerW must be > 0');
  });

  it('ohne Pro: Starten 403, Beenden geht trotzdem', async () => {
    const ctx = makeCtx({ pro: false });
    const start = await call(ctx, 'POST', '/api/ev/override', { powerW: 3700 });
    assert.equal(start.status, 403);
    const stop = await call(ctx, 'DELETE', '/api/ev/override');
    assert.equal(stop.status, 200);
    assert.deepEqual(ctx.bridgeCalls, [['clear']]);
  });
});

describe('/api/ev/override „Laden stoppen“', () => {
  it('POST { kind: stop } → Brücke bekommt kind stop, ohne Leistung', async () => {
    const ctx = makeCtx();
    ctx.eosEvccBridge.setOverride = async (o) => { ctx.bridgeCalls.push(['set', o]); return { ok: true, override: { kind: o.kind, powerW: 0, until: null } }; };
    const r = await call(ctx, 'POST', '/api/ev/override', { kind: 'stop' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ctx.bridgeCalls, [['set', { kind: 'stop', powerW: undefined, untilMs: null }]]);
    assert.ok(ctx.logs.some((l) => l.event === 'ev_override_set' && l.payload.kind === 'stop'));
  });

  it('POST { kind: stop, durationMin: 60 } → Ende in 60 min', async () => {
    const ctx = makeCtx();
    ctx.eosEvccBridge.setOverride = async (o) => { ctx.bridgeCalls.push(['set', o]); return { ok: true, override: { kind: 'stop' } }; };
    const t0 = Date.now();
    await call(ctx, 'POST', '/api/ev/override', { kind: 'stop', durationMin: 60 });
    const o = ctx.bridgeCalls[0][1];
    assert.ok(o.untilMs >= t0 + 3_600_000 && o.untilMs <= Date.now() + 3_600_000);
  });
});

describe('Pro (eos): Wallbox-Steuerung und E-Auto-Planung (2026-10-15)', () => {
  it('POST /api/ev ohne Pro → 403, nichts gespeichert', async () => {
    const ctx = makeCtx({ pro: false });
    const r = await call(ctx, 'POST', '/api/ev', { optimizeEv: true });
    assert.equal(r.status, 403);
    assert.equal(r.body.feature, 'eos');
    assert.equal(ctx.saved.length, 0);
  });
});

describe('Wochenplan über /api/ev (2026-10-27)', () => {
  it('GET liefert den abgeleiteten Wochenplan einer alten Config (Mo–Fr 07:00, keine Ankunft)', async () => {
    const ctx = makeCtx();
    Object.assign(ctx.getRawCfg().optimizer, { evDepartureEnabled: true, evDepartureTime: '07:00', evDepartureDays: [1, 2, 3, 4, 5] });
    const r = await call(ctx, 'GET', '/api/ev');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const wp = r.body.departure.weeklyPlan;
    assert.equal(wp.length, 7);
    assert.deepEqual(wp.map((e) => e.departure), ['07:00', '07:00', '07:00', '07:00', '07:00', '', '']);
    assert.deepEqual(wp.map((e) => e.arrival), ['', '', '', '', '', '', '']);
    assert.equal(r.body.departure.arrivalOnce, '');
    assert.equal(r.body.departure.commuteKm, 0);
  });

  it('POST mit Wochenplan + einmaliger Ankunft + Heimweg → normalisiert gespeichert', async () => {
    const ctx = makeCtx();
    const r = await call(ctx, 'POST', '/api/ev', { departure: {
      enabled: true, commuteKm: 25, arrivalOnce: '2026-10-27T21:30:00+01:00',
      weeklyPlan: [{ day: 1, arrival: '20:00', departure: '5:00' }, { day: 5, arrival: '15:00', departure: '09:00', targetValue: 100 }],
    } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const opt = ctx.saved.at(-1).optimizer;
    assert.equal(opt.evWeeklyPlan.length, 7);
    assert.deepEqual(opt.evWeeklyPlan[0], { day: 1, arrival: '20:00', departure: '05:00', targetValue: null, commuteKm: null });
    assert.equal(opt.evWeeklyPlan[4].targetValue, 100);
    assert.equal(opt.evArrivalOnce, '2026-10-27T20:30:00.000Z');
    assert.equal(opt.evCommuteKm, 25);
    assert.deepEqual(ctx.replans, [], 'Planänderung allein stößt keinen Sofort-Lauf an (die Minuten-Wache übernimmt)');
  });

  it('POST Ankunft ohne Abfahrt → 400, nichts gespeichert', async () => {
    const ctx = makeCtx();
    const r = await call(ctx, 'POST', '/api/ev', { departure: { weeklyPlan: [{ day: 2, arrival: '20:00' }] } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'departure.weeklyPlan[0].departure is required with an arrival');
    assert.equal(ctx.saved.length, 0);
  });
});

describe('Erwarteter Ladestand bei Ankunft über GET /api/ev', () => {
  // Heute 20:00 Ankunft, morgen 05:00 Abfahrt — an jedem Tag, damit der Test
  // unabhängig vom Wochentag läuft. 60 kWh, 18 kWh/100 km, Heimweg 20 km = 6 %.
  const plan = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, arrival: '20:00', departure: '05:00' }));
  const setup = (ctx) => Object.assign(ctx.getRawCfg().optimizer, {
    evDepartureEnabled: true, evWeeklyPlan: plan, evCapacityWh: 60000, evConsumptionKwhPer100km: 18, evCommuteKm: 20,
    evTargetMode: 'percent', evTargetValue: 80,
  });

  it('TeslaMate meldet unterwegs 70 % (vor 1 min) → erwartet 64 %, Quelle live', async () => {
    const ctx = makeCtx();
    setup(ctx);
    ctx.teslamateService = { getState: () => ({ batteryLevel: 70 }), getFieldUpdatedAt: () => ({ batteryLevel: new Date(Date.now() - 60_000) }) };
    ctx.evccIntegration = { getLoadpoints: () => [{ id: 1, connected: false }], getStatus: () => ({ loadpoints: [{ id: 1, connected: false }] }) };
    const r = await call(ctx, 'GET', '/api/ev');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.arrival.expectedSocPct, 64);
    assert.equal(r.body.arrival.source, 'live');
    assert.equal(r.body.arrival.basePct, 70);
    assert.equal(r.body.arrival.deductKm, 20);
    assert.ok(r.body.departure.resolved.arrivalAt, 'nächste Ankunft mitgeliefert');
  });

  it('angesteckt: der echte Ladestand gilt (evcc 55 %), nichts abgezogen', async () => {
    const ctx = makeCtx();
    setup(ctx);
    ctx.teslamateService = { getState: () => ({ batteryLevel: null }) };
    ctx.evccIntegration = { getLoadpoints: () => [{ id: 1, connected: true, vehicleSocPct: 55 }], getStatus: () => ({ loadpoints: [{ id: 1, connected: true, vehicleSocPct: 55 }] }) };
    const r = await call(ctx, 'GET', '/api/ev');
    assert.equal(r.body.arrival.expectedSocPct, 55);
    assert.equal(r.body.arrival.source, 'plugged');
  });
});
