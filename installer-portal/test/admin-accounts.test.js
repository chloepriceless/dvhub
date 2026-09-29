// Konten nur durch den Admin: Selbstregistrierung standardmaessig aus, Admin legt
// Installateure mit Startpasswort an, Pflicht zum Passwortwechsel, Reset, Loeschen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const SERVER = path.join(import.meta.dirname, '..', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function startPortal(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-admin-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ALLOW_SELF_REGISTER: '', ...env }, stdio: 'ignore' });
  t.after(() => { proc.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/portal-info')).ok) break; } catch { /* startet */ } await sleep(50); }
  // einfacher Cookie-Client je Nutzer
  const client = () => {
    let cookie = '';
    return async (p, { method = 'GET', body } = {}) => {
      const r = await fetch(url + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      let j = {}; try { j = await r.json(); } catch { /* leer */ }
      return { status: r.status, j };
    };
  };
  return { url, client };
}

async function withAdmin(t) {
  const p = await startPortal(t, { ADMIN_SETUP_TOKEN: 'setup-0123456789' });
  const admin = p.client();
  const r = await admin('/api/account', { method: 'POST', body: { name: 'admin', password: 'adminpass123', setupToken: 'setup-0123456789' } });
  assert.equal(r.status, 201);
  return { ...p, admin };
}

test('Selbstregistrierung ist standardmaessig aus', async (t) => {
  const { client } = await withAdmin(t);
  const anon = client();
  const info = await anon('/api/portal-info');
  assert.equal(info.j.selfRegister, false);
  const r = await anon('/api/account', { method: 'POST', body: { name: 'Solar Meier', password: 'geheim12345' } });
  assert.equal(r.status, 403);
  assert.equal(r.j.error, 'registrierung_nur_durch_admin');
});

test('Frisches Portal: Registrierung angeboten, damit das Admin-Konto entstehen kann', async (t) => {
  const p = await startPortal(t, { ADMIN_SETUP_TOKEN: 'setup-0123456789' });
  assert.equal((await p.client()('/api/portal-info')).j.selfRegister, true);
});

test('Admin legt Installateur an; Startpasswort muss beim ersten Login geaendert werden', async (t) => {
  const { admin, client } = await withAdmin(t);
  const c = await admin('/api/admin/accounts', { method: 'POST', body: { name: 'Solar Meier', company: 'SM GmbH' } });
  assert.equal(c.status, 201);
  assert.ok(c.j.password.length >= 12, 'Startpasswort erzeugt');
  assert.equal((await admin('/api/admin/accounts', { method: 'POST', body: { name: 'solar meier' } })).status, 409, 'doppelt');
  assert.equal((await admin('/api/admin/accounts', { method: 'POST', body: { name: 'admin' } })).status, 403, 'Admin-Name reserviert');

  const inst = client();
  assert.equal((await inst('/api/login', { method: 'POST', body: { name: 'Solar Meier', password: c.j.password } })).status, 200);
  const me = await inst('/api/me');
  assert.equal(me.j.mustChangePassword, true);
  assert.equal(me.j.role, 'installer');
  const blocked = await inst('/api/pairings');
  assert.equal(blocked.status, 403, 'vor dem Passwortwechsel gesperrt');
  assert.equal(blocked.j.error, 'passwort_aendern');
  assert.equal((await inst('/api/password', { method: 'POST', body: { oldPassword: 'falsch', newPassword: 'neuespasswort1' } })).status, 403);
  assert.equal((await inst('/api/password', { method: 'POST', body: { oldPassword: c.j.password, newPassword: 'kurz' } })).status, 400);
  assert.equal((await inst('/api/password', { method: 'POST', body: { oldPassword: c.j.password, newPassword: 'neuespasswort1' } })).status, 200);
  assert.equal((await inst('/api/me')).j.mustChangePassword, false);
  assert.equal((await inst('/api/pairings')).status, 200, 'danach frei');
  // Installateur ist kein Admin
  assert.equal((await inst('/api/admin/accounts', { method: 'POST', body: { name: 'X' } })).status, 403);
  // Altes Startpasswort gilt nicht mehr
  assert.equal((await client()('/api/login', { method: 'POST', body: { name: 'Solar Meier', password: c.j.password } })).status, 401);
});

test('Reset beendet Sitzungen und erzwingt neuen Wechsel; Loeschen nur ohne Anlagen', async (t) => {
  const { admin, client } = await withAdmin(t);
  const c = await admin('/api/admin/accounts', { method: 'POST', body: { name: 'Meier' } });
  const inst = client();
  await inst('/api/login', { method: 'POST', body: { name: 'Meier', password: c.j.password } });
  await inst('/api/password', { method: 'POST', body: { oldPassword: c.j.password, newPassword: 'neuespasswort1' } });
  await inst('/api/pairings', { method: 'POST', body: { applianceId: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Hof' } });
  const r = await admin('/api/admin/accounts/reset', { method: 'POST', body: { account: 'meier', resetSecurity: true } });
  assert.equal(r.status, 200);
  assert.equal((await inst('/api/me')).status, 401, 'alte Sitzung ungueltig');
  const inst2 = client();
  assert.equal((await inst2('/api/login', { method: 'POST', body: { name: 'Meier', password: r.j.password } })).status, 200);
  assert.equal((await inst2('/api/me')).j.mustChangePassword, true);
  // Loeschen: mit Anlage abgelehnt
  const ov = await admin('/api/admin/overview');
  const owned = ov.j.installers.find((i) => i.key === 'meier').counts.total;
  const del = await admin('/api/admin/accounts/delete', { method: 'POST', body: { account: 'meier' } });
  assert.ok(owned > 0, 'Testanlage ist dem Konto zugeordnet');
  assert.equal(del.status, 409); assert.equal(del.j.error, 'konto_hat_anlagen');
  // Konto ohne Anlagen laesst sich loeschen, Admin nicht
  await admin('/api/admin/accounts', { method: 'POST', body: { name: 'Leer' } });
  assert.equal((await admin('/api/admin/accounts/delete', { method: 'POST', body: { account: 'leer' } })).status, 200);
  assert.equal((await admin('/api/admin/accounts/delete', { method: 'POST', body: { account: 'admin' } })).status, 403);
  assert.equal((await client()('/api/login', { method: 'POST', body: { name: 'Leer', password: 'x' } })).status, 401);
});
