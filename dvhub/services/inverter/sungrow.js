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
import { createModbusHealth } from './modbus-health.js';

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

// Notladungs-Puffer über Sungrows Geräte-Untergrenze (M1, Christin 16.11.): kundeneinstellbar je Anlage,
// Standard 1 Prozentpunkt (real). Der effektive Entlade-Boden ist max(hardFloorSocPct, geräteMinReal + Puffer).
// 0 = kein Puffer (DVhub entlädt bis exakt zur Geräte-Untergrenze). Geklemmt auf [0, 50].
export const SUNGROW_DEFAULT_SOC_FLOOR_BUFFER_PCT = 1;
export function sungrowSocFloorBufferPct(cfg) {
  const v = Number(cfg?.sungrow?.socFloorBufferPct);
  return Number.isFinite(v) && v >= 0 ? Math.min(50, v) : SUNGROW_DEFAULT_SOC_FLOOR_BUFFER_PCT;
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
// (Christin 16.11., kundeneinstellbar, Default 1 pp) hält DVhub knapp ÜBER Sungrows eigener Untergrenze (real =
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
 *   • Sollwert ≥ 0 (keine Einspeisung gewollt): Entladen höchstens die Netto-Last (Last − PV), damit kein
 *     Akkustrom ins Netz geht, wenn keine Einspeisung angefordert ist.
 * Fehlen Netz- oder Akku-Messung (oder PV/Last für die Begrenzung), gibt es keine Zwangsvorgabe.
 *
 * @returns {{ mode: 'self'|'forced', command?: 'charge'|'discharge'|'stop', powerW?: number, reason: string }}
 */
export function decideEmsCommand({
  setpointW, gridImportW, batteryW, pvW = null, loadW = null,
  maxChargeW, maxDischargeW, bandW = 300, gain = 0.7, minPowerW = 50, noGridCharge = false,
  forced = false, socPct = null, floorSocPct = null
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
  if (p > 0) {
    p = Math.min(p, Number(maxChargeW));
    if (s <= 0 || noGridCharge === true) {
      const surplus = fin(pvW) && fin(loadW) ? Math.max(0, Number(pvW) - Number(loadW)) : 0;
      if (p > surplus) { p = surplus; reason = 'charge_pv_only'; }
    }
  } else if (p < 0) {
    if (belowFloor) { p = 0; reason = 'discharge_floor'; } // SoC am Boden → kein Entladen (nur dieser Takt)
    else {
      p = Math.max(p, -Number(maxDischargeW));
      if (s >= 0) {
        const netLoad = fin(pvW) && fin(loadW) ? Math.max(0, Number(loadW) - Number(pvW)) : 0;
        if (-p > netLoad) { p = -netLoad; reason = 'discharge_load_only'; }
      }
    }
  }
  const powerW = Math.round(Math.abs(p) / 10) * 10;
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
 * @returns {{masterW:number, slaveW:number, slaveUncommanded:boolean}}
 */
export function splitStrategyShares(strategy, {
  powerW, charge, masterMax, slaveMax, masterSoc, slaveSoc,
  masterCapacityWh, slaveCapacityWh, floorSocPct = 0, maxSocPct = 100, ratioMasterPct = 50, minPowerW = 50,
  masterFloorPct = floorSocPct, slaveFloorPct = floorSocPct, masterCeilPct = maxSocPct, slaveCeilPct = maxSocPct,
  socDeadbandPct = SOC_BALANCE_DEADBAND_PCT,
} = {}) {
  const fin = (v) => v != null && Number.isFinite(Number(v));
  const p = Math.max(0, Math.round(Number(powerW) || 0));
  let mMax = Math.max(0, Number(masterMax) || 0);
  let sMax = Math.max(0, Number(slaveMax) || 0);
  // Per-WR-SoC-Grenze (Aufgabe 1): ein WR, der seine Grenze in DIESER Richtung erreicht hat — beim Entladen den
  // eigenen Min-SoC (max aus hardFloor und 13059), beim Laden den eigenen Max-SoC (min aus maxSoc und 13058) —
  // bekommt 0 W; sein Anteil geht über splitSungrowPower an den anderen WR (bis zu DESSEN Grenze). SoC unbekannt →
  // nicht sperren (die System-Grenze im Regler schützt weiter). Symmetrisch für Laden/Entladen.
  const atLimit = (soc, floor, ceil) => fin(soc) && (charge ? (fin(ceil) && Number(soc) >= Number(ceil)) : (fin(floor) && Number(soc) <= Number(floor)));
  if (atLimit(masterSoc, masterFloorPct, masterCeilPct)) mMax = 0;
  if (atLimit(slaveSoc, slaveFloorPct, slaveCeilPct)) sMax = 0;
  const strat = SPLIT_STRATEGIES.includes(String(strategy)) ? String(strategy) : 'soc-balance';
  if (p <= 0) return { masterW: 0, slaveW: 0, slaveUncommanded: strat === 'master-only' };
  // master-only: Slave bleibt in Modus 0, Master bekommt alles (an seine Grenze geklemmt).
  if (strat === 'master-only') return { masterW: Math.min(p, mMax), slaveW: 0, slaveUncommanded: true };
  if (sMax <= 0) return { masterW: Math.min(p, mMax), slaveW: 0, slaveUncommanded: false }; // Slave offline/an Grenze → alles Master
  if (mMax <= 0) return { masterW: 0, slaveW: Math.min(p, sMax), slaveUncommanded: false }; // Master an Grenze → alles Slave
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
  return { masterW, slaveW, slaveUncommanded: false };
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
 */
export function createSungrowEms({ state, getCfg, transport: baseTransport, pushLog = () => {}, now = () => Date.now(), statePath = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), connOverride = null, statusKey = 'sungrowEms', slaveActuator = null, isSlave = false, forcedHeartbeatPath = null, modbusHealth = null }) {
  // Modbus-Gesundheit dieser Verbindung (N5/M7b): zählt jede Anfrage/jeden Fehler transparent. wrap() legt sich vor
  // den Transport; der Rest des Aktuators nutzt nur noch `transport` (gezählt). snapshot() geht in publish() an die
  // Kachel. Ein von außen übergebener Zähler (Master: ctx.sungrowMasterHealth) wird GETEILT — dann zählen Poll UND
  // EMS in denselben Master-Zähler (M7b). Ohne Übergabe ein eigener (Slave, Tests).
  const modbusHealthInst = modbusHealth || createModbusHealth(now);
  const transport = modbusHealthInst.wrap(baseTransport);
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
    lastStepAt: 0,
    writeDay: { key: null, regs: {} }, // Tages-Schreibzähler je Register (Verschleißschutz, Punkt 2)
    responseMs: null,    // gleitender Mittelwert der Schreib-/Rücklese-Antwortzeit (adaptiver Takt, Punkt 2)
    decision: null,
    error: null,
    neutralizedAt: null,  // pausedAt des Not-Halts, für den die eine Rücknahme schon lief
    revokedReason: null,  // ein Tor hat den letzten Sollwert abgelehnt
    acceptSeq: 0,         // zählt angenommene Sollwerte (Aufrufzeitpunkt) — eine ältere Ablehnung widerruft keinen neueren
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
  function touchForcedHeartbeat() {
    if (!forcedHeartbeatPath || isSlave) return;
    const t = now();
    if (st.lastForcedHeartbeatFileAt && t - st.lastForcedHeartbeatFileAt < 5000) return;
    st.lastForcedHeartbeatFileAt = t;
    try { atomicWriteControlState(forcedHeartbeatPath, { at: t, endpointKey: st.endpointKey }); }
    catch (e) { logOnce(e?.message || 'x', 'sungrow_ems_heartbeat_file_error', { error: e?.message || String(e) }, 'warn'); }
  }

  // Modus 4 (VPP) ist immer fremd; Modus 3 (External EMS) nur dann nicht, wenn DVhub ihn selbst gesetzt hat
  // (Merker). Modus 2 (Forced) gilt als fremdes EMS NUR, wenn DVhub gerade im Forced-Modus steuert (dann ist
  // Modus 2 „seiner" — ein nicht besessener Modus 2 am Master kommt von einem anderen System, B4). Steuert DVhub
  // per External EMS (Modus 3), ist ein Modus 2 nicht sein erwarteter Modus → die bisherige Bereinigung eines
  // liegengebliebenen Zwangsbetriebs (zurück in Self-consumption) bleibt.
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
    if (mode === EMS_MODE.FORCED) {
      const controlForced = resolveSungrowControl(getCfg()).modeValue === EMS_MODE.FORCED;
      if (!controlForced) return false;
      if (st.owns && st.ownMode === EMS_MODE.FORCED) return false;
      // Besitz-Merker weg, aber das Gerät zeigt DVhubs zuletzt geschriebenen Modus 2 → EIGENER Modus, NICHT fremd.
      return !ownWroteMode(EMS_MODE.FORCED, dev);
    }
    return false;
  };

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
      regulateEveryMs: adaptiveRegulateMs(getCfg()),
      // N5/M7b: gewählter Takt (0 = Auto) + Modbus-Gesundheit dieser Verbindung. responseMs = der Median aus der
      // Gesundheit (EINE „Antwort"-Zahl; der Regelzyklus steht separat in regulateEveryMs), kein eingefrorener Wert.
      regulateConfiguredMs: configuredRegulateMs(getCfg()),
      health: modbusHealthInst.snapshot(),
      responseMs: modbusHealthInst.responseMs() ?? st.responseMs,
      writesToday: { mode13050: writeDayBucket().regs[EMS_MODE_ADDR] || 0, cmd13051: st.writeDay.regs[EMS_CMD_ADDR] || 0, power13052: st.writeDay.regs[EMS_POWER_ADDR] || 0, heartbeat13080: st.writeDay.regs[HEARTBEAT_ADDR] || 0 },
      modeBudgetLeft: modeBudgetLeft(),
      target: st.target ? { setpointW: st.target.setpointW, source: st.target.source, at: st.target.at, noGridCharge: st.target.noGridCharge === true } : null,
      device: st.dev ? { ...st.dev } : null,
      decision: st.decision,
      owns: st.owns,
      ownMode: st.ownMode,
      error: st.error
    };
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
    st.hb = { key: null, supported: null };
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

  // Not-Halt vor JEDEM Write prüfen: ein Takt, der vor dem Eintritt begann, darf danach nichts mehr setzen.
  // Nur die eine Rücknahme (neutralize) darf im Not-Halt schreiben.
  async function writeReg(conf, address, value, { neutralize = false, claimMode = null, fc = 6 } = {}) {
    if (state.ctrl?.discretionaryWritesPaused && !neutralize) {
      const err = new Error('emergency_stop_active');
      err.code = 'emergency_stop_active';
      throw err;
    }
    // Besitz erst, wenn der Write wirklich rausgeht (nach dem Not-Halt-Tor), aber VOR der Bestätigung:
    // geht sie verloren, kann der Befehl trotzdem wirken (Codex 28317bd5).
    if (claimMode != null) setOwns(claimMode);
    // FC 16 (Write Multiple) für Register, die FC 06 (Write Single) nicht annehmen (manche Sungrow-Holding-
    // Register, u. a. 13080 am SH10RT-20): dasselbe Register, ein Wort.
    if (fc === 16) await transport.mbWriteMultiple({ ...endpoint(conf), address, values: [value & 0xffff] });
    else await transport.mbWriteSingle({ ...endpoint(conf), address, value: value & 0xffff });
    countWrite(address); // Tages-Schreibzähler je Register (Punkt 2)
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

  function foreignModeError(mode) {
    setOwns(null);
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
      await writeReg(conf, EMS_CMD_ADDR, EMS_CMD.STOP, { neutralize: true });
      await writeReg(conf, EMS_MODE_ADDR, EMS_MODE.SELF, { neutralize: true });
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
      await writeReg(conf, HEARTBEAT_ADDR, heartbeatS, { ...opt, fc });
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
  async function writeDecision(conf, decision, { neutralize = false, modeValue = EMS_MODE.FORCED, heartbeatS = null, forceAll = false, heartbeatAfterMode = true, heartbeatWriteFc = null, acceptDeviceHeartbeatS = 0 } = {}) {
    const dev = st.dev || await readDevice(conf);
    // Ein fremdes EMS/VPP wird nie übersteuert, auch nicht im Not-Halt. Der Slave (isSlave) folgt dem Master-Modus
    // (Feld #5) — ein Modus 2/3 am Slave ist Master-gesteuert, nicht fremd; nur VPP (4) am Slave wäre fremd.
    if (isSlave ? dev.mode === EMS_MODE.VPP : isForeignMode(dev.mode, dev)) throw foreignModeError(dev.mode);
    const writeStartedAt = now(); // Antwortzeit (Schreiben bis bestätigtes Rücklesen) für den adaptiven Takt (Punkt 2)
    if (decision.mode === 'self') {
      const opt = { neutralize };
      if (dev.cmd !== EMS_CMD.STOP) await writeReg(conf, EMS_CMD_ADDR, EMS_CMD.STOP, opt);
      // Modus 0 nur am Master schreiben — der Slave verwirft 13050 und folgt dem Master (Feld #5).
      if (!isSlave && dev.mode !== EMS_MODE.SELF) await writeReg(conf, EMS_MODE_ADDR, EMS_MODE.SELF, opt);
    } else {
      const opt = { neutralize, claimMode: modeValue };
      const cmd = CMD_BY_NAME[decision.command];
      if (decision.command !== 'stop' && (forceAll || dev.powerW !== decision.powerW)) await writeReg(conf, EMS_POWER_ADDR, decision.powerW, opt);
      if (forceAll || dev.cmd !== cmd) await writeReg(conf, EMS_CMD_ADDR, cmd, opt);
      // Nur am Master: Modus (13050) und — in External EMS — der Herzschlag. Der Slave bekommt NIE einen
      // Modus-Write (Feld #5: wird verworfen, der Slave folgt dem Master-Modus 2).
      const needHeartbeat = !isSlave && modeValue === EMS_MODE.EXTERNAL && (forceAll || dev.mode !== modeValue);
      const hb = async () => applyHeartbeat(conf, heartbeatS, opt, { writeFc: heartbeatWriteFc, acceptDeviceS: acceptDeviceHeartbeatS });
      if (needHeartbeat && !heartbeatAfterMode) await hb();
      if (!isSlave && (forceAll || dev.mode !== modeValue)) await writeReg(conf, EMS_MODE_ADDR, modeValue, opt);
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
    // Erst ein bestätigtes Self-consumption gibt den Besitz ab.
    if (decision.mode === 'self') setOwns(null);
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

  // Feldtest „Akku nicht laden" (M14b): während eines Abregelungs-Tests mit dieser
  // Option (state.ctrl.curtailmentTest.blockCharge) den Akku anhalten. Selbst-
  // ablaufend über das Lease (now < until) — endet garantiert mit dem Test.
  function curtailmentBatteryHold() {
    const ct = state.ctrl?.curtailmentTest;
    return !!(ct && ct.active === true && ct.blockCharge === true && now() < ct.until);
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
    if (st.lastTaktCfg !== undefined && taktCfg !== st.lastTaktCfg) st.lastStepAt = 0;
    st.lastTaktCfg = taktCfg;
    if (!(st.owns && (st.ownMode === EMS_MODE.EXTERNAL || st.ownMode === EMS_MODE.FORCED))) return opts.regulateEveryMs;
    return adaptiveRegulateMs(cfg);
  }
  const due = (everyMs) => now() - st.lastStepAt >= everyMs - TICK_JITTER_MS;

  // Beide WR sicher in Self-consumption (Split-Abbruch): Master neutralisieren (writeDecision self), Slave über
  // seinen eigenen Pfad, Besitz abgeben, Ziel verwerfen. Best effort — Self ist immer die sichere Seite.
  async function neutralizeBoth(reason) {
    // M2 (Feld 16.11.): den Besitz-Merker ERST abgeben, wenn die Rückgabe am Master BESTÄTIGT ist (writeDecision self
    // liest 13050=0 zurück). Scheitert sie (Lesefehler/Abweichung), Merker UND Ziel behalten — der nächste Takt tritt
    // die Rückgabe erneut an. Sonst hielte DVhub seinen eigenen Modus 2 für fremd (owns weg) und schriebe nie wieder.
    let masterSafe = false;
    try { st.dev = null; await writeDecision(sungrowEmsConf(getCfg()), { mode: 'self', reason }, { neutralize: true }); masterSafe = true; } catch { /* best effort — Merker bleibt, Wiederholung nächster Takt */ }
    try { await slaveActuator.neutralize(reason); } catch { /* best effort */ }
    st.revokedReason = reason;
    if (masterSafe) { setOwns(null); st.target = null; }
  }

  // Split-Steuerung: die Reglerentscheidung auf beide WR schreiben. Self → Master Self + Slave zurückziehen.
  // Forced → Leistung nach Punkt-2-Grenzen und SoC-Reserve/Headroom aufteilen, Slave zuerst, dann Master;
  // scheitert EINER (Herzschlag, Rücklesen, fremder Modus, …) → BEIDE sicher in Self-consumption.
  async function stepSplit({ conf, ctl, decision, gap, second, reason, t, opts }) {
    const cfg = getCfg();
    const optMaster = cfg.optimizer || {};
    const si = cfg.sungrow?.secondInverter || {};
    if (decision.mode === 'self') {
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
    // 13058) — alles real %. Der Puffer (kundeneinstellbar, Default 1) hält DVhub knapp über Sungrows Untergrenze
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
    const { masterW, slaveW, slaveUncommanded } = splitStrategyShares(strategy, {
      powerW: decision.powerW, charge, masterMax, slaveMax, masterSoc, slaveSoc,
      masterCapacityWh: optMaster.batteryCapacityWh, slaveCapacityWh: si.batteryCapacityWh,
      floorSocPct: floor, maxSocPct: maxSoc, masterFloorPct, slaveFloorPct, masterCeilPct, slaveCeilPct,
      ratioMasterPct: secondCfg.ratioMasterPct, minPowerW: opts.minPowerW,
      socDeadbandPct: secondCfg.socBalanceDeadbandPct,
    });
    const mk = (w) => (w >= opts.minPowerW ? { mode: 'forced', command: decision.command, powerW: w, reason: decision.reason } : { mode: 'forced', command: 'stop', powerW: 0, reason: decision.reason });
    // M16 (Feld 16.11., Christin Weg 1): Solange eine Abregelung/Sperre aktiv ist (Einspeisung am Netzpunkt gesperrt —
    // feedExcessDcPv=0 / dv_forced_off / Negativpreis / Test, alle über applyDvVictronControl → state.ctrl._lastDvFeedIn
    // === false), darf der Slave KEINE eigenen Lade-/Entladebefehle (13051/13052) bekommen. Steuerfunktionen gehen laut
    // Sungrow-Protokoll NUR an den Master, der verteilt selbst; DVhub steuert den Slave im Split aber direkt — damit
    // folgte der Slave der Master-Einspeisegrenze NICHT, seine PV lief weiter und er konnte ins Netz entladen. Lösung:
    // Slave fest auf 0xCC (Stopp, Modus 2 bleibt — er folgt dem Master), KEINE Leistung. Ohne eigene Befehle folgt seine
    // PV der Master-Grenze (13074=0 drosselt die System-PV am Netzpunkt), und er kann nicht ins Netz entladen. Der
    // Master regelt ALLEIN weiter (Netz-Sollwert wie gehabt, KEINE zusätzliche Master-Entladesperre); das 13050-Budget
    // bleibt unberührt (kein Moduswechsel). Nach der Freigabe (_lastDvFeedIn !== false) kehrt der Slave im nächsten Takt
    // über den normalen Pfad in den Split zurück (nur 13051/13052, kein Moduswechsel).
    const feedInBlocked = state.ctrl?._lastDvFeedIn === false;
    // Slave nicht kommandieren bei master-only ODER Notladung (uncontrollable) → nur best effort in Self halten.
    const skipSlave = slaveUncommanded || slaveEmergency;
    const slaveDecision = feedInBlocked
      ? { mode: 'forced', command: 'stop', powerW: 0, reason: 'curtailment_hold' }
      : (skipSlave ? { mode: 'self', command: 'stop', powerW: 0, reason: decision.reason } : mk(slaveW));
    let masterDecision = mk(masterW);
    let effMasterW = masterW; let effSlaveW = slaveW; let slaveFellBack = false; let slaveWrote = false; let slaveCurtailHold = false;
    // Slave zuerst (eigener Pfad neutralisiert sich bei Fehler selbst).
    if (feedInBlocked) {
      // Sperre aktiv: Slave aktiv auf 0xCC halten (nicht nur neutralize — das wäre ein No-op, wenn der Slave gerade nicht
      // besessen ist), seinen Anteil dem Master geben. Der Master hält den Netz-Sollwert allein ein; seine Einspeisegrenze
      // (13074=0) drosselt die System-PV. Scheitert der Slave-Stopp (Lese-/Schreibfehler), best effort neutralisieren —
      // der Master steuert trotzdem weiter (kein Modus 0 wegen eines Slave-Fehlers).
      slaveCurtailHold = true;
      effSlaveW = 0;
      effMasterW = Math.min(decision.powerW, masterMax);
      masterDecision = mk(effMasterW);
      const sr = await slaveActuator.applyDirectCommand(slaveDecision, ctl);
      slaveWrote = sr.ok === true && sr.unchanged !== true;
      if (!sr.ok) {
        try { await slaveActuator.neutralize('curtailment_hold_failed'); } catch { /* best effort */ }
        slaveFellBack = true;
      }
      logOnce('slave-curtail-hold', 'sungrow_ems_slave_curtail_hold', { side: 'slave', masterW: effMasterW, slaveWrote, slaveFellBack, text: 'Sungrow: Abregelung/Sperre aktiv — Slave auf 0xCC angehalten (keine eigenen Befehle), der Master regelt allein weiter (seine Einspeisegrenze 13074=0 drosselt die PV).' });
    } else if (skipSlave) {
      // master-only/Notladung: Slave in Modus 0 (Self) halten. Scheitert das nicht hart — der Slave liegt dann ohnehin in Self.
      try { await slaveActuator.neutralize('self'); } catch { /* best effort */ }
    } else {
      const sr = await slaveActuator.applyDirectCommand(slaveDecision, ctl);
      slaveWrote = sr.ok === true && sr.unchanged !== true; // echter Slave-Write (N4: Log/Status nur bei Änderung)
      if (!sr.ok) {
        // Absicherung C6 (Aufgabe 3): EIN Slave-Fehler (z. B. „EMS-Register lesen fehlgeschlagen: modbus exception 4",
        // Feld 15.11.) darf NICHT beide WR auf Modus 0 werfen (~20 s Ausfall). readDevice hat den Lesevorgang bereits
        // 1× nach 300 ms wiederholt (retryable). Scheitert der Slave trotzdem, faellt DVhub auf Master-only zurueck:
        // den Slave sicher zurueckziehen (0xCC, best effort) und seinen Anteil dem Master geben (bis zu dessen Grenze).
        // Der Master steuert weiter. Modus 0 (beide in Self) nur, wenn der MASTER selbst nicht sicher steuerbar ist
        // (naechster try-Block). Ein fremdes EMS am Slave (sr.foreign) wird ebenfalls nicht angefasst → Master-only.
        try { await slaveActuator.neutralize('split_slave_failed'); } catch { /* best effort */ }
        effSlaveW = 0;
        effMasterW = Math.min(decision.powerW, masterMax);
        masterDecision = mk(effMasterW);
        slaveFellBack = true;
        logOnce(`${sr.error}`, 'sungrow_ems_split_slave_fallback', { side: 'slave', error: sr.error || null, readError: sr.readError === true, masterW: effMasterW, text: 'Sungrow: Slave-Fehler im Split — Anteil auf den Master verlagert, der Master steuert weiter (kein Modus 0).' }, 'warn');
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
      slaveCurtailHold, // M16: Abregelung/Sperre aktiv → Slave auf 0xCC angehalten, Master regelt allein weiter
      slaveFellBack, // Aufgabe 3: Slave-Fehler → Anteil auf den Master verlagert, Master steuert weiter
    };
    // Master-Anteil. Scheitert er → beide sicher in Self.
    try {
      const mdev = (st.dev && t - st.dev.at < opts.deviceRecheckMs) ? st.dev : await readDevice(conf);
      if (isForeignMode(mdev.mode, mdev)) throw foreignModeError(mdev.mode);
      // Schreibdrossel (N4/Aufgabe 5): Master 13051 nur bei Befehlswechsel, 13052 nur bei Änderung > stepW — und das
      // Log sungrow_ems_split_write NUR bei echtem Write (im Feld lief es jede Sekunde, /api/log reichte ~3 min).
      // Bei gap (Herzschlag-Lücke/Wiederaufnahme) immer voll schreiben.
      if (!gap && emsMatches(mdev, masterDecision, opts.stepW, ctl.modeValue)) {
        st.error = null;
        st.decision = { ...decision, at: t, trigger: reason, split: splitDetail };
        // Hat der Slave in diesem Takt geschrieben, ist es ein echter Write → protokollieren; sonst stiller Takt.
        if (slaveWrote) pushLog('sungrow_ems_split_write', { command: decision.command, systemW: decision.powerW, masterW: effMasterW, slaveW: effSlaveW, strategy, slaveFellBack, side: 'slave', reason: decision.reason, trigger: reason, readback: { mode: mdev.mode, cmd: mdev.cmd, powerW: mdev.powerW } });
        publish();
        return { ok: true, split: true, unchanged: !slaveWrote, decision, masterW: effMasterW, slaveW: effSlaveW, slaveFellBack };
      }
      const back = await writeDecision(conf, masterDecision, { modeValue: ctl.modeValue, heartbeatS: ctl.heartbeatTimeoutS, forceAll: gap, heartbeatAfterMode: ctl.heartbeatAfterMode, heartbeatWriteFc: ctl.heartbeatWriteFc, acceptDeviceHeartbeatS: ctl.acceptDeviceHeartbeatS });
      st.error = null; st.logKeys = {};
      st.decision = { ...decision, at: t, trigger: reason, split: splitDetail };
      pushLog('sungrow_ems_split_write', { command: decision.command, systemW: decision.powerW, masterW: effMasterW, slaveW: effSlaveW, strategy, slaveFellBack, reason: decision.reason, trigger: reason, readback: { mode: back.mode, cmd: back.cmd, powerW: back.powerW } });
      publish();
      return { ok: true, split: true, decision, masterW: effMasterW, slaveW: effSlaveW, slaveFellBack };
    } catch (e) {
      // Der MASTER ist nicht sicher steuerbar → beide sicher in Self (Modus 0). Das ist der EINZIGE Weg zu Modus 0 im
      // Split (ein Slave-Fehler fuehrt oben nur auf Master-only, Aufgabe 3).
      await neutralizeBoth('split_master_failed');
      st.error = e?.message || String(e);
      logOnce(st.error, e?.code === 'foreign_ems_mode' ? 'sungrow_ems_foreign_mode' : 'sungrow_ems_split_aborted', { side: 'master', error: st.error }, 'warn');
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
    // 4b: positiven Sollwert zusätzlich hart auf die Anschlussgrenze deckeln (Netzladen ≤ limitKw).
    const gridLimitW = Number(cfg?.gridConnection?.limitKw) > 0 ? Number(cfg.gridConnection.limitKw) * 1000 : null;
    const clampGrid = (s) => (gridLimitW != null && Number.isFinite(Number(s)) && Number(s) > gridLimitW ? gridLimitW : s);
    const regulate = (setpointW) => decideEmsCommand({
      setpointW: clampGrid(setpointW), ...tel, maxChargeW: maxChargeCap, maxDischargeW: maxDischargeCap,
      bandW: 0, gain: opts.gain, minPowerW: opts.minPowerW, noGridCharge: noGridChargeNow,
      forced: true, socPct: isSplit ? null : socPct, floorSocPct: isSplit ? null : floorSocPct,
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
    // Feldtest „Akku nicht laden" (services/curtailment-test.js, M14b): während
    // eines Abregelungs-Tests mit dieser Option den Akku beider WR auf Stopp
    // (0xCC, Modus 2 bleibt), damit der PV-Überschuss sichtbar abgeregelt wird
    // (PV deckt nur die Hauslast, der Akku nimmt ihn nicht auf). Nur wenn DVhub
    // Forced wirklich besitzt — der Split trägt den Stopp an den Slave weiter
    // (stepSplit: powerW 0 → mk(0) → beide 0xCC). Selbst-ablaufend über das Lease.
    if (ownsForced && curtailmentBatteryHold()) {
      decision = { mode: 'forced', command: 'stop', powerW: 0, reason: 'curtailment_test_hold' };
    }
    st.decision = { ...decision, at: t, trigger: reason };
    st.selfBridgeSince = 0;
    st.externalEnteredAt = 0;
    try {
      // Gerätezustand höchstens alle deviceRecheckMs neu lesen (Note 6: RW-Register nicht im Sekundentakt lesen);
      // zwischendurch die Rücklesung der eigenen Writes nutzen. So fällt ein geräteeigener Rückfall auf Modus 0
      // (WR-Neustart) spätestens nach deviceRecheckMs auf — der Akku steht bis dahin im sicheren Eigenverbrauch.
      const dev = (st.dev && t - st.dev.at < opts.deviceRecheckMs) ? st.dev : await readDevice(conf);
      // Fremder Modus (VPP, oder Modus 2/3 ohne DVhub-Besitz) → nicht übersteuern (B4).
      if (isForeignMode(dev.mode, dev)) throw foreignModeError(dev.mode);
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
        logOnce(`reentry-${st.forcedReentryTimes.length}`, 'sungrow_ems_reentry', { count1h: st.forcedReentryTimes.length }, 'warn');
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
      if (slaveActuator) { try { await slaveActuator.neutralize('slave_telemetry_lost'); } catch { /* best effort */ } }
      if (decision.mode === 'self') {
        // Nur Einzel-WR, nicht besitzend: der Zustand passt schon (Gerät steht in Self), nichts schreiben.
        if (emsMatches(dev, decision, 0, ctl.modeValue)) { st.error = null; publish(); return { ok: true, unchanged: true, decision }; }
        await writeDecision(conf, decision, { modeValue: ctl.modeValue });
        setOwns(null);
        st.error = null; publish();
        return { ok: true, decision };
      }
      if (emsMatches(dev, decision, opts.stepW, ctl.modeValue)) {
        st.error = null; publish();
        return { ok: true, unchanged: true, decision };
      }
      const back = await writeDecision(conf, decision, { modeValue: ctl.modeValue });
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
        logOnce(String(e.mode), 'sungrow_ems_foreign_mode', { mode: e.mode, text: 'Sungrow steht im Forced-/External-EMS-/VPP-Modus eines anderen Systems — DVhub schreibt nichts' }, 'warn');
      } else if (e?.code === 'emergency_stop_active') {
        st.dev = null; publish();
        return { ok: false, blocked: true, error: 'emergency_stop_active' };
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
    const gate = deviceGate(cfg);
    if (gate) {
      st.error = gate;
      publish();
      return { ok: false, error: gate };
    }
    const opts = resolveSungrowEmsOptions(conf);
    const ctl = resolveSungrowControl(cfg);
    const t = now();
    st.lastStepAt = t;
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
        noGridCharge: noGridChargeForce()
      })
      : { mode: 'self', reason: st.target ? 'target_expired' : (st.revokedReason ? 'revoked' : 'no_setpoint') };
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
          await writeReg(conf, HEARTBEAT_ADDR, ctl.heartbeatTimeoutS, { fc: st.hb.workingFc || 6 });
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
            await writeReg(conf, EMS_POWER_ADDR, dev.powerW, { fc: 6 }); // Leistung neu schreiben = Lebenszeichen
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
      if (!gap && emsMatches(dev, decision, decision.mode === 'forced' ? opts.stepW : 0, ctl.modeValue)) {
        if (decision.mode === 'self') setOwns(null);
        st.error = null;
        publish();
        return { ok: true, unchanged: true, decision };
      }
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
      // Not-Halt gilt für BEIDE WR: auch den Slave (Split-Steuerung) einmal zurück in Self-consumption.
      if (slaveActuator) { try { await slaveActuator.neutralize('emergency_stop'); } catch { /* best effort */ } }
      if (st.neutralizedAt === pausedAt) return { ok: true, skipped: true, reason: 'already_done' };
      st.neutralizedAt = pausedAt;
      const cfg = getCfg();
      const conf = sungrowEmsConf(cfg);
      syncEndpoint(cfg);
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
      st.lastStepAt = now();
      try {
        // Schreibdrossel je WR (N4/Aufgabe 5, Feld 15.11.: der Slave schrieb per forceAll JEDEN Takt 13051+13052):
        // erst lesen, dann NUR schreiben, wenn der Befehl wechselt ODER die Leistung > stepW abweicht. Der Slave
        // folgt dem Master-Modus (ignoreMode), hält seinen Befehl im Forced mode — ein Rück-Schreiben jeden Takt
        // ist unnötig und verschleißt die Holding-Register.
        st.dev = null;
        const dev = await readDevice(conf);
        if (isSlave ? dev.mode === EMS_MODE.VPP : isForeignMode(dev.mode, dev)) throw foreignModeError(dev.mode);
        if (emsMatches(dev, decision, opts.stepW, control.modeValue, { ignoreMode: isSlave })) {
          // M12 (Feld 16.11.): steht der Slave schon im von DVhub geführten Zustand (Modus 2 + passender Befehl, z. B.
          // 0xCC am SoC-Boden — genau der Zustand nach eigener Freigabe / Neustart) und führt DVhub ihn regulär in
          // forced (decision.mode !== 'self', Gerät NICHT fremd — oben geprüft), dann ist das DVhubs EIGENER Zustand:
          // Besitz übernehmen, auch ohne Write. Sonst zeigt die Kachel „Besitz nein", obwohl DVhub den Slave führt.
          // Nur für den Slave; die M2-Fremderkennung am Master bleibt unberührt.
          if (isSlave && decision.mode !== 'self' && !(st.owns && st.ownMode === control.modeValue)) setOwns(control.modeValue);
          st.decision = { ...decision, at: now() };
          st.error = null;
          publish();
          return { ok: true, unchanged: true, decision, readback: dev };
        }
        const back = await writeDecision(conf, decision, {
          modeValue: control.modeValue, heartbeatS: control.heartbeatTimeoutS, forceAll: false,
          heartbeatAfterMode: control.heartbeatAfterMode, heartbeatWriteFc: control.heartbeatWriteFc,
          acceptDeviceHeartbeatS: control.acceptDeviceHeartbeatS,
        });
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
        if (e?.code === 'ems_read_error') return { ok: false, readError: true, error: st.error };
        return { ok: false, error: st.error };
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
  // Darum NICHT über writeDecision (das lehnt einen vermeintlich „fremden" Modus 2 ab) — die Register direkt setzen
  // und zurücklesen. Danach Besitz/Ziel/letzten Write zurücksetzen, damit DVhub nicht sofort wieder eintritt.
  function forceRelease(reason = 'manual_release') {
    return serial(async () => {
      const cfg = getCfg();
      const conf = sungrowEmsConf(cfg);
      if (!conf || transport?.type !== 'modbus') return { ok: true, skipped: true, reason: 'no_modbus' };
      syncEndpoint(cfg);
      const out = { ok: false };
      if (slaveActuator) { try { await slaveActuator.forceRelease(reason); } catch { /* best effort */ } }
      try {
        st.dev = null;
        await writeReg(conf, EMS_CMD_ADDR, EMS_CMD.STOP, { neutralize: true });
        if (!isSlave) await writeReg(conf, EMS_MODE_ADDR, EMS_MODE.SELF, { neutralize: true });
        const back = await readDevice(conf);
        out.ok = back.cmd === EMS_CMD.STOP && (isSlave || back.mode === EMS_MODE.SELF);
        out.device = { mode: back.mode, cmd: back.cmd, powerW: back.powerW };
      } catch (e) { out.error = e?.message || String(e); }
      setOwns(null); st.target = null; st.revokedReason = reason; st.lastMasterWrite = null;
      if (!isSlave) pushLog('sungrow_ems_manual_release', { reason, ok: out.ok, error: out.error || null, text: 'Sungrow manuell freigegeben (Modus 0, beide 0xCC).' }, out.ok ? undefined : 'warn');
      publish();
      return out;
    });
  }

  return { applySetpoint, revoke, acceptSeq, tick, emergencyStop, applyDirectCommand, neutralize, releaseControl, forceRelease, status: () => (publish(), state.ctrl?.[statusKey] || null), _st: st };
}

function describe(d, modeValue = EMS_MODE.FORCED) {
  if (d.mode === 'self') return 'Self-consumption';
  const name = modeValue === EMS_MODE.EXTERNAL ? 'External EMS' : 'Zwangsbetrieb';
  return d.command === 'stop' ? `${name} Stopp` : `${name} ${d.command === 'charge' ? 'Laden' : 'Entladen'} ${d.powerW} W`;
}
