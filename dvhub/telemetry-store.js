import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function isoTimestamp(input = new Date()) {
  if (input instanceof Date) return input.toISOString();
  return new Date(input).toISOString();
}

function floorToInterval(date, seconds) {
  const bucketMs = seconds * 1000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

const DEFAULT_PRICE_BUCKET_SECONDS = 900;
const MATERIALIZED_SLOT_BUCKET_SECONDS = 900;
const DEFAULT_TELEMETRY_BACKFILL_SERIES = [
  'grid_import_w',
  'grid_export_w',
  'grid_total_w',
  'pv_total_w',
  'battery_power_w'
];
const MATERIALIZED_ENERGY_SERIES = new Set([
  'grid_import_w',
  'grid_export_w',
  'grid_total_w',
  'pv_total_w',
  'pv_ac_w',
  'battery_power_w',
  'battery_charge_w',
  'battery_discharge_w',
  'load_power_w',
  'vrm_solar_yield_w',
  'vrm_site_consumption_w',
  'vrm_grid_import_ref_w',
  'vrm_grid_export_ref_w',
  'vrm_consumption_input_w',
  'vrm_consumption_output_w',
  'self_consumption_w',
  'solar_direct_use_w',
  'solar_to_battery_w',
  'solar_to_grid_w',
  'grid_direct_use_w',
  'grid_to_battery_w',
  'battery_direct_use_w',
  'battery_to_grid_w'
]);

function roundKwh(value) {
  const numeric = Number(value || 0);
  const sign = numeric < 0 ? -1 : 1;
  return sign * (Math.round((Math.abs(numeric) + Number.EPSILON) * 100) / 100);
}

function bucketIso(ts, seconds) {
  return floorToInterval(new Date(ts), seconds).toISOString();
}

function energyKwhForSample(value, resolutionSeconds) {
  const numeric = Number(value);
  const seconds = Number(resolutionSeconds || 0);
  if (!Number.isFinite(numeric) || !Number.isFinite(seconds) || seconds <= 0) return null;
  return (numeric * seconds) / 3600000;
}

function weightedAverage(entries) {
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const entry of entries) {
    const value = Number(entry.value_num);
    const weight = Number(entry.resolution_seconds || 1);
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) continue;
    weightedTotal += value * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;
  return weightedTotal / totalWeight;
}

function parseMetaJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeMaterializedMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const estimated = meta.estimated === true || meta.provenance === 'estimated';
  const incomplete = meta.incomplete === true;
  if (!estimated && !incomplete) return null;
  return {
    estimated,
    incomplete
  };
}

function mergeMaterializedMeta(current, incoming) {
  const left = normalizeMaterializedMeta(current);
  const right = normalizeMaterializedMeta(incoming);
  if (!left && !right) return null;
  return {
    estimated: Boolean(left?.estimated || right?.estimated),
    incomplete: Boolean(left?.incomplete || right?.incomplete)
  };
}

function isCompleteHistoricalSolarMarketValueYear({ year, monthlyKeys = [], annualKeys = [] }) {
  const numericYear = Number(year);
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isInteger(numericYear) || numericYear >= currentYear) return false;
  return monthlyKeys.length >= 12 && annualKeys.includes(String(numericYear));
}

export function createTelemetryStore({ dbPath, rawRetentionDays = 45, rollupIntervals = [300, 900, 3600] }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeseries_samples (
      id INTEGER PRIMARY KEY,
      series_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      quality TEXT NOT NULL,
      ts_utc TEXT NOT NULL,
      resolution_seconds INTEGER NOT NULL,
      value_num REAL,
      value_text TEXT,
      unit TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(series_key, scope, source, quality, ts_utc, resolution_seconds)
    );
    CREATE INDEX IF NOT EXISTS idx_timeseries_series_ts ON timeseries_samples(series_key, ts_utc);
    CREATE INDEX IF NOT EXISTS idx_timeseries_scope_ts ON timeseries_samples(scope, ts_utc);

    CREATE TABLE IF NOT EXISTS control_events (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      target TEXT,
      value_num REAL,
      value_text TEXT,
      reason TEXT,
      source TEXT NOT NULL,
      ts_utc TEXT NOT NULL,
      meta_json TEXT
    );

    CREATE TABLE IF NOT EXISTS schedule_snapshots (
      id INTEGER PRIMARY KEY,
      ts_utc TEXT NOT NULL,
      rules_json TEXT NOT NULL,
      default_grid_setpoint_w REAL,
      default_charge_current_a REAL,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS optimizer_runs (
      id INTEGER PRIMARY KEY,
      optimizer TEXT NOT NULL,
      run_started_at TEXT NOT NULL,
      run_finished_at TEXT,
      status TEXT NOT NULL,
      input_json TEXT,
      result_json TEXT,
      source TEXT NOT NULL,
      external_run_id TEXT
    );

    CREATE TABLE IF NOT EXISTS optimizer_run_series (
      id INTEGER PRIMARY KEY,
      optimizer_run_id INTEGER NOT NULL,
      series_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      ts_utc TEXT NOT NULL,
      resolution_seconds INTEGER NOT NULL,
      value_num REAL,
      unit TEXT,
      FOREIGN KEY(optimizer_run_id) REFERENCES optimizer_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS import_jobs (
      id INTEGER PRIMARY KEY,
      job_type TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      requested_from TEXT,
      requested_to TEXT,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      source_account TEXT,
      meta_json TEXT
    );

    CREATE TABLE IF NOT EXISTS data_gaps (
      id INTEGER PRIMARY KEY,
      series_key TEXT NOT NULL,
      gap_start TEXT NOT NULL,
      gap_end TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      status TEXT NOT NULL,
      fill_source TEXT
    );

    CREATE TABLE IF NOT EXISTS energy_slots_15m (
      id INTEGER PRIMARY KEY,
      slot_start_utc TEXT NOT NULL,
      series_key TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      quality TEXT NOT NULL,
      value_num REAL,
      unit TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slot_start_utc, series_key, source_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_energy_slots_15m_slot_start ON energy_slots_15m(slot_start_utc);

    CREATE TABLE IF NOT EXISTS solar_market_values (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      ct_kwh REAL NOT NULL,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      last_attempt_at TEXT,
      cooldown_until TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      UNIQUE(scope, key)
    );
    CREATE INDEX IF NOT EXISTS idx_solar_market_values_scope_key ON solar_market_values(scope, key);

    CREATE TABLE IF NOT EXISTS solar_market_value_year_attempts (
      year INTEGER PRIMARY KEY,
      last_attempt_at TEXT NOT NULL,
      cooldown_until TEXT,
      status TEXT NOT NULL,
      error TEXT
    );
  `);

  const insertSampleStmt = db.prepare(`
    INSERT INTO timeseries_samples (
      series_key, scope, source, quality, ts_utc, resolution_seconds, value_num, value_text, unit, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(series_key, scope, source, quality, ts_utc, resolution_seconds)
    DO UPDATE SET value_num=excluded.value_num, value_text=excluded.value_text, unit=excluded.unit, meta_json=excluded.meta_json
  `);
  const insertControlEventStmt = db.prepare(`
    INSERT INTO control_events (event_type, target, value_num, value_text, reason, source, ts_utc, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertScheduleSnapshotStmt = db.prepare(`
    INSERT INTO schedule_snapshots (ts_utc, rules_json, default_grid_setpoint_w, default_charge_current_a, source)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertOptimizerRunStmt = db.prepare(`
    INSERT INTO optimizer_runs (optimizer, run_started_at, run_finished_at, status, input_json, result_json, source, external_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOptimizerSeriesStmt = db.prepare(`
    INSERT INTO optimizer_run_series (optimizer_run_id, series_key, scope, ts_utc, resolution_seconds, value_num, unit)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertImportJobStmt = db.prepare(`
    INSERT INTO import_jobs (job_type, started_at, finished_at, status, requested_from, requested_to, imported_rows, source_account, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAccumulatedEnergySlotStmt = db.prepare(`
    INSERT INTO energy_slots_15m (
      slot_start_utc, series_key, source_kind, quality, value_num, unit, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot_start_utc, series_key, source_kind)
    DO UPDATE SET
      quality=excluded.quality,
      value_num=COALESCE(energy_slots_15m.value_num, 0) + COALESCE(excluded.value_num, 0),
      unit=excluded.unit,
      meta_json=excluded.meta_json,
      updated_at=CURRENT_TIMESTAMP
  `);
  const insertReplacedEnergySlotStmt = db.prepare(`
    INSERT INTO energy_slots_15m (
      slot_start_utc, series_key, source_kind, quality, value_num, unit, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot_start_utc, series_key, source_kind)
    DO UPDATE SET
      quality=excluded.quality,
      value_num=excluded.value_num,
      unit=excluded.unit,
      meta_json=excluded.meta_json,
      updated_at=CURRENT_TIMESTAMP
  `);
  const upsertSolarMarketValueStmt = db.prepare(`
    INSERT INTO solar_market_values (
      scope, key, ct_kwh, source, fetched_at, last_attempt_at, cooldown_until, status, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, key)
    DO UPDATE SET
      ct_kwh=excluded.ct_kwh,
      source=excluded.source,
      fetched_at=excluded.fetched_at,
      last_attempt_at=excluded.last_attempt_at,
      cooldown_until=excluded.cooldown_until,
      status=excluded.status,
      error=excluded.error
  `);
  const getSolarMarketValueStmt = db.prepare(`
    SELECT scope, key, ct_kwh, source, fetched_at, last_attempt_at, cooldown_until, status, error
    FROM solar_market_values
    WHERE scope = ? AND key = ?
  `);
  const listSolarMarketValuesForYearStmt = db.prepare(`
    SELECT scope, key, ct_kwh, source, fetched_at, last_attempt_at, cooldown_until, status, error
    FROM solar_market_values
    WHERE status = 'ready'
      AND (
        (scope = 'monthly' AND key >= ? AND key < ?)
        OR (scope = 'annual' AND CAST(key AS INTEGER) <= ?)
      )
    ORDER BY scope ASC, key ASC
  `);
  const upsertSolarMarketValueAttemptStmt = db.prepare(`
    INSERT INTO solar_market_value_year_attempts (year, last_attempt_at, cooldown_until, status, error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(year)
    DO UPDATE SET
      last_attempt_at=excluded.last_attempt_at,
      cooldown_until=excluded.cooldown_until,
      status=excluded.status,
      error=excluded.error
  `);
  const getSolarMarketValueAttemptStmt = db.prepare(`
    SELECT year, last_attempt_at, cooldown_until, status, error
    FROM solar_market_value_year_attempts
    WHERE year = ?
  `);

  function buildMaterializedEnergySlotWrites(rows) {
    const writes = new Map();
    for (const row of rows) {
      const seriesKey = String(row.seriesKey || '').trim();
      if (!MATERIALIZED_ENERGY_SERIES.has(seriesKey)) continue;

      let sourceKind = null;
      let writeMode = null;
      let quality = null;

      if ((row.scope || 'live') === 'live' && (row.source || 'local_poll') === 'local_poll') {
        sourceKind = 'local_live';
        writeMode = 'accumulate';
        quality = 'raw_derived';
      } else if ((row.scope || '') === 'history' && (row.source || '') === 'vrm_import') {
        sourceKind = 'vrm_import';
        writeMode = 'replace';
        quality = row.quality || 'backfilled';
      }

      if (!sourceKind || !writeMode) continue;

      const valueNum = energyKwhForSample(row.value, row.resolutionSeconds);
      if (!Number.isFinite(valueNum)) continue;

      const slotStartUtc = bucketIso(row.ts, MATERIALIZED_SLOT_BUCKET_SECONDS);
      const key = `${slotStartUtc}\u0000${seriesKey}\u0000${sourceKind}`;
      const existing = writes.get(key);
      if (existing) {
        existing.valueNum += valueNum;
        existing.meta = mergeMaterializedMeta(existing.meta, row.meta);
        continue;
      }
      writes.set(key, {
        slotStartUtc,
        seriesKey,
        sourceKind,
        quality,
        valueNum,
        unit: 'kWh',
        meta: mergeMaterializedMeta(null, row.meta),
        writeMode
      });
    }
    return [...writes.values()];
  }

  function writeSamples(rows) {
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        insertSampleStmt.run(
          row.seriesKey,
          row.scope || 'live',
          row.source || 'local_poll',
          row.quality || 'raw',
          isoTimestamp(row.ts),
          Number(row.resolutionSeconds || 1),
          row.value == null ? null : Number(row.value),
          row.valueText ?? null,
          row.unit ?? null,
          row.meta == null ? null : JSON.stringify(row.meta)
        );
      }
      for (const slotRow of buildMaterializedEnergySlotWrites(rows)) {
        const stmt = slotRow.writeMode === 'replace'
          ? insertReplacedEnergySlotStmt
          : insertAccumulatedEnergySlotStmt;
        stmt.run(
          slotRow.slotStartUtc,
          slotRow.seriesKey,
          slotRow.sourceKind,
          slotRow.quality,
          slotRow.valueNum,
          slotRow.unit,
          slotRow.meta == null ? null : JSON.stringify(slotRow.meta)
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function writeControlEvent(event) {
    insertControlEventStmt.run(
      event.eventType,
      event.target ?? null,
      event.valueNum ?? null,
      event.valueText ?? null,
      event.reason ?? null,
      event.source || 'runtime',
      isoTimestamp(event.ts),
      event.meta == null ? null : JSON.stringify(event.meta)
    );
  }

  function writeScheduleSnapshot(snapshot) {
    insertScheduleSnapshotStmt.run(
      isoTimestamp(snapshot.ts),
      JSON.stringify(snapshot.rules || []),
      snapshot.defaultGridSetpointW ?? null,
      snapshot.defaultChargeCurrentA ?? null,
      snapshot.source || 'runtime'
    );
  }

  function writeOptimizerRun(run) {
    insertOptimizerRunStmt.run(
      run.optimizer,
      isoTimestamp(run.runStartedAt || new Date()),
      isoTimestamp(run.runFinishedAt || new Date()),
      run.status || 'applied',
      run.inputJson == null ? null : JSON.stringify(run.inputJson),
      run.resultJson == null ? null : JSON.stringify(run.resultJson),
      run.source || 'runtime',
      run.externalRunId ?? null
    );
    const rowId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);

    db.exec('BEGIN');
    try {
      for (const row of (run.series || [])) {
        insertOptimizerSeriesStmt.run(
          rowId,
          row.seriesKey,
          row.scope || 'output',
          isoTimestamp(row.ts),
          Number(row.resolutionSeconds || 3600),
          row.value == null ? null : Number(row.value),
          row.unit ?? null
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowId;
  }

  function buildRollups({ now = new Date() } = {}) {
    const current = new Date(now);
    let inserted = 0;
    for (const interval of rollupIntervals) {
      const end = floorToInterval(current, interval);
      const start = new Date(end.getTime() - interval * 1000);
      const rows = db.prepare(`
        SELECT series_key, AVG(value_num) AS avg_value, unit
        FROM timeseries_samples
        WHERE scope != 'rollup'
          AND value_num IS NOT NULL
          AND ts_utc >= ?
          AND ts_utc < ?
        GROUP BY series_key, unit
      `).all(start.toISOString(), end.toISOString());

      for (const row of rows) {
        insertSampleStmt.run(
          row.series_key,
          'rollup',
          'rollup',
          'aggregated',
          start.toISOString(),
          Number(interval),
          Number(row.avg_value),
          null,
          row.unit ?? null,
          JSON.stringify({ bucketStart: start.toISOString(), bucketEnd: end.toISOString() })
        );
        inserted += 1;
      }
    }
    return { inserted };
  }

  function cleanupRawSamples({ now = new Date() } = {}) {
    const cutoff = new Date(new Date(now).getTime() - rawRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare(`
      DELETE FROM timeseries_samples
      WHERE scope != 'rollup'
        AND ts_utc < ?
    `).run(cutoff);
    return Number(result.changes || 0);
  }

  function getTelemetryBounds() {
    const row = db.prepare(`
      SELECT MIN(ts_utc) AS earliest, MAX(ts_utc) AS latest
      FROM timeseries_samples
      WHERE series_key NOT LIKE 'price_%'
    `).get();
    return {
      earliest: row?.earliest || null,
      latest: row?.latest || null
    };
  }

  function listMissingPriceBuckets({ start = null, end = null, seriesKeys = DEFAULT_TELEMETRY_BACKFILL_SERIES } = {}) {
    const keys = Array.isArray(seriesKeys) && seriesKeys.length ? seriesKeys : DEFAULT_TELEMETRY_BACKFILL_SERIES;
    const placeholders = keys.map(() => '?').join(', ');
    const telemetryRows = db.prepare(`
      SELECT ts_utc
      FROM timeseries_samples
      WHERE series_key IN (${placeholders})
        ${start ? 'AND ts_utc >= ?' : ''}
        ${end ? 'AND ts_utc < ?' : ''}
    `).all(...keys, ...(start ? [isoTimestamp(start)] : []), ...(end ? [isoTimestamp(end)] : []));
    const priceRows = db.prepare(`
      SELECT ts_utc
      FROM timeseries_samples
      WHERE series_key = 'price_ct_kwh'
        ${start ? 'AND ts_utc >= ?' : ''}
        ${end ? 'AND ts_utc < ?' : ''}
    `).all(...(start ? [isoTimestamp(start)] : []), ...(end ? [isoTimestamp(end)] : []));

    const telemetryBuckets = new Set(telemetryRows.map((row) => bucketIso(row.ts_utc, DEFAULT_PRICE_BUCKET_SECONDS)));
    const pricedBuckets = new Set(priceRows.map((row) => bucketIso(row.ts_utc, DEFAULT_PRICE_BUCKET_SECONDS)));

    return [...telemetryBuckets].filter((ts) => !pricedBuckets.has(ts)).sort();
  }

  function listAggregatedEnergySlots({ start, end, bucketSeconds = DEFAULT_PRICE_BUCKET_SECONDS, scopes = null }) {
    const scopeList = Array.isArray(scopes)
      ? scopes.map((scope) => String(scope || '').trim()).filter(Boolean)
      : [];
    const scopeClause = scopeList.length
      ? ` AND scope IN (${scopeList.map(() => '?').join(', ')})`
      : '';
    const rows = db.prepare(`
      SELECT series_key, ts_utc, resolution_seconds, value_num, meta_json
      FROM timeseries_samples
      WHERE series_key IN (
        'grid_import_w',
        'grid_export_w',
        'grid_total_w',
        'pv_total_w',
        'pv_ac_w',
        'battery_power_w',
        'battery_charge_w',
        'battery_discharge_w',
        'load_power_w',
        'vrm_solar_yield_w',
        'vrm_site_consumption_w',
        'vrm_grid_import_ref_w',
        'vrm_grid_export_ref_w',
        'vrm_consumption_input_w',
        'vrm_consumption_output_w',
        'self_consumption_w',
        'solar_direct_use_w',
        'solar_to_battery_w',
        'solar_to_grid_w',
        'grid_direct_use_w',
        'grid_to_battery_w',
        'battery_direct_use_w',
        'battery_to_grid_w'
      )
        AND value_num IS NOT NULL
        AND ts_utc >= ?
        AND ts_utc < ?
        ${scopeClause}
      ORDER BY ts_utc ASC
    `).all(isoTimestamp(start), isoTimestamp(end), ...scopeList);

    const buckets = new Map();
    for (const row of rows) {
      const ts = bucketIso(row.ts_utc, bucketSeconds);
      const bucket = buckets.get(ts) || new Map();
      const entries = bucket.get(row.series_key) || [];
      entries.push(row);
      bucket.set(row.series_key, entries);
      buckets.set(ts, bucket);
    }

    return [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ts, bucket]) => {
        const energyForSeries = (seriesKey) => {
          const avgPower = weightedAverage(bucket.get(seriesKey) || []);
          if (!Number.isFinite(avgPower)) return 0;
          return roundKwh((avgPower * bucketSeconds) / 3600000);
        };
        const flagsForSeries = (seriesKey) => {
          const entries = bucket.get(seriesKey) || [];
          const meta = entries.map((entry) => parseMetaJson(entry.meta_json)).filter(Boolean);
          return {
            estimated: meta.some((item) => item.provenance === 'estimated'),
            incomplete: meta.some((item) => item.incomplete === true)
          };
        };
        const trackedSeries = [
          'grid_import_w',
          'grid_export_w',
          'pv_total_w',
          'battery_power_w',
          'battery_charge_w',
          'battery_discharge_w',
          'load_power_w'
        ];
        const estimatedSeriesKeys = trackedSeries.filter((seriesKey) => flagsForSeries(seriesKey).estimated);
        const incompleteSeriesKeys = trackedSeries.filter((seriesKey) => flagsForSeries(seriesKey).incomplete);
        return {
          ts,
          importKwh: energyForSeries('grid_import_w'),
          exportKwh: energyForSeries('grid_export_w'),
          gridKwh: energyForSeries('grid_total_w'),
          pvKwh: energyForSeries('pv_total_w'),
          pvAcKwh: energyForSeries('pv_ac_w'),
          batteryKwh: energyForSeries('battery_power_w'),
          batteryChargeKwh: energyForSeries('battery_charge_w'),
          batteryDischargeKwh: energyForSeries('battery_discharge_w'),
          loadKwh: energyForSeries('load_power_w'),
          vrmSolarYieldKwh: energyForSeries('vrm_solar_yield_w'),
          vrmSiteConsumptionKwh: energyForSeries('vrm_site_consumption_w'),
          vrmGridImportRefKwh: energyForSeries('vrm_grid_import_ref_w'),
          vrmGridExportRefKwh: energyForSeries('vrm_grid_export_ref_w'),
          vrmConsumptionInputKwh: energyForSeries('vrm_consumption_input_w'),
          vrmConsumptionOutputKwh: energyForSeries('vrm_consumption_output_w'),
          selfConsumptionKwh: energyForSeries('self_consumption_w'),
          solarDirectUseKwh: energyForSeries('solar_direct_use_w'),
          solarToBatteryKwh: energyForSeries('solar_to_battery_w'),
          solarToGridKwh: energyForSeries('solar_to_grid_w'),
          gridDirectUseKwh: energyForSeries('grid_direct_use_w'),
          gridToBatteryKwh: energyForSeries('grid_to_battery_w'),
          batteryDirectUseKwh: energyForSeries('battery_direct_use_w'),
          batteryToGridKwh: energyForSeries('battery_to_grid_w'),
          estimated: estimatedSeriesKeys.length > 0,
          incomplete: incompleteSeriesKeys.length > 0,
          estimatedSeriesCount: estimatedSeriesKeys.length,
          incompleteSeriesCount: incompleteSeriesKeys.length,
          estimatedSeriesKeys,
          incompleteSeriesKeys
        };
      });
  }

  function listPriceSlots({ start, end, bucketSeconds = DEFAULT_PRICE_BUCKET_SECONDS }) {
    const rows = db.prepare(`
      SELECT series_key, ts_utc, resolution_seconds, value_num
      FROM timeseries_samples
      WHERE series_key IN ('price_ct_kwh', 'price_eur_mwh')
        AND value_num IS NOT NULL
        AND ts_utc >= ?
        AND ts_utc < ?
      ORDER BY ts_utc ASC
    `).all(isoTimestamp(start), isoTimestamp(end));

    const buckets = new Map();
    for (const row of rows) {
      const ts = bucketIso(row.ts_utc, bucketSeconds);
      const bucket = buckets.get(ts) || new Map();
      const entries = bucket.get(row.series_key) || [];
      entries.push(row);
      bucket.set(row.series_key, entries);
      buckets.set(ts, bucket);
    }

    return [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ts, bucket]) => ({
        ts,
        priceCtKwh: weightedAverage(bucket.get('price_ct_kwh') || []),
        priceEurMwh: weightedAverage(bucket.get('price_eur_mwh') || [])
      }))
      .filter((row) => row.priceCtKwh != null || row.priceEurMwh != null);
  }

  function listMaterializedEnergySlots({
    start,
    end,
    sourceKinds = ['vrm_import', 'local_live']
  }) {
    const preferredSourceKinds = Array.isArray(sourceKinds)
      ? sourceKinds.map((kind) => String(kind || '').trim()).filter(Boolean)
      : ['vrm_import', 'local_live'];
    const sourceClause = preferredSourceKinds.length
      ? ` AND source_kind IN (${preferredSourceKinds.map(() => '?').join(', ')})`
      : '';
    const seriesList = [...MATERIALIZED_ENERGY_SERIES];
    const rows = db.prepare(`
      SELECT slot_start_utc, series_key, source_kind, quality, value_num, unit, meta_json
      FROM energy_slots_15m
      WHERE series_key IN (${seriesList.map(() => '?').join(', ')})
        AND slot_start_utc >= ?
        AND slot_start_utc < ?
        ${sourceClause}
      ORDER BY slot_start_utc ASC, series_key ASC, source_kind ASC
    `).all(
      ...seriesList,
      isoTimestamp(start),
      isoTimestamp(end),
      ...preferredSourceKinds
    );

    const buckets = new Map();
    for (const row of rows) {
      const bucket = buckets.get(row.slot_start_utc) || new Map();
      const bySeries = bucket.get(row.series_key) || new Map();
      bySeries.set(row.source_kind, row);
      bucket.set(row.series_key, bySeries);
      buckets.set(row.slot_start_utc, bucket);
    }

    return [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ts, bucket]) => {
        const selectedSourceKinds = new Set();
        const availableSourceKinds = new Set();
        const pickSeriesRow = (seriesKey) => {
          const bySource = bucket.get(seriesKey);
          if (!bySource) return null;
          for (const sourceKind of preferredSourceKinds) {
            const row = bySource.get(sourceKind);
            if (row) {
              selectedSourceKinds.add(sourceKind);
              for (const key of bySource.keys()) availableSourceKinds.add(key);
              return row;
            }
          }
          const fallbackRow = [...bySource.values()][0] || null;
          if (fallbackRow) {
            selectedSourceKinds.add(fallbackRow.source_kind);
            for (const key of bySource.keys()) availableSourceKinds.add(key);
          }
          return fallbackRow;
        };
        const energyForSeries = (seriesKey) => Number(pickSeriesRow(seriesKey)?.value_num || 0);
        const flagsForSeries = (seriesKey) => {
          const meta = parseMetaJson(pickSeriesRow(seriesKey)?.meta_json);
          return {
            estimated: meta?.estimated === true,
            incomplete: meta?.incomplete === true
          };
        };
        const trackedSeries = [
          'grid_import_w',
          'grid_export_w',
          'pv_total_w',
          'battery_power_w',
          'battery_charge_w',
          'battery_discharge_w',
          'load_power_w'
        ];
        const estimatedSeriesKeys = trackedSeries.filter((seriesKey) => flagsForSeries(seriesKey).estimated);
        const incompleteSeriesKeys = trackedSeries.filter((seriesKey) => flagsForSeries(seriesKey).incomplete);
        const selectedKinds = [...selectedSourceKinds];
        const overallSourceKind = selectedKinds.length === 1 ? selectedKinds[0] : (selectedKinds.length > 1 ? 'mixed' : null);
        return {
          ts,
          importKwh: energyForSeries('grid_import_w'),
          exportKwh: energyForSeries('grid_export_w'),
          gridKwh: energyForSeries('grid_total_w'),
          pvKwh: energyForSeries('pv_total_w'),
          pvAcKwh: energyForSeries('pv_ac_w'),
          batteryKwh: energyForSeries('battery_power_w'),
          batteryChargeKwh: energyForSeries('battery_charge_w'),
          batteryDischargeKwh: energyForSeries('battery_discharge_w'),
          loadKwh: energyForSeries('load_power_w'),
          vrmSolarYieldKwh: energyForSeries('vrm_solar_yield_w'),
          vrmSiteConsumptionKwh: energyForSeries('vrm_site_consumption_w'),
          vrmGridImportRefKwh: energyForSeries('vrm_grid_import_ref_w'),
          vrmGridExportRefKwh: energyForSeries('vrm_grid_export_ref_w'),
          vrmConsumptionInputKwh: energyForSeries('vrm_consumption_input_w'),
          vrmConsumptionOutputKwh: energyForSeries('vrm_consumption_output_w'),
          selfConsumptionKwh: energyForSeries('self_consumption_w'),
          solarDirectUseKwh: energyForSeries('solar_direct_use_w'),
          solarToBatteryKwh: energyForSeries('solar_to_battery_w'),
          solarToGridKwh: energyForSeries('solar_to_grid_w'),
          gridDirectUseKwh: energyForSeries('grid_direct_use_w'),
          gridToBatteryKwh: energyForSeries('grid_to_battery_w'),
          batteryDirectUseKwh: energyForSeries('battery_direct_use_w'),
          batteryToGridKwh: energyForSeries('battery_to_grid_w'),
          sourceKind: overallSourceKind,
          sourceKinds: [...availableSourceKinds].sort(),
          estimated: estimatedSeriesKeys.length > 0,
          incomplete: incompleteSeriesKeys.length > 0,
          estimatedSeriesCount: estimatedSeriesKeys.length,
          incompleteSeriesCount: incompleteSeriesKeys.length,
          estimatedSeriesKeys,
          incompleteSeriesKeys
        };
      });
  }

  function listImportJobRanges({
    jobTypes = [],
    statuses = ['completed'],
    sourceAccount = null,
    requestedFrom = null,
    requestedTo = null
  } = {}) {
    const typeList = Array.isArray(jobTypes)
      ? jobTypes.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const statusList = Array.isArray(statuses)
      ? statuses.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const clauses = ['requested_from IS NOT NULL', 'requested_to IS NOT NULL'];
    const params = [];

    if (typeList.length) {
      clauses.push(`job_type IN (${typeList.map(() => '?').join(', ')})`);
      params.push(...typeList);
    }
    if (statusList.length) {
      clauses.push(`status IN (${statusList.map(() => '?').join(', ')})`);
      params.push(...statusList);
    }
    if (sourceAccount) {
      clauses.push('source_account = ?');
      params.push(String(sourceAccount));
    }
    if (requestedFrom) {
      clauses.push('requested_to > ?');
      params.push(isoTimestamp(requestedFrom));
    }
    if (requestedTo) {
      clauses.push('requested_from < ?');
      params.push(isoTimestamp(requestedTo));
    }

    return db.prepare(`
      SELECT job_type, status, requested_from, requested_to, imported_rows, source_account, meta_json
      FROM import_jobs
      WHERE ${clauses.join(' AND ')}
      ORDER BY requested_from ASC, requested_to ASC
    `).all(...params).map((row) => ({
      jobType: row.job_type,
      status: row.status,
      requestedFrom: row.requested_from,
      requestedTo: row.requested_to,
      importedRows: Number(row.imported_rows || 0),
      sourceAccount: row.source_account || null,
      meta: parseMetaJson(row.meta_json)
    }));
  }

  function mapSolarMarketValueRow(row) {
    if (!row) return null;
    return {
      scope: row.scope,
      key: row.key,
      ctKwh: Number(row.ct_kwh),
      source: row.source,
      fetchedAt: row.fetched_at,
      lastAttemptAt: row.last_attempt_at || null,
      cooldownUntil: row.cooldown_until || null,
      status: row.status,
      error: row.error || null
    };
  }

  function mapSolarMarketValueAttemptRow(row) {
    if (!row) return null;
    return {
      year: Number(row.year),
      lastAttemptAt: row.last_attempt_at,
      cooldownUntil: row.cooldown_until || null,
      status: row.status,
      error: row.error || null
    };
  }

  return {
    dbPath,
    listTables() {
      return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
    },
    countRows(table, where = '1=1') {
      const ALLOWED_TABLES = ['telemetry', 'control_events', 'schedule_snapshots', 'optimizer_runs', 'import_jobs', 'timeseries_samples', 'optimizer_run_series'];
      if (!ALLOWED_TABLES.includes(table)) throw new Error(`countRows: unknown table "${table}"`);
      return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE ${where}`).get().count);
    },
    writeSamples,
    writeControlEvent,
    writeScheduleSnapshot,
    writeOptimizerRun,
    writeImportJob(job) {
      insertImportJobStmt.run(
        job.jobType,
        isoTimestamp(job.startedAt || new Date()),
        isoTimestamp(job.finishedAt || new Date()),
        job.status || 'completed',
        job.requestedFrom ?? null,
        job.requestedTo ?? null,
        Number(job.importedRows || 0),
        job.sourceAccount ?? null,
        job.meta == null ? null : JSON.stringify(job.meta)
      );
      return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
    },
    buildRollups,
    cleanupRawSamples,
    getTelemetryBounds,
    listMissingPriceBuckets,
    listAggregatedEnergySlots,
    listMaterializedEnergySlots,
    listImportJobRanges,
    listPriceSlots,
    upsertSolarMarketValue(entry = {}) {
      const fetchedAt = isoTimestamp(entry.fetchedAt || new Date());
      upsertSolarMarketValueStmt.run(
        String(entry.scope || ''),
        String(entry.key || ''),
        Number(entry.ctKwh),
        String(entry.source || 'energy_charts'),
        fetchedAt,
        entry.lastAttemptAt ? isoTimestamp(entry.lastAttemptAt) : fetchedAt,
        entry.cooldownUntil ? isoTimestamp(entry.cooldownUntil) : null,
        entry.status || 'ready',
        entry.error ?? null
      );
    },
    getSolarMarketValue({ scope, key } = {}) {
      return mapSolarMarketValueRow(getSolarMarketValueStmt.get(String(scope || ''), String(key || '')));
    },
    listSolarMarketValuesForYear({ year } = {}) {
      const numericYear = Number(year);
      if (!Number.isInteger(numericYear)) {
        return {
          hasAny: false,
          summary: { monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} },
          cooldownUntil: null
        };
      }
      const yearPrefix = `${numericYear}-`;
      const nextYearPrefix = `${numericYear + 1}-`;
      const rows = listSolarMarketValuesForYearStmt.all(yearPrefix, nextYearPrefix, numericYear);
      const summary = {
        monthlyCtKwhByMonth: {},
        annualCtKwhByYear: {}
      };
      for (const row of rows) {
        const entry = mapSolarMarketValueRow(row);
        if (entry.scope === 'monthly') {
          summary.monthlyCtKwhByMonth[entry.key] = entry.ctKwh;
        } else if (entry.scope === 'annual') {
          summary.annualCtKwhByYear[entry.key] = entry.ctKwh;
        }
      }
      const attempt = mapSolarMarketValueAttemptRow(getSolarMarketValueAttemptStmt.get(numericYear));
      const monthlyKeys = Object.keys(summary.monthlyCtKwhByMonth);
      const annualKeys = Object.keys(summary.annualCtKwhByYear);
      return {
        hasAny: rows.length > 0,
        hasComplete: isCompleteHistoricalSolarMarketValueYear({
          year: numericYear,
          monthlyKeys,
          annualKeys
        }),
        summary,
        cooldownUntil: attempt?.cooldownUntil || null,
        attempt
      };
    },
    markSolarMarketValueAttempt(entry = {}) {
      const numericYear = Number(entry.year);
      if (!Number.isInteger(numericYear)) return;
      upsertSolarMarketValueAttemptStmt.run(
        numericYear,
        isoTimestamp(entry.attemptedAt || new Date()),
        entry.cooldownUntil ? isoTimestamp(entry.cooldownUntil) : null,
        String(entry.status || 'ready'),
        entry.error ?? null
      );
    },
    getSolarMarketValueAttempt({ year } = {}) {
      const numericYear = Number(year);
      if (!Number.isInteger(numericYear)) return null;
      return mapSolarMarketValueAttemptRow(getSolarMarketValueAttemptStmt.get(numericYear));
    },
    hasCompleteSolarMarketValueYear({ year } = {}) {
      return this.listSolarMarketValuesForYear({ year }).hasComplete === true;
    },
    getStatus() {
      const lastSample = db.prepare(`SELECT MAX(ts_utc) AS value FROM timeseries_samples`).get().value;
      const lastEvent = db.prepare(`SELECT MAX(ts_utc) AS value FROM control_events`).get().value;
      return {
        dbPath,
        rawRetentionDays,
        rollupIntervals: [...rollupIntervals],
        lastWriteAt: lastEvent || lastSample || null,
        sampleRows: Number(db.prepare(`SELECT COUNT(*) AS count FROM timeseries_samples`).get().count),
        eventRows: Number(db.prepare(`SELECT COUNT(*) AS count FROM control_events`).get().count)
      };
    },
    close() {
      db.close();
    }
  };
}
