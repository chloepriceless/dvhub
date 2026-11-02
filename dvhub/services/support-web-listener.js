// services/support-web-listener.js — eigener Listener für das Web-Ziel des
// Support-Tunnels (Strix T-0001). Nur auf 127.0.0.1; jede Anfrage trägt
// req.dvhubSupportTunnel = true, damit routes-api.js sie nicht als „die Box
// selbst“ behandelt (kein Loopback-Freibrief, keine Freigaben, Audit-Kennung).
import http from 'node:http';

export const SUPPORT_WEB_HOST = '127.0.0.1';

/**
 * @param {{ handler: Function, port: number, onError?: Function, onListening?: Function }} opts
 * @returns {import('node:http').Server}
 */
export function startSupportWebListener({ handler, port, onError = () => {}, onListening = () => {} }) {
  const server = http.createServer((req, res) => {
    req.dvhubSupportTunnel = true;
    return handler(req, res);
  });
  server.on('error', onError);
  server.listen(port, SUPPORT_WEB_HOST, () => onListening(server.address()));
  return server;
}
