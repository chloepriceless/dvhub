// test/node-runtime-provision.test.js -- Port-Recht ueber systemd + jemalloc.
// Das Skript laeuft als ExecStartPre bei JEDEM Start. Ein Fehler hier heisst:
// DVhub bindet Port 80 nicht mehr. Getestet wird darum vor allem der Umstieg
// in zwei Starts: das Datei-Recht faellt erst, wenn systemd das Port-Recht
// schon fuer den laufenden Start geladen hatte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node-runtime-provision.sh');

function setup({ jemalloc = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-nrp-'));
  const ambientFile = join(dir, 'ambient');
  writeFileSync(ambientFile, '');
  const log = join(dir, 'calls.log');
  const fake = (name, body) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const systemctl = fake('systemctl', `if [[ "$1" == show ]]; then cat "${ambientFile}"; fi`);
  const setcap = fake('setcap', '');
  const lib = join(dir, 'lib', 'x86_64-linux-gnu', 'libjemalloc.so.2');
  if (jemalloc) { mkdirSync(dirname(lib), { recursive: true }); writeFileSync(lib, ''); }
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  const dropinDir = join(dir, 'dvhub.service.d');
  const run = (extraEnv = {}) => execFileSync('bash', [SCRIPT], {
    env: {
      PATH: process.env.PATH, SYSTEMCTL: systemctl, SETCAP: setcap, NODE_BIN: '/usr/bin/node',
      DATA_DIR: dataDir, DROPIN_DIR: dropinDir, JEMALLOC_CANDIDATES: `${dir}/lib/*/libjemalloc.so.2`, ...extraEnv
    },
    encoding: 'utf8'
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  // "Neustart": systemd hat den Drop-in geladen, Aufrufprotokoll beginnt neu.
  const restart = () => { writeFileSync(ambientFile, 'cap_net_bind_service'); rmSync(log, { force: true }); };
  const optOut = () => writeFileSync(join(dataDir, '.no-jemalloc'), '');
  const conf = () => readFileSync(join(dropinDir, '10-node-runtime.conf'), 'utf8');
  return { run, calls, conf, lib, restart, optOut, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('erster Start nach dem Update: Drop-in schreiben, setcap BLEIBT (dieser Start hat noch kein systemd-Recht)', () => {
  const s = setup();
  try {
    s.run();
    assert.match(s.conf(), /^AmbientCapabilities=CAP_NET_BIND_SERVICE$/m);
    assert.match(s.conf(), new RegExp(`^Environment=LD_PRELOAD=${s.lib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(s.conf(), /^Environment=MALLOC_CONF=background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:0$/m);
    const c = s.calls();
    assert.ok(c.includes('systemctl daemon-reload'));
    assert.ok(c.includes('setcap cap_net_bind_service=+ep /usr/bin/node'));
    assert.ok(!c.some((l) => l.startsWith('setcap -r')), 'nie ohne Port-Recht starten');
  } finally { s.cleanup(); }
});

test('zweiter Start: systemd hatte das Recht geladen → Datei-Recht weg, kein Reload', () => {
  const s = setup();
  try {
    s.run();
    s.restart();
    s.run();
    const c = s.calls();
    assert.ok(c.includes('setcap -r /usr/bin/node'));
    assert.ok(!c.includes('systemctl daemon-reload'), 'Drop-in unveraendert → kein Reload');
  } finally { s.cleanup(); }
});

test('Neuinstallation (FRESH): Dienst startet erst danach → Datei-Recht sofort weg', () => {
  const s = setup();
  try {
    s.run({ NODE_RUNTIME_FRESH: '1' });
    assert.ok(s.calls().includes('setcap -r /usr/bin/node'));
  } finally { s.cleanup(); }
});

test('ohne libjemalloc2: nur das Port-Recht, glibc wie bisher', () => {
  const s = setup({ jemalloc: false });
  try {
    s.run();
    assert.match(s.conf(), /AmbientCapabilities=CAP_NET_BIND_SERVICE/);
    assert.doesNotMatch(s.conf(), /^Environment=/m);
  } finally { s.cleanup(); }
});

test('Opt-out .no-jemalloc nimmt jemalloc wieder raus (Drop-in wird umgeschrieben)', () => {
  const s = setup();
  try {
    s.run();
    s.restart();
    s.optOut();
    s.run();
    assert.doesNotMatch(s.conf(), /^Environment=LD_PRELOAD/m);
    assert.ok(s.calls().includes('systemctl daemon-reload'));
    assert.ok(s.calls().includes('setcap -r /usr/bin/node'), 'Port-Recht war geladen');
  } finally { s.cleanup(); }
});

test('Fehler in systemctl/setcap sind nie fatal', () => {
  const s = setup();
  try {
    const out = s.run({ SYSTEMCTL: '/bin/false', SETCAP: '/bin/false' });
    assert.match(out, /setcap bleibt/);
  } finally { s.cleanup(); }
});
