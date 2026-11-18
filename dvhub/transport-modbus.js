import net from 'node:net';
import {
  isReadOnlyMode,
  modbusWriteFunctionCode,
  noteBlockedWrite,
  ReadOnlyViolation
} from './read-only-guard.js';
// Plan 09-06 (D-08): services/log.js wrapper imported for Modbus connect/reconnect/error
// surfaces. The current transport routes errors through Promise rejections to the polling
// loop (which calls pushLog); the wrapper is the new preferred path for any direct stderr-
// style output without touching console.* directly.
// eslint-disable-next-line no-unused-vars
import { info as logInfo, warn as logWarn, error as logError, debug as logDebug } from './services/log.js';
// Plan 09-07: safeInterval reserved import — Modbus transport currently uses
// setTimeout-based reconnect chains (no setInterval call sites today). Import
// kept so future setInterval introductions inherit the helper without a
// separate edit. Auditable via grep "from './services/safe-async.js'".
// eslint-disable-next-line no-unused-vars
import { safeInterval } from './services/safe-async.js';

// A7 (Paritätsfund dvhub-rs ABWEICHUNGEN): Schreib-Sperre für den Not-Halt.
// Jeder Write merkt sich beim Einreihen die aktuelle Generation; direkt vor dem
// Draht wird ein Write aus einer älteren Generation verworfen. setEmergencyStop
// erhöht die Generation einmal beim Eintritt — davor eingereihte Sollwerte
// gehen nicht mehr raus, die eine Rücknahme danach schon. Prozessweit, damit
// alle Modbus-Verbindungen (Haupt-GX, zweite GX, Scan, Heizstab) gelten.
let writeFenceGeneration = 0;
export function fenceModbusWrites() {
  writeFenceGeneration += 1;
  return writeFenceGeneration;
}
export function modbusWriteFenceGeneration() {
  return writeFenceGeneration;
}

// E7 (18.11.2026): Anfrage-Taktung je Verbindung (host:port). Manche Geräte vertragen keine Anfragen direkt
// hintereinander: SMA verlangt ≥ 10 s zwischen Modbus-Transfers und höchstens fünf Werte je Transfer
// (SMA-Modbus-general-TI-en-10 §3.7), Solis > 300 ms zwischen Frames, Huawei eine Pause nach dem Verbindungsaufbau.
// Die Werte kommen aus dem Herstellerprofil (`victron.requestPacing`) und gelten für JEDE Anfrage auf dieser
// Verbindung — Lesen und Schreiben, in der Reihenfolge der Warteschlange. Ohne Einstellung (alle mitgelieferten
// Stable-Profile) läuft der Transport wie bisher: kein Zeitgeber, keine Wartezeit, dieselbe Reihenfolge.
//   minRequestGapMs        Mindestabstand vom Ende einer Anfrage (Antwort, Fehler, Zeitüberschreitung) bis zur
//                          nächsten auf derselben Verbindung
//   connectDelayMs         Pause nach jedem (Neu-)Aufbau der TCP-Verbindung vor der ersten Anfrage
//   maxRegistersPerRequest höchstens so viele Register je Lese-Anfrage (FC 3/4); längere Blöcke werden in
//                          Teil-Anfragen zerlegt (gleich hintereinander eingereiht) und wieder zusammengesetzt. Bei
//                          32-bit-Werten eine gerade Zahl wählen, sonst landen die Hälften eines Werts in zwei Anfragen.
//                          Lesungen der Lese-Engine (ein Wert, Wert + Skalenfaktor, combineBlock) zerlegt der Transport
//                          nie (opts.atomic): über dem Deckel sind sie ein Lesefehler statt einer Mischung zweier Proben.
// minPollIntervalMs (Mindestabstand der Poll-Takte) liest polling.js aus demselben Block.
// Ungültige oder fehlende Werte gelten als „aus“ (0).
const PACING_MAX_GAP_MS = 600_000;
const PACING_MAX_CONNECT_DELAY_MS = 60_000;
export function normalizeModbusPacing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ms = (v, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : 0;
  };
  const minRequestGapMs = ms(raw.minRequestGapMs, PACING_MAX_GAP_MS);
  const connectDelayMs = ms(raw.connectDelayMs, PACING_MAX_CONNECT_DELAY_MS);
  const cap = Number(raw.maxRegistersPerRequest);
  // 125 = Grenze des Modbus-Lesebefehls; darüber gibt es nichts zu begrenzen.
  const maxRegistersPerRequest = Number.isInteger(cap) && cap >= 1 && cap < 125 ? cap : 0;
  if (!minRequestGapMs && !connectDelayMs && !maxRegistersPerRequest) return null;
  return { minRequestGapMs, connectDelayMs, maxRegistersPerRequest };
}

// Resolver für createModbusTransport({ pacingFor }) aus der wirksamen Config: die Taktung des Profils
// (`victron.requestPacing`) gilt nur für die Anlagen-Verbindung victron.host:victron.port — nicht für Wallboxen,
// Zähler auf anderen Adressen oder andere Ports. Liest die Config bei jedem Aufruf (Änderungen ohne Neustart).
export function modbusPacingFromConfig(getCfg) {
  return (host, port) => {
    const v = getCfg?.()?.victron;
    if (!v || v.transport === 'mqtt' || !v.requestPacing) return null;
    if (String(host ?? '') !== String(v.host ?? '') || Number(port) !== Number(v.port)) return null;
    return v.requestPacing;
  };
}

/**
 * Modbus TCP Transport für Victron-Kommunikation.
 * Extrahiert aus server.js — reiner Modbus-Client (kein Server).
 * opts.pacingFor(host, port) → Taktung dieser Verbindung (E7, siehe normalizeModbusPacing) oder null.
 */
export function createModbusTransport(opts = {}) {
  const mbPool = new Map();
  // E7: Taktung je Verbindung, bei jeder Anfrage neu aufgelöst. Ohne Resolver (oder bei einem Fehler darin): keine.
  const pacingFor = typeof opts.pacingFor === 'function' ? opts.pacingFor : null;
  function pacingOf(host, port) {
    if (!pacingFor) return null;
    try {
      return normalizeModbusPacing(pacingFor(host, port));
    } catch {
      return null;
    }
  }
  // E7: Ende der letzten Anfrage je host:port. Auf Pool-Ebene, damit der Abstand auch über einen Neuaufbau der
  // Verbindung (Leerlauf-Abbau, dropConnections, Zeitüberschreitung) hinweg gilt.
  const lastTransferEndAt = new Map();
  // Leerlauf bis zum Abbau einer Verbindung (opts.idleMs nur für Tests).
  const MB_IDLE_MS = Number(opts.idleMs) > 0 ? Number(opts.idleMs) : 30000;
  const MB_QUEUE_MAX = 256;
  // Plan 25-04 (Befund 4): Connect-Timeout-Guard. Default 5000 ms (config-getrieben
  // über victron.modbusConnectTimeoutMs). Bricht einen hängenden TCP-Connect zu einem
  // toten/firewalled Host ab, bevor der OS-Default (~75-130 s) den Poll-Zyklus blockiert.
  const connectTimeoutMs = Number(opts.connectTimeoutMs) > 0 ? Number(opts.connectTimeoutMs) : 5000;
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
      connectTimer: null,
      // E7: Zeitgeber, solange die nächste Anfrage auf ihren Abstand bzw. die Pause nach dem Verbindungsaufbau
      // wartet (nur mit Taktung gesetzt), und der Zeitpunkt des 'connect' des aktuellen Sockets (0 = noch nicht).
      gapTimer: null,
      connectedAt: 0,
      // E7: eine Anfrage ist zu Ende (Antwort, Fehler, Zeitüberschreitung) — Bezugspunkt für minRequestGapMs.
      _markTransferEnd() {
        lastTransferEndAt.set(this.key, Date.now());
      },
      _clearGapTimer() {
        if (this.gapTimer) {
          clearTimeout(this.gapTimer);
          this.gapTimer = null;
        }
      },
      connect() {
        if (this.sock && !this.sock.destroyed) return;
        // Paritätsfund A4 (dvhub-rs ABWEICHUNGEN): jedes Ereignis gilt nur für
        // SEINEN Socket. Früher rief das close-Ereignis eines nach einer
        // Zeitüberschreitung verworfenen Sockets _fail auf der schon neu
        // aufgebauten Verbindung — der Rest des Poll-Takts scheiterte mit
        // „connection closed“.
        const sock = new net.Socket();
        this.sock = sock;
        this.connectedAt = 0;
        const current = () => this.sock === sock;
        sock.setKeepAlive(true, 10000);
        sock.connect(port, host);
        // Plan 25-04 (Befund 4 / Pitfall 3): Connect-Timeout-Guard. Greift NUR in
        // der Connect-Phase. Bei ausbleibendem 'connect' (stiller SYN-Drop eines
        // toten/firewalled Hosts) wird der Socket über denselben _fail-Pfad
        // destroyed wie ein echter Connect-Fehler → konsistente Rejection an die
        // Poll-Schleife, kein OS-Default-Hang. NACH 'connect' wird der Timer
        // ge-clear-t, damit langlebige/seltene Polls NICHT als Idle abgebrochen
        // werden (setTimeout ist KEIN Idle-Timeout — vgl. Pitfall 3).
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = setTimeout(() => {
          this.connectTimer = null;
          if (current()) this._fail(new Error('modbus connect timeout'));
        }, connectTimeoutMs);
        this.connectTimer.unref();
        sock.once('connect', () => {
          if (!current()) return;
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
          this.connectedAt = Date.now();
        });
        sock.on('data', (chunk) => {
          if (!current()) return;
          this.buf = Buffer.concat([this.buf, chunk]);
          this._drain();
        });
        // Ein verworfener Socket darf keinen unbehandelten 'error' werfen,
        // aber auch nichts mehr an der neuen Verbindung abbrechen.
        sock.on('error', (e) => { if (current()) this._fail(e); });
        sock.on('close', () => { if (current()) this._fail(new Error('connection closed')); });
      },
      _resetIdle() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.destroy(), MB_IDLE_MS);
      },
      _drain() {
        while (this.pending && this.buf.length >= 7) {
          const len = this.buf.readUInt16BE(4);
          // A8 (Paritätsfund dvhub-rs): Modbus-TCP-Rahmen sind höchstens 260 Byte
          // (Längenfeld ≤ 254). Ein größeres Längenfeld ist Unsinn — sofort als
          // Fehler werten, statt auf bis zu 64 KiB zu warten.
          if (len > 254) {
            this._fail(new Error(`invalid modbus frame length ${len}`));
            return;
          }
          const total = 6 + len;
          if (this.buf.length < total) break;
          const frame = this.buf.subarray(0, total);
          this.buf = this.buf.subarray(total);
          const p = this.pending;
          this.pending = null;
          if (p.timer) clearTimeout(p.timer);
          this._markTransferEnd();
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
        // Plan 25-04: Connect-Guard ebenfalls clearen, damit ein bereits über
        // _fail abgebrochener Connect keinen verwaisten Timer hinterlässt.
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        // E7: wartende Anfragen werden unten abgewiesen — kein Zeitgeber, der danach noch sendet.
        this._clearGapTimer();
        const p = this.pending;
        if (p) {
          this.pending = null;
          if (p.timer) clearTimeout(p.timer);
          this._markTransferEnd();
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
        // Plan 25-04: Connect-Guard beim Pool-Cleanup ebenfalls clearen.
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        this._clearGapTimer();
        // Reject pending/queued requests without killing the socket yet
        const p = this.pending;
        if (p) {
          this.pending = null;
          if (p.timer) clearTimeout(p.timer);
          this._markTransferEnd();
          p.reject(new Error('pool cleanup'));
        }
        for (const q of this.queue) {
          if (q.timer) clearTimeout(q.timer);
          q.reject(new Error('pool cleanup'));
        }
        this.queue = [];
        this.buf = Buffer.alloc(0);
        mbPool.delete(this.key);
        // Graceful close: send FIN instead of RST so the remote side
        // sees a clean TCP disconnect and releases resources.
        const sock = this.sock;
        this.sock = null;
        if (sock && !sock.destroyed) {
          sock.end();
          // Force-kill if the remote doesn't close within 2s
          setTimeout(() => { if (!sock.destroyed) sock.destroy(); }, 2000).unref();
        }
      },
      send(reqBuf, timeoutMs) {
        return new Promise((resolve, reject) => {
          // Lese-Modus: Schreib-Telegramme gar nicht erst einreihen. Dies ist
          // die einzige Stelle, durch die jede Modbus-Anfrage laeuft — was
          // hier abgelehnt wird, erreicht die Anlage nicht.
          if (isReadOnlyMode()) {
            const fc = modbusWriteFunctionCode(reqBuf);
            if (fc !== null) {
              noteBlockedWrite(`Modbus fc=${fc} an ${this.key}`);
              reject(new ReadOnlyViolation(`Schreibzugriff im Lese-Modus abgelehnt (Modbus fc=${fc})`));
              return;
            }
          }
          // A8: Warteschlange begrenzen — hängt das Gerät, wächst sie sonst ohne Ende.
          if (this.queue.length >= MB_QUEUE_MAX) {
            reject(new Error('modbus queue full'));
            return;
          }
          const isWrite = modbusWriteFunctionCode(reqBuf) !== null;
          const entry = { reqBuf, resolve, reject, timer: null, timeoutMs, fence: isWrite ? writeFenceGeneration : null };
          this.queue.push(entry);
          this._next();
        });
      },
      _next() {
        if (this.pending || !this.queue.length) return;
        // E7: die nächste Anfrage wartet schon auf ihren Abstand — der Zeitgeber sendet sie (nur mit Taktung).
        if (this.gapTimer) return;
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
        const pace = pacingOf(host, port);
        if (pace) {
          // E7: nie in einen noch nicht verbundenen Socket schreiben — der 'connect'-Listener aus dem
          // Verbindungsaufbau oben ruft _next erneut, dann zählt die Pause ab connectedAt.
          if (!this.connectedAt) return;
          const lastEnd = lastTransferEndAt.get(this.key);
          const readyAt = Math.max(
            this.connectedAt + pace.connectDelayMs,
            lastEnd != null ? lastEnd + pace.minRequestGapMs : 0
          );
          const wait = readyAt - Date.now();
          if (wait > 0) {
            // Die Verbindung ist nicht im Leerlauf, sie wartet auf ihren Takt: kein Leerlauf-Abbau, der die
            // wartenden Anfragen mit „pool cleanup“ abbräche. Die Schreib-Sperre (A7) prüft der Durchlauf nach dem
            // Warten — ein in der Wartezeit überholter Write geht nicht mehr raus.
            if (this.idleTimer) {
              clearTimeout(this.idleTimer);
              this.idleTimer = null;
            }
            this.gapTimer = setTimeout(() => {
              this.gapTimer = null;
              this._next();
            }, wait);
            return;
          }
        }
        let entry = this.queue.shift();
        // A7: vor der Schreib-Sperre eingereihte Writes verwerfen (nie auf den Draht).
        while (entry && entry.fence !== null && entry.fence !== writeFenceGeneration) {
          entry.reject(new Error('modbus write verworfen (Not-Halt seit dem Einreihen)'));
          entry = this.queue.shift();
        }
        if (!entry) {
          // Alles verworfen: Verbindung trotzdem nach Leerlauf abbauen (Codex 56e41b93, P2).
          this._resetIdle();
          return;
        }
        this.pending = entry;
        // Eine Anfrage läuft: kein Leerlauf. Der Timer startet nach der Antwort
        // neu (_drain → _resetIdle). Sonst konnte der Timer einer früheren
        // Antwort — auch einer schon verworfenen Verbindung — die laufende
        // Anfrage mit „pool cleanup“ abbrechen (Codex a24eeff6, P2).
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = null;
        }
        entry.timer = setTimeout(() => {
          if (this.pending === entry) {
            this.pending = null;
            this._markTransferEnd();
            entry.reject(new Error('modbus timeout'));
            // Socket verwerfen (eine späte Antwort darf keiner Folgeanfrage
            // zugeordnet werden) und angefangene Bytes vergessen. Erst
            // this.sock lösen, dann zerstören: dessen close-/error-Ereignis
            // gilt damit nicht mehr als „aktueller Socket“ (A4).
            const old = this.sock;
            this.sock = null;
            this.buf = Buffer.alloc(0);
            if (this.idleTimer) {
              clearTimeout(this.idleTimer);
              this.idleTimer = null;
            }
            if (old && !old.destroyed) old.destroy();
            this._next();
          }
        }, entry.timeoutMs || 1000);
        this.sock.write(entry.reqBuf);
      }
    };
    mbPool.set(key, c);
    return c;
  }

  // opts.atomic (Lese-Engine, Codex 742c52c9): diese Lesung ist EIN Messzeitpunkt (ein Wert, Wert + Skalenfaktor,
  // combineBlock) und darf nie in Teil-Anfragen zerlegt werden — über dem Deckel ein Lesefehler statt einer Mischung.
  function mbRequest(args, opts = {}) {
    const { host, port, fc, address, quantity } = args;
    // A6 (Paritätsfund dvhub-rs, Codex adc3a82): nur Lese-Funktionen 1–4. Mit
    // FC 6 wäre die „Lese“-Anfrage ein gültiger Write gewesen (quantity = Wert).
    if (![1, 2, 3, 4].includes(Number(fc))) {
      return Promise.reject(new Error(`modbus read: fc ${fc} ist keine Lese-Funktion`));
    }
    // E7: höchstens maxRegistersPerRequest Register je Anfrage (nur Register-Lesen FC 3/4; FC 1/2 zählen Bits).
    // Die Teil-Anfragen werden in einem Zug eingereiht, stehen also direkt hintereinander in der Warteschlange.
    const cap = (Number(fc) === 3 || Number(fc) === 4) ? pacingOf(host, port)?.maxRegistersPerRequest : 0;
    const total = Number(quantity);
    if (cap && Number.isInteger(total) && total > cap && Number.isInteger(address) && address >= 0 && address + total - 1 <= 0xffff) {
      if (opts?.atomic) {
        return Promise.reject(new Error(`modbus read: ${total} Register ab ${address} müssen in einer Anfrage gelesen werden, die Verbindung erlaubt höchstens ${cap} (maxRegistersPerRequest)`));
      }
      const parts = [];
      for (let off = 0; off < total; off += cap) {
        parts.push(mbRequestOnce({ ...args, address: address + off, quantity: Math.min(cap, total - off) }));
      }
      return Promise.all(parts).then((chunks) => chunks.flat());
    }
    return mbRequestOnce(args);
  }

  function mbRequestOnce({ host, port, unitId, fc, address, quantity, timeoutMs }) {
    const tid = (tidCounter++ & 0xffff) || 1;
    const req = Buffer.alloc(12);
    req.writeUInt16BE(tid, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(6, 4);
    req.writeUInt8(unitId, 6);
    req.writeUInt8(fc, 7);
    req.writeUInt16BE(address, 8);
    req.writeUInt16BE(quantity, 10);
    // Angefragte Menge, wie sie auf den Draht ging (Grundlage der Längenprüfung).
    const wireQuantity = req.readUInt16BE(10);

    const conn = getMbConn(host, port);
    return conn.send(req, timeoutMs).then((frame) => {
      const rTid = frame.readUInt16BE(0);
      const pid = frame.readUInt16BE(2);
      const unit = frame.readUInt8(6);
      const rFc = frame.readUInt8(7);
      const quantity = wireQuantity;
      if (pid !== 0 || unit !== unitId || rTid !== tid) throw new Error('invalid modbus response');
      if ((rFc & 0x80) === 0x80) throw new Error(`modbus exception ${frame.readUInt8(8)}`);
      if (rFc !== fc) throw new Error(`unexpected fc ${rFc}`);
      // Paritätsfund A5 (dvhub-rs ABWEICHUNGEN): eine Antwort mit weniger
      // Daten als angefragt ist ein Lesefehler. Früher wurden fehlende Wörter
      // beim Aufrufer zu 0 — der Netzzähler galt dann als „ok“ mit 0 W, und
      // Netzanschluss-Wächter und §14a-Budget rechneten mit erfundenen Werten.
      const byteCount = frame.length > 8 ? frame.readUInt8(8) : 0;
      const wantBytes = fc <= 2 ? Math.ceil(quantity / 8) : quantity * 2;
      const available = Math.max(0, frame.length - 9);
      if (byteCount !== wantBytes || available < wantBytes) {
        const got = Math.floor(Math.min(byteCount, available) / 2);
        throw new Error(`modbus short response (${got} von ${quantity} Registern)`);
      }
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
      // Echo-Prüfung (Codex-Review R3): FC6 antwortet mit Adresse und Wert des
      // Auftrags. Falsche Adresse = falsches Register bestätigt → Fehler. Ein
      // abweichender Wert wird nur gemeldet: manche Geräte maskieren Bits oder
      // runden, und ein harter Fehler stoppte dort die Steuerung.
      if (frame.length < 12) throw new Error('invalid write ack (short frame)');
      const ackAddr = frame.readUInt16BE(8);
      const ackValue = frame.readUInt16BE(10);
      if (ackAddr !== (Number(address) & 0xffff)) throw new Error(`invalid write ack (address ${ackAddr} ≠ ${address})`);
      const echoMismatch = ackValue !== (value & 0xffff);
      if (echoMismatch) logWarn('modbus write ack value differs', { host, unitId, address, sent: value & 0xffff, ack: ackValue });
      return { addr: ackAddr, value: ackValue, echoMismatch };
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
      // FC16 bestätigt Startadresse und Registeranzahl (Codex-Review R3).
      if (frame.length < 12) throw new Error('invalid write ack (short frame)');
      const ackAddr = frame.readUInt16BE(8);
      const ackQty = frame.readUInt16BE(10);
      if (ackAddr !== (Number(address) & 0xffff)) throw new Error(`invalid write ack (address ${ackAddr} ≠ ${address})`);
      if (ackQty !== qty) throw new Error(`invalid write ack (quantity ${ackQty} ≠ ${qty})`);
      return { addr: ackAddr, quantity: ackQty };
    });
  }

  // FC5 Write Single Coil (Phoenix EV Charge Control: Coil 400 „Ladevorgang freigeben“).
  // Ein = 0xFF00, aus = 0x0000; die Antwort spiegelt Adresse und Wert.
  function mbWriteCoil({ host, port, unitId, address, value, timeoutMs }) {
    const tid = (tidCounter++ & 0xffff) || 1;
    const word = value ? 0xff00 : 0x0000;
    const req = Buffer.alloc(12);
    req.writeUInt16BE(tid, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(6, 4);
    req.writeUInt8(unitId, 6);
    req.writeUInt8(5, 7);
    req.writeUInt16BE(address, 8);
    req.writeUInt16BE(word, 10);

    const conn = getMbConn(host, port);
    return conn.send(req, timeoutMs).then((frame) => {
      const rTid = frame.readUInt16BE(0);
      const pid = frame.readUInt16BE(2);
      const unit = frame.readUInt8(6);
      const fc = frame.readUInt8(7);
      if (pid !== 0 || unit !== unitId || rTid !== tid) throw new Error('invalid write ack');
      if ((fc & 0x80) === 0x80) throw new Error(`modbus exception ${frame.readUInt8(8)}`);
      if (fc !== 5) throw new Error('invalid write ack');
      if (frame.length < 12) throw new Error('invalid write ack (short frame)');
      const ackAddr = frame.readUInt16BE(8);
      if (ackAddr !== (Number(address) & 0xffff)) throw new Error(`invalid write ack (address ${ackAddr} ≠ ${address})`);
      return { addr: ackAddr, value: frame.readUInt16BE(10) === 0xff00 };
    });
  }

  return {
    type: 'modbus',
    async init() { /* Modbus verbindet on-demand */ },
    mbRequest,
    mbWriteSingle,
    mbWriteMultiple,
    mbWriteCoil,
    // T-FREEZE (2026-07-24): alle gepoolten Sessions verwerfen. Der Pool baut beim
    // nächsten Request von selbst neu auf (connect on-demand) — der Aufrufer muss
    // nichts weiter tun. Anlass: der GX (dbus-modbustcp v1.0.93) räumt tote
    // Modbus-Sessions nicht ab; eine halb-tote Session liefert weiter ERFOLGREICHE
    // Reads mit eingefrorenen Werten. Ein sauberer FIN + Neuaufbau ist die einzige
    // Handhabe, die DVhub auf seiner Seite hat. Gibt die Zahl der verworfenen
    // Verbindungen zurück (Log/Diagnose).
    dropConnections() {
      const n = mbPool.size;
      for (const c of [...mbPool.values()]) c.destroy();
      mbPool.clear();
      return n;
    },
    async destroy() {
      for (const c of mbPool.values()) c.destroy();
      mbPool.clear();
    }
  };
}
