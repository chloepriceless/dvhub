// services/release-backoff.js — Wiederholung gescheiterter Freigaben (M14 Teil 2, Sungrow-Feldtest 6a4e10d3).
//
// Eine echt gescheiterte FREIGABE wird nicht endlos im Takt gehämmert: nach RELEASE_BACKOFF_AFTER Fehlschlägen in
// Folge nur noch alle RELEASE_BACKOFF_MS versuchen. Keine Obergrenze für die Zahl der Versuche — eine Freigabe gibt
// DVhub nie auf. Ein ausdrücklicher Bedienbefehl umgeht das Backoff-Fenster.
//
// Genutzt von:
//   • der Einspeise-Freigabe nach Abregelung (schedule-eval.js applyDvVictronControl, DV/§51/Feldtest-Knopf),
//   • der manuellen Sungrow-Freigabe (services/inverter/sungrow.js forceRelease, Option A Christin 19.11.2026).

export const RELEASE_BACKOFF_AFTER = 3;
export const RELEASE_BACKOFF_MS = 5 * 60_000;

/** Nächster frühester Versuch nach `fails` Fehlschlägen in Folge (0 = sofort im nächsten Takt). */
export function releaseBackoffNextAt(fails, nowMs) {
  return fails >= RELEASE_BACKOFF_AFTER ? nowMs + RELEASE_BACKOFF_MS : 0;
}
