import { resolveUserImportPriceCtKwhForSlot } from './config-model.js';

const BERLIN_TIME_ZONE = 'Europe/Berlin';
const SUPPORTED_VIEWS = new Set(['day', 'week', 'month', 'year']);
const SLOT_BUCKET_SECONDS = 900;

function round2(value) {
  const numeric = Number(value || 0);
  const sign = numeric < 0 ? -1 : 1;
  return sign * (Math.round((Math.abs(numeric) + Number.EPSILON) * 100) / 100);
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
    importCostEur: 0,
    exportRevenueEur: 0,
    netEur: 0,
    slotCount: 0,
    incompleteSlots: 0
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
    row.importCostEur = round2(row.importCostEur + (slot.importCostEur || 0));
    row.exportRevenueEur = round2(row.exportRevenueEur + (slot.exportRevenueEur || 0));
    row.netEur = round2(row.exportRevenueEur - row.importCostEur);
    row.slotCount += 1;
    if (slot.incomplete) row.incompleteSlots += 1;
    groups.set(key, row);
  }
  return [...groups.values()];
}

export function createHistoryRuntime({ store, getPricingConfig = () => ({}) }) {
  function getSummary({ view = 'day', date }) {
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

        const missingImportPrice = slot.importKwh > 0 && !Number.isFinite(userImportPriceCtKwh);
        const missingMarketPrice = slot.exportKwh > 0 && !Number.isFinite(marketPriceCtKwh);
        const importCostEur = missingImportPrice ? null : round2((slot.importKwh * Number(userImportPriceCtKwh || 0)) / 100);
        const exportRevenueEur = missingMarketPrice ? null : round2((slot.exportKwh * Number(marketPriceCtKwh || 0)) / 100);
        const netEur = round2((exportRevenueEur || 0) - (importCostEur || 0));

        return {
          ...slot,
          marketPriceCtKwh,
          userImportPriceCtKwh,
          importCostEur,
          exportRevenueEur,
          netEur,
          incomplete: missingImportPrice || missingMarketPrice
        };
      });

    const missingImportPriceSlots = slots.filter((slot) => slot.importKwh > 0 && !Number.isFinite(slot.userImportPriceCtKwh)).length;
    const missingMarketPriceSlots = slots.filter((slot) => slot.exportKwh > 0 && !Number.isFinite(slot.marketPriceCtKwh)).length;
    const kpis = slots.reduce((totals, slot) => ({
      importKwh: round2(totals.importKwh + slot.importKwh),
      exportKwh: round2(totals.exportKwh + slot.exportKwh),
      importCostEur: round2(totals.importCostEur + (slot.importCostEur || 0)),
      exportRevenueEur: round2(totals.exportRevenueEur + (slot.exportRevenueEur || 0)),
      netEur: round2(totals.netEur + slot.netEur)
    }), {
      importKwh: 0,
      exportKwh: 0,
      importCostEur: 0,
      exportRevenueEur: 0,
      netEur: 0
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
      kpis,
      series: {
        financial: slots.map((slot) => ({
          ts: slot.ts,
          importCostEur: slot.importCostEur,
          exportRevenueEur: slot.exportRevenueEur,
          netEur: slot.netEur
        })),
        energy: slots.map((slot) => ({
          ts: slot.ts,
          importKwh: slot.importKwh,
          exportKwh: slot.exportKwh
        })),
        prices: slots.map((slot) => ({
          ts: slot.ts,
          marketPriceCtKwh: slot.marketPriceCtKwh,
          userImportPriceCtKwh: slot.userImportPriceCtKwh
        }))
      },
      rows: summarizeRows(slots, view),
      slots,
      meta: {
        unresolved: {
          missingImportPriceSlots,
          missingMarketPriceSlots,
          incompleteSlots: missingImportPriceSlots + missingMarketPriceSlots,
          slotCount: slots.length
        }
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
  defaultBzn = 'DE-LU'
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
      return { status: 200, body: historyRuntime.getSummary({ view, date }) };
    },
    async postPriceBackfill(body = {}) {
      if (!telemetryEnabled || !historyImportManager) {
        return { status: 503, body: { ok: false, error: 'internal telemetry store disabled' } };
      }
      const result = await historyImportManager.backfillMissingPriceHistory({
        bzn: String(body.bzn || defaultBzn),
        start: body.start ?? body.requestedFrom ?? null,
        end: body.end ?? body.requestedTo ?? null
      });
      return { status: result.ok ? 200 : 400, body: result };
    }
  };
}
