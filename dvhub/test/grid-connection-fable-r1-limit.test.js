// test/grid-connection-fable-r1-limit.test.js — Befunde der unabhängigen
// Fable-Prüfung R1 (Release-Kandidat 1.0.10) zur wirksamen Grenze:
//   P1-3  ein Lesefehler von Reg. 2714 hebt die Victron-Grenze nicht auf
//   P2-3  Victron knapp unter der DVhub-Grenze lockert das Ziel nicht
//   P2-4  Spannungsschwankung verschiebt die Grenze nicht bei jedem Takt
//   R3 P2-2  der Wert für EOS bleibt dabei stabil (kein PUT je Abgleich)
//   R3 P3-3  der EOS-Behelf zieht das E-Auto nur ab, wenn EOS es plant
//   P3-3  Kacheltext bei Victron-Lesefehler, P3-5 Victron-Wert unter 6 A
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveGridConnection, victronLimitExtra, gridConnectionFromState, createGridConnectionGuard,
  eosGridImportLimitW, eosGridChargeCapW, VICTRON_LIMIT_MAX_AGE_MS
} from '../services/grid-connection/index.js';
import { buildEosInverters } from '../services/optimizer/eos-config-sync.js';

const NOW = 1_800_000_000_000;
const LICENSED = { allowGridCharge: true, mispel: { mode: 'pauschal' } };

const victronState = (a, { at = NOW, error = null, gv = null } = {}) => ({
  meter: { ok: true, updatedAt: NOW, grid_total_w: -5000 },
  victron: { acInputLimitA: a, fieldUpdatedAt: { acInputLimitA: at }, errors: error ? { acInputLimitA: error } : {}, ...(gv ? { gridVoltage: gv } : {}) },
  schedule: {}, ctrl: {}
});

// --- P1-3 ------------------------------------------------------------------------

test('P1-3: Lesefehler von 2714 — der letzte gültige Wert gilt bis zu seinem Höchstalter weiter', () => {
  const state = victronState(40, { at: NOW - 70_000, error: 'modbus timeout' });
  const x = victronLimitExtra(state, NOW, { manufacturer: 'victron' });
  assert.equal(x.victronPhaseLimitA, 40, 'Wert der letzten Lesung gilt');
  assert.equal(x.victronReadError, true, 'Fehler wird trotzdem gemeldet');
  const r = gridConnectionFromState({ gridConnection: { limitKw: 34.5 } }, state, NOW);
  assert.equal(r.limitW, 27600, 'Ziel springt nicht auf die DVhub-Grenze');
  assert.equal(r.targetW, 27600);
  const only = gridConnectionFromState({}, state, NOW);
  assert.equal(only.active, true, 'nur Victron-Grenze: bleibt aktiv');
});

test('P1-3: nach dem Höchstalter fällt die Grenze auf die DVhub-Einstellung zurück, nie auf „keine“', () => {
  const state = victronState(40, { at: NOW - VICTRON_LIMIT_MAX_AGE_MS - 1000, error: 'modbus timeout' });
  const r = gridConnectionFromState({ gridConnection: { limitKw: 34.5 } }, state, NOW);
  assert.equal(r.active, true);
  assert.equal(r.limitW, 34500);
  assert.equal(r.limitSource, 'dvhub');
});

test('P1-3: Wächter löst die Deckel bei einem Lesefehler nicht', () => {
  let t = NOW;
  const state = victronState(40, { at: t });
  state.meter.grid_total_w = -30000; // 30 kW Bezug
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, wallbox: { type: 'evcc' }, optimizer: { evEvccLoadpoint: 1, evMaxChargeW: 11000 } };
  const lp = { id: 1, mode: 'pv', charging: true, connected: true, chargePowerW: 11000, minCurrentA: 6, maxCurrentA: 16, phasesActive: 3 };
  const ctx = {
    getCfg: () => cfg, state, pushLog: () => {},
    evccIntegration: { getStatus: () => ({ url: cfg.evcc.url, lastPolledAt: t, lastError: null, loadpoints: [lp] }) },
    eosEvccBridge: { apply: async () => ({}), getOverride: () => null, hasPendingRestore: () => false },
  };
  const guard = createGridConnectionGuard(ctx, { now: () => t });
  guard.tick();
  guard.tick();
  const cap = guard.capW('wallbox');
  assert.ok(cap != null && cap < 11000, `Wallbox gedeckelt (${cap})`);
  // Eine Lesung scheitert (der Poller lässt Wert und Zeitstempel stehen).
  t += 60_000;
  state.meter.updatedAt = t;
  lp.chargePowerW = cap;
  state.meter.grid_total_w = -27000;
  state.victron.errors.acInputLimitA = 'modbus timeout';
  guard.tick();
  assert.equal(guard.summary().active, true);
  assert.equal(guard.summary().limitW, 27600);
  assert.equal(guard.capW('wallbox'), cap, 'Deckel bleibt');
  assert.ok(guard.batteryCeilingW() != null && guard.batteryCeilingW() <= 27600, 'Sollwert-Decke bleibt');
});

test('P3-3: nur Victron-Grenze, veraltet nach Lesefehlern → Kachel sagt „nicht lesbar“, nicht „ungültig“', () => {
  const state = victronState(40, { at: NOW - VICTRON_LIMIT_MAX_AGE_MS - 1000, error: 'modbus timeout' });
  const guard = createGridConnectionGuard({ getCfg: () => ({}), state, pushLog: () => {} }, { now: () => NOW });
  guard.tick();
  const s = guard.summary();
  assert.equal(s.active, false);
  assert.match(s.text, /Victron-Grenze \(Reg\. 2714\) nicht lesbar/);
  assert.doesNotMatch(s.text, /ungültig/);
});

test('P3-5: Victron-Wert unter 6 A gilt nicht, wird aber gemeldet', () => {
  const logs = [];
  const state = victronState(4);
  const guard = createGridConnectionGuard({ getCfg: () => ({ gridConnection: { limitKw: 29 } }), state, pushLog: (type, data) => logs.push({ type, data }) }, { now: () => NOW });
  guard.tick();
  guard.tick();
  assert.equal(guard.summary().limitW, 29000);
  const hits = logs.filter((l) => l.type === 'grid_connection_victron_ignored');
  assert.equal(hits.length, 1, 'einmal gemeldet');
  assert.equal(hits[0].data.valueA, 4);
});

// --- P2-3 ------------------------------------------------------------------------

test('P2-3: Victron 42 A knapp unter DVhub 29 kW → Ziel bleibt DVhubs 28 000 W (nicht 28 980 W)', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 29 } }, { victronPhaseLimitA: 42 });
  assert.equal(r.limitW, 28900, 'strengere Grenze ist die von Victron (auf 100 W abgerundet)');
  assert.equal(r.targetW, 28000, 'Ziel = min(Victron ohne Abzug, DVhub − Abstand)');
  assert.equal(r.marginW, 900);
  assert.equal(r.marginText, null, 'kein „kein Abstand“, wenn DVhubs Ziel gilt');
});

test('P2-3: Victron deutlich strenger → Victron ohne Abzug, wie bisher', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 29 } }, { victronPhaseLimitA: 40 });
  assert.equal(r.targetW, 27600);
  assert.equal(r.marginW, 0);
  assert.equal(r.marginText, 'kein Abstand (Victron-Grenze)');
});

test('P2-3 je Phase: Victron 39 A knapp unter DVhub 40 A → DVhubs Phasenziel (8 867 W) gilt', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 40 } }, { victronPhaseLimitA: 39 });
  assert.equal(r.phaseLimitW, 8970, 'härtere Phasengrenze von Victron');
  assert.equal(r.phaseTargetW, 8867, 'nicht 8 970');
  const v = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 40 } }, { victronPhaseLimitA: 35 });
  assert.equal(v.phaseTargetW, 8050, 'Victron deutlich strenger: ohne Abzug');
});

// --- P2-4 und R3 P2-2 ------------------------------------------------------------

test('P2-4: 40 A bei schwankender Spannung → Grenze auf 100 W, folgt nicht jeder Schwankung', () => {
  const state = victronState(40);
  const seen = new Set();
  const volts = [230.4, 230.1, 229.8, 230.1, 230.4, 229.9, 230.3];
  for (let i = 0; i < 40; i += 1) {
    const u = volts[i % volts.length];
    state.victron.gridVoltage = { l1: u, l2: u, l3: u, updatedAt: NOW };
    const r = gridConnectionFromState({}, state, NOW);
    assert.ok(r.limitW <= 40 * 3 * u, `nie über der echten Grenze (${r.limitW} > ${40 * 3 * u})`);
    assert.equal(r.limitW % 100, 0);
    seen.add(r.limitW);
  }
  assert.ok(seen.size <= 2, `höchstens ein Wechsel (${[...seen].join(', ')})`);
});

test('P2-4: fällt die Spannung wirklich, folgt die Grenze sofort nach unten', () => {
  const state = victronState(40, { gv: { l1: 233, l2: 233, l3: 233, updatedAt: NOW } });
  assert.equal(gridConnectionFromState({}, state, NOW).limitW, 27900);
  state.victron.gridVoltage = { l1: 228, l2: 228, l3: 228, updatedAt: NOW };
  assert.equal(gridConnectionFromState({}, state, NOW).limitW, 27300, '40 × 684 = 27 360 → 27 300');
});

test('R3 P2-2: der Wert für EOS bleibt bei Spannungsschwankung gleich (kein PUT je Abgleich)', () => {
  const state = victronState(40);
  const cfg = { optimizer: { ...LICENSED, maxChargeW: 27000 } };
  const bodies = new Set();
  for (const u of [230.4, 230.1, 230.3, 230.2, 230.4]) {
    state.victron.gridVoltage = { l1: u, l2: u, l3: u, updatedAt: NOW };
    const extra = victronLimitExtra(state, NOW, cfg);
    bodies.add(JSON.stringify(buildEosInverters(cfg, { gridImportLimitSupported: true, gridConnectionExtra: extra })));
    bodies.add(`vanilla:${JSON.stringify(buildEosInverters(cfg, { gridConnectionExtra: extra }))}`);
    assert.equal(eosGridImportLimitW(cfg, extra) % 100, 0);
  }
  assert.equal(bodies.size, 2, 'je Fassung ein einziger Inhalt');
});

// --- R3 P3-3 ---------------------------------------------------------------------

test('R3 P3-3: ohne angemeldetes Auto zieht der Behelf die Auto-Ladeleistung nicht ab', () => {
  const cfg = { optimizer: { ...LICENSED, eosOptimizeEv: true, evMaxChargeW: 11000 } };
  // 3 × 16 A = 11 040 W, Grundlast 1 000 W.
  assert.equal(eosGridChargeCapW(cfg, { victronPhaseLimitA: 16, evPlanned: false }), 10000);
  assert.equal(eosGridChargeCapW(cfg, { victronPhaseLimitA: 16, evPlanned: true }), 0, 'Auto angemeldet: abziehen');
  const inv = buildEosInverters(cfg, { gridConnectionExtra: { victronPhaseLimitA: 16, evPlanned: false } })[0];
  assert.equal(inv.max_ac_charge_power_w, 10000);
});
