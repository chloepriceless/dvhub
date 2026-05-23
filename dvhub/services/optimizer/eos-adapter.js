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
          // Phase 21 hotfix (2026-05-23): include url.search so
          // `?force_enable=true` reaches EOS. Without this the import
          // endpoints returned 404 because the per-provider flag stayed
          // off — silently broke every push since Phase 19.1-01.
          path: url.pathname + url.search,
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
            // Phase 21 hotfix (2026-05-23): EOS' import endpoints reply
            // 200 OK with content-length:0 (no body) — JSON.parse('')
            // then surfaces as a false "invalid JSON" error. Empty body
            // on a 2xx = success; only complain when content is present
            // but unparseable.
            if (chunks.length === 0) {
              resolve({ ok: true, data: null });
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
   * Phase 19.1-01: EOS v0.3.0 replaced PUT /v1/prediction/list with
   * PUT /v1/prediction/import/{provider_id} (per-provider import). We now
   * push three providers separately:
   *   - PVForecastImport       (PV power, W)
   *   - LoadImport             (load power, W)
   *   - ElecPriceImport        (electricity price, €/Wh)
   *
   * @param {object} forecastResponse - { pv: { slots }, price: { slots }, load: { slots } }
   * @returns {Promise<{ ok: boolean, error?: string, perProvider?: object }>}
   */
  async function pushForecast(forecastResponse) {
    const perProvider = {};
    const errors = [];

    // Phase 21 hotfix (2026-05-23): EOS v0.3.0 PUT /v1/prediction/import/{id}
    // returns HTTP 400 "Object of type PydanticDateTimeData is not JSON
    // serializable" when the body is the documented {timestamps, values}
    // (PydanticDateTimeData) shape — and HTTP 500 on PydanticDateTimeDataFrame.
    // The only shape that actually returns 200 is a plain dict mapping
    // ISO-string timestamps to numeric values. Empirically verified against
    // the live prod EOS (curl probe 2026-05-23). The OpenAPI's anyOf:[{},null]
    // schema is meaningless — pick what the implementation actually accepts.
    // Skip slots with missing/NaN ts so a single bad row doesn't kill the push.
    function buildDateTimeData(slots, valueFn) {
      const out = {};
      for (const s of slots) {
        if (!s) continue;
        const d = new Date(s.ts);
        if (Number.isNaN(d.getTime())) continue;
        out[d.toISOString()] = valueFn(s);
      }
      return out;
    }

    // PV
    if (forecastResponse.pv?.slots?.length) {
      const body = buildDateTimeData(forecastResponse.pv.slots, s => Number(s.watts) || 0);
      const res = await httpRequest('PUT', '/v1/prediction/import/PVForecastImport?force_enable=true', body);
      perProvider.pv = { ok: res.ok, error: res.error || null };
      if (!res.ok) errors.push(`PV: ${res.error}`);
    }

    // Load
    if (forecastResponse.load?.slots?.length) {
      const body = buildDateTimeData(forecastResponse.load.slots, s => Number(s.watts) || 0);
      const res = await httpRequest('PUT', '/v1/prediction/import/LoadImport?force_enable=true', body);
      perProvider.load = { ok: res.ok, error: res.error || null };
      if (!res.ok) errors.push(`Load: ${res.error}`);
    }

    // Price — convert to €/Wh; EOS ElecPriceImport expects ts+value pairs.
    if (forecastResponse.price?.slots?.length) {
      const enriched = forecastResponse.price.slots;
      const valueFn = enriched[0]?.importCtKwh != null
        ? s => (Number(s.importCtKwh) || 0) / 100000  // ct/kWh → €/Wh
        : s => (Number(s.ctKwh) || 0) / 100000;
      const body = buildDateTimeData(enriched, valueFn);
      const res = await httpRequest('PUT', '/v1/prediction/import/ElecPriceImport?force_enable=true', body);
      perProvider.price = { ok: res.ok, error: res.error || null };
      if (!res.ok) errors.push(`Price: ${res.error}`);
    }

    if (errors.length > 0) {
      return { ok: false, error: errors.join('; '), perProvider };
    }
    return { ok: true, perProvider };
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
    // EOS Akkudoktor FastAPI exposes /v1/health (returns {status:"alive",...}).
    // /v1/ returns 404 on EOS v0.3.0 (post-starlette<1.0 pin from Phase 18).
    const result = await httpRequest('GET', '/v1/health');
    return result.ok;
  }

  return { pushForecast, pullSchedule, isAvailable };
}
