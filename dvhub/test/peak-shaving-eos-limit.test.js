// test/peak-shaving-eos-limit.test.js — Peak Shaving P2 (Christin 24.11.2026): EOS bekommt die KLEINERE Grenze aus
// Netzanschluss und Peak Shaving — nur, wenn Peak Shaving aktiv ist.
//
// Unser EOS kennt devices.inverters.<id>.max_grid_import_power_w (W). Bisher bekam es nur die Netzanschluss-Grenze
// (Grenze − Abstand). Mit Peak Shaving plant EOS sonst Netzladen über der Bezugsgrenze, die DVhub danach an der
// Ausführung wieder kappt — der Plan stimmt nicht. Vanilla-EOS (ohne den Schlüssel) bekommt den Behelf
// (AC-Ladeleistung = kleinere Grenze − Grundlast − ggf. E-Auto).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createEosConfigSync, buildEosInverters } from '../services/optimizer/eos-config-sync.js';
import { EOS_GRID_IMPORT_OFF_W, eosGridImportLimitW, eosGridChargeCapW } from '../services/grid-connection/index.js';
import { eosPeakShavingTargetW } from '../services/peak-shaving/index.js';
import { createEosThresholdAssist } from '../services/optimizer/eos-threshold-assist.js';

const KEY = 'max_grid_import_power_w';
const LICENSED = { allowGridCharge: true, mispel: { mode: 'pauschal' } };
const PS_ON = { updateChannel: 'dev', manufacturer: 'victron', peakShaving: { enabled: true, gridImportLimitW: 10000, marginW: 300 } };

describe('Wert für EOS (rein)', () => {
  it('eosPeakShavingTargetW: aktiv → Grenze − Abstand; aus, Stable-Kanal oder ohne Grenze → null', () => {
    assert.equal(eosPeakShavingTargetW(PS_ON), 9700);
    assert.equal(eosPeakShavingTargetW({ ...PS_ON, peakShaving: { ...PS_ON.peakShaving, enabled: false } }), null);
    assert.equal(eosPeakShavingTargetW({ ...PS_ON, updateChannel: 'stable' }), null);
    assert.equal(eosPeakShavingTargetW({ ...PS_ON, peakShaving: { enabled: true, gridImportLimitW: null } }), null);
  });

  it('kleinere Grenze gewinnt: Netzanschluss 29 kW (Ziel 28 kW) und Peak Shaving 9,7 kW → 9 700 W', () => {
    assert.equal(eosGridImportLimitW({ gridConnection: { limitKw: 29 } }, { peakShavingTargetW: 9700 }), 9700);
    // Netzanschluss strenger (8 kW, Abstand 1 kW → 7 kW) → 7 000 W
    assert.equal(eosGridImportLimitW({ gridConnection: { limitKw: 8 } }, { peakShavingTargetW: 9700 }), 7000);
    // nur Peak Shaving
    assert.equal(eosGridImportLimitW({}, { peakShavingTargetW: 9700 }), 9700);
    // ohne Peak Shaving unverändert
    assert.equal(eosGridImportLimitW({ gridConnection: { limitKw: 29 } }, { peakShavingTargetW: null }), 28000);
    assert.equal(eosGridImportLimitW({}, {}), EOS_GRID_IMPORT_OFF_W);
  });

  it('Behelf für Vanilla-EOS: kleinere Grenze − Grundlast (− E-Auto, wenn EOS es plant)', () => {
    // Peak Shaving allein: 9 700 − 1 000 Grundlast = 8 700 W
    assert.equal(eosGridChargeCapW({}, { peakShavingTargetW: 9700 }), 8700);
    assert.equal(eosGridChargeCapW({ optimizer: { eosOptimizeEv: true, evMaxChargeW: 11000 } }, { peakShavingTargetW: 9700, evPlanned: true }), 0);
    // mit Netzanschluss 29 kW: kleinere Grenze 9 700 W
    assert.equal(eosGridChargeCapW({ gridConnection: { limitKw: 29 } }, { peakShavingTargetW: 9700 }), 8700);
    // ohne Peak Shaving unverändert
    assert.equal(eosGridChargeCapW({ gridConnection: { limitKw: 29 } }, {}), 27000);
    assert.equal(eosGridChargeCapW({}, {}), null);
  });

  it('buildEosInverters: EOS kennt die Grenze → Feld = kleinere Grenze', () => {
    const cfg = { ...PS_ON, gridConnection: { limitKw: 29 }, optimizer: { ...LICENSED, maxChargeW: 27000 } };
    const inv = buildEosInverters(cfg, { gridImportLimitSupported: true, gridConnectionExtra: { peakShavingTargetW: 9700 } })[0];
    assert.equal(inv[KEY], 9700);
    assert.equal(inv.max_ac_charge_power_w, 27000, 'EOS kürzt selbst');
  });
});

// --- Abgleich gegen eine EOS-Attrappe (wie test/grid-connection-eos-limit.test.js) ---------------------------------

function createMockEos() {
  const config = {
    optimization: { algorithm: 'GENETIC', genetic: { individuals: 300, generations: 400, interval_sec: 900 }, keys: [] },
    feedintariff: { provider: null, direct_marketing_enabled: true },
    devices: {
      batteries: { battery1: { device_id: 'battery1' } },
      inverters: { inverter1: { device_id: 'inverter1', [KEY]: null } },
      electric_vehicles: {}, home_appliances: {}, max_home_appliances: 0,
    },
  };
  const puts = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.method === 'GET' && req.url === '/v1/config') return send(200, config);
        if (req.method === 'GET' && req.url === '/v1/health') return send(200, { status: 'alive', version: '0.4.0rc3' });
        if (req.method === 'PUT') {
          puts.push({ section: req.url.replace('/v1/config/', ''), body });
          return send(200, { ok: true });
        }
        return send(404, {});
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, puts, close: () => new Promise((r) => server.close(r)) }));
  });
}

function ctxFor(port, extra, peakShaving = undefined) {
  return {
    state: { victron: { minSocPct: 5 }, optimizer: {} },
    pushLog: () => {},
    ...(peakShaving ? { peakShaving } : {}),
    getCfg: () => ({
      ...extra,
      optimizer: {
        eosProxy: { enabled: true, url: `http://127.0.0.1:${port}` },
        batteryCapacityWh: 43000, maxChargeW: 27000, roundTripEfficiency: 0.92,
        eosOptimizationIntervalSec: 900, tariff: { feedInMode: 'spot' }, ...LICENSED,
      },
    }),
  };
}

const lastInverterPut = (m) => m.puts.filter((p) => p.section === 'devices/inverters').at(-1)?.body?.inverter1;
let mock;
afterEach(async () => { if (mock) { await mock.close(); mock = null; } });

describe('Abgleich', () => {
  it('Peak Shaving aktiv + Netzanschluss 29 kW: EOS bekommt 9 700 W', async () => {
    mock = await createMockEos();
    const res = await createEosConfigSync(ctxFor(mock.port, { ...PS_ON, gridConnection: { limitKw: 29 } })).sync();
    assert.ok(res.applied.includes('devices/inverters'), JSON.stringify(res.errors));
    assert.equal(lastInverterPut(mock)[KEY], 9700);
  });

  it('Peak Shaving aus: EOS bekommt nur die Netzanschluss-Grenze (28 000 W) wie bisher', async () => {
    mock = await createMockEos();
    await createEosConfigSync(ctxFor(mock.port, { ...PS_ON, updateChannel: 'stable', gridConnection: { limitKw: 29 } })).sync();
    assert.equal(lastInverterPut(mock)[KEY], 28000);
  });

  it('Dienst liefert die wirksame Grenze (z. B. an die Jahresspitze angepasst) → EOS bekommt sie', async () => {
    mock = await createMockEos();
    const svc = { eosTargetW: () => 11700 };
    await createEosConfigSync(ctxFor(mock.port, { ...PS_ON }, svc)).sync();
    assert.equal(lastInverterPut(mock)[KEY], 11700);
  });
});

// --- EOS-Schwelle: Peak Shaving deckt sie schon ab --------------------------------------------------------------

describe('EOS-Schwellen-Peak-Shaving', () => {
  it('Schwelle = Peak-Shaving-Ziel: keine zweite Anforderung (Peak Shaving regelt nach Viertelstunden-Budget)', () => {
    const state = { ctrl: {} };
    const requests = [];
    const assist = {
      request: (q) => { requests.push(q); return { ok: true }; },
      release: () => ({ ok: true }),
      status: () => ({ gridTargetW: null })
    };
    const t = createEosThresholdAssist({
      state, getCfg: () => PS_ON, getAssist: () => assist,
      getPeakShavingTargetW: () => 9700
    });
    const rule = { id: 'r', source: 'forecast_optimizer', optimizer: 'eos', target: 'gridSetpointW', closedLoopHold: true, peakShavingThresholdW: 9700 };
    const info = t.tick(rule);
    assert.equal(requests.length, 0);
    assert.equal(info.coveredBy, 'peak-shaving');
    // Schwelle strenger als Peak Shaving (z. B. EOS mit anderer Grenze): Anforderung wie bisher
    t.tick({ ...rule, peakShavingThresholdW: 8000 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].maxImportW, 8000);
  });
});
