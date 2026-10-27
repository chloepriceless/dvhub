// test/ev-preplan.test.js -- Vorplanung: EOS bekommt das Auto schon vor dem
// Anstecken, mit dem erwarteten Ladestand und einem fruehesten Ladestart.
//
// Nur korrekt, wenn EOS einen Ladestart kennt (Feld EOS_EV_CHARGE_START_FIELD
// am Fahrzeug) — sonst plante EOS Ladung, bevor das Auto da ist. Erkannt wird
// das wie die Wirkungsgradkurve an GET /v1/config: EOS liefert bekannte, aber
// unbelegte Felder als null mit aus — Akku und Auto teilen dort dasselbe
// Modell (BatteriesCommonSettings), also steht das Feld auch an battery1.
//
// Rechenbasis (von Hand): 60 kWh, 18 kWh/100 km, Heimweg 20 km → 6 % je Weg.
// TeslaMate meldet unterwegs 70 % → erwartet bei Ankunft 64 %.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { detectEosCapabilities, EOS_EV_CHARGE_START_FIELD } from '../services/optimizer/eos-capabilities.js';
import { createEosConfigSync, buildEosElectricVehicles } from '../services/optimizer/eos-config-sync.js';
import { computeEvRegistration, evSocForEos, PREPLAN_GRACE_MS } from '../services/optimizer/ev-registration.js';
import { createEvWatch } from '../services/optimizer/ev-watch.js';
import { createEosForecastBridge } from '../services/optimizer/eos-forecast-bridge.js';

const TZ = 'Europe/Berlin';
const HOUR = 3600_000;

/** 'HH:MM' Ortszeit Berlin fuer einen Zeitpunkt. */
function hhmm(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}
/** Minute abrunden — so steht die Zeit im Plan. */
const floorMin = (ms) => Math.floor(ms / 60_000) * 60_000;

/**
 * Jeder Tag gleich: Ankunft jetzt + arrOffset, Abfahrt jetzt + depOffset.
 * Damit ist das naechste Fenster unabhaengig vom Wochentag des Testlaufs.
 */
function planAround(nowMs, arrOffset, depOffset) {
  const arrival = hhmm(nowMs + arrOffset);
  const departure = hhmm(nowMs + depOffset);
  return [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, arrival, departure }));
}

const EOS_CFG = (withChargeStart) => ({
  optimization: {
    algorithm: 'GENETIC', algorithms: ['GENETIC', 'GENETIC0'],
    genetic: { individuals: 300, generations: 400, interval_sec: 3600, horizon_hours: 48 }, genetic0: {}, keys: [],
  },
  feedintariff: { provider: null, direct_marketing_enabled: true },
  devices: {
    batteries: { battery1: { device_id: 'battery1', min_soc_deadline_datetime: null, ...(withChargeStart ? { [EOS_EV_CHARGE_START_FIELD]: null } : {}) } },
    inverters: { inverter1: { device_id: 'inverter1' } },
    electric_vehicles: {}, home_appliances: {}, max_home_appliances: 0,
  },
  elecprice: { provider: 'ElecPriceImport', providers: [] },
});

function createMockEos(withChargeStart) {
  const puts = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && req.url === '/v1/config') return res.end(JSON.stringify(EOS_CFG(withChargeStart)));
        if (req.method === 'GET' && req.url === '/v1/health') return res.end(JSON.stringify({ status: 'alive', version: '0.4.0-test' }));
        if (req.method === 'PUT') puts.push({ section: req.url.replace('/v1/config/', ''), body });
        return res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, puts,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}
const bodyOf = (m, section) => (m.puts.filter((p) => p.section === section).at(-1) || {}).body;

function ctxFor(port, { opt = {}, plugged = false, teslaPct = 70, evccSoc = null } = {}) {
  const state = { victron: { minSocPct: 5, soc: 50 }, optimizer: {} };
  const cfg = {
    schedule: { timezone: TZ },
    optimizer: {
      eosProxy: { enabled: true, url: `http://127.0.0.1:${port}` },
      batteryCapacityWh: 43000, maxChargeW: 18000, roundTripEfficiency: 0.92, eosOptimizationIntervalSec: 900,
      tariff: { feedInMode: 'spot' },
      eosOptimizeEv: true, evCapacityWh: 60000, evConsumptionKwhPer100km: 18, evCommuteKm: 20,
      evDepartureEnabled: true, evTargetMode: 'percent', evTargetValue: 80,
      ...opt,
    },
  };
  return {
    state,
    pushLog: () => {},
    getCfg: () => cfg,
    teslamateService: teslaPct === null ? undefined : {
      getState: () => ({ batteryLevel: teslaPct }),
      getFieldUpdatedAt: () => ({ batteryLevel: new Date(Date.now() - 60_000) }),
    },
    evccIntegration: { getLoadpoints: () => [{ id: 1, connected: plugged, vehicleSocPct: plugged ? evccSoc : 0 }] },
  };
}

let mock;
afterEach(async () => { if (mock) { await mock.close(); mock = null; } });

describe('EOS-Faehigkeit „Ladestart“ erkennen', () => {
  it(`Feldname steht an EINER Stelle: ${EOS_EV_CHARGE_START_FIELD}`, () => {
    assert.equal(EOS_EV_CHARGE_START_FIELD, 'charge_start_datetime');
  });
  it('Feld (auch null) an battery1 oder einem Auto → evChargeStart', () => {
    assert.equal(detectEosCapabilities(EOS_CFG(true)).evChargeStart, true);
    assert.equal(detectEosCapabilities(EOS_CFG(false)).evChargeStart, false);
    const evOnly = EOS_CFG(false);
    evOnly.devices.electric_vehicles = { ev11: { device_id: 'ev11', [EOS_EV_CHARGE_START_FIELD]: '2026-10-27T19:00:00Z' } };
    assert.equal(detectEosCapabilities(evOnly).evChargeStart, true);
  });
});

describe('EOS-Fahrzeug mit Ladestart', () => {
  const cfg = { schedule: { timezone: TZ }, optimizer: { evDepartureEnabled: false, evMinSocPct: 60 } };
  it('mit Faehigkeit: Feld gesetzt bzw. ausdruecklich null', () => {
    const [a] = buildEosElectricVehicles(cfg, { supportsDeadline: true, supportsChargeStart: true, chargeStartAt: '2026-10-27T19:00:00.000Z' });
    assert.equal(a[EOS_EV_CHARGE_START_FIELD], '2026-10-27T19:00:00.000Z');
    const [b] = buildEosElectricVehicles(cfg, { supportsDeadline: true, supportsChargeStart: true, chargeStartAt: null });
    assert.equal(b[EOS_EV_CHARGE_START_FIELD], null);
    assert.ok(EOS_EV_CHARGE_START_FIELD in b, 'null raeumt einen alten Ladestart in EOS ab');
  });
  it('ohne Faehigkeit: Feld fehlt ganz (EOS wuerde es ablehnen)', () => {
    const [ev] = buildEosElectricVehicles(cfg, { supportsDeadline: true, chargeStartAt: '2026-10-27T19:00:00.000Z' });
    assert.equal(EOS_EV_CHARGE_START_FIELD in ev, false);
  });
});

describe('Anmelden bei EOS (computeEvRegistration)', () => {
  const NOW = Date.now();
  const ctxPlan = (arrOff, depOff, extra = {}) => {
    const ctx = ctxFor(1, { opt: { evWeeklyPlan: planAround(NOW, arrOff, depOff), ...extra.opt }, plugged: extra.plugged ?? false, teslaPct: 'teslaPct' in extra ? extra.teslaPct : 70, evccSoc: extra.evccSoc });
    return { ctx, cfg: ctx.getCfg() };
  };

  it('Ankunft in 2 h, nicht angesteckt, EOS kann Ladestart → Vorplanung mit 64 % ab Ankunft', () => {
    const { ctx, cfg } = ctxPlan(2 * HOUR, 10 * HOUR);
    const r = computeEvRegistration(ctx, cfg, { chargeStartSupported: true, plugged: false, nowMs: NOW });
    assert.equal(r.register, true);
    assert.equal(r.mode, 'preplan');
    assert.equal(r.socPct, 64);
    assert.equal(r.socSource, 'live');
    assert.equal(r.chargeStartAt, new Date(floorMin(NOW + 2 * HOUR)).toISOString());
    assert.equal(r.departureAt, new Date(floorMin(NOW + 10 * HOUR)).toISOString());
  });

  it('ohne Faehigkeit: wie bisher nicht anmelden, Hinweis „Vorplanung braucht EOS mit Ladestart“', () => {
    const { ctx, cfg } = ctxPlan(2 * HOUR, 10 * HOUR);
    const r = computeEvRegistration(ctx, cfg, { chargeStartSupported: false, plugged: false, nowMs: NOW });
    assert.equal(r.register, false);
    assert.equal(r.reason, 'nicht angesteckt');
    assert.equal(r.preplanBlocked, 'Vorplanung braucht EOS mit Ladestart');
    assert.equal(r.expectedSocPct, 64, 'erwarteter Ladestand trotzdem sichtbar');
  });

  it('angesteckt: echter Ladestand, kein Ladestart', () => {
    const { ctx, cfg } = ctxPlan(2 * HOUR, 10 * HOUR, { plugged: true, teslaPct: null, evccSoc: 55 });
    const r = computeEvRegistration(ctx, cfg, { chargeStartSupported: true, plugged: true, nowMs: NOW });
    assert.equal(r.register, true);
    assert.equal(r.mode, 'plugged');
    assert.equal(r.socPct, 55);
    assert.equal(r.chargeStartAt, null);
  });

  it('Ankunft vor 10 min, noch nicht angesteckt (Kulanz 30 min): weiter vorplanen, Ladestart null', () => {
    const { ctx, cfg } = ctxPlan(-10 * 60_000, 8 * HOUR);
    const r = computeEvRegistration(ctx, cfg, { chargeStartSupported: true, plugged: false, nowMs: NOW });
    assert.equal(r.mode, 'preplan');
    assert.equal(r.chargeStartAt, null);
  });

  it(`Ankunft laenger als ${PREPLAN_GRACE_MS / 60_000} min vorbei und nicht angesteckt: nicht mehr anmelden`, () => {
    const { ctx, cfg } = ctxPlan(-2 * HOUR, 8 * HOUR);
    const r = computeEvRegistration(ctx, cfg, { chargeStartSupported: true, plugged: false, nowMs: NOW });
    assert.equal(r.register, false);
    assert.equal(r.reason, 'nicht angesteckt');
  });

  it('kein erwarteter Ladestand (nichts bekannt): nicht vorplanen, Grund genannt', () => {
    const { ctx, cfg } = ctxPlan(2 * HOUR, 10 * HOUR, { teslaPct: null });
    const r = computeEvRegistration(ctx, cfg, { chargeStartSupported: true, plugged: false, nowMs: NOW });
    assert.equal(r.register, false);
    assert.equal(r.preplanBlocked, 'kein erwarteter Ladestand bei Ankunft');
  });

  it('Abfahrt/Wochenplan aus: keine Vorplanung', () => {
    const { ctx, cfg } = ctxPlan(2 * HOUR, 10 * HOUR, { opt: { evDepartureEnabled: false } });
    const r = computeEvRegistration(ctx, cfg, { chargeStartSupported: true, plugged: false, nowMs: NOW });
    assert.equal(r.register, false);
    assert.equal(r.preplanBlocked, null);
  });

  it('evPlanOnlyWhenPlugged=false ohne Faehigkeit: wie bisher immer anmelden (Ladestand vom Auto)', () => {
    const { ctx, cfg } = ctxPlan(2 * HOUR, 10 * HOUR, { opt: { evPlanOnlyWhenPlugged: false } });
    const r = computeEvRegistration(ctx, cfg, { chargeStartSupported: false, plugged: false, nowMs: NOW });
    assert.equal(r.register, true);
    assert.equal(r.mode, 'always');
    assert.equal(r.socPct, 70);
  });

  it('evPlanOnlyWhenPlugged=false mit Faehigkeit: Vorplanung mit erwartetem Ladestand + Ladestart', () => {
    const { ctx, cfg } = ctxPlan(2 * HOUR, 10 * HOUR, { opt: { evPlanOnlyWhenPlugged: false } });
    const r = computeEvRegistration(ctx, cfg, { chargeStartSupported: true, plugged: false, nowMs: NOW });
    assert.equal(r.mode, 'preplan');
    assert.equal(r.socPct, 64);
  });
});

describe('Abgleich mit EOS (sync/syncEv)', () => {
  it('mit Ladestart: Auto angemeldet, Ladestart = Ankunft, Abfahrt als Frist', async () => {
    mock = await createMockEos(true);
    const now = Date.now();
    const ctx = ctxFor(mock.port, { opt: { evWeeklyPlan: planAround(now, 2 * HOUR, 10 * HOUR) } });
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(bodyOf(mock, 'devices/max_electric_vehicles'), 1);
    const ev = bodyOf(mock, 'devices/electric_vehicles').ev11;
    assert.equal(ev[EOS_EV_CHARGE_START_FIELD], new Date(floorMin(now + 2 * HOUR)).toISOString());
    assert.equal(ev.min_soc_deadline_datetime, new Date(floorMin(now + 10 * HOUR)).toISOString());
    assert.equal(ev.min_soc_percentage, 80);
    assert.equal(ctx.state.optimizer.eos.evChargeStart, true);
    assert.equal(ctx.state.optimizer.eosEv.mode, 'preplan');
    assert.equal(ctx.state.optimizer.eosEv.socPct, 64);

    const evRes = await createEosConfigSync(ctx).syncEv();
    assert.equal(evRes.ok, true);
    assert.equal(evRes.ev[EOS_EV_CHARGE_START_FIELD], ev[EOS_EV_CHARGE_START_FIELD]);
  });

  it('ohne Ladestart: wie bisher abgemeldet, State nennt den Grund', async () => {
    mock = await createMockEos(false);
    const now = Date.now();
    const ctx = ctxFor(mock.port, { opt: { evWeeklyPlan: planAround(now, 2 * HOUR, 10 * HOUR) } });
    await createEosConfigSync(ctx).sync();
    assert.equal(bodyOf(mock, 'devices/max_electric_vehicles'), 0);
    assert.deepEqual(bodyOf(mock, 'devices/electric_vehicles'), {});
    assert.equal(ctx.state.optimizer.eos.evChargeStart, false);
    assert.equal(ctx.state.optimizer.eosEv.preplanBlocked, 'Vorplanung braucht EOS mit Ladestart');
  });

  it('angesteckt mit Faehigkeit: Ladestart ausdruecklich null (raeumt den alten ab)', async () => {
    mock = await createMockEos(true);
    const now = Date.now();
    const ctx = ctxFor(mock.port, { opt: { evWeeklyPlan: planAround(now, 2 * HOUR, 10 * HOUR) }, plugged: true, teslaPct: null, evccSoc: 55 });
    await createEosConfigSync(ctx).sync();
    const ev = bodyOf(mock, 'devices/electric_vehicles').ev11;
    assert.equal(ev[EOS_EV_CHARGE_START_FIELD], null);
    assert.equal(ctx.state.optimizer.eosEv.mode, 'plugged');
  });
});

describe('Ladestand fuer den EOS-Lauf (evSocForEos / socForRun)', () => {
  it('Vorplanung: erwarteter Ladestand statt des Unterwegs-Werts; angesteckt der echte', () => {
    const now = Date.now();
    const ctx = ctxFor(1, { opt: { evWeeklyPlan: planAround(now, 2 * HOUR, 10 * HOUR) } });
    ctx.state.optimizer.eosEv = { register: true, mode: 'preplan', socPct: 64 };
    assert.deepEqual(evSocForEos(ctx), { pct: 64, source: 'arrival-live' });
    const plugged = ctxFor(1, { plugged: true, teslaPct: null, evccSoc: 55 });
    plugged.state.optimizer.eosEv = { register: true, mode: 'preplan', socPct: 64 };
    assert.equal(evSocForEos(plugged).pct, 55, 'angesteckt gewinnt der echte Wert, auch vor dem naechsten Abgleich');
  });

  it('socForRun gibt EOS den erwarteten Ladestand (64 statt 70)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(['battery1-soc-factor', 'ev11-soc-factor']));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const now = Date.now();
      const ctx = ctxFor(server.address().port, { opt: { evWeeklyPlan: planAround(now, 2 * HOUR, 10 * HOUR) } });
      ctx.state.optimizer = { eos: { supported: true }, eosEv: { register: true, mode: 'preplan', socPct: 64 } };
      const bridge = createEosForecastBridge(ctx);
      assert.deepEqual(await bridge.socForRun(), { soc: { battery1: 50, ev11: 64 } });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('Minuten-Wache (ev-watch.js)', () => {
  function fakeSync() {
    const calls = [];
    return {
      calls,
      sync: async () => { calls.push('sync'); return { ok: true }; },
      syncEv: async () => { calls.push('syncEv'); return { ok: true }; },
    };
  }

  it('Vorplanung beginnt/endet ohne Steckwechsel → voller Abgleich + Neuplan', async () => {
    const now = Date.now();
    const ctx = ctxFor(1, { opt: { evWeeklyPlan: planAround(now, 2 * HOUR, 10 * HOUR) } });
    ctx.state.optimizer.eos = { supported: true, evChargeStart: false };
    const eos = fakeSync();
    const replans = [];
    const watch = createEvWatch({ ctx, eosConfigSync: eos, requestReplan: (why) => replans.push(why), pushLog: () => {} });
    await watch.tick(now);
    assert.deepEqual(replans, [], 'erste Beobachtung setzt nur den Ausgangszustand');
    // EOS kann jetzt Ladestart (Update) → Vorplanung wird moeglich.
    ctx.state.optimizer.eos.evChargeStart = true;
    await watch.tick(now + 60_000);
    assert.ok(eos.calls.includes('sync'));
    assert.deepEqual(replans, ['ev_preplan']);
  });

  it('Ladestart faellt weg (Ankunft erreicht) → nur das Fahrzeug neu schicken', async () => {
    const now = Date.now();
    const ctx = ctxFor(1, { opt: { evWeeklyPlan: planAround(now, 2 * 60_000, 10 * HOUR) } });
    ctx.state.optimizer.eos = { supported: true, evChargeStart: true };
    const eos = fakeSync();
    const watch = createEvWatch({ ctx, eosConfigSync: eos, requestReplan: () => {}, pushLog: () => {} });
    await watch.tick(now);
    eos.calls.length = 0;
    await watch.tick(now + 60_000);
    assert.deepEqual(eos.calls, [], 'nichts geaendert');
    await watch.tick(now + 3 * 60_000);   // Ankunft vorbei → Ladestart null
    assert.deepEqual(eos.calls, ['syncEv']);
  });

  it('merkt sich jede Minute den Ladestand (Schaetzbasis)', async () => {
    const ctx = ctxFor(1, {});
    const seen = [];
    ctx.evSocMemory = { observe: (r) => seen.push(r), get: () => null };
    ctx.getCfg().optimizer.eosOptimizeEv = false;
    const watch = createEvWatch({ ctx, eosConfigSync: fakeSync(), requestReplan: () => {}, pushLog: () => {} });
    await watch.tick(Date.now());
    assert.equal(seen.length, 1);
    assert.equal(seen[0].pct, 70);
  });
});

describe('Codex-Befunde Runde 2 (Minuten-Wache)', () => {
  it('kurzes „nicht angesteckt“ (evcc wackelt) loest keinen Abgleich und keinen Neuplan aus', async () => {
    const now = Date.now();
    let connected = true;
    const ctx = ctxFor(1, { opt: { evWeeklyPlan: planAround(now, 2 * HOUR, 10 * HOUR) }, teslaPct: null });
    ctx.evccIntegration = { getLoadpoints: () => [{ id: 1, connected, vehicleSocPct: connected ? 55 : 0 }] };
    ctx.state.optimizer.eos = { supported: true, evChargeStart: true };
    const calls = [];
    const replans = [];
    const watch = createEvWatch({
      ctx, requestReplan: (w) => replans.push(w), pushLog: () => {},
      eosConfigSync: { sync: async () => { calls.push('sync'); return { ok: true }; }, syncEv: async () => { calls.push('syncEv'); return { ok: true }; } },
    });
    await watch.tick(now);
    calls.length = 0;
    connected = false;                     // eine Abfrage lang weg
    await watch.tick(now + 60_000);
    connected = true;
    await watch.tick(now + 120_000);
    assert.deepEqual(calls.filter((c) => c === 'sync'), []);
    assert.deepEqual(replans, []);
  });
});
