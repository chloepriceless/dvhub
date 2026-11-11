// test/ev-einmal-ziel-ende.test.js -- Einmal-Ziel: wann es aktiv ist und wann
// es endet (Christin 11.11.2026, Prod-Test test-5: „man weiß nicht, ab wann es
// aktiv ist und wann es endet“).
//
// Server-Seite des Dialogs „Einmalige Abfahrt planen“:
//   - describeEvOnce: aktiv / vorbei, was es ersetzt, was vorher noch kommt;
//   - evOnceCleanupPatch: ein vergangenes Einmal-Ziel wird aus der Config
//     geräumt — erst wenn es an der Planung nichts mehr ändert (die ersetzte
//     Wochenplan-Abfahrt darf nicht als Phantom-Fahrt zurückkommen);
//   - evOnceUnplugPatch: Abstecken kurz vor der einmaligen Abfahrt = Abfahrt;
//   - parseEvDeparturePatch mit nowMs: neue Termine in der Vergangenheit abgelehnt;
//   - Minuten-Wache (ev-watch.js) speichert beides.
//
// Zeiten: Europe/Berlin im Winter UTC+1. Mo 16.11.2026.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeEvOnce, evOnceCleanupPatch, evOnceUnplugPatch, parseEvDeparturePatch,
  resolveEvDeparture, buildEvTrips, DEPARTURE_LEAD_MS, ONCE_UNPLUG_WINDOW_MS,
} from '../services/optimizer/ev-departure.js';
import { createEvWatch } from '../services/optimizer/ev-watch.js';

const TZ = 'Europe/Berlin';
const at = (s) => Date.parse(s);
const MIN = 60_000;
const HOUR = 60 * MIN;

function cfg(extra = {}) {
  return {
    schedule: { timezone: TZ },
    optimizer: {
      eosOptimizeEv: true, evDepartureEnabled: true, evCapacityWh: 60000, evConsumptionKwhPer100km: 18,
      evTargetMode: 'percent', evTargetValue: 80, evMaxChargeW: 11000, ...extra,
    },
  };
}
// Mo–Fr Ankunft 18:00, Abfahrt 07:00 (Folgetag), mindestens 60 %, Fahrt 20 %.
const COMMUTE = [1, 2, 3, 4, 5].map((day) => ({ day, arrival: '18:00', departure: '07:00', minSocPct: 60, tripSocPct: 20 }));
// Einmalig Mi 18.11. 06:00 (= 05:00Z) statt Mi 07:00 (= 06:00Z), mindestens 90 %.
const ONCE = '2026-11-18T05:00:00.000Z';
const withOnce = (extra = {}) => cfg({ evWeeklyPlan: COMMUTE, evDepartureOnce: ONCE, evDepartureOnceMinSocPct: 90, ...extra });

describe('describeEvOnce: aktiv, ersetzt, vorher', () => {
  test('Mo abends: aktiv, ersetzt Mi 07:00, Di 07:00 kommt vorher mit eigenem Ziel', () => {
    const d = describeEvOnce(withOnce(), at('2026-11-16T19:00:00Z'));
    assert.equal(d.departure.state, 'active');
    assert.equal(d.departure.effective, true);
    assert.equal(d.departure.at, ONCE);
    assert.equal(d.departure.targetSocPct, 90);
    assert.equal(d.departure.targetFrom, 'once');
    assert.equal(d.departure.replaces.departureAt, '2026-11-18T06:00:00.000Z');
    assert.equal(d.departure.replaces.arrivalAt, '2026-11-17T17:00:00.000Z');
    assert.equal(d.departure.weeklyBefore, 1);
    assert.equal(d.departure.nextWeeklyAt, '2026-11-17T06:00:00.000Z');
    // dieselbe Reihenfolge wie die Planung
    assert.equal(resolveEvDeparture(withOnce(), at('2026-11-16T19:00:00Z')).departureAt, '2026-11-17T06:00:00.000Z');
  });

  test('ohne eigenes Ziel: Ziel der ersetzten Zeile', () => {
    const d = describeEvOnce(withOnce({ evDepartureOnceMinSocPct: null }), at('2026-11-16T19:00:00Z'));
    assert.equal(d.departure.targetSocPct, 60);
    assert.equal(d.departure.targetFrom, 'weekly');
  });

  test('Vorlauf: 10 min vor der Abfahrt ist sie vorbei (ended)', () => {
    const onceMs = at(ONCE);
    assert.equal(describeEvOnce(withOnce(), onceMs - DEPARTURE_LEAD_MS - 1).departure.state, 'active');
    assert.equal(describeEvOnce(withOnce(), onceMs - DEPARTURE_LEAD_MS).departure.state, 'ended');
    assert.equal(describeEvOnce(withOnce(), onceMs - DEPARTURE_LEAD_MS).departure.effective, false);
  });

  test('Wochenplan aus: wirkt trotzdem, ersetzt nichts (seit 11.11.2026; Details in ev-einmal-ziel-ohne-wochenplan)', () => {
    const d = describeEvOnce(withOnce({ evDepartureEnabled: false }), at('2026-11-16T19:00:00Z'));
    assert.equal(d.weeklyEnabled, false);
    assert.equal(d.departure.state, 'active');
    assert.equal(d.departure.effective, true);
    assert.equal(d.departure.replaces, null);
  });

  test('ohne Einmal-Ziel: departure und arrival null', () => {
    const d = describeEvOnce(cfg({ evWeeklyPlan: COMMUTE }), at('2026-11-16T19:00:00Z'));
    assert.equal(d.departure, null);
    assert.equal(d.arrival, null);
  });

  test('einmalige Ankunft: aktiv im laufenden Fenster, sonst wartend bzw. vorbei', () => {
    const NOON = at('2026-11-16T11:00:00Z');
    const act = describeEvOnce(cfg({ evWeeklyPlan: COMMUTE, evArrivalOnce: '2026-11-16T20:00:00.000Z' }), NOON);
    assert.equal(act.arrival.state, 'active');
    const pend = describeEvOnce(cfg({ evWeeklyPlan: COMMUTE, evArrivalOnce: '2026-11-18T20:00:00.000Z' }), NOON);
    assert.equal(pend.arrival.state, 'pending');
    const old = describeEvOnce(cfg({ evWeeklyPlan: COMMUTE, evArrivalOnce: '2026-11-13T20:00:00.000Z' }), NOON);
    assert.equal(old.arrival.state, 'ended');
  });
});

describe('evOnceCleanupPatch: vergangenes Einmal-Ziel abräumen', () => {
  const CLEAR = { evDepartureOnce: '', evDepartureOnceMinSocPct: null, evDepartureOnceTripSocPct: null, evDepartureOnceLeftAt: '' };

  test('solange es kommt: nichts', () => {
    assert.deepEqual(evOnceCleanupPatch(withOnce(), at('2026-11-16T19:00:00Z')), {});
    assert.deepEqual(evOnceCleanupPatch(withOnce(), at(ONCE) - DEPARTURE_LEAD_MS - 1), {});
  });

  test('vorbei, aber die ersetzte Mi 07:00 läge noch vor uns: bleibt (sonst Phantom-Fahrt)', () => {
    assert.deepEqual(evOnceCleanupPatch(withOnce(), at('2026-11-18T04:51:00Z')), {});
    // auch nach Mi 07:00: die Einmal-Fahrt ist die laufende, nicht Mi 07:00
    assert.deepEqual(evOnceCleanupPatch(withOnce(), at('2026-11-18T06:30:00Z')), {});
  });

  test('nach der nächsten echten Abfahrt (Do 07:00): abgeräumt', () => {
    assert.deepEqual(evOnceCleanupPatch(withOnce(), at('2026-11-19T05:51:00Z')), CLEAR);
  });

  test('ohne Wochenplan-Abfahrten: gleich nach der Abfahrt abgeräumt', () => {
    const c = cfg({ evWeeklyPlan: [], evDepartureOnce: ONCE, evDepartureOnceMinSocPct: 90 });
    assert.deepEqual(evOnceCleanupPatch(c, at(ONCE) - DEPARTURE_LEAD_MS - 1), {});
    assert.deepEqual(evOnceCleanupPatch(c, at(ONCE) - DEPARTURE_LEAD_MS), CLEAR);
  });

  test('kaputte Zeit oder Ziel ohne Abfahrt: abgeräumt', () => {
    assert.deepEqual(evOnceCleanupPatch(cfg({ evDepartureOnce: 'kaputt', evDepartureOnceMinSocPct: 70 }), at('2026-11-16T19:00:00Z')), CLEAR);
    assert.deepEqual(evOnceCleanupPatch(cfg({ evDepartureOnce: '', evDepartureOnceTripSocPct: 30 }), at('2026-11-16T19:00:00Z')),
      { evDepartureOnceMinSocPct: null, evDepartureOnceTripSocPct: null, evDepartureOnceLeftAt: '' });
    assert.deepEqual(evOnceCleanupPatch(cfg({ evArrivalOnce: 'kaputt' }), at('2026-11-16T19:00:00Z')), { evArrivalOnce: '' });
  });

  test('einmalige Ankunft: bleibt, solange ihr Fenster läuft; nach dessen Abfahrt abgeräumt', () => {
    const c = cfg({ evWeeklyPlan: COMMUTE, evArrivalOnce: '2026-11-16T20:00:00.000Z' });
    assert.deepEqual(evOnceCleanupPatch(c, at('2026-11-16T11:00:00Z')), {});
    assert.deepEqual(evOnceCleanupPatch(c, at('2026-11-16T20:30:00Z')), {}, 'vergangen, wirkt aber noch (Fenster bis Di 07:00)');
    assert.deepEqual(evOnceCleanupPatch(c, at('2026-11-17T05:51:00Z')), { evArrivalOnce: '' });
  });

  // Die Kernzusage: Abräumen ändert nie, was DVhub plant. Minute für Minute
  // (in 5-min-Schritten) über die Woche: Config mit Einmal-Ziel vs. Config, in
  // der die Wache abgeräumt hat, sobald sie durfte.
  for (const [name, extra] of [
    ['Abfahrt Mi 06:00 statt 07:00', {}],
    ['Abfahrt Mi 09:00 statt 07:00, mit Fahrt', { evDepartureOnce: '2026-11-18T08:00:00.000Z', evDepartureOnceTripSocPct: 50 }],
    ['Abfahrt Fr 17:00 vor dem Wochenende', { evDepartureOnce: '2026-11-20T16:00:00.000Z' }],
    ['Abfahrt plus einmalige Ankunft', { evArrivalOnce: '2026-11-17T20:30:00.000Z' }],
    ['Abfahrt ohne Ankunftszeiten (alter Plan Mo–Fr 07:00)', { evWeeklyPlan: undefined, evDepartureTime: '07:00', evDepartureDays: [1, 2, 3, 4, 5] }],
  ]) {
    test(`Abräumen ändert die Planung nie: ${name}`, () => {
      const orig = withOnce(extra);
      let live = JSON.parse(JSON.stringify(orig));
      let clearedAt = null;
      for (let t = at('2026-11-16T19:00:00Z'); t < at('2026-11-23T19:00:00Z'); t += 5 * MIN) {
        const p = evOnceCleanupPatch(live, t);
        if (Object.keys(p).length) {
          live = { ...live, optimizer: { ...live.optimizer, ...p } };
          if (p.evDepartureOnce === '' && clearedAt === null) clearedAt = t;
        }
        const a = resolveEvDeparture(orig, t);
        const b = resolveEvDeparture(live, t);
        assert.deepEqual(b, a, `Planung weicht ab um ${new Date(t).toISOString()}`);
        const ta = buildEvTrips(orig, t, { days: 3 }).trips;
        const tb = buildEvTrips(live, t, { days: 3 }).trips;
        assert.deepEqual(tb, ta, `Fahrten weichen ab um ${new Date(t).toISOString()}`);
      }
      assert.ok(clearedAt !== null, 'nie abgeräumt');
      assert.ok(clearedAt - at(orig.optimizer.evDepartureOnce) < 4 * 24 * HOUR, 'zu spät abgeräumt');
      assert.equal(live.optimizer.evArrivalOnce || '', '', 'einmalige Ankunft nicht abgeräumt');
    });
  }
});

describe('evOnceUnplugPatch: Abstecken zur Abfahrt', () => {
  const onceMs = at(ONCE);
  test(`in den letzten ${ONCE_UNPLUG_WINDOW_MS / MIN} min vor der Abfahrt: losgefahren = jetzt (minutengenau), Termin bleibt`, () => {
    const p = evOnceUnplugPatch(withOnce(), onceMs - 25 * MIN + 17_000);
    assert.deepEqual(p, { evDepartureOnceLeftAt: new Date(onceMs - 25 * MIN).toISOString() });
    // danach ist es vorbei
    const after = { ...withOnce(), optimizer: { ...withOnce().optimizer, ...p } };
    assert.equal(describeEvOnce(after, onceMs - 25 * MIN + 17_000).departure.state, 'ended');
  });
  test('Codex 5fe74510: frühes Abstecken holt keine andere ersetzte Abfahrt zurück', () => {
    // Täglich Ankunft 18:00 → Abfahrt 07:00; einmalig Mi 18.11. 18:10 (17:10Z) ersetzt Do 07:00.
    const DAILY = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, arrival: '18:00', departure: '07:00', minSocPct: 60, tripSocPct: 20 }));
    const c = cfg({ evWeeklyPlan: DAILY, evDepartureOnce: '2026-11-18T17:10:00.000Z', evDepartureOnceMinSocPct: 90 });
    assert.equal(describeEvOnce(c, at('2026-11-18T12:00:00Z')).departure.replaces.departureAt, '2026-11-19T06:00:00.000Z');
    const unplug = at('2026-11-18T16:45:00Z');   // 17:45 Ortszeit, 25 min vorher
    const p = evOnceUnplugPatch(c, unplug);
    const after = { ...c, optimizer: { ...c.optimizer, ...p } };
    const d = describeEvOnce(after, unplug + MIN);
    assert.equal(d.departure.state, 'ended');
    assert.equal(d.departure.leftAt, '2026-11-18T16:45:00.000Z');
    assert.equal(d.departure.replaces.departureAt, '2026-11-19T06:00:00.000Z', 'ersetzt bleibt Do 07:00');
    // Do 07:00 kommt nicht zurück: die nächste Abfahrt ist Fr 07:00, die laufende Fahrt begann 17:45.
    const r = resolveEvDeparture(after, unplug + MIN);
    assert.equal(r.departureAt, '2026-11-20T06:00:00.000Z');
    assert.equal(r.tripStartAt, '2026-11-18T16:45:00.000Z');
    // ein neuer Termin setzt das „schon los“ zurück; derselbe nicht
    assert.equal(parseEvDeparturePatch({ once: '2026-11-25T08:00:00Z' }, 'departure', { opt: after.optimizer, nowMs: unplug }).patch.evDepartureOnceLeftAt, '');
    assert.ok(!('evDepartureOnceLeftAt' in parseEvDeparturePatch({ once: '2026-11-18T17:10:00Z' }, 'departure', { opt: after.optimizer, nowMs: unplug }).patch));
    // abgeräumt wird alles zusammen
    const clear = evOnceCleanupPatch(after, at('2026-11-20T05:51:00Z'));
    assert.equal(clear.evDepartureOnce, '');
    assert.equal(clear.evDepartureOnceLeftAt, '');
  });
  test('früher abgesteckt (umparken): Einmal-Ziel bleibt', () => {
    assert.deepEqual(evOnceUnplugPatch(withOnce(), onceMs - ONCE_UNPLUG_WINDOW_MS - MIN), {});
  });
  test('schon vorbei oder keins: nichts', () => {
    assert.deepEqual(evOnceUnplugPatch(withOnce(), onceMs), {});
    assert.deepEqual(evOnceUnplugPatch(cfg({ evWeeklyPlan: COMMUTE }), onceMs - 5 * MIN), {});
  });
});

describe('parseEvDeparturePatch mit nowMs: keine neuen Termine in der Vergangenheit', () => {
  const NOW = at('2026-11-16T19:00:00Z');
  test('Abfahrt in der Vergangenheit oder im Vorlauf: abgelehnt', () => {
    const past = parseEvDeparturePatch({ once: '2026-11-16T18:00:00Z' }, 'departure', { nowMs: NOW });
    assert.equal(past.ok, false);
    assert.equal(past.code, 'once_in_past');
    assert.match(past.error, /departure\.once/);
    assert.equal(parseEvDeparturePatch({ once: new Date(NOW + 5 * MIN).toISOString() }, 'departure', { nowMs: NOW }).ok, false);
    assert.equal(parseEvDeparturePatch({ once: new Date(NOW + 11 * MIN).toISOString() }, 'departure', { nowMs: NOW }).ok, true);
  });
  test('gespeicherter Wert darf unverändert zurückkommen (Seite mit altem Formular)', () => {
    const r = parseEvDeparturePatch({ once: '2026-11-16T18:00:00+01:00' }, 'departure', { nowMs: NOW, opt: { evDepartureOnce: '2026-11-16T17:00:00.000Z' } });
    assert.equal(r.ok, true);
    assert.equal(r.patch.evDepartureOnce, '2026-11-16T17:00:00.000Z');
  });
  test('Leeren geht immer', () => {
    const r = parseEvDeparturePatch({ once: '', onceMinSocPct: '', onceTripSocPct: '', arrivalOnce: '' }, 'departure', { nowMs: NOW });
    assert.deepEqual(r.patch, { evDepartureOnce: '', evArrivalOnce: '', evDepartureOnceMinSocPct: null, evDepartureOnceTripSocPct: null });
  });
  test('einmalige Ankunft in der Vergangenheit: abgelehnt', () => {
    const r = parseEvDeparturePatch({ arrivalOnce: '2026-11-16T18:59:00Z' }, 'departure', { nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'arrival_once_in_past');
    assert.equal(parseEvDeparturePatch({ arrivalOnce: '2026-11-16T19:30:00Z' }, 'departure', { nowMs: NOW }).ok, true);
  });
  test('ohne nowMs (reine Umrechnung) wie bisher', () => {
    assert.equal(parseEvDeparturePatch({ once: '2026-09-26T09:30:00+02:00' }).ok, true);
  });
});

describe('Minuten-Wache (ev-watch.js) räumt ab und erkennt das Abstecken', () => {
  function watchCtx(opt, { plugged = true } = {}) {
    const raw = { schedule: { timezone: TZ }, optimizer: { ...opt } };
    const logs = [];
    const saved = [];
    const lp = { id: 1, connected: plugged, vehicleSocPct: 50 };
    const ctx = {
      logs, saved, lp,
      state: { victron: { minSocPct: 5, soc: 50 }, optimizer: {} },
      getCfg: () => raw,
      getRawCfg: () => raw,
      saveAndApplyConfig: (next) => { saved.push(JSON.parse(JSON.stringify(next))); raw.optimizer = next.optimizer; return { ok: true }; },
      evccIntegration: { getLoadpoints: () => [lp] },
    };
    return ctx;
  }
  const fakeSync = () => ({ sync: async () => ({ ok: true }), syncEv: async () => ({ ok: true }) });

  test('abgelaufenes Einmal-Ziel wird gespeichert abgeräumt — auch ohne EOS-Planung, nur einmal', async () => {
    const ctx = watchCtx({ ...withOnce().optimizer, eosOptimizeEv: false });
    const logs = [];
    const watch = createEvWatch({ ctx, eosConfigSync: fakeSync(), requestReplan: () => {}, pushLog: (e, p) => logs.push([e, p]) });
    await watch.tick(at('2026-11-17T12:00:00Z'));
    assert.equal(ctx.saved.length, 0, 'kommt noch');
    await watch.tick(at('2026-11-19T05:51:00Z'));
    assert.equal(ctx.saved.length, 1);
    assert.equal(ctx.getRawCfg().optimizer.evDepartureOnce, '');
    assert.equal(ctx.getRawCfg().optimizer.evDepartureOnceMinSocPct, null);
    assert.deepEqual(logs.find(([e]) => e === 'ev_once_expired')?.[1].before.evDepartureOnce, ONCE);
    await watch.tick(at('2026-11-19T05:52:00Z'));
    assert.equal(ctx.saved.length, 1, 'kein zweites Speichern');
  });

  test('Abstecken 20 min vor der einmaligen Abfahrt beendet sie; Abstecken 2 h vorher nicht', async () => {
    const opt = { ...withOnce().optimizer, eosProxy: { enabled: true, url: 'http://127.0.0.1:1' } };
    for (const [before, ends] of [[20 * MIN, true], [2 * HOUR, false]]) {
      const ctx = watchCtx(opt, { plugged: true });
      const logs = [];
      const watch = createEvWatch({ ctx, eosConfigSync: fakeSync(), requestReplan: () => {}, pushLog: (e, p) => logs.push([e, p]), stableTicks: 1 });
      const t0 = at(ONCE) - before - MIN;
      await watch.tick(t0);
      ctx.lp.connected = false;
      await watch.tick(t0 + MIN);
      const o = ctx.getRawCfg().optimizer;
      if (ends) {
        assert.equal(o.evDepartureOnce, ONCE, 'Termin bleibt');
        assert.equal(o.evDepartureOnceLeftAt, new Date(t0 + MIN).toISOString());
        assert.ok(logs.some(([e]) => e === 'ev_once_departed'));
        assert.equal(describeEvOnce(ctx.getCfg(), t0 + MIN).departure.state, 'ended');
      } else {
        assert.equal(o.evDepartureOnce, ONCE);
        assert.ok(!logs.some(([e]) => e === 'ev_once_departed'));
      }
    }
  });
});
