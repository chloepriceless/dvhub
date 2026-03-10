const VRM_API_BASE = 'https://vrmapi.victronenergy.com';
const VRM_HISTORY_TYPES = ['venus', 'consumption', 'kwh'];
const VRM_HISTORY_INTERVAL = '15mins';
const VRM_HISTORY_SLOT_SECONDS = 900;
const VRM_BACKFILL_CHUNK_DAYS = 7;
const VRM_GAP_BACKFILL_LOOKBACK_DAYS = 7;
const VRM_GAP_BACKFILL_CHUNK_DAYS = 1;
const VRM_BACKFILL_EMPTY_WINDOW_LIMIT = 2;
const VRM_BACKFILL_DELAY_MS = 500;
const VRM_BACKFILL_RETRY_ATTEMPTS = 3;
const VRM_BACKFILL_RETRY_DELAY_MS = 1000;
const VRM_COVERAGE_JOB_TYPES = [
  'vrm_history_import',
  'vrm_history_backfill',
  'vrm_history_full_backfill',
  'vrm_history_gap_backfill'
];
const ENERGY_CHARTS_PRICE_API_BASE = 'https://api.energy-charts.info/price';
const PRICE_BUCKET_SECONDS = 900;

import {
  buildHistoricalPriceTelemetrySamples,
  buildHistoricalTelemetrySample
} from './telemetry-runtime.js';

const CORE_SLOT_FIELDS = [
  'loadPowerW',
  'pvTotalW',
  'gridImportW',
  'gridExportW',
  'batteryChargeW',
  'batteryDischargeW'
];

const FIELD_TO_SERIES = {
  loadPowerW: 'load_power_w',
  pvTotalW: 'pv_total_w',
  gridImportW: 'grid_import_w',
  gridExportW: 'grid_export_w',
  batteryChargeW: 'battery_charge_w',
  batteryDischargeW: 'battery_discharge_w',
  batteryPowerW: 'battery_power_w'
};

const FLOW_FIELD_TO_SERIES = {
  solarDirectUseW: 'solar_direct_use_w',
  solarToBatteryW: 'solar_to_battery_w',
  solarToGridW: 'solar_to_grid_w',
  gridDirectUseW: 'grid_direct_use_w',
  gridToBatteryW: 'grid_to_battery_w',
  batteryDirectUseW: 'battery_direct_use_w',
  batteryToGridW: 'battery_to_grid_w',
  selfConsumptionW: 'self_consumption_w'
};

const VRM_REFERENCE_FIELD_TO_SERIES = {
  vrmSolarYieldW: 'vrm_solar_yield_w',
  vrmSiteConsumptionW: 'vrm_site_consumption_w',
  vrmGridImportRefW: 'vrm_grid_import_ref_w',
  vrmGridExportRefW: 'vrm_grid_export_ref_w',
  vrmConsumptionInputW: 'vrm_consumption_input_w',
  vrmConsumptionOutputW: 'vrm_consumption_output_w'
};

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

function shiftIsoByDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString();
}

function compareIso(left, right) {
  return new Date(left).getTime() - new Date(right).getTime();
}

function mergeCoverageRanges(ranges = []) {
  const normalized = ranges
    .filter((range) => range?.start && range?.end && compareIso(range.start, range.end) < 0)
    .sort((left, right) => compareIso(left.start, right.start));
  const merged = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (!last || compareIso(range.start, last.end) > 0) {
      merged.push({ start: range.start, end: range.end });
      continue;
    }
    if (compareIso(range.end, last.end) > 0) last.end = range.end;
  }
  return merged;
}

function buildBackfillWindows({ start, end, chunkDays }) {
  const windows = [];
  const stepDays = Math.max(1, Number(chunkDays || 1));
  let cursor = toIso(start);
  const rangeEnd = toIso(end);
  while (compareIso(cursor, rangeEnd) < 0) {
    const next = shiftIsoByDays(cursor, stepDays);
    const windowEnd = compareIso(next, rangeEnd) < 0 ? next : rangeEnd;
    windows.push({
      start: cursor,
      end: windowEnd
    });
    cursor = windowEnd;
  }
  return windows;
}

function rangeIsCovered(window, ranges) {
  return ranges.some((range) => compareIso(range.start, window.start) <= 0 && compareIso(range.end, window.end) >= 0);
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
    const error = new Error(`Energy Charts price request failed for ${day}: HTTP ${response.status}`);
    error.status = Number(response.status);
    error.day = day;
    throw error;
  }
  return parseEnergyChartsPriceRows(await response.json());
}

async function fetchEnergyChartsDayWithRetry({
  bzn,
  day,
  fetchImpl,
  waitImpl,
  maxAttempts = 3,
  retryDelayMs = 250
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchEnergyChartsDay({ bzn, day, fetchImpl });
    } catch (error) {
      lastError = error;
      if (Number(error?.status) !== 429 || attempt >= maxAttempts) break;
      await waitImpl(retryDelayMs * attempt);
    }
  }
  throw lastError;
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

function kwhToAveragePower(value, resolutionSeconds) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return (numeric * 3600000) / Number(resolutionSeconds || 900);
}

function getOrCreateSlotBucket(slotBuckets, ts, resolutionSeconds) {
  const key = `${ts}:${resolutionSeconds}`;
  let bucket = slotBuckets.get(key);
  if (!bucket) {
    bucket = {
      ts,
      resolutionSeconds,
      values: {},
      metaByField: {},
      samples: new Map(),
      vrmAggregates: new Map()
    };
    slotBuckets.set(key, bucket);
  }
  return bucket;
}

function vrmAggregateMode(type, code) {
  if (type === 'venus' && code !== 'tsT') return 'power';
  if (type === 'consumption' || type === 'kwh') return 'energy';
  return null;
}

function getOrCreateVrmAggregate(bucket, type, code) {
  const key = `${type}:${code}`;
  let aggregate = bucket.vrmAggregates.get(key);
  if (!aggregate) {
    aggregate = {
      type,
      code,
      mode: vrmAggregateMode(type, code),
      sampleCount: 0,
      coverageSeconds: 0,
      weightedValueSeconds: 0,
      totalEnergyKwh: 0
    };
    bucket.vrmAggregates.set(key, aggregate);
  }
  return aggregate;
}

function accumulateVrmAggregate(bucket, { type, code, rawValue, durationSeconds }) {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) return;
  const aggregate = getOrCreateVrmAggregate(bucket, type, code);
  if (!aggregate.mode) return;
  aggregate.sampleCount += 1;
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    aggregate.coverageSeconds += durationSeconds;
  }
  if (aggregate.mode === 'power') {
    const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
    aggregate.weightedValueSeconds += numeric * seconds;
    return;
  }
  aggregate.totalEnergyKwh += numeric;
}

function addVrmValuesToSlotBuckets(slotBuckets, { type, code, values, slotResolutionSeconds }) {
  if (!Array.isArray(values) || !values.length) return;
  const sorted = values
    .filter((item) => Array.isArray(item) && item.length >= 2 && Number.isFinite(Number(item[0])) && Number.isFinite(Number(item[1])))
    .sort((left, right) => Number(left[0]) - Number(right[0]));
  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index];
    const currentMs = Number(item[0]);
    const slotStartIso = bucketIso(currentMs, slotResolutionSeconds);
    const slotEndMs = new Date(slotStartIso).getTime() + slotResolutionSeconds * 1000;
    const nextMs = index + 1 < sorted.length ? Number(sorted[index + 1][0]) : null;
    const boundedNextMs = Number.isFinite(nextMs) ? Math.min(nextMs, slotEndMs) : slotEndMs;
    const durationSeconds = Math.max(0, boundedNextMs - currentMs) / 1000;
    const bucket = getOrCreateSlotBucket(slotBuckets, slotStartIso, slotResolutionSeconds);
    accumulateVrmAggregate(bucket, {
      type,
      code,
      rawValue: item[1],
      durationSeconds
    });
  }
}

function setBucketField(bucket, field, value, meta) {
  if (!Number.isFinite(Number(value))) return;
  bucket.values[field] = Number(value);
  bucket.metaByField[field] = meta;
}

function extractVrmSources(meta) {
  if (!meta) return [];
  if (Array.isArray(meta.vrmSources)) {
    return meta.vrmSources
      .filter((item) => item && item.vrmType && item.vrmCode)
      .map((item) => ({ vrmType: item.vrmType, vrmCode: item.vrmCode }));
  }
  if (meta.vrmType && meta.vrmCode) {
    return [{ vrmType: meta.vrmType, vrmCode: meta.vrmCode }];
  }
  return [];
}

function addBucketSample(bucket, sample, field = null) {
  if (!sample?.seriesKey) return;
  bucket.samples.set(sample.seriesKey, sample);
  if (field) setBucketField(bucket, field, sample.value, sample.meta);
}

function addMappedCanonicalSample(bucket, { seriesKey, field = null, value, unit = 'W', meta }) {
  const sample = buildHistoricalTelemetrySample({
    seriesKey,
    ts: bucket.ts,
    value,
    unit,
    resolutionSeconds: bucket.resolutionSeconds,
    meta
  });
  addBucketSample(bucket, sample, field);
}

function addAccumulatedCanonicalSample(bucket, { seriesKey, field, value, unit = 'W', meta }) {
  const existingValue = Number(bucket.values[field]);
  if (!Number.isFinite(existingValue)) {
    addMappedCanonicalSample(bucket, { seriesKey, field, value, unit, meta });
    return;
  }
  const accumulatedValue = existingValue + Number(value || 0);
  const vrmSources = [...extractVrmSources(bucket.metaByField[field]), ...extractVrmSources(meta)];
  addMappedCanonicalSample(bucket, {
    seriesKey,
    field,
    value: accumulatedValue,
    unit,
    meta: {
      provenance: 'summed_from_vrm',
      vrmSources
    }
  });
}

function addMappedFlowSample(bucket, { field, value, meta }) {
  const seriesKey = FLOW_FIELD_TO_SERIES[field];
  if (!seriesKey) return;
  addMappedCanonicalSample(bucket, {
    seriesKey,
    field,
    value,
    meta
  });
}

function addMappedReferenceSample(bucket, { field, value, meta }) {
  const seriesKey = VRM_REFERENCE_FIELD_TO_SERIES[field];
  if (!seriesKey) return;
  addMappedCanonicalSample(bucket, {
    seriesKey,
    field,
    value,
    meta
  });
}

function mapBatterySamples(bucket, value, type, code) {
  const meta = {
    provenance: 'mapped_from_vrm',
    vrmType: type,
    vrmCode: code
  };
  addMappedCanonicalSample(bucket, {
    seriesKey: 'battery_power_w',
    field: 'batteryPowerW',
    value,
    meta
  });
  if (value >= 0) {
    addMappedCanonicalSample(bucket, {
      seriesKey: 'battery_discharge_w',
      field: 'batteryDischargeW',
      value,
      meta
    });
    addMappedCanonicalSample(bucket, {
      seriesKey: 'battery_charge_w',
      field: 'batteryChargeW',
      value: 0,
      meta
    });
    return;
  }
  addMappedCanonicalSample(bucket, {
    seriesKey: 'battery_charge_w',
    field: 'batteryChargeW',
    value: Math.abs(value),
    meta
  });
  addMappedCanonicalSample(bucket, {
    seriesKey: 'battery_discharge_w',
    field: 'batteryDischargeW',
    value: 0,
    meta
  });
}

function mapCanonicalRowsFromVrm({ bucket, type, code, rawValue, resolutionSeconds, meta: metaOverride = null }) {
  const mappedMeta = {
    provenance: 'mapped_from_vrm',
    vrmType: type,
    vrmCode: code,
    ...(metaOverride || {})
  };

  if (type === 'venus' && code === 'Pdc') {
    addAccumulatedCanonicalSample(bucket, {
      seriesKey: 'pv_total_w',
      field: 'pvTotalW',
      value: rawValue,
      meta: mappedMeta
    });
    return;
  }

  if (type === 'venus' && code === 'Pac') {
    addAccumulatedCanonicalSample(bucket, {
      seriesKey: 'pv_total_w',
      field: 'pvTotalW',
      value: rawValue,
      meta: mappedMeta
    });
    return;
  }

  if (type === 'venus' && code === 'solar_yield') {
    addMappedReferenceSample(bucket, {
      field: 'vrmSolarYieldW',
      value: rawValue,
      meta: mappedMeta
    });
    return;
  }

  if (type === 'venus' && code === 'consumption') {
    addMappedReferenceSample(bucket, {
      field: 'vrmSiteConsumptionW',
      value: rawValue,
      meta: mappedMeta
    });
    return;
  }

  if (type === 'venus' && code === 'ac_loads' && !Number.isFinite(bucket.values.vrmSiteConsumptionW)) {
    addMappedReferenceSample(bucket, {
      field: 'vrmSiteConsumptionW',
      value: rawValue,
      meta: mappedMeta
    });
    return;
  }

  if (type === 'venus' && code === 'consumption_input') {
    addMappedReferenceSample(bucket, {
      field: 'vrmConsumptionInputW',
      value: rawValue,
      meta: mappedMeta
    });
    return;
  }

  if (type === 'venus' && code === 'consumption_output') {
    addMappedReferenceSample(bucket, {
      field: 'vrmConsumptionOutputW',
      value: rawValue,
      meta: mappedMeta
    });
    return;
  }

  if (type === 'venus' && code === 'from_to_grid') {
    addMappedReferenceSample(bucket, {
      field: rawValue >= 0 ? 'vrmGridImportRefW' : 'vrmGridExportRefW',
      value: Math.abs(rawValue),
      meta: mappedMeta
    });
    return;
  }

  if ((type === 'consumption' || type === 'kwh') && code === 'Pc') {
    const value = kwhToAveragePower(rawValue, resolutionSeconds);
    addMappedFlowSample(bucket, {
      field: 'solarDirectUseW',
      value,
      meta: mappedMeta
    });
    return;
  }

  if (type === 'consumption' && code === 'Pb') {
    addMappedFlowSample(bucket, {
      field: 'solarToBatteryW',
      value: kwhToAveragePower(rawValue, resolutionSeconds),
      meta: mappedMeta
    });
    return;
  }

  if ((type === 'consumption' || type === 'kwh') && code === 'Gc') {
    const value = kwhToAveragePower(rawValue, resolutionSeconds);
    addMappedFlowSample(bucket, {
      field: 'gridDirectUseW',
      value,
      meta: mappedMeta
    });
    return;
  }

  if ((type === 'consumption' || type === 'kwh') && code === 'Gb') {
    addMappedFlowSample(bucket, {
      field: 'gridToBatteryW',
      value: kwhToAveragePower(rawValue, resolutionSeconds),
      meta: mappedMeta
    });
    return;
  }

  if ((type === 'consumption' || type === 'kwh') && code === 'Bc') {
    addMappedFlowSample(bucket, {
      field: 'batteryDirectUseW',
      value: kwhToAveragePower(rawValue, resolutionSeconds),
      meta: mappedMeta
    });
    return;
  }

  if ((type === 'consumption' || type === 'kwh') && code === 'Bg') {
    addMappedFlowSample(bucket, {
      field: 'batteryToGridW',
      value: kwhToAveragePower(rawValue, resolutionSeconds),
      meta: mappedMeta
    });
    return;
  }

  if ((type === 'consumption' || type === 'kwh') && (code === 'Gs' || code === 'Pg')) {
    const value = kwhToAveragePower(rawValue, resolutionSeconds);
    addMappedFlowSample(bucket, {
      field: 'solarToGridW',
      value,
      meta: mappedMeta
    });
    return;
  }

  if (type === 'kwh' && code === 'Pb') {
    mapBatterySamples(bucket, kwhToAveragePower(rawValue, resolutionSeconds), type, code);
  }
}

function positiveFinite(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric;
}

function allocateSourceTotal(total, candidates, remainingDemands) {
  const allocations = Object.fromEntries(candidates.map((candidate) => [candidate.field, 0]));
  let remaining = positiveFinite(total);
  for (let iteration = 0; iteration < 6 && remaining > 1e-9; iteration += 1) {
    const active = candidates.filter((candidate) => positiveFinite(remainingDemands[candidate.demandKey]) > 1e-9);
    if (!active.length) break;
    const weighted = active.map((candidate) => ({
      ...candidate,
      weight: positiveFinite(candidate.weight) > 0
        ? positiveFinite(candidate.weight)
        : positiveFinite(remainingDemands[candidate.demandKey])
    }));
    const totalWeight = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
    let allocated = 0;
    for (const candidate of weighted) {
      const share = totalWeight > 0
        ? remaining * (candidate.weight / totalWeight)
        : remaining / weighted.length;
      const amount = Math.min(share, positiveFinite(remainingDemands[candidate.demandKey]));
      allocations[candidate.field] += amount;
      remainingDemands[candidate.demandKey] = Math.max(0, positiveFinite(remainingDemands[candidate.demandKey]) - amount);
      allocated += amount;
    }
    if (allocated <= 1e-9) {
      const fallback = weighted[0];
      const amount = Math.min(remaining, positiveFinite(remainingDemands[fallback.demandKey]));
      allocations[fallback.field] += amount;
      remainingDemands[fallback.demandKey] = Math.max(0, positiveFinite(remainingDemands[fallback.demandKey]) - amount);
      allocated += amount;
    }
    remaining = Math.max(0, remaining - allocated);
  }
  return allocations;
}

function normalizeFlowValuesToVrmAnchors(flowValues, anchors) {
  const batteryCharge = Math.max(0, anchors.pv + anchors.import - anchors.load - anchors.export);
  const batteryDischarge = Math.max(0, anchors.load + anchors.export - anchors.pv - anchors.import);
  const remainingDemands = {
    load: anchors.load,
    export: anchors.export,
    charge: batteryCharge
  };
  const solar = allocateSourceTotal(anchors.pv, [
    { field: 'solarDirectW', demandKey: 'load', weight: flowValues.solarDirectW },
    { field: 'solarToGridW', demandKey: 'export', weight: flowValues.solarToGridW },
    { field: 'solarToBatteryW', demandKey: 'charge', weight: flowValues.solarToBatteryW }
  ], remainingDemands);
  const grid = allocateSourceTotal(anchors.import, [
    { field: 'gridDirectW', demandKey: 'load', weight: flowValues.gridDirectW },
    { field: 'gridToBatteryW', demandKey: 'charge', weight: flowValues.gridToBatteryW }
  ], remainingDemands);
  const battery = allocateSourceTotal(batteryDischarge, [
    { field: 'batteryDirectW', demandKey: 'load', weight: flowValues.batteryDirectW },
    { field: 'batteryToGridW', demandKey: 'export', weight: flowValues.batteryToGridW }
  ], remainingDemands);
  return {
    solarDirectW: positiveFinite(solar.solarDirectW),
    solarToBatteryW: positiveFinite(solar.solarToBatteryW),
    solarToGridW: positiveFinite(solar.solarToGridW),
    gridDirectW: positiveFinite(grid.gridDirectW),
    gridToBatteryW: positiveFinite(grid.gridToBatteryW),
    batteryDirectW: positiveFinite(battery.batteryDirectW),
    batteryToGridW: positiveFinite(battery.batteryToGridW)
  };
}

function deriveMissingField(values, field) {
  const load = values.loadPowerW;
  const pv = values.pvTotalW;
  const gridImport = values.gridImportW;
  const gridExport = values.gridExportW;
  const batteryCharge = values.batteryChargeW;
  const batteryDischarge = values.batteryDischargeW;

  switch (field) {
    case 'loadPowerW':
      if ([pv, batteryDischarge, gridImport, gridExport, batteryCharge].every(Number.isFinite)) {
        return pv + batteryDischarge + gridImport - gridExport - batteryCharge;
      }
      return null;
    case 'pvTotalW':
      if ([load, batteryDischarge, gridImport, gridExport, batteryCharge].every(Number.isFinite)) {
        return load - batteryDischarge - gridImport + gridExport + batteryCharge;
      }
      return null;
    case 'gridImportW':
      if ([load, pv, batteryDischarge, gridExport, batteryCharge].every(Number.isFinite)) {
        return load - pv - batteryDischarge + gridExport + batteryCharge;
      }
      return null;
    case 'gridExportW':
      if ([pv, batteryDischarge, gridImport, batteryCharge, load].every(Number.isFinite)) {
        return pv + batteryDischarge + gridImport - batteryCharge - load;
      }
      return null;
    case 'batteryChargeW':
      if ([pv, batteryDischarge, gridImport, gridExport, load].every(Number.isFinite)) {
        return pv + batteryDischarge + gridImport - gridExport - load;
      }
      return null;
    case 'batteryDischargeW':
      if ([load, pv, gridImport, gridExport, batteryCharge].every(Number.isFinite)) {
        return load - pv - gridImport + gridExport + batteryCharge;
      }
      return null;
    default:
      return null;
  }
}

function reconstructSlotBucket(bucket) {
  let flowValues = {
    solarDirectW: Number(bucket.values.solarDirectUseW || 0),
    solarToBatteryW: Number(bucket.values.solarToBatteryW || 0),
    solarToGridW: Number(bucket.values.solarToGridW || 0),
    gridDirectW: Number(bucket.values.gridDirectUseW || 0),
    gridToBatteryW: Number(bucket.values.gridToBatteryW || 0),
    batteryDirectW: Number(bucket.values.batteryDirectUseW || 0),
    batteryToGridW: Number(bucket.values.batteryToGridW || 0)
  };
  const vrmAnchors = {
    pv: positiveFinite(bucket.values.vrmSolarYieldW),
    load: positiveFinite(bucket.values.vrmSiteConsumptionW),
    import: positiveFinite(bucket.values.vrmGridImportRefW),
    export: positiveFinite(bucket.values.vrmGridExportRefW)
  };
  const hasVrmAnchors = vrmAnchors.pv > 0 || vrmAnchors.load > 0 || vrmAnchors.import > 0 || vrmAnchors.export > 0;

  if (hasVrmAnchors) {
    flowValues = normalizeFlowValuesToVrmAnchors(flowValues, vrmAnchors);
    const normalizedMeta = {
      provenance: 'normalized_from_vrm_reference',
      derivedFrom: [
        'vrm_solar_yield_w',
        'vrm_site_consumption_w',
        'vrm_grid_import_ref_w',
        'vrm_grid_export_ref_w'
      ]
    };
    addMappedFlowSample(bucket, {
      field: 'solarDirectUseW',
      value: flowValues.solarDirectW,
      meta: normalizedMeta
    });
    addMappedFlowSample(bucket, {
      field: 'solarToBatteryW',
      value: flowValues.solarToBatteryW,
      meta: normalizedMeta
    });
    addMappedFlowSample(bucket, {
      field: 'solarToGridW',
      value: flowValues.solarToGridW,
      meta: normalizedMeta
    });
    addMappedFlowSample(bucket, {
      field: 'gridDirectUseW',
      value: flowValues.gridDirectW,
      meta: normalizedMeta
    });
    addMappedFlowSample(bucket, {
      field: 'gridToBatteryW',
      value: flowValues.gridToBatteryW,
      meta: normalizedMeta
    });
    addMappedFlowSample(bucket, {
      field: 'batteryDirectUseW',
      value: flowValues.batteryDirectW,
      meta: normalizedMeta
    });
    addMappedFlowSample(bucket, {
      field: 'batteryToGridW',
      value: flowValues.batteryToGridW,
      meta: normalizedMeta
    });
  }

  const directUseFieldsPresent = [
    Number.isFinite(bucket.values.solarDirectUseW),
    Number.isFinite(bucket.values.gridDirectUseW),
    Number.isFinite(bucket.values.batteryDirectUseW)
  ].filter(Boolean).length;

  if (hasVrmAnchors) {
    addMappedCanonicalSample(bucket, {
      seriesKey: 'load_power_w',
      field: 'loadPowerW',
      value: vrmAnchors.load > 0 ? vrmAnchors.load : flowValues.solarDirectW + flowValues.gridDirectW + flowValues.batteryDirectW,
      meta: {
        provenance: 'mapped_from_vrm_reference',
        derivedFrom: ['vrm_site_consumption_w']
      }
    });
    addMappedCanonicalSample(bucket, {
      seriesKey: 'grid_import_w',
      field: 'gridImportW',
      value: vrmAnchors.import,
      meta: {
        provenance: 'mapped_from_vrm_reference',
        derivedFrom: ['vrm_grid_import_ref_w']
      }
    });
    addMappedCanonicalSample(bucket, {
      seriesKey: 'grid_export_w',
      field: 'gridExportW',
      value: vrmAnchors.export,
      meta: {
        provenance: 'mapped_from_vrm_reference',
        derivedFrom: ['vrm_grid_export_ref_w']
      }
    });
    addMappedCanonicalSample(bucket, {
      seriesKey: 'pv_total_w',
      field: 'pvTotalW',
      value: vrmAnchors.pv,
      meta: {
        provenance: 'mapped_from_vrm_reference',
        derivedFrom: ['vrm_solar_yield_w']
      }
    });
    addMappedCanonicalSample(bucket, {
      seriesKey: 'battery_charge_w',
      field: 'batteryChargeW',
      value: flowValues.solarToBatteryW + flowValues.gridToBatteryW,
      meta: {
        provenance: 'derived_from_vrm_flows',
        derivedFrom: ['solar_to_battery_w', 'grid_to_battery_w']
      }
    });
    addMappedCanonicalSample(bucket, {
      seriesKey: 'battery_discharge_w',
      field: 'batteryDischargeW',
      value: flowValues.batteryDirectW + flowValues.batteryToGridW,
      meta: {
        provenance: 'derived_from_vrm_flows',
        derivedFrom: ['battery_direct_use_w', 'battery_to_grid_w']
      }
    });
  }

  if (!Number.isFinite(bucket.values.loadPowerW)) {
    const loadPower = flowValues.solarDirectW + flowValues.gridDirectW + flowValues.batteryDirectW;
    if (loadPower > 0 && directUseFieldsPresent >= 2) {
      addMappedCanonicalSample(bucket, {
        seriesKey: 'load_power_w',
        field: 'loadPowerW',
        value: loadPower,
        meta: {
          provenance: 'derived_from_vrm_flows',
          derivedFrom: ['solar_direct_use_w', 'grid_direct_use_w', 'battery_direct_use_w']
        }
      });
    }
  }

  if (!Number.isFinite(bucket.values.gridImportW)) {
    const gridImport = flowValues.gridDirectW + flowValues.gridToBatteryW;
    if (gridImport > 0) {
      addMappedCanonicalSample(bucket, {
        seriesKey: 'grid_import_w',
        field: 'gridImportW',
        value: gridImport,
        meta: {
          provenance: 'derived_from_vrm_flows',
          derivedFrom: ['grid_direct_use_w', 'grid_to_battery_w']
        }
      });
    }
  }

  if (!Number.isFinite(bucket.values.gridExportW)) {
    const gridExport = flowValues.solarToGridW + flowValues.batteryToGridW;
    if (gridExport > 0) {
      addMappedCanonicalSample(bucket, {
        seriesKey: 'grid_export_w',
        field: 'gridExportW',
        value: gridExport,
        meta: {
          provenance: 'derived_from_vrm_flows',
          derivedFrom: ['solar_to_grid_w', 'battery_to_grid_w']
        }
      });
    }
  }

  if (!Number.isFinite(bucket.values.batteryChargeW)) {
    const batteryCharge = flowValues.solarToBatteryW + flowValues.gridToBatteryW;
    if (batteryCharge > 0) {
      addMappedCanonicalSample(bucket, {
        seriesKey: 'battery_charge_w',
        field: 'batteryChargeW',
        value: batteryCharge,
        meta: {
          provenance: 'derived_from_vrm_flows',
          derivedFrom: ['solar_to_battery_w', 'grid_to_battery_w']
        }
      });
    }
  }

  if (!Number.isFinite(bucket.values.batteryDischargeW)) {
    const batteryDischarge = flowValues.batteryDirectW + flowValues.batteryToGridW;
    if (batteryDischarge > 0) {
      addMappedCanonicalSample(bucket, {
        seriesKey: 'battery_discharge_w',
        field: 'batteryDischargeW',
        value: batteryDischarge,
        meta: {
          provenance: 'derived_from_vrm_flows',
          derivedFrom: ['battery_direct_use_w', 'battery_to_grid_w']
        }
      });
    }
  }

  if (!Number.isFinite(bucket.values.pvTotalW)) {
    const pvTotal = flowValues.solarDirectW + flowValues.solarToBatteryW + flowValues.solarToGridW;
    if (pvTotal > 0) {
      addMappedCanonicalSample(bucket, {
        seriesKey: 'pv_total_w',
        field: 'pvTotalW',
        value: pvTotal,
        meta: {
          provenance: 'derived_from_vrm_flows',
          derivedFrom: ['solar_direct_use_w', 'solar_to_battery_w', 'solar_to_grid_w']
        }
      });
    }
  }

  addMappedFlowSample(bucket, {
    field: 'selfConsumptionW',
    value: directUseFieldsPresent >= 2
      ? flowValues.solarDirectW + flowValues.gridDirectW + flowValues.batteryDirectW
      : null,
    meta: {
      provenance: 'derived_from_vrm_flows',
      derivedFrom: ['solar_direct_use_w', 'grid_direct_use_w', 'battery_direct_use_w']
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const field of CORE_SLOT_FIELDS) {
      if (Number.isFinite(bucket.values[field])) continue;
      const derived = deriveMissingField(bucket.values, field);
      if (!Number.isFinite(derived)) continue;
      const seriesKey = FIELD_TO_SERIES[field];
      const meta = {
        provenance: 'estimated',
        derivedFrom: CORE_SLOT_FIELDS
          .filter((candidate) => candidate !== field && Number.isFinite(bucket.values[candidate]))
          .map((candidate) => FIELD_TO_SERIES[candidate])
      };
      addBucketSample(bucket, buildHistoricalTelemetrySample({
        seriesKey,
        ts: bucket.ts,
        value: derived,
        unit: 'W',
        resolutionSeconds: bucket.resolutionSeconds,
        meta
      }), field);
      changed = true;
    }
  }

  if (Number.isFinite(bucket.values.batteryChargeW) || Number.isFinite(bucket.values.batteryDischargeW)) {
    const batteryPower = Number(bucket.values.batteryDischargeW || 0) - Number(bucket.values.batteryChargeW || 0);
    if (!bucket.samples.has('battery_power_w')) {
      addBucketSample(bucket, buildHistoricalTelemetrySample({
        seriesKey: 'battery_power_w',
        ts: bucket.ts,
        value: batteryPower,
        unit: 'W',
        resolutionSeconds: bucket.resolutionSeconds,
        meta: {
          provenance: 'estimated',
          derivedFrom: ['battery_discharge_w', 'battery_charge_w']
        }
      }), 'batteryPowerW');
    }
  }

  const incomplete = CORE_SLOT_FIELDS.some((field) => !Number.isFinite(bucket.values[field]));
  return [...bucket.samples.values()].map((sample) => ({
    ...sample,
    meta: {
      ...(sample.meta || {}),
      incomplete
    }
  }));
}

function finalizeVrmSlotBucket(bucket) {
  for (const aggregate of bucket.vrmAggregates.values()) {
    if (!aggregate.mode || aggregate.sampleCount <= 0) continue;
    const aggregateMeta = {
      sampleCount: aggregate.sampleCount,
      coverageSeconds: aggregate.coverageSeconds,
      slotNormalized: true
    };
    if (aggregate.mode === 'power') {
      const averagePowerW = aggregate.weightedValueSeconds / Number(bucket.resolutionSeconds || VRM_HISTORY_SLOT_SECONDS);
      if (!Number.isFinite(averagePowerW)) continue;
      mapCanonicalRowsFromVrm({
        bucket,
        type: aggregate.type,
        code: aggregate.code,
        rawValue: averagePowerW,
        resolutionSeconds: bucket.resolutionSeconds,
        meta: aggregateMeta
      });
      continue;
    }
    mapCanonicalRowsFromVrm({
      bucket,
      type: aggregate.type,
      code: aggregate.code,
      rawValue: aggregate.totalEnergyKwh,
      resolutionSeconds: bucket.resolutionSeconds,
      meta: aggregateMeta
    });
  }
  return reconstructSlotBucket(bucket);
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

      if (type === 'venus' && code === 'Pac') {
        pushSeriesRow(rows, {
          seriesKey: 'pv_ac_w',
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
    const error = new Error(`VRM stats request failed for ${type}: HTTP ${response.status}`);
    error.status = Number(response.status);
    error.type = type;
    error.start = toIso(start);
    error.end = toIso(end);
    throw error;
  }
  return response.json();
}

async function fetchVrmStatsWithRetry({
  portalId,
  token,
  type,
  start,
  end,
  interval,
  fetchImpl,
  waitImpl,
  maxAttempts = VRM_BACKFILL_RETRY_ATTEMPTS,
  retryDelayMs = VRM_BACKFILL_RETRY_DELAY_MS
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchVrmStats({
        portalId,
        token,
        type,
        start,
        end,
        interval,
        fetchImpl
      });
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt >= maxAttempts) break;
      await waitImpl(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

export function createHistoryImportManager({
  store,
  telemetryConfig = {},
  fetchImpl = globalThis.fetch,
  waitImpl = async () => {}
}) {
  let vrmBackfillPromise = null;

  function getStatus() {
    const importConfig = telemetryConfig.historyImport || {};
    const provider = 'vrm';
    const ready = Boolean(importConfig.vrmPortalId && importConfig.vrmToken);

    return {
      enabled: Boolean(importConfig.enabled),
      provider,
      mode: 'vrm_only',
      ready,
      vrmPortalId: importConfig.vrmPortalId || '',
      backfillRunning: Boolean(vrmBackfillPromise)
    };
  }

  function validateConfiguredVrmImport({ start = null, end = null, requireRange = true } = {}) {
    const status = getStatus();
    if (!status.enabled) return { ok: false, error: 'history import disabled' };
    if (!status.ready) return { ok: false, error: 'history import not configured' };
    if (status.provider !== 'vrm') return { ok: false, error: 'automatic import currently supports provider vrm only' };
    if (requireRange && (!start || !end)) return { ok: false, error: 'start and end are required for configured imports' };
    return { ok: true, status };
  }

  function listCompletedCoverageRanges({ start, end }) {
    const importConfig = telemetryConfig.historyImport || {};
    const rows = typeof store.listImportJobRanges === 'function'
      ? store.listImportJobRanges({
        jobTypes: VRM_COVERAGE_JOB_TYPES,
        statuses: ['completed'],
        sourceAccount: importConfig.vrmPortalId || null,
        requestedFrom: start,
        requestedTo: end
      })
      : [];
    return mergeCoverageRanges(rows.map((row) => ({
      start: row.requestedFrom,
      end: row.requestedTo
    })));
  }

  function collectGapWindows({
    now = null,
    lookbackDays = VRM_GAP_BACKFILL_LOOKBACK_DAYS,
    chunkDays = VRM_GAP_BACKFILL_CHUNK_DAYS
  } = {}) {
    const rangeEnd = now ? toIso(now) : new Date().toISOString();
    const rangeStart = shiftIsoByDays(rangeEnd, -Math.max(1, Number(lookbackDays || VRM_GAP_BACKFILL_LOOKBACK_DAYS)));
    const coverage = listCompletedCoverageRanges({
      start: rangeStart,
      end: rangeEnd
    });
    const windows = buildBackfillWindows({
      start: rangeStart,
      end: rangeEnd,
      chunkDays
    });
    return {
      requestedFrom: rangeStart,
      requestedTo: rangeEnd,
      coverage,
      windows,
      gapWindows: windows.filter((window) => !rangeIsCovered(window, coverage))
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

  async function fetchConfiguredVrmRows({ start, end, interval = VRM_HISTORY_INTERVAL }) {
    const validation = validateConfiguredVrmImport({ start, end, requireRange: true });
    if (!validation.ok) return validation;
    const importConfig = telemetryConfig.historyImport || {};
    const normalizedInterval = VRM_HISTORY_INTERVAL;
    const resolutionSeconds = intervalSeconds(normalizedInterval);
    const rawRows = [];
    const slotBuckets = new Map();

    for (const type of VRM_HISTORY_TYPES) {
      const payload = await fetchVrmStatsWithRetry({
        portalId: importConfig.vrmPortalId,
        token: importConfig.vrmToken,
        type,
        start,
        end,
        interval: normalizedInterval,
        fetchImpl,
        waitImpl
      });
      const records = payload.records || {};
      rawRows.push(...parseVrmSeries(type, records, resolutionSeconds));
      for (const [code, values] of Object.entries(records)) {
        addVrmValuesToSlotBuckets(slotBuckets, {
          type,
          code,
          values,
          slotResolutionSeconds: VRM_HISTORY_SLOT_SECONDS
        });
      }
    }

    const canonicalRows = [...slotBuckets.values()].flatMap((bucket) => finalizeVrmSlotBucket(bucket));
    const allRows = [...rawRows, ...canonicalRows];

    return {
      ok: true,
      provider: 'vrm',
      normalizedInterval,
      requestedInterval: interval,
      requestedFrom: toIso(start),
      requestedTo: toIso(end),
      rows: allRows,
      seriesCount: new Set(allRows.map((row) => row.seriesKey)).size
    };
  }

  async function importFromConfiguredSource({ start, end, interval = VRM_HISTORY_INTERVAL }) {
    const fetched = await fetchConfiguredVrmRows({ start, end, interval });
    if (!fetched.ok) return fetched;
    const allRows = fetched.rows || [];

    if (!allRows.length) {
      return { ok: false, error: 'no importable rows returned from VRM' };
    }

    store.writeSamples(allRows);
    const importConfig = telemetryConfig.historyImport || {};
    const jobId = store.writeImportJob({
      jobType: 'vrm_history_import',
      status: 'completed',
      requestedFrom: fetched.requestedFrom,
      requestedTo: fetched.requestedTo,
      importedRows: allRows.length,
      sourceAccount: importConfig.vrmPortalId,
      meta: {
        provider: 'vrm',
        interval: fetched.normalizedInterval,
        requestedInterval: fetched.requestedInterval,
        types: [...VRM_HISTORY_TYPES]
      }
    });

    return {
      ok: true,
      provider: fetched.provider,
      jobId,
      importedRows: allRows.length,
      seriesCount: fetched.seriesCount
    };
  }

  async function runVrmFullBackfill({
    now = null,
    chunkDays = VRM_BACKFILL_CHUNK_DAYS,
    delayMs = VRM_BACKFILL_DELAY_MS,
    maxEmptyWindows = VRM_BACKFILL_EMPTY_WINDOW_LIMIT,
    interval = VRM_HISTORY_INTERVAL,
    auto = false
  } = {}) {
    const validation = validateConfiguredVrmImport({ requireRange: false });
    if (!validation.ok) return validation;

    let cursorEnd = now ? toIso(now) : new Date().toISOString();
    let windowsVisited = 0;
    let importedWindows = 0;
    let trailingEmptyWindows = 0;
    let importedRows = 0;
    let requestedFrom = null;
    const requestedTo = cursorEnd;

    while (trailingEmptyWindows < maxEmptyWindows) {
      const windowEnd = cursorEnd;
      const windowStart = shiftIsoByDays(windowEnd, -Math.max(1, Number(chunkDays || VRM_BACKFILL_CHUNK_DAYS)));
      requestedFrom = windowStart;
      windowsVisited += 1;

      const fetched = await fetchConfiguredVrmRows({
        start: windowStart,
        end: windowEnd,
        interval
      });
      if (!fetched.ok) return fetched;

      if ((fetched.rows || []).length > 0) {
        store.writeSamples(fetched.rows);
        importedWindows += 1;
        importedRows += fetched.rows.length;
        trailingEmptyWindows = 0;
      } else {
        trailingEmptyWindows += 1;
      }

      cursorEnd = windowStart;
      if (trailingEmptyWindows >= maxEmptyWindows) break;
      await waitImpl(delayMs);
    }

    const importConfig = telemetryConfig.historyImport || {};
    const jobId = store.writeImportJob({
      jobType: 'vrm_history_full_backfill',
      status: 'completed',
      requestedFrom,
      requestedTo,
      importedRows,
      sourceAccount: importConfig.vrmPortalId,
      meta: {
        provider: 'vrm',
        interval,
        auto,
        mode: 'full',
        chunkDays,
        maxEmptyWindows,
        windowsVisited,
        importedWindows,
        emptyWindows: trailingEmptyWindows
      }
    });

    return {
      ok: true,
      partial: false,
      provider: 'vrm',
      auto,
      mode: 'full',
      jobId,
      requestedFrom,
      requestedTo,
      windowsVisited,
      importedWindows,
      emptyWindows: trailingEmptyWindows,
      importedRows
    };
  }

  async function runVrmGapBackfill({
    now = null,
    lookbackDays = VRM_GAP_BACKFILL_LOOKBACK_DAYS,
    chunkDays = VRM_GAP_BACKFILL_CHUNK_DAYS,
    delayMs = VRM_BACKFILL_DELAY_MS,
    interval = VRM_HISTORY_INTERVAL,
    auto = false
  } = {}) {
    const validation = validateConfiguredVrmImport({ requireRange: false });
    if (!validation.ok) return validation;

    const plan = collectGapWindows({ now, lookbackDays, chunkDays });
    const { requestedFrom, requestedTo, gapWindows } = plan;
    if (!gapWindows.length) {
      return {
        ok: true,
        partial: false,
        provider: 'vrm',
        auto,
        mode: 'gap',
        jobId: null,
        requestedFrom,
        requestedTo,
        windowsVisited: 0,
        importedWindows: 0,
        emptyWindows: 0,
        importedRows: 0
      };
    }

    let importedWindows = 0;
    let importedRows = 0;
    let emptyWindows = 0;

    for (let index = 0; index < gapWindows.length; index += 1) {
      const window = gapWindows[index];
      const fetched = await fetchConfiguredVrmRows({
        start: window.start,
        end: window.end,
        interval
      });
      if (!fetched.ok) return fetched;

      if ((fetched.rows || []).length > 0) {
        store.writeSamples(fetched.rows);
        importedWindows += 1;
        importedRows += fetched.rows.length;
      } else {
        emptyWindows += 1;
      }

      if (index + 1 < gapWindows.length) {
        await waitImpl(delayMs);
      }
    }

    const importConfig = telemetryConfig.historyImport || {};
    const status = emptyWindows > 0 ? 'completed_with_gaps' : 'completed';
    const jobId = store.writeImportJob({
      jobType: 'vrm_history_gap_backfill',
      status,
      requestedFrom,
      requestedTo,
      importedRows,
      sourceAccount: importConfig.vrmPortalId,
      meta: {
        provider: 'vrm',
        interval,
        auto,
        mode: 'gap',
        chunkDays,
        lookbackDays,
        windowsVisited: gapWindows.length,
        importedWindows,
        emptyWindows,
        coverageWindows: plan.windows.length,
        coveredWindows: plan.windows.length - gapWindows.length
      }
    });

    return {
      ok: true,
      partial: emptyWindows > 0,
      provider: 'vrm',
      auto,
      mode: 'gap',
      jobId,
      requestedFrom,
      requestedTo,
      windowsVisited: gapWindows.length,
      importedWindows,
      emptyWindows,
      importedRows
    };
  }

  async function backfillHistoryFromConfiguredSource(options = {}) {
    const mode = options.mode === 'full' ? 'full' : 'gap';
    if (vrmBackfillPromise) {
      return {
        ok: false,
        error: 'vrm history backfill already running'
      };
    }
    vrmBackfillPromise = mode === 'full'
      ? runVrmFullBackfill(options)
      : runVrmGapBackfill(options);
    try {
      return await vrmBackfillPromise;
    } finally {
      vrmBackfillPromise = null;
    }
  }

  function startAutomaticBackfill(options = {}) {
    const status = getStatus();
    if (!status.enabled || !status.ready || vrmBackfillPromise) {
      return {
        ok: false,
        started: false
      };
    }
    const plan = collectGapWindows(options);
    if (!plan.gapWindows.length) {
      return {
        ok: true,
        started: false
      };
    }
    vrmBackfillPromise = runVrmGapBackfill({ auto: true, ...options })
      .catch((error) => ({
        ok: false,
        auto: true,
        error: error?.message || String(error)
      }))
      .finally(() => {
        vrmBackfillPromise = null;
      });
    return {
      ok: true,
      started: true
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
    const openDays = [];
    const errors = [];

    for (const day of days) {
      try {
        const rows = await fetchEnergyChartsDayWithRetry({
          bzn,
          day,
          fetchImpl,
          waitImpl
        });
        for (const row of rows) {
          if (!missingSet.has(bucketIso(row.ts))) continue;
          matchedRows.push(row);
        }
      } catch (error) {
        openDays.push(day);
        errors.push(error?.message || String(error));
      }
    }

    const historyRows = buildHistoricalPriceTelemetrySamples(matchedRows);
    if (historyRows.length) store.writeSamples(historyRows);

    const skippedBuckets = Math.max(0, missingBuckets.length - matchedRows.length);
    const partial = openDays.length > 0 && historyRows.length > 0;
    const ok = openDays.length === 0 || partial;
    const jobId = store.writeImportJob({
      jobType: 'price_backfill',
      status: ok ? (partial ? 'completed_with_gaps' : 'completed') : 'failed',
      requestedFrom: rangeStart,
      requestedTo: rangeEnd,
      importedRows: historyRows.length,
      sourceAccount: bzn,
      meta: {
        provider: 'energy_charts',
        requestedDays: days,
        matchedBuckets: matchedRows.length,
        skippedBuckets,
        openDays,
        errors
      }
    });

    return {
      ok,
      partial,
      jobId,
      requestedDays: days.length,
      matchedBuckets: matchedRows.length,
      importedRows: historyRows.length,
      skippedBuckets,
      days,
      openDays,
      error: errors.length ? errors.join('; ') : null
    };
  }

  return {
    getStatus,
    importSamples,
    importFromConfiguredSource,
    backfillHistoryFromConfiguredSource,
    startAutomaticBackfill,
    backfillMissingPriceHistory
  };
}
