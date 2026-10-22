#!/usr/bin/env node
// scripts/mobile-link-vectors.mjs — Prüfwerte für die Handy-Kopplung
// (docs/HANDY-APP-PROTOKOLL.md). Die iPhone-App (ios/DVhubLink) testet gegen
// genau diese Datei; nach einer Protokolländerung neu erzeugen:
//   node scripts/mobile-link-vectors.mjs > test/fixtures/mobile-link-vectors.json
//
// Feste Testschlüssel, feste kurzlebige Schlüssel und Nonces. ECDSA-Signaturen
// sind zufällig — sie stehen zum Prüfen drin, nicht zum Nachrechnen.

import crypto from 'node:crypto';
import {
  b64u, framed, transcript, keyId, signerFromPrivateKey, relayAuthData, issueTicket,
  pairRelayToken, pairTokenHash, x25519FromSeed, createDeviceHandshake, createBoxHandshake,
  createPairDevice, createPairBox, sealMailbox, aeadSeal,
} from '../services/mobile-link/crypto.js';
import { buildPairPayload } from '../services/mobile-link/qr.js';

// Nur für Prüfwerte — nirgends sonst verwenden.
const BOX_JWK = { kty: 'EC', crv: 'P-256', x: 'f_yYUuP-TRYJpYrpjuYTzGX6HJf6mknYZy5nLBr5qSM', y: 'RPfnPvyOkqYsNyeBe0lXDSzRL7TCxI2w8EkcAZEOWBg', d: 'KV3lK00U_3gNpjRF60QttJ_Eo73KmZD88c9dCGIJB3o' };
const DEV_JWK = { kty: 'EC', crv: 'P-256', x: '9yrjniLy5d0Prvz8BXNf5KBE3xwhoqsBYgMXMUZa8_4', y: 'xlvq2tpo35OppKeQIAGT6MDoEivPnKvxgTCO0DLgaHQ', d: 'TK-KpOtNALdNDBH9rLr8cUdYHLgoDPZ-h_luP2x0IpE' };

const seed = (b) => Buffer.alloc(32, b);
const nonce = (b) => Buffer.alloc(16, b);

const box = signerFromPrivateKey(crypto.createPrivateKey({ key: BOX_JWK, format: 'jwk' }));
const dev = signerFromPrivateKey(crypto.createPrivateKey({ key: DEV_JWK, format: 'jwk' }));
const out = { version: 1, note: 'Erzeugt von scripts/mobile-link-vectors.mjs — nicht von Hand ändern.' };

out.keys = {
  // Rohe Skalare (32 Byte) — CryptoKit: P256.Signing.PrivateKey(rawRepresentation:)
  boxPrivateRaw: BOX_JWK.d,
  devPrivateRaw: DEV_JWK.d,
  boxPub: b64u(box.publicRaw),
  boxId: box.id,
  devPub: b64u(dev.publicRaw),
  devId: dev.id,
};

out.framed = {
  input: ['abc', '', 'Grüße', 1792674389],
  framedHex: framed('abc', '', 'Grüße', 1792674389).toString('hex'),
  transcriptHex: transcript('abc', '', 'Grüße', 1792674389).toString('hex'),
};

const challenge = b64u(Buffer.alloc(32, 7));
out.relayAuth = {
  challenge,
  boxDataHex: relayAuthData('box', challenge).toString('hex'),
  boxSig: b64u(box.sign(relayAuthData('box', challenge))),
  deviceDataHex: relayAuthData('device', challenge).toString('hex'),
  deviceSig: b64u(dev.sign(relayAuthData('device', challenge))),
};

out.ticket = issueTicket(box, dev.id, 4102444800);

const secret = Buffer.alloc(32, 0x5a);
out.pairToken = { secret: b64u(secret), token: b64u(pairRelayToken(secret)), tokenHash: pairTokenHash(pairRelayToken(secret)) };

// Handshake gekoppeltes Gerät
{
  const eD = x25519FromSeed(seed(1));
  const eB = x25519FromSeed(seed(2));
  const d = createDeviceHandshake({ boxPublicRaw: box.publicRaw, signer: dev, eph: eD, nonce: nonce(3) });
  const b = createBoxHandshake({ boxSigner: box, lookupDevice: () => dev.publicRaw, eph: eB, nonce: nonce(4) });
  const hs1 = d.hello();
  const hs2 = b.onHs1(hs1);
  const r = d.onHs2(hs2);
  const rb = b.onHs3(r.hs3);
  const p1 = JSON.stringify({ t: 'sub', live: true, intervalMs: 2000 });
  const p2 = JSON.stringify({ t: 'welcome', perms: ['read'] });
  out.deviceHandshake = {
    ephDeviceSeed: b64u(seed(1)), ephBoxSeed: b64u(seed(2)),
    hs1, hs2, hs3: r.hs3,
    transcriptHex: r.th.toString('hex'),
    // Erste Nachricht je Richtung (Zähler 0) und die zweite Gerät→Box (Zähler 1).
    deviceToBox: [
      { plaintext: p1, d: r.session.seal(JSON.parse(p1)) },
      { plaintext: p1, d: r.session.seal(JSON.parse(p1)) },
    ],
    boxToDevice: [{ plaintext: p2, d: rb.session.seal(JSON.parse(p2)) }],
  };
}

// Kopplung
{
  const eD = x25519FromSeed(seed(5));
  const eB = x25519FromSeed(seed(6));
  const d = createPairDevice({ boxPublicRaw: box.publicRaw, secret, signer: dev, eph: eD, nonce: nonce(7) });
  const b = createPairBox({ boxSigner: box, secret, eph: eB, nonce: nonce(8) });
  const p1 = d.hello();
  const { p2, session: bs } = b.onP1(p1);
  const { session: ds, p3, th } = d.onP2(p2, { name: 'Chrissis iPhone', model: 'iPhone Duo' });
  const p3d = ds.seal(p3);
  b.verifyP3(bs.open(p3d));
  const okPlain = JSON.stringify({ t: 'p_wait' });
  out.pairHandshake = {
    secret: b64u(secret), ephDeviceSeed: b64u(seed(5)), ephBoxSeed: b64u(seed(6)),
    p1, p2, transcriptHex: th.toString('hex'),
    p3, p3PlaintextNote: 'p3 enthält eine zufällige Signatur; d entschlüsseln und prüfen',
    p3d,
    boxToDevice: [{ plaintext: okPlain, d: bs.seal(JSON.parse(okPlain)) }],
  };
}

// Briefkasten
{
  const mk = Buffer.alloc(32, 9);
  const obj = { t: 'latest', ts: '2026-10-22T12:00:00.000Z', status: { soc: 55 } };
  out.mailbox = { key: b64u(mk), devId: dev.id, plaintext: JSON.stringify(obj), d: sealMailbox(mk, dev.id, obj) };
}

// Roh-AEAD (für die erste Fehlersuche)
{
  const key = Buffer.alloc(32, 1);
  const n = Buffer.alloc(12, 0);
  out.aead = { key: b64u(key), nonceHex: n.toString('hex'), aadHex: '616164', plaintext: 'hallo', sealedHex: aeadSeal(key, n, Buffer.from('hallo'), Buffer.from('aad')).toString('hex') };
}

out.qrExample = buildPairPayload({
  boxPublicRaw: box.publicRaw, secret, name: 'DVhub Test', lan: ['192.168.1.60:8080', 'dvhub.local'],
  relay: 'wss://relay.dvhub.de/v1/ws', expSec: 4102444800,
});
out.qrExampleParsed = { box: b64u(box.publicRaw), secret: b64u(secret), name: 'DVhub Test', lan: ['ws://192.168.1.60:8080/api/mobile-link/ws', 'ws://dvhub.local/api/mobile-link/ws'], relay: 'wss://relay.dvhub.de/v1/ws', exp: 4102444800 };

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
