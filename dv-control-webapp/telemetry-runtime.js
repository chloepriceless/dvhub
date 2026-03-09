import path from 'node:path';

function pushSample(rows, seriesKey, value, unit, base = {}) {
  if (value == null) return;
  const num = Number(value);
  if (!Number.isFinite(num)) return;
  rows.push({
    seriesKey,
    value: num,
    unit,
    scope: base.scope || 'live',
    source: base.source || 'local_poll',
    quality: base.quality || 'raw',
    ts: base.ts || new Date().toISOString(),
    resolutionSeconds: Number(base.resolutionSeconds || 1),
    meta: base.meta || null
  });
}

export function resolveTelemetryDbPath({ configPath, telemetryConfig = {}, dataDir }) {
  if (telemetryConfig.dbPath) return String(telemetryConfig.dbPath);
  let baseDir = dataDir;
  if (!baseDir) {
    baseDir = String(configPath).startsWith('/etc/')
      ? '/var/lib/dvhub'
      : path.join(path.dirname(configPath), 'data');
  }
  return path.join(baseDir, 'telemetry.sqlite');
}

export function buildLiveTelemetrySamples({ ts, resolutionSeconds, meter = {}, victron = {} }) {
  const rows = [];
  const base = {
    ts,
    resolutionSeconds,
    scope: 'live',
    source: 'local_poll',
    quality: 'raw'
  };

  pushSample(rows, 'grid_l1_w', meter.grid_l1_w, 'W', base);
  pushSample(rows, 'grid_l2_w', meter.grid_l2_w, 'W', base);
  pushSample(rows, 'grid_l3_w', meter.grid_l3_w, 'W', base);
  pushSample(rows, 'grid_total_w', meter.grid_total_w, 'W', base);
  pushSample(rows, 'grid_import_w', victron.gridImportW, 'W', base);
  pushSample(rows, 'grid_export_w', victron.gridExportW, 'W', base);
  pushSample(rows, 'battery_soc_pct', victron.soc, '%', base);
  pushSample(rows, 'battery_power_w', victron.batteryPowerW, 'W', base);
  pushSample(rows, 'battery_charge_w', victron.batteryChargeW, 'W', base);
  pushSample(rows, 'battery_discharge_w', victron.batteryDischargeW, 'W', base);
  pushSample(rows, 'pv_dc_w', victron.pvPowerW, 'W', base);
  pushSample(rows, 'pv_ac_l1_w', victron.acPvL1W, 'W', base);
  pushSample(rows, 'pv_ac_l2_w', victron.acPvL2W, 'W', base);
  pushSample(rows, 'pv_ac_l3_w', victron.acPvL3W, 'W', base);
  pushSample(rows, 'pv_total_w', victron.pvTotalW, 'W', base);
  pushSample(rows, 'load_power_w', victron.selfConsumptionW, 'W', base);
  pushSample(rows, 'grid_setpoint_w', victron.gridSetpointW, 'W', base);
  pushSample(rows, 'min_soc_pct', victron.minSocPct, '%', base);

  return rows;
}

export function buildPriceTelemetrySamples(rows, options = {}) {
  return rows.flatMap((row) => {
    const ts = new Date(Number(row.ts)).toISOString();
    const base = {
      ts,
      resolutionSeconds: Number(options.resolutionSeconds || 3600),
      scope: options.scope || 'forecast',
      source: options.source || 'price_api',
      quality: options.quality || 'raw'
    };
    const out = [];
    pushSample(out, 'price_eur_mwh', row.eur_mwh, 'EUR/MWh', base);
    pushSample(out, 'price_ct_kwh', row.ct_kwh, 'ct/kWh', base);
    return out;
  });
}

const OPTIMIZER_TARGET_MAP = {
  gridSetpointW: { seriesKey: 'grid_setpoint_w', unit: 'W' },
  chargeCurrentA: { seriesKey: 'charge_current_a', unit: 'A' },
  minSocPct: { seriesKey: 'min_soc_pct', unit: '%' }
};

export function buildOptimizerRunPayload({ optimizer, body, source, ts = new Date().toISOString() }) {
  const series = [];
  for (const [key, meta] of Object.entries(OPTIMIZER_TARGET_MAP)) {
    const value = Number(body?.[key]);
    if (!Number.isFinite(value)) continue;
    series.push({
      seriesKey: meta.seriesKey,
      scope: 'output',
      ts,
      resolutionSeconds: 3600,
      value,
      unit: meta.unit
    });
  }

  return {
    optimizer,
    status: 'applied',
    source,
    inputJson: null,
    resultJson: body || {},
    series
  };
}
