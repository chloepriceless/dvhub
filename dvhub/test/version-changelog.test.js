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
//
// Ausnahme seit 1.0.10 (Bleeding-Edge-Pakete aus main, Christin 05.11.2026):
// Nach einem Release steht package.json auf main schon auf der NÄCHSTEN Nummer,
// damit dev-Pakete (<pkg>-dev.<Zeit>.<sha8>) nach dem Release sortieren
// (test/release-build.test.js). CHANGELOG und README nennen bis zum nächsten
// Release weiter das letzte; erlaubt ist das nur mit Einträgen unter
// [Unreleased] und nur genau eine Stelle weiter (Patch, Minor oder Major).
const esc = (v) => v.replace(/\./g, '\\.');
const escapedVersion = () => esc(pkg.version);
const releases = [...changelog.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}/gm)].map((m) => m.slice(1, 4).map(Number));
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const newestRelease = releases.sort((a, b) => cmp(b, a))[0];
const unreleasedBody = (/^## \[Unreleased\][^\n]*\n([\s\S]*?)^## \[/m.exec(changelog) || [])[1] || '';
const pkgParts = pkg.version.split('.').map(Number);
const isNextAfter = (v, r) => (v[0] === r[0] && v[1] === r[1] && v[2] === r[2] + 1)
  || (v[0] === r[0] && v[1] === r[1] + 1 && v[2] === 0)
  || (v[0] === r[0] + 1 && v[1] === 0 && v[2] === 0);
const inDevelopment = () => !!newestRelease && /^\s*- /m.test(unreleasedBody) && isNextAfter(pkgParts, newestRelease);

test('package.json version is semver and has a matching CHANGELOG heading (read at boot by app-version.js)', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json needs a semver version');
  if (inDevelopment()) return;   // nächste Version in Arbeit (siehe oben)
  assert.match(
    changelog,
    new RegExp(`^#+\\s*\\[?${escapedVersion()}`, 'm'),
    `CHANGELOG.md must contain a ${pkg.version} heading (oder: [Unreleased] mit Einträgen und package.json genau eine Version über dem letzten Release)`
  );
});

test('package.json läuft nach einem Release nicht über die nächste Version hinaus', () => {
  assert.ok(newestRelease, 'CHANGELOG nennt Releases');
  const exact = cmp(pkgParts, newestRelease) === 0;
  assert.ok(exact || inDevelopment(), `package.json ${pkg.version}: erwartet ${newestRelease.join('.')} oder die nächste Version mit Einträgen unter [Unreleased]`);
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
  // In Arbeit (package.json schon auf der nächsten Nummer): README nennt das letzte Release.
  const shown = inDevelopment() ? newestRelease.join('.') : pkg.version;
  assert.match(readme, new RegExp(`Version ${esc(shown)}`), `README must advertise Version ${shown}`);
  assert.doesNotMatch(readme, /bewusst als 0\.8 geführt/, 'README must no longer claim the build is deliberately 0.8');
});
