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
function startFakeGx({ silentAddress = 1, shortFor = null, byteCountLie = null, slowAddress = null, slowMs = 0 } = {}) {
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
          if (address === slowAddress) setTimeout(() => { if (!socket.destroyed) socket.write(res); }, slowMs);
          else socket.write(res);
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

test('A4 (Codex a24eeff6): der Leerlauf-Timer der verworfenen Verbindung bricht die neue nicht ab', async () => {
  // Erfolg arms den Leerlauf-Timer (hier 300 ms), dann Zeitüberschreitung,
  // dann eine langsame, gesunde Anfrage über die neue Verbindung, die über
  // das Ende des alten Timers hinausläuft.
  const gx = await startFakeGx({ slowAddress: 70, slowMs: 200 });
  const transport = createModbusTransport({ idleMs: 300 });
  try {
    assert.deepEqual(await transport.mbRequest(read(gx.port, 10)), [10, 11]);
    await assert.rejects(() => transport.mbRequest(read(gx.port, 1, 150)), /modbus timeout/);
    assert.deepEqual(await transport.mbRequest(read(gx.port, 70)), [70, 71]);
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

// A6: Ein Lese-Aufruf mit Schreib-Funktionscode wäre ein gültiger Write
// gewesen (FC 6: „quantity“ = Wert). A8: übergroße Rahmen/unbegrenzte Schlange.

test('A6: mbRequest mit Schreib-Funktionscode wird abgelehnt, kein Rahmen erreicht das Gerät', async () => {
  let frames = 0;
  const server = net.createServer((socket) => { socket.on('data', () => { frames += 1; }); socket.on('error', () => {}); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const transport = createModbusTransport();
  try {
    for (const fc of [5, 6, 15, 16, 22, 23, 43, 0, undefined]) {
      await assert.rejects(
        () => transport.mbRequest({ host: '127.0.0.1', port: server.address().port, unitId: 100, fc, address: 2716, quantity: 1000, timeoutMs: 200 }),
        /keine Lese-Funktion/, `fc ${fc}`);
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(frames, 0, 'kein Rahmen am Gerät');
  } finally {
    await transport.destroy();
    await new Promise((r) => server.close(r));
  }
});

test('A8: Rahmen mit Längenfeld > 254 (über 260 Byte) ist ungültig statt bis 64 KiB zu warten', async () => {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (req) => {
      const res = Buffer.alloc(9);
      req.copy(res, 0, 0, 4);
      res.writeUInt16BE(0xfff0, 4);           // behauptet ~64 KiB
      res.writeUInt8(req.readUInt8(6), 6);
      res.writeUInt8(3, 7);
      res.writeUInt8(4, 8);
      socket.write(res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const transport = createModbusTransport();
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => transport.mbRequest({ host: '127.0.0.1', port: server.address().port, unitId: 100, fc: 3, address: 10, quantity: 2, timeoutMs: 2000 }),
      /invalid modbus frame length/);
    assert.ok(Date.now() - t0 < 1500, 'sofort, nicht erst nach der Zeitüberschreitung');
  } finally {
    await transport.destroy();
    await new Promise((r) => server.close(r));
  }
});

test('A8: Warteschlange je Verbindung begrenzt (256)', async () => {
  const server = net.createServer((socket) => { socket.on('error', () => {}); });   // antwortet nie
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const transport = createModbusTransport();
  try {
    const req = { host: '127.0.0.1', port: server.address().port, unitId: 100, fc: 3, address: 10, quantity: 1, timeoutMs: 100 };
    const all = Array.from({ length: 300 }, () => transport.mbRequest(req).then(() => 'ok', (e) => e.message));
    const results = await Promise.race([
      Promise.all(all.slice(257)),
      new Promise((r) => setTimeout(() => r(null), 1000)),
    ]);
    assert.ok(Array.isArray(results), 'überzählige Anfragen scheitern sofort');
    assert.ok(results.every((m) => /modbus queue full/.test(m)), results.slice(0, 3).join(' | '));
  } finally {
    await transport.destroy();
    await new Promise((r) => server.close(r));
  }
});

// A7: Beim Not-Halt eingereihte, noch nicht gesendete Writes gingen danach
// noch auf den Draht. Jetzt verwirft die Schreib-Sperre (fenceModbusWrites)
// alles, was vorher eingereiht wurde; die eine Rücknahme danach geht raus.

function startEchoGx(delayMs) {
  return new Promise((resolve) => {
    const seen = [];
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 12) {
          const req = Buffer.from(buf.subarray(0, 12));
          buf = buf.subarray(12);
          const fc = req.readUInt8(7);
          seen.push({ fc, address: req.readUInt16BE(8), value: req.readUInt16BE(10) });
          let res;
          if (fc === 6) res = Buffer.from(req);                  // FC6: Echo
          else {
            res = Buffer.alloc(11);
            req.copy(res, 0, 0, 4);
            res.writeUInt16BE(5, 4); res.writeUInt8(req.readUInt8(6), 6); res.writeUInt8(fc, 7);
            res.writeUInt8(2, 8); res.writeUInt16BE(42, 9);
          }
          setTimeout(() => { if (!socket.destroyed) socket.write(res); }, delayMs);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, seen,
      close: () => new Promise((r) => { server.close(r); }),
    }));
  });
}

test('A7: vor dem Not-Halt eingereihte Writes gehen nicht mehr raus, die Rücknahme danach schon', async () => {
  const { fenceModbusWrites } = await import('../transport-modbus.js');
  const gx = await startEchoGx(150);
  const transport = createModbusTransport();
  const base = { host: '127.0.0.1', port: gx.port, unitId: 100, timeoutMs: 1000 };
  try {
    const readP = transport.mbRequest({ ...base, fc: 3, address: 10, quantity: 1 });       // läuft
    const stale = transport.mbWriteSingle({ ...base, address: 2716, value: 5000 })          // wartet
      .then(() => 'gesendet', (e) => e.message);
    await new Promise((r) => setTimeout(r, 30));
    fenceModbusWrites();
    const neutral = transport.mbWriteSingle({ ...base, address: 2716, value: 0 });
    assert.deepEqual(await readP, [42], 'eine Lesung läuft weiter');
    assert.match(await stale, /Not-Halt/);
    assert.equal((await neutral).value, 0);
    assert.deepEqual(gx.seen.filter((f) => f.fc === 6).map((f) => f.value), [0], 'nur die Rücknahme am Gerät');
  } finally {
    await transport.destroy();
    await gx.close();
  }
});

test('A7: setEmergencyStop setzt die Schreib-Sperre, bevor es neutralisiert', async () => {
  const { modbusWriteFenceGeneration } = await import('../transport-modbus.js');
  const { setEmergencyStop } = await import('../services/control-commands.js');
  const before = modbusWriteFenceGeneration();
  let genAtNeutralize = null;
  const ctx = {
    state: { ctrl: {} },
    pushLog: () => {},
    applyControlTarget: async () => { genAtNeutralize = modbusWriteFenceGeneration(); return { ok: true }; },
  };
  const r = await setEmergencyStop(ctx, { on: true });
  assert.equal(r.ok, true);
  assert.equal(genAtNeutralize, before + 1);
  // Schon im Not-Halt: keine zweite Sperre nötig.
  await setEmergencyStop(ctx, { on: true });
  assert.equal(modbusWriteFenceGeneration(), before + 1);
});

test('A7 (Codex 56e41b93, P2): verwirft die Sperre alles, wird die Verbindung nach Leerlauf trotzdem abgebaut', async () => {
  const { fenceModbusWrites } = await import('../transport-modbus.js');
  let closed = 0;
  const server = net.createServer((socket) => { socket.on('error', () => {}); socket.on('close', () => { closed += 1; }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const transport = createModbusTransport({ idleMs: 150 });
  try {
    const p = transport.mbWriteSingle({ host: '127.0.0.1', port: server.address().port, unitId: 100, address: 2716, value: 1, timeoutMs: 1000 })
      .then(() => 'gesendet', (e) => e.message);
    fenceModbusWrites();                       // noch vor dem Verbindungsaufbau
    assert.match(await p, /Not-Halt/);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(closed, 1, 'Verbindung nach Leerlauf geschlossen');
  } finally {
    await transport.destroy();
    await new Promise((r) => server.close(r));
  }
});
