// test/eos-first-plan.test.js -- Erstplan-Wache (eos-first-plan.js).
// Timer und Uhr werden injiziert, damit der Ablauf ohne Wartezeit und ohne
// laufendes EOS pruefbar ist.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEosFirstPlanWatch, isFreshEosSolution } from '../services/optimizer/eos-first-plan.js';

/** Kontrollierbare Timer-/Uhr-Umgebung: fire() fuehrt den faelligen Tick aus. */
function harness(opts = {}) {
  let clock = 1_000_000;
  let pending = null;
  const emsPuts = [];
  const logs = [];
  let triggered = 0;
  let solutionReady = opts.solutionReady ?? false;
  const probedSince = [];

  const watch = createEosFirstPlanWatch({
    hasFreshSolution: async (sinceMs) => {
      if (opts.probeThrows) throw new Error('EOS weg');
      probedSince.push(sinceMs);
      return solutionReady;
    },
    setEmsIntervalSec: async (sec) => {
      if (opts.putThrows) throw new Error('PUT abgelehnt');
      emsPuts.push(sec);
      return { ok: true };
    },
    triggerOptimization: () => { triggered += 1; },
    pushLog: (event, data) => logs.push({ event, data }),
    pollMs: 30_000,
    maxWaitMs: 90_000,
    boostIntervalSec: opts.boostIntervalSec ?? 60,
    now: () => clock,
    setTimer: (fn) => { pending = fn; return { unref() {} }; },
    clearTimer: () => { pending = null; }
  });

  return {
    watch, emsPuts, logs, probedSince,
    events: () => logs.map(l => l.event),
    triggeredCount: () => triggered,
    setSolutionReady: (v) => { solutionReady = v; },
    advance: (ms) => { clock += ms; },
    hasPending: () => pending !== null,
    async fire() {
      const fn = pending;
      pending = null;
      if (fn) await fn();
    }
  };
}

describe('eos-first-plan watch', () => {
  test('arm senkt ems.interval und pollt; bei Loesung: zurueck + Lauf angestossen', async () => {
    const h = harness();

    assert.equal(await h.watch.arm({ restoreIntervalSec: 900 }), true);
    assert.equal(h.watch.isArmed(), true);
    assert.equal(h.watch.isBoosted(), true);
    assert.deepEqual(h.emsPuts, [60], 'Boost auf 60 s gesetzt');
    assert.ok(h.hasPending(), 'Nachpoll-Timer laeuft');

    // Erster Tick: EOS hat noch nichts -> weiter pollen, Boost bleibt.
    h.advance(30_000);
    await h.fire();
    assert.equal(h.watch.isArmed(), true);
    assert.deepEqual(h.emsPuts, [60]);
    assert.equal(h.triggeredCount(), 0);

    // Zweiter Tick: Loesung da -> ems.interval zurueck, Optimizer-Lauf angestossen.
    h.setSolutionReady(true);
    h.advance(30_000);
    await h.fire();
    assert.equal(h.watch.isArmed(), false);
    assert.equal(h.watch.isBoosted(), false);
    assert.deepEqual(h.emsPuts, [60, 900], 'Soll-Takt wiederhergestellt');
    assert.equal(h.triggeredCount(), 1);
    assert.ok(h.events().includes('eos_first_plan_ready'));
    const ready = h.logs.find(l => l.event === 'eos_first_plan_ready');
    assert.equal(ready.data.waitedMs, 60_000);
  });

  test('arm ist idempotent -- zweiter Aufruf boostet nicht erneut', async () => {
    const h = harness();
    assert.equal(await h.watch.arm({ restoreIntervalSec: 900 }), true);
    assert.equal(await h.watch.arm({ restoreIntervalSec: 900 }), false);
    assert.deepEqual(h.emsPuts, [60]);
  });

  test('maxWaitMs: Sicherheitsnetz setzt den Takt zurueck und gibt auf', async () => {
    const h = harness();
    await h.watch.arm({ restoreIntervalSec: 900 });

    h.advance(90_000); // >= maxWaitMs
    await h.fire();

    assert.equal(h.watch.isArmed(), false);
    assert.deepEqual(h.emsPuts, [60, 900], 'kein Dauer-Boost nach Aufgabe');
    assert.equal(h.triggeredCount(), 0);
    assert.ok(h.events().includes('eos_first_plan_timeout'));
    assert.equal(h.hasPending(), false, 'kein Timer bleibt zurueck');
  });

  test('kein Boost, wenn der Soll-Takt schon kuerzer ist als der Boost', async () => {
    const h = harness();
    await h.watch.arm({ restoreIntervalSec: 30 });
    assert.equal(h.watch.isBoosted(), false);
    assert.deepEqual(h.emsPuts, [], 'ems.interval unangetastet');
    assert.ok(h.hasPending(), 'aber nachgepollt wird trotzdem');
  });

  test('boostIntervalSec=0 schaltet den Boost ab, Nachpollen bleibt', async () => {
    const h = harness({ boostIntervalSec: 0 });
    await h.watch.arm({ restoreIntervalSec: 900 });
    assert.deepEqual(h.emsPuts, []);
    h.setSolutionReady(true);
    h.advance(30_000);
    await h.fire();
    assert.equal(h.triggeredCount(), 1);
    assert.deepEqual(h.emsPuts, [], 'ohne Boost auch kein Restore-PUT');
  });

  test('unbekannter Soll-Takt: kein Boost (wir ueberschreiben nichts blind)', async () => {
    const h = harness();
    await h.watch.arm({});
    assert.equal(h.watch.isBoosted(), false);
    assert.deepEqual(h.emsPuts, []);
  });

  test('disarm setzt einen laufenden Boost zurueck', async () => {
    const h = harness();
    await h.watch.arm({ restoreIntervalSec: 900 });
    await h.watch.disarm();
    assert.equal(h.watch.isArmed(), false);
    assert.deepEqual(h.emsPuts, [60, 900]);
    assert.equal(h.hasPending(), false);
  });

  test('Sonde wirft (EOS weg): Wache bleibt scharf und pollt weiter', async () => {
    const h = harness({ probeThrows: true });
    await h.watch.arm({ restoreIntervalSec: 900 });
    h.advance(30_000);
    await h.fire();
    assert.equal(h.watch.isArmed(), true);
    assert.ok(h.events().includes('eos_first_plan_probe_failed'));
    assert.ok(h.hasPending());
  });

  test('Boost-PUT scheitert: Wache laeuft ohne Boost weiter, kein Restore-PUT', async () => {
    const h = harness({ putThrows: true });
    await h.watch.arm({ restoreIntervalSec: 900 });
    assert.equal(h.watch.isBoosted(), false);
    assert.ok(h.events().includes('eos_first_plan_boost_failed'));
    h.setSolutionReady(true);
    h.advance(30_000);
    await h.fire();
    assert.equal(h.triggeredCount(), 1, 'Plan wird trotzdem abgeholt');
  });

  test('stop() raeumt Timer weg und stellt den Takt wieder her', async () => {
    const h = harness();
    await h.watch.arm({ restoreIntervalSec: 900 });
    h.watch.stop();
    assert.equal(h.watch.isArmed(), false);
    assert.equal(h.hasPending(), false);
    await new Promise(r => setImmediate(r)); // fire-and-forget Restore abwarten
    assert.deepEqual(h.emsPuts, [60, 900]);
  });
});

describe('eos-first-plan watch: Config als Getter', () => {
  test('pollMs/boostIntervalSec duerfen Funktionen sein (Config erst spaeter da)', async () => {
    let cfg = null; // wie beim Bauen des Dienstes: noch keine Config
    const emsPuts = [];
    const watch = createEosFirstPlanWatch({
      hasFreshSolution: async () => false,
      setEmsIntervalSec: async (sec) => { emsPuts.push(sec); return { ok: true }; },
      triggerOptimization: () => {},
      pollMs: () => cfg?.pollMs ?? 30_000,
      boostIntervalSec: () => cfg?.boostSec ?? 60,
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {}
    });
    // Erst jetzt kommt die Config — der Getter liest sie beim Armieren.
    cfg = { pollMs: 10_000, boostSec: 45 };
    await watch.arm({ restoreIntervalSec: 900 });
    assert.deepEqual(emsPuts, [45], 'Boost-Wert aus der spaeter geladenen Config');
    assert.equal(watch.getState().pollMs, 10_000);
  });
});

// Nach einem Neustart stellt EOS seine letzte Loesung aus der eigenen Datenbank
// wieder her. Sie ist da, aber nicht mit den neuen Prognosen gerechnet — auf
// prod hat sie die Wache 2026-09-21 zu frueh entschaerft (Plan erst +10 min).
describe('eos-first-plan: nur frische Loesungen zaehlen', () => {
  const since = Date.parse('2026-09-22T10:00:00Z');

  test('Loesung vor dem ersten Push ist veraltet, danach frisch', () => {
    assert.equal(isFreshEosSolution({ generatedAt: '2026-09-22T09:59:00Z' }, since), false);
    assert.equal(isFreshEosSolution({ generatedAt: '2026-09-22T10:00:30+00:00' }, since), true);
    // EOS liefert lokale Zeit mit Offset — derselbe Zeitpunkt, anders geschrieben.
    assert.equal(isFreshEosSolution({ generatedAt: '2026-09-22T12:00:30.5+02:00' }, since), true);
  });

  test('keine Loesung / kein generatedAt: nicht frisch', () => {
    assert.equal(isFreshEosSolution(null, since), false);
    assert.equal(isFreshEosSolution({ generatedAt: null }, since), false);
    assert.equal(isFreshEosSolution({}, since), false);
  });

  test('ohne Bezugszeitpunkt (noch kein Push) genuegt eine vorhandene Loesung', () => {
    assert.equal(isFreshEosSolution({ generatedAt: '2026-01-01T00:00:00Z' }, null), true);
    assert.equal(isFreshEosSolution(null, null), false);
  });

  test('arm reicht freshSince an die Sonde durch; ohne Angabe gilt der Armier-Zeitpunkt', async () => {
    const h = harness();
    await h.watch.arm({ restoreIntervalSec: 900, freshSince: 123_456 });
    h.advance(30_000);
    await h.fire();
    assert.deepEqual(h.probedSince, [123_456]);
    assert.equal(h.watch.getState().freshSince, 123_456);

    const h2 = harness();
    await h2.watch.arm({ restoreIntervalSec: 900 });
    assert.equal(h2.watch.getState().freshSince, 1_000_000, 'Armier-Zeitpunkt der Harness-Uhr');
  });
});

// Gesamtprüfung Release 1.0.9: stop() während eines Takts (Abfrage hängt im
// Netz) — der Takt lief danach weiter, stieß bei fertiger Lösung noch einen
// Lauf an bzw. stellte den nächsten Timer.
test('stop() während der Abfrage: kein Lauf, kein neuer Timer', async () => {
  for (const ready of [true, false]) {
    let answer;
    let pending = null;
    let triggered = 0;
    const watch = createEosFirstPlanWatch({
      hasFreshSolution: () => new Promise((r) => { answer = r; }),
      setEmsIntervalSec: async () => ({ ok: true }),
      triggerOptimization: () => { triggered += 1; },
      pollMs: 30_000, maxWaitMs: 900_000, boostIntervalSec: 0,
      now: () => 1_000_000,
      setTimer: (fn) => { pending = fn; return { unref() {} }; },
      clearTimer: () => { pending = null; },
    });
    await watch.arm({});
    const fn = pending; pending = null;
    const tick = fn();
    while (!answer) await new Promise((r) => setImmediate(r));
    watch.stop();
    answer(ready);
    await tick;
    assert.equal(triggered, 0, `ready=${ready}: kein Lauf nach stop()`);
    assert.equal(pending, null, `ready=${ready}: kein neuer Timer nach stop()`);
  }
});

// Gegenprüfung a80fa938 (P3): stop() während des Zurücksetzens (Lösung schon
// da, armed schon false) — danach kam trotzdem noch triggerOptimization().
test('stop() während des Zurücksetzens nach fertiger Lösung: kein Lauf', async () => {
  let pending = null;
  let triggered = 0;
  let releasePut;
  let puts = 0;
  const watch = createEosFirstPlanWatch({
    hasFreshSolution: async () => true,
    setEmsIntervalSec: () => { puts += 1; return puts === 1 ? Promise.resolve({ ok: true }) : new Promise((r) => { releasePut = r; }); },
    triggerOptimization: () => { triggered += 1; },
    pollMs: 30_000, maxWaitMs: 900_000, boostIntervalSec: 60,
    now: () => 1_000_000,
    setTimer: (fn) => { pending = fn; return { unref() {} }; },
    clearTimer: () => { pending = null; },
  });
  await watch.arm({ restoreIntervalSec: 900 });
  const tick = pending();
  while (!releasePut) await new Promise((r) => setImmediate(r));
  watch.stop();
  releasePut({ ok: true });
  await tick;
  assert.equal(triggered, 0);
});
