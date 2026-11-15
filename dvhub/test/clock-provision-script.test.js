// test/clock-provision-script.test.js — Box-Uhr-Provisionierung clock-provision.sh (Aufgabe 11).
// Feld 15.11.: eine Box lief mit „System clock synchronized: no, NTP inactive", 18 s daneben →
// EOS-Slots/Zeitpläne hängen daran. Das Skript aktiviert systemd-timesyncd (timedatectl set-ntp true)
// und meldet den Zustand. Getestet mit Attrappen für timedatectl/systemctl/systemd-detect-virt im PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'clock-provision.sh');

// Baut eine Testbox mit PATH-Attrappen (schirmt timedatectl/systemctl/systemd-detect-virt des Hosts ab, damit
// der Test überall deterministisch läuft). ntp = Startzustand ('yes'/'no'); container=true meldet „docker".
function setup({ ntp = 'no', sync = 'no', container = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-clock-')));
  const data = path.join(dir, 'data');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(bin);
  const ntpState = path.join(dir, 'ntp.state');
  const syncState = path.join(dir, 'sync.state');
  const calls = path.join(dir, 'calls.log');
  fs.writeFileSync(ntpState, `${ntp}\n`);
  fs.writeFileSync(syncState, `${sync}\n`);
  // timedatectl: show -p NTP/-p NTPSynchronized liest den Zustand; set-ntp true schaltet beide auf yes.
  fs.writeFileSync(path.join(bin, 'timedatectl'), [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  show)',
    '    if [[ "$3" == NTP ]]; then cat "$NTP_STATE"; elif [[ "$3" == NTPSynchronized ]]; then cat "$SYNC_STATE"; fi ;;',
    '  set-ntp)',
    '    echo "set-ntp $2" >> "$CALLS"',
    '    echo yes > "$NTP_STATE"; echo yes > "$SYNC_STATE" ;;',
    'esac',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  // systemctl-Attrappe (immer da, schirmt den Host ab): protokolliert und existiert (list-unit-files exit 0).
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/usr/bin/env bash\necho "systemctl $*" >> "$CALLS"\nexit 0\n', { mode: 0o755 });
  // systemd-detect-virt: „none" (oder „docker" im Container-Fall) — nie der Host-Wert.
  fs.writeFileSync(path.join(bin, 'systemd-detect-virt'), `#!/usr/bin/env bash\necho ${container ? 'docker' : 'none'}\nexit 0\n`, { mode: 0o755 });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, DATA_DIR: data,
    NTP_STATE: ntpState, SYNC_STATE: syncState, CALLS: calls,
  };
  return { dir, data, calls, env, ntpState };
}

// bash per absolutem Pfad, damit der Subprozess auch mit leerem PATH (Test „timedatectl fehlt") startet.
function run(env, args = []) {
  return spawnSync('/bin/bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
}

test('NTP inaktiv → set-ntp true, danach meldet es synchronisiert + Merker geschrieben', () => {
  const { data, calls, env } = setup({ ntp: 'no', sync: 'no' });
  const r = run(env);
  assert.equal(r.status, 0);
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.match(log, /set-ntp true/, 'aktiviert den Zeitabgleich');
  assert.match(r.stdout, /NTP-Dienst yes/, 'meldet NTP aktiv');
  assert.match(r.stdout, /synchronisiert yes/);
  assert.ok(fs.existsSync(path.join(data, '.ntp-provisioned')), 'Merker geschrieben');
});

test('NTP bereits aktiv → kein set-ntp, nur Meldung', () => {
  const { calls, env } = setup({ ntp: 'yes', sync: 'yes' });
  const r = run(env);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /bereits aktiv/);
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.doesNotMatch(log, /set-ntp/, 'nichts umgeschaltet');
});

test('Opt-out .no-ntp → nur gemeldet, nicht aktiviert', () => {
  const { data, calls, env } = setup({ ntp: 'no' });
  fs.writeFileSync(path.join(data, '.no-ntp'), '');
  const r = run(env);
  assert.equal(r.status, 0);
  assert.match(r.stderr + r.stdout, /\.no-ntp/);
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.doesNotMatch(log, /set-ntp/);
});

test('--check: read-only, meldet Zustand, ändert nichts', () => {
  const { calls, env } = setup({ ntp: 'no', sync: 'no' });
  const r = run(env, ['--check']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NTP-Dienst no/);
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.doesNotMatch(log, /set-ntp/, '--check schaltet nie');
});

test('Container → übersprungen (Host-Uhr zählt), kein set-ntp', () => {
  const { calls, env } = setup({ ntp: 'no', container: true });
  const r = run(env);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Container/);
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.doesNotMatch(log, /set-ntp/);
});

test('Mit systemd-timesyncd-Unit: nach set-ntp wird die Unit entmaskt/aktiviert', () => {
  const { calls, env } = setup({ ntp: 'no' });
  const r = run(env);
  assert.equal(r.status, 0);
  const log = fs.readFileSync(calls, 'utf8');
  assert.match(log, /set-ntp true/);
  assert.match(log, /enable --now systemd-timesyncd/);
});

test('timedatectl fehlt → freundliche Meldung, kein Fehler', () => {
  const { dir, env } = setup({ ntp: 'no' });
  // PATH auf ein leeres Verzeichnis → timedatectl definitiv nicht auffindbar (Host-timedatectl ausgeschlossen).
  const emptyBin = path.join(dir, 'empty');
  fs.mkdirSync(emptyBin);
  const r = run({ ...env, PATH: emptyBin });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /timedatectl nicht vorhanden/);
});
