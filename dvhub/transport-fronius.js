import net from 'node:net';

/**
 * Fronius SunSpec Modbus TCP Transport für DVhub.
 *
 * Implementiert denselben Interface-Kontrakt wie transport-modbus.js und
 * erweitert ihn um:
 *   - IEEE 754 Float32-Dekodierung aus zwei uint16-Registern (SunSpec Float-Modus)
 *   - WMaxLimPct / WMaxLim_Ena Schreiblogik (Einspeisebegrenzung, IC123)
 *   - IC124 Basic Storage Controls (SOC lesen, StorCtl_Mod / InWRte / OutWRte schreiben)
 *
 * Voraussetzungen am Fronius-Wechselrichter:
 *   Kommunikation → Modbus → TCP aktiviert, SunSpec Model Type = Float.
 *   "Wechselrichter-Steuerung über Modbus" muss aktiviert sein (Technician-Passwort).
 *
 * Registeradressen (0-basiert, d. h. Register-Nr. 40001 = Adresse 40000):
 *
 *   Wechselrichter (Unit-ID 1) — SunSpec Inverter Model 113 (3-phasig), Float:
 *     40093  W          Float32   AC-Wirkleistung gesamt [W]
 *     40107  DCW        Float32   DC-Eingangsleistung [W]  (positiv = PV, negativ = Entladen)
 *     40117  St         uint16    Betriebszustand (4 = MPPT, 5 = Throttled)
 *     40267  WMaxLimPct Float32   Einspeisebegrenzung [%]      IC123, Offset +2
 *     40275  WMaxLim_Ena uint16   Begrenzung aktiv (1 = ein)   IC123, Offset +10
 *
 *   IC124 Basic Storage Controls (Float-Modus, Startadresse 40355):
 *     40358  StorCtl_Mod uint16   Steuermodus (bit0 = Laden, bit1 = Entladen)
 *     40360  MinRsvPct   uint16   Mindest-SOC [%]
 *     40361  ChaState    uint16   Aktueller SOC [‰] → / 100 = %  (0–10000)
 *     40365  OutWRte     int16    Max. Entladerate [% WChaMax]
 *     40366  InWRte      int16    Max. Laderate [% WChaMax]
 *     40370  ChaGriSet   uint16   Netzladen (0 = nein, 1 = ja)
 *
 *   Fronius Smart Meter (Unit-ID 200) — SunSpec Meter Model 203, Float:
 *     40090  W           Float32   Netzleistung gesamt [W]  (+ = Einspeisung)
 *     40092  WphA        Float32   Netzleistung L1 [W]
 *     40094  WphB        Float32   Netzleistung L2 [W]
 *     40096  WphC        Float32   Netzleistung L3 [W]
 *
 * Vorzeichenkonvention Netz: positiv = Einspeisung, negativ = Bezug.
 * → In config.json: "gridPositiveMeans": "feed_in" setzen.
 */

// ---------------------------------------------------------------------------
// IEEE 754 Float32 Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Dekodiert zwei uint16-Register (Big Endian) als IEEE 754 Float32.
 * @param {number} hi - Höherwertiges Register
 * @param {number} lo - Niederwertiges Register
 * @returns {number}
 */
function regsToFloat32(hi, lo) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(hi & 0xffff, 0);
  buf.writeUInt16BE(lo & 0xffff, 2);
  return buf.readFloatBE(0);
}

/**
 * Kodiert einen Float32-Wert als zwei uint16-Register (Big Endian).
 * @param {number} value
 * @returns {[number, number]} [hi, lo]
 */
function float32ToRegs(value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value, 0);
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

/** SunSpec NaN-Sentinel: oberstes Byte 0x7F oder 0xFF → not-implemented. */
function isSunSpecNaN(hi) {
  const top = (hi >> 8) & 0xff;
  return top === 0x7f || top === 0xff;
}

// ---------------------------------------------------------------------------
// Modbus TCP connection pool (gleiche Logik wie transport-modbus.js)
// ---------------------------------------------------------------------------

function createConnectionPool() {
  const pool = new Map();
  const IDLE_MS = 30000;
  let tidCounter = 1;

  function getConn(host, port) {
    const key = `${host}:${port}`;
    let c = pool.get(key);
    if (c && !c.destroyed) return c;

    c = {
      key, sock: null, destroyed: false,
      buf: Buffer.alloc(0), pending: null, queue: [], idleTimer: null,
      connect() {
        if (this.sock && !this.sock.destroyed) return;
        this.sock = new net.Socket();
        this.sock.setKeepAlive(true, 10000);
        this.sock.connect(port, host);
        this.sock.on('data', (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); this._drain(); });
        this.sock.on('error', (e) => this._fail(e));
        this.sock.on('close', () => this._fail(new Error('connection closed')));
      },
      _resetIdle() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.destroy(), IDLE_MS);
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
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        const p = this.pending;
        if (p) { this.pending = null; if (p.timer) clearTimeout(p.timer); p.reject(err); }
        for (const q of this.queue) { if (q.timer) clearTimeout(q.timer); q.reject(err); }
        this.queue = [];
        this.buf = Buffer.alloc(0);
        if (this.sock && !this.sock.destroyed) this.sock.destroy();
        this.sock = null;
      },
      destroy() {
        this.destroyed = true;
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        const p = this.pending;
        if (p) { this.pending = null; if (p.timer) clearTimeout(p.timer); p.reject(new Error('pool cleanup')); }
        for (const q of this.queue) { if (q.timer) clearTimeout(q.timer); q.reject(new Error('pool cleanup')); }
        this.queue = [];
        this.buf = Buffer.alloc(0);
        pool.delete(this.key);
        const sock = this.sock; this.sock = null;
        if (sock && !sock.destroyed) { sock.end(); setTimeout(() => { if (!sock.destroyed) sock.destroy(); }, 2000).unref(); }
      },
      send(reqBuf, timeoutMs) {
        return new Promise((resolve, reject) => { this.queue.push({ reqBuf, resolve, reject, timer: null, timeoutMs }); this._next(); });
      },
      _next() {
        if (this.pending || !this.queue.length) return;
        if (!this.sock || this.sock.destroyed) { this.connect(); this.sock.once('connect', () => this._next()); return; }
        if (!this.sock.writable) { this.connect(); this.sock.once('connect', () => this._next()); return; }
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
    pool.set(key, c);
    return c;
  }

  function nextTid() { return (tidCounter++ & 0xffff) || 1; }

  function sendRead(host, port, unitId, fc, address, quantity, timeoutMs) {
    const tid = nextTid();
    const req = Buffer.alloc(12);
    req.writeUInt16BE(tid, 0); req.writeUInt16BE(0, 2); req.writeUInt16BE(6, 4);
    req.writeUInt8(unitId, 6); req.writeUInt8(fc, 7);
    req.writeUInt16BE(address, 8); req.writeUInt16BE(quantity, 10);
    return getConn(host, port).send(req, timeoutMs).then((frame) => {
      if (frame.readUInt16BE(0) !== tid || frame.readUInt16BE(2) !== 0 || frame.readUInt8(6) !== unitId)
        throw new Error('invalid modbus response');
      const rFc = frame.readUInt8(7);
      if ((rFc & 0x80) === 0x80) throw new Error(`modbus exception ${frame.readUInt8(8)}`);
      if (rFc !== fc) throw new Error(`unexpected fc ${rFc}`);
      const byteCount = frame.readUInt8(8);
      const data = frame.subarray(9, 9 + byteCount);
      const regs = [];
      for (let i = 0; i + 1 < data.length; i += 2) regs.push(data.readUInt16BE(i));
      return regs;
    });
  }

  function sendWriteSingle(host, port, unitId, address, value, timeoutMs) {
    const tid = nextTid();
    const req = Buffer.alloc(12);
    req.writeUInt16BE(tid, 0); req.writeUInt16BE(0, 2); req.writeUInt16BE(6, 4);
    req.writeUInt8(unitId, 6); req.writeUInt8(6, 7);
    req.writeUInt16BE(address, 8); req.writeUInt16BE(value & 0xffff, 10);
    return getConn(host, port).send(req, timeoutMs).then((frame) => {
      if (frame.readUInt16BE(0) !== tid || frame.readUInt8(7) !== 6)
        throw new Error('invalid write ack');
      if ((frame.readUInt8(7) & 0x80) === 0x80) throw new Error(`modbus exception ${frame.readUInt8(8)}`);
      return { addr: frame.readUInt16BE(8), value: frame.readUInt16BE(10) };
    });
  }

  function sendWriteMultiple(host, port, unitId, address, values, timeoutMs) {
    const words = values.map((v) => Number(v) & 0xffff);
    const tid = nextTid();
    const qty = words.length;
    const byteCount = qty * 2;
    const req = Buffer.alloc(13 + byteCount);
    req.writeUInt16BE(tid, 0); req.writeUInt16BE(0, 2); req.writeUInt16BE(7 + byteCount, 4);
    req.writeUInt8(unitId, 6); req.writeUInt8(16, 7);
    req.writeUInt16BE(address, 8); req.writeUInt16BE(qty, 10); req.writeUInt8(byteCount, 12);
    for (let i = 0; i < qty; i += 1) req.writeUInt16BE(words[i], 13 + i * 2);
    return getConn(host, port).send(req, timeoutMs).then((frame) => {
      if (frame.readUInt16BE(0) !== tid || frame.readUInt8(7) !== 16)
        throw new Error('invalid write ack');
      if ((frame.readUInt8(7) & 0x80) === 0x80) throw new Error(`modbus exception ${frame.readUInt8(8)}`);
      return { addr: frame.readUInt16BE(8), quantity: frame.readUInt16BE(10) };
    });
  }

  return { getConn, sendRead, sendWriteSingle, sendWriteMultiple, pool };
}

// ---------------------------------------------------------------------------
// Fronius-spezifische Steuerroutinen
// ---------------------------------------------------------------------------

/**
 * Einspeisebegrenzung via SunSpec IC123 (Immediate Controls):
 *   enable=true  → WMaxLimPct = limitPct%, WMaxLim_Ena = 1
 *   enable=false → WMaxLim_Ena = 0  (Begrenzung aufheben)
 *
 * @param {object} pool - Connection pool
 * @param {string} host
 * @param {number} port
 * @param {number} unitId
 * @param {number} timeoutMs
 * @param {boolean} enable
 * @param {number} [limitPct=0]
 */
async function setWMaxLim(pool, host, port, unitId, timeoutMs, enable, limitPct = 0) {
  if (enable) {
    const pct = Math.max(0, Math.min(100, limitPct));
    const [hi, lo] = float32ToRegs(pct);
    // WMaxLimPct (Float32, 2 Register) an Adresse 40267
    await pool.sendWriteMultiple(host, port, unitId, 40267, [hi, lo], timeoutMs);
    // WMaxLim_Ena = 1 (uint16) an Adresse 40275
    await pool.sendWriteSingle(host, port, unitId, 40275, 1, timeoutMs);
    return { enabled: true, limitPct: pct };
  } else {
    // WMaxLim_Ena = 0 → Begrenzung aufheben
    await pool.sendWriteSingle(host, port, unitId, 40275, 0, timeoutMs);
    return { enabled: false };
  }
}

/**
 * Batterie-Steuermodus setzen (IC124 StorCtl_Mod).
 *   Adresse 40358 (0-basiert), uint16, Bitfeld: bit0 = Laden erlaubt, bit1 = Entladen erlaubt.
 *   Typische Werte: 3 = beides erlaubt (Normal), 1 = nur laden, 2 = nur entladen, 0 = gesperrt.
 *
 * @param {object} pool
 * @param {string} host
 * @param {number} port
 * @param {number} unitId
 * @param {number} timeoutMs
 * @param {number} mode - Bitfeld (0–3)
 */
async function setStorCtlMod(pool, host, port, unitId, timeoutMs, mode) {
  await pool.sendWriteSingle(host, port, unitId, 40358, mode & 0x03, timeoutMs);
  return { storCtlMod: mode & 0x03 };
}

// ---------------------------------------------------------------------------
// Transport Factory
// ---------------------------------------------------------------------------

/**
 * Erstellt einen Fronius SunSpec Modbus TCP Transport für DVhub.
 *
 * @param {object} cfg - victron-Block aus config.json (host, port, unitId, timeoutMs)
 * @returns {object} Transport-Objekt (Kontrakt identisch mit createModbusTransport)
 */
export function createFroniusTransport(cfg) {
  const connPool = createConnectionPool();
  const host = cfg?.host ?? '127.0.0.1';
  const port = cfg?.port ?? 502;
  const unitId = cfg?.unitId ?? 1;
  const timeoutMs = cfg?.timeoutMs ?? 2000;

  // ---------------------------------------------------------------------------
  // mbRequest — Kernmethode, die polling.js aufruft
  // ---------------------------------------------------------------------------

  /**
   * Liest Modbus-Register und dekodiert je nach `encoding`-Feld im conf-Objekt.
   *
   * Unterstützte Encodings (zusätzlich zu Standard-uint16):
   *   "sunspec_float32"           — 2 Register → IEEE 754 Float32
   *   "sunspec_float32_battery_dc"— wie oben; DCW-Vorzeichen wird aus Kontext ableitet
   *   "sunspec_float32_meter_block"— 8 Register → { total, l1, l2, l3 } als Float32 je 2 Register
   *   "raw_uint16"                — 1 Register, kein signed-Handling (Skalierung durch conf.scale)
   *
   * Gibt für float-Encodings ein Objekt zurück; polling.js muss pointFromRegs()
   * entsprechend erweitern (siehe polling.js-Patch).
   */
  function mbRequest(conf) {
    const h = conf.host ?? host;
    const p = conf.port ?? port;
    const uid = conf.unitId ?? unitId;
    const tms = conf.timeoutMs ?? timeoutMs;
    const fc = conf.fc ?? 3;

    switch (conf.encoding) {
      case 'sunspec_float32':
      case 'sunspec_float32_battery_dc': {
        return connPool.sendRead(h, p, uid, fc, conf.address, 2, tms).then((regs) => {
          if (!regs || regs.length < 2) return { __froniusFloat32: true, value: null };
          if (isSunSpecNaN(regs[0])) return { __froniusFloat32: true, value: null };
          const raw = regsToFloat32(regs[0], regs[1]);
          // DCW: Fronius meldet positive DC-Leistung für PV-Erzeugung.
          // Für DVhub soll batteryPowerW positiv = Laden, negativ = Entladen sein.
          // Da DCW PV + Akku summiert, dient es hier als Näherung; Vorzeichen beibehalten.
          const value = Number.isFinite(raw) ? raw : null;
          return { __froniusFloat32: true, value };
        });
      }

      case 'sunspec_float32_meter_block': {
        // 8 Register: W_total (2), WphA (2), WphB (2), WphC (2)
        return connPool.sendRead(h, p, uid, fc, conf.address, 8, tms).then((regs) => {
          const f = (i) => (regs.length >= i + 2 && !isSunSpecNaN(regs[i]))
            ? regsToFloat32(regs[i], regs[i + 1])
            : null;
          return {
            __froniusMeterBlock: true,
            total: f(0),
            l1: f(2),
            l2: f(4),
            l3: f(6)
          };
        });
      }

      case 'raw_uint16':
      default:
        // Standard-Modbus-Read, gibt uint16-Array zurück (polling.js-kompatibel)
        return connPool.sendRead(h, p, uid, fc, conf.address, conf.quantity ?? 1, tms);
    }
  }

  // ---------------------------------------------------------------------------
  // Schreiben (Standard-Modbus, für minSocPct etc.)
  // ---------------------------------------------------------------------------

  function mbWriteSingle({ host: h, port: p, unitId: uid, address, value, timeoutMs: tms }) {
    return connPool.sendWriteSingle(h ?? host, p ?? port, uid ?? unitId, address, value, tms ?? timeoutMs);
  }

  function mbWriteMultiple({ host: h, port: p, unitId: uid, address, values, timeoutMs: tms }) {
    return connPool.sendWriteMultiple(h ?? host, p ?? port, uid ?? unitId, address, values, tms ?? timeoutMs);
  }

  // ---------------------------------------------------------------------------
  // Fronius-spezifische API (für schedule-eval.js)
  // ---------------------------------------------------------------------------

  return {
    type: 'modbus',
    manufacturer: 'fronius',

    async init() { /* Verbindet on-demand */ },

    mbRequest,
    mbWriteSingle,
    mbWriteMultiple,

    /**
     * Einspeisebegrenzung setzen (IC123 WMaxLimPct + WMaxLim_Ena).
     * Wird von schedule-eval.js aufgerufen statt des Standard-mbWriteSingle.
     *
     * @param {boolean} enable - true = Einspeisung sperren, false = freigeben
     * @param {number} [limitPct=0] - Leistungslimit in Prozent (0–100)
     * @param {object} [opts] - Optionale Verbindungsüberschreibungen (host, port, unitId, timeoutMs)
     */
    setWMaxLim(enable, limitPct = 0, opts = {}) {
      return setWMaxLim(
        connPool,
        opts.host ?? host, opts.port ?? port,
        opts.unitId ?? unitId, opts.timeoutMs ?? timeoutMs,
        enable, limitPct
      );
    },

    /**
     * Batterie-Steuermodus setzen (IC124 StorCtl_Mod).
     * @param {number} mode - 0=gesperrt, 1=nur laden, 2=nur entladen, 3=normal
     * @param {object} [opts]
     */
    setStorCtlMod(mode, opts = {}) {
      return setStorCtlMod(
        connPool,
        opts.host ?? host, opts.port ?? port,
        opts.unitId ?? unitId, opts.timeoutMs ?? timeoutMs,
        mode
      );
    },

    async destroy() {
      for (const c of connPool.pool.values()) c.destroy();
      connPool.pool.clear();
    }
  };
}
