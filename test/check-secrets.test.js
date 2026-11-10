// test/check-secrets.test.js — scripts/check-secrets.sh, Probe im
// Wegwerf-Repo (Paritätsfund dvhub-rs HANDOVER).
//
// Die Private-Key-Prüfung lief ins Leere: das Muster „-----BEGIN …“ ging ohne
// `-e` an git grep und wurde als Option gelesen (rc 129). Der Fehler wurde
// verschluckt, die Prüfung meldete nie etwas. Die Probe legt einen
// Schlüssel-Kopf (ohne echten Schlüssel, zur Laufzeit zusammengesetzt) in ein
// temporäres Repo und erwartet, dass die Sperre greift.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = path.join(repoRoot, 'scripts', 'check-secrets.sh');
const DASHES = '-'.repeat(5);
const keyHeader = (kind = '') => `${DASHES}BEGIN ${kind}PRIVATE KEY${DASHES}`;

function probeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-check-secrets-'));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-secrets.sh'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git('add', '-A');
  const run = spawnSync('bash', ['scripts/check-secrets.sh'], { cwd: dir, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return run;
}

test('Private-Key-Kopf in einer öffentlichen Datei sperrt den Push', () => {
  for (const kind of ['', 'RSA ', 'EC ', 'OPENSSH ']) {
    const r = probeRepo({ 'src/probe.pem': `${keyHeader(kind)}\nNUR-EIN-PLATZHALTER\n` });
    assert.equal(r.status, 1, `${kind || 'PKCS8'}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Private-Key-Material/);
    assert.match(r.stdout, /src\/probe\.pem/);
  }
});

test('Schlüssel-Kopf in Testdateien und Fixtures bleibt erlaubt; saubere Probe ist grün', () => {
  const r = probeRepo({
    'dvhub/test/fixtures/probe.pem': `${keyHeader()}\nPLATZHALTER\n`,
    'src/ok.js': 'export const x = 1;\n',
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Sauber/);
});

test('ein scheiternder git grep wird nicht als „sauber“ gewertet', () => {
  // Ohne -e liefert git grep für Muster mit führendem „-“ rc 129 — das darf
  // nie mehr still als „kein Treffer“ durchgehen.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /git grep -nIE -e "\$rx"/);
  assert.match(src, /git grep scheiterte/);
});
