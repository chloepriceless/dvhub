// solcast-client.js -- Solcast PV forecast client with rate limiting.
// Factory: createSolcastClient(ctx, { store }) -> { fetchPvForecast, getRemainingCalls }
// Respects 10 calls/day free-tier API limit.

const SOLCAST_BASE = 'https://api.solcast.com.au/rooftop_sites';
const MAX_CALLS_PER_DAY = 10;

/**
 * Compute confidence score from Solcast prediction interval.
 * Narrow prediction interval = high confidence, wide = low.
 *
 * 18-01i: tolerates missing pv_estimate10/pv_estimate90 (period-endpoint
 * response shape exposes only `pv_estimate_period`) — returns 0.5 when the
 * interval bounds are absent rather than producing NaN.
 *
 * @param {object} f - Solcast forecast entry; may have either
 *   { pv_estimate, pv_estimate10, pv_estimate90 } (point endpoint) or
 *   { pv_estimate_period } (period endpoint).
 * @returns {number} confidence between 0.3 and 1.0
 */
export function computeSolcastConfidence(f) {
  const lo = Number.isFinite(f.pv_estimate10) ? f.pv_estimate10 : null;
  const hi = Number.isFinite(f.pv_estimate90) ? f.pv_estimate90 : null;
  const mid = Number.isFinite(f.pv_estimate) ? f.pv_estimate
            : Number.isFinite(f.pv_estimate_period) ? f.pv_estimate_period
            : null;
  if (lo == null || hi == null || mid == null) return 0.5; // unknown spread -> mid confidence
  const range = (hi - lo) / Math.max(mid, 0.01);
  return Math.max(0.3, Math.min(1.0, 1.0 - range));
}

const DEFAULT_PERIOD_MS = 30 * 60_000; // Solcast free-tier default interval (30 min).

/**
 * Parse a Solcast `period` field (ISO-8601 duration, e.g. "PT30M"/"PT15M") to
 * milliseconds. Minimal parser supporting optional hours + minutes; returns the
 * 30-min default when the field is missing or unparseable (deterministic
 * fallback — never throws, never NaN; threat T-26-03-01).
 *
 * @param {string|undefined} period - ISO-8601 duration string
 * @returns {number} duration in milliseconds (default 30 min)
 */
export function parseIsoDurationMs(period) {
  if (typeof period !== 'string') return DEFAULT_PERIOD_MS;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(period.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return DEFAULT_PERIOD_MS;
  const hours = m[1] !== undefined ? Number(m[1]) : 0;
  const minutes = m[2] !== undefined ? Number(m[2]) : 0;
  const ms = (hours * 60 + minutes) * 60_000;
  return ms > 0 ? ms : DEFAULT_PERIOD_MS;
}

/**
 * Floor a UTC timestamp string onto the nearest 15-minute boundary — identical
 * to pvnode-client.js floorToQuarterIso (the sibling-client established pattern),
 * so all providers merge on the same 15-min axis in ensemble.mergeForecasts
 * (exact ts_utc string match).
 *
 * @param {string} tsUtc - ISO-8601 UTC timestamp
 * @returns {string} ISO-8601 timestamp floored to XX:00, :15, :30, or :45
 */
export function floorToQuarterIso(tsUtc) {
  const d = new Date(tsUtc);
  const minutes = d.getUTCMinutes();
  d.setUTCMinutes(Math.floor(minutes / 15) * 15, 0, 0);
  return d.toISOString();
}

/**
 * Derive the period-START slot timestamp from a Solcast forecast entry. Solcast
 * delivers the interval END (period_end); the START = period_end - interval
 * duration (from the `period` field; 30-min fallback), then floored onto the
 * 15-min axis so it collides with pvnode/pvlib in the ensemble merge (26-03).
 *
 * Returns null when period_end is missing/unparseable so the caller can drop the
 * row instead of pushing a NaN timestamp into the slot path (threat T-26-03-01).
 *
 * @param {object} f - Solcast forecast entry with { period_end, period? }
 * @returns {string|null} ISO-8601 period-START on the 15-min axis, or null
 */
export function solcastPeriodStartIso(f) {
  const endMs = new Date(f?.period_end).getTime();
  if (!Number.isFinite(endMs)) return null;
  const startMs = endMs - parseIsoDurationMs(f?.period);
  return floorToQuarterIso(new Date(startMs).toISOString());
}

/**
 * Pick the power estimate (kW) from a Solcast forecast entry.
 *
 * The Solcast API has two known response shapes:
 *   - point endpoint:   { pv_estimate, pv_estimate10, pv_estimate90 }  (kW)
 *   - period endpoint:  { pv_estimate_period, ... }                    (kW averaged)
 *
 * Some account tiers only return one. Prefer the point estimate; fall back
 * to the period estimate. Returns null if neither is finite — the caller
 * (parseSolcastResponse) drops the row and fetchPvForecast emits a
 * `solcast_persist_diag` pushLog with the raw first-row keys.
 *
 * @param {object} f - Solcast forecast entry
 * @returns {number|null} estimate in kW, or null if no usable field
 */
function pickEstimate(f) {
  if (Number.isFinite(f.pv_estimate)) return f.pv_estimate;
  if (Number.isFinite(f.pv_estimate_period)) return f.pv_estimate_period;
  return null;
}

/**
 * Parse Solcast forecast response into rows with W (not kW).
 *
 * 18-01i: previously returned a plain array via `.map(...)` — but if
 * `f.pv_estimate` was undefined/null/NaN (Solcast API field drift, or wrong
 * endpoint shape) the resulting `powerW` was `NaN`, which forecast-store.js
 * `insertPvForecast` then silently coerced to 0 via its NaN-guard. Result: 145
 * zero-power rows persisted per fetch with no error in logs.
 *
 * Now returns `{ rows, dropped, firstRawKeys }`:
 *   - rows: only entries where pv_estimate is a finite number
 *   - dropped: count of skipped entries
 *   - firstRawKeys: Object.keys of forecasts[0] (for the caller diagnostic)
 *
 * The caller (`fetchPvForecast`) emits a `solcast_persist_diag` pushLog when
 * `dropped > 0` or all parsed rows are zero, so prod drift in field names is
 * visible in `/api/log`.
 *
 * @param {Array<object>} forecasts - Solcast forecasts[] array
 * @returns {{ rows: Array<{ ts: string, powerW: number, confidence: number }>, dropped: number, firstRawKeys: string[] }}
 */
export function parseSolcastResponse(forecasts) {
  if (!Array.isArray(forecasts)) return { rows: [], dropped: 0, firstRawKeys: [] };
  const firstRawKeys = forecasts.length > 0 ? Object.keys(forecasts[0]) : [];
  let dropped = 0;
  const rows = [];
  for (const f of forecasts) {
    // 18-01i: use pickEstimate fallback chain (pv_estimate -> pv_estimate_period)
    // so the period-endpoint response shape also persists non-zero power. The
    // `Number.isFinite(f.pv_estimate)` drop guard is preserved (now inside
    // pickEstimate). Rows missing BOTH fields are dropped + counted.
    const estKw = pickEstimate(f);
    if (estKw == null) { dropped++; continue; }
    // 26-03: normalize ts to the period START (period_end - interval duration),
    // floored onto the 15-min axis, so Solcast slots collide with pvnode/pvlib in
    // ensemble.mergeForecasts. Drop rows with an unparseable period_end (no NaN ts).
    const ts = solcastPeriodStartIso(f);
    if (ts == null) { dropped++; continue; }
    rows.push({
      ts,
      powerW: Math.round(estKw * 1000),
      confidence: computeSolcastConfidence(f)
    });
  }
  return { rows, dropped, firstRawKeys };
}

/**
 * Create a Solcast PV forecast client with rate limiting.
 * @param {object} ctx - DI context { state, getCfg, pushLog }
 * @param {{ store: object }} deps - forecast-store instance
 * @returns {{ fetchPvForecast: Function, getRemainingCalls: Function, _incrementCallCount: Function, _resetForNewDay: Function }}
 */
export function createSolcastClient(ctx, { store }) {
  const { state, getCfg, pushLog } = ctx;

  let callsToday = 0;
  let lastCallDate = todayString();

  /**
   * Get today's date as YYYY-MM-DD string.
   */
  function todayString() {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Check and reset daily counter if day changed.
   */
  function checkDayReset() {
    const today = todayString();
    if (today !== lastCallDate) {
      callsToday = 0;
      lastCallDate = today;
    }
  }

  /**
   * Fetch PV forecast from Solcast API.
   * Returns null if API key/siteId missing or rate limit reached.
   * @returns {Promise<Array|null>} parsed forecast rows or null
   */
  async function fetchPvForecast() {
    const cfg = getCfg();
    const apiKey = cfg.forecast?.solcast?.apiKey;
    const siteId = cfg.forecast?.solcast?.siteId;

    if (!apiKey || !siteId) {
      return null;
    }

    checkDayReset();

    if (callsToday >= MAX_CALLS_PER_DAY) {
      pushLog('solcast_rate_limit', { callsToday });
      return null;
    }

    const url = `${SOLCAST_BASE}/${siteId}/forecasts?format=json&hours=72`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) throw new Error(`Solcast HTTP ${res.status}`);

      callsToday++;

      const data = await res.json();
      const { rows, dropped, firstRawKeys } = parseSolcastResponse(data.forecasts || []);

      // 18-01i: surface field-name drift or all-zero parse to /api/log so the
      // operator can see WHY persisted rows are 0 (the forecast-store NaN-guard
      // silently coerces undefined/NaN power_w to 0).
      const allZero = rows.length > 0 && rows.every(r => r.powerW === 0);
      if (dropped > 0 || allZero) {
        pushLog('solcast_persist_diag', {
          parsed: rows.length,
          dropped,
          allZero,
          firstRawKeys,
          rawSample: data.forecasts?.[0] ?? null
        });
      }

      // Persist via forecast-store
      for (const r of rows) {
        await store.insertPvForecast({
          model: 'solcast',
          ts_utc: r.ts,
          power_w: r.powerW,
          confidence: r.confidence
        });
      }

      // Update state
      state.forecast.pv.lastFetchAt = Date.now();
      state.forecast.pv.data = rows;
      state.forecast.pv.model = 'solcast';
      ctx.bumpForecastVersion?.();

      pushLog('solcast_fetch_ok', { count: rows.length, callsToday });
      return rows;
    } catch (error) {
      pushLog('solcast_fetch_error', { error: error.message });
      return null;
    }
  }

  /**
   * Get remaining API calls for today.
   * @returns {number}
   */
  function getRemainingCalls() {
    checkDayReset();
    return MAX_CALLS_PER_DAY - callsToday;
  }

  // --- Test helpers (prefixed with underscore) ---

  function _incrementCallCount() {
    callsToday++;
  }

  function _resetForNewDay() {
    callsToday = 0;
    lastCallDate = todayString();
  }

  return { fetchPvForecast, getRemainingCalls, _incrementCallCount, _resetForNewDay };
}

/**
 * Phase 20-06 (D-11): single-shot probe for the credential editor.
 *
 * Operator clicks the "Probe-Anfrage" button on the Solcast tab of the
 * Forecast-Provider drawer; this helper performs a minimal upstream call
 * (hours=1 instead of the production hours=72) so the response is small.
 * The call STILL counts as 1 against the daily 10-call quota — see
 * Pitfall 3; the UI surfaces a "Solcast erlaubt 10 Aufrufe/Tag" warning
 * on the tab.
 *
 * IMPORTANT: this helper is intentionally state-free — it does NOT mutate
 * the production client's `callsToday` counter, does NOT persist to the
 * forecast-store, and does NOT bump the forecast version. Anti-DoS rate
 * limiting is enforced at the route layer (checkProviderRateLimit).
 *
 * Always resolves with `{ok, sample?, error?}` — never throws (T-20-06-06).
 *
 * @param {{ apiKey: string, siteId: string }} args
 * @returns {Promise<{ok:boolean, sample?:{ts:string, watts:number}|null, error?:string}>}
 */
export async function probeSolcast({ apiKey, siteId }) {
  if (!apiKey || !siteId) return { ok: false, error: 'missing_credentials' };
  const url = `${SOLCAST_BASE}/${siteId}/forecasts?format=json&hours=1`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) return { ok: false, error: `Solcast HTTP ${res.status}` };
    const data = await res.json();
    const first = (data && Array.isArray(data.forecasts)) ? data.forecasts[0] : null;
    if (!first) return { ok: true, sample: null };
    return {
      ok: true,
      sample: {
        // 26-03: same period-START normalization as parseSolcastResponse (UI-sample
        // consistency; state-free). Fall back to the raw period_end if unparseable.
        ts: solcastPeriodStartIso(first) ?? first.period_end,
        // Solcast emits kW; convert to W for the UI sample-block.
        watts: Math.round((first.pv_estimate || 0) * 1000)
      }
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
