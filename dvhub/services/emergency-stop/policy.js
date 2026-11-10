// services/emergency-stop/policy.js — was DVhub im Not-Halt noch schreiben darf.
//
// Regel (Christin 06./07.11.2026, ergänzt 10.11.2026): Not-Halt heißt „als ob
// die Kiste aus ist“ — DVhub hört mit allen Steuerungen auf, Lesen, Werte und
// Logging laufen weiter. Beim Eintritt nimmt DVhub jede EIGENE Vorgabe genau
// einmal zurück (nur, wo DVhub gerade selbst aktiv vorgibt; im Zweifel nichts
// senden), danach schreibt es nichts mehr — kein Nachführen, kein Herzschlag,
// kein Wiederholen. Auch § 14a (EEBUS-Grenzen an Geräte) ist ausgesetzt.
//
// Entscheidung Christin 10.11.2026: „Ja, Not-Halt heißt auch die Punkte von
// §51 usw.“ — auch die rechtlichen bzw. Schutz-Abregelungen (§ 51 bei negativem
// Preis, Direktvermarkter-Abregelung, Einspeisegrenze der Steuerbox, feste
// Einspeisegrenze als Regelschleife, Sicherheits-Nullung am SoC-Boden)
// schreiben im Not-Halt NICHT weiter. Eine von DVhub gesetzte Abregelung wird
// beim Eintritt einmal aufgehoben (nur, wenn DVhub sie nachweislich selbst
// gesetzt hat), danach ist der Betreiber selbst verantwortlich — der Leitstand
// zeigt, was ausgesetzt ist (notHaltSuspendedLabels).
//
// Jede Klasse lässt sich unten einzeln wieder einschalten (true = schreibt im
// Not-Halt weiter wie bis 1.0.9); dann gilt für sie der alte Weg.

// Ein zentrales Modul, damit jeder Schreibpfad (schedule-eval, Begrenzer 2706,
// EEBUS, zweite GX, Wallbox-Lebenszeichen) dieselbe Antwort bekommt.

/**
 * true = schreibt im Not-Halt weiter (Stand bis 1.0.9), false = als ob aus
 * (Stand 1.0.10, Christin 10.11.2026).
 *   negativePrice          § 51 EEG: Abregelung/Sollwert bei negativem Preis
 *                          (Quelle negative_price_protection, PV-Sperre, Nulleinspeise-Deckel)
 *   dvCurtailment          Direktvermarkter: Abregelung forcedOff (Modbus-Schnittstelle,
 *                          LUOX 0 %) und Teilvorgabe auf den Begrenzer 2706 (Quelle 'dv')
 *   gridOperatorProduction Einspeisegrenze der Steuerbox (EEBUS LPP, § 9 EEG):
 *                          Begrenzer 2706 (Quelle 'eebus_lpp') bzw. PV-Sperre ohne Begrenzer
 *   feedInCapLoop          feste Einspeisegrenze (60/70 %) als Regelschleife an SunSpec-
 *                          Wechselrichtern (WMaxLimPct alle 5 s); der Victron-Wert 2706
 *                          liegt im GX gespeichert und braucht im Not-Halt keinen Write
 *   socFloor               Sicherheits-Nullung am SoC-Boden (Quelle manual_override_soc_floor)
 */
export const NOT_HALT_CONTINUES = Object.freeze({
  negativePrice: false,
  dvCurtailment: false,
  gridOperatorProduction: false,
  feedInCapLoop: false,
  socFloor: false,
});

// Für Leitstand/Status: was im Not-Halt ausgesetzt ist (Klasse → Text).
const CLASS_LABELS = Object.freeze({
  negativePrice: '§51-Abregelung bei negativen Preisen',
  dvCurtailment: 'Abregelung durch den Direktvermarkter (inkl. Teilvorgabe)',
  gridOperatorProduction: 'Einspeisegrenze der Steuerbox (EEBUS LPP)',
  feedInCapLoop: 'feste Einspeisegrenze als Regelschleife (SunSpec-Wechselrichter)',
  socFloor: 'Schutz am SoC-Boden (Sicherheits-Nullung)',
});

/** Texte aller im Not-Halt ausgesetzten Funktionen (inkl. § 14a, immer ausgesetzt). */
export function notHaltSuspendedLabels(policy = NOT_HALT_CONTINUES) {
  const list = ['§14a-Steuerung (EEBUS-Grenzen an Wallbox, Wärmepumpe, Speicher)'];
  for (const [cls, label] of Object.entries(CLASS_LABELS)) if (policy[cls] !== true) list.push(label);
  list.push('alle Optimierungen, Zeitpläne, Wallbox, Heizstab, Geräte, zweite GX');
  return list;
}

// Quellen in schedule-eval.applyControlTarget, die das Not-Halt-Tor kennt.
// emergency_stop = die eine Neutralisierung des Not-Halts selbst (immer).
const SOURCE_CLASS = Object.freeze({
  negative_price_protection: 'negativePrice',
  manual_override_soc_floor: 'socFloor',
});

// Gründe für die PV-Sperre (applyDvVictronControl) → Klasse.
const DV_REASON_CLASS = Object.freeze({
  dv_forced_off: 'dvCurtailment',
  negative_price_protection: 'negativePrice',
  paragraph14a_production_block: 'gridOperatorProduction',
});

// Quellen im Begrenzer 2706 (feed-in-limit-arbiter) → Klasse. 'fixed' fehlt
// bewusst: die feste Grenze steht im GX gespeichert und gilt auch, wenn DVhub
// aus ist — im Not-Halt schreibt DVhub sie nicht nach.
const FEED_IN_SOURCE_CLASS = Object.freeze({
  dv: 'dvCurtailment',
  eebus_lpp: 'gridOperatorProduction',
});

/** Läuft diese Klasse im Not-Halt weiter? Unbekannt = nein (fail-safe). */
export function notHaltContinues(cls, policy = NOT_HALT_CONTINUES) {
  return cls != null && policy[cls] === true;
}

/** applyControlTarget-Quelle darf im Not-Halt schreiben. */
export function notHaltAllowsControlSource(source, policy = NOT_HALT_CONTINUES) {
  if (String(source) === 'emergency_stop') return true;
  return notHaltContinues(SOURCE_CLASS[String(source)], policy);
}

/** Grund einer PV-Sperre (dv_forced_off …) darf im Not-Halt schreiben. */
export function notHaltAllowsDvReason(reason, policy = NOT_HALT_CONTINUES) {
  return notHaltContinues(DV_REASON_CLASS[String(reason)], policy);
}

/** Quelle des Begrenzers 2706 darf im Not-Halt schreiben. */
export function notHaltAllowsFeedInSource(source, policy = NOT_HALT_CONTINUES) {
  return notHaltContinues(FEED_IN_SOURCE_CLASS[String(source)], policy);
}

// Quellen, die im Not-Halt genau EINE Rücknahme einer eigenen Vorgabe
// schreiben (die Wertprüfung macht schedule-eval). Das Tor lässt jede höchstens
// einmal je Not-Halt durch — kein Wiederholen, wenn sie scheitert.
export const NOT_HALT_ONE_SHOT_SOURCES = Object.freeze([
  'peak_shaving_restore',
  'grid_connection_restore',
  'multi_gx_handoff_stop',
]);

// --- Abfrage für Module ohne eigenen Zustand (Wallbox-Adapter) ----------------
// server.js meldet hier, wie der Not-Halt abgefragt wird; ohne Meldung (Tests,
// Werkzeuge) gilt „kein Not-Halt“.
let probe = () => false;

export function setNotHaltProbe(fn) {
  probe = typeof fn === 'function' ? fn : () => false;
}

/** Not-Halt gerade aktiv (state.ctrl.discretionaryWritesPaused). */
export function notHaltActive() {
  try { return probe() === true; } catch { return false; }
}
