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
const MATERIALIZED_ENERGY_SERIES = new Set([
  'grid_import_w', 'grid_export_w', 'grid_total_w',
  'pv_total_w', 'pv_ac_w',
  'battery_power_w', 'battery_charge_w', 'battery_discharge_w',
  'load_power_w',
  'vrm_solar_yield_w', 'vrm_site_consumption_w',
  'vrm_grid_import_ref_w', 'vrm_grid_export_ref_w',
  'vrm_consumption_input_w', 'vrm_consumption_output_w',
  'self_consumption_w',
  'solar_direct_use_w', 'solar_to_battery_w', 'solar_to_grid_w',
  'grid_direct_use_w', 'grid_to_battery_w',
  'battery_direct_use_w', 'battery_to_grid_w'
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
  if (!value || typeof value === 'object') return value || null;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeMaterializedMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const estimated = meta.estimated === true || meta.provenance === 'estimated';
  const incomplete = meta.incomplete === true;
  if (!estimated && !incomplete) return null;
  return { estimated, incomplete };
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

function assertSqlIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL ${label}: ${value}`);
  }
  return value;
}

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
    writes.set(key, { slotStartUtc, seriesKey, sourceKind, quality, valueNum, unit: 'kWh', meta: mergeMaterializedMeta(null, row.meta), writeMode });
  }
  return [...writes.values()];
}

const KNOWN_TABLES = new Set([
  'timeseries_samples', 'energy_slots_15m', 'control_events',
  'schedule_snapshots', 'optimizer_runs', 'optimizer_run_series',
  'import_jobs', 'data_gaps', 'solar_market_values', 'solar_market_value_year_attempts'
]);

export async function ensurePgSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS timeseries_samples (
      id BIGSERIAL PRIMARY KEY,
      series_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      quality TEXT NOT NULL,
      ts_utc TIMESTAMPTZ NOT NULL,
      resolution_seconds INTEGER NOT NULL,
      value_num DOUBLE PRECISION,
      value_text TEXT,
      unit TEXT,
      meta_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(series_key, scope, source, quality, ts_utc, resolution_seconds)
    );
    CREATE INDEX IF NOT EXISTS idx_timeseries_series_ts ON timeseries_samples(series_key, ts_utc);
    CREATE INDEX IF NOT EXISTS idx_timeseries_scope_ts ON timeseries_samples(scope, ts_utc);

    CREATE TABLE IF NOT EXISTS control_events (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      target TEXT,
      value_num DOUBLE PRECISION,
      value_text TEXT,
      reason TEXT,
      source TEXT NOT NULL,
      ts_utc TIMESTAMPTZ NOT NULL,
      meta_json TEXT
    );

    CREATE TABLE IF NOT EXISTS schedule_snapshots (
      id BIGSERIAL PRIMARY KEY,
      ts_utc TIMESTAMPTZ NOT NULL,
      rules_json TEXT NOT NULL,
      default_grid_setpoint_w DOUBLE PRECISION,
      default_charge_current_a DOUBLE PRECISION,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS optimizer_runs (
      id BIGSERIAL PRIMARY KEY,
      optimizer TEXT NOT NULL,
      run_started_at TIMESTAMPTZ NOT NULL,
      run_finished_at TIMESTAMPTZ,
      status TEXT NOT NULL,
      input_json TEXT,
      result_json TEXT,
      source TEXT NOT NULL,
      external_run_id TEXT
    );

    CREATE TABLE IF NOT EXISTS optimizer_run_series (
      id BIGSERIAL PRIMARY KEY,
      optimizer_run_id BIGINT NOT NULL REFERENCES optimizer_runs(id) ON DELETE CASCADE,
      series_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      ts_utc TIMESTAMPTZ NOT NULL,
      resolution_seconds INTEGER NOT NULL,
      value_num DOUBLE PRECISION,
      unit TEXT
    );

    CREATE TABLE IF NOT EXISTS import_jobs (
      id BIGSERIAL PRIMARY KEY,
      job_type TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      status TEXT NOT NULL,
      requested_from TEXT,
      requested_to TEXT,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      source_account TEXT,
      meta_json TEXT
    );

    CREATE TABLE IF NOT EXISTS data_gaps (
      id BIGSERIAL PRIMARY KEY,
      series_key TEXT NOT NULL,
      gap_start TIMESTAMPTZ NOT NULL,
      gap_end TIMESTAMPTZ NOT NULL,
      detected_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      fill_source TEXT
    );

    CREATE TABLE IF NOT EXISTS energy_slots_15m (
      id BIGSERIAL PRIMARY KEY,
      slot_start_utc TIMESTAMPTZ NOT NULL,
      series_key TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      quality TEXT NOT NULL,
      value_num DOUBLE PRECISION,
      unit TEXT,
      meta_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(slot_start_utc, series_key, source_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_energy_slots_15m_slot_start ON energy_slots_15m(slot_start_utc);

    CREATE TABLE IF NOT EXISTS solar_market_values (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      ct_kwh DOUBLE PRECISION NOT NULL,
      source TEXT NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL,
      last_attempt_at TIMESTAMPTZ,
      cooldown_until TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      UNIQUE(scope, key)
    );
    CREATE INDEX IF NOT EXISTS idx_solar_market_values_scope_key ON solar_market_values(scope, key);

    CREATE TABLE IF NOT EXISTS vrm_forecasts (
      id BIGSERIAL PRIMARY KEY,
      forecast_type TEXT NOT NULL,
      ts_utc TIMESTAMPTZ NOT NULL,
      value_w DOUBLE PRECISION,
      fetched_at TIMESTAMPTZ NOT NULL,
      forecast_for_date TEXT,
      source TEXT,
      meta_json TEXT,
      UNIQUE(forecast_type, ts_utc)
    );
    CREATE INDEX IF NOT EXISTS idx_vrm_forecasts_ts ON vrm_forecasts(ts_utc);

    CREATE TABLE IF NOT EXISTS solar_market_value_year_attempts (
      year INTEGER PRIMARY KEY,
      last_attempt_at TIMESTAMPTZ NOT NULL,
      cooldown_until TIMESTAMPTZ,
      status TEXT NOT NULL,
      error TEXT
    );
  `);
  // Ensure connected user owns all tables (fixes tables created by a different user, e.g. postgres)
  const { rows } = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tableowner <> current_user
  `);
  for (const row of rows) {
    const safeName = assertSqlIdentifier(row.tablename, 'tablename');
    await pool.query(`ALTER TABLE public.${safeName} OWNER TO current_user`);
  }
}

export function createTelemetryStorePg(pool, { rawRetentionDays = 45 } = {}) {

  async function writeSamples(rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        await client.query(`
          INSERT INTO timeseries_samples
            (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num, value_text, unit, meta_json)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (series_key, scope, source, quality, ts_utc, resolution_seconds)
          DO UPDATE SET value_num = EXCLUDED.value_num, value_text = EXCLUDED.value_text, unit = EXCLUDED.unit, meta_json = EXCLUDED.meta_json
        `, [
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
        ]);
      }

      for (const slotRow of buildMaterializedEnergySlotWrites(rows)) {
        if (slotRow.writeMode === 'replace') {
          await client.query(`
            INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, unit, meta_json)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (slot_start_utc, series_key, source_kind)
            DO UPDATE SET quality = EXCLUDED.quality, value_num = EXCLUDED.value_num, unit = EXCLUDED.unit, meta_json = EXCLUDED.meta_json, updated_at = now()
          `, [slotRow.slotStartUtc, slotRow.seriesKey, slotRow.sourceKind, slotRow.quality, slotRow.valueNum, slotRow.unit, slotRow.meta == null ? null : JSON.stringify(slotRow.meta)]);
        } else {
          await client.query(`
            INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, unit, meta_json)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (slot_start_utc, series_key, source_kind)
            DO UPDATE SET quality = EXCLUDED.quality, value_num = COALESCE(energy_slots_15m.value_num, 0) + COALESCE(EXCLUDED.value_num, 0), unit = EXCLUDED.unit, meta_json = EXCLUDED.meta_json, updated_at = now()
          `, [slotRow.slotStartUtc, slotRow.seriesKey, slotRow.sourceKind, slotRow.quality, slotRow.valueNum, slotRow.unit, slotRow.meta == null ? null : JSON.stringify(slotRow.meta)]);
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function writeControlEvent(event) {
    await pool.query(`
      INSERT INTO control_events (event_type, target, value_num, value_text, reason, source, ts_utc, meta_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      event.eventType, event.target ?? null, event.valueNum ?? null,
      event.valueText ?? null, event.reason ?? null,
      event.source || 'runtime', isoTimestamp(event.ts),
      event.meta == null ? null : JSON.stringify(event.meta)
    ]);
  }

  async function writeScheduleSnapshot(snapshot) {
    await pool.query(`
      INSERT INTO schedule_snapshots (ts_utc, rules_json, default_grid_setpoint_w, default_charge_current_a, source)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      isoTimestamp(snapshot.ts), JSON.stringify(snapshot.rules || []),
      snapshot.defaultGridSetpointW ?? null, snapshot.defaultChargeCurrentA ?? null,
      snapshot.source || 'runtime'
    ]);
  }

  async function writeOptimizerRun(run) {
    const result = await pool.query(`
      INSERT INTO optimizer_runs (optimizer, run_started_at, run_finished_at, status, input_json, result_json, source, external_run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [
      run.optimizer, isoTimestamp(run.runStartedAt || new Date()),
      isoTimestamp(run.runFinishedAt || new Date()), run.status || 'applied',
      run.inputJson == null ? null : JSON.stringify(run.inputJson),
      run.resultJson == null ? null : JSON.stringify(run.resultJson),
      run.source || 'runtime', run.externalRunId ?? null
    ]);
    const rowId = Number(result.rows[0].id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of (run.series || [])) {
        await client.query(`
          INSERT INTO optimizer_run_series (optimizer_run_id, series_key, scope, ts_utc, resolution_seconds, value_num, unit)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [rowId, row.seriesKey, row.scope || 'output', isoTimestamp(row.ts), Number(row.resolutionSeconds || 3600), row.value == null ? null : Number(row.value), row.unit ?? null]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return rowId;
  }

  async function writeImportJob(job) {
    const result = await pool.query(`
      INSERT INTO import_jobs (job_type, started_at, finished_at, status, requested_from, requested_to, imported_rows, source_account, meta_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      job.jobType, isoTimestamp(job.startedAt || new Date()),
      isoTimestamp(job.finishedAt || new Date()), job.status || 'completed',
      job.requestedFrom ?? null, job.requestedTo ?? null,
      Number(job.importedRows || 0), job.sourceAccount ?? null,
      job.meta == null ? null : JSON.stringify(job.meta)
    ]);
    return Number(result.rows[0].id);
  }

  // buildRollups is a no-op — TimescaleDB continuous aggregates handle this
  async function buildRollups() {
    return { inserted: 0 };
  }

  // cleanupRawSamples is a no-op — TimescaleDB retention policy handles this
  async function cleanupRawSamples() {
    return 0;
  }

  async function getTelemetryBounds() {
    const result = await pool.query(`
      SELECT MIN(ts_utc) AS earliest, MAX(ts_utc) AS latest
      FROM timeseries_samples
      WHERE series_key NOT LIKE 'price_%'
    `);
    const row = result.rows[0];
    return {
      earliest: row?.earliest ? new Date(row.earliest).toISOString() : null,
      latest: row?.latest ? new Date(row.latest).toISOString() : null
    };
  }

  async function listMissingPriceBuckets({ start = null, end = null, seriesKeys = ['grid_import_w', 'grid_export_w', 'grid_total_w', 'pv_total_w', 'battery_power_w'] } = {}) {
    const keys = Array.isArray(seriesKeys) && seriesKeys.length ? seriesKeys : ['grid_import_w', 'grid_export_w', 'grid_total_w', 'pv_total_w', 'battery_power_w'];

    // Telemetry query: series keys + optional start/end
    const telemetryParams = [...keys];
    let telemetryIdx = keys.length;
    let telemetryWhere = '';
    if (start) { telemetryIdx++; telemetryWhere += ` AND ts_utc >= $${telemetryIdx}`; telemetryParams.push(isoTimestamp(start)); }
    if (end) { telemetryIdx++; telemetryWhere += ` AND ts_utc < $${telemetryIdx}`; telemetryParams.push(isoTimestamp(end)); }
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const telemetryRows = (await pool.query(`SELECT ts_utc FROM timeseries_samples WHERE series_key IN (${placeholders})${telemetryWhere}`, telemetryParams)).rows;

    // Price query: separate params with own indices
    const priceParams = [];
    let priceIdx = 0;
    let priceWhere = '';
    if (start) { priceIdx++; priceWhere += ` AND ts_utc >= $${priceIdx}`; priceParams.push(isoTimestamp(start)); }
    if (end) { priceIdx++; priceWhere += ` AND ts_utc < $${priceIdx}`; priceParams.push(isoTimestamp(end)); }
    const priceQuery = priceParams.length
      ? `SELECT ts_utc FROM timeseries_samples WHERE series_key = 'price_ct_kwh'${priceWhere}`
      : `SELECT ts_utc FROM timeseries_samples WHERE series_key = 'price_ct_kwh'`;
    const priceRows = (await pool.query(priceQuery, priceParams)).rows;

    const telemetryBuckets = new Set(telemetryRows.map((row) => bucketIso(row.ts_utc, DEFAULT_PRICE_BUCKET_SECONDS)));
    const pricedBuckets = new Set(priceRows.map((row) => bucketIso(row.ts_utc, DEFAULT_PRICE_BUCKET_SECONDS)));
    return [...telemetryBuckets].filter((ts) => !pricedBuckets.has(ts)).sort();
  }

  async function listAggregatedEnergySlots({ start, end, bucketSeconds = DEFAULT_PRICE_BUCKET_SECONDS, scopes = null }) {
    const scopeList = Array.isArray(scopes) ? scopes.map((s) => String(s || '').trim()).filter(Boolean) : [];
    const params = [isoTimestamp(start), isoTimestamp(end)];
    let scopeClause = '';
    if (scopeList.length) {
      scopeClause = ` AND scope IN (${scopeList.map((_, i) => `$${i + 3}`).join(', ')})`;
      params.push(...scopeList);
    }

    const energySeries = [
      'grid_import_w', 'grid_export_w', 'grid_total_w', 'pv_total_w', 'pv_ac_w',
      'battery_power_w', 'battery_charge_w', 'battery_discharge_w', 'load_power_w',
      'vrm_solar_yield_w', 'vrm_site_consumption_w', 'vrm_grid_import_ref_w', 'vrm_grid_export_ref_w',
      'vrm_consumption_input_w', 'vrm_consumption_output_w', 'self_consumption_w',
      'solar_direct_use_w', 'solar_to_battery_w', 'solar_to_grid_w',
      'grid_direct_use_w', 'grid_to_battery_w', 'battery_direct_use_w', 'battery_to_grid_w'
    ];
    const seriesPlaceholders = energySeries.map((_, i) => `$${params.length + i + 1}`).join(', ');
    params.push(...energySeries);

    const result = await pool.query(`
      SELECT series_key, ts_utc, resolution_seconds, value_num, meta_json
      FROM timeseries_samples
      WHERE series_key IN (${seriesPlaceholders})
        AND value_num IS NOT NULL
        AND ts_utc >= $1 AND ts_utc < $2
        ${scopeClause}
      ORDER BY ts_utc ASC
    `, params);

    const buckets = new Map();
    for (const row of result.rows) {
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
        const trackedSeries = ['grid_import_w', 'grid_export_w', 'pv_total_w', 'battery_power_w', 'battery_charge_w', 'battery_discharge_w', 'load_power_w'];
        const estimatedSeriesKeys = trackedSeries.filter((sk) => flagsForSeries(sk).estimated);
        const incompleteSeriesKeys = trackedSeries.filter((sk) => flagsForSeries(sk).incomplete);
        return {
          ts,
          importKwh: energyForSeries('grid_import_w'), exportKwh: energyForSeries('grid_export_w'),
          gridKwh: energyForSeries('grid_total_w'), pvKwh: energyForSeries('pv_total_w'),
          pvAcKwh: energyForSeries('pv_ac_w'), batteryKwh: energyForSeries('battery_power_w'),
          batteryChargeKwh: energyForSeries('battery_charge_w'), batteryDischargeKwh: energyForSeries('battery_discharge_w'),
          loadKwh: energyForSeries('load_power_w'),
          vrmSolarYieldKwh: energyForSeries('vrm_solar_yield_w'), vrmSiteConsumptionKwh: energyForSeries('vrm_site_consumption_w'),
          vrmGridImportRefKwh: energyForSeries('vrm_grid_import_ref_w'), vrmGridExportRefKwh: energyForSeries('vrm_grid_export_ref_w'),
          vrmConsumptionInputKwh: energyForSeries('vrm_consumption_input_w'), vrmConsumptionOutputKwh: energyForSeries('vrm_consumption_output_w'),
          selfConsumptionKwh: energyForSeries('self_consumption_w'),
          solarDirectUseKwh: energyForSeries('solar_direct_use_w'), solarToBatteryKwh: energyForSeries('solar_to_battery_w'),
          solarToGridKwh: energyForSeries('solar_to_grid_w'), gridDirectUseKwh: energyForSeries('grid_direct_use_w'),
          gridToBatteryKwh: energyForSeries('grid_to_battery_w'), batteryDirectUseKwh: energyForSeries('battery_direct_use_w'),
          batteryToGridKwh: energyForSeries('battery_to_grid_w'),
          estimated: estimatedSeriesKeys.length > 0, incomplete: incompleteSeriesKeys.length > 0,
          estimatedSeriesCount: estimatedSeriesKeys.length, incompleteSeriesCount: incompleteSeriesKeys.length,
          estimatedSeriesKeys, incompleteSeriesKeys
        };
      });
  }

  async function listPriceSlots({ start, end, bucketSeconds = DEFAULT_PRICE_BUCKET_SECONDS }) {
    const result = await pool.query(`
      SELECT series_key, ts_utc, resolution_seconds, value_num
      FROM timeseries_samples
      WHERE series_key IN ('price_ct_kwh', 'price_eur_mwh')
        AND value_num IS NOT NULL
        AND ts_utc >= $1 AND ts_utc < $2
      ORDER BY ts_utc ASC
    `, [isoTimestamp(start), isoTimestamp(end)]);

    const buckets = new Map();
    for (const row of result.rows) {
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

  async function listMaterializedEnergySlots({ start, end, sourceKinds = ['vrm_import', 'local_live'] }) {
    const preferredSourceKinds = Array.isArray(sourceKinds) ? sourceKinds.map((k) => String(k || '').trim()).filter(Boolean) : ['vrm_import', 'local_live'];
    const seriesList = [...MATERIALIZED_ENERGY_SERIES];
    const params = [...seriesList, isoTimestamp(start), isoTimestamp(end), ...preferredSourceKinds];
    const seriesPlaceholders = seriesList.map((_, i) => `$${i + 1}`).join(', ');
    const sourceOffset = seriesList.length + 2;
    const sourcePlaceholders = preferredSourceKinds.map((_, i) => `$${sourceOffset + i + 1}`).join(', ');

    const result = await pool.query(`
      SELECT slot_start_utc, series_key, source_kind, quality, value_num, unit, meta_json
      FROM energy_slots_15m
      WHERE series_key IN (${seriesPlaceholders})
        AND slot_start_utc >= $${seriesList.length + 1}
        AND slot_start_utc < $${seriesList.length + 2}
        AND source_kind IN (${sourcePlaceholders})
      ORDER BY slot_start_utc ASC, series_key ASC, source_kind ASC
    `, params);

    const buckets = new Map();
    for (const row of result.rows) {
      const tsKey = new Date(row.slot_start_utc).toISOString();
      const bucket = buckets.get(tsKey) || new Map();
      const bySeries = bucket.get(row.series_key) || new Map();
      bySeries.set(row.source_kind, row);
      bucket.set(row.series_key, bySeries);
      buckets.set(tsKey, bucket);
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
            if (row) { selectedSourceKinds.add(sourceKind); for (const key of bySource.keys()) availableSourceKinds.add(key); return row; }
          }
          const fallbackRow = [...bySource.values()][0] || null;
          if (fallbackRow) { selectedSourceKinds.add(fallbackRow.source_kind); for (const key of bySource.keys()) availableSourceKinds.add(key); }
          return fallbackRow;
        };
        const energyForSeries = (seriesKey) => Number(pickSeriesRow(seriesKey)?.value_num || 0);
        const flagsForSeries = (seriesKey) => {
          const meta = parseMetaJson(pickSeriesRow(seriesKey)?.meta_json);
          return { estimated: meta?.estimated === true, incomplete: meta?.incomplete === true };
        };
        const trackedSeries = ['grid_import_w', 'grid_export_w', 'pv_total_w', 'battery_power_w', 'battery_charge_w', 'battery_discharge_w', 'load_power_w'];
        const estimatedSeriesKeys = trackedSeries.filter((sk) => flagsForSeries(sk).estimated);
        const incompleteSeriesKeys = trackedSeries.filter((sk) => flagsForSeries(sk).incomplete);
        const selectedKinds = [...selectedSourceKinds];
        const overallSourceKind = selectedKinds.length === 1 ? selectedKinds[0] : (selectedKinds.length > 1 ? 'mixed' : null);
        return {
          ts, importKwh: energyForSeries('grid_import_w'), exportKwh: energyForSeries('grid_export_w'),
          gridKwh: energyForSeries('grid_total_w'), pvKwh: energyForSeries('pv_total_w'), pvAcKwh: energyForSeries('pv_ac_w'),
          batteryKwh: energyForSeries('battery_power_w'), batteryChargeKwh: energyForSeries('battery_charge_w'),
          batteryDischargeKwh: energyForSeries('battery_discharge_w'), loadKwh: energyForSeries('load_power_w'),
          vrmSolarYieldKwh: energyForSeries('vrm_solar_yield_w'), vrmSiteConsumptionKwh: energyForSeries('vrm_site_consumption_w'),
          vrmGridImportRefKwh: energyForSeries('vrm_grid_import_ref_w'), vrmGridExportRefKwh: energyForSeries('vrm_grid_export_ref_w'),
          vrmConsumptionInputKwh: energyForSeries('vrm_consumption_input_w'), vrmConsumptionOutputKwh: energyForSeries('vrm_consumption_output_w'),
          selfConsumptionKwh: energyForSeries('self_consumption_w'),
          solarDirectUseKwh: energyForSeries('solar_direct_use_w'), solarToBatteryKwh: energyForSeries('solar_to_battery_w'),
          solarToGridKwh: energyForSeries('solar_to_grid_w'), gridDirectUseKwh: energyForSeries('grid_direct_use_w'),
          gridToBatteryKwh: energyForSeries('grid_to_battery_w'), batteryDirectUseKwh: energyForSeries('battery_direct_use_w'),
          batteryToGridKwh: energyForSeries('battery_to_grid_w'),
          sourceKind: overallSourceKind, sourceKinds: [...availableSourceKinds].sort(),
          estimated: estimatedSeriesKeys.length > 0, incomplete: incompleteSeriesKeys.length > 0,
          estimatedSeriesCount: estimatedSeriesKeys.length, incompleteSeriesCount: incompleteSeriesKeys.length,
          estimatedSeriesKeys, incompleteSeriesKeys
        };
      });
  }

  async function listImportJobRanges({ jobTypes = [], statuses = ['completed'], sourceAccount = null, requestedFrom = null, requestedTo = null } = {}) {
    const typeList = Array.isArray(jobTypes) ? jobTypes.map((v) => String(v || '').trim()).filter(Boolean) : [];
    const statusList = Array.isArray(statuses) ? statuses.map((v) => String(v || '').trim()).filter(Boolean) : [];
    const clauses = ['requested_from IS NOT NULL', 'requested_to IS NOT NULL'];
    const params = [];
    let idx = 0;

    if (typeList.length) { clauses.push(`job_type IN (${typeList.map(() => `$${++idx}`).join(', ')})`); params.push(...typeList); }
    if (statusList.length) { clauses.push(`status IN (${statusList.map(() => `$${++idx}`).join(', ')})`); params.push(...statusList); }
    if (sourceAccount) { clauses.push(`source_account = $${++idx}`); params.push(String(sourceAccount)); }
    if (requestedFrom) { clauses.push(`requested_to > $${++idx}`); params.push(isoTimestamp(requestedFrom)); }
    if (requestedTo) { clauses.push(`requested_from < $${++idx}`); params.push(isoTimestamp(requestedTo)); }

    const result = await pool.query(`
      SELECT job_type, status, requested_from, requested_to, imported_rows, source_account, meta_json
      FROM import_jobs WHERE ${clauses.join(' AND ')}
      ORDER BY requested_from ASC, requested_to ASC
    `, params);

    return result.rows.map((row) => ({
      jobType: row.job_type, status: row.status,
      requestedFrom: row.requested_from ? new Date(row.requested_from).toISOString() : null,
      requestedTo: row.requested_to ? new Date(row.requested_to).toISOString() : null,
      importedRows: Number(row.imported_rows || 0),
      sourceAccount: row.source_account || null,
      meta: parseMetaJson(row.meta_json)
    }));
  }

  function mapSolarMarketValueRow(row) {
    if (!row) return null;
    return {
      scope: row.scope, key: row.key, ctKwh: Number(row.ct_kwh),
      source: row.source, fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
      lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
      cooldownUntil: row.cooldown_until ? new Date(row.cooldown_until).toISOString() : null,
      status: row.status, error: row.error || null
    };
  }

  function mapSolarMarketValueAttemptRow(row) {
    if (!row) return null;
    return {
      year: Number(row.year),
      lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
      cooldownUntil: row.cooldown_until ? new Date(row.cooldown_until).toISOString() : null,
      status: row.status, error: row.error || null
    };
  }

  // Query arbitrary telemetry series (e.g. battery_soc_pct)
  async function querySeries({ seriesKeys, start, end, maxResolution = 900 }) {
    const keys = Array.isArray(seriesKeys) ? seriesKeys : [seriesKeys];
    if (!keys.length) return [];
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(`
      SELECT series_key, ts_utc, resolution_seconds, value_num, unit
      FROM timeseries_samples
      WHERE series_key IN (${placeholders})
        AND ts_utc >= $${keys.length + 1} AND ts_utc < $${keys.length + 2}
        AND resolution_seconds <= $${keys.length + 3}
      ORDER BY ts_utc ASC, resolution_seconds ASC
    `, [...keys, isoTimestamp(start), isoTimestamp(end), maxResolution]);
    // Deduplicate: prefer smallest resolution per (key, 15min bucket)
    const seen = new Map();
    const rows = [];
    for (const row of result.rows) {
      const bucket = `${row.series_key}|${bucketIso(row.ts_utc, 900)}`;
      if (!seen.has(bucket)) {
        seen.set(bucket, true);
        rows.push({
          key: row.series_key,
          ts: row.ts_utc,
          value: Number(row.value_num),
          unit: row.unit,
          resolution: row.resolution_seconds
        });
      }
    }
    return rows;
  }

  return {
    dbPath: 'postgresql',
    querySeries,
    async listTables() {
      const result = await pool.query(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
      return result.rows.map((row) => row.name);
    },
    async countRows(table, filters = {}) {
      const tableName = assertSqlIdentifier(table, 'table');
      if (!KNOWN_TABLES.has(tableName)) throw new Error(`Unknown table: ${tableName}`);

      if (typeof filters === 'string') {
        const safeWherePattern = /^[A-Za-z_][A-Za-z0-9_]*\s+(=|LIKE|!=|<>|<|>|<=|>=)\s+'[^']*'(\s+AND\s+[A-Za-z_][A-Za-z0-9_]*\s+(=|LIKE|!=|<>|<|>|<=|>=)\s+'[^']*')*$/i;
        if (filters === '1=1') {
          const r = await pool.query(`SELECT COUNT(*) AS count FROM ${tableName}`);
          return Number(r.rows[0].count);
        }
        if (!safeWherePattern.test(filters.trim())) throw new Error(`unsafe WHERE clause: ${filters}`);
        const r = await pool.query(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${filters}`);
        return Number(r.rows[0].count);
      }

      if (filters == null || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('filters must be an object');
      const clauses = [];
      const params = [];
      let idx = 0;
      for (const [column, value] of Object.entries(filters)) {
        const columnName = assertSqlIdentifier(column, 'column');
        clauses.push(`${columnName} = $${++idx}`);
        params.push(value);
      }
      const whereClause = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const r = await pool.query(`SELECT COUNT(*) AS count FROM ${tableName}${whereClause}`, params);
      return Number(r.rows[0].count);
    },
    writeSamples,
    writeControlEvent,
    writeScheduleSnapshot,
    writeOptimizerRun,
    writeImportJob,
    buildRollups,
    cleanupRawSamples,
    getTelemetryBounds,
    listMissingPriceBuckets,
    listAggregatedEnergySlots,
    listMaterializedEnergySlots,
    listImportJobRanges,
    listPriceSlots,
    async upsertSolarMarketValue(entry = {}) {
      const fetchedAt = isoTimestamp(entry.fetchedAt || new Date());
      await pool.query(`
        INSERT INTO solar_market_values (scope, key, ct_kwh, source, fetched_at, last_attempt_at, cooldown_until, status, error)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (scope, key)
        DO UPDATE SET ct_kwh = EXCLUDED.ct_kwh, source = EXCLUDED.source, fetched_at = EXCLUDED.fetched_at,
          last_attempt_at = EXCLUDED.last_attempt_at, cooldown_until = EXCLUDED.cooldown_until, status = EXCLUDED.status, error = EXCLUDED.error
      `, [
        String(entry.scope || ''), String(entry.key || ''), Number(entry.ctKwh),
        String(entry.source || 'energy_charts'), fetchedAt,
        entry.lastAttemptAt ? isoTimestamp(entry.lastAttemptAt) : fetchedAt,
        entry.cooldownUntil ? isoTimestamp(entry.cooldownUntil) : null,
        entry.status || 'ready', entry.error ?? null
      ]);
    },
    async getSolarMarketValue({ scope, key } = {}) {
      const result = await pool.query(`SELECT * FROM solar_market_values WHERE scope = $1 AND key = $2`, [String(scope || ''), String(key || '')]);
      return mapSolarMarketValueRow(result.rows[0]);
    },
    async listSolarMarketValuesForYear({ year } = {}) {
      const numericYear = Number(year);
      if (!Number.isInteger(numericYear)) return { hasAny: false, summary: { monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} }, cooldownUntil: null };
      const yearPrefix = `${numericYear}-`;
      const nextYearPrefix = `${numericYear + 1}-`;
      const result = await pool.query(`
        SELECT * FROM solar_market_values
        WHERE status = 'ready' AND (
          (scope = 'monthly' AND key >= $1 AND key < $2)
          OR (scope = 'annual' AND CAST(key AS INTEGER) <= $3)
        ) ORDER BY scope ASC, key ASC
      `, [yearPrefix, nextYearPrefix, numericYear]);

      const summary = { monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} };
      for (const row of result.rows) {
        const entry = mapSolarMarketValueRow(row);
        if (entry.scope === 'monthly') summary.monthlyCtKwhByMonth[entry.key] = entry.ctKwh;
        else if (entry.scope === 'annual') summary.annualCtKwhByYear[entry.key] = entry.ctKwh;
      }
      const attemptResult = await pool.query(`SELECT * FROM solar_market_value_year_attempts WHERE year = $1`, [numericYear]);
      const attempt = mapSolarMarketValueAttemptRow(attemptResult.rows[0]);
      const monthlyKeys = Object.keys(summary.monthlyCtKwhByMonth);
      const annualKeys = Object.keys(summary.annualCtKwhByYear);
      return {
        hasAny: result.rows.length > 0,
        hasComplete: isCompleteHistoricalSolarMarketValueYear({ year: numericYear, monthlyKeys, annualKeys }),
        summary, cooldownUntil: attempt?.cooldownUntil || null, attempt
      };
    },
    async markSolarMarketValueAttempt(entry = {}) {
      const numericYear = Number(entry.year);
      if (!Number.isInteger(numericYear)) return;
      await pool.query(`
        INSERT INTO solar_market_value_year_attempts (year, last_attempt_at, cooldown_until, status, error)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (year)
        DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at, cooldown_until = EXCLUDED.cooldown_until, status = EXCLUDED.status, error = EXCLUDED.error
      `, [numericYear, isoTimestamp(entry.attemptedAt || new Date()), entry.cooldownUntil ? isoTimestamp(entry.cooldownUntil) : null, String(entry.status || 'ready'), entry.error ?? null]);
    },
    async getSolarMarketValueAttempt({ year } = {}) {
      const numericYear = Number(year);
      if (!Number.isInteger(numericYear)) return null;
      const result = await pool.query(`SELECT * FROM solar_market_value_year_attempts WHERE year = $1`, [numericYear]);
      return mapSolarMarketValueAttemptRow(result.rows[0]);
    },
    async hasCompleteSolarMarketValueYear({ year } = {}) {
      return (await this.listSolarMarketValuesForYear({ year })).hasComplete === true;
    },
    async getStatus() {
      const lastSample = (await pool.query(`SELECT MAX(ts_utc) AS value FROM timeseries_samples`)).rows[0]?.value;
      const lastEvent = (await pool.query(`SELECT MAX(ts_utc) AS value FROM control_events`)).rows[0]?.value;
      const sampleCount = (await pool.query(`SELECT COUNT(*) AS count FROM timeseries_samples`)).rows[0]?.count;
      const eventCount = (await pool.query(`SELECT COUNT(*) AS count FROM control_events`)).rows[0]?.count;
      return {
        dbPath: 'postgresql',
        rawRetentionDays,
        rollupIntervals: [],
        lastWriteAt: (lastEvent || lastSample) ? new Date(lastEvent || lastSample).toISOString() : null,
        sampleRows: Number(sampleCount || 0),
        eventRows: Number(eventCount || 0)
      };
    },
    async listControlEvents({ limit = 200, eventType = null } = {}) {
      let query = 'SELECT event_type, target, value_num, value_text, reason, source, ts_utc, meta_json FROM control_events';
      const params = [];
      if (eventType) {
        params.push(eventType);
        query += ` WHERE event_type = $${params.length}`;
      }
      params.push(Math.min(Math.max(1, Number(limit) || 200), 2000));
      query += ` ORDER BY ts_utc DESC LIMIT $${params.length}`;
      const result = await pool.query(query, params);
      return result.rows.map(r => ({
        event: r.event_type,
        target: r.target,
        value: r.value_num,
        valueText: r.value_text,
        reason: r.reason,
        source: r.source,
        ts: r.ts_utc,
        meta: r.meta_json ? (typeof r.meta_json === "string" ? JSON.parse(r.meta_json) : r.meta_json) : null
      }));
    },
    async writeForecastPoints(points = []) {
      if (!points.length) return 0;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let upserted = 0;
        for (const pt of points) {
          await client.query(`
            INSERT INTO vrm_forecasts (forecast_type, ts_utc, value_w, fetched_at, forecast_for_date, source, meta_json)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (forecast_type, ts_utc, forecast_for_date)
            DO UPDATE SET value_w = EXCLUDED.value_w, fetched_at = EXCLUDED.fetched_at, source = EXCLUDED.source
          `, [pt.forecastType, pt.tsUtc, pt.valueW, pt.fetchedAt || new Date().toISOString(), pt.forecastForDate, pt.source || 'vrm', pt.meta ? JSON.stringify(pt.meta) : null]);
          upserted++;
        }
        await client.query('COMMIT');
        return upserted;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async listForecasts({ start, end, forecastType = null } = {}) {
      let query = 'SELECT forecast_type, ts_utc, value_w, fetched_at, forecast_for_date, source FROM vrm_forecasts WHERE ts_utc >= $1 AND ts_utc <= $2';
      const params = [start, end];
      if (forecastType) {
        params.push(forecastType);
        query += ` AND forecast_type = $${params.length}`;
      }
      query += ' ORDER BY ts_utc ASC';
      const result = await pool.query(query, params);
      return result.rows.map(r => ({
        type: r.forecast_type,
        ts: r.ts_utc,
        valueW: r.value_w,
        fetchedAt: r.fetched_at,
        forecastForDate: r.forecast_for_date,
        source: r.source
      }));
    },
    async close() {
      await pool.end();
    }
  };
}
