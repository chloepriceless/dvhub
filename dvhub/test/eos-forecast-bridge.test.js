// test/eos-forecast-bridge.test.js — Phase 22.1 (2026-05-24).
//
// Pure-function tests for the DVhub→EOS forecast bridge helpers. The HTTP
// push and timer/start orchestration are integration-level concerns covered
// by the live deploy path; here we lock the data-shape contract that EOS'
// PydanticDateTimeDataFrame import expects.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import http from 'node:http';
import { zoneOffsetMs } from '../tz-fast.js';

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
import { eosTargetKey } from '../services/optimizer/eos-adapter.js';

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

test('socForRun: Auto-Ladestand abgerundet, nie aufgerundet (63,9 → 63; Akku weiter gerundet)', async () => {
  const mock = await createMockEos(keysHandler(['date_time', 'battery1-soc-factor', 'ev11-soc-factor']));
  try {
    const state = { victron: { soc: 54.6 }, optimizer: { eos: { supported: true } } };
    const b = createEosForecastBridge(socCtx(mock, { state, teslamate: { batteryLevel: 63.9 } }));
    assert.deepEqual(await b.socForRun(), { soc: { battery1: 55, ev11: 63 } });
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
  // Tagesmuster in Ortszeit wie echte Börsenpreise — die Schätzung rechnet
  // seit der Zeitumstellungs-Korrektur auf Ortszeit (Gesamtprüfung Release 1.0.9).
  const pattern = (ms) => 10 + 8 * Math.sin((((ms + zoneOffsetMs(ms, 'Europe/Berlin')) / Q) % 96 - 30) / 96 * 2 * Math.PI);
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
      optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }, tariff, timezone: 'Europe/Berlin', eosOptimizationIntervalSec: 900, ...optimizer },
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

// Fable R3, P3-2: Merker, seit wann sicher keine Schätzwerte mehr in EOS liegen
// (eos-adapter estimatedPriceCutoffMs). Gesetzt beim ersten Push ohne Schätzung,
// dessen Löschen gelang; nicht bei jedem Push nachgezogen; ein Push mit
// Schätzung löscht ihn.
test('P3-2: eosEstimatesClearedAt — einmal gesetzt ohne Schätzung, gelöscht mit Schätzung', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const { ctx, state } = estimateCtx(mock, { optimizer: { eosStartAfterPreviousRun: true } });
    const bridge = createEosForecastBridge(ctx);
    const before = Date.now();
    await bridge.push();
    assert.equal(state.optimizer.eosPriceEstimate, null, 'eigener Takt: keine Schätzung');
    const first = state.optimizer.eosEstimatesClearedAt;
    assert.ok(Number.isFinite(first) && first >= before, `gesetzt (${first})`);
    await new Promise((r) => setTimeout(r, 5));
    await bridge.push();
    assert.equal(state.optimizer.eosEstimatesClearedAt, first, 'nicht bei jedem Push nachgezogen');
  } finally { await mock.close(); }
  // Codex d81a0ddc (1): Merker weg, BEVOR Schätzwerte EOS erreichen — ein
  // abgebrochener Push darf ihn nicht stehen lassen.
  let markerAtImport;
  let st2;
  const mock2 = await createMockEos((req, res) => {
    if (req.method === 'PUT' && req.url.startsWith('/v1/prediction/import/ElecPriceImport')) markerAtImport = st2?.optimizer?.eosEstimatesClearedAt;
    return okHandler(req, res);
  });
  try {
    const { ctx, state } = estimateCtx(mock2);
    st2 = state;
    state.optimizer.eosEstimatesClearedAt = 123;
    await createEosForecastBridge(ctx).push();
    assert.ok(state.optimizer.eosPriceEstimate, 'DVhub stößt an: mit Schätzung');
    assert.equal(markerAtImport, null, 'schon beim Preis-Import zurückgenommen');
    assert.equal(state.optimizer.eosEstimatesClearedAt, null, 'Schätzwerte in EOS → Merker weg');
  } finally { await mock2.close(); }
  // Codex d81a0ddc (2): Merker gehört zum EOS-Ziel — anderes Ziel → neu ab jetzt.
  const mock3 = await createMockEos(okHandler);
  try {
    const { ctx, state } = estimateCtx(mock3, { optimizer: { eosStartAfterPreviousRun: true } });
    state.optimizer.eosEstimatesClearedAt = 123;
    state.optimizer.eosEstimatesClearedTarget = 'altes-eos';
    const before = Date.now();
    await createEosForecastBridge(ctx).push();
    assert.ok(state.optimizer.eosEstimatesClearedAt >= before, 'nicht der alte Zeitpunkt');
    assert.equal(state.optimizer.eosEstimatesClearedTarget, eosTargetKey(ctx.getCfg()));
  } finally { await mock3.close(); }
});

// E-Auto Max-Ladestand (1.0.10): Preise und PV für die Wertbestimmung reichen
// 7 Tage über die Abfahrt hinaus (bis jetzt + 9,5 Tage), Bezug wie an EOS.
test('Wertgrundlage E-Auto: Bezug wie an EOS, 9,5 Tage geschätzt, PV-Überschuss aus der Prognose', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const { ctx, state, q0, realEnd } = estimateCtx(mock, { optimizer: { eosOptimizeEv: true, evMaxSocPct: 80 } });
    state.optimizer.eos.evSocValue = true;
    await createEosForecastBridge(ctx).push();
    const v = state.optimizer.evValueInputs;
    assert.ok(v, 'Wertgrundlage im Zustand');
    assert.equal(v.baseMs, q0);
    assert.ok(v.untilMs >= Date.now() + 9 * 86_400_000, `reicht bis ${new Date(v.untilMs).toISOString()}`);
    // Fester Tarif 30 ct — auch geschätzt; Einspeisung = Börse.
    assert.equal(v.importCt[0], 30);
    assert.equal(v.importCt[Math.floor((realEnd - q0) / Q) + 400], 30);
    // PV 1000 W − Last 500 W = 125 Wh je Viertelstunde, auch hinter der Prognose (Median).
    assert.equal(v.surplusWh[0], 125);
    assert.equal(v.surplusWh.at(-1), 125);
  } finally { await mock.close(); }
});

test('Wertgrundlage E-Auto: nur mit Max-Ladestand und EOS-Feld', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const { ctx, state } = estimateCtx(mock, { optimizer: { eosOptimizeEv: true, evMaxSocPct: 80 } });
    await createEosForecastBridge(ctx).push();
    assert.equal(state.optimizer.evValueInputs ?? null, null, 'Vanilla-EOS: nichts rechnen');
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
  assert.equal(resolveEosPredictionHours(c({ eosPredictionHours: '60' })), 60);
  assert.equal(resolveEosPredictionHours(c({ eosPredictionHours: 500 })), 72);
  assert.equal(resolveEosPredictionHours(c({ eosPredictionHours: -3 })), 72);
  assert.equal(resolveControlHorizonMaxHours(c({})), 48);
  assert.equal(resolveControlHorizonMaxHours(c({ eosControlHorizonMaxHours: 12 })), 12);
  assert.equal(resolveControlHorizonMaxHours(c({ eosControlHorizonMaxHours: '24' })), 24);
  // Gegenprüfung ae4e76f6 (P2): mindestens 12 h Schwanz hinter dem Steuerzeitraum
  // — sonst bewertet EOS die Restladung nur zum Einspeisewert (Tail-Fix 01.11.).
  assert.equal(resolveControlHorizonMaxHours(c({ eosPredictionHours: 48 })), 36, 'Prognosehorizont − 12 h');
  assert.equal(resolveControlHorizonMaxHours(c({ eosControlHorizonMaxHours: 24, eosPredictionHours: 48 })), 24);
  assert.equal(resolveControlHorizonMaxHours(c({ eosPredictionHours: 24 })), 12, 'auch ein per API gesetzter kurzer Wert behält 12 h Schwanz');
});

// Fernbetrieb: Der Rechendienst nimmt prediction/hours nicht an (Allowlist),
// der EOS-Runner rechnet mit dem EOS-Standard 48 h. DVhub muss damit planen —
// sonst schickt es 48 h Steuerzeitraum und EOS kürzt den Schwanz auf 0
// (Gegenprüfung Release 1.0.9, Verdacht Codex).
test('Fernbetrieb: Prognosehorizont = EOS-Standard des Rechendiensts, Steuerzeitraum behält 12 h Schwanz', async () => {
  const { resolveEosPredictionHours, resolveControlHorizonMaxHours } = await import('../services/optimizer/eos-forecast-bridge.js');
  const { REMOTE_EOS_PREDICTION_HOURS } = await import('../services/optimizer/eos-remote.js');
  assert.equal(REMOTE_EOS_PREDICTION_HOURS, 48);
  const remote = (o = {}) => ({ optimizer: { eosProxy: { enabled: true, mode: 'remote' }, ...o } });
  assert.equal(resolveEosPredictionHours(remote()), 48);
  assert.equal(resolveEosPredictionHours(remote({ eosPredictionHours: 72 })), 48, 'feste Einstellung erreicht den Dienst nicht');
  assert.equal(resolveControlHorizonMaxHours(remote()), 36);
  assert.equal(resolveControlHorizonMaxHours(remote({ eosControlHorizonMaxHours: 24 })), 24);
  // Lokal bzw. Fernbetrieb aus: unverändert.
  assert.equal(resolveEosPredictionHours({ optimizer: { eosProxy: { enabled: false, mode: 'remote' } } }), 72);
  assert.equal(resolveControlHorizonMaxHours({ optimizer: { eosProxy: { enabled: true, mode: 'local' } } }), 48);
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
    // 34 h echte Preise — ohne Grenze wären es 33 h (Gegenprüfung ae4e76f6, P3)
    const { ctx } = estimateCtx(mock, { realHours: 34, pvHours: 70, optimizer: { eosControlHorizonMaxHours: 12 } });
    const t0 = Date.now();
    await createEosForecastBridge(ctx).push();
    const hz = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/optimization/genetic/horizon_hours'));
    assert.equal(hz.body, 12);
    const ph = mock.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/prediction/hours')).pop();
    assert.equal(ph.body, 60, 'Zielwert zuletzt (erster Push: erst 72 h, siehe Neustart-Test)');
    const elec = seriesOf(mock, 'ElecPriceImport', 'elecprice_marketprice_wh');
    assert.ok(Math.max(...elec.keys()) < t0 + 60 * 3_600_000 + Q, 'Preis-Fortschreibung endet am Prognosehorizont');
    assert.ok(Math.max(...elec.keys()) >= t0 + 59 * 3_600_000);
  } finally { await mock.close(); }
});

test('Prognosehorizont 48 h kappt den Steuerzeitraum auf 36 h; beim Senken erst Steuerzeitraum, dann Prognose', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const opt = {};
    const { ctx } = estimateCtx(mock, { realHours: 40, pvHours: 60, optimizer: opt });
    const bridge = createEosForecastBridge(ctx);
    await bridge.push(); // 72 h / 39 h
    mock.requests.length = 0;
    opt.eosPredictionHours = 48;
    await bridge.push();
    const puts = mock.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/'));
    const iHz = puts.findIndex((r) => r.url.startsWith('/v1/config/optimization/genetic/horizon_hours'));
    const iPh = puts.findIndex((r) => r.url.startsWith('/v1/config/prediction/hours'));
    assert.equal(puts[iHz].body, 36);
    assert.equal(puts[iPh].body, 48);
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
  assert.deepEqual(ctrl.options.map((o) => o.value), [0, 'auto', 6, 12, 24]);
  assert.match(ctrl.options[0].label, /ganze[rn]? bekannte[rn]? Preiszeitraum/i);
  assert.match(ctrl.help, /Rechenzeit/);
  assert.equal(pred.type, 'select');
  assert.deepEqual(pred.options.map((o) => o.value), [0, 48, 60, 72]);
  assert.match(pred.help, /Rechenzeit/);
  assert.match(pred.help, /mindestens 12 h/);
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
    const b = ctx.state.optimizer.eosFeedInBasis;
    assert.deepEqual({ feedIn: b.feedIn, fixedCtKwh: b.fixedCtKwh }, { feedIn: 'fixed', fixedCtKwh: 8.2 });
    assert.ok(b.since > 0, 'erster Push: gilt ab Start der Bridge (Gegenprüfung 18f41bac)');
  } finally { await mock2.close(); }
});

// Gegenprüfung d22f5a4d (P3): Marktprämie > 0 → spot_premium.
test('push merkt spot_premium, wenn die Marktprämie > 0 war', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = premiumCtx(mock, { gate: true, overrideAw: 10, mwByYear: { [LAST_YEAR]: 6 } });
    ctx.state.optimizer = {};
    await createEosForecastBridge(ctx).push();
    assert.equal(ctx.state.optimizer.eosFeedInBasis.feedIn, 'spot_premium');
  } finally { await mock.close(); }
});

// Gegenprüfung d22f5a4d (P2): Grundlage wechselt erst mit einem Plan, der nach
// dem Wechsel gerechnet ist; scheitert der Einspeise-PUT, bleibt die alte.
test('Grundlage: Wechsel mit Zeitstempel, nur nach angenommenem Einspeise-PUT', async () => {
  let failFeed = false;
  const mock = await createMockEos((req, res) => {
    if (failFeed && req.url.startsWith('/v1/prediction/import/FeedInTariffImport')) { res.writeHead(500); res.end('{}'); return; }
    okHandler(req, res);
  });
  try {
    const tariff = { feedInMode: 'fixed', feedInCtKwh: 7.78 };
    const { ctx } = estimateCtx(mock, { tariff });
    const bridge = createEosForecastBridge(ctx);
    await bridge.push();
    const since0 = ctx.state.optimizer.eosFeedInBasis.since;
    await bridge.push(); // unverändert: Zeitstempel bleibt
    assert.equal(ctx.state.optimizer.eosFeedInBasis.since, since0);
    tariff.feedInCtKwh = 8.2;
    failFeed = true;
    await bridge.push();
    assert.equal(ctx.state.optimizer.eosFeedInBasis.fixedCtKwh, 7.78, 'PUT gescheitert: alte Grundlage');
    failFeed = false;
    const t0 = Date.now();
    await bridge.push();
    const b = ctx.state.optimizer.eosFeedInBasis;
    assert.equal(b.fixedCtKwh, 8.2);
    assert.ok(b.since >= t0);
    assert.equal(ctx.state.optimizer.eosFeedInBasisPrev.fixedCtKwh, 7.78);
  } finally { await mock.close(); }
});

test('eosPlanFeedInBasis: Grundlage zum Plan passend', async () => {
  const { eosPlanFeedInBasis } = await import('../services/optimizer/eos-forecast-bridge.js');
  const fixedCfg = { optimizer: { tariff: { feedInMode: 'fixed', feedInCtKwh: 8.1 } } };
  // vor dem ersten Push: aus der Einstellung, mit festem Satz (P3)
  assert.deepEqual({ ...eosPlanFeedInBasis({}, fixedCfg, NaN) }, { feedIn: 'fixed', fixedCtKwh: 8.1 });
  assert.deepEqual({ ...eosPlanFeedInBasis(undefined, {}, NaN) }, { feedIn: 'fixed', fixedCtKwh: 7.78 });
  const opt = {
    eosFeedInBasis: { feedIn: 'fixed', fixedCtKwh: 8.2, since: 1000 },
    eosFeedInBasisPrev: { feedIn: 'fixed', fixedCtKwh: 7.78, since: 0 },
  };
  assert.deepEqual({ ...eosPlanFeedInBasis(opt, fixedCfg, 2000, 1) }, { feedIn: 'fixed', fixedCtKwh: 8.2 });
  assert.deepEqual({ ...eosPlanFeedInBasis(opt, fixedCfg, 500, 1) }, { feedIn: 'fixed', fixedCtKwh: 7.78 }, 'Plan älter als der Wechsel');
  assert.deepEqual({ ...eosPlanFeedInBasis(opt, fixedCfg, NaN) }, { feedIn: 'fixed', fixedCtKwh: 8.2 }, 'Planzeit unbekannt');
  assert.equal(eosPlanFeedInBasis({ eosFeedInBasis: opt.eosFeedInBasis }, fixedCfg, 500, 1), null, 'ältere Grundlage unbekannt → kein Zusatz');
  assert.deepEqual({ ...eosPlanFeedInBasis({ eosFeedInBasis: { feedIn: 'spot', since: 0 } }, fixedCfg, 5, 1) }, { feedIn: 'spot' });
});


// Gegenprüfung ae4e76f6 (P3): Scheitert nach dem Steuerzeitraum der
// Prognosehorizont-PUT, muss DVhub trotzdem den an EOS gesendeten
// Steuerzeitraum kennen (Warmstart des Lauf-Anstoßes rechnet damit).
test('Teil-Fehlschlag: gesendeter Steuerzeitraum steht im Zustand', async () => {
  // Nur der Zielwert scheitert (erster Push: erst 72 h, dann Steuerzeitraum,
  // dann 60 h — Neustart-Reihenfolge, Gesamtprüfung Release 1.0.9).
  const failPred = (req, res) => {
    if (req.method === 'PUT' && req.url.startsWith('/v1/config/prediction/hours') && mock.requests.at(-1).body === 60) { res.writeHead(500); res.end('{}'); return; }
    okHandler(req, res);
  };
  const mock = await createMockEos(failPred);
  try {
    const { ctx, realEnd } = estimateCtx(mock, { realHours: 34, pvHours: 60, optimizer: { eosPredictionHours: 60 } });
    ctx.state.optimizer.eosControlHorizonH = 24;
    const res = await createEosForecastBridge(ctx).push();
    const hz = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/optimization/genetic/horizon_hours'));
    assert.equal(hz.body, Math.floor((realEnd - Date.now() - Q) / 3_600_000));
    assert.equal(ctx.state.optimizer.eosControlHorizonH, hz.body);
    assert.ok(res.errors.horizon, 'Fehler gemeldet');
  } finally { await mock.close(); }
});

// Gegenprüfung ae4e76f6 (P3): Nach dem Speichern erst neu rechnen, wenn der
// Abgleich (Push + Config-Sync) durch ist — sonst rechnet der Lauf mit dem
// alten Steuerzeitraum / Akku.
test('requestEosReplanAfterSave wartet auf den Abgleich nach dem Speichern', async () => {
  const { requestEosReplanAfterSave } = await import('../routes-api.js');
  const calls = [];
  let release;
  const ctx = { eosAfterSave: new Promise((r) => { release = r; }), optimizerService: { requestEosReplan: (why) => calls.push(why) } };
  const done = requestEosReplanAfterSave(ctx, 'config');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, []);
  release();
  await done;
  assert.deepEqual(calls, ['config']);
  // ohne laufenden Abgleich sofort; ein fehlgeschlagener Abgleich hält nicht auf
  const ctx2 = { eosAfterSave: Promise.reject(new Error('x')), optimizerService: { requestEosReplan: (why) => calls.push(why) } };
  await requestEosReplanAfterSave(ctx2, 'config');
  await requestEosReplanAfterSave({ optimizerService: { requestEosReplan: (why) => calls.push(why) } }, 'config');
  assert.deepEqual(calls, ['config', 'config', 'config']);
});

test('Speichern: Server merkt den Abgleich, die Route wartet darauf', () => {
  const fsMod = globalThis.process.getBuiltinModule('node:fs');
  const server = fsMod.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /ctx\.eosAfterSave = \(async \(\) => \{/);
  const routes = fsMod.readFileSync(new URL('../routes/config-routes.js', import.meta.url), 'utf8');
  assert.match(routes, /requestEosReplanAfterSave\(ctx, 'config'\)/);
  assert.doesNotMatch(routes, /ctx\.optimizerService\?\.requestEosReplan\?\.\('config'\)/);
});

// Gegenprüfung a25589cc (P3): ein angenommener Steuerzeitraum-Wechsel steht im
// Log, auch wenn danach der Prognosehorizont-PUT scheitert; „previous“ stimmt.
test('Log: Steuerzeitraum-Wechsel trotz gescheitertem Prognosehorizont, mit richtigem Vorwert', async () => {
  let failPred = false;
  const mock = await createMockEos((req, res) => {
    if (failPred && req.url.startsWith('/v1/config/prediction/hours')) { res.writeHead(500); res.end('{}'); return; }
    okHandler(req, res);
  });
  try {
    const opt = {};
    const logs = [];
    const { ctx } = estimateCtx(mock, { realHours: 40, pvHours: 60, optimizer: opt, logs });
    const bridge = createEosForecastBridge(ctx);
    await bridge.push();
    const h1 = logs.filter((l) => l.event === 'eos_control_horizon').pop().data.hours;
    opt.eosPredictionHours = 48; // Steuerzeitraum → 36
    failPred = true;
    await bridge.push();
    const l2 = logs.filter((l) => l.event === 'eos_control_horizon').pop().data;
    assert.equal(l2.hours, 36);
    assert.equal(l2.previous, h1);
    failPred = false;
    await bridge.push();
    const l3 = logs.filter((l) => l.event === 'eos_control_horizon').pop().data;
    assert.equal(l3.predictionHours, 48);
    assert.equal(l3.previous, 36);
  } finally { await mock.close(); }
});

// Gegenprüfung 18f41bac: Grundlage zum Laufbeginn des Plans (generatedAt −
// Laufdauer); Wechsel während des Laufs → unbekannt; die vorige nur, wenn sie
// vor dem Laufbeginn galt; nach dem Start gilt die erste erst ab Start.
test('eosPlanFeedInBasis: Laufbeginn, Wechsel während des Laufs, zwei Wechsel', async () => {
  const { eosPlanFeedInBasis } = await import('../services/optimizer/eos-forecast-bridge.js');
  const A = { feedIn: 'fixed', fixedCtKwh: 7.78, since: 0 };
  const B = { feedIn: 'spot', since: 1000 };
  const C = { feedIn: 'spot_premium', since: 2000 };
  // Plan fertig 1500, Lauf 1000 ms → Start 500 < Wechsel 1000 < Ende: unbekannt
  assert.equal(eosPlanFeedInBasis({ eosFeedInBasis: B, eosFeedInBasisPrev: A }, {}, 1500, 1000), null);
  // Lauf startete nach dem Wechsel
  assert.deepEqual({ ...eosPlanFeedInBasis({ eosFeedInBasis: B, eosFeedInBasisPrev: A }, {}, 2500, 1000) }, { feedIn: 'spot' });
  // zwei Wechsel nach dem Plan: B galt bei Laufbeginn nicht → unbekannt
  assert.equal(eosPlanFeedInBasis({ eosFeedInBasis: C, eosFeedInBasisPrev: B }, {}, 500, 0), null);
  // vorige galt bei Laufbeginn
  assert.deepEqual({ ...eosPlanFeedInBasis({ eosFeedInBasis: C, eosFeedInBasisPrev: B }, {}, 1500, 100) }, { feedIn: 'spot' });
});

test('erster Push nach dem Start: Grundlage gilt erst ab Start der Bridge', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const t0 = Date.now();
    const { ctx } = estimateCtx(mock, { tariff: { feedInMode: 'fixed', feedInCtKwh: 7.78 } });
    await createEosForecastBridge(ctx).push();
    assert.ok(ctx.state.optimizer.eosFeedInBasis.since >= t0);
  } finally { await mock.close(); }
});

test('Lauf-/Geräte-Neuplan nach dem Speichern wartet auf den Abgleich (EV, Geräte)', () => {
  const fsMod = globalThis.process.getBuiltinModule('node:fs');
  const cc = fsMod.readFileSync(new URL('../services/control-commands.js', import.meta.url), 'utf8');
  assert.match(cc, /requestEosReplanAfterSave\(ctx, 'ev_config'\)/);
  const api = fsMod.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');
  const dev = api.slice(api.indexOf("pushLog('schedulable_device_saved'"), api.indexOf('// Phase 21 (2026-05-23): MQTT-hub broker'));
  assert.equal((dev.match(/requestEosReplanAfterSave\(ctx, 'devices'\)/g) || []).length, 2);
  assert.doesNotMatch(dev, /ctx\.eosConfigSync\?\.sync\?\.\(\)/, 'kein zweiter, paralleler Sync');
  assert.doesNotMatch(dev, /requestEosReplan\?\.\('devices'\)/);
});

// Gegenprüfung 27a172cb (P3): Laufdauer unbekannt (EOS rechnet nach eigenem
// Takt, Lauf aus dem alten Prozess) → bis zu 60 min Laufzeit annehmen.
test('eosPlanFeedInBasis: unbekannte Laufdauer → 60 min angenommen', async () => {
  const { eosPlanFeedInBasis } = await import('../services/optimizer/eos-forecast-bridge.js');
  const H = 3_600_000;
  const B = { feedIn: 'spot', since: 10 * H };
  const A = { feedIn: 'fixed', fixedCtKwh: 7.78, since: 1 };
  assert.equal(eosPlanFeedInBasis({ eosFeedInBasis: B, eosFeedInBasisPrev: A }, {}, 10.5 * H, NaN), null);
  assert.equal(eosPlanFeedInBasis({ eosFeedInBasis: B, eosFeedInBasisPrev: A }, {}, 10.5 * H, 0), null);
  assert.deepEqual({ ...eosPlanFeedInBasis({ eosFeedInBasis: B, eosFeedInBasisPrev: A }, {}, 11.5 * H, NaN) }, { feedIn: 'spot' });
});

// Gegenprüfung 8c050aae (P2): EOS speichert Importe nur dazu und löscht nichts.
// Fehlen nach einem Preisausfall die echten Preise für jetzt, lägen sonst die
// früher geschickten Schätzwerte im Steuerzeitraum und EOS plante darauf.
function deletes(mock) {
  return mock.requests
    .filter((r) => r.method === 'DELETE' && r.url.startsWith('/v1/prediction/range'))
    .map((r) => {
      const u = new URL(r.url, 'http://x');
      return { key: u.searchParams.get('key'), start: Date.parse(u.searchParams.get('start_datetime')), end: Date.parse(u.searchParams.get('end_datetime')) };
    });
}

test('Preise auffüllen: nach Preisausfall werden die früher geschickten Schätzwerte in EOS gelöscht', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const logs = [];
    const env = estimateCtx(mock, { logs });
    // Die Bridge hält das Prognose-Objekt fest — die Antwort darüber umschalten.
    const fs0 = env.ctx.forecastService;
    const orig = fs0.buildForecastResponse;
    let override = null;
    fs0.buildForecastResponse = async () => override || orig();
    const bridge = createEosForecastBridge(env.ctx);
    await bridge.push();
    const first = env.state.optimizer.lastEosPush.priceEstimate;
    assert.ok(first && first.estimatedSlots > 0);
    // Jeder Push löscht nur HINTER dem Geschickten, nie im geschickten Bereich.
    for (const d of deletes(mock)) assert.ok(d.start >= Date.parse(first.until), 'solange echte Preise jetzt abdecken, nichts im geschickten Bereich');
    mock.requests.length = 0;
    // Abruf gestört: die Prognose liefert nur noch Preise, die vor jetzt enden.
    const stale = [];
    for (let ms = env.q0 - 26 * 3_600_000; ms < env.q0 - 3_600_000; ms += Q) stale.push({ start: new Date(ms).toISOString(), ctKwh: 10 });
    override = { ...(await orig()), price: { slots: stale } };
    await bridge.push();
    const del = deletes(mock);
    assert.deepEqual(del.map((d) => d.key).sort(), ['elecprice_marketprice_wh', 'feed_in_tariff_wh']);
    for (const d of del) {
      assert.ok(d.start <= Date.parse(first.from), 'ab dem ersten Schätzwert');
      assert.ok(d.end >= Date.parse(first.until), 'bis zum letzten Schätzwert');
    }
    assert.equal(env.state.optimizer.lastEosPush.priceEstimate, null);
    // Gelöscht wird bei jedem Push — ins Log kommen nur Fehler.
    assert.ok(!logs.some((l) => l.event === 'eos_price_estimate_clear_error'));
  } finally { await mock.close(); }
});

test('Preise auffüllen: auch nach DVhub-Neustart — echte Preise decken jetzt nicht ab → Bereich dahinter löschen', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const fc = await env.ctx.forecastService.buildForecastResponse();
    const stale = [];
    for (let ms = env.q0 - 26 * 3_600_000; ms < env.q0 - 3_600_000; ms += Q) stale.push({ start: new Date(ms).toISOString(), ctKwh: 10 });
    env.ctx.forecastService = { buildForecastResponse: async () => ({ ...fc, price: { slots: stale } }) };
    await createEosForecastBridge(env.ctx).push();
    const del = deletes(mock);
    assert.equal(del.length, 2);
    for (const d of del) {
      assert.equal(d.start, env.q0 - 3_600_000, 'ab dem Ende der echten Preise');
      assert.ok(d.end >= Date.now() + 72 * 3_600_000, 'über den ganzen möglichen Schätzbereich');
    }
  } finally { await mock.close(); }
});

// Gegenprüfung 8c050aae (P2): Stundenpreise + 15-min-Schätzungen ergäben eine
// gemischte Kadenz, EOS (bounded_forecast_array) liest dann Lücken.
test('Preise auffüllen: bei Stundenpreisen kommt die Schätzung ebenfalls stündlich', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const H = 3_600_000;
    const h0 = env.q0 - (env.q0 % H);
    const hourly = [];
    for (let ms = h0 - 2 * H; ms < h0 + 10 * H; ms += H) hourly.push({ start: new Date(ms).toISOString(), ctKwh: env.pattern(ms) });
    const fc = await env.ctx.forecastService.buildForecastResponse();
    env.ctx.forecastService = { buildForecastResponse: async () => ({ ...fc, price: { slots: hourly } }) };
    await createEosForecastBridge(env.ctx).push();
    for (const [provider, key] of [['ElecPriceImport', 'elecprice_marketprice_wh'], ['FeedInTariffImport', 'feed_in_tariff_wh']]) {
      const ts = [...seriesOf(mock, provider, key).keys()].sort((a, b) => a - b);
      assert.ok(ts.length > hourly.length, `${provider}: geschätzt wurde`);
      for (let i = 1; i < ts.length; i += 1) assert.equal(ts[i] - ts[i - 1], H, `${provider}: gleichmäßig stündlich`);
    }
    assert.equal(env.state.optimizer.lastEosPush.priceEstimate.from, new Date(h0 + 10 * H).toISOString());
  } finally { await mock.close(); }
});

// Codex-Gegenprüfung Branch (P2): schlägt das Löschen fehl, ist der Push nicht ok
// (sonst gilt die Prognose als zugestellt und der Wiederholversuch entfällt).
test('Preise auffüllen: Löschen fehlgeschlagen → Push nicht ok', async () => {
  const mock = await createMockEos((req, res) => {
    if (req.method === 'DELETE') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"detail":"boom"}'); return; }
    okHandler(req, res);
  });
  try {
    const env = estimateCtx(mock);
    const fc = await env.ctx.forecastService.buildForecastResponse();
    const stale = [];
    for (let ms = env.q0 - 26 * 3_600_000; ms < env.q0 - 3_600_000; ms += Q) stale.push({ start: new Date(ms).toISOString(), ctKwh: 10 });
    env.ctx.forecastService = { buildForecastResponse: async () => ({ ...fc, price: { slots: stale } }) };
    const res = await createEosForecastBridge(env.ctx).push();
    assert.equal(res.ok, false);
    assert.equal(env.state.optimizer.lastEosPush.ok, false);
    assert.match(env.state.optimizer.lastEosPush.error, /priceEstimateClear/);
  } finally { await mock.close(); }
});

// Codex-Gegenprüfung f442800b (P2): zwei Pushes gleichzeitig (Takt + neuer
// Day-Ahead) — ein alter Stand darf nicht nach dem neuen löschen. Pushes laufen
// nacheinander.
test('Preise auffüllen: gleichzeitige Pushes laufen nacheinander', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const bridge = createEosForecastBridge(env.ctx);
    await Promise.all([bridge.push(), bridge.push()]);
    const marks = mock.requests.map((r, i) => ({ i, url: r.url, method: r.method }));
    const pv = marks.filter((m) => m.url.startsWith('/v1/prediction/import/PVForecastImport'));
    const hz = marks.filter((m) => m.url.startsWith('/v1/config/optimization/genetic/horizon_hours'));
    assert.equal(pv.length, 2);
    assert.ok(hz[0].i < pv[1].i, 'der zweite Push beginnt erst nach dem ersten');
  } finally { await mock.close(); }
});

test('Preise auffüllen: echte Preise enden in weniger als 1 h 15 min → keine Schätzung, Rest wird gelöscht', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const fc = await env.ctx.forecastService.buildForecastResponse();
    const shortEnd = env.q0 + 60 * 60_000; // jetzt + höchstens 1 h
    const real = fc.price.slots.filter((s) => Date.parse(s.start) < shortEnd);
    env.ctx.forecastService = { buildForecastResponse: async () => ({ ...fc, price: { slots: real } }) };
    await createEosForecastBridge(env.ctx).push();
    assert.equal(env.state.optimizer.lastEosPush.priceEstimate, null);
    const del = deletes(mock);
    assert.equal(del.length, 2);
    assert.equal(del[0].start, shortEnd);
  } finally { await mock.close(); }
});
// ── Laufstart (Entwurf ab 02.11.2026 abends) ─────────────────────────────────
// Schätzpreise dürfen nie im Steuerzeitraum eines Laufs liegen. Statt einer
// Buchführung über Prozesse und Neustarts hinweg (Gegenprüfungen a6dbbd1d …
// ec268f9f fanden darin immer neue Lücken) pusht der Prozess, der den Lauf
// anstößt, unmittelbar davor frisch (prepareRun): Schätzung nur hinter echten
// Preisen, die jetzt + 1 h 15 min decken; Steuerzeitraum aus den echten Preisen
// mit 15 min Puffer; alles hinter dem Geschickten wird gelöscht. Der Lauf geht
// nur, wenn echte Preise da sind, der Preis-Import ankam und der
// Steuerzeitraum gesetzt ist.
function shortRealEnv(mock) {
  const env = estimateCtx(mock);
  const fc0 = env.ctx.forecastService.buildForecastResponse;
  const realEnd = env.q0 + 90 * 60_000; // jetzt + 75..90 min
  env.ctx.forecastService = {
    buildForecastResponse: async () => {
      const fc = await fc0();
      return { ...fc, price: { slots: fc.price.slots.filter((s) => Date.parse(s.start) < realEnd) } };
    },
  };
  return { ...env, realEnd };
}
const pvImports = (mock) => mock.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/v1/prediction/import/PVForecastImport')).length;
function failingMock(match) {
  const ctl = { fail: false };
  return createMockEos((req, res) => {
    if (ctl.fail && match(req)) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"detail":"boom"}'); return; }
    okHandler(req, res);
  }).then((mock) => Object.assign(mock, { ctl }));
}
const isPut = (provider) => (req) => req.method === 'PUT' && req.url.startsWith(`/v1/prediction/import/${provider}`);

test('Laufstart: vor jedem Lauf frisch pushen — Schätzwerte beginnen hinter dem Steuerzeitraum (auch ab dem nächsten Slot)', async (t) => {
  const base = Math.floor(Date.now() / Q) * Q;
  // Anstöße an verschiedenen Stellen im Slot, auch kurz vor der Grenze.
  for (const off of [0, 7 * 60_000, Q - 1]) {
    t.mock.timers.enable({ apis: ['Date'], now: base + off });
    const mock = await createMockEos(okHandler);
    try {
      const env = estimateCtx(mock);
      const bridge = createEosForecastBridge(env.ctx);
      await bridge.push(); // früherer Push
      t.mock.timers.setTime(Date.now() + 65 * 60_000); // Lauf viel später, ohne Push dazwischen
      const n = pvImports(mock);
      assert.deepEqual(await bridge.prepareRun(), { ok: true, pushed: true });
      assert.equal(pvImports(mock), n + 1, 'frisch gepusht');
      const est = env.state.optimizer.lastEosPush.priceEstimate;
      const h = env.state.optimizer.eosControlHorizonH;
      const latestRunStart = Math.floor(Date.now() / Q) * Q + Q;
      assert.ok(Date.parse(est.from) >= latestRunStart + h * 3_600_000, `off=${off}: Schätzung ab ${est.from}, Zeitraum ${h} h`);
    } finally { await mock.close(); t.mock.timers.reset(); }
  }
});

test('Laufstart: pusht immer, auch direkt nach einem Push', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const bridge = createEosForecastBridge(env.ctx);
    await bridge.push();
    const n = pvImports(mock);
    assert.deepEqual(await bridge.prepareRun(), { ok: true, pushed: true });
    assert.equal(pvImports(mock), n + 1);
  } finally { await mock.close(); }
});

test('Laufstart: echte Preise reichen nicht über jetzt + 1 h 15 min → keine Schätzung, alles dahinter gelöscht; Lauf nur, wenn der Steuerzeitraum hineinpasst', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const mock = await createMockEos(okHandler);
  try {
    const env = shortRealEnv(mock);
    const bridge = createEosForecastBridge(env.ctx);
    await bridge.push();
    assert.ok(env.state.optimizer.lastEosPush.priceEstimate, 'zuerst noch geschätzt');
    t.mock.timers.setTime(Date.now() + 50 * 60_000);
    mock.requests.length = 0;
    // jetzt + 25..40 min echte Preise: Steuerzeitraum auf 1 h geklemmt, reicht
    // darüber hinaus — EOS bräche ab, also kein Lauf.
    const res = await bridge.prepareRun();
    assert.equal(res.ok, false);
    assert.match(res.error, /über die echten Preise/);
    assert.equal(env.state.optimizer.lastEosPush.priceEstimate, null);
    const del = deletes(mock);
    assert.deepEqual(del.map((d) => d.key).sort(), ['elecprice_marketprice_wh', 'feed_in_tariff_wh']);
    for (const d of del) assert.equal(d.start, env.realEnd, 'ab dem Ende der echten Preise');
  } finally { await mock.close(); }
});

test('Jeder Push löscht hinter dem Geschickten (auch nach einem Neustart ohne Gedächtnis)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const first = createEosForecastBridge(env.ctx);
    // derselbe Prozess zweimal, dann ein neuer (Neustart ohne Gedächtnis)
    for (const bridge of [first, first, createEosForecastBridge(env.ctx)]) {
      mock.requests.length = 0;
      await bridge.push();
      const until = Date.parse(env.state.optimizer.lastEosPush.priceEstimate.until);
      const del = deletes(mock);
      assert.equal(del.length, 2);
      for (const d of del) {
        assert.equal(d.start, until, 'nie im geschickten Bereich');
        assert.ok(d.end >= Date.now() + 72 * 3_600_000);
      }
    }
  } finally { await mock.close(); }
});

test('Laufstart: Preis-Import scheitert → kein Lauf (alte Werte könnten im Steuerzeitraum liegen)', async () => {
  for (const provider of ['ElecPriceImport', 'FeedInTariffImport']) {
    const mock = await failingMock(isPut(provider));
    try {
      const env = estimateCtx(mock);
      const bridge = createEosForecastBridge(env.ctx);
      await bridge.push();
      mock.ctl.fail = true;
      const res = await bridge.prepareRun();
      assert.equal(res.ok, false, provider);
      assert.equal(res.pushed, true);
      assert.match(res.error, new RegExp(provider));
    } finally { await mock.close(); }
  }
});

test('Laufstart: Steuerzeitraum lässt sich nicht setzen → kein Lauf', async () => {
  const mock = await failingMock((req) => req.method === 'PUT' && req.url.startsWith('/v1/config/optimization/genetic/horizon_hours'));
  try {
    const env = estimateCtx(mock);
    mock.ctl.fail = true;
    const res = await createEosForecastBridge(env.ctx).prepareRun();
    assert.equal(res.ok, false);
    assert.match(res.error, /Steuerzeitraum/);
  } finally { await mock.close(); }
});

test('Laufstart: Löschen hinter dem Geschickten scheitert → Push nicht ok, Lauf geht (liegt hinter dem Steuerzeitraum)', async () => {
  const mock = await failingMock((req) => req.method === 'DELETE');
  try {
    const env = estimateCtx(mock);
    mock.ctl.fail = true;
    const bridge = createEosForecastBridge(env.ctx);
    assert.deepEqual(await bridge.prepareRun(), { ok: true, pushed: true });
    assert.equal(env.state.optimizer.lastEosPush.ok, false, 'Push nicht ok → Wiederholung');
    assert.match(env.state.optimizer.lastEosPush.error, /priceEstimateClear/);
  } finally { await mock.close(); }
});

test('Laufstart: keine echten Preise (z. B. Neustart im Preisausfall) → nichts löschen, kein Lauf', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    env.ctx.forecastService = { buildForecastResponse: async () => ({ pv: { slots: [] }, load: { slots: [] }, price: { slots: [] } }) };
    const res = await createEosForecastBridge(env.ctx).prepareRun();
    assert.equal(res.ok, false);
    assert.match(res.error, /keine echten Preise/);
    assert.deepEqual(deletes(mock), [], 'EOS hält evtl. noch echte Preise — nicht pauschal löschen');
  } finally { await mock.close(); }
});

test('Laufstart: Push scheitert schon beim Aufbau → Fehler des Pushs, kein Lauf', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    env.ctx.forecastService = { buildForecastResponse: async () => { throw new Error('DB weg'); } };
    const res = await createEosForecastBridge(env.ctx).prepareRun();
    assert.equal(res.ok, false);
    assert.match(res.error, /DB weg/);
  } finally { await mock.close(); }
});

test('Laufstart: wartet auf einen laufenden Push', async () => {
  let releasePut;
  let holdNext = false;
  const mock = await createMockEos((req, res) => {
    if (holdNext && isPut('ElecPriceImport')(req)) {
      holdNext = false;
      releasePut = () => okHandler(req, res);
      return;
    }
    okHandler(req, res);
  });
  try {
    const env = estimateCtx(mock);
    const bridge = createEosForecastBridge(env.ctx);
    holdNext = true;
    let pushDone = false;
    const p = bridge.push().then(() => { pushDone = true; });
    await waitUntil(() => typeof releasePut === 'function');
    let prepDone = false;
    const prep = bridge.prepareRun().then((r) => { prepDone = true; return r; });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(prepDone, false, 'prepareRun wartet auf den laufenden Push');
    releasePut();
    await p;
    assert.ok(pushDone);
    assert.equal((await prep).ok, true);
  } finally { await mock.close(); }
});

// Gegenprüfung a6dbbd1d (P3): Pushes laufen nacheinander. Hängt einer (z. B.
// eine Datenbankabfrage ohne Zeitlimit), warteten alle folgenden — und damit
// auch der Laufstart (prepareRun). Eine Wache gibt die Kette nach einer Frist
// frei; der hängende Push schreibt danach nichts mehr an EOS.
test('Pushes nacheinander: ein hängender Push blockiert die Kette nicht', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const fc0 = env.ctx.forecastService.buildForecastResponse;
    let release;
    let calls = 0;
    env.ctx.forecastService = {
      buildForecastResponse: () => {
        calls += 1;
        if (calls === 1) return new Promise((r) => { release = r; });
        return fc0();
      },
    };
    env.ctx.pushTimeoutMs = 2000; // reicht auch unter Last für den zweiten Lauf; der erste hängt bewusst
    const bridge = createEosForecastBridge(env.ctx);
    const both = Promise.all([bridge.push(), bridge.prepareRun()]);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Kette hängt')), 5_000).unref());
    const [a, b] = await Promise.race([both, timeout]);
    assert.equal(a.ok, false);
    assert.match(String(a.errors.timeout), /2000/);
    assert.deepEqual(b, { ok: true, pushed: true }, 'der Lauf danach wird vorbereitet');
    assert.equal(pvImports(mock), 1);
    // Der hängende Push kommt später doch zurück: er schreibt nichts mehr.
    const n = mock.requests.length;
    release(await fc0());
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mock.requests.length, n, 'der aufgegebene Push schreibt nicht an EOS');
    assert.equal(env.state.optimizer.lastEosPush.ok, true, 'das Ergebnis des neueren Pushs bleibt stehen');
  } finally { await mock.close(); }
});

// Gegenprüfung 16856110 (P3): Rechnet EOS nach eigenem Takt
// (optimizer.eosStartAfterPreviousRun), gibt es keinen Laufstart, vor dem
// DVhub pushen könnte — dann keine Schätzung; früher geschickte werden gelöscht.
test('Preise auffüllen: EOS rechnet nach eigenem Takt → keine Schätzung, alte werden gelöscht', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const cfg0 = env.ctx.getCfg;
    let ownCadence = false;
    env.ctx.getCfg = () => { const c = cfg0(); if (ownCadence) c.optimizer.eosStartAfterPreviousRun = true; return c; };
    const bridge = createEosForecastBridge(env.ctx);
    await bridge.push();
    assert.ok(env.state.optimizer.lastEosPush.priceEstimate);
    ownCadence = true;
    mock.requests.length = 0;
    await bridge.push();
    assert.equal(env.state.optimizer.lastEosPush.priceEstimate, null);
    const del = deletes(mock);
    assert.equal(del.length, 2);
    for (const d of del) assert.equal(d.start, env.realEnd);
  } finally { await mock.close(); }
});

// Gegenprüfung 2ed313de (P3): Ohne erkanntes EOS 0.4 stößt DVhub keine Läufe
// an und setzt keinen Steuerzeitraum — dann keine Schätzung.
test('Preise auffüllen: EOS nicht erkannt → keine Schätzung', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    env.state.optimizer.eos.supported = false;
    await createEosForecastBridge(env.ctx).push();
    assert.equal(env.state.optimizer.lastEosPush.priceEstimate, null);
    const elec = seriesOf(mock, 'ElecPriceImport', 'elecprice_marketprice_wh');
    assert.equal(Math.max(...elec.keys()), env.realEnd - Q);
  } finally { await mock.close(); }
});

// Gegenprüfung 7e99580c (P2): PV nur aus VRM beginnt nach einem Abruf erst zur
// nächsten vollen Stunde. Der Steuerzeitraum wurde dann nicht gesetzt und der
// Lauf fiel aus. Für die Berechnung wird PV wie die Last auf jetzt
// zurückgefüllt (importiert wird nur, was die Prognose liefert).
test('Laufstart: PV beginnt erst zur nächsten Stunde → Steuerzeitraum trotzdem gesetzt, Lauf geht', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const fc0 = env.ctx.forecastService.buildForecastResponse;
    const nextHour = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000;
    env.ctx.forecastService = {
      buildForecastResponse: async () => {
        const fc = await fc0();
        return { ...fc, pv: { slots: fc.pv.slots.filter((s) => Date.parse(s.start) >= nextHour) } };
      },
    };
    assert.deepEqual(await createEosForecastBridge(env.ctx).prepareRun(), { ok: true, pushed: true });
    assert.equal(env.state.optimizer.eosControlHorizonH, Math.floor((env.realEnd - Date.now() - Q) / 3_600_000));
    const pv = seriesOf(mock, 'PVForecastImport', 'pvforecast_ac_power');
    assert.equal(Math.min(...pv.keys()), nextHour, 'PV-Import unverändert');
  } finally { await mock.close(); }
});

// Gegenprüfung 7e99580c (P3): Spät abends ohne Folgetag-Preise ist der
// Steuerzeitraum auf 1 h geklemmt und reicht über die echten Preise hinaus.
// Scheiterte dort das Löschen, plante EOS auf alten Schätzwerten. Der Lauf
// geht nur, wenn der Steuerzeitraum ganz in echten Preisen liegt — wo nicht,
// brach EOS vor der Schätzung ohnehin ab („Missing prices“).
test('Laufstart: Steuerzeitraum reicht über die echten Preise hinaus → kein Lauf, auch wenn das Löschen scheitert', async () => {
  for (const failDeletes of [false, true]) {
    const mock = await failingMock((req) => req.method === 'DELETE');
    try {
      const env = estimateCtx(mock);
      const fc0 = env.ctx.forecastService.buildForecastResponse;
      const realEnd = env.q0 + 45 * 60_000; // jetzt + 30..45 min → 1 h geklemmt
      env.ctx.forecastService = {
        buildForecastResponse: async () => {
          const fc = await fc0();
          return { ...fc, price: { slots: fc.price.slots.filter((s) => Date.parse(s.start) < realEnd) } };
        },
      };
      mock.ctl.fail = failDeletes;
      const res = await createEosForecastBridge(env.ctx).prepareRun();
      assert.equal(res.ok, false, `failDeletes=${failDeletes}`);
      assert.match(res.error, /über die echten Preise/);
    } finally { await mock.close(); }
  }
});

// Gegenprüfung 165fa8be (P3): Eine Lücke in den echten Preisen zählt — der
// Steuerzeitraum muss in der lückenlosen Abdeckung ab jetzt liegen, nicht nur
// vor dem letzten echten Slot (in der Lücke könnten alte Schätzwerte liegen).
test('Laufstart: Lücke in den echten Preisen im Steuerzeitraum → kein Lauf', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const fc0 = env.ctx.forecastService.buildForecastResponse;
    env.ctx.forecastService = {
      buildForecastResponse: async () => {
        const fc = await fc0();
        const gap = (ms) => ms >= env.q0 + 30 * 60_000 && ms < env.q0 + 75 * 60_000;
        return { ...fc, price: { slots: fc.price.slots.filter((s) => !gap(Date.parse(s.start))) } };
      },
    };
    const res = await createEosForecastBridge(env.ctx).prepareRun();
    assert.equal(res.ok, false);
    assert.match(res.error, /über die echten Preise/);
  } finally { await mock.close(); }
});

// Gegenprüfung 165fa8be (P3): EOS rundet den Laufbeginn auf SEINEN Slot ab —
// bei Stunden-Slots auf die volle Stunde. Spät abends ohne Folgetag-Preise
// (echte bis zur nächsten vollen Stunde, 20 min nach der vollen Stunde) passt
// der 1-h-Zeitraum dann noch in die echten Preise.
test('Laufstart: Stunden-Slots — Laufbeginn auf die volle Stunde gerundet', async (t) => {
  const H = 3_600_000;
  const hourStart = Math.floor(Date.now() / H) * H;
  for (const [intervalSec, ok] of [[3600, true], [900, false]]) {
    t.mock.timers.enable({ apis: ['Date'], now: hourStart + 20 * 60_000 });
    const mock = await createMockEos(okHandler);
    try {
      const env = estimateCtx(mock);
      const cfg0 = env.ctx.getCfg;
      env.ctx.getCfg = () => { const c = cfg0(); c.optimizer.eosOptimizationIntervalSec = intervalSec; return c; };
      const fc0 = env.ctx.forecastService.buildForecastResponse;
      env.ctx.forecastService = {
        buildForecastResponse: async () => {
          const fc = await fc0();
          return { ...fc, price: { slots: fc.price.slots.filter((s) => Date.parse(s.start) < hourStart + H) } };
        },
      };
      const res = await createEosForecastBridge(env.ctx).prepareRun();
      assert.equal(res.ok, ok, `interval ${intervalSec}: ${res.error || ''}`);
    } finally { await mock.close(); t.mock.timers.reset(); }
  }
});

// Koordinator 02.11. abends, Punkt 3 (P2 aus der Gegenprüfung c0fdcbef):
// Startet DVhub neu, während der Preisabruf gestört ist, sind keine Preise im
// Speicher — jeder Lauf fiel aus, obwohl EOS noch echte Preise hielt. Jetzt
// nimmt die Bridge dann die gespeicherten echten Preise (price_ct_kwh, nur
// Day-Ahead) aus der Datenbank: sie überschreiben in EOS, was dort liegt, und
// der Lauf geht wie gewohnt, wenn sie den Steuerzeitraum decken.
function storedPrices(env, endMs) {
  const rows = [];
  for (let ms = env.q0 - 20 * 86_400_000; ms < endMs; ms += Q) rows.push({ key: 'price_ct_kwh', ts: new Date(ms).toISOString(), value: env.pattern(ms), resolution: 900 });
  return rows;
}
test('Laufstart: Neustart im Preisausfall → gespeicherte echte Preise aus der Datenbank, Lauf geht', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const fc0 = env.ctx.forecastService.buildForecastResponse;
    env.ctx.forecastService = { buildForecastResponse: async () => ({ ...(await fc0()), price: { slots: [] } }) };
    const rows = storedPrices(env, env.realEnd);
    env.ctx.telemetryStore = { querySeries: async ({ start, end }) => rows.filter((r) => r.ts >= new Date(start).toISOString() && r.ts < new Date(end).toISOString()) };
    assert.deepEqual(await createEosForecastBridge(env.ctx).prepareRun(), { ok: true, pushed: true });
    const elec = seriesOf(mock, 'ElecPriceImport', 'elecprice_marketprice_wh');
    assert.ok(elec.has(env.realEnd - Q), 'echte Preise aus der Datenbank an EOS');
    assert.equal(env.state.optimizer.eosControlHorizonH, Math.floor((env.realEnd - Date.now() - Q) / 3_600_000));
  } finally { await mock.close(); }
});

test('Laufstart: Neustart im Preisausfall, auch die Datenbank deckt jetzt nicht → kein Lauf, nichts gelöscht', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const fc0 = env.ctx.forecastService.buildForecastResponse;
    env.ctx.forecastService = { buildForecastResponse: async () => ({ ...(await fc0()), price: { slots: [] } }) };
    const rows = storedPrices(env, env.q0 - 3_600_000); // nur Vergangenheit
    env.ctx.telemetryStore = { querySeries: async ({ start, end }) => rows.filter((r) => r.ts >= new Date(start).toISOString() && r.ts < new Date(end).toISOString()) };
    const res = await createEosForecastBridge(env.ctx).prepareRun();
    assert.equal(res.ok, false);
    assert.deepEqual(deletes(mock), [], 'nichts gelöscht');
  } finally { await mock.close(); }
});

// Punkt 1 (P3): EOS 0.4 kennt nur 900 und 3600 s (geneticsettings.py,
// v0.4.0rc3). Bei 1800 lehnt EOS ab und behält seinen alten Wert — welchen,
// weiß DVhub nicht: spätester Laufbeginn dann mit 15 min gerechnet.
test('Laufstart: Slot 1800 s (kennt EOS nicht) → vorsichtig mit 15 min gerechnet', async (t) => {
  const H = 3_600_000;
  const hourStart = Math.floor(Date.now() / H) * H;
  t.mock.timers.enable({ apis: ['Date'], now: hourStart + 20 * 60_000 });
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock, { optimizer: { eosOptimizationIntervalSec: 1800 } });
    const fc0 = env.ctx.forecastService.buildForecastResponse;
    env.ctx.forecastService = {
      buildForecastResponse: async () => {
        const fc = await fc0();
        return { ...fc, price: { slots: fc.price.slots.filter((s) => Date.parse(s.start) < hourStart + H) } };
      },
    };
    const res = await createEosForecastBridge(env.ctx).prepareRun();
    assert.equal(res.ok, false, 'EOS könnte um :15 beginnen und bräuchte Preise bis eine Stunde später');
  } finally { await mock.close(); }
});

// Punkt 2 (P3): Bei Stunden-Slots beginnt EOS' Fenster an der vollen Stunde —
// die lückenlose Abdeckung muss dort beginnen, nicht bei „jetzt“.
test('Laufstart: Stunden-Slots — Lücke zwischen voller Stunde und jetzt → kein Lauf', async (t) => {
  const H = 3_600_000;
  const hourStart = Math.floor(Date.now() / H) * H;
  t.mock.timers.enable({ apis: ['Date'], now: hourStart + 20 * 60_000 });
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock, { optimizer: { eosOptimizationIntervalSec: 3600 } });
    const fc0 = env.ctx.forecastService.buildForecastResponse;
    env.ctx.forecastService = {
      buildForecastResponse: async () => {
        const fc = await fc0();
        // Slot ab der vollen Stunde fehlt, ab :15 lückenlos
        return { ...fc, price: { slots: fc.price.slots.filter((s) => { const ms = Date.parse(s.start); return ms < hourStart || ms >= hourStart + Q; }) } };
      },
    };
    const res = await createEosForecastBridge(env.ctx).prepareRun();
    assert.equal(res.ok, false);
    assert.match(res.error, /über die echten Preise/);
  } finally { await mock.close(); }
});

// Punkt 4: Die Sperrmeldung nennt die Reihe, die jetzt nicht abdeckt — nicht
// pauschal „no prices“, wenn PV oder Last fehlen.
test('Laufstart: PV deckt jetzt nicht (nur Vergangenheit) → Meldung nennt PV', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const fc0 = env.ctx.forecastService.buildForecastResponse;
    env.ctx.forecastService = {
      buildForecastResponse: async () => {
        const fc = await fc0();
        const pv = [];
        for (let ms = env.q0 - 5 * 3_600_000; ms < env.q0 - 3_600_000; ms += Q) pv.push({ start: new Date(ms).toISOString(), powerW: 500 });
        return { ...fc, pv: { slots: pv } };
      },
    };
    const res = await createEosForecastBridge(env.ctx).prepareRun();
    assert.equal(res.ok, false);
    assert.match(res.error, /PV/);
    assert.doesNotMatch(res.error, /no prices/);
  } finally { await mock.close(); }
});

// Gegenprüfung 5ba95a7b (P3): Der Rückfall auf gespeicherte Preise ließ
// Stundenpreise weg und ebenso Zeilen mit falschem Stempel (eine Lücke im
// Abruf stempelt alle Zeilen z. B. mit 1800 s). Jetzt zählt der tatsächliche
// Abstand der Zeilen, wie bei realPriceCoverage.
test('Laufstart: gespeicherte Preise stündlich oder falsch gestempelt → trotzdem genutzt', async () => {
  const H = 3_600_000;
  // 5400: erstes Zeilenpaar des Abrufs mit 1,5 h Lücke (Gegenprüfung fac22151)
  for (const [stepMs, stamp] of [[H, 3600], [Q, 1800], [Q, 5400]]) {
    const mock = await createMockEos(okHandler);
    try {
      const env = estimateCtx(mock);
      const fc0 = env.ctx.forecastService.buildForecastResponse;
      env.ctx.forecastService = { buildForecastResponse: async () => ({ ...(await fc0()), price: { slots: [] } }) };
      const h0 = env.q0 - (env.q0 % H);
      const rows = [];
      for (let ms = h0 - 2 * H; ms < h0 + 10 * H; ms += stepMs) rows.push({ key: 'price_ct_kwh', ts: new Date(ms).toISOString(), value: env.pattern(ms), resolution: stamp });
      env.ctx.telemetryStore = { querySeries: async ({ start, end, maxResolution = 900 }) => rows.filter((r) => r.resolution <= maxResolution && r.ts >= new Date(start).toISOString() && r.ts < new Date(end).toISOString()) };
      const res = await createEosForecastBridge(env.ctx).prepareRun();
      assert.deepEqual(res, { ok: true, pushed: true }, `Abstand ${stepMs / 60_000} min, Stempel ${stamp}: ${res.error || ''}`);
      const elec = seriesOf(mock, 'ElecPriceImport', 'elecprice_marketprice_wh');
      const ts = [...elec.keys()].filter((t) => t < h0 + 10 * H).sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i += 1) assert.equal(ts[i] - ts[i - 1], stepMs, 'eine Kadenz');
    } finally { await mock.close(); }
  }
});

// Gegenprüfung Release 1.0.9 (P2): Läuft die Frist eines Pushs während des
// ersten DELETE ab, startet die Kette den nächsten Push. Die Löschschleife
// prüfte job.abandoned nicht: Der aufgegebene Push schickte danach noch das
// zweite DELETE mit seinem alten Zeitraum und löschte die gerade vom neueren
// Push importierten Einspeisepreise. Jetzt prüfen auch die Hilfsfunktionen
// (Löschen, Steuerzeitraum, Ladestand) vor jedem Schreiben.
test('aufgegebener Push: nach dem hängenden DELETE kein weiterer Schreib- oder Löschaufruf', async () => {
  let held = 0;
  let releaseFirst = null;
  const mock = await createMockEos((req, res) => {
    if (req.method === 'DELETE' && held === 0) {
      held += 1;
      releaseFirst = () => okHandler(req, res);
      return;
    }
    okHandler(req, res);
  });
  try {
    const env = estimateCtx(mock);
    env.ctx.pushTimeoutMs = 2000; // reicht auch unter Last für den neueren Push; das DELETE des ersten hängt bewusst
    const bridge = createEosForecastBridge(env.ctx);
    const first = bridge.push();
    const second = bridge.push();
    const a = await first;
    assert.match(String(a.errors.timeout), /2000/, 'erster Push aufgegeben');
    const b = await second;
    assert.equal(b.ok, true, 'neuerer Push vollständig');
    const afterSecond = mock.requests.length;
    const feedInImports = mock.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/v1/prediction/import/FeedInTariffImport')).length;
    assert.equal(feedInImports, 2, 'beide Pushs haben vor dem Löschen importiert');
    // Jetzt kommt das hängende DELETE des aufgegebenen Pushs zurück.
    releaseFirst();
    await new Promise((r) => setTimeout(r, 300));
    const late = mock.requests.slice(afterSecond);
    assert.deepEqual(late.map((r) => `${r.method} ${r.url.split('?')[0]}`), [], 'der aufgegebene Push schreibt und löscht nichts mehr');
    assert.equal(env.state.optimizer.lastEosPush.ok, true, 'das Ergebnis des neueren Pushs bleibt stehen');
  } finally { await mock.close(); }
});

// Gegenprüfung aa0d76e9 (P3): Die Prüfungen in syncControlHorizon und pushSoc
// waren ungetestet, und ein aufgegebener Push schrieb nach einer verspäteten
// Antwort noch DVhubs Zustand (Steuerzeitraum) — über den des neueren Pushs.
const twoBatteries = (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/measurement/keys')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(['battery1-soc-factor', 'battery2-soc-factor']));
    return;
  }
  okHandler(req, res);
};
for (const [name, match, optimizer] of [
  ['Steuerzeitraum-PUT', (r) => r.method === 'PUT' && r.url.startsWith('/v1/config/'), {}],
  // EOS rechnet nach eigenem Takt → DVhub schreibt den Ladestand als Messwert.
  ['Ladestand-PUT', (r) => r.method === 'PUT' && r.url.startsWith('/v1/measurement/value'), { eosStartAfterPreviousRun: true }],
]) {
  test(`aufgegebener Push: hängender ${name} — kein weiterer Aufruf, kein Zustand vom alten Push`, async () => {
    let held = 0;
    let releaseFirst = null;
    const mock = await createMockEos((req, res) => {
      if (match(req) && held === 0) {
        held += 1;
        releaseFirst = () => twoBatteries(req, res);
        return;
      }
      twoBatteries(req, res);
    });
    try {
      const env = estimateCtx(mock, { optimizer });
      env.ctx.pushTimeoutMs = 300;
      const bridge = createEosForecastBridge(env.ctx);
      const first = bridge.push();
      const second = bridge.push();
      assert.match(String((await first).errors.timeout), /300/);
      await second;
      assert.ok(releaseFirst, 'der Aufruf hing');
      const afterSecond = mock.requests.length;
      // Anderen Wert vortäuschen, um ein Überschreiben durch den alten Push zu sehen.
      env.state.optimizer.eosControlHorizonH = 'neu';
      env.state.optimizer.eosPredictionHours = 'neu';
      releaseFirst();
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(mock.requests.slice(afterSecond).map((r) => `${r.method} ${r.url.split('?')[0]}`), []);
      assert.equal(env.state.optimizer.eosControlHorizonH, 'neu', 'der alte Push schreibt keinen Steuerzeitraum mehr');
      assert.equal(env.state.optimizer.eosPredictionHours, 'neu', 'und keinen Prognosehorizont');
    } finally { await mock.close(); }
  });
}

// Gegenprüfung 711646f2 (P3): Der zweite Steuerzeitraum-PUT (Prognosehorizont)
// und die Rückgabe „aufgegeben“ an die Schleife waren ungetestet — ohne sie
// lief die verspätete Antwort in den Fehlerzweig (lastPredictionHours = null,
// logChange) und schrieb ein falsches eos_control_horizon ins Log.
test('aufgegebener Push: hängender Prognosehorizont-PUT — kein Log, kein Zustand, kein weiterer Aufruf', async () => {
  let configPuts = 0;
  let releaseHeld = null;
  const mock = await createMockEos((req, res) => {
    if (req.method === 'PUT' && req.url.startsWith('/v1/config/')) {
      configPuts += 1;
      if (configPuts === 2) { releaseHeld = () => okHandler(req, res); return; }
    }
    okHandler(req, res);
  });
  try {
    const logs = [];
    const env = estimateCtx(mock, { logs });
    env.ctx.pushTimeoutMs = 300;
    const bridge = createEosForecastBridge(env.ctx);
    const first = bridge.push();
    const second = bridge.push();
    assert.match(String((await first).errors.timeout), /300/);
    await second;
    assert.ok(releaseHeld, 'der zweite Config-PUT hing');
    assert.ok(mock.requests.some((r) => r.url.startsWith('/v1/config/prediction/hours')));
    const afterSecond = mock.requests.length;
    const logsBefore = logs.filter((l) => l.event === 'eos_control_horizon').length;
    env.state.optimizer.eosPredictionHours = 'neu';
    releaseHeld();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(mock.requests.slice(afterSecond).map((r) => `${r.method} ${r.url.split('?')[0]}`), []);
    assert.equal(env.state.optimizer.eosPredictionHours, 'neu', 'kein Prognosehorizont vom alten Push');
    assert.equal(logs.filter((l) => l.event === 'eos_control_horizon').length, logsBefore, 'kein Log-Eintrag vom alten Push');
  } finally { await mock.close(); }
});

// ── Gesamtprüfung Release 1.0.9, Befund 9 ──────────────────────────────────────
// Die Preise im Speicher decken jetzt, enden aber früher als die gespeicherten
// echten (epex-fetch.js ersetzt state.epex.data komplett — ein Abruf mit nur
// heute lässt morgen aus dem Speicher fallen). Dann dürfen Schätzwerte die
// echten Preise für morgen in EOS nicht überschreiben (und clearStaleEstimates
// darf sie nicht löschen): die gespeicherten echten Preise reichen weiter.
test('Befund 9: Speicher kürzer als die Datenbank → echte Preise aus der Datenbank, Schätzung erst dahinter', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const logs = [];
    const env = estimateCtx(mock, { logs });
    const storedEnd = env.realEnd + 14 * 3_600_000;
    // Heute steht in der Datenbank ein anderer Wert als im Speicher: der Speicher
    // hat Vorrang (Gegenprüfung 1c7d8b2c, P3).
    const rows = storedPrices(env, env.realEnd).map((r) => (Date.parse(r.ts) >= env.q0 - 3 * 3_600_000 ? { ...r, value: r.value + 40 } : r));
    // Morgen: echter Preis 77 ct, deutlich anders als jede Schätzung.
    for (let ms = env.realEnd; ms < storedEnd; ms += Q) rows.push({ key: 'price_ct_kwh', ts: new Date(ms).toISOString(), value: 77, resolution: 900 });
    env.ctx.telemetryStore = { querySeries: async ({ start, end }) => rows.filter((r) => r.ts >= new Date(start).toISOString() && r.ts < new Date(end).toISOString()) };
    await createEosForecastBridge(env.ctx).push();
    const feed = seriesOf(mock, 'FeedInTariffImport', 'feed_in_tariff_wh');
    const t = env.realEnd + 5 * 3_600_000;
    assert.ok(Math.abs(feed.get(t) * 100_000 - 77) < 0.01, `echter Preis für morgen bleibt: ${feed.get(t) * 100_000}`);
    const est = env.state.optimizer.lastEosPush.priceEstimate;
    assert.equal(est?.from, new Date(storedEnd).toISOString(), 'Schätzung erst hinter den echten Preisen');
    // Gelöscht wird erst hinter dem Geschickten — nie die echten Preise von morgen.
    for (const d of deletes(mock)) assert.ok(d.start >= storedEnd, `Löschfenster beginnt hinter den echten Preisen: ${new Date(d.start).toISOString()}`);
    const today = env.realEnd - 2 * 3_600_000;
    assert.ok(Math.abs(feed.get(today) * 100_000 - env.pattern(today)) < 0.01, 'heute gilt der Speicher');
    assert.equal(logs.find((l) => l.event === 'eos_prices_from_store')?.data?.mode, 'append');
  } finally { await mock.close(); }
});

test('Befund 9: Lücke im Speicher → die Datenbank füllt nur die Lücke, sonst gilt der Speicher (keine doppelten Slots)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const logs = [];
    const env = estimateCtx(mock, { logs });
    const gapAt = env.q0 + 3 * 3_600_000;
    const fc0 = env.ctx.forecastService.buildForecastResponse;
    env.ctx.forecastService = { buildForecastResponse: async () => { const fc = await fc0(); return { ...fc, price: { slots: fc.price.slots.filter((x) => Date.parse(x.start) !== gapAt) } }; } };
    const rows = storedPrices(env, env.realEnd + 14 * 3_600_000).map((r) => (Date.parse(r.ts) >= gapAt ? { ...r, value: 55 } : r));
    env.ctx.telemetryStore = { querySeries: async ({ start, end }) => rows.filter((r) => r.ts >= new Date(start).toISOString() && r.ts < new Date(end).toISOString()) };
    await createEosForecastBridge(env.ctx).push();
    const feed = seriesOf(mock, 'FeedInTariffImport', 'feed_in_tariff_wh');
    assert.ok(Math.abs(feed.get(gapAt) * 100_000 - 55) < 0.01, 'Lücke aus der Datenbank');
    const after = gapAt + 3_600_000;
    assert.ok(Math.abs(feed.get(after) * 100_000 - env.pattern(after)) < 0.01, 'hinter der Lücke wieder der Speicher');
    assert.ok(Math.abs(feed.get(env.realEnd + 3_600_000) * 100_000 - 55) < 0.01, 'hinter dem Speicher die Datenbank');
    assert.ok(Math.abs(feed.get(gapAt - Q) * 100_000 - env.pattern(gapAt - Q)) < 0.01, 'davor der Speicher');
  } finally { await mock.close(); }
});

test('Befund 9: Stundenpreise im Speicher, 15-min-Preise in der Datenbank → ganz aus der Datenbank (keine gemischte Kadenz)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const logs = [];
    const env = estimateCtx(mock, { logs });
    const H = 3_600_000;
    const fc0 = env.ctx.forecastService.buildForecastResponse;
    env.ctx.forecastService = {
      buildForecastResponse: async () => {
        const fc = await fc0();
        return { ...fc, price: { slots: fc.price.slots.filter((x) => Date.parse(x.start) % H === 0 && Date.parse(x.start) + H <= env.realEnd) } };
      },
    };
    const rows = storedPrices(env, env.realEnd + 14 * H);
    env.ctx.telemetryStore = { querySeries: async ({ start, end }) => rows.filter((r) => r.ts >= new Date(start).toISOString() && r.ts < new Date(end).toISOString()) };
    await createEosForecastBridge(env.ctx).push();
    assert.equal(logs.find((l) => l.event === 'eos_prices_from_store')?.data?.mode, 'extend');
    const feed = seriesOf(mock, 'FeedInTariffImport', 'feed_in_tariff_wh');
    assert.ok(feed.has(env.realEnd + 5 * H + Q), '15-min-Raster aus der Datenbank');
  } finally { await mock.close(); }
});

test('Befund 9: hängende Datenbank hält den Push nicht auf — weiter mit den Preisen im Speicher (Gegenprüfung 1c7d8b2c, P3)', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const logs = [];
    const env = estimateCtx(mock, { logs });
    const history = env.ctx.telemetryStore.querySeries;
    env.ctx.telemetryStore = { querySeries: (q) => (q.seriesKeys.length === 1 ? new Promise(() => {}) : history(q)) };
    env.ctx.storedPricesTimeoutMs = 50;
    const res = await createEosForecastBridge(env.ctx).push();
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.ok(logs.some((l) => l.event === 'eos_prices_from_store_error'));
    const feed = seriesOf(mock, 'FeedInTariffImport', 'feed_in_tariff_wh');
    assert.ok(feed.has(env.realEnd - Q), 'Preise aus dem Speicher an EOS');
  } finally { await mock.close(); }
});

// ── Gesamtprüfung Release 1.0.9, Befund 15 ─────────────────────────────────────
// Ein Datenbankfehler (oder eine leere Antwort) beim Laden der Preis-Historie
// blieb 1 h im Zwischenspeicher — so lange bekam EOS keinen geschätzten Schwanz.
test('Befund 15: Datenbankfehler bei der Preis-Historie wird nicht zwischengespeichert', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const history = [];
    for (let ms = env.q0 - 20 * 86_400_000; ms < env.q0; ms += Q) history.push({ key: 'price_ct_kwh', ts: new Date(ms), value: env.pattern(ms), resolution: 900 });
    let fail = true;
    env.ctx.telemetryStore = { querySeries: async () => { if (fail) throw new Error('Verbindung verloren'); return history; } };
    const bridge = createEosForecastBridge(env.ctx);
    await bridge.push();
    assert.equal(env.state.optimizer.lastEosPush.priceEstimate, null, 'ohne Historie keine Schätzung');
    fail = false;
    await bridge.push();
    assert.ok(env.state.optimizer.lastEosPush.priceEstimate?.estimatedSlots > 0, 'nächster Push schätzt wieder');
  } finally { await mock.close(); }
});

test('Befund 15: leere Preis-Historie wird nicht zwischengespeichert', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock);
    const history = [];
    for (let ms = env.q0 - 20 * 86_400_000; ms < env.q0; ms += Q) history.push({ key: 'price_ct_kwh', ts: new Date(ms), value: env.pattern(ms), resolution: 900 });
    let empty = true;
    env.ctx.telemetryStore = { querySeries: async () => (empty ? [] : history) };
    const bridge = createEosForecastBridge(env.ctx);
    await bridge.push();
    assert.equal(env.state.optimizer.lastEosPush.priceEstimate, null);
    empty = false;
    await bridge.push();
    assert.ok(env.state.optimizer.lastEosPush.priceEstimate?.estimatedSlots > 0);
  } finally { await mock.close(); }
});

// ── Gesamtprüfung Release 1.0.9: Horizont-Schreibvorgänge nach einem Neustart ──
// Nach einem DVhub-Neustart ist unbekannt, was EOS hält. Der Stand galt als
// „kürzer werdend“ (erst Steuerzeitraum): hielt EOS noch einen kürzeren
// Prognosehorizont, stand kurz horizon_hours > prediction.hours, und ein Lauf
// genau dann brach ab. Jetzt: erst weit (72 h), dann Steuerzeitraum, dann Ziel.
test('Neustart: erst Prognosehorizont 72 h, dann Steuerzeitraum, dann der Zielwert', async () => {
  let predInEos = 12; // z. B. früher fest 12 h eingestellt
  const violations = [];
  const mock = await createMockEos((req, res) => {
    const body = mock.requests.at(-1).body;
    if (req.method === 'PUT' && req.url.startsWith('/v1/config/prediction/hours')) predInEos = body;
    if (req.method === 'PUT' && req.url.startsWith('/v1/config/optimization/genetic/horizon_hours') && body > predInEos) violations.push(`${body} > ${predInEos}`);
    okHandler(req, res);
  });
  try {
    const { ctx } = estimateCtx(mock, { realHours: 34, pvHours: 60, optimizer: { eosPredictionHours: 48 } });
    await createEosForecastBridge(ctx).push();
    const seq = mock.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/') && /prediction\/hours|horizon_hours/.test(r.url))
      .map((r) => `${r.url.includes('horizon_hours') ? 'H' : 'P'}${r.body}`);
    assert.deepEqual(seq, ['P72', 'H33', 'P48']);
    assert.deepEqual(violations, []);
    assert.equal(ctx.state.optimizer.eosPredictionHours, 48);
  } finally { await mock.close(); }
});

// ── Restbefund 3 (Codex P2, 1.0.10): Wertstufen frisch zum Lauf ─────────────
// Die Wertstufen des Autos (soc_value_steps) hängen an der Wertgrundlage, die
// erst der Push baut. Ein von DVhub angestoßener Lauf rechnete sonst mit den
// Stufen des letzten Fahrzeug-Abgleichs (nach dem Start: ohne Grundlage, also
// leer). Reihenfolge jetzt: Push (Grundlage) → Fahrzeug an EOS → Lauf.
test('Laufstart: nach dem Push das Fahrzeug mit frischen Wertstufen an EOS, erst dann gilt der Lauf als vorbereitet', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock, { optimizer: { eosOptimizeEv: true, evMaxSocPct: 80 } });
    env.state.optimizer.eos.evSocValue = true;
    const seen = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    env.ctx.eosConfigSync = {
      syncEv: async () => {
        seen.push({ inputs: env.state.optimizer.evValueInputs, pv: pvImports(mock) });
        await gate;
        return { ok: true };
      },
    };
    const bridge = createEosForecastBridge(env.ctx);
    let done = false;
    const prep = bridge.prepareRun().then((r) => { done = true; return r; });
    for (let i = 0; i < 200 && !seen.length; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(seen.length, 1, 'Fahrzeug-Abgleich vor dem Lauf');
    assert.ok(seen[0].inputs && seen[0].inputs.builtAt > 0, 'mit der Wertgrundlage dieses Pushs');
    assert.equal(seen[0].pv, 1, 'nach dem Prognose-Push');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(done, false, 'Lauf wartet auf den Abgleich');
    release();
    assert.deepEqual(await prep, { ok: true, pushed: true });
  } finally { await mock.close(); }
});

test('Laufstart: Fahrzeug-Abgleich scheitert → Lauf trotzdem (Akku-Plan), Fehler im Log; ohne E-Auto kein Abgleich', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const logs = [];
    const env = estimateCtx(mock, { logs, optimizer: { eosOptimizeEv: true, evMaxSocPct: 80 } });
    env.state.optimizer.eos.evSocValue = true;
    env.ctx.eosConfigSync = { syncEv: async () => { throw new Error('boom'); } };
    assert.deepEqual(await createEosForecastBridge(env.ctx).prepareRun(), { ok: true, pushed: true });
    assert.ok(logs.some((l) => l.event === 'eos_ev_sync_before_run_error'), JSON.stringify(logs.map((l) => l.event)));
  } finally { await mock.close(); }
  const mock2 = await createMockEos(okHandler);
  try {
    const env = estimateCtx(mock2);
    let n = 0;
    env.ctx.eosConfigSync = { syncEv: async () => { n += 1; return { ok: true }; } };
    assert.deepEqual(await createEosForecastBridge(env.ctx).prepareRun(), { ok: true, pushed: true });
    assert.equal(n, 0);
  } finally { await mock2.close(); }
});
