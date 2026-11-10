// test/ev-wochenplan-soc.test.js -- Wochenplan in SoC-%: Mindest-Ladestand je
// Abfahrt, Fahrtverbrauch, Einmal-Ziel, Max-Ladestand und die Fahrtenliste für
// die Vorausschau. Übernahme alter Pläne (Ziel in %/kWh/km, Heimweg in km).
//
// Zeiten von Hand gerechnet: Europe/Berlin im Winter UTC+1. Mo 16.11.2026.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  effectiveWeeklyPlan, migrateWeeklyPlanRows, resolveEvDeparture, parseEvDeparturePatch, buildEvTrips
} from '../services/optimizer/ev-departure.js';
import { estimateArrivalSoc } from '../services/optimizer/ev-arrival.js';
import { loadConfigFile, createDefaultConfig } from '../config-model.js';

const TZ = 'Europe/Berlin';
const at = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString();

// Mo–Do Ankunft 20:00, Abfahrt 05:00 (Folgetag); Fr Ankunft 15:00, Abfahrt Sa 09:00.
const OWNER_LEGACY = [
  { day: 1, arrival: '20:00', departure: '05:00' },
  { day: 2, arrival: '20:00', departure: '05:00' },
  { day: 3, arrival: '20:00', departure: '05:00' },
  { day: 4, arrival: '20:00', departure: '05:00' },
  { day: 5, arrival: '15:00', departure: '09:00', targetValue: 100, commuteKm: 50 },
];
const OPT = { evCapacityWh: 60000, evConsumptionKwhPer100km: 18, evTargetMode: 'percent', evTargetValue: 80 };

function cfg(extra = {}) {
  return {
    schedule: { timezone: TZ },
    optimizer: { eosOptimizeEv: true, evDepartureEnabled: true, ...OPT, ...extra }
  };
}

describe('Wochenplan in SoC-%: Übernahme alter Pläne', () => {
  test('Ziel in % wird Mindest-Ladestand; leeres Ziel bleibt leer (= allgemeiner Wert)', () => {
    const plan = migrateWeeklyPlanRows(OWNER_LEGACY, OPT);
    assert.equal(plan.length, 7);
    assert.equal(plan[4].minSocPct, 100);
    assert.equal(plan[0].minSocPct, null);
    for (const e of plan) {
      assert.ok(!('targetValue' in e), 'altes Feld verschwindet');
      assert.ok(!('commuteKm' in e), 'altes Feld verschwindet');
    }
  });

  test('Ziel in kWh/km wird einmalig in % umgerechnet', () => {
    const kwh = migrateWeeklyPlanRows([{ day: 1, departure: '07:00', targetValue: 30 }], { ...OPT, evTargetMode: 'kwh' });
    assert.equal(kwh[0].minSocPct, 50);
    const km = migrateWeeklyPlanRows([{ day: 1, departure: '07:00', targetValue: 200 }], { ...OPT, evTargetMode: 'km' });
    assert.equal(km[0].minSocPct, 60);
  });

  test('Heimweg (km, zur Ankunft der Zeile) wird Fahrtverbrauch der Abfahrt davor (Hin- und Rückweg)', () => {
    // Fr-Ankunft 15:00 kommt von der Abfahrt Fr 05:00 (Zeile Do, Folgetag): 50 km × 18 kWh/100 km = 9 kWh = 15 % je Weg.
    const plan = migrateWeeklyPlanRows(OWNER_LEGACY, OPT);
    assert.equal(plan[3].tripSocPct, 30);
    assert.equal(plan[0].tripSocPct, null);
    assert.equal(plan[4].tripSocPct, null);
  });

  test('allgemeiner Heimweg gilt für jede Zeile mit Ankunft ohne eigenen', () => {
    const plan = migrateWeeklyPlanRows(OWNER_LEGACY, { ...OPT, evCommuteKm: 20 });
    // 20 km = 3,6 kWh = 6 % je Weg → 12 % je Fahrt. Mo-Ankunft kommt von So? Nein: von der Abfahrt Sa 09:00 (Zeile Fr).
    assert.equal(plan[4].tripSocPct, 12, 'Sa 09:00 → Mo 20:00');
    assert.equal(plan[0].tripSocPct, 12, 'Di 05:00 → Di 20:00');
    assert.equal(plan[3].tripSocPct, 30, 'eigener Heimweg der Fr-Zeile gewinnt');
  });

  test('schon übernommene Zeilen bleiben, wie sie sind', () => {
    const plan = migrateWeeklyPlanRows([{ day: 2, arrival: '', departure: '07:00', minSocPct: 55, tripSocPct: 25 }], OPT);
    assert.deepEqual(plan[1], { day: 2, arrival: '', departure: '07:00', minSocPct: 55, tripSocPct: 25 });
  });

  test('alter Plan ohne evWeeklyPlan: Abfahrten aus Uhrzeit + Tagen, ohne Ziele', () => {
    const plan = effectiveWeeklyPlan({ evDepartureTime: '07:00', evDepartureDays: [1, 2] });
    assert.deepEqual(plan[0], { day: 1, arrival: '', departure: '07:00', minSocPct: null, tripSocPct: null });
  });

  test('Konfig-Migration beim Laden: gespeicherter Plan in SoC-%, neue Felder mit Vorgaben', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dvhub-evplan-'));
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({ manufacturer: 'victron', optimizer: { ...OPT, evCommuteKm: 0, evWeeklyPlan: OWNER_LEGACY } }));
    const { persistedConfig } = loadConfigFile(p);
    const opt = persistedConfig.optimizer;
    assert.equal(opt.evWeeklyPlan[4].minSocPct, 100);
    assert.equal(opt.evWeeklyPlan[3].tripSocPct, 30);
    assert.ok(!('targetValue' in opt.evWeeklyPlan[4]));
    assert.equal(opt.evMaxSocPct, 80);
    assert.equal(opt.evValueMarginCt, 1);
    assert.equal(opt.evDepartureOnceMinSocPct, null);
    assert.equal(opt.evDepartureOnceTripSocPct, null);
  });

  test('Konfig-Migration: allgemeines Ziel in km/kWh wird einmalig % (Ziele nie in km)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dvhub-evplan-'));
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({ manufacturer: 'victron', optimizer: { ...OPT, evTargetMode: 'km', evTargetValue: 200, evWeeklyPlan: [{ day: 1, departure: '07:00', targetValue: 100 }] } }));
    const opt = loadConfigFile(p).persistedConfig.optimizer;
    assert.equal(opt.evTargetMode, 'percent');
    assert.equal(opt.evTargetValue, 60, '200 km × 18 kWh/100 km = 36 kWh von 60 kWh');
    assert.equal(opt.evWeeklyPlan[0].minSocPct, 30, 'Zeile mit der alten Einheit umgerechnet (100 km)');
  });

  test('Vorgaben: Max 80 %, Abschlag 1 ct', () => {
    const d = createDefaultConfig().optimizer;
    assert.equal(d.evMaxSocPct, 80);
    assert.equal(d.evValueMarginCt, 1);
  });
});

describe('Wochenplan in SoC-%: Eingaben', () => {
  test('Zeile mit Mindest-Ladestand und Fahrt in %', () => {
    const r = parseEvDeparturePatch({ weeklyPlan: [{ day: 2, departure: '07:00', arrival: '18:00', minSocPct: 50, tripSocPct: 30 }] });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.patch.evWeeklyPlan[1], { day: 2, arrival: '18:00', departure: '07:00', minSocPct: 50, tripSocPct: 30 });
  });

  for (const [name, body, error] of [
    ['Mindest über 100', { weeklyPlan: [{ day: 1, departure: '05:00', minSocPct: 120 }] }, 'departure.weeklyPlan[0].minSocPct must be 0..100 or empty'],
    ['Fahrt negativ', { weeklyPlan: [{ day: 1, departure: '05:00', tripSocPct: -1 }] }, 'departure.weeklyPlan[0].tripSocPct must be 0..100 or empty'],
    ['Max 0', { maxSocPct: 0 }, 'departure.maxSocPct must be 10..100 or empty'],
    ['Einmal-Ziel 101', { onceMinSocPct: 101 }, 'departure.onceMinSocPct must be 0..100 or empty'],
    ['Abschlag negativ', { valueMarginCt: -1 }, 'departure.valueMarginCt must be 0..50'],
  ]) {
    test(`Fehler: ${name}`, () => {
      const r = parseEvDeparturePatch(body);
      assert.equal(r.ok, false);
      assert.equal(r.error, error);
    });
  }

  test('Max-Ladestand, Einmal-Ziel und Abschlag landen im Patch; leer = aus', () => {
    const r = parseEvDeparturePatch({ maxSocPct: 85, onceMinSocPct: 75, onceTripSocPct: 45, valueMarginCt: 2 });
    assert.deepEqual(r.patch, { evMaxSocPct: 85, evDepartureOnceMinSocPct: 75, evDepartureOnceTripSocPct: 45, evValueMarginCt: 2 });
    const off = parseEvDeparturePatch({ maxSocPct: '', onceMinSocPct: null });
    assert.deepEqual(off.patch, { evMaxSocPct: null, evDepartureOnceMinSocPct: null });
  });

  test('alte Oberfläche (Ziel/Heimweg je Zeile) wird beim Speichern umgerechnet', () => {
    const r = parseEvDeparturePatch({ weeklyPlan: OWNER_LEGACY }, 'departure', { opt: OPT });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.patch.evWeeklyPlan[4].minSocPct, 100);
    assert.equal(r.patch.evWeeklyPlan[3].tripSocPct, 30);
  });
});

describe('Wochenplan in SoC-%: Auflösung', () => {
  const plan = [
    { day: 2, arrival: '', departure: '07:00', minSocPct: 50, tripSocPct: 30 },
    { day: 3, arrival: '', departure: '07:00', minSocPct: 50, tripSocPct: 30 },
  ];
  test('Mindest-Ladestand der Zeile; ohne eigenen der allgemeine', () => {
    // Mo 16.11. 20:00 = 19:00Z → Di 07:00 = 06:00Z
    const r = resolveEvDeparture(cfg({ evWeeklyPlan: plan }), at('2026-11-16T19:00:00Z'));
    assert.equal(r.departureAt, '2026-11-17T06:00:00.000Z');
    assert.equal(r.targetSocPct, 50);
    assert.equal(r.tripSocPct, 30);
    const g = resolveEvDeparture(cfg({ evWeeklyPlan: [{ day: 2, departure: '07:00' }] }), at('2026-11-16T19:00:00Z'));
    assert.equal(g.targetSocPct, 80);
  });

  test('Einmal-Ziel „morgen einmal 75 % bis 08:00“ ersetzt das Ziel, nicht den Wochenplan', () => {
    const c = cfg({ evWeeklyPlan: plan, evDepartureOnce: '2026-11-17T07:00:00.000Z', evDepartureOnceMinSocPct: 75, evDepartureOnceTripSocPct: 45 });
    const r = resolveEvDeparture(c, at('2026-11-16T19:00:00Z'));
    assert.equal(r.source, 'once');
    assert.equal(r.departureAt, '2026-11-17T07:00:00.000Z');
    assert.equal(r.targetSocPct, 75);
    assert.equal(r.tripSocPct, 45);
    assert.deepEqual(c.optimizer.evWeeklyPlan, plan, 'Wochenplan unverändert');
    // nach der Abfahrt: wieder der Wochenplan (Mi 07:00, 50 %)
    const after = resolveEvDeparture(c, at('2026-11-17T07:00:00Z'));
    assert.equal(after.departureAt, '2026-11-18T06:00:00.000Z');
    assert.equal(after.targetSocPct, 50);
  });

  test('Einmal-Abfahrt ohne eigenes Ziel: Ziel und Fahrt des ersetzten Fensters', () => {
    const c = cfg({ evWeeklyPlan: plan, evDepartureOnce: '2026-11-17T08:00:00.000Z' });
    const r = resolveEvDeparture(c, at('2026-11-16T19:00:00Z'));
    assert.equal(r.targetSocPct, 50);
    assert.equal(r.tripSocPct, 30);
  });
});

describe('Fahrtenliste für die Vorausschau (buildEvTrips)', () => {
  const plan = [
    { day: 2, arrival: '', departure: '07:00', minSocPct: 50, tripSocPct: 30 },
    { day: 3, arrival: '', departure: '07:00', minSocPct: 50, tripSocPct: 30 },
    { day: 6, arrival: '', departure: '09:00', minSocPct: 45, tripSocPct: 40 },
  ];
  test('Abfahrt, Rückkehr = Ankunft des nächsten Fensters, Fahrt und Mindestziel je Fahrt', () => {
    const { trips } = buildEvTrips(cfg({ evWeeklyPlan: plan.slice(0, 3) }), at('2026-11-16T19:00:00Z'), { days: 8 });
    const first = trips.filter((t) => t.depMs > at('2026-11-16T19:00:00Z')).slice(0, 3);
    assert.deepEqual(first.map((t) => [iso(t.depMs), iso(t.retMs), t.tripPct, t.minPct]), [
      // Ohne Ankunftszeit ist die Rückkehr unbekannt: DVhub nimmt an, das Auto ist gleich wieder da.
      ['2026-11-17T06:00:00.000Z', '2026-11-17T06:00:00.000Z', 30, 50],
      ['2026-11-18T06:00:00.000Z', '2026-11-18T06:00:00.000Z', 30, 50],
      ['2026-11-21T08:00:00.000Z', '2026-11-21T08:00:00.000Z', 40, 45],
    ]);
  });

  test('mit Ankunftszeiten: Rückkehr zur Ankunft des nächsten Fensters', () => {
    const p = [1, 2, 3, 4, 5].map((day) => ({ day, arrival: '18:00', departure: '07:30', minSocPct: 45, tripSocPct: 25 }));
    // Mo 16.11. 12:00 = 11:00Z; Fenster Mo 18:00 → Di 07:30 usw.
    const { trips } = buildEvTrips(cfg({ evWeeklyPlan: p }), at('2026-11-16T11:00:00Z'), { days: 8 });
    const t = trips.find((x) => x.depMs === at('2026-11-17T06:30:00Z'));
    assert.equal(iso(t.retMs), '2026-11-17T17:00:00.000Z');
    assert.equal(t.tripPct, 25);
    assert.equal(t.minPct, 45);
    // Abfahrt 07:30 liegt vor der Ankunft 18:00 → Folgetag: Abfahrten Di–Sa. Die
    // laufende Fahrt (Sa 14.11. 07:30 → Mo 18:00) ist dabei, als „unterwegs“.
    const cur = trips.find((x) => x.src === 'current');
    assert.equal(iso(cur.depMs), '2026-11-14T06:30:00.000Z');
    assert.equal(iso(cur.retMs), '2026-11-16T17:00:00.000Z');
    assert.equal(cur.tripPct, 25);
  });

  test('Einmal-Ziel mitten im Plan: ersetzt die eine Fahrt, nicht mehr', () => {
    const p = [1, 2, 3, 4, 5].map((day) => ({ day, arrival: '18:00', departure: '07:30', minSocPct: 45, tripSocPct: 25 }));
    const c = cfg({ evWeeklyPlan: p, evDepartureOnce: '2026-11-18T05:00:00.000Z', evDepartureOnceMinSocPct: 80, evDepartureOnceTripSocPct: 60 });
    const { trips } = buildEvTrips(c, at('2026-11-16T11:00:00Z'), { days: 8 });
    const wed = trips.filter((x) => x.depMs >= at('2026-11-18T00:00:00Z') && x.depMs < at('2026-11-19T00:00:00Z'));
    assert.deepEqual(wed.map((x) => [iso(x.depMs), x.minPct, x.tripPct, x.src]), [['2026-11-18T05:00:00.000Z', 80, 60, 'once']]);
  });

  test('vorgezogene Einmal-Abfahrt: nach ihr kehrt die ersetzte reguläre nicht zurück', () => {
    const p = [1, 2, 3, 4, 5].map((day) => ({ day, arrival: '18:00', departure: '07:30', minSocPct: 45, tripSocPct: 25 }));
    // Mi 06:00 statt 07:30
    const c = cfg({ evWeeklyPlan: p, evDepartureOnce: '2026-11-18T05:00:00.000Z', evDepartureOnceMinSocPct: 60 });
    const r = resolveEvDeparture(c, at('2026-11-18T05:30:00Z'));
    assert.equal(r.departureAt, '2026-11-19T06:30:00.000Z', 'Do 07:30, nicht die ersetzte Mi-07:30-Fahrt');
  });
});

describe('Erwarteter Ladestand bei Ankunft mit Fahrt in %', () => {
  const NOW = at('2026-11-17T15:00:00Z');
  const START = at('2026-11-17T06:00:00Z');
  test('Wert von vor der Abfahrt: ganze Fahrt ab, abgerundet', () => {
    const r = estimateArrivalSoc({ plugged: false, reading: { pct: 70.6, source: 'evcc', atMs: START - 3600_000 }, tripStartMs: START, tripPct: 30.3, nowMs: NOW });
    assert.equal(r.pct, 40);
    assert.equal(r.deductPct, 30.3);
  });
  test('Wert vom Auto nach der Abfahrt: nur noch die Rückfahrt (halbe Fahrt)', () => {
    const r = estimateArrivalSoc({ plugged: false, reading: { pct: 60, source: 'teslamate', atMs: NOW - 60_000 }, tripStartMs: START, tripPct: 30, nowMs: NOW });
    assert.equal(r.pct, 45);
    assert.equal(r.source, 'live');
  });
});

describe('Codex 52c5ee20: Einmal-Fahrt bleibt bis zur nächsten echten Abfahrt', () => {
  test('Fr 17:00 statt Sa 09:00 mit 60 % Fahrt: am Sonntagabend zählt noch die Einmal-Fahrt', () => {
    const p = [
      { day: 5, arrival: '15:00', departure: '09:00', minSocPct: 50, tripSocPct: 30 },
      { day: 1, arrival: '18:00', departure: '07:00', minSocPct: 50, tripSocPct: 20 },
    ];
    // Fr 20.11. 17:00 = 16:00Z; Sonntag 22.11. 20:00 = 19:00Z, Ankunft Mo 23.11. 18:00
    const c = cfg({ evWeeklyPlan: p, evDepartureOnce: '2026-11-20T16:00:00.000Z', evDepartureOnceTripSocPct: 60 });
    const r = resolveEvDeparture(c, at('2026-11-22T19:00:00Z'));
    assert.equal(r.tripStartAt, '2026-11-20T16:00:00.000Z');
    assert.equal(r.prevTripSocPct, 60);
  });
});
