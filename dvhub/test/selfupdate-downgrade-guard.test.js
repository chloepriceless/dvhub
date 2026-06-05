// T-0100 part 1: universal self-update downgrade guard.
//
// /api/admin/update/apply pulls origin/main (dev channel) or the latest release tag
// (stable channel). With origin/main 1082 commits behind v1.0-dev and tags stuck at
// v0.4.2, an unguarded auto-checkout would DOWNGRADE a live site. assertNoDowngrade is
// the pure decision the handler runs for BOTH channels before touching the working
// tree: refuse a downgrade or an undeterminable target (fail-safe), unless allowDowngrade.
// Pure test — no git, no server.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertNoDowngrade, compareSemverTag } from '../routes-api.js';

test('T-0100: the real-world danger — origin/main/v0.4.2 vs installed 0.8.0 is blocked', () => {
  assert.throws(
    () => assertNoDowngrade('0.4.2', '0.8.0', { label: 'latest release tag' }),
    (e) => e.code === 'downgrade_blocked'
  );
  // sanity: that IS a downgrade per compareSemverTag
  assert.equal(compareSemverTag('0.4.2', '0.8.0') < 0, true);
});

test('T-0100: an upgrade is allowed', () => {
  assert.doesNotThrow(() => assertNoDowngrade('0.9.0', '0.8.0', {}));
  assert.doesNotThrow(() => assertNoDowngrade('v1.0.0', '0.8.0', {}));
});

test('T-0100: same version is allowed (no-op re-apply)', () => {
  assert.doesNotThrow(() => assertNoDowngrade('0.8.0', '0.8.0', {}));
});

test('T-0100: a downgrade is blocked', () => {
  assert.throws(() => assertNoDowngrade('0.7.9', '0.8.0', {}), (e) => e.code === 'downgrade_blocked');
  assert.throws(() => assertNoDowngrade('v0.8.0', '0.8.1', {}), (e) => e.code === 'downgrade_blocked');
});

test('T-0100: an undeterminable target version fails safe (does not check out blindly)', () => {
  for (const bad of [null, undefined, '', 'main', 'not-a-version', 'origin/main']) {
    assert.throws(() => assertNoDowngrade(bad, '0.8.0', {}), (e) => e.code === 'version_undeterminable',
      `target ${JSON.stringify(bad)} must fail safe`);
  }
});

test('T-0100: allowDowngrade overrides BOTH the downgrade and the undeterminable guard', () => {
  assert.doesNotThrow(() => assertNoDowngrade('0.4.2', '0.8.0', { allowDowngrade: true }));
  assert.doesNotThrow(() => assertNoDowngrade(null, '0.8.0', { allowDowngrade: true }));
});

test('T-0100: missing currentVersion defaults to 0.0.0 (anything is an upgrade)', () => {
  assert.doesNotThrow(() => assertNoDowngrade('0.1.0', undefined, {}));
});
