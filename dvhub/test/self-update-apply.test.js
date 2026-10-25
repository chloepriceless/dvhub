// test/self-update-apply.test.js -- Ablauf von /api/admin/update/apply und
// /api/admin/update/channel (routes/admin-routes.js) mit aufgezeichneten
// Prozessaufrufen statt git/npm/sudo.
//
// Review 25.10.2026:
//  P1: `git stash --include-untracked` im Repo-Ordner (/opt/dvhub) räumte
//      eos-venv/, forecast-venv/ und bin/ weg (nicht in .gitignore), und der
//      Stash kam nie zurück. Untracked-Laufzeitdateien gehören nicht in den Stash.
//  P2: ein abgebrochenes npm install ließ node_modules halb zurück, und der
//      Lockfile-Marker von post-update.sh unterdrückte die Reparatur.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdminRoutes } from '../routes/admin-routes.js';
import { SEMVER_TAG, GIT_SHA_REF, compareSemverTag, selectLatestSemverTag, assertNoDowngrade } from '../routes-api.js';

export function makeHarness({ channel = 'dev', npmFails = false, mainVersion = '9.9.9', tags = 'v9.9.9' } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-selfupdate-'));
  const appDir = path.join(repoRoot, 'dvhub');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(repoRoot, '.npm-install-hash'), 'alt\n');
  fs.writeFileSync(path.join(appDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const calls = [];
  const execFileAsync = async (cmd, args = [], opts = {}) => {
    calls.push([cmd, ...args].join(' '));
    const a = args.join(' ');
    if (cmd === 'git' && a.startsWith('rev-parse')) return { stdout: 'a'.repeat(40) + '\n', stderr: '' };
    if (cmd === 'git' && a.startsWith('show origin/main:')) return { stdout: JSON.stringify({ version: mainVersion }), stderr: '' };
    if (cmd === 'sudo' && args.includes('stash')) return { stdout: 'No local changes to save\n', stderr: '' };
    const npm = cmd === 'npm' || (cmd === 'sudo' && args.includes('npm-install'));
    if (npm && npmFails) {
      const e = new Error('npm killed (timeout)'); e.killed = true; throw e;
    }
    void opts;
    return { stdout: '', stderr: '' };
  };
  const responses = [];
  const deps = {
    ctx: {
      getServiceActionsEnabled: () => true,
      getRepoRoot: () => repoRoot,
      getAppDir: () => appDir,
      getRawCfg: () => ({ updateChannel: channel }),
      saveAndApplyConfig: () => {},
      getAppVersion: () => ({ version: '1.0.0', versionLabel: '1.0.0' }),
      scheduleServiceRestart: () => { calls.push('<restart>'); },
      getServiceName: () => 'dvhub.service',
    },
    getCfg: () => ({}),
    pushLog: () => {},
    json: (res, code, payload) => { responses.push({ code, payload }); },
    checkAuth: () => true,
    execFileAsync,
    GIT_SHA_REF, SEMVER_TAG, compareSemverTag, selectLatestSemverTag, assertNoDowngrade,
    listReachableReleaseTags: async () => tags,
  };
  const handle = createAdminRoutes(deps);
  const post = async (pathname, body = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST'; req.headers = {};
    await handle(req, {}, new URL(`http://x${pathname}`));
    return responses.at(-1);
  };
  return { repoRoot, appDir, calls, post, handle, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

const HELPER = 'sudo -n /usr/local/libexec/dvhub-update';
// Was der Dienst NICHT mehr selbst ausführen darf: /opt/dvhub gehört root.
const MUTATING = /^(git (fetch|checkout|pull|stash|reset|clean)|npm |sudo bash )/;

describe('Self-Update über den root-eigenen Einstieg dvhub-update', () => {
  for (const [label, pathname, body, channel] of [
    ['update/apply dev', '/api/admin/update/apply', {}, 'dev'],
    ['update/apply stable', '/api/admin/update/apply', {}, 'stable'],
    ['update/apply Pin', '/api/admin/update/apply', { ref: 'a'.repeat(40) }, 'dev'],
    ['update/channel', '/api/admin/update/channel', { channel: 'dev' }, 'dev'],
  ]) {
    it(`${label}: schreibende Schritte nur über ${HELPER}, kein Stash von untracked Dateien`, async () => {
      const h = makeHarness({ channel });
      try {
        const r = await h.post(pathname, body);
        assert.equal(r.code, 200, JSON.stringify(r.payload));
        assert.deepEqual(h.calls.filter((c) => MUTATING.test(c)), [], h.calls.join('\n'));
        assert.ok(!h.calls.some((c) => /--include-untracked|stash .*-u\b|--all/.test(c)));
        const helperCalls = h.calls.filter((c) => c.startsWith(HELPER)).map((c) => c.slice(HELPER.length + 1));
        assert.ok(helperCalls.includes('stash'), helperCalls.join(' | '));
        assert.ok(helperCalls.includes('npm-install'), helperCalls.join(' | '));
        assert.ok(helperCalls.some((c) => /^checkout-(main|tag|commit)\b/.test(c)), helperCalls.join(' | '));
        if (pathname.endsWith('/apply')) assert.ok(helperCalls.includes('post-update'));
      } finally { h.cleanup(); }
    });
  }

  it('npm install scheitert → Rückroll über den Einstieg (checkout-commit <vorher>, npm-install)', async () => {
    const h = makeHarness({ npmFails: true });
    try {
      const r = await h.post('/api/admin/update/apply', {});
      assert.equal(r.code, 500);
      assert.ok(h.calls.includes(`${HELPER} checkout-commit ${'a'.repeat(40)}`), h.calls.join('\n'));
      assert.deepEqual(h.calls.filter((c) => MUTATING.test(c)), []);
    } finally { h.cleanup(); }
  });

  it('Update-Check holt Tags über den Einstieg', async () => {
    const h = makeHarness({ channel: 'stable' });
    try {
      const req = Readable.from([]); req.method = 'GET'; req.headers = {};
      await h.handle(req, {}, new URL('http://x/api/admin/update/check'));
      assert.ok(h.calls.includes(`${HELPER} fetch`), h.calls.join('\n'));
      assert.deepEqual(h.calls.filter((c) => MUTATING.test(c)), []);
    } finally { h.cleanup(); }
  });
});
