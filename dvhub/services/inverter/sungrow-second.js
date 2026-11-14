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
import { wire, runningStateText, resolveSecondInverter } from './sungrow.js';

export const SUNGROW_SECOND_TICK_MS = 5000;
const OFFLINE_AFTER_ERRORS = 3;

// Draht-Adressen (Doku − 1), FC 4 (Input-Register), wie im Master-Profil hersteller/sungrow.json.
const ADDR = {
  batteryPowerW: wire(5214), // S32 le, Doku 5214–5215; Sungrow positiv = Entladen → scale −1 (DVhub: + = Laden)
  pvPowerW: wire(5017),      // U32 le, Doku 5017–5018 Total DC power (alle MPPT dieses WR)
  socPct: wire(13023),       // U16, Doku 13023, 0,1 %
  bdcRatedW: wire(5628),     // U16, Doku 5628, ×100 W (Nennleistung des Lade-/Entladewandlers)
  batteryCapacityWh: wire(5639), // U16, Doku 5639 „Battery Capacity – High precision", 0,01 kWh → Wh = ·10 (nur Vorschlag)
  runningState: wire(13000), // U16, Doku 13000
};

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
  const transport = deps.transport;
  const now = deps.now || Date.now;
  let timer = null;
  let running = false;
  let online = null;
  let errors = 0;

  function publish(extra) {
    ctx.state.sungrowSecond = {
      enabled: false, online: null, host: null,
      batteryPowerW: null, pvPowerW: null, socPct: null, bdcRatedW: null,
      runningState: null, runningStateText: null, aggregate: false,
      errors, updatedAt: now(), ...extra,
    };
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

    let readOk = false;
    let lastError = null;
    const out = { batteryPowerW: null, pvPowerW: null, socPct: null, bdcRatedW: null, batteryCapacitySuggestionWh: null, runningState: null };
    try {
      const bat = await readReg(c, ADDR.batteryPowerW, 2);
      const sv = s32le(bat);
      out.batteryPowerW = sv == null ? null : -sv; // Sungrow positiv = Entladen → DVhub positiv = Laden
      const pv = await readReg(c, ADDR.pvPowerW, 2);
      out.pvPowerW = u32le(pv);
      const soc = await readReg(c, ADDR.socPct, 1);
      out.socPct = u16(soc?.[0]) == null ? null : u16(soc[0]) / 10;
      try { const bdc = u16((await readReg(c, ADDR.bdcRatedW, 1))?.[0]); out.bdcRatedW = bdc == null || bdc === 0 ? null : bdc * 100; } catch { out.bdcRatedW = null; }
      try { const cap = u16((await readReg(c, ADDR.batteryCapacityWh, 1))?.[0]); out.batteryCapacitySuggestionWh = cap == null || cap === 0 ? null : Math.round(cap * 10); } catch { out.batteryCapacitySuggestionWh = null; }
      try { out.runningState = u16((await readReg(c, ADDR.runningState, 1))?.[0]); } catch { out.runningState = null; }
      errors = 0;
      readOk = true;
    } catch (e) {
      errors += 1;
      lastError = e?.message || String(e);
    }

    if (errors >= OFFLINE_AFTER_ERRORS) setAvailable(false, c.host, lastError);
    if (readOk) setAvailable(true, c.host);

    const ok = online === true;
    publish({
      enabled: true, online: ok, host: c.host, aggregate: c.aggregateTelemetry,
      batteryPowerW: ok ? out.batteryPowerW : null,
      pvPowerW: ok ? out.pvPowerW : null,
      socPct: ok ? out.socPct : null,
      bdcRatedW: ok ? out.bdcRatedW : null,
      batteryCapacitySuggestionWh: ok ? out.batteryCapacitySuggestionWh : null,
      runningState: ok ? out.runningState : null,
      runningStateText: ok ? runningStateText(out.runningState) : null,
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
