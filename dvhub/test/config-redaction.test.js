import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDACTED_PATHS, redactConfig, restoreRedacted, isRedactedPath } from '../config-redaction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_API_PATH = path.resolve(__dirname, '..', 'routes-api.js');
const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');

test('config-redaction: REDACTED_PATHS has >= 10 entries and is frozen', () => {
  assert.ok(Array.isArray(REDACTED_PATHS));
  assert.ok(REDACTED_PATHS.length >= 10, `expected >=10 paths, got ${REDACTED_PATHS.length}`);
  assert.ok(Object.isFrozen(REDACTED_PATHS));
});

test('config-redaction: routes-api.js imports REDACTED_PATHS from config-redaction.js', () => {
  const src = fs.readFileSync(ROUTES_API_PATH, 'utf8');
  assert.match(src, /import\s*\{[^}]*REDACTED_PATHS[^}]*\}\s*from\s*['"]\.\/config-redaction\.js['"]/);
  assert.doesNotMatch(src, /const\s+REDACTED_PATHS\s*=\s*\[/);
});

test('config-redaction: server.js imports from config-redaction.js', () => {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  assert.match(src, /import\s*\{[^}]*\}\s*from\s*['"]\.\/config-redaction\.js['"]/);
  assert.doesNotMatch(src, /const\s+REDACTED_PATHS\s*=\s*\[/);
});

test('config-redaction: known sensitive paths are present', () => {
  const expected = ['apiToken', 'telemetry.database.password', 'forecast.solcast.apiKey',
    'mqtt.username', 'mqtt.password', 'notifications.providers.telegram.botToken',
    'notifications.providers.pushover.userKey'];
  for (const p of expected) assert.ok(REDACTED_PATHS.includes(p), `missing ${p}`);
});

test('config-redaction: isRedactedPath returns true for known paths', () => {
  assert.ok(isRedactedPath('apiToken'));
  assert.ok(isRedactedPath('mqtt.password'));
  assert.ok(!isRedactedPath('some.random.path'));
});

test('config-redaction: roundtrip masks then restores', () => {
  const cfg = {
    apiToken: 'secret-a', mqtt: { username: 'user', password: 'pw' },
    forecast: { solcast: { apiKey: 'skey' } },
    notifications: { providers: { pushover: { userKey: 'u1', appToken: 't1' } } }
  };
  const masked = redactConfig(cfg);
  assert.equal(masked.apiToken, '***');
  assert.equal(masked.mqtt.password, '***');
  assert.equal(masked.mqtt.username, '***');
  assert.equal(masked.forecast.solcast.apiKey, '***');
  const restored = restoreRedacted(masked, cfg);
  assert.equal(restored.apiToken, 'secret-a');
  assert.equal(restored.mqtt.password, 'pw');
  assert.equal(restored.mqtt.username, 'user');
  assert.equal(restored.forecast.solcast.apiKey, 'skey');
});

test('config-redaction: non-redacted fields pass through restoreRedacted unchanged', () => {
  const current = { mqtt: { password: 'pw' }, foo: 'bar' };
  const incoming = { mqtt: { password: '***' }, foo: 'baz' };
  const out = restoreRedacted(incoming, current);
  assert.equal(out.mqtt.password, 'pw');
  assert.equal(out.foo, 'baz');
});

test('config-redaction: redactConfig does not mutate original', () => {
  const cfg = { apiToken: 'secret', mqtt: { password: 'pw' } };
  const masked = redactConfig(cfg);
  assert.equal(cfg.apiToken, 'secret');
  assert.equal(cfg.mqtt.password, 'pw');
  assert.equal(masked.apiToken, '***');
});

test('config-redaction: restoreRedacted handles missing nested paths gracefully', () => {
  const incoming = { apiToken: '***' };
  const current = { apiToken: 'real-token' };
  const out = restoreRedacted(incoming, current);
  assert.equal(out.apiToken, 'real-token');
  // No mqtt/forecast keys in either — should not throw
});
