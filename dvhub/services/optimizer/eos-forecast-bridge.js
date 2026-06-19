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
 * EOS' PydanticDateTimeDataFrame schema (core/pydantic.py:995) is keyed
 * datetime-first, then column:
 *   data: { "<iso8601>": { "<column>": <value>, ... }, ... }
 * NOT column-first. A column-first shape ("data: {<column>: {<datetime>:
 * value}}") deserializes silently as 0 rows — the field_validator treats the
 * datetime strings as "columns" and the cross-check `next(iter(values))`
 * sees them as the column-set; the dataframe then has zero rows because the
 * inner dicts are empty after column-stripping.
 *
 * @param {string} columnKey   - EOS canonical series key (e.g. "pvforecast_ac_power")
 * @param {Array<{start: string, powerW: number}>} slots
 * @param {string} tz          - default "Europe/Berlin"
 * @returns {object}             PydanticDateTimeDataFrame body
 */
function buildDataFrameBody(columnKey, slots, tz = 'Europe/Berlin') {
  const timeMap = slotsToTimeMap(slots);
  const data = {};
  for (const [iso, value] of Object.entries(timeMap)) {
    data[iso] = { [columnKey]: value };
  }
  return {
    data,
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
        // Include url.search — the SoC measurement PUT passes datetime/key/
        // value entirely on the query string. The forecast import PUTs carry
        // no query string, so url.search is '' for them (unchanged behaviour).
        path: url.pathname + url.search,
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
  const { getCfg, pushLog, forecastService, state } = ctx;

  let tickHandle = null;

  /**
   * Push the current battery (and, when available, EV) State-of-Charge into
   * EOS' own measurement series. The genetic optimizer seeds its run with the
   * latest `*-soc-factor` measurement at ems.start_datetime
   * (geneticparams.py:440 / :511); without it the start SoC defaults to 0 and
   * any plan EOS produces is wrong (it "thinks" the battery is empty). DVhub
   * already records SoC every poll as telemetry `battery_soc_pct` — this just
   * forwards the live value to EOS.
   *
   * EOS measurement keys are device-derived (`battery1-soc-factor`,
   * `ev11-soc-factor`). We discover them from /v1/measurement/keys instead of
   * hard-coding device ids, so a device rename can't silently break the push.
   *
   * Value is the SoC *factor* (0..1) = percent / 100. Never throws.
   *
   * @param {string} baseUrl
   * @returns {Promise<{pushed: string[], errors: object, skipped?: string}>}
   */
  async function pushSoc(baseUrl) {
    const pushed = [];
    const errors = {};

    const socPct = Number(state?.victron?.soc);
    if (!Number.isFinite(socPct)) {
      return { pushed, errors, skipped: 'no live battery soc in state' };
    }
    const battFactor = Math.max(0, Math.min(1, socPct / 100));

    // EV SoC is best-effort: DVhub does not reliably populate it. When absent
    // we skip the EV key entirely (EOS then defaults that device to 0, which
    // is a clean no-op, not a hard error).
    const evPct = Number(state?.victron?.evSocPct);
    const evFactor = Number.isFinite(evPct) ? Math.max(0, Math.min(1, evPct / 100)) : null;

    const keysRes = await eosHttpRequest(baseUrl, 'GET', '/v1/measurement/keys');
    if (!keysRes.ok || !Array.isArray(keysRes.data)) {
      errors.soc = `could not read measurement keys: ${keysRes.error || 'unexpected shape'}`;
      return { pushed, errors };
    }
    const socKeys = keysRes.data.filter((k) => /-soc-factor$/.test(String(k)));
    // Stamp the SoC at the top of the current hour, NOT "now". EOS seeds the
    // optimizer with the latest measurement at/<= ems.start_datetime, and that
    // start is floored to the top of the current hour (observed plan
    // valid_from=HH:00). A "now" timestamp lands AFTER start_datetime, so EOS
    // looks back, misses it, and falls back to SoC=0 (empty battery) — the plan
    // then optimises from a wrong start state. Berlin is a whole-hour offset,
    // so flooring the UTC epoch to the hour aligns with local HH:00.
    const nowIso = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000)
      .toISOString()
      .replace('.000Z', 'Z');

    for (const key of socKeys) {
      const isEv = /(^|[^a-z])ev\d*-soc-factor$/.test(key);
      const value = isEv ? evFactor : battFactor;
      if (value === null) continue; // EV with no live value — skip cleanly
      // value rides as a query param (verified accepted by EOS 0.3.0); the
      // endpoint takes datetime/key/value all on the query string, no body.
      const path =
        `/v1/measurement/value?datetime=${encodeURIComponent(nowIso)}` +
        `&key=${encodeURIComponent(key)}&value=${value}`;
      const res = await eosHttpRequest(baseUrl, 'PUT', path);
      if (res.ok) pushed.push(`${key}=${value}`);
      else errors[key] = res.error;
    }

    return { pushed, errors };
  }

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

    // Import (Bezugs) price. In FIXED-tariff mode the operator pays a flat gross
    // ct/kWh (e.g. 26.9 ct) regardless of spot, so push THAT — not the raw spot
    // (~14 ct) the bridge would otherwise stream. Otherwise the GA prices grid
    // imports far too cheaply, making self-consumption look barely better than
    // selling, so it over-sells the battery at the evening peak and buys the
    // night back from the grid. With the real import price, self-consumption
    // (avoided ~26.9 ct) clearly beats feed-in (≤17 ct spot) and the battery
    // covers the night instead. Feed-in/Vermarktung stays spot (handled below).
    // 2026-05-30, operator request.
    const pricing = cfg?.userEnergyPricing || {};
    const fixedImportCt =
      String(pricing.mode || '').toLowerCase() === 'fixed'
        ? Number(pricing.fixedGrossImportCtKwh)
        : NaN;
    const importFixed = Number.isFinite(fixedImportCt) && fixedImportCt > 0;
    const elecpriceSlots = importFixed
      ? priceSlotsCt
          .filter((s) => s && s.start)
          .map((s) => ({ start: s.start, powerW: fixedImportCt / 100 / 1000 }))
      : priceSlotsToEosFormat(priceSlotsCt);

    // Feed-in tariff = spot price × feedInSpotFactor (€/Wh), pushed only in spot
    // mode (operator request 2026-05-29). Without this EOS values feed-in at the
    // flat EEG tariff (FeedInTariffEnergyCharts) and never discharges the battery
    // to grid at the high evening spot — with it, EOS plans evening Vermarktung
    // at peak prices and holds PV back from feed-in during negative windows.
    const tariff = cfg?.optimizer?.tariff || {};
    const feedInSpot = String(tariff.feedInMode || 'fixed').toLowerCase() === 'spot';
    const feedInFactor = Number.isFinite(Number(tariff.feedInSpotFactor)) ? Number(tariff.feedInSpotFactor) : 1.0;
    const feedInSlots = feedInSpot
      ? priceSlotsCt
          .filter((s) => s && s.start && Number.isFinite(Number(s.ctKwh)))
          .map((s) => ({ start: s.start, powerW: (Number(s.ctKwh) / 100 / 1000) * feedInFactor }))
      : [];

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
        body: buildDataFrameBody('elecprice_marketprice_wh', elecpriceSlots, tz),
        rows: elecpriceSlots.length,
      },
    ];
    if (feedInSpot && feedInSlots.length) {
      tasks.push({
        provider: 'FeedInTariffImport',
        body: buildDataFrameBody('feed_in_tariff_wh', feedInSlots, tz),
        rows: feedInSlots.length,
      });
    }

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

    // Forward the live battery SoC so EOS seeds its optimizer with the real
    // start state (not 0). Folded into the same cycle/cadence as the forecasts.
    const socRes = await pushSoc(baseUrl);
    for (const p of socRes.pushed) pushed.push(p);
    Object.assign(errors, socRes.errors);

    const okAll = pushed.length === tasks.length + socRes.pushed.length
      && Object.keys(socRes.errors).length === 0;
    if (pushLog) {
      pushLog('eos_forecast_bridge', { ok: okAll, pushed, errors, socSkipped: socRes.skipped });
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
  /**
   * Start the periodic reconcile timer.
   *
   * @param {object} [opts]
   * @param {() => (void|Promise<void>)} [opts.afterPush] - run AFTER each push,
   *   on the same tick. This is how the integration SELF-HEALS after an *EOS*
   *   restart: an EOS restart resets all API-set config (elecprice/load/
   *   pvforecast providers, optimization.interval, battery efficiency) back to
   *   its EOS.config.json defaults, and eos-config-sync otherwise only runs on
   *   DVhub boot/save. Wiring config-sync in here re-asserts that config every
   *   tick, so a reverted provider (e.g. elecprice -> EnergyCharts spot) is
   *   auto-reconciled within <=1 interval instead of needing a manual DVhub
   *   restart. push() runs BEFORE afterPush so the *Import series are fresh when
   *   the providers are re-flipped at them.
   * @param {number} [opts.intervalMs] - tick interval, default 3600_000 (1 h).
   * @param {boolean} [opts.fireImmediately=true] - run one tick now. Pass false
   *   when the caller already ran a boot reconcile (push->sync) just before.
   */
  function start(opts = {}) {
    if (tickHandle) return;
    const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 3600 * 1000;
    const tick = async () => {
      // push() and afterPush each log + swallow their own errors; the timer
      // callback must never throw.
      try { await push(); } catch { /* push() already logs */ }
      if (typeof opts.afterPush === 'function') {
        try { await opts.afterPush(); } catch { /* afterPush logs/swallows */ }
      }
    };
    if (opts.fireImmediately !== false) tick();
    tickHandle = setInterval(tick, intervalMs);
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

// Internal regexes exported for unit-tests of the SoC key classification.
export const SOC_KEY_RE = /-soc-factor$/;
export const EV_SOC_KEY_RE = /(^|[^a-z])ev\d*-soc-factor$/;
