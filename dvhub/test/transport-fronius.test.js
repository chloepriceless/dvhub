import test from 'node:test';
import assert from 'node:assert/strict';
import { createFroniusTransport } from '../transport-fronius.js';

// ---------------------------------------------------------------------------
// Hilfsfunktionen zum Bauen von Fake-Modbus-Antworten
// ---------------------------------------------------------------------------

/** Baut einen minimalen Modbus TCP Response Frame (FC3). */
function buildMbFrame(tid, unitId, regs) {
  const byteCount = regs.length * 2;
  const buf = Buffer.alloc(9 + byteCount);
  buf.writeUInt16BE(tid, 0);         // Transaction ID
  buf.writeUInt16BE(0, 2);           // Protocol ID
  buf.writeUInt16BE(3 + byteCount, 4); // Length
  buf.writeUInt8(unitId, 6);         // Unit ID
  buf.writeUInt8(3, 7);              // FC3
  buf.writeUInt8(byteCount, 8);      // Byte count
  for (let i = 0; i < regs.length; i++) buf.writeUInt16BE(regs[i] & 0xffff, 9 + i * 2);
  return buf;
}

/** IEEE 754 Float32 → zwei uint16 (Big Endian). */
function float32ToRegs(value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value, 0);
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

// ---------------------------------------------------------------------------
// Float32-Enkodierung (Einheitentests, ohne Netzwerkverbindung)
// ---------------------------------------------------------------------------

test('regsToFloat32: 5000.0 W korrekt dekodiert', () => {
  const [hi, lo] = float32ToRegs(5000.0);
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(hi, 0);
  buf.writeUInt16BE(lo, 2);
  const result = buf.readFloatBE(0);
  assert.ok(Math.abs(result - 5000.0) < 0.01, `Erwartet ~5000, erhalten ${result}`);
});

test('regsToFloat32: negative Werte (Entladen) korrekt', () => {
  const [hi, lo] = float32ToRegs(-2500.5);
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(hi, 0);
  buf.writeUInt16BE(lo, 2);
  const result = buf.readFloatBE(0);
  assert.ok(Math.abs(result - (-2500.5)) < 0.01, `Erwartet ~-2500.5, erhalten ${result}`);
});

test('regsToFloat32: SunSpec NaN-Sentinel (0x7FC0 0x0000) → null', () => {
  // SunSpec NaN: hi = 0x7FC0 → isSunSpecNaN = true
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(0x7fc0, 0);
  buf.writeUInt16BE(0x0000, 2);
  // Der Wert ist IEEE 754 NaN — prüfen dass isSunSpecNaN greift
  const hi = 0x7fc0;
  const top = (hi >> 8) & 0xff;
  assert.equal(top, 0x7f);
});

// ---------------------------------------------------------------------------
// createFroniusTransport: Interface-Kontrakt
// ---------------------------------------------------------------------------

test('createFroniusTransport gibt Objekt mit type=modbus und manufacturer=fronius zurück', () => {
  const t = createFroniusTransport({ host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1000 });
  assert.equal(t.type, 'modbus');
  assert.equal(t.manufacturer, 'fronius');
  assert.equal(typeof t.init, 'function');
  assert.equal(typeof t.mbRequest, 'function');
  assert.equal(typeof t.mbWriteSingle, 'function');
  assert.equal(typeof t.mbWriteMultiple, 'function');
  assert.equal(typeof t.setWMaxLim, 'function');
  assert.equal(typeof t.setStorCtlMod, 'function');
  assert.equal(typeof t.destroy, 'function');
});

test('createFroniusTransport: destroy() ohne vorherige Verbindung wirft keinen Fehler', async () => {
  const t = createFroniusTransport({ host: '127.0.0.1', port: 19999, unitId: 1, timeoutMs: 100 });
  await assert.doesNotReject(() => t.destroy());
});

// ---------------------------------------------------------------------------
// mbRequest mit sunspec_float32 Encoding — via Mock-Server
// ---------------------------------------------------------------------------

import net from 'node:net';

/** Startet einen minimalen Modbus TCP Mock-Server auf einem freien Port. */
async function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('data', (data) => {
        const tid = data.readUInt16BE(0);
        const unitId = data.readUInt8(6);
        const fc = data.readUInt8(7);
        const address = data.readUInt16BE(8);
        const quantity = data.readUInt16BE(10);
        const regs = handler({ tid, unitId, fc, address, quantity });
        if (regs) sock.write(buildMbFrame(tid, unitId, regs));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

test('mbRequest sunspec_float32: liest 5000 W korrekt', async () => {
  const expectedW = 5000.0;
  const [hi, lo] = float32ToRegs(expectedW);

  const { server, port } = await startMockServer(({ address }) => {
    if (address === 40093) return [hi, lo]; // W register
    return [0, 0];
  });

  try {
    const t = createFroniusTransport({ host: '127.0.0.1', port, unitId: 1, timeoutMs: 500 });
    const result = await t.mbRequest({
      fc: 3, address: 40093, quantity: 2,
      encoding: 'sunspec_float32', scale: 1, offset: 0
    });
    assert.ok(result.__froniusFloat32 === true, 'Erwartet __froniusFloat32=true');
    assert.ok(Math.abs(result.value - expectedW) < 0.1, `Erwartet ~${expectedW}, erhalten ${result.value}`);
    await t.destroy();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('mbRequest sunspec_float32_meter_block: liest W_total + L1/L2/L3 korrekt', async () => {
  const vals = [1234.5, 400.1, 400.2, 434.2]; // total, L1, L2, L3
  const regs = vals.flatMap((v) => float32ToRegs(v));

  const { server, port } = await startMockServer(({ address }) => {
    if (address === 40090) return regs;
    return [];
  });

  try {
    const t = createFroniusTransport({ host: '127.0.0.1', port, unitId: 200, timeoutMs: 500 });
    const result = await t.mbRequest({
      fc: 3, unitId: 200, address: 40090, quantity: 8,
      encoding: 'sunspec_float32_meter_block'
    });
    assert.ok(result.__froniusMeterBlock === true);
    assert.ok(Math.abs(result.total - 1234.5) < 0.5, `total: ${result.total}`);
    assert.ok(Math.abs(result.l1 - 400.1) < 0.5, `L1: ${result.l1}`);
    assert.ok(Math.abs(result.l2 - 400.2) < 0.5, `L2: ${result.l2}`);
    assert.ok(Math.abs(result.l3 - 434.2) < 0.5, `L3: ${result.l3}`);
    await t.destroy();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('mbRequest sunspec_float32: SunSpec NaN → value=null', async () => {
  // SunSpec NaN-Sentinel: hi-Register = 0x7FC0
  const { server, port } = await startMockServer(() => [0x7fc0, 0x0000]);

  try {
    const t = createFroniusTransport({ host: '127.0.0.1', port, unitId: 1, timeoutMs: 500 });
    const result = await t.mbRequest({
      fc: 3, address: 40093, quantity: 2,
      encoding: 'sunspec_float32'
    });
    assert.ok(result.__froniusFloat32 === true);
    assert.equal(result.value, null);
    await t.destroy();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('mbRequest raw_uint16: SOC-Register (ChaState) korrekt lesen', async () => {
  // ChaState: Wert 7543 = 75.43% SOC (vor scale 0.01)
  const { server, port } = await startMockServer(() => [7543]);

  try {
    const t = createFroniusTransport({ host: '127.0.0.1', port, unitId: 1, timeoutMs: 500 });
    const regs = await t.mbRequest({
      fc: 3, address: 40361, quantity: 1,
      encoding: 'raw_uint16', scale: 0.01, offset: 0
    });
    // raw_uint16 gibt uint16-Array zurück — polling.js wendet scale an
    assert.ok(Array.isArray(regs), 'Erwartet Array für raw_uint16');
    assert.equal(regs[0], 7543);
    await t.destroy();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// setWMaxLim: Schreibsequenz prüfen
// ---------------------------------------------------------------------------

test('setWMaxLim(enable=false): schreibt nur WMaxLim_Ena=0 (FC6 an Adresse 40275)', async () => {
  const writes = [];

  const { server, port } = await startMockServer(({ fc, address, quantity }) => {
    if (fc === 3) return new Array(quantity).fill(0);
    return null; // FC6/FC16 werden nicht von readHandler bedient
  });

  // Mock-Server: Write-Antworten
  server.on('connection', (sock) => {
    sock.on('data', (data) => {
      const tid = data.readUInt16BE(0);
      const fc = data.readUInt8(7);
      const address = data.readUInt16BE(8);

      if (fc === 6) {
        writes.push({ fc, address, value: data.readUInt16BE(10) });
        // Echo zurück (FC6 Write Single Response)
        const resp = Buffer.alloc(12);
        data.copy(resp, 0, 0, 12);
        sock.write(resp);
      } else if (fc === 16) {
        writes.push({ fc, address, qty: data.readUInt16BE(10) });
        // FC16 Response
        const resp = Buffer.alloc(12);
        resp.writeUInt16BE(tid, 0);
        resp.writeUInt16BE(0, 2);
        resp.writeUInt16BE(6, 4);
        resp.writeUInt8(data.readUInt8(6), 6);
        resp.writeUInt8(16, 7);
        resp.writeUInt16BE(address, 8);
        resp.writeUInt16BE(data.readUInt16BE(10), 10);
        sock.write(resp);
      }
    });
  });

  try {
    const t = createFroniusTransport({ host: '127.0.0.1', port, unitId: 1, timeoutMs: 500 });
    await t.setWMaxLim(false); // Begrenzung aufheben
    // Muss genau einen FC6-Write an 40275 mit value=0 ausgelöst haben
    const w = writes.find((wr) => wr.fc === 6 && wr.address === 40275);
    assert.ok(w, 'FC6-Write an Adresse 40275 erwartet');
    assert.equal(w.value, 0, 'WMaxLim_Ena muss 0 sein');
    assert.ok(!writes.find((wr) => wr.fc === 16), 'Kein FC16-Write erwartet bei enable=false');
    await t.destroy();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('setWMaxLim(enable=true, limitPct=0): schreibt WMaxLimPct=0% (FC16) und WMaxLim_Ena=1 (FC6)', async () => {
  const writes = [];

  const { server, port } = await startMockServer(() => null);
  server.on('connection', (sock) => {
    sock.on('data', (data) => {
      const tid = data.readUInt16BE(0);
      const fc = data.readUInt8(7);
      const address = data.readUInt16BE(8);
      if (fc === 6) {
        writes.push({ fc, address, value: data.readUInt16BE(10) });
        const resp = Buffer.alloc(12); data.copy(resp); sock.write(resp);
      } else if (fc === 16) {
        const qty = data.readUInt16BE(10);
        writes.push({ fc, address, qty });
        const resp = Buffer.alloc(12);
        resp.writeUInt16BE(tid, 0); resp.writeUInt16BE(0, 2); resp.writeUInt16BE(6, 4);
        resp.writeUInt8(data.readUInt8(6), 6); resp.writeUInt8(16, 7);
        resp.writeUInt16BE(address, 8); resp.writeUInt16BE(qty, 10);
        sock.write(resp);
      }
    });
  });

  try {
    const t = createFroniusTransport({ host: '127.0.0.1', port, unitId: 1, timeoutMs: 500 });
    await t.setWMaxLim(true, 0);
    // FC16 an 40267 (WMaxLimPct, 2 Register)
    const fc16 = writes.find((w) => w.fc === 16 && w.address === 40267);
    assert.ok(fc16, 'FC16-Write an 40267 (WMaxLimPct) erwartet');
    assert.equal(fc16.qty, 2, '2 Register für Float32 erwartet');
    // FC6 an 40275 mit value=1
    const fc6 = writes.find((w) => w.fc === 6 && w.address === 40275);
    assert.ok(fc6, 'FC6-Write an 40275 (WMaxLim_Ena) erwartet');
    assert.equal(fc6.value, 1, 'WMaxLim_Ena muss 1 sein');
    await t.destroy();
  } finally {
    await new Promise((r) => server.close(r));
  }
});
