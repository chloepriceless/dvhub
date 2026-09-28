// installer-portal/test/security.test.js — TOTP + WebAuthn (Zero-Dep-Module)
//
// Der "Authenticator" wird hier simuliert: EC-P256-Key, clientDataJSON,
// authenticatorData und Signatur werden exakt nach Spec zusammengebaut.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { randomSecret, totp, totpVerify, totpMatchStep, base32Decode, otpauthUri } from '../totp.js';
import { verifyRegistration, verifyAssertion, bufB64url, b64urlBuf, cborDecode, parseAuthData, coseToKey } from '../webauthn.js';
import { makeAuthenticator as makeFakeAuthenticator } from './fake-auth.js';

// ---------- minimaler CBOR-Encoder (nur was der Test braucht) ----------
const enc = (v) => {
  const head = (mt, n) => n < 24 ? Buffer.concat([Buffer.from([(mt << 5) | n])])
    : n < 256 ? Buffer.concat([Buffer.from([(mt << 5) | 24, n])])
    : Buffer.concat([Buffer.from([(mt << 5) | 25]), Buffer.from([n >> 8, n & 0xff])]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(enc)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]);
  throw new Error('enc: ' + typeof v);
};

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ---------- TOTP ----------
test('TOTP: RFC-6238-Testvektor', () => {
  // ASCII "12345678901234567890" als Base32
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1_111_111_109_000), '081804');
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1_234_567_890_000), '005924');
});

test('TOTP: Secret/Roundtrip/Verifikation', () => {
  const s = randomSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.ok(base32Decode(s).length === 20);
  const code = totp(s);
  assert.equal(code.length, 6);
  assert.ok(totpVerify(s, code));
  // ±1 Schritt Toleranz
  assert.ok(totpVerify(s, totp(s, Date.now() - 30_000)));
  assert.ok(totpVerify(s, totp(s, Date.now() + 30_000)));
  // 2 Schritte daneben -> abgelehnt (window=1)
  assert.ok(!totpVerify(s, totp(s, Date.now() + 120_000)));
  assert.ok(!totpVerify(s, 'abc123'));
  assert.ok(!totpVerify(s, '12345'));
  assert.ok(!totpVerify('kein-base32!!', '123456'));
});

test('TOTP: Timing-safe gegen falsche Laenge, otpauth-URI', () => {
  const s = randomSecret();
  assert.ok(!totpVerify(s, '12345678')); // zu lang, kein Crash
  const uri = otpauthUri({ secret: s, accountName: 'christin@example.com' });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.ok(uri.includes(`secret=${s}`));
});

// ---------- WebAuthn-Authenticator-Simulation ----------
function makeAuthenticator(rpId = 'localhost') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]);
  const credId = crypto.randomBytes(16);
  const rpIdHash = sha256(Buffer.from(rpId, 'utf8'));
  let counter = 0;

  const authData = (withCred) => {
    const flags = 0x01 | 0x04 | (withCred ? 0x40 : 0); // UP | UV | AT
    const base = Buffer.concat([rpIdHash, Buffer.from([flags]), Buffer.from([0, 0, 0, ++counter])]);
    if (!withCred) return base;
    const aaguid = Buffer.alloc(16);
    const cidLen = Buffer.alloc(2);
    cidLen.writeUInt16BE(credId.length);
    return Buffer.concat([base, aaguid, cidLen, credId, enc(cose)]);
  };
  return {
    signCount: () => counter,
    create(Origin, challenge) {
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: Origin }), 'utf8');
      const attObj = enc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(true)]]));
      return {
        id: bufB64url(credId),
        rawId: bufB64url(credId),
        response: { clientDataJSON: bufB64url(cd), attestationObject: bufB64url(attObj) },
      };
    },
    get(Origin, challenge) {
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: Origin }), 'utf8');
      const ad = authData(false);
      const sig = crypto.sign('sha256', Buffer.concat([ad, sha256(cd)]), privateKey);
      return {
        id: bufB64url(credId),
        rawId: bufB64url(credId),
        response: { clientDataJSON: bufB64url(cd), authenticatorData: bufB64url(ad), signature: bufB64url(sig) },
      };
    },
  };
}

const RP_HASH = sha256(Buffer.from('localhost')).toString('hex');

test('WebAuthn: Registrierung + Assertion (Happy Path)', () => {
  const auth = makeAuthenticator();
  const origin = 'http://localhost:8700';
  const ch = 'chall-123';
  const c = auth.create(origin, ch);
  const reg = verifyRegistration({
    attestationObject: c.response.attestationObject,
    clientDataJSON: c.response.clientDataJSON,
    expectedChallenge: ch, expectedOrigin: origin, expectedRpIdHash: RP_HASH,
  });
  assert.ok(reg.id && reg.publicKey && reg.algorithm === -7);

  const ch2 = 'chall-456';
  const a = auth.get(origin, ch2);
  const res = verifyAssertion({
    authenticatorData: a.response.authenticatorData,
    clientDataJSON: a.response.clientDataJSON,
    signature: a.response.signature,
    expectedChallenge: ch2, expectedOrigin: origin, expectedRpIdHash: RP_HASH,
    credential: { publicKey: reg.publicKey },
  });
  assert.ok(res.counter > 0);
});

test('WebAuthn: manipulierte Werte fliegen raus', () => {
  const auth = makeAuthenticator();
  const origin = 'http://localhost:8700';
  const c = auth.create(origin, 'ch1');
  const reg = verifyRegistration({
    attestationObject: c.response.attestationObject, clientDataJSON: c.response.clientDataJSON,
    expectedChallenge: 'ch1', expectedOrigin: origin, expectedRpIdHash: RP_HASH,
  });
  // falsche Challenge
  assert.throws(() => verifyRegistration({
    attestationObject: c.response.attestationObject, clientDataJSON: c.response.clientDataJSON,
    expectedChallenge: 'anderes', expectedOrigin: origin, expectedRpIdHash: RP_HASH,
  }), /clientdata_challenge/);
  // fremder Origin
  assert.throws(() => verifyRegistration({
    attestationObject: c.response.attestationObject, clientDataJSON: c.response.clientDataJSON,
    expectedChallenge: 'ch1', expectedOrigin: 'http://evil.test', expectedRpIdHash: RP_HASH,
  }), /clientdata_origin/);
  // falsche rpIdHash
  assert.throws(() => verifyRegistration({
    attestationObject: c.response.attestationObject, clientDataJSON: c.response.clientDataJSON,
    expectedChallenge: 'ch1', expectedOrigin: origin, expectedRpIdHash: 'ff'.repeat(32),
  }), /rpid_hash/);

  // Assertion mit fremdem Key -> Signaturfehler
  const a = auth.get(origin, 'ch2');
  const foreign = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const fj = foreign.publicKey.export({ format: 'jwk' });
  const bogusPk = enc(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(fj.x, 'base64url')], [-3, Buffer.from(fj.y, 'base64url')],
  ])).toString('base64');
  assert.throws(() => verifyAssertion({
    authenticatorData: a.response.authenticatorData, clientDataJSON: a.response.clientDataJSON,
    signature: a.response.signature, expectedChallenge: 'ch2', expectedOrigin: origin,
    expectedRpIdHash: RP_HASH, credential: { publicKey: bogusPk },
  }), /signatur_ungueltig/);
  // falsche Challenge in der Assertion
  assert.throws(() => verifyAssertion({
    authenticatorData: a.response.authenticatorData, clientDataJSON: a.response.clientDataJSON,
    signature: a.response.signature, expectedChallenge: 'nope', expectedOrigin: origin,
    expectedRpIdHash: RP_HASH, credential: { publicKey: reg.publicKey },
  }), /clientdata_challenge/);
});

test('WebAuthn: andere Kurven als P-256 werden abgelehnt', () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const j = publicKey.export({ format: 'jwk' });
  const m = new Map([[1, 2], [3, -35], [-1, 2], [-2, Buffer.from(j.x, 'base64url')], [-3, Buffer.from(j.y, 'base64url')]]);
  assert.throws(() => coseToKey(m), /nur_EC2_P256_unterstuetzt/);
});

test('WebAuthn: requireUV lehnt Assertion ohne Nutzer-Verifikation ab', () => {
  const origin = 'http://localhost:8700';
  for (const uv of [false, true]) {
    const auth = makeFakeAuthenticator('localhost', { uv });
    const c = auth.create(origin, 'reg-ch');
    const reg = verifyRegistration({
      attestationObject: c.response.attestationObject, clientDataJSON: c.response.clientDataJSON,
      expectedChallenge: 'reg-ch', expectedOrigin: origin, expectedRpIdHash: RP_HASH,
    });
    const a = auth.get(origin, 'login-ch');
    const args = {
      authenticatorData: a.response.authenticatorData, clientDataJSON: a.response.clientDataJSON,
      signature: a.response.signature, expectedChallenge: 'login-ch', expectedOrigin: origin,
      expectedRpIdHash: RP_HASH, credential: { publicKey: reg.publicKey },
    };
    // ohne requireUV (2. Faktor) geht beides
    assert.ok(verifyAssertion(args).counter > 0);
    if (uv) assert.ok(verifyAssertion({ ...args, requireUV: true }).counter > 0);
    else assert.throws(() => verifyAssertion({ ...args, requireUV: true }), /uv_fehlt/);
  }
});

test('TOTP: totpMatchStep liefert den getroffenen Zeitschritt (±1 Fenster)', () => {
  const secret = randomSecret();
  const at = Date.parse('2026-09-28T12:00:10Z');
  const base = Math.floor(at / 30_000);
  assert.equal(totpMatchStep(secret, totp(secret, at), at), base);
  assert.equal(totpMatchStep(secret, totp(secret, at - 30_000), at), base - 1);
  assert.equal(totpMatchStep(secret, totp(secret, at + 30_000), at), base + 1);
  assert.equal(totpMatchStep(secret, totp(secret, at + 90_000), at), null);
  assert.equal(totpMatchStep(secret, 'abcdef', at), null);
});

test('WebAuthn: Credential-ID über 1023 Byte wird bei der Registrierung abgelehnt', () => {
  const origin = 'http://localhost:8700';
  const ok = makeFakeAuthenticator('localhost', { credIdBytes: 1023 }).create(origin, 'c');
  assert.ok(verifyRegistration({ attestationObject: ok.response.attestationObject, clientDataJSON: ok.response.clientDataJSON,
    expectedChallenge: 'c', expectedOrigin: origin, expectedRpIdHash: RP_HASH }).id);
  const tooLong = makeFakeAuthenticator('localhost', { credIdBytes: 1024 }).create(origin, 'c');
  assert.throws(() => verifyRegistration({ attestationObject: tooLong.response.attestationObject, clientDataJSON: tooLong.response.clientDataJSON,
    expectedChallenge: 'c', expectedOrigin: origin, expectedRpIdHash: RP_HASH }), /credid_laenge/);
});
