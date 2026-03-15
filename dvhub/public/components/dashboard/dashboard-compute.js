/**
 * Pure compute functions for dashboard data cards.
 * Ported from legacy app.js -- no DOM, no signals, no project imports.
 */

/**
 * Format a numeric cent value using de-DE locale with "Cent" suffix.
 * @param {number} value
 * @param {number} [maximumFractionDigits=2]
 * @returns {string} e.g. "12,35 Cent" or "-"
 */
function fmtCentValue(value, maximumFractionDigits = 2) {
  if (value == null) return '-';
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '-';
  return `${numericValue.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits })} Cent`;
}

/**
 * Format cents value as German locale string with "Cent" suffix.
 * @param {number} ct - value in cents
 * @returns {string} e.g. "12,35 Cent" or "-"
 */
export function formatCentFromCt(ct) {
  return fmtCentValue(ct);
}

/**
 * Format a tenth-of-cent value (divides by 10 first).
 * @param {number} value - value in 1/10 cents
 * @returns {string} e.g. "12,3 Cent" or "-"
 */
export function formatCentFromTenthCt(value) {
  return fmtCentValue(Number(value) / 10);
}

/**
 * Resolve DV control indicators from telemetry status.
 * Returns DC feed-in and AC curtailment indicator objects.
 *
 * @param {object} status - telemetry.value object
 * @returns {{ dc: { text: string, tone: string|undefined }, ac: { text: string, tone: string|undefined } }}
 */
export function resolveDvControlIndicators(status) {
  const dcReadback = status?.victron?.feedExcessDcPv;
  const acReadback = status?.victron?.dontFeedExcessAcPv;
  if (dcReadback != null || acReadback != null) {
    return {
      dc: {
        text: dcReadback == null ? '-' : (Number(dcReadback) === 1 ? 'EIN' : 'AUS'),
        tone: dcReadback == null ? undefined : (Number(dcReadback) === 1 ? 'ok' : 'off')
      },
      ac: {
        text: acReadback == null ? '-' : (Number(acReadback) === 1 ? 'Ja' : 'Nein'),
        tone: acReadback == null ? undefined : (Number(acReadback) === 1 ? 'off' : 'ok')
      }
    };
  }

  const dvc = status?.ctrl?.dvControl;
  if (!dvc) return { dc: { text: '-', tone: undefined }, ac: { text: '-', tone: undefined } };

  const dcOk = dvc.feedExcessDcPv?.ok;
  const acOk = dvc.dontFeedExcessAcPv?.ok;
  return {
    dc: {
      text: dcOk != null ? (dvc.feedIn ? 'EIN' : 'AUS') : '-',
      tone: dcOk != null ? (dvc.feedIn ? 'ok' : 'off') : undefined
    },
    ac: {
      text: acOk != null ? (dvc.feedIn ? 'Nein' : 'Ja') : '-',
      tone: acOk != null ? (dvc.feedIn ? 'ok' : 'off') : undefined
    }
  };
}

/**
 * Compute CSS color variable for net cost display.
 * @param {number|null} netEur
 * @returns {string} CSS variable string
 */
export function computeCostColor(netEur) {
  if (netEur == null) return 'var(--text-muted)';
  return netEur >= 0 ? 'var(--dvhub-green)' : 'var(--dvhub-red)';
}

/**
 * Format a timestamp as "DD.MM. HH:MM" German locale.
 * @param {string|number|null} ts - ISO string or epoch ms
 * @returns {string} e.g. "14.03. 14:30" or "--"
 */
export function formatTimestamp(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '--';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}.${month}. ${hours}:${minutes}`;
}
