import { toFiniteNumber } from './util.js';

/**
 * DVhub fork (2026-06-01) — live PV + battery CO-EXPORT setpoint (EOS Option B).
 *
 * Runtime regulator behind the EOS→Zeitplan translation. Re-evaluated every
 * control tick against the *live* PV reading, so PV fluctuation is tracked
 * continuously and the battery export share rides ON TOP of whatever PV is doing
 * right now (the operator's "nachregeln"). Driven by the dcExportMode runtime
 * block when a schedule rule carries `batteryExportW` (the AC battery export
 * share EOS chose for the slot); a rule without it passes batteryExportW=0 and
 * this collapses to the legacy PV-only -(pvW - buffer).
 *
 * Hard guarantees (no illegal grid charge — result is always <= 0):
 *  - battery share is clamped to `akkuAcLimitW` (the ~16 kW AC battery limit the
 *    MultiPlus itself does NOT know; clamping here is what stops the Multi from
 *    over-pulling the battery to hold a large grid setpoint when PV dips).
 *  - total export is clamped to `connectionLimitW` (~29 kW grid connection); the
 *    battery share is trimmed first since PV export is "free" / has priority.
 *  - at/below `stopSocPct` the battery share is dropped → PV-only export.
 *
 * @param {object} p
 * @param {number} p.pvW                live PV production (W, AC-side total)
 * @param {number} [p.batteryExportW]   battery AC export share to add on top (W, >=0)
 * @param {number|null} [p.socPct]      live battery SoC (%), or null to skip the floor
 * @param {number|null} [p.stopSocPct]  slot SoC floor (%), or null to skip
 * @param {number} [p.bufferW]          self-consumption buffer kept off the grid
 * @param {number} [p.akkuAcLimitW]     battery AC discharge cap (default 16000)
 * @param {number} [p.connectionLimitW] total grid-export cap (default 29000)
 * @returns {{gridSetpointW:number, batteryShareW:number, exportW:number, reason:string}}
 */
export function computeCoExportSetpointW({
  pvW,
  batteryExportW = 0,
  socPct = null,
  stopSocPct = null,
  bufferW = 100,
  akkuAcLimitW = 16000,
  connectionLimitW = 29000
} = {}) {
  const pv = Math.max(0, toFiniteNumber(pvW, 0));
  const buffer = Math.max(0, toFiniteNumber(bufferW, 0));
  const akkuCap = Math.max(0, toFiniteNumber(akkuAcLimitW, 16000));
  const connCap = Math.max(0, toFiniteNumber(connectionLimitW, 29000));
  let share = Math.max(0, toFiniteNumber(batteryExportW, 0));
  let reason = 'co_export';

  // SoC floor: stop drawing the battery at/below the slot's stop floor —
  // fall back to PV-only export so we never drain past the operator's floor.
  // NB: Number(null) === 0 (finite!), so guard null/undefined explicitly —
  // otherwise an unset SoC would read as 0 % and falsely trip the floor.
  const soc = (socPct == null) ? NaN : toFiniteNumber(socPct, NaN);
  const floor = (stopSocPct == null) ? NaN : toFiniteNumber(stopSocPct, NaN);
  if (Number.isFinite(soc) && Number.isFinite(floor) && soc <= floor) {
    share = 0;
    reason = 'soc_floor_pv_only';
  }

  // Clamp the battery share to the AC battery limit (the Multi doesn't know it).
  if (share > akkuCap) {
    share = akkuCap;
    reason = 'akku_ac_clamp';
  }

  let exportW = pv + share - buffer;
  // Total grid export must not exceed the connection limit. Trim the battery
  // share first — PV export is free and has priority over arbitrage discharge.
  if (exportW > connCap) {
    const overshoot = exportW - connCap;
    share = Math.max(0, share - overshoot);
    exportW = pv + share - buffer;
    if (exportW > connCap) exportW = connCap; // PV alone exceeds the cap (rare)
    reason = 'connection_clamp';
  }
  exportW = Math.max(0, exportW);

  const roundedExport = Math.round(exportW);
  return {
    // Avoid -0 when there is nothing to export.
    gridSetpointW: roundedExport === 0 ? 0 : -roundedExport,
    batteryShareW: Math.round(share),
    exportW: roundedExport,
    reason
  };
}
