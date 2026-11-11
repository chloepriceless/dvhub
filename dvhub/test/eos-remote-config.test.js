// test/eos-remote-config.test.js — Einstellungen für EOS im Fernbetrieb (seit 1.0.10 abgeschaltet).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigDefinition, createDefaultConfig, normalizeConfigInput, loadConfigFile, EOS_REMOTE_MODE_MIGRATION_WARNING } from '../config-model.js';
import { REDACTED_PATHS, redactConfig } from '../config-redaction.js';
import { isAllowedRemoteEndpoint, readEosPin, DEFAULT_REMOTE_EOS_VERSION, remoteSettings } from '../services/optimizer/eos-remote.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Seit 1.0.10 (Christin 11.11.2026): kein Fernbetrieb mehr. Betriebsart und
// remote.* verschwinden aus der Oberfläche; gespeicherte Werte bleiben, nur
// 'remote' wird beim Laden zu 'local' (mit Hinweis).
test('Oberfläche: keine Betriebsart und keine Rechendienst-Felder mehr; Vorgabe lokal', () => {
  const fields = Object.fromEntries(getConfigDefinition().fields.map((f) => [f.path, f]));
  for (const p of ['optimizer.eosProxy.mode', 'optimizer.eosProxy.remote.endpoint', 'optimizer.eosProxy.remote.token',
    'optimizer.eosProxy.remote.localFallback', 'optimizer.eosProxy.remote.debugBundle', 'optimizer.eosProxy.remote.jobTimeoutMs']) {
    assert.equal(fields[p], undefined, `${p} darf nicht mehr angeboten werden`);
  }
  assert.ok(fields['optimizer.eosProxy.url'], 'Adresse des EOS bleibt');
  const d = createDefaultConfig().optimizer.eosProxy;
  assert.equal(d.enabled, false);
  assert.equal(d.mode, 'local');
});

test('gespeichertes remote → beim Laden lokal, mit Hinweis; Anmeldedaten bleiben stehen', () => {
  const r = normalizeConfigInput({ optimizer: { eosProxy: { enabled: true, mode: 'remote', url: 'http://127.0.0.1:8503', remote: { endpoint: 'https://eos.example.invalid', token: 'dves_x' } } } });
  for (const p of [r.persistedConfig.optimizer.eosProxy, r.effectiveConfig.optimizer.eosProxy]) {
    assert.equal(p.mode, 'local');
    assert.equal(p.enabled, true, 'EOS bleibt eingeschaltet');
    assert.equal(p.remote.endpoint, 'https://eos.example.invalid');
    assert.equal(p.remote.token, 'dves_x');
  }
  assert.ok(r.warnings.includes(EOS_REMOTE_MODE_MIGRATION_WARNING), JSON.stringify(r.warnings));
  assert.match(EOS_REMOTE_MODE_MIGRATION_WARNING, /seit 1\.0\.10/);
});

test('lokal oder ohne Betriebsart: kein Hinweis; ungültiger Wert → lokal', () => {
  for (const mode of ['local', undefined]) {
    const r = normalizeConfigInput({ optimizer: { eosProxy: { enabled: true, ...(mode ? { mode } : {}) } } });
    assert.equal(r.persistedConfig.optimizer.eosProxy.mode, 'local');
    assert.ok(!r.warnings.includes(EOS_REMOTE_MODE_MIGRATION_WARNING));
  }
  assert.equal(normalizeConfigInput({ optimizer: { eosProxy: { mode: 'irgendwas' } } }).persistedConfig.optimizer.eosProxy.mode, 'local');
});

test('loadConfigFile: gespeichertes remote → Hinweis in den Warnungen (Protokoll [config], Einstellungen)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-eosremote-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ optimizer: { eosProxy: { enabled: true, mode: 'remote' } } }));
    const loaded = loadConfigFile(file);
    assert.equal(loaded.effectiveConfig.optimizer.eosProxy.mode, 'local');
    assert.ok(loaded.warnings.includes(EOS_REMOTE_MODE_MIGRATION_WARNING));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Box-Token wird wie andere Tokens geschwärzt', () => {
  assert.ok(REDACTED_PATHS.includes('optimizer.eosProxy.remote.token'));
  const red = redactConfig({ optimizer: { eosProxy: { remote: { token: 'dves_geheim', endpoint: 'https://x' } } } });
  assert.notEqual(red.optimizer.eosProxy.remote.token, 'dves_geheim');
  assert.equal(red.optimizer.eosProxy.remote.endpoint, 'https://x');
});

// Strix L-0006 + Gegenprüfung zu 23c3962c (P3): Speichern und Senden folgen
// EINER Regel — sonst ließe sich eine Adresse speichern, an die DVhub dann nie
// etwas schickt (still kein Plan). Nur https, nur unter dvhub.de (oder per
// DVHUB_EOS_REMOTE_TRUSTED_HOSTS auf der Box freigegeben), nichts Internes.
test('Adresse des Dienstes: nur https unter dvhub.de, nichts Internes', () => {
  assert.equal(isAllowedRemoteEndpoint('https://eos.dvhub.de'), true);
  assert.equal(isAllowedRemoteEndpoint('https://eos.example.invalid'), false);
  assert.equal(isAllowedRemoteEndpoint('http://10.1.2.3:8080'), false);
  assert.equal(isAllowedRemoteEndpoint('http://127.0.0.1:18080'), false);
  assert.equal(isAllowedRemoteEndpoint('http://eos.dvhub.de'), false);
  assert.equal(isAllowedRemoteEndpoint('ftp://x'), false);
  assert.equal(isAllowedRemoteEndpoint('nicht-url'), false);
  assert.equal(isAllowedRemoteEndpoint('https://user:pw@eos.dvhub.de'), false, 'keine Zugangsdaten in der URL');
});

test('Speichern prüft die Adresse des Dienstes (config-routes)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'config-routes.js'), 'utf8');
  assert.match(src, /isAllowedRemoteEndpoint\(candidateRemoteEndpoint\)/);
  assert.match(src, /invalid_eos_remote_endpoint/);
});

test('Erwartete EOS-Version = EOS_PIN aus eos-version.env (DVhub-EOS: ohne Präfix dvhub-eos-, wie der Docker-Tag)', () => {
  const appDir = path.resolve(__dirname, '..');
  const pin = /^EOS_PIN=(\S+)/m.exec(fs.readFileSync(path.resolve(appDir, '..', 'eos-version.env'), 'utf8'))[1];
  const label = pin.replace(/^dvhub-eos-/, '');
  assert.equal(readEosPin(appDir), label);
  assert.equal(DEFAULT_REMOTE_EOS_VERSION, label, 'Rückfallwert (Container ohne eos-version.env) nachziehen');
});

test('remoteSettings: Grenzen der Wartezeit', () => {
  assert.equal(remoteSettings({ optimizer: { eosProxy: { remote: { jobTimeoutMs: 1 } } } }).jobTimeoutMs, 10_000);
  assert.equal(remoteSettings({}).jobTimeoutMs, 1_200_000);
});
