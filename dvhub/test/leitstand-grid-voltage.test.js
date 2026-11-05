// test/leitstand-grid-voltage.test.js — Netzspannung + Frequenz dezent am
// Netz-Knoten des Leitstands (05.11.2026). /api/status liefert neben dem
// Rohwert (victron.gridVoltage) die serverseitig geprüfte Frische
// (gridVoltage.ok) — die Uhr des Browsers spielt dafür keine Rolle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApiRoutes } from '../routes-api.js';

const LAN_IP = '192.168.4.71';

function makeReq(method, urlPath) {
  const req = {
    method, url: urlPath,
    headers: { host: 'dvhub.test', 'content-type': 'application/json' },
    socket: { remoteAddress: LAN_IP },
    on(event, cb) { if (event === 'end') setTimeout(() => cb(), 0); return req; },
    destroy() {},
  };
  return req;
}
function mockRes() {
  const c = { status: 0, body: '' };
  return { writeHead(s) { c.status = s; }, setHeader() {}, end(p) { c.body = p == null ? '' : String(p); }, _c: c };
}
function routeCtx(victron) {
  const cfg = {
    apiToken: null, epex: { enabled: false, timezone: 'Europe/Berlin' }, optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' }, telemetry: { enabled: false }, family: {},
    gridPositiveMeans: 'grid_import', keepalivePulseSec: 30, corsAllowedOrigins: [], allowedHosts: [],
    security: { lanTrust: 'open' },
  };
  return {
    state: {
      meter: { ok: false, updatedAt: 0, grid_total_w: 0 }, victron: {}, epex: { ok: false, data: [] },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 }, telemetry: { enabled: false, ok: false },
      keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0 },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: 0, discretionaryWritesPaused: false, pausedAt: 0 },
      log: [], forecast: null,
    },
    getCfg: () => cfg, getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigPath: () => '/tmp/config.json', getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '1.0.10-test' }), getTransportType: () => 'modbus',
    getAppDir: () => '/tmp', getRepoRoot: () => '/tmp', getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub', getServiceUseSudo: () => false, runServiceCommand: async () => ({ ok: true }),
    controlValue: () => 'off', pushLog: () => {}, telemetrySafeWrite: () => {}, needsSetup: () => false,
    epexNowNext: () => null, expireLeaseIfNeeded: () => {}, persistConfig: () => {}, persistControlState: () => {},
    getCachedRuntimeStatusPayload: () => null,
    buildFallbackStatusPayload: (now) => ({ ok: true, now, victron }),
    buildRuntimeRouteMeta: () => ({}),
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
  };
}
async function getStatus(victron) {
  const routes = createApiRoutes(routeCtx(victron));
  const req = makeReq('GET', '/api/status');
  const res = mockRes();
  await routes.handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
  return JSON.parse(res._c.body);
}

test('/api/status: victron.gridVoltage roh + gridVoltage mit Frische (frisch / veraltet / keine Quelle)', async () => {
  const gv = { l1: 238.2, l2: 237.1, l3: 237.4, frequencyHz: 49.98, updatedAt: Date.now() - 5000, source: 'victron_modbus', unitId: 100, error: null };
  const fresh = await getStatus({ gridVoltage: gv });
  assert.equal(fresh.victron.gridVoltage.l1, 238.2);
  assert.equal(fresh.gridVoltage.ok, true);
  assert.equal(fresh.gridVoltage.frequencyHz, 49.98);
  const stale = await getStatus({ gridVoltage: { ...gv, updatedAt: Date.now() - 10 * 60_000 } });
  assert.deepEqual(stale.gridVoltage, { ok: false, reason: 'voltage_stale' });
  const none = await getStatus({});
  assert.deepEqual(none.gridVoltage, { ok: false, reason: 'voltage_unavailable' });
});

function loadGridMeterView() {
  const app = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const m = app.match(/function gridMeterView\(status\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'app.js definiert gridMeterView(status)');
  return new Function(`${m[0]}; return gridMeterView;`)();
}
const RAW = { l1: 238.24, l2: 237.1, l3: 254.0, frequencyHz: 49.98, updatedAt: Date.parse('2026-11-05T11:34:20Z'), source: 'victron_modbus', unitId: 100, error: null };

test('Zähler-Kachel: L1–L3 mit 1 Nachkommastelle, Frequenz mit 2; außerhalb 207–253 V bzw. 49,8–50,2 Hz markiert', () => {
  const view = loadGridMeterView();
  const v = view({ gridVoltage: { ok: true, ...RAW }, victron: { gridVoltage: RAW } });
  assert.equal(v.state, 'ok');
  assert.deepEqual(v.rows.l1, { text: '238,2 V', cls: '' });
  assert.deepEqual(v.rows.l2, { text: '237,1 V', cls: '' });
  assert.deepEqual(v.rows.l3, { text: '254,0 V', cls: 'warn' }, 'über 253 V markiert');
  assert.deepEqual(v.rows.freq, { text: '49,98 Hz', cls: '' });
  const f = view({ gridVoltage: { ok: true, ...RAW, l3: 206.9, frequencyHz: 50.21 }, victron: { gridVoltage: RAW } });
  assert.equal(f.rows.l3.cls, 'warn');
  assert.equal(f.rows.freq.cls, 'warn');
  assert.equal(view({ gridVoltage: { ok: true, ...RAW, l3: 207, frequencyHz: 49.8 } }).rows.freq.cls, '', 'Grenzen gelten noch als normal');
});

test('Zähler-Kachel: keine Werte → „–“ (nie 0); einphasig → L2/L3 „–“', () => {
  const view = loadGridMeterView();
  const none = view({ gridVoltage: { ok: false, reason: 'voltage_unavailable' }, victron: {} });
  assert.equal(none.state, 'none');
  for (const k of ['l1', 'l2', 'l3', 'freq']) assert.deepEqual(none.rows[k], { text: '–', cls: 'dim' }, k);
  assert.match(none.chip.text, /keine Werte/);
  assert.deepEqual(view({}).rows.l1, { text: '–', cls: 'dim' }, 'auch ohne Feld im Status');
  const one = view({ gridVoltage: { ok: true, ...RAW, l2: null, l3: null } });
  assert.equal(one.rows.l2.text, '–');
  assert.equal(one.rows.l1.text, '238,2 V');
});

test('Zähler-Kachel: veraltete Werte bleiben sichtbar, aber gedimmt und als „veraltet“ gekennzeichnet', () => {
  const view = loadGridMeterView();
  const v = view({ gridVoltage: { ok: false, reason: 'voltage_stale' }, victron: { gridVoltage: { ...RAW, error: 'modbus timeout' } } });
  assert.equal(v.state, 'stale');
  assert.deepEqual(v.rows.l1, { text: '238,2 V', cls: 'dim' });
  assert.deepEqual(v.rows.l3, { text: '254,0 V', cls: 'dim' }, 'alte Werte nicht als Grenzverletzung färben');
  assert.match(v.chip.text, /veraltet/);
  assert.equal(v.chip.tone, 'warn');
  assert.match(v.chip.title, /modbus timeout/);
});

test('Leitstand: Kachel „Netz · Zähler“ im Stil der übrigen Kacheln, gefüllt aus /api/status', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../public/index.html'), 'utf8');
  const card = html.match(/<div class="card rail-card"[^>]*id="gridMeterCard"[^>]*>[\s\S]*?\n {6}<\/div>/);
  assert.ok(card, 'rail-card gridMeterCard vorhanden');
  for (const id of ['gridVoltL1', 'gridVoltL2', 'gridVoltL3', 'gridFreq', 'gridMeterChip']) assert.match(card[0], new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(card[0], /data-leit="adv"/, 'auch in der einfachen Ansicht sichtbar');
  const app = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  assert.match(app, /safeRender\('dashboard\.grid-meter', \(\) => renderGridMeterCard\(status\)\)/);
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '../public/index.css'), 'utf8');
  assert.match(css, /\.rail-card-head \.dot-grid \{[^}]*var\(--pink\)/, 'Farbe über das vorhandene Token');
});
