// test/integrations-mqtt-topics.test.js -- RED route test for /api/integrations/mqtt/topics (D-05)
//
// Wave 0 (plan 09.4-01): the /api/integrations/mqtt/topics endpoint does not
// exist yet — plan 09.4-02 adds it to routes-api.js. These tests start the
// REAL DVhub request handler on an ephemeral loopback port with a minimal fake
// ctx and assert the D-05 contract. They FAIL now (RED) and GREEN when 09.4-02
// ships the route. RED is correct for Wave 0.
//
// Contract under test (from 09.4-RESEARCH.md § "/api/integrations/mqtt/topics route"):
//   GET -> 200 { connected:boolean, observedSince:number|null, total:number,
//                topics:[{topic,count,lastAt,lastPayload}] }
//   - GET-only LAN-bypass; external (non-LAN) callers need a Bearer token —
//     same posture as /api/integrations/health.
//   - 401 for a non-LAN request with no Authorization header.
//   - connected:false must be distinguishable from an empty topic list (Pitfall 7).
//
// Threat T-09.4-03 (DoS): the loopback server binds an ephemeral port (0) and
// is closed in an after() hook so no listener leaks past the test run.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createApiRoutes } from '../routes-api.js';

const TEST_TOKEN = 'x'.repeat(64); // 64-char token — passes the length gate

// Build a minimal fake ctx for createApiRoutes(). The handler only dereferences
// a few fields for this route + the auth/host gates it passes through.
//   - getCfg(): trustProxy + trustedProxyIps let an X-Forwarded-For header
//     classify a loopback request as non-LAN (otherwise 127.0.0.1 is always LAN).
//   - mqttHub.connected / mqttTopicObserver: the data source the route reads.
function makeCtx({ connected = true, topics = null } = {}) {
  const observerTopics = topics || [
    { topic: 'a/b', count: 3, lastAt: Date.now(), lastPayload: '{}' }
  ];
  return {
    state: {},
    pushLog: () => {},
    getCfg: () => ({
      apiToken: TEST_TOKEN,
      trustProxy: true,
      trustedProxyIps: ['127.0.0.1'],
      allowedHosts: [],
      corsAllowedOrigins: []
    }),
    needsSetup: () => false,
    getAppDir: () => process.cwd(),
    getAppVersion: () => ({ versionLabel: 'test' }),
    mqttHub: { connected },
    mqttTopicObserver: {
      getTopics: () => observerTopics,
      observedSince: 1_700_000_000_000
    }
  };
}

// Start the real DVhub request handler on an ephemeral loopback port.
async function startHandler(ctx) {
  const routes = createApiRoutes(ctx);
  const srv = createServer((req, res) => {
    // Mirror server.js: parse the URL, dispatch to handleRequest, fall back to
    // serveStatic when the route is unhandled (returns false). An unknown
    // /api/* path 404s via serveStatic — that is the RED signal here.
    Promise.resolve()
      .then(() => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        return routes.handleRequest(req, res, url);
      })
      .then((handled) => {
        if (handled !== false) return;
        routes.serveStatic(req, res);
      })
      .catch((e) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(e && e.message || e) }));
        }
      });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return { srv, baseUrl: `http://127.0.0.1:${port}` };
}

describe('/api/integrations/mqtt/topics route (D-05)', () => {
  it('GET /api/integrations/mqtt/topics without a token from a non-LAN address returns 401', async () => {
    const { srv, baseUrl } = await startHandler(makeCtx());
    after(() => new Promise((r) => srv.close(r)));

    // X-Forwarded-For with a public IP + trusted-proxy config classifies this as
    // non-LAN; no Authorization header => the auth gate must reject with 401.
    // NOTE: the global checkAuth gate in routes-api.js fires for every /api/*
    // path BEFORE route matching, so this 401 holds whether or not 09.4-02 has
    // added the route — it asserts the D-05 Bearer-required posture either way.
    const res = await fetch(baseUrl + '/api/integrations/mqtt/topics', {
      headers: { 'X-Forwarded-For': '8.8.8.8' }
    });

    assert.equal(res.status, 401, 'non-LAN request with no Bearer token is rejected');
  });

  it('GET with a valid Bearer token returns 200 and the documented shape', async () => {
    const { srv, baseUrl } = await startHandler(makeCtx());
    after(() => new Promise((r) => srv.close(r)));

    const res = await fetch(baseUrl + '/api/integrations/mqtt/topics', {
      headers: {
        'X-Forwarded-For': '8.8.8.8',
        'Authorization': 'Bearer ' + TEST_TOKEN
      }
    });

    assert.equal(res.status, 200, 'authenticated request reaches the route');
    const body = await res.json();
    assert.deepEqual(
      Object.keys(body).sort(),
      ['connected', 'observedSince', 'topics', 'total'],
      'body has exactly connected/observedSince/total/topics'
    );
    assert.ok(Array.isArray(body.topics), 'topics is an array');
    assert.equal(body.total, body.topics.length, 'total equals topics.length');
  });

  it('each topic entry carries topic/count/lastAt/lastPayload', async () => {
    const { srv, baseUrl } = await startHandler(makeCtx());
    after(() => new Promise((r) => srv.close(r)));

    const res = await fetch(baseUrl + '/api/integrations/mqtt/topics', {
      headers: { 'Authorization': 'Bearer ' + TEST_TOKEN }
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    const first = body.topics[0];
    assert.equal(typeof first.topic, 'string', 'topic is a string');
    assert.equal(typeof first.count, 'number', 'count is a number');
    assert.equal(typeof first.lastAt, 'number', 'lastAt is a number');
    assert.equal(typeof first.lastPayload, 'string', 'lastPayload is a string');
  });

  it('reports connected:false distinctly from an empty topic list (Pitfall 7)', async () => {
    // MQTT off + observer empty: the drawer must tell "MQTT off" from "no topics
    // yet" — connected:false alongside total:0, not an indistinguishable [].
    const { srv, baseUrl } = await startHandler(makeCtx({ connected: false, topics: [] }));
    after(() => new Promise((r) => srv.close(r)));

    const res = await fetch(baseUrl + '/api/integrations/mqtt/topics', {
      headers: { 'Authorization': 'Bearer ' + TEST_TOKEN }
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.connected, false, 'connected reflects mqttHub.connected');
    assert.equal(body.total, 0, 'total is 0 when no topics observed');
  });
});
