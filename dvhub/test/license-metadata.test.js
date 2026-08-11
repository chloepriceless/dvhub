import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This test file lives in dvhub/test/; repo-root is two levels up.
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const license = read('LICENSE.md');
const commercial = read('COMMERCIAL_LICENSE.md');
const pkg = read('dvhub/package.json');
const installSh = read('install.sh');

test('LICENSE.md names the real copyright rights-holder entity', () => {
  // Operator-approved deviation (28-04): the copyright line names the company
  // rights-holder (Bikini Bottom Capital GmbH); `chloepriceless` is RETAINED as
  // the person/author alongside the company, so we assert the company is PRESENT
  // rather than asserting the old name is absent.
  assert.match(
    license,
    /Copyright \(c\) 2026 Bikini Bottom Capital GmbH/,
    'LICENSE.md line 3 must name the real copyright entity (Bikini Bottom Capital GmbH)'
  );
});

test('COMMERCIAL_LICENSE.md has a real commercial contact and no placeholder text', () => {
  assert.match(
    commercial,
    /info@bikinibottom\.capital/,
    'COMMERCIAL_LICENSE.md must contain the real commercial-license contact email'
  );
  assert.match(
    commercial,
    /Bikini Bottom Capital GmbH/,
    'COMMERCIAL_LICENSE.md must name the commercial-license company'
  );
  assert.doesNotMatch(
    commercial,
    /please contact the author|contact the repository owner/i,
    'COMMERCIAL_LICENSE.md must not keep the placeholder contact text'
  );
});

test('release-repo chloepriceless/dvhub URLs are preserved (not renamed)', () => {
  // The 11 github.com/chloepriceless/dvhub sites are live release-repo URLs and the
  // installer/release anchor depend on them. A global rename would break the installer.
  assert.match(
    pkg,
    /chloepriceless\/dvhub/,
    'dvhub/package.json repository.url must keep the chloepriceless/dvhub release-repo URL'
  );
  assert.match(
    installSh,
    /chloepriceless\/dvhub/,
    'install.sh REPO_URL must keep the chloepriceless/dvhub release-repo URL'
  );
});
