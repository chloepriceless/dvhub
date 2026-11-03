// test/grid-share-reset-worker.test.js — Netzstrom-Zähler zurücksetzen im
// Worker-Betrieb (Gegenprüfung Release 1.0.9, P2).
//
// Mit DVHUB_ENABLE_RUNTIME_WORKER=1 beantwortet der Web-Prozess die Route, sein
// Zähler ist aber nur lesend (server.js readOnly) — reset() lieferte immer
// read_only_process, die Route 409. Ein fehlerhafter Zählerstand samt
// Einspeisesperre ließ sich so nicht korrigieren. Jetzt geht der Reset per IPC
// an den Runtime-Prozess, der ihn ausführt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApiRoutes } from '../routes-api.js';
import { createGridShareTracker } from '../services/optimizer/grid-share.js';

function mockRes() {
  const captured = { status: 0, body: '' };
  return {
    headersSent: false,
    setHeader() {},
    writeHead(code) { captured.status = code; this.headersSent = true; },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function makeReq(body) {
  const raw = JSON.stringify(body);
  const req = {
    method: 'POST', url: '/api/battery/grid-share/reset',
    headers: { host: '127.0.0.1:8080', 'content-type': 'application/json', 'x-confirm-legal-gate': 'true', 'user-agent': 'Browser/1' },
    socket: { remoteAddress: '127.0.0.1' },
    on(ev, cb) {
      if (ev === 'data') setTimeout(() => { cb(Buffer.from(raw)); req._end?.(); }, 0);
      else if (ev === 'end') req._end = cb;
      return req;
    },
    destroy() {},
  };
  return req;
}

const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' }, security: { lanTrust: 'open' } };

// Runtime-Zähler mit 500 Wh Netzstrom im Akku → gesperrt.
function chargedRuntimeTracker(dir) {
  const rt = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
  const t0 = Date.now() - 120_000;
  rt.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 77_000 });
  rt.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 30_000, gridImportW: 30_000 }, socPct: 50, capacityWh: 77_000 });
  assert.equal(rt.isLocked(), true);
  return rt;
}

function ctxFor(dir, extra = {}) {
  return {
    getCfg: () => cfg,
    getRawCfg: () => JSON.parse(JSON.stringify(cfg)),
    pushLog: () => {},
    needsSetup: () => false,
    getAppDir: () => '/tmp',
    licenseService: { requirePro: () => true, isProActive: () => true },
    processRole: 'web',
    gridShare: createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir, readOnly: true }),
    ...extra,
  };
}

async function callReset(ctx) {
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  await routes.handleRequest(makeReq({ reason: 'Prüfung' }), res, new URL('http://x/api/battery/grid-share/reset'));
  return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
}

test('Worker-Betrieb: Reset aus dem Web-Prozess erreicht den zählenden Prozess', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-gs-reset-'));
  try {
    const rt = chargedRuntimeTracker(dir);
    const calls = [];
    const ctx = ctxFor(dir, {
      // So verdrahtet server.js den Web-Prozess: Reset an den Runtime-Prozess.
      resetGridShare: async (opts) => { calls.push(opts); return rt.reset(opts); },
    });
    assert.equal(ctx.gridShare.reset({}).error, 'read_only_process', 'Web-Zähler ist nur lesend');
    const r = await callReset(ctx);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reason, 'Prüfung');
    assert.equal(rt.summary().gridWh, 0);
    assert.equal(rt.isLocked(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── IPC über eine echte Prozessgrenze ──────────────────────────────────────
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntimeCommandClient, attachRuntimeCommandServer, RUNTIME_MESSAGE_TYPES } from '../runtime-worker-protocol.js';
import { validateRuntimeCommand, createRuntimeCommandRequest } from '../runtime-commands.js';

const fixture = fileURLToPath(new URL('./fixtures/grid-share-runtime-worker.mjs', import.meta.url));

async function startFixture(dir, env = {}) {
  const worker = fork(fixture, [], { env: { ...process.env, DVHUB_TEST_GS_DIR: dir, ...env }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const client = createRuntimeCommandClient({ getWorker: () => worker, timeoutMs: 5_000 });
  worker.on('message', (m) => client.handleMessage(m));
  worker.on('exit', () => client.failAll('runtime_worker_exited'));
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (m) => { if (m?.type === RUNTIME_MESSAGE_TYPES.RUNTIME_READY) resolve(); });
  });
  return { worker, client };
}

test('Worker-Betrieb: Route → IPC → Runtime-Prozess setzt zurück, der Web-Prozess sieht 0 sofort', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-gs-reset-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  chargedRuntimeTracker(dir);   // Stand in der Datei: 500 Wh, gesperrt
  const { worker, client } = await startFixture(dir);
  t.after(() => worker.kill());
  const ctx = ctxFor(dir);
  assert.equal(ctx.gridShare.isLocked(), true, 'Web-Prozess liest die Sperre aus der Datei');
  // Wie server.js (ctx.resetGridShare im Web-Prozess).
  ctx.resetGridShare = async (opts) => {
    const r = await client.send('grid_share_reset', opts);
    if (!r.ok) return { ok: false, error: r.error };
    ctx.gridShare.reload();
    return r.result;
  };
  const r = await callReset(ctx);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.previousKwh, 0.5);
  assert.equal(ctx.gridShare.summary().gridWh, 0, 'ohne 5-s-Wartezeit neu gelesen');
  assert.equal(ctx.gridShare.isLocked(), false);
  const proto = fs.readFileSync(path.join(dir, 'battery_grid_share_log.jsonl'), 'utf8');
  assert.match(proto, /"event":"reset"[^\n]*"reason":"Prüfung"/);
});

test('Worker-Betrieb: Worker fehlt oder endet → Fehler statt Hängen; unbekannte Befehle werden abgelehnt', async (t) => {
  const none = createRuntimeCommandClient({ getWorker: () => null });
  assert.deepEqual(await none.send('grid_share_reset', {}), { ok: false, error: 'runtime_worker_unavailable' });
  assert.equal((await none.send('grid_share_reset', { reason: 5 })).error, 'grid_share_reset reason must be a string');
  assert.equal(validateRuntimeCommand(createRuntimeCommandRequest('grid_share_reset', { reason: 'x' })).ok, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-gs-reset-exit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { worker, client } = await startFixture(dir, { DVHUB_TEST_GS_EXIT: '1' });
  t.after(() => worker.kill());
  const started = Date.now();
  const r = await client.send('grid_share_reset', { reason: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'runtime_worker_exited');
  assert.ok(Date.now() - started < 4_000, 'nicht erst nach dem Zeitlimit');
  assert.equal(client.pendingCount(), 0);

  // Server: nur bekannte Handler, Antwort mit requestId.
  const sent = [];
  const listeners = [];
  const proc = { send: (m) => sent.push(m), on: (ev, cb) => listeners.push(cb), off() {} };
  attachRuntimeCommandServer({ proc, handlers: { grid_share_reset: () => ({ ok: true, previousKwh: 0 }) } });
  listeners[0]({ type: RUNTIME_MESSAGE_TYPES.COMMAND_REQUEST, requestId: 'a', command: createRuntimeCommandRequest('poll_now') });
  listeners[0]({ type: RUNTIME_MESSAGE_TYPES.COMMAND_REQUEST, requestId: 'b', command: createRuntimeCommandRequest('grid_share_reset', {}) });
  await new Promise((r2) => setTimeout(r2, 20));
  assert.deepEqual(sent.map((m) => [m.requestId, m.ok]), [['a', false], ['b', true]]);
  assert.match(sent[0].error, /unsupported runtime command: poll_now/);
  assert.deepEqual(sent[1].result, { ok: true, previousKwh: 0 });
});

// Gegenprüfung 302ebd13 (P3): Nach dem Zeitlimit führt der Worker den Befehl
// womöglich doch aus — seine verspätete Antwort darf nicht verloren gehen.
test('Zeitlimit: verspätete Antwort geht an onLateResult, nicht ins Leere', async () => {
  const sent = [];
  const late = [];
  const worker = { connected: true, send: (m) => sent.push(m) };
  const client = createRuntimeCommandClient({ getWorker: () => worker, timeoutMs: 30, onLateResult: (type, outcome) => late.push({ type, outcome }) });
  const keepAlive = setInterval(() => {}, 1_000);   // das Zeitlimit ist unref
  const r = await client.send('grid_share_reset', { reason: 'x' }).finally(() => clearInterval(keepAlive));
  assert.deepEqual(r, { ok: false, error: 'runtime_worker_timeout' });
  assert.equal(client.handleMessage({ type: RUNTIME_MESSAGE_TYPES.COMMAND_RESULT, requestId: sent[0].requestId, ok: true, result: { ok: true, previousKwh: 0.5 } }), true);
  assert.deepEqual(late, [{ type: 'grid_share_reset', outcome: { ok: true, result: { ok: true, previousKwh: 0.5 } } }]);
  assert.equal(client.handleMessage({ type: RUNTIME_MESSAGE_TYPES.COMMAND_RESULT, requestId: sent[0].requestId, ok: true }), false, 'nur einmal');
});

test('Route: Worker nicht bereit → 503, Zeitlimit → 504 mit Hinweis „Ergebnis unbekannt“', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-gs-reset-codes-'));
  try {
    for (const [error, status] of [['runtime_worker_unavailable', 503], ['runtime_worker_timeout', 504], ['read_only_process', 409]]) {
      const r = await callReset(ctxFor(dir, { resetGridShare: async () => ({ ok: false, error }) }));
      assert.equal(r.status, status, error);
      assert.equal(r.body.error, error);
      if (status !== 409) assert.ok(r.body.detail, error);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
