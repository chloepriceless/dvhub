// test/eosdash-proxy-headers.test.js -- Strix W2 (30.10.2026): der EOSdash-Proxy
// übernahm die Kopfzeilen von EOSdash 1:1, strich X-Frame-Options und setzte
// keine eigenen (läuft vor handleRequest, SECURITY_HEADERS greifen dort nicht).
// Eine fremde Seite konnte /eosdash/ einbetten (Clickjacking unter lanTrust
// „Offen“). Jetzt: Einbetten nur von DVhub selbst, nosniff, kein Referrer.
// Bewusst NICHT die volle DVhub-CSP: EOSdash bettet Bokeh-JavaScript inline
// ein, script-src 'self' bräche die Diagramme.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEosdashProxy } from '../services/eosdash-proxy.js';

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

async function rig(upstreamHeaders) {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...upstreamHeaders });
    res.end('<html><script>Bokeh.embed()</script></html>');
  });
  const upPort = await listen(upstream);
  const proxy = createEosdashProxy({ pushLog: () => {} }, { port: upPort });
  const front = http.createServer((req, res) => proxy(req, res));
  const port = await listen(front);
  const get = () => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/eosdash/' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    }).on('error', reject);
  });
  return { get, close: () => { upstream.close(); front.close(); } };
}

test('W2: geproxte EOSdash-Seite nur von DVhub selbst einbettbar, nosniff, kein Referrer', async () => {
  const r = await rig({ 'x-frame-options': 'DENY' });
  try {
    const res = await r.get();
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(res.headers['content-security-policy'], "frame-ancestors 'self'");
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  } finally { r.close(); }
});

test('W2: eine CSP von EOSdash bleibt, frame-ancestors kommt dazu (keine script-src von DVhub)', async () => {
  const r = await rig({ 'content-security-policy': "default-src 'self' 'unsafe-inline'" });
  try {
    const res = await r.get();
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /^default-src 'self' 'unsafe-inline'; frame-ancestors 'self'$/);
  } finally { r.close(); }
});

test('W2: frame-ancestors von EOSdash wird durch die eigene Regel ersetzt', async () => {
  const r = await rig({ 'content-security-policy': "frame-ancestors *; img-src *" });
  try {
    const res = await r.get();
    assert.equal(res.headers['content-security-policy'], "img-src *; frame-ancestors 'self'");
  } finally { r.close(); }
});

test('W2: auch die 502-Antwort (EOSdash nicht erreichbar) trägt die Kopfzeilen', async () => {
  const blocker = http.createServer();
  const deadPort = await listen(blocker);
  blocker.close();
  const proxy = createEosdashProxy({ pushLog: () => {} }, { port: deadPort });
  const front = http.createServer((req, res) => proxy(req, res));
  const port = await listen(front);
  try {
    const res = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/eosdash/' }, (x) => { x.resume(); x.on('end', () => resolve(x)); }).on('error', reject);
    });
    assert.equal(res.statusCode, 502);
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  } finally { front.close(); }
});
