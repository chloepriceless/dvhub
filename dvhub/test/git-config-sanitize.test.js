// test/git-config-sanitize.test.js -- git-Konfiguration des Programmordners
// bereinigen, bevor root darin git ausführt (Gegenprüfung a75c2cea).
// Bis zur Rechte-Härtung vom 25.10.2026 gehörte .git dem Dienstbenutzer; wer ihn
// kontrollierte, konnte in .git/config (und .git/info/attributes) Befehle
// ablegen, die root bei fetch/checkout ausführt. Die -c-Schalter der
// root-Aufrufe decken nur Hooks und core.fsmonitor ab.
// Echte git-Repos im Temp-Ordner; jede Nutzlast legt eine Markerdatei an.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPDATE_SCRIPT = join(ROOT, 'dvhub-update.sh');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

function sanitizerBlock(file = 'post-update.sh') {
  const s = read(file);
  const a = s.indexOf('# BEGIN DVHUB GIT CONFIG');
  const b = s.indexOf('# END DVHUB GIT CONFIG');
  assert.ok(a >= 0 && b > a, `Block BEGIN/END DVHUB GIT CONFIG in ${file}`);
  return s.slice(a, b);
}

// Vorlage einmal je Datei (Upstream, nacktes origin, Klon auf v1.0.0, v1.2.0
// schon in origin); jeder Test kopiert nur den Klon — sonst kosten die vielen
// git-Aufrufe unter Last mehr als die Zeitgrenze der Datei.
let TEMPLATE = null;
const baseEnv = (home) => ({ ...process.env, ...GIT_ENV, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig-global') });
function template() {
  if (TEMPLATE) return TEMPLATE;
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-gitcfg-tpl-'));
  writeFileSync(join(dir, 'gitconfig-global'), '');
  const env = baseEnv(dir);
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();
  const up = join(dir, 'upstream');
  mkdirSync(join(up, 'dvhub'), { recursive: true });
  git(up, 'init', '-q', '-b', 'main');
  writeFileSync(join(up, 'post-update.sh'), '#!/bin/bash\n# DVHUB_ROOT_OWNED_INSTALL\n');
  writeFileSync(join(up, 'app.txt'), 'v1.0.0\n');
  writeFileSync(join(up, 'dvhub', 'package.json'), '{"version":"1.0.0"}\n');
  git(up, 'add', '.'); git(up, 'commit', '-qm', 'v1.0.0'); git(up, 'tag', 'v1.0.0');
  writeFileSync(join(up, 'app.txt'), 'v1.1.0\n');
  git(up, 'commit', '-qam', 'v1.1.0'); git(up, 'tag', 'v1.1.0');
  const origin = join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', up, origin);
  const inst = join(dir, 'opt');
  git(dir, 'clone', '-q', origin, inst);
  git(inst, 'checkout', '-q', '--detach', 'v1.0.0');
  // Neuer Stand erst nach dem Klon: fetch muss ihn holen.
  writeFileSync(join(up, 'app.txt'), 'v1.2.0\n');
  writeFileSync(join(up, 'post-update.sh'), '#!/bin/bash\n# DVHUB_ROOT_OWNED_INSTALL v1.2.0\n');
  git(up, 'commit', '-qam', 'v1.2.0'); git(up, 'tag', 'v1.2.0');
  git(up, 'push', '-q', origin, 'main', 'v1.2.0');
  TEMPLATE = { dir, origin, inst, target: git(up, 'rev-parse', 'HEAD') };
  return TEMPLATE;
}
after(() => { if (TEMPLATE) rmSync(TEMPLATE.dir, { recursive: true, force: true }); });

function setup() {
  const tpl = template();
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-gitcfg-'));
  // Eigenes HOME/System-Config: nichts vom Entwicklerrechner fließt ein.
  writeFileSync(join(dir, 'gitconfig-global'), '');
  const env = baseEnv(dir);
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();
  const inst = join(dir, 'opt');
  execFileSync('cp', ['-Rp', tpl.inst, inst]);
  const { origin, target } = tpl;
  // Wie der Dienstbenutzer: Schlüssel direkt in .git/config anhängen.
  const set = (key, value) => {
    const a = key.indexOf('.'), b = key.lastIndexOf('.');
    const head = a === b ? `[${key.slice(0, a)}]` : `[${key.slice(0, a)} "${key.slice(a + 1, b)}"]`;
    const v = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    appendFileSync(join(inst, '.git', 'config'), `${head}\n\t${key.slice(b + 1)} = "${v}"\n`);
  };
  const markers = join(dir, 'markers');
  mkdirSync(markers);
  const payloads = join(dir, 'payload');
  mkdirSync(payloads);
  // Nutzlast: Marker anlegen. Filter reichen die Daten durch (sonst bräche der
  // Checkout ab), alle anderen enden sofort (upload-pack würde sonst warten).
  const payload = (name, { filter = false } = {}) => {
    const p = join(payloads, `${name}.sh`);
    writeFileSync(p, `#!/bin/sh\ntouch "${markers}/${name}"\n${filter ? 'cat\n' : 'exit 0\n'}`);
    chmodSync(p, 0o755);
    return p;
  };
  const fired = () => readdirSync(markers).sort();
  const cfgPath = join(inst, '.git', 'config');
  const runSanitizer = () => spawnSync('bash', ['-c', `set -euo pipefail\n${sanitizerBlock()}\ndvhub_sanitize_git_config "$1"`, 'sanitize', inst], { encoding: 'utf8', env });
  // Dieselben git-Schritte wie root beim Update (dvhub-update.sh fetch,
  // checkout-tag; install.sh status/rev-parse) — hier OHNE die -c-Schalter, damit
  // die Bereinigung allein zeigt, was sie leistet.
  const plainUpdate = () => {
    const out = [];
    for (const args of [['status', '--porcelain'], ['fetch', '--tags', '--quiet', 'origin'], ['checkout', '-q', '--detach', 'refs/tags/v1.2.0'], ['rev-parse', 'HEAD']]) {
      const r = spawnSync('git', ['-C', inst, ...args], { encoding: 'utf8', env, timeout: 20000 });
      out.push(r);
    }
    return out;
  };
  // Der echte root-Einstieg (mit seinen -c-Schaltern), npm wird nicht gebraucht.
  const helper = (...args) => spawnSync('bash', [UPDATE_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...env, DVHUB_UPDATE_TEST_INSTALL_DIR: inst, DVHUB_UPDATE_TEST_EUID: '0', DVHUB_UPDATE_TEST_LOCK: join(dir, 'update.lock'), DVHUB_UPDATE_TEST_RESTART_FLAG: join(dir, 'npm-restart') },
  });
  const backups = () => readdirSync(join(inst, '.git')).filter((n) => n.includes('dvhub-bak'))
    .concat(existsSync(join(inst, '.git', 'info')) ? readdirSync(join(inst, '.git', 'info')).filter((n) => n.includes('dvhub-bak')).map((n) => `info/${n}`) : []);
  const leftovers = () => readdirSync(join(inst, '.git')).filter((n) => /dvhub-(snap|new|list)/.test(n));
  return {
    dir, origin, inst, target, git, set, env, payload, fired, cfgPath, runSanitizer, plainUpdate, helper, backups, leftovers,
    cfg: () => readFileSync(cfgPath, 'utf8'),
    tracking: () => [git(inst, 'config', '--get', 'branch.main.remote'), git(inst, 'config', '--get', 'branch.main.merge')],
    head: () => git(inst, 'rev-parse', 'HEAD'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Jede Nutzlast einzeln: [Name, Pflanzen].
const CASES = [
  ['fsmonitor', (s) => s.set('core.fsmonitor', s.payload('fsmonitor'))],
  ['filter', (s) => {
    s.set('filter.x.clean', s.payload('filter-clean', { filter: true }));
    s.set('filter.x.smudge', s.payload('filter-smudge', { filter: true }));
    writeFileSync(join(s.inst, '.git', 'info', 'attributes'), '*.txt filter=x\n');
  }],
  ['include', (s) => {
    const inc = join(s.dir, 'evil.inc');
    writeFileSync(inc, `[core]\n\tfsmonitor = ${s.payload('include')}\n`);
    s.set('include.path', inc);
  }],
  ['sshCommand+insteadOf', (s) => {
    s.set('core.sshCommand', s.payload('ssh'));
    s.set('url.ssh://evil.invalid/dvhub.insteadOf', s.origin);
  }],
  ['remote.uploadpack', (s) => s.set('remote.origin.uploadpack', s.payload('uploadpack'))],
];

for (const [name, plant] of CASES) {
  test(`Gegenprobe ohne Bereinigung: ${name} läuft bei den git-Schritten des Updates`, () => {
    const s = setup();
    try {
      plant(s);
      s.plainUpdate();
      assert.notDeepEqual(s.fired(), [], `${name}: Nutzlast muss ohne Bereinigung laufen, sonst beweist der Test nichts`);
    } finally { s.cleanup(); }
  });

  test(`mit Bereinigung: ${name} läuft nicht; Quelle, Verfolgung und Ziel stimmen`, () => {
    const s = setup();
    try {
      const url = s.git(s.inst, 'config', '--get', 'remote.origin.url');
      const tracking = s.tracking();
      plant(s);
      const r = s.runSanitizer();
      assert.equal(r.status, 0, r.stderr);
      const steps = s.plainUpdate();
      assert.deepEqual(s.fired(), [], `${name}: keine Nutzlast`);
      for (const st of steps) assert.equal(st.status, 0, st.stderr);
      assert.equal(s.head(), s.target, 'HEAD auf dem Ziel-Tag');
      assert.equal(s.git(s.inst, 'config', '--get', 'remote.origin.url'), url, 'Quelle unverändert');
      assert.deepEqual(s.tracking(), tracking, 'Branch-Verfolgung unverändert');
    } finally { s.cleanup(); }
  });
}

function plantAll(s) {
  for (const [, plant] of CASES) plant(s);
  s.set('diff.x.textconv', s.payload('textconv', { filter: true }));
  s.set('merge.x.driver', s.payload('merge'));
  s.set('alias.st', `!${s.payload('alias')}`);
  s.set('uploadpack.packObjectsHook', s.payload('packhook'));
  s.set('receivepack.denyCurrentBranch', 'ignore');
  s.set('protocol.ext.allow', 'always');
  s.set('credential.helper', `!${s.payload('credential')}`);
  s.set('core.pager', s.payload('pager'));
  s.set('core.hooksPath', join(s.dir, 'hooks'));
  s.set('gpg.program', s.payload('gpg'));
  writeFileSync(join(s.inst, '.git', 'info', 'attributes'),
    '# Kommentar mit filter=x bleibt\n*.txt filter=x diff=x\n*.bin -diff\n[attr]evil merge=x\n*.c text\n');
}

test('alles zusammen: Bereinigung entfernt nur Fremdes, sichert das Original (0600), loggt Schlüssel ohne Werte', () => {
  const s = setup();
  try {
    const url = s.git(s.inst, 'config', '--get', 'remote.origin.url');
    const tracking = s.tracking();
    plantAll(s);
    const before = s.cfg();
    const attrBefore = readFileSync(join(s.inst, '.git', 'info', 'attributes'), 'utf8');
    const r = s.runSanitizer();
    assert.equal(r.status, 0, r.stderr);
    // Eine Zeile je entferntem Schlüssel, ohne den Wert (keine Pfade der Nutzlast).
    for (const k of ['core.fsmonitor', 'filter.x.clean', 'filter.x.smudge', 'include.path', 'core.sshcommand',
      'remote.origin.uploadpack', 'diff.x.textconv', 'merge.x.driver', 'alias.st', 'uploadpack.packobjectshook',
      'receivepack.denycurrentbranch', 'protocol.ext.allow', 'credential.helper', 'core.pager', 'core.hookspath', 'gpg.program']) {
      assert.match(r.stdout, new RegExp(`^.*${k.replace(/\./g, '\\.')} entfernt`, 'mi'), `Logzeile für ${k}\n${r.stdout}`);
    }
    assert.match(r.stdout, /url\.ssh:\/\/evil\.invalid\/dvhub\.insteadof entfernt/i);
    assert.doesNotMatch(r.stdout + r.stderr, /payload|evil\.inc/, 'keine Werte im Log');
    const cfg = s.cfg();
    assert.doesNotMatch(cfg, /payload|evil|insteadOf|\[filter|\[diff|\[alias|\[include|\[uploadpack|\[protocol|\[credential|\[gpg/i);
    assert.equal(s.git(s.inst, 'config', '--get', 'remote.origin.url'), url);
    assert.deepEqual(s.tracking(), tracking);
    // Sicherung = Original, nur für den Eigentümer lesbar.
    const bk = s.backups();
    const cfgBak = bk.find((n) => n.startsWith('config.dvhub-bak-'));
    const attrBak = bk.find((n) => n.startsWith('info/attributes.dvhub-bak-'));
    assert.ok(cfgBak && attrBak, bk.join(','));
    assert.equal(readFileSync(join(s.inst, '.git', cfgBak), 'utf8'), before);
    assert.equal(statSync(join(s.inst, '.git', cfgBak)).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(s.inst, '.git', attrBak), 'utf8'), attrBefore);
    assert.equal(statSync(join(s.inst, '.git', attrBak)).mode & 0o777, 0o600);
    assert.equal(statSync(s.cfgPath).mode & 0o777, 0o644);
    assert.equal(readFileSync(join(s.inst, '.git', 'info', 'attributes'), 'utf8'), '# Kommentar mit filter=x bleibt\n*.bin -diff\n*.c text\n');
    assert.deepEqual(s.leftovers(), [], 'keine Zwischendateien');
    // Danach: Update über den echten root-Einstieg und die nackten git-Schritte.
    const f = s.helper('fetch');
    assert.equal(f.status, 0, f.stderr);
    const c = s.helper('checkout-tag', 'v1.2.0');
    assert.equal(c.status, 0, c.stderr);
    for (const st of s.plainUpdate()) assert.equal(st.status, 0, st.stderr);
    assert.deepEqual(s.fired(), []);
    assert.equal(s.head(), s.target);
    // Ein zweiter Lauf ändert nichts mehr (keine weitere Sicherung).
    const again = s.runSanitizer();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, '');
    assert.equal(s.backups().length, 2);
  } finally { s.cleanup(); }
});

// Rot vor der Bereinigung: die -c-Schalter von dvhub-update.sh decken Filter,
// core.sshCommand + url.insteadOf und remote.*.uploadpack nicht ab.
test('dvhub-update.sh (echter root-Einstieg): Filter, sshCommand+insteadOf und uploadpack laufen nicht; HEAD am Ziel', () => {
  const s = setup();
  try {
    const url = s.git(s.inst, 'config', '--get', 'remote.origin.url');
    CASES[1][1](s); // filter
    CASES[3][1](s); // sshCommand + insteadOf
    const f = s.helper('fetch');
    assert.deepEqual(s.fired(), [], `fetch: ${f.stderr}`);
    assert.equal(f.status, 0, f.stderr);
    const c = s.helper('checkout-tag', 'v1.2.0');
    assert.equal(c.status, 0, c.stderr);
    assert.deepEqual(s.fired(), []);
    assert.equal(s.head(), s.target);
    assert.equal(s.git(s.inst, 'config', '--get', 'remote.origin.url'), url);
  } finally { s.cleanup(); }
});

test('dvhub-update.sh: remote.origin.uploadpack läuft beim fetch nicht', () => {
  const s = setup();
  try {
    CASES[4][1](s);
    const f = s.helper('fetch');
    assert.deepEqual(s.fired(), [], `fetch: ${f.stderr}`);
    assert.equal(f.status, 0, f.stderr);
  } finally { s.cleanup(); }
});

test('Hooks unter .git/hooks laufen bei den root-Schritten nicht (core.hooksPath=/dev/null)', () => {
  const s = setup();
  try {
    for (const h of ['post-checkout', 'reference-transaction', 'post-index-change', 'pre-auto-gc', 'post-merge']) {
      const p = join(s.inst, '.git', 'hooks', h);
      writeFileSync(p, `#!/bin/sh\ntouch "${s.dir}/markers/hook-${h}"\nexit 0\n`);
      chmodSync(p, 0o755);
    }
    for (const args of [['fetch'], ['stash'], ['checkout-tag', 'v1.2.0'], ['checkout-main']]) {
      const r = s.helper(...args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    }
    assert.deepEqual(s.fired(), []);
  } finally { s.cleanup(); }
});

test('unveränderter Klon (eigener Ursprung, Fork, ssh): Byte für Byte gleich, keine Sicherung, keine Ausgabe', () => {
  for (const url of [null, 'https://github.com/someone/dvhub-fork.git', 'git@github.com:someone/dvhub.git', 'ssh://git@mirror.example:2222/dvhub.git', 'git://mirror.example/dvhub.git', 'file:///srv/mirror/dvhub.git']) {
    const s = setup();
    try {
      if (url) s.git(s.inst, 'remote', 'set-url', 'origin', url);
      const before = s.cfg();
      const r = s.runSanitizer();
      assert.equal(r.status, 0, `${url}: ${r.stderr}`);
      assert.equal(r.stdout + r.stderr, '', `${url}: keine Meldung`);
      assert.equal(s.cfg(), before, `${url}: Byte für Byte`);
      assert.deepEqual(s.backups(), [], `${url}: keine Sicherung`);
      assert.deepEqual(s.leftovers(), []);
      if (!url) {
        // Ein normales Update über den root-Einstieg legt auch nichts an.
        assert.equal(s.helper('fetch').status, 0);
        assert.equal(s.helper('checkout-main').status, 0);
        assert.equal(s.head(), s.target);
        assert.deepEqual(s.backups(), []);
      }
    } finally { s.cleanup(); }
  }
});

test('Quelle in unzulässiger Form (ext::, fd::, „-“, unbekannter Transport): abgelehnt, nichts geändert', () => {
  for (const url of ['ext::sh -c touch% /tmp/dvhub-pwned', 'fd::3', '-oProxyCommand=touch /tmp/x', '--upload-pack=touch /tmp/x', 'evil::foo', 'xyz://host/repo', 'ssh://-oProxyCommand=x/repo', 'relative/path']) {
    const s = setup();
    try {
      plantAll(s);
      s.git(s.inst, 'config', 'remote.origin.url', url);
      const before = s.cfg();
      const attr = readFileSync(join(s.inst, '.git', 'info', 'attributes'), 'utf8');
      const r = s.runSanitizer();
      assert.equal(r.status, 2, `${url}: ${r.status} ${r.stderr}`);
      assert.match(r.stderr, /remote\.origin\.url/, url);
      assert.match(r.stderr, /abgelehnt/i, url);
      assert.doesNotMatch(r.stderr, /tmp\/(dvhub-pwned|x)/, `${url}: Wert nicht im Log`);
      assert.equal(s.cfg(), before, `${url}: nichts geändert`);
      assert.equal(readFileSync(join(s.inst, '.git', 'info', 'attributes'), 'utf8'), attr);
      assert.deepEqual(s.backups(), []);
      assert.deepEqual(s.leftovers(), []);
      // Der root-Einstieg bricht vor git ab.
      const f = s.helper('fetch');
      assert.equal(f.status, 5, `${url}: ${f.stderr}`);
      assert.match(f.stderr, /remote\.origin\.url/);
      assert.deepEqual(s.fired(), []);
      assert.equal(s.cfg(), before);
    } finally { s.cleanup(); }
  }
});

test('Quelle in einer zweiten Fernstelle mit ext:: wird ebenso abgelehnt', () => {
  const s = setup();
  try {
    s.git(s.inst, 'remote', 'add', 'spiegel', 'https://example.invalid/dvhub.git');
    s.git(s.inst, 'config', 'remote.spiegel.url', 'ext::sh -c id');
    const before = s.cfg();
    const r = s.runSanitizer();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /remote\.spiegel\.url/);
    assert.equal(s.cfg(), before);
  } finally { s.cleanup(); }
});

test('.git/config.worktree wird ebenso bereinigt; extensions bleiben', () => {
  const s = setup();
  try {
    s.git(s.inst, 'config', 'core.repositoryformatversion', '1');
    s.git(s.inst, 'config', 'extensions.worktreeConfig', 'true');
    writeFileSync(join(s.inst, '.git', 'config.worktree'), `[core]\n\tfsmonitor = ${s.payload('wt')}\n`);
    const r = s.runSanitizer();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /config\.worktree.*core\.fsmonitor entfernt|core\.fsmonitor entfernt.*config\.worktree/);
    assert.equal(s.git(s.inst, 'config', '--get', 'extensions.worktreeconfig'), 'true');
    s.plainUpdate();
    assert.deepEqual(s.fired(), []);
    assert.equal(s.head(), s.target);
  } finally { s.cleanup(); }
});

test('Verweise statt Dateien (.git/config, .git/info) und .git/commondir: abgelehnt', () => {
  for (const kind of ['config', 'info', 'commondir']) {
    const s = setup();
    try {
      const gd = join(s.inst, '.git');
      if (kind === 'config') {
        writeFileSync(join(s.dir, 'other-config'), s.cfg());
        rmSync(join(gd, 'config'));
        execFileSync('ln', ['-s', join(s.dir, 'other-config'), join(gd, 'config')]);
      } else if (kind === 'info') {
        rmSync(join(gd, 'info'), { recursive: true });
        mkdirSync(join(s.dir, 'other-info'));
        execFileSync('ln', ['-s', join(s.dir, 'other-info'), join(gd, 'info')]);
      } else {
        writeFileSync(join(gd, 'commondir'), `${s.dir}/elsewhere\n`);
      }
      const r = s.runSanitizer();
      assert.equal(r.status, 2, `${kind}: ${r.status} ${r.stderr}`);
      assert.match(r.stderr, /abgelehnt/i);
      assert.deepEqual(s.backups(), []);
    } finally { s.cleanup(); }
  }
});

test('Gruppen-schreibbare .git/config wird nur-lesbar für andere, Inhalt bleibt', () => {
  const s = setup();
  try {
    const before = s.cfg();
    chmodSync(s.cfgPath, 0o664);
    chmodSync(join(s.inst, '.git'), 0o775);
    const r = s.runSanitizer();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(statSync(s.cfgPath).mode & 0o022, 0);
    assert.equal(statSync(join(s.inst, '.git')).mode & 0o022, 0);
    assert.equal(s.cfg(), before);
    assert.deepEqual(s.backups(), []);
  } finally { s.cleanup(); }
});

test('Aufrufe: vor dem ersten git als root (install.sh, post-update.sh, dvhub-update.sh)', () => {
  const p = read('post-update.sh');
  const pCall = p.indexOf('\ndvhub_sanitize_git_config "$INSTALL_DIR"');
  assert.ok(pCall > 0 && pCall < p.indexOf('\ndvhub_root_own_install_dir "$INSTALL_DIR"'), 'post-update.sh: vor dem Rechte-Schritt (rev-parse)');
  const i = read('install.sh');
  const step = i.slice(i.indexOf('echo "[4/7] Repository bereitstellen"'), i.indexOf('remove_legacy_app_dir\n'));
  const iCall = step.indexOf('dvhub_sanitize_git_config "$INSTALL_DIR"');
  assert.ok(iCall > 0 && iCall < step.indexOf('dvhub_root_own_install_dir "$INSTALL_DIR"') && iCall < step.indexOf('igit fetch'), 'install.sh: vor Rechte-Schritt und fetch');
  const u = read('dvhub-update.sh');
  const uCall = u.indexOf('dvhub_sanitize_git_config "$INSTALL_DIR"');
  assert.ok(uCall > 0 && uCall < u.indexOf('g fetch --tags'), 'dvhub-update.sh: vor fetch');
  // Byte-gleich in allen drei Dateien (tests/sudoers-drift.mjs prüft das in CI).
  assert.equal(sanitizerBlock('install.sh'), sanitizerBlock('post-update.sh'));
  assert.equal(sanitizerBlock('dvhub-update.sh'), sanitizerBlock('post-update.sh'));
});

// ── Gegenprüfung b2274d8b (3× P1) ──
// P1: ein Fernstellenname wie „--upload-pack=<nutzlast>“ mit promisor=true —
// beim Nachladen fehlender Objekte (Teil-Klon) reicht git den Namen an ein
// inneres `git fetch` weiter, das ihn als Option liest: Nutzlast als root.
function partialCloneRig() {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-gitcfg-pc-'));
  writeFileSync(join(dir, 'gitconfig-global'), '');
  const env = baseEnv(dir);
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();
  const up = join(dir, 'up');
  git(dir, 'init', '-q', '-b', 'main', up);
  writeFileSync(join(up, 'post-update.sh'), '#!/bin/bash\n# DVHUB_ROOT_OWNED_INSTALL\n');
  writeFileSync(join(up, 'a.txt'), 'a\n');
  git(up, 'add', '.'); git(up, 'commit', '-qm', '1'); git(up, 'tag', 'v1.0.0');
  writeFileSync(join(up, 'a.txt'), 'b\n'); writeFileSync(join(up, 'c.txt'), 'c\n');
  git(up, 'add', '.'); git(up, 'commit', '-qm', '2'); git(up, 'tag', 'v1.1.0');
  const origin = join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', up, origin);
  git(origin, 'config', 'uploadpack.allowFilter', 'true');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const inst = join(dir, 'opt');
  git(dir, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, inst);
  git(inst, 'checkout', '-q', '--detach', 'v1.0.0');
  const marker = join(dir, 'MARK');
  const pay = join(dir, 'pay.sh');
  writeFileSync(pay, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  chmodSync(pay, 0o755);
  const cfg = join(inst, '.git', 'config');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('[remote "origin"]', `[remote "--upload-pack=${pay}"]`));
  return { dir, env, git, inst, marker, cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('Gegenprobe: Fernstellenname als Option (promisor) führt beim Auschecken die Nutzlast aus — auch mit den -c-Schaltern', () => {
  const r = partialCloneRig();
  try {
    spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', r.inst, 'checkout', '-q', '--detach', 'v1.1.0'], { encoding: 'utf8', env: r.env, timeout: 20000 });
    assert.ok(existsSync(r.marker), 'ohne Bereinigung läuft die Nutzlast — sonst beweist der nächste Test nichts');
  } finally { r.cleanup(); }
});

test('Fernstellenname, branch.*.remote oder extensions.partialclone mit „-“ am Anfang: abgelehnt, nichts geändert, keine Nutzlast', () => {
  const r = partialCloneRig();
  try {
    const before = readFileSync(r.cfg, 'utf8');
    const s = spawnSync('bash', ['-c', `set -euo pipefail\n${sanitizerBlock()}\ndvhub_sanitize_git_config "$1"`, 'x', r.inst], { encoding: 'utf8', env: r.env });
    assert.equal(s.status, 2, s.stderr);
    assert.match(s.stderr, /abgelehnt/);
    assert.match(s.stderr, /Fernstellenname|Fernstelle/);
    assert.doesNotMatch(s.stderr, /pay\.sh/, 'Name nicht im Log');
    assert.equal(readFileSync(r.cfg, 'utf8'), before);
    const h = spawnSync('bash', [UPDATE_SCRIPT, 'checkout-tag', 'v1.1.0'], {
      encoding: 'utf8', timeout: 30000,
      env: { ...r.env, DVHUB_UPDATE_TEST_INSTALL_DIR: r.inst, DVHUB_UPDATE_TEST_EUID: '0', DVHUB_UPDATE_TEST_LOCK: join(r.dir, 'l'), DVHUB_UPDATE_TEST_RESTART_FLAG: join(r.dir, 'f') },
    });
    assert.equal(h.status, 5, h.stderr);
    assert.equal(existsSync(r.marker), false);
  } finally { r.cleanup(); }
  for (const [key, value] of [['branch.main.remote', '--upload-pack=/x'], ['extensions.partialclone', '-x']]) {
    const s = setup();
    try {
      s.set(key, value);
      const before = s.cfg();
      const out = s.runSanitizer();
      assert.equal(out.status, 2, `${key}: ${out.stderr}`);
      assert.match(out.stderr, new RegExp(key.replace(/\./g, '\\.'), 'i'));
      assert.equal(s.cfg(), before);
    } finally { s.cleanup(); }
  }
});

test('ein unveränderter Teil-Klon (--filter=blob:none) bleibt Byte für Byte gleich und lässt sich aktualisieren', () => {
  const r = partialCloneRig();
  try {
    // Name zurück auf origin: ein gewöhnlicher Teil-Klon.
    writeFileSync(r.cfg, readFileSync(r.cfg, 'utf8').replace(/\[remote "--upload-pack=[^"]*"\]/, '[remote "origin"]'));
    const before = readFileSync(r.cfg, 'utf8');
    const s = spawnSync('bash', ['-c', `set -euo pipefail\n${sanitizerBlock()}\ndvhub_sanitize_git_config "$1"`, 'x', r.inst], { encoding: 'utf8', env: r.env });
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.stdout + s.stderr, '');
    assert.equal(readFileSync(r.cfg, 'utf8'), before);
    const h = spawnSync('bash', [UPDATE_SCRIPT, 'checkout-tag', 'v1.1.0'], {
      encoding: 'utf8', timeout: 30000,
      env: { ...r.env, DVHUB_UPDATE_TEST_INSTALL_DIR: r.inst, DVHUB_UPDATE_TEST_EUID: '0', DVHUB_UPDATE_TEST_LOCK: join(r.dir, 'l'), DVHUB_UPDATE_TEST_RESTART_FLAG: join(r.dir, 'f') },
    });
    assert.equal(h.status, 0, h.stderr);
    assert.equal(readFileSync(join(r.inst, 'c.txt'), 'utf8'), 'c\n');
  } finally { r.cleanup(); }
});

// P1: auf einer Altbox kann der Dienstbenutzer einen schreibbaren Deskriptor auf
// .git/config offen halten; chown/chmod nehmen ihn ihm nicht. Darum geht der
// geprüfte Schnappschuss als neue Datei (neue Inode) an seinen Platz, auch wenn
// nichts zu entfernen war — Inhalt Byte für Byte gleich, keine Sicherung.
test('Datei war fremd/gruppen-schreibbar: geprüfter Inhalt kommt als neue Inode, Byte für Byte gleich, ohne Sicherung', () => {
  const s = setup();
  try {
    const attr = join(s.inst, '.git', 'info', 'attributes');
    writeFileSync(attr, '*.bin -diff\n');
    s.git(s.inst, 'config', 'core.repositoryformatversion', '1');
    s.git(s.inst, 'config', 'extensions.worktreeConfig', 'true');
    const wt = join(s.inst, '.git', 'config.worktree');
    writeFileSync(wt, '[core]\n\tfilemode = true\n'); // nur Erlaubtes: keine Sicherung
    s.set('core.sparseCheckout', 'false'); // wird aus config entfernt → dort eine Sicherung
    for (const f of [s.cfgPath, attr]) chmodSync(f, 0o664);
    chmodSync(wt, 0o664);
    const ino = (f) => statSync(f).ino;
    const before = { cfg: ino(s.cfgPath), attr: ino(attr), wt: ino(wt), attrText: readFileSync(attr, 'utf8') };
    const r = s.runSanitizer();
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(ino(attr), before.attr, 'attributes: neue Inode');
    assert.equal(readFileSync(attr, 'utf8'), before.attrText);
    assert.notEqual(ino(wt), before.wt, 'config.worktree: neue Inode');
    assert.notEqual(ino(s.cfgPath), before.cfg, 'config: neue Inode');
    for (const f of [s.cfgPath, attr, wt]) assert.equal(statSync(f).mode & 0o777, 0o644, f);
    // Sicherung nur für config (dort wurde ein Schlüssel entfernt).
    assert.deepEqual(s.backups().map((n) => n.replace(/-\d{8}-\d{6}.*/, '')), ['config.dvhub-bak']);
    assert.deepEqual(s.leftovers(), []);
    // Root-eigene, nur für den Eigentümer schreibbare Dateien bleiben, wo sie sind.
    const again = { cfg: ino(s.cfgPath), attr: ino(attr), wt: ino(wt) };
    assert.equal(s.runSanitizer().status, 0);
    assert.deepEqual({ cfg: ino(s.cfgPath), attr: ino(attr), wt: ino(wt) }, again);
  } finally { s.cleanup(); }
});

// P1: Prüfungen (commondir, Verweise) erst, nachdem der Elternordner gesichert
// ist — sonst legt der Dienstbenutzer .git/commondir zwischen Prüfen und
// Sichern an. Nachgestellt mit einer chmod-Attrappe, die genau dann zuschlägt,
// wenn .git umgestellt wird (letzter Moment, in dem er noch schreiben darf).
test('commondir, das während des Sicherns von .git entsteht, wird erkannt (Prüfen nach dem Sichern)', () => {
  const s = setup();
  try {
    const bin = join(s.dir, 'bin');
    mkdirSync(bin);
    const gd = join(s.inst, '.git');
    const realChmod = execFileSync('bash', ['-c', 'command -v chmod'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'chmod'), `#!/bin/bash\nfor a in "$@"; do [[ "$a" == */.git ]] && echo "${s.dir}/elsewhere" > "$a/commondir"; done\nexec ${realChmod} "$@"\n`);
    chmodSync(join(bin, 'chmod'), 0o755);
    chmodSync(gd, 0o775); // gruppen-schreibbar → wird gesichert
    const r = spawnSync('bash', ['-c', `set -euo pipefail\n${sanitizerBlock()}\ndvhub_sanitize_git_config "$1"`, 'x', s.inst],
      { encoding: 'utf8', env: { ...s.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.ok(existsSync(join(gd, 'commondir')), 'Attrappe hat zugeschlagen');
    assert.equal(r.status, 2, `${r.status} ${r.stderr}`);
    assert.match(r.stderr, /commondir/);
  } finally { s.cleanup(); }
});
