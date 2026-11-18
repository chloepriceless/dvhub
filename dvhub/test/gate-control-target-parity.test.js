// H-1 Phase 3b — Paritätsnachweis Pfad 1 der D.1-Inventur über das Schreibtor im Legacy-Modus (VCL-Vertrag v6 D.2
// „bit-gleich zu main", Nachweis D.4(2)): applyControlTargetCore mit seinen Senken Modbus (Victron 2716 FC16 samt
// Keepalive, 2705/2704/2901/2706 FC6, Sungrow-/Deye-/Fronius-Register), MQTT-Brücke (Venus mit Rückmeldung),
// DVhub-Schema mit Broker und ohne Broker (HTTP-Abholung, samt GET /api/integration/loxone und dem Ergebnis `ok`).
// Jedes Szenario läuft einmal über den ALTEN Weg und einmal über das ECHTE Tor (test/helpers/dv-parity-rig.js);
// verglichen werden Draht-Folge, Transport-Aufrufe samt Argumenten, Rückgaben/Fehler, Log-Ereignisse samt Daten und
// Stufe, Telemetrie-Ereignisse, ctrl und der ganze Zeitplan-Zustand (lastWrite, active, _verify, Keepalive-Sammler)
// und im Lese-Modus die abgewehrten Schreibversuche. Auf der neuen Seite zusätzlich: jeder Senken-Aufruf genau ein
// Tor-Ereignis (Vertrauensklasse legacy, Gerät inverter), das Tor sperrt nichts selbst, Aktionsklassen stehen fest.
//
// Szenarien: test/helpers/ct-parity-scenarios.js; mit umgeschalteter Not-Halt-Richtlinie (eine Pflicht-Klasse läuft im
// Not-Halt weiter) prüft sie test/gate-dv-parity-policy-flip.test.js.
//
// Gegenbeweis gegen den Stand VOR dem Umbau (516a5e60):
//   git show 516a5e60:dvhub/schedule-eval.js > dvhub/schedule-eval.parity-base.js
//   DV_PARITY_BASE=schedule-eval.parity-base.js node --test test/gate-control-target-parity.test.js   (in dvhub/;
//   danach löschen — die Kopie läge sonst im R-T1-Scan)

import { controlTargetScenarios } from './helpers/ct-parity-scenarios.js';
import { registerParityScenarios } from './helpers/dv-parity-rig.js';

registerParityScenarios(controlTargetScenarios(), 'Pfad 1');
