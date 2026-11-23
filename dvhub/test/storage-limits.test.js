// test/storage-limits.test.js — journald nach Speicherprofil (Speicher-Konzept
// 23.11.2026, S8 a: nur „klein“/„winzig“). systemctl ist eine Attrappe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'storage-limits.sh');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-slim-'));
  const bin = join(dir, 'bin'); const data = join(dir, 'data'); const conf = join(dir, 'journald.conf.d');
  mkdirSync(bin); mkdirSync(data);
  const log = join(dir, 'calls.log');
  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "systemctl $*" >> "${log}"\n`);
  chmodSync(join(bin, 'systemctl'), 0o755);
  const profile = (p, { link = false } = {}) => {
    const f = join(data, link ? 'echt.json' : 'storage-profile.json');
    writeFileSync(f, JSON.stringify({ version: 1, base: p, effective: p }, null, 2));
    if (link) symlinkSync(f, join(data, 'storage-profile.json'));
  };
  const run = () => execFileSync('bash', [SCRIPT], {
    env: { PATH: `${bin}:${process.env.PATH}`, STORAGE_LIMITS_EUID: '0', DATA_DIR: data, JOURNALD_CONF_DIR: conf }, encoding: 'utf8',
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  const dropin = () => (existsSync(join(conf, '90-dvhub-speicherprofil.conf')) ? readFileSync(join(conf, '90-dvhub-speicherprofil.conf'), 'utf8') : null);
  return { dir, conf, profile, run, calls, dropin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('„klein“: 200 MB, idempotent (kein zweiter Neustart); „winzig“: 100 MB', () => {
  const s = setup();
  try {
    s.profile('klein');
    s.run();
    assert.match(s.dropin(), /^\[Journal\]$/m);
    assert.match(s.dropin(), /^SystemMaxUse=200M$/m);
    assert.deepEqual(s.calls(), ['systemctl restart systemd-journald']);
    assert.match(s.run(), /aktuell/);
    assert.equal(s.calls().length, 1, 'kein weiterer Neustart');
    s.profile('winzig');
    s.run();
    assert.match(s.dropin(), /^SystemMaxUse=100M$/m);
  } finally { s.cleanup(); }
});

test('groß/mittel/ohne Profil: keine Grenze; eigene Datei wird entfernt, fremde nie', () => {
  const s = setup();
  try {
    s.run();
    assert.equal(s.dropin(), null);
    assert.deepEqual(s.calls(), []);
    s.profile('klein'); s.run();
    s.profile('mittel'); s.run();
    assert.equal(s.dropin(), null, 'zurück auf mittel: eigene Grenze weg');
    mkdirSync(s.conf, { recursive: true });
    writeFileSync(join(s.conf, '90-dvhub-speicherprofil.conf'), '[Journal]\nSystemMaxUse=1G\n');
    s.run();
    assert.equal(s.dropin(), '[Journal]\nSystemMaxUse=1G\n', 'fremde Datei bleibt');
    // Codex 2739f099: auch bei „klein“ keine fremde Datei überschreiben.
    s.profile('klein');
    s.run();
    assert.equal(s.dropin(), '[Journal]\nSystemMaxUse=1G\n', 'fremde Datei bleibt auch bei klein');
    writeFileSync(join(s.conf, 'dvhub.conf'), '[Journal]\nMaxRetentionSec=1week\n');
    rmSync(join(s.conf, '90-dvhub-speicherprofil.conf'));
    s.run();
    assert.match(s.dropin(), /SystemMaxUse=200M/);
    assert.equal(readFileSync(join(s.conf, 'dvhub.conf'), 'utf8'), '[Journal]\nMaxRetentionSec=1week\n', 'andere Datei unberührt');
  } finally { s.cleanup(); }
});

test('Verweis auf die Profildatei wird nicht verfolgt', () => {
  const s = setup();
  try {
    s.profile('winzig', { link: true });
    s.run();
    assert.equal(s.dropin(), null);
  } finally { s.cleanup(); }
});

// Codex 3e530edf: frühere eigene Datei dvhub.conf (mit Kennzeile) wird mitgenommen.
test('frühere eigene dvhub.conf wird entfernt, auch beim Wechsel auf „groß“', () => {
  const s = setup();
  try {
    mkdirSync(s.conf, { recursive: true });
    writeFileSync(join(s.conf, 'dvhub.conf'), '# DVhub: Speicherprofil klein (storage-limits.sh).\n[Journal]\nSystemMaxUse=200M\n');
    s.profile('gross');
    s.run();
    assert.equal(existsSync(join(s.conf, 'dvhub.conf')), false);
    assert.deepEqual(s.calls(), ['systemctl restart systemd-journald']);
  } finally { s.cleanup(); }
});
