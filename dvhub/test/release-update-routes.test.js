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

function harness({ channel = 'stable', helper = {}, release = {} } = {}) {
  const rel = makeRelease(release);
  const calls = [];
  const saved = [];
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
      getServiceActionsEnabled: () => true,
      getRepoRoot: () => rel.root,
      getAppDir: () => rel.appDir,
      getRawCfg: () => ({ updateChannel: channel }),
      saveAndApplyConfig: (c) => { saved.push(c); },
      getAppVersion: () => readAppVersionInfo({ appDir: rel.appDir }),
      scheduleServiceRestart: () => { calls.push('<restart>'); },
      getServiceName: () => 'dvhub.service',
    },
    getCfg: () => ({}),
    pushLog: () => {},
    json: (res, code, payload) => { responses.push({ code, payload }); },
    checkAuth: () => true,
    execFileAsync,
    GIT_SHA_REF, SEMVER_TAG, compareSemverTag, selectLatestSemverTag, assertNoDowngrade,
    listReachableReleaseTags: async () => '',
  };
  const handle = createAdminRoutes(deps);
  const call = async (method, pathname, body = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = method; req.headers = {};
    await handle(req, {}, new URL(`http://x${pathname}`));
    return responses.at(-1);
  };
  return { ...rel, calls, saved, call };
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

  it('apply startet install latest <kanal> und plant keinen eigenen Neustart', async () => {
    const h = harness({ channel: 'dev', helper: { install: { ok: true, started: true, job: 'install' } } });
    try {
      const r = await h.call('POST', '/api/admin/update/apply', {});
      assert.equal(r.code, 200, JSON.stringify(r.payload));
      assert.equal(r.payload.mode, 'package');
      assert.equal(r.payload.job, 'install');
      assert.ok(h.calls.includes(`sudo -n ${RELEASE_HELPER} install latest dev`));
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
    const h = harness({ channel: 'stable', helper: { install: { ok: true, started: true } } });
    try {
      const r = await h.call('POST', '/api/admin/update/channel', { channel: 'dev' });
      assert.equal(r.code, 200, JSON.stringify(r.payload));
      assert.equal(h.saved.at(-1).updateChannel, 'dev');
      assert.ok(h.calls.includes(`sudo -n ${RELEASE_HELPER} install latest dev`));
      assert.ok(!h.calls.some((c) => c.startsWith('git ')));
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
