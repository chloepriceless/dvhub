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
import { summarizeWeightedApplicableValue } from '../../history-runtime.js';

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
  const {
    getCfg,
    pushLog,
    forecastService,
    state,
    // Optional (Marktprämien-Modulation, 2026-06-21). Lazy accessors wired in
    // server.js; absent in tests/older builds → premium silently disabled.
    getSolarMarketValueSummary,
    getApplicableValueSummary,
  } = ctx;

  let tickHandle = null;
  let watchdogHandle = null;
  let lastEosPid = null;

  /**
   * Read the EOS process pid from /v1/health. The pid changes on every EOS
   * (re)start, so comparing it across polls is a reliable restart signal.
   * Returns null on any error (EOS unreachable / mid-restart) — the caller
   * treats null as "no decision, retry next poll".
   *
   * @param {string} baseUrl
   * @returns {Promise<number|null>}
   */
  async function readEosPid(baseUrl) {
    const res = await eosHttpRequest(baseUrl, 'GET', '/v1/health');
    const pid = res.ok && res.data ? Number(res.data.pid) : NaN;
    return Number.isFinite(pid) ? pid : null;
  }

  /**
   * Resolve the weighted "anzulegender Wert" (AW) in ct/kWh for the configured
   * PV plants. Prefers the explicit operator override; otherwise auto-computes
   * from BNetzA applicable values + pvPlants (same source the Historie page
   * uses, so the dispatch signal and the revenue KPI agree). Never throws —
   * returns null when AW can't be resolved (→ premium disabled, raw spot).
   *
   * @param {object} cfg
   * @returns {Promise<number|null>}
   */
  async function resolveApplicableValueCtKwh(cfg) {
    const uep = cfg?.userEnergyPricing || {};
    const override = Number(uep.applicableValueOverrideCtKwh);
    if (Number.isFinite(override) && override > 0) return override; // fast path, no async
    if (typeof getApplicableValueSummary !== 'function') return null;
    const pvPlants = Array.isArray(uep.pvPlants) ? uep.pvPlants : [];
    let summary;
    try {
      summary = await getApplicableValueSummary({ year: new Date().getUTCFullYear(), pvPlants });
    } catch {
      return null;
    }
    const r = summarizeWeightedApplicableValue({
      pvPlants,
      applicableValueSummary: summary,
      applicableValueOverrideCtKwh: uep.applicableValueOverrideCtKwh,
    });
    const aw = Number(r?.weightedApplicableValueCtKwh);
    return Number.isFinite(aw) ? aw : null;
  }

  /**
   * Resolve the *fixed* prior-year annual Solar market value (Jahresmarktwert)
   * in ct/kWh. Per operator directive (2026-06-21) the previous year's official
   * value is final and used as a constant — no rolling re-derivation. Never
   * throws — returns null when unavailable (→ premium disabled, raw spot).
   *
   * @returns {Promise<number|null>}
   */
  async function resolveAnnualMarketValueCtKwh() {
    if (typeof getSolarMarketValueSummary !== 'function') return null;
    const lastYear = new Date().getUTCFullYear() - 1;
    let summary;
    try {
      summary = await getSolarMarketValueSummary({ year: lastYear });
    } catch {
      return null;
    }
    const mw = Number(summary?.annualCtKwhByYear?.[lastYear]);
    return Number.isFinite(mw) ? mw : null;
  }

  /**
   * Market premium (ct/kWh) to add onto the spot export signal for EOS, so the
   * genetic optimizer values feed-in at the real EEG-Direktvermarktung margin
   * (spot + Marktprämie) instead of raw spot. Premium = max(0, AW − MW). Gated
   * behind optimizer.tariff.feedInIncludeMarketPremium (default OFF). Returns 0
   * when the gate is off or inputs are missing → push falls back to raw spot
   * (byte-identical to the pre-feature behaviour). Never throws.
   *
   * §51 (negative-price windows) is handled at the slot level by the caller:
   * the premium is only added to non-negative spot slots.
   *
   * @param {object} cfg
   * @returns {Promise<number>}
   */
  async function resolveFeedInMarketPremiumCtKwh(cfg) {
    const tariff = cfg?.optimizer?.tariff || {};
    if (tariff.feedInIncludeMarketPremium !== true) return 0;
    const [aw, mw] = await Promise.all([
      resolveApplicableValueCtKwh(cfg),
      resolveAnnualMarketValueCtKwh(),
    ]);
    if (!Number.isFinite(aw) || !Number.isFinite(mw)) {
      if (pushLog) pushLog('eos_feedin_premium_skip', { reason: 'AW or MW unavailable', aw, mw });
      return 0;
    }
    return Math.max(0, aw - mw);
  }

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
    // Market premium (ct/kWh) added onto non-negative spot slots so EOS values
    // feed-in at the real Direktvermarktung margin (spot + Marktprämie), not raw
    // spot. 0 when the gate is OFF (default) → the else-branch below reproduces
    // the exact original expression → byte-identical push. 2026-06-21.
    const premiumCt = await resolveFeedInMarketPremiumCtKwh(cfg);
    const feedInSlots = feedInSpot
      ? priceSlotsCt
          .filter((s) => s && s.start && Number.isFinite(Number(s.ctKwh)))
          .map((s) => {
            const spotCt = Number(s.ctKwh);
            // §51: premium only on non-negative spot. Gate OFF (premiumCt===0)
            // keeps the original (spot/100/1000)*factor expression untouched.
            const powerW = premiumCt > 0 && spotCt >= 0
              ? (spotCt * feedInFactor + premiumCt) / 100 / 1000
              : (spotCt / 100 / 1000) * feedInFactor;
            return { start: s.start, powerW };
          })
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
        // force_enable=true lets the import land even when this provider is not
        // the active one yet — the exact state on a FRESH INSTALL and right
        // after an EOS restart, before eos-config-sync flips load/pvforecast/
        // elecprice to the *Import providers. Without it EOS returns 404
        // "Provider not enabled" (server/eos.py:980), the forecast never
        // reaches EOS until a much later reconcile tick, and EOS plans on empty
        // data → no overnight reserve → the battery drains. No-op once the
        // provider is enabled (the EOS-side guard short-circuits).
        `/v1/prediction/import/${t.provider}?force_enable=true`,
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
   * @param {() => (void|Promise<void>)} [opts.beforePush] - run BEFORE each push.
   *   Use this to re-assert EOS config (eos-config-sync) ahead of the forecast
   *   import so a provider that an EOS restart reset back to its default is
   *   re-enabled before the import lands — otherwise EOS reads the stale
   *   default provider for up to a full interval. Preferred over afterPush.
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
   * @param {number} [opts.watchdogMs=60000] - EOS-restart watchdog poll interval.
   *   Polls /v1/health for the EOS pid; on a pid change (= EOS restarted) it runs
   *   a full reconcile tick immediately so providers + data recover in ~seconds
   *   instead of waiting up to intervalMs.
   */
  function start(opts = {}) {
    if (tickHandle) return;
    const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 3600 * 1000;
    const tick = async () => {
      // beforePush, push() and afterPush each log + swallow their own errors;
      // the timer callback must never throw.
      //
      // beforePush re-asserts EOS config (providers/interval) BEFORE the push,
      // so an EOS restart — which resets all API-set config back to its
      // defaults (providers disabled, interval 300) — is healed before the
      // forecast import lands, not a whole interval later. With sync-first the
      // *Import providers are active when the push arrives; the push's
      // force_enable=true covers the brief flip race either way.
      if (typeof opts.beforePush === 'function') {
        try { await opts.beforePush(); } catch { /* beforePush logs/swallows */ }
      }
      try { await push(); } catch { /* push() already logs */ }
      if (typeof opts.afterPush === 'function') {
        try { await opts.afterPush(); } catch { /* afterPush logs/swallows */ }
      }
    };
    if (opts.fireImmediately !== false) tick();
    tickHandle = setInterval(tick, intervalMs);

    // EOS-restart watchdog (2026-06-28). An EOS restart wipes ALL pushed
    // *Import series AND reverts some providers (observed: load/pvforecast fall
    // back to their EOS defaults; elecprice/interval survive). The persisted
    // config file only reliably preserves a subset, and the data is gone
    // regardless — so the only complete recovery is to re-assert config AND
    // re-push data. Without this, that recovery waited for the next forecast
    // tick (up to intervalMs, i.e. 15 min), during which EOS planned on stale
    // defaults + empty series. Polling the EOS pid (which changes on every
    // restart) lets us run a full reconcile within ~watchdogMs instead. The
    // reconcile reuses tick() so providers (beforePush=config-sync) are
    // re-flipped and forecasts+SoC re-pushed in one go.
    const watchdogMs = Number(opts.watchdogMs) > 0 ? Number(opts.watchdogMs) : 60_000;
    const watchdog = async () => {
      const cfg = getCfg();
      if (cfg?.optimizer?.eosProxy?.enabled === false) return;
      const baseUrl = cfg?.optimizer?.eosProxy?.url || 'http://127.0.0.1:8503';
      const pid = await readEosPid(baseUrl);
      if (pid === null) return; // EOS unreachable / still starting — decide next poll
      if (lastEosPid !== null && pid !== lastEosPid) {
        if (pushLog) pushLog('eos_restart_detected', { oldPid: lastEosPid, newPid: pid });
        lastEosPid = pid;
        await tick(); // re-assert providers + re-push data immediately
        return;
      }
      lastEosPid = pid;
    };
    watchdogHandle = setInterval(watchdog, watchdogMs);
  }

  function stop() {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
    if (watchdogHandle) {
      clearInterval(watchdogHandle);
      watchdogHandle = null;
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
