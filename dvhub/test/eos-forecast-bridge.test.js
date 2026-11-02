// test/eos-forecast-bridge.test.js — Phase 22.1 (2026-05-24).
//
// Pure-function tests for the DVhub→EOS forecast bridge helpers. The HTTP
// push and timer/start orchestration are integration-level concerns covered
// by the live deploy path; here we lock the data-shape contract that EOS'
// PydanticDateTimeDataFrame import expects.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import http from 'node:http';

import {
  slotsToTimeMap,
  expandHourlyToQuarterHourly,
  priceSlotsToEosFormat,
  buildDataFrameBody,
  createEosForecastBridge,
  SOC_KEY_RE,
  EV_SOC_KEY_RE,
  computeControlHorizonHours,
} from '../services/optimizer/eos-forecast-bridge.js';

/**
 * Minimal mock EOS server. Captures { method, url } per request and lets the
 * handler reply. Body is parsed as JSON only when present (the SoC measurement
 * PUT carries everything on the query string with no body).
 */
// Bis zu `ms` warten, bis cond() stimmt — statt fester Wartezeiten, die unter
// Last (volle Suite neben anderer Arbeit) zu knapp waren (2026-10-15).
async function waitUntil(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
}

function createMockEos(handler) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        if (body) { try { parsed = JSON.parse(body); } catch { parsed = body; } }
        requests.push({ method: req.method, url: req.url, body: parsed });
        handler(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// A handler that 200-OKs every EOS endpoint the bridge touches.
function okHandler(req, res) {
  if (req.method === 'GET' && req.url.startsWith('/v1/measurement/keys')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      'battery1-soc-factor',
      'battery1-power-l1-w',
      'ev11-soc-factor',
      'date_time',
    ]));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function forecastSlots() {
  return {
    pv: { slots: [{ start: '2026-05-24T12:00:00.000Z', powerW: 1000 }] },
    load: { slots: [{ start: '2026-05-24T12:00:00.000Z', powerW: 500 }] },
    price: { slots: [{ start: '2026-05-24T12:00:00.000Z', ctKwh: 20 }] },
  };
}

test('slotsToTimeMap: ISO key + W value, skips null/NaN', () => {
  const slots = [
    { start: '2026-05-24T12:00:00.000Z', powerW: 1000 },
    { start: '2026-05-24T12:15:00.000Z', powerW: 1500 },
    { start: '2026-05-24T12:30:00.000Z', powerW: null },
    { start: '2026-05-24T12:45:00.000Z', powerW: NaN },
    { start: null, powerW: 2000 },
    { start: '2026-05-24T13:00:00.000Z', powerW: 2500 },
  ];
  const out = slotsToTimeMap(slots);
  assert.deepEqual(Object.keys(out), [
    '2026-05-24T12:00:00Z',
    '2026-05-24T12:15:00Z',
    '2026-05-24T13:00:00Z',
  ]);
  assert.equal(out['2026-05-24T12:15:00Z'], 1500);
});

test('expandHourlyToQuarterHourly: every hour becomes 4 step-fn slots', () => {
  const hourly = [
    { start: '2026-05-24T12:00:00.000Z', powerW: 800 },
    { start: '2026-05-24T13:00:00.000Z', powerW: 1200 },
  ];
  const quarter = expandHourlyToQuarterHourly(hourly);
  assert.equal(quarter.length, 8);
  assert.equal(quarter[0].start, '2026-05-24T12:00:00.000Z');
  assert.equal(quarter[1].start, '2026-05-24T12:15:00.000Z');
  assert.equal(quarter[2].start, '2026-05-24T12:30:00.000Z');
  assert.equal(quarter[3].start, '2026-05-24T12:45:00.000Z');
  assert.equal(quarter[4].start, '2026-05-24T13:00:00.000Z');
  // All quarter-hour rows for the same source-hour carry the same power
  assert.equal(quarter[0].powerW, 800);
  assert.equal(quarter[3].powerW, 800);
  assert.equal(quarter[4].powerW, 1200);
});

test('expandHourlyToQuarterHourly: empty/invalid input → empty output', () => {
  assert.deepEqual(expandHourlyToQuarterHourly([]), []);
  assert.deepEqual(expandHourlyToQuarterHourly([{ start: null }]), []);
});

test('priceSlotsToEosFormat: ct/kWh → EUR/Wh conversion', () => {
  const slots = [
    { start: '2026-05-24T12:00:00.000Z', ctKwh: 25.4 },   // 25.4 ct/kWh
    { start: '2026-05-24T12:15:00.000Z', ctKwh: 0 },      // free slot
    { start: '2026-05-24T12:30:00.000Z', ctKwh: -5.1 },   // negative (paid to consume)
    { start: '2026-05-24T12:45:00.000Z', ctKwh: 'bad' },  // bad value skipped
  ];
  const out = priceSlotsToEosFormat(slots);
  assert.equal(out.length, 3);
  // 25.4 ct/kWh = 0.254 €/kWh = 0.000254 €/Wh
  assert.equal(out[0].powerW.toFixed(8), '0.00025400');
  assert.equal(out[1].powerW, 0);
  assert.equal(out[2].powerW.toFixed(8), '-0.00005100');
});

test('buildDataFrameBody: PydanticDateTimeDataFrame contract (datetime-first)', () => {
  const slots = [
    { start: '2026-05-24T12:00:00.000Z', powerW: 1000 },
    { start: '2026-05-24T12:15:00.000Z', powerW: 1500 },
  ];
  const body = buildDataFrameBody('pvforecast_ac_power', slots, 'Europe/Berlin');
  assert.equal(typeof body.data, 'object');
  // Outer keys are datetimes (NOT columns) — see schema in core/pydantic.py
  assert.deepEqual(
    Object.keys(body.data).sort(),
    ['2026-05-24T12:00:00Z', '2026-05-24T12:15:00Z'],
  );
  // Inner is {column: value}
  assert.deepEqual(body.data['2026-05-24T12:00:00Z'], { pvforecast_ac_power: 1000 });
  assert.deepEqual(body.data['2026-05-24T12:15:00Z'], { pvforecast_ac_power: 1500 });
  assert.equal(body.dtypes.pvforecast_ac_power, 'float64');
  assert.equal(body.tz, 'Europe/Berlin');
  assert.deepEqual(body.datetime_columns, []);
});

test('createEosForecastBridge.push: skips when eosProxy.enabled=false', async () => {
  const calls = [];
  const ctx = {
    getCfg: () => ({ optimizer: { eosProxy: { enabled: false } } }),
    pushLog: (kind, payload) => calls.push({ kind, payload }),
    forecastService: { buildForecastResponse: async () => ({ pv: { slots: [] } }) },
  };
  const bridge = createEosForecastBridge(ctx);
  const res = await bridge.push();
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 'eosProxy.enabled=false');
});

test('createEosForecastBridge.push: fails gracefully when forecastService missing', async () => {
  const calls = [];
  const ctx = {
    getCfg: () => ({}),
    pushLog: (kind, payload) => calls.push({ kind, payload }),
    // no forecastService
  };
  const bridge = createEosForecastBridge(ctx);
  const res = await bridge.push();
  assert.equal(res.ok, false);
  assert.ok(res.errors.bootstrap);
});

test('createEosForecastBridge.push: handles forecast-build exception', async () => {
  const calls = [];
  const ctx = {
    getCfg: () => ({}),
    pushLog: (kind, payload) => calls.push({ kind, payload }),
    forecastService: { buildForecastResponse: async () => { throw new Error('VRM down'); } },
  };
  const bridge = createEosForecastBridge(ctx);
  const res = await bridge.push();
  assert.equal(res.ok, false);
  assert.ok(res.errors.build);
  assert.match(res.errors.build, /VRM down/);
});

test('SoC key classification: battery vs EV', () => {
  assert.ok(SOC_KEY_RE.test('battery1-soc-factor'));
  assert.ok(SOC_KEY_RE.test('ev11-soc-factor'));
  assert.ok(!SOC_KEY_RE.test('battery1-power-l1-w'));
  // EV keys match the EV regex; battery keys must NOT (else real SoC leaks to EV)
  assert.ok(EV_SOC_KEY_RE.test('ev11-soc-factor'));
  assert.ok(EV_SOC_KEY_RE.test('ev1-soc-factor'));
  assert.ok(!EV_SOC_KEY_RE.test('battery1-soc-factor'));
});

test('push forwards live battery SoC as factor; skips EV when absent', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosStartAfterPreviousRun: true, eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: { soc: 16 } }, // 16% → factor 0.16, no EV SoC
    };
    const bridge = createEosForecastBridge(ctx);
    const res = await bridge.push();

    const socPuts = mock.requests.filter(
      (r) => r.method === 'PUT' && r.url.startsWith('/v1/measurement/value'),
    );
    // Battery gepusht, EV uebersprungen (kein evSocPct) — ein Stempel 'jetzt'
    // (EOS 0.4 bricht ab, wenn der Wert aelter als 300 s ist).
    assert.equal(socPuts.length, 1, 'nur der „jetzt“-Stempel (EOS 0.4)');
    for (const put of socPuts) {
      assert.match(put.url, /key=battery1-soc-factor/);
      assert.match(put.url, /value=0\.16(&|$)/);
    }
    const stamps = socPuts.map((r) => decodeURIComponent(r.url).match(/datetime=([^&]+)/)[1]);
    assert.ok(
      stamps.some((d) => !/T\d\d:00:00Z$/.test(d) && Math.abs(Date.now() - Date.parse(d)) < 60_000),
      'ein Stempel auf jetzt',
    );
    assert.equal(res.pushed.filter((p) => p.startsWith('battery1-soc-factor=0.16')).length, 1);
  } finally {
    await mock.close();
  }
});

test('push forwards EV SoC when state provides evSocPct', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosStartAfterPreviousRun: true, eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: { soc: 50, evSocPct: 80 } },
    };
    const bridge = createEosForecastBridge(ctx);
    await bridge.push();

    const socPuts = mock.requests.filter(
      (r) => r.method === 'PUT' && r.url.startsWith('/v1/measurement/value'),
    );
    // zwei Kanaele x zwei Stempel
    assert.equal(socPuts.length, 2);
    assert.equal(socPuts.filter((r) => /key=battery1-soc-factor/.test(r.url) && /value=0\.5(&|$)/.test(r.url)).length, 1);
    assert.equal(socPuts.filter((r) => /key=ev11-soc-factor/.test(r.url) && /value=0\.8(&|$)/.test(r.url)).length, 1);
  } finally {
    await mock.close();
  }
});

// prod 2026-09-23: state.victron.evSocPct setzte nie jemand — der EV-SoC kam
// nie bei EOS an, und 0.4 brach deshalb jeden Lauf ab. Quelle ist jetzt
// TeslaMate (bzw. evcc).
test('push holt den EV-SoC aus TeslaMate', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosStartAfterPreviousRun: true, eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: { soc: 50 } },
      teslamateService: { getState: () => ({ batteryLevel: 63 }) },
    };
    await createEosForecastBridge(ctx).push();
    const evPuts = mock.requests.filter(
      (r) => r.method === 'PUT' && /key=ev11-soc-factor/.test(r.url) && /value=0\.63(&|$)/.test(r.url),
    );
    assert.equal(evPuts.length, 1, 'EV-SoC mit dem „jetzt“-Stempel');
  } finally {
    await mock.close();
  }
});

test('push skips SoC cleanly when no live battery SoC in state', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: {} }, // no soc
    };
    const bridge = createEosForecastBridge(ctx);
    await bridge.push();

    const socPuts = mock.requests.filter(
      (r) => r.method === 'PUT' && r.url.startsWith('/v1/measurement/value'),
    );
    assert.equal(socPuts.length, 0);
    // measurement/keys should not even be queried when there's no SoC to push
    const keyGets = mock.requests.filter((r) => r.url.startsWith('/v1/measurement/keys'));
    assert.equal(keyGets.length, 0);
  } finally {
    await mock.close();
  }
});

test('push sends FeedInTariffImport (spot price × factor) only in spot mode', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }, tariff: { feedInMode: 'spot', feedInSpotFactor: 1 } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => ({
        pv: { slots: [{ start: '2026-05-24T12:00:00.000Z', powerW: 1000 }] },
        load: { slots: [{ start: '2026-05-24T12:00:00.000Z', powerW: 500 }] },
        price: { slots: [{ start: '2026-05-24T12:00:00.000Z', ctKwh: 30 }, { start: '2026-05-24T12:15:00.000Z', ctKwh: -5 }] },
      }) },
      state: { victron: { soc: 50 } },
    };
    const bridge = createEosForecastBridge(ctx);
    await bridge.push();
    const feedReq = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/prediction/import/FeedInTariffImport'));
    assert.ok(feedReq, 'FeedInTariffImport pushed in spot mode');
  } finally {
    await mock.close();
  }
});

test('push: Nur Netzspeicher → PV als Nullen, Verbrauch = Ruhebedarf, auch ohne jede Prognose', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const price = Array.from({ length: 8 }, (_, i) => ({ start: new Date(hour + i * 900_000).toISOString(), ctKwh: 10 + i }));
    const ctx = {
      getCfg: () => ({ optimizer: {
        eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` },
        tariff: { feedInMode: 'spot', feedInSpotFactor: 1 },
        gridStorageOnly: true, gridStorageStandbyW: 150,
      } }),
      pushLog: () => {},
      // Keine PV-Prognose, und eine Hausprognose, die nicht gelten darf.
      forecastService: { buildForecastResponse: async () => ({ pv: { slots: [] }, load: { slots: [{ start: new Date(hour).toISOString(), powerW: 900 }] }, price: { slots: price } }) },
      state: { victron: { soc: 50 } },
    };
    const bridge = createEosForecastBridge(ctx);
    await bridge.push();
    const bodyOf = (provider) => {
      const req = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith(`/v1/prediction/import/${provider}`));
      assert.ok(req, `${provider} gesendet`);
      return Object.values(req.body.data).map((row) => Object.values(row)[0]);
    };
    const pv = bodyOf('PVForecastImport');
    assert.equal(pv.length, 16, '2 h vor jetzt + 2 h Preise, je Viertelstunde');
    assert.equal(pv.every((v) => v === 0), true);
    const load = bodyOf('LoadImport');
    assert.equal(load.every((v) => v === 150), true);
    assert.deepEqual(ctx.state.optimizer.gridStorage, { standbyW: 150, standbySource: 'config', samples: 0 });
  } finally {
    await mock.close();
  }
});

test('push: every forecast import carries force_enable=true (lands before provider flip)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }, tariff: { feedInMode: 'spot', feedInSpotFactor: 1 } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => ({
        pv: { slots: [{ start: '2026-05-24T12:00:00.000Z', powerW: 1000 }] },
        load: { slots: [{ start: '2026-05-24T12:00:00.000Z', powerW: 500 }] },
        price: { slots: [{ start: '2026-05-24T12:00:00.000Z', ctKwh: 30 }] },
      }) },
      state: { victron: { soc: 50 } },
    };
    await createEosForecastBridge(ctx).push();
    const imports = mock.requests.filter(
      (r) => r.method === 'PUT' && r.url.startsWith('/v1/prediction/import/'),
    );
    assert.ok(imports.length >= 3, 'at least PV/Load/ElecPrice imported');
    for (const r of imports) {
      assert.match(r.url, /[?&]force_enable=true(&|$)/, `${r.url} must carry force_enable=true`);
    }
  } finally {
    await mock.close();
  }
});

test('start({beforePush}): beforePush runs BEFORE each push (config re-asserted ahead of import)', async () => {
  const order = [];
  const ctx = {
    getCfg: () => ({ optimizer: { eosProxy: { enabled: false } } }),
    pushLog: () => {},
    // push() short-circuits on eosProxy.enabled=false but still records order.
    forecastService: { buildForecastResponse: async () => { order.push('push'); return {}; } },
    state: {},
  };
  const bridge = createEosForecastBridge(ctx);
  bridge.start({
    fireImmediately: true,
    intervalMs: 100000,
    beforePush: async () => { order.push('before'); },
  });
  await new Promise((r) => setTimeout(r, 30));
  bridge.stop();
  // beforePush must precede the push on the same tick. (push() returns early on
  // disabled proxy so 'push' may be absent, but 'before' must be first.)
  assert.equal(order[0], 'before', 'beforePush runs before push');
});

test('push sends the FIXED feed-in tariff in fixed mode (EOS 0.4 cancels runs without one)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }, tariff: { feedInMode: 'fixed', feedInCtKwh: 8.1 } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: { soc: 50 } },
    };
    const bridge = createEosForecastBridge(ctx);
    await bridge.push();
    const feedReq = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/prediction/import/FeedInTariffImport'));
    assert.ok(feedReq, 'FeedInTariffImport also in fixed mode');
    const values = Object.values(feedReq.body.data).map((row) => row.feed_in_tariff_wh);
    assert.ok(values.length > 0);
    for (const v of values) assert.ok(v === 0 || Math.abs(v - 8.1 / 100 / 1000) < 1e-12, `fixed 8.1 ct or 0 at negative spot, got ${v}`);
  } finally {
    await mock.close();
  }
});

test('fixedFeedInSlots: feste Vergütung, 0 bei negativem Spot, Standard 7,78 ct', async () => {
  const { fixedFeedInSlots } = await import('../services/optimizer/eos-forecast-bridge.js');
  const slots = [{ start: '2026-10-02T10:00:00Z', ctKwh: 5 }, { start: '2026-10-02T10:15:00Z', ctKwh: -1 }, { start: '2026-10-02T10:30:00Z', ctKwh: null }];
  assert.deepEqual(fixedFeedInSlots(slots, {}).map((s) => s.powerW), [7.78 / 100 / 1000, 0, 7.78 / 100 / 1000]);
  assert.deepEqual(fixedFeedInSlots(slots, { feedInCtKwh: 0 }).map((s) => s.powerW), [0, 0, 0]);
});

test('push: ElecPriceImport resolves the import price PER active tariff PERIOD (date-based)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = {
      getCfg: () => ({
        optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }, tariff: { feedInMode: 'fixed' }, timezone: 'Europe/Berlin' },
        userEnergyPricing: {
          mode: 'fixed',
          fixedGrossImportCtKwh: 26.9, // top-level matches the CURRENT period
          periods: [
            { id: 'p1', label: 'Grünwelt', startDate: '2025-09-15', endDate: '2025-12-09', mode: 'fixed', fixedGrossImportCtKwh: 29 },
            { id: 'p2', label: 'Grüün', startDate: '2025-12-10', endDate: '2026-12-10', mode: 'fixed', fixedGrossImportCtKwh: 26.9 },
          ],
        },
      }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => ({
        pv: { slots: [{ start: '2026-06-29T17:45:00.000Z', powerW: 1000 }] },
        load: { slots: [{ start: '2026-06-29T17:45:00.000Z', powerW: 500 }] },
        // Two slots straddling the period boundary; spot is 14 ct but a FIXED
        // period must override it with the period's gross price, NOT the spot.
        price: { slots: [
          { start: '2026-06-29T17:45:00.000Z', ctKwh: 14 }, // 2026 → period 2 → 26.9 ct
          { start: '2025-11-01T18:45:00.000Z', ctKwh: 14 }, // Nov 2025 → period 1 → 29 ct
        ] },
      }) },
      state: { victron: { soc: 50 } },
    };
    await createEosForecastBridge(ctx).push();
    const elec = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/prediction/import/ElecPriceImport'));
    assert.ok(elec && elec.body && elec.body.data, 'ElecPriceImport pushed with a data frame');
    const data = elec.body.data;
    // period 2 (current): 26.9 ct/kWh = 0.000269 €/Wh — NOT the 14 ct raw spot.
    assert.equal(data['2026-06-29T17:45:00Z'].elecprice_marketprice_wh.toFixed(8), '0.00026900');
    // period 1 (expired 2025-12-09): 29 ct/kWh = 0.00029 €/Wh.
    assert.equal(data['2025-11-01T18:45:00Z'].elecprice_marketprice_wh.toFixed(8), '0.00029000');
  } finally {
    await mock.close();
  }
});

// --- Self-heal reconcile hook (2026-06-19): start({afterPush}) re-runs config-sync each tick ---
test('start({fireImmediately:false}): no immediate tick; afterPush runs on the interval (EOS-restart self-heal)', async () => {
  const ctx = { getCfg: () => ({ optimizer: { eosProxy: { enabled: false } } }), pushLog: () => {}, forecastService: { buildForecastResponse: async () => ({}) }, state: {} };
  const bridge = createEosForecastBridge(ctx);
  let after = 0;
  bridge.start({ fireImmediately: false, intervalMs: 25, afterPush: async () => { after += 1; } });
  assert.equal(after, 0, 'fireImmediately:false must not tick at start');
  await new Promise((r) => setTimeout(r, 90));
  bridge.stop();
  assert.ok(after >= 1, 'afterPush must run on the interval tick (config-sync self-heal)');
});

test('start(): default fireImmediately runs exactly one immediate tick', async () => {
  const ctx = { getCfg: () => ({ optimizer: { eosProxy: { enabled: false } } }), pushLog: () => {}, forecastService: { buildForecastResponse: async () => ({}) }, state: {} };
  const bridge = createEosForecastBridge(ctx);
  let after = 0;
  bridge.start({ intervalMs: 100000, afterPush: async () => { after += 1; } });
  await new Promise((r) => setTimeout(r, 25));
  bridge.stop();
  assert.equal(after, 1, 'default fireImmediately should run one immediate tick');
});

// --- EOS-restart watchdog (2026-06-28): pid change → immediate reconcile ---
function healthPidHandler(getPid) {
  return (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'alive', pid: getPid() }));
      return;
    }
    okHandler(req, res);
  };
}

test('watchdog: EOS pid change triggers an immediate reconcile (providers + data re-pushed)', async () => {
  let pid = 1000;
  const mock = await createMockEos(healthPidHandler(() => pid));
  try {
    let beforeCount = 0;
    const logs = [];
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: (ev, d) => logs.push({ ev, d }),
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: { soc: 50 } },
    };
    const bridge = createEosForecastBridge(ctx);
    const restarts = [];
    let pushesBeforeRestartHook = null;
    bridge.start({
      fireImmediately: false, intervalMs: 100000, watchdogMs: 20,
      beforePush: async () => { beforeCount += 1; },
      onEosRestart: (info) => { restarts.push(info); pushesBeforeRestartHook = beforeCount; },
    });
    // Let the watchdog record the initial pid — no reconcile while it is stable.
    // (Zwei /v1/health-Abfragen: die erste hat die Ausgangs-PID sicher gemerkt.)
    const healthPolls = () => mock.requests.filter((q) => q.url.startsWith('/v1/health')).length;
    await waitUntil(() => healthPolls() >= 2);
    assert.equal(beforeCount, 0, 'stable pid must not reconcile');
    assert.equal(restarts.length, 0, 'kein Neustart-Hook ohne Neustart');
    // Simulate an EOS restart: the pid changes.
    pid = 2000;
    await waitUntil(() => restarts.length >= 1 && beforeCount >= 1);
    // Ein paar Takte weiter: eine doppelte Benachrichtigung soll auffallen.
    await new Promise((r) => setTimeout(r, 100));
    bridge.stop();
    assert.ok(beforeCount >= 1, 'pid change must trigger a reconcile tick (config-sync beforePush ran)');
    // Der Optimizer wird erst NACH dem Neu-Push benachrichtigt (sonst haette
    // EOS beim Abholen noch keine Prognosen) — und genau einmal.
    assert.deepEqual(restarts, [{ oldPid: 1000, newPid: 2000 }]);
    assert.ok(pushesBeforeRestartHook >= 1, 'Hook nach dem Reconcile-Tick');
    assert.ok(
      logs.some((l) => l.ev === 'eos_restart_detected' && l.d.oldPid === 1000 && l.d.newPid === 2000),
      'eos_restart_detected must log old + new pid',
    );
  } finally {
    await mock.close();
  }
});

test('watchdog: stable EOS pid never triggers a reconcile', async () => {
  const mock = await createMockEos(healthPidHandler(() => 4242));
  try {
    let beforeCount = 0;
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: { soc: 50 } },
    };
    const bridge = createEosForecastBridge(ctx);
    bridge.start({ fireImmediately: false, intervalMs: 100000, watchdogMs: 20, beforePush: async () => { beforeCount += 1; } });
    await new Promise((r) => setTimeout(r, 100));
    bridge.stop();
    assert.equal(beforeCount, 0, 'stable pid must never reconcile');
  } finally {
    await mock.close();
  }
});

// ── Marktprämien-Modulation (2026-06-21) ───────────────────────────────────
// Export-Signal = spot + Marktprämie (premium = max(0, AW − MW)), §51: kein
// Aufschlag bei negativem Preis; config-gated, default OFF (byte-identisch).

const FEED_KEY = 'feed_in_tariff_wh';
const LAST_YEAR = new Date().getUTCFullYear() - 1;
const closeTo = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function premiumCtx(mock, { gate, overrideAw, mwByYear, applicableSummary, pvPlants, onLog } = {}) {
  return {
    getCfg: () => ({
      optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }, tariff: { feedInMode: 'spot', feedInSpotFactor: 1, feedInIncludeMarketPremium: gate } },
      userEnergyPricing: { applicableValueOverrideCtKwh: overrideAw, pvPlants: pvPlants || [] },
    }),
    pushLog: onLog || (() => {}),
    forecastService: { buildForecastResponse: async () => ({
      pv: { slots: [{ start: '2026-05-24T12:00:00.000Z', powerW: 1000 }] },
      load: { slots: [{ start: '2026-05-24T12:00:00.000Z', powerW: 500 }] },
      price: { slots: [{ start: '2026-05-24T12:00:00.000Z', ctKwh: 30 }, { start: '2026-05-24T12:15:00.000Z', ctKwh: -5 }] },
    }) },
    state: { victron: { soc: 50 } },
    getSolarMarketValueSummary: async () => ({ annualCtKwhByYear: mwByYear || {} }),
    getApplicableValueSummary: async () => applicableSummary || { applicableValueCtKwhByMonth: {} },
  };
}

function feedMap(mock) {
  const req = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/prediction/import/FeedInTariffImport'));
  assert.ok(req && req.body && req.body.data, 'FeedInTariffImport body present');
  // Body is datetime-first (PydanticDateTimeDataFrame): data[iso][FEED_KEY].
  // Flatten to {iso: value} so the assertions read naturally.
  return Object.fromEntries(
    Object.entries(req.body.data).map(([iso, cell]) => [iso, cell?.[FEED_KEY]]),
  );
}

test('premium ON: adds max(0,AW−MW) to positive spot, NOT to negative (§51)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = premiumCtx(mock, { gate: true, overrideAw: 10, mwByYear: { [LAST_YEAR]: 6 } }); // premium = 4 ct
    await createEosForecastBridge(ctx).push();
    const d = feedMap(mock);
    closeTo(d['2026-05-24T12:00:00Z'], (30 + 4) / 100 / 1000); // +premium on positive
    closeTo(d['2026-05-24T12:15:00Z'], -5 / 100 / 1000);       // no premium on negative
  } finally { await mock.close(); }
});

test('premium OFF (gate false): byte-identical raw spot even with services present', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = premiumCtx(mock, { gate: false, overrideAw: 10, mwByYear: { [LAST_YEAR]: 6 } });
    await createEosForecastBridge(ctx).push();
    const d = feedMap(mock);
    closeTo(d['2026-05-24T12:00:00Z'], 30 / 100 / 1000);
    closeTo(d['2026-05-24T12:15:00Z'], -5 / 100 / 1000);
  } finally { await mock.close(); }
});

test('premium ON but MW unavailable: falls back to raw spot + logs skip', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const logs = [];
    const ctx = premiumCtx(mock, { gate: true, overrideAw: 10, mwByYear: {}, onLog: (ev, d) => logs.push({ ev, d }) });
    await createEosForecastBridge(ctx).push();
    const d = feedMap(mock);
    closeTo(d['2026-05-24T12:00:00Z'], 30 / 100 / 1000); // no premium
    assert.ok(logs.some((l) => l.ev === 'eos_feedin_premium_skip'), 'skip logged when MW missing');
  } finally { await mock.close(); }
});

test('premium clamp: AW < MW yields zero premium (no negative add)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = premiumCtx(mock, { gate: true, overrideAw: 5, mwByYear: { [LAST_YEAR]: 8 } }); // max(0,-3)=0
    await createEosForecastBridge(ctx).push();
    const d = feedMap(mock);
    closeTo(d['2026-05-24T12:00:00Z'], 30 / 100 / 1000);
  } finally { await mock.close(); }
});

test('premium ON: auto AW from BNetzA summary (no override) + MW → premium applied', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = premiumCtx(mock, {
      gate: true,
      overrideAw: undefined, // force the async auto path
      mwByYear: { [LAST_YEAR]: 6 },
      pvPlants: [{ kwp: 10, commissionedAt: '2026-01' }],
      applicableSummary: { getApplicableValueCtKwh: () => 7 }, // AW=7 → premium=1
    });
    await createEosForecastBridge(ctx).push();
    const d = feedMap(mock);
    closeTo(d['2026-05-24T12:00:00Z'], (30 + 1) / 100 / 1000);
  } finally { await mock.close(); }
});

// prod 2026-09-23 01:51: EOS 0.4 brach jeden Lauf ab, weil Day-Ahead nachts
// nur bis Mitternacht reicht, der Steuerzeitraum aber fest 24 h war.
describe('Steuerzeitraum = Preisabdeckung (EOS 0.4)', () => {
  const Q = 15 * 60_000;
  const slots = (fromMs, count) => Array.from({ length: count }, (_, i) => ({ start: new Date(fromMs + i * Q).toISOString(), powerW: 0.0001 }));
  const now = Date.parse('2026-09-22T23:52:00Z'); // 01:52 Ortszeit
  const midnight = Date.parse('2026-09-23T22:00:00Z'); // 24:00 Ortszeit

  test('nachts: bis Mitternacht belegt (22 h 08 min) → 21 h (volle Stunden nach 15 min Puffer)', () => {
    const list = slots(Date.parse('2026-09-22T22:00:00Z'), (midnight - Date.parse('2026-09-22T22:00:00Z')) / Q);
    assert.equal(computeControlHorizonHours([list], now), 21);
  });

  // Christin 02.11.2026: keine 24-h-Kappe mehr — Standard ist der ganze
  // bekannte Preiszeitraum (Memory „EOS-Horizont = Preishorizont“).
  test('nach 13 Uhr mit Folgetag: ganzer Preiszeitraum (45 h), nicht 24 h', () => {
    const list = slots(Date.parse('2026-09-22T22:00:00Z'), 48 * 4);
    assert.equal(computeControlHorizonHours([list], now), 45);
  });

  test('eingestellte Grenze (maxHours) kappt weiter', () => {
    const list = slots(Date.parse('2026-09-22T22:00:00Z'), 48 * 4);
    assert.equal(computeControlHorizonHours([list], now, { maxHours: 24 }), 24);
    assert.equal(computeControlHorizonHours([list], now, { maxHours: 6 }), 6);
  });

  test('absolute Obergrenze 48 h (Rechendienst nimmt 1..48)', () => {
    const list = slots(Date.parse('2026-09-22T22:00:00Z'), 60 * 4);
    assert.equal(computeControlHorizonHours([list], now), 48);
  });

  test('Luecke in einer Reihe begrenzt den Zeitraum auf die Luecke', () => {
    const a = slots(Date.parse('2026-09-22T23:45:00Z'), 40);
    const b = [...slots(Date.parse('2026-09-22T23:45:00Z'), 12), ...slots(Date.parse('2026-09-23T03:00:00Z'), 40)];
    // b ist bis 02:45 UTC belegt → 2h53 ab jetzt → minus Puffer → 2 h
    assert.equal(computeControlHorizonHours([a, b], now), 2);
  });

  test('der laufende Slot fehlt: keine Abdeckung', () => {
    assert.equal(computeControlHorizonHours([slots(Date.parse('2026-09-23T01:00:00Z'), 40)], now), null);
  });

  test('Reihe ganz ohne Werte zaehlt nicht mit (wird auch nicht geschickt)', () => {
    const list = slots(Date.parse('2026-09-22T22:00:00Z'), (midnight - Date.parse('2026-09-22T22:00:00Z')) / Q);
    assert.equal(computeControlHorizonHours([list, []], now), 21);
    assert.equal(computeControlHorizonHours([list, [{ start: 'x', powerW: null }]], now), 21);
    assert.equal(computeControlHorizonHours([[], []], now), null, 'gar keine Werte: kein Zeitraum');
  });

  test('knapp belegt: mindestens 1 h', () => {
    assert.equal(computeControlHorizonHours([slots(Date.parse('2026-09-22T23:45:00Z'), 3)], now), 1);
  });
});

// EOS 0.4 nimmt den SoC nur aus den letzten 300 s — DVhub schickt ihn
// minuetlich, nur mit "jetzt"-Stempel. Erst nachdem ein EOS 0.4 erkannt ist.
// Altes Verhalten (optimizer.eosStartAfterPreviousRun): EOS rechnet nach eigenem
// Takt und liest den Ladestand aus Messwerten.
test('pushFreshSoc (EOS-eigener Takt): nur bei erkanntem EOS 0.4, nur ein Zeitstempel', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const state = { victron: { soc: 50 }, optimizer: { eos: { supported: false } } };
    const ctx = {
      getCfg: () => ({ optimizer: { eosStartAfterPreviousRun: true, eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state,
      teslamateService: { getState: () => ({ batteryLevel: 63 }) },
    };
    const bridge = createEosForecastBridge(ctx);
    assert.equal((await bridge.pushFreshSoc()).skipped, 'eos not supported');
    assert.equal(mock.requests.length, 0);

    state.optimizer.eos.supported = true;
    const res = await bridge.pushFreshSoc();
    const puts = mock.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/v1/measurement/value'));
    assert.equal(puts.length, 2, 'Akku + Auto, je EIN Stempel');
    assert.equal(res.pushed.length, 2);
  } finally {
    await mock.close();
  }
});

test('Steuerzeitraum: stuendliche Reihe gilt nicht als Luecke', () => {
  const now = Date.parse('2026-09-22T23:52:00Z');
  const hourly = Array.from({ length: 30 }, (_, i) => ({ start: new Date(Date.parse('2026-09-22T23:00:00Z') + i * 3_600_000).toISOString(), powerW: 1 }));
  // belegt bis 05:00Z übermorgen: 29 h 08 min ab jetzt − 15 min → 28 h
  assert.equal(computeControlHorizonHours([hourly], now), 28);
});

// EOS 0.4 bricht ohne Messwert <gerät>.cycles_completed JEDEN Lauf ab
// („Invalid completed cycle count“, Pi 2026-10-01).
test('pushFreshSoc: abgeschlossene Geräteläufe als Messwert (0 ohne Zähler, höchstens 1)', async () => {
  const mock = await createMockEos((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/measurement/keys')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(['battery1-soc-factor', 'appl_spuele.cycles_completed', 'appl_trockner.cycles_completed']));
      return;
    }
    okHandler(req, res);
  });
  try {
    const state = { victron: { soc: 50 }, optimizer: { eos: { supported: true }, applianceCyclesToday: { appl_trockner: 3 } } };
    const ctx = {
      getCfg: () => ({ optimizer: { eosStartAfterPreviousRun: true, eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {}, forecastService: { buildForecastResponse: async () => forecastSlots() }, state,
    };
    const res = await createEosForecastBridge(ctx).pushFreshSoc();
    assert.ok(res.pushed.includes('appl_spuele.cycles_completed=0'));
    assert.ok(res.pushed.includes('appl_trockner.cycles_completed=1'));
  } finally {
    await mock.close();
  }
});

import { padSlotsBackToNow } from '../services/optimizer/eos-forecast-bridge.js';

test('Lastprognose bis vor die laufende Stunde aufgefüllt (sonst bricht EOS nach Neustart ab)', () => {
  const now = Date.parse('2026-10-02T00:33:00+02:00');
  const slots = [{ start: '2026-10-01T23:00:00.000Z', powerW: 700 }, { start: '2026-10-02T00:00:00.000Z', powerW: 650 }];
  const out = padSlotsBackToNow(slots, now);
  assert.equal(out[0].start, '2026-10-01T20:00:00.000Z', 'ab 2 h vor der laufenden Stunde (22:00 UTC = 00:00 lokal)');
  assert.equal(out.length, 5);
  assert.ok(out.slice(0, 3).every((s) => s.powerW === 700 && s.padded));
  assert.deepEqual(padSlotsBackToNow(out, now), out, 'idempotent, wenn schon abgedeckt');
  assert.deepEqual(padSlotsBackToNow([], now), []);
});

test('keepOnGridSlots drops forecast.solar sunrise/sunset stamps (EOS cadence would collapse to 15 s)', async () => {
  const { keepOnGridSlots } = await import('../services/optimizer/eos-forecast-bridge.js');
  const slots = [
    { start: '2026-10-02T17:00:00+02:00', powerW: 0 },
    { start: '2026-10-02T17:15:00+02:00', powerW: 10 },
    { start: '2026-10-02T19:00:00+02:00', powerW: 305 },
    { start: '2026-10-02T19:00:15+02:00', powerW: 2 },
    { start: '2026-10-03T07:24:22+02:00', powerW: 0 },
    { start: 'kaputt', powerW: 1 },
  ];
  assert.deepEqual(keepOnGridSlots(slots).map((s) => s.start), [
    '2026-10-02T17:00:00+02:00', '2026-10-02T17:15:00+02:00', '2026-10-02T19:00:00+02:00',
  ]);
  assert.deepEqual(keepOnGridSlots(null), []);
});

test('Heizstab: erwarteter Verbrauch geht als Last an EOS (Vorhaltung in Überschuss-Stunden)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    // Morgen 10–13 Uhr UTC: 4 kW PV bei 500 W Last → 3,5 kW Überschuss je Stunde.
    const day = new Date(Date.now() + 24 * 3600_000); day.setUTCHours(0, 0, 0, 0);
    const at = (h, q = 0) => new Date(day.getTime() + h * 3600_000 + q * 900_000).toISOString();
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const forecast = {
      pv: { slots: hours.flatMap((h) => [0, 1, 2, 3].map((q) => ({ start: at(h, q), powerW: h >= 10 && h <= 13 ? 4000 : 0 }))) },
      load: { slots: hours.map((h) => ({ start: at(h), powerW: 500 })) },
      price: { slots: hours.flatMap((h) => [0, 1, 2, 3].map((q) => ({ start: at(h, q), ctKwh: 10 }))) },
    };
    const heater = { id: 'Heizstaab', name: 'Heizstab', schedulable: true, kind: 'modulating', enabled: true, plan: { maxPowerW: 3000, minPowerW: 0, capacityWh: 8000 }, endpoint: { type: 'mqtt_expose' } };
    const state = { victron: { soc: 50 } };
    const logs = [];
    const run = async (cfgExtra) => {
      mock.requests.length = 0;
      const bridge = createEosForecastBridge({
        getCfg: () => ({ devices: [heater], optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }, ...cfgExtra } }),
        pushLog: (event, data) => logs.push({ event, data }),
        forecastService: { buildForecastResponse: async () => forecast },
        state,
      });
      await bridge.push();
      const put = mock.requests.find((r) => r.method === 'PUT' && r.url.includes('/v1/prediction/import/LoadImport'));
      assert.ok(put, 'LoadImport gesendet');
      return Object.values(put.body.data).map((row) => row.loadforecast_power_w);
    };

    const withHeater = await run({});
    const extraWh = withHeater.reduce((sum, w) => sum + (w - 500) / 4, 0);
    assert.equal(Math.round(extraWh), 8000, 'genau die Tagesmenge des Heizstabs zusätzlich');
    assert.equal(Math.max(...withHeater), 3500, 'höchstens Grundlast + Maximalleistung');
    assert.deepEqual(Object.values(state.optimizer.heaterReservation.byDay), [8000]);
    assert.ok(logs.some((l) => l.event === 'eos_forecast_bridge' && l.data.heaterReservedWh));

    const off = await run({ heaterLoadReservation: false });
    assert.ok(off.every((w) => w === 500), 'abgeschaltet: Lastprognose unverändert');
    assert.equal(state.optimizer.heaterReservation, null);
  } finally {
    await mock.close();
  }
});

test('watchdog: Neustart im Container (PID bleibt 1) löst über den Monitor den Neu-Push aus', async () => {
  const mock = await createMockEos(okHandler);
  try {
    let beforeCount = 0;
    const logs = [];
    const monitor = { pid: 1, restarts: 0, lastRestartReason: null };
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: (ev, d) => logs.push({ ev, d }),
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: { soc: 50 } },
      eosMonitor: { status: () => { statusCalls += 1; return { ...monitor }; } },
    };
    let statusCalls = 0;
    const bridge = createEosForecastBridge(ctx);
    const restarts = [];
    bridge.start({
      fireImmediately: false, intervalMs: 100000, watchdogMs: 20,
      beforePush: async () => { beforeCount += 1; },
      onEosRestart: (info) => { restarts.push(info); },
    });
    // Zwei Watchdog-Takte: der erste hat den Ausgangsstand sicher gemerkt.
    await waitUntil(() => statusCalls >= 2);
    assert.equal(beforeCount, 0, 'ohne Neustart kein Reconcile');
    // EOS-Container neu erstellt: gleiche PID, der Monitor zählt den Neustart.
    monitor.restarts = 1; monitor.lastRestartReason = 'started_at';
    await waitUntil(() => restarts.length >= 1 && beforeCount >= 1);
    // Ein paar Takte weiter: eine doppelte Benachrichtigung soll auffallen.
    await new Promise((r) => setTimeout(r, 100));
    bridge.stop();
    assert.ok(beforeCount >= 1, 'Neustart → Einstellungen und Prognosen sofort neu');
    assert.equal(restarts.length, 1, 'Optimierer genau einmal benachrichtigt');
    assert.ok(logs.some((l) => l.ev === 'eos_restart_detected' && l.d.reason === 'started_at'));
  } finally {
    await mock.close();
  }
});

// Seit 2026-10-11 stößt DVhub die Läufe an (eos-run-trigger.js): der Ladestand
// reist im Aufruf mit, als Messwert wird er nicht mehr geschrieben.
function socCtx(mock, { state, cfgExtra = {}, teslamate } = {}) {
  return {
    getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }, ...cfgExtra } }),
    pushLog: () => {},
    forecastService: { buildForecastResponse: async () => forecastSlots() },
    state,
    ...(teslamate ? { teslamateService: { getState: () => teslamate } } : {}),
  };
}
const keysHandler = (keys) => (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/measurement/keys')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(keys));
    return;
  }
  okHandler(req, res);
};

test('Standard: kein Ladestand mehr als Messwert — weder minütlich noch im Prognose-Push', async () => {
  const mock = await createMockEos(keysHandler(['battery1-soc-factor', 'ev11-soc-factor', 'appl_spuele.cycles_completed']));
  try {
    const state = { victron: { soc: 50, evSocPct: 40 }, optimizer: { eos: { supported: true }, applianceCyclesToday: { appl_spuele: 1 } } };
    const bridge = createEosForecastBridge(socCtx(mock, { state }));
    const fresh = await bridge.pushFreshSoc();
    assert.equal(fresh.skipped, 'soc travels with the run request');
    assert.equal(mock.requests.length, 0, 'der Minutentakt fragt EOS gar nicht mehr');

    const res = await bridge.push();
    const values = mock.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/v1/measurement/value'));
    assert.deepEqual(values.map((r) => new URL(r.url, 'http://x').searchParams.get('key')), ['appl_spuele.cycles_completed'],
      'nur noch der Zähler des Geräts, kein *-soc-factor');
    assert.ok(res.pushed.includes('appl_spuele.cycles_completed=1'));
  } finally {
    await mock.close();
  }
});

test('socForRun: ganze Prozent je EOS-Gerät, Auto nur mit Ladestand', async () => {
  const mock = await createMockEos(keysHandler(['date_time', 'battery1-power-l1-w', 'battery1-soc-factor', 'ev11-soc-factor']));
  try {
    const state = { victron: { soc: 54.6 }, optimizer: { eos: { supported: true } } };
    // Auto angemeldet, DVhub kennt seinen Ladestand: 63 % aus TeslaMate.
    const withEv = createEosForecastBridge(socCtx(mock, { state, teslamate: { batteryLevel: 63 } }));
    assert.deepEqual(await withEv.socForRun(), { soc: { battery1: 55, ev11: 63 } });
    // Ohne Ladestand fürs Auto: nur der Akku (54,6 → 55).
    const withoutEv = createEosForecastBridge(socCtx(mock, { state }));
    assert.deepEqual(await withoutEv.socForRun(), { soc: { battery1: 55 } });
    // Grenzen: 100,4 → 100, −3 → 0.
    state.victron.soc = 100.4;
    assert.deepEqual(await withoutEv.socForRun(), { soc: { battery1: 100 } });
    state.victron.soc = -3;
    assert.deepEqual(await withoutEv.socForRun(), { soc: { battery1: 0 } });
    assert.equal(mock.requests.filter((r) => r.method !== 'GET').length, 0, 'liest nur, schreibt nichts');
  } finally {
    await mock.close();
  }
});

test('socForRun: ohne Akku-Ladestand oder ohne Akku in EOS kein Aufruf', async () => {
  const mock = await createMockEos(keysHandler(['date_time']));
  try {
    const noSoc = createEosForecastBridge(socCtx(mock, { state: { victron: {}, optimizer: {} } }));
    assert.equal((await noSoc.socForRun()).skipped, 'no live battery soc in state');
    assert.equal(mock.requests.length, 0);
    const noBattery = createEosForecastBridge(socCtx(mock, { state: { victron: { soc: 50 }, optimizer: {} } }));
    assert.equal((await noBattery.socForRun()).skipped, 'no battery registered in EOS');
  } finally {
    await mock.close();
  }
});

// Review 25.10.2026: die Bridge ist einziger Schreiber der EOS-Prognosen; ihr
// Ergebnis steht deshalb in state.optimizer.lastEosPush (Prognose-Inspektor).
test('push traegt das eigene Ergebnis in state.optimizer.lastEosPush ein', async () => {
  let failLoad = true;
  const mock = await createMockEos((req, res) => {
    if (failLoad && req.method === 'PUT' && req.url.startsWith('/v1/prediction/import/LoadImport')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'boom' }));
      return;
    }
    okHandler(req, res);
  });
  try {
    const state = { victron: { soc: 50 }, optimizer: {} };
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state,
    };
    const bridge = createEosForecastBridge(ctx);
    await bridge.push();
    assert.equal(state.optimizer.lastEosPush.ok, false);
    assert.match(state.optimizer.lastEosPush.error, /LoadImport/);
    assert.ok(Number.isFinite(state.optimizer.lastEosPush.at));
    failLoad = false;
    await bridge.push();
    assert.equal(state.optimizer.lastEosPush.ok, true);
    assert.equal(state.optimizer.lastEosPush.error, null);
  } finally {
    await mock.close();
  }
});

test('push ohne Prognosedienst meldet den Fehler ebenfalls in lastEosPush', async () => {
  const state = { optimizer: {} };
  await createEosForecastBridge({ getCfg: () => ({}), pushLog: () => {}, state }).push();
  assert.equal(state.optimizer.lastEosPush.ok, false);
  assert.match(state.optimizer.lastEosPush.error, /bootstrap/);
});

// --- Preise über die bekannten hinaus schätzen (Christin 01.11.2026) ---------
// Vormittags enden die echten Preise um Mitternacht; EOS kürzte seinen Schwanz
// auf 0,5 h („Tail forecast shortened … limited by import price, feed-in
// tariff“). Die Bridge verlängert die Preisreihen bis zum Ende der PV-/Last-
// Prognose mit geschätzten Börsenpreisen; der Steuerzeitraum bleibt bei den
// echten Preisen.
const Q = 15 * 60 * 1000;
function estimateCtx(mock, { pricing, tariff = { feedInMode: 'spot', feedInSpotFactor: 1 }, withHistory = true, logs = [], realHours = 10, pvHours = 40, optimizer = {} } = {}) {
  const now = Date.now();
  const q0 = now - (now % Q);
  const realEnd = q0 + realHours * 3_600_000; // echte Preise bis jetzt + 10 h
  const pvEnd = q0 + pvHours * 3_600_000;     // PV/Last bis jetzt + 40 h
  const pattern = (ms) => 10 + 8 * Math.sin(((ms / Q) % 96 - 30) / 96 * 2 * Math.PI);
  const price = [];
  for (let ms = q0 - 2 * 3_600_000; ms < realEnd; ms += Q) price.push({ start: new Date(ms).toISOString(), ctKwh: pattern(ms) });
  const pv = [];
  for (let ms = q0; ms < pvEnd; ms += Q) pv.push({ start: new Date(ms).toISOString(), powerW: 1000 });
  const load = [];
  for (let ms = q0 - (q0 % 3_600_000); ms < pvEnd; ms += 3_600_000) load.push({ start: new Date(ms).toISOString(), powerW: 500 });
  const history = [];
  for (let ms = q0 - 20 * 86_400_000; ms < q0; ms += Q) history.push({ key: 'price_ct_kwh', ts: new Date(ms), value: pattern(ms), resolution: 900 });
  const state = { victron: { soc: 50 }, optimizer: { eos: { supported: true } } };
  const ctx = {
    getCfg: () => ({
      optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }, tariff, timezone: 'Europe/Berlin', ...optimizer },
      userEnergyPricing: pricing || { mode: 'fixed', fixedGrossImportCtKwh: 30 },
    }),
    pushLog: (event, data) => logs.push({ event, data }),
    forecastService: { buildForecastResponse: async () => ({ pv: { slots: pv }, load: { slots: load }, price: { slots: price } }) },
    state,
    ...(withHistory ? { telemetryStore: { querySeries: async () => history } } : {}),
  };
  // Ende der Reihen: die längere von PV (15 min) und Last (stündlich).
  const fillEnd = Math.max(pvEnd, Date.parse(load[load.length - 1].start) + 3_600_000);
  return { ctx, state, q0, realEnd, fillEnd, pattern };
}

function seriesOf(mock, provider, key) {
  const req = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith(`/v1/prediction/import/${provider}`));
  assert.ok(req && req.body && req.body.data, `${provider} gesendet`);
  return new Map(Object.entries(req.body.data).map(([iso, cell]) => [Date.parse(iso), cell[key]]));
}

test('Preise auffüllen: Bezug (fest) und Einspeisung (Börse) bis zum Ende der Prognose, Steuerzeitraum nur echte', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const logs = [];
    const { ctx, state, q0, realEnd, fillEnd, pattern } = estimateCtx(mock, { logs });
    await createEosForecastBridge(ctx).push();
    const elec = seriesOf(mock, 'ElecPriceImport', 'elecprice_marketprice_wh');
    const feed = seriesOf(mock, 'FeedInTariffImport', 'feed_in_tariff_wh');
    assert.equal(Math.max(...elec.keys()), fillEnd - Q, 'Bezugspreis reicht bis zum Ende der PV-/Lastprognose');
    assert.equal(Math.max(...feed.keys()), fillEnd - Q, 'Einspeisewert reicht bis zum Ende der PV-/Lastprognose');
    // Fester Tarif: auch der geschätzte Slot kostet 30 ct.
    closeTo(elec.get(realEnd + 5 * 3_600_000), 30 / 100 / 1000);
    // Einspeisung = geschätzter Börsenpreis, folgt dem Tagesmuster.
    const t = realEnd + 7 * 3_600_000;
    assert.ok(Math.abs(feed.get(t) * 100_000 - pattern(t)) < 1, `${feed.get(t) * 100_000} vs ${pattern(t)}`);
    // Steuerzeitraum aus den echten Preisen (10 h ab Viertelstundenbeginn).
    const hz = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/optimization/genetic/horizon_hours'));
    assert.equal(hz.body, Math.floor((realEnd - Date.now() - Q) / 3_600_000));
    // Kennzeichnung für Oberfläche und Log.
    const est = state.optimizer.lastEosPush.priceEstimate;
    assert.equal(est.estimatedSlots, (fillEnd - realEnd) / Q);
    assert.equal(est.from, new Date(realEnd).toISOString());
    assert.equal(state.optimizer.eosPriceEstimate.estimatedSlots, est.estimatedSlots);
    const log = logs.find((l) => l.event === 'eos_forecast_bridge');
    assert.equal(log.data.estimatedPriceSlots, est.estimatedSlots);
    assert.ok(q0 > 0);
  } finally { await mock.close(); }
});

test('Preise auffüllen: Anbieterpreis = Ausgleichsgerade über dem geschätzten Börsenpreis', async () => {
  const { setProviderEstimate, clearProviderPrices } = await import('../services/tariff-provider/price-store.js');
  const mock = await createMockEos(okHandler);
  try {
    setProviderEstimate({ slope: 1.2257, intercept: 15.98, n: 96 });
    const { ctx, realEnd } = estimateCtx(mock, { pricing: { mode: 'provider', provider: { name: 'lichtblick', priceBasis: 'gross_total' } } });
    await createEosForecastBridge(ctx).push();
    const elec = seriesOf(mock, 'ElecPriceImport', 'elecprice_marketprice_wh');
    const feed = seriesOf(mock, 'FeedInTariffImport', 'feed_in_tariff_wh');
    const t = realEnd + 3 * 3_600_000;
    const spot = feed.get(t) * 100_000;
    assert.ok(Math.abs(elec.get(t) * 100_000 - (1.2257 * spot + 15.98)) < 0.02);
  } finally { clearProviderPrices(); await mock.close(); }
});

test('Preise auffüllen: dynamischer Tarif = geschätzter Börsenpreis + Bestandteile', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const components = { energyMarkupCtKwh: 2, gridChargesCtKwh: 10, leviesAndFeesCtKwh: 3, vatPct: 19 };
    const { ctx, realEnd } = estimateCtx(mock, { pricing: { mode: 'dynamic', dynamicComponents: components } });
    await createEosForecastBridge(ctx).push();
    const elec = seriesOf(mock, 'ElecPriceImport', 'elecprice_marketprice_wh');
    const feed = seriesOf(mock, 'FeedInTariffImport', 'feed_in_tariff_wh');
    const t = realEnd + 4 * 3_600_000;
    const spot = feed.get(t) * 100_000;
    assert.ok(Math.abs(elec.get(t) * 100_000 - (spot + 15) * 1.19) < 0.05);
  } finally { await mock.close(); }
});

test('Preise auffüllen: ohne gespeicherte Historie bleibt alles wie bisher', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const { ctx, state, realEnd } = estimateCtx(mock, { withHistory: false });
    await createEosForecastBridge(ctx).push();
    const elec = seriesOf(mock, 'ElecPriceImport', 'elecprice_marketprice_wh');
    assert.equal(Math.max(...elec.keys()), realEnd - Q);
    assert.equal(state.optimizer.lastEosPush.priceEstimate, null);
    assert.equal(state.optimizer.eosPriceEstimate, null);
  } finally { await mock.close(); }
});

// Leitstand „Laut EOS-Plan“ (Christin 02.11.2026): die Anzeige nennt, womit EOS
// die eingespeiste kWh bewertet — dieselbe Regel wie push().
test('eosFeedInBasis: fest, Börse, Börse + Marktprämie', async () => {
  const { eosFeedInBasis } = await import('../services/optimizer/eos-forecast-bridge.js');
  assert.equal(eosFeedInBasis(undefined), 'fixed');
  assert.equal(eosFeedInBasis({ optimizer: { tariff: { feedInMode: 'fixed', feedInIncludeMarketPremium: true } } }), 'fixed');
  assert.equal(eosFeedInBasis({ optimizer: { tariff: { feedInMode: 'spot' } } }), 'spot');
  assert.equal(eosFeedInBasis({ optimizer: { tariff: { feedInMode: 'SPOT', feedInIncludeMarketPremium: true } } }), 'spot_premium');
});

// --- Steuerzeitraum und EOS-Prognosehorizont einstellbar (Christin 02.11.2026) ---
// Steuerzeitraum: Standard der ganze bekannte Preiszeitraum, optional höchstens
// 6/12/24 h (kleine Boards). Prognosehorizont (EOS prediction.hours, bisher fest
// 48): Standard Steuerzeitraum-Grenze + 48 h Schwanz, höchstens 72 h — dieselbe
// Grenze wie die Preis-Fortschreibung. Nie kürzer als der Steuerzeitraum: EOS
// bricht sonst jeden Lauf ab.
test('resolveEosPredictionHours / resolveControlHorizonMaxHours', async () => {
  const { resolveEosPredictionHours, resolveControlHorizonMaxHours } = await import('../services/optimizer/eos-forecast-bridge.js');
  const c = (o) => ({ optimizer: o });
  assert.equal(resolveEosPredictionHours(undefined), 72);
  assert.equal(resolveEosPredictionHours(c({})), 72);
  assert.equal(resolveEosPredictionHours(c({ eosControlHorizonMaxHours: 6 })), 54);
  assert.equal(resolveEosPredictionHours(c({ eosControlHorizonMaxHours: 12 })), 60);
  assert.equal(resolveEosPredictionHours(c({ eosControlHorizonMaxHours: 24 })), 72);
  assert.equal(resolveEosPredictionHours(c({ eosPredictionHours: 48 })), 48);
  assert.equal(resolveEosPredictionHours(c({ eosPredictionHours: '36' })), 36);
  assert.equal(resolveEosPredictionHours(c({ eosPredictionHours: 500 })), 72);
  assert.equal(resolveEosPredictionHours(c({ eosPredictionHours: -3 })), 72);
  assert.equal(resolveControlHorizonMaxHours(c({})), 48);
  assert.equal(resolveControlHorizonMaxHours(c({ eosControlHorizonMaxHours: 12 })), 12);
  assert.equal(resolveControlHorizonMaxHours(c({ eosControlHorizonMaxHours: '24' })), 24);
  assert.equal(resolveControlHorizonMaxHours(c({ eosPredictionHours: 24 })), 24, 'nie länger als der Prognosehorizont');
  assert.equal(resolveControlHorizonMaxHours(c({ eosControlHorizonMaxHours: 36, eosPredictionHours: 24 })), 24);
});

test('priceFillUntilMs: höchstens bis maxMs (Prognosehorizont)', async () => {
  const { priceFillUntilMs } = await import('../services/optimizer/eos-forecast-bridge.js');
  const now = Date.parse('2026-11-02T09:00:00Z');
  const pv = Array.from({ length: 70 * 4 }, (_, i) => ({ start: new Date(now + i * Q).toISOString(), powerW: 1 }));
  assert.equal(priceFillUntilMs(pv, [], now), now + 70 * 3_600_000);
  assert.equal(priceFillUntilMs(pv, [], now, 48 * 3_600_000), now + 48 * 3_600_000);
});

test('Nachmittags: Steuerzeitraum über 24 h, EOS-Prognosehorizont 72 h', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const { ctx, realEnd } = estimateCtx(mock, { realHours: 34, pvHours: 60 });
    await createEosForecastBridge(ctx).push();
    const hz = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/optimization/genetic/horizon_hours'));
    const expected = Math.floor((realEnd - Date.now() - Q) / 3_600_000);
    assert.ok(expected > 24);
    assert.equal(hz.body, expected);
    const ph = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/prediction/hours'));
    assert.ok(ph, 'prediction/hours gesendet');
    assert.equal(ph.body, 72);
    assert.equal(ctx.state.optimizer.eosPredictionHours, 72);
  } finally { await mock.close(); }
});

test('Grenze 12 h: Steuerzeitraum 12, Prognosehorizont 60, Preise höchstens 60 h', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const { ctx } = estimateCtx(mock, { realHours: 10, pvHours: 70, optimizer: { eosControlHorizonMaxHours: 12 } });
    const t0 = Date.now();
    await createEosForecastBridge(ctx).push();
    const hz = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/optimization/genetic/horizon_hours'));
    assert.ok(hz.body <= 12 && hz.body >= 9);
    const ph = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/prediction/hours'));
    assert.equal(ph.body, 60);
    const elec = seriesOf(mock, 'ElecPriceImport', 'elecprice_marketprice_wh');
    assert.ok(Math.max(...elec.keys()) < t0 + 60 * 3_600_000 + Q, 'Preis-Fortschreibung endet am Prognosehorizont');
    assert.ok(Math.max(...elec.keys()) >= t0 + 59 * 3_600_000);
  } finally { await mock.close(); }
});

test('Prognosehorizont 24 h kappt den Steuerzeitraum; beim Senken erst Steuerzeitraum, dann Prognose', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const opt = {};
    const { ctx } = estimateCtx(mock, { realHours: 34, pvHours: 60, optimizer: opt });
    const bridge = createEosForecastBridge(ctx);
    await bridge.push(); // 72 h / ~33 h
    mock.requests.length = 0;
    opt.eosPredictionHours = 24;
    await bridge.push();
    const puts = mock.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/'));
    const iHz = puts.findIndex((r) => r.url.startsWith('/v1/config/optimization/genetic/horizon_hours'));
    const iPh = puts.findIndex((r) => r.url.startsWith('/v1/config/prediction/hours'));
    assert.equal(puts[iHz].body, 24);
    assert.equal(puts[iPh].body, 24);
    assert.ok(iHz < iPh, 'Steuerzeitraum zuerst senken, sonst kurz Prognose < Steuerzeitraum');
    // wieder hoch: erst Prognose, dann Steuerzeitraum
    mock.requests.length = 0;
    delete opt.eosPredictionHours;
    await bridge.push();
    const up = mock.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/'));
    assert.ok(up.findIndex((r) => r.url.startsWith('/v1/config/prediction/hours')) < up.findIndex((r) => r.url.startsWith('/v1/config/optimization/genetic/horizon_hours')));
  } finally { await mock.close(); }
});

test('Einstellungen: Steuerzeitraum-Grenze und Prognosehorizont mit Rechenzeit-Hinweis', async () => {
  const { getConfigDefinition, normalizeConfigInput } = await import('../config-model.js');
  const fields = getConfigDefinition().fields;
  const ctrl = fields.find((f) => f.path === 'optimizer.eosControlHorizonMaxHours');
  const pred = fields.find((f) => f.path === 'optimizer.eosPredictionHours');
  assert.ok(ctrl && pred, 'beide Felder definiert');
  assert.equal(ctrl.type, 'select');
  assert.deepEqual(ctrl.options.map((o) => o.value), [0, 6, 12, 24]);
  assert.match(ctrl.options[0].label, /ganze[rn]? bekannte[rn]? Preiszeitraum/i);
  assert.match(ctrl.help, /Rechenzeit/);
  assert.equal(pred.type, 'select');
  assert.deepEqual(pred.options.map((o) => o.value), [0, 24, 36, 48, 72]);
  assert.match(pred.help, /Rechenzeit/);
  assert.match(pred.help, /Steuerzeitraum/);
  for (const f of [ctrl, pred]) assert.equal(f.group, 'optimization');
  const ok = normalizeConfigInput({ optimizer: { eosControlHorizonMaxHours: '12', eosPredictionHours: 48 } });
  assert.equal(ok.rawConfig.optimizer.eosControlHorizonMaxHours, 12);
  assert.equal(ok.rawConfig.optimizer.eosPredictionHours, 48);
  const bad = normalizeConfigInput({ optimizer: { eosControlHorizonMaxHours: 7 } });
  assert.equal(bad.rawConfig.optimizer.eosControlHorizonMaxHours, undefined);
});

// Gegenprüfung 63b36983 (P2): push() merkt sich, womit es den Einspeisewert
// tatsächlich gebildet hat — Marktprämie nur, wenn sie > 0 war.
test('push merkt die Grundlage des Einspeisewerts (state.optimizer.eosFeedInBasis)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const { ctx } = estimateCtx(mock, { tariff: { feedInMode: 'spot', feedInSpotFactor: 1, feedInIncludeMarketPremium: true } });
    await createEosForecastBridge(ctx).push();
    // Prämie eingeschaltet, aber ohne anzulegenden Wert → 0 → reine Börse
    assert.equal(ctx.state.optimizer.eosFeedInBasis.feedIn, 'spot');
  } finally { await mock.close(); }
  const mock2 = await createMockEos(okHandler);
  try {
    const { ctx } = estimateCtx(mock2, { tariff: { feedInMode: 'fixed', feedInCtKwh: 8.2 } });
    await createEosForecastBridge(ctx).push();
    assert.deepEqual({ ...ctx.state.optimizer.eosFeedInBasis }, { feedIn: 'fixed', fixedCtKwh: 8.2 });
  } finally { await mock2.close(); }
});
