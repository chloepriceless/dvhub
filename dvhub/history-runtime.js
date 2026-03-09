import { resolveUserImportPriceCtKwhForSlot } from './config-model.js';

const BERLIN_TIME_ZONE = 'Europe/Berlin';
const SUPPORTED_VIEWS = new Set(['day', 'week', 'month', 'year']);
const SLOT_BUCKET_SECONDS = 900;

function round2(value) {
  const numeric = Number(value || 0);
  const sign = numeric < 0 ? -1 : 1;
  return sign * (Math.round((Math.abs(numeric) + Number.EPSILON) * 100) / 100);
}

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
    opportunityCostEur: 0,
    selfConsumptionCostEur: 0,
    exportRevenueEur: 0,
    solarCompensationEur: 0,
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
    estimatedSlots: 0
  };
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
    const row = groups.get(key) || buildRowAccumulator(key, label);
    row.importKwh = round2(row.importKwh + slot.importKwh);
    row.exportKwh = round2(row.exportKwh + slot.exportKwh);
    row.loadKwh = round2(row.loadKwh + Number(slot.loadKwh || 0));
    row.pvKwh = round2(row.pvKwh + Number(slot.pvKwh || 0));
    row.batteryChargeKwh = round2(row.batteryChargeKwh + Number(slot.batteryChargeKwh || 0));
    row.batteryDischargeKwh = round2(row.batteryDischargeKwh + Number(slot.batteryDischargeKwh || 0));
    row.selfConsumptionKwh = round2(row.selfConsumptionKwh + Number(slot.selfConsumptionKwh || 0));
    row.gridShareKwh = round2(row.gridShareKwh + Number(slot.gridShareKwh || 0));
    row.pvShareKwh = round2(row.pvShareKwh + Number(slot.pvShareKwh || 0));
    row.batteryShareKwh = round2(row.batteryShareKwh + Number(slot.batteryShareKwh || 0));
    row.importCostEur = round2(row.importCostEur + (slot.importCostEur || 0));
    row.gridCostEur = round2(row.gridCostEur + (slot.gridCostEur || 0));
    row.pvCostEur = round2(row.pvCostEur + (slot.pvCostEur || 0));
    row.batteryCostEur = round2(row.batteryCostEur + (slot.batteryCostEur || 0));
    row.opportunityCostEur = round2(row.opportunityCostEur + (slot.opportunityCostEur || 0));
    row.selfConsumptionCostEur = round2(row.selfConsumptionCostEur + (slot.selfConsumptionCostEur || 0));
    row.exportRevenueEur = round2(row.exportRevenueEur + (slot.exportRevenueEur || 0));
    row.netEur = round2(row.exportRevenueEur - row.selfConsumptionCostEur);
    const marketWeight = Number(slot.pvShareKwh || 0) + Number(slot.batteryShareKwh || 0) + Number(slot.exportKwh || 0);
    if (Number.isFinite(Number(slot.marketPriceCtKwh)) && marketWeight > 0) {
      row.marketPriceWeightKwh = round2(row.marketPriceWeightKwh + marketWeight);
      row.marketPriceWeightedCtTotal = round2(row.marketPriceWeightedCtTotal + (marketWeight * Number(slot.marketPriceCtKwh)));
      row.marketPriceWeightedCtKwh = round2(row.marketPriceWeightedCtTotal / row.marketPriceWeightKwh);
    }
    const importWeight = Number(slot.importKwh || 0);
    if (Number.isFinite(Number(slot.userImportPriceCtKwh)) && importWeight > 0) {
      row.userImportPriceWeightKwh = round2(row.userImportPriceWeightKwh + importWeight);
      row.userImportPriceWeightedCtTotal = round2(row.userImportPriceWeightedCtTotal + (importWeight * Number(slot.userImportPriceCtKwh)));
      row.userImportPriceWeightedCtKwh = round2(row.userImportPriceWeightedCtTotal / row.userImportPriceWeightKwh);
    }
    row.slotCount += 1;
    if (slot.incomplete) row.incompleteSlots += 1;
    if (slot.estimated) row.estimatedSlots += 1;
    groups.set(key, row);
  }
  return [...groups.values()];
}

function buildDayCharts(slots) {
  return {
    dayEnergyLines: slots.map((slot) => ({
      ts: slot.ts,
      label: localTimeLabel(slot.ts),
      pvKwh: round2(slot.pvKwh || 0),
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
      opportunityCostEur: slot.opportunityCostEur,
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
      opportunityCostEur: row.opportunityCostEur,
      selfConsumptionCostEur: row.selfConsumptionCostEur,
      netEur: row.netEur,
      estimatedSlots: row.estimatedSlots,
      incompleteSlots: row.incompleteSlots
    })),
    periodCombinedBars: rows.map((row) => ({
      label: row.label,
      importKwh: row.importKwh,
      exportKwh: row.exportKwh,
      loadKwh: row.loadKwh,
      pvKwh: row.pvKwh,
      batteryChargeKwh: row.batteryChargeKwh,
      batteryDischargeKwh: row.batteryDischargeKwh,
      selfConsumptionKwh: row.selfConsumptionKwh,
      gridShareKwh: row.gridShareKwh,
      pvShareKwh: row.pvShareKwh,
      batteryShareKwh: row.batteryShareKwh,
      exportRevenueEur: row.exportRevenueEur,
      gridCostEur: row.gridCostEur,
      pvCostEur: row.pvCostEur,
      batteryCostEur: row.batteryCostEur,
      opportunityCostEur: row.opportunityCostEur,
      selfConsumptionCostEur: row.selfConsumptionCostEur,
      netEur: row.netEur,
      estimatedSlots: row.estimatedSlots,
      incompleteSlots: row.incompleteSlots
    })),
    periodEnergyBars: rows.map((row) => ({
      label: row.label,
      importKwh: row.importKwh,
      exportKwh: row.exportKwh,
      loadKwh: row.loadKwh,
      pvKwh: row.pvKwh,
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

export function createHistoryRuntime({
  store,
  getPricingConfig = () => ({}),
  getSolarMarketValueSummary = () => ({ monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} })
}) {
  function getSummary({ view = 'day', date, solarMarketValues = null }) {
    const range = normalizeViewRange(view, date);
    const start = localDateTimeToUtcIso(range.startDate, 0, 0);
    const end = localDateTimeToUtcIso(range.endDateExclusive, 0, 0);
    const energySlots = store.listAggregatedEnergySlots({
      start,
      end,
      bucketSeconds: SLOT_BUCKET_SECONDS
    });
    const priceRows = store.listPriceSlots({
      start,
      end
    });
    const priceByTs = new Map(priceRows.map((row) => [row.ts, row]));
    const pricingConfig = getPricingConfig() || {};
    const pvCostCtKwh = Number(pricingConfig?.costs?.pvCtKwh);
    const batteryCostCtKwh = effectiveBatteryCostCtKwh(pricingConfig?.costs || {});

    const slots = energySlots
      .filter((slot) => {
        const localDate = localDateString(slot.ts);
        return localDate >= range.startDate && localDate < range.endDateExclusive;
      })
      .map((slot) => {
        const price = priceByTs.get(slot.ts) || {};
        const marketPriceCtKwh = Number.isFinite(Number(price.priceCtKwh)) ? Number(price.priceCtKwh) : null;
        const userImportPriceCtKwh = resolveUserImportPriceCtKwhForSlot({
          ts: slot.ts,
          ct_kwh: marketPriceCtKwh
        }, pricingConfig);
        const shares = proportionalSourceShares(slot);
        const localSelfConsumptionKwh = round2(Number(shares.pvShareKwh || 0) + Number(shares.batteryShareKwh || 0));
        const selfConsumptionKwh = round2(Number(shares.gridShareKwh || 0) + localSelfConsumptionKwh);
        const missingImportPrice = Number(slot.importKwh || 0) > 0 && !Number.isFinite(userImportPriceCtKwh);
        const missingMarketPrice = slot.exportKwh > 0 && !Number.isFinite(marketPriceCtKwh);
        const gridCostEur = costForShareEur(slot.importKwh, userImportPriceCtKwh);
        const pvCostEur = costForShareEur(shares.pvShareKwh, pvCostCtKwh);
        const batteryCostEur = costForShareEur(shares.batteryShareKwh, batteryCostCtKwh);
        const importCostEur = gridCostEur;
        const opportunityCostEur = costForShareEur(localSelfConsumptionKwh, marketPriceCtKwh);
        const selfConsumptionCostEur = round2((gridCostEur || 0) + (pvCostEur || 0) + (batteryCostEur || 0));
        const exportRevenueEur = missingMarketPrice ? null : round2((slot.exportKwh * Number(marketPriceCtKwh || 0)) / 100);
        const netEur = round2((exportRevenueEur || 0) - (selfConsumptionCostEur || 0));

        return {
          ...slot,
          ...shares,
          selfConsumptionKwh,
          marketPriceCtKwh,
          userImportPriceCtKwh,
          gridCostEur,
          pvCostEur,
          batteryCostEur,
          opportunityCostEur,
          selfConsumptionCostEur,
          importCostEur,
          exportRevenueEur,
          netEur,
          estimated: Boolean(slot.estimated),
          incomplete: Boolean(slot.incomplete) || missingImportPrice || missingMarketPrice
        };
      });

    const missingImportPriceSlots = slots.filter((slot) => slot.importKwh > 0 && !Number.isFinite(slot.userImportPriceCtKwh)).length;
    const missingMarketPriceSlots = slots.filter((slot) => slot.exportKwh > 0 && !Number.isFinite(slot.marketPriceCtKwh)).length;
    const incompleteSlots = slots.filter((slot) => slot.incomplete).length;
    const estimatedSlots = slots.filter((slot) => slot.estimated).length;
    const kpis = slots.reduce((totals, slot) => ({
      importKwh: round2(totals.importKwh + slot.importKwh),
      exportKwh: round2(totals.exportKwh + slot.exportKwh),
      loadKwh: round2(totals.loadKwh + Number(slot.loadKwh || 0)),
      pvKwh: round2(totals.pvKwh + Number(slot.pvKwh || 0)),
      batteryChargeKwh: round2(totals.batteryChargeKwh + Number(slot.batteryChargeKwh || 0)),
      batteryDischargeKwh: round2(totals.batteryDischargeKwh + Number(slot.batteryDischargeKwh || 0)),
      selfConsumptionKwh: round2(totals.selfConsumptionKwh + Number(slot.selfConsumptionKwh || 0)),
      gridShareKwh: round2(totals.gridShareKwh + Number(slot.gridShareKwh || 0)),
      pvShareKwh: round2(totals.pvShareKwh + Number(slot.pvShareKwh || 0)),
      batteryShareKwh: round2(totals.batteryShareKwh + Number(slot.batteryShareKwh || 0)),
      importCostEur: round2(totals.importCostEur + (slot.importCostEur || 0)),
      gridCostEur: round2(totals.gridCostEur + (slot.gridCostEur || 0)),
      pvCostEur: round2(totals.pvCostEur + (slot.pvCostEur || 0)),
      batteryCostEur: round2(totals.batteryCostEur + (slot.batteryCostEur || 0)),
      opportunityCostEur: round2(totals.opportunityCostEur + (slot.opportunityCostEur || 0)),
      selfConsumptionCostEur: round2(totals.selfConsumptionCostEur + (slot.selfConsumptionCostEur || 0)),
      exportRevenueEur: round2(totals.exportRevenueEur + (slot.exportRevenueEur || 0)),
      solarCompensationEur: 0,
      netEur: round2(totals.netEur + slot.netEur)
    }), {
      importKwh: 0,
      exportKwh: 0,
      loadKwh: 0,
      pvKwh: 0,
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
      opportunityCostEur: 0,
      selfConsumptionCostEur: 0,
      exportRevenueEur: 0,
      solarCompensationEur: 0,
      netEur: 0
    });
    const baseRows = summarizeRows(slots, view);
    const solarApplied = applySolarMarketValues({
      rows: baseRows,
      view,
      date,
      kpis,
      meta: {
        unresolved: {
          missingImportPriceSlots,
          missingMarketPriceSlots,
          incompleteSlots,
          estimatedSlots,
          slotCount: slots.length
        }
      },
      solarMarketValues: solarMarketValues || getSolarMarketValueSummary({
        year: parseDateOnly(startOfYear(date))?.year ?? parseDateOnly(currentBerlinDate())?.year
      })
    });
    const rows = solarApplied.rows;
    const charts = view === 'day'
      ? buildDayCharts(slots)
      : buildPeriodCharts(rows);

    return {
      view,
      date,
      range: {
        startDate: range.startDate,
        endDateExclusive: range.endDateExclusive,
        start,
        end
      },
      kpis: solarApplied.kpis,
      series: {
        financial: slots.map((slot) => ({
          ts: slot.ts,
          gridCostEur: slot.gridCostEur,
          pvCostEur: slot.pvCostEur,
          batteryCostEur: slot.batteryCostEur,
          opportunityCostEur: slot.opportunityCostEur,
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
      },
      charts,
      rows,
      slots,
      meta: solarApplied.meta
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
        return { status: 400, body: { ok: false, error: 'view must be one of day, week, month, year' } };
      }
      if (!isDateOnly(date)) {
        return { status: 400, body: { ok: false, error: 'date must use YYYY-MM-DD' } };
      }
      let solarMarketValues = null;
      if (view === 'year' && typeof getSolarMarketValueSummary === 'function') {
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
          ...historyRuntime.getSummary({ view, date, solarMarketValues }),
          app: appVersion
        }
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
      if (!start || !end) {
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
