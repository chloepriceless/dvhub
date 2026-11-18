// Node-Schreibtor, Vorprüfung 1 Not-Halt (VCL-Vertrag v6 A.5, A.6, D.1; Entscheidungen H-7 und H-8 vom 17.11.2026).
//
// H-7: Einzige Ausnahme im Not-Halt ist die manuelle Zwangsfreigabe (`manualForceRelease`) — ausdrückliche
//      Bedienhandlung, feste Literalfolge Richtung Grundzustand, NIE ein Sollwert.
// H-8: Min-SoC und Ladestrom (und alles mit Richtlinie `never`) werden nie zurückgesetzt — auch nicht im Durchgang.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS } from '../services/gate/index.js';
import { rig, deferred, DEVICE } from './helpers/gate-rig.js';

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
    policies: { [DEVICE]: { emsCmd: { class: 'battery_grid', resource: 'batteryControl', sink: 'inv', neutralValues: [204], neutral: { kind: 'sequence', use: 'release' } } } },
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

test('Durchgang: haltNeutralize schreibt nur ein Grundzustands-Literal — nie einen Sollwert unter dem Namen der Rücknahme', async () => {
  const r = rig();
  const pvLease = () => ({ resource: 'pvExport', epoch: r.gate.leaseEpoch(DEVICE, 'pvExport') });
  assert.equal((await r.gate.submit(r.op({ point: 'feedLimitPct', value: 50, lease: pvLease() }))).outcome, 'ok');
  assert.equal((await r.gate.submit(r.op())).outcome, 'ok'); // emsCmd = 170 im Besitz
  const before = r.calls.length;
  r.flags.halt = true;
  const pass = (over) => r.op({ action: 'haltNeutralize', kind: 'neutralize', lease: null, source: 'emergency_stop', ...over });
  for (const [point, value] of [['feedLimitPct', 999], ['feedLimitPct', 0], ['emsCmd', 170], ['emsCmd', 187]]) {
    const res = await r.gate.submit(pass({ point, value }));
    assert.deepEqual([res.outcome, res.detail], ['blocked_nothalt', 'neutralize_not_neutral'], `${point}=${value}`);
  }
  assert.equal(r.calls.length, before, 'kein Sollwert im Not-Halt');
  assert.equal((await r.gate.submit(pass({ point: 'feedLimitPct', value: 100 }))).outcome, 'ok', 'fester Neutralwert');
  assert.equal((await r.gate.submit(pass({ point: 'emsCmd', value: 204 }))).outcome, 'ok', 'Literal der Rücknahme-Folge');
});

test('Sperrmarke: was vor dem Not-Halt eingereiht war, geht auch nach dem Aufheben nie raus (Codex 7a183a18)', async () => {
  const hold = deferred();
  let n = 0;
  const r = rig({ sinkWrite: () => (n++ === 0 ? hold.promise : {}) });
  const first = r.gate.submit(r.op());                                            // hängt in der Senke
  const queued = r.gate.submit(r.op({ point: 'emsPower', value: 1500, step: 1 }));  // vor dem Not-Halt eingereiht
  const release = r.gate.submit(force(r, { step: 2 }));                            // Zwangsfreigabe: bleibt erlaubt
  await new Promise((res) => setImmediate(res));
  r.flags.halt = true;
  const duringHalt = r.gate.submit(r.op({ point: 'emsMode', value: 2, step: 3 }));  // im Not-Halt eingereicht
  r.flags.halt = false; // aufgehoben, bevor die Warteschlange drankommt
  hold.resolve({});
  const [a, b, c, d] = await Promise.all([first, queued, release, duringHalt]);
  assert.equal(a.outcome, 'ok');
  assert.deepEqual([b.outcome, b.detail], ['blocked_nothalt', 'fenced']);
  assert.equal(c.outcome, 'ok', 'Zwangsfreigabe Richtung Grundzustand ist nie veraltet');
  assert.deepEqual([d.outcome, d.detail], ['blocked_nothalt', 'fenced'], 'im Not-Halt eingereicht → nie');
  assert.deepEqual(r.calls.map((x) => x.wireOp.point), ['emsCmd', 'emsCmd']);
  assert.equal((await r.gate.submit(r.op({ point: 'emsPower', value: 1500, step: 4 }))).outcome, 'ok', 'neu nach dem Aufheben: geht');
});

test('Sperrmarke: gate.fence() greift auch, wenn das Tor den Not-Halt selbst nie gesehen hat; isCurrent() bleibt falsch', async () => {
  const seen = [];
  const r = rig({ sinkWrite: (_w, ctx) => { seen.push(ctx.isCurrent()); r.gate.fence(); seen.push(ctx.isCurrent()); return {}; } });
  await r.gate.submit(r.op());
  assert.deepEqual(seen, [true, false]);
  // Kurzer Not-Halt zwischen zwei Abfragen der Senke: danach weiter veraltet.
  const seen2 = [];
  const r2 = rig({ sinkWrite: (_w, ctx) => { r2.flags.halt = true; seen2.push(ctx.isCurrent()); r2.flags.halt = false; seen2.push(ctx.isCurrent()); return {}; } });
  await r2.gate.submit(r2.op());
  assert.deepEqual(seen2, [false, false]);
});
