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
import { computeWeights, mergeForecasts, resampleTo15min } from './ensemble.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PV_FORECAST_SCRIPT = path.join(__dirname, '..', 'python-bridge', 'scripts', 'pv_forecast.py');

// Forecast interval: every 6 hours
const FORECAST_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Dedicated pvnode refresh tick (Christin 2026-06-25): pull pvnode on its OWN
// cadence — independent of the 6 h ensemble cycle and WITHOUT re-running Solcast /
// pvlib / the other providers. Fixed 15-min tick = the plan-window floor; the
// pvnode client gates each call by the selected plan (Plus fetches every tick,
// Free returns cache ~47/48 ticks). Each fresh pull re-merges against the LAST
// known other-provider slots, so the ensemble follows pvnode's nowcast without
// touching any other provider's quota.
const PVNODE_REFRESH_TICK_MS = 15 * 60 * 1000;

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

  // Review 2026-06-10 (P2-2): setHours(0,0,0,0) + toISOString().replace('Z','')
  // produced a zone-less UTC wall-time string that pandas then localised as
  // Europe/Berlin — a ~2h grid offset in EVERY host TZ. Only the clear-sky
  // fallback consumes `start` (with weather rows pvlib uses the UTC-indexed
  // weather frame), but fix it properly: pass the bare Berlin calendar date —
  // pd.date_range('YYYY-MM-DD', tz='Europe/Berlin') anchors to Berlin midnight.
  const berlinToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

  const base = {
    lat: loc.latitude,
    lon: loc.longitude,
    start: berlinToday,
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
  // Present providers (non-empty slots) in THIS forecast cycle — the merge only
  // ever weights what is actually here.
  const present = Object.entries(providersBySlot)
    .filter(([, rows]) => Array.isArray(rows) && rows.length > 0)
    .map(([k]) => k);

  // Read each provider's rolling-7d MAE from yesterday's accuracy row. Operator
  // request 2026-06-21: ALL PV providers are accuracy-tracked now (was
  // pvnode/solcast/pvlib only) — read the full set so every present provider can
  // be weighted by its own accuracy.
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
        pvlib: row.mae_7d_pvlib,
        vrm: row.mae_7d_vrm,
        forecast_solar: row.mae_7d_forecast_solar,
        open_meteo: row.mae_7d_open_meteo
      };
    }
  } catch (err) {
    if (typeof pushLog === 'function') pushLog('ensemble_mae_read_error', { error: err?.message ?? String(err) });
  }

  // Neutral prior (operator request 2026-06-21): a present provider WITHOUT its
  // own 7-day MAE (just added, or no snapshot that day) is weighted at the MEAN
  // MAE of the providers that DO have one — so it participates at average accuracy
  // instead of being dropped, and the ensemble never collapses to a single tracked
  // provider during the warm-up days. computeWeights then turns these MAEs into
  // inverse-MAE weights over ALL present providers.
  const finiteMaes = present
    .map(p => Number(mae7d[p]))
    .filter(v => Number.isFinite(v) && v > 0);
  const priorMae = finiteMaes.length > 0
    ? finiteMaes.reduce((s, v) => s + v, 0) / finiteMaes.length
    : null;

  const maeForWeights = {};
  const priored = [];
  for (const p of present) {
    const v = Number(mae7d[p]);
    if (Number.isFinite(v) && v > 0) {
      maeForWeights[p] = v;
    } else if (priorMae != null) {
      maeForWeights[p] = priorMae;
      priored.push(p);
    }
    // else: NO provider has any MAE → leave undefined → computeWeights → {} → uniform below.
  }

  const weights = computeWeights(maeForWeights);
  const hasValidWeights = Object.keys(weights).length > 0;

  if (!hasValidWeights) {
    // Uniform fallback: no present provider has ANY accuracy data yet. Log once per cycle.
    const uniformWeight = present.length > 0 ? 1 / present.length : 0;
    const uniform = Object.fromEntries(present.map(k => [k, uniformWeight]));
    if (typeof pushLog === 'function') {
      pushLog('ensemble_uniform_fallback', { providers: present });
    }
    return { merged: mergeForecasts(providersBySlot, uniform), weights: uniform };
  }

  // Observability: which present providers ran on the neutral prior (no own MAE
  // yet) vs their own accuracy. With the prior, no present provider is excluded.
  if (typeof pushLog === 'function' && priored.length > 0) {
    pushLog('ensemble_mae_neutral_prior', {
      priored,
      weighted: present.filter(p => !priored.includes(p)),
      priorMaeW: Math.round(priorMae)
    });
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
  let pvnodeTimerId = null;
  // Baseline from the last FULL ensemble run, reused by the pvnode-only refresh so
  // it re-merges fresh pvnode against the other providers WITHOUT re-fetching them.
  let lastProviderSlots = null;
  let lastPvnodeSig = null;
  // Shared guard: the 6 h full cycle and the 15-min pvnode refresh must never write
  // state.forecast.pv / insert combined rows concurrently (last-writer-wins race).
  let forecastRunning = false;

  /** Cheap change-signature of a pvnode slot array (length + first ts + last value). */
  function pvnodeSigOf(slots) {
    if (!Array.isArray(slots) || slots.length === 0) return 'empty';
    const a = slots[0]; const b = slots[slots.length - 1];
    return slots.length + ':' + (a?.ts_utc ?? '') + ':' + (b?.ts_utc ?? '') + ':' + (b?.power_w ?? '');
  }

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
    // Operator request 2026-06-22: bring EVERY provider onto a common 15-min grid
    // BEFORE the ensemble merge — coarser providers (30/60-min) are interpolated,
    // finer ones averaged — so every present provider contributes to every slot
    // (removes the residual saw-tooth left after the weightSum renorm). Future
    // non-15-min providers are covered automatically by the same wrap.
    const pvnodeSlots  = resampleTo15min(normalizeProviderRows(pvnodeResult));
    const solcastSlots = resampleTo15min(normalizeProviderRows(solcastResult));
    const pvlibSlots   = resampleTo15min(normalizeProviderRows(pvlibResult));
    // Phase 26-01: vrm/forecast_solar/open_meteo were fetched + normalized but only ever
    // consumed by the single-fallback else-if chain below — they never entered the weighted
    // ensemble. Lift them through the SAME three-step (normalize → present-push →
    // providersBySlot) as pvnode/solcast/pvlib so mergePvForecastsWeighted mixes them. They
    // ride the uniform-weight path (no MAE column by design — see 26-01 plan); the inverse-MAE
    // path stays on pvnode/solcast/pvlib only (computeWeights filters out the keys without MAE).
    const vrmSlots           = resampleTo15min(normalizeProviderRows(vrmResult));
    const forecastSolarSlots = resampleTo15min(normalizeProviderRows(forecastSolarResult));
    const openMeteoSlots     = resampleTo15min(normalizeProviderRows(openMeteoResult));

    // Baseline for the pvnode-only refresh: re-merge fresh pvnode against THESE
    // other-provider slots later, without re-fetching Solcast/pvlib/etc.
    lastProviderSlots = { pvnode: pvnodeSlots, solcast: solcastSlots, pvlib: pvlibSlots, vrm: vrmSlots, forecast_solar: forecastSolarSlots, open_meteo: openMeteoSlots };
    lastPvnodeSig = pvnodeSigOf(pvnodeSlots);

    const presentProviders = [];
    if (pvnodeSlots.length  > 0) presentProviders.push('pvnode');
    if (solcastSlots.length > 0) presentProviders.push('solcast');
    if (pvlibSlots.length   > 0) presentProviders.push('pvlib');
    if (vrmSlots.length           > 0) presentProviders.push('vrm');
    if (forecastSolarSlots.length > 0) presentProviders.push('forecast_solar');
    if (openMeteoSlots.length     > 0) presentProviders.push('open_meteo');

    let ensembleWeights = null;
    let mergedSlots = null;
    let stateUpdated = false;

    if (presentProviders.length >= 2) {
      // Multiple providers → inverse-MAE ensemble merge (D-A4 + D-C3)
      const providersBySlot = {
        pvnode: pvnodeSlots,
        solcast: solcastSlots,
        pvlib: pvlibSlots,
        vrm: vrmSlots,
        forecast_solar: forecastSolarSlots,
        open_meteo: openMeteoSlots
      };
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
      // Review 2026-06-10 (P2-11a): this branch was the only single-provider
      // path WITHOUT a DB persist — pvnode-only forecasts vanished on restart
      // and never reached the accuracy/snapshot pipeline. Mirror the
      // pvlib/solcast branches.
      // Second-pass hardening: tolerate both row shapes — pvnode-client's
      // extractRows emits {ts_utc,…} while the sibling branches map {ts,…}.
      // Drop rows without a usable timestamp instead of inserting null ts_utc.
      await store.insertPvForecastBatch(
        pvnodeResult
          .map((row) => ({
            model: 'pvnode',
            ts_utc: row.ts_utc ?? row.ts ?? null,
            power_w: row.power_w,
            confidence: 0.5
          }))
          .filter((r) => r.ts_utc != null)
      );
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'pvnode',
        data: pvnodeResult,
        confidence: 0.5
      };
      stateUpdated = true;
      ctx.bumpForecastVersion?.();
    } else if (!stateUpdated && vrmResult.length > 0) {
      // VRM PREFERRED over forecast_solar/open_meteo (2026-05-29): on this
      // deployment solcast is unconfigured (0 kWh), pvlib/pvnode inactive, and
      // forecast_solar under-predicts badly (~35 kWh vs VRM ~112 kWh for the
      // actual 12.8 kWp system) while open_meteo over-predicts (~173 kWh).
      // VRM is Victron's forecast for the REAL installed array — it matches the
      // Leitstand daily total (readDailyTotals) and the operator's expectation.
      // The previous order let forecast_solar win, so EOS + the chart ran on a
      // ~3× too-low PV forecast (the battery could never plan to fill). Keep
      // pvlib/solcast/pvnode ahead (they're better models WHEN configured), but
      // prefer VRM to the two weather-only fallbacks.
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'vrm',
        data: vrmResult,
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
          // Phase 26-01: persist the three additional provider layers so they are not
          // missing from the snapshot once they participate in the ensemble.
          vrm: vrmSlots,
          forecast_solar: forecastSolarSlots,
          open_meteo: openMeteoSlots,
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
   * pvnode-only refresh (Christin 2026-06-25): pull pvnode on its plan cadence and
   * re-merge the ensemble using the LAST known other-provider slots — NO Solcast /
   * pvlib / vrm re-fetch (those keep their own slow cadence + quotas). The pvnode
   * client gates the actual network call by the selected plan, so this no-ops when
   * pvnode has no fresh data. Needs a prior full runForecast() (provider baseline).
   * Shares the forecastRunning guard with the 6 h cycle so the two never collide.
   */
  async function refreshPvnodeOnly() {
    if (forecastRunning) return;       // never race the full cycle (or itself)
    if (!lastProviderSlots) return;    // no baseline yet — wait for the first full run
    const cfg = getCfg();
    const model = cfg.forecast?.pv?.model || 'auto';
    const pvnodeActive = model === 'pvnode' || model === 'both'
      || (model === 'auto' && pvnodeClient?.isConfigured);
    if (!pvnodeActive) return;

    forecastRunning = true; // set synchronously with the check above — no await between → no race
    try {
      let pvnodeResult = [];
      try {
        pvnodeResult = await pvnodeClient.fetchForecast() || [];
      } catch (err) {
        pushLog('pv_pvnode_error', { error: err?.message ?? String(err) });
        return;
      }
      const pvnodeSlots = resampleTo15min(normalizeProviderRows(pvnodeResult));
      if (pvnodeSlots.length === 0) return;
      const sig = pvnodeSigOf(pvnodeSlots);
      if (sig === lastPvnodeSig) return; // client returned cached/unchanged data → nothing to re-merge

      const providersBySlot = { ...lastProviderSlots, pvnode: pvnodeSlots };
      const present = Object.values(providersBySlot).filter(s => Array.isArray(s) && s.length > 0).length;
      if (present < 2) { lastPvnodeSig = sig; return; }

      const { merged, weights } = await mergePvForecastsWeighted({ providersBySlot, store, pushLog });
      if (Array.isArray(merged) && merged.length > 0) {
        await store.insertPvForecastBatch(merged.map((row) => ({
          model: 'combined', ts_utc: row.ts_utc, power_w: row.power_w, confidence: 0.5
        })));
        // Persist pvnode's own rows too (accuracy tracker / snapshots), like runForecast.
        await store.insertPvForecastBatch(pvnodeSlots
          .map((r) => ({ model: 'pvnode', ts_utc: r.ts_utc ?? r.ts ?? null, power_w: r.power_w, confidence: 0.5 }))
          .filter((r) => r.ts_utc != null));
        state.forecast.pv = {
          lastFetchAt: new Date().toISOString(),
          model: 'combined',
          data: merged.map((r) => ({ ts: r.ts_utc, ts_utc: r.ts_utc, power_w: r.power_w, confidence: 0.5 })),
          confidence: 0.5,
          ensembleWeights: weights
        };
        lastProviderSlots = providersBySlot;
        lastPvnodeSig = sig;
        ctx.bumpForecastVersion?.();
        pushLog('pvnode_refresh_merged', { slots: merged.length });
      }
    } catch (err) {
      pushLog('ensemble_merge_error', { error: err?.message ?? String(err) });
    } finally {
      forecastRunning = false;
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

    // Schedule periodic runs (always, even if first run threw).
    // Review 2026-06-10 (P2-11b): overlap guard — a slow cycle (python spawn
    // retries + sluggish DB) must not race a second concurrent runForecast()
    // (double batch-inserts + last-writer-wins on state.forecast.pv). Same
    // pattern as load-forecast.js / weather-fetch.js. forecastRunning is now
    // SHARED with refreshPvnodeOnly so the 6 h cycle and the pvnode refresh
    // serialise (never both write the combined forecast at once).
    intervalId = setInterval(() => {
      if (forecastRunning) return;
      forecastRunning = true;
      runForecast()
        .catch(err => {
          pushLog('pv_forecast_interval_error', { error: err.message });
        })
        .finally(() => { forecastRunning = false; });
    }, FORECAST_INTERVAL_MS);

    // Dedicated pvnode refresh on its own (plan-gated) cadence — independent of the
    // 6 h cycle and of Solcast/pvlib. Ticks every 15 min; the pvnode client only
    // hits the network when the selected plan's window has elapsed (Plus → every
    // tick, Free → ~1/12 h). No-ops until the first full run sets the baseline.
    pvnodeTimerId = setInterval(() => {
      refreshPvnodeOnly().catch(err => pushLog('pvnode_refresh_error', { error: err?.message ?? String(err) }));
    }, PVNODE_REFRESH_TICK_MS);
  }

  /**
   * Stop the PV forecast service. Clear interval.
   */
  function close() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (pvnodeTimerId) {
      clearInterval(pvnodeTimerId);
      pvnodeTimerId = null;
    }
  }

  return { start, close, runForecast, refreshPvnodeOnly };
}
