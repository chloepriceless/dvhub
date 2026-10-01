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

import { resolveEvDeparture } from './ev-departure.js';
import { effectiveInverterCurve } from '../inverter-efficiency/calibrator.js';
import { resolveEvSocPct, resolveEvPlugged } from './ev-soc.js';
import { buildEosHomeAppliances } from './eos-devices.js';
import { loadSchedulableDevices } from '../devices/schedulable.js';
import http from 'node:http';

import { createEosCapabilityProbe } from './eos-capabilities.js';

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
    // EOS uses ONE power cap for both charge and discharge (battery.py applies
    // max_charge_power_w to discharge_energy too). The battery→grid export must
    // never exceed the operator's AC discharge limit (maxDischargeW, e.g. 16 kW),
    // because the inverter would otherwise over-pull the battery to hold a high
    // AC setpoint when PV drops intra-slot. So prefer maxDischargeW as the EOS
    // cap; charging is then modelled at the same (slightly lower) bound, which is
    // immaterial (PV rarely charges >16 kW and grid charge is disabled). Falls
    // back to maxChargeW, then a safe 5 kW default.
    max_charge_power_w: Number(opt.maxDischargeW) || Number(opt.maxChargeW) || 5000,
    // DVhub has no min_charge_power_w setting — leave EOS default (50 W is
    // a sane modulation floor for most hybrid inverters; configurable later).
    min_charge_power_w: 50,
    charge_rates: chargeRates,
    // Single-floor model (2026-06-16): EOS discharges down to DVhub's hard floor
    // (optimizer.hardFloorSocPct, = the live Victron BMS min). The caller passes
    // that floor via opts.minSocPct; fall back to the configured hard floor, then
    // a safe 5%. (The legacy soft optimizer.minSocPct knob was retired.)
    min_soc_percentage: Number.isFinite(Number(opts.minSocPct)) ? Number(opts.minSocPct) : (Number(opt.hardFloorSocPct) || 5),
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
export function buildEosElectricVehicles(cfg, { supportsDeadline = false, nowMs = Date.now() } = {}) {
  const opt = cfg?.optimizer || {};
  // Abfahrt + Ziel (ev-departure.js). Ist sie an, ersetzt ihr Ziel den
  // allgemeinen Ziel-SoC. Die Uhrzeit (min_soc_deadline_datetime, EOS 0.4)
  // geht nur mit supportsDeadline mit — der Abgleich setzt es immer.
  const departure = resolveEvDeparture(cfg, nowMs);
  const fallbackMinSoc = Number.isFinite(Number(opt.evMinSocPct)) ? Number(opt.evMinSocPct) : 70;
  const ev = {
    device_id: 'ev11',
    capacity_wh: Number(opt.evCapacityWh) || 50000,
    charging_efficiency: 0.88,
    discharging_efficiency: 0.88,
    max_charge_power_w: Number(opt.evMaxChargeW) || 5000,
    min_charge_power_w: 50,
    charge_rates: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    min_soc_percentage: departure.enabled && departure.targetSocPct !== null ? departure.targetSocPct : fallbackMinSoc,
    max_soc_percentage: 100,
  };
  // Immer mitsenden, wo EOS das Feld kennt — auch null: sonst bliebe eine
  // abgeschaltete oder vergangene Abfahrt in EOS stehen.
  if (supportsDeadline) ev.min_soc_deadline_datetime = departure.enabled ? departure.departureAt : null;
  return [ev];
}

/**
 * Build the EOS optimization section. interval=900 (15-min slots) gives DV
 * operators the EPEX day-ahead-2024 resolution; EOS 0.4 accepts it natively
 * (optimization.genetic.interval_sec ∈ {900, 3600}). Default stays 3600 for
 * safety; operators opt-in via optimizer.eosOptimizationIntervalSec.
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
 * genetic optimization. By default it is derived from (and slowed to suit) the
 * slot resolution: at 15-min slots a run is heavy, so the auto value is 3600s
 * (1 run/hour) to keep the loop from stomping on itself.
 *
 * Operator override (optimizer.eosEmsIntervalSec, 2026-06-08): DECOUPLE the EMS
 * tick from the slot resolution so 15-min slots can be re-planned more often
 * than hourly. A run measures ~6 min on prod, so 30-min ticks (1800s) are safe
 * and give slower hardware (e.g. a Raspberry-Pi EOS host) comfortable headroom.
 * Clamped to [300, 7200]; 0 / non-finite → fall back to the auto value.
 *
 * @param {number} intervalSec  the slot resolution from buildEosOptimization
 * @param {number} [overrideSec] explicit operator ems.interval (optimizer.eosEmsIntervalSec)
 * @returns {number}             ems.interval in seconds
 */
export function pickEmsIntervalSec(intervalSec, overrideSec) {
  const o = Number(overrideSec);
  if (Number.isFinite(o) && o > 0) return Math.min(7200, Math.max(300, Math.round(o)));
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
export function buildEosInverters(cfg, { curve = null } = {}) {
  const opt = cfg?.optimizer || {};
  const pvKwp = Number(opt?.mispel?.pvKwp);
  // max_power_w is the inverter's TOTAL AC throughput cap (PV + battery feed-in
  // together). Prefer the operator's real AC grid-connection limit
  // (inverterMaxPowerW, e.g. 29 kW); fall back to the PV nameplate (pvKwp×1000)
  // as a defensible upper bound, then 10 kW. Using the connection cap keeps the
  // battery→grid CO-EXPORT (inverter.py Case 1) from planning an unrealistically
  // high combined feed-in.
  const inverterMaxPowerW = Number(opt?.inverterMaxPowerW);
  const maxPowerW = Number.isFinite(inverterMaxPowerW) && inverterMaxPowerW > 0
    ? inverterMaxPowerW
    : (Number.isFinite(pvKwp) && pvKwp > 0 ? pvKwp * 1000 : 10000);
  // Grid→battery (AC) charging is §14a-illegal for vanilla self-consumption
  // operators, so HARD-DISABLE it unless grid-arbitrage is licensed
  // (allowGridCharge + MisPel pauschal/abgrenzung). max_ac_charge_power_w=0
  // makes EOS' simulate() set ac_charging_possible=False → ac_charge_hours are
  // zeroed, so the genetic can never pencil in a grid→battery transfer.
  // IMPORTANT: this only blocks the AC (grid) charge path. PV→battery charging
  // goes through the inverter's DC-surplus path (process_energy + dc_charge),
  // which is untouched — the battery still charges from PV, just never from the
  // grid. The charge_rates gate in buildEosBatteries alone was insufficient
  // ([1.0] still left a factor-1.0 AC-charge state in the genetic search).
  const gridChargeAllowed = isGridArbitrageLicensed(cfg);
  return [{
    device_id: INVERTER_DEVICE_ID,
    max_power_w: maxPowerW,
    battery_id: BATTERY_DEVICE_ID,
    // AC→DC (Laden) wird nicht gemessen — bleibt 1.0, die Ladeverluste stecken
    // in charging_efficiency des Akkus.
    ac_to_dc_efficiency: 1.0,
    // DC→AC: autonom kalibriert (services/inverter-efficiency). Ohne freigegebene
    // Kurve 1.0 wie bisher. Mit Kurve der energiegewichtete Mittelwert über alle
    // gemessenen Entladungen (Σ AC / Σ DC) — offizielles EOS kennt nur eine
    // Konstante; die Kurve selbst geht mit, sobald EOS sie annimmt.
    dc_to_ac_efficiency: curve ? curve.referenceEta : 1.0,
    max_ac_charge_power_w: gridChargeAllowed ? (Number(opt.maxChargeW) || null) : 0,
  }];
}

/**
 * Geräteliste -> Abbildung nach device_id, wie EOS ab #1330 sie erwartet
 * (`devices.batteries.battery1` statt `devices.batteries[0]`). Benennt dabei
 * das Verschleiß-Feld mit um: `levelized_cost_of_storage_kwh` heißt dort
 * `levelized_cost_of_storage_amt_kwh` — beides kam mit demselben Umbau, an
 * v0.4.0rc1 gemessen. Ohne die Umbenennung kommen die Speicherkosten nicht an
 * und EOS rechnet Zyklen als kostenlos.
 *
 * Geräte ohne `device_id` fallen weg: EOS braucht den Schlüssel, und ein
 * Gerät ohne ihn wäre in der Abbildung nicht adressierbar.
 *
 * @param {Array<object>} list
 * @returns {Object<string, object>}
 */
function devicesAsMap(list) {
  const out = {};
  for (const dev of Array.isArray(list) ? list : []) {
    if (!dev || !dev.device_id) continue;
    const entry = { ...dev };
    if (Object.prototype.hasOwnProperty.call(entry, 'levelized_cost_of_storage_kwh')) {
      entry.levelized_cost_of_storage_amt_kwh = entry.levelized_cost_of_storage_kwh;
      delete entry.levelized_cost_of_storage_kwh;
    }
    out[dev.device_id] = entry;
  }
  return out;
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

  // Erkennung, ob ein EOS 0.4 antwortet (eos-capabilities.js). Ergebnis wird
  // gemerkt (5 min) und in state.optimizer.eos veröffentlicht, sodass
  // /api/optimizer/status zeigt, welche Fassung antwortet. Ältere Fassungen
  // bekommen nichts mehr geschrieben.
  const capabilityProbe = ctx.eosCapabilityProbe
    || createEosCapabilityProbe({ request: (baseUrl, method, path, body) => eosHttpRequest(baseUrl, method, path, body) });

  // Zuletzt gesehenes `supported` (nur von erreichbaren Erkennungen), damit
  // `eos_unsupported_version` nur beim Wechsel ins Log geht, nicht bei jedem Lauf.
  let lastSupported = null;
  function publishCaps(caps) {
    if (state) {
      state.optimizer = state.optimizer || {};
      state.optimizer.eos = {
        flavor: caps.flavor, version: caps.version, reachable: caps.reachable,
        supported: caps.supported, reason: caps.reason, detectedAt: caps.detectedAt,
      };
    }
    if (!caps.reachable) return;
    if (caps.supported === false && lastSupported !== false && pushLog) {
      pushLog('eos_unsupported_version', { version: caps.version, flavor: caps.flavor });
    }
    lastSupported = caps.supported;
  }
  const unsupportedResult = (caps) => ({
    ok: false, applied: [], errors: {}, skipped: 'eos_unsupported', reason: caps.reason,
    eos: { flavor: caps.flavor, version: caps.version, supported: false },
  });

  // Aktiver Boost der Erstplan-Wache ({ boostSec, restoreSec }) oder null.
  // Die Wache lebt im Optimizer-Dienst und meldet sich ueber ctx an.
  const activeEmsBoost = () => {
    try { return ctx.getEosEmsIntervalBoost?.() || null; } catch { return null; }
  };

  // Fahrzeug bei EOS anmelden? Nur, wenn es mitoptimiert werden soll UND
  // DVhub einen frischen SoC hat. Sonst bricht 0.4 den ganzen Lauf ab ("Fresh
  // SoC missing for ev11", prod 2026-09-23) und auch der Hausakku bleibt ohne Plan.
  // Ergebnis steht in state.optimizer.eosEv (Panel + /api/optimizer/status).
  function decideEvRegistration(cfg) {
    const wanted = cfg?.optimizer?.eosOptimizeEv === true;
    const soc = wanted ? resolveEvSocPct(ctx) : null;
    // Nur angesteckt planen (Standard): ohne Auto an der Wallbox wuerde EOS
    // Energie fuers Auto einplanen und den Hausakku danach ausrichten (halten,
    // aufsparen) — fuer ein Auto, das gar nicht laden kann. Beim Anstecken
    // meldet die Steck-Wache (server.js) das Auto an und stoesst einen
    // Neuplan an.
    const onlyWhenPlugged = cfg?.optimizer?.evPlanOnlyWhenPlugged !== false;
    const plugged = wanted ? resolveEvPlugged(ctx) : null;
    let register = wanted;
    let reason = wanted ? null : 'eosOptimizeEv=false';
    if (wanted && onlyWhenPlugged && plugged !== true) {
      register = false;
      reason = plugged === false ? 'nicht angesteckt' : 'Steckzustand unbekannt (Wallbox/evcc nicht erreichbar)';
    } else if (wanted && !soc) {
      register = false;
      reason = 'kein Ladestand des Autos (TeslaMate/evcc) — EOS 0.4 wuerde sonst gar nicht rechnen';
    }
    const decision = { wanted, register, reason, onlyWhenPlugged, plugged, socPct: soc?.pct ?? null, socSource: soc?.source ?? null };
    if (state) {
      state.optimizer = state.optimizer || {};
      const prev = state.optimizer.eosEv;
      state.optimizer.eosEv = decision;
      if (pushLog && wanted && !register && (!prev || prev.register !== false)) pushLog(plugged === true || !onlyWhenPlugged ? 'eos_ev_no_soc' : 'eos_ev_not_plugged', { reason });
    }
    return decision;
  }

  async function sync() {
    const cfg = getCfg();
    const baseUrl = cfg?.optimizer?.eosProxy?.url || 'http://127.0.0.1:8503';

    // No-op when the operator has explicitly disabled the EOS bridge — avoids
    // log spam when EOS isn't running and the operator doesn't intend it to.
    // Review 2026-06-10 (B6): treat ABSENT eosProxy config as disabled too.
    // The old `=== false` check let installs without any eosProxy block
    // (undefined) run 10+ doomed HTTP calls against 127.0.0.1:8503 on every
    // config save — log flood at fleet scale. Explicit enabled:true required.
    if (!cfg?.optimizer?.eosProxy?.enabled) {
      return { ok: true, applied: [], errors: {}, skipped: 'eosProxy.enabled=false' };
    }

    // Fassung bestimmen, BEVOR irgendeine Aufgabe gebaut wird (siehe
    // eos-capabilities.js). Ein GET je Sync, nicht pro Aufgabe; das Ergebnis
    // wird 5 min gemerkt.
    const caps = await capabilityProbe.get(baseUrl);
    publishCaps(caps);
    // EOS antwortete beim Erkennen nicht (rechnet, Timeout) und es gibt keine
    // gemerkte Fassung: lieber diesen Lauf auslassen als blind schreiben.
    // Nächster Lauf holt es nach.
    if (!caps.reachable) {
      return { ok: false, applied: [], errors: { probe: 'eos_unreachable' }, skipped: 'eos_unreachable' };
    }
    // Kein EOS 0.4: gar nichts schreiben. Das alte Schema (Listen,
    // optimization.interval, charges_kwh …) pflegt DVhub nicht mehr.
    if (caps.supported === false) return unsupportedResult(caps);
    // EOS 0.4 führt Geräte als Abbildung nach device_id. Ein Listen-PUT
    // scheitert dort mit 400 ("Input should be a valid dictionary") — gemessen
    // am 20.09.2026 gegen v0.4.0rc1 — und EOS behält sein Bootstrap-Gerät.
    const asDevices = devicesAsMap;

    // Single-floor model (2026-06-16): EOS min_soc = DVhub's ONE discharge floor.
    // Source of truth = the live Victron BMS min (the absolute level DVhub itself
    // discharges to); fall back to the configured optimizer.hardFloorSocPct, then
    // 5%. The legacy soft optimizer.minSocPct (10%) was retired from the UI — it
    // never governed the EOS path. (Rationale, operator request 2026-05-29: with
    // a 10% floor EOS would hit 10% overnight and *import from grid* to hold it
    // instead of riding down to 5% and refilling via PV.) NOTE: this flat floor
    // does NOT reserve overnight load — see the planned overnight-reserve work
    // (battery→grid arbitrage can still drain the pack and force a dawn import).
    const liveVictronMin = Number(state?.victron?.minSocPct);
    const configHardFloor = Number(cfg?.optimizer?.hardFloorSocPct);
    const eosMinSocPct = Number.isFinite(liveVictronMin) ? liveVictronMin
      : (Number.isFinite(configHardFloor) ? configHardFloor : 5);

    const batteries = buildEosBatteries(cfg, { minSocPct: eosMinSocPct });
    const inverters = buildEosInverters(cfg, { curve: effectiveInverterCurve(cfg, ctx.inverterCurve?.get?.()) });
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
    // Phase 22 (2026-05-24): added the optimization interval (15-min slots).
    // Scalar settings hit field-level PUT endpoints (PUT /v1/config/{path}) one value
    // at a time — the section-level shape only works for {device,inverter}.
    const emsIntervalSec = pickEmsIntervalSec(optimization.interval, cfg?.optimizer?.eosEmsIntervalSec);
    // EV optimization is opt-in via cfg.optimizer.eosOptimizeEv (default OFF,
    // operator request 2026-05-29). When OFF, EOS gets max_electric_vehicles=0
    // (geneticparams → electric_vehicle_params=None) so it does NOT schedule EV
    // charging from the grid overnight — the operator charges the EV from PV
    // during the day, and that load is already captured by the LoadImport
    // forecast. When ON, EOS models the EV as a separately-optimised device.
    const evDecision = decideEvRegistration(cfg);
    const optimizeEv = evDecision.register;
    const evTasks = optimizeEv
      ? [
          { section: 'devices/max_electric_vehicles', body: 1 },
          { section: 'devices/electric_vehicles', body: asDevices(buildEosElectricVehicles(cfg, { supportsDeadline: true })) },
        ]
      : [
          { section: 'devices/max_electric_vehicles', body: 0 },
          { section: 'devices/electric_vehicles', body: {} },
        ];

    // Home appliances: DVhub does not model schedulable white goods, so EOS
    // must be told there are NONE. This is not cosmetic — EOS *fabricates* a
    // demo appliance when the setting is absent and then persists it:
    //   devices.py:331          max_home_appliances defaults to None
    //   geneticparams.py:576-578  None  -> logs "defaulting to 1"
    //   geneticparams.py:583-605  then invents "dishwasher1" (2000 Wh / 3 h,
    //                             windows 08:00 + 15:00) and writes it back
    // The result is a phantom ~2 kWh/day load that EOS strictly ADDS on top of
    // the LoadImport forecast (genetic.py:378-383) — it distorts the battery
    // and grid plan on every box where the key was never set.
    //
    // max_home_appliances=0 ist der tragende Wert (gegen ein echtes EOS am
    // 07.08.2026 verifiziert: prepare() ohne den Wert erfindet die
    // Demo-Spülmaschine, mit 0 bleibt es leer). Dazu wird die Abbildung mit
    // `{}` geleert, sonst bleibt ein früher gesendetes Gerät stehen (unten).
    // Planbare An/Aus-Verbraucher (Geschirrspüler & Co., 2026-09-26): als EOS
    // home_appliances mitplanen. Nur deferrable Geräte; modulierende Heizstäbe
    // regelt DVhub selbst (EOS' genetic kann nur EIN EV-artiges Gerät). Ohne
    // solche Geräte bleibt es beim tragenden max=0 (siehe Kommentar oben).
    // Reihenfolge im tasks-Array: max ZUERST, dann Liste (analog EV).
    let applianceIdMap = {};
    let homeApplianceTasks;
    {
      const sched = loadSchedulableDevices(cfg).devices.filter((d) => d.kind === 'deferrable' && d.enabled !== false);
      if (sched.length) {
        const built = buildEosHomeAppliances(sched, { timeZone: cfg?.timeZone || 'Europe/Berlin' });
        applianceIdMap = built.idMap;
        homeApplianceTasks = [
          { section: 'devices/max_home_appliances', body: built.appliances.length },
          { section: 'devices/home_appliances', body: asDevices(built.appliances) },
        ];
        if (state) { state.optimizer = state.optimizer || {}; state.optimizer.eosApplianceIdMap = applianceIdMap; }
      } else {
        // Die Abbildung MUSS mitgeleert werden: sonst bleibt ein früher
        // gesendetes Gerät stehen und 0.4 bricht mit "home_appliances exceeds
        // configured maximum 0" JEDEN Lauf ab (HANDOFF 2026-09-26, live auf
        // prod aufgetreten nach Löschen eines Testgeräts). Reihenfolge: max
        // zuerst, dann die leere Abbildung.
        homeApplianceTasks = [
          { section: 'devices/max_home_appliances', body: 0 },
          { section: 'devices/home_appliances', body: {} },
        ];
        if (state?.optimizer) state.optimizer.eosApplianceIdMap = {};
      }
    }

    // EOS 0.4 führt die Slot-Länge unter optimization.genetic.interval_sec und
    // lässt 15 Minuten nativ zu ({900, 3600}, 900 s an v0.4.0rc1 gemessen).
    // Zwei Engines stehen nebeneinander: GENETIC (neu) und GENETIC0 (die
    // alte). Wir wählen ausdrücklich die neue, statt den Vorgabewert
    // stillschweigend zu erben.

    // max_batteries / max_inverters MUESSEN gesetzt sein, und zwar VOR den
    // Geraeten selbst. Ohne sie gilt die Geraeteliste fuer EOS als nicht
    // konfiguriert: der Optimierer meldet "Number of battery devices not
    // configured - defaulting to 1", rechnet mit einem Standardakku, und --
    // schwerwiegender -- die daraus abgeleiteten Messschluessel entstehen
    // nicht. /v1/measurement/keys liefert dann nur "date_time", jeder
    // SoC-PUT scheitert mit 404 "Key 'battery1-soc-factor' not found in
    // measurements", der Optimierer rechnet mit SoC=0 und liefert gar keine
    // Loesung. DVhub faellt in dem Fall still auf den internen Plan zurueck.
    //
    // Auf prod am 2026-09-21 genau so aufgetreten: EOS lief seit dem 19.07.
    // durch, die Werte waren nur zur Laufzeit gesetzt (nie in EOS.config.json)
    // und gingen beim ersten Neustart verloren. Nach dem Nachziehen der beiden
    // Zeilen erschienen die Messschluessel sofort, der SoC-PUT kam durch, und
    // der naechste Lauf lieferte wieder eine vollstaendige Loesung.
    const deviceCountTasks = [
      { section: 'devices/max_batteries', body: batteries.length },
      { section: 'devices/max_inverters', body: inverters.length },
    ];

    const tasks = [
      ...deviceCountTasks,
      { section: 'devices/batteries', body: asDevices(batteries) },
      { section: 'devices/inverters', body: asDevices(inverters) },
      ...evTasks,
      ...homeApplianceTasks,
      { section: 'optimization/algorithm', body: 'GENETIC' },
      { section: 'optimization/genetic/interval_sec', body: optimization.interval },
      { section: 'optimization/genetic/generations', body: geneticSizing.generations },
      { section: 'optimization/genetic/individuals', body: geneticSizing.individuals },
      // Hat die Erstplan-Wache den Takt gerade hochgesetzt, bleibt ihr Wert
      // stehen — sonst setzt der Boot-Abgleich (alle 20 s) ihn sofort auf den
      // Soll-Takt zurueck, und der Boost wirkt nie (prod 2026-09-22).
      { section: 'ems/interval', body: activeEmsBoost()?.boostSec ?? emsIntervalSec },
      // Phase 22.1 (2026-05-24): point EOS at the *Import providers so
      // eos-forecast-bridge can stream DVhub's native 15-min PV ensemble,
      // load model and EnergyCharts spot cache. VRM/EnergyCharts pulls on
      // EOS' side stop firing once these are set — single source of truth.
      { section: 'pvforecast/provider', body: 'PVForecastImport' },
      { section: 'load/provider', body: 'LoadImport' },
      { section: 'elecprice/provider', body: 'ElecPriceImport' },
    ];
    // In spot feed-in mode, point feedintariff at FeedInTariffImport so EOS
    // values grid export at the spot price the bridge pushes (operator request
    // 2026-05-29) — enables evening battery Vermarktung at peak prices instead
    // of the flat EEG tariff. EOS-side planning only; the real plant is
    // unaffected (primarySource=internal).
    const directMarketing = String(cfg?.optimizer?.tariff?.feedInMode || 'fixed').toLowerCase() === 'spot';
    if (directMarketing) {
      tasks.push({ section: 'feedintariff/provider', body: 'FeedInTariffImport' });
    }

    // Direktvermarktungs-Generalschalter (Christin 2026-08-07).
    //
    // EOS legt drei Verhaltensweisen hinter EINEN Konfigschalter — `genetic.py:2670-2677`:
    //     direct_marketing_enabled = self._direct_marketing_enabled()
    //     self.optimize_dc_charge           = direct_marketing_enabled
    //     self.optimize_battery_grid_export = direct_marketing_enabled
    // und derselbe Schalter gated die harte PV-Abregelung bei Negativpreis
    // (`genetic.py:504`). Default ist FALSE (`prediction/feedintariff.py:75`).
    //
    // Ohne diese Zeile blieben still DREI Dinge
    // abgeschaltet — darunter die Negativpreis-Abregelung, und die ist §51-Pflicht,
    // keine Optimierung. Genau der Fail-open-Fehlertyp aus T-0325.
    //
    // Pflicht-Task: ein Fehlschlag ist ein echter Fehler und kippt okAll.
    //
    // Keine elecprice.charges_kwh / vat_rate: die Schlüssel sind ab #1330
    // gelöscht (der PUT quittiert mit 400), und das elecfee-Framework braucht
    // DVhub nicht — die Bridge schickt über ElecPriceImport bereits den
    // aufgelösten Endkundenpreis (`elecpriceimport.py` ruft
    // `_store_gross_series` nicht), sonst würde doppelt gerechnet.
    tasks.push({ section: 'feedintariff/direct_marketing_enabled', body: directMarketing });

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
        eos_flavor: caps.flavor,
        eos_version: caps.version,
        applied,
        errors,
        battery_capacity_wh: batteries[0]?.capacity_wh,
        battery_max_charge_w: batteries[0]?.max_charge_power_w,
        battery_min_soc_pct: batteries[0]?.min_soc_percentage,
        inverter_max_power_w: inverters[0]?.max_power_w,
      });
    }
    return { ok: okAll, applied, errors, eos: { flavor: caps.flavor, version: caps.version, supported: true } };
  }

  /**
   * Persist EOS' current (DVhub-synced) configuration to its config file so the
   * *Import providers + 15-min interval SURVIVE an EOS restart.
   *
   * EOS only holds API-set config in memory; an EOS restart drops everything
   * sync() pushed back to the EOS.config.json defaults (providers disabled,
   * ems.interval 300) and EOS then plans on its own VRM/spot pulls until
   * DVhub's next reconcile tick re-asserts it — a multi-minute dead window that
   * hits fresh installs hardest (operator just set it up, restarts EOS, watches
   * it produce garbage). PUT /v1/config/file (server/eos.py:468) snapshots the
   * live config to disk; the next EOS boot then loads the right providers
   * immediately. Idempotent, never throws. Call AFTER a successful sync().
   *
   * @returns {Promise<{ok: boolean, error?: string, skipped?: string}>}
   */
  async function persist() {
    const cfg = getCfg();
    const baseUrl = cfg?.optimizer?.eosProxy?.url || 'http://127.0.0.1:8503';
    if (!cfg?.optimizer?.eosProxy?.enabled) {
      return { ok: true, skipped: 'eosProxy.enabled=false' };
    }
    // PUT /v1/config/file schreibt den LAUFENDEN Stand auf die Platte. Ein
    // gerade aktiver Boost der Erstplan-Wache darf dort nicht landen, sonst
    // rechnet EOS nach dem naechsten Neustart dauerhaft im Minutentakt.
    const boost = activeEmsBoost();
    if (boost && Number.isFinite(boost.restoreSec)) {
      await eosHttpRequest(baseUrl, 'PUT', '/v1/config/ems/interval', boost.restoreSec);
    }
    const res = await eosHttpRequest(baseUrl, 'PUT', '/v1/config/file');
    if (boost && Number.isFinite(boost.restoreSec)) {
      await eosHttpRequest(baseUrl, 'PUT', '/v1/config/ems/interval', boost.boostSec);
    }
    if (pushLog) pushLog('eos_config_persist', { ok: res.ok, error: res.error });
    return { ok: res.ok, error: res.error };
  }

  /**
   * Nur das Fahrzeug an EOS schicken (Ziel + Abfahrt). Fuer die Minuten-Wache
   * in server.js: eine Abfahrt muss VOR ihrem Zeitpunkt weitergeschoben sein —
   * der volle Abgleich laeuft nur alle 15 min, und ein vergangener Termin
   * heisst fuer EOS "sofort laden".
   */
  async function syncEv() {
    const cfg = getCfg();
    const baseUrl = cfg?.optimizer?.eosProxy?.url || 'http://127.0.0.1:8503';
    if (!cfg?.optimizer?.eosProxy?.enabled) return { ok: true, skipped: 'eosProxy.enabled=false' };
    if (cfg?.optimizer?.eosOptimizeEv !== true) return { ok: true, skipped: 'eosOptimizeEv=false' };
    const caps = await capabilityProbe.get(baseUrl);
    // Fassung unbekannt (EOS antwortet nicht): nichts schreiben. Der nächste
    // Lauf holt es nach.
    if (!caps.reachable) return { ok: false, skipped: 'eos_unreachable' };
    // Kein EOS 0.4: nichts schreiben (siehe sync()).
    if (caps.supported === false) {
      publishCaps(caps);
      return { ok: false, skipped: 'eos_unsupported', reason: caps.reason };
    }
    // Kein SoC: Fahrzeug nicht anfassen — der volle Abgleich hat es bereits
    // abgemeldet, und ein Anmelden hier legte EOS lahm.
    if (!decideEvRegistration(cfg).register) return { ok: true, skipped: 'no ev soc' };
    const list = buildEosElectricVehicles(cfg, { supportsDeadline: true });
    const body = devicesAsMap(list);
    const res = await eosHttpRequest(baseUrl, 'PUT', '/v1/config/devices/electric_vehicles', body);
    if (pushLog) {
      pushLog('eos_ev_sync', {
        ok: res.ok, error: res.error,
        minSocPct: list[0].min_soc_percentage,
        deadline: list[0].min_soc_deadline_datetime ?? null,
        deadlineSupported: true,
      });
    }
    return { ok: res.ok, error: res.error, ev: list[0] };
  }

  return { sync, persist, syncEv };
}
