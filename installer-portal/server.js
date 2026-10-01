#!/usr/bin/env node
// installer-portal/server.js — Installateurs-Portal (lokaler Aufbau)
//
// Zero-Dependency Node-App (nur node:Builtins + openssl fürs Keygen), damit es
// exakt so einfach läuft wie DVhub selbst:  node server.js  →  http://localhost:8700
//
// Was das Portal tut:
//   1. Installateur-Konto anlegen → Key-Paar (Ed25519) + self-signiertes
//      X.509-Zertifikat werden HIER erzeugt; der Private Key verlässt das
//      Portal niemals (weder ins dvhub-Passwort noch zu DVhub).
//   2. Anlage koppeln → POST <dvhub>/api/installer/register mit dem Zertifikat.
//      DVhub antwortet mit Kopplungs-Code; den nennt der Installateur seinem
//      Kunden, der bestätigt in der DVhub-Oberfläche.
//   3. Login → Challenge/Response-Signatur mit dem Private Key, daraus
//      Session-Token (wird bei 401 automatisch erneuert).
//   4. Betrieb → Live-Status/Alarme, Historie, Update-Check/-Apply und
//      Support-Tunnel öffnen/schließen über die /api/installer/*-Endpunkte.
//
// Umgebungsvariablen:
//   PORT       (Default 8700)          — Portal-Port
//   DATA_DIR   (Default ./data)        — Konten, Schlüssel, Anlagenliste
//   SESSION_TTL_H (Default 12)         — Browser-Login-Lebensdauer (Stunden)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomSecret, totpMatchStep, otpauthUri } from './totp.js';
import { verifyRegistration, verifyAssertion } from './webauthn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8700;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_H) || 12) * 3600_000;
// Admin-Rechnungen (Herstellersicht): Kommagetrennte Kontonamen
// (case-insensitive). Default 'admin' — das erste Konto mit diesem Namen
// bekommt die Admin-Kachel (Übersicht, Umverteilung, Backup). Die Rolle
// wird dynamisch aus der ENV abgeleitet, kein Rollen-Feld in der Datei.
const ADMIN_ACCOUNTS = new Set(String(process.env.ADMIN_ACCOUNTS || 'admin')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
// Admin-Namen sind für die offene Registrierung RESERVIERT: angelegt werden
// können sie nur mit diesem Setup-Token (ohne gesetzte Variable gar nicht per
// HTTP). Sonst würde ein in ADMIN_ACCOUNTS stehender, aber noch nicht
// angelegter Name (z. B. der Default 'admin') jedem zufallen, der ihn zuerst
// registriert. Gleiches Token schützt den Backup-Import auf frischem Portal.
const ADMIN_SETUP_TOKEN = String(process.env.ADMIN_SETUP_TOKEN || '');
// Selbstregistrierung ist aus: Installateurs-Konten legt der Admin an (Startpasswort,
// muss beim ersten Login geaendert werden). Nur das erste Admin-Konto entsteht per
// ADMIN_SETUP_TOKEN. ALLOW_SELF_REGISTER=1 schaltet die offene Registrierung wieder ein.
const ALLOW_SELF_REGISTER = process.env.ALLOW_SELF_REGISTER === '1';
const MIN_PASSWORD = 8;
function tempPassword() { return crypto.randomBytes(12).toString('base64url'); }
// TOTP: nach so vielen falschen Codes wird das Konto so lange für 2FA gesperrt.
const TOTP_MAX_FAILS = 5;
const TOTP_LOCK_MS = 15 * 60_000;
function setupTokenOk(candidate) {
  if (!ADMIN_SETUP_TOKEN || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate), b = Buffer.from(ADMIN_SETUP_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const APPLIANCES_FILE = path.join(DATA_DIR, 'appliances.json');
// Pull-Modell (NAT): Pairing-Anfragen + Poll-State der Anlagen, die sich bei
// UNS melden. Keyed by applianceId.
const PAIRINGS_FILE = path.join(DATA_DIR, 'pairings.json');
const SECRET_FILE = path.join(DATA_DIR, 'portal-secret');
const KEYS_DIR = path.join(DATA_DIR, 'keys');
// Fehlerprotokoll je Anlage (JSONL, nur anhängen) — die Anlage meldet ihre
// Fehler beim Poll, das Portal hebt sie dauerhaft auf und quittiert sie
// (errorsAck). Erst danach kürzt die Anlage ihr lokales Log (24 h / 7 Tage).
const ERRORS_DIR = path.join(DATA_DIR, 'errors');
const ERRORS_MAX_BYTES = 20 * 1024 * 1024;
const ERRORS_KEEP_LINES = 100_000;

fs.mkdirSync(KEYS_DIR, { recursive: true });

// ── kleine Hilfsditzen ───────────────────────────────────────────────────────
const jsonRes = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 2 * 1024 * 1024) { reject(new Error('body_too_large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (!chunks.length) return resolve({});
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { reject(new Error('invalid_json')); }
  });
  req.on('error', reject);
});
const readJsonFile = (p, dflt) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
};
const writeJsonFile = (p, obj) => {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
};
const nowIso = () => new Date().toISOString();
const APPLIANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,35}$/i;
// Kopplungs-Codes: 30 min gültig, nach 5 Fehlversuchen gesperrt (6 Ziffern
// sind sonst in Minuten durchprobiert — /api/pair/claim ist unauthentisiert).
const PAIRING_CODE_TTL_MS = 30 * 60_000;
const PAIRING_MAX_ATTEMPTS = 5;
// Eine freigegebene Anlage, die sich so lange nicht mehr gemeldet hat, darf
// ein anderer Installateur neu koppeln (Installateurwechsel ohne Trennen).
const STALE_APPROVED_MS = 7 * 24 * 3600_000;

// ── Rate-Limit (pro IP, Sliding Window 1 min) für die offenen Endpunkte ──────
const rateBuckets = new Map();
function rateLimited(req, bucket, max = 20) {
  const ip = req.socket?.remoteAddress || '?';
  const key = `${bucket}|${ip}`;
  const t = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((x) => t - x < 60_000);
  hits.push(t);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (!v.some((x) => t - x < 60_000)) rateBuckets.delete(k);
  }
  return hits.length > max;
}

// Schlüsselverzeichnis eines Kontos. Neue Konten: zufällige ID (nie der
// Benutzername — der ist Nutzereingabe, "../x" wäre Path Traversal).
// Altkonten ohne keyDir: Kontoname, aber nur als direktes Unterverzeichnis.
function keyDirFor(acctKey, acct) {
  const rel = (acct && acct.keyDir) || acctKey;
  const dir = path.resolve(KEYS_DIR, String(rel));
  if (path.dirname(dir) !== path.resolve(KEYS_DIR)) throw new Error('key_dir_invalid');
  return dir;
}

// ── Portal-Signing-Secret (für Browser-Session-Cookies) ─────────────────────
function portalSecret() {
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  }
}

// ── Passwörter: scrypt mit Salt ──────────────────────────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const cand = crypto.scryptSync(String(pw), salt, 32);
    const expect = Buffer.from(hash, 'hex');
    return cand.length === expect.length && crypto.timingSafeEqual(cand, expect);
  } catch { return false; }
}

// ── Key-Paar + self-signiertes Zertifikat via openssl ───────────────────────
function issueIdentity(accountDir, commonName) {
  fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(accountDir, 'key.pem');
  const certPath = path.join(accountDir, 'cert.pem');
  // OpenSSL 3 erwartet /type=value-Formate; CN darf kein '/' enthalten.
  const cn = String(commonName).replace(/[=/]+/g, ' ').trim() || 'DVhub Installer';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519', '-keyout', keyPath,
    '-out', certPath, '-days', '1095', '-nodes', '-subj', `/CN=${cn}`],
    { stdio: 'ignore' });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best-effort */ }
  return { keyPath, certPath };
}
function certFingerprint(pem) {
  const der = new crypto.X509Certificate(pem).raw;
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
}

// Konto anlegen (Schluesselpaar + Zertifikat); schreibt nicht, das macht der Aufrufer.
function createAccount(accounts, key, name, company, password, extra = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const keyDir = `acct-${id}`;
  const { certPath } = issueIdentity(path.join(KEYS_DIR, keyDir), `${name} (DVhub Installateurs-Portal)`);
  const certPem = fs.readFileSync(certPath, 'utf8');
  accounts[key] = {
    id, keyDir, name, company: String(company || '').trim().slice(0, 120),
    passHash: hashPassword(password),
    createdAt: nowIso(),
    fingerprint: certFingerprint(certPem),
    ...extra,
  };
  return accounts[key];
}
function validName(name) {
  // eslint-disable-next-line no-control-regex
  return !!name && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name);
}

function isAdmin(acctKey) { return ADMIN_ACCOUNTS.has(String(acctKey).toLowerCase()); }

// ── WebAuthn-Handshake-State ─────────────────────────────────────────────────────
// Kurzlebige Challenges für Registrierung/Login (5 min, einmalverbrauch).
// Key: `${kind}:${konto}`. Ein Prozess → In-Memory genügt; ein Neustart
// bricht nur einen laufenden Browser-Handshake ab, keine Dauerwirkung.
const pendingChallenges = new Map();
function putChallenge(kind, who) {
  const challenge = crypto.randomBytes(32).toString('base64url');
  pendingChallenges.set(`${kind}:${who}`, { challenge, exp: Date.now() + 5 * 60_000 });
  return challenge;
}
// Immer konsumieren (auch bei Fehler → kein Reset-Vektor); gibt die vom
// Server erzeugte Challenge zurück oder null. Die weitere Prüfung
// (clientDataJSON.challenge === erwartet) übernimmt der WebAuthn-Verifier —
// der Client kann hier also nichts schönreden.
function takeChallenge(kind, who) {
  const k = `${kind}:${who}`;
  const rec = pendingChallenges.get(k);
  pendingChallenges.delete(k);
  if (!rec || rec.exp < Date.now()) return null;
  return rec.challenge;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingChallenges) if (v.exp < now) pendingChallenges.delete(k);
}, 60_000).unref();

// rpId + Origin für WebAuthn. Online IMMER fest einstellen:
//   WEBAUTHN_ORIGIN=https://portal.example.de   (rpId = deren Hostname)
//   WEBAUTHN_RP_ID=example.de                   (optional, abweichende rpId)
// Dann legt der Server die erwarteten Werte selbst fest und ignoriert die
// Request-Header. Ohne Einstellung (lokaler Test) werden sie wie bisher aus
// Host/Origin abgeleitet — hinter einem Reverse-Proxy ohne durchgereichten
// Host würden Passkeys dann still unbenutzbar (rpId = 127.0.0.1).
const WEBAUTHN_ORIGIN = (() => {
  const raw = String(process.env.WEBAUTHN_ORIGIN || '').trim();
  if (!raw) return '';
  try { return new URL(raw).origin; } catch { throw new Error(`WEBAUTHN_ORIGIN ungültig: ${raw}`); }
})();
const WEBAUTHN_RP_ID = String(process.env.WEBAUTHN_RP_ID || '').trim()
  || (WEBAUTHN_ORIGIN ? new URL(WEBAUTHN_ORIGIN).hostname : '');
const rpIdFor = (req) => WEBAUTHN_RP_ID || String(req.headers.host || 'localhost').split(':')[0];
const rpIdHashFor = (req) => crypto.createHash('sha256').update(rpIdFor(req)).digest('hex');
// Origin-Bindung: fest konfiguriert, sonst Origin-Header bzw. aus Host abgeleitet.
const expectedOriginFor = (req) => WEBAUTHN_ORIGIN
  || String(req.headers.origin || `http://${req.headers.host || 'localhost'}`);

// ── Browser-Sessions ─────────────────────────────────────────────────────────
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', portalSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function readSession(req) {
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)portal_session=([^;]+)/.exec(cookie);
  if (!m) return null;
  const token = m[1];
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const expect = crypto.createHmac('sha256', portalSecret()).update(body).digest('base64url');
  const a = Buffer.from(token.slice(dot + 1)), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

// Ein TOTP-Versuch mit allen Schutzmechanismen — für Login UND Deaktivieren
// (sonst könnte eine gestohlene Session beim Abschalten unbegrenzt raten).
// Verändert acct (Fehlzähler/Sperre/letzter Schritt); der Aufrufer speichert.
//   Sperre PRO KONTO nach TOTP_MAX_FAILS Fehlversuchen, Replay-Schutz über
//   den zuletzt benutzten Zeitschritt.
function totpAttempt(acct, code) {
  if (acct.totpLockedUntil && Date.parse(acct.totpLockedUntil) > Date.now()) {
    return { ok: false, status: 429, error: 'totp_gesperrt' };
  }
  const step = totpMatchStep(acct.totpSecret, code);
  if (step === null) {
    acct.totpFails = (acct.totpFails || 0) + 1;
    if (acct.totpFails >= TOTP_MAX_FAILS) {
      acct.totpLockedUntil = new Date(Date.now() + TOTP_LOCK_MS).toISOString();
      acct.totpFails = 0;
    }
    return { ok: false, status: 401, error: 'totp_falsch', failed: true };
  }
  if (Number.isFinite(acct.totpLastStep) && step <= acct.totpLastStep) {
    return { ok: false, status: 401, error: 'totp_bereits_benutzt' };
  }
  acct.totpLastStep = step;
  acct.totpFails = 0;
  delete acct.totpLockedUntil;
  return { ok: true };
}

// Cookie-Helfer — eine Stelle für alle Logins. COOKIE_SECURE=1 für den
// Online-Betrieb hinter HTTPS (Cookie wird dann nie über http:// gesendet).
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const cookieAttrs = `HttpOnly; SameSite=Lax; Path=/${COOKIE_SECURE ? '; Secure' : ''}`;
// Session für ein Konto ausstellen. sv = sessionVersion des Kontos: wird die
// hochgezählt (2FA/Passkeys geändert), sind alle älteren Sessions ungültig.
function setSessionCookie(res, acctKey, acct) {
  const token = signSession({ acct: acctKey, sv: (acct && acct.sessionVersion) || 0, exp: Date.now() + SESSION_TTL_MS });
  res.setHeader('set-cookie', `portal_session=${token}; ${cookieAttrs}`);
}
// Signatur+Ablauf prüft readSession; hier zusätzlich: Konto existiert und
// die Session ist nicht durch eine Sicherheitsänderung überholt.
function sessionMatches(sess, acct) {
  return !!(sess && acct && (sess.sv || 0) === (acct.sessionVersion || 0));
}
// Sicherheitsrelevante Kontoänderung: alle anderen Sessions beenden, die
// aktuelle bekommt ein frisches Cookie (sonst sperrt man sich selbst aus).
function rotateSessions(res, acctKey, acct) {
  acct.sessionVersion = (acct.sessionVersion || 0) + 1;
  setSessionCookie(res, acctKey, acct);
}

// ── DVhub-Gegenstelle (ausgehend) ───────────────────────────────────────────
// Alle Aufrufe tragen X-Installer-Session; bei 401/abgelaufener Session wird
// automatisch neu eingeloggt (Challenge → Signatur → Login) und einmal
// wiederholt. baseUrl darf http:// (lokales Netz) oder https:// sein.
async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, body: parsed, text };
}

function loginToAppliance(appliance) {
  const accounts = readJsonFile(ACCOUNTS_FILE, {});
  const acct = accounts[appliance.accountId];
  if (!acct) throw new Error('account_missing');
  const keyPem = fs.readFileSync(path.join(keyDirFor(appliance.accountId, acct), 'key.pem'));
  const key = crypto.createPrivateKey(keyPem);
  return (async () => {
    const ch = await fetchJson(`${appliance.url}/api/installer/login/challenge`, {
      method: 'POST', body: { installerId: appliance.installerId },
    });
    if (!ch.ok || !ch.body?.challenge) {
      throw new Error(ch.body?.error || `challenge_http_${ch.status}`);
    }
    const payload = `dvhub-installer-v1\n${ch.body.applianceId}\n${appliance.installerId}\n${ch.body.challenge}`;
    const signature = crypto.sign(null, Buffer.from(payload), key).toString('base64');
    const lg = await fetchJson(`${appliance.url}/api/installer/login`, {
      method: 'POST',
      body: { installerId: appliance.installerId, challenge: ch.body.challenge, signature },
    });
    if (!lg.ok || !lg.body?.sessionToken) {
      throw new Error(lg.body?.error || `login_http_${lg.status}`);
    }
    const apps = readJsonFile(APPLIANCES_FILE, {});
    if (apps[appliance.id]) {
      apps[appliance.id].session = { token: lg.body.sessionToken, expiresAt: lg.body.expiresAt };
      apps[appliance.id].paired = true;
      apps[appliance.id].applianceId = ch.body.applianceId;
      apps[appliance.id].lastLoginAt = nowIso();
      writeJsonFile(APPLIANCES_FILE, apps);
    }
    return lg.body;
  })();
}

// Update-Einspielen läuft auf der Anlage synchron (git + npm install +
// Migrationen) — dafür großzügig warten, sonst meldet das Portal einen
// Fehler, während das Update noch läuft (und lädt zu Doppelklicks ein).
const DV_TIMEOUT_MS = { '/api/installer/updates/apply': 10 * 60_000 };

async function dvhubCall(appliance, p, { method = 'GET', body, query = '' } = {}) {
  const apps = readJsonFile(APPLIANCES_FILE, {});
  const live = apps[appliance.id] || appliance;
  const timeoutMs = DV_TIMEOUT_MS[p] || 15000;
  const doCall = () => fetchJson(`${live.url}${p}${query}`, {
    method,
    body,
    timeoutMs,
    headers: live.session?.token ? { 'x-installer-session': live.session.token } : {},
  });
  let r = await doCall();
  if (r.status === 401 || (r.status === 503 && r.body?.error === 'installer_session_invalid')) {
    await loginToAppliance(live);
    const fresh = readJsonFile(APPLIANCES_FILE, {})[appliance.id] || live;
    r = await fetchJson(`${live.url}${p}${query}`, {
      method, body, timeoutMs,
      headers: fresh.session?.token ? { 'x-installer-session': fresh.session.token } : {},
    });
  }
  return r;
}

// ── Routing ──────────────────────────────────────────────────────────────────
const STATIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // ── Maschinen-Endpunkte (Anlage → Portal, ausgehend, Token-Auth) ─────────
  // Kein Cookie: die Anlage meldet sich mit dem Appliance-Token, das sie beim
  // Claim bekommen hat. Firewalls: nur ausgehend, nie eingehend.
  // ── Von der Anlage gemeldete Lizenz / Tagesberichte (nur Zahlen, gekappt) ──
  // null/undefined/'' bleiben null — „unbekannt“ ist nicht 0 (Number(null) === 0).
  const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const kwpOrNull = (v) => (isNum(v) && Number(v) > 0 && Number(v) < 100000 ? Math.round(Number(v) * 10) / 10 : null);
  const eurOrNull = (v) => (isNum(v) && Math.abs(Number(v)) < 1e7 ? Math.round(Number(v) * 100) / 100 : null);
  const cleanLicense = (l) => (l && typeof l === 'object' ? {
    proActive: l.proActive === true,
    status: String(l.status || 'none').slice(0, 24),
    kind: l.kind ? String(l.kind).slice(0, 24) : null,
    maxKwp: kwpOrNull(l.maxKwp),
    systemKwp: kwpOrNull(l.systemKwp),
    capacityOk: l.capacityOk !== false,
    at: nowIso(),
  } : null);
  // Fehler der Anlage anhängen. Nur ids über dem bisherigen Quittungs-Cursor
  // (die Anlage schickt aufsteigend und wiederholt, bis quittiert) → kein
  // Doppeleintrag. Gibt den neuen Cursor zurück.
  function storeErrors(aid, pr, list) {
    if (!Array.isArray(list) || !list.length) return pr.errorAckId || 0;
    const ack = Number(pr.errorAckId) || 0;
    const rows = list
      .map((e) => ({
        id: Number(e?.id), ts: String(e?.ts || '').slice(0, 40),
        type: String(e?.type || '').slice(0, 200), sev: String(e?.sev || 'error').slice(0, 16),
        msg: String(e?.msg || '').slice(0, 1000),
      }))
      .filter((e) => Number.isSafeInteger(e.id) && e.id > ack && e.type && !Number.isNaN(Date.parse(e.ts)))
      .sort((a, b) => a.id - b.id)
      .slice(0, 1000);
    if (!rows.length) return ack;
    fs.mkdirSync(ERRORS_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(ERRORS_DIR, `${aid}.jsonl`);
    fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    try {
      if (fs.statSync(file).size > ERRORS_MAX_BYTES) {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, lines.slice(-ERRORS_KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
      }
    } catch { /* Kürzen ist best effort */ }
    pr.errorAckId = rows[rows.length - 1].id;
    pr.errorCount = (Number(pr.errorCount) || 0) + rows.length;
    pr.lastErrorAt = rows[rows.length - 1].ts;
    return pr.errorAckId;
  }
  function readErrors(aid, { limit = 200, type = '' } = {}) {
    const file = path.join(ERRORS_DIR, `${aid}.jsonl`);
    if (!fs.existsSync(file)) return { errors: [], summary: [] };
    const all = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    const byType = new Map();
    for (const e of all) {
      const t = byType.get(e.type) || { type: e.type, count: 0, first: e.ts, last: e.ts };
      t.count += 1; t.last = e.ts;
      byType.set(e.type, t);
    }
    const sel = (type ? all.filter((e) => e.type === type) : all).slice(-limit).reverse();
    return { errors: sel, summary: [...byType.values()].sort((a, b) => (a.last < b.last ? 1 : -1)) };
  }

  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MONTH_RE = /^\d{4}-\d{2}$/;
  const DAYS_KEEP = 400;
  function storeDayReport(pr, r) {
    if (!r || typeof r !== 'object' || !DAY_RE.test(String(r.day || ''))) return;
    pr.days = { ...(pr.days || {}) };
    pr.days[r.day] = {
      netEur: eurOrNull(r.netEur), exportRevenueEur: eurOrNull(r.exportRevenueEur),
      importCostEur: eurOrNull(r.importCostEur), exportKwh: eurOrNull(r.exportKwh), pvKwh: eurOrNull(r.pvKwh),
    };
    const keys = Object.keys(pr.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - DAYS_KEEP))) delete pr.days[k];
    const m = r.month;
    // asOf: Rechenzeitpunkt (ISO), vergleichbar als String.
    if (m && MONTH_RE.test(String(m.month || '')) && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(String(m.asOf || ''))) {
      pr.months = { ...(pr.months || {}) };
      const prev = pr.months[m.month];
      // Nur vorwärts: ein nachgeholter älterer Tag überschreibt keinen neueren Monatsstand.
      if (!prev || String(prev.asOf) <= m.asOf) {
        pr.months[m.month] = {
          asOf: m.asOf, dvRevenueEur: eurOrNull(m.dvRevenueEur), exportRevenueEur: eurOrNull(m.exportRevenueEur),
          marketPremiumEur: eurOrNull(m.marketPremiumEur), exportKwh: eurOrNull(m.exportKwh), dvRevenueCtKwh: eurOrNull(m.dvRevenueCtKwh),
        };
      }
    }
  }

  if (p === '/api/pair/claim' && method === 'POST') {
    if (rateLimited(req, 'claim')) return jsonRes(res, 429, { ok: false, error: 'rate_limited' });
    const b = await readBody(req);
    const aid = String(b.applianceId || '').trim().toLowerCase();
    const code = String(b.code || '').trim();
    const pairings = readJsonFile(PAIRINGS_FILE, {});
    const pr = pairings[aid];
    if (!pr) return jsonRes(res, 404, { ok: false, error: 'pairing_not_found' });
    if (pr.status === 'declined') return jsonRes(res, 409, { ok: false, error: 'pairing_declined' });
    if (pr.status !== 'waiting') {
      // Re-Claim nach Anlage-Neustart: mit korrektem Token gibt's Status zurück.
      if (b.applianceToken && b.applianceToken === pr.applianceToken) {
        return jsonRes(res, 200, { ok: true, applianceToken: pr.applianceToken, status: pr.status });
      }
      return jsonRes(res, 409, { ok: false, error: 'pairing_already_claimed' });
    }
    if (Date.now() - Date.parse(pr.createdAt) > PAIRING_CODE_TTL_MS) {
      return jsonRes(res, 410, { ok: false, error: 'pairing_code_expired' });
    }
    if ((pr.failedAttempts || 0) >= PAIRING_MAX_ATTEMPTS) {
      return jsonRes(res, 429, { ok: false, error: 'pairing_locked' });
    }
    const a = Buffer.from(code), e = Buffer.from(String(pr.code));
    if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) {
      pr.failedAttempts = (pr.failedAttempts || 0) + 1;
      writeJsonFile(PAIRINGS_FILE, pairings);
      return jsonRes(res, 403, { ok: false, error: 'pairing_code_mismatch' });
    }
    pr.status = 'requested';                    // wartet auf Freigabe im Portal
    pr.applianceToken = crypto.randomBytes(32).toString('hex');
    pr.applianceName = String(b.name || '').slice(0, 80) || null;
    pr.requestedAt = nowIso();
    pr.license = cleanLicense(b.license);
    writeJsonFile(PAIRINGS_FILE, pairings);
    return jsonRes(res, 200, { ok: true, applianceToken: pr.applianceToken, status: pr.status });
  }
  if (p === '/api/poll' && method === 'POST') {
    const token = String(req.headers['x-appliance-token'] || '');
    const b = await readBody(req);
    const aid = String(b.applianceId || '').trim().toLowerCase();
    const pairings = readJsonFile(PAIRINGS_FILE, {});
    const pr = pairings[aid];
    if (!pr || !token || token !== pr.applianceToken) {
      return jsonRes(res, 401, { ok: false, error: 'appliance_token_invalid' });
    }
    if (pr.status === 'declined') return jsonRes(res, 410, { ok: false, error: 'pairing_declined' });
    const approved = pr.status === 'approved';
    // Status-/Kommando-Verarbeitung nur nach Freigabe; vorher bleibt die
    // Anlage am Haken und weiß immerhin, dass sie wartet.
    if (approved) {
      pr.lastSeenAt = nowIso();
      pr.lastStatus = b.status || null;   // ohne Pro-Lizenz schickt die Anlage keinen Status
      if (b.license) pr.license = cleanLicense(b.license);
      storeDayReport(pr, b.dayReport);
      if (b.errorsReset === true) pr.errorAckId = 0;   // Anlage hat eine neue Datenbank
      storeErrors(aid, pr, b.errors);
    }
    const commands = approved ? (pr.commands || []).splice(0, 5) : [];
    writeJsonFile(PAIRINGS_FILE, pairings);
    return jsonRes(res, 200, { ok: true, approved, commands, ...(approved ? { errorsAck: Number(pr.errorAckId) || 0 } : {}) });
  }
  // Anlage trennt sich (Kunde hat „Portal-Kopplung trennen“ gedrückt):
  // Kopplung hier löschen, damit die Anlage frei für einen neuen Code ist.
  if (p === '/api/pair/release' && method === 'POST') {
    const token = String(req.headers['x-appliance-token'] || '');
    const b = await readBody(req);
    const aid = String(b.applianceId || '').trim().toLowerCase();
    const pairings = readJsonFile(PAIRINGS_FILE, {});
    const pr = pairings[aid];
    if (!pr || !token || token !== pr.applianceToken) {
      return jsonRes(res, 401, { ok: false, error: 'appliance_token_invalid' });
    }
    delete pairings[aid];
    writeJsonFile(PAIRINGS_FILE, pairings);
    return jsonRes(res, 200, { ok: true });
  }
  if (p === '/api/command-result' && method === 'POST') {
    const token = String(req.headers['x-appliance-token'] || '');
    const b = await readBody(req);
    const aid = String(b.applianceId || '').trim().toLowerCase();
    const pairings = readJsonFile(PAIRINGS_FILE, {});
    const pr = pairings[aid];
    if (!pr || !token || token !== pr.applianceToken) {
      return jsonRes(res, 401, { ok: false, error: 'appliance_token_invalid' });
    }
    pr.results = { ...(pr.results || {}) };
    for (const r of (Array.isArray(b.results) ? b.results : [])) {
      if (r && r.id) pr.results[r.id] = { ok: !!r.ok, status: r.status ?? null, result: r.result ?? null, at: nowIso() };
    }
    writeJsonFile(PAIRINGS_FILE, pairings);
    return jsonRes(res, 200, { ok: true });
  }

  // Öffentlich, damit die Login-Seite den Backup-Import-Hinweis nur auf
  // einem frischen Portal zeigt. Nur ein Boolean — keine Kontennamen.
  if (p === '/api/portal-info' && method === 'GET') {
    const hasAccounts = Object.keys(readJsonFile(ACCOUNTS_FILE, {})).length > 0;
    return jsonRes(res, 200, { ok: true, hasAccounts, selfRegister: ALLOW_SELF_REGISTER || !hasAccounts });
  }

  // Backup-Import. Auf einem FRISCHEN Portal (noch kein Konto) ohne Login
  // möglich — sonst braucht es den Admin (Prüfung oben im Admin-Block).
  // Überschreibt accounts/pairings/appliances/keys vollständig; die Anlagen
  // machen am Poll-Protokoll nichts falsch, weil Token + Keys 1:1 mitwandern.
  if (p === '/api/admin/import' && method === 'POST') {
    const hasAccounts = Object.keys(readJsonFile(ACCOUNTS_FILE, {})).length > 0;
    const sess0 = readSession(req);
    const acct0 = sess0 ? readJsonFile(ACCOUNTS_FILE, {})[sess0.acct] : null;
    if (hasAccounts && (!sessionMatches(sess0, acct0) || !isAdmin(sess0.acct))) {
      return jsonRes(res, 403, { ok: false, error: 'kein_admin_konto' });
    }
    const b = await readBody(req);
    // Frisches Portal: nur mit Setup-Token — sonst könnte, wer ein neu
    // aufgesetztes Portal zuerst erreicht, eigene Konten (inkl. Admin) einspielen.
    if (!hasAccounts && !setupTokenOk(b.setupToken)) {
      return jsonRes(res, 403, { ok: false, error: 'setup_token_noetig' });
    }
    if (b.kind !== 'dvhub-installer-portal-backup' || typeof b.accounts !== 'object' || !b.accounts) {
      return jsonRes(res, 400, { ok: false, error: 'kein_dvhub_portal_backup' });
    }
    try {
      writeJsonFile(ACCOUNTS_FILE, b.accounts);
      writeJsonFile(PAIRINGS_FILE, (b.pairings && typeof b.pairings === 'object') ? b.pairings : {});
      writeJsonFile(APPLIANCES_FILE, (b.appliances && typeof b.appliances === 'object') ? b.appliances : {});
      for (const [dir, pair] of Object.entries(b.keys || {})) {
        if (!pair || !pair.keyPem || !pair.certPem) continue;
        // Nur schlichte Ordnernamen, die direkt unter KEYS_DIR landen — „..“
        // o. Ä. würde sonst key.pem in DATA_DIR (oder höher) schreiben.
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(dir)) continue;
        const dirPath = path.resolve(KEYS_DIR, dir);
        if (path.dirname(dirPath) !== path.resolve(KEYS_DIR)) continue;
        fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dirPath, 'key.pem'), pair.keyPem, { mode: 0o600 });
        fs.writeFileSync(path.join(dirPath, 'cert.pem'), pair.certPem);
      }
      return jsonRes(res, 200, { ok: true, accounts: Object.keys(b.accounts).length });
    } catch (e) {
      return jsonRes(res, 500, { ok: false, error: 'import_fehlgeschlagen', detail: String(e.message || e).slice(0, 160) });
    }
  }

  // --- Konto/Session ---------------------------------------------------------
  if (p === '/api/account' && method === 'POST') {
    if (rateLimited(req, 'account', 5)) return jsonRes(res, 429, { ok: false, error: 'rate_limited' });
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    const password = String(b.password || '');
    if (!name || password.length < 8) return jsonRes(res, 400, { ok: false, error: 'name_und_mindestens_8_zeichen_passwort_noetig' });
    // eslint-disable-next-line no-control-regex
    if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
      return jsonRes(res, 400, { ok: false, error: 'name_ungueltig' });
    }
    const accounts = readJsonFile(ACCOUNTS_FILE, {});
    const key = name.toLowerCase();
    if (accounts[key]) return jsonRes(res, 409, { ok: false, error: 'konto_existiert_bereits' });
    if (isAdmin(key) && !setupTokenOk(b.setupToken)) {
      return jsonRes(res, 403, { ok: false, error: 'name_reserviert' });
    }
    // Installateurs-Konten nur durch den Admin (ausser ALLOW_SELF_REGISTER=1)
    if (!isAdmin(key) && !ALLOW_SELF_REGISTER) {
      return jsonRes(res, 403, { ok: false, error: 'registrierung_nur_durch_admin' });
    }
    createAccount(accounts, key, name, b.company, password);
    writeJsonFile(ACCOUNTS_FILE, accounts);
    setSessionCookie(res, key, accounts[key]);
    return jsonRes(res, 201, { ok: true, name, fingerprint: accounts[key].fingerprint });
  }
  if (p === '/api/login' && method === 'POST') {
    if (rateLimited(req, 'login', 10)) return jsonRes(res, 429, { ok: false, error: 'rate_limited' });
    const b = await readBody(req);
    const accounts = readJsonFile(ACCOUNTS_FILE, {});
    const acct = accounts[String(b.name || '').toLowerCase()];
    if (!acct || !verifyPassword(b.password, acct.passHash)) {
      return jsonRes(res, 401, { ok: false, error: 'anmeldung_fehlgeschlagen' });
    }
    // 2FA: TOTP erst nach korrektem Passwort — Fehlermeldung getrennt, damit
    // die UI gezielt nach dem Code fragen kann (kein Konten-Oracle: Passwort
    // muss vorher schon gestimmt haben).
    if (acct.totpEnabled) {
      if (!b.totp) return jsonRes(res, 401, { ok: false, error: 'totp_ausstaendig' });
      // Sperre pro Konto + Replay-Schutz: siehe totpAttempt.
      const t = totpAttempt(acct, b.totp);
      writeJsonFile(ACCOUNTS_FILE, accounts);
      if (!t.ok) {
        if (t.failed && rateLimited(req, 'totp', 6)) return jsonRes(res, 429, { ok: false, error: 'rate_limited' });
        return jsonRes(res, t.status, { ok: false, error: t.error });
      }
    }
    setSessionCookie(res, String(b.name).toLowerCase(), acct);
    return jsonRes(res, 200, { ok: true, name: acct.name });
  }
  // Passkey-Login: Two-Step (Challenge → Assertion), danach Session-Cookie wie
  // beim Passwort-Login. Kein Passwort, kein TOTP — der Passkey IST der Faktor.
  if (p === '/api/passkey/login-begin' && method === 'POST') {
    if (rateLimited(req, 'pkbegin', 10)) return jsonRes(res, 429, { ok: false, error: 'rate_limited' });
    const b = await readBody(req);
    const accounts = readJsonFile(ACCOUNTS_FILE, {});
    const key = String(b.name || '').toLowerCase();
    const acct = accounts[key];
    // Immer dieselbe Antwort-Form (200 + Challenge), auch für unbekannte Konten
    // oder Konten ohne Passkey — sonst ließe sich abfragen, welche Konten
    // existieren. login-finish scheitert dann regulär mit 401.
    const allow = (acct && Array.isArray(acct.passkeys)) ? acct.passkeys.map((k) => k.id) : [];
    return jsonRes(res, 200, { ok: true, challenge: putChallenge('pklogin', key), rpId: rpIdFor(req), allow });
  }
  if (p === '/api/passkey/login-finish' && method === 'POST') {
    if (rateLimited(req, 'pkfinish', 10)) return jsonRes(res, 429, { ok: false, error: 'rate_limited' });
    const b = await readBody(req);
    const key = String(b.name || '').toLowerCase();
    const stored = takeChallenge('pklogin', key);
    if (!stored) return jsonRes(res, 401, { ok: false, error: 'challenge_abgelaufen' });
    const accounts = readJsonFile(ACCOUNTS_FILE, {});
    const acct = accounts[key];
    const cred = (acct && Array.isArray(acct.passkeys) ? acct.passkeys : []).find((k) => k.id === b.id);
    if (!acct || !cred) return jsonRes(res, 401, { ok: false, error: 'passkey_unbekannt' });
    try {
      const res2 = verifyAssertion({
        authenticatorData: b.authenticatorData,
        clientDataJSON: b.clientDataJSON,
        signature: b.signature,
        expectedChallenge: stored,
        expectedOrigin: expectedOriginFor(req),
        expectedRpIdHash: rpIdHashFor(req),
        credential: { publicKey: cred.publicKey },
        requireUV: true, // Passkey ist hier der einzige Faktor
      });
      cred.lastUsed = nowIso();
      if (typeof res2.counter === 'number') cred.counter = res2.counter;
      writeJsonFile(ACCOUNTS_FILE, accounts);
    } catch (e) {
      return jsonRes(res, 401, { ok: false, error: 'passkey_verifikation_fehlgeschlagen', detail: String(e.message).slice(0, 80) });
    }
    setSessionCookie(res, key, acct);
    return jsonRes(res, 200, { ok: true, name: acct.name });
  }
  if (p === '/api/logout' && method === 'POST') {
    res.setHeader('set-cookie', `portal_session=; ${cookieAttrs}; Max-Age=0`);
    return jsonRes(res, 200, { ok: true });
  }

  // --- ab hier nur für angemeldete Installateure -----------------------------
  const sess = readSession(req);
  if (!sess) return jsonRes(res, 401, { ok: false, error: 'nicht_angeloggt' });
  const accounts = readJsonFile(ACCOUNTS_FILE, {});
  const acct = accounts[sess.acct];
  if (!acct) return jsonRes(res, 401, { ok: false, error: 'konto_nicht_gefunden' });
  if (!sessionMatches(sess, acct)) return jsonRes(res, 401, { ok: false, error: 'sitzung_abgelaufen' });
  // Für Routen, die den Konto-Store ändern: ERST den Body lesen, DANN Konten
  // frisch laden und die Session erneut prüfen — sonst schreibt ein
  // veralteter Snapshot parallele Änderungen (auch Session-Sperren) zurück.
  const bodyWithFreshAccount = async () => {
    const body = await readBody(req);
    const fresh = readJsonFile(ACCOUNTS_FILE, {});
    const cur = fresh[sess.acct];
    if (!sessionMatches(sess, cur)) { jsonRes(res, 401, { ok: false, error: 'sitzung_abgelaufen' }); return null; }
    return { b: body, accounts: fresh, acct: cur };
  };

  // Eigenes Passwort aendern (Pflicht nach Startpasswort/Reset)
  if (p === '/api/password' && method === 'POST') {
    if (rateLimited(req, 'password', 10)) return jsonRes(res, 429, { ok: false, error: 'rate_limited' });
    const ctx = await bodyWithFreshAccount(); if (!ctx) return;
    const { b, accounts: fresh, acct: cur } = ctx;
    if (!verifyPassword(b.oldPassword, cur.passHash)) return jsonRes(res, 403, { ok: false, error: 'altes_passwort_falsch' });
    const np = String(b.newPassword || '');
    if (np.length < MIN_PASSWORD) return jsonRes(res, 400, { ok: false, error: 'passwort_zu_kurz' });
    if (np === String(b.oldPassword)) return jsonRes(res, 400, { ok: false, error: 'passwort_unveraendert' });
    cur.passHash = hashPassword(np);
    delete cur.mustChangePassword;
    rotateSessions(res, sess.acct, cur);
    writeJsonFile(ACCOUNTS_FILE, fresh);
    return jsonRes(res, 200, { ok: true });
  }
  // Solange das Startpasswort nicht geaendert ist, geht nur /api/me, /api/password, /api/logout
  if (acct.mustChangePassword && p !== '/api/me') {
    return jsonRes(res, 403, { ok: false, error: 'passwort_aendern' });
  }

  if (p === '/api/me' && method === 'GET') {
    return jsonRes(res, 200, {
      ok: true, name: acct.name, company: acct.company, fingerprint: acct.fingerprint,
      role: isAdmin(sess.acct) ? 'admin' : 'installer',
      mustChangePassword: !!acct.mustChangePassword,
      totpEnabled: !!acct.totpEnabled,
      passkeys: (acct.passkeys || []).map((k) => ({ id: k.id, label: k.label || 'Passkey', addedAt: k.addedAt, lastUsed: k.lastUsed || null })),
    });
  }

  // ── Sicherheit: TOTP einrichten / Passkeys verwalten (eingeloggt) ────────
  if (p === '/api/totp/setup' && method === 'POST') {
    if (acct.totpEnabled) return jsonRes(res, 409, { ok: false, error: 'totp_bereits_aktiv' });
    acct.totpPending = randomSecret();
    writeJsonFile(ACCOUNTS_FILE, accounts);
    return jsonRes(res, 200, { ok: true, secret: acct.totpPending, otpauth: otpauthUri({ secret: acct.totpPending, accountName: acct.name }) });
  }
  if (p === '/api/totp/enable' && method === 'POST') {
    const f = await bodyWithFreshAccount();
    if (!f) return;
    const { b, accounts, acct } = f;
    if (!acct.totpPending) return jsonRes(res, 400, { ok: false, error: 'kein_setup_gestartet' });
    const enableStep = totpMatchStep(acct.totpPending, b.code);
    if (enableStep === null) return jsonRes(res, 400, { ok: false, error: 'code_falsch' });
    acct.totpSecret = acct.totpPending;
    acct.totpEnabled = true;
    // Der Code, mit dem aktiviert wurde, ist verbraucht (kein Login damit).
    acct.totpLastStep = enableStep;
    delete acct.totpPending;
    rotateSessions(res, sess.acct, acct);
    writeJsonFile(ACCOUNTS_FILE, accounts);
    return jsonRes(res, 200, { ok: true });
  }
  if (p === '/api/totp/disable' && method === 'POST') {
    const f = await bodyWithFreshAccount();
    if (!f) return;
    const { b, accounts, acct } = f;
    if (!acct.totpEnabled) return jsonRes(res, 400, { ok: false, error: 'totp_nicht_aktiv' });
    // Deaktivieren nur mit gültigem Code (sonst könnte eine gestohlene
    // Session 2FA still abschalten und danach den Login kapern) — mit
    // denselben Sperren wie beim Login, sonst wäre hier unbegrenztes Raten möglich.
    const t = totpAttempt(acct, b.code);
    if (!t.ok) {
      writeJsonFile(ACCOUNTS_FILE, accounts);
      return jsonRes(res, t.status === 401 ? 400 : t.status, { ok: false, error: t.error === 'totp_falsch' ? 'code_falsch' : t.error });
    }
    delete acct.totpSecret; delete acct.totpEnabled; delete acct.totpPending;
    delete acct.totpLastStep; delete acct.totpFails; delete acct.totpLockedUntil;
    rotateSessions(res, sess.acct, acct);
    writeJsonFile(ACCOUNTS_FILE, accounts);
    return jsonRes(res, 200, { ok: true });
  }
  if (p === '/api/passkey/register-begin' && method === 'POST') {
    return jsonRes(res, 200, { ok: true, challenge: putChallenge('pkreg', sess.acct), rpId: rpIdFor(req), userId: `${acct.id}` });
  }
  if (p === '/api/passkey/register-finish' && method === 'POST') {
    const f = await bodyWithFreshAccount();
    if (!f) return;
    const { b, accounts, acct } = f;
    const stored = takeChallenge('pkreg', sess.acct);
    if (!stored) return jsonRes(res, 400, { ok: false, error: 'challenge_abgelaufen' });
    let reg;
    try {
      reg = verifyRegistration({
        attestationObject: b.attestationObject,
        clientDataJSON: b.clientDataJSON,
        expectedChallenge: stored,
        expectedOrigin: expectedOriginFor(req),
        expectedRpIdHash: rpIdHashFor(req),
      });
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: 'passkey_registrierung_abgelehnt', detail: String(e.message).slice(0, 80) });
    }
    acct.passkeys = acct.passkeys || [];
    if (acct.passkeys.some((k) => k.id === reg.id)) return jsonRes(res, 409, { ok: false, error: 'passkey_bereits_registriert' });
    if (acct.passkeys.length >= 10) return jsonRes(res, 409, { ok: false, error: 'max_10_passkeys' });
    acct.passkeys.push({
      id: reg.id, publicKey: reg.publicKey, algorithm: reg.algorithm,
      label: String(b.label || '').trim().slice(0, 40) || 'Passkey',
      addedAt: nowIso(), counter: reg.counter || 0,
    });
    writeJsonFile(ACCOUNTS_FILE, accounts);
    return jsonRes(res, 201, { ok: true, id: reg.id });
  }
  // WebAuthn erlaubt Credential-IDs bis 1023 Byte (≈ 1364 Zeichen base64url) —
  // jede registrierbare ID muss auch wieder löschbar sein.
  const pkMatch = /^\/api\/passkeys\/([a-zA-Z0-9_-]{1,1400})$/.exec(p);
  if (pkMatch && method === 'DELETE') {
    const before = (acct.passkeys || []).length;
    acct.passkeys = (acct.passkeys || []).filter((k) => k.id !== pkMatch[1]);
    if (acct.passkeys.length === before) return jsonRes(res, 404, { ok: false, error: 'passkey_nicht_gefunden' });
    rotateSessions(res, sess.acct, acct);
    writeJsonFile(ACCOUNTS_FILE, accounts);
    return jsonRes(res, 200, { ok: true });
  }

  // ── Admin-Bereich (Hersteller): Übersicht, Umverteilung, Backup ────────
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(sess.acct)) return jsonRes(res, 403, { ok: false, error: 'kein_admin_konto' });

    // Installateur anlegen: Startpasswort wird erzeugt und einmal angezeigt
    if (p === '/api/admin/accounts' && method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim();
      if (!validName(name)) return jsonRes(res, 400, { ok: false, error: 'name_ungueltig' });
      const key = name.toLowerCase();
      if (isAdmin(key)) return jsonRes(res, 403, { ok: false, error: 'name_reserviert' });
      const fresh = readJsonFile(ACCOUNTS_FILE, {});
      if (fresh[key]) return jsonRes(res, 409, { ok: false, error: 'konto_existiert_bereits' });
      const password = tempPassword();
      createAccount(fresh, key, name, b.company, password, { mustChangePassword: true, createdBy: sess.acct });
      writeJsonFile(ACCOUNTS_FILE, fresh);
      return jsonRes(res, 201, { ok: true, name, password });
    }
    // Passwort zuruecksetzen (optional auch 2FA/Passkeys entfernen); beendet alle Sitzungen
    if (p === '/api/admin/accounts/reset' && method === 'POST') {
      const b = await readBody(req);
      const key = String(b.account || '').trim().toLowerCase();
      const fresh = readJsonFile(ACCOUNTS_FILE, {});
      const a = fresh[key];
      if (!a) return jsonRes(res, 404, { ok: false, error: 'konto_nicht_gefunden' });
      if (isAdmin(key)) return jsonRes(res, 403, { ok: false, error: 'admin_konto' });
      const password = tempPassword();
      a.passHash = hashPassword(password);
      a.mustChangePassword = true;
      a.sessionVersion = (a.sessionVersion || 0) + 1;
      if (b.resetSecurity) { for (const k of Object.keys(a)) if (k.startsWith('totp')) delete a[k]; a.passkeys = []; }
      writeJsonFile(ACCOUNTS_FILE, fresh);
      return jsonRes(res, 200, { ok: true, name: a.name, password });
    }
    // Konto loeschen — nur ohne zugeordnete Anlagen (vorher umverteilen)
    if (p === '/api/admin/accounts/delete' && method === 'POST') {
      const b = await readBody(req);
      const key = String(b.account || '').trim().toLowerCase();
      const fresh = readJsonFile(ACCOUNTS_FILE, {});
      const a = fresh[key];
      if (!a) return jsonRes(res, 404, { ok: false, error: 'konto_nicht_gefunden' });
      if (isAdmin(key)) return jsonRes(res, 403, { ok: false, error: 'admin_konto' });
      const owned = Object.values(readJsonFile(PAIRINGS_FILE, {})).filter((pr) => pr.acct === key).length;
      if (owned) return jsonRes(res, 409, { ok: false, error: 'konto_hat_anlagen', count: owned });
      delete fresh[key];
      writeJsonFile(ACCOUNTS_FILE, fresh);
      if (a.keyDir && /^acct-[0-9a-f]{16}$/.test(a.keyDir)) fs.rmSync(path.join(KEYS_DIR, a.keyDir), { recursive: true, force: true });
      return jsonRes(res, 200, { ok: true });
    }

    // Übersicht: alle Installateure mit Anlagenzahl, freigegeben/live,
    // installierter Leistung (summierte sizeKwp) und Anlagendetails.
    if (p === '/api/admin/overview' && method === 'GET') {
      const all = Object.values(readJsonFile(PAIRINGS_FILE, {}));
      const accounts = readJsonFile(ACCOUNTS_FILE, {});
      const installers = Object.entries(accounts).map(([key, a]) => {
        const mine = all.filter((pr) => pr.acct === key);
        const kwp = mine.reduce((sum, pr) => sum + (Number(pr.sizeKwp) || 0), 0);
        return {
          key, name: a.name, company: a.company || '', role: isAdmin(key) ? 'admin' : 'installer',
          createdAt: a.createdAt || null, mustChangePassword: !!a.mustChangePassword,
          totpEnabled: !!a.totpEnabled, passkeys: (a.passkeys || []).length,
          appliances: mine.map((pr) => ({
            applianceId: pr.applianceId, name: pr.name || pr.applianceName || null,
            customer: pr.customer || null, status: pr.status,
            sizeKwp: Number(pr.sizeKwp) || null,
            seenAt: pr.lastSeenAt || null,
            pvNowW: pr.lastStatus?.pvTotalW ?? null,
          })),
          counts: {
            total: mine.length,
            approved: mine.filter((x) => x.status === 'approved').length,
            live: mine.filter((x) => x.status === 'approved' && x.lastSeenAt
              && Date.now() - Date.parse(x.lastSeenAt) < 5 * 60_000).length,
          },
          totalKwp: Math.round(kwp * 10) / 10,
        };
      });
      return jsonRes(res, 200, { ok: true, installers });
    }

    // Anlage einem anderen Installateur zuordnen (z. B. Installateur-Wechsel
    // beim Kunden). Die Anlage selbst merkt davon nichts — der Token
    // wandert mit, nur die Sicht im Portal wechselt.
    if (p === '/api/admin/reassign' && method === 'POST') {
      const b = await readBody(req);
      const aid = String(b.applianceId || '').trim().toLowerCase();
      const to = String(b.toAccount || '').trim().toLowerCase();
      const pairings = readJsonFile(PAIRINGS_FILE, {});
      const pr = pairings[aid];
      if (!pr) return jsonRes(res, 404, { ok: false, error: 'pairing_nicht_gefunden' });
      const accounts = readJsonFile(ACCOUNTS_FILE, {});
      if (!accounts[to]) return jsonRes(res, 404, { ok: false, error: 'ziel_installateur_nicht_gefunden' });
      if (pr.acct === to) return jsonRes(res, 409, { ok: false, error: 'bereits_zugeordnet' });
      pr.acct = to;
      writeJsonFile(PAIRINGS_FILE, pairings);
      return jsonRes(res, 200, { ok: true, applianceId: aid, toAccount: to });
    }

    // Voll-Backup: Konten (+Passwort-Hashes), Key-Paare (Private Keys!) und
    // alle Pairings — damit ein neues Portal die identische Anlage
    // fortsetzen kann. Als JSON-Download; Import dazu unten.
    if (p === '/api/admin/export' && method === 'GET') {
      const keys = {};
      try {
        for (const dir of fs.readdirSync(KEYS_DIR)) {
          try {
            keys[dir] = {
              keyPem: fs.readFileSync(path.join(KEYS_DIR, dir, 'key.pem'), 'utf8'),
              certPem: fs.readFileSync(path.join(KEYS_DIR, dir, 'cert.pem'), 'utf8'),
            };
          } catch { /* unvollständiges Verzeichnis ignorieren */ }
        }
      } catch { /* KEYS_DIR fehlt */ }
      const body = JSON.stringify({
        kind: 'dvhub-installer-portal-backup', version: 1,
        exportedAt: nowIso(),
        accounts: readJsonFile(ACCOUNTS_FILE, {}),
        pairings: readJsonFile(PAIRINGS_FILE, {}),
        appliances: readJsonFile(APPLIANCES_FILE, {}),
        keys,
      }, null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="dvhub-portal-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      return res.end(body);
    }
    return jsonRes(res, 404, { ok: false, error: 'not_found' });
  }

  // ── Pairing-Verwaltung (Installateur im Browser) ───────────────────────
  // Ablauf: ID eingeben → Code erzeugen → Code in die Anlage → Anlage claimt
  // (incoming) → Anfrage erscheint hier → "Annehmen" → Poll-Verbindung aktiv.
  const PAIRABLE = ['waiting', 'requested', 'approved', 'declined'];
  const pairingView = (pr) => ({
    applianceId: pr.applianceId, code: pr.code, status: pr.status,
    applianceName: pr.applianceName || null,
    // Installateur-Vergabe: eigener Anlagename + Kundenname (nur fürs Portal,
    // die Anlage selbst weiß davon nichts). Fallback-Anzeige im UI:
    // name → applianceName → 'Anlage'.
    name: pr.name || null, customer: pr.customer || null,
    sizeKwp: Number(pr.sizeKwp) || null,
    createdAt: pr.createdAt, requestedAt: pr.requestedAt || null,
    seenAt: pr.lastSeenAt || null, lastStatus: pr.lastStatus || null,
    pendingCommands: (pr.commands || []).length,
    results: pr.results || {},
    license: pr.license || null,
    // Passt die angegebene Anlagengröße zur Lizenz? (nur wenn beides bekannt)
    sizeCheck: sizeCheck(pr),
    // Tagesertrag: letzter gemeldeter Tag + Monatsstände (DV-Erlös), vom Portal gespeichert.
    lastDay: lastDayOf(pr),
    months: pr.months || {},
    errorCount: Number(pr.errorCount) || 0,
    lastErrorAt: pr.lastErrorAt || null,
  });
  // Lizenz vorhanden (auch wenn Pro gerade gesperrt ist — „Anlage größer als
  // Lizenz“ sperrt Pro in DVhub selbst, genau dann braucht es den Hinweis).
  function sizeCheck(pr) {
    const lic = pr.license;
    const size = Number(pr.sizeKwp) || null;
    if (!lic) return null;
    if (lic.capacityOk === false) return { ok: false, reason: 'plant_exceeds_license', systemKwp: lic.systemKwp, maxKwp: lic.maxKwp };
    if (!lic.proActive) return null;
    if (lic.maxKwp && size && size > lic.maxKwp) return { ok: false, reason: 'size_exceeds_license', sizeKwp: size, maxKwp: lic.maxKwp };
    return { ok: true, maxKwp: lic.maxKwp };
  }
  function lastDayOf(pr) {
    const keys = Object.keys(pr.days || {}).sort();
    const k = keys[keys.length - 1];
    return k ? { day: k, ...pr.days[k] } : null;
  }
  if (p === '/api/pairings' && method === 'GET') {
    const list = Object.values(readJsonFile(PAIRINGS_FILE, {}))
      .filter((pr) => pr.acct === sess.acct).map(pairingView);
    return jsonRes(res, 200, { ok: true, pairings: list });
  }
  if (p === '/api/pairings' && method === 'POST') {
    const b = await readBody(req);
    const aid = String(b.applianceId || '').trim().toLowerCase();
    if (!APPLIANCE_ID_RE.test(aid)) return jsonRes(res, 400, { ok: false, error: 'appliance_id_ungültig' });
    const pairings = readJsonFile(PAIRINGS_FILE, {});
    const existing = pairings[aid];
    if (existing && existing.status === 'approved') {
      const lastSeen = Date.parse(existing.lastSeenAt || existing.approvedAt || 0) || 0;
      const stale = Date.now() - lastSeen > STALE_APPROVED_MS;
      if (existing.acct === sess.acct || !stale) {
        return jsonRes(res, 409, { ok: false, error: 'anlage_bereits_gekoppelt' });
      }
    } else if (existing && existing.acct !== sess.acct && existing.status !== 'declined') {
      // Offene Anfrage eines ANDEREN Installateurs nicht überschreiben,
      // solange ihr Code noch gilt bzw. die Freigabe aussteht.
      const open = existing.status === 'requested'
        || Date.now() - Date.parse(existing.createdAt) <= PAIRING_CODE_TTL_MS;
      if (open) return jsonRes(res, 409, { ok: false, error: 'anlage_bei_anderem_installateur_in_kopplung' });
    }
    const pr = {
      applianceId: aid, acct: sess.acct,
      code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
      status: 'waiting', applianceName: null, applianceToken: null, failedAttempts: 0,
      // Name/Kunde darf der Installateur schon bei der Anlage angeben — oder
      // später jederzeit über /rename ändern.
      name: String(b.name || '').trim().slice(0, 80) || null,
      customer: String(b.customer || '').trim().slice(0, 80) || null,
      sizeKwp: Number.isFinite(Number(b.sizeKwp)) && Number(b.sizeKwp) > 0 ? Math.round(Number(b.sizeKwp) * 10) / 10 : null,
      createdAt: nowIso(), requestedAt: null, lastSeenAt: null,
      lastStatus: null, commands: [], results: {},
    };
    pairings[aid] = pr;
    writeJsonFile(PAIRINGS_FILE, pairings);
    return jsonRes(res, 201, { ok: true, pairing: pairingView(pr) });
  }
  const pairMatch = /^\/api\/pairings\/([a-z0-9-]{1,36})(\/[a-z-]+)?$/i.exec(p);
  if (pairMatch) {
    const aid = pairMatch[1].toLowerCase();
    const sub = pairMatch[2] || '';
    const pairings = readJsonFile(PAIRINGS_FILE, {});
    const pr = pairings[aid];
    if (!pr || pr.acct !== sess.acct) return jsonRes(res, 404, { ok: false, error: 'pairing_nicht_gefunden' });
    if (sub === '' && method === 'GET') return jsonRes(res, 200, { ok: true, pairing: pairingView(pr) });
    // Fehlerprotokoll der Anlage (neueste zuerst) + Übersicht je Fehlerart.
    if (sub === '/errors' && method === 'GET') {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const type = String(url.searchParams.get('type') || '').slice(0, 200);
      return jsonRes(res, 200, { ok: true, ...readErrors(aid, { limit, type }) });
    }
    // Umbenennen (Installateur-Vergabe): name/customer setzen oder mit leerem
    // Wert zurück auf die Anlagen-Reportierung (applianceName) löschen.
    if (sub === '/rename' && method === 'POST') {
      const b = await readBody(req);
      // Wie /command: Store ERST nach dem Body frisch lesen und ohne weiteres
      // await schreiben — sonst schreibt ein veralteter Snapshot gelöschte
      // Kopplungen oder schon abgeholte Kommandos zurück.
      const fresh = readJsonFile(PAIRINGS_FILE, {});
      const cur = fresh[aid];
      if (!cur || cur.acct !== sess.acct) return jsonRes(res, 404, { ok: false, error: 'pairing_nicht_gefunden' });
      if (b.name !== undefined) cur.name = String(b.name || '').trim().slice(0, 80) || null;
      if (b.customer !== undefined) cur.customer = String(b.customer || '').trim().slice(0, 80) || null;
      if (b.sizeKwp !== undefined) cur.sizeKwp = Number.isFinite(Number(b.sizeKwp)) && Number(b.sizeKwp) > 0 ? Math.round(Number(b.sizeKwp) * 10) / 10 : null;
      writeJsonFile(PAIRINGS_FILE, fresh);
      return jsonRes(res, 200, { ok: true, pairing: pairingView(cur) });
    }
    if (sub === '/accept' && method === 'POST') {
      if (pr.status !== 'requested') return jsonRes(res, 409, { ok: false, error: 'keine_offene_anfrage' });
      pr.status = 'approved';
      pr.approvedAt = nowIso();
      writeJsonFile(PAIRINGS_FILE, pairings);
      return jsonRes(res, 200, { ok: true, pairing: pairingView(pr) });
    }
    if (sub === '/decline' && method === 'POST') {
      if (pr.status !== 'requested') return jsonRes(res, 409, { ok: false, error: 'keine_offene_anfrage' });
      pr.status = 'declined';
      writeJsonFile(PAIRINGS_FILE, pairings);
      return jsonRes(res, 200, { ok: true, pairing: pairingView(pr) });
    }
    if (sub === '/command' && method === 'POST') {
      const b = await readBody(req);
      // Store ERST nach dem Body frisch lesen und ohne weiteres await
      // schreiben — sonst überschreibt ein veralteter Snapshot zwischenzeitliche
      // Polls/Ergebnisse/Löschungen.
      const fresh = readJsonFile(PAIRINGS_FILE, {});
      const cur = fresh[aid];
      if (!cur || cur.acct !== sess.acct) return jsonRes(res, 404, { ok: false, error: 'pairing_nicht_gefunden' });
      if (cur.status !== 'approved') return jsonRes(res, 409, { ok: false, error: 'anlage_nicht_freigegeben' });
      const type = String(b.type || '');
      if (!['open_tunnel', 'close_tunnel', 'updates_check', 'license_activate'].includes(type)) {
        return jsonRes(res, 400, { ok: false, error: 'unbekanntes_kommando' });
      }
      // Ohne aktive Pro-Lizenz nur „Lizenz einspielen“ (DVhub prüft es selbst
      // noch einmal). Ältere Anlagen melden keine Lizenz → nicht blockieren.
      if (type !== 'license_activate' && cur.license && cur.license.proActive === false) {
        return jsonRes(res, 409, { ok: false, error: 'lizenz_erforderlich' });
      }
      let args = {};
      if (type === 'open_tunnel') {
        const ttlMin = Number(b.args?.ttlMin);
        if (Number.isFinite(ttlMin)) args = { ttlMin };
      } else if (type === 'license_activate') {
        // Wie DVhub (normalizeKey): Leerzeichen/Zeilenumbrüche aus kopierten
        // Mails entfernen, dann prüfen — druckbar, begrenzte Länge.
        const key = String(b.args?.key || '').replace(/\s+/g, '');
        if (!/^[\x21-\x7e]{8,512}$/.test(key)) return jsonRes(res, 400, { ok: false, error: 'lizenzschluessel_ungueltig' });
        args = { key };
      }
      const cmd = { id: crypto.randomBytes(8).toString('hex'), type, args, queuedAt: nowIso() };
      cur.commands = [...(cur.commands || []), cmd].slice(-20);
      writeJsonFile(PAIRINGS_FILE, fresh);
      return jsonRes(res, 200, { ok: true, commandId: cmd.id });
    }
    if (sub === '' && method === 'DELETE') {
      delete pairings[aid];
      writeJsonFile(PAIRINGS_FILE, pairings);
      return jsonRes(res, 200, { ok: true });
    }
  }

  const appliancesForMe = () => Object.values(readJsonFile(APPLIANCES_FILE, {}))
    .filter((a) => a.accountId === sess.acct);

  if (p === '/api/appliances' && method === 'GET') {
    return jsonRes(res, 200, { ok: true, appliances: appliancesForMe() });
  }
  if (p === '/api/appliances' && method === 'POST') {
    const b = await readBody(req);
    // Nur Schema + Host + Port übernehmen: kein Pfad, keine Query/Fragment,
    // keine Zugangsdaten — sonst könnte ein Konto per "…/beliebig?" den
    // angehängten Pfad in die Query schieben und das Portal beliebige interne
    // Endpunkte aufrufen lassen (SSRF). Alle DVhub-Aufrufe hängen feste Pfade an.
    let dvUrl;
    try {
      const u = new URL(String(b.url || '').trim());
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('scheme');
      if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Error('extra');
      dvUrl = u.origin;
    } catch {
      return jsonRes(res, 400, { ok: false, error: 'url_nur_schema_host_port' });
    }
    const name = String(b.name || '').trim() || dvUrl.replace(/^https?:\/\//, '');
    const certPem = fs.readFileSync(path.join(keyDirFor(sess.acct, acct), 'cert.pem'), 'utf8');
    let r;
    try {
      r = await fetchJson(new URL('/api/installer/register', dvUrl).href, {
        method: 'POST', body: { name: acct.name, company: acct.company, cert: certPem }, timeoutMs: 10000,
      });
    } catch (e) {
      return jsonRes(res, 502, { ok: false, error: 'dvhub_nicht_erreichbar', detail: String(e.message || e) });
    }
    if (!r.ok || !r.body?.installerId) {
      return jsonRes(res, 502, { ok: false, error: r.body?.error || `dvhub_http_${r.status}` });
    }
    const apps = readJsonFile(APPLIANCES_FILE, {});
    const id = crypto.randomBytes(8).toString('hex');
    apps[id] = {
      id, accountId: sess.acct, name, url: dvUrl,
      installerId: r.body.installerId,
      pairingCode: r.body.pairingCode || null,   // dem Kunden nennen!
      paired: false, session: null, applianceId: null,
      addedAt: nowIso(), lastLoginAt: null,
    };
    writeJsonFile(APPLIANCES_FILE, apps);
    return jsonRes(res, 201, { ok: true, appliance: apps[id] });
  }

  const apMatch = /^\/api\/appliances\/([a-f0-9]+)(\/[a-z/-]+)?$/.exec(p);
  if (apMatch) {
    const apps = readJsonFile(APPLIANCES_FILE, {});
    const ap = apps[apMatch[1]];
    if (!ap || ap.accountId !== sess.acct) return jsonRes(res, 404, { ok: false, error: 'anlage_nicht_gefunden' });
    const sub = apMatch[2] || '';

    if (p === `/api/appliances/${ap.id}` && method === 'DELETE') {
      delete apps[ap.id];
      writeJsonFile(APPLIANCES_FILE, apps);
      return jsonRes(res, 200, { ok: true });
    }
    // Kopplung prüfen: Login-Versuch — schlägt fehl, solange der Kunde den
    // Code noch nicht bestätigt hat (installer_not_active).
    if (sub === '/try-pair' && method === 'POST') {
      try {
        const lg = await loginToAppliance(ap);
        return jsonRes(res, 200, { ok: true, paired: true, expiresAt: lg.expiresAt });
      } catch (e) {
        const code = String(e.message || e);
        const hint = code === 'installer_not_active'
          ? 'Der Kunde hat den Kopplungs-Code noch nicht bestätigt.'
          : code;
        return jsonRes(res, 200, { ok: false, paired: false, hint });
      }
    }
    // Alles Weitere ist ein Durchreichen an DVhub (Session automatisch).
    const DELEGATES = {
      '/info': ['GET'], '/status': ['GET'], '/history': ['GET'],
      '/updates': ['GET'], '/updates/apply': ['POST'],
      '/tunnel/status': ['GET'], '/tunnel/open': ['POST'], '/tunnel/close': ['POST'],
    };
    const DV_PATHS = {
      '/info': '/api/installer/info', '/status': '/api/installer/status',
      '/history': '/api/installer/history/summary', '/updates': '/api/installer/updates/check',
      '/updates/apply': '/api/installer/updates/apply',
      '/tunnel/status': '/api/installer/support-tunnel/status',
      '/tunnel/open': '/api/installer/support-tunnel/open',
      '/tunnel/close': '/api/installer/support-tunnel/close',
    };
    if (DV_PATHS[sub] && DELEGATES[sub].includes(method)) {
      if (!ap.paired) return jsonRes(res, 409, { ok: false, error: 'anlage_noch_nicht_gekoppelt' });
      let body = null;
      if (method === 'POST') body = await readBody(req);
      let r;
      // GET-Query (z. B. /history?view=month&date=…) an die feste DVhub-Route
      // durchreichen — der Pfad bleibt fest, nur Suchparameter wandern mit.
      const query = method === 'GET' ? url.search : '';
      try { r = await dvhubCall(ap, DV_PATHS[sub], { method, body, query }); }
      catch (e) {
        const code = String(e.message || e);
        // Re-Login scheitert fachlich (nicht technisch): klar benennen.
        if (code === 'installer_not_active' || code === 'installer_not_found') {
          return jsonRes(res, 403, { ok: false, error: 'zugang_vom_kunden_widerrufen' });
        }
        if (code === 'certificate_expired') return jsonRes(res, 403, { ok: false, error: 'zertifikat_abgelaufen' });
        if (code === 'installer_portal_disabled') return jsonRes(res, 503, { ok: false, error: 'installer_portal_disabled' });
        return jsonRes(res, 502, { ok: false, error: 'dvhub_nicht_erreichbar', detail: code });
      }
      // Status kompakt vorbereiten, damit das Frontend nicht den ganzen
      // Leitstands-Payload verarbeiten muss.
      if (sub === '/status' && r.ok && r.body) {
        const v = r.body.victron || {};
        return jsonRes(res, 200, {
          ok: true,
          compact: {
            soc: v.soc, batteryPowerW: v.batteryPowerW, pvTotalW: v.pvTotalW ?? v.pvPowerW,
            gridSetpointW: v.gridSetpointW, minSocPct: v.minSocPct,
            alarms: r.body.victronAlarms?.active || [],
            emergencyStop: !!r.body.emergencyStop?.active,
            telemetryFrozen: !!r.body.telemetryFreeze?.active,
            supportTunnelOpen: !!r.body.supportTunnel?.open,
            ts: nowIso(),
          },
        });
      }
      return jsonRes(res, r.status || 502, r.body ?? { ok: false, error: 'leere_antwort' });
    }
  }
  return jsonRes(res, 404, { ok: false, error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    // Host-Header ist Nutzereingabe ("Host: [" wirft) — nie außerhalb des
    // Fehler-Blocks parsen, sonst beendet eine unbehandelte Rejection den Prozess.
    url = new URL(req.url, 'http://portal.local');
  } catch {
    res.writeHead(400); return res.end('bad request');
  }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    // Statische Dateien
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(STATIC_DIR, file);
    if (!full.startsWith(STATIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`DVhub Installateurs-portal: http://localhost:${PORT}`);
  console.log(`Datenverzeichnis: ${DATA_DIR}`);
  if (!WEBAUTHN_ORIGIN) {
    console.warn('WARNUNG: WEBAUTHN_ORIGIN nicht gesetzt — Passkey-rpId/Origin kommen aus den Request-Headern. Für Online-Betrieb setzen (z. B. https://portal.example.de).');
  }
  const existing = readJsonFile(ACCOUNTS_FILE, {});
  for (const name of ADMIN_ACCOUNTS) {
    if (!existing[name]) {
      console.warn(`WARNUNG: Admin-Name "${name}" ist noch kein Konto — nur mit ADMIN_SETUP_TOKEN anlegbar${ADMIN_SETUP_TOKEN ? '' : ' (ADMIN_SETUP_TOKEN ist NICHT gesetzt)'}.`);
    }
  }
});
