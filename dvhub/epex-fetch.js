// epex-fetch.js -- EPEX price fetching and VRM solar forecast.
// Extracted from server.js (Phase 2, Plan 02).
// Factory receives DI context; timer lifecycle via start()/stop().

import { berlinDateString, addDays } from './server-utils.js';
import { buildPriceTelemetrySamples } from './telemetry-runtime.js';

const VRM_FORECAST_API = 'https://vrmapi.victronenergy.com';

export function createEpexFetcher(ctx) {
  const { state, getCfg, pushLog, telemetrySafeWrite } = ctx;

  const timers = [];  // Track all interval/timeout handles for cleanup

  // --- Private: fetchEpexFromDvhubApi ---
  async function fetchEpexFromDvhubApi(day, day2, bzn) {
    const cfg = getCfg();
    const baseUrl = cfg.epex.priceApiUrl || 'https://api.dvhub.de';
    const url = `${baseUrl}/api/prices?start=${day}&end=${addDays(day2, 1)}&zone=${encodeURIComponent(bzn)}`;
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`DVhub Price API HTTP ${r.status}`);
    const p = await r.json();
    if (!Array.isArray(p?.data) || p.data.length === 0) return null;
    return p.data.map((entry) => {
      const ts = new Date(entry.ts).getTime();
      const eur = Number(entry.price);
      const ds = berlinDateString(new Date(ts), cfg.epex.timezone);
      return { ts, day: ds, eur_mwh: eur, ct_kwh: Number((eur / 10).toFixed(3)) };
    }).filter((row) => row.day === day || row.day === day2);
  }

  // --- Private: fetchEpexFromEnergyCharts ---
  async function fetchEpexFromEnergyCharts(day, day2, bzn) {
    const cfg = getCfg();
    const url = `https://api.energy-charts.info/price?bzn=${encodeURIComponent(bzn)}&start=${day}&end=${day2}`;
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Energy Charts HTTP ${r.status}`);
    const p = await r.json();
    const unix = Array.isArray(p?.unix_seconds) ? p.unix_seconds : [];
    const prices = Array.isArray(p?.price) ? p.price : [];
    const n = Math.min(unix.length, prices.length);
    const data = [];
    for (let i = 0; i < n; i++) {
      const sec = Number(unix[i]);
      const eur = Number(prices[i]);
      if (!Number.isFinite(sec) || !Number.isFinite(eur)) continue;
      const ts = sec * 1000;
      const ds = berlinDateString(new Date(ts), cfg.epex.timezone);
      if (ds !== day && ds !== day2) continue;
      data.push({ ts, day: ds, eur_mwh: eur, ct_kwh: Number((eur / 10).toFixed(3)) });
    }
    return data;
  }

  // --- Public: fetchEpexDay ---
  async function fetchEpexDay() {
    const cfg = getCfg();
    if (!cfg.epex.enabled) return;
    const day = berlinDateString(new Date(), cfg.epex.timezone);
    const day2 = addDays(day, 1);
    const bzn = cfg.epex.bzn || 'DE-LU';
    try {
      let data = null;
      try {
        data = await fetchEpexFromDvhubApi(day, day2, bzn);
      } catch (apiErr) {
        pushLog('epex_dvhub_api_fallback', { error: apiErr.message });
      }
      if (!data || data.length === 0) {
        data = await fetchEpexFromEnergyCharts(day, day2, bzn);
      }

      data.sort((a, b) => a.ts - b.ts);
      state.epex = { ok: true, date: day, nextDate: day2, updatedAt: Date.now(), data, error: null };
      ctx.telemetrySafeWrite(() => ctx.telemetryStore.writeSamples(buildPriceTelemetrySamples(data, {
        source: 'price_api',
        scope: 'forecast',
        resolutionSeconds: 3600
      })));
      pushLog('epex_refresh_ok', { count: data.length });
    } catch (e) {
      state.epex.ok = false;
      state.epex.error = e.message;
      state.epex.updatedAt = Date.now();
      pushLog('epex_refresh_err', { error: e.message });
    }
    ctx.publishRuntimeSnapshot();
  }

  // --- Public: fetchVrmForecast ---
  async function fetchVrmForecast() {
    const cfg = getCfg();
    const hi = cfg.telemetry?.historyImport;
    if (!hi?.enabled || !hi?.vrmPortalId || !hi?.vrmToken) return;
    if (!ctx.telemetryStore?.writeForecastPoints) return;

    const portalId = hi.vrmPortalId;
    const token = hi.vrmToken;
    const now = new Date();
    const fetchedAt = now.toISOString();

    // Fetch today, tomorrow, and day after tomorrow
    const days = [0, 1, 2];
    let totalUpserted = 0;

    for (const dayOffset of days) {
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      dayStart.setDate(dayStart.getDate() + dayOffset);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);
      const forecastForDate = dayStart.toISOString().slice(0, 10);

      try {
        const params = new URLSearchParams({
          type: 'forecast',
          start: String(Math.floor(dayStart.getTime() / 1000)),
          end: String(Math.floor(dayEnd.getTime() / 1000))
        });
        const url = `${VRM_FORECAST_API}/v2/installations/${encodeURIComponent(portalId)}/stats?${params}`;
        const response = await fetch(url, {
          headers: { accept: 'application/json', 'x-authorization': `Token ${token}` },
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) continue;
        const data = await response.json();
        if (!data.success || !data.records) continue;

        const points = [];

        // Solar yield forecast
        if (Array.isArray(data.records.solar_yield_forecast)) {
          for (const [tsMs, valueW] of data.records.solar_yield_forecast) {
            if (valueW == null || !Number.isFinite(valueW)) continue;
            points.push({
              forecastType: 'solar_yield',
              tsUtc: new Date(tsMs).toISOString(),
              valueW: Math.round(valueW * 10) / 10,
              fetchedAt,
              forecastForDate,
              source: 'vrm'
            });
          }
        }

        // Consumption forecast
        if (Array.isArray(data.records.vrm_consumption_fc)) {
          for (const [tsMs, valueW] of data.records.vrm_consumption_fc) {
            if (valueW == null || !Number.isFinite(valueW)) continue;
            points.push({
              forecastType: 'consumption',
              tsUtc: new Date(tsMs).toISOString(),
              valueW: Math.round(valueW * 10) / 10,
              fetchedAt,
              forecastForDate,
              source: 'vrm'
            });
          }
        }

        if (points.length > 0) {
          const upserted = await ctx.telemetryStore.writeForecastPoints(points);
          totalUpserted += upserted;
        }
      } catch (e) {
        pushLog('vrm_forecast_error', { dayOffset, error: e.message });
      }
    }

    if (totalUpserted > 0) {
      pushLog('vrm_forecast_ok', { upserted: totalUpserted });
    }

    // Store in state for quick API access
    state.forecast = state.forecast || {};
    state.forecast.lastFetchAt = fetchedAt;
    state.forecast.lastUpserted = totalUpserted;
  }

  // --- Public: epexNowNext ---
  function epexNowNext() {
    const rec = state.epex;
    if (!rec.ok || !Array.isArray(rec.data) || rec.data.length === 0) return null;
    const now = Date.now();
    let current = rec.data[0];
    let next = null;
    for (const row of rec.data) {
      if (row.ts <= now) current = row;
      else { next = row; break; }
    }

    const tomorrowRows = rec.data.filter((r) => r.day === rec.nextDate);
    const todayRows = rec.data.filter((r) => r.day === rec.date);
    const hasFutureNegative = todayRows.some((r) => r.ts > now && Number(r.eur_mwh) < 0);

    return {
      current,
      next,
      hasFutureNegative,
      today: rec.date,
      tomorrow: rec.nextDate,
      todayMin: todayRows.length ? Math.min(...todayRows.map((r) => Number(r.eur_mwh))) : null,
      todayMax: todayRows.length ? Math.max(...todayRows.map((r) => Number(r.eur_mwh))) : null,
      tomorrowNegative: tomorrowRows.some((r) => Number(r.eur_mwh) < 0),
      tomorrowMin: tomorrowRows.length ? Math.min(...tomorrowRows.map((r) => Number(r.eur_mwh))) : null,
      tomorrowMax: tomorrowRows.length ? Math.max(...tomorrowRows.map((r) => Number(r.eur_mwh))) : null
    };
  }

  function start() {
    // Initial fetch
    fetchEpexDay();

    // EPEX refresh: check every 5 min
    const epexInterval = setInterval(() => {
      const cfg = getCfg();
      const mustRefresh = !state.epex.date || state.epex.date !== berlinDateString(new Date(), cfg.epex.timezone);
      if (mustRefresh || (Date.now() - state.epex.updatedAt) > 6 * 60 * 60 * 1000) fetchEpexDay();
    }, 5 * 60 * 1000);
    timers.push(epexInterval);

    // VRM forecast: initial fetch after 10s delay
    const vrmInitTimeout = setTimeout(() => {
      fetchVrmForecast().catch(e => pushLog('vrm_forecast_init_error', { error: e.message }));
    }, 10000);
    timers.push(vrmInitTimeout);

    // VRM forecast: every 2 hours
    const vrmInterval = setInterval(() => {
      fetchVrmForecast().catch(e => pushLog('vrm_forecast_error', { error: e.message }));
    }, 2 * 60 * 60 * 1000);
    timers.push(vrmInterval);
  }

  function stop() {
    // Call BOTH clearInterval and clearTimeout on each handle
    // One will be a no-op but both are safe
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    timers.length = 0;
  }

  return { fetchEpexDay, fetchVrmForecast, epexNowNext, start, stop };
}
