// test/docker-install-update.test.js — ../docker/install.sh als Update
// (2026-10-15, Christin: „ein Update auf die neue DVhub-Version bringt alles
// auf den neuesten Stand“). Ein zweiter Lauf behält die .env (Passwörter), zog
// aber die darin festgeschriebenen Versionen (EOS_TAG, TIMESCALE_TAG) nie nach.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');

function rig(envText, { raw = REPO } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-dinst-'));
  const bin = path.join(dir, 'bin');
  const inst = path.join(dir, 'inst');
  fs.mkdirSync(bin); fs.mkdirSync(inst);
  if (envText != null) fs.writeFileSync(path.join(inst, '.env'), envText);
  const log = path.join(dir, 'docker.log');
  // docker-Ersatz: compose version / pull / up / ps / inspect
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "docker $*" >> ${log}
case "$*" in
  "compose version --short") echo "2.29.1" ;;
  "compose ps -q dvhub") echo "cid1" ;;
  inspect*) echo "healthy" ;;
esac
exit 0
`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  const run = () => spawnSync('bash', [path.join(REPO, 'docker', 'install.sh'), '--dir', inst], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DVHUB_REPO_RAW: `file://${raw}` }, encoding: 'utf8',
  });
  const env = () => Object.fromEntries(fs.readFileSync(path.join(inst, '.env'), 'utf8').split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { dir, run, env };
}

const example = Object.fromEntries(fs.readFileSync(path.join(REPO, 'docker', '.env.example'), 'utf8').split('\n')
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

describe('docker/install.sh als Update', () => {
  it('alte Versionen werden auf die Vorgabe angehoben, Passwörter bleiben', () => {
    const r = rig('DB_ADMIN_PASSWORD=geheim1\nDVHUB_DB_PASSWORD=geheim2\nEOS_TAG=v0.4.0rc1\nTIMESCALE_TAG=2.25.2-pg17\nDVHUB_TAG=latest\n');
    try {
      const out = r.run();
      assert.equal(out.status, 0, out.stderr + out.stdout);
      const e = r.env();
      assert.equal(e.EOS_TAG, example.EOS_TAG);
      assert.equal(e.TIMESCALE_TAG, example.TIMESCALE_TAG);
      assert.equal(e.DB_ADMIN_PASSWORD, 'geheim1');
      assert.equal(e.DVHUB_DB_PASSWORD, 'geheim2');
    } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  });

  it('TimescaleDB wird nie abgesenkt und nicht über die PG-Hauptversion gewechselt', () => {
    for (const own of ['9.99.0-pg17', '2.25.2-pg16']) {
      const r = rig(`DB_ADMIN_PASSWORD=a\nDVHUB_DB_PASSWORD=b\nTIMESCALE_TAG=${own}\n`);
      try {
        assert.equal(r.run().status, 0);
        assert.equal(r.env().TIMESCALE_TAG, own, own);
      } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
    }
  });

  // T-0415 (1.0.10): Vanilla-EOS v0.4.0rc3 → DVhub-EOS. Git-Tag und Docker-Tag
  // unterscheiden sich (Präfix dvhub-eos-), das Repo wechselt auf den Fork.
  // Ohne EOS_IMAGE_TAG und EOS_REPO in .env zöge compose ein Image unter dem
  // Git-Tag, das es nicht gibt.
  it('Update von 1.0.9 (Vanilla rc3): EOS_REPO, EOS_TAG und EOS_IMAGE_TAG folgen der Vorgabe', () => {
    const r = rig('DB_ADMIN_PASSWORD=a\nDVHUB_DB_PASSWORD=b\nCOMPOSE_PROFILES=eos\nEOS_REPO=https://github.com/Akkudoktor-EOS/EOS.git\nEOS_TAG=v0.4.0rc3\nEOS_MEM_LIMIT=320m\nTIMESCALE_TAG=2.30.2-pg17\n');
    const envPath = path.join(r.dir, 'inst', '.env');
    fs.chmodSync(envPath, 0o600);
    try {
      const out = r.run();
      assert.equal(fs.statSync(envPath).mode & 0o777, 0o600, '.env behält 600 (Passwörter)');
      assert.equal(out.status, 0, out.stderr + out.stdout);
      const e = r.env();
      assert.ok(example.EOS_IMAGE_TAG, 'Vorgabe hat EOS_IMAGE_TAG');
      assert.equal(e.EOS_REPO, example.EOS_REPO);
      assert.equal(e.EOS_TAG, example.EOS_TAG);
      assert.equal(e.EOS_IMAGE_TAG, example.EOS_IMAGE_TAG);
      assert.equal(e.EOS_MEM_LIMIT, '320m', 'übrige Einstellungen bleiben');
      assert.match(out.stdout, /EOS: v0\.4\.0rc3 → dvhub-eos-/);
      // zweiter Lauf: nichts mehr zu tun, keine doppelten Zeilen
      assert.equal(r.run().status, 0);
      const text = fs.readFileSync(path.join(r.dir, 'inst', '.env'), 'utf8');
      for (const k of ['EOS_REPO', 'EOS_TAG', 'EOS_IMAGE_TAG']) assert.equal(text.split('\n').filter((l) => l.startsWith(`${k}=`)).length, 1, k);
    } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  });

  it('Rückweg: Vorgabe ohne EOS_IMAGE_TAG → Zeile fällt weg, compose nimmt wieder EOS_TAG', () => {
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-dinst-raw-'));
    fs.mkdirSync(path.join(raw, 'docker'));
    fs.copyFileSync(path.join(REPO, 'docker', 'compose.yml'), path.join(raw, 'docker', 'compose.yml'));
    fs.writeFileSync(path.join(raw, 'docker', '.env.example'), 'EOS_REPO=https://github.com/Akkudoktor-EOS/EOS.git\nEOS_TAG=v0.4.0rc3\n# EOS_IMAGE_TAG=0.4.0\n');
    const r = rig(`DB_ADMIN_PASSWORD=a\nDVHUB_DB_PASSWORD=b\nEOS_REPO=${example.EOS_REPO}\nEOS_TAG=${example.EOS_TAG}\nEOS_IMAGE_TAG=${example.EOS_IMAGE_TAG}\n`, { raw });
    try {
      const out = r.run();
      assert.equal(out.status, 0, out.stderr + out.stdout);
      const e = r.env();
      assert.equal(e.EOS_REPO, 'https://github.com/Akkudoktor-EOS/EOS.git');
      assert.equal(e.EOS_TAG, 'v0.4.0rc3');
      assert.equal(e.EOS_IMAGE_TAG, undefined);
    } finally { fs.rmSync(r.dir, { recursive: true, force: true }); fs.rmSync(raw, { recursive: true, force: true }); }
  });

  it('DVHUB_PIN_VERSIONS=1 → eigene Versionen bleiben', () => {
    const r = rig('DB_ADMIN_PASSWORD=a\nDVHUB_DB_PASSWORD=b\nDVHUB_PIN_VERSIONS=1\nEOS_TAG=v0.4.0rc1\nTIMESCALE_TAG=2.25.2-pg17\n');
    try {
      assert.equal(r.run().status, 0);
      assert.equal(r.env().EOS_TAG, 'v0.4.0rc1');
      assert.equal(r.env().EOS_IMAGE_TAG, undefined, 'kein Docker-Tag dazu — compose nimmt EOS_TAG');
      assert.equal(r.env().TIMESCALE_TAG, '2.25.2-pg17');
    } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  });
});
