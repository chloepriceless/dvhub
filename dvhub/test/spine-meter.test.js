// spine-http-Meterzweig — SPiNE EnergyLink One als Netzzähler-Quelle.
// Der Zweig liest GET /rpc/EM.GetStatus über die lokale HTTP-API des Geräts
// (fetchImpl, im Test injiziert) statt über den Modbus/MQTT-Transport der
// Anlage. Fixture = echte EM.GetStatus-Antwort eines EM400 (nur L1 belegt).
// Semantik: EM positiv = Bezug → bei gridPositiveMeans 'feed_in' invertiert.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPoller } from '../polling.js';

// Echte Antwort von EM400-A0000UZU (gekürzt auf die gelesenen Felder).
const EM_FIXTURE = {
  id: 0,
  a_current: 0.018, b_current: 0, c_current: 0, total_current: 0.018,
  a_voltage: 235.775, b_voltage: 0, c_voltage: 0,
  a_act_power: 3.7, b_act_power: 0, c_act_power: 0, total_act_power: 3.7,
  freq: 50.022, pf: 1
};

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

/**
 * Harness wie in poll-backoff.test.js, aber mit spine-http-Meter und einem
 * Modbus-Transport, der bei JEDEM Zugriff wirft — so ist bewiesen, dass der
 * spine-Zweig den Anlagen-Transport nicht benutzt.
 */
function makeSpinePoller({ fetchImpl, gridPositiveMeans = 'feed_in', meter = {} } = {}) {
  const state = {
    meter: {
      ok: false, updatedAt: 0, raw: [],
      grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null
    },
    victron: { errors: {}, updatedAt: 0 },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-08-27', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  const transport = {
    type: 'modbus',
    mbRequest: async () => { throw new Error('transport must not be used for spine meter'); }
  };
  const cfg = {
    pollMs: 500,
    gridPositiveMeans,
    meter: { readType: 'spine-http', host: '192.168.20.137', ...meter },
    points: {},
    epex: { timezone: 'UTC' },
    userEnergyPricing: {},
    dvControl: {}
  };
  const poller = createPoller({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: () => {},
    energyPath: '/tmp/spine-meter-test.json',
    onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
    fetchImpl
  });
  return { state, poller, cfg };
}

function fetchStub(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const hit = Object.keys(routes).find((p) => url.endsWith(p));
    if (!hit) return jsonResponse({}, { ok: false, status: 404 });
    const entry = routes[hit];
    return typeof entry === 'function' ? entry(url, opts) : jsonResponse(entry);
  };
  fn.calls = calls;
  return fn;
}

test('spine-http: EM.GetStatus wird gemappt, feed_in invertiert (Bezug → negativ)', async () => {
  const fetchImpl = fetchStub({ '/rpc/EM.GetStatus': EM_FIXTURE });
  const { state, poller } = makeSpinePoller({ fetchImpl });
  await poller.requestPoll();

  assert.equal(state.meter.ok, true);
  // 3.7 W Bezug, feed_in-Konvention → -4 W (gerundet)
  assert.equal(state.meter.grid_total_w, -4);
  assert.equal(state.meter.grid_l1_w, -4);
  assert.equal(state.meter.grid_l2_w, 0);
  assert.equal(state.meter.grid_l3_w, 0);
  // raw = [total, l1, l2, l3] unskaliert/unsigniert wie geliefert
  assert.deepEqual(state.meter.raw, [3.7, 3.7, 0, 0]);
  assert.equal(state.meter.consecutiveErrors, 0);
  // korrekter Endpoint auf dem konfigurierten Host
  assert.ok(fetchImpl.calls[0].url === 'http://192.168.20.137/rpc/EM.GetStatus');
});

test('spine-http: grid_import-Konvention behält das Vorzeichen (Bezug → positiv)', async () => {
  const fetchImpl = fetchStub({ '/rpc/EM.GetStatus': EM_FIXTURE });
  const { state, poller } = makeSpinePoller({ fetchImpl, gridPositiveMeans: 'grid_import' });
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 4);
  assert.equal(state.meter.grid_l1_w, 4);
});

test('spine-http: Einspeisung (EM negativ) wird unter feed_in positiv', async () => {
  const fx = { ...EM_FIXTURE, total_act_power: -1234.5, a_act_power: -1234.5 };
  const fetchImpl = fetchStub({ '/rpc/EM.GetStatus': fx });
  const { state, poller } = makeSpinePoller({ fetchImpl });
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 1235); // Math.round(1234.5)
  assert.equal(state.meter.grid_l1_w, 1235);
});

test('spine-http: fehlendes/NaN-Total ist ein Lesefehler (Backoff-Pfad, keine stille 0)', async () => {
  const fetchImpl = fetchStub({ '/rpc/EM.GetStatus': { a_act_power: 3.7 } }); // ohne total
  const { state, poller } = makeSpinePoller({ fetchImpl });
  await poller.requestPoll();
  assert.equal(state.meter.ok, false);
  assert.match(state.meter.error, /total power missing\/NaN/);
  assert.equal(state.meter.consecutiveErrors, 1);
});

test('spine-http: HTTP-Fehler der local-api landet im Fehler-/Backoff-Pfad', async () => {
  const fetchImpl = fetchStub({
    '/rpc/EM.GetStatus': () => jsonResponse({}, { ok: false, status: 502 })
  });
  const { state, poller } = makeSpinePoller({ fetchImpl });
  await poller.requestPoll();
  await poller.requestPoll();
  assert.equal(state.meter.ok, false);
  assert.match(state.meter.error, /HTTP 502/);
  assert.equal(state.meter.consecutiveErrors, 2);
});

test('spine-http: baseUrl übersteuert host (Container-Fall http://local-api:80)', async () => {
  const fetchImpl = fetchStub({ '/rpc/EM.GetStatus': EM_FIXTURE });
  const { poller } = makeSpinePoller({
    fetchImpl,
    meter: { baseUrl: 'http://local-api:80/' } // trailing slash wird entfernt
  });
  await poller.requestPoll();
  assert.equal(fetchImpl.calls[0].url, 'http://local-api:80/rpc/EM.GetStatus');
});
