import { toFiniteNumber } from './util.js';
import { computeAvailableEnergyKwh, sumForecastSlotsKwh } from './small-market-automation.js';

// Stage-2 (predictive pre-empty) pure planning core.
//
// This module is the ~10% genuinely-new logic of Phase 10: the confidence-gated
// target-SOC sizing, the dual-limit export-power clamp, and the LEEREN/HALTEN/
// FREIGEBEN phase machine. It is a PURE module — no `state`, no `ctx`, no
// `process`, no I/O — fully unit-testable, mirroring `small-market-automation.js`.
//
// Every exported function builds a guard/fallback object up front, returns a
// plain object with a `reason` string on EVERY branch, and coerces every numeric
// input via `toFiniteNumber` (the upstream EPEX/forecast rows are untrusted —
// they originate from external APIs).
//
// Plan 10-04 (the builder integration) imports these functions; it never reaches
// into the byte-frozen Stage-1 reserve computation — D-01.

export const STAGE2_SLOT_MS = 15 * 60 * 1000;

/**
 * D-04 / D-07 — Detect the qualifying midday/curtailment window from the EPEX
 * price curve. A slot qualifies if its `ct_kwh` is negative OR below the PV
 * generation cost. The window is the contiguous run of qualifying slots that
 * contains the cheapest qualifying slot.
 *
 * @param {Array<{ts:number, ct_kwh:number}>} epexSlots — raw EPEX rows.
 * @param {number|null} pvGenerationCostCtKwh — PV LCOE in ct/kWh; null/NaN ->
 *        only the `ct_kwh < 0` criterion applies.
 * @param {{startTs:number, endTs:number}} dayBounds — half-open day window.
 * @returns {{startTs:number, endTs:number, reason:string}|null}
 *          `null` (D-04: Stage 2 idle) when no slot qualifies.
 */
export function detectQualifyingWindow(epexSlots, pvGenerationCostCtKwh, dayBounds) {
  const startBound = toFiniteNumber(dayBounds?.startTs, null);
  const endBound = toFiniteNumber(dayBounds?.endTs, null);
  if (!Array.isArray(epexSlots) || startBound == null || endBound == null || endBound <= startBound) {
    return null;
  }

  const pvCost = toFiniteNumber(pvGenerationCostCtKwh, null);

  // Filter to the day's half-open window, coerce ts/ct_kwh, sort ascending by ts.
  const inDay = epexSlots
    .map((s) => ({ ts: toFiniteNumber(s?.ts, null), ctKwh: toFiniteNumber(s?.ct_kwh, null) }))
    .filter((s) => s.ts != null && s.ctKwh != null && s.ts >= startBound && s.ts < endBound)
    .sort((a, b) => a.ts - b.ts);

  if (!inDay.length) return null;

  const qualifies = (ctKwh) => ctKwh < 0 || (pvCost != null && ctKwh < pvCost);

  // Build the contiguous (one-slot-step) runs of qualifying slots, then return
  // the run that contains the single cheapest qualifying slot.
  const runs = [];
  let current = null;
  for (const slot of inDay) {
    if (!qualifies(slot.ctKwh)) {
      current = null;
      continue;
    }
    if (current && slot.ts - current[current.length - 1].ts === STAGE2_SLOT_MS) {
      current.push(slot);
    } else {
      current = [slot];
      runs.push(current);
    }
  }

  if (!runs.length) return null;

  // Pick the run holding the cheapest qualifying slot (D-07: a disjoint cheap
  // run is the window even if another qualifying run sits earlier).
  let bestRun = runs[0];
  let bestPrice = Math.min(...bestRun.map((s) => s.ctKwh));
  for (const run of runs.slice(1)) {
    const runMin = Math.min(...run.map((s) => s.ctKwh));
    if (runMin < bestPrice) {
      bestPrice = runMin;
      bestRun = run;
    }
  }

  return {
    startTs: bestRun[0].ts,
    endTs: bestRun[bestRun.length - 1].ts + STAGE2_SLOT_MS,
    reason: 'window_detected'
  };
}

/**
 * D-08 — Estimate the PV energy (kWh) the qualifying window will produce, with
 * the average forecast confidence over the overlapping slots.
 *
 * The kWh summation is delegated to `sumForecastSlotsKwh` (Don't-Hand-Roll —
 * Pitfall 7: it already handles partial-slot overlap + mixed resolution). The
 * confidence average is computed here at full precision over the overlapping
 * slots, because the gate in `computePreEmptyTargetSoc` needs the un-rounded
 * value.
 *
 * @param {{pvSlots:Array<{start:string,end:string,powerW:number,confidence:number}>,
 *          window:{startTs:number,endTs:number}}} args
 * @returns {{totalKwh:number, avgConfidence:number, slotsCounted:number, reason:string}}
 */
export function estimateWindowPvKwh({ pvSlots, window } = {}) {
  const fromTs = toFiniteNumber(window?.startTs, null);
  const toTs = toFiniteNumber(window?.endTs, null);
  const slots = Array.isArray(pvSlots) ? pvSlots : [];

  if (fromTs == null || toTs == null || toTs <= fromTs) {
    return { totalKwh: 0, avgConfidence: 0, slotsCounted: 0, reason: 'no_forecast_data' };
  }

  // Don't-Hand-Roll: delegate the kWh summation + partial-slot overlap math.
  const summed = sumForecastSlotsKwh({
    slots,
    fromTs,
    toTs,
    defaultDurationMin: 15
  });

  // Full-precision confidence average over the slots that overlap the window
  // (sumForecastSlotsKwh rounds avgConfidence to 2dp; the confidence gate needs
  // the un-rounded value so the real ~0.27 prod band interpolates correctly).
  let confSum = 0;
  let confCount = 0;
  for (const s of slots) {
    const startMs = s?.start ? Date.parse(s.start) : NaN;
    if (!Number.isFinite(startMs)) continue;
    const endMs = s?.end ? Date.parse(s.end) : startMs + 15 * 60000;
    const slotEndMs = Number.isFinite(endMs) ? endMs : startMs + 15 * 60000;
    const overlapStart = Math.max(startMs, fromTs);
    const overlapEnd = Math.min(slotEndMs, toTs);
    if (overlapEnd <= overlapStart) continue;
    confSum += toFiniteNumber(s.confidence, 0);
    confCount += 1;
  }
  const avgConfidence = confCount ? confSum / confCount : 0;

  return {
    totalKwh: summed.totalKwh,
    avgConfidence,
    slotsCounted: summed.slotsCounted,
    reason: summed.slotsCounted === 0 ? 'no_forecast_data' : 'window_pv_estimated'
  };
}

/**
 * D-08 / D-09 / D-10 — Size a forecast-confidence-gated pre-empty target SOC.
 *
 * The pre-empty depth is gated by forecast confidence: below `confidenceFactorLow`
 * the depth factor is 0 (Stage 2 stays put — D-09 confidence gate); between
 * `confidenceFactorLow` and `confidenceFactorHigh` it interpolates linearly to 1.
 * The endpoints are calibrated to the WAVE-0-confirmed real prod confidence band
 * (PV ~0.25 / load ~0.30) — NOT the Phase-02 optimizer's 0.5/0.7 band. At the
 * real ~0.27 prod confidence the depth factor lands strictly in (0, 1).
 *
 * The "forecast-justified depth" is the SOC headroom the window PV can re-store.
 * `windowPvKwh` is AC energy; it is converted to an SOC delta using the same
 * capacity + inverter-efficiency relationship `computeAvailableEnergyKwh` uses
 * (the inverse of that function — Don't-Hand-Roll the kWh<->SOC math).
 *
 * The result is clamped so `targetSocPct >= hardFloorSocPct` — D-10: the global
 * hard floor is the absolute lower bound, never crossed.
 *
 * @returns {{targetSocPct:number, depthFactor:number, forecastJustifiedDeltaPct:number,
 *            windowPvKwh:number, confidence:number, reason:string}}
 */
export function computePreEmptyTargetSoc({
  windowPvKwh,
  confidence,
  batteryCapacityKwh,
  currentSocPct,
  hardFloorSocPct,
  inverterEfficiencyPct = 85,
  confidenceFactorLow = 0.24,
  confidenceFactorHigh = 0.30
} = {}) {
  const currentSoc = toFiniteNumber(currentSocPct, 0);
  const hardFloor = toFiniteNumber(hardFloorSocPct, 5);
  const conf = toFiniteNumber(confidence, 0);
  const pvKwh = Math.max(0, toFiniteNumber(windowPvKwh, 0));
  const capacity = toFiniteNumber(batteryCapacityKwh, 0);
  const lowEndpoint = toFiniteNumber(confidenceFactorLow, 0.24);
  const highEndpoint = toFiniteNumber(confidenceFactorHigh, 0.30);

  // Guard/fallback object up front — the confidence gate returns this verbatim.
  const fallback = {
    targetSocPct: currentSoc,
    depthFactor: 0,
    forecastJustifiedDeltaPct: 0,
    windowPvKwh: pvKwh,
    confidence: conf,
    reason: 'low_confidence'
  };

  // D-09 confidence gate: below the low endpoint Stage 2 does not deepen.
  if (conf < lowEndpoint) return fallback;

  // No usable battery capacity or no forecast PV -> nothing to size against.
  if (capacity <= 0 || pvKwh <= 0) {
    return { ...fallback, reason: 'no_forecast_data' };
  }

  // Linear interpolation of confidence between the WAVE-0 endpoints, clamped [0,1].
  const span = highEndpoint - lowEndpoint;
  const depthFactor = span > 0
    ? Math.max(0, Math.min(1, (conf - lowEndpoint) / span))
    : 1;

  // kWh -> SOC% conversion: the inverse of computeAvailableEnergyKwh. That
  // function maps a (currentSoc - minSoc) delta of D percentage points to
  //   acEnergy = capacity * (1 - safety/100) * (D/100) * (efficiency/100)
  // Probe it with a reference 100-point delta (safetyMarginPct: 0 — the hard
  // floor is the only floor that applies to Stage 2) to obtain kWh-per-point,
  // then invert. Don't-Hand-Roll: the efficiency/usable-capacity handling is
  // owned by computeAvailableEnergyKwh.
  const acKwhPer100Pct = computeAvailableEnergyKwh({
    batteryCapacityKwh: capacity,
    currentSocPct: 100,
    minSocPct: 0,
    inverterEfficiencyPct,
    safetyMarginPct: 0
  });
  const acKwhPerPct = (toFiniteNumber(acKwhPer100Pct, 0)) / 100;

  // SOC headroom (% points) the window PV can re-store.
  const forecastJustifiedDeltaPct = acKwhPerPct > 0 ? pvKwh / acKwhPerPct : 0;

  // Pre-empty target: deepen by the confidence-scaled forecast-justified delta,
  // then clamp to the hard floor (D-10 — the absolute lower bound).
  const rawTarget = currentSoc - depthFactor * forecastJustifiedDeltaPct;
  const targetSocPct = Math.round(Math.max(hardFloor, rawTarget) * 10) / 10;

  return {
    targetSocPct,
    depthFactor: Math.round(depthFactor * 1e6) / 1e6,
    forecastJustifiedDeltaPct: Math.round(forecastJustifiedDeltaPct * 100) / 100,
    windowPvKwh: pvKwh,
    confidence: conf,
    reason: 'forecast_sized'
  };
}

/**
 * D-12 / D-17 — the Stage-2 export-setpoint clamp with a DYNAMIC akku headroom.
 *
 * A pre-empty slot wants to export aggressively. PV is exported at its full
 * forecast value — it is never throttled. The battery's contribution is shaped
 * by TWO limits:
 *   - the AC-side grid-export ceiling (`maxDischargeW`, negative W) — D-12, and
 *   - the DC-side battery discharge, governed by a soft/hard limit pair — D-17.
 *
 * Dynamic headroom (D-17): the battery discharges FREELY up to `akkuSoftLimitW`
 * (default 18 kW). Above the soft limit each extra watt of demand is admitted
 * at an exponentially decaying marginal rate — 1.0 at the soft limit, ->0
 * toward the hard limit — so the discharge asymptotically approaches but never
 * exceeds `akkuHardLimitW` (default 20 kW). There is NO fixed PV de-rating:
 * when the battery is far from its limit it is used at full tilt; the taper
 * only bites near the limit. The D-18 live clamp in schedule-eval.js is the
 * runtime backstop against a real PV dip.
 *
 * `gridSetpointW` is always <= 0 (export-only — never an illegal grid charge)
 * and `impliedBatteryDischargeW` is always <= `akkuHardLimitW`.
 *
 * Physical identity: batteryDischarge = |gridExport| + houseLoad - PV.
 *
 * @returns {{gridSetpointW:number, impliedBatteryDischargeW:number,
 *            batteryShareW:number, mode:string, reason:string}}
 */
export function preEmptySlotSetpointW({
  pvForecastW,
  expectedHouseLoadW,
  maxDischargeW = -12000,
  akkuHardLimitW = 20000,
  akkuSoftLimitW = 18000
} = {}) {
  const pvW = Math.max(0, toFiniteNumber(pvForecastW, 0));
  const houseLoadW = Math.max(0, toFiniteNumber(expectedHouseLoadW, 0));
  const acAbsCap = Math.abs(toFiniteNumber(maxDischargeW, -12000));
  const hardW = Math.max(0, toFiniteNumber(akkuHardLimitW, 20000));
  // The soft limit can never sit above the hard limit.
  const softW = Math.min(hardW, Math.max(0, toFiniteNumber(akkuSoftLimitW, 18000)));

  // D-12: AC side — the battery export share the grid-export ceiling permits
  // ON TOP OF the PV already flowing to grid. PV itself is never throttled.
  const acBatteryExportShareW = Math.max(0, acAbsCap - pvW);
  // The battery also serves the house load, so its raw TOTAL discharge demand:
  const rawBatteryDischargeW = acBatteryExportShareW + houseLoadW;

  // D-17 DYNAMIC HEADROOM: free below the soft limit; above it the excess is
  // admitted with an exponentially decaying marginal rate, so the discharge
  // asymptotically approaches but never reaches `akkuHardLimitW`.
  let allowedBatteryDischargeW;
  let tapered;
  if (rawBatteryDischargeW <= softW || hardW <= softW) {
    // Below the soft knee, or a degenerate soft>=hard config -> a plain cap.
    allowedBatteryDischargeW = Math.min(rawBatteryDischargeW, hardW);
    tapered = rawBatteryDischargeW > softW;
  } else {
    const band = hardW - softW;
    const excessW = rawBatteryDischargeW - softW;
    allowedBatteryDischargeW = hardW - band * Math.exp(-excessW / band);
    tapered = true;
  }
  // D-17 invariant — pin the discharge strictly within [0, akkuHardLimitW].
  allowedBatteryDischargeW = Math.min(Math.max(0, allowedBatteryDischargeW), hardW);

  // The battery covers the house load first; the rest is its grid-export share.
  const batteryShareW = Math.max(0, allowedBatteryDischargeW - houseLoadW);
  // Total grid export = full PV forecast + the clamped battery export share.
  // Both terms are >= 0, so gridSetpointW is always <= 0 (export-only).
  const gridSetpointW = -Math.round(pvW + batteryShareW);
  const impliedBatteryDischargeW = batteryShareW + houseLoadW;

  return {
    gridSetpointW,
    impliedBatteryDischargeW,
    batteryShareW,
    mode: tapered ? 'dcDischarge' : 'aggressiveExport',
    reason: tapered ? 'akku_soft_limit_taper' : 'aggressive_export'
  };
}

/**
 * D-13 — Resolve the Stage-2 phase from the clock and the plan inputs.
 *
 * LEEREN  — still pre-emptying (before the hold deadline).
 * HALTEN  — target SOC reached, holding it until the window opens.
 * FREIGEBEN — the qualifying window is open; release the battery to absorb PV.
 * IDLE    — no plan (missing/NaN timestamps), or HALTEN aborted because the
 *           forecast significantly degraded (D-13 abort: stop holding, let the
 *           battery charge normally).
 *
 * @returns {{phase:string, reason:string}}
 */
export function resolveStage2Phase({
  nowTs,
  windowStartTs,
  holdStartTs,
  targetReached,
  forecastDegraded
} = {}) {
  const now = toFiniteNumber(nowTs, null);
  const windowStart = toFiniteNumber(windowStartTs, null);
  const holdStart = toFiniteNumber(holdStartTs, null);

  if (now == null || windowStart == null || holdStart == null) {
    return { phase: 'IDLE', reason: 'no_plan' };
  }

  // The qualifying window is open -> release the battery to absorb the PV.
  if (now >= windowStart) {
    return { phase: 'FREIGEBEN', reason: 'window_open' };
  }

  // Between the hold deadline and the window: holding the reached target SOC.
  if (now >= holdStart && targetReached) {
    if (forecastDegraded) {
      // D-13 abort: a significantly degraded forecast voids the hold —
      // stop holding, let the battery charge normally.
      return { phase: 'IDLE', reason: 'halten_aborted_forecast_drop' };
    }
    return { phase: 'HALTEN', reason: 'holding_target' };
  }

  // Still before the hold deadline -> actively pre-emptying.
  return { phase: 'LEEREN', reason: 'pre_emptying' };
}
