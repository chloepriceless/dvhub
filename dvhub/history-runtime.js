import fs from 'node:fs';
import path from 'node:path';
import { resolveUserImportPriceCtKwhForSlot } from './config-model.js';
import { getEegNegativePriceRule, getFeedInCompensationCtKwh, isNegativePriceSlotAffected } from './eeg-rules.js';
import { vollastViertelstunden, extensionFromVollast } from './eeg-extension.js';
// Sweep package 6: shared 2-decimal rounding helper (was a local round2 duplicate).
import { round2 } from './server-utils.js';
// WS3 (2026-05-30): PVGIS-derived monthly expected production (real array
// geometry) replaces the crude static monthly-distribution estimate.
import { readCachedPvgisMonthly } from './pvgis-expected-production.js';

const PVGIS_EXPECTED_CACHE_PATH = path.join(
  process.env.DV_DATA_DIR || '.',
  'reference-data',
  'pvgis-expected-production.json',
);

const BERLIN_TIME_ZONE = 'Europe/Berlin';
const SUPPORTED_VIEWS = new Set(['day', 'week', 'month', 'year', 'all']);
const SLOT_BUCKET_SECONDS = 900;
const AGGREGATE_SUM_FIELDS = [
  'importKwh',
  'exportKwh',
  'loadKwh',
  'pvKwh',
  'pvAcKwh',
  'solarDirectUseKwh',
  'solarToBatteryKwh',
  'solarToGridKwh',
  'gridDirectUseKwh',
  'gridToBatteryKwh',
  'batteryDirectUseKwh',
  'batteryToGridKwh',
  'batteryChargeKwh',
  'batteryDischargeKwh',
  'selfConsumptionKwh',
  'gridShareKwh',
  'pvShareKwh',
  'batteryShareKwh',
  'importCostEur',
  'gridCostEur',
  'pvCostEur',
  'batteryCostEur',
  'avoidedImportGrossEur',
  'avoidedImportPvGrossEur',
  'avoidedImportBatteryGrossEur',
  'opportunityCostEur',
  'opportunityCostPvEur',
  'opportunityCostBatteryEur',
  'selfConsumptionCostEur',
  'exportRevenueEur',
  'solarCompensationEur',
  'netEur',
  'premiumEligibleExportKwh',
  'premiumValuedExportKwh',
  'marketPremiumCtTotal'
];

function roundCtKwh(value) {
  return round2(value);
}

function effectiveBatteryCostCtKwh(costs = {}) {
  const pvCtKwh = Number(costs?.pvCtKwh);
  const base = Number(costs?.batteryBaseCtKwh);
  if (!Number.isFinite(base) && !Number.isFinite(pvCtKwh)) return null;
  const markup = Number(costs?.batteryLossMarkupPct || 0);
  const combinedBase =
    (Number.isFinite(pvCtKwh) ? pvCtKwh : 0)
    + (Number.isFinite(base) ? base : 0);
  return roundCtKwh(combinedBase * (1 + markup / 100));
}

function proportionalSourceShares(slot) {
  const loadKwh = Math.max(Number(slot.loadKwh || 0), 0);
  const gridKwh = Math.max(Number(slot.importKwh || 0), 0);
  const pvKwh = Math.max(Number(slot.pvKwh || 0), 0);
  const batteryKwh = Math.max(Number(slot.batteryDischargeKwh ?? slot.batteryKwh ?? 0), 0);
  const totalSupplyKwh = gridKwh + pvKwh + batteryKwh;
  const servedLoadKwh = totalSupplyKwh > 0 ? Math.min(loadKwh, totalSupplyKwh) : 0;
  if (servedLoadKwh <= 0 || totalSupplyKwh <= 0) {
    return {
      gridShareKwh: 0,
      pvShareKwh: 0,
      batteryShareKwh: 0
    };
  }
  return {
    gridShareKwh: servedLoadKwh * (gridKwh / totalSupplyKwh),
    pvShareKwh: servedLoadKwh * (pvKwh / totalSupplyKwh),
    batteryShareKwh: servedLoadKwh * (batteryKwh / totalSupplyKwh)
  };
}

function costForShareEur(kwh, ctKwh) {
  const shareKwh = Number(kwh || 0);
  if (shareKwh <= 0) return 0;
  const priceCtKwh = Number(ctKwh);
  if (!Number.isFinite(priceCtKwh)) return null;
  return round2((shareKwh * priceCtKwh) / 100);
}

function roundOrZero(value) {
  return round2(Number(value || 0));
}

function bucketTimestamp(value, bucketSeconds = SLOT_BUCKET_SECONDS) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return String(value || '');
  const bucketMs = bucketSeconds * 1000;
  return new Date(Math.floor(ms / bucketMs) * bucketMs).toISOString();
}

function isDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDateOnly(value) {
  if (!isDateOnly(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

function dateOnlyToUtcMs(value) {
  const parts = parseDateOnly(value);
  if (!parts) return Number.NaN;
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function addDays(value, days) {
  const utcMs = dateOnlyToUtcMs(value);
  if (!Number.isFinite(utcMs)) return null;
  return new Date(utcMs + days * 86400000).toISOString().slice(0, 10);
}

function startOfMonth(value) {
  const parts = parseDateOnly(value);
  return parts ? `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-01` : null;
}

function startOfYear(value) {
  const parts = parseDateOnly(value);
  return parts ? `${String(parts.year).padStart(4, '0')}-01-01` : null;
}

function startOfWeek(value) {
  const utcMs = dateOnlyToUtcMs(value);
  if (!Number.isFinite(utcMs)) return null;
  const day = new Date(utcMs).getUTCDay() || 7;
  return addDays(value, 1 - day);
}

function getLocalParts(date, timeZone = BERLIN_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
    day: Number(parts.find((part) => part.type === 'day')?.value),
    hour: Number(parts.find((part) => part.type === 'hour')?.value),
    minute: Number(parts.find((part) => part.type === 'minute')?.value)
  };
}

function localDateString(value, timeZone = BERLIN_TIME_ZONE) {
  const parts = getLocalParts(new Date(value), timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function localMonthString(value, timeZone = BERLIN_TIME_ZONE) {
  const parts = getLocalParts(new Date(value), timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}`;
}

function localYearString(value, timeZone = BERLIN_TIME_ZONE) {
  const parts = getLocalParts(new Date(value), timeZone);
  return String(parts.year).padStart(4, '0');
}

function localTimeLabel(value, timeZone = BERLIN_TIME_ZONE) {
  const parts = getLocalParts(new Date(value), timeZone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function localDateTimeToUtcIso(dateString, hour = 0, minute = 0, timeZone = BERLIN_TIME_ZONE) {
  const parts = parseDateOnly(dateString);
  if (!parts) return null;
  let guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute));
  for (let index = 0; index < 5; index += 1) {
    const local = getLocalParts(guess, timeZone);
    const desired = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute);
    const current = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    const diffMinutes = Math.round((desired - current) / 60000);
    if (diffMinutes === 0) return guess.toISOString();
    guess = new Date(guess.getTime() + diffMinutes * 60000);
  }
  return guess.toISOString();
}

function normalizeViewRange(view, date) {
  if (!SUPPORTED_VIEWS.has(view)) throw new Error('unsupported view');
  if (!isDateOnly(date)) throw new Error('date must use YYYY-MM-DD');

  if (view === 'day') {
    return { startDate: date, endDateExclusive: addDays(date, 1) };
  }
  if (view === 'week') {
    const startDate = startOfWeek(date);
    return { startDate, endDateExclusive: addDays(startDate, 7) };
  }
  if (view === 'month') {
    const startDate = startOfMonth(date);
    const parts = parseDateOnly(startDate);
    const nextMonth = parts.month === 12
      ? `${parts.year + 1}-01-01`
      : `${String(parts.year).padStart(4, '0')}-${String(parts.month + 1).padStart(2, '0')}-01`;
    return { startDate, endDateExclusive: nextMonth };
  }
  if (view === 'all') {
    // "Alle" — the whole history. Buckets are per calendar year (years are to
    // 'all' what months are to 'year'). The window floors at a fixed early
    // bound (no DVhub appliance data predates 2015) and ends at the start of
    // next year, so it always covers the full history regardless of the
    // anchor date. summarizeRows groups by year, so only years that actually
    // carry data produce a row — empty floor years never appear.
    const nowYear = parseDateOnly(currentBerlinDate())?.year
      ?? parseDateOnly(date)?.year;
    return { startDate: '2015-01-01', endDateExclusive: `${nowYear + 1}-01-01` };
  }
  const startDate = startOfYear(date);
  const parts = parseDateOnly(startDate);
  return { startDate, endDateExclusive: `${parts.year + 1}-01-01` };
}

function buildRowAccumulator(key, label) {
  return {
    key,
    label,
    importKwh: 0,
    exportKwh: 0,
    loadKwh: 0,
    pvKwh: 0,
    pvAcKwh: 0,
    solarDirectUseKwh: 0,
    solarToBatteryKwh: 0,
    solarToGridKwh: 0,
    gridDirectUseKwh: 0,
    gridToBatteryKwh: 0,
    batteryDirectUseKwh: 0,
    batteryToGridKwh: 0,
    batteryChargeKwh: 0,
    batteryDischargeKwh: 0,
    selfConsumptionKwh: 0,
    gridShareKwh: 0,
    pvShareKwh: 0,
    batteryShareKwh: 0,
    importCostEur: 0,
    gridCostEur: 0,
    pvCostEur: 0,
    batteryCostEur: 0,
    avoidedImportGrossEur: 0,
    avoidedImportPvGrossEur: 0,
    avoidedImportBatteryGrossEur: 0,
    opportunityCostEur: 0,
    opportunityCostPvEur: 0,
    opportunityCostBatteryEur: 0,
    selfConsumptionCostEur: 0,
    exportRevenueEur: 0,
    solarCompensationEur: 0,
    premiumEligibleExportKwh: 0,
    premiumValuedExportKwh: 0,
    marketPremiumCtTotal: 0,
    marketPremiumEur: null,
    marketPremiumCtKwh: null,
    grossReturnEur: null,
    solarMarketValueCtKwh: null,
    marketPriceWeightedCtKwh: null,
    userImportPriceWeightedCtKwh: null,
    marketPriceWeightKwh: 0,
    userImportPriceWeightKwh: 0,
    marketPriceWeightedCtTotal: 0,
    userImportPriceWeightedCtTotal: 0,
    netEur: 0,
    slotCount: 0,
    incompleteSlots: 0,
    estimatedSlots: 0,
    sourceKind: null,
    sourceKinds: []
  };
}

function finalizeAggregateSums(target, fields = AGGREGATE_SUM_FIELDS) {
  for (const field of fields) {
    if (field in target) target[field] = round2(Number(target[field] || 0));
  }
  if ('marketPriceWeightKwh' in target) target.marketPriceWeightKwh = round2(Number(target.marketPriceWeightKwh || 0));
  if ('userImportPriceWeightKwh' in target) target.userImportPriceWeightKwh = round2(Number(target.userImportPriceWeightKwh || 0));
  if ('marketPriceWeightedCtTotal' in target) target.marketPriceWeightedCtTotal = round2(Number(target.marketPriceWeightedCtTotal || 0));
  if ('userImportPriceWeightedCtTotal' in target) target.userImportPriceWeightedCtTotal = round2(Number(target.userImportPriceWeightedCtTotal || 0));
  if ('marketPriceWeightedCtKwh' in target) {
    target.marketPriceWeightedCtKwh = Number(target.marketPriceWeightKwh || 0) > 0
      ? round2(Number(target.marketPriceWeightedCtTotal || 0) / Number(target.marketPriceWeightKwh || 1))
      : null;
  }
  if ('userImportPriceWeightedCtKwh' in target) {
    target.userImportPriceWeightedCtKwh = Number(target.userImportPriceWeightKwh || 0) > 0
      ? round2(Number(target.userImportPriceWeightedCtTotal || 0) / Number(target.userImportPriceWeightKwh || 1))
      : null;
  }
  if ('netEur' in target) {
    target.netEur = round2(Number(target.exportRevenueEur || 0) - Number(target.selfConsumptionCostEur || 0));
  }
  if ('marketPremiumEur' in target || 'marketPremiumCtTotal' in target || 'premiumValuedExportKwh' in target) {
    const premiumValuedExportKwh = Number(target.premiumValuedExportKwh || 0);
    const marketPremiumCtTotal = Number(target.marketPremiumCtTotal || 0);
    target.marketPremiumEur = premiumValuedExportKwh > 0 ? round2(marketPremiumCtTotal / 100) : null;
    target.marketPremiumCtKwh = premiumValuedExportKwh > 0 ? round2(marketPremiumCtTotal / premiumValuedExportKwh) : null;
  }
  if ('grossReturnEur' in target) {
    target.grossReturnEur = round2(Number(target.netEur || 0) + Number(target.avoidedImportGrossEur || 0));
  }
  return target;
}

function summarizeRows(slots, view) {
  const groups = new Map();
  for (const slot of slots) {
    let key = slot.ts;
    let label = localTimeLabel(slot.ts);
    if (view === 'week' || view === 'month') {
      key = localDateString(slot.ts);
      label = key;
    }
    if (view === 'year') {
      key = localMonthString(slot.ts);
      label = key;
    }
    if (view === 'all') {
      key = localYearString(slot.ts);
      label = key;
    }
    const row = groups.get(key) || buildRowAccumulator(key, label);
    for (const field of AGGREGATE_SUM_FIELDS) {
      if (field === 'solarCompensationEur' || field === 'netEur') continue;
      row[field] += Number(slot[field] || 0);
    }
    const marketWeight = Number(slot.pvShareKwh || 0) + Number(slot.batteryShareKwh || 0) + Number(slot.exportKwh || 0);
    if (Number.isFinite(Number(slot.marketPriceCtKwh)) && marketWeight > 0) {
      row.marketPriceWeightKwh += marketWeight;
      row.marketPriceWeightedCtTotal += marketWeight * Number(slot.marketPriceCtKwh);
    }
    const importWeight = Number(slot.importKwh || 0);
    if (Number.isFinite(Number(slot.userImportPriceCtKwh)) && importWeight > 0) {
      row.userImportPriceWeightKwh += importWeight;
      row.userImportPriceWeightedCtTotal += importWeight * Number(slot.userImportPriceCtKwh);
    }
    row.slotCount += 1;
    if (slot.incomplete) row.incompleteSlots += 1;
    if (slot.estimated) row.estimatedSlots += 1;
    const sourceKinds = new Set(Array.isArray(row.sourceKinds) ? row.sourceKinds : []);
    if (slot.sourceKind === 'local_live') sourceKinds.add('local_live');
    if (slot.sourceKind === 'vrm_import') sourceKinds.add('vrm_import');
    for (const kind of (Array.isArray(slot.sourceKinds) ? slot.sourceKinds : [])) {
      if (kind) sourceKinds.add(kind);
    }
    row.sourceKinds = [...sourceKinds].sort();
    row.sourceKind = row.sourceKinds.length === 1
      ? row.sourceKinds[0]
      : (row.sourceKinds.length > 1 ? 'mixed' : null);
    groups.set(key, row);
  }
  return [...groups.values()].map((row) => finalizeAggregateSums(row));
}

function buildDayCharts(slots) {
  return {
    dayEnergyLines: slots.map((slot) => ({
      ts: slot.ts,
      label: localTimeLabel(slot.ts),
      pvKwh: round2(slot.pvKwh || 0),
      pvAcKwh: round2(slot.pvAcKwh || 0),
      solarDirectUseKwh: round2(slot.solarDirectUseKwh || 0),
      solarToBatteryKwh: round2(slot.solarToBatteryKwh || 0),
      solarToGridKwh: round2(slot.solarToGridKwh || 0),
      gridDirectUseKwh: round2(slot.gridDirectUseKwh || 0),
      gridToBatteryKwh: round2(slot.gridToBatteryKwh || 0),
      batteryDirectUseKwh: round2(slot.batteryDirectUseKwh || 0),
      batteryToGridKwh: round2(slot.batteryToGridKwh || 0),
      importKwh: slot.importKwh,
      selfConsumptionKwh: round2(slot.selfConsumptionKwh || 0),
      batteryKwh: round2(Math.max(Number(slot.batteryDischargeKwh ?? slot.batteryKwh ?? 0), 0)),
      batteryChargeKwh: round2(Math.max(Number(slot.batteryChargeKwh || 0), 0)),
      batteryDischargeKwh: round2(Math.max(Number(slot.batteryDischargeKwh || 0), 0)),
      exportKwh: slot.exportKwh,
      loadKwh: round2(slot.loadKwh || 0),
      estimated: Boolean(slot.estimated),
      incomplete: Boolean(slot.incomplete)
    })),
    dayPriceLines: slots.map((slot) => ({
      ts: slot.ts,
      label: localTimeLabel(slot.ts),
      marketPriceCtKwh: slot.marketPriceCtKwh,
      userImportPriceCtKwh: slot.userImportPriceCtKwh,
      estimated: Boolean(slot.estimated),
      incomplete: Boolean(slot.incomplete)
    })),
    dayFinancialLines: slots.map((slot) => ({
      ts: slot.ts,
      label: localTimeLabel(slot.ts),
      gridCostEur: slot.gridCostEur,
      pvCostEur: slot.pvCostEur,
      batteryCostEur: slot.batteryCostEur,
      avoidedImportGrossEur: slot.avoidedImportGrossEur,
      avoidedImportPvGrossEur: slot.avoidedImportPvGrossEur,
      avoidedImportBatteryGrossEur: slot.avoidedImportBatteryGrossEur,
      opportunityCostEur: slot.opportunityCostEur,
      opportunityCostPvEur: slot.opportunityCostPvEur,
      opportunityCostBatteryEur: slot.opportunityCostBatteryEur,
      selfConsumptionCostEur: slot.selfConsumptionCostEur,
      exportRevenueEur: slot.exportRevenueEur,
      netEur: slot.netEur,
      estimated: Boolean(slot.estimated),
      incomplete: Boolean(slot.incomplete)
    }))
  };
}

function buildPeriodCharts(rows) {
  return {
    periodFinancialBars: rows.map((row) => ({
      label: row.label,
      exportKwh: row.exportKwh,
      exportRevenueEur: row.exportRevenueEur,
      gridCostEur: row.gridCostEur,
      pvCostEur: row.pvCostEur,
      batteryCostEur: row.batteryCostEur,
      avoidedImportGrossEur: row.avoidedImportGrossEur,
      avoidedImportPvGrossEur: row.avoidedImportPvGrossEur,
      avoidedImportBatteryGrossEur: row.avoidedImportBatteryGrossEur,
      opportunityCostEur: row.opportunityCostEur,
      opportunityCostPvEur: row.opportunityCostPvEur,
      opportunityCostBatteryEur: row.opportunityCostBatteryEur,
      selfConsumptionCostEur: row.selfConsumptionCostEur,
      netEur: row.netEur,
      grossReturnEur: row.grossReturnEur,
      premiumEligibleExportKwh: row.premiumEligibleExportKwh,
      premiumValuedExportKwh: row.premiumValuedExportKwh,
      marketPremiumEur: row.marketPremiumEur,
      marketPremiumCtKwh: row.marketPremiumCtKwh,
      estimatedSlots: row.estimatedSlots,
      incompleteSlots: row.incompleteSlots
    })),
    periodCombinedBars: rows.map((row) => ({
      label: row.label,
      importKwh: row.importKwh,
      exportKwh: row.exportKwh,
      loadKwh: row.loadKwh,
      pvKwh: row.pvKwh,
      pvAcKwh: row.pvAcKwh,
      solarDirectUseKwh: row.solarDirectUseKwh,
      solarToBatteryKwh: row.solarToBatteryKwh,
      solarToGridKwh: row.solarToGridKwh,
      gridDirectUseKwh: row.gridDirectUseKwh,
      gridToBatteryKwh: row.gridToBatteryKwh,
      batteryDirectUseKwh: row.batteryDirectUseKwh,
      batteryToGridKwh: row.batteryToGridKwh,
      batteryChargeKwh: row.batteryChargeKwh,
      batteryDischargeKwh: row.batteryDischargeKwh,
      cycles: row.cycles,
      selfConsumptionKwh: row.selfConsumptionKwh,
      gridShareKwh: row.gridShareKwh,
      pvShareKwh: row.pvShareKwh,
      batteryShareKwh: row.batteryShareKwh,
      exportRevenueEur: row.exportRevenueEur,
      gridCostEur: row.gridCostEur,
      pvCostEur: row.pvCostEur,
      batteryCostEur: row.batteryCostEur,
      avoidedImportGrossEur: row.avoidedImportGrossEur,
      avoidedImportPvGrossEur: row.avoidedImportPvGrossEur,
      avoidedImportBatteryGrossEur: row.avoidedImportBatteryGrossEur,
      opportunityCostEur: row.opportunityCostEur,
      opportunityCostPvEur: row.opportunityCostPvEur,
      opportunityCostBatteryEur: row.opportunityCostBatteryEur,
      selfConsumptionCostEur: row.selfConsumptionCostEur,
      netEur: row.netEur,
      grossReturnEur: row.grossReturnEur,
      premiumEligibleExportKwh: row.premiumEligibleExportKwh,
      premiumValuedExportKwh: row.premiumValuedExportKwh,
      marketPremiumEur: row.marketPremiumEur,
      marketPremiumCtKwh: row.marketPremiumCtKwh,
      estimatedSlots: row.estimatedSlots,
      incompleteSlots: row.incompleteSlots
    })),
    periodEnergyBars: rows.map((row) => ({
      label: row.label,
      importKwh: row.importKwh,
      exportKwh: row.exportKwh,
      loadKwh: row.loadKwh,
      pvKwh: row.pvKwh,
      pvAcKwh: row.pvAcKwh,
      batteryChargeKwh: row.batteryChargeKwh,
      batteryDischargeKwh: row.batteryDischargeKwh,
      selfConsumptionKwh: row.selfConsumptionKwh,
      gridShareKwh: row.gridShareKwh,
      pvShareKwh: row.pvShareKwh,
      batteryShareKwh: row.batteryShareKwh,
      estimatedSlots: row.estimatedSlots,
      incompleteSlots: row.incompleteSlots
    }))
  };
}

function currentBerlinDate() {
  return localDateString(new Date());
}

function summarizeSolarMarketValue({ year, rows, solarMarketValues }) {
  const annualCtKwhByYear = solarMarketValues?.annualCtKwhByYear || {};
  const monthlyCtKwhByMonth = solarMarketValues?.monthlyCtKwhByMonth || {};
  const officialAnnual = Number(annualCtKwhByYear?.[year]);
  const availableMonths = rows.filter((row) => Number.isFinite(Number(monthlyCtKwhByMonth[row.label]))).length;

  if (Number.isFinite(officialAnnual)) {
    return {
      year,
      annualCtKwh: round2(officialAnnual),
      source: 'official_annual',
      availableMonths
    };
  }

  const weighted = rows.reduce((acc, row) => {
    const ctKwh = Number(monthlyCtKwhByMonth[row.label]);
    const exportKwh = Number(row.exportKwh || 0);
    if (!Number.isFinite(ctKwh) || exportKwh <= 0) return acc;
    acc.weightedCt += ctKwh * exportKwh;
    acc.exportKwh += exportKwh;
    return acc;
  }, { weightedCt: 0, exportKwh: 0 });

  if (weighted.exportKwh <= 0) return null;
  return {
    year,
    annualCtKwh: round2(weighted.weightedCt / weighted.exportKwh),
    source: 'derived_monthly_weighted',
    availableMonths
  };
}

function applySolarMarketValues({ rows, view, date, kpis, meta, solarMarketValues }) {
  if (view !== 'year') return { rows, kpis, meta };
  const parts = parseDateOnly(startOfYear(date));
  const year = parts?.year;
  if (!year) return { rows, kpis, meta };
  const monthlyCtKwhByMonth = solarMarketValues?.monthlyCtKwhByMonth || {};

  const nextRows = rows.map((row) => {
    const solarMarketValueCtKwh = Number(monthlyCtKwhByMonth[row.label]);
    const solarCompensationEur = Number.isFinite(solarMarketValueCtKwh) && Number(row.exportKwh || 0) > 0
      ? round2((Number(row.exportKwh || 0) * solarMarketValueCtKwh) / 100)
      : 0;
    return {
      ...row,
      solarMarketValueCtKwh: Number.isFinite(solarMarketValueCtKwh) ? solarMarketValueCtKwh : null,
      solarCompensationEur
    };
  });

  const solarMarketValue = summarizeSolarMarketValue({
    year,
    rows: nextRows,
    solarMarketValues
  });
  const nextKpis = {
    ...kpis,
    solarCompensationEur: solarMarketValue?.source === 'official_annual'
      ? round2((Number(kpis.exportKwh || 0) * Number(solarMarketValue.annualCtKwh || 0)) / 100)
      : round2(nextRows.reduce((sum, row) => sum + Number(row.solarCompensationEur || 0), 0))
  };
  const nextMeta = {
    ...meta,
    solarMarketValue
  };
  return {
    rows: nextRows,
    kpis: nextKpis,
    meta: nextMeta
  };
}

function summarizeWeightedApplicableValue({ pvPlants, applicableValueSummary, applicableValueOverrideCtKwh = null }) {
  const plants = Array.isArray(pvPlants) ? pvPlants : [];
  const overrideValue = Number(applicableValueOverrideCtKwh);
  if (Number.isFinite(overrideValue) && overrideValue > 0) {
    return {
      weightedApplicableValueCtKwh: round2(overrideValue),
      configuredPlantCount: plants.length,
      resolvedPlantCount: plants.length
    };
  }
  const applicableValueCtKwhByMonth = applicableValueSummary?.applicableValueCtKwhByMonth || {};
  const applicableValueLookup = typeof applicableValueSummary?.getApplicableValueCtKwh === 'function'
    ? applicableValueSummary.getApplicableValueCtKwh
    : ({ commissionedAt }) => applicableValueCtKwhByMonth[String(commissionedAt || '').slice(0, 7)];
  if (!plants.length) {
    return {
      weightedApplicableValueCtKwh: null,
      configuredPlantCount: 0,
      resolvedPlantCount: 0
    };
  }

  let totalKwp = 0;
  let weightedApplicableValueCt = 0;
  let resolvedPlantCount = 0;

  for (const plant of plants) {
    const kwp = Number(plant?.kwp);
    const commissionedAt = typeof plant?.commissionedAt === 'string' ? plant.commissionedAt : '';
    const applicableValueCtKwh = Number(applicableValueLookup({
      commissionedAt,
      kwp
    }));
    if (!Number.isFinite(kwp) || kwp <= 0) continue;
    if (!Number.isFinite(applicableValueCtKwh)) {
      return {
        weightedApplicableValueCtKwh: null,
        configuredPlantCount: plants.length,
        resolvedPlantCount
      };
    }
    totalKwp += kwp;
    weightedApplicableValueCt += kwp * applicableValueCtKwh;
    resolvedPlantCount += 1;
  }

  if (totalKwp <= 0) {
    return {
      weightedApplicableValueCtKwh: null,
      configuredPlantCount: plants.length,
      resolvedPlantCount
    };
  }

  return {
    weightedApplicableValueCtKwh: round2(weightedApplicableValueCt / totalKwp),
    configuredPlantCount: plants.length,
    resolvedPlantCount
  };
}

function summarizeConfiguredPvCapacity(pvPlants) {
  const plants = Array.isArray(pvPlants) ? pvPlants : [];
  const configuredPvCapacityKwp = round2(plants.reduce((sum, plant) => {
    const kwp = Number(plant?.kwp);
    if (!Number.isFinite(kwp) || kwp <= 0) return sum;
    return sum + kwp;
  }, 0));
  return configuredPvCapacityKwp > 0 ? configuredPvCapacityKwp : null;
}

function resolveMarketValueMode(pricingConfig) {
  return pricingConfig?.marketValueMode === 'monthly' ? 'monthly' : 'annual';
}

function applyPvFullLoadHours({ kpis, pricingConfig }) {
  const configuredPvCapacityKwp = summarizeConfiguredPvCapacity(pricingConfig?.pvPlants);
  const pvFullLoadHours =
    Number.isFinite(configuredPvCapacityKwp)
    && configuredPvCapacityKwp > 0
    && Number(kpis?.pvKwh || 0) > 0
      ? round2(Number(kpis.pvKwh || 0) / configuredPvCapacityKwp)
      : null;
  return {
    ...kpis,
    configuredPvCapacityKwp,
    pvFullLoadHours
  };
}

// Erwartete PV-Erzeugung fuer den View-Zeitraum berechnen.
// Soll-Wert = pvPotentialKwhAnnual × Σ Monats-Anteil im Zeitraum.
// Liefert null wenn weder ein Annual-Potential noch eine kWp-basierte Schaetzung
// moeglich ist (kein pvPlants).
//
// view='all' bekommt KEINE Schaetzung — wir wissen nicht ob das Anlagenleistungs-
// Profil ueber die Jahre konstant war (Erweiterungen, Stilllegungen). Lieber
// "nicht verfuegbar" als irreführend.
function computeExpectedPvKwh({ view, range, pricingConfig }) {
  if (view === 'all') return null;

  // WS3: prefer the PVGIS-derived monthly expected production (real array
  // geometry — tilt/azimuth per plane, incl. the north-string penalty). Falls
  // back to the legacy pvPotentialKwhAnnual × static-distribution model when the
  // PVGIS cache is absent/stale (no geometry, or PVGIS unreachable at refresh).
  // The PVGIS service keeps this cache consistent with the user's configured
  // string geometry (forecast.pv.strings) on boot + every config save, so we
  // just read it. Present ⇒ this user's array was resolved; absent ⇒ no
  // geometry configured / PVGIS unreachable ⇒ legacy estimate.
  let pvgisMonthly = readCachedPvgisMonthly({ cachePath: PVGIS_EXPECTED_CACHE_PATH });
  // PVGIS PVcalc is computed without site horizon shading, so for a site with
  // hills/trees it overshoots the real yield. Use PVGIS for the geometry-
  // accurate monthly SHAPE (relative orientation/north-penalty distribution)
  // but calibrate the MAGNITUDE to the operator's known annual yield
  // (pvPotentialKwhAnnual) when set — best of both. Without that figure, use
  // PVGIS absolute.
  if (pvgisMonthly) {
    const annualSet = Number(pricingConfig?.pvPotentialKwhAnnual);
    const pvgisAnnual = pvgisMonthly.reduce((a, b) => a + (Number(b) || 0), 0);
    if (Number.isFinite(annualSet) && annualSet > 0 && pvgisAnnual > 0) {
      const f = annualSet / pvgisAnnual;
      pvgisMonthly = pvgisMonthly.map((v) => (Number(v) || 0) * f);
    }
  }

  const annualPotential = (() => {
    const raw = Number(pricingConfig?.pvPotentialKwhAnnual);
    if (Number.isFinite(raw) && raw > 0) return raw;
    // Fallback: kWp × 900 (Deutschland-Schnitt fuer ohne-spezifische-Daten)
    const kwp = summarizeConfiguredPvCapacity(pricingConfig?.pvPlants);
    return Number.isFinite(kwp) && kwp > 0 ? kwp * 900 : null;
  })();
  if (annualPotential == null && !pvgisMonthly) return null;

  const distArr = Array.isArray(pricingConfig?.pvMonthlyDistributionPct)
    && pricingConfig.pvMonthlyDistributionPct.length === 12
    ? pricingConfig.pvMonthlyDistributionPct.map((v) => Number(v) || 0)
    : [2.5, 4.5, 7.5, 11.0, 14.0, 14.5, 14.0, 12.0, 9.5, 6.0, 3.0, 1.5];
  const distSum = distArr.reduce((a, b) => a + b, 0) || 100;

  const start = range?.startDate ? parseDateOnly(range.startDate) : null;
  const endExcl = range?.endDateExclusive ? parseDateOnly(range.endDateExclusive) : null;
  if (!start || !endExcl) return null;

  // Tagesaufgeloeste Iteration: pro Tag = Monatsanteil / Tage-in-Monat.
  // So funktioniert auch eine Wochenansicht die ueber zwei Monate laeuft sauber.
  let expectedKwh = 0;
  let cursor = range.startDate;
  while (cursor < range.endDateExclusive) {
    const p = parseDateOnly(cursor);
    if (!p) break;
    const daysInMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
    const monthIdx = p.month - 1; // 0..11
    if (pvgisMonthly) {
      // PVGIS kWh for this calendar month, spread evenly across its days.
      expectedKwh += (Number(pvgisMonthly[monthIdx]) || 0) / daysInMonth;
      cursor = addDays(cursor, 1);
      continue;
    }
    const monthShare = (distArr[monthIdx] || 0) / distSum;
    expectedKwh += (annualPotential * monthShare) / daysInMonth;
    cursor = addDays(cursor, 1);
  }
  return round2(expectedKwh);
}

async function applyCurtailmentEstimate({ view, range, kpis, pricingConfig, curtailmentService = null }) {
  // expectedPvKwh stays the PVGIS whole-range expectation: it drives the card's
  // visibility + the curtailed/expected ratio accent. null (e.g. view='all')
  // hides the card and skips the (potentially expensive) calibrated query.
  const expectedPvKwh = computeExpectedPvKwh({ view, range, pricingConfig });
  if (expectedPvKwh == null) {
    return { ...kpis, expectedPvKwh: null, curtailedPvKwh: null };
  }
  const actualPvKwh = Number(kpis?.pvKwh || 0);
  // PVGIS fallback (weather-blind): the gap below the monthly-average Soll.
  const pvgisCurtailedPvKwh = round2(Math.max(0, expectedPvKwh - actualPvKwh));

  // T-CURTAIL Increment 3: prefer the irradiance-calibrated curtailment — a
  // per-slot, negative-price-gated estimate from measured GHI (no longer
  // conflating cloudy/missing-data days with curtailment). Falls back to PVGIS
  // when the service is absent, errors, or the window has neg-price slots that
  // could not be computed at all (no GHI / no calibration yet).
  if (curtailmentService?.computeForRange && range?.startDate && range?.endDateExclusive) {
    try {
      const from = localDateTimeToUtcIso(range.startDate, 0, 0);
      const to = localDateTimeToUtcIso(range.endDateExclusive, 0, 0);
      const r = await curtailmentService.computeForRange({ from, to });
      // negSlots===0 -> legitimately zero curtailment (not a fallback case);
      // computed/fallback>0 -> we produced a real estimate.
      if (r && r.ok && (r.negSlots === 0 || r.computedSlots > 0 || r.fallbackSlots > 0)) {
        return { ...kpis, expectedPvKwh, curtailedPvKwh: round2(r.curtailedKwh), curtailmentSource: 'calibrated' };
      }
    } catch {
      // fall through to PVGIS
    }
  }
  return { ...kpis, expectedPvKwh, curtailedPvKwh: pvgisCurtailedPvKwh, curtailmentSource: 'pvgis' };
}

function applyAnnualMarketPremium({ view, slots, kpis, meta, pricingConfig, applicableValueSummary }) {
  if (view !== 'year') {
    return { kpis, meta };
  }

  const weightedApplicableValue = summarizeWeightedApplicableValue({
    pvPlants: pricingConfig?.pvPlants,
    applicableValueSummary,
    applicableValueOverrideCtKwh: pricingConfig?.applicableValueOverrideCtKwh
  });
  const selectedYear = parseDateOnly(startOfYear(meta?.selectedDate || ''))?.year;
  const currentYear = parseDateOnly(startOfYear(getCurrentDateValue(meta?.currentDate || '')))?.year;
  const officialAnnualMarketValueCtKwh = meta?.solarMarketValue?.source === 'official_annual'
    ? round2(Number(meta.solarMarketValue.annualCtKwh || 0))
    : null;
  const derivedRunningAnnualMarketValueCtKwh =
    meta?.solarMarketValue?.source === 'derived_monthly_weighted'
    && selectedYear != null
    && currentYear != null
    && selectedYear === currentYear
      ? round2(Number(meta.solarMarketValue.annualCtKwh || 0))
      : null;
  const annualMarketValueCtKwh = Number.isFinite(officialAnnualMarketValueCtKwh)
    ? officialAnnualMarketValueCtKwh
    : derivedRunningAnnualMarketValueCtKwh;
  const weightedApplicableValueCtKwh = weightedApplicableValue.weightedApplicableValueCtKwh;
  const monthlyCtKwhByMonth = meta?.solarMarketValueMonthlyCtKwhByMonth || {};
  const marketValueMode = resolveMarketValueMode(pricingConfig);
  const baselinePremiumEligibleExportKwh = round2(slots.reduce((sum, slot) => {
    const marketPriceCtKwh = Number(slot?.marketPriceCtKwh);
    if (!Number.isFinite(marketPriceCtKwh) || marketPriceCtKwh < 0) return sum;
    return sum + Number(slot?.exportKwh || 0);
  }, 0));

  let premiumEligibleExportKwh = baselinePremiumEligibleExportKwh;
  let premiumValuedExportKwh = 0;
  let marketPremiumEur = null;
  let marketPremiumCtKwh = null;
  let source = Number.isFinite(officialAnnualMarketValueCtKwh) ? 'official_annual' : null;

  if (marketValueMode === 'monthly' && Number.isFinite(weightedApplicableValueCtKwh)) {
    const configuredMonthly = slots.reduce((acc, slot) => {
      const marketPriceCtKwh = Number(slot?.marketPriceCtKwh);
      const exportKwh = Number(slot?.exportKwh || 0);
      const monthKey = localMonthString(slot?.ts);
      const monthlyMarketValueCtKwh = Number(monthlyCtKwhByMonth?.[monthKey]);
      if (!Number.isFinite(marketPriceCtKwh) || marketPriceCtKwh < 0 || exportKwh <= 0) return acc;
      if (!Number.isFinite(monthlyMarketValueCtKwh)) return acc;
      acc.premiumValuedExportKwh += exportKwh;
      acc.marketPremiumCt += exportKwh * (weightedApplicableValueCtKwh - monthlyMarketValueCtKwh);
      acc.weightedMarketValueCt += exportKwh * monthlyMarketValueCtKwh;
      return acc;
    }, {
      premiumValuedExportKwh: 0,
      marketPremiumCt: 0,
      weightedMarketValueCt: 0
    });
    premiumValuedExportKwh = round2(configuredMonthly.premiumValuedExportKwh);
    const configuredAnnualMarketValueCtKwh = premiumValuedExportKwh > 0
      ? round2(configuredMonthly.weightedMarketValueCt / premiumValuedExportKwh)
      : null;
    marketPremiumEur = premiumValuedExportKwh > 0 ? round2(configuredMonthly.marketPremiumCt / 100) : null;
    marketPremiumCtKwh = premiumValuedExportKwh > 0
      ? round2(configuredMonthly.marketPremiumCt / premiumValuedExportKwh)
      : null;
    source = premiumValuedExportKwh > 0 ? 'configured_monthly' : null;
    return {
      kpis: {
        ...kpis,
        annualMarketValueCtKwh: configuredAnnualMarketValueCtKwh,
        weightedApplicableValueCtKwh: Number.isFinite(weightedApplicableValueCtKwh) ? weightedApplicableValueCtKwh : null,
        premiumEligibleExportKwh,
        premiumValuedExportKwh,
        marketPremiumEur,
        marketPremiumCtKwh,
        marketPremiumCtTotal: premiumValuedExportKwh > 0 ? round2(configuredMonthly.marketPremiumCt) : 0
      },
      meta: {
        ...meta,
        marketPremium: {
          source,
          annualMarketValueCtKwh: configuredAnnualMarketValueCtKwh,
          weightedApplicableValueCtKwh: Number.isFinite(weightedApplicableValueCtKwh) ? weightedApplicableValueCtKwh : null,
          premiumEligibleExportKwh,
          premiumValuedExportKwh,
          marketPremiumEur,
          marketPremiumCtKwh,
          availableMarketValueMonths: Number(meta?.solarMarketValue?.availableMonths || 0),
          configuredPlantCount: weightedApplicableValue.configuredPlantCount,
          resolvedPlantCount: weightedApplicableValue.resolvedPlantCount
        }
      }
    };
  }

  if (Number.isFinite(officialAnnualMarketValueCtKwh) && Number.isFinite(weightedApplicableValueCtKwh)) {
    premiumValuedExportKwh = premiumEligibleExportKwh;
    marketPremiumEur = premiumEligibleExportKwh > 0
      ? round2((premiumEligibleExportKwh * (weightedApplicableValueCtKwh - officialAnnualMarketValueCtKwh)) / 100)
      : null;
    marketPremiumCtKwh = premiumEligibleExportKwh > 0
      ? round2(weightedApplicableValueCtKwh - officialAnnualMarketValueCtKwh)
      : null;
  } else if (Number.isFinite(derivedRunningAnnualMarketValueCtKwh) && Number.isFinite(weightedApplicableValueCtKwh)) {
    premiumValuedExportKwh = premiumEligibleExportKwh;
    marketPremiumCtKwh = premiumEligibleExportKwh > 0
      ? round2(weightedApplicableValueCtKwh - derivedRunningAnnualMarketValueCtKwh)
      : null;
    marketPremiumEur =
      premiumEligibleExportKwh > 0 && Number.isFinite(marketPremiumCtKwh)
        ? round2((premiumEligibleExportKwh * marketPremiumCtKwh) / 100)
        : null;
    source = premiumEligibleExportKwh > 0 ? 'derived_monthly_running' : null;
  }

  return {
    kpis: {
      ...kpis,
      annualMarketValueCtKwh: Number.isFinite(annualMarketValueCtKwh) ? annualMarketValueCtKwh : null,
      weightedApplicableValueCtKwh: Number.isFinite(weightedApplicableValueCtKwh) ? weightedApplicableValueCtKwh : null,
      premiumEligibleExportKwh,
      premiumValuedExportKwh,
      marketPremiumEur,
      marketPremiumCtKwh,
      marketPremiumCtTotal:
        premiumValuedExportKwh > 0 && Number.isFinite(marketPremiumCtKwh)
          ? round2(premiumValuedExportKwh * marketPremiumCtKwh)
          : 0
    },
    meta: {
      ...meta,
      marketPremium: {
        source,
        marketValueMode,
        annualMarketValueCtKwh: Number.isFinite(annualMarketValueCtKwh) ? annualMarketValueCtKwh : null,
        weightedApplicableValueCtKwh: Number.isFinite(weightedApplicableValueCtKwh) ? weightedApplicableValueCtKwh : null,
        premiumEligibleExportKwh,
        premiumValuedExportKwh,
        marketPremiumEur,
        marketPremiumCtKwh,
        availableMarketValueMonths: Number(meta?.solarMarketValue?.availableMonths || 0),
        configuredPlantCount: weightedApplicableValue.configuredPlantCount,
        resolvedPlantCount: weightedApplicableValue.resolvedPlantCount
      }
    }
  };
}

function applyPeriodPremiumDisplay({ view, date, slots, kpis, meta, pricingConfig, weightedApplicableValueCtKwh = null }) {
  if (view === 'day') {
    return { kpis, meta };
  }

  const annualCtKwhByYear = meta?.solarMarketValueAnnualCtKwhByYear || {};
  const monthlyCtKwhByMonth = meta?.solarMarketValueMonthlyCtKwhByMonth || {};
  const marketValueMode = resolveMarketValueMode(pricingConfig);
  // Ride marketValueMode along in meta.marketPremium so every branch below
  // (each spreads `...(meta?.marketPremium || {})`) carries it to the
  // frontend — computeMarketPremium only runs for the year view, so
  // week/month would otherwise lose it.
  meta = { ...meta, marketPremium: { ...(meta?.marketPremium || {}), marketValueMode } };
  const premiumEligibleExportKwh = round2(slots.reduce((sum, slot) => {
    const marketPriceCtKwh = Number(slot?.marketPriceCtKwh);
    if (!Number.isFinite(marketPriceCtKwh) || marketPriceCtKwh < 0) return sum;
    return sum + Number(slot?.exportKwh || 0);
  }, 0));

  if (view === 'year') {
    return {
      kpis: {
        ...kpis,
        weightedApplicableValueCtKwh: Number.isFinite(weightedApplicableValueCtKwh) ? round2(weightedApplicableValueCtKwh) : null,
        periodMarketValueCtKwh: Number.isFinite(Number(kpis?.annualMarketValueCtKwh))
          ? round2(Number(kpis.annualMarketValueCtKwh))
          : null
      },
      meta: {
        ...meta,
        marketPremium: {
          ...(meta?.marketPremium || {}),
          displaySource: meta?.marketPremium?.source || null
        }
      }
    };
  }

  if (!Number.isFinite(weightedApplicableValueCtKwh)) {
    return {
      kpis: {
        ...kpis,
        weightedApplicableValueCtKwh: null,
        premiumEligibleExportKwh,
        periodMarketValueCtKwh: null,
        marketPremiumEur: null,
        marketPremiumCtKwh: null
      },
      meta: {
        ...meta,
        marketPremium: {
          ...(meta?.marketPremium || {}),
          premiumEligibleExportKwh,
          displaySource: null
        }
      }
    };
  }

  const selectedYear = parseDateOnly(startOfYear(date))?.year;
  if (view === 'month') {
    const selectedMonth = startOfMonth(date)?.slice(0, 7);
    const monthlyMarketValueCtKwh = Number(monthlyCtKwhByMonth?.[selectedMonth]);
    if (marketValueMode === 'monthly') {
      const marketPremiumCtKwh = Number.isFinite(monthlyMarketValueCtKwh)
        ? round2(weightedApplicableValueCtKwh - monthlyMarketValueCtKwh)
        : null;
      const marketPremiumEur =
        premiumEligibleExportKwh > 0 && Number.isFinite(marketPremiumCtKwh)
          ? round2((premiumEligibleExportKwh * marketPremiumCtKwh) / 100)
          : null;
      return {
        kpis: {
          ...kpis,
          weightedApplicableValueCtKwh: round2(weightedApplicableValueCtKwh),
          premiumEligibleExportKwh,
          periodMarketValueCtKwh: Number.isFinite(monthlyMarketValueCtKwh) ? round2(monthlyMarketValueCtKwh) : null,
          marketPremiumEur,
          marketPremiumCtKwh
        },
        meta: {
          ...meta,
          marketPremium: {
            ...(meta?.marketPremium || {}),
            premiumEligibleExportKwh,
            displaySource: Number.isFinite(monthlyMarketValueCtKwh) ? 'official_monthly_configured' : null
          }
        }
      };
    }

    const officialAnnualMarketValueCtKwh = Number(annualCtKwhByYear?.[selectedYear]);
    if (Number.isFinite(officialAnnualMarketValueCtKwh)) {
      const marketPremiumCtKwh = round2(weightedApplicableValueCtKwh - officialAnnualMarketValueCtKwh);
      const marketPremiumEur = premiumEligibleExportKwh > 0
        ? round2((premiumEligibleExportKwh * marketPremiumCtKwh) / 100)
        : null;
      return {
        kpis: {
          ...kpis,
          weightedApplicableValueCtKwh: round2(weightedApplicableValueCtKwh),
          premiumEligibleExportKwh,
          periodMarketValueCtKwh: round2(officialAnnualMarketValueCtKwh),
          marketPremiumEur,
          marketPremiumCtKwh
        },
        meta: {
          ...meta,
          marketPremium: {
            ...(meta?.marketPremium || {}),
            premiumEligibleExportKwh,
            displaySource: 'official_annual'
          }
        }
      };
    }

    const marketPremiumCtKwh = Number.isFinite(monthlyMarketValueCtKwh)
      ? round2(weightedApplicableValueCtKwh - monthlyMarketValueCtKwh)
      : null;
    const marketPremiumEur =
      premiumEligibleExportKwh > 0 && Number.isFinite(marketPremiumCtKwh)
        ? round2((premiumEligibleExportKwh * marketPremiumCtKwh) / 100)
        : null;
    return {
      kpis: {
        ...kpis,
        weightedApplicableValueCtKwh: round2(weightedApplicableValueCtKwh),
        premiumEligibleExportKwh,
        periodMarketValueCtKwh: Number.isFinite(monthlyMarketValueCtKwh) ? round2(monthlyMarketValueCtKwh) : null,
        marketPremiumEur,
        marketPremiumCtKwh
      },
      meta: {
        ...meta,
        marketPremium: {
          ...(meta?.marketPremium || {}),
          premiumEligibleExportKwh,
          displaySource: Number.isFinite(monthlyMarketValueCtKwh) ? 'official_monthly' : null
        }
      }
    };
  }

  if (view === 'week') {
    const eligibleSlots = slots.filter((slot) => {
      const marketPriceCtKwh = Number(slot?.marketPriceCtKwh);
      return Number.isFinite(marketPriceCtKwh) && marketPriceCtKwh >= 0 && Number(slot?.exportKwh || 0) > 0;
    });
    const weightedMonthly = eligibleSlots.reduce((acc, slot) => {
      const monthlyMarketValueCtKwh = Number(monthlyCtKwhByMonth?.[localMonthString(slot?.ts)]);
      const exportKwh = Number(slot?.exportKwh || 0);
      if (!Number.isFinite(monthlyMarketValueCtKwh)) {
        acc.missingValue = true;
        return acc;
      }
      acc.exportKwh += exportKwh;
      acc.weightedCt += exportKwh * monthlyMarketValueCtKwh;
      return acc;
    }, {
      exportKwh: 0,
      weightedCt: 0,
      missingValue: false
    });
    const periodMarketValueCtKwh =
      !weightedMonthly.missingValue && weightedMonthly.exportKwh > 0
        ? round2(weightedMonthly.weightedCt / weightedMonthly.exportKwh)
        : null;
    const marketPremiumCtKwh = Number.isFinite(periodMarketValueCtKwh)
      ? round2(weightedApplicableValueCtKwh - periodMarketValueCtKwh)
      : null;
    const marketPremiumEur =
      premiumEligibleExportKwh > 0 && Number.isFinite(marketPremiumCtKwh)
        ? round2((premiumEligibleExportKwh * marketPremiumCtKwh) / 100)
        : null;
    return {
      kpis: {
        ...kpis,
        weightedApplicableValueCtKwh: round2(weightedApplicableValueCtKwh),
        premiumEligibleExportKwh,
        periodMarketValueCtKwh,
        marketPremiumEur,
        marketPremiumCtKwh
      },
      meta: {
        ...meta,
        marketPremium: {
          ...(meta?.marketPremium || {}),
          premiumEligibleExportKwh,
          displaySource: Number.isFinite(periodMarketValueCtKwh) ? 'weighted_monthly' : null
        }
      }
    };
  }

  return { kpis, meta };
}

function getCurrentDateValue(value) {
  if (isDateOnly(value)) return value;
  return currentBerlinDate();
}

function buildSummarySeries(view, slots) {
  if (view === 'year' || view === 'all') {
    return {
      financial: [],
      energy: [],
      prices: []
    };
  }
  return {
    financial: slots.map((slot) => ({
      ts: slot.ts,
      gridCostEur: slot.gridCostEur,
      pvCostEur: slot.pvCostEur,
      batteryCostEur: slot.batteryCostEur,
      avoidedImportGrossEur: slot.avoidedImportGrossEur,
      avoidedImportPvGrossEur: slot.avoidedImportPvGrossEur,
      avoidedImportBatteryGrossEur: slot.avoidedImportBatteryGrossEur,
      opportunityCostEur: slot.opportunityCostEur,
      opportunityCostPvEur: slot.opportunityCostPvEur,
      opportunityCostBatteryEur: slot.opportunityCostBatteryEur,
      selfConsumptionCostEur: slot.selfConsumptionCostEur,
      importCostEur: slot.importCostEur,
      exportRevenueEur: slot.exportRevenueEur,
      netEur: slot.netEur
    })),
    energy: slots.map((slot) => ({
      ts: slot.ts,
      importKwh: slot.importKwh,
      exportKwh: slot.exportKwh,
      loadKwh: slot.loadKwh,
      pvKwh: roundOrZero(slot.pvKwh),
      pvAcKwh: roundOrZero(slot.pvAcKwh),
      solarDirectUseKwh: roundOrZero(slot.solarDirectUseKwh),
      solarToBatteryKwh: roundOrZero(slot.solarToBatteryKwh),
      solarToGridKwh: roundOrZero(slot.solarToGridKwh),
      gridDirectUseKwh: roundOrZero(slot.gridDirectUseKwh),
      gridToBatteryKwh: roundOrZero(slot.gridToBatteryKwh),
      batteryDirectUseKwh: roundOrZero(slot.batteryDirectUseKwh),
      batteryToGridKwh: roundOrZero(slot.batteryToGridKwh),
      batteryChargeKwh: roundOrZero(slot.batteryChargeKwh),
      batteryDischargeKwh: roundOrZero(slot.batteryDischargeKwh),
      selfConsumptionKwh: roundOrZero(slot.selfConsumptionKwh),
      gridShareKwh: round2(slot.gridShareKwh || 0),
      pvShareKwh: round2(slot.pvShareKwh || 0),
      batteryShareKwh: round2(slot.batteryShareKwh || 0)
    })),
    prices: slots.map((slot) => ({
      ts: slot.ts,
      marketPriceCtKwh: slot.marketPriceCtKwh,
      userImportPriceCtKwh: slot.userImportPriceCtKwh
    }))
  };
}

export function createHistoryRuntime({
  store,
  getPricingConfig = () => ({}),
  getOptimizerConfig = () => ({}),
  getSolarMarketValueSummary = () => ({ monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} }),
  getApplicableValueSummary = () => ({ applicableValueCtKwhByMonth: {} }),
  getCurrentDate = currentBerlinDate,
  // T-CURTAIL Increment 3: irradiance-calibrated curtailment. Returns the
  // curtailment service (or null). When present, the "Abgeregelte Energie" KPI
  // uses the per-slot, negative-price-gated calibrated estimate instead of the
  // weather-blind PVGIS gap. null (e.g. in tests) => PVGIS fallback, unchanged.
  getCurtailmentService = () => null
}) {
  function batteryNominalCapacityKwh() {
    const cfg = getOptimizerConfig() || {};
    const totalWh = Number(cfg.batteryCapacityWh);
    if (!Number.isFinite(totalWh) || totalWh <= 0) return null;
    return totalWh / 1000;
  }
  // 1 cycle = cumulative discharge equal to one nominal capacity (0%→100%).
  // 43 kWh in + 43 kWh out across one day = 1 cycle (counts the discharge half;
  // the user's mental model). Multi-day: 90% discharge + 10% discharge = 100%
  // cumulated = 1.0 cycles.
  function computeCycles(dischargeKwh) {
    const cap = batteryNominalCapacityKwh();
    if (!Number.isFinite(cap) || cap <= 0) return null;
    const d = Math.max(0, Number(dischargeKwh) || 0);
    return Math.round((d / cap) * 100) / 100;
  }
  async function listRawFallbackSlotsForRange({ start, end }) {
    const today = getCurrentDate();
    const todayStart = localDateTimeToUtcIso(today, 0, 0);

    if (end <= todayStart) {
      return await store.listAggregatedEnergySlots({
        start,
        end,
        bucketSeconds: SLOT_BUCKET_SECONDS,
        scopes: ['history']
      });
    }

    if (start >= todayStart) {
      return await store.listAggregatedEnergySlots({
        start,
        end,
        bucketSeconds: SLOT_BUCKET_SECONDS,
        scopes: ['live']
      });
    }

    const historySlots = await store.listAggregatedEnergySlots({
      start,
      end: todayStart,
      bucketSeconds: SLOT_BUCKET_SECONDS,
      scopes: ['history']
    });
    const liveSlots = await store.listAggregatedEnergySlots({
      start: todayStart,
      end,
      bucketSeconds: SLOT_BUCKET_SECONDS,
      scopes: ['live']
    });
    return [...historySlots, ...liveSlots].sort((left, right) => left.ts.localeCompare(right.ts));
  }

  async function listEnergySlotsForRange({ start, end }) {
    if (typeof store.listMaterializedEnergySlots === 'function') {
      const materialized = await store.listMaterializedEnergySlots({
        start,
        end,
        sourceKinds: ['vrm_import', 'local_live']
      });
      if (materialized.length > 0 || typeof store.listAggregatedEnergySlots !== 'function') {
        return materialized;
      }
    }
    return await listRawFallbackSlotsForRange({ start, end });
  }

  async function listYearEnergySlotsByMonth(date) {
    const yearStart = startOfYear(date);
    const year = parseDateOnly(yearStart)?.year;
    if (!Number.isFinite(year)) return [];
    const slots = [];
    for (let month = 1; month <= 12; month += 1) {
      const monthDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
      const monthRange = normalizeViewRange('month', monthDate);
      const start = localDateTimeToUtcIso(monthRange.startDate, 0, 0);
      const end = localDateTimeToUtcIso(monthRange.endDateExclusive, 0, 0);
      slots.push(...await listEnergySlotsForRange({ start, end }));
    }
    return slots;
  }

  async function getSummary({ view = 'day', date, solarMarketValues = null }) {
    const range = normalizeViewRange(view, date);
    const start = localDateTimeToUtcIso(range.startDate, 0, 0);
    const end = localDateTimeToUtcIso(range.endDateExclusive, 0, 0);
    const energySlots = view === 'year' && typeof store.listMaterializedEnergySlots === 'function'
      ? await listYearEnergySlotsByMonth(date)
      : await listEnergySlotsForRange({ start, end });
    const priceRows = await store.listPriceSlots({
      start,
      end
    });
    const priceByTs = new Map(priceRows.map((row) => [row.ts, row]));
    const priceByBucketTs = new Map(priceRows.map((row) => [bucketTimestamp(row.ts), row]));
    const pricingConfig = getPricingConfig() || {};
    const applicableValueSummary = getApplicableValueSummary({
      year: parseDateOnly(startOfYear(date))?.year ?? parseDateOnly(currentBerlinDate())?.year,
      pvPlants: pricingConfig?.pvPlants || []
    });
    const weightedApplicableValue = summarizeWeightedApplicableValue({
      pvPlants: pricingConfig?.pvPlants,
      applicableValueSummary,
      applicableValueOverrideCtKwh: pricingConfig?.applicableValueOverrideCtKwh
    });
    const weightedApplicableValueCtKwh = weightedApplicableValue.weightedApplicableValueCtKwh;

    // Compute weighted AW for Volleinspeisung (full feed) using feedType='full'
    // For pre-EEG 2023 plants, getApplicableValueCtKwh returns null for feedType='full'
    // -> fall back to partial AW
    const awFullCtKwh = (() => {
      const plants = pricingConfig?.pvPlants;
      if (!Array.isArray(plants) || plants.length === 0) return null;
      const avSummary = applicableValueSummary;
      if (typeof avSummary?.getApplicableValueCtKwh !== 'function') return weightedApplicableValueCtKwh;
      let totalKwp = 0;
      let weightedCt = 0;
      let resolved = 0;
      for (const plant of plants) {
        const kwp = Number(plant?.kwp);
        if (!Number.isFinite(kwp) || kwp <= 0) continue;
        const ctFull = avSummary.getApplicableValueCtKwh({ commissionedAt: plant.commissionedAt, kwp, feedType: 'full' });
        const ctPartial = avSummary.getApplicableValueCtKwh({ commissionedAt: plant.commissionedAt, kwp, feedType: 'partial' });
        // If full-feed AW is null (pre-EEG 2023 plant), fall back to partial AW
        // Explicit null check: Number(null) === 0 which is finite, so we must check null first
        const ctFullVal = (ctFull != null && Number.isFinite(Number(ctFull))) ? Number(ctFull) : null;
        const ctPartialVal = (ctPartial != null && Number.isFinite(Number(ctPartial))) ? Number(ctPartial) : null;
        const ct = ctFullVal ?? ctPartialVal;
        if (ct == null) return null;
        totalKwp += kwp;
        weightedCt += kwp * ct;
        resolved += 1;
      }
      if (totalKwp <= 0 || resolved === 0) return weightedApplicableValueCtKwh;
      return round2(weightedCt / totalKwp);
    })();

    // EV feed-in compensation (AW minus 0.4 ct/kWh)
    const evFullCtKwh = getFeedInCompensationCtKwh({ applicableValueCtKwh: awFullCtKwh });
    const evPartialCtKwh = getFeedInCompensationCtKwh({ applicableValueCtKwh: weightedApplicableValueCtKwh });

    // Negative price curtailment rule for the configured plants.
    // Use the EARLIEST-commissioned plant deterministically (ISO dates sort
    // chronologically) — NOT pvPlants[0], whose array order is arbitrary and
    // could flip the §51 rule between saves on a multi-plant site. The oldest
    // plant defines the site's longest-standing funding regime.
    const earliestCommissionedAt = (() => {
      const plants = Array.isArray(pricingConfig?.pvPlants) ? pricingConfig.pvPlants : [];
      const dates = plants
        .map((p) => (typeof p?.commissionedAt === 'string' ? p.commissionedAt : ''))
        .filter(Boolean)
        .sort();
      return dates[0] || pricingConfig?.pvPlants?.[0]?.commissionedAt;
    })();
    const negPriceRule = getEegNegativePriceRule({
      commissionedAt: earliestCommissionedAt,
      kwp: summarizeConfiguredPvCapacity(pricingConfig?.pvPlants)
    });

    const solarMarketValueSummary = solarMarketValues || getSolarMarketValueSummary({
      year: parseDateOnly(startOfYear(date))?.year ?? parseDateOnly(currentBerlinDate())?.year
    });
    const solarMarketValueMonthlyCtKwhByMonth = solarMarketValueSummary?.monthlyCtKwhByMonth || {};
    const pvCostCtKwh = Number(pricingConfig?.costs?.pvCtKwh);
    const batteryCostCtKwh = effectiveBatteryCostCtKwh(pricingConfig?.costs || {});

    // Pre-pass: compute isNegPriceAffected per slot timestamp for negative price curtailment.
    // For hour-based rules (6h/4h/tiered), track consecutive negative hours using hourly averages.
    // For 15min rule: just check slot price directly.
    // For 'none': always false.
    const negPriceAffectedByTs = (() => {
      const result = new Map();
      if (negPriceRule.rule === 'none') return result; // all false (map returns undefined -> falsy)

      const rawFiltered = energySlots.filter((slot) => {
        const localDate = localDateString(slot.ts);
        return localDate >= range.startDate && localDate < range.endDateExclusive;
      });

      if (negPriceRule.rule === '15min') {
        for (const slot of rawFiltered) {
          const price = priceByTs.get(slot.ts) || priceByBucketTs.get(bucketTimestamp(slot.ts)) || {};
          const priceCtKwh = Number.isFinite(Number(price.priceCtKwh)) ? Number(price.priceCtKwh) : null;
          result.set(slot.ts, priceCtKwh != null && priceCtKwh < 0);
        }
        return result;
      }

      // Hour-based rules: group slots by hour key, compute hourly average price,
      // then track consecutive negative hours
      const slotsByHour = new Map();
      for (const slot of rawFiltered) {
        const ts = new Date(slot.ts);
        // Review 2026-06-10 (P2-1): keys MUST sort chronologically — the
        // unpadded form ("2026-9-30-2") sorted lexicographically as
        // 0,1,10,…,19,2,20,…, breaking the consecutive-negative-hour count
        // (§51 EEG hourly rules, plants ≥ 400 kWp). Zero-pad all parts.
        const hourKey = `${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, '0')}-${String(ts.getUTCDate()).padStart(2, '0')}-${String(ts.getUTCHours()).padStart(2, '0')}`;
        if (!slotsByHour.has(hourKey)) slotsByHour.set(hourKey, []);
        slotsByHour.get(hourKey).push(slot);
      }

      // Sort hours
      const sortedHourKeys = [...slotsByHour.keys()].sort();
      const hourNegative = new Map();
      for (const hourKey of sortedHourKeys) {
        const hourSlots = slotsByHour.get(hourKey);
        let priceSum = 0;
        let priceCount = 0;
        for (const slot of hourSlots) {
          const price = priceByTs.get(slot.ts) || priceByBucketTs.get(bucketTimestamp(slot.ts)) || {};
          const priceCtKwh = Number.isFinite(Number(price.priceCtKwh)) ? Number(price.priceCtKwh) : null;
          if (priceCtKwh != null) { priceSum += priceCtKwh; priceCount += 1; }
        }
        hourNegative.set(hourKey, priceCount > 0 && (priceSum / priceCount) < 0);
      }

      // Track consecutive negative hours and mark affected slots
      let consecutiveNegHours = 0;
      for (const hourKey of sortedHourKeys) {
        const isNeg = hourNegative.get(hourKey);
        if (isNeg) {
          consecutiveNegHours += 1;
        } else {
          consecutiveNegHours = 0;
        }
        const affected = isNegativePriceSlotAffected({
          rule: negPriceRule.rule,
          consecutiveNegativeHours: consecutiveNegHours,
          year: Number(hourKey.split('-')[0]),
          tiers: negPriceRule.tiers
        });
        for (const slot of slotsByHour.get(hourKey)) {
          result.set(slot.ts, affected);
        }
      }
      return result;
    })();

    const slots = energySlots
      .filter((slot) => {
        const localDate = localDateString(slot.ts);
        return localDate >= range.startDate && localDate < range.endDateExclusive;
      })
      .map((slot) => {
        const price = priceByTs.get(slot.ts) || priceByBucketTs.get(bucketTimestamp(slot.ts)) || {};
        const marketPriceCtKwh = Number.isFinite(Number(price.priceCtKwh)) ? Number(price.priceCtKwh) : null;
        const userImportPriceCtKwh = resolveUserImportPriceCtKwhForSlot({
          ts: slot.ts,
          ct_kwh: marketPriceCtKwh
        }, pricingConfig);
        const monthKey = localMonthString(slot.ts);
        const monthlyMarketValueCtKwh = Number(solarMarketValueMonthlyCtKwhByMonth?.[monthKey]);
        const shares = proportionalSourceShares(slot);
        const flowValues = {
          solarDirectUseKwh: round2(Number(slot.solarDirectUseKwh || 0)),
          pvAcKwh: round2(Number(slot.pvAcKwh || 0)),
          solarToBatteryKwh: round2(Number(slot.solarToBatteryKwh || 0)),
          solarToGridKwh: round2(Number(slot.solarToGridKwh || 0)),
          gridDirectUseKwh: round2(Number(slot.gridDirectUseKwh || 0)),
          gridToBatteryKwh: round2(Number(slot.gridToBatteryKwh || 0)),
          batteryDirectUseKwh: round2(Number(slot.batteryDirectUseKwh || 0)),
          batteryToGridKwh: round2(Number(slot.batteryToGridKwh || 0))
        };
        const pvExportKwh = Math.max(Number(slot.solarToGridKwh || 0), 0);
        const batteryExportKwh = Math.max(Number(slot.batteryToGridKwh || 0), 0);
        const localSelfConsumptionKwh = round2(Number(shares.pvShareKwh || 0) + Number(shares.batteryShareKwh || 0));
        const selfConsumptionKwh = round2(Number(shares.gridShareKwh || 0) + localSelfConsumptionKwh);
        const missingImportPrice = Number(slot.importKwh || 0) > 0 && !Number.isFinite(userImportPriceCtKwh);
        const missingMarketPrice = slot.exportKwh > 0 && !Number.isFinite(marketPriceCtKwh);
        const gridCostEur = costForShareEur(slot.importKwh, userImportPriceCtKwh);
        const pvCostEur = costForShareEur(Number(shares.pvShareKwh || 0) + pvExportKwh, pvCostCtKwh);
        const batteryCostEur = costForShareEur(Number(shares.batteryShareKwh || 0) + batteryExportKwh, batteryCostCtKwh);
        const avoidedImportPvGrossEur = costForShareEur(shares.pvShareKwh, userImportPriceCtKwh);
        const avoidedImportBatteryGrossEur = costForShareEur(shares.batteryShareKwh, userImportPriceCtKwh);
        const avoidedImportGrossEur = round2((avoidedImportPvGrossEur || 0) + (avoidedImportBatteryGrossEur || 0));
        const importCostEur = gridCostEur;
        const opportunityCostEur = costForShareEur(localSelfConsumptionKwh, marketPriceCtKwh);
        const opportunityCostPvEur = costForShareEur(shares.pvShareKwh, marketPriceCtKwh);
        const opportunityCostBatteryEur = costForShareEur(shares.batteryShareKwh, marketPriceCtKwh);
        const selfConsumptionCostEur = round2((gridCostEur || 0) + (pvCostEur || 0) + (batteryCostEur || 0));
        const exportRevenueEur = missingMarketPrice ? null : round2((slot.exportKwh * Number(marketPriceCtKwh || 0)) / 100);
        const netEur = round2((exportRevenueEur || 0) - (selfConsumptionCostEur || 0));
        const premiumEligibleExportKwh =
          Number.isFinite(marketPriceCtKwh) && marketPriceCtKwh >= 0
            ? round2(Number(slot.exportKwh || 0))
            : 0;
        const premiumValuedExportKwh =
          premiumEligibleExportKwh > 0
          && Number.isFinite(weightedApplicableValueCtKwh)
          && Number.isFinite(monthlyMarketValueCtKwh)
            ? premiumEligibleExportKwh
            : 0;
        const marketPremiumCtTotal = premiumValuedExportKwh > 0
          ? round2(premiumValuedExportKwh * (weightedApplicableValueCtKwh - monthlyMarketValueCtKwh))
          : 0;
        const marketPremiumEur = premiumValuedExportKwh > 0 ? round2(marketPremiumCtTotal / 100) : null;
        const marketPremiumCtKwh = premiumValuedExportKwh > 0 ? round2(marketPremiumCtTotal / premiumValuedExportKwh) : null;
        const grossReturnEur = round2(netEur + avoidedImportGrossEur);

        // DV comparison: negative price curtailment per slot
        const isNegPriceAffected = Boolean(negPriceAffectedByTs.get(slot.ts));
        const negPriceEligiblePvKwh = isNegPriceAffected ? 0 : round2(Number(slot.pvKwh || 0));
        const negPriceEligibleExportKwh = isNegPriceAffected ? 0 : round2(Number(slot.exportKwh || 0));
        // Accumulate in ct to avoid EUR rounding per slot — divide by 100 at the end
        const hypFullFeedInCtTotal = evFullCtKwh != null
          ? round2(negPriceEligiblePvKwh * evFullCtKwh)
          : null;
        const hypSurplusFeedInCtTotal = evPartialCtKwh != null
          ? round2(negPriceEligibleExportKwh * evPartialCtKwh)
          : null;

        return {
          ...slot,
          ...flowValues,
          ...shares,
          selfConsumptionKwh,
          marketPriceCtKwh,
          userImportPriceCtKwh,
          gridCostEur,
          pvCostEur,
          batteryCostEur,
          avoidedImportGrossEur,
          avoidedImportPvGrossEur,
          avoidedImportBatteryGrossEur,
          opportunityCostEur,
          opportunityCostPvEur,
          opportunityCostBatteryEur,
          selfConsumptionCostEur,
          importCostEur,
          exportRevenueEur,
          netEur,
          grossReturnEur,
          premiumEligibleExportKwh,
          premiumValuedExportKwh,
          marketPremiumCtTotal,
          marketPremiumEur,
          marketPremiumCtKwh,
          negPriceEligiblePvKwh,
          negPriceEligibleExportKwh,
          isNegPriceAffected,
          hypFullFeedInCtTotal,
          hypSurplusFeedInCtTotal,
          estimated: Boolean(slot.estimated),
          incomplete: Boolean(slot.incomplete) || missingImportPrice || missingMarketPrice
        };
      });

    const missingImportPriceSlots = slots.filter((slot) => slot.importKwh > 0 && !Number.isFinite(slot.userImportPriceCtKwh)).length;
    const missingMarketPriceSlots = slots.filter((slot) => slot.exportKwh > 0 && !Number.isFinite(slot.marketPriceCtKwh)).length;
    const incompleteSlots = slots.filter((slot) => slot.incomplete).length;
    const estimatedSlots = slots.filter((slot) => slot.estimated).length;
    const kpis = finalizeAggregateSums(slots.reduce((totals, slot) => ({
      importKwh: totals.importKwh + slot.importKwh,
      exportKwh: totals.exportKwh + slot.exportKwh,
      loadKwh: totals.loadKwh + Number(slot.loadKwh || 0),
      pvKwh: totals.pvKwh + Number(slot.pvKwh || 0),
      pvAcKwh: totals.pvAcKwh + Number(slot.pvAcKwh || 0),
      solarDirectUseKwh: totals.solarDirectUseKwh + Number(slot.solarDirectUseKwh || 0),
      solarToBatteryKwh: totals.solarToBatteryKwh + Number(slot.solarToBatteryKwh || 0),
      solarToGridKwh: totals.solarToGridKwh + Number(slot.solarToGridKwh || 0),
      gridDirectUseKwh: totals.gridDirectUseKwh + Number(slot.gridDirectUseKwh || 0),
      gridToBatteryKwh: totals.gridToBatteryKwh + Number(slot.gridToBatteryKwh || 0),
      batteryDirectUseKwh: totals.batteryDirectUseKwh + Number(slot.batteryDirectUseKwh || 0),
      batteryToGridKwh: totals.batteryToGridKwh + Number(slot.batteryToGridKwh || 0),
      batteryChargeKwh: totals.batteryChargeKwh + Number(slot.batteryChargeKwh || 0),
      batteryDischargeKwh: totals.batteryDischargeKwh + Number(slot.batteryDischargeKwh || 0),
      selfConsumptionKwh: totals.selfConsumptionKwh + Number(slot.selfConsumptionKwh || 0),
      gridShareKwh: totals.gridShareKwh + Number(slot.gridShareKwh || 0),
      pvShareKwh: totals.pvShareKwh + Number(slot.pvShareKwh || 0),
      batteryShareKwh: totals.batteryShareKwh + Number(slot.batteryShareKwh || 0),
      importCostEur: totals.importCostEur + (slot.importCostEur || 0),
      gridCostEur: totals.gridCostEur + (slot.gridCostEur || 0),
      pvCostEur: totals.pvCostEur + (slot.pvCostEur || 0),
      batteryCostEur: totals.batteryCostEur + (slot.batteryCostEur || 0),
      avoidedImportGrossEur: totals.avoidedImportGrossEur + (slot.avoidedImportGrossEur || 0),
      avoidedImportPvGrossEur: totals.avoidedImportPvGrossEur + (slot.avoidedImportPvGrossEur || 0),
      avoidedImportBatteryGrossEur: totals.avoidedImportBatteryGrossEur + (slot.avoidedImportBatteryGrossEur || 0),
      opportunityCostEur: totals.opportunityCostEur + (slot.opportunityCostEur || 0),
      opportunityCostPvEur: totals.opportunityCostPvEur + (slot.opportunityCostPvEur || 0),
      opportunityCostBatteryEur: totals.opportunityCostBatteryEur + (slot.opportunityCostBatteryEur || 0),
      selfConsumptionCostEur: totals.selfConsumptionCostEur + (slot.selfConsumptionCostEur || 0),
      exportRevenueEur: totals.exportRevenueEur + (slot.exportRevenueEur || 0),
      solarCompensationEur: 0,
      netEur: totals.netEur + slot.netEur,
      grossReturnEur: null,
      configuredPvCapacityKwp: null,
      pvFullLoadHours: null,
      annualMarketValueCtKwh: null,
      weightedApplicableValueCtKwh: null,
      premiumEligibleExportKwh: totals.premiumEligibleExportKwh + (slot.premiumEligibleExportKwh || 0),
      premiumValuedExportKwh: totals.premiumValuedExportKwh + (slot.premiumValuedExportKwh || 0),
      marketPremiumCtTotal: totals.marketPremiumCtTotal + (slot.marketPremiumCtTotal || 0),
      marketPremiumEur: null,
      marketPremiumCtKwh: null,
      negPriceEligiblePvKwh: totals.negPriceEligiblePvKwh + (slot.negPriceEligiblePvKwh || 0),
      negPriceEligibleExportKwh: totals.negPriceEligibleExportKwh + (slot.negPriceEligibleExportKwh || 0),
      // §51-EEG: count of slots whose feed-in compensation is curtailed to 0 by
      // negative prices — drives the Förder-Verlängerung KPI (see below). Plain
      // integer; not in AGGREGATE_SUM_FIELDS so finalizeAggregateSums leaves it.
      negPriceAffectedSlots: totals.negPriceAffectedSlots + (slot.isNegPriceAffected ? 1 : 0),
      hypFullFeedInCtTotal: slot.hypFullFeedInCtTotal != null
        ? (totals.hypFullFeedInCtTotal || 0) + slot.hypFullFeedInCtTotal
        : totals.hypFullFeedInCtTotal,
      hypSurplusFeedInCtTotal: slot.hypSurplusFeedInCtTotal != null
        ? (totals.hypSurplusFeedInCtTotal || 0) + slot.hypSurplusFeedInCtTotal
        : totals.hypSurplusFeedInCtTotal
    }), {
      importKwh: 0,
      exportKwh: 0,
      loadKwh: 0,
      pvKwh: 0,
      pvAcKwh: 0,
      solarDirectUseKwh: 0,
      solarToBatteryKwh: 0,
      solarToGridKwh: 0,
      gridDirectUseKwh: 0,
      gridToBatteryKwh: 0,
      batteryDirectUseKwh: 0,
      batteryToGridKwh: 0,
      batteryChargeKwh: 0,
      batteryDischargeKwh: 0,
      selfConsumptionKwh: 0,
      gridShareKwh: 0,
      pvShareKwh: 0,
      batteryShareKwh: 0,
      importCostEur: 0,
      gridCostEur: 0,
      pvCostEur: 0,
      batteryCostEur: 0,
      avoidedImportGrossEur: 0,
      avoidedImportPvGrossEur: 0,
      avoidedImportBatteryGrossEur: 0,
      opportunityCostEur: 0,
      opportunityCostPvEur: 0,
      opportunityCostBatteryEur: 0,
      selfConsumptionCostEur: 0,
      exportRevenueEur: 0,
      solarCompensationEur: 0,
      netEur: 0,
      grossReturnEur: null,
      configuredPvCapacityKwp: null,
      pvFullLoadHours: null,
      annualMarketValueCtKwh: null,
      weightedApplicableValueCtKwh: null,
      premiumEligibleExportKwh: 0,
      premiumValuedExportKwh: 0,
      marketPremiumCtTotal: 0,
      marketPremiumEur: null,
      marketPremiumCtKwh: null,
      negPriceEligiblePvKwh: 0,
      negPriceEligibleExportKwh: 0,
      negPriceAffectedSlots: 0,
      hypFullFeedInCtTotal: evFullCtKwh != null ? 0 : null,
      hypSurplusFeedInCtTotal: evPartialCtKwh != null ? 0 : null
    }));

    // §51 EEG (Solarspitzengesetz) Förder-Verlängerung. Jede negativ-bepreiste
    // Viertelstunde, in der die EEG-Vergütung auf 0 gekürzt wird, verlängert den
    // 20-Jahre-Anspruchszeitraum um genau diese Dauer (§51 Abs. 2 EEG 2023 i.d.F.
    // Solarspitzengesetz). Der "Verlust" ist also aufgeschoben, nicht endgültig.
    // Summe der betroffenen Slots × Slot-Dauer → Stunden; Monats-Näherung mit
    // 730,5 h/Monat (8766 h/Jahr ÷ 12). negPriceRule='none' ⇒ Anlage nicht §51-
    // betroffen ⇒ Karte blendet die Zeile aus (Frontend prüft die rule).
    const eegExtensionSlotHours = SLOT_BUCKET_SECONDS / 3600; // 0,25 h bei 15-min Slots
    const negSlotCount = Number(kpis.negPriceAffectedSlots || 0);
    const eegExtensionHours = round2(negSlotCount * eegExtensionSlotHours);
    kpis.negPriceRule = negPriceRule.rule;
    kpis.negPriceRuleDescription = negPriceRule.description || null;
    kpis.eegExtensionHours = eegExtensionHours;
    kpis.eegExtensionMonths = eegExtensionHours > 0 ? round2(eegExtensionHours / 730.5) : 0;
    // §51a-Solarspitzengesetz-Mechanik (Karte „§51 Förderverlängerung", 2026-06-14):
    //   Volllastviertelstunden = ceil(Negativ-15min × 0,5); Förderverlängerung in
    //   Monaten via gesetzlicher Monatstabelle (extensionFromVollast). Die
    //   Monatszahl ist nur über ein VOLLES Jahr sinnvoll (die VVL-Verteilung auf
    //   Monate ist stark ungleich) → nur in der Jahresansicht gesetzt.
    const vlv = vollastViertelstunden(negSlotCount);
    kpis.negPriceQuarterHourCount = negSlotCount;
    kpis.volllastViertelstunden = vlv;
    kpis.eegExtensionMonthsVlv = view === 'year' ? round2(extensionFromVollast(vlv).accruedMonths) : null;
    // Börse Ø als Bewertungsbasis für den Pot. Erlös der abgeregelten Energie
    // (Christin 2026-06-14, mehrfach präzisiert): Der Wert muss dem in der DV-
    // Karte gezeigten Börsenpreis ENTSPRECHEN — das ist der export-GEWICHTETE
    // Spotpreis (Börsenerlös ÷ exportierte kWh = was real je kWh erlöst wurde),
    // NICHT das flache Zeitmittel (das wich ab: Mai 9,75 statt 10,78). Es wird
    // über die VIEW-Periode gerechnet — identisch zur DV-Karte (die ebenfalls
    // kpis.exportRevenueEur/kpis.exportKwh nutzt) → beide Karten zeigen denselben
    // Börsenpreis. Der avgSpotPriceBasis-Hinweis steuert nur das Label.
    const weightedExpKwh = Number(kpis.exportKwh || 0);
    const weightedExpRev = Number(kpis.exportRevenueEur || 0);
    kpis.avgSpotPriceCtKwh = weightedExpKwh > 0
      ? round2((weightedExpRev / weightedExpKwh) * 100)
      : null;
    kpis.avgSpotPriceBasis = view; // 'day'|'week'|'month'|'year'|'all'

    // DV comparison KPIs: week, month and year views (data exists from the
    // week view onward); null for day / all.
    if (view === 'week' || view === 'month' || view === 'year') {
      const hypFullFeedInEur = kpis.hypFullFeedInCtTotal != null
        ? round2(kpis.hypFullFeedInCtTotal / 100)
        : null;
      const hypSurplusFeedInEur = kpis.hypSurplusFeedInCtTotal != null
        ? round2(kpis.hypSurplusFeedInCtTotal / 100)
        : null;
      const dvRevenueEur = round2((kpis.exportRevenueEur || 0) + (kpis.marketPremiumCtTotal ? round2(kpis.marketPremiumCtTotal / 100) : 0));
      const dvExcessEur = hypSurplusFeedInEur != null
        ? round2(dvRevenueEur - hypSurplusFeedInEur)
        : null;

      const dvCostMonthlyEurVal = Number(pricingConfig?.dvCostMonthlyEur);
      let dvCostEur = null;
      if (Number.isFinite(dvCostMonthlyEurVal)) {
        if (view === 'month') {
          dvCostEur = round2(dvCostMonthlyEurVal);
        } else if (view === 'week') {
          // The DV provider fee is billed monthly — for the week view we
          // prorate it per day: daily rate = monthly fee / days in that
          // day's month, summed over the week's days up to (and including)
          // today. A fully elapsed week → 7 daily rates; the current week
          // → only the days already elapsed; a cross-month week uses each
          // day's own month length.
          const today = currentBerlinDate();
          let cost = 0;
          let cursor = range.startDate;
          while (cursor < range.endDateExclusive && cursor <= today) {
            const p = parseDateOnly(cursor);
            const daysInMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
            cost += dvCostMonthlyEurVal / daysInMonth;
            cursor = addDays(cursor, 1);
          }
          dvCostEur = round2(cost);
        } else {
          // Year view: count distinct months with export > 0
          const activeMonthSet = new Set(
            slots.filter((s) => Number(s.exportKwh || 0) > 0).map((s) => localMonthString(s.ts))
          );
          const activeMonths = activeMonthSet.size > 0 ? activeMonthSet.size : 1;
          dvCostEur = round2(dvCostMonthlyEurVal * activeMonths);
        }
      }

      const dvNetAdvantageEur = dvExcessEur != null && dvCostEur != null
        ? round2(dvExcessEur - dvCostEur)
        : null;

      const dvExportKwh = Number(kpis.exportKwh || 0);
      const dvRevenueCtKwh = dvExportKwh > 0
        ? round2((dvRevenueEur / dvExportKwh) * 100)
        : null;

      Object.assign(kpis, {
        dvRevenueEur,
        dvRevenueCtKwh,
        hypFullFeedInEur,
        hypSurplusFeedInEur,
        dvExcessEur,
        dvCostEur,
        dvNetAdvantageEur,
        awFullCtKwh: awFullCtKwh ?? null,
        awPartialCtKwh: weightedApplicableValueCtKwh ?? null,
        // Effective EEG-Vergütung rate (AW − Pauschalabzug §50e) — the
        // actual ct/kWh multiplied per slot. Useful for the UI to show
        // "1.640 kWh × 7,56 ct/kWh = 124 €" instead of just the Euro total.
        hypFullFeedInCtKwh: evFullCtKwh ?? null,
        hypSurplusFeedInCtKwh: evPartialCtKwh ?? null
        // kWh-basis fields (negPriceEligiblePvKwh / negPriceEligibleExportKwh)
        // are already aggregated into kpis by the reducer above, no need to
        // re-assign here — they come through via the kpis surface.
      });
    } else {
      Object.assign(kpis, {
        dvRevenueEur: null,
        dvRevenueCtKwh: null,
        hypFullFeedInEur: null,
        hypSurplusFeedInEur: null,
        dvExcessEur: null,
        dvCostEur: null,
        dvNetAdvantageEur: null,
        awFullCtKwh: null,
        awPartialCtKwh: null,
        hypFullFeedInCtKwh: null,
        hypSurplusFeedInCtKwh: null
      });
    }

    const capacityAppliedKpis = applyPvFullLoadHours({
      kpis,
      pricingConfig
    });
    capacityAppliedKpis.cycles = computeCycles(capacityAppliedKpis.batteryDischargeKwh);
    capacityAppliedKpis.batteryNominalCapacityKwh = batteryNominalCapacityKwh();
    const baseRows = summarizeRows(slots, view).map((row) => ({
      ...row,
      cycles: computeCycles(row.batteryDischargeKwh)
    }));
    const solarApplied = applySolarMarketValues({
      rows: baseRows,
      view,
      date,
      kpis: capacityAppliedKpis,
      meta: {
        selectedDate: date,
        currentDate: getCurrentDate(),
        unresolved: {
          missingImportPriceSlots,
          missingMarketPriceSlots,
          incompleteSlots,
          estimatedSlots,
          slotCount: slots.length
        }
      },
      solarMarketValues: solarMarketValueSummary
    });
    const solarMeta = {
      ...solarApplied.meta,
      solarMarketValueMonthlyCtKwhByMonth: solarMarketValueSummary?.monthlyCtKwhByMonth || {},
      solarMarketValueAnnualCtKwhByYear: solarMarketValueSummary?.annualCtKwhByYear || {}
    };
    const annualPremiumApplied = applyAnnualMarketPremium({
      view,
      slots,
      kpis: solarApplied.kpis,
      meta: solarMeta,
      pricingConfig,
      applicableValueSummary
    });
    const periodPremiumApplied = applyPeriodPremiumDisplay({
      view,
      date,
      slots,
      kpis: annualPremiumApplied.kpis,
      meta: annualPremiumApplied.meta,
      pricingConfig,
      weightedApplicableValueCtKwh
    });

    // DV-Recompute: dvRevenueEur wurde weiter oben mit der Slot-Summe
    // marketPremiumCtTotal berechnet, BEVOR applyAnnualMarketPremium die
    // Jahres-Fallback-Prämie hochzieht (für Monate ohne konfigurierten
    // Monatsmarktwert). Spalte 1 der DV-Karte zeigt aber den finalen
    // marketPremiumEur. Damit beide Spalten sich gegenseitig erklären,
    // recompute dvRevenueEur/-CtKwh/-Excess/-NetAdvantage hier mit dem
    // finalen marketPremiumEur.
    if (view === 'week' || view === 'month' || view === 'year') {
      const finalK = periodPremiumApplied.kpis;
      const finalMarketPremiumEur = Number(finalK.marketPremiumEur || 0);
      const dvExportKwh = Number(finalK.exportKwh || 0);
      const dvRevenueEur = round2(Number(finalK.exportRevenueEur || 0) + finalMarketPremiumEur);
      const dvRevenueCtKwh = dvExportKwh > 0 ? round2((dvRevenueEur / dvExportKwh) * 100) : null;
      const dvExcessEur = finalK.hypSurplusFeedInEur != null
        ? round2(dvRevenueEur - Number(finalK.hypSurplusFeedInEur))
        : null;
      const dvNetAdvantageEur = dvExcessEur != null && finalK.dvCostEur != null
        ? round2(dvExcessEur - Number(finalK.dvCostEur))
        : null;
      Object.assign(finalK, { dvRevenueEur, dvRevenueCtKwh, dvExcessEur, dvNetAdvantageEur });
    }
    // Abregelungs-Schaetzung: erwartete vs. tatsaechliche PV-Erzeugung.
    // Schreibt expectedPvKwh / curtailedPvKwh ins finalK direkt (statt eines
    // neuen kpis-Spreads, weil periodPremiumApplied.kpis bereits die Quelle ist).
    const curtailKpis = await applyCurtailmentEstimate({
      view,
      range,
      kpis: periodPremiumApplied.kpis,
      pricingConfig,
      curtailmentService: getCurtailmentService()
    });
    if (curtailKpis.expectedPvKwh != null || curtailKpis.curtailedPvKwh != null) {
      Object.assign(periodPremiumApplied.kpis, {
        expectedPvKwh: curtailKpis.expectedPvKwh,
        curtailedPvKwh: curtailKpis.curtailedPvKwh,
        curtailmentSource: curtailKpis.curtailmentSource ?? null
      });
    }

    // SoC-Randkorrektur (Christin 2026-06-14): Akku-/Gesamt-Verlust = geladen −
    // entladen vergleicht ZWEI Energieflüsse über ein festes Fenster, ignoriert
    // aber den SoC-Übertrag an den Rändern (abends voll aus dem Vormonat / Akku
    // mit in den Folgemonat). batteryStoredDeltaKwh = (SoC_Ende − SoC_Start) ×
    // Kapazität; das Frontend zieht es von Akku- UND Gesamtverlust ab und
    // korrigiert den Wirkungsgrad. Kein SoC (z.B. vor 2026-03-26) ⇒ Feld fehlt ⇒
    // unkorrigiert wie bisher.
    try {
      const cap = batteryNominalCapacityKwh();
      if (cap != null && typeof store.getSeriesBoundaryValues === 'function'
          && range?.startDate && range?.endDateExclusive) {
        const soc = await store.getSeriesBoundaryValues({
          seriesKey: 'battery_soc_pct',
          start: localDateTimeToUtcIso(range.startDate, 0, 0),
          end: localDateTimeToUtcIso(range.endDateExclusive, 0, 0)
        });
        if (soc.startValue != null && soc.endValue != null) {
          Object.assign(periodPremiumApplied.kpis, {
            batterySocStartPct: round2(soc.startValue),
            batterySocEndPct: round2(soc.endValue),
            batteryStoredDeltaKwh: round2(((soc.endValue - soc.startValue) / 100) * cap)
          });
        }
      }
    } catch {
      // no SoC series for this window -> leave KPIs uncorrected (legacy behaviour)
    }
    const rows = solarApplied.rows;
    const charts = view === 'day'
      ? buildDayCharts(slots)
      : buildPeriodCharts(rows);
    const sourceSummary = slots.reduce((summary, slot) => {
      const sourceKinds = new Set(Array.isArray(slot?.sourceKinds) ? slot.sourceKinds : []);
      if (slot?.sourceKind === 'local_live') sourceKinds.add('local_live');
      if (slot?.sourceKind === 'vrm_import') sourceKinds.add('vrm_import');
      return {
        localLiveSlots: summary.localLiveSlots + (sourceKinds.has('local_live') ? 1 : 0),
        vrmImportSlots: summary.vrmImportSlots + (sourceKinds.has('vrm_import') ? 1 : 0)
      };
    }, {
      localLiveSlots: 0,
      vrmImportSlots: 0
    });

    return {
      view,
      date,
      range: {
        startDate: range.startDate,
        endDateExclusive: range.endDateExclusive,
        start,
        end
      },
      kpis: periodPremiumApplied.kpis,
      series: buildSummarySeries(view, slots),
      charts,
      rows,
      slots: (view === 'year' || view === 'all') ? [] : slots,
      meta: {
        ...periodPremiumApplied.meta,
        sourceSummary
      }
    };
  }

  return {
    getSummary
  };
}

export function createHistoryApiHandlers({
  historyRuntime,
  historyImportManager,
  telemetryEnabled,
  defaultBzn = 'DE-LU',
  appVersion = null,
  getSolarMarketValueSummary = null
}) {
  return {
    async getSummary(query = {}) {
      if (!telemetryEnabled || !historyRuntime) {
        return { status: 503, body: { ok: false, error: 'internal telemetry store disabled' } };
      }
      const view = String(query.view || 'day');
      const date = String(query.date || '');
      if (!SUPPORTED_VIEWS.has(view)) {
        return { status: 400, body: { ok: false, error: 'view must be one of day, week, month, year, all' } };
      }
      if (!isDateOnly(date)) {
        return { status: 400, body: { ok: false, error: 'date must use YYYY-MM-DD' } };
      }
      let solarMarketValues = null;
      if (view !== 'day' && typeof getSolarMarketValueSummary === 'function') {
        try {
          solarMarketValues = await getSolarMarketValueSummary({
            year: parseDateOnly(startOfYear(date))?.year
          });
        } catch (_error) {
          solarMarketValues = null;
        }
      }
      return {
        status: 200,
        body: {
          ...await historyRuntime.getSummary({ view, date, solarMarketValues }),
          app: appVersion
        }
      };
    },
    async getExportCsv(query = {}) {
      if (!telemetryEnabled || !historyRuntime) {
        return { status: 503, body: { ok: false, error: 'internal telemetry store disabled' } };
      }
      const view = String(query.view || 'day');
      const date = String(query.date || '');
      if (!SUPPORTED_VIEWS.has(view)) {
        return { status: 400, body: { ok: false, error: 'view must be one of day, week, month, year, all' } };
      }
      if (!isDateOnly(date)) {
        return { status: 400, body: { ok: false, error: 'date must use YYYY-MM-DD' } };
      }
      let solarMarketValues = null;
      if (view !== 'day' && typeof getSolarMarketValueSummary === 'function') {
        try {
          solarMarketValues = await getSolarMarketValueSummary({
            year: parseDateOnly(startOfYear(date))?.year
          });
        } catch (_error) {
          solarMarketValues = null;
        }
      }
      const summary = await historyRuntime.getSummary({ view, date, solarMarketValues });
      const rows = Array.isArray(summary?.rows) ? summary.rows : [];
      const includeSolar = view === 'year';
      // German Excel: semicolon separator + UTF-8 BOM. Use comma decimals.
      const fmtNumber = (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(4).replace('.', ',') : '';
      const csvCell = (v) => {
        const s = v == null ? '' : String(v);
        return /[;\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const headers = [
        'Periode', 'Import_kWh', 'Verbrauch_kWh', 'PV_erzeugt_kWh', 'PV_AC_kWh',
        'PV_direkt_kWh', 'PV_zu_Akku_kWh', 'PV_zu_Netz_kWh',
        'Netz_direkt_kWh', 'Netz_zu_Akku_kWh', 'Akku_direkt_kWh', 'Akku_zu_Netz_kWh',
        'Akku_geladen_kWh', 'Akku_entladen_kWh', 'Akku_Zyklen',
        'Eigenverbrauch_kWh', 'Eigenverbrauch_Netz_kWh', 'Eigenverbrauch_PV_kWh', 'Eigenverbrauch_Akku_kWh',
        'Export_kWh',
        'Netzkosten_EUR', 'PV_Kosten_EUR', 'Akku_Kosten_EUR', 'Vermiedener_Bezug_EUR',
        'Erloes_Einspeisung_EUR', 'Kosten_EUR', 'Netto_EUR', 'Brutto_Erloes_EUR'
      ];
      if (includeSolar) headers.push('Marktwert_Solar_ct_kWh', 'Solar_Ausgleich_EUR');
      headers.push('estimatedSlots', 'incompleteSlots', 'sourceKind');
      const lines = [headers.map(csvCell).join(';')];
      for (const row of rows) {
        const cost = Number(row.gridCostEur ?? row.importCostEur ?? 0)
          + Number(row.pvCostEur || 0) + Number(row.batteryCostEur || 0);
        const net = Number(row.exportRevenueEur || 0) - cost;
        const cells = [
          row.label || row.key || '',
          fmtNumber(row.importKwh), fmtNumber(row.loadKwh), fmtNumber(row.pvKwh), fmtNumber(row.pvAcKwh),
          fmtNumber(row.solarDirectUseKwh), fmtNumber(row.solarToBatteryKwh), fmtNumber(row.solarToGridKwh),
          fmtNumber(row.gridDirectUseKwh), fmtNumber(row.gridToBatteryKwh),
          fmtNumber(row.batteryDirectUseKwh), fmtNumber(row.batteryToGridKwh),
          fmtNumber(row.batteryChargeKwh), fmtNumber(row.batteryDischargeKwh), fmtNumber(row.cycles),
          fmtNumber(row.selfConsumptionKwh), fmtNumber(row.gridShareKwh),
          fmtNumber(row.pvShareKwh), fmtNumber(row.batteryShareKwh),
          fmtNumber(row.exportKwh),
          fmtNumber(row.gridCostEur ?? row.importCostEur), fmtNumber(row.pvCostEur), fmtNumber(row.batteryCostEur),
          fmtNumber(row.avoidedImportGrossEur),
          fmtNumber(row.exportRevenueEur), fmtNumber(cost), fmtNumber(net), fmtNumber(row.grossReturnEur)
        ];
        if (includeSolar) {
          cells.push(fmtNumber(row.solarMarketValueCtKwh), fmtNumber(row.solarCompensationEur));
        }
        cells.push(
          String(row.estimatedSlots ?? ''),
          String(row.incompleteSlots ?? ''),
          row.sourceKind || ''
        );
        lines.push(cells.map(csvCell).join(';'));
      }
      const bom = '﻿';
      const csv = bom + lines.join('\r\n') + '\r\n';
      const filename = `dvhub-history-${view}-${date}.csv`;
      return {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`
        },
        rawBody: csv
      };
    },
    async postPriceBackfill(body = {}) {
      if (!telemetryEnabled || !historyImportManager) {
        return { status: 503, body: { ok: false, error: 'internal telemetry store disabled' } };
      }
      const explicitStart = body.start ?? body.requestedFrom ?? null;
      const explicitEnd = body.end ?? body.requestedTo ?? null;
      let start = explicitStart;
      let end = explicitEnd;
      if ((!start || !end) && (body.view || body.date)) {
        const view = SUPPORTED_VIEWS.has(String(body.view || '')) ? String(body.view) : 'day';
        const date = isDateOnly(String(body.date || '')) ? String(body.date) : currentBerlinDate();
        const range = normalizeViewRange(view, date);
        start = localDateTimeToUtcIso(range.startDate, 0, 0);
        end = localDateTimeToUtcIso(range.endDateExclusive, 0, 0);
      }
      try {
        const result = await historyImportManager.backfillMissingPriceHistory({
          bzn: String(body.bzn || defaultBzn),
          start,
          end
        });
        return { status: result.ok ? 200 : 400, body: result };
      } catch (error) {
        return { status: 502, body: { ok: false, error: error.message } };
      }
    }
  };
}
