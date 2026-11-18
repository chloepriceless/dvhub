// Node-Schreibtor: Zustell-Einordnung (VCL-Vertrag v6 §0.2, B.5, H-6) und ihre Folge für den Besitz (A.3).
//
// H-6: Modbus-Ausnahmen nach Code, nicht pauschal — 01/02/03 → rejected, 04/05/06/08/0A/0B → unknown.
// Rust-Abweichung R-9: modbus_sink.rs macht heute jede Ausnahme zu Rejected.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  classifyModbusError, classifySinkError, classifySinkResult, modbusExceptionCode, MODBUS_EXCEPTION_DELIVERY,
} from '../services/gate/index.js';
import { createModbusTransport } from '../transport-modbus.js';
import { ReadOnlyViolation } from '../read-only-guard.js';
import { rig, DEVICE } from './helpers/gate-rig.js';

// Die Tabelle aus §0.2 / H-6, ausgeschrieben.
const H6 = [
  [0x01, 'rejected'], [0x02, 'rejected'], [0x03, 'rejected'],
  [0x04, 'unknown'], [0x05, 'unknown'], [0x06, 'unknown'], [0x08, 'unknown'], [0x0a, 'unknown'], [0x0b, 'unknown'],
];

test('H-6 Tabelle: Modbus-Ausnahme-Code → Zustellung', () => {
  for (const [code, delivery] of H6) {
    // So wirft transport-modbus.js: `modbus exception ${frame.readUInt8(8)}` (dezimal).
    assert.deepEqual(classifyModbusError(new Error(`modbus exception ${code}`)), { delivery, exceptionCode: code }, `Text ${code}`);
    assert.equal(classifyModbusError({ exceptionCode: code }).delivery, delivery, `Feld ${code}`);
  }
  assert.deepEqual(Object.keys(MODBUS_EXCEPTION_DELIVERY).map(Number).sort((a, b) => a - b), H6.map(([c]) => c));
});

test('H-6: nicht gelistete Ausnahme-Codes sind unknown (im Zweifel womöglich angekommen)', () => {
  for (const code of [0x07, 0x09, 0x0c, 0x7f, 0xff]) {
    assert.equal(classifyModbusError(new Error(`modbus exception ${code}`)).delivery, 'unknown', `Code ${code}`);
  }
});

test('Modbus ohne Ausnahme: nur nachweislich nie gesendet ist notSent, alles nach dem Senden unknown', () => {
  const notSent = [
    new ReadOnlyViolation('Schreibzugriff im Lese-Modus abgelehnt (Modbus fc=6)'),
    new Error('modbus queue full'),
    new Error('modbus write verworfen (Not-Halt seit dem Einreihen)'),
    new Error('modbus write multiple: empty values'),
    new Error('modbus write multiple: too many values'),
    new Error('modbus connect timeout'),
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:502'), { code: 'ECONNREFUSED' }),
  ];
  for (const e of notSent) assert.equal(classifyModbusError(e).delivery, 'notSent', e.message);
  const unknown = [
    new Error('modbus timeout'),
    new Error('connection closed'),
    new Error('invalid write ack'),
    new Error('invalid write ack (address 1 ≠ 2)'),
    new Error('pool cleanup'),
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    new Error('irgendwas'),
  ];
  for (const e of unknown) assert.equal(classifyModbusError(e).delivery, 'unknown', e.message);
  assert.equal(modbusExceptionCode(new Error('modbus timeout')), null);
});

test('andere Senken: Fehler nur über err.delivery oder Lese-Modus eingeordnet, sonst unknown; pushOnly/Abholung = pickupPending', () => {
  assert.equal(classifySinkError(Object.assign(new Error('x'), { delivery: 'notSent' })).delivery, 'notSent');
  assert.equal(classifySinkError(Object.assign(new Error('x'), { delivery: 'acked' })).delivery, 'unknown', 'acked ist kein Fehler');
  assert.equal(classifySinkError(new ReadOnlyViolation('ro')).delivery, 'notSent');
  assert.equal(classifySinkError(new Error('MQTT nicht verbunden')).delivery, 'unknown', 'kein Raten aus Meldungstexten');
  assert.deepEqual(classifySinkResult('mqtt', { ok: true, pushOnly: true }), { delivery: 'unknown', detail: 'pickupPending' });
  assert.deepEqual(classifySinkResult('pickup', undefined), { delivery: 'unknown', detail: 'pickupPending' });
  assert.deepEqual(classifySinkResult('mqtt', { ok: true, topic: 'W/x' }), { delivery: 'acked' });
  assert.deepEqual(classifySinkResult('modbus', undefined), { delivery: 'acked' });
});

// --- an der echten Grenze: transport-modbus.js gegen einen lokalen Server mit Ausnahme-Antworten ------------------

function exceptionServer(code) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', (req) => {
        const res = Buffer.alloc(9);
        req.copy(res, 0, 0, 7);
        res.writeUInt16BE(3, 4);
        res.writeUInt8(req.readUInt8(7) | 0x80, 7);
        res.writeUInt8(code, 8);
        socket.write(res);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      // Der Transport hält die Verbindung im Pool offen (Leerlauf 30 s) — beim Schließen hart trennen.
      close: () => new Promise((done) => { for (const s of sockets) s.destroy(); server.close(() => done()); }),
    }));
  });
}

test('echte Grenze: Ausnahmen aus transport-modbus.js werden über das Tor nach H-6 eingeordnet', async () => {
  const transport = createModbusTransport();
  const r = rig({ legacy: { mbWriteSingle: (a) => transport.mbWriteSingle(a), mbWriteMultiple: (a) => transport.mbWriteMultiple(a) } });
  try {
    for (const [code, delivery] of [[2, 'rejected'], [3, 'rejected'], [4, 'unknown'], [6, 'unknown'], [11, 'unknown']]) {
      const srv = await exceptionServer(code);
      try {
        const args = { host: '127.0.0.1', port: srv.port, unitId: 1, address: 13050, value: 2, timeoutMs: 1000 };
        const res = await r.gate.submit(r.op({ lease: null, point: 'emsMode', value: 2, legacy: { sink: 'inv', fn: 'mbWriteSingle', args: [args] } }));
        assert.deepEqual([res.outcome, res.delivery, res.exceptionCode], ['error', delivery, code], `Ausnahme ${code}`);
        assert.match(res.error.message, new RegExp(`modbus exception ${code}`));
      } finally {
        await srv.close();
      }
    }
  } finally {
    await transport.destroy();
  }
});

// --- Folge für den Besitz (A.3, deckungsgleich mit Rust owner.rs) -----------------------------------------------------

test('Besitz: acked bestätigt, unknown bleibt unsicher, rejected/notSent ändert nichts', async () => {
  let fail = null;
  const r = rig({ sinkWrite: async () => { if (fail) throw fail; return {}; } });
  assert.equal((await r.gate.submit(r.op({ value: 170 }))).delivery, 'acked');
  assert.deepEqual(r.gate.owned(DEVICE, 'emsCmd').confirmed, 170);

  fail = new Error('modbus exception 2'); // rejected: nachgewiesene Nichtwirkung
  await r.gate.submit(r.op({ value: 187 }));
  let o = r.gate.owned(DEVICE, 'emsCmd');
  assert.deepEqual([o.confirmed, o.uncertain], [170, []], 'rejected ändert den Besitz nicht');

  fail = new Error('modbus queue full'); // notSent
  await r.gate.submit(r.op({ value: 187 }));
  o = r.gate.owned(DEVICE, 'emsCmd');
  assert.deepEqual([o.confirmed, o.uncertain], [170, []]);

  fail = new Error('modbus exception 4'); // unknown: zählt als angekommen
  await r.gate.submit(r.op({ value: 204 }));
  o = r.gate.owned(DEVICE, 'emsCmd');
  assert.deepEqual([o.confirmed, o.uncertain], [170, [204]]);

  // Mit unsicherem Kandidaten ist nichts „unverändert“ — auch nicht der bestätigte Wert.
  fail = null;
  const again = await r.gate.submit(r.op({ value: 170 }));
  assert.equal(again.outcome, 'ok');
  o = r.gate.owned(DEVICE, 'emsCmd');
  assert.deepEqual([o.confirmed, o.uncertain], [170, []]);
  const skip = await r.gate.submit(r.op({ value: 170 }));
  assert.equal(skip.outcome, 'skipped_unchanged');
});

test('Senke liefert unbekannten Zustellwert → unknown (vorsichtig)', async () => {
  const r = rig({ sinks: { odd: { kind: 'http', write: async () => ({}), classifyResult: () => ({ delivery: 'vielleicht' }) } },
    policies: { [DEVICE]: { emsCmd: { class: 'battery_grid', resource: 'batteryControl', sink: 'odd' } } } });
  const res = await r.gate.submit(r.op());
  assert.deepEqual([res.outcome, res.delivery, res.possiblyEffective], ['ok', 'unknown', true]);
});

test('Einordner der Senke wirft → unknown, submit() wirft nie (der Write ist womöglich schon draußen)', async () => {
  const r = rig({ sinks: { odd: { kind: 'modbus', write: async () => { throw new Error('modbus timeout'); }, classifyError: () => { throw new Error('kaputt'); } } },
    policies: { [DEVICE]: { emsCmd: { class: 'battery_grid', resource: 'batteryControl', sink: 'odd' } } } });
  const res = await r.gate.submit(r.op());
  assert.deepEqual([res.outcome, res.delivery], ['error', 'unknown']);
  assert.deepEqual(r.gate.owned(DEVICE, 'emsCmd').uncertain, [170], 'Besitz hält (unknown zählt als angekommen)');
});
