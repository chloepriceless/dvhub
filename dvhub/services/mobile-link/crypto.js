// services/mobile-link/crypto.js — Ende-zu-Ende-Verschlüsselung zwischen
// DVhub und gekoppelten Handys (Chrissi 22.10.2026).
//
// Das Relay (relay.dvhub.de oder selbst gehostet) sieht nur Chiffretext. Die
// Schlüssel tauschen Box und Handy ausschließlich über den QR-Code aus. Alles
// hier muss die iPhone-App bit-genau nachbauen (CryptoKit) — die Beschreibung
// steht in docs/HANDY-APP-PROTOKOLL.md, die Prüfwerte in
// test/fixtures/mobile-link-vectors.json.
//
// Bausteine (nur node:crypto, keine Zusatzpakete):
//   Identität   ECDSA P-256 / SHA-256, Signatur roh r||s (64 Byte), öffentlicher
//               Schlüssel unkomprimiert (65 Byte, 0x04||X||Y). Auf dem iPhone
//               liegt der private Schlüssel in der Secure Enclave (nur P-256).
//   Sitzung     X25519 (je Verbindung frisch → Vorwärtssicherheit), HKDF-SHA256,
//               ChaCha20-Poly1305 mit Zähler-Nonce (4 Null-Byte || u64 BE).
//   Protokoll   Feldfolge mit Längenpräfix (u16 BE) → SHA-256 („Transkript“).

import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 1;
const TAG_LEN = 16;
const MAX_FIELD = 0xffff;

// ── Kodierung ───────────────────────────────────────────────────────────────

const B64U_RE = /^[A-Za-z0-9_-]*$/;

export function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

// Strikt: nur das base64url-Alphabet, keine Füllzeichen, exakte Länge optional.
export function fromB64u(str, expectLen = null) {
  if (typeof str !== 'string' || !B64U_RE.test(str) || str.length % 4 === 1) throw new Error('bad_b64u');
  const buf = Buffer.from(str, 'base64url');
  if (b64u(buf) !== str) throw new Error('bad_b64u');
  if (expectLen != null && buf.length !== expectLen) throw new Error('bad_length');
  return buf;
}

function bytes(part) {
  if (Buffer.isBuffer(part)) return part;
  if (part instanceof Uint8Array) return Buffer.from(part);
  if (typeof part === 'string') return Buffer.from(part, 'utf8');
  if (typeof part === 'number' && Number.isSafeInteger(part)) return Buffer.from(String(part), 'utf8');
  throw new TypeError('transcript: unbekannter Feldtyp');
}

// Jedes Feld mit 2-Byte-Länge davor — eindeutig, egal was in den Feldern steht.
export function framed(...parts) {
  const out = [];
  for (const p of parts) {
    const b = bytes(p);
    if (b.length > MAX_FIELD) throw new Error('field_too_long');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    out.push(len, b);
  }
  return Buffer.concat(out);
}

export function transcript(...parts) {
  return crypto.createHash('sha256').update(framed(...parts)).digest();
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

// ── Identitäten (P-256) ─────────────────────────────────────────────────────

export function importP256Public(raw) {
  const b = Buffer.isBuffer(raw) ? raw : fromB64u(raw, 65);
  if (b.length !== 65 || b[0] !== 0x04) throw new Error('bad_public_key');
  // createPublicKey prüft, dass der Punkt auf der Kurve liegt.
  try {
    return crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64u(b.subarray(1, 33)), y: b64u(b.subarray(33, 65)) },
      format: 'jwk',
    });
  } catch {
    throw new Error('bad_public_key');
  }
}

export function p256PublicRaw(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([0x04]), fromB64u(jwk.x, 32), fromB64u(jwk.y, 32)]);
}

// Kurz-ID aus dem öffentlichen Schlüssel: erste 16 Byte von SHA-256, base64url
// (22 Zeichen). Das Relay prüft sie selbst nach — es braucht kein Register.
export function keyId(publicRaw) {
  return b64u(sha256(Buffer.isBuffer(publicRaw) ? publicRaw : fromB64u(publicRaw, 65)).subarray(0, 16));
}

export function signerFromPrivateKey(privateKey) {
  const key = typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
  const publicRaw = p256PublicRaw(crypto.createPublicKey(key));
  return {
    publicRaw,
    id: keyId(publicRaw),
    sign: (data) => crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }),
    exportPem: () => key.export({ format: 'pem', type: 'pkcs8' }),
  };
}

export function generateIdentity() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return signerFromPrivateKey(privateKey);
}

export function verifySig(publicRaw, data, sig) {
  try {
    const s = Buffer.isBuffer(sig) ? sig : fromB64u(sig, 64);
    if (s.length !== 64) return false;
    return crypto.verify('sha256', data, { key: importP256Public(publicRaw), dsaEncoding: 'ieee-p1363' }, s);
  } catch {
    return false;
  }
}

// ── Kurzlebige Schlüssel (X25519) ───────────────────────────────────────────

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export function x25519FromSeed(seed) {
  const s = Buffer.from(seed);
  if (s.length !== 32) throw new Error('bad_seed');
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, s]), format: 'der', type: 'pkcs8' });
  const publicRaw = fromB64u(crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x, 32);
  return { privateKey, publicRaw };
}

export function generateEphemeral() {
  return x25519FromSeed(crypto.randomBytes(32));
}

export function x25519Shared(privateKey, peerRaw) {
  const peer = Buffer.isBuffer(peerRaw) ? peerRaw : fromB64u(peerRaw, 32);
  if (peer.length !== 32) throw new Error('bad_ephemeral');
  let shared;
  try {
    const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(peer) }, format: 'jwk' });
    shared = crypto.diffieHellman({ privateKey, publicKey });
  } catch {
    throw new Error('bad_ephemeral');
  }
  // Punkte kleiner Ordnung liefern lauter Nullen — ablehnen.
  if (shared.every((b) => b === 0)) throw new Error('bad_ephemeral');
  return shared;
}

export function hkdf(ikm, salt, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), len));
}

// ── AEAD ────────────────────────────────────────────────────────────────────

export function aeadSeal(key, nonce, plaintext, aad) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_LEN });
  c.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

export function aeadOpen(key, nonce, sealed, aad) {
  if (sealed.length < TAG_LEN) throw new Error('decrypt_failed');
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_LEN });
  d.setAAD(aad, { plaintextLength: sealed.length - TAG_LEN });
  d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
  try {
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_LEN)), d.final()]);
  } catch {
    throw new Error('decrypt_failed');
  }
}

function counterNonce(n) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(n), 4);
  return nonce;
}

// Verschlüsselte Sitzung: je Richtung eigener Schlüssel und eigener Zähler.
// Die WebSocket-Verbindung liefert in Reihenfolge — ein fehlender, doppelter
// oder vertauschter Rahmen lässt die Entschlüsselung scheitern (kein Replay).
export function createSession({ sendKey, recvKey, aad }) {
  let sendN = 0;
  let recvN = 0;
  return {
    seal(obj) {
      const pt = Buffer.from(JSON.stringify(obj), 'utf8');
      return b64u(aeadSeal(sendKey, counterNonce(sendN++), pt, aad));
    },
    open(d) {
      const pt = aeadOpen(recvKey, counterNonce(recvN), fromB64u(d), aad);
      recvN++;
      return JSON.parse(pt.toString('utf8'));
    },
  };
}

function sessionKeys(ikm, salt, info) {
  const okm = hkdf(ikm, salt, info, 64);
  return { d2b: okm.subarray(0, 32), b2d: okm.subarray(32, 64) };
}

// ── Relay-Anmeldung und Ticket ──────────────────────────────────────────────

export const RELAY_AUTH_LABEL = 'dvhub-relay-auth-v1';
export const TICKET_LABEL = 'dvhub-ticket-v1';

export function relayAuthData(role, challenge) {
  return framed(RELAY_AUTH_LABEL, role, fromB64u(challenge, 32));
}

// Ticket: von der Box unterschrieben, „Gerät <dev> darf in meinen Kanal“. Das
// Relay prüft es ohne eigene Datenhaltung; gesperrte Geräte sortiert die Box
// über ihre Freigabeliste aus, solange sie verbunden ist.
export function issueTicket(boxSigner, devId, expSec) {
  const sig = boxSigner.sign(framed(TICKET_LABEL, boxSigner.id, devId, expSec));
  return { v: 1, box: b64u(boxSigner.publicRaw), dev: devId, exp: expSec, sig: b64u(sig) };
}

export function verifyTicket(ticket, nowSec) {
  if (!ticket || ticket.v !== 1 || typeof ticket.dev !== 'string' || !Number.isSafeInteger(ticket.exp)) return null;
  let boxPub;
  try { boxPub = fromB64u(ticket.box, 65); } catch { return null; }
  const boxId = keyId(boxPub);
  if (!verifySig(boxPub, framed(TICKET_LABEL, boxId, ticket.dev, ticket.exp), ticket.sig)) return null;
  if (ticket.exp <= nowSec) return null;
  return { boxId, devId: ticket.dev };
}

// Kopplungs-Token für das Relay: aus dem QR-Geheimnis abgeleitet, das Relay
// bekommt nur seinen Hash. Wer den QR-Code nicht hat, kommt nicht in den Kanal.
export function pairRelayToken(secret) {
  return hkdf(secret, Buffer.alloc(0), 'dvhub-link-pair-token-v1', 32);
}

export function pairTokenHash(token) {
  return b64u(sha256(token));
}

// ── Handshake Gerät ↔ Box (gekoppeltes Gerät) ───────────────────────────────

const HS_LABEL = 'dvhub-link-hs-v1';
const HS_KEYS = 'dvhub-link-keys-v1';

function nonce16(n) { return n ? Buffer.from(n) : crypto.randomBytes(16); }

// Geräteseite. `signer` = { publicRaw, sign(data) } — auf dem iPhone die
// Secure Enclave. `eph`/`nonce` nur für Prüfwerte vorgeben.
export function createDeviceHandshake({ boxPublicRaw, signer, eph = null, nonce = null }) {
  const e = eph || generateEphemeral();
  const n = nonce16(nonce);
  let done = false;
  return {
    hello() {
      return { t: 'hs1', v: PROTOCOL_VERSION, dev: keyId(signer.publicRaw), e: b64u(e.publicRaw), n: b64u(n) };
    },
    onHs2(msg) {
      if (done) throw new Error('handshake_state');
      if (!msg || msg.t !== 'hs2') throw new Error('handshake_unexpected');
      const eB = fromB64u(msg.e, 32);
      const nB = fromB64u(msg.n, 16);
      const th = transcript(HS_LABEL, boxPublicRaw, signer.publicRaw, e.publicRaw, n, eB, nB);
      if (!verifySig(boxPublicRaw, th, msg.sig)) throw new Error('box_signature_invalid');
      const keys = sessionKeys(x25519Shared(e.privateKey, eB), th, HS_KEYS);
      done = true;
      return {
        hs3: { t: 'hs3', sig: b64u(signer.sign(transcript(th, 'client'))) },
        session: createSession({ sendKey: keys.d2b, recvKey: keys.b2d, aad: th }),
        th,
      };
    },
  };
}

// Boxseite. `lookupDevice(devId)` → öffentlicher Schlüssel (65 Byte) oder null.
export function createBoxHandshake({ boxSigner, lookupDevice, eph = null, nonce = null }) {
  let pending = null;
  return {
    onHs1(msg) {
      if (pending) throw new Error('handshake_state');
      if (!msg || msg.t !== 'hs1') throw new Error('handshake_unexpected');
      if (msg.v !== PROTOCOL_VERSION) throw new Error('version_unsupported');
      const devPub = typeof msg.dev === 'string' ? lookupDevice(msg.dev) : null;
      if (!devPub) throw new Error('unknown_device');
      const eD = fromB64u(msg.e, 32);
      const nD = fromB64u(msg.n, 16);
      const e = eph || generateEphemeral();
      const n = nonce16(nonce);
      const th = transcript(HS_LABEL, boxSigner.publicRaw, devPub, eD, nD, e.publicRaw, n);
      const keys = sessionKeys(x25519Shared(e.privateKey, eD), th, HS_KEYS);
      pending = { devId: msg.dev, devPub, th, keys };
      return { t: 'hs2', e: b64u(e.publicRaw), n: b64u(n), sig: b64u(boxSigner.sign(th)) };
    },
    onHs3(msg) {
      if (!pending || pending.done) throw new Error('handshake_state');
      if (!msg || msg.t !== 'hs3') throw new Error('handshake_unexpected');
      if (!verifySig(pending.devPub, transcript(pending.th, 'client'), msg.sig)) throw new Error('device_signature_invalid');
      pending.done = true;
      return {
        devId: pending.devId,
        session: createSession({ sendKey: pending.keys.b2d, recvKey: pending.keys.d2b, aad: pending.th }),
        th: pending.th,
      };
    },
  };
}

// ── Kopplung per QR-Geheimnis ───────────────────────────────────────────────
//
// Das 32-Byte-Geheimnis aus dem QR-Code fließt in den Schlüssel ein (HMAC als
// HKDF-Salt): Nur wer den Code gescannt hat, kann mitlesen oder antworten. Die
// Box unterschreibt zusätzlich mit ihrem Schlüssel aus dem QR-Code; das Gerät
// beweist mit seiner Signatur, dass es den neuen Schlüssel besitzt.

const PAIR_LABEL = 'dvhub-link-pair-v1';
const PAIR_KEYS = 'dvhub-link-pair-keys-v1';

function pairSalt(secret, th) {
  return crypto.createHmac('sha256', secret).update(th).digest();
}

export function createPairDevice({ boxPublicRaw, secret, signer, eph = null, nonce = null }) {
  const e = eph || generateEphemeral();
  const n = nonce16(nonce);
  let done = false;
  return {
    hello() {
      return { t: 'p1', v: PROTOCOL_VERSION, e: b64u(e.publicRaw), n: b64u(n) };
    },
    // Liefert die Sitzung; die erste verschlüsselte Nachricht ist `p3`.
    onP2(msg, { name = '', model = '' } = {}) {
      if (done) throw new Error('handshake_state');
      if (!msg || msg.t !== 'p2') throw new Error('handshake_unexpected');
      const eB = fromB64u(msg.e, 32);
      const nB = fromB64u(msg.n, 16);
      const th = transcript(PAIR_LABEL, boxPublicRaw, e.publicRaw, n, eB, nB);
      if (!verifySig(boxPublicRaw, th, msg.sig)) throw new Error('box_signature_invalid');
      const keys = sessionKeys(x25519Shared(e.privateKey, eB), pairSalt(secret, th), PAIR_KEYS);
      done = true;
      const session = createSession({ sendKey: keys.d2b, recvKey: keys.b2d, aad: th });
      const p3 = {
        t: 'p3',
        pub: b64u(signer.publicRaw),
        sig: b64u(signer.sign(transcript(th, 'pair-client'))),
        name: String(name).slice(0, 64),
        model: String(model).slice(0, 64),
      };
      return { session, p3, th };
    },
  };
}

export function createPairBox({ boxSigner, secret, eph = null, nonce = null }) {
  let state = null;
  return {
    onP1(msg) {
      if (state) throw new Error('handshake_state');
      if (!msg || msg.t !== 'p1') throw new Error('handshake_unexpected');
      if (msg.v !== PROTOCOL_VERSION) throw new Error('version_unsupported');
      const eD = fromB64u(msg.e, 32);
      const nD = fromB64u(msg.n, 16);
      const e = eph || generateEphemeral();
      const n = nonce16(nonce);
      const th = transcript(PAIR_LABEL, boxSigner.publicRaw, eD, nD, e.publicRaw, n);
      const keys = sessionKeys(x25519Shared(e.privateKey, eD), pairSalt(secret, th), PAIR_KEYS);
      state = { th, session: createSession({ sendKey: keys.b2d, recvKey: keys.d2b, aad: th }) };
      return { p2: { t: 'p2', e: b64u(e.publicRaw), n: b64u(n), sig: b64u(boxSigner.sign(th)) }, session: state.session };
    },
    // Prüft die entschlüsselte p3-Nachricht → { devId, devPub, name, model }.
    verifyP3(msg) {
      if (!state) throw new Error('handshake_state');
      if (!msg || msg.t !== 'p3') throw new Error('handshake_unexpected');
      const devPub = fromB64u(msg.pub, 65);
      importP256Public(devPub);
      if (!verifySig(devPub, transcript(state.th, 'pair-client'), msg.sig)) throw new Error('device_signature_invalid');
      return {
        devId: keyId(devPub),
        devPub,
        name: typeof msg.name === 'string' ? msg.name.slice(0, 64) : '',
        model: typeof msg.model === 'string' ? msg.model.slice(0, 64) : '',
      };
    },
  };
}

// ── Briefkasten (Puffer am Relay, solange das Handy nicht verbunden ist) ────
//
// Eigener, bei der Kopplung übergebener Schlüssel je Gerät; Zufalls-Nonce
// (12 Byte) vorne an. Das Relay hält diese Blöcke nur im Arbeitsspeicher.

const MBOX_LABEL = 'dvhub-mbox-v1';

export function sealMailbox(key, devId, obj) {
  const nonce = crypto.randomBytes(12);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  return b64u(Buffer.concat([nonce, aeadSeal(key, nonce, pt, framed(MBOX_LABEL, devId))]));
}

export function openMailbox(key, devId, d) {
  const buf = fromB64u(d);
  if (buf.length < 12 + TAG_LEN) throw new Error('decrypt_failed');
  const pt = aeadOpen(key, buf.subarray(0, 12), buf.subarray(12), framed(MBOX_LABEL, devId));
  return JSON.parse(pt.toString('utf8'));
}
