// Schein-Modbus-Gerät auf Socket-Ebene für Zeit-Tests des echten Transports (transport-modbus.js, E7/E12) mit
// falscher Uhr (node:test mock.timers für setTimeout und Date). Ersetzt net.Socket, solange installiert: der Transport
// baut seinen Socket mit `new net.Socket()`, also landet jede Verbindung hier. Kein Netzwerk.
//
// Jeder Rahmen auf dem Draht steht mit virtueller Uhrzeit im Protokoll (`wire`, zerlegt; `bytes`, roh als Hex),
// Verbindungsaufbau und -abbau in `events`. Antworten kommen aus einem Registerbild je (Unit-ID, Adresse); Writes
// (FC 5/6/16) werden bestätigt.
//
// framing 'tcp' (Standard): Modbus TCP mit MBAP-Kopf. framing 'rtu' (E12): transparentes RS485-Gateway — Anfrage und
// Antwort sind RTU-Rahmen (Unit-ID + PDU + CRC-16/Modbus, Low-Byte zuerst). framing darf auch eine Funktion
// (host, port) → 'tcp' | 'rtu' sein; sie gilt je Anfrage. Eine Anfrage mit falscher CRC beantwortet
// das Schein-Gerät nicht (wie ein echtes RTU-Gerät) und vermerkt sie mit `badCrc` im Protokoll. Die CRC rechnet dieser
// Helfer bitweise selbst (unabhängig von der Tabelle im Transport).

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';

// CRC-16/MODBUS bitweise (Polynom 0xA001 reflektiert, Startwert 0xFFFF); RevEng-Katalog: check("123456789") = 0x4B37.
export function crc16ModbusBitwise(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
  }
  return crc;
}

// RTU-Rahmen aus Unit-ID und PDU (Funktionscode + Daten), CRC Low-Byte zuerst.
export function rtuFrame(unitId, pdu) {
  const body = Buffer.concat([Buffer.from([unitId & 0xff]), Buffer.from(pdu)]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16ModbusBitwise(body), 0);
  return Buffer.concat([body, crc]);
}

export function installFakeModbusSockets({ connectLatencyMs = 0, respondDelayMs = 0, framing = 'tcp' } = {}) {
  const OriginalSocket = net.Socket;
  const regs = new Map();
  const wire = [];
  const bytes = [];
  const events = [];
  const silent = new Set(); // Adressen ohne Antwort (Zeitüberschreitung)
  const mutators = new Map(); // Adresse → fn(antwort, ctx) → null | Buffer | [{ bytes, delayMs?, toLive? }]
  const sockets = [];
  let t0 = Date.now();
  const at = () => Date.now() - t0;
  const live = () => [...sockets].reverse().find((s) => !s.destroyed && s.connected) || null;

  const framingOf = (host, port) => (typeof framing === 'function' ? framing(host, port) : framing);

  function parseRequest(req, mode) {
    if (mode === 'rtu') {
      const crcOk = req.length >= 4 && crc16ModbusBitwise(req.subarray(0, req.length - 2)) === req.readUInt16LE(req.length - 2);
      return {
        crcOk,
        unitId: req.readUInt8(0),
        fc: req.readUInt8(1),
        address: req.readUInt16BE(2),
        word: req.readUInt16BE(4),
        value16: (i) => req.readUInt16BE(7 + i * 2),
      };
    }
    return {
      crcOk: true,
      tid: req.subarray(0, 4),
      unitId: req.readUInt8(6),
      fc: req.readUInt8(7),
      address: req.readUInt16BE(8),
      word: req.readUInt16BE(10),
      value16: (i) => req.readUInt16BE(13 + i * 2),
    };
  }

  // PDU der Antwort (Funktionscode + Daten), wie ein ordentliches Gerät sie schickt.
  function responsePdu({ unitId, fc, address, word }) {
    if (fc === 1 || fc === 2) {
      const n = Math.ceil(word / 8);
      return Buffer.concat([Buffer.from([fc, n]), Buffer.alloc(n)]);
    }
    if (fc === 3 || fc === 4) {
      const pdu = Buffer.alloc(2 + word * 2);
      pdu.writeUInt8(fc, 0);
      pdu.writeUInt8(word * 2, 1);
      for (let i = 0; i < word; i += 1) pdu.writeUInt16BE((regs.get(`${unitId}:${address + i}`) ?? 0) & 0xffff, 2 + i * 2);
      return pdu;
    }
    // FC 5/6/16: Echo von Adresse und Wert bzw. Anzahl.
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(fc, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(word, 3);
    return pdu;
  }

  function frameResponse(parsed, pdu, mode) {
    if (mode === 'rtu') return rtuFrame(parsed.unitId, pdu);
    const res = Buffer.alloc(7 + pdu.length);
    parsed.tid.copy(res, 0, 0, 4);
    res.writeUInt16BE(1 + pdu.length, 4);
    res.writeUInt8(parsed.unitId, 6);
    pdu.copy(res, 7);
    return res;
  }

  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.connected = false;
      this.writable = true;
      sockets.push(this);
    }
    setKeepAlive() { return this; }
    connect(port, host) {
      this.port = port;
      this.host = host;
      const done = () => {
        if (this.destroyed) return;
        this.connected = true;
        events.push({ t: at(), ev: 'connect', host, port });
        this.emit('connect');
      };
      if (connectLatencyMs > 0) setTimeout(done, connectLatencyMs);
      else queueMicrotask(done);
      return this;
    }
    write(buf) {
      const req = Buffer.from(buf);
      bytes.push({ t: at(), host: this.host, port: this.port, hex: req.toString('hex') });
      const mode = framingOf(this.host, this.port);
      let parsed;
      try {
        parsed = parseRequest(req, mode);
        if (parsed.fc === 16 && parsed.word > 0) parsed.value16(parsed.word - 1);
      } catch {
        // Passt nicht zum Rahmen dieses Geräts (z. B. RTU an ein MBAP-Gerät): keine Antwort, wie im Feld.
        wire.push({ t: at(), unparsed: true });
        return true;
      }
      const { fc, unitId, address, word } = parsed;
      const detail = fc <= 4 ? { quantity: word }
        : fc === 16 ? { values: Array.from({ length: word }, (_, i) => parsed.value16(i)) }
          : { value: word };
      const entry = { t: at(), fc, unitId, address, ...detail };
      if (!parsed.crcOk) entry.badCrc = true;
      wire.push(entry);
      if (!parsed.crcOk || silent.has(address)) return true;
      let res = frameResponse(parsed, responsePdu(parsed), mode);
      const mutate = mutators.get(address);
      let chunks = [{ bytes: res, delayMs: respondDelayMs }];
      if (mutate) {
        res = mutate(res, { ...parsed, framing: mode });
        if (res == null) return true;
        chunks = Array.isArray(res) ? res : [{ bytes: res, delayMs: respondDelayMs }];
      }
      for (const c of chunks) {
        const deliver = () => {
          const target = c.toLive ? live() : this;
          if (target && !target.destroyed) target.emit('data', Buffer.from(c.bytes));
        };
        if (c.delayMs > 0) setTimeout(deliver, c.delayMs);
        else queueMicrotask(deliver);
      }
      return true;
    }
    destroy() {
      if (this.destroyed) return this;
      this.destroyed = true;
      this.writable = false;
      events.push({ t: at(), ev: 'close', host: this.host, port: this.port });
      queueMicrotask(() => this.emit('close'));
      return this;
    }
    end() { return this.destroy(); }
  }

  net.Socket = FakeSocket;
  return {
    wire,
    bytes,
    events,
    // Registerbild: 16-bit-Wort bzw. 32-bit-Wert (High-Wort zuerst) je Unit-ID.
    set(unitId, address, value) { regs.set(`${unitId}:${address}`, Number(value) & 0xffff); return this; },
    set32(unitId, address, value) {
      const raw = value < 0 ? value + 0x100000000 : value;
      this.set(unitId, address, Math.floor(raw / 0x10000));
      return this.set(unitId, address + 1, raw & 0xffff);
    },
    silence(address) { silent.add(address); },
    unsilence(address) { silent.delete(address); },
    // Antwort auf Anfragen an `address` verändern: fn(fertiger Antwortrahmen, { fc, unitId, address, word, framing })
    // → null (keine Antwort), ein Buffer oder Teilstücke [{ bytes, delayMs, toLive }]. toLive: an den dann aktuell
    // verbundenen Socket statt an den, der gefragt hat (transparentes Gateway gibt serielle Bytes an jede Verbindung).
    mutate(address, fn) { mutators.set(address, fn); },
    unmutate(address) { mutators.delete(address); },
    // Bytes ohne Anfrage auf die aktuell verbundene Verbindung schicken (z. B. eine späte Antwort vom Bus).
    inject(buf) { const s = live(); if (s) s.emit('data', Buffer.from(buf)); return !!s; },
    // Die Gegenstelle legt auf (die aktuell verbundene Verbindung schließt von der Geräteseite).
    hangUp() { const s = live(); if (s) s.destroy(); return !!s; },
    resetClock() { t0 = Date.now(); },
    restore() { net.Socket = OriginalSocket; },
  };
}

// Mikrotasks und Socket-Ereignisse abarbeiten (setImmediate ist nicht verspottet).
export async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
}

// Virtuelle Uhr in kleinen Schritten vorstellen; zwischen den Schritten laufen Mikrotasks (Antworten, _next).
export async function advance(ms, step = 50) {
  const end = Date.now() + ms;
  await flush();
  while (Date.now() < end) {
    mock.timers.tick(Math.min(step, end - Date.now()));
    await flush();
  }
}

export function enableFakeClock(now = 1_800_000_000_000) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
}

export function disableFakeClock() {
  mock.timers.reset();
}
