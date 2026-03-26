// user-energy-pricing.js -- Pure domain pricing functions.
// Extracted from server.js (Phase 1, Plan 02).
// Imports only from server-utils.js and schedule-runtime.js. ZERO state/config dependencies.

import { roundCtKwh, localMinutesOfDay } from './server-utils.js';
import { parseHHMM } from './schedule-runtime.js';

// --- Helpers ---

export function configuredModule3Windows(pricing = {}) {
  if (!pricing?.usesParagraph14aModule3) return [];
  return Object.entries(pricing.module3Windows || {})
    .map(([id, window]) => {
      const start = parseHHMM(window?.start);
      const end = parseHHMM(window?.end);
      const priceCtKwh = Number(window?.priceCtKwh);
      if (window?.enabled !== true || start == null || end == null || !Number.isFinite(priceCtKwh)) return null;
      return {
        id,
        label: window?.label ? String(window.label) : id,
        start,
        end,
        priceCtKwh: roundCtKwh(priceCtKwh)
      };
    })
    .filter(Boolean);
}

function slotMinuteMatchesWindow(minuteOfDay, window) {
  if (!window) return false;
  if (window.start <= window.end) return minuteOfDay >= window.start && minuteOfDay < window.end;
  return minuteOfDay >= window.start || minuteOfDay < window.end;
}

function computeDynamicGrossImportCtKwh(marketCtKwh, components = {}) {
  const base =
    Number(marketCtKwh || 0)
    + Number(components.energyMarkupCtKwh || 0)
    + Number(components.gridChargesCtKwh || 0)
    + Number(components.leviesAndFeesCtKwh || 0);
  return roundCtKwh(base * (1 + (Number(components.vatPct || 0) / 100)));
}

// --- Public exports ---

export function effectiveBatteryCostCtKwh(costs = {}) {
  const pvCtKwh = Number(costs?.pvCtKwh);
  const base = Number(costs?.batteryBaseCtKwh);
  if (!Number.isFinite(base) && !Number.isFinite(pvCtKwh)) return null;
  const markup = Number(costs?.batteryLossMarkupPct || 0);
  const combinedBase =
    (Number.isFinite(pvCtKwh) ? pvCtKwh : 0)
    + (Number.isFinite(base) ? base : 0);
  return roundCtKwh(combinedBase * (1 + markup / 100));
}

export function mixedCostCtKwh(costs = {}) {
  const pvCtKwh = Number(costs?.pvCtKwh);
  const batteryCtKwh = effectiveBatteryCostCtKwh(costs);
  if (Number.isFinite(pvCtKwh) && Number.isFinite(batteryCtKwh)) return roundCtKwh((pvCtKwh + batteryCtKwh) / 2);
  if (Number.isFinite(pvCtKwh)) return roundCtKwh(pvCtKwh);
  if (Number.isFinite(batteryCtKwh)) return roundCtKwh(batteryCtKwh);
  return null;
}

export function resolveImportPriceCtKwhForSlot(row, pricing = {}, timezone = 'Europe/Berlin') {
  if (!row) return null;
  const minuteOfDay = localMinutesOfDay(new Date(row.ts), timezone);
  for (const window of configuredModule3Windows(pricing)) {
    if (slotMinuteMatchesWindow(minuteOfDay, window)) return window.priceCtKwh;
  }

  if (pricing?.mode === 'fixed') {
    const fixed = Number(pricing?.fixedGrossImportCtKwh);
    return Number.isFinite(fixed) ? roundCtKwh(fixed) : null;
  }

  return computeDynamicGrossImportCtKwh(Number(row.ct_kwh || 0), pricing?.dynamicComponents || {});
}

export function slotComparison(row, pricing = {}, timezone = 'Europe/Berlin') {
  if (!row) return null;
  const importPriceCtKwh = resolveImportPriceCtKwhForSlot(row, pricing, timezone);
  const pvCtKwh = Number(pricing?.costs?.pvCtKwh);
  const batteryCtKwh = effectiveBatteryCostCtKwh(pricing?.costs || {});
  const mixedCt = mixedCostCtKwh(pricing?.costs || {});
  const exportPriceCtKwh = roundCtKwh(Number(row.ct_kwh || 0));

  const margins = [
    Number.isFinite(pvCtKwh) ? { source: 'pv', marginCtKwh: roundCtKwh(exportPriceCtKwh - pvCtKwh) } : null,
    Number.isFinite(batteryCtKwh) ? { source: 'battery', marginCtKwh: roundCtKwh(exportPriceCtKwh - batteryCtKwh) } : null,
    Number.isFinite(mixedCt) ? { source: 'mixed', marginCtKwh: roundCtKwh(exportPriceCtKwh - mixedCt) } : null
  ].filter(Boolean);
  const best = margins.length
    ? margins.reduce((winner, entry) => (winner == null || entry.marginCtKwh > winner.marginCtKwh ? entry : winner), null)
    : null;

  return {
    ts: row.ts,
    exportPriceCtKwh,
    importPriceCtKwh,
    spreadToImportCtKwh: Number.isFinite(importPriceCtKwh) ? roundCtKwh(exportPriceCtKwh - importPriceCtKwh) : null,
    pvMarginCtKwh: Number.isFinite(pvCtKwh) ? roundCtKwh(exportPriceCtKwh - pvCtKwh) : null,
    batteryMarginCtKwh: Number.isFinite(batteryCtKwh) ? roundCtKwh(exportPriceCtKwh - batteryCtKwh) : null,
    mixedMarginCtKwh: Number.isFinite(mixedCt) ? roundCtKwh(exportPriceCtKwh - mixedCt) : null,
    bestSource: best?.source || null,
    bestMarginCtKwh: best?.marginCtKwh ?? null
  };
}
