// Sicherheits-Tests für das blinde Relay der Handy-App (Strix-Funde
// H-0001, H-0002, H-0004, H-0005, verifiziert 30.10.2026). Nur lokal —
// niemals gegen relay.dvhub.de.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

import { b64u, generateIdentity, issueTicket, relayAuthData } from '../services/mobile-link/crypto.js';
import { createRelay, createMemorySocketPair, DEFAULT_LIMITS } from '../services/mobile-link/relay-core.js';
import * as relayServer from '../services/mobile-link/relay-server.js';

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

async function boxOnRelay(relay, signer) {
  const c = memClient(relay);
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
  test('allow-Flut einer Box kostet nicht O(alle Briefkästen)', async () => {
    const relay = createRelay({ limits: { boxFramesPerWindow: 1e9, boxBytesPerWindow: 1e12 } });
    const devs = Array.from({ length: 32 }, (_, i) => `dev${i}`);
    for (let i = 0; i < 120; i++) {
      const b = await boxOnRelay(relay, generateIdentity());
      b.send({ t: 'allow', devs });
      for (const dev of devs) b.send({ t: 'mbox_put', dev, slot: 'latest', d: 'QUFB' });
    }
    await sleep(20);
    assert.equal(relay.stats().mailboxes, 120 * 32);
    const a = await boxOnRelay(relay, generateIdentity());
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 4000; i++) a.send({ t: 'allow', devs });
    await flush(a);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 400, `4000× allow dauerten ${ms.toFixed(0)} ms`);
    relay.close();
  });
});

// ── Codex-Gegenprüfung 4597a2f8 ────────────────────────────────────────────

// Box direkt am Relay (synchron, ohne Microtasks) — für Mengen-Tests.
function syncBox(relay) {
  let recv;
  let challenge;
  const inbox = [];
  relay.attach({ send: (s) => { const m = JSON.parse(s); if (m.t === 'challenge') challenge = m.n; else inbox.push(m); }, close() {}, onMessage: (f) => { recv = f; }, onClose() {} });
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
    const relay = createRelay({ limits: { mailboxTotalBytes: 16 * 1024 * 1024, boxFramesPerWindow: 1e9, boxBytesPerWindow: 1e12 } });
    const devs = Array.from({ length: 32 }, (_, i) => `dev${i}`);
    const boxes = [];
    for (let i = 0; i < 40; i++) {
      const b = syncBox(relay);
      b.send({ t: 'allow', devs });
      for (const dev of devs) for (let j = 0; j < 64; j++) b.send({ t: 'mbox_put', dev, d: 'A' });
      boxes.push(b);
    }
    const t0 = performance.now();
    for (const b of boxes) b.send({ t: 'mbox_put', dev: devs[0], d: 'A'.repeat(500_000) });
    const ms = performance.now() - t0;
    assert.ok(relay.stats().mailboxBytes <= 16 * 1024 * 1024);
    assert.ok(ms < 300, `40 große Ablagen unter Druck dauerten ${ms.toFixed(0)} ms`);
    relay.close();
  });
});
