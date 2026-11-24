// services/peak-shaving/billing.js — Leistungsentgelt in € für RLM-Anschlüsse (Christin 24.11.2026, P4).
//
// Rechtsgrundlage StromNEV § 17 Abs. 2: Netzentgelt = Leistungspreis (€/kW·a) × Jahreshöchstleistung + Arbeitspreis
// (ct/kWh) × Arbeit. Beide Preise gibt es in zwei Stufen nach der Benutzungsdauer T = Jahresarbeit / Jahreshöchst-
// leistung (StromNEV Anlage 4 Nr. 3): unter 2.500 h niedriger Leistungs- und hoher Arbeitspreis, ab 2.500 h
// umgekehrt. Jahreshöchstleistung ist in der Praxis der höchste 15-min-Mittelwert des Netzbezugs im Jahr. § 19 Abs. 1:
// wahlweise Monatsleistungspreis (€/kW·Monat) auf die Monatshöchstleistung, mit eigenem Arbeitspreis.
//
// Effektives Netzentgelt je kWh = Arbeitspreis + Leistungspreis / T. Wert einer gekappten kW = Leistungspreis der
// Stufe. Eine einzige ungekappte Viertelstunde im Jahr setzt die Jahreshöchstleistung (Recherche Merkel
// „RLM-Netzentgelte …“, 23.11.2026; Preisblatt Netz Leipzig 2026, NEW Netz 2026).
//
// Vermieden: Vergleich mit der Spitze OHNE Akku-Beitrag (je Viertelstunde Bezug + Akku-Entladung, Christin 24.11.)
// bei GLEICHER Arbeit — so zählt nur die Spitze (samt Stufenwechsel), nicht der Eigenverbrauch des Akkus. Das ist
// eine Obergrenze dessen, was Peak Shaving gebracht hat: auch ohne Peak Shaving hätte der Akku entladen.
//
// Rein: Eingaben sind die Monatswerte aus energy_slots_15m (telemetry-store-pg getPeakBillingMonths).

export const USAGE_HOURS_THRESHOLD = 2500;

const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const nonNeg = (v) => { const n = num(v); return n != null && n >= 0 ? n : null; };
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * Preise aus der Config (peakShaving.tariff). Leer = unbekannt; DVhub rät keine Preise.
 * @returns {{ model: 'year'|'month', low: {lpEurPerKwYear:number|null, apCtPerKwh:number|null},
 *   high: {lpEurPerKwYear:number|null, apCtPerKwh:number|null}, month: {lpEurPerKwMonth:number|null, apCtPerKwh:number|null},
 *   complete: boolean, missing: string[] }}
 */
export function resolveTariff(cfg = {}) {
  const t = cfg?.peakShaving?.tariff || {};
  const model = t.model === 'month' ? 'month' : 'year';
  const low = { lpEurPerKwYear: nonNeg(t.lpLowEurPerKwYear), apCtPerKwh: nonNeg(t.apLowCtPerKwh) };
  const high = { lpEurPerKwYear: nonNeg(t.lpHighEurPerKwYear), apCtPerKwh: nonNeg(t.apHighCtPerKwh) };
  const month = { lpEurPerKwMonth: nonNeg(t.lpMonthEurPerKwMonth), apCtPerKwh: nonNeg(t.apMonthCtPerKwh) };
  const need = model === 'month'
    ? [['lpMonthEurPerKwMonth', month.lpEurPerKwMonth], ['apMonthCtPerKwh', month.apCtPerKwh]]
    : [['lpLowEurPerKwYear', low.lpEurPerKwYear], ['apLowCtPerKwh', low.apCtPerKwh],
      ['lpHighEurPerKwYear', high.lpEurPerKwYear], ['apHighCtPerKwh', high.apCtPerKwh]];
  const missing = need.filter(([, v]) => v == null).map(([k]) => k);
  return { model, low, high, month, complete: missing.length === 0, missing };
}

/** Stufe nach Benutzungsdauer (h). */
export function tierFor(usageHours) {
  return usageHours != null && usageHours >= USAGE_HOURS_THRESHOLD ? 'high' : 'low';
}

/**
 * Netzentgelt eines Jahres nach Jahresleistungspreis (Arbeit E kWh, Spitze P W).
 * @returns {{ tier, usageHours, lpEurPerKwYear, apCtPerKwh, demandChargeEur, energyChargeEur, totalEur, effectiveCtPerKwh }}
 */
export function yearCharge({ energyKwh, peakW, tariff, usageHoursForTier = null }) {
  const E = nonNeg(energyKwh);
  const P = nonNeg(peakW);
  if (E == null || P == null || P <= 0) return null;
  const T = E / (P / 1000);
  const tier = tierFor(usageHoursForTier ?? T);
  const p = tier === 'high' ? tariff.high : tariff.low;
  if (p.lpEurPerKwYear == null || p.apCtPerKwh == null) return { tier, usageHours: T, lpEurPerKwYear: p.lpEurPerKwYear, apCtPerKwh: p.apCtPerKwh, demandChargeEur: null, energyChargeEur: null, totalEur: null, effectiveCtPerKwh: null };
  const demand = (P / 1000) * p.lpEurPerKwYear;
  const energy = (E * p.apCtPerKwh) / 100;
  const basisT = usageHoursForTier ?? T;
  return {
    tier,
    usageHours: T,
    lpEurPerKwYear: p.lpEurPerKwYear,
    apCtPerKwh: p.apCtPerKwh,
    demandChargeEur: demand,
    energyChargeEur: energy,
    totalEur: demand + energy,
    // AP + LP / T (€/kW·a ÷ h = €/kWh → × 100 ct)
    effectiveCtPerKwh: basisT > 0 ? p.apCtPerKwh + (p.lpEurPerKwYear * 100) / basisT : null
  };
}

/** Stunden eines Kalenderjahres bzw. bis jetzt (für die Hochrechnung der Benutzungsdauer). */
function hoursBetween(startMs, endMs) {
  return Math.max(0, (endMs - startMs) / 3_600_000);
}

/**
 * Jahresabrechnung aus Monatswerten.
 * @param {object} p
 * @param {Array<{ym:string, energyKwh:number, peakW:number, peakSlot?:string, uncappedPeakW?:number|null, slots?:number, batterySlots?:number}>} p.months
 * @param {ReturnType<typeof resolveTariff>} p.tariff
 * @param {{ startMs:number, endMs:number }} p.period   Jahr [start, end)
 * @param {number} [p.nowMs]   Hochrechnung, wenn das Jahr noch läuft
 */
export function computeYearBilling({ months = [], tariff, period, nowMs = Date.now() }) {
  const rows = months.filter((m) => nonNeg(m.energyKwh) != null);
  const E = rows.reduce((s, m) => s + Number(m.energyKwh), 0);
  const peakRow = rows.reduce((best, m) => (nonNeg(m.peakW) != null && (!best || Number(m.peakW) > Number(best.peakW)) ? m : best), null);
  const P = peakRow ? Number(peakRow.peakW) : null;
  const withBattery = rows.filter((m) => nonNeg(m.uncappedPeakW) != null && Number(m.batterySlots || 0) > 0);
  const Pu = withBattery.length ? Math.max(...withBattery.map((m) => Number(m.uncappedPeakW))) : null;
  const running = nowMs >= period.startMs && nowMs < period.endMs;
  const yearH = hoursBetween(period.startMs, period.endMs);
  const elapsedH = running ? hoursBetween(period.startMs, nowMs) : yearH;
  const usageHours = P > 0 ? E / (P / 1000) : null;
  const usageHoursProjected = usageHours != null && elapsedH > 0 ? usageHours * (yearH / elapsedH) : null;
  const out = {
    model: tariff.model,
    running,
    energyKwh: round2(E),
    peakW: P,
    peakSlot: peakRow?.peakSlot ?? null,
    uncappedPeakW: Pu,
    usageHours: round1(usageHours),
    usageHoursProjected: round1(running ? usageHoursProjected : usageHours),
    tier: null,
    tariffComplete: tariff.complete,
    tariffMissing: tariff.missing,
    months: rows.map((m) => monthRow(m, tariff, null))
  };
  if (tariff.model === 'month') {
    let total = 0; let demand = 0; let energy = 0; let avoided = 0; let avoidedKnown = false;
    const mrows = rows.map((m) => monthRow(m, tariff, null));
    for (const r of mrows) {
      if (r.totalEur == null) { total = null; break; }
      total += r.totalEur; demand += r.demandChargeEur; energy += r.energyChargeEur;
      if (r.avoidedEur != null) { avoided += r.avoidedEur; avoidedKnown = true; }
    }
    return {
      ...out,
      months: mrows,
      lpEurPerKwMonth: tariff.month.lpEurPerKwMonth,
      apCtPerKwh: tariff.month.apCtPerKwh,
      demandChargeEur: total == null ? null : round2(demand),
      energyChargeEur: total == null ? null : round2(energy),
      totalEur: total == null ? null : round2(total),
      effectiveCtPerKwh: total != null && E > 0 ? round2((total / E) * 100) : null,
      avoidedEur: total != null && avoidedKnown ? round2(avoided) : null
    };
  }
  // Jahresleistungspreis: Stufe nach der (hochgerechneten) Benutzungsdauer.
  const basis = running ? usageHoursProjected : usageHours;
  const c = P > 0 ? yearCharge({ energyKwh: E, peakW: P, tariff, usageHoursForTier: basis }) : null;
  let avoidedEur = null;
  let uncapped = null;
  if (c?.totalEur != null && Pu != null && Pu > 0) {
    // Gleiche Arbeit, Spitze ohne Akku-Beitrag; Stufe je aus der eigenen Benutzungsdauer. Im laufenden Jahr beide
    // Seiten mit der aufs Jahr hochgerechneten Arbeit — sonst stünde ein voller Jahres-Leistungspreis gegen ein
    // anteiliges Arbeitsentgelt (Codex f2bf3ea5 P2).
    const eYear = running && elapsedH > 0 ? E * (yearH / elapsedH) : E;
    const capped = yearCharge({ energyKwh: eYear, peakW: P, tariff });
    uncapped = yearCharge({ energyKwh: eYear, peakW: Pu, tariff });
    if (uncapped?.totalEur != null && capped?.totalEur != null) avoidedEur = Math.max(0, uncapped.totalEur - capped.totalEur);
  }
  const tier = c?.tier ?? null;
  return {
    ...out,
    tier,
    months: rows.map((m) => monthRow(m, tariff, tier)),
    lpEurPerKwYear: c?.lpEurPerKwYear ?? null,
    apCtPerKwh: c?.apCtPerKwh ?? null,
    demandChargeEur: round2(c?.demandChargeEur ?? null),
    energyChargeEur: round2(c?.energyChargeEur ?? null),
    totalEur: round2(c?.totalEur ?? null),
    effectiveCtPerKwh: round2(c?.effectiveCtPerKwh ?? null),
    uncappedTier: uncapped?.tier ?? null,
    uncappedTotalEur: round2(uncapped?.totalEur ?? null),
    avoidedEur: round2(avoidedEur)
  };
}

/**
 * Eine Monatszeile. Monatsleistungspreis: volle Monatsabrechnung. Jahresleistungspreis: nur das Arbeitsentgelt des
 * Monats in der Stufe des Jahres (der Leistungspreis fällt einmal im Jahr auf die Jahresspitze an).
 */
export function monthRow(m, tariff, yearTier) {
  const E = nonNeg(m.energyKwh);
  const P = nonNeg(m.peakW);
  const Pu = Number(m.batterySlots || 0) > 0 ? nonNeg(m.uncappedPeakW) : null;
  const base = { ym: m.ym, energyKwh: round2(E), peakW: P, peakSlot: m.peakSlot ?? null, uncappedPeakW: Pu };
  if (tariff.model === 'month') {
    const lp = tariff.month.lpEurPerKwMonth;
    const ap = tariff.month.apCtPerKwh;
    if (lp == null || ap == null || E == null || P == null) return { ...base, demandChargeEur: null, energyChargeEur: null, totalEur: null, avoidedEur: null };
    const demand = (P / 1000) * lp;
    const energy = (E * ap) / 100;
    return {
      ...base,
      demandChargeEur: round2(demand),
      energyChargeEur: round2(energy),
      totalEur: round2(demand + energy),
      avoidedEur: Pu != null ? round2(Math.max(0, (Pu - P) / 1000) * lp) : null
    };
  }
  const p = yearTier === 'high' ? tariff.high : yearTier === 'low' ? tariff.low : null;
  return {
    ...base,
    energyChargeEur: p?.apCtPerKwh != null && E != null ? round2((E * p.apCtPerKwh) / 100) : null
  };
}
