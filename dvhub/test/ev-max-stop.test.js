// test/ev-max-stop.test.js -- Max-Ladestand erreicht → DVhub beendet das Laden
// an der Wallbox (Christin 07.11.2026: „Ziel erreicht = Ladung endet“), auch
// wenn ein alter EOS-Plan noch „laden“ sagt. Eine Ladegrenze im Auto kann
// zusätzlich bestehen; DVhub verlässt sich nicht darauf. „Sofort laden“ von
// Hand und der Not-Halt bleiben unberührt.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

const T0 = Date.parse('2026-11-16T22:00:00Z');
const Q = 15 * 60_000;
const cfg = (extra = {}) => ({ evcc: { url: 'http://evcc.local:7070' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3, evStopMode: 'pv', ...extra } });
const solution = (f) => ({ generatedAt: '2026-11-16T21:58:00Z', slotMinutes: 15, rows: f.map((x, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: x, evSocPct: 70 + i })) });

function harness({ maxStop = { maxSocPct: 80, socPct: 72 }, paused = false } = {}) {
  let clock = T0 + 60_000;
  const calls = [];
  const logs = [];
  let stop = maxStop;
  let isPaused = paused;
  let mode = 'pv';
  const fakeEvcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [{ id: 1, mode, connected: true, charging: mode === 'now' }],
    setMaxCurrent: async (lp, a) => { calls.push(['maxcurrent', lp, a]); return { ok: true }; },
    setMode: async (lp, m) => { calls.push(['mode', lp, m]); mode = m; return { ok: true }; },
  };
  const bridge = createEosEvccBridge({
    getCfg: () => cfg(),
    getSolution: async () => solution([1, 1, 1, 1]),
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    getEvMaxStop: () => stop,
    isPaused: () => isPaused,
    pushLog: (event, data) => logs.push({ event, data }),
    now: () => clock,
  });
  return { bridge, calls, logs, setSoc: (p) => { stop = { ...stop, socPct: p }; }, setStop: (s) => { stop = s; }, advance: (ms) => { clock += ms; }, pause: (v) => { isPaused = v; } };
}

describe('Max-Ladestand an der Wallbox', () => {
  test('unter Max: Plan „laden“ wird geladen', async () => {
    const h = harness();
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 1, 'now']);
  });

  test('Max erreicht: Laden endet hart (evcc „aus“, nicht der PV-Modus), Log einmal', async () => {
    const h = harness();
    await h.bridge.tick();
    h.setSoc(80);
    h.advance(60_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 1, 'off']);
    assert.equal(h.logs.filter((l) => l.event === 'ev_max_soc_reached').length, 1);
    const st = h.bridge.getStatus();
    assert.equal(st.maxStop.active, true);
    assert.equal(st.maxStop.maxSocPct, 80);
    // Weiterer Takt: nichts Neues senden.
    const n = h.calls.length;
    h.advance(60_000);
    await h.bridge.tick();
    assert.equal(h.calls.length, n);
  });

  test('kleine Schwankung (79,6 %) lädt nicht wieder an; erst deutlich darunter', async () => {
    const h = harness({ maxStop: { maxSocPct: 80, socPct: 80.2 } });
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 1, 'off']);
    h.setSoc(79.6);
    h.advance(60_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 1, 'off'], 'Haltebereich 1 Punkt');
    h.setSoc(78.5);
    h.advance(60_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 1, 'now']);
  });

  test('ohne Max-Grenze (Vanilla-EOS / Max aus) oder ohne Ladestand: wie bisher', async () => {
    const h = harness({ maxStop: null });
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 1, 'now']);
    const u = harness({ maxStop: { maxSocPct: 80, socPct: null } });
    await u.bridge.tick();
    assert.deepEqual(u.calls.at(-1), ['mode', 1, 'now']);
  });

  test('Not-Halt: auch am Max keine Writes', async () => {
    const h = harness({ maxStop: { maxSocPct: 80, socPct: 85 }, paused: true });
    await h.bridge.tick();
    assert.equal(h.calls.length, 0);
  });

  test('„Sofort laden“ von Hand gewinnt über den Max-Ladestand', async () => {
    const h = harness({ maxStop: { maxSocPct: 80, socPct: 85 } });
    const r = await h.bridge.setOverride({ powerW: 11000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    await h.bridge.tick();
    assert.ok(h.calls.some((c) => c[0] === 'mode' && c[2] === 'now'));
    assert.ok(!h.calls.some((c) => c[0] === 'mode' && c[2] === 'off'), 'kein Stopp gegen die Hand-Ladung');
  });
});
