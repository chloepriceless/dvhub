// test/notifications-uptime-kuma.test.js -- RED tests for the Uptime Kuma provider (D-08)
//
// Wave 0 (plan 09.4-01): written FIRST, against a module that does not exist
// yet. EXPECTED TO FAIL with MODULE_NOT_FOUND until plan 09.4-03 ships
// `services/notifications/providers/uptime-kuma.js`. RED is correct.
//
// Contract under test (from 09.4-RESEARCH.md § "Uptime Kuma provider"):
//   createUptimeKumaProvider(cfg) -> { type:'uptime-kuma', notify, startHeartbeat, stopHeartbeat }
//   - cfg: { pushUrl, heartbeatIntervalSec? }
//     throws Error('uptime-kuma provider requires pushUrl') if !pushUrl
//   - notify({level,title,body}) GETs pushUrl with searchParams
//       status=(critical?'down':'up'), msg=`${title}: ${body}`
//   - returns {ok} shape; never throws
//   - startHeartbeat() sets a setInterval + sends an immediate push;
//     stopHeartbeat() clears it; idempotent
//
// Threat T-09.4-02 (DoS): every test that starts a heartbeat MUST stop it; the
// heartbeat interval is sub-second so total runtime stays under ~3s.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createUptimeKumaProvider } from '../services/notifications/providers/uptime-kuma.js';

// ---------- helpers ----------
function startMockServer(responseStatus, responseBody) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString()
        });
        res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody || {}));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, requests, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeMockServer(mock) {
  return new Promise((resolve) => mock.server.close(resolve));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('createUptimeKumaProvider', () => {
  let mock_;
  let provider_;

  afterEach(async () => {
    // Always stop a possibly-running heartbeat first (T-09.4-02 — no dangling timer).
    if (provider_ && typeof provider_.stopHeartbeat === 'function') {
      provider_.stopHeartbeat();
    }
    provider_ = null;
    if (mock_) await closeMockServer(mock_);
    mock_ = null;
  });

  it('throws when pushUrl is missing', () => {
    assert.throws(() => createUptimeKumaProvider({}), /requires pushUrl/);
  });

  it('notify GETs status=up for info level', async () => {
    mock_ = await startMockServer(200, { ok: true });
    provider_ = createUptimeKumaProvider({ pushUrl: mock_.baseUrl + '/api/push/tok' });

    const result = await provider_.notify({ level: 'info', title: 'T', body: 'B' });

    assert.equal(result.ok, true);
    assert.equal(mock_.requests.length, 1);
    const req = mock_.requests[0];
    assert.equal(req.method, 'GET');
    const q = new URL('http://x' + req.url).searchParams;
    assert.equal(q.get('status'), 'up', 'info level -> status=up');
    assert.ok(String(q.get('msg')).includes('T'), 'msg carries the title');
  });

  it('notify uses status=down for critical level', async () => {
    mock_ = await startMockServer(200, { ok: true });
    provider_ = createUptimeKumaProvider({ pushUrl: mock_.baseUrl + '/api/push/tok' });

    await provider_.notify({ level: 'critical', title: 'Alarm', body: 'down' });

    const q = new URL('http://x' + mock_.requests[0].url).searchParams;
    assert.equal(q.get('status'), 'down', 'critical level -> status=down');
  });

  it('returns {ok:false} on HTTP error and never throws', async () => {
    mock_ = await startMockServer(500, { error: 'server' });
    provider_ = createUptimeKumaProvider({ pushUrl: mock_.baseUrl + '/api/push/tok' });

    const httpErr = await provider_.notify({ level: 'info', title: 'T', body: 'B' });
    assert.equal(httpErr.ok, false);

    // Bad host — fetch rejects; provider must catch and return the shape.
    const badHost = createUptimeKumaProvider({ pushUrl: 'http://127.0.0.1:1/api/push/tok' });
    const netErr = await badHost.notify({ level: 'info', title: 'T', body: 'B' });
    assert.equal(netErr.ok, false);
    assert.equal(typeof netErr.error, 'string');
  });

  it('startHeartbeat sends an immediate push and schedules an interval', async () => {
    mock_ = await startMockServer(200, { ok: true });
    // Sub-second heartbeat keeps the test fast (T-09.4-02).
    provider_ = createUptimeKumaProvider({
      pushUrl: mock_.baseUrl + '/api/push/tok',
      heartbeatIntervalSec: 0.2
    });

    provider_.startHeartbeat();
    await sleep(500); // immediate beat + at least one interval beat
    provider_.stopHeartbeat();

    assert.ok(mock_.requests.length >= 1, 'at least one heartbeat push arrived');
    const q = new URL('http://x' + mock_.requests[0].url).searchParams;
    assert.equal(q.get('status'), 'up', 'heartbeat push uses status=up');
  });

  it('stopHeartbeat clears the timer and startHeartbeat is idempotent', async () => {
    mock_ = await startMockServer(200, { ok: true });
    provider_ = createUptimeKumaProvider({
      pushUrl: mock_.baseUrl + '/api/push/tok',
      heartbeatIntervalSec: 0.2
    });

    // Calling startHeartbeat twice must not double the timer (idempotent).
    provider_.startHeartbeat();
    provider_.startHeartbeat();
    await sleep(400);
    provider_.stopHeartbeat();

    const countAfterStop = mock_.requests.length;
    await sleep(500); // no further pushes must arrive after stopHeartbeat()
    assert.equal(
      mock_.requests.length,
      countAfterStop,
      'no heartbeat pushes after stopHeartbeat()'
    );
  });
});
