// services/optimizer/cost-model.js -- Cost model for electricity pricing
// Transforms raw EPEX spot prices into fully-loaded Bezugspreise (import costs)
// and Einspeisepreise (feed-in compensation), including all German electricity
// price components per MiSpeL/StromNEV regulations (2026 defaults).
//
// Pure functions -- no side effects, no config reads.
// Config is passed in via enrichPriceSlotsWithCosts(slots, cfg).

/**
 * Compute import and feed-in costs for a single time slot.
 *
 * @param {number} spotCtKwh - Raw EPEX spot price in ct/kWh
 * @param {object} tariff - Tariff configuration
 * @param {string} tariff.type - 'dynamic' | 'fixed' | 'mixed'
 * @param {number} tariff.fixedCtKwh - Fixed tariff rate (used when type='fixed')
 * @param {number} tariff.minCtKwh - Floor price for mixed mode
 * @param {number} tariff.netzentgeltCtKwh - Network charge (default 9.26)
 * @param {number} tariff.kwkCtKwh - CHP surcharge (default 0.446)
 * @param {number} tariff.offshoreCtKwh - Offshore wind surcharge (default 0.941)
 * @param {number} tariff.stromnevCtKwh - StromNEV surcharge (default 1.559)
 * @param {number} tariff.stromsteuerCtKwh - Electricity tax (default 2.05)
 * @param {number} tariff.konzessionsabgabeCtKwh - Concession fee (default 1.66)
 * @param {number} tariff.vertriebsaufschlagCtKwh - Retail markup (default 0)
 * @param {number} tariff.vatPct - VAT percentage (default 19)
 * @param {string} tariff.feedInMode - 'fixed' | 'spot'
 * @param {number} tariff.feedInCtKwh - Fixed feed-in rate (default 7.78)
 * @param {number} tariff.feedInSpotFactor - Spot feed-in factor (default 1.0)
 * @param {object} paragraph14a - Paragraph 14a EnWG configuration
 * @param {boolean} paragraph14a.enabled - Whether 14a reduction is active
 * @param {number} paragraph14a.reductionCtKwh - Reduction amount in ct/kWh
 * @returns {{ importCtKwh: number, feedInCtKwh: number, components: object }}
 */
export function computeSlotCosts(spotCtKwh, tariff, paragraph14a) {
  // --- Fixed tariff: return flat rate, skip surcharge calculation ---
  if (tariff.type === 'fixed') {
    return {
      importCtKwh: tariff.fixedCtKwh,
      feedInCtKwh: tariff.feedInCtKwh,
      components: { type: 'fixed' }
    };
  }

  // --- Dynamic / Mixed tariff: sum all components ---
  const netzentgelt = tariff.netzentgeltCtKwh ?? 9.26;
  const kwk = tariff.kwkCtKwh ?? 0.446;
  const offshore = tariff.offshoreCtKwh ?? 0.941;
  const stromnev = tariff.stromnevCtKwh ?? 1.559;
  const stromsteuer = tariff.stromsteuerCtKwh ?? 2.05;
  const konzession = tariff.konzessionsabgabeCtKwh ?? 1.66;
  const vertrieb = tariff.vertriebsaufschlagCtKwh ?? 0;
  const vatPct = tariff.vatPct ?? 19;

  // 14a reduction: only applied when enabled
  const p14aReduction = paragraph14a.enabled ? (paragraph14a.reductionCtKwh ?? 0) : 0;

  // Netto base: spot + all surcharges - 14a reduction
  let nettoBase = spotCtKwh + netzentgelt + kwk + offshore + stromnev + stromsteuer + konzession + vertrieb - p14aReduction;

  // Mixed mode: enforce floor price
  if (tariff.type === 'mixed') {
    nettoBase = Math.max(nettoBase, tariff.minCtKwh ?? 20);
  }

  // Brutto: netto * (1 + VAT), rounded to 3 decimal places
  const importCtKwh = Math.round(nettoBase * (1 + vatPct / 100) * 1000) / 1000;

  // --- Feed-in price ---
  let feedInCtKwh;
  if (spotCtKwh < 0) {
    // D-30: Negative spot price -> no feed-in compensation
    feedInCtKwh = 0;
  } else if (tariff.feedInMode === 'spot') {
    feedInCtKwh = spotCtKwh * (tariff.feedInSpotFactor ?? 1.0);
  } else {
    // 'fixed' mode (default)
    feedInCtKwh = tariff.feedInCtKwh ?? 7.78;
  }

  return {
    importCtKwh,
    feedInCtKwh,
    components: {
      spot: spotCtKwh,
      netzentgelt,
      kwk,
      offshore,
      stromnev,
      stromsteuer,
      konzession,
      vertrieb,
      p14aReduction,
      vatPct
    }
  };
}

/**
 * Enrich an array of normalized price slots with import and feed-in costs.
 * Reads ALL pricing data from existing userEnergyPricing config — no duplicate fields.
 *
 * Sources:
 * - Tariff type + surcharges: userEnergyPricing.mode + dynamicComponents
 * - Fixed price: userEnergyPricing.fixedGrossImportCtKwh
 * - §14a: userEnergyPricing.usesParagraph14aModule3 + module3Windows
 * - Feed-in tariff: from pvPlants anzulegender Wert (or default 7.78)
 *
 * @param {Array<{ts: number, endTs: number, ctKwh: number, confidence: number}>} priceSlots
 * @param {object} cfg - Full config object
 * @param {object} [options] - Optional overrides
 * @param {number} [options.applicableValueCtKwh] - Anzulegender Wert from bundesnetzagentur-applicable-values
 * @returns {Array<{ts: number, endTs: number, ctKwh: number, confidence: number, importCtKwh: number, feedInCtKwh: number}>}
 */
export function enrichPriceSlotsWithCosts(priceSlots, cfg, options = {}) {
  const uep = cfg.userEnergyPricing ?? {};
  const dc = uep.dynamicComponents ?? {};

  // Build tariff from userEnergyPricing (single source of truth)
  const tariff = {
    type: uep.mode ?? 'dynamic',
    netzentgeltCtKwh: dc.gridChargesCtKwh ?? 9.26,
    kwkCtKwh: dc.kwkCtKwh ?? 0.446,
    offshoreCtKwh: dc.offshoreCtKwh ?? 0.941,
    stromnevCtKwh: dc.stromnevCtKwh ?? 1.559,
    stromsteuerCtKwh: dc.stromsteuerCtKwh ?? 2.05,
    konzessionsabgabeCtKwh: dc.konzessionsabgabeCtKwh ?? 1.66,
    vertriebsaufschlagCtKwh: dc.energyMarkupCtKwh ?? 0,
    vatPct: dc.vatPct ?? 19,
    fixedCtKwh: uep.fixedGrossImportCtKwh ?? 30,
    minCtKwh: 20,
    // Feed-in: from anzulegender Wert (pvPlants) or fallback
    feedInMode: uep.marketValueMode === 'monthly' ? 'spot' : 'fixed',
    feedInCtKwh: options.applicableValueCtKwh ?? 7.78,
    feedInSpotFactor: 1.0
  };

  // §14a from existing userEnergyPricing (not duplicate optimizer fields)
  const paragraph14a = {
    enabled: uep.usesParagraph14aModule3 ?? false,
    reductionCtKwh: cfg.optimizer?.paragraph14a?.reductionCtKwh ?? 0
  };

  return priceSlots.map(slot => {
    const costs = computeSlotCosts(slot.ctKwh, tariff, paragraph14a);
    return {
      ...slot,
      importCtKwh: costs.importCtKwh,
      feedInCtKwh: costs.feedInCtKwh
    };
  });
}

/**
 * Convert enriched price slots (15-min, ct/kWh) to EOS Strompreis array (1h, Euro/Wh).
 * Groups by hour, averages importCtKwh, converts ct/kWh to Euro/Wh (divide by 100000).
 * Returns flat number[] sorted by time.
 *
 * D-20: EOS expects Euro/Wh, our slots store ct/kWh.
 * 1 ct/kWh = 0.01 Euro / 1000 Wh = 0.00001 Euro/Wh = 1/100000
 *
 * @param {Array<{ts: number, importCtKwh: number}>} enrichedSlots
 * @returns {number[]} Flat array of Euro/Wh values, one per hour, sorted by time
 */
export function toEosStrompreisArray(enrichedSlots) {
  if (!enrichedSlots || enrichedSlots.length === 0) return [];

  // Group by hour boundary
  const hourBuckets = new Map();

  for (const slot of enrichedSlots) {
    const hourStart = slot.ts - (slot.ts % 3600000);
    if (!hourBuckets.has(hourStart)) {
      hourBuckets.set(hourStart, []);
    }
    hourBuckets.get(hourStart).push(slot);
  }

  // Sort hour keys and compute averages
  const sortedHours = Array.from(hourBuckets.keys()).sort((a, b) => a - b);

  return sortedHours.map(hourStart => {
    const bucketSlots = hourBuckets.get(hourStart);
    let sum = 0;
    for (const s of bucketSlots) {
      sum += s.importCtKwh;
    }
    const avgCtKwh = sum / bucketSlots.length;
    // Convert ct/kWh to Euro/Wh
    return avgCtKwh / 100000;
  });
}
