// test/ev-override.test.js -- „Sofort laden“: laden mit X kW, egal was EOS plant.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEosEvccBridge, normalizeOverride, resolveEvccBridgeConfig, minChargeW } from '../services/optimizer/eos-evcc-bridge.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

const T0 = Date.parse('2026-09-27T10:00:00Z');
const Q = 15 * 60_000;

function cfg(extra = {}) {
  return {
    evcc: { url: 'http://evcc.local:7070' },
    optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3, ...extra }
  };
}

function harness({ config = cfg(), solution = 'stop', mode = 'pv', connected = true, saved = null } = {}) {
  let clock = T0 + 60_000;
  let lp = { id: 1, mode, connected, charging: false };
  const calls = [];
  const logs = [];
  const store = { value: saved };
  const fakeEvcc = {
    getStatus: () => ({ url: config.evcc?.url || null }),
    getLoadpoints: () => [lp],
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', id, m]); lp = { ...lp, mode: m }; return { ok: true }; }
  };
  const getSolution = async () => {
    if (solution === 'down') throw new Error('EOS nicht erreichbar');
    return { slotMinutes: 15, rows: [0, 0, 0, 0].map((f, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: f })) };
  };
  const make = () => createEosEvccBridge({
    getCfg: () => config,
    getSolution,
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    pushLog: (event, data) => logs.push({ event, data }),
    now: () => clock,
    loadOverride: () => store.value,
    saveOverride: (ov) => { store.value = ov ? JSON.parse(JSON.stringify(ov)) : null; }
  });
  return {
    bridge: make(), make, calls, logs, store,
    advance: (ms) => { clock += ms; },
    now: () => clock,
    setLp: (patch) => { lp = { ...lp, ...patch }; }
  };
}

describe('ev-override: Eingabe', () => {
  test('Leistung auf Mindest- und Hoechstleistung begrenzt', () => {
    const bc = resolveEvccBridgeConfig(cfg());
    assert.equal(minChargeW(bc), 4140); // 6 A × 230 V × 3
    assert.equal(normalizeOverride({ powerW: 20000 }, bc, T0).override.powerW, 11000);
    assert.equal(normalizeOverride({ powerW: 2000 }, bc, T0).override.powerW, 4140);
    assert.equal(normalizeOverride({ powerW: 2000 }, bc, T0).override.requestedW, 2000);
    assert.equal(normalizeOverride({ powerW: 0 }, bc, T0).ok, false);
    assert.equal(normalizeOverride({ powerW: 5000, untilMs: T0 - 1 }, bc, T0).ok, false);
    assert.equal(normalizeOverride({ powerW: 5000, untilMs: T0 + 49 * 3600_000 }, bc, T0).ok, false);
  });
});

describe('ev-override: Steuern', () => {
  test('laedt sofort, auch wenn EOS nicht erreichbar ist', async () => {
    const h = harness({ solution: 'down' });
    const out = await h.bridge.setOverride({ powerW: 7000 });
    assert.equal(out.ok, true);
    assert.equal(out.result.ok, true);
    assert.deepEqual(h.calls, [['maxcurrent', 1, 10.1], ['mode', 1, 'now']]);
    // Naechster Takt: unveraendert, EOS weiter weg — kein Stopp.
    h.advance(30_000);
    const r = await h.bridge.tick();
    assert.equal(r.unchanged, true);
    assert.equal(h.calls.length, 2);
  });

  test('laedt auch, wenn die EOS-Weitergabe aus ist — Ende stellt den evcc-Modus von vorher her', async () => {
    const h = harness({ config: cfg({ evEvccControl: false }), mode: 'pv' });
    await h.bridge.setOverride({ powerW: 11000 });
    assert.deepEqual(h.calls, [['maxcurrent', 1, 15.9], ['mode', 1, 'now']]);
    await h.bridge.clearOverride();
    assert.deepEqual(h.calls.at(-1), ['mode', 1, 'pv']);
    assert.equal(h.bridge.getOverride(), null);
  });

  test('evcc von aussen umgestellt → naechster Takt setzt wieder „now“', async () => {
    const h = harness();
    await h.bridge.setOverride({ powerW: 11000 });
    h.setLp({ mode: 'off' });
    h.advance(30_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls.slice(-2), [['maxcurrent', 1, 15.9], ['mode', 1, 'now']]);
  });

  test('Ablauf der Zeit → wieder EOS-Plan (hier Stopp)', async () => {
    const h = harness();
    await h.bridge.setOverride({ powerW: 11000, untilMs: h.now() + 3600_000 });
    h.advance(3600_000 + 1000);
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 1, 'off']);
    assert.equal(h.bridge.getOverride(), null);
    assert.equal(h.store.value, null);
    assert.ok(h.logs.some((l) => l.event === 'ev_override_end' && l.data.reason === 'expired'));
  });

  test('Abstecken beendet — aber erst nachdem das Auto angesteckt war', async () => {
    const h = harness({ connected: false });
    await h.bridge.setOverride({ powerW: 11000 });
    h.advance(30_000);
    await h.bridge.tick();
    assert.ok(h.bridge.getOverride(), 'noch nicht angesteckt: Override bleibt');
    h.setLp({ connected: true });
    h.advance(30_000);
    await h.bridge.tick();
    h.setLp({ connected: false });
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.bridge.getOverride(), null);
    assert.ok(h.logs.some((l) => l.event === 'ev_override_end' && l.data.reason === 'unplugged'));
  });

  test('ueberlebt einen Neustart', async () => {
    const h = harness();
    await h.bridge.setOverride({ powerW: 8000 });
    assert.equal(h.store.value.powerW, 8000);
    const restarted = h.make();
    assert.equal(restarted.getOverride().powerW, 8000);
    const before = h.calls.length;
    await restarted.tick();
    assert.deepEqual(h.calls.slice(before), [['maxcurrent', 1, 11.6], ['mode', 1, 'now']]);
  });

  test('Status zeigt Override und Grenzen', async () => {
    const h = harness();
    await h.bridge.setOverride({ powerW: 6000 });
    const st = h.bridge.getStatus();
    assert.equal(st.override.powerW, 6000);
    assert.deepEqual(st.overrideLimits, { minPowerW: 4140, maxPowerW: 11000 });
    assert.equal(st.lastSent.override, true);
  });
});

describe('ev-override: Review-Befunde 27.09.', () => {
  test('evcc stand schon auf „now“ und Weitergabe aus → Ende setzt den Stopp-Modus statt weiterzuladen', async () => {
    const h = harness({ config: cfg({ evEvccControl: false }), mode: 'now' });
    await h.bridge.setOverride({ powerW: 11000 });
    const out = await h.bridge.clearOverride();
    assert.deepEqual(h.calls.at(-1), ['mode', 1, 'off']);
    assert.equal(out.error, null);
  });

  test('Lizenz weg → Override endet, Beenden bleibt moeglich', async () => {
    let pro = true;
    const calls = [];
    let lp = { id: 1, mode: 'pv', connected: true };
    const fakeEvcc = {
      getStatus: () => ({ url: 'http://evcc' }),
      getLoadpoints: () => [lp],
      setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); return { ok: true }; },
      setMode: async (id, m) => { calls.push(['mode', id, m]); lp = { ...lp, mode: m }; return { ok: true }; }
    };
    const bridge = createEosEvccBridge({
      getCfg: () => cfg(),
      getSolution: async () => null,
      getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
      isProActive: () => pro,
      now: () => T0
    });
    await bridge.setOverride({ powerW: 11000 });
    pro = false;
    await bridge.tick();
    assert.equal(bridge.getOverride(), null);
    assert.deepEqual(calls.at(-1), ['mode', 1, 'pv'], 'zurueck auf den Modus von vorher');
  });

  test('Beenden waehrend eines laufenden Takts wartet ihn ab (kein Absturz, kein Nachladen)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    let lp = { id: 1, mode: 'pv', connected: true };
    let slow = false;
    const fakeEvcc = {
      getStatus: () => ({ url: 'http://evcc' }),
      getLoadpoints: () => [lp],
      setMaxCurrent: async (id, a) => { if (slow) await gate; calls.push(['maxcurrent', id, a]); return { ok: true }; },
      setMode: async (id, m) => { calls.push(['mode', id, m]); lp = { ...lp, mode: m }; return { ok: true }; }
    };
    const bridge = createEosEvccBridge({
      getCfg: () => cfg({ evEvccControl: false }),
      getSolution: async () => null,
      getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
      now: () => T0
    });
    await bridge.setOverride({ powerW: 11000 });
    slow = true;
    const t = bridge.apply();          // haengt im Schreiben
    const c = bridge.clearOverride();  // Knopf „Beenden“ gleichzeitig
    release();
    const [tr, cr] = await Promise.all([t, c]);
    assert.equal(tr.ok, true);
    assert.equal(cr.ok, true);
    assert.equal(bridge.getOverride(), null);
    assert.deepEqual(calls.at(-1), ['mode', 1, 'pv'], 'am Ende steht der alte Modus, nicht „now“');
  });

  test('Mindeststrom ueber Hoechstleistung → Grenzen und Override passen zur Wirklichkeit', () => {
    const bc = resolveEvccBridgeConfig(cfg({ evMinCurrentA: 32, evMaxChargeW: 5000 }));
    const ov = normalizeOverride({ powerW: 5000 }, bc, T0).override;
    assert.equal(ov.powerW, 22080);
  });

  test('Beenden meldet einen Wallbox-Fehler', async () => {
    const fakeEvcc = {
      getStatus: () => ({ url: 'http://evcc' }),
      getLoadpoints: () => [{ id: 1, mode: 'pv', connected: true }],
      setMaxCurrent: async () => ({ ok: true }),
      setMode: async (id, m) => (m === 'now' ? { ok: true } : { ok: false, error: 'HTTP 500' })
    };
    const bridge = createEosEvccBridge({
      getCfg: () => cfg({ evEvccControl: false }),
      getSolution: async () => null,
      getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
      now: () => T0
    });
    await bridge.setOverride({ powerW: 11000 });
    const out = await bridge.clearOverride();
    assert.equal(out.error, 'HTTP 500');
  });
});

describe('ev-override: Not-Halt', () => {
  test('friert ein: kein Befehl, Override bleibt und greift nach dem Aufheben', async () => {
    let paused = true;
    const calls = [];
    const fakeEvcc = {
      getStatus: () => ({ url: 'http://evcc' }),
      getLoadpoints: () => [{ id: 1, mode: 'pv', connected: true }],
      setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); return { ok: true }; },
      setMode: async (id, m) => { calls.push(['mode', id, m]); return { ok: true }; }
    };
    const bridge = createEosEvccBridge({
      getCfg: () => cfg(),
      getSolution: async () => null,
      getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
      isPaused: () => paused,
      now: () => T0
    });
    const out = await bridge.setOverride({ powerW: 11000 });
    assert.equal(out.result.skipped, 'paused');
    assert.equal(calls.length, 0);
    assert.ok(bridge.getOverride());
    paused = false;
    await bridge.tick();
    assert.deepEqual(calls, [['maxcurrent', 1, 15.9], ['mode', 1, 'now']]);
  });
});
