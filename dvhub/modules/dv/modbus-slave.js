/**
 * Modbus Slave Frame Processor
 *
 * Processes Modbus TCP (MBAP) frames for the DV module.
 * Handles FC3/FC4 reads and FC6/FC16 writes.
 * Write signals are interpreted via provider adapter and delegated to onWrite callback.
 *
 * CRITICAL: processFrame is synchronous -- no async boundaries
 * in the DV real-time path.
 */

/**
 * Build a Modbus exception response (9 bytes).
 * @param {number} tid - Transaction ID
 * @param {number} unit - Unit ID
 * @param {number} fc - Original function code
 * @param {number} code - Exception code (1=illegal function, 2=illegal address, 3=illegal value)
 * @returns {Buffer}
 */
function buildException(tid, unit, fc, code) {
  const b = Buffer.alloc(9);
  b.writeUInt16BE(tid, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(3, 4);
  b.writeUInt8(unit, 6);
  b.writeUInt8((fc | 0x80) & 0xff, 7);
  b.writeUInt8(code, 8);
  return b;
}

/**
 * Build a Modbus read response (FC3/FC4).
 * @param {number} tid - Transaction ID
 * @param {number} unit - Unit ID
 * @param {number} fc - Function code (3 or 4)
 * @param {number} addr - Start address
 * @param {number} qty - Number of registers
 * @param {function} getReg - Register read function
 * @returns {{ out: Buffer, regs: number[] }}
 */
function buildReadResp(tid, unit, fc, addr, qty, getReg) {
  const byteCount = qty * 2;
  const out = Buffer.alloc(9 + byteCount);
  out.writeUInt16BE(tid, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(3 + byteCount, 4);
  out.writeUInt8(unit, 6);
  out.writeUInt8(fc, 7);
  out.writeUInt8(byteCount, 8);
  const regs = [];
  for (let i = 0; i < qty; i++) {
    const v = getReg(addr + i);
    regs.push(v);
    out.writeUInt16BE(v, 9 + i * 2);
  }
  return { out, regs };
}

/**
 * Create a Modbus slave frame processor.
 * @param {object} opts
 * @param {object} opts.state - DV state from createDvState()
 * @param {object} opts.provider - Provider adapter from createLuoxProvider()
 * @param {function} opts.onWrite - Callback for curtailment signals: (signal) => void
 * @param {object} [opts.log] - Optional Pino logger
 * @returns {object} Slave with processFrame(frame, remote) method
 */
export function createModbusSlave({ state, provider, onWrite, log }) {
  /**
   * Record a Modbus query in keepalive state.
   */
  function rememberModbusQuery({ remote, fc, addr, qty, sample }) {
    state.keepalive.modbusLastQuery = {
      ts: Date.now(),
      remote,
      fc,
      addr,
      qty,
      sample
    };
  }

  /**
   * Process a Modbus TCP frame.
   * MUST be synchronous -- no async/await.
   * @param {Buffer} frame - Raw MBAP frame
   * @param {string} remote - Remote address string
   * @returns {Buffer|null} Response buffer or null
   */
  function processFrame(frame, remote) {
    if (frame.length < 8) return null;

    const tid = frame.readUInt16BE(0);
    const pid = frame.readUInt16BE(2);
    const len = frame.readUInt16BE(4);

    if (pid !== 0 || len < 2 || frame.length < 6 + len) return null;

    const unit = frame.readUInt8(6);
    const fc = frame.readUInt8(7);

    // FC3 (Read Holding Registers) / FC4 (Read Input Registers)
    if (fc === 3 || fc === 4) {
      if (len < 6) return buildException(tid, unit, fc, 3);
      const addr = frame.readUInt16BE(8);
      const qty = frame.readUInt16BE(10);
      if (qty < 1 || qty > 125) return buildException(tid, unit, fc, 3);

      const { out, regs } = buildReadResp(tid, unit, fc, addr, qty, (a) => state.getReg(a));
      rememberModbusQuery({ remote, fc, addr, qty, sample: regs.slice(0, 8) });
      return out;
    }

    // FC6 (Write Single Register)
    if (fc === 6) {
      if (len < 6) return buildException(tid, unit, fc, 3);
      const addr = frame.readUInt16BE(8);
      const val = frame.readUInt16BE(10);
      state.setReg(addr, val);

      const signal = provider.interpretWrite(addr, [val]);
      if (signal) onWrite(signal);

      rememberModbusQuery({ remote, fc, addr, qty: 1, sample: [val] });

      if (log) log.info({ remote, addr, value: val }, 'modbus_fc6');
      return frame.subarray(0, 12);
    }

    // FC16 (Write Multiple Registers)
    if (fc === 16) {
      if (len < 7) return buildException(tid, unit, fc, 3);
      const addr = frame.readUInt16BE(8);
      const qty = frame.readUInt16BE(10);
      const bc = frame.readUInt8(12);
      if (bc !== qty * 2) return buildException(tid, unit, fc, 3);
      if (13 + bc > 6 + len) return buildException(tid, unit, fc, 3);

      const values = [];
      for (let i = 0; i < qty; i++) {
        const v = frame.readUInt16BE(13 + i * 2);
        values.push(v);
        state.setReg(addr + i, v);
      }

      const signal = provider.interpretWrite(addr, values);
      if (signal) onWrite(signal);

      rememberModbusQuery({ remote, fc, addr, qty, sample: values.slice(0, 8) });

      if (log) log.info({ remote, addr, qty, values }, 'modbus_fc16');

      // FC16 acknowledgment: echo addr + qty
      const ack = Buffer.alloc(12);
      ack.writeUInt16BE(tid, 0);
      ack.writeUInt16BE(0, 2);
      ack.writeUInt16BE(6, 4);
      ack.writeUInt8(unit, 6);
      ack.writeUInt8(16, 7);
      ack.writeUInt16BE(addr, 8);
      ack.writeUInt16BE(qty, 10);
      return ack;
    }

    // Unsupported function code
    return buildException(tid, unit, fc, 1);
  }

  return { processFrame };
}
