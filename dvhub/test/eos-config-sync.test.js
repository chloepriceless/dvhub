// test/eos-config-sync.test.js — Phase 22 (2026-05-24).
//
// Verifies the DVhub→EOS config-builder functions for grid-arbitrage gating,
// dynamic-pricing pass-through, and slot-resolution selection. These three
// concerns are the new surface area that Phase 22 added on top of the
// hardware-spec sync introduced in Phase 21.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import http from 'node:http';

import {
  buildEosBatteries,
  buildEosInverters,
  buildEosElecprice,
  buildEosOptimization,
  buildEosElectricVehicles,
  pickGeneticSizing,
  pickEmsIntervalSec,
  createEosConfigSync,
} from '../services/optimizer/eos-config-sync.js';

// Minimal mock EOS server — captures {method, url} per request, 200-OKs all.
// `failUrls` simuliert ein EOS, das einen Konfigschluessel NICHT kennt — genau
// die Lage unseres aktuellen Forks (Basis 17.03.) gegenueber
// feedintariff/direct_marketing_enabled.
function createMockEos(failUrls = []) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let body;
        try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
        requests.push({ method: req.method, url: req.url, body });
        if (failUrls.includes(req.url)) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'unknown config key' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const STD_CFG = {
  optimizer: {
    batteryCapacityWh: 43000,
    maxChargeW: 18000,
    roundTripEfficiency: 0.92,
    minSocPct: 5,
    maxSocPct: 100,
  },
};

test('buildEosBatteries: charge_rates = [1.0] when allowGridCharge=false (default)', () => {
  const bat = buildEosBatteries(STD_CFG)[0];
  assert.deepEqual(bat.charge_rates, [1.0]);
  assert.equal(bat.capacity_wh, 43000);
  assert.equal(bat.max_charge_power_w, 18000);
});

test('buildEosBatteries: charge_rates = [1.0] when allowGridCharge=true but no MisPel', () => {
  const cfg = { ...STD_CFG, optimizer: { ...STD_CFG.optimizer, allowGridCharge: true } };
  const bat = buildEosBatteries(cfg)[0];
  // Without MisPel pauschal/abgrenzung, grid arbitrage is §14a-illegal — gate blocks.
  assert.deepEqual(bat.charge_rates, [1.0]);
});

test('buildEosBatteries: full 11-step charge_rates when allowGridCharge=true AND mispel.mode=pauschal', () => {
  const cfg = {
    ...STD_CFG,
    optimizer: {
      ...STD_CFG.optimizer,
      allowGridCharge: true,
      mispel: { mode: 'pauschal' },
    },
  };
  const bat = buildEosBatteries(cfg)[0];
  assert.equal(bat.charge_rates.length, 11);
  assert.deepEqual(bat.charge_rates, [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
});

test('buildEosBatteries: full charge_rates also for mispel.mode=abgrenzung', () => {
  const cfg = {
    ...STD_CFG,
    optimizer: {
      ...STD_CFG.optimizer,
      allowGridCharge: true,
      mispel: { mode: 'abgrenzung' },
    },
  };
  const bat = buildEosBatteries(cfg)[0];
  assert.equal(bat.charge_rates.length, 11);
});

test('buildEosElecprice: null when pricing.mode is not "dynamic"', () => {
  assert.equal(buildEosElecprice({}), null);
  assert.equal(buildEosElecprice({ userEnergyPricing: { mode: 'fixed' } }), null);
});

test('buildEosElecprice: null when dynamic but all components are 0/missing', () => {
  const cfg = { userEnergyPricing: { mode: 'dynamic', dynamicComponents: {} } };
  assert.equal(buildEosElecprice(cfg), null);
});

test('buildEosElecprice: sums energy markup + grid charges + levies into charges_kwh (€/kWh)', () => {
  const cfg = {
    userEnergyPricing: {
      mode: 'dynamic',
      dynamicComponents: {
        energyMarkupCtKwh: 2.5,
        gridChargesCtKwh: 8.2,
        leviesAndFeesCtKwh: 4.3,
        vatPct: 19,
      },
    },
  };
  const result = buildEosElecprice(cfg);
  // (2.5 + 8.2 + 4.3) ct = 15.0 ct → 0.15 €/kWh
  assert.equal(result.charges_kwh, 0.15);
  assert.equal(result.vat_rate, 1.19);
});

test('buildEosElecprice: defaults vat_rate to 1.19 when vatPct is missing', () => {
  const cfg = {
    userEnergyPricing: {
      mode: 'dynamic',
      dynamicComponents: { gridChargesCtKwh: 10 },
    },
  };
  assert.equal(buildEosElecprice(cfg).vat_rate, 1.19);
});

test('buildEosOptimization: defaults to interval=3600 when unset', () => {
  assert.deepEqual(buildEosOptimization({}), { interval: 3600 });
});

test('buildEosOptimization: accepts 900 / 1800 / 3600 as valid intervals', () => {
  for (const i of [900, 1800, 3600]) {
    const cfg = { optimizer: { eosOptimizationIntervalSec: i } };
    assert.equal(buildEosOptimization(cfg).interval, i, `interval ${i} should pass through`);
  }
});

test('buildEosOptimization: rejects invalid intervals and falls back to 3600', () => {
  for (const bad of [60, 300, 7200, null, 'fifteen']) {
    const cfg = { optimizer: { eosOptimizationIntervalSec: bad } };
    assert.equal(buildEosOptimization(cfg).interval, 3600, `interval ${bad} should clamp to 3600`);
  }
});

test('buildEosInverters: max_ac_charge_power_w HARD-DISABLED to 0 when grid-arbitrage NOT licensed (§14a)', () => {
  // T-0080: STD_CFG carries maxChargeW=18000 but no allowGridCharge/mispel, so AC
  // grid→battery charging is §14a-illegal for a vanilla self-consumption operator.
  // buildEosInverters must report 0 (a886317 hard-disable) so EOS' genetic can
  // never pencil in a grid→battery transfer. This was a FALSE-NEGATIVE: the old
  // assertion expected 18000, so a regression that re-enabled illegal grid-charge
  // (dropping the gridChargeAllowed gate) would have passed unnoticed.
  const inv = buildEosInverters(STD_CFG)[0];
  assert.equal(inv.max_ac_charge_power_w, 0);
  assert.equal(inv.battery_id, 'battery1');
});

test('buildEosInverters: max_ac_charge_power_w = maxChargeW when grid-arbitrage IS licensed', () => {
  // Positive case: explicit allowGridCharge + a MisPel mode = the operator is
  // licensed for grid arbitrage → the 18000 W AC-charge cap passes through.
  const cfg = { optimizer: { ...STD_CFG.optimizer, allowGridCharge: true, mispel: { mode: 'pauschal' } } };
  assert.equal(buildEosInverters(cfg)[0].max_ac_charge_power_w, 18000);
});

test('buildEosInverters: max_power_w = inverterMaxPowerW (AC grid-connection cap) when set', () => {
  const cfg = { optimizer: { ...STD_CFG.optimizer, inverterMaxPowerW: 29000, mispel: { pvKwp: 29.7 } } };
  assert.equal(buildEosInverters(cfg)[0].max_power_w, 29000);
});

test('buildEosInverters: max_power_w falls back to pvKwp×1000 when inverterMaxPowerW unset', () => {
  const cfg = { optimizer: { ...STD_CFG.optimizer, mispel: { pvKwp: 29.7 } } };
  assert.equal(buildEosInverters(cfg)[0].max_power_w, 29700);
});

test('buildEosBatteries: max_charge_power_w prefers maxDischargeW (AC discharge cap) over maxChargeW', () => {
  const cfg = { optimizer: { ...STD_CFG.optimizer, maxChargeW: 18000, maxDischargeW: 16000 } };
  // EOS uses one power cap for both directions; the battery→grid export must
  // honour the AC discharge limit, so maxDischargeW wins.
  assert.equal(buildEosBatteries(cfg)[0].max_charge_power_w, 16000);
});

test('pickGeneticSizing: full upstream sizing at all resolutions', () => {
  // Operator preference: full-quality plan + slower EMS-tick beats a degraded
  // plan with a faster tick at sub-hourly slot resolutions. ems.interval
  // scales out so the genetic loop never overlaps with the next tick.
  assert.deepEqual(pickGeneticSizing(3600), { generations: 400, individuals: 300 });
  assert.deepEqual(pickGeneticSizing(1800), { generations: 400, individuals: 300 });
  assert.deepEqual(pickGeneticSizing(900),  { generations: 400, individuals: 300 });
  assert.deepEqual(pickGeneticSizing(7200), { generations: 400, individuals: 300 });
});

test('pickEmsIntervalSec: stretches at finer slot resolutions', () => {
  // hourly: stay at EOS upstream default 300s
  assert.equal(pickEmsIntervalSec(3600), 300);
  // 30-min: 1800s tick
  assert.equal(pickEmsIntervalSec(1800), 1800);
  // 15-min: stretch to 3600s — one high-quality run per hour
  assert.equal(pickEmsIntervalSec(900), 3600);
  // unknown interval: hourly default
  assert.equal(pickEmsIntervalSec(7200), 300);
});

test('pickEmsIntervalSec: operator override decouples ems tick from slot resolution', () => {
  // 15-min slots BUT operator wants a 30-min re-plan tick → override wins, slots untouched
  assert.equal(pickEmsIntervalSec(900, 1800), 1800);
  // override applies regardless of slot resolution
  assert.equal(pickEmsIntervalSec(3600, 1800), 1800);
  assert.equal(pickEmsIntervalSec(900, 900), 900);
  // clamped to [300, 7200]
  assert.equal(pickEmsIntervalSec(900, 60), 300);
  assert.equal(pickEmsIntervalSec(900, 99999), 7200);
  // 0 / non-finite / negative → fall back to the auto value
  assert.equal(pickEmsIntervalSec(900, 0), 3600);
  assert.equal(pickEmsIntervalSec(900, undefined), 3600);
  assert.equal(pickEmsIntervalSec(900, NaN), 3600);
  assert.equal(pickEmsIntervalSec(900, -5), 3600);
});

test('buildEosElectricVehicles returns one ev11 with config overrides', () => {
  const def = buildEosElectricVehicles({});
  assert.equal(def.length, 1);
  assert.equal(def[0].device_id, 'ev11');
  assert.equal(def[0].capacity_wh, 50000);
  assert.equal(def[0].min_soc_percentage, 70);
  assert.equal(def[0].charge_rates.length, 11);

  const over = buildEosElectricVehicles({ optimizer: { evCapacityWh: 75000, evMaxChargeW: 11000, evMinSocPct: 50 } });
  assert.equal(over[0].capacity_wh, 75000);
  assert.equal(over[0].max_charge_power_w, 11000);
  assert.equal(over[0].min_soc_percentage, 50);
});

// --- Phantom-Spülmaschine (2026-07-29): EOS must be told there are no home
// appliances, otherwise it invents "dishwasher1" (2000 Wh / 3 h) and adds that
// phantom load on top of the LoadImport forecast. See the block comment in
// eos-config-sync.js and geneticparams.py:576-605 / :614.
test('sync(): disables home appliances so EOS cannot invent a phantom dishwasher', async () => {
  const mock = await createMockEos();
  try {
    const ctx = {
      getCfg: () => ({
        ...STD_CFG,
        optimizer: {
          ...STD_CFG.optimizer,
          eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` },
        },
      }),
      pushLog: () => {},
      state: {},
    };
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true, `sync failed: ${JSON.stringify(res.errors)}`);

    const maxPut = mock.requests.find(
      (r) => r.method === 'PUT' && r.url === '/v1/config/devices/max_home_appliances',
    );
    const listPut = mock.requests.find(
      (r) => r.method === 'PUT' && r.url === '/v1/config/devices/home_appliances',
    );

    assert.ok(maxPut, 'devices/max_home_appliances must be synced, never left unset');
    assert.equal(maxPut.body, 0, 'max_home_appliances must be 0 (geneticparams.py:579)');

    // Die leere Geräteliste darf NICHT mitgeschickt werden (07.08.2026): bei 0
    // liest EOS sie nie, und die Sende-Schleife bricht bei einem Fehler nicht
    // ab — scheitert der 0-PUT und gelingt der Listen-PUT, erzeugt der nackte
    // `except:` in geneticparams.py:614 die Demo-Spülmaschine neu.
    assert.equal(
      listPut, undefined,
      'devices/home_appliances darf nicht gesendet werden — die 0 allein trägt',
    );
  } finally {
    await mock.close();
  }
});

// --- persist() (2026-06-28): snapshot synced config so it survives EOS restart ---
test('persist(): PUTs /v1/config/file when eosProxy enabled', async () => {
  const mock = await createMockEos();
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      state: {},
    };
    const res = await createEosConfigSync(ctx).persist();
    assert.equal(res.ok, true);
    const persistPuts = mock.requests.filter((r) => r.method === 'PUT' && r.url === '/v1/config/file');
    assert.equal(persistPuts.length, 1, 'exactly one config-file persist PUT');
  } finally {
    await mock.close();
  }
});

test('persist(): no-op (no HTTP) when eosProxy disabled', async () => {
  const mock = await createMockEos();
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: false, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      state: {},
    };
    const res = await createEosConfigSync(ctx).persist();
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'eosProxy.enabled=false');
    assert.equal(mock.requests.length, 0, 'no HTTP when disabled');
  } finally {
    await mock.close();
  }
});

// Direktvermarktungs-Generalschalter (Christin 2026-08-07).
//
// Upstream-EOS leitet aus `feedintariff.direct_marketing_enabled` DREI Dinge ab
// (`genetic.py:2670-2677` + `:504`): DC-Charge-Optimierung, Battery-to-Grid-
// Export und die harte PV-Abregelung bei Negativpreis. Default ist FALSE.
// Ohne diesen PUT würde ein Umstieg auf upstream alle drei still abschalten —
// die Abregelung ist §51-Pflicht, keine Optimierung.
test('sync(): pusht den Direktvermarktungs-Schalter im Spot-Modus', async () => {
  const mock = await createMockEos();
  try {
    const ctx = {
      getCfg: () => ({
        ...STD_CFG,
        optimizer: {
          ...STD_CFG.optimizer,
          tariff: { feedInMode: 'spot' },
          eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` },
        },
      }),
      pushLog: () => {},
      state: {},
    };
    const res = await createEosConfigSync(ctx).sync();
    const put = mock.requests.find(
      (r) => r.method === 'PUT' && r.url === '/v1/config/feedintariff/direct_marketing_enabled',
    );
    assert.ok(put, 'direct_marketing_enabled muss gesendet werden');
    assert.equal(put.body, true);
    assert.ok(
      res.appliedOptional.includes('feedintariff/direct_marketing_enabled'),
      'erfolgreicher optionaler Task muss in appliedOptional stehen',
    );
  } finally {
    await mock.close();
  }
});

test('sync(): sendet false, wenn nicht im Spot-Modus', async () => {
  const mock = await createMockEos();
  try {
    const ctx = {
      getCfg: () => ({
        ...STD_CFG,
        optimizer: {
          ...STD_CFG.optimizer,
          tariff: { feedInMode: 'fixed' },
          eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` },
        },
      }),
      pushLog: () => {},
      state: {},
    };
    await createEosConfigSync(ctx).sync();
    const put = mock.requests.find(
      (r) => r.method === 'PUT' && r.url === '/v1/config/feedintariff/direct_marketing_enabled',
    );
    assert.ok(put, 'der Schalter wird auch im Fixed-Modus gesetzt, dann auf false');
    assert.equal(put.body, false);
  } finally {
    await mock.close();
  }
});

test('sync(): ein alter EOS-Fork ohne den Schluessel kippt den Gesamtstatus NICHT', async () => {
  // Der Kern des optionalen Tasks. Waere er Pflicht, stuende okAll auf unserem
  // heutigen Fork dauerhaft auf false — ein Signal, das immer rot ist, erzieht
  // zum Wegsehen. Der Fehlschlag muss sichtbar sein, ohne alles rot zu faerben.
  const mock = await createMockEos(['/v1/config/feedintariff/direct_marketing_enabled']);
  try {
    const ctx = {
      getCfg: () => ({
        ...STD_CFG,
        optimizer: {
          ...STD_CFG.optimizer,
          tariff: { feedInMode: 'spot' },
          eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` },
        },
      }),
      pushLog: () => {},
      state: {},
    };
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true, 'Pflicht-Tasks sind durch → ok bleibt true');
    assert.deepEqual(res.appliedOptional, []);
    assert.ok(
      res.errorsOptional['feedintariff/direct_marketing_enabled'],
      'der Fehlschlag muss sichtbar protokolliert sein, nicht verschluckt',
    );
  } finally {
    await mock.close();
  }
});
