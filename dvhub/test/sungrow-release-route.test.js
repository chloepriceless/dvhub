// test/sungrow-release-route.test.js — POST /api/sungrow/release am echten Weg (Route → forceRelease des echten
// Sungrow-Aktuators → Fake-Modbus). Restpunkt 1 (19.11.2026): die API meldete ok:true, auch wenn gar nichts
// geschrieben wurde — bei ungültigem Herstellerprofil hat der Sungrow-EMS keine Schreibadressen (R-T2.1), die
// Freigabe ging ins Leere und die Kachel zeigte „freigegeben (Modus 0)“. Jetzt: ok:false, sent:false, klarer Grund.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApiRoutes } from '../routes-api.js';
import { loadConfigFile } from '../config-model.js';
import { createSungrowEms, wire, EMS_MODE, EMS_CMD } from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const MODE = wire(13050); const CMD = wire(13051); const POWER = wire(13052);

function brokenProfileConfig() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sg-route-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'hersteller', 'sungrow.json'), '{ "kaputt": ');
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'sungrow', updateChannel: 'dev', victron: { host: '192.0.2.50' } }));
  const loaded = loadConfigFile(configPath);
  assert.ok(loaded.manufacturerProfileError);
  return loaded.effectiveConfig;
}

function setup(cfg, { holding = { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 }, failCmd = false } = {}) {
  const image = sungrowImage({ holding });
  const m = mockSungrow(image);
  const writes = [];
  const transport = {
    type: 'modbus',
    mbRequest: (c) => m.mbRequest(c),
    mbWriteSingle: async (c) => { writes.push(`${c.address}=${c.value}`); if (failCmd && c.address === CMD) throw new Error('modbus timeout'); return m.mbWriteSingle(c); },
    mbWriteMultiple: async (c) => { writes.push(`${c.address}=[${c.values}]`); return m.mbWriteMultiple(c); },
  };
  const logs = [];
  const pushLog = (event, payload) => logs.push({ event, payload: payload || {} });
  const state = { victron: { errors: {}, fieldUpdatedAt: {}, device: sungrowDevice() }, meter: {}, ctrl: {}, log: [] };
  const sungrowEms = createSungrowEms({ state, getCfg: () => cfg, transport, pushLog, sleep: async () => {} });
  const ctx = {
    state, getCfg: () => cfg, getRawCfg: () => cfg, pushLog, sungrowEms,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getAppVersion: () => ({ version: '0.0.0-test' }), needsSetup: () => false,
  };
  return { ctx, writes, logs, image, sungrowEms };
}

async function post(ctx, body) {
  const routes = createApiRoutes(ctx);
  const req = {
    method: 'POST', url: '/api/sungrow/release',
    headers: { host: 'dvhub.test', 'content-type': 'application/json' },
    socket: { remoteAddress: '192.168.1.20' },
    on(ev, cb) {
      if (ev === 'data') setTimeout(() => cb(Buffer.from(JSON.stringify(body))), 0);
      if (ev === 'end') setTimeout(() => cb(), 1);
      return req;
    },
    destroy() {},
  };
  const captured = { status: 0, body: '' };
  const res = { writeHead(c) { captured.status = c; }, setHeader() {}, end(b) { captured.body = b == null ? '' : String(b); } };
  await routes.handleRequest(req, res, new URL('/api/sungrow/release', 'http://dvhub.test'));
  return { status: captured.status, body: captured.body ? JSON.parse(captured.body) : null };
}

describe('POST /api/sungrow/release — ehrliche Antwort (Restpunkt 1)', () => {
  it('ungültiges Herstellerprofil: kein Schreibweg → 409, ok:false, sent:false, Grund; nichts geschrieben', async () => {
    const cfg = brokenProfileConfig();
    const { ctx, writes, logs } = setup(cfg);
    const r = await post(ctx, { confirm: true });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.equal(r.body.sent, false);
    assert.equal(r.body.error, 'config_unsafe_manufacturer_profile_error');
    assert.equal(typeof r.body.requestedAt, 'number');
    assert.deepEqual(writes, []);
    const log = logs.find((l) => l.event === 'sungrow_manual_release');
    assert.equal(log?.payload?.ok, false);
    assert.equal(log?.payload?.sent, false);
  });

  it('ohne Sungrow-EMS-Profil (Victron-artig): 409 sungrow_ems_not_configured, nichts geschrieben', async () => {
    const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import' });
    cfg.controlWrite = { gridSetpointW: { enabled: true, address: 2700 } };
    const { ctx, writes } = setup(cfg);
    const r = await post(ctx, { confirm: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.sent, false);
    assert.equal(r.body.error, 'sungrow_ems_not_configured');
    assert.deepEqual(writes, []);
  });

  it('gültige Sungrow-Konfiguration: Freigabe bestätigt → 200, ok:true, requestedAt; geschrieben 0xCC + Modus 0', async () => {
    const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced' } });
    const { ctx, writes, image } = setup(cfg);
    const r = await post(ctx, { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.notEqual(r.body.sent, false);
    assert.equal(typeof r.body.requestedAt, 'number');
    assert.deepEqual(writes, [`${CMD}=${EMS_CMD.STOP}`, `${MODE}=${EMS_MODE.SELF}`]);
    assert.equal(image.holding.get(MODE), EMS_MODE.SELF);
  });

  it('ohne confirm: 400, nichts geschrieben (unverändert)', async () => {
    const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced' } });
    const { ctx, writes } = setup(cfg);
    const r = await post(ctx, {});
    assert.equal(r.status, 400);
    assert.deepEqual(writes, []);
  });
});
