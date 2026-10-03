// services/clock-check.js — prüft die Systemuhr gegen einen Zeitserver.
//
// DVhub hängt an der Uhr: EOS-Läufe starten zur vollen Viertelstunde der Börse,
// Zeitpläne und 15-min-Slots ebenso. Ein Container kann die Uhr nicht stellen
// (alle Container teilen die Uhr des Host-Kernels; Stellen bräuchte
// CAP_SYS_TIME) — der Abgleich ist Sache des Betriebssystems der Box
// (systemd-timesyncd/chrony; eHive-Image: DietPi CONFIG_NTP_MODE=4). Boards
// ohne Hardware-Uhr driften sonst Sekunden pro Tag (eHive 2026-10-03: +1,5 s
// bei Abgleich nur „beim Booten + täglich“).
//
// Dieser Dienst STELLT nichts. Er fragt stündlich per SNTP die Abweichung ab,
// legt sie im Status ab (state.clock) und schreibt eine Warnung ins Protokoll,
// sobald die Uhr mehr als warnMs danebenliegt (einmal je Zustandswechsel).
// Ohne Internet bleibt es bei einem stillen „nicht prüfbar“.

import dgram from 'node:dgram';

export const CLOCK_CHECK_INTERVAL_MS = 3600_000;
export const CLOCK_CHECK_FIRST_DELAY_MS = 60_000;
export const CLOCK_WARN_OFFSET_MS = 2000;
const NTP_EPOCH_OFFSET_S = 2208988800; // 1900-01-01 → 1970-01-01
const DEFAULT_SERVER = 'pool.ntp.org';

/** 48-Byte-Anfrage (SNTP v4, Client); Sendezeit t1 steht im Transmit-Feld. */
export function buildSntpRequest(t1Ms) {
  const buf = Buffer.alloc(48);
  buf[0] = 0x23; // LI 0, Version 4, Mode 3 (Client)
  writeNtpTimestamp(buf, 40, t1Ms);
  return buf;
}

function writeNtpTimestamp(buf, offset, ms) {
  const seconds = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET_S;
  const fraction = Math.round(((ms % 1000) / 1000) * 2 ** 32);
  buf.writeUInt32BE(seconds >>> 0, offset);
  buf.writeUInt32BE(fraction >>> 0, offset + 4);
}

function readNtpTimestamp(buf, offset) {
  const seconds = buf.readUInt32BE(offset) - NTP_EPOCH_OFFSET_S;
  const fraction = buf.readUInt32BE(offset + 4) / 2 ** 32;
  return (seconds + fraction) * 1000;
}

/**
 * Abweichung der lokalen Uhr aus einer SNTP-Antwort.
 * offsetMs > 0: die lokale Uhr geht NACH (Serverzeit ist weiter).
 * @returns {{offsetMs:number, delayMs:number}|null} null bei ungültiger Antwort
 */
export function parseSntpResponse(buf, t1Ms, t4Ms) {
  if (!Buffer.isBuffer(buf) || buf.length < 48) return null;
  const mode = buf[0] & 0x07;
  const stratum = buf[1];
  if (mode !== 4 || stratum === 0 || stratum > 15) return null; // kein Server / „kiss of death“
  const t2 = readNtpTimestamp(buf, 32);
  const t3 = readNtpTimestamp(buf, 40);
  if (!Number.isFinite(t2) || !Number.isFinite(t3) || t3 <= 0) return null;
  return {
    offsetMs: ((t2 - t1Ms) + (t3 - t4Ms)) / 2,
    delayMs: (t4Ms - t1Ms) - (t3 - t2)
  };
}

/** Eine SNTP-Abfrage. Lehnt bei Zeitüberschreitung/Fehler ab. */
export function querySntp({ server = DEFAULT_SERVER, port = 123, timeoutMs = 4000, dgramLib = dgram, now = () => Date.now() } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgramLib.createSocket('udp4');
    let done = false;
    let t1 = 0;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* schon zu */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    timer.unref?.();
    socket.on('error', (error) => finish(error));
    socket.on('message', (msg) => {
      const parsed = parseSntpResponse(msg, t1, now());
      if (!parsed) return finish(new Error('invalid_response'));
      finish(null, parsed);
    });
    t1 = now();
    socket.send(buildSntpRequest(t1), port, server, (error) => { if (error) finish(error); });
  });
}

/**
 * @param {object} ctx
 * @param {()=>object} ctx.getCfg  clockCheck.enabled (Standard an), clockCheck.server
 * @param {object} ctx.state       state.clock wird gesetzt
 * @param {Function} [ctx.pushLog]
 * @param {object} [deps]          Test-Naht: { query, now }
 */
export function createClockCheck(ctx, { query = querySntp, now = () => Date.now() } = {}) {
  const { getCfg, state, pushLog = () => {} } = ctx;
  let firstTimer = null;
  let timer = null;
  let warned = false;

  async function check() {
    const cfg = getCfg()?.clockCheck || {};
    if (cfg.enabled === false) {
      state.clock = { enabled: false };
      return state.clock;
    }
    const server = typeof cfg.server === 'string' && cfg.server.trim() ? cfg.server.trim() : DEFAULT_SERVER;
    const warnMs = Number(cfg.warnOffsetMs) > 0 ? Number(cfg.warnOffsetMs) : CLOCK_WARN_OFFSET_MS;
    try {
      const { offsetMs, delayMs } = await query({ server });
      const rounded = Math.round(offsetMs);
      const ok = Math.abs(rounded) <= warnMs;
      state.clock = { enabled: true, ok, offsetMs: rounded, delayMs: Math.round(delayMs), server, checkedAt: now(), error: null };
      if (!ok && !warned) {
        warned = true;
        pushLog('clock_offset_warning', {
          offsetMs: rounded,
          server,
          hint: 'Systemuhr weicht ab — Zeitabgleich (NTP) des Betriebssystems prüfen; ein Container kann die Uhr nicht stellen.'
        }, 'warn');
      } else if (ok && warned) {
        warned = false;
        pushLog('clock_offset_ok', { offsetMs: rounded, server });
      }
    } catch (error) {
      // Kein Internet / UDP 123 gesperrt: nicht prüfbar, kein Alarm.
      state.clock = { ...(state.clock || {}), enabled: true, server, checkedAt: now(), error: String(error?.message || error) };
      if (state.clock.ok === undefined) state.clock.ok = null;
    }
    return state.clock;
  }

  return {
    check,
    start() {
      if (timer || firstTimer) return;
      firstTimer = setTimeout(() => { firstTimer = null; check().catch(() => {}); }, CLOCK_CHECK_FIRST_DELAY_MS);
      firstTimer.unref?.();
      timer = setInterval(() => { check().catch(() => {}); }, CLOCK_CHECK_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      clearTimeout(firstTimer); clearInterval(timer);
      firstTimer = null; timer = null;
    }
  };
}
