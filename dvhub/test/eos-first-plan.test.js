// test/eos-first-plan.test.js -- Erstplan-Wache (eos-first-plan.js).
// Timer und Uhr werden injiziert, damit der Ablauf ohne Wartezeit und ohne
// laufendes EOS pruefbar ist.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEosFirstPlanWatch } from '../services/optimizer/eos-first-plan.js';

/** Kontrollierbare Timer-/Uhr-Umgebung: fire() fuehrt den faelligen Tick aus. */
function harness(opts = {}) {
  let clock = 1_000_000;
  let pending = null;
  const emsPuts = [];
  const logs = [];
  let triggered = 0;
  let solutionReady = opts.solutionReady ?? false;

  const watch = createEosFirstPlanWatch({
    hasSolution: async () => {
      if (opts.probeThrows) throw new Error('EOS weg');
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
    watch, emsPuts, logs,
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
      hasSolution: async () => false,
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
