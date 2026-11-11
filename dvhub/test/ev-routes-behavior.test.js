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
    assert.deepEqual(r.body.patch, { evDepartureEnabled: true, evDepartureTime: '07:30', evDepartureDays: [1, 5], evWeeklyPlan: null, evWeeklyDepartures: null, evTargetMode: 'percent', evTargetValue: 80 });
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
  // T-0427: Zeile = Abfahrtstag. POST nimmt weeklyDepartures, speichert beide
  // Formate; GET liefert beide und den Umstell-Hinweis, bis er gelesen ist.
  it('POST weeklyDepartures + migrationSeen → neues und altes Format gespeichert, Hinweis gelesen; GET zeigt beides', async () => {
    const ctx = makeCtx();
    ctx.getRawCfg().optimizer.evWeeklyMigration = { at: '2026-11-11T12:00:00.000Z', reason: 'legacy', seen: false, notes: [{ kind: 'helper', day: 2, text: 'x' }], previous: [] };
    let g = await call(ctx, 'GET', '/api/ev');
    assert.deepEqual(g.body.departure.weeklyMigration, { at: '2026-11-11T12:00:00.000Z', reason: 'legacy', notes: [{ kind: 'helper', day: 2, text: 'x' }] });
    const r = await call(ctx, 'POST', '/api/ev', { departure: { enabled: true, migrationSeen: true, weeklyDepartures: [
      { day: 2, departure: '08:30', minSocPct: 80, homeFrom: '19:15', homeFromPrevDay: true },
      { day: 6, departure: '09:22', minSocPct: 60, homeFrom: '09:17', homeFromPrevDay: false },
      { day: 6, departure: '10:00', minSocPct: 50 },
    ] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const opt = ctx.saved.at(-1).optimizer;
    assert.equal(opt.evWeeklyDepartures.length, 8, '7 Tage + zweite Abfahrt am Samstag');
    assert.equal(opt.evWeeklyMigration.seen, true);
    assert.deepEqual(opt.evWeeklyPlan.find((x) => x.day === 1), { day: 1, arrival: '19:15', departure: '08:30', minSocPct: 80, tripSocPct: null, targetValue: 80, commuteKm: null });
    Object.assign(ctx.getRawCfg().optimizer, opt);
    g = await call(ctx, 'GET', '/api/ev');
    assert.equal(g.body.departure.weeklyMigration, null);
    assert.deepEqual(g.body.departure.weeklyDepartures, opt.evWeeklyDepartures);
    assert.deepEqual(g.body.departure.weeklyPlan, opt.evWeeklyPlan);
  });

  it('POST weeklyDepartures: „zuhause ab“ am selben Tag nach der Abfahrt → 400', async () => {
    const ctx = makeCtx();
    const r = await call(ctx, 'POST', '/api/ev', { departure: { weeklyDepartures: [{ day: 2, departure: '08:30', homeFrom: '09:00', homeFromPrevDay: false }] } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'departure.weeklyDepartures[0].homeFrom must be before the departure on the same day');
    assert.equal(ctx.saved.length, 0);
  });

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
    // Einmalige Ankunft muss in der Zukunft liegen (seit 11.11.2026 geprüft).
    const arrOnce = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 2 * 86400_000);
    const r = await call(ctx, 'POST', '/api/ev', { departure: {
      enabled: true, commuteKm: 25, arrivalOnce: arrOnce.toISOString().replace('.000Z', '+00:00'),
      weeklyPlan: [{ day: 1, arrival: '20:00', departure: '5:00' }, { day: 5, arrival: '15:00', departure: '09:00', targetValue: 100 }],
    } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const opt = ctx.saved.at(-1).optimizer;
    assert.equal(opt.evWeeklyPlan.length, 7);
    // Alte Oberfläche (Ziel/Heimweg) → SoC-%: Ziel 100 % als Mindest-Ladestand.
    // Der Heimweg wird keine Fahrt (Christin 10.11.2026) — er bleibt nur als
    // alter Wert stehen (Hinweis in der Oberfläche).
    assert.equal(opt.evWeeklyPlan[0].minSocPct, null);
    assert.ok(opt.evWeeklyPlan.every((e) => e.tripSocPct === null), JSON.stringify(opt.evWeeklyPlan));
    // Mitgeschriebenes altes Format für 1.0.9 (T-0427): targetValue in %, kein Heimweg
    assert.equal(opt.evWeeklyPlan[0].targetValue, null);
    assert.equal(opt.evWeeklyPlan[0].commuteKm, null);
    assert.equal(opt.evWeeklyPlan[4].minSocPct, 100);
    assert.equal(opt.evWeeklyPlan[4].targetValue, 100);
    // Gilt: Zeile = Abfahrtstag — Di 05:00 (zuhause ab Mo 20:00), Sa 09:00 (zuhause ab Fr 15:00)
    assert.deepEqual(opt.evWeeklyDepartures.filter((x) => x.departure).map((x) => [x.day, x.departure, x.homeFrom, x.homeFromPrevDay, x.minSocPct]),
      [[2, '05:00', '20:00', true, null], [6, '09:00', '15:00', true, 100]]);
    assert.equal(opt.evArrivalOnce, arrOnce.toISOString());
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
  // Jeden Tag gleich: Ankunft in 2 h, Abfahrt in 10 h (Ortszeit Berlin) —
  // so liegt die letzte Abfahrt immer 14 h zurück und der Test hängt weder vom
  // Wochentag noch von der Uhrzeit ab (Codex-Befund: feste 20:00/05:00 fielen
  // zwischen 04:50 und 05:01 um). Fahrt 12 % je Abfahrt (Hin- und Rückweg,
  // je Strecke 6 %); der alte Heimweg (evCommuteKm) zählt nicht mehr.
  const hhmm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  const planNow = () => {
    const now = Date.now();
    return [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, arrival: hhmm(now + 2 * 3600_000), departure: hhmm(now + 10 * 3600_000), minSocPct: null, tripSocPct: 12 }));
  };
  const setup = (ctx) => Object.assign(ctx.getRawCfg().optimizer, {
    evDepartureEnabled: true, evWeeklyPlan: planNow(), evCapacityWh: 60000, evConsumptionKwhPer100km: 18, evCommuteKm: 20,
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
    assert.equal(r.body.arrival.deductPct, 6);
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

describe('Vorplanung im GET /api/ev', () => {
  it('meldet Ladestart-Fähigkeit, Modus, Ladestart und den Grund einer blockierten Vorplanung', async () => {
    const ctx = makeCtx();
    ctx.state.optimizer = {
      eos: { supported: true, evChargeStart: false },
      eosEv: { wanted: true, register: false, reason: 'nicht angesteckt', mode: null, chargeStartAt: null, preplanBlocked: 'Vorplanung braucht EOS mit Ladestart' },
    };
    const r = await call(ctx, 'GET', '/api/ev');
    assert.equal(r.body.departure.chargeStartSupported, false);
    assert.equal(r.body.vehicle.registrationMode, null);
    assert.equal(r.body.vehicle.preplanBlocked, 'Vorplanung braucht EOS mit Ladestart');

    ctx.state.optimizer.eos.evChargeStart = true;
    ctx.state.optimizer.eosEv = { wanted: true, register: true, mode: 'preplan', chargeStartAt: '2026-10-27T19:00:00.000Z', preplanBlocked: null };
    const r2 = await call(ctx, 'GET', '/api/ev');
    assert.equal(r2.body.departure.chargeStartSupported, true);
    assert.equal(r2.body.vehicle.registrationMode, 'preplan');
    assert.equal(r2.body.vehicle.chargeStartAt, '2026-10-27T19:00:00.000Z');
  });
});

describe('GET /api/ev ohne evcc', () => {
  it('„angesteckt“ aus MQTT/HTTP/Home Assistant, wenn weder Wallbox noch evcc es melden', async () => {
    const ctx = makeCtx();
    ctx.vehiclePull = { getState: (k) => (k === 'homeassistant' ? { configured: true, socPct: 61, socAt: Date.now() - 60_000, plugged: true } : { configured: false, socPct: null, plugged: null }) };
    const r = await call(ctx, 'GET', '/api/ev');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.vehicle.plugged, true);
    assert.equal(r.body.vehicle.connected, true);
    assert.equal(r.body.vehicle.socPct, 61);
    assert.equal(r.body.vehicle.socSource, 'homeassistant');
    assert.equal(r.body.vehicle.source, 'homeassistant');
  });
});

describe('GET /api/integrations/evcc: Wochenplan-Zustand für die Schublade', () => {
  it('liefert erwarteten Ladestand und den Zustand von HTTP/Home Assistant — ohne Token', async () => {
    const ctx = makeCtx();
    ctx.evccIntegration = { getStatus: () => ({}), getLoadpoints: () => [] };
    ctx.vehiclePull = { getState: (k) => (k === 'http'
      ? { configured: true, socPct: null, socAt: null, socStale: false, plugged: null, error: 'Pfad „data.soc“ nicht in der Antwort gefunden' }
      : { configured: false, socPct: null, plugged: null }) };
    ctx.getRawCfg().optimizer.evHttpToken = 'geheim';
    const r = await call(ctx, 'GET', '/api/integrations/evcc');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const dep = r.body.eos.departure;
    assert.ok('arrival' in dep);
    assert.equal(dep.vehicleSources.http.error, 'Pfad „data.soc“ nicht in der Antwort gefunden');
    assert.equal(dep.vehicleSources.homeassistant.configured, false);
    assert.doesNotMatch(JSON.stringify(r.body), /geheim/);
  });
});

describe('Max-Ladestand und Einmal-Ziel über /api/ev (1.0.10)', () => {
  it('POST speichert Max, Einmal-Ziel und Plan in SoC-%', async () => {
    const ctx = makeCtx();
    // Einmalige Abfahrt in der Zukunft (Vergangenheit wird seit 11.11.2026 abgelehnt).
    const once = new Date(Date.now() + 3 * 86400_000).toISOString();
    const r = await call(ctx, 'POST', '/api/ev', { departure: {
      enabled: true, maxSocPct: 85, once, onceMinSocPct: 75, onceTripSocPct: 45,
      weeklyPlan: [{ day: 2, arrival: '', departure: '07:00', minSocPct: 50, tripSocPct: 30 }],
    } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const opt = ctx.saved.at(-1).optimizer;
    assert.equal(opt.evMaxSocPct, 85);
    assert.equal(opt.evDepartureOnceMinSocPct, 75);
    assert.equal(opt.evDepartureOnceTripSocPct, 45);
    assert.deepEqual(opt.evWeeklyPlan[1], { day: 2, arrival: '', departure: '07:00', minSocPct: 50, tripSocPct: 30, targetValue: 50, commuteKm: null });
    assert.deepEqual(opt.evWeeklyDepartures[1], { day: 2, departure: '07:00', minSocPct: 50, tripSocPct: 30, homeFrom: '', homeFromPrevDay: false });
  });

  it('GET zeigt Max, Einmal-Ziel, abgeleitete EOS-Ziele (min, max, Wertstufen) und den Wallbox-Stopp', async () => {
    const ctx = makeCtx();
    Object.assign(ctx.getRawCfg().optimizer, { evDepartureEnabled: true, evMaxSocPct: 80, evDepartureOnceMinSocPct: 75 });
    ctx.state.optimizer = {
      eos: { supported: true, evSocValue: true },
      evTargets: { minSocPct: 50, maxSocPct: 80, steps: [[55, 0.24], [80, 0.21]], maxActive: true, valueSupported: true, reason: null },
    };
    ctx.eosEvccBridge.getStatus = () => ({ maxStop: { maxSocPct: 80, socPct: 80, active: true, since: '2026-11-17T03:00:00.000Z' } });
    const r = await call(ctx, 'GET', '/api/ev');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.departure.maxSocPct, 80);
    assert.equal(r.body.departure.onceMinSocPct, 75);
    assert.equal(r.body.departure.onceTripSocPct, null);
    assert.equal(r.body.departure.valueSupported, true);
    assert.deepEqual(r.body.targets.steps, [[55, 0.24], [80, 0.21]]);
    assert.equal(r.body.targets.maxSocPct, 80);
    assert.equal(r.body.maxStop.active, true);
  });
});

describe('Einmal-Ziel über /api/ev: Prüfung und Status (11.11.2026)', () => {
  it('POST mit einmaliger Abfahrt in der Vergangenheit → 400 once_in_past, nichts gespeichert', async () => {
    const ctx = makeCtx();
    const r = await call(ctx, 'POST', '/api/ev', { departure: { once: new Date(Date.now() - 3600_000).toISOString(), onceMinSocPct: 80 } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'once_in_past');
    assert.equal(ctx.saved.length, 0);
  });

  it('POST mit Abfahrt im Vorlauf (in 5 min) → 400; in 30 min → gespeichert', async () => {
    const ctx = makeCtx();
    const soon = await call(ctx, 'POST', '/api/ev', { departure: { once: new Date(Date.now() + 5 * 60_000).toISOString() } });
    assert.equal(soon.status, 400);
    const ok = await call(ctx, 'POST', '/api/ev', { departure: { enabled: true, once: new Date(Date.now() + 30 * 60_000).toISOString(), onceMinSocPct: 80 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ctx.saved.at(-1).optimizer.evDepartureOnceMinSocPct, 80);
  });

  it('GET liefert onceInfo: aktiv bzw. vorbei (kein Aktiv-Chip für ein vergangenes Ziel)', async () => {
    const ctx = makeCtx();
    Object.assign(ctx.getRawCfg().optimizer, { evDepartureEnabled: true, evDepartureOnce: new Date(Date.now() + 86400_000).toISOString(), evDepartureOnceMinSocPct: 85 });
    const r = await call(ctx, 'GET', '/api/ev');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.departure.onceInfo.departure.state, 'active');
    assert.equal(r.body.departure.onceInfo.departure.effective, true);
    assert.equal(r.body.departure.onceInfo.departure.targetSocPct, 85);
    ctx.getRawCfg().optimizer.evDepartureOnce = new Date(Date.now() - 60_000).toISOString();
    const r2 = await call(ctx, 'GET', '/api/ev');
    assert.equal(r2.body.departure.onceInfo.departure.state, 'ended');
    assert.equal(r2.body.departure.onceInfo.departure.effective, false);
  });

  it('POST /api/ev/preview beschreibt das Einmal-Ziel des Entwurfs und lehnt die Vergangenheit ab', async () => {
    const ctx = makeCtx();
    // Leerer Wochenplan: sonst hinge die nächste Abfahrt vom Wochentag des Testlaufs ab.
    Object.assign(ctx.getRawCfg().optimizer, { evDepartureEnabled: true, evWeeklyPlan: [] });
    const r = await call(ctx, 'POST', '/api/ev/preview', { departure: { once: new Date(Date.now() + 86400_000).toISOString(), onceMinSocPct: 70 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.once.departure.state, 'active');
    assert.equal(r.body.resolved.targetSocPct, 70);
    const past = await call(ctx, 'POST', '/api/ev/preview', { departure: { once: new Date(Date.now() - 86400_000).toISOString() } });
    assert.equal(past.status, 400);
    assert.equal(past.body.code, 'once_in_past');
  });
});
