// services/forecast/pvnode-client.js — pvnode.com PV forecast client (V2 API).
//
// T-PVNODE-V2 (2026-06-22) rewrite — migrated off the legacy /v1 query-string API
// onto the pvnode V2 REST API (api.pvnode.com/v2, openapi 2.0.0):
//   - ALL roof planes go in ONE request via the V2 `strings[]` array (V1 was capped
//     at 2 planes/request → ⌈N/2⌉ calls + slot-summing; that chunking is gone).
//   - Two request modes, decided by config:
//       * forecast.pvnode.siteId set → GET /v2/forecast/{site_id}   (saved, possibly
//         CALIBRATED site managed in the pvnode web-app — the operator's primary path)
//       * siteId empty                → POST /v2/forecast/inline      (geometry sent
//         inline from the configured pvPlants[]; works with no web-app setup)
//   - Same Bearer API key as V1 (one key works for both; V1 frozen, sunset 2026-12-31).
//   - V2 response timestamps are SITE-LOCAL wall-clock (no offset) + an IANA `timezone`
//     field — there is no `timezone=utc` param anymore. We convert local→UTC ourselves
//     (localWallClockToUtcIso) before anything hits the 15-min/ensemble pipeline, which
//     is UTC throughout.
//   - HTTP retry via p-retry (network + 5xx only); 401/403/429 → AbortError halts retries.
//   - Client-side monthly quota tracked via pvnodeQuota.increment() after each 2xx; on
//     HTTP 429 → pvnodeQuota.markExhausted() + cached data returned (no throw to caller).
//
// API: https://api.pvnode.com/v2  (15-minute resolution, Bearer auth)

import pRetry, { AbortError } from 'p-retry';

import { resolvePvnodePlan } from './pvnode-plans.js';

const PVNODE_BASE = 'https://api.pvnode.com/v2';

/**
 * Offset (wall-clock in `ianaTz` minus UTC) in ms at the given UTC instant.
 * Uses Intl.DateTimeFormat — no external tz library (none is bundled).
 *
 * @param {number} utcMs — epoch ms
 * @param {string} ianaTz — e.g. 'Europe/Berlin'
 * @returns {number} offset in ms (e.g. +7200000 for CEST)
 */
function tzOffsetMs(utcMs, ianaTz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some engines emit '24' for midnight under h23
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second)
  );
  return asUtc - utcMs;
}

/**
 * Convert a pvnode V2 site-local wall-clock timestamp into a UTC ISO string.
 *
 * V2 `ForecastValue.timestamp` / `HistoricalValue.timestamp` are ISO 8601 LOCAL time
 * WITHOUT an offset (e.g. "2026-06-22T14:00:00"), accompanied by the response-level
 * IANA `timezone` (e.g. "Europe/Berlin"). DVhub's pipeline is UTC end-to-end, so we
 * resolve the instant here.
 *
 * If the string already carries an explicit offset or 'Z', it is trusted as-is. If no
 * `ianaTz` is provided, the string is treated as UTC (best-effort). The two-pass offset
 * correction handles DST boundaries (the offset depends on the instant we are solving for).
 *
 * @param {string|number|null} localTs
 * @param {string|null} ianaTz
 * @returns {string|null} UTC ISO string, or null when unparseable
 */
export function localWallClockToUtcIso(localTs, ianaTz) {
  if (localTs == null) return null;
  const s = String(localTs).trim();
  if (!s) return null;
  // Explicit offset or Z present → trust it (just normalize).
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // No tz info at all → assume the wall-clock is already UTC.
  if (!ianaTz) {
    const d = new Date(`${s}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Interpret `s` as wall-clock in `ianaTz`: first treat it as UTC to get a guess,
  // then subtract the zone offset at that instant (refine once for DST edges).
  const guessMs = Date.parse(`${s}Z`);
  if (Number.isNaN(guessMs)) return null;
  const off1 = tzOffsetMs(guessMs, ianaTz);
  let utcMs = guessMs - off1;
  const off2 = tzOffsetMs(utcMs, ianaTz);
  if (off2 !== off1) utcMs = guessMs - off2;
  return new Date(utcMs).toISOString();
}

/**
 * Map DVhub sanitized pvPlants[] entries to V2 `strings[]` (InlinePVString).
 *
 * Geometry only: { slope, orientation, power_kw }. The V2 azimuth convention
 * (0=N, 90=E, 180=S, 270=W) matches DVhub's azimuthDeg natively — no offset.
 *
 * NOTE: V1's skyObstructionConfig/shadingConfig were free-form V1 query params; V2
 * expresses shading per-string as `near_field_shading` (a time-of-day × season matrix)
 * or site-level `config.shading`. The formats are NOT interchangeable, so we do NOT
 * forward those strings inline (a wrong format → HTTP 422). Operators who need shading
 * configure it on the saved site in the pvnode web-app (the siteId path).
 *
 * @param {Array<{kwp:number,tiltDeg:number,azimuthDeg:number}>} plants
 * @returns {Array<{slope:number,orientation:number,power_kw:number}>}
 */
export function buildStrings(plants) {
  if (!Array.isArray(plants)) return [];
  return plants
    .filter(p => Number(p?.kwp) > 0
      && Number.isFinite(Number(p?.tiltDeg))
      && Number.isFinite(Number(p?.azimuthDeg)))
    .map(p => ({
      slope: Number(p.tiltDeg),
      orientation: Number(p.azimuthDeg),
      power_kw: Number(p.kwp)
    }));
}

/**
 * Extract {ts_utc, power_w} rows from a V2 Forecast/Historical response body.
 *
 * Canonical V2 shape: { timezone, values: [{ timestamp, pv_power }, ...] }.
 * `pv_power` is nullable (e.g. at night) — null rows are skipped (the resample +
 * ensemble layers tolerate gaps). Timestamps are converted local→UTC using the
 * response `timezone`.
 *
 * Tolerant fallbacks (older/edge shapes, kept from the V1 client for robustness):
 *   arrays: values | forecasts | data | forecast | bare array
 *   ts fields:    timestamp | time | ts | ts_utc | datetime
 *   power fields: pv_power | power_w | power | watts
 *
 * @param {any} body — parsed JSON
 * @returns {Array<{ts_utc:string, power_w:number}>}
 */
export function extractValues(body) {
  let arr;
  let tz = null;
  if (Array.isArray(body)) {
    arr = body;
  } else if (body && typeof body === 'object') {
    tz = typeof body.timezone === 'string' ? body.timezone : null;
    arr = Array.isArray(body.values) ? body.values
        : Array.isArray(body.forecasts) ? body.forecasts
        : Array.isArray(body.data) ? body.data
        : Array.isArray(body.forecast) ? body.forecast
        : null;
  }
  if (!Array.isArray(arr)) return [];
  const rows = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const ts = e.timestamp ?? e.time ?? e.ts ?? e.ts_utc ?? e.datetime;
    const pw = e.pv_power ?? e.power_w ?? e.power ?? e.watts;
    if (ts == null || pw == null) continue;
    const power = Number(pw);
    if (!Number.isFinite(power)) continue;
    const iso = localWallClockToUtcIso(ts, tz);
    if (!iso) continue;
    rows.push({ ts_utc: iso, power_w: power });
  }
  return rows;
}

/**
 * Clamp a configured forecast horizon (days) to the V2-allowed range [1, 7].
 *
 * pvnode caps the horizon by license tier (Free = 48 h / 2 days; higher plans up to 7).
 * Requesting more than the plan allows is harmless — the API simply returns the plan
 * maximum. Empty/invalid config falls back to 2 (the Free-tier reality).
 *
 * @param {*} v - configured value (forecast.pvnode.forecastDays)
 * @param {number} [fallback=2]
 * @returns {number} integer in [1, 7]
 */
export function clampForecastDays(v, fallback = 2) {
  if (v == null || v === '') return fallback;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(7, n));
}

/** Resolve geo coordinates (forecast.location preferred, sma-automation fallback). */
function resolveLocation(cfg) {
  const fc = cfg.forecast || {};
  const lat = fc.location?.latitude
    ?? cfg.schedule?.smallMarketAutomation?.location?.latitude;
  const lon = fc.location?.longitude
    ?? cfg.schedule?.smallMarketAutomation?.location?.longitude;
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  return { lat: Number(lat), lon: Number(lon) };
}

/** Read + sanitize plants from cfg (pvPlants[] preferred, single-string legacy fallback). */
function resolvePlants(cfg) {
  const fc = cfg.forecast || {};
  const raw = Array.isArray(cfg.userEnergyPricing?.pvPlants)
    ? cfg.userEnergyPricing.pvPlants
    : [];
  const plants = raw
    .filter(p => Number(p?.kwp) > 0
      && Number.isFinite(Number(p?.tiltDeg))
      && Number.isFinite(Number(p?.azimuthDeg)))
    .map(p => ({
      kwp: Number(p.kwp),
      tiltDeg: Number(p.tiltDeg),
      azimuthDeg: Number(p.azimuthDeg)
    }));
  // Legacy single-string fallback: cfg.forecast.pv.totalKwp/tiltDeg/azimuthDeg.
  if (plants.length === 0 && Number(fc.pv?.totalKwp) > 0) {
    plants.push({
      kwp: Number(fc.pv.totalKwp),
      tiltDeg: Number(fc.pv.tiltDeg ?? 35),
      azimuthDeg: Number(fc.pv.azimuthDeg ?? 180)
    });
  }
  return plants;
}

/** Build the HTTP headers for a V2 request (Bearer auth; JSON content-type for POST). */
function authHeaders(apiKey, hasBody) {
  const h = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  if (hasBody) h['Content-Type'] = 'application/json';
  return h;
}

/**
 * Perform a single V2 request with p-retry. A fresh AbortSignal.timeout is created on
 * EACH attempt (a shared signal would already be aborted on the second try).
 *
 * @param {string} apiKey
 * @param {{url:string, method:string, body?:string|null, timeoutMs?:number}} req
 * @returns {Promise<any>} parsed JSON
 */
async function pvnodeFetch(apiKey, { url, method, body = null, timeoutMs = 20000 }) {
  return pRetry(
    async () => {
      const res = await fetch(url, {
        method,
        headers: authHeaders(apiKey, body != null),
        body: body != null ? body : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status === 429) throw new AbortError('pvnode_rate_limited');
      if (res.status === 401 || res.status === 403) throw new AbortError(`pvnode_auth_${res.status}`);
      if (!res.ok) throw new Error(`pvnode_http_${res.status}`);
      return res.json();
    },
    { retries: 3, factor: 2, minTimeout: 1000, maxTimeout: 10000 }
  );
}

/**
 * Build a V2 forecast/historical request descriptor.
 *
 * @param {{ kind:'forecast'|'historical', siteId?:string, lat?:number, lon?:number,
 *           plants?:Array, query:URLSearchParams, timeoutMs?:number }} args
 * @returns {{url:string, method:string, body:string|null, timeoutMs:number}}
 */
function buildRequest({ kind, siteId, lat, lon, plants, query, timeoutMs = 20000 }) {
  const qs = query.toString();
  if (siteId) {
    return {
      url: `${PVNODE_BASE}/${kind}/${encodeURIComponent(siteId)}${qs ? `?${qs}` : ''}`,
      method: 'GET',
      body: null,
      timeoutMs
    };
  }
  return {
    url: `${PVNODE_BASE}/${kind}/inline${qs ? `?${qs}` : ''}`,
    method: 'POST',
    body: JSON.stringify({ latitude: lat, longitude: lon, strings: buildStrings(plants) }),
    timeoutMs
  };
}

/**
 * Create the pvnode forecast client factory.
 *
 * @param {object} ctx - DI context { getCfg, pushLog }
 * @param {object} deps - { store, pvnodeQuota }
 */
export function createPvnodeClient(ctx, { store, pvnodeQuota } = {}) {
  const { getCfg, pushLog } = ctx;
  let lastFetchAt = 0;
  let cachedData = null;

  function getSiteId(cfg) {
    return String(cfg.forecast?.pvnode?.siteId ?? '').trim();
  }

  async function bumpQuota() {
    if (pvnodeQuota && typeof pvnodeQuota.increment === 'function') {
      await pvnodeQuota.increment(1);
    } else if (store && typeof store.incrementPvnodeQuota === 'function') {
      await store.incrementPvnodeQuota(1);
    }
  }

  /**
   * Fetch PV forecast — ONE V2 request (saved site or inline), 15-min slots in UTC.
   * Returns cached data on throttle / quota exhaustion / 429 (caller contract stable).
   * @returns {Promise<Array<{ts_utc:string,power_w:number}>|null>}
   */
  async function fetchForecast() {
    const cfg = getCfg(); // QUAL-05: never cache at module scope
    // Poll cadence is plan-derived (budget-aware): Free 12 h, Light 1 h, Plus
    // 15 min, Enterprise/override custom — floored at 15 min. No point fetching
    // faster than the plan recomputes, and the monthly quota bounds the rate.
    const plan = resolvePvnodePlan(cfg);
    const now = Date.now();
    if (now - lastFetchAt < plan.fetchIntervalMs) {
      return cachedData;
    }
    const apiKey = cfg.forecast?.pvnode?.apiKey;
    if (!apiKey) {
      pushLog('pvnode_skip', { reason: 'missing_apikey' });
      return null;
    }

    // Quota-exhausted flag BEFORE any network call.
    if (pvnodeQuota && typeof pvnodeQuota.isExhausted === 'function' && pvnodeQuota.isExhausted()) {
      pushLog('pvnode_skipped_quota_exhausted', {});
      return cachedData;
    }

    const siteId = getSiteId(cfg);
    // Horizon is config-driven (clamped 1..7) AND capped at the plan maximum
    // (Free 2 d, paid 7 d) so we never request beyond what the plan delivers.
    const forecastDays = Math.min(plan.maxForecastDays, clampForecastDays(cfg.forecast?.pvnode?.forecastDays));
    const query = new URLSearchParams({ forecast_days: String(forecastDays) });
    let req;
    if (siteId) {
      req = buildRequest({ kind: 'forecast', siteId, query });
    } else {
      // Inline mode needs location + plants.
      const loc = resolveLocation(cfg);
      if (!loc) {
        pushLog('pvnode_skip', { reason: 'missing_location' });
        return null;
      }
      const plants = resolvePlants(cfg);
      if (plants.length === 0) {
        pushLog('pvnode_skip', { reason: 'no_plants_configured' });
        return null;
      }
      req = buildRequest({ kind: 'forecast', lat: loc.lat, lon: loc.lon, plants, query });
    }

    let data;
    try {
      data = await pvnodeFetch(apiKey, req);
      await bumpQuota();
      pushLog('pvnode_ok', { mode: siteId ? 'site' : 'inline' });
    } catch (err) {
      pushLog('pvnode_error', { error: err?.message || String(err) });
      if (err && err.name === 'AbortError') {
        if (err.message === 'pvnode_rate_limited'
            && pvnodeQuota && typeof pvnodeQuota.markExhausted === 'function') {
          pvnodeQuota.markExhausted(3600);
          pushLog('pvnode_throttled', { retryAfterSeconds: 3600 });
        }
      }
      return cachedData;
    }

    const points = extractValues(data)
      .map(s => ({ ts_utc: s.ts_utc, power_w: Math.round(s.power_w * 10) / 10 }))
      .sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));

    // Persist to DB (non-blocking — log but don't fail).
    if (store && typeof store.writePvForecasts === 'function' && points.length > 0) {
      const storeRows = points.map(s => ({
        model: 'pvnode',
        ts_utc: s.ts_utc,
        power_w: s.power_w,
        confidence: 0.75 // 15-min resolution
      }));
      store.writePvForecasts(storeRows).catch(e =>
        pushLog('pvnode_persist_error', { error: e?.message || String(e) })
      );
    }

    lastFetchAt = Date.now();
    cachedData = points;
    return points;
  }

  /**
   * Fetch historical PV production for a date range — used by pvnode-backfill.
   *
   * V2 takes the whole [start_date, end_date] window AND all planes in ONE request
   * (saved site or inline), so this is a single API call → planeGroupsCalled = 1
   * (the V1 ⌈N/2⌉ plane-group chunking is gone). NOT throttled (admin-triggered).
   *
   * @param {{startDate:string,endDate:string}} args  YYYY-MM-DD inclusive
   * @returns {Promise<{slots:Array<{ts_utc:string,power_w:number}>, planeGroupsCalled:number}>}
   */
  async function fetchHistory({ startDate, endDate } = {}) {
    const cfg = getCfg();
    const apiKey = cfg.forecast?.pvnode?.apiKey;
    if (!apiKey) throw new Error('pvnode_not_configured');

    const siteId = getSiteId(cfg);
    const query = new URLSearchParams({ start_date: startDate, end_date: endDate });
    let req;
    if (siteId) {
      req = buildRequest({ kind: 'historical', siteId, query, timeoutMs: 30000 });
    } else {
      const loc = resolveLocation(cfg);
      if (!loc) throw new Error('pvnode_no_coords');
      const plants = resolvePlants(cfg);
      if (plants.length === 0) throw new Error('pvnode_no_plants');
      req = buildRequest({ kind: 'historical', lat: loc.lat, lon: loc.lon, plants, query, timeoutMs: 30000 });
    }

    const data = await pvnodeFetch(apiKey, req);
    await bumpQuota();
    pushLog('pvnode_history_ok', { startDate, endDate, mode: siteId ? 'site' : 'inline' });

    const slots = extractValues(data)
      .map(s => ({ ts_utc: s.ts_utc, power_w: Math.round(s.power_w * 10) / 10 }))
      .sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));

    return { slots, planeGroupsCalled: 1 };
  }

  return {
    fetchForecast,
    fetchHistory,
    get lastFetchAt() { return lastFetchAt; },
    get isConfigured() { return Boolean(getCfg().forecast?.pvnode?.apiKey); }
  };
}

/**
 * Single-shot probe for the credential editor ("Probe-Anfrage" button) — V2.
 *
 * If `siteId` is given, probes the saved site (GET /v2/forecast/{site_id}?forecast_days=1);
 * otherwise an inline single-string forecast (POST /v2/forecast/inline). State-free:
 * no pRetry, no quota increment, no cache/store mutation. Always resolves with
 * {ok, sample?, error?} — never throws.
 *
 * @param {{ apiKey:string, siteId?:string, lat?:number, lon?:number,
 *           slope?:number, orientation?:number, kwp?:number }} args
 * @returns {Promise<{ok:boolean, sample?:{ts:string|null, watts:number}|null, error?:string}>}
 */
export async function probePvnode({ apiKey, siteId, lat, lon, slope = 30, orientation = 180, kwp = 1 }) {
  if (!apiKey) return { ok: false, error: 'missing_apikey' };
  const sid = String(siteId ?? '').trim();
  const query = new URLSearchParams({ forecast_days: '1' });
  const req = sid
    ? buildRequest({ kind: 'forecast', siteId: sid, query })
    : buildRequest({
        kind: 'forecast',
        lat, lon,
        plants: [{ kwp, tiltDeg: slope, azimuthDeg: orientation }],
        query
      });
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: authHeaders(apiKey, req.body != null),
      body: req.body != null ? req.body : undefined,
      signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) return { ok: false, error: `pvnode HTTP ${res.status}` };
    const data = await res.json();
    const rows = extractValues(data);
    const first = rows[0] || null;
    if (!first) return { ok: true, sample: null };
    return { ok: true, sample: { ts: first.ts_utc, watts: Math.round(first.power_w) } };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
