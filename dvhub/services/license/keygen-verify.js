// services/license/keygen-verify.js — Hardening B (2026-06-22).
//
// Offline cryptographic verification of a Keygen "signed key" (scheme
// ED25519_SIGN) against the account's Ed25519 public key. This makes a
// hand-tampered license_state.json useless: without a key whose signature
// verifies against the embedded account public key, the licence is rejected —
// and it works fully OFFLINE (no Keygen round-trip required).
//
// Keygen signed-key format (verified against the live prod key, 2026-06-22):
//   key/{base64url(payload)}.{base64(signature)}
//   - The signature is computed by Keygen over the UTF-8 bytes of the ENTIRE
//     first segment INCLUDING the "key/" prefix, i.e. the string
//     `key/{base64url(payload)}` (everything before the final ".").
//   - signature = 64 raw Ed25519 bytes, base64-encoded (88 chars incl. padding).
//   - payload = base64url(JSON dataset). We do NOT need to decode it to verify
//     the signature; decodeKeygenPayload() is provided for claim inspection
//     (expiry etc.) once the signature is trusted.
//
// Docs: https://keygen.sh/docs/api/cryptography/#cryptographic-keys (ED25519_SIGN)

import crypto from 'node:crypto';

// DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key.
// (RFC 8410 — AlgorithmIdentifier {id-Ed25519} + BIT STRING header.)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Build a Node KeyObject from a raw Ed25519 public key supplied as hex,
 * base64/base64url, or a 32-byte Buffer. Returns null on any malformed input.
 * @param {string|Buffer} raw
 * @returns {import('node:crypto').KeyObject|null}
 */
export function toEd25519PublicKey(raw) {
  try {
    let bytes;
    if (Buffer.isBuffer(raw)) {
      bytes = raw;
    } else if (typeof raw === 'string') {
      const s = raw.trim();
      if (/^[0-9a-fA-F]{64}$/.test(s)) {
        bytes = Buffer.from(s, 'hex');
      } else {
        // base64 or base64url
        bytes = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      }
    } else {
      return null;
    }
    if (bytes.length !== 32) return null;
    const der = Buffer.concat([ED25519_SPKI_PREFIX, bytes]);
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/**
 * Verify a Keygen signed key against the account Ed25519 public key, offline.
 *
 * @param {string} signedKey - the full `key/{payload}.{signature}` string
 * @param {string|Buffer} publicKeyRaw - raw Ed25519 public key (hex/base64/Buffer)
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyKeygenSignedKey(signedKey, publicKeyRaw) {
  if (typeof signedKey !== 'string' || !signedKey.startsWith('key/')) {
    return { valid: false, reason: 'format_prefix' };
  }
  const dotIdx = signedKey.lastIndexOf('.');
  if (dotIdx <= 4) {
    return { valid: false, reason: 'format_no_signature' };
  }
  const signingData = signedKey.slice(0, dotIdx); // "key/{payload}" — signed verbatim
  const sigSegment = signedKey.slice(dotIdx + 1);

  let signature;
  try {
    signature = Buffer.from(sigSegment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return { valid: false, reason: 'signature_decode' };
  }
  if (signature.length !== 64) {
    return { valid: false, reason: 'signature_length' };
  }

  const pub = toEd25519PublicKey(publicKeyRaw);
  if (!pub) return { valid: false, reason: 'public_key' };

  let ok = false;
  try {
    // algorithm = null → Ed25519 (Node treats the digest as part of the alg).
    ok = crypto.verify(null, Buffer.from(signingData, 'utf8'), pub, signature);
  } catch {
    return { valid: false, reason: 'verify_error' };
  }
  return { valid: ok };
}

/**
 * Decode the base64url payload of a (trusted) signed key into its JSON dataset.
 * Only meaningful AFTER verifyKeygenSignedKey() returned valid:true.
 * @param {string} signedKey
 * @returns {object|null}
 */
export function decodeKeygenPayload(signedKey) {
  try {
    if (typeof signedKey !== 'string' || !signedKey.startsWith('key/')) return null;
    const dotIdx = signedKey.lastIndexOf('.');
    const payloadB64 = signedKey.slice(4, dotIdx > 4 ? dotIdx : undefined);
    const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
