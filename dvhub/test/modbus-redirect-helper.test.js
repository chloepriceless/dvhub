// dvhub-modbus-redirect.sh — Ersatzweg Modbus-Port (2026-10-18). Läuft als root
// über sudo; prüft Interface und Ports selbst. Hier mit nachgestelltem nft bzw.
// iptables im PATH, die ihre Aufrufe protokollieren.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODBUS_REDIRECT_HELPER } from '../vpn-manager.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(repoRoot, 'dvhub-modbus-redirect.sh');

function rig(tools = ['nft']) {
  const bin = mkdtempSync(path.join(tmpdir(), 'dvhub-mbredir-'));
  const log = path.join(bin, 'calls.log');
  for (const t of tools) {
    const p = path.join(bin, t);
    // Protokolliert Argumente; bei „-f -“ auch die Regeln von stdin. Wie echtes
    // iptables: -D/-C auf eine fehlende Regel scheitern (sonst liefe die
    // Löschschleife im Skript endlos).
    writeFileSync(p, `#!/bin/bash\necho "${t} $*" >> "${log}"\nif [[ "$*" == "-f -" ]]; then /bin/cat >> "${log}"; fi\nif [[ "$*" == *" -D "* || "$*" == *" -C "* ]]; then exit 1; fi\nexit 0\n`);
    chmodSync(p, 0o755);
  }
  const run = (...args) => spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: bin } });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { run, calls };
}

test('add mit nft: Tabelle in einem Zug ersetzt, Umleitung nur am Tunnel-Interface', () => {
  const r = rig(['nft']);
  const res = r.run('add', 'tun0', '502', '1502');
  assert.equal(res.status, 0, res.stderr);
  const log = r.calls();
  assert.match(log, /^nft -f -$/m);
  assert.match(log, /delete table ip dvhub_modbus/);
  assert.match(log, /type nat hook prerouting priority dstnat; policy accept;/);
  assert.match(log, /iifname "tun0" tcp dport 502 redirect to :1502/);
});

test('del mit nft entfernt die Tabelle', () => {
  const r = rig(['nft']);
  assert.equal(r.run('del').status, 0);
  assert.match(r.calls(), /^nft delete table ip dvhub_modbus$/m);
});

test('ohne nft: iptables mit eigener Kette', () => {
  const r = rig(['iptables']);
  assert.equal(r.run('add', 'wg0', '502', '1502').status, 0);
  const log = r.calls();
  assert.match(log, /iptables -t nat -A DVHUB_MODBUS -i wg0 -p tcp --dport 502 -j REDIRECT --to-ports 1502/);
  assert.match(log, /iptables -t nat -I PREROUTING 1 -j DVHUB_MODBUS|iptables -t nat -C PREROUTING -j DVHUB_MODBUS/);
  assert.equal(r.run('del').status, 0);
  assert.match(r.calls(), /iptables -t nat -X DVHUB_MODBUS/);
});

test('weder nft noch iptables: klare Meldung', () => {
  const r = rig([]);
  const res = r.run('add', 'tun0', '502', '1502');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /weder nft noch iptables/);
});

test('lehnt fremde Interfaces, Pfad-Tricks und ungültige Ports ab — ohne nft-Aufruf', () => {
  const r = rig(['nft']);
  const bad = [
    ['add', '../x', '502', '1502'], ['add', 'lo', '502', '1502'], ['add', 'a b', '502', '1502'],
    ['add', 'x'.repeat(16), '502', '1502'], ['add', 'tun0"; flush ruleset; "', '502', '1502'],
    ['add', 'tun0', '0', '1502'], ['add', 'tun0', '502', '65536'], ['add', 'tun0', '502', '1502;'],
    ['add', 'tun0', '502', '502'], ['add', 'tun0', '502'], ['add', 'tun0', '502', '1502', 'x'],
    ['del', 'x'], ['flush'], [],
  ];
  for (const args of bad) {
    const res = r.run(...args);
    assert.equal(res.status, 2, `Aufruf ${JSON.stringify(args)}: ${res.stderr}`);
  }
  assert.equal(r.calls(), '', 'nft nie aufgerufen');
});

for (const file of ['install.sh', 'post-update.sh']) {
  test(`${file}: Hilfsskript installiert, sudoers nur add */del`, () => {
    const src = readFileSync(path.join(repoRoot, file), 'utf8');
    // Installiert über den gemeinsamen HELPERS-Block (Gegenprüfung 25.10.2026).
    assert.equal(MODBUS_REDIRECT_HELPER, '/usr/local/libexec/dvhub-modbus-redirect');
    assert.ok(src.includes('DVHUB_LIBEXEC="${DVHUB_LIBEXEC:-/usr/local/libexec}"'));
    assert.ok(src.includes('MODBUS_REDIRECT_PATH="$DVHUB_LIBEXEC/dvhub-modbus-redirect"'));
    assert.ok(src.includes('dvhub_install_helper dvhub-modbus-redirect.sh "$MODBUS_REDIRECT_PATH"'));
    assert.ok(src.includes('${SERVICE_USER} ALL=(root) NOPASSWD: ${MODBUS_REDIRECT_PATH} add *\n'));
    assert.ok(src.includes('${SERVICE_USER} ALL=(root) NOPASSWD: ${MODBUS_REDIRECT_PATH} del\n'));
  });
}

test('Container: Hilfsskript root-eigen im Image, sudoers nur add */del', () => {
  const df = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  assert.match(df, new RegExp(`COPY --chmod=0755 dvhub-modbus-redirect\\.sh ${MODBUS_REDIRECT_HELPER}`));
  assert.ok(df.includes(`'dvhub ALL=(root) NOPASSWD: ${MODBUS_REDIRECT_HELPER} add *'`));
  assert.ok(df.includes(`'dvhub ALL=(root) NOPASSWD: ${MODBUS_REDIRECT_HELPER} del'`));
  assert.match(df, /apk add [^\n]*\bnftables\b/);
  assert.match(readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8'), /^!dvhub-modbus-redirect\.sh$/m);
});
