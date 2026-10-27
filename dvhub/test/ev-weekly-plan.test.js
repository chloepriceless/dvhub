// test/ev-weekly-plan.test.js -- Wochenplan fuers E-Auto: je Wochentag
// Ankunft (Anstecken), Abfahrt und optional ein eigenes Ziel.
//
// Alle erwarteten Zeitpunkte sind von Hand gerechnet: Europe/Berlin ist im
// Sommer UTC+2 (CEST), im Winter UTC+1 (CET); 2026 endet die Sommerzeit am
// Sonntag 25.10. um 03:00 und beginnt am Sonntag 29.03. um 02:00.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEvDeparture, effectiveWeeklyPlan, parseEvDeparturePatch, DEPARTURE_LEAD_MS
} from '../services/optimizer/ev-departure.js';

const TZ = 'Europe/Berlin';
const iso = (ms) => new Date(ms).toISOString();
const at = (s) => Date.parse(s);

// Beispiel der Betreiberin: Mo–Do Ankunft 20:00, Abfahrt 05:00 am naechsten
// Morgen; Fr Ankunft 15:00, Abfahrt Sa 09:00; Sa/So kein Plan.
const OWNER_PLAN = [
  { day: 1, arrival: '20:00', departure: '05:00' },
  { day: 2, arrival: '20:00', departure: '05:00' },
  { day: 3, arrival: '20:00', departure: '05:00' },
  { day: 4, arrival: '20:00', departure: '05:00' },
  { day: 5, arrival: '15:00', departure: '09:00', targetValue: 100 },
];

function cfg(extra = {}) {
  return {
    schedule: { timezone: TZ },
    optimizer: {
      eosOptimizeEv: true, evCapacityWh: 60000,
      evDepartureEnabled: true, evDepartureTime: '07:00', evDepartureDays: [1, 2, 3, 4, 5],
      evTargetMode: 'percent', evTargetValue: 80, evConsumptionKwhPer100km: 18,
      evWeeklyPlan: OWNER_PLAN,
      ...extra
    }
  };
}

describe('Wochenplan: Uebernahme der alten Einstellung', () => {
  test('alte Uhrzeit + Tage → gleiche Abfahrt an diesen Tagen, keine Ankunft', () => {
    const plan = effectiveWeeklyPlan({ evDepartureTime: '07:00', evDepartureDays: [1, 2, 3, 4, 5] });
    assert.equal(plan.length, 7);
    assert.deepEqual(plan.map((e) => [e.day, e.arrival, e.departure, e.targetValue, e.commuteKm]), [
      [1, '', '07:00', null, null], [2, '', '07:00', null, null], [3, '', '07:00', null, null],
      [4, '', '07:00', null, null], [5, '', '07:00', null, null], [6, '', '', null, null], [7, '', '', null, null],
    ]);
  });

  test('ohne evWeeklyPlan rechnet DVhub exakt wie bisher (Di 20:00 → Mi 07:00, Fr abends → Mo)', () => {
    const legacy = cfg({ evWeeklyPlan: null });
    // Di 22.09.2026 20:00 CEST = 18:00Z → Mi 07:00 CEST = 05:00Z
    const r = resolveEvDeparture(legacy, at('2026-09-22T18:00:00Z'));
    assert.equal(r.departureAt, '2026-09-23T05:00:00.000Z');
    assert.equal(r.source, 'weekly');
    assert.equal(r.arrivalAt, null);
    assert.equal(r.targetSocPct, 80);
    // Fr 25.09. 20:00 CEST → Mo 28.09. 07:00 CEST = 05:00Z
    assert.equal(resolveEvDeparture(legacy, at('2026-09-25T18:00:00Z')).departureAt, '2026-09-28T05:00:00.000Z');
  });

  test('gespeicherter Plan geht vor den alten Feldern; fehlende Tage sind leer', () => {
    const plan = effectiveWeeklyPlan({ evDepartureTime: '07:00', evDepartureDays: [1, 2, 3, 4, 5], evWeeklyPlan: [{ day: 3, departure: '06:15' }] });
    assert.deepEqual(plan.map((e) => e.departure), ['', '', '06:15', '', '', '', '']);
  });
});

describe('Wochenplan: naechstes Fenster', () => {
  test('Di mittags: Ankunft heute 20:00, Abfahrt morgen 05:00 (ueber Mitternacht)', () => {
    // Di 22.09.2026 12:00 CEST = 10:00Z
    const r = resolveEvDeparture(cfg(), at('2026-09-22T10:00:00Z'));
    assert.equal(r.arrivalAt, '2026-09-22T18:00:00.000Z');
    assert.equal(r.departureAt, '2026-09-23T03:00:00.000Z');
    assert.equal(r.arrivalSource, 'weekly');
    assert.equal(r.day, 2);
    // Die Fahrt begann mit der Abfahrt Di 05:00 aus dem Montags-Eintrag.
    assert.equal(r.tripStartAt, '2026-09-22T03:00:00.000Z');
    assert.equal(r.targetSocPct, 80);
  });

  test('nach Mitternacht gilt noch dasselbe Fenster, kurz vor 05:00 schon das naechste', () => {
    // Mi 23.09. 00:30 CEST = Di 22:30Z
    assert.equal(resolveEvDeparture(cfg(), at('2026-09-22T22:30:00Z')).departureAt, '2026-09-23T03:00:00.000Z');
    // Mi 04:51 CEST = 02:51Z: 05:00 minus Vorlauf (10 min) ist vorbei
    const r = resolveEvDeparture(cfg(), at('2026-09-23T03:00:00Z') - DEPARTURE_LEAD_MS + 60_000);
    assert.equal(r.arrivalAt, '2026-09-23T18:00:00.000Z');
    assert.equal(r.departureAt, '2026-09-24T03:00:00.000Z');
  });

  test('Freitag: Ankunft 15:00, Abfahrt Samstag 09:00, eigenes Ziel 100 %', () => {
    // Fr 25.09. 10:00 CEST = 08:00Z
    const r = resolveEvDeparture(cfg(), at('2026-09-25T08:00:00Z'));
    assert.equal(r.arrivalAt, '2026-09-25T13:00:00.000Z');
    assert.equal(r.departureAt, '2026-09-26T07:00:00.000Z');
    assert.equal(r.targetSocPct, 100);
    assert.equal(r.day, 5);
  });

  test('Wochenende: nach Sa 09:00 ist Montag dran (So hat keinen Plan)', () => {
    // Sa 26.09. 10:00 CEST = 08:00Z → Mo 28.09. 20:00 CEST = 18:00Z, Di 05:00 = 03:00Z
    const r = resolveEvDeparture(cfg(), at('2026-09-26T08:00:00Z'));
    assert.equal(r.arrivalAt, '2026-09-28T18:00:00.000Z');
    assert.equal(r.departureAt, '2026-09-29T03:00:00.000Z');
    assert.equal(r.tripStartAt, '2026-09-26T07:00:00.000Z', 'letzte Abfahrt war Sa 09:00');
    assert.equal(r.targetSocPct, 80);
  });

  test('Zeitumstellung Herbst: Mo 26.10. 20:00 ist UTC+1', () => {
    // Sa 24.10.2026 10:00 CEST = 08:00Z → Mo 26.10. 20:00 CET = 19:00Z, Di 27.10. 05:00 CET = 04:00Z
    const r = resolveEvDeparture(cfg(), at('2026-10-24T08:00:00Z'));
    assert.equal(r.arrivalAt, '2026-10-26T19:00:00.000Z');
    assert.equal(r.departureAt, '2026-10-27T04:00:00.000Z');
  });

  test('Fenster ueber die Umstellungsnacht: Sa 22:00 CEST → So 05:00 CET (8 h statt 7 h)', () => {
    const plan = [{ day: 6, arrival: '22:00', departure: '05:00' }];
    const r = resolveEvDeparture(cfg({ evWeeklyPlan: plan }), at('2026-10-24T08:00:00Z'));
    assert.equal(r.arrivalAt, '2026-10-24T20:00:00.000Z');
    assert.equal(r.departureAt, '2026-10-25T04:00:00.000Z');
  });

  test('Zeitumstellung Fruehjahr: Sa 22:00 CET → So 05:00 CEST (6 h)', () => {
    const plan = [{ day: 6, arrival: '22:00', departure: '05:00' }];
    const r = resolveEvDeparture(cfg({ evWeeklyPlan: plan }), at('2026-03-28T08:00:00Z'));
    assert.equal(r.arrivalAt, '2026-03-28T21:00:00.000Z');
    assert.equal(r.departureAt, '2026-03-29T03:00:00.000Z');
  });

  test('nur Abfahrt eingetragen: Fenster ohne Ankunft', () => {
    const plan = [{ day: 3, departure: '07:30' }];
    const r = resolveEvDeparture(cfg({ evWeeklyPlan: plan }), at('2026-09-22T10:00:00Z'));
    assert.equal(r.departureAt, '2026-09-23T05:30:00.000Z');
    assert.equal(r.arrivalAt, null);
    assert.equal(r.arrivalSource, null);
  });

  test('Plan ganz leer: keine Abfahrt', () => {
    const r = resolveEvDeparture(cfg({ evWeeklyPlan: [] }), at('2026-09-22T10:00:00Z'));
    assert.equal(r.departureAt, null);
    assert.equal(r.reason, 'keine Abfahrt geplant');
  });

  test('ueber eine Woche in Minutenschritten: Abfahrt immer mind. den Vorlauf voraus, Ankunft davor', () => {
    const c = cfg();
    const start = at('2026-10-22T00:00:00Z');
    for (let t = start; t < start + 7 * 24 * 3600_000; t += 7 * 60_000) {
      const r = resolveEvDeparture(c, t);
      const d = Date.parse(r.departureAt);
      assert.ok(d - t >= DEPARTURE_LEAD_MS, `Abfahrt zu nah bei ${iso(t)}`);
      if (r.arrivalAt) assert.ok(Date.parse(r.arrivalAt) < d, `Ankunft nach Abfahrt bei ${iso(t)}`);
    }
  });
});

describe('Wochenplan: einmalige Abweichungen', () => {
  test('einmalige Abfahrt geht vor und behaelt die Ankunft des naechsten Fensters', () => {
    // Di 22.09. 12:00 CEST; einmalig Mi 06:30 CEST (= 04:30Z) statt 05:00
    const r = resolveEvDeparture(cfg({ evDepartureOnce: '2026-09-23T04:30:00.000Z' }), at('2026-09-22T10:00:00Z'));
    assert.equal(r.source, 'once');
    assert.equal(r.departureAt, '2026-09-23T04:30:00.000Z');
    assert.equal(r.arrivalAt, '2026-09-22T18:00:00.000Z');
    assert.equal(r.arrivalSource, 'weekly');
  });

  test('einmalige Ankunft ersetzt die des Fensters, in dessen Luecke sie faellt', () => {
    // heute spaeter: Di 23:00 CEST = 21:00Z
    const c = cfg({ evArrivalOnce: '2026-09-22T21:00:00.000Z' });
    const r = resolveEvDeparture(c, at('2026-09-22T10:00:00Z'));
    assert.equal(r.arrivalAt, '2026-09-22T21:00:00.000Z');
    assert.equal(r.arrivalSource, 'once');
    assert.equal(r.departureAt, '2026-09-23T03:00:00.000Z');
    // Nach der Abfahrt Mi 05:00 rollt alles weiter: Mi-Fenster wieder woechentlich.
    const next = resolveEvDeparture(c, at('2026-09-23T03:00:00Z'));
    assert.equal(next.arrivalAt, '2026-09-23T18:00:00.000Z');
    assert.equal(next.arrivalSource, 'weekly');
  });

  test('einmalige Ankunft nach der Abfahrt gehoert zum Folgefenster (Mi frueher heim)', () => {
    // Mi 16:00 CEST = 14:00Z liegt zwischen Mi 05:00 und Do 05:00
    const r = resolveEvDeparture(cfg({ evArrivalOnce: '2026-09-23T14:00:00.000Z' }), at('2026-09-22T10:00:00Z'));
    assert.equal(r.arrivalAt, '2026-09-22T18:00:00.000Z', 'heute gilt noch der Plan');
    const wed = resolveEvDeparture(cfg({ evArrivalOnce: '2026-09-23T14:00:00.000Z' }), at('2026-09-23T06:00:00Z'));
    assert.equal(wed.arrivalAt, '2026-09-23T14:00:00.000Z');
    assert.equal(wed.arrivalSource, 'once');
  });

  test('einmalige Ankunft + Abfahrt zusammen', () => {
    const c = cfg({ evArrivalOnce: '2026-09-26T16:00:00.000Z', evDepartureOnce: '2026-09-27T08:00:00.000Z' });
    // Sa 26.09. 10:00 CEST: eigentlich waere Mo dran — die einmalige Fahrt geht vor.
    const r = resolveEvDeparture(c, at('2026-09-26T08:00:00Z'));
    assert.equal(r.source, 'once');
    assert.equal(r.arrivalAt, '2026-09-26T16:00:00.000Z');
    assert.equal(r.arrivalSource, 'once');
    assert.equal(r.departureAt, '2026-09-27T08:00:00.000Z');
  });
});

describe('Wochenplan: Eingaben pruefen', () => {
  test('Plan wird auf 7 Tage normalisiert, Zeiten aufgefuellt, Tage sortiert', () => {
    const r = parseEvDeparturePatch({ weeklyPlan: [
      { day: 5, arrival: '15:00', departure: '9:00', targetValue: 100 },
      { day: 1, arrival: '', departure: '05:00', commuteKm: 25 },
    ] });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.patch.evWeeklyPlan.length, 7);
    assert.deepEqual(r.patch.evWeeklyPlan[0], { day: 1, arrival: '', departure: '05:00', targetValue: null, commuteKm: 25 });
    assert.deepEqual(r.patch.evWeeklyPlan[4], { day: 5, arrival: '15:00', departure: '09:00', targetValue: 100, commuteKm: null });
    assert.deepEqual(r.patch.evWeeklyPlan[6], { day: 7, arrival: '', departure: '', targetValue: null, commuteKm: null });
  });

  for (const [name, body, error] of [
    ['kein Array', { weeklyPlan: 'mo' }, 'departure.weeklyPlan must be a list of up to 7 days'],
    ['Tag doppelt', { weeklyPlan: [{ day: 1, departure: '05:00' }, { day: 1, departure: '06:00' }] }, 'departure.weeklyPlan[1].day must be a unique weekday 1..7'],
    ['Tag 8', { weeklyPlan: [{ day: 8, departure: '05:00' }] }, 'departure.weeklyPlan[0].day must be a unique weekday 1..7'],
    ['Uhrzeit kaputt', { weeklyPlan: [{ day: 1, departure: '25:00' }] }, 'departure.weeklyPlan[0].departure must be HH:MM or empty'],
    ['Ankunft ohne Abfahrt', { weeklyPlan: [{ day: 2, arrival: '20:00' }] }, 'departure.weeklyPlan[0].departure is required with an arrival'],
    ['Ziel negativ', { weeklyPlan: [{ day: 1, departure: '05:00', targetValue: -5 }] }, 'departure.weeklyPlan[0].targetValue must be 0..2000 or empty'],
    ['Heimweg zu weit', { weeklyPlan: [{ day: 1, departure: '05:00', commuteKm: 5000 }] }, 'departure.weeklyPlan[0].commuteKm must be 0..1000 or empty'],
    ['Heimweg allgemein', { commuteKm: -1 }, 'departure.commuteKm must be 0..1000'],
    ['einmalige Ankunft kaputt', { arrivalOnce: 'morgen' }, 'departure.arrivalOnce must be an ISO date time or empty'],
  ]) {
    test(`Fehler: ${name}`, () => {
      const r = parseEvDeparturePatch(body);
      assert.equal(r.ok, false);
      assert.equal(r.error, error);
    });
  }

  test('einmalige Ankunft: ISO normalisiert, leer = aus; Heimweg allgemein', () => {
    assert.equal(parseEvDeparturePatch({ arrivalOnce: '2026-09-26T18:00:00+02:00' }).patch.evArrivalOnce, '2026-09-26T16:00:00.000Z');
    assert.equal(parseEvDeparturePatch({ arrivalOnce: '' }).patch.evArrivalOnce, '');
    assert.equal(parseEvDeparturePatch({ commuteKm: 25 }).patch.evCommuteKm, 25);
  });

  test('alte Felder (Uhrzeit/Tage) ohne Plan: Plan zuruecksetzen, damit sie wieder gelten', () => {
    const r = parseEvDeparturePatch({ time: '06:45', days: [1, 2] });
    assert.equal(r.patch.evWeeklyPlan, null);
    const both = parseEvDeparturePatch({ time: '06:45', weeklyPlan: [{ day: 1, departure: '05:00' }] });
    assert.equal(both.patch.evWeeklyPlan.length, 7, 'mit Plan gewinnt der Plan');
  });
});

describe('Codex-Befunde Runde 1 (Wochenplan)', () => {
  test('verschobene Abfahrt behaelt ihr Fenster: Fr 15:00 → Sa 10:00 statt 09:00, Ziel 100 % bleibt nach 08:50', () => {
    // einmalig Sa 26.09. 10:00 CEST = 08:00Z; jetzt Sa 08:51 CEST = 06:51Z
    const r = resolveEvDeparture(cfg({ evDepartureOnce: '2026-09-26T08:00:00.000Z' }), at('2026-09-26T06:51:00Z'));
    assert.equal(r.source, 'once');
    assert.equal(r.departureAt, '2026-09-26T08:00:00.000Z');
    assert.equal(r.arrivalAt, '2026-09-25T13:00:00.000Z');
    assert.equal(r.targetSocPct, 100);
    assert.equal(r.tripStartAt, '2026-09-25T03:00:00.000Z', 'die ersetzte Sa-09:00-Abfahrt ist keine Fahrt');
  });

  test('Zeitzone oestlich von UTC+12 (Pacific/Auckland): Mo 20:00 → Di 05:00, nicht Mi', () => {
    // NZDT = UTC+13. Mo 26.10.2026 20:00 = 07:00Z; Di 27.10. 05:00 = Mo 16:00Z; jetzt Mo 10:00 NZDT = So 21:00Z
    const c = cfg({ evWeeklyPlan: [{ day: 1, arrival: '20:00', departure: '05:00' }] });
    c.schedule.timezone = 'Pacific/Auckland';
    const r = resolveEvDeparture(c, at('2026-10-25T21:00:00Z'));
    assert.equal(r.arrivalAt, '2026-10-26T07:00:00.000Z');
    assert.equal(r.departureAt, '2026-10-26T16:00:00.000Z');
  });

  test('Ankunft in der Luecke der Zeitumstellung (So 29.03. 02:30): keine Ankunft nach der Abfahrt', () => {
    const plan = [{ day: 7, arrival: '02:30', departure: '03:00' }];
    const r = resolveEvDeparture(cfg({ evWeeklyPlan: plan }), at('2026-03-28T12:00:00Z'));
    assert.equal(r.departureAt, '2026-03-29T01:00:00.000Z');
    assert.equal(r.arrivalAt, null);
  });
});

describe('Codex-Befunde Runde 2 (einmalige Abfahrt)', () => {
  test('vorgezogene Abfahrt (Fr 17:00 statt Sa 09:00, Fr mittags gesetzt) gehoert zum Fr-Fenster, nicht zur erledigten Fr-05:00-Fahrt', () => {
    // jetzt Fr 25.09. 12:00 CEST = 10:00Z; einmalig Fr 17:00 CEST = 15:00Z
    const r = resolveEvDeparture(cfg({ evDepartureOnce: '2026-09-25T15:00:00.000Z' }), at('2026-09-25T10:00:00Z'));
    assert.equal(r.departureAt, '2026-09-25T15:00:00.000Z');
    assert.equal(r.arrivalAt, '2026-09-25T13:00:00.000Z');
    assert.equal(r.targetSocPct, 100);
    assert.equal(r.tripStartAt, '2026-09-25T03:00:00.000Z', 'die Fr-05:00-Fahrt hat stattgefunden');
  });
});
