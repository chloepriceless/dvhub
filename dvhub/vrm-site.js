// vrm-site.js — VRM-Anlage eindeutig ansprechen (GH #32).
//
// Alle Installations-Endpunkte der VRM-API (/v2/installations/{idSite}/stats,
// …/widgets/Graph, …/diagnostics) erwarten die numerische Site-ID (idSite).
// Kunden finden im VRM-Portal aber meist zuerst die „VRM-Portal-ID“ (die
// 12-stellige Hex-Kennung des GX-Geräts, in der API `identifier`). Das Feld
// telemetry.historyImport.vrmPortalId nimmt deshalb beides:
//   - nur Ziffern (bis 10 Stellen) → Site-ID, wird unverändert genutzt
//     (bestehende Konfigurationen ändern sich nicht, kein Netzaufruf);
//   - sonst → Portal-ID, wird aufgelöst:
//       GET /v2/users/me                     → user.id
//       GET /v2/users/{user.id}/installations → records[] mit identifier == Portal-ID → idSite
//     (offizielle Doku vrm-api-docs.victronenergy.com, InfoMeCommand.yaml und
//     InstallationsCommand.yaml; am 02.11.2026 an einem echten Konto bestätigt:
//     user.id ist eine Zahl, idSite eine Zahl, identifier 12 Hex-Zeichen klein.)
//
// Das Ergebnis bleibt im Prozess zwischengespeichert (je Portal-ID und Konto);
// Fehlschläge werden nicht gespeichert, der nächste Lauf versucht es erneut.

import { createHash } from 'node:crypto';

export const VRM_API_BASE = 'https://vrmapi.victronenergy.com';
const RESOLVE_TIMEOUT_MS = 20_000;
const CACHE_MAX_ENTRIES = 32;
// Site-IDs sind heute 6-stellig; Portal-IDs (MAC-basiert) 12 Zeichen — auch
// eine Portal-ID nur aus Ziffern bleibt damit eine Portal-ID.
const SITE_ID_RE = /^\d{1,10}$/;
const PORTAL_ID_RE = /^[A-Za-z0-9]{4,64}$/;

export class VrmSiteResolveError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.name = 'VrmSiteResolveError';
    this.code = code;
    this.status = status;
  }
}

const defaultCache = new Map();

/** Was steht im Feld? → { kind: 'site'|'portal'|'empty'|'invalid', value } */
export function classifyVrmInstallationRef(raw) {
  const value = raw == null ? '' : String(raw).trim();
  if (!value) return { kind: 'empty', value };
  if (SITE_ID_RE.test(value)) return { kind: 'site', value };
  if (PORTAL_ID_RE.test(value)) return { kind: 'portal', value };
  return { kind: 'invalid', value };
}

function cacheKey(portalId, token) {
  // Token nie im Klartext als Schlüssel ablegen.
  const fp = createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
  return `${portalId.toLowerCase()}|${fp}`;
}

function networkReason(e) {
  if (e?.cause?.code) return String(e.cause.code);
  if (e?.name === 'TimeoutError') return 'ETIMEDOUT';
  return String(e?.message || e);
}

async function vrmGet(path, { token, fetchImpl, what }) {
  let res;
  try {
    res = await fetchImpl(`${VRM_API_BASE}${path}`, {
      headers: { accept: 'application/json', 'x-authorization': `Token ${token}` },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
    });
  } catch (e) {
    throw new VrmSiteResolveError(`VRM nicht erreichbar (${what}): ${networkReason(e)}`, 'network');
  }
  if (res.status === 401 || res.status === 403) {
    throw new VrmSiteResolveError(
      `VRM-Token ungültig oder ohne Leserechte (${what}: HTTP ${res.status}). Token im VRM-Portal unter Präferenzen → Integrationen → Access-Tokens neu erzeugen.`,
      'auth', res.status
    );
  }
  if (!res.ok) {
    throw new VrmSiteResolveError(`VRM-Abfrage fehlgeschlagen (${what}: HTTP ${res.status})`, 'http', res.status);
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new VrmSiteResolveError(`VRM lieferte keine lesbare Antwort (${what})`, 'unexpected');
  }
  return body;
}

async function lookupSiteId(portalId, { token, fetchImpl }) {
  const me = await vrmGet('/v2/users/me', { token, fetchImpl, what: 'users/me' });
  const userId = me?.user?.id;
  if (userId == null || !/^\d+$/.test(String(userId))) {
    throw new VrmSiteResolveError('VRM lieferte keine Nutzer-ID (users/me)', 'unexpected');
  }
  const list = await vrmGet(`/v2/users/${encodeURIComponent(String(userId))}/installations`, {
    token, fetchImpl, what: 'installations'
  });
  const records = Array.isArray(list?.records) ? list.records : [];
  const wanted = portalId.toLowerCase();
  const siteIds = [...new Set(records
    .filter((r) => r && String(r.identifier ?? '').trim().toLowerCase() === wanted)
    .map((r) => String(r.idSite ?? '').trim())
    .filter((id) => SITE_ID_RE.test(id)))];
  if (siteIds.length === 1) return siteIds[0];
  if (siteIds.length > 1) {
    throw new VrmSiteResolveError(
      `VRM-Portal-ID „${portalId}“ gehört in diesem Konto zu mehreren Anlagen (Site-IDs ${siteIds.join(', ')}). Bitte die gewünschte Site-ID direkt eintragen.`,
      'ambiguous'
    );
  }
  throw new VrmSiteResolveError(
    `VRM-Portal-ID „${portalId}“ ist in diesem VRM-Konto nicht zu finden (${records.length} Anlagen im Konto). Portal-ID prüfen oder die numerische Site-ID eintragen.`,
    'not_in_account'
  );
}

/**
 * Site-ID für /v2/installations/{idSite}/… ermitteln.
 * @param {{ ref: string|number, token: string, fetchImpl?: Function, cache?: Map }} args
 * @returns {Promise<string>} numerische Site-ID als String
 * @throws {VrmSiteResolveError} code: missing | invalid | network | auth | http | unexpected | not_in_account | ambiguous
 */
export async function resolveVrmSiteId({ ref, token, fetchImpl = (...a) => fetch(...a), cache = defaultCache }) {
  const { kind, value } = classifyVrmInstallationRef(ref);
  if (kind === 'empty') throw new VrmSiteResolveError('VRM-Portal-ID oder Site-ID fehlt (Integrationen → VRM Cloud)', 'missing');
  if (kind === 'invalid') {
    throw new VrmSiteResolveError(`„${value.slice(0, 64)}“ ist weder eine VRM-Site-ID (Zahl) noch eine VRM-Portal-ID`, 'invalid');
  }
  if (kind === 'site') return value;
  if (!token) throw new VrmSiteResolveError('VRM-Token fehlt (Integrationen → VRM Cloud)', 'missing');

  const key = cacheKey(value, token);
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = lookupSiteId(value, { token, fetchImpl });
  cache.set(key, pending);
  try {
    const siteId = await pending;
    cache.set(key, siteId);
    while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return siteId;
  } catch (e) {
    if (cache.get(key) === pending) cache.delete(key);
    throw e;
  }
}
