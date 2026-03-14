/**
 * Tariff Engine Service
 *
 * Resolves the effective import price (ct/kWh) for any timestamp across
 * all supported German tariff models:
 * - Fixed price (with optional period overrides)
 * - Dynamic (EPEX spot + components)
 * - Paragraph 14a Module 3 time-variable network charges (HT/NT/ST windows)
 *
 * Factory function pattern matching plan-engine.js.
 */

/**
 * Find the active pricing period for a given timestamp.
 * Periods use startDate/endDate (inclusive) as configured in config.example.json.
 * @param {Array} periods - Array of period objects with startDate/endDate
 * @param {Date} timestamp
 * @returns {object|null} Matching period or null
 */
function findActivePeriod(periods, timestamp) {
  if (!periods || !periods.length) return null;
  const ts = timestamp.getTime();
  for (const period of periods) {
    const start = new Date(period.startDate || period.start).getTime();
    // endDate is inclusive -- set to end of that day
    const endStr = period.endDate || period.end;
    const end = new Date(endStr).getTime() + 86400000 - 1; // end of day
    if (ts >= start && ts <= end) {
      return period;
    }
  }
  return null;
}

/**
 * Convert a Date to HH:MM string in Europe/Berlin timezone.
 * Uses Intl.DateTimeFormat for timezone-safe conversion (no hand-rolled math).
 * @param {Date} timestamp
 * @returns {string} HH:MM format
 */
function toBerlinHHMM(timestamp) {
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(timestamp);
}

/**
 * Convert HH:MM string to minutes since midnight.
 * @param {string} hhmm - Time in HH:MM format
 * @returns {number} Minutes since midnight
 */
function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Find the active Module 3 time window for a given timestamp.
 * Handles midnight-crossing windows (start > end means overnight).
 * @param {object} module3Windows - { window1, window2, window3 } from config
 * @param {Date} timestamp
 * @returns {object|null} Matching window or null
 */
function findActiveModule3Window(module3Windows, timestamp) {
  if (!module3Windows) return null;
  const berlinTime = toBerlinHHMM(timestamp);
  const nowMinutes = hhmmToMinutes(berlinTime);

  for (const key of ['window1', 'window2', 'window3']) {
    const win = module3Windows[key];
    if (!win || !win.enabled) continue;

    const startMin = hhmmToMinutes(win.start);
    const endMin = hhmmToMinutes(win.end);

    if (startMin < endMin) {
      // Normal window (e.g., 08:00-20:00)
      if (nowMinutes >= startMin && nowMinutes < endMin) return win;
    } else {
      // Midnight-crossing window (e.g., 23:00-08:00)
      if (nowMinutes >= startMin || nowMinutes < endMin) return win;
    }
  }
  return null;
}

/**
 * Create a tariff engine that resolves prices for any timestamp.
 * @param {object} options
 * @param {object} options.config - The userEnergyPricing section from effectiveConfig
 * @param {object} [options.log] - Pino-compatible logger
 * @returns {{ resolvePrice, resolveNetworkCharge, computeTotalImportCost }}
 */
export function createTariffEngine({ config, log } = {}) {
  const mode = config.mode || 'fixed';

  /**
   * Resolve the effective price for a given timestamp.
   * Checks active period override first, then falls back to base config.
   * @param {Date} timestamp
   * @returns {{ grossCtKwh?: number, components?: object, needsSpotPrice?: boolean }}
   */
  function resolvePrice(timestamp) {
    const period = findActivePeriod(config.periods, timestamp);
    const effectiveMode = period?.mode || mode;

    if (effectiveMode === 'fixed') {
      return {
        grossCtKwh: period?.fixedGrossImportCtKwh || config.fixedGrossImportCtKwh,
      };
    }
    if (effectiveMode === 'dynamic') {
      const components = period?.dynamicComponents || config.dynamicComponents;
      return { components, needsSpotPrice: true };
    }

    // Fallback
    return { grossCtKwh: config.fixedGrossImportCtKwh || 0 };
  }

  /**
   * Resolve the network charge for a given timestamp.
   * Without Module 3: returns flat gridChargesCtKwh.
   * With Module 3: resolves HT/NT/ST window based on Europe/Berlin time-of-day.
   * @param {Date} timestamp
   * @returns {{ networkChargeCtKwh: number, windowLabel?: string }}
   */
  function resolveNetworkCharge(timestamp) {
    if (!config.usesParagraph14aModule3) {
      return {
        networkChargeCtKwh: config.dynamicComponents?.gridChargesCtKwh || 0,
      };
    }

    const win = findActiveModule3Window(config.module3Windows, timestamp);
    return {
      networkChargeCtKwh: win?.priceCtKwh || 0,
      windowLabel: win?.label || 'unknown',
    };
  }

  /**
   * Compute total import cost from dynamic components.
   * Formula: (spotPrice + markup + gridCharge + levies) * (1 + VAT/100)
   * @param {object} params
   * @param {number} params.spotPriceCtKwh - EPEX spot price in ct/kWh
   * @param {object} params.components - Dynamic tariff components
   * @param {object} [params.module3Charge] - Module 3 network charge override
   * @returns {{ netCtKwh: number, grossCtKwh: number }}
   */
  function computeTotalImportCost({ spotPriceCtKwh, components, module3Charge }) {
    const energyCost = spotPriceCtKwh + (components.energyMarkupCtKwh || 0);
    const gridCharge = module3Charge?.networkChargeCtKwh ?? (components.gridChargesCtKwh || 0);
    const levies = components.leviesAndFeesCtKwh || 0;
    const netTotal = energyCost + gridCharge + levies;
    const grossTotal = netTotal * (1 + (components.vatPct || 19) / 100);
    return { netCtKwh: netTotal, grossCtKwh: grossTotal };
  }

  return { resolvePrice, resolveNetworkCharge, computeTotalImportCost };
}
