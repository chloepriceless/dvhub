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
