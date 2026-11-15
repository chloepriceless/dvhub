// test/sungrow-provision-script.test.js — Sungrow-Absicherung C2/C4 (M3, Feld 16.11.).
// Auf der Paket-Box fehlten nach dem Update ExecStopPost (sungrow-forced-release.mjs) und der Watchdog-Timer.
// sungrow-provision.sh hängt beides als Drop-in/Unit ein — nur für Sungrow-Anlagen; sonst räumt es auf.
// Getestet mit einer systemctl-Attrappe und einem überschreibbaren SYSTEMD_DIR (kein Root/echtes systemd nötig).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'sungrow-provision.sh');

function setup({ manufacturer = 'sungrow', optOut = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sg-prov-')));
  const data = path.join(dir, 'data');
  const app = path.join(dir, 'app');
  const bin = path.join(dir, 'bin');
  const sysd = path.join(dir, 'systemd');
  for (const d of [data, app, bin, sysd]) fs.mkdirSync(d, { recursive: true });
  const cfg = path.join(app, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ manufacturer, victron: { host: '192.0.2.5' } }));
  if (optOut) fs.writeFileSync(path.join(data, '.no-sungrow-watchdog'), '');
  const calls = path.join(dir, 'calls.log');
  // systemctl-Attrappe: protokolliert; is-enabled meldet aktiv, sobald der Timer existiert.
  fs.writeFileSync(path.join(bin, 'systemctl'), [
    '#!/usr/bin/env bash',
    'echo "systemctl $*" >> "$CALLS"',
    'if [[ "$1" == "is-enabled" ]]; then [[ -f "$SYSTEMD_DIR/dvhub-sungrow-watchdog.timer" ]] && exit 0 || exit 1; fi',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  // systemd-detect-virt: „none" (kein Container) — nie der Host-Wert.
  fs.writeFileSync(path.join(bin, 'systemd-detect-virt'), '#!/usr/bin/env bash\necho none\nexit 0\n', { mode: 0o755 });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    INSTALL_DIR: dir, APP_DIR: app, SERVICE_NAME: 'dvhub', DATA_DIR: data,
    DV_APP_CONFIG: cfg, SYSTEMD_DIR: sysd, NODE_BIN: '/usr/bin/node', CALLS: calls,
  };
  return { dir, data, app, sysd, calls, env };
}

const run = (env, args = []) => spawnSync('/bin/bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
const dropin = (sysd) => path.join(sysd, 'dvhub.service.d', 'sungrow-forced-release.conf');
const wdTimer = (sysd) => path.join(sysd, 'dvhub-sungrow-watchdog.timer');
const wdSvc = (sysd) => path.join(sysd, 'dvhub-sungrow-watchdog.service');

test('Sungrow-Anlage → ExecStopPost-Drop-in + Watchdog-Service/Timer werden angelegt und der Timer aktiviert', () => {
  const { sysd, calls, env } = setup({ manufacturer: 'sungrow' });
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(dropin(sysd)), 'Drop-in angelegt');
  const conf = fs.readFileSync(dropin(sysd), 'utf8');
  assert.match(conf, /ExecStopPost=.*scripts\/sungrow-forced-release\.mjs/);
  assert.match(conf, /Environment=DATA_DIR=/, 'DATA_DIR gesetzt (Merker im richtigen Verzeichnis)');
  assert.ok(fs.existsSync(wdSvc(sysd)), 'Watchdog-Service angelegt');
  const svc = fs.readFileSync(wdSvc(sysd), 'utf8');
  assert.match(svc, /sungrow-forced-watchdog\.mjs/);
  assert.ok(fs.existsSync(wdTimer(sysd)), 'Watchdog-Timer angelegt');
  assert.match(fs.readFileSync(wdTimer(sysd), 'utf8'), /OnUnitActiveSec=60s/);
  const log = fs.readFileSync(calls, 'utf8');
  assert.match(log, /daemon-reload/);
  assert.match(log, /enable --now dvhub-sungrow-watchdog\.timer/);
});

test('idempotent: zweiter Lauf ändert nichts (kein zweites daemon-reload nötig)', () => {
  const { sysd, env, dir } = setup({ manufacturer: 'sungrow' });
  run(env);
  const calls2 = path.join(dir, 'calls2.log');
  const r = run({ ...env, CALLS: calls2 });
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(dropin(sysd)));
  const log = fs.readFileSync(calls2, 'utf8');
  assert.doesNotMatch(log, /daemon-reload/, 'keine Unit-Änderung → kein daemon-reload');
});

test('keine Sungrow-Anlage → nichts eingehängt (und früheres Drop-in wird entfernt)', () => {
  // Erst als Sungrow einhängen, dann Hersteller wechseln → Aufräumen.
  const { sysd, app, env } = setup({ manufacturer: 'sungrow' });
  run(env);
  assert.ok(fs.existsSync(dropin(sysd)));
  fs.writeFileSync(path.join(app, 'config.json'), JSON.stringify({ manufacturer: 'victron' }));
  const r = run(env);
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(dropin(sysd)), 'Drop-in entfernt');
  assert.ok(!fs.existsSync(wdTimer(sysd)), 'Timer entfernt');
  assert.match(r.stdout, /keine Sungrow-Anlage/);
});

test('Opt-out (.no-sungrow-watchdog) → nichts eingehängt, auch bei Sungrow', () => {
  const { sysd, env } = setup({ manufacturer: 'sungrow', optOut: true });
  const r = run(env);
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(dropin(sysd)));
  assert.ok(!fs.existsSync(wdTimer(sysd)));
});

test('--check: read-only, legt nichts an', () => {
  const { sysd, env } = setup({ manufacturer: 'sungrow' });
  const r = run(env, ['--check']);
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(dropin(sysd)), 'check legt nichts an');
  assert.match(r.stdout, /Sungrow-Absicherung/);
});
