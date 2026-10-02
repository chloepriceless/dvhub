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
import fs from 'node:fs';
import path from 'node:path';
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

// ── Geräte-Tausch (Christin 2026-10-01) ─────────────────────────────────────
// Ein voller Export muss ALLE Schlüssel tragen, damit ein Ersatzgerät ohne
// Neueinrichtung weiterläuft. Neben den Config-Geheimnissen liegen sie in
// Dateien. Nur diese feste Liste wandert mit (relativ zu Daten- bzw.
// Konfigordner); beim Import wird nichts anderes geschrieben.
//   appliance-id          Geräte-Kennung — die Lizenz (Machine-File) ist daran
//                         gebunden, gleiche Identität für Portal/Datenspende
//   license_state.json    Lizenzschlüssel + signiertes Machine-File
//   datenspende.json      API-Schlüssel der Datenspende
//   installer-portal-*    Kopplung mit dem Installateur-Portal
//   input-push-key        Push-Schlüssel HA/Loxone
//   support/*             Schlüssel des Fernwartungs-Relays
//   tls/*                 HTTPS-Zertifikat (keine neue Browser-Warnung)
//   vpn/profiles/**       VPN-Profile, u. a. das des Direktvermarkters
//   eebus/*               EEBUS-Identität (Zertifikat/SKI — die Steuerbox kennt
//                         DVhub nur darüber), Failsafe-Werte, Zählerstände
export const MIGRATION_DATA_FILES = Object.freeze([
  'appliance-id', 'license_state.json', 'datenspende.json',
  'installer-portal-client.json', 'installer-portal-secret', 'input-push-key',
  'support/relay_id_ed25519', 'support/relay_id_ed25519.pub', 'support/known_hosts', 'support/relay.json',
  'eebus/cert.pem', 'eebus/key.pem', 'eebus/grid-state.json', 'eebus/energy.json',
]);
export const MIGRATION_CONFIG_FILES = Object.freeze(['tls/cert.pem', 'tls/key.pem']);
export const MIGRATION_CONFIG_DIRS = Object.freeze(['vpn/profiles']);
const MIGRATION_MAX_FILE_BYTES = 256 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

/** Gehört dieser Bundle-Pfad (data/… oder config/…) zur erlaubten Liste? */
export function isAllowedMigrationFile(rel) {
  const s = String(rel || '');
  const segs = s.split('/');
  if (segs.some((x) => !SAFE_SEGMENT.test(x) || x === '.' || x === '..')) return false;
  if (segs[0] === 'data') return MIGRATION_DATA_FILES.includes(segs.slice(1).join('/'));
  if (segs[0] === 'config') {
    const r = segs.slice(1).join('/');
    return MIGRATION_CONFIG_FILES.includes(r) || MIGRATION_CONFIG_DIRS.some((d) => r.startsWith(`${d}/`));
  }
  return false;
}

function walkFiles(root, rel, fsImpl, out) {
  let entries = [];
  try { entries = fsImpl.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walkFiles(root, r, fsImpl, out);
    else if (e.isFile()) out.push(r);
  }
}

/** Dateien für den Geräte-Tausch einsammeln → { 'data/appliance-id': base64, … }. */
export function collectMigrationFiles({ dataDir, configDir, fsImpl = fs } = {}) {
  const out = {};
  const add = (root, rel, prefix) => {
    if (!root) return;
    try {
      const p = path.join(root, rel);
      const st = fsImpl.statSync(p);
      if (!st.isFile() || st.size > MIGRATION_MAX_FILE_BYTES) return;
      const key = `${prefix}/${rel}`;
      if (isAllowedMigrationFile(key)) out[key] = fsImpl.readFileSync(p).toString('base64');
    } catch { /* fehlt auf dieser Box — kein Fehler */ }
  };
  for (const f of MIGRATION_DATA_FILES) add(dataDir, f, 'data');
  for (const f of MIGRATION_CONFIG_FILES) add(configDir, f, 'config');
  for (const d of MIGRATION_CONFIG_DIRS) {
    const files = [];
    if (configDir) walkFiles(configDir, d, fsImpl, files);
    for (const f of files.sort()) add(configDir, f, 'config');
  }
  return out;
}

/** Dateien aus dem Bundle zurückschreiben (nur erlaubte Pfade, atomar, 0600). */
export function restoreMigrationFiles(files, { dataDir, configDir, fsImpl = fs } = {}) {
  const written = [];
  for (const [key, b64] of Object.entries(files || {})) {
    if (!isAllowedMigrationFile(key) || typeof b64 !== 'string') continue;
    const root = key.startsWith('data/') ? dataDir : configDir;
    if (!root) continue;
    const target = path.join(root, key.slice(key.indexOf('/') + 1));
    if (!path.resolve(target).startsWith(path.resolve(root) + path.sep)) continue;
    fsImpl.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${process.pid}`;
    const mode = /\.(pub|pem)$/.test(target) && !/key\.pem$/.test(target) ? 0o644 : 0o600;
    fsImpl.writeFileSync(tmp, Buffer.from(b64, 'base64'), { mode });
    fsImpl.renameSync(tmp, target);
    written.push(key);
  }
  return written;
}

// Seal the config's secrets under password. Returns a JSON-serialisable blob, or
// null when there is nothing to protect (so callers can skip the field entirely).
// opts.files / opts.apiToken: Geräte-Tausch (siehe oben). Sie liegen im selben
// verschlüsselten Block unter __files / __apiToken; applySecrets ignoriert sie,
// übernommen werden sie nur beim Import mit ausdrücklichem migrate:true.
export function encryptSecrets(config, password, { files = null, apiToken = null } = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password_required');
  }
  const secrets = collectSecrets(config);
  const names = Object.keys(secrets);
  if (files && Object.keys(files).length) { secrets.__files = files; names.push(...Object.keys(files)); }
  if (typeof apiToken === 'string' && apiToken) { secrets.__apiToken = apiToken; names.push('apiToken'); }
  if (names.length === 0) return null;

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
    paths: names
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
