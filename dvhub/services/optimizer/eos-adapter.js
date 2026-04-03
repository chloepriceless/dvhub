// services/optimizer/eos-adapter.js -- Bidirectional EOS adapter per D-12/D-14.
// Sends DVhub forecasts to co-hosted EOS and receives optimized schedules.
// Consistent { ok, error } contract -- NEVER throws (addresses Codex review concern).
import http from 'node:http';
import { toEosStrompreisArray } from './cost-model.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const EOS_DEFAULT_CONFIDENCE = 0.7;
const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * Create a bidirectional EOS adapter for co-hosted Akkudoktor EOS integration.
 *
 * @param {object} ctx - DI context with getCfg() and pushLog()
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000] - HTTP request timeout in ms
 * @returns {{ pushForecast: Function, pullSchedule: Function, isAvailable: Function }}
 */
export function createEosAdapter(ctx, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { getCfg, pushLog } = ctx;

  /**
   * Internal HTTP request helper. NEVER throws -- returns consistent { ok, data } or { ok, error }.
   *
   * @param {string} method - HTTP method (GET, PUT, POST)
   * @param {string} path - URL path (e.g. /v1/prediction/list)
   * @param {object|null} [body=null] - JSON body to send
   * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
   */
  function httpRequest(method, path, body = null) {
    const cfg = getCfg();
    const baseUrl = cfg.optimizer?.eosProxy?.url || 'http://localhost:8503';

    return new Promise((resolve) => {
      try {
        const url = new URL(path, baseUrl);

        const headers = {};
        if (body !== null) {
          headers['Content-Type'] = 'application/json';
        }

        const req = http.request({
          hostname: url.hostname,
          port: url.port || 8503,
          path: url.pathname,
          method,
          headers,
          timeout: timeoutMs
        }, (res) => {
          let chunks = '';
          res.on('data', chunk => chunks += chunk);
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              resolve({ ok: false, error: `EOS returned HTTP ${res.statusCode}` });
              return;
            }
            try {
              const data = JSON.parse(chunks);
              resolve({ ok: true, data });
            } catch {
              resolve({ ok: false, error: 'EOS returned invalid JSON' });
            }
          });
        });

        req.on('error', (err) => {
          resolve({ ok: false, error: err.message || 'EOS connection error' });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ ok: false, error: 'EOS request timed out' });
        });

        if (body !== null) {
          req.write(JSON.stringify(body));
        }
        req.end();
      } catch (err) {
        resolve({ ok: false, error: err.message || 'EOS request failed' });
      }
    });
  }

  /**
   * Convert DVhub forecast response to EOS prediction format and send via PUT.
   * Accepts output of buildForecastResponse() from Phase 01.
   *
   * @param {object} forecastResponse - { pv: { slots }, price: { slots }, load: { slots } }
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function pushForecast(forecastResponse) {
    const payload = {};

    // PV forecast: array of [timestamp_epoch, watts] pairs
    if (forecastResponse.pv?.slots?.length) {
      payload.pv_forecast = forecastResponse.pv.slots.map(s => [
        Math.floor(new Date(s.ts).getTime() / 1000),
        Number(s.watts) || 0
      ]);
    }

    // Price forecast: use fully-loaded prices for EOS (D-20) when enriched
    if (forecastResponse.price?.slots?.length) {
      const enrichedSlots = forecastResponse.price.slots;
      if (enrichedSlots[0]?.importCtKwh != null) {
        // Use pre-computed fully-loaded prices via toEosStrompreisArray
        payload.strompreis_euro_pro_wh = toEosStrompreisArray(enrichedSlots);
      } else {
        // Fallback: raw ctKwh (backwards compat)
        payload.price_forecast = enrichedSlots.map(s => [
          Math.floor(new Date(s.ts).getTime() / 1000),
          Number(s.ctKwh) || 0
        ]);
      }
    }

    // Load forecast: array of [timestamp_epoch, watts] pairs
    if (forecastResponse.load?.slots?.length) {
      payload.load_forecast = forecastResponse.load.slots.map(s => [
        Math.floor(new Date(s.ts).getTime() / 1000),
        Number(s.watts) || 0
      ]);
    }

    const result = await httpRequest('PUT', '/v1/prediction/list', payload);

    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true };
  }

  /**
   * Convert EOS plan format (hourly entries) to array of 15-min slots.
   * Each hourly entry becomes 4x 15-min slots with same power.
   *
   * @param {Array<{ start_time: string, battery_power: number }>} planEntries
   * @returns {Array<{ ts: number, endTs: number, powerW: number, confidence: number }>}
   */
  function convertEosPlanToSlots(planEntries) {
    const slots = [];

    for (const entry of planEntries) {
      const baseTs = new Date(entry.start_time + 'Z').getTime();
      const powerW = Number(entry.battery_power) || 0;

      // Split hourly entry into 4x 15-min slots
      for (let q = 0; q < 4; q++) {
        slots.push({
          ts: baseTs + q * QUARTER_HOUR_MS,
          endTs: baseTs + (q + 1) * QUARTER_HOUR_MS,
          powerW,
          confidence: EOS_DEFAULT_CONFIDENCE
        });
      }
    }

    return slots;
  }

  /**
   * Pull optimized schedule from EOS. Validates response structure (pinned to v0.3.0).
   * Returns null on ANY error (per research pitfall 3: defensive validation).
   *
   * @returns {Promise<Array<{ ts: number, endTs: number, powerW: number, confidence: number }>|null>}
   */
  async function pullSchedule() {
    const result = await httpRequest('GET', '/v1/energy-management/plan');

    if (!result.ok) {
      return null;
    }

    // Validate v0.3.0 structure: must contain 'result' key with array
    const plan = result.data;
    if (!plan || !Array.isArray(plan.result)) {
      return null;
    }

    try {
      return convertEosPlanToSlots(plan.result);
    } catch {
      return null;
    }
  }

  /**
   * Check if EOS is reachable and responding.
   *
   * @returns {Promise<boolean>}
   */
  async function isAvailable() {
    const result = await httpRequest('GET', '/v1/');
    return result.ok;
  }

  return { pushForecast, pullSchedule, isAvailable };
}
