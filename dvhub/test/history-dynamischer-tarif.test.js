// test/history-dynamischer-tarif.test.js — Auswertung „dynamischer Tarif in
// der Historie“ an der echten Grenze: createHistoryRuntime mit 15-min-Slots
// und createHistoryApiHandlers (Zusammenfassung + /api/history/tariff-scatter).
// Christin 23.11.2026 (T1–T10). Erwartungen werden unabhängig aus denselben
// Roh-Slots nachgerechnet.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryRuntime, createHistoryApiHandlers, SUMMARY_CACHE_VERSION } from '../history-runtime.js';
import { putProviderSlots, clearProviderPrices } from '../services/tariff-provider/price-store.js';

const SLOT_MS = 900_000;
const berlinDate = (ts) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(ts));

// Börse 0/10/20/30 ct im Stundentakt; Bezug 1 kWh bei 0 ct, sonst 0,1 kWh.
const spotDefault = (ms) => (new Date(ms).getUTCHours() % 4) * 10;
const importAt = (ms, spotAt) => (spotAt(ms) <= 0 ? 1 : 0.1);

function makeStore({ fromUtc, toUtc, spotAt = spotDefault, withCache = false, flows = false, soc = null }) {
  const slots = [];
  const prices = [];
  for (let t = Date.parse(fromUtc); t < Date.parse(toUtc); t += SLOT_MS) {
    const ts = new Date(t).toISOString();
    const imp = importAt(t, spotAt);
    const slot = {
      ts, importKwh: imp, exportKwh: 0, loadKwh: imp, pvKwh: 0, gridDirectUseKwh: imp,
      sourceKind: 'local_live', sourceKinds: ['local_live']
    };
    if (flows) {
      // Tagsüber PV: 0,2 direkt, 0,1 in den Akku, 0,05 ins Netz; Akku gibt 0,08 ans Haus.
      Object.assign(slot, {
        pvKwh: 0.35, solarDirectUseKwh: 0.2, solarToBatteryKwh: 0.1, solarToGridKwh: 0.05,
        batteryDirectUseKwh: 0.08, exportKwh: 0.05, loadKwh: imp + 0.28
      });
    }
    slots.push(slot);
    const spot = spotAt(t);
    if (spot != null) prices.push({ ts, priceCtKwh: spot });
  }
  const within = (rows, start, end) => rows.filter((r) => r.ts >= start && r.ts < end).map((r) => ({ ...r }));
  const store = {
    slots,
    prices,
    async listMaterializedEnergySlots({ start, end }) { return within(slots, start, end); },
    async listAggregatedEnergySlots({ start, end }) { return within(slots, start, end); },
    async listPriceSlots({ start, end }) { return within(prices, start, end); }
  };
  if (soc) store.getSeriesBoundaryValues = async () => soc;
  if (withCache) {
    const cache = new Map();
    store.cache = cache;
    store.historySectionFingerprints = async ({ boundaries }) => {
      const out = [];
      for (let i = 0; i + 1 < boundaries.length; i += 1) {
        const a = new Date(boundaries[i]).toISOString();
        const b = new Date(boundaries[i + 1]).toISOString();
        const n = slots.filter((s) => s.ts >= a && s.ts < b).length;
        out.push({ slotRows: n, fp: String(n) });
      }
      return out;
    };
    store.getHistoryCacheEntries = async (prefix) => new Map([...cache].filter(([k]) => k.startsWith(prefix)));
    store.putHistoryCacheEntry = async (key, fingerprint, payload) => { cache.set(key, { fingerprint, payload }); };
  }
  return store;
}

const DYN19 = { energyMarkupCtKwh: 0, gridChargesCtKwh: 10, leviesAndFeesCtKwh: 2, vatPct: 19 };
// Standard-Tarif dynamisch OHNE „gilt ab“; davor ein Festpreis-Zeitraum bis 14.03.
// → abgeleitet: gilt ab 15.03.2026 (T1-Übergang).
const PRICING = {
  mode: 'dynamic',
  fixedGrossImportCtKwh: 35,
  baseFeeEurMonth: 31,
  dynamicComponents: DYN19,
  periods: [
    { id: 'alt', label: 'Stadtwerke Fest', startDate: '2025-01-01', endDate: '2026-03-14', mode: 'fixed', fixedGrossImportCtKwh: 30, baseFeeEurMonth: 10 }
  ]
};
const dynPrice = (spot) => Math.round((spot + 12) * 119) / 100;

const runtimeFor = (store, pricing, today = '2026-11-23', extra = {}) =>
  createHistoryRuntime({ store, getPricingConfig: () => pricing, getCurrentDate: () => today, ...extra });

const close = (actual, expected, msg, eps = 0.011) => {
  assert.ok(Number.isFinite(actual), `${msg}: ${actual} ist keine Zahl`);
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: ${actual} statt ${expected}`);
};

test('Ablage-Version 9 (dynamischer Tarif, ungerundete Flüsse)', () => {
  assert.equal(SUMMARY_CACHE_VERSION, 9);
});

test('März mit Tarifwechsel am 15. und Sommerzeit: Ø, Börse, Aufschlag, Formel, Grundgebühr, Vergleich', async () => {
  const store = makeStore({ fromUtc: '2026-02-28T23:00:00.000Z', toUtc: '2026-03-31T22:00:00.000Z' });
  const summary = await runtimeFor(store, PRICING).getSummary({ view: 'month', date: '2026-03-10' });
  const t = summary.kpis.tariff;
  // T1: ohne Datum abgeleitet aus dem Ende des Festpreis-Zeitraums.
  assert.deepEqual(t.validFrom, { date: '2026-03-15', source: 'fixed_period' });

  // Unabhängige Nachrechnung: nur Tage ab 15.03. (dynamisch).
  let kwh = 0; let ct = 0; let spotCt = 0; let n = 0; let priceSum = 0; let slots = 0; const days = new Set();
  for (const s of store.slots) {
    const d = berlinDate(s.ts);
    if (d < '2026-03-01' || d >= '2026-04-01') continue;
    slots += 1;
    days.add(d);
    if (d < '2026-03-15') continue;
    const spot = spotDefault(Date.parse(s.ts));
    const p = dynPrice(spot);
    n += 1; priceSum += p; kwh += s.importKwh; ct += s.importKwh * p; spotCt += s.importKwh * spot;
  }
  // Sommerzeit 29.03.: 23-h-Tag → 31 Tage, 31·96 − 4 Viertelstunden.
  assert.equal(slots, 31 * 96 - 4);
  assert.equal(days.size, 31);
  assert.equal(t.pricedSlots, n);
  close(t.importKwh, kwh, 'Netzbezug dynamisch');
  close(t.avgImportCtKwh, ct / kwh, 'Ø-Bezugspreis');
  close(t.avgSlotCtKwh, priceSum / n, 'Ø je Viertelstunde');
  close(t.avgSpotWeightedCtKwh, spotCt / kwh, 'Ø Börse mengengewichtet');
  close(t.avgMarkupCtKwh, (ct - spotCt) / kwh, 'Ø Aufschlag');
  // Gleich zu den Feldern aus feat/arbeitspreis-vergleich.
  assert.equal(t.avgImportCtKwh, summary.kpis.variableImportCtKwh);
  assert.equal(t.fixedCompare.savingsEur, summary.kpis.fixedCompareSavingsEur);

  // T2: Formel p = 1,19·(s + 12) → a = 14,28, b = 1,19, R² = 1, netto +0 %.
  assert.equal(t.fits.length, 1);
  assert.equal(t.fits[0].tariffKey, 'base');
  assert.deepEqual(t.fits[0].fit.gross, { interceptCtKwh: 14.28, slope: 1.19 });
  assert.equal(t.fits[0].fit.r2, 1);
  assert.equal(t.fits[0].fit.markupPctNet, 0);

  // T5: Grundgebühr 14 Tage × 10 €/31 + 17 Tage × 31 €/31 = 4,52 + 17,00 = 21,52 €.
  assert.deepEqual(t.baseFee, { eur: 21.52, days: 31, missingDays: 0, variableEur: 17, variableDays: 17, variableMissingDays: 0 });
  close(t.variableCostWithFeeEur, Math.round(ct) / 100 + 17, 'dynamisch mit Grundgebühr');
  // T6: Vergleich 30 ct mit Grundgebühr des Festpreis-Zeitraums (10 €/Monat → 17 Tage = 5,48 €).
  assert.equal(t.fixedCompare.ctKwh, 30);
  close(t.fixedCompare.fixedEur, (kwh * 30) / 100, 'Festpreis gleiche Mengen');
  assert.equal(t.fixedCompareWithFee.feeFixedEur, 5.48);
  assert.equal(t.fixedCompareWithFee.feeActualEur, 17);
  close(t.fixedCompareWithFee.savingsEur, t.fixedCompareWithFee.fixedEur - t.fixedCompareWithFee.actualEur, 'Ersparnis mit Gebühr', 0.001);

  // Tageszeilen tragen dieselbe Auswertung (Festpreis-Tag ohne variable Viertelstunden).
  const fixedDay = summary.rows.find((row) => row.key === '2026-03-10');
  const dynDay = summary.rows.find((row) => row.key === '2026-03-20');
  assert.equal(fixedDay.tariff.variableSlots, 0);
  assert.equal(fixedDay.tariff.avgImportCtKwh, null);
  assert.equal(dynDay.tariff.variableSlots, 96);
  close(dynDay.tariff.baseFee.eur, 1, 'Tagesgebühr 31 €/31');
});

test('T1: eingetragenes „gilt ab“ schlägt die Ableitung; davor nie dynamisch', async () => {
  const store = makeStore({ fromUtc: '2026-02-28T23:00:00.000Z', toUtc: '2026-03-31T22:00:00.000Z' });
  const pricing = { ...PRICING, validFrom: '2026-03-20', periods: [] };
  const t = (await runtimeFor(store, pricing).getSummary({ view: 'month', date: '2026-03-01' })).kpis.tariff;
  assert.deepEqual(t.validFrom, { date: '2026-03-20', source: 'configured' });
  // 12 Tage (20.–31.03., einer mit 23 h) dynamisch.
  assert.equal(t.pricedSlots, 12 * 96 - 4);
  // Davor gilt der feste Bruttopreis 35 ct — ohne Grundgebühr (unbekannt vor „gilt ab“).
  assert.equal(t.baseFee.days, 31);
  assert.equal(t.baseFee.missingDays, 19);
  assert.equal(t.allCostWithFeeEur, null);
  // Vergleich: Standard-Tarif-Festpreis 35 ct, keine Vergleichs-Gebühr bekannt.
  assert.equal(t.fixedCompare.ctKwh, 35);
  assert.equal(t.fixedCompareWithFee, null);
  assert.equal(t.compareFeeMissingDays, 12);
});

test('Ohne Hinweis in den Daten gilt der dynamische Standard-Tarif wie bisher für die ganze Historie', async () => {
  const store = makeStore({ fromUtc: '2026-02-28T23:00:00.000Z', toUtc: '2026-03-31T22:00:00.000Z' });
  const t = (await runtimeFor(store, { ...PRICING, periods: [] }).getSummary({ view: 'month', date: '2026-03-01' })).kpis.tariff;
  assert.deepEqual(t.validFrom, { date: null, source: 'none' });
  assert.equal(t.pricedSlots, 31 * 96 - 4);
});

test('Anbieterpreis: echte gegen geschätzte Viertelstunden, Stundenpreise gelten für vier Viertel, Schalter (T3)', async (t) => {
  clearProviderPrices();
  t.after(() => clearProviderPrices());
  const store = makeStore({ fromUtc: '2026-10-31T23:00:00.000Z', toUtc: '2026-11-07T23:00:00.000Z' });
  // Anbieterpreise ab 03.11. Berlin (02.11. 23:00 UTC) als Stundenpreise: Börse + 20 ct.
  const provider = [];
  for (let ms = Date.parse('2026-11-02T23:00:00.000Z'); ms < Date.parse('2026-11-07T23:00:00.000Z'); ms += 3_600_000) {
    provider.push({ ts: ms, ctKwh: spotDefault(ms) + 20, durationMs: 3_600_000 });
  }
  putProviderSlots('tibber', provider);
  const pricing = {
    mode: 'provider', provider: { priceBasis: 'gross_total' }, fixedGrossImportCtKwh: 33,
    dynamicComponents: { energyMarkupCtKwh: 1, gridChargesCtKwh: 10, leviesAndFeesCtKwh: 2, vatPct: 0 },
    validFrom: '2026-11-01', periods: []
  };
  const runtime = runtimeFor(store, pricing, '2026-11-23');
  const week = await runtime.getSummary({ view: 'week', date: '2026-11-04' });
  const k = week.kpis.tariff;
  // Woche 02.–08.11.; Daten bis 07.11. 24:00 → 6 Tage, davon 02.11. ohne Anbieterpreis (geschätzt
  // nach der dynamischen Formel: Börse + 13 ct), 03.–07.11. echte Stundenpreise (alle vier Viertel).
  assert.equal(k.pricedSlots, 6 * 96);
  assert.equal(k.estimatedSlots, 96);
  const sample = week.slots.length ? week.slots : null;
  assert.equal(sample, null, 'Woche liefert keine Slots in der Zusammenfassung');
  let estKwh = 0; let allKwh = 0; let realKwh = 0; let realCt = 0;
  for (const s of store.slots) {
    const d = berlinDate(s.ts);
    if (d < '2026-11-02' || d > '2026-11-07') continue;
    allKwh += s.importKwh;
    if (d === '2026-11-02') estKwh += s.importKwh;
    else { realKwh += s.importKwh; realCt += s.importKwh * (spotDefault(Date.parse(s.ts)) + 20); }
  }
  close(k.estimatedImportKwh, estKwh, 'geschätzte kWh');
  close(k.estimatedSharePct, (estKwh / allKwh) * 100, 'Anteil geschätzt');
  // Formel aus echten Anbieterpreisen + geschätzten: zwei Höhen → R² < 1, ohne geschätzte exakt.
  assert.ok(k.fits[0].fit.r2 < 1);
  const excl = (await runtime.getSummary({ view: 'week', date: '2026-11-04', estimated: 'exclude' })).kpis.tariff;
  assert.equal(excl.excludeEstimated, true);
  close(excl.avgImportCtKwh, realCt / realKwh, 'Ø ohne geschätzte');
  assert.deepEqual(excl.fits[0].fit.gross, { interceptCtKwh: 20, slope: 1 });
  assert.equal(excl.fits[0].fit.r2, 1);
});

test('T1-Übergang Anbieter: ohne Datum gilt der Standard-Tarif ab dem ersten Anbieterpreis', async (t) => {
  clearProviderPrices();
  t.after(() => clearProviderPrices());
  const store = makeStore({ fromUtc: '2026-10-31T23:00:00.000Z', toUtc: '2026-11-07T23:00:00.000Z' });
  putProviderSlots('lichtblick', [{ ts: Date.parse('2026-11-04T23:00:00.000Z'), ctKwh: 25 }]);
  const pricing = { mode: 'provider', provider: { priceBasis: 'gross_total' }, fixedGrossImportCtKwh: 33, dynamicComponents: DYN19, periods: [] };
  const k = (await runtimeFor(store, pricing).getSummary({ view: 'week', date: '2026-11-04' })).kpis.tariff;
  assert.deepEqual(k.validFrom, { date: '2026-11-05', source: 'provider_data' });
  // 05.–07.11. variabel, 02.–04.11. Festpreis 33 ct.
  assert.equal(k.variableSlots, 3 * 96);
});

test('Negative Börse: eigene Punktwolke, nicht im Fit; Endpreis darf negativ sein', async () => {
  // Börse −20/−10/10/20 ct im Stundentakt.
  const spotAt = (ms) => [-20, -10, 10, 20][new Date(ms).getUTCHours() % 4];
  const store = makeStore({ fromUtc: '2026-05-31T22:00:00.000Z', toUtc: '2026-06-07T22:00:00.000Z', spotAt });
  const pricing = { mode: 'dynamic', validFrom: '2026-01-01', dynamicComponents: { energyMarkupCtKwh: 0, gridChargesCtKwh: 5, leviesAndFeesCtKwh: 0, vatPct: 19 }, periods: [] };
  const k = (await runtimeFor(store, pricing).getSummary({ view: 'week', date: '2026-06-03' })).kpis.tariff;
  const f = k.fits[0];
  assert.equal(f.n, 7 * 48);
  assert.equal(f.negative.n, 7 * 48);
  // s ≥ 0: p = 1,19·(s + 5); s < 0 ebenso → negatives Endpreis bei −20: 1,19·(−15) = −17,85.
  assert.deepEqual(f.fit.gross, { interceptCtKwh: 5.95, slope: 1.19 });
  assert.equal(f.negative.markupMinCtKwh, Math.round((-17.85 + 20) * 100) / 100);
});

test('Jahr und Alle: Monatszeilen; Ablage liefert dieselbe Auswertung wie frisch gerechnet', async () => {
  // Ab 01.12.2025 (Berlin), damit „Alle“ zwei Jahreszeilen hat.
  const store = makeStore({ fromUtc: '2025-11-30T23:00:00.000Z', toUtc: '2026-04-30T22:00:00.000Z', withCache: true });
  const runtime = runtimeFor(store, PRICING, '2026-04-20');
  const fresh = await runtime.getSummary({ view: 'year', date: '2026-01-01' });
  assert.ok(store.cache.size >= 3, 'abgeschlossene Monate abgelegt');
  const cached = await runtime.getSummary({ view: 'year', date: '2026-01-01' });
  assert.deepEqual(cached.kpis.tariff, fresh.kpis.tariff);
  assert.deepEqual(cached.tariffMonthRows, fresh.tariffMonthRows);
  assert.deepEqual(fresh.tariffMonthRows.map((r) => r.key), ['2026-01', '2026-02', '2026-03', '2026-04']);
  // Januar/Februar Festpreis-Zeitraum → keine variablen Viertelstunden.
  assert.equal(fresh.tariffMonthRows[0].variableSlots, 0);
  assert.ok(fresh.tariffMonthRows[3].avgImportCtKwh > 0);
  // Alle: Zeilen sind Jahre, Monatszeilen über alle Jahre, gleich zur Jahresansicht.
  const all = await runtime.getSummary({ view: 'all', date: '2026-01-01' });
  assert.deepEqual(all.rows.map((r) => r.key), ['2025', '2026']);
  const allMonths = all.tariffMonthRows.filter((r) => r.key.startsWith('2026'));
  assert.deepEqual(allMonths, fresh.tariffMonthRows);
  const allCached = await runtime.getSummary({ view: 'all', date: '2026-01-01' });
  assert.deepEqual(allCached.tariffMonthRows, all.tariffMonthRows);
  // Schalter ändert nur das Abschließen, nicht die Ablage.
  const excl = await runtime.getSummary({ view: 'year', date: '2026-01-01', estimated: 'exclude' });
  assert.equal(excl.kpis.tariff.excludeEstimated, true);
  assert.equal(excl.kpis.tariff.avgImportCtKwh, fresh.kpis.tariff.avgImportCtKwh);
});

test('Eigenverbrauch bewertet: Flüsse je Viertelstunde, Ladestand am Rand (T7)', async () => {
  const store = makeStore({
    fromUtc: '2026-05-31T22:00:00.000Z', toUtc: '2026-06-07T22:00:00.000Z', flows: true,
    soc: { startValue: 20, endValue: 50 }
  });
  const pricing = { mode: 'dynamic', validFrom: '2026-01-01', dynamicComponents: DYN19, periods: [] };
  const runtime = runtimeFor(store, pricing, '2026-11-23', { getOptimizerConfig: () => ({ batteryCapacityWh: 10000 }) });
  const k = (await runtime.getSummary({ view: 'week', date: '2026-06-03' })).kpis.tariff.selfUse;
  let lhs = 0; let load = 0;
  for (const s of store.slots) {
    const spot = spotDefault(Date.parse(s.ts));
    const p = dynPrice(spot);
    const l = s.solarDirectUseKwh + s.gridDirectUseKwh + s.batteryDirectUseKwh;
    load += l;
    lhs += l * p - s.gridDirectUseKwh * p + s.solarToGridKwh * spot - (s.solarDirectUseKwh + s.solarToBatteryKwh + s.solarToGridKwh) * spot;
  }
  assert.equal(k.slots, store.slots.length);
  close(k.loadKwh, load, 'Last aus Flüssen');
  // ΔSoC (50 − 20) % × 10 kWh = 3 kWh, zum Einstandspreis bewertet; Bilanz ohne Korrektur aufgeht.
  assert.equal(k.battery.storedDeltaKwh, 3);
  close(k.advantageEur - k.battery.socCorrectionEur, lhs / 100, 'Bilanz', 0.02);
  close(k.battery.socCorrectionEur, (3 * k.battery.storedValueCtKwh) / 100, 'Ladestand-Ausgleich', 0.01);
  // Einstand je geladener kWh: PV 0,1 kWh je Viertelstunde zur Börse.
  close(k.battery.storedValueCtKwh, 15, 'Ø Börse beim Laden (0/10/20/30)', 0.01);
});

test('Codex 39d05c79: Tagesansicht – Viertelstunden-Zeilen ohne Tagesgebühr, Zeitraum einmal', async () => {
  const store = makeStore({ fromUtc: '2026-03-19T23:00:00.000Z', toUtc: '2026-03-20T23:00:00.000Z' });
  const summary = await runtimeFor(store, { ...PRICING, validFrom: '2026-03-01' }).getSummary({ view: 'day', date: '2026-03-20' });
  assert.equal(summary.rows.length, 96);
  assert.ok(summary.rows.every((row) => row.tariff.baseFee === null));
  assert.equal(summary.kpis.tariff.baseFee.eur, 1);
});

test('Codex ddbea4c0: Ø-Bezugspreis über den Zeitraum aus ungerundeten Summen', async () => {
  const store = makeStore({ fromUtc: '2026-06-01T22:00:00.000Z', toUtc: '2026-06-01T22:15:00.000Z' });
  store.slots[0].importKwh = 0.054;
  store.slots[0].gridDirectUseKwh = 0.054;
  const pricing = { mode: 'fixed', fixedGrossImportCtKwh: 30, periods: [] };
  const summary = await runtimeFor(store, pricing).getSummary({ view: 'week', date: '2026-06-02' });
  assert.equal(summary.kpis.userImportPriceWeightedCtKwh, 30);
  const tiny = makeStore({ fromUtc: '2026-06-01T22:00:00.000Z', toUtc: '2026-06-01T22:15:00.000Z' });
  tiny.slots[0].importKwh = 0.004;
  const t2 = await runtimeFor(tiny, pricing).getSummary({ view: 'week', date: '2026-06-02' });
  assert.equal(t2.kpis.userImportPriceWeightedCtKwh, 30);
});

test('API: Zusammenfassung mit ?estimated, /api/history/tariff-scatter mit Klassen und Punkten', async () => {
  const store = makeStore({ fromUtc: '2026-02-28T23:00:00.000Z', toUtc: '2026-03-31T22:00:00.000Z' });
  const api = createHistoryApiHandlers({ historyRuntime: runtimeFor(store, PRICING), telemetryEnabled: true, appVersion: 'test' });
  const bad = await api.getSummary({ view: 'month', date: '2026-03-01', estimated: 'nein' });
  assert.equal(bad.status, 400);
  const ok = await api.getSummary({ view: 'month', date: '2026-03-01', estimated: 'exclude' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.kpis.tariff.excludeEstimated, true);
  assert.equal(ok.body.tariffScatter, undefined, 'Streudaten nicht in der Zusammenfassung');

  const scatter = await api.getTariffScatter({ view: 'month', date: '2026-03-01' });
  assert.equal(scatter.status, 200);
  const b = scatter.body;
  assert.equal(b.ok, true);
  assert.deepEqual(b.validFrom, { date: '2026-03-15', source: 'fixed_period' });
  // Börse 0/10/20/30 → vier Klassen, Endpreis exakt 1,19·(s + 12).
  assert.deepEqual(b.bins.map((bin) => [bin.spotFromCt, bin.avgCt, bin.minCt, bin.maxCt]),
    [[0, 14.28, 14.28, 14.28], [10, 26.18, 26.18, 26.18], [20, 38.08, 38.08, 38.08], [30, 49.98, 49.98, 49.98]]);
  assert.equal(b.points.length, 17 * 96 - 4);
  // Erster Punkt 15.03. 00:00 Berlin = 14.03. 23:00 UTC → Börse 30 ct.
  assert.deepEqual(b.points[0].slice(0, 2), [30, 49.98]);
  assert.equal(b.fits[0].fit.gross.slope, 1.19);
  assert.equal((await api.getTariffScatter({ view: 'day', date: '2026-03-01' })).status, 400);
  assert.equal((await api.getTariffScatter({ view: 'month', date: '01.03.2026' })).status, 400);
  const year = await api.getTariffScatter({ view: 'year', date: '2026-03-01' });
  assert.equal(year.body.points, null);
  assert.equal(year.body.bins.length, 4);
});
