// test/dvhub-apt-setcap-helper.test.js -- root-eigene Einstiege dvhub-apt.sh
// und dvhub-setcap.sh.
// Gegenprüfung 25.10.2026 (P2): `apt-get update *`, `apt-get upgrade *`,
// `apt list *`, `fuser *` und `setcap *` in den sudoers ließen beliebige
// Argumente zu — `apt-get update -o APT::Update::Pre-Invoke::=…` führt einen
// Befehl als root aus, `setcap cap_dac_override+ep <kopie von cp>` hebelt jede
// Dateiberechtigung aus. Jetzt gibt es nur feste Aktionen; apt-get, apt, fuser
// und setcap sind hier Attrappen, die ihre Argumente aufschreiben.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APT = join(ROOT, 'dvhub-apt.sh');
const SETCAP = join(ROOT, 'dvhub-setcap.sh');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-aptcap-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  for (const name of ['apt-get', 'apt', 'fuser', 'setcap']) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $* LC_ALL=$LC_ALL" >> "${log}"\nexit "\${FAKE_RC:-0}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const run = (script, args, env = {}) => spawnSync('bash', [script, ...args], {
    encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, DVHUB_HELPER_TEST_EUID: '0', ...env },
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, run, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('dvhub-apt: jede Aktion ruft genau den bisherigen Befehl auf (englische Ausgabe)', () => {
  const s = sandbox();
  try {
    for (const a of ['refresh', 'list-upgradable', 'upgrade-all', 'upgrade-security', 'lock-held']) {
      assert.equal(s.run(APT, [a]).status, 0, a);
    }
    assert.deepEqual(s.calls(), [
      'apt-get update -qq LC_ALL=C',
      'apt list --upgradable LC_ALL=C',
      'apt-get upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold LC_ALL=C',
      'apt-get -y -o Dir::Etc::SourceList=/etc/apt/sources.list -o Dir::Etc::SourceParts=/etc/apt/security.sources.list.d -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade LC_ALL=C',
      'fuser /var/lib/dpkg/lock-frontend LC_ALL=C',
    ]);
  } finally { s.cleanup(); }
});

test('dvhub-apt: Exit-Code des Programms kommt durch (lock-held: 1 = keine Sperre)', () => {
  const s = sandbox();
  try {
    assert.equal(s.run(APT, ['lock-held'], { FAKE_RC: '1' }).status, 1);
  } finally { s.cleanup(); }
});

test('dvhub-apt: alles andere → Exit 2, kein apt-Aufruf', () => {
  const s = sandbox();
  try {
    for (const args of [[], ['update'], ['refresh', '-o', 'APT::Update::Pre-Invoke::=id'], ['upgrade-all', '-o', 'DPkg::Pre-Invoke::=id'],
      ['install', 'x'], ['-o', 'x'], ['list-upgradable', '--all-versions'], ['lock-held', '/etc/shadow'], ['refresh;id']]) {
      const r = s.run(APT, args);
      assert.equal(r.status, 2, `${JSON.stringify(args)} → ${r.status} ${r.stderr}`);
    }
    assert.deepEqual(s.calls(), []);
  } finally { s.cleanup(); }
});

test('dvhub-apt: ohne root Abbruch', () => {
  const s = sandbox();
  try {
    assert.notEqual(s.run(APT, ['refresh'], { DVHUB_HELPER_TEST_EUID: '1000' }).status, 0);
    assert.deepEqual(s.calls(), []);
  } finally { s.cleanup(); }
});

function nodeBin(s, { mode = 0o755 } = {}) {
  const d = join(s.dir, 'usr-bin');
  mkdirSync(d, { recursive: true });
  const real = join(d, 'node22');
  writeFileSync(real, '#!/bin/sh\n');
  chmodSync(real, mode);
  const link = join(d, 'node');
  symlinkSync(real, link);
  return { real, link };
}

test('dvhub-setcap node: genau cap_net_bind_service=+ep auf die aufgelöste node-Datei', () => {
  const s = sandbox();
  try {
    const { real, link } = nodeBin(s);
    const owner = String(process.getuid());
    const r = s.run(SETCAP, ['node'], { DVHUB_HELPER_TEST_NODE: link, DVHUB_HELPER_TEST_OWNER_UID: owner });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.calls(), [`setcap cap_net_bind_service=+ep ${realpathSync(real)} LC_ALL=C`]);
  } finally { s.cleanup(); }
});

test('dvhub-setcap: andere Argumente, fremde oder beschreibbare Dateien → abgelehnt', () => {
  const s = sandbox();
  try {
    const { link } = nodeBin(s);
    const env = { DVHUB_HELPER_TEST_NODE: link, DVHUB_HELPER_TEST_OWNER_UID: String(process.getuid()) };
    for (const args of [[], ['cap_dac_override+ep', '/tmp/cp'], ['node', '/tmp/cp'], ['-r', 'node'], ['nodejs']]) {
      assert.equal(s.run(SETCAP, args, env).status, 2, JSON.stringify(args));
    }
    // Datei gehört nicht root (hier: nicht der erwarteten UID)
    assert.equal(s.run(SETCAP, ['node'], { ...env, DVHUB_HELPER_TEST_OWNER_UID: '4242' }).status, 3);
    // für andere beschreibbar
    const w = nodeBin({ dir: join(s.dir, 'w') }, { mode: 0o777 });
    assert.equal(s.run(SETCAP, ['node'], { ...env, DVHUB_HELPER_TEST_NODE: w.link }).status, 3);
    // keine node-Datei
    const cp = join(s.dir, 'cp');
    writeFileSync(cp, '#!/bin/sh\n'); chmodSync(cp, 0o755);
    assert.equal(s.run(SETCAP, ['node'], { ...env, DVHUB_HELPER_TEST_NODE: cp }).status, 3);
    assert.deepEqual(s.calls(), []);
  } finally { s.cleanup(); }
});
