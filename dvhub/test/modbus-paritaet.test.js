// test/modbus-paritaet.test.js — Funde aus dem Paritätsvergleich mit dem
// Rust-Neubau (dvhub-rs docs/ABWEICHUNGEN.md A4/A5, Release 1.0.10).
//
// A4: Nach einer Zeitüberschreitung schlug der Rest des Takts mit
//     „connection closed“ fehl — das close-Ereignis des alten Sockets rief
//     _fail auf der schon neu aufgebauten Verbindung.
// A5: Eine zu kurze Lese-Antwort wurde zu fehlenden Wörtern = 0 → Netzzähler
//     „ok“ mit 0 W. Netzanschluss-Wächter und §14a-Budget hängen an meter.ok.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createModbusTransport } from '../transport-modbus.js';

// Fake-GX: FC3/FC4 liefert [addr, addr+1, …]; Adresse 1 bleibt unbeantwortet;
// `shortFor` antwortet für diese Adresse mit nur einem Register.
function startFakeGx({ silentAddress = 1, shortFor = null, byteCountLie = null } = {}) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 12) {
          const req = buf.subarray(0, 12);
          buf = buf.subarray(12);
          const address = req.readUInt16BE(8);
          const quantity = req.readUInt16BE(10);
          if (address === silentAddress) continue;
          const words = address === shortFor ? 1 : quantity;
          const byteCount = address === shortFor && byteCountLie != null ? byteCountLie : words * 2;
          const res = Buffer.alloc(9 + words * 2);
          req.copy(res, 0, 0, 4);
          res.writeUInt16BE(3 + words * 2, 4);
          res.writeUInt8(req.readUInt8(6), 6);
          res.writeUInt8(req.readUInt8(7), 7);
          res.writeUInt8(byteCount, 8);
          for (let i = 0; i < words; i += 1) res.writeUInt16BE((address + i) & 0xffff, 9 + i * 2);
          socket.write(res);
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        async close() {
          for (const s of sockets) s.destroy();
          await new Promise((done) => server.close(() => done()));
        }
      });
    });
  });
}

const read = (port, address, timeoutMs = 1000, quantity = 2) => ({
  host: '127.0.0.1', port, unitId: 100, fc: 3, address, quantity, timeoutMs
});

test('A4: eine Zeitüberschreitung trifft nur die eine Anfrage, der Rest des Takts läuft weiter', async () => {
  const gx = await startFakeGx();
  const transport = createModbusTransport();
  try {
    const [a, b, c] = await Promise.allSettled([
      transport.mbRequest(read(gx.port, 1, 150)),
      transport.mbRequest(read(gx.port, 10)),
      transport.mbRequest(read(gx.port, 20)),
    ]);
    assert.equal(a.status, 'rejected');
    assert.match(String(a.reason?.message), /modbus timeout/);
    assert.equal(b.status, 'fulfilled', `Folgeanfrage 1: ${b.reason?.message}`);
    assert.deepEqual(b.value, [10, 11]);
    assert.equal(c.status, 'fulfilled', `Folgeanfrage 2: ${c.reason?.message}`);
    assert.deepEqual(c.value, [20, 21]);
    // Auch der nächste Takt läuft über die neue Verbindung.
    assert.deepEqual(await transport.mbRequest(read(gx.port, 30)), [30, 31]);
  } finally {
    await transport.destroy();
    await gx.close();
  }
});

test('A4: nach einer Zeitüberschreitung, nacheinander abgefragt, scheitert keine Folgeanfrage', async () => {
  const gx = await startFakeGx();
  const transport = createModbusTransport();
  try {
    await assert.rejects(() => transport.mbRequest(read(gx.port, 1, 100)), /modbus timeout/);
    for (const addr of [10, 20, 30, 40]) {
      assert.deepEqual(await transport.mbRequest(read(gx.port, addr)), [addr, addr + 1]);
    }
  } finally {
    await transport.destroy();
    await gx.close();
  }
});

test('A5: zu kurze Lese-Antwort ist ein Lesefehler, keine erfundenen Nullen', async () => {
  const gx = await startFakeGx({ shortFor: 50 });
  const transport = createModbusTransport();
  try {
    await assert.rejects(() => transport.mbRequest(read(gx.port, 50, 1000, 3)), /modbus short response \(1 von 3 Registern\)/);
    // Die Verbindung bleibt danach nutzbar.
    assert.deepEqual(await transport.mbRequest(read(gx.port, 60, 1000, 3)), [60, 61, 62]);
  } finally {
    await transport.destroy();
    await gx.close();
  }
});

test('A5: Byte-Zähler größer als die gelieferten Daten → Lesefehler', async () => {
  const gx = await startFakeGx({ shortFor: 50, byteCountLie: 6 });
  const transport = createModbusTransport();
  try {
    await assert.rejects(() => transport.mbRequest(read(gx.port, 50, 1000, 3)), /modbus short response/);
  } finally {
    await transport.destroy();
    await gx.close();
  }
});

function meterState() {
  return {
    meter: { ok: true, updatedAt: 0, raw: [], grid_l1_w: 1500, grid_l2_w: 1500, grid_l3_w: 1500, grid_total_w: 4500, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-10', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
  };
}

async function pollOnceWith(regsForMeter) {
  const { createPoller } = await import('../polling.js');
  const state = meterState();
  const transport = {
    type: 'modbus',
    async mbRequest(req) {
      if (req.address === 820) return regsForMeter;
      throw new Error('nicht gebraucht');
    },
  };
  const poller = createPoller({
    state,
    getCfg: () => ({
      pollMs: 500, gridPositiveMeans: 'grid_import',
      meter: { host: '127.0.0.1', port: 502, unitId: 100, fc: 4, address: 820, quantity: 3, timeoutMs: 500 },
      points: {}, epex: { timezone: 'UTC' }, userEnergyPricing: {}, dvControl: {},
    }),
    transport, pushLog: () => {},
    energyPath: path.join(os.tmpdir(), `modbus-paritaet-${process.pid}.json`),
    onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  await poller.requestPoll();
  poller.stop?.();
  return state;
}

test('A5: Netzzähler mit weniger Registern als angefragt → meter.ok=false, kein 0-W-Wert', async () => {
  const state = await pollOnceWith([1200]);
  assert.equal(state.meter.ok, false, 'Zähler gilt als gestört');
  assert.match(String(state.meter.error), /modbus short response \(1 von 3 Registern\)/);
  // Kein erfundener Wert: der letzte echte Messwert bleibt stehen (ok=false sperrt ihn).
  assert.notEqual(state.meter.grid_l2_w, 0);
  assert.notEqual(state.meter.grid_l3_w, 0);
});

test('A5: vollständige Antwort bleibt unverändert gültig', async () => {
  const state = await pollOnceWith([100, 200, 300]);
  assert.equal(state.meter.ok, true);
  assert.equal(state.meter.grid_total_w, 600);
});
