// test/eos-watch-compose.test.js — Wächter im EOS-Container (docker/compose.yml,
// configs dvhub-eos-watch, 2026-10-18). Getestet wird genau das Skript aus der
// Compose-Datei, mit echtem Python gegen einen Ersatz-DVhub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const composePath = fileURLToPath(new URL('../../docker/compose.yml', import.meta.url));
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

function watcherScript() {
  const lines = fs.readFileSync(composePath, 'utf8').split('\n');
  const start = lines.findIndex((l) => l === '  dvhub-eos-watch:');
  assert.ok(start > 0, 'configs.dvhub-eos-watch fehlt in docker/compose.yml');
  assert.equal(lines[start + 1], '    content: |');
  const body = [];
  for (const l of lines.slice(start + 2)) {
    if (l.trim() && !l.startsWith('      ')) break;
    body.push(l.slice(6));
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eos-watch-')), 'watch.py');
  fs.writeFileSync(file, body.join('\n'));
  return file;
}

async function fakeDvhub(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, boot: Number(u.searchParams.get('boot')) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, requestedAt: answer(seen.at(-1)) }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

function runWatcher(script, url, childCode, extraEnv = {}) {
  const p = spawn(PY, [script, '--', PY, '-c', childCode], {
    env: { ...process.env, DVHUB_URL: url, DVHUB_URL_FILE: '/nonexistent/dvhub-url', DVHUB_EOS_WATCH_SEC: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => p.on('exit', (code, signal) => resolve({ code, signal, out })));
  return { p, done };
}

test('Anforderung jünger als der Start → EOS wird beendet, Wächter endet mit 75', { skip: !PY }, async () => {
  const dv = await fakeDvhub((q) => q.boot + 1);
  try {
    const t0 = Date.now();
    const { done } = runWatcher(watcherScript(), dv.url, 'import time; time.sleep(60)');
    const r = await done;
    assert.equal(r.code, 75);
    assert.match(r.out, /fordert einen Neustart an/);
    assert.ok(Date.now() - t0 < 15_000, 'innerhalb weniger Sekunden');
    assert.equal(dv.seen[0].path, '/api/eos/restart-request');
    assert.ok(dv.seen[0].boot > 0 && Math.abs(dv.seen[0].boot - t0) < 5_000, 'boot = Startzeit in ms');
  } finally { await dv.close(); }
});

test('Ältere Anforderung oder keine → EOS läuft weiter; Exit-Code des Kindes wird weitergereicht', { skip: !PY }, async () => {
  const dv = await fakeDvhub((q) => q.boot - 60_000);
  try {
    const r = await runWatcher(watcherScript(), dv.url, 'import sys, time; time.sleep(2.5); sys.exit(3)').done;
    assert.equal(r.code, 3);
    assert.ok(dv.seen.length >= 1, 'hat gefragt');
  } finally { await dv.close(); }
  // DVhub nicht erreichbar: nichts passiert
  const r2 = await runWatcher(watcherScript(), 'http://127.0.0.1:9', 'import sys, time; time.sleep(1.5); sys.exit(0)').done;
  assert.equal(r2.code, 0);
});

test('docker stop (SIGTERM) wird an EOS weitergegeben', { skip: !PY }, async () => {
  const dv = await fakeDvhub(() => null);
  try {
    const { p, done } = runWatcher(watcherScript(), dv.url,
      'import signal, sys, time\nsignal.signal(signal.SIGTERM, lambda *a: sys.exit(42))\nprint("bereit", flush=True)\ntime.sleep(60)');
    // Erst senden, wenn das Kind seinen Handler hat — feste 800 ms reichten
    // unter Last (volle Testsuite) nicht immer.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Kind meldet sich nicht')), 15_000);
      const check = (d) => { if (String(d).includes('bereit')) { clearTimeout(t); p.stdout.off('data', check); resolve(); } };
      p.stdout.on('data', check);
    });
    p.kill('SIGTERM');
    const r = await done;
    assert.equal(r.code, 42, 'Kind hat SIGTERM bekommen und sich mit 42 beendet');
  } finally { await dv.close(); }
});

// Codex 2026-10-18: Port in der Oberfläche geändert → DVHUB_URL stimmt nicht mehr.
// Maßgeblich ist die Adresse, die DVhub beim Start in die gemeinsame Datei schreibt.
test('Adresse aus der gemeinsamen Datei hat Vorrang vor DVHUB_URL', { skip: !PY }, async () => {
  const dv = await fakeDvhub((q) => q.boot + 1);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-watch-url-'));
    const file = path.join(dir, 'dvhub-url');
    fs.writeFileSync(file, `${dv.url}\n`);
    const r = await runWatcher(watcherScript(), 'http://127.0.0.1:9', 'import time; time.sleep(60)', { DVHUB_URL_FILE: file }).done;
    assert.equal(r.code, 75, 'über die Datei erreicht und Neustart ausgeführt');
    assert.ok(dv.seen.length >= 1);
  } finally { await dv.close(); }
});
