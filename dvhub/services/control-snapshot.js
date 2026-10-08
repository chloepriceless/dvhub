// services/control-snapshot.js -- gemeinsame Sicht auf die aktiven
// Steuerbefehle für Integrationen (2026-09-14).
//
// Anlass (Christin): "Steuerbefehle des EOS transparent über MQTT weitergeben,
// sodass ein User seinen Home-Assistant-Akku daran anschließen kann; das
// gleiche für Loxone." DVhub schreibt seine Sollwerte über Modbus oder die
// MQTT-Bridge an die Anlage — hier wird derselbe Zustand nur GESPIEGELT:
//   - services/mqtt/publisher.js → <prefix>/control/* (retained)
//   - routes-api.js integrationState() → dvhub_control_* (Loxone-Textzeilen)
//
// Generische Ziele sind gridSetpointW, chargeCurrentA, minSocPct,
// maxDischargeW. feedExcessDcPv / dontFeedExcessAcPv sind Victron-Register
// (Überschuss-DC-Einspeisung, PreventFeedback) und gehören nicht ins
// herstellerneutrale Schema.
//
// Wert-Auflösung je Ziel: zuerst der zuletzt GEWOLLTE Wert aus
// state.schedule.active (auch ein gehaltener/skipped Wert ist der aktive
// Sollwert), sonst die Rücklesung aus state.victron, sonst null — nie 0
// erfinden, ein Abnehmer soll "unbekannt" von "0 W" unterscheiden können.

export const CONTROL_KEYS = Object.freeze(['gridSetpointW', 'chargeCurrentA', 'minSocPct', 'maxDischargeW']);

/** Topic-Suffix je Ziel (unter mqtt.topicPrefix, Default 'dvhub'). */
export const CONTROL_TOPIC_SUFFIX = Object.freeze({
  gridSetpointW: 'control/grid_setpoint_w',
  chargeCurrentA: 'control/charge_current_a',
  minSocPct: 'control/min_soc_pct',
  maxDischargeW: 'control/max_discharge_w'
});

/** Flacher Feldname je Ziel (Loxone Virtual HTTP Input, D-18 namespaced). */
export const CONTROL_FLAT_KEY = Object.freeze({
  gridSetpointW: 'dvhub_control_grid_setpoint_w',
  chargeCurrentA: 'dvhub_control_charge_current_a',
  minSocPct: 'dvhub_control_min_soc_pct',
  maxDischargeW: 'dvhub_control_max_discharge_w'
});

function numOrNull(v) {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : n;
}

/**
 * Rohquelle des Steuerpfads → Herkunft für Menschen und Automationen.
 * schedule-eval liefert `rule:<id>`, `default`, `runtime`, `manual_override*`,
 * `none`. Für Regeln entscheidet die Regel selbst: EOS-Plan (optimizer 'eos'),
 * interner Prognose-Optimizer, Kleinmarkt-Automation (sma-…), sonst eine
 * manuelle Zeitplan-Regel. Christin 2026-09-14: "sollte die Optimizer-Quelle
 * nicht auf EOS lauten?" — ja.
 */
export function resolveControlOrigin(source, rules) {
  if (!source || source === 'none') return 'none';
  if (source === 'default' || source === 'runtime') return source;
  if (String(source).startsWith('manual_override')) return 'override';
  if (String(source).startsWith('rule:')) {
    const id = source.slice(5);
    const rule = Array.isArray(rules) ? rules.find(r => r && String(r.id) === id) : null;
    if (rule) {
      if (rule.optimizer === 'eos') return 'eos';
      if (rule.source === 'forecast_optimizer' || rule.optimizer === 'internal') return 'optimizer';
      if (rule.source === 'small_market_automation') return 'market_automation';
      return 'rule';
    }
    if (id.startsWith('opt-')) return 'optimizer';
    if (id.startsWith('sma-')) return 'market_automation';
    return 'rule';
  }
  return String(source);
}

/**
 * @param {object} state  server state (schedule.active, victron, ctrl)
 * @param {number} [nowMs]
 */
export function buildControlSnapshot(state, nowMs = Date.now()) {
  const active = state?.schedule?.active || {};
  const readback = state?.victron || {};
  const values = {};
  let updatedAtMs = 0;
  for (const key of CONTROL_KEYS) {
    const a = active[key];
    if (a && a.value != null && Number.isFinite(Number(a.value))) {
      values[key] = { value: Number(a.value), source: a.source || null, at: Number(a.at) || null, origin: 'active' };
      if (Number(a.at) > updatedAtMs) updatedAtMs = Number(a.at);
    } else if (readback[key] != null && Number.isFinite(Number(readback[key]))) {
      values[key] = { value: numOrNull(readback[key]), source: null, at: null, origin: 'readback' };
    } else {
      values[key] = { value: null, source: null, at: null, origin: null };
    }
  }
  // Quelle/Regel: der Netz-Sollwert ist das Leitziel (Regeln, EOS-Plan, Default).
  const lead = values.gridSetpointW.source
    || CONTROL_KEYS.map(k => values[k].source).find(Boolean)
    || 'none';
  const rule = typeof lead === 'string' && lead.startsWith('rule:') ? lead.slice(5) : null;
  return {
    values,
    // Herkunft (eos | optimizer | market_automation | rule | override | default | runtime | none);
    // die Rohquelle je Ziel steht in values[key].source.
    source: resolveControlOrigin(lead, state?.schedule?.rules),
    sourceRaw: lead,
    rule,
    updatedAtMs: updatedAtMs || null,
    updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
    paused: !!state?.ctrl?.discretionaryWritesPaused,
    forcedOff: !!state?.ctrl?.forcedOff,
    generatedAt: nowMs
  };
}

/** Flache Felder für Loxone (key=value je Zeile). */
export function controlSnapshotFlat(snapshot) {
  const flat = {};
  for (const key of CONTROL_KEYS) flat[CONTROL_FLAT_KEY[key]] = snapshot.values[key]?.value ?? null;
  flat.dvhub_control_source = snapshot.source;
  flat.dvhub_control_rule = snapshot.rule;
  flat.dvhub_control_updated_at = snapshot.updatedAt;
  flat.dvhub_control_paused = snapshot.paused;
  return flat;
}

// --- Netzbetreiber-Grenzen (§14a / EEBUS) ------------------------------------
//
// 2026-10-08 (Christin): die Grenzen der Steuerbox wirkten nur auf Speicher,
// Wallbox und Einspeisebegrenzer und waren sonst nur über die API zu lesen.
// Ein Gerät ohne EEBUS (Wärmepumpe über Home Assistant, Loxone-Logik) konnte
// ihnen nicht folgen. Hier derselbe Zustand als Spiegel für MQTT und Loxone.
//
// Bezug: state.p14a (Quelle „eebus" oder „relay", Aufteilung je Gerät).
// Einspeisung: state.eebus.applied (Grenze oder Sperre ohne Begrenzer).

/** Topic-Suffixe unter mqtt.topicPrefix. */
export const GRID_LIMIT_TOPIC = Object.freeze({
  active: 'control/grid_limit/active',
  source: 'control/grid_limit/source',
  consumptionW: 'control/grid_limit/consumption_w',
  productionW: 'control/grid_limit/production_w',
  productionBlocked: 'control/grid_limit/production_blocked',
  state: 'control/grid_limit/state'
});

/**
 * @param {object} state  server state (p14a, eebus)
 * @returns {{ active:boolean, source:string, consumptionW:number|null,
 *   productionW:number|null, productionBlocked:boolean, belowMinimum:boolean,
 *   budgetW:number|null, shares:object }}
 */
export function buildGridLimitSnapshot(state) {
  const p = state?.p14a || {};
  const applied = state?.eebus?.applied || {};
  const consumptionActive = p.active === true && numOrNull(p.limitW) != null;
  const productionW = numOrNull(applied.productionLimitW);
  const productionBlocked = applied.productionBlock === true;
  const shares = {};
  for (const [id, w] of Object.entries(p.shares || {})) {
    if (numOrNull(w) != null) shares[id] = Number(w);
  }
  let source = 'none';
  if (consumptionActive) source = p.source || 'unknown';
  else if (productionW != null || productionBlocked) source = 'eebus';
  return {
    active: consumptionActive || productionW != null || productionBlocked,
    source,
    // null = keine Grenze. Nie 0 erfinden: 0 W hieße „nichts beziehen".
    consumptionW: consumptionActive ? Number(p.limitW) : null,
    productionW,
    productionBlocked,
    belowMinimum: consumptionActive && p.belowPmin === true,
    budgetW: consumptionActive ? numOrNull(p.budgetW) : null,
    shares: consumptionActive ? shares : {}
  };
}

/** Flache Felder für Loxone (key=value je Zeile). */
export function gridLimitSnapshotFlat(snapshot) {
  return {
    dvhub_control_grid_limit_active: snapshot.active,
    dvhub_control_grid_limit_source: snapshot.source,
    dvhub_control_grid_limit_consumption_w: snapshot.consumptionW,
    dvhub_control_grid_limit_production_w: snapshot.productionW,
    dvhub_control_grid_limit_production_blocked: snapshot.productionBlocked
  };
}
