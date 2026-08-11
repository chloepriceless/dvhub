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

// Generisch (nicht mehr auf 1.0.0 hartkodiert — war stale seit 1.0.1): die
// package.json-Version, der neueste CHANGELOG-Heading und das README-Badge müssen
// synchron sein. So bricht der Test bei jedem Bump, bei dem eins vergessen wurde.
const escapedVersion = () => pkg.version.replace(/\./g, '\\.');

test('package.json version is semver and has a matching CHANGELOG heading (read at boot by app-version.js)', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json needs a semver version');
  assert.match(
    changelog,
    new RegExp(`^#+\\s*\\[?${escapedVersion()}`, 'm'),
    `CHANGELOG.md must contain a ${pkg.version} heading`
  );
});

test('package.json keeps the chloepriceless/dvhub release-repo URL (DO NOT TOUCH)', () => {
  // Guards threat T-28-04: the version bump must not disturb repository.url.
  assert.match(
    pkg.repository?.url ?? '',
    /chloepriceless\/dvhub/,
    'repository.url must still point at the chloepriceless/dvhub release repo'
  );
});

test('README status badge advertises the package.json version and drops the obsolete 0.8 note', () => {
  assert.match(readme, new RegExp(`Version ${escapedVersion()}`), `README must advertise Version ${pkg.version}`);
  assert.doesNotMatch(readme, /bewusst als 0\.8 geführt/, 'README must no longer claim the build is deliberately 0.8');
});
