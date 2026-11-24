// services/inverter/sungrow-second.js — Zweiter Sungrow-Hybrid im Master/Slave-Parallelbetrieb,
// NUR LESEND (T-0422, zwei WR, 2026-11-14).
//
// Hintergrund (offizielle Sungrow-Doku „Communication Protocol of Residential Hybrid Inverter“ V1.1.11,
// 2025-11-19, Abschnitt Energy Management): „For multi-inverter (master/slave) systems, this parameter only
// needs to be issued to the master.“ Dieselbe Notiz steht bei der Einspeisebegrenzung (Note 4) und der
// Wirkleistungsbegrenzung. Heißt: Die EMS-Steuerregister 13050/13051/13052 und der Herzschlag 13080 werden
// NUR an den Master geschrieben; der Master verteilt Laden/Entladen intern auf den Slave. DVhub steuert daher
// ausschließlich den Master (bestehender Pfad createSungrowEms). Ein zweiter Schreibpfad würde gegen die
// interne Koordination des Masters arbeiten — genau die „Gegenregelung“, die wir verhindern wollen.
//
// Dieser Dienst liest den ZWEITEN Wechselrichter nur aus (eigener Modbus-Pool, eigener träger Takt, kurzes
// Zeitlimit), damit eine hängende zweite Verbindung den Master-Steuerpfad nie ausbremst. Er schreibt NIE.
// (Punkt 3, Split-Steuerung: ein separater EMS-Aktuator — zweite createSungrowEms-Instanz in schedule-eval —
// SCHREIBT bei sungrow.secondInverter.control = 'split' an den Slave, über DENSELBEN Modbus-Pool wie dieser
// Lesedienst, damit ein WiNet-S nur einen Modbus-Client sieht. Dieser Lesedienst selbst bleibt reines Lesen.)
// Veröffentlicht state.sungrowSecond für die Anzeige. Nur wenn der Betreiber am Gerät geprüft hat, dass der
// Master die System-Summen NICHT meldet (jeder WR meldet nur seine eigene PV/Akku-Leistung), darf er
// sungrow.secondInverter.aggregateTelemetry einschalten — dann zählt createSungrowEms PV/Akku/Leistungsgrenze
// beider WR zusammen (System-Werte für den Regler). Netz und Last kommen immer vom Master (einziger Zähler).
//
// @module services/inverter/sungrow-second

import { safeInterval } from '../safe-async.js';
import { wire, runningStateText, resolveSecondInverter, isSungrowEmergencyCharge } from './sungrow.js';
import { createModbusHealth } from './modbus-health.js';
import { pickMonoNow, stampMono } from '../mono-clock.js';

export const SUNGROW_SECOND_TICK_MS = 5000;
const OFFLINE_AFTER_ERRORS = 3;
// Geräte-/Grenzwerte (bdc, Kapazität, Lade-/Entladegrenze, Min/Max-SoC) ändern sich praktisch nie — sie werden im
// LANGSAMEN Info-Takt gelesen (N3, Feld 15.11.), nicht in jedem 5-s-Lesetakt. So sinken die Modbus-Anfragen je Takt
// von ~11 auf 3 (Zustands-/SoC-Block + Akku + PV). Die zuletzt gelesenen Werte werden gecacht und jeden Takt
// mitveröffentlicht. 15 s ist der langsame Takt (N3: 10–30 s).
export const SUNGROW_SECOND_CONFIG_EVERY_MS = 15000;

// Draht-Adressen (Doku − 1), FC 4 (Input-Register), wie im Master-Profil hersteller/sungrow.json.
const ADDR = {
  batteryPowerW: wire(5214), // S32 le, Doku 5214–5215; Sungrow positiv = Entladen → scale −1 (DVhub: + = Laden)
  pvPowerW: wire(5017),      // U32 le, Doku 5017–5018 Total DC power (alle MPPT dieses WR)
  socPct: wire(13023),       // U16, Doku 13023, 0,1 %
  bdcRatedW: wire(5628),     // U16, Doku 5628, ×100 W (Nennleistung des Lade-/Entladewandlers)
  batteryCapacityWh: wire(5639), // U16, Doku 5639 „Battery Capacity – High precision", 0,01 kWh → Wh = ·10 (nur Vorschlag)
  runningState: wire(13000), // U16, Doku 13000
  maxChargeW: wire(33047),   // Holding, U16, ×10 W — Gerätegrenze Laden (B3: Standard-Ladegrenze)
  maxDischargeW: wire(33048), // Holding, U16, ×10 W — Gerätegrenze Entladen
  batteryCapacityLimit: wire(33049), // Holding, U16, ×10 Wh — konfigurierte Kapazität (GUI-Vorschlag)
  // Max-/Min-SoC je WR (Feld 15.11., Aufgabe 1): der WR hält seinen Min-SoC beim Entladen im Forced mode NICHT
  // selbst ein (der Slave lief per Notladung bis 10 % leer) — DVhub muss die Grenze je WR SELBST einhalten. Max-SoC
  // (13058) begrenzt das Laden, Min-SoC (13059) das Entladen. Holding, FC 3. Einheit 0,1 % wie der SoC 13023.
  maxSoc: wire(13058),       // Holding, U16, 0,1 % — Gerätegrenze Laden (Max-SoC)
  minSoc: wire(13059),       // Holding, U16, 0,1 % — Gerätegrenze Entladen (Min-SoC)
};

// Blöcke (N3, Feld 15.11.): statt vieler Einzel-Lesungen wenige zusammenhängende Blöcke.
//   • Zustands-/SoC-Block FC4 Doku 13000+46: runningState (Offset 0) UND SoC 13023 (Offset 23) in EINER Anfrage.
//   • Grenzen-Block  FC3 Doku 33047+3: Laden (0) · Entladen (1) · Kapazität (2), je ×10.
//   • SoC-Grenzen-Block FC3 Doku 13057+4: Max-SoC 13058 (Offset 1) · Min-SoC 13059 (Offset 2), je 0,1 %.
// Die FC-3-Blöcke werden je Verbindung EINMAL geprobt; wirft der WR eine Modbus-Ausnahme (illegale Adresse —
// im Feld trat genau das beim Block ab 33046 am Slave auf, Exception 4), wird für diese Verbindung dauerhaft auf
// Einzellesen der benötigten Register zurückgefallen. Ein transienter Fehler (Timeout/Reset) löst KEINEN
// Rückfall aus (nächster Takt probt den Block erneut).
const STATE_BLOCK_DOC = 13000;
const STATE_BLOCK_QTY = 46;
const STATE_SOC_OFFSET = 13023 - 13000; // SoC 13023 im Zustandsblock
const LIMITS_BLOCK_DOC = 33047;
const LIMITS_BLOCK_QTY = 3;
const SOC_BLOCK_DOC = 13057;
const SOC_BLOCK_QTY = 4;
const SOC_BLOCK_MAX_OFFSET = 13058 - 13057; // 1
const SOC_BLOCK_MIN_OFFSET = 13059 - 13057; // 2

// Eine echte Modbus-Ausnahme (illegale Adresse/Daten) heißt: der WR kennt den Block nicht → auf Einzellesen
// zurückfallen. Timeout/ECONNRESET/ETIMEDOUT sind transient (Verbindung) und lösen KEINEN Rückfall aus.
const isModbusException = (e) => /modbus exception \d/i.test(String(e?.message));

const U16_NA = 0xffff;
const U32_NA = 0xffffffff;

/** S32 aus zwei Worten (niederwertiges Wort zuerst, Doku Beispiel 4.2). */
function s32le(regs) {
  if (!Array.isArray(regs) || regs.length < 2) return null;
  const u = ((Number(regs[1]) & 0xffff) << 16 | (Number(regs[0]) & 0xffff)) >>> 0;
  if (u === U32_NA) return null;
  return u >= 0x80000000 ? u - 0x100000000 : u;
}
/** U32 aus zwei Worten (niederwertiges Wort zuerst). */
function u32le(regs) {
  if (!Array.isArray(regs) || regs.length < 2) return null;
  const u = ((Number(regs[1]) & 0xffff) << 16 | (Number(regs[0]) & 0xffff)) >>> 0;
  return u === U32_NA ? null : u;
}
const u16 = (w) => {
  const v = Number(w) & 0xffff;
  return v === U16_NA ? null : v;
};

export function createSungrowSecond(ctx, deps = {}) {
  const now = deps.now || Date.now;
  // A23 b (Christin 23.11.2026): Config-Takt und Modbus-Gesundheit monoton; updatedAt bleibt Wanduhr (Anzeige).
  // A24: updatedAt bekommt beim Veröffentlichen eine monotone Marke (stampMono) — die Frische-Prüfung der Verbraucher
  // (secondInverterTelemetry) misst damit.
  const monoNow = pickMonoNow(deps.monoNow, deps.now);
  // Modbus-Gesundheit des Slave-WR (N5): zählt die Lese-Anfragen/Fehler dieses Pollers (Feld: ~1 Lesefehler auf
  // 4000 Slave-Anfragen). wrap() zählt transparent; der eigentliche Transport bleibt unverändert.
  // M22: Lesefehler des Slave als sungrow_modbus_error ins Protokoll (source poll), Häufungen zusammengefasst.
  const modbusHealth = createModbusHealth(now, { pushLog: (...a) => ctx.pushLog?.(...a), wr: 'slave', source: 'poll', monoNow });
  const transport = modbusHealth.wrap(deps.transport);
  let timer = null;
  let running = false;
  let online = null;
  let errors = 0;
  // Block-Fähigkeit und Geräte-/Grenzwert-Cache je Verbindung (Host:Port:Unit). Wechselt die Verbindung, wird alles
  // neu geprobt und neu gelesen (anderes Gerät).
  let capKey = null;
  let limitsBlockOk = true; // FC3 33047+3 blockweise lesbar?
  let socBlockOk = true;    // FC3 13057+4 blockweise lesbar?
  let configCache = null;   // zuletzt gelesene Geräte-/Grenzwerte (langsamer Takt)
  let configAt = null;      // wann zuletzt gelesen (monoton); null = beim nächsten erfolgreichen Takt lesen

  function resetForEndpoint(key) {
    if (key === capKey) return;
    capKey = key;
    limitsBlockOk = true;
    socBlockOk = true;
    configCache = null;
    configAt = null;
  }

  function publish(extra) {
    ctx.state.sungrowSecond = {
      enabled: false, online: null, host: null,
      batteryPowerW: null, pvPowerW: null, socPct: null, bdcRatedW: null,
      maxChargeWDevice: null, maxDischargeWDevice: null, batteryCapacityLimitWh: null,
      maxSocPctDevice: null, minSocPctDevice: null,
      runningState: null, runningStateText: null, emergencyCharge: false, aggregate: false,
      // N5: Modbus-Gesundheit des Slave-Lesepfads + wirksamer Lesetakt (ms).
      health: modbusHealth.snapshot(), tickMs: SUNGROW_SECOND_TICK_MS,
      errors, updatedAt: now(), ...extra,
    };
    stampMono(ctx.state.sungrowSecond, 'updatedAt', { clock: monoNow });
  }

  async function readReg(c, address, quantity) {
    return transport.mbRequest({ host: c.host, port: c.port, unitId: c.unitId, fc: 4, address, quantity, timeoutMs: c.timeoutMs });
  }

  function setAvailable(next, host, error) {
    if (next === online) return;
    online = next;
    if (next === false) ctx.pushLog?.('sungrow_second_offline', { host, error: error || null }, 'warn');
    if (next === true) ctx.pushLog?.('sungrow_second_online', { host });
  }

  async function tick() {
    if (running) return; // ein langsamer zweiter WR darf keine Takte stapeln
    running = true;
    try { await runTick(); } finally { running = false; }
  }

  // FC 3 lesen (Holding). Reine Lesung.
  const mbReq3 = (c, address, quantity) => transport.mbRequest({ host: c.host, port: c.port, unitId: c.unitId, fc: 3, address, quantity, timeoutMs: c.timeoutMs });
  const ten10 = (v) => (v == null || v === 0 ? null : v * 10);
  const socPct = (v) => (v == null ? null : Math.min(100, Math.max(0, v / 10)));

  // Einen FC-3-Block [startDoc, startDoc+qty) lesen; bei Modbus-Ausnahme je Verbindung dauerhaft auf Einzellesen der
  // benötigten Doku-Adressen (docByOffset[i], null = nicht gebraucht) zurückfallen. Ergebnis: Array der Länge qty mit
  // u16 je Offset (fehlend/Fehler/transient → null). getOk/setOk halten das Block-Flag der Verbindung.
  async function readFc3BlockOrSingle(c, startDoc, qty, getOk, setOk, docByOffset) {
    const res = new Array(qty).fill(null);
    if (getOk()) {
      try {
        const b = await mbReq3(c, wire(startDoc), qty);
        if (!Array.isArray(b) || b.length < qty) throw new Error('short block');
        for (let i = 0; i < qty; i += 1) res[i] = u16(b[i]);
        return res;
      } catch (e) {
        if (isModbusException(e)) setOk(false); // Block nicht lesbar → ab jetzt Einzellesen
        else return res; // transient: dieser Takt null, nächster Takt probt den Block erneut
      }
    }
    for (let i = 0; i < qty; i += 1) {
      const doc = docByOffset[i];
      if (doc == null) continue;
      try { res[i] = u16((await mbReq3(c, doc, 1))?.[0]); } catch { /* null */ }
    }
    return res;
  }

  // Geräte-/Grenzwerte im langsamen Takt lesen (best effort, einzelne Fehler → null). bdc/Kapazität liegen weit
  // auseinander (nicht blockbar), die vier FC-3-Grenzwerte kommen als zwei Blöcke.
  async function readConfig(c) {
    const out = { bdcRatedW: null, batteryCapacitySuggestionWh: null, maxChargeWDevice: null, maxDischargeWDevice: null, batteryCapacityLimitWh: null, maxSocPctDevice: null, minSocPctDevice: null };
    try { const bdc = u16((await readReg(c, ADDR.bdcRatedW, 1))?.[0]); out.bdcRatedW = bdc == null || bdc === 0 ? null : bdc * 100; } catch { /* null */ }
    try { const cap = u16((await readReg(c, ADDR.batteryCapacityWh, 1))?.[0]); out.batteryCapacitySuggestionWh = cap == null || cap === 0 ? null : Math.round(cap * 10); } catch { /* null */ }
    const limits = await readFc3BlockOrSingle(c, LIMITS_BLOCK_DOC, LIMITS_BLOCK_QTY, () => limitsBlockOk, (v) => { limitsBlockOk = v; }, [ADDR.maxChargeW, ADDR.maxDischargeW, ADDR.batteryCapacityLimit]);
    out.maxChargeWDevice = ten10(limits[0]);
    out.maxDischargeWDevice = ten10(limits[1]);
    out.batteryCapacityLimitWh = ten10(limits[2]);
    const socs = await readFc3BlockOrSingle(c, SOC_BLOCK_DOC, SOC_BLOCK_QTY, () => socBlockOk, (v) => { socBlockOk = v; }, [null, ADDR.maxSoc, ADDR.minSoc, null]);
    out.maxSocPctDevice = socPct(socs[SOC_BLOCK_MAX_OFFSET]);
    out.minSocPctDevice = socPct(socs[SOC_BLOCK_MIN_OFFSET]);
    return out;
  }

  async function runTick() {
    const cfg = ctx.getCfg() || {};
    const c = resolveSecondInverter(cfg);
    if (!c.enabled) {
      if (online !== null) setAvailable(null);
      online = null; errors = 0;
      publish({ enabled: false, reason: 'not_configured' });
      return;
    }
    if (transport?.type !== 'modbus') {
      publish({ enabled: true, online: false, host: c.host, aggregate: c.aggregateTelemetry, reason: 'no_modbus' });
      return;
    }
    resetForEndpoint(`${c.host}:${c.port}:${c.unitId}`);

    let readOk = false;
    let lastError = null;
    const out = { batteryPowerW: null, pvPowerW: null, socPct: null, runningState: null };
    try {
      // Live-Telemetrie je Takt: Akku (FC4 5214+2), PV (FC4 5017+2), Zustands-/SoC-Block (FC4 13000+46 → runningState
      // Offset 0 und SoC 13023 Offset 23 in einer Anfrage).
      const bat = await readReg(c, ADDR.batteryPowerW, 2);
      const sv = s32le(bat);
      out.batteryPowerW = sv == null ? null : -sv; // Sungrow positiv = Entladen → DVhub positiv = Laden
      const pv = await readReg(c, ADDR.pvPowerW, 2);
      out.pvPowerW = u32le(pv);
      const state = await readReg(c, wire(STATE_BLOCK_DOC), STATE_BLOCK_QTY);
      if (!Array.isArray(state) || state.length < STATE_BLOCK_QTY) throw new Error('short state block');
      out.runningState = u16(state[0]);
      out.socPct = u16(state[STATE_SOC_OFFSET]) == null ? null : u16(state[STATE_SOC_OFFSET]) / 10;
      errors = 0;
      readOk = true;
    } catch (e) {
      errors += 1;
      lastError = e?.message || String(e);
    }

    // Geräte-/Grenzwerte nur im langsamen Takt (und beim ersten erfolgreichen Lesen), danach gecacht weiterreichen.
    if (readOk && (!configCache || configAt == null || monoNow() - configAt >= SUNGROW_SECOND_CONFIG_EVERY_MS)) {
      configCache = await readConfig(c);
      configAt = monoNow();
    }

    if (errors >= OFFLINE_AFTER_ERRORS) {
      setAvailable(false, c.host, lastError);
      configAt = null; // bei Rückkehr frische Grenzwerte lesen
    }
    if (readOk) setAvailable(true, c.host);

    const ok = online === true;
    const cc = ok ? (configCache || {}) : {};
    publish({
      enabled: true, online: ok, host: c.host, aggregate: c.aggregateTelemetry,
      batteryPowerW: ok ? out.batteryPowerW : null,
      pvPowerW: ok ? out.pvPowerW : null,
      socPct: ok ? out.socPct : null,
      bdcRatedW: cc.bdcRatedW ?? null,
      batteryCapacitySuggestionWh: cc.batteryCapacitySuggestionWh ?? null,
      maxChargeWDevice: cc.maxChargeWDevice ?? null,
      maxDischargeWDevice: cc.maxDischargeWDevice ?? null,
      batteryCapacityLimitWh: cc.batteryCapacityLimitWh ?? null,
      maxSocPctDevice: cc.maxSocPctDevice ?? null,
      minSocPctDevice: cc.minSocPctDevice ?? null,
      runningState: ok ? out.runningState : null,
      runningStateText: ok ? runningStateText(out.runningState) : null,
      // Notladung (Aufgabe 2): der WR lädt unter seinem Min-SoC eigenmächtig aus dem Netz (runningState 0x4001) —
      // NICHT steuerbar. Nur bei bestätigter Verbindung aussagekräftig.
      emergencyCharge: ok ? isSungrowEmergencyCharge(out.runningState) : false,
      reason: ok ? null : (readOk ? null : 'read_failed'),
    });
  }

  function start() {
    if (timer) return;
    publish({ enabled: resolveSecondInverter(ctx.getCfg() || {}).enabled, reason: 'starting' });
    timer = safeInterval('sungrow-second', tick, SUNGROW_SECOND_TICK_MS);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, status: () => ctx.state.sungrowSecond || null };
}
