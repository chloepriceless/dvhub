// test/static-serving-stream.test.js -- statische Dateien über einen echten
// HTTP-Server (Gegenprüfung zu W1, e33145bd/f18e951b).
//  P2: pipe() zerstörte den Lese-Stream nicht, wenn der Client mitten im
//      Download abbrach — der Dateideskriptor blieb offen (ohne Token
//      wiederholbar → EMFILE).
//  P3: writeHead(200) lief vor dem Öffnen der Datei; eine unlesbare Datei
//      gab einen Verbindungsabbruch statt der zugesagten 404.
//  P3: der W1-Test prüfte nur Verzeichnisse — auch „alles 404“ hätte bestanden.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiRoutes } from '../routes-api.js';

function ctxFor(appDir, extra = {}) {
  return {
    ...extra,
    getAppDir: () => appDir,
    getCfg: () => ({}),
    getRawCfg: () => ({}),
    pushLog: () => {},
  };
}

async function serve(appDir, extra) {
  const routes = createApiRoutes(ctxFor(appDir, extra));
  const server = http.createServer((req, res) => routes.serveStatic(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function openFds() {
  try { return fs.readdirSync('/dev/fd').length; } catch { return null; }
}

function setupApp() {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-static-'));
  fs.mkdirSync(path.join(app, 'public', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(app, 'public', 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(app, 'public', 'assets', 'big.png'), Buffer.alloc(16 * 1024 * 1024, 7));
  return app;
}

test('echte Datei → 200 mit Inhalt, Verzeichnis → 404', async () => {
  const app = setupApp();
  const { server, port } = await serve(app);
  try {
    const ok = await get(port, '/index.html');
    assert.equal(ok.status, 200);
    assert.equal(ok.body, '<!doctype html><title>x</title>');
    assert.equal((await get(port, '/assets')).status, 404);
  } finally { server.close(); fs.rmSync(app, { recursive: true, force: true }); }
});

test('unlesbare Datei → 404 statt Verbindungsabbruch', { skip: process.getuid?.() === 0 ? 'als root ist jede Datei lesbar' : false }, async () => {
  const app = setupApp();
  const f = path.join(app, 'public', 'geheim.js');
  fs.writeFileSync(f, 'x');
  fs.chmodSync(f, 0o000);
  const { server, port } = await serve(app);
  try {
    const r = await get(port, '/geheim.js');
    assert.equal(r.status, 404);
  } finally { server.close(); fs.chmodSync(f, 0o600); fs.rmSync(app, { recursive: true, force: true }); }
});

test('abgebrochener Download gibt den Dateideskriptor frei', { skip: openFds() === null ? 'kein /dev/fd' : false }, async () => {
  const app = setupApp();
  const { server, port } = await serve(app);
  try {
    await get(port, '/index.html'); // Server warm, Keep-Alive-Sockets stabil
    const before = openFds();
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/assets/big.png', agent: false }, (res) => {
          res.pause(); // nicht lesen: Gegendruck staut den Server-Stream
          setTimeout(() => { req.destroy(); resolve(); }, 150);
        });
        req.on('error', () => {});
      });
    }
    await new Promise((r) => setTimeout(r, 400));
    const after = openFds();
    assert.ok(after - before <= 1, `offene Deskriptoren vorher ${before}, nachher ${after}`);
  } finally { server.closeAllConnections?.(); server.close(); fs.rmSync(app, { recursive: true, force: true }); }
});

// Gegenprüfung zu 1bc645ab (P2): ein Client, der nicht liest, aber verbunden
// bleibt, hielt Deskriptor und Socket unbegrenzt (kein Server-Timeout).
test('stehender Client wird nach der Leerlauf-Grenze getrennt, Deskriptor frei', { skip: openFds() === null ? 'kein /dev/fd' : false }, async () => {
  const app = setupApp();
  const { server, port } = await serve(app, { staticIdleTimeoutMs: 300 });
  const reqs = [];
  try {
    await get(port, '/index.html');
    const before = openFds();
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/assets/big.png', agent: false }, (res) => { res.pause(); resolve(); });
        req.on('error', () => {});
        reqs.push(req);
      });
    }
    await new Promise((r) => setTimeout(r, 1200));
    const after = openFds();
    // Die Client-Sockets dieses Prozesses zählen mit: höchstens sie bleiben offen.
    assert.ok(after - before <= reqs.length, `offene Deskriptoren vorher ${before}, nachher ${after}`);
  } finally {
    for (const r of reqs) r.destroy();
    server.closeAllConnections?.(); server.close(); fs.rmSync(app, { recursive: true, force: true });
  }
});
