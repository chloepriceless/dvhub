// test/wallbox-grenze-nur-begrenzen.test.js -- Fable R1 P2-5 (nachgeprüft in R5):
// Eine Grenze (§14a, Netzanschluss) an einer direkt angebundenen Wallbox, die
// DVhub gerade nicht selbst steuert, wird nur als Strom-Obergrenze gesetzt —
// nicht als Ladebefehl. Vorher: go-e/Wattpilot frc=2, OpenEVSE-Claim „active“
// — die Box lud los, auch wenn sie von Hand gestoppt war, und der nächste
// Grenz-Schritt startete sie wieder.
//
// go-e/Wattpilot: nur amp; zurück auf den Strom von vorher (frc bleibt, wie er
// war). OpenEVSE: eigener Claim nur mit max_current (evse_man.cpp: ein Claim
// ohne state setzt keinen Zustand), zurück = Claim löschen. Boxen ohne reine
// Strom-Obergrenze: wie bisher über charge().
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
      requests.push({ method: req.method, url: req.url, body });
      const [status, payload] = handler(req, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)),
  })));
}

describe('Adapter: reine Strom-Obergrenze', () => {
  test('go-e: limit = nur amp, unlimit = amp von vorher, limitState liest amp', async () => {
    const box = { amp: 16, frc: 1 };
    const srv = await mockServer((req) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/set') {
        const out = {};
        for (const [k, v] of u.searchParams) { box[k] = Number(v); out[k] = true; }
        return [200, out];
      }
      return [200, { amp: box.amp, frc: box.frc }];
    });
    try {
      const a = createGoeAdapter(() => ({ url: srv.url }));
      assert.equal((await a.limit(10.7)).ok, true);
      assert.deepEqual(await a.limitState({ limitA: 10 }), { known: true, active: true });
      assert.equal((await a.unlimit({ origCurrentA: 16 })).ok, true);
      assert.deepEqual(await a.limitState({ limitA: 10 }), { known: true, active: false });
      assert.deepEqual(srv.requests.filter((r) => r.url.startsWith('/api/set')).map((r) => r.url), ['/api/set?amp=10', '/api/set?amp=16']);
      assert.equal(box.frc, 1, 'von Hand gestoppt bleibt gestoppt');
    } finally { await srv.close(); }
  });

  test('OpenEVSE: limit = Claim nur mit max_current, unlimit = Claim löschen', async () => {
    const claims = new Map();
    const srv = await mockServer((req, body) => {
      const m = /^\/claims\/(\d+)$/.exec(req.url);
      if (m && req.method === 'POST') { claims.set(m[1], body); return [200, { msg: 'done' }]; }
      if (m && req.method === 'DELETE') return claims.delete(m[1]) ? [200, { msg: 'done' }] : [404, {}];
      if (req.url === '/claims') return [200, [...claims.entries()].map(([client, c]) => ({ client: Number(client), ...c }))];
      return [404, {}];
    });
    try {
      const a = createOpenEvseAdapter(() => ({ url: srv.url }));
      assert.equal((await a.limit(12.4)).ok, true);
      assert.deepEqual(claims.get(String(OPENEVSE_DVHUB_CLIENT)), { max_current: 12, auto_release: false }, 'kein state, kein charge_current');
      assert.deepEqual(await a.limitState({ limitA: 12 }), { known: true, active: true });
      assert.equal((await a.unlimit({ origCurrentA: null })).ok, true);
      assert.equal(claims.size, 0);
      assert.deepEqual(await a.limitState({ limitA: 12 }), { known: true, active: false });
    } finally { await srv.close(); }
  });
});

// go-e-Attrappe mit limit/unlimit; frc und amp wie an der Box.
function goeLike({ capW = 8300, frc = 0, amp = 16, statusOk = true } = {}) {
  const calls = [];
  const box = { frc, amp };
  const ref = { capW, paused: false };
  const adapter = {
    type: 'goe', isConfigured: () => true,
    charge: async (a) => { calls.push(['charge', a]); box.frc = 2; box.amp = Math.floor(a); return { ok: true }; },
    stop: async () => { calls.push(['stop']); box.frc = 1; return { ok: true }; },
    release: async () => { calls.push(['release']); box.frc = 0; return { ok: true }; },
    limit: async (a) => { calls.push(['limit', a]); box.amp = Math.floor(a); return { ok: true }; },
    unlimit: async ({ origCurrentA }) => { calls.push(['unlimit', origCurrentA]); if (origCurrentA != null) box.amp = origCurrentA; return { ok: true }; },
    limitState: async (r) => ({ known: true, active: box.amp === Math.floor(r.limitA) }),
    status: async () => (statusOk ? { ok: true, connected: true, charging: box.frc !== 1, currentA: box.amp, raw: { frc: box.frc, amp: box.amp } } : { ok: false, error: 'timeout' }),
    dvhubState: async (r) => ({ known: true, active: box.frc === 2 && (r.currentAs || []).some((c) => Math.floor(c) === box.amp) }),
  };
  const cfg = { optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000 }, wallbox: { type: 'goe', goe: { url: 'http://192.0.2.30' } } };
  const ownedStore = { value: null };
  const make = () => createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [] }),
    getCharger: () => adapter,
    getGridCapW: () => ref.capW,
    isPaused: () => ref.paused,
    loadOverride: () => null,
    saveOverride: () => {},
    loadOwned: () => ownedStore.value,
    saveOwned: (list) => { ownedStore.value = list ? JSON.parse(JSON.stringify(list)) : null; },
  });
  return { bridge: make(), make, calls, box, ref, ownedStore };
}

describe('Brücke: Grenze an direkter Box nur begrenzen (Fable R1 P2-5)', () => {
  test('Deckel → nur limit, kein Ladebefehl; von Hand gestoppt bleibt gestoppt', async () => {
    const h = goeLike({ frc: 1 });
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['limit', 12]], 'Deckel 8,3 kW → 12 A, nur als Grenze');
    assert.equal(h.box.frc, 1);
    // Nächster Grenz-Schritt (Wächter erzwingt): wieder nur limit.
    await h.bridge.apply();
    assert.ok(!h.calls.some((c) => c[0] === 'charge'), JSON.stringify(h.calls));
  });

  test('Grenze weg → Strom von vorher zurück, frc unberührt', async () => {
    const h = goeLike({ frc: 0, amp: 14 });
    await h.bridge.tick();
    h.ref.capW = null;
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['limit', 12], ['unlimit', 14]]);
    assert.equal(h.box.amp, 14);
    assert.equal(h.ownedStore.value, null, 'kein Datensatz mehr');
    const n = h.calls.length;
    await h.bridge.tick();
    assert.equal(h.calls.length, n, 'danach still');
  });

  test('Deckel unter dem Mindeststrom: wie bisher aus', async () => {
    const h = goeLike({ capW: 3000 });
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['stop']]);
  });

  test('Neustart mit stehender Grenze, danach Grenze weg → Strom von vorher zurück', async () => {
    const h = goeLike({ amp: 16 });
    await h.bridge.tick();
    h.ref.capW = null;
    const again = h.make();
    await again.tick();
    assert.deepEqual(h.calls, [['limit', 12], ['unlimit', 16]]);
  });

  test('Ursprungsstrom unlesbar: zurück auf den Höchststrom der Einstellung', async () => {
    const h = goeLike({ statusOk: false });
    await h.bridge.tick();
    h.ref.capW = null;
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['limit', 12], ['unlimit', 16]]);
  });

  test('Not-Halt: eigene Grenze einmal zurück, nicht stoppen; danach still', async () => {
    const h = goeLike({ frc: 0, amp: 16 });
    await h.bridge.tick();
    h.ref.paused = true;
    const r = await h.bridge.emergencyStop();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(h.calls, [['limit', 12], ['unlimit', 16]]);
    const n = h.calls.length;
    await h.bridge.tick();
    await h.bridge.emergencyStop();
    assert.equal(h.calls.length, n, 'keine weiteren Writes');
  });

  test('Not-Halt: Grenze inzwischen von Hand geändert → nichts senden', async () => {
    const h = goeLike({ frc: 0, amp: 16 });
    await h.bridge.tick();
    h.box.amp = 8; // jemand hat am Gerät umgestellt
    h.ref.paused = true;
    await h.bridge.emergencyStop();
    assert.deepEqual(h.calls, [['limit', 12]]);
  });
});
