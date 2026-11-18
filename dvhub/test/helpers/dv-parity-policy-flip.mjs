// test/helpers/dv-parity-policy-flip.mjs — Paritätsnachweis mit UMGESCHALTETER Not-Halt-Richtlinie (läuft nur im
// Kind-Prozess mit --experimental-test-module-mocks, gestartet von test/gate-dv-parity-policy-flip.test.js).
//
// services/emergency-stop/policy.js lässt jede Pflicht-Klasse einzeln wieder im Not-Halt weiterschreiben
// (NOT_HALT_CONTINUES, „true = schreibt im Not-Halt weiter wie bis 1.0.9“). Ab Werk ist keine eingeschaltet —
// dann schreibt eine Pflicht-Abregelung im Not-Halt gar nicht (das zeigen die Szenarien in gate-dv-parity.test.js).
// Hier sind negativePrice, dvCurtailment und feedInCapLoop eingeschaltet: die §-51-Sperre, die DV-Teilvorgabe am
// Begrenzer 2706, der Nulleinspeise-Deckel unter einer §-51-Sperre und die Regelschleife der festen Grenze laufen
// im Not-Halt weiter. Über das Tor muss das genauso durchgehen (Lauf-Zulassung mit inHalt), ein Befehl nicht.

import { mock } from 'node:test';

const real = await import('../../services/emergency-stop/policy.js');
const FLIPPED = Object.freeze({ ...real.NOT_HALT_CONTINUES, negativePrice: true, dvCurtailment: true, feedInCapLoop: true });
mock.module('../../services/emergency-stop/policy.js', {
  namedExports: {
    ...real,
    NOT_HALT_CONTINUES: FLIPPED,
    notHaltSuspendedLabels: (p = FLIPPED) => real.notHaltSuspendedLabels(p),
    notHaltContinues: (c, p = FLIPPED) => real.notHaltContinues(c, p),
    notHaltAllowsControlSource: (s, p = FLIPPED) => real.notHaltAllowsControlSource(s, p),
    notHaltAllowsDvReason: (r, p = FLIPPED) => real.notHaltAllowsDvReason(r, p),
    notHaltAllowsFeedInSource: (s, p = FLIPPED) => real.notHaltAllowsFeedInSource(s, p),
  },
});

const { registerParityScenarios } = await import('./dv-parity-rig.js');
const { flipScenarios } = await import('./dv-parity-scenarios.js');
registerParityScenarios(flipScenarios(), 'Richtlinie umgeschaltet');
