// test/integrations-mqtt-control.test.js -- Routen für die MQTT-Steuerung
// der Integrationsseite (2026-09-14).
//
//   GET  /api/integrations/mqtt/status  -> { ok, status, log, config }
//        GET-only LAN-Bypass wie /api/integrations/mqtt/topics; extern Bearer.
//   POST /api/integrations/mqtt/action  { action: connect|disconnect|reconnect }
//        -> ruft hub.connect()/disconnect()/restart(), antwortet mit Status.
//   POST /api/family/mqtt-config         nimmt zusätzlich enabled, embeddedPort,
//        publishIntervalMs, clientId, keepaliveSec, reconnectPeriodMs,
//        connectTimeoutMs, rejectUnauthorized an, validiert Bereiche und
//        übernimmt mit applyNow:true live (hub.restart + publisher.restart)
//        statt einen Service-Neustart zu verlangen.
//
// Startet den echten Request-Handler auf einem Loopback-Port (Muster aus
// integrations-mqtt-topics.test.js). Rot, bis routes-api.js die Routen hat.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createApiRoutes } from '../routes-api.js';

const TEST_TOKEN = 'x'.repeat(64);

function makeHub() {
  const hub = {
    calls: [],
    connected: true,
    getStatus() { return { enabled: true, state: 'connected', brokerUrl: 'mqtt://b:1883', reconnects: 2, lastError: null }; },
    getLog(limit) { return [{ ts: 1, level: 'info', msg: 'Connected' }].slice(0, limit || 100); },
    async connect() { hub.calls.push('connect'); return { ok: true, state: 'connecting' }; },
    async disconnect() { hub.calls.push('disconnect'); return { ok: true, state: 'stopped' }; },
    async restart() { hub.calls.push('restart'); return { ok: true, state: 'connecting' }; }
  };
  return hub;
}

function makeCtx({ rawMqtt = null } = {}) {
  const raw = {
    apiToken: TEST_TOKEN,
    trustProxy: true,
    trustedProxyIps: ['127.0.0.1'],
    allowedHosts: [],
    corsAllowedOrigins: [],
    mqtt: rawMqtt || { enabled: true, brokerUrl: 'mqtt://b:1883', username: 'u', password: 'secret', publishIntervalMs: 5000 }
  };
  const hub = makeHub();
  const publisher = { restarts: 0, topicCount: 3, restart() { this.restarts++; } };
  const saved = [];
  return {
    ctx: {
      state: {},
      pushLog: () => {},
      getCfg: () => raw,
      getRawCfg: () => raw,
      saveAndApplyConfig: (next) => { saved.push(next); Object.assign(raw, next); return { ok: true, restartRequired: true, restartRequiredPaths: ['mqtt'] }; },
      needsSetup: () => false,
      getAppDir: () => process.cwd(),
      getAppVersion: () => ({ versionLabel: 'test' }),
      mqttHub: hub,
      mqttPublisher: publisher,
      mqttTopicObserver: { getTopics: () => [], observedSince: null }
    },
    hub, publisher, saved, raw
  };
}

async function startHandler(ctx) {
  const routes = createApiRoutes(ctx);
  const srv = createServer((req, res) => {
    Promise.resolve()
      .then(() => routes.handleRequest(req, res, new URL(req.url, `http://${req.headers.host}`)))
      .then((handled) => { if (handled === false) routes.serveStatic(req, res); })
      .catch((e) => {
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) })); }
      });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, baseUrl: `http://127.0.0.1:${srv.address().port}` };
}

const auth = { 'Authorization': 'Bearer ' + TEST_TOKEN, 'Content-Type': 'application/json' };

describe('GET /api/integrations/mqtt/status', () => {
  it('liefert status, log und config; Passwort nur als passwordSet', async () => {
    const { ctx } = makeCtx();
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/integrations/mqtt/status', { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status.state, 'connected');
    assert.equal(body.status.reconnects, 2);
    assert.ok(Array.isArray(body.log) && body.log.length === 1);
    assert.equal(body.config.brokerUrl, 'mqtt://b:1883');
    assert.equal(body.config.passwordSet, true);
    assert.equal(body.config.enabled, true);
    assert.equal(body.config.publishIntervalMs, 5000);
    assert.equal(JSON.stringify(body).includes('secret'), false, 'Passwort verlässt den Server nicht');
  });

  it('verlangt extern ein Bearer-Token (401)', async () => {
    const { ctx } = makeCtx();
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/integrations/mqtt/status', { headers: { 'X-Forwarded-For': '8.8.8.8' } });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/integrations/mqtt/action', () => {
  for (const [action, expectCall] of [['connect', 'connect'], ['disconnect', 'disconnect'], ['reconnect', 'restart']]) {
    it(`action=${action} ruft hub.${expectCall}() und antwortet mit Status`, async () => {
      const { ctx, hub } = makeCtx();
      const { srv, baseUrl } = await startHandler(ctx);
      after(() => new Promise((r) => srv.close(r)));
      const res = await fetch(baseUrl + '/api/integrations/mqtt/action', { method: 'POST', headers: auth, body: JSON.stringify({ action }) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(hub.calls, [expectCall]);
      assert.equal(body.status.state, 'connected');
    });
  }

  it('unbekannte Aktion → 400', async () => {
    const { ctx, hub } = makeCtx();
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/integrations/mqtt/action', { method: 'POST', headers: auth, body: JSON.stringify({ action: 'explode' }) });
    assert.equal(res.status, 400);
    assert.deepEqual(hub.calls, []);
  });

  it('extern ohne Token → 401, keine Aktion', async () => {
    const { ctx, hub } = makeCtx();
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/integrations/mqtt/action', { method: 'POST', headers: { 'X-Forwarded-For': '8.8.8.8', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reconnect' }) });
    assert.equal(res.status, 401);
    assert.deepEqual(hub.calls, []);
  });
});

describe('POST /api/family/mqtt-config — erweiterte Felder + applyNow', () => {
  it('speichert die Verbindungsoptionen und übernimmt sie live ohne Service-Neustart', async () => {
    const { ctx, hub, publisher, raw } = makeCtx();
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/family/mqtt-config', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        enabled: true, brokerUrl: 'mqtts://b:8883', embeddedPort: 18830, publishIntervalMs: 10000,
        clientId: 'dvhub-haus', keepaliveSec: 45, reconnectPeriodMs: 8000, connectTimeoutMs: 15000,
        rejectUnauthorized: false, password: '***', applyNow: true
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.restartRequired, false, 'live übernommen, kein Neustart nötig');
    assert.equal(body.applied, true);
    assert.deepEqual(hub.calls, ['restart']);
    assert.equal(publisher.restarts, 1);
    assert.equal(raw.mqtt.publishIntervalMs, 10000);
    assert.equal(raw.mqtt.clientId, 'dvhub-haus');
    assert.equal(raw.mqtt.keepaliveSec, 45);
    assert.equal(raw.mqtt.reconnectPeriodMs, 8000);
    assert.equal(raw.mqtt.connectTimeoutMs, 15000);
    assert.equal(raw.mqtt.rejectUnauthorized, false);
    assert.equal(raw.mqtt.embeddedBroker.port, 18830);
    assert.equal(raw.mqtt.password, 'secret', '*** = Passwort bleibt');
    assert.equal(body.mqtt.clientId, 'dvhub-haus');
    assert.equal(body.mqtt.publishIntervalMs, 10000);
  });

  it('ohne applyNow bleibt restartRequired wie bisher und der Hub wird nicht angefasst', async () => {
    const { ctx, hub } = makeCtx();
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/family/mqtt-config', { method: 'POST', headers: auth, body: JSON.stringify({ publishIntervalMs: 7000 }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.restartRequired, true);
    assert.deepEqual(hub.calls, []);
  });

  it('enabled:false wird gespeichert und mit applyNow live abgeschaltet', async () => {
    const { ctx, hub, raw } = makeCtx();
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/family/mqtt-config', { method: 'POST', headers: auth, body: JSON.stringify({ enabled: false, applyNow: true }) });
    assert.equal(res.status, 200);
    assert.equal(raw.mqtt.enabled, false);
    assert.deepEqual(hub.calls, ['restart']);
  });

  for (const [field, value, error] of [
    ['publishIntervalMs', 100, 'invalid_publish_interval'],
    ['keepaliveSec', 0, 'invalid_keepalive'],
    ['reconnectPeriodMs', 100, 'invalid_reconnect_period'],
    ['connectTimeoutMs', 100, 'invalid_connect_timeout'],
    ['embeddedPort', 80, 'invalid_embedded_port'],
    ['clientId', 'hat leerzeichen', 'invalid_client_id']
  ]) {
    it(`lehnt ${field}=${JSON.stringify(value)} mit 400 ${error} ab`, async () => {
      const { ctx, saved } = makeCtx();
      const { srv, baseUrl } = await startHandler(ctx);
      after(() => new Promise((r) => srv.close(r)));
      const res = await fetch(baseUrl + '/api/family/mqtt-config', { method: 'POST', headers: auth, body: JSON.stringify({ [field]: value }) });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, error);
      assert.equal(saved.length, 0, 'nichts gespeichert');
    });
  }
});
