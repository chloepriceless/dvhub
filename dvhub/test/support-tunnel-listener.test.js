// test/support-tunnel-listener.test.js -- Strix T-0001 (30.10.2026), Teil 2.
// Das Web-Ziel des Support-Tunnels zeigte auf den normalen Port; beim Box-sshd
// kommt die Verbindung von 127.0.0.1 an und bekam den Loopback-Freibrief —
// volle Rechte unabhängig von lanTrust, und der Support konnte den Tunnel
// selbst verlängern. Jetzt endet der Tunnel an einem eigenen Listener
// (127.0.0.1:SUPPORT_WEB_PORT); Anfragen von dort tragen req.dvhubSupportTunnel
// und gelten wie ein Gerät im Heimnetz (folgen also lanTrust), dürfen den
// Tunnel nicht öffnen/verlängern und keine Fernzugangs-Freigaben erteilen, und
// das Audit-Log kennzeichnet sie.
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
    },
    ...extra,
  };
  return { ctx, logs, opened, saved };
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

// Gegenprüfung 6f9c9cca (P1, 2× P2): weitere Wege, auf denen der Support über
// den offenen Tunnel sich selbst einen Zugang einrichten konnte — Installateur-
// Kopplung bestätigen, Handy koppeln/freischalten, Voll-Export (Token und
// Schlüssel) und Geräte-Tausch. Alle von dort gesperrt; Verengen bleibt erlaubt.
test('Support-Tunnel: keine Kopplungen, keine Handy-Freigaben, kein Voll-Export, kein Geräte-Tausch', async () => {
  const portal = { enabled: () => true, permissions: () => ({}), checkUiToken: () => true, issueUiToken: () => 'p', confirm: () => ({ confirmed: true }) };
  const confirmed = [];
  const ml = {
    status: () => ({}), reconcile() {}, startPairing: () => ({ qr: 'x' }), approvePairing: () => { confirmed.push('approve'); return { ok: true }; },
    cancelPairing: () => ({ ok: true }), removeDevice: () => ({ ok: true }), updateDevice: () => { confirmed.push('update'); return { ok: true }; },
  };
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' }, installerPortal: { enabled: true } };
  const { ctx, saved } = ctxWith(box, {
    installerPortal: { ...portal, confirm: () => { confirmed.push('confirm'); return {}; } }, mobileLink: ml,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
    getConfigPath: () => '/nonexistent/config.json', getDataDir: () => '/nonexistent',
  });
  const routes = createApiRoutes(ctx);
  const call = async (p, body) => {
    const res = mockRes();
    const req = makeReq('POST', p, body, { viaSupport: true });
    req.headers.authorization = `Bearer ${'b'.repeat(32)}`; // selbst mit Token
    await routes.handleRequest(req, res, new URL(`http://x${p}`));
    return { status: res._captured.status, error: JSON.parse(res._captured.body || '{}').error };
  };
  for (const [p, body] of [
    ['/api/installer/confirm', { installerId: 'i', pairingCode: '123456', uiToken: 'p' }],
    ['/api/mobile-link/settings', { enabled: true, useRelay: true }],
    ['/api/mobile-link/pair/start', {}],
    ['/api/mobile-link/pair/approve', { perms: ['read', 'control'] }],
    ['/api/mobile-link/devices/update', { id: 'd', perms: ['control'] }],
    ['/api/config/export', { password: 'angreifer1' }],
    ['/api/config/import', { config: { httpPort: 8080 }, migrate: true }],
  ]) {
    const r = await call(p, body);
    assert.equal(r.status, 403, `${p}: ${r.status} ${r.error}`);
    assert.equal(r.error, 'support_tunnel_consent_denied', p);
  }
  assert.deepEqual(confirmed, []);
  assert.equal(saved.length, 0);
  // Verengen geht weiter: Handy-Funktion aus, Gerät entfernen, Kopplung abbrechen.
  assert.notEqual((await call('/api/mobile-link/settings', { enabled: false })).status, 403);
  assert.notEqual((await call('/api/mobile-link/devices/remove', { id: 'd' })).status, 403);
  assert.notEqual((await call('/api/mobile-link/pair/cancel', {})).status, 403);
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

// Gegenprüfung fbb2dc4b: (P1) eigenes VPN-Profil hochladen/starten = Zugang über
// das Tunnel-Ende hinaus; (P2) Token rotieren / apiToken setzen; (P2) Support-
// Login wieder einschalten; (P2) X-Forwarded-For über den Tunnel.
test('Support-Tunnel: kein VPN-Profil, kein Token, Support-Login bleibt wie die Box es hat', async () => {
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' }, support: { localUser: { enabled: false } } };
  const vpnCalls = [];
  const { ctx, saved } = ctxWith(box, {
    vpnManager: { start: async () => { vpnCalls.push('start'); return { ok: true }; }, uploadConfig: async () => { vpnCalls.push('upload'); return { ok: true }; }, stop: async () => ({ ok: true }) },
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
    getConfigPath: () => '/nonexistent/config.json', getServiceActionsEnabled: () => true,
  });
  const routes = createApiRoutes(ctx);
  const call = async (p, body) => {
    const res = mockRes();
    await routes.handleRequest(makeReq('POST', p, body, { viaSupport: true }), res, new URL(`http://x${p}`));
    return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
  };
  for (const p of ['/api/vpn/config/upload', '/api/vpn/start', '/api/admin/token/rotate']) {
    const r = await call(p, { type: 'openvpn', name: 'x', content: 'remote evil.example.net 1194' });
    assert.equal(r.status, 403, `${p}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'support_tunnel_consent_denied', p);
  }
  assert.deepEqual(vpnCalls, []);
  await call('/api/config', { config: { httpPort: 8080, apiToken: 'c'.repeat(40), support: { localUser: { enabled: true } } } });
  const last = saved.at(-1);
  if (last) {
    assert.notEqual(last.apiToken, 'c'.repeat(40), 'Token nicht über den Tunnel gesetzt');
    assert.equal(last.support.localUser.enabled, false, 'Support-Login nicht über den Tunnel eingeschaltet');
  }
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

test('Support-Tunnel: versiegelter Block mit apiToken setzt kein Token (Import und Speichern)', async () => {
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
    assert.notEqual(last.apiToken, evil, `${p}: Token nicht über den Tunnel gesetzt`);
    assert.equal(last.mqtt?.password, 'mq', `${p}: andere Geheimnisse kommen weiter an`);
    // Der Wert, den restoreRedacted einsetzt, ist der der Box.
    assert.equal(restoreRedacted(last, box).apiToken, box.apiToken, `${p}: Token der Box bleibt`);
  }
  // Ohne apiToken im Paket darf der Tunnel das Token auch nicht löschen.
  const res = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/config/import', { config: { httpPort: 8080 } }, { viaSupport: true }), res, new URL('http://x/api/config/import'));
  assert.equal(res._captured.status, 200, res._captured.body);
  assert.equal(restoreRedacted(saved.at(-1), box).apiToken, box.apiToken, 'Token nicht über den Tunnel gelöscht');
});

test('applySecrets übernimmt nie apiToken — nur der Geräte-Tausch (__apiToken) setzt es', async () => {
  const { applySecrets } = await import('../services/config-secrets-crypto.js');
  const out = applySecrets({ apiToken: 'b'.repeat(32) }, { apiToken: 'c'.repeat(40), 'mqtt.password': 'mq' });
  assert.equal(out.apiToken, 'b'.repeat(32));
  assert.equal(out.mqtt.password, 'mq');
});

// Gesamtprüfung release/1.0.9 (Hauptbefunde 4, 5, 6 und die systematische
// Durchsicht aller schreibenden Wege): Über den Fern-Support lassen sich keine
// Freigaben erteilen — kein VPN (auch nicht per Neustart), kein Token setzen,
// löschen oder abholen (Einrichtungsfenster, Push-Schlüssel), keine
// Einwilligung (Datenspende, Ortsnetz), keine EEBUS-Kopplung, keine Zugänge
// über die Konfiguration. Zurücknehmen bleibt erlaubt.
test('Support-Tunnel: kein VPN-Neustart, kein Token-Widerruf, keine Einwilligung, kein Push-Schlüssel, keine EEBUS-Kopplung', async () => {
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' }, datenspende: { enabled: false }, ortsnetz: { enabled: false } };
  const calls = [];
  const { ctx, saved } = ctxWith(box, {
    vpnManager: { restart: async () => { calls.push('vpn_restart'); }, getStatus: () => ({ status: 'connected' }) },
    datenspende: {
      status: () => ({ linked: true }),
      link: async () => { calls.push('ds_link'); }, linkApiKey: async () => { calls.push('ds_link'); },
      startBackfill: () => { calls.push('ds_backfill'); return {}; }, stopBackfill: () => ({}),
      unlink: () => { calls.push('ds_unlink'); return {}; }, cancelPendingLink() {},
    },
    ortsnetz: { status: () => ({}), tick: async () => ({}) },
    inputPush: { regenerate: () => { calls.push('push_key'); return 'k'.repeat(32); }, hasKey: () => false },
    eebus: { setPairing: async (on) => { calls.push(`eebus_pairing_${on}`); return { ok: true }; }, status: () => ({ pairing: false }), reload: async () => {} },
    getServiceActionsEnabled: () => true, getServiceName: () => 'dvhub-test-nicht-starten',
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
    getConfigPath: () => '/nonexistent/config.json',
  });
  const routes = createApiRoutes(ctx);
  const call = async (method, p, body) => {
    const res = mockRes();
    const req = makeReq(method, p, body, { viaSupport: true });
    req.headers.authorization = `Bearer ${'b'.repeat(32)}`; // selbst mit Token
    await routes.handleRequest(req, res, new URL(`http://x${p}`));
    return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
  };
  for (const [method, p, body] of [
    ['POST', '/api/vpn/restart', {}],
    ['POST', '/api/admin/token/revoke', {}],
    ['POST', '/api/datenspende/link', { mode: 'apikey', apiKey: 'x', consent: true, uiToken: 'n' }],
    ['POST', '/api/datenspende/settings', { enabled: true }],
    ['POST', '/api/datenspende/settings', { sources: { grid: true } }],
    ['POST', '/api/datenspende/backfill', { action: 'start' }],
    ['POST', '/api/ortsnetz/settings', { enabled: true }],
    ['POST', '/api/ortsnetz/settings', { sendPvForecast: true }],
    ['POST', '/api/input/push-key', {}],
    ['POST', '/api/eebus/trust', { ski: 'a'.repeat(40), role: 'grid' }],
    ['POST', '/api/eebus/pairing', { on: true }],
  ]) {
    const r = await call(method, p, body);
    assert.equal(r.status, 403, `${p} ${JSON.stringify(body)}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'support_tunnel_consent_denied', p);
    assert.equal(r.body.key, undefined, `${p}: kein Schlüssel in der Antwort`);
  }
  assert.deepEqual(calls, []);
  assert.equal(saved.length, 0);
  // Zurücknehmen bleibt erlaubt.
  for (const [method, p, body] of [
    ['POST', '/api/datenspende/settings', { enabled: false }],
    ['POST', '/api/datenspende/backfill', { action: 'stop' }],
    ['POST', '/api/ortsnetz/settings', { enabled: false, sendPvForecast: false }],
    ['DELETE', `/api/eebus/trust?ski=${'a'.repeat(40)}`, null],
    ['POST', '/api/eebus/pairing', { on: false }],
  ]) {
    const r = await call(method, p, body);
    assert.notEqual(r.body.error, 'support_tunnel_consent_denied', `${p} ${JSON.stringify(body)}`);
  }
});

test('Support-Tunnel: das Einrichtungsfenster gibt kein Token heraus', async () => {
  const box = { httpPort: 8080, apiToken: 'b'.repeat(32), security: { lanTrust: 'open' } };
  const { ctx, saved } = ctxWith(box, { needsSetup: () => true, getDataDir: () => '/nonexistent' });
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/setup/complete', { victronHost: '192.168.1.20' }, { viaSupport: true }), res, new URL('http://x/api/setup/complete'));
  assert.equal(res._captured.status, 403, res._captured.body);
  assert.equal(JSON.parse(res._captured.body).error, 'support_tunnel_consent_denied');
  assert.doesNotMatch(res._captured.body, /b{32}/);
  assert.equal(saved.length, 0);
  // Vom Heimnetz/von der Box aus läuft die Einrichtung weiter.
  const res2 = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/setup/complete', { victronHost: '192.168.1.20' }), res2, new URL('http://x/api/setup/complete'));
  assert.equal(res2._captured.status, 200, res2._captured.body);
});

test('Support-Tunnel: Zugänge in der Konfiguration (Sicherheit, VPN, Hosts, EEBUS-Kopplungen, Ortsnetz) bleiben, wie die Box sie hat', async () => {
  const box = {
    httpPort: 8080, apiToken: 'b'.repeat(32),
    security: { lanTrust: 'open', lanCidrs: [], trustedClientIps: [] },
    vpn: { enabled: false, autoConnect: false },
    eebus: { enabled: true, trusted: [] },
    ortsnetz: { enabled: false },
    victron: { mqtt: { broker: 'mqtt://192.168.1.5:1883' } },
  };
  const { ctx, saved } = ctxWith(box, {
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }), getConfigDefinition: () => [],
    getConfigPath: () => '/nonexistent/config.json', getServiceActionsEnabled: () => true,
  });
  const routes = createApiRoutes(ctx);
  const wide = {
    httpPort: 8080,
    security: { lanTrust: 'open', lanCidrs: ['0.0.0.0/0', '::/0'], trustedClientIps: [] },
    vpn: { enabled: true, autoConnect: true },
    allowedHosts: ['evil.example.net'], corsAllowedOrigins: ['https://evil.example.net'],
    trustProxy: true, trustedProxyIps: ['127.0.0.1'],
    eebus: { enabled: true, trusted: [{ ski: 'a'.repeat(40), role: 'grid' }] },
    ortsnetz: { enabled: true },
    mqtt: { brokerUrl: 'mqtts://broker.evil.example.net', haDiscovery: { enabled: true } },
    victron: { transport: 'mqtt', mqtt: { schema: 'dvhub', broker: 'mqtts://broker.evil.example.net' }, mqttCrossCheck: { broker: 'mqtt://evil.example.net' } },
    forecast: { weather: { mqtt: { brokerUrl: 'mqtt://evil.example.net' } } },
  };
  for (const p of ['/api/config', '/api/config/import']) {
    const res = mockRes();
    await routes.handleRequest(makeReq('POST', p, { config: JSON.parse(JSON.stringify(wide)) }, { viaSupport: true }), res, new URL(`http://x${p}`));
    assert.equal(res._captured.status, 200, `${p}: ${res._captured.body}`);
    const last = saved.at(-1);
    assert.deepEqual(last.security, box.security, `${p}: security`);
    assert.deepEqual(last.vpn, box.vpn, `${p}: vpn`);
    assert.deepEqual(last.eebus.trusted, [], `${p}: eebus.trusted`);
    assert.deepEqual(last.ortsnetz, box.ortsnetz, `${p}: ortsnetz`);
    assert.equal(last.mqtt.brokerUrl, undefined, `${p}: mqtt.brokerUrl`);
    assert.equal(last.mqtt.haDiscovery.enabled, true, `${p}: übrige MQTT-Einstellungen bleiben änderbar`);
    assert.equal(last.victron.mqtt.broker, 'mqtt://192.168.1.5:1883', `${p}: victron.mqtt.broker der Box bleibt`);
    assert.equal(last.victron.mqtt.schema, 'dvhub', `${p}: übrige Anbindung änderbar`);
    assert.equal(last.victron.mqttCrossCheck.broker, undefined, `${p}: Gegenprobe-Broker`);
    assert.equal(last.forecast.weather.mqtt.brokerUrl, undefined, `${p}: Wetter-Broker`);
    for (const k of ['allowedHosts', 'corsAllowedOrigins', 'trustProxy', 'trustedProxyIps']) assert.equal(last[k], undefined, `${p}: ${k}`);
  }
  // Vom Heimnetz aus geht dasselbe weiter.
  const res = mockRes();
  await routes.handleRequest(makeReq('POST', '/api/config', { config: JSON.parse(JSON.stringify(wide)) }), res, new URL('http://x/api/config'));
  assert.equal(res._captured.status, 200, res._captured.body);
  assert.equal(saved.at(-1).vpn.autoConnect, true);
});

test('Support-Tunnel: keinen anderen MQTT-Broker eintragen (bleibender Steuerweg)', async () => {
  const box = { httpPort: 8080, security: { lanTrust: 'open' }, mqtt: { brokerUrl: 'mqtt://192.168.1.5:1883' } };
  const { ctx, saved } = ctxWith(box);
  const routes = createApiRoutes(ctx);
  const call = async (body, viaSupport) => {
    const res = mockRes();
    await routes.handleRequest(makeReq('POST', '/api/family/mqtt-config', body, { viaSupport }), res, new URL('http://x/api/family/mqtt-config'));
    return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
  };
  const r = await call({ brokerUrl: 'mqtts://broker.evil.example.net' }, true);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, 'support_tunnel_consent_denied');
  assert.equal(saved.length, 0);
  assert.notEqual((await call({ brokerUrl: 'mqtt://192.168.1.5:1883', username: 'u' }, true)).status, 403, 'gleicher Broker bleibt änderbar');
  // Mit Zugangsdaten in der Adresse schickt die Seite sie redigiert zurück.
  box.mqtt.brokerUrl = ' mqtt://user:pw@192.168.1.5:1883';
  assert.notEqual((await call({ brokerUrl: 'mqtt://***:***@192.168.1.5:1883', topicPrefix: 'x' }, true)).status, 403, 'redigierte Adresse = gleicher Broker');
  // Backslash: WHATWG liest Host 192.168.1.5, url.parse (mqtt.js) evil.example.net (Gegenprüfung ebab0f7e, P2).
  const bs = await call({ brokerUrl: 'mqtt://a:b@evil.example.net\\@192.168.1.5:1883' }, true);
  assert.equal(bs.status, 400, JSON.stringify(bs.body));
  assert.equal(bs.body.error, 'invalid_broker_url');
  assert.equal((await call({ brokerUrl: 'mqtt://x@192.168.1.5:1883 evil' }, false)).status, 400, 'Leerzeichen');
  // Nicht lesbare Adresse mit @ (Gegenprüfung 50af8805, P3): gespeichert ist eine
  // ebenfalls nicht lesbare — beide würden zu „***@redacted“.
  box.mqtt.brokerUrl = 'mqtt://user:pa#ss@192.168.1.5:1883';
  const bad = await call({ brokerUrl: 'mqtt://a:b@evil.example.net^' }, true);
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(bad.body.error, 'invalid_broker_url');
  assert.notEqual((await call({ brokerUrl: 'mqtts://broker.example.net' }, false)).status, 403, 'vom Heimnetz aus weiter möglich');
});
