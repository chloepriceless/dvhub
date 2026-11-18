// services/gate/index.js — Node-Schreibtor (VCL-Vertrag v6 D.1, H-1). Phase 1: Gerüst; Phase 2: Pfad 6 (Sungrow
// `writeReg`, Master und Slave) läuft im Legacy-Modus hierüber (services/gate/legacy.js); Phase 3: die Abregel-Pfade
// 2–5 (schedule-eval.js) mit Lauf-Zulassung.
//
// Ein Zugang: `submit(GateOp) → Promise<SubmitResult>`. Jede Schreibabsicht — Vertragsroute oder Legacy-Pfad — soll
// hier enden (R-T1); bis die acht Pfade umgestellt sind, führt test/gate-rt1-structure.test.js die bekannten
// Direktaufrufe als Ausnahmeliste, die nur kürzer werden darf.
//
// Vorprüfungen in fester Reihenfolge (D.1; deckungsgleich mit Rust dvhub-gate/src/lib.rs `submit`, plus die neuen):
//   1 halt        Not-Halt — nur `haltNeutralize` und eine bestätigte `manualForceRelease` Richtung Grundzustand (H-7)
//   2 deadline    Frist abgelaufen
//   3 readOnly    Lese-Modus
//   4 release     Schreibfreigabe je Gerät (open | profileInvalid | setupIncomplete | notIdentified | identityMismatch)
//   5 target      unbekanntes Ziel, Freigabestufe
//   6 lease       Epoche aktuell, Ressource passt zum Punkt; eingereihte Operationen mit alter Epoche verfallen (R-T5)
//   7 constraint  Einschränkung — Phase 1 nur Schnittstelle (einsteckbarer Prüfer, Voreinstellung: erlauben; H-4)
//   8 unchanged   unverändert → kein Write
//
// Senken werden beim Anlegen übergeben (Modbus/MQTT/HTTP-Abholung als Funktionen); das Tor importiert keinen
// Transport. Legacy-Modus (D.2, Vertrauensklasse `legacy`): der heutige, schon kodierte Aufruf geht unverändert an die
// Senke, die Rückgabe kommt unverändert zurück (gleiche Referenz) plus Zusatzfelder — damit ein Pfad später bit-gleich
// verdrahtet werden kann. Im Legacy-Modus behält der Pfad Besitz-, Budget- und Unverändert-Logik wie heute (D.2):
// Vorprüfung 8 und die Lease-Pflicht gelten nur für Vertragsoperationen.
//
// Legacy-Lauf (Phase 3, Pfade 2–5): Die Abregel-Pfade entscheiden den Not-Halt heute EINMAL am Eingang eines Laufs
// (applyDvVictronControl, der Begrenzer vor applyDvFeedInLimit, der Anfang des Nulleinspeise-/Deckel-Takts) und
// schreiben die Folge danach zu Ende. Ein solcher Pfad holt sich direkt nach seiner Prüfung eine Lauf-Zulassung
// (`admitLegacyRun`) und reicht sie mit jeder Operation des Laufs ein (`submit(op, { run })`). Vorprüfung 1 urteilt
// dann mit dem Not-Halt-Stand am Laufeingang (siehe checkHalt) — sonst sperrte das Tor eine vor dem Eintritt
// begonnene Folge mitten drin, was heute nicht geschieht (D.2 bit-gleich). Ohne Zulassung gilt die Regel unverändert.

import { isReadOnlyMode, noteBlockedWrite, ReadOnlyViolation } from '../../read-only-guard.js';
import {
  ACTIONS,
  BLOCKED_WHEN_PROFILE_INVALID,
  DELIVERIES,
  DETAIL,
  GATE_OP_KEYS,
  KINDS,
  LEASE_REQUIRED,
  LOOPS,
  PRE_CHECKS,
  RELEASE_DETAIL,
  RELEASE_STATES,
} from './constants.js';
import { classifySinkResult, defaultErrorClassifier } from './delivery.js';
import { createOwnerRegister } from './owner.js';

export * from './constants.js';
export * from './delivery.js';
export { createOwnerRegister, MAX_UNCERTAIN } from './owner.js';

/** @typedef {import('./types.js').GateOp} GateOp */
/** @typedef {import('./types.js').SubmitResult} SubmitResult */
/** @typedef {import('./types.js').WriteEvent} WriteEvent */
/** @typedef {import('./types.js').PointPolicy} PointPolicy */

const OP_KEYS = new Set(GATE_OP_KEYS);
const CONSTRAINT_BOOL_KEYS = new Set(['noGridCharge', 'noGridExport']);
const CONSTRAINT_NUM_KEYS = new Set(['maxChargeW', 'maxDischargeW', 'socFloorPct', 'socCeilPct', 'gridImportMaxW', 'gridExportMaxW']);
const SINK_KINDS = new Set(['modbus', 'mqtt', 'http', 'pickup']);
// Ereignis-Zielart wie Rust `TargetKind`; die HTTP-Abholung ist dort `http`.
const EVENT_TARGET_KIND = { modbus: 'modbus', mqtt: 'mqtt', http: 'http', pickup: 'http' };
// Wie viele Takte je Schleife sich das Tor für die Eindeutigkeit der opId merkt (je Versuch eindeutig, §0.2).
const OPID_TICKS = 1000;

/** Vom Tor gesperrt oder ausgelassen — für Legacy-Aufrufer, die heute auf einen Fehler warten. */
export class GateBlockedError extends Error {
  constructor(res, op) {
    super(`Schreibtor: ${res.outcome}${res.detail ? ` (${res.detail})` : ''} ${op?.device ?? '?'}/${op?.point ?? '?'}`);
    this.name = 'GateBlockedError';
    this.outcome = res.outcome;
    this.detail = res.detail ?? null;
    this.opId = res.opId;
  }
}

/**
 * Legacy-Aufrufstelle wie heute bedienen: Rückgabe der Senke (gleiche Referenz) oder deren Fehler (gleiche
 * Referenz) werfen. Hat das Tor gesperrt, kommt ein Fehler — im Lese-Modus derselbe Typ wie aus dem Transport.
 * @param {SubmitResult} res
 * @param {GateOp} [op]
 */
export function unwrapLegacy(res, op) {
  if ('error' in res) throw res.error;
  if ('result' in res) return res.result;
  if (res.outcome === 'blocked_readonly') {
    throw new ReadOnlyViolation(`Schreibzugriff im Lese-Modus abgelehnt (Tor ${op?.device ?? '?'}/${op?.point ?? '?'})`);
  }
  throw new GateBlockedError(res, op);
}

/** Voreinstellung für Vorprüfung 7 (Phase 1): alles erlauben. Die durchsetzende Prüfung ist H-4. */
export function allowAllConstraints() {
  return { ok: true };
}

const isScalar = (v) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || typeof v === 'string';
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

/** Schlüsselmenge geschlossen (IOP-4): unbekannte Schlüssel ungültig, `x-`/`_` werden ignoriert. */
function validateOp(op) {
  if (!isPlainObject(op)) return 'op ist kein Objekt';
  for (const k of Object.keys(op)) {
    if (!OP_KEYS.has(k) && !k.startsWith('x-') && !k.startsWith('_')) return `unbekannter Schlüssel ${k}`;
  }
  if (!isNonEmptyString(op.device)) return 'device';
  if (!isNonEmptyString(op.point)) return 'point';
  if (!isScalar(op.value)) return 'value';
  if (op.requested !== undefined && !isScalar(op.requested)) return 'requested';
  if (!isNonEmptyString(op.source)) return 'source';
  if (!KINDS.includes(op.kind)) return 'kind';
  if (!ACTIONS.includes(op.action)) return 'action';
  if (op.lease !== null) {
    if (!isPlainObject(op.lease) || !isNonEmptyString(op.lease.resource) || !isNonNegInt(op.lease.epoch)) return 'lease';
    if (Object.keys(op.lease).some((k) => k !== 'resource' && k !== 'epoch')) return 'lease';
  }
  const c = op.constraints;
  if (!isPlainObject(c) || !isPlainObject(c.set) || !isPlainObject(c.caps) || !Array.isArray(c.enforcedBy)) return 'constraints';
  if (Object.keys(c).some((k) => k !== 'set' && k !== 'caps' && k !== 'enforcedBy')) return 'constraints';
  for (const [k, v] of Object.entries(c.set)) {
    if (CONSTRAINT_BOOL_KEYS.has(k)) { if (typeof v !== 'boolean') return `constraints.set.${k}`; }
    else if (CONSTRAINT_NUM_KEYS.has(k)) { if (v !== null && !(typeof v === 'number' && Number.isFinite(v))) return `constraints.set.${k}`; }
    else return `constraints.set.${k}`;
  }
  for (const [k, v] of Object.entries(c.caps)) {
    if ((k !== 'chargeW' && k !== 'dischargeW') || !(typeof v === 'number' && Number.isFinite(v))) return `constraints.caps.${k}`;
  }
  if (!c.enforcedBy.every(isNonEmptyString)) return 'constraints.enforcedBy';
  if (op.validUntilMs !== null && !(typeof op.validUntilMs === 'number' && Number.isFinite(op.validUntilMs))) return 'validUntilMs';
  if (!isPlainObject(op.tick) || !LOOPS.includes(op.tick.loop) || !isNonNegInt(op.tick.seq)) return 'tick';
  if (Object.keys(op.tick).some((k) => k !== 'loop' && k !== 'seq')) return 'tick';
  if (!isNonNegInt(op.step)) return 'step';
  if (op.ruleId !== undefined && !isNonEmptyString(op.ruleId)) return 'ruleId';
  if (op.confirmedBy !== undefined && !isNonEmptyString(op.confirmedBy)) return 'confirmedBy';
  if (op.legacy !== undefined && op.legacy !== null) {
    const l = op.legacy;
    if (!isPlainObject(l) || !isNonEmptyString(l.sink) || !isNonEmptyString(l.fn) || !Array.isArray(l.args)) return 'legacy';
    if (Object.keys(l).some((k) => k !== 'sink' && k !== 'fn' && k !== 'args')) return 'legacy';
  }
  return null;
}

function normalizePolicies(input) {
  const out = new Map();
  for (const [device, points] of Object.entries(input || {})) {
    const m = new Map();
    for (const [point, pol] of Object.entries(points || {})) m.set(point, Object.freeze({ ...pol }));
    out.set(device, m);
  }
  return out;
}

const neutralKind = (pol) => pol?.neutral?.kind ?? 'never';

/**
 * JSON mit sortierten Schlüsseln auf jeder Ebene (auch `neutral: { kind, value }`, Codex 710d8f36 P2). Wie
 * JSON.stringify: Felder mit `undefined` fehlen (ein weggelassenes optionales Feld ist dasselbe, Codex 5dda7ee7 P2),
 * in Listen wird `undefined` zu `null`.
 */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Vergleich von Richtlinien je Gerät (für setPolicies): Reihenfolge der Schlüssel egal, auf jeder Ebene. */
function policySignature(points) {
  return points ? canonicalJson(Object.fromEntries(points)) : '';
}

/** Eigene Eigenschaft — nie über die Prototyp-Kette (`legacy.fn: 'constructor'` ist keine Senke). */
const own = (obj, key) => (obj != null && Object.hasOwn(obj, key) ? obj[key] : undefined);

/**
 * Ist der Wert ein festes Literal Richtung Grundzustand? Gilt für den Not-Halt-Durchgang (`haltNeutralize`) und die
 * manuelle Zwangsfreigabe (H-7): `neutralValues` der Richtlinie, der feste Wert bei `fixed`, der Ersatzwert bei
 * `restoreBefore`. Bei `never` nichts (H-8: nie gesetzt → nie zurückgesetzt).
 */
function isNeutralLiteral(pol, value) {
  if (!pol || neutralKind(pol) === 'never') return false;
  const literals = Array.isArray(pol.neutralValues) ? [...pol.neutralValues] : [];
  if (pol.neutral?.kind === 'fixed') literals.push(pol.neutral.value);
  if (pol.neutral?.kind === 'restoreBefore' && pol.neutral.fallback !== undefined) literals.push(pol.neutral.fallback);
  return literals.some((l) => l === value);
}

/**
 * Schreibtor anlegen.
 * @param {{
 *   sinks?: Record<string, { kind: 'modbus'|'mqtt'|'http'|'pickup', write?: Function, legacy?: Record<string, Function>,
 *                            classifyError?: Function, classifyResult?: Function }>,
 *   policies?: Record<string, Record<string, PointPolicy>>,
 *   released?: Iterable<string>,
 *   isHalted?: () => boolean,
 *   isReadOnly?: () => boolean,
 *   onReadOnlyBlock?: (what: string) => void,
 *   checkConstraints?: (op: GateOp, policy: PointPolicy) => { ok: boolean, reason?: string },
 *   onEvent?: (ev: WriteEvent) => void,
 *   now?: () => number,
 *   configRev?: string|null,
 *   licensePro?: boolean,
 *   opIdTicks?: number,
 * }} [options]
 */
export function createGate(options = {}) {
  const {
    isHalted = () => false,
    isReadOnly = () => isReadOnlyMode(),
    onReadOnlyBlock = noteBlockedWrite,
    checkConstraints = allowAllConstraints,
    onEvent = null,
    now = Date.now,
    configRev = null,
    licensePro = false,
    opIdTicks = OPID_TICKS,
  } = options;
  // Eigene Tabelle (nie das Objekt des Aufrufers verändern); attachSink() ergänzt sie. Ohne Prototyp: auch eine Senke
  // namens `__proto__` ist ein eigener Eintrag und kein Prototyp-Wechsel (Codex 8ad74e08 P3).
  const sinks = Object.create(null);
  const checkSink = (name, spec) => {
    if (!spec || !SINK_KINDS.has(spec.kind)) throw new TypeError(`Senke ${name}: kind muss modbus|mqtt|http|pickup sein`);
  };
  for (const [name, spec] of Object.entries(options.sinks || {})) {
    checkSink(name, spec);
    sinks[name] = spec;
  }

  let policies = normalizePolicies(options.policies);
  let released = new Set(options.released || []); // leer = nichts freigegeben (wie Rust Settings.released)
  const owners = createOwnerRegister();
  /** @type {Map<string, { state: string, gen: number, passDone: Set<string> }>} */
  const releases = new Map();
  /** @type {Map<string, number>} Lease-Epoche je (Gerät, Ressource) */
  const leaseEpochs = new Map();
  /** @type {Map<string, Promise<unknown>>} Warteschlange je Gerät (nur Vertragsoperationen) */
  const chains = new Map();
  /** @type {Map<string, { horizon: number, seqs: Map<number, Map<string, number>> }>} opId-Gedächtnis je Schleife */
  const opIdMemory = new Map();
  let uniqueCounter = 0;
  let invalidCounter = 0;
  // Not-Halt-Sperrmarke (wie fenceModbusWrites, nur im Tor): steigt bei jedem Not-Halt-Eintritt — gemeldet über
  // fence() oder vom Tor selbst beobachtet. Vor dem Eintritt zugelassene Operationen gehen danach nie mehr raus,
  // auch nicht nach dem Aufheben (Codex 7a183a18 P1).
  let fenceGen = 0;
  let lastHalted = false;
  // Vom Tor ausgegebene Lauf-Zulassungen (admitLegacyRun). Nur diese gelten — ein nachgebautes Objekt nicht.
  const issuedRuns = new WeakSet();

  const policyOf = (device, point) => policies.get(device)?.get(point) ?? null;
  const epochKey = (device, resource) => `${device}\u0000${resource}`;

  function rel(device) {
    let r = releases.get(device);
    if (!r) {
      // Nie gemeldet = Einrichtung unvollständig: fail-closed.
      r = { state: 'setupIncomplete', gen: 0, passDone: new Set() };
      releases.set(device, r);
    }
    return r;
  }

  function leaseEpoch(device, resource) {
    return leaseEpochs.get(epochKey(device, resource)) ?? 0;
  }

  function advanceLeaseEpoch(device, resource) {
    const next = leaseEpoch(device, resource) + 1;
    leaseEpochs.set(epochKey(device, resource), next);
    return next;
  }

  function resourcesOf(device) {
    const set = new Set();
    for (const pol of policies.get(device)?.values() ?? []) if (pol.resource) set.add(pol.resource);
    const prefix = `${device}\u0000`;
    for (const k of leaseEpochs.keys()) if (k.startsWith(prefix)) set.add(k.slice(prefix.length));
    return set;
  }

  /** Gerätegeneration und alle Lease-Epochen des Geräts erhöhen: zugelassene Operationen verfallen. */
  function bumpDevice(device, extraResources = []) {
    const r = rel(device);
    r.gen += 1;
    for (const resource of new Set([...resourcesOf(device), ...extraResources])) advanceLeaseEpoch(device, resource);
    return r.gen;
  }

  /**
   * Freigabezustand eines Geräts setzen. Jeder WECHSEL erhöht die Epoche (R-T5): die Gerätegeneration und die
   * Lease-Epoche jeder Ressource des Geräts. Eingereihte Operationen mit alter Epoche verfallen in Vorprüfung 6.
   */
  function setRelease(device, state) {
    if (!isNonEmptyString(device)) throw new TypeError('device');
    if (!RELEASE_STATES.includes(state)) throw new TypeError(`Freigabezustand ${state} unbekannt`);
    const r = rel(device);
    if (r.state === state) return { changed: false, generation: r.gen };
    r.state = state;
    r.passDone = new Set(); // neuer Abschnitt: R-T2.3 erlaubt wieder genau einen Rücknahme-Durchgang je Punkt
    return { changed: true, generation: bumpDevice(device) };
  }

  /**
   * Richtlinien ersetzen. Ändert sich irgendetwas an den Richtlinien eines Geräts, verfallen dessen eingereihte und
   * laufende Operationen (neue Generation und Lease-Epochen) — sie wurden gegen das alte Ziel zugelassen (Codex
   * 7a183a18 P1). Besitz an Punkten, deren Richtlinie wegfällt oder deren Senke/Ressource wechselt, verfällt.
   */
  function setPolicies(next) {
    const fresh = normalizePolicies(next);
    for (const [device, point] of owners.keys()) {
      const a = policyOf(device, point);
      const b = fresh.get(device)?.get(point) ?? null;
      if (!a || !b || a.sink !== b.sink || a.resource !== b.resource) owners.release(device, point);
    }
    const changed = [];
    for (const device of new Set([...policies.keys(), ...fresh.keys()])) {
      if (policySignature(policies.get(device)) !== policySignature(fresh.get(device))) changed.push(device);
    }
    const oldResources = new Map(changed.map((d) => [d, [...resourcesOf(d)]]));
    policies = fresh;
    for (const device of changed) bumpDevice(device, oldResources.get(device));
  }

  /**
   * Richtlinien EINES Geräts ersetzen, die übrigen bleiben (Phase 3: die Abregel-Pfade pflegen die Punkte des
   * Geräts `inverter` aus dem Herstellerprofil, ohne die Sungrow-Tabelle zu kennen). Sonst wie setPolicies.
   */
  function setDevicePolicies(device, points) {
    if (!isNonEmptyString(device)) throw new TypeError('device');
    // Ohne Prototyp: auch ein Gerät namens `__proto__` bleibt ein eigener Eintrag (Codex 135fdc22 P3).
    const next = Object.create(null);
    for (const [d, m] of policies) next[d] = Object.fromEntries(m);
    next[device] = points || {};
    setPolicies(next);
  }

  /** Not-Halt-Eintritt melden (wie fenceModbusWrites): alles vorher Zugelassene verfällt. */
  function fence() {
    fenceGen += 1;
    return fenceGen;
  }

  function setReleased(classes) {
    released = new Set(classes || []);
  }

  /**
   * Senke nachträglich anschließen: ein Pfad, der seinen Transport selbst baut (Sungrow-EMS mit eigenem
   * Gesundheitszähler, Phase 2), bringt ihn hier ans Tor — danach erreicht er ihn nur noch über submit(). Ein Name
   * genau einmal: zwei Schreiber unter demselben Gerätenamen wären ein Verdrahtungsfehler (R-T4).
   */
  function attachSink(name, spec) {
    if (!isNonEmptyString(name)) throw new TypeError('Senke: Name fehlt');
    checkSink(name, spec);
    if (Object.hasOwn(sinks, name)) throw new Error(`Senke ${name} ist schon angeschlossen`);
    sinks[name] = spec;
  }

  /**
   * Lauf-Zulassung für einen Legacy-Pfad (D.2), direkt nach SEINER Not-Halt-Prüfung am Laufeingang geholt. Hält den
   * Not-Halt-Stand dieses Augenblicks fest; Vorprüfung 1 urteilt für jede Operation des Laufs damit:
   *   • Eingang außerhalb des Not-Halts → der Lauf schreibt zu Ende, auch wenn der Not-Halt währenddessen beginnt
   *     (heute: keine Prüfung je Write; die Modbus-Sperrmarke verwirft weiter nur, was beim Eintritt eingereiht war).
   *   • Eingang im Not-Halt mit `inHalt` (der Pfad nennt die Regel, nach der SEINE Prüfung den Lauf im Not-Halt
   *     zulässt: die eine Freigabe einer eigenen Sperre, eine nach policy.js weiterlaufende Pflicht-Klasse, ein
   *     Begrenzer davor) → alles außer `command` und `keepalive`; ein Befehl oder Lebenszeichen bleibt gesperrt.
   *   • Eingang im Not-Halt ohne `inHalt`, oder Not-Halt-Zustand unlesbar → wie ohne Zulassung im Not-Halt.
   * @param {string} device
   * @param {{ inHalt?: string|null }} [opts]
   */
  function admitLegacyRun(device, { inHalt = null } = {}) {
    if (!isNonEmptyString(device)) throw new TypeError('device');
    const { halted, unknown } = haltedNow();
    const run = Object.freeze({ device, halted, unknown, inHalt: isNonEmptyString(inHalt) ? inHalt : null });
    issuedRuns.add(run);
    return run;
  }

  /**
   * opId je Versuch eindeutig. Gemerkt werden die letzten `opIdTicks` Takte je Schleife (exakt, Grundform plus `~n`
   * bei Wiederholung). Ein Takt, der älter als das Gedächtnis ist, bekommt einen nie wiederkehrenden Zusatz `~u<n>`
   * — so kann eine opId auch nach dem Vergessen nicht doppelt vorkommen (Codex 7a183a18 P2).
   */
  function nextOpId(op) {
    const base = `${op.tick.loop}-${op.tick.seq}-${op.device}-${op.point}-${op.step}`;
    let mem = opIdMemory.get(op.tick.loop);
    if (!mem) {
      mem = { horizon: -1, seqs: new Map() };
      opIdMemory.set(op.tick.loop, mem);
    }
    if (op.tick.seq <= mem.horizon) {
      uniqueCounter += 1;
      return `${base}~u${uniqueCounter}`;
    }
    let bucket = mem.seqs.get(op.tick.seq);
    if (!bucket) {
      bucket = new Map();
      mem.seqs.set(op.tick.seq, bucket);
      while (mem.seqs.size > opIdTicks) {
        const oldest = Math.min(...mem.seqs.keys());
        mem.seqs.delete(oldest);
        mem.horizon = Math.max(mem.horizon, oldest);
      }
      if (op.tick.seq <= mem.horizon) { // der neue Takt war selbst der älteste
        uniqueCounter += 1;
        return `${base}~u${uniqueCounter}`;
      }
    }
    const n = (bucket.get(base) ?? 0) + 1;
    bucket.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  }

  function haltedNow() {
    let halted;
    let unknown = false;
    try {
      halted = isHalted() === true;
    } catch {
      halted = true; // Not-Halt-Zustand unbekannt → als Not-Halt behandeln
      unknown = true;
    }
    if (halted && !lastHalted) fenceGen += 1; // selbst beobachteter Eintritt — fence() ist der verlässliche Weg
    lastHalted = halted;
    return { halted, unknown };
  }

  const HALT_EXEMPT = new Set(['haltNeutralize', 'manualForceRelease']);
  // Auch in einem im Not-Halt zugelassenen Legacy-Lauf gesperrt: ein Befehl und ein Lebenszeichen sind nie Teil der
  // Not-Halt-Regel eines Pfads (A.5: nur Rücknahme bzw. eine weiterlaufende Schutz-Begrenzung).
  const RUN_HALT_BLOCKED = new Set(['command', 'keepalive']);

  const block = (outcome, detail, extra = {}) => ({ outcome, detail, ...extra });

  // --- die acht Vorprüfungen (je: null = weiter, sonst Ergebnis) -------------------------------------------------

  function checkHalt(op, pol, adm, run) {
    // Legacy-Lauf: Not-Halt-Stand am Laufeingang (admitLegacyRun), sonst der jetzige.
    const { halted, unknown } = run ? { halted: run.halted, unknown: run.unknown } : haltedNow();
    const stopped = halted ? 'blocked_nothalt' : 'blocked_gate';
    // Im Not-Halt zugelassener Lauf: der Pfad hat nach seiner Not-Halt-Regel entschieden (heutiges Verhalten). Ein
    // Befehl/Lebenszeichen bleibt gesperrt; H-8 gilt weiter (`never` wird auch im Durchgang nie geschrieben). Den
    // Rücknahme-Wert hält im Legacy-Modus der Pfad (Sicherung dv_seq_saved.json, D.2) — kein Literal-Abgleich.
    if (run && halted && !unknown && run.inHalt && op.action !== 'manualForceRelease') {
      if (RUN_HALT_BLOCKED.has(op.action)) return block('blocked_nothalt', DETAIL.notHalt);
      if (op.action === 'haltNeutralize' && pol && neutralKind(pol) === 'never') return block('skipped_not_owned', DETAIL.neverNeutralized);
      return null;
    }
    if (op.action === 'manualForceRelease') {
      // H-7: einzige Ausnahme im Not-Halt — ausdrückliche Bedienhandlung, feste Literalfolge Richtung Grundzustand,
      // nie ein Sollwert. Gilt als Klassen-Definition auch außerhalb des Not-Halts.
      if (!isNonEmptyString(op.confirmedBy)) return block(stopped, DETAIL.forceReleaseUnconfirmed);
      if (!isNeutralLiteral(pol, op.value)) return block(stopped, DETAIL.forceReleaseNotNeutral);
      return null;
    }
    if (op.action === 'haltNeutralize') {
      // Der Durchgang gehört dem Not-Halt; außerhalb ist die Klasse ein Umweg an Lease und Freigabe vorbei
      // (im Legacy-Modus entscheidet der Pfad wie heute, wann er zurücknimmt).
      if (!halted && !op.legacy) return block('blocked_gate', DETAIL.neutralizeOutsideHalt);
      // H-8: was DVhub nie setzt (Min-SoC, Ladestrom, Netz-Sollwert: `never`), wird im Durchgang nie geschrieben.
      if (pol && neutralKind(pol) === 'never') return block('skipped_not_owned', DETAIL.neverNeutralized);
      // Nur ein Literal Richtung Grundzustand — nie ein Sollwert unter dem Namen der Rücknahme (Codex 7a183a18 P1).
      if (pol && !isNeutralLiteral(pol, op.value)) return block(stopped, DETAIL.neutralizeNotNeutral);
      return null;
    }
    if (halted) return block('blocked_nothalt', unknown ? DETAIL.haltStateUnknown : DETAIL.notHalt);
    // Legacy-Lauf außerhalb des Not-Halts zugelassen: er schreibt zu Ende wie heute (keine Sperrmarke im Tor).
    if (run) return null;
    // Nach dem Aufheben: was vor dem Eintritt oder während des Not-Halts zugelassen wurde, geht nie mehr raus.
    if (adm.halted || adm.fence !== fenceGen) return block('blocked_nothalt', DETAIL.fenced);
    return null;
  }

  function checkDeadline(op) {
    if (op.validUntilMs !== null && now() > op.validUntilMs) return block('blocked_gate', DETAIL.expired);
    return null;
  }

  function checkReadOnly(op) {
    let ro;
    let unknown = false;
    try {
      ro = isReadOnly() === true;
    } catch {
      ro = true;
      unknown = true;
    }
    if (!ro) return null;
    // Zweites Argument: die Operation — ein Legacy-Anschluss kann daraus dieselbe Meldung wie sein Transport bilden.
    // Eine Legacy-Senke kann ihre Zeile selbst liefern (`readOnlyWhat(op)`, z. B. MQTT mit dem Topic des Transports).
    let what = `Tor ${op.device}/${op.point}`;
    try {
      const own2 = op.legacy ? own(sinks, op.legacy.sink)?.readOnlyWhat?.(op) : null;
      if (isNonEmptyString(own2)) what = own2;
    } catch { /* die Zeile ist Diagnose */ }
    try { onReadOnlyBlock?.(what, op); } catch { /* Zählen darf das Sperren nicht verhindern */ }
    return block('blocked_readonly', unknown ? DETAIL.readOnlyStateUnknown : DETAIL.readOnly);
  }

  function checkRelease(op) {
    const r = rel(op.device);
    if (r.state === 'open') return null;
    if (r.state === 'profileInvalid') {
      // R-T2: gesperrt command, keepalive, protectiveLimit, autoRestore; genau EIN Rücknahme-Durchgang
      // (`safetyRelease`) je Punkt; Not-Halt-Durchgang und Zwangsfreigabe bleiben möglich.
      if (BLOCKED_WHEN_PROFILE_INVALID.has(op.action)) return block('blocked_gate', DETAIL.profileInvalid);
      if (op.action === 'safetyRelease' && r.passDone.has(op.point)) return block('blocked_gate', DETAIL.releasePassDone);
      return null;
    }
    // setupIncomplete, notIdentified, identityMismatch: kein Write — auch keine Rücknahme an ein nicht sicher
    // erkanntes Gerät (R-L7).
    return block('blocked_gate', RELEASE_DETAIL[r.state]);
  }

  function checkTarget(op, pol) {
    if (!pol) return block('blocked_gate', DETAIL.unknownTarget);
    if (!released.has(pol.class)) return block('blocked_gate', DETAIL.stageNotReleased);
    return null;
  }

  function checkLease(op, pol, adm) {
    const legacy = Boolean(op.legacy);
    if (op.action !== 'manualForceRelease') {
      if (op.lease) {
        if (!pol.resource || op.lease.resource !== pol.resource) return block('blocked_gate', DETAIL.leaseResourceMismatch);
        if (op.lease.epoch !== leaseEpoch(op.device, op.lease.resource)) return block('blocked_gate', DETAIL.leaseEpochStale);
      } else if (!legacy && LEASE_REQUIRED.has(op.action)) {
        return block('blocked_gate', DETAIL.leaseMissing);
      }
    }
    // R-T5: zwischen Einreichen und Ausführen hat sich der Freigabezustand geändert → verfallen.
    if (rel(op.device).gen !== adm.gen) return block('blocked_gate', DETAIL.epochStale);
    // A.5: der Not-Halt-Durchgang braucht einen Eigentumsbeleg (im Legacy-Modus entscheidet der Pfad wie heute).
    if (!legacy && op.action === 'haltNeutralize' && owners.candidates(op.device, op.point).length === 0) {
      return block('skipped_not_owned', DETAIL.notControlled);
    }
    return null;
  }

  function checkConstraint(op, pol) {
    // Not-Halt-Durchgang und Zwangsfreigabe schreiben nur Grundzustand (Vorprüfung 1) — eine Einschränkung hält
    // eine Rücknahme nie auf.
    if (HALT_EXEMPT.has(op.action)) return null; // Wert ist in Vorprüfung 1 als Grundzustands-Literal geprüft
    let verdict;
    try {
      verdict = checkConstraints(op, pol);
    } catch {
      verdict = { ok: false, reason: 'checker_error' };
    }
    // Fail-closed: nur ein synchrones `{ ok: true }` lässt durch (auch ein Promise sperrt).
    if (verdict && verdict.ok === true) return null;
    return block('blocked_gate', DETAIL.constraint, { reason: typeof verdict?.reason === 'string' ? verdict.reason : 'constraint' });
  }

  function checkUnchanged(op) {
    // Legacy: der Pfad entscheidet wie heute selbst (Schreib-Cache, Rücklesung). Vertrag: wie Rust nur `write`;
    // Lebenszeichen, Schritte und Rücknahmen schreiben immer.
    if (op.legacy || op.kind !== 'write') return null;
    const o = owners.get(op.device, op.point);
    if (o && !o.truncated && o.uncertain.length === 0 && o.inflight.length === 0 && o.confirmed !== null && o.confirmed === op.value) {
      return block('skipped_unchanged', undefined);
    }
    return null;
  }

  // --- Ergebnis und Ereignis ---------------------------------------------------------------------------------------

  function emit(op, opId, res, pol, sinkKind) {
    if (typeof onEvent !== 'function') return;
    const ro = (() => { try { return isReadOnly() === true; } catch { return true; } })();
    /** @type {WriteEvent} */
    const ev = {
      schema: 'dvhub.write/1',
      impl: 'node',
      mode: 'live',
      ts_ms: now(),
      tick: { loop: op.tick.loop, seq: op.tick.seq },
      decision_id: `${op.tick.loop}-${op.tick.seq}-${op.point}`, // Rust-Form (lib.rs `event`)
      op_id: opId,
      layer: 'semantic',
      target: { kind: EVENT_TARGET_KIND[sinkKind] ?? pol?.targetKind ?? null, device: op.device },
      point: op.point,
      value: {
        eng: op.value,
        ...(pol?.unit ? { unit: pol.unit } : {}),
        ...(op.requested !== undefined ? { requested: op.requested } : {}),
      },
      cause: { source: op.source, gates: [], ...(op.ruleId ? { rule_id: op.ruleId } : {}) },
      kind: op.kind,
      action: op.action,
      step: op.step,
      lease: op.lease ? { resource: op.lease.resource, epoch: op.lease.epoch } : null,
      outcome: res.outcome,
      delivery: res.delivery,
      error: 'error' in res ? String(res.error?.message ?? res.error) : null,
      ...(res.detail ? { detail: res.detail } : {}),
      trust: res.trust,
      inputs_ref: null,
      config_rev: configRev,
      state_flags: { not_halt: haltedNow().halted, forced_off: false, read_only: ro, license_pro: licensePro === true },
    };
    try { onEvent(ev); } catch { /* Ereignis-Abnehmer darf das Schreiben nicht stören */ }
  }

  function finalize(op, opId, r, pol, sinkKind) {
    const delivery = r.delivery ?? null;
    /** @type {SubmitResult} */
    const res = {
      opId,
      outcome: r.outcome,
      delivery,
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.blockedBy ? { blockedBy: r.blockedBy } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.exceptionCode != null ? { exceptionCode: r.exceptionCode } : {}),
      trust: op.legacy ? 'legacy' : 'contract',
      // B.5 Zusatzfelder — `ok` des Pfads bleibt im Legacy-Modus, wie er ist; nichts wird umgedeutet.
      delivered: delivery === 'acked',
      pickup: r.detail === DETAIL.pickupPending,
      possiblyEffective: delivery === 'acked' || delivery === 'unknown',
    };
    if ('result' in r) res.result = r.result;
    if ('error' in r) res.error = r.error;
    emit(op, opId, res, pol, sinkKind);
    return res;
  }

  // --- Bewertung einer Operation ------------------------------------------------------------------------------------

  async function evaluate(op, opId, adm, run = null) {
    let pol = null;
    let decided = null;
    try {
      pol = policyOf(op.device, op.point);
      const checks = {
        halt: () => checkHalt(op, pol, adm, run),
        deadline: () => checkDeadline(op),
        readOnly: () => checkReadOnly(op),
        release: () => checkRelease(op),
        target: () => checkTarget(op, pol),
        lease: () => checkLease(op, pol, adm),
        constraint: () => checkConstraint(op, pol),
        unchanged: () => checkUnchanged(op),
      };
      // Die Reihenfolge steht allein in PRE_CHECKS (constants.js).
      for (const name of PRE_CHECKS) {
        const hit = checks[name]();
        if (hit) {
          decided = { ...hit, blockedBy: name };
          break;
        }
      }
    } catch {
      decided = { outcome: 'blocked_gate', detail: DETAIL.gateError, blockedBy: 'shape' }; // fail-closed
    }
    if (decided) return finalize(op, opId, decided, pol, (op.legacy ? own(sinks, op.legacy.sink) : own(sinks, pol?.sink))?.kind);

    // Zustellung: Senke wählen.
    const spec = op.legacy ? own(sinks, op.legacy.sink) : own(sinks, pol.sink);
    const fn = op.legacy ? own(spec?.legacy, op.legacy.fn) : own(spec, 'write');
    if (typeof fn !== 'function') {
      return finalize(op, opId, { outcome: 'blocked_gate', detail: DETAIL.noSink, blockedBy: 'dispatch' }, pol, spec?.kind);
    }
    const r = rel(op.device);
    if (r.state === 'profileInvalid' && op.action === 'safetyRelease') r.passDone.add(op.point); // auch ein Abbruch zählt
    // Besitz beginnt VOR dem Senden (A.3).
    const attempt = owners.begin(op.device, op.point, op.value, op.source, now());

    let out;
    let err;
    let threw = false;
    try {
      if (op.legacy) {
        out = await fn(...op.legacy.args); // unverändert: dieselben Argument-Objekte, keine Zusätze
      } else {
        const t = now();
        const wireOp = {
          opId, device: op.device, point: op.point, value: op.value, kind: op.kind, action: op.action,
          step: op.step, lease: op.lease, remainingMs: op.validUntilMs === null ? null : op.validUntilMs - t,
        };
        // Sperrmarke für alle Senken (R-L6): eine Senke mit eigener Warteschlange fragt direkt vor dem Draht.
        const ctx = {
          isCurrent: () => rel(op.device).gen === adm.gen
            && (!op.lease || op.lease.epoch === leaseEpoch(op.device, op.lease.resource))
            && (HALT_EXEMPT.has(op.action) || (!haltedNow().halted && !adm.halted && adm.fence === fenceGen)),
        };
        out = await fn(wireOp, ctx);
      }
    } catch (e) {
      err = e;
      threw = true;
    }

    let classified;
    try {
      classified = threw
        ? (spec.classifyError || defaultErrorClassifier(spec.kind))(err)
        : (spec.classifyResult ? spec.classifyResult(out) : classifySinkResult(spec.kind, out));
    } catch {
      classified = { delivery: 'unknown' }; // Einordnung kaputt: im Zweifel womöglich angekommen (IOP-5)
    }
    const delivery = DELIVERIES.includes(classified?.delivery) ? classified.delivery : 'unknown';
    owners.finish(op.device, op.point, attempt, delivery);
    const r2 = {
      outcome: threw ? 'error' : 'ok',
      delivery,
      ...(classified?.detail ? { detail: classified.detail } : {}),
      ...(classified?.exceptionCode != null ? { exceptionCode: classified.exceptionCode } : {}),
    };
    if (threw) r2.error = err;
    else r2.result = out;
    return finalize(op, opId, r2, pol, spec.kind);
  }

  function enqueue(device, task) {
    const prev = chains.get(device) || Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(device, tail);
    tail.then(() => { if (chains.get(device) === tail) chains.delete(device); });
    return run;
  }

  /**
   * Eine Schreibabsicht prüfen und ggf. zustellen. Vertragsoperationen laufen je Gerät nacheinander (wie das Rust-Tor
   * unter seiner Sperre); die Vorprüfungen laufen direkt vor der Zustellung. Legacy-Operationen werden nicht
   * eingereiht — der Pfad ruft heute direkt, und die Reihenfolge auf dem Draht soll gleich bleiben.
   * `opts.run`: Lauf-Zulassung (admitLegacyRun) — gilt nur für eine Legacy-Operation an genau dieses Gerät und nur,
   * wenn dieses Tor sie ausgegeben hat; sonst wird sie übergangen (Regel ohne Zulassung).
   * @param {GateOp} op
   * @param {{ run?: object }} [opts]
   * @returns {Promise<SubmitResult>}
   */
  async function submit(op, opts = undefined) {
    const invalid = validateOp(op);
    if (invalid) {
      invalidCounter += 1;
      return {
        opId: `invalid-${invalidCounter}`,
        outcome: 'blocked_gate',
        delivery: null,
        detail: DETAIL.invalidOp,
        blockedBy: 'shape',
        reason: invalid,
        trust: op && op.legacy ? 'legacy' : 'contract',
        delivered: false,
        pickup: false,
        possiblyEffective: false,
      };
    }
    const opId = nextOpId(op);
    // Zulassung: Epoche, Not-Halt-Sperrmarke und Not-Halt jetzt festhalten (R-T5, R-L6).
    const { halted } = haltedNow();
    const adm = { gen: rel(op.device).gen, fence: fenceGen, halted };
    if (op.legacy) {
      const r = opts?.run;
      const run = r && issuedRuns.has(r) && r.device === op.device ? r : null;
      return evaluate(op, opId, adm, run);
    }
    return enqueue(op.device, () => evaluate(op, opId, adm));
  }

  return {
    submit,
    admitLegacyRun,
    setRelease,
    fence,
    releaseState: (device) => rel(device).state,
    releaseGeneration: (device) => rel(device).gen,
    leaseEpoch,
    advanceLeaseEpoch,
    setPolicies,
    setDevicePolicies,
    setReleased,
    attachSink,
    owned: (device, point) => owners.get(device, point),
  };
}
