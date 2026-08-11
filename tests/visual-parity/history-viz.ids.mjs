// tests/visual-parity/history-viz.ids.mjs
// Phase 09.3 — canonical 14-card mount-ID list (source-of-truth).
//
// This is a PLAIN ES module, not a Playwright spec — Playwright rejects a
// spec file importing another spec file ("test file should not import test
// file"). The shared EXPECTED_VIZ_IDS array lives here so both
// history-viz.spec.mjs and history-viz-leak.spec.mjs (and any future
// binding-contract consumer) can import it without tripping that rule.
//
// Order mirrors the wave sequence (Wave 2: 5, Wave 3: 3, Wave 4: 3, Wave 5: 3).
// 'ledgerBody' removed (2026-07): the Spot-Ledger card was dropped by design —
// history-viz.js:1478 "the `ledger` slug is intentionally absent".
// 'vNegPrice' added (2026-07, Plan 09.4): Negativpreis-Heatmap card, slug
// 'neg-price', month+year views only — net card count unchanged at 14.

export const EXPECTED_VIZ_IDS = [
  'sankeySvg', 'hm', 'dayProfileMount', 'vStack',
  'autarkCal', 'ringSvg', 'vDuration', 'vPHeat', 'vNegPrice', 'vSpag',
  'vCycles', 'vTop10', 'vCalYear', 'vScatter'
];
