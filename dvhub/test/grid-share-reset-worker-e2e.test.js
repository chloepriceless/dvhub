// test/grid-share-reset-worker-e2e.test.js — echter Start von server.js mit
// Runtime-Worker (DVHUB_ENABLE_RUNTIME_WORKER=1): POST /api/battery/grid-share/reset
// geht per IPC an den Worker, der Web-Prozess zeigt danach sofort 0
// (Gegenprüfung 302ebd13, P3: Verdrahtung in server.js war ungetestet).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const DVHUB_DIR = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

test('Worker-Betrieb (echter server.js): Reset über IPC, sofort sichtbar; vor dem Worker-Start sofortige Absage', { timeout: 120_000 }, async (t) => {
  const rig = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-gs-reset-e2e-'));
  fs.mkdirSync(path.join(rig, 'etc', 'hersteller'), { recursive: true });
  fs.mkdirSync(path.join(rig, 'data'));
  fs.copyFileSync(path.join(DVHUB_DIR, 'hersteller', 'victron.json'), path.join(rig, 'etc', 'hersteller', 'victron.json'));
  const port = await freePort();
  const configPath = path.join(rig, 'etc', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    // Victron ohne Gerät (Modbus an 127.0.0.1 scheitert sofort), kein
    // eingebetteter Broker: so wenig Last wie möglich neben den anderen Tests.
    manufacturer: 'victron', httpPort: port, httpsPort: 0,
    victron: { host: '127.0.0.1', port: await freePort() },
    optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true },
    schedule: { timezone: 'Europe/Berlin' },
  }));
  // 500 Wh Netzstrom im Akku → gesperrt.
  fs.writeFileSync(path.join(rig, 'data', 'battery_grid_share.json'), JSON.stringify({
    version: 1, gridWh: 500, locked: true, since: new Date().toISOString(), updatedAt: new Date().toISOString(),
    storedWh: 38_500, share: 0.013, day: { date: null }, totals: {},
  }));

  const out = fs.openSync(path.join(rig, 'dvhub.log'), 'a');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: DVHUB_DIR,
    env: { ...process.env, DV_APP_CONFIG: configPath, DV_DATA_DIR: path.join(rig, 'data'), NODE_ENV: 'test', DVHUB_ENABLE_RUNTIME_WORKER: '1', DVHUB_SUPPORT_WEB_PORT: String(await freePort()) },
    stdio: ['ignore', out, out],
  });
  // Niedrige Priorität (vererbt sich auf den Worker): zwei startende
  // DVhub-Prozesse sollen zeitkritische Tests nebenan nicht ausbremsen
  // (mobile-link-relay-sicherheit kippte unter dieser Last).
  try { os.setPriority(proc.pid, 19); } catch { /* nicht überall erlaubt */ }
  t.after(async () => {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([exited, sleep(5000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    if (!process.env.KEEP_RIG) fs.rmSync(rig, { recursive: true, force: true });
    else console.log('Rig:', rig);
  });
  const dv = (p) => `http://127.0.0.1:${port}${p}`;
  const reset = async () => {
    const t0 = Date.now();
    const r = await fetch(dv('/api/battery/grid-share/reset'), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-confirm-legal-gate': 'true' }, body: JSON.stringify({ reason: 'e2e' }),
    });
    return { status: r.status, j: await r.json().catch(() => null), ms: Date.now() - t0 };
  };

  // Bis der Worker bereit ist: sofortige Absage (kein Warten aufs Zeitlimit), danach 200.
  let r = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { r = await reset(); } catch { r = null; await sleep(250); continue; }
    if (r.status === 200) break;
    assert.equal(r.j?.error, 'runtime_worker_unavailable', JSON.stringify(r));
    assert.ok(r.ms < 2_000, `Absage nach ${r.ms} ms`);
    await sleep(250);
  }
  assert.equal(r?.status, 200, JSON.stringify(r));
  assert.equal(r.j.previousKwh, 0.5);
  const gs = await (await fetch(dv('/api/battery/grid-share'))).json();
  assert.equal(gs.gridWh, 0, 'Web-Prozess liest sofort neu');
  assert.equal(gs.locked, false);
  assert.ok(gs.protocol.some((e) => e.event === 'reset' && e.reason === 'e2e'), 'Protokollzeile vom Worker');
});
