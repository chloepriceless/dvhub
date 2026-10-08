import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildSntpRequest, parseSntpResponse, querySntp, createClockCheck, CLOCK_WARN_OFFSET_MS
} from '../services/clock-check.js';

const NTP_EPOCH_OFFSET_S = 2208988800;
function ntpTs(buf, offset, ms) {
  buf.writeUInt32BE((Math.floor(ms / 1000) + NTP_EPOCH_OFFSET_S) >>> 0, offset);
  buf.writeUInt32BE(Math.round(((ms % 1000) / 1000) * 2 ** 32) >>> 0, offset + 4);
}
function response({ t2, t3, mode = 4, stratum = 2 }) {
  const buf = Buffer.alloc(48);
  buf[0] = (4 << 3) | mode;
  buf[1] = stratum;
  ntpTs(buf, 32, t2);
  ntpTs(buf, 40, t3);
  return buf;
}

test('SNTP-Anfrage: 48 Byte, Client-Modus, Sendezeit im Transmit-Feld', () => {
  const t1 = Date.UTC(2026, 9, 3, 20, 53, 22, 250);
  const req = buildSntpRequest(t1);
  assert.equal(req.length, 48);
  assert.equal(req[0], 0x23);
  assert.equal(req.readUInt32BE(40), Math.floor(t1 / 1000) + NTP_EPOCH_OFFSET_S);
});

test('Abweichung: lokale Uhr geht 1,5 s nach → offset +1500 ms, Laufzeit herausgerechnet', () => {
  const t1 = 1_790_000_000_000;         // lokal gesendet
  const t4 = t1 + 40;                    // lokal empfangen (40 ms Umlauf)
  const t2 = t1 + 1500 + 15;             // Server empfängt (Serverzeit)
  const t3 = t2 + 10;                    // Server sendet nach 10 ms
  const r = parseSntpResponse(response({ t2, t3 }), t1, t4);
  assert.ok(Math.abs(r.offsetMs - 1500) < 1, `offset ${r.offsetMs}`);
  assert.ok(Math.abs(r.delayMs - 30) < 1, `delay ${r.delayMs}`);
});

test('ungültige Antworten werden verworfen', () => {
  const t = 1_790_000_000_000;
  assert.equal(parseSntpResponse(Buffer.alloc(10), t, t), null, 'zu kurz');
  assert.equal(parseSntpResponse(response({ t2: t, t3: t, mode: 3 }), t, t), null, 'kein Server-Paket');
  assert.equal(parseSntpResponse(response({ t2: t, t3: t, stratum: 0 }), t, t), null, 'kiss of death');
});

function fakeDgram(reply) {
  const sent = [];
  return {
    sent,
    createSocket() {
      const socket = new EventEmitter();
      socket.close = () => { socket.closed = true; };
      socket.send = (buf, port, host, cb) => {
        sent.push({ port, host, length: buf.length });
        cb(null);
        const msg = reply(buf);
        if (msg) setImmediate(() => socket.emit('message', msg));
      };
      return socket;
    }
  };
}

test('querySntp: fragt Port 123 und liefert die Abweichung; Zeitüberschreitung wird gemeldet', async () => {
  const clock = 1_790_000_000_000;
  const lib = fakeDgram(() => response({ t2: clock - 3000, t3: clock - 3000 }));
  const r = await querySntp({ server: 'zeit.example', dgramLib: lib, now: () => clock });
  assert.deepEqual(lib.sent, [{ port: 123, host: 'zeit.example', length: 48 }]);
  assert.ok(Math.abs(r.offsetMs + 3000) < 1, 'lokale Uhr geht 3 s vor');

  // Der Zeitüberschreitungs-Timer hält den Prozess absichtlich nicht am Leben
  // (unref). Ohne echten Socket gäbe es hier sonst nichts, worauf Node wartet —
  // der Testprozess endete, bevor die Zeitüberschreitung gemeldet ist.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(querySntp({ dgramLib: fakeDgram(() => null), timeoutMs: 20 }), /timeout/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('Dienst: Status, Warnung einmal je Zustandswechsel, kein Alarm ohne Internet', async () => {
  const logs = [];
  const checks = [];
  const state = {};
  let result = { offsetMs: 120.4, delayMs: 18 };
  let cfg = {};
  const svc = createClockCheck(
    { getCfg: () => cfg, state, pushLog: (event, data, level) => { if (event === 'clock_check') checks.push(data); else logs.push({ event, data, level }); } },
    { query: async ({ server }) => { if (result instanceof Error) throw result; return { ...result, server }; }, now: () => 42 }
  );

  await svc.check();
  assert.deepEqual(state.clock, { enabled: true, ok: true, offsetMs: 120, delayMs: 18, server: 'pool.ntp.org', checkedAt: 42, error: null });
  assert.equal(logs.length, 0);
  assert.deepEqual(checks, [{ offsetMs: 120, offsetSec: 0.12, delayMs: 18, server: 'pool.ntp.org', ok: true }], 'jede Prüfung steht im Protokoll');

  result = { offsetMs: CLOCK_WARN_OFFSET_MS + 700, delayMs: 20 };
  await svc.check(); await svc.check();
  assert.equal(state.clock.ok, false);
  assert.deepEqual(logs.map((l) => [l.event, l.level]), [['clock_offset_warning', 'warn']], 'nur eine Warnung');
  assert.equal(logs[0].data.offsetMs, 2700);

  result = new Error('timeout');
  await svc.check();
  assert.equal(state.clock.error, 'timeout');
  assert.equal(state.clock.ok, false, 'letzter bekannter Stand bleibt');
  assert.equal(logs.length, 1, 'nicht prüfbar ist kein Alarm');
  assert.equal(checks.length, 3, 'ohne Antwort keine Prüfzeile');
  assert.equal(checks[2].offsetSec, 2.7);

  result = { offsetMs: -30, delayMs: 20 };
  await svc.check();
  assert.deepEqual(logs.map((l) => l.event), ['clock_offset_warning', 'clock_offset_ok']);

  cfg = { clockCheck: { enabled: false } };
  await svc.check();
  assert.deepEqual(state.clock, { enabled: false });

  cfg = { clockCheck: { server: 'ntp.intern', warnOffsetMs: 10 } };
  await svc.check();
  assert.equal(state.clock.server, 'ntp.intern');
  assert.equal(state.clock.ok, false, 'eigene Schwelle 10 ms');
});

test('ohne Internet von Anfang an: ok bleibt unbestimmt', async () => {
  const state = {};
  const svc = createClockCheck({ getCfg: () => ({}), state }, { query: async () => { throw new Error('ENETUNREACH'); } });
  await svc.check();
  assert.equal(state.clock.ok, null);
  assert.equal(state.clock.error, 'ENETUNREACH');
});
