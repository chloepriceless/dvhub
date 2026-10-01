import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSecrets, encryptSecrets, decryptSecrets, applySecrets } from '../services/config-secrets-crypto.js';

function sampleConfig() {
  return {
    apiToken: 'box-token-1234567890',
    forecast: {
      solcast: { apiKey: 'SOLCAST-REAL-KEY' },
      pvnode: { apiKey: 'PVNODE-REAL-KEY' }
    },
    telemetry: { database: { password: 'db-secret' } },
    epex: { enabled: true }, // non-secret — must NOT travel in the bundle
    optimizer: { allowGridDischarge: true }
  };
}

test('collectSecrets gathers present REDACTED_PATHS values but never apiToken', () => {
  const secrets = collectSecrets(sampleConfig());
  assert.equal(secrets['forecast.solcast.apiKey'], 'SOLCAST-REAL-KEY');
  assert.equal(secrets['forecast.pvnode.apiKey'], 'PVNODE-REAL-KEY');
  assert.equal(secrets['telemetry.database.password'], 'db-secret');
  // apiToken is the target box's own auth token — must NOT travel (lockout risk)
  assert.equal('apiToken' in secrets, false);
  // a non-secret field is never collected
  assert.equal('epex.enabled' in secrets, false);
});

test('collectSecrets skips empty / "***" placeholders and apiToken', () => {
  const secrets = collectSecrets({
    forecast: { solcast: { apiKey: '***' }, pvnode: { apiKey: '' } },
    apiToken: 'real'
  });
  assert.equal('forecast.solcast.apiKey' in secrets, false); // '***' placeholder skipped
  assert.equal('forecast.pvnode.apiKey' in secrets, false);  // empty skipped
  assert.equal('apiToken' in secrets, false);                // never portable
});

test('encrypt → decrypt round-trips the secrets with the right password', () => {
  const blob = encryptSecrets(sampleConfig(), 'correct horse battery staple');
  assert.ok(blob && blob.v === 1 && blob.alg === 'aes-256-gcm');
  // blob exposes path NAMES but never values
  const serialized = JSON.stringify(blob);
  assert.equal(serialized.includes('SOLCAST-REAL-KEY'), false);
  assert.equal(serialized.includes('db-secret'), false);
  assert.ok(blob.paths.includes('forecast.solcast.apiKey'));

  const out = decryptSecrets(blob, 'correct horse battery staple');
  assert.equal(out['forecast.solcast.apiKey'], 'SOLCAST-REAL-KEY');
  assert.equal(out['telemetry.database.password'], 'db-secret');
});

test('decrypt with the wrong password throws invalid_password (GCM auth fail)', () => {
  const blob = encryptSecrets(sampleConfig(), 'right-password');
  assert.throws(() => decryptSecrets(blob, 'wrong-password'), /invalid_password/);
});

test('decrypt rejects a tampered ciphertext', () => {
  const blob = encryptSecrets(sampleConfig(), 'pw');
  const tampered = { ...blob, data: Buffer.from('garbage-ciphertext').toString('base64') };
  assert.throws(() => decryptSecrets(tampered, 'pw'), /invalid_password/);
});

test('decrypt rejects an unsupported blob format', () => {
  assert.throws(() => decryptSecrets({ v: 99 }, 'pw'), /unsupported_secrets_format/);
  assert.throws(() => decryptSecrets(null, 'pw'), /unsupported_secrets_format/);
});

test('encryptSecrets returns null when there is nothing to protect', () => {
  assert.equal(encryptSecrets({ epex: { enabled: true } }, 'pw'), null);
});

test('encryptSecrets requires a non-empty password', () => {
  assert.throws(() => encryptSecrets(sampleConfig(), ''), /password_required/);
});

test('applySecrets restores secrets onto a fresh config and ignores unknown paths', () => {
  const fresh = { forecast: { solcast: { apiKey: '***' }, pvnode: { apiKey: '***' } }, epex: { enabled: true } };
  const restored = applySecrets(fresh, {
    'forecast.solcast.apiKey': 'SOLCAST-REAL-KEY',
    'telemetry.database.password': 'db-secret',
    'evil.injected.path': 'nope' // not in REDACTED_PATHS → must be ignored
  });
  assert.equal(restored.forecast.solcast.apiKey, 'SOLCAST-REAL-KEY');
  assert.equal(restored.telemetry.database.password, 'db-secret');
  assert.equal(restored.evil, undefined); // arbitrary key injection blocked
  // input config is not mutated
  assert.equal(fresh.forecast.solcast.apiKey, '***');
});

test('full migration flow: export secrets, fresh box restores them', () => {
  const prod = sampleConfig();
  const blob = encryptSecrets(prod, 'migrate-2026');
  // fresh box: keys are dead '***' placeholders after a plain import
  const freshImported = {
    forecast: { solcast: { apiKey: '***' }, pvnode: { apiKey: '***' } },
    telemetry: { database: { password: '***' } },
    apiToken: 'fresh-box-own-token'
  };
  const secrets = decryptSecrets(blob, 'migrate-2026');
  const merged = applySecrets(freshImported, secrets);
  assert.equal(merged.forecast.solcast.apiKey, 'SOLCAST-REAL-KEY');
  assert.equal(merged.forecast.pvnode.apiKey, 'PVNODE-REAL-KEY');
  assert.equal(merged.telemetry.database.password, 'db-secret');
  // the fresh box keeps its OWN auth token — never overwritten by the bundle
  assert.equal(merged.apiToken, 'fresh-box-own-token');
});

// ── Geräte-Tausch (2026-10-01) ─────────────────────────────────────────────
import fsx from 'node:fs';
import osx from 'node:os';
import pathx from 'node:path';
import {
  collectMigrationFiles, restoreMigrationFiles, isAllowedMigrationFile,
} from '../services/config-secrets-crypto.js';

function box() {
  const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'dvhub-mig-'));
  const dataDir = pathx.join(root, 'data'); const configDir = pathx.join(root, 'etc');
  fsx.mkdirSync(pathx.join(dataDir, 'support'), { recursive: true });
  fsx.mkdirSync(pathx.join(configDir, 'tls'), { recursive: true });
  fsx.mkdirSync(pathx.join(configDir, 'vpn/profiles/direktvermarkter'), { recursive: true });
  return { root, dataDir, configDir };
}

test('Geräte-Tausch: Schlüssel-Dateien + Token reisen verschlüsselt und kommen bitgleich zurück', () => {
  const a = box();
  fsx.writeFileSync(pathx.join(a.dataDir, 'appliance-id'), 'dvhub-abc123\n');
  fsx.writeFileSync(pathx.join(a.dataDir, 'license_state.json'), '{"license_key":"K"}');
  fsx.writeFileSync(pathx.join(a.dataDir, 'support/relay_id_ed25519'), 'PRIVKEY');
  fsx.writeFileSync(pathx.join(a.configDir, 'tls/key.pem'), 'TLSKEY');
  fsx.writeFileSync(pathx.join(a.configDir, 'vpn/profiles/direktvermarkter/client.ovpn'), 'remote dv.example 1194');
  fsx.writeFileSync(pathx.join(a.dataDir, 'telemetry.sqlite'), 'nicht mitnehmen');
  const files = collectMigrationFiles(a);
  assert.deepEqual(Object.keys(files).sort(), [
    'config/tls/key.pem', 'config/vpn/profiles/direktvermarkter/client.ovpn',
    'data/appliance-id', 'data/license_state.json', 'data/support/relay_id_ed25519',
  ]);
  const blob = encryptSecrets({ forecast: { solcast: { apiKey: 'S' } } }, 'pw-12345678', { files, apiToken: 'TOKEN-xyz' });
  assert.ok(blob.paths.includes('apiToken') && blob.paths.includes('data/appliance-id'));
  assert.ok(!JSON.stringify(blob).includes('PRIVKEY'), 'Inhalt nur verschlüsselt');
  const secrets = decryptSecrets(blob, 'pw-12345678');
  assert.equal(secrets.__apiToken, 'TOKEN-xyz');
  // applySecrets übernimmt weder Token noch Dateien.
  const applied = applySecrets({}, secrets);
  assert.equal(applied.apiToken, undefined);
  assert.equal(applied.__files, undefined);

  const b = box();
  const written = restoreMigrationFiles(secrets.__files, b);
  assert.equal(written.length, 5);
  assert.equal(fsx.readFileSync(pathx.join(b.dataDir, 'appliance-id'), 'utf8'), 'dvhub-abc123\n');
  assert.equal(fsx.readFileSync(pathx.join(b.configDir, 'vpn/profiles/direktvermarkter/client.ovpn'), 'utf8'), 'remote dv.example 1194');
  assert.equal(fsx.statSync(pathx.join(b.dataDir, 'support/relay_id_ed25519')).mode & 0o777, 0o600);
  fsx.rmSync(a.root, { recursive: true, force: true }); fsx.rmSync(b.root, { recursive: true, force: true });
});

test('Geräte-Tausch: nur erlaubte Pfade, kein Ausbruch aus den Ordnern', () => {
  for (const bad of ['data/../../etc/passwd', 'data/telemetry.sqlite', 'config/config.json', 'config/vpn/profiles/../../x', 'etc/shadow', 'data/support/../appliance-id']) {
    assert.equal(isAllowedMigrationFile(bad), false, bad);
  }
  const b = box();
  const written = restoreMigrationFiles({ 'data/../evil': 'eA==', 'config/config.json': 'eA==', 'data/appliance-id': Buffer.from('ok').toString('base64') }, b);
  assert.deepEqual(written, ['data/appliance-id']);
  assert.equal(fsx.existsSync(pathx.join(b.root, 'evil')), false);
  fsx.rmSync(b.root, { recursive: true, force: true });
});
