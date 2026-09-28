// test/datenspende-routes.test.js — /api/datenspende/*: Nonce (CSRF), Einwilligung,
// Schalter, Validierung. Der Dienst ist gestubbt; geprüft wird die Routen-Schicht.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApiRoutes } from '../routes-api.js';

const LAN_IP = '192.168.4.71';
const API_TOKEN = 'B'.repeat(32);

function mockRes() {
  const c = { status: 0, headers: {}, body: '' };
  return { writeHead(s, h) { c.status = s; Object.assign(c.headers, h); }, end(p) { c.body = p == null ? '' : String(p); }, setHeader() {}, _c: c };
}
function makeReq(p, { method = 'GET', body = null, ip = LAN_IP, token = null } = {}) {
  const buf = body != null ? Buffer.from(JSON.stringify(body)) : null;
  const s = Readable.from(buf ? [buf] : []);
  Object.assign(s, { method, url: p, headers: { host: 'dvhub.test' }, socket: { remoteAddress: ip } });
  if (buf) s.headers['content-type'] = 'application/json';
  if (token) s.headers.authorization = `Bearer ${token}`;
  return s;
}
function setup({ linked = false } = {}) {
  let raw = { apiToken: API_TOKEN, datenspende: { enabled: false } };
  const calls = [];
  const ds = {
    linked,
    status() { return { linked: this.linked, enabled: raw.datenspende?.enabled === true, donated: 0 }; },
    async link(args) { calls.push(['link', args]); this.linked = true; return this.status(); },
    unlink() { calls.push(['unlink']); this.linked = false; return this.status(); },
  };
  const ctx = {
    state: {}, pushLog: () => {}, telemetrySafeWrite: () => {}, licenseService: null,
    getCfg: () => ({ ...raw, epex: { enabled: false }, telemetry: { enabled: false }, security: { lanTrust: 'open' }, allowedHosts: [] }),
    getRawCfg: () => raw,
    saveAndApplyConfig: (n) => { raw = n; },
    getAppVersion: () => ({}),
    datenspende: ds,
  };
  const routes = createApiRoutes(ctx);
  const call = async (req) => {
    const res = mockRes();
    await routes.handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
    let j = null; try { j = JSON.parse(res._c.body); } catch { /* */ }
    return { status: res._c.status, j };
  };
  return { call, calls, ds, raw: () => raw };
}

test('status liefert Nonce; link ohne Nonce (fremde Webseite) → 403', async () => {
  const s = setup();
  const st = await s.call(makeReq('/api/datenspende/status'));
  assert.equal(st.status, 200);
  assert.match(st.j.uiToken, /^[a-f0-9]{32}$/);
  const bad = await s.call(makeReq('/api/datenspende/link', { method: 'POST', body: { username: 'u', password: 'p', consent: true } }));
  assert.equal(bad.status, 403);
  assert.equal(bad.j.error, 'ui_token_required');
  assert.equal(s.calls.length, 0);
});

test('link mit Nonce: Einwilligung wird durchgereicht, Spende eingeschaltet', async () => {
  const s = setup();
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/link', { method: 'POST', body: {
    mode: 'signup', username: 'u', password: 'p', consent: true, household: { zip: '52062' }, uiToken: j.uiToken,
  } }));
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.calls[0][1].consent, true);
  assert.equal(s.calls[0][1].household.zip, '52062');
  assert.equal(s.raw().datenspende.enabled, true);
});

test('link: consent muss wörtlich true sein', async () => {
  const s = setup();
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  await s.call(makeReq('/api/datenspende/link', { method: 'POST', body: { username: 'u', password: 'p', consent: 'ja', uiToken: j.uiToken } }));
  assert.equal(s.calls[0][1].consent, false);
});

test('settings: Einschalten braucht Nonce + Verknüpfung; Ausschalten geht immer', async () => {
  const s = setup();
  const noNonce = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { enabled: true } }));
  assert.equal(noNonce.status, 403);
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const notLinked = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { enabled: true, uiToken: j.uiToken } }));
  assert.equal(notLinked.status, 409);
  s.ds.linked = true;
  const on = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { enabled: true, uiToken: j.uiToken } }));
  assert.equal(on.status, 200);
  assert.equal(s.raw().datenspende.enabled, true);
  const off = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { enabled: false } }));
  assert.equal(off.status, 200, 'Ausschalten ohne Nonce (Not-Aus)');
  assert.equal(s.raw().datenspende.enabled, false);
});

test('settings: Quellen/Intervall validiert und zusammengeführt', async () => {
  const s = setup({ linked: true });
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { sources: { pv: false }, intervalSec: 30, uiToken: j.uiToken } }));
  assert.equal(r.status, 200);
  const r2 = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { sources: { devices: false }, uiToken: j.uiToken } }));
  assert.equal(r2.status, 200);
  assert.deepEqual(s.raw().datenspende.sources, { pv: false, devices: false });
  assert.equal(s.raw().datenspende.intervalSec, 30);
  assert.equal((await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { intervalSec: 1, uiToken: j.uiToken } }))).status, 400);
  assert.equal((await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { sources: { hack: true }, uiToken: j.uiToken } }))).status, 400);
});

test('unlink braucht Nonce und schaltet aus', async () => {
  const s = setup({ linked: true });
  assert.equal((await s.call(makeReq('/api/datenspende/unlink', { method: 'POST', body: {} }))).status, 403);
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/unlink', { method: 'POST', body: { uiToken: j.uiToken } }));
  assert.equal(r.status, 200);
  assert.deepEqual(s.calls.at(-1), ['unlink']);
  assert.equal(s.raw().datenspende.enabled, false);
});

test('Bearer-Token ersetzt den Nonce (Skripte/API)', async () => {
  const s = setup({ linked: true });
  const r = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', token: API_TOKEN, body: { enabled: true } }));
  assert.equal(r.status, 200);
});

test('settings: Ausschalten verwirft eine laufende Einrichtung (cancelPendingLink)', async () => {
  const s = setup({ linked: true });
  let cancelled = 0;
  s.ds.cancelPendingLink = () => { cancelled++; };
  await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { enabled: false } }));
  assert.equal(cancelled, 1);
});

test('link mode=apikey ruft linkApiKey (mit Nonce), Einwilligung wörtlich', async () => {
  const s = setup();
  s.ds.linkApiKey = async (a) => { s.calls.push(['linkApiKey', a]); s.ds.linked = true; return s.ds.status(); };
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/link', { method: 'POST', body: { mode: 'apikey', apiKey: 'K'.repeat(40), consent: true, uiToken: j.uiToken } }));
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(s.calls.at(-1), ['linkApiKey', { apiKey: 'K'.repeat(40), consent: true }]);
  assert.equal(s.raw().datenspende.enabled, true);
});

test('backfill: Start braucht Nonce, Stopp nicht; ungültige Aktion 400', async () => {
  const s = setup({ linked: true });
  s.ds.startBackfill = () => { s.calls.push(['start']); return s.ds.status(); };
  s.ds.stopBackfill = () => { s.calls.push(['stop']); return s.ds.status(); };
  assert.equal((await s.call(makeReq('/api/datenspende/backfill', { method: 'POST', body: { action: 'start' } }))).status, 403);
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  assert.equal((await s.call(makeReq('/api/datenspende/backfill', { method: 'POST', body: { action: 'start', uiToken: j.uiToken } }))).status, 200);
  assert.equal((await s.call(makeReq('/api/datenspende/backfill', { method: 'POST', body: { action: 'stop' } }))).status, 200);
  assert.equal((await s.call(makeReq('/api/datenspende/backfill', { method: 'POST', body: { action: 'x' } }))).status, 400);
  assert.deepEqual(s.calls.map((c) => c[0]), ['start', 'stop']);
});
