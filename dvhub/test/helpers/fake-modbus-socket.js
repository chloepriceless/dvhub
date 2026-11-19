// Schein-Modbus-TCP-Gerät auf Socket-Ebene für Zeit-Tests des echten Transports (transport-modbus.js, E7) mit
// falscher Uhr (node:test mock.timers für setTimeout und Date). Ersetzt net.Socket, solange installiert: der Transport
// baut seinen Socket mit `new net.Socket()`, also landet jede Verbindung hier. Kein Netzwerk.
//
// Jeder Rahmen auf dem Draht steht mit virtueller Uhrzeit im Protokoll (`wire`), Verbindungsaufbau und -abbau in
// `events`. Antworten kommen aus einem Registerbild je (Unit-ID, Adresse); Writes (FC 5/6/16) werden bestätigt.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';

export function installFakeModbusSockets({ connectLatencyMs = 0, respondDelayMs = 0 } = {}) {
  const OriginalSocket = net.Socket;
  const regs = new Map();
  const wire = [];
  const events = [];
  const silent = new Set(); // Adressen ohne Antwort (Zeitüberschreitung)
  let t0 = Date.now();
  const at = () => Date.now() - t0;

  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.writable = true;
    }
    setKeepAlive() { return this; }
    connect(port, host) {
      this.port = port;
      this.host = host;
      const done = () => {
        if (this.destroyed) return;
        events.push({ t: at(), ev: 'connect', host, port });
        this.emit('connect');
      };
      if (connectLatencyMs > 0) setTimeout(done, connectLatencyMs);
      else queueMicrotask(done);
      return this;
    }
    write(buf) {
      const req = Buffer.from(buf);
      const fc = req.readUInt8(7);
      const unitId = req.readUInt8(6);
      const address = req.readUInt16BE(8);
      const word = req.readUInt16BE(10);
      const detail = fc <= 4 ? { quantity: word }
        : fc === 16 ? { values: Array.from({ length: word }, (_, i) => req.readUInt16BE(13 + i * 2)) }
          : { value: word };
      wire.push({ t: at(), fc, unitId, address, ...detail });
      if (silent.has(address)) return true;
      let res;
      if (fc === 3 || fc === 4) {
        const words = [];
        for (let i = 0; i < word; i += 1) words.push(regs.get(`${unitId}:${address + i}`) ?? 0);
        res = Buffer.alloc(9 + words.length * 2);
        req.copy(res, 0, 0, 4);
        res.writeUInt16BE(3 + words.length * 2, 4);
        res.writeUInt8(unitId, 6);
        res.writeUInt8(fc, 7);
        res.writeUInt8(words.length * 2, 8);
        words.forEach((w, i) => res.writeUInt16BE(w & 0xffff, 9 + i * 2));
      } else {
        // FC 5/6/16: Echo von Adresse und Wert bzw. Anzahl (die ersten 12 Byte des Auftrags, Länge 6).
        res = Buffer.from(req.subarray(0, 12));
        res.writeUInt16BE(6, 4);
      }
      const deliver = () => { if (!this.destroyed) this.emit('data', res); };
      if (respondDelayMs > 0) setTimeout(deliver, respondDelayMs);
      else queueMicrotask(deliver);
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
