// test/ev-einmal-ziel-wochenplan.test.js -- Einmal-Ziel und Wochenplan bestehen
// nebeneinander (Fable R5 P2-1): Wochenplan-Abfahrten VOR der einmaligen
// Abfahrt bleiben mit Mindestziel und Frist; nur die eine Abfahrt, die das
// Einmal-Ziel ersetzt (resolveEvWindow: dasselbe Fenster bzw. die nächstgelegene
// Abfahrt bis 24 h), fällt weg. Auch ein Einmal-Ziel in mehr als 16 Tagen setzt
// den Wochenplan nicht außer Kraft.
//
// Zeiten von Hand gerechnet: Europe/Berlin im Winter UTC+1, im Sommer UTC+2.
// Mo 16.11.2026; Sommerzeit endet So 25.10.2026 03:00, beginnt So 28.03.2027 02:00.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEvDeparture, buildEvTrips, DEPARTURE_LEAD_MS } from '../services/optimizer/ev-departure.js';
import { resolveEvTargets, TRIP_LOOKAHEAD_DAYS } from '../services/optimizer/ev-targets.js';

const TZ = 'Europe/Berlin';
const at = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString();

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

/** Künftige Fahrten (ohne die laufende) als [Abfahrt, Mindestziel, Quelle]. */
function futureTrips(c, nowMs, days = 8) {
  return buildEvTrips(c, nowMs, { days }).trips
    .filter((t) => t.src !== 'current')
    .map((t) => [iso(t.depMs), t.minPct, t.src]);
}

describe('Fable R5 P2-1: Einmal-Ziel hinter Wochenplan-Abfahrten', () => {
  // Mo 16.11. 20:00 = 19:00Z; einmalig Do 19.11. 09:00 = 08:00Z mit 100 %.
  const NOW = at('2026-11-16T19:00:00Z');
  const c = cfg({ evWeeklyPlan: COMMUTE, evDepartureOnce: '2026-11-19T08:00:00.000Z', evDepartureOnceMinSocPct: 100 });

  test('nächste Abfahrt bleibt die vom Wochenplan (Di 07:00, 60 %), nicht das Einmal-Ziel', () => {
    const r = resolveEvDeparture(c, NOW);
    assert.equal(r.source, 'weekly');
    assert.equal(r.departureAt, '2026-11-17T06:00:00.000Z');
    assert.equal(r.arrivalAt, '2026-11-16T17:00:00.000Z');
    assert.equal(r.targetSocPct, 60);
  });

  test('Fahrtenliste: Di und Mi bleiben, Do 09:00 ersetzt nur Do 07:00', () => {
    const trips = futureTrips(c, NOW).filter(([d]) => d < '2026-11-21T00:00:00.000Z');
    assert.deepEqual(trips, [
      ['2026-11-17T06:00:00.000Z', 60, 'weekly'],
      ['2026-11-18T06:00:00.000Z', 60, 'weekly'],
      ['2026-11-19T08:00:00.000Z', 100, 'once'],
      ['2026-11-20T06:00:00.000Z', 60, 'weekly'],
    ]);
  });

  test('Mittwochabend: jetzt ist das Einmal-Ziel dran, mit der Ankunft vom Mittwoch', () => {
    const r = resolveEvDeparture(c, at('2026-11-18T19:00:00Z'));
    assert.equal(r.source, 'once');
    assert.equal(r.departureAt, '2026-11-19T08:00:00.000Z');
    assert.equal(r.arrivalAt, '2026-11-18T17:00:00.000Z');
    assert.equal(r.targetSocPct, 100);
  });

  test('EOS-Ziele: Frist = Di 07:00, Mindestziel mindestens 60 %', () => {
    const t = resolveEvTargets({ state: {} }, c, { nowMs: NOW });
    assert.equal(t.source, 'plan');
    assert.equal(t.deadlineAt, '2026-11-17T06:00:00.000Z');
    assert.ok(t.minSocPct >= 60, `minSocPct ${t.minSocPct}`);
  });

  test('in Minutenschritten bis nach dem Einmal-Ziel: keine Abfahrt wird übersprungen', () => {
    const expected = ['2026-11-17T06:00:00.000Z', '2026-11-18T06:00:00.000Z', '2026-11-19T08:00:00.000Z', '2026-11-20T06:00:00.000Z'].map(at);
    for (let t = NOW; t < at('2026-11-19T20:00:00Z'); t += 11 * 60_000) {
      const want = expected.find((d) => d - DEPARTURE_LEAD_MS > t);
      assert.equal(resolveEvDeparture(c, t).departureAt, iso(want), `bei ${iso(t)}`);
    }
  });
});

describe('Fable R5 P2-1: Einmal-Ziel mehr als 16 Tage voraus', () => {
  const NOW = at('2026-11-16T19:00:00Z');
  const c = cfg({ evWeeklyPlan: COMMUTE, evDepartureOnce: '2026-12-20T08:00:00.000Z', evDepartureOnceMinSocPct: 100 });

  test('Wochenplan gilt weiter (nächste Abfahrt Di 07:00, Fahrtenliste voll)', () => {
    const r = resolveEvDeparture(c, NOW);
    assert.equal(r.source, 'weekly');
    assert.equal(r.departureAt, '2026-11-17T06:00:00.000Z');
    const trips = futureTrips(c, NOW, TRIP_LOOKAHEAD_DAYS);
    assert.ok(trips.length >= 10, `nur ${trips.length} Fahrten`);
    assert.ok(trips.every(([, , src]) => src === 'weekly'));
  });

  test('EOS-Ziele aus dem Plan, nicht „keine Abfahrt in der Vorausschau“', () => {
    const t = resolveEvTargets({ state: {} }, c, { nowMs: NOW });
    assert.equal(t.source, 'plan');
    assert.equal(t.deadlineAt, '2026-11-17T06:00:00.000Z');
  });

  test('Tage später, wenn es näher rückt, kommt das Einmal-Ziel in die Fahrtenliste', () => {
    const trips = futureTrips(c, at('2026-12-14T19:00:00Z'));
    assert.ok(trips.some(([d, min, src]) => d === '2026-12-20T08:00:00.000Z' && min === 100 && src === 'once'));
  });
});

describe('Fable R5 P2-1: Lage des Einmal-Ziels zum Wochenplan', () => {
  test('vor allen Wochenplan-Abfahrten (keine in 24 h): Einmal-Ziel zuerst, der Plan danach bleibt', () => {
    const plan = [3, 5].map((day) => ({ day, departure: '07:00', minSocPct: 50, tripSocPct: 30 }));
    // Mo 16.11. 08:00; einmalig Mo 18:00 = 17:00Z, Mi 07:00 ist 37 h entfernt.
    const c = cfg({ evWeeklyPlan: plan, evDepartureOnce: '2026-11-16T17:00:00.000Z', evDepartureOnceMinSocPct: 70 });
    const now = at('2026-11-16T07:00:00Z');
    assert.equal(resolveEvDeparture(c, now).source, 'once');
    assert.deepEqual(futureTrips(c, now).slice(0, 3), [
      ['2026-11-16T17:00:00.000Z', 70, 'once'],
      ['2026-11-18T06:00:00.000Z', 50, 'weekly'],
      ['2026-11-20T06:00:00.000Z', 50, 'weekly'],
    ]);
  });

  test('zwischen zwei Wochenplan-Abfahrten (keine in 24 h): beide bleiben', () => {
    const plan = [1, 4].map((day) => ({ day, departure: '07:00', minSocPct: 50, tripSocPct: 30 }));
    // So 15.11. 20:00; einmalig Di 17.11. 12:00 = 11:00Z (Mo 07:00: 29 h, Do 07:00: 53 h).
    const c = cfg({ evWeeklyPlan: plan, evDepartureOnce: '2026-11-17T11:00:00.000Z', evDepartureOnceMinSocPct: 90 });
    const now = at('2026-11-15T19:00:00Z');
    const r = resolveEvDeparture(c, now);
    assert.equal(r.source, 'weekly');
    assert.equal(r.departureAt, '2026-11-16T06:00:00.000Z');
    assert.deepEqual(futureTrips(c, now).slice(0, 4), [
      ['2026-11-16T06:00:00.000Z', 50, 'weekly'],
      ['2026-11-17T11:00:00.000Z', 90, 'once'],
      ['2026-11-19T06:00:00.000Z', 50, 'weekly'],
      ['2026-11-23T06:00:00.000Z', 50, 'weekly'],
    ]);
    assert.equal(resolveEvDeparture(c, at('2026-11-16T08:00:00Z')).source, 'once');
  });

  test('am selben Tag (Mi 09:00 statt 07:00): ersetzt nur Mi 07:00, Di bleibt', () => {
    // Alter Plan ohne Ankunft: Mo–Fr 07:00.
    const c = cfg({ evDepartureTime: '07:00', evDepartureDays: [1, 2, 3, 4, 5], evDepartureOnce: '2026-11-18T08:00:00.000Z', evDepartureOnceMinSocPct: 90 });
    const now = at('2026-11-16T19:00:00Z');
    assert.equal(resolveEvDeparture(c, now).departureAt, '2026-11-17T06:00:00.000Z');
    assert.deepEqual(futureTrips(c, now).slice(0, 4), [
      ['2026-11-17T06:00:00.000Z', 80, 'weekly'],
      ['2026-11-18T08:00:00.000Z', 90, 'once'],
      ['2026-11-19T06:00:00.000Z', 80, 'weekly'],
      ['2026-11-20T06:00:00.000Z', 80, 'weekly'],
    ]);
  });

  test('über Mitternacht (Do 01:00 statt 05:00): Di und Mi 05:00 bleiben, Ankunft Mi 20:00', () => {
    const plan = [1, 2, 3, 4].map((day) => ({ day, arrival: '20:00', departure: '05:00', minSocPct: 55, tripSocPct: 20 }));
    const c = cfg({ evWeeklyPlan: plan, evDepartureOnce: '2026-11-19T00:00:00.000Z', evDepartureOnceMinSocPct: 95 });
    const now = at('2026-11-16T20:00:00Z');
    assert.equal(resolveEvDeparture(c, now).departureAt, '2026-11-17T04:00:00.000Z');
    assert.deepEqual(futureTrips(c, now).slice(0, 4), [
      ['2026-11-17T04:00:00.000Z', 55, 'weekly'],
      ['2026-11-18T04:00:00.000Z', 55, 'weekly'],
      ['2026-11-19T00:00:00.000Z', 95, 'once'],
      ['2026-11-20T04:00:00.000Z', 55, 'weekly'],
    ]);
    const wed = resolveEvDeparture(c, at('2026-11-18T19:30:00Z'));
    assert.equal(wed.source, 'once');
    assert.equal(wed.arrivalAt, '2026-11-18T19:00:00.000Z');
  });

  test('Zeitumstellung Herbst (So 25.10.2026): Sa und So bleiben, Mo 12:00 ersetzt Mo 07:00', () => {
    const plan = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, departure: '07:00', minSocPct: 50, tripSocPct: 10 }));
    const c = cfg({ evWeeklyPlan: plan, evDepartureOnce: '2026-10-26T11:00:00.000Z', evDepartureOnceMinSocPct: 90 });
    const now = at('2026-10-23T18:00:00Z'); // Fr 20:00 CEST
    assert.deepEqual(futureTrips(c, now).slice(0, 4), [
      ['2026-10-24T05:00:00.000Z', 50, 'weekly'], // Sa 07:00 CEST
      ['2026-10-25T06:00:00.000Z', 50, 'weekly'], // So 07:00 CET
      ['2026-10-26T11:00:00.000Z', 90, 'once'], // Mo 12:00 CET
      ['2026-10-27T06:00:00.000Z', 50, 'weekly'],
    ]);
  });

  test('Zeitumstellung Frühjahr (So 28.03.2027): Sa und So bleiben, Mo 12:00 ersetzt Mo 07:00', () => {
    const plan = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, departure: '07:00', minSocPct: 50, tripSocPct: 10 }));
    const c = cfg({ evWeeklyPlan: plan, evDepartureOnce: '2027-03-29T10:00:00.000Z', evDepartureOnceMinSocPct: 90 });
    const now = at('2027-03-26T19:00:00Z'); // Fr 20:00 CET
    assert.deepEqual(futureTrips(c, now).slice(0, 4), [
      ['2027-03-27T06:00:00.000Z', 50, 'weekly'], // Sa 07:00 CET
      ['2027-03-28T05:00:00.000Z', 50, 'weekly'], // So 07:00 CEST
      ['2027-03-29T10:00:00.000Z', 90, 'once'], // Mo 12:00 CEST
      ['2027-03-30T05:00:00.000Z', 50, 'weekly'],
    ]);
  });

  test('leerer Wochenplan: nur das Einmal-Ziel', () => {
    const c = cfg({ evWeeklyPlan: [], evDepartureOnce: '2026-11-19T08:00:00.000Z', evDepartureOnceMinSocPct: 85 });
    const now = at('2026-11-16T19:00:00Z');
    const r = resolveEvDeparture(c, now);
    assert.equal(r.source, 'once');
    assert.equal(r.targetSocPct, 85);
    assert.deepEqual(futureTrips(c, now), [['2026-11-19T08:00:00.000Z', 85, 'once']]);
  });

  test('Einmal-Ziel in der Vergangenheit: Wochenplan unverändert', () => {
    const c = cfg({ evWeeklyPlan: COMMUTE, evDepartureOnce: '2026-11-16T10:00:00.000Z', evDepartureOnceMinSocPct: 100 });
    const plain = cfg({ evWeeklyPlan: COMMUTE });
    const now = at('2026-11-16T19:00:00Z');
    assert.equal(resolveEvDeparture(c, now).departureAt, '2026-11-17T06:00:00.000Z');
    assert.deepEqual(futureTrips(c, now), futureTrips(plain, now));
  });
});

describe('Fable R5 P2-1: welche Abfahrt ersetzt ist, hängt nicht von der Uhrzeit ab', () => {
  // Einmalig Do 20:00 (= 19:00Z), Plan Mo–Fr Ankunft 18:00 → Abfahrt 07:00:
  // das Auto ist Do ab 18:00 da, fährt um 20:00 statt Fr 07:00. Do 07:00
  // (Mi-Fenster) ist eine eigene Fahrt und bleibt — von Montag aus gesehen
  // ebenso wie am Mittwochabend.
  const c = cfg({ evWeeklyPlan: COMMUTE, evDepartureOnce: '2026-11-19T19:00:00.000Z', evDepartureOnceMinSocPct: 90 });
  const expected = ['2026-11-17T06:00:00.000Z', '2026-11-18T06:00:00.000Z', '2026-11-19T06:00:00.000Z', '2026-11-19T19:00:00.000Z', '2026-11-21T06:00:00.000Z'].map(at);

  test('Fahrtenliste bleibt über die Tage gleich', () => {
    const until = at('2026-11-22T00:00:00Z');
    for (let t = at('2026-11-16T19:00:00Z'); t < at('2026-11-20T00:00:00Z'); t += 13 * 60_000) {
      const got = buildEvTrips(c, t, { days: 8 }).trips.filter((x) => x.src !== 'current' && x.depMs < until).map((x) => x.depMs);
      assert.deepEqual(got.map(iso), expected.filter((d) => d - DEPARTURE_LEAD_MS > t).map(iso), `bei ${iso(t)}`);
    }
  });
});
