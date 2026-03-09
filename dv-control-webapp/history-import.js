const VRM_API_BASE = 'https://vrmapi.victronenergy.com';
const VRM_HISTORY_TYPES = ['venus', 'consumption', 'kwh'];

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

  return {
    getStatus,
    importSamples,
    importFromConfiguredSource
  };
}
