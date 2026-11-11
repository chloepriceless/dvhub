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
  const mode = o.controlMode === 'forced' ? 'forced' : 'external';
  const t = Math.round(Number(o.heartbeatTimeoutS));
  const heartbeatTimeoutS = Number.isFinite(t) ? Math.min(300, Math.max(20, t)) : 30;
  return { mode, modeValue: mode === 'forced' ? EMS_MODE.FORCED : EMS_MODE.EXTERNAL, heartbeatTimeoutS };
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
    bdcRatedW
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
  maxChargeW, maxDischargeW, bandW = 300, gain = 0.7, minPowerW = 50, noGridCharge = false
} = {}) {
  const fin = (v) => v != null && Number.isFinite(Number(v));
  if (!fin(setpointW)) return { mode: 'self', reason: 'no_setpoint' };
  const s = Number(setpointW);
  if (Math.abs(s) <= Math.max(0, Number(bandW) || 0)) return { mode: 'self', reason: 'band' };
  if (!fin(gridImportW) || !fin(batteryW)) return { mode: 'self', reason: 'telemetry_missing' };
  if (!(Number(maxChargeW) > 0) || !(Number(maxDischargeW) > 0)) return { mode: 'self', reason: 'power_limit_unknown' };
  const k = Math.min(1, Math.max(0.1, Number(gain) || 0.7));
  let p = Number(batteryW) + k * (s - Number(gridImportW));
  let reason = 'regulate';
  if (p > 0) {
    p = Math.min(p, Number(maxChargeW));
    if (s <= 0 || noGridCharge === true) {
      const surplus = fin(pvW) && fin(loadW) ? Math.max(0, Number(pvW) - Number(loadW)) : 0;
      if (p > surplus) { p = surplus; reason = 'charge_pv_only'; }
    }
  } else if (p < 0) {
    p = Math.max(p, -Number(maxDischargeW));
    if (s >= 0) {
      const netLoad = fin(pvW) && fin(loadW) ? Math.max(0, Number(loadW) - Number(pvW)) : 0;
      if (-p > netLoad) { p = -netLoad; reason = 'discharge_load_only'; }
    }
  }
  const powerW = Math.round(Math.abs(p) / 10) * 10;
  if (powerW < Math.max(0, Number(minPowerW) || 0)) return { mode: 'forced', command: 'stop', powerW: 0, reason };
  return { mode: 'forced', command: p > 0 ? 'charge' : 'discharge', powerW, reason };
}

const CMD_BY_NAME = { charge: EMS_CMD.CHARGE, discharge: EMS_CMD.DISCHARGE, stop: EMS_CMD.STOP };

/** Ist der Zustand am Gerät (Modus/Befehl/Leistung) schon das Gewünschte? */
export function emsMatches(dev, decision, toleranceW = 0, modeValue = EMS_MODE.FORCED) {
  if (!dev) return false;
  if (decision.mode === 'self') return dev.mode === EMS_MODE.SELF && dev.cmd === EMS_CMD.STOP;
  if (dev.mode !== modeValue || dev.cmd !== CMD_BY_NAME[decision.command]) return false;
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

// Takt, in dem schedule-eval tick() aufruft (ZFI_TICK_MS), und erlaubtes Zittern des Intervall-Timers.
const CALLER_TICK_MS = 5000;
const TICK_JITTER_MS = 250;

/** Schlüssel der Geräteverbindung (Adresse, Port, Unit-ID) — Erkennung und Schreib-Tor gelten je Verbindung. */
export function endpointKeyOf(v) {
  return `${v?.host ?? ''}:${v?.port ?? ''}:${v?.unitId ?? ''}`;
}

/**
 * Aktuator für den nachgebildeten Netz-Sollwert. Alle Writes nur über Holding-Register 13050–13052 und den
 * Herzschlag 13080, jede Änderung mit Rücklesen. Steuermodus nach cfg.sungrow: External EMS (Modus 3, Standard,
 * mit Herzschlag — fällt DVhub aus, kehrt der Wechselrichter selbst in Self-consumption zurück) oder Forced mode
 * (Modus 2, ohne Rückfall). Im Not-Halt: einmal zurück in Self-consumption, wenn DVhub den Modus gesetzt hat
 * (oder gesetzt haben könnte), danach nichts mehr — auch kein Herzschlag.
 */
export function createSungrowEms({ state, getCfg, transport, pushLog = () => {}, now = () => Date.now(), statePath = null }) {
  const st = {
    target: null,        // { setpointW, source, at }
    dev: null,           // letzter gelesener/bestätigter Gerätezustand { mode, cmd, powerW, at }
    owns: false,         // Zwangs-/EMS-Betrieb ist (womöglich) von DVhub — ab dem ersten Write, bis Self bestätigt ist
    ownMode: null,       // welchen Modus DVhub gesetzt hat (2 Forced, 3 External EMS)
    endpointKey: null,   // Verbindung, für die target/dev/owns gelten
    hb: { key: null, supported: null }, // gibt es das Herzschlag-Register an dieser Verbindung?
    lastHeartbeatAt: 0,
    sentTimeoutS: null,  // zuletzt an den Wechselrichter geschriebene Frist (gilt dort, bis eine neue rausging)
    lastStepAt: 0,
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

  // Modus 4 (VPP) ist immer fremd, Modus 3 nur dann nicht, wenn DVhub ihn selbst gesetzt hat.
  const isForeignMode = (mode) => mode === EMS_MODE.VPP
    || (mode === EMS_MODE.EXTERNAL && !(st.owns && st.ownMode === EMS_MODE.EXTERNAL));

  function publish() {
    if (!state.ctrl) return;
    const ctl = resolveSungrowControl(getCfg());
    state.ctrl.sungrowEms = {
      controlMode: ctl.mode,
      heartbeatTimeoutS: ctl.heartbeatTimeoutS,
      heartbeatSupported: st.hb.supported,
      lastHeartbeatAt: st.lastHeartbeatAt || null,
      target: st.target ? { setpointW: st.target.setpointW, source: st.target.source, at: st.target.at } : null,
      device: st.dev ? { ...st.dev } : null,
      decision: st.decision,
      owns: st.owns,
      ownMode: st.ownMode,
      error: st.error
    };
  }

  function endpoint(conf) {
    return { host: conf.host, port: conf.port, unitId: conf.unitId, timeoutMs: conf.timeoutMs };
  }

  // Verbindung gewechselt (andere Adresse/Port/Unit-ID): alles Gemerkte gehört zum alten Gerät.
  function syncEndpoint(cfg) {
    const key = endpointKeyOf(cfg?.victron);
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

  async function readDevice(conf) {
    const regs = await transport.mbRequest({ ...endpoint(conf), fc: 3, address: EMS_BLOCK_ADDRESS, quantity: 3 });
    if (!Array.isArray(regs) || regs.length < 3) throw new Error('EMS-Register: unvollständige Antwort');
    st.dev = { mode: Number(regs[0]) & 0xffff, cmd: Number(regs[1]) & 0xffff, powerW: Number(regs[2]) & 0xffff, at: now() };
    return st.dev;
  }

  // Herzschlag-Register vorhanden? Einmal je Verbindung lesen. Exception 1/2 oder 0xFFFF (Doku: nicht
  // vorhandenes U16) = Firmware zu alt. Andere Lesefehler entscheiden nichts (nächster Takt).
  async function heartbeatSupported(conf) {
    if (st.hb.key === st.endpointKey && st.hb.supported != null) return st.hb.supported;
    let supported;
    try {
      const regs = await transport.mbRequest({ ...endpoint(conf), fc: 3, address: HEARTBEAT_ADDR, quantity: 1 });
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
  async function writeReg(conf, address, value, { neutralize = false, claimMode = null } = {}) {
    if (state.ctrl?.discretionaryWritesPaused && !neutralize) {
      const err = new Error('emergency_stop_active');
      err.code = 'emergency_stop_active';
      throw err;
    }
    // Besitz erst, wenn der Write wirklich rausgeht (nach dem Not-Halt-Tor), aber VOR der Bestätigung:
    // geht sie verloren, kann der Befehl trotzdem wirken (Codex 28317bd5).
    if (claimMode != null) setOwns(claimMode);
    await transport.mbWriteSingle({ ...endpoint(conf), address, value: value & 0xffff });
  }

  function foreignModeError(mode) {
    setOwns(null);
    const err = new Error('sungrow_foreign_ems_mode');
    err.code = 'foreign_ems_mode';
    err.mode = mode;
    return err;
  }

  /**
   * Gewünschten Zustand schreiben (nur was abweicht; forceAll: alles) und zurücklesen. Wirft bei Fehler/Abweichung.
   * External EMS: Reihenfolge Leistung → Befehl → Herzschlag (Frist scharf) → Modus 3.
   */
  async function writeDecision(conf, decision, { neutralize = false, modeValue = EMS_MODE.FORCED, heartbeatS = null, forceAll = false } = {}) {
    const dev = st.dev || await readDevice(conf);
    // Ein fremdes EMS/VPP wird nie übersteuert, auch nicht im Not-Halt.
    if (isForeignMode(dev.mode)) throw foreignModeError(dev.mode);
    let heartbeatWritten = false;
    if (decision.mode === 'self') {
      const opt = { neutralize };
      if (dev.cmd !== EMS_CMD.STOP) await writeReg(conf, EMS_CMD_ADDR, EMS_CMD.STOP, opt);
      if (dev.mode !== EMS_MODE.SELF) await writeReg(conf, EMS_MODE_ADDR, EMS_MODE.SELF, opt);
    } else {
      const opt = { neutralize, claimMode: modeValue };
      const cmd = CMD_BY_NAME[decision.command];
      if (decision.command !== 'stop' && (forceAll || dev.powerW !== decision.powerW)) await writeReg(conf, EMS_POWER_ADDR, decision.powerW, opt);
      if (forceAll || dev.cmd !== cmd) await writeReg(conf, EMS_CMD_ADDR, cmd, opt);
      if (modeValue === EMS_MODE.EXTERNAL && (forceAll || dev.mode !== modeValue)) {
        await writeReg(conf, HEARTBEAT_ADDR, heartbeatS, opt);
        st.sentTimeoutS = heartbeatS;
        heartbeatWritten = true;
      }
      if (forceAll || dev.mode !== modeValue) await writeReg(conf, EMS_MODE_ADDR, modeValue, opt);
    }
    st.dev = null;
    const back = await readDevice(conf);
    if (!emsMatches(back, decision, 10, modeValue)) {
      const err = new Error(`EMS-Rücklesung weicht ab (Soll ${describe(decision, modeValue)}, Ist Modus ${back.mode}, Befehl 0x${back.cmd.toString(16)}, ${back.powerW} W)`);
      err.code = 'readback_mismatch';
      throw err;
    }
    if (heartbeatWritten) {
      const hb = await transport.mbRequest({ ...endpoint(conf), fc: 3, address: HEARTBEAT_ADDR, quantity: 1 });
      if (!Array.isArray(hb) || (Number(hb[0]) & 0xffff) !== heartbeatS) {
        const err = new Error(`Herzschlag-Rücklesung weicht ab (Soll ${heartbeatS} s, Ist ${Array.isArray(hb) ? hb[0] : hb})`);
        err.code = 'readback_mismatch';
        throw err;
      }
      st.lastHeartbeatAt = now();
    }
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

  // Abstand der Takte, solange DVhub External EMS fährt: höchstens ein Drittel der Herzschlag-Frist, auf den
  // 5-s-Takt des Aufrufers (schedule-eval) abgerundet — sonst wird aus 6,7 s faktisch 10 s (Codex ff728d09).
  // Die Toleranz fängt das Zittern des Intervall-Timers ab.
  function stepEveryMs(opts, ctl) {
    if (!(st.owns && st.ownMode === EMS_MODE.EXTERNAL)) return opts.regulateEveryMs;
    const frist = Math.min(ctl.heartbeatTimeoutS, st.sentTimeoutS ?? ctl.heartbeatTimeoutS) * 1000;
    const third = Math.max(CALLER_TICK_MS, Math.floor(frist / 3 / CALLER_TICK_MS) * CALLER_TICK_MS);
    return Math.min(opts.regulateEveryMs, third);
  }
  const due = (everyMs) => now() - st.lastStepAt >= everyMs - TICK_JITTER_MS;

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
    const targetFresh = st.target && t - st.target.at <= opts.targetMaxAgeMs;
    const tel = telemetry(cfg, opts);
    const bdc = Number(state.victron.device.bdcRatedW) || null;
    const cap = opts.maxPowerW != null ? (bdc ? Math.min(bdc, opts.maxPowerW) : opts.maxPowerW) : bdc;
    let decision = targetFresh
      ? decideEmsCommand({
        setpointW: st.target.setpointW, ...tel, maxChargeW: cap, maxDischargeW: cap,
        bandW: opts.bandW, gain: opts.gain, minPowerW: opts.minPowerW,
        noGridCharge: NO_GRID_CHARGE_SOURCES.has(String(st.target.source))
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
      const dev = st.dev && t - st.dev.at < opts.deviceRecheckMs ? st.dev : await readDevice(conf);
      if (isForeignMode(dev.mode)) throw foreignModeError(dev.mode);
      // Herzschlag im Takt, solange DVhub External EMS fährt und dabei bleibt (die Doku verlangt genau das:
      // den Wert innerhalb der Frist erneut schreiben).
      if (ownsExternal && !gap && decision.mode === 'forced' && dev.mode === EMS_MODE.EXTERNAL) {
        await writeReg(conf, HEARTBEAT_ADDR, ctl.heartbeatTimeoutS);
        st.sentTimeoutS = ctl.heartbeatTimeoutS;
        st.lastHeartbeatAt = now();
      }
      if (!gap && emsMatches(dev, decision, decision.mode === 'forced' ? opts.stepW : 0, ctl.modeValue)) {
        if (decision.mode === 'self') setOwns(null);
        st.error = null;
        publish();
        return { ok: true, unchanged: true, decision };
      }
      const back = await writeDecision(conf, decision, { modeValue: ctl.modeValue, heartbeatS: ctl.heartbeatTimeoutS, forceAll: gap });
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
  function applySetpoint(setpointW, source) {
    st.acceptSeq += 1;
    return serial(async () => {
      syncEndpoint(getCfg());
      const changed = !st.target || Number(st.target.setpointW) !== Number(setpointW);
      st.target = { setpointW: Number(setpointW), source, at: now() };
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

  return { applySetpoint, revoke, acceptSeq, tick, emergencyStop, status: () => (publish(), state.ctrl?.sungrowEms || null), _st: st };
}

function describe(d, modeValue = EMS_MODE.FORCED) {
  if (d.mode === 'self') return 'Self-consumption';
  const name = modeValue === EMS_MODE.EXTERNAL ? 'External EMS' : 'Zwangsbetrieb';
  return d.command === 'stop' ? `${name} Stopp` : `${name} ${d.command === 'charge' ? 'Laden' : 'Entladen'} ${d.powerW} W`;
}
