// services/tariff-provider/luox-client.js — LUOX-Kundenportal (Lumenaza),
// inoffizielle Portal-Schnittstelle mit den eigenen Zugangsdaten der Kundin.
//
// Übernommen aus Christins Vorarbeit ~/Projects/REA/luox (luox_api.py,
// ENDPOINTS.md, live verifiziert 11.11.2026). Die LUOX-App ist nur eine Hülle
// (TWA) um https://portal.luox-energy.de; dessen JSON-API ist die „App-API“.
//   Anmeldung  GET /login → CSRF-Feld + Cookies, POST /api/login/ (JSON) →
//              { user_id, token, refresh_token }; Token = Keycloak-JWT, ~7 Tage
//   Refresh    POST /api/refresh_token/ { token, refresh_token } → rotiert
//              BEIDE Werte: Das alte Paar gilt danach nicht mehr.
//   Daten      GET /api/<pfad> mit Authorization: Bearer <JWT>; abgelehntes
//              Token = Umleitung (302) auf /login
// Inoffiziell: LUOX/Lumenaza kann das jederzeit ändern.
//
// Nur lesen: Das Portal kennt auch Schreib-Endpunkte (edit_*_data,
// new_password, new_username, terminate_contract, create/update_control_resource,
// logout). Der Client lässt per Freigabeliste nur die lesenden GET-Pfade zu
// (assertReadOnlyPath); POST gibt es nur für Anmeldung und Refresh.
//
// Tokens liegen gebunden an E-Mail + Passwort im Datenverzeichnis (0600,
// token-cache.js). Weil der Refresh rotiert, wird das neue Paar atomar
// gespeichert, bevor es benutzt wird, und Erneuerungen laufen je Datei
// nacheinander (zweiter Refresh mit dem schon verbrauchten Token schlüge fehl).
// Scheitert der Refresh, folgt einmal die Anmeldung mit Passwort.
// Meldungen enthalten nie Zugangsdaten, Tokens oder Antworttexte des Portals.

import { TariffProviderError, REQUEST_TIMEOUT_MS } from './common.js';
import { writeCache, loadBoundCache, bindingFor } from './token-cache.js';

export const PORTAL_BASE = 'https://portal.luox-energy.de';
export const LOGIN_PAGE_URL = `${PORTAL_BASE}/login`;
export const LOGIN_URL = `${PORTAL_BASE}/api/login/`;
export const REFRESH_URL = `${PORTAL_BASE}/api/refresh_token/`;
const API_BASE = `${PORTAL_BASE}/api/`;
const USER_AGENT = 'DVhub (https://dvhub.online)';
// Ab dieser Restlaufzeit wird das Token vor dem Abruf erneuert.
const REFRESH_BEFORE_MS = 10 * 60_000;
// Token ohne lesbares exp: so lange nach dem Erhalt gilt es als frisch.
const FALLBACK_TOKEN_LIFETIME_MS = 6 * 24 * 60 * 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Lesende Portal-Pfade (unter /api/). Vertragsnummern: Buchstabe + Ziffern +
// Bindestrich; Datum JJJJ-MM-TT. Alles andere ist gesperrt.
const ID = '[A-Za-z0-9][A-Za-z0-9-]{0,40}';
const DATE = '\\d{4}-\\d{2}-\\d{2}';
const READ_ONLY_PATHS = [
  /^config$/,
  /^contracts$/,
  /^epex_price_today\/$/,
  new RegExp(`^products/${ID}/${DATE}/${DATE}$`),
  new RegExp(`^energy_data/${ID}/(?:prod|slp)/(?:LGS|other_then_LGS)/(?:day|month|year)/${DATE}/${DATE}/$`),
  new RegExp(`^epex_price/${ID}/${DATE}/${DATE}/(?:producer|consumer)/$`),
  new RegExp(`^get_plant_details/${ID}$`)
];

/** Wirft, wenn der Pfad kein freigegebener lesender Portal-Pfad ist. */
export function assertReadOnlyPath(p) {
  const s = String(p ?? '');
  if (!READ_ONLY_PATHS.some((rx) => rx.test(s))) {
    throw new TariffProviderError('forbidden_path', `LUOX-Portalpfad nicht freigegeben (nur lesende Abrufe): ${s.slice(0, 80)}`);
  }
  return s;
}

/** CSRF-Wert aus dem Anmeldeformular (input#csrf, sonst Djangos csrfmiddlewaretoken). */
export function extractCsrf(html) {
  const s = String(html || '');
  const inputs = s.match(/<input\b[^>]*>/gi) || [];
  for (const want of [/\bid\s*=\s*["']csrf["']/i, /\bname\s*=\s*["']csrfmiddlewaretoken["']/i]) {
    for (const tag of inputs) {
      if (!want.test(tag)) continue;
      const m = tag.match(/\bvalue\s*=\s*(["'])([^"']+)\1/i);
      if (m) return m[2];
    }
  }
  return null;
}

/** Name → Wert aller Set-Cookie-Kopfzeilen (ohne Attribute). */
export function parseSetCookies(headers) {
  let list = [];
  if (typeof headers?.getSetCookie === 'function') list = headers.getSetCookie() || [];
  if (!list.length) {
    const joined = headers?.get?.('set-cookie');
    // Zusammengefügte Kopfzeile: an Kommas trennen, die einen neuen Cookie beginnen
    if (joined) list = String(joined).split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
  }
  const out = new Map();
  for (const line of list) {
    const first = String(line).split(';')[0].trim();
    const eq = first.indexOf('=');
    if (eq > 0) out.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return out;
}

/** exp-Claim (Sekunden) eines JWT ohne Signaturprüfung, sonst null. */
export function jwtExp(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const data = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return Number.isFinite(data?.exp) ? data.exp : null;
  } catch {
    return null;
  }
}

function networkError(error) {
  const kind = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Zeitüberschreitung' : (error?.cause?.code || error?.name || 'Fehler');
  return new TariffProviderError('network', `LUOX-Portal nicht erreichbar (${kind}).`);
}

async function request(fetchImpl, url, init, timeoutMs) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw networkError(error);
  }
}

async function readText(res) {
  try {
    const text = await res.text();
    return text.length > MAX_BODY_BYTES ? '' : text;
  } catch {
    return '';
  }
}

async function readJson(res) {
  const text = await readText(res);
  try { return text ? JSON.parse(text) : null; } catch { return undefined; }
}

const isRedirect = (status) => status >= 300 && status < 400;

// Je Token-Datei nur eine Erneuerung gleichzeitig (Rotation!).
const renewLocks = new Map();
function withRenewLock(key, fn) {
  const prev = renewLocks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  renewLocks.set(key, tail);
  tail.then(() => { if (renewLocks.get(key) === tail) renewLocks.delete(key); });
  return run;
}

/**
 * @param {{email:string, password:string, cacheFile?:string|null, fetchImpl?:Function, now?:Function, timeoutMs?:number}} opts
 */
export function createLuoxPortalClient({ email, password, cacheFile = null, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  // Ohne Speicherdatei (Verbindungstest mit fremden Zugangsdaten) bleibt das
  // Token nur in diesem Client.
  let memory = null;
  const lockKey = cacheFile || Symbol('luox-memory');

  const baseHeaders = { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' };

  async function loadEntry() {
    if (!cacheFile) return memory;
    return loadBoundCache(cacheFile, email, password);
  }

  async function saveEntry(cached, data) {
    const entry = {
      ...await bindingFor(email, password, cached),
      token: data.token,
      refreshToken: data.refresh_token || null,
      userId: data.user_id ?? cached?.userId ?? null,
      obtainedAt: now()
    };
    if (cacheFile) writeCache(cacheFile, entry);
    memory = entry;
    return entry;
  }

  function fresh(entry) {
    if (!entry?.token) return false;
    const exp = jwtExp(entry.token);
    const expiresAt = exp ? exp * 1000 : Number(entry.obtainedAt || 0) + FALLBACK_TOKEN_LIFETIME_MS;
    return expiresAt - now() > REFRESH_BEFORE_MS;
  }

  async function login() {
    const page = await request(fetchImpl, LOGIN_PAGE_URL, { method: 'GET', headers: { ...baseHeaders, Accept: 'text/html' } }, timeoutMs);
    if (page.status >= 400) throw new TariffProviderError('api', `LUOX-Anmeldeseite antwortet mit HTTP ${page.status}.`);
    const csrf = extractCsrf(await readText(page));
    if (!csrf) throw new TariffProviderError('format', 'LUOX-Anmeldeseite ohne CSRF-Feld (Portal geändert?).');
    const cookies = parseSetCookies(page.headers);
    const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await request(fetchImpl, LOGIN_URL, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf,
        Referer: LOGIN_PAGE_URL,
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify({ username: email, password }),
      redirect: 'manual'
    }, timeoutMs);
    const json = await readJson(res);
    if (res.status === 200 && json?.token) return json;
    if (res.status === 400 || res.status === 401) throw new TariffProviderError('auth', `LUOX-Anmeldung abgelehnt (HTTP ${res.status}) — E-Mail/Passwort prüfen.`);
    if (res.status === 403) throw new TariffProviderError('api', 'LUOX-Anmeldung abgelehnt (HTTP 403, CSRF-Prüfung) — Portal geändert?');
    if (res.status === 200) throw new TariffProviderError('format', 'LUOX-Anmeldung ohne Token in der Antwort.');
    throw new TariffProviderError('api', `LUOX-Anmeldung fehlgeschlagen (HTTP ${res.status}).`);
  }

  async function refresh(entry) {
    const res = await request(fetchImpl, REFRESH_URL, {
      method: 'POST',
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: entry.token, refresh_token: entry.refreshToken }),
      redirect: 'manual'
    }, timeoutMs);
    const json = await readJson(res);
    if (res.status === 200 && json?.token) {
      // Fehlt ein neuer Refresh-Token, den alten behalten
      return { ...json, refresh_token: json.refresh_token || entry.refreshToken, user_id: json.user_id ?? entry.userId };
    }
    return null;
  }

  /** Gültiges Token: Speicher → Refresh (rotiert) → Anmeldung mit Passwort. */
  async function token({ force = false, rejected = null } = {}) {
    if (!email || !password) throw new TariffProviderError('auth', 'E-Mail und Passwort des LUOX-Kundenportals fehlen.');
    if (!force) {
      const current = await loadEntry();
      if (fresh(current)) return current.token;
    }
    return withRenewLock(lockKey, async () => {
      // Ein anderer Abruf hat inzwischen erneuert?
      const cached = await loadEntry();
      // (Nach einer Ablehnung zählt nur ein anderes Token als das abgelehnte.)
      if (cached?.token && cached.token !== rejected && (force || fresh(cached))) return cached.token;
      let data = null;
      if (cached?.refreshToken) {
        try {
          data = await refresh(cached);
        } catch (error) {
          if (error.code === 'network') throw error;
          data = null;
        }
      }
      if (!data) data = await login();
      return (await saveEntry(cached, data)).token;
    });
  }

  async function get(p, kind) {
    const pathOk = assertReadOnlyPath(p);
    const url = `${API_BASE}${pathOk}`;
    let tok = await token();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await request(fetchImpl, url, {
        method: 'GET',
        headers: { ...baseHeaders, Authorization: `Bearer ${tok}` },
        redirect: 'manual'
      }, timeoutMs);
      const rejectedToken = isRedirect(res.status) || res.status === 401 || res.status === 403;
      if (rejectedToken) {
        if (attempt === 0) { tok = await token({ force: true, rejected: tok }); continue; }
        throw new TariffProviderError('auth', 'LUOX-Portal lehnt den Zugriff ab (Token ungültig).');
      }
      if (res.status !== 200) {
        const detail = res.status < 500 ? await readJson(res) : null;
        const hint = typeof detail?.detail === 'string' ? `: ${detail.detail.slice(0, 120)}` : '';
        throw new TariffProviderError('api', `LUOX-Portal antwortet mit HTTP ${res.status}${hint}.`);
      }
      if (kind === 'binary') {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BODY_BYTES) throw new TariffProviderError('format', 'LUOX-Antwort zu groß.');
        return buf;
      }
      const json = await readJson(res);
      if (json === undefined || json === null) throw new TariffProviderError('format', 'LUOX-Portal liefert kein JSON (Portal geändert?).');
      return json;
    }
    throw new TariffProviderError('auth', 'LUOX-Portal lehnt den Zugriff ab.');
  }

  return {
    /** JSON eines freigegebenen lesenden Pfads unter /api/. */
    getJson: (p) => get(p, 'json'),
    /** Binärantwort (Abrechnungs-XLSX) eines freigegebenen lesenden Pfads. */
    getBinary: (p) => get(p, 'binary'),
    /** Nur Anmeldung/Token prüfen. */
    ensureToken: () => token().then(() => true)
  };
}
