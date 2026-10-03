import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryRuntime, SUMMARY_CACHE_VERSION } from '../history-runtime.js';
import { getEegNegativePriceRule } from '../eeg-rules.js';

// Vorberechnete Historie (Jahr/Alle): der Rechenstand nach jedem abgeschlossenen
// Monat wird abgelegt, ein Aufruf rechnet nur die Monate danach. Diese Tests
// halten fest:
//   - das Ergebnis ist mit Ablage exakt dasselbe wie ohne (kalt und warm),
//   - abgeschlossene Monate werden nicht mehr aus den Rohdaten gelesen,
//   - ein geänderter Monatsmarktwert oder geänderte Rohdaten lassen ab diesem
//     Monat neu rechnen, die Monate davor bleiben gültig.

const SLOT_MS = 4 * 3600_000; // 6 Slots je Tag reichen; Werte bewusst „krumm“
const DATA_START = Date.UTC(2025, 4, 1); // Daten ab Mai 2025
const TODAY = '2026-09-05';
const DATA_END = Date.UTC(2026, 8, 5, 12);

function makeDataset() {
  const slots = [];
  const prices = [];
  for (let t = DATA_START, i = 0; t < DATA_END; t += SLOT_MS, i += 1) {
    const ts = new Date(t).toISOString();
    const pv = ((i * 37) % 23) / 7.3;
    const load = 0.31 + ((i * 11) % 13) / 9.1;
    const direct = Math.min(pv, load);
    const toGrid = Math.max(0, pv - direct) * 0.6;
    const toBat = Math.max(0, pv - direct) * 0.4;
    const batUse = (i % 5 === 0) ? 0.27 : 0;
    const batGrid = (i % 7 === 0) ? 0.41 : 0;
    const gridUse = Math.max(0, load - direct - batUse);
    slots.push({
      ts,
      importKwh: gridUse, exportKwh: toGrid + batGrid, gridKwh: gridUse - toGrid - batGrid,
      pvKwh: pv, pvAcKwh: pv * 0.97,
      batteryKwh: batUse + batGrid - toBat, batteryChargeKwh: toBat, batteryDischargeKwh: batUse + batGrid,
      loadKwh: load,
      solarDirectUseKwh: direct, solarToBatteryKwh: toBat, solarToGridKwh: toGrid,
      gridDirectUseKwh: gridUse, gridToBatteryKwh: 0, batteryDirectUseKwh: batUse, batteryToGridKwh: batGrid,
      selfConsumptionKwh: direct + batUse,
      sourceKind: i % 9 === 0 ? 'vrm_import' : 'local_live',
      sourceKinds: i % 9 === 0 ? ['vrm_import'] : ['local_live'],
      estimated: i % 31 === 0, incomplete: false,
      estimatedSeriesCount: 0, incompleteSeriesCount: 0,
      estimatedSeriesKeys: [], incompleteSeriesKeys: []
    });
    // Preise mit Negativ-Strecken, auch über Monatsgrenzen hinweg.
    const price = ((i * 13) % 29) - 6 + (i % 4) * 0.37;
    prices.push({ ts, priceCtKwh: price });
  }
  return { slots, prices };
}

function createStore({ withCache }) {
  const data = makeDataset();
  const store = {
    data,
    slotRequests: [],
    cache: new Map(),
    puts: 0,
    dataVersion: new Map(), // 'YYYY-MM' (UTC-Start des Abschnitts) → Zähler
    listMaterializedEnergySlots({ start, end }) {
      store.slotRequests.push({ start, end });
      return data.slots.filter((s) => s.ts >= start && s.ts < end).map((s) => ({ ...s }));
    },
    listAggregatedEnergySlots() { throw new Error('raw fallback must not run'); },
    listPriceSlots({ start, end }) {
      return data.prices.filter((p) => p.ts >= start && p.ts < end).map((p) => ({ ...p }));
    }
  };
  if (withCache) {
    store.historySectionFingerprints = async ({ boundaries }) => {
      const out = [];
      for (let i = 0; i + 1 < boundaries.length; i += 1) {
        const a = new Date(boundaries[i]).toISOString();
        const b = new Date(boundaries[i + 1]).toISOString();
        const rows = data.slots.filter((s) => s.ts >= a && s.ts < b);
        const version = store.dataVersion.get(a) || 0;
        out.push({ slotRows: rows.length, fp: `${rows.length}|${version}` });
      }
      return out;
    };
    store.getHistoryCacheEntries = async (prefix) => new Map([...store.cache].filter(([k]) => k.startsWith(prefix)));
    store.putHistoryCacheEntry = async (key, fingerprint, payload) => { store.puts += 1; store.cache.set(key, { fingerprint, payload }); };
  }
  return store;
}

const PRICING = {
  costs: { pvCtKwh: 6.5, batteryCtKwh: 4.2 },
  pvPlants: [{ kwp: 14.4, commissionedAt: '2023-04-01' }],
  usesMarketPremium: true
};

function makeRuntime(store, { pricing = PRICING, today = TODAY } = {}) {
  return createHistoryRuntime({
    store,
    getPricingConfig: () => pricing,
    getOptimizerConfig: () => ({ batteryCapacityWh: 43000 }),
    getApplicableValueSummary: () => ({ applicableValueCtKwhByMonth: {}, getApplicableValueCtKwh: () => 8.1 }),
    getCurrentDate: () => today
  });
}

const MARKET = {
  monthlyCtKwhByMonth: {
    '2025-05': 4.1, '2025-06': 3.2, '2025-07': 4.9, '2025-08': 5.6, '2025-09': 6.3, '2025-10': 7.4, '2025-11': 8.8, '2025-12': 9.1,
    '2026-01': 9.9, '2026-02': 8.2, '2026-03': 5.5, '2026-04': 3.1, '2026-05': 2.8, '2026-06': 3.9, '2026-07': 4.4, '2026-08': 5.2
  },
  annualCtKwhByYear: { 2025: 5.9 }
};

async function plain(view, date, market = MARKET, opts) {
  return makeRuntime(createStore({ withCache: false }), opts).getSummary({ view, date, solarMarketValues: market });
}

test('Jahr: kalt und warm exakt wie ohne Ablage; warm liest nur den laufenden Monat', async () => {
  const expected = await plain('year', TODAY);
  assert.ok(expected.kpis.pvKwh > 0 && expected.rows.length === 9, 'Testdaten tragen (9 Monate 2026)');

  const store = createStore({ withCache: true });
  const runtime = makeRuntime(store);
  const cold = await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET });
  assert.deepStrictEqual(cold, expected, 'kalt (Ablage wird gefüllt) = ohne Ablage');
  assert.equal(store.puts, 8, 'Jan–Aug abgelegt, der laufende September nicht');
  assert.ok([...store.cache.keys()].every((k) => k.startsWith(`v${SUMMARY_CACHE_VERSION}|year|2026-01-01|`)));

  store.slotRequests.length = 0;
  const warm = await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET });
  assert.deepStrictEqual(warm, expected, 'warm = ohne Ablage');
  // Jan–Aug aus der Ablage; gelesen werden nur noch Sep (laufend) und Okt–Dez (leer).
  const months = store.slotRequests.map((r) => r.start.slice(0, 7));
  assert.ok(!months.some((m) => m >= '2025-12' && m < '2026-08'), `abgeschlossene Monate gelesen: ${months}`);
  assert.equal(store.slotRequests.length, 4);
  assert.equal(store.puts, 8, 'nichts neu abgelegt');
});

test('abgeschlossenes Jahr: warm ganz ohne Rohdaten-Abruf', async () => {
  const expected = await plain('year', '2025-06-15');
  const store = createStore({ withCache: true });
  const runtime = makeRuntime(store);
  assert.deepStrictEqual(await runtime.getSummary({ view: 'year', date: '2025-06-15', solarMarketValues: MARKET }), expected);
  store.slotRequests.length = 0;
  assert.deepStrictEqual(await runtime.getSummary({ view: 'year', date: '2025-06-15', solarMarketValues: MARKET }), expected);
  assert.equal(store.slotRequests.length, 0, 'kein Monat mehr aus den Rohdaten gelesen');
});

test('Alle: warm = ohne Ablage, nur der laufende Monat wird gelesen', async () => {
  const expected = await plain('all', TODAY);
  assert.equal(expected.rows.length, 2, 'Zeilen 2025 und 2026');
  const store = createStore({ withCache: true });
  const runtime = makeRuntime(store);
  assert.deepStrictEqual(await runtime.getSummary({ view: 'all', date: TODAY, solarMarketValues: MARKET }), expected);
  store.slotRequests.length = 0;
  assert.deepStrictEqual(await runtime.getSummary({ view: 'all', date: TODAY, solarMarketValues: MARKET }), expected);
  const read = store.slotRequests.map((r) => r.start.slice(0, 7));
  assert.ok(read.every((m) => m >= '2026-08'), `nur ab dem laufenden Monat gelesen: ${read}`);
});

test('neuer Monatsmarktwert: ab diesem Monat neu gerechnet, davor aus der Ablage', async () => {
  const store = createStore({ withCache: true });
  const runtime = makeRuntime(store);
  await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET });

  const changed = { ...MARKET, monthlyCtKwhByMonth: { ...MARKET.monthlyCtKwhByMonth, '2026-06': 4.7 } };
  const expected = await plain('year', TODAY, changed);
  store.slotRequests.length = 0;
  const putsBefore = store.puts;
  const result = await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: changed });
  assert.deepStrictEqual(result, expected, 'Ergebnis mit dem neuen Marktwert');
  assert.notDeepStrictEqual(result.kpis, (await plain('year', TODAY)).kpis, 'der Marktwert wirkt sich aus');
  const read = store.slotRequests.map((r) => r.start.slice(0, 7));
  assert.ok(read.every((m) => m >= '2026-05'), `Jan–Mai nicht neu gelesen: ${read}`);
  assert.equal(store.puts - putsBefore, 3, 'Jun, Jul, Aug neu abgelegt');

  // Danach wieder warm.
  store.slotRequests.length = 0;
  assert.deepStrictEqual(await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: changed }), expected);
  assert.equal(store.slotRequests.length, 4);
});

test('geänderte Rohdaten (z. B. VRM-Import): ab dem Monat neu aus den Rohdaten', async () => {
  const store = createStore({ withCache: true });
  const runtime = makeRuntime(store);
  await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET });

  // Ein März-Slot wird korrigiert; die Rohdaten-Tabelle meldet das über updated_at.
  const target = store.data.slots.find((s) => s.ts.startsWith('2026-03-10'));
  target.exportKwh += 2.5; target.solarToGridKwh += 2.5; target.pvKwh += 2.5;
  const marchStartUtc = '2026-02-28T23:00:00.000Z';
  store.dataVersion.set(marchStartUtc, 1);

  const reference = createStore({ withCache: false });
  const refTarget = reference.data.slots.find((s) => s.ts === target.ts);
  Object.assign(refTarget, { exportKwh: target.exportKwh, solarToGridKwh: target.solarToGridKwh, pvKwh: target.pvKwh });
  const expected = await makeRuntime(reference).getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET });

  store.slotRequests.length = 0;
  const result = await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET });
  assert.deepStrictEqual(result, expected);
  const read = store.slotRequests.map((r) => r.start.slice(0, 7));
  assert.ok(read.every((m) => m >= '2026-02'), `Jan/Feb nicht neu gelesen: ${read}`);
});

test('geänderte Tarife: alles neu, Ergebnis wie ohne Ablage', async () => {
  const store = createStore({ withCache: true });
  await makeRuntime(store).getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET });
  const pricing = { ...PRICING, costs: { pvCtKwh: 7.9, batteryCtKwh: 4.2 } };
  const expected = await plain('year', TODAY, MARKET, { pricing });
  store.slotRequests.length = 0;
  assert.deepStrictEqual(await makeRuntime(store, { pricing }).getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET }), expected);
  assert.equal(store.slotRequests.length, 12, 'kein Stand passt mehr → alle Monate gelesen');
});

test('§51 stundenbasierte Regel: Negativstunden-Zähler läuft über die Ablage weiter', async () => {
  const pricing = { ...PRICING, pvPlants: [{ kwp: 520, commissionedAt: '2021-03-01' }] };
  const rule = getEegNegativePriceRule({ commissionedAt: '2021-03-01', kwp: 520 }).rule;
  assert.ok(rule !== 'none' && rule !== '15min', `Testanlage hat eine Stundenregel (${rule})`);
  const expected = await plain('year', TODAY, MARKET, { pricing });
  const store = createStore({ withCache: true });
  const runtime = makeRuntime(store, { pricing });
  assert.deepStrictEqual(await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET }), expected);
  store.slotRequests.length = 0;
  assert.deepStrictEqual(await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET }), expected);
  assert.ok(store.slotRequests.every((r) => r.start.slice(0, 7) >= '2026-08'), 'auch das Vortags-Warm-up entfällt');
});

test('beschädigter Eintrag: es wird ohne Ablage richtig gerechnet', async () => {
  const store = createStore({ withCache: true });
  const runtime = makeRuntime(store);
  const expected = await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET });
  const key = [...store.cache.keys()].find((k) => k.endsWith('2026-04'));
  store.cache.set(key, { fingerprint: store.cache.get(key).fingerprint, payload: Buffer.from('kaputt') });
  assert.deepStrictEqual(await runtime.getSummary({ view: 'year', date: TODAY, solarMarketValues: MARKET }), expected);
});
