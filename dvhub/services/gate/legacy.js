// services/gate/legacy.js — Bestandspfade im Legacy-Modus ans Schreibtor anschließen (VCL-Vertrag v6 D.1, D.2).
// Phase 2: Pfad 6 (Sungrow-EMS, Master UND Slave, services/inverter/sungrow.js `submitReg`).
//
// Nur hier — im Tor-Verzeichnis — stehen die Schreibfunktionen der Modbus-Senke (R-T1: „Die Senken sind nur noch aus
// dem Tor erreichbar“). sungrow.js reicht seinen schon kodierten Aufruf als `legacy: { sink, fn, args }` ein; das Tor
// prüft die acht Vorprüfungen und gibt `args` unverändert an `modbusLegacySink(transport)` weiter. Verhalten und
// Draht bleiben bit-gleich (D.2, Nachweis test/gate-sungrow-parity.test.js und test/gate-golden-sungrow.test.js).

import { noteBlockedWrite } from '../../read-only-guard.js';
import { createGate } from './index.js';

/** Freigabestufen, die der Legacy-Modus braucht (Rust `TargetClass::BatteryGrid`); heute gibt es keine Stufung. */
export const LEGACY_CLASSES = Object.freeze(['battery_grid']);

/** Gerätenamen im Tor: der Master (Führungsgerät) und der Slave (Folgegerät) sind getrennte Geräte (C.2 `group`). */
export const SUNGROW_GATE_DEVICES = Object.freeze({ master: 'sungrow-master', slave: 'sungrow-slave' });

const RESOURCE = 'batteryControl';
const release = Object.freeze({ kind: 'sequence', use: 'release' });

/**
 * Richtlinien der vier Sungrow-Punkte (C.2 `writes`, Ressource `batteryControl`, Rücknahme `sequence: release`).
 * Grundzustands-Literale (A.6, H-7): Befehl 13051 = 0xCC (204, Stopp), Modus 13050 = 0 (Self-consumption). Leistung
 * 13052 und Herzschlag 13080 haben kein Literal — weder der Not-Halt-Durchgang noch die Zwangsfreigabe schreiben sie.
 * Min-/Max-SoC (13059/13058) und Ladestrom haben KEINEN Punkt (H-8: DVhub schreibt sie nie): ein Write dorthin wäre
 * ein unbekanntes Ziel und wird vom Tor gesperrt.
 */
export function sungrowLegacyPolicies() {
  const points = (device) => ({
    emsMode: { class: 'battery_grid', resource: RESOURCE, sink: device, targetKind: 'modbus', neutral: release, neutralValues: [0] },
    emsCmd: { class: 'battery_grid', resource: RESOURCE, sink: device, targetKind: 'modbus', neutral: release, neutralValues: [0xcc] },
    emsPower: { class: 'battery_grid', resource: RESOURCE, sink: device, targetKind: 'modbus', unit: 'W', neutral: release },
    heartbeat: { class: 'battery_grid', resource: RESOURCE, sink: device, targetKind: 'modbus', unit: 's', neutral: { kind: 'never' } },
  });
  return {
    [SUNGROW_GATE_DEVICES.master]: points(SUNGROW_GATE_DEVICES.master),
    [SUNGROW_GATE_DEVICES.slave]: points(SUNGROW_GATE_DEVICES.slave),
  };
}

/**
 * Modbus-Senke für den Legacy-Modus: genau die heutigen Transport-Aufrufe, Argument-Objekt und Rückgabe unverändert
 * (gleiche Referenz). `transport` ist der Transport des Pfads (bei Sungrow samt Gesundheitszähler).
 */
export function modbusLegacySink(transport) {
  return {
    kind: 'modbus',
    legacy: {
      mbWriteSingle: (args) => transport.mbWriteSingle(args),
      mbWriteMultiple: (args) => transport.mbWriteMultiple(args),
    },
  };
}

/**
 * Lese-Modus-Meldung eines Legacy-Modbus-Aufrufs wortgleich wie transport-modbus.js (`Modbus fc=<fc> an
 * <host>:<port>`, der Schlüssel der Verbindung) — sonst null.
 */
export function legacyModbusReadOnlyWhat(op) {
  const fn = op?.legacy?.fn;
  const a = op?.legacy?.args?.[0];
  const fc = fn === 'mbWriteSingle' ? 6 : (fn === 'mbWriteMultiple' ? 16 : null);
  return fc != null && a && typeof a === 'object' ? `Modbus fc=${fc} an ${a.host}:${a.port}` : null;
}

/**
 * Das Tor für die Bestandspfade: Sungrow-Richtlinien, Stufe `battery_grid` freigegeben. `isHalted` liest dieselbe
 * Marke wie die Bestandsprüfung (`state.ctrl.discretionaryWritesPaused`); Lese-Modus wie der Transport
 * (DVHUB_READ_ONLY), gezählt und gemeldet mit derselben Zeile wie dort. Senken schließen die Pfade selbst an
 * (`attachSink`).
 * @param {Parameters<typeof createGate>[0]} [options]
 */
export function createLegacyGate(options = {}) {
  return createGate({
    policies: sungrowLegacyPolicies(),
    released: LEGACY_CLASSES,
    onReadOnlyBlock: (what, op) => noteBlockedWrite(legacyModbusReadOnlyWhat(op) ?? what),
    ...options,
  });
}
