// services/tariff-provider/lichtblick-client.js — Viertelstundenpreise des
// Tarifs „ÖkoStrom Dynamic“ über das Backend der LichtBlick-App.
//
// Übernommen aus Christins Vorarbeit github.com/chloepriceless/Lichtblick-Lokal-Preis
// (fetch_prices.py, 2026-10-21): dieselben Endpunkte und Header wie die App.
//   Login  Azure AD B2C, ROPC-Flow (Policy b2c_1a_ropc_signin), Access-Token 1 h,
//          Refresh-Token wird bei jeder Erneuerung rotiert
//   Daten  Apollo-GraphQL POST https://graph.lichtblick.de/
// Inoffiziell: LichtBlick kann das jederzeit ändern. Zugriff nur auf den eigenen
// Vertrag des Kunden, mit seinen eigenen App-Zugangsdaten.
//
// Damit nicht stündlich mit Passwort angemeldet wird, liegen Tokens und
// Vertragsnummer im Datenverzeichnis (0600), gebunden an E-Mail und Passwort:
// Mit anderen Zugangsdaten gilt der Zwischenspeicher nicht.
//
// Laut AGB (Sept. 2026) ist der Spotpreis der IDA1-Preis (SIDC, ~15 Uhr am
// Vortag); Schrittweite, brutto/netto und enthaltene Netzentgelte sind erst ab
// dem ersten Liefertag an echten Daten prüfbar (Stand 21.10.2026: ungeprüft).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { TariffProviderError, postJson, pointsToSlots, localDateOf, addDaysToDate, localMidnight } from './common.js';

const pbkdf2 = promisify(crypto.pbkdf2);

export const B2C_TOKEN_URL = 'https://anmelden.lichtblick.de/lichtblickitb2cprod.onmicrosoft.com/oauth2/v2.0/token?p=b2c_1a_ropc_signin';
export const B2C_CLIENT_ID = 'c6079bc3-9572-4da7-abb7-b69694239976';
export const B2C_SCOPE = [
  'openid', 'offline_access', 'profile',
  'https://lichtblickitb2cprod.onmicrosoft.com/graph-gateway/app-backend.access',
  'https://lichtblickitb2cprod.onmicrosoft.com/graph-gateway/service-view.access'
].join(' ');
export const GRAPH_URL = 'https://graph.lichtblick.de/';
const GRAPH_HEADERS = Object.freeze({
  'apollographql-client-name': 'lichtblick-app-android',
  'apollographql-client-version': '3.9.0'
});
const TIME_ZONE = 'Europe/Berlin';

export const SELECTABLE_CONTRACTS = `query SelectableContracts {
  b2cCustomer {
    __typename id
    appSelectableContracts {
      __typename
      contracts { __typename b2cContractId productName category }
    }
  }
}`;

export const ENERGY_PRICE_CURVES = `query EnergyPriceCurves($contractId: Int!, $startToday: DateTime!, $endToday: DateTime!,
                        $startTomorrow: DateTime!, $endTomorrow: DateTime!) {
  todayPriceCurves: energyPriceCurves(input: { powerCloudContractId: $contractId,
    priceCurveAggregation: DAY, start: $startToday, end: $endToday }) {
    __typename ...EnergyPriceCurvesFragment }
  tomorrowPriceCurves: energyPriceCurves(input: { powerCloudContractId: $contractId,
    priceCurveAggregation: DAY, start: $startTomorrow, end: $endTomorrow }) {
    __typename ...EnergyPriceCurvesFragment }
}
fragment EnergyPriceCurvesFragment on EnergyPriceCurvesPayload {
  __typename
  energyPriceCurvesResponse {
    __typename
    energyPricesInCents { __typename valueInCents time }
    averagePriceInCents
  }
}`;

// ── Token-Zwischenspeicher ────────────────────────────────────────────────

function emailKey(email) {
  return crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 16);
}

async function passwordHash(password, saltHex) {
  return (await pbkdf2(String(password), Buffer.from(saltHex, 'hex'), 200_000, 32, 'sha256')).toString('hex');
}

function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeCache(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(payload)); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

async function loadBoundCache(file, email, password) {
  const raw = readCache(file);
  if (!raw || raw.emailKey !== emailKey(email) || typeof raw.salt !== 'string' || typeof raw.pwHash !== 'string') return null;
  const hash = await passwordHash(password, raw.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(raw.pwHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? raw : null;
}

// ── Login ─────────────────────────────────────────────────────────────────

async function b2cToken(fetchImpl, fields) {
  const { status, json } = await postJson(fetchImpl, B2C_TOKEN_URL, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: B2C_CLIENT_ID, scope: B2C_SCOPE, ...fields }).toString()
  });
  if (json?.access_token) return json;
  const err = String(json?.error || '');
  // invalid_grant / AADB2C90225 & Co.: Zugangsdaten falsch oder Konto gesperrt
  if (err === 'invalid_grant' || err === 'invalid_request' || err === 'access_denied' || status === 400 || status === 401) {
    throw new TariffProviderError('auth', `LichtBlick-Anmeldung abgelehnt (${err || `HTTP ${status}`}).`);
  }
  throw new TariffProviderError('api', `LichtBlick-Anmeldung fehlgeschlagen (${err || `HTTP ${status}`}).`);
}

/**
 * Gültiges Access-Token (aus dem Zwischenspeicher, per Refresh oder per Passwort).
 * @returns {Promise<{accessToken:string, cache:object}>}
 */
async function accessToken({ email, password, cacheFile, fetchImpl, now, forceRefresh = false }) {
  const cached = cacheFile ? await loadBoundCache(cacheFile, email, password) : null;
  if (!forceRefresh && cached?.accessToken && Number(cached.expiresAt) > now() + 60_000) {
    return { accessToken: cached.accessToken, cache: cached };
  }
  let tok = null;
  if (cached?.refreshToken) {
    try {
      tok = await b2cToken(fetchImpl, { grant_type: 'refresh_token', refresh_token: cached.refreshToken });
    } catch (error) {
      if (error.code === 'network') throw error;
      tok = null; // Refresh abgelaufen/widerrufen → einmal mit Passwort
    }
  }
  if (!tok) tok = await b2cToken(fetchImpl, { grant_type: 'password', username: email, password });
  const salt = cached?.salt || crypto.randomBytes(16).toString('hex');
  const next = {
    emailKey: emailKey(email),
    salt,
    pwHash: cached?.pwHash || await passwordHash(password, salt),
    accessToken: tok.access_token,
    // B2C rotiert den Refresh-Token; fehlt ein neuer, den alten behalten
    refreshToken: tok.refresh_token || cached?.refreshToken || null,
    expiresAt: now() + Number(tok.expires_in || 3600) * 1000,
    contractId: cached?.contractId ?? null,
    productName: cached?.productName ?? null
  };
  if (cacheFile) writeCache(cacheFile, next);
  return { accessToken: next.accessToken, cache: next };
}

async function gql(fetchImpl, token, query, variables, operationName) {
  const { status, json } = await postJson(fetchImpl, GRAPH_URL, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...GRAPH_HEADERS },
    body: JSON.stringify({ query, variables: variables || undefined, operationName })
  });
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const unauth = status === 401
    || errors.some((e) => /UNAUTHENTICATED|AUTH_NOT_AUTHENTICATED/i.test(String(e?.extensions?.code || '')));
  if (unauth) throw new TariffProviderError('auth_token', 'LichtBlick lehnt das Token ab.');
  if (!json?.data) {
    if (errors.length) {
      throw new TariffProviderError('api', `LichtBlick-Fehler: ${String(errors[0]?.message || '').slice(0, 200)} [${errors[0]?.extensions?.code || ''}]`);
    }
    throw new TariffProviderError(status >= 400 ? 'api' : 'format', `Unerwartete Antwort von LichtBlick (HTTP ${status}).`);
  }
  return json.data;
}

function curvePoints(day) {
  const list = day?.energyPriceCurvesResponse?.energyPricesInCents;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.time === 'string' && !p.time.startsWith('0001-') && Number.isFinite(Number(p.valueInCents)))
    .map((p) => ({ ts: p.time, ctKwh: Number(p.valueInCents) }));
}

/**
 * @param {{email:string, password:string, contractId?:number|null, cacheFile?:string|null, fetchImpl?:Function, now?:Function}} opts
 * @returns {Promise<{provider:'lichtblick', account:{contractId:number, label:string|null}, slots:Array}>}
 */
export async function fetchLichtblickPrices({ email, password, contractId = null, cacheFile = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  if (!email || !password) throw new TariffProviderError('auth', 'E-Mail und Passwort der LichtBlick-App fehlen.');
  let { accessToken: token, cache } = await accessToken({ email, password, cacheFile, fetchImpl, now });

  // Ein abgelehntes Token (z. B. vorzeitig widerrufen) einmal erneuern.
  const withToken = async (fn) => {
    try {
      return await fn(token);
    } catch (error) {
      if (error.code !== 'auth_token') throw error;
      ({ accessToken: token, cache } = await accessToken({ email, password, cacheFile, fetchImpl, now, forceRefresh: true }));
      try {
        return await fn(token);
      } catch (again) {
        if (again.code === 'auth_token') throw new TariffProviderError('auth', 'LichtBlick lehnt den Zugriff ab.');
        throw again;
      }
    }
  };

  let id = Number.isInteger(contractId) && contractId > 0 ? contractId : (Number.isInteger(cache?.contractId) ? cache.contractId : null);
  let label = cache?.productName ?? null;
  if (!id) {
    const data = await withToken((t) => gql(fetchImpl, t, SELECTABLE_CONTRACTS, null, 'SelectableContracts'));
    const contracts = data?.b2cCustomer?.appSelectableContracts?.contracts;
    const power = (Array.isArray(contracts) ? contracts : []).filter((c) => c?.category === 'POWER' && Number.isInteger(c?.b2cContractId));
    if (!power.length) throw new TariffProviderError('no_contract', 'Kein Strom-Vertrag im LichtBlick-Konto gefunden.');
    id = power[0].b2cContractId;
    label = power[0].productName || null;
    if (cacheFile) {
      try { writeCache(cacheFile, { ...cache, contractId: id, productName: label }); } catch { /* nur Komfort */ }
    }
  }

  const today = localDateOf(now(), TIME_ZONE);
  const tomorrow = addDaysToDate(today, 1);
  const dayAfter = addDaysToDate(today, 2);
  const data = await withToken((t) => gql(fetchImpl, t, ENERGY_PRICE_CURVES, {
    contractId: id,
    startToday: localMidnight(today, TIME_ZONE).iso,
    endToday: localMidnight(tomorrow, TIME_ZONE).iso,
    startTomorrow: localMidnight(tomorrow, TIME_ZONE).iso,
    endTomorrow: localMidnight(dayAfter, TIME_ZONE).iso
  }, 'EnergyPriceCurves'));
  const slots = pointsToSlots([...curvePoints(data?.todayPriceCurves), ...curvePoints(data?.tomorrowPriceCurves)]);
  return { provider: 'lichtblick', account: { contractId: id, label }, slots };
}
