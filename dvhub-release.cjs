#!/usr/bin/node
// dvhub-release — root-eigener Einstieg für signierte Release-Pakete
// (docs/release-pakete.md). Ersetzt auf Paket-Boxen das git-Update
// (dvhub-update). install.sh/post-update.sh kopieren diese Datei nach
// /usr/local/libexec/dvhub-release (root:root 0755) und tragen die Werte unten
// fest ein; die sudoers-Regeln zeigen nur auf diese Kopie und nur auf feste
// Aktionen.
//
// Aufruf (über sudo -n, als Dienstbenutzer aus der Oberfläche):
//   dvhub-release check <stable|dev>              Index prüfen, JSON ausgeben
//   dvhub-release install <version|latest> <stable|dev>   Auftrag starten
//   dvhub-release rollback                        auf die vorige Version
//   dvhub-release status                          Fortschritt/Ergebnis (JSON)
// Nur als root (nicht in sudoers):
//   dvhub-release migrate [--force]               einmalige Umstellung git → Paket
//   dvhub-release boot-hook                       aus post-update.sh: Umstellung
//                                                 planen bzw. unterbrochenen Auftrag fortsetzen
//   dvhub-release recover                         aus dem Notfall-Drop-in der Unit: eine
//                                                 mitten im Verschieben abgebrochene
//                                                 Umstellung sofort zurücknehmen
//   dvhub-release _job install|rollback|migrate|resume …   der eigentliche Auftrag
//                                                 (läuft als eigene systemd-Unit)
//
// Exit: 0 gut, 1 Fehler, 2 Aufruf, 3 abgelehnt (Vorbedingung), 4 läuft bereits.
//
// Nur Bordmittel: node:-Module, tar, ssh-keygen, systemctl, systemd-run, git
// (nur bei der Umstellung). CommonJS ohne Endung, damit Node die Kopie unter
// /usr/local/libexec ohne package.json lädt.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

// Fest eingetragen beim Installieren (dvhub_install_helper in install.sh und
// post-update.sh ersetzt genau diese Zeilen). Ohne INSTALLED="1" läuft der
// Helfer im Testbetrieb mit Pfaden aus der Umgebung.
let INSTALL_DIR, CONFIG_DIR, SERVICE_USER, SERVICE_NAME, INSTALLED;
INSTALL_DIR="@INSTALL_DIR@"
CONFIG_DIR="@CONFIG_DIR@"
SERVICE_USER="@SERVICE_USER@"
SERVICE_NAME="@SERVICE_NAME@"
INSTALLED="@INSTALLED@"

const DEFAULT_BASE_URL = 'https://github.com/chloepriceless/dvhub/releases/download';
const OFFICIAL_REPO_RE = /^(?:https:\/\/|git:\/\/|ssh:\/\/git@|git@)github\.com[:/]chloepriceless\/dvhub(?:\.git)?\/?$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CHANNELS = ['stable', 'dev'];
const NS_PACKAGE = 'dvhub-release';
const NS_INDEX = 'dvhub-release-index';
const PRINCIPAL = 'dvhub-release';
const MANIFEST = '.dvhub-release.json';
// Entpackt ~90 MB je Release (node_modules, EEBUS-Binary). Vorgabe: aktuelles
// und voriges (Rückweg ohne Download); release.conf keep_releases=2…5.
const KEEP_RELEASES = 2;
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
// Box-Zustand im Programmordner: wird nie verlinkt, verschoben oder gelöscht.
const STATE_ENTRIES = new Set(['releases', 'current', 'eos', 'eos-venv', 'forecast-venv', 'bin', 'ml-models',
  '.legacy-git', '.npm-install-hash', '.root-owned-rev']);
const JOB_UNIT = 'dvhub-release-job';
const MIGRATE_UNIT = 'dvhub-release-migrate';
const RESUME_UNIT = 'dvhub-release-resume';
const MIGRATE_RETRY_S = 24 * 3600;
const MIGRATE_MAX_ATTEMPTS = 5;

class Exit extends Error {
  constructor(code, msg) { super(msg); this.exitCode = code; }
}

// ── Umgebung ────────────────────────────────────────────────────────────────

function settings(env = process.env) {
  const test = INSTALLED !== '1';
  const pick = (testKey, fixed) => (test ? env[testKey] || '' : fixed);
  const installDir = pick('DVHUB_RELEASE_TEST_INSTALL_DIR', INSTALL_DIR);
  const serviceName = test ? (env.DVHUB_RELEASE_TEST_SERVICE_NAME || 'dvhub') : (SERVICE_NAME.startsWith('@') ? 'dvhub' : SERVICE_NAME);
  const s = {
    test,
    installDir,
    serviceName,
    serviceUser: test ? (env.DVHUB_RELEASE_TEST_SERVICE_USER || 'dvhub') : (SERVICE_USER.startsWith('@') ? 'dvhub' : SERVICE_USER),
    configDir: test ? (env.DVHUB_RELEASE_TEST_CONFIG_DIR || '') : (CONFIG_DIR.startsWith('@') ? '/etc/dvhub' : CONFIG_DIR),
    stateDir: pick('DVHUB_RELEASE_TEST_STATE_DIR', '/var/lib/dvhub-release'),
    etcDir: pick('DVHUB_RELEASE_TEST_ETC_DIR', '/etc/dvhub-release'),
    unitFile: test ? (env.DVHUB_RELEASE_TEST_UNIT_FILE || '') : `/etc/systemd/system/${serviceName}.service`,
    dropinDir: test ? (env.DVHUB_RELEASE_TEST_DROPIN_DIR || '') : `/etc/systemd/system/${serviceName}.service.d`,
    lockDir: test ? path.join(env.DVHUB_RELEASE_TEST_STATE_DIR || '/nonexistent', 'lock') : '/run/dvhub-release.lock',
    euid: test ? Number(env.DVHUB_RELEASE_TEST_EUID ?? process.geteuid()) : process.geteuid(),
    systemctl: test ? (env.DVHUB_RELEASE_TEST_SYSTEMCTL || '') : 'systemctl',
    systemdRun: test ? (env.DVHUB_RELEASE_TEST_SYSTEMD_RUN || 'systemd-run') : 'systemd-run',
    healthUrl: test ? (env.DVHUB_RELEASE_TEST_HEALTH_URL || '') : '',
    arch: test ? (env.DVHUB_RELEASE_TEST_ARCH || debArch()) : debArch(),
    sshKeygen: test ? (env.DVHUB_RELEASE_TEST_SSH_KEYGEN || 'ssh-keygen') : '/usr/bin/ssh-keygen',
    self: __filename,
    write: (t) => process.stdout.write(t),
  };
  s.allowedSigners = path.join(s.etcDir, 'allowed_signers');
  s.conf = readConf(path.join(s.etcDir, 'release.conf'));
  s.baseUrl = (s.conf.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
  s.healthTimeoutS = clampInt(test && env.DVHUB_RELEASE_TEST_HEALTH_TIMEOUT_S ? env.DVHUB_RELEASE_TEST_HEALTH_TIMEOUT_S : s.conf.health_timeout_s, 180, test ? 1 : 10, 1800);
  // Abstand der zwei Gesundheitsproben und Takt der Abfrage (Tests: kurz).
  s.stableMs = test && env.DVHUB_RELEASE_TEST_FAST ? 100 : 5000;
  s.pollMs = test && env.DVHUB_RELEASE_TEST_FAST ? 100 : 2000;
  s.migrateDelayS = clampInt(s.conf.migrate_delay_s, 120, 1, 86400);
  s.postUpdateTimeoutS = clampInt(s.conf.post_update_timeout_s, 300, 30, 3600);
  s.keepReleases = clampInt(s.conf.keep_releases, KEEP_RELEASES, 2, 5);
  return s;
}

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}

// release.conf: key=value, nur bekannte Schlüssel. Gehört root (/etc/dvhub-release).
function readConf(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (['base_url', 'health_timeout_s', 'migrate_delay_s', 'post_update_timeout_s', 'migrate_custom_repo', 'keep_releases'].includes(k)) out[k] = v;
  }
  if (out.base_url && !/^https?:\/\/[^\s]+$/.test(out.base_url)) delete out.base_url;
  return out;
}

function debArch(nodeArch = process.arch) {
  return { arm64: 'arm64', arm: 'armhf', x64: 'amd64' }[nodeArch] || nodeArch;
}

// ── Versionen ───────────────────────────────────────────────────────────────

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v || '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] } : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`ungültige Version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : (x.pre.length ? -1 : 1);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p < +q ? -1 : 1; continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

function baseVersion(v) {
  const p = parseVersion(v);
  return p ? `${p.major}.${p.minor}.${p.patch}` : null;
}

// Node-Bereich aus package.json engines: Vergleiche >=, >, <=, <, = (mit
// Leerzeichen verknüpft) sowie ^X.Y.Z; mehr nutzt DVhub nicht.
function satisfiesEngine(range, version) {
  if (!range) return true;
  const ver = String(version).replace(/^v/, '');
  for (const part of String(range).trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=|\^)?v?(\d+(?:\.\d+){0,2})$/.exec(part);
    if (!m) return false;
    const want = m[2].split('.').concat(['0', '0']).slice(0, 3).join('.');
    const c = compareVersions(ver, want);
    const op = m[1] || '=';
    if (op === '>=' && c < 0) return false;
    if (op === '>' && c <= 0) return false;
    if (op === '<=' && c > 0) return false;
    if (op === '<' && c >= 0) return false;
    if (op === '=' && c !== 0) return false;
    if (op === '^' && (c < 0 || parseVersion(ver).major !== parseVersion(want).major)) return false;
  }
  return true;
}

// Version aus dem Label von /health ("v1.0.9+abc1234" → "1.0.9").
function versionFromLabel(label) {
  return String(label || '').replace(/^v/, '').split('+')[0];
}

// ── Argumente ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const usage = () => new Exit(2, 'Aufruf: dvhub-release check <stable|dev> | install <version|latest> <stable|dev> | rollback | status | migrate [--force] | boot-hook | recover');
  const channel = (c) => { if (!CHANNELS.includes(c)) throw new Exit(2, `ungültiger Kanal: ${String(c).slice(0, 20)}`); return c; };
  const version = (v) => {
    if (v === 'latest') return v;
    if (typeof v !== 'string' || v.length > 64 || !VERSION_RE.test(v)) throw new Exit(2, `ungültige Version: ${String(v).slice(0, 64)}`);
    return v;
  };
  switch (action) {
    case 'check':
      if (rest.length !== 1) throw usage();
      return { action, channel: channel(rest[0]) };
    case 'install':
      if (rest.length !== 2) throw usage();
      return { action, version: version(rest[0]), channel: channel(rest[1]) };
    case 'rollback':
    case 'status':
    case 'boot-hook':
    case 'recover':
      if (rest.length) throw usage();
      return { action };
    case 'migrate':
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--force')) throw usage();
      return { action, force: rest[0] === '--force' };
    case '_job': {
      const [job, ...a] = rest;
      if (job === 'install' && a.length === 2) return { action, job, version: version(a[0]), channel: channel(a[1]) };
      if ((job === 'rollback' || job === 'resume') && a.length === 0) return { action, job };
      if (job === 'migrate' && (a.length === 0 || (a.length === 1 && a[0] === '--force'))) return { action, job, force: a[0] === '--force' };
      throw usage();
    }
    default:
      throw usage();
  }
}

// ── Dateien und Zustand ─────────────────────────────────────────────────────

function readJson(file, dflt = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}

function writeJsonAtomic(file, obj, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

function stateFile(s) { return path.join(s.stateDir, 'state.json'); }
function statusFile(s) { return path.join(s.stateDir, 'status.json'); }
function loadState(s) {
  return { format: 1, current: null, previous: null, history: [], trust_version: null, legacy: null, pending: null, migration: null, migrate: { attempts: 0, last_attempt: 0 }, ...readJson(stateFile(s), {}) };
}
function saveState(s, st) { writeJsonAtomic(stateFile(s), st); }

function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return 'unknown'; }
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function releasesDir(s) { return path.join(s.installDir, 'releases'); }
function currentLink(s) { return path.join(s.installDir, 'current'); }

function currentVersion(s) {
  try {
    const t = fs.readlinkSync(currentLink(s));
    const m = /^releases\/([^/]+)$/.exec(t);
    return m && VERSION_RE.test(m[1]) ? m[1] : null;
  } catch { return null; }
}

function releaseManifest(s, version) {
  return readJson(path.join(releasesDir(s), version, MANIFEST));
}

function isPackageLayout(s) {
  return !!currentVersion(s);
}

// ── Status für die Oberfläche ───────────────────────────────────────────────

class Job {
  constructor(s, kind, fields = {}) {
    this.s = s;
    this.status = { job: kind, state: 'running', phase: 'start', message: '', started: new Date().toISOString(), updated: null, finished: null, log: [], ...fields };
    this.write();
  }

  write() {
    this.status.updated = new Date().toISOString();
    try { writeJsonAtomic(statusFile(this.s), this.status); } catch { /* Status ist Beiwerk */ }
  }

  phase(phase, message) {
    this.status.phase = phase;
    this.status.message = message;
    this.log(message);
  }

  log(line) {
    const l = `${new Date().toISOString()} ${line}`;
    this.s.write(`${l}\n`);
    this.status.log = [...this.status.log, l].slice(-30);
    this.write();
  }

  progress(bytes, total) {
    const now = Date.now();
    if (this._last && now - this._last < 1000 && bytes < total) return;
    this._last = now;
    this.status.progress = { bytes, total };
    this.write();
  }

  finish(state, message, extra = {}) {
    Object.assign(this.status, extra, { state, phase: 'done', message, finished: new Date().toISOString() });
    this.log(message);
  }
}

// ── Externe Befehle ─────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message), error: r.error };
  return r;
}

function systemctl(s, ...args) {
  if (!s.systemctl) return { status: 0, stdout: '', stderr: '' };
  return run(s.systemctl, args, { timeout: 240000 });
}

function unitActive(s, unit) {
  return s.systemctl ? systemctl(s, 'is-active', '--quiet', unit).status === 0 : false;
}

// ── Signaturen ──────────────────────────────────────────────────────────────

function trustedKeyCount(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  return text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && /\bssh-ed25519\b|\bssh-rsa\b|\becdsa-sha2-/.test(l)).length;
}

function verifySignature(s, file, sigFile, namespace) {
  if (!trustedKeyCount(s.allowedSigners)) throw new Exit(3, `kein Release-Schlüssel in ${s.allowedSigners} — Pakete werden nicht angenommen`);
  const fd = fs.openSync(file, 'r');
  try {
    const r = run(s.sshKeygen, ['-Y', 'verify', '-f', s.allowedSigners, '-I', PRINCIPAL, '-n', namespace, '-s', sigFile], { stdio: [fd, 'pipe', 'pipe'], timeout: 120000 });
    if (r.status !== 0) throw new Error(`Signatur ungültig (${path.basename(file)}): ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  } finally { fs.closeSync(fd); }
}

// ── Download ────────────────────────────────────────────────────────────────

async function download(url, dest, { maxBytes, expectSize = null, job = null, attempts = 3, idleMs = 60000 }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let have = 0;
    try { have = fs.statSync(dest).size; } catch { have = 0; }
    if (expectSize !== null && have > expectSize) { fs.rmSync(dest, { force: true }); have = 0; }
    if (expectSize !== null && have === expectSize) return;
    const ctrl = new AbortController();
    let idle = setTimeout(() => ctrl.abort(new Error('keine Daten seit 60 s')), idleMs);
    try {
      const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
      const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
      if (res.status === 200) {
        have = 0;
        fs.writeFileSync(dest, '');
      } else if (res.status !== 206) {
        throw new Error(`HTTP ${res.status} für ${url}`);
      }
      const fh = fs.openSync(dest, 'a', 0o600);
      try {
        for await (const chunk of res.body) {
          clearTimeout(idle);
          idle = setTimeout(() => ctrl.abort(new Error('keine Daten seit 60 s')), idleMs);
          have += chunk.length;
          if (have > maxBytes || (expectSize !== null && have > expectSize)) throw new Exit(1, `Download größer als erwartet (${url})`);
          fs.writeSync(fh, chunk);
          if (job && expectSize) job.progress(have, expectSize);
        }
      } finally { fs.closeSync(fh); }
      if (expectSize === null || have === expectSize) return;
      throw new Error(`Download unvollständig (${have}/${expectSize} Bytes)`);
    } catch (e) {
      lastErr = e;
      if (e instanceof Exit || e?.code === 'ENOSPC') {
        fs.rmSync(dest, { force: true });
        throw e.code === 'ENOSPC' ? new Exit(1, 'Speicher voll beim Download') : e;
      }
      if (job) job.log(`Download-Versuch ${attempt}/${attempts} fehlgeschlagen: ${e.message}`);
    } finally {
      clearTimeout(idle);
    }
  }
  throw new Error(`Download fehlgeschlagen: ${lastErr?.message || 'unbekannt'}`);
}

// ── Index ───────────────────────────────────────────────────────────────────

function indexUrl(s, channel) {
  return `${s.baseUrl}/channels/index-${channel}.json`;
}

function stagingDir(s) {
  const d = path.join(s.stateDir, 'staging');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(d, 0o700); } catch { /* */ }
  return d;
}

function validateIndex(idx, channel) {
  if (!idx || idx.format !== 1) throw new Error('Index: unbekanntes Format');
  if (idx.channel !== channel) throw new Error(`Index: Kanal ${idx.channel} statt ${channel}`);
  if (!Array.isArray(idx.releases) || !idx.releases.length) throw new Error('Index: keine Releases');
  for (const r of idx.releases) {
    if (!VERSION_RE.test(String(r.version))) throw new Error(`Index: ungültige Version ${r.version}`);
    for (const a of Object.values(r.artifacts || {})) {
      if (!/^[0-9a-f]{64}$/.test(a.sha256 || '') || !Number.isInteger(a.size) || a.size <= 0 || a.size > MAX_PACKAGE_BYTES
        || typeof a.url !== 'string' || typeof a.sig !== 'string') throw new Error(`Index: Artefakt unvollständig (${r.version})`);
    }
  }
  return idx;
}

// Jeder Abruf in einem eigenen Ordner: `check` läuft ohne Sperre und darf
// einem gleichzeitigen Auftrag die Dateien nicht wegnehmen (Gegenprüfung 67ade305).
async function fetchIndex(s, channel) {
  const dir = fs.mkdtempSync(path.join(stagingDir(s), `index-${channel}-`));
  const url = indexUrl(s, channel);
  const file = path.join(dir, `index-${channel}.json`);
  const sig = `${file}.sig`;
  try {
    await download(url, file, { maxBytes: MAX_INDEX_BYTES, attempts: 2 });
    await download(`${url}.sig`, sig, { maxBytes: 64 * 1024, attempts: 2 });
    verifySignature(s, file, sig, NS_INDEX);
    const idx = validateIndex(readJson(file), channel);
    return { idx, url };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pickRelease(idx, version) {
  const v = version === 'latest' ? idx.latest : version;
  const r = idx.releases.find((x) => x.version === v);
  if (!r) throw new Exit(3, `Version ${v} nicht im Index`);
  return r;
}

// ── Entpacken und Prüfen ────────────────────────────────────────────────────

function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch { return Infinity; }
}

function ensureSpace(s, size) {
  const stage = stagingDir(s);
  fs.mkdirSync(releasesDir(s), { recursive: true });
  const needStage = size + 16 * 1024 * 1024;
  const needRel = size * 5 + 64 * 1024 * 1024;
  if (freeBytes(stage) < needStage) throw new Exit(3, `zu wenig Speicher für den Download (${Math.ceil(needStage / 1048576)} MB nötig in ${stage})`);
  if (freeBytes(releasesDir(s)) < needRel) throw new Exit(3, `zu wenig Speicher zum Entpacken (${Math.ceil(needRel / 1048576)} MB nötig in ${releasesDir(s)})`);
}

// Baum gegen das Manifest: jede Datei da, Hash und Modus stimmen, nichts
// zusätzlich, Symlinks bleiben im Release.
function verifyTree(root, manifest) {
  const want = new Map(manifest.files.map((f) => [f.path, f]));
  const seen = new Set();
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const r = rel ? `${rel}/${name}` : name;
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) { walk(abs, r); continue; }
      if (r === MANIFEST) continue;
      const f = want.get(r);
      if (!f) throw new Error(`zusätzliche Datei im Paket: ${r}`);
      seen.add(r);
      if (f.type === 'symlink') {
        if (!st.isSymbolicLink() || fs.readlinkSync(abs) !== f.target) throw new Error(`Symlink weicht ab: ${r}`);
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(r), f.target));
        if (path.posix.isAbsolute(f.target) || resolved.startsWith('../')) throw new Error(`Symlink zeigt aus dem Paket: ${r}`);
      } else {
        if (!st.isFile()) throw new Error(`keine Datei: ${r}`);
        if (st.size !== f.size || sha256File(abs) !== f.sha256) throw new Error(`Prüfsumme weicht ab: ${r}`);
        const x = (st.mode & 0o111) !== 0;
        if (x !== (f.mode === '0755')) throw new Error(`Modus weicht ab: ${r}`);
      }
    }
  };
  walk(root, '');
  for (const p of want.keys()) if (!seen.has(p)) throw new Error(`Datei fehlt im Paket: ${p}`);
}

function unpack(s, tarball, version, { channel, job }) {
  const rel = releasesDir(s);
  fs.mkdirSync(rel, { recursive: true, mode: 0o755 });
  const partial = path.join(rel, `.${version}.partial`);
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { mode: 0o755 });
  try {
    const r = run('tar', ['-xzf', tarball, '-C', partial, '--no-same-owner', '--no-same-permissions'], { timeout: 600000 });
    if (r.status !== 0) {
      if (/No space left/i.test(r.stderr)) throw new Exit(1, 'Speicher voll beim Entpacken');
      throw new Error(`Entpacken fehlgeschlagen: ${(r.stderr || '').trim().split('\n').pop()}`);
    }
    const manifest = readJson(path.join(partial, MANIFEST));
    if (!manifest || manifest.format !== 1 || !Array.isArray(manifest.files)) throw new Error('Manifest fehlt oder ist ungültig');
    if (manifest.version !== version) throw new Error(`Manifest nennt Version ${manifest.version} statt ${version}`);
    if (manifest.arch !== s.arch) throw new Error(`Paket für ${manifest.arch}, Box ist ${s.arch}`);
    if (channel && manifest.channel !== channel) throw new Error(`Paket aus Kanal ${manifest.channel} statt ${channel}`);
    if (!satisfiesEngine(manifest.node_engine, process.version)) throw new Exit(3, `Node ${process.version} passt nicht zu ${manifest.node_engine}`);
    job?.phase('verify-files', `${manifest.files.length} Dateien gegen das Manifest prüfen`);
    verifyTree(partial, manifest);
    if (!s.test) run('chown', ['-R', '0:0', partial]);
    const final = path.join(rel, version);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(partial, final);
    return manifest;
  } catch (e) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw e;
  }
}

// Paket holen, prüfen, nach releases/<v> entpacken. Gibt das Manifest zurück.
async function fetchAndUnpack(s, job, { channel, version, index = null }) {
  if (!index) job.phase('index', `Kanal-Index ${channel} laden`);
  const { idx, url } = index || await fetchIndex(s, channel);
  const rel = pickRelease(idx, version);
  const art = rel.artifacts?.[s.arch];
  if (!art) throw new Exit(3, `kein Paket für ${s.arch} in ${rel.version}`);
  ensureSpace(s, art.size);
  const dir = stagingDir(s);
  const file = path.join(dir, `dvhub-${rel.version}-${s.arch}.tar.gz`);
  const sig = `${file}.sig`;
  try {
    job.status.version = rel.version;
    job.phase('download', `Paket ${rel.version} (${(art.size / 1048576).toFixed(1)} MB) laden`);
    await download(new URL(art.url, url).href, file, { maxBytes: MAX_PACKAGE_BYTES, expectSize: art.size, job });
    fs.rmSync(sig, { force: true });
    await download(new URL(art.sig, url).href, sig, { maxBytes: 64 * 1024 });
    job.phase('verify', 'Prüfsumme und Signatur prüfen');
    if (sha256File(file) !== art.sha256) {
      fs.rmSync(file, { force: true });
      throw new Error('Prüfsumme des Pakets stimmt nicht');
    }
    verifySignature(s, file, sig, NS_PACKAGE);
    job.phase('unpack', `nach releases/${rel.version} entpacken`);
    const manifest = unpack(s, file, rel.version, { channel, job });
    return { manifest, release: rel };
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(sig, { force: true });
  }
}

// ── Umschalten, Links, Dienst ───────────────────────────────────────────────

function switchCurrent(s, version) {
  const link = currentLink(s);
  const tmp = path.join(s.installDir, `.current.tmp-${process.pid}`);
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(`releases/${version}`, tmp);
  fs.renameSync(tmp, link);
}

// /opt/dvhub/<eintrag> → current/<eintrag> für jeden Eintrag der obersten
// Paketebene; tote Links (Eintrag fehlt im aktuellen Release) weg. Echte
// Dateien und Ordner bleiben unangetastet.
function reconcileLinks(s, log = () => {}) {
  const cur = currentLink(s);
  let names = [];
  try { names = fs.readdirSync(cur).filter((n) => !n.startsWith('.')); } catch { return; }
  for (const n of names) {
    if (STATE_ENTRIES.has(n)) continue;
    const p = path.join(s.installDir, n);
    let st = null;
    try { st = fs.lstatSync(p); } catch { st = null; }
    if (!st) { fs.symlinkSync(`current/${n}`, p); continue; }
    if (st.isSymbolicLink() && fs.readlinkSync(p) === `current/${n}`) continue;
    log(`Hinweis: ${p} ist kein Verweis auf current/${n} — bleibt unverändert`);
  }
  for (const n of fs.readdirSync(s.installDir)) {
    const p = path.join(s.installDir, n);
    try {
      if (fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p).startsWith('current/') && !fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* */ }
  }
}

function unitEnv(s, key) {
  try {
    const m = new RegExp(`^Environment=${key}=(.*)$`, 'm').exec(fs.readFileSync(s.unitFile, 'utf8'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function configPath(s) {
  return unitEnv(s, 'DV_APP_CONFIG') || path.join(s.configDir || '/etc/dvhub', 'config.json');
}

function readChannel(s) {
  const c = readJson(configPath(s), {})?.updateChannel;
  return CHANNELS.includes(c) ? c : 'stable';
}

function healthUrl(s) {
  if (s.healthUrl) return s.healthUrl;
  const port = Number(readJson(configPath(s), {})?.httpPort) || 8080;
  return `http://127.0.0.1:${port}/health`;
}

// Host-Kopf für die Probe: DVhub prüft den Host vor allem anderen (auch vor
// /health). Ist allowedHosts gesetzt, wird 127.0.0.1 abgewiesen — dann den
// ersten erlaubten Namen schicken, verbunden wird trotzdem lokal
// (Gegenprüfung 67ade305).
function healthHost(s, url) {
  const allowed = readJson(configPath(s), {})?.allowedHosts;
  if (Array.isArray(allowed) && allowed.length && typeof allowed[0] === 'string' && /^[A-Za-z0-9.:[\]-]+$/.test(allowed[0])) return allowed[0];
  return new URL(url).host;
}

function httpGet(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => { if (chunks.length < 64) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ status: 0, error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
  });
}

async function healthOnce(s, expect) {
  const url = healthUrl(s);
  const r = await httpGet(url, { Host: healthHost(s, url) }, 5000);
  if (r.status !== 200) return { ok: false, why: r.error || `HTTP ${r.status}` };
  let j = null;
  try { j = JSON.parse(r.body); } catch { return { ok: false, why: 'keine JSON-Antwort' }; }
  if (j?.ok !== true) return { ok: false, why: 'ok != true' };
  if (expect && versionFromLabel(j.version) !== expect) return { ok: false, why: `läuft ${j.version}, erwartet ${expect}` };
  return { ok: true, label: j.version };
}

// Gesund = zweimal im Abstand von 5 s ok mit der erwarteten Version und die
// Unit aktiv (fängt Absturzschleifen ab).
// Neustarts der Unit laut systemd (Restart=always): eine Absturzschleife
// erkennt die Prüfung daran, statt die volle Wartezeit abzusitzen.
function nRestarts(s) {
  if (!s.systemctl) return null;
  const out = String(systemctl(s, 'show', '-p', 'NRestarts', '--value', `${s.serviceName}.service`).stdout || '').trim();
  return /^\d+$/.test(out) ? Number(out) : null;
}

async function waitHealthy(s, expect, job) {
  const deadline = Date.now() + s.healthTimeoutS * 1000;
  const base = nRestarts(s);
  let last = '';
  while (Date.now() < deadline) {
    const n = nRestarts(s);
    if (base !== null && n !== null && n - base >= 3) {
      job?.log(`Gesundheitsprüfung abgebrochen: ${n - base} Neustarts des Dienstes (Absturzschleife)`);
      return false;
    }
    const h = await healthOnce(s, expect);
    if (h.ok) {
      await sleep(s.stableMs);
      const h2 = await healthOnce(s, expect);
      const active = !s.systemctl || unitActive(s, `${s.serviceName}.service`);
      if (h2.ok && active) return true;
      last = h2.ok ? 'Dienst nicht aktiv' : h2.why;
    } else {
      last = h.why;
    }
    await sleep(s.pollMs);
  }
  job?.log(`Gesundheitsprüfung gescheitert: ${last}`);
  return false;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function runPostUpdate(s, job) {
  const script = path.join(currentLink(s), 'post-update.sh');
  if (!fs.existsSync(script)) { job.log('post-update.sh fehlt im Release — übersprungen'); return; }
  const r = run(fs.existsSync('/usr/bin/bash') ? '/usr/bin/bash' : '/bin/bash', [script], {
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8', INSTALL_DIR: s.installDir, SERVICE_NAME: s.serviceName, DVHUB_START_BUDGET_S: String(s.postUpdateTimeoutS) },
    timeout: s.postUpdateTimeoutS * 1000 + 30000,
  });
  for (const line of `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-15)) if (line) job.log(`  post-update: ${line}`);
  if (r.status !== 0) job.log(`post-update.sh endete mit ${r.status} (nicht fatal, die Gesundheitsprüfung entscheidet)`);
}

function restartService(s, job) {
  job.phase('restart', `${s.serviceName} neu starten`);
  const r = systemctl(s, 'restart', `${s.serviceName}.service`);
  if (r.status !== 0) job.log(`systemctl restart: ${(r.stderr || '').trim()}`);
}

function updateTrust(s, st, version, job) {
  const src = path.join(releasesDir(s), version, 'release-keys', 'allowed_signers');
  if (!fs.existsSync(src) || !trustedKeyCount(src)) return;
  if (st.trust_version && compareVersions(version, st.trust_version) <= 0) return;
  const now = fs.existsSync(s.allowedSigners) ? fs.readFileSync(s.allowedSigners) : null;
  const next = fs.readFileSync(src);
  if (!now || !now.equals(next)) {
    fs.mkdirSync(s.etcDir, { recursive: true, mode: 0o755 });
    const tmp = `${s.allowedSigners}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next, { mode: 0o644 });
    fs.renameSync(tmp, s.allowedSigners);
    job.log(`Vertrauensdatei aus ${version} übernommen (${trustedKeyCount(s.allowedSigners)} Schlüssel)`);
  }
  st.trust_version = version;
}

function pruneReleases(s, st, job) {
  const keep = new Set([st.current, st.previous].filter(Boolean));
  const order = [...st.history].reverse().map((h) => h.version);
  for (const v of order) {
    if (keep.size >= s.keepReleases) break;
    if (fs.existsSync(path.join(releasesDir(s), v))) keep.add(v);
  }
  let names = [];
  try { names = fs.readdirSync(releasesDir(s)); } catch { return; }
  for (const n of names) {
    if (keep.has(n)) continue;
    fs.rmSync(path.join(releasesDir(s), n), { recursive: true, force: true });
    job.log(`altes Release ${n} entfernt`);
  }
}

function removeLegacy(s, st, job) {
  if (!st.legacy?.dir || fs.existsSync(path.join(s.etcDir, 'keep-legacy-git'))) return;
  const dir = path.join(s.installDir, '.legacy-git');
  if (st.legacy.dir === dir) fs.rmSync(dir, { recursive: true, force: true });
  job.log('alter git-Checkout (.legacy-git) entfernt');
  st.legacy = null;
}

// ── Sperre ──────────────────────────────────────────────────────────────────

function lockHeld(s) {
  const pid = Number(readJson(path.join(s.lockDir, 'owner'), {})?.pid);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lock(s) {
  try {
    fs.mkdirSync(s.lockDir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(readJson(path.join(s.lockDir, 'owner'), {})?.pid);
    let alive = false;
    try { if (pid) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
    if (alive) throw new Exit(4, 'ein anderer Update-Auftrag läuft bereits');
    fs.rmSync(s.lockDir, { recursive: true, force: true });
    fs.mkdirSync(s.lockDir);
  }
  fs.writeFileSync(path.join(s.lockDir, 'owner'), JSON.stringify({ pid: process.pid }));
  return () => fs.rmSync(s.lockDir, { recursive: true, force: true });
}

// ── Aufträge ────────────────────────────────────────────────────────────────

function record(st, version, result) {
  st.history = [...(st.history || []), { version, at: new Date().toISOString(), result }].slice(-20);
}

// Gemeinsamer Teil von install/rollback: umschalten, einrichten, neu starten,
// prüfen; bei Misserfolg zurück auf from.
async function switchAndVerify(s, st, job, { to, from, op }) {
  st.pending = { op, version: to, previous: from, boot_id: bootId(), at: new Date().toISOString() };
  saveState(s, st);
  job.phase('switch', `current → ${to}`);
  switchCurrent(s, to);
  reconcileLinks(s, (l) => job.log(l));
  job.phase('provision', 'post-update.sh des neuen Stands (Hilfsskripte, sudoers, Provisionierung)');
  runPostUpdate(s, job);
  restartService(s, job);
  job.phase('health', `Gesundheitsprüfung (${s.healthTimeoutS} s)`);
  if (await waitHealthy(s, to, job)) {
    st.previous = from;
    st.current = to;
    st.pending = null;
    record(st, to, 'ok');
    saveState(s, st);
    return true;
  }
  job.phase('rollback', `nicht gesund — zurück auf ${from}`);
  switchCurrent(s, from);
  reconcileLinks(s, (l) => job.log(l));
  restartService(s, job);
  const back = await waitHealthy(s, from, job);
  st.current = from;
  st.pending = null;
  record(st, to, back ? 'rolled_back' : 'failed');
  saveState(s, st);
  job.log(back ? `${from} läuft wieder` : `Achtung: auch ${from} meldet sich nicht gesund`);
  return false;
}

// Abschluss eines erfolgreichen Updates: Vertrauen, alter Checkout, Aufräumen.
function finalizeInstall(s, st, version, job) {
  updateTrust(s, st, version, job);
  removeLegacy(s, st, job);
  pruneReleases(s, st, job);
  saveState(s, st);
}

async function jobInstall(s, job, { version, channel }) {
  const st = loadState(s);
  const from = currentVersion(s);
  if (!from) throw new Exit(3, 'keine Paket-Installation (git-Box: Umstellung läuft über migrate)');
  st.current = from;
  if (version !== 'latest' && version === from) { job.finish('ok', `${from} ist bereits installiert`, { result: 'up_to_date' }); return; }
  job.phase('index', `Kanal-Index ${channel} laden`);
  const index = await fetchIndex(s, channel);
  const target = version === 'latest' ? index.idx.latest : version;
  if (target === from) { job.finish('ok', `${from} ist bereits aktuell`, { result: 'up_to_date', version: from }); return; }
  const curManifest = releaseManifest(s, from);
  if (curManifest?.channel === channel && compareVersions(target, from) < 0) {
    throw new Exit(3, `${target} ist älter als ${from} — dafür gibt es „rollback“`);
  }
  const { manifest } = await fetchAndUnpack(s, job, { channel, version: target, index });
  if (await switchAndVerify(s, st, job, { to: manifest.version, from, op: 'install' })) {
    finalizeInstall(s, st, manifest.version, job);
    job.finish('ok', `${manifest.version} installiert und gesund`, { result: 'ok', version: manifest.version, from });
  } else {
    fs.rmSync(path.join(releasesDir(s), manifest.version), { recursive: true, force: true });
    job.finish('rolled_back', `${manifest.version} war nicht gesund — ${from} läuft wieder`, { result: 'rolled_back', version: manifest.version, from });
  }
}

async function jobRollback(s, job) {
  const st = loadState(s);
  const from = currentVersion(s);
  if (!from) throw new Exit(3, 'keine Paket-Installation');
  const to = st.previous;
  if (!to || to === from || !fs.existsSync(path.join(releasesDir(s), to, MANIFEST))) throw new Exit(3, 'keine vorige Version vorhanden');
  job.status.version = to;
  if (await switchAndVerify(s, st, job, { to, from, op: 'rollback' })) {
    job.finish('ok', `zurück auf ${to}`, { result: 'ok', version: to, from });
  } else {
    job.finish('failed', `Rückweg auf ${to} nicht gesund — ${from} läuft wieder`, { result: 'failed', version: to, from });
  }
}

// ── Umstellung git → Paket ──────────────────────────────────────────────────

function git(s, ...args) {
  return run('git', ['-c', `safe.directory=${s.installDir}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', s.installDir, ...args], { timeout: 60000 });
}

// Ob und warum (nicht) umgestellt wird. Gibt { ok, reason, channel, gitVersion } zurück.
function migrationCheck(s, { force = false } = {}) {
  if (isPackageLayout(s)) return { ok: false, reason: 'already_package' };
  if (!fs.existsSync(path.join(s.installDir, '.git'))) return { ok: false, reason: 'no_git_checkout' };
  if (!trustedKeyCount(s.allowedSigners)) return { ok: false, reason: 'no_release_key' };
  const dataDir = unitEnv(s, 'DV_DATA_DIR') || '/var/lib/dvhub';
  if (!force && fs.existsSync(path.join(dataDir, '.no-release-packages'))) return { ok: false, reason: 'opt_out' };
  const origin = (git(s, 'config', '--get', 'remote.origin.url').stdout || '').trim();
  if (!force && !OFFICIAL_REPO_RE.test(origin) && s.conf.migrate_custom_repo !== '1') return { ok: false, reason: 'custom_repo', origin };
  const dirty = (git(s, 'status', '--porcelain', '--untracked-files=no').stdout || '').trim();
  if (!force && dirty) return { ok: false, reason: 'local_changes', files: dirty.split('\n').slice(0, 10) };
  const unit = (() => { try { return fs.readFileSync(s.unitFile, 'utf8'); } catch { return ''; } })();
  if (!unit.includes(`${s.installDir}/dvhub`)) return { ok: false, reason: 'unit_unexpected' };
  const gitVersion = readJson(path.join(s.installDir, 'dvhub', 'package.json'), {})?.version || null;
  return { ok: true, channel: readChannel(s), gitVersion, origin };
}

function rewriteUnit(s, text) {
  const cur = `${s.installDir}/current`;
  return text
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${cur}/dvhub`)
    .replace(/^ExecStartPre=(.*?)\S*\/post-update\.sh[ \t]*$/m, (_m, pre) => `ExecStartPre=${pre}${cur}/post-update.sh`)
    .replace(/^ExecStart=\/usr\/bin\/node .*server\.js[ \t]*$/m, `ExecStart=/usr/bin/node ${cur}/dvhub/server.js`);
}

function revertMigration(s, st, job, { reload = true } = {}) {
  const m = st.migration;
  if (!m) return;
  job.log('Umstellung zurücknehmen');
  // Eintrag, dessen Verschieben ein Abbruch unterbrochen hat (Journal: moving).
  if (m.moving && !(m.moved || []).includes(m.moving)) {
    const from = path.join(m.legacy, m.moving);
    const to = path.join(s.installDir, m.moving);
    if (fs.existsSync(from) || isLink(from)) {
      try { if (isLink(to)) fs.unlinkSync(to); } catch { /* */ }
      if (!fs.existsSync(to)) fs.renameSync(from, to);
    }
  }
  for (const n of [...(m.linked || [])].reverse()) {
    const p = path.join(s.installDir, n);
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* */ }
  }
  for (const n of [...(m.moved || [])].reverse()) {
    const from = path.join(m.legacy, n);
    const to = path.join(s.installDir, n);
    try { if (fs.lstatSync(to).isSymbolicLink()) fs.unlinkSync(to); } catch { /* */ }
    if (fs.existsSync(from) || isLink(from)) fs.renameSync(from, to);
  }
  try { fs.rmdirSync(m.legacy); } catch { /* nicht leer: bleibt zur Diagnose */ }
  try { fs.unlinkSync(currentLink(s)); } catch { /* */ }
  if (m.unit_backup && fs.existsSync(m.unit_backup)) writeFileAtomic(s.unitFile, fs.readFileSync(m.unit_backup));
  removeDropin(s, job, { reload: false });
  if (reload) systemctl(s, 'daemon-reload');
  if (m.version) fs.rmSync(path.join(releasesDir(s), m.version), { recursive: true, force: true });
  st.migration = null;
  saveState(s, st);
}

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

// Notfall-Drop-in für die Zeit des Verschiebens (Gegenprüfung 67ade305): fällt
// der Strom, während der Checkout halb verschoben ist, fehlen der Unit evtl.
// post-update.sh und der Arbeitsordner. Das Drop-in hängt einen Vorlauf an,
// der nicht im Programmordner liegt (dvhub-release recover), und duldet einen
// fehlenden Arbeitsordner — recover stellt den git-Stand her, bevor ExecStart
// den Pfad braucht.
const DROPIN_NAME = '05-dvhub-release-recover.conf';
// Drop-ins hängen ExecStartPre= hinten an. Darum erst die Liste leeren, dann
// recover, dann die Vorläufe der Unit — sonst liefe post-update.sh noch auf dem
// halb verschobenen Stand (Gegenprüfung 68409be5).
function dropinContent(s, unitText) {
  const pre = String(unitText).split('\n').filter((l) => /^ExecStartPre=./.test(l));
  return ['# Von dvhub-release während der Umstellung git → Paket angelegt; danach wieder entfernt.', '[Service]',
    `WorkingDirectory=-${s.installDir}/dvhub`, 'ExecStartPre=', `ExecStartPre=-+${s.self} recover`, ...pre, ''].join('\n');
}
function writeDropin(s, job) {
  if (!s.dropinDir) return;
  fs.mkdirSync(s.dropinDir, { recursive: true, mode: 0o755 });
  writeFileAtomic(path.join(s.dropinDir, DROPIN_NAME), dropinContent(s, fs.readFileSync(s.unitFile, 'utf8')));
  systemctl(s, 'daemon-reload');
  job.log('Notfall-Drop-in für die Unit angelegt');
}
function removeDropin(s, job, { reload = true } = {}) {
  if (!s.dropinDir) return;
  const f = path.join(s.dropinDir, DROPIN_NAME);
  if (!fs.existsSync(f)) return;
  fs.rmSync(f, { force: true });
  try { fs.rmdirSync(s.dropinDir); } catch { /* andere Drop-ins bleiben */ }
  if (reload) systemctl(s, 'daemon-reload');
  job?.log?.('Notfall-Drop-in entfernt');
}

async function jobMigrate(s, job, { force }) {
  const st = loadState(s);
  st.migrate = { attempts: 0, last_attempt: 0, ...st.migrate };
  const chk = migrationCheck(s, { force });
  if (!chk.ok) {
    st.migrate.skipped = chk.reason;
    saveState(s, st);
    job.finish('skipped', `Umstellung nicht ausgeführt: ${chk.reason}${chk.origin ? ` (${chk.origin})` : ''}`, { result: 'skipped', reason: chk.reason });
    return;
  }
  // Versuch zählen, bevor etwas schiefgehen kann (Index offline, Signatur):
  // sonst versuchte es die Box bei jedem Start erneut (Gegenprüfung da65a346).
  // Nur „Paket älter als der Checkout“ nimmt den Zähler unten zurück.
  const before = { attempts: st.migrate.attempts, last_attempt: st.migrate.last_attempt };
  st.migrate.attempts += 1;
  st.migrate.last_attempt = Math.floor(Date.now() / 1000);
  delete st.migrate.skipped;
  saveState(s, st);
  const gitSha = (git(s, 'rev-parse', 'HEAD').stdout || '').trim();
  job.log(`git-Stand ${chk.gitVersion} (${gitSha.slice(0, 7)}), Kanal ${chk.channel}`);
  job.phase('index', `Kanal-Index ${chk.channel} laden`);
  const index = await fetchIndex(s, chk.channel);
  const target = index.idx.latest;
  // Älteres Paket als der Checkout: warten, nicht zurücknehmen — und kein
  // Fehlversuch (sonst gäbe die Box nach fünf Tagen auf; Gegenprüfung 68409be5).
  // Gleiche package.json-Version heißt nicht gleicher Stand (dev: main ist
  // weiter als das letzte Paket) — darum auch die Commit-Zeit (67ade305).
  const headTime = Number((git(s, 'log', '-1', '--format=%ct', 'HEAD').stdout || '').trim());
  const relDate = Date.parse(index.idx.releases.find((r) => r.version === target)?.date || '') / 1000;
  let older = '';
  if (chk.gitVersion && baseVersion(target) && compareVersions(baseVersion(target), baseVersion(chk.gitVersion)) < 0) {
    older = `Paket ${target} ist älter als der git-Stand ${chk.gitVersion}`;
  } else if (Number.isFinite(headTime) && headTime > 0 && Number.isFinite(relDate) && relDate < headTime) {
    older = `Paket ${target} (Stand ${new Date(relDate * 1000).toISOString()}) ist älter als der git-Checkout (${new Date(headTime * 1000).toISOString()})`;
  }
  if (older && !force) {
    Object.assign(st.migrate, before);
    st.migrate.skipped = 'package_older';
    st.migrate.last_check = Math.floor(Date.now() / 1000);
    saveState(s, st);
    job.finish('skipped', `${older} — Umstellung wartet auf ein neueres Paket`, { result: 'skipped', reason: 'package_older' });
    return;
  }
  const { manifest } = await fetchAndUnpack(s, job, { channel: chk.channel, version: target, index });
  const version = manifest.version;

  // Ab hier Journal in state.json: ein Abbruch lässt sich mit resume zurücknehmen.
  const legacy = path.join(s.installDir, '.legacy-git');
  const unitBackup = path.join(s.stateDir, `${s.serviceName}.service.git-backup`);
  fs.copyFileSync(s.unitFile, unitBackup);
  st.migration = { phase: 'moving', version, legacy, moved: [], linked: [], unit_backup: unitBackup, git_sha: gitSha, git_version: chk.gitVersion, boot_id: bootId(), at: new Date().toISOString() };
  saveState(s, st);
  try {
    job.phase('switch', `alten Checkout nach .legacy-git, current → ${version}`);
    writeDropin(s, job);
    fs.rmSync(legacy, { recursive: true, force: true });
    fs.mkdirSync(legacy, { mode: 0o755 });
    switchCurrent(s, version);
    const tracked = new Set((git(s, 'ls-tree', '--name-only', 'HEAD').stdout || '').split('\n').filter(Boolean));
    tracked.add('.git');
    const relTop = new Set(fs.readdirSync(path.join(releasesDir(s), version)).filter((n) => !n.startsWith('.')));
    for (const n of fs.readdirSync(s.installDir)) {
      if (STATE_ENTRIES.has(n) || n.startsWith('.current.tmp')) continue;
      if (!tracked.has(n) && !relTop.has(n)) continue;
      // Erst das Vorhaben ins Journal, dann verschieben (Gegenprüfung 67ade305).
      st.migration.moving = n;
      saveState(s, st);
      fs.renameSync(path.join(s.installDir, n), path.join(legacy, n));
      if (relTop.has(n)) fs.symlinkSync(`current/${n}`, path.join(s.installDir, n));
      st.migration.moved.push(n);
      if (relTop.has(n)) st.migration.linked.push(n);
      delete st.migration.moving;
      saveState(s, st);
    }
    for (const n of relTop) {
      if (STATE_ENTRIES.has(n) || isLink(path.join(s.installDir, n)) || fs.existsSync(path.join(s.installDir, n))) continue;
      fs.symlinkSync(`current/${n}`, path.join(s.installDir, n));
      st.migration.linked.push(n);
    }
    st.migration.phase = 'unit';
    saveState(s, st);
    job.phase('unit', 'systemd-Unit auf current umstellen');
    writeFileAtomic(s.unitFile, rewriteUnit(s, fs.readFileSync(s.unitFile, 'utf8')));
    removeDropin(s, job, { reload: false });
    systemctl(s, 'daemon-reload');
    st.migration.phase = 'provision';
    saveState(s, st);
    job.phase('provision', 'post-update.sh des Pakets');
    runPostUpdate(s, job);
    restartService(s, job);
    job.phase('health', `Gesundheitsprüfung (${s.healthTimeoutS} s)`);
    if (await waitHealthy(s, version, job)) {
      st.current = version;
      st.previous = null;
      st.legacy = { dir: legacy, git_sha: gitSha, version: chk.gitVersion, at: new Date().toISOString() };
      st.migration = null;
      st.migrate.done_at = new Date().toISOString();
      record(st, version, 'migrated');
      updateTrust(s, st, version, job);
      saveState(s, st);
      job.finish('ok', `auf Paket ${version} umgestellt; alter Checkout liegt in .legacy-git`, { result: 'ok', version, from: `git ${chk.gitVersion}` });
      return;
    }
    throw new Error(`Paket ${version} nicht gesund`);
  } catch (e) {
    job.log(`Umstellung gescheitert: ${e.message}`);
    job.phase('rollback', 'zurück auf den git-Checkout');
    revertMigration(s, st, job);
    restartService(s, job);
    const back = await waitHealthy(s, null, job);
    record(st, version, 'migration_failed');
    saveState(s, st);
    job.finish('rolled_back', `Umstellung zurückgenommen (${e.message}); git-Stand ${back ? 'läuft' : 'meldet sich NICHT gesund'}`, { result: 'rolled_back', version, from: `git ${chk.gitVersion}` });
  }
}

// Nach einem Neustart mitten im Auftrag (Strom weg): ist der laufende Stand
// gesund, gilt er; sonst zurück.
async function jobResume(s, job) {
  const st = loadState(s);
  if (st.migration) {
    const v = st.migration.version;
    job.phase('health', `unterbrochene Umstellung auf ${v}: Gesundheitsprüfung`);
    if (st.migration.phase === 'provision' && currentVersion(s) === v && await waitHealthy(s, v, job)) {
      st.current = v;
      st.legacy = { dir: st.migration.legacy, git_sha: st.migration.git_sha, version: st.migration.git_version, at: new Date().toISOString() };
      st.migration = null;
      record(st, v, 'migrated');
      updateTrust(s, st, v, job);
      removeDropin(s, job);
      saveState(s, st);
      job.finish('ok', `Umstellung auf ${v} abgeschlossen (nach Unterbrechung)`, { result: 'ok', version: v });
      return;
    }
    revertMigration(s, st, job);
    restartService(s, job);
    await waitHealthy(s, null, job);
    job.finish('rolled_back', 'unterbrochene Umstellung zurückgenommen', { result: 'rolled_back', version: v });
    return;
  }
  if (st.pending) {
    const { version: to, previous: from } = st.pending;
    job.phase('health', `unterbrochener Auftrag (${to}): Gesundheitsprüfung`);
    const cur = currentVersion(s);
    if (cur === to && await waitHealthy(s, to, job)) {
      const op = st.pending.op;
      st.previous = from;
      st.current = to;
      st.pending = null;
      record(st, to, 'ok');
      if (op === 'install') finalizeInstall(s, st, to, job);
      saveState(s, st);
      job.finish('ok', `${to} läuft gesund (nach Unterbrechung bestätigt)`, { result: 'ok', version: to });
      return;
    }
    if (from && fs.existsSync(path.join(releasesDir(s), from))) {
      switchCurrent(s, from);
      reconcileLinks(s);
      restartService(s, job);
      await waitHealthy(s, from, job);
    }
    st.current = currentVersion(s);
    st.pending = null;
    record(st, to, 'rolled_back');
    saveState(s, st);
    job.finish('rolled_back', `unterbrochener Auftrag: zurück auf ${from}`, { result: 'rolled_back', version: to, from });
    return;
  }
  job.finish('ok', 'nichts fortzusetzen', { result: 'noop' });
}

// ── Vordergrund-Aktionen ────────────────────────────────────────────────────

function readStatus(s) {
  const status = readJson(statusFile(s), null);
  const st = loadState(s);
  const cur = currentVersion(s);
  const running = status?.state === 'running' || status?.state === 'queued';
  return {
    ok: true,
    mode: cur ? 'package' : 'git',
    current: cur,
    previous: st.previous && fs.existsSync(path.join(releasesDir(s), st.previous)) ? st.previous : null,
    running,
    status,
    migration: { skipped: st.migrate?.skipped || null, attempts: st.migrate?.attempts || 0, done_at: st.migrate?.done_at || null },
  };
}

async function actionCheck(s, channel) {
  const cur = currentVersion(s);
  const manifest = cur ? releaseManifest(s, cur) : null;
  const st = loadState(s);
  const { idx } = await fetchIndex(s, channel);
  const latest = idx.releases.find((r) => r.version === idx.latest) || idx.releases[0];
  const forArch = idx.releases.filter((r) => r.artifacts?.[s.arch]);
  const newer = cur ? forArch.filter((r) => (manifest?.channel === channel ? compareVersions(r.version, cur) > 0 : r.version !== cur)) : forArch;
  const changelog = newer.flatMap((r) => (Array.isArray(r.changes) ? r.changes.map((c) => `${r.version}: ${c}`) : [])).slice(0, 60);
  return {
    ok: true,
    mode: cur ? 'package' : 'git',
    channel,
    arch: s.arch,
    current: cur ? { version: cur, git_sha: manifest?.git_sha || null, channel: manifest?.channel || null } : null,
    previous: st.previous && fs.existsSync(path.join(releasesDir(s), st.previous)) ? st.previous : null,
    latest: { version: latest.version, git_sha: latest.git_sha || null, date: latest.date || null, available: !!latest.artifacts?.[s.arch] },
    updateAvailable: !!cur && !!latest.artifacts?.[s.arch] && latest.version !== cur
      && (manifest?.channel !== channel || compareVersions(latest.version, cur) > 0),
    availableVersions: forArch.map((r) => r.version).slice(0, 10),
    changelog,
  };
}

// Startet den Auftrag als eigene Unit (überlebt den Neustart von DVhub).
function spawnJob(s, unit, jobArgs, { delayS = 0 } = {}) {
  if (unitActive(s, `${unit}.service`) || (delayS && unitActive(s, `${unit}.timer`))) throw new Exit(4, 'ein Update-Auftrag läuft bereits');
  if (lockHeld(s)) throw new Exit(4, 'ein Update-Auftrag läuft bereits');
  const args = ['--collect', '--quiet', `--unit=${unit}`, '--description=DVhub Release-Paket',
    `--property=StandardOutput=append:${path.join(s.stateDir, 'job.log')}`,
    `--property=StandardError=append:${path.join(s.stateDir, 'job.log')}`];
  if (delayS) args.push(`--on-active=${delayS}s`);
  const r = run(s.systemdRun, [...args, s.self, '_job', ...jobArgs], { timeout: 30000 });
  if (r.status !== 0) throw new Error(`systemd-run: ${(r.stderr || '').trim()}`);
}

async function main(argv, s = settings()) {
  const a = parseArgs(argv);
  if (s.euid !== 0) throw new Exit(1, 'muss als root laufen');
  if (!s.installDir || !path.isAbsolute(s.installDir)) throw new Exit(1, 'kein Programmordner');
  fs.mkdirSync(s.stateDir, { recursive: true, mode: 0o755 });
  process.umask(0o022);
  const out = (o) => s.write(`${JSON.stringify(o)}\n`);

  switch (a.action) {
    case 'status':
      out(readStatus(s));
      return 0;
    case 'check':
      out(await actionCheck(s, a.channel));
      return 0;
    case 'install':
    case 'rollback': {
      if (!isPackageLayout(s)) throw new Exit(3, 'keine Paket-Installation');
      const jobArgs = a.action === 'install' ? ['install', a.version, a.channel] : ['rollback'];
      writeJsonAtomic(statusFile(s), { job: a.action, state: 'queued', phase: 'queued', message: 'Auftrag gestartet', version: a.version || null, started: new Date().toISOString(), log: [] });
      if (s.test) return runJob(s, { action: '_job', job: jobArgs[0], version: a.version, channel: a.channel });
      spawnJob(s, JOB_UNIT, jobArgs);
      out({ ok: true, started: true, job: a.action });
      return 0;
    }
    case 'migrate':
      // Von Hand als root: im Vordergrund (der Aufrufer ist nicht der Dienst).
      return runJob(s, { action: '_job', job: 'migrate', force: a.force });
    case 'boot-hook':
      return bootHook(s);
    case 'recover':
      return recover(s);
    case '_job':
      return runJob(s, a);
    default:
      throw new Exit(2, 'unbekannte Aktion');
  }
}

// Aus post-update.sh (bei jedem Dienststart): unterbrochenen Auftrag
// fortsetzen oder auf einer git-Box die Umstellung planen.
function bootHook(s) {
  const st = loadState(s);
  const jobRunning = lockHeld(s) || unitActive(s, `${JOB_UNIT}.service`) || unitActive(s, `${MIGRATE_UNIT}.service`)
    || unitActive(s, `${RESUME_UNIT}.service`) || unitActive(s, `${RESUME_UNIT}.timer`);
  // Ein Auftrag ist vermerkt, aber keiner läuft: Stromausfall oder Absturz.
  if (!jobRunning && (st.pending || st.migration)) {
    spawnJob(s, RESUME_UNIT, ['resume'], { delayS: 60 });
    s.write('dvhub-release: unterbrochener Auftrag — Fortsetzung in 60 s geplant\n');
    return 0;
  }
  if (isPackageLayout(s)) return 0;
  if (jobRunning || unitActive(s, `${MIGRATE_UNIT}.timer`)) { s.write('dvhub-release: Umstellung bereits geplant\n'); return 0; }
  const chk = migrationCheck(s);
  if (!chk.ok) {
    if (st.migrate?.skipped !== chk.reason) { st.migrate = { ...st.migrate, skipped: chk.reason }; saveState(s, st); }
    s.write(`dvhub-release: Umstellung auf Pakete nicht geplant (${chk.reason})\n`);
    return 0;
  }
  const m = st.migrate || {};
  const now = Math.floor(Date.now() / 1000);
  if ((m.attempts || 0) >= MIGRATE_MAX_ATTEMPTS) { s.write('dvhub-release: Umstellung nach 5 Fehlversuchen nur noch von Hand (dvhub-release migrate)\n'); return 0; }
  if (m.last_attempt && now - m.last_attempt < MIGRATE_RETRY_S) { s.write('dvhub-release: nächster Umstellungsversuch nach 24 h\n'); return 0; }
  if (m.skipped === 'package_older' && m.last_check && now - m.last_check < 6 * 3600) { s.write('dvhub-release: Paket älter als der Checkout — nächste Prüfung in 6 h\n'); return 0; }
  spawnJob(s, MIGRATE_UNIT, ['migrate'], { delayS: s.migrateDelayS });
  s.write(`dvhub-release: Umstellung auf Pakete in ${s.migrateDelayS} s geplant\n`);
  return 0;
}

// Synchron aus dem Notfall-Drop-in (ExecStartPre): nur eine im Verschieben
// abgebrochene Umstellung; alles Spätere entscheidet resume per Gesundheit.
function recover(s) {
  const st = loadState(s);
  const log = { log: (l) => s.write(`dvhub-release recover: ${l}\n`) };
  if (lockHeld(s)) return 0;
  if (st.migration && st.migration.phase === 'moving') {
    const version = st.migration.version || '-';
    // Kein daemon-reload mitten im Start (ExecStartPre): systemd verlöre den
    // laufenden Befehl aus der Liste und übersprünge post-update.sh
    // (Gegenprüfung da65a346). Der Reload folgt 30 s später als eigene Unit.
    revertMigration(s, st, log, { reload: false });
    run(s.systemdRun, ['--collect', '--quiet', '--on-active=30s', '--unit=dvhub-release-reload', 'systemctl', 'daemon-reload'], { timeout: 30000 });
    record(st, version, 'migration_interrupted');
    saveState(s, st);
    log.log('abgebrochene Umstellung zurückgenommen — git-Stand wiederhergestellt');
    return 0;
  }
  if (!st.migration) removeDropin(s, log);
  return 0;
}

async function runJob(s, a) {
  const release = lock(s);
  const job = new Job(s, a.job, { version: a.version && a.version !== 'latest' ? a.version : null });
  try {
    if (a.job === 'install') await jobInstall(s, job, a);
    else if (a.job === 'rollback') await jobRollback(s, job);
    else if (a.job === 'migrate') await jobMigrate(s, job, a);
    else if (a.job === 'resume') await jobResume(s, job);
    return ['ok', 'skipped'].includes(job.status.state) ? 0 : 1;
  } catch (e) {
    job.finish('failed', `fehlgeschlagen: ${e.message}`, { result: 'failed' });
    return e instanceof Exit ? e.exitCode : 1;
  } finally {
    release();
  }
}

module.exports = {
  parseArgs, compareVersions, parseVersion, satisfiesEngine, versionFromLabel, debArch, readConf, settings,
  validateIndex, verifyTree, reconcileLinks, dropinContent, switchCurrent, currentVersion, rewriteUnit, migrationCheck,
  OFFICIAL_REPO_RE, main, Exit, trustedKeyCount, verifySignature, download, unpack, readStatus, actionCheck,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0), (e) => {
    process.stderr.write(`dvhub-release: ${e.message}\n`);
    process.exit(e instanceof Exit ? e.exitCode : 1);
  });
}
