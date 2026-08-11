// Phase 28-01 / W5.1: defensive self-update tag selection.
//
// The 4 routes-api.js tag-selection sites (+ install.sh:318) historically picked
// `git tag --sort=-v:refname | head -1` with NO filter, so a stray non-semver tag
// (e.g. a CI build tag `build-5918`, or a bare numeric `5918`) could win and get
// checked out. selectLatestSemverTag() is the shared, pure guard: it parses an
// already-sorted tag-list string and returns the FIRST line that is a real semver
// release tag (reusing the canonical SEMVER_TAG export), else null. No git, no server.

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectLatestSemverTag, SEMVER_TAG } from '../routes-api.js';

test('W5.1: picks the highest semver among a mixed, already-sorted tag list', () => {
  // Empirically-verified --sort=-v:refname order from RESEARCH §1.
  const input = 'v1.0.0\nv1.0\nv0.8.0\nv0.4.2\nbuild-5918\n5918';
  assert.equal(selectLatestSemverTag(input), 'v1.0.0');
});

test('W5.1: skips non-semver leading lines and returns the first real release tag', () => {
  // A CI build tag and a bare numeric must NOT be selected even though they sort first.
  assert.equal(selectLatestSemverTag('build-5918\n5918\nv0.4.2'), 'v0.4.2');
});

test('W5.1: returns null for an all-junk list and for empty / null / undefined input', () => {
  assert.equal(selectLatestSemverTag('build-5918\nmain\nnot-a-version'), null);
  assert.equal(selectLatestSemverTag(''), null);
  assert.equal(selectLatestSemverTag(null), null);
  assert.equal(selectLatestSemverTag(undefined), null);
});

test('W5.1: v1.0.0 outranks v0.4.2 and bare numerics; whitespace/blank lines ignored', () => {
  // Blank lines and surrounding whitespace must be trimmed/dropped, not break selection.
  assert.equal(selectLatestSemverTag('\n  5918 \n\n  v1.0.0  \n v0.4.2 '), 'v1.0.0');
  // The selector reuses the canonical SEMVER_TAG guard (sanity: bare numeric is NOT a release tag).
  assert.equal(SEMVER_TAG.test('5918'), false);
  assert.equal(SEMVER_TAG.test('v1.0.0'), true);
});

// ---------------------------------------------------------------------------
// T-UPDATE-ANCHOR (2026-07-03): listReachableReleaseTags — release anchors must
// be REACHABLE from origin/main. Git-fixture test: builds a repo whose history
// mirrors the live public repo (orphaned pre-cleanup tags v0.4.2… NOT ancestors
// of the cleaned main) and proves the orphans are filtered out.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listReachableReleaseTags } from '../routes-api.js';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

function makeFixtureRepo({ withReachableTag = false, withOriginMain = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-anchor-'));
  git(dir, 'init', '-q', '-b', 'old-history');
  // Orphaned pre-cleanup history with an old release tag (mirrors live v0.4.2).
  fs.writeFileSync(path.join(dir, 'a.txt'), 'old');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'old history');
  git(dir, 'tag', '-a', 'v0.4.2', '-m', 'old release');
  // Cleaned main = a fresh ORPHAN branch — the old tag is NOT an ancestor.
  git(dir, 'checkout', '-q', '--orphan', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'clean');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'cleaned main');
  if (withReachableTag) git(dir, 'tag', '-a', 'v1.0.0', '-m', 'real release');
  if (withOriginMain) git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
  return dir;
}

test('T-UPDATE-ANCHOR: orphaned pre-cleanup tag is NOT a release anchor (live v0.4.2 case)', async () => {
  const repo = makeFixtureRepo();
  const tags = await listReachableReleaseTags(repo);
  assert.equal(selectLatestSemverTag(tags), null, 'v0.4.2 (not an ancestor of origin/main) must be filtered out');
});

test('T-UPDATE-ANCHOR: a real release tag ON main is selected; the orphan still is not', async () => {
  const repo = makeFixtureRepo({ withReachableTag: true });
  const tags = await listReachableReleaseTags(repo);
  assert.equal(selectLatestSemverTag(tags), 'v1.0.0');
  assert.ok(!tags.includes('v0.4.2'), 'orphaned v0.4.2 must not appear in the reachable list');
});

test('T-UPDATE-ANCHOR: missing origin/main falls back to the unfiltered list (no hard error)', async () => {
  const repo = makeFixtureRepo({ withOriginMain: false });
  const tags = await listReachableReleaseTags(repo);
  // Fallback returns the plain list — the downgrade guard downstream still protects.
  assert.equal(selectLatestSemverTag(tags), 'v0.4.2');
});
