// services/tariff-provider/price-stats.js — Auswertung Anbieterpreis ↔ Day-Ahead.
//
// Christin 01.11.2026: LichtBlick ÖkoStrom Dynamic rechnet laut AGB den
// Intraday-Preis (IDA1) × Risikofaktor plus feste Umlagen; Tibber den
// Day-Ahead-Preis plus Aufschlag. DVhub loggt den Endpreis des Anbieters je
// Viertelstunde (Reihe tariff_import_ct_kwh) neben dem Day-Ahead-Preis
// (price_ct_kwh). Hier entstehen daraus kleine Kennzahlen:
//
//   Mittelwerte      Anbieterpreis (wie geliefert), Day-Ahead, Abstand
//   Formel           Anbieterpreis ≈ a + b × Day-Ahead (kleinste Quadrate),
//                    netto: brutto ÷ (1 + MwSt) — b ist dann der Faktor auf den
//                    Börsenpreis (bei LichtBlick ≈ Risikofaktor, solange IDA1 ≈
//                    Day-Ahead), a Aufschlag + Netzentgelt + Umlagen netto
//   Abweichung       mittlere und größte Abweichung des Anbieterpreises von
//                    der Formel (brutto, wie bezahlt) und R²
//
// Anders als fitProviderEstimate (price-store.js) ohne Plausibilitätsgrenzen:
// Hier soll sichtbar werden, was der Anbieter tatsächlich rechnet.

export const STATS_MIN_PAIRS = 16;
export const STATS_DEFAULT_DAYS = 30;
export const STATS_MAX_DAYS = 365;
const QUARTER_MS = 15 * 60 * 1000;

const round = (v, digits) => {
  const f = 10 ** digits;
  return Math.round((v + Number.EPSILON) * f) / f;
};

/** Auswertungszeitraum in Tagen: ganze Zahl 1 … 365, sonst 30. */
export function clampStatsDays(days) {
  const n = Math.floor(Number(days));
  if (days == null || days === '' || !Number.isFinite(n)) return STATS_DEFAULT_DAYS;
  return Math.min(STATS_MAX_DAYS, Math.max(1, n));
}

function marketCtKwh(slot) {
  const ct = slot?.priceCtKwh == null || slot.priceCtKwh === '' ? NaN : Number(slot.priceCtKwh);
  if (Number.isFinite(ct)) return ct;
  const eur = slot?.priceEurMwh == null || slot.priceEurMwh === '' ? NaN : Number(slot.priceEurMwh);
  return Number.isFinite(eur) ? eur / 10 : NaN;
}

/**
 * Anbieterpreise (Reihe tariff_import_ct_kwh) und Day-Ahead-Viertelstunden
 * (listPriceSlots) zu Paaren je Viertelstunde. Ein Stundenpreis des Anbieters
 * gilt für alle vier Viertel seiner Stunde.
 * @param {Array<{ts:string|number, value:number, resolutionSeconds?:number}>} providerRows
 * @param {Array<{ts:string|number, priceCtKwh?:number|null, priceEurMwh?:number|null}>} marketSlots
 * @returns {Array<{ts:number, provider:number, market:number}>}
 */
export function pairProviderWithMarket(providerRows = [], marketSlots = []) {
  const market = new Map();
  for (const slot of marketSlots) {
    const ts = typeof slot?.ts === 'number' ? slot.ts : new Date(slot?.ts).getTime();
    const ct = marketCtKwh(slot);
    if (Number.isFinite(ts) && Number.isFinite(ct)) market.set(ts, ct);
  }
  const byTs = new Map();
  for (const row of providerRows) {
    const ts = typeof row?.ts === 'number' ? row.ts : new Date(row?.ts).getTime();
    const value = row?.value == null || row.value === '' ? NaN : Number(row.value);
    if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
    const quarters = Math.max(1, Math.round((Number(row.resolutionSeconds) || 900) / 900));
    for (let q = 0; q < quarters; q += 1) {
      const slotTs = ts + q * QUARTER_MS;
      const m = market.get(slotTs);
      if (m != null) byTs.set(slotTs, { ts: slotTs, provider: value, market: m });
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * Kennzahlen aus den Paaren.
 * @param {Array<{ts:number, provider:number, market:number}>} pairs
 * @param {{vatPct?:number, priceBasis?:'gross_total'|'net_energy'}} opts
 */
export function computeProviderPriceStats(pairs = [], { vatPct = 19, priceBasis = 'gross_total' } = {}) {
  const basis = priceBasis === 'net_energy' ? 'net_energy' : 'gross_total';
  const vat = Number.isFinite(Number(vatPct)) ? Number(vatPct) : 19;
  const clean = pairs.filter((p) => Number.isFinite(p?.provider) && Number.isFinite(p?.market));
  const n = clean.length;
  const out = {
    pairs: n,
    priceBasis: basis,
    vatPct: vat,
    firstSlot: n ? new Date(clean[0].ts).toISOString() : null,
    lastSlot: n ? new Date(clean[n - 1].ts).toISOString() : null,
    meanProviderCtKwh: null,
    meanMarketCtKwh: null,
    meanSpreadCtKwh: null,
    formula: null
  };
  if (!n) return out;
  const mx = clean.reduce((s, p) => s + p.market, 0) / n;
  const my = clean.reduce((s, p) => s + p.provider, 0) / n;
  out.meanProviderCtKwh = round(my, 3);
  out.meanMarketCtKwh = round(mx, 3);
  out.meanSpreadCtKwh = round(my - mx, 3);
  if (n < STATS_MIN_PAIRS) return out;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of clean) {
    sxx += (p.market - mx) ** 2;
    sxy += (p.market - mx) * (p.provider - my);
    syy += (p.provider - my) ** 2;
  }
  if (sxx / n < 1e-6) return out;   // Börsenpreis ohne Streuung: keine Steigung
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let absSum = 0;
  let absMax = 0;
  let sse = 0;
  for (const p of clean) {
    const r = p.provider - (intercept + slope * p.market);
    absSum += Math.abs(r);
    absMax = Math.max(absMax, Math.abs(r));
    sse += r * r;
  }
  const toNet = basis === 'gross_total' ? 1 / (1 + vat / 100) : 1;
  out.formula = {
    gross: { interceptCtKwh: round(intercept, 3), slope: round(slope, 4) },
    net: { interceptCtKwh: round(intercept * toNet, 3), slope: round(slope * toNet, 4) },
    r2: syy > 1e-12 ? round(Math.max(0, 1 - sse / syy), 4) : 1,
    meanAbsDeviationCtKwh: round(absSum / n, 3),
    maxAbsDeviationCtKwh: round(absMax, 3)
  };
  return out;
}
