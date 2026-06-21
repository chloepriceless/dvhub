// services/forecast/forecast-snapshots.js — Phase 07 FORE-11 / D-B1 + D-B2.
//
// Daily snapshot writer for 5 forecast layers (pvnode, solcast, pvlib, merged, ml).
//
// REVIEWS H1 (locked schema — Plan 07-01): every row in forecast_snapshots carries BOTH
//   forecast_date — when this forecast was generated (today UTC, provenance column)
//   target_date   — which day the slot predicts (accuracy-join key, derived from slot.ts_utc)
//
// REVIEWS L3 (authoritative event-driven + recovery fallback):
//   - AUTHORITATIVE path: called from forecast/index.js runForecast() after a successful
//     forecastVersion increment (post merge + ml-correction). This is the source-of-record.
//   - RECOVERY fallback: scheduler at 00:05 local only writes if `lastSnapshotForecastDate`
//     does NOT already match today. If the event-driven path already wrote the snapshot
//     today (startup + midnight bump), the recovery pass is a no-op.
//
// Pitfall S-1 (nowcast-refresh must NOT pollute snapshots):
//   writeSnapshot({source: 'nowcast'}) short-circuits with a log entry. Callers from the
//   nowcast-refresh path MUST pass source='nowcast'.
//
// Idempotency:
//   1. In-memory fast-path: `lastSnapshotForecastDate` blocks same-day double-writes.
//   2. DB-level safety net: SELECT 1 from forecast_snapshots WHERE forecast_date=$1
//      AND layer='merged' LIMIT 1. If merged already present for this forecast_date, skip.
//   3. forecast-store.insertSnapshot also uses ON CONFLICT … DO UPDATE as final safety net.

/**
 * Factory: create the forecast-snapshots service.
 * @param {object} ctx - DI context { getCfg, pushLog }
 * @param {object} deps - { store, forecastService }
 *   store: forecast-store with insertSnapshot + query helpers (Plan 07-01 REVIEWS H2)
 *   forecastService: optional; provides getCurrentForecasts() for the recovery path
 * @returns {{ start: Function, close: Function, writeSnapshot: Function,
 *             getLastSnapshotForecastDate: Function }}
 */
export function createForecastSnapshots(ctx, { store, forecastService } = {}) {
  const { pushLog } = ctx || {};

  // Scheduler handles.
  let timeoutHandle = null;
  let intervalHandle = null;

  // In-memory guard: forecast_date (YYYY-MM-DD UTC) of the last successful snapshot.
  // Blocks same-day double-writes across the authoritative and recovery paths (REVIEWS L3).
  let lastSnapshotForecastDate = null;

  function log(event, payload = {}) {
    if (typeof pushLog === 'function') pushLog(event, payload);
  }

  function todayStringUtc() {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Derive target_date (YYYY-MM-DD UTC) from a slot timestamp.
   * @param {string|Date} tsUtc
   * @returns {string|null}
   */
  function deriveTargetDate(tsUtc) {
    if (!tsUtc) return null;
    if (typeof tsUtc === 'string' && tsUtc.length >= 10) return tsUtc.slice(0, 10);
    try { return new Date(tsUtc).toISOString().slice(0, 10); } catch { return null; }
  }

  /**
   * Write all 5 layers for the current forecast cycle.
   *
   * Params keys: pvnode, solcast, pvlib, merged, ml — each an array of
   * { ts_utc: string, power_w: number } slots. All are optional and default to [].
   *
   * Control:
   *   params.source        — callers from nowcast-refresh pass 'nowcast' to short-circuit (S-1).
   *   params.forecast_date — optional override (defaults to today UTC). Useful for tests.
   *
   * @returns {Promise<{ok: boolean, forecastDate?: string, slotsWritten?: number,
   *                     skipped?: boolean, reason?: string }>}
   */
  async function writeSnapshot(params = {}) {
    // Pitfall S-1: nowcast-origin writes are refused.
    if (params.source === 'nowcast' || params.source === 'pvnode-nowcast') {
      log('snapshots_skip_nowcast', { source: params.source });
      return { ok: false, reason: 'nowcast_source_not_allowed' };
    }

    const forecastDate = params.forecast_date || todayStringUtc();

    // REVIEWS L3: in-memory fast-path — already wrote today's snapshot → skip.
    if (lastSnapshotForecastDate === forecastDate) {
      log('snapshots_skip_already_written_memory', { forecastDate });
      return { ok: true, skipped: true, forecastDate };
    }

    // T-0105: defer until the forecast-store DB pool is initialised. At boot the
    // first event-driven writeSnapshot (fired by pv-forecast after the startup
    // forecast) can race ahead of forecast-store.ensureSchema(), leaving pool=null
    // → every insertSnapshot throws "Cannot read properties of null (reading
    // 'query')" (the 8× snapshots_insert_error burst observed at boot; benign +
    // self-healing). Skip cleanly instead of dereferencing a null pool; the next
    // forecast cycle / 00:05 recovery writes today's snapshot once the pool is up.
    // lastSnapshotForecastDate stays unset so that retry proceeds.
    if (typeof store?.isReady === 'function' && !store.isReady()) {
      log('snapshots_skip_db_not_ready', { forecastDate });
      return { ok: false, reason: 'db_not_ready' };
    }

    // DB-level idempotency: merged layer already present for this forecast_date?
    try {
      const existing = await store.query(
        `SELECT 1 FROM forecast_snapshots
          WHERE forecast_date = $1 AND layer = 'merged'
          LIMIT 1`,
        [forecastDate]
      );
      if (existing && (existing.rowCount > 0 || (Array.isArray(existing.rows) && existing.rows.length > 0))) {
        lastSnapshotForecastDate = forecastDate;
        log('snapshots_skip_existing_db', { forecastDate });
        return { ok: true, skipped: true, forecastDate };
      }
    } catch (err) {
      // Non-fatal: log and continue. The insertSnapshot ON CONFLICT path is the final safety net.
      log('snapshots_idempotency_query_error', { error: err?.message ?? String(err) });
    }

    const layers = {
      pvnode: Array.isArray(params.pvnode) ? params.pvnode : [],
      solcast: Array.isArray(params.solcast) ? params.solcast : [],
      pvlib: Array.isArray(params.pvlib) ? params.pvlib : [],
      // Operator request 2026-06-21: persist the three Phase-26-01 providers so the
      // accuracy-tracker can compute their MAE → inverse-MAE merge weights them too.
      // The caller (pv-forecast.js writeSnapshot) already passes these arrays.
      vrm: Array.isArray(params.vrm) ? params.vrm : [],
      forecast_solar: Array.isArray(params.forecast_solar) ? params.forecast_solar : [],
      open_meteo: Array.isArray(params.open_meteo) ? params.open_meteo : [],
      merged: Array.isArray(params.merged) ? params.merged : [],
      ml: Array.isArray(params.ml) ? params.ml : []
    };

    let slotsWritten = 0;
    let slotsSkipped = 0;
    for (const [layer, slots] of Object.entries(layers)) {
      for (const slot of slots) {
        const tsUtc = slot?.ts_utc ?? slot?.ts ?? slot?.start;
        const powerW = Number(slot?.power_w ?? slot?.powerW);
        if (!tsUtc || !Number.isFinite(powerW)) { slotsSkipped++; continue; }
        const targetDate = deriveTargetDate(tsUtc);
        if (!targetDate) { slotsSkipped++; continue; }
        try {
          await store.insertSnapshot({
            forecast_date: forecastDate,
            target_date: targetDate,
            slot_utc: typeof tsUtc === 'string' ? tsUtc : new Date(tsUtc).toISOString(),
            layer,
            power_w: powerW
          });
          slotsWritten++;
        } catch (err) {
          log('snapshots_insert_error', { layer, error: err?.message ?? String(err) });
        }
      }
    }

    lastSnapshotForecastDate = forecastDate;
    log('snapshots_written', {
      forecastDate,
      slotsWritten,
      slotsSkipped,
      layers: Object.keys(layers),
      source: params.source ?? 'event_driven'
    });
    return { ok: true, forecastDate, slotsWritten };
  }

  /**
   * Recovery-path entry: used by the 00:05 scheduler. Reads current forecasts from
   * forecastService (if it exposes getCurrentForecasts) and delegates to writeSnapshot.
   * REVIEWS L3: only runs when the event-driven path did not already write today.
   */
  async function writeTodaySnapshot(source = 'scheduler_recovery') {
    const today = todayStringUtc();
    if (lastSnapshotForecastDate === today) {
      log('snapshots_recovery_skip_already_done', { forecastDate: today });
      return { ok: true, skipped: true, forecastDate: today };
    }
    if (!forecastService?.getCurrentForecasts) {
      log('snapshots_recovery_skip_no_forecast_service', {});
      return { ok: false, reason: 'forecast_service_unavailable' };
    }
    let current;
    try {
      current = await forecastService.getCurrentForecasts();
    } catch (err) {
      log('snapshots_recovery_error', { error: err?.message ?? String(err) });
      return { ok: false, reason: 'forecast_service_error' };
    }
    return writeSnapshot({ ...(current || {}), source });
  }

  /**
   * Start the RECOVERY fallback scheduler (REVIEWS L3).
   * First run at 00:05 local, then every 24h. The 5-minute offset lets the first post-midnight
   * forecast refresh (event-driven authoritative) populate the snapshot first; the recovery pass
   * is a no-op when that has already happened.
   */
  function start() {
    const now = new Date();
    const next = new Date(now);
    // REVIEWS L3 recovery-fallback schedule — 00:05 local daily, AFTER event-driven bump window.
    next.setHours(0, 5, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delayMs = next.getTime() - now.getTime();

    timeoutHandle = setTimeout(async () => {
      try {
        await writeTodaySnapshot('scheduler_recovery');
      } catch (err) {
        log('snapshots_error', { error: err?.message ?? String(err) });
      }
      intervalHandle = setInterval(() => {
        writeTodaySnapshot('scheduler_recovery').catch(err =>
          log('snapshots_error', { error: err?.message ?? String(err) })
        );
      }, 24 * 60 * 60 * 1000);
    }, delayMs);

    log('snapshots_started', { nextRunInMs: delayMs, role: 'recovery_fallback' });
  }

  /** Stop the recovery scheduler. Safe to call multiple times. */
  function close() {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  }

  function getLastSnapshotForecastDate() {
    return lastSnapshotForecastDate;
  }

  return { start, close, writeSnapshot, getLastSnapshotForecastDate };
}
