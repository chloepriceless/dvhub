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
//   RELAY_TRUST_PROXY     Anzahl Reverse-Proxys davor (1 = Caddy). Dann zählt als
//                         Quelladresse der Eintrag, den der äußerste Proxy in
//                         X-Forwarded-For angehängt hat (von rechts gezählt) —
//                         nie der clientgesetzte vordere (Strix H-0001). Gilt nur,
//                         wenn die Gegenstelle selbst eine private Adresse hat.
//                         Die Adresse zählt für die Grenze je Quelle.

import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRelay, createSocketGuard, WS_SERVER_OPTIONS } from './relay-core.js';

export const WS_PATH = '/v1/ws';

function loadAllowlist(file) {
  if (!file) return null;
  const read = () => new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));
  let set = read();
  // Änderungen ohne Neustart übernehmen.
  fs.watchFile(file, { interval: 5000 }, () => { try { set = read(); } catch { /* alte Liste behalten */ } });
  return (boxId) => set.has(boxId);
}

// Private/lokale Gegenstelle = Proxy im eigenen Netz (Docker-Netz, localhost).
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    return x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80:');
  }
  return false;
}

// Adresse ohne Klammern, IPv4 aus „::ffff:a.b.c.d“ ausgepackt; null, wenn keine IP.
function unwrapIp(raw) {
  let ip = String(raw || '').trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  return net.isIP(ip) ? ip.toLowerCase() : null;
}

// Zählschlüssel: IPv4 wie sie ist, IPv6 auf das /64 gekürzt — ein Anschluss
// hat meist ein ganzes /64, sonst wäre die Grenze je Quelle wirkungslos.
function remoteKey(raw) {
  const ip = unwrapIp(raw);
  if (!ip || net.isIPv4(ip)) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  if ([...h, ...t].some((g) => g.includes('.'))) return ip; // eingebettetes IPv4: selten, unverändert
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// Quelladresse für die Grenze je Quelle (Strix H-0001).
export function clientAddress(req, trustProxy = process.env.RELAY_TRUST_PROXY) {
  const peerRaw = req.socket?.remoteAddress || '';
  const peer = remoteKey(peerRaw) || peerRaw || null;
  const hops = Number.parseInt(trustProxy, 10);
  const peerIp = unwrapIp(peerRaw);
  if (!(hops > 0) || !peerIp || !isPrivate(peerIp)) return peer;
  const list = String(req.headers?.['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Jeder Proxy hängt die Adresse seiner Gegenstelle hinten an: was der
  // äußerste (vom Internet aus erste) gesehen hat, steht an Stelle `hops` von rechts.
  const key = list.length >= hops ? remoteKey(list[list.length - hops]) : null;
  return key || peer;
}

export function startRelayServer({
  port = Number(process.env.RELAY_PORT) || 8787,
  host = process.env.RELAY_HOST || '0.0.0.0',
  name = process.env.RELAY_NAME || 'dvhub-relay',
  allowBox = loadAllowlist(process.env.RELAY_BOX_ALLOWLIST) || (() => true),
  limits = process.env.RELAY_MAX_BOXES ? { maxBoxes: Number(process.env.RELAY_MAX_BOXES) } : {},
  log = (event, data) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data })),
  pingMs = 25_000,
  // Grenzen für Ausgangspuffer und angefangene Rahmen (relay-core.js SOCKET_LIMITS).
  socketLimits = {},
} = {}) {
  const relay = createRelay({ name, allowBox, limits, log });
  const guard = createSocketGuard(socketLimits);
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, relay: name, ...relay.stats(), ...guard.stats() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });
  // maxPayload = Obergrenze (größter Box-Rahmen). Vor der Anmeldung und je
  // Rolle gilt die engere Grenze des Wächters, den Rest prüft relay-core.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 + 4096, ...WS_SERVER_OPTIONS });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== WS_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const remote = clientAddress(req);
      relay.attach(guard.wrap(ws, { remote, pingMs }), { remote });
    });
  });
  const ready = new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
  return {
    relay,
    server,
    ready,
    socketStats: () => guard.stats(),
    close() {
      relay.close();
      guard.close();
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
