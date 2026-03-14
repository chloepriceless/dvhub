import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDvState } from '../modules/dv/dv-state.js';
import { createLuoxProvider } from '../modules/dv/providers/luox.js';
import { createModbusSlave } from '../modules/dv/modbus-slave.js';

/**
 * Build an MBAP/TCP frame for testing.
 * @param {number} tid - Transaction ID
 * @param {number} unitId - Unit ID
 * @param {number} fc - Function code
 * @param {Buffer} payload - PDU payload after unit+fc
 * @returns {Buffer}
 */
function buildMbapFrame(tid, unitId, fc, payload) {
  const pdu = Buffer.concat([Buffer.from([unitId, fc]), payload]);
  const header = Buffer.alloc(6);
  header.writeUInt16BE(tid, 0);
  header.writeUInt16BE(0, 2);     // protocol ID = 0
  header.writeUInt16BE(pdu.length, 4);
  return Buffer.concat([header, pdu]);
}

/**
 * Build FC3/FC4 read request payload (addr + qty).
 */
function readPayload(addr, qty) {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(addr, 0);
  b.writeUInt16BE(qty, 2);
  return b;
}

/**
 * Build FC6 single write payload (addr + value).
 */
function fc6Payload(addr, value) {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(addr, 0);
  b.writeUInt16BE(value, 2);
  return b;
}

/**
 * Build FC16 multi write payload (addr + qty + byteCount + values).
 */
function fc16Payload(addr, values) {
  const qty = values.length;
  const bc = qty * 2;
  const b = Buffer.alloc(5 + bc);
  b.writeUInt16BE(addr, 0);
  b.writeUInt16BE(qty, 2);
  b.writeUInt8(bc, 4);
  for (let i = 0; i < qty; i++) {
    b.writeUInt16BE(values[i], 5 + i * 2);
  }
  return b;
}

function createSlave(opts = {}) {
  const state = opts.state ?? createDvState();
  const provider = opts.provider ?? createLuoxProvider();
  const writes = [];
  const onWrite = (signal) => writes.push(signal);
  const slave = createModbusSlave({ state, provider, onWrite });
  return { slave, state, writes };
}

describe('createModbusSlave', () => {
  it('returns object with processFrame method', () => {
    const { slave } = createSlave();
    assert.strictEqual(typeof slave.processFrame, 'function');
  });

  it('processFrame is NOT async', () => {
    const { slave } = createSlave();
    assert.notStrictEqual(
      slave.processFrame.constructor.name,
      'AsyncFunction',
      'processFrame must be synchronous'
    );
  });
});

describe('FC3/FC4 read responses', () => {
  it('FC3 read addr=0, qty=2 returns correct MBAP response', () => {
    const { slave, state } = createSlave();
    state.setReg(0, 1500);
    state.setReg(1, 0);

    const frame = buildMbapFrame(1, 1, 3, readPayload(0, 2));
    const resp = slave.processFrame(frame, '127.0.0.1');

    assert.ok(Buffer.isBuffer(resp));
    // MBAP header
    assert.strictEqual(resp.readUInt16BE(0), 1);  // tid
    assert.strictEqual(resp.readUInt16BE(2), 0);  // protocol
    // PDU
    assert.strictEqual(resp.readUInt8(7), 3);     // fc
    assert.strictEqual(resp.readUInt8(8), 4);     // byte count = 2 regs * 2
    assert.strictEqual(resp.readUInt16BE(9), 1500); // reg 0
    assert.strictEqual(resp.readUInt16BE(11), 0);   // reg 1
  });

  it('FC4 read addr=0, qty=5 returns all register values', () => {
    const { slave, state } = createSlave();
    state.setReg(0, 100);
    state.setReg(1, 200);
    // reg 2 is not in the default layout -- getReg returns 0
    state.setReg(3, 300);
    state.setReg(4, 400);

    const frame = buildMbapFrame(2, 1, 4, readPayload(0, 5));
    const resp = slave.processFrame(frame, '127.0.0.1');

    assert.ok(Buffer.isBuffer(resp));
    assert.strictEqual(resp.readUInt8(7), 4);     // fc
    assert.strictEqual(resp.readUInt8(8), 10);    // byte count = 5 regs * 2
    assert.strictEqual(resp.readUInt16BE(9), 100);
    assert.strictEqual(resp.readUInt16BE(11), 200);
    assert.strictEqual(resp.readUInt16BE(13), 0);   // reg 2 not set
    assert.strictEqual(resp.readUInt16BE(15), 300);
    assert.strictEqual(resp.readUInt16BE(17), 400);
  });
});

describe('FC6 single write', () => {
  it('addr=3, value=1 calls onWrite with curtail signal', () => {
    const { slave, writes } = createSlave();
    const frame = buildMbapFrame(3, 1, 6, fc6Payload(3, 1));
    const resp = slave.processFrame(frame, '127.0.0.1');

    assert.ok(Buffer.isBuffer(resp));
    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(writes[0], { action: 'curtail', reason: 'fc16_addr3_0001' });
  });
});

describe('FC16 multi write', () => {
  it('addr=0, values=[0,0] calls onWrite curtail', () => {
    const { slave, writes } = createSlave();
    const frame = buildMbapFrame(4, 1, 16, fc16Payload(0, [0, 0]));
    const resp = slave.processFrame(frame, '127.0.0.1');

    assert.ok(Buffer.isBuffer(resp));
    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(writes[0], { action: 'curtail', reason: 'fc16_addr0_0000' });

    // FC16 ack: 12 bytes
    assert.strictEqual(resp.length, 12);
    assert.strictEqual(resp.readUInt16BE(0), 4);  // tid
    assert.strictEqual(resp.readUInt8(7), 16);    // fc
    assert.strictEqual(resp.readUInt16BE(8), 0);  // addr
    assert.strictEqual(resp.readUInt16BE(10), 2); // qty
  });

  it('addr=0, values=[0xffff,0xffff] calls onWrite release', () => {
    const { slave, writes } = createSlave();
    const frame = buildMbapFrame(5, 1, 16, fc16Payload(0, [0xffff, 0xffff]));
    slave.processFrame(frame, '127.0.0.1');

    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(writes[0], { action: 'release', reason: 'fc16_addr0_ffff' });
  });
});

describe('Unsupported function code', () => {
  it('returns Modbus exception (fc|0x80, code 1)', () => {
    const { slave } = createSlave();
    const frame = buildMbapFrame(6, 1, 5, Buffer.alloc(4)); // FC5 not supported
    const resp = slave.processFrame(frame, '127.0.0.1');

    assert.ok(Buffer.isBuffer(resp));
    assert.strictEqual(resp.length, 9);
    assert.strictEqual(resp.readUInt8(7), (5 | 0x80) & 0xff); // exception fc
    assert.strictEqual(resp.readUInt8(8), 1); // illegal function
  });
});

describe('Edge cases', () => {
  it('frame shorter than 8 bytes returns null', () => {
    const { slave } = createSlave();
    const resp = slave.processFrame(Buffer.alloc(7), '127.0.0.1');
    assert.strictEqual(resp, null);
  });
});

describe('Keepalive tracking', () => {
  it('read/write updates keepalive.modbusLastQuery', () => {
    const { slave, state } = createSlave();
    assert.strictEqual(state.keepalive.modbusLastQuery, null);

    const frame = buildMbapFrame(7, 1, 3, readPayload(0, 2));
    slave.processFrame(frame, '192.168.1.100');

    const q = state.keepalive.modbusLastQuery;
    assert.ok(q);
    assert.strictEqual(typeof q.ts, 'number');
    assert.strictEqual(q.remote, '192.168.1.100');
    assert.strictEqual(q.fc, 3);
    assert.strictEqual(q.addr, 0);
    assert.strictEqual(q.qty, 2);
    assert.ok(Array.isArray(q.sample));
  });
});
