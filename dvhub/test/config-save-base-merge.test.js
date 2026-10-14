// test/config-save-base-merge.test.js
//
// Die Einstellungsseite schickt beim Speichern die ganze Konfiguration, so wie
// sie beim Öffnen der Seite war. Was die Box seitdem selbst geändert hat
// (Zeitplan-Regeln, Standard-Sollwerte vom Dashboard, Schalter anderer Wege),
// sprang dadurch zurück (Audit 2026-10-14, Befund 1). Jetzt schickt die Seite
// den Stand beim Öffnen als `base` mit; übernommen wird nur, was im Formular
// tatsächlich geändert wurde.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createApiRoutes } from '../routes-api.js';
import { mergeAgainstBase } from '../services/config-base-merge.js';

const API_TOKEN = crypto.randomBytes(32).toString('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function makeReq(pathname, body, { lan = false } = {}) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = 'POST';
  stream.url = pathname;
  stream.headers = { host: 'dvhub.test', 'content-type': 'application/json' };
  if (!lan) stream.headers.authorization = `Bearer ${API_TOKEN}`;
  stream.socket = { remoteAddress: lan ? '192.168.1.20' : '203.0.113.5' };
  return stream;
}

const manualA = { id: 'a', enabled: true, target: 'gridSetpointW', start: '10:00', end: '11:00', value: 500 };
const manualB = { id: 'b', enabled: true, target: 'gridSetpointW', start: '12:00', end: '13:00', value: -800 };

// Stand beim Öffnen der Seite.
function loadedConfig() {
  return {
    apiToken: API_TOKEN,
    keepalivePulseSec: 30,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin', rules: [manualA], defaultGridSetpointW: 0, defaultChargeCurrentA: 20 },
    telemetry: { enabled: false },
  };
}

function mockCtx(boxRaw) {
  const saved = [];
  const raw = clone(boxRaw);
  return {
    saved,
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
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigPath: () => '/tmp/config.json',
    getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '0.0.0-test' }),
    getTransportType: () => 'modbus',
    getAppDir: () => '/tmp',
    getRepoRoot: () => '/tmp',
    getServiceActionsEnabled: () => false,
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    saveAndApplyConfig: (incoming) => {
      saved.push(clone(incoming));
      return { ok: true, changedPaths: [], restartRequired: false, restartRequiredPaths: [], loadedConfig: { exists: true, valid: true } };
    },
  };
}

async function post(ctx, pathname, body, opts) {
  const res = mockRes();
  const req = makeReq(pathname, body, opts);
  await createApiRoutes(ctx).handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
  return res._captured;
}

// Box hat seit dem Öffnen: Regel B von Hand dazu, Regel A automatisch
// abgeschaltet, Standard-Sollwert am Dashboard auf -100 W.
function boxNow() {
  const box = loadedConfig();
  box.schedule.rules = [{ ...manualA, enabled: false }, manualB];
  box.schedule.defaultGridSetpointW = -100;
  return box;
}

describe('POST /api/config mit Stand beim Öffnen (base)', () => {
  it('Zeitplan-Regeln und Standardwerte der Box bleiben, die Änderung im Formular kommt an', async () => {
    const ctx = mockCtx(boxNow());
    const base = loadedConfig();
    const config = loadedConfig();
    config.keepalivePulseSec = 60;           // einzige Änderung im Formular
    const r = await post(ctx, '/api/config', { config, base });
    assert.equal(r.status, 200, r.body);
    const out = ctx.saved.at(-1);
    assert.equal(out.keepalivePulseSec, 60);
    assert.deepEqual(out.schedule.rules, [{ ...manualA, enabled: false }, manualB]);
    assert.equal(out.schedule.defaultGridSetpointW, -100);
    assert.equal(out.schedule.defaultChargeCurrentA, 20);
  });

  it('Konflikt: im Formular und auf der Box verschieden geändert → 409 mit Pfad und Box-Wert', async () => {
    const ctx = mockCtx(boxNow());                       // Box: −100 W (beim Öffnen 0)
    const config = loadedConfig();
    config.schedule.defaultGridSetpointW = 250;          // Formular: 250 W
    const r = await post(ctx, '/api/config', { config, base: loadedConfig() });
    assert.equal(r.status, 409, r.body);
    const body = JSON.parse(r.body);
    assert.equal(body.error, 'config_conflict');
    assert.deepEqual(body.conflicts, [{ path: 'schedule.defaultGridSetpointW', yours: 250, box: -100, base: 0 }]);
    assert.equal(ctx.saved.length, 0, 'nichts gespeichert');
  });

  it('Konflikt bestätigt (overwriteConflicts) → Formular gewinnt', async () => {
    const ctx = mockCtx(boxNow());
    const config = loadedConfig();
    config.schedule.defaultGridSetpointW = 250;
    const r = await post(ctx, '/api/config', { config, base: loadedConfig(), overwriteConflicts: true });
    assert.equal(r.status, 200, r.body);
    assert.equal(ctx.saved.at(-1).schedule.defaultGridSetpointW, 250);
  });

  it('kein Konflikt, wenn Formular und Box auf denselben Wert geändert haben', async () => {
    const ctx = mockCtx(boxNow());
    const config = loadedConfig();
    config.schedule.defaultGridSetpointW = -100;
    const r = await post(ctx, '/api/config', { config, base: loadedConfig() });
    assert.equal(r.status, 200, r.body);
  });

  it('Konflikt in einem Geheimnis zeigt keinen Wert', async () => {
    const box = boxNow();
    box.telemetry = { enabled: false, database: { password: 'box-geheim' } };
    const ctx = mockCtx(box);
    const loaded = loadedConfig();
    loaded.telemetry = { enabled: false, database: { password: '***' } };
    const base = clone(loaded);
    base.telemetry.database.password = 'alt';            // künstlich: Box hat es seitdem geändert
    const config = clone(loaded);
    config.telemetry.database.password = 'neu-im-formular';
    const r = await post(ctx, '/api/config', { config, base }, { lan: true });
    assert.equal(r.status, 409, r.body);
    assert.equal(r.body.includes('box-geheim') || r.body.includes('neu-im-formular') || r.body.includes('"alt"'), false, r.body);
  });

  it('im Formular geleertes Feld (gelöscht) bleibt gelöscht', async () => {
    const ctx = mockCtx(boxNow());
    const config = loadedConfig();
    delete config.schedule.defaultChargeCurrentA;
    const r = await post(ctx, '/api/config', { config, base: loadedConfig() });
    assert.equal(r.status, 200, r.body);
    assert.equal('defaultChargeCurrentA' in ctx.saved.at(-1).schedule, false);
  });

  it('geschwärzte Geheimnisse bleiben geschwärzt (kein Stärke-Check gegen den alten Token)', async () => {
    const box = boxNow();
    box.apiToken = 'kurz';                    // Alt-Box mit schwachem Token
    const ctx = mockCtx(box);
    const loaded = loadedConfig();
    loaded.apiToken = '***';                  // so liefert GET /api/config
    const config = clone(loaded);
    config.keepalivePulseSec = 45;
    // Aus dem LAN ohne Token — so speichert die Einstellungsseite im Heimnetz.
    const r = await post(ctx, '/api/config', { config, base: loaded }, { lan: true });
    assert.equal(r.status, 200, r.body);
    assert.equal(ctx.saved.at(-1).apiToken, '***');
  });

  it('ohne base gilt die geschickte Config — nur Zeitplan-Regeln werden ignoriert', async () => {
    const ctx = mockCtx(boxNow());
    const config = loadedConfig();
    config.schedule.rules = [{ ...manualA, value: 9999 }];   // alter Stand einer Seite
    const r = await post(ctx, '/api/config', { config });
    assert.equal(r.status, 200, r.body);
    const out = ctx.saved.at(-1);
    assert.equal('rules' in out.schedule, false, 'Regeln gehören nicht in die Config');
    assert.equal(out.schedule.defaultGridSetpointW, 0, 'ohne base gewinnt die geschickte Config');
  });

  it('Import: Config aus der Datei (ohne Regeln), Regeln gehen in die eigene Ablage', async () => {
    const ctx = mockCtx(boxNow());
    const imported = [];
    ctx.replaceManualScheduleRules = (rules) => { imported.push(clone(rules)); return rules.length; };
    const r = await post(ctx, '/api/config/import', { config: loadedConfig(), base: loadedConfig() });
    assert.equal(r.status, 200, r.body);
    assert.equal('rules' in ctx.saved.at(-1).schedule, false);
    assert.equal(ctx.saved.at(-1).schedule.defaultGridSetpointW, 0, 'Import nimmt die Datei, nicht den Stand der Box');
    assert.deepEqual(imported, [[manualA]]);
  });

  it('Import ohne Regeln in der Datei lässt die Regeln der Box', async () => {
    const ctx = mockCtx(boxNow());
    let called = false;
    ctx.replaceManualScheduleRules = () => { called = true; return 0; };
    const config = loadedConfig();
    delete config.schedule.rules;
    const r = await post(ctx, '/api/config/import', { config });
    assert.equal(r.status, 200, r.body);
    assert.equal(called, false);
  });

  it('Export legt die Regeln von Hand bei (Sicherung, Geräte-Tausch)', async () => {
    const box = boxNow();
    delete box.schedule.rules;                       // stehen nicht mehr in der Config
    const ctx = mockCtx(box);
    ctx.getManualScheduleRules = () => [manualB];
    const res = mockRes();
    const req = Readable.from([]);
    Object.assign(req, { method: 'GET', url: '/api/config/export', headers: { host: 'dvhub.test', authorization: `Bearer ${API_TOKEN}` }, socket: { remoteAddress: '203.0.113.5' } });
    await createApiRoutes(ctx).handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
    const r = res._captured;
    assert.equal(r.status, 200, r.body);
    const exported = JSON.parse(r.body);
    assert.deepEqual(exported.schedule.rules, [manualB]);
    assert.equal(exported.apiToken, '***');
  });
});

describe('mergeAgainstBase', () => {
  it('von Hand gerechnet: unverändert → Box, geändert → Formular, neu in der Box → Box', () => {
    const base = { a: 1, b: { c: 2, d: [1, 2] }, e: 'x' };
    const incoming = { a: 1, b: { c: 3, d: [1, 2] }, e: 'x', f: true };
    const current = { a: 9, b: { c: 2, d: [1, 2, 3], g: 7 }, h: 'neu' };
    // a: Formular = base → Box 9. b.c: Formular 3 ≠ base 2 → 3. b.d: Formular = base → Box [1,2,3].
    // b.g: nur Box → 7. e: Formular = base, Box hat es gelöscht → weg. f: nur Formular → true. h: nur Box → 'neu'.
    assert.deepEqual(mergeAgainstBase(incoming, base, current), { a: 9, b: { c: 3, d: [1, 2, 3], g: 7 }, f: true, h: 'neu' });
  });

  it('base kein Objekt → incoming unverändert', () => {
    assert.deepEqual(mergeAgainstBase({ a: 1 }, null, { a: 2 }), { a: 1 });
  });
});

describe('Einstellungsseite schickt den Stand beim Öffnen mit', () => {
  function loadHelpers() {
    const settingsPath = fileURLToPath(new URL('../public/settings.js', import.meta.url));
    const sandbox = { console, globalThis: {}, window: { DVhubCommon: {}, addEventListener() {}, setTimeout() {} } };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(settingsPath, 'utf8'), sandbox, { filename: path.basename(settingsPath) });
    return sandbox.DVhubSettingsSave;
  }

  it('Speichern: config + base; Import: ohne base', () => {
    const { buildConfigSaveBody } = loadHelpers();
    const base = { schedule: { rules: [manualA] } };
    const save = JSON.parse(JSON.stringify(buildConfigSaveBody({ a: 1 }, 'settings', {}, base)));
    assert.deepEqual(save, { config: { a: 1 }, base });
    const imp = JSON.parse(JSON.stringify(buildConfigSaveBody({ a: 1 }, 'import', { password: 'pw12345678', migrate: true }, base)));
    assert.deepEqual(imp, { config: { a: 1 }, password: 'pw12345678', migrate: true });
  });
});

describe('Einrichtungsassistent schickt den geladenen Stand mit', () => {
  function loadWizard() {
    const setupPath = fileURLToPath(new URL('../public/setup.js', import.meta.url));
    const sandbox = { console, globalThis: {}, window: { DVhubCommon: {}, addEventListener() {}, setTimeout() {} } };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(setupPath, 'utf8'), sandbox, { filename: path.basename(setupPath) });
    return sandbox.DVhubSetupWizard;
  }

  it('vorhandene Config → base (überschreibt Konflikte bewusst); frische Einrichtung (leer) → ohne base; Import → ohne base', () => {
    const { createSetupWizardState, buildSetupSaveBody } = loadWizard();
    const raw = { schedule: { rules: [manualA] } };
    const existing = createSetupWizardState({ config: raw, effectiveConfig: { a: 1 } });
    assert.deepEqual(JSON.parse(JSON.stringify(buildSetupSaveBody({ x: 1 }, 'setup', existing))), { config: { x: 1 }, base: raw, overwriteConflicts: true });
    const fresh = createSetupWizardState({ config: {}, effectiveConfig: { a: 1 } });
    assert.deepEqual(JSON.parse(JSON.stringify(buildSetupSaveBody({ x: 1 }, 'setup', fresh))), { config: { x: 1 } });
    assert.deepEqual(JSON.parse(JSON.stringify(buildSetupSaveBody({ x: 1 }, 'import', existing))), { config: { x: 1 } });
  });
});

describe('Einstellungsseite: Konflikt beim Speichern', () => {
  function loadHelpers() {
    const settingsPath = fileURLToPath(new URL('../public/settings.js', import.meta.url));
    const sandbox = { console, globalThis: {}, window: { DVhubCommon: {}, addEventListener() {}, setTimeout() {} } };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(settingsPath, 'utf8'), sandbox, { filename: path.basename(settingsPath) });
    return sandbox.DVhubSettingsSave;
  }

  it('Speicherkörper trägt overwriteConflicts nur auf Wunsch', () => {
    const { buildConfigSaveBody } = loadHelpers();
    const plain = JSON.parse(JSON.stringify(buildConfigSaveBody({ a: 1 }, 'settings', {}, { a: 0 })));
    assert.equal('overwriteConflicts' in plain, false);
    const forced = JSON.parse(JSON.stringify(buildConfigSaveBody({ a: 1 }, 'settings', { overwriteConflicts: true }, { a: 0 })));
    assert.equal(forced.overwriteConflicts, true);
  });

  it('Konfliktzeilen: Feldname, dein Wert, Wert der Box; Geheimnis ohne Werte', () => {
    const { describeConfigConflicts } = loadHelpers();
    const lines = JSON.parse(JSON.stringify(describeConfigConflicts([
      { path: 'schedule.defaultGridSetpointW', yours: 250, box: -100, base: 0 },
      { path: 'mqtt.password', secret: true },
      { path: 'optimizer.enabled', yours: true, box: undefined, base: false },
    ], (p) => ({ 'schedule.defaultGridSetpointW': 'Standard-Sollwert Netz' }[p] || p))));
    assert.deepEqual(lines, [
      'Standard-Sollwert Netz: deine Eingabe 250, auf der Box jetzt -100',
      'mqtt.password: auf der Box geändert (Wert verborgen)',
      'optimizer.enabled: deine Eingabe an, auf der Box jetzt (nicht gesetzt)',
    ]);
  });
});
