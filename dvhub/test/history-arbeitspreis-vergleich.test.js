// test/history-arbeitspreis-vergleich.test.js — Ø Arbeitspreis je Zeitraum und
// Vergleich mit einem Festpreis (Christin 13.11.2026, Ziel 1.0.11):
// „Ein Durchschnittspreis für den Monat, wie unser dynamischer Tarif im
// Durchschnitt beim Arbeitspreis war – so können wir vergleichen, was ein
// Festpreis gebracht hätte.“
//
// Geprüft an der echten Grenze: der Aggregator (createHistoryRuntime) mit
// 15-min-Slots über einen ganzen März mit Tarifwechsel mitten im Monat
// (fest → dynamisch am 15.03.) und Zeitumstellung (29.03.2026, 23-h-Tag).
// Die Erwartung rechnet der Test unabhängig aus denselben Slots nach.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryRuntime, SUMMARY_CACHE_VERSION } from '../history-runtime.js';
import {
  normalizeConfigInput,
  resolveComparisonFixedPriceForDate,
  resolveUserImportTariffModeForTimestamp
} from '../config-model.js';

const SLOT_MS = 900_000;
const berlinDate = (ts) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(ts));

// Börsenpreis je Slot: 0/10/20/30 ct im Stundentakt. Netzbezug 1 kWh in den
// billigen Stunden (0 ct), sonst 0,1 kWh — Lastverschiebung ins Billige.
function spotAt(ms) { return (new Date(ms).getUTCHours() % 4) * 10; }
function importAt(ms, { zeroImport = false } = {}) {
  if (zeroImport) return 0;
  return spotAt(ms) === 0 ? 1 : 0.1;
}

function makeStore({ fromUtc, toUtc, zeroImport = false, withCache = false }) {
  const slots = [];
  const prices = [];
  for (let t = Date.parse(fromUtc); t < Date.parse(toUtc); t += SLOT_MS) {
    const ts = new Date(t).toISOString();
    const imp = importAt(t, { zeroImport });
    slots.push({
      ts, importKwh: imp, exportKwh: 0, loadKwh: imp, pvKwh: 0, gridDirectUseKwh: imp,
      sourceKind: 'local_live', sourceKinds: ['local_live']
    });
    prices.push({ ts, priceCtKwh: spotAt(t) });
  }
  const within = (rows, start, end) => rows.filter((r) => r.ts >= start && r.ts < end).map((r) => ({ ...r }));
  const store = {
    slots,
    slotRequests: 0,
    async listMaterializedEnergySlots({ start, end }) { store.slotRequests += 1; return within(slots, start, end); },
    async listAggregatedEnergySlots({ start, end }) { return within(slots, start, end); },
    async listPriceSlots({ start, end }) { return within(prices, start, end); },
  };
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

const DYN = { energyMarkupCtKwh: 0, gridChargesCtKwh: 10, leviesAndFeesCtKwh: 2, vatPct: 0 };
// Festtarif bis 14.03., ab 15.03. dynamisch (Spot + 12 ct).
const PRICING_SWITCH = {
  mode: 'fixed',
  fixedGrossImportCtKwh: 35,
  dynamicComponents: DYN,
  periods: [
    { id: 'alt', label: 'Stadtwerke Fest', startDate: '2025-01-01', endDate: '2026-03-14', mode: 'fixed', fixedGrossImportCtKwh: 30 },
    { id: 'dyn', label: 'Dynamisch', startDate: '2026-03-15', endDate: '2026-12-31', mode: 'dynamic', dynamicComponents: DYN }
  ]
};

function runtimeFor(store, pricing, today = '2026-11-13') {
  return createHistoryRuntime({ store, getPricingConfig: () => pricing, getCurrentDate: () => today });
}

const close = (actual, expected, msg, eps = 0.011) => {
  assert.ok(Number.isFinite(actual), `${msg}: ${actual} ist keine Zahl`);
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: ${actual} statt ${expected}`);
};

// Unabhängige Nachrechnung aus den Roh-Slots.
function expectFor(store, { fromLocal, toLocalExclusive, dynFromLocal = '2026-03-15', fixedCt = 30, dynExtraCt = 12 }) {
  let allKwh = 0; let allCt = 0;
  let dynKwh = 0; let dynCt = 0; let dynSlots = 0; let dynPriceSum = 0; let fixedCtTotal = 0;
  let slots = 0;
  for (const s of store.slots) {
    const d = berlinDate(s.ts);
    if (d < fromLocal || d >= toLocalExclusive) continue;
    slots += 1;
    const ms = Date.parse(s.ts);
    const dynamic = d >= dynFromLocal;
    const price = dynamic ? spotAt(ms) + dynExtraCt : fixedCt;
    allKwh += s.importKwh; allCt += s.importKwh * price;
    if (dynamic) {
      dynSlots += 1; dynPriceSum += price;
      dynKwh += s.importKwh; dynCt += s.importKwh * price; fixedCtTotal += s.importKwh * fixedCt;
    }
  }
  return {
    slots,
    allKwh, avgAllCt: allKwh > 0 ? allCt / allKwh : null,
    dynSlots, dynKwh, avgDynCt: dynKwh > 0 ? dynCt / dynKwh : null,
    timeAvgDynCt: dynSlots > 0 ? dynPriceSum / dynSlots : null,
    actualEur: dynCt / 100, fixedEur: fixedCtTotal / 100, savingsEur: (fixedCtTotal - dynCt) / 100
  };
}

// ── Vergleichs-Festpreis: Auflösung ─────────────────────────────────────────

test('Vergleichs-Festpreis: eigener Wert hat Vorrang', () => {
  const r = resolveComparisonFixedPriceForDate('2026-06-01', { ...PRICING_SWITCH, comparisonFixedCtKwh: 27.5 });
  assert.deepEqual(r, { ctKwh: 27.5, source: 'configured', periodId: null, label: null });
});

test('Vergleichs-Festpreis: leer → letzter Festpreis-Zeitraum vor dem Tag', () => {
  const pricing = {
    ...PRICING_SWITCH,
    comparisonFixedCtKwh: null,
    periods: [
      { id: 'a', label: 'Uralt', startDate: '2023-01-01', endDate: '2023-12-31', mode: 'fixed', fixedGrossImportCtKwh: 22 },
      { id: 'b', label: 'Stadtwerke Fest', startDate: '2024-01-01', endDate: '2026-03-14', mode: 'fixed', fixedGrossImportCtKwh: 26.9 },
      { id: 'c', label: 'Dynamisch', startDate: '2026-03-15', endDate: '2026-12-31', mode: 'dynamic', dynamicComponents: DYN }
    ]
  };
  assert.deepEqual(resolveComparisonFixedPriceForDate('2026-03-20', pricing),
    { ctKwh: 26.9, source: 'period', periodId: 'b', label: 'Stadtwerke Fest' });
  // Ein später gültiger Festpreis-Zeitraum zählt nicht für frühere Tage.
  assert.equal(resolveComparisonFixedPriceForDate('2024-06-01', pricing).periodId, 'a');
});

test('Vergleichs-Festpreis: ohne Festpreis-Zeitraum → oberster Festpreis, sonst keiner', () => {
  const base = { mode: 'dynamic', fixedGrossImportCtKwh: 31, dynamicComponents: DYN, periods: [] };
  assert.deepEqual(resolveComparisonFixedPriceForDate('2026-05-01', base),
    { ctKwh: 31, source: 'base', periodId: null, label: null });
  assert.equal(resolveComparisonFixedPriceForDate('2026-05-01', { ...base, fixedGrossImportCtKwh: null }), null);
  assert.equal(resolveComparisonFixedPriceForDate('2026-05-01', { ...base, fixedGrossImportCtKwh: '' }), null);
});

test('Tarif-Modus je Slot folgt den Zeiträumen', () => {
  assert.equal(resolveUserImportTariffModeForTimestamp('2026-03-14T22:00:00Z', PRICING_SWITCH), 'fixed'); // 23:00 Berlin, 14.03.
  assert.equal(resolveUserImportTariffModeForTimestamp('2026-03-14T23:00:00Z', PRICING_SWITCH), 'dynamic'); // 00:00 Berlin, 15.03.
  assert.equal(resolveUserImportTariffModeForTimestamp('2027-02-01T12:00:00Z', PRICING_SWITCH), 'fixed'); // Standard-Tarif
  assert.equal(resolveUserImportTariffModeForTimestamp('2027-02-01T12:00:00Z', { mode: 'provider' }), 'provider');
});

test('Konfiguration: comparisonFixedCtKwh wird geprüft (leer → null, Unsinn → Warnung)', () => {
  const load = (value) => normalizeConfigInput({ manufacturer: 'victron', userEnergyPricing: { comparisonFixedCtKwh: value } });
  assert.equal(load('').effectiveConfig.userEnergyPricing.comparisonFixedCtKwh, null);
  assert.equal(load('26,9x').effectiveConfig.userEnergyPricing.comparisonFixedCtKwh, null);
  assert.ok(load('26,9x').warnings.some((w) => w.includes('comparisonFixedCtKwh')));
  assert.ok(load(-3).warnings.some((w) => w.includes('comparisonFixedCtKwh')));
  assert.equal(load(-3).effectiveConfig.userEnergyPricing.comparisonFixedCtKwh, null);
  assert.equal(load('26.9').effectiveConfig.userEnergyPricing.comparisonFixedCtKwh, 26.9);
  // Standard: leer (kein Vergleichspreis fest eingetragen).
  assert.equal(normalizeConfigInput({ manufacturer: 'victron' }).effectiveConfig.userEnergyPricing.comparisonFixedCtKwh, null);
});

// ── Aggregator ──────────────────────────────────────────────────────────────

// März 2026 lokal: 28.02. 23:00 UTC … 31.03. 22:00 UTC (Sommerzeit ab 29.03.).
const MARCH = { fromUtc: '2026-02-28T23:00:00Z', toUtc: '2026-03-31T22:00:00Z' };

test('Monat mit Tarifwechsel und Zeitumstellung: Ø Arbeitspreis und Festpreis-Vergleich je Slot', async () => {
  const store = makeStore(MARCH);
  const r = await runtimeFor(store, PRICING_SWITCH).getSummary({ view: 'month', date: '2026-03-10' });
  const exp = expectFor(store, { fromLocal: '2026-03-01', toLocalExclusive: '2026-04-01' });
  assert.equal(exp.slots, 31 * 96 - 4, 'März hat wegen der Zeitumstellung 4 Viertelstunden weniger');
  assert.equal(r.meta.unresolved.slotCount, exp.slots);
  assert.equal(exp.dynSlots, 17 * 96 - 4, 'dynamisch ab 15.03. inkl. 23-h-Tag');

  const k = r.kpis;
  close(k.userImportPriceWeightedCtKwh, exp.avgAllCt, 'Ø Arbeitspreis gesamt');
  assert.equal(k.variableTariffSlotCount, exp.dynSlots);
  close(k.variableImportKwh, exp.dynKwh, 'Netzbezug im dynamischen Tarif');
  close(k.variableImportCtKwh, exp.avgDynCt, 'Ø Arbeitspreis dynamisch (mengengewichtet)');
  close(k.variablePriceAvgCtKwh, exp.timeAvgDynCt, 'Ø Arbeitspreis dynamisch (zeitlich)');
  close(k.fixedCompareImportKwh, exp.dynKwh, 'verglichene kWh = nur dynamische Slots');
  close(k.fixedCompareActualEur, exp.actualEur, 'tatsächlich bezahlt (dynamisch)');
  close(k.fixedCompareFixedEur, exp.fixedEur, 'mit Festpreis');
  close(k.fixedCompareSavingsEur, exp.savingsEur, 'Ersparnis');
  assert.ok(k.fixedCompareSavingsEur > 0, 'Lastverschiebung ins Billige spart hier');
  close(k.fixedCompareCtKwh, 30, 'Vergleichspreis 30 ct');
  assert.deepEqual(k.fixedCompareSources.map((s) => [s.ctKwh, s.source, s.periodId, s.label]),
    [[30, 'period', 'alt', 'Stadtwerke Fest']]);
  assert.ok(k.variableImportCtKwh < k.variablePriceAvgCtKwh, 'gewichtet billiger als zeitlich: Lastverschiebung');

  // Monatszeilen (Tage) tragen dieselben Felder; der 23-h-Tag rechnet mit 92 Slots.
  const dstDay = r.rows.find((row) => row.key === '2026-03-29');
  assert.equal(dstDay.slotCount, 92);
  assert.equal(dstDay.variableTariffSlotCount, 92);
  const fixedDay = r.rows.find((row) => row.key === '2026-03-10');
  assert.equal(fixedDay.variableTariffSlotCount, 0);
  assert.equal(fixedDay.fixedCompareSavingsEur, null, 'Tag im Festtarif: kein Vergleich');
  close(fixedDay.userImportPriceWeightedCtKwh, 30, 'Tag im Festtarif: Ø = Festpreis');
});

test('Monat ganz im Festtarif: kein Vergleich, Ø = Festpreis', async () => {
  const store = makeStore({ fromUtc: '2026-01-31T23:00:00Z', toUtc: '2026-02-28T23:00:00Z' });
  const r = await runtimeFor(store, PRICING_SWITCH).getSummary({ view: 'month', date: '2026-02-10' });
  const k = r.kpis;
  close(k.userImportPriceWeightedCtKwh, 30, 'Ø Arbeitspreis');
  assert.equal(k.variableTariffSlotCount, 0);
  assert.equal(k.variableImportCtKwh, null);
  assert.equal(k.variablePriceAvgCtKwh, null);
  assert.equal(k.fixedCompareSavingsEur, null);
  assert.equal(k.fixedCompareFixedEur, null);
  assert.equal(k.fixedCompareCtKwh, null);
  assert.deepEqual(k.fixedCompareSources, []);
});

test('Monat ohne Netzbezug: kein Teilen durch null, Ersparnis 0', async () => {
  const store = makeStore({ fromUtc: '2026-04-30T22:00:00Z', toUtc: '2026-05-31T22:00:00Z', zeroImport: true });
  const r = await runtimeFor(store, PRICING_SWITCH).getSummary({ view: 'month', date: '2026-05-10' });
  const k = r.kpis;
  assert.equal(k.importKwh, 0);
  assert.equal(k.userImportPriceWeightedCtKwh, null, 'ohne Bezug kein Ø');
  assert.equal(k.variableImportCtKwh, null);
  close(k.variablePriceAvgCtKwh, 12 + 15, 'zeitlicher Ø gibt es auch ohne Bezug (Spot Ø 15 + 12)');
  assert.equal(k.fixedCompareImportKwh, 0);
  assert.equal(k.fixedCompareSavingsEur, 0);
  assert.equal(k.fixedCompareCtKwh, null, 'ohne kWh kein effektiver Vergleichspreis');
  for (const v of Object.values(k)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), 'keine NaN/Infinity in den Kennzahlen');
  }
});

test('Vergleich nur für Slots mit Börsenpreis: fehlender Preis zählt nicht mit 0 ct', async () => {
  const store = makeStore({ fromUtc: '2026-04-30T22:00:00Z', toUtc: '2026-05-01T22:00:00Z' });
  const pricesMissing = { ...store };
  pricesMissing.listPriceSlots = async () => []; // kein Börsenpreis am ganzen Tag
  const r = await runtimeFor(pricesMissing, PRICING_SWITCH).getSummary({ view: 'day', date: '2026-05-01' });
  assert.equal(r.kpis.variableTariffSlotCount, 96);
  assert.equal(r.kpis.fixedCompareImportKwh, 0);
  assert.equal(r.kpis.variablePriceAvgCtKwh, null);
  assert.equal(r.kpis.fixedCompareSavingsEur, null, 'nichts verglichen → kein Betrag');
});

test('Eigener Vergleichspreis wird genutzt und genannt', async () => {
  const store = makeStore(MARCH);
  const r = await runtimeFor(store, { ...PRICING_SWITCH, comparisonFixedCtKwh: 25 }).getSummary({ view: 'month', date: '2026-03-10' });
  const exp = expectFor(store, { fromLocal: '2026-03-01', toLocalExclusive: '2026-04-01', fixedCt: 25 });
  close(r.kpis.fixedCompareFixedEur, exp.fixedEur, 'mit 25 ct');
  close(r.kpis.fixedCompareSavingsEur, exp.savingsEur, 'Ersparnis mit 25 ct');
  assert.deepEqual(r.kpis.fixedCompareSources.map((s) => s.source), ['configured']);
});

test('Anbieter-Tarif zählt als variabler Tarif', async () => {
  const store = makeStore({ fromUtc: '2026-04-30T22:00:00Z', toUtc: '2026-05-01T22:00:00Z' });
  const pricing = { ...PRICING_SWITCH, periods: [PRICING_SWITCH.periods[0], { ...PRICING_SWITCH.periods[1], mode: 'provider' }] };
  const r = await runtimeFor(store, pricing).getSummary({ view: 'day', date: '2026-05-01' });
  assert.equal(r.kpis.variableTariffSlotCount, 96);
  assert.ok(r.kpis.fixedCompareImportKwh > 0);
  assert.ok(Number.isFinite(r.kpis.fixedCompareSavingsEur));
});

test('Jahr: je Monat Ø und Ersparnis, Jahressumme = Summe der Monate; Ablage liefert dasselbe', async () => {
  const range = { fromUtc: '2026-01-31T23:00:00Z', toUtc: '2026-04-30T22:00:00Z' }; // Feb–Apr
  const expected = await runtimeFor(makeStore(range), PRICING_SWITCH, '2026-05-02').getSummary({ view: 'year', date: '2026-03-01' });
  const store = makeStore(range);
  const months = Object.fromEntries(expected.rows.map((row) => [row.key, row]));
  assert.deepEqual(Object.keys(months).sort(), ['2026-02', '2026-03', '2026-04']);
  assert.equal(months['2026-02'].fixedCompareSavingsEur, null, 'Februar ganz im Festtarif');
  const marchExp = expectFor(store, { fromLocal: '2026-03-01', toLocalExclusive: '2026-04-01' });
  close(months['2026-03'].fixedCompareSavingsEur, marchExp.savingsEur, 'März-Ersparnis');
  close(months['2026-03'].variablePriceAvgCtKwh, marchExp.timeAvgDynCt, 'März zeitlicher Ø');
  const aprilExp = expectFor(store, { fromLocal: '2026-04-01', toLocalExclusive: '2026-05-01' });
  close(months['2026-04'].fixedCompareSavingsEur, aprilExp.savingsEur, 'April-Ersparnis');

  const k = expected.kpis;
  close(k.fixedCompareSavingsEur, marchExp.savingsEur + aprilExp.savingsEur, 'Jahressumme', 0.02);
  const yearExp = expectFor(store, { fromLocal: '2026-01-01', toLocalExclusive: '2027-01-01' });
  close(k.userImportPriceWeightedCtKwh, yearExp.avgAllCt, 'Jahres-Ø gesamt');
  close(k.variableImportCtKwh, yearExp.avgDynCt, 'Jahres-Ø dynamisch');

  // Vorberechnete Monate (Ablage) ergeben exakt dasselbe — auch die Quellen.
  assert.ok(SUMMARY_CACHE_VERSION >= 7, 'Slot-Bewertung geändert (zuletzt bepreiste Viertelstunden, Codex 7dc5e9e9) → Ablage-Version erhöht');
  const cached = makeStore({ ...range, withCache: true });
  const rt = runtimeFor(cached, PRICING_SWITCH, '2026-05-02');
  assert.deepStrictEqual(await rt.getSummary({ view: 'year', date: '2026-03-01' }), expected, 'kalt');
  assert.ok(cached.cache.size >= 3, 'Monate abgelegt');
  cached.slotRequests = 0;
  const warm = await rt.getSummary({ view: 'year', date: '2026-03-01' });
  assert.deepStrictEqual(warm, expected, 'warm');
  assert.deepEqual(warm.kpis.fixedCompareSources.map((s) => s.periodId), ['alt']);
});

// ── Codex ec0c105c ──────────────────────────────────────────────────────────

test('Ø Arbeitspreis gesamt: Viertelstunden ohne Preis zählen weder mit 0 ct noch mit Zuschlägen allein', async () => {
  // 01.05.: Festpreis 30 ct; 02.05.: Festtarif ohne Preis (null); 03.05.: dynamisch ohne Börsenpreis.
  const store = makeStore({ fromUtc: '2026-04-30T22:00:00Z', toUtc: '2026-05-03T22:00:00Z' });
  const noPriceStore = { ...store, listPriceSlots: async () => [] };
  const pricing = {
    mode: 'fixed', fixedGrossImportCtKwh: null, dynamicComponents: DYN,
    periods: [
      { id: 'f', label: 'Fest', startDate: '2026-05-01', endDate: '2026-05-01', mode: 'fixed', fixedGrossImportCtKwh: 30 },
      { id: 'd', label: 'Dyn', startDate: '2026-05-03', endDate: '2026-12-31', mode: 'dynamic', dynamicComponents: DYN }
    ]
  };
  const r = await runtimeFor(noPriceStore, pricing).getSummary({ view: 'week', date: '2026-05-01' });
  const dayKwh = store.slots.filter((s) => berlinDate(s.ts) === '2026-05-01').reduce((a, s) => a + s.importKwh, 0);
  close(r.kpis.userImportPriceWeightedCtKwh, 30, 'nur der bepreiste Tag zählt');
  close(r.kpis.userImportPriceWeightKwh, dayKwh, 'bepreiste kWh');
  close(r.kpis.importPricedCostEur, dayKwh * 0.3, 'Bezugskosten des Ø');
  const may2 = r.rows.find((row) => row.key === '2026-05-02');
  const may3 = r.rows.find((row) => row.key === '2026-05-03');
  assert.equal(may2.userImportPriceWeightedCtKwh, null, 'Festtarif ohne Preis: kein Ø');
  assert.equal(may3.userImportPriceWeightedCtKwh, null, 'dynamisch ohne Börsenpreis: kein Ø');
});

test('Bezugskosten zum Ø: aus derselben ungerundeten Summe (kleine Viertelstunden-Bezüge)', async () => {
  const slots = [];
  const start = Date.parse('2026-04-30T22:00:00Z');
  for (let i = 0; i < 96; i++) {
    slots.push({ ts: new Date(start + i * SLOT_MS).toISOString(), importKwh: 0.01, exportKwh: 0, loadKwh: 0.01, pvKwh: 0, sourceKind: 'local_live', sourceKinds: ['local_live'] });
  }
  const store = {
    async listMaterializedEnergySlots() { return slots; },
    async listAggregatedEnergySlots() { return slots; },
    async listPriceSlots() { return []; }
  };
  const r = await runtimeFor(store, { mode: 'fixed', fixedGrossImportCtKwh: 32, periods: [] }).getSummary({ view: 'day', date: '2026-05-01' });
  close(r.kpis.userImportPriceWeightedCtKwh, 32, 'Ø');
  assert.equal(r.kpis.importPricedCostEur, 0.31, '96 × 0,01 kWh × 32 ct = 0,3072 € → 0,31 €');
});

// ── Codex 7dc5e9e9 ──────────────────────────────────────────────────────────

test('Euro-Beträge aus den ungerundeten ct-Summen (keine doppelte Rundung an der Halb-Cent-Grenze)', async () => {
  // Eine Viertelstunde, 0,15 kWh: Festtag 29,99 ct → 4,4985 ct = 0,04 €; dynamisch 17,99 + 12 = 29,99 ct.
  const one = (ts, price) => {
    const slots = [{ ts, importKwh: 0.15, exportKwh: 0, loadKwh: 0.15, pvKwh: 0, sourceKind: 'local_live', sourceKinds: ['local_live'] }];
    return {
      async listMaterializedEnergySlots() { return slots; },
      async listAggregatedEnergySlots() { return slots; },
      async listPriceSlots() { return price == null ? [] : [{ ts, priceCtKwh: price }]; }
    };
  };
  const fixed = await runtimeFor(one('2026-05-01T10:00:00.000Z', null), { mode: 'fixed', fixedGrossImportCtKwh: 29.99, periods: [] })
    .getSummary({ view: 'day', date: '2026-05-01' });
  assert.equal(fixed.kpis.importPricedCostEur, 0.04, '4,4985 ct → 0,04 € (nicht über 4,50 ct → 0,05 €)');
  const dyn = await runtimeFor(one('2026-05-01T10:00:00.000Z', 17.99), { ...PRICING_SWITCH, comparisonFixedCtKwh: 29.99 })
    .getSummary({ view: 'day', date: '2026-05-01' });
  assert.equal(dyn.kpis.fixedCompareActualEur, 0.04);
  assert.equal(dyn.kpis.fixedCompareFixedEur, 0.04);
  assert.equal(dyn.kpis.fixedCompareSavingsEur, 0);
});
