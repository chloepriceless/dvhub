// Lese-Modus (DVHUB_READ_ONLY=1): kein Schreibzugriff darf die Anlage erreichen.
//
// Der Integrationsteil misst nicht nur die geworfene Ausnahme, sondern was der
// Gegenüber tatsächlich empfängt — eine Sperre, die zwar meldet, aber trotzdem
// sendet, wäre wertlos. Der Fake-Server protokolliert deshalb jedes Byte.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  isReadOnlyMode,
  modbusWriteFunctionCode,
  MODBUS_WRITE_FUNCTION_CODES,
  resetBlockedWriteCount,
  blockedWriteCount
} from '../read-only-guard.js';

function frameWithFc(fc) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(1, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(6, 4);
  b.writeUInt8(1, 6);
  b.writeUInt8(fc, 7);
  return b;
}

test('Schreib-Funktionscodes werden erkannt, Lese-Codes nicht', () => {
  for (const fc of [5, 6, 15, 16, 22, 23]) {
    assert.equal(modbusWriteFunctionCode(frameWithFc(fc)), fc, `fc ${fc} muss als Schreibzugriff gelten`);
  }
  for (const fc of [1, 2, 3, 4]) {
    assert.equal(modbusWriteFunctionCode(frameWithFc(fc)), null, `fc ${fc} ist ein Lesezugriff`);
  }
  // Die im Victron-Profil genutzten Schreibcodes müssen enthalten sein.
  assert.ok(MODBUS_WRITE_FUNCTION_CODES.has(6));
  assert.ok(MODBUS_WRITE_FUNCTION_CODES.has(16));
});

test('zu kurze oder fehlende Rahmen werfen nicht', () => {
  assert.equal(modbusWriteFunctionCode(null), null);
  assert.equal(modbusWriteFunctionCode(Buffer.alloc(4)), null);
  assert.equal(modbusWriteFunctionCode('kein Buffer'), null);
});

test('der Modus haengt an der Umgebung, nicht an der Konfiguration', () => {
  assert.equal(isReadOnlyMode({ DVHUB_READ_ONLY: '1' }), true);
  assert.equal(isReadOnlyMode({ DVHUB_READ_ONLY: '0' }), false);
  assert.equal(isReadOnlyMode({}), false);
  assert.equal(isReadOnlyMode({ DVHUB_READ_ONLY: 'true' }), false, 'nur exakt "1" aktiviert');
});

// ── Integration: was kommt beim Geraet an? ─────────────────────────────────

/** Fake-Modbus-Server: merkt sich jedes empfangene Byte, beantwortet fc=3. */
function startFakeGx() {
  const received = [];
  const server = net.createServer((sock) => {
    sock.on('data', (buf) => {
      received.push(Buffer.from(buf));
      const tid = buf.readUInt16BE(0);
      const unit = buf.readUInt8(6);
      const fc = buf.readUInt8(7);
      if (fc === 3 || fc === 4) {
        const res = Buffer.alloc(11);
        res.writeUInt16BE(tid, 0);
        res.writeUInt16BE(0, 2);
        res.writeUInt16BE(5, 4);
        res.writeUInt8(unit, 6);
        res.writeUInt8(fc, 7);
        res.writeUInt8(2, 8);
        res.writeUInt16BE(4242, 9);
        sock.write(res);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

test('im Lese-Modus erreicht KEIN Schreib-Telegramm das Geraet', async (t) => {
  const gx = await startFakeGx();
  t.after(() => gx.server.close());

  const prev = process.env.DVHUB_READ_ONLY;
  process.env.DVHUB_READ_ONLY = '1';
  resetBlockedWriteCount();
  // Erst nach gesetzter Umgebung laden, damit der Transport frisch greift.
  const { createModbusTransport } = await import('../transport-modbus.js');
  const transport = createModbusTransport({});

  try {
    await assert.rejects(
      () => transport.mbWriteSingle({
        host: '127.0.0.1', port: gx.port, unitId: 1, address: 2700, value: 1, timeoutMs: 1000
      }),
      (err) => err.code === 'DVHUB_READ_ONLY',
      'mbWriteSingle muss im Lese-Modus abgelehnt werden'
    );

    await assert.rejects(
      () => transport.mbWriteMultiple({
        host: '127.0.0.1', port: gx.port, unitId: 1, address: 2700, values: [1, 2], timeoutMs: 1000
      }),
      (err) => err.code === 'DVHUB_READ_ONLY',
      'mbWriteMultiple muss im Lese-Modus abgelehnt werden'
    );

    // Der entscheidende Nachweis: das Geraet hat nichts gesehen.
    assert.equal(gx.received.length, 0, 'kein einziges Byte darf beim Geraet ankommen');
    assert.equal(blockedWriteCount(), 2, 'beide Versuche werden gezaehlt');

    // Lesen muss weiterhin funktionieren — sonst waere der Modus nutzlos.
    const read = await transport.mbRequest({
      host: '127.0.0.1', port: gx.port, unitId: 1, fc: 3, address: 840, quantity: 1, timeoutMs: 2000
    });
    assert.ok(read, 'Lesezugriff muss durchgehen');
    assert.ok(gx.received.length >= 1, 'der Lesezugriff erreicht das Geraet');
    assert.equal(gx.received[0].readUInt8(7), 3, 'und zwar als fc=3');
  } finally {
    if (prev === undefined) delete process.env.DVHUB_READ_ONLY; else process.env.DVHUB_READ_ONLY = prev;
  }
});

test('ohne Lese-Modus geht der Schreibzugriff normal durch', async (t) => {
  const gx = await startFakeGx();
  t.after(() => gx.server.close());

  const prev = process.env.DVHUB_READ_ONLY;
  delete process.env.DVHUB_READ_ONLY;
  const { createModbusTransport } = await import('../transport-modbus.js');
  const transport = createModbusTransport({});

  try {
    // Der Fake beantwortet fc=6 nicht -> Timeout. Entscheidend ist, dass das
    // Telegramm ueberhaupt gesendet wurde, nicht die Antwort.
    await transport.mbWriteSingle({
      host: '127.0.0.1', port: gx.port, unitId: 1, address: 2700, value: 1, timeoutMs: 300
    }).catch(() => {});
    assert.ok(gx.received.length >= 1, 'ohne Lese-Modus muss gesendet werden');
    assert.equal(gx.received[0].readUInt8(7), 6, 'als fc=6 (Write Single Register)');
  } finally {
    if (prev !== undefined) process.env.DVHUB_READ_ONLY = prev;
  }
});
