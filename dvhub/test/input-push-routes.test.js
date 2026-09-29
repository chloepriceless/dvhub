// test/input-push-routes.test.js — /api/input/push: Auth ohne LAN-Freibrief,
// Bearer statt Push-Schlüssel, Profil-/Prozess-Voraussetzungen.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApiRoutes } from '../routes-api.js';
import { createInputPush } from '../services/input-push.js';

const API_TOKEN = 'C'.repeat(32);
function setup({ schema = 'dvhub', processRole = 'monolith' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-inpush-'));
  const ingested = [];
  const ctx = {
    state: {}, pushLog: () => {}, telemetrySafeWrite: () => {}, licenseService: null,
    getCfg: () => ({ apiToken: API_TOKEN, epex: { enabled: false }, telemetry: { enabled: false }, security: { lanTrust: 'open' }, allowedHosts: [] }),
    getAppVersion: () => ({}), getDataDir: () => dir, processRole,
    transport: { type: 'mqtt', schema, ingest: (input, value) => { ingested.push([input, value]); return true; } },
  };
  ctx.inputPush = createInputPush(ctx);
  const key = ctx.inputPush.regenerate();
  const routes = createApiRoutes(ctx);
  const call = async (url, { method = 'GET', headers = {}, body, ip = '192.168.4.20' } = {}) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = Readable.from(buf ? [buf] : []);
    Object.assign(req, { method, url, headers: { host: 'dvhub.test', ...(buf ? { 'content-type': 'application/json' } : {}), ...headers }, socket: { remoteAddress: ip } });
    const c = { status: 0, body: '' };
    const res = { writeHead(s) { c.status = s; }, end(p) { c.body = String(p ?? ''); }, setHeader() {} };
    await routes.handleRequest(req, res, new URL(url, 'http://dvhub.test'));
    return { status: c.status, j: JSON.parse(c.body || 'null') };
  };
  return { call, key, ingested };
}

test('LAN ohne Schlüssel → 401 (kein LAN-Freibrief), falscher Schlüssel → 401', async () => {
  const s = setup();
  assert.equal((await s.call('/api/input/push?grid_w=1')).status, 401);
  assert.equal((await s.call('/api/input/push?grid_w=1', { headers: { 'x-dvhub-push-key': 'a'.repeat(64) } })).status, 401);
  assert.equal(s.ingested.length, 0);
});

test('richtiger Schlüssel (GET wie Loxone) oder Bearer → angenommen', async () => {
  const s = setup();
  const r = await s.call('/api/input/push?grid_w=-900&soc_pct=50', { headers: { 'x-dvhub-push-key': s.key } });
  assert.equal(r.status, 200);
  assert.deepEqual(s.ingested, [['grid_total', -900], ['battery_soc', 50]]);
  const b = await s.call('/api/input/push', { method: 'POST', headers: { authorization: `Bearer ${API_TOKEN}` }, body: { pv_w: 1234 } });
  assert.equal(b.status, 200);
  assert.deepEqual(s.ingested.at(-1), ['pv_total', 1234]);
});

test('nur ungültige Werte → 400 mit Fehlerliste', async () => {
  const s = setup();
  const r = await s.call('/api/input/push?soc_pct=150&x=1', { headers: { 'x-dvhub-push-key': s.key } });
  assert.equal(r.status, 400);
  assert.equal(r.j.errors.length, 2);
});

test('falsches Profil → 409, getrennter Web-Prozess → 503', async () => {
  const venus = setup({ schema: 'venus' });
  assert.equal((await venus.call('/api/input/push?grid_w=1', { headers: { 'x-dvhub-push-key': venus.key } })).status, 409);
  const split = setup({ processRole: 'web' });
  assert.equal((await split.call('/api/input/push?grid_w=1', { headers: { 'x-dvhub-push-key': split.key } })).status, 503);
});
