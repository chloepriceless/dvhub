// test/schedule-rules-store-e2e.test.js — Zeitplan-Regeln liegen nicht mehr in
// config.json, sondern in DATA_DIR/schedule-rules.json (2026-10-14).
//
// Echter Start von server.js: erster Start übernimmt die Regeln aus der Config
// (und nimmt sie dort heraus), eine Regel-Änderung schreibt nur die eigene
// Ablage (keine Config-Sicherung), Speichern der Einstellungen lässt die
// Regeln stehen, nach einem Neustart sind sie wieder da.

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
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(250); }
  throw new Error(`Timeout: ${what}`);
}

const ruleA = { id: 'a', enabled: true, target: 'gridSetpointW', start: '10:00', end: '11:00', value: -500, source: 'manual' };
const ruleB = { id: 'b', enabled: true, target: 'gridSetpointW', start: '12:00', end: '13:00', value: '800', source: 'manual' };

test('Zeitplan-Regeln: eigene Ablage statt config.json', { timeout: 120_000 }, async (t) => {
  const rig = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-rules-e2e-'));
  fs.mkdirSync(path.join(rig, 'etc', 'hersteller'), { recursive: true });
  fs.mkdirSync(path.join(rig, 'data'));
  fs.copyFileSync(path.join(DVHUB_DIR, 'hersteller', 'dvhub-mqtt.json'), path.join(rig, 'etc', 'hersteller', 'dvhub-mqtt.json'));
  const port = await freePort();
  const brokerPort = await freePort();
  const configPath = path.join(rig, 'etc', 'config.json');
  const rulesPath = path.join(rig, 'data', 'schedule-rules.json');
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: 'dvhub-mqtt', updateChannel: 'dev', httpPort: port, httpsPort: 0,
    victron: { host: '127.0.0.1', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub', staleMaxAgeMs: 4000 } },
    mqtt: { enabled: true, embeddedBroker: { enabled: true, port: brokerPort } },
    schedule: { timezone: 'Europe/Berlin', rules: [ruleA], defaultGridSetpointW: -40 },
  }));

  let proc = null;
  const start = async () => {
    const out = fs.openSync(path.join(rig, 'dvhub.log'), 'a');
    proc = spawn(process.execPath, ['server.js'], {
      cwd: DVHUB_DIR,
      env: { ...process.env, DV_APP_CONFIG: configPath, DV_DATA_DIR: path.join(rig, 'data'), NODE_ENV: 'test' },
      stdio: ['ignore', out, out],
    });
    await waitFor(async () => { try { return (await fetch(dv('/healthz'))).ok; } catch { return false; } }, 30_000, 'DVhub bootet');
  };
  const stop = async () => {
    if (!proc) return;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([exited, sleep(5000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    proc = null;
  };
  t.after(async () => {
    await stop();
    if (!process.env.KEEP_RIG) fs.rmSync(rig, { recursive: true, force: true });
    else console.log('Rig:', rig);
  });
  const dv = (p) => `http://127.0.0.1:${port}${p}`;
  const getJson = async (p) => (await fetch(dv(p))).json();
  const postJson = async (p, body) => {
    const r = await fetch(dv(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
  const manualIds = (rules) => rules.filter((r) => r.source !== 'forecast_optimizer').map((r) => r.id);
  const backups = () => fs.readdirSync(path.join(rig, 'etc')).filter((f) => f.startsWith('config.backup-'));
  const stored = () => JSON.parse(fs.readFileSync(rulesPath, 'utf8')).rules;

  // 1. Erster Start: aus der Config übernommen, dort herausgenommen.
  await start();
  assert.deepEqual(stored().map((r) => r.id), ['a']);
  const cfgAfterStart = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.ok(!(cfgAfterStart.schedule.rules || []).length, 'Regeln stehen nicht mehr in config.json');
  assert.equal(cfgAfterStart.schedule.defaultGridSetpointW, -40, 'Einstellungen bleiben in der Config');
  assert.deepEqual(manualIds((await getJson('/api/schedule')).rules), ['a']);

  // 2. Regel dazu: nur die Ablage wird geschrieben, keine Config-Sicherung.
  const backupsBefore = backups().length;
  const cfgText = fs.readFileSync(configPath, 'utf8');
  const add = await postJson('/api/schedule/rules', { rules: [ruleA, ruleB] });
  assert.equal(add.status, 200, JSON.stringify(add.j));
  assert.deepEqual(stored().map((r) => r.id), ['a', 'b']);
  assert.equal(stored()[1].value, 800, 'normalisiert wie früher über die Config (Zahl statt Text)');
  assert.equal(fs.readFileSync(configPath, 'utf8'), cfgText, 'config.json unverändert');
  assert.equal(backups().length, backupsBefore, 'keine Config-Sicherung für eine Regel-Änderung');

  // 3. Einstellungen speichern (mit altem Stand ohne Regel b) lässt die Regeln stehen.
  const cfgApi = await getJson('/api/config');
  const stale = JSON.parse(JSON.stringify(cfgApi.config));
  stale.schedule = { ...stale.schedule, rules: [ruleA] };
  stale.keepalivePulseSec = 45;
  const save = await postJson('/api/config', { config: stale });
  assert.equal(save.status, 200, JSON.stringify(save.j));
  assert.deepEqual(manualIds((await getJson('/api/schedule')).rules), ['a', 'b']);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).keepalivePulseSec, 45);

  // 4. Export trägt die Regeln mit.
  const exported = await getJson('/api/config/export');
  assert.deepEqual(exported.schedule.rules.map((r) => r.id), ['a', 'b']);

  // 5. Neustart: Regeln aus der Ablage zurück.
  await stop();
  await start();
  assert.deepEqual(manualIds((await getJson('/api/schedule')).rules), ['a', 'b']);
});
