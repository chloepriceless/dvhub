// test/eos-config-sync-flavors.test.js -- der Konfigurationsabgleich richtet
// sich nach der erkannten EOS-Fassung (2026-09-15).
//
// Ziel: derselbe DVhub spricht mit unserem Fork UND mit dem Maintainer-Branch,
// ohne dass jemand etwas umstellt. Umgekehrt darf gegen den alten Fork kein
// Schlüssel geschrieben werden, den er nicht kennt — das war bisher ein
// dauerhaft roter optionaler Task.
import { describe, it, beforeEach, afterEach } from 'node:test';
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

describe('Abgleich gegen unseren Fork (dv-fork)', () => {
  it('schreibt den Direktvermarktungs-Schalter NICHT und meldet die Fassung', async () => {
    mock = await createMockEos('dvFork');
    const ctx = ctxFor(mock.port);
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true);
    assert.equal(sectionsOf(mock).includes('feedintariff/direct_marketing_enabled'), false,
      'der Fork kennt den Schlüssel nicht — gar nicht erst schreiben');
    assert.ok(sectionsOf(mock).includes('optimization/interval'));
    assert.equal(ctx.state.optimizer.eos.flavor, 'dv-fork');
    assert.equal(ctx.state.optimizer.eos.supports.directMarketingFlag, false);
  });

  it('behält das 15-Minuten-Intervall', async () => {
    mock = await createMockEos('dvFork');
    await createEosConfigSync(ctxFor(mock.port)).sync();
    assert.equal(bodyOf(mock, 'optimization/interval'), 900);
  });
});

describe('Abgleich gegen den Maintainer-Branch (upstream-dm)', () => {
  it('schreibt den Direktvermarktungs-Schalter als Pflicht-Task', async () => {
    mock = await createMockEos('upstreamDm');
    const ctx = ctxFor(mock.port);
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true);
    assert.equal(bodyOf(mock, 'feedintariff/direct_marketing_enabled'), true,
      'Einspeisemodus spot → Direktvermarktung an');
    assert.equal(ctx.state.optimizer.eos.flavor, 'upstream-dm');
    assert.equal(ctx.state.optimizer.eos.supports.applianceScheduling, true);
  });

  it('ein abgelehnter Pflicht-Schalter kippt den Gesamtstatus', async () => {
    mock = await createMockEos('upstreamDm', ['feedintariff/direct_marketing_enabled']);
    const res = await createEosConfigSync(ctxFor(mock.port)).sync();
    assert.equal(res.ok, false);
    assert.ok(res.errors['feedintariff/direct_marketing_enabled']);
  });

  it('Einspeisemodus fest → Schalter wird auf false gesetzt, nicht weggelassen', async () => {
    mock = await createMockEos('upstreamDm');
    await createEosConfigSync(ctxFor(mock.port, { tariff: { feedInMode: 'fixed' } })).sync();
    assert.equal(bodyOf(mock, 'feedintariff/direct_marketing_enabled'), false);
  });
});

describe('Abgleich gegen heutiges Upstream-main', () => {
  it('schreibt das Intervall auf den anderen Pfad und stuft auf 3600 s herab', async () => {
    mock = await createMockEos('upstreamMain');
    const ctx = ctxFor(mock.port);
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true);
    assert.equal(sectionsOf(mock).includes('optimization/interval'), false);
    assert.equal(bodyOf(mock, 'optimization/genetic/interval_sec'), 3600,
      'main kennt keine 15 Minuten — herabstufen statt Fehler');
    assert.equal(ctx.state.optimizer.eos.flavor, 'upstream-main');
    assert.equal(ctx.state.optimizer.eos.supports.quarterHour, false);
  });
});

describe('EOS nicht erreichbar / unbekannte Fassung', () => {
  it('verhält sich wie bisher: Schalter bleibt optional, Intervall auf dem alten Pfad', async () => {
    mock = await createMockEos('dvFork', ['feedintariff/direct_marketing_enabled']);
    // Erkennung ins Leere laufen lassen: GET /v1/config beantwortet der Mock,
    // aber wir tun so, als käme Unsinn zurück → über eine leere Konfiguration.
    const ctx = ctxFor(mock.port);
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true, 'ein unbekannter optionaler Schlüssel kippt nichts');
  });

  it('Erkennung läuft höchstens einmal je Abgleich', async () => {
    mock = await createMockEos('upstreamDm');
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
  for (const kind of ['dvFork', 'upstreamDm', 'upstreamGenetic']) {
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
  it('schreibt Geräte als Abbildung nach device_id statt als Liste', async () => {
    mock = await createMockEos('upstreamGenetic');
    const ctx = ctxFor(mock.port);
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true);
    assert.equal(ctx.state.optimizer.eos.flavor, 'upstream-genetic');

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
    assert.equal(ctx.state.optimizer.eos.supports.quarterHour, true);
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
