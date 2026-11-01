#!/usr/bin/env node
// services/mobile-link/relay-server.js — eigenständiges Relay für die
// Handy-Kopplung (relay.dvhub.de oder selbst gehostet, siehe relay/README.md).
//
// Ein HTTP-Server mit WebSocket unter /v1/ws und /healthz. TLS macht der
// Reverse-Proxy davor (Caddy, nginx, Traefik) — die Inhalte sind ohnehin Ende
// zu Ende verschlüsselt, TLS schützt nur die Verbindungsdaten.
//
// Umgebung:
//   RELAY_PORT            Port (Standard 8787)
//   RELAY_HOST            Adresse (Standard 0.0.0.0)
//   RELAY_NAME            Name in der Begrüßung (Standard dvhub-relay)
//   RELAY_BOX_ALLOWLIST   optional: Datei mit erlaubten Box-IDs (eine je Zeile);
//                         ohne Datei darf jede Box das Relay nutzen
//   RELAY_MAX_BOXES       höchstens so viele Boxen gleichzeitig (Standard 10000)
//   RELAY_TRUST_PROXY     1 = Client-Adresse aus X-Forwarded-For lesen (nur Log)

import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRelay, wrapWebSocket } from './relay-core.js';

export const WS_PATH = '/v1/ws';

function loadAllowlist(file) {
  if (!file) return null;
  const read = () => new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));
  let set = read();
  // Änderungen ohne Neustart übernehmen.
  fs.watchFile(file, { interval: 5000 }, () => { try { set = read(); } catch { /* alte Liste behalten */ } });
  return (boxId) => set.has(boxId);
}

export function startRelayServer({
  port = Number(process.env.RELAY_PORT) || 8787,
  host = process.env.RELAY_HOST || '0.0.0.0',
  name = process.env.RELAY_NAME || 'dvhub-relay',
  allowBox = loadAllowlist(process.env.RELAY_BOX_ALLOWLIST) || (() => true),
  limits = process.env.RELAY_MAX_BOXES ? { maxBoxes: Number(process.env.RELAY_MAX_BOXES) } : {},
  log = (event, data) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data })),
  pingMs = 25_000,
} = {}) {
  const relay = createRelay({ name, allowBox, limits, log });
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, relay: name, ...relay.stats() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });
  // maxPayload knapp über der größten erlaubten Nachricht; den Rest prüft relay-core.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 + 4096 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== WS_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const remote = process.env.RELAY_TRUST_PROXY === '1'
        ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
        : req.socket.remoteAddress;
      relay.attach(wrapWebSocket(ws, { pingMs }), { remote });
    });
  });
  const ready = new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
  return {
    relay,
    server,
    ready,
    close() {
      relay.close();
      wss.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const r = startRelayServer();
  r.ready.then((addr) => console.log(`dvhub-relay listening on ${addr.address}:${addr.port}${WS_PATH}`));
  const stop = () => { r.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
