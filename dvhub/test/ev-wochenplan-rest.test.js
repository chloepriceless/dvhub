// test/ev-wochenplan-rest.test.js -- Restbefunde der E-Auto-Wochenplanung
// (Codex P2, Release-Kandidat 1.0.10):
//   1. Phasen von außen umgestellt (evcc-App, evcc-Automatik „auto“): DVhub
//      erkennt es an der eingestellten Phasenzahl (phasesConfigured) und stellt
//      die Phasen für diesen Ladevorgang nicht mehr ein (Besitzregel wie beim
//      evcc-Modus) — der Netzanschluss-Wächter begrenzt weiter den Strom.
//      Toleranz gegen veraltete evcc-Meldungen: Frist nach dem eigenen Befehl,
//      nur Abfragen nach dem Befehl, zwei Beobachtungen.
//   2. (zurückgenommen, Christin 10.11.2026) Der Heimweg fließt nicht mehr
//      ein — weder allgemein (evCommuteKm) noch je Zeile (commuteKm).
//   4. Alter Wert `targetValue: []` (Number([]) = 0) gilt als „nicht gesetzt“.
// (3. Wertstufen vor dem Lauf: test/eos-forecast-bridge.test.js.)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEosEvccBridge, EV_PHASE_SETTLE_MS } from '../services/optimizer/eos-evcc-bridge.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';
import { effectiveWeeklyPlan, migrateWeeklyPlanRows, resolveEvDeparture } from '../services/optimizer/ev-departure.js';
import { estimateArrivalSoc } from '../services/optimizer/ev-arrival.js';
import { loadConfigFile } from '../config-model.js';

const T0 = Date.parse('2026-11-16T22:00:00Z');
const Q = 15 * 60_000;

// evcc wie in echt: setPhases ändert die Einstellung (phasesConfigured) und —
// sofern die Meldung nicht veraltet ist — die aktiven Phasen.
function harness({ factors = [0.25, 0.25, 0.25, 0.25], configured = 3, owned = null } = {}) {
  const calls = [];
  const logs = [];
  const ctl = { capW: null, paused: false, stale: false, polledAt: null, saved: null };
  const lp = { id: 1, mode: 'pv', connected: true, charging: false, phases1p3p: true, phasesConfigured: configured, phasesActive: 3 };
  const fakeEvcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [{ ...lp }],
    refresh: async () => true,
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', m]); lp.mode = m; return { ok: true }; },
    setPhases: async (id, n) => { calls.push(['phases', n]); if (!ctl.stale) { lp.phasesConfigured = n; lp.phasesActive = n === 0 ? 3 : n; } return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3, evStopMode: 'pv' } };
  let clock = T0 + 60_000;
  let sol = factors;
  const make = () => createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ generatedAt: '2026-11-16T21:58:00Z', slotMinutes: 15, rows: sol.map((f, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: f, evSocPct: 50 })) }),
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => [{ ...lp }],
    getEvccPolledAt: () => ctl.polledAt,
    getGridCapW: () => ctl.capW,
    isPaused: () => ctl.paused,
    pushLog: (event, data) => logs.push({ event, data }),
    loadOwned: () => (ctl.saved ?? owned),
    saveOwned: (list) => { ctl.saved = list; },
    now: () => clock,
  });
  const bridge = make();
  return {
    bridge, make, calls, logs, ctl, lp, cfg,
    advance: (ms) => { clock += ms; }, now: () => clock, setFactors: (f) => { sol = f; },
    // Takte im 30-s-Raster (wie der echte Takt), bis `ms` vergangen sind.
    async run(ms, b = bridge) { for (let t = 0; t < ms; t += 30_000) { clock += 30_000; await b.tick(); } },
  };
}
const phaseCalls = (calls) => calls.filter((c) => c[0] === 'phases');
const changedEvents = (logs) => logs.filter((l) => l.event === 'ev_phases_changed_externally');

describe('Befund 1: Phasen von außen umgestellt — DVhub kämpft nicht dagegen', () => {
  test('Kunde stellt bei gleichem Strom zurück auf drei Phasen: kein Zurückschalten, Strom passt zur Planleistung (6 A statt 12 A dreiphasig)', async () => {
    const h = harness();
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['phases', 1], ['maxcurrent', 12], ['mode', 'now']], 'einphasig 2,75 kW');
    h.advance(EV_PHASE_SETTLE_MS);
    // evcc-App: drei Phasen. Ohne Erkennung bliebe der Befehl „unverändert“ —
    // 12 A × 3 Phasen = 8,3 kW statt 2,75 kW.
    h.lp.phasesConfigured = 3;
    h.lp.phasesActive = 3;
    const n = h.calls.length;
    await h.run(120_000);
    const after = h.calls.slice(n);
    assert.deepEqual(phaseCalls(after), [], `keine Phasen-Umschaltung: ${JSON.stringify(after)}`);
    assert.ok(after.some((c) => c[0] === 'maxcurrent' && c[1] === 6), `Strom auf die Planleistung dreiphasig (Mindeststrom): ${JSON.stringify(after)}`);
    assert.equal(changedEvents(h.logs).length, 1, 'einmal protokolliert');
    assert.equal(h.bridge.getStatus().phasesByCustomer?.found, 3);
  });

  test('für diesen Ladevorgang: weitere einphasige Slots und „Sofort laden“ schalten keine Phasen; nach Abstecken stellt DVhub wieder ein', async () => {
    const h = harness({ factors: [0.25, 0.3, 0.25, 0.25] });
    await h.bridge.tick();
    h.advance(EV_PHASE_SETTLE_MS);
    h.lp.phasesConfigured = 3;
    h.lp.phasesActive = 3;
    await h.run(120_000);
    const n = h.calls.length;
    h.advance(Q); // nächster Slot, wieder unter dem dreiphasigen Mindeststrom
    await h.bridge.tick();
    assert.equal((await h.bridge.setOverride({ powerW: 11000 })).ok, true);
    await h.bridge.clearOverride();
    assert.deepEqual(phaseCalls(h.calls.slice(n)), [], JSON.stringify(h.calls.slice(n)));
    // Abgesteckt: der Ladevorgang ist vorbei — danach schaltet DVhub wieder
    // nach Plan (evcc ist jetzt auf drei Phasen, der Slot will eine).
    const m = h.calls.length;
    h.lp.connected = false;
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.bridge.getStatus().phasesByCustomer, null);
    h.lp.connected = true;
    h.advance(Q);
    await h.bridge.tick();
    assert.deepEqual(phaseCalls(h.calls.slice(m)), [['phases', 1]], 'neuer Ladevorgang: DVhub schaltet wieder');
  });

  test('Netzanschluss-Wächter begrenzt weiter den Strom — ohne die Phasen anzufassen', async () => {
    const h = harness({ factors: [0.25, 1, 1, 1] });
    await h.bridge.tick();
    h.advance(EV_PHASE_SETTLE_MS);
    h.lp.phasesConfigured = 3;
    h.lp.phasesActive = 3;
    await h.run(120_000);
    h.advance(Q);
    h.ctl.capW = 6900; // 6900 W / (230 V × 3) = 10 A
    const n = h.calls.length;
    await h.bridge.tick();
    const after = h.calls.slice(n);
    assert.ok(after.some((c) => c[0] === 'maxcurrent' && c[1] === 10), JSON.stringify(after));
    assert.deepEqual(phaseCalls(after), [], 'auch kein „erst drei Phasen herstellen“');
  });

  test('übersteht einen Neustart (ev_owned.json)', async () => {
    const h = harness();
    await h.bridge.tick();
    h.advance(EV_PHASE_SETTLE_MS);
    h.lp.phasesConfigured = 3;
    h.lp.phasesActive = 3;
    await h.run(120_000);
    const b2 = h.make();
    const n = h.calls.length;
    h.advance(Q);
    await b2.tick();
    assert.deepEqual(phaseCalls(h.calls.slice(n)), []);
  });

  test('Not-Halt: auch nach der Erkennung kein einziger Befehl', async () => {
    const h = harness();
    await h.bridge.tick();
    h.advance(EV_PHASE_SETTLE_MS);
    h.lp.phasesConfigured = 3;
    h.ctl.paused = true;
    const n = h.calls.length;
    await h.run(180_000);
    assert.deepEqual(h.calls.slice(n), []);
  });
});

describe('Codex 9e0a7d5c: Grenze beim Umrechnen und Abstecken im Not-Halt', () => {
  test('P1: Kunde stellt auf eine Phase, Grenze steht, schneidet aber den Planstrom nicht: Strom bleibt unter der Grenze (dreiphasig gerechnet)', async () => {
    // 4,4 kW Plan = 6,4 A dreiphasig; Grenze 5 kW = 7,2 A dreiphasig — sie
    // kürzt nicht, gilt aber. Einphasig wären 4,4 kW 19 A → 16 A; meldet evcc
    // noch drei aktive Phasen, lüden 16 A × 3 = 11 kW über der Grenze.
    const h = harness({ factors: [0.25, 0.4, 0.4, 0.4] });
    await h.bridge.tick();      // einphasig
    h.advance(Q);
    await h.bridge.tick();      // 4,4 kW: DVhub schaltet auf drei Phasen
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1], ['phases', 3]]);
    h.ctl.capW = 5000;
    h.advance(EV_PHASE_SETTLE_MS);
    h.lp.phasesConfigured = 1;  // Kunde: eine Phase; evcc meldet noch drei aktive
    const n = h.calls.length;
    await h.run(120_000);
    const amps = h.calls.slice(n).filter((c) => c[0] === 'maxcurrent').map((c) => c[1]);
    assert.ok(amps.length && Math.max(...amps) <= 5000 / (230 * 3), `Strom ${JSON.stringify(amps)} unter 7,2 A`);
  });

  test('P2: im Not-Halt abgesteckt und wieder angesteckt: neuer Ladevorgang, DVhub stellt die Phasen wieder ein', async () => {
    const h = harness({ factors: [0.25, 0.25, 0.25, 0.25] });
    await h.bridge.tick();
    h.advance(EV_PHASE_SETTLE_MS);
    h.lp.phasesConfigured = 3;
    h.lp.phasesActive = 3;
    await h.run(120_000);
    assert.ok(h.bridge.getStatus().phasesByCustomer);
    h.ctl.paused = true;
    const n = h.calls.length;
    h.lp.connected = false;
    await h.run(60_000);
    h.lp.connected = true;
    await h.run(60_000);
    assert.equal(h.calls.length, n, 'im Not-Halt kein Befehl');
    h.ctl.paused = false;
    h.advance(Q);
    await h.bridge.tick();
    assert.equal(h.bridge.getStatus().phasesByCustomer, null);
    assert.deepEqual(phaseCalls(h.calls.slice(n)), [['phases', 1]]);
  });
});

describe('Befund 1: Toleranz gegen veraltete evcc-Meldungen', () => {
  test('Meldung hängt kurz nach dem eigenen Befehl noch auf drei Phasen: keine Fremdänderung, kein erneutes Schalten', async () => {
    const h = harness();
    h.ctl.stale = true; // evcc meldet die neue Einstellung erst später
    await h.bridge.tick();
    await h.run(EV_PHASE_SETTLE_MS - 30_000);
    h.lp.phasesConfigured = 1; // jetzt kommt sie an
    h.lp.phasesActive = 1;
    await h.run(120_000);
    assert.equal(changedEvents(h.logs).length, 0);
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1]], 'genau eine Umschaltung');
  });

  test('evcc-Abfrage älter als der eigene Befehl (evcc nicht erreichbar): zählt nicht, auch nach Minuten', async () => {
    const h = harness();
    h.ctl.polledAt = h.now() - 5_000; // letzte erfolgreiche Abfrage vor dem Befehl
    h.ctl.stale = true;
    await h.bridge.tick();
    await h.run(5 * 60_000);
    assert.equal(changedEvents(h.logs).length, 0);
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1]]);
  });

  test('nur eine abweichende Meldung (danach wieder DVhubs Wert): keine Fremdänderung', async () => {
    const h = harness();
    await h.bridge.tick();
    h.advance(EV_PHASE_SETTLE_MS);
    h.lp.phasesConfigured = 3;
    await h.run(30_000);
    h.lp.phasesConfigured = 1;
    await h.run(120_000);
    assert.equal(changedEvents(h.logs).length, 0);
  });
});

describe('Befund 1: evcc schaltet selbst (phasesConfigured 0 = automatisch)', () => {
  test('evcc-Automatik ohne DVhub-Phasenbefehl: wechselnde aktive Phasen lösen nichts aus', async () => {
    const h = harness({ factors: [1, 1, 1, 1], configured: 0 });
    await h.bridge.tick();
    assert.deepEqual(phaseCalls(h.calls), [], 'volle Leistung: evcc regelt die Phasen selbst');
    for (const ph of [1, 3, 1, 3]) {
      h.lp.phasesActive = ph;
      await h.run(60_000);
    }
    assert.deepEqual(phaseCalls(h.calls), []);
    assert.equal(changedEvents(h.logs).length, 0);
  });

  test('DVhub hat eine Phase gesetzt, Kunde stellt evcc auf „automatisch“: DVhub greift nicht mehr ein', async () => {
    const h = harness({ configured: 0 });
    await h.bridge.tick();
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1]]);
    h.advance(EV_PHASE_SETTLE_MS);
    h.lp.phasesConfigured = 0;
    h.lp.phasesActive = 3;
    const n = h.calls.length;
    await h.run(120_000);
    h.advance(Q);
    await h.bridge.tick();
    assert.deepEqual(phaseCalls(h.calls.slice(n)), []);
    assert.equal(changedEvents(h.logs).length, 1);
  });
});

describe('Heimweg fließt nicht mehr ein (Christin 10.11.2026)', () => {
  // „Der Heimweg ist ja immer anders … woher weiß man, ob man auf dem Heimweg
  // ist oder noch woanders hinfährt?“ — geplant wird nur mit dem je Abfahrt
  // eingetragenen Fahrtverbrauch in % (tripSocPct). Alte Heimweg-Werte
  // (allgemein evCommuteKm, je Zeile commuteKm) werden nicht umgerechnet.
  const OLD = { evDepartureTime: '07:00', evDepartureDays: [1, 2, 3, 4, 5], evCommuteKm: 20, evCapacityWh: 60000, evConsumptionKwhPer100km: 18 };

  test('evWeeklyPlan fehlt/null: der allgemeine Heimweg wird keine Fahrt', () => {
    for (const evWeeklyPlan of [undefined, null]) {
      const plan = effectiveWeeklyPlan({ ...OLD, evWeeklyPlan });
      for (const day of [1, 2, 3, 4, 5]) {
        assert.deepEqual(plan[day - 1], { day, arrival: '', departure: '07:00', minSocPct: null, tripSocPct: null }, `Tag ${day}`);
      }
    }
  });

  test('Ankunftsschätzung: ohne eingetragene Fahrt geht nichts ab (auch nicht der alte Heimweg)', () => {
    // Di 17.11.2026 12:00 Ortszeit: letzte Abfahrt Di 07:00.
    const nowMs = Date.parse('2026-11-17T11:00:00Z');
    const cfg = { schedule: { timezone: 'Europe/Berlin' }, optimizer: { ...OLD, evWeeklyPlan: null, evDepartureEnabled: true, evTargetMode: 'percent', evTargetValue: 80 } };
    const dep = resolveEvDeparture(cfg, nowMs);
    assert.ok(!dep.prevTripSocPct, `keine Fahrt: ${dep.prevTripSocPct}`);
    const r = estimateArrivalSoc({
      plugged: false, reading: { pct: 70, source: 'evcc', atMs: Date.parse('2026-11-17T05:30:00Z') },
      tripStartMs: Date.parse(dep.tripStartAt), tripPct: dep.prevTripSocPct, commuteKm: 20,
      consumptionKwhPer100km: 18, capacityWh: 60000, nowMs,
    });
    assert.equal(r.pct, 70);
    assert.equal(r.deductPct, 0);
  });

  test('alte Zeilen mit und ohne Ankunft: weder allgemeiner noch eigener Heimweg wird Fahrt', () => {
    const plan = migrateWeeklyPlanRows([
      { day: 1, arrival: '', departure: '07:00' },
      { day: 2, arrival: '18:00', departure: '07:00' },
      { day: 3, arrival: '', departure: '07:00', commuteKm: 50 },
      { day: 5, arrival: '15:00', departure: '09:00', commuteKm: 50 },
    ], { evCommuteKm: 20, evCapacityWh: 60000, evConsumptionKwhPer100km: 18 });
    for (const e of plan) {
      assert.equal(e.tripSocPct, null, `Tag ${e.day}`);
      assert.ok(!('commuteKm' in e), 'altes Feld verschwindet');
    }
  });

  test('ohne Heimweg bleibt es leer', () => {
    const plan = effectiveWeeklyPlan({ evDepartureTime: '07:00', evDepartureDays: [1, 2] });
    assert.deepEqual(plan[0], { day: 1, arrival: '', departure: '07:00', minSocPct: null, tripSocPct: null });
  });

  test('eingetragene Fahrt (tripSocPct) gilt weiter', () => {
    const plan = migrateWeeklyPlanRows([{ day: 1, arrival: '18:00', departure: '07:00', minSocPct: null, tripSocPct: 25 }], { evCommuteKm: 20 });
    assert.equal(plan[0].tripSocPct, 25);
  });
});

describe('Befund 4: kaputte alte Zahlen gelten als „nicht gesetzt“', () => {
  const OPT = { evCapacityWh: 60000, evConsumptionKwhPer100km: 18, evTargetMode: 'percent', evTargetValue: 80 };

  test('targetValue [] / Leerzeichen / true → kein Mindest-Ladestand 0 % bzw. 1 %', () => {
    for (const targetValue of [[], ' ', true, {}, [50]]) {
      const plan = migrateWeeklyPlanRows([{ day: 1, departure: '07:00', targetValue }], OPT);
      assert.equal(plan[0].minSocPct, null, `targetValue ${JSON.stringify(targetValue)}`);
    }
    // Zahl als Text bleibt eine Zahl.
    assert.equal(migrateWeeklyPlanRows([{ day: 1, departure: '07:00', targetValue: '60' }], OPT)[0].minSocPct, 60);
  });

  test('commuteKm [] bleibt folgenlos (Heimweg zählt nicht mehr)', () => {
    const plan = migrateWeeklyPlanRows([{ day: 1, arrival: '18:00', departure: '07:00', commuteKm: [] }], { ...OPT, evCommuteKm: 20 });
    assert.equal(plan[0].tripSocPct, null);
  });

  test('Konfig-Übernahme beim Laden: targetValue [] wird nicht 0 %', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-evrest-'));
    try {
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(file, JSON.stringify({ optimizer: { ...OPT, evWeeklyPlan: [{ day: 1, arrival: '18:00', departure: '07:00', targetValue: [] }] } }));
      const opt = loadConfigFile(file).rawConfig.optimizer;
      assert.equal(opt.evWeeklyPlan[0].minSocPct, null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
