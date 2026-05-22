// services/forecast/pvnode-client.js — pvnode.com PV forecast client (multi-plane).
//
// Phase 07 Wave 1 (Plan 07-02) refactor:
//   - Endpoint migrated to api.pvnode.com/v1/forecast/ (GET+URLSearchParams). The pre-refactor
//     client used the legacy *.io host with POST+JSON; both have been replaced.
//   - Multi-plane support: for N pvPlants, issue ⌈N/2⌉ GETs using second_array_* query params.
//   - Azimuth convention native to pvnode.com: 0=N, 180=S (the old "-180 offset" has been removed).
//   - HTTP retry via p-retry (network + 502/503/504 only); AbortError on 401/403/429 halts retries.
//   - Client-side monthly quota tracked via pvnodeQuota.increment() after each 2xx (REVIEWS L2).
//   - On HTTP 429: pvnodeQuota.markExhausted() + cached data returned (no throw to caller).
//   - odd-N chunk rule (REVIEWS H6 LOCKED): the LARGEST plant is isolated alone; the remaining
//     smaller plants pair up in descending chunks of 2.
//   - Two independent pvnode config query params (REVIEWS H7 LOCKED):
//       skyObstructionConfig → sky_obstruction_config (horizon profile, direct-sun shading)
//       shadingConfig        → shading_config (inter-row / tracker shading)
//
// API: https://api.pvnode.com  (15-minute resolution, Bearer-auth, quota NOT in headers)

import pRetry, { AbortError } from 'p-retry';

const PVNODE_BASE = 'https://api.pvnode.com/v1';

/**
 * Chunk a pvPlants[] array into groups of at most 2 (pvnode API limit: 2 planes per request).
 *
 * For odd N, REVIEWS H6 LOCKED RULE: the LARGEST plant is isolated alone as the first group;
 * the remaining smaller plants pair up in descending chunks of 2. Rationale: pairing smaller
 * plants yields smaller absolute forecast error when summed, while the largest plant alone
 * keeps its single-plane accuracy.
 *
 * @param {Array<{kwp:number,tiltDeg:number,azimuthDeg:number,skyObstructionConfig?:string,shadingConfig?:string}>} pvPlants
 * @returns {Array<Array>} chunked groups (each group has length 1 or 2)
 */
export function chunkPlants(pvPlants) {
  if (!Array.isArray(pvPlants) || pvPlants.length === 0) return [];
  const sorted = [...pvPlants].sort((a, b) => (b.kwp ?? 0) - (a.kwp ?? 0));
  const groups = [];
  // odd N: isolate largest plant alone (REVIEWS H6)
  // Rationale: the largest plant alone means the remaining (smaller) plants pair up,
  // and paired groups have smaller absolute forecast error than isolating the smallest.
  let start = 0;
  if (sorted.length % 2 === 1) {
    groups.push([sorted[0]]);
    start = 1;
  }
  for (let i = start; i < sorted.length; i += 2) {
    groups.push(sorted.slice(i, i + 2));
  }
  return groups;
}

/**
 * Build URLSearchParams for a single pvnode forecast request (1 or 2 planes).
 *
 * Global-per-request config params (REVIEWS H7 LOCKED — INDEPENDENT):
 *   sky_obstruction_config — horizon profile for direct-sun shading
 *   shading_config         — inter-row shading (tracker systems)
 * Both are read from plants[0] (pvnode treats them as global-per-request; only one value
 * per param per request).
 *
 * Azimuth convention: 0=N, 180=S natively — NO -180 offset (api.pvnode.com openapi.json).
 *
 * @param {{ lat:number, lon:number, plants:Array, forecastDays?:number, nowcast?:boolean, timezone?:string }} args
 * @returns {URLSearchParams}
 */
export function buildQueryParams({ lat, lon, plants, forecastDays = 7, nowcast = true, timezone = 'utc' }) {
  if (!Array.isArray(plants) || plants.length === 0) {
    throw new Error('buildQueryParams: plants must be a non-empty array');
  }
  const q = new URLSearchParams();
  q.set('latitude', String(lat));
  q.set('longitude', String(lon));
  q.set('forecast_days', String(forecastDays));
  q.set('nowcast', String(nowcast));
  q.set('timezone', timezone);
  q.set('required_data', 'spec_watts,temp');
  q.set('pv_only', 'true');

  const p0 = plants[0];
  q.set('slope', String(p0.tiltDeg));
  q.set('orientation', String(p0.azimuthDeg)); // 0=N, 180=S — NO -180 offset
  q.set('pv_power_kw', String(p0.kwp));

  if (plants[1]) {
    const p1 = plants[1];
    q.set('second_array_slope', String(p1.tiltDeg));
    q.set('second_array_orientation', String(p1.azimuthDeg));
    q.set('second_array_power_kw', String(p1.kwp));
  }

  // REVIEWS H7: two INDEPENDENT global-per-request config params, from plants[0]
  //   skyObstructionConfig → sky_obstruction_config (horizon profile)
  //   shadingConfig        → shading_config (inter-row / tracker shading)
  if (typeof plants[0].skyObstructionConfig === 'string' && plants[0].skyObstructionConfig.length > 0) {
    q.set('sky_obstruction_config', plants[0].skyObstructionConfig);
  }
  if (typeof plants[0].shadingConfig === 'string' && plants[0].shadingConfig.length > 0) {
    q.set('shading_config', plants[0].shadingConfig);
  }

  return q;
}

/**
 * Floor a UTC timestamp string to the nearest 15-minute boundary (Pitfall M-2 protection
 * when slot-summing across multiple groups with potentially mis-aligned timestamps).
 *
 * @param {string} tsUtc — ISO-8601 UTC timestamp
 * @returns {string} ISO-8601 timestamp floored to XX:00, :15, :30, or :45
 */
function floorToQuarterIso(tsUtc) {
  const d = new Date(tsUtc);
  const minutes = d.getUTCMinutes();
  d.setUTCMinutes(Math.floor(minutes / 15) * 15, 0, 0);
  return d.toISOString();
}

/**
 * Extract {ts_utc, power_w} rows from a pvnode /v1/forecast/ response body.
 *
 * The OpenAPI spec declares the response as an "inline unspecified" object. The 2026-04-16
 * probe script (scripts/probe-pvnode-headers.js) has not yet been executed against a live
 * key, so this helper mirrors the field-name-tolerant parsing of the pre-refactor client.
 *
 * Accepted shapes (in priority order):
 *   1. { forecasts: [{ timestamp, power_w }, ...] }
 *   2. { data:      [{ timestamp, power_w }, ...] }
 *   3. [{ timestamp, power_w }, ...]  (bare array)
 * Field synonyms per element: timestamp|time|ts, power_w|power|watts
 *
 * @param {any} data — parsed JSON body
 * @returns {Array<{ts_utc:string, power_w:number}>}
 */
function extractPowerSeries(data) {
  let arr;
  if (Array.isArray(data)) {
    arr = data;
  } else if (Array.isArray(data?.forecasts)) {
    arr = data.forecasts;
  } else if (Array.isArray(data?.data)) {
    arr = data.data;
  } else {
    return [];
  }
  const rows = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const ts = entry.timestamp ?? entry.time ?? entry.ts ?? entry.ts_utc;
    const pw = entry.power_w ?? entry.power ?? entry.watts;
    if (ts == null || pw == null) continue;
    const power = Number(pw);
    if (!Number.isFinite(power)) continue;
    let isoTs;
    try {
      isoTs = new Date(ts).toISOString();
    } catch {
      continue;
    }
    rows.push({ ts_utc: isoTs, power_w: power });
  }
  return rows;
}

/**
 * Execute one GET request against /v1/forecast/ for a single plane-group, with p-retry.
 *
 * Retry policy:
 *   - network / 5xx (non-4xx) errors → retry up to 3 times, exponential backoff
 *   - 401 / 403 / 429 → AbortError (halt retries; caller handles 429 specifically)
 *
 * @param {string} apiKey
 * @param {URLSearchParams} params
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{data:any, status:number}>}
 */
async function fetchGroup(apiKey, params, opts = {}) {
  const url = `${PVNODE_BASE}/forecast/?${params.toString()}`;
  return pRetry(
    async () => {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000)
      });
      if (res.status === 429) throw new AbortError('pvnode_rate_limited');
      if (res.status === 401 || res.status === 403) throw new AbortError(`pvnode_auth_${res.status}`);
      if (!res.ok) throw new Error(`pvnode_http_${res.status}`);
      return { data: await res.json(), status: res.status };
    },
    { retries: 3, factor: 2, minTimeout: 1000, maxTimeout: 10000 }
  );
}

/**
 * Create the pvnode forecast client factory.
 *
 * @param {object} ctx - DI context { getCfg, pushLog }
 * @param {object} deps - { store, pvnodeQuota }
 *   - store: forecast-store (needed for writePvForecasts persistence, fallback quota)
 *   - pvnodeQuota: single quota authority (REVIEWS L2). If absent, fallback to store.incrementPvnodeQuota
 *     during transitional wiring — full integration wires pvnodeQuota in Plan 07-03+.
 */
export function createPvnodeClient(ctx, { store, pvnodeQuota } = {}) {
  const { getCfg, pushLog } = ctx;
  const MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 min between fetches
  let lastFetchAt = 0;
  let cachedData = null;

  /**
   * Fetch PV forecast — serially iterates plane-groups, sums power_w per 15-min slot.
   * Returns cached data on throttle / quota exhaustion / 429 to keep the caller contract stable.
   * @returns {Promise<Array<{ts_utc:string,power_w:number}>|null>}
   */
  async function fetchForecast() {
    const now = Date.now();
    if (now - lastFetchAt < MIN_INTERVAL_MS) {
      return cachedData;
    }

    const cfg = getCfg(); // QUAL-05: never cache at module scope
    const apiKey = cfg.forecast?.pvnode?.apiKey;
    if (!apiKey) {
      pushLog('pvnode_skip', { reason: 'missing_apikey' });
      return null;
    }

    // REVIEWS L2: check quota-exhausted flag BEFORE any network call
    if (pvnodeQuota && typeof pvnodeQuota.isExhausted === 'function' && pvnodeQuota.isExhausted()) {
      pushLog('pvnode_skipped_quota_exhausted', {});
      return cachedData;
    }

    // Resolve geo coordinates (forecast.location preferred, SMA fallback)
    const fc = cfg.forecast || {};
    const lat = fc.location?.latitude
      ?? cfg.schedule?.smallMarketAutomation?.location?.latitude;
    const lon = fc.location?.longitude
      ?? cfg.schedule?.smallMarketAutomation?.location?.longitude;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
      pushLog('pvnode_skip', { reason: 'missing_location' });
      return null;
    }

    // Read plants from config-model-sanitized pvPlants[] (D-A2, REVIEWS H7 locked field names)
    const rawPlants = Array.isArray(cfg.userEnergyPricing?.pvPlants)
      ? cfg.userEnergyPricing.pvPlants
      : [];
    const plants = rawPlants
      .filter(p => Number(p?.kwp) > 0
        && Number.isFinite(Number(p?.tiltDeg))
        && Number.isFinite(Number(p?.azimuthDeg)))
      .map(p => ({
        kwp: Number(p.kwp),
        tiltDeg: Number(p.tiltDeg),
        azimuthDeg: Number(p.azimuthDeg),
        skyObstructionConfig: p.skyObstructionConfig, // REVIEWS H7
        shadingConfig: p.shadingConfig                 // REVIEWS H7
      }));

    // Single-string fallback: legacy cfg.forecast.pv.totalKwp/tiltDeg/azimuthDeg (pre-D-A2 configs)
    if (plants.length === 0 && Number(fc.pv?.totalKwp) > 0) {
      plants.push({
        kwp: Number(fc.pv.totalKwp),
        tiltDeg: Number(fc.pv.tiltDeg ?? 35),
        azimuthDeg: Number(fc.pv.azimuthDeg ?? 180)
      });
    }

    if (plants.length === 0) {
      pushLog('pvnode_skip', { reason: 'no_plants_configured' });
      return null;
    }

    const groups = chunkPlants(plants);
    const results = [];
    for (const group of groups) {
      try {
        const params = buildQueryParams({ lat: Number(lat), lon: Number(lon), plants: group });
        const { data } = await fetchGroup(apiKey, params);
        results.push(data);

        // REVIEWS L2: route quota through pvnodeQuota (fallback to store if pvnodeQuota absent)
        if (pvnodeQuota && typeof pvnodeQuota.increment === 'function') {
          await pvnodeQuota.increment(1);
        } else if (store && typeof store.incrementPvnodeQuota === 'function') {
          await store.incrementPvnodeQuota(1);
        }
        pushLog('pvnode_ok', { planes: group.length });
      } catch (err) {
        pushLog('pvnode_error', { error: err?.message || String(err), planes: group.length });
        if (err && err.name === 'AbortError') {
          if (err.message === 'pvnode_rate_limited'
              && pvnodeQuota && typeof pvnodeQuota.markExhausted === 'function') {
            pvnodeQuota.markExhausted(3600);
            pushLog('pvnode_throttled', { retryAfterSeconds: 3600 });
          }
          return cachedData;
        }
        // Non-abort error already retried by p-retry; give up on this group and continue
      }
    }

    // Slot-wise sum across all groups (Pitfall M-2: floor to 15-min boundary to align groups)
    const merged = new Map();
    for (const data of results) {
      const rows = extractPowerSeries(data);
      for (const { ts_utc, power_w } of rows) {
        const key = floorToQuarterIso(ts_utc);
        merged.set(key, (merged.get(key) ?? 0) + power_w);
      }
    }

    const points = [...merged.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts_utc, power_w]) => ({ ts_utc, power_w: Math.round(power_w * 10) / 10 }));

    // Persist to DB (non-blocking error recovery — log but don't fail)
    if (store && typeof store.writePvForecasts === 'function' && points.length > 0) {
      const storeRows = points.map(s => ({
        model: 'pvnode',
        ts_utc: s.ts_utc,
        power_w: s.power_w,
        confidence: 0.75 // 15-min resolution (kept from pre-refactor client)
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
   * Fetch historical PV production for a date range — used by pvnode-backfill (Plan 07-03).
   *
   * Endpoint: GET /v1/history/?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD + same plane params
   * as /v1/forecast. Iterates chunkPlants(plants) groups serially, sums power_w per 15-min slot
   * across plane-groups, returns an aligned slot array.
   *
   * NOT subject to MIN_INTERVAL_MS throttling (admin-triggered, different semantics).
   * Uses a longer 30s timeout per request (history responses are larger than forecast).
   *
   * Quota routed through pvnodeQuota.increment() per plane-group (REVIEWS L2 consistency with
   * fetchForecast); falls back to store.incrementPvnodeQuota when pvnodeQuota is absent.
   *
   * REVIEWS H8: returns `planeGroupsCalled` so pvnode-backfill can track apiCallsUsed
   * accurately — no more fixed `+= 2` constant approximation.
   *
   * @param {{startDate:string,endDate:string,plants?:Array}} args
   *   startDate/endDate: YYYY-MM-DD strings (inclusive boundaries per REVIEWS H8)
   *   plants: optional override; falls back to cfg.userEnergyPricing.pvPlants sanitized list
   * @returns {Promise<{slots:Array<{ts_utc:string,power_w:number}>, planeGroupsCalled:number}>}
   */
  async function fetchHistory({ startDate, endDate, plants: overridePlants } = {}) {
    const cfg = getCfg();
    const apiKey = cfg.forecast?.pvnode?.apiKey;
    if (!apiKey) throw new Error('pvnode_not_configured');

    const fc = cfg.forecast || {};
    const lat = fc.location?.latitude
      ?? cfg.schedule?.smallMarketAutomation?.location?.latitude;
    const lon = fc.location?.longitude
      ?? cfg.schedule?.smallMarketAutomation?.location?.longitude;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
      throw new Error('pvnode_no_coords');
    }

    // Use override plants (admin-controlled) or fall back to config plants
    let plants = overridePlants;
    if (!Array.isArray(plants) || plants.length === 0) {
      const rawPlants = Array.isArray(cfg.userEnergyPricing?.pvPlants)
        ? cfg.userEnergyPricing.pvPlants
        : [];
      plants = rawPlants
        .filter(p => Number(p?.kwp) > 0
          && Number.isFinite(Number(p?.tiltDeg))
          && Number.isFinite(Number(p?.azimuthDeg)))
        .map(p => ({
          kwp: Number(p.kwp),
          tiltDeg: Number(p.tiltDeg),
          azimuthDeg: Number(p.azimuthDeg),
          skyObstructionConfig: p.skyObstructionConfig,
          shadingConfig: p.shadingConfig
        }));
    }
    if (plants.length === 0) throw new Error('pvnode_no_plants');

    const groups = chunkPlants(plants);
    const merged = new Map();
    let planeGroupsCalled = 0;

    for (const group of groups) {
      const q = buildQueryParams({
        lat: Number(lat),
        lon: Number(lon),
        plants: group,
        nowcast: false
      });
      // Swap forecast-specific params for history-specific params:
      q.delete('forecast_days');
      q.delete('past_days');
      q.delete('nowcast');
      q.set('start_date', startDate);
      q.set('end_date', endDate);

      const url = `${PVNODE_BASE}/history/?${q.toString()}`;
      const data = await pRetry(
        async () => {
          const r = await fetch(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(30000) // longer timeout for history range
          });
          if (r.status === 429) throw new AbortError('pvnode_rate_limited');
          if (r.status === 401 || r.status === 403) throw new AbortError(`pvnode_auth_${r.status}`);
          if (!r.ok) throw new Error(`pvnode_history_http_${r.status}`);
          return r.json();
        },
        { retries: 3, factor: 2, minTimeout: 1000, maxTimeout: 10000 }
      );

      // REVIEWS L2: route quota through pvnodeQuota (fallback to store.incrementPvnodeQuota)
      if (pvnodeQuota && typeof pvnodeQuota.increment === 'function') {
        await pvnodeQuota.increment(1);
      } else if (store && typeof store.incrementPvnodeQuota === 'function') {
        await store.incrementPvnodeQuota(1);
      }
      planeGroupsCalled += 1;
      pushLog('pvnode_history_ok', { startDate, endDate, planes: group.length });

      const rows = extractPowerSeries(data);
      for (const { ts_utc, power_w } of rows) {
        const key = floorToQuarterIso(ts_utc);
        merged.set(key, (merged.get(key) ?? 0) + power_w);
      }
    }

    const slots = [...merged.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts_utc, power_w]) => ({ ts_utc, power_w: Math.round(power_w * 10) / 10 }));

    // REVIEWS H8 accurate counter: expose actual plane-group call count to caller
    return { slots, planeGroupsCalled };
  }

  return {
    fetchForecast,
    fetchHistory,
    get lastFetchAt() { return lastFetchAt; },
    get isConfigured() { return Boolean(getCfg().forecast?.pvnode?.apiKey); }
  };
}

/**
 * Phase 20-06 (D-11): single-shot probe for the credential editor.
 *
 * Operator clicks "Probe-Anfrage" on the pvnode tab of the Forecast-Provider
 * drawer; this helper performs a minimal upstream call (forecastDays=1) to
 * verify the apiKey + plant geometry round-trip. The pvnode free tier is
 * 40 calls/MONTH (Pitfall 4) — 10× tighter than Solcast — so the UI also
 * shows a "Free-Tarif: 40 Aufrufe/Monat — sparsam testen" warning.
 *
 * IMPORTANT: this helper is intentionally state-free —
 *   - does NOT use pRetry (a single one-off operator click, not a fetch loop)
 *   - does NOT increment pvnodeQuota (the operator triggered this — they own
 *     the 40/month budget; the route-layer checkProviderRateLimit caps
 *     accidental spam)
 *   - does NOT mutate cachedData or lastFetchAt on the production client
 *   - does NOT persist to the forecast-store
 *
 * Always resolves with `{ok, sample?, error?}` — never throws (T-20-06-06).
 *
 * @param {{ apiKey:string, lat:number, lon:number, slope?:number, orientation?:number, kwp?:number, nowcast?:boolean }} args
 * @returns {Promise<{ok:boolean, sample?:{ts:string|null, watts:number}|null, error?:string}>}
 */
export async function probePvnode({ apiKey, lat, lon, slope = 30, orientation = 180, kwp = 1, nowcast = false }) {
  if (!apiKey) return { ok: false, error: 'missing_apikey' };
  // WR-01: reuse buildQueryParams so the probe shape (latitude/longitude/
  // forecast_days/pv_power_kw/nowcast/required_data/pv_only/timezone) matches
  // the production fetch. The pre-fix probe used lat/lon/forecastDays which
  // the api.pvnode.com openapi.json rejects with HTTP 422.
  const params = buildQueryParams({
    lat,
    lon,
    plants: [{ kwp, tiltDeg: slope, azimuthDeg: orientation }],
    forecastDays: 1,
    nowcast
  });
  const url = `${PVNODE_BASE}/forecast/?${params.toString()}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) return { ok: false, error: `pvnode HTTP ${res.status}` };
    const data = await res.json();
    // WR-02: shape priority matches extractPowerSeries — forecasts[] plural is
    // the documented production shape; data[] and forecast[] singular are kept
    // as tolerant fallbacks. Field synonyms mirror the production extractor
    // (timestamp/time/ts/ts_utc; power_w/power/watts).
    const first = Array.isArray(data?.forecasts) ? data.forecasts[0]
                : Array.isArray(data?.data) ? data.data[0]
                : Array.isArray(data?.forecast) ? data.forecast[0]
                : Array.isArray(data) ? data[0]
                : null;
    if (!first) return { ok: true, sample: null };
    const ts = first.timestamp ?? first.time ?? first.ts ?? first.ts_utc ?? first.datetime ?? null;
    const pw = first.power_w ?? first.power ?? first.watts ?? 0;
    return {
      ok: true,
      sample: {
        ts,
        watts: Math.round(Number(pw) || 0)
      }
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
