import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createModbusTransport } from '../transport-modbus.js';

function startModbusServer(handler) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const response = handler(chunk);
        if (response) socket.write(response);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        async close() {
          await new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())));
        }
      });
    });
  });
}

test('mbWriteSingle surfaces Modbus exception responses', async () => {
  const server = await startModbusServer((request) => {
    const response = Buffer.alloc(9);
    request.copy(response, 0, 0, 7);
    response.writeUInt16BE(3, 4);
    response.writeUInt8(0x86, 7);
    response.writeUInt8(2, 8);
    return response;
  });
  const transport = createModbusTransport();

  try {
    await assert.rejects(
      () => transport.mbWriteSingle({
        host: '127.0.0.1',
        port: server.port,
        unitId: 100,
        address: 2848,
        value: 1,
        timeoutMs: 1000
      }),
      /modbus exception 2/
    );
  } finally {
    await transport.destroy();
    await server.close();
  }
});

test('mbWriteMultiple surfaces Modbus exception responses', async () => {
  const server = await startModbusServer((request) => {
    const response = Buffer.alloc(9);
    request.copy(response, 0, 0, 7);
    response.writeUInt16BE(3, 4);
    response.writeUInt8(0x90, 7);
    response.writeUInt8(2, 8);
    return response;
  });
  const transport = createModbusTransport();

  try {
    await assert.rejects(
      () => transport.mbWriteMultiple({
        host: '127.0.0.1',
        port: server.port,
        unitId: 100,
        address: 2848,
        values: [1, 2],
        timeoutMs: 1000
      }),
      /modbus exception 2/
    );
  } finally {
    await transport.destroy();
    await server.close();
  }
});

// Plan 25-04 (Befund 4) — Connect-Timeout gegen toten/firewalled Host.
// Ein stiller SYN-Drop (totes Gerät / Firewall-DROP) darf den Poll-Zyklus NICHT
// bis zum OS-Default-TCP-Connect-Timeout (~75-130 s) blockieren. Test verbindet
// auf die nicht-routbare TEST-NET/Blackhole-Adresse 10.255.255.1, die SYN ohne
// Antwort schluckt, und prüft, dass die Promise innerhalb einer Zeitschranke
// rejected statt zu hängen.
test('mbWriteSingle rejects within connect timeout against a blackhole host', async () => {
  const transport = createModbusTransport({ connectTimeoutMs: 300 });
  const start = Date.now();

  try {
    await assert.rejects(
      () => transport.mbWriteSingle({
        host: '10.255.255.1',
        port: 502,
        unitId: 1,
        address: 100,
        value: 0,
        timeoutMs: 5000
      }),
      /connect timeout/
    );
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 2000,
      `connect timeout did not abort in time: ${elapsed}ms (expected < 2000ms)`
    );
  } finally {
    await transport.destroy();
  }
});

// Plan 25-04 — Lebend-Regression: der Connect-Timeout-Guard darf gesunde Connects
// NICHT killen. Ein normaler Write gegen einen lebenden lokalen Server muss
// erfolgreich antworten (kein fälschlicher Connect-Timeout-Abbruch).
test('mbWriteSingle still succeeds against a live server with connect timeout set', async () => {
  const server = await startModbusServer((request) => {
    // Echo a valid FC=6 write-single ack back.
    const response = Buffer.alloc(12);
    request.copy(response, 0, 0, 12);
    response.writeUInt16BE(6, 4);
    return response;
  });
  const transport = createModbusTransport({ connectTimeoutMs: 5000 });

  try {
    const ack = await transport.mbWriteSingle({
      host: '127.0.0.1',
      port: server.port,
      unitId: 100,
      address: 2848,
      value: 1,
      timeoutMs: 1000
    });
    assert.equal(ack.addr, 2848);
    assert.equal(ack.value, 1);
  } finally {
    await transport.destroy();
    await server.close();
  }
});
