import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubText, scrubDeep } from '../config-redaction.js';
import { buildSupportBundle, supportBundleFilename, SUPPORT_BUNDLE_VERSION } from '../services/support-bundle.js';

// --- scrubText: secrets + PII in free text -----------------------------------

test('scrubText: masks bearer tokens, api keys, JWTs and long hex', () => {
  assert.match(scrubText('Authorization: Bearer abcDEF123456ghiJKL'), /Bearer \*\*\*/);
  assert.match(scrubText('apiKey=abcdef123456'), /apiKey=\*\*\*/i);
  assert.match(scrubText('token: "s3cr3tvalue99"'), /token:\s*"?\*\*\*/i);
  assert.match(scrubText('jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), /\*\*\*/);
  assert.match(scrubText('hash 0123456789abcdef0123456789abcdef'), /\*\*\*/);
  assert.ok(!scrubText('Authorization: Bearer abcDEF123456ghiJKL').includes('abcDEF123456'));
});

test('scrubText: masks emails and URL userinfo', () => {
  assert.equal(scrubText('contact kunde@example.com now'), 'contact ***@*** now');
  // creds masked; broker host also masked (T-0113 wants broker hosts redacted)
  assert.match(scrubText('mqtt://user:passw0rd@broker.local'), /mqtt:\/\/\*\*\*:\*\*\*@/);
  assert.ok(!scrubText('mqtt://user:passw0rd@broker.local').includes('passw0rd'));
});

test('scrubText: masks PUBLIC IPv4 but KEEPS LAN/GX addresses', () => {
  // public → masked
  assert.equal(scrubText('peer 203.0.113.7 connected'), 'peer ***.***.***.*** connected');
  // RFC1918 + loopback + GX → kept (diagnostic value)
  assert.equal(scrubText('GX at 192.168.1.19:502'), 'GX at 192.168.1.19:502');
  assert.equal(scrubText('db on 10.1.2.3'), 'db on 10.1.2.3');
  assert.equal(scrubText('localhost 127.0.0.1'), 'localhost 127.0.0.1');
  // version-like 1.23.17 (octet >255 path / only 3 parts) is not an IP → untouched
  assert.equal(scrubText('uptime-kuma 1.23.17'), 'uptime-kuma 1.23.17');
});

test('scrubText: passes through non-strings and empties unchanged', () => {
  assert.equal(scrubText(''), '');
  assert.equal(scrubText(42), 42);
  assert.equal(scrubText(null), null);
});

// --- scrubDeep: recursive, cycle-safe ----------------------------------------

test('scrubDeep: scrubs nested string values, leaves keys + non-strings intact', () => {
  const out = scrubDeep({
    event: 'login', // key 'token' would be a field name, value is what we scrub
    detail: { token: 'abcdef123456ghij', who: 'admin@host.de', count: 5 },
    list: ['Bearer zzzzzzzzzzzzzz', 'ok'],
  });
  assert.equal(out.event, 'login');
  assert.equal(out.detail.count, 5);
  assert.match(out.detail.token, /\*\*\*/);
  assert.equal(out.detail.who, '***@***');
  assert.match(out.list[0], /Bearer \*\*\*/);
  assert.equal(out.list[1], 'ok');
});

test('scrubDeep: handles circular references without throwing', () => {
  const a = { name: 'x' }; a.self = a;
  const out = scrubDeep(a);
  assert.equal(out.name, 'x');
  assert.equal(out.self, '[Circular]');
});

// --- buildSupportBundle: allowlist + redaction + caps ------------------------

const NOW = '2026-06-08T12:00:00.000Z';

test('buildSupportBundle: redacts config secrets and scrubs log/audit PII', () => {
  const bundle = buildSupportBundle({
    version: '0.8.0',
    system: { node: 'v22', platform: 'linux', uptimeSec: 3600 },
    migrations: { current: 24, applied: [1, 2, 3] },
    config: { apiToken: 'SUPERSECRET', optimizer: { enabled: true }, mqtt: { password: 'pw', brokerUrl: 'mqtt://u:p@host' } },
    logRing: [
      { ts: NOW, event: 'boot', detail: 'ok' },
      { ts: NOW, event: 'push', detail: 'sent to admin@kunde.de from 203.0.113.9' },
    ],
    auditEntries: [{ ts: NOW, eventType: 'vpn_started', payload: { token: 'aaaaaaaaaaaaaaaaaaaa1111' } }],
    health: { telemetryOk: true },
  }, { nowIso: NOW });

  // config secrets gone
  assert.equal(bundle.config.apiToken, '***');
  assert.equal(bundle.config.mqtt.password, '***');
  assert.match(bundle.config.mqtt.brokerUrl, /mqtt:\/\/\*\*\*:\*\*\*@host/);
  // log PII scrubbed (email + public IP)
  assert.match(bundle.logs[1].detail, /\*\*\*@\*\*\*/);
  assert.match(bundle.logs[1].detail, /\*\*\*\.\*\*\*\.\*\*\*\.\*\*\*/);
  // audit secret scrubbed
  assert.match(bundle.audit[0].payload.token, /\*\*\*/);
  // meta + version
  assert.equal(bundle.meta.bundleVersion, SUPPORT_BUNDLE_VERSION);
  assert.equal(bundle.meta.dvhubVersion, '0.8.0');
  assert.equal(bundle.meta.counts.logs, 2);
});

test('buildSupportBundle: enforces entry caps (keeps most-recent)', () => {
  const logRing = Array.from({ length: 50 }, (_, i) => ({ ts: NOW, event: `e${i}` }));
  const bundle = buildSupportBundle({ logRing }, { maxLogEntries: 10, nowIso: NOW });
  assert.equal(bundle.logs.length, 10);
  assert.equal(bundle.logs[9].event, 'e49'); // newest kept
  assert.equal(bundle.logs[0].event, 'e40');
});

test('buildSupportBundle: time window keeps only recent entries', () => {
  const old = '2026-06-08T09:00:00.000Z'; // 3h before NOW
  const recent = '2026-06-08T11:50:00.000Z'; // 10min before NOW
  const bundle = buildSupportBundle({
    logRing: [{ ts: old, event: 'old' }, { ts: recent, event: 'recent' }],
  }, { sinceMs: 60 * 60 * 1000, nowIso: NOW }); // last 1h
  assert.equal(bundle.logs.length, 1);
  assert.equal(bundle.logs[0].event, 'recent');
});

test('buildSupportBundle: empty/missing sources yield a valid empty bundle', () => {
  const bundle = buildSupportBundle({}, { nowIso: NOW });
  assert.equal(bundle.config, null);
  assert.deepEqual(bundle.logs, []);
  assert.deepEqual(bundle.audit, []);
  assert.equal(bundle.meta.counts.logs, 0);
});

test('supportBundleFilename: stable, filesystem-safe, carries version', () => {
  const fn = supportBundleFilename(NOW, '0.8.0');
  assert.match(fn, /^dvhub-support_2026-06-08_12-00-00-000_v0\.8\.0\.json$/);
  assert.ok(!fn.includes(':'));
});
