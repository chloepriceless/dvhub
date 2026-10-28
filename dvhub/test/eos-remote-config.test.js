// test/eos-remote-config.test.js — Einstellungen für EOS im Fernbetrieb.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigDefinition, createDefaultConfig, normalizeConfigInput } from '../config-model.js';
import { REDACTED_PATHS, redactConfig } from '../config-redaction.js';
import { isAllowedRemoteEndpoint, readEosPin, DEFAULT_REMOTE_EOS_VERSION, remoteSettings } from '../services/optimizer/eos-remote.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Felder mit deutschen Beschriftungen, Standard: aus / lokal', () => {
  const fields = Object.fromEntries(getConfigDefinition().fields.map((f) => [f.path, f]));
  const mode = fields['optimizer.eosProxy.mode'];
  assert.ok(mode, 'Betriebsart-Feld fehlt');
  assert.equal(mode.type, 'select');
  assert.deepEqual(mode.options.map((o) => o.value), ['local', 'remote']);
  for (const p of ['optimizer.eosProxy.remote.endpoint', 'optimizer.eosProxy.remote.token', 'optimizer.eosProxy.remote.localFallback',
    'optimizer.eosProxy.remote.debugBundle', 'optimizer.eosProxy.remote.jobTimeoutMs']) {
    assert.ok(fields[p], `${p} fehlt`);
    assert.ok(/[äöüÄÖÜß]|[A-Z][a-z]/.test(fields[p].label), `${p}: Beschriftung`);
  }
  assert.equal(fields['optimizer.eosProxy.remote.token'].type, 'password');
  const d = createDefaultConfig().optimizer.eosProxy;
  assert.equal(d.enabled, false);
  assert.equal(d.mode, 'local');
  assert.deepEqual(d.remote, { endpoint: '', token: '', jobTimeoutMs: 1_200_000, localFallback: false, debugBundle: false });
});

test('Betriebsart remote bleibt beim Normalisieren erhalten', () => {
  const r = normalizeConfigInput({ optimizer: { eosProxy: { enabled: true, mode: 'remote', remote: { endpoint: 'https://eos.example.invalid', token: 'dves_x' } } } });
  const p = r.effectiveConfig?.optimizer?.eosProxy || r.persistedConfig.optimizer.eosProxy;
  assert.equal(p.mode, 'remote');
  assert.equal(p.remote.endpoint, 'https://eos.example.invalid');
  assert.equal(p.remote.token, 'dves_x');
});

test('Box-Token wird wie andere Tokens geschwärzt', () => {
  assert.ok(REDACTED_PATHS.includes('optimizer.eosProxy.remote.token'));
  const red = redactConfig({ optimizer: { eosProxy: { remote: { token: 'dves_geheim', endpoint: 'https://x' } } } });
  assert.notEqual(red.optimizer.eosProxy.remote.token, 'dves_geheim');
  assert.equal(red.optimizer.eosProxy.remote.endpoint, 'https://x');
});

test('Adresse des Dienstes: https überall, http nur im eigenen Netz', () => {
  assert.equal(isAllowedRemoteEndpoint('https://eos.example.invalid'), true);
  assert.equal(isAllowedRemoteEndpoint('http://10.1.2.3:8080'), true);
  assert.equal(isAllowedRemoteEndpoint('http://127.0.0.1:18080'), true);
  assert.equal(isAllowedRemoteEndpoint('http://eos.example.invalid'), false);
  assert.equal(isAllowedRemoteEndpoint('ftp://x'), false);
  assert.equal(isAllowedRemoteEndpoint('nicht-url'), false);
  assert.equal(isAllowedRemoteEndpoint('https://user:pw@eos.example.invalid'), false, 'keine Zugangsdaten in der URL');
});

test('Speichern prüft die Adresse des Dienstes (config-routes)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'config-routes.js'), 'utf8');
  assert.match(src, /isAllowedRemoteEndpoint\(candidateRemoteEndpoint\)/);
  assert.match(src, /invalid_eos_remote_endpoint/);
});

test('Erwartete EOS-Version = EOS_PIN aus eos-version.env', () => {
  const appDir = path.resolve(__dirname, '..');
  const pin = /^EOS_PIN=(\S+)/m.exec(fs.readFileSync(path.resolve(appDir, '..', 'eos-version.env'), 'utf8'))[1];
  assert.equal(readEosPin(appDir), pin);
  assert.equal(DEFAULT_REMOTE_EOS_VERSION, pin, 'Rückfallwert (Container ohne eos-version.env) nachziehen');
});

test('remoteSettings: Grenzen der Wartezeit', () => {
  assert.equal(remoteSettings({ optimizer: { eosProxy: { remote: { jobTimeoutMs: 1 } } } }).jobTimeoutMs, 10_000);
  assert.equal(remoteSettings({}).jobTimeoutMs, 1_200_000);
});
