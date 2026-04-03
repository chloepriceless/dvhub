// services/optimizer/mispel-tracker.js -- MiSpeL/Pauschaloption yearly tracker (D-24..D-29).
// Tracks annual Gruenstrom/Graustrom feed-in volumes, computes Saldierung (yearly offset)
// for Umlagen refund, and provides real-time profitability check for grid-charging decisions.

/**
 * Total refundable Umlagen under Pauschaloption (ct/kWh).
 * KWK: 0.446 + Offshore: 0.941 + StromNEV: 1.559 + Stromsteuer: 2.05 = 4.996
 */
export const REFUNDABLE_UMLAGEN_CT_KWH = 4.996;

/**
 * Create a MiSpeL tracker instance for yearly Gruenstrom/Graustrom accounting.
 *
 * Under the Pauschaloption (EEG §19 Abs. 3c), PV systems up to 30 kWp can charge
 * batteries from the grid while retaining EEG feed-in tariff. The yearly offset
 * (Saldierung) determines how much grid withdrawal is retroactively exempted from
 * Umlagen (KWK, Offshore, StromNEV, Stromsteuer).
 *
 * @param {object} state - Shared application state (mutated: state.optimizer.mispel)
 * @param {function} getCfg - Config getter returning current config
 * @param {function} pushLog - Logging function (key, data)
 * @returns {{ update: function, getState: function, isGridChargeProfitable: function }}
 */
export function createMispelTracker(state, getCfg, pushLog) {
  const cfg = getCfg();
  const mode = cfg.optimizer?.mispel?.mode ?? 'none';

  // Initialize mispel sub-state if not present
  if (!state.optimizer.mispel) {
    state.optimizer.mispel = {
      mode,
      yearlyFeedInKwh: 0,
      yearlyGridWithdrawalKwh: 0,
      gruenstromKwh: 0,
      graustromKwh: 0,
      saldierungsfaehigKwh: 0,
      lastResetYear: new Date().getFullYear(),
      lastUpdateAt: null
    };
  }

  // Warn about Pauschaloption EU approval status (D-29)
  if (mode === 'pauschal') {
    pushLog('mispel_pauschal_warning', {
      message: 'Pauschaloption aktiviert -- EU-beihilferechtliche Genehmigung steht noch aus (Stand April 2026)'
    });
  }

  const mispel = state.optimizer.mispel;

  /**
   * Accumulate feed-in and grid withdrawal, recalculate derived fields.
   * Resets counters on year boundary (January 1).
   *
   * @param {number} feedInWh - Feed-in energy in Wh since last update
   * @param {number} gridWithdrawalWh - Grid withdrawal energy in Wh since last update
   */
  function update(feedInWh, gridWithdrawalWh) {
    // Year boundary reset
    const currentYear = new Date().getFullYear();
    if (currentYear !== mispel.lastResetYear) {
      mispel.yearlyFeedInKwh = 0;
      mispel.yearlyGridWithdrawalKwh = 0;
      mispel.gruenstromKwh = 0;
      mispel.graustromKwh = 0;
      mispel.saldierungsfaehigKwh = 0;
      mispel.lastResetYear = currentYear;
    }

    // Accumulate
    mispel.yearlyFeedInKwh += feedInWh / 1000;
    mispel.yearlyGridWithdrawalKwh += gridWithdrawalWh / 1000;

    // Recalculate derived fields (D-25)
    const pvKwp = getCfg().optimizer?.mispel?.pvKwp ?? 10;
    const gruenstromLimit = 500 * pvKwp;
    mispel.gruenstromKwh = Math.min(mispel.yearlyFeedInKwh, gruenstromLimit);
    mispel.graustromKwh = Math.max(0, mispel.yearlyFeedInKwh - gruenstromLimit);
    mispel.saldierungsfaehigKwh = mispel.graustromKwh;
    mispel.lastUpdateAt = new Date().toISOString();
  }

  /**
   * Return current mispel state snapshot.
   * @returns {object} Current state.optimizer.mispel
   */
  function getState() {
    return { ...mispel };
  }

  /**
   * Check if grid charging is profitable under Pauschaloption.
   * Returns adjusted import price reflecting Saldierung refund.
   *
   * @param {number} importCtKwh - Current grid import price in ct/kWh
   * @returns {{ profitable: boolean, reason: string, adjustedImportCtKwh: number }}
   */
  function isGridChargeProfitable(importCtKwh) {
    // Mode check (D-24)
    if (mispel.mode === 'none') {
      return {
        profitable: false,
        reason: 'mispel_disabled',
        adjustedImportCtKwh: importCtKwh
      };
    }

    // Saldierung formula (D-26)
    const saldierungsfaehig = mispel.saldierungsfaehigKwh;
    const alreadySaldiert = Math.min(saldierungsfaehig, mispel.yearlyGridWithdrawalKwh);
    const remaining = saldierungsfaehig - alreadySaldiert;

    if (remaining > 0) {
      return {
        profitable: true,
        reason: 'saldierung_available',
        adjustedImportCtKwh: importCtKwh - REFUNDABLE_UMLAGEN_CT_KWH
      };
    }

    return {
      profitable: false,
      reason: 'saldierung_exhausted',
      adjustedImportCtKwh: importCtKwh
    };
  }

  return { update, getState, isGridChargeProfitable };
}
