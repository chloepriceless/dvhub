// services/inverter/modbus-health.js — Modbus-Gesundheit je Wechselrichter (N5, Feld 16.11.).
//
// Zählt die Modbus-Aktivität EINER Verbindung (Lesen/Schreiben): Anfragen gesamt, Anfragen/s (gleitendes
// 10-s-Fenster), gemessene Antwortzeit (gleitender Mittelwert der erfolgreichen Anfragen), Modbus-Fehler der
// letzten 24 h (Timeout/Ausnahme) und der letzte Fehler mit Zeit. So sieht der Betreiber in der WR-Kachel, ob der
// gewählte Regeltakt wirklich gehalten wird und wie oft Lesefehler auftreten (Feld: ~1 auf 4000 im 1-s-Takt →
// Modus-0-Abstürze).
//
// wrap(transport) legt sich transparent VOR einen Modbus-Transport: jede mbRequest/mbWriteSingle/mbWriteMultiple
// wird gezählt und durchgereicht; der eigentliche Transport bleibt unverändert (Tests sehen reads/writes weiter am
// Original). snapshot() liefert die aktuellen Kennzahlen für publish()/die Kachel.
//
// M22 (Christin 19.11.): mit { pushLog, wr } wird jeder Modbus-Fehler eine Log-Zeile `sungrow_modbus_error`
// {wr, source, kind, code, fc, address, register, quantity, value, message} — ohne LAN-Adresse. Häufungen fasst DVhub
// zusammen, damit das Protokoll nicht überläuft: im 60-s-Fenster nur der erste Fehler einzeln, der Rest als EINE Zeile
// `sungrow_modbus_error_summary` („12 Fehler in 60 s, Master, ECONNREFUSED"). Hält die Störung an, verdoppelt sich das
// Fenster bis 15 min. Die Kachel behält nur Zähler und letzten Fehler.

// Zeit (A23 b, Christin 23.11.2026): alle Abstände (Anfragen/s-Fenster, 24-h-Fehler, Startphase, Antwortzeit,
// Sammelfenster) misst der Zähler mit der monotonen Uhr (monoNow), damit ein Sprung der Systemzeit sie weder dehnt noch
// staucht. lastError.at bleibt Wanduhrzeit (Anzeige). Ohne eigene monotone Uhr nimmt er eine eingespielte Uhr (Tests).

import { pickMonoNow } from '../mono-clock.js';

const REQ_WINDOW_MS = 10_000;   // Fenster für „Anfragen/s"
const DAY_MS = 86_400_000;      // 24 h für die Fehlerzählung
const MAX_REQ_TIMES = 2048;     // Kappung des Zeitstempel-Puffers (Speicher)
// Antwortzeit (N5/M7b): gleitender MEDIAN der letzten Anfragen (robust gegen den langsamen ersten Verbindungsaufbau),
// LAUFEND aktualisiert — nicht ein eingefrorener Startwert. Die ersten STARTUP_MS werden NICHT gewertet (die erste
// Verbindung ist einmalig langsam, am Feld 6436 ms → Auto-Takt hing fälschlich auf 5 s).
const RESP_SAMPLES = 30;
const STARTUP_MS = 60_000;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

const ERROR_WINDOW_MS = 60_000;        // M22: Sammelfenster der Fehler-Zusammenfassung
const ERROR_WINDOW_MAX_MS = 15 * 60_000; // bei anhaltender Störung wächst das Fenster bis hierhin

/**
 * Fehlerart einordnen (M22, Feld: ECONNREFUSED stand fälschlich als „timeout"). Rein.
 *   exception   — Modbus-Ausnahme vom Gerät (code = Nummer, z. B. 4)
 *   refused     — Verbindung abgelehnt (ECONNREFUSED)
 *   unreachable — Netz/Host nicht erreichbar (EHOSTUNREACH, ENETUNREACH, EHOSTDOWN)
 *   timeout     — keine Antwort in der Frist (modbus timeout, connect timeout, ETIMEDOUT)
 *   reset       — Verbindung unterbrochen (ECONNRESET, EPIPE, connection closed, socket, not connected)
 *   other       — alles andere
 * @returns {{kind:string, code:(number|string|null)}}
 */
export function classifyModbusError(message, errCode = null) {
  const m = String(message || '');
  const c = errCode == null ? '' : String(errCode);
  const both = `${c} ${m}`;
  const ex = /modbus exception (\d+)/i.exec(m);
  if (ex) return { kind: 'exception', code: Number(ex[1]) };
  const pick = (re) => (re.test(c) ? c.toUpperCase() : (re.exec(m)?.[0]?.toUpperCase() || null));
  if (/ECONNREFUSED/i.test(both)) return { kind: 'refused', code: 'ECONNREFUSED' };
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/i.test(both)) return { kind: 'unreachable', code: pick(/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/i) };
  if (/ETIMEDOUT|timeout/i.test(both)) return { kind: 'timeout', code: /ETIMEDOUT/i.test(both) ? 'ETIMEDOUT' : null };
  if (/ECONNRESET|EPIPE|connection closed|socket|not connected/i.test(both)) return { kind: 'reset', code: pick(/ECONNRESET|EPIPE/i) };
  return { kind: 'other', code: c || null };
}

const WR_LABEL = { master: 'Master', slave: 'Slave' };

// Codex 7dd3cd43 (P2): keine LAN-Adresse ins Protokoll/in die Kachel. Node schreibt sie in Verbindungsfehler
// („connect ECONNREFUSED 192.168.68.83:502", „getaddrinfo ENOTFOUND wr.local") — Adresse und Port herausnehmen.
export function sanitizeModbusMessage(message) {
  return String(message || '')
    .replace(/\b(connect|getaddrinfo|read|write)\s+(E[A-Z]+)\s+\S+/g, '$1 $2')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<adresse>');
}
// Kurzname eines Fehlercodes für die Zusammenfassung („ECONNREFUSED", „Ausnahme 4", „Timeout").
function codeLabel(kind, code) {
  if (kind === 'exception') return `Ausnahme ${code}`;
  if (code) return String(code);
  return { timeout: 'Timeout', reset: 'Verbindung getrennt', unreachable: 'nicht erreichbar', refused: 'ECONNREFUSED' }[kind] || 'Fehler';
}

// M22: Funktion, Adresse, Menge/Wert einer Anfrage für das Fehler-Protokoll — bewusst OHNE host/port (LAN-Adresse).
// Gemeinsam für den Transport-Mantel (wrap) und für Writes, die das Schreibtor schon vor dem Draht abweist (Lese-Modus,
// services/inverter/sungrow.js unwrapGate) — beide Wege melden denselben Fehler gleich (Parität alt ↔ Tor).
const FC_OF = { mbWriteSingle: 6, mbWriteMultiple: 16 };
export function modbusRequestInfo(method, arg, errCode = null) {
  return {
    errCode,
    fc: FC_OF[method] ?? (arg?.fc ?? null),
    address: arg?.address,
    quantity: method === 'mbRequest' ? (arg?.quantity ?? null) : (method === 'mbWriteMultiple' ? (arg?.values?.length ?? null) : 1),
    // Codex 7dd3cd43 (P2): auch bei FC 16 den geschriebenen Wert (ein Wort → Zahl, mehrere → Liste).
    value: method === 'mbWriteSingle' ? (arg?.value ?? null)
      : (method === 'mbWriteMultiple' && Array.isArray(arg?.values) ? (arg.values.length === 1 ? arg.values[0] : [...arg.values]) : null),
  };
}

export function createModbusHealth(now = Date.now, { pushLog = null, wr = null, source = null, wireToDoc = (a) => a + 1, monoNow: monoNowArg = null } = {}) {
  const mono = pickMonoNow(monoNowArg, now);
  let total = 0;
  let reqTimes = [];        // Zeitpunkte der letzten Anfragen (monoton, für Anfragen/s)
  const errTimes = [];      // Zeitpunkte der Fehler (monoton, für die 24-h-Zählung)
  let lastError = null;     // { message, kind, at } — at = Wanduhr (Anzeige)
  const respSamples = [];   // Antwortzeiten der letzten RESP_SAMPLES erfolgreichen Anfragen (nach der Startphase)
  let startedAt = null;     // erster Messpunkt (monoton) — die ersten STARTUP_MS werden nicht gewertet
  // M22: Sammelfenster für das Fehler-Protokoll.
  let win = null;           // { start (monoton), lenMs, count, logged, kinds, codes }
  let stormLenMs = 0;       // > 0: die letzte Häufung lief noch — nächstes Fenster so lang
  let lastErrorAt = 0;      // Codex 7dd3cd43: Ruhe zählt ab dem letzten FEHLER, nicht ab dem Fensterende

  function closeWindow(t) {
    if (!win) return;
    const extra = win.count - (win.logged ? 1 : 0);
    if (extra > 0 && typeof pushLog === 'function') {
      const top = Object.entries(win.codes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Fehler';
      const spanS = Math.round(win.lenMs / 1000);
      pushLog('sungrow_modbus_error_summary', {
        wr, source, count: win.count, windowS: spanS, kinds: { ...win.kinds }, codes: { ...win.codes },
        text: `${win.count} Fehler in ${spanS} s, ${WR_LABEL[wr] || wr || 'WR'}, ${top}`,
      }, 'warn');
    }
    stormLenMs = win.count > 1 ? Math.min(ERROR_WINDOW_MAX_MS, win.lenMs * 2) : 0;
    win = null;
  }
  function closeIfDue(t) { if (win && t - win.start >= win.lenMs) closeWindow(t); }
  function reportError(entry, t) {
    if (typeof pushLog !== 'function') return;
    closeIfDue(t);
    if (!win) {
      // Folgt der Fehler direkt auf eine Häufung (letzter Fehler < 60 s her), bleibt er im (längeren) Sammelfenster;
      // nach einer fehlerfreien Minute steht er wieder einzeln im Log.
      const inStorm = stormLenMs > 0 && t - lastErrorAt < ERROR_WINDOW_MS;
      win = { start: t, lenMs: inStorm ? stormLenMs : ERROR_WINDOW_MS, count: 0, logged: !inStorm, kinds: {}, codes: {} };
      if (!inStorm) { stormLenMs = 0; pushLog('sungrow_modbus_error', entry, 'warn'); }
    }
    win.count += 1;
    lastErrorAt = t;
    win.kinds[entry.kind] = (win.kinds[entry.kind] || 0) + 1;
    const cl = codeLabel(entry.kind, entry.code);
    win.codes[cl] = (win.codes[cl] || 0) + 1;
  }

  function trimReq(t) {
    const cut = t - REQ_WINDOW_MS;
    if (reqTimes.length > MAX_REQ_TIMES || (reqTimes.length && reqTimes[0] < cut)) {
      reqTimes = reqTimes.filter((x) => x >= cut);
    }
  }

  function record(ok, ms, errMsg, info = null) {
    const t = mono();
    closeIfDue(t);
    if (startedAt == null) startedAt = t;
    total += 1;
    reqTimes.push(t);
    trimReq(t);
    if (ok) {
      // Antwortzeit nur NACH der Startphase werten (der erste Verbindungsaufbau ist einmalig langsam) und als
      // gleitenden Median der letzten RESP_SAMPLES Anfragen — laufend, ohne einen eingefrorenen Startwert.
      if (t - startedAt >= STARTUP_MS && Number.isFinite(ms) && ms >= 0) {
        respSamples.push(ms);
        if (respSamples.length > RESP_SAMPLES) respSamples.shift();
      }
    } else {
      errTimes.push(t);
      const day = t - DAY_MS;
      while (errTimes.length && errTimes[0] < day) errTimes.shift();
      const { kind, code } = classifyModbusError(errMsg, info?.errCode);
      const message = sanitizeModbusMessage(errMsg).slice(0, 200);
      lastError = { message, kind, code, at: now() };
      const address = Number.isFinite(Number(info?.address)) ? Number(info.address) : null;
      reportError({
        wr, source, kind, code, fc: info?.fc ?? null,
        address, register: address == null ? null : wireToDoc(address),
        quantity: info?.quantity ?? null, value: info?.value ?? null, message,
      }, t);
    }
  }

  function wrap(transport) {
    if (!transport) return transport;
    // Alle Argumente durchreichen (E7: opts.atomic der Lese-Engine als zweites Argument); das Fehler-Protokoll (M22)
    // nimmt Funktion/Adresse/Menge/Wert aus dem ersten (der Anfrage).
    const call = async (method, ...args) => {
      const arg = args[0];
      const start = mono();
      try {
        const r = await transport[method](...args);
        record(true, mono() - start);
        return r;
      } catch (e) {
        record(false, mono() - start, e?.message || String(e), modbusRequestInfo(method, arg, e?.code ?? null));
        throw e;
      }
    };
    return {
      get type() { return transport.type; },
      // Zweites Argument (opts.atomic der Lese-Engine, E7) unverändert durchreichen.
      mbRequest: (...args) => call('mbRequest', ...args),
      mbWriteSingle: (arg) => call('mbWriteSingle', arg),
      mbWriteMultiple: (arg) => call('mbWriteMultiple', arg),
    };
  }

  function snapshot() {
    const t = mono();
    closeIfDue(t); // M22: abgelaufenes Sammelfenster auch ohne neue Anfrage zusammenfassen
    const cut = t - REQ_WINDOW_MS;
    const recent = reqTimes.filter((x) => x >= cut);
    // Rate über das tatsächliche Fenster (mind. 1 s, damit ein einzelner Takt nicht fälschlich hoch rechnet).
    const spanS = recent.length > 1 ? Math.max(1, (t - recent[0]) / 1000) : 1;
    const day = t - DAY_MS;
    const errors24h = errTimes.filter((x) => x >= day).length;
    return {
      totalRequests: total,
      requestsPerSec: recent.length ? Math.round((recent.length / spanS) * 10) / 10 : 0,
      responseMs: median(respSamples),
      errors24h,
      lastError: lastError ? { ...lastError } : null,
    };
  }

  // Gleitender Median der Antwortzeit (null in der Startphase/ohne Werte) — für den adaptiven Regeltakt.
  function responseMs() { return median(respSamples); }

  return { wrap, snapshot, record, responseMs };
}
