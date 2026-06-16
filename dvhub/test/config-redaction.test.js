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

// --- Review 2026-06-10 (B4): T-0131 weather-broker credentials ---
import { redactConfig as _redactB4, restoreRedacted as _restoreB4, REDACTED_PATHS as _PATHS_B4 } from '../config-redaction.js';

test('B4: forecast.weather.mqtt password/username are in REDACTED_PATHS', () => {
  assert.ok(_PATHS_B4.includes('forecast.weather.mqtt.password'));
  assert.ok(_PATHS_B4.includes('forecast.weather.mqtt.username'));
});

test('B4: weather brokerUrl credentials are URL-redacted and restored', () => {
  const cfg = { forecast: { weather: { mqtt: { brokerUrl: 'mqtt://lox:geheim@192.168.0.10:1883', password: 'pw' } } } };
  const red = _redactB4(cfg);
  assert.ok(!JSON.stringify(red).includes('geheim'), 'embedded password must not survive redaction');
  assert.equal(red.forecast.weather.mqtt.password, '***');
  // UI echoes the redacted copy back → restore must bring the original URL back.
  const restored = _restoreB4(red, cfg);
  assert.equal(restored.forecast.weather.mqtt.brokerUrl, 'mqtt://lox:geheim@192.168.0.10:1883');
  assert.equal(restored.forecast.weather.mqtt.password, 'pw');
});

// --- Phase 24-05 (§5): meterSource / dbBackup redaction gaps ---
// Three verified leaks closed: dbBackup.smb.username (whole-field),
// meterSource.http.url + meterSource.modbus.host (URL-cred). All three must
// roundtrip mask→restore so a GUI-Save (POST /api/config REPLACES verbatim —
// MEMORY feedback_config_save_replaces) never overwrites the cleartext with ***.

test('24-05: dbBackup.smb.username is whole-field redacted and restored', () => {
  const cfg = { dbBackup: { smb: { host: 'nas.lan', share: 'backups', username: 'svc-backup', password: 'pw' } } };
  const masked = redactConfig(cfg);
  assert.equal(masked.dbBackup.smb.username, '***', 'SMB service-account name must be masked in the dump');
  assert.equal(masked.dbBackup.smb.password, '***');
  // host/share are not secrets → untouched
  assert.equal(masked.dbBackup.smb.host, 'nas.lan');
  // UI echoes the masked copy back on save → restore brings the cleartext back.
  const restored = restoreRedacted(masked, cfg);
  assert.equal(restored.dbBackup.smb.username, 'svc-backup');
  assert.equal(restored.dbBackup.smb.password, 'pw');
});

test('24-05: meterSource.http.url credentials are URL-redacted and restored', () => {
  const cfg = { meterSource: { http: { url: 'http://meter:s3cret@192.168.1.9/api', jsonPath: '$.power' } } };
  const masked = redactConfig(cfg);
  assert.ok(!JSON.stringify(masked).includes('s3cret'), 'embedded meter password must not survive redaction');
  // host/path survive — only the user:pass@ component is stripped.
  assert.ok(masked.meterSource.http.url.includes('192.168.1.9'), 'host must survive URL-cred redaction');
  // UI echoes the redacted URL back → looksUrlRedacted guard restores the original.
  const restored = restoreRedacted(masked, cfg);
  assert.equal(restored.meterSource.http.url, 'http://meter:s3cret@192.168.1.9/api');
});

test('24-05: meterSource.modbus.host — plain host is a no-op, @-credential form is redacted+restored', () => {
  // Plain host (the normal case): redactUrlCreds is a no-op, roundtrip stable.
  const plain = { meterSource: { modbus: { host: '192.168.1.7', port: 502 } } };
  const maskedPlain = redactConfig(plain);
  assert.equal(maskedPlain.meterSource.modbus.host, '192.168.1.7', 'plain modbus host must pass through untouched');
  const restoredPlain = restoreRedacted(maskedPlain, plain);
  assert.equal(restoredPlain.meterSource.modbus.host, '192.168.1.7');
  // Edge: an @-bearing host (defensive — RESEARCH A2) is masked then restored.
  const creds = { meterSource: { modbus: { host: 'user:pass@192.168.1.7', port: 502 } } };
  const maskedCreds = redactConfig(creds);
  assert.ok(!JSON.stringify(maskedCreds).includes('user:pass'), 'embedded modbus creds must not survive redaction');
  const restoredCreds = restoreRedacted(maskedCreds, creds);
  assert.equal(restoredCreds.meterSource.modbus.host, 'user:pass@192.168.1.7');
});
