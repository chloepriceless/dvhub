// test/ev-stop-override.test.js — „Laden stoppen“ für alle Wallboxen (2026-10-15).
//
// Wunsch (Christin): ein Stopp, der für jede angebundene Wallbox gilt. Bisher
// gab es nur „Sofort laden“ (Override mit X kW) und den Lademodus „Aus“ — der
// hält aber nicht gegen den EOS-Plan: steuert EOS die Wallbox, setzt die
// Brücke einen evcc-Modus „off“ beim nächsten Takt auf „now“ zurück.
// Jetzt: Override-Art 'stop' in der Brücke — gilt vor dem EOS-Plan, für evcc
// (Modus off, egal welcher Stopp-Modus eingestellt ist) und direkt angebundene
// Boxen (stop(), nicht release()), übersteht einen Neustart, wirkt auch im
// Not-Halt (Stoppen ist die sichere Richtung), endet per Knopf, Uhrzeit oder
// Abstecken.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEosEvccBridge, normalizeOverride, resolveEvccBridgeConfig } from '../services/optimizer/eos-evcc-bridge.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

const T0 = Date.parse('2026-10-15T10:00:00Z');
const Q = 15 * 60_000;

function cfg(extra = {}, wallboxType = 'evcc') {
  return {
    evcc: { url: 'http://evcc.local:7070' },
    wallbox: { type: wallboxType },
    optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3, evStopMode: 'pv', ...extra },
  };
}

function harness({ config = cfg(), plan = 'charge', mode = 'pv', connected = true, saved = null, direct = false, paused = false } = {}) {
  let clock = T0 + 60_000;
  let lp = { id: 1, mode, connected, charging: false };
  let pausedNow = paused;
  const calls = [];
  const store = { value: saved };
  const fakeEvcc = {
    getStatus: () => ({ url: config.evcc?.url || null }),
    getLoadpoints: () => [lp],
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', id, m]); lp = { ...lp, mode: m }; return { ok: true }; },
  };
  const directBox = {
    type: 'openevse',
    isConfigured: () => true,
    charge: async (a) => { calls.push(['charge', a]); return { ok: true }; },
    stop: async () => { calls.push(['stop']); return { ok: true }; },
    release: async () => { calls.push(['release']); return { ok: true }; },
    status: async () => ({ ok: true, connected: lp.connected, charging: false, powerW: 0 }),
  };
  const factor = plan === 'charge' ? 1 : 0;
  const make = () => createEosEvccBridge({
    getCfg: () => config,
    getSolution: async () => ({ slotMinutes: 15, rows: [0, 1, 2, 3].map((i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: factor })) }),
    getCharger: (c, bc) => (direct ? directBox : createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode)),
    isPaused: () => pausedNow,
    now: () => clock,
    loadOverride: () => store.value,
    saveOverride: (ov) => { store.value = ov ? JSON.parse(JSON.stringify(ov)) : null; },
  });
  return {
    bridge: make(), make, calls, store,
    advance: (ms) => { clock += ms; },
    setLp: (patch) => { lp = { ...lp, ...patch }; },
    mode: () => lp.mode,
    setPaused: (v) => { pausedNow = v; },
  };
}

describe('Ausgangslage (heute)', () => {
  test('evcc-Modus „off“ von Hand hält nicht gegen den EOS-Plan', async () => {
    const h = harness({ plan: 'charge' });
    await h.bridge.tick();
    assert.equal(h.mode(), 'now');
    h.setLp({ mode: 'off' });                 // jemand stellt in evcc „Aus“
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.mode(), 'now', 'die Brücke setzt den Plan wieder durch');
  });
});

describe('Laden stoppen: Eingabe', () => {
  test('ohne Leistung gültig, mit Ende in 48 h-Grenze', () => {
    const bc = resolveEvccBridgeConfig(cfg());
    const n = normalizeOverride({ kind: 'stop' }, bc, T0);
    assert.equal(n.ok, true);
    assert.equal(n.override.kind, 'stop');
    assert.equal(n.override.powerW, 0);
    assert.equal(normalizeOverride({ kind: 'stop', untilMs: T0 - 1 }, bc, T0).ok, false);
    assert.equal(normalizeOverride({ kind: 'blah' }, bc, T0).ok, false);
  });
});

describe('Laden stoppen: evcc', () => {
  test('stoppt gegen einen Lade-Plan mit Modus off — auch bei Stopp-Modus „pv“', async () => {
    const h = harness({ plan: 'charge' });
    const out = await h.bridge.setOverride({ kind: 'stop' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(h.mode(), 'off');
    assert.equal(h.calls.some(([c]) => c === 'maxcurrent'), false, 'kein Ladebefehl');
    // Folgetakte: der Plan will laden, der Stopp gilt.
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.mode(), 'off');
  });

  test('wird evcc umgestellt, setzt der nächste Takt wieder off', async () => {
    const h = harness({ plan: 'charge' });
    await h.bridge.setOverride({ kind: 'stop' });
    h.setLp({ mode: 'now' });
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.mode(), 'off');
  });

  test('Abstecken beendet den Stopp; mit EOS-Weitergabe gilt danach wieder der Plan', async () => {
    const h = harness({ plan: 'charge', connected: true });
    await h.bridge.setOverride({ kind: 'stop' });
    h.setLp({ connected: false });
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.bridge.getOverride(), null);
    assert.equal(h.mode(), 'now', 'EOS-Plan (laden) gilt wieder');
  });

  test('ohne EOS-Weitergabe: Ende stellt den Modus von vorher her', async () => {
    const h = harness({ config: cfg({ evEvccControl: false }), mode: 'minpv' });
    await h.bridge.setOverride({ kind: 'stop' });
    assert.equal(h.mode(), 'off');
    await h.bridge.clearOverride();
    assert.equal(h.mode(), 'minpv');
  });

  test('Ende zur Uhrzeit', async () => {
    const h = harness({ config: cfg({ evEvccControl: false }), mode: 'pv' });
    await h.bridge.setOverride({ kind: 'stop', untilMs: T0 + 60_000 + 30 * 60_000 });
    h.advance(31 * 60_000);
    await h.bridge.tick();
    assert.equal(h.bridge.getOverride(), null);
    assert.equal(h.mode(), 'pv');
  });
});

describe('Laden stoppen: direkt angebundene Wallbox (OpenEVSE/go-e/Wattpilot)', () => {
  test('stop() statt release(), auch bei Stopp-Modus „pv“; Plan „laden“ wird nicht gesendet', async () => {
    const h = harness({ config: cfg({}, 'openevse'), plan: 'charge', direct: true });
    await h.bridge.setOverride({ kind: 'stop' });
    assert.deepEqual(h.calls, [['stop']]);
    h.advance(30_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['stop']], 'unverändert, kein Ladebefehl');
  });

  test('Beenden gibt die Box frei (ohne EOS-Weitergabe)', async () => {
    const h = harness({ config: cfg({ evEvccControl: false }, 'openevse'), direct: true });
    await h.bridge.setOverride({ kind: 'stop' });
    await h.bridge.clearOverride();
    assert.deepEqual(h.calls, [['stop'], ['release']]);
  });
});

describe('Laden stoppen: Not-Halt, Neustart, Wechsel', () => {
  test('wirkt auch im Not-Halt (Stoppen ist die sichere Richtung)', async () => {
    const h = harness({ plan: 'charge', paused: true });
    await h.bridge.setOverride({ kind: 'stop' });
    assert.equal(h.mode(), 'off');
  });

  test('„Sofort laden“ bleibt im Not-Halt eingefroren (unverändert)', async () => {
    const h = harness({ plan: 'charge', paused: true });
    const out = await h.bridge.setOverride({ powerW: 11000 });
    assert.equal(out.result.skipped, 'paused');
    assert.equal(h.calls.length, 0);
  });

  test('übersteht einen Neustart', async () => {
    const h = harness({ plan: 'charge' });
    await h.bridge.setOverride({ kind: 'stop' });
    assert.equal(h.store.value.kind, 'stop');
    const fresh = h.make();
    assert.equal(fresh.getOverride()?.kind, 'stop');
    h.setLp({ mode: 'now' });
    await fresh.tick();
    assert.equal(h.mode(), 'off');
  });

  test('Wechsel von „Sofort laden“ zu „Laden stoppen“', async () => {
    const h = harness({ plan: 'stop' });
    await h.bridge.setOverride({ powerW: 11000 });
    assert.equal(h.mode(), 'now');
    await h.bridge.setOverride({ kind: 'stop' });
    assert.equal(h.mode(), 'off');
    assert.equal(h.bridge.getStatus().override.kind, 'stop');
  });
});

describe('Laden stoppen im Not-Halt: Ende erst nach dem Aufheben', () => {
  test('Beenden per Knopf wird abgelehnt, der Stopp bleibt', async () => {
    const h = harness({ plan: 'charge', paused: true });
    await h.bridge.setOverride({ kind: 'stop' });
    const out = await h.bridge.clearOverride();
    assert.equal(out.ok, false);
    assert.equal(out.error, 'emergency_stop_active');
    assert.equal(h.bridge.getOverride()?.kind, 'stop');
    assert.equal(h.mode(), 'off');
  });

  test('Abstecken im Not-Halt beendet nicht; nach dem Aufheben schon', async () => {
    const h = harness({ plan: 'charge', paused: true, connected: true });
    await h.bridge.setOverride({ kind: 'stop' });
    h.setLp({ connected: false });
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.bridge.getOverride()?.kind, 'stop', 'im Not-Halt gehalten');
    h.setPaused(false);
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.bridge.getOverride(), null, 'nach dem Aufheben beendet');
  });
});
