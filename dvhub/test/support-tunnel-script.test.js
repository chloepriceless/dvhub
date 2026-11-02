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
      const r = spawnSync('bash', [SCRIPT, '--ttl', bad, '--print'], { encoding: 'utf8', env: t.env });
      assert.equal(r.status, 2, `--ttl ${JSON.stringify(bad)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--ttl/);
    }
    for (const good of ['0', '5', '60', '240', '08']) {
      const r = spawnSync('bash', [SCRIPT, '--ttl', good, '--print'], { encoding: 'utf8', env: t.env });
      assert.equal(r.status, 0, `--ttl ${good}: ${r.stderr}`);
    }
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('T-0004: fremder Prozess mit dem Schlüsselpfad blockiert nicht und wird von --close nicht beendet', async () => {
  const t = setup();
  // Köder: Befehlszeile enthält den Schlüsselpfad (wie `less …/relay_id_ed25519`).
  const decoy = spawn('bash', ['-c', 'sleep 300', t.key], { stdio: 'ignore', detached: true });
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
    const second = spawnSync('bash', [SCRIPT, '--ttl', '5'], { encoding: 'utf8', env: t.env });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /läuft bereits/);

    const close = spawnSync('bash', [SCRIPT, '--close'], { encoding: 'utf8', env: t.env });
    assert.equal(close.status, 0, close.stderr);
    assert.match(close.stdout, /beendet/);
    for (let i = 0; i < 30 && tunnel.exitCode === null; i += 1) await sleep(100);
    assert.notEqual(tunnel.exitCode, null, 'Tunnel-Skript beendet');
    assert.ok(alive(decoy.pid), 'Köder lebt noch');
    assert.ok(!fs.existsSync(pidFile), 'PID-Datei weg');

    const again = spawnSync('bash', [SCRIPT, '--close'], { encoding: 'utf8', env: t.env });
    assert.match(again.stdout, /Kein laufender Support-Tunnel/);
    assert.ok(alive(decoy.pid), 'Köder lebt auch nach zweitem --close');
  } finally {
    try { process.kill(-decoy.pid, 'SIGKILL'); } catch { /* weg */ }
    if (tunnel) { try { process.kill(-tunnel.pid, 'SIGKILL'); } catch { /* weg */ } }
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});
