// services/optimizer/eos-config-sync.js — Phase 21 (operator request 2026-05-23).
//
// Pushes DVhub's optimizer/battery/inverter settings into EOS via the
// path-based PUT /v1/config/{section} endpoint. Without this, EOS keeps its
// bootstrap defaults (8 kWh battery, 5 kW charge, 0% min-SoC, 10 kW inverter)
// regardless of what DVhub knows about the operator's actual hardware — so
// the genetic optimizer produces plans for a fictional appliance.
//
// Triggered from server.js:saveAndApplyConfig() (fire-and-forget) and once
// at boot when EOS first reports healthy. Same defensive contract as
// eos-adapter.js: never throws, returns { ok, applied, errors }.

import http from 'node:http';

const TIMEOUT_MS = 8_000;
const BATTERY_DEVICE_ID = 'battery1';   // EOS default — mirrors what EOS bootstraps.
const INVERTER_DEVICE_ID = 'inverter1'; // EOS default — same.
// Standard 11-step charge-rate grid used by EOS GENETIC (0 .. 1 in 0.1 steps).
const DEFAULT_CHARGE_RATES = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

/**
 * Split a round-trip efficiency into a symmetric charge/discharge pair.
 * DVhub stores one round-trip number; EOS wants two. sqrt(rt) gives a
 * symmetric split that round-trips back to the original.
 *
 * @param {number} rt - round-trip efficiency, expected in (0, 1].
 * @returns {number} per-direction efficiency in (0, 1].
 */
function splitRoundTripEff(rt) {
  if (!Number.isFinite(rt) || rt <= 0 || rt > 1) return 0.94; // safe symmetric default
  return Math.sqrt(rt);
}

/**
 * Whether the operator is currently licensed for grid-arbitrage charging
 * (Netzbezug zum Akku-Laden). Allowed only with MisPel "pauschal" or
 * "abgrenzung" mode and the operator's explicit allowGridCharge consent.
 *
 * Without this gate the genetic algo MUST NOT see AC charge rates — otherwise
 * it would happily pencil in grid→battery transfers that are §14a-illegal
 * for vanilla self-consumption operators.
 *
 * @param {object} cfg
 * @returns {boolean}
 */
function isGridArbitrageLicensed(cfg) {
  const allow = cfg?.optimizer?.allowGridCharge === true;
  const mispelMode = cfg?.optimizer?.mispel?.mode;
  return allow && (mispelMode === 'pauschal' || mispelMode === 'abgrenzung');
}

/**
 * Build the EOS batteries array from a DVhub config object. Returns a single
 * battery entry — DVhub only ever models one home-battery bank. Keeps the
 * EOS measurement_key_* fields untouched (EOS regenerates them itself when
 * device_id is preserved).
 *
 * charge_rates encodes whether AC-from-grid charging is a legal option in
 * the genetic search space:
 *   - Arbitrage-licensed → full 11-step grid [0.0 … 1.0] so the algo can pick
 *     partial charge powers when night-spot < day-spot − charges_kwh.
 *   - Otherwise → [1.0] only; combined with the discharge_hours_bin encoding
 *     this leaves Idle and DC-from-PV-Charge as the only positive states.
 *
 * @param {object} cfg - DVhub raw config (from getCfg()).
 * @returns {Array<object>}
 */
export function buildEosBatteries(cfg, opts = {}) {
  const opt = cfg?.optimizer || {};
  const eff = splitRoundTripEff(opt.roundTripEfficiency);
  const costs = cfg?.userEnergyPricing?.costs || {};
  // ct/kWh + loss-markup% → €/kWh. Defaults to 0 (EOS bootstrap value) so a
  // missing pricing block doesn't accidentally penalise battery dispatch.
  const baseCt = Number(costs.batteryBaseCtKwh) || 0;
  const markupPct = Number(costs.batteryLossMarkupPct) || 0;
  const levelisedEurKwh = (baseCt / 100) * (1 + markupPct / 100);

  const chargeRates = isGridArbitrageLicensed(cfg) ? DEFAULT_CHARGE_RATES : [1.0];

  return [{
    device_id: BATTERY_DEVICE_ID,
    capacity_wh: Number(opt.batteryCapacityWh) || 8000,
    charging_efficiency: eff,
    discharging_efficiency: eff,
    levelized_cost_of_storage_kwh: Number(levelisedEurKwh.toFixed(6)),
    max_charge_power_w: Number(opt.maxChargeW) || 5000,
    // DVhub has no min_charge_power_w setting — leave EOS default (50 W is
    // a sane modulation floor for most hybrid inverters; configurable later).
    min_charge_power_w: 50,
    charge_rates: chargeRates,
    // min_soc defaults to the soft optimizer floor, but the sync passes DVhub's
    // hard floor (Victron BMS minSocPct) so EOS may discharge as deep as DVhub
    // does (avoids overnight grid-import to hold an artificially high floor).
    min_soc_percentage: Number.isFinite(Number(opts.minSocPct)) ? Number(opts.minSocPct) : (Number(opt.minSocPct) || 0),
    max_soc_percentage: Number(opt.maxSocPct) || 100,
  }];
}

/**
 * Build the EOS electric-vehicle device list (only used when the operator
 * enables EV optimization via cfg.optimizer.eosOptimizeEv). Mirrors the EOS
 * 'ev11' defaults; overridable via cfg.optimizer.ev{CapacityWh,MaxChargeW,
 * MinSocPct}. Charge_rates are the 11-step grid so the genetic algo can pick a
 * partial charge power per slot.
 *
 * @param {object} cfg
 * @returns {Array<object>}
 */
export function buildEosElectricVehicles(cfg) {
  const opt = cfg?.optimizer || {};
  return [{
    device_id: 'ev11',
    capacity_wh: Number(opt.evCapacityWh) || 50000,
    charging_efficiency: 0.88,
    discharging_efficiency: 0.88,
    max_charge_power_w: Number(opt.evMaxChargeW) || 5000,
    min_charge_power_w: 50,
    charge_rates: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    min_soc_percentage: Number.isFinite(Number(opt.evMinSocPct)) ? Number(opt.evMinSocPct) : 70,
    max_soc_percentage: 100,
  }];
}

/**
 * Build the EOS elecprice section. When the operator has configured the
 * dynamicComponents (Netzentgelte + Abgaben + Energie-Markup), surface their
 * sum as `charges_kwh` so the genetic algo prices grid imports at the real
 * Endkundenpreis instead of pure spot. Without this, EOS would systematically
 * under-estimate the cost of grid charging and over-recommend it.
 *
 * @param {object} cfg
 * @returns {object|null} { charges_kwh, vat_rate } or null when not in dynamic mode.
 */
export function buildEosElecprice(cfg) {
  const pricing = cfg?.userEnergyPricing;
  if (pricing?.mode !== 'dynamic') return null;
  const dc = pricing.dynamicComponents || {};
  const sumCtKwh =
    (Number(dc.energyMarkupCtKwh) || 0) +
    (Number(dc.gridChargesCtKwh) || 0) +
    (Number(dc.leviesAndFeesCtKwh) || 0);
  if (sumCtKwh <= 0) return null; // nothing meaningful to push
  const vatPct = Number(dc.vatPct);
  const vatRate = Number.isFinite(vatPct) && vatPct > 0 ? 1 + vatPct / 100 : 1.19;
  return {
    charges_kwh: Number((sumCtKwh / 100).toFixed(6)),
    vat_rate: Number(vatRate.toFixed(4)),
  };
}

/**
 * Build the EOS optimization section. interval=900 (15-min slots) is enabled
 * by the DVhub fork's genetic-slot-math refactor (see eos-patches/apply.sh
 * Phase A) and gives DV operators the EPEX day-ahead-2024 resolution. Default
 * stays 3600 for safety; operators opt-in via optimizer.eosOptimizationIntervalSec.
 *
 * @param {object} cfg
 * @returns {object}
 */
export function buildEosOptimization(cfg) {
  const opt = cfg?.optimizer || {};
  const intervalSec = Number(opt.eosOptimizationIntervalSec);
  const interval = [900, 1800, 3600].includes(intervalSec) ? intervalSec : 3600;
  return { interval };
}

/**
 * Pick a sane genetic-sizing tuple for the chosen slot resolution.
 *
 * The genetic algo's wallclock scales (roughly) linearly with
 *   generations × individuals × slot_count.
 *
 * At interval=3600, slot_count=48 with the upstream default (gens=400,
 * pop=300) runs in ~10-30s — fine. At interval=900, slot_count jumps to 192
 * AND the genome doubles in length per step (charge+EV vectors), so the
 * upstream defaults push wallclock to 10-15min per cycle (verified
 * empirically on prod 2026-05-24). EOS' ems.interval is 300s by default, so
 * a >5min genetic run completely starves the loop and the operator never
 * sees a fresh plan.
 *
 * The diminishing-returns knee for this problem class is around
 * generations=100 / individuals=200 at 15-min — fitness gain past that is
 * <1%. We shrink both at high slot counts so 15-min Direktvermarktung stays
 * under ems.interval. Operator can still override via genetic.generations /
 * genetic.individuals if they want longer runs.
 *
 * @param {number} intervalSec
 * @returns {{generations: number, individuals: number}}
 */
export function pickGeneticSizing(intervalSec) {
  // Operator preference 2026-05-24: at 15-min resolution we'd rather have a
  // high-quality plan once an hour than a degraded plan every 5min. PV/load/
  // spot inputs don't shift fast enough to warrant a sub-hourly refresh at
  // this granularity. Hourly EMS-runs (see pickEmsIntervalSec) give the
  // genetic algo enough wallclock for the full upstream sizing even at
  // 192-slot horizons.
  return { generations: 400, individuals: 300 };
}

/**
 * EMS tick interval — how often the energy-management loop fires a fresh
 * genetic optimization. At 15-min slot resolution a single run takes ~30-60
 * min, so we slow the ticker to 3600s (= 1 run/hour) so the loop never
 * stomps on itself. Hourly slot resolution keeps the EOS default 300s.
 *
 * @param {number} intervalSec  the slot resolution from buildEosOptimization
 * @returns {number}             ems.interval in seconds
 */
export function pickEmsIntervalSec(intervalSec) {
  if (intervalSec === 900) return 3600;
  if (intervalSec === 1800) return 1800;
  return 300; // hourly — upstream default
}

/**
 * Build the EOS inverters array. DVhub doesn't yet expose AC-cap or per-
 * direction conversion efficiencies as first-class config; we derive max_power_w
 * from the PV nameplate (mispel.pvKwp × 1000) as a defensible upper bound and
 * use symmetric 1.0 conversion efficiencies (which match EOS bootstrap, so
 * no behaviour change unless DVhub later adds explicit fields).
 *
 * @param {object} cfg
 * @returns {Array<object>}
 */
export function buildEosInverters(cfg) {
  const opt = cfg?.optimizer || {};
  const pvKwp = Number(opt?.mispel?.pvKwp);
  const maxPowerW = Number.isFinite(pvKwp) && pvKwp > 0 ? pvKwp * 1000 : 10000;
  return [{
    device_id: INVERTER_DEVICE_ID,
    max_power_w: maxPowerW,
    battery_id: BATTERY_DEVICE_ID,
    ac_to_dc_efficiency: 1.0,
    dc_to_ac_efficiency: 1.0,
    max_ac_charge_power_w: Number(opt.maxChargeW) || null,
  }];
}

/**
 * Internal HTTP helper. Mirrors eos-adapter.js — never throws, returns
 * { ok, data?, error? } so the caller can fan out per-section errors.
 */
function eosHttpRequest(baseUrl, method, path, body) {
  return new Promise((resolve) => {
    try {
      const url = new URL(path, baseUrl);
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 8503,
        path: url.pathname,
        method,
        headers,
        timeout: TIMEOUT_MS,
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({ ok: false, error: `EOS HTTP ${res.statusCode}: ${chunks.slice(0, 200)}` });
            return;
          }
          try {
            resolve({ ok: true, data: chunks ? JSON.parse(chunks) : null });
          } catch {
            resolve({ ok: true, data: null });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message || 'EOS connect error' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'EOS timeout' }); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message || 'EOS request failed' });
    }
  });
}

/**
 * Create an EOS config-sync agent. Returns a single `sync()` function that
 * pushes battery + inverter config sections to EOS. Caller can pushLog the
 * structured result.
 *
 * @param {object} ctx - DI context with getCfg() and pushLog()
 * @returns {{ sync: () => Promise<{ok: boolean, applied: string[], errors: object}> }}
 */
export function createEosConfigSync(ctx) {
  const { getCfg, pushLog, state } = ctx;

  async function sync() {
    const cfg = getCfg();
    const baseUrl = cfg?.optimizer?.eosProxy?.url || 'http://127.0.0.1:8503';

    // No-op when the operator has explicitly disabled the EOS bridge — avoids
    // log spam when EOS isn't running and the operator doesn't intend it to.
    if (cfg?.optimizer?.eosProxy?.enabled === false) {
      return { ok: true, applied: [], errors: {}, skipped: 'eosProxy.enabled=false' };
    }

    // EOS min_soc should be DVhub's HARD floor (the live Victron BMS minSocPct,
    // = the absolute level DVhub itself discharges to, default 5%), NOT the soft
    // optimizer.minSocPct (10%). With min_soc=10 EOS hits 10% overnight and then
    // *imports from grid* to hold it instead of riding the battery down to 5%
    // and refilling via PV in the morning (operator request 2026-05-29).
    const hardFloorSocPct = Number(state?.victron?.minSocPct);
    const eosMinSocPct = Number.isFinite(hardFloorSocPct) ? hardFloorSocPct : 5;

    const batteries = buildEosBatteries(cfg, { minSocPct: eosMinSocPct });
    const inverters = buildEosInverters(cfg);
    const elecprice = buildEosElecprice(cfg);
    const optimization = buildEosOptimization(cfg);
    const geneticSizing = pickGeneticSizing(optimization.interval);

    // Phase 21 hotfix (2026-05-23): provider auto-flip REVERTED. The
    // earlier idea (auto-set elecprice/load/pvforecast/feedintariff providers
    // to their *Import variants + ems.mode='OPTIMIZATION') hit an upstream
    // EOS bug: /v1/prediction/import/{provider_id} returns 200 OK but the
    // PUT body is silently dropped before reaching storage (Pydantic Union
    // validation captures the body as a model, then json.dumps fails inside
    // the handler — verified by reading /v1/prediction/series?key=... and
    // finding 0 entries after every successful PUT). Flipping providers
    // without working imports left EOS running OPTIMIZATION with empty data
    // → bullshit plans. Until the EOS handler is patched OR we switch to
    // file-based import (writing JSON files + setting
    // *.provider_settings.*Import.import_file_path), we only sync the
    // device hardware spec (battery + inverter capacities). Provider choice
    // + ems.mode stay operator-owned via EOSdash.
    //
    // Phase 22 (2026-05-24): added optimization.interval (15-min slots) and
    // elecprice.charges_kwh (Bezugs-Aufschlag for grid-import pricing).
    // These hit field-level PUT endpoints (PUT /v1/config/{path}) one value
    // at a time — the section-level shape only works for {device,inverter}.
    const emsIntervalSec = pickEmsIntervalSec(optimization.interval);
    // EV optimization is opt-in via cfg.optimizer.eosOptimizeEv (default OFF,
    // operator request 2026-05-29). When OFF, EOS gets max_electric_vehicles=0
    // (geneticparams → electric_vehicle_params=None) so it does NOT schedule EV
    // charging from the grid overnight — the operator charges the EV from PV
    // during the day, and that load is already captured by the LoadImport
    // forecast. When ON, EOS models the EV as a separately-optimised device.
    const optimizeEv = cfg?.optimizer?.eosOptimizeEv === true;
    const evTasks = optimizeEv
      ? [
          { section: 'devices/max_electric_vehicles', body: 1 },
          { section: 'devices/electric_vehicles', body: buildEosElectricVehicles(cfg) },
        ]
      : [
          { section: 'devices/max_electric_vehicles', body: 0 },
          { section: 'devices/electric_vehicles', body: [] },
        ];

    const tasks = [
      { section: 'devices/batteries', body: batteries },
      { section: 'devices/inverters', body: inverters },
      ...evTasks,
      { section: 'optimization/interval', body: optimization.interval },
      { section: 'optimization/genetic/generations', body: geneticSizing.generations },
      { section: 'optimization/genetic/individuals', body: geneticSizing.individuals },
      { section: 'ems/interval', body: emsIntervalSec },
      // Phase 22.1 (2026-05-24): point EOS at the *Import providers so
      // eos-forecast-bridge can stream DVhub's native 15-min PV ensemble,
      // load model and EnergyCharts spot cache. VRM/EnergyCharts pulls on
      // EOS' side stop firing once these are set — single source of truth.
      { section: 'pvforecast/provider', body: 'PVForecastImport' },
      { section: 'load/provider', body: 'LoadImport' },
      { section: 'elecprice/provider', body: 'ElecPriceImport' },
    ];
    if (elecprice) {
      tasks.push(
        { section: 'elecprice/charges_kwh', body: elecprice.charges_kwh },
        { section: 'elecprice/vat_rate', body: elecprice.vat_rate },
      );
    }

    const applied = [];
    const errors = {};
    for (const t of tasks) {
      const res = await eosHttpRequest(baseUrl, 'PUT', `/v1/config/${t.section}`, t.body);
      if (res.ok) applied.push(t.section);
      else errors[t.section] = res.error;
    }

    const okAll = applied.length === tasks.length;
    if (pushLog) {
      pushLog('eos_config_sync', {
        ok: okAll,
        applied,
        errors,
        battery_capacity_wh: batteries[0]?.capacity_wh,
        battery_max_charge_w: batteries[0]?.max_charge_power_w,
        battery_min_soc_pct: batteries[0]?.min_soc_percentage,
        inverter_max_power_w: inverters[0]?.max_power_w,
      });
    }
    return { ok: okAll, applied, errors };
  }

  return { sync };
}
