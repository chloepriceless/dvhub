#!/usr/bin/env node
// ios/interop/harness.mjs — echte DVhub-Gegenstelle für App- und Swift-Tests.
//
// Startet das eigenständige Relay (dvhub/services/mobile-link/relay-server.js)
// und den Box-Agenten (createMobileLink) mit nachgebildeten Werten, dazu das
// eingebettete Heimnetz-Relay unter /api/mobile-link/ws. Gibt den QR-Text aus
// und gibt jede Kopplung automatisch frei (danach gleich ein neuer QR-Code).
//
//   PATH=/opt/homebrew/opt/node@22/bin:$PATH node ios/interop/harness.mjs
//
// Umgebung:
//   HARNESS_RELAY_PORT  (Standard 18787)   HARNESS_LAN_PORT (Standard 18788)
//   HARNESS_PERMS       read | read,control (Standard read)
//   HARNESS_QR_FILE     Datei, in die der aktuelle QR-Text geschrieben wird
//   HARNESS_NO_LAN=1    QR ohne Heimnetz-Adresse (nur Relay)
//   HARNESS_APPROVE_DELAY_MS  Freigabe erst nach so vielen ms (Vergleichscode ansehen)
// Signale: SIGUSR1 = Box offline (Agent stoppen), SIGUSR2 = Box wieder online.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dvhubDir = path.resolve(here, '../../dvhub');
const require = createRequire(path.join(dvhubDir, 'package.json'));
const { WebSocketServer } = require('ws');
const { startRelayServer } = await import(path.join(dvhubDir, 'services/mobile-link/relay-server.js'));
const { createMobileLink } = await import(path.join(dvhubDir, 'services/mobile-link/agent.js'));

const relayPort = Number(process.env.HARNESS_RELAY_PORT) || 18787;
const lanPort = Number(process.env.HARNESS_LAN_PORT) || 18788;
const perms = String(process.env.HARNESS_PERMS || 'read').split(',').map((s) => s.trim()).filter(Boolean);
const qrFile = process.env.HARNESS_QR_FILE || null;
const noLan = process.env.HARNESS_NO_LAN === '1';
const approveDelayMs = Number(process.env.HARNESS_APPROVE_DELAY_MS) || 0;
let scannedAt = 0;

const relay = startRelayServer({ port: relayPort, host: '127.0.0.1', log: () => {} });
await relay.ready;
const relayUrl = `ws://127.0.0.1:${relayPort}/v1/ws`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-harness-'));
const cfg = { httpPort: lanPort, mobileLink: { enabled: true, relayUrl, name: 'DVhub Testanlage' } };
let emergencyStop = false;

// Nachgebildete Anlage: Werte ändern sich langsam, damit Live sichtbar ist.
function compactStatus() {
  const t = Date.now() / 1000;
  const pv = Math.max(0, Math.round(4200 + 1800 * Math.sin(t / 40)));
  const load = Math.round(900 + 300 * Math.sin(t / 7));
  const battery = Math.round((pv - load) * 0.6);
  const grid = pv - load - battery;
  return {
    ts: new Date().toISOString(),
    soc: Math.round((62 + 3 * Math.sin(t / 90)) * 10) / 10,
    batteryPowerW: battery,
    pvTotalW: pv,
    gridSetpointW: -50,
    gridImportW: grid < 0 ? -grid : 0,
    gridExportW: grid > 0 ? grid : 0,
    loadW: load,
    minSocPct: 10,
    alarmsActive: 0,
    alarmsSeverity: 0,
    alarmsStale: false,
    emergencyStop,
    telemetryFrozen: false,
    supportTunnelOpen: false,
    todayNetEur: 3.21,
    todayRevenueEur: 4.05,
    todayCostEur: 0.84,
    version: 'harness',
    controls: { dv: { profile: 'plexlog', curtailed: false, limitPct: null, until: null }, negativePrice: { protection: true, active: false } },
  };
}

function series(query) {
  const u = new URLSearchParams(query);
  const keys = (u.get('keys') || 'battery_soc_pct').split(',');
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const rows = [];
  const nowMs = Date.now();
  for (let ms = start.getTime(); ms < nowMs; ms += 900_000) {
    const h = new Date(ms).getHours() + new Date(ms).getMinutes() / 60;
    const pv = Math.max(0, Math.round(7000 * Math.sin(Math.PI * (h - 6) / 14)));
    const load = Math.round(600 + 400 * Math.abs(Math.sin(h)));
    const vals = {
      pv_total_w: h > 6 && h < 20 ? pv : 0,
      load_power_w: load,
      self_consumption_w: load,
      battery_soc_pct: Math.round(40 + 40 * Math.sin(Math.PI * (h - 4) / 20)),
      battery_power_w: Math.round(((h > 6 && h < 20 ? pv : 0) - load) * 0.5),
      grid_import_w: h < 7 ? load : 0,
      grid_export_w: h > 9 && h < 17 ? Math.round(pv * 0.3) : 0,
    };
    for (const k of keys) if (k in vals) rows.push({ key: k, ts: new Date(ms).toISOString(), value: vals[k], unit: k.endsWith('pct') ? '%' : 'W', resolution: 900 });
  }
  return { ok: true, keys, start: start.toISOString(), end: new Date(start.getTime() + 86400_000).toISOString(), total: rows.length, data: rows };
}

function eosPlan() {
  const rows = [];
  const t0 = Math.floor(Date.now() / 900_000) * 900_000;
  for (let i = 0; i < 96; i++) {
    const ms = t0 + i * 900_000;
    const h = new Date(ms).getHours() + new Date(ms).getMinutes() / 60;
    const pvWh = Math.max(0, Math.round(1600 * Math.sin(Math.PI * (h - 6) / 14)));
    rows.push({ ts_utc: new Date(ms).toISOString(), socPct: Math.round(30 + 50 * Math.sin(Math.PI * (h - 5) / 18) ** 2), pvWh, gridFeedinWh: Math.round(pvWh * 0.4) });
  }
  return { ok: true, available: true, reason: null, output: { slotMinutes: 15, rows, truncated: false, totalCount: rows.length }, plan: { fetchedAt: new Date().toISOString() } };
}

async function loopback(method, p, bodyText) {
  const [pathname, query = ''] = p.split('?');
  if (method === 'GET' && pathname === '/api/status') return { status: 200, body: { ok: true, victron: compactStatus(), harness: true } };
  if (method === 'GET' && pathname === '/api/telemetry/series') return { status: 200, body: series(query) };
  if (method === 'GET' && pathname === '/api/eos/plan') return { status: 200, body: eosPlan() };
  if (method === 'GET' && pathname === '/api/costs') return { status: 200, body: { ok: true, netEur: 3.21 } };
  if (method === 'POST' && pathname === '/api/control/stop') { emergencyStop = true; return { status: 200, body: { ok: true, emergencyStop: true } }; }
  if (method === 'POST' && pathname === '/api/control/resume') { emergencyStop = false; return { status: 200, body: { ok: true, emergencyStop: false } }; }
  return { status: 404, body: { ok: false, error: 'harness_not_found', method, path: p, body: bodyText ? JSON.parse(bodyText) : null } };
}

let agent = null;
function makeAgent() {
  const a = createMobileLink({
    getCfg: () => cfg, getDataDir: () => dataDir,
    pushLog: (e, d) => console.log(`[box] ${e} ${JSON.stringify(d || {})}`),
  }, {
    buildStatus: compactStatus,
    loopback,
    // Heimnetz-Adresse der Testbox: der Mac selbst (Simulator teilt das Netz).
    networkHosts: () => (noLan ? [] : ['127.0.0.1']),
  });
  a.start();
  return a;
}

// Heimnetz-Weg: eingebettetes Relay hinter einem eigenen HTTP-Server.
const lanServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
lanServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/api/mobile-link/ws' || !agent) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => agent.attachLan(ws, { remote: req.socket.remoteAddress }));
});
await new Promise((r) => lanServer.listen(lanPort, '127.0.0.1', r));

let lastPairingAt = 0;
let approveToken = null;
function newPairing() {
  lastPairingAt = Date.now();
  // Testläufe koppeln oft: an der Gerätegrenze das älteste Testgerät entfernen.
  const st = agent.status();
  if (st.devices.length >= st.maxDevices) agent.removeDevice(st.devices[0].id);
  const p = agent.startPairing({ lanHost: null });
  approveToken = p.approveToken;
  let qr = p.qr;
  if (noLan) {
    // Heimnetz-Adressen aus dem QR-Inhalt entfernen (nur Relay testen).
    const q = new URLSearchParams(qr.slice('dvhub://pair?'.length));
    q.delete('l');
    qr = 'dvhub://pair?' + q.toString();
  }
  console.log(`QR=${qr}`);
  if (qrFile) fs.writeFileSync(qrFile, qr + '\n');
}

agent = makeAgent();
// Kurz warten, bis das Relay die Box kennt, dann ersten QR ausgeben.
await new Promise((r) => setTimeout(r, 300));
newPairing();

// Freigabe automatisch, danach sofort neuer QR-Code.
setInterval(() => {
  if (!agent) return;
  const st = agent.status();
  if (st.pairing?.status === 'scanned') {
    if (!scannedAt) scannedAt = Date.now();
    if (Date.now() - scannedAt < approveDelayMs) return;
    scannedAt = 0;
    // Vergleichscode der Box für die Swift-Tests ablegen (gleich wie in der App?).
    if (qrFile) fs.writeFileSync(`${qrFile}.code`, String(st.pairing.candidate?.code ?? st.pairing.code ?? ''));
    try {
      agent.approvePairing({ perms, approveToken });
    } catch (e) {
      console.log(`[harness] Freigabe fehlgeschlagen: ${e.message}`);
    }
  } else if (!st.pairing && Date.now() - lastPairingAt > 700) {
    newPairing();
  }
}, 200).unref();
// Briefkasten oft füllen, damit der Offline-Fall schnell testbar ist.
setInterval(() => agent?._pushMailboxLatest(), 3000).unref();

console.log(`RELAY=${relayUrl}`);
console.log(`LAN=ws://127.0.0.1:${lanPort}/api/mobile-link/ws`);
console.log(`PERMS=${perms.join(',')}`);
console.log('READY');

// Box offline/online schalten: Store bleibt (gleicher Datenordner).
process.on('SIGUSR1', () => {
  console.log('[harness] Box offline');
  agent?.stop();
  agent = null;
  // Der alte QR-Code gilt nicht mehr (Kopplung lebt nur im laufenden Agenten).
  if (qrFile) fs.writeFileSync(qrFile, '');
});
process.on('SIGUSR2', () => { if (!agent) { console.log('[harness] Box online'); agent = makeAgent(); } });
const stop = async () => { agent?.stop(); await relay.close(); lanServer.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
