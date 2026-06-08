// services/power-limits.js — T-0126: single source of truth for the appliance's
// PHYSICAL hardware power limits.
//
// Today the same physical quantity is duplicated across optimizer.*, SMA
// (schedule.smallMarketAutomation.*), dcExportMode.* and the Victron control
// path — with DIFFERENT units (Wh vs kWh, W vs A) and DIFFERENT signs (optimizer
// maxDischargeW positive, SMA maxDischargeW negative). That caused the
// AC-vs-DC / 14-vs-16 kW confusion (T-0126 Codex-refute).
//
// This resolver is the ONE place every module will read from. It is NON-BREAKING:
// no consumer is wired yet. Each module migrates to getPowerLimits() one at a
// time, with a golden test proving resolved == the module's legacy value on a
// real config. Migration order (live write paths LAST): resolver → display
// readers → EOS sync → SMA/MILP → live control → legacy UI read-only.
//
// CONVENTIONS (Codex-refute hard rules):
//  - Power caps are stored/returned as POSITIVE MAGNITUDES (Watt). The sign is
//    applied at the write site (grid-setpoint export = -magnitude).
//  - Distinct physical layers are NOT collapsed: DC battery, AC ESS, inverter AC,
//    grid connection, and charge CURRENT (Amps) are separate fields.
//  - Efficiencies stay separate: roundTrip (EOS, fraction sqrt-split) vs inverter
//    (SMA, AC conversion). Never merged.
//  - Each field reports its source: 'canonical' | 'legacy' | 'default'.

// Documented safe defaults. On a CONFIGURED system every field is set, so these
// only apply to an unconfigured/fresh box (not in productive use). Where legacy
// per-module defaults diverged (e.g. capacity 8000/10000/30000), the canonical
// default is the most representative; golden tests cover the configured case.
export const POWER_LIMIT_DEFAULTS = Object.freeze({
  batteryNominalVoltageV: 55.2,        // 16S LFP
  batteryCapacityWh: 10000,
  batteryMaxDischargeDcW: 20000,       // DC battery discharge cap
  batteryMaxChargeW: 5000,             // DC/charge power cap (W)
  batteryMaxChargeCurrentA: 350,       // DC charge current cap (Victron write path)
  essMaxDischargeAcW: 0,               // 0 = unset (manual reg2704 / operator owned)
  inverterMaxPowerW: 10000,            // total inverter AC throughput
  gridConnectionExportLimitW: 0,       // 0 = no grid feed-in cap
  roundTripEfficiencyPct: 88,          // matches EOS sqrt-split safe default (~0.94/dir)
  inverterEfficiencyPct: 85,           // SMA AC conversion
  hardFloorSocPct: 5,
  maxSocPct: 100,
});

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// Positive magnitude (normalizes SMA's negative maxDischargeW etc.).
function mag(v) {
  const n = finite(v);
  return n == null ? null : Math.abs(n);
}

// Resolve one field: canonical (system.power.<key>) first, then the ordered list
// of legacy candidates, then the default. Each candidate is {get, norm?}; the
// first that yields a non-null value wins. Returns { value, source }.
function resolveField(canonicalVal, legacyCandidates, dflt, normalize = finite) {
  const c = normalize(canonicalVal);
  if (c != null) return { value: c, source: 'canonical' };
  for (const cand of legacyCandidates) {
    const v = (cand.norm || normalize)(cand.value);
    if (v != null) return { value: v, source: 'legacy' };
  }
  return { value: dflt, source: 'default' };
}

/**
 * Resolve the canonical hardware power limits from a DVhub config.
 * @param {object} cfg - the full config object (cfg.system?.power is canonical)
 * @returns {{ limits: object, sources: object }}
 *   limits: normalized values (W / Wh / A / V / %, positive magnitudes)
 *   sources: per-field 'canonical' | 'legacy' | 'default'
 */
export function getPowerLimits(cfg = {}) {
  const sp = cfg?.system?.power || {};
  const opt = cfg?.optimizer || {};
  const sma = cfg?.schedule?.smallMarketAutomation || {};
  const pp = sma?.predictivePreEmpty || {};
  const schedCfg = cfg?.schedule || {};

  const D = POWER_LIMIT_DEFAULTS;
  const limits = {};
  const sources = {};
  const put = (key, res) => { limits[key] = res.value; sources[key] = res.source; };

  // Nominal voltage — needed for any A<->W conversion. Legacy: SMA pre-empty.
  put('batteryNominalVoltageV', resolveField(
    sp.batteryNominalVoltageV,
    [{ value: pp.batteryVoltageV }],
    D.batteryNominalVoltageV,
  ));

  // Capacity (Wh). Legacy: optimizer.batteryCapacityWh, then SMA kWh*1000.
  put('batteryCapacityWh', resolveField(
    sp.batteryCapacityWh,
    [
      { value: opt.batteryCapacityWh },
      { value: sma.batteryCapacityKwh, norm: (v) => { const n = finite(v); return n == null ? null : n * 1000; } },
    ],
    D.batteryCapacityWh,
  ));

  // DC battery discharge cap (W). Legacy: optimizer.maxDischargeW (positive),
  // then SMA maxDischargeW (stored NEGATIVE → magnitude).
  put('batteryMaxDischargeDcW', resolveField(
    sp.batteryMaxDischargeDcW,
    [{ value: opt.maxDischargeW, norm: mag }, { value: sma.maxDischargeW, norm: mag }],
    D.batteryMaxDischargeDcW,
    mag,
  ));

  // Charge power cap (W). Legacy: optimizer.maxChargeW.
  put('batteryMaxChargeW', resolveField(
    sp.batteryMaxChargeW,
    [{ value: opt.maxChargeW, norm: mag }],
    D.batteryMaxChargeW,
    mag,
  ));

  // Charge CURRENT cap (A) — canonical for the Victron charge-current write path.
  // Legacy: SMA maxChargeCurrentA, then schedule.defaultChargeCurrentA.
  put('batteryMaxChargeCurrentA', resolveField(
    sp.batteryMaxChargeCurrentA,
    [{ value: pp.maxChargeCurrentA, norm: mag }, { value: schedCfg.defaultChargeCurrentA, norm: mag }],
    D.batteryMaxChargeCurrentA,
    mag,
  ));

  // ESS AC discharge cap (W) — Victron reg2704 path. No config key today (manual).
  put('essMaxDischargeAcW', resolveField(
    sp.essMaxDischargeAcW,
    [],
    D.essMaxDischargeAcW,
    mag,
  ));

  // Inverter total AC cap (W). Legacy: optimizer.inverterMaxPowerW.
  put('inverterMaxPowerW', resolveField(
    sp.inverterMaxPowerW,
    [{ value: opt.inverterMaxPowerW, norm: mag }],
    D.inverterMaxPowerW,
    mag,
  ));

  // Grid feed-in cap (W) — NEW. Legacy: optimizer.gridExportLimitW (if present).
  put('gridConnectionExportLimitW', resolveField(
    sp.gridConnectionExportLimitW,
    [{ value: opt.gridExportLimitW, norm: mag }],
    D.gridConnectionExportLimitW,
    mag,
  ));

  // Round-trip efficiency in PERCENT (UI/canonical). EOS legacy stores a fraction
  // (0,1] → ×100. Consumers needing the fraction divide by 100.
  put('roundTripEfficiencyPct', resolveField(
    sp.roundTripEfficiencyPct,
    [{
      value: opt.roundTripEfficiency,
      norm: (v) => { const n = finite(v); return (n != null && n > 0 && n <= 1) ? n * 100 : null; },
    }],
    D.roundTripEfficiencyPct,
  ));

  // Inverter (AC conversion) efficiency in PERCENT — SMA. Kept SEPARATE.
  put('inverterEfficiencyPct', resolveField(
    sp.inverterEfficiencyPct,
    [{ value: sma.inverterEfficiencyPct }],
    D.inverterEfficiencyPct,
  ));

  // Hard SoC safety floor (%). Legacy: optimizer.hardFloorSocPct. (Live Victron
  // BMS readback handled per-consumer; this is the configured floor.)
  put('hardFloorSocPct', resolveField(
    sp.hardFloorSocPct,
    [{ value: opt.hardFloorSocPct }],
    D.hardFloorSocPct,
  ));

  // Max SoC (%).
  put('maxSocPct', resolveField(
    sp.maxSocPct,
    [{ value: opt.maxSocPct }],
    D.maxSocPct,
  ));

  // Convenience derivations (NOT canonical — for consumers wanting other units).
  limits.batteryCapacityKwh = Math.round((limits.batteryCapacityWh / 1000) * 1000) / 1000;
  limits.roundTripEfficiencyFraction = Math.round((limits.roundTripEfficiencyPct / 100) * 1e6) / 1e6;
  // Charge power implied by the current cap (informational; NOT forced equal to
  // batteryMaxChargeW, which may be a deliberately lower W cap).
  limits.batteryMaxChargeCurrentImpliedW = Math.round(limits.batteryMaxChargeCurrentA * limits.batteryNominalVoltageV);

  return { limits, sources };
}
