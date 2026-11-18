// services/gate/legacy.js — Bestandspfade im Legacy-Modus ans Schreibtor anschließen (VCL-Vertrag v6 D.1, D.2).
// Phase 2: Pfad 6 (Sungrow-EMS, Master UND Slave, services/inverter/sungrow.js `submitReg`).
// Phase 3: Pfade 2–5 (schedule-eval.js: Abregel-Sequenzen, Victron 2707/2708 und MQTT, Einspeisegrenze 2706,
// Nulleinspeisung/fester Deckel) über das Gerät `inverter` (allgemeiner WR-Transport, wie Rust `Policies::from_config`).
//
// Nur hier — im Tor-Verzeichnis — stehen die Schreibfunktionen der Senken (R-T1: „Die Senken sind nur noch aus dem
// Tor erreichbar“). Die Pfade reichen ihren schon kodierten Aufruf als `legacy: { sink, fn, args }` ein; das Tor
// prüft die acht Vorprüfungen und gibt `args` unverändert an die Senke weiter. Verhalten und Draht bleiben bit-gleich
// (D.2, Nachweis test/gate-sungrow-parity.test.js, test/gate-dv-parity.test.js und die Golden-Master).

import { noteBlockedWrite, ReadOnlyViolation } from '../../read-only-guard.js';
import { createGate, GateBlockedError } from './index.js';

/**
 * Freigabestufen, die der Legacy-Modus braucht (Rust `TargetClass::BatteryGrid` und `TargetClass::DvCurtail`); heute
 * gibt es keine Stufung — beide sind freigegeben.
 */
export const LEGACY_CLASSES = Object.freeze(['battery_grid', 'dv_curtail']);

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

// --- Phase 3: Abregel-Pfade über das Gerät `inverter` ------------------------------------------------------------

/** Gerätename im Tor für den allgemeinen WR-Transport der Bewertung (schedule-eval.js), wie Rust (`inverter`). */
export const INVERTER_GATE_DEVICE = 'inverter';

// Freigabe-Literale der Einzelpunkte (Richtung „Einspeisung frei“ bzw. „Deckel aus“): Victron 2707 OvervoltageFeedIn
// = 1, 2708 PreventFeedback = 0 (Modbus und MQTT-Brücke unter demselben Namen), SunSpec WMaxLim_Ena = 0.
const PV_RELEASE_LITERALS = Object.freeze({ feedExcessDcPv: [1], dontFeedExcessAcPv: [0], wMaxLimEna: [0] });
const PV_UNITS = Object.freeze({ dvFeedInLimitW: 'W', wMaxLimPct: '%', wMaxLimPctRvrtTms: 's' });

/**
 * Richtlinie eines Punkts am Gerät `inverter` (Ressource `pvExport`, D.1 R-T4; Stufe `dv_curtail` wie Rust
 * `TargetClass::DvCurtail`). Rücknahme laut A.6: PV-Sperre/DV-Sequenz `sequence: release` (die Einzelflaggen mit
 * ihrem Freigabe-Literal), alle übrigen Punkte — Sequenz-Schritte, Einspeisegrenze 2706 — `restoreBefore`: der Wert
 * vor DVhub, den im Legacy-Modus der Pfad sichert (dv_seq_saved.json, D.2). Welche Punkte es gibt, bestimmt im
 * Legacy-Modus das Herstellerprofil (D.0): die Pfade melden jeden Punkt vor seinem ersten Write an.
 * @param {string} point
 * @param {'modbus'|'mqtt'} [targetKind]
 */
export function inverterLegacyPolicy(point, targetKind = 'modbus') {
  const literals = Object.hasOwn(PV_RELEASE_LITERALS, point) ? PV_RELEASE_LITERALS[point] : null;
  return {
    class: 'dv_curtail',
    resource: 'pvExport',
    sink: INVERTER_GATE_DEVICE,
    targetKind,
    ...(Object.hasOwn(PV_UNITS, point) ? { unit: PV_UNITS[point] } : {}),
    neutral: literals ? { kind: 'sequence', use: 'release' } : { kind: 'restoreBefore' },
    ...(literals ? { neutralValues: [...literals] } : {}),
  };
}

/**
 * Senke des allgemeinen WR-Transports (Modbus oder MQTT-Brücke) für die Abregel-Pfade: genau die heutigen
 * Transport-Aufrufe, Argumente und Rückgabe unverändert. Die Art folgt dem Transport (MQTT → `mqtt`, sonst `modbus`).
 * Im Lese-Modus meldet sie für MQTT dieselbe Zeile wie transport-mqtt.js (`MQTT <W/-Topic>`); Modbus wie
 * transport-modbus.js über legacyModbusReadOnlyWhat.
 */
export function inverterLegacySink(transport) {
  return {
    kind: transport?.type === 'mqtt' ? 'mqtt' : 'modbus',
    legacy: {
      mbWriteSingle: (args) => transport.mbWriteSingle(args),
      mbWriteMultiple: (args) => transport.mbWriteMultiple(args),
      mqttWrite: (name, value) => transport.mqttWrite(name, value),
    },
    readOnlyWhat: (op) => {
      if (op?.legacy?.fn !== 'mqttWrite' || typeof transport?._writeTopics !== 'function') return null;
      const topic = transport._writeTopics()?.[op.legacy.args?.[0]];
      return typeof topic === 'string' && topic ? `MQTT ${topic}` : null;
    },
  };
}

/** Fehler, den der Transport im Lese-Modus für diesen Aufruf wirft — dieselbe Klasse, derselbe Text. */
export function legacyReadOnlyError(op) {
  const fn = op?.legacy?.fn;
  if (fn === 'mqttWrite') return new ReadOnlyViolation(`Schreibzugriff im Lese-Modus abgelehnt (MQTT ${op.legacy.args?.[0]})`);
  return new ReadOnlyViolation(`Schreibzugriff im Lese-Modus abgelehnt (Modbus fc=${fn === 'mbWriteMultiple' ? 16 : 6})`);
}

/**
 * Ergebnis des Tors wie den heutigen Transport-Aufruf behandeln: Rückgabe bzw. derselbe Fehler (gleiche Referenz).
 * Sperrt das Tor im Lese-Modus, derselbe Fehler wie aus dem Transport. Jede andere Sperre ist im Legacy-Modus ein
 * Verdrahtungsfehler und wirft laut GateBlockedError (code gate_blocked).
 */
export function unwrapLegacyWrite(res, op) {
  if ('error' in res) throw res.error;
  if ('result' in res) return res.result;
  if (res.outcome === 'blocked_readonly') throw legacyReadOnlyError(op);
  const err = new GateBlockedError(res, op);
  err.code = 'gate_blocked';
  throw err;
}

/**
 * Das Tor für die Bestandspfade: Sungrow-Richtlinien, Stufen `battery_grid` und `dv_curtail` freigegeben. `isHalted`
 * liest dieselbe Marke wie die Bestandsprüfung (`state.ctrl.discretionaryWritesPaused`); Lese-Modus wie der Transport
 * (DVHUB_READ_ONLY), gezählt und gemeldet mit derselben Zeile wie dort. Senken schließen die Pfade selbst an
 * (`attachSink`), die Punkte des Geräts `inverter` meldet schedule-eval.js an (`setDevicePolicies`).
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
