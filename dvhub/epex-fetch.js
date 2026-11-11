// epex-fetch.js -- EPEX price fetching and VRM solar forecast.
// Extracted from server.js (Phase 2, Plan 02).
// Factory receives DI context; timer lifecycle via start()/stop().

import { berlinDateString, addDays, localMinutesOfDay } from './server-utils.js';
import { buildPriceTelemetrySamples } from './telemetry-runtime.js';
// Plan 09-07: shared safeInterval — catches sync throws AND awaited Promise
// rejections from the ticker, logs via configured logger + pushLog, and the
// next tick still fires. Stops one-bad-fetch from disabling the loop forever.
import { safeInterval } from './services/safe-async.js';
import { VRM_API_BASE as VRM_FORECAST_API, resolveVrmSiteId } from './vrm-site.js';
// priceApiUrl kommt aus der Config: Namen beim Verbinden prüfen (1.0.10).
import { outboundFetch } from './services/outbound-fetch.js';

// Preisquelle 'luox' (T-0417): Für einen Tag, den LUOX nicht liefert, ab
// 13 Uhr (Day-Ahead veröffentlicht) bis 20 Uhr weiter bei LUOX nachfragen —
// die öffentliche Quelle hat ihn bis dahin schon aufgefüllt.
const LUOX_RETRY_UNTIL_MINUTE = 20 * 60;
const DAY_AHEAD_MINUTE = 13 * 60;

/**
 * Ist ein neuer Day-Ahead-Abruf fällig? (15-min-Takt in start(); rein, damit testbar.)
 * @param {{epex:object}} state  @param {{epex:object}} cfg  @param {number} nowMs
 */
export function epexRefreshDue(state, cfg, nowMs = Date.now()) {
  const tz = cfg.epex?.timezone;
  const today = berlinDateString(new Date(nowMs), tz);
  const mustRefresh = !state.epex?.date || state.epex.date !== today;
  const stale = (nowMs - (state.epex?.updatedAt || 0)) > 6 * 60 * 60 * 1000;
  // Day-ahead for tomorrow publishes ~12:45 CET. The plain 6h-staleness
  // check can delay tomorrow's prices by up to 6h, during which EOS ffills a
  // flat tomorrow and dumps the battery tonight. After 13:00 Berlin, refresh
  // every tick until tomorrow's rows are actually present (then fetchEpexDay
  // pushes them to the EOS bridge — see above).
  const tomorrow = addDays(today, 1);
  const hasTomorrow = Array.isArray(state.epex?.data) && state.epex.data.some((r) => r.day === tomorrow);
  const minutes = localMinutesOfDay(new Date(nowMs), tz);
  const dayAheadDue = minutes >= DAY_AHEAD_MINUTE && !hasTomorrow;
  const byDay = state.epex?.sourceByDay || {};
  const luoxPending = cfg.epex?.priceSource === 'luox' && !mustRefresh && (
    byDay[today] !== 'luox'
    || (minutes >= DAY_AHEAD_MINUTE && minutes < LUOX_RETRY_UNTIL_MINUTE && byDay[tomorrow] !== 'luox')
  );
  return mustRefresh || stale || dayAheadDue || luoxPending;
}

export function createEpexFetcher(ctx, deps = {}) {
  const { state, getCfg, pushLog } = ctx;
  const nowMs = deps.now || (() => Date.now());
  let lastLuoxError = null;

  const timers = [];  // Track all interval/timeout handles for cleanup

  // --- Private: fetchEpexFromDvhubApi ---
  async function fetchEpexFromDvhubApi(day, day2, bzn) {
    const cfg = getCfg();
    const baseUrl = cfg.epex.priceApiUrl || 'https://dvhub.online';
    const url = `${baseUrl}/api/prices?start=${day}&end=${addDays(day2, 1)}&zone=${encodeURIComponent(bzn)}`;
    const r = await (ctx.outboundFetch || outboundFetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
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

  // --- Private: fetchEpexFromLuox (T-0417) ---
  // Day-Ahead direkt aus dem LUOX-Kundenportal bzw. der Lumenaza-Partner-API
  // (services/tariff-provider/luox-service.js) — dieselben EPEX-Preise, ohne
  // Umweg über öffentliche Preisanbieter.
  async function fetchEpexFromLuox(day, day2) {
    const cfg = getCfg();
    if (typeof ctx.luox?.fetchDayAhead !== 'function') return null;
    const r = await ctx.luox.fetchDayAhead();
    return (r?.rows || []).map((row) => {
      const ds = berlinDateString(new Date(row.ts), cfg.epex.timezone);
      return { ts: row.ts, day: ds, eur_mwh: row.eurMwh, ct_kwh: Number((row.eurMwh / 10).toFixed(3)) };
    }).filter((row) => row.day === day || row.day === day2);
  }

  // Öffentliche Quelle(n) wie bisher: 'dvhub' = dvhub.online + Energy-Charts
  // als stiller Fallback, 'public' = nur Energy-Charts.
  async function fetchEpexPublic(day, day2, bzn, priceSource) {
    if (priceSource !== 'public') {
      try {
        const data = await fetchEpexFromDvhubApi(day, day2, bzn);
        if (data && data.length > 0) return { data, source: 'dvhub' };
      } catch (apiErr) {
        pushLog('epex_dvhub_api_fallback', { error: apiErr.message });
      }
    }
    const data = await fetchEpexFromEnergyCharts(day, day2, bzn);
    return { data: data || [], source: 'energy_charts' };
  }

  // --- Public: fetchEpexDay ---
  async function fetchEpexDay() {
    const cfg = getCfg();
    if (!cfg.epex.enabled) return;
    const day = berlinDateString(new Date(nowMs()), cfg.epex.timezone);
    const day2 = addDays(day, 1);
    // Did we already hold tomorrow's day-ahead before this fetch? Used to fire
    // the EOS bridge the instant tomorrow's prices first arrive (see below).
    const hadTomorrowBefore = Array.isArray(state.epex?.data)
      && state.epex.data.some((r) => r.day === day2);
    const bzn = cfg.epex.bzn || 'DE-LU';
    // Phase 09.2 D-04: outer-boundary timer for health-tracker. EPEX cadence
    // is hours, so ms-granularity (Date.now) is more than enough. Captured
    // here so the failure path can also report wall-clock latency.
    const __t0 = Date.now();
    try {
      // Preisquelle (2026-06-17): 'dvhub' = dvhub.online primär + Energy-Charts als
      // stiller Fallback; 'public' = direkt Energy-Charts (dvhub.online wird
      // übersprungen). Unset → 'dvhub' (Altverhalten beibehalten).
      // 'luox' (T-0417): LUOX zuerst; Tage, die LUOX nicht liefert, kommen aus
      // dem schon gehaltenen Stand oder der öffentlichen Quelle ('dvhub'-Kette).
      const priceSource = cfg.epex.priceSource || 'dvhub';
      let data = null;
      let activeSource = null;
      const sourceByDay = {};
      // LUOX liefert nur die deutsche Preiszone (DE-LU); bei anderer Zone gilt
      // die öffentliche Quelle.
      if (priceSource === 'luox' && bzn === 'DE-LU') {
        try {
          const luoxData = await fetchEpexFromLuox(day, day2);
          if (luoxData && luoxData.length > 0) {
            data = luoxData;
            activeSource = 'luox';
            for (const r of luoxData) sourceByDay[r.day] = 'luox';
          }
          lastLuoxError = null;
        } catch (luoxErr) {
          const msg = luoxErr?.message || String(luoxErr);
          // Nur bei neuer Meldung protokollieren (Abruf alle 15 min).
          if (msg !== lastLuoxError) pushLog('epex_luox_fallback', { code: luoxErr?.code || 'error', error: msg });
          lastLuoxError = msg;
        }
        // Auch wenn LUOX ganz ausfällt: Tage, die schon gehalten werden, nicht
        // bei jedem 15-min-Nachfragen erneut öffentlich abrufen.
        {
          data = data || [];
          const minutes = localMinutesOfDay(new Date(nowMs()), cfg.epex.timezone);
          const missing = [day, day2].filter((d) => !sourceByDay[d] && (d === day || minutes >= 13 * 60));
          if (missing.length) {
            // Erst aus dem gehaltenen Stand (gleicher Tag = dieselben Preise),
            // sonst einmal öffentlich abrufen.
            const held = Array.isArray(state.epex?.data) ? state.epex.data : [];
            const heldBy = state.epex?.sourceByDay || {};
            let pub = null;
            for (const d of missing) {
              let rows = held.filter((r) => r.day === d);
              let src = heldBy[d] || 'held';
              if (!rows.length) {
                if (!pub) pub = await fetchEpexPublic(day, day2, bzn, 'dvhub').catch(() => ({ data: [], source: null }));
                rows = pub.data.filter((r) => r.day === d);
                src = pub.source;
              }
              if (rows.length) {
                data = data.concat(rows);
                sourceByDay[d] = src;
                if (!activeSource) activeSource = src === 'held' ? 'held' : src;
              }
            }
          }
        }
      }
      if (!data || data.length === 0) {
        const pub = await fetchEpexPublic(day, day2, bzn, priceSource);
        data = pub.data;
        activeSource = data.length ? pub.source : null;
        for (const r of data) sourceByDay[r.day] = pub.source;
      }
      // Review 2026-06-10 (P2-6): if BOTH sources came back empty this is a
      // FAILED refresh — do not stamp state.epex.ok=true with data:[] (that
      // fooled the health tracker and every ok-trusting consumer). Throw into
      // the existing catch path so ok:false + error get recorded instead.
      if (!data || data.length === 0) {
        throw new Error('both price sources returned no slots');
      }

      data.sort((a, b) => a.ts - b.ts);
      state.epex = { ok: true, date: day, nextDate: day2, updatedAt: nowMs(), data, error: null, activeSource, sourceByDay };
      // Resolution stamp derived from the actual slot spacing: the hardcoded
      // 3600 mis-stamped the 15-min day-ahead slots (96/day) as hourly from
      // 2026-03-26 until this fix — consumers that filter or weigh by
      // resolution_seconds were misled (found via the T-0004 §51a counter).
      const slotSpacingSec = data.length >= 2
        ? Math.max(60, Math.round((Number(data[1].ts) - Number(data[0].ts)) / 1000))
        : 900;
      ctx.telemetrySafeWrite(() => ctx.telemetryStore.writeSamples(buildPriceTelemetrySamples(data, {
        source: 'price_api',
        scope: 'forecast',
        resolutionSeconds: slotSpacingSec
      })));
      pushLog('epex_refresh_ok', { count: data.length, priceSource, activeSource });
      // Bridge-timing fix (2026-05-31): the moment tomorrow's day-ahead first
      // lands, push it to EOS so the optimizer stops forward-filling a flat
      // tomorrow (which makes it dump the battery tonight instead of holding for
      // tomorrow's peak). Fire-and-forget; EOS re-optimizes on its next EMS tick.
      const hasTomorrowNow = data.some((r) => r.day === day2);
      if (hasTomorrowNow && !hadTomorrowBefore && ctx.eosForecastBridge) {
        pushLog('epex_dayahead_arrived', { date: day2, triggering: 'eos_bridge_push' });
        Promise.resolve(ctx.eosForecastBridge.push())
          .then(() => {
            // Seltener Takt (2026-10-18, eos-replan-triggers.js): mit den neuen
            // Preisen sofort rechnen statt bis zu 2 h auf den nächsten Takt.
            ctx.optimizerService?.requestEosReplanIfSparse?.('dayahead');
          })
          .catch((err) => {
            try { pushLog('eos_forecast_bridge_error', { phase: 'dayahead_arrived', error: err?.message || String(err) }); } catch { /* ignore */ }
          });
      }
      // Phase 09.2 D-04: record a successful EPEX fetch sample. Optional
      // chaining for the same boot-race reason as polling.js — initial
      // fetchEpexDay() can fire before telemetryReady IIFE completes and
      // assigns ctx.healthTracker.
      ctx.healthTracker?.recordSample('epex', {
        latencyMs: Date.now() - __t0,
        success: true
      });
    } catch (e) {
      state.epex.ok = false;
      state.epex.error = e.message;
      state.epex.updatedAt = Date.now();
      pushLog('epex_refresh_err', { error: e.message });
      // Phase 09.2 D-04: record a failed EPEX fetch sample at the outer
      // boundary so partial / fallback failures still produce one sample
      // per attempt (matches the recordSample-per-cycle cadence used by
      // polling.js and the mqtt publisher).
      ctx.healthTracker?.recordSample('epex', {
        latencyMs: Date.now() - __t0,
        success: false
      });
    }
    // Defensive: ctx.publishRuntimeSnapshot is wired up in server.js init order
    // AFTER createEpexFetcher() runs (it's assigned to ctx around server.js:1090).
    // The initial fetchEpexDay() call from setupEpex() can race with that wiring
    // when EPEX network calls return fast or fail fast during startup. Optional
    // chaining keeps the eager call as a snapshot-trigger without crashing the
    // process when the ticker fires before ctx is fully populated.
    ctx.publishRuntimeSnapshot?.();
  }

  // --- Public: fetchVrmForecast ---
  async function fetchVrmForecast() {
    const cfg = getCfg();
    const hi = cfg.telemetry?.historyImport;
    if (!hi?.enabled || !hi?.vrmPortalId || !hi?.vrmToken) return;
    if (!ctx.telemetryStore?.writeForecastPoints) return;

    const token = hi.vrmToken;
    // GH #32: Feld darf Site-ID oder Portal-ID enthalten; /stats braucht die
    // Site-ID. Bisher lief eine Portal-ID still in HTTP 404 (continue ohne Log).
    let siteId;
    try {
      siteId = await resolveVrmSiteId({ ref: hi.vrmPortalId, token });
    } catch (e) {
      pushLog('vrm_forecast_error', { stage: 'site_id', error: e.message });
      return;
    }
    const now = new Date();
    const fetchedAt = now.toISOString();
    let httpError = null;

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
        const url = `${VRM_FORECAST_API}/v2/installations/${encodeURIComponent(siteId)}/stats?${params}`;
        const response = await fetch(url, {
          headers: { accept: 'application/json', 'x-authorization': `Token ${token}` },
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
          httpError = httpError || { dayOffset, status: response.status };
          continue;
        }
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
    if (httpError) {
      // Einmal je Lauf statt je Tag: welcher HTTP-Status kam zurück.
      pushLog('vrm_forecast_error', { stage: 'stats', dayOffset: httpError.dayOffset, error: `VRM HTTP ${httpError.status}` });
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

    // EPEX refresh: check every 15 min (aligned to the 15-min slot cadence)
    const epexInterval = safeInterval('epex-fetch.refresh', () => {
      if (epexRefreshDue(state, getCfg(), nowMs())) fetchEpexDay();
    }, 15 * 60 * 1000);
    timers.push(epexInterval);

    // VRM forecast: initial fetch after 10s delay
    const vrmInitTimeout = setTimeout(() => {
      fetchVrmForecast().catch(e => pushLog('vrm_forecast_init_error', { error: e.message }));
    }, 10000);
    timers.push(vrmInitTimeout);

    // VRM forecast: every 2 hours
    const vrmInterval = safeInterval('epex-fetch.vrm', () => {
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
