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
    rows.push({
      ts: f.period_end,
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
