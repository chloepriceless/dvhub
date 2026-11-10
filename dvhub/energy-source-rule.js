// energy-source-rule.js — Historie: welche Quelle gilt je Reihe und Viertelstunde?
//
// Regel (Christin, 05.11.2026, Entscheidung „B“): Es gilt der eigene, lokal
// gemessene Wert. Den VRM-Import nimmt DVhub nur,
//   (a) wenn für die Viertelstunde keine eigenen Werte da sind, oder
//   (b) wenn die eigenen Werte sie nicht vollständig abdecken (z. B. Neustart
//       von DVhub mitten in der Viertelstunde).
// Nie gemittelt, nie gemischt: je Reihe und Viertelstunde genau EINE Quelle,
// die Kennzeichen geschätzt/unvollständig kommen von dieser Quelle.
//
// „Vollständig“ — gemessen an der Abdeckungszeit der eigenen Rohwerte:
//
//   Jede Live-Probe trägt als resolutionSeconds die Zeit seit der vorigen
//   gespeicherten Probe (runtime-performance.js createTelemetryWriteBuffer), in
//   ganzen Sekunden mit Übertrag des Rundungsrests — die Summe folgt der echten
//   Zeit (Fable R3, P2-1: einzeln gerundet kam ein 5,3-s-Zyklus nie auf 885 s).
//   Nach einem Neustart beginnt diese Zählung neu: die erste Probe trägt nur
//   ein Abfrageintervall, die Ausfallzeit fehlt also in der Summe. Die
//   Abdeckung einer Reihe im Slot ist die Summe dieser Zeiten, je Probe
//   höchstens LOCAL_SAMPLE_MAX_CREDIT_SECONDS (= Lückengrenze 90 s: größtes
//   einstellbares Abfrageintervall, config-model meterPollMs max 60 000, plus
//   Abfragedauer) — eine Probe nach einem minutenlangen Hänger deckt die Lücke
//   davor nicht ab.
//
//   Die Proben landen ganz im Slot ihres Zeitstempels (sampleEnergyBySlot), am
//   Slotrand verschiebt sich daher bis zu ein Probenabstand in den Nachbarslot.
//   Vollständig heißt deshalb: Abdeckung ≥ Slotlänge − Toleranz, Toleranz =
//   max(15 s, 1,5 × mittlerer Probenabstand im Slot). Bei 5-s-Proben erkennt
//   das jeden Ausfall ab ~15 s, bei 60-s-Abfragen ab ~90 s.
//
//   Zwei Ausschlüsse (Codex 633d1caf):
//   - Proben aus einer fehlgeschlagenen oder veralteten Abfrage (polling.js
//     behält dann die alten Werte) tragen meta.stale (telemetry-runtime.js
//     liveSnapshotStale) und zählen 0 s.
//   - Eine Probe über 90 s (größtes Abfrageintervall 60 s plus Abfragedauer,
//     Codex 26452e9b) trägt ihre ganze Dauer als Energie in den Slot
//     (sampleEnergyBySlot), die Energie wäre also hochgerechnet: ein Slot mit
//     so einer Probe gilt nie als vollständig.
//
//   Gespeichert wird die Abdeckung je (Slot, Reihe) in energy_slots_15m.meta_json
//   der Quelle local_live: {"coverageS": Σ Sekunden, "samples": Anzahl Proben,
//   "maxResS": längste Probe}.
//   Ältere Slots (vor 1.0.10) tragen keine Abdeckung. Für sie ist unbekannt, ob
//   sie vollständig sind — sie behalten die bisherige Reihenfolge (VRM vor
//   lokal), damit sich gespeicherte Historie nicht nachträglich verschiebt.

export const SLOT_SECONDS = 900;
export const LOCAL_COVERAGE_MIN_TOLERANCE_SECONDS = 15;
export const LOCAL_COVERAGE_SPACING_FACTOR = 1.5;
// Längste Probe, die noch keine Lücke ist (60-s-Abfrage + Abfragedauer).
export const LOCAL_SAMPLE_MAX_GAP_SECONDS = 90;
// Eine Probe bis zur Lückengrenze zählt mit ihrer ganzen Dauer (Codex 607fa4b2:
// mit 60 s gekappt deckten lückenlose 70-s-Zyklen den Slot nie ab).
export const LOCAL_SAMPLE_MAX_CREDIT_SECONDS = LOCAL_SAMPLE_MAX_GAP_SECONDS;

export const LOCAL_SOURCE_KIND = 'local_live';
export const VRM_SOURCE_KIND = 'vrm_import';
// Rohdaten (timeseries_samples): VRM-Import landet mit scope 'history'.
export const VRM_RAW_SCOPE = 'history';

// Hauptflüsse der Anlage: kommt eine davon im Slot aus dem VRM-Import, gelten
// die lokalen Akku-2-Reihen des Slots nicht (VRM kennt die zweite Anlage nicht,
// Codex-Gegenprüfung 21.10.2026). Gemeinsam für Speicher und Diagramme.
export const PRIMARY_FLOW_SERIES = Object.freeze([
  'grid_import_w', 'grid_export_w', 'pv_total_w', 'load_power_w',
  'battery_power_w', 'battery_charge_w', 'battery_discharge_w',
  'solar_direct_use_w', 'solar_to_battery_w', 'solar_to_grid_w',
  'grid_direct_use_w', 'grid_to_battery_w', 'battery_direct_use_w', 'battery_to_grid_w'
]);

/** Sekunden, die eine Live-Probe zur Abdeckung ihres Slots beiträgt (veraltet: 0). */
export function localSampleCreditSeconds(resolutionSeconds, slotSeconds = SLOT_SECONDS, { stale = false } = {}) {
  if (stale) return 0;
  const seconds = Number(resolutionSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, LOCAL_SAMPLE_MAX_CREDIT_SECONDS, slotSeconds);
}

/**
 * Deckt die Abdeckung den Slot vollständig ab? Unbekannt (null/NaN) ⇒ false.
 * @param {number|null} coverageS  Summe der Probenzeiten im Slot
 * @param {number|null} samples    Anzahl Proben (fehlt ⇒ Mindesttoleranz)
 * @param {number|null} maxResS    längste Probe im Slot (über 90 s ⇒ nie vollständig)
 */
export function isLocalCoverageComplete(coverageS, samples, slotSeconds = SLOT_SECONDS, maxResS = null) {
  if (coverageS == null) return false;
  if (Number(maxResS) > LOCAL_SAMPLE_MAX_GAP_SECONDS) return false;
  const coverage = Number(coverageS);
  if (!Number.isFinite(coverage) || coverage <= 0) return false;
  const count = Number(samples);
  const spacing = Number.isFinite(count) && count > 0 ? coverage / count : 0;
  const tolerance = Math.max(LOCAL_COVERAGE_MIN_TOLERANCE_SECONDS, LOCAL_COVERAGE_SPACING_FACTOR * spacing);
  return coverage >= slotSeconds - tolerance;
}

function parseMeta(meta) {
  if (!meta) return null;
  if (typeof meta === 'object') return meta;
  try { return JSON.parse(meta); } catch { return null; }
}

/** Abdeckung aus meta_json (Text oder Objekt); null, wenn keine gespeichert ist. */
export function localCoverageFromMeta(meta) {
  const parsed = parseMeta(meta);
  if (!parsed || parsed.coverageS == null) return null;
  const coverageS = Number(parsed.coverageS);
  if (!Number.isFinite(coverageS)) return null;
  const samples = Number(parsed.samples);
  const maxResS = Number(parsed.maxResS);
  return { coverageS, samples: Number.isFinite(samples) ? samples : null, maxResS: Number.isFinite(maxResS) ? maxResS : null };
}

/** Ist eine Rohprobe als veraltet gekennzeichnet (meta_json.stale)? */
export function isStaleSampleMeta(meta) {
  return parseMeta(meta)?.stale === true;
}

/** Ist eine energy_slots_15m-Zeile ein vollständig abgedeckter eigener Wert? */
export function isCompleteLocalSlotRow(row) {
  if (!row || row.source_kind !== LOCAL_SOURCE_KIND) return false;
  const coverage = localCoverageFromMeta(row.meta_json);
  return Boolean(coverage) && isLocalCoverageComplete(coverage.coverageS, coverage.samples, SLOT_SECONDS, coverage.maxResS);
}

/**
 * Zeile einer Reihe im Slot wählen. bySource: Map source_kind → Zeile.
 * Vollständiger eigener Wert zuerst, sonst die übergebene Reihenfolge
 * (Standard: VRM-Import, dann eigene Werte), sonst die erste vorhandene.
 */
export function pickSlotSourceRow(bySource, preferredSourceKinds) {
  if (!bySource || bySource.size === 0) return null;
  const local = bySource.get(LOCAL_SOURCE_KIND);
  if (local && preferredSourceKinds.includes(LOCAL_SOURCE_KIND) && isCompleteLocalSlotRow(local)) return local;
  for (const kind of preferredSourceKinds) {
    const row = bySource.get(kind);
    if (row) return row;
  }
  return [...bySource.values()][0] || null;
}

/**
 * PostgreSQL-Ausdruck: true, wenn metaExpr (TEXT-Spalte meta_json einer
 * local_live-Zeile) eine vollständige Abdeckung trägt. Gleiche Rechnung wie
 * isLocalCoverageComplete; GREATEST übergeht NULL (fehlende Probenzahl).
 */
export function localCoverageCompleteSql(metaExpr = 'meta_json') {
  const cov = `((${metaExpr})::jsonb ->> 'coverageS')::float8`;
  const n = `((${metaExpr})::jsonb ->> 'samples')::float8`;
  const maxRes = `((${metaExpr})::jsonb ->> 'maxResS')::float8`;
  return `COALESCE(${cov} > 0 AND COALESCE(${maxRes}, 0) <= ${LOCAL_SAMPLE_MAX_GAP_SECONDS} AND ${cov} >= ${SLOT_SECONDS} - GREATEST(${LOCAL_COVERAGE_MIN_TOLERANCE_SECONDS}, ${LOCAL_COVERAGE_SPACING_FACTOR} * ${cov} / NULLIF(${n}, 0)), false)`;
}

/**
 * PostgreSQL-Rang je Zeile (kleiner = bevorzugt) für DISTINCT ON / ROW_NUMBER:
 * vollständiger eigener Wert, VRM-Import, unvollständiger/alter eigener Wert, Rest.
 */
export function slotSourceRankSql({ kindExpr = 'source_kind', metaExpr = 'meta_json' } = {}) {
  return `CASE WHEN ${kindExpr} = '${LOCAL_SOURCE_KIND}' AND ${localCoverageCompleteSql(metaExpr)} THEN 0`
    + ` WHEN ${kindExpr} = '${VRM_SOURCE_KIND}' THEN 1`
    + ` WHEN ${kindExpr} = '${LOCAL_SOURCE_KIND}' THEN 2 ELSE 3 END`;
}

/**
 * Rohdaten-Ausweichpfad: Einträge EINER Reihe in EINEM Bucket
 * ({ scope, resolution_seconds, ... }) → die Einträge der gewählten Quelle.
 * Eigene Werte (alles außer scope 'history'), wenn sie den Bucket abdecken;
 * sonst der VRM-Import, falls vorhanden; sonst die eigenen Werte.
 */
export function chooseRawEntries(entries = [], bucketSeconds = SLOT_SECONDS) {
  const list = Array.isArray(entries) ? entries : [];
  const vrm = list.filter((entry) => entry.scope === VRM_RAW_SCOPE);
  if (!vrm.length) return list;
  const local = list.filter((entry) => entry.scope !== VRM_RAW_SCOPE);
  if (!local.length) return vrm;
  const coverageS = local.reduce((sum, entry) => sum + localSampleCreditSeconds(entry.resolution_seconds, bucketSeconds, { stale: isStaleSampleMeta(entry.meta_json) }), 0);
  const maxResS = local.reduce((max, entry) => Math.max(max, Number(entry.resolution_seconds) || 0), 0);
  return isLocalCoverageComplete(coverageS, local.length, bucketSeconds, maxResS) ? local : vrm;
}
