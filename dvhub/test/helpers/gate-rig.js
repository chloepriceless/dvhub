// test/helpers/gate-rig.js — Prüfstand für das Node-Schreibtor (services/gate). Keine echte Senke, kein Gerät.

import { createGate } from '../../services/gate/index.js';

export const DEVICE = 'sungrow-master';
export const RES = 'batteryControl';

/** Richtlinien wie für den Sungrow-EMS-Pfad gedacht (Phase 2), plus H-8-Punkte und ein fester Neutralwert. */
export const POLICIES = Object.freeze({
  [DEVICE]: {
    emsCmd: { class: 'battery_grid', resource: RES, sink: 'inv', unit: '', neutral: { kind: 'sequence', use: 'release' }, forceRelease: [204] },
    emsMode: { class: 'battery_grid', resource: RES, sink: 'inv', neutral: { kind: 'sequence', use: 'release' }, forceRelease: [0] },
    emsPower: { class: 'battery_grid', resource: RES, sink: 'inv', unit: 'W', neutral: { kind: 'sequence', use: 'release' } },
    heartbeat: { class: 'battery_grid', resource: RES, sink: 'inv', unit: 's', neutral: { kind: 'never' } },
    minSocPct: { class: 'battery_grid', resource: RES, sink: 'inv', unit: '%', neutral: { kind: 'never' } },
    chargeCurrentA: { class: 'battery_grid', resource: RES, sink: 'inv', unit: 'A' }, // ohne neutral = never (H-8)
    gridSetpointW: { class: 'battery_grid', resource: 'gridSetpoint', sink: 'inv', unit: 'W', neutral: { kind: 'never' } },
    feedLimitPct: { class: 'dv_curtail', resource: 'pvExport', sink: 'inv', unit: '%', neutral: { kind: 'fixed', value: 100 } },
  },
  'sungrow-slave': {
    emsCmd: { class: 'battery_grid', resource: RES, sink: 'inv', neutral: { kind: 'sequence', use: 'release' }, forceRelease: [204] },
  },
});

/** Toy-Prüfer für Vorprüfung 7: Laden (Befehl 170) unter Netzladeverbot sperren. */
export function toyConstraintChecker(op) {
  if (op.constraints.set.noGridCharge === true && op.point === 'emsCmd' && op.value === 170) return { ok: false, reason: 'noGridCharge' };
  return { ok: true };
}

/** Steuerbarer Aufschub für Senken-Aufrufe (Warteschlangen-Tests). */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Tor mit Fake-Senke. `sinkWrite(wireOp, ctx)` und `legacy` (Name → Funktion) sind austauschbar.
 * Jeder Senken-Aufruf landet in `calls`, jedes Ereignis in `events`.
 */
export function rig({ release = 'open', released = ['battery_grid', 'dv_curtail'], sinkWrite, legacy, sinkKind = 'modbus', checker = toyConstraintChecker, policies = POLICIES, sinks: extraSinks = {} } = {}) {
  const flags = { halt: false, readOnly: false };
  const calls = [];
  const events = [];
  const readOnlyBlocks = [];
  let clock = 1_700_000_000_000;
  const legacyFns = {};
  for (const [name, fn] of Object.entries(legacy || {})) {
    legacyFns[name] = (...args) => { calls.push({ legacy: name, args }); return fn(...args); };
  }
  const gate = createGate({
    sinks: {
      inv: {
        kind: sinkKind,
        write: (wireOp, ctx) => { calls.push({ wireOp, ctx }); return sinkWrite ? sinkWrite(wireOp, ctx) : { ack: true }; },
        legacy: legacyFns,
      },
      ...extraSinks,
    },
    policies,
    released,
    isHalted: () => flags.halt,
    isReadOnly: () => flags.readOnly,
    onReadOnlyBlock: (what) => readOnlyBlocks.push(what),
    checkConstraints: checker,
    onEvent: (ev) => events.push(ev),
    now: () => clock,
  });
  if (release) {
    gate.setRelease(DEVICE, release);
    gate.setRelease('sungrow-slave', release);
  }
  const r = {
    gate, flags, calls, events, readOnlyBlocks,
    now: () => clock,
    advance(ms) { clock += ms; },
    /** Grund-Operation: Laden 170 als Befehl unter der aktuellen Lease. */
    op(over = {}) {
      const device = over.device ?? DEVICE;
      return {
        device,
        point: 'emsCmd',
        value: 170,
        source: 'rule:test',
        kind: 'write',
        action: 'command',
        lease: { resource: RES, epoch: gate.leaseEpoch(device, RES) },
        constraints: { set: {}, caps: {}, enforcedBy: [] },
        validUntilMs: null,
        tick: { loop: 'eval', seq: 7 },
        step: 0,
        ...over,
      };
    },
  };
  return r;
}
