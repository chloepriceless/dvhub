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
  decodeKeygenPayload,
  verifyKeygenMachineFile,
  readApplianceId
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

// --- Hardening C: offline machine-file verification (node-lock) --------------

function mintMachineFile(privateKey, fingerprint, { prefix = 'machine', banner = 'MACHINE FILE', alg = 'base64+ed25519' } = {}) {
  const dataset = {
    data: { type: 'machines', id: 'm1', attributes: { fingerprint } },
    included: [{ type: 'licenses', id: 'lic-1' }],
    meta: { expiry: null }
  };
  const enc = Buffer.from(JSON.stringify(dataset), 'utf8').toString('base64');
  const sig = crypto.sign(null, Buffer.from(`${prefix}/${enc}`, 'utf8'), privateKey).toString('base64');
  const inner = Buffer.from(JSON.stringify({ enc, sig, alg }), 'utf8').toString('base64');
  const wrapped = inner.replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${banner}-----\n${wrapped}\n-----END ${banner}-----\n`;
}

test('verifyKeygenMachineFile: accepts a correctly signed file + extracts fingerprint', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const file = mintMachineFile(privateKey, 'box-7');
  const res = verifyKeygenMachineFile(file, rawPubHex(publicKey));
  assert.equal(res.valid, true, res.reason);
  assert.equal(res.fingerprint, 'box-7');
  assert.equal(res.licenseId, 'lic-1');
  assert.equal(res.expiry, null);
});

test('verifyKeygenMachineFile: rejects a tampered dataset (signature no longer matches)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const file = mintMachineFile(privateKey, 'box-7');
  // Flip the bound fingerprint inside enc without re-signing.
  const inner = JSON.parse(Buffer.from(file.replace(/-----[^-]*-----/g, '').replace(/\s+/g, ''), 'base64').toString('utf8'));
  const ds = JSON.parse(Buffer.from(inner.enc, 'base64').toString('utf8'));
  ds.data.attributes.fingerprint = 'HACKED-BOX';
  inner.enc = Buffer.from(JSON.stringify(ds), 'utf8').toString('base64');
  const forged = `-----BEGIN MACHINE FILE-----\n${Buffer.from(JSON.stringify(inner), 'utf8').toString('base64')}\n-----END MACHINE FILE-----`;
  assert.equal(verifyKeygenMachineFile(forged, rawPubHex(publicKey)).valid, false);
});

test('verifyKeygenMachineFile: rejects the WRONG public key', () => {
  const a = crypto.generateKeyPairSync('ed25519');
  const b = crypto.generateKeyPairSync('ed25519');
  const file = mintMachineFile(a.privateKey, 'box-7');
  assert.equal(verifyKeygenMachineFile(file, rawPubHex(b.publicKey)).valid, false);
});

test('verifyKeygenMachineFile: rejects an unsupported algorithm', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const file = mintMachineFile(privateKey, 'box-7', { alg: 'aes-256-gcm+ed25519' });
  assert.equal(verifyKeygenMachineFile(file, rawPubHex(publicKey)).reason, 'alg_unsupported');
});

test('verifyKeygenMachineFile: rejects malformed / empty / non-string input', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = rawPubHex(publicKey);
  assert.equal(verifyKeygenMachineFile('', pub).valid, false);
  assert.equal(verifyKeygenMachineFile('-----BEGIN MACHINE FILE-----\nnotbase64json\n-----END MACHINE FILE-----', pub).valid, false);
  assert.equal(verifyKeygenMachineFile(null, pub).valid, false);
  assert.equal(verifyKeygenMachineFile(42, pub).valid, false);
});

test('verifyKeygenMachineFile: a license-file prefix verifies under opts.prefix', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const file = mintMachineFile(privateKey, 'box-7', { prefix: 'license', banner: 'LICENSE FILE' });
  assert.equal(verifyKeygenMachineFile(file, rawPubHex(publicKey), { prefix: 'license' }).valid, true);
  // …and FAILS if checked with the default 'machine' prefix (cross-type confusion guard).
  assert.equal(verifyKeygenMachineFile(file, rawPubHex(publicKey)).valid, false);
});

test('readApplianceId: reads + lowercases a valid id, null on absent/malformed', () => {
  const fakeFs = (content) => ({ readFileSync: () => { if (content == null) throw new Error('ENOENT'); return content; } });
  assert.equal(readApplianceId('/x', fakeFs('A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D\n')), 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
  assert.equal(readApplianceId('/x', fakeFs('  box-7  ')), 'box-7');
  assert.equal(readApplianceId('/x', fakeFs('not a valid id!')), null);
  assert.equal(readApplianceId('/x', fakeFs('a'.repeat(37))), null);
  assert.equal(readApplianceId('/x', fakeFs(null)), null);
});
