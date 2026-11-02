// release-info.js — erkennt eine Installation aus einem signierten
// Release-Paket (docs/release-pakete.md). Das Paket legt .dvhub-release.json in
// seinen Wurzelordner, also eine Ebene über dvhub/. Dort stehen Version, Kanal
// und Commit; einen git-Checkout gibt es dann nicht.

import fs from 'node:fs';
import path from 'node:path';

export const RELEASE_MANIFEST = '.dvhub-release.json';

export function readReleaseInfo(appDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(path.resolve(appDir, '..'), RELEASE_MANIFEST), 'utf8'));
    if (!m || m.format !== 1 || typeof m.version !== 'string') return null;
    return {
      version: m.version,
      channel: m.channel === 'dev' ? 'dev' : 'stable',
      gitSha: /^[0-9a-f]{40}$/.test(String(m.git_sha || '')) ? m.git_sha : null,
      arch: typeof m.arch === 'string' ? m.arch : null,
    };
  } catch {
    return null;
  }
}
