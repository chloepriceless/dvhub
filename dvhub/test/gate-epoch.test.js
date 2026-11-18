// Node-Schreibtor: Epoche und Schreibfreigabe (VCL-Vertrag v6 A.2 R-L6, D.1 R-T2, R-T5).
//
// R-T5: Jeder Wechsel des Freigabezustands erhöht die Epoche; eingereihte Operationen mit alter Epoche verfallen
// (wie die Not-Halt-Sperrmarke in transport-modbus.js, nur für alle Senken).

import test from 'node:test';
import assert from 'node:assert/strict';

import { rig, deferred, DEVICE, RES, POLICIES } from './helpers/gate-rig.js';

test('Epoche steigt nur bei einem WECHSEL des Freigabezustands — Gerätegeneration und jede Ressource des Geräts', () => {
  const r = rig();
  const gen = r.gate.releaseGeneration(DEVICE);
  const ep = r.gate.leaseEpoch(DEVICE, RES);
  const pv = r.gate.leaseEpoch(DEVICE, 'pvExport');
  const slave = r.gate.leaseEpoch('sungrow-slave', RES);
  assert.deepEqual(r.gate.setRelease(DEVICE, 'open'), { changed: false, generation: gen }, 'gleicher Zustand: keine neue Epoche');
  assert.equal(r.gate.leaseEpoch(DEVICE, RES), ep);
  assert.deepEqual(r.gate.setRelease(DEVICE, 'notIdentified'), { changed: true, generation: gen + 1 });
  assert.equal(r.gate.leaseEpoch(DEVICE, RES), ep + 1);
  assert.equal(r.gate.leaseEpoch(DEVICE, 'pvExport'), pv + 1);
  assert.equal(r.gate.leaseEpoch('sungrow-slave', RES), slave, 'anderes Gerät unberührt');
  assert.throws(() => r.gate.setRelease(DEVICE, 'offen'), TypeError);
});

test('R-T5: eingereihte Operation mit alter Epoche verfällt, die Senke sieht sie nie', async () => {
  const hold = deferred();
  let n = 0;
  const r = rig({ sinkWrite: () => (n++ === 0 ? hold.promise : {}) });
  const first = r.gate.submit(r.op({ value: 170 }));                           // hängt in der Senke
  const queued = r.gate.submit(r.op({ point: 'emsPower', value: 1500, step: 1 })); // wartet dahinter, Epoche alt
  const forced = r.gate.submit(r.op({ action: 'manualForceRelease', kind: 'restore', lease: null, confirmedBy: 'christin', value: 204, step: 2 }));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.calls.length, 1, 'nur die erste ist an der Senke');
  r.gate.setRelease(DEVICE, 'setupIncomplete');
  r.gate.setRelease(DEVICE, 'open'); // wieder offen — aber zwei Wechsel später
  hold.resolve({ ack: true });
  const [a, b, c] = await Promise.all([first, queued, forced]);
  assert.equal(a.outcome, 'ok');
  assert.deepEqual([b.outcome, b.detail, b.blockedBy, b.delivery], ['blocked_gate', 'lease_epoch_stale', 'lease', null]);
  assert.deepEqual([c.outcome, c.detail, c.blockedBy], ['blocked_gate', 'epoch_stale', 'lease'], 'auch ohne Lease: Zulassungs-Epoche');
  assert.equal(r.calls.length, 1);
  // Eine NACH dem Wechsel gebaute Operation (aktuelle Epoche) geht durch.
  const fresh = await r.gate.submit(r.op({ point: 'emsPower', value: 1500, step: 1 }));
  assert.equal(fresh.outcome, 'ok');
});

test('Warteschlange: Vertragsoperationen eines Geräts laufen nacheinander, Vorprüfungen direkt vor der Zustellung', async () => {
  const hold = deferred();
  let n = 0;
  const r = rig({ sinkWrite: () => (n++ === 0 ? hold.promise : {}) });
  const first = r.gate.submit(r.op({ value: 170 }));
  const second = r.gate.submit(r.op({ point: 'emsPower', value: 1500, step: 1 }));
  const otherDevice = r.gate.submit(r.op({ device: 'sungrow-slave' })); // anderes Gerät: nicht blockiert
  assert.equal((await otherDevice).outcome, 'ok');
  r.flags.halt = true; // Not-Halt, während die zweite wartet
  hold.resolve({});
  assert.equal((await first).outcome, 'ok');
  const b = await second;
  assert.deepEqual([b.outcome, b.detail], ['blocked_nothalt', 'not_halt'], 'Prüfung zur Zustellzeit, nicht zur Einreichzeit');
});

test('Sperrmarke für alle Senken: ctx.isCurrent() kippt bei Freigabewechsel, neuer Lease-Epoche oder Not-Halt', async () => {
  const seen = [];
  let act = () => {};
  const r = rig({ sinkWrite: (_w, ctx) => { seen.push(ctx.isCurrent()); act(); seen.push(ctx.isCurrent()); return {}; } });
  act = () => r.gate.setRelease(DEVICE, 'notIdentified');
  await r.gate.submit(r.op());
  r.gate.setRelease(DEVICE, 'open');
  act = () => r.gate.advanceLeaseEpoch(DEVICE, RES); // Lease-Schicht vergibt die Ressource neu
  await r.gate.submit(r.op({ value: 187 }));
  act = () => { r.flags.halt = true; };
  await r.gate.submit(r.op({ value: 204 }));
  assert.deepEqual(seen, [true, false, true, false, true, false]);
});

test('Lease-Epoche neu vergeben: alte Lease ist veraltet, neue gilt', async () => {
  const r = rig();
  const old = r.op();
  const next = r.gate.advanceLeaseEpoch(DEVICE, RES);
  assert.equal((await r.gate.submit(old)).detail, 'lease_epoch_stale');
  assert.equal((await r.gate.submit(r.op({ lease: { resource: RES, epoch: next } }))).outcome, 'ok');
});

test('R-T2 profileInvalid: command/keepalive/protectiveLimit/autoRestore gesperrt, genau ein safetyRelease je Punkt', async () => {
  const r = rig();
  r.gate.setRelease(DEVICE, 'profileInvalid');
  for (const action of ['command', 'keepalive', 'protectiveLimit', 'autoRestore']) {
    const res = await r.gate.submit(r.op({ action, value: 204 }));
    assert.deepEqual([res.outcome, res.detail], ['blocked_gate', 'profile_invalid'], action);
  }
  const rel = (point, value, step) => r.op({ action: 'safetyRelease', kind: 'restore', point, value, step });
  assert.equal((await r.gate.submit(rel('emsCmd', 204, 0))).outcome, 'ok');
  assert.equal((await r.gate.submit(rel('emsMode', 0, 1))).outcome, 'ok', 'anderer Punkt derselben Ressource');
  const again = await r.gate.submit(rel('emsCmd', 204, 2));
  assert.deepEqual([again.outcome, again.detail], ['blocked_gate', 'release_pass_done']);
  // Neuer Abschnitt (gültig → wieder ungültig): wieder genau ein Durchgang.
  r.gate.setRelease(DEVICE, 'open');
  r.gate.setRelease(DEVICE, 'profileInvalid');
  assert.equal((await r.gate.submit(rel('emsCmd', 204, 3))).outcome, 'ok');
  assert.equal(r.calls.length, 3);
});

test('R-T2: ein vom Tor gesperrter Rücknahme-Versuch verbraucht den Durchgang nicht', async () => {
  const r = rig();
  r.gate.setRelease(DEVICE, 'profileInvalid');
  const stale = await r.gate.submit(r.op({ action: 'safetyRelease', kind: 'restore', value: 204, lease: { resource: RES, epoch: 0 } }));
  assert.equal(stale.detail, 'lease_epoch_stale');
  assert.equal((await r.gate.submit(r.op({ action: 'safetyRelease', kind: 'restore', value: 204 }))).outcome, 'ok');
});

test('setupIncomplete, notIdentified, identityMismatch: kein Write — auch keine Rücknahme und keine Zwangsfreigabe', async () => {
  const r = rig();
  for (const state of ['setupIncomplete', 'notIdentified', 'identityMismatch']) {
    r.gate.setRelease(DEVICE, state);
    const detail = { setupIncomplete: 'setup_incomplete', notIdentified: 'not_identified', identityMismatch: 'identity_mismatch' }[state];
    for (const over of [{}, { action: 'safetyRelease', kind: 'restore', value: 204 }, { action: 'manualForceRelease', kind: 'restore', lease: null, confirmedBy: 'christin', value: 204 }]) {
      const res = await r.gate.submit(r.op(over));
      assert.deepEqual([res.outcome, res.detail, res.blockedBy], ['blocked_gate', detail, 'release'], `${state} ${over.action || 'command'}`);
    }
  }
  assert.equal(r.calls.length, 0);
});

test('setPolicies: geänderte Richtlinie eines Geräts lässt eingereihte und laufende Operationen verfallen (Codex 7a183a18)', async () => {
  const hold = deferred();
  const seen = [];
  let n = 0;
  const r = rig({
    sinkWrite: (_w, ctx) => { seen.push(ctx.isCurrent()); return n++ === 0 ? hold.promise.then(() => { seen.push(ctx.isCurrent()); return {}; }) : {}; },
    sinks: { other: { kind: 'modbus', write: async () => ({}) } },
  });
  const first = r.gate.submit(r.op());
  const queued = r.gate.submit(r.op({ point: 'emsPower', value: 1500, step: 1 }));
  await new Promise((res) => setImmediate(res));
  const slaveEpoch = r.gate.leaseEpoch('sungrow-slave', RES);
  // Gleiche Ressource und Klasse, aber andere Senke für emsPower.
  const next = structuredClone(POLICIES);
  next[DEVICE].emsPower = { ...next[DEVICE].emsPower, sink: 'other' };
  r.gate.setPolicies(next);
  hold.resolve();
  const [a, b] = await Promise.all([first, queued]);
  assert.equal(a.outcome, 'ok');
  assert.deepEqual(seen, [true, false], 'laufende Operation: Sperrmarke kippt');
  assert.deepEqual([b.outcome, b.blockedBy], ['blocked_gate', 'lease'], 'eingereihte Operation verfällt');
  assert.equal(r.gate.leaseEpoch('sungrow-slave', RES), slaveEpoch, 'unverändertes Gerät behält seine Epoche');
});

test('setPolicies: inhaltsgleiche Richtlinien (andere Schlüsselreihenfolge) erhöhen keine Epoche', () => {
  const r = rig();
  const gen = r.gate.releaseGeneration(DEVICE);
  const ep = r.gate.leaseEpoch(DEVICE, RES);
  const reordered = Object.fromEntries(Object.entries(POLICIES).map(([d, pts]) => [d, Object.fromEntries(Object.entries(pts).reverse()
    .map(([p, pol]) => [p, Object.fromEntries(Object.entries(pol).reverse())]))]));
  r.gate.setPolicies(reordered);
  assert.equal(r.gate.releaseGeneration(DEVICE), gen);
  assert.equal(r.gate.leaseEpoch(DEVICE, RES), ep);
});
