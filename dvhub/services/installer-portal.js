// services/installer-portal.js — Installateur-Portal-Anbindung (T-INSTALLER-PORTAL).
//
// Trust model: ein Installateur legt sich im (externen) Installateurs-Portal ein
// Konto an; das Portal besitzt ein Key-Paar. Der PUBLIC key (X.509-Zertifikat)
// wird hier gegen die DVhub-Anlage "gekoppelt" — die Kopplung muss der Kunde
// einmalig per Kopplungs-Code (Pairing) in der eigenen DVhub-Oberfläche
// bestätigen (analog zum Support-Tunnel: nichts geht ohne Kunden-Opt-In).
//
// Nach der Aktivierung authentisiert sich das Portal gegen die Anlage per
// Challenge/Response: die Anlage sendet einen einmaligen Nonce, das Portal
// signiert ihn mit dem PRIVATE key (RSA/ECDSA/Ed25519), die Anlage verifiziert
// mit dem hinterlegten Zertifikat. Es verlässt niemals ein Secret das Portal —
// der Private Key wird nie über das Netz übertragen. Transportverschlüsselung
// übernimmt TLS (HTTPS-Listener der Anlage bzw. der Support-Tunnel-Relay).
//
// Die Signatur ist an Kontext gebunden (Domain-Separation + applianceId), damit
// eine abgefangene Signatur nicht gegen eine andere Anlage replayt:
//   "dvhub-installer-v1\n<applianceId>\n<installerId>\n<challenge>"
//
//Erfolgreich authentisiert gibt es ein kurzlebiges Session-Token (HMAC-signiert, TTL konfigurierbar),
// mit dem die Les-/Steuer-Endpunkte (/api/installer/*) benutzt werden.
//
// Persistenz: ${DATA_DIR}/installer-portal.json (atomiarer Schreib). In-Memory:
// ausstehende Challenges (one-shot, 60s TTL) — ein Neustart verwirft nur
// halbfertige Logins, keine Kopplungen.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readApplianceId } from './support-tunnel.js';

export const SIGNATURE_CONTEXT = 'dvhub-installer-v1';
export const CHALLENGE_TTL_MS = 60_000;
export const SESSION_TTL_MS_DEFAULT = 60 * 60_000;
export const INSTALLER_ID_RE = /^[a-f0-9]{8,32}$/;
export const PAIRING_CODE_RE = /^\d{6}$/;
// Offene (unbestätigte) Kopplungsanfragen verfallen nach 30 min und sind auf
// 5 gleichzeitig begrenzt — register ist WAN-offen, ein Spammer darf weder den
// Store fluten noch die Plätze aktiver Installateure blockieren.
export const PENDING_TTL_MS = 30 * 60_000;
export const MAX_PENDING = 5;
export const MAX_ACTIVE = 20;
export const SECRET_FILE_NAME = 'installer-portal-secret';

// ── certificate helpers ──────────────────────────────────────────────────────

// Parse + basic-validate an X.509 PEM certificate. Throws Error with a stable
// machine-readable code suffix so routes can map to error strings. Returns:
//   { fingerprint, subject, cn, notBefore, notAfter, keyType }
// fingerprint = uppercase hex SHA-256 over the DER encoding (matches
// `openssl x509 -fingerprint -sha256`).
export function parseInstallerCertificate(pem) {
  const s = String(pem || '').trim();
  if (!s.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('invalid_certificate: PEM block expected');
  }
  let cert;
  try {
    cert = new crypto.X509Certificate(s);
  } catch (e) {
    throw new Error(`invalid_certificate: ${e.message}`);
  }
  const notBefore = Date.parse(cert.validFrom);
  const notAfter = Date.parse(cert.validTo);
  const now = Date.now();
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    throw new Error('invalid_certificate: unparseable validity window');
  }
  if (notAfter <= now) throw new Error('certificate_expired');
  if (notBefore > now) throw new Error('certificate_not_yet_valid');
  let keyType = '';
  try { keyType = String(cert.publicKey.asymmetricKeyType || ''); } catch { /* opaque key */ }
  if (!keyType) throw new Error('unsupported_key: opaque public key');
  // X509Certificate#fingerprint is a SHA-1 getter (no method form in Node);
  // compute SHA-256 over the DER (cert.raw) — matches `openssl -fingerprint -sha256`.
  const fingerprint = crypto.createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
  return {
    fingerprint,
    subject: cert.subject || '',
    cn: cert.subject ? parseSubjectCn(cert.subject) : '',
    notBefore: new Date(notBefore).toISOString(),
    notAfter: new Date(notAfter).toISOString(),
    keyType,
  };
}

// Extract CN=... from an OpenSSL-style subject block ("CN=Firma X\nO=Y").
function parseSubjectCn(subject) {
  for (const line of String(subject).split('\n')) {
    const m = /^CN=(.+)$/.exec(line.trim());
    if (m) return m[1];
  }
  return '';
}

// The exact bytes a client must sign for challenge/response.
export function buildSignaturePayload({ applianceId, installerId, challenge }) {
  return `${SIGNATURE_CONTEXT}\n${applianceId}\n${installerId}\n${challenge}`;
}

// Verify a base64 signature over buildSignaturePayload with the installer's
// certificate public key. asymmetricKeyType 'ed25519'/'ed448' implies
// dsaEncoding-less verify (Node handles it via algorithm null). Never throws.
export function verifyChallengeSignature({ certPem, applianceId, installerId, challenge, signatureB64 }) {
  try {
    const sig = Buffer.from(String(signatureB64 || ''), 'base64');
    if (!sig.length || sig.length > 512) return false;
    const data = Buffer.from(buildSignaturePayload({ applianceId, installerId, challenge }));
    let key;
    try { key = new crypto.X509Certificate(certPem).publicKey; } catch { return false; }
    return crypto.verify(null, data, key, sig);
  } catch {
    return false;
  }
}

// ── session tokens ───────────────────────────────────────────────────────────
// Token shape: base64url(payload-json).base64url(hmac-sha256). Payload is NOT
// encrypted (contains only ids + expiry) — the HMAC binds it, so a stolen
// token cannot be forged and a revoked installer's tokens die with the next
// verify (revocation is re-checked against the store at verify time too).

// gen = Session-Generation des Installateurs: ein Widerruf zählt sie hoch, damit
// alte Tokens auch nach einem erneuten Koppeln (gleiche Installer-ID) tot bleiben.
export function signSessionToken({ signingKey, installerId, fingerprint, ttlMs, now = Date.now(), gen = 0 }) {
  const payload = { iid: installerId, fp: fingerprint.slice(0, 16), exp: now + ttlMs, g: gen };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', signingKey).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifySessionToken({ signingKey, token, now = Date.now() }) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', signingKey).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.iid !== 'string' || !INSTALLER_ID_RE.test(payload.iid)) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
  return { installerId: payload.iid, gen: Number.isInteger(payload.g) ? payload.g : 0 };
}

// ── store / service factory ──────────────────────────────────────────────────

export function createInstallerPortal(ctx = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const now = deps.now || (() => Date.now());
  const randomId = deps.randomId || (() => crypto.randomBytes(8).toString('hex'));
  const randomCode = deps.randomCode || (() => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'));
  const randomNonce = deps.randomNonce || (() => crypto.randomBytes(24).toString('base64url'));
  const pushLog = (typeof ctx?.pushLog === 'function') ? ctx.pushLog : () => {};
  const getCfg = (typeof ctx?.getCfg === 'function') ? ctx.getCfg : (() => ({}));

  function dataDir() {
    if (typeof ctx?.getDataDir === 'function') return ctx.getDataDir() || '.';
    return process.env.DV_DATA_DIR || '.';
  }
  function storePath() { return path.join(dataDir(), 'installer-portal.json'); }

  function load() {
    try {
      const raw = JSON.parse(fsImpl.readFileSync(storePath(), 'utf8'));
      if (raw && Array.isArray(raw.installers)) return { installers: raw.installers };
    } catch { /* first boot — empty store */ }
    return { installers: [] };
  }
  function save(store) {
    const p = storePath();
    const tmp = `${p}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fsImpl.renameSync(tmp, p);
  }

  // Session-HMAC-Key: zufälliges 32-Byte-Secret in DATA_DIR (0600), einmal
  // erzeugt und dann wiederverwendet — überlebt Neustarts. Früher aus dem
  // apiToken abgeleitet; ohne Token war das eine öffentlich bekannte Konstante
  // (Session-Tokens fälschbar). Ist DATA_DIR nicht beschreibbar, bleibt der
  // Key nur im Speicher (Sessions sterben dann mit dem Neustart — sicher).
  let cachedKey = null;
  function signingKey() {
    if (cachedKey) return cachedKey;
    const p = path.join(dataDir(), SECRET_FILE_NAME);
    try {
      const hex = String(fsImpl.readFileSync(p, 'utf8')).trim();
      if (/^[a-f0-9]{64}$/.test(hex)) { cachedKey = Buffer.from(hex, 'hex'); return cachedKey; }
    } catch { /* noch nicht angelegt */ }
    const fresh = crypto.randomBytes(32);
    try { fsImpl.writeFileSync(p, fresh.toString('hex'), { mode: 0o600 }); } catch { /* read-only → nur RAM */ }
    cachedKey = fresh;
    return cachedKey;
  }

  function applianceId() {
    return readApplianceId(dataDir(), fsImpl) || 'unknown-appliance';
  }

  // Opt-in: ohne ausdrückliches enabled=true bleibt die gesamte Portal-
  // Anbindung zu (WAN-Endpunkte register/login UND der ausgehende Poll-Client).
  function enabled() {
    const cfg = getCfg() || {};
    return cfg.installerPortal?.enabled === true;
  }

  // Kunden-Freigaben für eingreifende Aktionen. Die Kopplung allein erlaubt
  // nur Lesen (Status/Historie/Update-Check); Support-Tunnel öffnen und
  // Updates einspielen braucht je einen eigenen Haken des Kunden.
  function permissions() {
    const ip = (getCfg() || {}).installerPortal || {};
    return { allowTunnel: ip.allowTunnel === true, allowUpdates: ip.allowUpdates === true };
  }

  function sessionTtlMs() {
    const raw = Number(getCfg()?.installerPortal?.sessionTtlMin);
    if (!Number.isFinite(raw) || raw <= 0) return SESSION_TTL_MS_DEFAULT;
    return Math.min(24 * 60, Math.max(5, Math.round(raw))) * 60_000;
  }

  function publicView(inst) {
    return {
      id: inst.id,
      name: inst.name,
      company: inst.company || '',
      cn: inst.cn || '',
      fingerprint: inst.fingerprint,
      keyType: inst.keyType || '',
      status: inst.status,
      createdAt: inst.createdAt,
      confirmedAt: inst.confirmedAt || null,
      revokedAt: inst.revokedAt || null,
      lastSeenAt: inst.lastSeenAt || null,
      certExpiresAt: inst.notAfter || null,
    };
  }

  function get(installerId) {
    if (!installerId || !INSTALLER_ID_RE.test(String(installerId))) return null;
    return load().installers.find((i) => i.id === String(installerId)) || null;
  }

  function list() {
    const t = now();
    return load().installers.filter((i) => !isPendingExpired(i, t)).map(publicView);
  }

  // Register (or re-submit) an installer certificate. Returns
  // { installer, pairingCode, alreadyRegistered }. Re-submitting the same
  // fingerprint refreshes name/company and re-issues a pairing code; an ACTIVE
  // installer that re-registers the same cert stays active (cert renewal path).
  function isPendingExpired(inst, t = now()) {
    if (inst.status !== 'pending') return false;
    const issued = Date.parse(inst.pairingIssuedAt || inst.createdAt || 0);
    return !Number.isFinite(issued) || t - issued > PENDING_TTL_MS;
  }
  function pruneExpiredPending(store) {
    const before = store.installers.length;
    const t = now();
    store.installers = store.installers.filter((i) => !isPendingExpired(i, t));
    return store.installers.length !== before;
  }

  function register({ name, company, certPem }) {
    const cert = parseInstallerCertificate(certPem);
    const store = load();
    pruneExpiredPending(store);
    const cleanName = String(name || '').trim().slice(0, 80);
    if (!cleanName) throw new Error('name_required');
    const cleanCompany = String(company || '').trim().slice(0, 120);
    const existing = store.installers.find((i) => i.fingerprint === cert.fingerprint);
    const pairingCode = randomCode();
    if (existing) {
      // Das Zertifikat ist öffentlich — wer es kennt, darf einen AKTIVEN
      // Eintrag nicht umbenennen (sonst sähe der Kunde einen falschen Namen).
      if (existing.status !== 'active') {
        existing.name = cleanName || existing.name;
        existing.company = cleanCompany || existing.company;
      }
      existing.certPem = certPem;
      existing.notAfter = cert.notAfter;
      existing.keyType = cert.keyType;
      // Active certs keep their status on renewal; pending ones get a new code
      // (and a fresh TTL). A revoked installer may ask again — it goes back to
      // pending and needs a fresh customer confirmation like a new one.
      if (existing.status === 'revoked') {
        if (store.installers.filter((i) => i.status === 'pending').length >= MAX_PENDING) {
          throw new Error('installer_pending_limit');
        }
        existing.status = 'pending';
      }
      existing.pairingCode = existing.status === 'pending' ? pairingCode : null;
      if (existing.status === 'pending') existing.pairingIssuedAt = new Date(now()).toISOString();
      save(store);
      return { installer: publicView(existing), pairingCode: existing.pairingCode, alreadyRegistered: true };
    }
    if (store.installers.filter((i) => i.status === 'active').length >= MAX_ACTIVE) {
      throw new Error('installer_limit_reached');
    }
    if (store.installers.filter((i) => i.status === 'pending').length >= MAX_PENDING) {
      throw new Error('installer_pending_limit');
    }
    const inst = {
      id: randomId(),
      name: cleanName,
      company: cleanCompany,
      certPem: String(certPem),
      fingerprint: cert.fingerprint,
      cn: cert.cn,
      keyType: cert.keyType,
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
      status: 'pending',
      pairingCode,
      pairingIssuedAt: new Date(now()).toISOString(),
      createdAt: new Date(now()).toISOString(),
      confirmedAt: null,
      revokedAt: null,
      lastSeenAt: null,
    };
    store.installers.push(inst);
    save(store);
    pushLog('installer_registered', { installerId: inst.id, fingerprint: cert.fingerprint.slice(0, 16) });
    return { installer: publicView(inst), pairingCode, alreadyRegistered: false };
  }

  // Customer-side confirmation (must be reached via LAN/apiToken, never by the
  // portal itself): activates a pending installer that presented the pairing
  // code shown in the DVhub UI.
  function confirm({ installerId, pairingCode }) {
    const store = load();
    const inst = store.installers.find((i) => i.id === String(installerId || ''));
    if (!inst) throw new Error('installer_not_found');
    if (inst.status === 'active') return { installer: publicView(inst), alreadyActive: true };
    if (inst.status !== 'pending') throw new Error('installer_not_pending');
    if (isPendingExpired(inst)) throw new Error('pairing_code_expired');
    if (!PAIRING_CODE_RE.test(String(pairingCode || '')) || pairingCode !== inst.pairingCode) {
      throw new Error('pairing_code_invalid');
    }
    inst.status = 'active';
    inst.confirmedAt = new Date(now()).toISOString();
    inst.pairingCode = null;
    save(store);
    pushLog('installer_pairing_confirmed', { installerId: inst.id });
    return { installer: publicView(inst), alreadyActive: false };
  }

  function revoke({ installerId }) {
    const store = load();
    const inst = store.installers.find((i) => i.id === String(installerId || ''));
    if (!inst) throw new Error('installer_not_found');
    inst.status = 'revoked';
    inst.revokedAt = new Date(now()).toISOString();
    // Alle bisher ausgestellten Sessions endgültig ungültig machen — auch für
    // den Fall, dass derselbe Installateur später erneut gekoppelt wird.
    inst.sessionGen = (inst.sessionGen || 0) + 1;
    inst.pairingCode = null;
    save(store);
    pushLog('installer_revoked', { installerId: inst.id });
    return { installer: publicView(inst) };
  }

  // ── challenge/response login ───────────────────────────────────────────────
  // In-memory one-shot challenges. Keyed by installerId; a fresh request
  // replaces the outstanding challenge for the same installer.
  const challenges = new Map(); // installerId -> { challenge, expiresAt }

  function pruneChallenges() {
    const t = now();
    for (const [k, v] of challenges) if (v.expiresAt <= t) challenges.delete(k);
  }

  // Gültigkeitsfenster des hinterlegten Zertifikats gilt nicht nur bei der
  // Registrierung, sondern für jeden Login und jede Session.
  function certExpired(inst) {
    const na = Date.parse(inst?.notAfter || '');
    return !Number.isFinite(na) || na <= now();
  }

  function issueChallenge(installerId) {
    const inst = get(installerId);
    if (!inst) throw new Error('installer_not_found');
    if (inst.status !== 'active') throw new Error('installer_not_active');
    if (certExpired(inst)) throw new Error('certificate_expired');
    pruneChallenges();
    const challenge = randomNonce();
    challenges.set(installerId, { challenge, expiresAt: now() + CHALLENGE_TTL_MS });
    return {
      challenge,
      applianceId: applianceId(),
      expiresInMs: CHALLENGE_TTL_MS,
      signaturePayloadHint: `${SIGNATURE_CONTEXT}\\n<applianceId>\\n${installerId}\\n<challenge>`,
    };
  }

  // Consumes the challenge (one-shot, even on failure → brute forcers must
  // re-request a challenge every attempt, which the rate limiter caps).
  function verifyLogin({ installerId, challenge, signature }) {
    pruneChallenges();
    const pending = challenges.get(String(installerId || ''));
    if (!pending) throw new Error('challenge_unknown');
    challenges.delete(String(installerId || ''));
    if (pending.challenge !== String(challenge || '')) throw new Error('challenge_mismatch');
    const inst = get(installerId);
    if (!inst || inst.status !== 'active') throw new Error('installer_not_active');
    if (certExpired(inst)) throw new Error('certificate_expired');
    const ok = verifyChallengeSignature({
      certPem: inst.certPem,
      applianceId: applianceId(),
      installerId: String(installerId),
      challenge: pending.challenge,
      signatureB64: signature,
    });
    if (!ok) {
      pushLog('installer_login_bad_signature', { installerId: String(installerId) });
      throw new Error('signature_invalid');
    }
    const ttl = sessionTtlMs();
    const token = signSessionToken({
      signingKey: signingKey(),
      installerId: inst.id,
      fingerprint: inst.fingerprint,
      ttlMs: ttl,
      now: now(),
      gen: inst.sessionGen || 0,
    });
    // lastSeen bookkeeping (best-effort — never block a login on fs pain)
    try {
      const store = load();
      const live = store.installers.find((i) => i.id === inst.id);
      if (live) { live.lastSeenAt = new Date(now()).toISOString(); save(store); }
    } catch { /* ignore */ }
    pushLog('installer_login', { installerId: inst.id });
    return { sessionToken: token, expiresAt: new Date(now() + ttl).toISOString(), installer: publicView(inst) };
  }

  // Session gate for the data endpoints. Verifies HMAC + expiry AND re-checks
  // the store, so revocation takes effect immediately (≤ the fs read, no
  // waiting for token expiry).
  function verifySession(token) {
    const v = verifySessionToken({ signingKey: signingKey(), token, now: now() });
    if (!v) return null;
    const inst = get(v.installerId);
    if (!inst || inst.status !== 'active' || certExpired(inst)) return null;
    if (v.gen !== (inst.sessionGen || 0)) return null; // vor einem Widerruf ausgestellt
    return { installer: publicView(inst), installerId: inst.id };
  }

  function touchSession(installerId) {
    try {
      const store = load();
      const live = store.installers.find((i) => i.id === String(installerId));
      if (live) { live.lastSeenAt = new Date(now()).toISOString(); save(store); }
    } catch { /* best-effort */ }
  }

  // ── CSRF-Nonce für die Kunden-Endpunkte ──────────────────────────────────
  // Bei lanTrust 'open' kommen Kunden-Calls ohne Credentials durch; parseBody
  // akzeptiert JSON auch als text/plain (kein Preflight). Eine fremde Webseite
  // im Browser des Kunden könnte so ein Angreifer-Portal koppeln oder Freigaben
  // setzen. Deshalb verlangen privilegien-ERWEITERNDE Aufrufe (koppeln,
  // bestätigen, einschalten/freigeben) diesen Nonce oder einen gültigen Bearer.
  // Ausgeliefert wird er nur per GET /api/installer/settings — cross-origin
  // nicht lesbar. Mehrfach nutzbar innerhalb der TTL (mehrere Schalter
  // hintereinander), danach rotiert er.
  const UI_TOKEN_TTL_MS = 10 * 60_000;
  let uiToken = null;
  let uiTokenAt = 0;
  function issueUiToken() {
    const t = now();
    if (!uiToken || t - uiTokenAt > UI_TOKEN_TTL_MS) {
      uiToken = crypto.randomBytes(16).toString('hex');
      uiTokenAt = t;
    }
    return uiToken;
  }
  function checkUiToken(candidate) {
    if (!uiToken || typeof candidate !== 'string') return false;
    if (now() - uiTokenAt > UI_TOKEN_TTL_MS) { uiToken = null; return false; }
    const a = Buffer.from(candidate), b = Buffer.from(uiToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Public surface for routes-api.js / status payloads.
  return {
    enabled,
    permissions,
    issueUiToken,
    checkUiToken,
    applianceId,
    signingKey,
    sessionTtlMs,
    register,
    confirm,
    revoke,
    get,
    list,
    issueChallenge,
    verifyLogin,
    verifySession,
    touchSession,
    publicView,
  };
}
