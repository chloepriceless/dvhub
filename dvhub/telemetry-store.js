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
const DEFAULT_TELEMETRY_BACKFILL_SERIES = [
  'grid_import_w',
  'grid_export_w',
  'grid_total_w',
  'pv_total_w',
  'battery_power_w'
];

function roundKwh(value) {
  const numeric = Number(value || 0);
  const sign = numeric < 0 ? -1 : 1;
  return sign * (Math.round((Math.abs(numeric) + Number.EPSILON) * 100) / 100);
}

function bucketIso(ts, seconds) {
  return floorToInterval(new Date(ts), seconds).toISOString();
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

  return {
    dbPath,
    listTables() {
      return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
    },
    countRows(table, where = '1=1') {
      return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count);
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
    listPriceSlots,
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
