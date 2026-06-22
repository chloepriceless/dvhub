// test/keygen-verify.test.js — Hardening B (2026-06-22).
//
// Verifies the offline Ed25519 signed-key verification logic independently of
// the real Keygen account public key, by generating an ephemeral Ed25519
// keypair and building a Keygen-format signed key the same way Keygen does:
//   sign(Ed25519, "key/{base64url(payload)}") -> base64(signature)
//   signedKey = "key/{base64url(payload)}.{base64(signature)}"
//
// Constraint (PROJECT.md): node:test + node:assert/strict ONLY.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  verifyKeygenSignedKey,
  toEd25519PublicKey,
  decodeKeygenPayload
} from '../services/license/keygen-verify.js';

// --- Helpers: mint a Keygen-format signed key with an ephemeral keypair ------

function rawPubHex(publicKey) {
  // last 32 bytes of the DER SPKI encoding = the raw Ed25519 public key
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

function mintSignedKey(privateKey, payloadObj) {
  const payloadB64url = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const signingData = `key/${payloadB64url}`;
  const sig = crypto.sign(null, Buffer.from(signingData, 'utf8'), privateKey);
  return `${signingData}.${sig.toString('base64')}`;
}

// ---------------------------------------------------------------------------

test('verifyKeygenSignedKey: accepts a correctly signed key (hex pubkey)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signedKey = mintSignedKey(privateKey, { lic: 'abc', expiry: null });
  const res = verifyKeygenSignedKey(signedKey, rawPubHex(publicKey));
  assert.equal(res.valid, true, res.reason);
});

test('verifyKeygenSignedKey: accepts with base64 pubkey input too', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signedKey = mintSignedKey(privateKey, { lic: 'abc' });
  const rawB64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  assert.equal(verifyKeygenSignedKey(signedKey, rawB64).valid, true);
});

test('verifyKeygenSignedKey: rejects a tampered payload (same signature)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signedKey = mintSignedKey(privateKey, { lic: 'abc' });
  const sig = signedKey.slice(signedKey.lastIndexOf('.') + 1);
  const forgedPayload = Buffer.from(JSON.stringify({ lic: 'HACKED' }), 'utf8').toString('base64url');
  const forged = `key/${forgedPayload}.${sig}`;
  assert.equal(verifyKeygenSignedKey(forged, rawPubHex(publicKey)).valid, false);
});

test('verifyKeygenSignedKey: rejects when verified against the WRONG public key', () => {
  const a = crypto.generateKeyPairSync('ed25519');
  const b = crypto.generateKeyPairSync('ed25519');
  const signedKey = mintSignedKey(a.privateKey, { lic: 'abc' });
  assert.equal(verifyKeygenSignedKey(signedKey, rawPubHex(b.publicKey)).valid, false);
});

test('verifyKeygenSignedKey: rejects malformed inputs', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = rawPubHex(publicKey);
  assert.equal(verifyKeygenSignedKey('', pub).valid, false);
  assert.equal(verifyKeygenSignedKey('not-a-key', pub).valid, false);
  assert.equal(verifyKeygenSignedKey('key/onlypayloadnodot', pub).valid, false);
  assert.equal(verifyKeygenSignedKey('key/abc.def', pub).valid, false); // bad signature length
  assert.equal(verifyKeygenSignedKey(null, pub).valid, false);
});

test('verifyKeygenSignedKey: rejects a malformed public key', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const signedKey = mintSignedKey(privateKey, { lic: 'abc' });
  assert.equal(verifyKeygenSignedKey(signedKey, 'deadbeef').valid, false); // too short
  assert.equal(toEd25519PublicKey('zz'), null);
});

test('decodeKeygenPayload: round-trips the dataset of a verified key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const payload = { lic: 'abc', scope: { machine: null }, n: 42 };
  const signedKey = mintSignedKey(privateKey, payload);
  assert.equal(verifyKeygenSignedKey(signedKey, rawPubHex(publicKey)).valid, true);
  assert.deepEqual(decodeKeygenPayload(signedKey), payload);
});
