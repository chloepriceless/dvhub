#!/usr/bin/env node
// scripts/sungrow-forced-release.mjs — systemd ExecStopPost (Absicherung C, Dauer-Forced-Split).
//
// Läuft, NACHDEM der DVhub-Dienst gestoppt ist. Forced mode (13050=2) hat keinen geräteeigenen Rückfall: hat der
// Prozess den Modus nicht selbst freigegeben (Crash/SIGKILL/hängender Shutdown — dann steht der Merker noch), nimmt
// dieses Skript beide WR per Modbus sicher zurück (Master Modus 0, beide Befehl 0xCC). Hat DVhub sauber beendet,
// ist der Merker weg → nichts zu tun.
//
// systemd (Beispiel, im DVhub-.service unter [Service]):
//   ExecStopPost=/usr/bin/node /opt/dvhub/dvhub/scripts/sungrow-forced-release.mjs
//   Environment=DV_APP_CONFIG=/opt/dvhub/dvhub/config.json
//   Environment=DATA_DIR=/var/lib/dvhub
//
// Niemals blockieren: hartes Gesamt-Timeout, alles best effort, Exit 0 (ExecStopPost soll den Stop nicht aufhalten).

import path from 'node:path';

import { loadConfigFile } from '../config-model.js';
import { createModbusTransport } from '../transport-modbus.js';
import { sungrowForcedSafeOff, readForcedMarker, forcedConnections } from '../services/inverter/sungrow-forced-safeoff.js';
import { sungrowEmsConf } from '../services/inverter/sungrow.js';

const HARD_TIMEOUT_MS = Number(process.env.SUNGROW_RELEASE_TIMEOUT_MS) || 8000;
const log = (msg, extra) => console.log(`[sungrow-forced-release] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);

async function main() {
  const configPath = process.env.DV_APP_CONFIG || path.join(process.cwd(), 'config.json');
  const dataDir = process.env.DATA_DIR || path.dirname(configPath);
  const statePath = path.join(dataDir, 'sungrow_ems_state.json');

  let cfg;
  try { cfg = loadConfigFile(configPath).effectiveConfig; }
  catch (e) { log('Config nicht lesbar — nichts zu tun', { error: e?.message || String(e) }); return; }

  // Nur wenn der Netz-Sollwert überhaupt über den Sungrow-EMS nachgebildet wird.
  if (!sungrowEmsConf(cfg)) { log('kein Sungrow-EMS-Profil aktiv — nichts zu tun'); return; }

  const marker = readForcedMarker(statePath);
  if (!marker.owned) { log('kein Forced-Besitz-Merker — DVhub hat sauber freigegeben oder besaß Modus 2 nie'); return; }

  const { master, slave, masterKey } = forcedConnections(cfg);
  // Nur die Verbindung anfassen, an der DVhub den Modus besaß (Adresswechsel: nicht ein fremdes Gerät umschalten).
  if (marker.endpointKey && marker.endpointKey !== masterKey) {
    log('Merker zeigt auf eine andere Verbindung — nichts anfassen', { marker: marker.endpointKey, master: masterKey });
    return;
  }
  if (!master.host) { log('keine Master-Adresse in der Config — nichts zu tun'); return; }

  const transport = createModbusTransport({ connectTimeoutMs: 1500 });
  try {
    const out = await sungrowForcedSafeOff({ transport, master, slave });
    log('Forced mode zurückgenommen', out);
  } finally {
    try { await transport.destroy(); } catch { /* best effort */ }
  }
}

const timer = setTimeout(() => { console.error('[sungrow-forced-release] Gesamt-Timeout — Abbruch'); process.exit(0); }, HARD_TIMEOUT_MS);
timer.unref?.();
main().then(() => process.exit(0)).catch((e) => { console.error('[sungrow-forced-release] Fehler:', e?.message || e); process.exit(0); });
