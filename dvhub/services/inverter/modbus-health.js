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

const REQ_WINDOW_MS = 10_000;   // Fenster für „Anfragen/s"
const DAY_MS = 86_400_000;      // 24 h für die Fehlerzählung
const MAX_REQ_TIMES = 2048;     // Kappung des Zeitstempel-Puffers (Speicher)

// Fehlerart grob einordnen: Modbus-Ausnahme (illegale Adresse/Daten, Geräteseite) vs. Timeout/Verbindung.
function classify(message) {
  const m = String(message || '');
  if (/modbus exception \d/i.test(m)) return 'exception';
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|EPIPE|socket|not connected/i.test(m)) return 'timeout';
  return 'other';
}

export function createModbusHealth(now = Date.now) {
  let total = 0;
  let reqTimes = [];        // Zeitstempel der letzten Anfragen (für Anfragen/s)
  const errTimes = [];      // Zeitstempel der Fehler (für die 24-h-Zählung)
  let lastError = null;     // { message, kind, at }
  let responseMs = null;    // gleitender Mittelwert (nur erfolgreiche Anfragen)

  function trimReq(t) {
    const cut = t - REQ_WINDOW_MS;
    if (reqTimes.length > MAX_REQ_TIMES || (reqTimes.length && reqTimes[0] < cut)) {
      reqTimes = reqTimes.filter((x) => x >= cut);
    }
  }

  function record(ok, ms, errMsg) {
    const t = now();
    total += 1;
    reqTimes.push(t);
    trimReq(t);
    if (ok) {
      if (Number.isFinite(ms) && ms >= 0) responseMs = responseMs == null ? ms : Math.round(0.7 * responseMs + 0.3 * ms);
    } else {
      errTimes.push(t);
      const day = t - DAY_MS;
      while (errTimes.length && errTimes[0] < day) errTimes.shift();
      lastError = { message: String(errMsg || '').slice(0, 200), kind: classify(errMsg), at: t };
    }
  }

  function wrap(transport) {
    if (!transport) return transport;
    const call = async (method, arg) => {
      const start = now();
      try {
        const r = await transport[method](arg);
        record(true, now() - start);
        return r;
      } catch (e) {
        record(false, now() - start, e?.message || String(e));
        throw e;
      }
    };
    return {
      get type() { return transport.type; },
      mbRequest: (arg) => call('mbRequest', arg),
      mbWriteSingle: (arg) => call('mbWriteSingle', arg),
      mbWriteMultiple: (arg) => call('mbWriteMultiple', arg),
    };
  }

  function snapshot() {
    const t = now();
    const cut = t - REQ_WINDOW_MS;
    const recent = reqTimes.filter((x) => x >= cut);
    // Rate über das tatsächliche Fenster (mind. 1 s, damit ein einzelner Takt nicht fälschlich hoch rechnet).
    const spanS = recent.length > 1 ? Math.max(1, (t - recent[0]) / 1000) : 1;
    const day = t - DAY_MS;
    const errors24h = errTimes.filter((x) => x >= day).length;
    return {
      totalRequests: total,
      requestsPerSec: recent.length ? Math.round((recent.length / spanS) * 10) / 10 : 0,
      responseMs,
      errors24h,
      lastError: lastError ? { ...lastError } : null,
    };
  }

  return { wrap, snapshot, record };
}
