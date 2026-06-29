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
import fs from 'node:fs';
import path from 'node:path';

// DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key.
// (RFC 8410 — AlgorithmIdentifier {id-Ed25519} + BIT STRING header.)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Hardening C (node-lock): the only cryptographic certificate algorithm we
// accept for an offline machine file. Allowlisted to prevent a forged file from
// down-negotiating to a weaker/unsigned scheme (Codex finding #10). Keygen emits
// "base64+ed25519" for the ED25519_SIGN cryptographic scheme: the dataset is
// base64-encoded (NOT encrypted) and signed with Ed25519.
const MACHINE_FILE_ALG = 'base64+ed25519';

// appliance-id validation — MUST stay in lock-step with the canonical reader in
// services/support-tunnel.js (APPLIANCE_ID_RE). Duplicated here on purpose so the
// security-critical license verify path stays self-contained and never imports
// the support subsystem at boot.
const APPLIANCE_ID_RE = /^[a-z0-9-]{1,36}$/;

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

// ---------------------------------------------------------------------------
// Hardening C — offline machine-file verification (node-lock)
// ---------------------------------------------------------------------------
//
// A Keygen *machine file* is the offline artifact produced by
// `POST /machines/:id/actions/check-out` (cryptographic ED25519_SIGN scheme).
// It is a PEM-style envelope:
//
//   -----BEGIN MACHINE FILE-----
//   {base64( JSON{ "enc": "...", "sig": "...", "alg": "base64+ed25519" } )}
//   -----END MACHINE FILE-----
//
//   - enc = base64( JSON dataset )                         (NOT encrypted)
//   - sig = base64( Ed25519_sign("machine/" + enc) )       (64 raw bytes)
//   - dataset = JSON:API doc; data.attributes.fingerprint = the bound machine
//     fingerprint (= the DVhub appliance-id), meta.expiry = optional TTL.
//
// The signing prefix is the resource type ("machine/" for machine files,
// "license/" for license files) — Keygen signs `"<type>/<enc>"` verbatim.
//
// ⚠️ The exact field shapes are taken from the Keygen CE docs and MUST be
// re-confirmed against the live license.dvhub.de instance during the activation
// spike (T-0125 Must-Fix #1) before the online check-out flow is built. This
// verifier is pure/offline and is wired in INERT (config-gated, only enforced
// when a machine file is actually present), so it changes no current behavior.
//
// Docs: https://keygen.sh/docs/api/cryptography/#cryptographic-lic (ED25519_SIGN)

/**
 * Verify a Keygen machine file offline against the account Ed25519 public key
 * and extract its bound fingerprint. The signature is checked BEFORE any
 * dataset field is trusted.
 *
 * @param {string} fileContent  - the full "-----BEGIN MACHINE FILE-----…" text
 * @param {string|Buffer} publicKeyRaw - raw Ed25519 public key (hex/base64/Buffer)
 * @param {{ prefix?: 'machine'|'license' }} [opts]
 * @returns {{ valid: boolean, reason?: string, fingerprint?: string|null,
 *            expiry?: string|null, licenseId?: string|null, dataset?: object }}
 */
export function verifyKeygenMachineFile(fileContent, publicKeyRaw, opts = {}) {
  const prefix = opts.prefix || 'machine';
  if (typeof fileContent !== 'string') return { valid: false, reason: 'format_input' };

  // Strip the PEM banners + all whitespace → bare base64 of the cert envelope.
  const stripped = fileContent
    .replace(/-----BEGIN[A-Z ]*-----/g, '')
    .replace(/-----END[A-Z ]*-----/g, '')
    .replace(/\s+/g, '');
  if (!stripped) return { valid: false, reason: 'format_empty' };

  let cert;
  try {
    cert = JSON.parse(Buffer.from(stripped, 'base64').toString('utf8'));
  } catch {
    return { valid: false, reason: 'envelope_decode' };
  }
  if (!cert || typeof cert !== 'object') return { valid: false, reason: 'envelope_shape' };

  const { enc, sig, alg } = cert;
  if (alg !== MACHINE_FILE_ALG) return { valid: false, reason: 'alg_unsupported' };
  if (typeof enc !== 'string' || typeof sig !== 'string') {
    return { valid: false, reason: 'envelope_fields' };
  }

  let signature;
  try {
    signature = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return { valid: false, reason: 'signature_decode' };
  }
  if (signature.length !== 64) return { valid: false, reason: 'signature_length' };

  const pub = toEd25519PublicKey(publicKeyRaw);
  if (!pub) return { valid: false, reason: 'public_key' };

  const signingData = `${prefix}/${enc}`;     // Keygen signs "<type>/<enc>" verbatim
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(signingData, 'utf8'), pub, signature);
  } catch {
    return { valid: false, reason: 'verify_error' };
  }
  if (!ok) return { valid: false, reason: 'signature_mismatch' };

  // Signature trusted → safe to decode + read claims.
  let dataset;
  try {
    dataset = JSON.parse(Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return { valid: false, reason: 'dataset_decode' };
  }

  const fingerprint = dataset?.data?.attributes?.fingerprint ?? null;
  const expiry = dataset?.meta?.expiry ?? dataset?.data?.attributes?.expiry ?? null;
  const licenseId =
    (Array.isArray(dataset?.included)
      ? (dataset.included.find((x) => x?.type === 'licenses')?.id ?? null)
      : null) ??
    dataset?.data?.relationships?.license?.data?.id ??
    null;

  // Tier ceiling (maxKwp) + license kind (e.g. "demo") from the SIGNED dataset.
  // SECURITY: read ONLY from issuer-controlled objects — the `licenses`/`policies`
  // resources in `included` (we set those), NEVER from `data.attributes.metadata`
  // when `data` is the MACHINE (an activator can set machine metadata). For a plain
  // signed license-key, `data` IS the license, so that path is issuer-controlled too.
  // Everything here runs only AFTER the Ed25519 signature verified above → trusted.
  const includedMeta = (type) =>
    (Array.isArray(dataset?.included)
      ? dataset.included.find((x) => x?.type === type)?.attributes?.metadata
      : null) ?? null;
  let metadata = includedMeta('licenses') ?? includedMeta('policies') ?? null;
  if (metadata == null && dataset?.data?.type === 'licenses') {
    metadata = dataset?.data?.attributes?.metadata ?? null;
  }
  const maxKwpRaw = metadata?.maxKwp;
  const maxKwp = (maxKwpRaw == null || maxKwpRaw === '')
    ? null
    : (Number.isFinite(Number(maxKwpRaw)) ? Number(maxKwpRaw) : null);
  const kind = (typeof metadata?.kind === 'string' && metadata.kind) ? metadata.kind : null;

  return { valid: true, fingerprint, expiry, licenseId, maxKwp, kind, dataset };
}

/**
 * Read + validate this host's appliance-id from `${dataDir}/appliance-id`.
 * Returns the lowercased id, or null if the file is absent/malformed. Mirrors
 * services/support-tunnel.js:readApplianceId — kept local so the license verify
 * path has no boot-time dependency on the support subsystem.
 *
 * @param {string} dataDir
 * @param {typeof import('node:fs')} [fsImpl]
 * @returns {string|null}
 */
export function readApplianceId(dataDir, fsImpl = fs) {
  try {
    const raw = String(fsImpl.readFileSync(path.join(dataDir || '.', 'appliance-id'), 'utf8'))
      .trim()
      .toLowerCase();
    return APPLIANCE_ID_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
