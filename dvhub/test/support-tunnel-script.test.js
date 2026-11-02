// test/support-tunnel-script.test.js -- Notfall-Skript dvhub-support-tunnel.sh.
//  Strix T-0002 (30.10.2026): --ttl wurde nicht geprüft; 0, -1, abc, 1e3
//    liefen ohne Auto-Close, 43200 schloss erst nach 30 Tagen. Erlaubt sind
//    nur 0 (bis Strg-C) und 5–240 Minuten.
//  Strix T-0004: --close und der Konflikt-Schutz suchten mit `pgrep -f
//    <Schlüsselpfad>` — jeder Prozess mit dem Pfad in der Befehlszeile (z. B.
//    `less …/relay_id_ed25519`) blockierte das Öffnen oder wurde von --close
//    als root beendet. Jetzt zählen nur die PIDs, die das Skript selbst
//    aufschreibt (tunnel-manual.pid) bzw. tunnel-state.json des Dienstes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'dvhub-support-tunnel.sh');

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-tunnel-sh-')));
  const data = path.join(dir, 'data');
  const sup = path.join(data, 'support');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(sup, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(sup, 'relay.json'), JSON.stringify({ host: 'relay.invalid', port: 47821, user: 'dvhub-support', shellPort: 49101, webPort: 49102 }));
  fs.writeFileSync(path.join(sup, 'relay_id_ed25519'), 'KEY', { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'appliance-id'), 'test-box');
  // autossh-Attrappe: hält wie autossh einen Kindprozess (ssh) am Leben.
  fs.writeFileSync(path.join(bin, 'autossh'), '#!/usr/bin/env bash\nsleep 300 &\nwait\n', { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, DV_DATA_DIR: data, HOME: dir };
  return { dir, data, sup, key: path.join(sup, 'relay_id_ed25519'), env };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('T-0002: --ttl nur 0 oder 5–240, sonst Abbruch mit Meldung', () => {
  const t = setup();
  try {
    for (const bad of ['abc', '-1', '1e3', '43200', '3', '241', '', '08x']) {
      const r = spawnSync('bash', [SCRIPT, '--ttl', bad, '--print'], { encoding: 'utf8', env: t.env, timeout: 15_000 });
      assert.equal(r.status, 2, `--ttl ${JSON.stringify(bad)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--ttl/);
    }
    for (const good of ['0', '5', '60', '240', '08']) {
      const r = spawnSync('bash', [SCRIPT, '--ttl', good, '--print'], { encoding: 'utf8', env: t.env, timeout: 15_000 });
      assert.equal(r.status, 0, `--ttl ${good}: ${r.stderr}`);
    }
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('T-0004: fremder Prozess mit dem Schlüsselpfad blockiert nicht und wird von --close nicht beendet', async () => {
  const t = setup();
  // Köder: Befehlszeile enthält den Schlüsselpfad (wie `less …/relay_id_ed25519`).
  const decoy = spawn('bash', ['-c', 'sleep 300; :', t.key], { stdio: 'ignore', detached: true });
  let tunnel;
  try {
    await sleep(200);
    tunnel = spawn('bash', [SCRIPT, '--ttl', '5'], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    tunnel.stdout.on('data', (d) => { out += d; });
    tunnel.stderr.on('data', (d) => { out += d; });
    for (let i = 0; i < 50 && !/Tunnel OFFEN/.test(out) && tunnel.exitCode === null; i += 1) await sleep(100);
    assert.match(out, /Tunnel OFFEN/, out);
    const pidFile = path.join(t.sup, 'tunnel-manual.pid');
    assert.ok(fs.existsSync(pidFile), 'PID-Datei geschrieben');

    // Zweites Öffnen: läuft schon (über die PID-Datei erkannt).
    const second = spawnSync('bash', [SCRIPT, '--ttl', '5'], { encoding: 'utf8', env: t.env, timeout: 15_000 });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /läuft bereits/);

    const close = spawnSync('bash', [SCRIPT, '--close'], { encoding: 'utf8', env: t.env, timeout: 15_000 });
    assert.equal(close.status, 0, close.stderr);
    assert.match(close.stdout, /beendet/);
    for (let i = 0; i < 30 && tunnel.exitCode === null; i += 1) await sleep(100);
    assert.notEqual(tunnel.exitCode, null, 'Tunnel-Skript beendet');
    assert.ok(alive(decoy.pid), 'Köder lebt noch');
    assert.ok(!fs.existsSync(pidFile), 'PID-Datei weg');

    const again = spawnSync('bash', [SCRIPT, '--close'], { encoding: 'utf8', env: t.env, timeout: 15_000 });
    assert.match(again.stdout, /Kein laufender Support-Tunnel/);
    assert.ok(alive(decoy.pid), 'Köder lebt auch nach zweitem --close');
  } finally {
    try { process.kill(-decoy.pid, 'SIGKILL'); } catch { /* weg */ }
    if (tunnel) { try { process.kill(-tunnel.pid, 'SIGKILL'); } catch { /* weg */ } }
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

// Gegenprüfung 2e784304 (P1): nach Ablauf der Zeit beendete ein schon
// abgelaufenes sleep das Aufräumen unter set -e (Exit 1, PID-Datei blieb).
test('Auto-Close nach Ablauf: Exit 0, aufgeräumt, keine rohen Shell-Fehler', async () => {
  const t = setup();
  try {
    const r = await new Promise((resolve) => {
      const p = spawn('bash', [SCRIPT, '--ttl', '5'], { env: { ...t.env, DVHUB_TUNNEL_TEST_TTL_S: '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => resolve({ code, out, err }));
    });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Support-Tunnel geschlossen/);
    assert.ok(!fs.existsSync(path.join(t.sup, 'tunnel-manual.pid')), 'PID-Datei weg');
    assert.doesNotMatch(r.err, /No such file|Datei oder Verzeichnis nicht gefunden/, r.err);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// Gegenprüfung 2e784304 (P2): App-Tunnel ohne Unit (tunnel-process.json).
test('--close beendet den von der App selbst gestarteten Tunnel, nicht den Köder', async () => {
  const t = setup();
  const appTunnel = spawn('bash', ['-c', 'sleep 300; :', '-i', t.key], { stdio: 'ignore', detached: true });
  const decoy = spawn('bash', ['-c', 'sleep 300; :', t.key], { stdio: 'ignore', detached: true });
  try {
    await sleep(200);
    fs.writeFileSync(path.join(t.sup, 'tunnel-process.json'), JSON.stringify({ pid: appTunnel.pid }));
    const busy = spawnSync('bash', [SCRIPT, '--ttl', '5'], { encoding: 'utf8', env: t.env, timeout: 15_000 });
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /läuft bereits/);
    const close = spawnSync('bash', [SCRIPT, '--close'], { encoding: 'utf8', env: t.env, timeout: 15_000 });
    assert.match(close.stdout, /beendet/);
    for (let i = 0; i < 20 && alive(appTunnel.pid); i += 1) await sleep(100);
    assert.ok(!alive(appTunnel.pid), 'App-Tunnel beendet');
    assert.ok(alive(decoy.pid), 'Köder lebt');
    assert.equal(close.stderr, '', close.stderr);
  } finally {
    for (const p of [appTunnel, decoy]) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* weg */ } }
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('PID-Datei als FIFO lässt --close nicht hängen', () => {
  const t = setup();
  try {
    spawnSync('mkfifo', [path.join(t.sup, 'tunnel-manual.pid')]);
    const r = spawnSync('bash', [SCRIPT, '--close'], { encoding: 'utf8', env: t.env, timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Kein laufender Support-Tunnel/);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// Gegenprüfung 98bfcb68 (P2): ohne lesbaren Schlüssel endete das Skript still
// (pipefail in der KEY_UID-Zeile), statt die Einrichtungs-Meldung zu zeigen.
test('ohne Schlüssel: Öffnen meldet FEHLER, --close sagt „kein Tunnel“', () => {
  const t = setup();
  try {
    fs.rmSync(t.key);
    const open = spawnSync('bash', [SCRIPT, '--ttl', '5'], { encoding: 'utf8', env: t.env, timeout: 15_000 });
    assert.equal(open.status, 1);
    assert.match(open.stderr, /FEHLER: Support nicht eingerichtet/);
    const close = spawnSync('bash', [SCRIPT, '--close'], { encoding: 'utf8', env: t.env, timeout: 15_000 });
    assert.equal(close.status, 0, close.stderr);
    assert.match(close.stdout, /Kein laufender Support-Tunnel/);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// Gegenprüfung 5cdad8bf (P2): ohne sudo meldete --close „kein Tunnel“, obwohl
// einer lief (support/ nicht lesbar).
test('ohne Leserecht auf support/: klare Meldung „mit sudo ausführen“', { skip: process.getuid?.() === 0 ? 'als root immer lesbar' : false }, () => {
  const t = setup();
  try {
    fs.chmodSync(t.sup, 0o000);
    for (const args of [['--close'], ['--ttl', '5']]) {
      const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: t.env, timeout: 15_000 });
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /mit sudo ausführen/);
    }
  } finally { fs.chmodSync(t.sup, 0o700); fs.rmSync(t.dir, { recursive: true, force: true }); }
});
