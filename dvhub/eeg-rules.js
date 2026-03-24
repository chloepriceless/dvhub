/**
 * EEG rules lookup table for negative price regulations and feed-in compensation.
 *
 * Implements §51 EEG for all commissioning date ranges:
 *   - Pre-2016: no curtailment
 *   - 2016–2020 >= 500 kWp: 6h rule (EEG 2017)
 *   - 2021–2022 >= 400 kWp: 4h rule (EEG 2021)
 *   - 2023–2025-02-24 >= 400 kWp: tiered rule (EEG 2023 §51)
 *   - From 2025-02-25 >= 2 kWp: 15min rule (Solarspitzengesetz)
 */

function round2(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const sign = numeric < 0 ? -1 : 1;
  return sign * (Math.round((Math.abs(numeric) + Number.EPSILON) * 100) / 100);
}

/**
 * Ordered from newest to oldest commissioning date so the first match wins.
 * Each entry defines: commissionedFrom, commissionedBefore (exclusive upper bound),
 * minKwp (minimum plant size to trigger the rule), rule type, and optional tiers.
 */
export const NEGATIVE_PRICE_RULES = [
  {
    commissionedFrom: '2025-02-25',
    minKwp: 2,
    rule: '15min',
    description: '§51/51a/51b EEG 2023 (Solarspitzengesetz): Kürzung bei jeder negativen Viertelstunde'
  },
  {
    commissionedFrom: '2023-01-01',
    commissionedBefore: '2025-02-25',
    minKwp: 400,
    rule: 'tiered',
    tiers: { 2023: 4, 2024: 3 },
    description: '§51 EEG 2023 (Übergangsstufen): 4h/3h abgestufte Kürzungsregel'
  },
  {
    commissionedFrom: '2021-01-01',
    commissionedBefore: '2023-01-01',
    minKwp: 400,
    rule: '4h',
    description: '§51 EEG 2021: Kürzung ab 4 aufeinanderfolgenden negativen Stunden'
  },
  {
    commissionedFrom: '2016-01-01',
    commissionedBefore: '2021-01-01',
    minKwp: 500,
    rule: '6h',
    description: '§51 EEG 2017: Kürzung ab 6 aufeinanderfolgenden negativen Stunden'
  }
];

/**
 * EV (Einspeisevergütungs-Vermeidungs) deduction in ct/kWh for standard connection.
 * The feed-in compensation is the applicable value (AW) minus this deduction.
 */
export const EV_DEDUCTION_CT_KWH = 0.4;

/**
 * EV deduction for plants with an intelligent meter system (iMSys).
 */
export const EV_DEDUCTION_ISMS_CT_KWH = 0.2;

/**
 * Look up the §51 EEG negative price curtailment rule for a plant.
 *
 * @param {object} params
 * @param {string|null|undefined} params.commissionedAt - ISO date string (YYYY-MM-DD)
 * @param {number} params.kwp - Plant capacity in kWp
 * @returns {{ rule: string, minKwp?: number, tiers?: object, description?: string }}
 */
export function getEegNegativePriceRule({ commissionedAt, kwp } = {}) {
  if (!commissionedAt || typeof commissionedAt !== 'string') {
    return { rule: 'none', description: 'Keine Kürzung: kein Inbetriebnahmedatum angegeben' };
  }

  const numericKwp = Number(kwp);
  if (!Number.isFinite(numericKwp) || numericKwp <= 0) {
    return { rule: 'none', description: 'Keine Kürzung: ungültige Anlagengröße' };
  }

  for (const entry of NEGATIVE_PRICE_RULES) {
    const afterFrom = commissionedAt >= entry.commissionedFrom;
    const beforeEnd = !entry.commissionedBefore || commissionedAt < entry.commissionedBefore;
    const meetsKwp = numericKwp >= entry.minKwp;

    if (afterFrom && beforeEnd && meetsKwp) {
      return {
        rule: entry.rule,
        minKwp: entry.minKwp,
        ...(entry.tiers ? { tiers: entry.tiers } : {}),
        ...(entry.description ? { description: entry.description } : {})
      };
    }
  }

  return { rule: 'none', description: 'Keine Kürzung: Anlage vor 2016 in Betrieb genommen oder unter Schwellenwert' };
}

/**
 * Calculate the feed-in compensation (Einspeisevergütung) in ct/kWh.
 * The compensation is the applicable value (AW / Anzulegender Wert) minus the EV deduction.
 *
 * @param {object} params
 * @param {number|null} params.applicableValueCtKwh - The AW in ct/kWh
 * @param {boolean} [params.hasSmartMeter=false] - Whether an iMSys is installed
 * @returns {number|null} Feed-in compensation in ct/kWh, or null if AW is not finite
 */
export function getFeedInCompensationCtKwh({ applicableValueCtKwh, hasSmartMeter = false } = {}) {
  if (applicableValueCtKwh == null) return null;
  const aw = Number(applicableValueCtKwh);
  if (!Number.isFinite(aw)) return null;
  const deduction = hasSmartMeter ? EV_DEDUCTION_ISMS_CT_KWH : EV_DEDUCTION_CT_KWH;
  return round2(aw - deduction);
}

/**
 * Determine whether a specific slot (quarter-hour or hour) is subject to
 * negative price curtailment under §51 EEG.
 *
 * @param {object} params
 * @param {string} params.rule - Rule type: 'none' | '6h' | '4h' | 'tiered' | '15min'
 * @param {number} [params.marketPriceCtKwh] - Spot market price in ct/kWh (for 15min rule)
 * @param {number} [params.consecutiveNegativeHours] - Number of consecutive negative hours so far
 * @param {number} [params.year] - Calendar year (for tiered rule threshold lookup)
 * @param {object} [params.tiers] - Year-to-hours threshold map (for tiered rule)
 * @returns {boolean}
 */
export function isNegativePriceSlotAffected({ rule, marketPriceCtKwh, consecutiveNegativeHours, year, tiers } = {}) {
  switch (rule) {
    case 'none':
      return false;
    case '6h':
      return Number(consecutiveNegativeHours) >= 6;
    case '4h':
      return Number(consecutiveNegativeHours) >= 4;
    case '15min':
      return Number(marketPriceCtKwh) < 0;
    case 'tiered': {
      const threshold = (tiers && year != null) ? (tiers[Number(year)] ?? 4) : 4;
      return Number(consecutiveNegativeHours) >= threshold;
    }
    default:
      return false;
  }
}
