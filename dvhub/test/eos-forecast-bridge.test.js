// test/eos-forecast-bridge.test.js — Phase 22.1 (2026-05-24).
//
// Pure-function tests for the DVhub→EOS forecast bridge helpers. The HTTP
// push and timer/start orchestration are integration-level concerns covered
// by the live deploy path; here we lock the data-shape contract that EOS'
// PydanticDateTimeDataFrame import expects.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import http from 'node:http';

import {
  slotsToTimeMap,
  expandHourlyToQuarterHourly,
  priceSlotsToEosFormat,
  buildDataFrameBody,
  createEosForecastBridge,
  SOC_KEY_RE,
  EV_SOC_KEY_RE,
} from '../services/optimizer/eos-forecast-bridge.js';

/**
 * Minimal mock EOS server. Captures { method, url } per request and lets the
 * handler reply. Body is parsed as JSON only when present (the SoC measurement
 * PUT carries everything on the query string with no body).
 */
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
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: { soc: 16 } }, // 16% → factor 0.16, no EV SoC
    };
    const bridge = createEosForecastBridge(ctx);
    const res = await bridge.push();

    const socPuts = mock.requests.filter(
      (r) => r.method === 'PUT' && r.url.startsWith('/v1/measurement/value'),
    );
    // battery pushed, EV skipped (no evSocPct)
    assert.equal(socPuts.length, 1);
    assert.match(socPuts[0].url, /key=battery1-soc-factor/);
    assert.match(socPuts[0].url, /value=0\.16(&|$)/);
    // SoC must be stamped at the top of an hour (EOS seeds at ems.start_datetime
    // = HH:00); a minute/second-precise "now" would be missed → SoC defaults 0.
    const dtMatch = decodeURIComponent(socPuts[0].url).match(/datetime=([^&]+)/);
    assert.ok(dtMatch, 'datetime present');
    assert.match(dtMatch[1], /T\d\d:00:00Z$/, 'datetime floored to top of hour');
    assert.ok(res.pushed.some((p) => p.startsWith('battery1-soc-factor=0.16')));
  } finally {
    await mock.close();
  }
});

test('push forwards EV SoC when state provides evSocPct', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: { soc: 50, evSocPct: 80 } },
    };
    const bridge = createEosForecastBridge(ctx);
    await bridge.push();

    const socPuts = mock.requests.filter(
      (r) => r.method === 'PUT' && r.url.startsWith('/v1/measurement/value'),
    );
    assert.equal(socPuts.length, 2);
    assert.ok(socPuts.some((r) => /key=battery1-soc-factor/.test(r.url) && /value=0\.5(&|$)/.test(r.url)));
    assert.ok(socPuts.some((r) => /key=ev11-soc-factor/.test(r.url) && /value=0\.8(&|$)/.test(r.url)));
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

test('push does NOT send FeedInTariffImport in fixed mode', async () => {
  const mock = await createMockEos(okHandler);
  try {
    const ctx = {
      getCfg: () => ({ optimizer: { eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }, tariff: { feedInMode: 'fixed' } } }),
      pushLog: () => {},
      forecastService: { buildForecastResponse: async () => forecastSlots() },
      state: { victron: { soc: 50 } },
    };
    const bridge = createEosForecastBridge(ctx);
    await bridge.push();
    const feedReq = mock.requests.find((r) => r.method === 'PUT' && r.url.startsWith('/v1/prediction/import/FeedInTariffImport'));
    assert.ok(!feedReq, 'no FeedInTariffImport in fixed mode');
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
