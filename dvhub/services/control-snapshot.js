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
    source: lead,
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
