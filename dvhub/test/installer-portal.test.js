// test/installer-portal.test.js — T-INSTALLER-PORTAL
//
// Deckt beide Ebenen ab:
//  1. Service (services/installer-portal.js): Zertifikats-Validierung,
//     Pairing, Challenge/Response inkl. Replay-Schutz, Session-HMAC,
//     Widerruf — mit echter Self-Signed-Ed25519-Kette via node:crypto.
//  2. Routen (routes-api.js /api/installer/*): Gateway-Semantik — WAN ohne
//     Session darf nur register/login, Kunden-Endpunkte brauchen checkAuth,
//     Daten-Endpunkte brauchen X-Installer-Session.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  createInstallerPortal,
  parseInstallerCertificate,
  buildSignaturePayload,
  signSessionToken,
  verifySessionToken,
  INSTALLER_ID_RE,
} from '../services/installer-portal.js';
import { createApiRoutes } from '../routes-api.js';

// ── fixtures: echtes Ed25519-Self-Signed-Zertifikat ─────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-installer-test-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519',
  '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'),
  '-days', '365', '-nodes', '-subj', '/CN=Test Installateur GmbH'],
  { stdio: 'ignore' });
const CERT_PEM = fs.readFileSync(path.join(tmp, 'cert.pem'), 'utf8');
const KEY = crypto.createPrivateKey(fs.readFileSync(path.join(tmp, 'key.pem'), 'utf8'));
const APPLIANCE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-installer-data-'));
  fs.writeFileSync(path.join(dir, 'appliance-id'), APPLIANCE_ID);
  return dir;
}
function serviceFor(dir, cfg = { apiToken: 't'.repeat(20), installerPortal: { enabled: true } }) {
  return createInstallerPortal({
    getDataDir: () => dir,
    getCfg: () => cfg,
    pushLog: () => {},
  });
}
// Portalseite: Challenge korrekt signieren.
function signChallenge({ installerId, challenge, applianceId = APPLIANCE_ID, key = KEY }) {
  return crypto.sign(null, Buffer.from(buildSignaturePayload({ applianceId, installerId, challenge })), key).toString('base64');
}

// ── 1. Service-Ebene ─────────────────────────────────────────────────────────

test('parseInstallerCertificate akzeptiert gültiges PEM und liefert SHA-256-Fingerprint', () => {
  const info = parseInstallerCertificate(CERT_PEM);
  assert.match(info.fingerprint, /^[0-9A-F]{64}$/);
  assert.equal(info.cn, 'Test Installateur GmbH');
  assert.equal(info.keyType, 'ed25519');
  assert.ok(Date.parse(info.notAfter) > Date.now());
  // Vergleich mit openssl: SHA256 über DER
  const ossl = execFileSync('openssl', ['x509', '-in', path.join(tmp, 'cert.pem'), '-fingerprint', '-sha256', '-noout'], {})
    .toString().trim().split('=')[1].replace(/:/g, '');
  assert.equal(info.fingerprint, ossl.toUpperCase());
});

test('parseInstallerCertificate lehnt Müll, abgelaufene und Nicht-PEM ab', () => {
  assert.throws(() => parseInstallerCertificate('kein zertifikat'), /invalid|PEM/);
  assert.throws(() => parseInstallerCertificate(''), /PEM/);
  // absichtlich abgelaufen (2020-01-01…02) — eingecheckte Fixture, weil
  // `openssl req -not_before/-not_after` erst ab OpenSSL 3.4 existiert (CI: 3.0).
  const pem = fs.readFileSync(new URL('./fixtures/installer-cert-expired.pem', import.meta.url), 'utf8');
  assert.throws(() => parseInstallerCertificate(pem), /certificate_expired/);
});

test('Register→Pairing→Login→Session→Widerruf: vollständiger Flow', () => {
  const p = serviceFor(freshDataDir());
  const r = p.register({ name: 'Meier Solar', company: 'MS', certPem: CERT_PEM });
  assert.equal(r.installer.status, 'pending');
  assert.match(r.pairingCode, /^\d{6}$/);
  assert.match(r.installer.id, INSTALLER_ID_RE);

  // Login vor Bestätigung muss scheitern
  assert.throws(() => p.issueChallenge(r.installer.id), /installer_not_active/);

  // Falscher Kopplungs-Code
  assert.throws(() => p.confirm({ installerId: r.installer.id, pairingCode: '999998' }), /pairing_code_invalid/);
  const c = p.confirm({ installerId: r.installer.id, pairingCode: r.pairingCode });
  assert.equal(c.installer.status, 'active');

  const ch = p.issueChallenge(r.installer.id);
  assert.equal(ch.applianceId, APPLIANCE_ID);
  const login = p.verifyLogin({
    installerId: r.installer.id, challenge: ch.challenge,
    signature: signChallenge({ installerId: r.installer.id, challenge: ch.challenge }),
  });
  assert.ok(login.sessionToken.includes('.'));
  const sess = p.verifySession(login.sessionToken);
  assert.equal(sess.installerId, r.installer.id);
});

test('Replay: Challenge ist one-shot — zweite Anmeldung dieselbe Signatur scheitert', () => {
  const p = serviceFor(freshDataDir());
  const r = p.register({ name: 'X', certPem: CERT_PEM });
  p.confirm({ installerId: r.installer.id, pairingCode: r.pairingCode });
  const ch = p.issueChallenge(r.installer.id);
  const sig = signChallenge({ installerId: r.installer.id, challenge: ch.challenge });
  p.verifyLogin({ installerId: r.installer.id, challenge: ch.challenge, signature: sig });
  assert.throws(() => p.verifyLogin({ installerId: r.installer.id, challenge: ch.challenge, signature: sig }), /challenge_unknown/);
});

test('Fremde Anlage: Signatur über anderer applianceId wird abgelehnt', () => {
  const p = serviceFor(freshDataDir());
  const r = p.register({ name: 'X', certPem: CERT_PEM });
  p.confirm({ installerId: r.installer.id, pairingCode: r.pairingCode });
  const ch = p.issueChallenge(r.installer.id);
  const sig = signChallenge({ installerId: r.installer.id, challenge: ch.challenge, applianceId: 'andere-anlage' });
  assert.throws(() => p.verifyLogin({ installerId: r.installer.id, challenge: ch.challenge, signature: sig }), /signature_invalid/);
});

test('Fremder Private Key: Signatur passt nicht zum hinterlegten Zertifikat', () => {
  const p = serviceFor(freshDataDir());
  const r = p.register({ name: 'X', certPem: CERT_PEM });
  p.confirm({ installerId: r.installer.id, pairingCode: r.pairingCode });
  const ch = p.issueChallenge(r.installer.id);
  const otherKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const sig = signChallenge({ installerId: r.installer.id, challenge: ch.challenge, key: otherKey });
  assert.throws(() => p.verifyLogin({ installerId: r.installer.id, challenge: ch.challenge, signature: sig }), /signature_invalid/);
});

test('Widerruf tötet Session sofort (Revocation vor Token-Ablauf)', () => {
  const p = serviceFor(freshDataDir());
  const r = p.register({ name: 'X', certPem: CERT_PEM });
  p.confirm({ installerId: r.installer.id, pairingCode: r.pairingCode });
  const ch = p.issueChallenge(r.installer.id);
  const login = p.verifyLogin({
    installerId: r.installer.id, challenge: ch.challenge,
    signature: signChallenge({ installerId: r.installer.id, challenge: ch.challenge }),
  });
  assert.ok(p.verifySession(login.sessionToken));
  p.revoke({ installerId: r.installer.id });
  assert.equal(p.verifySession(login.sessionToken), null);
});

test('Gleiches Zertifikat nochmal registriert: stays active, kein Duplikat (Erneuerungs-Pfad)', () => {
  const p = serviceFor(freshDataDir());
  const r1 = p.register({ name: 'Alt', certPem: CERT_PEM });
  p.confirm({ installerId: r1.installer.id, pairingCode: r1.pairingCode });
  const r2 = p.register({ name: 'Neu', certPem: CERT_PEM });
  assert.equal(r2.alreadyRegistered, true);
  assert.equal(r2.installer.id, r1.installer.id);
  assert.equal(r2.installer.status, 'active');
  assert.equal(p.list().length, 1);
});

test('Session-HMAC: Fälschung und falscher Schlüssel scheitern', () => {
  const k = crypto.randomBytes(32);
  const tok = signSessionToken({ signingKey: k, installerId: 'abcd1234', fingerprint: 'AB'.repeat(32), ttlMs: 60_000 });
  assert.equal(verifySessionToken({ signingKey: k, token: tok }).installerId, 'abcd1234');
  assert.equal(verifySessionToken({ signingKey: crypto.randomBytes(32), token: tok }), null);
  assert.equal(verifySessionToken({ signingKey: k, token: tok + 'x' }), null);
  assert.equal(verifySessionToken({ signingKey: k, token: tok, now: Date.now() + 120_000 }), null); // abgelaufen
});

test('Store überlebt Neustart (persistiert in DATA_DIR)', () => {
  const dir = freshDataDir();
  const p1 = serviceFor(dir);
  const r = p1.register({ name: 'Persistenz', certPem: CERT_PEM });
  p1.confirm({ installerId: r.installer.id, pairingCode: r.pairingCode });
  const p2 = serviceFor(dir); // „Neustart"
  assert.equal(p2.get(r.installer.id).status, 'active');
});

// ── 2. Routen-Ebene ──────────────────────────────────────────────────────────

const REMOTE_IP = '203.0.113.5';  // TEST-NET-3 — garantiert kein LAN
const LAN_IP = '192.168.4.71';
const API_TOKEN = 'A'.repeat(32);

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload == null ? '' : String(payload); },
    _captured: captured,
  };
}
function makeReq(pathname, { method = 'GET', token = null, body = null, ip = REMOTE_IP, headers = {} } = {}) {
  const bodyBuf = body != null ? Buffer.from(JSON.stringify(body)) : null;
  const stream = Readable.from(bodyBuf ? [bodyBuf] : []);
  stream.method = method;
  stream.url = pathname;
  stream.headers = { host: 'dvhub.test', ...headers };
  if (token) stream.headers.authorization = `Bearer ${token}`;
  if (body != null) stream.headers['content-type'] = 'application/json';
  stream.socket = { remoteAddress: ip };
  return stream;
}
function routes(ipCfg = { enabled: true }, { client = null } = {}) {
  const dir = freshDataDir();
  const portal = createInstallerPortal({
    getDataDir: () => dir,
    // httpPort 1 → Delegation scheitert sichtbar (502)
    getCfg: () => ({ apiToken: API_TOKEN, httpPort: 1, installerPortal: ipCfg }),
    pushLog: () => {},
  });
  const logs = [];
  let savedCfg = null;
  const ctx = {
    state: {},
    getCfg: () => ({
      apiToken: API_TOKEN, httpPort: 1, epex: { enabled: false }, telemetry: { enabled: false },
      security: { lanTrust: 'open' }, allowedHosts: [], installerPortal: ipCfg,
    }),
    getRawCfg: () => ({ apiToken: API_TOKEN, httpPort: 1, installerPortal: ipCfg }),
    saveAndApplyConfig: (next) => { savedCfg = next; },
    pushLog: (e, d, a) => logs.push({ event: e, detail: d, actor: a }),
    telemetrySafeWrite: () => {},
    licenseService: null,
    getAppVersion: () => ({ version: '1.0.6', versionLabel: 'v1.0.6' }),
    installerPortal: portal,
    installerPortalClient: client,
  };
  return { routes: createApiRoutes(ctx), portal, logs, dir, ipCfg, getSavedCfg: () => savedCfg };
}
async function call(routesObj, req, url = req.url) {
  const res = mockRes();
  await routesObj.routes.handleRequest(req, res, new URL(url, 'http://dvhub.test'));
  let parsed = null;
  try { parsed = JSON.parse(res._captured.body); } catch { /* non-JSON */ }
  return { status: res._captured.status, body: parsed, raw: res._captured.body };
}
// Portal-Login bis zur Session durchspielen, gibt { installerId, sessionToken } zurück.
async function loginThrough(r) {
  const reg = await call(r, makeReq('/api/installer/register', { method: 'POST', body: { name: 'Portal GmbH', cert: CERT_PEM } }));
  const inst = r.portal.confirm({ installerId: reg.body.installerId, pairingCode: reg.body.pairingCode });
  const ch = await call(r, makeReq('/api/installer/login/challenge', { method: 'POST', body: { installerId: inst.installer.id } }));
  const lg = await call(r, makeReq('/api/installer/login', {
    method: 'POST',
    body: {
      installerId: inst.installer.id, challenge: ch.body.challenge,
      signature: signChallenge({ installerId: inst.installer.id, challenge: ch.body.challenge }),
    },
  }));
  return { installerId: inst.installer.id, sessionToken: lg.body.sessionToken };
}

test('Route: WAN-Register ohne irgendein Token möglich → pending + pairingCode', async () => {
  const r = routes();
  const res = await call(r, makeReq('/api/installer/register', { method: 'POST', body: { name: 'Portal GmbH', company: 'PG', cert: CERT_PEM } }));
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pending');
  assert.match(res.body.pairingCode, /^\d{6}$/);
});

test('Route: Daten-Endpunkt von WAN ohne Session → 401', async () => {
  const r = routes();
  const res = await call(r, makeReq('/api/installer/status'));
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'installer_session_invalid');
});

test('Route: Kunden-Endpunkte von WAN ohne Bearer → 401, mit Bearer → ok', async () => {
  const r = routes();
  const noTok = await call(r, makeReq('/api/installer/list'));
  assert.equal(noTok.status, 401);
  const withTok = await call(r, makeReq('/api/installer/list', { token: API_TOKEN }));
  assert.equal(withTok.status, 200);
  assert.ok(Array.isArray(withTok.body.installers));
  // LAN ohne Token darf (lanTrust: open)
  const lan = await call(r, makeReq('/api/installer/list', { ip: LAN_IP }));
  assert.equal(lan.status, 200);
});

test('Route: confirm braucht korrekten Code; danach Login → Session → /info', async () => {
  const r = routes();
  const reg = await call(r, makeReq('/api/installer/register', { method: 'POST', body: { name: 'P', cert: CERT_PEM } }));
  const wrong = await call(r, makeReq('/api/installer/confirm', {
    method: 'POST', token: API_TOKEN, body: { installerId: reg.body.installerId, pairingCode: '000000' },
  }));
  // 000000 kann theoretisch der echte Code sein — dann ist der Fall ok statt 403
  assert.ok(wrong.status === 403 || (wrong.status === 200 && reg.body.pairingCode === '000000'));
  const { sessionToken, installerId } = await loginThrough(r);
  assert.ok(sessionToken, 'Login muss Session-Token liefern');
  const info = await call(r, makeReq('/api/installer/info', { headers: { 'x-installer-session': sessionToken } }));
  assert.equal(info.status, 200);
  assert.equal(info.body.applianceId, APPLIANCE_ID);
  assert.equal(info.body.installer.id, installerId);
});

test('Route: Signatur falsch → 401 signature_invalid, keine Session', async () => {
  const r = routes();
  const reg = await call(r, makeReq('/api/installer/register', { method: 'POST', body: { name: 'P', cert: CERT_PEM } }));
  r.portal.confirm({ installerId: reg.body.installerId, pairingCode: reg.body.pairingCode });
  const ch = await call(r, makeReq('/api/installer/login/challenge', { method: 'POST', body: { installerId: reg.body.installerId } }));
  const lg = await call(r, makeReq('/api/installer/login', {
    method: 'POST', body: { installerId: reg.body.installerId, challenge: ch.body.challenge, signature: 'AAAA' },
  }));
  assert.equal(lg.status, 401);
  assert.equal(lg.body.error, 'signature_invalid');
});

test('Route: delegierter Endpunkt ohne Session → 401, ungekannte Route → 404', async () => {
  const r = routes();
  const t = await call(r, makeReq('/api/installer/support-tunnel/status'));
  assert.equal(t.status, 401);
  const { sessionToken } = await loginThrough(r);
  const unknown = await call(r, makeReq('/api/installer/gibt-es-nicht', { headers: { 'x-installer-session': sessionToken } }));
  assert.equal(unknown.status, 404);
});

test('Route: Settings-Endpunkt — GET liefert enabled, POST schaltet und speichert Config', async () => {
  const r = routes();
  const get = await call(r, makeReq('/api/installer/settings', { token: API_TOKEN }));
  assert.equal(get.status, 200);
  assert.equal(get.body.enabled, true); // Default
  const off = await call(r, makeReq('/api/installer/settings', {
    method: 'POST', token: API_TOKEN, body: { enabled: false },
  }));
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.equal(r.getSavedCfg()?.installerPortal?.enabled, false); // landet in der Config
  const bad = await call(r, makeReq('/api/installer/settings', {
    method: 'POST', token: API_TOKEN, body: { enabled: 'ja' },
  }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'enabled_must_be_boolean');
  // WAN ohne Token darf den Schalter nicht umlegen
  const wan = await call(r, makeReq('/api/installer/settings', { method: 'POST', body: { enabled: true } }));
  assert.equal(wan.status, 401);
});

test('Route: list liefert applianceId für die Settings-Kachel', async () => {
  const r = routes();
  const res = await call(r, makeReq('/api/installer/list', { token: API_TOKEN }));
  assert.equal(res.status, 200);
  assert.equal(res.body.applianceId, APPLIANCE_ID);
});

test('Route: deaktiviertes Portal → 503 installer_portal_disabled', async () => {
  const dir = freshDataDir();
  const cfg = { apiToken: API_TOKEN, httpPort: 1, installerPortal: { enabled: false } };
  const portal = createInstallerPortal({ getDataDir: () => dir, getCfg: () => cfg, pushLog: () => {} });
  const ctx = {
    state: {}, pushLog: () => {}, telemetrySafeWrite: () => {}, licenseService: null,
    getCfg: () => ({ ...cfg, epex: { enabled: false }, telemetry: { enabled: false }, security: { lanTrust: 'open' }, allowedHosts: [] }),
    getAppVersion: () => ({}), installerPortal: portal,
  };
  const ro = { routes: createApiRoutes(ctx) };
  const res = await call(ro, makeReq('/api/installer/register', { method: 'POST', body: { name: 'P', cert: CERT_PEM } }));
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'installer_portal_disabled');
});

// ── Review-Fixes 2026-09-27 ──────────────────────────────────────────────────

test('Default: Portal ist Opt-in — ohne enabled=true alles zu', () => {
  const dir = freshDataDir();
  const p = serviceFor(dir, { apiToken: API_TOKEN });
  assert.equal(p.enabled(), false);
  assert.deepEqual(p.permissions(), { allowTunnel: false, allowUpdates: false });
  const r = routes({});
  return call(r, makeReq('/api/installer/register', { method: 'POST', body: { name: 'P', cert: CERT_PEM } }))
    .then((res) => assert.equal(res.status, 503));
});

test('Session-Key: zufällig + persistiert, NICHT aus (fehlendem) apiToken ableitbar', () => {
  const dir = freshDataDir();
  const p1 = serviceFor(dir, { installerPortal: { enabled: true } }); // kein apiToken
  const r = p1.register({ name: 'X', certPem: CERT_PEM });
  p1.confirm({ installerId: r.installer.id, pairingCode: r.pairingCode });
  // Früherer Fallback-Key war öffentlich bekannt → damit gefälschtes Token muss scheitern.
  const legacyKey = crypto.createHash('sha256').update('installer-portal|dvhub-installer-portal').digest();
  const forged = signSessionToken({ signingKey: legacyKey, installerId: r.installer.id, fingerprint: 'AA', ttlMs: 60_000 });
  assert.equal(p1.verifySession(forged), null);
  const secret = fs.readFileSync(path.join(dir, 'installer-portal-secret'), 'utf8');
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal((fs.statSync(path.join(dir, 'installer-portal-secret')).mode & 0o777), 0o600);
  // Neustart: gleicher Key → echtes Token bleibt gültig
  const tok = signSessionToken({ signingKey: p1.signingKey(), installerId: r.installer.id, fingerprint: 'AA', ttlMs: 60_000 });
  assert.ok(serviceFor(dir, { installerPortal: { enabled: true } }).verifySession(tok));
});

test('Offene Anfragen verfallen nach 30 min und sind auf 5 begrenzt', () => {
  const dir = freshDataDir();
  let t = Date.parse('2026-09-27T10:00:00Z');
  const certs = [];
  for (let i = 0; i < 6; i++) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-ip-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519', '-keyout', path.join(d, 'k.pem'),
      '-out', path.join(d, 'c.pem'), '-days', '30', '-nodes', '-subj', `/CN=Spam ${i}`], { stdio: 'ignore' });
    certs.push(fs.readFileSync(path.join(d, 'c.pem'), 'utf8'));
  }
  const p = createInstallerPortal({ getDataDir: () => dir, getCfg: () => ({ installerPortal: { enabled: true } }), pushLog: () => {} }, { now: () => t });
  const first = p.register({ name: 'Spam 0', certPem: certs[0] });
  for (let i = 1; i < 5; i++) p.register({ name: `Spam ${i}`, certPem: certs[i] });
  assert.throws(() => p.register({ name: 'Spam 5', certPem: certs[5] }), /installer_pending_limit/);
  t += 31 * 60_000;
  assert.throws(() => p.confirm({ installerId: first.installer.id, pairingCode: first.pairingCode }), /pairing_code_expired/);
  assert.equal(p.list().length, 0, 'abgelaufene Anfragen sind unsichtbar');
  p.register({ name: 'Spam 5', certPem: certs[5] }); // Plätze wieder frei
  assert.equal(p.list().length, 1);
});

test('Re-Register: aktiver Eintrag lässt sich nicht umbenennen; widerrufener wird wieder pending', () => {
  const dir = freshDataDir();
  const p = serviceFor(dir);
  const r = p.register({ name: 'Echt GmbH', certPem: CERT_PEM });
  p.confirm({ installerId: r.installer.id, pairingCode: r.pairingCode });
  const again = p.register({ name: 'Fake GmbH', certPem: CERT_PEM });
  assert.equal(again.installer.name, 'Echt GmbH');
  assert.equal(again.installer.status, 'active');
  assert.equal(again.pairingCode, null);
  p.revoke({ installerId: r.installer.id });
  const re = p.register({ name: 'Echt GmbH', certPem: CERT_PEM });
  assert.equal(re.installer.status, 'pending');
  assert.match(re.pairingCode, /^\d{6}$/);
  p.confirm({ installerId: r.installer.id, pairingCode: re.pairingCode });
  assert.equal(p.get(r.installer.id).status, 'active');
});

test('Route: Tunnel öffnen / Updates einspielen brauchen eigene Kunden-Freigabe', async () => {
  const r = routes({ enabled: true });
  const { sessionToken } = await loginThrough(r);
  const h = { 'x-installer-session': sessionToken };
  const open = await call(r, makeReq('/api/installer/support-tunnel/open', { method: 'POST', headers: h, body: {} }));
  assert.equal(open.status, 403);
  assert.equal(open.body.error, 'tunnel_not_permitted');
  const upd = await call(r, makeReq('/api/installer/updates/apply', { method: 'POST', headers: h, body: {} }));
  assert.equal(upd.status, 403);
  assert.equal(upd.body.error, 'updates_not_permitted');
  // Schließen + Update-Check bleiben erlaubt (→ Delegation, hier 502 wegen Port 1)
  const close = await call(r, makeReq('/api/installer/support-tunnel/close', { method: 'POST', headers: h, body: {} }));
  assert.equal(close.status, 502);
  r.ipCfg.allowTunnel = true;
  const open2 = await call(r, makeReq('/api/installer/support-tunnel/open', { method: 'POST', headers: h, body: {} }));
  assert.equal(open2.status, 502, 'mit Freigabe wird delegiert');
});

test('Route: list + revoke funktionieren auch bei ausgeschaltetem Portal', async () => {
  const r = routes({ enabled: true });
  const { installerId } = await loginThrough(r);
  r.ipCfg.enabled = false;
  const list = await call(r, makeReq('/api/installer/list', { token: API_TOKEN }));
  assert.equal(list.status, 200);
  assert.equal(list.body.enabled, false);
  assert.equal(list.body.applianceId, APPLIANCE_ID);
  const rev = await call(r, makeReq('/api/installer/revoke', { method: 'POST', token: API_TOKEN, body: { installerId } }));
  assert.equal(rev.status, 200);
  assert.equal(r.portal.get(installerId).status, 'revoked');
  const conf = await call(r, makeReq('/api/installer/confirm', { method: 'POST', token: API_TOKEN, body: { installerId, pairingCode: '123456' } }));
  assert.equal(conf.status, 503);
});

test('Route: Settings patcht allowTunnel/allowUpdates einzeln, Typfehler → 400', async () => {
  const r = routes({ enabled: true });
  const get = await call(r, makeReq('/api/installer/settings', { token: API_TOKEN }));
  assert.equal(get.body.allowTunnel, false);
  assert.equal(get.body.allowUpdates, false);
  const set = await call(r, makeReq('/api/installer/settings', { method: 'POST', token: API_TOKEN, body: { allowTunnel: true } }));
  assert.equal(set.status, 200);
  assert.deepEqual(r.getSavedCfg().installerPortal, { enabled: true, allowTunnel: true });
  const bad = await call(r, makeReq('/api/installer/settings', { method: 'POST', token: API_TOKEN, body: { allowUpdates: 1 } }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'allowUpdates_must_be_boolean');
});

test('Abgelaufenes Zertifikat: kein Login und keine Session mehr nach notAfter', () => {
  const dir = freshDataDir();
  let t = Date.now();
  const p = createInstallerPortal({ getDataDir: () => dir, getCfg: () => ({ installerPortal: { enabled: true } }), pushLog: () => {} }, { now: () => t });
  const r = p.register({ name: 'Ablauf', certPem: CERT_PEM });
  p.confirm({ installerId: r.installer.id, pairingCode: r.pairingCode });
  const ch = p.issueChallenge(r.installer.id);
  const lg = p.verifyLogin({ installerId: r.installer.id, challenge: ch.challenge,
    signature: signChallenge({ installerId: r.installer.id, challenge: ch.challenge }) });
  assert.ok(p.verifySession(lg.sessionToken));
  t = Date.parse(p.get(r.installer.id).notAfter) + 1000; // Zertifikat abgelaufen
  assert.equal(p.verifySession(lg.sessionToken), null, 'laufende Session endet mit dem Zertifikat');
  assert.throws(() => p.issueChallenge(r.installer.id), /certificate_expired/);
});

test('Route: CSRF — koppeln/bestätigen/freigeben ohne Bearer brauchen den UI-Nonce', async () => {
  const r = routes({ enabled: true });
  // LAN ohne Token (lanTrust open) — so käme auch eine fremde Webseite rein
  const noNonce = await call(r, makeReq('/api/installer/settings', { method: 'POST', ip: LAN_IP, body: { allowTunnel: true } }));
  assert.equal(noNonce.status, 403);
  assert.equal(noNonce.body.error, 'ui_token_required');
  // client/pair: im E2E-Test gegen den echten Server abgedeckt (hier kein Client verdrahtet)
  const conf = await call(r, makeReq('/api/installer/confirm', { method: 'POST', ip: LAN_IP, body: { installerId: 'abcdef12', pairingCode: '123456' } }));
  assert.equal(conf.status, 403);
  // Ausschalten (privilegien-reduzierend) geht ohne Nonce
  const off = await call(r, makeReq('/api/installer/settings', { method: 'POST', ip: LAN_IP, body: { allowTunnel: false } }));
  assert.equal(off.status, 200);
  // Mit Nonce aus GET /settings klappt es
  const g = await call(r, makeReq('/api/installer/settings', { ip: LAN_IP }));
  assert.match(g.body.uiToken, /^[a-f0-9]{32}$/);
  const ok = await call(r, makeReq('/api/installer/settings', { method: 'POST', ip: LAN_IP, body: { allowTunnel: true, uiToken: g.body.uiToken } }));
  assert.equal(ok.status, 200);
  const bad = await call(r, makeReq('/api/installer/settings', { method: 'POST', ip: LAN_IP, body: { allowTunnel: true, uiToken: 'f'.repeat(32) } }));
  assert.equal(bad.status, 403);
});

test('Route: Ausschalten verwirft eine laufende Kopplungs-Anfrage (cancelPending)', async () => {
  let cancelled = 0;
  const r = routes({ enabled: true }, { client: { cancelPending: () => { cancelled++; }, status: () => ({ paired: false }) } });
  const on = await call(r, makeReq('/api/installer/settings', { method: 'POST', token: API_TOKEN, body: { allowTunnel: true } }));
  assert.equal(on.status, 200);
  assert.equal(cancelled, 0, 'andere Schalter verwerfen nichts');
  const off = await call(r, makeReq('/api/installer/settings', { method: 'POST', token: API_TOKEN, body: { enabled: false } }));
  assert.equal(off.status, 200);
  assert.equal(cancelled, 1);
});

test('Widerruf + erneutes Koppeln: alte Session bleibt ungültig, neue funktioniert', () => {
  const dir = freshDataDir();
  const p = serviceFor(dir);
  const login = (id) => {
    const ch = p.issueChallenge(id);
    return p.verifyLogin({ installerId: id, challenge: ch.challenge, signature: signChallenge({ installerId: id, challenge: ch.challenge }) }).sessionToken;
  };
  const r = p.register({ name: 'Wiederkehrer', certPem: CERT_PEM });
  p.confirm({ installerId: r.installer.id, pairingCode: r.pairingCode });
  const oldToken = login(r.installer.id);
  assert.ok(p.verifySession(oldToken));
  p.revoke({ installerId: r.installer.id });
  const again = p.register({ name: 'Wiederkehrer', certPem: CERT_PEM }); // gleiche ID
  assert.equal(again.installer.id, r.installer.id);
  p.confirm({ installerId: r.installer.id, pairingCode: again.pairingCode });
  assert.equal(p.verifySession(oldToken), null, 'vor dem Widerruf ausgestellter Token bleibt tot');
  assert.ok(p.verifySession(login(r.installer.id)), 'frischer Login nach erneutem Koppeln geht');
});
