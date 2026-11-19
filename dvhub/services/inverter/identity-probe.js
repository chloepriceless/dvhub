// E10 (Lese-Engine, 19.11.2026): Kennungsprobe eines Herstellerprofils — antwortet das Gerät, für das die Registerkarte
// gilt? Nur Lesen und Anzeigen: das Ergebnis steht in state.victron.identityProbe, im Status (Hinweisleiste) und im
// Log; bei „passt nicht“ blendet der Poller die Werte aus, die das Profil unter `hideOnMismatch` nennt (Werte, deren
// Registerlage oder Kodierung von Gerät/Fassung abhängt) — leer statt falsch. KEINE Wirkung auf Writes oder das
// Schreibtor: kein Sperrzustand, kein identify.requiredForWrites (das bleibt Sache des Schreibtor-Strangs).
//
// Profil (unter `victron`, wie requestPacing — der Block gehört zur Anlagen-Verbindung):
//   "identityProbe": {
//     "checks": [ { "label": "E3/DC-Kennung", "fc": 3, "address": 40000, "equals": [58332] } ],
//     "hideOnMismatch": ["meter", "pvPowerW", "batteryPowerW", "soc"],
//     "everyMs": 600000
//   }
// Je Prüfung genau eine Bedingung: `equals` (Liste erlaubter Werte), `range` ([min, max], einschließlich) oder `prefix`
// (Text am Anfang, mit `quantity` Registern, 2 Zeichen je Register, High-Byte zuerst). Zahlen dekodiert derselbe
// Decoder wie die Lesepunkte (u16 Standard, `signed`, `readType` uint32/int32, `wordOrder`).

import { decodePointRegs } from './point-read.js';

export const IDENTITY_PROBE_DEFAULT_EVERY_MS = 600_000;
export const IDENTITY_PROBE_RETRY_MS = 60_000;
const MIN_EVERY_MS = 60_000;
const MAX_EVERY_MS = 86_400_000;
const MAX_CHECKS = 8;
const MAX_STRING_REGISTERS = 64;

const isAddress = (a) => typeof a === 'number' && Number.isInteger(a) && a >= 0 && a <= 0xffff;
const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

function normalizeCheck(raw, i) {
  const where = `checks[${i}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} muss ein Objekt sein`);
  if (!isAddress(raw.address)) throw new Error(`${where}.address ${raw.address} ist keine Registeradresse`);
  if (raw.fc !== 3 && raw.fc !== 4) throw new Error(`${where}.fc muss 3 oder 4 sein (ist ${JSON.stringify(raw.fc)})`);
  if (raw.unitId !== undefined && !(Number.isInteger(raw.unitId) && raw.unitId >= 0 && raw.unitId <= 255)) {
    throw new Error(`${where}.unitId ${raw.unitId} ist keine Unit-ID`);
  }
  const kinds = ['equals', 'range', 'prefix'].filter((k) => raw[k] !== undefined);
  if (kinds.length !== 1) throw new Error(`${where} braucht genau eine Bedingung: equals, range oder prefix`);
  const out = { fc: raw.fc, address: raw.address, label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : `Register ${raw.address}` };
  if (raw.unitId !== undefined) out.unitId = raw.unitId;
  if (raw.prefix !== undefined) {
    if (typeof raw.prefix !== 'string' || !raw.prefix) throw new Error(`${where}.prefix muss ein nicht leerer Text sein`);
    if (!(Number.isInteger(raw.quantity) && raw.quantity >= 1 && raw.quantity <= MAX_STRING_REGISTERS)) {
      throw new Error(`${where}.quantity (Register des Texts, 1…${MAX_STRING_REGISTERS}) fehlt oder ist ungültig`);
    }
    if (raw.prefix.length > raw.quantity * 2) throw new Error(`${where}.prefix ist länger als ${raw.quantity} Register`);
    return { ...out, kind: 'prefix', prefix: raw.prefix, quantity: raw.quantity };
  }
  const readType = raw.readType === undefined ? '' : String(raw.readType).toLowerCase();
  if (readType && readType !== 'uint32' && readType !== 'int32') throw new Error(`${where}.readType ${raw.readType}: nur uint32 oder int32 (16 bit ohne readType)`);
  const quantity = readType ? 2 : 1;
  if (raw.quantity !== undefined && raw.quantity !== quantity) throw new Error(`${where}.quantity ${raw.quantity} passt nicht zum Typ (${quantity})`);
  const decode = { quantity, scale: 1, offset: 0 };
  if (readType) decode.readType = readType;
  if (raw.wordOrder !== undefined) decode.wordOrder = raw.wordOrder;
  if (raw.signed === true) decode.signed = true;
  if (raw.equals !== undefined) {
    if (!Array.isArray(raw.equals) || !raw.equals.length || !raw.equals.every(isFiniteNumber)) {
      throw new Error(`${where}.equals muss eine nicht leere Liste von Zahlen sein`);
    }
    return { ...out, kind: 'equals', equals: [...raw.equals], quantity, decode };
  }
  const r = raw.range;
  if (!Array.isArray(r) || r.length !== 2 || !r.every(isFiniteNumber) || r[0] > r[1]) {
    throw new Error(`${where}.range muss [min, max] mit min ≤ max sein`);
  }
  return { ...out, kind: 'range', range: [r[0], r[1]], quantity, decode };
}

/**
 * Prüft den Profilblock `victron.identityProbe` und liefert die normalisierte Probe; wirft bei Profilfehlern.
 * @returns {{ checks: object[], hideOnMismatch: string[], everyMs: number }}
 */
export function normalizeIdentityProbe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('identityProbe muss ein Objekt sein');
  if (!Array.isArray(raw.checks) || !raw.checks.length) throw new Error('identityProbe.checks braucht mindestens eine Prüfung');
  if (raw.checks.length > MAX_CHECKS) throw new Error(`identityProbe.checks: höchstens ${MAX_CHECKS} Prüfungen`);
  const checks = raw.checks.map(normalizeCheck);
  const hide = raw.hideOnMismatch === undefined ? [] : raw.hideOnMismatch;
  if (!Array.isArray(hide) || !hide.every((n) => typeof n === 'string' && n.trim())) {
    throw new Error('identityProbe.hideOnMismatch muss eine Liste von Punktnamen (oder "meter") sein');
  }
  let everyMs = IDENTITY_PROBE_DEFAULT_EVERY_MS;
  if (raw.everyMs !== undefined) {
    if (!isFiniteNumber(raw.everyMs) || raw.everyMs < MIN_EVERY_MS || raw.everyMs > MAX_EVERY_MS) {
      throw new Error(`identityProbe.everyMs muss zwischen ${MIN_EVERY_MS} und ${MAX_EVERY_MS} liegen`);
    }
    everyMs = Math.round(raw.everyMs);
  }
  return { checks, hideOnMismatch: [...new Set(hide.map((n) => n.trim()))], everyMs };
}

// Registertext: je Register High-Byte, dann Low-Byte; endet am ersten NUL, Leerzeichen am Ende zählen nicht.
export function decodeRegisterString(regs) {
  const bytes = [];
  for (const r of regs) {
    const w = Number(r) & 0xffff;
    bytes.push(w >> 8, w & 0xff);
  }
  const end = bytes.indexOf(0);
  return Buffer.from(end >= 0 ? bytes.slice(0, end) : bytes).toString('latin1').replace(/\s+$/, '');
}

const hex = (n) => (Number.isInteger(n) && n >= 0 ? ` (0x${n.toString(16).toUpperCase().padStart(4, '0')})` : '');
const showValue = (v) => (typeof v === 'string' ? `„${v}“` : `${v}${hex(v)}`);
function expectedText(c) {
  if (c.kind === 'prefix') return `beginnt mit „${c.prefix}“`;
  if (c.kind === 'range') return `zwischen ${c.range[0]} und ${c.range[1]}`;
  return c.equals.map((v) => `${v}${hex(v)}`).join(' oder ');
}
function matches(c, value) {
  if (c.kind === 'prefix') return typeof value === 'string' && value.startsWith(c.prefix);
  if (value == null) return false;
  if (c.kind === 'range') return value >= c.range[0] && value <= c.range[1];
  return c.equals.includes(value);
}

// Anzeigenamen der ausgeblendeten Werte (Hinweisleiste, Log).
const VALUE_NAMES = {
  meter: 'Netz', pvPowerW: 'PV', batteryPowerW: 'Akku', soc: 'Ladestand', selfConsumptionW: 'Hauslast',
  deviceMaxChargeW: 'Ladegrenze', deviceMaxDischargeW: 'Entladegrenze', deviceMaxChargeA: 'Ladestromgrenze',
  deviceMaxDischargeA: 'Entladestromgrenze',
};
export const identityValueName = (name) => VALUE_NAMES[name] || name;

/**
 * Liest alle Prüfungen (je eine Anfrage, nacheinander) und bewertet sie.
 *   ok          jede Prüfung gelesen und erfüllt
 *   mismatch    mindestens eine Prüfung gelesen und NICHT erfüllt — `hidden` nennt die auszublendenden Werte
 *   unreadable  keine verletzt, aber mindestens eine nicht lesbar (Zeitüberschreitung, Modbus-Ausnahme)
 * @param {{ checks: object[], hideOnMismatch: string[] }} probe - aus normalizeIdentityProbe
 * @param {(req: {fc, address, quantity, unitId?}) => Promise<number[]>} read
 */
export async function runIdentityProbe(probe, read) {
  const results = [];
  for (const c of probe.checks) {
    const entry = { label: c.label, fc: c.fc, address: c.address, expected: expectedText(c), value: null, ok: null };
    try {
      const regs = await read({ fc: c.fc, address: c.address, quantity: c.quantity, ...(c.unitId !== undefined ? { unitId: c.unitId } : {}) });
      if (!Array.isArray(regs) || regs.length < c.quantity) throw new Error(`unvollständige Antwort (${Array.isArray(regs) ? regs.length : 0} von ${c.quantity} Registern)`);
      const words = regs.slice(0, c.quantity);
      entry.value = c.kind === 'prefix' ? decodeRegisterString(words) : decodePointRegs(words, c.decode);
      entry.ok = matches(c, entry.value);
    } catch (e) {
      entry.error = String(e?.message || e);
    }
    results.push(entry);
  }
  const failed = results.filter((r) => r.ok === false);
  const unreadable = results.filter((r) => r.ok === null);
  if (failed.length) {
    const hidden = probe.hideOnMismatch;
    const why = failed.map((r) => `${r.label}: Register ${r.address} = ${showValue(r.value)}, erwartet ${r.expected}`).join('; ');
    const what = hidden.length
      ? `nicht angezeigt: ${hidden.map(identityValueName).join(', ')}`
      : 'Werte werden ungeprüft angezeigt';
    return {
      status: 'mismatch', hidden: [...hidden], checks: results,
      text: `Kennungsprobe passt nicht (${why}) — antwortet das richtige Gerät in der richtigen Einstellung? ${what}.`,
    };
  }
  if (unreadable.length) {
    const why = unreadable.map((r) => `${r.label}: ${r.error}`).join('; ');
    return { status: 'unreadable', hidden: [], checks: results, text: `Kennungsprobe nicht lesbar (${why}) — Werte werden ungeprüft angezeigt.` };
  }
  return { status: 'ok', hidden: [], checks: results, text: `Kennungsprobe bestanden (${results.map((r) => r.label).join(', ')}).` };
}
