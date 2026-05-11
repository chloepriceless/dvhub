// services/forecast/pvnode-backfill.js — admin-triggered chunked idempotent pvnode /v1/history backfill.
//
// Phase 07 FORE-10 / D-A3 (Plan 07-03).
// Per RESEARCH §pvnode API Backfill (lines 1146-1164) + Pitfalls B-1/B-2.
//
// REVIEWS H8 fixes (LOCKED in this module):
//   1. DAY-LEVEL idempotency (not chunk-level): for each day in the chunk, SELECT from
//      forecast_snapshots WHERE target_date = ANY($1::date[]) AND layer='pvnode'. Skip only
//      the days already present. Partial-chunk failures no longer silently lose remaining days.
//   2. splitDateRange(fromInclusive, toInclusive, chunkDays) — INCLUSIVE/INCLUSIVE semantics.
//      All chunk boundaries are inclusive-inclusive. Dedicated unit tests cover 1-day,
//      30-day, and month-crossing ranges.
//   3. Accurate API call counter: apiCallsUsed += planeGroupsCalled (returned by
//      pvnodeClient.fetchHistory()) — NOT fixed `+= 2`.
//
// REVIEWS H1 cascade: insertSnapshot calls pass BOTH target_date (= slot date, the day the
// slot describes) AND forecast_date (= today UTC, when this backfill run generated the row).
// This matches the schema locked in Plan 07-01.
//
// Nowcast-suspend (Pitfall B-1): forecastService.setNowcastSuspended(true) is called on entry
// and setNowcastSuspended(false) is called unconditionally in finally — nowcast always resumes
// even on unexpected error.
//
// Quota guard: pre-chunk quota.isLowBudget(0.20) halts before exhaustion.

const CHUNK_DAYS_DEFAULT = 30;
const INTER_CHUNK_DELAY_MS = 500;
const LOW_BUDGET_THRESHOLD = 0.20;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * REVIEWS H8: Split an inclusive-inclusive date range into inclusive-inclusive chunks.
 *
 * Both `fromInclusive` and `toInclusive` are YYYY-MM-DD strings and are included in the
 * output. Each chunk has `{startDate, endDate}` both inclusive. The next chunk starts the
 * day AFTER the previous chunk's endDate — no overlap, no gap.
 *
 * @param {string} fromInclusive YYYY-MM-DD — first day included
 * @param {string} toInclusive   YYYY-MM-DD — last day included
 * @param {number} chunkDays     number of days per chunk
 * @returns {Array<{startDate: string, endDate: string}>} each endDate is INCLUSIVE
 *
 * Examples:
 *   splitDateRange('2026-04-01','2026-04-01',30)
 *     → [{startDate:'2026-04-01', endDate:'2026-04-01'}]                 // 1-day
 *   splitDateRange('2026-04-01','2026-04-30',30)
 *     → [{startDate:'2026-04-01', endDate:'2026-04-30'}]                 // 30-day
 *   splitDateRange('2026-03-15','2026-05-14',30)
 *     → [{startDate:'2026-03-15', endDate:'2026-04-13'},
 *        {startDate:'2026-04-14', endDate:'2026-05-13'},
 *        {startDate:'2026-05-14', endDate:'2026-05-14'}]                  // month-crossing
 */
export function splitDateRange(fromInclusive, toInclusive, chunkDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromInclusive)) {
    throw new Error(`splitDateRange: fromInclusive must be YYYY-MM-DD, got ${fromInclusive}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toInclusive)) {
    throw new Error(`splitDateRange: toInclusive must be YYYY-MM-DD, got ${toInclusive}`);
  }
  if (!Number.isInteger(chunkDays) || chunkDays < 1) {
    throw new Error(`splitDateRange: chunkDays must be a positive integer, got ${chunkDays}`);
  }

  const chunks = [];
  let cursor = new Date(fromInclusive + 'T00:00:00Z');
  const end = new Date(toInclusive + 'T00:00:00Z');
  if (cursor > end) return chunks;

  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + chunkDays - 1); // -1 for inclusive-inclusive
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      startDate: cursor.toISOString().slice(0, 10),
      endDate: chunkEnd.toISOString().slice(0, 10)
    });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1); // next chunk starts the day AFTER previous endDate
  }
  return chunks;
}

/**
 * Return every YYYY-MM-DD day from chunk.startDate to chunk.endDate INCLUSIVE.
 *
 * @param {{startDate:string,endDate:string}} chunk
 * @returns {string[]} array of YYYY-MM-DD day strings
 */
export function expandChunkDays(chunk) {
  const days = [];
  let cursor = new Date(chunk.startDate + 'T00:00:00Z');
  const end = new Date(chunk.endDate + 'T00:00:00Z');
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Create the pvnode backfill factory.
 *
 * @param {object} ctx - DI context { getCfg, pushLog }
 * @param {object} deps - { pvnodeClient, quota, store, forecastService }
 *   - pvnodeClient: must expose fetchHistory({startDate, endDate, plants?})
 *     returning {slots, planeGroupsCalled}
 *   - quota: must expose isLowBudget(threshold) → boolean Promise
 *   - store: must expose query(sql, params) + insertSnapshot(row)
 *   - forecastService: optional; if present, setNowcastSuspended(bool) toggles nowcast during run
 */
export function createPvnodeBackfill(ctx, { pvnodeClient, quota, store, forecastService } = {}) {
  const { pushLog } = ctx;

  const state = {
    state: 'idle', // idle | running | paused | completed | error
    daysDone: 0,
    daysTotal: 0,
    apiCallsUsed: 0,
    from: null,
    to: null,
    startedAt: null,
    finishedAt: null,
    error: null
  };

  /**
   * REVIEWS H8 day-level idempotency check.
   *
   * Query forecast_snapshots for any (target_date, layer='pvnode') rows matching the
   * supplied day list, return a Set of YYYY-MM-DD strings that are already present.
   *
   * @param {string[]} days — YYYY-MM-DD list
   * @returns {Promise<Set<string>>}
   */
  async function daysAlreadyPresent(days) {
    if (!Array.isArray(days) || days.length === 0) return new Set();
    const result = await store.query(
      `SELECT DISTINCT target_date
         FROM forecast_snapshots
        WHERE target_date = ANY($1::date[])
          AND layer = 'pvnode'`,
      [days]
    );
    const rows = result?.rows ?? [];
    return new Set(rows.map(r => {
      const td = r.target_date;
      if (td instanceof Date) return td.toISOString().slice(0, 10);
      return String(td).slice(0, 10);
    }));
  }

  async function run({ from, to, chunkDays = CHUNK_DAYS_DEFAULT } = {}) {
    if (state.state === 'running') {
      pushLog('pvnode_backfill_already_running', { from, to });
      return { ok: false, error: 'already_running' };
    }

    state.state = 'running';
    state.from = from;
    state.to = to;
    state.daysDone = 0;
    state.daysTotal = expandChunkDays({ startDate: from, endDate: to }).length;
    state.apiCallsUsed = 0;
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    state.error = null;

    // Pitfall B-1: suspend nowcast to avoid quota competition during backfill
    if (forecastService && typeof forecastService.setNowcastSuspended === 'function') {
      try { forecastService.setNowcastSuspended(true); } catch { /* best-effort */ }
    }

    try {
      const chunks = splitDateRange(from, to, chunkDays);
      pushLog('pvnode_backfill_started', {
        from, to, chunks: chunks.length, days_total: state.daysTotal
      });

      // REVIEWS H8: forecast_date (today UTC) is recorded ONCE per run — provenance for
      // every row written by this particular backfill invocation.
      const forecastDate = new Date().toISOString().slice(0, 10);

      for (const chunk of chunks) {
        const daysInChunk = expandChunkDays(chunk);

        // REVIEWS H8 day-level idempotency: find which days are missing in DB
        let present;
        try {
          present = await daysAlreadyPresent(daysInChunk);
        } catch (err) {
          pushLog('pvnode_backfill_idempotency_error', {
            chunk: `${chunk.startDate}..${chunk.endDate}`,
            error: err?.message || String(err)
          });
          present = new Set();
        }
        const missingDays = daysInChunk.filter(d => !present.has(d));

        if (missingDays.length === 0) {
          pushLog('pvnode_backfill_skip_all_days_present', {
            chunk: `${chunk.startDate}..${chunk.endDate}`,
            present: present.size
          });
          state.daysDone += daysInChunk.length;
          continue;
        }

        // Quota guard: halt if <20% remaining. Resume happens on next admin invocation
        // (idempotency ensures already-completed days are skipped).
        try {
          if (quota && typeof quota.isLowBudget === 'function'
              && await quota.isLowBudget(LOW_BUDGET_THRESHOLD)) {
            pushLog('pvnode_backfill_paused', {
              reason: 'quota_low',
              chunk: `${chunk.startDate}..${chunk.endDate}`,
              days_done: state.daysDone,
              days_total: state.daysTotal
            });
            state.state = 'paused';
            return {
              ok: false,
              error: 'quota_low',
              daysDone: state.daysDone,
              apiCallsUsed: state.apiCallsUsed
            };
          }
        } catch (err) {
          // Quota backend failure is non-fatal — log and continue (treat as "enough budget").
          pushLog('pvnode_backfill_quota_check_error', {
            error: err?.message || String(err)
          });
        }

        try {
          // Fetch the full chunk range (inclusive-inclusive) — we filter to only-missing-days
          // before writing, so previously-successful days are never double-inserted.
          const { slots: historySlots, planeGroupsCalled } = await pvnodeClient.fetchHistory({
            startDate: chunk.startDate,
            endDate: chunk.endDate
          });

          // REVIEWS H8 accurate counter: use actual plane-groups called, not fixed `+=2`.
          const planeGroupsUsed = Number.isFinite(planeGroupsCalled)
            ? planeGroupsCalled
            : Math.ceil(((ctx.getCfg?.()?.userEnergyPricing?.pvPlants?.length) ?? 2) / 2);
          state.apiCallsUsed += planeGroupsUsed;

          const missingDaysSet = new Set(missingDays);
          // Plan 09-08 Task 2: single batched INSERT replaces per-slot await loop.
          // REVIEWS H1: pass BOTH target_date (which day the slot describes) AND
          // forecast_date (today UTC — when this backfill run generated the row).
          // For 96 slots/day × multi-day chunks, this reduces Pi PG round trips
          // from O(slots) to O(1) per chunk.
          const batchRows = (historySlots || [])
            .filter((slot) => missingDaysSet.has(String(slot?.ts_utc || '').slice(0, 10)))
            .map((slot) => ({
              forecast_date: forecastDate,
              target_date: String(slot.ts_utc).slice(0, 10),
              slot_utc: slot.ts_utc,
              layer: 'pvnode',
              power_w: slot.power_w
            }));
          if (batchRows.length > 0) await store.insertSnapshotBatch(batchRows);
          const slotsWritten = batchRows.length;

          state.daysDone += daysInChunk.length;
          pushLog('pvnode_backfill_chunk_ok', {
            chunk: `${chunk.startDate}..${chunk.endDate}`,
            slots_total: (historySlots || []).length,
            slots_written: slotsWritten,
            missing_days: missingDays.length,
            plane_groups_called: planeGroupsUsed
          });
        } catch (err) {
          pushLog('pvnode_backfill_chunk_error', {
            chunk: `${chunk.startDate}..${chunk.endDate}`,
            error: err?.message || String(err)
          });
          // Do NOT bump daysDone for this chunk — retry on next invocation via day-level idempotency.
        }

        await sleep(INTER_CHUNK_DELAY_MS);
      }

      state.state = 'completed';
      state.finishedAt = new Date().toISOString();
      pushLog('pvnode_backfill_completed', {
        daysDone: state.daysDone,
        daysTotal: state.daysTotal,
        apiCallsUsed: state.apiCallsUsed
      });
      return {
        ok: true,
        daysDone: state.daysDone,
        apiCallsUsed: state.apiCallsUsed
      };
    } catch (err) {
      state.state = 'error';
      state.error = err?.message || String(err);
      state.finishedAt = new Date().toISOString();
      pushLog('pvnode_backfill_error', { error: state.error });
      return { ok: false, error: state.error };
    } finally {
      // Always resume nowcast — REVIEWS H8 defensive: finally block guarantees state is
      // restored even on unexpected exception.
      if (forecastService && typeof forecastService.setNowcastSuspended === 'function') {
        try { forecastService.setNowcastSuspended(false); } catch { /* best-effort */ }
      }
    }
  }

  function getStatus() {
    const percent = state.daysTotal > 0
      ? Math.round((state.daysDone / state.daysTotal) * 100)
      : 0;
    // Estimated completion: if running, extrapolate from current rate. If idle/completed,
    // expose last known finishedAt. No fancy ETA — the admin UX is "see it roughly done".
    let estimatedCompletion = null;
    if (state.state === 'running' && state.startedAt && state.daysDone > 0 && state.daysTotal > 0) {
      const startedMs = new Date(state.startedAt).getTime();
      const elapsedMs = Date.now() - startedMs;
      const msPerDay = elapsedMs / state.daysDone;
      const remainingDays = state.daysTotal - state.daysDone;
      estimatedCompletion = new Date(Date.now() + remainingDays * msPerDay).toISOString();
    }
    return {
      state: state.state,
      percent_complete: percent,
      days_done: state.daysDone,
      days_total: state.daysTotal,
      api_calls_used: state.apiCallsUsed,
      from: state.from,
      to: state.to,
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      estimated_completion: estimatedCompletion,
      error: state.error
    };
  }

  return { run, getStatus };
}
