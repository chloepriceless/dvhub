// services/gate/delivery.js — Einordnung des Senken-Ausgangs in die vier Zustellwerte (VCL-Vertrag v6 §0.2, B.5, H-6).
//
// Reine Funktionen auf Fehler- und Ergebnisformen; nichts hier importiert einen Transport. Die Senken-Adapter, die
// dem Tor beim Anlegen übergeben werden, nutzen diese Einordner (oder eigene).

/**
 * Modbus-Ausnahme-Code → Zustellung (H-6, §0.2). Nach Code, nicht pauschal:
 * 01/02/03 = Anfrage abgelehnt, nichts geschrieben → `rejected`;
 * 04/05/06/08/0A/0B = Wirkung unbestimmt → `unknown` (06 „beschäftigt“ und 0A „Pfad nicht verfügbar“ bewusst
 * vorsichtig). Beleg: Ein Rücknahme-Write kann mit Ausnahme 4 scheitern, obwohl der Zielwert schon am Gerät steht
 * (schedule-eval.js, DV-Rücknahme liest nach der Ausnahme zurück).
 * Rust-Abweichung R-9: `modbus_sink.rs` macht heute JEDE Ausnahme zu `Rejected`.
 */
export const MODBUS_EXCEPTION_DELIVERY = Object.freeze({
  0x01: 'rejected', // Illegal Function
  0x02: 'rejected', // Illegal Data Address
  0x03: 'rejected', // Illegal Data Value
  0x04: 'unknown', // Server Device Failure
  0x05: 'unknown', // Acknowledge (angenommen, Ausführung läuft)
  0x06: 'unknown', // Server Device Busy
  0x08: 'unknown', // Memory Parity Error
  0x0a: 'unknown', // Gateway Path Unavailable
  0x0b: 'unknown', // Gateway Target Device Failed to Respond
});

// Fehlermeldungen von transport-modbus.js, bei denen der Rahmen den Draht nachweislich NIE erreicht hat.
// Abgeglichen am Code (Stand feat/vcl-tor @ 667f431d):
//   'modbus queue full'                       — abgelehnt vor dem Einreihen
//   'modbus write verworfen (Not-Halt …)'      — vor dem Draht verworfen (Sperrmarke A7)
//   'modbus write multiple: empty values'      — abgelehnt vor dem Bau des Rahmens
//   'modbus write multiple: too many values'   — dito
//   'modbus connect timeout'                  — Verbindung nie aufgebaut, gepufferte Bytes nie gesendet
// Wie Rust `ModbusError::not_sent()` (dvhub-io/src/modbus.rs: QueueFull, Fenced, BadWrite, ConnectTimeout, ReadOnly).
const MODBUS_NOT_SENT_MESSAGES = [
  /^modbus queue full$/,
  /^modbus write verworfen\b/,
  /^modbus write multiple: (empty|too many) values$/,
  /^modbus connect timeout$/,
];

// Socket-Fehler, die nur beim Verbindungsaufbau auftreten (nie gesendet). Alles andere nach dem Senden — Zeitüberschreitung,
// 'connection closed', ECONNRESET, 'invalid write ack', 'pool cleanup' — ist `unknown`: zählt als angekommen.
const CONNECT_ONLY_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Modbus-Ausnahme-Code aus einem Fehler lesen (`err.exceptionCode` oder Text „modbus exception N“), sonst null. */
export function modbusExceptionCode(err) {
  if (err == null) return null;
  const direct = Number(err.exceptionCode);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const m = /modbus exception (\d+)/.exec(String(err.message ?? err));
  return m ? Number(m[1]) : null;
}

function isReadOnlyViolation(err) {
  return err?.name === 'ReadOnlyViolation';
}

/**
 * Fehler einer Modbus-Senke → `{ delivery, exceptionCode?, detail? }`.
 * Unbekannte Ausnahme-Codes (07, 09, ≥ 0C) sind `unknown` — im Zweifel „womöglich angekommen“ (IOP-5).
 */
export function classifyModbusError(err) {
  const code = modbusExceptionCode(err);
  if (code != null) {
    return { delivery: MODBUS_EXCEPTION_DELIVERY[code] ?? 'unknown', exceptionCode: code };
  }
  if (isReadOnlyViolation(err)) return { delivery: 'notSent', detail: 'read_only' };
  const msg = String(err?.message ?? err ?? '');
  if (MODBUS_NOT_SENT_MESSAGES.some((re) => re.test(msg))) return { delivery: 'notSent' };
  if (CONNECT_ONLY_ERROR_CODES.has(err?.code)) return { delivery: 'notSent' };
  return { delivery: 'unknown' };
}

/**
 * Fehler einer beliebigen Senke (MQTT, HTTP) → Zustellung. Eine Senke kann den Wert selbst angeben
 * (`err.delivery`); sonst: Lese-Modus = `notSent`, alles andere `unknown`.
 * Bewusst kein Raten aus Meldungstexten anderer Transporte — wer `notSent` meint, sagt es per `err.delivery`.
 */
export function classifySinkError(err) {
  if (err && typeof err.delivery === 'string' && ['rejected', 'notSent', 'unknown'].includes(err.delivery)) {
    return { delivery: err.delivery };
  }
  if (isReadOnlyViolation(err)) return { delivery: 'notSent', detail: 'read_only' };
  return { delivery: 'unknown' };
}

/**
 * Erfolgreiche Rückgabe einer Senke → Zustellung. MQTT ohne Broker (`pushOnly`, transport-mqtt.js mqttWrite) und die
 * HTTP-Abholung senden nichts: der Wert liegt abholbereit und kann jederzeit wirken → `unknown` + `pickupPending`
 * (B.5 „HTTP-Abholung“).
 * MQTT mit Broker: `mqttWrite` übergibt mit QoS 0 an `client.publish()` und wartet auf keine Quittung — das ist keine
 * Quittung der Gegenstelle (§0.2, D.2) → `unknown` + `no_ack`, außer der Adapter belegt sie (`result.acked === true`,
 * Codex 7a183a18 P2).
 */
export function classifySinkResult(kind, result) {
  if (kind === 'pickup') return { delivery: 'unknown', detail: 'pickupPending' };
  if (kind === 'mqtt') {
    if (result && result.pushOnly === true) return { delivery: 'unknown', detail: 'pickupPending' };
    if (result && result.acked === true) return { delivery: 'acked' };
    return { delivery: 'unknown', detail: 'no_ack' };
  }
  return { delivery: 'acked' };
}

/** Voreinstellung der Fehler-Einordnung je Senkenart. */
export function defaultErrorClassifier(kind) {
  return kind === 'modbus' ? classifyModbusError : classifySinkError;
}
