// services/optimizer/schedule-builder.js -- Converts optimizer output to schedule rules.
// Produces rules compatible with schedule-eval.js using configurable timezone.
// Source: 'forecast_optimizer', displayTone: 'blue' (distinct from SMA's 'yellow').

/**
 * Format an epoch-ms timestamp to local 'HH:MM' string in the given timezone.
 *
 * @param {number} tsMs - Epoch milliseconds
 * @param {string} timezone - IANA timezone (e.g. 'Europe/Berlin')
 * @returns {string} 'HH:MM' in local time
 */
function formatHHMM(tsMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(tsMs));
  const hours = parts.find(p => p.type === 'hour')?.value || '00';
  const minutes = parts.find(p => p.type === 'minute')?.value || '00';
  return `${hours}:${minutes}`;
}

/**
 * Convert optimizer power slots to schedule rule objects.
 * Each rule has the same shape as SMA rules (market-automation-builder.js lines 418-431)
 * but with source='forecast_optimizer' and displayTone='blue'.
 *
 * @param {object} params
 * @param {Array<{ts: number, endTs: number, powerW: number, confidence: number}>} params.slots - Optimizer output slots
 * @param {string} [params.source='forecast_optimizer'] - Rule source identifier
 * @param {string} [params.optimizer='internal'] - Optimizer type ('internal' or 'eos')
 * @param {function} params.getCfg - Config getter for timezone lookup
 * @returns {Array<object>} Schedule rules compatible with schedule-eval.js
 */
export function buildScheduleRules({ slots, source = 'forecast_optimizer', optimizer = 'internal', getCfg }) {
  const tz = getCfg().schedule.timezone || 'Europe/Berlin';

  return slots.map((slot, index) => ({
    id: `opt-${slot.ts}-${index}`,
    enabled: true,
    target: 'gridSetpointW',
    start: formatHHMM(slot.ts, tz),
    end: formatHHMM(slot.endTs, tz),
    value: slot.powerW,
    slotTs: slot.ts,
    slotEndTs: slot.endTs,
    source,
    autoManaged: true,
    displayTone: 'blue',
    confidence: slot.confidence,
    optimizer
  }));
}

/**
 * Replace old optimizer rules with new ones.
 * Filters out rules with matching source, then prepends new rules (highest priority).
 * Atomic replacement -- never mutates the input array in-place.
 *
 * @param {Array<object>} stateScheduleRules - Current schedule rules from state
 * @param {Array<object>} newRules - New optimizer rules to insert
 * @param {string} source - Source to match for removal (e.g. 'forecast_optimizer')
 * @returns {Array<object>} Updated rules array with new rules first
 */
export function insertOptimizerRules(stateScheduleRules, newRules, source) {
  const kept = stateScheduleRules.filter(r => r.source !== source);
  return [...newRules, ...kept];
}
