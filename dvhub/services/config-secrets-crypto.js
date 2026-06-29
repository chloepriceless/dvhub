// config-secrets-crypto.js — optional password-protected secrets bundle for the
// config export/import (T-fresh-box-migration).
//
// Problem: the plain config export redacts every REDACTED_PATHS value to '***',
// so importing a prod config onto a FRESH box loses all credentials (forecast
// API keys, DB password, MQTT creds, notification tokens). restoreRedacted can
// only bring back a secret that already exists on the target box — on a fresh
// install there is nothing to restore, so the field stays the literal '***'.
//
// This module lets the operator opt into a portable, encrypted secrets bundle:
//   - encryptSecrets(config, password) collects the real REDACTED_PATHS values
//     and seals them with AES-256-GCM under a PBKDF2-SHA256(password) key.
//   - decryptSecrets(blob, password) returns the {path: value} map or throws
//     'invalid_password' (GCM auth-tag mismatch ⇒ wrong password OR tampering).
//   - applySecrets(config, secrets) writes ONLY known REDACTED_PATHS back into a
//     config clone (an encrypted blob can therefore never inject arbitrary keys).
//
// The password is never stored; it only derives the key in-memory per call.
import crypto from 'node:crypto';
import { REDACTED_PATHS } from '../config-redaction.js';

const VERSION = 1;
// PBKDF2-HMAC-SHA256 work factor. 210k matches the OWASP 2023 recommendation.
const KDF_ITERATIONS = 210000;
const SALT_LEN = 16;
const IV_LEN = 12; // 96-bit nonce — the standard size for AES-GCM
const KEY_LEN = 32; // AES-256

function getPath(obj, dotPath) {
  return dotPath.split('.').reduce(
    (acc, k) => (acc != null && Object.prototype.hasOwnProperty.call(acc, k)) ? acc[k] : undefined,
    obj
  );
}

function setPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let target = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (target[k] == null || typeof target[k] !== 'object') target[k] = {};
    target = target[k];
  }
  target[parts[parts.length - 1]] = value;
}

// Secrets that must NEVER travel in a portable migration bundle. apiToken is the
// TARGET box's own auth token — transplanting the source box's token would lock
// the operator out of the fresh box mid-session (their browser is authenticated
// with the fresh box's own token). restoreRedacted already keeps the box's own
// apiToken, so excluding it here is the safe default.
const PORTABLE_SKIP = new Set(['apiToken']);

// Collect the REAL secret values present in the config (skip missing / empty /
// redaction-placeholder fields and the non-portable apiToken).
export function collectSecrets(config) {
  const out = {};
  for (const path of REDACTED_PATHS) {
    if (PORTABLE_SKIP.has(path)) continue;
    const v = getPath(config, path);
    if (v === undefined || v === null || v === '' || v === '***') continue;
    out[path] = v;
  }
  return out;
}

// Seal the config's secrets under password. Returns a JSON-serialisable blob, or
// null when there is nothing to protect (so callers can skip the field entirely).
export function encryptSecrets(config, password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password_required');
  }
  const secrets = collectSecrets(config);
  if (Object.keys(secrets).length === 0) return null;

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, KDF_ITERATIONS, KEY_LEN, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: VERSION,
    alg: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iter: KDF_ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
    // Path NAMES only (e.g. 'forecast.solcast.apiKey') — not the values. Lets the
    // UI show "what's inside" without decrypting.
    paths: Object.keys(secrets)
  };
}

// Returns the decrypted {path: value} map. Throws 'invalid_password' on a wrong
// password (GCM tag mismatch) and 'unsupported_secrets_format' on a bad blob.
export function decryptSecrets(blob, password) {
  if (!blob || typeof blob !== 'object' || blob.v !== VERSION || blob.alg !== 'aes-256-gcm') {
    throw new Error('unsupported_secrets_format');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password_required');
  }
  let salt; let iv; let tag; let data;
  try {
    salt = Buffer.from(String(blob.salt), 'base64');
    iv = Buffer.from(String(blob.iv), 'base64');
    tag = Buffer.from(String(blob.tag), 'base64');
    data = Buffer.from(String(blob.data), 'base64');
  } catch {
    throw new Error('unsupported_secrets_format');
  }
  const iterations = Number.isInteger(blob.iter) && blob.iter > 0 ? blob.iter : KDF_ITERATIONS;
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, KEY_LEN, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let dec;
  try {
    dec = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    // GCM authentication failed → wrong password or the blob was tampered with.
    throw new Error('invalid_password');
  }
  let parsed;
  try {
    parsed = JSON.parse(dec.toString('utf8'));
  } catch {
    throw new Error('invalid_password');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_password');
  }
  return parsed;
}

// Write decrypted secrets back into a CLONE of config. Only known REDACTED_PATHS
// are restored — a malicious/old blob can never inject arbitrary config keys.
export function applySecrets(config, secrets) {
  const copy = JSON.parse(JSON.stringify(config || {}));
  for (const [path, value] of Object.entries(secrets || {})) {
    if (!REDACTED_PATHS.includes(path)) continue;
    if (value === undefined || value === null) continue;
    setPath(copy, path, value);
  }
  return copy;
}
