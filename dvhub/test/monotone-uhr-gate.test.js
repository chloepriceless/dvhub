// A23 b (Christin 23.11.2026): Das Schreibtor misst die Frist einer Operation (validUntilMs) monoton. validUntilMs
// bleibt laut Vertrag ein Wanduhr-Zeitpunkt; das Tor rechnet ihn beim Einreichen einmal in eine Restzeit um und
// misst diese mit der monotonen Uhr — auch während die Operation in der Warteschlange des Geräts steht.
// opId, Ereignisse (ts_ms = Wanduhr) und Prüfreihenfolge bleiben unverändert.
import test from 'node:test';
import assert from 'node:assert/strict';

import { rig, deferred } from './helpers/gate-rig.js';

function clockedRig(extra = {}) {
  const c = { wall: 1_700_000_000_000, mono: 5000 };
  const hold = deferred();
  let first = true;
  const r = rig({
    ...extra,
    sinkWrite: (wireOp) => {
      if (first) { first = false; return hold.promise.then(() => ({ ack: true })); }
      return { ack: true, remainingMs: wireOp.remainingMs };
    },
    gateOptions: { now: () => c.wall, monoNow: () => c.mono },
  });
  return { r, c, hold };
}

test('Tor: Rücksprung der Wanduhr während der Warteschlange — abgelaufene Frist sperrt trotzdem', async () => {
  const { r, c, hold } = clockedRig();
  const a = r.gate.submit(r.op({ value: 170 }));
  const b = r.gate.submit(r.op({ value: 187, validUntilMs: c.wall + 5000 }));
  c.wall -= 3_600_000; c.mono += 10_000; // 10 s Laufzeit vergehen, die Uhr springt 1 h zurück
  hold.resolve();
  assert.equal((await a).outcome, 'ok');
  const rb = await b;
  assert.equal(rb.outcome, 'blocked_gate');
  assert.equal(rb.detail, 'expired');
  assert.equal(rb.blockedBy, 'deadline');
});

test('Tor: Sprung vorwärts während der Warteschlange — gültige Frist läuft nicht vorzeitig ab, Restzeit monoton', async () => {
  const { r, c, hold } = clockedRig();
  const a = r.gate.submit(r.op({ value: 170 }));
  const b = r.gate.submit(r.op({ value: 187, validUntilMs: c.wall + 5000 }));
  c.wall += 3_600_000; c.mono += 1000;
  hold.resolve();
  await a;
  const rb = await b;
  assert.equal(rb.outcome, 'ok');
  const call = r.calls.find((x) => x.wireOp?.value === 187);
  assert.equal(call.wireOp.remainingMs, 4000);
  // Ereignis-Zeit bleibt Wanduhr.
  const ev = r.events.find((e) => e.op_id === rb.opId);
  assert.equal(ev.ts_ms, c.wall);
});

test('Tor: Frist schon beim Einreichen abgelaufen → gesperrt wie bisher (Wanduhr-Vergleich beim Einreichen)', async () => {
  const { r, c, hold } = clockedRig();
  hold.resolve();
  const res = await r.gate.submit(r.op({ value: 170, validUntilMs: c.wall - 1 }));
  assert.equal(res.detail, 'expired');
  const ok = await r.gate.submit(r.op({ value: 187, validUntilMs: null }));
  assert.equal(ok.outcome, 'ok');
});
