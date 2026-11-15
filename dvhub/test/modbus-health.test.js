// test/modbus-health.test.js — Modbus-Gesundheit je WR (N5, Feld 16.11.).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModbusHealth } from '../services/inverter/modbus-health.js';

function clockFrom(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('wrap zählt erfolgreiche Anfragen, misst Antwortzeit (Median nach der Startphase), reicht das Ergebnis durch', async () => {
  const c = clockFrom(1_000_000);
  const h = createModbusHealth(c.now);
  const base = { type: 'modbus', async mbRequest(a) { c.advance(20); return ['ok', a.address]; }, async mbWriteSingle() {}, async mbWriteMultiple() {} };
  const tx = h.wrap(base);
  assert.equal(tx.type, 'modbus');
  // Erste Anfrage in der Startphase (60 s): wird gezählt, aber die Antwortzeit NICHT gewertet.
  const r = await tx.mbRequest({ address: 5 });
  assert.deepEqual(r, ['ok', 5], 'Ergebnis unverändert durchgereicht');
  assert.equal(h.snapshot().responseMs, null, 'Startphase: noch keine Antwortzeit');
  // Nach der Startphase: die Antwortzeit (20 ms) wird als Median gewertet.
  c.advance(61_000);
  await tx.mbRequest({ address: 6 });
  const s = h.snapshot();
  assert.equal(s.totalRequests, 2);
  assert.equal(s.responseMs, 20);
  assert.equal(s.errors24h, 0);
  assert.equal(s.lastError, null);
});

test('M7b: Antwortzeit als gleitender Median, Startphase übersprungen', () => {
  const c = clockFrom(2_000_000);
  const h = createModbusHealth(c.now);
  h.record(true, 6436); // langsamer Startwert — NICHT werten (Startphase)
  assert.equal(h.responseMs(), null);
  c.advance(61_000);
  for (const ms of [500, 100, 600, 400, 50]) h.record(true, ms);
  // Median von [50,100,400,500,600] = 400.
  assert.equal(h.responseMs(), 400, 'Median, der langsame Startwert 6436 zählt nicht');
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

test('M7b: ein GETEILTER Health zählt zwei Verbindungen zusammen (Master: Poll + EMS)', async () => {
  const c = clockFrom(1_000_000);
  const h = createModbusHealth(c.now);
  // Zwei Transporte (Poll und EMS) über DENSELBEN Health-Zähler gewickelt — wie ctx.sungrowMasterHealth beim Master.
  const poll = h.wrap({ type: 'modbus', async mbRequest() { c.advance(10); return [1]; }, async mbWriteSingle() {}, async mbWriteMultiple() {} });
  const ems = h.wrap({ type: 'modbus', async mbRequest() { c.advance(500); return [2]; }, async mbWriteSingle() {}, async mbWriteMultiple() {} });
  await poll.mbRequest({}); await poll.mbRequest({}); await ems.mbRequest({});
  assert.equal(h.snapshot().totalRequests, 3, 'Poll (2) + EMS (1) zusammen');
});
