// test/release-build.test.js — Bau der Release-Pakete (docs/release-pakete.md):
// Allowlist, deterministisches tar, Version, Manifest, Abhängigkeits-Prüfung,
// Kanal-Index und ein vollständiger Lauf von build-release.sh auf einem
// Wegwerf-Repo (zweimal → gleiche Bytes, signiert, Allowlist wirkt).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseAllowlist, isAllowed, createTar, readTar, gzipDeterministic, computeReleaseVersion, compareVersions,
  packTree, buildManifest, checkDependencies, mergeIndex, validateIndex, referencedScripts, changelogSection,
  MANIFEST_NAME, sha256,
} from '../scripts/release/lib/release-lib.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD = path.join(repoRoot, 'scripts/release/build-release.sh');
const ALLOWLIST = path.join(repoRoot, 'scripts/release/allowlist.txt');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('Allowlist: alles verboten, gezielt erlaubt, letzte Regel gewinnt', () => {
  const rules = parseAllowlist(fs.readFileSync(ALLOWLIST, 'utf8'));
  const yes = ['dvhub/server.js', 'dvhub/public/index.html', 'dvhub/hersteller/victron.json', 'dvhub/db/migrations/001-vrm-forecasts-unique.sql',
    'dvhub/package-lock.json', 'post-update.sh', 'eos-provision.sh', 'eos-version.env', 'dvhub-update.sh', 'dvhub-release.cjs',
    'scripts/reconcile-vendor-profiles.mjs', 'release-keys/allowed_signers', 'LICENSE.md', 'dvhub/eebus/go/main.go',
    'dvhub/python/requirements.lock', 'dvhub/services/python-bridge/scripts/pv_forecast.py', 'eos-patches/apply.sh'];
  const no = ['dvhub/test/foo.test.js', 'dvhub/docs/ABREGELUNG-ERKLAERT.md', 'dvhub/node_modules/x/index.js', 'dvhub/eslint.config.js',
    'dvhub/eebus/go/main_test.go', 'dvhub/eebus/go/testdata/fixtures/openssl-key.pem', 'dvhub/eebus/test/interop.py',
    'dvhub/services/python-bridge/scripts/tests/test_x.py', 'dvhub/config.json', 'dvhub/foo.log', 'test/install-script.test.js',
    'tests/csp-lint.mjs', '.github/workflows/ci.yml', 'docs/API.md', 'assets/logo.png', 'install.sh', 'Dockerfile', 'docker/compose.yml',
    'installer-portal/server.js', 'support-relay/x.js', 'README.md', '.gitignore', 'db/telemetry.sqlite', 'scripts/deploy-test.sh',
    'dvhub/scripts/probe-pvnode-headers.js', '.planning/x.md'];
  for (const p of yes) assert.ok(isAllowed(p, rules), `sollte im Paket sein: ${p}`);
  for (const p of no) assert.ok(!isAllowed(p, rules), `darf nicht ins Paket: ${p}`);
  assert.throws(() => parseAllowlist('dvhub/'), /erwartet/);
});

// Werkzeuge, die die Doku auf der Box aufrufen lässt (docs/HERSTELLERPROFIL-
// MIGRIEREN.md: cd /opt/dvhub; node scripts/vendor-profile-diff.mjs …) —
// fehlten sie im Paket, gäbe es den Befehl nach der Umstellung nicht mehr
// (Gesamtprüfung 03.11.2026).
test('Allowlist: Box-Werkzeuge aus der Doku sind im Paket', () => {
  const rules = parseAllowlist(fs.readFileSync(ALLOWLIST, 'utf8'));
  for (const p of ['scripts/vendor-profile-diff.mjs', 'scripts/reconcile-vendor-profiles.mjs']) {
    assert.ok(isAllowed(p, rules), `fehlt im Paket: ${p}`);
  }
});

test('Allowlist deckt alle Skripte ab, die post-update.sh und install.sh aufrufen', () => {
  const rules = parseAllowlist(fs.readFileSync(ALLOWLIST, 'utf8'));
  const refs = new Set([
    ...referencedScripts(fs.readFileSync(path.join(repoRoot, 'post-update.sh'), 'utf8')),
    ...referencedScripts(fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8')),
  ]);
  assert.ok(refs.has('eos-provision.sh') && refs.has('dvhub-update.sh') && refs.has('dvhub-release.cjs'), [...refs].join(','));
  for (const r of refs) {
    if (!fs.existsSync(path.join(repoRoot, r))) continue;
    assert.ok(isAllowed(r, rules), `aufgerufen, aber nicht in der Allowlist: ${r}`);
  }
});

test('tar: sortiert, root/0, feste Zeit und Modi, lange Pfade über PAX, Rundreise', () => {
  const long = `dvhub/node_modules/${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(120)}.js`;
  const entries = [
    { path: 'z.sh', type: 'file', mode: 0o700, data: Buffer.from('#!/bin/sh\n') },
    { path: 'a', type: 'dir' },
    { path: 'a/x.txt', type: 'file', mode: 0o666, data: Buffer.from('x') },
    { path: long, type: 'file', mode: 0o644, data: Buffer.from('lang') },
    { path: 'a/link', type: 'symlink', linkname: 'x.txt' },
  ];
  const t1 = createTar(entries, { mtime: 1700000000 });
  const t2 = createTar([...entries].reverse(), { mtime: 1700000000 });
  assert.ok(t1.equals(t2), 'Reihenfolge der Eingabe darf nicht zählen');
  assert.equal(t1.length % 10240, 0);
  const back = readTar(t1);
  assert.deepEqual(back.map((e) => e.path), ['a', 'a/link', 'a/x.txt', long, 'z.sh']);
  for (const e of back) {
    assert.equal(e.uid, 0); assert.equal(e.gid, 0); assert.equal(e.uname, 'root'); assert.equal(e.mtime, 1700000000);
  }
  assert.equal(back.find((e) => e.path === 'z.sh').mode, 0o755);
  assert.equal(back.find((e) => e.path === 'a/x.txt').mode, 0o644);
  assert.equal(back.find((e) => e.path === 'a/link').linkname, 'x.txt');
  assert.equal(back.find((e) => e.path === long).data.toString(), 'lang');
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a//b']) {
    assert.throws(() => createTar([{ path: bad, type: 'file', data: Buffer.from('') }], { mtime: 0 }), /ungültiger Pfad/);
  }
});

test('tar wird von GNU/BSD tar gelesen (Modi, Symlink, langer Pfad)', () => {
  const dir = tmp('dvhub-tar-');
  try {
    const long = `n/${'d'.repeat(90)}/${'e'.repeat(90)}/f.js`;
    const gz = gzipDeterministic(createTar([
      { path: 'run.sh', type: 'file', mode: 0o755, data: Buffer.from('#!/bin/sh\necho hi\n') },
      { path: long, type: 'file', mode: 0o644, data: Buffer.from('ok') },
      { path: 'l', type: 'symlink', linkname: 'run.sh' },
    ], { mtime: 1700000000 }));
    assert.equal(gz[9], 3, 'gzip-OS-Byte Unix');
    assert.equal(gz.readUInt32LE(4), 0, 'gzip ohne Zeitstempel');
    fs.writeFileSync(path.join(dir, 'p.tar.gz'), gz);
    fs.mkdirSync(path.join(dir, 'x'));
    const r = spawnSync('tar', ['-xzf', path.join(dir, 'p.tar.gz'), '-C', path.join(dir, 'x')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'x', long), 'utf8'), 'ok');
    assert.ok(fs.statSync(path.join(dir, 'x/run.sh')).mode & 0o100);
    assert.equal(fs.readlinkSync(path.join(dir, 'x/l')), 'run.sh');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Version: Tag → stable (muss zu package.json passen), sonst dev mit Commit-Zeit und SHA', () => {
  const sha = 'c7a245a1fb36057044a6faed4f002e1c4dad103a';
  assert.deepEqual(computeReleaseVersion({ tag: 'v1.0.9', pkgVersion: '1.0.9', commitTime: 0, sha }), { version: '1.0.9', channel: 'stable' });
  assert.throws(() => computeReleaseVersion({ tag: 'v1.0.9', pkgVersion: '1.0.8', commitTime: 0, sha }), /passt nicht/);
  assert.deepEqual(computeReleaseVersion({ tag: '', pkgVersion: '1.0.8', commitTime: 1761582084, sha }),
    { version: '1.0.8-dev.20251027162124.c7a245a1', channel: 'dev' });
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.8-dev.20261027162124.c7a245a1', '1.0.8'), -1);
  assert.equal(compareVersions('1.0.8-dev.20261028000000.aaaaaaaa', '1.0.8-dev.20261027162124.c7a245a1'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
});

test('Manifest: alle Dateien mit sha256, Größe, Modus; Symlinks mit Ziel; ohne sich selbst', () => {
  const m = buildManifest({
    entries: [
      { path: 'a.sh', type: 'file', mode: 0o755, data: Buffer.from('x') },
      { path: 'd', type: 'dir' },
      { path: 'd/l', type: 'symlink', linkname: '../a.sh' },
      { path: MANIFEST_NAME, type: 'file', mode: 0o644, data: Buffer.from('{}') },
    ],
    meta: { version: '1.0.9', arch: 'arm64' },
  });
  assert.equal(m.version, '1.0.9');
  assert.deepEqual(m.files, [
    { path: 'a.sh', sha256: sha256(Buffer.from('x')), size: 1, mode: '0755' },
    { path: 'd/l', type: 'symlink', target: '../a.sh' },
  ]);
});

test('packTree lehnt Symlinks ab, die aus dem Paket zeigen', () => {
  const dir = tmp('dvhub-pack-');
  try {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    fs.symlinkSync('/etc/passwd', path.join(dir, 'bad'));
    assert.throws(() => packTree(dir, { mtime: 0, meta: {} }), /zeigt aus dem Paket/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Gegenprüfung eb012ce8 (P3): der Bau muss ablehnen, was die Box ablehnt
// (dvhub-release.cjs verifyTree) — sonst wäre ein signiertes Paket auf jeder
// Box uninstallierbar. Ziel über einen anderen Symlink des Pakets hinweg.
test('packTree lehnt Symlink-Ziele über einen anderen Paket-Symlink ab (wie die Box)', () => {
  for (const make of [
    (dir) => { fs.symlinkSync('.', path.join(dir, 'p')); fs.symlinkSync('p/../etc', path.join(dir, 'q')); },
    (dir) => { fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/lib/foo.js'), 'x');
      fs.symlinkSync('src/lib', path.join(dir, 'lib')); fs.symlinkSync('lib/foo.js', path.join(dir, 'x')); },
  ]) {
    const dir = tmp('dvhub-pack-');
    try {
      fs.writeFileSync(path.join(dir, 'a'), 'a');
      make(dir);
      assert.throws(() => packTree(dir, { mtime: 0, meta: {} }), /zeigt aus dem Paket/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const ok = tmp('dvhub-pack-');
  try {
    fs.mkdirSync(path.join(ok, 'nm/.bin'), { recursive: true });
    fs.mkdirSync(path.join(ok, 'nm/pkg/bin'), { recursive: true });
    fs.writeFileSync(path.join(ok, 'nm/pkg/bin/cli.js'), 'x');
    fs.symlinkSync('../pkg/bin/cli.js', path.join(ok, 'nm/.bin/cli'));
    packTree(ok, { mtime: 0, meta: {} });
  } finally { fs.rmSync(ok, { recursive: true, force: true }); }
});

test('Abhängigkeiten: Install-Skripte, os/cpu und native Module schlagen an', () => {
  const dir = tmp('dvhub-deps-');
  try {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ packages: {
      '': {}, 'node_modules/ok': {}, 'node_modules/dev': { dev: true, hasInstallScript: true },
      'node_modules/bad': { hasInstallScript: true }, 'node_modules/plat': { os: ['linux'] },
    } }));
    fs.mkdirSync(path.join(dir, 'node_modules/n/build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/n/build/x.node'), '');
    fs.writeFileSync(path.join(dir, 'node_modules/n/package.json'), JSON.stringify({ name: 'n', scripts: { postinstall: 'node x' } }));
    const p = checkDependencies(dir).join('\n');
    assert.match(p, /node_modules\/bad: hasInstallScript/);
    assert.match(p, /node_modules\/plat: os\/cpu/);
    assert.match(p, /x\.node: natives Modul/);
    assert.match(p, /scripts\.postinstall/);
    assert.doesNotMatch(p, /node_modules\/dev:/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Die echten Produktionsabhängigkeiten sind architekturneutral (Lockfile)', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dvhub/package-lock.json'), 'utf8'));
  const bad = Object.entries(lock.packages).filter(([k, p]) => k && !p.dev && (p.hasInstallScript || p.os || p.cpu));
  assert.deepEqual(bad.map(([k]) => k), []);
});

test('Kanal-Index: einfügen, absteigend, latest, Prüfung', () => {
  const art = (v) => ({ arm64: { url: `../v${v}/dvhub-${v}-arm64.tar.gz`, sha256: 'a'.repeat(64), size: 10, sig: `../v${v}/x.sig` } });
  let idx = mergeIndex(null, { channel: 'stable', release: { version: '1.0.9', date: 'd1', artifacts: art('1.0.9') } });
  idx = mergeIndex(idx, { channel: 'stable', release: { version: '1.0.10', date: 'd2', artifacts: art('1.0.10') } });
  idx = mergeIndex(idx, { channel: 'stable', release: { version: '1.0.9', date: 'd1', artifacts: art('1.0.9') } });
  assert.equal(idx.latest, '1.0.10');
  assert.deepEqual(idx.releases.map((r) => r.version), ['1.0.10', '1.0.9']);
  validateIndex(idx, 'stable');
  assert.throws(() => validateIndex(idx, 'dev'), /Kanal/);
  assert.throws(() => validateIndex({ ...idx, releases: [{ version: '1.0.9', artifacts: { arm64: { url: 'x', sig: 'y', size: 1, sha256: 'kurz' } } }] }, 'stable'), /sha256/);
  const kept = [1, 2, 3, 4].reduce((acc, n) => mergeIndex(acc, { channel: 'dev', release: { version: `1.0.8-dev.2026102${n}000000.aaaaaaa${n}`, artifacts: {} }, keep: 3 }), null);
  assert.equal(kept.releases.length, 3);
  assert.equal(kept.latest, '1.0.8-dev.20261024000000.aaaaaaa4');
});

test('CHANGELOG-Abschnitt für den Index', () => {
  const text = '## [Unreleased]\n- neu\n\n## [1.0.9] - 2026-11-01\n\nText\n\n- **Fett**: mit `code` und [Link](http://x)\n  Folgezeile\n- zweiter Punkt\n\n## [1.0.8]\n- alt\n';
  assert.deepEqual(changelogSection(text, '1.0.9'), ['Fett: mit code und Link Folgezeile', 'zweiter Punkt']);
  // Zweiter Absatz nach Leerzeile: kein „null …“-Eintrag (Gegenprüfung 7adccd58).
  assert.deepEqual(changelogSection('## [3.0.0]\n\n- a\n  weiter\n\n  Absatz\n- b\n', '3.0.0'), ['a weiter', 'b']);
  // Lange, umbrochene Punkte werden an einer Wortgrenze gekürzt, nicht mitten im Wort.
  const long = `## [2.0.0]\n\n- **Titel**: ${'Wort '.repeat(30)}\n  ${'weiter '.repeat(20)}\n`;
  const [one] = changelogSection(long, '2.0.0');
  assert.ok(one.length <= 160 && one.endsWith('…') && /(Wort|weiter)…$/.test(one), one);
  assert.deepEqual(changelogSection(text, '9.9.9'), []);
});

// ── build-release.sh auf einem Wegwerf-Repo ──────────────────────────────────

function fixtureRepo() {
  const dir = tmp('dvhub-build-repo-');
  const w = (p, c, mode) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); if (mode) fs.chmodSync(path.join(dir, p), mode); };
  w('dvhub/package.json', JSON.stringify({ name: 'dvhub', version: '1.2.3', type: 'module', engines: { node: '>=22.0.0' } }));
  w('dvhub/package-lock.json', JSON.stringify({ name: 'dvhub', version: '1.2.3', lockfileVersion: 3, requires: true, packages: { '': { name: 'dvhub', version: '1.2.3' } } }));
  w('dvhub/server.js', 'console.log("hi")\n');
  w('dvhub/public/index.html', '<!doctype html>\n');
  w('dvhub/test/a.test.js', 'nein\n');
  w('dvhub/eslint.config.js', 'nein\n');
  w('post-update.sh', '#!/usr/bin/env bash\nbash "$INSTALL_DIR/eos-provision.sh"\n', 0o755);
  w('eos-provision.sh', '#!/usr/bin/env bash\n', 0o755);
  w('eos-version.env', 'EOS_REPO_URL=https://example.invalid/eos.git\nEOS_PIN=v0.4.0rc3\n');
  w('.node-version', '22\n');
  w('README.md', 'nein\n');
  w('tests/x.mjs', 'nein\n');
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-27T16:21:24Z', GIT_COMMITTER_DATE: '2026-10-27T16:21:24Z' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git('tag', 'v1.2.3');
  w('untracked-leftover.txt', 'darf nicht ins Paket\n');
  w('dvhub/config.json', '{"geheim":1}\n');
  return { dir, git };
}

function keypair(dir, name) {
  const k = path.join(dir, name);
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', k]);
  assert.equal(r.status, 0);
  return { key: k, pub: fs.readFileSync(`${k}.pub`, 'utf8').trim() };
}

function build(repo, out, extra = []) {
  return spawnSync('bash', [BUILD, ...extra, '--repo', repo, '--out', out, '--arch', 'arm64', '--no-eebus'], {
    encoding: 'utf8', env: { ...process.env, DVHUB_RELEASE_NPM_CACHE: path.join(out, '..', 'npm-cache') },
  });
}

test('build-release.sh: Tag → signiertes, reproduzierbares Paket nur aus der Allowlist', { timeout: 120000 }, () => {
  const { dir } = fixtureRepo();
  const work = tmp('dvhub-build-out-');
  try {
    const { key, pub } = keypair(work, 'k');
    const r1 = build(dir, path.join(work, 'o1'), ['v1.2.3', '--key', key]);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    const r2 = build(dir, path.join(work, 'o2'), ['v1.2.3', '--key', key]);
    assert.equal(r2.status, 0, r2.stderr);
    const f1 = path.join(work, 'o1/1.2.3/dvhub-1.2.3-arm64.tar.gz');
    const f2 = path.join(work, 'o2/1.2.3/dvhub-1.2.3-arm64.tar.gz');
    assert.equal(sha256(fs.readFileSync(f1)), sha256(fs.readFileSync(f2)), 'gleiche Ref → gleiche Bytes');

    const entries = readTar(zlib.gunzipSync(fs.readFileSync(f1)));
    const names = entries.filter((e) => e.type !== 'dir').map((e) => e.path).sort();
    assert.deepEqual(names, ['.dvhub-release.json', '.node-version', 'dvhub/package-lock.json', 'dvhub/package.json', 'dvhub/public/index.html',
      'dvhub/server.js', 'eos-provision.sh', 'eos-version.env', 'post-update.sh']);
    assert.ok(entries.every((e) => e.uid === 0 && e.mtime === 1793118084));

    const manifest = JSON.parse(entries.find((e) => e.path === '.dvhub-release.json').data);
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.channel, 'stable');
    assert.equal(manifest.tag, 'v1.2.3');
    assert.equal(manifest.arch, 'arm64');
    assert.equal(manifest.node_engine, '>=22.0.0');
    assert.equal(manifest.eos.pin, 'v0.4.0rc3');
    for (const f of manifest.files) {
      assert.equal(f.sha256, sha256(entries.find((e) => e.path === f.path).data), f.path);
    }
    assert.equal(manifest.files.find((f) => f.path === 'post-update.sh').mode, '0755');

    const rel = JSON.parse(fs.readFileSync(path.join(work, 'o1/1.2.3/release.json'), 'utf8'));
    assert.equal(rel.artifacts.arm64.sha256, sha256(fs.readFileSync(f1)));

    fs.writeFileSync(path.join(work, 'allowed'), `dvhub-release namespaces="dvhub-release,dvhub-release-index" ${pub}\n`);
    const verify = (file, sig) => spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(work, 'allowed'), '-I', 'dvhub-release', '-n', 'dvhub-release', '-s', sig], { input: fs.readFileSync(file) });
    assert.equal(verify(f1, `${f1}.sig`).status, 0, 'Signatur gültig');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('build-release.sh: Ref ohne Tag → dev-Version; ohne Schlüssel nur mit --no-sign; Allowlist-Lücke bricht ab', { timeout: 120000 }, () => {
  const { dir, git } = fixtureRepo();
  const work = tmp('dvhub-build-out-');
  try {
    const sha = git('rev-parse', 'HEAD');
    const noKey = build(dir, path.join(work, 'o'), ['HEAD', '--key', path.join(work, 'fehlt')]);
    assert.notEqual(noKey.status, 0);
    assert.match(noKey.stderr, /Signaturschlüssel/);
    const r = build(dir, path.join(work, 'o'), ['HEAD', '--no-sign']);
    assert.equal(r.status, 0, r.stderr);
    const v = `1.2.3-dev.20261027162124.${sha.slice(0, 8)}`;
    assert.ok(fs.existsSync(path.join(work, 'o', v, `dvhub-${v}-arm64.tar.gz`)), r.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'o', v, 'release.json'), 'utf8')).channel, 'dev');

    const narrow = path.join(work, 'allow.txt');
    fs.writeFileSync(narrow, '+ dvhub/\n+ post-update.sh\n');
    const gap = build(dir, path.join(work, 'o3'), ['HEAD', '--no-sign', '--allowlist', narrow]);
    assert.notEqual(gap.status, 0);
    assert.match(gap.stderr, /eos-provision\.sh/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('build-release.sh: Schlüsselrechte mit GNU-stat (Linux/CI) richtig gelesen', { timeout: 120000 }, () => {
  const { dir } = fixtureRepo();
  const work = tmp('dvhub-build-out-');
  try {
    const { key } = keypair(work, 'k');
    // GNU stat: "-f" heißt Dateisystem — '%Lp' wird als Dateiname gelesen,
    // die Ausgabe zum echten Pfad landet trotzdem auf stdout, Exit 1.
    const bin = path.join(work, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'stat'), `#!/bin/sh
if [ "$1" = "-f" ]; then echo "  File: \\"$3\\""; echo "    ID: 0 Namelen: 255 Type: apfs"; echo "stat: cannot read file system information for '$2'" >&2; exit 1; fi
if [ "$1" = "-c" ]; then node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8) + "\\n")' "$3"; exit 0; fi
exit 2
`, { mode: 0o755 });
    const r = spawnSync('bash', [BUILD, 'v1.2.3', '--key', key, '--repo', dir, '--out', path.join(work, 'o'), '--arch', 'arm64', '--no-eebus'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DVHUB_RELEASE_NPM_CACHE: path.join(work, 'npm-cache') },
    });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('publish-release.sh --dry-run: Schlüssel mit Passphrase im ssh-agent reicht (keine Rückfrage)', { timeout: 120000 }, (t) => {
  const { dir } = fixtureRepo();
  const work = tmp('dvhub-publish-');
  const sock = path.join(work, 'agent.sock');
  let agentPid = null;
  try {
    const { key } = keypair(work, 'k');
    const r = build(dir, path.join(work, 'o'), ['v1.2.3', '--key', key]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const ag = spawnSync('ssh-agent', ['-a', sock], { encoding: 'utf8' });
    if (ag.status !== 0) { t.skip('ssh-agent nicht verfügbar'); return; }
    agentPid = Number((ag.stdout.match(/SSH_AGENT_PID=(\d+)/) || [])[1]) || null;
    const env = { ...process.env, SSH_AUTH_SOCK: sock };
    assert.equal(spawnSync('ssh-add', ['-q', key], { env }).status, 0, 'Schlüssel in den Agenten');
    // Erst danach mit Passphrase verschlüsseln: wie auf dem Mac liegt er nur im Agenten offen.
    assert.equal(spawnSync('ssh-keygen', ['-q', '-p', '-P', '', '-N', 'geheim-passphrase', '-f', key]).status, 0);
    const pub = path.join(work, 'pub');
    const p = spawnSync('bash', [path.join(repoRoot, 'scripts/release/publish-release.sh'), path.join(work, 'o/1.2.3'), '--key', key, '--repo', dir, '--dry-run', '--dest', pub], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.ok(fs.existsSync(path.join(pub, 'v1.2.3', 'dvhub-1.2.3-arm64.tar.gz')));
    assert.ok(fs.existsSync(path.join(pub, 'channels', 'index-stable.json.sig')));
  } finally {
    if (agentPid) { try { process.kill(agentPid); } catch { /* weg */ } }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ── Version auf main (Christin 05.11.2026: dev-Pakete aus main) ─────────────
// Ein dev-Paket heißt <package.json>-dev.<Zeit>.<sha8>. Steht package.json nach
// dem Release noch auf der Release-Nummer, sortiert jedes dev-Paket VOR dem
// Release (Semver: 1.0.9-dev.x < 1.0.9) — Boxen auf 1.0.9 meldeten den Wechsel
// als Rückschritt und sähen nie ein Update. Darum: hat [Unreleased] Einträge,
// muss package.json über dem neuesten Release stehen. Vierstellige Nummern
// (1.0.9.1) kennt der Box-Helfer nicht (VERSION_RE) — sie machten den ganzen
// Index auf allen Boxen ungültig.
test('Version auf main: dev-Pakete sortieren nach dem neuesten Release (package.json, Lockfile, CHANGELOG)', async () => {
  const { createRequire } = await import('node:module');
  const H = createRequire(import.meta.url)(path.join(repoRoot, 'dvhub-release.cjs'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dvhub/package.json'), 'utf8')).version;
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dvhub/package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg, 'package-lock.json passt zu package.json');
  assert.equal(lock.packages[''].version, pkg, 'package-lock.json packages[""] passt zu package.json');
  assert.match(pkg, /^\d+\.\d+\.\d+$/, 'dreistellig, ohne Vorabteil');
  const text = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const released = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}/gm)].map((m) => m[1]);
  assert.ok(released.length, 'CHANGELOG nennt Releases');
  const newest = released.sort((a, b) => compareVersions(b, a))[0];
  const unreleased = (/^## \[Unreleased\][^\n]*\n([\s\S]*?)^## \[/m.exec(text) || [])[1] || '';
  const dev = computeReleaseVersion({ tag: '', pkgVersion: pkg, commitTime: 1793880000, sha: 'a'.repeat(40) }).version;
  assert.ok(H.VERSION_RE.test(dev), `Box-Helfer nimmt ${dev} an`);
  if (/^\s*- /m.test(unreleased)) {
    assert.equal(compareVersions(pkg, newest), 1, `package.json ${pkg} muss über dem Release ${newest} stehen ([Unreleased] hat Einträge)`);
    assert.equal(compareVersions(dev, newest), 1, `${dev} sortiert nach ${newest}`);
    assert.equal(H.compareVersions(dev, newest), 1, `Box-Helfer: ${dev} nach ${newest}`);
  } else {
    assert.ok(compareVersions(pkg, newest) >= 0, `package.json ${pkg} nicht unter dem Release ${newest}`);
  }
});

// ── dev-Pakete: Bau → Veröffentlichung (Dry-Run) → Box prüft und installiert ─

function fixtureRepoDev(version = '1.0.10') {
  const f = fixtureRepo();
  const w = (p, c) => fs.writeFileSync(path.join(f.dir, p), c);
  w('dvhub/package.json', JSON.stringify({ name: 'dvhub', version, type: 'module', engines: { node: '>=22.0.0' } }));
  w('dvhub/package-lock.json', JSON.stringify({ name: 'dvhub', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'dvhub', version } } }));
  f.git('add', 'dvhub/package.json', 'dvhub/package-lock.json');
  f.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'feat: etwas Neues');
  return f;
}

// dev seit dem dev-Schlüssel (24.11.2026): publish-release schreibt index-dev-v2.json
// und verlangt, dass es ihn schon gibt (Brücke erledigt). Für Trockenläufe ohne
// Brücke: leerer Platzhalter als Vorgänger — so wie der dev-Worker es macht.
function seedV2(dest) {
  fs.mkdirSync(path.join(dest, 'channels'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'channels', 'index-dev-v2.json'), '{"format":1,"channel":"dev","latest":null,"releases":[]}\n');
}

// Falsches gh im PATH: protokolliert und scheitert — kein Test darf GitHub erreichen.
// Mehr als 30 Commit-Betreffe seit dem vorigen dev-Paket: `git log … | head -30`
// unter `set -o pipefail` bricht mit SIGPIPE (Exit 141) ab, sobald head nach 30
// Zeilen schließt (21.11.2026: 127 Betreffe seit 4a8f7810, Veröffentlichung von
// 47cdb7a5 brach ab). Erwartet: Erfolg, die neuesten 30 Betreffe als Änderungen.
test('publish-release.sh --dry-run: mehr als 30 Commits seit dem vorigen dev-Paket brechen nicht ab', { timeout: 240000 }, () => {
  const { dir, git } = fixtureRepoDev('1.0.10');
  const work = tmp('dvhub-dev-many-');
  try {
    const { key } = keypair(work, 'k');
    const gh = fakeGh(work);
    const dest = path.join(work, 'pub');
    seedV2(dest);
    const env = { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` };
    const pubOnce = (outDir) => {
      const r = build(dir, outDir, ['HEAD', '--sig-scope', 'dev', '--key', key]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const version = fs.readdirSync(outDir)[0];
      const p = spawnSync('bash', [path.join(repoRoot, 'scripts/release/publish-release.sh'), path.join(outDir, version), '--sig-scope', 'dev', '--key', key, '--repo', dir, '--dry-run', '--dest', dest], { encoding: 'utf8', env });
      return Object.assign(p, { version });
    };
    const first = pubOnce(path.join(work, 'o1'));
    assert.equal(first.status, 0, first.stdout + first.stderr);
    // Viele Betreffe, damit git log mehr als eine Pipe-Puffer-Ladung schreibt.
    const lang = 'x'.repeat(400);
    for (let i = 1; i <= 400; i += 1) git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', `fix: Änderung ${i} ${lang}`);
    const second = pubOnce(path.join(work, 'o2'));
    assert.equal(second.status, 0, `Exit ${second.status}: ${second.stdout}${second.stderr}`);
    const idx = JSON.parse(fs.readFileSync(path.join(dest, 'channels', 'index-dev-v2.json'), 'utf8'));
    const entry = idx.releases.find((r) => r.version === second.version);
    assert.ok(entry, `Eintrag ${second.version} im Index`);
    assert.ok(idx.releases.some((r) => r.version === first.version), 'Vorgänger bleibt im Index');
    const changes = entry.changes;
    assert.equal(changes.length, 30, 'höchstens 30 Betreffe');
    assert.equal(changes[0], `fix: Änderung 400 ${lang}`, 'neuester Betreff zuerst');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

function fakeGh(work) {
  const bin = path.join(work, 'gh-bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(work, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
  return { bin, log };
}

test('dev-Paket: build-release.sh HEAD + publish-release.sh --dry-run (dev-Schlüssel) → signierter index-dev-v2.json, Box nimmt ihn an', { timeout: 180000 }, async () => {
  const { createRequire } = await import('node:module');
  const H = createRequire(import.meta.url)(path.join(repoRoot, 'dvhub-release.cjs'));
  const { dir, git } = fixtureRepoDev('1.0.10');
  const work = tmp('dvhub-dev-pub-');
  try {
    const sha = git('rev-parse', 'HEAD');
    const { key, pub } = keypair(work, 'k');
    const r = build(dir, path.join(work, 'o'), ['HEAD', '--sig-scope', 'dev', '--key', key]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rel = JSON.parse(fs.readFileSync(path.join(work, 'o', fs.readdirSync(path.join(work, 'o'))[0], 'release.json'), 'utf8'));
    assert.equal(rel.channel, 'dev');
    assert.match(rel.version, new RegExp(`^1\\.0\\.10-dev\\.\\d{14}\\.${sha.slice(0, 8)}$`));
    assert.equal(rel.tag, null);
    assert.equal(H.compareVersions(rel.version, '1.0.9'), 1, 'dev aus main sortiert nach 1.0.9');

    const gh = fakeGh(work);
    const dest = path.join(work, 'pub');
    const env = { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` };
    const pubArgs = [path.join(repoRoot, 'scripts/release/publish-release.sh'), path.join(work, 'o', rel.version), '--key', key, '--repo', dir, '--dry-run', '--dest', dest];
    // Ohne --sig-scope dev: index-dev.json ist eingefroren → verweigert; ohne Brücke (kein index-dev-v2.json) ebenso.
    let p = spawnSync('bash', pubArgs, { encoding: 'utf8', env });
    assert.notEqual(p.status, 0); assert.match(p.stderr, /eingefroren/);
    p = spawnSync('bash', [...pubArgs, '--sig-scope', 'dev'], { encoding: 'utf8', env });
    assert.notEqual(p.status, 0); assert.match(p.stderr, /Brücken-Paket/);
    seedV2(dest);
    p = spawnSync('bash', [...pubArgs, '--sig-scope', 'dev'], { encoding: 'utf8', env });
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.ok(!fs.existsSync(gh.log), 'Dry-Run ruft gh nicht auf');
    assert.ok(fs.existsSync(path.join(dest, 'dev', `dvhub-${rel.version}-arm64.tar.gz`)), 'Paket am Vorab-Release dev');
    assert.ok(!fs.existsSync(path.join(dest, 'channels', 'index-dev.json')), 'alte index-dev.json bleibt unangetastet');
    const idxFile = path.join(dest, 'channels', 'index-dev-v2.json');
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    assert.equal(idx.channel, 'dev');
    assert.equal(idx.latest, rel.version);
    assert.equal(idx.releases[0].artifacts.arm64.url, `../dev/dvhub-${rel.version}-arm64.tar.gz`);
    assert.deepEqual(idx.releases[0].changes, ['feat: etwas Neues', 'init']);
    H.validateIndex(idx, 'dev');   // Prüfung der Box
    // Vertrauenszeile wie für den dev-Schlüssel in release-keys/allowed_signers.
    fs.writeFileSync(path.join(work, 'allowed'), `dvhub-release namespaces="dvhub-release-dev,dvhub-release-index-dev" ${pub}\n`);
    const verify = (ns, file) => spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(work, 'allowed'), '-I', 'dvhub-release', '-n', ns, '-s', `${file}.sig`], { input: fs.readFileSync(file) });
    assert.equal(verify('dvhub-release-index-dev', idxFile).status, 0, 'Index-Signatur (Namensraum dvhub-release-index-dev)');
    for (const ns of ['dvhub-release-index', 'dvhub-release', 'dvhub-release-dev']) assert.notEqual(verify(ns, idxFile).status, 0, `Index nicht gültig für ${ns}`);
    const pkg = path.join(dest, 'dev', `dvhub-${rel.version}-arm64.tar.gz`);
    assert.equal(verify('dvhub-release-dev', pkg).status, 0, 'Paket im Namensraum dvhub-release-dev');
    assert.notEqual(verify('dvhub-release', pkg).status, 0, 'Paket nicht als stable-Paket gültig');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('publish-release.sh dev: nur Commits, die auf origin/main liegen (nichts Unveröffentlichtes als Paket)', { timeout: 180000 }, () => {
  const { dir, git } = fixtureRepoDev('1.0.10');
  const work = tmp('dvhub-dev-guard-');
  try {
    const { key } = keypair(work, 'k');
    const r = build(dir, path.join(work, 'o'), ['HEAD', '--sig-scope', 'dev', '--key', key]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = path.join(work, 'o', fs.readdirSync(path.join(work, 'o'))[0]);
    const gh = fakeGh(work);
    const env = { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` };
    const pub = (extra) => spawnSync('bash', [path.join(repoRoot, 'scripts/release/publish-release.sh'), out, '--sig-scope', 'dev', '--key', key, '--repo', dir, '--gh-repo', 'nobody/nothing', ...extra], { encoding: 'utf8', env });
    // Kein origin/main: ablehnen, bevor gh irgendetwas tut.
    const p1 = pub([]);
    assert.notEqual(p1.status, 0, p1.stdout + p1.stderr);
    assert.match(p1.stderr, /origin\/main/);
    assert.ok(!fs.existsSync(gh.log), `gh nicht aufgerufen: ${fs.existsSync(gh.log) ? fs.readFileSync(gh.log, 'utf8') : ''}`);
    // origin/main steht vor dem Commit (lokaler, ungepushter Stand): ebenso.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD~1');
    const p2 = pub([]);
    assert.notEqual(p2.status, 0);
    assert.match(p2.stderr, /origin\/main/);
    assert.ok(!fs.existsSync(gh.log));
    // Liegt der Commit auf origin/main, geht es weiter (bis zum falschen gh).
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const p3 = pub([]);
    assert.doesNotMatch(p3.stderr, /origin\/main/);
    assert.ok(fs.existsSync(gh.log), 'erst jetzt gh');
    // Dry-Run auf einem ungepushten Stand: nur ein Hinweis.
    git('update-ref', '-d', 'refs/remotes/origin/main');
    seedV2(path.join(work, 'dest'));
    const p4 = pub(['--dry-run', '--dest', path.join(work, 'dest')]);
    assert.equal(p4.status, 0, p4.stderr);
    assert.match(p4.stderr, /origin\/main/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ── Fable R3, P3-6: publish-release.sh gegen ein nachgebautes GitHub ─────────
// (1) Scheitert der Abruf des bisherigen Index aus einem anderen Grund als
//     „gibt es nicht“ (Netz, Anmeldung), baute das Skript ohne Vorgänger — der
//     stabile Index enthielte nur die neue Version, der Rückweg fehlte. Jetzt:
//     Abbruch, bevor irgendetwas hochgeladen wird.
// (2) Index und Signatur gingen nacheinander mit --clobber hoch; scheiterte das
//     zweite Hochladen, blieb ein Index mit falscher Signatur liegen. Jetzt:
//     beide unter Zwischennamen hochladen, dann umbenennen (erst Signatur,
//     dann Index).
function statefulGh(work) {
  const bin = path.join(work, 'gh-store-bin');
  const store = path.join(work, 'gh-store');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  const log = path.join(work, 'gh-store.log');
  const script = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const store = ${JSON.stringify(store)}; const log = ${JSON.stringify(log)};
const a = process.argv.slice(2);
fs.appendFileSync(log, a.join(' ') + '\\n');
const idsFile = path.join(store, 'ids.json');
const ids = fs.existsSync(idsFile) ? JSON.parse(fs.readFileSync(idsFile, 'utf8')) : { next: 1, assets: {} };
const save = () => fs.writeFileSync(idsFile, JSON.stringify(ids));
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
if (process.env.FAKE_GH_OFFLINE === '1' && a.join(' ').includes('channels')) fail('error connecting to api.github.com');
const relDir = (tag) => path.join(store, 'rel', tag);
const assetsOf = (tag) => Object.entries(ids.assets).filter(([, v]) => v.tag === tag).map(([id, v]) => ({ id: Number(id), name: v.name, size: fs.existsSync(path.join(relDir(tag), v.name)) ? fs.statSync(path.join(relDir(tag), v.name)).size : 0 }));
if (a[0] === 'api') {
  const method = opt('-X') || 'GET';
  const route = a.find((x, i) => i > 0 && x.startsWith('repos/'));
  let m;
  if (method === 'GET' && (m = /releases\\/tags\\/([^/]+)$/.exec(route))) {
    if (!fs.existsSync(relDir(m[1]))) fail('gh: Not Found (HTTP 404)');
    process.stdout.write(JSON.stringify({ tag_name: m[1], assets: assetsOf(m[1]) })); process.exit(0);
  }
  if ((m = /releases\\/assets\\/(\\d+)$/.exec(route))) {
    const as = ids.assets[m[1]]; if (!as) fail('gh: Not Found (HTTP 404)');
    if (method === 'DELETE') { fs.rmSync(path.join(relDir(as.tag), as.name)); delete ids.assets[m[1]]; save(); process.exit(0); }
    if (method === 'PATCH') {
      const name = (a[a.indexOf('-f') + 1] || '').replace(/^name=/, '');
      // Einmaliger Fehler (vorübergehend, z. B. 502): der nächste Aufruf gelingt.
      const failMark = path.join(store, 'patch-failed');
      if (process.env.FAKE_GH_PATCH_FAIL === name && !fs.existsSync(failMark)) { fs.writeFileSync(failMark, '1'); fail('gh: Server Error (HTTP 502)'); }
      // Verlorene Antwort: GitHub hat umbenannt, der Aufruf meldet trotzdem Fehler.
      const lostMark = path.join(store, 'patch-lost');
      const lost = process.env.FAKE_GH_PATCH_LOST === name && !fs.existsSync(lostMark);
      if (assetsOf(as.tag).some((x) => x.name === name)) fail('gh: Validation Failed (HTTP 422) already_exists');
      fs.renameSync(path.join(relDir(as.tag), as.name), path.join(relDir(as.tag), name)); as.name = name; save();
      if (lost) { fs.writeFileSync(lostMark, '1'); fail('error connecting to api.github.com (connection reset)'); }
      process.stdout.write(JSON.stringify({ id: Number(m[1]), name })); process.exit(0);
    }
  }
  fail('fake gh: unbekannter api-Aufruf ' + a.join(' '));
}
if (a[0] === 'release') {
  const tag = a[2];
  if (a[1] === 'view') { if (!fs.existsSync(relDir(tag))) fail('release not found'); process.exit(0); }
  if (a[1] === 'create') { fs.mkdirSync(relDir(tag), { recursive: true }); process.exit(0); }
  if (a[1] === 'upload') {
    if (!fs.existsSync(relDir(tag))) fail('release not found');
    for (const f of a.slice(3).filter((x) => !x.startsWith('-') && x !== opt('-R'))) {
      const name = path.basename(f);
      const old = assetsOf(tag).find((x) => x.name === name);
      if (old) { if (!a.includes('--clobber')) fail('asset exists'); delete ids.assets[old.id]; }
      if (process.env.FAKE_GH_UPLOAD_FAIL && name.endsWith(process.env.FAKE_GH_UPLOAD_FAIL)) { save(); fail('upload failed: ' + name); }
      fs.copyFileSync(f, path.join(relDir(tag), name)); ids.assets[ids.next++] = { tag, name }; save();
    }
    process.exit(0);
  }
  if (a[1] === 'download') {
    const name = opt('-p'); const out = opt('-O');
    if (!fs.existsSync(path.join(relDir(tag), name))) fail('no assets match the file pattern');
    fs.copyFileSync(path.join(relDir(tag), name), out); process.exit(0);
  }
  if (a[1] === 'delete-asset') { const as = assetsOf(tag).find((x) => x.name === a[3]); if (as) { fs.rmSync(path.join(relDir(tag), as.name)); delete ids.assets[as.id]; save(); } process.exit(0); }
}
fail('fake gh: unbekannt ' + a.join(' '));
`;
  fs.writeFileSync(path.join(bin, 'gh'), script, { mode: 0o755 });
  const seed = (tag, name, file) => {
    const ids = fs.existsSync(path.join(store, 'ids.json')) ? JSON.parse(fs.readFileSync(path.join(store, 'ids.json'), 'utf8')) : { next: 1, assets: {} };
    fs.mkdirSync(path.join(store, 'rel', tag), { recursive: true });
    if (file) { fs.copyFileSync(file, path.join(store, 'rel', tag, name)); ids.assets[ids.next++] = { tag, name }; }
    fs.writeFileSync(path.join(store, 'ids.json'), JSON.stringify(ids));
  };
  return { bin, store, log, seed, file: (tag, name) => path.join(store, 'rel', tag, name) };
}

test('publish-release.sh (P3-6): bisheriger Index bleibt drin, Zwischennamen + Umbenennen, Abbruch bei Netzfehler', { timeout: 180000 }, () => {
  const { dir } = fixtureRepo();
  const work = tmp('dvhub-pub-atomic-');
  try {
    const { key, pub } = keypair(work, 'k');
    const r = build(dir, path.join(work, 'o'), ['v1.2.3', '--key', key]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = path.join(work, 'o', '1.2.3');
    // Vorgänger-Index (1.2.2) aus einem Dry-Run gebaut.
    const dry = path.join(work, 'dry');
    const d = spawnSync('bash', [path.join(repoRoot, 'scripts/release/publish-release.sh'), out, '--key', key, '--repo', dir, '--dry-run', '--dest', dry], { encoding: 'utf8' });
    assert.equal(d.status, 0, d.stderr);
    const prevIdx = JSON.parse(fs.readFileSync(path.join(dry, 'channels', 'index-stable.json'), 'utf8'));
    prevIdx.releases[0].version = '1.2.2'; prevIdx.latest = '1.2.2';
    const prevFile = path.join(work, 'prev-index.json');
    fs.writeFileSync(prevFile, JSON.stringify(prevIdx));

    const gh = statefulGh(work);
    gh.seed('channels', 'index-stable.json', prevFile);
    gh.seed('channels', 'index-stable.json.sig', prevFile);
    const run = (env = {}) => spawnSync('bash', [path.join(repoRoot, 'scripts/release/publish-release.sh'), out, '--key', key, '--repo', dir, '--gh-repo', 'o/r'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${gh.bin}:${process.env.PATH}`, ...env },
    });

    // (1) Netzfehler beim Abruf des Kanal-Index (übrige Aufrufe gehen): Abbruch, nichts hochgeladen.
    const off = run({ FAKE_GH_OFFLINE: '1' });
    assert.notEqual(off.status, 0, 'Abbruch statt Bau ohne Vorgänger');
    assert.match(off.stderr, /Index|Kanal/);
    assert.equal(fs.readFileSync(gh.file('channels', 'index-stable.json'), 'utf8'), JSON.stringify(prevIdx), 'alter Index unverändert');
    assert.ok(!fs.existsSync(path.join(gh.store, 'rel', 'v1.2.3')), 'kein Release angelegt');

    // (2) Hochladen des Zwischenstands scheitert: alter Index samt Signatur bleibt.
    const upFail = run({ FAKE_GH_UPLOAD_FAIL: 'index-stable.json.new' });
    assert.notEqual(upFail.status, 0);
    assert.equal(fs.readFileSync(gh.file('channels', 'index-stable.json'), 'utf8'), JSON.stringify(prevIdx), 'alter Index bleibt gültig');
    assert.equal(fs.readFileSync(gh.file('channels', 'index-stable.json.sig'), 'utf8'), JSON.stringify(prevIdx), 'alte Signatur bleibt');

    // (3) Normaler Lauf: Index mit Vorgänger, gültige Signatur, keine Zwischennamen übrig.
    const ok = run();
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const idxFile = gh.file('channels', 'index-stable.json');
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    assert.deepEqual(idx.releases.map((x) => x.version), ['1.2.3', '1.2.2'], 'Vorgänger bleibt als Rückweg');
    fs.writeFileSync(path.join(work, 'allowed'), `dvhub-release namespaces="dvhub-release,dvhub-release-index" ${pub}\n`);
    const v = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(work, 'allowed'), '-I', 'dvhub-release', '-n', 'dvhub-release-index', '-s', `${idxFile}.sig`], { input: fs.readFileSync(idxFile) });
    assert.equal(v.status, 0, `Signatur passt zum Index: ${v.stderr}`);
    assert.deepEqual(fs.readdirSync(path.join(gh.store, 'rel', 'channels')).sort(), ['index-stable.json', 'index-stable.json.sig']);
    const calls = fs.readFileSync(gh.log, 'utf8');
    assert.match(calls, /release upload channels .*index-stable\.json\.sig\.new .*index-stable\.json\.new/, 'Zwischennamen');
    const lastRun = calls.slice(calls.lastIndexOf('releases/tags/channels', calls.lastIndexOf('index-stable.json.new')));
    const renames = [...lastRun.matchAll(/-X PATCH \S+ -f name=(\S+)/g)].map((m) => m[1]);
    assert.deepEqual(renames, ['index-stable.json.sig', 'index-stable.json'], 'erst Signatur, dann Index');

    // (4) Codex 9f40b69c: Umbenennen scheitert mittendrin → alter Stand zurück, Zwischenstand bleibt.
    const live = fs.readFileSync(idxFile, 'utf8');
    const liveSig = fs.readFileSync(`${idxFile}.sig`, 'utf8');
    const pf = run({ FAKE_GH_PATCH_FAIL: 'index-stable.json' });
    assert.notEqual(pf.status, 0);
    assert.match(pf.stderr, /wiederhergestellt/);
    assert.equal(fs.readFileSync(idxFile, 'utf8'), live, 'lebender Index zurück');
    assert.equal(fs.readFileSync(`${idxFile}.sig`, 'utf8'), liveSig, 'lebende Signatur zurück');
    assert.deepEqual(fs.readdirSync(path.join(gh.store, 'rel', 'channels')).sort(),
      ['index-stable.json', 'index-stable.json.new', 'index-stable.json.sig'], 'Zwischenstand des Index bleibt für den nächsten Lauf');
    // (4b) Codex 8f94225c: Umbenennen wirkt, aber die Antwort geht verloren → trotzdem altes Paar zurück.
    const lostRun = run({ FAKE_GH_PATCH_LOST: 'index-stable.json.sig' });
    assert.notEqual(lostRun.status, 0);
    assert.match(lostRun.stderr, /wiederhergestellt/);
    assert.equal(fs.readFileSync(idxFile, 'utf8'), live, 'lebender Index = alter');
    assert.equal(fs.readFileSync(`${idxFile}.sig`, 'utf8'), liveSig, 'lebende Signatur = alte, passend zum Index');
    // Codex 11f469a2: das alte Paar bleibt dauerhaft neben dem Build liegen (Hand-Reparatur, falls auch das Hochladen scheitert).
    assert.equal(fs.readFileSync(path.join(out, 'channels-restore', 'index-stable.json'), 'utf8'), live);
    // Codex 3aa7d678: bestätigt wiederhergestellt → Marke, damit der dev-Worker nicht dauerhaft anhält.
    assert.ok(fs.existsSync(path.join(out, 'channels-restore', 'bestaetigt')));

    // (5) Lebender Index fehlt (Abbruch zwischen Sichern und Umstellen): Vorgänger aus ….new, nicht „erster Index“.
    const ch = path.join(gh.store, 'rel', 'channels');
    const ids = JSON.parse(fs.readFileSync(path.join(gh.store, 'ids.json'), 'utf8'));
    for (const [id, v] of Object.entries(ids.assets)) {
      if (v.tag === 'channels' && v.name === 'index-stable.json') { fs.rmSync(path.join(ch, v.name)); delete ids.assets[id]; }
    }
    fs.writeFileSync(path.join(gh.store, 'ids.json'), JSON.stringify(ids));
    const rec = run();
    assert.equal(rec.status, 0, rec.stdout + rec.stderr);
    assert.match(rec.stderr, /Vorgänger aus index-stable\.json\.new/);
    assert.deepEqual(JSON.parse(fs.readFileSync(idxFile, 'utf8')).releases.map((x) => x.version), ['1.2.3', '1.2.2'], 'Rückweg bleibt');
    assert.deepEqual(fs.readdirSync(ch).sort(), ['index-stable.json', 'index-stable.json.sig']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('publish-release.sh (P3-6): ohne Kanal-Release (404) erster Index ohne Vorgänger', { timeout: 180000 }, () => {
  const { dir } = fixtureRepo();
  const work = tmp('dvhub-pub-first-');
  try {
    const { key } = keypair(work, 'k');
    const r = build(dir, path.join(work, 'o'), ['v1.2.3', '--key', key]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const gh = statefulGh(work);
    const p = spawnSync('bash', [path.join(repoRoot, 'scripts/release/publish-release.sh'), path.join(work, 'o', '1.2.3'), '--key', key, '--repo', dir, '--gh-repo', 'o/r'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` },
    });
    assert.equal(p.status, 0, p.stdout + p.stderr);
    const idx = JSON.parse(fs.readFileSync(gh.file('channels', 'index-stable.json'), 'utf8'));
    assert.deepEqual(idx.releases.map((x) => x.version), ['1.2.3']);
    assert.ok(fs.existsSync(gh.file('v1.2.3', 'dvhub-1.2.3-arm64.tar.gz')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// dev-Schlüssel (24.11.2026): nur für dev-Stände; Tags (stable) brechen ab.
test('build-release --sig-scope dev: Tag-Ref (stable) wird abgelehnt', () => {
  const dir = tmp('dvhub-scope-');
  try {
    const run = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    run('init', '-q');
    fs.mkdirSync(path.join(dir, 'dvhub'));
    fs.writeFileSync(path.join(dir, 'dvhub/package.json'), JSON.stringify({ name: 'dvhub', version: '1.0.0' }));
    run('add', '-A'); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'); run('tag', 'v1.0.0');
    const key = path.join(dir, 'k');
    assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]).status, 0);
    const r = spawnSync('bash', [BUILD, 'v1.0.0', '--repo', dir, '--out', path.join(dir, 'out'), '--sig-scope', 'dev', '--key', key, '--no-eebus'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /nur für dev-Stände/);
    const bad = spawnSync('bash', [BUILD, 'HEAD', '--repo', dir, '--sig-scope', 'stable'], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--sig-scope release oder dev/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// dev-Schlüssel + Brücke gegen das nachgebaute GitHub (nicht nur Dry-Run):
// Brücke friert index-dev.json ein (v2 zuerst umgestellt), dev-Schlüssel
// schreibt nur index-dev-v2.json, ein unterbrochenes Umstellen (nur .new da)
// blockiert nicht (Codex ac5e49a1), und der Notweg ohne dev-Schlüssel
// (--release-key-only) signiert v2 mit dem Release-Schlüssel.
test('publish-release.sh dev: Brücke, dev-Schlüssel, Zwischenstand, Notweg — gegen nachgebautes GitHub', { timeout: 300000 }, () => {
  const { dir } = fixtureRepo();
  const work = tmp('dvhub-pub-bridge-');
  try {
    const rel = keypair(work, 'rel');
    const dev = keypair(work, 'dev');
    const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };
    let n = 0;
    const commit = (msg) => {
      n += 1;
      const env = { ...process.env, GIT_AUTHOR_DATE: `2026-11-0${n}T10:00:00Z`, GIT_COMMITTER_DATE: `2026-11-0${n}T10:00:00Z` };
      for (const a of [['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], ['update-ref', 'refs/remotes/origin/main', 'HEAD']]) {
        const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env });
        assert.equal(r.status, 0, r.stderr);
      }
    };
    w('dvhub/package.json', JSON.stringify({ name: 'dvhub', version: '1.3.0', type: 'module', engines: { node: '>=22.0.0' } }));
    w('dvhub/package-lock.json', JSON.stringify({ name: 'dvhub', version: '1.3.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'dvhub', version: '1.3.0' } } }));
    w('dvhub-release.cjs', fs.readFileSync(path.join(repoRoot, 'dvhub-release.cjs'), 'utf8'));
    w('release-keys/allowed_signers', `dvhub-release namespaces="dvhub-release,dvhub-release-index" ${rel.pub}\ndvhub-release namespaces="dvhub-release-dev,dvhub-release-index-dev" ${dev.pub}\n`);
    commit('feat: Brücke');

    const gh = statefulGh(work);
    const oldIdx = path.join(work, 'old-index.json');
    fs.writeFileSync(oldIdx, JSON.stringify({ format: 1, channel: 'dev', latest: '1.2.0-dev.20261001000000.aaaaaaaa', releases: [{ version: '1.2.0-dev.20261001000000.aaaaaaaa', git_sha: 'a'.repeat(40), artifacts: {} }] }));
    gh.seed('channels', 'index-dev.json', oldIdx);
    gh.seed('channels', 'index-dev.json.sig', oldIdx);
    const env = { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` };
    const out = (name) => path.join(work, name);
    const buildAt = (name, ...extra) => {
      const r = build(dir, out(name), ['HEAD', ...extra]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return path.join(out(name), fs.readdirSync(out(name))[0]);
    };
    const publish = (b, ...extra) => spawnSync('bash', [path.join(repoRoot, 'scripts/release/publish-release.sh'), b, '--repo', dir, '--gh-repo', 'o/r', ...extra], { encoding: 'utf8', env });
    const chan = (name) => gh.file('channels', name);
    const verify = (file, ns, pub) => {
      fs.writeFileSync(path.join(work, 'allowed'), `dvhub-release namespaces="${ns}" ${pub}\n`);
      return spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(work, 'allowed'), '-I', 'dvhub-release', '-n', ns, '-s', `${file}.sig`], { input: fs.readFileSync(file) }).status === 0;
    };

    // Vor der Brücke: dev-Schlüssel verweigert.
    const early = buildAt('o0', '--sig-scope', 'dev', '--key', dev.key);
    let p = publish(early, '--sig-scope', 'dev', '--key', dev.key);
    assert.notEqual(p.status, 0); assert.match(p.stderr, /erst das Brücken-Paket/);

    // Brücke.
    const bridge = buildAt('o1', '--key', rel.key);
    p = publish(bridge, '--bridge', '--key', rel.key, '--dev-key', dev.key);
    assert.equal(p.status, 0, p.stdout + p.stderr);
    const bridgeV = path.basename(bridge);
    assert.ok(fs.existsSync(gh.file('dev-bridge', `dvhub-${bridgeV}-arm64.tar.gz`)));
    assert.deepEqual(JSON.parse(fs.readFileSync(chan('index-dev.json'), 'utf8')).releases.map((x) => x.version), [bridgeV]);
    assert.ok(verify(chan('index-dev.json'), 'dvhub-release-index', rel.pub), 'eingefrorene index-dev.json: Release-Schlüssel');
    assert.ok(verify(chan('index-dev-v2.json'), 'dvhub-release-index-dev', dev.pub), 'index-dev-v2.json: dev-Schlüssel');
    const renames = [...fs.readFileSync(gh.log, 'utf8').matchAll(/-X PATCH \S+ -f name=(\S+)/g)].map((m) => m[1]);
    assert.deepEqual(renames, ['index-dev-v2.json.sig', 'index-dev-v2.json', 'index-dev.json.sig', 'index-dev.json'], 'v2 zuerst, die alte Datei zuletzt');
    const frozen = fs.readFileSync(chan('index-dev.json'));

    // Nächster Stand mit dem dev-Schlüssel.
    w('dvhub/server.js', 'console.log("zwei")\n'); commit('feat: zwei');
    const two = buildAt('o2', '--sig-scope', 'dev', '--key', dev.key);
    p = publish(two, '--sig-scope', 'dev', '--key', dev.key);
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.ok(fs.readFileSync(chan('index-dev.json')).equals(frozen), 'index-dev.json eingefroren');
    assert.deepEqual(JSON.parse(fs.readFileSync(chan('index-dev-v2.json'), 'utf8')).releases.map((x) => x.version), [path.basename(two), bridgeV]);
    p = publish(bridge, '--bridge', '--key', rel.key, '--dev-key', dev.key);
    assert.notEqual(p.status, 0, 'zweite Brücke verweigert'); assert.match(p.stderr, /Brücke ist erledigt/);

    // Unterbrochenes Umstellen: nur der Zwischenstand index-dev-v2.json.new liegt.
    const ids = JSON.parse(fs.readFileSync(path.join(gh.store, 'ids.json'), 'utf8'));
    for (const v of Object.values(ids.assets)) {
      if (v.tag === 'channels' && v.name === 'index-dev-v2.json') { fs.renameSync(chan(v.name), chan(`${v.name}.new`)); v.name = `${v.name}.new`; }
    }
    fs.writeFileSync(path.join(gh.store, 'ids.json'), JSON.stringify(ids));
    w('dvhub/server.js', 'console.log("drei")\n'); commit('feat: drei');
    const three = buildAt('o3', '--sig-scope', 'dev', '--key', dev.key);
    p = publish(three, '--sig-scope', 'dev', '--key', dev.key);
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.match(p.stderr, /Vorgänger aus index-dev-v2\.json\.new/);
    assert.deepEqual(JSON.parse(fs.readFileSync(chan('index-dev-v2.json'), 'utf8')).releases.map((x) => x.version).slice(0, 2), [path.basename(three), path.basename(two)]);

    // Notweg ohne dev-Schlüssel.
    w('dvhub/server.js', 'console.log("vier")\n'); commit('fix: Notfall');
    const four = buildAt('o4', '--key', rel.key);
    p = publish(four, '--bridge', '--release-key-only', '--force-bridge', '--key', rel.key, '--dev-key', path.join(work, 'gibt-es-nicht'));
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.ok(verify(chan('index-dev-v2.json'), 'dvhub-release-index', rel.pub), 'v2 im Notweg mit dem Release-Schlüssel');
    assert.equal(JSON.parse(fs.readFileSync(chan('index-dev-v2.json'), 'utf8')).latest, path.basename(four));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});
