// Auswertung Anbieterpreis ↔ Day-Ahead (services/tariff-provider/price-stats.js):
// Mittelwerte, Ausgleichsgerade brutto und netto, mittlere Abweichung.
// Christin 01.11.2026: LichtBlick rechnet IDA1 × Risikofaktor + feste Umlagen —
// die Kennzahlen sollen Aufschlag und Faktor aus den geloggten Preisen zeigen.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pairProviderWithMarket, computeProviderPriceStats, STATS_MIN_PAIRS, clampStatsDays
} from '../services/tariff-provider/price-stats.js';

const Q = 900_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function series(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

test('Paare: nur Viertelstunden mit beiden Preisen; Stundenpreis des Anbieters gilt für alle vier Viertel', () => {
  const provider = [
    { ts: iso(T0), value: 40, resolutionSeconds: 900 },
    { ts: iso(T0 + Q), value: 41, resolutionSeconds: 900 },           // kein Börsenpreis → fällt weg
    { ts: iso(T0 + 4 * Q), value: 50, resolutionSeconds: 3600 }       // Stunde → 4 Viertel
  ];
  const market = [
    { ts: iso(T0), priceCtKwh: 10 },
    { ts: iso(T0 + 4 * Q), priceCtKwh: 11 },
    { ts: iso(T0 + 5 * Q), priceCtKwh: null, priceEurMwh: 120 },        // nur €/MWh → 12 ct
    { ts: iso(T0 + 6 * Q), priceCtKwh: 13 },
    { ts: iso(T0 + 7 * Q), priceCtKwh: 14 },
    { ts: iso(T0 + 8 * Q), priceCtKwh: 99 }                             // nach der Stunde → nicht dabei
  ];
  const pairs = pairProviderWithMarket(provider, market);
  assert.deepEqual(pairs.map((p) => [p.ts, p.provider, p.market]), [
    [T0, 40, 10],
    [T0 + 4 * Q, 50, 11],
    [T0 + 5 * Q, 50, 12],
    [T0 + 6 * Q, 50, 13],
    [T0 + 7 * Q, 50, 14]
  ]);
});

test('Kennzahlen: Brutto-Gerade, Netto-Formel ≈ a + b × Börse, Mittelwerte, Abweichung 0 bei exakter Formel', () => {
  // LichtBlick-artig: netto = 18 ct + 1,1 × Börse, brutto mit 19 % MwSt.
  const pairs = series(96, (i) => {
    const market = -2 + i * 0.25;
    return { ts: T0 + i * Q, market, provider: (18 + 1.1 * market) * 1.19 };
  });
  const s = computeProviderPriceStats(pairs, { vatPct: 19, priceBasis: 'gross_total' });
  assert.equal(s.pairs, 96);
  const meanMarket = pairs.reduce((a, p) => a + p.market, 0) / 96;
  assert.ok(Math.abs(s.meanMarketCtKwh - meanMarket) < 0.01);
  assert.ok(Math.abs(s.meanProviderCtKwh - (18 + 1.1 * meanMarket) * 1.19) < 0.01);
  assert.ok(Math.abs(s.meanSpreadCtKwh - (s.meanProviderCtKwh - s.meanMarketCtKwh)) < 0.02);
  assert.ok(Math.abs(s.formula.net.interceptCtKwh - 18) < 0.001, `a netto ${s.formula.net.interceptCtKwh}`);
  assert.ok(Math.abs(s.formula.net.slope - 1.1) < 0.0001, `b netto ${s.formula.net.slope}`);
  assert.ok(Math.abs(s.formula.gross.interceptCtKwh - 18 * 1.19) < 0.001);
  assert.ok(Math.abs(s.formula.gross.slope - 1.1 * 1.19) < 0.0001);
  assert.equal(s.formula.meanAbsDeviationCtKwh, 0);
  assert.equal(s.formula.r2, 1);
  assert.equal(s.firstSlot, iso(T0));
  assert.equal(s.lastSlot, iso(T0 + 95 * Q));
});

test('Kennzahlen: Streuung ergibt mittlere und größte Abweichung; netto ohne MwSt bei „nur Energiepreis netto“', () => {
  const pairs = series(40, (i) => ({ ts: T0 + i * Q, market: i, provider: 30 + i + (i % 2 ? 0.5 : -0.5) }));
  const gross = computeProviderPriceStats(pairs, { vatPct: 19, priceBasis: 'gross_total' });
  assert.ok(Math.abs(gross.formula.meanAbsDeviationCtKwh - 0.5) < 0.02);
  assert.ok(Math.abs(gross.formula.maxAbsDeviationCtKwh - 0.5) < 0.05);
  assert.ok(gross.formula.r2 > 0.99 && gross.formula.r2 < 1);
  const net = computeProviderPriceStats(pairs, { vatPct: 19, priceBasis: 'net_energy' });
  assert.equal(net.formula.net.slope, net.formula.gross.slope, 'schon netto');
  assert.equal(net.formula.net.interceptCtKwh, net.formula.gross.interceptCtKwh);
  assert.equal(net.priceBasis, 'net_energy');
});

test('Kennzahlen: zu wenige Paare oder konstanter Börsenpreis → Mittelwerte ja, Formel nein', () => {
  const few = series(STATS_MIN_PAIRS - 1, (i) => ({ ts: T0 + i * Q, market: i, provider: 30 + i }));
  const s = computeProviderPriceStats(few);
  assert.equal(s.pairs, STATS_MIN_PAIRS - 1);
  assert.ok(Number.isFinite(s.meanProviderCtKwh));
  assert.equal(s.formula, null);
  const flat = series(50, (i) => ({ ts: T0 + i * Q, market: 8, provider: 30 + (i % 3) }));
  assert.equal(computeProviderPriceStats(flat).formula, null, 'ohne Streuung der Börse keine Steigung');
  const none = computeProviderPriceStats([]);
  assert.deepEqual({ n: none.pairs, mp: none.meanProviderCtKwh, f: none.formula }, { n: 0, mp: null, f: null });
});

test('Zeitraum: 1 bis 365 Tage, Standard 30', () => {
  assert.equal(clampStatsDays(undefined), 30);
  assert.equal(clampStatsDays('abc'), 30);
  assert.equal(clampStatsDays(0), 1);
  assert.equal(clampStatsDays('7'), 7);
  assert.equal(clampStatsDays(9999), 365);
});
