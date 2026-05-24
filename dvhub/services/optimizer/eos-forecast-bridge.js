// services/optimizer/eos-forecast-bridge.js — Phase 22.1 (2026-05-24).
//
// Bridges DVhub's native 15-min forecasts (PV ensemble, EnergyCharts spot
// cache, hour-of-day load model) into EOS via PUT /v1/prediction/import/
// {provider_id} so the genetic optimizer sees the same data DVhub's own
// optimizer consumes. Without this, EOS pulls VRM independently — VRM only
// surfaces hourly forecasts AND lacks the Solcast+pvnode+OpenMeteo+ML
// ensemble DVhub already runs, so EOS plans on inferior inputs.
//
// Push contract:
//   - Format: PydanticDateTimeDataFrame
//       { data: {<key>: {<iso8601>: <value>}}, dtypes: {<key>: 'float64'},
//         tz: 'Europe/Berlin', datetime_columns: [] }
//   - Keys (EOS-canonical):
//       pvforecast_ac_power     [W]      from forecastService.buildForecastResponse().pv
//       loadforecast_power_w    [W]      from .load (hourly, forward-filled 4x)
//       elecprice_marketprice_wh [€/Wh]  from .price (ct/kWh ÷ 100000)
//   - Horizon: as many slots as available; EOS extends with last value via
//     fill_method='ffill' on its side if needed.
//
// Triggered:
//   - On boot (after eos-config-sync runs, before first ems.interval tick).
//   - On every saveAndApplyConfig() (config change may flip slot resolution).
//   - On the hourly EMS-tick offset (60s before ems.interval fires) via
//     setInterval started from createEosForecastBridge.start().
//
// Defensive: never throws, mirrors eos-adapter.js / eos-config-sync.js
// contract — { ok, pushed: string[], errors: object } per call.

import http from 'node:http';

const TIMEOUT_MS = 15_000; // bigger than config-sync because 192 rows × 3 keys
const SLOT_MS_15MIN = 15 * 60 * 1000;

/**
 * Convert a DVhub 15-min slot array into the {iso8601: value} map EOS expects
 * for a single dataframe column. Empty/null power values get skipped — EOS
 * tolerates sparse columns and fills with ffill.
 *
 * @param {Array<{start: string, powerW: number}>} slots
 * @returns {Object<string, number>}
 */
function slotsToTimeMap(slots) {
  const out = {};
  for (const s of slots) {
    if (!s?.start) continue;
    // Skip nullable values explicitly — Number(null) === 0 would silently
    // turn an "unknown" slot into a "0 W" data point, biasing the optimizer.
    if (s.powerW === null || s.powerW === undefined) continue;
    const v = Number(s.powerW);
    if (!Number.isFinite(v)) continue;
    // EOS accepts plain "YYYY-MM-DD HH:MM:SS" or ISO8601. Use ISO with
    // millisecond precision stripped (EOS' pendulum parser is strict).
    const iso = new Date(s.start).toISOString().replace('.000Z', 'Z');
    out[iso] = v;
  }
  return out;
}

/**
 * Forward-fill a 1-hour load slot grid into 15-minute granularity. EOS sees
 * 4× the row count with the same watt-value repeated per quarter — equivalent
 * to a step function. Acceptable because DVhub's load-forecast is itself a
 * hour-of-day SQL rollup; no real sub-hourly information exists upstream.
 *
 * @param {Array<{start: string, powerW: number}>} hourlySlots
 * @returns {Array<{start: string, powerW: number}>}
 */
function expandHourlyToQuarterHourly(hourlySlots) {
  const out = [];
  for (const s of hourlySlots) {
    if (!s?.start) continue;
    const baseMs = new Date(s.start).getTime();
    for (let q = 0; q < 4; q++) {
      out.push({
        start: new Date(baseMs + q * SLOT_MS_15MIN).toISOString(),
        powerW: s.powerW,
      });
    }
  }
  return out;
}

/**
 * Convert a DVhub price slot ({ctKwh}) to EOS' EUR/Wh format. EOS' canonical
 * unit for elecprice_marketprice_wh is EUR per watt-hour, NOT ct/kWh — divide
 * by 100 (ct→€) then by 1000 (kWh→Wh).
 *
 * @param {Array<{start: string, ctKwh: number}>} slots
 * @returns {Array<{start: string, powerW: number}>}  reused powerW field
 */
function priceSlotsToEosFormat(slots) {
  return slots
    .filter((s) => s?.start && Number.isFinite(Number(s.ctKwh)))
    .map((s) => ({
      start: s.start,
      powerW: Number(s.ctKwh) / 100 / 1000, // EUR/Wh
    }));
}

/**
 * Build the DataFrame payload for a single EOS *Import provider.
 *
 * @param {string} columnKey   - EOS canonical series key (e.g. "pvforecast_ac_power")
 * @param {Array<{start: string, powerW: number}>} slots
 * @param {string} tz          - default "Europe/Berlin"
 * @returns {object}             PydanticDateTimeDataFrame body
 */
function buildDataFrameBody(columnKey, slots, tz = 'Europe/Berlin') {
  return {
    data: { [columnKey]: slotsToTimeMap(slots) },
    dtypes: { [columnKey]: 'float64' },
    tz,
    datetime_columns: [],
  };
}

/**
 * Internal HTTP helper. Mirrors eos-config-sync.js — never throws,
 * returns { ok, data?, error? }.
 */
function eosHttpRequest(baseUrl, method, path, body) {
  return new Promise((resolve) => {
    try {
      const url = new URL(path, baseUrl);
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 8503,
        path: url.pathname,
        method,
        headers,
        timeout: TIMEOUT_MS,
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({ ok: false, error: `EOS HTTP ${res.statusCode}: ${chunks.slice(0, 300)}` });
            return;
          }
          try {
            resolve({ ok: true, data: chunks ? JSON.parse(chunks) : null });
          } catch {
            resolve({ ok: true, data: null });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message || 'EOS connect error' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'EOS timeout' }); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message || 'EOS request failed' });
    }
  });
}

/**
 * Create the bridge agent. Returns { push, start, stop }.
 *
 * @param {object} ctx - DI: { getCfg, pushLog, forecastService }
 * @returns {{
 *   push: () => Promise<{ok: boolean, pushed: string[], errors: object}>,
 *   start: () => void,
 *   stop: () => void,
 * }}
 */
export function createEosForecastBridge(ctx) {
  const { getCfg, pushLog, forecastService } = ctx;

  let tickHandle = null;

  /**
   * One push cycle: build the 3 payloads, PUT each. Sequential so that EOS'
   * disk-flush after each PUT doesn't race; the 15s timeout per call gives
   * plenty of headroom.
   */
  async function push() {
    const cfg = getCfg();
    const baseUrl = cfg?.optimizer?.eosProxy?.url || 'http://127.0.0.1:8503';

    if (cfg?.optimizer?.eosProxy?.enabled === false) {
      return { ok: true, pushed: [], errors: {}, skipped: 'eosProxy.enabled=false' };
    }

    if (!forecastService?.buildForecastResponse) {
      const err = 'forecastService.buildForecastResponse unavailable — bridge inactive';
      if (pushLog) pushLog('eos_forecast_bridge_skip', { reason: err });
      return { ok: false, pushed: [], errors: { bootstrap: err } };
    }

    let forecast;
    try {
      forecast = await forecastService.buildForecastResponse();
    } catch (e) {
      const err = `forecastService.buildForecastResponse failed: ${e.message}`;
      if (pushLog) pushLog('eos_forecast_bridge_error', { reason: err });
      return { ok: false, pushed: [], errors: { build: err } };
    }

    const pvSlots = forecast?.pv?.slots || [];
    const loadSlots = forecast?.load?.slots || [];
    const priceSlotsCt = forecast?.price?.slots || [];
    const tz = cfg?.optimizer?.timezone || 'Europe/Berlin';

    const tasks = [
      {
        provider: 'PVForecastImport',
        body: buildDataFrameBody('pvforecast_ac_power', pvSlots, tz),
        rows: pvSlots.length,
      },
      {
        provider: 'LoadImport',
        body: buildDataFrameBody(
          'loadforecast_power_w',
          expandHourlyToQuarterHourly(loadSlots),
          tz,
        ),
        rows: loadSlots.length * 4,
      },
      {
        provider: 'ElecPriceImport',
        body: buildDataFrameBody(
          'elecprice_marketprice_wh',
          priceSlotsToEosFormat(priceSlotsCt),
          tz,
        ),
        rows: priceSlotsCt.length,
      },
    ];

    const pushed = [];
    const errors = {};
    for (const t of tasks) {
      if (t.rows === 0) {
        errors[t.provider] = 'no slots available — skipping';
        continue;
      }
      const res = await eosHttpRequest(
        baseUrl,
        'PUT',
        `/v1/prediction/import/${t.provider}`,
        t.body,
      );
      if (res.ok) pushed.push(`${t.provider}(${t.rows})`);
      else errors[t.provider] = res.error;
    }

    const okAll = pushed.length === tasks.length;
    if (pushLog) {
      pushLog('eos_forecast_bridge', { ok: okAll, pushed, errors });
    }
    return { ok: okAll, pushed, errors };
  }

  /**
   * Start the hourly push cycle. Synchronizes to ems.interval by firing the
   * first push immediately (so EOS has fresh data BEFORE its first tick) and
   * then every 3600s. Hourly is the right cadence because all upstream
   * forecast pipelines update at most hourly — pushing more often than that
   * sends EOS the same numbers redundantly.
   */
  function start() {
    if (tickHandle) return;
    // Fire once at boot (after eos-config-sync.sync() has set the providers
    // to *Import variants); callers schedule the start() invocation.
    push().catch(() => {});
    tickHandle = setInterval(() => {
      push().catch(() => {});
    }, 3600 * 1000);
  }

  function stop() {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  return { push, start, stop };
}

// Exported for unit-tests.
export {
  slotsToTimeMap,
  expandHourlyToQuarterHourly,
  priceSlotsToEosFormat,
  buildDataFrameBody,
};
