// Node-Schreibtor (VCL-Vertrag v6 D.1): die acht Vorprüfungen in fester Reihenfolge.
//
// Für JEDES Paar (i < j) wird eine Operation gebaut, die an Prüfung i UND an Prüfung j scheitert; erwartet wird
// immer das Ergebnis von Prüfung i. Damit ist die Reihenfolge vollständig festgehalten (28 Paare) — z. B.
// Not-Halt schlägt Lese-Modus, abgelaufene Frist schlägt „unverändert“. Kein Fall erreicht die Senke.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRE_CHECKS } from '../services/gate/index.js';
import { rig, DEVICE } from './helpers/gate-rig.js';

// Je Prüfung: wie man sie (unabhängig von den anderen) zum Scheitern bringt, und was sie dann meldet.
const FAIL = {
  halt: { setup: (r) => { r.flags.halt = true; }, expect: ['blocked_nothalt', 'not_halt'] },
  deadline: { op: (o, r) => ({ ...o, validUntilMs: r.now() - 1 }), expect: ['blocked_gate', 'expired'] },
  readOnly: { setup: (r) => { r.flags.readOnly = true; }, expect: ['blocked_readonly', 'read_only'] },
  release: { setup: (r) => { r.gate.setRelease(DEVICE, 'profileInvalid'); }, expect: ['blocked_gate', 'profile_invalid'] },
  target: { op: (o) => ({ ...o, point: 'unbekanntesZiel' }), expect: ['blocked_gate', 'unknown_target'] },
  lease: { op: (o) => ({ ...o, lease: { ...o.lease, epoch: o.lease.epoch - 1 } }), expect: ['blocked_gate', 'lease_epoch_stale'] },
  constraint: { op: (o) => ({ ...o, constraints: { ...o.constraints, set: { noGridCharge: true } } }), expect: ['blocked_gate', 'constraint'] },
  // „unverändert“: derselbe Wert wurde vorher quittiert geschrieben (Besitz bestätigt, nichts unsicher).
  unchanged: { seed: true, expect: ['skipped_unchanged', undefined] },
};

async function runWith(names) {
  const r = rig();
  let seeded = 0;
  if (names.some((n) => FAIL[n].seed)) {
    const s = await r.gate.submit(r.op());
    assert.equal(s.outcome, 'ok', 'Vorbereitung: quittierter Write');
    seeded = 1;
  }
  for (const n of names) FAIL[n].setup?.(r);
  let op = r.op();
  for (const n of names) if (FAIL[n].op) op = FAIL[n].op(op, r);
  const res = await r.gate.submit(op);
  return { r, res, seeded };
}

test('Reihenfolge der Vorprüfungen ist die aus D.1 (Rust lib.rs submit plus Freigabe, Lease, Einschränkung)', () => {
  assert.deepEqual([...PRE_CHECKS], ['halt', 'deadline', 'readOnly', 'release', 'target', 'lease', 'constraint', 'unchanged']);
});

test('ohne Befund: Write geht an die Senke, quittiert', async () => {
  const r = rig();
  const res = await r.gate.submit(r.op());
  assert.equal(res.outcome, 'ok');
  assert.equal(res.delivery, 'acked');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].wireOp.value, 170);
});

for (const name of PRE_CHECKS) {
  test(`Vorprüfung ${PRE_CHECKS.indexOf(name) + 1} (${name}) allein: sperrt bzw. lässt aus, nichts an die Senke`, async () => {
    const { r, res, seeded } = await runWith([name]);
    const [outcome, detail] = FAIL[name].expect;
    assert.equal(res.outcome, outcome);
    assert.equal(res.detail, detail);
    assert.equal(res.blockedBy, name);
    assert.equal(res.delivery, null, 'nicht versucht');
    assert.equal(res.possiblyEffective, false);
    assert.equal(r.calls.length, seeded, 'die Senke wurde nicht (erneut) gerufen');
  });
}

for (let i = 0; i < PRE_CHECKS.length; i += 1) {
  for (let j = i + 1; j < PRE_CHECKS.length; j += 1) {
    const a = PRE_CHECKS[i];
    const b = PRE_CHECKS[j];
    test(`Reihenfolge: ${i + 1} ${a} schlägt ${j + 1} ${b}`, async () => {
      const { r, res, seeded } = await runWith([a, b]);
      const [outcome, detail] = FAIL[a].expect;
      assert.equal(res.outcome, outcome, `${a} vor ${b}`);
      assert.equal(res.detail, detail);
      assert.equal(res.blockedBy, a);
      assert.equal(res.delivery, null);
      assert.equal(r.calls.length, seeded);
    });
  }
}

test('Vorprüfung 5: Freigabestufe nicht freigegeben → stage_not_released (wie Rust)', async () => {
  const r = rig({ released: ['dv_curtail'] });
  const res = await r.gate.submit(r.op());
  assert.equal(res.outcome, 'blocked_gate');
  assert.equal(res.detail, 'stage_not_released');
  assert.equal(r.calls.length, 0);
});

test('Vorprüfung 6: Lease fehlt oder gehört zu einer anderen Ressource', async () => {
  const r = rig();
  const missing = await r.gate.submit(r.op({ lease: null }));
  assert.equal(missing.detail, 'lease_missing');
  const other = await r.gate.submit(r.op({ lease: { resource: 'pvExport', epoch: r.gate.leaseEpoch(DEVICE, 'pvExport') } }));
  assert.equal(other.detail, 'lease_resource_mismatch');
  assert.equal(r.calls.length, 0);
});

test('Vorprüfung 7: Prüfer, der wirft oder ein Promise liefert, sperrt (fail-closed); Grund steht im Ergebnis', async () => {
  const throwing = rig({ checker: () => { throw new Error('kaputt'); } });
  const a = await throwing.gate.submit(throwing.op());
  assert.deepEqual([a.outcome, a.detail, a.reason], ['blocked_gate', 'constraint', 'checker_error']);
  const asyncChecker = rig({ checker: async () => ({ ok: true }) });
  const b = await asyncChecker.gate.submit(asyncChecker.op());
  assert.deepEqual([b.outcome, b.detail], ['blocked_gate', 'constraint']);
  const toy = rig();
  const c = await toy.gate.submit(toy.op({ constraints: { set: { noGridCharge: true }, caps: { chargeW: 0 }, enforcedBy: [] } }));
  assert.equal(c.reason, 'noGridCharge');
  assert.equal(throwing.calls.length + asyncChecker.calls.length + toy.calls.length, 0);
});

test('Vorprüfung 8 gilt nur für kind write: Lebenszeichen und Schrittfolgen schreiben trotz gleichem Wert', async () => {
  const r = rig();
  await r.gate.submit(r.op({ point: 'heartbeat', value: 30, kind: 'heartbeat', action: 'keepalive' }));
  const again = await r.gate.submit(r.op({ point: 'heartbeat', value: 30, kind: 'heartbeat', action: 'keepalive' }));
  assert.equal(again.outcome, 'ok');
  await r.gate.submit(r.op({ kind: 'sequenceStep' }));
  const step = await r.gate.submit(r.op({ kind: 'sequenceStep', step: 1 }));
  assert.equal(step.outcome, 'ok');
  assert.equal(r.calls.length, 4);
});

test('ungültige Operation (Form) wird vor allen Vorprüfungen gesperrt, auch im Not-Halt', async () => {
  const r = rig();
  r.flags.halt = true;
  for (const bad of [
    { ...r.op(), action: 'gridSetpoint' },          // Intent-Name statt Aktionsklasse
    { ...r.op(), extra: 1 },                        // Schlüsselmenge geschlossen (IOP-4)
    { ...r.op(), value: Number.NaN },
    { ...r.op(), tick: { loop: 'irgendwas', seq: 1 } },
    { ...r.op(), constraints: { set: { noGridCharge: 'ja' }, caps: {}, enforcedBy: [] } },
    { ...r.op(), legacy: { sink: 'inv', fn: 'mbWriteSingle' } },
    null,
  ]) {
    const res = await r.gate.submit(bad);
    assert.equal(res.outcome, 'blocked_gate');
    assert.equal(res.detail, 'invalid_op');
    assert.equal(res.blockedBy, 'shape');
  }
  // `x-`/`_`-Schlüssel werden ignoriert, nicht abgelehnt.
  r.flags.halt = false;
  const ok = await r.gate.submit({ ...r.op(), 'x-trace': 'abc', _debug: true });
  assert.equal(ok.outcome, 'ok');
});

test('unbekannter Freigabezustand: nie gemeldetes Gerät gilt als setupIncomplete (fail-closed)', async () => {
  const r = rig({ release: null });
  assert.equal(r.gate.releaseState(DEVICE), 'setupIncomplete');
  const res = await r.gate.submit(r.op());
  assert.deepEqual([res.outcome, res.detail], ['blocked_gate', 'setup_incomplete']);
});
