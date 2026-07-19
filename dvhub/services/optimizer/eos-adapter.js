// services/optimizer/eos-adapter.js -- Bidirectional EOS adapter per D-12/D-14.
// Sends DVhub forecasts to co-hosted EOS and receives optimized schedules.
// Consistent { ok, error } contract -- NEVER throws (addresses Codex review concern).
import http from 'node:http';
import { toEosStrompreisArray } from './cost-model.js';
import { classifyEosSlotAction } from '../../eos-zeitplan-map.js';

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

    // Price (elecprice_marketprice_wh) + Feed-in (feed_in_tariff_wh): deliberately
    // NOT pushed here. The EOS-Forecast-Bridge (services/optimizer/eos-forecast-
    // bridge.js, own scheduled push) is the canonical SINGLE-SOURCE writer for the
    // price signal — it applies the fixed-tariff import price (flat gross ct/kWh in
    // fixed mode, 2026-05-30) AND the Direktvermarktung market premium on feed-in
    // (§51-aware, 2026-06-21).
    //
    // Phase 30 (P30-R2, 2026-06-22): this adapter previously PUT raw spot to BOTH
    // providers (importCtKwh ?? ctKwh, feed-in ×factor without premium). Once the
    // Phase-22.1 bridge made /v1/prediction/import actually land, the adapter's
    // per-optimizer-run push RACED the bridge's timer push (last-writer-wins) and
    // clobbered both fixes: on prod the GA read a spot elecprice (~6 ct midday)
    // instead of the flat 26.9 ct Endkundenpreis, and feed-in lost its market
    // premium (elecprice == feed_in == raw spot, verified read-only 2026-06-22).
    // The fix is to stop writing the price signal here — the bridge owns it. The
    // pv/load pushes above stay (identical between both writers, harmless).
    perProvider.price = { ok: true, skipped: 'bridge owns elecprice (Phase 30 R2)' };
    perProvider.feedIn = { ok: true, skipped: 'bridge owns feed_in (Phase 30 R2)' };

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
        // EOS' electricity price for this slot, €/kWh → ct/kWh. With fixed-tariff
        // operators this is the flat Endkunden-Bezugspreis the optimizer prices
        // grid IMPORT against (e.g. 26.9 ct).
        priceCtKwh: numOrNull(pr.elec_price_amt_kwh) != null ? pr.elec_price_amt_kwh * 100 : null,
        // The spot / feed-in tariff for this slot, €/kWh → ct/kWh — what EOS
        // values grid EXPORT (Einspeisung/Vermarktung) at. Shown next to the
        // import price so the operator sees both sides (buy vs sell) per slot.
        feedInCtKwh: numOrNull(pr.feed_in_tariff_amt_kwh) != null ? pr.feed_in_tariff_amt_kwh * 100 : null,
        gridConsumptionWh: numOrNull(r.grid_consumption_energy_wh),
        gridFeedinWh: numOrNull(r.grid_feedin_energy_wh),
        costsAmt: numOrNull(r.costs_amt),
        revenueAmt: numOrNull(r.revenue_amt),
        // Raw genetic intent factors — used below to classify the slot's
        // Zeitplan lever; not surfaced directly.
        _dischargeAllowedFactor: numOrNull(r.genetic_discharge_allowed_factor),
        _dcChargeFactor: numOrNull(r.genetic_dc_charge_factor),
      };
    });

    // WS1 (2026-05-30): translate each EOS slot into the DVhub Victron grid
    // setpoint it *would* command — display only, no write path. Convention
    // (schedule-eval gridSetpointW / Victron ESS register 2700): positive =
    // draw FROM grid (import/charge), negative = feed INTO grid (export/
    // discharge), 0 = hold/self-consumption. Net grid power for the slot =
    // (import − feed-in) energy / slot-hours. slotMinutes computed below, so
    // derive hours per row from the global slot length once known.
    const slotMinutesForSetpoint = (() => {
      if (allRows.length >= 2) {
        const d = new Date(tsKeys[1]).getTime() - new Date(tsKeys[0]).getTime();
        if (Number.isFinite(d) && d > 0) return Math.round(d / 60000);
      }
      // Review 2026-06-10 (B8): a single-row solution has no derivable slot
      // length — guessing 15 min turned a 1h slot's Wh into a 4×-too-large
      // setpoint. Return null → slotHours 0 → dvhubSetpointW stays null and
      // the slot is not actuated (safe skip instead of a wrong write).
      return null;
    })();
    const slotHoursForSetpoint = slotMinutesForSetpoint / 60;
    // WS-EOS (2026-06-01): translate each EOS slot into the DVhub Zeitplan lever
    // it would command — display only, no write path. The operator validates
    // "macht EOS in der Vorhersage die richtigen Sachen?" by reading the per-slot
    // action in the EOS-Übersicht. Levers mirror the kleine Börsenautomatik:
    // dcExportMode (PV- / PV+Akku-Einspeisung) and gridSetpointW (Halten).
    const cfg = (typeof getCfg === 'function' ? getCfg() : null) || {};
    const bufferW = Number(cfg?.dcExportMode?.bufferW) || 100;
    const connectionLimitW = Number(cfg?.optimizer?.inverterMaxPowerW) || 29000;
    // Resolve the preview AC cap along the SAME chain EOS uses for its battery
    // power (maxDischargeW || maxChargeW), then fall back to the physical
    // inverter ceiling (connectionLimitW) instead of a hardcoded 16 kW. A
    // hardcoded default would show a stale "Akku 16000" after a power upgrade
    // (2026-07-19) and mislead customers whose limit differs — the number must
    // always track the operator's configured/physical limit, never a magic W.
    const akkuAcLimitW = Number(cfg?.optimizer?.akkuAcLimitW)
      || Number(cfg?.optimizer?.maxDischargeW)
      || Number(cfg?.optimizer?.maxChargeW)
      || connectionLimitW;
    for (const row of allRows) {
      const imp = row.gridConsumptionWh;
      const exp = row.gridFeedinWh;
      // Keep the raw net-grid setpoint for the existing display column.
      row.dvhubSetpointW =
        (imp != null || exp != null) && slotHoursForSetpoint > 0
          ? Math.round(((Number(imp) || 0) - (Number(exp) || 0)) / slotHoursForSetpoint)
          : null;
      // Wh → W for the slot, then classify into a Zeitplan lever.
      const h = slotHoursForSetpoint > 0 ? slotHoursForSetpoint : 0.25;
      const action = classifyEosSlotAction({
        pvW: (Number(row.pvWh) || 0) / h,
        feedinW: (Number(exp) || 0) / h,
        loadW: (Number(row.loadWh) || 0) / h, // enables the "Akku lädt + Überschuss" label
        importW: (Number(imp) || 0) / h,
        dischargeAllowed: (row._dischargeAllowedFactor || 0) > 0,
        dcChargeFactor: row._dcChargeFactor || 0,
        socPct: row.socPct,
        stopSocPct: null, // forecast preview — runtime applies the live floor
        bufferW, akkuAcLimitW, connectionLimitW
      });
      row.zeitplanAction = action.action;
      row.zeitplanLabel = action.label;
      row.zeitplanTarget = action.target;
      row.zeitplanBatteryExportW = action.batteryExportW;
      row.zeitplanGridSetpointW = action.gridSetpointW;
      delete row._dischargeAllowedFactor;
      delete row._dcChargeFactor;
    }

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
   * T-0118 (2026-06-06): build GRID-SETPOINT control slots directly from EOS'
   * optimization SOLUTION (its own predicted per-slot grid flows), NOT from the
   * FRBC plan instructions. The plan's op-mode strings (PEAK_SHAVING /
   * grid_support_export / NON_EXPORT) carry no power magnitude, so the
   * plan→power converter (convertEosPlanToSlots) maps EOS' real battery→grid
   * export to 0 — DVhub silently dropped the entire arbitrage plan. The solution
   * row's (grid_consumption − grid_feedin) energy IS the net grid EOS decided
   * for that slot, already AC-side and loss-correct (= row.dvhubSetpointW, the
   * same value the EOS inspector shows): positive = import, negative = export.
   *
   * Operator policy (2026-06-06): EOS owns the full economic decision (peak
   * export, self-consumption holds, AND deliberate cheap emptying before a
   * curtailment window to free room for otherwise-curtailed PV). We therefore
   * ACTUATE only its deliberate EXPORTs and leave everything else to the plant's
   * safe self-consumption default:
   *   • Emit a rule for every genuine EXPORT slot, split by lever (T-0124b):
   *       – pure PV-surplus feed-in (B=0) → lever 'dcExportMode' (live PV drives
   *         gridSetpointW = -(PV−buffer) every cycle, like the manual "100 %
   *         Einspeisung" checkbox — the real PV sets the setpoint, no static value).
   *       – deliberate battery export (B>0, e.g. the evening dump) → lever
   *         'gridSetpointW' with the closed-loop (B + live PV on top, reg-2704 cap).
   *     Import / self-consumption / PV-charge slots are still skipped → plant
   *     default. We NEVER write a positive (grid-charge) value (§14a-safe).
   *   • Hard guard — never export at a negative feed-in price (curtail instead +
   *     keep the §51 Förder hours). EOS already curtails internally; this is
   *     defense in depth at the actuation edge.
   *
   * @param {number} [bandW=300] |net grid| ≤ this ⇒ self-consumption ⇒ no rule
   * @returns {Promise<Array<{ts:number,endTs:number,powerW:number,planAction:string,confidence:number}>|null>}
   */
  async function pullGridSetpoints(bandW = 300) {
    // Cover the full EOS horizon (≤8 days of 15-min slots) — no tail truncation.
    const sol = await getOptimizationSolution(8 * 24 * 4);
    if (!sol || !Array.isArray(sol.rows) || sol.rows.length === 0) return null;
    const slotMin = Number(sol.slotMinutes) > 0 ? Number(sol.slotMinutes) : 15;
    const slotMs = slotMin * 60 * 1000;
    const slotH = slotMin / 60;
    // T-0121: only ACTUATE rules within a horizon. The plan covers days, but rules
    // for slots >horizon out get recomputed at the next (hourly) run as conditions
    // change — emitting them now just churns hundreds of rules. Default 12 h.
    const acfg = (typeof getCfg === 'function' ? getCfg() : null) || {};
    const horizonH = Number(acfg.optimizer?.ruleHorizonHours) > 0 ? Number(acfg.optimizer.ruleHorizonHours) : 12;
    const horizonCutoff = Date.now() + horizonH * 3600 * 1000;
    const out = [];
    for (const r of sol.rows) {
      const ts = new Date(r.ts_utc).getTime();
      if (!Number.isFinite(ts)) continue;
      if (ts > horizonCutoff) continue; // beyond the actuation horizon — recomputed next run
      const gridW = (typeof r.dvhubSetpointW === 'number') ? r.dvhubSetpointW : null;
      if (gridW === null) continue;
      // Only deliberate EXPORT becomes a forced setpoint. Skip import / hold /
      // self-consumption (gridW ≥ −band) — plant default, and never force charge.
      if (gridW >= -bandW) continue;
      // Hard guard: never export at a negative feed-in price.
      const feedInCt = (typeof r.feedInCtKwh === 'number') ? r.feedInCtKwh : null;
      if (feedInCt !== null && feedInCt < 0) continue;
      // T-0121 closed-loop: split the planned net export into a PV-surplus part
      // (re-derived from LIVE PV every control cycle in schedule-eval) and the
      // battery part B — the deliberate Akku→Netz dump, held from the plan. At
      // the evening peak PV≈0 so B ≈ net export; for a pure-surplus slot B≈0.
      // The precise plan-split is noisy, but the reg-2704 cap (= B) bounds it.
      const pvW = slotH > 0 ? (Number(r.pvWh) || 0) / slotH : 0;
      const loadW = slotH > 0 ? (Number(r.loadWh) || 0) / slotH : 0;
      const pvSurplusW = Math.max(0, pvW - loadW);
      const batteryShareW = Math.max(0, -gridW - pvSurplusW); // -gridW = net export (W)
      if (batteryShareW <= 0) {
        // T-0124b (operator 2026-06-09, supersedes T-0124): a PURE PV-surplus
        // feed-in slot — EOS' forecast PV covers the planned export, no deliberate
        // battery share. Actuate it via the dcExportMode lever instead of a static
        // setpoint: schedule-eval drives gridSetpointW = -(live PV − buffer) every
        // cycle, so the REAL measured PV sets the setpoint (Christin 2026-06-09:
        // "der echte PV setzt den grid setpoint") — the exact same "100 %
        // Einspeisung" lever the manual Zeitplan checkbox uses. Neg-price pause and
        // the dcExportMode SoC-guard still apply (handled in schedule-eval). No
        // static gridSetpointW → no forecast-vs-live mismatch forcing a drain.
        // T-CURTAIL-CHARGE (Christin 2026-06-25): when EOS ALSO charges the
        // battery in this surplus slot (planned net export < PV surplus), the
        // "100 % Einspeisung" lever must NOT export all live PV — it would export
        // the power EOS wanted to charge with (midday: PV 20 kW, charge 10 kW,
        // export 8 kW → batteryShareW=0 above, yet 10 kW belong to the battery).
        // chargeReserveW = the EOS-planned charge (PV surplus − planned net
        // export); schedule-eval subtracts it from LIVE PV before exporting, so
        // the battery charges and only the real surplus above it is fed in.
        // Below the band it is plan-split noise → 0 (behaviour unchanged).
        const plannedChargeW = pvSurplusW + gridW; // gridW<0 ⇒ = pvSurplus − netExport
        const chargeReserveW = plannedChargeW > bandW ? Math.round(plannedChargeW) : 0;
        out.push({
          ts,
          endTs: ts + slotMs,
          lever: 'dcExportMode',
          planAction: 'eos_pv_export',
          confidence: EOS_DEFAULT_CONFIDENCE,
          ...(chargeReserveW > 0 ? { chargeReserveW } : {}),
        });
        continue;
      }
      out.push({
        ts,
        endTs: ts + slotMs,
        lever: 'gridSetpointW',
        powerW: gridW,
        batteryShareW,
        closedLoopExport: true,
        planAction: 'eos_grid_export',
        confidence: EOS_DEFAULT_CONFIDENCE,
      });
    }
    return out;
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

  return { pushForecast, pullSchedule, pullGridSetpoints, getOptimizationSolution, isAvailable };
}
