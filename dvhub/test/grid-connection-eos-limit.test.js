// test/grid-connection-eos-limit.test.js — Netzanschluss-Grenze an EOS
// (Christin 06.11.2026): unser EOS bekommt `devices.inverters.<id>.
// max_grid_import_power_w` (W, null = aus). Vanilla v0.4.0rc3 kennt den
// Schlüssel nicht.
//
//   EOS kennt den Schlüssel → DVhub gibt Grenze − Sicherheitsabstand, der
//     Behelf (kleinere AC-Ladeleistung) entfällt, EOS kürzt selbst.
//   EOS kennt ihn nicht → Schlüssel wird nie geschickt, der Behelf bleibt.
//   Grenze entfernt → EOS bekommt EOS_GRID_IMPORT_OFF_W: ein null per PUT
//     setzt den Wert in EOS nicht zurück (ConfigEOS.set_nested_value merkt die
//     Laufzeit-Einstellung mit exclude_none, deep_merge behält den alten Wert).
//
// Erkannt wird am Config-Abgleich (GET /v1/config: Schlüssel am Wechselrichter
// vorhanden, auch als null). Die EOS-Attrappe bildet das nach.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createEosConfigSync, buildEosInverters } from '../services/optimizer/eos-config-sync.js';
import { detectEosCapabilities } from '../services/optimizer/eos-capabilities.js';
import { EOS_GRID_IMPORT_OFF_W, eosGridImportLimitW } from '../services/grid-connection/index.js';

const KEY = 'max_grid_import_power_w';
const LICENSED = { allowGridCharge: true, mispel: { mode: 'pauschal' } };

function eosConfig({ knowsKey, inverters = true }) {
  return {
    optimization: { algorithm: 'GENETIC', genetic: { individuals: 300, generations: 400, interval_sec: 900 }, keys: [] },
    feedintariff: { provider: null, direct_marketing_enabled: true },
    devices: {
      batteries: { battery1: { device_id: 'battery1' } },
      inverters: inverters ? { inverter1: { device_id: 'inverter1', ...(knowsKey ? { [KEY]: null } : {}) } } : {},
      electric_vehicles: {}, home_appliances: {}, max_home_appliances: 0,
    },
  };
}

// EOS-Attrappe: GET /v1/config spiegelt die PUTs. Wie EOS: ein null für den
// Schlüssel setzt ihn nicht zurück; ein EOS ohne den Schlüssel lehnt ihn ab.
function createMockEos({ knowsKey, inverters = true, fail = new Set() }) {
  const config = eosConfig({ knowsKey, inverters });
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
          const section = req.url.replace('/v1/config/', '');
          puts.push({ section, body });
          if (fail.has(section)) return send(500, { detail: 'boom' });
          if (section === 'devices/inverters' && body && typeof body === 'object') {
            for (const [id, inv] of Object.entries(body)) {
              if (!knowsKey && Object.prototype.hasOwnProperty.call(inv, KEY)) return send(422, { detail: `extra field ${KEY}` });
              const cur = config.devices.inverters[id] || (knowsKey ? { [KEY]: null } : {});
              for (const [k, v] of Object.entries(inv)) {
                if (k === KEY && v === null) continue; // null setzt nicht zurück
                cur[k] = v;
              }
              config.devices.inverters[id] = cur;
            }
          }
          return send(200, { ok: true });
        }
        return send(404, {});
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, puts, config, fail,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function ctxFor(port, cfgRef) {
  return {
    state: { victron: { minSocPct: 5 }, optimizer: {} },
    pushLog: () => {},
    getCfg: () => ({
      ...cfgRef.extra,
      optimizer: {
        eosProxy: { enabled: true, url: `http://127.0.0.1:${port}` },
        batteryCapacityWh: 43000, maxChargeW: 27000, roundTripEfficiency: 0.92,
        eosOptimizationIntervalSec: 900, tariff: { feedInMode: 'spot' },
        ...LICENSED, eosOptimizeEv: true, evMaxChargeW: 11000, evPlanOnlyWhenPlugged: false,
      },
    }),
  };
}

const lastInverterPut = (m) => m.puts.filter((p) => p.section === 'devices/inverters').at(-1)?.body?.inverter1;

let mock;
afterEach(async () => { if (mock) { await mock.close(); mock = null; } });

describe('Erkennung und Aufbau', () => {
  it('Erkennung: Schlüssel am Wechselrichter vorhanden (auch null) = EOS kennt die Grenze', () => {
    assert.equal(detectEosCapabilities(eosConfig({ knowsKey: true })).gridImportLimit, true);
    assert.equal(detectEosCapabilities(eosConfig({ knowsKey: false })).gridImportLimit, false);
    assert.equal(detectEosCapabilities(eosConfig({ knowsKey: true, inverters: false })).gridImportLimit, false);
  });

  it('Wert für EOS: Grenze − Abstand; ohne Grenze der Aus-Wert', () => {
    assert.equal(eosGridImportLimitW({ gridConnection: { limitKw: 29 } }), 28000);
    assert.equal(eosGridImportLimitW({}), EOS_GRID_IMPORT_OFF_W);
    assert.ok(EOS_GRID_IMPORT_OFF_W >= 1e9, 'weit über jedem Anschluss');
  });

  it('EOS kennt die Grenze: Feld gesetzt, Behelf aus (volle Ladeleistung)', () => {
    const cfg = { gridConnection: { limitKw: 29 }, optimizer: { ...LICENSED, maxChargeW: 27000, eosOptimizeEv: true, evMaxChargeW: 11000 } };
    const inv = buildEosInverters(cfg, { gridImportLimitSupported: true })[0];
    assert.equal(inv[KEY], 28000);
    assert.equal(inv.max_ac_charge_power_w, 27000);
  });

  it('EOS kennt sie nicht: kein Feld, Behelf bleibt (16 kW)', () => {
    const cfg = { gridConnection: { limitKw: 29 }, optimizer: { ...LICENSED, maxChargeW: 27000, eosOptimizeEv: true, evMaxChargeW: 11000 } };
    const inv = buildEosInverters(cfg)[0];
    assert.equal(Object.prototype.hasOwnProperty.call(inv, KEY), false);
    assert.equal(inv.max_ac_charge_power_w, 16000);
  });
});

describe('Abgleich gegen eine EOS-Attrappe', () => {
  it('EOS mit Schlüssel: Grenze 28 kW ankommen, Ladeleistung ungekürzt', async () => {
    mock = await createMockEos({ knowsKey: true });
    const cfgRef = { extra: { gridConnection: { limitKw: 29 } } };
    const res = await createEosConfigSync(ctxFor(mock.port, cfgRef)).sync();
    assert.ok(res.applied.includes('devices/inverters'), JSON.stringify(res.errors));
    assert.equal(lastInverterPut(mock)[KEY], 28000);
    assert.equal(lastInverterPut(mock).max_ac_charge_power_w, 27000);
    assert.equal(mock.config.devices.inverters.inverter1[KEY], 28000);
  });

  it('Vanilla rc3 ohne Schlüssel: nie geschickt, Behelf 16 kW (Auto bei EOS angemeldet)', async () => {
    mock = await createMockEos({ knowsKey: false });
    const cfgRef = { extra: { gridConnection: { limitKw: 29 } } };
    const ctx = ctxFor(mock.port, cfgRef);
    ctx.teslamateService = { getState: () => ({ batteryLevel: 50 }) }; // Ladestand bekannt → angemeldet
    const res = await createEosConfigSync(ctx).sync();
    assert.ok(res.applied.includes('devices/inverters'), JSON.stringify(res.errors));
    assert.equal(ctx.state.optimizer.eosEv.register, true);
    assert.equal(Object.prototype.hasOwnProperty.call(lastInverterPut(mock), KEY), false);
    assert.equal(lastInverterPut(mock).max_ac_charge_power_w, 16000);
  });

  it('Fable R3 P3-3: Vanilla rc3, Auto NICHT angemeldet → Behelf ohne Abzug der Auto-Ladeleistung (27 kW)', async () => {
    mock = await createMockEos({ knowsKey: false });
    const cfgRef = { extra: { gridConnection: { limitKw: 29 } } };
    const ctx = ctxFor(mock.port, cfgRef);
    const sync = createEosConfigSync(ctx);
    await sync.sync();
    assert.equal(ctx.state.optimizer.eosEv.register, false, 'kein Ladestand → nicht angemeldet');
    // Erst wenn EOS „kein Auto“ quittiert hat, wird die Grenze gelockert (Codex 0190570d, P2).
    assert.equal(lastInverterPut(mock).max_ac_charge_power_w, 16000, 'erster Abgleich vorsichtig');
    await sync.sync();
    assert.equal(lastInverterPut(mock).max_ac_charge_power_w, 27000);
  });

  it('Codex 0190570d P2: Wechselrichter-PUT scheitert → das Auto wird in diesem Abgleich nicht angemeldet', async () => {
    mock = await createMockEos({ knowsKey: false });
    const cfgRef = { extra: { gridConnection: { limitKw: 29 } } };
    const ctx = ctxFor(mock.port, cfgRef);
    const sync = createEosConfigSync(ctx);
    await sync.sync();
    await sync.sync();
    assert.equal(lastInverterPut(mock).max_ac_charge_power_w, 27000, 'ohne Auto gelockert');
    // Auto kommt, aber die engere Grenze kommt nicht an.
    ctx.teslamateService = { getState: () => ({ batteryLevel: 50 }) };
    mock.fail.add('devices/inverters');
    const n = mock.puts.length;
    const res = await sync.sync();
    const sent = mock.puts.slice(n).map((p) => `${p.section}=${JSON.stringify(p.body)}`);
    assert.ok(!sent.includes('devices/max_electric_vehicles=1'), sent.join(' | '));
    assert.equal(res.errors['devices/max_electric_vehicles'], 'inverter_cap_not_applied');
    // Grenze kommt an → Auto wird angemeldet.
    mock.fail.delete('devices/inverters');
    await sync.sync();
    assert.equal(lastInverterPut(mock).max_ac_charge_power_w, 16000);
    assert.ok(mock.puts.some((p) => p.section === 'devices/max_electric_vehicles' && p.body === 1));
  });

  it('Codex 0190570d P2: Abmeldung des Autos nicht quittiert → die engere Grenze bleibt', async () => {
    mock = await createMockEos({ knowsKey: false });
    const cfgRef = { extra: { gridConnection: { limitKw: 29 } } };
    const ctx = ctxFor(mock.port, cfgRef);
    ctx.teslamateService = { getState: () => ({ batteryLevel: 50 }) };
    const sync = createEosConfigSync(ctx);
    await sync.sync();
    assert.equal(lastInverterPut(mock).max_ac_charge_power_w, 16000);
    ctx.teslamateService = { getState: () => ({ batteryLevel: null }) }; // Auto weg
    mock.fail.add('devices/max_electric_vehicles');
    await sync.sync();
    await sync.sync();
    const caps = mock.puts.filter((p) => p.section === 'devices/inverters').map((p) => p.body.inverter1.max_ac_charge_power_w);
    assert.ok(caps.every((w) => w === 16000), `nie gelockert (${caps.join(', ')})`);
  });

  it('Grenze in DVhub entfernt: EOS bekommt den Aus-Wert, nicht null (null setzt nicht zurück)', async () => {
    mock = await createMockEos({ knowsKey: true });
    const cfgRef = { extra: { gridConnection: { limitKw: 29 } } };
    const sync = createEosConfigSync(ctxFor(mock.port, cfgRef));
    await sync.sync();
    assert.equal(mock.config.devices.inverters.inverter1[KEY], 28000);
    cfgRef.extra = { gridConnection: { limitKw: null } };
    await sync.sync();
    assert.equal(lastInverterPut(mock)[KEY], EOS_GRID_IMPORT_OFF_W);
    assert.equal(mock.config.devices.inverters.inverter1[KEY], EOS_GRID_IMPORT_OFF_W, 'in EOS wirklich aus');
    assert.equal(lastInverterPut(mock).max_ac_charge_power_w, 27000);
  });

  it('frisches EOS ohne Wechselrichter: nach dem ersten PUT erkannt und Grenze gleich nachgeschickt', async () => {
    mock = await createMockEos({ knowsKey: true, inverters: false });
    const cfgRef = { extra: { gridConnection: { limitKw: 29 } } };
    await createEosConfigSync(ctxFor(mock.port, cfgRef)).sync();
    assert.equal(mock.config.devices.inverters.inverter1[KEY], 28000);
    assert.equal(lastInverterPut(mock).max_ac_charge_power_w, 27000, 'Behelf nach der Erkennung wieder aus');
  });
});

describe('Gesamtprüfung 7', () => {
  it('ohne maxChargeW und ohne Grenze: AC-Ladeleistung als Zahl, nicht null (null setzt in EOS nicht zurück)', () => {
    const inv = buildEosInverters({ optimizer: { ...LICENSED } }, { gridImportLimitSupported: true })[0];
    assert.equal(typeof inv.max_ac_charge_power_w, 'number');
    assert.ok(inv.max_ac_charge_power_w > 0);
    const inv2 = buildEosInverters({ optimizer: { ...LICENSED } })[0];
    assert.equal(typeof inv2.max_ac_charge_power_w, 'number');
  });
});

describe('Abschluss-Gesamtrunde 2', () => {
  it('anderes Hersteller-Profil: eine gemerkte Victron-Grenze erreicht EOS nicht (Codex, P2)', async () => {
    mock = await createMockEos({ knowsKey: true });
    const cfgRef = { extra: { manufacturer: 'fronius', gridConnection: { limitKw: 29 } } };
    const ctx = ctxFor(mock.port, cfgRef);
    ctx.state.victron = { minSocPct: 5, acInputLimitA: 30, fieldUpdatedAt: { acInputLimitA: Date.now() }, errors: {} };
    await createEosConfigSync(ctx).sync();
    assert.equal(lastInverterPut(mock)[KEY], 28000, 'nur die DVhub-Grenze, nicht 30 A');
  });
});
