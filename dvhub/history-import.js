const VRM_API_BASE = 'https://vrmapi.victronenergy.com';
const VRM_HISTORY_TYPES = ['venus', 'consumption', 'kwh'];
const VRM_HISTORY_INTERVAL = '15mins';
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
      samples: new Map()
    };
    slotBuckets.set(key, bucket);
  }
  return bucket;
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

function mapCanonicalRowsFromVrm({ bucket, type, code, rawValue, resolutionSeconds }) {
  const mappedMeta = {
    provenance: 'mapped_from_vrm',
    vrmType: type,
    vrmCode: code
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

  if (type === 'consumption' && code === 'Pc') {
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

  if (type === 'consumption' && code === 'Gc') {
    const value = kwhToAveragePower(rawValue, resolutionSeconds);
    addMappedFlowSample(bucket, {
      field: 'gridDirectUseW',
      value,
      meta: mappedMeta
    });
    return;
  }

  if (type === 'consumption' && code === 'Gb') {
    addMappedFlowSample(bucket, {
      field: 'gridToBatteryW',
      value: kwhToAveragePower(rawValue, resolutionSeconds),
      meta: mappedMeta
    });
    return;
  }

  if (type === 'consumption' && code === 'Bc') {
    addMappedFlowSample(bucket, {
      field: 'batteryDirectUseW',
      value: kwhToAveragePower(rawValue, resolutionSeconds),
      meta: mappedMeta
    });
    return;
  }

  if (type === 'consumption' && code === 'Bg') {
    addMappedFlowSample(bucket, {
      field: 'batteryToGridW',
      value: kwhToAveragePower(rawValue, resolutionSeconds),
      meta: mappedMeta
    });
    return;
  }

  if (type === 'consumption' && (code === 'Gs' || code === 'Pg')) {
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
  const flowValues = {
    solarDirectW: Number(bucket.values.solarDirectUseW || 0),
    solarToBatteryW: Number(bucket.values.solarToBatteryW || 0),
    solarToGridW: Number(bucket.values.solarToGridW || 0),
    gridDirectW: Number(bucket.values.gridDirectUseW || 0),
    gridToBatteryW: Number(bucket.values.gridToBatteryW || 0),
    batteryDirectW: Number(bucket.values.batteryDirectUseW || 0),
    batteryToGridW: Number(bucket.values.batteryToGridW || 0)
  };
  const directUseFieldsPresent = [
    Number.isFinite(bucket.values.solarDirectUseW),
    Number.isFinite(bucket.values.gridDirectUseW),
    Number.isFinite(bucket.values.batteryDirectUseW)
  ].filter(Boolean).length;

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

  if (Number.isFinite(bucket.values.batteryPowerW)) {
    if (!Number.isFinite(bucket.values.batteryChargeW) && bucket.values.batteryPowerW < 0) {
      setBucketField(bucket, 'batteryChargeW', Math.abs(bucket.values.batteryPowerW), {
        provenance: 'mapped_from_vrm',
        vrmType: 'kwh',
        vrmCode: 'Pb'
      });
    }
    if (!Number.isFinite(bucket.values.batteryDischargeW) && bucket.values.batteryPowerW > 0) {
      setBucketField(bucket, 'batteryDischargeW', bucket.values.batteryPowerW, {
        provenance: 'mapped_from_vrm',
        vrmType: 'kwh',
        vrmCode: 'Pb'
      });
    }
  }

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
    throw new Error(`VRM stats request failed for ${type}: HTTP ${response.status}`);
  }
  return response.json();
}

export function createHistoryImportManager({
  store,
  telemetryConfig = {},
  fetchImpl = globalThis.fetch,
  waitImpl = async () => {}
}) {
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

  async function importFromConfiguredSource({ start, end, interval = VRM_HISTORY_INTERVAL }) {
    const status = getStatus();
    if (!status.enabled) return { ok: false, error: 'history import disabled' };
    if (!status.ready) return { ok: false, error: 'history import not configured' };
    if (status.provider !== 'vrm') return { ok: false, error: 'automatic import currently supports provider vrm only' };
    if (!start || !end) return { ok: false, error: 'start and end are required for configured imports' };

    const importConfig = telemetryConfig.historyImport || {};
    const normalizedInterval = VRM_HISTORY_INTERVAL;
    const resolutionSeconds = intervalSeconds(normalizedInterval);
    const rawRows = [];
    const slotBuckets = new Map();

    for (const type of VRM_HISTORY_TYPES) {
      const payload = await fetchVrmStats({
        portalId: importConfig.vrmPortalId,
        token: importConfig.vrmToken,
        type,
        start,
        end,
        interval: normalizedInterval,
        fetchImpl
      });
      rawRows.push(...parseVrmSeries(type, payload.records || {}, resolutionSeconds));
      for (const [code, values] of Object.entries(payload.records || {})) {
        if (!Array.isArray(values)) continue;
        for (const item of values) {
          if (!Array.isArray(item) || item.length < 2) continue;
          const ts = toIso(item[0]);
          const bucket = getOrCreateSlotBucket(slotBuckets, ts, resolutionSeconds);
          mapCanonicalRowsFromVrm({
            bucket,
            type,
            code,
            rawValue: item[1],
            resolutionSeconds
          });
        }
      }
    }

    const canonicalRows = [...slotBuckets.values()].flatMap((bucket) => reconstructSlotBucket(bucket));
    const allRows = [...rawRows, ...canonicalRows];

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
      meta: { provider: 'vrm', interval: normalizedInterval, requestedInterval: interval, types: [...VRM_HISTORY_TYPES] }
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
    backfillMissingPriceHistory
  };
}
