// test/ev-no-evcc.test.js -- Wochenplan, erwarteter Ladestand, „angesteckt“
// und EOS-Vorplanung OHNE evcc (Owner-Vorgabe 2026-10-27): jede Anlage soll
// genauso funktionieren — mit DVhubs eigener Wallbox-Anbindung, nur MQTT, nur
// HTTP-Abruf oder nur Home Assistant. In keinem ctx steht evccIntegration.
//
// Rechenbasis (von Hand): 60 kWh, 18 kWh/100 km, Heimweg 20 km → 6 % je Weg.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createEosConfigSync } from '../services/optimizer/eos-config-sync.js';
import { createEosForecastBridge } from '../services/optimizer/eos-forecast-bridge.js';
import { EOS_EV_CHARGE_START_FIELD } from '../services/optimizer/eos-capabilities.js';
import { resolveEvArrival } from '../services/optimizer/ev-arrival.js';
import { resolveEvPlugged, createEvSocMemory, resolveEvSocReading } from '../services/optimizer/ev-soc.js';

const TZ = 'Europe/Berlin';
const HOUR = 3600_000;
const hhmm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const floorMin = (ms) => Math.floor(ms / 60_000) * 60_000;
// Jeder Tag gleich: Ankunft in 2 h, Abfahrt in 10 h → letzte Abfahrt vor 14 h.
const planAround = (now) => [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, arrival: hhmm(now + 2 * HOUR), departure: hhmm(now + 10 * HOUR) }));

let eos = null;
afterEach(async () => { if (eos) { await eos.close(); eos = null; } });

/** EOS-Attrappe mit Ladestart-Faehigkeit; merkt sich die PUTs. */
function mockEos() {
  const puts = [];
  const config = {
    optimization: { algorithm: 'GENETIC', genetic: { interval_sec: 3600, horizon_hours: 48 }, genetic0: {} },
    feedintariff: { provider: null, direct_marketing_enabled: true },
    devices: {
      batteries: { battery1: { device_id: 'battery1', [EOS_EV_CHARGE_START_FIELD]: null } },
      inverters: { inverter1: { device_id: 'inverter1' } }, electric_vehicles: {}, home_appliances: {}, max_home_appliances: 0,
    },
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && req.url === '/v1/config') return res.end(JSON.stringify(config));
        if (req.method === 'GET' && req.url === '/v1/health') return res.end('{"status":"alive","version":"0.4-test"}');
        if (req.method === 'GET' && req.url.startsWith('/v1/measurement/keys')) return res.end(JSON.stringify(['battery1-soc-factor', 'ev11-soc-factor']));
        if (req.method === 'PUT') puts.push({ section: req.url.replace('/v1/config/', ''), body: raw ? JSON.parse(raw) : undefined });
        return res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, puts, close: () => new Promise((r) => server.close(r)) }));
  });
}
const lastBody = (m, section) => (m.puts.filter((p) => p.section === section).at(-1) || {}).body;

function baseCtx(port, now, extra = {}) {
  const cfg = {
    schedule: { timezone: TZ },
    wallbox: { type: extra.wallboxType || 'evcc' },   // Standardwert — evcc selbst ist NICHT eingerichtet
    optimizer: {
      eosProxy: { enabled: true, url: `http://127.0.0.1:${port}` },
      batteryCapacityWh: 10000, maxChargeW: 5000, eosOptimizationIntervalSec: 900,
      eosOptimizeEv: true, evCapacityWh: 60000, evConsumptionKwhPer100km: 18, evCommuteKm: 20,
      evDepartureEnabled: true, evTargetMode: 'percent', evTargetValue: 80, evWeeklyPlan: planAround(now),
      evSocSource: 'auto', ...(extra.opt || {}),
    },
  };
  return { state: { victron: { soc: 50, minSocPct: 5 }, optimizer: {} }, pushLog: () => {}, getCfg: () => cfg };
}

async function runEos(ctx) {
  await createEosConfigSync(ctx).sync();
  const run = await createEosForecastBridge(ctx).socForRun();
  return run.soc || {};
}

describe('ohne evcc: nur DVhubs eigene Wallbox-Anbindung (OpenEVSE)', () => {
  const wallbox = (connected, vehicleSocPct) => ({
    isDirect: () => true, label: () => 'OpenEVSE',
    state: () => ({ type: 'openevse', available: true, connected, vehicleSocPct: connected ? vehicleSocPct : null }),
  });

  it('angesteckt mit 55 %: plugged, Ankunft = echter Wert, EOS ohne Ladestart', async () => {
    eos = await mockEos();
    const now = Date.now();
    const ctx = Object.assign(baseCtx(eos.port, now, { wallboxType: 'openevse' }), { mainWallbox: wallbox(true, 55) });
    assert.equal(resolveEvPlugged(ctx), true);
    const a = resolveEvArrival(ctx, ctx.getCfg(), { plugged: true, nowMs: now });
    assert.deepEqual([a.pct, a.source], [55, 'plugged']);
    const soc = await runEos(ctx);
    const ev = lastBody(eos, 'devices/electric_vehicles').ev11;
    assert.equal(ctx.state.optimizer.eosEv.mode, 'plugged');
    assert.equal(ev[EOS_EV_CHARGE_START_FIELD], null);
    assert.equal(soc.ev11, 55);
  });

  it('abgesteckt: gemerkter Wallbox-Wert von vor der Abfahrt → 55 − 2 × 6 = 43 % (geschaetzt), Vorplanung ab Ankunft', async () => {
    eos = await mockEos();
    const now = Date.now();
    const ctx = Object.assign(baseCtx(eos.port, now, { wallboxType: 'openevse' }), { mainWallbox: wallbox(false) });
    ctx.evSocMemory = createEvSocMemory();
    ctx.evSocMemory.observe({ pct: 55, source: 'openevse', atMs: now - 15 * HOUR });   // vor der Abfahrt (vor 14 h)
    assert.equal(resolveEvPlugged(ctx), false);
    const a = resolveEvArrival(ctx, ctx.getCfg(), { plugged: false, nowMs: now });
    assert.deepEqual([a.pct, a.source, a.legs], [43, 'estimate', 2]);
    const soc = await runEos(ctx);
    const ev = lastBody(eos, 'devices/electric_vehicles').ev11;
    assert.equal(ev[EOS_EV_CHARGE_START_FIELD], new Date(floorMin(now + 2 * HOUR)).toISOString());
    assert.equal(ev.min_soc_deadline_datetime, new Date(floorMin(now + 10 * HOUR)).toISOString());
    assert.equal(soc.ev11, 43);
  });
});

// Die drei Fahrzeug-Quellen ohne Wallbox-Anbindung: das Auto meldet unterwegs
// 70 % (vor 1 min) und „nicht angesteckt“ → erwartet 70 − 6 = 64 % (live).
const VEHICLE_ONLY = {
  'nur MQTT': (now) => ({ vehicleMqtt: { getState: () => ({ configured: true, socPct: 70, socAt: now - 60_000, plugged: false }) } }),
  'nur HTTP-Abruf': (now) => ({ vehiclePull: { getState: (k) => (k === 'http' ? { configured: true, socPct: 70, socAt: now - 60_000, plugged: false } : { configured: false, socPct: null, plugged: null }) } }),
  'nur Home Assistant': (now) => ({ vehiclePull: { getState: (k) => (k === 'homeassistant' ? { configured: true, socPct: 70, socAt: now - 60_000, plugged: false } : { configured: false, socPct: null, plugged: null }) } }),
};

for (const [name, sources] of Object.entries(VEHICLE_ONLY)) {
  describe(`ohne evcc: ${name}`, () => {
    it('unterwegs 70 % → 64 % live, nicht angesteckt, EOS-Vorplanung mit Ladestart', async () => {
      eos = await mockEos();
      const now = Date.now();
      const ctx = Object.assign(baseCtx(eos.port, now), sources(now));
      assert.equal(resolveEvPlugged(ctx), false);
      assert.equal(resolveEvSocReading(ctx, now).atMs, now - 60_000, 'Quelle nennt ihren Zeitpunkt');
      const a = resolveEvArrival(ctx, ctx.getCfg(), { plugged: false, nowMs: now });
      assert.deepEqual([a.pct, a.source], [64, 'live']);
      const soc = await runEos(ctx);
      assert.equal(lastBody(eos, 'devices/max_electric_vehicles'), 1);
      const ev = lastBody(eos, 'devices/electric_vehicles').ev11;
      assert.equal(ev[EOS_EV_CHARGE_START_FIELD], new Date(floorMin(now + 2 * HOUR)).toISOString());
      assert.equal(ev.min_soc_percentage, 80);
      assert.equal(ctx.state.optimizer.eosEv.mode, 'preplan');
      assert.equal(soc.ev11, 64);
    });

    it('angesteckt gemeldet: echter Wert gewinnt, kein Ladestart', async () => {
      eos = await mockEos();
      const now = Date.now();
      const ctx = Object.assign(baseCtx(eos.port, now), sources(now));
      // Gleiche Quelle, jetzt „angesteckt“ mit 70 %.
      const key = Object.keys(sources(now))[0];
      const orig = ctx[key].getState;
      ctx[key] = { getState: (k) => { const s = orig(k); return s.configured ? { ...s, plugged: true } : s; } };
      assert.equal(resolveEvPlugged(ctx), true);
      const a = resolveEvArrival(ctx, ctx.getCfg(), { plugged: true, nowMs: now });
      assert.deepEqual([a.pct, a.source], [70, 'plugged']);
      const soc = await runEos(ctx);
      assert.equal(ctx.state.optimizer.eosEv.mode, 'plugged');
      assert.equal(lastBody(eos, 'devices/electric_vehicles').ev11[EOS_EV_CHARGE_START_FIELD], null);
      assert.equal(soc.ev11, 70);
    });

    it('veralteter Wert der Quelle (liefert null) → kein erwarteter Ladestand, keine Vorplanung', async () => {
      eos = await mockEos();
      const now = Date.now();
      const ctx = baseCtx(eos.port, now);
      const key = Object.keys(sources(now))[0];
      ctx[key] = { getState: () => ({ configured: true, socPct: null, socStale: true, socAt: now - 48 * HOUR, plugged: false }) };
      const a = resolveEvArrival(ctx, ctx.getCfg(), { plugged: false, nowMs: now });
      assert.equal(a.pct, null);
      await createEosConfigSync(ctx).sync();
      assert.equal(lastBody(eos, 'devices/max_electric_vehicles'), 0);
      assert.equal(ctx.state.optimizer.eosEv.preplanBlocked, 'kein erwarteter Ladestand bei Ankunft');
    });
  });
}
