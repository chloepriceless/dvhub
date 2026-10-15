// test/stack-update.test.js — ../stack-update.sh mit Ersatzprogrammen im PATH
// (2026-10-15). Spielt eine native Box nach: apt/dpkg mit Versionsständen,
// su/psql mit TimescaleDB-Versionen, systemctl protokolliert.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', 'stack-update.sh');

function rig({ pkgs, upgrades = {}, ext = '2.28.2', bin = '2.30.2', alterFails = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-stack-'));
  const bindir = path.join(dir, 'bin');
  const data = path.join(dir, 'data');
  fs.mkdirSync(bindir); fs.mkdirSync(data);
  const state = path.join(dir, 'state');
  fs.writeFileSync(path.join(state + '.pkgs'), Object.entries(pkgs).map(([p, v]) => `${p}=${v}`).join('\n') + '\n');
  fs.writeFileSync(state + '.upgrades', Object.entries(upgrades).map(([p, v]) => `${p}=${v}`).join('\n') + '\n');
  fs.writeFileSync(state + '.ext', ext);
  const log = path.join(dir, 'calls.log');
  const w = (name, body) => { fs.writeFileSync(path.join(bindir, name), `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(path.join(bindir, name), 0o755); };
  w('pg_lsclusters', 'echo "17 main 5432 online postgres /var/lib/postgresql/17/main"');
  w('psql', 'exit 0');
  w('systemctl', `echo "systemctl $*" >> ${log}; exit 0`);
  w('dpkg-query', `
if [[ "$2" == '-f=\${Status}' ]]; then grep -q "^$3=" ${state}.pkgs && echo "install ok installed"; exit 0; fi
shift 2; for p in "$@"; do grep "^$p=" ${state}.pkgs; done`);
  w('apt-get', `
echo "apt-get $*" >> ${log}
if [[ "$1" == install ]]; then
  while IFS='=' read -r p v; do [[ -z "$p" ]] && continue
    grep -q "^$p=" ${state}.pkgs && sed -i.bak "s/^$p=.*/$p=$v/" ${state}.pkgs
  done < ${state}.upgrades
fi
exit 0`);
  w('su', `
cmd="$3"
if [[ "$cmd" == *"FROM pg_extension WHERE extname"* ]]; then cat ${state}.ext; exit 0; fi
if [[ "$cmd" == *"pg_available_extensions"* ]]; then echo "${bin}"; exit 0; fi
if [[ "$cmd" == *"ALTER EXTENSION"* ]]; then echo "ALTER" >> ${log}; ${alterFails ? 'exit 1' : `echo -n ${bin} > ${state}.ext; exit 0`}; fi
exit 0`);
  const env = { ...process.env, PATH: `${bindir}:${process.env.PATH}`, STACK_UPDATE_ALLOW_NONROOT: '1',
    INSTALL_DIR: path.join(dir, 'install'), DATA_DIR: data, SERVICE_NAME: 'dvhub', STACK_UPDATE_VERSION: '1.0.8@abc' };
  const run = () => spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const status = () => JSON.parse(fs.readFileSync(path.join(data, 'stack-update.json'), 'utf8'));
  return { dir, run, calls, status };
}

describe('stack-update.sh', () => {
  it('Node.js-Update + veraltete Erweiterung: Pakete, PG neu, ALTER, PG neu, DVhub neu', () => {
    const r = rig({ pkgs: { nodejs: '22.20.0-1', 'postgresql-17': '17.5-1', openvpn: '2.6.3-1' }, upgrades: { nodejs: '22.23.3-1' } });
    try {
      const out = r.run();
      assert.equal(out.status, 0, out.stderr);
      const c = r.calls();
      const i = (s) => c.findIndex((x) => x.startsWith(s));
      assert.ok(c.some((x) => x.startsWith('apt-get install -y --only-upgrade') && x.includes('nodejs') && x.includes('postgresql-17')), c.join('\n'));
      assert.equal(c.filter((x) => x === 'ALTER').length, 1);
      const pgRestarts = c.map((x, n) => (x === 'systemctl restart postgresql.service' ? n : -1)).filter((n) => n >= 0);
      assert.equal(pgRestarts.length, 2);
      assert.ok(pgRestarts[0] < c.indexOf('ALTER') && c.indexOf('ALTER') < pgRestarts[1], 'ALTER zwischen den beiden Neustarts');
      assert.ok(i('systemctl restart dvhub.service') > pgRestarts[1], 'DVhub zuletzt');
      const s = r.status();
      assert.equal(s.changedPackages, 'nodejs=22.23.3-1');
      assert.deepEqual(s.timescale, { from: '2.28.2', to: '2.30.2', result: 'updated' });
      assert.equal(s.restartedDvhub, 1);
      assert.equal(s.version, '1.0.8@abc');
      assert.equal(s.errors, '');
    } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  });

  it('alles aktuell: keine Neustarts, Erweiterung „current“', () => {
    const r = rig({ pkgs: { nodejs: '22.23.3-1', 'postgresql-17': '17.6-1' }, ext: '2.30.2', bin: '2.30.2' });
    try {
      assert.equal(r.run().status, 0);
      assert.equal(r.calls().some((x) => x.startsWith('systemctl restart')), false, r.calls().join('\n'));
      assert.equal(r.status().timescale.result, 'current');
      assert.equal(r.status().restartedDvhub, 0);
    } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  });

  it('ALTER scheitert: Fehler im Status, kein DVhub-Neustart, Exit 0', () => {
    const r = rig({ pkgs: { nodejs: '22.23.3-1' }, alterFails: true });
    try {
      assert.equal(r.run().status, 0);
      const s = r.status();
      assert.equal(s.timescale.result, 'failed');
      assert.match(s.errors, /alter-extension/);
      assert.equal(r.calls().includes('systemctl restart dvhub.service'), false);
    } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  });
});
