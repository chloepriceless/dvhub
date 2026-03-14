/**
 * MISPEL Tracker -- Energy provenance tracking for Pauschaloption regulation.
 *
 * Tracks PV vs grid-sourced battery charge/discharge flows and monitors
 * the annual 500 kWh/kWp cap for EEG eligibility under the upcoming
 * BNetzA MISPEL Festlegung.
 *
 * IMPORTANT: This is preparation-only. Disabled by default (config.enabled = false).
 * BNetzA rules are not yet finalized (expected H1 2026). Do NOT use for billing.
 */

/**
 * Create a MISPEL tracker for energy provenance and annual cap monitoring.
 * @param {object} [options]
 * @param {object} [options.config] - MISPEL config: { enabled, pvPeakKwp, capKwhPerKwp }
 * @param {object} [options.db] - Database adapter with insertSamples/queryAggregates
 * @param {object} [options.log] - Pino-compatible logger
 * @returns {{ recordEnergyFlow, getAnnualStatus, isEnabled }}
 */
export function createMispelTracker({ config, db, log } = {}) {
  const enabled = config?.enabled === true;
  const pvPeakKwp = config?.pvPeakKwp || 0;
  const capKwhPerKwp = config?.capKwhPerKwp || 500;
  const annualCapKwh = pvPeakKwp * capKwhPerKwp;

  /**
   * Whether the MISPEL tracker is active.
   * @returns {boolean}
   */
  function isEnabled() {
    return enabled;
  }

  /**
   * Record an energy flow sample with provenance tracking.
   * No-op when MISPEL is disabled.
   * @param {object} flow
   * @param {string} flow.timestamp - ISO timestamp
   * @param {number} flow.pvToStorageWh - PV energy charged to storage (Wh)
   * @param {number} flow.gridToStorageWh - Grid energy charged to storage (Wh)
   * @param {number} flow.storageToGridWh - Storage energy discharged to grid (Wh)
   */
  async function recordEnergyFlow({ timestamp, pvToStorageWh, gridToStorageWh, storageToGridWh }) {
    if (!enabled) return;

    await db.insertSamples([
      { ts: timestamp, seriesKey: 'mispel.pvToStorage', valueNum: pvToStorageWh, unit: 'Wh' },
      { ts: timestamp, seriesKey: 'mispel.gridToStorage', valueNum: gridToStorageWh, unit: 'Wh' },
      { ts: timestamp, seriesKey: 'mispel.storageToGrid', valueNum: storageToGridWh, unit: 'Wh' }
    ]);

    log?.debug(
      { timestamp, pvToStorageWh, gridToStorageWh, storageToGridWh },
      'MISPEL energy flow recorded'
    );
  }

  /**
   * Get annual cap utilization status.
   * @param {number} year - Calendar year (e.g. 2026)
   * @returns {Promise<{ usedKwh, capKwh, remainingKwh, utilizationPct, year, enabled }>}
   */
  async function getAnnualStatus(year) {
    const start = new Date(`${year}-01-01T00:00:00Z`);
    const end = new Date(`${year + 1}-01-01T00:00:00Z`);

    const samples = await db.queryAggregates({
      seriesKeys: ['mispel.storageToGrid'],
      start,
      end,
      bucket: 'yearly'
    });

    const totalWh = samples.reduce((sum, s) => sum + (s.valueNum || 0), 0);
    const usedKwh = totalWh / 1000;

    return {
      usedKwh,
      capKwh: annualCapKwh,
      remainingKwh: Math.max(0, annualCapKwh - usedKwh),
      utilizationPct: annualCapKwh > 0 ? (usedKwh / annualCapKwh) * 100 : 0,
      year,
      enabled
    };
  }

  return { recordEnergyFlow, getAnnualStatus, isEnabled };
}
