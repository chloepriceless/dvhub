// services/forecast/inspector.js — Read-only Inspector data shaping for /api/forecast/inspector/*.
//
// Phase 19 Plan 19-01: B6 (Optimizer-Cold) is fully implemented. B1–B5 are
// stubs returning {ok:false, error:'not_implemented'} envelopes — Plans
// 19-02..19-06 replace each method body in turn.
//
// Factory pattern matches services/forecast/index.js + services/family/index.js:
// the constructor accepts ctx + deps and returns an object of async methods +
// 2 pure helpers (consumed by 19-06; declared here so 19-06 doesn't need to
// add new exports).
//
// Phase 18 lesson: never destructure DI fields at factory-creation time —
// ctx.* fields may be wired AFTER the factory runs (e.g. ctx.telemetryStore
// is set inside the telemetryReady IIFE). Always read ctx.* lazily at call
// time. For deps passed directly to createInspector(ctx, deps), capturing
// is fine when the caller has already wired the dep — the inspector is
// composed AFTER its deps are stable.

export function createInspector(ctx, deps = {}) {
  const pushLog = ctx && typeof ctx.pushLog === 'function' ? ctx.pushLog : () => {};
  const state = ctx && ctx.state ? ctx.state : null;
  const { store, mlService, eosAdapter, forecastService, vrmForecast } = deps;
  // telemetryStore is read lazily — supports both deps.telemetryStore (passed
  // at factory time) AND ctx.telemetryStore (set later in server bootstrap).
  function getTelemetryStore() {
    if (deps.telemetryStore) return deps.telemetryStore;
    if (ctx && ctx.telemetryStore) return ctx.telemetryStore;
    return null;
  }

  pushLog('inspector_init', { hasStore: !!store, hasTelemetry: !!getTelemetryStore() });

  // ───────────── B1 — PV Providers (Plan 19-02) ─────────────
  //
  // Pivots store.getLatestPvForecast({start,end}) rows by `model` column.
  // CRITICAL Pitfall-1 guard: this method MUST NOT call vrmForecast.readPvForecast()
  // — that path triggers a write-amplification re-fetch (Phase 18-01i). We read
  // exclusively from the store, which queries pv_forecasts read-only.
  //
  // Returns envelope:
  //   {
  //     window: { from, to },
  //     providers: { solcast: [{ts_utc, power_w, confidence}], ..., combined: [...] },
  //     ensembleWeights: state.forecast?.pv?.ensembleWeights ?? null,
  //     ensembleActive: !!state.forecast?.pv?.ensembleWeights,
  //     oldestFetchedAt: { solcast: ISO|null, ... } (latest fetched_at per model),
  //     meta: { rowCount, modelCount }
  //   }
  //
  // ensembleActive reflects the PIPELINE state (weights present in state), NOT
  // whether any `combined` rows landed in the response window. Operators need
  // to see "ensemble configured but no data" distinct from "ensemble off".
  async function getPvProviders({ from, to } = {}) {
    if (!store || typeof store.getLatestPvForecast !== 'function') {
      return { ok: false, error: 'store_unavailable', window: { from, to } };
    }
    let rows = [];
    try {
      rows = (await store.getLatestPvForecast({ start: from, end: to })) || [];
    } catch (e) {
      pushLog('inspector_pv_providers_query_error', { error: e && e.message ? e.message : String(e) });
      return { ok: false, error: 'query_failed', window: { from, to } };
    }

    // Pivot rows by model. Each row → {ts_utc:string, power_w:number, confidence:number|null}
    const providers = {};
    const fetchedByModel = {};
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const model = r.model || 'unknown';
      const ts = r.ts_utc instanceof Date ? r.ts_utc.toISOString() : String(r.ts_utc);
      const powerNum = Number(r.power_w);
      const confRaw = r.confidence == null ? null : Number(r.confidence);
      const conf = confRaw == null || !Number.isFinite(confRaw) ? null : confRaw;
      if (!providers[model]) providers[model] = [];
      providers[model].push({
        ts_utc: ts,
        power_w: Number.isFinite(powerNum) ? powerNum : 0,
        confidence: conf,
      });
      const fetched = r.fetched_at instanceof Date
        ? r.fetched_at
        : (r.fetched_at ? new Date(r.fetched_at) : null);
      if (fetched && Number.isFinite(fetched.getTime())) {
        if (!fetchedByModel[model] || fetched > fetchedByModel[model]) {
          fetchedByModel[model] = fetched;
        }
      }
    }
    // Sort each provider's slots ascending by ts_utc string (ISO strings sort
    // lexicographically the same as chronologically).
    for (const m of Object.keys(providers)) {
      providers[m].sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
    }
    const oldestFetchedAt = {};
    for (const m of Object.keys(fetchedByModel)) {
      oldestFetchedAt[m] = fetchedByModel[m].toISOString();
    }

    const ensembleWeights = state && state.forecast && state.forecast.pv
      ? (state.forecast.pv.ensembleWeights || null)
      : null;

    return {
      window: { from, to },
      providers,
      ensembleWeights,
      ensembleActive: !!ensembleWeights,
      oldestFetchedAt,
      meta: { rowCount: rows.length, modelCount: Object.keys(providers).length },
    };
  }

  // ───────────── B2 — Load Forecast (Plan 19-03) ─────────────
  //
  // Pivots store.getLatestLoadForecast({start,end}) rows by `model` column +
  // joins measured load via telemetryStore.listLoadActualSlots. The B2 surface
  // ties the Phase-18-01k SQL-weekday distinction to a live UI signal:
  //   - 'sql_weekday'          — real weekday rollup (≥4 weeks of data)
  //   - 'sql_weekday_fallback' — cold-start constant 800 W (Phase 18-01k)
  //   - 'statsforecast'        — Python statsforecast output
  // sqlWeekdayFallbackActive is true iff the fallback model has at least one
  // row in the response window — operators see the fallback banner whenever
  // the SQL forecaster is in cold-start mode.
  //
  // Returns envelope:
  //   {
  //     window: { from, to },
  //     models: {
  //       sql_weekday: [{ts_utc, power_w}, ...],
  //       sql_weekday_fallback: [...],
  //       statsforecast: [...],
  //     },
  //     actual: [{ts_utc, power_w}, ...],  // measured (load_power_w * 4000)
  //     meta: { sqlWeekdayFallbackActive, rowCount, actualCount },
  //   }
  async function getLoad({ from, to } = {}) {
    if (!store || typeof store.getLatestLoadForecast !== 'function') {
      return { ok: false, error: 'store_unavailable', window: { from, to } };
    }
    let forecastRows = [];
    let actualRows = [];
    try {
      const telemetryStore = getTelemetryStore();
      const tasks = [
        store.getLatestLoadForecast({ start: from, end: to }),
        (telemetryStore && typeof telemetryStore.listLoadActualSlots === 'function')
          ? telemetryStore.listLoadActualSlots({ start: from, end: to })
          : Promise.resolve([]),
      ];
      const results = await Promise.all(tasks);
      forecastRows = results[0] || [];
      actualRows = results[1] || [];
    } catch (e) {
      pushLog('inspector_load_query_error', { error: e && e.message ? e.message : String(e) });
      return { ok: false, error: 'query_failed', window: { from, to } };
    }

    const models = {};
    for (const r of forecastRows) {
      if (!r || typeof r !== 'object') continue;
      const m = r.model || 'unknown';
      const ts = r.ts_utc instanceof Date ? r.ts_utc.toISOString() : String(r.ts_utc);
      const powerNum = Number(r.power_w);
      if (!models[m]) models[m] = [];
      models[m].push({
        ts_utc: ts,
        power_w: Number.isFinite(powerNum) ? powerNum : 0,
      });
    }
    for (const m of Object.keys(models)) {
      models[m].sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
    }

    const actual = actualRows.map(r => ({
      ts_utc: typeof r.start === 'string' ? r.start : new Date(r.start).toISOString(),
      power_w: Number(r.powerW) || 0,
    })).sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));

    const fallbackRows = models.sql_weekday_fallback || [];
    const sqlWeekdayFallbackActive = fallbackRows.length > 0;

    return {
      window: { from, to },
      models,
      actual,
      meta: {
        sqlWeekdayFallbackActive,
        rowCount: forecastRows.length,
        actualCount: actualRows.length,
      },
    };
  }

  // ───────────── B3 — ML Shadow Correction (stubbed; Plan 19-04 implements) ─────────────
  async function getMlCorrection({ from, to } = {}) {
    return { ok: false, error: 'not_implemented', stub: 'b3', window: { from, to } };
  }

  // ───────────── B4 — EOS Output (stubbed; Plan 19-05 implements) ─────────────
  async function getEos({ from, to } = {}) {
    return { ok: false, error: 'not_implemented', stub: 'b4', window: { from, to } };
  }

  // ───────────── B5 — Stage-2 Backtest (stubbed; Plan 19-06 implements) ─────────────
  async function getStage2({ date } = {}) {
    return { ok: false, error: 'not_implemented', stub: 'b5', date };
  }

  // ───────────── B6 — Optimizer Cold (IMPLEMENTED — Plan 19-01) ─────────────
  // Reads the latest optimizer run timestamp from telemetryStore and derives
  // {lastRunAt, daysSinceLastRun, isStale, reason?, optimizer?}. The 2-day
  // stale threshold is locked in UI-SPEC (Optimizer-Cold yellow @ ≥2d). The
  // frontend renders red @ ≥5d via its own threshold constant; this method
  // only flags isStale=true at ≥2d to avoid drifting two thresholds across
  // the stack.
  async function getOptimizerCold() {
    const telemetryStore = getTelemetryStore();
    if (!telemetryStore || typeof telemetryStore.getLatestOptimizerRun !== 'function') {
      return { lastRunAt: null, daysSinceLastRun: null, isStale: true, reason: 'telemetry_unavailable' };
    }
    try {
      const run = await telemetryStore.getLatestOptimizerRun({ optimizer: null });
      if (!run) {
        return { lastRunAt: null, daysSinceLastRun: null, isStale: true, reason: 'never_run' };
      }
      const startedRaw = run.runStartedAt || run.run_started_at;
      const lastMs = startedRaw ? new Date(startedRaw).getTime() : NaN;
      if (!Number.isFinite(lastMs)) {
        return { lastRunAt: null, daysSinceLastRun: null, isStale: true, reason: 'invalid_timestamp' };
      }
      const daysSince = (Date.now() - lastMs) / 86_400_000;
      return {
        lastRunAt: typeof startedRaw === 'string' ? startedRaw : new Date(startedRaw).toISOString(),
        daysSinceLastRun: Math.floor(daysSince * 10) / 10,
        isStale: daysSince >= 2,
        optimizer: run.optimizer || null,
      };
    } catch (e) {
      pushLog('inspector_optimizer_cold_error', { error: e && e.message ? e.message : String(e) });
      return { lastRunAt: null, daysSinceLastRun: null, isStale: true, reason: 'query_failed' };
    }
  }

  // ───────────── Pure helpers (consumed by Plan 19-06) ─────────────
  //
  // partitionRulesByStage2 — splits schedule rules into Stage-2-plan vs operator-override
  // arrays. Stage-2 rules are identified by THREE independent markers (any one matches):
  //   1. id starts with 'sma-stage2-' (canonical convention from market-automation-builder.js)
  //   2. stage2Phase ∈ {'LEEREN','HALTEN'} (set by Stage-2 builder)
  //   3. source === 'small_market_automation' (set on each rule by the builder)
  // The triple-marker approach gives reconstruction integrity (T-19-06): even if the
  // builder convention drifts in one place, the other two markers still classify correctly.
  function partitionRulesByStage2(rules) {
    if (!Array.isArray(rules)) return { planRules: [], overrideRules: [] };
    const SMA_SOURCE = 'small_market_automation';
    const planRules = [];
    const overrideRules = [];
    for (const r of rules) {
      if (!r || typeof r !== 'object') continue;
      const isStage2 =
        (typeof r.id === 'string' && r.id.startsWith('sma-stage2-')) ||
        (r.stage2Phase === 'LEEREN' || r.stage2Phase === 'HALTEN') ||
        (r.source === SMA_SOURCE);
      (isStage2 ? planRules : overrideRules).push(r);
    }
    return { planRules, overrideRules };
  }

  // classifyStage2Slot — per UI-SPEC §B5 status matrix.
  //   plan:     { plannedPowerW } | null
  //   actual:   { actualPowerW }  | null
  //   override: { id, ... }       | null
  //
  // Status precedence:
  //   1. no plan slot                                   → 'NEUTRAL'
  //   2. override present                               → 'OVERRIDE' (operator took control)
  //   3. actual missing/invalid                         → 'NEUTRAL'
  //   4. |actual - plan| ≤ max(15% of plan, 100W floor) → 'MATCHED'
  //   5. otherwise                                      → 'DEVIATION'
  //
  // The 100W floor handles HALTEN slots (plannedPowerW=0) where the 15% rule would
  // demand exact-zero match; idle drift up to ±100W is normal hardware behavior.
  function classifyStage2Slot(plan, actual, override) {
    if (!plan || plan.plannedPowerW == null) return 'NEUTRAL';
    if (override) return 'OVERRIDE';
    const planned = Number(plan.plannedPowerW);
    const actualW = Number(actual && actual.actualPowerW);
    if (!Number.isFinite(actualW)) return 'NEUTRAL';
    const tolerance = Math.max(Math.abs(planned) * 0.15, 100);
    return Math.abs(actualW - planned) <= tolerance ? 'MATCHED' : 'DEVIATION';
  }

  return {
    getPvProviders,
    getLoad,
    getMlCorrection,
    getEos,
    getStage2,
    getOptimizerCold,
    partitionRulesByStage2,
    classifyStage2Slot,
  };
}
