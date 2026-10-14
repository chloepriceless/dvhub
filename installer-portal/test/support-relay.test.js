// installer-portal/test/support-relay.test.js — Fern-Support über das Portal
// (2026-10-14): Laufzeit/Schlüssel aus dem Poll, Freischaltung beim Relay über
// den Auftragsordner, „Tunnel öffnen“ mit Ports; dazu die Härtung der
// Geräteschlüssel (nur Prüfwert, konstanter Vergleich, Dateirechte 0600).
//
// Der root-Dienst des Relays wird durch das echte enroll-from-portal.py mit
// einem Ersatz-Renderer in einem Testverzeichnis vertreten.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const SERVER = path.join(import.meta.dirname, '..', 'server.js');
const ENROLL = path.join(import.meta.dirname, '..', '..', 'support-relay', 'enroll-from-portal.py');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function relayDirs() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-relay-'));
  for (const sub of ['req', 'res', 'keys', 'ak']) fs.mkdirSync(path.join(d, sub));
  fs.writeFileSync(path.join(d, 'registry.json'), JSON.stringify({ appliances: {} }));
  const render = path.join(d, 'render.sh');
  fs.writeFileSync(render, '#!/usr/bin/env bash\ncp "$RELAY_REGISTRY" "$RELAY_AK_DIR/dvhub-support"\n');
  return d;
}

// Vertritt support-relay-enroll.path: läuft das echte Skript, sobald ein Auftrag liegt.
function startEnrollWatcher(t, d) {
  let stop = false;
  const loop = async () => {
    while (!stop) {
      if (fs.readdirSync(path.join(d, 'req')).some((f) => f.endsWith('.json'))) {
        execFileSync('python3', [ENROLL], {
          env: {
            ...process.env, RELAY_DIR: d, RELAY_REGISTRY: path.join(d, 'registry.json'), RELAY_KEYS_DIR: path.join(d, 'keys'),
            RELAY_REQUEST_DIR: path.join(d, 'req'), RELAY_RESULT_DIR: path.join(d, 'res'), RELAY_RENDER_CMD: path.join(d, 'render.sh'),
            RELAY_AK_DIR: path.join(d, 'ak'), RELAY_LOCK: path.join(d, '.lock'), RELAY_ENROLL_LOG: path.join(d, 'enroll.log'),
          },
        });
      }
      await sleep(100);
    }
  };
  loop();
  t.after(() => { stop = true; });
}

async function startPortal(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-sup-'));
  const port = await freePort();
  let log = '';
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ALLOW_SELF_REGISTER: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  t.after(() => { proc.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/portal-info')).ok) break; } catch { /* startet noch */ }
    await sleep(50);
  }
  async function call(p, { method = 'GET', body, cookie, headers = {} } = {}) {
    const res = await fetch(url + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* */ }
    return { status: res.status, j, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] || null };
  }
  return { url, dataDir, call, log: () => log };
}

const AID = 'sup-appliance-01';
const pro = { proActive: true, status: 'active', maxKwp: 30, systemKwp: 20, capacityOk: true };

function realPubkey() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-key-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(d, 'k')]);
  const [type, data] = fs.readFileSync(path.join(d, 'k.pub'), 'utf8').split(' ');
  fs.rmSync(d, { recursive: true, force: true });
  return `${type} ${data}`;
}

async function paired(t, env = {}) {
  const p = await startPortal(t, env);
  const cookie = (await p.call('/api/account', { method: 'POST', body: { name: 'Solar Meier', password: 'geheim12345' } })).cookie;
  const pr = await p.call('/api/pairings', { method: 'POST', cookie, body: { applianceId: AID } });
  const claim = await p.call('/api/pair/claim', { method: 'POST', body: { applianceId: AID, code: pr.j.pairing.code, license: pro } });
  assert.equal(claim.status, 200, claim.text);
  const token = claim.j.applianceToken;
  assert.equal((await p.call(`/api/pairings/${AID}/accept`, { method: 'POST', cookie })).status, 200);
  const poll = (body) => p.call('/api/poll', { method: 'POST', headers: { 'x-appliance-token': token }, body: { applianceId: AID, license: pro, ...body } });
  const view = async () => (await p.call(`/api/pairings/${AID}`, { cookie })).j.pairing;
  const supportOpen = (ttlMin = 60) => p.call(`/api/pairings/${AID}/support-open`, { method: 'POST', cookie, body: { ttlMin } });
  return { p, cookie, token, poll, view, supportOpen };
}

const support = (pubkey, over = {}) => ({ allowTunnel: true, pubkey, fingerprint: 'egal', provisioned: false, open: false, mode: 'service', ...over });

test('Geräteschlüssel: nur Prüfwert gespeichert, Datei 0600, falscher Schlüssel abgewiesen', async (t) => {
  const { p, token, poll } = await paired(t);
  const raw = fs.readFileSync(path.join(p.dataDir, 'pairings.json'), 'utf8');
  assert.ok(!raw.includes(token), 'Klartext-Schlüssel darf nicht in pairings.json stehen');
  assert.ok(raw.includes(crypto.createHash('sha256').update(token).digest('hex')));
  assert.equal(fs.statSync(path.join(p.dataDir, 'pairings.json')).mode & 0o777, 0o600);
  assert.equal((await poll({})).status, 200);
  const wrong = await p.call('/api/poll', { method: 'POST', headers: { 'x-appliance-token': token.slice(0, -1) + (token.endsWith('0') ? '1' : '0') }, body: { applianceId: AID } });
  assert.equal(wrong.status, 401);
});

test('Alte Kopplung mit Klartext-Schlüssel wird beim nächsten Melden umgestellt', async (t) => {
  const { p, token, poll } = await paired(t);
  const file = path.join(p.dataDir, 'pairings.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete store[AID].applianceTokenHash;
  store[AID].applianceToken = token;           // Stand vor dem 14.10.
  fs.writeFileSync(file, JSON.stringify(store), { mode: 0o644 });
  assert.equal((await poll({})).status, 200);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))[AID];
  assert.equal(after.applianceToken, undefined);
  assert.equal(after.applianceTokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  // Wiederholte Kopplung (Anlagen-Neustart) mit dem bekannten Schlüssel klappt weiter.
  const reclaim = await p.call('/api/pair/claim', { method: 'POST', body: { applianceId: AID, code: '000000', applianceToken: token } });
  assert.equal(reclaim.status, 200, reclaim.text);
  assert.equal(reclaim.j.applianceToken, token);
});

test('Anzeige: Container bzw. Betriebssystem und Version aus dem Poll', async (t) => {
  const { poll, view } = await paired(t);
  await poll({ runtime: { kind: 'container', label: 'Docker-Container', os: 'Alpine Linux v3.21', arch: 'arm64', version: 'v1.0.7+abc1234', extra: 'x'.repeat(500) } });
  let v = await view();
  assert.deepEqual(v.runtime, { kind: 'container', label: 'Docker-Container', os: 'Alpine Linux v3.21', arch: 'arm64', version: 'v1.0.7+abc1234' });
  await poll({ runtime: { kind: 'native', label: 'Debian GNU/Linux 12 (bookworm)', arch: 'x64', version: 'v1.0.7' } });
  v = await view();
  assert.equal(v.runtime.kind, 'native');
  assert.equal(v.runtime.label, 'Debian GNU/Linux 12 (bookworm)');
});

test('Fern-Support: ohne Kundenfreigabe oder Schlüssel kein Öffnen', async (t) => {
  const d = relayDirs();
  const { poll, supportOpen } = await paired(t, { RELAY_REQUEST_DIR: path.join(d, 'req'), RELAY_RESULT_DIR: path.join(d, 'res') });
  assert.equal((await supportOpen()).j.error, 'anlage_meldet_keinen_fernsupport');
  await poll({ support: support(realPubkey(), { allowTunnel: false }) });
  assert.equal((await supportOpen()).j.error, 'kunde_hat_fernsupport_nicht_erlaubt');
  await poll({ support: support(realPubkey(), { capable: false }) });
  assert.equal((await supportOpen()).j.error, 'fernsupport_hier_nicht_moeglich');
  await poll({ support: support('ssh-ed25519 kaputt"; rm -rf /') });
  assert.equal((await supportOpen()).j.error, 'anlage_hat_keinen_relay_schluessel');
  assert.deepEqual(fs.readdirSync(path.join(d, 'req')), [], 'kein Auftrag ans Relay');
});

test('Fern-Support: erstes Öffnen trägt beim Relay ein und schickt Ports, zweites nutzt sie wieder', async (t) => {
  const d = relayDirs();
  startEnrollWatcher(t, d);
  const { p, poll, view, supportOpen } = await paired(t, { RELAY_REQUEST_DIR: path.join(d, 'req'), RELAY_RESULT_DIR: path.join(d, 'res') });
  const pub = realPubkey();
  await poll({ support: support(pub) });
  const r = await supportOpen(45);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.j.relay, { shellPort: 49000, webPort: 49001 });
  const reg = JSON.parse(fs.readFileSync(path.join(d, 'registry.json'), 'utf8'));
  assert.deepEqual(reg.appliances[AID], { shellPort: 49000, webPort: 49001 });
  assert.equal(fs.readFileSync(path.join(d, 'keys', `${AID}.pub`), 'utf8'), `${pub} dvhub-appliance-${AID}\n`);
  // Die Anlage holt „Tunnel öffnen“ mit Ports und Dauer ab.
  const cmds = (await poll({ support: support(pub) })).j.commands;
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].type, 'open_tunnel');
  assert.deepEqual(cmds[0].args, { ttlMin: 45, shellPort: 49000, webPort: 49001 });
  const v = await view();
  assert.equal(v.relay.shellPort, 49000);
  assert.equal(v.support.keyKnown, true);
  assert.equal(JSON.stringify(v).includes(pub.split(' ')[1]), false, 'der Schlüssel selbst steht nicht in der Anzeige');
  // Zweites Öffnen: kein neuer Auftrag, gleiche Ports.
  const before = fs.readFileSync(path.join(d, 'enroll.log'), 'utf8');
  const r2 = await supportOpen(30);
  assert.deepEqual(r2.j.relay, { shellPort: 49000, webPort: 49001 });
  await sleep(300);
  assert.equal(fs.readFileSync(path.join(d, 'enroll.log'), 'utf8'), before);
  // Ungültige Dauer wird begrenzt.
  const cmd2 = (await poll({ support: support(pub) })).j.commands[0];
  assert.equal(cmd2.args.ttlMin, 30);
  assert.ok(p);
});

test('Fern-Support: neuer Schlüssel für eine eingetragene Anlage wird vom Relay abgelehnt', async (t) => {
  const d = relayDirs();
  startEnrollWatcher(t, d);
  const { poll, supportOpen } = await paired(t, { RELAY_REQUEST_DIR: path.join(d, 'req'), RELAY_RESULT_DIR: path.join(d, 'res') });
  await poll({ support: support(realPubkey()) });
  assert.equal((await supportOpen()).status, 200);
  await poll({ support: support(realPubkey()) });   // Box neu installiert → anderer Schlüssel
  const r = await supportOpen();
  assert.equal(r.status, 409);
  assert.equal(r.j.error, 'relay_key_mismatch');
  assert.match(r.j.detail, /eingetragen SHA256:.*gemeldet SHA256:/);
});

test('Fern-Support: ohne eingerichtete Freischaltung klare Meldung, Relay schweigt → Zeitüberschreitung', async (t) => {
  const { poll, supportOpen } = await paired(t);
  await poll({ support: support(realPubkey()) });
  assert.equal((await supportOpen()).j.error, 'relay_freischaltung_nicht_eingerichtet');
  const d = relayDirs();
  const q = await paired(t, { RELAY_REQUEST_DIR: path.join(d, 'req'), RELAY_RESULT_DIR: path.join(d, 'res'), RELAY_ENROLL_WAIT_MS: '600' });
  await q.poll({ support: support(realPubkey()) });
  const r = await q.supportOpen();
  assert.equal(r.status, 504);
  assert.equal(r.j.error, 'relay_antwortet_nicht');
});

test('Rate-Limit hinter dem Proxy zählt je Absender (X-Forwarded-For)', async (t) => {
  const p = await startPortal(t, { TRUST_PROXY: '1' });
  const claim = (ip) => p.call('/api/pair/claim', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: { applianceId: 'nix', code: '123456' } });
  for (let i = 0; i < 20; i++) assert.equal((await claim('198.51.100.7')).status, 404);
  assert.equal((await claim('198.51.100.7')).status, 429);
  assert.equal((await claim('203.0.113.9')).status, 404, 'ein anderer Absender ist nicht mitgesperrt');
});
