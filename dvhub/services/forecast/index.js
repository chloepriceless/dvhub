// services/forecast/index.js -- Forecast service factory.
// Wires all subsystems: weather, Solcast, PV forecast, load forecast, accuracy tracker.
// Exposes buildForecastResponse() for /api/forecast endpoint (D-01).
// Follows the factory pattern: createForecastService(ctx) -> { start, close, tier, store, buildForecastResponse }

import { detectRamTier } from './ram-tier.js';
import { createForecastStore } from './forecast-store.js';
import { createWeatherFetch } from './weather-fetch.js';
import { createSolcastClient } from './solcast-client.js';
import { createForecastSolar } from './forecast-solar.js';
import { createVrmForecast } from './vrm-forecast.js';
import { createOpenMeteoSolar } from './open-meteo-solar.js';
import { createPvnodeClient } from './pvnode-client.js';
import { createPvForecast } from './pv-forecast.js';
import { createLoadForecast } from './load-forecast.js';
import { createAccuracyTracker } from './accuracy-tracker.js';
import { createPythonBridge } from '../python-bridge/index.js';

/**
 * Create the forecast service. Detects RAM tier, initializes subsystems,
 * and provides buildForecastResponse() for the combined API endpoint.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog, db }
 * @returns {{ start: Function, close: Function, tier: number, store: object, buildForecastResponse: Function }}
 */
export function createForecastService(ctx) {
  const { state, getCfg, pushLog } = ctx;

  // Detect hardware tier
  const { tier, totalMB } = detectRamTier();

  // Version counter: increments on any forecast data change.
  // Optimizer polls this to detect when re-optimization is needed (D-02).
  let forecastVersion = 0;

  /** Increment forecast version. Called by subsystems when data changes. */
  function bumpForecastVersion() { forecastVersion++; }
  ctx.bumpForecastVersion = bumpForecastVersion;

  // Initialize forecast state with tier-gated flags
  state.forecast = {
    tier,
    totalMB,
    weather: { lastFetchAt: null, data: null, error: null },
    pv: { lastFetchAt: null, model: null, data: null, confidence: 0.3 },
    load: { lastFetchAt: null, data: null, confidence: 0.3 },
    price: { source: 'epex', data: null },
    workerReady: tier === 1  // Tier 1 has no worker, always "ready"
  };

  pushLog('forecast_init', { tier, totalMB });

  // Create store (schema will be ensured on start)
  const store = createForecastStore(ctx);

  // Create subsystems
  const weatherFetch = createWeatherFetch(ctx, { store });
  const solcastClient = createSolcastClient(ctx, { store });
  const forecastSolar = createForecastSolar(ctx, { store });
  const vrmForecast = createVrmForecast(ctx);
  const openMeteoSolar = createOpenMeteoSolar(ctx, { store });
  const pvnodeClient = createPvnodeClient(ctx, { store });
  const pythonBridge = tier >= 2 ? createPythonBridge(ctx, { tier }) : null;
  const pvForecast = createPvForecast(ctx, { tier, store, pythonBridge, solcastClient, forecastSolar, vrmForecast, openMeteoSolar, pvnodeClient });
  const loadForecast = createLoadForecast(ctx, { store, vrmForecast, pythonBridge });
  const accuracyTracker = createAccuracyTracker(ctx, { store });

  /**
   * Start the forecast service: ensure DB schema, start all subsystems.
   */
  async function start() {
    // ctx.db is a getter that reads dbPool — set during createTelemetryStoreIfEnabled() before start() is called
    if (ctx.db) {
      await store.ensureSchema(ctx.db);
      pushLog('forecast_schema_ready', { tier });
    }
    await weatherFetch.start();
    await pvForecast.start();
    await loadForecast.start();
    await accuracyTracker.start();
    pushLog('forecast_started', { tier, subsystems: ['weather', 'pv', 'load', 'accuracy'] });
  }

  /**
   * Graceful shutdown. Stop all subsystems.
   */
  async function close() {
    weatherFetch.close();
    pvForecast.close();
    loadForecast.close();
    accuracyTracker.close();
    if (pythonBridge) pythonBridge.close();
    store.close();
  }

  // --- Internal helpers for buildForecastResponse ---

  /**
   * Build price section from existing EPEX data (15-min resolution per D-02).
   * EPEX day-ahead prices are published facts -- confidence is high for today, lower for tomorrow.
   * @returns {{ resolution: string, slots: Array }}
   */
  function buildPriceSection() {
    const epexData = state.epex?.data;
    if (!Array.isArray(epexData) || epexData.length === 0) {
      return { resolution: '15min', slots: [] };
    }

    const now = Date.now();
    const slots = epexData.map(row => {
      const tsMs = Number(row.ts);
      const endMs = tsMs + 15 * 60 * 1000;
      // Published day-ahead prices for today/tomorrow have near-certain confidence.
      // Prices further out (if any) have lower confidence.
      const hoursAhead = (tsMs - now) / 3_600_000;
      const confidence = hoursAhead <= 24 ? 0.95 : hoursAhead <= 48 ? 0.85 : 0.7;

      return {
        start: new Date(tsMs).toISOString(),
        end: new Date(endMs).toISOString(),
        ctKwh: Number(row.ct_kwh ?? 0),
        confidence
      };
    });

    return { resolution: '15min', slots };
  }

  /**
   * Build PV section from forecast state (15-min resolution per D-02).
   * @returns {{ resolution: string, slots: Array }}
   */
  function buildPvSection() {
    const pvData = state.forecast.pv.data;
    if (!Array.isArray(pvData) || pvData.length === 0) {
      return { resolution: '15min', slots: [] };
    }

    const slots = pvData.map(row => ({
      start: row.ts ? new Date(row.ts).toISOString() : (row.ts_utc || ''),
      end: row.ts
        ? new Date(new Date(row.ts).getTime() + 15 * 60 * 1000).toISOString()
        : '',
      powerW: row.powerW ?? row.power_w ?? 0,
      confidence: row.confidence ?? state.forecast.pv.confidence ?? 0.3
    }));

    return { resolution: '15min', slots };
  }

  /**
   * Build load section from forecast state (1h resolution per D-02).
   * @returns {{ resolution: string, slots: Array }}
   */
  function buildLoadSection() {
    const loadData = state.forecast.load.data;
    if (!Array.isArray(loadData) || loadData.length === 0) {
      return { resolution: '1h', slots: [] };
    }

    const slots = loadData.map(row => ({
      start: row.ts_utc || '',
      end: row.ts_utc
        ? new Date(new Date(row.ts_utc).getTime() + 3_600_000).toISOString()
        : '',
      powerW: row.power_w ?? 0,
      confidence: row.confidence ?? state.forecast.load.confidence ?? 0.3
    }));

    return { resolution: '1h', slots };
  }

  /**
   * Build combined forecast response for /api/forecast per D-01.
   * ML post-processing: applies ML correction after PV section is built (D-02).
   * @returns {{ meta: object, price: object, pv: object, rawPv: object, load: object }}
   */
  async function buildForecastResponse() {
    const cfg = getCfg();
    const pv = buildPvSection();
    const load = buildLoadSection();

    // ML post-processing: correct PV forecast if model available (Tier 2+).
    // correct() is async (spawns Python), so await it.
    // D-A1/A3: correct() now builds features internally and uses forecastVersion cache.
    let mlResult = { applied: false, corrected: pv.slots, model: null };
    if (ctx.mlService?.correct) {
      try {
        mlResult = (await ctx.mlService.correct(pv.slots, {
          forecastVersion
        })) ?? mlResult;
      } catch {
        // Swallow — bypass ML correction on error, keep raw pv
      }
    }

    let mlActive = mlResult.applied || false;
    let correctedPv = mlActive ? { ...pv, slots: mlResult.corrected } : pv;

    // Sanity fallback: if ML correction collapses the forecast to ~zero while raw
    // has real values (observed: lightgbm v7 squashing 22kW peaks down to <1W),
    // disable ML for this response and fall back to raw — otherwise the
    // Börsenchart overlay disappears entirely.
    let mlSanityFallback = false;
    if (mlActive) {
      const maxOf = (slots) => slots.reduce((m, s) => Math.max(m, Number(s?.powerW) || 0), 0);
      const rawMax = maxOf(pv.slots);
      const corrMax = maxOf(correctedPv.slots);
      if (rawMax >= 200 && corrMax < rawMax * 0.01) {
        pushLog('ml_correction_sanity_fallback', { rawMaxW: Math.round(rawMax), corrMaxW: Math.round(corrMax * 10) / 10, mlModel: mlResult.model });
        correctedPv = pv;
        mlActive = false;
        mlSanityFallback = true;
      }
    }

    // H-12 restored: use ML-corrected PV for Börsenchart solar overlay (not raw PV)
    const solar = correctedPv.slots.map(s => ({ ts: new Date(s.start).getTime(), w: s.powerW || 0 }));
    const consumption = load.slots.map(s => ({ ts: new Date(s.start).getTime(), w: s.powerW || 0 }));

    // VRM PV forecast for Börsenchart overlay — independent of active model.
    // Lets users compare Victron's prediction against the active source.
    let vrmSolar = [];
    if (vrmForecast?.isAvailable) {
      try {
        const vrmRows = await vrmForecast.readPvForecast();
        if (Array.isArray(vrmRows)) {
          vrmSolar = vrmRows
            .map((r) => ({ ts: new Date(r.ts_utc).getTime(), w: Number(r.power_w) || 0 }))
            .filter((p) => Number.isFinite(p.ts));
        }
      } catch (e) {
        pushLog('vrm_solar_overlay_error', { error: e.message });
      }
    }

    // Tagesgesamt for the dashboard summary cards (PV + Verbrauch). The
    // pv/load slots above only contain ts_utc >= NOW, so summing them gives
    // "remaining today", not the full day. The Leitstand cards want the
    // whole day — query VRM forecast directly for full Berlin-local-day totals.
    let dailyTotals = null;
    if (vrmForecast?.readDailyTotals) {
      try {
        dailyTotals = await vrmForecast.readDailyTotals();
      } catch (e) {
        pushLog('vrm_daily_totals_query_error', { error: e.message });
      }
    }

    // D-B1: fetch last 12h of measured PV from energy_slots_15m via telemetryStore
    let actual = [];
    let pastForecast = [];
    if (ctx.telemetryStore?.listPvActualSlots) {
      try {
        const end = new Date();
        const start = new Date(end.getTime() - 12 * 3600 * 1000);
        actual = await ctx.telemetryStore.listPvActualSlots({ start, end });

        // Fetch historic PV forecasts for the same time range so the comparison
        // chart can plot Ist vs Prognose at matching timestamps. Without this
        // the Ist line (past) and the Prognose lines (future) are time-disjoint
        // and the user sees no real overlap.
        try {
          const historicRows = await store.getLatestPvForecast({
            start: start.toISOString(),
            end: end.toISOString()
          });
          if (Array.isArray(historicRows)) {
            // Pick latest forecast per timestamp (multiple models may have written
            // for the same slot — prefer 'combined' > 'solcast' > 'pvlib' > 'pvnode'
            // > anything else, and within the same model the row with latest
            // generated_at wins thanks to the ORDER BY ts_utc ASC + Map overwrite).
            const modelRank = (m) => {
              const idx = ['combined', 'solcast', 'pvlib', 'pvnode'].indexOf(m);
              return idx === -1 ? 999 : idx;
            };
            const byTs = new Map();
            for (const row of historicRows) {
              const key = new Date(row.ts_utc).toISOString();
              const prev = byTs.get(key);
              if (!prev || modelRank(row.model) < modelRank(prev.model)) {
                byTs.set(key, row);
              }
            }
            pastForecast = Array.from(byTs.values())
              .sort((a, b) => new Date(a.ts_utc) - new Date(b.ts_utc))
              .map((r) => ({
                start: new Date(r.ts_utc).toISOString(),
                powerW: Number(r.power_w) || 0,
                model: r.model
              }));
          }
        } catch (e) {
          pushLog('forecast_historic_query_error', { error: e.message });
        }
      } catch (e) {
        pushLog('forecast_actual_query_error', { error: e.message });
      }
    }

    return {
      ok: true,
      meta: {
        generatedAt: new Date().toISOString(),
        horizon: '72h',
        tier,
        pvModel: state.forecast.pv.model || cfg.forecast?.pv?.model || 'solcast',
        loadModel: cfg.forecast?.load?.model || 'sql_weekday',
        mlActive,
        mlModel: mlActive ? (mlResult.model || null) : null,
        mlSanityFallback,
        // Phase 07 Plan 07-04: ensembleWeights from inverse-MAE merge (REVIEWS H2 + D-C3).
        // Dashboard debug-overlay renders these per forecast cycle.
        ensembleWeights: state.forecast.pv.ensembleWeights ?? null
      },
      price: buildPriceSection(),
      pv: correctedPv,     // ML-corrected (or raw if no model)
      rawPv: pv,           // Pre-ML for comparison chart (D-22)
      load,
      actual,              // D-B1: measured PV from energy_slots_15m (last 12h, in Watts)
      pastForecast,        // Historic pv_forecasts for the same 12h window (for chart overlay)
      // Berlin-local full-day totals from VRM forecast (today + tomorrow). Frontend
      // uses these for Tagesgesamt cards; existing pv/load.slots stay future-only
      // and feed the "noch X kWh übrig" detail line.
      dailyTotals,
      // Legacy fields for app.js Börsenchart overlay (drawPriceChart expects these)
      solar,
      consumption,
      vrmSolar
    };
  }

  // Phase 07 Plan 07-04: expose pvnodeClient for Wave-2 DI wiring in server.js.
  // routes-api.js reads ctx.pvnodeBackfill + ctx.pvnodeQuota + ctx.forecastSnapshots
  // built from this client + store in server.js.
  return {
    start,
    close,
    tier,
    store,
    pvnodeClient,
    buildForecastResponse,
    // Phase 07 FORE-12 D-D2: load-forecast degradation visibility via /api/ml/status.
    getLoadForecastState: () => loadForecast.getState?.() ?? {
      source: 'unknown', status: 'unknown', consecutiveNonSfRuns: 0, lastUpdatedAt: null
    },
    get forecastVersion() { return forecastVersion; }
  };
}
