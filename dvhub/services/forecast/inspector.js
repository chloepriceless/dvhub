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

    // Phase 19.1-08: forward-fill hourly providers across 15-min sub-slots.
    // forecast_solar / open_meteo / vrm return hourly resolution → the 96-row
    // Inspector table previously showed value only at :00 with :15/:30/:45 blank.
    // Operators interpreted that as "spiky" PV at the hour mark when really it
    // means the AVERAGE power across that whole hour. Now every hour's value
    // is copied to its 4 child 15-min slots so the UI shows a flat run of
    // identical values per hour — matches the data's actual semantics.
    // Per-provider, detect the resolution (gap between first two slots) and
    // skip forward-fill for providers already at 15-min granularity (solcast
    // 30-min stays as-is because forward-filling only by 2x sub-slots is fine).
    const QUARTER_MS = 15 * 60 * 1000;
    const resolutionByProvider = {};
    for (const m of Object.keys(providers)) {
      const slots = providers[m];
      if (slots.length < 2) continue;
      const t0 = Date.parse(slots[0].ts_utc);
      const t1 = Date.parse(slots[1].ts_utc);
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
      const gap = t1 - t0;
      resolutionByProvider[m] = gap;
      if (gap <= QUARTER_MS) continue; // already 15-min, no fill needed
      const filled = [];
      const subSlots = Math.round(gap / QUARTER_MS); // 2 for 30-min, 4 for 1h
      for (const s of slots) {
        const baseTs = Date.parse(s.ts_utc);
        for (let q = 0; q < subSlots; q++) {
          filled.push({
            ts_utc: new Date(baseTs + q * QUARTER_MS).toISOString(),
            power_w: s.power_w,
            confidence: s.confidence,
          });
        }
      }
      providers[m] = filled;
    }

    const oldestFetchedAt = {};
    for (const m of Object.keys(fetchedByModel)) {
      oldestFetchedAt[m] = fetchedByModel[m].toISOString();
    }

    const ensembleWeights = state && state.forecast && state.forecast.pv
      ? (state.forecast.pv.ensembleWeights || null)
      : null;

    // 19.1-08: surface per-provider source-resolution (ms gap between consecutive
    // upstream rows) so the frontend can show "Auflösung: 1h / 30min / 15min"
    // badges. Forward-filled values now look identical at each 15-min slot but
    // the operator should know they came from one hourly value, not 4 independent
    // 15-min samples.
    const resolutionMinByProvider = {};
    for (const m of Object.keys(resolutionByProvider)) {
      const gap = resolutionByProvider[m];
      if (Number.isFinite(gap) && gap > 0) {
        resolutionMinByProvider[m] = Math.round(gap / 60000);
      }
    }

    return {
      window: { from, to },
      providers,
      ensembleWeights,
      ensembleActive: !!ensembleWeights,
      oldestFetchedAt,
      resolutionMinByProvider,
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

    // Phase 19.1-02: guard against degenerate all-zero PV input. Solcast on a
    // sub-scribed-without-key install returns flat zeros; the v1 ML model's
    // feature-only prediction path (weather + time + system params, NO input
    // PV) then emits ~1 kW typical-day values that look like load forecasts
    // to the operator. Skip the predict and surface reason:'no_input_signal'
    // — Inspector banner explains the diagnostic instead of misleading data.
    const hasSignal = raw.some(r => Number(r.power_w) > 0);
    if (!hasSignal) {
      return {
        window: { from, to },
        raw,
        corrected: null,
        delta: null,
        model: null,
        applied: false,
        reason: 'no_input_signal',
        mlEnabled,
        meta: { inputModel, cacheHit: false },
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

    // Phase 19.1-07: coherence guard against the v1-collapse pattern flagged
    // in Plan 16-05 D-01. Even with raw>0, the v1 lightgbm model can emit a
    // suspiciously load-like output (~1 kW typical-day baseline) when feature
    // drift compresses the prediction surface. Heuristic check on the delta:
    //   - rawSum = total energy in the raw window (W * slot_count)
    //   - corrSum = same for corrected
    // If the corrected curve flattens the raw signal by >70% (i.e. corrSum < 0.3*rawSum
    // when rawSum is meaningful — sunny midday) we flag low_confidence so the
    // UI banner explains why the operator should not trust this prediction.
    // This is a runtime SAFETY NET, not a fix — the real fix is retrain (Phase
    // 19.1 retrain plan deferred until accuracy-tracker has more 7d-MAE data).
    let coherenceFlag = null;
    if (corrected && corrected.length > 0) {
      const rawSum = raw.reduce((s, r) => s + (Number(r.power_w) || 0), 0);
      const corrSum = corrected.reduce((s, c) => s + (Number(c.power_w) || 0), 0);
      // Only run the check when rawSum is substantial (>1 kWh-equivalent across the
      // window) — at night both sums are ~0 and noisy ratios mean nothing.
      if (rawSum > 4000 && corrSum < rawSum * 0.3) {
        coherenceFlag = 'collapsed_low';
        pushLog('inspector_ml_correction_coherence_flag', {
          rawSum: Math.round(rawSum),
          corrSum: Math.round(corrSum),
          ratio: rawSum > 0 ? Math.round((corrSum / rawSum) * 100) / 100 : null,
          model: mlResult?.model || null,
        });
      } else if (rawSum > 4000 && corrSum > rawSum * 2.5) {
        coherenceFlag = 'collapsed_high';
        pushLog('inspector_ml_correction_coherence_flag', {
          rawSum: Math.round(rawSum),
          corrSum: Math.round(corrSum),
          ratio: rawSum > 0 ? Math.round((corrSum / rawSum) * 100) / 100 : null,
          model: mlResult?.model || null,
        });
      }
    }

    const payload = {
      window: { from, to },
      raw,
      corrected,
      delta,
      model: (mlResult && mlResult.model) || null,
      applied: !!(mlResult && mlResult.applied),
      reason: coherenceFlag ? coherenceFlag : ((mlResult && mlResult.reason) || null),
      mlEnabled,
      meta: { inputModel, cacheHit: false, coherenceFlag },
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
    function slotsOf(section) {
      if (Array.isArray(section)) return section;
      if (section && Array.isArray(section.slots)) return section.slots;
      return [];
    }
    const payloadSummary = forecastPayload ? {
      pvSlotCount: slotCountOf(forecastPayload.pv),
      loadSlotCount: slotCountOf(forecastPayload.load),
      priceSlotCount: slotCountOf(forecastPayload.price),
    } : { pvSlotCount: 0, loadSlotCount: 0, priceSlotCount: 0 };

    // Phase 21 — Operator request 2026-05-22: expose ACTUAL push data per
    // EOS provider endpoint, not just counts. The UI needs to show what
    // we're sending so the operator can verify the EOS integration end-
    // to-end. Mirror the (PV|Load|Price) → DateTimeData transformation
    // the adapter performs in pushForecast (eos-adapter.js:100-156),
    // capped to PAYLOAD_PREVIEW_LIMIT rows per provider to keep the
    // /api/forecast/inspector/eos response bounded.
    const PAYLOAD_PREVIEW_LIMIT = 200;
    function previewProvider(section, valueFn, unit) {
      const slots = slotsOf(section).slice(0, PAYLOAD_PREVIEW_LIMIT);
      const rows = [];
      for (const s of slots) {
        if (!s) continue;
        const ts = s.ts != null ? s.ts : s.start;
        const d = ts instanceof Date ? ts : new Date(ts);
        if (!Number.isFinite(d.getTime())) continue;
        rows.push({ ts_utc: d.toISOString(), value: valueFn(s) });
      }
      return { rows, unit, truncated: slotCountOf(section) > PAYLOAD_PREVIEW_LIMIT, totalCount: slotCountOf(section) };
    }
    const providers = forecastPayload ? {
      pv: previewProvider(forecastPayload.pv, function (s) { return Number(s.watts != null ? s.watts : (s.powerW != null ? s.powerW : 0)) || 0; }, 'W'),
      load: previewProvider(forecastPayload.load, function (s) { return Number(s.watts != null ? s.watts : (s.powerW != null ? s.powerW : 0)) || 0; }, 'W'),
      price: previewProvider(forecastPayload.price, function (s) {
        // EOS expects €/Wh; we surface ct/kWh for human readability.
        if (s.importCtKwh != null) return Number(s.importCtKwh) || 0;
        if (s.ctKwh != null) return Number(s.ctKwh) || 0;
        return 0;
      }, 'ct/kWh'),
    } : { pv: { rows: [], unit: 'W', truncated: false, totalCount: 0 },
          load: { rows: [], unit: 'W', truncated: false, totalCount: 0 },
          price: { rows: [], unit: 'ct/kWh', truncated: false, totalCount: 0 } };

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
      push: { ok: pushOk, payloadSummary, providers, error: pushError },
      pull: { ok: pullOk, slots: pullSlots, error: pullError },
      meta: { timeoutMs: 5000, previewLimit: PAYLOAD_PREVIEW_LIMIT },
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

    // 19.1-06: prefer multi-snapshot reconstruction when telemetry-store
    // returned .snapshots[] (sorted ascending). Falls back to single-snapshot
    // mode for back-compat (e.g. SQLite store still using LIMIT 1).
    const allSnapshots = Array.isArray(snapshot.snapshots) ? snapshot.snapshots : [snapshot];

    // Plan rules: use the LATEST snapshot's stage2 rules — Stage-2 plans rewrite
    // the full automation rule-set on every regeneration, so the latest planning
    // event is the source of truth for what Stage-2 INTENDED that day.
    const latestSnapshot = allSnapshots[allSnapshots.length - 1];
    const { planRules } = partitionRulesByStage2(latestSnapshot.rules || []);

    // Override rules: merge across ALL snapshots' override rules. If the operator
    // added a manual rule mid-day that was later overwritten by automation, the
    // earlier snapshot still has it. Keying on the rule's startTs preserves
    // per-slot lookup. operator_manual-tagged snapshots get priority for the
    // .source field shown in the UI.
    const overrideByTs = {};
    const snapshotsByOverrideTs = {};  // for tracking which snapshot contributed
    for (const snap of allSnapshots) {
      const { overrideRules: snapOverrides } = partitionRulesByStage2(snap.rules || []);
      for (const o of snapOverrides) {
        let ts = null;
        if (typeof o.startTs === 'number' && Number.isFinite(o.startTs)) {
          ts = new Date(o.startTs).toISOString();
        } else if (typeof o.startTs === 'string') {
          ts = o.startTs;
        }
        if (!ts) continue;
        // operator_manual snapshots always win over config_persist for the same ts
        const existing = snapshotsByOverrideTs[ts];
        if (!existing || (snap.source === 'operator_manual' && existing !== 'operator_manual')) {
          overrideByTs[ts] = {
            id: o.id || null,
            source: o.source || null,
            snapshotSource: snap.source || null,
            snapshotTs: snap.ts,
          };
          snapshotsByOverrideTs[ts] = snap.source;
        }
      }
    }

    // Build actual-by-ts map (key = ISO slot start)
    const actualByTs = {};
    for (const a of actuals) {
      const ts = typeof a.start === 'string' ? a.start : new Date(a.start).toISOString();
      actualByTs[ts] = Number(a.powerW);
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

    // 19.1-06: timeline of all snapshots that day, with their source tag, so the
    // frontend can show "X operator edits today at HH:MM, HH:MM, ..." badge.
    const snapshotTimeline = allSnapshots.map(s => ({
      id: s.id,
      ts: s.ts,
      source: s.source || null,
      ruleCount: Array.isArray(s.rules) ? s.rules.length : 0,
    }));
    const operatorEditCount = snapshotTimeline.filter(s => s.source === 'operator_manual').length;

    return {
      ok: true,
      date,
      snapshot: { id: latestSnapshot.id, ts: latestSnapshot.ts },
      snapshotTimeline,
      operatorEditCount,
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
