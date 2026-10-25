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

export function buildHistoricalTelemetrySample({
  seriesKey,
  ts,
  value,
  unit,
  resolutionSeconds = 900,
  source = 'vrm_import',
  quality = 'backfilled',
  meta = null,
  scope = 'history'
} = {}) {
  const rows = [];
  pushSample(rows, seriesKey, value, unit, {
    ts,
    resolutionSeconds,
    scope,
    source,
    quality,
    meta
  });
  return rows[0] || null;
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

export function buildLiveTelemetrySamples({ ts, resolutionSeconds, meter = {}, victron = {}, managed = null }) {
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
  // Inc 2 (Last-Separation): house load minus positively confirmed controllable
  // load, so the forecast stops learning EV/device draw that EOS then adds again.
  // The decision AND its log event live in server.js `onPollComplete` (this builder
  // is a pure mapper with no logger); `managed.exManagedW` is the finished result and
  // already equals the raw value whenever nothing qualified. null -> pushSample skips,
  // which is the correct behaviour when the raw load itself was unusable.
  pushSample(rows, 'load_power_w_ex_managed', managed?.exManagedW, 'W', base);
  pushSample(rows, 'self_consumption_w', victron.selfConsumptionW, 'W', base);
  pushSample(rows, 'solar_direct_use_w', victron.solarDirectUseW, 'W', base);
  pushSample(rows, 'solar_to_battery_w', victron.solarToBatteryW, 'W', base);
  pushSample(rows, 'solar_to_grid_w', victron.solarToGridW, 'W', base);
  pushSample(rows, 'grid_direct_use_w', victron.gridDirectUseW, 'W', base);
  pushSample(rows, 'grid_to_battery_w', victron.gridToBatteryW, 'W', base);
  pushSample(rows, 'battery_direct_use_w', victron.batteryDirectUseW, 'W', base);
  pushSample(rows, 'battery_to_grid_w', victron.batteryToGridW, 'W', base);
  // Akku der zweiten GX-Anlage als eigene Reihen (21.10.2026, Chrissi: „kannst
  // die Akkus dort getrennt aufzeigen“). polling.js setzt die Felder auf null,
  // solange keine zweite Anlage einbezogen ist → pushSample ueberspringt sie,
  // ohne zweite Anlage entsteht also keine einzige neue Zeile.
  pushSample(rows, 'second_battery_charge_w', victron.secondBatteryChargeW, 'W', base);
  pushSample(rows, 'second_battery_discharge_w', victron.secondBatteryDischargeW, 'W', base);
  pushSample(rows, 'second_solar_to_battery_w', victron.secondSolarToBatteryW, 'W', base);
  pushSample(rows, 'second_grid_to_battery_w', victron.secondGridToBatteryW, 'W', base);
  pushSample(rows, 'second_battery_to_grid_w', victron.secondBatteryToGridW, 'W', base);
  pushSample(rows, 'second_battery_direct_use_w', victron.secondBatteryDirectUseW, 'W', base);
  pushSample(rows, 'second_battery_soc_pct', victron.secondBatterySocPct, '%', base);
  // Akku→Akku-Verschiebung (gegenlaeufige Akkus), ebenfalls nur mit zweiter Anlage.
  pushSample(rows, 'battery_to_second_battery_w', victron.batteryToSecondBatteryW, 'W', base);
  pushSample(rows, 'second_battery_to_battery_w', victron.secondBatteryToBatteryW, 'W', base);
  pushSample(rows, 'grid_setpoint_w', victron.gridSetpointW, 'W', base);
  pushSample(rows, 'min_soc_pct', victron.minSocPct, '%', base);

  return rows;
}

export function buildPriceTelemetrySamples(rows, options = {}) {
  return rows.flatMap((row) => {
    const ts = new Date(Number(row.ts)).toISOString();
    const base = {
      ts,
      resolutionSeconds: Number(row.resolutionSeconds || options.resolutionSeconds || 3600),
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

export function buildHistoricalPriceTelemetrySamples(rows, options = {}) {
  // Zeilen duerfen ihren eigenen Stempel mitbringen (row.resolutionSeconds, aus
  // priceRowSpacingSeconds): vor dem 01.10.2025 war der Day-Ahead stuendlich
  // und wurde trotzdem pauschal als 900 s gestempelt.
  return buildPriceTelemetrySamples(rows, {
    resolutionSeconds: 900,
    scope: 'history',
    source: 'price_backfill',
    quality: 'backfilled',
    ...options
  });
}

const PRICE_QUARTER_MS = 900 * 1000;
const PRICE_HOUR_MS = 3600 * 1000;

function priceTsMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/**
 * Stempel je Preiszeile aus dem echten Abstand zu den Nachbarzeilen: 3600 fuer
 * Stundenpreise (volle Stunde, naechster Nachbar >= 1 h weg), sonst 900. Zeilen
 * mit `ts` (Epoch-ms oder ISO). Ueber die VOLLSTAENDIG geholten Zeilen rechnen,
 * nicht ueber eine ausgeduennte Auswahl.
 */
export function priceRowSpacingSeconds(rows) {
  const times = rows.map((row) => priceTsMs(Number.isFinite(Number(row.ts)) ? Number(row.ts) : row.ts));
  const sorted = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
  const position = new Map(sorted.map((ms, index) => [ms, index]));
  return times.map((ms) => {
    const index = position.get(ms);
    if (index == null) return 900;
    const gaps = [];
    if (index > 0) gaps.push(ms - sorted[index - 1]);
    if (index + 1 < sorted.length) gaps.push(sorted[index + 1] - ms);
    if (!gaps.length) return 900;
    return Math.min(...gaps) >= PRICE_HOUR_MS && ms % PRICE_HOUR_MS === 0 ? 3600 : 900;
  });
}

/**
 * true, wenn die Preiszeile bei `ms` ein Stundenpreis ist: volle UTC-Stunde und
 * die naechste Nachbarzeile derselben Reihe liegt mindestens eine Stunde weg.
 * Ohne Nachbarn entscheidet der Stempel. Der Stempel allein taugt nicht: der
 * Preis-Backfill stempelte Stundenpreise mit 900 s, epex-fetch.js bis Maerz 2026
 * 15-min-Preise mit 3600 s. Dieselbe Regel steht als SQL in
 * telemetry-store-pg.js (listMissingPriceBuckets).
 */
function isHourlyPriceRow(ms, prevMs, nextMs, maxResolutionSeconds) {
  if (!Number.isFinite(ms) || ms % PRICE_HOUR_MS !== 0) return false;
  const gaps = [];
  if (Number.isFinite(prevMs)) gaps.push(ms - prevMs);
  if (Number.isFinite(nextMs)) gaps.push(nextMs - ms);
  if (!gaps.length) return Number(maxResolutionSeconds) >= 3600;
  return Math.min(...gaps) >= PRICE_HOUR_MS;
}

/** Zeitraum, den die Preisabfragen zusaetzlich lesen muessen (Stunde davor/danach). */
export const PRICE_COVERAGE_PAD_MS = PRICE_HOUR_MS;

/**
 * Ergaenzt Stundenpreis-Zeilen um Kopien fuer :15, :30 und :45 ihrer Stunde,
 * damit jede Viertelstunde einen Preis findet. Zeilen: { series_key, ts_utc,
 * resolution_seconds, value_num } wie aus den Stores. Die Kopien tragen
 * ts_utc als ISO-String; die Gewichtung (resolution_seconds) bleibt gleich.
 * Die Zeilen sollten eine Stunde vor und nach dem gewuenschten Bereich
 * enthalten (PRICE_COVERAGE_PAD_MS), sonst fehlen Nachbarn am Rand.
 */
export function expandHourlyPriceRows(rows) {
  const bySeries = new Map();
  for (const row of rows || []) {
    const ms = priceTsMs(row.ts_utc);
    if (!Number.isFinite(ms)) continue;
    const key = row.series_key ?? '';
    let byTs = bySeries.get(key);
    if (!byTs) { byTs = new Map(); bySeries.set(key, byTs); }
    const list = byTs.get(ms) || [];
    list.push(row);
    byTs.set(ms, list);
  }
  const out = [...(rows || [])];
  for (const byTs of bySeries.values()) {
    const times = [...byTs.keys()].sort((a, b) => a - b);
    for (let index = 0; index < times.length; index += 1) {
      const ms = times[index];
      const group = byTs.get(ms);
      const maxResolution = Math.max(...group.map((row) => Number(row.resolution_seconds) || 0));
      if (!isHourlyPriceRow(ms, times[index - 1], times[index + 1], maxResolution)) continue;
      for (let quarter = 1; quarter < 4; quarter += 1) {
        const ts = new Date(ms + quarter * PRICE_QUARTER_MS).toISOString();
        for (const row of group) out.push({ ...row, ts_utc: ts });
      }
    }
  }
  return out;
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
