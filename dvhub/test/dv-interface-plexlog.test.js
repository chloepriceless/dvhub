// test/dv-interface-plexlog.test.js — Das Plexlog-DV-Profil verhält sich wie das
// echte Gerät (dekompilierter Code REA/plexlog-dump MIClientHandle.cs +
// PMManagement.cs, am echten Plexlog-Gerät am 14.11.2026 gegengemessen):
//   Holding 0 (Int32, niederwertiges Wort zuerst) = Soll-Wirkleistung in Watt
//     (0 = aus, −1/≥ Anlagenleistung = voll, dazwischen = Grenze in Watt).
//   Holding 3 = Watchdog (Lebenszeichen, kein Aus); ohne Auffrischen → 100 %.
//   FC4: 0–1 Einspeisung, 3–4 Referenz, 7 Produktion, ab 10 Spiegel der Holding.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDvLimitController, plexlogInputRegisters, LUOX_WATCHDOG_MS, wordsToU32,
} from '../dv-interface-luox.js';

const i32 = (lo, hi) => (wordsToU32(lo, hi) | 0);

// 29 000 W „Max. AC Leistung" wie bei Christins Anlage (PMTotalPower).
function controller({ cfg = {}, applyFails = false } = {}) {
  let t = 1_000_000;
  const calls = [];
  const state = { ctrl: { forcedOff: false, offUntil: 0 } };
  const c = createDvLimitController({
    state,
    getCfg: () => ({ controlWrite: { dvFeedInLimitW: { enabled: true } }, dvInterface: { luox: { referencePowerW: 29000 } }, ...cfg }),
    setForcedOff: (reason, opts) => { calls.push(['off', reason, opts?.until]); state.ctrl.forcedOff = true; state.ctrl.offUntil = opts?.until; },
    clearForcedOff: (reason) => { calls.push(['on', reason]); state.ctrl.forcedOff = false; },
    applyDvFeedInLimit: async (w) => { calls.push(['limit', w]); if (applyFails && w != null) throw new Error('modbus timeout'); },
    now: () => t,
  });
  return { c, state, calls, advance: (ms) => { t += ms; } };
}

test('Holding 0 = 0 W → aus', () => {
  const { c, state, calls } = controller();
  const r = c.setDvLimitW(0, 'r0');
  assert.equal(r.mode, 'off');
  assert.equal(state.ctrl.forcedOff, true);
  assert.deepEqual(calls.at(-1).slice(0, 2), ['off', 'r0']);
});

test('Holding 0 = 14500 W bei 29 kW Anlage → Teilgrenze 14500 W (50 %)', async () => {
  const { c, state, calls } = controller();
  const r = c.setDvLimitW(14500, 'r');
  await r.done;
  assert.equal(r.mode, 'limit');
  assert.equal(r.limitW, 14500, 'Grenze ist der Watt-Wert selbst, nicht prozentgerundet');
  assert.deepEqual(calls.at(-1), ['limit', 14500]);
  assert.equal(state.ctrl.dvLimitPct, 50, 'Anzeige-Prozent = 100·14500/29000');
  assert.equal(state.ctrl.forcedOff, false);
});

test('Holding 0 = 20000 W → Teilgrenze 20000 W (≈69 %, wie live gemessen)', async () => {
  const { c, state, calls } = controller();
  await c.setDvLimitW(20000, 'r').done;
  assert.deepEqual(calls.at(-1), ['limit', 20000]);
  assert.equal(state.ctrl.dvLimitPct, 69);
});

test('Holding 0 = −1 (FFFF,FFFF) → voll frei, keine Vorgabe', () => {
  const { c, state } = controller();
  assert.equal(c.setDvLimitW(-1, 'r').mode, 'full');
  assert.equal(state.ctrl.forcedOff, false);
  assert.equal(state.ctrl.dvLimitPct ?? null, null);
});

test('Holding 0 ≥ Anlagenleistung → voll frei (auch LUOX-Freigabe 255,255)', () => {
  const genau = controller();
  assert.equal(genau.c.setDvLimitW(29000, 'r').mode, 'full');
  const drueber = controller();
  assert.equal(drueber.c.setDvLimitW(30000, 'r').mode, 'full');
  // 255,255 als Int32 = 16 711 935 W → weit über jeder Anlage → voll frei.
  const sentinel = controller();
  assert.equal(sentinel.c.setDvLimitW(i32(255, 255), 'r').mode, 'full');
});

test('Von Aus auf Teilvorgabe: Sperre wird aufgehoben, Grenze gesetzt', async () => {
  const { c, state, calls } = controller();
  c.setDvLimitW(0, 'aus');
  assert.equal(state.ctrl.forcedOff, true);
  await c.setDvLimitW(14500, 'teil').done;
  assert.ok(calls.some((x) => x[0] === 'on'), 'clearForcedOff gerufen');
  assert.equal(state.ctrl.forcedOff, false);
  assert.deepEqual(calls.at(-1), ['limit', 14500]);
});

test('Watchdog hält die Teilvorgabe, Ablauf der Lease → zurück auf 100 %', async () => {
  const { c, state, calls, advance } = controller();
  c.watchdogRefresh();
  await c.setDvLimitW(14500, 'r').done;
  advance(10 * 60_000);
  c.watchdogRefresh();
  assert.equal(state.ctrl.dvLimitUntil, 1_000_000 + 10 * 60_000 + LUOX_WATCHDOG_MS, 'Watchdog verlängert die Lease');
  advance(LUOX_WATCHDOG_MS - 1);
  c.expireIfNeeded();
  assert.equal(state.ctrl.dvLimitPct, 50, 'noch gültig');
  advance(2);
  c.expireIfNeeded();
  await new Promise((res) => setImmediate(res));
  assert.equal(state.ctrl.dvLimitPct, null, 'Lease abgelaufen → 100 %');
  assert.deepEqual(calls.at(-1), ['limit', null]);
});

test('Teilvorgabe ohne Referenzleistung → sicherheitshalber ganz abregeln', () => {
  const { c, state } = controller({ cfg: { dvInterface: { luox: { referencePowerW: 0 } } } });
  const r = c.setDvLimitW(14500, 'r');
  assert.equal(r.fallback, true);
  assert.equal(state.ctrl.forcedOff, true);
});

test('Schreibfehler an der Einspeisegrenze → ganz abregeln', async () => {
  const { c, state } = controller({ applyFails: true });
  await c.setDvLimitW(14500, 'r').done;
  assert.equal(state.ctrl.forcedOff, true);
  assert.equal(state.ctrl.dvLimitPct, null);
});

test('plexlogInputRegisters: Belegung 0–1 Einspeisung, 3–4 Referenz, 7 Produktion, Spiegel ab 10', () => {
  const state = {
    meter: { grid_total_w: -1500 },
    victron: { pvTotalW: 5000 },
    dvRegs: { 0: 14500, 1: 0, 3: 7 },
  };
  const cfg = { gridPositiveMeans: 'feed_in', dvInterface: { luox: { referencePowerW: 29000 } } };
  const regs = plexlogInputRegisters(state, cfg);
  assert.equal(i32(regs[0], regs[1]), -1500, 'Einspeisung (Bezug negativ)');
  assert.equal(regs[2], 0, 'Reg 2 leer');
  assert.equal(i32(regs[3], regs[4]), 29000, 'Referenz-/Anlagenleistung');
  assert.equal(i32(regs[5], regs[6]), 0, 'Reg 5–6 (Einstrahlung) unbekannt → 0');
  assert.equal(i32(regs[7], regs[8]), 5000, 'Produktion');
  assert.equal(regs[10], 14500, 'Spiegel Soll-Wirkleistung (Lo)');
  assert.equal(regs[11], 0, 'Spiegel Soll-Wirkleistung (Hi)');
  assert.equal(regs[13], 7, 'Spiegel Watchdog');
});

test('plexlogInputRegisters: Einspeisung positiv, Referenz aus PV-kWp', () => {
  const state = { meter: { grid_total_w: 42000 }, victron: { pvTotalW: 30000 }, dvRegs: {} };
  const cfg = { gridPositiveMeans: 'feed_in', userEnergyPricing: { pvPlants: [{ kwp: 18 }, { kwp: 9 }] } };
  const regs = plexlogInputRegisters(state, cfg);
  assert.equal(i32(regs[0], regs[1]), 42000, 'Einspeisung positiv, volles i32 über 32,7 kW');
  assert.equal(i32(regs[3], regs[4]), 27000, 'Referenz = Summe der kWp × 1000');
});
