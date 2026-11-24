// test/peak-shaving-billing-report.test.js — Peak Shaving P4: Leistungsentgelt in Historie (Monat/Jahr) und
// Leitstand-Kachel. Leipzig NS 2026 (siehe test/peak-shaving-billing.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { peakBillingReport, createPeakShaving, peakPeriods } from '../services/peak-shaving/index.js';

const TARIFF = { model: 'year', lpLowEurPerKwYear: 19.17, apLowCtPerKwh: 5.96, lpHighEurPerKwYear: 82.02, apHighCtPerKwh: 3.44 };
const CFG = { updateChannel: 'dev', manufacturer: 'victron', schedule: { timezone: 'Europe/Berlin' },
  peakShaving: { enabled: true, gridImportLimitW: 50000, marginW: 300, tariff: TARIFF } };
const MONTHS = [
  { ym: '2025-01', energyKwh: 75_000, peakW: 50_000, peakSlot: '2025-01-15T10:00:00.000Z', uncappedPeakW: 60_000, slots: 2976, batterySlots: 2976 },
  { ym: '2025-07', energyKwh: 75_000, peakW: 42_000, peakSlot: null, uncappedPeakW: 55_000, slots: 2976, batterySlots: 2976 }
];

function store(calls = []) {
  return { getPeakBillingMonths: async (q) => { calls.push(q); return MONTHS; } };
}

test('Historie Jahr 2025: ganzes Kalenderjahr in Ortszeit, 9.261 €, vermieden 820,20 €', async () => {
  const calls = [];
  const r = await peakBillingReport(store(calls), CFG, { view: 'year', date: '2025-07-01', nowMs: Date.parse('2026-06-01T00:00:00Z') });
  assert.equal(r.status, 200);
  assert.deepEqual(calls[0], { start: '2024-12-31T23:00:00.000Z', end: '2025-12-31T23:00:00.000Z', timeZone: 'Europe/Berlin' });
  assert.equal(r.body.billing.totalEur, 9261);
  assert.equal(r.body.billing.avoidedEur, 820.2);
  assert.equal(r.body.month, null);
});

test('Historie Monat Juli 2025: Monatszeile mit Arbeitsentgelt in der Stufe des Jahres', async () => {
  const r = await peakBillingReport(store(), CFG, { view: 'month', date: '2025-07-15', nowMs: Date.parse('2026-06-01T00:00:00Z') });
  assert.equal(r.body.ym, '2025-07');
  assert.equal(r.body.month.peakW, 42000);
  assert.equal(r.body.month.energyChargeEur, 2580);
});

test('Peak Shaving aus: Karte aus (enabled false), keine Abfrage', async () => {
  const calls = [];
  const r = await peakBillingReport(store(calls), { ...CFG, updateChannel: 'stable' }, { view: 'year', date: '2025-07-01' });
  assert.deepEqual(r.body, { ok: true, enabled: false });
  assert.equal(calls.length, 0);
});

test('ohne Datenbank: 503', async () => {
  const r = await peakBillingReport(null, CFG, { view: 'year' });
  assert.equal(r.status, 503);
});

test('Leitstand: Status trägt das Leistungsentgelt des laufenden Jahres', async () => {
  const NOW = Date.parse('2025-07-02T10:00:00Z');
  const s = createPeakShaving({
    state: { victron: {}, meter: {}, ctrl: {} }, getCfg: () => CFG, pushLog: () => {},
    telemetryStore: { getGridImportPeak: async () => null, getPeakBillingMonths: async () => MONTHS }
  }, { now: () => NOW });
  await s.refreshPeaks();
  const b = s.summary().billing;
  assert.equal(b.model, 'year');
  assert.equal(b.year.running, true);
  assert.equal(b.year.peakW, 50000);
  assert.equal(b.year.demandChargeEur, 4101);
  assert.equal(b.month.ym, '2025-07');
  assert.equal(b.year.months, undefined, 'Monatsliste nicht im Status');
  // Periode passt zum laufenden Jahr
  assert.equal(peakPeriods(NOW).year.start, '2024-12-31T23:00:00.000Z');
});
