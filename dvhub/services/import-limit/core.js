// services/import-limit/core.js — gemeinsamer Kern aller Bezugsgrenzen.
//
// Zwei Funktionen begrenzen den Netzbezug am Anschlusspunkt:
//   - Netzanschluss (services/grid-connection): physikalische Grenze des
//     Hausanschlusses (Sicherungen), stabil, für alle Anlagen.
//   - Peak Shaving (services/peak-shaving, Beta): Gewerbe-Leistungspreis (RLM).
// §14a (services/paragraph14a) teilt zusätzlich die Vorgabe des Netzbetreibers
// auf die Geräte auf. Alle drei nutzen dieselben Bausteine:
//
//   meterImport()          Netzbezug gesamt und je Phase aus state.meter,
//                          mit Frische — Bezug positiv, egal wie der Zähler zählt.
//   capPositiveSetpoint()  Deckel auf einen POSITIVEN Netz-Sollwert (Victron:
//                          gewünschter Bezug am Zähler). Senkt nur, nie unter 0,
//                          nie in Richtung Einspeisung.
//   smallestLimit()        „kleinste gilt“ über mehrere Quellen (auch der
//                          Einspeise-Begrenzer services/feed-in-limit-arbiter.js).
//   mergeDeviceCaps()      dasselbe je Gerät (id → W, null = frei).

/** Nennspannung je Phase für A ↔ W (Niederspannung, 230 V). */
export const NOMINAL_PHASE_VOLTAGE_V = 230;

const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/**
 * Kleinste gültige Grenze aus einer Liste bzw. den Werten einer Map/eines
 * Objekts; null, wenn keine Quelle begrenzt.
 * @param {Iterable<number|null>|Record<string, number|null>} values
 */
export function smallestLimit(values) {
  const list = values == null ? []
    : typeof values[Symbol.iterator] === 'function' ? values : Object.values(values);
  let min = null;
  for (const w of list) {
    if (!finite(w)) continue;
    const n = Number(w);
    if (min === null || n < min) min = n;
  }
  return min;
}

/**
 * Grenzen je Gerät zusammenführen: für jede id gilt die kleinste Grenze aller
 * Quellen; null heißt „diese Quelle begrenzt das Gerät nicht“.
 * @param {...(Record<string, number|null>|null|undefined)} sources
 * @returns {Record<string, number|null>}
 */
export function mergeDeviceCaps(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [id, w] of Object.entries(src)) {
      const prev = out[id] ?? null;
      out[id] = smallestLimit([prev, w]);
    }
  }
  return out;
}

/**
 * Netzbezug am Anschlusspunkt aus state.meter. Bezug positiv, Einspeisung
 * negativ (cfg.gridPositiveMeans legt fest, wie der Zähler zählt).
 *
 * fresh: Zähler meldet ok und der letzte Wert ist höchstens maxAgeMs alt.
 * phasesW: [L1, L2, L3] oder null, wenn der Zähler keine Phasenwerte liefert.
 *
 * @param {object} state
 * @param {object} cfg
 * @param {{ now?: number, maxAgeMs: number }} opts
 * @returns {{ fresh: boolean, reason: string|null, importW: number|null, phasesW: number[]|null, ageMs: number|null }}
 */
export function meterImport(state, cfg, { now = Date.now(), maxAgeMs }) {
  const m = state?.meter || {};
  const at = Number(m.updatedAt) || 0;
  const ageMs = at > 0 ? now - at : null;
  const sign = cfg?.gridPositiveMeans === 'grid_import' ? 1 : -1;
  const total = m.grid_total_w;
  const reason = m.ok !== true ? 'meter_error'
    : ageMs === null || ageMs > maxAgeMs ? 'meter_stale'
      : !finite(total) ? 'meter_no_value' : null;
  if (reason) return { fresh: false, reason, importW: null, phasesW: null, ageMs };
  const ph = [m.grid_l1_w, m.grid_l2_w, m.grid_l3_w];
  const phasesW = ph.every(finite) ? ph.map((w) => Number(w) * sign) : null;
  return { fresh: true, reason: null, importW: Number(total) * sign, phasesW, ageMs };
}

/**
 * Deckel auf einen positiven Netz-Sollwert. Werte bis zur Decke, Einspeisung
 * (≤ 0) und ungültige Werte bleiben unverändert; darüber wird auf die Decke
 * gesenkt, nie unter 0.
 * @returns {{ value: number|*, clamped: boolean }}
 */
export function capPositiveSetpoint(value, ceilingW) {
  const v = Number(value);
  if (!finite(value) || !finite(ceilingW) || !(v > 0) || !(v > Number(ceilingW))) {
    return { value, clamped: false };
  }
  return { value: Math.max(0, Math.round(Number(ceilingW))), clamped: true };
}
