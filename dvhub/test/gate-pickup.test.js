// Abholpuffer hinter dem Tor (VCL-Vertrag v6 D.1 R-T3): gate.pickupVerdict() und die Abholsenke
// services/gate/pickup.js im Einzelnen. Verhalten an Route und Publisher: test/integration-pickup-suspended.test.js;
// Bit-Gleichheit im Normalbetrieb gegen 24eabf21: test/gate-pickup-parity.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGate } from '../services/gate/index.js';
import { createLegacyGate, inverterReleaseState, INVERTER_GATE_DEVICE } from '../services/gate/legacy.js';
import { createPickupSink, PICKUP_GATE_DEVICES, PICKUP_SUSPENDED, suspensionOf } from '../services/gate/pickup.js';
import {
  buildControlSnapshot, buildGridLimitSnapshot, controlSnapshotFlat, gridLimitSnapshotFlat,
} from '../services/control-snapshot.js';

const T0 = 1_789_000_000_000;

function makeState() {
  return {
    ctrl: { forcedOff: true, discretionaryWritesPaused: false },
    victron: { gridSetpointW: -100, minSocPct: 20 },
    schedule: {
      rules: [{ id: 'abend', optimizer: 'eos' }],
      active: { gridSetpointW: { value: -2500, source: 'rule:abend', at: T0 }, feedExcessDcPv: { value: 1, source: 'runtime', at: T0 } },
    },
    p14a: { active: true, limitW: 4200, source: 'relay', shares: { wp: 4200 } },
    eebus: { applied: { productionLimitW: 3000 } },
  };
}

describe('gate.pickupVerdict (R-T3)', () => {
  it('urteilt mit den Vorprüfungen 1 Not-Halt, 3 Lese-Modus, 4 Schreibfreigabe — in dieser Reihenfolge', () => {
    let halted = false;
    let ro = false;
    const gate = createGate({ isHalted: () => halted, isReadOnly: () => ro });
    assert.deepEqual(gate.pickupVerdict('dev'), { open: false, outcome: 'blocked_gate', detail: 'setup_incomplete', blockedBy: 'release' },
      'nie gemeldet = Einrichtung unvollständig (fail-closed wie submit)');
    gate.setRelease('dev', 'open');
    assert.deepEqual(gate.pickupVerdict('dev'), { open: true });
    gate.setRelease('dev', 'profileInvalid');
    assert.deepEqual(gate.pickupVerdict('dev'), { open: false, outcome: 'blocked_gate', detail: 'profile_invalid', blockedBy: 'release' });
    ro = true;
    assert.deepEqual(gate.pickupVerdict('dev'), { open: false, outcome: 'blocked_readonly', detail: 'read_only', blockedBy: 'readOnly' });
    halted = true;
    assert.deepEqual(gate.pickupVerdict('dev'), { open: false, outcome: 'blocked_nothalt', detail: 'not_halt', blockedBy: 'halt' });
  });

  it('unlesbarer Not-Halt- bzw. Lese-Modus-Zustand sperrt (fail-closed)', () => {
    const g1 = createGate({ isHalted: () => { throw new Error('x'); } });
    g1.setRelease('dev', 'open');
    assert.equal(g1.pickupVerdict('dev').detail, 'halt_state_unknown');
    const g2 = createGate({ isReadOnly: () => { throw new Error('x'); } });
    g2.setRelease('dev', 'open');
    assert.equal(g2.pickupVerdict('dev').detail, 'read_only_state_unknown');
  });

  it('kein Ereignis, keine Lese-Modus-Zählung, keine opId — Abholen ist kein Schreibversuch', async () => {
    const events = [];
    let noted = 0;
    const gate = createGate({
      isReadOnly: () => true, onReadOnlyBlock: () => { noted += 1; }, onEvent: (e) => events.push(e),
      sinks: { s: { kind: 'pickup', write: async () => ({}) } },
      policies: { dev: { p: { class: 'c', sink: 's', neutral: { kind: 'never' } } } }, released: ['c'],
    });
    gate.setRelease('dev', 'open');
    for (let i = 0; i < 5; i += 1) assert.equal(gate.pickupVerdict('dev').blockedBy, 'readOnly');
    assert.equal(noted, 0);
    assert.equal(events.length, 0);
    const res = await gate.submit({
      device: 'dev', point: 'p', value: 1, source: 't', kind: 'write', action: 'command', lease: null,
      constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null, tick: { loop: 'eval', seq: 1 }, step: 0,
    });
    assert.equal(res.opId, 'eval-1-dev-p-0', 'opId-Folge unberührt');
    assert.equal(noted, 1, 'ein echter Schreibversuch zählt weiter');
  });

  it('verlangt ein Gerät', () => {
    assert.throws(() => createGate().pickupVerdict(''), TypeError);
  });
});

describe('services/gate/pickup.js', () => {
  it('suspensionOf: Grund je Urteil', () => {
    assert.equal(suspensionOf({ open: true }), null);
    assert.equal(suspensionOf({ open: false, blockedBy: 'halt', detail: 'not_halt' }), 'not_halt');
    assert.equal(suspensionOf({ open: false, blockedBy: 'halt', detail: 'halt_state_unknown' }), 'not_halt');
    assert.equal(suspensionOf({ open: false, blockedBy: 'readOnly' }), 'read_only');
    assert.equal(suspensionOf({ open: false, blockedBy: 'release', detail: 'profile_invalid' }), 'config_unsafe');
    assert.equal(suspensionOf({ open: false, blockedBy: 'release', detail: 'setup_incomplete' }), 'not_released');
    assert.equal(suspensionOf(undefined), 'gate_error');
    for (const v of ['not_halt', 'read_only', 'config_unsafe', 'not_released', 'gate_error']) assert.ok(PICKUP_SUSPENDED.includes(v));
  });

  it('offen: genau die bisherigen Bausteine (dieselben Werte, scheduleActive dieselbe Referenz, kein Grund-Feld)', () => {
    const state = makeState();
    const sink = createPickupSink({ state, getCfg: () => ({}) });
    const h = sink.handOut(T0);
    assert.equal(h.suspended, null);
    assert.equal(h.gridLimitSuspended, null);
    assert.deepEqual(h.control, buildControlSnapshot(state, T0));
    assert.deepEqual(h.gridLimit, buildGridLimitSnapshot(state));
    assert.equal(sink.scheduleActive(h), state.schedule.active);
    const flat = sink.flat(h);
    assert.deepEqual(Object.entries(flat), Object.entries({ ...controlSnapshotFlat(buildControlSnapshot(state)), ...gridLimitSnapshotFlat(buildGridLimitSnapshot(state)) }),
      'gleiche Schlüssel in gleicher Reihenfolge');
  });

  it('Not-Halt: „keine Vorgabe“ in der Form ohne jeden Sollwert, Status bleibt', () => {
    const state = makeState();
    state.ctrl.discretionaryWritesPaused = true;
    const sink = createPickupSink({ state, getCfg: () => ({}) });
    const h = sink.handOut(T0);
    assert.equal(h.suspended, 'not_halt');
    assert.equal(h.gridLimitSuspended, 'not_halt');
    assert.deepEqual(h.control, { ...buildControlSnapshot({ ctrl: state.ctrl }, T0), suspended: 'not_halt' });
    assert.equal(h.control.paused, true);
    assert.equal(h.control.forcedOff, true, 'Status forcedOff läuft weiter');
    assert.deepEqual(h.gridLimit, buildGridLimitSnapshot({}));
    assert.deepEqual(sink.scheduleActive(h), { gridSetpointW: null, feedExcessDcPv: null });
    assert.equal(state.schedule.active.gridSetpointW.value, -2500, 'der Puffer selbst bleibt unangetastet');
    assert.equal(sink.flat(h).dvhub_control_suspended, 'not_halt');
  });

  it('ungültige Config: nur das Gerät inverter ist zu; das Tor bekommt dieselbe Schreibfreigabe wie submitInverter', () => {
    const state = makeState();
    const cfg = { writeSafety: { ok: false, reason: 'manufacturer_profile_error' } };
    const gate = createLegacyGate({ isHalted: () => false });
    const sink = createPickupSink({ state, getCfg: () => cfg, getGate: () => gate });
    const h = sink.handOut(T0);
    assert.equal(h.suspended, 'config_unsafe');
    assert.equal(h.gridLimitSuspended, null);
    assert.deepEqual(h.gridLimit, buildGridLimitSnapshot(state));
    assert.equal(gate.releaseState(INVERTER_GATE_DEVICE), inverterReleaseState(cfg));
    assert.equal(gate.releaseState(PICKUP_GATE_DEVICES.gridLimit), 'open');
    cfg.writeSafety = { ok: true };
    assert.equal(sink.handOut(T0).suspended, null);
    assert.equal(gate.releaseState(INVERTER_GATE_DEVICE), 'open');
  });

  it('inverterReleaseState: nur writeSafety.ok === false sperrt', () => {
    assert.equal(inverterReleaseState(undefined), 'open');
    assert.equal(inverterReleaseState({}), 'open');
    assert.equal(inverterReleaseState({ writeSafety: { ok: true } }), 'open');
    assert.equal(inverterReleaseState({ writeSafety: {} }), 'open');
    // Christin 19.11.2026: bei ungültigem Herstellerprofil dürfen Not-Halt-Rücknahme und Zwangsfreigabe durch
    // (profileInvalid); ohne belegten Grund — wie bei kaputter config.json — sperrt das Tor alles (setupIncomplete,
    // test/c2-nothalt-release.test.js). Bis dahin hieß auch das profileInvalid.
    assert.equal(inverterReleaseState({ writeSafety: { ok: false } }), 'setupIncomplete');
    assert.equal(inverterReleaseState({ writeSafety: { ok: false, reason: 'manufacturer_profile_error' } }), 'profileInvalid');
  });

  it('kaputte config.json (Tor setupIncomplete) heißt nach außen weiter config_unsafe', () => {
    const state = makeState();
    const gate = createLegacyGate({ isHalted: () => false });
    const sink = createPickupSink({ state, getCfg: () => ({ writeSafety: { ok: false, reason: 'config_broken' } }), getGate: () => gate });
    const h = sink.handOut(T0);
    assert.equal(gate.releaseState(INVERTER_GATE_DEVICE), 'setupIncomplete');
    assert.equal(h.suspended, 'config_unsafe');
    assert.equal(sink.flat(h).dvhub_control_suspended, 'config_unsafe');
    assert.equal(h.gridLimitSuspended, null);
    assert.equal(h.dvSignalSuspended, null);
  });

  it('Tor nicht befragbar: nichts herausgeben (gate_error)', () => {
    const state = makeState();
    const sink = createPickupSink({ state, getCfg: () => ({}), getGate: () => ({ setRelease() { throw new Error('kaputt'); } }) });
    const h = sink.handOut(T0);
    assert.equal(h.suspended, 'gate_error');
    assert.equal(h.gridLimitSuspended, 'gate_error');
    assert.equal(h.dvSignalSuspended, 'gate_error');
    assert.deepEqual(sink.dvSignal(h, () => 0), { dvControlValue: null, forcedOff: null, suspended: 'gate_error' });
    assert.equal(h.control.values.gridSetpointW.value, null);
    assert.equal(h.gridLimit.active, false);
  });

  // Direktvermarkter-Signal (dvControlValue, forcedOff) für Loxone/HA und die Datenfluss-Übersicht. Christin 19.11.2026:
  // „im Not-Halt sollte das eigentlich auch stoppen, das DV-Signal“ — im Not-Halt und Lese-Modus „kein Signal“ (wie beim
  // Gerät gridLimit/§14a), bei ungültiger Konfiguration läuft es weiter (DVhub kann dann selbst nicht abregeln).
  describe('DV-Signal', () => {
    it('offen: genau die bisherigen Werte (controlValue(), state.ctrl.forcedOff roh), kein Grund', () => {
      const state = makeState();
      const sink = createPickupSink({ state, getCfg: () => ({}) });
      const h = sink.handOut(T0);
      assert.equal(h.dvSignalSuspended, null);
      assert.deepEqual(sink.dvSignal(h, () => 0), { dvControlValue: 0, forcedOff: true });
      state.ctrl.forcedOff = undefined;
      assert.deepEqual(sink.dvSignal(h, () => 1), { dvControlValue: 1, forcedOff: undefined }, 'roh wie bisher');
    });

    it('Not-Halt: kein Signal (null) mit Grund not_halt; der Lease-Ablauf läuft weiter (controlValue wird gefragt)', () => {
      const state = makeState();
      state.ctrl.discretionaryWritesPaused = true;
      const sink = createPickupSink({ state, getCfg: () => ({}) });
      const h = sink.handOut(T0);
      assert.equal(h.dvSignalSuspended, 'not_halt');
      let asked = 0;
      assert.deepEqual(sink.dvSignal(h, () => { asked += 1; return 0; }), { dvControlValue: null, forcedOff: null, suspended: 'not_halt' });
      assert.equal(asked, 1, 'controlValue() läuft weiter (Lease-Ablauf in server.js)');
      assert.equal(state.ctrl.forcedOff, true, 'der Zustand selbst bleibt');
    });

    it('Lese-Modus: kein Signal (read_only)', () => {
      const state = makeState();
      const gate = createLegacyGate({ isHalted: () => false, isReadOnly: () => true });
      const sink = createPickupSink({ state, getCfg: () => ({}), getGate: () => gate });
      const h = sink.handOut(T0);
      assert.equal(h.dvSignalSuspended, 'read_only');
      assert.deepEqual(sink.dvSignal(h, () => 0), { dvControlValue: null, forcedOff: null, suspended: 'read_only' });
    });

    it('ungültige Config (C2): das Signal läuft weiter, nur die Sollwerte sind zu', () => {
      const state = makeState();
      const gate = createLegacyGate({ isHalted: () => false });
      const sink = createPickupSink({ state, getCfg: () => ({ writeSafety: { ok: false, reason: 'manufacturer_profile_error' } }), getGate: () => gate });
      const h = sink.handOut(T0);
      assert.equal(h.suspended, 'config_unsafe');
      assert.equal(h.dvSignalSuspended, null);
      assert.deepEqual(sink.dvSignal(h, () => 0), { dvControlValue: 0, forcedOff: true });
      assert.equal(gate.releaseState(PICKUP_GATE_DEVICES.dvSignal), 'open');
    });
  });

  it('publishMirror: 15 Steuer-Topics retained in fester Reihenfolge, Text roh, sonst JSON', () => {
    const state = makeState();
    const published = [];
    const topics = [];
    const sink = createPickupSink({ state, getCfg: () => ({}) });
    sink.publishMirror({ publish: (t, p, o) => published.push([t, p, o]) }, 'pfx', topics, T0);
    assert.deepEqual(published.map(([t]) => t), [
      'pfx/control/grid_setpoint_w', 'pfx/control/charge_current_a', 'pfx/control/min_soc_pct', 'pfx/control/max_discharge_w',
      'pfx/control/source', 'pfx/control/rule', 'pfx/control/updated_at', 'pfx/control/paused', 'pfx/control/state',
      'pfx/control/grid_limit/active', 'pfx/control/grid_limit/source', 'pfx/control/grid_limit/consumption_w',
      'pfx/control/grid_limit/production_w', 'pfx/control/grid_limit/production_blocked', 'pfx/control/grid_limit/state',
    ]);
    assert.deepEqual(topics, published.map(([t]) => t));
    assert.ok(published.every(([, , o]) => o.retain === true));
    assert.equal(published[0][1], '-2500');
    assert.equal(published[4][1], 'eos', 'Text roh');
    assert.equal(published[10][1], 'relay');
  });
});
