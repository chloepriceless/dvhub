// test/ui-build-id.test.js -- T-0423 (Christin 11.11.2026): die offene
// Oberfläche (Home-Screen-Webapp) erkennt eine neue DVhub-Version und lädt neu.
//
// Server-Seite: eine Build-Kennung aus Versionsangabe + Inhalt von public/
// (ui-build.js), die jede JSON-Antwort als Kopfzeile X-DVhub-Build trägt — so
// sehen die vorhandenen Status-Abfragen jeder Seite einen Versionswechsel ohne
// neuen Dauer-Poll. Die Kennung ist ein undurchsichtiger Hash (nichts, was
// nicht ohnehin öffentlich ist: /health nennt die Version, public/ ist frei
// abrufbar).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeUiBuildId } from '../ui-build.js';
import { createApiRoutes } from '../routes-api.js';

function rig() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-uibuild-'));
  fs.mkdirSync(path.join(appDir, 'public', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'public', 'index.html'), '<html>alt</html>');
  fs.writeFileSync(path.join(appDir, 'public', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(appDir, 'public', 'assets', 'logo.svg'), '<svg/>');
  return appDir;
}

describe('computeUiBuildId', () => {
  it('liefert 12 Hex-Zeichen, gleich für gleichen Stand (unabhängig von Änderungszeiten)', () => {
    const dir = rig();
    const a = computeUiBuildId({ appDir: dir, versionLabel: 'v1.0.10+abc1234' });
    assert.match(a, /^[0-9a-f]{12}$/);
    const t = new Date(Date.now() - 86400_000);
    fs.utimesSync(path.join(dir, 'public', 'app.js'), t, t);
    assert.equal(computeUiBuildId({ appDir: dir, versionLabel: 'v1.0.10+abc1234' }), a);
  });

  it('ändert sich mit dem Inhalt einer Datei, einer neuen Datei, auch in Unterordnern', () => {
    const dir = rig();
    const a = computeUiBuildId({ appDir: dir, versionLabel: 'v1' });
    fs.writeFileSync(path.join(dir, 'public', 'app.js'), 'console.log(2)');
    const b = computeUiBuildId({ appDir: dir, versionLabel: 'v1' });
    assert.notEqual(b, a);
    fs.writeFileSync(path.join(dir, 'public', 'assets', 'neu.css'), 'a{}');
    const c = computeUiBuildId({ appDir: dir, versionLabel: 'v1' });
    assert.notEqual(c, b);
    fs.writeFileSync(path.join(dir, 'public', 'assets', 'logo.svg'), '<svg></svg>');
    assert.notEqual(computeUiBuildId({ appDir: dir, versionLabel: 'v1' }), c);
  });

  it('ändert sich mit der Versionsangabe (Server-Commit ohne Oberflächen-Änderung)', () => {
    const dir = rig();
    assert.notEqual(
      computeUiBuildId({ appDir: dir, versionLabel: 'v1.0.10+abc1234' }),
      computeUiBuildId({ appDir: dir, versionLabel: 'v1.0.10+def5678' })
    );
  });

  it('Dateiname zählt mit (Umbenennen ist eine Änderung)', () => {
    const dir = rig();
    const a = computeUiBuildId({ appDir: dir, versionLabel: 'v1' });
    fs.renameSync(path.join(dir, 'public', 'app.js'), path.join(dir, 'public', 'app2.js'));
    assert.notEqual(computeUiBuildId({ appDir: dir, versionLabel: 'v1' }), a);
  });

  it('ohne lesbares public/ trotzdem eine Kennung (aus der Version), kein Absturz', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-uibuild-leer-'));
    const a = computeUiBuildId({ appDir: dir, versionLabel: 'v1' });
    assert.match(a, /^[0-9a-f]{12}$/);
    assert.notEqual(computeUiBuildId({ appDir: dir, versionLabel: 'v2' }), a);
  });

  it('echtes public/ des Repos: Kennung in vertretbarer Zeit', () => {
    const appDir = path.resolve(import.meta.dirname, '..');
    const t0 = process.hrtime.bigint();
    const id = computeUiBuildId({ appDir, versionLabel: 'v-test' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.match(id, /^[0-9a-f]{12}$/);
    assert.ok(ms < 2000, `zu langsam: ${ms} ms`);
  });
});

// --- Kopfzeile an den JSON-Antworten (routes-api.js json()) ---------------

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function mockCtx(extra = {}) {
  const cfg = {
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false },
    corsAllowedOrigins: [],
    allowedHosts: [],
  };
  return {
    state: { telemetry: { enabled: false, ok: false }, log: [] },
    getCfg: () => cfg,
    getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getAppVersion: () => ({ version: '1.0.10', versionLabel: 'v1.0.10+abc1234' }),
    getAppDir: () => '/tmp',
    pushLog: () => {},
    needsSetup: () => false,
    ...extra,
  };
}

async function get(ctx, pathname) {
  const routes = createApiRoutes(ctx);
  const req = { method: 'GET', url: pathname, headers: { host: 'dvhub.test' }, socket: { remoteAddress: '192.168.1.5' } };
  const res = mockRes();
  await routes.handleRequest(req, res, new URL(pathname, 'http://dvhub.test'));
  return res._captured;
}

describe('X-DVhub-Build an JSON-Antworten', () => {
  it('/health trägt die Kennung als Kopfzeile', async () => {
    const r = await get(mockCtx({ getAppBuild: () => '0123456789ab' }), '/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-dvhub-build'], '0123456789ab');
    // Körper unverändert (keine neuen Felder nötig)
    assert.equal(JSON.parse(r.body).version, 'v1.0.10+abc1234');
  });

  it('auch Fehlerantworten über json() (hier: fremde Herkunft beim Schreiben, 403)', async () => {
    const ctx = mockCtx({ getAppBuild: () => '0123456789ab' });
    const routes = createApiRoutes(ctx);
    const req = { method: 'POST', url: '/api/ev', headers: { host: 'dvhub.test', origin: 'https://boese.example' }, socket: { remoteAddress: '192.168.1.5' } };
    const res = mockRes();
    await routes.handleRequest(req, res, new URL('/api/ev', 'http://dvhub.test'));
    assert.equal(res._captured.status, 403);
    assert.equal(res._captured.headers['x-dvhub-build'], '0123456789ab');
  });

  it('ohne Kennung (Tests, alte Kontexte) keine Kopfzeile', async () => {
    const r = await get(mockCtx(), '/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-dvhub-build'], undefined);
  });
});
