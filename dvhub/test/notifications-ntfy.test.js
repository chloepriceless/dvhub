// test/notifications-ntfy.test.js -- RED tests for the ntfy.sh provider (D-07)
//
// Wave 0 (plan 09.4-01): written FIRST, against a module that does not exist
// yet. EXPECTED TO FAIL with MODULE_NOT_FOUND until plan 09.4-03 ships
// `services/notifications/providers/ntfy.js`. RED is correct.
//
// Contract under test (from 09.4-RESEARCH.md § "ntfy provider"):
//   createNtfyProvider(cfg) -> { type: 'ntfy', notify }
//   - cfg: { topicUrl, token? } — throws Error('ntfy provider requires topicUrl') if !topicUrl
//   - notify({level,title,body}) POSTs to topicUrl with headers
//       Title=title||'DVhub', Priority=(critical?'5':'3'),
//       Tags=(critical?'warning':'information_source'),
//       Authorization='Bearer '+token (only when token set); body = body||''
//   - returns {ok:true} on res.ok, else {ok:false, error:'HTTP '+status}; never throws
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createNtfyProvider } from '../services/notifications/providers/ntfy.js';

// ---------- helpers ----------
// Local HTTP server: records {method,url,headers,body} of every request and
// replies with a configurable status. Header names are LOWERCASED by Node's
// http server — tests assert lowercase keys.
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

describe('createNtfyProvider', () => {
  let mock_;

  afterEach(async () => {
    if (mock_) await closeMockServer(mock_);
    mock_ = null;
  });

  it('throws when topicUrl is missing', () => {
    assert.throws(() => createNtfyProvider({}), /requires topicUrl/);
  });

  it('POSTs with ntfy headers and returns {ok:true}', async () => {
    mock_ = await startMockServer(200, { id: 'abc' });
    const p = createNtfyProvider({ topicUrl: mock_.baseUrl });

    const result = await p.notify({ level: 'info', title: 'T', body: 'B' });

    assert.deepEqual(result, { ok: true });
    assert.equal(mock_.requests.length, 1);
    const req = mock_.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.title, 'T');
    assert.equal(req.headers.priority, '3', 'info level -> Priority 3');
    assert.equal(req.headers.tags, 'information_source');
    assert.equal(req.body, 'B');
  });

  it('uses Priority 5 + warning tag for critical', async () => {
    mock_ = await startMockServer(200, { id: 'abc' });
    const p = createNtfyProvider({ topicUrl: mock_.baseUrl });

    await p.notify({ level: 'critical', title: 'Alarm', body: 'SOC kritisch' });

    const req = mock_.requests[0];
    assert.equal(req.headers.priority, '5', 'critical level -> Priority 5');
    assert.equal(req.headers.tags, 'warning');
  });

  it('sends Authorization Bearer when token is set', async () => {
    mock_ = await startMockServer(200, { id: 'abc' });
    const p = createNtfyProvider({ topicUrl: mock_.baseUrl, token: 'tok' });

    await p.notify({ level: 'info', title: 'T', body: 'B' });

    assert.equal(mock_.requests[0].headers.authorization, 'Bearer tok');
  });

  it('omits Authorization header when no token is set', async () => {
    mock_ = await startMockServer(200, { id: 'abc' });
    const p = createNtfyProvider({ topicUrl: mock_.baseUrl });

    await p.notify({ level: 'info', title: 'T', body: 'B' });

    assert.equal(mock_.requests[0].headers.authorization, undefined);
  });

  it('returns {ok:false} on HTTP error', async () => {
    mock_ = await startMockServer(500, { error: 'server' });
    const p = createNtfyProvider({ topicUrl: mock_.baseUrl });

    const result = await p.notify({ level: 'info', title: 'T', body: 'B' });

    assert.equal(result.ok, false);
    assert.ok(String(result.error).includes('500'), 'error mentions HTTP 500');
  });

  it('returns {ok:false} and does not throw on network failure', async () => {
    // Port 1 — nothing listens; fetch rejects, provider must catch + return shape.
    const p = createNtfyProvider({ topicUrl: 'http://127.0.0.1:1/x' });

    const result = await p.notify({ level: 'info', title: 'T', body: 'B' });

    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  });
});
