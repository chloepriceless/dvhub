// DVhub fork (2026-06-01) — EOS → Zeitplan-Hebel mapping (display-only).
//
// Translates one EOS optimisation-solution slot into the DVhub Zeitplan lever
// the kleine Börsenautomatik / Zeitplan actually use, so the operator can SEE,
// per 15-min slot in the EOS-Übersicht, what EOS' forecast plan would command —
// and judge whether "EOS macht die richtigen Sachen in der Vorhersage" — WITHOUT
// any actuation (primarySource stays internal).
//
// The only levers that exist in the Zeitplan (verified in market-automation-
// builder.js): gridSetpointW (Halten / Entladen) and dcExportMode (PV- bzw.
// PV+Akku-Einspeisung, live-nachgeregelt). feedExcessDcPv is the DV-Schnittstelle
// (DV-Vermarktung) and is NOT a Zeitplan lever. There is deliberately NO active
// charge lever (chargeCurrentA / Netzladen) here: grid-charging stays off until
// the Bundesnetzagentur MisPel / Pauschaloption clearance — "Laden" therefore
// just means "nicht entladen, Akku lädt aus PV" (Halten).

import { computeCoExportSetpointW } from './predictive-pre-empty.js';

// Below this many watts a flow is treated as noise (no export / no charge).
const EPS_W = 150;
const HOLD_SETPOINT_W = -40;

/**
 * Classify a single EOS solution slot into its Zeitplan lever.
 *
 * All power inputs are in watts (the caller converts EOS' per-slot Wh using the
 * slot length). Sign convention for gridSetpointW matches schedule-eval / the
 * Victron ESS register: <= 0 (export / hold), never a positive grid charge.
 *
 * @param {object} p
 * @param {number} p.pvW            forecast PV production for the slot (W)
 * @param {number} p.feedinW        EOS grid feed-in (export) for the slot (W)
 * @param {number} [p.importW]      EOS grid consumption (import) for the slot (W)
 * @param {boolean} [p.dischargeAllowed]  genetic_discharge_allowed_factor > 0
 * @param {number} [p.dcChargeFactor]     genetic_dc_charge_factor (>0 = PV charging)
 * @param {number|null} [p.socPct]        EOS SoC trajectory for the slot (%)
 * @param {number|null} [p.stopSocPct]    floor for the co-export preview, or null
 * @param {number} [p.bufferW]            dcExportMode buffer kept off the grid
 * @param {number} [p.akkuAcLimitW]       battery AC export cap (default 16000)
 * @param {number} [p.connectionLimitW]   grid connection cap (default 29000)
 * @returns {{action:string, label:string, target:string,
 *            batteryExportW:number, gridSetpointW:number}}
 */
export function classifyEosSlotAction({
  pvW = 0,
  feedinW = 0,
  importW = 0,
  dischargeAllowed = false,
  dcChargeFactor = 0,
  socPct = null,
  stopSocPct = null,
  bufferW = 100,
  akkuAcLimitW = 16000,
  connectionLimitW = 29000
} = {}) {
  const pv = Math.max(0, Number(pvW) || 0);
  const feedin = Math.max(0, Number(feedinW) || 0);
  const imp = Math.max(0, Number(importW) || 0);
  const charging = (Number(dcChargeFactor) || 0) > 0;
  // Battery's grid-export share = feed-in beyond what PV alone supplies.
  const batteryShare = Math.max(0, feedin - pv);

  // PV + Akku zusammen einspeisen (the live-nachgeregelte co-export).
  if (dischargeAllowed && feedin > EPS_W && batteryShare > EPS_W) {
    const co = computeCoExportSetpointW({
      pvW: pv, batteryExportW: batteryShare,
      socPct, stopSocPct, bufferW, akkuAcLimitW, connectionLimitW
    });
    return {
      action: 'co_export',
      label: 'PV+Akku einspeisen',
      target: 'dcExportMode',
      batteryExportW: co.batteryShareW,
      gridSetpointW: co.gridSetpointW
    };
  }

  // Reine PV-Überschuss-Einspeisung (Akku netto ~0).
  if (feedin > EPS_W) {
    const exportW = Math.max(0, Math.round(pv - bufferW));
    return {
      action: 'pv_export',
      label: 'PV-Überschuss einspeisen',
      target: 'dcExportMode',
      batteryExportW: 0,
      gridSetpointW: exportW === 0 ? 0 : -exportW
    };
  }

  // Akku lädt aus PV — kein aktives Laden (Netzladen aus, bis BNetzA-Freigabe):
  // einfach halten, damit PV-Überschuss in den Akku statt ins Netz geht.
  if (charging) {
    return {
      action: 'charge',
      label: 'Akku lädt (PV)',
      target: 'gridSetpointW',
      batteryExportW: 0,
      gridSetpointW: HOLD_SETPOINT_W
    };
  }

  // Netzbezug zur Lastdeckung (Akku leer / hält) — Hebel ist ebenfalls Halten.
  if (imp > EPS_W) {
    return {
      action: 'grid_draw',
      label: 'Netzbezug',
      target: 'gridSetpointW',
      batteryExportW: 0,
      gridSetpointW: HOLD_SETPOINT_W
    };
  }

  // Halten / Eigenverbrauch.
  return {
    action: 'hold',
    label: 'Halten',
    target: 'gridSetpointW',
    batteryExportW: 0,
    gridSetpointW: HOLD_SETPOINT_W
  };
}
