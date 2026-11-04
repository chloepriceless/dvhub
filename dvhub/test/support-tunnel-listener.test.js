// test/support-tunnel-listener.test.js -- Strix T-0001 (30.10.2026), Teil 2.
// Das Web-Ziel des Support-Tunnels zeigte auf den normalen Port; beim Box-sshd
// kommt die Verbindung von 127.0.0.1 an und bekam den Loopback-Freibrief —
// volle Rechte unabhängig von lanTrust, und der Support konnte den Tunnel
// selbst verlängern. Jetzt endet der Tunnel an einem eigenen Listener
// (127.0.0.1:SUPPORT_WEB_PORT); Anfragen von dort tragen req.dvhubSupportTunnel
// und gelten wie ein Gerät im Heimnetz (folgen also lanTrust), dürfen den
// Tunnel nicht öffnen/verlängern und keine Fernzugangs-Freigaben erteilen, und
// das Audit-Log kennzeichnet sie.
//
// Christin 03./04.11.2026: Der Support-Tunnel ist der Reparaturzugang — er
// darf wieder alles (VPN, Token, Kopplungen, Sicherheitseinstellungen), nur
// Einwilligungen des Kunden (Datenspende, Ortsnetz, Fernzugang) nicht; jede
// schreibende Aktion steht im Fern-Support-Protokoll.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiRoutes, actorContext } from '../routes-api.js';
import { restoreRedacted } from '../config-redaction.js';
import { SUPPORT_WEB_PORT_DEFAULT, supportWebPort } from '../services/support-tunnel.js';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    headersSent: false,
    setHeader() {},
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers || {}); this.headersSent = true; },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function makeReq(method, urlPath, body, { viaSupport = false } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const listeners = {};
  const req = {
    method, url: urlPath,
    headers: { host: '127.0.0.1:8080', 'content-type': 'application/json', 'user-agent': 'Browser/1' },
    socket: { remoteAddress: '127.0.0.1' },
    on(ev, cb) {
      if (ev === 'data' && raw) setTimeout(() => { cb(Buffer.from(raw)); listeners.end?.(); }, 0);
      else if (ev === 'end' && !raw) setTimeout(cb, 0);
      else listeners[ev] = cb;
      return req;
    },
    destroy() {},
  };
  if (viaSupport) req.dvhubSupportTunnel = true;
  return req;
}

function ctxWith(cfg, extra = {}) {
  const logs = [];
  const opened = [];
  const saved = [];
  const recorded = [];
  const ctx = {
    getCfg: () => cfg,
    getRawCfg: () => JSON.parse(JSON.stringify(cfg)),
    saveAndApplyConfig: (next) => { saved.push(next); return { ok: true }; },
    pushLog: (event, details, actor) => logs.push({ event, details, actor }),
    needsSetup: () => false,
    getAppDir: () => '/tmp',
    licenseService: { requirePro: () => true, isProActive: () => true },
    supportTunnel: {
      status: () => ({ open: false, uiToken: 'tok' }),
      consumeUiToken: (t) => t === 'tok',
      open: async (o, actor) => { opened.push(actor); return { ok: true }; },
      close: async () => ({ ok: true }),
      recordAction: (entry) => { recorded.push(entry); return entry; },
    },
    ...extra,
  };
  return { ctx, logs, opened, saved, recorded };
}

test('Port des Support-Listeners: fester Standard, per Umgebung änderbar, Notfall-Skript nimmt denselben', () => {
  assert.equal(SUPPORT_WEB_PORT_DEFAULT, 47822);
  assert.equal(supportWebPort({}), 47822);
  assert.equal(supportWebPort({ DVHUB_SUPPORT_WEB_PORT: '47900' }), 47900);
  assert.equal(supportWebPort({ DVHUB_SUPPORT_WEB_PORT: 'x' }), 47822);
  const sh = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dvhub-support-tunnel.sh'), 'utf8');
  assert.match(sh, /LOCAL_WEB="\$\{LOCAL_WEB:-\$\{DVHUB_SUPPORT_WEB_PORT:-47822\}\}"/);
});

test('lanTrust strict: über den Support-Listener braucht es das Token, vom Box-Loopback nicht', () => {
  const { ctx } = ctxWith({ security: { lanTrust: 'strict' }, apiToken: 'x'.repeat(32) });
  const routes = createApiRoutes(ctx);
  const resBox = mockRes();
  assert.equal(routes.enforceRequestGate(makeReq('GET', '/api/status'), resBox), true);
  const resSup = mockRes();
  assert.equal(routes.enforceRequestGate(makeReq('GET', '/api/status', null, { viaSupport: true }), resSup), false);
  assert.equal(resSup._captured.status, 401);
});

test('lanTrust open: Support-Listener wie ein Gerät im Heimnetz (ohne Token)', () => {
  const { ctx } = ctxWith({ security: { lanTrust: 'open' } });
  const routes = createApiRoutes(ctx);
  assert.equal(routes.enforceRequestGate(makeReq('GET', '/api/status', null, { viaSupport: true }), mockRes()), true);
});

test('Support kann den Tunnel nicht selbst öffnen oder verlängern', async () => {
  const { ctx, opened, logs } = ctxWith({ security: { lanTrust: 'open' } });
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/support/tunnel/open', { ttlMin: 240, uiToken: 'tok' }, { viaSupport: true }), res, new URL('http://x/api/support/tunnel/open'));
  assert.equal(res._captured.status, 403, res._captured.body);
  assert.equal(JSON.parse(res._captured.body).error, 'support_tunnel_self_extend');
  assert.equal(opened.length, 0);
  assert.ok(logs.some((l) => l.event === 'support_tunnel_self_extend_denied'));
  // Vom Kunden (Heimnetz/Box) weiter möglich.
  const res2 = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/support/tunnel/open', { ttlMin: 30, uiToken: 'tok' }), res2, new URL('http://x/api/support/tunnel/open'));
  assert.equal(res2._captured.status, 200, res2._captured.body);
  assert.equal(opened.length, 1);
});

test('Support kann keine Fernzugangs-Freigabe erteilen, Abschalten bleibt erlaubt', async () => {
  const portal = { enabled: () => true, permissions: () => ({ allowTunnel: false, allowUpdates: false }), checkUiToken: () => true, issueUiToken: () => 'p' };
  const { ctx, saved } = ctxWith({ security: { lanTrust: 'open' }, installerPortal: { enabled: true } }, { installerPortal: portal });
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/installer/settings', { allowTunnel: true, uiToken: 'p' }, { viaSupport: true }), res, new URL('http://x/api/installer/settings'));
  assert.equal(res._captured.status, 403, res._captured.body);
  assert.equal(JSON.parse(res._captured.body).error, 'support_tunnel_consent_denied');
  assert.equal(saved.length, 0);
  const res2 = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/installer/settings', { allowTunnel: false }, { viaSupport: true }), res2, new URL('http://x/api/installer/settings'));
  assert.notEqual(res2._captured.status, 403, res2._captured.body);
});

test('Audit: Aktionen über den Support-Listener sind als Support gekennzeichnet', () => {
  assert.match(actorContext(makeReq('GET', '/', null, { viaSupport: true })).actor_ua, /^Support-Tunnel \| Browser\/1$/);
  assert.equal(actorContext(makeReq('GET', '/')).actor_ua, 'Browser/1');
});

// Gegenprüfung 8bbfb19d (P1): ein Gerät im WLAN (lanTrust „Offen“, ohne Token)
// konnte ein selbst versiegeltes Paket mit migrate:true importieren — der
// Geräte-Tausch übernahm dann support.relay, Kopplungen und Dateien
// (support/known_hosts → eigener Hostschlüssel = Mitlesen). Ein Geräte-Tausch
// braucht jetzt das API-Token dieser Box.
test('Geräte-Tausch-Import ohne Token der Box → 401, nichts gespeichert; mit Token an der Sperre vorbei', async () => {
  const { encryptSecrets } = await import('../services/config-secrets-crypto.js');
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' }, support: { relay: { host: 'support.dvhub.de' } } };
  const blob = encryptSecrets({ notifications: {} }, 'pw', { files: { 'data/support/known_hosts': Buffer.from('[evil]:22 ssh-ed25519 AAAA\n').toString('base64') } });
  const body = { config: { httpPort: 8080, support: { relay: { host: 'evil.example.net' } }, _encryptedSecrets: blob }, password: 'pw', migrate: true };
  const { ctx, saved } = ctxWith(box, {
    getDataDir: () => '/nonexistent', getConfigPath: () => '/nonexistent/config.json',
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
  });
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/config/import', body), res, new URL('http://x/api/config/import'));
  assert.equal(res._captured.status, 401, res._captured.body);
  assert.equal(JSON.parse(res._captured.body).error, 'migrate_token_required');
  assert.equal(saved.length, 0);
  // Nur Einstellungen (ohne migrate) bleibt ohne Token möglich — Relay der Box bleibt.
  const res2 = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/config/import', { ...body, config: { ...body.config, _encryptedSecrets: blob }, migrate: false }), res2, new URL('http://x/api/config/import'));
  assert.notEqual(res2._captured.status, 401, res2._captured.body);
  if (saved.length) assert.equal(saved.at(-1).support.relay.host, 'support.dvhub.de');
  // Mit dem Token der Box kommt der Geräte-Tausch an der Sperre vorbei.
  const req3 = makeReq('POST', '/api/config/import', { ...body, config: { ...body.config, _encryptedSecrets: blob } });
  req3.headers.authorization = `Bearer ${'b'.repeat(32)}`;
  const res3 = mockRes();
  await routes.handleRequest(req3, res3, new URL('http://x/api/config/import'));
  assert.notEqual(JSON.parse(res3._captured.body || '{}').error, 'migrate_token_required', res3._captured.body);
});

// Christin 04.11.2026: Portal-Kopplung bestätigen, Handy koppeln/freischalten,
// Voll-Export und Geräte-Tausch darf der Fern-Support wieder (Reparatur) —
// jeweils mit Eintrag im Fern-Support-Protokoll.
test('Support-Tunnel: Kopplungen, Handy-Freigaben, Voll-Export und Geräte-Tausch gehen und stehen im Protokoll', async () => {
  const portal = { enabled: () => true, permissions: () => ({}), checkUiToken: () => true, issueUiToken: () => 'p', confirm: () => ({ confirmed: true }) };
  const confirmed = [];
  const ml = {
    status: () => ({}), reconcile() {}, startPairing: () => { confirmed.push('start'); return { qr: 'x' }; }, approvePairing: () => { confirmed.push('approve'); return { ok: true }; },
    cancelPairing: () => ({ ok: true }), removeDevice: () => ({ ok: true }), updateDevice: () => { confirmed.push('update'); return { ok: true }; },
  };
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' }, installerPortal: { enabled: true } };
  const { ctx, logs, recorded } = ctxWith(box, {
    installerPortal: { ...portal, confirm: () => { confirmed.push('confirm'); return {}; } }, mobileLink: ml,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
    getConfigPath: () => '/nonexistent/config.json', getDataDir: () => '/nonexistent',
  });
  const routes = createApiRoutes(ctx);
  const call = async (p, body) => {
    const res = mockRes();
    const req = makeReq('POST', p, body, { viaSupport: true });
    req.headers.authorization = `Bearer ${'b'.repeat(32)}`;
    await routes.handleRequest(req, res, new URL(`http://x${p}`));
    return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
  };
  for (const [p, body] of [
    ['/api/installer/confirm', { installerId: 'i', pairingCode: '123456', uiToken: 'p' }],
    ['/api/mobile-link/settings', { enabled: true, useRelay: true }],
    ['/api/mobile-link/pair/start', {}],
    ['/api/mobile-link/pair/approve', { perms: ['read', 'control'] }],
    ['/api/mobile-link/devices/update', { id: 'd', perms: ['control'] }],
    ['/api/config/export', { password: 'support-pw-1' }],
  ]) {
    const r = await call(p, body);
    assert.notEqual(r.body.error, 'support_tunnel_consent_denied', `${p}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.status < 400, `${p}: ${r.status} ${JSON.stringify(r.body)}`);
    const entry = logs.findLast((l) => l.event === 'support_tunnel_action');
    assert.equal(entry.details.route, p);
    assert.equal(entry.details.via, 'Fern-Support');
    assert.match(entry.actor.actor_ua, /^Support-Tunnel/);
    assert.equal(recorded.at(-1).route, p);
  }
  assert.deepEqual(confirmed, ['confirm', 'start', 'approve', 'update']);
  // Kopplungen sind für den Kunden hervorgehoben (Liste + Benachrichtigung).
  assert.equal(recorded.find((r) => r.route === '/api/mobile-link/pair/approve').kind, 'kopplung');
  assert.equal(recorded.find((r) => r.route === '/api/config/export').kind, 'sicherheit');
  // Feldnamen ja, Werte nie.
  const exp = logs.find((l) => l.event === 'support_tunnel_action' && l.details.route === '/api/config/export');
  assert.deepEqual(exp.details.keys, ['password']);
  assert.doesNotMatch(JSON.stringify(logs.filter((l) => l.event === 'support_tunnel_action')), /support-pw-1/);
  // Geräte-Tausch: an der Tunnel-Sperre vorbei (die Token-Prüfung des Tauschs gilt weiter).
  const mig = await call('/api/config/import', { config: { httpPort: 8080 }, migrate: true });
  assert.notEqual(mig.body.error, 'support_tunnel_consent_denied', JSON.stringify(mig.body));
});

// Gegenprüfung 6f9c9cca (P2): unter lanTrust „Offen“ mit trustedClientIps
// galt der Tunnel trotzdem als Heimnetz (Loopback-Abkürzung).
test('Support-Tunnel folgt trustedClientIps und lanCidrs', () => {
  for (const security of [{ lanTrust: 'open', trustedClientIps: ['192.168.1.5'] }, { lanTrust: 'open', lanCidrs: ['192.168.1.0/24'] }]) {
    const { ctx } = ctxWith({ security, apiToken: 'x'.repeat(32) });
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    assert.equal(routes.enforceRequestGate(makeReq('GET', '/api/status', null, { viaSupport: true }), res), false, JSON.stringify(security));
    assert.equal(res._captured.status, 401);
    assert.equal(routes.enforceRequestGate(makeReq('GET', '/api/status'), mockRes()), true, 'Box selbst weiter frei');
  }
});

// Gegenprüfung cf372cdc (P1): der Geräte-Tausch lief auch über POST /api/config
// mit migrate:true — ohne die Token-Prüfung.
test('Geräte-Tausch über /api/config ohne Token → 401', async () => {
  const { encryptSecrets } = await import('../services/config-secrets-crypto.js');
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' } };
  const blob = encryptSecrets({ notifications: {} }, 'pw', { files: { 'data/support/known_hosts': Buffer.from('x').toString('base64') }, apiToken: 'c'.repeat(32) });
  const { ctx, saved } = ctxWith(box, {
    getDataDir: () => '/nonexistent', getConfigPath: () => '/nonexistent/config.json',
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
  });
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/config', { config: { httpPort: 8080, _encryptedSecrets: blob }, password: 'pw', migrate: true }), res, new URL('http://x/api/config'));
  assert.equal(res._captured.status, 401, res._captured.body);
  assert.equal(JSON.parse(res._captured.body).error, 'migrate_token_required');
  assert.equal(saved.length, 0);
});

// Gegenprüfung 6f9c9cca (P3): der eigentliche Listener war ungetestet.
test('Support-Listener: nur 127.0.0.1, jede Anfrage als Support-Tunnel markiert', async () => {
  const http = await import('node:http');
  const { startSupportWebListener } = await import('../services/support-web-listener.js');
  const seen = [];
  const server = await new Promise((resolve, reject) => {
    const srv = startSupportWebListener({
      handler: (req, res) => { seen.push(req.dvhubSupportTunnel); res.end('ok'); },
      port: 0, onError: reject, onListening: () => resolve(srv),
    });
  });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, (r) => { r.resume(); r.on('end', resolve); }).on('error', reject));
    assert.deepEqual(seen, [true]);
  } finally { server.close(); }
});

test('Port-Kollision: Support-Port = Web-Port → Tunnel öffnet nicht (kein Rückfall auf den Freibrief)', async () => {
  const fsMod = await import('node:fs');
  const os = await import('node:os');
  const { createSupportTunnel } = await import('../services/support-tunnel.js');
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sup-port-'));
  try {
    fsMod.writeFileSync(path.join(dir, 'appliance-id'), 'box-01\n');
    fsMod.mkdirSync(path.join(dir, 'support'));
    fsMod.writeFileSync(path.join(dir, 'support', 'relay_id_ed25519'), 'K', { mode: 0o600 });
    fsMod.writeFileSync(path.join(dir, 'support', 'relay.json'), JSON.stringify({ shellPort: 49101, webPort: 49102 }));
    const tun = createSupportTunnel({ getDataDir: () => dir, getCfg: () => ({ httpPort: 47822 }), pushLog: () => {} }, {
      inContainer: false, unitMode: () => false, spawn: () => { throw new Error('darf nicht starten'); },
      setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
    });
    const r = await tun.open({ ttlMin: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'support_web_port_conflict');
  } finally { fsMod.rmSync(dir, { recursive: true, force: true }); }
});

// Gegenprüfung fbb2dc4b hatte VPN-Profil, VPN-Start und Token über den Tunnel
// gesperrt; Christin 04.11.2026: wieder erlaubt (Reparatur). Der Support-Login
// (support.*) ist Teil der Einwilligung in den Fernzugang und bleibt.
test('Support-Tunnel: VPN-Profil und -Start, Token rotieren und setzen gehen; Support-Login bleibt wie die Box es hat', async () => {
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' }, support: { localUser: { enabled: false } } };
  const vpnCalls = [];
  const { ctx, saved, logs, recorded } = ctxWith(box, {
    vpnManager: {
      start: async () => { vpnCalls.push('start'); return { ok: true }; },
      uploadConfig: async () => { vpnCalls.push('upload'); return { ok: true }; },
      stop: async () => ({ ok: true }), getStatus: () => ({ status: 'connected', profileName: 'x' }),
    },
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
    getConfigPath: () => '/nonexistent/config.json', getServiceActionsEnabled: () => true,
  });
  const routes = createApiRoutes(ctx);
  const call = async (p, body) => {
    const res = mockRes();
    const req = makeReq('POST', p, body, { viaSupport: true });
    req.headers.authorization = `Bearer ${'b'.repeat(32)}`;
    await routes.handleRequest(req, res, new URL(`http://x${p}`));
    return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
  };
  const st = await call('/api/vpn/start', {});
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.deepEqual(vpnCalls, ['start']);
  assert.equal(recorded.at(-1).kind, 'sicherheit');
  const rot = await call('/api/admin/token/rotate', {});
  assert.equal(rot.status, 200, JSON.stringify(rot.body));
  assert.match(rot.body.token, /^[0-9a-f]{64}$/);
  assert.equal(saved.at(-1).apiToken, rot.body.token);
  const entry = logs.findLast((l) => l.event === 'support_tunnel_action');
  assert.equal(entry.details.route, '/api/admin/token/rotate');
  assert.equal(entry.details.kind, 'token');
  assert.doesNotMatch(JSON.stringify(entry), new RegExp(rot.body.token), 'neues Token nicht im Protokoll');
  assert.equal(recorded.at(-1).kind, 'token');
  // Token über die Konfiguration setzen; der Support-Login bleibt aus.
  const newTok = crypto.randomBytes(30).toString('base64url');
  await call('/api/config', { config: { httpPort: 8080, apiToken: newTok, support: { localUser: { enabled: true } } } });
  const last = saved.at(-1);
  assert.equal(last.apiToken, newTok, 'Token über den Tunnel gesetzt');
  assert.equal(last.support.localUser.enabled, false, 'Support-Login nicht über den Tunnel eingeschaltet');
});

test('Support-Listener entfernt Weiterleitungs-Kopfzeilen (X-Forwarded-For)', async () => {
  const http = await import('node:http');
  const { startSupportWebListener } = await import('../services/support-web-listener.js');
  let headers = null;
  const server = await new Promise((resolve, reject) => {
    const srv = startSupportWebListener({ handler: (req, res) => { headers = req.headers; res.end(); }, port: 0, onError: reject, onListening: () => resolve(srv) });
  });
  try {
    await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/', headers: { 'x-forwarded-for': '192.168.1.5', forwarded: 'for=192.168.1.5', 'x-real-ip': '192.168.1.5', 'x-forwarded-host': 'evil' } }, (r) => { r.resume(); r.on('end', resolve); }).on('error', reject));
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host']) assert.equal(headers[h], undefined, h);
  } finally { server.close(); }
});

// Gegenprüfung Release 1.0.9 (P1): Ein selbst versiegelter `_encryptedSecrets`-
// Block mit `apiToken` und migrate:false kam an der Token-Sperre vorbei — sie
// prüfte vor dem Entschlüsseln, applySecrets() übernahm danach auch apiToken.
function sealRawSecrets(secrets, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 210000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(secrets), 'utf8')), cipher.final()]);
  return { v: 1, alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iter: 210000, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), paths: Object.keys(secrets) };
}

// Seit 04.11.2026 darf der Tunnel das Token setzen — aber wie überall nur
// ausdrücklich (apiToken-Feld) oder per Geräte-Tausch (__apiToken):
// applySecrets() übernimmt nie apiToken, auch nicht nach dem Entschlüsseln.
test('Support-Tunnel: versiegelter Block mit apiToken ohne Geräte-Tausch setzt kein Token (Import und Speichern)', async () => {
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' }, support: { localUser: { enabled: false } } };
  const { ctx, saved } = ctxWith(box, {
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
    getConfigPath: () => '/nonexistent/config.json', getServiceActionsEnabled: () => true,
  });
  const routes = createApiRoutes(ctx);
  const evil = crypto.randomBytes(24).toString('base64url');
  for (const p of ['/api/config/import', '/api/config']) {
    const blob = sealRawSecrets({ apiToken: evil, 'mqtt.password': 'mq' }, 'pw-support-1');
    const res = mockRes();
    const body = { config: { httpPort: 8080, _encryptedSecrets: blob }, password: 'pw-support-1', migrate: false };
    await routes.handleRequest(makeReq('POST', p, body, { viaSupport: true }), res, new URL(`http://x${p}`));
    assert.equal(res._captured.status, 200, `${p}: ${res._captured.body}`);
    const last = saved.at(-1);
    assert.ok(last, `${p}: gespeichert`);
    assert.notEqual(last.apiToken, evil, `${p}: Token nicht aus dem Block übernommen`);
    assert.equal(last.mqtt?.password, 'mq', `${p}: andere Geheimnisse kommen weiter an`);
    // Der Wert, den restoreRedacted einsetzt, ist der der Box.
    assert.equal(restoreRedacted(last, box).apiToken, box.apiToken, `${p}: Token der Box bleibt`);
  }
});

// Echter Fehler, bleibt behoben: ein Import ohne apiToken-Feld löschte das
// Token der Box — über den Tunnel wie aus dem Heimnetz.
test('Import ohne apiToken-Feld löscht das Token nicht (Tunnel und Heimnetz); ausdrücklich leer löscht', async () => {
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' } };
  const { ctx, saved } = ctxWith(box, {
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
    getConfigPath: () => '/nonexistent/config.json',
  });
  const routes = createApiRoutes(ctx);
  for (const viaSupport of [true, false]) {
    for (const p of ['/api/config/import', '/api/config']) {
      const res = mockRes();
      await routes.handleRequest(makeReq('POST', p, { config: { httpPort: 8080 } }, { viaSupport }), res, new URL(`http://x${p}`));
      assert.equal(res._captured.status, 200, res._captured.body);
      assert.equal(restoreRedacted(saved.at(-1), box).apiToken, box.apiToken, `${p} viaSupport=${viaSupport}: Token bleibt`);
    }
  }
  const res = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/config/import', { config: { httpPort: 8080, apiToken: '' } }, { viaSupport: true }), res, new URL('http://x/api/config/import'));
  assert.equal(res._captured.status, 200, res._captured.body);
  assert.equal(saved.at(-1).apiToken, '', 'ausdrücklich leer = löschen');
});

test('applySecrets übernimmt nie apiToken — nur der Geräte-Tausch (__apiToken) setzt es', async () => {
  const { applySecrets } = await import('../services/config-secrets-crypto.js');
  const out = applySecrets({ apiToken: 'b'.repeat(32) }, { apiToken: 'c'.repeat(40), 'mqtt.password': 'mq' });
  assert.equal(out.apiToken, 'b'.repeat(32));
  assert.equal(out.mqtt.password, 'mq');
});

// Christin 04.11.2026: VPN-Neustart, Token-Widerruf, Push-Schlüssel,
// EEBUS-Kopplung und Einrichtungsfenster gehen über den Tunnel wieder; nur
// Einwilligungen (Datenspende, Ortsnetz) erteilt der Kunde. Ausschalten geht.
function reparaturCtx(extraCfg = {}) {
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' }, datenspende: { enabled: false }, ortsnetz: { enabled: false }, ...extraCfg };
  const calls = [];
  const env = ctxWith(box, {
    vpnManager: { restart: async () => { calls.push('vpn_restart'); }, getStatus: () => ({ status: 'connected', profileName: 'kunde' }) },
    datenspende: {
      status: () => ({ linked: true }),
      link: async () => { calls.push('ds_link'); }, linkApiKey: async () => { calls.push('ds_link'); },
      startBackfill: () => { calls.push('ds_backfill'); return {}; }, stopBackfill: () => ({}),
      unlink: () => { calls.push('ds_unlink'); return {}; }, cancelPendingLink() {},
    },
    ortsnetz: { status: () => ({}), tick: async () => ({}) },
    inputPush: { regenerate: () => { calls.push('push_key'); return 'k'.repeat(32); }, hasKey: () => false },
    eebus: {
      setPairing: async (on) => { calls.push(`eebus_pairing_${on}`); return { ok: true }; }, status: () => ({ pairing: false }), reload: async () => {},
      trust: async () => { calls.push('eebus_trust'); return { ok: true }; }, untrust: async () => ({ ok: true }),
    },
    getServiceActionsEnabled: () => false, getServiceName: () => 'dvhub-test-nicht-starten',
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
    getConfigPath: () => '/nonexistent/config.json',
  });
  const routes = createApiRoutes(env.ctx);
  const call = async (method, p, body) => {
    const res = mockRes();
    const req = makeReq(method, p, body, { viaSupport: true });
    req.headers.authorization = `Bearer ${'b'.repeat(32)}`;
    await routes.handleRequest(req, res, new URL(`http://x${p}`));
    return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
  };
  return { ...env, box, calls, call };
}

test('Support-Tunnel: VPN-Neustart geht und steht im Protokoll', async () => {
  const { call, calls, logs, recorded } = reparaturCtx();
  const r = await call('POST', '/api/vpn/restart', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls, ['vpn_restart']);
  const entry = logs.findLast((l) => l.event === 'support_tunnel_action');
  assert.deepEqual({ via: entry.details.via, route: entry.details.route, status: entry.details.status, kind: entry.details.kind },
    { via: 'Fern-Support', route: '/api/vpn/restart', status: 200, kind: 'sicherheit' });
  assert.equal(recorded.at(-1).route, '/api/vpn/restart');
});

test('Support-Tunnel: Token widerrufen, Push-Schlüssel, Einrichtungsfenster gehen und stehen im Protokoll', async () => {
  const { call, calls, logs, recorded, saved } = reparaturCtx();
  const rev = await call('POST', '/api/admin/token/revoke', {});
  assert.notEqual(rev.body.error, 'support_tunnel_consent_denied', JSON.stringify(rev.body));
  assert.equal(saved.at(-1).apiToken, '');
  assert.equal(logs.findLast((l) => l.event === 'support_tunnel_action').details.route, '/api/admin/token/revoke');
  const pk = await call('POST', '/api/input/push-key', {});
  assert.notEqual(pk.body.error, 'support_tunnel_consent_denied', JSON.stringify(pk.body));
  assert.ok(calls.includes('push_key'));
  assert.equal(recorded.at(-1).kind, 'token');
  assert.doesNotMatch(JSON.stringify(logs.filter((l) => l.event === 'support_tunnel_action')), /k{32}/, 'Schlüssel nicht im Protokoll');
});

// Codex-Prüfung release/1.0.9 (P2): ohne Dienst-Aktionen löscht der Widerruf
// das Token und antwortet 503 (kein Neustart). Die Änderung zählt trotzdem —
// Kundenliste und Benachrichtigung hängen an der Änderung, nicht am Status.
test('Support-Tunnel: Token-Widerruf mit 503 (ohne Neustart) steht trotzdem beim Kunden', async () => {
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' } };
  const { ctx, logs, recorded } = ctxWith(box, { getServiceActionsEnabled: () => false });
  ctx.saveAndApplyConfig = (next) => { Object.keys(box).forEach((k) => delete box[k]); Object.assign(box, JSON.parse(JSON.stringify(next))); return { ok: true, changedPaths: ['apiToken'] }; };
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  const req = makeReq('POST', '/api/admin/token/revoke', {}, { viaSupport: true });
  req.headers.authorization = `Bearer ${'b'.repeat(32)}`;
  await routes.handleRequest(req, res, new URL('http://x/api/admin/token/revoke'));
  assert.equal(res._captured.status, 503, res._captured.body);
  assert.equal(box.apiToken, '', 'Token gelöscht');
  const entry = logs.findLast((l) => l.event === 'support_tunnel_action');
  assert.equal(entry.details.status, 503);
  assert.deepEqual(entry.details.changedPaths, ['apiToken']);
  assert.equal(entry.details.kind, 'token');
  assert.equal(recorded.at(-1)?.route, '/api/admin/token/revoke', 'in der Kundenliste');
  assert.equal(recorded.at(-1).kind, 'token');
});

test('Support-Tunnel: Ersteinrichtung abschließen geht, auch wenn das Token zurückkommt', async () => {
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' } };
  const { ctx, saved, logs } = ctxWith(box, { needsSetup: () => true, getDataDir: () => '/nonexistent' });
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/setup/complete', { victronHost: '192.168.1.20' }, { viaSupport: true }), res, new URL('http://x/api/setup/complete'));
  assert.equal(res._captured.status, 200, res._captured.body);
  assert.ok(saved.length > 0);
  const entry = logs.findLast((l) => l.event === 'support_tunnel_action');
  assert.equal(entry.details.route, '/api/setup/complete');
  assert.equal(entry.details.kind, 'token');
  assert.doesNotMatch(JSON.stringify(entry), /b{32}/, 'Token nicht im Protokoll');
});

test('Support-Tunnel: EEBUS-Kopplung (Vertrauen, Kopplungsmodus) geht und steht im Protokoll', async () => {
  const { call, calls, recorded } = reparaturCtx();
  const pair = await call('POST', '/api/eebus/pairing', { on: true });
  assert.equal(pair.status, 200, JSON.stringify(pair.body));
  assert.ok(calls.includes('eebus_pairing_true'));
  assert.equal(recorded.at(-1).kind, 'kopplung');
  const trust = await call('POST', '/api/eebus/trust', { ski: 'a'.repeat(40), role: 'grid' });
  assert.notEqual(trust.body.error, 'support_tunnel_consent_denied', JSON.stringify(trust.body));
  assert.equal(recorded.at(-1).route, '/api/eebus/trust');
});

test('Support-Tunnel: Handy-App freigeben geht und steht im Protokoll', async () => {
  const approved = [];
  const ml = {
    status: () => ({}), reconcile() {}, startPairing: () => ({ qr: 'x' }),
    approvePairing: (o) => { approved.push(o.perms); return { ok: true }; },
    cancelPairing: () => ({ ok: true }), removeDevice: () => ({ ok: true }), updateDevice: () => ({ ok: true }),
  };
  const { ctx, logs, recorded } = ctxWith({ httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' } }, { mobileLink: ml });
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  const req = makeReq('POST', '/api/mobile-link/pair/approve', { perms: ['read', 'control'], approveToken: 'geheim-123' }, { viaSupport: true });
  req.headers.authorization = `Bearer ${'b'.repeat(32)}`;
  await routes.handleRequest(req, res, new URL('http://x/api/mobile-link/pair/approve'));
  assert.equal(res._captured.status, 200, res._captured.body);
  assert.deepEqual(approved, [['read', 'control']]);
  const entry = logs.findLast((l) => l.event === 'support_tunnel_action');
  assert.equal(entry.details.kind, 'kopplung');
  assert.deepEqual(entry.details.keys, ['perms', 'approveToken']);
  assert.doesNotMatch(JSON.stringify(entry), /geheim-123/);
  assert.equal(recorded.at(-1).label, 'Kopplung');
});

test('Support-Tunnel: Datenspende und Ortsnetz NICHT einschalten — Ausschalten geht', async () => {
  const { call, calls, saved } = reparaturCtx();
  for (const [method, p, body] of [
    ['POST', '/api/datenspende/link', { mode: 'apikey', apiKey: 'x', consent: true, uiToken: 'n' }],
    ['POST', '/api/datenspende/settings', { enabled: true }],
    ['POST', '/api/datenspende/settings', { sources: { grid: true } }],
    ['POST', '/api/datenspende/backfill', { action: 'start' }],
    ['POST', '/api/ortsnetz/settings', { enabled: true }],
    ['POST', '/api/ortsnetz/settings', { sendPvForecast: true }],
  ]) {
    const r = await call(method, p, body);
    assert.equal(r.status, 403, `${p} ${JSON.stringify(body)}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'support_tunnel_consent_denied', p);
  }
  assert.deepEqual(calls, []);
  assert.equal(saved.length, 0);
  for (const [method, p, body] of [
    ['POST', '/api/datenspende/settings', { enabled: false }],
    ['POST', '/api/datenspende/backfill', { action: 'stop' }],
    ['POST', '/api/ortsnetz/settings', { enabled: false, sendPvForecast: false }],
  ]) {
    const r = await call(method, p, body);
    assert.notEqual(r.body.error, 'support_tunnel_consent_denied', `${p} ${JSON.stringify(body)}`);
    assert.ok(r.status < 400, `${p}: ${r.status} ${JSON.stringify(r.body)}`);
  }
});

test('Freigabeliste: eine Stelle — ohne Eintrag ist die Einwilligung frei', async () => {
  const policy = await import('../services/support-tunnel-policy.js');
  assert.deepEqual([...policy.SUPPORT_TUNNEL_BLOCKED_CONSENTS], ['datenspende', 'ortsnetz', 'fernzugang']);
  for (const a of ['datenspende_link', 'datenspende_settings', 'datenspende_backfill', 'ortsnetz_settings', 'support_tunnel_open', 'installer_portal_grant']) {
    assert.equal(policy.isSupportTunnelConsentAction(a), true, a);
  }
  for (const a of ['vpn_restart', 'vpn_start', 'token_rotate', 'token_revoke', 'setup_complete', 'eebus_trust', 'mobile_link_pair_approve', 'input_push_key', 'config_migrate']) {
    assert.equal(policy.isSupportTunnelConsentAction(a), false, a);
  }
  assert.deepEqual(policy.supportTunnelKeptConfigRoots().sort(), ['datenspende', 'installerPortal', 'ortsnetz', 'support']);
  assert.equal(policy.isSupportTunnelKeptMigrationFile('data/support/known_hosts'), true);
  assert.equal(policy.isSupportTunnelKeptMigrationFile('data/datenspende.json'), true);
  assert.equal(policy.isSupportTunnelKeptMigrationFile('data/mobile-link.json'), false);
  // Ganzer Block neu (collectChangedPaths meldet nur den Elternpfad) zählt mit.
  assert.equal(policy.supportTunnelActionKind('/api/family/mqtt-config', { changedPaths: ['mqtt'] }), 'sicherheit');
  assert.equal(policy.supportTunnelActionKind('/api/config', { changedPaths: ['apiToken'] }), 'token');
  assert.equal(policy.supportTunnelActionKind('/api/config', { changedPaths: ['optimizer.minSoc'] }), null);
});

test('Support-Tunnel: Sicherheits-, Host-, VPN-, EEBUS- und Broker-Einstellungen in der Konfiguration gehen; Einwilligungen bleiben, wie die Box sie hat', async () => {
  const box = {
    httpPort: 8080, apiToken: 'b'.repeat(32),
    security: { lanTrust: 'open', lanCidrs: [], trustedClientIps: [] },
    vpn: { enabled: false, autoConnect: false },
    eebus: { enabled: true, trusted: [] },
    ortsnetz: { enabled: false },
    support: { localUser: { enabled: false } },
    victron: { mqtt: { broker: 'mqtt://192.168.1.5:1883' } },
  };
  const { ctx, saved, logs, recorded } = ctxWith(box, {
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
    getConfigPath: () => '/nonexistent/config.json', getServiceActionsEnabled: () => true,
    saveAndApplyConfig: (next) => { saved.push(next); return { ok: true, changedPaths: ['security.lanTrust', 'vpn.autoConnect'] }; },
  });
  const routes = createApiRoutes(ctx);
  const wide = {
    httpPort: 8080,
    security: { lanTrust: 'strict', lanCidrs: ['192.168.1.0/24'], trustedClientIps: [] },
    vpn: { enabled: true, autoConnect: true },
    allowedHosts: ['dvhub.local'], corsAllowedOrigins: ['https://ha.example.net'],
    trustProxy: true, trustedProxyIps: ['192.168.1.2'],
    eebus: { enabled: true, trusted: [{ ski: 'a'.repeat(40), role: 'grid' }] },
    ortsnetz: { enabled: true },
    support: { localUser: { enabled: true } },
    mqtt: { brokerUrl: 'mqtts://broker.example.net', haDiscovery: { enabled: true } },
    victron: { transport: 'mqtt', mqtt: { schema: 'dvhub', broker: 'mqtts://broker.example.net' } },
  };
  for (const p of ['/api/config', '/api/config/import']) {
    const res = mockRes();
    await routes.handleRequest(makeReq('POST', p, { config: JSON.parse(JSON.stringify(wide)) }, { viaSupport: true }), res, new URL(`http://x${p}`));
    assert.equal(res._captured.status, 200, `${p}: ${res._captured.body}`);
    const last = saved.at(-1);
    assert.equal(last.security.lanTrust, 'strict', `${p}: lanTrust geändert`);
    assert.deepEqual(last.security.lanCidrs, ['192.168.1.0/24'], `${p}: lanCidrs`);
    assert.equal(last.vpn.autoConnect, true, `${p}: vpn`);
    assert.deepEqual(last.eebus.trusted, wide.eebus.trusted, `${p}: eebus.trusted`);
    assert.equal(last.mqtt.brokerUrl, 'mqtts://broker.example.net', `${p}: mqtt.brokerUrl`);
    assert.equal(last.victron.mqtt.broker, 'mqtts://broker.example.net', `${p}: victron.mqtt.broker`);
    for (const k of ['allowedHosts', 'corsAllowedOrigins', 'trustProxy', 'trustedProxyIps']) assert.deepEqual(last[k], wide[k], `${p}: ${k}`);
    assert.deepEqual(last.ortsnetz, box.ortsnetz, `${p}: Ortsnetz-Einwilligung bleibt`);
    assert.equal(last.support.localUser.enabled, false, `${p}: Support-Login bleibt`);
    const entry = logs.findLast((l) => l.event === 'support_tunnel_action');
    assert.equal(entry.details.route, p);
    assert.deepEqual(entry.details.changedPaths, ['security.lanTrust', 'vpn.autoConnect']);
    assert.equal(entry.details.kind, 'sicherheit');
    assert.equal(recorded.at(-1).kind, 'sicherheit');
  }
});

test('Support-Tunnel: lanTrust ändern geht, steht im Protokoll und meldet sich beim Kunden', async () => {
  const fsMod = await import('node:fs');
  const os = await import('node:os');
  const { createSupportTunnel } = await import('../services/support-tunnel.js');
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sup-actions-'));
  const sent = [];
  try {
    const tunCtx = { getDataDir: () => dir, getCfg: () => ({}), pushLog: () => {}, notificationService: { sendDirect: async (m) => { sent.push(m); } } };
    const tun = createSupportTunnel(tunCtx, { inContainer: false, unitMode: () => false, setTimeout: () => ({ unref() {} }), clearTimeout: () => {} });
    const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' } };
    const { ctx, saved, logs } = ctxWith(box, {
      getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
      getConfigPath: () => '/nonexistent/config.json',
      saveAndApplyConfig: (next) => { saved.push(next); return { ok: true, changedPaths: ['security.lanTrust'] }; },
    });
    ctx.supportTunnel = { ...ctx.supportTunnel, recordAction: tun.recordAction };
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(makeReq('POST', '/api/config', { config: { httpPort: 8080, security: { lanTrust: 'restricted' } } }, { viaSupport: true }), res, new URL('http://x/api/config'));
    assert.equal(res._captured.status, 200, res._captured.body);
    assert.equal(saved.at(-1).security.lanTrust, 'restricted');
    const entry = logs.findLast((l) => l.event === 'support_tunnel_action');
    assert.deepEqual(entry.details.changedPaths, ['security.lanTrust']);
    // Kunde: Eintrag in der Liste (überlebt den Neustart) und eine Benachrichtigung.
    const list = tun.status().recentActions;
    assert.equal(list[0].route, '/api/config');
    assert.equal(list[0].kind, 'sicherheit');
    assert.deepEqual(list[0].changedPaths, ['security.lanTrust']);
    const again = createSupportTunnel(tunCtx, { inContainer: false, unitMode: () => false, setTimeout: () => ({ unref() {} }), clearTimeout: () => {} });
    assert.equal(again.recentActions()[0].route, '/api/config', 'aus der Datei nach Neustart');
    assert.equal(sent.length, 1);
    assert.match(sent[0].title, /Fern-Support: Sicherheitseinstellung geändert/);
    assert.match(sent[0].body, /security\.lanTrust/);
    // Viele harmlose Aufrufe drängen die Sicherheitsänderung nicht aus der
    // Liste (Gegenprüfung dca8ac88, P3).
    for (let i = 0; i < 40; i++) tun.recordAction({ method: 'POST', route: '/eosdash/x', status: 200, keys: [] });
    const after = tun.status().recentActions;
    assert.equal(after.filter((x) => x.kind === 'sicherheit').length, 1);
    assert.equal(after.filter((x) => !x.kind).length, 30);
    assert.equal(after[0].route, '/eosdash/x', 'neueste zuerst');
    // Lesende Aufrufe kommen nicht ins Protokoll.
    const before = logs.length;
    await routes.handleRequest(makeReq('GET', '/api/config', null, { viaSupport: true }), mockRes(), new URL('http://x/api/config'));
    assert.equal(logs.slice(before).filter((l) => l.event === 'support_tunnel_action').length, 0);
    // Aus dem Heimnetz: kein Fern-Support-Eintrag.
    await routes.handleRequest(makeReq('POST', '/api/config', { config: { httpPort: 8080 } }), mockRes(), new URL('http://x/api/config'));
    assert.equal(logs.slice(before).filter((l) => l.event === 'support_tunnel_action').length, 0);
  } finally { fsMod.rmSync(dir, { recursive: true, force: true }); }
});

test('Support-Tunnel: Geräte-Tausch bringt keine Einwilligungen mit (Datenspende, Fernzugang)', async () => {
  const { encryptSecrets } = await import('../services/config-secrets-crypto.js');
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' }, datenspende: { enabled: false }, installerPortal: { enabled: false } };
  const blob = encryptSecrets({ notifications: {} }, 'pw', {
    files: {
      'data/support/known_hosts': Buffer.from('x').toString('base64'),
      'data/datenspende.json': Buffer.from('{}').toString('base64'),
    },
  });
  const { ctx, saved, logs } = ctxWith(box, {
    getDataDir: () => '/nonexistent', getConfigPath: () => '/nonexistent/config.json',
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
  });
  const routes = createApiRoutes(ctx);
  const req = makeReq('POST', '/api/config/import', {
    config: { httpPort: 8080, datenspende: { enabled: true }, installerPortal: { enabled: true, allowTunnel: true }, _encryptedSecrets: blob },
    password: 'pw', migrate: true,
  }, { viaSupport: true });
  req.headers.authorization = `Bearer ${'b'.repeat(32)}`;
  const res = mockRes();
  await routes.handleRequest(req, res, new URL('http://x/api/config/import'));
  assert.equal(res._captured.status, 200, res._captured.body);
  assert.deepEqual(saved.at(-1).datenspende, box.datenspende);
  assert.deepEqual(saved.at(-1).installerPortal, box.installerPortal);
  const kept = logs.find((l) => l.event === 'support_tunnel_migration_files_kept');
  assert.deepEqual(kept.details.files.sort(), ['data/datenspende.json', 'data/support/known_hosts']);
  assert.equal(logs.findLast((l) => l.event === 'support_tunnel_action').details.kind, 'sicherheit');
});

test('Support-Tunnel: Portal-Kopplung geht, wenn der Kunde das Portal eingeschaltet hat — Einschalten und Tunnel-Freigabe nicht', async () => {
  const claims = [];
  const mk = (enabled, allowTunnel = false) => {
    const portal = { enabled: () => enabled, permissions: () => ({ allowTunnel }), checkUiToken: () => true, issueUiToken: () => 'p', applianceId: () => 'box' };
    const ipc = { claim: async (o) => { claims.push(o.pairingCode); return { paired: true }; }, status: () => ({ paired: false }) };
    const env = ctxWith({ httpPort: 8080, security: { lanTrust: 'open' }, installerPortal: { enabled } }, { installerPortal: portal, installerPortalClient: ipc });
    return { ...env, routes: createApiRoutes(env.ctx) };
  };
  const call = async (routes, body) => {
    const res = mockRes();
    await routes.handleRequest(makeReq('POST', '/api/installer/client/pair', { portalUrl: 'https://portal.dvhub.de', pairingCode: 'ABC123', uiToken: 'p', ...body }, { viaSupport: true }), res, new URL('http://x/api/installer/client/pair'));
    return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
  };
  const on = mk(true);
  const ok = await call(on.routes, {});
  assert.notEqual(ok.body.error, 'support_tunnel_consent_denied', JSON.stringify(ok.body));
  assert.equal(on.recorded.at(-1)?.kind, 'kopplung');
  const grant = await call(on.routes, { allowTunnel: true });
  assert.equal(grant.body.error, 'support_tunnel_consent_denied');
  const off = mk(false);
  const r = await call(off.routes, {});
  assert.equal(r.body.error, 'support_tunnel_consent_denied');
  assert.equal(off.saved.length, 0);
});

test('Support-Tunnel: Familien-MQTT — anderer Broker geht und steht im Protokoll; unlesbare Adressen weiter abgelehnt', async () => {
  const box = { httpPort: 8080, security: { lanTrust: 'open' }, mqtt: { brokerUrl: 'mqtt://192.168.1.5:1883' } };
  const { ctx, saved, recorded } = ctxWith(box);
  // Wie server.js: gespeichert ist danach der neue Stand.
  ctx.saveAndApplyConfig = (next) => { saved.push(next); Object.assign(box, JSON.parse(JSON.stringify(next))); return { ok: true }; };
  const routes = createApiRoutes(ctx);
  const call = async (body, viaSupport) => {
    const res = mockRes();
    await routes.handleRequest(makeReq('POST', '/api/family/mqtt-config', body, { viaSupport }), res, new URL('http://x/api/family/mqtt-config'));
    return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
  };
  const r = await call({ brokerUrl: 'mqtts://broker.example.net', password: 'mq-geheim' }, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(saved.at(-1).mqtt.brokerUrl, 'mqtts://broker.example.net');
  assert.deepEqual(recorded.at(-1).keys, ['brokerUrl', 'password']);
  // Eigener Speicherweg: der Vergleich vorher/nachher erkennt den Broker als
  // Sicherheitsänderung (Banner + Benachrichtigung; Gegenprüfung dca8ac88, P2).
  assert.ok(recorded.at(-1).changedPaths.includes('mqtt.brokerUrl'), JSON.stringify(recorded.at(-1)));
  assert.equal(recorded.at(-1).kind, 'sicherheit');
  assert.doesNotMatch(JSON.stringify(recorded), /mq-geheim/);
  // Gleichzeitige Änderung von anderer Seite (Kunde, Hintergrund) während einer
  // Tunnel-Anfrage, die selbst nichts speichert: nicht dem Support zugerechnet
  // (Gegenprüfung e17226cf, P3).
  ctx.mobileLink = { cancelPairing: () => { box.security = { lanTrust: 'strict' }; return { ok: true }; } };
  const r2 = mockRes();
  await createApiRoutes(ctx).handleRequest(makeReq('POST', '/api/mobile-link/pair/cancel', {}, { viaSupport: true }), r2, new URL('http://x/api/mobile-link/pair/cancel'));
  assert.equal(r2._captured.status, 200, r2._captured.body);
  assert.equal(recorded.at(-1).route, '/api/mobile-link/pair/cancel');
  assert.equal(recorded.at(-1).changedPaths, undefined, JSON.stringify(recorded.at(-1)));
  assert.notEqual(recorded.at(-1).kind, 'sicherheit');
  box.security = { lanTrust: 'open' };
  // Backslash: WHATWG liest Host 192.168.1.5, url.parse (mqtt.js) evil.example.net (Gegenprüfung ebab0f7e, P2).
  const bs = await call({ brokerUrl: 'mqtt://a:b@evil.example.net\\@192.168.1.5:1883' }, true);
  assert.equal(bs.status, 400, JSON.stringify(bs.body));
  assert.equal(bs.body.error, 'invalid_broker_url');
  assert.equal((await call({ brokerUrl: 'mqtt://x@192.168.1.5:1883 evil' }, false)).status, 400, 'Leerzeichen');
  const bad = await call({ brokerUrl: 'mqtt://a:b@evil.example.net^' }, true);
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(bad.body.error, 'invalid_broker_url');
});
