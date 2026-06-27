// modbus-server.js -- Modbus TCP server for Direktvermarkter communication.
// Extracted from server.js (Phase 2, Plan 01).
// Factory receives DI context; all state access through ctx.

import net from 'node:net';
import { u16, s16 } from './server-utils.js';

export function createModbusServer(ctx) {
  const { state, getCfg, pushLog } = ctx;

  let mbServer = null;

  // Plan 08-06 Task 2 Step 1: LAN-only gate for Modbus TCP clients.
  // Modbus FC6/FC16 writes to register 0/3 toggle the device-wide forcedOff flag,
  // which is safety-critical for grid assets. The previous 0.0.0.0:1502 listener
  // accepted writes from anywhere on the network. This gate accepts:
  //   - explicit allowlist when cfg.modbusAllowedClients is non-empty (CIDR-free, exact strings)
  //   - otherwise: loopback + RFC1918 only (10/8, 172.16/12, 192.168/16)
  // Rejected sockets are destroyed immediately and recorded in the audit log.
  function isAllowedModbusClient(socket, cfg) {
    const raw = String(socket.remoteAddress || '').replace(/^::ffff:/, '');
    const allowlist = Array.isArray(cfg?.modbusAllowedClients) ? cfg.modbusAllowedClients : [];
    if (allowlist.length > 0) return allowlist.includes(raw);
    if (raw === '127.0.0.1' || raw === '::1') return true;
    const parts = raw.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      if (parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
    }
    return false;
  }

  function setReg(addr, value) { state.dvRegs[addr] = u16(value); }
  function getReg(addr) { return u16(state.dvRegs[addr] ?? 0); }

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

  function buildReadResp(tid, unit, fc, addr, qty) {
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

  function handleWriteSignal(addr, values) {
    if (addr === 0 && values.length >= 2) {
      if (values[0] === 0 && values[1] === 0) return ctx.setForcedOff('fc16_addr0_0000');
      if (values[0] === 0xffff && values[1] === 0xffff) return ctx.clearForcedOff('fc16_addr0_ffff');
    }
    if (addr === 3 && values.length >= 1) {
      if (values[0] === 1) return ctx.setForcedOff('fc16_addr3_0001');
      if (values[0] === 0) return ctx.clearForcedOff('fc16_addr3_0000');
    }
  }

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

  function processModbusFrame(frame, remote) {
    if (frame.length < 8) return null;
    const tid = frame.readUInt16BE(0);
    const pid = frame.readUInt16BE(2);
    const len = frame.readUInt16BE(4);
    if (pid !== 0 || len < 2 || frame.length < 6 + len) return null;
    const unit = frame.readUInt8(6);
    const fc = frame.readUInt8(7);

    ctx.expireLeaseIfNeeded();

    if (fc === 3 || fc === 4) {
      if (len < 6) return buildException(tid, unit, fc, 3);
      const addr = frame.readUInt16BE(8);
      const qty = frame.readUInt16BE(10);
      if (qty < 1 || qty > 125) return buildException(tid, unit, fc, 3);
      const { out, regs } = buildReadResp(tid, unit, fc, addr, qty);
      rememberModbusQuery({ remote, fc, addr, qty, sample: regs.slice(0, 8) });
      return out;
    }

    if (fc === 6) {
      if (len < 6) return buildException(tid, unit, fc, 3);
      const addr = frame.readUInt16BE(8);
      const val = frame.readUInt16BE(10);
      setReg(addr, val);
      handleWriteSignal(addr, [val]);
      pushLog('modbus_fc6', { remote, addr, value: val, forcedOff: state.ctrl.forcedOff });
      return frame.subarray(0, 12);
    }

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
        setReg(addr + i, v);
      }
      handleWriteSignal(addr, values);
      pushLog('modbus_fc16', { remote, addr, qty, values, forcedOff: state.ctrl.forcedOff });

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

    return buildException(tid, unit, fc, 1);
  }

  function start() {
    // Idempotency guard (Pro-Gating): start() is invoked both at boot and from
    // the licence active<->inactive transition hook. A second listener would leak
    // a socket server, so a no-op when one is already bound.
    if (mbServer) return;
    const cfg = getCfg();
    mbServer = net.createServer((socket) => {
      // Plan 08-06 Task 2 Step 1: enforce LAN-only / allowlist on every accepted socket.
      if (!isAllowedModbusClient(socket, getCfg())) {
        pushLog('modbus_unauthorized_client', { remote: socket.remoteAddress });
        socket.destroy();
        return;
      }
      const remote = `${socket.remoteAddress}:${socket.remotePort}`;
      let buffer = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 7) {
          const len = buffer.readUInt16BE(4);
          const total = 6 + len;
          if (buffer.length < total) break;

          const frame = buffer.subarray(0, total);
          buffer = buffer.subarray(total);
          const resp = processModbusFrame(frame, remote);
          if (resp) socket.write(resp);
        }
      });
      socket.on('error', () => {});
    });

    mbServer.listen(cfg.modbusListenPort, cfg.modbusListenHost, () => {
      console.log(`Modbus server listening on ${cfg.modbusListenHost}:${cfg.modbusListenPort}`);
    });
  }

  function close() {
    if (mbServer) mbServer.close();
    mbServer = null;
  }

  return { start, close };
}
