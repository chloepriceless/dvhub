// T-COMMIT-PIN: the /api/admin/update/apply `ref` allowlist (GIT_SHA_REF).
//
// A beta tester can pin a specific bleeding-edge commit ("install exactly THIS
// dev commit"). The ref goes straight into `git rev-parse`/`git checkout` args,
// so the format guard is the security boundary: it must accept plain hex SHAs
// (7–40 chars) and reject everything else — shell metacharacters, git flag
// injection (a leading `-` read as `--upload-pack`), refspecs, path traversal.
// Reachability (ancestor of origin/main) is enforced separately at checkout.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GIT_SHA_REF } from '../routes-api.js';

test('accepts valid hex SHAs (short 7 to full 40)', () => {
  assert.equal(GIT_SHA_REF.test('0ae0128'), true);          // 7-char short
  assert.equal(GIT_SHA_REF.test('56e01c9d'), true);         // 8-char short
  assert.equal(GIT_SHA_REF.test('a'.repeat(40)), true);     // full 40
  assert.equal(GIT_SHA_REF.test('0AE0128'), true);          // uppercase hex
  assert.equal(GIT_SHA_REF.test('deadBEEF'), true);
});

test('rejects too-short, too-long, and non-hex', () => {
  assert.equal(GIT_SHA_REF.test('0ae012'), false);          // 6 chars — too short
  assert.equal(GIT_SHA_REF.test('a'.repeat(41)), false);    // 41 — too long
  assert.equal(GIT_SHA_REF.test('0ae012g'), false);         // 'g' not hex
  assert.equal(GIT_SHA_REF.test('v1.0.0'), false);          // semver tag → stable channel, not a pin
  assert.equal(GIT_SHA_REF.test('main'), false);            // branch name
});

test('rejects injection / flag-abuse payloads', () => {
  assert.equal(GIT_SHA_REF.test('--upload-pack=touch /tmp/x'), false); // git flag injection
  assert.equal(GIT_SHA_REF.test('-0ae0128'), false);                   // leading dash
  assert.equal(GIT_SHA_REF.test('0ae0128; rm -rf /'), false);          // shell metachars
  assert.equal(GIT_SHA_REF.test('0ae0128 origin'), false);             // embedded space
  assert.equal(GIT_SHA_REF.test('HEAD~3'), false);                     // rev expression
  assert.equal(GIT_SHA_REF.test('origin/main'), false);                // refspec / slash
  assert.equal(GIT_SHA_REF.test('../../etc/passwd'), false);           // path traversal
  assert.equal(GIT_SHA_REF.test(''), false);                           // empty
  assert.equal(GIT_SHA_REF.test('0ae0128\n56e01c9'), false);           // newline smuggling
});
