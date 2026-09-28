// installer-portal/test/portal-api.test.js — Portal-HTTP-API gegen den ECHTEN
// Portal-Prozess (server.js): Kontenschutz, Admin-Reservierung, Import,
// TOTP-Härtung, Passkey-Login, Session-Cookies, Races.
//
// Jeder Test startet sein eigenes Portal (eigener DATA_DIR, freier Port,
// eigene Env), damit Konfigurationen wie ADMIN_SETUP_TOKEN isoliert bleiben.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { totp } from '../totp.js';
import { makeAuthenticator } from './fake-auth.js';

const SERVER = path.join(import.meta.dirname, '..', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Startet ein Portal; gibt { url, dataDir, call, stop, log } zurück.
async function startPortal(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-api-'));
  const port = await freePort();
  let log = '';
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env },
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
    const res = await fetch(url + p, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* kein JSON */ }
    const setCookie = res.headers.get('set-cookie') || '';
    return { status: res.status, j, text, setCookie, cookie: setCookie.split(';')[0] || null };
  }
  return { url, port, dataDir, call, log: () => log };
}

const ACCT = { name: 'Solar Meier', password: 'geheim12345' };

// ── 2. Admin-Namen reserviert ────────────────────────────────────────────────

test('Admin-Name ohne ADMIN_SETUP_TOKEN ist nicht registrierbar; normale Namen schon', async (t) => {
  const p = await startPortal(t, { ADMIN_ACCOUNTS: 'chef' });
  const r = await p.call('/api/account', { method: 'POST', body: { name: 'Chef', password: 'geheim12345' } });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.j.error, 'name_reserviert');
  const n = await p.call('/api/account', { method: 'POST', body: ACCT });
  assert.equal(n.status, 201, n.text);
  const me = await p.call('/api/me', { cookie: n.cookie });
  assert.equal(me.j.role, 'installer');
  assert.match(p.log(), /WARNUNG: Admin-Name "chef" ist noch kein Konto/);
});

test('Admin-Name nur mit korrektem ADMIN_SETUP_TOKEN', async (t) => {
  const p = await startPortal(t, { ADMIN_ACCOUNTS: 'chef', ADMIN_SETUP_TOKEN: 'setup-0123456789' });
  const none = await p.call('/api/account', { method: 'POST', body: { name: 'chef', password: 'geheim12345' } });
  assert.equal(none.status, 403);
  const wrong = await p.call('/api/account', { method: 'POST', body: { name: 'chef', password: 'geheim12345', setupToken: 'setup-9999999999' } });
  assert.equal(wrong.status, 403);
  const ok = await p.call('/api/account', { method: 'POST', body: { name: 'chef', password: 'geheim12345', setupToken: 'setup-0123456789' } });
  assert.equal(ok.status, 201, ok.text);
  const me = await p.call('/api/me', { cookie: ok.cookie });
  assert.equal(me.j.role, 'admin');
});

// ── 3. Import auf frischem Portal ────────────────────────────────────────────

const BACKUP = {
  kind: 'dvhub-installer-portal-backup', version: 1,
  accounts: { eindringling: { id: 'deadbeefdeadbeef', name: 'eindringling', passHash: 'x:y' } },
  pairings: {}, appliances: {}, keys: {},
};

test('Import auf frischem Portal nur mit Setup-Token', async (t) => {
  const p = await startPortal(t, { ADMIN_SETUP_TOKEN: 'setup-0123456789' });
  const noTok = await p.call('/api/admin/import', { method: 'POST', body: BACKUP });
  assert.equal(noTok.status, 403, noTok.text);
  assert.equal(noTok.j.error, 'setup_token_noetig');
  assert.equal(fs.existsSync(path.join(p.dataDir, 'accounts.json')), false, 'nichts geschrieben');
  const ok = await p.call('/api/admin/import', { method: 'POST', body: { ...BACKUP, setupToken: 'setup-0123456789' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.j.accounts, 1);
});

test('Import auf frischem Portal ohne gesetztes ADMIN_SETUP_TOKEN: immer 403', async (t) => {
  const p = await startPortal(t, {});
  const r = await p.call('/api/admin/import', { method: 'POST', body: { ...BACKUP, setupToken: '' } });
  assert.equal(r.status, 403);
});

// ── 4. Race: /rename mit langsamem Body darf keinen alten Stand zurückschreiben ─

// POST mit Headern sofort, Body erst nach delayMs — simuliert langsamen Client.
function slowPost(port, p, body, cookie, delayMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, cookie } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    req.flushHeaders();
    setTimeout(() => { req.write(data); req.end(); }, delayMs);
  });
}

test('Race: Löschen während /rename-Body unterwegs ist → Kopplung bleibt gelöscht', async (t) => {
  const p = await startPortal(t);
  const acct = await p.call('/api/account', { method: 'POST', body: ACCT });
  const cookie = acct.cookie;
  const aid = 'race-appliance-01';
  const pr = await p.call('/api/pairings', { method: 'POST', cookie, body: { applianceId: aid } });
  assert.equal(pr.status, 201, pr.text);
  const renaming = slowPost(p.port, `/api/pairings/${aid}/rename`, { name: 'Neu' }, cookie, 400);
  await sleep(100); // Rename-Handler hat den Store schon gelesen und wartet auf den Body
  const del = await p.call(`/api/pairings/${aid}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 200);
  const rn = await renaming;
  assert.equal(rn.status, 404, `Umbenennen einer inzwischen gelöschten Kopplung: ${rn.text}`);
  const after = await p.call(`/api/pairings/${aid}`, { cookie });
  assert.equal(after.status, 404, 'gelöschte Kopplung darf nicht zurückkommen');
});

// ── 6. Passkey-Login verlangt User-Verification ──────────────────────────────

// Passkey über die echte API registrieren; liefert den Authenticator zurück.
async function registerPasskey(p, cookie, { uv = true, credIdBytes = 16 } = {}) {
  const auth = makeAuthenticator('127.0.0.1', { uv, credIdBytes });
  const origin = p.url;
  const b = await p.call('/api/passkey/register-begin', { method: 'POST', cookie, headers: { origin } });
  assert.equal(b.status, 200, b.text);
  const c = auth.create(origin, b.j.challenge);
  const f = await p.call('/api/passkey/register-finish', { method: 'POST', cookie, headers: { origin }, body: {
    label: 'Test', attestationObject: c.response.attestationObject, clientDataJSON: c.response.clientDataJSON,
  } });
  assert.equal(f.status, 201, f.text);
  return auth;
}
async function passkeyLogin(p, name, auth) {
  const origin = p.url;
  const b = await p.call('/api/passkey/login-begin', { method: 'POST', headers: { origin }, body: { name } });
  const a = auth.get(origin, b.j.challenge);
  return p.call('/api/passkey/login-finish', { method: 'POST', headers: { origin }, body: {
    name, id: a.id, authenticatorData: a.response.authenticatorData,
    clientDataJSON: a.response.clientDataJSON, signature: a.response.signature,
  } });
}

test('Passkey-Login: ohne User-Verification abgelehnt, mit UV erfolgreich', async (t) => {
  const p = await startPortal(t);
  const acct = await p.call('/api/account', { method: 'POST', body: ACCT });
  const noUv = await registerPasskey(p, acct.cookie, { uv: false });
  const withUv = await registerPasskey(p, acct.cookie, { uv: true });
  const r1 = await passkeyLogin(p, ACCT.name, noUv);
  assert.equal(r1.status, 401, r1.text);
  assert.match(r1.j.detail || '', /uv_fehlt/);
  const r2 = await passkeyLogin(p, ACCT.name, withUv);
  assert.equal(r2.status, 200, r2.text);
  assert.ok(r2.cookie, 'Session-Cookie gesetzt');
});

// ── 7. TOTP: Replay-Schutz + Sperre pro Konto ────────────────────────────────

async function accountWithTotp(p) {
  const acct = await p.call('/api/account', { method: 'POST', body: ACCT });
  const setup = await p.call('/api/totp/setup', { method: 'POST', cookie: acct.cookie });
  const secret = setup.j.secret;
  const en = await p.call('/api/totp/enable', { method: 'POST', cookie: acct.cookie, body: { code: totp(secret) } });
  assert.equal(en.status, 200, en.text);
  return { secret, cookie: acct.cookie };
}

test('TOTP: jeder Code nur einmal (auch der Aktivierungs-Code)', async (t) => {
  const p = await startPortal(t);
  const { secret } = await accountWithTotp(p);
  const login = (code) => p.call('/api/login', { method: 'POST', body: { ...ACCT, totp: code } });
  const reuseEnable = await login(totp(secret));
  assert.equal(reuseEnable.status, 401, reuseEnable.text);
  assert.equal(reuseEnable.j.error, 'totp_bereits_benutzt');
  const next = totp(secret, Date.now() + 30_000); // nächster Schritt, noch im ±1-Fenster
  const ok = await login(next);
  assert.equal(ok.status, 200, ok.text);
  const replay = await login(next);
  assert.equal(replay.status, 401);
  assert.equal(replay.j.error, 'totp_bereits_benutzt');
});

test('TOTP: nach 5 falschen Codes ist das Konto gesperrt — auch für richtige Codes', async (t) => {
  const p = await startPortal(t);
  const { secret } = await accountWithTotp(p);
  const login = (code) => p.call('/api/login', { method: 'POST', body: { ...ACCT, totp: code } });
  const good = totp(secret, Date.now() + 30_000);
  const wrong = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await login(wrong);
    assert.equal(r.status, 401, `Versuch ${i + 1}: ${r.text}`);
  }
  const locked = await login(good);
  assert.equal(locked.status, 429, locked.text);
  assert.equal(locked.j.error, 'totp_gesperrt');
});

// ── 8. WEBAUTHN_ORIGIN fest konfiguriert → Request-Header zählen nicht ──────

test('WEBAUTHN_ORIGIN: rpId/Origin kommen aus der Konfiguration, nicht aus Headern', async (t) => {
  const p = await startPortal(t, { WEBAUTHN_ORIGIN: 'http://portal.test' });
  assert.doesNotMatch(p.log(), /WEBAUTHN_ORIGIN nicht gesetzt/);
  const acct = await p.call('/api/account', { method: 'POST', body: ACCT });
  const tryRegister = async (origin) => {
    const b = await p.call('/api/passkey/register-begin', { method: 'POST', cookie: acct.cookie, headers: { origin } });
    assert.equal(b.j.rpId, 'portal.test', 'rpId aus WEBAUTHN_ORIGIN, nicht aus Host 127.0.0.1');
    const c = makeAuthenticator('portal.test').create(origin, b.j.challenge);
    return p.call('/api/passkey/register-finish', { method: 'POST', cookie: acct.cookie, headers: { origin }, body: {
      attestationObject: c.response.attestationObject, clientDataJSON: c.response.clientDataJSON,
    } });
  };
  // Fremde Origin — auch wenn der Origin-Header dazu passt — wird abgelehnt.
  const evil = await tryRegister('http://evil.test');
  assert.equal(evil.status, 400, evil.text);
  const good = await tryRegister('http://portal.test');
  assert.equal(good.status, 201, good.text);
});

test('ohne WEBAUTHN_ORIGIN: Warnung beim Start', async (t) => {
  const p = await startPortal(t);
  await sleep(100);
  assert.match(p.log(), /WEBAUTHN_ORIGIN nicht gesetzt/);
});

// ── 9. Import: Schlüssel-Ordnernamen dürfen KEYS_DIR nicht verlassen ────────

test('Import: Schlüssel-Ordner „..“ wird ignoriert, gültige werden geschrieben', async (t) => {
  const p = await startPortal(t, { ADMIN_SETUP_TOKEN: 'setup-0123456789' });
  const pair = { keyPem: '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n', certPem: 'CERT' };
  const r = await p.call('/api/admin/import', { method: 'POST', body: {
    ...BACKUP, setupToken: 'setup-0123456789', keys: { '..': pair, '.': pair, 'acct-ok': pair },
  } });
  assert.equal(r.status, 200, r.text);
  assert.equal(fs.existsSync(path.join(p.dataDir, 'key.pem')), false, 'nichts direkt in DATA_DIR');
  assert.equal(fs.existsSync(path.join(p.dataDir, 'keys', 'acct-ok', 'key.pem')), true);
});

// ── 10. passkey/login-begin verrät nicht, welche Konten existieren ─────────

test('passkey/login-begin: gleiche Antwort für unbekannte Konten und Konten ohne Passkey', async (t) => {
  const p = await startPortal(t);
  await p.call('/api/account', { method: 'POST', body: ACCT });
  const shape = (r) => ({ status: r.status, keys: Object.keys(r.j || {}).sort(), allow: r.j?.allow });
  const unknown = await p.call('/api/passkey/login-begin', { method: 'POST', body: { name: 'gibt-es-nicht' } });
  const noKey = await p.call('/api/passkey/login-begin', { method: 'POST', body: { name: ACCT.name } });
  assert.deepEqual(shape(unknown), shape(noKey));
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.j.allow, []);
  assert.match(unknown.j.challenge, /^[A-Za-z0-9_-]{20,}$/);
});

// ── 11. Session-Cookie: Secure-Flag + Sessions nach Sicherheitsänderung ungültig ─

test('COOKIE_SECURE=1 setzt das Secure-Flag (auch beim Abmelden)', async (t) => {
  const secure = await startPortal(t, { COOKIE_SECURE: '1' });
  const a = await secure.call('/api/account', { method: 'POST', body: ACCT });
  assert.match(a.setCookie, /;\s*Secure/i, a.setCookie);
  const out = await secure.call('/api/logout', { method: 'POST' });
  assert.match(out.setCookie, /;\s*Secure/i);
  const plain = await startPortal(t);
  const b = await plain.call('/api/account', { method: 'POST', body: ACCT });
  assert.doesNotMatch(b.setCookie, /Secure/i, 'ohne COOKIE_SECURE kein Secure (lokales http)');
});

test('2FA aktivieren beendet andere Sessions; die eigene bekommt ein neues Cookie', async (t) => {
  const p = await startPortal(t);
  const a = await p.call('/api/account', { method: 'POST', body: ACCT });
  const other = await p.call('/api/login', { method: 'POST', body: ACCT }); // zweites Gerät
  assert.equal((await p.call('/api/me', { cookie: other.cookie })).status, 200);
  const setup = await p.call('/api/totp/setup', { method: 'POST', cookie: a.cookie });
  const en = await p.call('/api/totp/enable', { method: 'POST', cookie: a.cookie, body: { code: totp(setup.j.secret) } });
  assert.equal(en.status, 200, en.text);
  assert.ok(en.cookie, 'neues Cookie für die aktuelle Session');
  assert.equal((await p.call('/api/me', { cookie: other.cookie })).status, 401, 'anderes Gerät ist raus');
  assert.equal((await p.call('/api/me', { cookie: a.cookie })).status, 401, 'altes Cookie ist ungültig');
  assert.equal((await p.call('/api/me', { cookie: en.cookie })).status, 200, 'neues Cookie funktioniert');
});

test('Passkey löschen beendet andere Sessions', async (t) => {
  const p = await startPortal(t);
  const a = await p.call('/api/account', { method: 'POST', body: ACCT });
  const other = await p.call('/api/login', { method: 'POST', body: ACCT });
  const auth = await registerPasskey(p, a.cookie);
  const del = await p.call(`/api/passkeys/${auth.get(p.url, 'x').id}`, { method: 'DELETE', cookie: a.cookie });
  assert.equal(del.status, 200, del.text);
  assert.equal((await p.call('/api/me', { cookie: other.cookie })).status, 401);
  assert.equal((await p.call('/api/me', { cookie: del.cookie })).status, 200);
});

// ── Codex-Nachprüfung: Konten-Store nach dem Body frisch lesen ──────────────

test('Race: Passkey-Löschung (Gerät B) wird von langsamem Request (Gerät A) nicht zurückgedreht', async (t) => {
  const p = await startPortal(t);
  const a = await p.call('/api/account', { method: 'POST', body: ACCT });
  const auth = await registerPasskey(p, a.cookie);
  const b = await p.call('/api/login', { method: 'POST', body: ACCT });
  const setup = await p.call('/api/totp/setup', { method: 'POST', cookie: a.cookie });
  const slow = slowPost(p.port, '/api/totp/enable', { code: totp(setup.j.secret) }, a.cookie, 400);
  await sleep(100); // A hat Konten schon (alt) gelesen und wartet auf den Body
  const del = await p.call(`/api/passkeys/${auth.get(p.url, 'x').id}`, { method: 'DELETE', cookie: b.cookie });
  assert.equal(del.status, 200, del.text);
  const r = await slow;
  assert.equal(r.status, 401, `Session von A wurde durch die Sicherheitsänderung von B beendet: ${r.text}`);
  const me = await p.call('/api/me', { cookie: del.cookie });
  assert.equal(me.status, 200, 'die neue Session von B bleibt gültig (keine Rücknahme der Session-Version)');
  assert.equal(me.j.passkeys.length, 0, 'gelöschter Passkey kommt nicht zurück');
  assert.equal(me.j.totpEnabled, false);
});

test('TOTP deaktivieren: nach 5 falschen Codes gesperrt (gestohlene Session kann nicht raten)', async (t) => {
  const p = await startPortal(t);
  const acct = await p.call('/api/account', { method: 'POST', body: ACCT });
  const setup = await p.call('/api/totp/setup', { method: 'POST', cookie: acct.cookie });
  const en = await p.call('/api/totp/enable', { method: 'POST', cookie: acct.cookie, body: { code: totp(setup.j.secret) } });
  const cookie = en.cookie;
  const good = totp(setup.j.secret, Date.now() + 30_000);
  const wrong = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await p.call('/api/totp/disable', { method: 'POST', cookie, body: { code: wrong } });
    assert.equal(r.status, 400, `Versuch ${i + 1}: ${r.text}`);
    assert.equal(r.j.error, 'code_falsch');
  }
  const locked = await p.call('/api/totp/disable', { method: 'POST', cookie, body: { code: good } });
  assert.equal(locked.status, 429, locked.text);
  assert.equal(locked.j.error, 'totp_gesperrt');
  assert.equal((await p.call('/api/me', { cookie })).j.totpEnabled, true, '2FA bleibt an');
});

test('Passkey mit langer Credential-ID (600 Byte) lässt sich registrieren UND löschen', async (t) => {
  const p = await startPortal(t);
  const a = await p.call('/api/account', { method: 'POST', body: ACCT });
  const auth = await registerPasskey(p, a.cookie, { credIdBytes: 600 });
  const id = auth.get(p.url, 'x').id;
  assert.ok(id.length > 128);
  const del = await p.call(`/api/passkeys/${id}`, { method: 'DELETE', cookie: a.cookie });
  assert.equal(del.status, 200, del.text);
});
