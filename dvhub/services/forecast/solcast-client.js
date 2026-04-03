// solcast-client.js -- Solcast PV forecast client with rate limiting.
// Factory: createSolcastClient(ctx, { store }) -> { fetchPvForecast, getRemainingCalls }
// Respects 10 calls/day free-tier API limit.

const SOLCAST_BASE = 'https://api.solcast.com.au/rooftop_sites';
const MAX_CALLS_PER_DAY = 10;

/**
 * Compute confidence score from Solcast prediction interval.
 * Narrow prediction interval = high confidence, wide = low.
 * @param {object} f - Solcast forecast entry with pv_estimate, pv_estimate10, pv_estimate90
 * @returns {number} confidence between 0.3 and 1.0
 */
export function computeSolcastConfidence(f) {
  const range = (f.pv_estimate90 - f.pv_estimate10) / Math.max(f.pv_estimate, 0.01);
  return Math.max(0.3, Math.min(1.0, 1.0 - range));
}

/**
 * Parse Solcast forecast response into rows with W (not kW).
 * @param {Array<object>} forecasts - Solcast forecasts[] array
 * @returns {Array<{ ts: string, powerW: number, confidence: number }>}
 */
export function parseSolcastResponse(forecasts) {
  if (!Array.isArray(forecasts)) return [];
  return forecasts.map(f => ({
    ts: f.period_end,
    powerW: Math.round(f.pv_estimate * 1000),
    confidence: computeSolcastConfidence(f)
  }));
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
      const rows = parseSolcastResponse(data.forecasts || []);

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
