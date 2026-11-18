// Node-Schreibtor, Vorprüfung 1 Not-Halt (VCL-Vertrag v6 A.5, A.6, D.1; Entscheidungen H-7 und H-8 vom 17.11.2026).
//
// H-7: Einzige Ausnahme im Not-Halt ist die manuelle Zwangsfreigabe (`manualForceRelease`) — ausdrückliche
//      Bedienhandlung, feste Literalfolge Richtung Grundzustand, NIE ein Sollwert.
// H-8: Min-SoC und Ladestrom (und alles mit Richtlinie `never`) werden nie zurückgesetzt — auch nicht im Durchgang.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS } from '../services/gate/index.js';
import { rig, DEVICE } from './helpers/gate-rig.js';

const force = (r, over = {}) => r.op({ action: 'manualForceRelease', kind: 'restore', lease: null, confirmedBy: 'christin', value: 204, source: 'manual_release', ...over });

test('Not-Halt: jede Aktionsklasse außer haltNeutralize und manualForceRelease ist gesperrt', async () => {
  const r = rig();
  r.flags.halt = true;
  for (const action of ACTIONS.filter((a) => a !== 'haltNeutralize' && a !== 'manualForceRelease')) {
    const res = await r.gate.submit(r.op({ action, value: 204 }));
    assert.deepEqual([res.outcome, res.detail, res.blockedBy], ['blocked_nothalt', 'not_halt', 'halt'], action);
  }
  assert.equal(r.calls.length, 0);
});

test('H-7: bestätigte Zwangsfreigabe Richtung Grundzustand geht im Not-Halt durch — ohne Lease', async () => {
  const r = rig();
  r.flags.halt = true;
  const cmd = await r.gate.submit(force(r));
  const mode = await r.gate.submit(force(r, { point: 'emsMode', value: 0, step: 1 }));
  assert.deepEqual([cmd.outcome, cmd.delivery], ['ok', 'acked']);
  assert.deepEqual([mode.outcome, mode.delivery], ['ok', 'acked']);
  assert.deepEqual(r.calls.map((c) => [c.wireOp.point, c.wireOp.value]), [['emsCmd', 204], ['emsMode', 0]]);
  assert.equal(r.events.at(-1).state_flags.not_halt, true);
});

test('H-7: Zwangsfreigabe mit einem Sollwert ist im Not-Halt gesperrt — nie ein Sollwert', async () => {
  const r = rig();
  r.flags.halt = true;
  for (const [point, value] of [['emsCmd', 170], ['emsCmd', 187], ['emsMode', 2], ['emsPower', 0], ['emsPower', 1500]]) {
    const res = await r.gate.submit(force(r, { point, value }));
    assert.deepEqual([res.outcome, res.detail], ['blocked_nothalt', 'force_release_not_neutral'], `${point}=${value}`);
  }
  assert.equal(r.calls.length, 0);
});

test('H-7: unbestätigte Zwangsfreigabe ist gesperrt — im Not-Halt und außerhalb', async () => {
  const r = rig();
  r.flags.halt = true;
  const inHalt = await r.gate.submit(force(r, { confirmedBy: undefined }));
  assert.deepEqual([inHalt.outcome, inHalt.detail], ['blocked_nothalt', 'force_release_unconfirmed']);
  r.flags.halt = false;
  const outside = await r.gate.submit(force(r, { confirmedBy: undefined }));
  assert.deepEqual([outside.outcome, outside.detail], ['blocked_gate', 'force_release_unconfirmed']);
  const setpoint = await r.gate.submit(force(r, { value: 170 }));
  assert.deepEqual([setpoint.outcome, setpoint.detail], ['blocked_gate', 'force_release_not_neutral']);
  assert.equal(r.calls.length, 0);
});

test('H-7: fester Neutralwert der Richtlinie ist ein erlaubtes Literal, jeder andere Wert nicht', async () => {
  const r = rig();
  r.flags.halt = true;
  const ok = await r.gate.submit(force(r, { point: 'feedLimitPct', value: 100 }));
  assert.equal(ok.outcome, 'ok');
  const no = await r.gate.submit(force(r, { point: 'feedLimitPct', value: 50 }));
  assert.equal(no.detail, 'force_release_not_neutral');
});

test('H-7: Zwangsfreigabe an ein nicht sicher erkanntes Gerät geht auch im Not-Halt nicht raus (Vorprüfung 4)', async () => {
  const r = rig();
  r.flags.halt = true;
  r.gate.setRelease(DEVICE, 'identityMismatch');
  const res = await r.gate.submit(force(r));
  assert.deepEqual([res.outcome, res.detail, res.blockedBy], ['blocked_gate', 'identity_mismatch', 'release']);
  r.flags.readOnly = true;
  r.gate.setRelease(DEVICE, 'open');
  const ro = await r.gate.submit(force(r));
  assert.deepEqual([ro.outcome, ro.blockedBy], ['blocked_readonly', 'readOnly'], 'Lese-Modus gewinnt auch gegen H-7');
  assert.equal(r.calls.length, 0);
});

test('H-8: Min-SoC, Ladestrom und Netz-Sollwert werden im Not-Halt nie geschrieben — weder Durchgang noch Zwangsfreigabe', async () => {
  const r = rig();
  // Besitz vorher herstellen, damit nicht „not_controlled“ entscheidet.
  for (const [point, value] of [['minSocPct', 20], ['chargeCurrentA', 50], ['gridSetpointW', -300]]) {
    const resource = point === 'gridSetpointW' ? 'gridSetpoint' : 'batteryControl';
    const w = await r.gate.submit(r.op({ point, value, lease: { resource, epoch: r.gate.leaseEpoch(DEVICE, resource) } }));
    assert.equal(w.outcome, 'ok');
  }
  const before = r.calls.length;
  r.flags.halt = true;
  for (const [point, value] of [['minSocPct', 10], ['chargeCurrentA', 0], ['gridSetpointW', 0]]) {
    const pass = await r.gate.submit(r.op({ point, value, action: 'haltNeutralize', kind: 'neutralize', lease: null, source: 'emergency_stop' }));
    assert.deepEqual([pass.outcome, pass.detail], ['skipped_not_owned', 'never_neutralized'], `Durchgang ${point}`);
    const manual = await r.gate.submit(force(r, { point, value }));
    assert.deepEqual([manual.outcome, manual.detail], ['blocked_nothalt', 'force_release_not_neutral'], `Zwangsfreigabe ${point}`);
  }
  assert.equal(r.calls.length, before, 'kein Write an Min-SoC/Ladestrom/Netz-Sollwert im Not-Halt');
});

test('Durchgang (Vertrag): haltNeutralize braucht einen Eigentumsbeleg und gilt nur im Not-Halt', async () => {
  const r = rig();
  const pass = (over = {}) => r.op({ action: 'haltNeutralize', kind: 'neutralize', lease: null, source: 'emergency_stop', value: 204, ...over });
  const outside = await r.gate.submit(pass());
  assert.deepEqual([outside.outcome, outside.detail], ['blocked_gate', 'neutralize_outside_halt']);
  r.flags.halt = true;
  const notOwned = await r.gate.submit(pass());
  assert.deepEqual([notOwned.outcome, notOwned.detail], ['skipped_not_owned', 'not_controlled']);
  r.flags.halt = false;
  assert.equal((await r.gate.submit(r.op())).outcome, 'ok'); // DVhub besitzt jetzt emsCmd = 170
  r.flags.halt = true;
  const owned = await r.gate.submit(pass());
  assert.deepEqual([owned.outcome, owned.delivery], ['ok', 'acked']);
  assert.deepEqual(r.calls.map((c) => c.wireOp.value), [170, 204]);
});

test('Durchgang (Legacy): der Pfad entscheidet über den Besitz wie heute — haltNeutralize geht ohne Register durch', async () => {
  const r = rig({ legacy: { mbWriteSingle: async (a) => ({ addr: a.address, value: a.value }) } });
  r.flags.halt = true;
  const res = await r.gate.submit(r.op({
    action: 'haltNeutralize', kind: 'neutralize', lease: null, source: 'emergency_stop', value: 204,
    legacy: { sink: 'inv', fn: 'mbWriteSingle', args: [{ host: 'sg', port: 502, unitId: 1, address: 13050, value: 204 }] },
  }));
  assert.deepEqual([res.outcome, res.trust], ['ok', 'legacy']);
  const never = await r.gate.submit(r.op({
    point: 'minSocPct', action: 'haltNeutralize', kind: 'neutralize', lease: null, source: 'emergency_stop', value: 10,
    legacy: { sink: 'inv', fn: 'mbWriteSingle', args: [{ host: 'sg', port: 502, unitId: 1, address: 13058, value: 100 }] },
  }));
  assert.deepEqual([never.outcome, never.detail], ['skipped_not_owned', 'never_neutralized'], 'H-8 gilt auch im Legacy-Modus');
  assert.equal(r.calls.length, 1);
});

test('Not-Halt-Zustand unlesbar → wie Not-Halt (fail-closed); H-7 bleibt möglich', async () => {
  const r = rig(); // nur für r.op()/force()
  const { createGate } = await import('../services/gate/index.js');
  const calls = [];
  const broken = createGate({
    sinks: { inv: { kind: 'modbus', write: (w) => { calls.push(w); return {}; } } },
    policies: { [DEVICE]: { emsCmd: { class: 'battery_grid', resource: 'batteryControl', sink: 'inv', forceRelease: [204], neutral: { kind: 'sequence', use: 'release' } } } },
    released: ['battery_grid'],
    isHalted: () => { throw new Error('control_state.json unlesbar'); },
    isReadOnly: () => false,
  });
  broken.setRelease(DEVICE, 'open');
  const cmd = await broken.submit({ ...r.op(), lease: { resource: 'batteryControl', epoch: broken.leaseEpoch(DEVICE, 'batteryControl') } });
  assert.deepEqual([cmd.outcome, cmd.detail], ['blocked_nothalt', 'halt_state_unknown']);
  const rel = await broken.submit(force(r));
  assert.equal(rel.outcome, 'ok');
  assert.equal(calls.length, 1);
});
