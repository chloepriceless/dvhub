// services/tariff-provider/luox-partner-client.js — offizielle Lumenaza-
// Partner-API (https://docs.lumenaza.de, OpenAPI „Lumenaza external API“ v3.8.0).
//
// VORBEREITET: Christin hat (Stand 11.11.2026) keine Partner-Zugangsdaten.
// Getestet nur gegen die Beispielantworten der Spezifikation
// (test/fixtures/lumenaza-partner). Zugangsdaten vergibt Lumenaza an
// Vertriebspartner; sobald welche da sind, schaltet die Einstellung
// luox.partner.enabled diesen Weg ein — er geht dann vor dem Kundenportal.
//
// Auth: OAuth 2.0 Client Credentials, POST /oauth2/token/ (Formular,
// grant_type=client_credentials, scope=read — DVhub liest nur), dann
// Authorization: Bearer. Das Token (expires_in, typisch 3600 s) bleibt nur im
// Speicher. Server: Prod api.lumenaza.de, Test api.test.lumenaza.de (fest —
// das Geheimnis geht nie an eine einstellbare Adresse).
//
// Nur lesende GET-Endpunkte; die vielen schreibenden (Verträge anlegen,
// kündigen, §14a-Steuerressourcen, Stammdaten) bleiben außen vor.

import { TariffProviderError, REQUEST_TIMEOUT_MS } from './common.js';

export const PARTNER_HOSTS = Object.freeze({ prod: 'https://api.lumenaza.de', test: 'https://api.test.lumenaza.de' });
const USER_AGENT = 'DVhub (https://dvhub.online)';
const TOKEN_SKEW_MS = 60_000;

const seg = (v) => encodeURIComponent(String(v ?? ''));

function series(list, valueKey, { startKey = 'start', endKey = 'end' } = {}) {
  const flat = (Array.isArray(list) ? list : []).flat(2).filter((x) => x && typeof x === 'object');
  const out = [];
  for (const x of flat) {
    const ts = Date.parse(x[startKey]);
    const end = Date.parse(x[endKey]);
    const v = x[valueKey];
    if (!Number.isFinite(ts) || !Number.isFinite(end) || !(end > ts) || v == null || !Number.isFinite(Number(v))) continue;
    out.push({ ts, durationMs: end - ts, wh: Number(v) });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * @param {{clientId:string, clientSecret:string, environment?:'prod'|'test', fetchImpl?:Function, now?:Function, timeoutMs?:number}} opts
 */
export function createLumenazaPartnerClient({ clientId, clientSecret, environment = 'prod', fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const base = PARTNER_HOSTS[environment] || PARTNER_HOSTS.prod;
  let cached = null; // { token, expiresAt }

  async function call(url, init) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const kind = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Zeitüberschreitung' : (error?.cause?.code || error?.name || 'Fehler');
      throw new TariffProviderError('network', `Lumenaza-Partner-API nicht erreichbar (${kind}).`);
    }
    const text = await res.text().catch(() => '');
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
    return { status: res.status, json };
  }

  async function token(force = false) {
    if (!clientId || !clientSecret) throw new TariffProviderError('auth', 'Zugangsdaten der Lumenaza-Partner-API fehlen (client_id/client_secret).');
    if (!force && cached && cached.expiresAt > now()) return cached.token;
    const { status, json } = await call(`${base}/oauth2/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: new URLSearchParams([['grant_type', 'client_credentials'], ['client_id', clientId], ['client_secret', clientSecret], ['scope', 'read']]).toString()
    });
    if (status === 200 && json?.access_token) {
      const ttlMs = Math.max(60, Number(json.expires_in) || 3600) * 1000;
      cached = { token: json.access_token, expiresAt: now() + ttlMs - TOKEN_SKEW_MS };
      return cached.token;
    }
    if (status === 400 || status === 401 || status === 403) {
      const err = typeof json?.error === 'string' ? json.error.slice(0, 40) : `HTTP ${status}`;
      throw new TariffProviderError('auth', `Lumenaza-Partner-API lehnt die Zugangsdaten ab (${err}).`);
    }
    throw new TariffProviderError('api', `Lumenaza-Partner-API: Token-Abruf mit HTTP ${status}.`);
  }

  async function get(pathname, params = {}) {
    const url = new URL(pathname, base);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    let tok = await token();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { status, json } = await call(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json', 'User-Agent': USER_AGENT }
      });
      if (status === 401 && attempt === 0) { tok = await token(true); continue; }
      if (status === 401 || status === 403) throw new TariffProviderError('auth', `Lumenaza-Partner-API verweigert den Zugriff (HTTP ${status}).`);
      if (status === 404) throw new TariffProviderError('no_contract', 'Lumenaza-Partner-API: Vertrag nicht gefunden (Nutzer-/Vertragsnummer prüfen).');
      if (status !== 200) {
        const detail = typeof json?.detail === 'string' ? `: ${json.detail.slice(0, 160)}` : '';
        throw new TariffProviderError('api', `Lumenaza-Partner-API antwortet mit HTTP ${status}${detail}.`);
      }
      if (json === undefined || json === null) throw new TariffProviderError('format', 'Lumenaza-Partner-API liefert kein JSON.');
      return json;
    }
    throw new TariffProviderError('auth', 'Lumenaza-Partner-API verweigert den Zugriff.');
  }

  const contractPath = (role, userId, contractId, tail) => `/v3/${role}/${seg(userId)}/contracts/${seg(contractId)}/${tail}`;
  const range = ({ start, end, aggregation = 'raw', timezone = null }) => ({ start, end, aggregation_type: aggregation, timezone });

  return {
    /** EPEX Day-Ahead (€/MWh), from inklusiv / to exklusiv, UTC. */
    async epexDayAhead({ from, to, aggregation = 'raw' }) {
      const json = await get('/v3/prices/epex_day_ahead/', { from, to, aggregation_type: aggregation });
      if (!Array.isArray(json)) throw new TariffProviderError('format', 'Lumenaza-Partner-API: unerwartete Preisliste.');
      const out = [];
      for (const p of json) {
        const ts = Date.parse(p?.start_time);
        const end = Date.parse(p?.end_time);
        if (!Number.isFinite(ts) || p?.price == null || !Number.isFinite(Number(p.price))) continue;
        const eur = Number(p.price);
        out.push({ ts, durationMs: Number.isFinite(end) && end > ts ? end - ts : 900_000, eurMwh: eur, ctKwh: Math.round(eur * 1000) / 10000 });
      }
      return out.sort((a, b) => a.ts - b.ts);
    },
    /** Einspeisung (Wh) eines Erzeugervertrags. */
    async producerFeed({ userId, contractId, ...r }) {
      return series(await get(contractPath('producers', userId, contractId, 'feed/'), range(r)), 'feed');
    },
    /** Erzeugungsprognose (Wh) eines Erzeugervertrags. */
    async producerForecast({ userId, contractId, start, end }) {
      return series(await get(contractPath('producers', userId, contractId, 'forecast/'), { start, end }), 'forecast_value', { startKey: 'start_time', endKey: 'end_time' });
    },
    /** Güte der Live-Daten (Abdeckung, Fehler) je Marktlokation. */
    async producerLiveDataQuality({ userId, contractId, start, end }) {
      const json = await get(contractPath('producers', userId, contractId, 'live_data/quality/'), { start, end });
      return Array.isArray(json) ? json : [];
    },
    /** Ausfallarbeit (Wh, z. B. Abregelung). */
    async producerOutageEnergy({ userId, contractId, ...r }) {
      return series(await get(contractPath('producers', userId, contractId, 'outage_energy/'), range(r)), 'energy');
    },
    /** Anlagendaten des Erzeugervertrags. */
    async producerPlantData({ userId, contractId }) {
      return get(contractPath('producers', userId, contractId, 'plant_data/'));
    },
    /** Bezug (Wh) eines Verbrauchsvertrags (RLM/iMSys). */
    async consumerSupply({ userId, contractId, ...r }) {
      return series(await get(contractPath('consumers', userId, contractId, 'supply/'), range(r)), 'supply');
    }
  };
}
