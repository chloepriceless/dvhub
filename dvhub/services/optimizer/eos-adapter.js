// services/optimizer/eos-adapter.js -- Bidirectional EOS adapter per D-12/D-14.
// Sends DVhub forecasts to co-hosted EOS and receives optimized schedules.
// Consistent { ok, error } contract -- NEVER throws (addresses Codex review concern).
import http from 'node:http';
import { toEosStrompreisArray } from './cost-model.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const EOS_DEFAULT_CONFIDENCE = 0.7;
const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * Create a bidirectional EOS adapter for co-hosted Akkudoktor EOS integration.
 *
 * @param {object} ctx - DI context with getCfg() and pushLog()
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000] - HTTP request timeout in ms
 * @returns {{ pushForecast: Function, pullSchedule: Function, isAvailable: Function }}
 */
export function createEosAdapter(ctx, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { getCfg, pushLog } = ctx;

  /**
   * Internal HTTP request helper. NEVER throws -- returns consistent { ok, data } or { ok, error }.
   *
   * @param {string} method - HTTP method (GET, PUT, POST)
   * @param {string} path - URL path (e.g. /v1/prediction/list)
   * @param {object|null} [body=null] - JSON body to send
   * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
   */
  function httpRequest(method, path, body = null) {
    const cfg = getCfg();
    const baseUrl = cfg.optimizer?.eosProxy?.url || 'http://localhost:8503';

    return new Promise((resolve) => {
      try {
        const url = new URL(path, baseUrl);

        const headers = {};
        if (body !== null) {
          headers['Content-Type'] = 'application/json';
        }

        const req = http.request({
          hostname: url.hostname,
          port: url.port || 8503,
          // Phase 21 hotfix (2026-05-23): include url.search so
          // `?force_enable=true` reaches EOS. Without this the import
          // endpoints returned 404 because the per-provider flag stayed
          // off — silently broke every push since Phase 19.1-01.
          path: url.pathname + url.search,
          method,
          headers,
          timeout: timeoutMs
        }, (res) => {
          let chunks = '';
          res.on('data', chunk => chunks += chunk);
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              resolve({ ok: false, error: `EOS returned HTTP ${res.statusCode}` });
              return;
            }
            // Phase 21 hotfix (2026-05-23): EOS' import endpoints reply
            // 200 OK with content-length:0 (no body) — JSON.parse('')
            // then surfaces as a false "invalid JSON" error. Empty body
            // on a 2xx = success; only complain when content is present
            // but unparseable.
            if (chunks.length === 0) {
              resolve({ ok: true, data: null });
              return;
            }
            try {
              const data = JSON.parse(chunks);
              resolve({ ok: true, data });
            } catch {
              resolve({ ok: false, error: 'EOS returned invalid JSON' });
            }
          });
        });

        req.on('error', (err) => {
          resolve({ ok: false, error: err.message || 'EOS connection error' });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ ok: false, error: 'EOS request timed out' });
        });

        if (body !== null) {
          req.write(JSON.stringify(body));
        }
        req.end();
      } catch (err) {
        resolve({ ok: false, error: err.message || 'EOS request failed' });
      }
    });
  }

  /**
   * Convert DVhub forecast response to EOS prediction format and send via PUT.
   * Accepts output of buildForecastResponse() from Phase 01.
   *
   * Phase 19.1-01: EOS v0.3.0 replaced PUT /v1/prediction/list with
   * PUT /v1/prediction/import/{provider_id} (per-provider import). We now
   * push three providers separately:
   *   - PVForecastImport       (PV power, W)
   *   - LoadImport             (load power, W)
   *   - ElecPriceImport        (electricity price, €/Wh)
   *
   * @param {object} forecastResponse - { pv: { slots }, price: { slots }, load: { slots } }
   * @returns {Promise<{ ok: boolean, error?: string, perProvider?: object }>}
   */
  async function pushForecast(forecastResponse) {
    const perProvider = {};
    const errors = [];

    // Phase 21 (2026-05-23 rewrite): the {ISO_TS: value} dict shape returned
    // HTTP 200 but data NEVER reached the provider — EOS' import_from_json
    // tries dataframe → datetimedata → simple-dict-with-record-keys in turn,
    // and our ts-keyed dict matched none (no record key matched a prefix in
    // the simple-dict branch), so each PUT no-op'd silently. Verified empty:
    //   curl /v1/prediction/series?key=pvforecast_ac_power → 0 entries
    // after 200-OK pushes.
    //
    // Correct shape per EOS dataabc.py:1670 example + PydanticDateTimeData:
    //   { start_datetime: ISO, interval: "15 minutes",
    //     "<provider_record_key>": [value, value, …] }
    //
    // Per-provider record key:
    //   PVForecastImport      → pvforecast_ac_power     (W)
    //   LoadImport            → loadforecast_power_w    (W)
    //   ElecPriceImport       → elecprice_marketprice_kwh (€/kWh)
    //   FeedInTariffImport    → feed_in_tariff_kwh      (€/kWh)
    // buildForecastResponse() slots are keyed { start: ISO, powerW: W } for
    // pv/load and { start: ISO, ctKwh } for price (services/forecast/index.js:
    // 195/199/217/221/173). Earlier this code read s.ts / s.watts, which don't
    // exist on those slots — every filter dropped 100% of slots, buildDateTimeData
    // returned null, and httpRequest then PUT a `null` body → EOS replied
    // HTTP 400 "Invalid JSON string 'null'" for every provider. Read the real
    // field names (start, powerW, ctKwh) so the body is populated.
    function buildDateTimeData(slots, recordKey, valueFn) {
      const validSlots = slots.filter(s => s && !Number.isNaN(new Date(s.start).getTime()));
      if (!validSlots.length) return null;
      const values = validSlots.map(valueFn);
      const start = new Date(validSlots[0].start).toISOString();
      // Derive interval from the first two slot timestamps. Default to
      // 15 minutes when only one slot exists.
      let intervalLabel = '15 minutes';
      if (validSlots.length >= 2) {
        const delta = new Date(validSlots[1].start).getTime() - new Date(validSlots[0].start).getTime();
        const minutes = Math.max(1, Math.round(delta / 60000));
        intervalLabel = minutes + ' minutes';
      }
      return { start_datetime: start, interval: intervalLabel, [recordKey]: values };
    }

    // PV
    if (forecastResponse.pv?.slots?.length) {
      const body = buildDateTimeData(forecastResponse.pv.slots, 'pvforecast_ac_power', s => Number(s.powerW) || 0);
      const res = await httpRequest('PUT', '/v1/prediction/import/PVForecastImport?force_enable=true', body);
      perProvider.pv = { ok: res.ok, error: res.error || null };
      if (!res.ok) errors.push(`PV: ${res.error}`);
    }

    // Load
    if (forecastResponse.load?.slots?.length) {
      const body = buildDateTimeData(forecastResponse.load.slots, 'loadforecast_power_w', s => Number(s.powerW) || 0);
      const res = await httpRequest('PUT', '/v1/prediction/import/LoadImport?force_enable=true', body);
      perProvider.load = { ok: res.ok, error: res.error || null };
      if (!res.ok) errors.push(`Load: ${res.error}`);
    }

    // Price — EOS' writable storage key is elecprice_marketprice_wh (€/Wh).
    // The _kwh variant is a computed property (= _wh × 1000). So values
    // MUST be in €/Wh = ct/kWh ÷ 100000. Per probe of EOS Python internals
    // (record_keys_writable check), only _wh is accepted by import_from_dict.
    if (forecastResponse.price?.slots?.length) {
      const enriched = forecastResponse.price.slots;
      const valueFn = enriched[0]?.importCtKwh != null
        ? s => (Number(s.importCtKwh) || 0) / 100000   // ct/kWh → €/Wh
        : s => (Number(s.ctKwh) || 0) / 100000;
      const body = buildDateTimeData(enriched, 'elecprice_marketprice_wh', valueFn);
      const res = await httpRequest('PUT', '/v1/prediction/import/ElecPriceImport?force_enable=true', body);
      perProvider.price = { ok: res.ok, error: res.error || null };
      if (!res.ok) errors.push(`Price: ${res.error}`);
    }

    // FeedInTariffImport — only when feedInMode='spot'. Writable storage key
    // is feed_in_tariff_wh (€/Wh). See FeedInTariffDataRecord.record_keys_
    // writable in EOS source — feed_in_tariff_kwh is computed-only.
    //
    // Note (2026-05-23): upstream EOS' /v1/prediction/import/{id} handler
    // currently silently drops every PUT (Pydantic-Union validation captures
    // the body as a model, json.dumps then fails inside the handler — patched
    // locally at /opt/dvhub/eos/.../server/eos.py:983 to use model_dump_json()).
    // Even with the patch, import_from_dict appears to no-op for non-trivial
    // reasons (provider state / ems_start_datetime alignment) — push.ok=true
    // but /v1/prediction/series returns 0 rows. Until that's solved end-to-end,
    // EOS keeps using its own internal providers (ElecPriceAkkudoktor etc.) and
    // this push code only stages the right shape for when the upstream
    // ingestion bug is properly fixed.
    if (forecastResponse.price?.slots?.length) {
      const cfg = getCfg();
      const tariff = cfg?.optimizer?.tariff || {};
      const mode = String(tariff.feedInMode || 'fixed').toLowerCase();
      if (mode === 'spot') {
        const factor = Number.isFinite(Number(tariff.feedInSpotFactor)) ? Number(tariff.feedInSpotFactor) : 1.0;
        const enriched = forecastResponse.price.slots;
        const feedFn = enriched[0]?.importCtKwh != null
          ? s => ((Number(s.importCtKwh) || 0) * factor) / 100000   // ct/kWh × factor → €/Wh
          : s => ((Number(s.ctKwh) || 0) * factor) / 100000;
        const body = buildDateTimeData(enriched, 'feed_in_tariff_wh', feedFn);
        const res = await httpRequest('PUT', '/v1/prediction/import/FeedInTariffImport?force_enable=true', body);
        perProvider.feedIn = { ok: res.ok, error: res.error || null };
        if (!res.ok) errors.push(`FeedIn: ${res.error}`);
      }
    }

    if (errors.length > 0) {
      return { ok: false, error: errors.join('; '), perProvider };
    }
    return { ok: true, perProvider };
  }

  /**
   * Phase 21 hotfix (2026-05-23): EOS v0.3.0 plan shape changed —
   *   {id, generated_at, instructions:[{execution_time, actuator_id,
   *    operation_mode_id, operation_mode_factor, type:'FRBCInstruction'}]}
   * was {result:[{start_time, battery_power}]}. Convert FRBC battery
   * instructions back to a (ts, powerW) slot stream so the inspector can
   * keep rendering the same table.
   *
   * power mapping (sign = battery perspective: + = charging, - = discharging):
   *   FORCED_CHARGE    → +factor × maxChargeW
   *   FORCED_DISCHARGE → -factor × maxDischargeW
   *   IDLE / SELF_CONSUMPTION / NON_EXPORT → 0  (no scheduled grid forcing)
   *   anything else → 0  (display-only; the rate is informational)
   */
  function planActionToPowerW(opMode, factor, maxChargeW, maxDischargeW) {
    const f = Number(factor);
    if (!Number.isFinite(f)) return 0;
    switch (opMode) {
      case 'FORCED_CHARGE':    return +f * (Number(maxChargeW) || 0);
      case 'FORCED_DISCHARGE': return -f * (Number(maxDischargeW) || 0);
      default:                  return 0;
    }
  }
  function convertEosPlanToSlots(planEntries, ctxCfg, planEndTs) {
    const maxChargeW    = ctxCfg?.optimizer?.maxChargeW    || 5000;
    const maxDischargeW = ctxCfg?.optimizer?.maxDischargeW || 5000;

    // Collect battery FRBC instructions only (EV / appliance are a separate
    // concern), as {baseTs, powerW, action}, then sort by time.
    const entries = [];
    for (const entry of planEntries) {
      if (!entry) continue;
      if (entry.type !== 'FRBCInstruction') continue;
      if (entry.actuator_id && !String(entry.actuator_id).startsWith('battery')) continue;
      // execution_time arrives with explicit offset (e.g. "+02:00") — let Date
      // parse it; do NOT append 'Z' (which broke 19.1-01 timezone math).
      const baseTs = new Date(entry.execution_time).getTime();
      if (!Number.isFinite(baseTs)) continue;
      entries.push({
        baseTs,
        powerW: planActionToPowerW(entry.operation_mode_id, entry.operation_mode_factor, maxChargeW, maxDischargeW),
        action: entry.operation_mode_id || 'IDLE',
      });
    }
    entries.sort((a, b) => a.baseTs - b.baseTs);
    if (!entries.length) return [];

    // EOS emits an instruction only when the battery operation mode CHANGES, on
    // the 15-min optimization grid (after the geneticsolution.py slot-resolution
    // fix). Each instruction therefore holds until the NEXT one — fill that span
    // at 15-min cadence. The old code blindly emitted 4 child slots per entry,
    // which was correct only while EOS instructions were hourly; once EOS went
    // 15-min, fixed-4 splitting overlapped consecutive instructions and mis-timed
    // the schedule. The trailing instruction fills to the plan's valid_until
    // (planEndTs) when known, else by the last observed inter-instruction gap.
    const slots = [];
    const MAX_SLOTS = 8 * 24 * 4; // safety cap: 8 days of 15-min slots
    for (let i = 0; i < entries.length; i++) {
      const cur = entries[i];
      let end;
      if (i + 1 < entries.length) {
        end = entries[i + 1].baseTs;
      } else if (Number.isFinite(planEndTs) && planEndTs > cur.baseTs) {
        end = planEndTs;
      } else {
        const lastGap = entries.length >= 2 ? (cur.baseTs - entries[entries.length - 2].baseTs) : QUARTER_HOUR_MS * 4;
        end = cur.baseTs + (lastGap > 0 ? lastGap : QUARTER_HOUR_MS * 4);
      }
      for (let t = cur.baseTs; t < end && slots.length < MAX_SLOTS; t += QUARTER_HOUR_MS) {
        slots.push({
          ts: t,
          endTs: t + QUARTER_HOUR_MS,
          powerW: cur.powerW,
          planAction: cur.action,
          confidence: EOS_DEFAULT_CONFIDENCE,
        });
      }
    }
    return slots;
  }

  async function pullSchedule() {
    const result = await httpRequest('GET', '/v1/energy-management/plan');

    if (!result.ok) {
      return null;
    }

    const plan = result.data;
    // Phase 21 hotfix: EOS v0.3.0 actually returns `instructions`, not the
    // documented `result` array. Accept either for forward/backward compat.
    const entries = Array.isArray(plan?.instructions) ? plan.instructions
                  : Array.isArray(plan?.result)       ? plan.result
                  : null;
    if (!entries) return null;

    // Pass the plan's validity end so the trailing instruction fills to the
    // real horizon end (15-min cadence) rather than a heuristic gap.
    const planEndTs = (plan && plan.valid_until) ? new Date(plan.valid_until).getTime() : undefined;

    try {
      return convertEosPlanToSlots(entries, getCfg(), planEndTs);
    } catch {
      return null;
    }
  }

  /**
   * Fetch EOS' optimization SOLUTION — the optimizer's OUTPUT (predicted SoC
   * trajectory, grid flows, per-slot costs), distinct from pullSchedule() which
   * returns only the dispatch instructions. GET /v1/energy-management/optimization/
   * solution returns an OptimizationSolution with a `solution` DateTimeDataFrame
   * (datetime-keyed rows) + KPI totals.
   *
   * Returns a compact, frontend-ready shape or null when no solution exists
   * (e.g. EOS hasn't optimised yet → HTTP 404). NEVER throws.
   *
   * @param {number} [previewLimit=300]
   * @returns {Promise<null | {
   *   generatedAt: string|null, validFrom: string|null, validUntil: string|null,
   *   slotMinutes: number|null,
   *   kpis: { totalCostsAmt: number|null, totalRevenuesAmt: number|null, totalLossesWh: number|null },
   *   rows: Array<{ ts_utc: string, socPct: number|null, gridConsumptionWh: number|null,
   *                 gridFeedinWh: number|null, costsAmt: number|null, revenueAmt: number|null }>,
   *   truncated: boolean, totalCount: number,
   * }>}
   */
  async function getOptimizationSolution(previewLimit = 300) {
    const res = await httpRequest('GET', '/v1/energy-management/optimization/solution');
    if (!res.ok || !res.data) return null;
    const sol = res.data;
    const data = sol.solution && sol.solution.data ? sol.solution.data : null;
    if (!data || typeof data !== 'object') return null;
    // EOS' prediction frame (same 15-min time index as the solution) carries the
    // PV/load forecast EOS actually optimised against — surface PV so the card
    // can show "what EOS predicts for PV", not just the resulting dispatch.
    const pred = (sol.prediction && sol.prediction.data && typeof sol.prediction.data === 'object')
      ? sol.prediction.data : {};

    // Datetime-keyed rows. Sort by timestamp (object key order is not guaranteed
    // across JSON parses). Derive the battery SoC key dynamically — the device id
    // is 'battery1' but a config-sync variant may register a different prefix; we
    // want the battery's *_soc_factor, never the EV's.
    const tsKeys = Object.keys(data).sort();
    let socKey = null;
    if (tsKeys.length) {
      const sample = data[tsKeys[0]] || {};
      socKey = Object.keys(sample).find(k => /_soc_factor$/.test(k) && !/(^|_)ev\d*_/.test(k)) || null;
    }
    const numOrNull = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
    const allRows = tsKeys.map((ts) => {
      const r = data[ts] || {};
      const pr = pred[ts] || {};
      const socFactor = socKey != null ? r[socKey] : undefined;
      return {
        ts_utc: new Date(ts).toISOString(),
        socPct: numOrNull(socFactor) != null ? Math.round(socFactor * 100) : null,
        pvWh: numOrNull(pr.pvforecast_ac_energy_wh),
        loadWh: numOrNull(pr.loadforecast_energy_wh),
        // EOS' electricity price for this slot, €/kWh → ct/kWh (the spot price
        // the optimizer actually priced grid import against).
        priceCtKwh: numOrNull(pr.elec_price_amt_kwh) != null ? pr.elec_price_amt_kwh * 100 : null,
        gridConsumptionWh: numOrNull(r.grid_consumption_energy_wh),
        gridFeedinWh: numOrNull(r.grid_feedin_energy_wh),
        costsAmt: numOrNull(r.costs_amt),
        revenueAmt: numOrNull(r.revenue_amt),
      };
    });

    let slotMinutes = null;
    if (tsKeys.length >= 2) {
      const delta = new Date(tsKeys[1]).getTime() - new Date(tsKeys[0]).getTime();
      if (Number.isFinite(delta) && delta > 0) slotMinutes = Math.round(delta / 60000);
    }

    return {
      generatedAt: sol.generated_at || null,
      validFrom: sol.valid_from || null,
      validUntil: sol.valid_until || null,
      slotMinutes,
      kpis: {
        totalCostsAmt: numOrNull(sol.total_costs_amt),
        totalRevenuesAmt: numOrNull(sol.total_revenues_amt),
        totalLossesWh: numOrNull(sol.total_losses_energy_wh),
      },
      rows: allRows.slice(0, previewLimit),
      truncated: allRows.length > previewLimit,
      totalCount: allRows.length,
    };
  }

  /**
   * Check if EOS is reachable and responding.
   *
   * @returns {Promise<boolean>}
   */
  async function isAvailable() {
    // EOS Akkudoktor FastAPI exposes /v1/health (returns {status:"alive",...}).
    // /v1/ returns 404 on EOS v0.3.0 (post-starlette<1.0 pin from Phase 18).
    const result = await httpRequest('GET', '/v1/health');
    return result.ok;
  }

  return { pushForecast, pullSchedule, getOptimizationSolution, isAvailable };
}
