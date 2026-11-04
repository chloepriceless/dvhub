// test/release-update-routes.test.js — Software-Update auf einer Paket-Box
// (docs/release-pakete.md): /api/admin/update/* rufen den root-eigenen Helfer
// dvhub-release statt git/npm, Version und Revision kommen aus dem Manifest.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdminRoutes, RELEASE_HELPER } from '../routes/admin-routes.js';
import { SEMVER_TAG, GIT_SHA_REF, compareSemverTag, selectLatestSemverTag, assertNoDowngrade } from '../routes-api.js';
import { readAppVersionInfo } from '../app-version.js';
import { readReleaseInfo } from '../release-info.js';

const SHA = 'c7a245a1fb36057044a6faed4f002e1c4dad103a';

function makeRelease({ version = '1.0.9', channel = 'stable' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-release-routes-'));
  const appDir = path.join(root, 'dvhub');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'dvhub', version: version.split('-')[0] }));
  fs.writeFileSync(path.join(root, '.dvhub-release.json'), JSON.stringify({ format: 1, name: 'dvhub', version, channel, git_sha: SHA, arch: 'arm64', files: [] }, null, 2));
  return { root, appDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function harness({ channel = 'stable', helper = {}, release = {}, getRawCfg = null, saveAndApplyConfig = null, dataDir = undefined, channelWatchMs = undefined, serviceActions = true } = {}) {
  const rel = makeRelease(release);
  const calls = [];
  const saved = [];
  const logs = [];
  const data = dataDir === undefined ? path.join(rel.root, 'data') : dataDir;
  if (data) fs.mkdirSync(data, { recursive: true });
  const execFileAsync = async (cmd, args = []) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'sudo' && args[1] === RELEASE_HELPER) {
      const action = args[2];
      const h = helper[action];
      if (typeof h === 'function') return h(args.slice(3));
      if (h instanceof Error) throw h;
      return { stdout: JSON.stringify(h ?? { ok: true }), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const responses = [];
  const deps = {
    ctx: {
      getServiceActionsEnabled: () => serviceActions,
      getRepoRoot: () => rel.root,
      getDataDir: () => data,
      getAppDir: () => rel.appDir,
      getRawCfg: getRawCfg || (() => ({ updateChannel: channel })),
      saveAndApplyConfig: (c) => { if (saveAndApplyConfig) saveAndApplyConfig(c); saved.push(c); },
      getAppVersion: () => readAppVersionInfo({ appDir: rel.appDir }),
      scheduleServiceRestart: () => { calls.push('<restart>'); },
      getServiceName: () => 'dvhub.service',
    },
    getCfg: () => ({}),
    pushLog: (event, fields = {}) => { logs.push({ event, ...fields }); },
    json: (res, code, payload) => { responses.push({ code, payload }); },
    checkAuth: () => true,
    execFileAsync,
    GIT_SHA_REF, SEMVER_TAG, compareSemverTag, selectLatestSemverTag, assertNoDowngrade,
    listReachableReleaseTags: async () => '',
    ...(channelWatchMs !== undefined ? { channelWatchMs } : {}),
  };
  const handle = createAdminRoutes(deps);
  const call = async (method, pathname, body = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = method; req.headers = {};
    await handle(req, {}, new URL(`http://x${pathname}`));
    return responses.at(-1);
  };
  return { ...rel, calls, saved, logs, call, dataDir: data, handle };
}

const CHECK = {
  ok: true, mode: 'package', channel: 'stable', arch: 'arm64',
  current: { version: '1.0.9', git_sha: SHA, channel: 'stable' }, previous: '1.0.8',
  latest: { version: '1.0.10', git_sha: 'd'.repeat(40), date: '2026-11-01T00:00:00Z', available: true },
  updateAvailable: true, availableVersions: ['1.0.10', '1.0.9'], changelog: ['1.0.10: Neu: etwas'],
};

describe('Paket-Box: Version aus dem Manifest', () => {
  it('readReleaseInfo liest .dvhub-release.json über dem App-Ordner', () => {
    const r = makeRelease({ version: '1.0.8-dev.20261027162124.c7a245a1', channel: 'dev' });
    try {
      const info = readReleaseInfo(r.appDir);
      assert.equal(info.version, '1.0.8-dev.20261027162124.c7a245a1');
      assert.equal(info.channel, 'dev');
      assert.equal(info.gitSha, SHA);
      assert.equal(readReleaseInfo(path.join(os.tmpdir(), 'gibt-es-nicht')), null);
    } finally { r.cleanup(); }
  });

  it('versionLabel zeigt die Paketversion (stable mit Revision, dev ohne doppelte)', () => {
    const s = makeRelease({ version: '1.0.9' });
    const d = makeRelease({ version: '1.0.8-dev.20261027162124.c7a245a1', channel: 'dev' });
    try {
      assert.equal(readAppVersionInfo({ appDir: s.appDir }).versionLabel, 'v1.0.9+c7a245a');
      assert.equal(readAppVersionInfo({ appDir: s.appDir }).revision, 'c7a245a');
      assert.equal(readAppVersionInfo({ appDir: d.appDir }).versionLabel, 'v1.0.8-dev.20261027162124.c7a245a1');
      assert.equal(readAppVersionInfo({ appDir: d.appDir }).releaseVersion, '1.0.8-dev.20261027162124.c7a245a1');
    } finally { s.cleanup(); d.cleanup(); }
  });
});

describe('Paket-Box: Update über dvhub-release', () => {
  it('check ruft den Helfer mit dem Kanal und liefert die bekannte Antwortform', async () => {
    const h = harness({ helper: { check: CHECK } });
    try {
      const r = await h.call('GET', '/api/admin/update/check');
      assert.equal(r.code, 200);
      assert.equal(r.payload.mode, 'package');
      assert.equal(r.payload.updateAvailable, true);
      assert.equal(r.payload.current.tag, 'v1.0.9');
      assert.equal(r.payload.latest.tag, 'v1.0.10');
      assert.equal(r.payload.previous, '1.0.8');
      assert.deepEqual(r.payload.changelog, ['1.0.10: Neu: etwas']);
      assert.ok(h.calls.includes(`sudo -n ${RELEASE_HELPER} check stable`));
      assert.ok(!h.calls.some((c) => c.startsWith('git ') || c.includes('dvhub-update')), h.calls.join('\n'));
    } finally { h.cleanup(); }
  });

  it('apply startet install latest stable und plant keinen eigenen Neustart', async () => {
    const h = harness({ channel: 'stable', helper: { install: { ok: true, started: true, job: 'install' } } });
    try {
      const r = await h.call('POST', '/api/admin/update/apply', {});
      assert.equal(r.code, 200, JSON.stringify(r.payload));
      assert.equal(r.payload.mode, 'package');
      assert.equal(r.payload.job, 'install');
      assert.ok(h.calls.includes(`sudo -n ${RELEASE_HELPER} install latest stable`));
      assert.ok(!h.calls.includes('<restart>'), 'den Neustart macht der Helfer');
    } finally { h.cleanup(); }
  });

  it('apply mit Version gibt sie geprüft weiter, Unsinn wird abgelehnt', async () => {
    const h = harness({ helper: { install: { ok: true, started: true } } });
    try {
      assert.equal((await h.call('POST', '/api/admin/update/apply', { version: 'v1.0.10' })).code, 200);
      assert.ok(h.calls.includes(`sudo -n ${RELEASE_HELPER} install 1.0.10 stable`));
      const bad = await h.call('POST', '/api/admin/update/apply', { version: '1.0.10; rm -rf /' });
      assert.equal(bad.code, 400);
      const pin = await h.call('POST', '/api/admin/update/apply', { ref: 'abcdef1' });
      assert.equal(pin.code, 400, 'Commit-Pins gibt es nur auf git-Boxen');
    } finally { h.cleanup(); }
  });

  it('läuft schon ein Auftrag (Exit 4), antwortet apply mit 409', async () => {
    const busy = Object.assign(new Error('Command failed'), { code: 4, stderr: 'dvhub-release: ein anderer Update-Auftrag läuft bereits\n' });
    const h = harness({ helper: { install: busy } });
    try {
      const r = await h.call('POST', '/api/admin/update/apply', {});
      assert.equal(r.code, 409);
      assert.match(r.payload.error, /läuft bereits/);
    } finally { h.cleanup(); }
  });

  it('status und rollback gehen an den Helfer', async () => {
    const status = { ok: true, mode: 'package', current: '1.0.9', previous: '1.0.8', running: true, status: { job: 'install', state: 'running', phase: 'download', message: 'Paket laden' } };
    const h = harness({ helper: { status, rollback: { ok: true, started: true, job: 'rollback' } } });
    try {
      const s = await h.call('GET', '/api/admin/update/status');
      assert.equal(s.code, 200);
      assert.equal(s.payload.status.phase, 'download');
      const r = await h.call('POST', '/api/admin/update/rollback');
      assert.equal(r.code, 200);
      assert.ok(h.calls.includes(`sudo -n ${RELEASE_HELPER} rollback`));
    } finally { h.cleanup(); }
  });

  it('Kanalwechsel speichert die Config und installiert das Neueste des Zielkanals', async () => {
    const h = harness({ channel: 'dev', helper: { check: CHECK, install: { ok: true, started: true } } });
    try {
      const r = await h.call('POST', '/api/admin/update/channel', { channel: 'stable' });
      assert.equal(r.code, 200, JSON.stringify(r.payload));
      assert.equal(h.saved.at(-1).updateChannel, 'stable');
      assert.ok(h.calls.includes(`sudo -n ${RELEASE_HELPER} install latest stable`));
      assert.ok(!h.calls.some((c) => c.startsWith('git ')));
    } finally { h.cleanup(); }
  });

  it('Kanalwechsel: lehnt der Helfer ab, bleibt der bisherige Kanal gespeichert', async () => {
    const h = harness({ channel: 'dev', helper: { check: CHECK, install: Object.assign(new Error('busy'), { code: 4, stderr: 'dvhub-release: läuft bereits' }) } });
    try {
      const r = await h.call('POST', '/api/admin/update/channel', { channel: 'stable' });
      assert.equal(r.code, 409, JSON.stringify(r.payload));
      assert.equal(h.saved.length, 0);
      assert.ok(!fs.existsSync(path.join(h.dataDir, 'update-channel-switch.json')), 'kein Rückfall-Vermerk');
    } finally { h.cleanup(); }
  });

  it('Kanalwechsel speichert den Stand NACH dem Helfer-Aufruf (Änderungen währenddessen bleiben)', async () => {
    // Gegenprüfung be05dd73 (P2): der Klon vor dem await überschrieb Änderungen,
    // die während des Helfer-Aufrufs gespeichert wurden.
    let raw = { updateChannel: 'dev', httpPort: 8080 };
    const h = harness({
      channel: 'dev',
      getRawCfg: () => raw,
      helper: { check: CHECK, install: () => { raw = { ...raw, httpPort: 9999 }; return { stdout: JSON.stringify({ ok: true, started: true }), stderr: '' }; } },
    });
    try {
      const r = await h.call('POST', '/api/admin/update/channel', { channel: 'stable' });
      assert.equal(r.code, 200, JSON.stringify(r.payload));
      assert.equal(h.saved.at(-1).updateChannel, 'stable');
      assert.equal(h.saved.at(-1).httpPort, 9999);
    } finally { h.cleanup(); }
  });

  it('Kanalwechsel: scheitert das Speichern nach dem Start, meldet die Antwort den laufenden Auftrag (200 + Warnung)', async () => {
    const h = harness({ channel: 'dev', saveAndApplyConfig: () => { throw new Error('EROFS'); }, helper: { check: CHECK, install: { ok: true, started: true } } });
    try {
      const r = await h.call('POST', '/api/admin/update/channel', { channel: 'stable' });
      assert.equal(r.code, 200, JSON.stringify(r.payload));
      assert.equal(r.payload.started, true);
      assert.match(String(r.payload.warning), /EROFS/);
    } finally { h.cleanup(); }
  });

  it('Kanalwechsel auf eine kleinere Grundversion: downgrade_blocked, mit allowDowngrade installiert (Strix R-0003)', async () => {
    const check = { ...CHECK, channel: 'stable', current: { version: '1.0.10-dev.20261102000000.aaaaaaaa', git_sha: SHA, channel: 'dev' }, latest: { version: '1.0.9', git_sha: SHA, available: true } };
    const h = harness({ channel: 'dev', release: { version: '1.0.10-dev.20261102000000.aaaaaaaa', channel: 'dev' }, helper: { check, install: { ok: true, started: true } } });
    try {
      const r = await h.call('POST', '/api/admin/update/channel', { channel: 'stable' });
      assert.equal(r.code, 400, JSON.stringify(r.payload));
      assert.equal(r.payload.error, 'downgrade_blocked');
      assert.equal(r.payload.target, '1.0.9');
      assert.ok(!h.calls.some((c) => c.includes(' install ')), 'nichts installiert');
      assert.equal(h.saved.length, 0);
      const ok = await h.call('POST', '/api/admin/update/channel', { channel: 'stable', allowDowngrade: true });
      assert.equal(ok.code, 200, JSON.stringify(ok.payload));
      assert.ok(h.calls.includes(`sudo -n ${RELEASE_HELPER} install latest stable`));
    } finally { h.cleanup(); }
  });

  it('Kanalwechsel dev → stable derselben Grundversion: gleicher Commit erlaubt, dev mit späteren Commits gesperrt', async () => {
    // Gegenprüfung 1d4ca47d (P2): 1.0.8-dev.<nach dem Tag> → stable 1.0.8 verlöre Commits.
    const dev = '1.0.9-dev.20261102121042.aaaaaaaa';
    const same = { ...CHECK, current: { version: dev, git_sha: SHA, channel: 'dev' }, latest: { version: '1.0.9', git_sha: SHA, date: '2026-11-02T12:10:42.000Z', available: true } };
    const h = harness({ channel: 'dev', release: { version: dev, channel: 'dev' }, helper: { check: same, install: { ok: true, started: true } } });
    try {
      const r = await h.call('POST', '/api/admin/update/channel', { channel: 'stable' });
      assert.equal(r.code, 200, JSON.stringify(r.payload));
    } finally { h.cleanup(); }
    const older = { ...same, latest: { ...same.latest, date: '2026-10-21T19:32:00.000Z' } };
    const h2 = harness({ channel: 'dev', release: { version: dev, channel: 'dev' }, helper: { check: older, install: { ok: true, started: true } } });
    try {
      const r = await h2.call('POST', '/api/admin/update/channel', { channel: 'stable' });
      assert.equal(r.code, 400, JSON.stringify(r.payload));
      assert.equal(r.payload.error, 'downgrade_blocked');
    } finally { h2.cleanup(); }
  });

  it('Update (apply) auf Paket-Box: Rückschritt nur mit allowDowngrade (Gegenprüfung 1d4ca47d)', async () => {
    const check = { ...CHECK, current: { version: '1.0.10-dev.20261102000000.aaaaaaaa', git_sha: SHA, channel: 'dev' }, latest: { version: '1.0.9', git_sha: SHA, available: true } };
    const h = harness({ channel: 'stable', release: { version: '1.0.10-dev.20261102000000.aaaaaaaa', channel: 'dev' }, helper: { check, install: { ok: true, started: true } } });
    try {
      const r = await h.call('POST', '/api/admin/update/apply', {});
      assert.equal(r.code, 400, JSON.stringify(r.payload));
      assert.equal(r.payload.error, 'downgrade_blocked');
      assert.ok(!h.calls.some((c) => c.includes(' install ')));
      const ok = await h.call('POST', '/api/admin/update/apply', { allowDowngrade: true });
      assert.equal(ok.code, 200, JSON.stringify(ok.payload));
      assert.ok(h.calls.includes(`sudo -n ${RELEASE_HELPER} install latest stable`));
    } finally { h.cleanup(); }
  });

  it('git-Box: status meldet mode git ohne Helfer-Pflicht, rollback 409', async () => {
    const h = harness({ helper: { status: Object.assign(new Error('nope'), { code: 1, stderr: 'sudo: Befehl nicht erlaubt' }) } });
    fs.rmSync(path.join(h.root, '.dvhub-release.json'));
    try {
      const s = await h.call('GET', '/api/admin/update/status');
      assert.equal(s.code, 200);
      assert.equal(s.payload.mode, 'git');
      const r = await h.call('POST', '/api/admin/update/rollback');
      assert.equal(r.code, 409);
    } finally { h.cleanup(); }
  });
});

// Christin 04.11.2026: signierte Pakete nur für stable, Bleeding Edge bleibt git.
const DEV_NOTICE = 'Bleeding Edge gibt es nur für git-Installationen. Paket-Installationen bleiben auf Stabil.';

describe('Paket-Box: Bleeding Edge nur für git-Installationen', () => {
  it('Wechsel auf dev: 409 mit klarer Meldung, kein Auftrag, Kanal bleibt stable, Log-Eintrag', async () => {
    const h = harness({ channel: 'stable', helper: { check: CHECK, install: { ok: true, started: true } } });
    try {
      const r = await h.call('POST', '/api/admin/update/channel', { channel: 'dev' });
      assert.equal(r.code, 409, JSON.stringify(r.payload));
      assert.equal(r.payload.ok, false);
      assert.equal(r.payload.error, 'dev_requires_git');
      assert.equal(r.payload.message, DEV_NOTICE);
      assert.equal(r.payload.channel, 'stable');
      assert.equal(h.saved.length, 0, 'Config unverändert');
      assert.ok(!h.calls.some((c) => c.includes(RELEASE_HELPER)), h.calls.join('\n'));
      assert.ok(h.logs.some((l) => l.event === 'update_channel_rejected' && l.reason === 'dev_requires_git'), JSON.stringify(h.logs));
    } finally { h.cleanup(); }
  });

  it('steht in der Config noch dev (Altbestand), prüfen und installieren check/apply trotzdem stable', async () => {
    const h = harness({ channel: 'dev', helper: { check: CHECK, install: { ok: true, started: true } } });
    try {
      const c = await h.call('GET', '/api/admin/update/check');
      assert.equal(c.code, 200);
      assert.equal(c.payload.channel, 'stable');
      const a = await h.call('POST', '/api/admin/update/apply', {});
      assert.equal(a.code, 200, JSON.stringify(a.payload));
      assert.ok(!h.calls.some((x) => / (check|install latest) dev$/.test(x)), h.calls.join('\n'));
      assert.ok(h.calls.includes(`sudo -n ${RELEASE_HELPER} install latest stable`));
    } finally { h.cleanup(); }
  });

  it('git-Box (auch Docker: kein Manifest) bleibt beim bisherigen Weg', async () => {
    const h = harness({ channel: 'stable' });
    fs.rmSync(path.join(h.root, '.dvhub-release.json'));
    try {
      const r = await h.call('POST', '/api/admin/update/channel', { channel: 'dev' });
      assert.notEqual(r.payload.error, 'dev_requires_git');
      assert.ok(h.calls.some((c) => c.includes('dvhub-update fetch')), h.calls.join('\n'));
    } finally { h.cleanup(); }
    const d = harness({ channel: 'stable', serviceActions: false });
    fs.rmSync(path.join(d.root, '.dvhub-release.json'));
    try {
      const r = await d.call('POST', '/api/admin/update/channel', { channel: 'dev' });
      assert.equal(r.code, 403, 'Docker: Dienstaktionen aus — wie bisher');
      assert.equal(d.saved.length, 0);
    } finally { d.cleanup(); }
  });

  it('Oberfläche: Paket-Box zeigt die Meldung statt zu wechseln (tools.js)', async () => {
    const vm = await import('node:vm');
    const src = fs.readFileSync(new URL('../public/tools.js', import.meta.url), 'utf8');
    const sandbox = { console, window: { DVhubCommon: {} } };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(src, sandbox, { filename: 'tools.js' });
    const { channelSwitchNotice } = sandbox.DVhubToolsUpdate;
    assert.equal(channelSwitchNotice('package', 'dev'), DEV_NOTICE);
    assert.equal(channelSwitchNotice('package', 'stable'), null);
    assert.equal(channelSwitchNotice('git', 'dev'), null);
    assert.equal(channelSwitchNotice(null, 'dev'), null);
    assert.match(src, /dev_requires_git/, 'Antwort des Servers wird ausgewertet');
  });
});

describe('Paket-Box: Kanal-Rückfall, wenn der Kanalwechsel-Auftrag scheitert', () => {
  const MARK = 'update-channel-switch.json';
  // Kanalwechsel dev → stable (der einzige auf einer Paket-Box), danach meldet
  // der Helfer-Status <status>.
  const switchThen = async (statusFn, opts = {}) => {
    let raw = { updateChannel: 'dev', httpPort: 8080 };
    let st = null;
    const h = harness({
      channel: 'dev',
      getRawCfg: () => raw,
      saveAndApplyConfig: (c) => { if (opts.failSave?.()) throw new Error('ENOSPC'); raw = JSON.parse(JSON.stringify(c)); },
      helper: { check: CHECK, install: { ok: true, started: true }, status: () => ({ stdout: JSON.stringify({ ok: true, mode: 'package', status: st }), stderr: '' }) },
    });
    const before = new Date(Date.now() - 1000).toISOString();
    const r = await h.call('POST', '/api/admin/update/channel', { channel: 'stable' });
    assert.equal(r.code, 200, JSON.stringify(r.payload));
    assert.equal(raw.updateChannel, 'stable', 'gespeichert, sobald angenommen');
    st = statusFn({ before, after: new Date(Date.now() + 5).toISOString() });
    return { h, raw: () => raw, setRaw: (x) => { raw = x; }, setStatus: (x) => { st = x; } };
  };

  for (const [state, result] of [['failed', 'failed'], ['rolled_back', 'rolled_back']]) {
    it(`Auftrag ${state}: updateChannel zurück auf den alten Wert, Log-Eintrag, Vermerk weg`, async () => {
      const { h, raw } = await switchThen(({ after }) => ({ job: 'install', state, phase: 'done', result, message: 'Index nicht ladbar (404)', started: after, finished: after }));
      try {
        assert.ok(fs.existsSync(path.join(h.dataDir, MARK)), 'Vermerk liegt im Datenordner (überlebt den Neustart)');
        const s = await h.call('GET', '/api/admin/update/status');
        assert.equal(s.code, 200);
        assert.equal(raw().updateChannel, 'dev', 'Kanal zurückgesetzt');
        assert.equal(raw().httpPort, 8080);
        assert.deepEqual(s.payload.channelSwitch, { state: 'reverted', channel: 'dev', from: 'stable' });
        const log = h.logs.find((l) => l.event === 'update_channel_reverted');
        assert.ok(log, JSON.stringify(h.logs));
        assert.equal(log.from, 'stable');
        assert.equal(log.to, 'dev');
        assert.equal(log.result, result);
        assert.ok(!fs.existsSync(path.join(h.dataDir, MARK)));
      } finally { h.cleanup(); }
    });
  }

  it('Auftrag nicht angenommen (Sperre belegt, Unit startet und schreibt failed): Rückfall', async () => {
    const { h, raw } = await switchThen(({ after }) => ({ job: 'install', state: 'failed', phase: 'done', result: 'failed', message: 'ein Update-Auftrag läuft bereits', started: after }));
    try {
      await h.call('GET', '/api/admin/update/status');
      assert.equal(raw().updateChannel, 'dev');
    } finally { h.cleanup(); }
  });

  it('Auftrag läuft noch: nichts ändern; danach ok: Kanal bleibt, Vermerk weg', async () => {
    const t = await switchThen(({ after }) => ({ job: 'install', state: 'running', phase: 'download', started: after }));
    const { h, raw } = t;
    try {
      await h.call('GET', '/api/admin/update/status');
      assert.equal(raw().updateChannel, 'stable');
      assert.ok(fs.existsSync(path.join(h.dataDir, MARK)));
      t.setStatus({ job: 'install', state: 'ok', phase: 'done', result: 'ok', started: new Date(Date.now() + 5).toISOString() });
      const s = await h.call('GET', '/api/admin/update/status');
      assert.equal(raw().updateChannel, 'stable');
      assert.equal(s.payload.channelSwitch?.state, 'kept');
      assert.ok(!fs.existsSync(path.join(h.dataDir, MARK)));
      assert.ok(!h.logs.some((l) => l.event === 'update_channel_reverted'));
    } finally { h.cleanup(); }
  });

  it('Status zeigt noch einen älteren Auftrag: nichts ändern', async () => {
    const { h, raw } = await switchThen(({ before }) => ({ job: 'install', state: 'failed', result: 'failed', started: new Date(Date.parse(before) - 60000).toISOString() }));
    try {
      await h.call('GET', '/api/admin/update/status');
      assert.equal(raw().updateChannel, 'stable');
      assert.ok(fs.existsSync(path.join(h.dataDir, MARK)));
    } finally { h.cleanup(); }
  });

  it('Kanal inzwischen anders eingestellt: kein Überschreiben', async () => {
    const t = await switchThen(({ after }) => ({ job: 'install', state: 'failed', result: 'failed', started: after }));
    try {
      // Jemand hat den Kanal nach dem Start von Hand umgestellt (nicht mehr
      // das Ziel des Auftrags): der Rückfall überschreibt das nicht.
      t.setRaw({ updateChannel: 'x-anders' });
      await t.h.call('GET', '/api/admin/update/status');
      assert.equal(t.raw().updateChannel, 'x-anders');
      assert.ok(!fs.existsSync(path.join(t.h.dataDir, MARK)));
    } finally { t.h.cleanup(); }
  });

  it('offener Kanalwechsel: kein neuer Auftrag (apply, rollback, Kanalwechsel) — 409 statt falscher Zuordnung (Codex ddd3f1bb, P2)', async () => {
    const t = await switchThen(({ after }) => ({ job: 'install', state: 'running', phase: 'download', started: after }));
    try {
      const installsBefore = t.h.calls.filter((c) => c.includes(' install ')).length;
      for (const [method, url, body] of [['POST', '/api/admin/update/apply', {}], ['POST', '/api/admin/update/rollback', {}], ['POST', '/api/admin/update/channel', { channel: 'stable' }]]) {
        const r = await t.h.call(method, url, body);
        assert.equal(r.code, 409, `${url}: ${JSON.stringify(r.payload)}`);
        assert.equal(r.payload.error, 'channel_switch_pending');
      }
      assert.equal(t.h.calls.filter((c) => c.includes(' install ')).length, installsBefore, 'kein weiterer install');
      assert.ok(!t.h.calls.some((c) => c.endsWith(' rollback')), 'kein rollback');
      // Ist der Wechsel durch, geht es wieder.
      t.setStatus({ job: 'install', state: 'ok', result: 'ok', started: new Date(Date.now() + 5).toISOString() });
      const ok = await t.h.call('POST', '/api/admin/update/apply', {});
      assert.equal(ok.code, 200, JSON.stringify(ok.payload));
    } finally { t.h.cleanup(); }
  });

  it('Stromausfall im Auftrag: Ergebnis des resume (rolled_back) setzt den Kanal zurück (Codex ddd3f1bb, P2)', async () => {
    const { h, raw } = await switchThen(({ after }) => ({ job: 'resume', state: 'rolled_back', result: 'rolled_back', started: after }));
    try {
      await h.call('GET', '/api/admin/update/status');
      assert.equal(raw().updateChannel, 'dev');
    } finally { h.cleanup(); }
  });

  it('Rückfall nicht speicherbar: Vermerk bleibt, späterer Abruf holt ihn nach (Codex ddd3f1bb, P2)', async () => {
    let failSave = false;
    const t = await switchThen(({ after }) => ({ job: 'install', state: 'failed', result: 'failed', started: after }), { failSave: () => failSave });
    try {
      failSave = true;
      const s1 = await t.h.call('GET', '/api/admin/update/status');
      assert.equal(s1.payload.channelSwitch?.state, 'revert_failed');
      assert.ok(fs.existsSync(path.join(t.h.dataDir, MARK)), 'Vermerk bleibt für den nächsten Versuch');
      assert.ok(t.h.logs.some((l) => l.event === 'update_channel_revert_error'));
      failSave = false;
      const s2 = await t.h.call('GET', '/api/admin/update/status');
      assert.equal(s2.payload.channelSwitch?.state, 'reverted');
      assert.equal(t.raw().updateChannel, 'dev');
      assert.ok(!fs.existsSync(path.join(t.h.dataDir, MARK)));
    } finally { t.h.cleanup(); }
  });

  it('ohne Abfrage aus der Oberfläche: nach einem Neustart setzt der Server den Kanal selbst zurück', async () => {
    const t = await switchThen(({ after }) => ({ job: 'install', state: 'rolled_back', result: 'rolled_back', started: after }));
    try {
      // Neuer Prozess (Neustart durch den Auftrag): dieselben Dateien, neuer Router.
      let raw = t.raw();
      const logs = [];
      const handle = createAdminRoutes({
        ctx: {
          getServiceActionsEnabled: () => true, getRepoRoot: () => t.h.root, getAppDir: () => t.h.appDir, getDataDir: () => t.h.dataDir,
          getRawCfg: () => raw, saveAndApplyConfig: (c) => { raw = JSON.parse(JSON.stringify(c)); },
          getAppVersion: () => readAppVersionInfo({ appDir: t.h.appDir }), scheduleServiceRestart: () => {}, getServiceName: () => 'dvhub.service',
        },
        getCfg: () => ({}), pushLog: (event, f = {}) => logs.push({ event, ...f }), json: () => {}, checkAuth: () => true,
        execFileAsync: async (cmd, args = []) => (args[2] === 'status'
          ? { stdout: JSON.stringify({ ok: true, status: { job: 'install', state: 'rolled_back', result: 'rolled_back', started: new Date(Date.now() + 5).toISOString() } }), stderr: '' }
          : { stdout: '{}', stderr: '' }),
        GIT_SHA_REF, SEMVER_TAG, compareSemverTag, selectLatestSemverTag, assertNoDowngrade, listReachableReleaseTags: async () => '',
        channelWatchMs: 20,
      });
      assert.equal(typeof handle, 'function');
      for (let i = 0; i < 50 && raw.updateChannel !== 'dev'; i += 1) await new Promise((r) => setTimeout(r, 20));
      assert.equal(raw.updateChannel, 'dev');
      assert.ok(logs.some((l) => l.event === 'update_channel_reverted'));
      assert.ok(!fs.existsSync(path.join(t.h.dataDir, MARK)));
    } finally { t.h.cleanup(); }
  });
});
