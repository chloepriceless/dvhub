// test/config-kaputt.test.js — Funde aus dem Paritätsvergleich mit dem
// Rust-Neubau (dvhub-rs .planning/HANDOVER.md, Release 1.0.10).
//
// 1. Kaputte config.json: DVhub lief mit Vorgaben weiter, und das nächste
//    Speichern (Einstellungen, Setup-Assistent, Automatik) überschrieb die
//    Datei — die echte Konfiguration war weg (die Sicherung vor dem Schreiben
//    fällt nach zehn weiteren Speichervorgängen aus der Aufbewahrung).
//    Jetzt: Kopie `config.json.broken-<Zeit>`, Speichern nur nach bewusster
//    Bestätigung, deutliche Meldung in Setup, Einstellungen und Assistent.
// 2. `schedule: 5` (falscher Typ) ließ das Laden werfen → Absturz beim Start.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { loadConfigFile, saveConfigFile } from '../config-model.js';
import { runMigrations } from '../migration-runner.js';
import { createApiRoutes } from '../routes-api.js';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function mkBox(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-config-kaputt-'));
  fs.cpSync(path.join(APP_DIR, 'hersteller'), path.join(dir, 'hersteller'), { recursive: true });
  const configPath = path.join(dir, 'config.json');
  if (text != null) fs.writeFileSync(configPath, text);
  return { dir, configPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const brokenCopies = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('config.json.broken-')).sort();

const BROKEN = '{\n  "victron": { "host": "192.168.1.19" },\n  "apiToken": "geheim-1234567890abcdef",\n';

test('kaputte config.json: Kopie .broken-<Zeit> mit gleichem Inhalt, 0600, nur einmal je Inhalt', () => {
  const box = mkBox(BROKEN);
  try {
    const loaded = loadConfigFile(box.configPath);
    assert.equal(loaded.valid, false);
    assert.equal(loaded.broken, true);
    assert.ok(loaded.parseError);
    const copies = brokenCopies(box.dir);
    assert.equal(copies.length, 1, copies.join(','));
    assert.match(copies[0], /^config\.json\.broken-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    assert.equal(loaded.brokenCopyPath, path.join(box.dir, copies[0]));
    assert.equal(fs.readFileSync(path.join(box.dir, copies[0]), 'utf8'), BROKEN);
    assert.equal(fs.statSync(path.join(box.dir, copies[0])).mode & 0o777, 0o600);
    // Neustart mit derselben kaputten Datei: keine zweite Kopie.
    const again = loadConfigFile(box.configPath);
    assert.equal(brokenCopies(box.dir).length, 1);
    assert.equal(again.brokenCopyPath, loaded.brokenCopyPath);
    // Die kaputte Datei selbst bleibt unangetastet.
    assert.equal(fs.readFileSync(box.configPath, 'utf8'), BROKEN);
  } finally { box.cleanup(); }
});

test('kaputte config.json: Speichern über Vorgaben wird verweigert, die Datei bleibt', () => {
  const box = mkBox(BROKEN);
  try {
    loadConfigFile(box.configPath);
    assert.throws(() => saveConfigFile(box.configPath, { victron: { host: '10.0.0.1' } }),
      (e) => e.code === 'CONFIG_BROKEN' && /kaputt/i.test(e.message));
    assert.equal(fs.readFileSync(box.configPath, 'utf8'), BROKEN, 'nichts überschrieben');
  } finally { box.cleanup(); }
});

test('kaputte config.json: Speichern nach bewusster Bestätigung, die Kopie bleibt', () => {
  const box = mkBox(BROKEN);
  try {
    const saved = saveConfigFile(box.configPath, { victron: { host: '10.0.0.1' } }, { overwriteBroken: true });
    assert.equal(saved.valid, true);
    assert.equal(saved.broken, false);
    assert.equal(JSON.parse(fs.readFileSync(box.configPath, 'utf8')).victron.host, '10.0.0.1');
    const copies = brokenCopies(box.dir);
    assert.equal(copies.length, 1, 'kaputter Stand gesichert, auch ohne vorheriges Laden');
    assert.equal(fs.readFileSync(path.join(box.dir, copies[0]), 'utf8'), BROKEN);
  } finally { box.cleanup(); }
});

test('Wurzel kein Objekt ([1], null) zählt als kaputt; leere und gültige Dateien nicht', () => {
  for (const text of ['[1]', 'null', '5']) {
    const box = mkBox(text);
    try {
      const loaded = loadConfigFile(box.configPath);
      assert.equal(loaded.broken, true, text);
      assert.throws(() => saveConfigFile(box.configPath, {}), (e) => e.code === 'CONFIG_BROKEN', text);
    } finally { box.cleanup(); }
  }
  for (const text of ['', '{}', '{"victron":{"host":"1.2.3.4"}}', null]) {
    const box = mkBox(text);
    try {
      const loaded = loadConfigFile(box.configPath);
      assert.equal(loaded.broken, false, String(text));
      assert.equal(brokenCopies(box.dir).length, 0);
      saveConfigFile(box.configPath, { victron: { host: '10.0.0.2' } });
    } finally { box.cleanup(); }
  }
});

test('Config-Migrationen werfen nicht bei einer Wurzel, die kein Objekt ist (null)', async () => {
  const box = mkBox('null');
  try {
    const r = await runMigrations(box.configPath);
    assert.deepEqual(r.applied, []);
    assert.ok(r.error);
    assert.equal(fs.readFileSync(box.configPath, 'utf8'), 'null');
  } finally { box.cleanup(); }
});

test('schedule mit falschem Typ (5, "x", true, []) → Warnung und Vorgabe statt Absturz', () => {
  for (const value of [5, 'x', true, []]) {
    const box = mkBox(JSON.stringify({ schedule: value, victron: { host: '1.2.3.4' } }));
    try {
      let loaded;
      assert.doesNotThrow(() => { loaded = loadConfigFile(box.configPath); }, JSON.stringify(value));
      assert.equal(loaded.broken, false);
      assert.ok(loaded.warnings.some((w) => /^schedule: /.test(w)), loaded.warnings.join(' | '));
      assert.ok(loaded.persistedConfig.schedule && typeof loaded.persistedConfig.schedule === 'object'
        && !Array.isArray(loaded.persistedConfig.schedule));
      assert.ok(Array.isArray(loaded.persistedConfig.schedule.rules));
      assert.equal(loaded.effectiveConfig.victron.host, '1.2.3.4', 'der Rest der Config gilt');
      assert.doesNotThrow(() => saveConfigFile(box.configPath, { schedule: value }));
    } finally { box.cleanup(); }
  }
});

// ── Routen: Einstellungen/Import und Setup-Assistent ─────────────────────

const API_TOKEN = crypto.randomBytes(32).toString('hex');

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function makeReq(pathname, body, { method = 'POST', lan = false } = {}) {
  const stream = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.url = pathname;
  stream.headers = { host: lan ? '192.168.1.10' : 'dvhub.test', 'content-type': 'application/json' };
  if (!lan) stream.headers.authorization = `Bearer ${API_TOKEN}`;
  stream.socket = { remoteAddress: lan ? '192.168.1.20' : '203.0.113.5' };
  return stream;
}

function brokenError() {
  const e = new Error('config.json ist kaputt');
  e.code = 'CONFIG_BROKEN';
  e.brokenCopyPath = '/data/config.json.broken-2026-11-10T12-00-00';
  return e;
}

function mockCtx({ needsSetup = false } = {}) {
  const calls = [];
  const raw = { apiToken: API_TOKEN, telemetry: { enabled: false } };
  return {
    calls,
    state: {
      meter: { ok: false, updatedAt: 0, grid_total_w: 0 },
      victron: { soc: 50, updatedAt: 0 },
      epex: { ok: false, data: [] },
      energy: { day: null },
      telemetry: { enabled: false, ok: false },
      keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0 },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: 0, dvControl: null },
      log: [],
      forecast: null,
    },
    getCfg: () => ({ ...raw, apiTokenSessionTtlMs: null, gridPositiveMeans: 'grid_import', corsAllowedOrigins: [], allowedHosts: [] }),
    getRawCfg: () => raw,
    getLoadedConfig: () => ({
      exists: true, valid: false, needsSetup: true, parseError: 'Unexpected end of JSON input',
      broken: true, brokenCopyPath: '/data/config.json.broken-2026-11-10T12-00-00', warnings: [],
    }),
    getConfigPath: () => '/data/config.json',
    getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '0.0.0-test' }),
    getTransportType: () => 'modbus',
    getAppDir: () => '/tmp',
    getRepoRoot: () => '/tmp',
    getServiceActionsEnabled: () => false,
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    needsSetup: () => needsSetup,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    saveAndApplyConfig: (incoming, opts = {}) => {
      calls.push({ incoming, opts });
      if (opts.overwriteBroken !== true) throw brokenError();
      return { ok: true, changedPaths: [], restartRequired: false, restartRequiredPaths: [], loadedConfig: { exists: true, valid: true } };
    },
  };
}

async function call(ctx, pathname, body, opts) {
  const res = mockRes();
  const req = makeReq(pathname, body, opts);
  await createApiRoutes(ctx).handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
  return res._captured;
}

for (const route of ['/api/config', '/api/config/import']) {
  test(`${route}: kaputte Datei → 409 config_broken ohne Bestätigung, mit Bestätigung gespeichert`, async () => {
    const ctx = mockCtx();
    const r = await call(ctx, route, { config: { victron: { host: '10.0.0.1' } } });
    assert.equal(r.status, 409, r.body);
    const body = JSON.parse(r.body);
    assert.equal(body.error, 'config_broken');
    assert.equal(body.brokenCopy, 'config.json.broken-2026-11-10T12-00-00', 'nur der Dateiname');
    assert.match(body.detail, /kaputt/i);
    const ok = await call(ctx, route, { config: { victron: { host: '10.0.0.1' } }, confirmOverwriteBrokenConfig: true });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ctx.calls.at(-1).opts.overwriteBroken, true);
  });
}

test('GET /api/config meldet die kaputte Datei (meta.broken, Name der Kopie)', async () => {
  const ctx = mockCtx();
  const r = await call(ctx, '/api/config', null, { method: 'GET' });
  assert.equal(r.status, 200, r.body);
  const meta = JSON.parse(r.body).meta;
  assert.equal(meta.broken, true);
  assert.equal(meta.brokenCopy, 'config.json.broken-2026-11-10T12-00-00');
});

test('Setup-Assistent: Zustand meldet die kaputte Datei, Abschluss braucht die Bestätigung', async () => {
  const ctx = mockCtx({ needsSetup: true });
  const st = await call(ctx, '/api/setup/state', null, { method: 'GET', lan: true });
  assert.equal(st.status, 200, st.body);
  const state = JSON.parse(st.body);
  assert.equal(state.configBroken, true);
  assert.equal(state.brokenCopy, 'config.json.broken-2026-11-10T12-00-00');
  assert.equal(st.body.includes('Unexpected end'), false, 'kein Parser-Text im offenen Setup-Fenster');

  const r = await call(ctx, '/api/setup/complete', { victronHost: '192.168.1.50' }, { lan: true });
  assert.equal(r.status, 409, r.body);
  assert.equal(JSON.parse(r.body).error, 'config_broken');
  const ok = await call(ctx, '/api/setup/complete', { victronHost: '192.168.1.50', confirmOverwriteBrokenConfig: true }, { lan: true });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(ctx.calls.at(-1).opts.overwriteBroken, true);
});

// ── Oberfläche: Bestätigung reist nur nach Rückfrage mit ──────────────────

function loadUi(file) {
  const p = path.join(APP_DIR, 'public', file);
  const sandbox = { console, globalThis: {}, window: { DVhubCommon: {}, addEventListener() {}, setTimeout() {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: file });
  return sandbox;
}

test('Einstellungen und Setup-Seite: confirmOverwriteBrokenConfig nur nach Rückfrage', () => {
  const { buildConfigSaveBody } = loadUi('settings.js').DVhubSettingsSave;
  assert.equal('confirmOverwriteBrokenConfig' in buildConfigSaveBody({ a: 1 }, 'settings', {}, null), false);
  assert.equal(buildConfigSaveBody({ a: 1 }, 'import', { overwriteBroken: true }, null).confirmOverwriteBrokenConfig, true);
  const { buildSetupSaveBody } = loadUi('setup.js').DVhubSetupWizard;
  assert.equal('confirmOverwriteBrokenConfig' in buildSetupSaveBody({ a: 1 }, 'setup', {}), false);
  assert.equal(buildSetupSaveBody({ a: 1 }, 'setup', { overwriteBrokenConfig: true }).confirmOverwriteBrokenConfig, true);
});
