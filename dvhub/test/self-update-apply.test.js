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
import crypto from 'node:crypto';
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
    if (cmd === 'git' && a === 'rev-parse HEAD') return { stdout: 'a'.repeat(40) + '\n', stderr: '' };
    if (cmd === 'git' && a.startsWith('show origin/main:')) return { stdout: JSON.stringify({ version: mainVersion }), stderr: '' };
    if (cmd === 'git' && a.startsWith('stash')) return { stdout: 'No local changes to save\n', stderr: '' };
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
  return { repoRoot, appDir, calls, post, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('Self-Update: Stash und npm-Marker', () => {
  for (const [label, pathname, body] of [
    ['update/apply', '/api/admin/update/apply', {}],
    ['update/channel', '/api/admin/update/channel', { channel: 'dev' }],
  ]) {
    it(`${label}: kein Stash von untracked Laufzeitdateien (eos-venv, forecast-venv, bin)`, async () => {
      const h = makeHarness();
      try {
        const r = await h.post(pathname, body);
        assert.equal(r.code, 200, JSON.stringify(r.payload));
        assert.ok(!h.calls.some((c) => /stash.*(--include-untracked|-u\b|--all)/.test(c)), h.calls.join('\n'));
      } finally { h.cleanup(); }
    });

    // Gegenprüfung zu 5fbdb213: nach Erfolg schreibt auch die Oberfläche den
    // Marker — sonst installiert post-update.sh danach ein zweites Mal.
    it(`${label}: nach erfolgreichem npm install = Lockfile-Hash (kein zweiter Lauf in post-update.sh)`, async () => {
      const h = makeHarness();
      try {
        const r = await h.post(pathname, body);
        assert.equal(r.code, 200, JSON.stringify(r.payload));
        const want = crypto.createHash('sha256').update(fs.readFileSync(path.join(h.appDir, 'package-lock.json'))).digest('hex');
        assert.equal(fs.readFileSync(path.join(h.repoRoot, '.npm-install-hash'), 'utf8').trim(), want);
      } finally { h.cleanup(); }
    });

    it(`${label}: npm-Marker ist vor jedem npm install ungültig — abgebrochener Lauf wird beim nächsten Start repariert`, async () => {
      const h = makeHarness({ npmFails: true });
      try {
        const r = await h.post(pathname, body);
        assert.equal(r.code, 500, 'Update wird zurückgerollt');
        assert.equal(fs.existsSync(path.join(h.repoRoot, '.npm-install-hash')), false,
          'Marker gelöscht → post-update.sh installiert beim nächsten Start neu');
      } finally { h.cleanup(); }
    });
  }
});
