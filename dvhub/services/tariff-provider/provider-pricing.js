// services/tariff-provider/provider-pricing.js — Bezugspreis je Slot im Modus
// „Vom Stromanbieter“ (userEnergyPricing.mode = 'provider').
//
// Zwei Lesarten des Anbieterpreises (userEnergyPricing.provider.priceBasis):
//   gross_total  Der Anbieterpreis ist der Endpreis je kWh (brutto, mit
//                Netzentgelt, Umlagen, Steuern) — so zeigt ihn Tibber als
//                `total`. DVhub rechnet nichts dazu, auch kein §14a Modul 3:
//                Rechnet der Anbieter Modul 3 ab, steckt es schon im Preis.
//   net_energy   Der Anbieterpreis ist nur der Energiepreis netto. DVhub rechnet
//                wie beim dynamischen Tarif — Anbieterpreis statt Börsenpreis,
//                plus Aufschlag, Netzentgelt, Umlagen, MwSt; Modul 3 ersetzt
//                im Fenster das Netzentgelt.
//
// Fehlt der Anbieterpreis für einen Slot, wird er geschätzt: mit der
// Ausgleichsgeraden aus price-store.js, sonst wie der dynamische Tarif aus dem
// Börsenpreis und den hinterlegten Preisbestandteilen.

import { providerSlotAt, getProviderEstimate } from './price-store.js';

export const PROVIDER_NAMES = Object.freeze(['tibber', 'lichtblick']);
export const PRICE_BASES = Object.freeze(['gross_total', 'net_energy']);

function roundCtKwh(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function dynamicGross(energyCtKwh, components = {}, windowGrossCtKwh = null) {
  const withGrid = windowGrossCtKwh == null;
  const base = Number(energyCtKwh || 0)
    + Number(components.energyMarkupCtKwh || 0)
    + (withGrid ? Number(components.gridChargesCtKwh || 0) : 0)
    + Number(components.leviesAndFeesCtKwh || 0);
  return roundCtKwh(base * (1 + Number(components.vatPct || 0) / 100) + (withGrid ? 0 : Number(windowGrossCtKwh || 0)));
}

/**
 * Bezugspreis (ct/kWh, brutto) eines Slots im Anbieter-Modus.
 * @param {{ts:any, ct_kwh?:number|null}} row  Slot mit Börsenpreis (für die Schätzung)
 * @param {object} pricing  wirksame Preis-Einstellungen (mode 'provider')
 * @param {{priceCtKwh:number}|null} activeWindow  aktives Modul-3-Fenster
 * @returns {number|null}
 */
export function providerImportPriceCtKwh(row, pricing = {}, activeWindow = null) {
  const basis = pricing?.provider?.priceBasis === 'net_energy' ? 'net_energy' : 'gross_total';
  const components = pricing?.dynamicComponents || {};
  const windowCt = activeWindow ? activeWindow.priceCtKwh : null;
  const slot = providerSlotAt(row?.ts);
  const market = row?.ct_kwh == null || row.ct_kwh === '' ? NaN : Number(row.ct_kwh);

  let providerCt = slot ? slot.ctKwh : null;
  if (providerCt == null) {
    if (!Number.isFinite(market)) return null;
    const model = getProviderEstimate();
    if (model) providerCt = model.slope * market + model.intercept;
    else if (basis === 'gross_total') return dynamicGross(market, components, windowCt);
    else providerCt = market;
  }
  if (basis === 'net_energy') return dynamicGross(providerCt, components, windowCt);
  return roundCtKwh(providerCt);
}

/** Wird der Anbieter-Modus heute oder künftig genutzt (Grundtarif oder ein Zeitraum)? */
export function providerModeInUse(pricing = {}, todayLocalDate = null) {
  if (pricing?.mode === 'provider') return true;
  const periods = Array.isArray(pricing?.periods) ? pricing.periods : [];
  return periods.some((p) => p?.mode === 'provider' && (!todayLocalDate || String(p.endDate || '') >= todayLocalDate));
}
