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
