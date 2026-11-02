// Sicherheits-Tests für das blinde Relay der Handy-App (Strix-Funde
// H-0001, H-0002, H-0004, H-0005, verifiziert 30.10.2026). Nur lokal —
// niemals gegen relay.dvhub.de.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

import { b64u, generateIdentity, issueTicket, relayAuthData } from '../services/mobile-link/crypto.js';
import { createRelay, createMemorySocketPair, DEFAULT_LIMITS } from '../services/mobile-link/relay-core.js';
import * as relayServer from '../services/mobile-link/relay-server.js';
import * as relayCore from '../services/mobile-link/relay-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until: timeout');
    await sleep(10);
  }
}

function memClient(relay, remote = null) {
  const [mine, theirs] = createMemorySocketPair();
  const inbox = [];
  const state = { closed: null };
  mine.onMessage((t) => inbox.push(JSON.parse(t)));
  relay.attach({
    send: theirs.send, onMessage: theirs.onMessage, onClose: theirs.onClose,
    close: (code, reason) => { state.closed = { code, reason }; theirs.close(); },
  }, { remote });
  return {
    inbox, state,
    send: (o) => mine.send(JSON.stringify(o)),
    async next(type) { return until(() => { const i = inbox.findIndex((m) => !type || m.t === type); return i >= 0 ? inbox.splice(i, 1)[0] : null; }); },
  };
}

async function boxOnRelay(relay, signer, remote = null) {
  const c = memClient(relay, remote);
  const ch = await c.next('challenge');
  c.send({ t: 'auth', role: 'box', pub: b64u(signer.publicRaw), sig: b64u(signer.sign(relayAuthData('box', ch.n))) });
  await c.next('ok');
  return c;
}

async function deviceOnRelay(relay, boxSigner, devSigner) {
  const c = memClient(relay);
  const ch = await c.next('challenge');
  c.send({ t: 'auth', role: 'device', ticket: issueTicket(boxSigner, devSigner.id, Math.floor(Date.now() / 1000) + 3600), pub: b64u(devSigner.publicRaw), sig: b64u(devSigner.sign(relayAuthData('device', ch.n))) });
  return c;
}

// Ein Rundlauf über die Box-Verbindung: danach sind alle vorher gesendeten
// Rahmen verarbeitet.
async function flush(b) {
  b.send({ t: 'ping' });
  await b.next('pong');
}

const b64 = (n, ch = 'A') => ch.repeat(n);

// ── H-0001: Quelladresse hinter dem Proxy ──────────────────────────────────

describe('Relay-Sicherheit H-0001: Quelladresse', () => {
  test('clientAddress folgt der Proxy-Kette von rechts, nur von vertrauten Proxys', () => {
    const { clientAddress } = relayServer;
    assert.equal(typeof clientAddress, 'function', 'clientAddress fehlt');
    const req = (xff, peer) => ({ headers: xff == null ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: peer } });
    // Caddy hängt die echte Adresse hinten an — der Eintrag davor ist frei wählbar.
    assert.equal(clientAddress(req('6.6.6.6, 198.51.100.9', '172.18.0.5'), '1'), '198.51.100.9');
    assert.equal(clientAddress(req('198.51.100.9', '::ffff:172.18.0.5'), '1'), '198.51.100.9');
    // Zwei Proxys hintereinander: der vorletzte Eintrag.
    assert.equal(clientAddress(req('6.6.6.6, 198.51.100.9, 10.0.0.2', '127.0.0.1'), '2'), '198.51.100.9');
    // Öffentliche Gegenstelle ist kein vertrauter Proxy → Kopfzeile egal.
    assert.equal(clientAddress(req('198.51.100.9', '203.0.113.1'), '1'), '203.0.113.1');
    // Ohne Vertrauen: immer die Gegenstelle.
    assert.equal(clientAddress(req('198.51.100.9', '127.0.0.1'), ''), '127.0.0.1');
    // Unsinn in der Kopfzeile → Gegenstelle.
    assert.equal(clientAddress(req('kein-ip', '172.18.0.5'), '1'), '172.18.0.5');
    assert.equal(clientAddress(req(null, '172.18.0.5'), '1'), '172.18.0.5');
    // IPv4 in IPv6 → IPv4; IPv6 je /64 zusammengefasst (sonst hat jeder
    // Anschluss 2^64 Adressen für die Grenze je Quelle).
    assert.equal(clientAddress(req(null, '::ffff:198.51.100.9'), ''), '198.51.100.9');
    assert.equal(clientAddress(req('2001:db8:1:2::1', '172.18.0.5'), '1'), clientAddress(req('2001:db8:1:2:ffff::7', '172.18.0.5'), '1'));
    assert.notEqual(clientAddress(req('2001:db8:1:2::1', '172.18.0.5'), '1'), clientAddress(req('2001:db8:1:3::1', '172.18.0.5'), '1'));
  });

  test('gefälschtes X-Forwarded-For umgeht die Grenze je Quelle nicht (echter WebSocket)', async () => {
    const old = process.env.RELAY_TRUST_PROXY;
    process.env.RELAY_TRUST_PROXY = '1';
    const srv = relayServer.startRelayServer({ port: 0, host: '127.0.0.1', limits: { maxConnectionsPerRemote: 2 }, log: () => {}, pingMs: 0 });
    try {
      const { port } = await srv.ready;
      const results = [];
      const socks = [];
      for (let i = 0; i < 3; i++) {
        // So kommt es bei Caddy an: frei gewählter Eintrag vorn, echte Adresse hinten.
        const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { 'x-forwarded-for': `10.9.8.${i}, 198.51.100.9` } });
        socks.push(ws);
        results.push(await new Promise((resolve) => {
          ws.once('message', () => resolve('challenge'));
          ws.once('close', (code, reason) => resolve(String(reason)));
          ws.once('error', () => resolve('error'));
        }));
      }
      assert.deepEqual(results, ['challenge', 'challenge', 'too_many_connections']);
      for (const ws of socks) ws.terminate();
    } finally {
      if (old === undefined) delete process.env.RELAY_TRUST_PROXY; else process.env.RELAY_TRUST_PROXY = old;
      await srv.close();
    }
  });

  test('Standardgrenzen passen zum Container (256 MiB): Verbindungen + Briefkästen deutlich darunter', () => {
    // ~10 KiB je offene Verbindung (Strix-Messung), dazu die Briefkästen.
    const worst = DEFAULT_LIMITS.maxConnections * 10 * 1024 + DEFAULT_LIMITS.mailboxTotalBytes;
    assert.ok(worst <= 128 * 1024 * 1024, `Worst Case ${Math.round(worst / 1048576)} MiB`);
    assert.ok(DEFAULT_LIMITS.mailboxBytesPerBox > 0 && DEFAULT_LIMITS.mailboxBytesPerBox < DEFAULT_LIMITS.mailboxTotalBytes / 8);
  });
});

// ── H-0002: Briefkasten-Speicher ───────────────────────────────────────────

describe('Relay-Sicherheit H-0002: Briefkasten-Speicher', () => {
  test('Grenze je Box: eine Box verdrängt nur ihre eigenen ältesten Einträge', async () => {
    const relay = createRelay({ limits: { mailboxBytesPerBox: 64 * 1024, boxFramesPerWindow: 1e6, boxBytesPerWindow: 1e9 } });
    const good = generateIdentity();
    const evil = generateIdentity();
    const g = await boxOnRelay(relay, good);
    g.send({ t: 'allow', devs: ['handy'] });
    g.send({ t: 'mbox_put', dev: 'handy', d: b64(1000, 'G') });
    await flush(g);
    const before = relay.stats().mailboxBytes;
    const e = await boxOnRelay(relay, evil);
    const devs = Array.from({ length: 8 }, (_, i) => `d${i}`);
    e.send({ t: 'allow', devs });
    for (let i = 0; i < 40; i++) e.send({ t: 'mbox_put', dev: devs[i % 8], d: b64(8000, String.fromCharCode(66 + (i % 20))) });
    await flush(e);
    const evilBytes = relay.stats().mailboxBytes - before;
    assert.ok(evilBytes <= 64 * 1024, `Box belegt ${evilBytes} B trotz Grenze 64 KiB`);
    assert.equal(e.inbox.filter((m) => m.t === 'error').length, 0, 'Älteste weichen, statt abzulehnen');
    // Die andere Box ist unberührt.
    assert.equal(relay.stats().mailboxBytes - evilBytes, before);
    relay.close();
  });

  test('globales Budget voll: ältestes zuerst verwerfen statt neue Meldungen abzulehnen', async () => {
    const relay = createRelay({ limits: { mailboxTotalBytes: 40 * 1024, mailboxBytesPerBox: 30 * 1024, boxFramesPerWindow: 1e6, boxBytesPerWindow: 1e9 } });
    const boxes = [];
    for (let i = 0; i < 4; i++) {
      const b = await boxOnRelay(relay, generateIdentity());
      b.send({ t: 'allow', devs: ['h'] });
      boxes.push(b);
    }
    for (const [i, b] of boxes.entries()) {
      for (let k = 0; k < 3; k++) b.send({ t: 'mbox_put', dev: 'h', d: b64(4000, String.fromCharCode(65 + i)) });
      await flush(b);
    }
    const st = relay.stats();
    assert.ok(st.mailboxBytes <= 40 * 1024, `Budget überschritten: ${st.mailboxBytes}`);
    for (const b of boxes) assert.equal(b.inbox.filter((m) => m.t === 'error').length, 0, 'keine relay_full-Ablehnung');
    relay.close();
  });

  test('nur Base64url wird abgelegt (sonst zählt ein Zeichen 2 Byte)', async () => {
    const relay = createRelay();
    const b = await boxOnRelay(relay, generateIdentity());
    b.send({ t: 'allow', devs: ['h'] });
    b.send({ t: 'mbox_put', dev: 'h', d: '€'.repeat(100) });
    assert.equal((await b.next('error')).e, 'bad_data');
    assert.equal(relay.stats().mailboxes, 0);
    relay.close();
  });

  test('Buchhaltung ≥ echter Speicher (eigener Prozess mit --expose-gc)', async () => {
    const core = pathToFileURL(path.join(here, '..', 'services', 'mobile-link', 'relay-core.js')).href;
    const cry = pathToFileURL(path.join(here, '..', 'services', 'mobile-link', 'crypto.js')).href;
    const script = `
      import { createRelay, createMemorySocketPair } from ${JSON.stringify(core)};
      import { b64u, generateIdentity, relayAuthData } from ${JSON.stringify(cry)};
      const relay = createRelay({ limits: { mailboxTotalBytes: 1 << 30, mailboxBytesPerBox: 1 << 30, maxMailboxes: 1e6, boxFramesPerWindow: 1e9, boxBytesPerWindow: 1e12 } });
      const tick = () => new Promise((r) => setTimeout(r, 0));
      const out = [];
      async function box(kind) {
        const id = generateIdentity();
        const [mine, theirs] = createMemorySocketPair();
        const inbox = [];
        mine.onMessage((t) => inbox.push(JSON.parse(t)));
        relay.attach({ ...theirs, close: () => theirs.close() }, {});
        await tick();
        const ch = inbox.shift();
        mine.send(JSON.stringify({ t: 'auth', role: 'box', pub: b64u(id.publicRaw), sig: b64u(id.sign(relayAuthData('box', ch.n))) }));
        await tick();
        const devs = Array.from({ length: 32 }, (_, i) => 'dev' + i);
        mine.send(JSON.stringify({ t: 'allow', devs }));
        global.gc(); global.gc();
        const h0 = process.memoryUsage().heapUsed;
        const c0 = relay.stats().mailboxBytes;
        for (let r = 0; r < 60; r++) {
          for (const dev of devs) {
            const s = kind === 'wide' ? '\\u20ac'.repeat(1000 + r) : 'Q'.repeat(2000 + r);
            mine.send(JSON.stringify({ t: 'mbox_put', dev, d: s }));
          }
          await tick();
        }
        await tick();
        global.gc(); global.gc();
        out.push({ kind, real: process.memoryUsage().heapUsed - h0, counted: relay.stats().mailboxBytes - c0 });
      }
      await box('b64');
      await box('wide');
      console.log(JSON.stringify(out));
      relay.close();
    `;
    const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    await new Promise((r) => child.on('exit', r));
    assert.ok(out.trim(), err);
    const res = JSON.parse(out.trim().split('\n').pop());
    for (const r of res) {
      // Toleranz 256 KiB für Messrauschen.
      assert.ok(r.real <= r.counted * 1.05 + 256 * 1024, `${r.kind}: real ${r.real} B, gezählt ${r.counted} B`);
    }
  });
});

// ── H-0004: Widerruf bei offline-Box ───────────────────────────────────────

describe('Relay-Sicherheit H-0004: Widerruf', () => {
  test('entkoppeltes Gerät bleibt abgewiesen, auch wenn die Box offline ist', async () => {
    const relay = createRelay();
    const box = generateIdentity();
    const devA = generateIdentity();
    const devB = generateIdentity();
    const devNeu = generateIdentity();
    const b = await boxOnRelay(relay, box);
    b.send({ t: 'allow', devs: [devA.id, devB.id] });
    b.send({ t: 'allow', devs: [devA.id] }); // B entkoppelt
    await flush(b);
    b.send({ t: 'close_me' }); // unbekannter Typ → Relay trennt die Box
    await until(() => b.state.closed);
    const rb = await deviceOnRelay(relay, box, devB);
    await until(() => rb.state.closed || rb.inbox.find((m) => m.t === 'ok'));
    assert.equal(rb.state.closed?.reason, 'device_not_allowed');
    // Weiterhin erlaubtes und neu gekoppeltes Gerät warten normal auf die Box.
    const ra = await deviceOnRelay(relay, box, devA);
    assert.equal((await ra.next('ok')).boxOnline, false);
    const rn = await deviceOnRelay(relay, box, devNeu);
    assert.equal((await rn.next('ok')).boxOnline, false);
    // Box kommt wieder und koppelt B neu: dann darf B wieder.
    const b2 = await boxOnRelay(relay, box);
    b2.send({ t: 'allow', devs: [devA.id, devB.id, devNeu.id] });
    await flush(b2);
    const rb2 = await deviceOnRelay(relay, box, devB);
    assert.equal((await rb2.next('ok')).boxOnline, true);
    relay.close();
  });
});

// ── H-0005: allow-Handler ──────────────────────────────────────────────────

describe('Relay-Sicherheit H-0005: allow ohne Rundlauf über alle Briefkästen', () => {
  test('allow-Flut einer Box kostet nicht O(alle Briefkästen)', () => {
    // Verhältnis statt fester Wandzeit (unter Last robust): dieselbe
    // allow-Flut bei 25 und bei 400 fremden Boxen (je 32 Briefkästen).
    // Unabhängig von der Menge: ~1× (etwas mehr durch den größeren Heap);
    // Rundlauf über alle: ~16×.
    const devs = Array.from({ length: 32 }, (_, i) => `dev${i}`);
    function run(n) {
      const relay = createRelay({ limits: { boxFramesPerWindow: 1e9, boxBytesPerWindow: 1e12 } });
      for (let i = 0; i < n; i++) {
        // Je Box eine eigene Quelle (neue Boxen sind je Quelle gedrosselt).
        const b = syncBox(relay, `198.51.${i >> 8}.${i & 255}`);
        b.send({ t: 'allow', devs });
        for (const dev of devs) b.send({ t: 'mbox_put', dev, slot: 'latest', d: 'QUFB' });
      }
      assert.equal(relay.stats().mailboxes, n * 32);
      const a = syncBox(relay, '203.0.113.1');
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 4000; i++) a.send({ t: 'allow', devs });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      relay.close();
      return ms;
    }
    const best = (n) => Math.min(run(n), run(n), run(n));
    best(25); // Aufwärmen (JIT)
    const small = best(25);
    const large = best(400);
    const ratio = large / Math.max(small, 0.5);
    if (process.env.RELAY_RATIO_LOG) console.log(`allow ${ratio.toFixed(2)}`);
    assert.ok(ratio < 6, `16× Briefkästen → ${ratio.toFixed(1)}× Zeit (${small.toFixed(1)} → ${large.toFixed(1)} ms), erwartet ~1, nicht ~16`);
  });
});

// ── Codex-Gegenprüfung 4597a2f8 ────────────────────────────────────────────

// Box direkt am Relay (synchron, ohne Microtasks) — für Mengen-Tests.
function syncBox(relay, remote = null) {
  let recv;
  let challenge;
  const inbox = [];
  relay.attach({ send: (s) => { const m = JSON.parse(s); if (m.t === 'challenge') challenge = m.n; else inbox.push(m); }, close() {}, onMessage: (f) => { recv = f; }, onClose() {} }, { remote });
  const id = generateIdentity();
  const send = (o) => recv(JSON.stringify(o));
  send({ t: 'auth', role: 'box', pub: b64u(id.publicRaw), sig: b64u(id.sign(relayAuthData('box', challenge))) });
  return { send, inbox, id };
}

describe('Relay-Sicherheit: Codex-Gegenprüfung', () => {
  test('Ereignis-IDs bleiben eindeutig, auch wenn ein Briefkasten verdrängt und neu angelegt wird (P2)', async () => {
    const relay = createRelay({ limits: { mailboxBytesPerBox: 24 * 1024, boxFramesPerWindow: 1e6, boxBytesPerWindow: 1e9 } });
    const box = generateIdentity();
    const dev = generateIdentity();
    const b = await boxOnRelay(relay, box);
    b.send({ t: 'allow', devs: [dev.id, 'anderes'] });
    b.send({ t: 'mbox_put', dev: dev.id, d: b64(100, 'E') });
    await flush(b);
    const d = await deviceOnRelay(relay, box, dev);
    await d.next('ok');
    d.send({ t: 'mbox_get' });
    const first = (await d.next('mbox')).items;
    assert.equal(first.length, 1);
    // Druck in derselben Box verdrängt den Briefkasten des Geräts …
    for (let i = 0; i < 3; i++) b.send({ t: 'mbox_put', dev: 'anderes', d: b64(8000, 'X') });
    // … dann kommt ein neues Ereignis, das das Gerät noch nicht gesehen hat.
    b.send({ t: 'mbox_put', dev: dev.id, d: b64(100, 'N') });
    await flush(b);
    d.send({ t: 'mbox_ack', ids: first.map((i) => i.id) });
    d.send({ t: 'mbox_get' });
    const now = (await d.next('mbox')).items;
    assert.deepEqual(now.map((i) => i.d[0]), ['N'], 'ungesehenes Ereignis durch alte Quittung gelöscht');
    relay.close();
  });

  test('Verdrängen unter Speicherdruck bleibt linear (kein Neustart des Iterators, P2)', () => {
    // Verhältnis statt fester Wandzeit (unter Last robust): k Boxen unter
    // vollem Budget, dann k große Ablagen, die je ~1900 kleine Einträge
    // verdrängen. Linear: 8× k → ~8× Zeit; quadratisch: ~64×.
    const devs = Array.from({ length: 32 }, (_, i) => `dev${i}`);
    function run(k) {
      const relay = createRelay({ limits: { mailboxTotalBytes: k * 400 * 1024, boxFramesPerWindow: 1e9, boxBytesPerWindow: 1e12 } });
      const boxes = [];
      for (let i = 0; i < k; i++) {
        const b = syncBox(relay, `198.51.${i >> 8}.${i & 255}`);
        b.send({ t: 'allow', devs });
        for (const dev of devs) for (let j = 0; j < 64; j++) b.send({ t: 'mbox_put', dev, d: 'A' });
        boxes.push(b);
      }
      const big = 'A'.repeat(500_000);
      const t0 = performance.now();
      for (const b of boxes) b.send({ t: 'mbox_put', dev: devs[0], d: big });
      const ms = performance.now() - t0;
      assert.ok(relay.stats().mailboxBytes <= k * 400 * 1024);
      relay.close();
      return ms;
    }
    const best = (k) => Math.min(run(k), run(k), run(k));
    best(16); // Aufwärmen (JIT)
    const small = best(16);
    const large = best(128);
    const ratio = large / Math.max(small, 0.5);
    if (process.env.RELAY_RATIO_LOG) console.log(`evict ${ratio.toFixed(2)}`);
    assert.ok(ratio < 20, `8× Boxen → ${ratio.toFixed(1)}× Zeit (${small.toFixed(1)} → ${large.toFixed(1)} ms), erwartet ~8 (linear), nicht ~64`);
  });
});

// ── Speicherhebel nach H-0002 (Relay-Restpunkte 02.11.2026) ─────────────────
// Ausgangspuffer je Verbindung/gesamt, Rahmen vor der Anmeldung, faire
// Verdrängung im Briefkasten. Alles nur lokal.

// Echter WebSocket-Client am lokalen Relay.
const openClients = new Set();
function dropClients() {
  for (const ws of openClients) { try { ws.terminate(); } catch { /* egal */ } }
  openClients.clear();
}

async function wsClient(port, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers });
  openClients.add(ws);
  const inbox = [];
  const state = { closed: null };
  ws.on('message', (data) => { try { inbox.push(JSON.parse(String(data))); } catch { /* egal */ } });
  ws.on('close', (code, reason) => { state.closed = { code, reason: String(reason) }; });
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws, inbox, state,
    send: (o) => ws.send(JSON.stringify(o)),
    async next(type, ms) { return until(() => { const i = inbox.findIndex((m) => !type || m.t === type); return i >= 0 ? inbox.splice(i, 1)[0] : null; }, ms); },
  };
}

async function wsBox(port, signer) {
  const c = await wsClient(port);
  const ch = await c.next('challenge');
  c.send({ t: 'auth', role: 'box', pub: b64u(signer.publicRaw), sig: b64u(signer.sign(relayAuthData('box', ch.n))) });
  await c.next('ok');
  return c;
}

async function wsDevice(port, boxSigner, devSigner) {
  const c = await wsClient(port);
  const ch = await c.next('challenge');
  c.send({ t: 'auth', role: 'device', ticket: issueTicket(boxSigner, devSigner.id, Math.floor(Date.now() / 1000) + 3600), pub: b64u(devSigner.publicRaw), sig: b64u(devSigner.sign(relayAuthData('device', ch.n))) });
  await c.next('ok');
  return c;
}

// Kopf eines maskierten Textrahmens (Maske 0 = Nutzdaten unverändert).
function frameHead(len, { fin = true, opcode = 0x1 } = {}) {
  const b0 = (fin ? 0x80 : 0) | opcode;
  if (len < 126) return Buffer.from([b0, 0x80 | len, 0, 0, 0, 0]);
  if (len < 65536) return Buffer.from([b0, 0x80 | 126, len >> 8, len & 255, 0, 0, 0, 0]);
  const h = Buffer.alloc(14);
  h[0] = b0;
  h[1] = 0x80 | 127;
  h.writeBigUInt64BE(BigInt(len), 2);
  return h;
}

// Roh-Verbindung mit Handshake von Hand (für halbe Rahmen und stumme Gegenstellen).
async function rawWs(port) {
  const sock = net.connect(port, '127.0.0.1');
  const state = { closedAt: null, data: Buffer.alloc(0) };
  sock.on('close', () => { state.closedAt = Date.now(); });
  sock.on('error', () => {});
  openClients.add({ terminate: () => sock.destroy() });
  await new Promise((resolve) => sock.once('connect', resolve));
  sock.write('GET /v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await new Promise((resolve) => sock.once('data', resolve));
  return { sock, state };
}

async function localRelay(opts = {}) {
  const srv = relayServer.startRelayServer({ port: 0, host: '127.0.0.1', log: () => {}, pingMs: 0, ...opts });
  const { port } = await srv.ready;
  const close = srv.close.bind(srv);
  srv.close = () => { dropClients(); return close(); };
  return { srv, port };
}

describe('Relay-Speicher: Ausgangspuffer', () => {
  test('langsamer Leser fliegt an der Grenze je Verbindung, Puffer danach frei (echter WebSocket)', async () => {
    const { srv, port } = await localRelay({
      limits: { boxFramesPerWindow: 1e6, boxBytesPerWindow: 1e12 },
      socketLimits: { outPerConn: 1024 * 1024, stallMs: 60_000 },
    });
    try {
      const box = generateIdentity();
      const dev = generateIdentity();
      const b = await wsBox(port, box);
      const d = await wsDevice(port, box, dev);
      const open = await b.next('open');
      // Das Handy liest nicht mehr.
      d.ws._socket.pause();
      const chunk = 'A'.repeat(512 * 1024);
      for (let i = 0; i < 16; i++) b.send({ t: 'data', c: open.c, d: chunk });
      const closed = await b.next('close', 5000);
      assert.equal(closed.c, open.c, 'langsamer Leser nicht getrennt');
      assert.equal(typeof srv.socketStats, 'function', 'socketStats fehlt');
      await until(() => srv.socketStats().outBufferedBytes === 0);
      b.ws.terminate();
      d.ws.terminate();
    } finally {
      await srv.close();
    }
  });

  function fakeWs() {
    const h = {};
    const ws = {
      readyState: 1, bufferedAmount: 0, pending: [], terminated: false,
      send(data, cb) { ws.pending.push(cb); },
      terminate() { if (ws.terminated) return; ws.terminated = true; ws.readyState = 3; for (const f of h.close || []) f(1006, Buffer.alloc(0)); },
      close() {}, ping() {},
      on(ev, fn) { (h[ev] ||= []).push(fn); },
      flush() { const p = ws.pending; ws.pending = []; for (const cb of p) cb?.(); },
    };
    return ws;
  }

  test('Grenzen je Verbindung, je Quelle und gesamt; die größten Rückstände weichen zuerst', () => {
    assert.equal(typeof relayCore.createSocketGuard, 'function', 'createSocketGuard fehlt');
    const K = 1024;
    const guard = relayCore.createSocketGuard({ outPerConn: 100 * K, outPerRemote: 250 * K, outTotal: 400 * K, stallMs: 1e9 });
    try {
      const x = (n) => 'x'.repeat(n * K);
      // Je Verbindung: Rückstand + neuer Rahmen über der Grenze → getrennt.
      const a = fakeWs();
      const sa = guard.wrap(a, { remote: 'A', pingMs: 0 });
      sa.send(x(90));
      assert.equal(a.terminated, false);
      sa.send(x(20));
      assert.equal(a.terminated, true, 'langsamer Leser nicht getrennt');
      assert.equal(guard.stats().outBufferedBytes, 0, 'Rückstand des getrennten Lesers noch gezählt');
      // Je Quelle: der größte Rückstand derselben Quelle weicht.
      const bs = [fakeWs(), fakeWs(), fakeWs()];
      const ss = bs.map((w) => guard.wrap(w, { remote: 'B', pingMs: 0 }));
      ss[0].send(x(95));
      ss[1].send(x(90));
      ss[2].send(x(80));
      assert.deepEqual(bs.map((w) => w.terminated), [true, false, false]);
      assert.ok(guard.stats().outBufferedBytes <= 250 * K);
      // Gesamt: Quellen C, D, E; wer neu sendet, verdrängt den größten Rückstand.
      const cs = ['C', 'D', 'E', 'F'].map((r) => { const w = fakeWs(); return { w, s: guard.wrap(w, { remote: r, pingMs: 0 }) }; });
      cs[0].s.send(x(99));
      cs[1].s.send(x(60));
      cs[2].s.send(x(60));
      assert.ok(guard.stats().outBufferedBytes <= 400 * K, `gesamt ${guard.stats().outBufferedBytes}`);
      cs[3].s.send(x(50));
      assert.ok(guard.stats().outBufferedBytes <= 400 * K, `gesamt ${guard.stats().outBufferedBytes}`);
      assert.equal(cs[3].w.terminated, false, 'Leser ohne Rückstand getrennt');
      assert.equal(cs[0].w.terminated, true, 'größter Rückstand nicht verdrängt');
      // Abgeholt → Platz wieder frei.
      for (const w of [...bs, ...cs.map((c) => c.w)]) w.flush();
      assert.equal(guard.stats().outBufferedBytes, 0);
    } finally {
      guard.close();
    }
  });

  test('Frist wächst mit der Rahmengröße: großer Rahmen auf langsamer Leitung fliegt nicht vorschnell (Review 834d1336 P3)', async () => {
    const guard = relayCore.createSocketGuard({ stallMs: 100, minRateBytesPerSec: 10 * 1024 });
    try {
      const w = fakeWs();
      const s = guard.wrap(w, { remote: 'A', pingMs: 0 });
      s.send('x'.repeat(5 * 1024)); // 100 ms + 500 ms
      await sleep(300);
      assert.equal(w.terminated, false, 'großer Rahmen nach fester Frist getrennt');
      await until(() => w.terminated, 2000);
      assert.equal(guard.stats().outBufferedBytes, 0);
    } finally {
      guard.close();
    }
  });

  test('Rückstau je Verbindung: vier größte Antworten plus Live-Werte gehen, ein fünfter größter Rahmen trennt (Gegenprüfung 67ede79a/7a5c7e49/9237ab50 P3)', () => {
    const guard = relayCore.createSocketGuard({ stallMs: 1e9 });
    try {
      const w = fakeWs();
      const s = guard.wrap(w, { remote: 'A', pingMs: 0 });
      // Größter weitergeleiteter Rahmen: Box-Rahmen bis 1 MiB + Spielraum.
      const max = JSON.stringify({ t: 'data', d: 'A'.repeat(DEFAULT_LIMITS.boxFrameBytes + relayCore.FRAME_SLACK - 20) });
      for (let i = 0; i < 4; i++) s.send(max);
      for (let i = 0; i < 10; i++) s.send(JSON.stringify({ t: 'data', d: 'L'.repeat(8 * 1024) }));
      assert.equal(w.terminated, false, 'vier größte Antworten trennen ein gesundes Handy');
      s.send(max);
      assert.equal(w.terminated, true, 'fünfter größter Rahmen im Rückstau nicht getrennt');
      assert.equal(guard.stats().outBufferedBytes, 0);
    } finally {
      guard.close();
    }
  });

  test('jeder wartende Rahmen zählt den Pool-Anteil seines Kopfes mit (Gegenprüfung 2339cc36 P3)', () => {
    const guard = relayCore.createSocketGuard({ stallMs: 1e9 });
    try {
      const w = fakeWs();
      const s = guard.wrap(w, { remote: 'A', pingMs: 0 });
      for (let i = 0; i < 10; i++) s.send('x');
      assert.ok(guard.stats().outBufferedBytes >= 10 * (1 + Buffer.poolSize), `gezählt ${guard.stats().outBufferedBytes}`);
      w.flush();
      assert.equal(guard.stats().outBufferedBytes, 0);
    } finally {
      guard.close();
    }
  });

  test('ohne Fortschritt wird getrennt, wer abholt, bleibt', async () => {
    const guard = relayCore.createSocketGuard({ stallMs: 150 });
    try {
      const slow = fakeWs();
      const fast = fakeWs();
      const ss = guard.wrap(slow, { remote: 'A', pingMs: 0 });
      const sf = guard.wrap(fast, { remote: 'B', pingMs: 0 });
      const t0 = Date.now();
      ss.send('x'.repeat(1000));
      while (Date.now() - t0 < 600) {
        sf.send('y'.repeat(1000));
        await sleep(30);
        fast.flush();
      }
      assert.equal(slow.terminated, true, 'Hänger nicht getrennt');
      assert.equal(fast.terminated, false, 'Leser mit Fortschritt getrennt');
      assert.equal(guard.stats().outBufferedBytes, 0);
    } finally {
      guard.close();
    }
  });
});

describe('Relay-Speicher: Rahmen vor und nach der Anmeldung', () => {
  test('vor der Anmeldung: halber großer Rahmen wird sofort abgewiesen, nicht gepuffert', async () => {
    const { srv, port } = await localRelay({ limits: { authTimeoutMs: 5000 } });
    try {
      const r = await rawWs(port);
      const t0 = Date.now();
      r.sock.write(Buffer.concat([frameHead(512 * 1024), Buffer.alloc(1024, 0x41)]));
      await until(() => r.state.closedAt, 2000).catch(() => {});
      assert.ok(r.state.closedAt && r.state.closedAt - t0 < 1500, 'großer Rahmen vor der Anmeldung angenommen');
      r.sock.destroy();
    } finally {
      await srv.close();
    }
  });

  test('nach der Anmeldung: Box darf große Rahmen, Gerät nur bis zu seiner Grenze', async () => {
    const { srv, port } = await localRelay({ limits: { boxFramesPerWindow: 1e6, boxBytesPerWindow: 1e12 } });
    try {
      const box = generateIdentity();
      const dev = generateIdentity();
      const b = await wsBox(port, box);
      const d = await wsDevice(port, box, dev);
      const open = await b.next('open');
      b.send({ t: 'data', c: open.c, d: 'B'.repeat(600 * 1024) });
      const got = await d.next('data');
      assert.equal(got.d.length, 600 * 1024);
      // Gerät: Rahmen über 256 KiB wird schon am Kopf abgewiesen (1009).
      d.send({ t: 'data', d: 'C'.repeat(300 * 1024) });
      await until(() => d.state.closed);
      assert.equal(d.state.closed.code, 1009);
      b.ws.terminate();
    } finally {
      await srv.close();
    }
  });

  test('angefangene Rahmen zählen gesamt: der größte weicht, Hänger fliegen nach Frist', async () => {
    const { srv, port } = await localRelay({
      limits: { boxFramesPerWindow: 1e6, boxBytesPerWindow: 1e12 },
      socketLimits: { inTotal: 1024 * 1024, inPerRemote: 8 * 1024 * 1024, stallMs: 400, minRateBytesPerSec: 1e9 },
    });
    try {
      const a = await wsBox(port, generateIdentity());
      const b = await wsBox(port, generateIdentity());
      const big = 700 * 1024;
      // A fängt einen großen Rahmen an und hört auf.
      a.ws._socket.write(Buffer.concat([frameHead(big), Buffer.alloc(10 * 1024, 0x20)]));
      await sleep(50);
      // B schickt einen ebenso großen Rahmen vollständig: A (größter) weicht.
      const text = JSON.stringify({ t: 'ping', pad: 'P'.repeat(big - 30) });
      b.ws._socket.write(Buffer.concat([frameHead(Buffer.byteLength(text)), Buffer.from(text)]));
      await b.next('pong');
      await until(() => a.state.closed);
      assert.equal(b.state.closed, null);
      // B fängt an und bleibt hängen → nach der Frist getrennt.
      b.ws._socket.write(Buffer.concat([frameHead(big), Buffer.alloc(1024, 0x20)]));
      await until(() => b.state.closed, 3000);
      assert.equal(srv.socketStats().inPartialBytes, 0);
    } finally {
      await srv.close();
    }
  });

  test('vom Relay geschlossen, Gegenstelle bestätigt nicht → Verbindung nach kurzer Frist weg', async () => {
    const { srv, port } = await localRelay();
    try {
      const r = await rawWs(port);
      const t0 = Date.now();
      // Falsche erste Nachricht → Relay schließt (4009); wir bestätigen nie.
      const text = JSON.stringify({ t: 'hallo' });
      r.sock.write(Buffer.concat([frameHead(text.length), Buffer.from(text)]));
      await until(() => r.state.closedAt, 5000).catch(() => {});
      assert.ok(r.state.closedAt && r.state.closedAt - t0 < 4000, 'stumme Gegenstelle bleibt bis zum ws-Zeitlimit (30 s) offen');
      r.sock.destroy();
    } finally {
      await srv.close();
    }
  });
});

describe('Relay-Speicher: Steuerrahmen und Fragmente (Gegenprüfung faf3cb0)', () => {
  test('Ping-Flut ohne Lesen: Steuerrahmen begrenzt (P1)', async () => {
    const { srv, port } = await localRelay();
    try {
      const b = await wsBox(port, generateIdentity());
      b.ws._socket.pause(); // liest nicht mehr
      for (let i = 0; i < 200; i++) b.ws.ping(Buffer.alloc(125, 1));
      await until(() => srv.relay.stats().connections === 0, 3000);
    } finally {
      await srv.close();
    }
  });

  test('Pongs zählen im Ausgangsbudget: Nicht-Leser fliegt auch unter der Steuerrahmen-Grenze (P1)', async () => {
    const { srv, port } = await localRelay({ socketLimits: { controlFramesPerWindow: 1e9, outPerConn: 64 * 1024, stallMs: 60_000 } });
    try {
      const b = await wsBox(port, generateIdentity());
      b.ws._socket.pause();
      const ping = Buffer.from([0x89, 0x80 | 125, 0, 0, 0, 0, ...Buffer.alloc(125, 1)]);
      for (let k = 0; k < 40 && srv.relay.stats().connections > 0; k++) {
        b.ws._socket.write(Buffer.concat(Array.from({ length: 1000 }, () => ping)));
        await sleep(20);
      }
      await until(() => srv.relay.stats().connections === 0, 3000);
    } finally {
      await srv.close();
    }
  });

  test('Pong hält das Lesestück nicht fest (Kopie der Ping-Nutzdaten, P2)', () => {
    const guard = relayCore.createSocketGuard({ stallMs: 1e9 });
    try {
      const h = {};
      let pongArg = null;
      const ws = {
        readyState: 1, bufferedAmount: 0,
        send() {}, terminate() {}, close() {}, ping() {},
        pong(data) { pongArg = data; },
        on(ev, fn) { (h[ev] ||= []).push(fn); },
      };
      guard.wrap(ws, { remote: 'A', pingMs: 0 });
      const chunk = Buffer.alloc(64 * 1024, 7);
      const view = chunk.subarray(100, 225);
      for (const f of h.ping || []) f(view);
      assert.ok(pongArg, 'Ping nicht beantwortet');
      assert.notEqual(pongArg.buffer, chunk.buffer, 'Pong teilt das Lesestück');
      assert.equal(pongArg.buffer.byteLength, view.length, 'Pong liegt in einem gemeinsamen Pool');
      assert.deepEqual([...pongArg], [...view]);
    } finally {
      guard.close();
    }
  });

  test('Ein-Byte-Fragmente mit Pong-Füllung: höchstens 16 Fragmente (P2)', async () => {
    // Steuerrahmen-Grenze außer Reichweite, festgehaltene Lesestücke winzig:
    // trennen darf hier nur maxFragments — genau an der Grenze: 16
    // Datenrahmen bleiben offen, der 17. trennt.
    const { srv, port } = await localRelay({ socketLimits: { controlFramesPerWindow: 1e9 } });
    try {
      const b = await wsBox(port, generateIdentity());
      const pong = Buffer.from([0x8a, 0x80, 0, 0, 0, 0]);
      const frag = () => Buffer.concat([frameHead(1, { fin: false, opcode: 0x0 }), Buffer.from(' '), pong, pong]);
      const parts = [Buffer.concat([frameHead(1, { fin: false, opcode: 0x1 }), Buffer.from('{'), pong])];
      for (let i = 0; i < 15; i++) parts.push(frag());
      b.ws._socket.write(Buffer.concat(parts));
      await sleep(300);
      assert.equal(b.state.closed, null, '16 Fragmente schon getrennt');
      b.ws._socket.write(frag());
      await until(() => b.state.closed, 3000);
    } finally {
      await srv.close();
    }
  });

  test('festgehaltene Lesestücke zählen in voller Größe (Rest-Byte); ruhende Verbindung hält nichts (Maske frei) (Gegenprüfung 39d4427 P2, 34e9bd0c/672c1753 P3)', async () => {
    const { srv, port } = await localRelay({ limits: { boxFramesPerWindow: 1e6, boxBytesPerWindow: 1e12 } });
    try {
      const text = JSON.stringify({ t: 'ping', pad: 'P'.repeat(65_000 - 30) });
      const frame = Buffer.concat([frameHead(Buffer.byteLength(text)), Buffer.from(text)]);
      // a: Rahmen + 1 Byte des nächsten Kopfes im selben Lesestück → das
      // Rest-Byte hält das ganze Stück. b: Rahmen allein → danach ruhend.
      const a = await wsBox(port, generateIdentity());
      const b = await wsBox(port, generateIdentity());
      const before = srv.socketStats().inPartialBytes;
      a.ws._socket.write(Buffer.concat([frame, Buffer.from([0x8a])]));
      await a.next('pong');
      await sleep(50);
      const held = srv.socketStats().inPartialBytes - before;
      assert.ok(held >= 60_000, `festgehaltenes Lesestück nur mit ${held} B gezählt`);
      b.ws._socket.write(frame);
      await b.next('pong');
      await sleep(50);
      assert.ok(srv.socketStats().inPartialBytes - before - held < 1024, 'ruhende Verbindung hält ihr letztes Lesestück');
      // Auch wenn ein Pong im selben Lesestück folgt (Gegenprüfung 672c1753 P3).
      const c = await wsBox(port, generateIdentity());
      const mid = srv.socketStats().inPartialBytes;
      c.ws._socket.write(Buffer.concat([frame, Buffer.from([0x8a, 0x80, 0, 0, 0, 0])]));
      await c.next('pong');
      await sleep(50);
      assert.ok(srv.socketStats().inPartialBytes - mid < 1024, 'Pong hinter dem Rahmen hält das Lesestück');
      // … und ebenso ein Ping (Gegenprüfung 75d75926 P3).
      const d = await wsBox(port, generateIdentity());
      const mid2 = srv.socketStats().inPartialBytes;
      d.ws._socket.write(Buffer.concat([frame, Buffer.from([0x89, 0x80, 0, 0, 0, 0])]));
      await d.next('pong');
      await sleep(50);
      assert.ok(srv.socketStats().inPartialBytes - mid2 < 1024, 'Ping hinter dem Rahmen hält das Lesestück');
    } finally {
      await srv.close();
    }
  });

  for (const [name, separate] of [['in einem Lesestück einmal', false], ['über getrennte Lesestücke summiert', true]]) {
    test(`Fragmente zählen genau: ${name} (Gegenprüfung 34e9bd0c P3)`, async () => {
      const { srv, port } = await localRelay({ socketLimits: { stallMs: 60_000 } });
      try {
        const b = await wsBox(port, generateIdentity());
        b.ws._socket.setNoDelay(true);
        await sleep(20);
        const before = srv.socketStats().inPartialBytes;
        const frames = [Buffer.concat([frameHead(1, { fin: false, opcode: 0x1 }), Buffer.from('{')])];
        for (let i = 0; i < 9; i++) frames.push(Buffer.concat([frameHead(1, { fin: false, opcode: 0x0 }), Buffer.from(' ')]));
        if (separate) for (const f of frames) { b.ws._socket.write(f); await sleep(20); }
        else b.ws._socket.write(Buffer.concat(frames));
        await sleep(100);
        // Unfertige Nachricht: 10 Byte zugesagt, 70 Byte Lesestücke festgehalten
        // (einmal gezählt), 10 Fragmente + Maske je 256 B.
        const total = frames.reduce((n, f) => n + f.length, 0);
        assert.equal(srv.socketStats().inPartialBytes - before, Math.max(10, total) + 11 * relayCore.SOCKET_LIMITS.chunkCost);
      } finally {
        await srv.close();
      }
    });
  }

  test('großer Rahmen in vielen kleinen Lesestücken wird nicht abgewiesen (maxBufferedChunks, Gegenprüfung 34e9bd0c P3)', async () => {
    const { srv, port } = await localRelay({ limits: { boxFramesPerWindow: 1e6, boxBytesPerWindow: 1e12 } });
    try {
      const b = await wsBox(port, generateIdentity());
      b.ws._socket.setNoDelay(true);
      const text = JSON.stringify({ t: 'ping', pad: 'P'.repeat(48 * 1024) });
      const buf = Buffer.concat([frameHead(Buffer.byteLength(text)), Buffer.from(text)]);
      // ~3000 Stücke (über 1024, unter 4096), einzeln mit Pause, damit TCP
      // sie nicht zusammenfasst.
      const step = Math.ceil(buf.length / 3000);
      for (let i = 0; i < buf.length; i += step) {
        b.ws._socket.write(buf.subarray(i, i + step));
        await new Promise((r) => setImmediate(r));
        if ((i / step) % 2 === 0) await sleep(1);
      }
      await b.next('pong', 10_000);
      assert.equal(b.state.closed, null);
    } finally {
      await srv.close();
    }
  });

  test('ein Halter je Verbindung im Eingang: Verdrängung vergleicht Verbindungen, nicht Teilposten (Gegenprüfung 39d4427 P3)', async () => {
    const { srv, port } = await localRelay({ limits: { boxFramesPerWindow: 1e6, boxBytesPerWindow: 1e12 }, socketLimits: { stallMs: 60_000 } });
    try {
      assert.ok(srv.guard, 'Wächter nicht erreichbar');
      const a = await wsBox(port, generateIdentity());
      const b = await wsBox(port, generateIdentity());
      // Beide mit angefangenem Rahmen und festgehaltenen Lesestücken.
      for (const c of [a, b]) c.ws._socket.write(Buffer.concat([frameHead(300 * 1024), Buffer.alloc(100 * 1024, 0x20)]));
      await sleep(100);
      assert.equal(srv.guard.in.holders.size, 2, `${srv.guard.in.holders.size} Halter für 2 Verbindungen`);
    } finally {
      await srv.close();
    }
  });

  test('Rahmen in winzigen TCP-Stücken: Stücke zählen im Eingangsbudget (P2)', async () => {
    const { srv, port } = await localRelay({ socketLimits: { inTotal: 64 * 1024, inPerRemote: 1024 * 1024, stallMs: 60_000 } });
    try {
      const b = await wsBox(port, generateIdentity());
      b.ws._socket.setNoDelay(true);
      b.ws._socket.write(frameHead(32 * 1024));
      for (let i = 0; i < 400 && !b.state.closed; i++) {
        b.ws._socket.write(Buffer.from(' '));
        await sleep(1);
      }
      await until(() => b.state.closed, 3000);
    } finally {
      await srv.close();
    }
  });
});

describe('Relay-Speicher: faire Verdrängung im Briefkasten', () => {
  const big = { boxFramesPerWindow: 1e9, boxBytesPerWindow: 1e12 };

  test('viele selbst erzeugte Boxen aus wenigen Quellen verdrängen keine fremden Meldungen', async () => {
    const relay = createRelay({ limits: { ...big, mailboxTotalBytes: 256 * 1024, mailboxBytesPerSource: 64 * 1024, mailboxBytesPerBox: 32 * 1024 } });
    const good = generateIdentity();
    const dev = generateIdentity();
    const g = await boxOnRelay(relay, good, '203.0.113.10');
    g.send({ t: 'allow', devs: [dev.id] });
    g.send({ t: 'mbox_put', dev: dev.id, d: b64(1000, 'G') });
    await flush(g);
    // 8 Quellen mit je 6 frischen Boxen, jede schreibt voll.
    for (let s = 0; s < 8; s++) {
      for (let k = 0; k < 6; k++) {
        const e = await boxOnRelay(relay, generateIdentity(), `198.51.100.${s}`);
        e.send({ t: 'allow', devs: ['x', 'y'] });
        for (let i = 0; i < 8; i++) e.send({ t: 'mbox_put', dev: i % 2 ? 'x' : 'y', d: b64(4000, 'E') });
        await flush(e);
      }
    }
    assert.ok(relay.stats().mailboxBytes <= 256 * 1024);
    const d = await deviceOnRelay(relay, good, dev);
    await d.next('ok');
    d.send({ t: 'mbox_get' });
    const items = (await d.next('mbox')).items;
    assert.equal(items.length, 1, 'echte Meldung wurde verdrängt');
    relay.close();
  });

  test('Quelle mit nur noch Verwaltung (Box zog um) lenkt die Verdrängung nicht auf das Älteste überhaupt (Review 834d1336 P2)', async () => {
    const relay = createRelay({ limits: { ...big, mailboxTotalBytes: 256 * 1024, mailboxBytesPerSource: 64 * 1024, mailboxBytesPerBox: 32 * 1024 } });
    const good = generateIdentity();
    const dev = generateIdentity();
    const g = await boxOnRelay(relay, good, '203.0.113.10');
    g.send({ t: 'allow', devs: [dev.id] });
    g.send({ t: 'mbox_put', dev: dev.id, d: b64(1000, 'G') });
    await flush(g);
    // Box legt aus Quelle A 32 Briefkästen an (Verwaltung zählt bei A) …
    const mover = generateIdentity();
    const devs = Array.from({ length: 32 }, (_, i) => `m${i}`);
    const a = await boxOnRelay(relay, mover, '198.51.100.200');
    a.send({ t: 'allow', devs });
    for (const d of devs) a.send({ t: 'mbox_put', dev: d, slot: 'latest', d: 'QUFB' });
    await flush(a);
    // … und befüllt sie danach aus Quelle B: A hält nur noch Verwaltung.
    const b = await boxOnRelay(relay, mover, '198.51.100.201');
    b.send({ t: 'allow', devs });
    for (const d of devs) b.send({ t: 'mbox_put', dev: d, slot: 'latest', d: 'QkJC' });
    await flush(b);
    // Füller aus vielen Quellen, jede kleiner als A, aber größer als die echte Box.
    for (let s = 0; s < 24; s++) {
      const e = await boxOnRelay(relay, generateIdentity(), `192.0.2.${s}`);
      e.send({ t: 'allow', devs: ['x'] });
      for (let i = 0; i < 3; i++) e.send({ t: 'mbox_put', dev: 'x', d: b64(4000, 'F') });
      await flush(e);
    }
    assert.ok(relay.stats().mailboxBytes <= 256 * 1024);
    const d = await deviceOnRelay(relay, good, dev);
    await d.next('ok');
    d.send({ t: 'mbox_get' });
    assert.equal((await d.next('mbox')).items.length, 1, 'echte Meldung wurde verdrängt');
    relay.close();
  });

  test('je Quelle gedeckelt, auch über viele Boxen', async () => {
    const relay = createRelay({ limits: { ...big, mailboxBytesPerSource: 48 * 1024 } });
    for (let k = 0; k < 10; k++) {
      const e = await boxOnRelay(relay, generateIdentity(), '198.51.100.77');
      e.send({ t: 'allow', devs: ['x'] });
      for (let i = 0; i < 4; i++) e.send({ t: 'mbox_put', dev: 'x', d: b64(4000, 'E') });
      await flush(e);
    }
    assert.ok(relay.stats().mailboxBytes <= 48 * 1024, `Quelle belegt ${relay.stats().mailboxBytes} B`);
    relay.close();
  });

  test('neue Boxen je Quelle gedrosselt, andere Quellen unberührt, Nachschub mit der Zeit', async () => {
    let t = Date.now();
    const relay = createRelay({ now: () => t, limits: { ...big, newBoxesPerSource: 3, newBoxRefillMs: 60_000 } });
    const errs = [];
    for (let k = 0; k < 4; k++) {
      const e = await boxOnRelay(relay, generateIdentity(), '198.51.100.5');
      e.send({ t: 'allow', devs: ['x'] });
      e.send({ t: 'mbox_put', dev: 'x', d: b64(100) });
      await flush(e);
      errs.push(e.inbox.find((m) => m.t === 'error')?.e || null);
    }
    assert.deepEqual(errs, [null, null, null, 'relay_busy']);
    const other = await boxOnRelay(relay, generateIdentity(), '203.0.113.9');
    other.send({ t: 'allow', devs: ['x'] });
    other.send({ t: 'mbox_put', dev: 'x', d: b64(100) });
    await flush(other);
    assert.equal(other.inbox.find((m) => m.t === 'error'), undefined);
    // Bekannte Box (Briefkasten vorhanden) ist nicht „neu“.
    t += 61_000;
    const again = await boxOnRelay(relay, generateIdentity(), '198.51.100.5');
    again.send({ t: 'allow', devs: ['x'] });
    again.send({ t: 'mbox_put', dev: 'x', d: b64(100) });
    await flush(again);
    assert.equal(again.inbox.find((m) => m.t === 'error'), undefined, 'kein Nachschub nach einer Minute');
    relay.close();
  });

  test('Fehler nennt slot (letzter Stand) und ref (Ereignis) — echtes Relay (Review d4d72b9f P3)', async () => {
    const relay = createRelay({ limits: { ...big, newBoxesPerSource: 1, newBoxRefillMs: 3600_000 } });
    // Erste neue Box der Quelle verbraucht den Eimer.
    const first = await boxOnRelay(relay, generateIdentity(), '198.51.100.9');
    first.send({ t: 'allow', devs: ['x'] });
    first.send({ t: 'mbox_put', dev: 'x', d: b64(100) });
    await flush(first);
    const b = await boxOnRelay(relay, generateIdentity(), '198.51.100.9');
    b.send({ t: 'allow', devs: ['x'] });
    b.send({ t: 'mbox_put', dev: 'x', slot: 'latest', d: b64(100) });
    b.send({ t: 'mbox_put', dev: 'x', d: b64(100), ref: 'e7' });
    b.send({ t: 'mbox_put', dev: 'x', d: b64(100), ref: 'x'.repeat(40) });
    await flush(b);
    const errs = b.inbox.filter((m) => m.t === 'error');
    assert.deepEqual(errs, [
      { t: 'error', e: 'relay_busy', dev: 'x', slot: 'latest' },
      { t: 'error', e: 'relay_busy', dev: 'x', ref: 'e7' },
      { t: 'error', e: 'relay_busy', dev: 'x' },
    ]);
    relay.close();
  });

  test('Standardgrenzen: Verbindungen, Briefkästen und Puffer passen zusammen unter den Container (256 MiB)', () => {
    const S = relayCore.SOCKET_LIMITS;
    assert.ok(S, 'SOCKET_LIMITS fehlt');
    // ~10 KiB je offene Verbindung; angefangene Rahmen (auch vor der
    // Anmeldung) zählen im Eingangsbudget. Rest (~80 MiB) für Node selbst und
    // Rahmen, die gerade verarbeitet werden.
    const worst = DEFAULT_LIMITS.maxConnections * 10 * 1024
      + DEFAULT_LIMITS.mailboxTotalBytes + S.outTotal + S.inTotal;
    assert.ok(worst <= 176 * 1024 * 1024, `Worst Case ${Math.round(worst / 1048576)} MiB`);
    assert.ok(S.outPerConn <= 4.5 * 1024 * 1024, 'Ausgang je Verbindung nicht deutlich unter den alten 8 MiB');
    assert.ok(S.outPerConn <= S.outPerRemote);
    assert.ok(S.preAuthFrameBytes <= 16 * 1024);
    assert.ok(DEFAULT_LIMITS.mailboxBytesPerSource < DEFAULT_LIMITS.mailboxTotalBytes / 8);
  });
});
