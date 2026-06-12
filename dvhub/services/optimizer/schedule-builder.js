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

  return slots.map((slot, index) => {
    const base = {
      id: `opt-${slot.ts}-${index}`,
      enabled: true,
      start: formatHHMM(slot.ts, tz),
      end: formatHHMM(slot.endTs, tz),
      slotTs: slot.ts,
      slotEndTs: slot.endTs,
      source,
      autoManaged: true,
      displayTone: 'blue',
      confidence: slot.confidence,
      optimizer,
    };
    // T-0124b: a pure PV-surplus feed-in slot is actuated via the dcExportMode
    // lever (the "100 % Einspeisung" Zeitplan checkbox): schedule-eval drives
    // gridSetpointW = -(live PV − buffer) each cycle, so the real PV sets the
    // setpoint — no static value. value=1 = lever ON.
    if (slot.lever === 'dcExportMode') {
      return { ...base, target: 'dcExportMode', value: 1 };
    }
    return {
      ...base,
      target: 'gridSetpointW',
      value: slot.powerW,
      // T-0121 closed-loop: carry the deliberate battery→grid share B + flag so
      // schedule-eval re-derives gridSetpointW = -(B + live PV surplus) each cycle
      // and writes the reg-2704 cap. Present only on EOS battery-export slots.
      ...(slot.closedLoopExport ? { closedLoopExport: true, batteryShareW: slot.batteryShareW } : {})
    };
  });
}

/**
 * Detect optimizer-managed rules — mirror of the frontend isOptimizerRule
 * (app.js) and the SMA counterpart isSmallMarketAutomationRule
 * (market-automation-builder.js): source match OR the 'opt-' id prefix.
 *
 * @param {object} rule
 * @returns {boolean}
 */
export function isForecastOptimizerRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  return rule.source === 'forecast_optimizer'
    || (typeof rule.id === 'string' && rule.id.startsWith('opt-'));
}

/**
 * Replace old optimizer rules with new ones.
 * Filters out rules with matching source, then prepends new rules (highest priority).
 * Atomic replacement -- never mutates the input array in-place.
 *
 * Operator slot-disable (2026-06-12): an operator can disable individual
 * optimizer slots via POST /api/schedule/rules/toggle. A replan rebuilds all
 * optimizer rules from scratch, so the disable is inherited onto the new rule
 * for the SAME slot (key slotTs|target). Slots the optimizer no longer plans
 * simply drop out — the disable expires with the slot.
 *
 * @param {Array<object>} stateScheduleRules - Current schedule rules from state
 * @param {Array<object>} newRules - New optimizer rules to insert
 * @param {string} source - Source to match for removal (e.g. 'forecast_optimizer')
 * @returns {Array<object>} Updated rules array with new rules first
 */
export function insertOptimizerRules(stateScheduleRules, newRules, source) {
  const disabledSlotKeys = new Set(
    stateScheduleRules
      .filter(r => r.source === source && r.enabled === false && Number.isFinite(Number(r.slotTs)))
      .map(r => `${r.slotTs}|${r.target}`)
  );
  const inherited = disabledSlotKeys.size
    ? newRules.map(r => (disabledSlotKeys.has(`${r.slotTs}|${r.target}`) ? { ...r, enabled: false } : r))
    : newRules;
  const kept = stateScheduleRules.filter(r => r.source !== source);
  return [...inherited, ...kept];
}

/**
 * T-0118: convert OPTIMIZER battery-dispatch slots into GRID-setpoint slots, and
 * DROP self-consumption slots.
 *
 * The MILP/heuristic emit a BATTERY dispatch power per slot (powerW: + charge,
 * − discharge). Writing that straight into gridSetpointW conflated two different
 * things: "discharge X W to cover the load" (self-consumption — the inverter does
 * this natively) vs. "export X W to the grid" (a deliberate market action). A
 * −1250 self-consumption dispatch became gridSetpointW=−1250 = a forced 1.25 kW
 * grid export at night.
 *
 * The real grid setpoint is the power-balance net grid — identical to the MILP's
 * own internal net grid: grid = load − PV + powerW (import +, export −). For a
 * pure self-consumption slot the battery just covers the load−PV deficit and the
 * net grid is ≈ 0, so NO rule is emitted — the slot is left to the plant's native
 * self-consumption at the default setpoint. This also stops the small-market
 * automation from treating self-consumption slots as "occupied" and cascading its
 * real arbitrage into worse (night) slots.
 *
 * Only genuine grid actions (|grid| beyond the band) become slots; their powerW
 * is replaced by the grid setpoint so the existing buildScheduleRules converter
 * (value = slot.powerW) writes the correct value. NOTE: only feed OPTIMIZER slots
 * here — dvRules already carry grid setpoints in powerW and must NOT be re-balanced.
 *
 * @param {Array<{ts:number,endTs:number,powerW:number,confidence?:number}>} slots - optimizer battery-dispatch slots
 * @param {Array<{ts:number,endTs:number,powerW:number}>} [pvSlots] - PV forecast slots (W)
 * @param {Array<{ts:number,endTs:number,powerW:number}>} [loadSlots] - load forecast slots (W)
 * @param {number} [selfConsumptionBandW=300] - |net grid| ≤ this ⇒ self-consumption ⇒ no rule
 * @returns {Array<object>} grid-setpoint slots (self-consumption slots removed)
 */
export function optimizerSlotsToGridSetpoints(slots, pvSlots = [], loadSlots = [], selfConsumptionBandW = 300) {
  if (!Array.isArray(slots)) return [];
  const findAt = (arr, ts) => (Array.isArray(arr) ? arr.find((s) => s.ts <= ts && s.endTs > ts) : null);
  const out = [];
  for (const slot of slots) {
    if (!slot) continue;
    const batteryPowerW = Number(slot.powerW) || 0;
    const pvW = Number(findAt(pvSlots, slot.ts)?.powerW) || 0;
    const loadW = Number(findAt(loadSlots, slot.ts)?.powerW) || 0;
    const gridW = Math.round(loadW - pvW + batteryPowerW);
    // Self-consumption / no meaningful grid flow → leave the slot UNSET so the
    // plant self-regulates (default setpoint). Only deliberate export/charge
    // become rules.
    if (Math.abs(gridW) <= selfConsumptionBandW) continue;
    out.push({ ...slot, powerW: gridW });
  }
  return out;
}
