// test/price-estimate.test.js — Börsenpreise über die bekannten Day-Ahead-
// Preise hinaus schätzen (Christin 01.11.2026, EOS-Schwanz „effective 0.5 h“).

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  capOutliers,
  forecastSpotPrices,
  fillPriceSlots,
  regularHistory,
  SLOT_MS,
} from '../services/optimizer/price-estimate.js';

const DAY = 96;
const T0 = Date.UTC(2026, 9, 1, 0, 0); // Do 01.10.2026 00:00 UTC

// Tagesmuster: nachts billig, abends teuer; Wochenende 5 ct billiger.
function priceAt(i, { weekend = true } = {}) {
  const slotOfDay = i % DAY;
  const day = Math.floor(i / DAY);
  const weekday = (4 + day) % 7; // 01.10.2026 ist ein Donnerstag
  const base = 10 + 8 * Math.sin(((slotOfDay - 30) / DAY) * 2 * Math.PI);
  return base - (weekend && (weekday === 0 || weekday === 6) ? 5 : 0);
}

function history(days, opts) {
  return Array.from({ length: days * DAY }, (_, i) => ({ ms: T0 + i * SLOT_MS, ct: priceAt(i, opts) }));
}

test('capOutliers kappt auf Mittelwert ± sigma·Standardabweichung', () => {
  const out = capOutliers([0, 0, 0, 0, 0, 0, 0, 0, 0, 100], 2);
  assert.ok(out[9] < 100 && out[9] > 0);
  assert.deepEqual(out.slice(0, 9), new Array(9).fill(0));
});

test('regularHistory überbrückt Lücken linear und endet am letzten bekannten Slot', () => {
  const pts = [{ ms: T0, ct: 10 }, { ms: T0 + 3 * SLOT_MS, ct: 16 }];
  assert.deepEqual(regularHistory(pts, T0 + 3 * SLOT_MS), [10, 12, 14, 16]);
  // Letzter Slot fehlt → keine Reihe (sonst würde fortgeschrieben, was fehlt)
  assert.deepEqual(regularHistory(pts, T0 + 4 * SLOT_MS), []);
});

test('zu wenig Historie (unter zwei Tagen): keine Schätzung', () => {
  const pts = history(1);
  assert.equal(forecastSpotPrices(pts, pts[pts.length - 1].ms, 96), null);
});

test('ab zwei Tagen: Tages-Saison setzt das Tagesmuster fort', () => {
  const pts = history(5, { weekend: false });
  const lastMs = pts[pts.length - 1].ms;
  const fc = forecastSpotPrices(pts, lastMs, 2 * DAY);
  assert.equal(fc.method, 'ets-daily');
  const n = pts.length;
  for (let h = 1; h <= 2 * DAY; h += 1) {
    assert.ok(Math.abs(fc.values[h - 1] - priceAt(n - 1 + h, { weekend: false })) < 0.5, `Slot ${h}`);
  }
});

test('ab zwei Wochen: Wochen-Saison kennt das billigere Wochenende', () => {
  // 15 Tage ab Do 01.10. → letzter bekannter Tag Do 15.10.; Sa 17.10. ist Tag 16.
  const pts = history(15);
  const lastMs = pts[pts.length - 1].ms;
  const fc = forecastSpotPrices(pts, lastMs, 3 * DAY);
  assert.equal(fc.method, 'ets-weekly');
  const n = pts.length;
  const fri = fc.values.slice(0, DAY).reduce((s, v) => s + v, 0) / DAY;
  const sat = fc.values.slice(DAY, 2 * DAY).reduce((s, v) => s + v, 0) / DAY;
  assert.ok(fri - sat > 3, `Freitag ${fri.toFixed(2)} vs. Samstag ${sat.toFixed(2)}`);
  assert.ok(Math.abs(fc.values[DAY + 70] - priceAt(n + DAY + 70)) < 1);
});

function slotsFrom(startIdx, count) {
  return Array.from({ length: count }, (_, k) => {
    const i = startIdx + k;
    return {
      start: new Date(T0 + i * SLOT_MS).toISOString(),
      end: new Date(T0 + (i + 1) * SLOT_MS).toISOString(),
      ctKwh: priceAt(i),
    };
  });
}

test('fillPriceSlots verlängert hinter dem letzten echten Slot bis untilMs, echte bleiben', () => {
  // Datenbank-Historie 20 Tage, dazu die echten Slots von heute (Tag 20).
  const hist = history(20);
  const real = slotsFrom(20 * DAY, DAY);
  const untilMs = T0 + (23 * DAY + 7) * SLOT_MS;
  const { slots, estimate } = fillPriceSlots(real, { history: hist, untilMs, nowMs: T0 + 20 * DAY * SLOT_MS });
  assert.deepEqual(slots.slice(0, DAY), real);
  const added = slots.slice(DAY);
  assert.equal(added.length, 2 * DAY + 7);
  assert.ok(added.every((s) => s.estimated === true));
  assert.equal(added[0].start, new Date(T0 + 21 * DAY * SLOT_MS).toISOString());
  assert.equal(estimate.estimatedSlots, 2 * DAY + 7);
  assert.equal(estimate.from, added[0].start);
  assert.equal(estimate.until, new Date(untilMs).toISOString());
  assert.equal(estimate.method, 'ets-weekly');
});

test('fillPriceSlots: echte Slots reichen schon bis untilMs → unverändert', () => {
  const real = slotsFrom(20 * DAY, DAY);
  const r = fillPriceSlots(real, { history: history(20), untilMs: T0 + 21 * DAY * SLOT_MS, nowMs: T0 + 20 * DAY * SLOT_MS });
  assert.equal(r.slots, real);
  assert.equal(r.estimate, null);
});

test('fillPriceSlots: zu wenig Historie oder gar keine echten Preise → unverändert', () => {
  const real = slotsFrom(0, DAY);
  const r = fillPriceSlots(real, { history: [], untilMs: T0 + 3 * DAY * SLOT_MS, nowMs: T0 });
  assert.equal(r.slots, real);
  assert.equal(r.estimate, null);
  const none = fillPriceSlots([], { history: history(20), untilMs: T0 + 30 * DAY * SLOT_MS });
  assert.deepEqual(none.slots, []);
  assert.equal(none.estimate, null);
});

test('fillPriceSlots: echte Preise decken „jetzt“ nicht ab → keine Schätzung (EOS nicht ganz auf Schätzwerten)', () => {
  const real = slotsFrom(20 * DAY, DAY);
  const nowMs = T0 + (21 * DAY + 4) * SLOT_MS; // nach dem letzten echten Slot
  const r = fillPriceSlots(real, { history: history(20), untilMs: T0 + 23 * DAY * SLOT_MS, nowMs });
  assert.equal(r.slots, real);
  assert.equal(r.estimate, null);
});

test('fillPriceSlots: Stundenpreise — geschätzt wird erst hinter der letzten vollen Stunde', () => {
  const real = Array.from({ length: 24 }, (_, h) => {
    const i = 20 * DAY + h * 4;
    return { start: new Date(T0 + i * SLOT_MS).toISOString(), ctKwh: priceAt(i) };
  });
  const { slots, estimate } = fillPriceSlots(real, { history: history(20), untilMs: T0 + 22 * DAY * SLOT_MS, nowMs: T0 + 20 * DAY * SLOT_MS });
  assert.equal(estimate.from, new Date(T0 + 21 * DAY * SLOT_MS).toISOString());
  // In der Kadenz der echten Preise: stündlich (Gegenprüfung 8c050aae).
  assert.equal(slots.length, 24 + 24);
  assert.ok(slots.slice(24).every((x) => Date.parse(x.end) - Date.parse(x.start) === 4 * SLOT_MS));
});

// Codex-Gegenprüfung Branch (P2): EOS' Steuerzeitraum ist mindestens 1 h —
// enden die echten Preise früher als jetzt + 1 h 15 min, lägen Schätzwerte
// im Steuerzeitraum. Dann nicht schätzen.
test('fillPriceSlots: echte Preise reichen nicht über den Mindest-Steuerzeitraum → keine Schätzung', () => {
  const real = slotsFrom(20 * DAY, DAY);
  const realEnd = T0 + 21 * DAY * SLOT_MS;
  const r = fillPriceSlots(real, { history: history(20), untilMs: realEnd + DAY * SLOT_MS, nowMs: realEnd - 60 * 60_000 });
  assert.equal(r.estimate, null);
  const ok = fillPriceSlots(real, { history: history(20), untilMs: realEnd + DAY * SLOT_MS, nowMs: realEnd - 75 * 60_000 });
  assert.ok(ok.estimate);
});

// ── Gesamtprüfung Release 1.0.9: Zeitumstellung ───────────────────────────────
// Die Saison lief auf dem UTC-Raster (96 Slots je UTC-Tag). Börsenpreise folgen
// aber der Ortszeit: nach der Umstellung (25.10.2026) lag die geschätzte
// Abendspitze eine Stunde daneben.
test('Zeitumstellung: die geschätzte Abendspitze bleibt bei 18 Uhr Ortszeit', async () => {
  const { zoneOffsetMs } = await import('../tz-fast.js');
  const Q = 15 * 60 * 1000;
  const localHour = (ms) => new Date(ms + zoneOffsetMs(ms, 'Europe/Berlin')).getUTCHours();
  const price = (ms) => (localHour(ms) === 18 ? 40 : 10);
  // Echte Preise 20 Tage bis Fr 30.10. 23:00 Ortszeit (= 22:00 UTC), Umstellung am 25.10.
  const end = Date.parse('2026-10-30T23:00:00Z');
  const real = [];
  for (let ms = end - 20 * 86_400_000; ms < end; ms += Q) real.push({ start: new Date(ms).toISOString(), ctKwh: price(ms) });
  const nowMs = end - 10 * 3_600_000;
  const r = fillPriceSlots(real, { history: [], untilMs: end + 86_400_000, nowMs, timeZone: 'Europe/Berlin' });
  assert.ok(r.estimate, 'geschätzt');
  const est = r.slots.filter((s) => s.estimated);
  const peak = est.reduce((a, b) => (b.ctKwh > a.ctKwh ? b : a));
  assert.equal(localHour(Date.parse(peak.start)), 18, `Spitze um ${peak.start}`);
});
