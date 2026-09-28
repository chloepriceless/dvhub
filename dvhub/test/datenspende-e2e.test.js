// test/datenspende-e2e.test.js — Datenspende Ende-zu-Ende: ECHTER DVhub-Prozess
// (server.js, ohne Hardware/DB) ↔ nachgebauter COMSYS-Server ↔ nachgebautes
// Shelly-Gerät. Prüft: Einwilligung/Einrichtung über die echte API, Messwerte
// eines echten Geräte-Adapters landen gebündelt beim Projekt, Pausieren,
// Trennen — und dass das Passwort nirgends gespeichert wird.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const DVHUB_DIR = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(200); }
  throw new Error(`Timeout: ${what}`);
}
function listen(handler) {
  return new Promise((res) => { const srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => res(srv)); });
}
const readBody = (req) => new Promise((res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let buf = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
    try { res(JSON.parse(buf.toString('utf8') || 'null')); } catch { res(null); }
  });
});

// Nachbau des COMSYS-Servers (Pfade/Antworten wie in der HA-Integration erwartet).
function fakeComsys() {
  const log = [];
  const batches = [];
  let meterN = 0;
  const handler = async (req, res) => {
    const body = await readBody(req);
    const p = new URL(req.url, 'http://x').pathname;
    log.push({ method: req.method, path: p, body, headers: req.headers });
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (p === '/api/v1/web/auth/sign-up/username') return send(201, { token: 'WEB-TOKEN', user: { id: 'user-1' } });
    if (p === '/api/v1/web/households') return send(201, { id: 'household-1' });
    if (p === '/api/v1/web/clients') return send(201, { id: 'client-1' });
    if (p === '/api/v1/web/auth/api-key/create') return send(201, { key: 'api-key-1' });
    if (p === '/api/v1/web/auth/sign-out') return send(200, {});
    if (req.headers['x-api-key'] !== 'api-key-1') return send(401, { error: 'unauthorized', message: 'key' });
    if (p === '/api/v1/clients/client-1/meters' && req.method === 'POST') return send(201, { meterId: `meter-${++meterN}` });
    if (p === '/api/v1/clients/client-1/meters/batch') {
      batches.push(body);
      const n = (body?.meters || []).reduce((s, m) => s + m.dt.length, 0);
      return send(201, { accepted: n, unknownMeters: [] });
    }
    return send(404, { error: 'not_found', message: p });
  };
  return { handler, log, batches };
}

test('Datenspende E2E: Einwilligung → Einrichtung → Shelly-Werte beim Projekt → Pause → Trennen', { timeout: 90_000 }, async (t) => {
  const comsys = fakeComsys();
  const comsysSrv = await listen(comsys.handler);
  const shellySrv = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 0, output: true, apower: 1234.5, aenergy: { total: 5000 } }));
  });
  const rig = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-ds-e2e-'));
  fs.mkdirSync(path.join(rig, 'etc', 'hersteller'), { recursive: true });
  fs.mkdirSync(path.join(rig, 'data'));
  fs.copyFileSync(path.join(DVHUB_DIR, 'hersteller', 'victron.json'), path.join(rig, 'etc', 'hersteller', 'victron.json'));
  const port = await freePort();
  fs.writeFileSync(path.join(rig, 'etc', 'config.json'), JSON.stringify({
    manufacturer: 'victron', httpPort: port, httpsPort: 0, victron: { host: '127.0.0.1' },
    devices: [{ id: 'waschmaschine', name: 'Waschmaschine', adapter: 'shelly-http',
      shelly: { host: `127.0.0.1:${shellySrv.address().port}`, pollIntervalSec: 1 } }],
    datenspende: { intervalSec: 5 },
  }));
  const out = fs.openSync(path.join(rig, 'dvhub.log'), 'w');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: DVHUB_DIR,
    env: { ...process.env, DV_APP_CONFIG: path.join(rig, 'etc', 'config.json'), DV_DATA_DIR: path.join(rig, 'data'),
      DV_DATENSPENDE_URL: `http://127.0.0.1:${comsysSrv.address().port}`, DV_DATENSPENDE_FLUSH_SEC: '2', NODE_ENV: 'test' },
    stdio: ['ignore', out, out],
  });
  t.after(() => {
    proc.kill('SIGKILL'); comsysSrv.close(); shellySrv.close();
    if (!process.env.KEEP_RIG) fs.rmSync(rig, { recursive: true, force: true });
  });
  const dv = (p) => `http://127.0.0.1:${port}${p}`;
  const call = async (p, body) => {
    const r = await fetch(dv(p), body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
  await waitFor(async () => { try { return (await fetch(dv('/healthz'))).ok; } catch { return false; } }, 30_000, 'DVhub bootet');

  // Ab Werk: nicht verbunden, nichts wird gesendet.
  const st0 = await waitFor(async () => {
    const s = await call('/api/datenspende/status');
    return s.j?.preview?.some((p) => p.key === 'device:waschmaschine') ? s : null;
  }, 15_000, 'Shelly-Wert in der Vorschau');
  assert.equal(st0.j.linked, false);
  assert.equal(st0.j.enabled, false);
  assert.equal(comsys.log.length, 0, 'ohne Einwilligung kein einziger Aufruf ans Projekt');

  // Fremde Webseite (ohne Nonce) kann nichts verknüpfen.
  const csrf = await call('/api/datenspende/link', { username: 'x', password: 'y', consent: true });
  assert.equal(csrf.status, 403);

  // Einwilligung + Einrichtung über die echte API.
  const link = await call('/api/datenspende/link', {
    mode: 'signup', username: 'christin', password: 'Sehr-Geheim-42', consent: true,
    household: { name: 'Testhaus', numberInhabitants: 3, zip: '52062', country: 'Deutschland' },
    uiToken: st0.j.uiToken,
  });
  assert.equal(link.status, 200, JSON.stringify(link.j));
  assert.equal(link.j.linked, true);
  assert.equal(link.j.enabled, true);
  const signup = comsys.log.find((l) => l.path.endsWith('/sign-up/username'));
  assert.equal(signup.body.consent, true);
  assert.equal(comsys.log.find((l) => l.path === '/api/v1/web/clients').body.type, 'dvhub');
  assert.deepEqual(comsys.log.find((l) => l.path === '/api/v1/web/households').body,
    { userId: 'user-1', name: 'Testhaus', numberInhabitants: 3, zip: '52062', country: 'Deutschland' });
  assert.ok(comsys.log.some((l) => l.path.endsWith('/sign-out')), 'Web-Session beendet');

  // Werte kommen gebündelt beim Projekt an — Shelly mit Leistung (W) und Energie (kWh).
  await waitFor(() => comsys.batches.some((b) => b.meters.some((m) => (m.power || []).includes(1234.5))), 30_000, 'Batch mit Shelly-Wert');
  const reg = comsys.log.filter((l) => l.path === '/api/v1/clients/client-1/meters' && l.method === 'POST').map((l) => l.body);
  const wm = reg.find((b) => b.name === 'Waschmaschine');
  assert.deepEqual(wm, { name: 'Waschmaschine', vendor: 'Shelly', model: 'shelly-http' });
  const batch = comsys.batches.find((b) => b.meters.some((m) => (m.power || []).includes(1234.5)));
  const m = batch.meters.find((x) => (x.power || []).includes(1234.5));
  assert.equal(m.energy[0], 5, 'aenergy.total 5000 Wh → 5 kWh');
  assert.match(batch.t0, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

  // Passwort nirgends im Datenverzeichnis.
  for (const f of fs.readdirSync(path.join(rig, 'data'))) {
    const full = path.join(rig, 'data', f);
    if (fs.statSync(full).isFile()) assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /Sehr-Geheim-42/, `Passwort in ${f}`);
  }
  const st1 = await call('/api/datenspende/status');
  assert.ok(st1.j.donated > 0);
  assert.equal(JSON.stringify(st1.j).includes('api-key-1'), false, 'Status verrät den API-Key nicht');

  // Pausieren (ohne Nonce, Not-Aus) → keine weiteren Batches.
  const off = await call('/api/datenspende/settings', { enabled: false });
  assert.equal(off.status, 200);
  await sleep(3000);
  const n = comsys.batches.length;
  await sleep(7000);
  assert.equal(comsys.batches.length, n, 'pausiert: nichts mehr gesendet');

  // Trennen → Zugang vergessen.
  const st2 = await call('/api/datenspende/status');
  const un = await call('/api/datenspende/unlink', { uiToken: st2.j.uiToken });
  assert.equal(un.status, 200);
  assert.equal(un.j.linked, false);
  assert.equal(fs.existsSync(path.join(rig, 'data', 'datenspende.json')), false);
});
