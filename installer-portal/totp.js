// installer-portal/totp.js — RFC 6238 TOTP (Zero-Dependency, nur node:crypto)
// Für die 2FA der Portal-Konten (Google Authenticator/2FAS/Bitwarden & Co.
// sprechen alle dieses Format: HMAC-SHA1, 30-s-Schritt, 6-stellig).

import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function randomSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

export function base32Decode(secret) {
  const s = String(secret || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!s || /[^A-Z2-7]/.test(s)) return null;
  let bits = '';
  for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}

// aktueller Code für Secret + Zeitpunkt (Default: jetzt)
export function totp(secret, at = Date.now(), { step = 30, digits = 6 } = {}) {
  const key = base32Decode(secret);
  if (!key) return null;
  const counter = Math.floor(at / 1000 / step);
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(ctr).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[off] & 0x7f) << 24 | hmac[off + 1] << 16 | hmac[off + 2] << 8 | hmac[off + 3])
    % (10 ** digits);
  return String(code).padStart(digits, '0');
}

// Welcher Zeitschritt (Zähler) passt zum Code? ±window Schritte Toleranz
// (Uhrzeit-Drift), timingSafe und ohne frühen Abbruch — kein Timing-Leak
// über die Position im Fenster. Gibt die Schritt-Nummer oder null zurück;
// der Aufrufer merkt sich den letzten benutzten Schritt (Replay-Schutz).
export function totpMatchStep(secret, code, at = Date.now(), { step = 30, digits = 6, window = 1 } = {}) {
  const want = String(code || '').trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(want)) return null;
  const base = Math.floor(at / 1000 / step);
  let match = null;
  for (let w = -window; w <= window; w++) {
    const c = totp(secret, at + w * step * 1000, { step, digits });
    if (c && c.length === want.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(want))) match = base + w;
  }
  return match;
}

export function totpVerify(secret, code, at = Date.now(), opts = {}) {
  return totpMatchStep(secret, code, at, opts) !== null;
}

export function otpauthUri({ secret, accountName, issuer = 'DVhub Portal' }) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`
    + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6`;
}
