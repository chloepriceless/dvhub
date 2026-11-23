// services/inverter/sungrow.js — Sungrow Hybrid (SH-RS/SH-RT/SH-T) über Modbus TCP (Beta, T-0422).
//
// Quelle der Register: Sungrow „Communication Protocol of Residential Hybrid Inverter“ V1.1.9 (2025-06-20),
// gegengeprüft mit dem evcc-Template sungrow-hybrid (MIT) und mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant
// (MIT) — nur Adressen, Typen, Vorzeichen; kein Code übernommen. Konventionen der Sungrow-Doku:
//   • Auf den Draht geht „Doku-Adresse − 1“ (Kap. 1.2, 4.1: Register 5000 wird als 0x1387 = 4999 gelesen).
//   • U32/S32: Wortreihenfolge little-endian (niederwertiges Wort zuerst, Beispiel 4.2), Bytes je Wort big-endian.
//   • Nicht vorhandene Register: U16 0xFFFF, U32 0xFFFFFFFF, S16 0x7FFF, S32 0x7FFFFFFF.
//   • Lesend: FC 4 (Tabelle 3, RO). Steuerung: FC 3/6/16 auf Tabelle 4 (RW, Holding).
//   • Über WiNet-S/S2/Logger sind RW-Register nicht für häufiges zyklisches Lesen/Schreiben gedacht (Note 6) —
//     DVhub liest Holding-Register nur vor/nach eigenen Writes und schreibt nur bei Änderungen.
//
// Hier: Gerätetabelle, Erkennung (Typcode/Seriennummer/BDC-Nennleistung), Tageswerte und der Aktuator, der
// DVhubs Netz-Sollwert (gridSetpointW, + = Bezug) über den EMS-Modus nachbildet:
//   Sollwert nahe 0  → Self-consumption (13050 = 0, 13051 = 0xCC) — der Wechselrichter regelt selbst auf ~0 W.
//   sonst            → Forced mode (13050 = 2) mit Laden 0xAA / Entladen 0xBB und Leistung 13052 (W),
//                      nachgeführt aus Netz- und Akku-Messung (Regler wie docs/DEYE-NODERED-BRIDGE.md Kap. 6).

import fs from 'node:fs';

import { meterImport } from '../import-limit/core.js';
import { atomicWriteControlState } from '../../control-state-io.js';
import { ReadOnlyViolation } from '../../read-only-guard.js';
import { GateBlockedError } from '../gate/index.js';
import { c2AllowsRelease, createLegacyGate, inverterReleaseState, modbusLegacySink, SUNGROW_GATE_DEVICES } from '../gate/legacy.js';
import { createModbusHealth, classifyModbusError, modbusRequestInfo } from './modbus-health.js';
import { releaseBackoffNextAt } from '../release-backoff.js';
import { bootStamp } from '../mono-clock.js';

/** Doku-Adresse → Draht-Adresse. */
export const wire = (docAddress) => Number(docAddress) - 1;

// Appendix 1 „Adaptive Inverter Models“ (V1.1.9) — Typcode (Register 5000) → Modell.
const MODEL_ROWS = [
  ['SH3.0-6.0RS', 1, [[0xd17, 'SH3.0RS'], [0xd0d, 'SH3.6RS'], [0xd18, 'SH4.0RS'], [0xd0f, 'SH5.0RS'], [0xd10, 'SH6.0RS']]],
  ['SH8.0-10RS', 1, [[0xd1a, 'SH8.0RS'], [0xd1b, 'SH10RS']]],
  ['SH5.0-10RT', 3, [
    [0xe00, 'SH5.0RT'], [0xe01, 'SH6.0RT'], [0xe02, 'SH8.0RT'], [0xe03, 'SH10RT'],
    [0xe10, 'SH5.0RT-20'], [0xe11, 'SH6.0RT-20'], [0xe12, 'SH8.0RT-20'], [0xe13, 'SH10RT-20'],
    [0xe0c, 'SH5.0RT-V112'], [0xe0d, 'SH6.0RT-V112'], [0xe0e, 'SH8.0RT-V112'], [0xe0f, 'SH10RT-V112'],
    [0xe08, 'SH5.0RT-V122'], [0xe09, 'SH6.0RT-V122'], [0xe0a, 'SH8.0RT-V122'], [0xe0b, 'SH10RT-V122']
  ]],
  ['SH5-25T', 3, [
    [0xe20, 'SH5T'], [0xe21, 'SH6T'], [0xe22, 'SH8T'], [0xe23, 'SH10T'], [0xe24, 'SH12T'],
    [0xe25, 'SH15T'], [0xe26, 'SH20T'], [0xe28, 'SH25T']
  ]],
  ['MG5-6RL', 1, [[0xd27, 'MG5RL'], [0xd28, 'MG6RL']]]
];

/** Typcode → { model, series, phases } für alle Hybrid-Geräte der Sungrow-Doku. */
export const SUNGROW_HYBRID_MODELS = new Map(
  MODEL_ROWS.flatMap(([series, phases, rows]) => rows.map(([code, model]) => [code, { model, series, phases }]))
);

export const EMS_MODE = Object.freeze({ SELF: 0, FORCED: 2, EXTERNAL: 3, VPP: 4 });
export const EMS_CMD = Object.freeze({ CHARGE: 0xaa, DISCHARGE: 0xbb, STOP: 0xcc });

// Holding-Register der Energieverwaltung (Tabelle 4/9): 13050 Modus, 13051 Befehl, 13052 Leistung (U16, W).
export const EMS_BLOCK_ADDRESS = wire(13050);
const EMS_MODE_ADDR = wire(13050);
const EMS_CMD_ADDR = wire(13051);
const EMS_POWER_ADDR = wire(13052);
// Doku 13080 „External EMS heartbeat“ (U16, 0–1000 s, Standard 20 s): Wert = Frist; ihn innerhalb der Frist
// erneut schreiben ist der Herzschlag. Bleibt er aus, kehrt der Wechselrichter in Self-consumption zurück.
export const HEARTBEAT_ADDR = wire(13080);

// Draht-Adresse → Punkt im Schreibtor (VCL-Vertrag v6 C.2 `writes`). Nur diese vier Register schreibt DVhub am
// Sungrow; für alles andere (u. a. Min-/Max-SoC 13059/13058, H-8) hat das Tor keinen Punkt und sperrt.
const GATE_POINT = Object.freeze({ [EMS_MODE_ADDR]: 'emsMode', [EMS_CMD_ADDR]: 'emsCmd', [EMS_POWER_ADDR]: 'emsPower', [HEARTBEAT_ADDR]: 'heartbeat' });

/** Betreiber-Einstellung cfg.sungrow: Steuermodus und Herzschlag-Frist (20–300 s, Standard 30 s). */
export function resolveSungrowControl(cfg) {
  const o = cfg?.sungrow && typeof cfg.sungrow === 'object' ? cfg.sungrow : {};
  // Standard-Steuermodus (Christin 14.11.): bei ZWEI WR Forced-Split (Dauer-Modus 2 mit Aufteilung auf beide WR —
  // der Slave liefert in External EMS 0 W, Feld #6/#7), bei EINEM WR External EMS (Modus 3 mit geräteeigenem
  // Rückfall, sicherer). Eine ausdrückliche Einstellung sungrow.controlMode gewinnt immer: 'forced' = Forced-Split,
  // 'external' = External EMS (bei zwei WR die master-only-Option, sicherer Rückfall, aber nur Master-Akku).
  const twoWr = typeof o.secondInverter?.host === 'string' && o.secondInverter.host.trim().length > 0;
  const mode = o.controlMode === 'forced' ? 'forced'
    : (o.controlMode === 'external' ? 'external' : (twoWr ? 'forced' : 'external'));
  const t = Math.round(Number(o.heartbeatTimeoutS));
  const heartbeatTimeoutS = Number.isFinite(t) ? Math.min(300, Math.max(20, t)) : 30;
  // Herzschlag 13080 NACH dem Moduswechsel schreiben (Standard an): der WR setzt 13080 beim Eintritt in External
  // EMS selbst (am Gerät 600 s beobachtet) und übernimmt unseren Wert erst danach — Doku V1.1.11: „set mode 3,
  // then deliver the heartbeat value". false = alte Reihenfolge (vor dem Moduswechsel), nur zur Diagnose.
  const heartbeatAfterMode = o.heartbeatAfterMode !== false;
  // Schreibfunktion für 13080: fest 6 (FC 06 Write Single) oder 16 (FC 16 Write Multiple), sonst null = Auto
  // (erst FC 06, bei Abweichung einmal FC 16; die funktionierende Variante wird je Verbindung gemerkt).
  const fc = Number(o.heartbeatWriteFc);
  const heartbeatWriteFc = fc === 6 || fc === 16 ? fc : null;
  // Opt-in letzter Ausweg (nur auf Christins Entscheidung): Übernimmt der WR KEINEN geschriebenen Herzschlag,
  // mit dem geräteeigenen Wert fahren, solange er ≤ acceptDeviceHeartbeatS ist (Rückfall dann bis zu diesem
  // Wert statt 30 s). 0/leer = aus (sicher scheitern).
  const a = Math.round(Number(o.acceptDeviceHeartbeatS));
  const acceptDeviceHeartbeatS = Number.isFinite(a) && a > 0 ? Math.min(600, a) : 0;
  // Lebenszeichen-Register (Punkt 3): solange DVhub External EMS fährt, wird dieses Register regelmäßig
  // beschrieben, damit der WR nicht von selbst in Self-consumption zurückfällt. '13080' (Herzschlag, Standard),
  // '13052' (Leistung neu schreiben — auch wenn 13080 nicht beschreibbar ist) oder 'both'.
  const kr = String(o.keepaliveRegister || '').trim();
  const keepaliveRegister = kr === '13052' || kr === 'both' ? kr : '13080';
  return { mode, modeValue: mode === 'forced' ? EMS_MODE.FORCED : EMS_MODE.EXTERNAL, heartbeatTimeoutS, heartbeatAfterMode, heartbeatWriteFc, acceptDeviceHeartbeatS, keepaliveRegister };
}

// Notladungs-Puffer über Sungrows Geräte-Untergrenze (M1, Christin 16.11.): kundeneinstellbar je Anlage. Der effektive
// Entlade-Boden ist max(hardFloorSocPct, geräteMinReal + Puffer). Geklemmt auf [0, 50]. M24 (Christin 19.11.): Standard
// 0 — der Puffer hält nur beim Entladen; im Stillstand sinkt der SoC trotzdem bis zur Geräte-Untergrenze (Eigenverbrauch
// des WR), dort lädt der WR selbst nach. Eine Erhaltungsladung baut DVhub bewusst nicht.
export const SUNGROW_DEFAULT_SOC_FLOOR_BUFFER_PCT = 0;
export function sungrowSocFloorBufferPct(cfg) {
  const v = Number(cfg?.sungrow?.socFloorBufferPct);
  return Number.isFinite(v) && v >= 0 ? Math.min(50, v) : SUNGROW_DEFAULT_SOC_FLOOR_BUFFER_PCT;
}

// Zwei WR, Frist „Master allein" (Christin 21.11.2026, A7 Option b): Ist ein nicht geführter Slave nicht auf Stopp
// bestätigt (nicht erreichbar, Rücklesung scheitert), wartet der Eintritt des Masters bzw. tritt der Master zurück —
// höchstens so lange. Danach regelt der Master allein; ein alter Slave-Befehl kann dann mitlaufen. Einstellung
// cfg.sungrow.secondInverter.slaveUnconfirmedMasterAloneAfterMin in Minuten: Standard 30, 0 = sofort, höchstens 1440.
// Leer/ungültig/negativ → Standard (leer ist NICHT 0 = sofort).
export const SUNGROW_DEFAULT_MASTER_ALONE_AFTER_MIN = 30;
export const SUNGROW_MAX_MASTER_ALONE_AFTER_MIN = 1440;
export function sungrowMasterAloneAfterMs(cfg) {
  const raw = cfg?.sungrow?.secondInverter?.slaveUnconfirmedMasterAloneAfterMin;
  const given = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '');
  const v = given ? Number(raw) : NaN;
  const min = Number.isFinite(v) && v >= 0 ? Math.min(SUNGROW_MAX_MASTER_ALONE_AFTER_MIN, v) : SUNGROW_DEFAULT_MASTER_ALONE_AFTER_MIN;
  return Math.round(min * 60000);
}
// Zustand der Frist (nur am Master). Monotone Zeit (monoNow): since = erstes „Slave unbestätigt" dieser Lage, lastAt =
// letztes, aloneSince = seit wann der Master allein regelt, logAt = letzte Warnung. Wanduhr nur für Anzeige/Protokoll:
// sinceWall, aloneSinceWall, at = Takt des letzten „allein" (Abgleich mit decision.at). slaveKey = Slave-Verbindung,
// active = der Master regelt allein, error = letzter Grund.
function masterAloneIdle() {
  return { since: null, sinceWall: null, lastAt: null, slaveKey: null, active: false, aloneSince: null, aloneSinceWall: null, at: null, logAt: null, error: null };
}

const U16_NA = 0xffff;
const S16_NA = 0x7fff;

/**
 * UTF-8-Zeichenkette aus Registern (High-Byte zuerst), endet am ersten 0x00 (Doku Kap. 1.1/4.7).
 * @param {number[]} regs
 */
export function decodeSungrowString(regs) {
  const bytes = [];
  for (const w of Array.isArray(regs) ? regs : []) {
    bytes.push((Number(w) >> 8) & 0xff, Number(w) & 0xff);
  }
  const end = bytes.indexOf(0);
  const text = Buffer.from(end >= 0 ? bytes.slice(0, end) : bytes).toString('utf8').trim();
  return text || null;
}

const u16 = (w) => {
  const v = Number(w) & 0xffff;
  return v === U16_NA ? null : v;
};
const s16 = (w) => {
  const v = Number(w) & 0xffff;
  if (v === S16_NA) return null;
  return v >= 0x8000 ? v - 0x10000 : v;
};
const tenth = (v) => (v == null ? null : Math.round(v) / 10);

/**
 * Tageswerte und Zustand aus dem Block Doku 13000–13045 (46 Register ab Draht 12999, FC 4).
 * @param {number[]} regs  46 Registerworte
 */
export function decodeSungrowInfoBlock(regs) {
  if (!Array.isArray(regs) || regs.length < 46) return null;
  const at = (docAddr) => regs[docAddr - 13000];
  const runningState = u16(at(13000));
  return {
    runningState,
    runningStateText: runningStateText(runningState),
    powerFlow: u16(at(13001)),
    dailyPvKwh: tenth(u16(at(13002))),
    dailyDirectConsumptionKwh: tenth(u16(at(13017))),
    sohPct: tenth(u16(at(13024))),
    batteryTempC: tenth(s16(at(13025))),
    dailyDischargeKwh: tenth(u16(at(13026))),
    dailyImportKwh: tenth(u16(at(13036))),
    dailyChargeKwh: tenth(u16(at(13040))),
    dailyExportKwh: tenth(u16(at(13045)))
  };
}

// Appendix 2 — Running State (die für den Betrieb wichtigen Werte).
const RUNNING_STATES = new Map([
  [0x0000, 'Betrieb (Netz)'], [0x0040, 'Betrieb (Netz)'], [0x0400, 'Wartungsbetrieb Akku'],
  [0x0800, 'Zwangsbetrieb (Compulsory)'], [0x1000, 'Inselbetrieb'], [0x4000, 'Externes EMS'],
  [0x4001, 'Notladung Akku'], [0x8000, 'Stopp'], [0x0001, 'Stopp'], [0x1300, 'Stopp (Taste/App)'],
  [0x0002, 'Stopp (Taste/App)'], [0x1500, 'Not-Aus'], [0x0004, 'Not-Aus'], [0x1400, 'Standby'],
  [0x0008, 'Standby'], [0x1200, 'Start-Standby'], [0x0010, 'Start-Standby'], [0x1600, 'Startet'],
  [0x0020, 'Startet'], [0x9100, 'Betrieb mit Warnung'], [0x8100, 'Leistung reduziert'],
  [0x0080, 'Leistung reduziert'], [0x8200, 'Fernvorgabe (Dispatch)'], [0x5500, 'Fehler'], [0x0100, 'Fehler']
]);
export function runningStateText(code) {
  if (code == null) return null;
  return RUNNING_STATES.get(code) || `Zustand 0x${code.toString(16).padStart(4, '0')}`;
}

// Notladung (Appendix 2, runningState 0x4001 = 16385): der WR lädt unter seinem Min-SoC eigenmächtig aus dem Netz,
// UNABHÄNGIG von Modus/Befehl, bis sein Min-SoC (13059) erreicht ist (Feld 15.11., Aufgabe 2). Ein WR in diesem
// Zustand ist NICHT über den EMS steuerbar — DVhub nimmt ihn aus dem Split und rechnet seine Ladeleistung dem
// Regler nicht zu.
export const RUNNING_STATE_EMERGENCY_CHARGE = 0x4001;
export function isSungrowEmergencyCharge(runningState) {
  return (Number(runningState) & 0xffff) === RUNNING_STATE_EMERGENCY_CHARGE;
}

// Fensterrelativer SoC → echter SoC (M1, Feld 16.11., kritisch): Sungrow meldet den SoC (Reg 13022/Doku 13023)
// RELATIV zum Min…Max-SoC-Fenster des WR (13059…13058), NICHT absolut. Echter SoC = min + gemeldet × (max − min)/100.
// Feld (Min 10 / Max 100): real = 10 + 0,9 × gemeldet; gemeldet 0 % = real 10 % = die geräteeigene Untergrenze (der
// WR gibt darunter nichts mehr frei). An diesen WR gibt es KEIN Register mit dem echten SoC (gescannt). DVhub rechnet
// intern auf EINER Skala — REAL — weil die Grenzen (13059/13058, hardFloorSocPct) real sind. Ohne gültiges Fenster
// (min/max fehlen oder max ≤ min) bleibt der gemeldete Wert stehen (keine Umrechnung möglich). Ergebnis [0,100].
export function sungrowRealSocPct(reportedPct, minSocPctDevice, maxSocPctDevice) {
  const fin = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  if (!fin(reportedPct)) return null;
  const r = Number(reportedPct);
  if (!fin(minSocPctDevice) || !fin(maxSocPctDevice)) return Math.min(100, Math.max(0, r));
  const min = Number(minSocPctDevice); const max = Number(maxSocPctDevice);
  if (!(max > min)) return Math.min(100, Math.max(0, r));
  return Math.min(100, Math.max(0, min + (r * (max - min)) / 100));
}

// Wirksame Entlade-Grenze eines WR (Aufgabe 1 + M1): der höhere aus hartem Boden und dem geräteeigenen Min-SoC
// (13059, real) PLUS Notladungs-Puffer. Unter DIESE Grenze (real %) darf DVhub den WR nicht entladen. Der Puffer
// (Christin 16.11., kundeneinstellbar, Standard 0 seit M24) hält DVhub knapp ÜBER Sungrows eigener Untergrenze (real =
// 13059), damit der WR nicht selbst in die Notladung (runningState 0x4001) fällt, die im Feld bei gemeldet 0 %
// (= real = Gerätemin) kam. Fehlt der Gerätewert, zählt nur der harte Boden (ohne Puffer — kein bekanntes Gerätemin).
export function sungrowDischargeFloorPct(hardFloorPct, deviceMinSocPct, bufferPct = 0) {
  const fin = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const buf = fin(bufferPct) ? Math.max(0, Number(bufferPct)) : 0;
  const devFloor = fin(deviceMinSocPct) ? Number(deviceMinSocPct) + buf : null;
  // Erst nullish/'' aussortieren, DANN nach Zahl — sonst würde Number(null)=0 als gültige Grenze zählen.
  const vals = [hardFloorPct, devFloor].filter((v) => v != null && v !== '' && Number.isFinite(Number(v))).map(Number);
  return vals.length ? Math.max(...vals) : 0;
}
// Wirksame Lade-Grenze eines WR (Aufgabe 1): der kleinere aus konfigurierter Max-SoC und dem geräteeigenen
// Max-SoC (13058) — über DIESE Grenze darf DVhub den WR nicht laden.
export function sungrowChargeCeilPct(maxSocPct, deviceMaxSocPct) {
  const vals = [maxSocPct, deviceMaxSocPct].filter((v) => v != null && v !== '' && Number.isFinite(Number(v))).map(Number);
  return vals.length ? Math.min(...vals) : 100;
}

// Wirksame Lade-/Entladeleistung eines WR (Aufgabe 1/4): die kleinste aus Feldeinstellung (Übersteuerung),
// gelesener Gerätegrenze (33047 Laden / 33048 Entladen) und BDC-Nennleistung. GLEICHE Regel für die Regelgrenze
// (stepSplit) UND die EOS-Vorgabe (planning). Das Feld ist nur Übersteuerung: leer → Gerätewert; gesetzt → der
// strengere (min). Fehlt jede Angabe, 0.
export function sungrowEffectivePowerW(fieldW, deviceW, bdcW) {
  const cands = [fieldW, deviceW, bdcW].filter((v) => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0).map(Number);
  return cands.length ? Math.min(...cands) : 0;
}

/**
 * Gerät erkennen. `read({fc, address, quantity})` liefert Registerworte (Transport-agnostisch).
 * Erkannt = Typcode steht in der Hybrid-Tabelle. Seriennummer und BDC-Nennleistung sind Zusatz:
 * fehlen sie, bleibt das Gerät erkannt, nur ohne diese Angaben.
 * @returns {Promise<object>} { typeCode, model, series, phases, supported, serial, nominalW, bdcRatedW }
 */
export async function identifySungrow(read) {
  const head = await read({ fc: 4, address: wire(5000), quantity: 2 });
  const typeCode = u16(head?.[0]);
  const nominal = u16(head?.[1]);
  const known = typeCode == null ? null : SUNGROW_HYBRID_MODELS.get(typeCode) || null;
  let serial = null;
  try { serial = decodeSungrowString(await read({ fc: 4, address: wire(4990), quantity: 10 })); } catch { /* Zusatz */ }
  let bdcRatedW = null;
  try {
    const bdc = u16((await read({ fc: 4, address: wire(5628), quantity: 1 }))?.[0]);
    bdcRatedW = bdc == null || bdc === 0 ? null : bdc * 100;
  } catch { /* Zusatz */ }
  // Akkukapazität (Doku 5639 „Battery Capacity – High precision", U16, 0,01 kWh → Wh = Rohwert·10): nur als
  // Vorschlag für die GUI gelesen, NICHT automatisch gesetzt (Betreiber prüft und trägt ein).
  let batteryCapacitySuggestionWh = null;
  try {
    const capRaw = u16((await read({ fc: 4, address: wire(5639), quantity: 1 }))?.[0]);
    batteryCapacitySuggestionWh = capRaw == null || capRaw === 0 ? null : Math.round(capRaw * 10);
  } catch { /* Zusatz */ }
  return {
    vendor: 'sungrow',
    typeCode,
    typeCodeHex: typeCode == null ? null : `0x${typeCode.toString(16).toUpperCase()}`,
    model: known?.model || null,
    series: known?.series || null,
    phases: known?.phases || null,
    supported: known != null,
    serial,
    nominalW: nominal == null ? null : nominal * 100,
    bdcRatedW,
    batteryCapacitySuggestionWh
  };
}

/**
 * Was soll der Wechselrichter tun, damit am Zähler `setpointW` fließt? Rein, ohne I/O.
 *
 * Regler (Akku + = Laden): P = Akku_Ist + gain · (Sollwert − Netz_Ist). Begrenzungen:
 *   • Laden höchstens maxChargeW, Entladen höchstens maxDischargeW.
 *   • Sollwert ≤ 0 (kein Netzbezug gewollt) oder noGridCharge (Netzbezug nur für die Last, z. B. EOS „Akku
 *     halten“): Laden höchstens aus dem PV-Überschuss (PV − Last), damit DVhub nie aus dem Netz lädt, wenn es
 *     das Netzladen nicht angefordert hat.
 *   • Sollwert ≥ 0 (keine Einspeisung gewollt) oder dischargeLoadOnly (Einspeisung gesperrt, M25): Entladen
 *     höchstens die Netto-Last (Last − PV), damit kein Akkustrom ins Netz geht.
 *   • noCharge (Test-Knopf „Akku nicht laden", M25): kein Laden — wäre Laden nötig, Stopp; Entladen bleibt.
 * Fehlen Netz- oder Akku-Messung (oder PV/Last für die Begrenzung), gibt es keine Zwangsvorgabe.
 *
 * @returns {{ mode: 'self'|'forced', command?: 'charge'|'discharge'|'stop', powerW?: number, reason: string }}
 */
export function decideEmsCommand({
  setpointW, gridImportW, batteryW, pvW = null, loadW = null,
  maxChargeW, maxDischargeW, bandW = 300, gain = 0.7, minPowerW = 50, noGridCharge = false,
  forced = false, socPct = null, floorSocPct = null, noCharge = false, dischargeLoadOnly = false
} = {}) {
  const fin = (v) => v != null && Number.isFinite(Number(v));
  if (!fin(setpointW)) return { mode: 'self', reason: 'no_setpoint' };
  const s = Number(setpointW);
  // Band = Ruhezustand nur im External-/Default-Pfad. Im Forced mode (forced:true) gibt es KEIN Band
  // (Christin 15.11.): die Regelschleife läuft immer auf den Sollwert, auch bei s = 0 (PV-Überschuss laden,
  // Defizit entladen). Ruhe entsteht nur taktweise, wenn |p| < minPowerW (unten → 0xCC für genau diesen Takt).
  if (!forced && Math.abs(s) <= Math.max(0, Number(bandW) || 0)) return { mode: 'self', reason: 'band' };
  if (!fin(gridImportW) || !fin(batteryW)) return { mode: 'self', reason: 'telemetry_missing' };
  if (!(Number(maxChargeW) > 0) || !(Number(maxDischargeW) > 0)) return { mode: 'self', reason: 'power_limit_unknown' };
  const k = Math.min(1, Math.max(0.1, Number(gain) || 0.7));
  let p = Number(batteryW) + k * (s - Number(gridImportW));
  let reason = 'regulate';
  // Entlade-Boden (SoC < hardFloorSocPct): nur das ENTLADEN sperren. Das Laden aus PV-Überschuss bleibt
  // erlaubt (Sollwert 0 + Einspeisung → p > 0 → Laden bis Netz ≈ 0). Gilt nur im Forced-Pfad.
  const belowFloor = forced && fin(socPct) && fin(floorSocPct) && Number(socPct) < Number(floorSocPct);
  // Harte Obergrenze für |p| in der gewählten Richtung (I-SafeQuant/VÄ-12): maxCharge bzw. PV-Überschuss bei
  // Netzlade-Verbot, maxDischarge bzw. Netto-Last bei „keine Einspeisung" oder gesperrter Einspeisung (M25).
  // Geprüft wird NACH der Quantisierung.
  let bound = null;
  if (p > 0 && noCharge === true) { p = 0; reason = 'charge_blocked'; } // M25: Laden gesperrt → Stopp
  else if (p > 0) {
    bound = Number(maxChargeW);
    if (s <= 0 || noGridCharge === true) {
      const surplus = fin(pvW) && fin(loadW) ? Math.max(0, Number(pvW) - Number(loadW)) : 0;
      bound = Math.min(bound, surplus);
      if (Math.min(p, Number(maxChargeW)) > surplus) reason = 'charge_pv_only'; // wie bisher: nach der maxCharge-Klemmung
    }
    p = Math.min(p, bound);
  } else if (p < 0) {
    if (belowFloor) { p = 0; reason = 'discharge_floor'; } // SoC am Boden → kein Entladen (nur dieser Takt)
    else {
      bound = Number(maxDischargeW);
      if (s >= 0 || dischargeLoadOnly === true) {
        const netLoad = fin(pvW) && fin(loadW) ? Math.max(0, Number(loadW) - Number(pvW)) : 0;
        bound = Math.min(bound, netLoad);
        if (Math.min(-p, Number(maxDischargeW)) > netLoad) reason = 'discharge_load_only'; // wie bisher: nach der maxDischarge-Klemmung
      }
      p = Math.max(p, -bound);
    }
  }
  // I-SafeQuant / VÄ-12 (VCL-Vertrag): normal auf das 10-W-Raster runden; reißt der gerundete Wert die harte
  // Grenze, zur SICHEREN Seite abrunden. Sonst machen 156 W Überschuss 160 W (4 W Netzladen) bzw. 156 W Netto-Last
  // 160 W Entladen (4 W Akku-Einspeisung) — auch wenn |p| die Grenze vorher nicht überschritt (Fable-Review 18.11.).
  const q = Math.abs(p) / 10;
  let powerW = Math.round(q) * 10;
  if (bound != null && powerW > bound) powerW = Math.floor(q) * 10;
  if (powerW < Math.max(0, Number(minPowerW) || 0)) return { mode: 'forced', command: 'stop', powerW: 0, reason };
  return { mode: 'forced', command: p > 0 ? 'charge' : 'discharge', powerW, reason };
}

const CMD_BY_NAME = { charge: EMS_CMD.CHARGE, discharge: EMS_CMD.DISCHARGE, stop: EMS_CMD.STOP };

/** Ist der Zustand am Gerät (Modus/Befehl/Leistung) schon das Gewünschte? */
export function emsMatches(dev, decision, toleranceW = 0, modeValue = EMS_MODE.FORCED, { ignoreMode = false } = {}) {
  if (!dev) return false;
  // Slave (ignoreMode, Feld #5): der Slave folgt dem Master-Modus — nur Befehl/Leistung prüfen, nie seinen Modus.
  if (decision.mode === 'self') return (ignoreMode || dev.mode === EMS_MODE.SELF) && dev.cmd === EMS_CMD.STOP;
  if ((!ignoreMode && dev.mode !== modeValue) || dev.cmd !== CMD_BY_NAME[decision.command]) return false;
  if (decision.command === 'stop') return true;
  return Math.abs(Number(dev.powerW) - Number(decision.powerW)) <= toleranceW;
}

const DEFAULTS = Object.freeze({
  bandW: 300,            // |Sollwert| bis hier: Self-consumption (DVhub-Puffer −40/−100 W, „Akku halten“)
  gain: 0.7,             // Dämpfung je Schritt (Bridge-Doku: 50–70 % des Fehlers)
  minPowerW: 50,
  stepW: 100,            // Leistung erst ab dieser Änderung neu schreiben
  regulateEveryMs: 10000, // Nachführen höchstens so oft (WiNet-S: RW-Register nicht im Sekundentakt)
  telemetryMaxAgeMs: 20000,
  targetMaxAgeMs: 120000, // ohne Auffrischung des Sollwerts zurück in Self-consumption
  deviceRecheckMs: 60000  // Gerätezustand (13050–13052) spätestens so oft neu lesen (Neustart, App-Eingriff)
});

// Quellen, deren positiver Sollwert nur die Last aus dem Netz holt, nie den Akku lädt (schedule-eval:
// EOS „Akku halten“ rechnet Live-Last − PV − Puffer).
const NO_GRID_CHARGE_SOURCES = new Set(['eos_grid_hold']);

// Gewählter fester Regeltakt (N5): Master aus cfg.sungrow.regulateEveryMs, Slave aus
// cfg.sungrow.secondInverter.regulateEveryMs (optional getrennt; leer/0 → erbt den Master-Takt). 0 = Auto (adaptiv).
export function sungrowConfiguredRegulateMs(cfg, { isSlave = false } = {}) {
  const slaveVal = Number(cfg?.sungrow?.secondInverter?.regulateEveryMs);
  if (isSlave && Number.isFinite(slaveVal) && slaveVal > 0) return slaveVal;
  const masterVal = Number(cfg?.sungrow?.regulateEveryMs);
  return Number.isFinite(masterVal) && masterVal > 0 ? masterVal : 0;
}

/** Regler-Einstellungen aus controlWrite.gridSetpointW.sungrowEms (Profil) mit Standardwerten. */
export function resolveSungrowEmsOptions(conf = {}) {
  const o = conf?.sungrowEms && typeof conf.sungrowEms === 'object' ? conf.sungrowEms : {};
  const num = (v, d, min) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  return {
    bandW: num(o.bandW, DEFAULTS.bandW, 0),
    gain: num(o.gain, DEFAULTS.gain, 0.1),
    minPowerW: num(o.minPowerW, DEFAULTS.minPowerW, 0),
    stepW: num(o.stepW, DEFAULTS.stepW, 0),
    regulateEveryMs: num(o.regulateEveryMs, DEFAULTS.regulateEveryMs, 2000),
    telemetryMaxAgeMs: num(o.telemetryMaxAgeMs, DEFAULTS.telemetryMaxAgeMs, 1000),
    targetMaxAgeMs: num(o.targetMaxAgeMs, DEFAULTS.targetMaxAgeMs, 10000),
    deviceRecheckMs: num(o.deviceRecheckMs, DEFAULTS.deviceRecheckMs, 10000),
    maxPowerW: Number(o.maxPowerW) > 0 ? Number(o.maxPowerW) : null
  };
}

/** Profil bildet den Netz-Sollwert über den Sungrow-EMS nach? */
export function sungrowEmsConf(cfg) {
  const c = cfg?.controlWrite?.gridSetpointW;
  return c?.enabled === true && c.emulate === 'sungrow-ems' ? c : null;
}

// Erlaubtes Zittern des Intervall-Timers (der Aufrufer tickt den Regler im eigenen schnellen Takt, Punkt 2).
const TICK_JITTER_MS = 250;
// Nach einem geräteeigenen Rückfall frühestens nach dieser Zeit wieder in External EMS eintreten (Punkt 3c).
const REENTRY_AFTER_FALLBACK_MS = 10000;
// Nach >3 Rückfällen/min so lange nicht wieder eintreten (Mode-Register 13050 schonen, Punkt 3c).
const FALLBACK_COOLDOWN_MS = 60000;
// Übergangs-Prinzip (Christin, Punkt 1): erst nach SO langem Eigenverbrauch (kein Sollwert / Band) aus External
// EMS zurück in Modus 0; kürzere Löcher werden mit Akku-0 W in External EMS überbrückt (kein Mode-Flattern).
const SELF_RELEASE_MS = 15 * 60 * 1000;
// Schreibbudget 13050 (Modus) je WR und Tag (Punkt 2): danach im aktuellen Modus bleiben, bis Mitternacht.
const MODE_WRITES_PER_DAY = 20;
// Dauer-Forced-Wiedereintritt (B3): fällt der Master von selbst auf Modus 0 (WR-Neustart/Firmware/Netzfehler),
// tritt DVhub einmal neu ein. Mehr als so viele Wiedereintritte je Stunde → nicht mehr eintreten (13050-Budget
// schonen), Modus 0 lassen, Warnung.
const FORCED_REENTRY_MAX_PER_HOUR = 6;
// Adaptiver Regeltakt (Punkt 2): Grenzen 1–5 s, gemessen aus der Antwortzeit (gleitender Mittelwert).
const REGULATE_MIN_MS = 1000;
const REGULATE_MAX_MS = 5000;
// Wählbarer fester Takt bis hinunter zu 0,25 s (Christin 15.11.): ein ausdrücklich gesetzter sungrow.regulateEveryMs
// darf schneller als die adaptive Untergrenze gehen (bis zur Hardware-Grenze). Die ADAPTIVE Messung bleibt bei
// 1–5 s (kein Überschwingen); nur der explizite Wert nutzt diese Untergrenze.
const REGULATE_FIXED_MIN_MS = 250;

/** Schlüssel der Geräteverbindung (Adresse, Port, Unit-ID) — Erkennung und Schreib-Tor gelten je Verbindung. */
export function endpointKeyOf(v) {
  return `${v?.host ?? ''}:${v?.port ?? ''}:${v?.unitId ?? ''}`;
}

/**
 * Betreiber-Einstellung cfg.sungrow.secondInverter: Verbindung des ZWEITEN Sungrow-WR im Master/Slave-
 * Parallelbetrieb und der Aggregations-Schalter. Steuerung geht laut Sungrow-Doku (V1.1.11, Energy-Management:
 * „For multi-inverter (master/slave) systems, this parameter only needs to be issued to the master.“) NUR an
 * den Master — der zweite WR wird hier ausschließlich LESEND angebunden (services/inverter/sungrow-second.js).
 */
export function resolveSecondInverter(cfg) {
  const o = cfg?.sungrow?.secondInverter;
  const c = o && typeof o === 'object' ? o : {};
  const host = String(c.host || '').trim();
  const t = Number(c.timeoutMs);
  return {
    host,
    port: Number(c.port) || 502,
    unitId: Number.isFinite(Number(c.unitId)) ? Number(c.unitId) : 1,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 1500,
    aggregateTelemetry: c.aggregateTelemetry === true,
    // Aufteilungs-Strategie des zweiten WR (Punkt 1), getrennt für Laden/Entladen. Standard 'soc-balance'
    // (= bisheriges Verhalten: nach nutzbarer Reserve/freiem Platz). strategyDischarge erbt strategyCharge, wenn
    // nicht gesetzt. Rückwärtskompatibel zum alten Feld control: 'self-only' → 'master-only', 'split' → 'soc-balance'.
    strategyCharge: strategyCharge(c),
    strategyDischarge: strategyDischarge(c),
    ratioMasterPct: clampRatioPct(c.ratioMasterPct),
    // Totband der soc-balance auf die SoC-Differenz (konfigurierbar, Christin 15.11.): kleinere Unterschiede
    // werden nicht aktiv ausgeglichen. 0–50 %, Standard 10 %.
    socBalanceDeadbandPct: Number.isFinite(Number(c.socBalanceDeadbandPct)) ? Math.min(50, Math.max(0, Number(c.socBalanceDeadbandPct))) : SOC_BALANCE_DEADBAND_PCT,
    maxChargeW: Number(c.maxChargeW) || 0,
    maxDischargeW: Number(c.maxDischargeW) || 0,
    batteryCapacityWh: Number(c.batteryCapacityWh) || 0,
    enabled: host.length > 0,
  };
}

/** Gültige Aufteilungs-Strategien für den zweiten WR (Punkt 1). */
export const SPLIT_STRATEGIES = ['master-only', 'ratio', 'by-capacity', 'by-power', 'soc-balance', 'priority-master', 'priority-slave'];

// soc-balance (Feld 15.11., Aufgabe 6 — von SOLLTE auf MUSS): die Aufteilung richtet sich NACH DEM SoC, sodass sich
// beide Akkus ANGLEICHEN. Entladen bekommt der WR mit dem HÖHEREN SoC mehr (mehr nutzbare Reserve über seinem
// Min-SoC), Laden der mit dem NIEDRIGEREN SoC mehr (mehr freier Platz bis zu seinem Max-SoC); bei gleichem SoC nach
// Kapazität. Das frühere Totband-Modell (10 % Deadband + schwaches Gegensteuern) glich im Feld NICHTS aus — eine
// Differenz von 5 % (9,2 % vs 14,4 %) lag ganz im Totband → 50/50. socBalanceDeadbandPct wird hier nicht mehr genutzt.
export const SOC_BALANCE_DEADBAND_PCT = 10;
// Angleich-Marge (Aufgabe 6): die Referenz, auf die sich beide WR zubewegen, liegt um diese Marge UNTER dem
// niedrigeren (Entladen) bzw. ÜBER dem höheren (Laden) SoC. So bekommt der WR, der angleichen soll, deutlich mehr,
// OHNE den anderen ganz auszuhungern (beide bleiben aktiv — der Regler verteilt die eine Vorgabe auf beide). Klein
// genug, dass eine SoC-Differenz von wenigen Prozent kräftig differenziert (5 % Differenz → ≈2:1), groß genug gegen
// Flattern bei winziger Differenz. SYMMETRISCH für Laden/Entladen (die alte Reserve-zur-Grenze war asymmetrisch:
// nahe leer unterschied sie beim Laden kaum → Feld 9,2/14,4 blieb ≈50/50).
const SOC_BALANCE_MARGIN_PCT = 5;

// M28 (Christin 19.11., Feldbeleg 12:28): Entlade-Marge im Split. Ein WR, der weniger als diese Marge (Prozentpunkte,
// ECHTER SoC) über seiner Entladegrenze steht, bekommt KEINEN Entlade-Anteil — sein Anteil geht an den anderen. Im
// Feld galt der Master mit real 10,6 % bei Grenze 10 % noch als lieferfähig, lieferte aber 0 W (Netz +552 W statt
// −40 W). Laden bleibt erlaubt (die Marge gilt nur beim Entladen).
export const SUNGROW_SPLIT_DISCHARGE_MARGIN_PCT = 1;
// M28 Liefert-nicht-Erkennung (Christin 19.11.): liefert ein WR über STALL_DETECT_MS weniger als STALL_DELIVER_RATIO
// seines Anteils (nur bei Anteil > STALL_MIN_SHARE_W), gilt er in dieser Richtung als „an der Grenze" — sein Anteil
// geht an den anderen. Etwa alle STALL_PROBE_MS bekommt er ihn probeweise zurück. Liegen zwei Messungen weiter als
// STALL_TRACK_MAX_GAP_MS auseinander (Takt stand), beginnt die Messung neu.
const STALL_MIN_SHARE_W = 200;
const STALL_DELIVER_RATIO = 0.5;
const STALL_DETECT_MS = 10000;
const STALL_PROBE_MS = 60000;
const STALL_TRACK_MAX_GAP_MS = 15000;
// M28 Grundsatz 0 (Christin 19.11., Nachtrag 12:45): die Aufteilung rechnet mit dem, was jeder WR TATSÄCHLICH liefert.
// Liefert ein WR bestätigt weniger als befohlen (Abweichung > max(LIMIT_ENTER_MIN_W, LIMIT_ENTER_RATIO·Befehl), über
// LIMIT_CONFIRM_MS, gemessen erst LIMIT_SETTLE_MS nach einer Befehlserhöhung — der Slave wird nur alle 5 s gelesen), gilt
// seine gemessene Leistung als seine Lieferfähigkeit (limitW). Das Fehlende (Anteil − limitW) geht an den anderen, bis
// zu dessen Leistungs-/SoC-Grenze; ein selbst begrenzter Empfänger bekommt höchstens limitW + LIMIT_PROBE_W (so zeigt
// er, ob er mehr kann, ohne hin und her zu springen). Aufgehoben wird die Begrenzung erst, wenn der WR wieder liefert,
// was befohlen ist (Abweichung ≤ max(LIMIT_EXIT_MIN_W, LIMIT_EXIT_RATIO·Befehl)), und mehr verlangt war als seine alte
// Grenze (Hysterese gegen Ping-Pong). Ohne neue Messung über LIMIT_STALE_MS verfällt sie.
const LIMIT_MIN_CMD_W = 100;
const LIMIT_ENTER_MIN_W = 100;
const LIMIT_ENTER_RATIO = 0.1;
const LIMIT_EXIT_MIN_W = 30;
const LIMIT_EXIT_RATIO = 0.05;
const LIMIT_SETTLE_MS = 1500;
const LIMIT_CONFIRM_MS = 2000;
const LIMIT_PROBE_W = 100;
const LIMIT_STALE_MS = 15000;

/**
 * Steht ein WR in DIESER Richtung an seiner SoC-Grenze? Entladen: SoC ≤ Boden, mit Marge > 0 schon SoC < Boden +
 * Marge (M28). Laden: SoC ≥ Decke. SoC oder Grenze unbekannt → false (nicht sperren). Rein.
 */
export function sungrowWrAtLimit({ charge, socPct, floorPct, ceilPct, dischargeMarginPct = 0 } = {}) {
  const fin = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  if (!fin(socPct)) return false;
  const soc = Number(socPct);
  if (charge) return fin(ceilPct) && soc >= Number(ceilPct);
  if (!fin(floorPct)) return false;
  const margin = fin(dischargeMarginPct) ? Math.max(0, Number(dischargeMarginPct)) : 0;
  return margin > 0 ? soc < Number(floorPct) + margin : soc <= Number(floorPct);
}

/**
 * Angleich-Gewichte der soc-balance (Aufgabe 6). Grundgewicht = Kapazität (ohne Kapazität die Leistungsgrenze als
 * Proxy); multipliziert mit dem Abstand des WR zur gemeinsamen Angleich-Referenz IN DER RICHTUNG. Entladen: Referenz
 * = niedrigerer der beiden SoC minus Marge → der HÖHERE SoC hat mehr Abstand → bekommt mehr (beide entladen sich auf
 * den niedrigeren zu). Laden: Referenz = höherer der beiden SoC plus Marge → der NIEDRIGERE SoC hat mehr Abstand →
 * bekommt mehr. Gleicher SoC → gleicher Abstand (= Marge) → rein kapazitätsproportional. SoC unbekannt → parallel
 * nach Kapazität (kein Angleich möglich). splitSungrowPower klemmt danach an die je-WR-Grenzen (Überlauf an den
 * anderen); die harte Grenz-Sperre (Min-/Max-SoC, Aufgabe 1) sitzt separat in splitStrategyShares.
 * @returns {{mW:number, sW:number}}
 */
export function socBalanceWeights({ charge, masterMax = 0, slaveMax = 0, masterSoc, slaveSoc, masterCapacityWh, slaveCapacityWh, marginPct = SOC_BALANCE_MARGIN_PCT } = {}) {
  const fin = (v) => v != null && Number.isFinite(Number(v));
  // Kapazität als Grundgewicht; fehlt sie, die Leistungsgrenze als Proxy (gleiche SoC-Lage → leistungsproportional).
  const capM = Math.max(0, Number(masterCapacityWh) || 0) || Math.max(0, Number(masterMax) || 0);
  const capS = Math.max(0, Number(slaveCapacityWh) || 0) || Math.max(0, Number(slaveMax) || 0);
  const socM = fin(masterSoc) ? Number(masterSoc) : null;
  const socS = fin(slaveSoc) ? Number(slaveSoc) : null;
  if (socM == null || socS == null) return { mW: capM, sW: capS }; // SoC unbekannt → parallel nach Kapazität
  const margin = Math.max(0, Number(marginPct) || 0);
  const ref = charge ? Math.max(socM, socS) + margin : Math.min(socM, socS) - margin;
  const spanM = charge ? Math.max(0, ref - socM) : Math.max(0, socM - ref);
  const spanS = charge ? Math.max(0, ref - socS) : Math.max(0, socS - ref);
  const mW = spanM * capM;
  const sW = spanS * capS;
  if (mW + sW <= 0) return { mW: capM, sW: capS }; // beide ohne Abstand (Marge 0, gleicher SoC) → kapazitätsproportional
  return { mW, sW };
}

function legacyStrategy(c) {
  // Altes Feld control → neue Strategie (Migration ohne Config-Umschreiben).
  if (c?.control === 'self-only') return 'master-only';
  return 'soc-balance'; // Standard und Migration von 'split'
}
function strategyCharge(c) {
  const v = String(c?.strategyCharge || '');
  return SPLIT_STRATEGIES.includes(v) ? v : legacyStrategy(c);
}
function strategyDischarge(c) {
  const v = String(c?.strategyDischarge || '');
  return SPLIT_STRATEGIES.includes(v) ? v : strategyCharge(c); // erbt Laden, wenn nicht eigens gesetzt
}
function clampRatioPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 50;
}

/**
 * Reglerleistung nach der gewählten Strategie (Punkt 1) auf zwei WR aufteilen. Alle Strategien halten die
 * Per-WR-Grenzen ein, der Überlauf geht an den anderen WR, und ein Anteil < minPowerW wird dem anderen WR
 * zugeschlagen (die Summe bleibt die Reglerleistung, ≤ maxPowerW). 'master-only' lässt den Slave in Modus 0
 * (slaveUncommanded=true). Ohne verfügbaren Slave (slaveMax ≤ 0) bekommt der Master alles.
 * M28: dischargeMarginPct (Entlade-Marge über der Grenze) und masterStalled/slaveStalled (liefert seinen Anteil nicht)
 * nehmen einen WR aus der Aufteilung; masterOut/slaveOut sagen, warum ('soc' | 'stalled' | null).
 * @returns {{masterW:number, slaveW:number, slaveUncommanded:boolean, masterOut:string|null, slaveOut:string|null}}
 */
export function splitStrategyShares(strategy, {
  powerW, charge, masterMax, slaveMax, masterSoc, slaveSoc,
  masterCapacityWh, slaveCapacityWh, floorSocPct = 0, maxSocPct = 100, ratioMasterPct = 50, minPowerW = 50,
  masterFloorPct = floorSocPct, slaveFloorPct = floorSocPct, masterCeilPct = maxSocPct, slaveCeilPct = maxSocPct,
  socDeadbandPct = SOC_BALANCE_DEADBAND_PCT, dischargeMarginPct = 0, masterStalled = false, slaveStalled = false,
} = {}) {
  const p = Math.max(0, Math.round(Number(powerW) || 0));
  let mMax = Math.max(0, Number(masterMax) || 0);
  let sMax = Math.max(0, Number(slaveMax) || 0);
  // Per-WR-SoC-Grenze (Aufgabe 1): ein WR, der seine Grenze in DIESER Richtung erreicht hat — beim Entladen den
  // eigenen Min-SoC (max aus hardFloor und 13059), beim Laden den eigenen Max-SoC (min aus maxSoc und 13058) —
  // bekommt 0 W; sein Anteil geht über splitSungrowPower an den anderen WR (bis zu DESSEN Grenze). SoC unbekannt →
  // nicht sperren (die System-Grenze im Regler schützt weiter). Symmetrisch für Laden/Entladen. M28: beim Entladen
  // zählt schon „weniger als dischargeMarginPct über dem Boden" als an der Grenze.
  const atLimit = (soc, floor, ceil) => sungrowWrAtLimit({ charge, socPct: soc, floorPct: floor, ceilPct: ceil, dischargeMarginPct });
  let masterOut = null; let slaveOut = null;
  if (atLimit(masterSoc, masterFloorPct, masterCeilPct) && mMax > 0) { mMax = 0; masterOut = 'soc'; }
  if (atLimit(slaveSoc, slaveFloorPct, slaveCeilPct) && sMax > 0) { sMax = 0; slaveOut = 'soc'; }
  const strat = SPLIT_STRATEGIES.includes(String(strategy)) ? String(strategy) : 'soc-balance';
  if (p <= 0) return { masterW: 0, slaveW: 0, slaveUncommanded: strat === 'master-only', masterOut, slaveOut };
  // master-only: Slave bleibt in Modus 0, Master bekommt alles (an seine Grenze geklemmt).
  if (strat === 'master-only') return { masterW: Math.min(p, mMax), slaveW: 0, slaveUncommanded: true, masterOut, slaveOut: null };
  // M28 liefert nicht: ein WR, der seinen Anteil nicht liefert (Erkennung im Aktuator), gibt ihn an den anderen ab —
  // aber nur, wenn der andere selbst liefert und noch Platz hat. Hängen beide, bringt Umverteilen nichts (normale
  // Aufteilung); kann der andere nicht, behält der hängende WR seinen Anteil (sonst bekäme keiner etwas).
  if (masterStalled && !slaveStalled && sMax > 0 && mMax > 0) { mMax = 0; masterOut = 'stalled'; }
  else if (slaveStalled && !masterStalled && mMax > 0 && sMax > 0) { sMax = 0; slaveOut = 'stalled'; }
  if (sMax <= 0) return { masterW: Math.min(p, mMax), slaveW: 0, slaveUncommanded: false, masterOut, slaveOut }; // Slave offline/an Grenze → alles Master
  if (mMax <= 0) return { masterW: 0, slaveW: Math.min(p, sMax), slaveUncommanded: false, masterOut, slaveOut }; // Master an Grenze → alles Slave
  // Gewichte je Strategie; splitSungrowPower verteilt danach und klemmt an die Grenzen (Überlauf an den anderen).
  let mW; let sW;
  if (strat === 'ratio') { mW = clampRatioPct(ratioMasterPct); sW = 100 - mW; }
  else if (strat === 'by-capacity') { mW = Math.max(0, Number(masterCapacityWh) || 0); sW = Math.max(0, Number(slaveCapacityWh) || 0); }
  else if (strat === 'by-power') { mW = mMax; sW = sMax; }
  else if (strat === 'priority-master') { mW = 1; sW = 0; }
  else if (strat === 'priority-slave') { mW = 0; sW = 1; }
  else { // soc-balance (Angleich, Aufgabe 6)
    ({ mW, sW } = socBalanceWeights({ charge, masterMax: mMax, slaveMax: sMax, masterSoc, slaveSoc, masterCapacityWh, slaveCapacityWh }));
  }
  let { masterW, slaveW } = splitSungrowPower({ powerW: p }, { maxW: mMax, weight: mW }, { maxW: sMax, weight: sW });
  // Anteil < minPowerW dem anderen WR zuschlagen (sonst ginge Leistung verloren). Nur, wenn der andere sie fasst.
  const min = Math.max(0, Number(minPowerW) || 0);
  if (masterW > 0 && masterW < min && slaveW + masterW <= sMax) { slaveW += masterW; masterW = 0; }
  else if (slaveW > 0 && slaveW < min && masterW + slaveW <= mMax) { masterW += slaveW; slaveW = 0; }
  return { masterW, slaveW, slaveUncommanded: false, masterOut, slaveOut };
}

/**
 * Frische, als System-Summe aggregierbare Messung des zweiten WR aus state.sungrowSecond — oder null. Reine
 * Lesefunktion (kein Modbus). Liefert nur etwas, wenn der Betreiber aggregateTelemetry eingeschaltet hat (am
 * Gerät geprüft: der Master meldet NICHT die System-Summen, jeder WR nur seine eigene PV/Akku-Leistung), der
 * zweite WR online und der Wert nicht älter als maxAgeMs ist. Netz/Last bleiben immer die Master-Werte
 * (einziger Zähler am Master).
 */
export function secondInverterTelemetry(state, cfg, { nowMs = Date.now(), maxAgeMs = 20000 } = {}) {
  const c = resolveSecondInverter(cfg);
  if (!c.aggregateTelemetry) return null;
  const s = state?.sungrowSecond;
  if (!s || s.online !== true) return null;
  const fin = (v) => v != null && Number.isFinite(Number(v));
  if (!fin(s.updatedAt) || nowMs - Number(s.updatedAt) > maxAgeMs) return null;
  // Notladung (Aufgabe 2): der Slave lädt eigenmächtig unter seinem Min-SoC aus dem Netz (runningState 0x4001) und
  // ist NICHT steuerbar. Seine Akku-Ladeleistung darf dem Regler NICHT zugerechnet werden (sonst verschöbe sie die
  // Systemsumme und DVhub regelte den Master in die falsche Richtung) → batteryPowerW hier auf null, der Poller
  // aggregiert ihn dann nicht in die System-Akkuleistung. SoC/PV/BDC bleiben für Anzeige und Split-Grenzen erhalten.
  const emergencyCharge = s.emergencyCharge === true || isSungrowEmergencyCharge(s.runningState);
  return {
    batteryPowerW: !emergencyCharge && fin(s.batteryPowerW) ? Number(s.batteryPowerW) : null,
    pvPowerW: fin(s.pvPowerW) ? Number(s.pvPowerW) : null,
    socPct: fin(s.socPct) ? Number(s.socPct) : null,
    bdcRatedW: fin(s.bdcRatedW) && Number(s.bdcRatedW) > 0 ? Number(s.bdcRatedW) : null,
    maxChargeWDevice: fin(s.maxChargeWDevice) && Number(s.maxChargeWDevice) > 0 ? Number(s.maxChargeWDevice) : null,
    maxDischargeWDevice: fin(s.maxDischargeWDevice) && Number(s.maxDischargeWDevice) > 0 ? Number(s.maxDischargeWDevice) : null,
    minSocPctDevice: fin(s.minSocPctDevice) ? Number(s.minSocPctDevice) : null,
    maxSocPctDevice: fin(s.maxSocPctDevice) ? Number(s.maxSocPctDevice) : null,
    emergencyCharge,
  };
}

/** Kapazitätsgewichtetes System-SoC beider WR (ohne Kapazitäten: einfaches Mittel). null, wenn keiner bekannt. */
export function sungrowSystemSoc(masterSoc, secondSoc, { masterCapacityWh = 0, secondCapacityWh = 0 } = {}) {
  const fin = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const m = fin(masterSoc); const s = fin(secondSoc);
  if (m == null && s == null) return null;
  if (m == null) return s;
  if (s == null) return m;
  const cm = Number(masterCapacityWh) > 0 ? Number(masterCapacityWh) : 0;
  const cs = Number(secondCapacityWh) > 0 ? Number(secondCapacityWh) : 0;
  if (cm > 0 && cs > 0) return Number(((m * cm + s * cs) / (cm + cs)).toFixed(2));
  return Number(((m + s) / 2).toFixed(2));
}

/**
 * Nutzbare Reserve eines Akkus über dem Mindest-SoC: (SoC − minSoC)/100 × Kapazität (Wh, ≥ 0). null, wenn SoC
 * oder Kapazität fehlen. Für die Anzeige und die Lastaufteilung je WR (Punkt 2/3: Entladen → mehr Reserve mehr).
 */
export function sungrowReserveWh(socPct, capacityWh, minSocPct = 0) {
  if (socPct == null || !Number.isFinite(Number(socPct)) || !(Number(capacityWh) > 0)) return null;
  const soc = Number(socPct); const cap = Number(capacityWh); const floor = Number(minSocPct) || 0;
  return Math.round(Math.max(0, ((soc - floor) / 100) * cap));
}

/** Freier Platz eines Akkus bis zum Max-SoC: (maxSoC − SoC)/100 × Kapazität (Wh, ≥ 0). Für Laden → mehr Platz mehr. */
export function sungrowHeadroomWh(socPct, capacityWh, maxSocPct = 100) {
  if (socPct == null || !Number.isFinite(Number(socPct)) || !(Number(capacityWh) > 0)) return null;
  const soc = Number(socPct); const cap = Number(capacityWh); const ceil = Number.isFinite(Number(maxSocPct)) ? Number(maxSocPct) : 100;
  return Math.round(Math.max(0, ((ceil - soc) / 100) * cap));
}

/**
 * Reglerleistung auf zwei WR aufteilen (Punkt 3, Split-Steuerung). master/slave: { maxW, weight }. maxW = die
 * Lade- bzw. Entladegrenze DIESES WR für die aktuelle Richtung; weight = nutzbare Reserve (Entladen) bzw. freier
 * Platz (Laden) in Wh. Aufteilung nach Gewicht (ohne Gewicht nach maxW); an die jeweilige Grenze geklemmt, der
 * Überlauf geht an den anderen (ein WR an der Grenze bekommt den Rest nicht — der andere übernimmt). Ohne
 * verfügbaren Slave alles auf den Master.
 * @returns {{masterW:number, slaveW:number}}
 */
export function splitSungrowPower(decision, master, slave) {
  const p = Math.max(0, Math.round(Number(decision?.powerW) || 0));
  const mMax = Math.max(0, Number(master?.maxW) || 0);
  const sMax = slave ? Math.max(0, Number(slave?.maxW) || 0) : 0;
  if (p <= 0 || mMax + sMax <= 0) return { masterW: 0, slaveW: 0 };
  if (!slave || sMax <= 0) return { masterW: Math.min(p, mMax), slaveW: 0 };
  const mW = Math.max(0, Number(master?.weight) || 0);
  const sW = Math.max(0, Number(slave?.weight) || 0);
  const totalW = mW + sW;
  const masterShare = totalW > 0 ? p * (mW / totalW) : p * (mMax / (mMax + sMax));
  let masterW = Math.min(Math.round(masterShare), mMax);
  let slaveW = Math.min(p - masterW, sMax);
  const rest = p - (masterW + slaveW);
  if (rest > 0) {
    if (masterW < mMax) masterW = Math.min(mMax, masterW + rest);
    else slaveW = Math.min(sMax, slaveW + rest);
  }
  return { masterW, slaveW };
}

/** Niedrigerer der beiden SoC — Grundlage des SoC-Bodens (schützt den schwächeren Akku). null, wenn keiner bekannt. */
export function sungrowSocFloor(masterSoc, secondSoc) {
  const vals = [masterSoc, secondSoc].filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  return vals.length ? Math.min(...vals) : null;
}

/**
 * Kanonische System-Telemetrie beider WR: aus der Master-Telemetrie `victron` und der aggregierbaren Slave-
 * Messung `second` die Felder, die DVhub auf die Systemsumme setzt (Akku-/PV-Leistung, SoC) — der Master-Rohwert
 * wandert nach sungrowMaster*. socFloorPct = niedrigerer SoC (SoC-Boden). null wenn `second` fehlt (keine
 * Aggregation → Master-Werte bleiben). Rein; der Poller wendet das Ergebnis feldweise an (nur frische Master-Werte).
 */
export function sungrowSystemTelemetry(victron, second, { masterCapacityWh = 0, secondCapacityWh = 0 } = {}) {
  if (!second) return null;
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const mBat = num(victron?.batteryPowerW); const mPv = num(victron?.pvPowerW);
  const mPvTot = num(victron?.pvTotalW); const mSoc = num(victron?.soc);
  const out = { socFloorPct: sungrowSocFloor(mSoc, second.socPct) };
  if (mBat != null && second.batteryPowerW != null) {
    out.sungrowMasterBatteryW = mBat;
    out.batteryPowerW = Number((mBat + second.batteryPowerW).toFixed(3));
  }
  if (mPv != null && second.pvPowerW != null) {
    out.sungrowMasterPvW = mPv;
    out.pvPowerW = Number((mPv + second.pvPowerW).toFixed(3));
    out.pvTotalW = mPvTot != null ? Number((mPvTot + second.pvPowerW).toFixed(3)) : out.pvPowerW;
  }
  const sysSoc = sungrowSystemSoc(mSoc, second.socPct, { masterCapacityWh, secondCapacityWh });
  if (sysSoc != null && mSoc != null) { out.sungrowMasterSocPct = mSoc; out.soc = sysSoc; }
  return out;
}

/**
 * Sanitierte Zusammenfassung des zweiten WR für Anzeige/Status (OHNE host/LAN-IP — /api/status ist für die App
 * freigegeben). null, wenn keine zweite Verbindung konfiguriert ist; sonst immer die Online-Lage, damit die App
 * sieht, ob der zweite WR erreichbar ist.
 */
export function sungrowSecondView(state, cfg) {
  const c = resolveSecondInverter(cfg);
  if (!c.enabled) return null;
  const s = state?.sungrowSecond;
  // online dreiwertig durchreichen: true (bestätigt erreichbar) / false (nicht
  // bestätigt bzw. unerreichbar — wie der Begleitdienst publiziert, offline bis
  // bestätigt) / null (nur im Start-Fenster vor dem ersten Takt). Messwerte nur
  // live. Das Installateur-Portal bindet „blocked" an false und spiegelt damit
  // denselben Erreichbarkeits-Zustand wie der Leitstand.
  const online = s?.online === true ? true : (s?.online === false ? false : null);
  const live = online === true;
  const pick = (v) => (live && v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    online,
    reason: s?.reason ?? null,
    aggregate: c.aggregateTelemetry === true,
    strategyCharge: c.strategyCharge,
    strategyDischarge: c.strategyDischarge,
    socPct: pick(s?.socPct),
    batteryPowerW: pick(s?.batteryPowerW),
    pvPowerW: pick(s?.pvPowerW),
    bdcRatedW: pick(s?.bdcRatedW),
    batteryCapacitySuggestionWh: pick(s?.batteryCapacitySuggestionWh),
    // Gerätegrenzen (B3/H): gelesene Lade-/Entladegrenze (33047/33048) und Kapazität (33049) als GUI-Vorschlag.
    maxChargeWDevice: pick(s?.maxChargeWDevice),
    maxDischargeWDevice: pick(s?.maxDischargeWDevice),
    batteryCapacityLimitWh: pick(s?.batteryCapacityLimitWh),
    // Min-/Max-SoC je WR (Aufgabe 1): gelesene Gerätewerte (13059/13058), 0,1 % → %. GUI zeigt sie neben dem Feld.
    minSocPctDevice: pick(s?.minSocPctDevice),
    maxSocPctDevice: pick(s?.maxSocPctDevice),
    runningState: live ? (s?.runningState ?? null) : null,
    runningStateText: live ? (s?.runningStateText ?? null) : null,
    // Notladung (Aufgabe 2): der Slave lädt eigenmächtig unter Min-SoC aus dem Netz (0x4001) — nicht steuerbar.
    emergencyCharge: live ? (s?.emergencyCharge === true) : false,
    // N5: Modbus-Gesundheit des Slave-Lesepfads (Anfragen/s, Antwortzeit, Fehler 24 h) + wirksamer Lesetakt. Keine
    // LAN-IP enthalten; auch offline aussagekräftig (zeigt, ob/wie oft der Slave antwortet).
    health: s?.health ?? null,
    tickMs: Number.isFinite(Number(s?.tickMs)) ? Number(s.tickMs) : null,
  };
}

/**
 * Aktuator für den nachgebildeten Netz-Sollwert. Alle Writes nur über Holding-Register 13050–13052 und den
 * Herzschlag 13080, jede Änderung mit Rücklesen. Steuermodus nach cfg.sungrow: External EMS (Modus 3, Standard,
 * mit Herzschlag — fällt DVhub aus, kehrt der Wechselrichter selbst in Self-consumption zurück) oder Forced mode
 * (Modus 2, ohne Rückfall). Im Not-Halt: einmal zurück in Self-consumption, wenn DVhub den Modus gesetzt hat
 * (oder gesetzt haben könnte), danach nichts mehr — auch kein Herzschlag.
 *
 * Jeder Register-Write geht über das Schreibtor (`gate.submit`, Legacy-Modus, VCL-Vertrag v6 D.1/D.2): die Laufzeit
 * übergibt das eine Tor des Prozesses (server.js `ctx.gate` → schedule-eval.js), Master und Slave schließen ihren
 * Transport daran an. Ohne `gate` (Tests, Einzelaufbau) legt der Aktuator ein eigenes mit denselben Richtlinien an.
 */
export function createSungrowEms({ state, getCfg, transport: baseTransport, pushLog = () => {}, now: nowArg = null, monoNow: monoNowArg = null, statePath = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), connOverride = null, statusKey = 'sungrowEms', slaveActuator = null, isSlave = false, forcedHeartbeatPath = null, modbusHealth = null, gate: injectedGate = null }) {
  // Modbus-Gesundheit dieser Verbindung (N5/M7b): zählt jede Anfrage/jeden Fehler transparent. wrap() legt sich vor
  // den Transport; der Rest des Aktuators nutzt nur noch `transport` (gezählt). snapshot() geht in publish() an die
  // Kachel. Ein von außen übergebener Zähler (Master: ctx.sungrowMasterHealth) wird GETEILT — dann zählen Poll UND
  // EMS in denselben Master-Zähler (M7b). Ohne Übergabe ein eigener (Slave, Tests).
  // M22: ohne geteilten Zähler loggt diese Instanz ihre Modbus-Fehler selbst (wr = Master/Slave, source = ems).
  const now = nowArg || (() => Date.now());
  // Monotone Uhr für die Frist „Master allein" (A7, Fable P3-2): ein Sprung der Wanduhr (NTP, Hand-Einstellung) darf
  // die Frist weder verkürzen noch verlängern. Laufzeit: performance.now(); mit eingespielter Uhr (Tests) dieselbe.
  const monoNow = monoNowArg || nowArg || (() => performance.now());
  const modbusHealthInst = modbusHealth || createModbusHealth(now, { pushLog, wr: isSlave ? 'slave' : 'master', source: 'ems', monoNow }); // A23 b: Abstände monoton
  const transport = modbusHealthInst.wrap(baseTransport);
  // Schreibtor (H-1 Phase 2): die Schreibfunktionen dieses Transports erreicht der Aktuator nur noch über das Tor
  // (R-T1). Die Not-Halt-Marke des Tors ist dieselbe wie die der Bestandsprüfung in submitReg.
  const gateDevice = isSlave ? SUNGROW_GATE_DEVICES.slave : SUNGROW_GATE_DEVICES.master;
  const gate = injectedGate || createLegacyGate({ isHalted: () => state.ctrl?.discretionaryWritesPaused === true });
  gate.attachSink(gateDevice, modbusLegacySink(transport));
  const st = {
    target: null,        // { setpointW, source, at }
    dev: null,           // letzter gelesener/bestätigter Gerätezustand { mode, cmd, powerW, at }
    owns: false,         // Zwangs-/EMS-Betrieb ist (womöglich) von DVhub — ab dem ersten Write, bis Self bestätigt ist
    ownMode: null,       // welchen Modus DVhub gesetzt hat (2 Forced, 3 External EMS)
    lastMasterWrite: null, // zuletzt am MASTER bestätigter DVhub-Write { mode, cmd, powerW, at } — erkennt den
                           // EIGENEN Modus 2/3 wieder, wenn der Besitz-Merker verloren ging (M2, Feld 16.11.)
    endpointKey: null,   // Verbindung, für die target/dev/owns gelten
    hb: { key: null, supported: null, workingFc: null, deviceManaged: false }, // Herzschlag-Register: vorhanden? welche Schreibfunktion (FC) nimmt es an?
    hbCfgSig: null,      // Signatur der Herzschlag-Einstellung (eigenes Feld, damit es st.hb-Neuzuweisungen überlebt) — für die lösbare Sperre (1d)
    lastHeartbeatAt: 0,
    externalEnteredAt: 0, // wann External EMS (Modus 3) bestätigt wurde — für die gemessene Rückfallzeit (Punkt 3)
    lastKeepaliveAt: 0,   // letztes Lebenszeichen (Keepalive)
    lastFallbackAfterS: 0, // gemessene Zeit bis der WR von selbst in Self zurückfiel
    lastFallbackAt: 0,    // Zeitpunkt des letzten geräteeigenen Rückfalls (Neueintritt-Sperre 10 s, 3c)
    selfBridgeSince: 0,   // seit wann der Sollwert im Band/aus ist, während DVhub External EMS besitzt (Brücke, Punkt 1)
    fallbackCooldownUntil: 0, // bis hierhin nach >3 Rückfällen/min NICHT wieder eintreten (Mode-Register schonen, 3c)
    fallbackTimes: [],    // Zeitstempel der letzten geräteeigenen Rückfälle (Ratenbegrenzung Neueintritt)
    sentTimeoutS: null,  // zuletzt an den Wechselrichter geschriebene Frist (gilt dort, bis eine neue rausging)
    lastStepAt: null,    // letzter Regeltakt (monoNow, A21); null = der nächste Aufruf ist fällig
    writeDay: { key: null, regs: {} }, // Tages-Schreibzähler je Register (Verschleißschutz, Punkt 2)
    responseMs: null,    // gleitender Mittelwert der Schreib-/Rücklese-Antwortzeit (adaptiver Takt, Punkt 2)
    decision: null,
    error: null,
    neutralizedAt: null,  // pausedAt des Not-Halts, für den die eine Rücknahme schon lief
    revokedReason: null,  // ein Tor hat den letzten Sollwert abgelehnt
    acceptSeq: 0,         // zählt angenommene Sollwerte (Aufrufzeitpunkt) — eine ältere Ablehnung widerruft keinen neueren
    release: null,        // ausstehende manuelle Freigabe (Option A): { reason, confirmedBy, requestedAt, since, attempts, nextAt, lastError }
    // Ergebnis der LETZTEN Freigabe-Anfrage, wenn es etwas zu melden gibt (Codex d6f4b256 P2: an die Anfrage gebunden,
    // jede neue Anfrage löscht es): { state: 'done' | 'abandoned' | 'failed', requestedAt, at, … }
    releaseInfo: null,
    deliver: {},          // M28: Liefert-nicht-Erkennung je WR und Richtung ('master:discharge' → { underSince, stalledUntil, episode })
    limit: {},            // M28 Grundsatz 0: gemessene Lieferfähigkeit je WR und Richtung ('slave:discharge' → { limited, limitW, … })
    splitLast: null,      // M28: zuletzt erfolgreich kommandierte Anteile im Split { direction, masterW, slaveW, at }
    drivenRegulateMs: null, // N3 (nur Slave): Takt, in dem der Master diesen Slave führt (setDrivenRegulateMs)
    // Slave (Christin 21.11.2026, Fable P2-1): Befehl Stopp seit der letzten eigenen Rücknahme/Prüfung am Gerät
    // bestätigt (zurückgelesen). Gelöscht, sobald DVhub einen Befehl schreibt oder die Verbindung wechselt; bis zur
    // ersten Prüfung unbekannt (false).
    stopConfirmed: false,
    stopConfirmedAt: 0,  // wann der Stopp zuletzt am Gerät bestätigt wurde (monoNow; Nachprüfung im Betrieb, Fable 2 P3)
    // Master: Prüfung des nicht geführten Slave vor Eintritt/im Betrieb (stopSlaveBeforeTakeover).
    slaveCheck: { failedAt: 0, error: null }, // letzter Fehlschlag mit Gerätezugriff — Drossel (Fable P3-2)
    slaveNeutralizeTick: null, // Takt, in dem der Pfad den besessenen Slave schon zurückzunehmen versuchte (P3-4)
    slaveForeignNotified: false, // Lage „Slave unter fremdem EMS" schon gemeldet (Review 4cf0a9e4 P3)
    slaveRecheckAt: 0,   // letzte Nachprüfung eines nicht geführten Slave mit bestätigtem Stopp (monoNow, Fable 2 P3)
    entryDeferred: { since: 0, lastAt: 0, logKey: null, logAt: 0 }, // Wartezustand vor dem Eintritt (P2-2)
    reentryLogPending: null, // Wiedereintritt (B3) erst melden, wenn er wirklich geschrieben ist (P3-3)
    // Master (A7, Christin 21.11.2026): Frist „Master allein" bei unbestätigtem, nicht geführtem Slave — nur im Speicher.
    masterAlone: masterAloneIdle(),
    logKeys: {}
  };
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  function logOnce(key, event, data, level) {
    if (st.logKeys[event] === key) return;
    st.logKeys[event] = key;
    pushLog(event, data, level);
  }

  // Besitz-Merker auf der Platte (wie dv_seq_saved.json): nach einem Neustart erkennt DVhub sein eigenes
  // External EMS wieder — sonst hielte es den eigenen Modus 3 für ein fremdes EMS.
  if (statePath) {
    try {
      const m = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (m && (m.ownMode === EMS_MODE.FORCED || m.ownMode === EMS_MODE.EXTERNAL) && typeof m.endpointKey === 'string') {
        st.owns = true;
        st.ownMode = m.ownMode;
        st.endpointKey = m.endpointKey;
        // Merker-Start-Reset (C3): DVhub besaß den Forced mode vor dem Neustart → der WR hält womöglich noch den
        // ALTEN Lade-/Entladebefehl. Beim ersten Forced-Takt zuerst auf 0xCC (Akku anhalten, Modus 2 bleibt) setzen,
        // damit kein stehengebliebener Befehl über den ersten Takt hinaus läuft; der nächste Takt regelt frisch.
        if (m.ownMode === EMS_MODE.FORCED) st.startupResetPending = true;
      }
    } catch { /* kein Merker → nichts in Besitz */ }
  }

  // A2 (Christin 16.11.2026): Tages-Schreibzähler (13050-Budget) auf die Platte, sonst setzt ein Neustart das
  // Budget zurück und der WR könnte an einem Tag deutlich mehr als 20 Moduswechsel sehen (Flash-Verschleiß). EIGENE
  // Datei neben dem Besitz-Merker (sungrow_ems_writeday.json) — der Watchdog-Schlüssel (ownMode/endpointKey im
  // sungrow_ems_state.json) bleibt exakt unberührt. Nur der Master persistiert (statePath gesetzt); der Slave hat
  // kein Mode-Budget. Geschrieben wird NUR beim Moduswechsel (≤20/Tag) — kein Datei-I/O im 1-s-Regeltakt.
  const writeDayPath = statePath ? String(statePath).replace(/[^/\\]*$/, 'sungrow_ems_writeday.json') : null;
  if (writeDayPath) {
    try {
      const w = JSON.parse(fs.readFileSync(writeDayPath, 'utf8'));
      if (w && typeof w.key === 'string' && w.regs && typeof w.regs === 'object') {
        // writeDayBucket() setzt an einem neuen Tag ohnehin zurück — ein veralteter Stand wird so verworfen.
        st.writeDay = { key: w.key, regs: { ...w.regs } };
      }
    } catch { /* keine/ungültige Datei → frischer Zähler */ }
  }

  function setStopConfirmed(v) {
    st.stopConfirmed = v === true;
    // Monotone Zeit (Review 590b056a P3): nur für den Abgleich der Nachprüfung am Master, die ebenfalls monoton rechnet.
    st.stopConfirmedAt = v === true ? monoNow() : 0;
  }

  function setOwns(mode) {
    const owns = mode != null;
    if (st.owns === owns && st.ownMode === (owns ? mode : null)) return;
    st.owns = owns;
    st.ownMode = owns ? mode : null;
    if (!owns) { st.lastHeartbeatAt = 0; st.sentTimeoutS = null; }
    if (!statePath) return;
    try {
      if (owns) atomicWriteControlState(statePath, { ownMode: mode, endpointKey: st.endpointKey, at: now() });
      else fs.rmSync(statePath, { force: true });
    } catch (e) {
      logOnce(e?.message || 'x', 'sungrow_ems_state_persist_error', { error: e?.message || String(e) }, 'warn');
    }
  }

  // Lebenszeichen-Zeitstempel für den unabhängigen Box-Watchdog (Absicherung C4): solange DVhub den Forced mode
  // aktiv fährt, wird diese Datei regelmäßig aufgefrischt. Der Watchdog (systemd-Timer) nimmt den Forced mode
  // zurück, wenn der Master in Modus 2 steht, aber die Datei älter als seine Frist ist (DVhub hängt). Gedrosselt
  // auf ≥ 5 s (Datei-I/O nicht in jedem 1-s-Takt). Nur der Master schreibt sie (der Slave folgt).
  // Drossel monoton (A21, Christin 23.11.2026): mit der Wanduhr blieb die Datei nach einem Rücksprung der Uhr um die
  // Sprungweite alt (der Watchdog hielte DVhub für hängend); in der Datei steht weiter die Wanduhrzeit.
  function touchForcedHeartbeat() {
    if (!forcedHeartbeatPath || isSlave) return;
    const t = now();
    const m = monoNow();
    const last = st.lastForcedHeartbeatFileMono;
    if (last != null && m - last >= 0 && m - last < 5000) return;
    st.lastForcedHeartbeatFileMono = m;
    try { atomicWriteControlState(forcedHeartbeatPath, { at: t, endpointKey: st.endpointKey, ...bootStamp() }); } // A23 b: bootMs/bootId für den Watchdog
    catch (e) { logOnce(e?.message || 'x', 'sungrow_ems_heartbeat_file_error', { error: e?.message || String(e) }, 'warn'); }
  }

  // Modus 4 (VPP) ist immer fremd; Modus 3 (External EMS) nur dann nicht, wenn DVhub ihn selbst gesetzt hat
  // (Merker) oder das Gerät DVhubs zuletzt bestätigten Write spiegelt (M2).
  // Modus 2 (Forced) ist NIE fremd — H-9 (Christin 17.11.2026, bestätigt 20.11.2026; VCL-Vertrag v6 Teil H, VÄ-3):
  // ein gefundener Modus 2 wird übernommen und als eigener weitergefahren, auch ohne Eigentumsbeleg. Das Eigentum
  // stellt DVhubs erster Write her (needsAdoption → writeDecision adopt: Befehl, bei Laden/Entladen auch die
  // Leistung, auch wenn das Gerät schon passt), nie ein unbekannter Gerätewert. Bis 8c0f34ea galt ein nicht
  // besessener Modus 2 bei Forced-Steuerung als fremd (B4) und lief unbeaufsichtigt weiter. Steuert DVhub per
  // External EMS, verlässt es einen Modus 2 wie bisher mit bekannten Writes (Self: 0xCC + Modus 0; Eintritt:
  // Leistung, Befehl, Modus 3, Herzschlag). Notausgang für einen ungewollten Modus 2 bleibt die manuelle
  // Zwangsfreigabe (H-7, forceRelease), auch im Not-Halt.
  // Stimmt der Gerätezustand (Modus 2/3, Befehl, Leistung) mit DVhubs zuletzt am Master BESTÄTIGTEM Write überein?
  // Dann ist der Modus DVhubs EIGENER, auch wenn der Besitz-Merker verloren ging (M2, Feld 16.11.: nach einem
  // Lesefehler löschte DVhub owns, schrieb die Rückgabe aber nicht durch — danach hielt es seinen eigenen Modus 2
  // für fremd und schrieb nichts mehr). KEIN Alter-Fenster: solange das Gerät exakt DVhubs Write spiegelt, hat
  // niemand sonst eingegriffen. Stop ignoriert die Leistung. Nur am Master (der Slave folgt dem Master-Modus).
  const ownWroteMode = (mode, dev) => {
    const lw = st.lastMasterWrite;
    if (isSlave || !lw || !dev) return false;
    if (lw.mode !== mode || dev.mode !== mode) return false;
    if (lw.cmd !== dev.cmd) return false;
    if (dev.cmd !== EMS_CMD.STOP && Math.abs(Number(lw.powerW) - Number(dev.powerW)) > 10) return false;
    return true;
  };
  // mode ohne dev (ältere Aufrufer): nur der Modus zählt; mit dev zusätzlich der Eigen-Write-Abgleich (M2).
  const isForeignMode = (mode, dev = null) => {
    if (mode === EMS_MODE.VPP) return true;
    if (mode === EMS_MODE.EXTERNAL) return !(st.owns && st.ownMode === EMS_MODE.EXTERNAL) && !ownWroteMode(EMS_MODE.EXTERNAL, dev);
    return false; // Modus 2 (H-9) und Modus 0
  };

  // H-9: Muss DVhub den Betrieb erst per eigenem Write übernehmen, bevor es ihn als eigenen weiterfährt?
  //   • Master: Forced-Steuerung, DVhub fährt einen Forced-Befehl, das Gerät steht in Modus 2, und DVhub hält keinen
  //     Forced-Besitz. Das gilt auch, wenn das Gerät DVhubs letzten bestätigten Write spiegelt (M2): ohne Merker sähen
  //     ihn Not-Halt, Beenden, Außen-Wächter und ExecStopPost nicht.
  //   • Slave (folgt dem Master-Modus, bekommt nie einen Moduswrite): DVhub fährt einen Befehl und hält keinen Besitz in
  //     dieser Steuerart. Ersetzt M12 (Besitz OHNE Write, wenn der Zustand im Rahmen der Schreibschwelle passte).
  // Dann geht DVhubs Befehl voll raus (writeDecision adopt), auch wenn das Gerät schon passt — so läuft nie ein
  // unbekannter Gerätewert unter DVhubs Besitz weiter. Modus 13050 bleibt 2 (kein zusätzlicher Moduswrite).
  function needsAdoption(dev, decision, modeValue) {
    if (!dev || decision?.mode !== 'forced') return false;
    if (st.owns && st.ownMode === modeValue) return false;
    if (isSlave) return true;
    return modeValue === EMS_MODE.FORCED && dev.mode === EMS_MODE.FORCED;
  }
  // Was vor der Übernahme am Gerät stand (für die Meldung danach; vor dem Write festhalten, weil writeDecision
  // lastMasterWrite überschreibt).
  function adoptionFound(dev) {
    return { mode: dev.mode, cmd: dev.cmd, powerW: dev.powerW, ownLastWrite: !isSlave && ownWroteMode(EMS_MODE.FORCED, dev) };
  }
  // Übernahme melden (warn). Der Slave meldet nur, wenn er etwas fuhr (Befehl ≠ Stopp) — sonst ist es sein
  // gewöhnlicher Eintritt nach einer Rücknahme.
  function logAdoption(found, decision) {
    if (isSlave && found.cmd === EMS_CMD.STOP) return;
    const side = isSlave ? 'slave' : 'master';
    const powerW = decision.command === 'stop' ? 0 : decision.powerW;
    pushLog('sungrow_ems_forced_adopted', {
      side,
      found: { mode: found.mode, cmd: found.cmd, powerW: found.powerW },
      written: { command: decision.command, powerW },
      ownLastWrite: found.ownLastWrite,
      text: `Sungrow ${isSlave ? 'Slave' : 'Master'}: ${isSlave ? 'Befehl' : 'Modus 2'} ohne DVhub-Besitz gefunden (Befehl 0x${(found.cmd & 0xffff).toString(16)}, ${found.powerW} W) — DVhub übernimmt (H-9) mit eigenem Befehl: ${describe(decision)}. Ungewollt? „Sungrow freigeben" (auch im Not-Halt).`,
    }, 'warn');
  }

  // Master: einen Slave, den DVhub in diesem Takt nicht führt, auf Stopp setzen und das bestätigen. Der Slave folgt dem
  // Master-Modus (Feld #5, nie ein Modus-Write am Slave); sein Befehl 13051/13052 wirkt, solange der Master im
  // Steuermodus steht, und ruht in Modus 0.
  //   kind 'adopt' (H-9, Codex 2a0f18b5 P2): der Master steht schon in einem gefundenen Modus 2 — der Slave-Befehl ist
  //     so unbekannt wie der des Masters. Ein besessener Slave bleibt hier wie bisher unberührt.
  //   kind 'entry' (Christin 21.11.2026): der Master tritt aus Modus 0 in den Steuermodus ein (auch der Wiedereintritt
  //     nach einem geräteeigenen Rückfall). Ein alter Befehl (anderes System, App, früherer Lauf) liefe sonst
  //     unbeaufsichtigt neben dem vollen Master-Anteil. Vertrag v6: A.8 I-SafePrefix („Eintritt: Leistung und Befehl
  //     vor dem Modus" — im Verbund auch die des Folgegeräts), VÄ-11 (die Master-Leistung muss für jeden noch möglichen
  //     Slave-Zustand sicher sein), H-9 (nie einen unbekannten Gerätewert blind fortführen). Nicht besessen →
  //     stopUnowned (nur 13051 = 0xCC, zurückgelesen); besessen (DVhubs eigener Befehl) → einmal zurücknehmen, aber nicht
  //     ein zweites Mal im selben Takt, wenn der Pfad es schon versucht hat (Fable P3-4).
  //   kind 'running' (Fable P2-1): der Master steht in DVhubs Steuermodus, der Slave wird in diesem Takt nicht (mehr)
  //     geführt (Werte weg, Richtung mit „nur Master", Strategie umgestellt, Slave-Fehler) und ist nicht besessen. Ist
  //     sein Stopp seit der letzten eigenen Rücknahme/Prüfung nicht bestätigt (etwa nach dem Eintritt bei Notladung mit
  //     führender Strategie, nach einem Neustart), wird er jetzt gestoppt; ohne Bestätigung tritt der Master zurück
  //     (Modus 0), bis der Stopp bestätigt ist. Ein besessener Slave bleibt beim Pfad (neutralize, C6: kein Modus 0).
  // Nicht bestätigt → in diesem Takt nicht übernehmen/eintreten bzw. zurücktreten (Fehler; ein späterer Takt versucht es
  // neu — nach einem Fehlschlag mit Gerätezugriff frühestens nach dem ruhigen Profil-Takt, Fable P3-2). Ein Slave in
  // Notladung wird nie kommandiert (S-36): dann wartet es, bis die Notladung vorbei ist und der Stopp möglich wird (Codex
  // c5502afe P2); im laufenden Betrieb tritt der Master deshalb nicht zurück. Im Not-Halt kein Eintritt und kein Write.
  // Auch bei einem fremd gesteuerten Slave der ruhige Profil-Takt (Review 4cf0a9e4 P3): endet die Fremdsteuerung, wird
  // ein stehengebliebener Befehl so binnen eines Takts gestoppt, nicht erst nach deviceRecheckMs.
  function slaveRecheckMs() {
    const o = resolveSungrowEmsOptions(sungrowEmsConf(getCfg()) || {});
    return Math.max(10000, Number(o.deviceRecheckMs) || 60000);
  }
  function slaveCheckRetryMs() {
    const o = resolveSungrowEmsOptions(sungrowEmsConf(getCfg()) || {});
    return Math.max(5000, Number(o.regulateEveryMs) || 10000);
  }
  async function stopSlaveBeforeTakeover(kind = 'adopt', modeValue = EMS_MODE.FORCED, t = now()) {
    const adopt = kind === 'adopt';
    const running = kind === 'running';
    if (isSlave || !slaveActuator) return;
    if (adopt && slaveActuator.ownsControl?.() === true) { endMasterAlone(); return; } // DVhubs eigener Befehl (A7)
    // Ohne zweiten WR gibt es keinen Slave: der immer angelegte Slave-Aktuator (schedule-eval.js) fiele sonst auf die
    // Master-Verbindung zurück.
    if (!resolveSecondInverter(getCfg()).enabled) return;
    const owned = slaveActuator.ownsControl?.() === true;
    if (owned) st.slaveForeignNotified = false; // ein fremd gesteuerter Slave ist nie besessen (foreignModeError)
    // Zeitgeber der Prüfungen (Nachprüfung, Drossel nach Fehlschlag) monoton wie die Frist (Review 590b056a P3): sonst
    // setzten sie nach einem Rücksprung der Wanduhr aus, während die Frist weiterläuft — „allein" ohne echte Prüfung.
    const mt = monoNow();
    // Nachprüfung im Betrieb (Fable 2 P3): ein bestätigter Stopp wird im Lesetakt des Masters (deviceRecheckMs) neu am
    // Gerät geprüft — sonst liefe ein später per App gesetzter Befehl unbemerkt neben dem vollen Master-Anteil. Nur
    // lesen (13000 + 13050–13052); steht ein Befehl an, gelten die Stopp-Regeln wie beim Eintritt. Nicht lesbar →
    // der Master steuert weiter (der zuletzt bekannte Zustand ist Stopp), nächster Versuch nach demselben Takt.
    let recheck = false;
    if (running) {
      if (owned) { endMasterAlone(); return; } // DVhubs eigener Befehl — kein „Slave unbestätigt" (A7)
      if (slaveActuator.stopConfirmed?.() === true) {
        // A7 (Fable P3-4): ein bestätigter Stopp beendet „allein" — auch wenn die Nachprüfung fällig ist und der Slave
        // dabei nicht lesbar ist (dann gilt der zuletzt bekannte Zustand Stopp).
        endMasterAlone();
        const last = Math.max(Number(slaveActuator.stopConfirmedAt?.()) || 0, st.slaveRecheckAt || 0);
        if (mt - last < slaveRecheckMs()) return;
        recheck = true;
        st.slaveRecheckAt = mt;
      }
    }
    // A7: regelt der Master schon allein, den nicht erreichbaren Slave nur im Lesetakt (deviceRecheckMs) neu versuchen,
    // nicht im Profiltakt — ein hängender Slave (Zeitüberschreitung mit Wiederholung) bremste sonst den Regeltakt.
    const retryMs = st.masterAlone.active ? slaveRecheckMs() : slaveCheckRetryMs();
    const throttled = !adopt && !recheck && st.slaveCheck.failedAt > 0 && mt - st.slaveCheck.failedAt < retryMs;
    let ss;
    if (!adopt && state.ctrl?.discretionaryWritesPaused) {
      ss = { ok: false, blocked: true, error: 'emergency_stop_active' };
    } else if (!adopt && owned && st.slaveNeutralizeTick === t) {
      ss = { ok: false, error: 'slave_not_released' }; // die Rücknahme dieses Takts scheiterte schon (P3-4)
    } else if (!(!adopt && owned) && isSungrowEmergencyCharge(state.sungrowSecond?.runningState)) {
      ss = { ok: false, emergency: true, error: 'slave_emergency_charge' };
    } else if (throttled) {
      ss = { ok: false, error: st.slaveCheck.error, throttled: true, foreign: st.slaveCheck.foreign === true };
    } else if (!adopt && owned) {
      const nr = await slaveActuator.neutralize('master_entry');
      ss = slaveActuator.ownsControl?.() === true ? { ok: false, error: nr?.error || nr?.reason || 'slave_not_released' } : { ok: true };
    } else {
      ss = await slaveActuator.stopUnowned(adopt ? 'master_adopted' : (running ? 'master_running' : 'master_entry'));
    }
    // Nachprüfung, Slave nicht lesbar: Zustand unverändert annehmen (zuletzt Stopp), kein Rücktritt.
    if (recheck && ss?.ok !== true && !ss?.blocked && !ss?.foreign && !ss?.emergency && ss?.stage !== 'write') return;
    // Drossel nur nach einem Fehlschlag mit Gerätezugriff auf die RW-Register (nicht bei Notladung — 13000 ist ein
    // Eingangsregister — und nicht im Not-Halt).
    if (!adopt && !ss?.throttled) {
      st.slaveCheck = ss?.ok === true || ss?.emergency === true || ss?.blocked ? { failedAt: 0, error: null } : { failedAt: mt, error: ss?.error || 'unbekannt', foreign: ss?.foreign === true };
      // Lage „fremd gesteuert" endet mit jedem anderen Ergebnis einer echten Prüfung (nicht im Not-Halt).
      if (ss?.foreign !== true && !ss?.blocked) st.slaveForeignNotified = false;
    }
    if (ss?.ok === true) { endMasterAlone(); return; }
    // Notladung, fremdes EMS: kein „Slave unbestätigt" im Sinn der Frist (A7). In der Wartephase beginnt sie danach neu;
    // regelt der Master schon allein, bleibt er es (Fable P3-1: sonst kostete jedes Ende einer Notladung einen Rücktritt,
    // zwei 13050-Writes und neue Wartezeit, obwohl der Slave durchgehend unbestätigt ist). Not-Halt beendet beides.
    // H-9-Übernahme (A12): Notladung wie oben; ein fremdes EMS zählt dort weiter als „unbestätigt" (bisher wartete die
    // Übernahme dann endlos — jetzt bis zur Frist).
    if (ss?.emergency === true || (!adopt && ss?.foreign === true)) {
      if (!st.masterAlone.active) endMasterAlone();
      // Notladung: weiter allein, im Status sichtbar (Review 0abbb847 P3). Fremdes EMS: die Lage bleibt (kein Rücktritt
      // danach), der Status zeigt aber kein „Slave unbestätigt" — der Slave antwortet, gemeldet wird sungrow_ems_slave_foreign
      // (Review 1b28e47c P3).
      else if (ss?.emergency === true) st.masterAlone.at = t;
    }
    if (ss?.blocked) endMasterAlone();
    if (running && ss?.emergency === true) return; // Notladung: kein Write, kein Rücktritt; nach der Notladung stoppen
    // Ein fremdes EMS (VPP) am Slave (Review 156a3e06 P3): DVhub fasst ihn nicht an (S-38), und ein Rücktritt des
    // Masters brächte ihn nicht zur Ruhe — der Master steuert wie bisher allein („nur Master"), gemeldet einmal je Lage.
    if (!adopt && ss?.foreign === true) {
      // Eigener Merker statt logOnce: st.logKeys leert jeder Master-Write, die Meldung käme sonst bei jeder Prüfung.
      if (!st.slaveForeignNotified) {
        st.slaveForeignNotified = true;
        pushLog('sungrow_ems_slave_foreign', { error: ss.error || null, text: 'Sungrow: Slave steht unter einem fremden EMS — DVhub fasst ihn nicht an und steuert den Master allein.' }, 'warn');
      }
      return;
    }
    // A7 (Christin 21.11.2026, Option b): Slave unbestätigt (nicht erreichbar, Rücklesung scheitert) — nach der Frist
    // tritt der Master trotzdem ein bzw. bleibt eingetreten und regelt allein (ein alter Slave-Befehl kann mitlaufen).
    // A12 (Christin 21.11.2026, a): ebenso die H-9-Übernahme eines gefundenen Modus 2 (DVhubs eigener Befehl am Master).
    // Nicht in Notladung (oben: wartet), nicht im Not-Halt.
    if (!ss?.blocked && ss?.emergency !== true && masterAloneDue(t)) {
      grantMasterAlone(kind, ss, t);
      return;
    }
    const what = adopt ? 'Übernahme des Modus 2 zurückgestellt' : (running ? `Rücktritt aus Modus ${modeValue}` : `Eintritt in Modus ${modeValue} zurückgestellt`);
    const err = new Error(`${what}: Slave nicht auf Stopp bestätigt (${ss?.error || 'unbekannt'})`);
    err.code = ss?.blocked ? 'emergency_stop_active' : (adopt ? 'adopt_slave_unconfirmed' : (running ? 'running_slave_unconfirmed' : 'entry_slave_unconfirmed'));
    err.slaveEmergency = ss?.emergency === true;
    throw err;
  }

  // Warten vor dem Eintritt (stopSlaveBeforeTakeover 'entry', nach einem Rücktritt auch 'running'): am Master steht
  // Modus 0. Keine Split-Rücknahme, Ziel und Besitz bleiben — ein späterer Takt prüft den Slave neu und tritt dann ein.
  // Der Gerätezustand des Masters bleibt im gewöhnlichen Lesetakt (deviceRecheckMs), nicht in jedem Takt (Fable P3-2).
  // Sichtbar im Status (sungrowEms.decision.reason = 'entry_slave_unconfirmed', decision.since, error) und als Warnung
  // beim ersten Mal, bei geändertem Grund und danach alle 15 min, solange es wartet (Fable P2-2).
  const ENTRY_DEFERRED_LOG_REPEAT_MS = 15 * 60 * 1000;
  const ENTRY_DEFERRED_EPISODE_GAP_MS = 5 * 60 * 1000;

  // Frist „Master allein" (A7, Christin 21.11.2026, Option b). Sie läuft ab dem ersten „Slave unbestätigt" (Eintritt
  // zurückgestellt bzw. Rücktritt), gemessen mit der monotonen Uhr (Fable P3-2).
  //   Wartephase: eine Lage, solange das Ergebnis alle paar Minuten wieder „unbestätigt" ist. Lücke > 5 min, Notladung,
  //     fremdes EMS → die Frist beginnt neu.
  //   Alleinbetrieb (Fable P3-1): bleibt, solange der Slave unbestätigt ist — auch nach einer Notladung, einem fremden
  //     EMS und Prüfpausen (Master-Lesefehler, ausstehende Freigabe, Modus 0 ohne Sollwert).
  // Beide enden, wenn der Stopp bestätigt ist, DVhub den Slave führt oder er DVhubs Befehl hält, im Not-Halt und beim
  // Wechsel der Master- oder Slave-Verbindung; danach beginnt die Frist neu. Nur im Speicher (Neustart: neu).
  function endMasterAlone() {
    const a = st.masterAlone;
    if (a.since != null || a.active) st.masterAlone = masterAloneIdle();
  }
  function masterAloneDue(t) {
    const m = monoNow();
    const key = endpointKeyOf(resolveSecondInverter(getCfg()));
    const a0 = st.masterAlone;
    const fresh = a0.since == null || a0.slaveKey !== key || (!a0.active && m - a0.lastAt > ENTRY_DEFERRED_EPISODE_GAP_MS);
    if (fresh) st.masterAlone = { ...masterAloneIdle(), since: m, sinceWall: t, slaveKey: key };
    const a = st.masterAlone;
    a.lastAt = m;
    return a.active || m - a.since >= sungrowMasterAloneAfterMs(getCfg());
  }
  // Frist abgelaufen: der Master regelt in diesem Takt allein. Warnung beim Wechsel und dann alle 15 min; im Status
  // als sungrowEms.decision.masterAlone (statusDecision), solange die Entscheidung aus einem solchen Takt stammt.
  function grantMasterAlone(kind, ss, t) {
    const m = monoNow();
    const a = st.masterAlone;
    const first = !a.active;
    if (first) { a.aloneSince = m; a.aloneSinceWall = t; }
    a.active = true;
    a.at = t;
    a.error = ss?.error || 'unbekannt';
    if (!first && m - a.logAt < ENTRY_DEFERRED_LOG_REPEAT_MS) return;
    a.logAt = m;
    const afterMin = Math.round(sungrowMasterAloneAfterMs(getCfg()) / 60000);
    const waitedMin = Math.round((m - a.since) / 60000);
    pushLog('sungrow_ems_master_alone_slave_unconfirmed', {
      error: a.error, kind, since: a.sinceWall, aloneSince: a.aloneSinceWall, waitedS: Math.round((m - a.since) / 1000), afterMin,
      text: `Sungrow: Slave seit ${waitedMin} min nicht auf Stopp bestätigt (nicht erreichbar oder Rücklesung scheitert). ${afterMin > 0 ? `Die Frist von ${afterMin} min ist abgelaufen` : 'Frist 0 (sofort)'} — der Master regelt allein. Ein alter Befehl am Slave kann mitlaufen. DVhub prüft den Slave weiter und stoppt einen solchen Befehl, sobald er antwortet.`,
    }, 'warn');
  }
  function statusDecision() {
    const d = st.decision;
    const a = st.masterAlone;
    if (isSlave || !d || !a.active || a.at !== d.at || d.mode === 'self') return d;
    return { ...d, masterAlone: { reason: 'slave_unconfirmed', since: a.aloneSinceWall, slaveUnconfirmedSince: a.sinceWall, afterMin: Math.round(sungrowMasterAloneAfterMs(getCfg()) / 60000), error: a.error } };
  }

  // adopt (Codex 22d327d3 P3): wartende H-9-Übernahme eines gefundenen Modus 2 — eigener Zustand 'adopt_wait' (der
  // vorgefundene Befehl des Masters läuft bis zur Übernahme weiter), mit Zeitpunkt masterAloneAt und eigener Warnung.
  function entryDeferred(e, t, { stepBack = false, foundMode = null, adopt = false } = {}) {
    // Der Wiedereintritts-Zähler (B3, stepForced) zählt den Takt vor dem Write. Ein zurückgestellter Eintritt schreibt
    // 13050 nicht — er darf nicht zählen, sonst sperrte eine längere Wartezeit (Notladung) den Wiedereintritt eine Stunde.
    const re = st.forcedReentryTimes;
    if (Array.isArray(re) && re.length > 0 && re[re.length - 1] === t) st.forcedReentryTimes = re.slice(0, -1);
    st.reentryLogPending = null;
    st.error = e?.message || String(e);
    const w = st.entryDeferred;
    if (!w.since || t - (w.lastAt || 0) > ENTRY_DEFERRED_EPISODE_GAP_MS) { w.since = t; w.logKey = null; w.logAt = 0; }
    w.lastAt = t;
    // A7: wann der Master allein regelt, wenn der Slave unbestätigt bleibt (in Notladung nie → null). Restzeit monoton
    // gemessen, angezeigt in Wanduhrzeit (Fable P3-2).
    const aloneAfterMs = sungrowMasterAloneAfterMs(getCfg());
    const a = st.masterAlone;
    const masterAloneAt = e?.slaveEmergency !== true && a.since != null ? t + Math.max(0, aloneAfterMs - (monoNow() - a.since)) : null;
    st.decision = adopt
      ? { mode: 'adopt_wait', reason: 'adopt_slave_unconfirmed', at: t, since: w.since, masterAloneAt }
      : { mode: 'self', reason: 'entry_slave_unconfirmed', at: t, since: w.since, masterAloneAt };
    const event = adopt ? 'sungrow_ems_adopt_deferred' : (stepBack ? 'sungrow_ems_slave_unconfirmed_stepback' : 'sungrow_ems_entry_deferred');
    const key = `${event}|${st.error}`;
    if (w.logKey !== key || t - w.logAt >= ENTRY_DEFERRED_LOG_REPEAT_MS) {
      w.logKey = key; w.logAt = t;
      const aloneMin = Math.round(aloneAfterMs / 60000);
      pushLog(event, {
        error: st.error, slaveEmergency: e?.slaveEmergency === true, since: w.since, waitingS: Math.round((t - w.since) / 1000), masterAloneAt,
        ...(foundMode != null ? { foundMode } : {}),
        text: adopt
          ? `Sungrow: Übernahme des gefundenen Modus 2 zurückgestellt — der Slave ist nicht auf Stopp bestätigt${e?.slaveEmergency === true ? ' (Notladung)' : ''}. Der vorgefundene Befehl des Masters läuft bis dahin weiter; ${e?.slaveEmergency === true ? 'DVhub übernimmt nach der Notladung.' : `ohne Bestätigung übernimmt DVhub nach ${aloneMin} min Wartezeit mit eigenem Befehl und regelt allein.`}`
          : stepBack && foundMode != null
          ? `Sungrow: Eintritt zurückgestellt — der Master stand in Modus ${foundMode}; DVhub hat ihn mit bekannten Writes in Modus 0 gesetzt (Befehl Stopp), damit kein unbekannter Befehl weiterläuft. Der Slave ist nicht auf Stopp bestätigt${e?.slaveEmergency === true ? ' (Notladung); DVhub tritt nach der Notladung ein.' : `; DVhub tritt ein, sobald der Stopp bestätigt ist, spätestens nach ${aloneMin} min Wartezeit (dann regelt der Master allein).`}`
          : stepBack
          ? `Sungrow: Master zurück in Modus 0 — der Slave wird nicht geführt und sein Befehl ist nicht auf Stopp bestätigt. DVhub tritt wieder ein, sobald der Stopp bestätigt ist, spätestens nach ${aloneMin} min Wartezeit (dann regelt der Master allein).`
          : (e?.slaveEmergency === true
            ? 'Sungrow: Eintritt zurückgestellt — der Slave ist in Notladung und wird danach nicht geführt; sein Befehl würde mit dem Eintritt wieder wirken. Master bleibt in Modus 0, DVhub tritt nach der Notladung ein.'
            : `Sungrow: Eintritt zurückgestellt — der Slave ist nicht auf Stopp bestätigt; ein alter Befehl würde mit dem Eintritt wieder wirken. Master bleibt in Modus 0, DVhub versucht es weiter. Ohne Bestätigung regelt der Master nach ${aloneMin} min Wartezeit allein.`),
      }, 'warn');
    }
    publish();
    return { ok: false, deferred: true, error: st.error };
  }

  // Rücktritt (Fable P2-1): der Master steht in DVhubs Steuermodus, der nicht geführte Slave lässt sich nicht auf Stopp
  // bestätigen → Master zurück in Modus 0 (0xCC + Modus 0, bekannte Writes), damit der Slave-Befehl ruht. Ziel bleibt;
  // danach gilt der Eintritt mit seiner Prüfung. Im Not-Halt schreibt das nicht (submitReg sperrt), der Durchgang nimmt
  // den eigenen Betrieb zurück.
  async function stepBackForSlave(conf, ctl, e, t, { foundMode = null } = {}) {
    st.splitLast = null;
    st.externalEnteredAt = 0;
    try {
      st.dev = null;
      await writeDecision(conf, { mode: 'self', reason: 'slave_unconfirmed' }, { modeValue: ctl.modeValue });
    } catch (we) {
      st.dev = null;
      if (we?.code === 'emergency_stop_active') { publish(); return { ok: false, blocked: true, error: 'emergency_stop_active' }; }
      st.error = we?.message || String(we);
      logOnce(st.error, 'sungrow_ems_error', { error: st.error, decision: { mode: 'self', reason: 'slave_unconfirmed' } }, 'warn');
      publish();
      return { ok: false, error: st.error };
    }
    return entryDeferred(e, t, { stepBack: true, foundMode });
  }

  // Zurückgestellter Eintritt (Codex-Review bb03fb53..181b0157 P1, 21.11.2026; A2): steht der Master dabei nicht in
  // Modus 0 — bei External-Steuerung ein gefundener Modus 2, dessen Befehl ohne geräteeigenen Rückfall weiterläuft —,
  // erst mit bekannten Writes verlassen (0xCC + Modus 0, wie der Rücktritt), dann warten. Vorher lief der gefundene
  // Befehl während des Wartens unbegrenzt weiter, und der Status meldete 'self'. Im Not-Halt schreibt das nicht.
  async function deferEntry(conf, ctl, e, t, modeSeen) {
    if (modeSeen != null && modeSeen !== EMS_MODE.SELF) return await stepBackForSlave(conf, ctl, e, t, { foundMode: modeSeen });
    return entryDeferred(e, t);
  }

  function publish() {
    if (!state.ctrl) return;
    const ctl = resolveSungrowControl(getCfg());
    state.ctrl[statusKey] = {
      controlMode: ctl.mode,
      heartbeatTimeoutS: ctl.heartbeatTimeoutS,
      heartbeatSupported: st.hb.supported,
      heartbeatWriteFc: ctl.heartbeatWriteFc,          // feste FC (config) oder null = Auto
      heartbeatWorkingFc: st.hb.workingFc,             // je Verbindung ermittelte funktionierende FC
      heartbeatDeviceManaged: st.hb.deviceManaged === true, // Opt-in: WR verwaltet 13080 selbst
      heartbeatSentS: st.sentTimeoutS ?? null,         // zuletzt wirksame Frist (unser Wert oder Gerätewert)
      keepaliveRegister: ctl.keepaliveRegister,        // Lebenszeichen-Register (13080/13052/both)
      deviceFallbackAfterS: st.lastFallbackAfterS || null, // gemessene Zeit, nach der der WR von selbst zurückfiel
      deviceFallbackCount60s: (st.fallbackTimes || []).filter((x) => now() - x < 60000).length, // Rückfälle letzte 60 s
      lastHeartbeatAt: st.lastHeartbeatAt || null,
      // Punkt 2: adaptiver Regeltakt + gemessene Antwortzeit + Tages-Schreibzähler je Register (13050 mit Budget).
      // N3 (Feld 19.11.): Der Slave hat keinen eigenen Regeltakt — tick()/applySetpoint laufen nur am Master, der
      // Slave wird in jeder Master-Runde mitgeführt (stepSplit → applyDirectCommand). Er meldet darum den Takt, in
      // dem der Master ihn führt, nicht seinen eigenen Rechenwert (der taktete nichts; Feld: API 5000 ms).
      regulateEveryMs: isSlave ? st.drivenRegulateMs : adaptiveRegulateMs(getCfg()),
      regulateFollowsMaster: isSlave,
      // N5/M7b: gewählter Takt (0 = Auto) + Modbus-Gesundheit dieser Verbindung. responseMs = der Median aus der
      // Gesundheit (EINE „Antwort"-Zahl; der Regelzyklus steht separat in regulateEveryMs), kein eingefrorener Wert.
      regulateConfiguredMs: configuredRegulateMs(getCfg()),
      health: modbusHealthInst.snapshot(),
      responseMs: modbusHealthInst.responseMs() ?? st.responseMs,
      writesToday: { mode13050: writeDayBucket().regs[EMS_MODE_ADDR] || 0, cmd13051: st.writeDay.regs[EMS_CMD_ADDR] || 0, power13052: st.writeDay.regs[EMS_POWER_ADDR] || 0, heartbeat13080: st.writeDay.regs[HEARTBEAT_ADDR] || 0 },
      modeBudgetLeft: modeBudgetLeft(),
      // M24: wirksamer Puffer über der Geräte-Untergrenze (Leitstand: „Minimum-SoC 10 % (Gerät)" bei 0).
      socFloorBufferPct: sungrowSocFloorBufferPct(getCfg()),
      target: st.target ? { setpointW: st.target.setpointW, source: st.target.source, at: st.target.at, noGridCharge: st.target.noGridCharge === true } : null,
      device: st.dev ? { ...st.dev } : null,
      decision: statusDecision(),
      owns: st.owns,
      ownMode: st.ownMode,
      error: st.error,
      // Option A: nur, wenn eine Freigabe aussteht oder die letzte Anfrage etwas zu melden hat (sonst fehlt das Feld).
      ...releaseStatus()
    };
  }
  // requestedAt bindet jeden Hinweis an seine Anfrage (Codex d6f4b256 P2): die Kachel zeigt nie das Ergebnis einer
  // älteren Anfrage über dem der jüngsten.
  function releaseStatus() {
    const r = st.release;
    if (r) {
      // Codex 6f356cb8: fällt der Schreibweg weg (Profil ungültig, kein Sungrow-EMS), kann der Takt nicht wiederholen —
      // dann nicht „wird wiederholt" melden, sondern „nicht gesendet" mit Grund; die Freigabe bleibt als Auftrag stehen.
      const cfg = getCfg();
      const noPath = !sungrowEmsConf(cfg) || transport?.type !== 'modbus';
      return { release: {
        pending: true, requestedAt: r.requestedAt ?? null, since: r.since, attempts: r.attempts, retryAt: r.nextAt || null, lastError: r.lastError,
        ...(noPath ? { sent: false, error: noWritePathError(cfg) } : {}),
        text: noPath ? 'Freigabe steht aus, nicht gesendet — kein Schreibweg' : 'Freigabe gescheitert, wird wiederholt',
      } };
    }
    const i = st.releaseInfo;
    if (!i) return {};
    if (i.state === 'done') {
      return { release: { pending: false, done: true, requestedAt: i.requestedAt ?? null, doneAt: i.at, attempts: i.attempts, via: i.via, text: 'Freigabe erledigt' } };
    }
    if (i.state === 'abandoned') {
      return { release: { pending: false, abandoned: true, requestedAt: i.requestedAt ?? null, at: i.at, attempts: i.attempts, reason: i.reason, mode: i.mode, text: 'Freigabe verworfen — DVhub überschreibt kein anderes System' } };
    }
    return { release: { pending: false, failed: true, requestedAt: i.requestedAt ?? null, at: i.at, ...(i.sent === false ? { sent: false } : {}), error: i.error, text: i.sent === false ? 'Freigabe nicht gesendet — kein Schreibweg' : 'Freigabe gescheitert' } };
  }

  // connOverride: zweite (Slave-)Instanz schreibt an eine andere Verbindung als die victron.*-Hauptverbindung;
  // als Funktion ausgewertet (Host/Port/Unit-ID kommen aus der Config und können sich ändern).
  const resolveOverride = () => (typeof connOverride === 'function' ? connOverride() : connOverride);
  function endpoint(conf) {
    const o = resolveOverride();
    if (o && o.host) {
      return { host: o.host, port: Number(o.port) || 502, unitId: Number.isFinite(Number(o.unitId)) ? Number(o.unitId) : 1, timeoutMs: o.timeoutMs || conf.timeoutMs };
    }
    return { host: conf.host, port: conf.port, unitId: conf.unitId, timeoutMs: conf.timeoutMs };
  }
  const overrideKey = () => { const o = resolveOverride(); return o && o.host ? `${o.host}:${Number(o.port) || 502}:${Number.isFinite(Number(o.unitId)) ? Number(o.unitId) : 1}` : null; };

  // Verbindung gewechselt (andere Adresse/Port/Unit-ID): alles Gemerkte gehört zum alten Gerät.
  function syncEndpoint(cfg) {
    const key = overrideKey() || endpointKeyOf(cfg?.victron);
    if (st.endpointKey === key) return;
    if (st.endpointKey != null && (st.owns || st.target)) {
      pushLog('sungrow_ems_endpoint_changed', { from: st.endpointKey, to: key, ownedForced: st.owns }, st.owns ? 'warn' : undefined);
    }
    st.endpointKey = key;
    st.target = null;
    st.dev = null;
    setStopConfirmed(false); // gilt dem alten Gerät
    st.slaveCheck = { failedAt: 0, error: null };
    st.masterAlone = masterAloneIdle(); // A7: die Frist galt dem alten Gerät
    st.hb = { key: null, supported: null };
    st.release = null; // eine ausstehende Freigabe galt dem alten Gerät
    setOwns(null);
  }

  // Kontroll-Register 13050–13052 lesen (vor/nach eigenen Writes). Reines LESEN: schlägt es fehl, wurde nichts
  // geschrieben → eigener Fehlercode 'ems_read_error' (der Aufrufer meldet das als sungrow_ems_read_error, nicht
  // als control_write_error). N2 (Feld 15.11.): ein transienter Lesefehler („modbus exception 4", ECONNRESET ODER
  // „modbus timeout"/ETIMEDOUT — im 1-s-Dauer-Forced ~1 auf 4000 Slave-Anfragen) darf die Anlage nicht auf Modus 0
  // werfen. Deshalb bis zu 2× wiederholen (je 250 ms) statt sofort zu scheitern; erst danach ems_read_error (der
  // Aufrufer faellt dann auf Master-only zurueck, C6). Häufen sich die Resets, steht womöglich ein anderer Modbus-
  // Client auf dem Gerät (WiNet-S erlaubt nur einen) — einmaliger Hinweis.
  const EMS_READ_RETRIES = 2; // Wiederholungen (⇒ bis zu 3 Versuche)
  async function readDevice(conf) {
    let lastErr = null;
    for (let attempt = 0; attempt <= EMS_READ_RETRIES; attempt += 1) {
      try {
        const regs = await transport.mbRequest({ ...endpoint(conf), fc: 3, address: EMS_BLOCK_ADDRESS, quantity: 3 });
        if (!Array.isArray(regs) || regs.length < 3) throw new Error('EMS-Register: unvollständige Antwort');
        st.dev = { mode: Number(regs[0]) & 0xffff, cmd: Number(regs[1]) & 0xffff, powerW: Number(regs[2]) & 0xffff, at: now() };
        st.readResetStreak = 0;
        return st.dev;
      } catch (e) {
        lastErr = e;
        const retryable = /modbus exception 4\b|ECONNRESET|modbus timeout|ETIMEDOUT/i.test(String(e?.message));
        if (attempt < EMS_READ_RETRIES && retryable) {
          st.readResetStreak = (st.readResetStreak || 0) + 1;
          if (st.readResetStreak >= 3) {
            logOnce('reset-hint', 'sungrow_ems_read_reset_streak', {
              streak: st.readResetStreak,
              text: 'Mehrfach abgebrochene Modbus-Lesevorgänge am Sungrow — steht ein anderer Modbus-Client auf dem Gerät? (WiNet-S/Logger erlaubt meist nur einen.)'
            }, 'warn');
          }
          await sleep(250);
          continue;
        }
        break;
      }
    }
    const err = new Error(`EMS-Register (13050–13052) lesen fehlgeschlagen: ${lastErr?.message || lastErr}`);
    err.code = 'ems_read_error';
    throw err;
  }

  // Betriebszustand (Doku 13000, FC4, Eingangsregister) lesen — mit derselben Wiederholung wie readDevice (Fable 2 P3).
  async function readRunningState(conf) {
    let lastErr = null;
    for (let attempt = 0; attempt <= EMS_READ_RETRIES; attempt += 1) {
      try {
        const rs = await transport.mbRequest({ ...endpoint(conf), fc: 4, address: wire(13000), quantity: 1 });
        if (!Array.isArray(rs) || rs.length < 1) throw new Error('Betriebszustand 13000: unvollständige Antwort');
        return Number(rs[0]) & 0xffff;
      } catch (e) {
        lastErr = e;
        const retryable = /modbus exception 4\b|ECONNRESET|modbus timeout|ETIMEDOUT/i.test(String(e?.message));
        if (attempt < EMS_READ_RETRIES && retryable) { await sleep(250); continue; }
        break;
      }
    }
    const err = new Error(`Betriebszustand 13000 lesen fehlgeschlagen: ${lastErr?.message || lastErr}`);
    err.code = 'ems_read_error';
    throw err;
  }

  // Herzschlag-Register vorhanden? Einmal je Verbindung lesen. Exception 1/2 oder 0xFFFF (Doku: nicht
  // vorhandenes U16) = Firmware zu alt. Andere Lesefehler entscheiden nichts (nächster Takt).
  async function heartbeatSupported(conf) {
    if (st.hb.key === st.endpointKey && st.hb.supported != null) return st.hb.supported;
    let supported;
    try {
      // Feld #3: 13080 IMMER mit Menge 2 lesen — mit Menge 1 liefert der WR einen falschen Festwert (am
      // SH10RT-20: 600), erst ab Menge 2 den echten Wert (zweites Wort 0xFFFF). Wert = regs[0].
      const regs = await transport.mbRequest({ ...endpoint(conf), fc: 3, address: HEARTBEAT_ADDR, quantity: 2 });
      supported = Array.isArray(regs) && regs.length >= 1 && (Number(regs[0]) & 0xffff) !== 0xffff;
    } catch (e) {
      if (!/^modbus exception (1|2)\b/.test(String(e?.message))) throw e;
      supported = false;
    }
    st.hb = { key: st.endpointKey, supported };
    if (!supported) {
      pushLog('sungrow_ems_heartbeat_unsupported', {
        text: 'Sungrow kennt das Herzschlag-Register 13080 nicht (Firmware zu alt) — External EMS nicht möglich, DVhub steuert den Akku nicht. Firmware aktualisieren oder bewusst „Forced mode“ wählen.'
      }, 'warn');
    }
    return supported;
  }

  // Ein Register schreiben — über das Schreibtor (VCL-Vertrag v6 D.1/D.2, Legacy-Modus, Pfad 6). Der Draht-Aufruf ist
  // derselbe wie bisher (Argument-Objekt, FC); das Tor prüft davor seine acht Vorprüfungen. Die Bestandsprüfungen
  // (C2, Not-Halt) bleiben in dieser Phase VOR dem Tor und entscheiden wie heute; das Tor bekommt die passende
  // Aktionsklasse, damit es nie anders entscheidet:
  //   neutralize        → haltNeutralize      (Rücknahme 13051=0xCC / 13050=0; der Not-Halt-Durchgang)
  //   manualRelease     → manualForceRelease  (Knopf/API, H-7 — mit Bestätigungsmarke; auch im Not-Halt)
  //   keepalive         → keepalive           (Herzschlag 13080, Leistungs-Lebenszeichen 13052)
  //   sonst             → command
  // Not-Halt vor JEDEM Write prüfen: ein Takt, der vor dem Eintritt begann, darf danach nichts mehr setzen.
  // Nur die eine Rücknahme (neutralize) darf im Not-Halt schreiben.
  let gateSeq = 0;
  async function submitReg(conf, address, value, { neutralize = false, claimMode = null, fc = 6, keepalive = false, manualRelease = null } = {}) {
    // C2 (Christin 16.11.2026): ungültige Konfiguration (kaputtes/fehlendes Herstellerprofil oder kaputte config.json →
    // cfg.writeSafety.ok === false) sperrt die Aktuator-Writes. Lauter Alarm einmal je Grund, dann KEIN Write.
    // Ausnahme (Christin 19.11.2026, „denke schon“): die Not-Halt-Rücknahme (neutralize IM Not-Halt → haltNeutralize)
    // und die manuelle Zwangsfreigabe (H-7, manualForceRelease) — beide nur die festen Literale 13051 = 0xCC und
    // 13050 = 0, nie 13058/13059 (H-8). Nur bei einem Herstellerprofil-Fehler (Torzustand profileInvalid): dann ist die
    // Verbindung die des Betreibers. Eine kaputte config.json (setupIncomplete) sperrt weiter alles — Vorgaben mit
    // leerem Host, ein Write ginge an localhost. Gesperrt bleiben auch die übrigen neutralize-Writes außerhalb des
    // Not-Halts (geordnetes Beenden, Split-Abbruch, Herzschlag-Fehler) — sie sind nicht die Not-Halt-Rücknahme.
    const cfgNow = getCfg();
    const ws = cfgNow?.writeSafety;
    const manual = typeof manualRelease === 'string' && manualRelease.length > 0;
    // Schreibfreigabe des Tors aus DERSELBEN Quelle, vor jeder Einreichung neu gesetzt — Tor und Bestandsprüfung
    // können so nicht auseinanderlaufen (R-T2/R-T5). Die Geräte-Erkennung bleibt in dieser Phase beim Aufrufer
    // (deviceGate in step()): als Torzustand `notIdentified` sperrte sie auch die heutigen Rücknahmen, die manuelle
    // Freigabe und jeden Slave-Write (der Slave wird nicht eigens erkannt) — eine Verhaltensänderung.
    gate.setRelease(gateDevice, inverterReleaseState(cfgNow));
    if (ws && ws.ok === false) {
      const haltPass = neutralize === true && state.ctrl?.discretionaryWritesPaused === true;
      if (!(c2AllowsRelease(cfgNow) && (manual || haltPass))) {
        if (st._writeUnsafeAlarm !== (ws.reason || 'config_invalid')) {
          st._writeUnsafeAlarm = ws.reason || 'config_invalid';
          pushLog('sungrow_write_blocked_config_unsafe', { reason: ws.reason || 'config_invalid', manufacturer: ws.manufacturer ?? null }, 'error');
        }
        const err = new Error(`config_unsafe_${ws.reason || 'config_invalid'}`);
        err.code = 'config_unsafe';
        throw err;
      }
    } else if (st._writeUnsafeAlarm) st._writeUnsafeAlarm = null;
    if (state.ctrl?.discretionaryWritesPaused && !neutralize) {
      const err = new Error('emergency_stop_active');
      err.code = 'emergency_stop_active';
      throw err;
    }
    // Besitz erst, wenn der Write wirklich rausgeht (nach dem Not-Halt-Tor), aber VOR der Bestätigung:
    // geht sie verloren, kann der Befehl trotzdem wirken (Codex 28317bd5).
    const ownBeforeClaim = st.owns ? st.ownMode : null;
    if (claimMode != null) setOwns(claimMode);
    // FC 16 (Write Multiple) für Register, die FC 06 (Write Single) nicht annehmen (manche Sungrow-Holding-
    // Register, u. a. 13080 am SH10RT-20): dasselbe Register, ein Wort.
    const word = value & 0xffff;
    const args = fc === 16
      ? { ...endpoint(conf), address, values: [word] }
      : { ...endpoint(conf), address, value: word };
    gateSeq += 1;
    const op = {
      device: gateDevice,
      point: GATE_POINT[address] ?? `reg${address}`,
      value: word,
      source: 'sungrow-ems',
      kind: manual || neutralize ? 'neutralize' : (address === HEARTBEAT_ADDR ? 'heartbeat' : (keepalive ? 'keepalive' : 'write')),
      action: manual ? 'manualForceRelease' : (neutralize ? 'haltNeutralize' : (keepalive ? 'keepalive' : 'command')),
      lease: null,
      constraints: { set: {}, caps: {}, enforcedBy: [] },
      validUntilMs: null,
      tick: { loop: manual ? 'event' : 'eval', seq: gateSeq },
      step: 0,
      ...(manual ? { confirmedBy: manualRelease } : {}),
      legacy: { sink: gateDevice, fn: fc === 16 ? 'mbWriteMultiple' : 'mbWriteSingle', args: [args] },
    };
    try {
      unwrapGate(await gate.submit(op), op, fc);
    } catch (e) {
      // Sicher NICHT gesendet (Lese-Modus — vom Tor oder vom Transport abgewiesen, bevor der Rahmen eingereiht war —
      // oder eine andere Torsperre): ein Besitz, den erst dieser Write beansprucht hat, gilt nicht. Sonst stünde ein
      // Merker für einen Betrieb, den DVhub nie gesetzt hat — mit H-9 etwa für den Modus 2 einer Produktivanlage, an
      // der eine Lese-Instanz mithört; Außen-Wächter und ExecStopPost schrieben darauf. Bei Zeitüberschreitung u. Ä.
      // bleibt der Besitz (der Befehl kann trotzdem wirken, Codex 28317bd5).
      if (claimMode != null && ownBeforeClaim !== claimMode && (e instanceof ReadOnlyViolation || e?.code === 'DVHUB_READ_ONLY' || e?.code === 'gate_blocked')) {
        setOwns(ownBeforeClaim);
      }
      // Register + Wert an den Fehler hängen (Feld-Wunsch 16.11.): split_aborted/Logs sollen
      // nennen, welches Register den Write abgelehnt hat (z. B. Leistung 13052 vs. Befehl 13051).
      if (e && typeof e === 'object') { if (e.emsAddress == null) e.emsAddress = address; if (e.emsValue == null) e.emsValue = value & 0xffff; }
      throw e;
    }
    countWrite(address); // Tages-Schreibzähler je Register (Punkt 2)
  }

  // Ergebnis des Tors wie den heutigen Transport-Aufruf behandeln: Rückgabe bzw. derselbe Fehler (gleiche Referenz) —
  // die Zustellungs-Einordnung des Tors ändert nichts an dem, was der Aktuator sieht. Sperrt das Tor im Lese-Modus,
  // dann wie transport-modbus.js: gleiche Meldung, gleicher Fehlertyp, ein Fehler in der Modbus-Gesundheit (den Write
  // zählte bisher der Transport). Jede andere Sperre ist in dieser Phase ein Verdrahtungsfehler: laut als Fehler.
  function unwrapGate(res, op, fc) {
    if ('error' in res) throw res.error;
    if ('result' in res) return res.result;
    if (res.outcome === 'blocked_readonly') {
      const msg = `Schreibzugriff im Lese-Modus abgelehnt (Modbus fc=${fc})`;
      const err = new ReadOnlyViolation(msg);
      // M22: wie der Transport-Mantel — Fehlerart, Funktion, Register und Wert ins Fehler-Protokoll (Parität alt ↔ Tor).
      modbusHealthInst.record(false, 0, msg, modbusRequestInfo(op.legacy?.fn, op.legacy?.args?.[0], err.code));
      throw err;
    }
    const err = new GateBlockedError(res, op);
    err.code = 'gate_blocked';
    throw err;
  }

  // Tages-Schreibzähler je Register, Reset zur lokalen Mitternacht (Verschleißschutz/Transparenz, Punkt 2).
  function writeDayBucket() {
    const key = new Date(now()).toDateString(); // lokaler Tag → Reset um Mitternacht
    if (st.writeDay.key !== key) st.writeDay = { key, regs: {} };
    return st.writeDay;
  }
  function countWrite(address) {
    const b = writeDayBucket();
    b.regs[address] = (b.regs[address] || 0) + 1;
    // A2: nur den budgetrelevanten Moduswechsel (13050) persistieren — hält das 13050-Budget restart-fest und
    // begrenzt das Datei-I/O auf ≤20/Tag (die häufigen 13052/13080-Writes brauchen keine Persistenz).
    if (writeDayPath && address === EMS_MODE_ADDR) {
      try { atomicWriteControlState(writeDayPath, { key: b.key, regs: b.regs }); }
      catch (e) { logOnce(e?.message || 'x', 'sungrow_ems_writeday_persist_error', { error: e?.message || String(e) }, 'warn'); }
    }
  }
  // Verbleibendes 13050-Tagesbudget (Moduswechsel). ≤ 0 → nicht mehr wechseln (im Modus bleiben, Punkt 2).
  function modeBudgetLeft() {
    return MODE_WRITES_PER_DAY - (writeDayBucket().regs[EMS_MODE_ADDR] || 0);
  }
  // Gleitender Mittelwert der gemessenen Antwortzeit (Schreiben → bestätigtes Rücklesen), für den adaptiven Takt.
  function updateResponseMs(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v < 0) return;
    st.responseMs = st.responseMs == null ? v : Math.round(0.7 * st.responseMs + 0.3 * v);
  }
  // Adaptiver Regeltakt (Punkt 2 / E): fester sungrow.regulateEveryMs hat Vorrang und ist bis 0,25 s wählbar
  // (REGULATE_FIXED_MIN_MS). Auto-Strecken (Christin 15.11.): lässt sich der gewünschte kurze Takt nicht halten —
  // die gemessene Antwortzeit (Lesen+Schreiben beider WR, Round-Trip ~241 ms) ist länger —, auf die gemessene Rate
  // strecken, sonst liefe der Takt auf. Ohne festen Wert aus der Antwortzeit (×2), geklemmt auf 1–5 s (kein
  // Überschwingen). Ob der Takt gehalten wird, zeigt der Vergleich regulateEveryMs vs. responseMs in der Kachel.
  const configuredRegulateMs = (cfg) => sungrowConfiguredRegulateMs(cfg, { isSlave });
  function adaptiveRegulateMs(cfg) {
    const fixed = configuredRegulateMs(cfg);
    // M7b: die gemessene Antwortzeit ist der gleitende MEDIAN der letzten Modbus-Anfragen (laufend, Startphase
    // übersprungen) — NICHT der eingefrorene Write-EWMA (der bei wenigen Writes auf dem langsamen Startwert hing und
    // Auto fälschlich auf 5 s klemmte). In der Startphase (noch kein Median) als Rückfall der Write-EWMA.
    const rt = modbusHealthInst.responseMs() ?? st.responseMs;
    if (Number.isFinite(fixed) && fixed > 0) {
      const want = Math.min(REGULATE_MAX_MS, Math.max(REGULATE_FIXED_MIN_MS, Math.round(fixed)));
      if (rt != null && rt > want) return Math.min(REGULATE_MAX_MS, Math.round(rt));
      return want;
    }
    if (rt != null && rt > 0) return Math.min(REGULATE_MAX_MS, Math.max(REGULATE_MIN_MS, Math.round(rt * 2)));
    return REGULATE_MAX_MS;
  }

  // M22: Register (Doku), Draht-Adresse, Wert und Fehlerart eines abgelehnten Writes für die Logs (split_aborted,
  // Slave-Fallback). writeReg hängt emsAddress (Draht) und emsValue an den Fehler; Doku = Draht + 1.
  function writeErrorInfo(e) {
    const wireAddress = e?.emsAddress ?? null;
    const { kind, code } = classifyModbusError(e?.cause?.message || e?.message, e?.code);
    return { register: wireAddress == null ? null : wireAddress + 1, wireAddress, value: e?.emsValue ?? null, kind, code };
  }

  function foreignModeError(mode) {
    setOwns(null);
    // Codex d6f4b256 P1: ein fremder Regler steuert — eine ausstehende Freigabe gehört nicht mehr zu DVhubs Betrieb und
    // wird verworfen (z. B. erkannt von der Not-Halt-/Shutdown-Rücknahme). Sonst schriebe die Wiederholung im nächsten
    // Takt 0xCC/Modus 0 über das fremde System, auch im Not-Halt.
    if (st.release) releaseAbandon('foreign_mode', mode);
    const err = new Error('sungrow_foreign_ems_mode');
    err.code = 'foreign_ems_mode';
    err.mode = mode;
    return err;
  }

  // Sicher scheitern, wenn der WR den Herzschlag NICHT übernommen hat (External EMS liefe sonst mit fremder Frist
  // — am Gerät 600 s statt 30 beobachtet, der Rückfall-Schutz griffe nicht). SOFORT im selben Durchlauf zurück in
  // Self-consumption (Befehl Stop, Modus 0, best effort auch im Not-Halt), Besitz abgeben, und External EMS für
  // diese Verbindung als „nicht übernommen" merken (nächster Takt steuert den Akku nicht). Danach wirft der
  // Aufrufer heartbeat_mismatch.
  async function neutralizeHeartbeatFailure(conf, hbRead, heartbeatS) {
    try {
      await submitReg(conf, EMS_CMD_ADDR, EMS_CMD.STOP, { neutralize: true });
      await submitReg(conf, EMS_MODE_ADDR, EMS_MODE.SELF, { neutralize: true });
      st.dev = null;
      await readDevice(conf);
    } catch { /* best effort — der WR fällt sonst nach seiner (langen) Frist selbst zurück */ }
    setOwns(null);
    st.hb = { key: st.endpointKey, supported: false };
    logOnce('hb-mismatch', 'sungrow_ems_heartbeat_unsupported', {
      soll: heartbeatS, ist: hbRead,
      text: 'Sungrow übernimmt den External-EMS-Herzschlag (13080) nicht (geschrieben ' + heartbeatS + ' s, gelesen ' + hbRead + ' s) — der Rückfall-Schutz griffe nicht. DVhub steuert den Akku NICHT über External EMS. Firmware/Doku prüfen oder „Forced mode" wählen.'
    }, 'warn');
    const err = new Error(`Herzschlag nicht übernommen (Soll ${heartbeatS} s, Ist ${hbRead}) — External EMS abgebrochen, zurück in Self-consumption`);
    err.code = 'heartbeat_mismatch';
    return err;
  }

  // Herzschlag 13080 schreiben + zurücklesen, mit FC-Wahl. writeFc (config) → nur diese FC; sonst die zuletzt
  // funktionierende FC zuerst, dann die andere; unbekannt → erst FC 06, dann FC 16 (manche Sungrow nehmen 13080
  // nur per „Write Multiple" an). Wird der Wert übernommen, FC je Verbindung merken. Übernimmt der WR gar keinen
  // Wert: acceptDeviceS > 0 und Gerätewert ≤ Grenze → Opt-in mit dem Gerätewert fahren (Warnung); sonst sicher
  // scheitern (neutralizeHeartbeatFailure).
  async function applyHeartbeat(conf, heartbeatS, opt, { writeFc = null, acceptDeviceS = 0 } = {}) {
    const readHb = async () => {
      // Feld #3: 13080 mit Menge 2 lesen (Menge 1 = falscher Festwert); Wert = regs[0], zweites Wort 0xFFFF.
      const hb = await transport.mbRequest({ ...endpoint(conf), fc: 3, address: HEARTBEAT_ADDR, quantity: 2 });
      return Array.isArray(hb) ? (Number(hb[0]) & 0xffff) : NaN;
    };
    const tryFc = async (fc) => {
      await submitReg(conf, HEARTBEAT_ADDR, heartbeatS, { ...opt, fc, keepalive: true });
      const hbRead = await readHb();
      // Übernommen = der Wechselrichter zählt ab unserem Wert herunter: direkt nach dem Schreiben liegt der
      // Rücklesewert in [Soll−3, Soll] (der Countdown tickt schon). 0/65535 (NA) oder weit darunter = NICHT
      // übernommen — dann scheitert der Herzschlag sicher (Feld #1/#2/#3).
      const ok = Number.isFinite(hbRead) && hbRead <= heartbeatS && hbRead >= heartbeatS - 3;
      return { ok, hbRead, fc };
    };
    const order = writeFc ? [writeFc]
      : (st.hb.workingFc ? [st.hb.workingFc, st.hb.workingFc === 6 ? 16 : 6] : [6, 16]);
    let last = null;
    for (const fc of order) {
      last = await tryFc(fc);
      if (last.ok) {
        st.hb = { ...st.hb, key: st.endpointKey, supported: true, workingFc: fc, deviceManaged: false };
        st.sentTimeoutS = heartbeatS;
        st.lastHeartbeatAt = now();
        logOnce('hb-fc-' + fc, 'sungrow_ems_heartbeat_fc', { fc, heartbeatS });
        return;
      }
    }
    const devHb = last?.hbRead;
    if (acceptDeviceS > 0 && Number.isFinite(devHb) && devHb > 0 && devHb <= acceptDeviceS) {
      // Opt-in: der WR verwaltet 13080 selbst — mit seinem Wert fahren. DVhub kann den Herzschlag nicht auffrischen;
      // der Rückfall-Schutz greift erst nach dem (längeren) Gerätewert. Am Gerät prüfen.
      st.hb = { ...st.hb, key: st.endpointKey, supported: true, workingFc: null, deviceManaged: true };
      st.sentTimeoutS = devHb;
      st.lastHeartbeatAt = now();
      logOnce('hb-device-' + devHb, 'sungrow_ems_heartbeat_device_managed', {
        deviceS: devHb, acceptS: acceptDeviceS,
        text: 'Sungrow übernimmt keinen geschriebenen Herzschlag — DVhub fährt External EMS mit dem geräteeigenen Wert (' + devHb + ' s). Der Rückfall dauert bei einem Ausfall entsprechend länger. Am Gerät prüfen.'
      }, 'warn');
      return;
    }
    throw await neutralizeHeartbeatFailure(conf, devHb, heartbeatS);
  }

  /**
   * Gewünschten Zustand schreiben (nur was abweicht; forceAll: alles) und zurücklesen. Wirft bei Fehler/Abweichung.
   * External EMS: Leistung → Befehl → Modus 3 → Herzschlag (heartbeatAfterMode, Standard; der WR setzt 13080 beim
   * Moduswechsel selbst und übernimmt unseren Wert erst danach). Der Herzschlag wird nach dem Schreiben zurückgelesen;
   * stimmt er nicht, wird sofort sicher in Self-consumption neutralisiert (heartbeat_mismatch).
   */
  // adopt (H-9, needsAdoption): Befehl und — bei Laden/Entladen — Leistung immer schreiben, auch wenn das Gerät sie
  // schon zeigt; der Besitz entsteht so durch DVhubs eigenen Write. Den Modus schreibt adopt nicht zusätzlich.
  async function writeDecision(conf, decision, { neutralize = false, modeValue = EMS_MODE.FORCED, heartbeatS = null, forceAll = false, adopt = false, heartbeatAfterMode = true, heartbeatWriteFc = null, acceptDeviceHeartbeatS = 0 } = {}) {
    const dev = st.dev || await readDevice(conf);
    // Ein fremdes EMS/VPP wird nie übersteuert, auch nicht im Not-Halt. Der Slave (isSlave) folgt dem Master-Modus
    // (Feld #5) — ein Modus 2/3 am Slave ist Master-gesteuert, nicht fremd; nur VPP (4) am Slave wäre fremd.
    if (isSlave ? dev.mode === EMS_MODE.VPP : isForeignMode(dev.mode, dev)) throw foreignModeError(dev.mode);
    const writeStartedAt = now(); // Antwortzeit (Schreiben bis bestätigtes Rücklesen) für den adaptiven Takt (Punkt 2)
    if (decision.mode === 'self') {
      const opt = { neutralize };
      if (dev.cmd !== EMS_CMD.STOP) await submitReg(conf, EMS_CMD_ADDR, EMS_CMD.STOP, opt);
      // Modus 0 nur am Master schreiben — der Slave verwirft 13050 und folgt dem Master (Feld #5).
      if (!isSlave && dev.mode !== EMS_MODE.SELF) await submitReg(conf, EMS_MODE_ADDR, EMS_MODE.SELF, opt);
    } else {
      const opt = { neutralize, claimMode: modeValue };
      const cmd = CMD_BY_NAME[decision.command];
      setStopConfirmed(false); // DVhub fährt jetzt einen Befehl — „Stopp bestätigt" gilt erst nach der nächsten Rücknahme
      if (decision.command !== 'stop' && (forceAll || adopt || dev.powerW !== decision.powerW)) await submitReg(conf, EMS_POWER_ADDR, decision.powerW, opt);
      if (forceAll || adopt || dev.cmd !== cmd) await submitReg(conf, EMS_CMD_ADDR, cmd, opt);
      // Nur am Master: Modus (13050) und — in External EMS — der Herzschlag. Der Slave bekommt NIE einen
      // Modus-Write (Feld #5: wird verworfen, der Slave folgt dem Master-Modus 2).
      const needHeartbeat = !isSlave && modeValue === EMS_MODE.EXTERNAL && (forceAll || dev.mode !== modeValue);
      const hb = async () => applyHeartbeat(conf, heartbeatS, opt, { writeFc: heartbeatWriteFc, acceptDeviceS: acceptDeviceHeartbeatS });
      if (needHeartbeat && !heartbeatAfterMode) await hb();
      if (!isSlave && (forceAll || dev.mode !== modeValue)) await submitReg(conf, EMS_MODE_ADDR, modeValue, opt);
      if (needHeartbeat && heartbeatAfterMode) await hb();
    }
    st.dev = null;
    const back = await readDevice(conf);
    updateResponseMs(now() - writeStartedAt); // gleitender Mittelwert der Antwortzeit (adaptiver Takt, Punkt 2)
    // Der Slave-Modus folgt dem Master (Feld #5) → beim Slave nur Befehl/Leistung zurückprüfen (ignoreMode).
    if (!emsMatches(back, decision, 10, modeValue, { ignoreMode: isSlave })) {
      const err = new Error(`EMS-Rücklesung weicht ab (Soll ${describe(decision, modeValue)}, Ist Modus ${back.mode}, Befehl 0x${back.cmd.toString(16)}, ${back.powerW} W)`);
      err.code = 'readback_mismatch';
      throw err;
    }
    // Zuletzt am Master bestätigter Zustand (M2): erkennt den eigenen Modus wieder, falls der Besitz-Merker verloren
    // geht. Auch ein bestätigtes Self (Modus 0) wird gemerkt — danach gilt Modus 2 nicht mehr als „eigener".
    if (!isSlave) st.lastMasterWrite = { mode: back.mode, cmd: back.cmd, powerW: back.powerW, at: now() };
    // Master: ein bestätigter Befehl im Steuermodus beendet das Warten vor dem Eintritt; ein gezählter Wiedereintritt
    // (B3) ist jetzt wirklich geschrieben und wird erst jetzt gemeldet (Fable P3-3).
    if (!isSlave && decision.mode === 'forced') {
      st.entryDeferred = { since: 0, lastAt: 0, logKey: null, logAt: 0 };
      if (st.reentryLogPending != null) {
        logOnce(`reentry-${st.reentryLogPending}`, 'sungrow_ems_reentry', { count1h: st.reentryLogPending }, 'warn');
        st.reentryLogPending = null;
      }
    }
    // Erst ein bestätigtes Self-consumption gibt den Besitz ab.
    if (decision.mode === 'self') {
      setOwns(null);
      setStopConfirmed(true); // Befehl Stopp zurückgelesen (am Slave: der Grundzustand seines Befehls)
      // Option A: eine ausstehende manuelle Freigabe ist damit am Gerät erreicht (0xCC + Modus 0 bzw. am Slave 0xCC
      // bestätigt) — etwa durch die einmalige Not-Halt-Rücknahme oder das Beenden. Nicht noch einmal schreiben.
      if (st.release) releaseCompleted(decision.reason || 'return');
    }
    return back;
  }

  function telemetry(cfg, opts) {
    const t = now();
    const maxAgeMs = opts.telemetryMaxAgeMs;
    const m = meterImport(state, cfg, { now: t, maxAgeMs });
    const v = state.victron || {};
    const fresh = (field) => {
      const at = Number(v.fieldUpdatedAt?.[field]) || 0;
      return at > 0 && t - at <= maxAgeMs && v[field] != null && Number.isFinite(Number(v[field]));
    };
    const untrusted = v.freeze?.active === true || v.sourceMismatch?.active === true;
    return {
      gridImportW: m.fresh && !untrusted ? m.importW : null,
      batteryW: fresh('batteryPowerW') && !untrusted ? Number(v.batteryPowerW) : null,
      pvW: fresh('pvPowerW') && !untrusted ? Number(v.pvPowerW) : null,
      loadW: fresh('selfConsumptionW') && !untrusted ? Number(v.selfConsumptionW) : null
    };
  }

  // Schreiben nur an ein erkanntes, unterstütztes Gerät — und nur an genau die Verbindung, an der es erkannt wurde.
  function deviceGate(cfg) {
    const d = state.victron?.device;
    if (!d || d.vendor !== 'sungrow') return 'sungrow_device_not_identified';
    if (d.endpointKey !== endpointKeyOf(cfg?.victron)) return 'sungrow_device_not_identified';
    if (d.supported !== true) return 'sungrow_device_not_supported';
    return null;
  }

  // Feldtest „Akku nicht laden" (M14b/M25): während eines Abregelungs-Tests mit dieser
  // Option (state.ctrl.curtailmentTest.blockCharge) das LADEN sperren (Entladen fürs Haus
  // bleibt). Selbst-ablaufend über das Lease (now < until) — endet garantiert mit dem Test.
  function curtailmentBatteryHold() {
    const ct = state.ctrl?.curtailmentTest;
    return !!(ct && ct.active === true && ct.blockCharge === true && now() < ct.until);
  }

  // M25 + Codex 4c624dcd (P1): Ist die Einspeisung gerade gesperrt? Dann entlädt DVhub nur fürs Haus (höchstens die
  // Netto-Last). Grund: Unter der Einspeisegrenze lehnt der Master zu große Entladebefehle mit „modbus exception 4" ab
  // (→ Split-Abbruch, Modus 0), und seit M27 läuft auch der Slave weiter — eine Export-Vorgabe (EOS/Regel) entlüde ihn
  // sonst ins Netz, an der Master-Grenze vorbei. Gesperrt = eigene Sperre geschrieben (_lastDvFeedIn=false), teilweise
  // geschrieben (_dvPartialBlock) oder die Pflicht-Abregelung liegt an, auch wenn ihr Write fehlschlug (DV-Abschaltung
  // forcedOff, Negativpreis) — wie multi-gx „export_blocked".
  function feedInBlocked() {
    const c = state.ctrl || {};
    return c._lastDvFeedIn === false || c._dvPartialBlock === true || c.forcedOff === true || c.negativePriceActive === true;
  }

  // Regeltakt (Punkt 2): beim aktiven Regeln (DVhub besitzt Forced ODER External EMS) der adaptive Takt 1–5 s aus
  // der gemessenen Antwortzeit (fester sungrow.regulateEveryMs hat Vorrang, wird aber ebenfalls auf 1–5 s geklemmt)
  // — unabhängig vom 5-s-Takt des Aufrufers. Sonst der ruhige Profil-Takt (regulateEveryMs). Wichtig für Forced:
  // so bleibt das Box-Watchdog-Lebenszeichen immer frisch (≤ 5 s), ein großer regulateEveryMs kann es nicht über
  // die Watchdog-Frist altern lassen (Review-Befund 3).
  function stepEveryMs(opts) {
    const cfg = getCfg();
    // Quirk-Fix (N5, Feld 16.11.): ändert sich der GEWÄHLTE Takt (Config), soll er an beiden WR ZEITNAH greifen —
    // nicht erst nach Ablauf des alten (langen) Takts (der Slave übernahm sofort, der Master erst ~10 s später).
    // Darum den internen Takt-Zeitgeber einmal zurücksetzen, damit der nächste Aufruf-Takt sofort nachregelt.
    const taktCfg = configuredRegulateMs(cfg);
    if (st.lastTaktCfg !== undefined && taktCfg !== st.lastTaktCfg) st.lastStepAt = null;
    st.lastTaktCfg = taktCfg;
    if (!(st.owns && (st.ownMode === EMS_MODE.EXTERNAL || st.ownMode === EMS_MODE.FORCED))) return opts.regulateEveryMs;
    return adaptiveRegulateMs(cfg);
  }
  // Takt-Zeitgeber monoton (A21, Christin 23.11.2026): mit der Wanduhr regelte tick() nach einem Rücksprung der Uhr bei
  // gleichbleibendem Sollwert um die Sprungweite nicht nach (kein Auffrischen, kein External-Herzschlag), nach einem
  // Sprung vorwärts vorzeitig. Ein negativer Abstand (nur mit eingespielter Uhr denkbar) gilt als fällig.
  const markStep = () => { st.lastStepAt = monoNow(); };
  const due = (everyMs) => {
    if (st.lastStepAt == null) return true;
    const d = monoNow() - st.lastStepAt;
    return d < 0 || d >= everyMs - TICK_JITTER_MS;
  };

  // Beide WR sicher in Self-consumption (Split-Abbruch): Master neutralisieren (writeDecision self), Slave über
  // seinen eigenen Pfad, Besitz abgeben, Ziel verwerfen. Best effort — Self ist immer die sichere Seite.
  async function neutralizeBoth(reason) {
    // M2 (Feld 16.11.): den Besitz-Merker ERST abgeben, wenn die Rückgabe am Master BESTÄTIGT ist (writeDecision self
    // liest 13050=0 zurück). Scheitert sie (Lesefehler/Abweichung), Merker UND Ziel behalten — der nächste Takt tritt
    // die Rückgabe erneut an. Sonst hielte DVhub seinen eigenen Modus 2 für fremd (owns weg) und schriebe nie wieder.
    let masterSafe = false;
    try {
      st.dev = null;
      const conf = sungrowEmsConf(getCfg());
      // Automatische Rücknahme nur für DVhubs EIGENEN Betrieb (S-49): Merker, oder das Gerät spiegelt DVhubs zuletzt
      // bestätigten Write (M2). Einen noch nicht übernommenen Modus 2 fasst sie nicht an — bis H-9 schützte ihn die
      // Fremderkennung in writeDecision (Codex 2a0f18b5 P1: sonst 0xCC + Modus 0 auf einen fremden Master).
      // Unberührt bleiben dann auch Besitz und Ziel (Codex 4e3fc521 P2): eine zurückgestellte Übernahme holt der
      // nächste Takt nach, statt bis zum nächsten Sollwert zu ruhen.
      let untouched = false;
      if (!st.owns) {
        const dev = await readDevice(conf);
        untouched = !ownWroteMode(dev.mode, dev);
      }
      if (!untouched) { await writeDecision(conf, { mode: 'self', reason }, { neutralize: true }); masterSafe = true; }
    } catch { /* best effort — Merker bleibt, Wiederholung nächster Takt */ }
    try { await slaveActuator.neutralize(reason); } catch { /* best effort */ }
    st.revokedReason = reason;
    if (masterSafe) { setOwns(null); st.target = null; }
  }

  // M28 (Christin 19.11., Feldbeleg 12:28): Liefert-nicht-Erkennung je WR und Richtung. Liefert ein WR über
  // STALL_DETECT_MS weniger als STALL_DELIVER_RATIO seines Anteils (bei Anteil > STALL_MIN_SHARE_W), gilt er als
  // „an der Grenze": für STALL_PROBE_MS bekommt er in dieser Richtung keinen Anteil, der andere übernimmt
  // (splitStrategyShares). Danach bekommt er seinen Anteil probeweise zurück; liefert er wieder, ist die Lage aufgehoben,
  // sonst greift die Erkennung nach STALL_DETECT_MS erneut. Ein Log je Lage (Erkennen + Erholung), nicht je Probe.
  // Gemessen wird gegen den im VORIGEN Takt kommandierten Anteil (die Messung zeigt dessen Wirkung).
  const wrLabel = (wr) => (wr === 'master' ? 'Master' : 'Slave');
  function deliverEntry(wr, direction) {
    const k = `${wr}:${direction}`;
    if (!st.deliver[k]) st.deliver[k] = { underSince: 0, stalledUntil: 0, episode: false };
    return st.deliver[k];
  }
  function isStalled(wr, direction, t) { return deliverEntry(wr, direction).stalledUntil > t; }

  // M28 Grundsatz 0: gemessene Lieferfähigkeit je WR und Richtung (siehe LIMIT_*). Beurteilt wird nur eine NEUE Messung
  // (Zeitstempel), und erst LIMIT_SETTLE_MS nach einer Befehlserhöhung — sonst hielte DVhub die alte, 5 s alte
  // Slave-Messung für eine Begrenzung. Rein zustandsbehaftet, kein I/O.
  const enterTolW = (cmdW) => Math.max(LIMIT_ENTER_MIN_W, LIMIT_ENTER_RATIO * cmdW);
  const exitTolW = (cmdW) => Math.max(LIMIT_EXIT_MIN_W, LIMIT_EXIT_RATIO * cmdW);
  function limitEntry(wr, direction) {
    const k = `${wr}:${direction}`;
    if (!st.limit[k]) st.limit[k] = { limited: false, limitW: null, underSince: 0, cmdW: 0, cmdRaisedAt: 0, lastSampleAt: 0, judgedAt: 0 };
    return st.limit[k];
  }
  function judgeLimit(wr, direction, cmdW, sample, commandedAt, probeW = LIMIT_PROBE_W) {
    const L = limitEntry(wr, direction);
    // Codex 07041019 (P2): eine deutliche Befehlserhöhung beginnt die Bestätigung neu — eine Lücke kurz davor darf beim
    // normalen Hochfahren keine Grenze bestätigen.
    if (cmdW > L.cmdW + enterTolW(cmdW)) { L.cmdRaisedAt = commandedAt; L.underSince = 0; }
    L.cmdW = cmdW;
    const at = Number(sample?.at) || 0;
    const w = sample?.w;
    if (!at || at === L.lastSampleAt || w == null || !Number.isFinite(Number(w))) return;
    L.lastSampleAt = at;
    if (at < L.cmdRaisedAt + LIMIT_SETTLE_MS) return;
    if (!(cmdW >= LIMIT_MIN_CMD_W)) { L.underSince = 0; return; }
    L.judgedAt = at;
    const delivered = direction === 'charge' ? Math.max(0, Number(w)) : Math.max(0, -Number(w));
    const deficit = cmdW - delivered;
    const rounded = Math.round(delivered / 10) * 10;
    if (L.limited) {
      const prev = Number(L.limitW) || 0;
      // Liefert wieder, was befohlen ist — und verlangt war klar mehr als die alte Grenze → Begrenzung aufgehoben.
      if (deficit <= exitTolW(cmdW) && cmdW >= prev + probeW / 2) { L.limited = false; L.limitW = null; L.underSince = 0; return; }
      // Echte Lücke → die Messung ist die Lieferfähigkeit; sonst (liefert den Befehl) nur nach oben nachführen.
      L.limitW = deficit > exitTolW(cmdW) ? rounded : Math.max(prev, rounded);
      return;
    }
    if (deficit > enterTolW(cmdW)) {
      if (!L.underSince) L.underSince = at;
      if (at - L.underSince >= LIMIT_CONFIRM_MS) { L.limited = true; L.limitW = rounded; L.underSince = 0; }
    } else L.underSince = 0;
  }
  function limitInfo(wr, direction, t) {
    const L = st.limit[`${wr}:${direction}`];
    if (!L || !L.limited) return { limited: false, limitW: null };
    if (t - L.judgedAt > LIMIT_STALE_MS) { L.limited = false; L.limitW = null; return { limited: false, limitW: null }; }
    return { limited: true, limitW: Math.max(0, Number(L.limitW) || 0) };
  }

  function trackDelivery(t, measured, probeW = LIMIT_PROBE_W) {
    const last = st.splitLast;
    if (!last || t - last.at > STALL_TRACK_MAX_GAP_MS) {
      for (const e of Object.values(st.deliver)) e.underSince = 0;
      for (const L of Object.values(st.limit)) L.underSince = 0;
      return;
    }
    // Codex 402a3df9 (P2): eine Messung in der GEGENRICHTUNG unterbricht die laufende Messung — sonst zählten Sekunden
    // aus einem früheren Entlade-Abschnitt nach einer Ladephase weiter und der WR flöge nach 1 s heraus. Codex e5b5fffe
    // (P2): auch der Befehl der anderen Richtung gilt als 0 — die Rückkehr ist dann eine Befehlserhöhung mit
    // Einschwingzeit, und ein Messwert von VOR dem Wiederbeginn (z. B. ein stehender Lade-Messwert) zählt nicht.
    for (const [k, e] of Object.entries(st.deliver)) if (!k.endsWith(`:${last.direction}`)) { e.underSince = 0; e.cmdW = 0; }
    for (const [k, L] of Object.entries(st.limit)) if (!k.endsWith(`:${last.direction}`)) { L.underSince = 0; L.cmdW = 0; }
    for (const wr of ['master', 'slave']) {
      const e = deliverEntry(wr, last.direction);
      const shareW = Math.max(0, Number(last[`${wr}W`]) || 0);
      judgeLimit(wr, last.direction, shareW, measured[wr], last.at, probeW);
      // Codex 402a3df9 (P2): nur eine NEUE Messung zählt, gemessen nach dem Einschwingen auf den Befehl, und die Frist
      // läuft in Messzeit — eine stehende (alte) Messung ist kein neuer Beleg, egal wie viele Takte vergehen.
      if (shareW > (e.cmdW || 0) + enterTolW(shareW)) { e.cmdRaisedAt = last.at; e.underSince = 0; }
      e.cmdW = shareW;
      const m = measured[wr]?.w;
      const at = Number(measured[wr]?.at) || 0;
      if (!(shareW > STALL_MIN_SHARE_W) || m == null || !Number.isFinite(Number(m)) || !at) { e.underSince = 0; continue; }
      if (at === e.lastSampleAt) continue;
      e.lastSampleAt = at;
      if (at < (e.cmdRaisedAt || 0) + LIMIT_SETTLE_MS) continue;
      const deliveredW = last.direction === 'charge' ? Math.max(0, Number(m)) : Math.max(0, -Number(m));
      const dirText = last.direction === 'charge' ? 'Lade' : 'Entlade';
      if (deliveredW >= STALL_DELIVER_RATIO * shareW) {
        e.underSince = 0;
        if (e.episode) {
          e.episode = false; e.stalledUntil = 0;
          pushLog('sungrow_ems_share_recovered', { wr, direction: last.direction, shareW, deliveredW: Math.round(deliveredW), text: `Sungrow: ${wrLabel(wr)} liefert seinen ${dirText}-Anteil wieder (${Math.round(deliveredW)} von ${shareW} W).` });
        }
        continue;
      }
      if (!e.underSince) e.underSince = at;
      if (at - e.underSince < STALL_DETECT_MS) continue;
      e.underSince = 0;
      e.stalledUntil = t + STALL_PROBE_MS;
      e.stallDeliveredW = Math.round(deliveredW); // was er beim Erkennen noch lieferte (Grundsatz 0, stalledOut)
      if (!e.episode) {
        e.episode = true;
        const other = wr === 'master' ? 'slave' : 'master';
        pushLog('sungrow_ems_share_stalled', {
          wr, direction: last.direction, shareW, deliveredW: Math.round(deliveredW), takeover: other, probeAfterS: STALL_PROBE_MS / 1000,
          text: `Sungrow: ${wrLabel(wr)} liefert seinen ${dirText}-Anteil nicht (${Math.round(deliveredW)} von ${shareW} W) — an der Grenze, der ${wrLabel(other)} übernimmt. Probe etwa alle ${STALL_PROBE_MS / 1000} s.`,
        });
      }
    }
  }

  // N3: den Slave kommandieren und ihm dabei den Takt mitgeben, in dem er geführt wird — den wirksamen Master-Takt
  // (derselbe Wert wie regulateEveryMs im Master-Status). Ein Aktuator ohne setDrivenRegulateMs (Tests) bleibt unberührt.
  function commandSlave(decision, ctl) {
    slaveActuator.setDrivenRegulateMs?.(adaptiveRegulateMs(getCfg()));
    return slaveActuator.applyDirectCommand(decision, ctl);
  }

  // Split-Steuerung: die Reglerentscheidung auf beide WR schreiben. Self → Master Self + Slave zurückziehen.
  // Forced → Leistung nach Punkt-2-Grenzen und SoC-Reserve/Headroom aufteilen, Slave zuerst, dann Master;
  // scheitert EINER (Herzschlag, Rücklesen, fremder Modus, …) → BEIDE sicher in Self-consumption.
  async function stepSplit({ conf, ctl, decision, gap, second, reason, t, opts }) {
    const cfg = getCfg();
    const optMaster = cfg.optimizer || {};
    const si = cfg.sungrow?.secondInverter || {};
    if (decision.mode === 'self') {
      st.splitLast = null; // M28: keine kommandierten Anteile mehr, die Erkennung ruht
      try {
        if (!emsMatches(st.dev, decision, 0, ctl.modeValue) || gap) {
          const back = await writeDecision(conf, decision, { modeValue: ctl.modeValue, heartbeatS: ctl.heartbeatTimeoutS, forceAll: gap, heartbeatAfterMode: ctl.heartbeatAfterMode, heartbeatWriteFc: ctl.heartbeatWriteFc, acceptDeviceHeartbeatS: ctl.acceptDeviceHeartbeatS });
          void back;
        } else if (decision.mode === 'self') setOwns(null);
      } catch (e) {
        st.error = e?.message || String(e); st.dev = null; publish();
        logOnce(st.error, 'sungrow_ems_error', { error: st.error, decision }, 'warn');
        return { ok: false, error: st.error };
      }
      // Slave bei Self zurückziehen (auf 0 / Self-consumption), falls er noch von DVhub gefahren wird.
      try { await slaveActuator.neutralize('self'); } catch { /* best effort */ }
      st.error = null; publish();
      return { ok: true, split: true, decision };
    }
    // Forced: Aufteilung nach gewählter Strategie (Punkt 1) berechnen.
    const secondCfg = resolveSecondInverter(cfg);
    const masterBdc = Number(state.victron.device.bdcRatedW) || null;
    const charge = decision.command === 'charge';
    // Per-WR-Grenze (B3): die kleinste aus Feldeinstellung (optional), Gerätegrenze (Laden 33047, Entladen 33048,
    // je ×10 W gelesen) und BDC-Nennleistung. Laden erbt NIE die Entladegrenze — jede Richtung ihre eigene Grenze.
    // Fehlt eine Angabe, zählt sie nicht; ohne jede Angabe 0. Ein zu hoch gelesener Gerätewert kann nicht schaden
    // (min mit BDC), ein zu niedriger regelt nur konservativer.
    const perWrMax = sungrowEffectivePowerW; // gemeinsamer Resolver (Feld-Übersteuerung ∧ Gerätewert ∧ BDC), Aufgabe 1/4
    const floor = Number(cfg.optimizer?.hardFloorSocPct ?? 5);
    const maxSoc = Number(cfg.optimizer?.maxSocPct ?? 100);
    const masterDev = state.victron.device || {};
    const slaveDev = state.sungrowSecond || {};
    // M1 (Feld 16.11., kritisch): der gemeldete SoC (13022) ist fensterrelativ — vor dem Vergleich mit den realen
    // Grenzen in den ECHTEN SoC umrechnen (min + gemeldet × (max−min)/100, je WR aus 13059/13058). Sonst sperrt das
    // Split-Gate bei gemeldet 0,8/2,2 % beide WR (verglichen mit real 10/11 %), obwohl Sungrow real ~10,7/12 % hält
    // und noch Energie freigibt → kein Entladen, Notladung.
    const masterSoc = sungrowRealSocPct(state.victron.sungrowMasterSocPct ?? state.victron.soc, masterDev.minSocPctDevice, masterDev.maxSocPctDevice);
    const slaveSoc = sungrowRealSocPct(second.socPct, slaveDev.minSocPctDevice, slaveDev.maxSocPctDevice);
    // Je-WR-SoC-Grenze (Aufgabe 1 + M1): Entlade-Boden = max(hardFloor, 13059 + Puffer), Lade-Decke = min(maxSoc,
    // 13058) — alles real %. Der Puffer (kundeneinstellbar, Standard 0 seit M24) hält DVhub knapp über Sungrows Untergrenze
    // (verhindert die Notladung). Fehlt der Gerätewert, zählt nur die Konfig-Grenze. splitStrategyShares sperrt damit
    // je WR und leitet den Anteil an den anderen (bis zu DESSEN Grenze) um.
    const socFloorBuffer = sungrowSocFloorBufferPct(cfg);
    const masterFloorPct = sungrowDischargeFloorPct(floor, masterDev.minSocPctDevice, socFloorBuffer);
    const slaveFloorPct = sungrowDischargeFloorPct(floor, slaveDev.minSocPctDevice, socFloorBuffer);
    const masterCeilPct = sungrowChargeCeilPct(maxSoc, masterDev.maxSocPctDevice);
    const slaveCeilPct = sungrowChargeCeilPct(maxSoc, slaveDev.maxSocPctDevice);
    const masterMax = perWrMax(charge ? optMaster.maxChargeW : optMaster.maxDischargeW, charge ? masterDev.maxChargeWDevice : masterDev.maxDischargeWDevice, masterBdc);
    // Notladung (Aufgabe 2): ein Slave in Notladung ist NICHT steuerbar → aus dem Split nehmen (Grenze 0, nicht
    // kommandieren), sein Anteil geht an den Master. second.emergencyCharge kommt aus secondInverterTelemetry.
    const slaveEmergency = second.emergencyCharge === true;
    const slaveMax = slaveEmergency ? 0 : perWrMax(charge ? si.maxChargeW : si.maxDischargeW, charge ? slaveDev.maxChargeWDevice : slaveDev.maxDischargeWDevice, second.bdcRatedW);
    const strategy = charge ? secondCfg.strategyCharge : secondCfg.strategyDischarge;
    // M28: gemessene Akku-Leistung je WR (+ = Laden) gegen den zuletzt kommandierten Anteil prüfen. Master-Rohwert
    // (sungrowMasterBatteryW, vom Poller bei aggregateTelemetry) nur frisch; Slave aus der frischen Slave-Telemetrie
    // (null in Notladung).
    const direction = charge ? 'charge' : 'discharge';
    const vic = state.victron || {};
    const masterBattAt = Number(vic.fieldUpdatedAt?.batteryPowerW) || 0;
    const masterMeasW = vic.sungrowMasterBatteryW != null && Number.isFinite(Number(vic.sungrowMasterBatteryW))
      && masterBattAt > 0 && t - masterBattAt <= opts.telemetryMaxAgeMs ? Number(vic.sungrowMasterBatteryW) : null;
    // Messzeitpunkt je WR (Grundsatz 0 beurteilt nur neue Messungen): Master = Poll-Stempel der Akku-Leistung, Slave =
    // Lesetakt des Begleitdienstes (state.sungrowSecond.updatedAt, alle 5 s).
    const slaveSampleAt = Number(state.sungrowSecond?.updatedAt) || 0;
    // Codex 07041019 (P2): die Probe über der gemessenen Grenze muss größer sein als die Schreibschwelle (stepW), sonst
    // geht sie nie ans Gerät.
    const probeW = Math.max(LIMIT_PROBE_W, (Number(opts.stepW) || 0) + 10);
    trackDelivery(t, { master: { w: masterMeasW, at: masterMeasW == null ? 0 : masterBattAt }, slave: { w: second.batteryPowerW, at: slaveSampleAt } }, probeW);
    const mLim = limitInfo('master', direction, t);
    const sLim = limitInfo('slave', direction, t);
    // „Liefert nicht" nimmt einen WR nur heraus, wenn der andere selbst nicht begrenzt ist — oder wenn der hängende WR
    // praktisch nichts liefert. Sonst trägt er weiter seinen Ist-Anteil (Grundsatz 0): ihn herauszunehmen kostete genau
    // das, was er noch liefert, wenn der andere den Rest nicht tragen kann.
    const shareArgs = {
      powerW: decision.powerW, charge, masterMax, slaveMax, masterSoc, slaveSoc,
      masterCapacityWh: optMaster.batteryCapacityWh, slaveCapacityWh: si.batteryCapacityWh,
      floorSocPct: floor, maxSocPct: maxSoc, masterFloorPct, slaveFloorPct, masterCeilPct, slaveCeilPct,
      ratioMasterPct: secondCfg.ratioMasterPct, minPowerW: opts.minPowerW,
      socDeadbandPct: secondCfg.socBalanceDeadbandPct,
      dischargeMarginPct: SUNGROW_SPLIT_DISCHARGE_MARGIN_PCT,
    };
    // Codex 28a9c637 (P2): herausnehmen nur, wenn der andere das, was der hängende WR noch liefert, auch übernehmen kann.
    // Ein WR an seiner Leistungsgrenze (z. B. Feldeinstellung 2 kW, liefert sie voll) gilt nicht als „begrenzt", hat aber
    // keinen Spielraum — ohne diese Prüfung kostete die Herausnahme genau die Restlieferung (Netzbezug +1 kW, nachgestellt).
    // Spielraum = wirksame Grenze (bei eigener Begrenzung limitW + Probe) minus Anteil ohne Herausnahme; 0 an der SoC-Grenze
    // bzw. Marge, in master-only/Notladung und wenn er selbst „liefert nicht".
    const roomOf = (lim, maxW, baseW) => Math.max(0, (lim.limited ? Math.min(maxW, lim.limitW + probeW) : maxW) - baseW);
    const base = splitStrategyShares(strategy, { ...shareArgs, masterStalled: false, slaveStalled: false });
    const slaveRoomW = base.slaveUncommanded || slaveEmergency || base.slaveOut || isStalled('slave', direction, t) ? 0 : roomOf(sLim, slaveMax, base.slaveW);
    const masterRoomW = base.masterOut || isStalled('master', direction, t) ? 0 : roomOf(mLim, masterMax, base.masterW);
    const stalledOut = (wr, other, otherRoomW) => {
      if (!isStalled(wr, direction, t)) return false;
      const deliveredW = Number(deliverEntry(wr, direction).stallDeliveredW) || 0;
      return deliveredW < LIMIT_MIN_CMD_W || (!other.limited && otherRoomW >= deliveredW);
    };
    const { masterW, slaveW, slaveUncommanded, masterOut, slaveOut } = splitStrategyShares(strategy, {
      ...shareArgs,
      masterStalled: stalledOut('master', sLim, slaveRoomW), slaveStalled: stalledOut('slave', mLim, masterRoomW),
    });
    const mk = (w) => (w >= opts.minPowerW ? { mode: 'forced', command: decision.command, powerW: w, reason: decision.reason } : { mode: 'forced', command: 'stop', powerW: 0, reason: decision.reason });
    // M27 (Christin 19.11., ersetzt den Slave-Stopp aus M16): Auch während einer Sperre (Negativpreis, Direktvermarkter,
    // Test-Knopf → state.ctrl._lastDvFeedIn === false) bekommt der Slave seinen normalen Anteil nach der Strategie —
    // KEIN 0xCC mehr. Feldbeleg: mit dem Slave-Stopp kam die Hauslast aus dem Netz, sobald der Master leer war. Beide WR
    // laden/entladen weiter, DVhub regelt die Summe auf den Sollwert (bei Negativpreis den Puffer −40 W). Die
    // Einspeisegrenze bleibt nur am Master (DV-Sequenz 13074/13087/13088/31222). Kurze Netzspitzen bei Lastsprüngen sind
    // hingenommen. Bekannte Lücke (bewusst nicht gebaut): die Slave-PV folgt der Master-Grenze nicht (13090).
    // Slave nicht kommandieren bei master-only ODER Notladung (uncontrollable) → nur best effort in Self halten.
    const skipSlave = slaveUncommanded || slaveEmergency;
    // M28 Grundsatz 0 (Christin 19.11.): das Fehlende eines WR, der bestätigt weniger liefert als befohlen (Anteil −
    // gemessene Lieferfähigkeit), geht an den anderen — bis zu dessen Leistungsgrenze (ein selbst begrenzter Empfänger:
    // seine Lieferfähigkeit + LIMIT_PROBE_W). Kein Empfänger an der SoC-Grenze/Marge, keiner, der „liefert nicht" hängt,
    // kein Slave in master-only/Notladung. Nur EINE Richtung je Takt und nur, wenn der Empfänger selbst nichts schuldig
    // bleibt — so schiebt DVhub nichts hin und her. Der begrenzte WR behält seinen Befehl (er trägt seinen Ist-Anteil und
    // zeigt so, wenn er wieder mehr kann). Netzbezug bleibt erst, wenn beide nicht mehr können.
    const shortOf = (lim, baseW) => (lim.limited ? Math.max(0, baseW - lim.limitW) : 0);
    const masterShortW = shortOf(mLim, masterW);
    const slaveShortW = shortOf(sLim, slaveW);
    let masterCmdW = masterW; let slaveCmdW = slaveW; let transferW = 0; let transferTo = null;
    if (masterShortW > 0 && slaveShortW === 0 && !skipSlave && !slaveOut && !isStalled('slave', direction, t)) {
      transferW = Math.min(masterShortW, roomOf(sLim, slaveMax, slaveW));
      if (transferW > 0) { slaveCmdW = slaveW + transferW; transferTo = 'slave'; }
    } else if (slaveShortW > 0 && masterShortW === 0 && !masterOut && !isStalled('master', direction, t)) {
      transferW = Math.min(slaveShortW, roomOf(mLim, masterMax, masterW));
      if (transferW > 0) { masterCmdW = masterW + transferW; transferTo = 'master'; }
    }
    const slaveDecision = skipSlave ? { mode: 'self', command: 'stop', powerW: 0, reason: decision.reason } : mk(slaveCmdW);
    let masterDecision = mk(masterCmdW);
    let effMasterW = masterCmdW; let effSlaveW = slaveCmdW; let slaveFellBack = false; let slaveWrote = false;
    let slaveReadback = null; // Gerätezustand des Slave nach dem Befehl (Codex 07041019: beurteilt wird, was AM GERÄT steht)
    // Befund 2 (16.11., Fable-Review, Repro belegt): Übernimmt der Master den Slave-Anteil (Slave-Fehler), muss er seinen
    // EIGENEN SoC-Boden/Deckel einhalten — genau wie splitStrategyShares, das mMax bei erreichter Grenze auf 0 klemmt
    // (atLimit). Der Fallback nahm nur die Leistungsgrenze (masterMax) und ließ den Master unter seinem Min-SoC entladen
    // bzw. über seinen Max-SoC laden (Risiko Netz-Nachladung). masterTakeoverW = 0, wenn der Master in DIESER Richtung
    // an seiner Grenze ist (M28: beim Entladen inkl. Marge), sonst masterMax.
    const masterAtLimit = sungrowWrAtLimit({ charge, socPct: masterSoc, floorPct: masterFloorPct, ceilPct: masterCeilPct, dischargeMarginPct: SUNGROW_SPLIT_DISCHARGE_MARGIN_PCT });
    const masterTakeoverW = masterAtLimit ? 0 : masterMax;
    // Slave zuerst (eigener Pfad neutralisiert sich bei Fehler selbst).
    // Fable P3-3: die Fallback-Meldung erst nach dem Ergebnis des Masters — „der Master steuert weiter" nur, wenn er es
    // wirklich tut (im zurückgestellten Eintritt oder beim Rücktritt nicht).
    let fallbackLog = null;
    const logFallback = (masterRuns) => {
      if (!fallbackLog) return;
      logOnce(`${fallbackLog.key}|${masterRuns ? 'run' : 'stop'}`, 'sungrow_ems_split_slave_fallback', masterRuns
        ? fallbackLog.data
        : { ...fallbackLog.data, masterW: 0, text: 'Sungrow: Slave-Fehler im Split — der Master steuert in diesem Takt nicht (Eintritt zurückgestellt bzw. zurückgetreten oder Master-Fehler, siehe folgende Meldung).' }, 'warn');
      fallbackLog = null;
    };
    if (skipSlave) {
      // master-only/Notladung: Slave in Modus 0 (Self) halten. Scheitert das nicht hart — der Slave liegt dann ohnehin in Self.
      st.slaveNeutralizeTick = t;
      try { await slaveActuator.neutralize('self'); } catch { /* best effort */ }
    } else {
      const sr = await commandSlave(slaveDecision, ctl);
      if (sr.ok) slaveReadback = sr.readback || null;
      if (sr.ok) st.slaveForeignNotified = false; // DVhub führt den Slave — eine spätere Fremdsteuerung ist eine neue Lage
      if (sr.ok) endMasterAlone(); // A7: der Slave antwortet und fährt DVhubs Befehl — die Frist beginnt später neu
      slaveWrote = sr.ok === true && sr.unchanged !== true; // echter Slave-Write (N4: Log/Status nur bei Änderung)
      if (!sr.ok) {
        // Absicherung C6 (Aufgabe 3): EIN Slave-Fehler (z. B. „EMS-Register lesen fehlgeschlagen: modbus exception 4",
        // Feld 15.11.) darf NICHT beide WR auf Modus 0 werfen (~20 s Ausfall). readDevice hat den Lesevorgang bereits
        // 1× nach 300 ms wiederholt (retryable). Scheitert der Slave trotzdem, faellt DVhub auf Master-only zurueck:
        // den Slave sicher zurueckziehen (0xCC, best effort) und seinen Anteil dem Master geben (bis zu dessen Grenze).
        // Der Master steuert weiter. Modus 0 (beide in Self) nur, wenn der MASTER selbst nicht sicher steuerbar ist
        // (naechster try-Block). Ein fremdes EMS am Slave (sr.foreign) wird ebenfalls nicht angefasst → Master-only.
        st.slaveNeutralizeTick = t;
        try { await slaveActuator.neutralize('split_slave_failed'); } catch { /* best effort */ }
        effSlaveW = 0;
        effMasterW = Math.min(decision.powerW, masterTakeoverW); // Befund 2: Master-SoC-Boden/Deckel einhalten
        masterDecision = mk(effMasterW);
        slaveFellBack = true;
        fallbackLog = { key: `${sr.error}`, data: { side: 'slave', error: sr.error || null, readError: sr.readError === true, register: sr.register ?? null, wireAddress: sr.wireAddress ?? null, value: sr.value ?? null, kind: sr.kind ?? null, code: sr.code ?? null, masterW: effMasterW, text: 'Sungrow: Slave-Fehler im Split — Anteil auf den Master verlagert, der Master steuert weiter (kein Modus 0).' } };
      }
    }
    // Split-Detail für GUI/Leitstand (Aufgabe 1/2/6): Anteil, wirksame Leistungsgrenze und wirksame SoC-Grenze je
    // WR sowie Notladungs-Flag des Slave. „wirksame Grenze" = die in DIESER Richtung geltende (Laden: Decke/Max,
    // Entladen: Boden/Min). masterW/slaveW = Anteil je WR.
    const splitDetail = {
      masterW: effMasterW, slaveW: effSlaveW, strategy, charge,
      masterMaxW: masterMax, slaveMaxW: slaveMax,
      masterFloorPct, slaveFloorPct, masterCeilPct, slaveCeilPct,
      masterLimitPct: charge ? masterCeilPct : masterFloorPct,
      slaveLimitPct: charge ? slaveCeilPct : slaveFloorPct,
      slaveEmergencyCharge: slaveEmergency,
      slaveFellBack, // Aufgabe 3: Slave-Fehler → Anteil auf den Master verlagert, Master steuert weiter
      // M28: warum ein WR keinen Anteil bekommt ('soc' = an der SoC-Grenze inkl. Entlade-Marge, 'stalled' = liefert
      // seinen Anteil nicht) und wer übernimmt (Kachel: „Master an der Grenze, Slave übernimmt").
      masterOut: masterOut || null, slaveOut: slaveOut || null,
      // M28 Grundsatz 0: Anteil nach Strategie (Base), gemessene Lieferfähigkeit (nur wenn begrenzt) und das an den
      // anderen verschobene Fehlende. masterW/slaveW oben = tatsächlicher Befehl (Base + Übernahme).
      masterBaseW: masterW, slaveBaseW: slaveW,
      masterLimitW: mLim.limited ? mLim.limitW : null, slaveLimitW: sLim.limited ? sLim.limitW : null,
      transferW: transferTo && !slaveFellBack ? transferW : 0,
      ...(() => {
        if (masterOut && effSlaveW > 0) return { takeover: 'slave', takeoverReason: masterOut };
        if (slaveOut && effMasterW > 0) return { takeover: 'master', takeoverReason: slaveOut };
        if (transferTo && !slaveFellBack) return { takeover: transferTo, takeoverReason: 'partial' };
        return { takeover: null, takeoverReason: null };
      })(),
    };
    // M28: die jetzt kommandierten Anteile für die Liefert-nicht-Erkennung im nächsten Takt (nach bestätigtem Write
    // unten gültig; scheitert der Master, verworfen). Codex 07041019 (P2): beurteilt wird der Wert, der AM GERÄT steht
    // (Rücklesung bzw. unveränderter Zustand) — eine Änderung innerhalb der Schreibschwelle (stepW) geht nicht raus,
    // sonst verglich DVhub einen nie geschriebenen Befehl mit der Messung und frischte eine falsche Grenze immer neu auf.
    const devShareW = (dev, fallbackW) => {
      if (decision.command !== 'charge' && decision.command !== 'discharge') return 0;
      if (!dev) return fallbackW;
      return (Number(dev.cmd) & 0xffff) === CMD_BY_NAME[decision.command] ? Math.max(0, Number(dev.powerW) || 0) : 0;
    };
    const commandedWith = (masterDev) => ({
      direction,
      masterW: devShareW(masterDev, effMasterW),
      slaveW: skipSlave || slaveFellBack ? 0 : devShareW(slaveReadback, effSlaveW),
      at: t,
    });
    // Master-Anteil. Scheitert er → beide sicher in Self.
    let masterModeSeen = null; // Modus am Master in diesem Takt (zurückgestellter Eintritt, Codex P1)
    try {
      const mdev = (st.dev && t - st.dev.at < opts.deviceRecheckMs) ? st.dev : await readDevice(conf);
      masterModeSeen = mdev.mode;
      if (isForeignMode(mdev.mode, mdev)) throw foreignModeError(mdev.mode);
      // H-9: Master in Modus 2 ohne Forced-Besitz → mit DVhubs eigenem Anteil übernehmen (voller Write, nie „unverändert").
      const adoptMaster = needsAdoption(mdev, masterDecision, ctl.modeValue);
      // Codex 2a0f18b5 P2: führt DVhub den Slave in diesem Takt nicht (master-only, Slave-Fehler), folgt er trotzdem dem
      // Modus 2 des Masters — sein Befehl liefe unter dem übernommenen Modus weiter. Vor der Übernahme einmal auf Stopp.
      // Codex c5502afe P2: ein Slave in Notladung wird nicht kommandiert. Führt ihn die Strategie danach wieder
      // (nicht master-only), übernimmt ihn DVhub dann per Write — der Master darf jetzt übernommen werden. Bei
      // master-only führte ihn danach niemand → die Übernahme wartet, bis die Notladung vorbei ist.
      // Eintritt (Christin 21.11.2026): steht der Master nicht im Steuermodus und führt DVhub den Slave in diesem Takt
      // nicht (master-only, Notladung, Slave-Fehler), würde sein Befehl mit dem Eintritt wieder wirksam → vorher
      // Stopp bestätigen, sonst kein Eintritt. Ein in diesem Takt kommandierter Slave hat schon DVhubs Befehl.
      // Fable P2-1: steht der Master schon in DVhubs Steuermodus und führt DVhub den Slave in diesem Takt nicht (mehr),
      // wird ein nicht besessener Slave ohne bestätigten Stopp jetzt gestoppt — sonst tritt der Master zurück.
      const slaveNotLed = skipSlave || slaveFellBack;
      const enterMaster = !adoptMaster && mdev.mode !== ctl.modeValue && slaveNotLed;
      if ((adoptMaster || enterMaster) && (!slaveEmergency || slaveUncommanded)) {
        await stopSlaveBeforeTakeover(adoptMaster ? 'adopt' : 'entry', ctl.modeValue, t);
      } else if (!adoptMaster && slaveNotLed && mdev.mode === ctl.modeValue) {
        await stopSlaveBeforeTakeover('running', ctl.modeValue, t);
      }
      // Schreibdrossel (N4/Aufgabe 5): Master 13051 nur bei Befehlswechsel, 13052 nur bei Änderung > stepW — und das
      // Log sungrow_ems_split_write NUR bei echtem Write (im Feld lief es jede Sekunde, /api/log reichte ~3 min).
      // Bei gap (Herzschlag-Lücke/Wiederaufnahme) immer voll schreiben.
      if (!gap && !adoptMaster && emsMatches(mdev, masterDecision, opts.stepW, ctl.modeValue)) {
        st.error = null;
        st.splitLast = commandedWith(mdev);
        st.decision = { ...decision, at: t, trigger: reason, split: splitDetail };
        // Hat der Slave in diesem Takt geschrieben, ist es ein echter Write → protokollieren; sonst stiller Takt.
        if (slaveWrote) pushLog('sungrow_ems_split_write', { command: decision.command, systemW: decision.powerW, masterW: effMasterW, slaveW: effSlaveW, strategy, slaveFellBack, side: 'slave', reason: decision.reason, trigger: reason, readback: { mode: mdev.mode, cmd: mdev.cmd, powerW: mdev.powerW } });
        logFallback(true);
        publish();
        return { ok: true, split: true, unchanged: !slaveWrote, decision, masterW: effMasterW, slaveW: effSlaveW, slaveFellBack };
      }
      const foundMaster = adoptMaster ? adoptionFound(mdev) : null;
      const back = await writeDecision(conf, masterDecision, { modeValue: ctl.modeValue, heartbeatS: ctl.heartbeatTimeoutS, forceAll: gap, adopt: adoptMaster, heartbeatAfterMode: ctl.heartbeatAfterMode, heartbeatWriteFc: ctl.heartbeatWriteFc, acceptDeviceHeartbeatS: ctl.acceptDeviceHeartbeatS });
      if (foundMaster) logAdoption(foundMaster, masterDecision);
      logFallback(true);
      st.error = null; st.logKeys = {};
      st.splitLast = commandedWith(back);
      st.decision = { ...decision, at: t, trigger: reason, split: splitDetail };
      pushLog('sungrow_ems_split_write', { command: decision.command, systemW: decision.powerW, masterW: effMasterW, slaveW: effSlaveW, transferW: splitDetail.transferW, strategy, slaveFellBack, reason: decision.reason, trigger: reason, readback: { mode: back.mode, cmd: back.cmd, powerW: back.powerW } });
      publish();
      return { ok: true, split: true, decision, masterW: effMasterW, slaveW: effSlaveW, slaveFellBack };
    } catch (e) {
      // Der MASTER ist nicht sicher steuerbar → beide sicher in Self (Modus 0). Das ist der EINZIGE Weg zu Modus 0 im
      // Split (ein Slave-Fehler fuehrt oben nur auf Master-only, Aufgabe 3).
      st.splitLast = null; // M28: nichts kommandiert, die Erkennung ruht
      logFallback(false);
      // Not-Halt kam während des Takts (Write gesperrt): hier nichts zurücknehmen. Der Not-Halt-Durchgang
      // (emergencyStop, läuft seriell danach) nimmt DVhubs eigenen Betrieb genau einmal zurück; einen nicht
      // übernommenen Modus 2 fasst er nicht an (Codex 2a0f18b5 P1, A.6: nur bei Besitz, ein Durchgang).
      if (e?.code === 'emergency_stop_active') {
        st.dev = null;
        publish();
        return { ok: false, blocked: true, error: 'emergency_stop_active' };
      }
      if (e?.code === 'entry_slave_unconfirmed') return await deferEntry(conf, ctl, e, t, masterModeSeen);
      if (e?.code === 'running_slave_unconfirmed') return await stepBackForSlave(conf, ctl, e, t);
      // Codex 0cc625c7 P1: den gemerkten Master-Zustand verwerfen (wie bisher im Fehlerzweig) — sonst schrieben der nächste
      // Takt und writeDecision mit dem alten Modus 2 an einen inzwischen fremd gesteuerten Master.
      if (e?.code === 'adopt_slave_unconfirmed') { st.dev = null; return entryDeferred(e, t, { adopt: true }); }
      await neutralizeBoth('split_master_failed');
      st.error = e?.message || String(e);
      logOnce(st.error, e?.code === 'foreign_ems_mode' ? 'sungrow_ems_foreign_mode' : 'sungrow_ems_split_aborted', { side: 'master', error: st.error, ...writeErrorInfo(e) }, 'warn');
      st.decision = { mode: 'self', reason: 'split_master_failed', at: t };
      publish();
      return { ok: false, readError: e?.code === 'heartbeat_mismatch' || e?.code === 'ems_read_error', error: st.error };
    }
  }

  // Netzlade-Verbot universell am Aktuator erzwingen (D, Ref d54a3fab, rechtlich EEG/MiSpeL): es hängt NICHT an der
  // Quelle oder an einem durchgereichten noGridCharge-Flag (das verliert sich im Feld, z. B. bei der Override-
  // Neuanwendung). Solange der Nutzer das Netzladen nicht ausdrücklich freigegeben hat (optimizer.allowGridCharge),
  // lädt der Regler für JEDES Ziel und jeden Takt (auch manual_override, Regeln, EOS) nur aus dem PV-Überschuss.
  // Ein durchgereichtes Flag/eos_grid_hold kann nur zusätzlich verschärfen, nie lockern. Gilt für Forced UND External.
  function noGridChargeForce() {
    const cfg = getCfg();
    return cfg?.optimizer?.allowGridCharge !== true
      || st.target?.noGridCharge === true || NO_GRID_CHARGE_SOURCES.has(String(st.target?.source));
  }

  // Dauer-Forced-Split (Christin 14./15.11.): Bei Forced mode (Modus 2) läuft DVhub DAUERHAFT in Modus 2. Der Master
  // wird EINMAL beim Eintritt auf 13050=2 gestellt und bleibt dort (kein Wechsel 0↔2 im Tagesverlauf); Vorgaben
  // ändern nur Befehl/Leistung je WR, nie den Modus.
  // NEUE REGEL (Christin 15.11.): Im Forced mode gibt es KEIN „Stopp" als Ruhezustand. Die Regelschleife läuft
  // IMMER auf den Netz-Sollwert; fehlt eine Vorgabe (kein/zurückgenommener Sollwert), regelt DVhub auf den
  // Standard-Puffer schedule.defaultGridSetpointW (≈ −40/0 W, neutral) weiter — PV-Überschuss wird geladen, ein
  // Defizit entladen. KEIN band-/no_setpoint/revoked-Dauerstopp mehr. 0xCC entsteht nur taktweise, wenn der
  // Regler |p| < minPowerW rechnet (decideEmsCommand → forced/stop), und gilt nur für diesen Takt.
  // Absicherungsfälle (Messwerte/Sollwert veraltet) → NICHT Stopp in Modus 2, sondern Rückgabe an den WR
  // (Modus 0, Absicherung C), damit er selbst weiterregelt. Modus 0 außerdem bei Not-Halt, Beenden/Ausfall,
  // abgeschalteter Steuerung, fremdem Modus oder Moduswechsel — nie ein Dauerstopp in Modus 2.
  async function stepForced({ conf, ctl, opts, reason, t, targetFresh, maxChargeCap, maxDischargeCap, tel, second }) {
    // Ein gemerkter Wiedereintritt gilt nur für den Takt, der ihn zählte (Review 156a3e06 P3): scheiterte er, meldet ein
    // späterer gewöhnlicher Eintritt keinen Wiedereintritt.
    st.reentryLogPending = null;
    const noGridChargeNow = noGridChargeForce();
    const cfg = getCfg();
    // Entlade-Boden (SoC < Boden): sperrt im Regler nur das Entladen, nicht das Laden aus PV. M1: der Boden ist der
    // effektive Entlade-Boden real % — max(hardFloor, geräteMin 13059 + Puffer); der SoC wird vor dem Vergleich vom
    // fensterrelativen gemeldeten Wert in den echten SoC umgerechnet (Einzel-WR; im Split sitzt die Grenze je WR im
    // Split-Gate). Ohne gelesenes Gerätefenster bleibt es beim harten Boden bzw. gemeldeten Wert (rückwärtskompatibel).
    const emsDev = state.victron?.device || {};
    const floorSocPct = sungrowDischargeFloorPct(Number(cfg?.optimizer?.hardFloorSocPct ?? 5), emsDev.minSocPctDevice, sungrowSocFloorBufferPct(cfg));
    const socPct = sungrowRealSocPct(state.victron?.sungrowMasterSocPct ?? state.victron?.soc ?? null, emsDev.minSocPctDevice, emsDev.maxSocPctDevice);
    // N1 (Feld 15.11., gefährlich): im SPLIT den System-Entlade-Boden NICHT am Master-SoC prüfen. Sonst stoppt
    // decideEmsCommand bei Master 9,8 % die GANZE Vorgabe (beide WR 0xCC), obwohl der Slave noch 14,4 % hat →
    // Hauslast komplett aus dem Netz, Slave-Reserve ungenutzt. Die je-WR-Grenze sitzt im Split-Gate
    // (splitStrategyShares, Aufgabe 1): der WR an SEINER Grenze liefert 0 W, der andere übernimmt. Sind BEIDE am
    // Boden, sperrt das Gate beide → Stopp. Einzel-WR (kein Split): weiter der Master-Boden. Unbekannter/veralteter
    // SoC bleibt über releaseForFloor (Modus 0) abgesichert.
    const isSplit = !!(slaveActuator && second != null);
    const exportBlocked = feedInBlocked(); // M25: während einer Sperre nur fürs Haus entladen
    // M25 (Christin 19.11.): Test-Knopf „Akku nicht laden" sperrt NUR das Laden: Laden 0 (wäre Laden nötig → Stopp,
    // Modus 2 bleibt), Entladen fürs Haus bleibt erlaubt (höchstens die Netto-Last), beide WR nach der Aufteilung.
    // Selbst-ablaufend über das Lease des Tests.
    const chargeBlocked = curtailmentBatteryHold();
    // 4b: positiven Sollwert zusätzlich hart auf die Anschlussgrenze deckeln (Netzladen ≤ limitKw).
    const gridLimitW = Number(cfg?.gridConnection?.limitKw) > 0 ? Number(cfg.gridConnection.limitKw) * 1000 : null;
    const clampGrid = (s) => (gridLimitW != null && Number.isFinite(Number(s)) && Number(s) > gridLimitW ? gridLimitW : s);
    const regulate = (setpointW) => decideEmsCommand({
      setpointW: clampGrid(setpointW), ...tel, maxChargeW: maxChargeCap, maxDischargeW: maxDischargeCap,
      bandW: 0, gain: opts.gain, minPowerW: opts.minPowerW, noGridCharge: noGridChargeNow,
      forced: true, socPct: isSplit ? null : socPct, floorSocPct: isSplit ? null : floorSocPct,
      dischargeLoadOnly: exportBlocked || chargeBlocked, noCharge: chargeBlocked,
    });
    let decision;
    if (targetFresh && st.target.releaseForFloor) {
      // Entlade-Boden wegen unbekanntem/veraltetem SoC (Absicherung C): an den WR zurückgeben (Modus 0), nicht
      // mit unsicherem SoC weiterregeln. Laden aus PV läuft dann über die geräteeigene Self-consumption.
      decision = { mode: 'self', reason: 'discharge_floor_release' };
    } else if (targetFresh) {
      // Frischer Sollwert → regeln (kein Band-Ruhezustand; s = 0 wird geregelt).
      decision = regulate(st.target.setpointW);
    } else if (st.target) {
      // Sollwert veraltet (Absicherung C): sicher an den WR zurückgeben (Modus 0), nicht blind weiterregeln.
      decision = { mode: 'self', reason: 'target_expired' };
    } else {
      // Kein/zurückgenommener Sollwert → Standard-Puffer, in Modus 2 WEITERREGELN (kein Dauer-Stopp).
      const dflt = Number(cfg?.schedule?.defaultGridSetpointW);
      decision = regulate(Number.isFinite(dflt) ? dflt : 0);
    }
    const ownsForced = st.owns && st.ownMode === EMS_MODE.FORCED;
    // Moduswechsel zur Laufzeit von External EMS (Modus 3) auf Forced: DVhub besitzt noch Modus 3 → erst sauber in
    // Self-consumption (Modus 0), der Forced-Eintritt folgt im nächsten Takt (kein direkter 3→2-Sprung).
    if (st.owns && st.ownMode !== EMS_MODE.FORCED) {
      decision = { mode: 'self', reason: 'mode_switch' };
    }
    // Codex cd9b71c6 (P2): Test-Knopf „Akku nicht laden" + Absicherungsfall (Messwerte/Sollwert veraltet, SoC unbekannt
    // → 'self'): Modus 0 ließe den WR den PV-Überschuss selbst laden, obwohl der Test „Laden gesperrt" meldet. Solange
    // der Test läuft (selbst-ablaufendes Lease), bleibt Modus 2 mit Stopp — wie vor M25. Ein Moduswechsel geht vor.
    // Codex f0967031 (P2): Modus 2 nur halten, wenn der Slave (falls angebunden) den Stopp BESTÄTIGT — sonst bliebe ein
    // unerreichbarer Slave auf seinem alten Befehl, während der Master in Modus 2 steht. Dann lieber der Rückfall in
    // Modus 0 (der Slave folgt dem Master und lässt den Befehl fallen). Codex 85c8309c (P2): bestätigt wird erst NACH
    // der Fremd-EMS-Prüfung am Master (unten im try) — ein fremd gesteuerter Slave bekommt keinen Write.
    let holdFallback = null;
    if (chargeBlocked && ownsForced && decision.mode === 'self') {
      holdFallback = decision;
      decision = { mode: 'forced', command: 'stop', powerW: 0, reason: 'charge_blocked_hold' };
    }
    // KEIN Dauer-Stopp mehr bei band/no_setpoint/revoked (Christin 15.11.): alle verbliebenen 'self'-Gründe
    // (telemetry_missing, power_limit_unknown, target_expired, mode_switch) sind Absicherungsfälle → Rückgabe an
    // den WR (Modus 0, Absicherung C) über den Self-Pfad unten. Das 0xCC bei |p| < minPowerW bleibt mode:'forced'
    // (Modus 2 bleibt) und gilt nur taktweise.
    // Merker-Start-Reset (C3): erster Forced-Takt nach einem Neustart mit Forced-Merker → den Akku-Befehl zuerst auf
    // 0xCC (Modus 2 bleibt), damit ein stehengebliebener Lade-/Entladebefehl nicht über den ersten Takt hinaus
    // läuft. Nur, wenn DVhub Forced wirklich besitzt und steuert (nicht bei Moduswechsel/stale-Rückfall in Self).
    if (st.startupResetPending && ownsForced && decision.mode === 'forced') {
      decision = { mode: 'forced', command: 'stop', powerW: 0, reason: 'startup_reset' };
      st.startupResetPending = false;
      logOnce('startup-reset', 'sungrow_ems_startup_reset', { text: 'Sungrow: nach Neustart mit Forced-Merker den Akku-Befehl einmal auf 0xCC zurückgesetzt (Modus 2 bleibt), bevor neu geregelt wird.' });
    } else if (st.startupResetPending && decision.mode === 'self') {
      st.startupResetPending = false; // in Self/Modus 0 ohnehin kein stehengebliebener Befehl mehr
    }
    // Feldtest „Akku nicht laden" (services/curtailment-test.js, M14b/M25): sperrt nur noch das LADEN (im Regler oben,
    // noCharge) — kein Dauer-0xCC beider WR mehr. Feld 19.11.: mit beiden WR auf 0xCC kam die Hauslast aus dem Netz,
    // obwohl der Sollwert −40 W war und die Akkus 13–15 % hatten.
    st.decision = { ...decision, at: t, trigger: reason };
    st.selfBridgeSince = 0;
    st.externalEnteredAt = 0;
    let masterModeSeen = null; // Modus am Master in diesem Takt (zurückgestellter Eintritt, Codex P1)
    try {
      // Gerätezustand höchstens alle deviceRecheckMs neu lesen (Note 6: RW-Register nicht im Sekundentakt lesen);
      // zwischendurch die Rücklesung der eigenen Writes nutzen. So fällt ein geräteeigener Rückfall auf Modus 0
      // (WR-Neustart) spätestens nach deviceRecheckMs auf — der Akku steht bis dahin im sicheren Eigenverbrauch.
      const dev = (st.dev && t - st.dev.at < opts.deviceRecheckMs) ? st.dev : await readDevice(conf);
      masterModeSeen = dev.mode;
      // Fremder Modus (VPP, oder Modus 3 ohne DVhub-Besitz) → nicht übersteuern (B4). Modus 2 ohne Besitz übernimmt
      // DVhub per eigenem Write (H-9, needsAdoption unten bzw. in stepSplit).
      if (isForeignMode(dev.mode, dev)) throw foreignModeError(dev.mode);
      if (holdFallback) {
        let slaveStopped = true;
        if (slaveActuator && resolveSecondInverter(cfg).enabled) {
          try {
            const sr = await commandSlave({ mode: 'forced', command: 'stop', powerW: 0, reason: 'charge_blocked_hold' }, ctl);
            slaveStopped = sr?.ok === true;
          } catch { slaveStopped = false; }
        }
        if (!slaveStopped) {
          logOnce('hold-slave', 'sungrow_ems_charge_hold_slave_unconfirmed', { reason: holdFallback.reason, text: 'Sungrow: „Akku nicht laden" — der Slave bestätigt den Stopp nicht, deshalb Rückfall in Modus 0 statt Halten in Modus 2.' }, 'warn');
          decision = holdFallback;
          st.decision = { ...decision, at: t, trigger: reason };
        }
      }
      // Wiedereintritt (B3): DVhub besitzt Forced, der Master steht aber von selbst in Modus 0 → er ist von selbst
      // zurückgefallen (WR-Neustart/Firmware/Netzfehler). EINMAL neu eintreten (die Writes unten setzen 13050=2
      // neu). Bei zu vielen Wiedereintritten/Stunde das Mode-Register (13050) schonen: nicht mehr eintreten, Modus 0
      // lassen, Warnung — sonst würde DVhub 13050 immer wieder hin- und herschreiben, wenn der WR es nicht hält.
      if (ownsForced && decision.mode === 'forced' && dev.mode === EMS_MODE.SELF) {
        st.forcedReentryTimes = [...(st.forcedReentryTimes || []), t].filter((x) => t - x < 3600000);
        if (st.forcedReentryTimes.length > FORCED_REENTRY_MAX_PER_HOUR) {
          st.decision = { mode: 'self', reason: 'reentry_rate', at: t };
          logOnce('reentry-rate', 'sungrow_ems_reentry_rate', { count1h: st.forcedReentryTimes.length, text: 'Sungrow fällt wiederholt von selbst aus dem Forced mode in Modus 0 zurück (>6/Stunde) — DVhub tritt vorerst nicht wieder ein (13050-Budget), der Akku bleibt im Eigenverbrauch (Modus 0). Firmware/Verkabelung prüfen.' }, 'warn');
          publish();
          return { ok: false, error: 'reentry_rate' };
        }
        // Gemeldet wird der Wiedereintritt erst, wenn er wirklich geschrieben ist (writeDecision) — ein zurückgestellter
        // Takt ist keiner (Fable P3-3).
        st.reentryLogPending = st.forcedReentryTimes.length;
      }
      // Lebenszeichen für den Box-Watchdog (C4): DVhub fährt den Forced mode aktiv (Befehl, nicht Rückfall) → die
      // Zeitstempel-Datei auffrischen, auch wenn in diesem Takt nichts geschrieben wird (ausgeregelt).
      if (decision.mode === 'forced') touchForcedHeartbeat();
      // Split (zwei WR mit aggregierter, frischer Slave-Telemetrie) oder Einzel-WR (alles am Master).
      if (slaveActuator && second != null) {
        return await stepSplit({ conf, ctl, decision, gap: false, second, reason, t, opts });
      }
      // Slave-Telemetrie fehlt (offline/veraltet/nicht aggregiert), DVhub steuert aber weiter (Einzel-WR am Master):
      // einen zuvor von DVhub gesetzten Slave-Befehl sicher zurücknehmen (0xCC). Sonst hielte der Slave im Forced
      // mode (ohne geräteeigenen Rückfall) seinen letzten Lade-/Entladebefehl unbeaufsichtigt — die SoC-Grenzen aus
      // stepSplit greifen nicht mehr (Review-Befund 1). neutralize ist ein No-op, wenn der Slave nicht besessen ist.
      if (slaveActuator) { st.slaveNeutralizeTick = t; try { await slaveActuator.neutralize('slave_telemetry_lost'); } catch { /* best effort */ } }
      if (decision.mode === 'self') {
        // Nur Einzel-WR, nicht besitzend: der Zustand passt schon (Gerät steht in Self), nichts schreiben.
        if (emsMatches(dev, decision, 0, ctl.modeValue)) { st.error = null; publish(); return { ok: true, unchanged: true, decision }; }
        await writeDecision(conf, decision, { modeValue: ctl.modeValue });
        setOwns(null);
        st.error = null; publish();
        return { ok: true, decision };
      }
      // H-9: ein gefundener Modus 2 ohne Forced-Besitz wird mit DVhubs eigenem Befehl übernommen — nie „unverändert".
      const adopt = needsAdoption(dev, decision, ctl.modeValue);
      // Der Slave wird hier nicht geführt und folgt dem Master-Modus 2: im eigenen Betrieb (Fable P2-1, auch vor einem
      // „unverändert"), vor der Übernahme (Codex 2a0f18b5 P2) und vor dem Eintritt aus Modus 0 (Christin 21.11.2026)
      // seinen Befehl auf Stopp bestätigen.
      if (!adopt && dev.mode === ctl.modeValue) await stopSlaveBeforeTakeover('running', ctl.modeValue, t);
      if (!adopt && emsMatches(dev, decision, opts.stepW, ctl.modeValue)) {
        st.error = null; publish();
        return { ok: true, unchanged: true, decision };
      }
      if (adopt) await stopSlaveBeforeTakeover('adopt', ctl.modeValue, t);
      else if (dev.mode !== ctl.modeValue) await stopSlaveBeforeTakeover('entry', ctl.modeValue, t);
      const found = adopt ? adoptionFound(dev) : null;
      const back = await writeDecision(conf, decision, { modeValue: ctl.modeValue, adopt });
      if (found) logAdoption(found, decision);
      st.error = null; st.logKeys = {};
      pushLog('sungrow_ems_write', {
        setpointW: st.target?.setpointW ?? null, source: st.target?.source ?? null, controlMode: ctl.mode,
        mode: decision.mode, command: decision.command || null, powerW: decision.powerW ?? null,
        reason: decision.reason, trigger: reason, readback: { mode: back.mode, cmd: back.cmd, powerW: back.powerW },
      });
      publish();
      return { ok: true, decision };
    } catch (e) {
      st.error = e?.message || String(e);
      if (e?.code === 'foreign_ems_mode') {
        logOnce(String(e.mode), 'sungrow_ems_foreign_mode', { mode: e.mode, text: 'Sungrow steht im External-EMS-/VPP-Modus eines anderen Systems — DVhub schreibt nichts' }, 'warn');
      } else if (e?.code === 'emergency_stop_active') {
        st.dev = null; publish();
        return { ok: false, blocked: true, error: 'emergency_stop_active' };
      } else if (e?.code === 'entry_slave_unconfirmed') {
        return await deferEntry(conf, ctl, e, t, masterModeSeen);
      } else if (e?.code === 'running_slave_unconfirmed') {
        return await stepBackForSlave(conf, ctl, e, t);
      } else if (e?.code === 'adopt_slave_unconfirmed') {
        st.dev = null; // Codex 0cc625c7 P1: frisch lesen, bevor die Übernahme fortgesetzt wird
        return entryDeferred(e, t, { adopt: true });
      } else if (e?.code === 'ems_read_error') {
        st.dev = null;
        logOnce(st.error, 'sungrow_ems_read_error', { error: st.error, decision }, 'warn');
        publish();
        return { ok: false, readError: true, error: st.error };
      } else {
        st.dev = null;
        logOnce(st.error, e?.code === 'readback_mismatch' ? 'sungrow_ems_readback_mismatch' : 'sungrow_ems_error', { error: st.error, decision }, 'warn');
      }
      publish();
      return { ok: false, error: st.error };
    }
  }

  async function step({ reason = 'tick' } = {}) {
    const cfg = getCfg();
    const conf = sungrowEmsConf(cfg);
    if (!conf || transport?.type !== 'modbus') return { ok: false, error: 'sungrow_ems_not_configured' };
    syncEndpoint(cfg);
    if (state.ctrl?.discretionaryWritesPaused) return { ok: false, blocked: true, error: 'emergency_stop_active' };
    // Option A: steht eine manuelle Freigabe aus (Master oder Slave), regelt DVhub nicht — kein Befehl, keine
    // Leistung, kein Herzschlag. Die Wiederholung läuft in tick(); DVhubs Modus bleibt DVhubs (nicht „fremd").
    if (releasePendingAny()) { publish(); return releasePendingResult(); }
    const gate = deviceGate(cfg);
    if (gate) {
      st.error = gate;
      publish();
      return { ok: false, error: gate };
    }
    const opts = resolveSungrowEmsOptions(conf);
    const ctl = resolveSungrowControl(cfg);
    const t = now();
    markStep();
    // (1d) Sperre ohne Neustart lösen: ändert der Betreiber die Herzschlag-Frist oder die Schreibfunktion (FC),
    // die External-EMS-Sperre und die gemerkte FC zurücksetzen — der nächste Takt probiert es neu.
    const hbSig = `${ctl.heartbeatTimeoutS}:${ctl.heartbeatWriteFc ?? 'auto'}:${ctl.acceptDeviceHeartbeatS}`;
    if (st.hbCfgSig != null && st.hbCfgSig !== hbSig) {
      st.hb = { key: null, supported: null, workingFc: null, deviceManaged: false };
      pushLog('sungrow_ems_heartbeat_config_changed', { text: 'Herzschlag-Einstellung geändert — External-EMS-Sperre zurückgesetzt, neuer Versuch.' });
    }
    st.hbCfgSig = hbSig;
    const targetFresh = st.target && t - st.target.at <= opts.targetMaxAgeMs;
    // Zweiter WR (Parallelbetrieb): PV/Akku/Last/SoC sind in state.victron bereits die Systemsumme (der Poller
    // aggregiert sie bei aggregateTelemetry, polling.js), deshalb liest der Regler sie hier UNVERÄNDERT — NICHT
    // noch einmal selbst dazuzählen (sonst Akku doppelt, Codex). Vom zweiten WR braucht der Regler nur die
    // BDC-Nennleistung für die System-Leistungsgrenze; der Master verteilt die eine EMS-Vorgabe intern.
    const tel = telemetry(cfg, opts);
    const second = secondInverterTelemetry(state, cfg, { nowMs: t, maxAgeMs: opts.telemetryMaxAgeMs });
    const masterBdc = Number(state.victron.device.bdcRatedW) || null;
    // System-Leistungsgrenze nur anheben, wenn BEIDE BDC-Nennleistungen bekannt sind. Fehlt die des Masters,
    // bleibt die Grenze unbekannt (→ Self-consumption wie ohne zweiten WR), statt mit halbem Wissen zu forcieren.
    const bdc = second?.bdcRatedW && masterBdc ? masterBdc + second.bdcRatedW : masterBdc;
    // Leistungsgrenze = Kleinste aus: Summe der Akku-Lade-/Entladeleistungen je WR (Punkt 2), BDC-Nennleistung
    // (Summe beider WR), Profil-Grenze und der Betreiber-Einstellung sungrow.maxPowerW. Letztere gilt für ALLE
    // Quellen (EOS, Regeln, §14a, Netzanschluss, Hand-Sollwert), weil sie hier im Aktuator begrenzt (Punkt 4).
    // Laden und Entladen getrennt; Slave nicht einbezogen (offline) → nur der Master-Anteil.
    const operatorMaxW = Number(cfg.sungrow?.maxPowerW) > 0 ? Number(cfg.sungrow.maxPowerW) : null;
    const optMaster = cfg.optimizer || {};
    const si = cfg.sungrow?.secondInverter || {};
    const sumChargeW = (Number(optMaster.maxChargeW) || 0) + (second ? (Number(si.maxChargeW) || 0) : 0);
    const sumDischargeW = (Number(optMaster.maxDischargeW) || 0) + (second ? (Number(si.maxDischargeW) || 0) : 0);
    // Hausanschluss (Aufgabe 4): das Netzladen beider WR darf die Anschlussgrenze (gridConnection.limitKw, z. B.
    // 28 kW) nicht überschreiten. Defense-in-depth AM AKTUATOR — der Netz-Sollwert wird zwar schon in applyControl-
    // Target auf die Wächter-Decke geklemmt (schedule-eval), aber der Akku-Ladecap wird hier zusätzlich hart auf die
    // rohe Anschlussgrenze gedeckelt (gilt für ALLE Quellen). Nur Laden (Netzbezug); Entladen/Einspeisung hat eine
    // eigene Grenze (gridConnectionExportLimitW).
    const gridLimitW = Number(cfg?.gridConnection?.limitKw) > 0 ? Number(cfg.gridConnection.limitKw) * 1000 : null;
    const capFor = (sumPower, extra = null) => {
      const cands = [bdc, opts.maxPowerW, operatorMaxW, sumPower, extra].filter((x) => Number(x) > 0);
      return cands.length ? Math.min(...cands) : null;
    };
    const maxChargeCap = capFor(sumChargeW, gridLimitW);
    const maxDischargeCap = capFor(sumDischargeW);
    // Forced mode (Modus 2): Dauer-Forced-Split über den eigenen Pfad — der Master bleibt in Modus 2, DVhub
    // regelt im Takt. External EMS (Modus 3) läuft weiter über die bestehende Logik unten (Herzschlag, Rückfall).
    if (ctl.modeValue === EMS_MODE.FORCED) {
      return await stepForced({ conf, ctl, opts, reason, t, targetFresh, maxChargeCap, maxDischargeCap, tel, second });
    }
    let decision = targetFresh
      ? decideEmsCommand({
        setpointW: st.target.setpointW, ...tel, maxChargeW: maxChargeCap, maxDischargeW: maxDischargeCap,
        bandW: opts.bandW, gain: opts.gain, minPowerW: opts.minPowerW,
        noGridCharge: noGridChargeForce(), dischargeLoadOnly: feedInBlocked()
      })
      : { mode: 'self', reason: st.target ? 'target_expired' : (st.revokedReason ? 'revoked' : 'no_setpoint') };
    let masterModeSeen = null; // Modus am Master in diesem Takt (zurückgestellter Eintritt, Codex P1)
    try {
      if (ctl.mode === 'external' && decision.mode === 'forced' && !(await heartbeatSupported(conf))) {
        // Ohne Herzschlag kein External EMS. Kein stiller Rückfall auf Forced mode (der hat keinen Rückfall
        // des Wechselrichters): DVhub lädt/entlädt nicht. Zurück in Self-consumption geht immer — so wird auch
        // ein liegengebliebener Zwangsbetrieb (ältere Einstellung, Neustart ohne Merker) wieder frei (Codex ff728d09).
        if (!st.owns) {
          st.decision = { ...decision, at: t, trigger: reason, blockedBy: 'heartbeat_unsupported' };
          st.error = 'sungrow_heartbeat_unsupported';
          publish();
          return { ok: false, error: 'sungrow_heartbeat_unsupported' };
        }
        decision = { mode: 'self', reason: 'heartbeat_unsupported' };
      }
      // Moduswechsel zur Laufzeit: erst sauber in Self-consumption, der neue Modus folgt im nächsten Takt.
      if (st.owns && st.ownMode !== ctl.modeValue && decision.mode === 'forced') decision = { mode: 'self', reason: 'mode_switch' };
      st.decision = { ...decision, at: t, trigger: reason };
      // Herzschlag-Lücke (DVhub hing, Neustart mit Merker): der Wechselrichter kann schon in Self-consumption
      // zurückgefallen sein — frisch lesen und den ganzen Befehl neu setzen.
      const ownsExternal = st.owns && st.ownMode === EMS_MODE.EXTERNAL;
      // Übergangs-Prinzip (Christin, Punkt 1): External EMS ist der gewünschte Betrieb, solange DVhub überhaupt steuert.
      // Ein kurzes Loch (Sollwert im Band / kurz kein Sollwert) NICHT mit einem Moduswechsel quittieren, sondern in
      // External EMS bleiben und den Akku auf 0 W (Stopp) setzen. Erst bei LÄNGEREM Eigenverbrauch (≥ SELF_RELEASE_MS)
      // zurück in Modus 0, damit der Akku wieder dem Eigenverbrauch folgt. So kein Mode-Flattern (Hysterese).
      // Nur für External EMS und nur bei „normalem" Self (Band/kein Sollwert) — Not-Halt, Widerruf, fehlender
      // Herzschlag und Moduswechsel gehen weiter direkt in Self zurück.
      const bridgeableSelf = decision.mode === 'self'
        && (decision.reason === 'band' || decision.reason === 'target_expired' || decision.reason === 'no_setpoint');
      // Schreibbudget 13050 (Punkt 2): nach ≤20 Moduswechseln/Tag nicht mehr wechseln, bis Mitternacht — im Modus
      // bleiben. Not-Halt/Widerruf (eigene Pfade, neutralize) und die Herzschlag-Lücke (gap, Wiederaufnahme) sind aus.
      const modeBudgetOut = modeBudgetLeft() <= 0;
      if (ownsExternal && ctl.modeValue === EMS_MODE.EXTERNAL && bridgeableSelf) {
        if (!st.selfBridgeSince) st.selfBridgeSince = t;
        const holdForBudget = modeBudgetOut; // Budget erschöpft → nicht zurück in Modus 0
        if (holdForBudget || t - st.selfBridgeSince < SELF_RELEASE_MS) {
          decision = { mode: 'forced', command: 'stop', powerW: 0, reason: holdForBudget ? 'mode_budget_hold' : 'bridge_idle' };
          st.decision = { ...decision, at: t, trigger: reason };
          if (holdForBudget) logOnce('mode-budget', 'sungrow_ems_mode_budget', { writesToday: MODE_WRITES_PER_DAY - modeBudgetLeft(), text: 'Sungrow: Tagesbudget für Moduswechsel (13050, ≤20) erreicht — DVhub bleibt bis Mitternacht im aktuellen Modus (Akku 0 W statt Eigenverbrauch).' }, 'warn');
        }
        // sonst: länger Eigenverbrauch → decision bleibt 'self' → unten Rückkehr in Modus 0 (owns wird freigegeben).
      } else {
        st.selfBridgeSince = 0;
        // Budget erschöpft und für einen Befehl müsste erst der Modus gewechselt werden (aktuell Self) → im Self bleiben.
        if (modeBudgetOut && decision.mode === 'forced' && !st.owns) {
          decision = { mode: 'self', reason: 'mode_budget' };
          st.decision = { ...decision, at: t, trigger: reason };
          logOnce('mode-budget', 'sungrow_ems_mode_budget', { writesToday: MODE_WRITES_PER_DAY - modeBudgetLeft(), text: 'Sungrow: Tagesbudget für Moduswechsel (13050, ≤20) erreicht — DVhub bleibt bis Mitternacht im Eigenverbrauch (keine neue Lade-/Entlade-Vorgabe an den WR).' }, 'warn');
        }
      }
      // Frist, die im Gerät wirklich gilt: die zuletzt geschriebene, bis eine neue rausging (Codex ff728d09).
      const deviceTimeoutS = Math.min(ctl.heartbeatTimeoutS, st.sentTimeoutS ?? ctl.heartbeatTimeoutS);
      const gap = ownsExternal && decision.mode === 'forced'
        && (!st.lastHeartbeatAt || t - st.lastHeartbeatAt > deviceTimeoutS * 1000);
      if (gap) {
        st.dev = null;
        logOnce(String(st.lastHeartbeatAt), 'sungrow_ems_heartbeat_gap', { lastHeartbeatAt: st.lastHeartbeatAt || null, timeoutS: ctl.heartbeatTimeoutS }, 'warn');
      }
      // Gerätezustand nur nach eigenen Writes und höchstens einmal je deviceRecheckMs lesen (Note 6);
      // so fällt ein Neustart des Wechselrichters oder ein Eingriff über die App auf.
      // Solange DVhub External EMS besitzt, den Gerätezustand in JEDEM Takt frisch lesen — sonst bliebe ein
      // geräteeigener Rückfall (Modus 0) bis deviceRecheckMs unbemerkt (Punkt 3). Sonst wie bisher gecacht.
      const dev = (st.dev && t - st.dev.at < opts.deviceRecheckMs && !ownsExternal) ? st.dev : await readDevice(conf);
      masterModeSeen = dev.mode;
      if (isForeignMode(dev.mode, dev)) throw foreignModeError(dev.mode);
      // (3b) Geräte-Rückfall: DVhub besitzt External EMS, der WR steht aber in Self-consumption → er ist von
      // selbst zurückgefallen (Lebenszeichen zu selten / 13080 nicht beschreibbar). Zeit messen + melden
      // (sungrow_ems_device_fallback, nicht readback_mismatch); (3c) bei >3 Rückfällen/min nicht wieder eintreten.
      // Nur bei bestätigtem External-Eintritt (externalEnteredAt gesetzt): so wird EIN Rückfall genau einmal gezählt
      // und der WR nicht in jedem Folgetakt erneut als „Rückfall" gewertet — sonst bliebe die Neueintritt-Sperre ewig
      // stehen. Eine Herzschlag-Lücke (gap, Neustart mit externalEnteredAt=0) ist kein Rückfall, sondern Wiederaufnahme.
      if (ownsExternal && decision.mode === 'forced' && dev.mode === EMS_MODE.SELF && st.externalEnteredAt && !gap) {
        const afterS = Math.round((t - st.externalEnteredAt) / 1000);
        if (afterS > 0) st.lastFallbackAfterS = afterS;
        st.lastFallbackAt = t;
        st.fallbackTimes = [...(st.fallbackTimes || []), t].filter((x) => t - x < 60000);
        logOnce(String(afterS), 'sungrow_ems_device_fallback', { afterS, side: 'master', count60s: st.fallbackTimes.length }, 'warn');
        st.externalEnteredAt = 0;
        st.lastKeepaliveAt = 0;
        if (st.fallbackTimes.length > 3) {
          st.fallbackCooldownUntil = t + FALLBACK_COOLDOWN_MS; // Mode-Register nicht weiter thrashen — WR zur Ruhe kommen lassen
          st.decision = { mode: 'self', reason: 'device_fallback_rate', at: t };
          logOnce('rate', 'sungrow_ems_device_fallback_rate', { text: 'Sungrow fällt wiederholt selbst aus External EMS zurück (>3/min) — DVhub steuert vorerst nicht; Keepalive-Register (sungrow.keepaliveRegister) oder Firmware prüfen.' }, 'warn');
          publish();
          return { ok: false, error: 'device_fallback_rate' };
        }
      }
      // (3c) Abkühlung nach zu vielen Rückfällen: eine Minute lang NICHT wieder eintreten — sonst würde DVhub das
      // Mode-Register (13050) im Sekundentakt hin- und herschreiben. Der WR steht in Self (neutral, sicher).
      if (ownsExternal && decision.mode === 'forced' && st.fallbackCooldownUntil && t < st.fallbackCooldownUntil) {
        st.decision = { mode: 'self', reason: 'device_fallback_rate', at: t };
        publish();
        return { ok: false, error: 'device_fallback_rate' };
      }
      // (3c) Neueintritt-Sperre: nach einem Rückfall frühestens nach 10 s wieder in External EMS eintreten. Bis dahin
      // nichts schreiben (der WR steht ohnehin in Self) — sonst würde DVhub sofort wieder eintreten und erneut abfallen.
      if (ownsExternal && decision.mode === 'forced' && st.lastFallbackAt && t - st.lastFallbackAt < REENTRY_AFTER_FALLBACK_MS) {
        st.decision = { mode: 'self', reason: 'fallback_reentry_wait', at: t };
        publish();
        return { ok: false, error: 'fallback_reentry_wait', wait: true };
      }
      // Lebenszeichen, solange DVhub External EMS fährt und der WR in Modus 3 steht. Zwei getrennte Mechanismen:
      if (ownsExternal && !gap && decision.mode === 'forced' && dev.mode === EMS_MODE.EXTERNAL) {
        if (!st.externalEnteredAt) st.externalEnteredAt = t;
        // (a) Takt-Herzschlag 13080 (Geräte-Watchdog): in JEDEM Steuertakt erneut schreiben — die Doku verlangt den
        //     Wert innerhalb der Frist, und der Steuertakt (stepEveryMs) ist bereits auf ≤ Frist/3 begrenzt. Nicht
        //     ausgedünnt, damit der Watchdog auch bei kurzer Frist sicher gespeist bleibt. Nur wenn das Register
        //     beschreibbar ist (nicht deviceManaged) und als Keepalive-Register gewählt (13080/both, Standard 13080).
        const reg = ctl.keepaliveRegister;
        if ((reg === '13080' || reg === 'both') && !st.hb.deviceManaged) {
          await submitReg(conf, HEARTBEAT_ADDR, ctl.heartbeatTimeoutS, { fc: st.hb.workingFc || 6, keepalive: true });
          st.sentTimeoutS = ctl.heartbeatTimeoutS;
          st.lastHeartbeatAt = now();
        }
        // (b) Punkt 3a — Leistungs-Lebenszeichen 13052: der WR fällt am Gerät ~30 s nach Eintritt von selbst zurück,
        //     auch bei 13080=600. Dagegen die Leistung regelmäßig neu schreiben. Takt = gemessene Rückfallzeit/3,
        //     max 10 s. Genutzt bei keepaliveRegister 13052/both oder wenn 13080 nicht beschreibbar ist
        //     (deviceManaged). Ein Leistungs-Write bei Sollwert-Änderung (unten) frischt dasselbe Fenster auf.
        if (reg === '13052' || reg === 'both' || st.hb.deviceManaged) {
          const fallbackMs = st.lastFallbackAfterS > 0 ? st.lastFallbackAfterS * 1000 : ctl.heartbeatTimeoutS * 1000;
          const kaEvery = Math.min(10000, Math.max(3000, Math.floor(fallbackMs / 3)));
          if (t - (st.lastKeepaliveAt || 0) >= kaEvery - TICK_JITTER_MS) {
            await submitReg(conf, EMS_POWER_ADDR, dev.powerW, { fc: 6, keepalive: true }); // Leistung neu schreiben = Lebenszeichen
            st.lastKeepaliveAt = now();
            if (st.hb.deviceManaged) st.lastHeartbeatAt = now();
          }
        }
      }
      if (decision.mode !== 'forced') st.externalEnteredAt = 0;
      // Split-Steuerung (Punkt 1): zweiter WR angebunden und als Systemsumme bekannt → Reglerleistung nach der
      // gewählten Strategie aufteilen und BEIDE WR steuern (auch 'master-only' läuft hier durch: Slave in Modus 0).
      // Ohne frische Slave-Telemetrie (second==null, offline/keine Aggregation) steuert nur der Master (alles Master).
      if (slaveActuator && second != null) {
        return await stepSplit({ conf, ctl, decision, gap, second, reason, t, opts });
      }
      // Slave-Werte fehlen (Review 156a3e06 P2): einen zuvor von DVhub gesetzten Slave-Befehl zurücknehmen wie im
      // Forced-Pfad (S-41, Review-Befund 1) — sonst liefe er neben dem vollen Master-Anteil weiter. No-op ohne Besitz.
      if (slaveActuator) { st.slaveNeutralizeTick = t; try { await slaveActuator.neutralize('slave_telemetry_lost'); } catch { /* best effort */ } }
      // Ohne Slave-Werte wird der Slave hier nicht geführt und folgt dem Master-Modus: im eigenen Betrieb (Fable P2-1,
      // auch vor einem „unverändert") und vor dem Eintritt (Christin 21.11.2026) seinen Befehl auf Stopp bestätigen —
      // sonst tritt der Master zurück bzw. bleibt in diesem Takt in Modus 0.
      if (decision.mode === 'forced' && st.owns && st.ownMode === ctl.modeValue && dev.mode === ctl.modeValue) {
        await stopSlaveBeforeTakeover('running', ctl.modeValue, t);
      }
      if (!gap && emsMatches(dev, decision, decision.mode === 'forced' ? opts.stepW : 0, ctl.modeValue)) {
        if (decision.mode === 'self') setOwns(null);
        st.error = null;
        publish();
        return { ok: true, unchanged: true, decision };
      }
      if (decision.mode === 'forced' && dev.mode !== ctl.modeValue) await stopSlaveBeforeTakeover('entry', ctl.modeValue, t);
      const back = await writeDecision(conf, decision, { modeValue: ctl.modeValue, heartbeatS: ctl.heartbeatTimeoutS, forceAll: gap, heartbeatAfterMode: ctl.heartbeatAfterMode, heartbeatWriteFc: ctl.heartbeatWriteFc, acceptDeviceHeartbeatS: ctl.acceptDeviceHeartbeatS });
      // Ein frischer Write (Modus/Leistung) ist ein Lebenszeichen → Keepalive-Fenster neu; bei External EMS gilt
      // der Eintrittszeitpunkt ab jetzt (für die gemessene Rückfallzeit).
      if (decision.mode === 'forced') { st.lastKeepaliveAt = now(); if (ctl.modeValue === EMS_MODE.EXTERNAL && !st.externalEnteredAt) st.externalEnteredAt = now(); }
      st.error = null;
      st.logKeys = {};
      pushLog('sungrow_ems_write', {
        setpointW: st.target?.setpointW ?? null, source: st.target?.source ?? null, controlMode: ctl.mode,
        mode: decision.mode, command: decision.command || null, powerW: decision.powerW ?? null,
        reason: decision.reason, trigger: reason, readback: { mode: back.mode, cmd: back.cmd, powerW: back.powerW }
      });
      publish();
      return { ok: true, decision };
    } catch (e) {
      st.error = e?.message || String(e);
      if (e?.code === 'foreign_ems_mode') {
        // Ein anderes EMS/VPP steuert den Wechselrichter — nicht dagegen regeln (Besitz ist abgegeben).
        logOnce(String(e.mode), 'sungrow_ems_foreign_mode', { mode: e.mode, text: 'Sungrow steht im externen EMS-/VPP-Modus eines anderen Systems — DVhub schreibt nichts' }, 'warn');
      } else if (e?.code === 'emergency_stop_active') {
        st.dev = null;
        publish();
        return { ok: false, blocked: true, error: 'emergency_stop_active' };
      } else if (e?.code === 'entry_slave_unconfirmed') {
        return await deferEntry(conf, ctl, e, t, masterModeSeen);
      } else if (e?.code === 'running_slave_unconfirmed') {
        return await stepBackForSlave(conf, ctl, e, t);
      } else if (e?.code === 'ems_read_error') {
        // Reines Lesen der Kontroll-Register fehlgeschlagen — es wurde NICHTS geschrieben. Eigenes Event (warn),
        // kein control_write_error beim Aufrufer (readError-Flag).
        st.dev = null;
        logOnce(st.error, 'sungrow_ems_read_error', { error: st.error, decision }, 'warn');
        publish();
        return { ok: false, readError: true, error: st.error };
      } else if (e?.code === 'heartbeat_mismatch') {
        // Herzschlag nicht übernommen: writeDecision/applyHeartbeat hat bereits in Self-consumption neutralisiert
        // und den Besitz abgegeben. Das Ziel NICHT weiterfahren (sonst triebe der nächste Takt denselben
        // External-EMS-Versuch an und spränge wieder kurz auf vollen Netzbezug). Der Aufrufer bekommt readError
        // (kein control_write_error). (1c) Die Anzeige zeigt jetzt Self-consumption statt ~20 s den alten
        // forced-Befehl: st.dev stammt aus der Rücklesung der Neutralisierung, st.decision auf self.
        st.target = null;
        st.revokedReason = 'heartbeat_mismatch';
        st.decision = { mode: 'self', reason: 'heartbeat_mismatch', at: now() };
        publish();
        return { ok: false, readError: true, error: st.error };
      } else {
        st.dev = null;
        logOnce(st.error, e?.code === 'readback_mismatch' ? 'sungrow_ems_readback_mismatch' : 'sungrow_ems_error',
          { error: st.error, decision }, 'warn');
      }
      publish();
      return { ok: false, error: st.error };
    }
  }

  /**
   * Neuer bzw. bestätigter Netz-Sollwert aus applyControlTarget (alle Tore davor sind durchlaufen).
   * Ein geänderter Wert regelt sofort, ein gleicher frischt nur den Sollwert auf (Nachführen im Takt).
   */
  function applySetpoint(setpointW, source, { noGridCharge = false, releaseForFloor = false } = {}) {
    st.acceptSeq += 1;
    return serial(async () => {
      syncEndpoint(getCfg());
      // Option A: während eine Freigabe aussteht, nimmt der Aktuator keine Vorgabe an (nichts geschrieben; der
      // Aufrufer behält den Sollwert wie bei jedem Aktuator-Fehler, emsFailure). Nach der Bestätigung wie bisher.
      // Not-Halt hat Vorrang in der Rückgabe (wie step()).
      if (releasePendingAny()) {
        publish();
        return state.ctrl?.discretionaryWritesPaused ? { ok: false, blocked: true, error: 'emergency_stop_active' } : releasePendingResult();
      }
      const changed = !st.target || Number(st.target.setpointW) !== Number(setpointW);
      // noGridCharge trägt das Netzlade-Tor (schedule-eval) mit: dieser positive Sollwert darf nur die Last aus
      // dem Netz decken, nie den Akku laden → der Regler begrenzt das Laden auf den PV-Überschuss.
      // releaseForFloor: der Entlade-Boden hat wegen UNBEKANNTEM/veraltetem SoC gehalten (schedule-eval) — ein
      // Absicherungsfall. Im Forced mode nicht blind weiterregeln, sondern an den WR zurückgeben (Modus 0,
      // Absicherung C); der WR deckt die Last/lädt PV mit seinem eigenen SoC-Wissen.
      st.target = { setpointW: Number(setpointW), source, at: now(), noGridCharge: noGridCharge === true, releaseForFloor: releaseForFloor === true };
      st.revokedReason = null;
      const cfg = getCfg();
      const opts = resolveSungrowEmsOptions(sungrowEmsConf(cfg) || {});
      if (!changed && !due(stepEveryMs(opts, resolveSungrowControl(cfg)))) {
        publish();
        return { ok: true, refreshed: true };
      }
      return step({ reason: changed ? 'setpoint' : 'refresh' });
    });
  }

  /**
   * Ein Tor in applyControlTarget hat den Sollwert abgelehnt (z. B. Netzladen nicht mehr erlaubt): der
   * gemerkte Sollwert gilt nicht mehr — sofort zurück in Self-consumption, wenn DVhub den Betrieb fährt.
   */
  function revoke(reason, { unlessAcceptedAfter = null } = {}) {
    const newer = () => unlessAcceptedAfter != null && st.acceptSeq > unlessAcceptedAfter;
    if (newer()) return Promise.resolve({ ok: true, skipped: true, reason: 'newer_setpoint' });
    return serial(async () => {
      // Ein neuerer Sollwert kam inzwischen an (Codex 28317bd5): die ältere Ablehnung gilt nicht für ihn.
      if (newer()) return { ok: true, skipped: true, reason: 'newer_setpoint' };
      if (!st.target && !st.owns) return { ok: true, idle: true };
      st.target = null;
      st.revokedReason = String(reason || 'rejected');
      if (!st.owns) { publish(); return { ok: true, revoked: true }; }
      st.dev = null; // frisch lesen: ein fremdes EMS kann inzwischen übernommen haben
      const r = await step({ reason: 'revoked' });
      return { ...r, revoked: true };
    });
  }

  /** Zähler angenommener Sollwerte (für revoke unlessAcceptedAfter). */
  function acceptSeq() { return st.acceptSeq; }

  /** Nachführen im festen Takt (schedule-eval, 5 s); intern höchstens alle regulateEveryMs (External EMS: Herzschlag). */
  function tick() {
    return serial(async () => {
      const cfg = getCfg();
      const conf = sungrowEmsConf(cfg);
      // Option A: ausstehende Freigabe wiederholen — im selben Takt wie das Regeln, auch im Not-Halt (H-7). Sonst nichts.
      if (conf && releasePendingAny()) return await retryPendingRelease();
      // Codex 6f356cb8: ohne Schreibweg steht die Freigabe weiter aus — Status auffrischen (Master und Slave), damit
      // Kachel und API „nicht gesendet" statt „wird wiederholt" zeigen.
      if (!conf && releasePendingAny()) { publish(); slaveActuator?.status?.(); return { ...releasePendingResult(), idle: true }; }
      if (!conf || state.ctrl?.discretionaryWritesPaused) return { ok: true, idle: true };
      const opts = resolveSungrowEmsOptions(conf);
      if (!st.target && !st.owns) return { ok: true, idle: true };
      if (!due(stepEveryMs(opts, resolveSungrowControl(cfg)))) return { ok: true, idle: true };
      return step({ reason: 'tick' });
    });
  }

  /**
   * Not-Halt-Eintritt: DVhubs Zwangs-/EMS-Betrieb genau einmal zurück in Self-consumption (Befehl Stopp, Modus 0),
   * danach kein Write und kein Herzschlag mehr. Nicht von DVhub gesetzt → nichts.
   */
  function emergencyStop() {
    return serial(async () => {
      const pausedAt = Number(state.ctrl?.pausedAt) || 0;
      st.target = null;
      // A7: nach dem Not-Halt beginnt die Frist „Master allein" neu (wie nach einem Neustart).
      st.masterAlone = masterAloneIdle();
      // Not-Halt gilt für BEIDE WR: auch den Slave (Split-Steuerung) einmal zurück in Self-consumption.
      if (slaveActuator) { try { await slaveActuator.neutralize('emergency_stop'); } catch { /* best effort */ } }
      if (st.neutralizedAt === pausedAt) return { ok: true, skipped: true, reason: 'already_done' };
      st.neutralizedAt = pausedAt;
      const cfg = getCfg();
      const conf = sungrowEmsConf(cfg);
      syncEndpoint(cfg);
      // Restpunkt 1 (gleiches Muster wie die manuelle Freigabe): DVhub besitzt den Betrieb (Merker), aber die
      // Konfiguration ist ungültig und es gibt keinen Schreibweg (R-T2.1: ungültiges Profil ohne Schreibadressen) —
      // dann nicht „nicht im Besitz, ok" melden, sondern ehrlich: nichts gesendet (der Not-Halt meldet es laut).
      if (!conf && st.owns && cfg?.writeSafety?.ok === false) return { ok: false, skipped: true, sent: false, reason: 'no_write_path', error: noWritePathError(cfg) };
      if (!conf || !st.owns) return { ok: true, skipped: true, reason: 'not_owned' };
      try {
        st.dev = null; // frisch lesen: nur schreiben, was am Gerät wirklich noch abweicht
        const back = await writeDecision(conf, { mode: 'self', reason: 'emergency_stop' }, { neutralize: true });
        pushLog('sungrow_ems_write', { mode: 'self', reason: 'emergency_stop', readback: { mode: back.mode, cmd: back.cmd, powerW: back.powerW } });
        publish();
        return { ok: true };
      } catch (e) {
        st.error = e?.message || String(e);
        publish();
        if (e?.code === 'foreign_ems_mode') return { ok: true, skipped: true, reason: 'foreign_ems_mode' };
        return { ok: false, error: st.error };
      }
    });
  }

  /**
   * Zweite (Slave-)Instanz (Punkt 3, Split-Steuerung): einen fertigen Befehl (nicht Sollwert-geregelt) direkt an
   * den Slave schreiben — alle Sicherheits-Schritte wie beim Master (Herzschlag-FC-Fallback, Rücklesen, sicheres
   * Scheitern, fremder Modus). Umgeht das Geräte-Tor (das Slave-Gerät wird nicht separat erkannt). Serialisiert.
   */
  function applyDirectCommand(decision, ctl) {
    return serial(async () => {
      const cfg = getCfg();
      const conf = sungrowEmsConf(cfg);
      if (!conf || transport?.type !== 'modbus') return { ok: false, error: 'sungrow_ems_not_configured' };
      syncEndpoint(cfg);
      if (state.ctrl?.discretionaryWritesPaused) return { ok: false, blocked: true, error: 'emergency_stop_active' };
      const control = ctl || resolveSungrowControl(cfg);
      const opts = resolveSungrowEmsOptions(conf);
      markStep();
      try {
        // Schreibdrossel je WR (N4/Aufgabe 5, Feld 15.11.: der Slave schrieb per forceAll JEDEN Takt 13051+13052):
        // erst lesen, dann NUR schreiben, wenn der Befehl wechselt ODER die Leistung > stepW abweicht. Der Slave
        // folgt dem Master-Modus (ignoreMode), hält seinen Befehl im Forced mode — ein Rück-Schreiben jeden Takt
        // ist unnötig und verschleißt die Holding-Register.
        st.dev = null;
        const dev = await readDevice(conf);
        if (isSlave ? dev.mode === EMS_MODE.VPP : isForeignMode(dev.mode, dev)) throw foreignModeError(dev.mode);
        // H-9 (ersetzt M12, Feld 16.11.): führt DVhub den Slave in einem Befehl, ohne ihn zu besitzen (nach Freigabe,
        // Rücknahme, Neustart ohne Merker oder ein Befehl eines anderen Systems), stellt erst DVhubs eigener Write den
        // Besitz her — auch wenn der Zustand schon passt (M12 übernahm ihn hier ohne Write, im Rahmen der Schreibschwelle).
        const adopt = needsAdoption(dev, decision, control.modeValue);
        if (!adopt && emsMatches(dev, decision, opts.stepW, control.modeValue, { ignoreMode: isSlave })) {
          st.decision = { ...decision, at: now() };
          st.error = null;
          publish();
          return { ok: true, unchanged: true, decision, readback: dev };
        }
        const found = adopt ? adoptionFound(dev) : null;
        const back = await writeDecision(conf, decision, {
          modeValue: control.modeValue, heartbeatS: control.heartbeatTimeoutS, forceAll: false, adopt,
          heartbeatAfterMode: control.heartbeatAfterMode, heartbeatWriteFc: control.heartbeatWriteFc,
          acceptDeviceHeartbeatS: control.acceptDeviceHeartbeatS,
        });
        if (found) logAdoption(found, decision);
        st.decision = { ...decision, at: now() };
        st.error = null;
        publish();
        return { ok: true, decision, readback: back };
      } catch (e) {
        st.error = e?.message || String(e);
        st.dev = null;
        publish();
        if (e?.code === 'foreign_ems_mode') return { ok: false, foreign: true, error: st.error };
        if (e?.code === 'heartbeat_mismatch') return { ok: false, heartbeatMismatch: true, error: st.error };
        if (e?.code === 'emergency_stop_active') return { ok: false, blocked: true, error: st.error };
        // Reines Lesen der Slave-Register fehlgeschlagen (modbus exception 4 o. Ä.) — es wurde NICHTS geschrieben.
        // Der Aufrufer (stepSplit, Aufgabe 3) faellt dann auf Master-only zurueck statt beide auf Modus 0 zu werfen.
        if (e?.code === 'ems_read_error') return { ok: false, readError: true, error: st.error, ...writeErrorInfo(e) };
        return { ok: false, error: st.error, ...writeErrorInfo(e) };
      }
    });
  }

  // === Schreibklassen-Matrix im Not-Halt (C3.2, Christin 16.11.2026) ==========================================
  // Entscheidung festgehalten: Der Not-Halt sperrt DVhubs EIGENE Regel-Writes (submitReg ohne neutralize wirft
  // emergency_stop_active). AUSDRÜCKLICHE Ausnahme — genau EINE Neutralisierung über den Außen-Pfad:
  //   • releaseControl (geordnetes Beenden, SIGTERM/Update, ExecStopPost des Not-Stop-Skripts) und
  //   • neutralize (Box-Watchdog)
  // dürfen den Forced-WR EINMAL sicher zurücknehmen (Modus 0 / Befehl 0xCC, neutralize:true). Grund: der
  // Forced-WR hat KEINEN geräteeigenen Rückfall — ohne diese Ausnahme hinge er im Zwangsmodus. „Einmal" ist durch
  // den Besitz-Merker begrenzt (nach der Rücknahme owns=null → ein zweiter Aufruf ist ein No-op). Abgesichert in
  // test/sungrow-ems.test.js („P5 Schreibklassen-Matrix …"). KEINE weitere Write-Klasse darf im Not-Halt schreiben.
  // ===========================================================================================================

  /**
   * N3 (nur Slave): der Master meldet hier vor jedem Befehl seinen wirksamen Takt — in genau diesem Takt wird der
   * Slave geführt. Reine Anzeige (Status regulateEveryMs), kein I/O, steuert nichts. Ungültig → null.
   */
  function setDrivenRegulateMs(ms) {
    const v = Number(ms);
    st.drivenRegulateMs = Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  }

  /**
   * H-9 (nur Slave, Codex 2a0f18b5 P2): vor der Übernahme des Masters — und vor seinem Eintritt aus Modus 0
   * (reason 'master_entry', Christin 21.11.2026) — einen Slave, den DVhub nicht führt, einmal auf
   * Stopp (0xCC) setzen und zurücklesen. Besitzt DVhub ihn oder steht er schon auf Stopp: kein Write. Kein Besitz
   * (Stopp ist der Grundzustand), kein Modus-Write, im Not-Halt nichts, in Notladung nichts (emergency: true).
   * ok:false = nicht bestätigt.
   */
  function stopUnowned(reason = 'master_adopted') {
    return serial(async () => {
      const cfg = getCfg();
      const conf = sungrowEmsConf(cfg);
      if (!conf || transport?.type !== 'modbus') return { ok: false, error: 'sungrow_ems_not_configured' };
      // Nur mit eigener Slave-Verbindung — ohne sie zeigte endpoint() auf den Master.
      if (isSlave && !resolveOverride()?.host) return { ok: true, skipped: true, reason: 'no_second_inverter' };
      syncEndpoint(cfg);
      if (state.ctrl?.discretionaryWritesPaused) return { ok: false, blocked: true, error: 'emergency_stop_active' };
      if (st.owns) return { ok: true, skipped: true, reason: 'owned' };
      // stage: 'read' bis zum Write — der Aufrufer unterscheidet „nicht lesbar" (Zustand unbekannt) von „fremden
      // Befehl gefunden, Stopp nicht bestätigt" (Nachprüfung im Betrieb, Fable 2 P3).
      let stage = 'read';
      try {
        // Betriebszustand am Slave selbst lesen (FC4 13000, nur Lesen): ohne Telemetrie des Begleitdiensts ist er
        // unbekannt. In Notladung (0x4001) ist der Slave nicht steuerbar und wird nie kommandiert (S-36); nicht
        // lesbar → nicht bestätigt, die Übernahme wartet (Codex 4e3fc521 P2). Mit derselben Wiederholung wie
        // readDevice (Fable 2 P3): ein einzelner Lesefehler kostet sonst einen Rücktritt (zwei 13050-Writes).
        const runningState = await readRunningState(conf);
        if (isSungrowEmergencyCharge(runningState)) { publish(); return { ok: false, emergency: true, error: 'slave_emergency_charge' }; }
        st.dev = null;
        const dev = await readDevice(conf);
        // Codex-Review P2: eine beobachtete Fremdsteuerung macht einen gespeicherten Stopp ungültig — sonst galt danach das
        // 60-s-Intervall und ein Lesefehler als „zuletzt Stopp“, und ein vom VPP hinterlassener Befehl liefe unbegrenzt
        // neben dem Master. Den fremd gesteuerten Slave schreibt DVhub weiterhin nicht (S-38).
        if (dev.mode === EMS_MODE.VPP) { setStopConfirmed(false); throw foreignModeError(dev.mode); }
        if (dev.cmd === EMS_CMD.STOP) { setStopConfirmed(true); publish(); return { ok: true, unchanged: true }; }
        setStopConfirmed(false); // ein Befehl steht an — bis zur bestätigten Rücknahme gilt der Stopp nicht
        const found = adoptionFound(dev);
        stage = 'write';
        await writeDecision(conf, { mode: 'self', reason }, {});
        if (reason === 'master_entry' || reason === 'master_running') {
          // Vor dem Eintritt des Masters (Christin 21.11.2026) bzw. im Betrieb, wenn DVhub den Slave nicht führt
          // (Fable P2-1, Nachprüfung): der Befehl wirkte bzw. hätte gewirkt, sobald der Master im Steuermodus steht.
          const entry = reason === 'master_entry';
          pushLog(entry ? 'sungrow_ems_entry_slave_stopped' : 'sungrow_ems_running_slave_stopped', {
            side: 'slave', found: { cmd: found.cmd, powerW: found.powerW },
            text: entry
              ? `Sungrow Slave: Befehl 0x${(found.cmd & 0xffff).toString(16)} (${found.powerW} W) ohne DVhub-Besitz vor dem Eintritt des Masters auf Stopp gesetzt — er hätte mit dem Eintritt wieder gewirkt.`
              : `Sungrow Slave: Befehl 0x${(found.cmd & 0xffff).toString(16)} (${found.powerW} W) ohne DVhub-Besitz im Betrieb gefunden (DVhub führt den Slave nicht) und auf Stopp gesetzt — er lief neben dem Master-Anteil.`,
          }, 'warn');
        } else {
          logAdoption(found, { mode: 'forced', command: 'stop', powerW: 0 });
        }
        publish();
        return { ok: true };
      } catch (e) {
        st.error = e?.message || String(e);
        st.dev = null;
        publish();
        return { ok: false, error: st.error, stage, ...(e?.code === 'emergency_stop_active' ? { blocked: true } : {}), ...(e?.code === 'foreign_ems_mode' ? { foreign: true } : {}) };
      }
    });
  }

  /** Slave einmal sicher in Self-consumption (Not-Halt, Split-Abbruch, Rückzug). Schreibt auch im Not-Halt. */
  function neutralize(reason = 'neutralize') {
    return serial(async () => {
      const cfg = getCfg();
      const conf = sungrowEmsConf(cfg);
      if (!conf || transport?.type !== 'modbus') return { ok: true, skipped: true };
      syncEndpoint(cfg);
      if (!st.owns) return { ok: true, skipped: true, reason: 'not_owned' };
      try {
        st.dev = null;
        await writeDecision(conf, { mode: 'self', reason }, { neutralize: true });
        publish();
        return { ok: true };
      } catch (e) {
        st.error = e?.message || String(e);
        publish();
        if (e?.code === 'foreign_ems_mode') return { ok: true, skipped: true, reason: 'foreign_ems_mode' };
        return { ok: false, error: st.error };
      }
    });
  }

  /**
   * Freigabe der Steuerung (Absicherung C): beide WR sicher in Self-consumption — erst den Slave anhalten (0xCC),
   * dann den Master in Modus 0 (Befehl 0xCC + Modus 0). Für den geordneten Shutdown (SIGTERM/Update-Neustart) und
   * als Ziel des externen Not-Stop-Skripts (ExecStopPost). Schreibt auch im Not-Halt (neutralize). Ein fremdes EMS
   * wird nicht angefasst (writeDecision prüft isForeignMode). Best effort — Self-consumption ist die sichere Seite.
   */
  function releaseControl(reason = 'shutdown_release') {
    return serial(async () => {
      const cfg = getCfg();
      const conf = sungrowEmsConf(cfg);
      if (!conf || transport?.type !== 'modbus') return { ok: true, skipped: true };
      syncEndpoint(cfg);
      // Slave zuerst anhalten (0xCC), dann Master auf Modus 0 — so hält der Slave keinen Lade-/Entladebefehl mehr,
      // wenn der Master in Modus 0 fällt (der Slave folgt dann dem Master, Feld #5).
      if (slaveActuator) { try { await slaveActuator.neutralize(reason); } catch { /* best effort */ } }
      if (!st.owns) return { ok: true, skipped: true, reason: 'not_owned' };
      try {
        st.dev = null;
        await writeDecision(conf, { mode: 'self', reason }, { neutralize: true });
        setOwns(null); st.target = null; st.revokedReason = reason;
        pushLog('sungrow_ems_release', { reason });
        publish();
        return { ok: true };
      } catch (e) {
        st.error = e?.message || String(e);
        publish();
        if (e?.code === 'foreign_ems_mode') return { ok: true, skipped: true, reason: 'foreign_ems_mode' };
        return { ok: false, error: st.error };
      }
    });
  }

  // Manuelle Freigabe per Knopf/API (M2, Feld 16.11.): Master in Modus 0, beide WR 0xCC — UNABHÄNGIG vom
  // Besitz-Merker. Der Merker kann nach einem Neustart/Lesefehler fehlen, während der Master real noch in DVhubs
  // Modus 2 mit fester Leistung steht (Feld: ~10 min, API-Neustart half nicht, nur sungrowForcedSafeOff löste es).
  // Darum NICHT über writeDecision (das lehnte bis H-9 einen vermeintlich „fremden" Modus 2 ab, ein fremdes Modus 3/VPP
  // weiterhin) — die Register direkt setzen
  // und zurücklesen. Nach BESTÄTIGTER Freigabe Besitz/Ziel/letzten Write zurücksetzen, damit DVhub nicht sofort wieder
  // eintritt. Schreibtor: Aktionsklasse manualForceRelease (H-7) — die einzige Not-Halt-Ausnahme, nur die festen
  // Literale 0xCC/0 Richtung Grundzustand. Bestätigt hat der Bediener am Aufrufer (POST /api/sungrow/release verlangt
  // confirm: true); die Marke nennt den Anlass. Der Master reicht die Freigabe an den Slave weiter (gleiche Klasse).
  //
  // Option A (Christin 19.11.2026, Punkt 7 — „das Verhalten aus dem Feldtest hat Vorrang, Option A ist eigentlich das
  // natürliche, was man erwarten würde"): Scheitert die Freigabe (Zeitüberschreitung, halb angekommen, nicht
  // bestätigt), bleibt sie als Absicht stehen und wird wiederholt, bis sie bestätigt ist. Vorher löschte sie Besitz,
  // Ziel und letzten Write trotzdem — der WR stand weiter in DVhubs Modus 2 mit dem alten Befehl, DVhub hielt ihn für
  // fremd und schrieb nie wieder; Not-Halt-/Shutdown-Rücknahme, ExecStopPost und Box-Watchdog übersprangen ihn.
  //   • DVhubs Modus bleibt DVhubs (Besitz-Merker bleibt, auch auf der Platte), solange die Freigabe aussteht.
  //   • Zwischen zwei Versuchen regelt DVhub nicht (step/applySetpoint: kein Befehl, keine Leistung, kein Herzschlag).
  //   • Wiederholung = dieselbe Abfolge (Slave 0xCC, Master 0xCC, Master Modus 0, Rücklesen) im vorhandenen Regeltakt
  //     (tick → due/stepEveryMs) mit dem vorhandenen Freigabe-Backoff aus dem Feldtest (M14, services/release-
  //     backoff.js: nach 3 Fehlschlägen in Folge alle 5 min, ohne Obergrenze; ein Knopfdruck umgeht das Fenster).
  //   • M14-Muster: Modbus-Ausnahme, Wert aber übernommen → Schritt erledigt (releaseWrite).
  //   • Im Not-Halt läuft nur die Wiederholung (manualForceRelease, H-7). Eine bestätigte Not-Halt-/Shutdown-Rücknahme
  //     erledigt die Freigabe mit (writeDecision self).
  //   • Kein eigener Betrieb (fremdes EMS/VPP oder nichts gesetzt): einmaliger Versuch wie bisher, keine Wiederholung.
  //   • Codex d6f4b256 P1: jede AUTOMATISCHE Wiederholung prüft vorher Besitz und Gerätezustand frisch; hat ein anderes
  //     System übernommen, wird die Freigabe verworfen (Log sungrow_ems_release_abandoned + Status), nie überschrieben.
  //   • Codex d6f4b256 P2: jede Anfrage trägt ihren Zeitpunkt (requestedAt); ihr Ergebnis ersetzt das der vorigen.
  //   • Restpunkt 1: ohne Schreibweg (Profil ungültig, kein Sungrow-EMS) ehrlich ok:false, sent:false — nichts gesendet.
  const releaseSide = isSlave ? 'slave' : 'master';
  const isModbusException = (e) => /^modbus exception \d+/.test(String(e?.message));

  // Warum es keinen Schreibweg gibt (Restpunkt 1). Gleiche Fehlernamen wie submitReg (C2) bzw. step().
  function noWritePathError(cfg) {
    const ws = cfg?.writeSafety;
    if (ws && ws.ok === false) return `config_unsafe_${ws.reason || 'config_invalid'}`;
    return 'sungrow_ems_not_configured';
  }

  // Ein Freigabe-Register schreiben. M14 (Feldtest 6a4e10d3, SH10RT-20; wie schedule-eval runDvControlSequence):
  // antwortet der WR mit einer Modbus-Ausnahme, hat den Wert aber übernommen, gilt der Schritt als erledigt —
  // zurücklesen statt ewig wiederholen. Nur bei einer echten Ausnahme (Gerät hat geantwortet); bei Zeitüberschreitung
  // oder Verbindungsfehler ist der Gerätezustand unbekannt → Fehlschlag.
  async function releaseWrite(conf, address, value, confirmedBy) {
    try {
      await submitReg(conf, address, value, { neutralize: true, manualRelease: confirmedBy });
    } catch (e) {
      if (!isModbusException(e)) throw e;
      let dev;
      try { dev = await readDevice(conf); } catch { dev = null; }
      const got = dev ? (address === EMS_MODE_ADDR ? dev.mode : dev.cmd) : null;
      if (got !== (value & 0xffff)) throw e;
      pushLog('sungrow_ems_release_already_set', { side: releaseSide, address, value: value & 0xffff, error: e?.message || String(e) }, 'warn');
    }
  }

  // Die Freigabe-Abfolge dieses WR (seit M2 unverändert): 0xCC, am Master dann Modus 0, zurücklesen.
  async function releaseAttempt(conf, confirmedBy) {
    const out = { ok: false };
    try {
      st.dev = null;
      await releaseWrite(conf, EMS_CMD_ADDR, EMS_CMD.STOP, confirmedBy);
      if (!isSlave) await releaseWrite(conf, EMS_MODE_ADDR, EMS_MODE.SELF, confirmedBy);
      const back = await readDevice(conf);
      out.ok = back.cmd === EMS_CMD.STOP && (isSlave || back.mode === EMS_MODE.SELF);
      out.device = { mode: back.mode, cmd: back.cmd, powerW: back.powerW };
      if (!out.ok) out.error = 'release_not_confirmed';
    } catch (e) { out.error = e?.message || String(e); }
    return out;
  }

  function releasePending() { return st.release != null; }
  function releasePendingAny() { return st.release != null || slaveActuator?.releasePending?.() === true; }
  // Ist der nächste automatische Versuch fällig (Backoff-Fenster vorbei)?
  function releaseDue() { return st.release != null && now() >= st.release.nextAt; }
  function releasePendingResult() { return { ok: false, error: 'sungrow_release_pending', releasePending: true }; }

  // requestedAt: ein neuer Knopfdruck übernimmt die ausstehende Freigabe — ihr Hinweis gehört jetzt zu ihm (P2).
  function releaseFailed(reason, confirmedBy, error, requestedAt = null) {
    const t = now();
    const r = st.release || { reason, confirmedBy, requestedAt, since: t, attempts: 0, nextAt: 0, lastError: null };
    if (requestedAt != null) r.requestedAt = requestedAt;
    r.attempts += 1;
    r.lastError = error || null;
    r.nextAt = releaseBackoffNextAt(r.attempts, t);
    st.release = r;
    st.releaseInfo = null;
  }

  // Automatischer Versuch gescheitert (nichts oder nicht alles angekommen, oder der Zustand war nicht lesbar).
  function retryFailed(r, error) {
    releaseFailed(r.reason, r.confirmedBy, error);
    pushLog('sungrow_ems_release_retry', {
      side: releaseSide, attempts: st.release.attempts, retryAt: st.release.nextAt || null, error: error || null,
      text: 'Sungrow-Freigabe gescheitert, wird wiederholt.',
    }, 'warn');
  }

  // Freigabe am Gerät erreicht, nachdem sie ausstand: Hinweis „erledigt" (Log + Status). via = 'release' (eigene
  // Wiederholung/Knopf), 'device' (der WR stand beim Nachlesen schon im Ziel — kein Write) oder der Anlass einer
  // bestätigten Rücknahme (emergency_stop, shutdown, …).
  function releaseCompleted(via) {
    const r = st.release;
    const attempts = r.attempts + (via === 'release' ? 1 : 0);
    st.release = null;
    st.releaseInfo = { state: 'done', requestedAt: r.requestedAt ?? null, at: now(), attempts, via };
    pushLog('sungrow_ems_release_done', {
      side: releaseSide, attempts, via,
      text: `Sungrow-Freigabe erledigt (${isSlave ? 'Slave 0xCC' : 'Master Modus 0 + 0xCC'} bestätigt, ${attempts} Versuch${attempts === 1 ? '' : 'e'}).`,
    });
  }

  // Codex d6f4b256 P1: die ausstehende Freigabe verwerfen — der Betrieb ist nicht mehr DVhubs (ein anderes System hat
  // übernommen, bzw. eine Rücknahme hat den fremden Modus erkannt und den Besitz abgegeben). DVhub wiederholt sie nicht
  // und überschreibt das fremde System nie, auch im Not-Halt nicht. reason: foreign_mode (an diesem WR),
  // master_foreign_mode (Slave: am Master steuert ein anderes System, der Slave folgt ihm), not_owned (Besitz weg).
  function releaseAbandon(reason, mode = null) {
    const r = st.release;
    if (!r) return;
    st.release = null;
    st.releaseInfo = { state: 'abandoned', requestedAt: r.requestedAt ?? null, at: now(), attempts: r.attempts, reason, mode };
    const where = reason === 'master_foreign_mode' ? 'am Master steuert ein anderes System' : (reason === 'foreign_mode' ? 'ein anderes System steuert' : 'der Betrieb ist nicht mehr DVhubs');
    pushLog('sungrow_ems_release_abandoned', {
      side: releaseSide, attempts: r.attempts, reason, mode,
      text: `Sungrow-Freigabe verworfen (${isSlave ? 'Slave' : 'Master'}): ${where}${mode != null ? ` (Modus ${mode})` : ''} — DVhub überschreibt das nicht und wiederholt nicht.`,
    }, 'warn');
  }

  function releaseConfirmed(reason, via = 'release') {
    setOwns(null); st.target = null; st.revokedReason = reason; st.lastMasterWrite = null;
    if (st.release) releaseCompleted(via);
  }

  // Eigene ausstehende Freigabe einmal AUTOMATISCH versuchen (Backoff-Fenster beachten). Aufrufer serialisiert.
  // Codex d6f4b256 P1: vorher Besitz und Gerätezustand frisch prüfen. Der Knopfdruck ist eine Bedienhandlung (M2: auch
  // gegen einen vermeintlich fremden Modus, einmal); die Wiederholung ist es nicht und überschreibt nie ein anderes System:
  //   • Besitz abgegeben (eine Rücknahme hat einen fremden Modus erkannt)        → verwerfen;
  //   • Slave: am Master steuert ein anderes System (der Slave folgt ihm, Feld #5) → verwerfen;
  //   • Zustand nicht lesbar (dieser WR bzw. für den Slave der Master)             → kein Write, zählt als Fehlschlag;
  //   • fremder Modus am Gerät (Slave: VPP; Master: isForeignMode wie writeDecision) → Besitz abgeben, verwerfen;
  //   • Gerät steht schon im Ziel (Master Modus 0 + 0xCC, Slave 0xCC)             → erledigt ohne Write (13050 schonen);
  //   • sonst dieselbe Freigabe-Abfolge wie beim Knopfdruck.
  // dev/readError: am Master der eben in retryPendingRelease gelesene Zustand (einmal lesen für Master und Slave).
  async function retryOwnRelease({ dev: given = undefined, readError = null, masterForeignMode = null } = {}) {
    const r = st.release;
    if (!r || now() < r.nextAt) return;
    if (!st.owns) { releaseAbandon('not_owned'); return; }
    if (masterForeignMode != null) { setOwns(null); releaseAbandon('master_foreign_mode', masterForeignMode); return; }
    const conf = sungrowEmsConf(getCfg());
    let dev = given;
    let err = readError;
    if (dev === undefined && err == null) {
      try { st.dev = null; dev = await readDevice(conf); } catch (e) { err = e?.message || String(e); }
    }
    if (err != null) { retryFailed(r, err); return; }
    if (isSlave ? dev.mode === EMS_MODE.VPP : isForeignMode(dev.mode, dev)) { setOwns(null); releaseAbandon('foreign_mode', dev.mode); return; }
    if (dev.cmd === EMS_CMD.STOP && (isSlave || dev.mode === EMS_MODE.SELF)) { releaseConfirmed(r.reason, 'device'); return; }
    const out = await releaseAttempt(conf, r.confirmedBy);
    if (out.ok) { releaseConfirmed(r.reason); return; }
    retryFailed(r, out.error);
  }

  // Wiederholung aus tick() (Master): im Regeltakt (due/stepEveryMs), Slave zuerst, dann Master. Auch im Not-Halt —
  // es läuft ausschließlich die Freigabe-Abfolge (manualForceRelease, H-7).
  async function retryPendingRelease() {
    const cfg = getCfg();
    const conf = sungrowEmsConf(cfg);
    if (!conf || transport?.type !== 'modbus') return { ok: true, idle: true };
    syncEndpoint(cfg);
    if (!releasePendingAny()) { publish(); return { ok: true, idle: true }; }
    if (!due(stepEveryMs(resolveSungrowEmsOptions(conf)))) return { ...releasePendingResult(), idle: true };
    const ownDue = releaseDue();
    const slaveDue = slaveActuator?.releaseDue?.() === true;
    if (!ownDue && !slaveDue) { publish(); return { ...releasePendingResult(), idle: true }; } // Backoff-Fenster: nicht einmal lesen
    markStep();
    // Codex d6f4b256 P1: den Master frisch lesen, BEVOR automatisch geschrieben wird. Er entscheidet auch über den Slave:
    // der folgt dem Master-Modus (Feld #5) — steuert am Master ein anderes System, gehört ihm auch der Slave.
    let masterDev;
    let masterErr = null;
    try { st.dev = null; masterDev = await readDevice(conf); } catch (e) { masterErr = e?.message || String(e); }
    if (slaveDue) {
      const masterForeignMode = masterDev && isForeignMode(masterDev.mode, masterDev) ? masterDev.mode : null;
      try { await slaveActuator.retryRelease({ masterForeignMode, masterReadError: masterErr }); } catch { /* bleibt ausstehend */ }
    }
    if (ownDue) await retryOwnRelease({ dev: masterDev, readError: masterErr });
    publish();
    return releasePendingAny() ? releasePendingResult() : { ok: true, released: true };
  }

  // Slave: Wiederholung auf Anstoß des Masters (eigene Serialisierung, eigener Backoff). masterForeignMode/
  // masterReadError: was der Master eben an sich gelesen hat (P1).
  function retryRelease({ masterForeignMode = null, masterReadError = null } = {}) {
    return serial(async () => {
      const cfg = getCfg();
      if (!sungrowEmsConf(cfg) || transport?.type !== 'modbus') return { ok: true, idle: true };
      syncEndpoint(cfg);
      await retryOwnRelease({ masterForeignMode, readError: masterReadError != null ? `Master: ${masterReadError}` : null });
      publish();
      return { ok: st.release == null, pending: st.release != null };
    });
  }

  // requestedAt: Zeitpunkt der Anfrage (der Master reicht seinen an den Slave weiter — beide Hinweise gehören zur selben).
  function forceRelease(reason = 'manual_release', { requestedAt = null } = {}) {
    const confirmedBy = `operator:${reason || 'manual_release'}`;
    return serial(async () => {
      const reqAt = requestedAt ?? now();
      // P2: eine neue Anfrage — was zur vorigen gemeldet wurde, gilt nicht mehr; eine ausstehende Freigabe gehört jetzt
      // zu ihr.
      st.releaseInfo = null;
      if (st.release) st.release.requestedAt = reqAt;
      const cfg = getCfg();
      const conf = sungrowEmsConf(cfg);
      if (!conf || transport?.type !== 'modbus') {
        // Restpunkt 1: kein Schreibweg (Herstellerprofil ungültig → R-T2.1 ohne Schreibadressen; kein Sungrow-EMS-Profil;
        // kein Modbus). Vorher ok:true — die Kachel zeigte „freigegeben (Modus 0)", obwohl nichts gesendet wurde.
        const error = noWritePathError(cfg);
        let slaveOut = null;
        if (slaveActuator) { try { slaveOut = await slaveActuator.forceRelease(reason, { requestedAt: reqAt }); } catch { /* nichts gesendet */ } }
        st.releaseInfo = { state: 'failed', requestedAt: reqAt, at: now(), sent: false, error };
        // Steht eine Freigabe aus, bleibt sie als Auftrag stehen (Codex 6f356cb8) — die Antwort sagt beides.
        const pending = st.release != null || slaveOut?.pending === true;
        if (!isSlave) {
          pushLog('sungrow_ems_manual_release', {
            reason, ok: false, sent: false, pending, error, slave: slaveOut ? { ok: slaveOut.ok === true, sent: slaveOut.sent !== false } : null,
            text: `Sungrow-Freigabe NICHT gesendet — kein Schreibweg (${error})${pending ? '; die ausstehende Freigabe bleibt stehen' : ''}.`,
          }, 'warn');
        }
        publish();
        return { ok: false, sent: false, skipped: true, reason: 'no_write_path', error, requestedAt: reqAt, ...(pending ? { pending: true } : {}) };
      }
      syncEndpoint(cfg);
      let slaveOut = null;
      if (slaveActuator) { try { slaveOut = await slaveActuator.forceRelease(reason, { requestedAt: reqAt }); } catch (e) { slaveOut = { ok: false, error: e?.message || String(e) }; } }
      // Wessen Betrieb wird freigegeben? Vor dem ersten Write festhalten (eine halb angekommene Freigabe ändert den
      // Gerätezustand). Merker — oder am Master (M2) der zuletzt gelesene Zustand spiegelt DVhubs letzten bestätigten
      // Write. Nur ein eigener Betrieb wird nach einem Fehlschlag gehalten und wiederholt.
      const ownBefore = st.owns ? st.ownMode
        : ((st.dev && (st.dev.mode === EMS_MODE.FORCED || st.dev.mode === EMS_MODE.EXTERNAL) && ownWroteMode(st.dev.mode, st.dev)) ? st.dev.mode : null);
      const out = await releaseAttempt(conf, confirmedBy); // Knopfdruck: sofort, ohne Backoff-Fenster
      out.requestedAt = reqAt;
      if (out.ok) {
        releaseConfirmed(reason);
      } else if (ownBefore != null) {
        setOwns(ownBefore); // eigener Betrieb bleibt eigener (Merker für Watchdog/ExecStopPost)
        releaseFailed(reason, confirmedBy, out.error, reqAt);
      } else {
        // Kein eigener Betrieb (fremdes EMS/VPP oder nichts gesetzt): einmaliger Versuch wie bisher. Eine noch
        // ausstehende Freigabe ohne Besitz wird nicht weiter automatisch versucht (P1); der Fehlschlag dieser Anfrage
        // steht im Status (P2).
        if (st.release) releaseAbandon('not_owned');
        setOwns(null); st.target = null; st.revokedReason = reason; st.lastMasterWrite = null;
        st.releaseInfo = { state: 'failed', requestedAt: reqAt, at: now(), error: out.error || null };
      }
      // Nur wenn etwas aussteht (sonst bleibt die Rückgabe wie bisher).
      if (st.release != null || slaveOut?.pending === true) out.pending = true;
      if (st.release) { out.attempts = st.release.attempts; out.retryAt = st.release.nextAt || null; }
      if (!isSlave) {
        const slaveFailed = slaveOut != null && slaveOut.ok !== true && slaveOut.skipped !== true;
        const text = out.pending
          ? 'Sungrow-Freigabe gescheitert, wird wiederholt — DVhub regelt bis zur Bestätigung nicht.'
          : (out.ok
            ? (slaveFailed ? 'Sungrow-Master freigegeben (Modus 0), Slave-Freigabe gescheitert.' : 'Sungrow manuell freigegeben (Modus 0, beide 0xCC).')
            : 'Sungrow-Freigabe gescheitert — kein von DVhub gesetzter Betrieb, keine Wiederholung.');
        pushLog('sungrow_ems_manual_release', {
          reason, ok: out.ok, pending: out.pending === true, error: out.error || null,
          ...(st.release ? { attempts: st.release.attempts, retryAt: st.release.nextAt || null } : {}),
          slave: slaveOut ? { ok: slaveOut.ok === true, pending: slaveOut.pending === true, error: slaveOut.error || null } : null,
          text,
        }, out.ok && !slaveFailed ? undefined : 'warn');
      }
      publish();
      return out;
    });
  }

  return { applySetpoint, revoke, acceptSeq, tick, emergencyStop, applyDirectCommand, setDrivenRegulateMs, neutralize, stopUnowned, ownsControl: () => st.owns === true, stopConfirmed: () => st.stopConfirmed === true, stopConfirmedAt: () => st.stopConfirmedAt || 0, releaseControl, forceRelease, releasePending, releaseDue, retryRelease, status: () => (publish(), state.ctrl?.[statusKey] || null), _st: st };
}

function describe(d, modeValue = EMS_MODE.FORCED) {
  if (d.mode === 'self') return 'Self-consumption';
  const name = modeValue === EMS_MODE.EXTERNAL ? 'External EMS' : 'Zwangsbetrieb';
  return d.command === 'stop' ? `${name} Stopp` : `${name} ${d.command === 'charge' ? 'Laden' : 'Entladen'} ${d.powerW} W`;
}
