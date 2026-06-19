import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// dvhub/test/ -> repo root is two levels up.
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dvhub', 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

test('package.json declares version 1.0.0 (read at boot by app-version.js)', () => {
  assert.equal(pkg.version, '1.0.0', 'package.json version must be 1.0.0');
});

test('package.json keeps the chloepriceless/dvhub release-repo URL (DO NOT TOUCH)', () => {
  // Guards threat T-28-04: the version bump must not disturb repository.url.
  assert.match(
    pkg.repository?.url ?? '',
    /chloepriceless\/dvhub/,
    'repository.url must still point at the chloepriceless/dvhub release repo'
  );
});

test('CHANGELOG.md exists and carries a 1.0.0 heading', () => {
  assert.match(changelog, /^#+\s*\[?1\.0\.0/m, 'CHANGELOG.md must contain a 1.0.0 heading');
});

test('README status badge reads Version 1.0.0 and drops the obsolete 0.8 note', () => {
  assert.match(readme, /Version 1\.0\.0/, 'README must advertise Version 1.0.0');
  assert.doesNotMatch(
    readme,
    /bewusst als 0\.8 geführt/,
    'README must no longer claim the build is deliberately 0.8'
  );
});
