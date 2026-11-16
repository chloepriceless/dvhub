// services/inverter/sungrow-forced-safeoff.js — Sichere Rücknahme des Sungrow Forced mode VON AUSSEN (Absicherung
// C, Dauer-Forced-Split, 2026-11-15).
//
// Forced mode (13050=2) hat KEINEN geräteeigenen Rückfall. Fällt der DVhub-Prozess aus, ohne den Forced mode selbst
// freizugeben (Crash/SIGKILL, hängender Shutdown), bliebe der Akku im letzten Lade-/Entladebefehl stehen. Dieses
// Modul schreibt die Register je WR direkt per Modbus (kein laufender DVhub nötig) und wird von zwei Stellen genutzt:
//   • scripts/sungrow-forced-release.mjs  — systemd ExecStopPost (läuft, nachdem der Dienst gestoppt ist)
//   • scripts/sungrow-forced-watchdog.mjs — unabhängiger systemd-Timer (läuft, auch wenn DVhub hängt)
//
// Reihenfolge wie im Prozess (releaseControl): erst den Slave anhalten (13051=0xCC — KEIN 13050, der Slave folgt dem
// Master, Feld #5), dann den Master (13051=0xCC, dann 13050=0). Alles best effort je Register; wirft nicht.

import fs from 'node:fs';

import { wire, EMS_MODE, EMS_CMD, resolveSecondInverter, endpointKeyOf } from './sungrow.js';

const MODE_ADDR = wire(13050);
const CMD_ADDR = wire(13051);

/**
 * Beide WR sicher in Self-consumption schreiben. `master`/`slave`: { host, port, unitId, timeoutMs }. Ohne Slave
 * (null) nur der Master. Best effort je Register — ein Fehler an einem Register stoppt die anderen nicht.
 * @returns {Promise<{master:object, slave:object}>} was geschrieben wurde bzw. welcher Fehler auftrat
 */
export async function sungrowForcedSafeOff({ transport, master, slave = null }) {
  const out = { master: {}, slave: {} };
  const write = async (conn, address, value, bucket, key) => {
    try { await transport.mbWriteSingle({ host: conn.host, port: conn.port, unitId: conn.unitId, address, value, timeoutMs: conn.timeoutMs }); bucket[key] = true; }
    catch (e) { bucket[`${key}Error`] = e?.message || String(e); }
  };
  // Slave zuerst: nur Befehl 0xCC (kein Modus — folgt dem Master).
  if (slave && slave.host) await write(slave, CMD_ADDR, EMS_CMD.STOP, out.slave, 'cmd');
  // Master: Befehl 0xCC, dann Modus 0.
  if (master && master.host) {
    await write(master, CMD_ADDR, EMS_CMD.STOP, out.master, 'cmd');
    await write(master, MODE_ADDR, EMS_MODE.SELF, out.master, 'mode');
  }
  return out;
}

/**
 * Besitz-Merker lesen (sungrow_ems_state.json): DVhub schreibt { ownMode, endpointKey, at }, wenn es den Modus
 * besitzt. Fehlt die Datei, besitzt DVhub (bzw. besaß) den Modus NICHT → nichts anfassen (kein fremdes EMS stören).
 * @returns {{owned:boolean, ownMode:number|null, endpointKey:string|null, at:number|null}}
 */
export function readForcedMarker(statePath) {
  try {
    const m = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const ownMode = Number(m?.ownMode);
    return { owned: ownMode === EMS_MODE.FORCED, ownMode: Number.isFinite(ownMode) ? ownMode : null, endpointKey: typeof m?.endpointKey === 'string' ? m.endpointKey : null, at: Number(m?.at) || null };
  } catch { return { owned: false, ownMode: null, endpointKey: null, at: null }; }
}

/** Lebenszeichen-Zeitstempel (sungrow_forced_heartbeat.json) des Masters lesen. null, wenn keine/ungültige Datei. */
export function readForcedHeartbeatAt(heartbeatPath) {
  try { const h = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')); const at = Number(h?.at); return Number.isFinite(at) ? at : null; }
  catch { return null; }
}

/**
 * Entscheidung des unabhängigen Box-Watchdogs (Absicherung C4), reine Logik: den Forced mode zurücknehmen, wenn
 * der Master LIVE in Modus 2 steht, DVhub ihn besitzt (Merker) UND das Lebenszeichen älter als staleMs ist (DVhub
 * hängt oder ist tot — fährt den Forced mode nicht mehr nach). Steht der Master nicht in Modus 2 (sauber
 * freigegeben / Eigenverbrauch), besitzt DVhub ihn nicht (fremdes EMS) oder ist das Lebenszeichen frisch
 * (DVhub lebt): NICHTS tun.
 */
export function watchdogShouldRelease({ liveMode, markerOwned, heartbeatAt, nowMs, staleMs = 120000 }) {
  if (liveMode !== EMS_MODE.FORCED) return { release: false, reason: 'mode_not_forced' };
  if (!markerOwned) return { release: false, reason: 'not_owned' };
  const ageMs = heartbeatAt == null ? Infinity : nowMs - heartbeatAt;
  if (ageMs < staleMs) return { release: false, reason: 'heartbeat_fresh', ageMs };
  return { release: true, reason: 'orphaned_forced', ageMs };
}

/**
 * Entscheidung des Shutdown-Release (ExecStopPost, Absicherung C), reine Logik. A3-2 (Christin 16.11.2026): auch das
 * Release-Skript liest erst den LIVE-Modus, bevor es schreibt — nicht blind auf den Merker. Nur zurücknehmen, wenn
 * DVhub den Modus besitzt (Merker) UND der Master LIVE in Modus 2 (Forced) steht. KEINE Lebenszeichen-Prüfung (der
 * Dienst wird gerade beendet, die Rücknahme hat Vorrang). liveMode === null (Lesefehler) → NICHT schreiben, damit
 * kein blinder Write an ein Gerät geht, das nicht (mehr) in DVhubs Forced mode steht; der Box-Watchdog greift sonst.
 * @returns {{write:boolean, reason:string}}
 */
export function releaseShouldWrite({ liveMode, markerOwned }) {
  if (!markerOwned) return { write: false, reason: 'not_owned' };
  if (liveMode !== EMS_MODE.FORCED) return { write: false, reason: 'mode_not_forced' };
  return { write: true, reason: 'owned_forced' };
}

/** Master- und Slave-Verbindung aus der DVhub-Config (victron + sungrow.secondInverter). */
export function forcedConnections(cfg) {
  const v = cfg?.victron || {};
  const master = { host: String(v.host || '').trim(), port: Number(v.port) || 502, unitId: Number.isFinite(Number(v.unitId)) ? Number(v.unitId) : 1, timeoutMs: Number(v.modbusConnectTimeoutMs) || 1500 };
  const si = resolveSecondInverter(cfg);
  const slave = si.enabled ? { host: si.host, port: si.port, unitId: si.unitId, timeoutMs: si.timeoutMs } : null;
  // masterKey GENAU wie der Besitz-Merker bilden: der Merker speichert endpointKeyOf(cfg.victron) in Rohform
  // (host:port:unitId, fehlende Felder leer). Würde man hier die normalisierten Werte (port 502, unitId 1) nehmen,
  // wichen die Schlüssel bei einer Config ohne explizite port/unitId ab → die Skripte übersprängen fälschlich und
  // der Forced mode (ohne Rückfall) bliebe hängen (Review-Befund 2).
  return { master, slave, masterKey: endpointKeyOf(v) };
}
