#!/usr/bin/env node
// scripts/sungrow-forced-watchdog.mjs — unabhängiger Box-Watchdog (Absicherung C4, Dauer-Forced-Split).
//
// Läuft als eigener systemd-Timer (~alle 60 s), UNABHÄNGIG vom DVhub-Prozess — greift also auch, wenn DVhub hängt
// (nicht abgestürzt, aber reagiert nicht mehr). Prüft am Gerät: Steht der Master in Modus 2 (Forced), besitzt DVhub
// ihn (Merker) und ist das Lebenszeichen älter als die Frist (Standard 120 s) → DVhub führt den Forced mode nicht
// mehr nach → beide WR sicher zurück (Master Modus 0, beide 0xCC).
//
// systemd (Beispiel):
//   # sungrow-forced-watchdog.service  (Type=oneshot)
//   ExecStart=/usr/bin/node /opt/dvhub/dvhub/scripts/sungrow-forced-watchdog.mjs
//   Environment=DV_APP_CONFIG=/opt/dvhub/dvhub/config.json
//   Environment=DATA_DIR=/var/lib/dvhub
//   # sungrow-forced-watchdog.timer   OnUnitActiveSec=60s

import path from 'node:path';

import { loadConfigFile } from '../config-model.js';
import { createModbusTransport } from '../transport-modbus.js';
import { wire, sungrowEmsConf } from '../services/inverter/sungrow.js';
import { sungrowForcedSafeOff, readForcedMarker, readForcedHeartbeatAt, watchdogShouldRelease, forcedConnections, unsafeConfigWithMarker } from '../services/inverter/sungrow-forced-safeoff.js';

const MODE_ADDR = wire(13050);
const HARD_TIMEOUT_MS = Number(process.env.SUNGROW_WATCHDOG_TIMEOUT_MS) || 8000;
const STALE_MS = Number(process.env.SUNGROW_WATCHDOG_STALE_MS) || 120000;
const log = (msg, extra) => console.log(`[sungrow-forced-watchdog] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
const warn = (msg, extra) => console.error(`[sungrow-forced-watchdog] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);

async function main() {
  const configPath = process.env.DV_APP_CONFIG || path.join(process.cwd(), 'config.json');
  const dataDir = process.env.DATA_DIR || path.dirname(configPath);
  const statePath = path.join(dataDir, 'sungrow_ems_state.json');
  const heartbeatPath = path.join(dataDir, 'sungrow_forced_heartbeat.json');

  let cfg;
  try { cfg = loadConfigFile(configPath).effectiveConfig; }
  catch (e) { log('Config nicht lesbar', { error: e?.message || String(e) }); return; }
  const marker = readForcedMarker(statePath);
  // Restpunkt 1: ungültige Konfiguration + stehender Merker — DVhubs Modus 2 kann weiterlaufen, der Watchdog schreibt
  // nichts (C2). Laut melden statt still „kein Sungrow-EMS-Profil aktiv".
  if (!sungrowEmsConf(cfg)) {
    const unsafe = unsafeConfigWithMarker(cfg, marker);
    if (unsafe) { warn('Konfiguration ungültig — Forced-Merker steht, aber kein Schreibweg: NICHTS zurückgenommen. Wechselrichter von Hand prüfen (Modus 0, Befehl 0xCC).', unsafe); return; }
    log('kein Sungrow-EMS-Profil aktiv');
    return;
  }

  const { master, slave, masterKey } = forcedConnections(cfg);
  if (!master.host) { log('keine Master-Adresse'); return; }
  if (marker.endpointKey && marker.endpointKey !== masterKey) { log('Merker zeigt auf andere Verbindung'); return; }

  const transport = createModbusTransport({ connectTimeoutMs: 1500 });
  try {
    let liveMode = null;
    try {
      const regs = await transport.mbRequest({ host: master.host, port: master.port, unitId: master.unitId, fc: 3, address: MODE_ADDR, quantity: 1, timeoutMs: master.timeoutMs });
      liveMode = Array.isArray(regs) ? (Number(regs[0]) & 0xffff) : null;
    } catch (e) { log('Modus lesen fehlgeschlagen — nichts tun', { error: e?.message || String(e) }); return; }

    const heartbeatAt = readForcedHeartbeatAt(heartbeatPath);
    const d = watchdogShouldRelease({ liveMode, markerOwned: marker.owned, heartbeatAt, nowMs: Date.now(), staleMs: STALE_MS });
    if (!d.release) { log('kein Eingriff', { ...d, liveMode }); return; }

    log('verwaister Forced mode — Rücknahme', d);
    const out = await sungrowForcedSafeOff({ transport, master, slave });
    log('zurückgenommen', out);
  } finally {
    try { await transport.destroy(); } catch { /* best effort */ }
  }
}

const timer = setTimeout(() => { console.error('[sungrow-forced-watchdog] Gesamt-Timeout — Abbruch'); process.exit(0); }, HARD_TIMEOUT_MS);
timer.unref?.();
main().then(() => process.exit(0)).catch((e) => { console.error('[sungrow-forced-watchdog] Fehler:', e?.message || e); process.exit(0); });
