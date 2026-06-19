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
