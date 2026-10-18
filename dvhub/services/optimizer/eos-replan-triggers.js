// services/optimizer/eos-replan-triggers.js — wann EOS zwischen zwei Takten neu
// rechnet (2026-10-18).
//
// Für schwache Geräte (SPiNE EnergyLink: 2 Kerne) läuft EOS nur alle 1–2 h
// (optimizer.eosEmsIntervalSec). Damit der Plan trotzdem stimmt, rechnet es
// außer der Reihe, sobald sich etwas ändert. Schon vorher vorhanden
// (requestEosReplan): Auto an/ab, Auto-Einstellungen, Geräte, plan-relevante
// Einstellungen. Hier dazu:
//   - neue Day-Ahead-Preise (epex-fetch.js, nach dem Prognose-Push)
//   - Ladestand weicht deutlich vom Plan ab (Wolken, falsche Last-Prognose)
// Beides nur bei seltenem Takt — mit 15 min rechnet EOS ohnehin bald neu.

export const SOC_DRIFT_THRESHOLD_PCT = 10;
// Ein frischer Plan beginnt beim echten Ladestand; erst danach kann er weglaufen.
export const SOC_DRIFT_MIN_PLAN_AGE_MS = 15 * 60_000;

/** Takt über 15 min? Dann lohnen Läufe außer der Reihe. */
export function sparseEosCadence(intervalSec) {
  return Number(intervalSec) > 900;
}

/** Ladestand laut Plan zum Zeitpunkt nowMs, linear zwischen zwei Slots. */
export function expectedSocPctAt(rows, nowMs) {
  if (!Array.isArray(rows)) return null;
  for (let i = 0; i < rows.length - 1; i += 1) {
    const a = Date.parse(rows[i]?.ts_utc);
    const b = Date.parse(rows[i + 1]?.ts_utc);
    if (!(nowMs >= a && nowMs < b)) continue;
    const sa = rows[i].socPct;
    const sb = rows[i + 1].socPct;
    if (!Number.isFinite(sa) || !Number.isFinite(sb)) return null;
    return Math.round((sa + ((sb - sa) * (nowMs - a)) / (b - a)) * 10) / 10;
  }
  return null;
}

/**
 * Soll EOS wegen eines davongelaufenen Ladestands neu rechnen?
 * @returns {{ replan: boolean, expectedPct: number|null, livePct: number|null, deltaPct: number|null }}
 */
export function socDriftReplan({
  solution, liveSocPct, nowMs, intervalSec,
  thresholdPct = SOC_DRIFT_THRESHOLD_PCT, minPlanAgeMs = SOC_DRIFT_MIN_PLAN_AGE_MS,
}) {
  const none = { replan: false, expectedPct: null, livePct: null, deltaPct: null };
  if (!sparseEosCadence(intervalSec) || !solution || !Number.isFinite(liveSocPct)) return none;
  const generatedMs = Date.parse(solution.generatedAt);
  if (!Number.isFinite(generatedMs) || nowMs - generatedMs < minPlanAgeMs) return none;
  const expectedPct = expectedSocPctAt(solution.rows, nowMs);
  if (expectedPct == null) return none;
  const deltaPct = Math.round((liveSocPct - expectedPct) * 10) / 10;
  return { replan: Math.abs(deltaPct) >= thresholdPct, expectedPct, livePct: liveSocPct, deltaPct };
}
