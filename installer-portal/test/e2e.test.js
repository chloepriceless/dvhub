// installer-portal/test/e2e.test.js — End-to-End des PULL-Modells:
// echtes Portal (Prozess) ↔ echter DVhub-Routen-Code (createApiRoutes)
// ↔ echter Installer-Portal-Client (services/installer-portal-client.js).
//
// Ablauf wie im Feld: Installateur erzeugt Code zur Appliance-ID → Anlage
// claimt ausgehend beim Portal → Installateur gibt frei → die Anlage pollt
// und führt Kommandos (Support-Tunnel) gegen ihre eigenen Routen aus.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApiRoutes } from '../../dvhub/routes-api.js';
import { createInstallerPortal } from '../../dvhub/services/installer-portal.js';
import { createInstallerPortalClient } from '../../dvhub/services/installer-portal-client.js';
import { totp } from '../totp.js';
import { makeAuthenticator } from './fake-auth.js';

const API_TOKEN = 'dvhub-test-token-1234567890';
const APPLIANCE_ID = 'e2e-appliance-0001';
let mockPort = 0;
let portalPort = 0;
let portalProc = null;

// ── Mock-DVhub: echter Routen-Code + echter Client ─────────────────────────
function startMockDvhub() {
  const dvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-e2e-dv-'));
  fs.writeFileSync(path.join(dvDir, 'appliance-id'), APPLIANCE_ID);
  const tunnelLog = [];
  const supportTunnel = {
    liteStatus: () => ({ open: false }),
    open: ({ ttlMin }) => { tunnelLog.push({ op: 'open', ttlMin }); return { ok: true, open: true, ttlMin }; },
    close: () => { tunnelLog.push({ op: 'close' }); return { ok: true, open: false }; },
  };
  const portal = createInstallerPortal({
    getDataDir: () => dvDir,
    getCfg: () => cfg, // eslint-disable-line no-use-before-define
    pushLog: () => {},
  });
  let rawCfg = { apiToken: API_TOKEN, installerPortal: { enabled: false, allowTunnel: true } };
  const cfg = {
    apiToken: API_TOKEN, httpPort: 0, epex: { enabled: false }, telemetry: { enabled: false },
    security: { lanTrust: 'strict' }, allowedHosts: [],
    installerPortal: { enabled: false, allowTunnel: true },
  };
  const ctx = {
    state: { ctrl: {}, telemetry: { ok: true } },
    getCfg: () => cfg,
    getRawCfg: () => rawCfg,
    saveAndApplyConfig: (n) => { rawCfg = n; cfg.installerPortal = { ...(n.installerPortal || {}) }; },
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    licenseService: null,
    getAppVersion: () => ({ version: '1.0.6', versionLabel: 'v1.0.6' }),
    getDataDir: () => dvDir,
    installerPortal: portal,
    supportTunnel,
    expireLeaseIfNeeded: () => {},
    getCachedRuntimeStatusPayload: () => ({
      victron: { soc: 42, batteryPowerW: -250, pvTotalW: 3100, gridSetpointW: 0, minSocPct: 30, alarms: null },
    }),
    buildFallbackStatusPayload: (now) => ({ ts: now, ok: true, victron: {} }),
    buildRuntimeRouteMeta: (now) => ({ ts: now }),
    getLoadedConfig: () => ({ exists: true, valid: true, parseError: null, needsSetup: false, warnings: [] }),
    getConfigPath: () => '/mock/config.json',
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
  };
  const client = createInstallerPortalClient(ctx, { pollIntervalMs: 300 });
  ctx.installerPortalClient = client;
  const routes = createApiRoutes(ctx);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    routes.handleRequest(req, res, url).catch((e) => { res.writeHead(500); res.end(String(e)); });
  });
  return { server, client, dvDir, tunnelLog, setPort: (p) => { cfg.httpPort = p; } };
}

const pv = (p) => `http://127.0.0.1:${portalPort}${p}`;
const dv = (p) => `http://127.0.0.1:${mockPort}${p}`;
async function call(url, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await JSON.parse(await res.text()); } catch { /* */ }
  return { status: res.status, j, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('E2E Pull-Modell: Code → Claim → Freigabe → Poll → Tunnel-Kommando → Trennen', async () => {
  const dvApp = startMockDvhub();
  await new Promise((r) => dvApp.server.listen(0, '127.0.0.1', r));
  mockPort = dvApp.server.address().port;
  dvApp.setPort(mockPort);

  // Portal-Prozess (echt) starten
  const portalData = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-e2e-portal-'));
  portalPort = 18700 + Math.floor(Math.random() * 200);
  portalProc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(portalPort), DATA_DIR: portalData, ADMIN_SETUP_TOKEN: 'e2e-setup-token', ALLOW_SELF_REGISTER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(pv('/')); break; } catch { await sleep(100); }
  }

  // 1) Installateur-Konto
  const acct = await call(pv('/api/account'), {
    method: 'POST', body: { name: 'Solar Meier', password: 'test1234ab' },
  });
  assert.equal(acct.status, 201, JSON.stringify(acct.j));
  // let: nach 2FA-/Passkey-Änderungen stellt das Portal ein neues Cookie aus
  // (alte Sessions werden ungültig) — der Test übernimmt es dann.
  let cookie = acct.cookie;

  // 2) Kopplungs-Code zur Appliance-ID erzeugen — inkl. Installateur-Namensvergabe
  const pair = await call(pv('/api/pairings'), {
    method: 'POST', cookie,
    body: { applianceId: APPLIANCE_ID, name: 'Musterhof Ost', customer: 'Familie Muster', sizeKwp: 12.5 },
  });
  assert.equal(pair.status, 201, JSON.stringify(pair.j));
  assert.match(pair.j.pairing.code, /^\d{6}$/);
  assert.equal(pair.j.pairing.status, 'waiting');
  assert.equal(pair.j.pairing.name, 'Musterhof Ost');
  assert.equal(pair.j.pairing.customer, 'Familie Muster');
  assert.equal(pair.j.pairing.sizeKwp, 12.5);

  // 2b) Umbenennen jederzeit möglich
  const ren = await call(pv(`/api/pairings/${APPLIANCE_ID}/rename`), {
    method: 'POST', cookie, body: { name: 'Musterhof West', customer: '' },
  });
  assert.equal(ren.j.pairing.name, 'Musterhof West');
  assert.equal(ren.j.pairing.customer, null);

  // 3) Anlage trägt Code ein → DVhub-Route → Client claimt AUSGEHEND beim Portal
  const nonce = (await call(dv('/api/installer/settings'))).j.uiToken;
  const claim = await call(dv('/api/installer/client/pair'), {
    method: 'POST', body: { portalUrl: pv(''), pairingCode: pair.j.pairing.code, name: 'Testhof', uiToken: nonce },
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.j));
  assert.equal(claim.j.status, 'requested');

  // 4) Portal zeigt die eingetroffene Anfrage
  const list1 = await call(pv('/api/pairings'), { cookie });
  const pr = list1.j.pairings.find((x) => x.applianceId === APPLIANCE_ID);
  assert.equal(pr.status, 'requested');
  assert.equal(pr.applianceName, 'Testhof');   // von der Anlage gemeldet
  assert.equal(pr.name, 'Musterhof West');      // Installateur-Vergabe hat Vorrang im UI

  // 5) Installateur gibt frei
  const acc = await call(pv(`/api/pairings/${APPLIANCE_ID}/accept`), { method: 'POST', cookie });
  assert.equal(acc.status, 200);
  assert.equal(acc.j.pairing.status, 'approved');

  // 6) Anlage pollt (Poll-Intervall 300 ms) → Live-Status kommt im Portal an
  for (let i = 0; i < 20 && !(await call(pv('/api/pairings'), { cookie })).j.pairings[0].seenAt; i++) await sleep(150);
  const list2 = await call(pv('/api/pairings'), { cookie });
  const live = list2.j.pairings.find((x) => x.applianceId === APPLIANCE_ID);
  assert.ok(live.seenAt, 'Poll kommt an');
  assert.equal(live.lastStatus.soc, 42);
  assert.equal(live.lastStatus.pvTotalW, 3100);

  // 7) Kommando vom Portal → Anlage führt es gegen ihre echten Routen aus
  await call(pv(`/api/pairings/${APPLIANCE_ID}/command`), {
    method: 'POST', cookie, body: { type: 'open_tunnel', args: { ttlMin: 15 } },
  });
  for (let i = 0; i < 25 && !dvApp.tunnelLog.length; i++) await sleep(150);
  assert.deepEqual(dvApp.tunnelLog[0], { op: 'open', ttlMin: 15 }, 'Tunnel über Loopback geöffnet');
  // Ergebnisbericht landet im Portal:
  for (let i = 0; i < 20; i++) {
    const l = await call(pv(`/api/pairings/${APPLIANCE_ID}`), { cookie });
    if (Object.keys(l.j.pairing.results || {}).length) {
      const r = Object.values(l.j.pairing.results)[0];
      assert.equal(r.ok, true);
      break;
    }
    await sleep(150);
  }

  // 8) Status-Endpunkt der Anlage zeigt die aktive Kopplung
  const st = await call(dv('/api/installer/client/status'));
  assert.equal(st.j.paired, true);
  assert.equal(st.j.approved, true);
  assert.equal(st.j.applianceId, APPLIANCE_ID);

  // 9) Admin-Bereich (Hersteller): Übersicht, Umverteilung, Backup
  const admin = await call(pv('/api/account'), {
    // Admin-Namen sind reserviert — nur mit Setup-Token anlegbar.
    method: 'POST', body: { name: 'admin', password: 'adminpass123', setupToken: 'e2e-setup-token' },
  });
  assert.equal(admin.status, 201);
  const adminCookie = admin.cookie;
  const me = await call(pv('/api/me'), { cookie: adminCookie });
  assert.equal(me.j.role, 'admin');
  // Normaler Installateur ist keiner:
  const meInstaller = await call(pv('/api/me'), { cookie });
  assert.equal(meInstaller.j.role, 'installer');
  const denied = await call(pv('/api/admin/overview'), { cookie });
  assert.equal(denied.status, 403);

  const ovw = await call(pv('/api/admin/overview'), { cookie: adminCookie });
  assert.equal(ovw.status, 200);
  const meier = ovw.j.installers.find((x) => x.name === 'Solar Meier');
  assert.equal(meier.counts.total, 1);
  assert.equal(meier.counts.approved, 1);
  assert.equal(meier.totalKwp, 12.5);
  assert.equal(meier.appliances[0].name, 'Musterhof West');

  // Umverteilung zu admin
  const re = await call(pv('/api/admin/reassign'), {
    method: 'POST', cookie: adminCookie, body: { applianceId: APPLIANCE_ID, toAccount: 'admin' },
  });
  assert.equal(re.status, 200, JSON.stringify(re.j));
  const afterMeier = await call(pv('/api/pairings'), { cookie });
  assert.equal(afterMeier.j.pairings.length, 0, 'bei Solar Meier weg');
  const afterAdmin = await call(pv('/api/pairings'), { cookie: adminCookie });
  assert.ok(afterAdmin.j.pairings.find((x) => x.applianceId === APPLIANCE_ID), 'bei admin angekommen');

  // Voll-Export: Konten + Keys + Pairings
  const exp = await call(pv('/api/admin/export'), { cookie: adminCookie });
  assert.equal(exp.status, 200);
  assert.equal(exp.j.kind, 'dvhub-installer-portal-backup');
  assert.ok(exp.j.accounts.admin && exp.j.accounts['solar meier']);
  assert.ok(Object.values(exp.j.keys).some((k) => k.keyPem?.includes('PRIVATE KEY')));
  assert.ok(exp.j.pairings[APPLIANCE_ID]);

  // Import desselben Backups (Überschreiben): alles bleibt konsistent
  const imp = await call(pv('/api/admin/import'), { method: 'POST', cookie: adminCookie, body: exp.j });
  assert.equal(imp.status, 200, JSON.stringify(imp.j));
  const ovw2 = await call(pv('/api/admin/overview'), { cookie: adminCookie });
  assert.equal(ovw2.j.installers.find((x) => x.key === 'admin').appliances.length, 1);
  // Import ohne Login, obwohl Konten existieren → abgelehnt
  const impAnon = await call(pv('/api/admin/import'), { method: 'POST', body: exp.j });
  assert.equal(impAnon.status, 403);

  // 9b) 2FA + Passkeys am Installateur-Konto (Solar Meier, Cookie vorhanden)
  const sec = await call(pv('/api/totp/setup'), { method: 'POST', cookie });
  assert.ok(sec.j.secret, 'TOTP-Setup liefert Secret');
  assert.equal((await call(pv('/api/totp/enable'), { method: 'POST', cookie, body: { code: '000000' } })).j.error, 'code_falsch', 'falscher Code wird abgewiesen');
  const enabled = await call(pv('/api/totp/enable'), { method: 'POST', cookie, body: { code: totp(sec.j.secret) } });
  assert.equal(enabled.status, 200);
  assert.equal((await call(pv('/api/me'), { cookie })).status, 401, 'alte Session ist nach 2FA-Aktivierung ungültig');
  cookie = enabled.cookie;
  assert.equal((await call(pv('/api/me'), { cookie })).j.totpEnabled, true);
  // Login ohne Code → geleitet; falscher Code → abgewiesen; richtiger → Session
  const noTotp = await call(pv('/api/login'), { method: 'POST', body: { name: 'Solar Meier', password: 'test1234ab' } });
  assert.equal(noTotp.j.error, 'totp_ausstaendig');
  assert.equal((await call(pv('/api/login'), { method: 'POST', body: { name: 'Solar Meier', password: 'test1234ab', totp: '111111' } })).j.error, 'totp_falsch');
  // Der Aktivierungs-Code ist verbraucht (Replay-Schutz) — Login mit dem
  // Code des nächsten Zeitschritts (liegt noch im ±1-Fenster).
  assert.equal((await call(pv('/api/login'), { method: 'POST', body: { name: 'Solar Meier', password: 'test1234ab', totp: totp(sec.j.secret, Date.now() + 30_000) } })).status, 200);

  // Passkey registrieren (simulierter Authenticator, rpId = 127.0.0.1)
  const origin = `http://127.0.0.1:${portalPort}`;
  const fakeKey = makeAuthenticator('127.0.0.1');
  const rb = await call(pv('/api/passkey/register-begin'), { method: 'POST', cookie });
  assert.ok(rb.j.challenge && rb.j.rpId === '127.0.0.1');
  const cred = fakeKey.create(origin, rb.j.challenge);
  const rf = await call(pv('/api/passkey/register-finish'), { method: 'POST', cookie, body: {
    label: 'E2E-Sicherheitsschlüssel',
    attestationObject: cred.response.attestationObject,
    clientDataJSON: cred.response.clientDataJSON,
  } });
  assert.equal(rf.status, 201, 'Passkey registriert');
  const mePk = await call(pv('/api/me'), { cookie });
  assert.equal(mePk.j.passkeys.length, 1);
  assert.equal(mePk.j.passkeys[0].label, 'E2E-Sicherheitsschlüssel');
  // Doppelt registrieren (gleiche Credential) → 409
  const rb2 = await call(pv('/api/passkey/register-begin'), { method: 'POST', cookie });
  const cred2 = fakeKey.create(origin, rb2.j.challenge);
  assert.equal((await call(pv('/api/passkey/register-finish'), { method: 'POST', cookie, body: {
    attestationObject: cred2.response.attestationObject, clientDataJSON: cred2.response.clientDataJSON,
  } })).status, 409);

  // Passkey-Login: Logout → ohne Passwort/2FA nur mit Challenge+Signatur
  await call(pv('/api/logout'), { method: 'POST', cookie });
  const lb = await call(pv('/api/passkey/login-begin'), { method: 'POST', body: { name: 'Solar Meier' } });
  assert.ok(lb.j.challenge);
  const assertn = fakeKey.get(origin, lb.j.challenge);
  const lf = await call(pv('/api/passkey/login-finish'), { method: 'POST', body: {
    name: 'Solar Meier', id: assertn.id,
    authenticatorData: assertn.response.authenticatorData,
    clientDataJSON: assertn.response.clientDataJSON,
    signature: assertn.response.signature,
  } });
  assert.equal(lf.status, 200, 'Passkey-Login durchgelassen');
  assert.match(lf.cookie, /portal_session/);
  // Challege ist Einmalgebrauch → Wiederholung scheitert
  assert.equal((await call(pv('/api/passkey/login-finish'), { method: 'POST', body: {
    name: 'Solar Meier', id: assertn.id,
    authenticatorData: assertn.response.authenticatorData,
    clientDataJSON: assertn.response.clientDataJSON,
    signature: assertn.response.signature,
  } })).status, 401, 'Challenge nur einmal verwendbar');

  // 10) Trennen an der Anlage → Kopplung wird auch im Portal freigegeben
  //     (sauberer Release statt nur Sidecar-Löschung — Anlage ist sofort
  //     wieder frei für einen neuen Kopplungscode).
  await call(dv('/api/installer/client/disconnect'), { method: 'POST' });
  assert.equal((await call(dv('/api/installer/client/status'))).j.paired, false);
  for (let i = 0; i < 20 && (await call(pv('/api/pairings'), { cookie: adminCookie })).j.pairings.length; i++) await sleep(150);
  const afterRelease = await call(pv('/api/pairings'), { cookie: adminCookie });
  assert.equal(afterRelease.j.pairings.length, 0, 'Kopplung im Portal freigegeben');
  const orphan = await fetch(pv('/api/poll'), {
    method: 'POST', headers: { 'x-appliance-token': 'gerraten' },
    body: JSON.stringify({ applianceId: APPLIANCE_ID }),
  });
  assert.equal(orphan.status, 401, 'fremder Token wird abgewiesen');

  fs.rmSync(dvApp.dvDir, { recursive: true, force: true });
  fs.rmSync(portalData, { recursive: true, force: true });
  portalProc?.kill();
  dvApp.server.close();
});
