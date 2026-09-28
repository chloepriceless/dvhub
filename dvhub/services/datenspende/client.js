// services/datenspende/client.js — Protokoll-Client für die COMSYS-Datenspende
// (RWTH Aachen, https://datenspende.comsys.rwth-aachen.de).
//
// 1:1 nach der offiziellen Home-Assistant-Integration „powercollect“
// (github.com/COMSYS/Datenspende, custom_components/powercollect/api.py,
// Stand 0.3.1 / Commit 28c7371). Eine veröffentlichte API-Doku gibt es nicht —
// Pfade, Statuscodes, Fehlercodes und das Batch-Format stammen aus diesem Code.
//
// Ablauf der Einrichtung (Web-Session, einmalig):
//   sign-up/sign-in → Haushalt anlegen → Client anlegen → API-Key erzeugen → sign-out
// Betrieb (API-Key im Header x-api-key):
//   Zähler registrieren → Messwerte gebündelt an /meters/batch senden.

import zlib from 'node:zlib';

export const DATENSPENDE_BASE_URL = 'https://datenspende.comsys.rwth-aachen.de';
export const MEASUREMENT_FIELDS = ['power', 'energy', 'voltage', 'current'];
// Unter dieser Größe kostet der gzip-Rahmen mehr, als er spart.
const GZIP_MIN_BYTES = 1024;
const TIMEOUT_MS = 5_000;
// Ein Batch trägt bis zu einigen tausend Messwerten — mehr Zeit als die kleinen Aufrufe.
const BATCH_TIMEOUT_MS = 30_000;

// ── Fehlerklassen (wie in der HA-Integration) ──────────────────────────────
// Die Einteilung entscheidet, was mit einem Batch passiert:
//   ConnError      → behalten, später erneut senden (Server nicht erreichbar, 429)
//   ServerError    → Server erreichbar, scheitert am Request (5xx) — begrenzt wiederholen
//   RequestError   → dauerhaft falsch (4xx), Wiederholen hilft nicht → verwerfen
//   AuthError      → Zugangsdaten/Key ungültig
//   DuplicateError → Messwert existiert schon (idempotent) → verwerfen
export class DatenspendeError extends Error {
  constructor(message, code = 'unknown_error', status = 0) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
  }
}
export class DatenspendeConnError extends DatenspendeError {}
export class DatenspendeServerError extends DatenspendeConnError {}
export class DatenspendeRequestError extends DatenspendeError {}
export class DatenspendeAuthError extends DatenspendeError {}
export class DatenspendeDuplicateError extends DatenspendeError {}

const AUTH_CODES = new Set([
  'password_too_short', 'password_too_long', 'username_too_short', 'username_too_long',
  'invalid_username', 'invalid_secret', 'authentication_error', 'invalid_credentials',
  'unauthorized', 'taken_username', 'taken_email', 'validation_email', 'invalid_email',
]);
const REQUEST_CODES = new Set([
  'bad_request', 'unexpected_resource_id', 'missing_fields', 'not_found', 'method_not_allowed',
]);

// HTTP-Antwort → passende Fehlerklasse (Logik aus api.py handle_api_error).
export function classifyError(status, body) {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const code = String(data.error || 'unknown_error');
  const message = String(data.message || 'Unknown error');
  const text = `${status} ${code}: ${message}`;
  if (code === 'duplicate_entry') return new DatenspendeDuplicateError(text, code, status);
  if (AUTH_CODES.has(code) && (status === 400 || status === 401 || status === 409)) {
    return new DatenspendeAuthError(text, code, status);
  }
  if (REQUEST_CODES.has(code) && status >= 400 && status < 500) return new DatenspendeRequestError(text, code, status);
  if (status === 500 && code === 'internal_server_error') return new DatenspendeServerError(text, code, status);
  if (status === 401 || status === 403) return new DatenspendeAuthError(text, code, status);
  // 429 = ausdrücklich „später wieder“ → so lange wiederholen wie nötig.
  if (status === 429) return new DatenspendeConnError(text, code, status);
  if (status >= 500) return new DatenspendeServerError(text, code, status);
  // Alles Unbekannte ist dauerhaft — sonst blockiert ein einziger unbekannter
  // Fehler die Warteschlange für immer.
  return new DatenspendeRequestError(text, code, status);
}

// Messwerte je Zähler in parallele Spalten (Batch-Endpunkt, api.py columnar_payload):
// statt Zähler-ID + Zeitstempel pro Wert gibt es je Zähler eine Liste von
// Sekunden-Abständen zu einem gemeinsamen t0 und je Messgröße eine Spalte;
// fehlt ein Wert, steht dort null, damit alle Spalten gleich lang bleiben.
export function columnarPayload(readings) {
  const base = Date.parse(readings[0].timestamp);
  const meters = new Map();
  for (const r of readings) {
    let m = meters.get(r.meter_id);
    if (!m) { m = { id: r.meter_id, dt: [] }; meters.set(r.meter_id, m); }
    const index = m.dt.length;
    m.dt.push(Math.round((Date.parse(r.timestamp) - base) / 1000));
    for (const field of MEASUREMENT_FIELDS) {
      const v = r[field];
      if (v === undefined || v === null) continue;
      const col = m[field] || (m[field] = []);
      while (col.length < index) col.push(null);
      col.push(v);
    }
  }
  for (const m of meters.values()) {
    for (const field of MEASUREMENT_FIELDS) {
      if (m[field]) while (m[field].length < m.dt.length) m[field].push(null);
    }
  }
  return { t0: readings[0].timestamp, meters: [...meters.values()] };
}

export function createDatenspendeClient({ baseUrl = DATENSPENDE_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  const api = String(baseUrl).replace(/\/+$/, '') + '/api/v1';

  async function call(method, path, { headers = {}, json, body, timeoutMs = TIMEOUT_MS, ok = [200, 201] } = {}) {
    let res;
    try {
      res = await fetchImpl(api + path, {
        method,
        headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: json !== undefined ? JSON.stringify(json) : body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      throw new DatenspendeConnError(`Verbindungsfehler: ${e?.cause?.code || e?.message || e}`, 'connection_error');
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
    if (ok.includes(res.status)) return { status: res.status, data };
    throw classifyError(res.status, data);
  }

  const keyHeaders = (apiKey) => {
    if (!apiKey) throw new DatenspendeAuthError('API-Key fehlt', 'missing_api_key');
    return { 'x-api-key': apiKey };
  };
  const bearer = (token) => ({ authorization: `Bearer ${token}` });

  return {
    // ── Einrichtung (Web-Session) ──
    async signUp({ username, password, email, secret, consent }) {
      if (!consent) throw new DatenspendeAuthError('Ohne Einwilligung keine Teilnahme', 'consent_required');
      const json = { username, password, consent: true };
      if (email) json.email = email;
      if (secret) json.secret = secret;
      const r = await call('POST', '/web/auth/sign-up/username', { json, ok: [201] });
      return { token: r.data?.token, userId: r.data?.user?.id };
    },
    async signIn({ username, password }) {
      const r = await call('POST', '/web/auth/sign-in/username', { json: { username, password }, ok: [200] });
      return { token: r.data?.token, userId: r.data?.user?.id };
    },
    async signOut(token) {
      await call('POST', '/web/auth/sign-out', { headers: bearer(token), ok: [200] });
    },
    async createHousehold(token, { userId, name, numberInhabitants, zip, country }) {
      const json = { userId };
      if (name) json.name = name;
      if (Number.isInteger(numberInhabitants)) json.numberInhabitants = numberInhabitants;
      if (zip) json.zip = zip;
      if (country) json.country = country;
      const r = await call('POST', '/web/households', { headers: bearer(token), json, ok: [201] });
      return r.data?.id;
    },
    async createClient(token, { householdId, name, type }) {
      const r = await call('POST', '/web/clients', { headers: bearer(token), json: { householdId, type, name }, ok: [201] });
      return r.data?.id;
    },
    async createApiKey(token, { clientId, name }) {
      const r = await call('POST', '/web/auth/api-key/create', { headers: bearer(token), json: { clientId, name }, ok: [201] });
      return r.data?.key;
    },

    // ── Betrieb (API-Key) ──
    async getClientId(apiKey) {
      const r = await call('GET', '/clients', { headers: keyHeaders(apiKey), ok: [201, 200] });
      return r.data?.clientId;
    },
    async registerMeter(apiKey, clientId, { name, vendor, model }) {
      const r = await call('POST', `/clients/${encodeURIComponent(clientId)}/meters`, {
        headers: keyHeaders(apiKey), json: { name, vendor, model }, ok: [201],
      });
      return r.data?.meterId;
    },
    // Gibt { accepted, unknownMeters } zurück. Einreichen ist idempotent: schon
    // vorhandene Werte überspringt der Server und zählt sie nicht mit.
    async submitBatch(apiKey, clientId, readings) {
      if (!readings.length) return { accepted: 0, unknownMeters: [] };
      let body = Buffer.from(JSON.stringify(columnarPayload(readings)));
      const headers = { ...keyHeaders(apiKey), 'content-type': 'application/json' };
      if (body.length >= GZIP_MIN_BYTES) {
        body = zlib.gzipSync(body, { level: 6 });
        headers['content-encoding'] = 'gzip';
      }
      const r = await call('POST', `/clients/${encodeURIComponent(clientId)}/meters/batch`, {
        headers, body, timeoutMs: BATCH_TIMEOUT_MS, ok: [201],
      });
      return { accepted: Number(r.data?.accepted) || 0, unknownMeters: Array.isArray(r.data?.unknownMeters) ? r.data.unknownMeters : [] };
    },
  };
}
