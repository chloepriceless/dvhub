// services/optimizer-plan.js -- der Optimizer-/EOS-Plan als Slot-Liste für
// Integrationen (2026-09-14, Christin: "kannst du den EOS Plan auch ausgeben
// nach Home Assistant?").
//
// Quelle ist NICHT die EOS-Lösung selbst, sondern die daraus erzeugten
// Zeitplan-Regeln (state.schedule.rules, autoManaged) — also genau das, was
// DVhub ausführen wird, unabhängig davon, ob EOS, der interne Optimizer oder
// die Kleinmarkt-Automation sie erzeugt hat. Jeder Slot: von … bis … →
// Ziel/Wert/Aktion. `devices` ist reserviert für Geräte-Slots (EOS flexible
// consumers: Geschirrspüler, Heizstab, Wallbox mit An/Aus), sobald der
// Adapter sie liefert — gleicher Kanal, gleiche Form.

import { resolveControlOrigin } from './control-snapshot.js';

const PLAN_RULE_SOURCES = new Set(['forecast_optimizer', 'small_market_automation']);

function isPlanRule(rule) {
  if (!rule || rule.enabled === false) return false;
  if (!Number.isFinite(Number(rule.slotTs)) || !Number.isFinite(Number(rule.slotEndTs))) return false;
  return rule.autoManaged === true || PLAN_RULE_SOURCES.has(rule.source);
}

/** Aktion für Menschen/Automationen aus Ziel + Wert. */
export function planAction(rule) {
  if (rule.target === 'dcExportMode') return Number(rule.value) ? 'export_surplus' : 'hold';
  if (rule.target === 'gridSetpointW') {
    const v = Number(rule.value);
    if (!Number.isFinite(v) || v === 0) return 'hold';
    return v < 0 ? 'export' : 'import';
  }
  return 'set';
}

function toSlot(rule, rules) {
  const slot = {
    start: new Date(Number(rule.slotTs)).toISOString(),
    end: new Date(Number(rule.slotEndTs)).toISOString(),
    target: rule.target || null,
    value: Number.isFinite(Number(rule.value)) ? Number(rule.value) : null,
    action: planAction(rule),
    source: resolveControlOrigin(`rule:${rule.id}`, rules),
    rule: rule.id != null ? String(rule.id) : null
  };
  if (Number(rule.chargeReserveW) > 0) slot.chargeReserveW = Math.round(Number(rule.chargeReserveW));
  if (Number.isFinite(Number(rule.targetSocPct))) slot.targetSocPct = Number(rule.targetSocPct);
  if (Number.isFinite(Number(rule.confidence))) slot.confidence = Number(rule.confidence);
  return slot;
}

/**
 * Aufeinanderfolgende Slots mit gleichem Befehl (Ziel, Wert, Aktion, Quelle,
 * Ladereserve) zu Bereichen "von … bis …" zusammenfassen. Lücken und Wechsel
 * trennen. Ohne Regel-IDs — das ist die kompakte Form für HA-Attribute
 * (16-KB-Grenze; 96 Einzel-Slots mit realistischen IDs liegen darüber) und
 * die Form, die ein Mensch liest ("16:00–18:30 einspeisen 4 kW").
 */
export function mergeRanges(slots, planSource = null) {
  const ranges = [];
  for (const s of slots) {
    const prev = ranges[ranges.length - 1];
    const sameCommand = prev && prev.end === s.start && prev._target === s.target && prev.value === s.value
      && prev.action === s.action && prev._source === s.source && (prev.chargeReserveW ?? null) === (s.chargeReserveW ?? null);
    if (sameCommand) {
      prev.end = s.end;
      prev.slots++;
      continue;
    }
    // Kompakt: target steckt in action (export_surplus = dcExportMode), source
    // nur, wenn sie vom Plan-Ganzen abweicht. 96 wechselnde Bereiche ≈ 11 KB.
    const r = { start: s.start, end: s.end, action: s.action, value: s.value, slots: 1 };
    if (s.chargeReserveW != null) r.chargeReserveW = s.chargeReserveW;
    if (s.source && s.source !== planSource) r.source = s.source;
    Object.defineProperty(r, '_target', { value: s.target, enumerable: false });
    Object.defineProperty(r, '_source', { value: s.source, enumerable: false });
    ranges.push(r);
  }
  return ranges;
}

/**
 * @param {object} state  server state (schedule.rules, optimizer)
 * @param {number} [nowMs]
 * @returns {{ plan: object, ranges: object[], current: object|null, next: object|null }}
 */
export function buildOptimizerPlan(state, nowMs = Date.now()) {
  const rules = Array.isArray(state?.schedule?.rules) ? state.schedule.rules : [];
  const opt = state?.optimizer || {};
  const slots = rules
    .filter(isPlanRule)
    .filter(r => Number(r.slotEndTs) > nowMs)            // abgelaufene raus, laufende bleiben
    .sort((a, b) => Number(a.slotTs) - Number(b.slotTs))
    .map(r => toSlot(r, rules));
  let slotMinutes = null;
  if (slots.length) {
    const d = Number(rules.find(isPlanRule)?.slotEndTs) - Number(rules.find(isPlanRule)?.slotTs);
    slotMinutes = Number.isFinite(d) && d > 0 ? Math.round(d / 60000) : null;
  }
  const ranges = mergeRanges(slots, opt.source || null);
  const current = slots.find(s => new Date(s.start).getTime() <= nowMs && new Date(s.end).getTime() > nowMs) || null;
  const upcoming = slots.find(s => new Date(s.start).getTime() > nowMs) || null;
  const next = upcoming ? { ...upcoming, startsInMin: Math.round((new Date(upcoming.start).getTime() - nowMs) / 60000) } : null;
  const plan = {
    source: opt.source || null,
    generatedAt: opt.lastRunAt || null,
    slotMinutes,
    validFrom: slots.length ? slots[0].start : null,
    validUntil: slots.length ? slots[slots.length - 1].end : null,
    slotCount: slots.length,
    rangeCount: ranges.length,
    slots,
    // Planbare Verbraucher (2026-09-26): der Geräte-Dispatch, den die
    // eos-device-bridge in state.optimizer.devicePlan ablegt (deferrable Fenster
    // aus dem EOS-home_appliance-Dispatch + modulierender Ist-Sollwert). Form je
    // Slot: { device, kind, start, end, action:'on', ... } bzw. der laufende
    // Leistungs-Sollwert modulierender Geräte.
    devices: Array.isArray(opt.devicePlan) ? opt.devicePlan : []
  };
  return { plan, ranges, current, next };
}
