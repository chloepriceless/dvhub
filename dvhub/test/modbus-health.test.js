// test/modbus-health.test.js — Modbus-Gesundheit je WR (N5, Feld 16.11.).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModbusHealth } from '../services/inverter/modbus-health.js';

function clockFrom(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('wrap zählt erfolgreiche Anfragen, misst Antwortzeit, reicht das Ergebnis durch', async () => {
  const c = clockFrom(1_000_000);
  const h = createModbusHealth(c.now);
  const base = { type: 'modbus', async mbRequest(a) { c.advance(20); return ['ok', a.address]; }, async mbWriteSingle() {}, async mbWriteMultiple() {} };
  const tx = h.wrap(base);
  assert.equal(tx.type, 'modbus');
  const r = await tx.mbRequest({ address: 5 });
  assert.deepEqual(r, ['ok', 5], 'Ergebnis unverändert durchgereicht');
  const s = h.snapshot();
  assert.equal(s.totalRequests, 1);
  assert.equal(s.responseMs, 20);
  assert.equal(s.errors24h, 0);
  assert.equal(s.lastError, null);
});

test('Fehler werden nach Art eingeordnet und als letzter Fehler gemerkt', async () => {
  const c = clockFrom(2_000_000);
  const h = createModbusHealth(c.now);
  const tx = h.wrap({ type: 'modbus', async mbRequest() { throw new Error('modbus exception 4'); }, async mbWriteSingle() {}, async mbWriteMultiple() {} });
  await assert.rejects(() => tx.mbRequest({ address: 1 }), /exception 4/);
  const s = h.snapshot();
  assert.equal(s.errors24h, 1);
  assert.equal(s.lastError.kind, 'exception');
  assert.match(s.lastError.message, /exception 4/);
  assert.equal(s.lastError.at, 2_000_000);
});

test('Timeout wird als timeout eingeordnet', async () => {
  const c = clockFrom(3_000_000);
  const h = createModbusHealth(c.now);
  const tx = h.wrap({ type: 'modbus', async mbRequest() { throw new Error('modbus timeout'); }, async mbWriteSingle() {}, async mbWriteMultiple() {} });
  await assert.rejects(() => tx.mbRequest({ address: 1 }));
  assert.equal(h.snapshot().lastError.kind, 'timeout');
});

test('Fehler älter als 24 h zählen nicht mehr in errors24h', () => {
  const c = clockFrom(10_000_000);
  const h = createModbusHealth(c.now);
  h.record(false, 0, 'modbus exception 2');     // t0
  c.advance(23 * 3600_000);
  h.record(false, 0, 'modbus timeout');         // +23 h
  assert.equal(h.snapshot().errors24h, 2, 'beide innerhalb 24 h');
  c.advance(2 * 3600_000);                       // +25 h ab t0 → der erste fällt raus
  assert.equal(h.snapshot().errors24h, 1);
});

test('Anfragen/s über das 10-s-Fenster', () => {
  const c = clockFrom(5_000_000);
  const h = createModbusHealth(c.now);
  // 10 Anfragen über 9 s (1 je 1000 ms) → ~1/s.
  for (let i = 0; i < 10; i += 1) { h.record(true, 5); c.advance(1000); }
  const s = h.snapshot();
  assert.ok(s.requestsPerSec >= 0.9 && s.requestsPerSec <= 1.3, `rate ${s.requestsPerSec}`);
  // Nach 20 s Stille fällt die Rate auf 0 (Fenster leer).
  c.advance(20_000);
  assert.equal(h.snapshot().requestsPerSec, 0);
});

test('null-Transport wird unverändert zurückgegeben (kein Wrap)', () => {
  const h = createModbusHealth();
  assert.equal(h.wrap(null), null);
});
