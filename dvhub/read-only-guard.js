// Lese-Modus: blockiert JEDEN schreibenden Zugriff auf die Anlage.
//
// Zweck: eine zweite DVhub-Instanz darf zu Test- und Messzwecken am selben
// Feldbus lauschen, ohne dass sie regeln kann. Der Anlass ist konkret — beim
// GX-Modbus-Incident (2026-07-24) lief ein vergessener Zweit-DVhub mit
// kopierter Produktivkonfiguration und wurde zum zweiten schreibenden
// ESS-Controller. Ein Konfigurationsschalter (`dvControl.enabled`) hat das
// nicht verhindert, weil er mitkopiert wurde.
//
// Deshalb sitzt diese Sperre bewusst NICHT in der Anwendungslogik, sondern
// unten im Transport: an der einzigen Stelle, durch die jedes Modbus-Telegramm
// muss, und an der einzigen MQTT-Schreibfunktion. Was hier abgelehnt wird,
// kann keine Regel-, Zeitplan- oder API-Schicht daran vorbeischleusen.
//
// Aktivierung ausschliesslich über die Umgebung (DVHUB_READ_ONLY=1) — bewusst
// nicht über die Konfiguration, damit eine kopierte config.json den Modus
// weder mitbringt noch aufhebt.

/** Modbus-Funktionscodes, die den Zustand der Anlage veraendern. */
export const MODBUS_WRITE_FUNCTION_CODES = new Set([
  5,   // 0x05 Write Single Coil
  6,   // 0x06 Write Single Register
  15,  // 0x0F Write Multiple Coils
  16,  // 0x10 Write Multiple Registers
  22,  // 0x16 Mask Write Register
  23   // 0x17 Read/Write Multiple Registers (schreibt mit)
]);

/** Byte-Position des Funktionscodes im Modbus/TCP-Rahmen (nach dem MBAP-Header). */
const MODBUS_FC_OFFSET = 7;

export function isReadOnlyMode(env = process.env) {
  return env.DVHUB_READ_ONLY === '1';
}

/**
 * Prueft einen fertig gebauten Modbus/TCP-Rahmen.
 * @returns {number|null} den Schreib-Funktionscode, wenn der Rahmen schreibt, sonst null.
 */
export function modbusWriteFunctionCode(reqBuf) {
  if (!reqBuf || typeof reqBuf.readUInt8 !== 'function') return null;
  if (reqBuf.length <= MODBUS_FC_OFFSET) return null;
  const fc = reqBuf.readUInt8(MODBUS_FC_OFFSET);
  return MODBUS_WRITE_FUNCTION_CODES.has(fc) ? fc : null;
}

export class ReadOnlyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyViolation';
    this.code = 'DVHUB_READ_ONLY';
  }
}

let blockedCount = 0;
export function blockedWriteCount() { return blockedCount; }
export function resetBlockedWriteCount() { blockedCount = 0; }

/** Zaehlt und protokolliert einen abgewehrten Schreibversuch. */
export function noteBlockedWrite(what) {
  blockedCount += 1;
  // Laut und ungefiltert: ein Schreibversuch im Lese-Modus ist immer ein
  // Befund, kein Rauschen — entweder ist die Instanz falsch konfiguriert
  // oder ein Pfad umgeht die erwartete Steuerungssperre.
  console.warn(`[READ-ONLY] Schreibzugriff blockiert: ${what} (bisher ${blockedCount})`);
}
