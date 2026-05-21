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

// Plan 19-04 (B3 ML Shadow Correction): preference rank for selecting an
// input PV-forecast model to feed into mlService.correct({shadow:true}).
// Mirrors the order used by buildForecastResponse in services/forecast/index.js
// — combined (ensemble) is preferred; falls through to single-provider models.
const ML_SHADOW_INPUT_MODEL_RANK = ['combined', 'solcast', 'forecast_solar', 'pvnode', 'open_meteo_solar', 'vrm'];

export function createInspector(ctx, deps = {}) {
  const pushLog = ctx && typeof ctx.pushLog === 'function' ? ctx.pushLog : () => {};
  const state = ctx && ctx.state ? ctx.state : null;
  const getCfg = ctx && typeof ctx.getCfg === 'function' ? ctx.getCfg : () => ({});
  const { store, mlService, eosAdapter, forecastService, vrmForecast } = deps;

  // Plan 19-04 (B3): single-slot ML-shadow cache. Keyed on forecastVersion +
  // 60s TTL so two consecutive 30s polls share the same Python spawn. Scoped
  // to the factory closure — every createInspector call gets its own cache,
  // which matches the production wiring (one inspector per server process).
  let mlShadowCache = null; // { forecastVersion, expiresAt, payload } | null
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

  // ───────────── B3 — ML Shadow Correction (Plan 19-04 — IMPLEMENTED) ─────────────
  //
  // Runs the ML model in SHADOW mode (mlService.correct(..., {shadow:true}))
  // so the operator can preview ML output BEFORE flipping cfg.ml.mlEnabled.
  // The Python spawn cost is amortised by a 60s sliding cache keyed on
  // forecastService.forecastVersion — two consecutive 30s polls hit the cache
  // (one spawn, not two). A forecastVersion bump (new forecast pipeline run)
  // invalidates the cache transparently.
  //
  // Input-model selection per ML_SHADOW_INPUT_MODEL_RANK. The cache stores
  // the FULL payload (raw + corrected + delta) so cacheHit serves the same
  // envelope shape the frontend already renders.
  //
  // Returns envelope:
  //   {
  //     window: { from, to },
  //     raw:        [{ ts_utc, power_w }],     // input PV slots
  //     corrected:  [{ ts_utc, power_w }]|null, // null when applied=false
  //     delta:      [{ ts_utc, delta_w }]|null, // null when applied=false
  //     model:      string|null,
  //     applied:    boolean,
  //     reason:     string|null,    // 'no_model'|'no_input'|null
  //     mlEnabled:  boolean,
  //     meta: { inputModel: string|null, cacheHit: boolean }
  //   }
  // Or, on hard failure: { ok: false, error: ..., window }.
  async function getMlCorrection({ from, to } = {}) {
    if (!store || typeof store.getLatestPvForecast !== 'function') {
      return { ok: false, error: 'store_unavailable', window: { from, to } };
    }
    if (!mlService || typeof mlService.correct !== 'function') {
      return { ok: false, error: 'ml_unavailable', window: { from, to } };
    }

    // Read forecastVersion lazily — forecastService may expose a getter or a
    // plain numeric field. Default to 0 when unavailable (cache still works
    // — every call shares fv=0 until a real forecast version lands).
    let fv = 0;
    if (forecastService) {
      const rawFv = forecastService.forecastVersion;
      const n = Number(rawFv);
      if (Number.isFinite(n)) fv = n;
    }

    const now = Date.now();
    if (mlShadowCache && mlShadowCache.forecastVersion === fv && mlShadowCache.expiresAt > now) {
      // Cache hit — return clone with cacheHit:true (preserve cached envelope shape).
      const cachedMeta = mlShadowCache.payload.meta || {};
      return Object.assign({}, mlShadowCache.payload, {
        meta: Object.assign({}, cachedMeta, { cacheHit: true }),
      });
    }

    let rows = [];
    try {
      rows = (await store.getLatestPvForecast({ start: from, end: to })) || [];
    } catch (e) {
      pushLog('inspector_ml_correction_query_error', { error: e && e.message ? e.message : String(e) });
      return { ok: false, error: 'query_failed', window: { from, to } };
    }

    // Bucket rows by model
    const byModel = {};
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const m = r.model || 'unknown';
      if (!byModel[m]) byModel[m] = [];
      byModel[m].push(r);
    }

    // Pick first non-empty model per preference rank
    let inputModel = null;
    let inputRows = [];
    for (const m of ML_SHADOW_INPUT_MODEL_RANK) {
      if (byModel[m] && byModel[m].length > 0) {
        inputModel = m;
        inputRows = byModel[m];
        break;
      }
    }

    const raw = inputRows
      .map(r => ({
        ts_utc: r.ts_utc instanceof Date ? r.ts_utc.toISOString() : String(r.ts_utc),
        power_w: Number.isFinite(Number(r.power_w)) ? Number(r.power_w) : 0,
      }))
      .sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));

    const mlEnabled = !!(getCfg().ml && getCfg().ml.mlEnabled);

    if (raw.length === 0) {
      // Transient empty — do NOT cache, so a follow-up poll re-queries cheaply.
      return {
        window: { from, to },
        raw: [],
        corrected: null,
        delta: null,
        model: null,
        applied: false,
        reason: 'no_input',
        mlEnabled,
        meta: { inputModel: null, cacheHit: false },
      };
    }

    // Adapt to mlService.correct input shape: [{start, powerW}]
    const slotsForMl = raw.map(r => ({ start: r.ts_utc, powerW: r.power_w }));
    let mlResult;
    try {
      mlResult = await mlService.correct(slotsForMl, { forecastVersion: fv, shadow: true });
    } catch (e) {
      pushLog('inspector_ml_correction_predict_error', { error: e && e.message ? e.message : String(e) });
      return { ok: false, error: 'ml_predict_failed', window: { from, to } };
    }

    let corrected = null;
    let delta = null;
    if (mlResult && mlResult.applied && Array.isArray(mlResult.corrected)) {
      corrected = mlResult.corrected.map((c, i) => ({
        ts_utc: (c && c.start) || (raw[i] && raw[i].ts_utc) || null,
        power_w: Number.isFinite(Number(c && c.powerW)) ? Number(c.powerW) : 0,
      }));
      delta = corrected.map((c, i) => ({
        ts_utc: c.ts_utc,
        delta_w: Number(c.power_w) - Number((raw[i] && raw[i].power_w) || 0),
      }));
    }

    const payload = {
      window: { from, to },
      raw,
      corrected,
      delta,
      model: (mlResult && mlResult.model) || null,
      applied: !!(mlResult && mlResult.applied),
      reason: (mlResult && mlResult.reason) || null,
      mlEnabled,
      meta: { inputModel, cacheHit: false },
    };

    // Cache only when applied — skipping caches for no_model / no_input avoids
    // 60s 'stuck' UX after the operator loads a model or rectifies the input.
    if (payload.applied) {
      mlShadowCache = { forecastVersion: fv, expiresAt: now + 60_000, payload };
    }

    return payload;
  }

  // ───────────── B4 — EOS Output (Plan 19-05 — IMPLEMENTED) ─────────────
  //
  // Surfaces the EOSdash push/pull exchange so operators can see exactly which
  // payload is shipped to EOS and which schedule comes back. Uses a DEDICATED
  // 5s-timeout adapter (wired in server.js Plan 19-05) so a hung EOS process
  // caps Inspector polls at 5s instead of the optimizer's 30s.
  //
  // Threat-model mitigations (19-PLAN §threat_model):
  //   - T-19-05 (DoS via cascading 30s timeouts): mitigated by 5s adapter wiring
  //     verified statically in inspector-b4.test.js
  //   - T-19-07 (DoS via cascading isAvailable timeouts): isAvailable() short-
  //     circuit — when false, NO pushForecast/pullSchedule attempted
  //   - T-19-22 (XSS via untrusted plan strings): all string values pass
  //     through escHtmlForecastInspector in settings.js before innerHTML
  //
  // Adapter shape from services/optimizer/eos-adapter.js (live impl):
  //   - pushForecast(payload) → { ok, error? }    (never throws)
  //   - pullSchedule()        → Array<slot>|null  (never throws)
  //   - isAvailable()         → boolean
  //
  // Returns envelope:
  //   {
  //     available: boolean,
  //     window: { from, to },
  //     push: { ok, payloadSummary:{pvSlotCount,loadSlotCount,priceSlotCount}, error|null },
  //     pull: { ok, slots:[{ts_utc, planAction, planPowerW}], error|null },
  //     meta: { timeoutMs: 5000 },
  //   }
  // Or, if EOS off: { available:false, reason:'eos_off'|'adapter_unavailable', window }.
  async function getEos({ from, to } = {}) {
    if (!eosAdapter || typeof eosAdapter.isAvailable !== 'function') {
      return { available: false, reason: 'adapter_unavailable', window: { from, to } };
    }

    let available = false;
    try {
      available = await eosAdapter.isAvailable();
    } catch (e) {
      pushLog('inspector_eos_isavailable_error', { error: e && e.message ? e.message : String(e) });
      return { available: false, reason: 'eos_off', window: { from, to } };
    }
    if (!available) {
      return { available: false, reason: 'eos_off', window: { from, to } };
    }

    // Build the same payload the optimizer pushes to EOS — mirrors RESEARCH §B4.
    // forecastService.buildForecastResponse() returns { meta, pv:{slots}, rawPv,
    // load:{slots}, price:{slots}, … }. We pass it verbatim to pushForecast which
    // extracts pv.slots / price.slots / load.slots (eos-adapter.js:97-126).
    let forecastPayload = null;
    try {
      if (forecastService && typeof forecastService.buildForecastResponse === 'function') {
        forecastPayload = await forecastService.buildForecastResponse();
      }
    } catch (e) {
      pushLog('inspector_eos_payload_build_error', { error: e && e.message ? e.message : String(e) });
      // Continue with null — pushForecast will degrade gracefully (empty payload).
    }

    // Fire push + pull in parallel. The 5s timeout is enforced inside the
    // adapter (per adapter-instance closure); we don't need to add a Promise.race
    // wrapper here. Each adapter call resolves to its own envelope and NEVER
    // throws (eos-adapter.js wraps errors as { ok:false, error } / null).
    const [pushResult, pullResult] = await Promise.all([
      eosAdapter.pushForecast(forecastPayload),
      eosAdapter.pullSchedule(),
    ]);

    // pushResult shape: { ok:boolean, error?:string }
    const pushOk = !!(pushResult && pushResult.ok);
    const pushError = (pushResult && !pushResult.ok && pushResult.error) || null;

    // pullResult shape: REAL adapter returns Array|null (eos-adapter.js:169-187).
    // We also accept { ok, data } in case a test/mock uses the older envelope.
    let pullOk = false;
    let pullRows = [];
    let pullError = null;
    if (Array.isArray(pullResult)) {
      pullOk = true;
      pullRows = pullResult;
    } else if (pullResult && typeof pullResult === 'object' && pullResult.ok) {
      // Defensive: mock-style envelope { ok, data }
      pullOk = true;
      pullRows = Array.isArray(pullResult.data) ? pullResult.data : [];
    } else if (pullResult && typeof pullResult === 'object' && pullResult.ok === false) {
      pullError = pullResult.error || 'pull_failed';
    } else if (pullResult == null) {
      // Real adapter returns null on any pull error — we surface as ok:false.
      pullOk = false;
    }

    // Shape pull slots for the frontend. Real adapter rows look like
    //   { ts, endTs, powerW, confidence }
    // with `ts` as a millisecond epoch. We project to { ts_utc, planAction,
    // planPowerW } so the frontend can render uniformly with the other tabs.
    // planAction is derived from sign of powerW (charge / discharge / idle) —
    // matches the rule-of-thumb interpretation in optimizer/index.js.
    const pullSlots = pullRows.map((s) => {
      let tsUtc = null;
      if (s && typeof s.ts_utc === 'string') tsUtc = s.ts_utc;
      else if (s && typeof s.start === 'string') tsUtc = s.start;
      else if (s && (typeof s.ts === 'number' || typeof s.start === 'number')) {
        const ms = typeof s.ts === 'number' ? s.ts : s.start;
        if (Number.isFinite(ms)) tsUtc = new Date(ms).toISOString();
      } else if (s && (s.start instanceof Date || s.ts instanceof Date)) {
        const d = s.start instanceof Date ? s.start : s.ts;
        tsUtc = d.toISOString();
      }
      const powerW = Number(s && (s.powerW != null ? s.powerW : (s.planPowerW != null ? s.planPowerW : 0)));
      let action = (s && (s.action || s.planAction)) || null;
      if (!action) {
        if (powerW > 50) action = 'charge';
        else if (powerW < -50) action = 'discharge';
        else action = 'idle';
      }
      return {
        ts_utc: tsUtc,
        planAction: action,
        planPowerW: Number.isFinite(powerW) ? powerW : 0,
      };
    });

    // Summarize push payload — operator wants slot counts, not full arrays.
    // Real buildForecastResponse() returns objects with .slots arrays. Tests
    // may pass plain arrays — handle both shapes.
    function slotCountOf(section) {
      if (Array.isArray(section)) return section.length;
      if (section && Array.isArray(section.slots)) return section.slots.length;
      return 0;
    }
    const payloadSummary = forecastPayload ? {
      pvSlotCount: slotCountOf(forecastPayload.pv),
      loadSlotCount: slotCountOf(forecastPayload.load),
      priceSlotCount: slotCountOf(forecastPayload.price),
    } : { pvSlotCount: 0, loadSlotCount: 0, priceSlotCount: 0 };

    // Phase 19.1-01: detect "EOS up but not configured for auto-optimization".
    // EOS v0.3.0 returns HTTP 404 with body
    //   {"detail":"Can not get the energy management plan.\nDid you configure automatic optimization?"}
    // when /v1/energy-management/plan is hit on an unconfigured instance.
    // The adapter today maps this to {ok:false, error:'EOS returned HTTP 404'}
    // because httpRequest treats non-2xx as ok:false. When BOTH push and pull
    // fail with HTTP 404 right after isAvailable returned true, surface this
    // as the more actionable reason 'eos_not_configured' so the UI can render
    // a helpful banner instead of a raw HTTP code.
    const looksNotConfigured =
      !pushOk && !pullOk &&
      typeof pushError === 'string' && pushError.includes('404') &&
      (pullError === null || (typeof pullError === 'string' && pullError.includes('404')));

    return {
      available: true,
      reason: looksNotConfigured ? 'eos_not_configured' : null,
      window: { from, to },
      push: { ok: pushOk, payloadSummary, error: pushError },
      pull: { ok: pullOk, slots: pullSlots, error: pullError },
      meta: { timeoutMs: 5000 },
    };
  }

  // ───────────── B5 — Stage-2 Backtest (Plan 19-06 — IMPLEMENTED) ─────────────
  //
  // Loads the latest schedule_snapshot for the given calendar day + the measured
  // battery actuals for the same day, partitions rules into Stage-2 plan rules vs
  // operator-override rules via partitionRulesByStage2, then classifies each plan
  // slot via classifyStage2Slot (MATCHED / OVERRIDE / DEVIATION / NEUTRAL).
  //
  // Operator-facing question the envelope answers: "On day D, which Stage-2 plan
  // slots ran as expected, which were overridden by a custom rule, and which
  // failed silently?" — the digital twin of Phase-15-style real-life-verification.
  //
  // Threat-model mitigations (19-06 plan §threat_model):
  //   - T-19-06 (Stage-2 reconstruction integrity): triple-marker partition in
  //     partitionRulesByStage2 (OR-logic). Verified by stage2-reconstruction.test.js.
  //   - T-19-08 (SQL injection via `date`): two-layer validation — route handler
  //     regex-checks YYYY-MM-DD AND querySnapshotsForDate re-validates + binds
  //     via $1::date placeholder.
  //   - T-19-24 (rules_json corruption): try/catch around JSON.parse falls back
  //     to []. No-rules path exercised by the empty-slots test.
  //   - T-19-26 (DoS via wide range): date input clamps min/max client-side +
  //     route handler caps to today-30..today. Each call = 1 SQL + 1 actuals,
  //     single-day window (96 slots max).
  //
  // Returns envelope:
  //   {
  //     ok: true,
  //     date: 'YYYY-MM-DD',
  //     snapshot: { id, ts },
  //     slots: [{ ts_utc, planAction:'LEEREN'|'HALTEN'|null, planPowerW,
  //              actualPowerW, override:{id,source}|null, status }],
  //     summary: { plannedCount, matchedCount, overrideCount, deviationCount, matchedPct },
  //   }
  // Or on failure:
  //   { ok:false, error:'telemetry_unavailable'|'no_snapshot'|'query_failed', date }
  async function getStage2({ date } = {}) {
    const telemetryStore = getTelemetryStore();
    if (!telemetryStore || typeof telemetryStore.querySnapshotsForDate !== 'function') {
      return { ok: false, error: 'telemetry_unavailable', date };
    }
    // Day-bounded window for actuals — UTC midnight to next-day UTC midnight
    const startIso = date + 'T00:00:00.000Z';
    const endIso = new Date(Date.parse(startIso) + 86_400_000).toISOString();

    let snapshot = null;
    let actuals = [];
    try {
      const tasks = [
        telemetryStore.querySnapshotsForDate(date),
        (typeof telemetryStore.listBatteryActualSlots === 'function')
          ? telemetryStore.listBatteryActualSlots({ start: startIso, end: endIso })
          : Promise.resolve([]),
      ];
      const results = await Promise.all(tasks);
      snapshot = results[0];
      actuals = results[1] || [];
    } catch (e) {
      pushLog('inspector_stage2_query_error', { error: e && e.message ? e.message : String(e) });
      return { ok: false, error: 'query_failed', date };
    }
    if (!snapshot) {
      return { ok: false, error: 'no_snapshot', date };
    }

    const { planRules, overrideRules } = partitionRulesByStage2(snapshot.rules || []);

    // Build actual-by-ts map (key = ISO slot start)
    const actualByTs = {};
    for (const a of actuals) {
      const ts = typeof a.start === 'string' ? a.start : new Date(a.start).toISOString();
      actualByTs[ts] = Number(a.powerW);
    }
    // Build override-by-ts map — keyed on slot start; accepts epoch-ms OR ISO string
    const overrideByTs = {};
    for (const o of overrideRules) {
      let ts = null;
      if (typeof o.startTs === 'number' && Number.isFinite(o.startTs)) {
        ts = new Date(o.startTs).toISOString();
      } else if (typeof o.startTs === 'string') {
        ts = o.startTs;
      }
      if (ts) overrideByTs[ts] = { id: o.id || null, source: o.source || null };
    }

    // Iterate Stage-2 plan rules — one output slot per rule
    const slots = [];
    for (const p of planRules) {
      let ts = null;
      if (typeof p.startTs === 'number' && Number.isFinite(p.startTs)) {
        ts = new Date(p.startTs).toISOString();
      } else if (typeof p.startTs === 'string') {
        ts = p.startTs;
      }
      if (!ts) continue;
      const actualRaw = actualByTs[ts];
      const hasActual = actualRaw != null && Number.isFinite(Number(actualRaw));
      const override = overrideByTs[ts] || null;
      const status = classifyStage2Slot(
        { plannedPowerW: Number(p.powerW) || 0 },
        { actualPowerW: hasActual ? Number(actualRaw) : NaN },
        override
      );
      slots.push({
        ts_utc: ts,
        planAction: p.stage2Phase || null,
        planPowerW: Number(p.powerW) || 0,
        actualPowerW: hasActual ? Number(actualRaw) : null,
        override,
        status,
      });
    }
    slots.sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));

    let matchedCount = 0;
    let overrideCount = 0;
    let deviationCount = 0;
    for (const s of slots) {
      if (s.status === 'MATCHED') matchedCount++;
      else if (s.status === 'OVERRIDE') overrideCount++;
      else if (s.status === 'DEVIATION') deviationCount++;
    }
    const plannedCount = slots.length;
    const matchedPct = plannedCount > 0
      ? Math.round((matchedCount / plannedCount) * 1000) / 10
      : 0;

    return {
      ok: true,
      date,
      snapshot: { id: snapshot.id, ts: snapshot.ts },
      slots,
      summary: { plannedCount, matchedCount, overrideCount, deviationCount, matchedPct },
    };
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
