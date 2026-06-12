// eeg-extension.js — §51a EEG 2023 Förderzeitraum-Verlängerung (T-0004).
//
// Official mechanics, verified against the primary source
// https://www.gesetze-im-internet.de/eeg_2014/__51a.html (EEG 2023 i.d.F.
// Solarspitzengesetz, fetched 2026-06-13):
//
//   Abs. 1: the subsidy period extends by the number of quarter-hours in
//           which §51 Abs. 1 reduced the anzulegender Wert to zero
//           (commissioning year + 19 following calendar years). The total is
//           rounded UP to the next full calendar day (96 quarter-hours).
//   Abs. 2 (SOLAR): the Abs.-1 quarter-hour count is multiplied by 0.5 and
//           rounded UP to the next full quarter-hour → "Volllastviertel-
//           stunden" (VLVS), a time budget. The budget is consumed month by
//           month per the statutory table below; the period extends to the
//           END of the month that holds the last consumed VLVS. Because the
//           regular 20-year period always ends on 31 December (§25 EEG),
//           consumption ALWAYS starts with January.
//
// All functions are pure — the API route does the data fetching.

// §51a Abs. 2 Satz 3 EEG 2023 — Volllastviertelstunden per month (Jan..Dez).
export const VLVS_MONTH_TABLE = [87, 189, 340, 442, 490, 508, 498, 453, 371, 231, 118, 73];

// Sum of one table year (3800) — used for fast multi-year consumption.
const VLVS_YEAR_TOTAL = VLVS_MONTH_TABLE.reduce((a, b) => a + b, 0);

const DOW_MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/**
 * §51a Abs. 2 Satz 1: negative-price quarter-hours × 0.5, rounded UP to the
 * next full quarter-hour.
 */
export function vollastViertelstunden(negQuarterCount) {
  const n = Number(negQuarterCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n * 0.5);
}

/**
 * §51a Abs. 1 Satz 2 (non-solar / legacy path): quarter-hours rounded UP to
 * the next full calendar day → extension in DAYS.
 */
export function legacyExtensionDays(negQuarterCount) {
  const n = Number(negQuarterCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / 96);
}

/**
 * Consume a VLVS budget against the statutory month table, starting with
 * January (§25: the regular period ends 31 Dec, so the extension always
 * begins 1 Jan).
 *
 * @returns {{
 *   fullMonths: number,        // months whose table value is fully consumed
 *   accruedMonths: number,     // fullMonths + fraction of the next month (display "X,z Monate")
 *   legalMonths: number,       // statutory extension: started months count fully (extension runs to month END)
 *   lastMonthName: string|null // German name of the month holding the last VLVS
 * }}
 */
export function extensionFromVollast(vlvs) {
  let remaining = Number(vlvs);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return { fullMonths: 0, accruedMonths: 0, legalMonths: 0, lastMonthName: null };
  }
  let fullMonths = 0;
  // Whole table years first (a 20-year plant can in theory accrue years).
  if (remaining > VLVS_YEAR_TOTAL) {
    const years = Math.floor((remaining - 1) / VLVS_YEAR_TOTAL);
    fullMonths += years * 12;
    remaining -= years * VLVS_YEAR_TOTAL;
  }
  let idx = 0;
  while (remaining > 0 && idx < 12) {
    const cap = VLVS_MONTH_TABLE[idx];
    if (remaining >= cap) {
      remaining -= cap;
      fullMonths += 1;
      idx += 1;
      if (remaining === 0) {
        return {
          fullMonths,
          accruedMonths: round2(fullMonths),
          legalMonths: fullMonths,
          lastMonthName: DOW_MONTHS_DE[(idx + 11) % 12]
        };
      }
    } else {
      const fraction = remaining / cap;
      return {
        fullMonths,
        accruedMonths: round2(fullMonths + fraction),
        legalMonths: fullMonths + 1, // started month → extension runs to its END
        lastMonthName: DOW_MONTHS_DE[idx % 12]
      };
    }
  }
  return { fullMonths, accruedMonths: round2(fullMonths), legalMonths: fullMonths, lastMonthName: DOW_MONTHS_DE[11] };
}

/**
 * Count negative-price quarter-hour slots from a spot-price series
 * ({ts, value, resolution?} rows, ct/kWh). §51 Abs. 1 (i.d.F.
 * Solarspitzengesetz, plants commissioned >= 2025-02-25): EVERY quarter-hour
 * with a negative day-ahead price reduces the AW to zero — market-wide, no
 * per-plant export condition (the exchanges report the count centrally,
 * §51a Abs. 3).
 *
 * Resolution-aware: prod stores some price windows HOURLY (resolution 3600,
 * observed since 2026-03-26) — a negative hourly row covers 4 quarter-hours.
 * Those are counted ×(resolution/900) and surfaced separately in
 * `approxQuarterSlots` so the payload can flag the approximation.
 *
 * @returns {{ count: number, approxQuarterSlots: number, firstTs: string|null, lastTs: string|null }}
 */
export function countNegativeQuarterSlots(priceRows) {
  let count = 0;
  let approxQuarterSlots = 0;
  let firstTs = null;
  let lastTs = null;
  for (const row of (Array.isArray(priceRows) ? priceRows : [])) {
    const v = Number(row?.value);
    if (!Number.isFinite(v)) continue;
    if (firstTs == null) firstTs = row.ts;
    lastTs = row.ts;
    if (v < 0) {
      const res = Number(row?.resolution);
      const quarters = Number.isFinite(res) && res > 900 ? Math.round(res / 900) : 1;
      count += quarters;
      if (quarters > 1) approxQuarterSlots += quarters;
    }
  }
  return { count, approxQuarterSlots, firstTs, lastTs };
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
