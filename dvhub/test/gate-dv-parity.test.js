// H-1 Phase 3 — Paritätsnachweis der Abregel-Pfade über das Schreibtor im Legacy-Modus (VCL-Vertrag v6 D.2 „bit-gleich
// zu main", Nachweis D.4(2)): jedes Szenario läuft einmal über den ALTEN Weg und einmal über das ECHTE Tor
// (test/helpers/dv-parity-rig.js). Verglichen werden Draht-Folge (Lesen und Schreiben, alle Geräte in einem
// Protokoll), volle Argument-Objekte, Rückgaben/Fehler, Log-Ereignisse samt Daten und Stufe, die Zustandsfelder der
// Pfade (state.ctrl inkl. dvControl, _lastDvFeedIn, _dvSeqSaved, _zfi/_fic; lastWrite, _verify), die Merker-Dateien
// dv_seq_saved.json/dv_seq_writeday.json und im Lese-Modus die abgewehrten Schreibversuche. Auf der neuen Seite muss
// zusätzlich jeder Draht-Write genau ein Tor-Ereignis (ok/error, Vertrauensklasse legacy) haben, das Tor darf nichts
// selbst sperren, und die Aktionsklassen stehen fest.
//
//   Pfad 2  runDvControlSequence — Abregel-Sequenzen Fronius / Deye / Sungrow (über applyDvVictronControl und den
//           Chokepoint applyControlTarget)
//   Pfad 4  applyDvFeedInLimit — Victron 2706 direkt, über den echten Begrenzer (feed-in-limit-arbiter) und den
//           echten Not-Halt-Eintritt (setEmergencyStop)
//   Pfad 5  zfiWrite — Nulleinspeise-Deckel (zeroFeedInTick) und feste Einspeisegrenze (feedInCapTick), Fronius
//   Pfad 3  applyDvVictronControl — Victron 2707/2708 direkt und über die MQTT-Brücke (Venus), Rücklese-Prüfung,
//           Freigabe-Backoff, Teil-Sperre (A11), ganzer Takt (evaluateSchedule) bei negativem Preis
//
// Die Szenarien stehen in test/helpers/dv-parity-scenarios.js; dieselben Pfade mit umgeschalteter
// Not-Halt-Richtlinie (eine Pflicht-Klasse läuft im Not-Halt weiter) prüft test/gate-dv-parity-policy-flip.test.js.
//
// Gegenbeweis gegen den Stand VOR dem Umbau (732f954a):
//   git show 732f954a:dvhub/schedule-eval.js > dvhub/schedule-eval.parity-base.js
//   DV_PARITY_BASE=schedule-eval.parity-base.js node --test test/gate-dv-parity.test.js   (in dvhub/; danach löschen —
//   die Kopie läge sonst im R-T1-Scan)

import { mainScenarios } from './helpers/dv-parity-scenarios.js';
import { registerParityScenarios } from './helpers/dv-parity-rig.js';

registerParityScenarios(mainScenarios());
