// services/tariff-provider/token-cache.js — Token-Zwischenspeicher der
// Anbieter-Abrufe im Datenverzeichnis (0600), gebunden an E-Mail und Passwort.
//
// Damit nicht bei jedem Abruf mit Passwort angemeldet wird, liegen Tokens im
// Datenverzeichnis. Die Datei gilt nur für dieselben Zugangsdaten: E-Mail als
// gekürzter SHA-256, Passwort als PBKDF2 mit eigenem Salz. Mit anderen
// Zugangsdaten (oder nach einem Passwortwechsel) wird sie nicht benutzt.
// Geschrieben wird atomar (Temp-Datei 0600 + rename): Ein Abbruch mitten im
// Schreiben hinterlässt nie ein halbes Token-Paar — wichtig, weil LUOX und
// LichtBlick den Refresh-Token bei jeder Erneuerung rotieren.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(crypto.pbkdf2);

export function emailKey(email) {
  return crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 16);
}

export async function passwordHash(password, saltHex) {
  return (await pbkdf2(String(password), Buffer.from(saltHex, 'hex'), 200_000, 32, 'sha256')).toString('hex');
}

export function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeCache(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(payload));
  } catch (error) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

/** Zwischenspeicher nur, wenn E-Mail und Passwort passen — sonst null. */
export async function loadBoundCache(file, email, password) {
  const raw = readCache(file);
  if (!raw || raw.emailKey !== emailKey(email) || typeof raw.salt !== 'string' || typeof raw.pwHash !== 'string') return null;
  const hash = await passwordHash(password, raw.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(raw.pwHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? raw : null;
}

/** Bindung (emailKey, salt, pwHash) für einen neuen Eintrag; vorhandene Bindung wird übernommen. */
export async function bindingFor(email, password, cached = null) {
  const salt = cached?.salt || crypto.randomBytes(16).toString('hex');
  return {
    emailKey: emailKey(email),
    salt,
    pwHash: cached?.pwHash || await passwordHash(password, salt)
  };
}
