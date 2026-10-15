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

function rig(envText) {
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DVHUB_REPO_RAW: `file://${REPO}` }, encoding: 'utf8',
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

  it('DVHUB_PIN_VERSIONS=1 → eigene Versionen bleiben', () => {
    const r = rig('DB_ADMIN_PASSWORD=a\nDVHUB_DB_PASSWORD=b\nDVHUB_PIN_VERSIONS=1\nEOS_TAG=v0.4.0rc1\nTIMESCALE_TAG=2.25.2-pg17\n');
    try {
      assert.equal(r.run().status, 0);
      assert.equal(r.env().EOS_TAG, 'v0.4.0rc1');
      assert.equal(r.env().TIMESCALE_TAG, '2.25.2-pg17');
    } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  });
});
