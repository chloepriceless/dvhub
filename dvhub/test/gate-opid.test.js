// Node-Schreibtor: opId je Versuch eindeutig (VCL-Vertrag v6 §0.2, Anhang I.1, H-6).
//
// Grundform `${loop}-${seq}-${device}-${point}-${step}` (Anhang I ohne Gerät — ohne Gerät kollidieren Folge- und
// Führungsgerät im selben Schritt, I.2(c)). Wiederholt sich dieselbe Grundform, hängt das Tor `~n` an.

import test from 'node:test';
import assert from 'node:assert/strict';

import { rig, DEVICE } from './helpers/gate-rig.js';

test('opId: deterministische Grundform loop-seq-device-point-step', async () => {
  const r = rig();
  const res = await r.gate.submit(r.op({ tick: { loop: 'eval', seq: 123 }, step: 2 }));
  assert.equal(res.opId, `eval-123-${DEVICE}-emsCmd-2`);
  assert.equal(r.calls[0].wireOp.opId, res.opId, 'die Senke bekommt dieselbe opId');
  assert.equal(r.events[0].op_id, res.opId, 'das Ereignis trägt dieselbe opId');
});

test('opId: derselbe Punkt zweimal im Takt (I.2 b), Folge- und Führungsgerät im selben Schritt (I.2 c) — alle verschieden', async () => {
  const r = rig();
  const tick = { loop: 'event', seq: 9 };
  const ids = [];
  ids.push((await r.gate.submit(r.op({ tick, step: 0, kind: 'sequenceStep', value: 204 }))).opId);
  ids.push((await r.gate.submit(r.op({ tick, step: 1, kind: 'sequenceStep', point: 'emsPower', value: 1500 }))).opId);
  ids.push((await r.gate.submit(r.op({ tick, step: 2, kind: 'sequenceStep', value: 170 }))).opId);
  ids.push((await r.gate.submit(r.op({ tick, step: 0, kind: 'sequenceStep', value: 204, device: 'sungrow-slave' }))).opId);
  assert.equal(new Set(ids).size, ids.length, ids.join(', '));
});

test('opId: Wiederholung derselben Operation ist ein neuer Versuch mit neuer opId — auch gesperrte Versuche zählen', async () => {
  const r = rig();
  const op = r.op();
  const a = await r.gate.submit(op);
  const b = await r.gate.submit(op); // unverändert → übersprungen, trotzdem eigener Versuch
  r.flags.halt = true;
  const c = await r.gate.submit(op);
  assert.deepEqual([a.outcome, b.outcome, c.outcome], ['ok', 'skipped_unchanged', 'blocked_nothalt']);
  assert.deepEqual([a.opId, b.opId, c.opId], [`eval-7-${DEVICE}-emsCmd-0`, `eval-7-${DEVICE}-emsCmd-0~2`, `eval-7-${DEVICE}-emsCmd-0~3`]);
});

test('opId: 2000 gemischte Versuche (gleichzeitig eingereicht) — keine Kollision', async () => {
  const r = rig();
  const points = ['emsCmd', 'emsMode', 'emsPower', 'heartbeat'];
  const jobs = [];
  for (let i = 0; i < 2000; i += 1) {
    jobs.push(r.gate.submit(r.op({ tick: { loop: i % 2 ? 'eval' : 'poll', seq: i % 37 }, point: points[i % 4], step: i % 3, value: i, kind: 'sequenceStep' })));
  }
  const ids = (await Promise.all(jobs)).map((x) => x.opId);
  assert.equal(new Set(ids).size, ids.length);
});

test('ungültige Operation bekommt eine eigene, eindeutige Kennung', async () => {
  const r = rig();
  const a = await r.gate.submit({ device: DEVICE });
  const b = await r.gate.submit({ device: DEVICE });
  assert.match(a.opId, /^invalid-\d+$/);
  assert.notEqual(a.opId, b.opId);
});
