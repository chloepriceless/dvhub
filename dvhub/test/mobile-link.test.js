// Handy-Kopplung (services/mobile-link/*): Krypto, Relay, Box-Agent, Rechte.
// Ende-zu-Ende-Tests laufen über echte WebSockets (relay-server.js) mit dem
// Referenz-Client, den die iPhone-App nachbaut.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import net from 'node:net';
import { spawn } from 'node:child_process';

import {
  b64u, fromB64u, framed, transcript, keyId, generateIdentity, signerFromPrivateKey,
  createDeviceHandshake, createBoxHandshake, createPairDevice, createPairBox,
  issueTicket, verifyTicket, relayAuthData, pairRelayToken, pairTokenHash,
  sealMailbox, openMailbox, x25519FromSeed, x25519Shared, aeadSeal, verifySig,
} from '../services/mobile-link/crypto.js';
import { createRelay, createMemorySocketPair, CLOSE, wrapWebSocket } from '../services/mobile-link/relay-core.js';
import { isAllowedMigrationFile } from '../services/config-secrets-crypto.js';
import { startRelayServer } from '../services/mobile-link/relay-server.js';
import { createMobileLink, normalizeRelayUrl, sanitizeLanHost, SIDECAR_NAME } from '../services/mobile-link/agent.js';
import { pairDevice, connectDevice } from '../services/mobile-link/client.js';
import { checkRequest, normalizePerms } from '../services/mobile-link/permissions.js';
import { parsePairPayload, qrSvg, buildPairPayload } from '../services/mobile-link/qr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until: timeout');
    await sleep(20);
  }
}

// ── Krypto ──────────────────────────────────────────────────────────────────

describe('mobile-link crypto', () => {
  test('base64url ist strikt (kein Padding, kein fremdes Alphabet, kanonisch)', () => {
    assert.deepEqual(fromB64u(b64u(Buffer.from([1, 2, 3]))), Buffer.from([1, 2, 3]));
    for (const bad of ['AQID=', 'AQ+D', 'A', 'AQ ', 'AR']) assert.throws(() => fromB64u(bad), /bad_b64u/, bad);
    assert.throws(() => fromB64u(b64u(Buffer.alloc(31)), 32), /bad_length/);
  });

  test('framed: Längenpräfix macht Feldgrenzen eindeutig', () => {
    assert.notDeepEqual(transcript('ab', 'c'), transcript('a', 'bc'));
    assert.equal(framed('a', '').toString('hex'), '000161' + '0000');
  });

  test('Geräte-Handshake: beide Seiten haben dieselben Schlüssel, Nachrichten kommen an', () => {
    const box = generateIdentity();
    const dev = generateIdentity();
    const d = createDeviceHandshake({ boxPublicRaw: box.publicRaw, signer: dev });
    const b = createBoxHandshake({ boxSigner: box, lookupDevice: (id) => (id === dev.id ? dev.publicRaw : null) });
    const r = d.onHs2(b.onHs1(d.hello()));
    const rb = b.onHs3(r.hs3);
    assert.equal(rb.devId, dev.id);
    assert.deepEqual(rb.session.open(r.session.seal({ hallo: 1 })), { hallo: 1 });
    assert.deepEqual(r.session.open(rb.session.seal({ zurück: 2 })), { zurück: 2 });
  });

  test('Geräte-Handshake: fremde Box (falscher Schlüssel im QR) wird abgelehnt', () => {
    const box = generateIdentity();
    const fake = generateIdentity();
    const dev = generateIdentity();
    const d = createDeviceHandshake({ boxPublicRaw: box.publicRaw, signer: dev });
    const b = createBoxHandshake({ boxSigner: fake, lookupDevice: () => dev.publicRaw });
    assert.throws(() => d.onHs2(b.onHs1(d.hello())), /box_signature_invalid/);
  });

  test('Geräte-Handshake: fremdes Gerät mit fremder dev-ID kommt nicht durch', () => {
    const box = generateIdentity();
    const dev = generateIdentity();
    const thief = generateIdentity();
    // Dieb gibt die ID des echten Geräts an, hat aber dessen Schlüssel nicht.
    const d = createDeviceHandshake({ boxPublicRaw: box.publicRaw, signer: { publicRaw: dev.publicRaw, sign: thief.sign } });
    const b = createBoxHandshake({ boxSigner: box, lookupDevice: (id) => (id === dev.id ? dev.publicRaw : null) });
    const r = d.onHs2(b.onHs1(d.hello()));
    assert.throws(() => b.onHs3(r.hs3), /device_signature_invalid/);
    const u = createBoxHandshake({ boxSigner: box, lookupDevice: () => null });
    assert.throws(() => u.onHs1(createDeviceHandshake({ boxPublicRaw: box.publicRaw, signer: thief }).hello()), /unknown_device/);
  });

  test('Sitzung: Wiederholung, Auslassung und Manipulation scheitern', () => {
    const box = generateIdentity();
    const dev = generateIdentity();
    const d = createDeviceHandshake({ boxPublicRaw: box.publicRaw, signer: dev });
    const b = createBoxHandshake({ boxSigner: box, lookupDevice: () => dev.publicRaw });
    const r = d.onHs2(b.onHs1(d.hello()));
    const rb = b.onHs3(r.hs3);
    const m0 = r.session.seal({ n: 0 });
    const m1 = r.session.seal({ n: 1 });
    assert.throws(() => rb.session.open(m1), /decrypt_failed/); // ausgelassen
    // Nach dem Fehlschlag ist der Zähler unverändert: m0 geht noch.
    assert.deepEqual(rb.session.open(m0), { n: 0 });
    assert.throws(() => rb.session.open(m0), /decrypt_failed/); // Wiederholung
    const raw = fromB64u(m1);
    raw[0] ^= 1;
    assert.throws(() => rb.session.open(b64u(raw)), /decrypt_failed/);
  });

  test('Kopplung: nur mit dem Geheimnis aus dem QR-Code', () => {
    const box = generateIdentity();
    const dev = generateIdentity();
    const secret = crypto.randomBytes(32);
    const d = createPairDevice({ boxPublicRaw: box.publicRaw, secret, signer: dev });
    const b = createPairBox({ boxSigner: box, secret });
    const { p2, session: bs } = b.onP1(d.hello());
    const { session: ds, p3 } = d.onP2(p2, { name: 'Test', model: 'iPhone Duo' });
    const cand = b.verifyP3(bs.open(ds.seal(p3)));
    assert.equal(cand.devId, dev.id);
    assert.equal(cand.model, 'iPhone Duo');

    // Gleicher Ablauf mit falschem Geheimnis: Box kann p3 nicht öffnen.
    const d2 = createPairDevice({ boxPublicRaw: box.publicRaw, secret: crypto.randomBytes(32), signer: dev });
    const b2 = createPairBox({ boxSigner: box, secret });
    const r2 = b2.onP1(d2.hello());
    const x = d2.onP2(r2.p2);
    assert.throws(() => r2.session.open(x.session.seal(x.p3)), /decrypt_failed/);
  });

  test('Kopplung: p3 mit fremdem Schlüssel (ohne Besitznachweis) wird abgelehnt', () => {
    const box = generateIdentity();
    const dev = generateIdentity();
    const other = generateIdentity();
    const secret = crypto.randomBytes(32);
    const d = createPairDevice({ boxPublicRaw: box.publicRaw, secret, signer: dev });
    const b = createPairBox({ boxSigner: box, secret });
    const { p2, session: bs } = b.onP1(d.hello());
    const { session: ds, p3 } = d.onP2(p2);
    assert.throws(() => b.verifyP3(bs.open(ds.seal({ ...p3, pub: b64u(other.publicRaw) }))), /device_signature_invalid/);
  });

  test('Ticket: gültig, abgelaufen, gefälscht, andere Box', () => {
    const box = generateIdentity();
    const other = generateIdentity();
    const t = issueTicket(box, 'devA', 2000);
    assert.deepEqual(verifyTicket(t, 1000), { boxId: box.id, devId: 'devA' });
    assert.equal(verifyTicket(t, 2000), null);
    assert.equal(verifyTicket({ ...t, dev: 'devB' }, 1000), null);
    assert.equal(verifyTicket({ ...t, exp: 3000 }, 1000), null);
    assert.equal(verifyTicket({ ...t, box: b64u(other.publicRaw) }, 1000), null);
  });

  test('X25519: Punkte kleiner Ordnung werden abgelehnt', () => {
    const e = x25519FromSeed(Buffer.alloc(32, 1));
    assert.throws(() => x25519Shared(e.privateKey, Buffer.alloc(32, 0)), /bad_ephemeral/);
  });

  test('Briefkasten: nur mit dem Schlüssel und nur für das eigene Gerät', () => {
    const k = crypto.randomBytes(32);
    const d = sealMailbox(k, 'devA', { t: 'latest', soc: 50 });
    assert.deepEqual(openMailbox(k, 'devA', d), { t: 'latest', soc: 50 });
    assert.throws(() => openMailbox(k, 'devB', d), /decrypt_failed/);
    assert.throws(() => openMailbox(crypto.randomBytes(32), 'devA', d), /decrypt_failed/);
  });

  test('QR-Inhalt: Hin und zurück, SVG ohne Skript', () => {
    const box = generateIdentity();
    const secret = crypto.randomBytes(32);
    const qr = buildPairPayload({ boxPublicRaw: box.publicRaw, secret, name: 'Haus & Hof', lan: ['192.168.1.2', 'x/y', 'dvhub.local:8080', 'dritte'], relay: 'wss://relay.dvhub.de/v1/ws', expSec: 123 });
    const p = parsePairPayload(qr);
    assert.ok(qr.length < 300, `QR-Inhalt zu lang: ${qr.length}`);
    assert.deepEqual(p.lan, ['ws://192.168.1.2/api/mobile-link/ws', 'ws://dvhub.local:8080/api/mobile-link/ws']);
    assert.equal(p.name, 'Haus & Hof');
    assert.equal(p.expSec, 123);
    assert.deepEqual(p.secret, secret);
    assert.deepEqual(p.boxPublicRaw, box.publicRaw);
    assert.equal(p.relay, 'wss://relay.dvhub.de/v1/ws');
    const svg = qrSvg(qr);
    assert.match(svg, /^<svg/);
    assert.doesNotMatch(svg, /<script|on\w+=|href=/i);
  });
});

// ── Prüfwerte (gemeinsam mit der iPhone-App) ────────────────────────────────

describe('mobile-link Prüfwerte', () => {
  const v = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'mobile-link-vectors.json'), 'utf8'));
  const jwk = (d, pub) => {
    const raw = fromB64u(pub, 65);
    return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d, x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  };
  const box = signerFromPrivateKey(jwk(v.keys.boxPrivateRaw, v.keys.boxPub));
  const dev = signerFromPrivateKey(jwk(v.keys.devPrivateRaw, v.keys.devPub));

  test('Schlüssel, IDs, framed, Transkript', () => {
    assert.equal(b64u(box.publicRaw), v.keys.boxPub);
    assert.equal(keyId(box.publicRaw), v.keys.boxId);
    assert.equal(keyId(dev.publicRaw), v.keys.devId);
    assert.equal(framed(...v.framed.input).toString('hex'), v.framed.framedHex);
    assert.equal(transcript(...v.framed.input).toString('hex'), v.framed.transcriptHex);
  });

  test('Relay-Anmeldung, Ticket, Kopplungs-Token', () => {
    assert.equal(relayAuthData('box', v.relayAuth.challenge).toString('hex'), v.relayAuth.boxDataHex);
    assert.ok(verifySig(box.publicRaw, relayAuthData('box', v.relayAuth.challenge), v.relayAuth.boxSig));
    assert.ok(verifySig(dev.publicRaw, relayAuthData('device', v.relayAuth.challenge), v.relayAuth.deviceSig));
    assert.deepEqual(verifyTicket(v.ticket, 1_800_000_000), { boxId: v.keys.boxId, devId: v.keys.devId });
    const secret = fromB64u(v.pairToken.secret, 32);
    assert.equal(b64u(pairRelayToken(secret)), v.pairToken.token);
    assert.equal(pairTokenHash(pairRelayToken(secret)), v.pairToken.tokenHash);
  });

  test('Handshakes mit festen Seeds ergeben dieselben Transkripte und Chiffretexte', () => {
    const h = v.deviceHandshake;
    const d = createDeviceHandshake({ boxPublicRaw: box.publicRaw, signer: dev, eph: x25519FromSeed(fromB64u(h.ephDeviceSeed)), nonce: Buffer.alloc(16, 3) });
    assert.deepEqual(d.hello(), h.hs1);
    const r = d.onHs2(h.hs2);
    assert.equal(r.th.toString('hex'), h.transcriptHex);
    assert.equal(r.session.seal(JSON.parse(h.deviceToBox[0].plaintext)), h.deviceToBox[0].d);
    assert.equal(r.session.seal(JSON.parse(h.deviceToBox[1].plaintext)), h.deviceToBox[1].d);
    assert.equal(JSON.stringify(r.session.open(h.boxToDevice[0].d)), h.boxToDevice[0].plaintext);

    const p = v.pairHandshake;
    const pd = createPairDevice({ boxPublicRaw: box.publicRaw, secret: fromB64u(p.secret, 32), signer: dev, eph: x25519FromSeed(fromB64u(p.ephDeviceSeed)), nonce: Buffer.alloc(16, 7) });
    assert.deepEqual(pd.hello(), p.p1);
    const pr = pd.onP2(p.p2);
    assert.equal(pr.th.toString('hex'), p.transcriptHex);
    assert.equal(JSON.stringify(pr.session.open(p.boxToDevice[0].d)), p.boxToDevice[0].plaintext);
  });

  test('QR-Beispiel wird wie beschrieben gelesen', () => {
    const p = parsePairPayload(v.qrExample);
    const e = v.qrExampleParsed;
    assert.deepEqual([b64u(p.boxPublicRaw), b64u(p.secret), p.name, p.lan, p.relay, p.expSec], [e.box, e.secret, e.name, e.lan, e.relay, e.exp]);
  });

  test('Briefkasten und Roh-AEAD', () => {
    assert.equal(JSON.stringify(openMailbox(fromB64u(v.mailbox.key, 32), v.mailbox.devId, v.mailbox.d)), v.mailbox.plaintext);
    const sealed = aeadSeal(fromB64u(v.aead.key, 32), Buffer.from(v.aead.nonceHex, 'hex'), Buffer.from(v.aead.plaintext), Buffer.from(v.aead.aadHex, 'hex'));
    assert.equal(sealed.toString('hex'), v.aead.sealedHex);
  });
});

// ── Relay (ohne Netz, Memory-Sockets) ───────────────────────────────────────

function memClient(relay) {
  const [mine, theirs] = createMemorySocketPair();
  const inbox = [];
  const state = { closed: null };
  mine.onMessage((t) => inbox.push(JSON.parse(t)));
  // Schließcode kommt über close(code, reason) des Relays an der Relay-Seite an;
  // wir merken ihn uns über eine Hülle.
  const wrapped = {
    send: theirs.send, onMessage: theirs.onMessage, onClose: theirs.onClose,
    close: (code, reason) => { state.closed = { code, reason }; theirs.close(); },
  };
  relay.attach(wrapped);
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

async function deviceOnRelay(relay, boxSigner, devSigner, { ticket = null } = {}) {
  const c = memClient(relay);
  const ch = await c.next('challenge');
  c.send({ t: 'auth', role: 'device', ticket: ticket || issueTicket(boxSigner, devSigner.id, Math.floor(Date.now() / 1000) + 3600), pub: b64u(devSigner.publicRaw), sig: b64u(devSigner.sign(relayAuthData('device', ch.n))) });
  return c;
}

describe('mobile-link relay-core', () => {
  test('Box-Anmeldung mit falscher Signatur → 4002', async () => {
    const relay = createRelay();
    const box = generateIdentity();
    const other = generateIdentity();
    const c = memClient(relay);
    const ch = await c.next('challenge');
    c.send({ t: 'auth', role: 'box', pub: b64u(box.publicRaw), sig: b64u(other.sign(relayAuthData('box', ch.n))) });
    await until(() => c.state.closed);
    assert.equal(c.state.closed.code, CLOSE.authFailed);
    relay.close();
  });

  test('Gerät: Ticket einer anderen Box, fremder Schlüssel, nicht freigegeben → abgelehnt', async () => {
    const relay = createRelay();
    const box = generateIdentity();
    const dev = generateIdentity();
    const thief = generateIdentity();
    const b = await boxOnRelay(relay, box);
    b.send({ t: 'allow', devs: [dev.id] });
    await sleep(10);
    // Ticket für dev, aber Signatur vom Dieb
    const c1 = memClient(relay);
    const ch = await c1.next('challenge');
    c1.send({ t: 'auth', role: 'device', ticket: issueTicket(box, dev.id, Math.floor(Date.now() / 1000) + 60), pub: b64u(dev.publicRaw), sig: b64u(thief.sign(relayAuthData('device', ch.n))) });
    await until(() => c1.state.closed);
    assert.equal(c1.state.closed.code, CLOSE.authFailed);
    // Gültig unterschriebenes Ticket, aber nicht in der Freigabeliste
    const c2 = await deviceOnRelay(relay, box, thief);
    await until(() => c2.state.closed);
    assert.equal(c2.state.closed.code, CLOSE.notAllowed);
    // Freigegeben → ok, Box bekommt open
    const c3 = await deviceOnRelay(relay, box, dev);
    const ok = await c3.next('ok');
    assert.equal(ok.boxOnline, true);
    const open = await b.next('open');
    assert.equal(open.dev, dev.id);
    // Entzug der Freigabe trennt sofort
    b.send({ t: 'allow', devs: [] });
    await until(() => c3.state.closed);
    assert.equal(c3.state.closed.code, CLOSE.notAllowed);
    relay.close();
  });

  test('Kopplungs-Token: nur einmal, nur mit dem richtigen Token, läuft ab', async () => {
    let t = Date.now();
    const relay = createRelay({ now: () => t });
    const box = generateIdentity();
    const b = await boxOnRelay(relay, box);
    const token = pairRelayToken(crypto.randomBytes(32));
    b.send({ t: 'pair_open', h: pairTokenHash(token), ttlMs: 60_000 });
    await sleep(10);
    const wrong = memClient(relay);
    await wrong.next('challenge');
    wrong.send({ t: 'auth', role: 'pair', box: box.id, token: b64u(crypto.randomBytes(32)) });
    await until(() => wrong.state.closed);
    assert.equal(wrong.state.closed.code, CLOSE.authFailed);
    const p1 = memClient(relay);
    await p1.next('challenge');
    p1.send({ t: 'auth', role: 'pair', box: box.id, token: b64u(token) });
    await p1.next('ok');
    const p2 = memClient(relay);
    await p2.next('challenge');
    p2.send({ t: 'auth', role: 'pair', box: box.id, token: b64u(token) });
    await until(() => p2.state.closed);
    assert.equal(p2.state.closed.reason, 'pairing_not_open');
    // Ablauf
    b.send({ t: 'pair_open', h: pairTokenHash(token), ttlMs: 1000 });
    await sleep(10);
    t += 2000;
    const p3 = memClient(relay);
    await p3.next('challenge');
    p3.send({ t: 'auth', role: 'pair', box: box.id, token: b64u(token) });
    await until(() => p3.state.closed);
    assert.equal(p3.state.closed.reason, 'pairing_not_open');
    relay.close();
  });

  test('Briefkasten: letzter Stand überschreibt, Ereignisse bis zur Quittung, 24 h, nur eigenes Gerät', async () => {
    let t = Date.now();
    const relay = createRelay({ now: () => t, limits: { mailboxItems: 3 } });
    const box = generateIdentity();
    const devA = generateIdentity();
    const devB = generateIdentity();
    const b = await boxOnRelay(relay, box);
    b.send({ t: 'allow', devs: [devA.id, devB.id] });
    b.send({ t: 'mbox_put', dev: devA.id, slot: 'latest', d: 'AAAA' });
    b.send({ t: 'mbox_put', dev: devA.id, slot: 'latest', d: 'BBBB' });
    for (const d of ['e1', 'e2', 'e3', 'e4']) b.send({ t: 'mbox_put', dev: devA.id, d });
    await sleep(10);
    const a = await deviceOnRelay(relay, box, devA);
    await a.next('ok');
    a.send({ t: 'mbox_get' });
    let mb = await a.next('mbox');
    assert.deepEqual(mb.items.map((i) => i.d), ['BBBB', 'e2', 'e3', 'e4']);
    a.send({ t: 'mbox_ack', ids: [mb.items[1].id, 'latest'] });
    a.send({ t: 'mbox_get' });
    mb = await a.next('mbox');
    assert.deepEqual(mb.items.map((i) => i.d), ['BBBB', 'e3', 'e4']);
    const other = await deviceOnRelay(relay, box, devB);
    await other.next('ok');
    other.send({ t: 'mbox_get' });
    assert.deepEqual((await other.next('mbox')).items, []);
    t += 25 * 3600_000;
    a.send({ t: 'mbox_get' });
    assert.deepEqual((await a.next('mbox')).items, []);
    assert.equal(relay.stats().mailboxBytes, 0);
    relay.close();
  });

  test('Briefkasten nur für freigegebene Geräte, Anzahl begrenzt (Fable H1)', async () => {
    const relay = createRelay({ limits: { maxMailboxes: 3 } });
    const box = generateIdentity();
    const b = await boxOnRelay(relay, box);
    // Ohne Freigabeliste: nichts wird abgelegt (fremde Box-Identitäten können
    // sonst beliebig viele Briefkästen anlegen).
    for (let i = 0; i < 5; i++) b.send({ t: 'mbox_put', dev: `dev${i}`, d: 'A' });
    await sleep(20);
    assert.equal(relay.stats().mailboxes, 0);
    b.send({ t: 'allow', devs: ['a', 'b', 'c', 'd'] });
    for (const dev of ['a', 'b', 'c', 'd', 'x']) b.send({ t: 'mbox_put', dev, d: 'A' });
    await sleep(20);
    assert.equal(relay.stats().mailboxes, 3);
    assert.equal((await b.next('error')).e, 'relay_full');
    // Zu lange Freigabeliste wird abgelehnt.
    b.send({ t: 'allow', devs: Array.from({ length: 100 }, (_, i) => `d${i}`) });
    await until(() => b.state.closed);
    assert.equal(b.state.closed.reason, 'bad_allow');
    relay.close();
  });

  test('Verbindungen je Quelladresse begrenzt (Fable H1)', async () => {
    const relay = createRelay({ limits: { maxConnectionsPerRemote: 2 } });
    const open = [];
    for (let i = 0; i < 3; i++) {
      const [mine, theirs] = createMemorySocketPair();
      const st = { closed: null };
      relay.attach({ ...theirs, close: (code, reason) => { st.closed = { code, reason }; theirs.close(); } }, { remote: '203.0.113.7' });
      open.push(st);
      mine.onMessage(() => {});
    }
    await sleep(10);
    assert.deepEqual(open.map((o) => o.closed?.reason || null), [null, null, 'too_many_connections']);
    relay.close();
  });

  test('pair_open mit relativer Laufzeit: Uhrzeitversatz der Box stört nicht (Fable M1)', async () => {
    const relay = createRelay({ now: () => Date.now() + 3600_000 }); // Relay-Uhr 1 h vor
    const box = generateIdentity();
    const b = await boxOnRelay(relay, box);
    const token = pairRelayToken(crypto.randomBytes(32));
    b.send({ t: 'pair_open', h: pairTokenHash(token), ttlMs: 60_000 });
    await sleep(10);
    const p = memClient(relay);
    await p.next('challenge');
    p.send({ t: 'auth', role: 'pair', box: box.id, token: b64u(token) });
    assert.equal((await p.next('ok')).role, 'pair');
    // Ungültige Angaben trennen die Box nicht, sondern ergeben einen Fehler.
    b.send({ t: 'pair_open', h: pairTokenHash(token), ttlMs: -5 });
    assert.equal((await b.next('error')).e, 'bad_pair_open');
    assert.equal(b.state.closed, null);
    relay.close();
  });

  test('Gerät wartet bei Box offline, Box kommt → open; Box geht → box_offline', async () => {
    const relay = createRelay();
    const box = generateIdentity();
    const dev = generateIdentity();
    const d = await deviceOnRelay(relay, box, dev);
    const ok = await d.next('ok');
    assert.equal(ok.boxOnline, false);
    d.send({ t: 'data', d: 'eA' });
    assert.equal((await d.next('error')).e, 'box_offline');
    const b = await boxOnRelay(relay, box);
    assert.equal((await b.next('open')).dev, dev.id);
    await d.next('box_online');
    // Zweite Verbindung derselben Box ersetzt die erste.
    const b2 = await boxOnRelay(relay, box);
    await until(() => b.state.closed);
    assert.equal(b.state.closed.code, CLOSE.replaced);
    assert.equal((await b2.next('open')).dev, dev.id);
    // Geräte erfahren davon und handshaken neu (Fable N4).
    await d.next('box_offline');
    await d.next('box_online');
    relay.close();
  });

  test('Grenzen: zu großer Rahmen und Flut werden getrennt, Anmeldung läuft ab', async () => {
    const relay = createRelay({ limits: { deviceFrameBytes: 1000, deviceFramesPerWindow: 5, authTimeoutMs: 50 } });
    const box = generateIdentity();
    const dev = generateIdentity();
    await boxOnRelay(relay, box);
    const d = await deviceOnRelay(relay, box, dev);
    await d.next('ok');
    d.send({ t: 'data', d: 'x'.repeat(2000) });
    await until(() => d.state.closed);
    assert.equal(d.state.closed.code, CLOSE.limit);
    const d2 = await deviceOnRelay(relay, box, dev);
    await d2.next('ok');
    for (let i = 0; i < 10; i++) d2.send({ t: 'ping' });
    await until(() => d2.state.closed);
    assert.equal(d2.state.closed.reason, 'rate_limited');
    const idle = memClient(relay);
    await until(() => idle.state.closed, 1000);
    assert.equal(idle.state.closed.code, CLOSE.authTimeout);
    relay.close();
  });
});

// ── Robustheit gegen kaputte Rahmen (Codex R1 P1) ───────────────────────────

describe('mobile-link Codex R2', () => {
  test('langsamer Empfänger: Ausgangspuffer begrenzt, Verbindung wird getrennt (P1)', () => {
    let terminated = false;
    let sent = 0;
    const fake = {
      readyState: 1, bufferedAmount: 0,
      send() { sent++; this.bufferedAmount += 1024 * 1024; },
      terminate() { terminated = true; this.readyState = 3; },
      ping() {}, close() {}, on() {},
    };
    const sock = wrapWebSocket(fake, { pingMs: 0 });
    for (let i = 0; i < 50; i++) sock.send('x');
    assert.ok(terminated, 'langsamer Empfänger nicht getrennt');
    assert.ok(sent <= 9, `zu viel gepuffert: ${sent} MiB`);
  });

  test('Umzugssicherung enthält die Schlüsseldatei der Handy-App (P2)', () => {
    assert.ok(isAllowedMigrationFile(`data/${SIDECAR_NAME}`));
  });
});

describe('mobile-link Relay-Prozess', () => {
  test('kaputter WebSocket-Rahmen beendet den Relay-Prozess nicht', async () => {
    const child = spawn(process.execPath, [path.join(here, '..', 'services', 'mobile-link', 'relay-server.js')], {
      env: { ...process.env, RELAY_PORT: '0', RELAY_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const port = await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (b) => { out += b; const m = /:(\d+)\/v1\/ws/.exec(out); if (m) resolve(Number(m[1])); });
        child.on('exit', (c) => reject(new Error(`exit ${c}`)));
      });
      // Handshake von Hand, dann ein unmaskierter Rahmen (Client→Server muss maskiert sein).
      await new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write('GET /v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
        });
        sock.once('data', () => { sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); setTimeout(() => { sock.destroy(); resolve(); }, 300); });
        sock.on('error', () => resolve());
      });
      await sleep(200);
      assert.equal(child.exitCode, null, 'Relay-Prozess ist abgestürzt');
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.status, 200);
    } finally {
      child.kill();
    }
  });
});

// ── Rechte und Einstellungen ────────────────────────────────────────────────

describe('mobile-link Rechte', () => {
  test('lesen: nur freigegebene GET-Pfade; keine Umwege', () => {
    assert.equal(checkRequest(['read'], 'GET', '/api/status?x=1').ok, true);
    assert.equal(checkRequest(['read'], 'GET', '/api/history/viz/day').ok, true);
    for (const p of ['/api/config', '/api/config/export', '/api/db/backup', '/api/admin/health', '/api/mobile-link/status',
      '/api/status/../config', '/api/%2e%2e/config', '//api/status', '/api//status', '/api/status#x', 'http://evil/api/status']) {
      assert.equal(checkRequest(['read', 'control'], 'GET', p).ok, false, p);
    }
  });

  test('steuern: nur mit Recht control und nur die Schalt-Endpunkte', () => {
    assert.equal(checkRequest(['read'], 'POST', '/api/control/stop').error, 'control_not_allowed');
    assert.equal(checkRequest(['read', 'control'], 'POST', '/api/control/stop').ok, true);
    assert.equal(checkRequest(['read', 'control'], 'POST', '/api/config').ok, false);
    assert.equal(checkRequest(['read', 'control'], 'DELETE', '/api/status').status, 405);
    assert.deepEqual(normalizePerms(['control', 'admin']), ['read', 'control']);
    assert.deepEqual(normalizePerms(null), ['read']);
  });

  test('Relay-Adresse: Kurzform, https→wss, ws nur im eigenen Netz', () => {
    assert.equal(normalizeRelayUrl('relay.dvhub.de'), 'wss://relay.dvhub.de/v1/ws');
    assert.equal(normalizeRelayUrl('https://relay.example.org'), 'wss://relay.example.org/v1/ws');
    assert.equal(normalizeRelayUrl('wss://r.example.org:8443/eigen/pfad'), 'wss://r.example.org:8443/eigen/pfad');
    assert.equal(normalizeRelayUrl('ws://192.168.1.5:8787'), 'ws://192.168.1.5:8787/v1/ws');
    for (const bad of ['ws://relay.example.org', 'ftp://x', 'wss://user:pw@x.org', '', 'javascript:alert(1)']) {
      assert.equal(normalizeRelayUrl(bad), null, bad);
    }
    assert.equal(sanitizeLanHost('192.168.1.60:8080'), '192.168.1.60:8080');
    assert.equal(sanitizeLanHost('evil.org/x?y'), null);
  });
});

// ── Ende zu Ende über echte WebSockets ──────────────────────────────────────

function makeAgent({ dir, relayUrl, extraCfg = {}, loopback, status = () => ({ soc: 55, batteryPowerW: -1200, alarmsActive: 0 }) }) {
  let cfg = { httpPort: 18099, mobileLink: { enabled: true, relayUrl, ...extraCfg } };
  const logs = [];
  const agent = createMobileLink(
    { getCfg: () => cfg, getDataDir: () => dir, pushLog: (e, d) => logs.push([e, d]) },
    {
      buildStatus: status,
      loopback: loopback || (async (m, p, b) => ({ status: 200, body: { echo: [m, p, b] } })),
      networkHosts: () => [],
    },
  );
  return { agent, logs, setCfg: (c) => { cfg = c; } };
}

describe('mobile-link Ende zu Ende', () => {
  const cleanups = [];
  after(async () => { for (const f of cleanups.reverse()) await f(); });

  async function setup(opts = {}) {
    const r = startRelayServer({ port: 0, host: '127.0.0.1', log: () => {}, pingMs: 0 });
    const addr = await r.ready;
    const relayUrl = `ws://127.0.0.1:${addr.port}/v1/ws`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-link-'));
    const a = makeAgent({ dir, relayUrl, ...opts });
    a.agent.start();
    cleanups.push(async () => { a.agent.stop(); await r.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { ...a, relayUrl, dir, relay: r };
  }

  async function pairVia(ctx, url, { perms = ['read'] } = {}) {
    const p = ctx.agent.startPairing();
    await until(() => ctx.agent.status().relay?.online);
    const phone = generateIdentity();
    const creds = await pairDevice({
      qr: p.qr, signer: phone, name: 'Testhandy', model: 'iPhone Duo', url,
      onWait: () => ctx.agent.approvePairing({ perms, approveToken: p.approveToken }),
    });
    return { phone, creds };
  }

  test('koppeln über das Relay, Sitzung, Live-Werte, Rechte, Briefkasten, entkoppeln', async () => {
    const ctx = await setup();
    const { phone, creds } = await pairVia(ctx, null);
    assert.equal(creds.boxId, ctx.agent._boxId());
    assert.deepEqual(creds.perms, ['read']);
    // Sidecar: 0600, enthält das Gerät, aber keine Kopplungsgeheimnisse.
    const sc = path.join(ctx.dir, SIDECAR_NAME);
    assert.equal(fs.statSync(sc).mode & 0o777, 0o600);
    const stored = JSON.parse(fs.readFileSync(sc, 'utf8'));
    assert.equal(stored.devices[0].id, creds.devId);

    const s = await connectDevice({ creds, signer: phone, url: ctx.relayUrl });
    assert.equal(s.welcome().box.id, creds.boxId);
    const lives = [];
    s.on('live', (m) => lives.push(m));
    s.subscribe(true, 1000);
    assert.deepEqual(await s.request('GET', '/api/status?x=1'), { status: 200, body: { echo: ['GET', '/api/status?x=1', null] } });
    // GET trägt nie einen Body zur eigenen API.
    assert.deepEqual((await s.request('GET', '/api/costs', { heimlich: 1 })).body, { echo: ['GET', '/api/costs', null] });
    assert.equal((await s.request('POST', '/api/control/stop', {})).status, 403);
    assert.equal((await s.request('GET', '/api/config')).status, 403);
    await until(() => lives.length >= 1);
    assert.equal(lives[0].status.soc, 55);

    ctx.agent._pushMailboxLatest();
    await sleep(50);
    const mb = await s.fetchMailbox();
    assert.equal(mb[0].slot, 'latest');
    assert.equal(mb[0].msg.status.soc, 55);

    ctx.agent.removeDevice(creds.devId);
    await until(() => s.closedInfo());
    assert.equal(s.closedInfo().reason, 'device_removed');
    // Wieder verbinden: Box ist ohne Geräte nicht mehr am Relay — das Gerät
    // kommt höchstens in den (geleerten) Briefkasten, nie zur Box.
    const again = await connectDevice({ creds, signer: phone, url: ctx.relayUrl });
    assert.equal(again.boxOnline(), false);
    assert.deepEqual(await again.fetchMailbox(), []);
    again.close();
  });

  test('Heimnetz: koppeln und verbinden direkt an der Box; Steuern mit Recht control', async () => {
    const calls = [];
    const ctx = await setup({
      extraCfg: { useRelay: false },
      loopback: async (m, p, b) => { calls.push([m, p, b]); return { status: 200, body: { ok: true } }; },
    });
    const srv = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    srv.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => ctx.agent.attachLan(ws)));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => { wss.close(); srv.close(() => r()); }));
    const lanUrl = `ws://127.0.0.1:${srv.address().port}/api/mobile-link/ws`;

    const p = ctx.agent.startPairing();
    assert.equal(parsePairPayload(p.qr).relay, null);
    const phone = generateIdentity();
    const creds = await pairDevice({ qr: p.qr, signer: phone, url: lanUrl, onWait: () => ctx.agent.approvePairing({ perms: ['read', 'control'], approveToken: p.approveToken }) });
    assert.equal(ctx.agent.status().relay, null, 'ohne Relay keine Außenverbindung');
    const s = await connectDevice({ creds, signer: phone, url: lanUrl });
    assert.equal(s.welcome().via, 'lan');
    const r = await s.request('POST', '/api/control/stop', { reason: 'test' });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.at(-1), ['POST', '/api/control/stop', JSON.stringify({ reason: 'test' })]);
    assert.ok(ctx.logs.some(([e, d]) => e === 'mobile_link_control' && d.path === '/api/control/stop'));
    s.close();
  });

  test('kaputte Handshakes fluten das Protokoll nicht', async () => {
    const ctx = await setup();
    const { phone, creds } = await pairVia(ctx, null);
    const { default: WebSocket } = await import('ws');
    for (let i = 0; i < 5; i++) {
      const ws = new WebSocket(ctx.relayUrl);
      await new Promise((resolve) => {
        ws.on('message', (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.t === 'challenge') {
            ws.send(JSON.stringify({ t: 'auth', role: 'device', ticket: creds.ticket, pub: b64u(phone.publicRaw), sig: b64u(phone.sign(relayAuthData('device', m.n))) }));
          } else if (m.t === 'ok') {
            ws.send(JSON.stringify({ t: 'data', d: b64u(Buffer.from('kein json')) }));
          }
        });
        ws.on('close', resolve);
      });
    }
    const errors = ctx.logs.filter(([e]) => e === 'mobile_link_peer_error');
    assert.equal(errors.length, 1, JSON.stringify(errors));
  });

  test('zu große Antwort → 413, die Verbindung der Box zum Relay bleibt (Codex R1 P2)', async () => {
    // 800 000 ASCII-Zeichen: unter der Zeichengrenze, verschlüsselt und base64
    // aber über der Rahmengrenze des Relays.
    const ctx = await setup({ loopback: async () => ({ status: 200, body: 'x'.repeat(800_000) }) });
    const { phone, creds } = await pairVia(ctx, null);
    const s = await connectDevice({ creds, signer: phone, url: ctx.relayUrl });
    const r = await s.request('GET', '/api/status', null, 5000);
    assert.equal(r.status, 413);
    assert.equal(ctx.agent.status().relay.online, true);
    // Die Sitzung läuft weiter (Zähler nicht verrutscht).
    s.subscribe(true, 1000);
    await until(() => new Promise((res) => s.once('live', () => res(true))));
    s.close();
  });

  test('QR-Inhalt nicht im Status, Freigabe nur mit Token, Vergleichscode stimmt (Fable M3)', async () => {
    const ctx = await setup();
    const p = ctx.agent.startPairing();
    assert.ok(p.qr && p.qrSvg && p.approveToken);
    const st = JSON.stringify(ctx.agent.status());
    assert.ok(!st.includes(parsePairPayload(p.qr).secret.toString('base64url')), 'Geheimnis im Status');
    assert.ok(!st.includes(p.approveToken), 'Freigabe-Token im Status');
    await until(() => ctx.agent.status().relay?.online);
    let phoneCode = null;
    const creds = await pairDevice({
      qr: p.qr, signer: generateIdentity(),
      onWait: (m) => {
        phoneCode = m.code;
        const cand = ctx.agent.status().pairing.candidate;
        assert.match(cand.code, /^\d{6}$/);
        assert.equal(cand.code, m.code, 'Vergleichscode Box ≠ Handy');
        assert.throws(() => ctx.agent.approvePairing({ perms: ['read'] }), /approve_token_invalid/);
        assert.throws(() => ctx.agent.approvePairing({ perms: ['read'], approveToken: 'x'.repeat(24) }), /approve_token_invalid/);
        ctx.agent.approvePairing({ perms: ['read'], approveToken: p.approveToken });
      },
    });
    assert.ok(phoneCode);
    assert.equal(creds.perms[0], 'read');
  });

  test('Anfragen je Gerät gebremst, Gerät steht im Audit-Header (Fable M2, N1)', async () => {
    const seen = [];
    const ctx = await setup({ loopback: async (m, p, b, meta) => { seen.push(meta?.devId); return { status: 200, body: {} }; } });
    const { phone, creds } = await pairVia(ctx, null);
    const s = await connectDevice({ creds, signer: phone, url: ctx.relayUrl });
    const codes = [];
    for (let i = 0; i < 62; i++) codes.push((await s.request('GET', '/api/status')).status);
    assert.equal(codes.filter((c) => c === 200).length, 60);
    assert.equal(codes.at(-1), 429);
    assert.equal(seen[0], creds.devId);
    s.close();
  });

  test('kaputte Schlüsseldatei: keine neue Identität, Datei bleibt, App bleibt aus (Fable H2)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-link-'));
    const a = makeAgent({ dir, relayUrl: 'ws://127.0.0.1:9/v1/ws' });
    a.agent.start();
    a.agent.startPairing();
    const boxId = a.agent._boxId();
    a.agent.stop();
    const file = path.join(dir, SIDECAR_NAME);
    const broken = fs.readFileSync(file, 'utf8').slice(0, 40);
    fs.writeFileSync(file, broken);
    const b = makeAgent({ dir, relayUrl: 'ws://127.0.0.1:9/v1/ws' });
    b.agent.start();
    const st = b.agent.status();
    assert.equal(st.storeError, 'sidecar_corrupt');
    assert.equal(st.enabled, false);
    assert.throws(() => b.agent.startPairing(), /mobile_link_disabled|mobile_link_store_unreadable/);
    assert.equal(fs.readFileSync(file, 'utf8'), broken, 'Sidecar wurde überschrieben');
    assert.notEqual(st.boxId, 'neu');
    assert.ok(b.logs.some(([e]) => e === 'mobile_link_store_error'));
    b.agent.stop();
    // Fehlende Datei ist dagegen der Normalfall: neue Identität.
    fs.rmSync(file);
    const c = makeAgent({ dir, relayUrl: 'ws://127.0.0.1:9/v1/ws' });
    c.agent.start();
    c.agent.startPairing();
    assert.ok(c.agent._boxId() && c.agent._boxId() !== boxId);
    c.agent.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Live-Intervall jenseits der Timer-Grenze flutet nicht (Codex R2 P2)', async () => {
    const ctx = await setup();
    const { phone, creds } = await pairVia(ctx, null);
    const s = await connectDevice({ creds, signer: phone, url: ctx.relayUrl });
    const lives = [];
    s.on('live', (m) => lives.push(m));
    s.subscribe(true, 2147483648);
    await sleep(1200);
    assert.ok(lives.length <= 2, `${lives.length} Live-Nachrichten in 1,2 s`);
    assert.equal(ctx.agent.status().relay.online, true);
    s.close();
  });

  test('gleichzeitige Anfragen je Gerät über alle Verbindungen begrenzt (Codex R2 P2)', async () => {
    // Die Loopback-Anfragen hängen, bis alle Antworten auf die überzähligen
    // da sind — so hängt der Test nicht an Laufzeiten.
    let running = 0;
    let peak = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const ctx = await setup({ loopback: async () => {
      running++; peak = Math.max(peak, running);
      await gate;
      running--;
      return { status: 200, body: {} };
    } });
    const { phone, creds } = await pairVia(ctx, null);
    const a = await connectDevice({ creds: { ...creds }, signer: phone, url: ctx.relayUrl });
    const b = await connectDevice({ creds: { ...creds }, signer: phone, url: ctx.relayUrl });
    let rejected = 0;
    const all = [];
    for (let i = 0; i < 4; i++) {
      for (const c of [a, b]) all.push(c.request('GET', '/api/status').then((r) => { if (r.status === 429) rejected++; return r; }));
    }
    await until(() => rejected === 4, 10_000);
    assert.equal(peak, 4);
    release();
    const res = await Promise.all(all);
    assert.equal(res.filter((r) => r.status === 200).length, 4);
    a.close(); b.close();
  });

  test('QR-Code gilt genau einmal; abgelehnte Anfrage koppelt nicht', async () => {
    const ctx = await setup();
    const p = ctx.agent.startPairing();
    await until(() => ctx.agent.status().relay?.online);
    const first = pairDevice({ qr: p.qr, signer: generateIdentity(), onWait: () => ctx.agent.cancelPairing() });
    await assert.rejects(first, /pairing_denied|closed/);
    const second = pairDevice({ qr: p.qr, signer: generateIdentity(), onWait: () => assert.fail('darf nicht warten') });
    await assert.rejects(second, /closed/);
    assert.equal(ctx.agent.status().devices.length, 0);
  });

  test('Neustart: Schlüssel und Geräte bleiben, gekoppeltes Handy kommt wieder rein', async () => {
    const ctx = await setup();
    const { phone, creds } = await pairVia(ctx, null);
    ctx.agent.stop();
    const b = makeAgent({ dir: ctx.dir, relayUrl: ctx.relayUrl });
    b.agent.start();
    cleanups.push(() => b.agent.stop());
    assert.equal(b.agent._boxId(), creds.boxId);
    await until(() => b.agent.status().relay?.online);
    const s = await connectDevice({ creds, signer: phone, url: ctx.relayUrl });
    assert.equal((await s.request('GET', '/api/status')).status, 200);
    s.close();
  });

  test('Ausschalten trennt Handys sofort und schließt die Außenverbindung', async () => {
    const ctx = await setup();
    const { phone, creds } = await pairVia(ctx, null);
    const s = await connectDevice({ creds, signer: phone, url: ctx.relayUrl });
    ctx.setCfg({ httpPort: 18099, mobileLink: { enabled: false, relayUrl: ctx.relayUrl } });
    ctx.agent.reconcile();
    await until(() => s.closedInfo() || !s.boxOnline());
    assert.equal(ctx.agent.status().relay, null);
    assert.throws(() => ctx.agent.startPairing(), /mobile_link_disabled/);
    s.close();
  });
});
