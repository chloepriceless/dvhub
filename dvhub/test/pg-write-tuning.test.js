// test/pg-write-tuning.test.js -- PostgreSQL-Schreib-Tuning bleibt idempotent.
// Review 25.10.2026 (P2): Ohne conf.d/timescaledb.conf entfernte das Skript die
// timescaledb.*-Zeile erst NACH dem Vergleich. Die Datei glich darum nie dem
// Soll, und jeder DVhub-Start schrieb sie neu und startete PostgreSQL neu.
// systemctl ist hier eine Attrappe, die ihre Aufrufe protokolliert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pg-write-tuning.sh');

function setup({ timescale = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-pgtune-'));
  const bin = join(dir, 'bin');
  const confDir = join(dir, 'postgresql', '17', 'main', 'conf.d');
  mkdirSync(bin, { recursive: true });
  mkdirSync(confDir, { recursive: true });
  if (timescale) writeFileSync(join(confDir, 'timescaledb.conf'), "shared_preload_libraries = 'timescaledb'\n");
  const log = join(dir, 'calls.log');
  const p = join(bin, 'systemctl');
  writeFileSync(p, `#!/usr/bin/env bash\necho "systemctl $*" >> "${log}"\n`);
  chmodSync(p, 0o755);
  const run = () => execFileSync('bash', [SCRIPT], {
    env: { PATH: `${bin}:${process.env.PATH}`, PG_TUNING_EUID: '0', PG_ETC: join(dir, 'postgresql') },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  const dropin = () => readFileSync(join(confDir, 'dvhub-writes.conf'), 'utf8');
  return { run, calls, dropin, confDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const timescale of [false, true]) {
  test(`${timescale ? 'mit' : 'ohne'} timescaledb.conf: zweiter Lauf schreibt nichts und startet nichts neu`, () => {
    const s = setup({ timescale });
    try {
      s.run();
      assert.deepEqual(s.calls(), ['systemctl restart postgresql'], 'erster Lauf: genau ein Neustart');
      const first = s.dropin();
      assert.equal(/^timescaledb\./m.test(first), timescale, 'timescaledb.* nur mit geladener Erweiterung');
      const out = s.run();
      assert.match(out, /Schreib-Tuning aktuell/);
      assert.deepEqual(s.calls(), ['systemctl restart postgresql'], 'zweiter Lauf: kein weiterer Neustart/Reload');
      assert.equal(s.dropin(), first);
    } finally { s.cleanup(); }
  });
}

test('Erweiterung kommt später dazu: Datei wird angepasst, genau ein weiterer Neustart', () => {
  const s = setup({ timescale: false });
  try {
    s.run();
    writeFileSync(join(s.confDir, 'timescaledb.conf'), "shared_preload_libraries = 'timescaledb'\n");
    s.run();
    assert.match(s.dropin(), /^timescaledb\.max_background_workers = /m);
    assert.deepEqual(s.calls(), ['systemctl restart postgresql', 'systemctl restart postgresql']);
    s.run();
    assert.equal(s.calls().length, 2, 'danach stabil');
  } finally { s.cleanup(); }
});
