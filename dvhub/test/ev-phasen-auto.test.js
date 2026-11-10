// test/ev-phasen-auto.test.js -- Phasen nach DVhubs eigenem Laden zurück
// (Christin 10.11.2026, „2c“): Steht evcc auf „automatisch“ (phasesConfigured
// 0), darf DVhub für sein geplantes günstiges Laden einphasig setzen, stellt
// danach aber den Wert von vorher wieder her — auch fest 1 oder 3, wenn DVhub
// ihn geändert hat. Danach heißt: Slot/Ladung von DVhub vorbei (Plan ohne
// Ladung, Max-Ladestand), Abstecken, Not-Halt (genau einmal). Von außen
// umgestellt: nichts zurückstellen. Lese-Modus: nichts schreiben. Der Wert von
// vorher übersteht einen Neustart (ev_owned.json).
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEosEvccBridge, EV_PHASE_SETTLE_MS } from '../services/optimizer/eos-evcc-bridge.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

const T0 = Date.parse('2026-11-16T22:00:00Z');
const Q = 15 * 60_000;

// evcc wie in echt: setPhases ändert die Einstellung (phasesConfigured);
// „automatisch“ (0) lädt mit drei aktiven Phasen.
function harness({ factors = [0.25, 0, 0, 0], configured = 0, active = null } = {}) {
  const calls = [];
  const logs = [];
  const ctl = { capW: null, paused: false, saved: null, maxStop: null, failPhases: false };
  const lp = { id: 1, mode: 'pv', connected: true, charging: false, phases1p3p: true, phasesConfigured: configured, phasesActive: active ?? (configured === 0 ? 3 : configured) };
  const fakeEvcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [{ ...lp }],
    refresh: async () => true,
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', m]); lp.mode = m; return { ok: true }; },
    setPhases: async (id, n) => { calls.push(['phases', n]); if (ctl.failPhases) return { ok: false, error: 'HTTP 500' }; lp.phasesConfigured = n; lp.phasesActive = n === 0 ? 3 : n; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3, evStopMode: 'pv' } };
  let clock = T0 + 60_000;
  const sol = factors;
  const make = () => createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ generatedAt: '2026-11-16T21:58:00Z', slotMinutes: 15, rows: sol.map((f, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: f, evSocPct: 50 })) }),
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => [{ ...lp }],
    getGridCapW: () => ctl.capW,
    isPaused: () => ctl.paused,
    getEvMaxStop: () => ctl.maxStop,
    pushLog: (event, data) => logs.push({ event, data }),
    loadOwned: () => ctl.saved,
    saveOwned: (list) => { ctl.saved = list; },
    now: () => clock,
  });
  const bridge = make();
  return {
    bridge, make, calls, logs, ctl, lp,
    advance: (ms) => { clock += ms; },
    async run(ms, b = bridge) { for (let t = 0; t < ms; t += 30_000) { clock += 30_000; await b.tick(); } },
  };
}
const phaseCalls = (calls) => calls.filter((c) => c[0] === 'phases');
const restoredEvents = (logs) => logs.filter((l) => l.event === 'ev_phases_restored');

describe('Phasen nach DVhubs Ladung zurück auf den Wert von vorher', () => {
  test('evcc „automatisch“: einphasig geladen, Plan ohne Ladung → erst Stopp, dann wieder automatisch (0)', async () => {
    const h = harness();
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['phases', 1], ['maxcurrent', 12], ['mode', 'now']]);
    assert.equal(h.bridge.getStatus().phasesRestoreTo, 0, 'Wert von vorher gemerkt');
    h.advance(Q);
    const n = h.calls.length;
    await h.bridge.tick();
    assert.deepEqual(h.calls.slice(n), [['mode', 'pv'], ['phases', 0]], 'Stopp vor der Rückkehr der Phasen (sonst 12 A dreiphasig)');
    assert.equal(h.lp.phasesConfigured, 0);
    assert.equal(restoredEvents(h.logs).length, 1);
    assert.equal(h.bridge.getStatus().phasesRestoreTo, null);
    // Danach still: keine weitere Umschaltung, keine „Änderung von außen“.
    const m = h.calls.length;
    await h.run(5 * 60_000);
    assert.deepEqual(phaseCalls(h.calls.slice(m)), []);
    assert.equal(h.logs.filter((l) => l.event === 'ev_phases_changed_externally').length, 0);
  });

  test('fest drei Phasen: nach der einphasigen Ladung wieder drei', async () => {
    const h = harness({ configured: 3 });
    await h.bridge.tick();
    h.advance(Q);
    await h.bridge.tick();
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1], ['phases', 3]]);
  });

  test('fest eine Phase, DVhub schaltet für mehr Leistung auf drei: danach wieder eine', async () => {
    const h = harness({ configured: 1, factors: [0.4, 0, 0, 0] });
    await h.bridge.tick();
    assert.deepEqual(phaseCalls(h.calls), [['phases', 3]]);
    h.advance(Q);
    await h.bridge.tick();
    assert.deepEqual(phaseCalls(h.calls), [['phases', 3], ['phases', 1]]);
  });

  test('Wechsel ein- auf dreiphasig mitten in DVhubs Ladung: zurück auf den Wert vor dem ERSTEN Befehl', async () => {
    const h = harness({ factors: [0.25, 0.4, 0, 0] });
    await h.bridge.tick();
    h.advance(Q);
    await h.bridge.tick();
    h.advance(Q);
    await h.bridge.tick();
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1], ['phases', 3], ['phases', 0]]);
  });

  test('Max-Ladestand erreicht (Laden endet): Phasen zurück', async () => {
    const h = harness({ factors: [0.25, 0.25, 0.25, 0.25] });
    await h.bridge.tick();
    h.advance(2 * 60_000);
    h.ctl.maxStop = { maxSocPct: 80, socPct: 80 };
    const n = h.calls.length;
    await h.bridge.tick();
    assert.deepEqual(h.calls.slice(n), [['mode', 'off'], ['phases', 0]]);
  });

  test('Abstecken während DVhubs Ladung: Phasen zurück, solange abgesteckt kein neuer Phasenbefehl; angesteckt wieder einphasig', async () => {
    const h = harness({ factors: [0.25, 0.25, 0, 0] });
    await h.bridge.tick();
    h.advance(2 * 60_000);
    h.lp.connected = false;
    await h.run(3 * 60_000);
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1], ['phases', 0]]);
    assert.ok(restoredEvents(h.logs).some((l) => l.data.reason === 'unplugged'), JSON.stringify(h.logs.map((l) => l.event)));
    h.lp.connected = true;
    await h.run(30_000);
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1], ['phases', 0], ['phases', 1]]);
    h.advance(2 * Q); // Slot ohne Ladung
    await h.run(30_000);
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1], ['phases', 0], ['phases', 1], ['phases', 0]], 'und nach dem Ende wieder automatisch');
  });

  test('„Laden stoppen“ (DVhub-Knopf) beendet DVhubs Ladung: Phasen zurück', async () => {
    const h = harness({ factors: [0.25, 0.25, 0.25, 0.25] });
    await h.bridge.tick();
    h.advance(2 * 60_000);
    const n = h.calls.length;
    assert.equal((await h.bridge.setOverride({ kind: 'stop' })).ok, true);
    assert.deepEqual(h.calls.slice(n), [['mode', 'off'], ['phases', 0]]);
  });

  test('übersteht einen Neustart (ev_owned.json): der Wert von vorher kommt aus der Datei', async () => {
    const h = harness();
    await h.bridge.tick();
    assert.ok(JSON.stringify(h.ctl.saved).includes('"phasesPrev":0'), JSON.stringify(h.ctl.saved));
    const b2 = h.make();
    h.advance(Q);
    await b2.tick();
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1], ['phases', 0]]);
  });

  test('von außen umgestellt (evcc-App): DVhub stellt nichts zurück', async () => {
    const h = harness({ factors: [0.25, 0.25, 0, 0] });
    await h.bridge.tick();
    h.advance(EV_PHASE_SETTLE_MS);
    h.lp.phasesConfigured = 3;
    h.lp.phasesActive = 3;
    await h.run(2 * 60_000);
    assert.equal(h.bridge.getStatus().phasesByCustomer?.found, 3);
    h.advance(2 * Q);
    await h.run(2 * 60_000);
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1]]);
    assert.equal(h.lp.phasesConfigured, 3);
  });

  test('evcc stand schon auf dem Plan-Wert (fest eine Phase): kein Befehl, nichts zurückzustellen', async () => {
    const h = harness({ configured: 1 });
    await h.bridge.tick();
    h.advance(Q);
    await h.run(2 * 60_000);
    assert.deepEqual(phaseCalls(h.calls), []);
  });

  test('Not-Halt im normalen Takt: kein Zurückstellen (nur die einmalige Neutralisierung)', async () => {
    const h = harness();
    await h.bridge.tick();
    h.ctl.paused = true;
    h.advance(Q);
    const n = h.calls.length;
    await h.run(5 * 60_000);
    assert.deepEqual(h.calls.slice(n), []);
  });
});

describe('Not-Halt: genau eine Rücknahme der eigenen Phasen-Vorgabe', () => {
  test('DVhub lädt einphasig: Not-Halt stoppt, stellt die Phasen einmal zurück, dann still', async () => {
    const h = harness({ factors: [0.25, 0.25, 0.25, 0.25] });
    await h.bridge.tick();
    h.advance(2 * 60_000);
    h.ctl.paused = true;
    const n = h.calls.length;
    const r = await h.bridge.emergencyStop();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(h.calls.slice(n), [['mode', 'off'], ['phases', 0]]);
    const m = h.calls.length;
    await h.run(5 * 60_000);
    await h.bridge.emergencyStop();
    assert.deepEqual(h.calls.slice(m), [], 'danach kein Befehl mehr');
    // Aufgehoben: neuer Plan-Slot — DVhub schaltet wieder einphasig wie vorher.
    h.ctl.paused = false;
    await h.run(30_000);
    assert.deepEqual(phaseCalls(h.calls.slice(m)), [['phases', 1]]);
  });

  test('DVhub hatte schon gestoppt, die Rückkehr scheiterte: Not-Halt holt sie einmal nach', async () => {
    const h = harness();
    await h.bridge.tick();
    h.advance(Q);
    h.ctl.failPhases = true; // evcc nimmt den Phasenbefehl gerade nicht an
    await h.bridge.tick();
    assert.equal(h.lp.phasesConfigured, 1, 'Rückkehr gescheitert');
    h.ctl.failPhases = false;
    h.ctl.paused = true;
    const n = h.calls.length;
    await h.bridge.emergencyStop();
    assert.deepEqual(h.calls.slice(n), [['phases', 0]]);
    const m = h.calls.length;
    await h.run(3 * 60_000);
    assert.deepEqual(h.calls.slice(m), []);
  });

  test('Kunde hat den Modus im Not-Halt-Moment von Hand übernommen: nichts senden; nach dem Aufheben stellt DVhub nach seiner Ladung zurück', async () => {
    const h = harness({ factors: [0.25, 0, 0, 0] });
    await h.bridge.tick();
    h.lp.mode = 'minpv'; // evcc-App
    h.ctl.paused = true;
    const n = h.calls.length;
    await h.bridge.emergencyStop();
    assert.deepEqual(h.calls.slice(n), [], 'Ladung des Kunden nicht anfassen — auch keine Phasen');
    assert.equal(h.bridge.getStatus().phasesRestoreTo, 0, 'Wert von vorher bleibt gemerkt');
    h.ctl.paused = false;
    h.advance(Q);
    await h.bridge.tick();
    assert.deepEqual(phaseCalls(h.calls.slice(n)), [['phases', 0]]);
  });

  test('nach DVhubs Stopp lädt jemand von Hand („now“): Not-Halt stellt keine Phasen', async () => {
    const h = harness();
    await h.bridge.tick();
    h.advance(Q);
    h.ctl.failPhases = true;
    await h.bridge.tick(); // Stopp ok, Rückkehr gescheitert
    h.ctl.failPhases = false;
    h.lp.mode = 'now'; // evcc-App: Sofort laden
    h.ctl.paused = true;
    const n = h.calls.length;
    await h.bridge.emergencyStop();
    assert.deepEqual(h.calls.slice(n), []);
  });

  test('Phasen von außen umgestellt: Not-Halt stellt keine Phasen', async () => {
    const h = harness({ factors: [0.25, 0.25, 0.25, 0.25] });
    await h.bridge.tick();
    h.advance(EV_PHASE_SETTLE_MS);
    h.lp.phasesConfigured = 3;
    await h.run(2 * 60_000);
    h.ctl.paused = true;
    const n = h.calls.length;
    await h.bridge.emergencyStop();
    assert.deepEqual(phaseCalls(h.calls.slice(n)), []);
  });
});

describe('Lese-Modus: nichts an evcc', () => {
  const prev = process.env.DVHUB_READ_ONLY;
  afterEach(() => { if (prev === undefined) delete process.env.DVHUB_READ_ONLY; else process.env.DVHUB_READ_ONLY = prev; });

  test('weder einphasig setzen noch zurückstellen — auch nicht im Not-Halt', async () => {
    process.env.DVHUB_READ_ONLY = '1';
    const h = harness({ factors: [0.25, 0, 0.25, 0.25] });
    await h.run(2 * 60_000);
    h.advance(Q);
    await h.run(2 * 60_000);
    h.lp.connected = false;
    await h.run(2 * 60_000);
    h.ctl.paused = true;
    await h.bridge.emergencyStop();
    assert.deepEqual(h.calls, []);
    assert.equal(h.lp.phasesConfigured, 0);
  });
});
