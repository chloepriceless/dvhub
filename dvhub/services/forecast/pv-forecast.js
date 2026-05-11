// pv-forecast.js -- PV forecast orchestrator.
// Gates pvlib to Tier 2+ (D-09). Tier 1 uses Solcast-only.
// Supports 3 config levels: simple, standard, detailed (D-11).
// Model can be 'solcast', 'pvlib', or 'both'.
//
// Phase 07 Plan 07-04 additions (REVIEWS H2 + L3 + D-C3):
//   - mergePvForecastsWeighted() replaces the simple-average merge whenever mae_7d_* data
//     is available via store.getForecastAccuracyRow(yesterday). Falls back to uniform
//     weights (ensemble_uniform_fallback) when all mae_7d_* are null/missing.
//   - After a successful merge + state update + bumpForecastVersion, the AUTHORITATIVE
//     forecast-snapshot trigger fires via ctx.forecastSnapshots?.writeSnapshot with
//     source='forecast_version_bump' (event-driven source-of-record per REVIEWS L3).
//   - ensembleWeights are surfaced to the caller via state.forecast.pv.ensembleWeights so
//     /api/forecast can expose them under meta.ensembleWeights for the dashboard overlay.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWeights, mergeForecasts } from './ensemble.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PV_FORECAST_SCRIPT = path.join(__dirname, '..', 'python-bridge', 'scripts', 'pv_forecast.py');

// Forecast interval: every 6 hours
const FORECAST_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Build pvlib input JSON from config.
 * Supports 3 config levels per D-11:
 *   - simple: uses totalKwp with default tilt=35, azimuth=180
 *   - standard: uses totalKwp with configured tilt and azimuth
 *   - detailed: passes strings[] array directly for multi-string calculation
 *
 * @param {object} cfg - Full config object
 * @returns {object} pvlib input data
 */
export function buildPvlibInput(cfg) {
  const fc = cfg.forecast;
  const pv = fc.pv;
  const loc = fc.location;

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const base = {
    lat: loc.latitude,
    lon: loc.longitude,
    start: start.toISOString().replace('Z', ''),
    periods: 288, // 72h at 15-min intervals
    weather: []
  };

  // configLevel: 'simple' (default), 'standard', or 'detailed' per D-11
  const level = pv.configLevel || 'simple';

  if (level === 'detailed' && pv.strings && pv.strings.length > 0) {
    // Detailed mode: pass strings array, kwp is sum (used as fallback)
    return {
      ...base,
      kwp: pv.totalKwp || pv.strings.reduce((sum, s) => sum + s.kwp, 0),
      tilt: pv.tiltDeg ?? 35,
      azimuth: pv.azimuthDeg ?? 180,
      strings: pv.strings
    };
  }

  if (level === 'standard') {
    // Standard mode: use configured tilt and azimuth
    return {
      ...base,
      kwp: pv.totalKwp,
      tilt: pv.tiltDeg ?? 35,
      azimuth: pv.azimuthDeg ?? 180,
      strings: []
    };
  }

  // Simple mode (default): use defaults
  return {
    ...base,
    kwp: pv.totalKwp,
    tilt: 35,
    azimuth: 180,
    strings: []
  };
}

/**
 * Merge Solcast and pvlib forecast results.
 * Averages power_w values for matching timestamps. Takes max confidence.
 *
 * @param {Array} solcastRows - [{ ts, power_w, ... }]
 * @param {Array} pvlibRows - [{ ts, power_w, ... }]
 * @returns {Array} merged rows with model='combined'
 */
export function mergePvForecasts(solcastRows, pvlibRows) {
  const map = new Map();

  for (const row of solcastRows) {
    map.set(row.ts, { solcast: row.power_w, pvlib: null });
  }
  for (const row of pvlibRows) {
    const existing = map.get(row.ts);
    if (existing) {
      existing.pvlib = row.power_w;
    } else {
      map.set(row.ts, { solcast: null, pvlib: row.power_w });
    }
  }

  const merged = [];
  for (const [ts, values] of map) {
    let power_w;
    if (values.solcast !== null && values.pvlib !== null) {
      power_w = Math.round((values.solcast + values.pvlib) / 2);
    } else {
      power_w = values.solcast ?? values.pvlib;
    }
    merged.push({
      model: 'combined',
      ts_utc: ts,
      power_w,
      confidence: 0.5 // Combined forecast starts with moderate confidence
    });
  }

  return merged.sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
}

/**
 * Normalize provider rows to the {ts_utc, power_w} shape expected by ensemble.mergeForecasts.
 * Accepts legacy `ts` (solcast/pvlib) or native `ts_utc` (pvnode) fields.
 * @param {Array<object>} rows
 * @returns {Array<{ts_utc: string, power_w: number}>}
 */
function normalizeProviderRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const ts = r?.ts_utc ?? r?.ts ?? r?.start;
    const p = Number(r?.power_w ?? r?.powerW);
    if (!ts || !Number.isFinite(p)) continue;
    out.push({ ts_utc: typeof ts === 'string' ? ts : new Date(ts).toISOString(), power_w: p });
  }
  return out;
}

/**
 * Inverse-MAE weighted ensemble merge with uniform fallback.
 * REVIEWS H2 + D-C3: reads mae_7d_* from store.getForecastAccuracyRow(yesterday).
 * Returns { merged, weights } where weights is the final weight dict (inverse-MAE or uniform).
 *
 * @param {object} opts
 * @param {{pvnode: Array, solcast: Array, pvlib: Array}} opts.providersBySlot
 * @param {object} opts.store - forecast-store exposing getForecastAccuracyRow
 * @param {Function} [opts.pushLog]
 * @returns {Promise<{merged: Array<{ts_utc,power_w}>, weights: Record<string,number>}>}
 */
export async function mergePvForecastsWeighted({ providersBySlot, store, pushLog }) {
  let mae7d = {};
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    // REVIEWS H2: getForecastAccuracyRow is a first-class Plan 01 export
    const row = await store?.getForecastAccuracyRow?.(yesterdayStr);
    if (row) {
      // REVIEWS H9: read mae_7d_* (rolling, computed via SQL AVG window in accuracy-tracker)
      mae7d = {
        pvnode: row.mae_7d_pvnode,
        solcast: row.mae_7d_solcast,
        pvlib: row.mae_7d_pvlib
      };
    }
  } catch (err) {
    if (typeof pushLog === 'function') pushLog('ensemble_mae_read_error', { error: err?.message ?? String(err) });
  }

  const weights = computeWeights(mae7d);
  const hasValidWeights = Object.keys(weights).length > 0;

  if (!hasValidWeights) {
    // Uniform fallback (pre-14-day period OR MAE unavailable). Log once per cycle.
    const present = Object.entries(providersBySlot)
      .filter(([, rows]) => Array.isArray(rows) && rows.length > 0)
      .map(([k]) => k);
    const uniformWeight = present.length > 0 ? 1 / present.length : 0;
    const uniform = Object.fromEntries(present.map(k => [k, uniformWeight]));
    if (typeof pushLog === 'function') {
      pushLog('ensemble_uniform_fallback', { providers: present });
    }
    return { merged: mergeForecasts(providersBySlot, uniform), weights: uniform };
  }

  return { merged: mergeForecasts(providersBySlot, weights), weights };
}

/**
 * Create PV forecast orchestrator.
 * Gates pvlib to Tier 2+ per D-09. Tier 1 uses Solcast-only.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog }
 * @param {object} deps - { tier, store, pythonBridge, solcastClient }
 * @returns {{ start: Function, close: Function, runForecast: Function }}
 */
export function createPvForecast(ctx, { tier, store, pythonBridge, solcastClient, forecastSolar, vrmForecast, openMeteoSolar, pvnodeClient }) {
  const { state, getCfg, pushLog } = ctx;
  let intervalId = null;

  /**
   * Transform weather rows from DB format to pvlib input format.
   */
  function weatherToInput(weatherRows) {
    return weatherRows.map(w => ({
      timestamp: w.ts_utc,
      ghi: w.ghi_wm2 ?? 0,
      dni: w.dni_wm2 ?? 0,
      dhi: w.dhi_wm2 ?? 0,
      temperature: w.temperature_c ?? 15,
      wind_speed: w.wind_speed_ms ?? 3
    }));
  }

  /**
   * Run a PV forecast cycle.
   * On Tier 1 or model='solcast': Solcast only.
   * On Tier 2+ and model='pvlib': pvlib only.
   * On Tier 2+ and model='both': run both, merge results.
   */
  async function runForecast() {
    const cfg = getCfg();
    const pvCfg = cfg.forecast?.pv;
    const model = pvCfg?.model || 'auto';
    const isTier1 = tier === 1;

    let solcastResult = [];
    let pvlibResult = [];
    let forecastSolarResult = [];
    let vrmResult = [];

    // --- VRM Forecast (always try if available — free, already fetched by epex-fetch) ---
    if (vrmForecast?.isAvailable()) {
      try {
        vrmResult = await vrmForecast.readPvForecast() || [];
      } catch (err) {
        pushLog('pv_vrm_error', { error: err.message });
      }
    }

    // --- Forecast.Solar (free, no API key, all tiers) ---
    if (model === 'auto' || model === 'forecast_solar' || model === 'both') {
      try {
        forecastSolarResult = await forecastSolar.fetchForecast() || [];
      } catch (err) {
        pushLog('pv_forecast_solar_error', { error: err.message });
      }
    }

    // --- Open-Meteo Solar (free, uses existing weather data, no extra API call) ---
    let openMeteoResult = [];
    if (model === 'auto' || model === 'open_meteo' || model === 'both') {
      try {
        openMeteoResult = await openMeteoSolar.generateForecast() || [];
      } catch (err) {
        pushLog('pv_open_meteo_solar_error', { error: err.message });
      }
    }

    // --- pvnode (needs API key, 15-min resolution) ---
    let pvnodeResult = [];
    if (model === 'pvnode' || model === 'both' || (model === 'auto' && pvnodeClient?.isConfigured)) {
      try {
        pvnodeResult = await pvnodeClient.fetchForecast() || [];
      } catch (err) {
        pushLog('pv_pvnode_error', { error: err.message });
      }
    }

    // --- Solcast (needs API key) ---
    if (model === 'solcast' || model === 'both' || (model === 'auto' && cfg.forecast?.solcast?.apiKey)) {
      try {
        solcastResult = await solcastClient.fetchPvForecast() || [];
      } catch (err) {
        pushLog('pv_solcast_error', { error: err.message });
      }
    }

    // --- pvlib (Tier 2+ only) ---
    if (!isTier1 && (model === 'pvlib' || model === 'both')) {
      try {
        const input = buildPvlibInput(cfg);

        // Get latest weather data for pvlib
        const now = new Date();
        const end = new Date(now.getTime() + 72 * 60 * 60 * 1000);
        const weatherRows = await store.getLatestWeather({ start: now.toISOString(), end: end.toISOString() });

        if (weatherRows.length > 0) {
          input.weather = weatherToInput(weatherRows);
        }

        pvlibResult = await pythonBridge.call(PV_FORECAST_SCRIPT, input) || [];
      } catch (err) {
        pushLog('pv_pvlib_error', { error: err.message });
      }
    }

    // --- Store results (REVIEWS H2 + D-C3: inverse-MAE ensemble merge when ≥2 providers) ---
    // Normalize provider rows for ensemble merge and downstream snapshot writes.
    const pvnodeSlots  = normalizeProviderRows(pvnodeResult);
    const solcastSlots = normalizeProviderRows(solcastResult);
    const pvlibSlots   = normalizeProviderRows(pvlibResult);

    const presentProviders = [];
    if (pvnodeSlots.length  > 0) presentProviders.push('pvnode');
    if (solcastSlots.length > 0) presentProviders.push('solcast');
    if (pvlibSlots.length   > 0) presentProviders.push('pvlib');

    let ensembleWeights = null;
    let mergedSlots = null;
    let stateUpdated = false;

    if (presentProviders.length >= 2) {
      // Multiple providers → inverse-MAE ensemble merge (D-A4 + D-C3)
      const providersBySlot = { pvnode: pvnodeSlots, solcast: solcastSlots, pvlib: pvlibSlots };
      try {
        const { merged, weights } = await mergePvForecastsWeighted({
          providersBySlot, store, pushLog
        });
        mergedSlots = merged;
        ensembleWeights = weights;
      } catch (err) {
        pushLog('ensemble_merge_error', { error: err?.message ?? String(err) });
      }

      if (Array.isArray(mergedSlots) && mergedSlots.length > 0) {
        // Persist merged rows under model='combined' for backward-compat with existing UI.
        // Plan 09-08 Task 2: single batched INSERT replaces per-slot await loop —
        // collapses N round trips into 1, measurable on Pi (Tier 1 RAM).
        await store.insertPvForecastBatch(
          mergedSlots.map((row) => ({
            model: 'combined',
            ts_utc: row.ts_utc,
            power_w: row.power_w,
            confidence: 0.5
          }))
        );
        state.forecast.pv = {
          lastFetchAt: new Date().toISOString(),
          model: 'combined',
          data: mergedSlots.map(r => ({ ts: r.ts_utc, ts_utc: r.ts_utc, power_w: r.power_w, confidence: 0.5 })),
          confidence: 0.5,
          ensembleWeights
        };
        stateUpdated = true;
        ctx.bumpForecastVersion?.();
      }
    }

    if (!stateUpdated && pvlibResult.length > 0) {
      // pvlib-only results
      // Plan 09-08 Task 2: single batched INSERT replaces per-slot await loop.
      await store.insertPvForecastBatch(
        pvlibResult.map((row) => ({
          model: 'pvlib',
          ts_utc: row.ts,
          power_w: row.power_w,
          confidence: 0.4
        }))
      );
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'pvlib',
        data: pvlibResult,
        confidence: 0.4
      };
      stateUpdated = true;
      ctx.bumpForecastVersion?.();
    } else if (!stateUpdated && solcastResult.length > 0) {
      // Solcast-only results
      // Plan 09-08 Task 2: single batched INSERT replaces per-slot await loop.
      await store.insertPvForecastBatch(
        solcastResult.map((row) => ({
          model: 'solcast',
          ts_utc: row.ts,
          power_w: row.power_w,
          confidence: 0.6
        }))
      );
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'solcast',
        data: solcastResult,
        confidence: 0.6
      };
      stateUpdated = true;
      ctx.bumpForecastVersion?.();
    } else if (!stateUpdated && pvnodeResult.length > 0) {
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'pvnode',
        data: pvnodeResult,
        confidence: 0.5
      };
      stateUpdated = true;
      ctx.bumpForecastVersion?.();
    } else if (!stateUpdated && forecastSolarResult.length > 0) {
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'forecast_solar',
        data: forecastSolarResult,
        confidence: 0.35
      };
      stateUpdated = true;
      ctx.bumpForecastVersion?.();
    } else if (!stateUpdated && openMeteoResult.length > 0) {
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'open_meteo',
        data: openMeteoResult,
        confidence: 0.3
      };
      stateUpdated = true;
      ctx.bumpForecastVersion?.();
    } else if (!stateUpdated && vrmResult.length > 0) {
      // VRM as last fallback — always available if VRM token configured
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'vrm',
        data: vrmResult,
        confidence: 0.25
      };
      stateUpdated = true;
      ctx.bumpForecastVersion?.();
    }

    pushLog('pv_forecast_complete', {
      model,
      tier,
      solcastCount: solcastResult.length,
      pvlibCount: pvlibResult.length,
      forecastSolarCount: forecastSolarResult.length,
      openMeteoCount: openMeteoResult.length,
      pvnodeCount: pvnodeResult.length,
      vrmCount: vrmResult.length,
      ensembleActive: ensembleWeights !== null,
      ensembleWeights
    });

    // REVIEWS L3: AUTHORITATIVE event-driven snapshot trigger.
    // Fires once per forecast cycle after bumpForecastVersion; forecastSnapshots.writeSnapshot
    // uses its in-memory `lastSnapshotForecastDate` guard to prevent duplicate same-day writes.
    // ML-corrected rows are supplied by ml-correction in buildForecastResponse, so the snapshot
    // recorded here is the raw (pre-ML) merge. Plan 05 ml-correction will add an ml layer when
    // it lands; for Plan 04 we persist pvnode/solcast/pvlib/merged layers from this cycle.
    if (stateUpdated && ctx.forecastSnapshots?.writeSnapshot) {
      Promise.resolve(
        ctx.forecastSnapshots.writeSnapshot({
          pvnode: pvnodeSlots,
          solcast: solcastSlots,
          pvlib: pvlibSlots,
          merged: Array.isArray(mergedSlots) && mergedSlots.length > 0
            ? mergedSlots
            : normalizeProviderRows(state.forecast.pv?.data),
          ml: [],
          source: 'forecast_version_bump'
        })
      ).catch(err => pushLog('snapshots_event_error', { error: err?.message ?? String(err) }));
    }
  }

  /**
   * Start the PV forecast service.
   * Sets interval for periodic forecast (every 6h). Runs immediately on start.
   */
  async function start() {
    // Run once immediately — never let a throw prevent the interval scheduling
    try {
      await runForecast();
    } catch (err) {
      pushLog('pv_forecast_first_run_error', { error: err?.message ?? String(err) });
    }

    // Schedule periodic runs (always, even if first run threw)
    intervalId = setInterval(() => {
      runForecast().catch(err => {
        pushLog('pv_forecast_interval_error', { error: err.message });
      });
    }, FORECAST_INTERVAL_MS);
  }

  /**
   * Stop the PV forecast service. Clear interval.
   */
  function close() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { start, close, runForecast };
}
