// test/ev-departure.test.js -- Abfahrtszeit + Ziel-Ladestand fuer EOS.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEvDeparture, nextWeeklyDeparture, targetSocPct, zonedToUtcMs, DEPARTURE_LEAD_MS,
  parseEvDeparturePatch, summarizeEvPlan
} from '../services/optimizer/ev-departure.js';
import { buildEosElectricVehicles } from '../services/optimizer/eos-config-sync.js';

const TZ = 'Europe/Berlin';
// Dienstag, 22.09.2026 20:00 Ortszeit (CEST, UTC+2)
const TUE_20H = Date.parse('2026-09-22T18:00:00Z');

function cfg(extra = {}) {
  return {
    schedule: { timezone: TZ },
    optimizer: {
      eosOptimizeEv: true, evCapacityWh: 60000,
      evDepartureEnabled: true, evDepartureTime: '07:00', evDepartureDays: [1, 2, 3, 4, 5],
      evTargetMode: 'percent', evTargetValue: 80, evConsumptionKwhPer100km: 18,
      ...extra
    }
  };
}

describe('ev-departure: Zeiten', () => {
  test('Ortszeit → UTC, Sommer- und Winterzeit', () => {
    assert.equal(new Date(zonedToUtcMs(2026, 9, 23, 7, 0, TZ)).toISOString(), '2026-09-23T05:00:00.000Z');
    assert.equal(new Date(zonedToUtcMs(2026, 12, 1, 7, 0, TZ)).toISOString(), '2026-12-01T06:00:00.000Z');
  });

  test('naechste woechentliche Abfahrt: morgen frueh, am Freitagabend erst Montag', () => {
    assert.equal(new Date(nextWeeklyDeparture({ time: '07:00', days: [1, 2, 3, 4, 5], timeZone: TZ, nowMs: TUE_20H })).toISOString(),
      '2026-09-23T05:00:00.000Z');
    const fri20h = Date.parse('2026-09-25T18:00:00Z');
    assert.equal(new Date(nextWeeklyDeparture({ time: '07:00', days: [1, 2, 3, 4, 5], timeZone: TZ, nowMs: fri20h })).toISOString(),
      '2026-09-28T05:00:00.000Z');
  });

  test('ueber die Zeitumstellung (25.10.2026): Montag 07:00 ist wieder UTC+1', () => {
    const sat = Date.parse('2026-10-24T12:00:00Z');
    assert.equal(new Date(nextWeeklyDeparture({ time: '07:00', days: [1], timeZone: TZ, nowMs: sat })).toISOString(),
      '2026-10-26T06:00:00.000Z');
  });

  test('Vorlauf: kurz vor der Abfahrt ist schon die naechste dran — nie ein vergangener Termin', () => {
    const dep = Date.parse('2026-09-23T05:00:00Z');
    const justBefore = dep - DEPARTURE_LEAD_MS + 1000;
    const next = nextWeeklyDeparture({ time: '07:00', days: [1, 2, 3, 4, 5], timeZone: TZ, nowMs: justBefore });
    assert.equal(new Date(next).toISOString(), '2026-09-24T05:00:00.000Z');
    // Ueber einen ganzen Tag in Minutenschritten: jeder Termin liegt mindestens
    // den Vorlauf in der Zukunft.
    for (let t = TUE_20H; t < TUE_20H + 24 * 3600_000; t += 60_000) {
      const d = Date.parse(resolveEvDeparture(cfg(), t).departureAt);
      assert.ok(d - t > DEPARTURE_LEAD_MS - 1, `Termin zu nah bei ${new Date(t).toISOString()}`);
    }
  });

  test('keine Tage / kaputte Uhrzeit: keine Abfahrt', () => {
    assert.equal(nextWeeklyDeparture({ time: '07:00', days: [], timeZone: TZ, nowMs: TUE_20H }), null);
    assert.equal(nextWeeklyDeparture({ time: '25:00', days: [1], timeZone: TZ, nowMs: TUE_20H }), null);
  });
});

describe('ev-departure: Ziel', () => {
  test('% / kWh / km → Ladestand', () => {
    assert.equal(targetSocPct({ mode: 'percent', value: 80, capacityWh: 60000 }), 80);
    assert.equal(targetSocPct({ mode: 'kwh', value: 45, capacityWh: 60000 }), 75);
    // 250 km × 18 kWh/100 km = 45 kWh von 60 kWh
    assert.equal(targetSocPct({ mode: 'km', value: 250, capacityWh: 60000, consumptionKwhPer100km: 18 }), 75);
    assert.equal(targetSocPct({ mode: 'km', value: 900, capacityWh: 60000, consumptionKwhPer100km: 18 }), 100, 'begrenzt auf 100');
    assert.equal(targetSocPct({ mode: 'km', value: 100, capacityWh: 60000, consumptionKwhPer100km: 0 }), null);
  });
});

describe('ev-departure: aufgeloest', () => {
  test('einmalige Abfahrt geht vor, solange sie kommt', () => {
    const once = '2026-09-26T07:30:00.000Z';
    const r = resolveEvDeparture(cfg({ evDepartureOnce: once }), TUE_20H);
    assert.equal(r.source, 'once');
    assert.equal(r.departureAt, once);
    const after = resolveEvDeparture(cfg({ evDepartureOnce: once }), Date.parse(once));
    assert.equal(after.source, 'weekly', 'vorbei → wieder die woechentliche');
  });

  test('aus: keine Abfahrt, kein Ziel', () => {
    const r = resolveEvDeparture(cfg({ evDepartureEnabled: false }), TUE_20H);
    assert.equal(r.enabled, false);
    assert.equal(r.departureAt, null);
  });
});

describe('buildEosElectricVehicles mit Abfahrt', () => {
  test('EOS 0.4: Ziel + Uhrzeit', () => {
    const [ev] = buildEosElectricVehicles(cfg({ evTargetMode: 'km', evTargetValue: 250 }), { supportsDeadline: true, nowMs: TUE_20H });
    assert.equal(ev.min_soc_percentage, 75);
    assert.equal(ev.min_soc_deadline_datetime, '2026-09-23T05:00:00.000Z');
  });

  test('aeltere EOS-Fassung: nur das Ziel, kein unbekanntes Feld', () => {
    const [ev] = buildEosElectricVehicles(cfg(), { supportsDeadline: false, nowMs: TUE_20H });
    assert.equal(ev.min_soc_percentage, 80);
    assert.equal('min_soc_deadline_datetime' in ev, false);
  });

  test('Abfahrt aus: allgemeiner Ziel-SoC, Uhrzeit ausdruecklich null', () => {
    const [ev] = buildEosElectricVehicles(cfg({ evDepartureEnabled: false, evMinSocPct: 60 }), { supportsDeadline: true, nowMs: TUE_20H });
    assert.equal(ev.min_soc_percentage, 60);
    assert.equal(ev.min_soc_deadline_datetime, null);
  });
});

describe('Eingaben pruefen (Integrationsseite + Leitstand-Kachel)', () => {
  test('nur uebergebene Felder landen im Patch', () => {
    const r = parseEvDeparturePatch({ time: '7:05', days: [5, 1, 1, 9, 3], targetValue: 80 });
    assert.deepEqual(r, { ok: true, patch: { evDepartureTime: '07:05', evDepartureDays: [1, 3, 5], evTargetValue: 80 } });
  });
  test('Fehler mit Praefix', () => {
    assert.equal(parseEvDeparturePatch({ time: '25:00' }, 'eos.departure').error, 'eos.departure.time must be HH:MM');
    assert.equal(parseEvDeparturePatch({ targetMode: 'meilen' }).error, 'departure.targetMode must be percent|kwh|km');
    assert.equal(parseEvDeparturePatch({ targetValue: -1 }).ok, false);
    assert.equal(parseEvDeparturePatch('x').ok, false);
  });
  test('einmalige Abfahrt: ISO normalisiert, leer = aus', () => {
    assert.equal(parseEvDeparturePatch({ once: '2026-09-26T09:30:00+02:00' }).patch.evDepartureOnce, '2026-09-26T07:30:00.000Z');
    assert.equal(parseEvDeparturePatch({ once: '' }).patch.evDepartureOnce, '');
  });
});

describe('EOS-Plan fuers Auto (Leitstand-Kachel)', () => {
  const NOW = Date.parse('2026-09-23T15:05:00Z');
  const row = (iso, f, soc) => ({ ts_utc: iso, evChargeFactor: f, evSocPct: soc });
  const rows = [
    row('2026-09-23T14:45:00Z', 1, 60),   // vorbei
    row('2026-09-23T15:00:00Z', 0, 68),   // laeuft gerade
    row('2026-09-23T22:15:00Z', 0.5, 68),
    row('2026-09-23T22:30:00Z', 1, 72),
    row('2026-09-23T22:45:00Z', 0, 78),
    row('2026-09-24T06:30:00Z', 0.2, 78),
    row('2026-09-24T06:45:00Z', 0, 80),
    row('2026-09-24T07:00:00Z', 0, 80),   // Abfahrts-Slot
    row('2026-09-24T09:00:00Z', 1, 80)    // nach der Abfahrt: zaehlt nicht
  ];
  const opts = { maxChargeW: 11000, nowMs: NOW, departureAt: '2026-09-24T07:00:00.000Z', targetSocPct: 80, horizonMs: 24 * 3600_000 };

  test('Energie, Fenster, Ziel erreicht — nur bis zur Abfahrt', () => {
    const p = summarizeEvPlan(rows, opts);
    assert.equal(p.hasEv, true);
    assert.equal(p.slots[0].ts, '2026-09-23T15:00:00.000Z', 'laufender Slot bleibt, vergangener faellt weg');
    // 5,5 kW + 11 kW + 2,2 kW je 15 min = 4,675 kWh
    assert.equal(p.energyKwh, 4.7);
    assert.equal(p.socAtDeparture, 80);
    assert.equal(p.targetReachedAt, '2026-09-24T06:45:00.000Z');
    assert.deepEqual(p.windows.map((w) => [w.start, w.end, w.maxW, w.kwh]), [
      ['2026-09-23T22:15:00.000Z', '2026-09-23T22:45:00.000Z', 11000, 4.1],
      ['2026-09-24T06:30:00.000Z', '2026-09-24T06:45:00.000Z', 2200, 0.6]
    ]);
  });

  test('Ziel verfehlt: kein targetReachedAt, Ladestand bei Abfahrt sichtbar', () => {
    const p = summarizeEvPlan(rows, { ...opts, targetSocPct: 90 });
    assert.equal(p.targetReachedAt, null);
    assert.equal(p.socAtDeparture, 80);
  });

  test('EOS ohne E-Auto-Werte: hasEv false', () => {
    const p = summarizeEvPlan([{ ts_utc: '2026-09-23T15:00:00Z' }], opts);
    assert.equal(p.hasEv, false);
    assert.equal(p.energyKwh, 0);
  });
});
