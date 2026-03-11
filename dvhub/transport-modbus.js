import net from 'node:net';

/**
 * Modbus TCP Transport für Victron-Kommunikation.
 * Extrahiert aus server.js — reiner Modbus-Client (kein Server).
 */
export function createModbusTransport() {
  const mbPool = new Map();
  const MB_IDLE_MS = 30000;
  let tidCounter = 1;

  function getMbConn(host, port) {
    const key = `${host}:${port}`;
    let c = mbPool.get(key);
    if (c && !c.destroyed) return c;

    c = {
      key,
      sock: null,
      destroyed: false,
      buf: Buffer.alloc(0),
      pending: null,
      queue: [],
      idleTimer: null,
      connect() {
        if (this.sock && !this.sock.destroyed) return;
        this.sock = new net.Socket();
        this.sock.setKeepAlive(true, 10000);
        this.sock.connect(port, host);
        this.sock.on('data', (chunk) => {
          this.buf = Buffer.concat([this.buf, chunk]);
          this._drain();
        });
        this.sock.on('error', (e) => this._fail(e));
        this.sock.on('close', () => this._fail(new Error('connection closed')));
      },
      _resetIdle() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.destroy(), MB_IDLE_MS);
      },
      _drain() {
        while (this.pending && this.buf.length >= 7) {
          const len = this.buf.readUInt16BE(4);
          const total = 6 + len;
          if (this.buf.length < total) break;
          const frame = this.buf.subarray(0, total);
          this.buf = this.buf.subarray(total);
          const p = this.pending;
          this.pending = null;
          if (p.timer) clearTimeout(p.timer);
          p.resolve(frame);
          this._resetIdle();
          this._next();
        }
      },
      _fail(err) {
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = null;
        }
        const p = this.pending;
        if (p) {
          this.pending = null;
          if (p.timer) clearTimeout(p.timer);
          p.reject(err);
        }
        for (const q of this.queue) {
          if (q.timer) clearTimeout(q.timer);
          q.reject(err);
        }
        this.queue = [];
        this.buf = Buffer.alloc(0);
        if (this.sock && !this.sock.destroyed) this.sock.destroy();
        this.sock = null;
      },
      destroy() {
        this.destroyed = true;
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = null;
        }
        this._fail(new Error('pool cleanup'));
        mbPool.delete(this.key);
      },
      send(reqBuf, timeoutMs) {
        return new Promise((resolve, reject) => {
          const entry = { reqBuf, resolve, reject, timer: null, timeoutMs };
          this.queue.push(entry);
          this._next();
        });
      },
      _next() {
        if (this.pending || !this.queue.length) return;
        if (!this.sock || this.sock.destroyed) {
          this.connect();
          this.sock.once('connect', () => this._next());
          return;
        }
        if (!this.sock.writable) {
          this.connect();
          this.sock.once('connect', () => this._next());
          return;
        }
        const entry = this.queue.shift();
        this.pending = entry;
        entry.timer = setTimeout(() => {
          if (this.pending === entry) {
            this.pending = null;
            entry.reject(new Error('modbus timeout'));
            if (this.sock && !this.sock.destroyed) this.sock.destroy();
            this.sock = null;
            this._next();
          }
        }, entry.timeoutMs || 1000);
        this.sock.write(entry.reqBuf);
      }
    };
    mbPool.set(key, c);
    return c;
  }

  function mbRequest({ host, port, unitId, fc, address, quantity, timeoutMs }) {
    const tid = (tidCounter++ & 0xffff) || 1;
    const req = Buffer.alloc(12);
    req.writeUInt16BE(tid, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(6, 4);
    req.writeUInt8(unitId, 6);
    req.writeUInt8(fc, 7);
    req.writeUInt16BE(address, 8);
    req.writeUInt16BE(quantity, 10);

    const conn = getMbConn(host, port);
    return conn.send(req, timeoutMs).then((frame) => {
      const rTid = frame.readUInt16BE(0);
      const pid = frame.readUInt16BE(2);
      const unit = frame.readUInt8(6);
      const rFc = frame.readUInt8(7);
      if (pid !== 0 || unit !== unitId || rTid !== tid) throw new Error('invalid modbus response');
      if ((rFc & 0x80) === 0x80) throw new Error(`modbus exception ${frame.readUInt8(8)}`);
      if (rFc !== fc) throw new Error(`unexpected fc ${rFc}`);
      const byteCount = frame.readUInt8(8);
      const data = frame.subarray(9, 9 + byteCount);
      const regs = [];
      for (let i = 0; i + 1 < data.length; i += 2) regs.push(data.readUInt16BE(i));
      return regs;
    });
  }

  function mbWriteSingle({ host, port, unitId, address, value, timeoutMs }) {
    const tid = (tidCounter++ & 0xffff) || 1;
    const req = Buffer.alloc(12);
    req.writeUInt16BE(tid, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(6, 4);
    req.writeUInt8(unitId, 6);
    req.writeUInt8(6, 7);
    req.writeUInt16BE(address, 8);
    req.writeUInt16BE(value & 0xffff, 10);

    const conn = getMbConn(host, port);
    return conn.send(req, timeoutMs).then((frame) => {
      const rTid = frame.readUInt16BE(0);
      const pid = frame.readUInt16BE(2);
      const unit = frame.readUInt8(6);
      const fc = frame.readUInt8(7);
      if (pid !== 0 || unit !== unitId || rTid !== tid) throw new Error('invalid write ack');
      if ((fc & 0x80) === 0x80) throw new Error(`modbus exception ${frame.readUInt8(8)}`);
      if (fc !== 6) throw new Error('invalid write ack');
      return { addr: frame.readUInt16BE(8), value: frame.readUInt16BE(10) };
    });
  }

  function mbWriteMultiple({ host, port, unitId, address, values, timeoutMs }) {
    const words = Array.isArray(values) ? values.map((v) => Number(v) & 0xffff) : [];
    if (!words.length) return Promise.reject(new Error('modbus write multiple: empty values'));
    if (words.length > 123) return Promise.reject(new Error('modbus write multiple: too many values'));

    const tid = (tidCounter++ & 0xffff) || 1;
    const qty = words.length;
    const byteCount = qty * 2;
    const req = Buffer.alloc(13 + byteCount);
    req.writeUInt16BE(tid, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(7 + byteCount, 4);
    req.writeUInt8(unitId, 6);
    req.writeUInt8(16, 7);
    req.writeUInt16BE(address, 8);
    req.writeUInt16BE(qty, 10);
    req.writeUInt8(byteCount, 12);
    for (let i = 0; i < qty; i += 1) req.writeUInt16BE(words[i], 13 + i * 2);

    const conn = getMbConn(host, port);
    return conn.send(req, timeoutMs).then((frame) => {
      const rTid = frame.readUInt16BE(0);
      const pid = frame.readUInt16BE(2);
      const unit = frame.readUInt8(6);
      const fc = frame.readUInt8(7);
      if (pid !== 0 || unit !== unitId || rTid !== tid) throw new Error('invalid write ack');
      if ((fc & 0x80) === 0x80) throw new Error(`modbus exception ${frame.readUInt8(8)}`);
      if (fc !== 16) throw new Error('invalid write ack');
      return { addr: frame.readUInt16BE(8), quantity: frame.readUInt16BE(10) };
    });
  }

  return {
    type: 'modbus',
    async init() { /* Modbus verbindet on-demand */ },
    mbRequest,
    mbWriteSingle,
    mbWriteMultiple,
    async destroy() {
      for (const c of mbPool.values()) c.destroy();
      mbPool.clear();
    }
  };
}
