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
 * @param {number|null} [p.loadW]   EOS house load for the slot (W); when given,
 *                                  a PV-surplus slot that ALSO charges the battery
 *                                  (PV − load − feed-in > band) is labelled
 *                                  "Akku lädt + Überschuss einspeisen". null/absent
 *                                  ⇒ legacy behaviour (plain "PV-Überschuss einspeisen").
 * @param {number} [p.bandW]        charge-detection band (W); below it the residual
 *                                  is plan-split noise → plain surplus (matches the
 *                                  control path's bandW in pullGridSetpoints).
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
  loadW = null,
  bandW = 300,
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
  const pvPresent = pv > EPS_W;

  if (dischargeAllowed && feedin > EPS_W && batteryShare > EPS_W) {
    if (pvPresent) {
      // PV + Akku zusammen einspeisen — the live-nachgeregelte co-export.
      // Lever = dcExportMode (it exports live PV; the battery share rides on
      // top once the regulator is wired). Only valid WHILE PV is flowing.
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
    // Keine PV (z. B. abends) → reine Akku-Entladung ins Netz. dcExportMode wäre
    // hier FALSCH (es exportiert PV und tut bei pvW≈0 nichts) — der richtige
    // Hebel ist ein negativer gridSetpointW (Entladen/LEEREN), Akku-Anteil auf
    // den AC-Cap geklemmt.
    let share = Math.min(batteryShare, akkuAcLimitW);
    if (share > connectionLimitW) share = connectionLimitW;
    const exportW = Math.round(share);
    return {
      action: 'battery_export',
      label: 'Akku einspeisen',
      target: 'gridSetpointW',
      batteryExportW: exportW,
      gridSetpointW: exportW === 0 ? 0 : -exportW
    };
  }

  // PV-Überschuss-Einspeisung (Akku netto ~0 ins Netz).
  if (feedin > EPS_W) {
    // T-CURTAIL-CHARGE (Christin 2026-06-25): EOS may CHARGE the battery from PV
    // in the SAME surplus slot it exports (planned charge = PV − Last − Einspeisung).
    // The control path (pullGridSetpoints/schedule-eval) reserves that charge above
    // the band before exporting, so the Fahrplan must show it too — otherwise the
    // preview reads "alles einspeisen" while the box actually charges. The exported
    // setpoint is then the EOS feed-in minus buffer (= live PV − Last − Reserve − Puffer).
    if (loadW != null) {
      const load = Math.max(0, Number(loadW) || 0);
      const chargeReserve = Math.max(0, pv - load - feedin);
      if (chargeReserve > bandW) {
        const exportW = Math.max(0, Math.round(feedin - bufferW));
        return {
          action: 'pv_charge_export',
          label: 'Akku lädt + Überschuss einspeisen',
          target: 'dcExportMode',
          batteryExportW: 0,
          gridSetpointW: exportW === 0 ? 0 : -exportW
        };
      }
    }
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
  // WICHTIG (T-0118, 2026-06-06): nur labeln wenn auch PV fließt. Die GA lässt
  // das DC-Lade-Gen (dcChargeFactor) in fast jedem Slot AN, damit der Akku lädt
  // SOBALD PV kommt — nachts ist PV=0, es lädt also nichts. Ohne diese
  // pvPresent-Bedingung zeigte der Inspector fälschlich „Akku lädt (PV)" für
  // jeden Nacht-Slot (SoC fällt, pv=0) — die wiederkehrende Verwirrung. Ohne PV
  // fällt der Slot korrekt auf Netzbezug/Halten durch.
  if (charging && pvPresent) {
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
