// installer-portal/test/pairing-lifecycle.test.js — Kopplung im Alltag
// (Christin 2026-10-15): Karteileichen, Offline-Anzeige, neu koppeln, und die
// Kommandos aus dem Support-Termin (Doppelklicks, Schließen ohne Lizenz).
// Gegen den echten Portal-Prozess (server.js), eigener DATA_DIR je Test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const SERVER = path.join(import.meta.dirname, '..', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

async function startPortal(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-life-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ALLOW_SELF_REGISTER: '1' },
    stdio: 'ignore',
  });
  t.after(() => { proc.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/portal-info')).ok) break; } catch { /* startet noch */ }
    await sleep(50);
  }
  const call = async (p, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const res = await fetch(url + p, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* kein JSON */ }
    return { status: res.status, j, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] || null };
  };
  const pairingsFile = path.join(dataDir, 'pairings.json');
  const edit = (aid, fn) => {
    const all = JSON.parse(fs.readFileSync(pairingsFile, 'utf8'));
    fn(all[aid]);
    fs.writeFileSync(pairingsFile, JSON.stringify(all));
  };
  return { call, edit, pairingsFile };
}

// Konto, Code, Anlage claimt, Installateur gibt frei → { cookie, token }.
async function approvedAppliance(p, aid, { license = { proActive: true, status: 'active' }, name } = {}) {
  const acct = await p.call('/api/account', { method: 'POST', body: { name: `Solar ${aid}`, password: 'geheim12345' } });
  const cookie = acct.cookie;
  const pr = await p.call('/api/pairings', { method: 'POST', cookie, body: { applianceId: aid, name } });
  assert.equal(pr.status, 201, pr.text);
  const claim = await p.call('/api/pair/claim', { method: 'POST', body: { applianceId: aid, code: pr.j.pairing.code, license } });
  assert.equal(claim.status, 200, claim.text);
  const acc = await p.call(`/api/pairings/${aid}/accept`, { method: 'POST', cookie });
  assert.equal(acc.status, 200, acc.text);
  return { cookie, token: claim.j.applianceToken };
}

const pending = (p, aid) => JSON.parse(fs.readFileSync(p.pairingsFile, 'utf8'))[aid].commands.map((c) => c.type);

test('Tunnel schließen geht auch ohne Pro-Lizenz, andere Kommandos nicht', async (t) => {
  const p = await startPortal(t);
  const aid = 'life-nolicense-01';
  const { cookie } = await approvedAppliance(p, aid, { license: { proActive: false, status: 'expired' } });
  const close = await p.call(`/api/pairings/${aid}/command`, { method: 'POST', cookie, body: { type: 'close_tunnel' } });
  assert.equal(close.status, 200, close.text);
  const upd = await p.call(`/api/pairings/${aid}/command`, { method: 'POST', cookie, body: { type: 'updates_check' } });
  assert.equal(upd.status, 409);
  assert.equal(upd.j.error, 'lizenz_erforderlich');
});

test('Doppelklick: gleiches Kommando wird nicht zweimal eingereiht', async (t) => {
  const p = await startPortal(t);
  const aid = 'life-dedupe-01';
  const { cookie } = await approvedAppliance(p, aid);
  const a = await p.call(`/api/pairings/${aid}/command`, { method: 'POST', cookie, body: { type: 'close_tunnel' } });
  const b = await p.call(`/api/pairings/${aid}/command`, { method: 'POST', cookie, body: { type: 'close_tunnel' } });
  assert.equal(b.status, 200);
  assert.equal(b.j.alreadyQueued, true);
  assert.equal(b.j.commandId, a.j.commandId);
  assert.deepEqual(pending(p, aid), ['close_tunnel']);
});

test('Schließen verwirft ein noch nicht abgeholtes Öffnen (und umgekehrt)', async (t) => {
  const p = await startPortal(t);
  const aid = 'life-cancel-01';
  const { cookie } = await approvedAppliance(p, aid);
  await p.call(`/api/pairings/${aid}/command`, { method: 'POST', cookie, body: { type: 'updates_check' } });
  await p.call(`/api/pairings/${aid}/command`, { method: 'POST', cookie, body: { type: 'open_tunnel', args: { ttlMin: 30 } } });
  await p.call(`/api/pairings/${aid}/command`, { method: 'POST', cookie, body: { type: 'close_tunnel' } });
  assert.deepEqual(pending(p, aid), ['updates_check', 'close_tunnel']);
  await p.call(`/api/pairings/${aid}/command`, { method: 'POST', cookie, body: { type: 'open_tunnel', args: { ttlMin: 30 } } });
  assert.deepEqual(pending(p, aid), ['updates_check', 'open_tunnel']);
});

test('Online, offline, verwaist: aus der letzten Meldung der Anlage', async (t) => {
  const p = await startPortal(t);
  const aid = 'life-online-01';
  const { cookie, token } = await approvedAppliance(p, aid);
  const view = async () => (await p.call(`/api/pairings/${aid}`, { cookie })).j.pairing;
  const poll = await p.call('/api/poll', { method: 'POST', headers: { 'x-appliance-token': token }, body: { applianceId: aid } });
  assert.equal(poll.status, 200, poll.text);
  let v = await view();
  assert.equal(v.online, true);
  assert.equal(v.orphaned, false);
  p.edit(aid, (pr) => { pr.lastSeenAt = new Date(Date.now() - 10 * 60_000).toISOString(); });
  v = await view();
  assert.equal(v.online, false, '10 min ohne Meldung = offline');
  assert.equal(v.orphaned, false);
  p.edit(aid, (pr) => { pr.lastSeenAt = new Date(Date.now() - 31 * 86400_000).toISOString(); });
  v = await view();
  assert.equal(v.orphaned, true, '31 Tage ohne Meldung = verwaist');
});

test('Eigene Anlage neu koppeln: nur ausdrücklich, Name und Verlauf bleiben', async (t) => {
  const p = await startPortal(t);
  const aid = 'life-repair-01';
  const { cookie } = await approvedAppliance(p, aid, { name: 'Halle Nord' });
  p.edit(aid, (pr) => { pr.customer = 'Meier'; pr.days = { '2026-10-14': { netEur: 12.5 } }; pr.months = { '2026-10': { asOf: '2026-10-14', dvRevenueEur: 99 } }; });
  const plain = await p.call('/api/pairings', { method: 'POST', cookie, body: { applianceId: aid } });
  assert.equal(plain.status, 409);
  assert.equal(plain.j.error, 'anlage_bereits_gekoppelt');
  const again = await p.call('/api/pairings', { method: 'POST', cookie, body: { applianceId: aid, replace: true } });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.j.pairing.status, 'waiting');
  assert.equal(again.j.pairing.name, 'Halle Nord');
  assert.equal(again.j.pairing.customer, 'Meier');
  assert.equal(again.j.pairing.lastDay.netEur, 12.5);
  assert.equal(again.j.pairing.months['2026-10'].dvRevenueEur, 99);
});

test('Neu koppeln mit replace ersetzt nie die Anlage eines anderen Installateurs', async (t) => {
  const p = await startPortal(t);
  const aid = 'life-foreign-01';
  await approvedAppliance(p, aid);
  const other = await p.call('/api/account', { method: 'POST', body: { name: 'Fremd GmbH', password: 'geheim12345' } });
  const r = await p.call('/api/pairings', { method: 'POST', cookie: other.cookie, body: { applianceId: aid, replace: true } });
  assert.equal(r.status, 409);
  assert.equal(r.j.error, 'anlage_bereits_gekoppelt');
});
