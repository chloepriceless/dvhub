// test/eos-config-sync-flavors.test.js -- der Konfigurationsabgleich schreibt
// nur noch gegen EOS 0.4 (Upstream ab #1330). Ältere Fassungen (0.3-Fork,
// Maintainer-Branch, Upstream-main vor #1330) werden erkannt und bekommen
// GAR NICHTS geschrieben.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createEosConfigSync } from '../services/optimizer/eos-config-sync.js';

const CONFIGS = {
  dvFork: {
    optimization: { interval: 900, hours: 48, genetic: { individuals: 300, generations: 400 } },
    feedintariff: { provider: 'FeedInTariffImport' },
    devices: { batteries: [], inverters: [], max_home_appliances: 0 },
  },
  upstreamDm: {
    optimization: { interval: 3600, hours: 48, genetic: { individuals: 300, generations: 400 } },
    feedintariff: { provider: null, direct_marketing_enabled: false },
    devices: { batteries: null, inverters: null, max_home_appliances: null, home_appliances: null },
  },
  upstreamMain: {
    optimization: { hours: 48, genetic: { individuals: 300, generations: 400, interval_sec: 3600 } },
    feedintariff: { provider: null },
    devices: { batteries: null, inverters: null },
  },
  // Nachgebildet aus GET /v1/config einer echten v0.4.0rc1-Instanz
  // (ARM64-Testbox, 21.09.2026) — gekürzt auf die Schlüssel,
  // an denen die Erkennung hängt:
  //   optimization: ['algorithm','algorithms','genetic','genetic0','keys']
  //   genetic.interval_sec vorhanden, optimization.interval NICHT
  //   feedintariff.direct_marketing_enabled vorhanden
  //   devices.batteries = {battery1: …}, electric_vehicles = {}
  //   elecprice ohne charges_kwh / vat_rate
  upstreamGenetic: {
    optimization: {
      algorithm: 'GENETIC',
      algorithms: ['GENETIC', 'GENETIC0'],
      genetic: { individuals: 300, generations: 400, interval_sec: 3600, horizon_hours: 48 },
      genetic0: {},
      keys: [],
    },
    feedintariff: { provider: null, direct_marketing_enabled: true },
    devices: {
      batteries: { battery1: { device_id: 'battery1' } },
      inverters: { inverter1: { device_id: 'inverter1' } },
      electric_vehicles: {},
      home_appliances: {},
      max_home_appliances: 0,
    },
    elecprice: { provider: 'ElecPriceImport', providers: [] },
  },
};

// Mock-EOS: liefert GET /v1/config je nach Fassung, nimmt PUTs an und merkt
// sie sich. `unknownKeys` simuliert ein EOS, das einen Schlüssel ablehnt.
function createMockEos(configKind, unknownKeys = []) {
  const puts = [];
  const gets = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
        if (req.method === 'GET' && req.url === '/v1/config') {
          gets.push(req.url);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(CONFIGS[configKind]));
        }
        if (req.method === 'GET' && req.url === '/v1/health') {
          gets.push(req.url);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'alive', version: '0.3.0-test' }));
        }
        if (req.method === 'PUT') {
          const section = req.url.replace('/v1/config/', '');
          if (unknownKeys.includes(section)) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ detail: 'unknown config key' }));
          }
          puts.push({ section, body });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(404); res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, puts, gets,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function ctxFor(port, overrides = {}) {
  const state = { victron: { minSocPct: 5 }, optimizer: {} };
  return {
    state,
    pushLog: () => {},
    getCfg: () => ({
      optimizer: {
        eosProxy: { enabled: true, url: `http://127.0.0.1:${port}` },
        batteryCapacityWh: 43000, maxChargeW: 18000, roundTripEfficiency: 0.92,
        eosOptimizationIntervalSec: 900,
        tariff: { feedInMode: 'spot' },
        ...overrides,
      },
    }),
  };
}

let mock;
afterEach(async () => { if (mock) { await mock.close(); mock = null; } });

const sectionsOf = (m) => m.puts.map((p) => p.section);
const bodyOf = (m, section) => (m.puts.find((p) => p.section === section) || {}).body;

const LEGACY = ['dvFork', 'upstreamDm', 'upstreamMain'];

describe('Alte EOS-Fassung (nicht mehr unterstützt)', () => {
  for (const kind of LEGACY) {
    it(`${kind}: sync() schreibt nichts, meldet eos_unsupported`, async () => {
      mock = await createMockEos(kind);
      const logs = [];
      const ctx = ctxFor(mock.port);
      ctx.pushLog = (ev, data) => logs.push({ ev, data });
      const res = await createEosConfigSync(ctx).sync();
      assert.equal(res.ok, false);
      assert.equal(res.skipped, 'eos_unsupported');
      assert.match(res.reason, /EOS 0\.4/);
      assert.deepEqual(mock.puts, [], 'kein einziger PUT');
      assert.equal(ctx.state.optimizer.eos.supported, false);
      assert.equal(ctx.state.optimizer.eos.reachable, true);
      assert.match(ctx.state.optimizer.eos.reason, /nicht mehr unterstützt/);
      const unsupported = logs.filter((l) => l.ev === 'eos_unsupported_version');
      assert.equal(unsupported.length, 1);
      assert.equal(unsupported[0].data.version, '0.3.0-test');
      assert.ok(unsupported[0].data.flavor);
      assert.equal(logs.some((l) => l.ev === 'eos_config_sync'), false);
    });
  }

  it('syncEv() schreibt nichts gegen eine alte Fassung', async () => {
    mock = await createMockEos('dvFork');
    const ctx = ctxFor(mock.port, { eosOptimizeEv: true, evPlanOnlyWhenPlugged: false });
    ctx.teslamateService = { getState: () => ({ batteryLevel: 40 }) };
    const res = await createEosConfigSync(ctx).syncEv();
    assert.equal(res.ok, false);
    assert.equal(res.skipped, 'eos_unsupported');
    assert.deepEqual(mock.puts, []);
    assert.equal(ctx.state.optimizer.eos.supported, false);
  });

  it('eos_unsupported_version nur beim Wechsel, nicht bei jedem Lauf', async () => {
    mock = await createMockEos('upstreamMain');
    const logs = [];
    const ctx = ctxFor(mock.port);
    ctx.pushLog = (ev) => logs.push(ev);
    const sync = createEosConfigSync(ctx);
    await sync.sync();
    await sync.sync();
    await sync.syncEv();
    assert.equal(logs.filter((e) => e === 'eos_unsupported_version').length, 1);
  });
});

describe('EOS nicht erreichbar', () => {
  it('schreibt nichts und meldet eos_unreachable', async () => {
    const ctx = ctxFor(1); // Port 1: niemand hört zu
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, false);
    assert.equal(res.skipped, 'eos_unreachable');
    assert.equal(ctx.state.optimizer.eos.reachable, false);
    assert.equal(ctx.state.optimizer.eos.supported, null);
  });

  it('Erkennung läuft höchstens einmal je Abgleich', async () => {
    mock = await createMockEos('upstreamGenetic');
    const sync = createEosConfigSync(ctxFor(mock.port));
    await sync.sync();
    const nachErstem = mock.gets.filter((u) => u === '/v1/config').length;
    assert.equal(nachErstem, 1);
    await sync.sync();
    assert.equal(mock.gets.filter((u) => u === '/v1/config').length, 1,
      'zweiter Abgleich nutzt die gemerkte Erkennung');
  });
});

// --- v0.4.0rc1 (#1330 „complete GENETIC optimization") ---------------------
//
// Der Umbau vom 17.09.2026 ändert vier Dinge auf einmal, und drei davon
// scheitern still, wenn DVhub sie nicht mitmacht. Am 20.09. gegen die echte
// Instanz gemessen: das alte Schema kam auf 10 von 16 PUTs, das neue auf 7/7;
// nach dem Umbau 14/14.
// --- Geraetezaehler: ohne sie gilt die Geraeteliste als nicht konfiguriert --
//
// Auf prod am 21.09.2026 aufgetreten: fehlten max_batteries/max_inverters,
// meldete EOS "Number of battery devices not configured", leitete KEINE
// Messschluessel ab (/v1/measurement/keys nur "date_time"), jeder SoC-PUT
// scheiterte mit 404, der Optimierer rechnete mit SoC=0 und lieferte gar
// keine Loesung -- DVhub fiel still auf den internen Plan zurueck.
describe('Geraetezaehler (max_batteries / max_inverters)', () => {
  for (const kind of ['upstreamGenetic']) {
    it(`werden gegen ${kind} gesetzt, und zwar VOR den Geraeten`, async () => {
      mock = await createMockEos(kind);
      await createEosConfigSync(ctxFor(mock.port)).sync();
      const sec = sectionsOf(mock);
      assert.equal(bodyOf(mock, 'devices/max_batteries'), 1);
      assert.equal(bodyOf(mock, 'devices/max_inverters'), 1);
      assert.ok(sec.indexOf('devices/max_batteries') < sec.indexOf('devices/batteries'),
        'das Limit muss vor der Liste stehen, sonst weist EOS die Geraete ab');
      assert.ok(sec.indexOf('devices/max_inverters') < sec.indexOf('devices/inverters'));
    });
  }
});

describe('Abgleich gegen Upstream ab #1330 (upstream-genetic)', () => {
  it('schreibt genau diese Abschnitte, in dieser Reihenfolge', async () => {
    mock = await createMockEos('upstreamGenetic');
    const res = await createEosConfigSync(ctxFor(mock.port)).sync();
    assert.equal(res.ok, true);
    assert.equal(res.eos.supported, true);
    assert.deepEqual(sectionsOf(mock), [
      'devices/max_batteries', 'devices/max_inverters', 'devices/batteries', 'devices/inverters',
      'devices/max_electric_vehicles', 'devices/electric_vehicles',
      'devices/max_home_appliances', 'devices/home_appliances',
      'optimization/algorithm', 'optimization/genetic/interval_sec',
      'optimization/genetic/generations', 'optimization/genetic/individuals',
      'ems/interval', 'pvforecast/provider', 'load/provider', 'elecprice/provider', 'measurement/historic_hours', 'database/autosave_interval_sec', 'ems/mode',
      'feedintariff/provider', 'feedintariff/direct_marketing_enabled',
    ]);
    assert.equal(bodyOf(mock, 'devices/max_home_appliances'), 0);
    assert.deepEqual(bodyOf(mock, 'devices/home_appliances'), {}, 'Abbildung wird mitgeleert');
  });

  it('rc1.6: setzt die Eigenverbrauchstabelle auf numpy, wenn EOS den Schalter kennt', async () => {
    const saved = CONFIGS.upstreamGenetic;
    CONFIGS.upstreamGenetic = { ...saved, optimization: { ...saved.optimization, self_consumption_interpolator: 'scipy' } };
    try {
      mock = await createMockEos('upstreamGenetic');
      await createEosConfigSync(ctxFor(mock.port)).sync();
      assert.equal(bodyOf(mock, 'optimization/self_consumption_interpolator'), 'numpy');
    } finally {
      CONFIGS.upstreamGenetic = saved;
    }
  });

  it('dynamische Preise: trotzdem kein charges_kwh / vat_rate', async () => {
    mock = await createMockEos('upstreamGenetic');
    const ctx = ctxFor(mock.port);
    const base = ctx.getCfg();
    ctx.getCfg = () => ({ ...base, userEnergyPricing: { mode: 'dynamic', dynamicComponents: { gridChargesCtKwh: 10, vatPct: 19 } } });
    await createEosConfigSync(ctx).sync();
    assert.equal(sectionsOf(mock).some((x) => x.startsWith('elecprice/charges') || x === 'elecprice/vat_rate'), false);
  });

  it('schreibt Geräte als Abbildung nach device_id statt als Liste', async () => {
    mock = await createMockEos('upstreamGenetic');
    const ctx = ctxFor(mock.port);
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true);
    assert.equal(ctx.state.optimizer.eos.flavor, 'upstream-genetic');
    assert.equal(ctx.state.optimizer.eos.supported, true);

    const bat = bodyOf(mock, 'devices/batteries');
    assert.ok(bat && !Array.isArray(bat) && typeof bat === 'object', 'batteries als Abbildung');
    assert.equal(bat.battery1.device_id, 'battery1', 'Schlüssel ist die device_id');
    const inv = bodyOf(mock, 'devices/inverters');
    assert.equal(inv.inverter1.battery_id, 'battery1', 'Wechselrichter zeigt weiter auf die Batterie');
    assert.deepEqual(bodyOf(mock, 'devices/electric_vehicles'), {},
      'leere Abbildung statt leerer Liste — eine Liste quittiert EOS mit 400');
  });

  it('benennt die Speicherkosten mit um (sonst rechnet EOS Zyklen als kostenlos)', async () => {
    mock = await createMockEos('upstreamGenetic');
    await createEosConfigSync(ctxFor(mock.port)).sync();
    const bat = bodyOf(mock, 'devices/batteries').battery1;
    assert.ok('levelized_cost_of_storage_amt_kwh' in bat, 'neuer Feldname');
    assert.equal('levelized_cost_of_storage_kwh' in bat, false, 'alter Feldname muss weg');
  });

  it('behält die 15 Minuten — auf dem neuen Pfad, ohne Herabstufung', async () => {
    mock = await createMockEos('upstreamGenetic');
    const ctx = ctxFor(mock.port);
    await createEosConfigSync(ctx).sync();
    assert.equal(bodyOf(mock, 'optimization/genetic/interval_sec'), 900,
      'ab #1330 sind 15 Minuten wieder erlaubt — NICHT auf 3600 herabstufen');
    assert.equal(sectionsOf(mock).includes('optimization/interval'), false,
      'der alte Schlüssel ist gelöscht; ein PUT darauf quittiert mit 400');
  });

  it('wählt GENETIC ausdrücklich, statt den Vorgabewert zu erben', async () => {
    mock = await createMockEos('upstreamGenetic');
    await createEosConfigSync(ctxFor(mock.port)).sync();
    assert.equal(bodyOf(mock, 'optimization/algorithm'), 'GENETIC',
      'GENETIC0 steht als Altlast daneben — die Wahl gehört nicht dem Zufall');
  });

  it('lässt charges_kwh und vat_rate weg (Schlüssel gelöscht, Wirkung hatten sie nie)', async () => {
    mock = await createMockEos('upstreamGenetic');
    await createEosConfigSync(ctxFor(mock.port)).sync();
    assert.equal(sectionsOf(mock).includes('elecprice/charges_kwh'), false);
    assert.equal(sectionsOf(mock).includes('elecprice/vat_rate'), false);
    assert.ok(sectionsOf(mock).includes('elecprice/provider'), 'der Provider wird weiter gesetzt');
  });

  it('schreibt den Direktvermarktungs-Schalter als Pflicht-Task', async () => {
    mock = await createMockEos('upstreamGenetic');
    const res = await createEosConfigSync(ctxFor(mock.port)).sync();
    assert.equal(bodyOf(mock, 'feedintariff/direct_marketing_enabled'), true);
    assert.equal(res.ok, true);
  });
});

// --- E-Auto-Abfahrt (2026-09-22) --------------------------------------------
// Ziel + Uhrzeit (`min_soc_deadline_datetime`, EOS 0.4) gehen immer mit.
describe('E-Auto: Ziel + Abfahrt', () => {
  const dep = {
    eosOptimizeEv: true, evCapacityWh: 60000,
    evDepartureEnabled: true, evDepartureTime: '07:00', evDepartureDays: [1, 2, 3, 4, 5, 6, 7],
    evTargetMode: 'kwh', evTargetValue: 45,
  };

  // Auto steckt (evcc) — ohne Stecker meldet DVhub es seit 2026-09-23 gar
  // nicht an (evPlanOnlyWhenPlugged); diese Tests pruefen Ziel/Abfahrt/SoC.
  const ctxP = (port, d) => Object.assign(ctxFor(port, d), {
    evccIntegration: { getLoadpoints: () => [{ id: 1, connected: true }] },
  });
  const withTesla = (ctx, batteryLevel = 40) => Object.assign(ctx, {
    teslamateService: { getState: () => ({ batteryLevel }) },
  });

  it('upstream-genetic: Ziel + Uhrzeit im Fahrzeug, auch ueber syncEv()', async () => {
    mock = await createMockEos('upstreamGenetic');
    const ctx = withTesla(ctxP(mock.port, dep));
    await createEosConfigSync(ctx).sync();
    const ev = bodyOf(mock, 'devices/electric_vehicles').ev11;
    assert.equal(ev.min_soc_percentage, 75);
    assert.ok(Date.parse(ev.min_soc_deadline_datetime) > Date.now(), 'Abfahrt liegt in der Zukunft');
    assert.equal(ctx.state.optimizer.eos.supported, true);

    const res = await createEosConfigSync(ctx).syncEv();
    assert.equal(res.ok, true);
    assert.equal(res.ev.min_soc_deadline_datetime, ev.min_soc_deadline_datetime);
  });

  // prod 2026-09-23: ohne Fahrzeug-SoC brach 0.4 JEDEN Lauf ab ("Fresh SoC
  // missing for ev11") — auch der Hausakku blieb ohne Plan.
  it('upstream-genetic OHNE Fahrzeug-SoC: Auto nicht anmelden, Grund im State', async () => {
    mock = await createMockEos('upstreamGenetic');
    const ctx = ctxP(mock.port, dep);
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true);
    assert.equal(bodyOf(mock, 'devices/max_electric_vehicles'), 0);
    assert.deepEqual(bodyOf(mock, 'devices/electric_vehicles'), {});
    assert.equal(ctx.state.optimizer.eosEv.wanted, true);
    assert.equal(ctx.state.optimizer.eosEv.register, false);
    assert.match(ctx.state.optimizer.eosEv.reason, /Ladestand/);
    assert.equal((await createEosConfigSync(ctx).syncEv()).skipped, 'no ev soc');
  });


  it('evcc-SoC springt ein, wenn TeslaMate nichts hat', async () => {
    mock = await createMockEos('upstreamGenetic');
    const ctx = Object.assign(ctxP(mock.port, dep), {
      teslamateService: { getState: () => ({ batteryLevel: null }) },
      evccIntegration: { getLoadpoints: () => [{ id: 1, connected: true, vehicleSocPct: 55 }] },
    });
    await createEosConfigSync(ctx).sync();
    assert.equal(bodyOf(mock, 'devices/max_electric_vehicles'), 1);
    assert.equal(ctx.state.optimizer.eosEv.socSource, 'evcc');
  });


  it('syncEv() tut nichts, solange das E-Auto nicht mitoptimiert wird', async () => {
    mock = await createMockEos('upstreamGenetic');
    const res = await createEosConfigSync(ctxP(mock.port, { ...dep, eosOptimizeEv: false })).syncEv();
    assert.equal(res.skipped, 'eosOptimizeEv=false');
    assert.equal(sectionsOf(mock).includes('devices/electric_vehicles'), false);
  });

  it('nicht angesteckt: Auto nicht anmelden, Grund im State (evPlanOnlyWhenPlugged, Standard)', async () => {
    mock = await createMockEos('upstreamGenetic');
    const ctx = Object.assign(withTesla(ctxFor(mock.port, dep)), {
      evccIntegration: { getLoadpoints: () => [{ id: 1, connected: false, vehicleSocPct: 0 }] },
    });
    await createEosConfigSync(ctx).sync();
    assert.equal(bodyOf(mock, 'devices/max_electric_vehicles'), 0);
    assert.equal(ctx.state.optimizer.eosEv.register, false);
    assert.equal(ctx.state.optimizer.eosEv.reason, 'nicht angesteckt');
    assert.equal(ctx.state.optimizer.eosEv.plugged, false);
  });

  it('evcc unbekannt: ebenfalls nicht anmelden', async () => {
    mock = await createMockEos('upstreamGenetic');
    const ctx = withTesla(ctxFor(mock.port, dep));
    await createEosConfigSync(ctx).sync();
    assert.equal(bodyOf(mock, 'devices/max_electric_vehicles'), 0);
    assert.match(ctx.state.optimizer.eosEv.reason, /unbekannt/);
  });

  it('evPlanOnlyWhenPlugged=false: altes Verhalten, auch ohne Stecker anmelden', async () => {
    mock = await createMockEos('upstreamGenetic');
    const ctx = withTesla(ctxFor(mock.port, { ...dep, evPlanOnlyWhenPlugged: false }));
    await createEosConfigSync(ctx).sync();
    assert.equal(bodyOf(mock, 'devices/max_electric_vehicles'), 1);
    assert.equal(ctx.state.optimizer.eosEv.register, true);
  });
});
