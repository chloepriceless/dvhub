#!/usr/bin/env node
// gen-vendor-profile-hashes.mjs — regeneriert dvhub/hersteller/.shipped-hashes.json
// aus der git-Historie aller Herstellerprofile. NACH JEDER Profil-Änderung laufen
// lassen (der Drift-Guard-Test in test/vendor-profile-reconcile.test.js erzwingt es).
//
// Für jedes hersteller/<name>.json: sha256 aller je committeten Inhalts-Versionen
// (git show <commit>:<path>) PLUS des aktuellen Working-Tree-Stands. Ein aktives
// Profil, dessen Hash hier vorkommt, gilt beim Update als „unverändert" und wird
// überschrieben; ein unbekannter Hash = Operator-Edit (→ .dist).
//
// Aufruf: node scripts/gen-vendor-profile-hashes.mjs   (aus dem Repo-Root)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HERSTELLER = 'dvhub/hersteller';

const profiles = {};
for (const file of fs.readdirSync(HERSTELLER).sort()) {
  if (!file.endsWith('.json') || file.startsWith('.')) continue;
  const rel = `${HERSTELLER}/${file}`;
  const hashes = [];
  let commits = [];
  try {
    commits = execFileSync('git', ['log', '--follow', '--format=%H', '--', rel], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { /* nicht in git → nur Working-Tree */ }
  for (const c of commits) {
    try {
      const blob = execFileSync('git', ['show', `${c}:${rel}`]);
      const h = sha256(blob);
      if (!hashes.includes(h)) hashes.push(h);
    } catch { /* Datei in diesem Commit (noch) nicht da */ }
  }
  const cur = sha256(fs.readFileSync(rel));
  if (!hashes.includes(cur)) hashes.push(cur); // aktueller Working-Tree-Stand
  profiles[file] = hashes;
  process.stdout.write(`${file}: ${hashes.length} Versionen\n`);
}

const out = {
  _doc: 'sha256 aller je ausgelieferten Versionen jedes Herstellerprofils. Genutzt von scripts/reconcile-vendor-profiles.mjs: aktives Profil mit bekanntem Hash = unverändert → beim Update überschrieben; unbekannter Hash = Operator-Edit → neue Version als .dist. Regenerieren mit scripts/gen-vendor-profile-hashes.mjs.',
  profiles
};
fs.writeFileSync(`${HERSTELLER}/.shipped-hashes.json`, JSON.stringify(out, null, 2) + '\n');
process.stdout.write(`geschrieben: ${HERSTELLER}/.shipped-hashes.json\n`);
