// test/npm-cache-update.test.js — npm-Cache und Besitz von node_modules.
// 2026-10-15: Update über die Oberfläche scheiterte an root-eigenen Einträgen im
// npm-Cache des Dienstbenutzers (EACCES). Damals lief npm deshalb als
// Dienstbenutzer. Seit der Rechte-Härtung (Review 25.10.2026) gehören
// /opt/dvhub und node_modules root, und JEDES npm install läuft als root mit
// HOME=/root — post-update.sh genauso wie das Update aus der Oberfläche
// (dvhub-update npm-install). Der Cache des Dienstbenutzers wird nicht mehr benutzt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('dvhub/.npmrc lenkt npm auf einen eigenen Cache (gilt auch für älteren Update-Code)', () => {
  assert.match(read('../.npmrc'), /^cache=\$\{HOME\}\/\.cache\/dvhub-npm$/m);
});

test('post-update.sh: npm als root mit HOME=/root, kein chown von APP_DIR/node_modules an den Dienstbenutzer', () => {
  const s = read('../../post-update.sh');
  // Entkoppelt in eigener Unit, ohne systemd-run im Vordergrund mit Zeitgrenze
  // (Gegenprüfung 25.10.2026) — beide als root mit HOME=/root.
  assert.match(s, /\nHOME=\/root npm install --omit=dev --ignore-scripts --no-audit --no-fund \|\| exit 1\n/);
  assert.match(s, /elif pu_bounded 75 env HOME=\/root npm install --omit=dev --ignore-scripts --no-audit --no-fund; then/);
  assert.doesNotMatch(s, /runuser -u "\$SERVICE_USER" -- env HOME=.*npm/);
  assert.doesNotMatch(s, /chown[^\n]*"\$SERVICE_USER:\$SERVICE_USER"[^\n]*(APP_DIR|node_modules)/);
});

test('dvhub-update.sh: npm install als root mit HOME=/root', () => {
  assert.match(read('../../dvhub-update.sh'), /env HOME="\$\{DVHUB_UPDATE_TEST_HOME:-\/root\}" npm install --omit=dev --ignore-scripts --no-audit --no-fund$/m);
});

// Strix R-0004 (30.10.2026): npm läuft als root. Ohne --ignore-scripts führte
// jedes Paket mit Install-Skript (preinstall/postinstall) bei jedem Update
// Code als root aus. Heute hat keines eines (0/211) — das Skript-Verbot hält
// das so, auch für künftige Abhängigkeiten.
// Gegenprüfung d70ba301 (P3): EIN geteilter Prüfer (kein kopierter Regex),
// alle Unterbefehle, die Pakete installieren (install/i/in/…/add, ci/ic/
// clean-install, update/up, rebuild/rb), Prüfung je Aufruf statt je Zeile,
// Fortsetzungszeilen zusammengezogen, echo-/--description-Texte entfernt statt
// die ganze Zeile zu überspringen.
const NPM_INSTALL_CMD = /\bnpm\b(?:\s+--?[\w-]+(?:[ =](?:"[^"]*"|'[^']*'|[^\s;&|'"]+))?)*\s+(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|ci|ic|clean-install|install-clean|isntall-clean|update|up|upgrade|udpate|rebuild|rb)\b[^;&|'"]*/g;
function npmInstallCallsWithoutIgnoreScripts(text) {
  const joined = text.replace(/\\\n\s*/g, ' ');
  const bad = [];
  let count = 0;
  for (const raw of joined.split('\n')) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw
      .replace(/\s#.*$/, '')                                   // Kommentar am Zeilenende
      .replace(/(\becho|--description)\s+"[^"]*"/g, '$1 ""');   // nur der Text, nicht die Zeile
    for (const m of line.matchAll(NPM_INSTALL_CMD)) {
      count += 1;
      if (!/(^|\s)--ignore-scripts(?=\s|$)/.test(m[0])) bad.push(m[0].trim());
    }
  }
  return { count, bad };
}

test('R-0004: jedes npm install in den Shell-Skripten ohne Lifecycle-Skripte', async () => {
  // Gegenprüfung f5ea8f2d (P3): alle versionierten *.sh.
  const { execFileSync } = await import('node:child_process');
  const root = new URL('../../', import.meta.url);
  const files = execFileSync('git', ['ls-files', '*.sh', '**/*.sh'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.includes('post-update.sh') && files.includes('dvhub-update.sh'), files.join(' '));
  let seen = 0;
  for (const f of files) {
    const { count, bad } = npmInstallCallsWithoutIgnoreScripts(fs.readFileSync(new URL(f, root), 'utf8'));
    seen += count;
    assert.deepEqual(bad, [], `${f}: npm-Aufruf ohne --ignore-scripts`);
  }
  assert.ok(seen >= 5, `npm-install-Aufrufe gefunden: ${seen}`);
});

test('R-0004: der Wächter erkennt abweichende Schreibweisen und Umgehungen', () => {
  for (const l of [
    'HOME=/root npm install || exit 1', 'npm --prefix "$APP_DIR" install --omit=dev', 'cd x; npm ci', 'npm i',
    'npm add left-pad', 'npm clean-install', 'npm update', 'npm rebuild',
    'npm install --ignore-scripts=false', 'npm ci --ignore-scripts || npm install', 'npm install # --ignore-scripts',
    'echo start; npm install', "systemd-run --description x bash -c 'npm install'", 'npm --prefix "$APP_DIR" \\\n  install',
  ]) {
    assert.equal(npmInstallCallsWithoutIgnoreScripts(l).bad.length, 1, l);
  }
  for (const l of [
    'npm install --omit=dev --ignore-scripts --no-audit --no-fund', 'echo "npm install: OK"',
    '--description "DVhub npm install (Abhaengigkeiten nach Update)" \\', '# npm install', 'npm test', 'npm run lint',
  ]) {
    assert.equal(npmInstallCallsWithoutIgnoreScripts(l).bad.length, 0, l);
  }
});

test('R-0004: kein Paket im Lockfile braucht ein Install-Skript', () => {
  const lock = JSON.parse(read('../package-lock.json'));
  const withScripts = Object.entries(lock.packages || {}).filter(([, v]) => v.hasInstallScript).map(([k]) => k);
  assert.deepEqual(withScripts, [], 'Paket mit Install-Skript: mit --ignore-scripts prüfen, ob es ohne läuft');
});
