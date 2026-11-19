// test/modbus-health.test.js — Modbus-Gesundheit je WR (N5, Feld 16.11.).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModbusHealth, classifyModbusError } from '../services/inverter/modbus-health.js';

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

// --- M22 (Christin 19.11.): jeder Modbus-Fehler je WR ins Log, Häufungen zusammengefasst, Fehlerart richtig ---------
const failingTx = (mkErr) => ({
  type: 'modbus',
  async mbRequest() { throw mkErr(); }, async mbWriteSingle() { throw mkErr(); }, async mbWriteMultiple() { throw mkErr(); },
});
const refused = () => Object.assign(new Error('connect ECONNREFUSED 192.168.68.83:502'), { code: 'ECONNREFUSED' });

test('M22: ECONNREFUSED ist „refused" (im Feld fälschlich „timeout")', async () => {
  const c = clockFrom(1_000_000);
  const h = createModbusHealth(c.now);
  const tx = h.wrap(failingTx(refused));
  await assert.rejects(() => tx.mbRequest({ fc: 4, address: 12999, quantity: 46 }));
  assert.equal(h.snapshot().lastError.kind, 'refused');
  assert.equal(h.snapshot().lastError.code, 'ECONNREFUSED');
});

test('M22: Einordnung — Ausnahme mit Nummer, Timeout, Verbindungsabbruch, nicht erreichbar, sonst', () => {
  assert.deepEqual(classifyModbusError('modbus exception 4'), { kind: 'exception', code: 4 });
  assert.deepEqual(classifyModbusError('connect ECONNREFUSED 1.2.3.4:502', 'ECONNREFUSED'), { kind: 'refused', code: 'ECONNREFUSED' });
  assert.deepEqual(classifyModbusError('connect ECONNREFUSED 1.2.3.4:502'), { kind: 'refused', code: 'ECONNREFUSED' });
  assert.equal(classifyModbusError('modbus timeout').kind, 'timeout');
  assert.equal(classifyModbusError('modbus connect timeout').kind, 'timeout');
  assert.deepEqual(classifyModbusError('read ECONNRESET', 'ECONNRESET'), { kind: 'reset', code: 'ECONNRESET' });
  assert.equal(classifyModbusError('connection closed').kind, 'reset');
  assert.deepEqual(classifyModbusError('connect EHOSTUNREACH 1.2.3.4:502', 'EHOSTUNREACH'), { kind: 'unreachable', code: 'EHOSTUNREACH' });
  assert.equal(classifyModbusError('invalid modbus response').kind, 'other');
});

test('M22: der erste Fehler wird eine Log-Zeile sungrow_modbus_error {wr, kind, code, fc, address, register, value, message}', async () => {
  const c = clockFrom(1_000_000);
  const logs = [];
  const h = createModbusHealth(c.now, { pushLog: (event, data, level) => logs.push({ event, data, level }), wr: 'slave', source: 'ems' });
  const tx = h.wrap(failingTx(() => new Error('modbus exception 4')));
  await assert.rejects(() => tx.mbWriteSingle({ host: 'x', address: 13051, value: 1200 }));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'sungrow_modbus_error');
  assert.equal(logs[0].level, 'warn');
  const d = logs[0].data;
  assert.deepEqual([d.wr, d.source, d.kind, d.code, d.fc, d.address, d.register, d.value], ['slave', 'ems', 'exception', 4, 6, 13051, 13052, 1200]);
  assert.match(d.message, /exception 4/);
  assert.equal(d.host, undefined, 'keine LAN-Adresse im Log');
});

test('M22: Häufung im 60-s-Fenster wird EINE Zusammenfassung — „12 Fehler in 60 s, Master, ECONNREFUSED"', async () => {
  const c = clockFrom(1_000_000);
  const logs = [];
  const h = createModbusHealth(c.now, { pushLog: (event, data, level) => logs.push({ event, data, level }), wr: 'master' });
  const tx = h.wrap(failingTx(refused));
  for (let i = 0; i < 12; i += 1) { await assert.rejects(() => tx.mbRequest({ fc: 4, address: 5213, quantity: 2 })); c.advance(5000); }
  assert.equal(logs.length, 1, 'nur der erste Fehler einzeln');
  h.snapshot(); // Fenster abgelaufen (60 s) → Zusammenfassung
  assert.equal(logs.length, 2);
  assert.equal(logs[1].event, 'sungrow_modbus_error_summary');
  assert.equal(logs[1].data.count, 12);
  assert.equal(logs[1].data.text, '12 Fehler in 60 s, Master, ECONNREFUSED');
  assert.deepEqual(logs[1].data.kinds, { refused: 12 });
  // Die Kachel behält Zähler und letzten Fehler.
  assert.equal(h.snapshot().errors24h, 12);
  assert.equal(h.snapshot().lastError.kind, 'refused');
});

test('M22: Dauerstörung (1 Fehler je 5 s, 1 h) läuft nicht über — Zusammenfassungen werden seltener', async () => {
  const c = clockFrom(1_000_000);
  const logs = [];
  const h = createModbusHealth(c.now, { pushLog: (event, data, level) => logs.push({ event, data, level }), wr: 'slave', source: 'poll' });
  const tx = h.wrap(failingTx(refused));
  for (let i = 0; i < 720; i += 1) { await assert.rejects(() => tx.mbRequest({ fc: 4, address: 12999, quantity: 46 })); c.advance(5000); }
  h.snapshot();
  assert.ok(logs.length <= 10, `höchstens ~10 Zeilen je Stunde: ${logs.length}`);
  const total = logs.reduce((n, l) => n + (l.event === 'sungrow_modbus_error_summary' ? l.data.count : 1), 0);
  assert.ok(total >= 700, `alle Fehler gezählt (${total})`);
  // Nach einer ruhigen Minute ist der nächste Fehler wieder sofort einzeln im Log.
  c.advance(16 * 60_000); h.snapshot();
  const before = logs.length;
  await assert.rejects(() => tx.mbRequest({ fc: 4, address: 12999, quantity: 46 }));
  assert.equal(logs.length, before + 1);
  assert.equal(logs.at(-1).event, 'sungrow_modbus_error');
});

test('M22: ohne pushLog keine Log-Zeilen (nur Zähler wie bisher)', async () => {
  const c = clockFrom(1_000_000);
  const h = createModbusHealth(c.now);
  const tx = h.wrap(failingTx(refused));
  await assert.rejects(() => tx.mbRequest({ fc: 4, address: 1, quantity: 1 }));
  assert.equal(h.snapshot().errors24h, 1);
});

// --- Codex 7dd3cd43 (P2): Ruhe nach dem letzten Fehler, keine LAN-Adresse, FC16-Wert ----------------------------
test('Codex 7dd3cd43 P2: nach einer fehlerfreien Minute ist ein einzelner Fehler wieder sofort einzeln im Log', async () => {
  const c = clockFrom(1_000_000);
  const logs = [];
  const h = createModbusHealth(c.now, { pushLog: (event, data, level) => logs.push({ event, data, level }), wr: 'master' });
  let fail = true;
  const tx = h.wrap({ type: 'modbus', async mbRequest() { if (fail) throw new Error('modbus timeout'); return [1]; }, async mbWriteSingle() {}, async mbWriteMultiple() {} });
  await assert.rejects(() => tx.mbRequest({ fc: 4, address: 1, quantity: 1 }));  // 0 s
  c.advance(5000);
  await assert.rejects(() => tx.mbRequest({ fc: 4, address: 1, quantity: 1 }));  // 5 s
  fail = false;
  for (let i = 0; i < 12; i += 1) { c.advance(5000); await tx.mbRequest({ fc: 4, address: 1, quantity: 1 }); } // bis 65 s fehlerfrei
  c.advance(10000);                                                               // 75 s: 70 s nach dem letzten Fehler
  fail = true;
  const before = logs.length;
  await assert.rejects(() => tx.mbRequest({ fc: 4, address: 5213, quantity: 2 }));
  assert.equal(logs.length, before + 1, 'sofort eine Zeile');
  assert.equal(logs.at(-1).event, 'sungrow_modbus_error');
  assert.equal(logs.at(-1).data.register, 5214);
});

test('Codex 7dd3cd43 P2: keine LAN-Adresse in Meldung und letztem Fehler (ECONNREFUSED nennt sonst IP:Port)', async () => {
  const c = clockFrom(1_000_000);
  const logs = [];
  const h = createModbusHealth(c.now, { pushLog: (event, data, level) => logs.push({ event, data, level }), wr: 'slave', source: 'poll' });
  const tx = h.wrap(failingTx(refused));
  await assert.rejects(() => tx.mbRequest({ host: '192.168.68.83', port: 502, fc: 4, address: 12999, quantity: 46 }));
  const all = JSON.stringify(logs) + JSON.stringify(h.snapshot());
  assert.doesNotMatch(all, /192\.168\.68\.83/, 'keine IP im Log oder in der Kachel');
  assert.doesNotMatch(all, /:502\b/, 'kein Port');
  assert.match(logs[0].data.message, /ECONNREFUSED/);
  assert.equal(logs[0].data.kind, 'refused');
});

test('Codex 7dd3cd43 P2: FC16-Write behält den geschriebenen Wert (Herzschlag 13080 = 30)', async () => {
  const c = clockFrom(1_000_000);
  const logs = [];
  const h = createModbusHealth(c.now, { pushLog: (event, data, level) => logs.push({ event, data, level }), wr: 'master' });
  const tx = h.wrap(failingTx(() => new Error('modbus exception 3')));
  await assert.rejects(() => tx.mbWriteMultiple({ address: 13079, values: [30] }));
  const d = logs[0].data;
  assert.deepEqual([d.fc, d.address, d.register, d.value, d.quantity], [16, 13079, 13080, 30, 1]);
  await assert.rejects(() => tx.mbWriteMultiple({ address: 13049, values: [2, 0xbb, 1200] }));
  c.advance(61_000); h.snapshot();
});
