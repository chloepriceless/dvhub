// test/wallbox-adapters.test.js -- OpenEVSE (Claims-API) + go-e (API v2) gegen
// nachgebaute Wallboxen, dazu die Bruecke mit direkter Wallbox.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createOpenEvseAdapter, createGoeAdapter, OPENEVSE_DVHUB_CLIENT } from '../services/wallbox/adapters.js';
import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';

function mockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization || null });
      const [status, payload] = handler(req, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r))
  })));
}

// OpenEVSE: verlangt Basic Auth wie die echte Box mit gesetztem Passwort.
function openEvseHandler(claims = new Map()) {
  return (req, body) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('admin:geheim').toString('base64')) return [401, {}];
    const m = /^\/claims\/(\d+)$/.exec(req.url);
    if (m && req.method === 'POST') { claims.set(m[1], body); return [200, { msg: 'done' }]; }
    if (m && req.method === 'DELETE') return claims.delete(m[1]) ? [200, { msg: 'done' }] : [404, { msg: 'not found' }];
    if (req.url === '/status') return [200, { status: 'active', state: 3, vehicle: 1, pilot: 10, amp: 9800, power: 6700, battery_level: 64 }];
    return [404, {}];
  };
}

describe('OpenEVSE-Adapter (Claims-API)', () => {
  test('laden / stoppen / freigeben ueber den eigenen Claim, mit Basic Auth', async () => {
    const claims = new Map();
    const box = await mockServer(openEvseHandler(claims));
    try {
      const a = createOpenEvseAdapter(() => ({ url: box.url, username: 'admin', password: 'geheim' }));
      assert.equal((await a.charge(9.7)).ok, true);
      assert.deepEqual(claims.get(String(OPENEVSE_DVHUB_CLIENT)), { state: 'active', charge_current: 9, auto_release: false },
        'ganze Ampere, abgerundet — nie mehr als EOS geplant hat');
      assert.equal((await a.stop()).ok, true);
      assert.equal(claims.get(String(OPENEVSE_DVHUB_CLIENT)).state, 'disabled');
      assert.equal((await a.release()).ok, true);
      assert.equal(claims.size, 0);
      assert.equal((await a.release()).ok, true, 'kein Claim mehr (404) gilt als freigegeben');
      assert.notEqual(OPENEVSE_DVHUB_CLIENT, 0x00040001, 'nicht die Client-ID von evcc');
    } finally { await box.close(); }
  });

  test('falsches Passwort: Fehler statt stiller Erfolg', async () => {
    const box = await mockServer(openEvseHandler());
    try {
      const a = createOpenEvseAdapter(() => ({ url: box.url, username: 'admin', password: 'falsch' }));
      const res = await a.charge(10);
      assert.equal(res.ok, false);
      assert.equal(res.status, 401);
    } finally { await box.close(); }
  });

  test('Status: Fahrzeug, Leistung, Pilotstrom, SoC aus der Box', async () => {
    const box = await mockServer(openEvseHandler());
    try {
      const st = await createOpenEvseAdapter(() => ({ url: box.url, username: 'admin', password: 'geheim' })).status();
      assert.equal(st.connected, true);
      assert.equal(st.charging, true);
      assert.equal(st.powerW, 6700);
      assert.equal(st.currentA, 10);
      assert.equal(st.vehicleSocPct, 64);
    } finally { await box.close(); }
  });
});

describe('go-e-Adapter (API v2)', () => {
  test('laden = amp + frc=2, stoppen = frc=1, freigeben = frc=0', async () => {
    const box = await mockServer((req) => {
      const q = new URL(req.url, 'http://x').searchParams;
      const out = {}; for (const k of q.keys()) out[k] = true;
      return [200, out];
    });
    try {
      const a = createGoeAdapter(() => ({ url: box.url }));
      assert.equal((await a.charge(12.9)).ok, true);
      assert.equal((await a.stop()).ok, true);
      assert.equal((await a.release()).ok, true);
      assert.deepEqual(box.requests.map((r) => r.url), ['/api/set?amp=12&frc=2', '/api/set?frc=1', '/api/set?frc=0']);
    } finally { await box.close(); }
  });

  test('go-e lehnt einen Wert ab: Fehlermeldung kommt durch', async () => {
    const box = await mockServer(() => [200, { amp: 'value out of range', frc: true }]);
    try {
      const res = await createGoeAdapter(() => ({ url: box.url })).charge(40);
      assert.equal(res.ok, false);
      assert.match(res.error, /amp: value out of range/);
    } finally { await box.close(); }
  });

  test('Status: car=2 laedt, Leistung aus nrg[11]', async () => {
    const nrg = Array(16).fill(0); nrg[11] = 7200;
    const box = await mockServer(() => [200, { car: 2, amp: 10, frc: 2, alw: true, nrg, fwv: '60.4' }]);
    try {
      const st = await createGoeAdapter(() => ({ url: box.url })).status();
      assert.equal(st.charging, true);
      assert.equal(st.connected, true);
      assert.equal(st.powerW, 7200);
    } finally { await box.close(); }
  });
});

describe('EOS-Bruecke mit direkter Wallbox', () => {
  const T0 = Date.parse('2026-09-22T10:00:00Z');
  const sol = (factors) => ({ slotMinutes: 15, rows: factors.map((f, i) => ({ ts_utc: new Date(T0 + i * 900_000).toISOString(), evChargeFactor: f })) });

  function setup(type, extraOpt = {}) {
    const calls = [];
    const fake = {
      type, isConfigured: () => true,
      charge: async (a) => { calls.push(['charge', a]); return { ok: true }; },
      stop: async () => { calls.push(['stop']); return { ok: true }; },
      release: async () => { calls.push(['release']); return { ok: true }; },
    };
    let cfg = { wallbox: { type }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000, ...extraOpt } };
    let clock = T0 + 60_000;
    const bridge = createEosEvccBridge({
      getCfg: () => cfg, getSolution: async () => sol([0.5, 0]), getCharger: () => fake, now: () => clock,
    });
    return { bridge, calls, setCfg: (c) => { cfg = c; }, advance: (ms) => { clock += ms; }, cfgOf: () => cfg };
  }

  test('Stopp = Aus: die Box bekommt "nicht laden"', async () => {
    const s = setup('openevse');
    await s.bridge.tick();
    s.advance(900_000);
    await s.bridge.tick();
    assert.deepEqual(s.calls, [['charge', 8], ['stop']]);
  });

  test('Stopp = PV: Vorgabe zuruecknehmen, die Box regelt selbst', async () => {
    const s = setup('goe', { evStopMode: 'pv' });
    await s.bridge.tick();
    s.advance(900_000);
    await s.bridge.tick();
    assert.deepEqual(s.calls.at(-1), ['release']);
  });

  test('Weitergabe abgeschaltet: DVhub nimmt seine Vorgabe zurueck (sonst bliebe ein Claim stehen)', async () => {
    const s = setup('openevse');
    await s.bridge.tick();
    s.setCfg({ ...s.cfgOf(), optimizer: { ...s.cfgOf().optimizer, evEvccControl: false } });
    await s.bridge.tick();
    assert.deepEqual(s.calls, [['charge', 8], ['release']]);
    await s.bridge.tick();
    assert.equal(s.calls.length, 2, 'nur einmal');
  });
});
