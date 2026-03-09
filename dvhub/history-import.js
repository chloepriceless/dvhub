const VRM_API_BASE = 'https://vrmapi.victronenergy.com';
const VRM_HISTORY_TYPES = ['venus', 'consumption', 'kwh'];
const ENERGY_CHARTS_PRICE_API_BASE = 'https://api.energy-charts.info/price';
const PRICE_BUCKET_SECONDS = 900;

import { buildHistoricalPriceTelemetrySamples } from './telemetry-runtime.js';

function toIso(value) {
  return new Date(value).toISOString();
}

function toEpochSeconds(value) {
  return Math.floor(new Date(value).getTime() / 1000);
}

function intervalSeconds(interval = '15mins') {
  const map = {
    '15mins': 900,
    hours: 3600,
    '2hours': 7200,
    days: 86400
  };
  return map[interval] || 900;
}

function berlinDateString(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function addDays(dateString, days) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function bucketIso(value, seconds = PRICE_BUCKET_SECONDS) {
  const bucketMs = seconds * 1000;
  const date = new Date(value);
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
}

function parseEnergyChartsPriceRows(payload = {}) {
  const unix = Array.isArray(payload?.unix_seconds) ? payload.unix_seconds : [];
  const prices = Array.isArray(payload?.price) ? payload.price : [];
  const count = Math.min(unix.length, prices.length);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const seconds = Number(unix[index]);
    const eurMwh = Number(prices[index]);
    if (!Number.isFinite(seconds) || !Number.isFinite(eurMwh)) continue;
    rows.push({
      ts: seconds * 1000,
      eur_mwh: eurMwh,
      ct_kwh: eurMwh / 10
    });
  }
  return rows;
}

async function fetchEnergyChartsDay({ bzn, day, fetchImpl }) {
  const nextDay = addDays(day, 1);
  const params = new URLSearchParams({
    bzn,
    start: day,
    end: nextDay
  });
  const response = await fetchImpl(`${ENERGY_CHARTS_PRICE_API_BASE}?${params.toString()}`, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Energy Charts price request failed for ${day}: HTTP ${response.status}`);
  }
  return parseEnergyChartsPriceRows(await response.json());
}

function pushSeriesRow(rows, entry) {
  if (entry.value == null) return;
  const value = Number(entry.value);
  if (!Number.isFinite(value)) return;
  rows.push({
    seriesKey: entry.seriesKey,
    ts: entry.ts,
    value,
    unit: entry.unit ?? null,
    resolutionSeconds: Number(entry.resolutionSeconds || 900),
    scope: entry.scope || 'history',
    source: entry.source || 'vrm_import',
    quality: entry.quality || 'backfilled',
    meta: entry.meta || null
  });
}

function parseVrmSeries(type, records, resolutionSeconds) {
  const rows = [];
  for (const [code, values] of Object.entries(records || {})) {
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const ts = toIso(item[0]);
      const value = item[1];
      pushSeriesRow(rows, {
        seriesKey: `vrm_${type}_${code}`,
        ts,
        value,
        unit: type === 'venus' ? (code === 'tsT' ? 'C' : 'W') : 'kWh',
        resolutionSeconds,
        meta: item.length > 2 ? { extra: item.slice(2) } : null
      });

      if (type === 'venus' && code === 'Pdc') {
        pushSeriesRow(rows, {
          seriesKey: 'pv_dc_w',
          ts,
          value,
          unit: 'W',
          resolutionSeconds
        });
      }

      if (type === 'venus' && code === 'tsT') {
        pushSeriesRow(rows, {
          seriesKey: 'temperature_c',
          ts,
          value,
          unit: 'C',
          resolutionSeconds,
          meta: item.length > 3 ? { min: item[2], max: item[3] } : null
        });
      }
    }
  }
  return rows;
}

async function fetchVrmStats({ portalId, token, type, start, end, interval, fetchImpl }) {
  const params = new URLSearchParams({
    type,
    start: String(toEpochSeconds(start)),
    end: String(toEpochSeconds(end)),
    interval
  });
  const url = `${VRM_API_BASE}/v2/installations/${encodeURIComponent(portalId)}/stats?${params.toString()}`;
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'x-authorization': `Token ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`VRM stats request failed for ${type}: HTTP ${response.status}`);
  }
  return response.json();
}

export function createHistoryImportManager({ store, telemetryConfig = {}, fetchImpl = globalThis.fetch }) {
  function getStatus() {
    const importConfig = telemetryConfig.historyImport || {};
    const provider = 'vrm';
    const ready = Boolean(importConfig.vrmPortalId && importConfig.vrmToken);

    return {
      enabled: Boolean(importConfig.enabled),
      provider,
      mode: 'vrm_only',
      ready,
      vrmPortalId: importConfig.vrmPortalId || ''
    };
  }

  function importSamples({ provider = 'vrm', rows = [], requestedFrom = null, requestedTo = null, sourceAccount = null }) {
    const cleaned = rows
      .filter((row) => row && row.seriesKey && row.ts != null && row.value != null)
      .map((row) => ({
        seriesKey: row.seriesKey,
        ts: row.ts,
        value: row.value,
        unit: row.unit ?? null,
        resolutionSeconds: Number(row.resolutionSeconds || 3600),
        scope: row.scope || 'history',
        source: `${provider}_import`,
        quality: 'backfilled',
        meta: row.meta || null
      }));

    if (!cleaned.length) {
      return {
        ok: false,
        importedRows: 0,
        error: 'rows array with valid samples required'
      };
    }

    store.writeSamples(cleaned);
    const jobId = store.writeImportJob({
      jobType: `${provider}_history_import`,
      status: 'completed',
      requestedFrom,
      requestedTo,
      importedRows: cleaned.length,
      sourceAccount,
      meta: { provider, mode: 'manual' }
    });

    return {
      ok: true,
      jobId,
      importedRows: cleaned.length
    };
  }

  async function importFromConfiguredSource({ start, end, interval = '15mins' }) {
    const status = getStatus();
    if (!status.enabled) return { ok: false, error: 'history import disabled' };
    if (!status.ready) return { ok: false, error: 'history import not configured' };
    if (status.provider !== 'vrm') return { ok: false, error: 'automatic import currently supports provider vrm only' };
    if (!start || !end) return { ok: false, error: 'start and end are required for configured imports' };

    const importConfig = telemetryConfig.historyImport || {};
    const resolutionSeconds = intervalSeconds(interval);
    const allRows = [];

    for (const type of VRM_HISTORY_TYPES) {
      const payload = await fetchVrmStats({
        portalId: importConfig.vrmPortalId,
        token: importConfig.vrmToken,
        type,
        start,
        end,
        interval,
        fetchImpl
      });
      allRows.push(...parseVrmSeries(type, payload.records || {}, resolutionSeconds));
    }

    if (!allRows.length) {
      return { ok: false, error: 'no importable rows returned from VRM' };
    }

    store.writeSamples(allRows);
    const jobId = store.writeImportJob({
      jobType: 'vrm_history_import',
      status: 'completed',
      requestedFrom: toIso(start),
      requestedTo: toIso(end),
      importedRows: allRows.length,
      sourceAccount: importConfig.vrmPortalId,
      meta: { provider: 'vrm', interval, types: [...VRM_HISTORY_TYPES] }
    });

    return {
      ok: true,
      provider: 'vrm',
      jobId,
      importedRows: allRows.length,
      seriesCount: new Set(allRows.map((row) => row.seriesKey)).size
    };
  }

  async function backfillMissingPriceHistory({ bzn = 'DE-LU', start = null, end = null, seriesKeys } = {}) {
    const bounds = store.getTelemetryBounds();
    const rangeStart = start ? toIso(start) : bounds.earliest;
    const rangeEnd = end
      ? toIso(end)
      : bounds.latest
        ? new Date(new Date(bounds.latest).getTime() + PRICE_BUCKET_SECONDS * 1000).toISOString()
        : null;

    if (!rangeStart || !rangeEnd) {
      return {
        ok: true,
        requestedDays: 0,
        matchedBuckets: 0,
        importedRows: 0,
        skippedBuckets: 0,
        days: []
      };
    }

    const missingBuckets = store.listMissingPriceBuckets({
      start: rangeStart,
      end: rangeEnd,
      seriesKeys
    });
    if (!missingBuckets.length) {
      return {
        ok: true,
        requestedDays: 0,
        matchedBuckets: 0,
        importedRows: 0,
        skippedBuckets: 0,
        days: []
      };
    }

    const missingSet = new Set(missingBuckets.map((ts) => bucketIso(ts)));
    const days = [...new Set(missingBuckets.map((ts) => berlinDateString(ts)))].sort();
    const matchedRows = [];

    for (const day of days) {
      const rows = await fetchEnergyChartsDay({ bzn, day, fetchImpl });
      for (const row of rows) {
        if (!missingSet.has(bucketIso(row.ts))) continue;
        matchedRows.push(row);
      }
    }

    const historyRows = buildHistoricalPriceTelemetrySamples(matchedRows);
    if (historyRows.length) store.writeSamples(historyRows);

    const skippedBuckets = Math.max(0, missingBuckets.length - matchedRows.length);
    const jobId = store.writeImportJob({
      jobType: 'price_backfill',
      status: 'completed',
      requestedFrom: rangeStart,
      requestedTo: rangeEnd,
      importedRows: historyRows.length,
      sourceAccount: bzn,
      meta: {
        provider: 'energy_charts',
        requestedDays: days,
        matchedBuckets: matchedRows.length,
        skippedBuckets
      }
    });

    return {
      ok: true,
      jobId,
      requestedDays: days.length,
      matchedBuckets: matchedRows.length,
      importedRows: historyRows.length,
      skippedBuckets,
      days
    };
  }

  return {
    getStatus,
    importSamples,
    importFromConfiguredSource,
    backfillMissingPriceHistory
  };
}
