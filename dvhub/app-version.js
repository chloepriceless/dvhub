import fs from 'node:fs';
import path from 'node:path';

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveGitDir(repoRoot) {
  const gitPath = path.join(repoRoot, '.git');
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return gitPath;
    if (!stat.isFile()) return null;
    const pointer = fs.readFileSync(gitPath, 'utf8').trim();
    const match = pointer.match(/^gitdir:\s*(.+)$/i);
    return match ? path.resolve(repoRoot, match[1]) : null;
  } catch {
    return null;
  }
}

function readGitRevision(repoRoot) {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return null;

  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head) return null;
    if (!head.startsWith('ref:')) return head.slice(0, 7);
    const ref = head.replace(/^ref:\s*/, '').trim();
    const revision = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    return revision ? revision.slice(0, 7) : null;
  } catch {
    return null;
  }
}

export function readAppVersionInfo({ appDir }) {
  const pkg = readJson(path.join(appDir, 'package.json')) || {};
  const name = String(pkg.name || 'dvhub');
  const version = String(pkg.version || '0.0.0');
  const revision = readGitRevision(path.resolve(appDir, '..'));

  return {
    name,
    version,
    revision,
    versionLabel: revision ? `v${version}+${revision}` : `v${version}`
  };
}
