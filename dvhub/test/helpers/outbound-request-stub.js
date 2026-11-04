// Fängt http(s).request() ab (z. B. den ntfy-Versand, der seit der
// Gesamtprüfung 1.0.9 mit geprüfter Namensauflösung statt fetch sendet) —
// ohne Netz. calls: { url, host, auth } je Anfrage; Antwort 200.
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';

export async function withOutboundRequests(fn, { status = 200 } = {}) {
  const calls = [];
  const real = { http: http.request, https: https.request };
  const fake = (url, opts, cb) => {
    const u = url instanceof URL ? url : new URL(String(url));
    calls.push({ url: u.href, host: u.hostname, auth: opts?.headers?.Authorization || null });
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.resume = () => {};
        cb(res);
        setImmediate(() => { res.emit('end'); req.emit('close'); });
      });
    };
    return req;
  };
  http.request = fake;
  https.request = fake;
  try { return await fn(calls); } finally { http.request = real.http; https.request = real.https; }
}
