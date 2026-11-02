// test/config-file-modes.test.js -- Gegenprüfung d5655361 (P1, 2× P2):
//  P1 timescale-provision.sh flip_config_true folgte einem Verweis config.json
//     (node schrieb hinein, chown ohne -h) — die R-0001-Kette über einen
//     anderen root-Weg.
//  P2 Konfig-Migrationen schrieben config.json mit 0644 zurück; ihre
//     Sicherung (copyFileSync) ebenso.
//  P2 post-update.sh setzte nur config.json auf 0600, nicht die Sicherungen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../migration-runner.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tmpdir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-cfgmode-')));

function flip(cfgPath) {
  const s = read('timescale-provision.sh');
  const a = s.indexOf('flip_config_true() {');
  const b = s.indexOf('\n}\n', a) + 3;
  assert.ok(a > 0 && b > a);
  return spawnSync('bash', ['-c', `set -euo pipefail\nSERVICE_USER='${os.userInfo().username}'\nCONFIG_PATH='${cfgPath}'\n${s.slice(a, b)}\nflip_config_true`], { encoding: 'utf8' });
}

test('P1: timescale flip_config_true setzt den Schalter, 0600, folgt keinem Verweis', () => {
  const d = tmpdir();
  try {
    const cfg = path.join(d, 'config.json');
    fs.writeFileSync(cfg, '{"apiToken":"x"}\n', { mode: 0o644 });
    fs.chmodSync(cfg, 0o644);
    let r = flip(cfg);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).telemetry.database.timescaledb, true);
    assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
    const victim = path.join(d, 'opfer.json');
    fs.writeFileSync(victim, '{"fremd":1}\n');
    fs.chmodSync(victim, 0o644);
    const link = path.join(d, 'link.json');
    fs.symlinkSync(victim, link);
    r = flip(link);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(victim, 'utf8'), '{"fremd":1}\n');
    assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'Verweis bleibt, root schreibt nicht hindurch');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('P2: Konfig-Migration schreibt config.json und Sicherung mit 0600', async () => {
  const d = tmpdir();
  try {
    const cfg = path.join(d, 'config.json');
    fs.writeFileSync(cfg, '{"apiToken":"geheim"}\n', { mode: 0o644 });
    fs.chmodSync(cfg, 0o644);
    const r = await runMigrations(cfg);
    assert.ok(r.applied.length >= 1, JSON.stringify(r));
    assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
    const backups = fs.readdirSync(d).filter((f) => f.startsWith('config.backup-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.statSync(path.join(d, backups[0])).mode & 0o777, 0o600);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('P2: post-update.sh setzt auch Sicherungen der Konfiguration auf 0600', () => {
  const s = read('post-update.sh');
  const a = s.indexOf('# BEGIN DVHUB CONFIG DIRS'); const b = s.indexOf('# END DVHUB CONFIG DIRS');
  const step7 = s.slice(s.indexOf('# ── 7. Berechtigungen ──'), s.indexOf('# ── 8. systemd Service'));
  const d = tmpdir();
  try {
    for (const f of ['config.json', 'config.backup-2026-11-01T00-00-00.json', 'config.json.tmp']) {
      fs.writeFileSync(path.join(d, f), '{}', { mode: 0o644 });
      fs.chmodSync(path.join(d, f), 0o644);
    }
    // Eine Sicherung als Verweis: root folgt ihm nicht (Gegenprüfung 0923ac3d).
    const victim = path.join(d, 'opfer'); fs.writeFileSync(victim, 'x'); fs.chmodSync(victim, 0o644);
    fs.symlinkSync(victim, path.join(d, 'config.backup-2026-11-02T00-00-00.json'));
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = spawnSync('bash', ['-c', `set -euo pipefail\nSERVICE_USER='${os.userInfo().username}'\nCONFIG_DIR='${d}'\nCONFIG_PATH='${d}/config.json'\n${s.slice(a, b)}\n${step7}`], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['config.json', 'config.backup-2026-11-01T00-00-00.json', 'config.json.tmp']) assert.equal(fs.statSync(path.join(d, f)).mode & 0o777, 0o600, f);
    assert.equal(fs.statSync(victim).mode & 0o777, 0o644, 'Ziel des Verweises unberührt');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// Gegenprüfung 0923ac3d (P3): eine schon vorhandene .tmp mit 0644 darf ihren
// Modus nicht an die neue config.json vererben.
test('P2: Konfig-Migration mit vorhandener 0644-.tmp → config.json 0600', async () => {
  const d = tmpdir();
  try {
    const cfg = path.join(d, 'config.json');
    fs.writeFileSync(cfg, '{"apiToken":"geheim"}\n');
    fs.writeFileSync(`${cfg}.tmp`, 'alt'); fs.chmodSync(`${cfg}.tmp`, 0o644);
    await runMigrations(cfg);
    assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
