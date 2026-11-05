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
//   gespeicherten Probe (runtime-performance.js createTelemetryWriteBuffer).
//   Nach einem Neustart beginnt diese Zählung neu: die erste Probe trägt nur
//   ein Abfrageintervall, die Ausfallzeit fehlt also in der Summe. Die
//   Abdeckung einer Reihe im Slot ist die Summe dieser Zeiten, je Probe
//   höchstens LOCAL_SAMPLE_MAX_CREDIT_SECONDS (das größte einstellbare
//   Abfrageintervall, config-model meterPollMs max 60 000) — eine Probe nach
//   einem minutenlangen Hänger deckt die Lücke davor nicht ab.
//
//   Die Proben landen ganz im Slot ihres Zeitstempels (sampleEnergyBySlot), am
//   Slotrand verschiebt sich daher bis zu ein Probenabstand in den Nachbarslot.
//   Vollständig heißt deshalb: Abdeckung ≥ Slotlänge − Toleranz, Toleranz =
//   max(15 s, 1,5 × mittlerer Probenabstand im Slot). Bei 5-s-Proben erkennt
//   das jeden Ausfall ab ~15 s, bei 60-s-Abfragen ab ~90 s.
//
//   Gespeichert wird die Abdeckung je (Slot, Reihe) in energy_slots_15m.meta_json
//   der Quelle local_live: {"coverageS": Σ Sekunden, "samples": Anzahl Proben}.
//   Ältere Slots (vor 1.0.10) tragen keine Abdeckung. Für sie ist unbekannt, ob
//   sie vollständig sind — sie behalten die bisherige Reihenfolge (VRM vor
//   lokal), damit sich gespeicherte Historie nicht nachträglich verschiebt.

export const SLOT_SECONDS = 900;
export const LOCAL_SAMPLE_MAX_CREDIT_SECONDS = 60;
export const LOCAL_COVERAGE_MIN_TOLERANCE_SECONDS = 15;
export const LOCAL_COVERAGE_SPACING_FACTOR = 1.5;

export const LOCAL_SOURCE_KIND = 'local_live';
export const VRM_SOURCE_KIND = 'vrm_import';
// Rohdaten (timeseries_samples): VRM-Import landet mit scope 'history'.
export const VRM_RAW_SCOPE = 'history';

/** Sekunden, die eine Live-Probe zur Abdeckung ihres Slots beiträgt. */
export function localSampleCreditSeconds(resolutionSeconds, slotSeconds = SLOT_SECONDS) {
  const seconds = Number(resolutionSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, LOCAL_SAMPLE_MAX_CREDIT_SECONDS, slotSeconds);
}

/**
 * Deckt die Abdeckung den Slot vollständig ab? Unbekannt (null/NaN) ⇒ false.
 * @param {number|null} coverageS  Summe der Probenzeiten im Slot
 * @param {number|null} samples    Anzahl Proben (fehlt ⇒ Mindesttoleranz)
 */
export function isLocalCoverageComplete(coverageS, samples, slotSeconds = SLOT_SECONDS) {
  if (coverageS == null) return false;
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
  return { coverageS, samples: Number.isFinite(samples) ? samples : null };
}

/** Ist eine energy_slots_15m-Zeile ein vollständig abgedeckter eigener Wert? */
export function isCompleteLocalSlotRow(row) {
  if (!row || row.source_kind !== LOCAL_SOURCE_KIND) return false;
  const coverage = localCoverageFromMeta(row.meta_json);
  return Boolean(coverage) && isLocalCoverageComplete(coverage.coverageS, coverage.samples);
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
  return `COALESCE(${cov} > 0 AND ${cov} >= ${SLOT_SECONDS} - GREATEST(${LOCAL_COVERAGE_MIN_TOLERANCE_SECONDS}, ${LOCAL_COVERAGE_SPACING_FACTOR} * ${cov} / NULLIF(${n}, 0)), false)`;
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
  const coverageS = local.reduce((sum, entry) => sum + localSampleCreditSeconds(entry.resolution_seconds, bucketSeconds), 0);
  return isLocalCoverageComplete(coverageS, local.length, bucketSeconds) ? local : vrm;
}
