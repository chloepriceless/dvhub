// test/pg-write-tuning.test.js -- PostgreSQL-Schreib-Tuning bleibt idempotent.
// Review 25.10.2026 (P2): Ohne conf.d/timescaledb.conf entfernte das Skript die
// timescaledb.*-Zeile erst NACH dem Vergleich. Die Datei glich darum nie dem
// Soll, und jeder DVhub-Start schrieb sie neu und startete PostgreSQL neu.
// systemctl ist hier eine Attrappe, die ihre Aufrufe protokolliert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pg-write-tuning.sh');

function setup({ timescale = false, profile = undefined, symlink = false } = {}) {
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
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  if (profile !== undefined) {
    const f = join(dataDir, symlink ? 'echt.json' : 'storage-profile.json');
    writeFileSync(f, JSON.stringify({ version: 1, mode: 'auto', base: profile, effective: profile }, null, 2));
    if (symlink) symlinkSync(f, join(dataDir, 'storage-profile.json'));
  }
  const run = () => execFileSync('bash', [SCRIPT], {
    env: { PATH: `${bin}:${process.env.PATH}`, PG_TUNING_EUID: '0', PG_ETC: join(dir, 'postgresql'), DATA_DIR: dataDir },
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

// Speicher-Konzept S7 a (Christin 23.11.2026): Profil aus storage-profile.json.
test('Speicherprofil: „groß“ bzw. ohne Datei unverändert (kein max_wal_size), „klein“/„winzig“ kleiner', () => {
  const none = setup({});
  const gross = setup({ profile: 'gross' });
  const klein = setup({ profile: 'klein' });
  const winzig = setup({ profile: 'winzig' });
  try {
    none.run(); gross.run(); klein.run(); winzig.run();
    assert.equal(gross.dropin(), none.dropin(), '„groß“ = bisheriges Drop-in, kein Neustart-Anlass');
    assert.doesNotMatch(none.dropin(), /max_wal_size/);
    assert.match(none.dropin(), /^min_wal_size = 64MB$/m);
    assert.match(klein.dropin(), /^max_wal_size = 256MB$/m);
    assert.match(winzig.dropin(), /^max_wal_size = 128MB$/m);
    assert.match(winzig.dropin(), /^min_wal_size = 32MB$/m);
  } finally { none.cleanup(); gross.cleanup(); klein.cleanup(); winzig.cleanup(); }
});

test('Speicherprofil: unbekannter Name oder Verweis wird ignoriert', () => {
  const bad = setup({ profile: 'riesig' });
  const link = setup({ profile: 'winzig', symlink: true });
  try {
    bad.run(); link.run();
    assert.doesNotMatch(bad.dropin(), /max_wal_size/);
    assert.doesNotMatch(link.dropin(), /max_wal_size/, 'Verweis nicht verfolgt');
  } finally { bad.cleanup(); link.cleanup(); }
});
