// modbus-server.js -- Modbus TCP server for Direktvermarkter communication.
// Extracted from server.js (Phase 2, Plan 01).
// Factory receives DI context; all state access through ctx.

import net from 'node:net';
import { u16 } from './server-utils.js';
import {
  dvInterfaceProfile, luoxInputRegisters, luoxHoldingRegisters, readWindow, luoxApplyWrite,
} from './dv-interface-luox.js';
import { classifyDvRequest } from './dv-profile-check.js';

// Ersatzport, wenn modbusListenPort nicht zu öffnen ist (siehe start()).
export const MODBUS_FALLBACK_PORT = 1502;

export function createModbusServer(ctx) {
  const { state, getCfg, pushLog } = ctx;

  let mbServer = null;

  // Plan 08-06 Task 2 Step 1: LAN-only gate for Modbus TCP clients.
  // Modbus FC6/FC16 writes to register 0/3 toggle the device-wide forcedOff flag,
  // which is safety-critical for grid assets. The previous 0.0.0.0 listener
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
      // So schaltet LUOX tatsächlich frei (Audit Mai–Okt 2026, zusammen mit Adresse 3 = 0).
      if (values[0] === 0x00ff && values[1] === 0x00ff) return ctx.clearForcedOff('fc16_addr0_00ff');
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

  // Was nicht zum Profil passt, melden (dv-profile-check.js): Protokoll je
  // Muster höchstens stündlich, Systemwarnung bis 24 h nach dem letzten Mal.
  const DV_UNKNOWN_LOG_MS = 60 * 60 * 1000;
  const DV_UNKNOWN_WARN_MS = 24 * 60 * 60 * 1000;
  const PROFILE_LABEL = { plexlog: 'Plexlog', luox: 'LUOX / Lumenaza' };
  function setWarning(id, message) {
    const list = state.systemWarnings;
    if (!Array.isArray(list)) return;
    const i = list.findIndex((w) => w.id === id);
    if (message == null) { if (i >= 0) list.splice(i, 1); return; }
    if (i >= 0) list[i] = { id, message }; else list.push({ id, message });
  }
  function checkDvRequest(profile, req, remote) {
    const now = Date.now();
    const st = (state.dvUnknown ??= { count: 0, seen: {}, last: null });
    if (st.last && now - st.last.at > DV_UNKNOWN_WARN_MS) setWarning('dv_unknown_command', null);
    const reason = classifyDvRequest(profile, req);
    if (!reason) return;
    st.count += 1;
    st.last = { at: now, reason, remote, profile };
    if (now - (st.seen[reason] || 0) >= DV_UNKNOWN_LOG_MS) {
      st.seen[reason] = now;
      pushLog('dv_unknown_command', { profile, remote, reason, fc: req.fc, addr: req.addr, values: req.values }, 'warn');
    }
    const time = new Date(now).toLocaleString('de-DE', { timeZone: getCfg()?.timeZone || 'Europe/Berlin' });
    setWarning('dv_unknown_command', `Direktvermarkter hat etwas gesendet, das nicht zum Profil „${PROFILE_LABEL[profile] || profile}“ passt: ${reason} (${time}). DVhub hat es nicht umgesetzt — bitte mit dem Direktvermarkter klären.`);
  }

  function parseForCheck(frame, fc, len) {
    if ((fc === 3 || fc === 4) && len >= 6) return { fc, addr: frame.readUInt16BE(8), qty: frame.readUInt16BE(10) };
    if (fc === 6 && len >= 6) return { fc, addr: frame.readUInt16BE(8), values: [frame.readUInt16BE(10)] };
    if (fc === 16 && len >= 7) {
      const qty = frame.readUInt16BE(10);
      const bc = frame.readUInt8(12);
      if (bc !== qty * 2 || 13 + bc > 6 + len) return null;
      return { fc, addr: frame.readUInt16BE(8), values: Array.from({ length: qty }, (_, i) => frame.readUInt16BE(13 + i * 2)) };
    }
    if (fc === 3 || fc === 4 || fc === 6 || fc === 16) return null; // kaputter Rahmen → Ausnahme wie bisher
    return { fc };
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

    const req = parseForCheck(frame, fc, len);
    if (req) checkDvRequest(dvInterfaceProfile(getCfg()), req, remote);

    if (dvInterfaceProfile(getCfg()) === 'luox') return processLuoxFrame(frame, remote, { tid, unit, fc, len });

    if (fc === 3 || fc === 4) {
      if (len < 6) return buildException(tid, unit, fc, 3);
      const addr = frame.readUInt16BE(8);
      const qty = frame.readUInt16BE(10);
      if (qty < 1 || qty > 125) return buildException(tid, unit, fc, 3);
      // FC4 (Input) nach der offiziellen LUOX/Lumenaza-Tabelle (02.06.2026):
      // die Plexlog-Leseregister waren nur abgeschaut — Reg 0–1 Einspeisung
      // (jetzt volles i32), 2–3 Produktion, 4 Netzbetreiber-%, 5–6 Referenz.
      // FC3 und das Schreiben bleiben im gemeinsamen Plexlog-Bereich.
      if (fc === 4) {
        const regs = readWindow(luoxInputRegisters(state, getCfg()), addr, qty);
        rememberModbusQuery({ remote, fc, addr, qty, sample: regs.slice(0, 8) });
        return regsResponse(tid, unit, fc, regs);
      }
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

  // LUOX/Lumenaza: getrennte Input- (FC4) und Holding-Register (FC3/6/16),
  // Belegung und Semantik in dv-interface-luox.js.
  function writeAck(tid, unit, fc, addr, qtyOrValue) {
    const ack = Buffer.alloc(12);
    ack.writeUInt16BE(tid, 0);
    ack.writeUInt16BE(0, 2);
    ack.writeUInt16BE(6, 4);
    ack.writeUInt8(unit, 6);
    ack.writeUInt8(fc, 7);
    ack.writeUInt16BE(addr, 8);
    ack.writeUInt16BE(qtyOrValue, 10);
    return ack;
  }

  function regsResponse(tid, unit, fc, regs) {
    const out = Buffer.alloc(9 + regs.length * 2);
    out.writeUInt16BE(tid, 0);
    out.writeUInt16BE(0, 2);
    out.writeUInt16BE(3 + regs.length * 2, 4);
    out.writeUInt8(unit, 6);
    out.writeUInt8(fc, 7);
    out.writeUInt8(regs.length * 2, 8);
    regs.forEach((v, i) => out.writeUInt16BE(v, 9 + i * 2));
    return out;
  }

  function processLuoxFrame(frame, remote, { tid, unit, fc, len }) {
    const luox = (state.dvLuox ??= { setpointPct: 100, watchdog: [0, 0], watchdogAt: null });
    if (fc === 3 || fc === 4) {
      if (len < 6) return buildException(tid, unit, fc, 3);
      const addr = frame.readUInt16BE(8);
      const qty = frame.readUInt16BE(10);
      if (qty < 1 || qty > 125) return buildException(tid, unit, fc, 3);
      const area = fc === 4 ? luoxInputRegisters(state, getCfg()) : luoxHoldingRegisters(luox);
      const regs = readWindow(area, addr, qty);
      rememberModbusQuery({ remote, fc, addr, qty, sample: regs.slice(0, 8) });
      return regsResponse(tid, unit, fc, regs);
    }
    if (fc !== 6 && fc !== 16) return buildException(tid, unit, fc, 1);

    let addr; let values;
    if (fc === 6) {
      if (len < 6) return buildException(tid, unit, fc, 3);
      addr = frame.readUInt16BE(8);
      values = [frame.readUInt16BE(10)];
    } else {
      if (len < 7) return buildException(tid, unit, fc, 3);
      addr = frame.readUInt16BE(8);
      const qty = frame.readUInt16BE(10);
      const bc = frame.readUInt8(12);
      if (bc !== qty * 2 || 13 + bc > 6 + len) return buildException(tid, unit, fc, 3);
      values = [];
      for (let i = 0; i < qty; i++) values.push(frame.readUInt16BE(13 + i * 2));
    }
    const change = luoxApplyWrite(luox, addr, values);
    if (change.error) {
      pushLog('modbus_luox_rejected', { remote, fc, addr, values });
      return buildException(tid, unit, fc, change.error);
    }
    // Watchdog zuerst: ein Schreibvorgang über Register 2–4 verlängert die
    // Frist, bevor die Vorgabe wirkt.
    if (change.watchdog) {
      luox.watchdog = change.watchdog;
      ctx.luoxWatchdogRefresh();
    }
    if (change.setpointPct !== undefined) {
      luox.setpointPct = change.setpointPct;
      ctx.setDvLimitPct(change.setpointPct, `luox_holding2_${change.setpointPct}`);
    }
    pushLog(fc === 6 ? 'modbus_fc6' : 'modbus_fc16', {
      remote, addr, values, profile: 'luox', setpointPct: luox.setpointPct, forcedOff: state.ctrl.forcedOff,
    });
    return fc === 6 ? frame.subarray(0, 12) : writeAck(tid, unit, 16, addr, values.length);
  }

  function handleConnection(socket) {
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
  }

  function listenHint(code) {
    if (code === 'EACCES') return 'Ports unter 1024 brauchen das Recht CAP_NET_BIND_SERVICE (nativ: systemd AmbientCapabilities, Container: DVhub-Image ab 18.10.2026).';
    if (code === 'EADDRINUSE') return 'Ein anderes Programm auf dem Gerät belegt den Port.';
    return null;
  }

  function start() {
    // Idempotency guard (Pro-Gating): start() is invoked both at boot and from
    // the licence active<->inactive transition hook. A second listener would leak
    // a socket server, so a no-op when one is already bound.
    if (mbServer) return;
    const cfg = getCfg();
    const requestedPort = cfg.modbusListenPort;
    const fallbackPort = ctx.fallbackPort ?? MODBUS_FALLBACK_PORT;
    listenOn(requestedPort, null);

    // Port nicht zu öffnen (belegt, oder < 1024 ohne CAP_NET_BIND_SERVICE): nicht
    // abstürzen — ohne Handler beendete das 'error' den Prozess und der Container
    // startete in einer Schleife neu. Stattdessen auf den Ersatzport ausweichen;
    // der VPN-Manager leitet den Port am Tunnel dorthin um (onModbusListen →
    // setModbusRedirect). Geht auch der nicht, melden und den Server freigeben,
    // damit ein späterer start() es erneut versucht.
    function listenOn(port, firstError) {
      const srv = net.createServer(handleConnection);
      mbServer = srv;
      srv.on('error', (err) => {
        if (mbServer === srv) mbServer = null;
        try { srv.close(); } catch { /* lauscht nicht */ }
        const code = err?.code || null;
        if (!firstError && (code === 'EACCES' || code === 'EADDRINUSE') && fallbackPort && fallbackPort !== port) {
          console.error(`Modbus server: Port ${port} nicht zu öffnen (${code}) — Ersatzport ${fallbackPort}`);
          return listenOn(fallbackPort, err);
        }
        const cause = firstError || err;
        const causeCode = cause?.code || null;
        const hint = listenHint(causeCode);
        state.modbusListen = {
          ok: false, port: requestedPort, requestedPort, fallback: false, code: causeCode,
          error: cause?.message || String(cause), hint, at: Date.now(),
        };
        console.error(`Modbus server: Port ${requestedPort} nicht zu öffnen (${causeCode || cause?.message})${firstError ? `, Ersatzport ${port} auch nicht (${code})` : ''}${hint ? ` — ${hint}` : ''}`);
        pushLog('modbus_listen_failed', {
          port: requestedPort, code: causeCode, error: cause?.message || String(cause), hint,
          ...(firstError ? { fallbackPort: port, fallbackCode: code } : {}),
        });
      });
      srv.listen(port, cfg.modbusListenHost, () => {
        const fallback = Boolean(firstError);
        const code = firstError?.code || null;
        const hint = fallback ? listenHint(code) : null;
        state.modbusListen = {
          ok: true, port, requestedPort, fallback, code,
          error: fallback ? (firstError.message || String(firstError)) : null, hint, at: Date.now(),
        };
        console.log(`Modbus server listening on ${cfg.modbusListenHost}:${port}${fallback ? ` (Ersatz für ${requestedPort}: ${code})` : ''}`);
        if (fallback) pushLog('modbus_listen_fallback', { requestedPort, port, code, hint });
        try { ctx.onModbusListen?.({ requestedPort, port, fallback }); } catch (e) {
          pushLog('modbus_listen_hook_error', { error: e?.message || String(e) });
        }
      });
    }
  }

  function close() {
    if (mbServer) mbServer.close();
    mbServer = null;
  }

  return { start, close };
}
