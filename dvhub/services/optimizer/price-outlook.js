// services/optimizer/price-outlook.js — Preisprognose von dvhub.online
// (Residuallast-Prognose, Christin 12.11.2026, 1.0.11): Preisschwanz für EOS
// und Preise für die Wertgrundlage des E-Autos (ev-targets.js).
//
// Hinter den bekannten Day-Ahead-Preisen braucht EOS Preise für seinen
// Prognose-Schwanz (tail), sonst bewertet es die Restladung im Akku fast nur
// zum Einspeisewert (Tail-Fix 01.11.2026). Sie kommen aus der
// Residuallast-Prognose von dvhub.online
// (GET /v1/residual-load/outlook, öffentlich, ohne Schlüssel):
//   Wetter (ECMWF) → Last/Wind/Solar → Residuallast → Börsenpreis DE-LU je
//   Stunde, P10/P50/P90 in €/MWh, fünf Tage ab dem Tag nach `last_known_day`.
//   Rückblick (Prüfjahr Nov. 2025 – Nov. 2026): Stunden-MAE 19–28 €/MWh gegen
//   26–39 bei der Fortschreibung aus dem Preisverlauf, die DVhub bis 1.0.10
//   nutzte; teure Tage zu 61–66 % erkannt (dort 30–36 %). Die Fortschreibung
//   ist seit 1.0.11 ganz entfallen (Christin 12.11.2026).
//
// Abruf nur, wenn die Preisprognose an ist (epex.priceOutlook, eigener
// Schalter; Standard „automatisch“: an bei Preisquelle DVhub und LUOX, aus bei
// „Öffentlich“) und die Preiszone DE-LU ist (outlookDisabledReason).
//
// Regeln:
//   - Echte Day-Ahead-Preise haben immer Vorrang; der Schwanz beginnt am Ende
//     der lückenlosen echten Preise und nimmt P50.
//   - Nur Preiszone DE-LU: Die Prognose gibt es nur für DE-LU. Andere Zonen
//     bekommen keinen Schwanz (EOS plant dann nur über die echten Preise).
//   - Rückfall: die letzte gültige Prognose (auf der Platte,
//     übersteht Neustarts), solange sie höchstens OUTLOOK_MAX_AGE_MS alt ist
//     und ihre Stunden noch in der Zukunft liegen. Danach kein Schwanz.
//   - Kaputte Antworten (Form, Zone, Werte) werden verworfen, die gespeicherte
//     Prognose bleibt.
//   - Stundenwerte gelten für jede ihrer Viertelstunden; gerechnet wird in
//     UTC-Stunden, Zeitumstellungstage (23/25 h) brauchen keine Sonderregel.

import fs from 'node:fs';
import path from 'node:path';
import { outboundFetch } from '../outbound-fetch.js';

export const SLOT_MS = 15 * 60 * 1000;
const HOUR_MS = 3_600_000;

/**
 * So weit müssen echte Preise mindestens voraus reichen, damit ein Schwanz
 * angehängt wird: EOS' Steuerzeitraum ist mindestens 1 h
 * (computeControlHorizonHours), dazu 15 min Puffer — sonst lägen Prognose-
 * preise im Steuerzeitraum.
 */
export const MIN_REAL_AHEAD_MS = 75 * 60 * 1000;

export const OUTLOOK_PATH = '/v1/residual-load/outlook';
/** Die Residuallast-Prognose gibt es nur für diese Preiszone. */
export const OUTLOOK_ZONE = 'DE-LU';
export const OUTLOOK_SCHEMA_VERSION = 1;
/**
 * Höchstalter einer Prognose (ab issued_at), bis zu dem DVhub sie weiter
 * benutzt, wenn keine neue kommt — 48 h. Begründung (Rückblick dvhub.online,
 * Prüfjahr Nov. 2025 – Nov. 2026, Stunden-MAE je Vorlauf 1–5: 18,6 / 20,6 /
 * 22,8 / 24,9 / 27,9 €/MWh; die frühere Fortschreibung aus dem Preisverlauf
 * ab Vorlauf 1: 26,4 / 33,8 / 36,4 …):
 *   - Nach 48 h sind die Tage, die der Schwanz dann noch braucht, für die alte
 *     Prognose Vorlauf 3–5. Deren Fehler liegt noch unter dem, was
 *     die frühere Fortschreibung schon am ersten Tag hatte — bis dahin lohnt das Weiter-
 *     benutzen klar.
 *   - Danach blieben nur Vorlauf 5 und Stunden außerhalb der Prognose; das
 *     Brennstoff-Preisniveau (Gas, CO2) der alten Prognose veraltet, und acht
 *     verpasste Läufe (4× täglich) sind ein echter Ausfall, kein Wackler.
 */
export const OUTLOOK_MAX_AGE_MS = 48 * HOUR_MS;
/** Abruf-Frist (Kopf und Body). */
export const OUTLOOK_FETCH_TIMEOUT_MS = 15_000;
/** Nach einem Fehlschlag frühestens so spät wieder fragen. */
export const OUTLOOK_RETRY_MS = 10 * 60_000;
/** Spätestens so oft fragen, auch ohne Termin (Termine siehe unten). */
export const OUTLOOK_REFRESH_MAX_MS = 3 * HOUR_MS;
/**
 * Neue Läufe der Prognose (UTC, dvhub.online): 08:15, 12:30, 15:00, 20:15.
 * DVhub fragt 10 min nach jedem Termin (Antwort-Cache des Servers 10 min).
 */
export const OUTLOOK_UPDATE_TIMES_UTC = Object.freeze([[8, 15], [12, 30], [15, 0], [20, 15]]);
const UPDATE_MARGIN_MS = 10 * 60_000;
/** Antworten über dieser Größe gelten als kaputt (heute ~25 KB). */
const MAX_BODY_BYTES = 1024 * 1024;
/** Plausible Börsenpreise in €/MWh (EPEX-Grenzen −500 … 4000, mit Luft). */
const PRICE_MIN_EUR_MWH = -1000;
const PRICE_MAX_EUR_MWH = 10_000;
/** Mehr Stunden nimmt DVhub nicht an (5 Tage + Luft). */
const MAX_HOURS = 8 * 24;

function finiteOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Antwort von /v1/residual-load/outlook prüfen und in die Form bringen, mit
 * der DVhub rechnet. Neue Felder stören nicht (abwärtskompatibel).
 *
 * @returns {{ok:true, outlook:object}|{ok:false, reason:string}}
 *   outlook: { issuedAt, issuedMs, lastKnownDay, biddingZone, modelVersion,
 *   schemaVersion, stale, hours: [{ms, p10, p50, p90, leadDays}] } — Preise in
 *   €/MWh, Stunden aufsteigend, je Stunde höchstens einmal. Stunden ohne
 *   gültiges P50 fehlen (Lücke).
 */
export function parseOutlook(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'invalid' };
  const schema = body.schema_version === undefined ? OUTLOOK_SCHEMA_VERSION : Number(body.schema_version);
  if (schema !== OUTLOOK_SCHEMA_VERSION) return { ok: false, reason: 'schema' };
  const issuedMs = Date.parse(body.issued_at || '');
  if (!Number.isFinite(issuedMs)) return { ok: false, reason: 'invalid' };
  const zone = typeof body.bidding_zone === 'string' ? body.bidding_zone.trim() : '';
  if (!zone) return { ok: false, reason: 'invalid' };
  if (!Array.isArray(body.hours)) return { ok: false, reason: 'invalid' };
  const byMs = new Map();
  for (const h of body.hours.slice(0, MAX_HOURS * 2)) {
    const ms = Date.parse(h?.ts || '');
    if (!Number.isFinite(ms) || ms % HOUR_MS !== 0) continue;
    const p = h?.price_eur_mwh;
    const p50 = finiteOrNull(p?.p50);
    if (p50 === null || p50 < PRICE_MIN_EUR_MWH || p50 > PRICE_MAX_EUR_MWH) continue;
    let p10 = finiteOrNull(p?.p10);
    let p90 = finiteOrNull(p?.p90);
    // Band nur, wenn es P50 einschließt — sonst lieber keins zeigen.
    if (p10 === null || p90 === null || !(p10 <= p50 && p50 <= p90)) { p10 = null; p90 = null; }
    byMs.set(ms, { ms, p10, p50, p90, leadDays: finiteOrNull(h?.lead_days) });
  }
  const hours = [...byMs.values()].sort((a, b) => a.ms - b.ms).slice(0, MAX_HOURS);
  if (!hours.length) return { ok: false, reason: 'empty' };
  return {
    ok: true,
    outlook: {
      issuedAt: new Date(issuedMs).toISOString(),
      issuedMs,
      lastKnownDay: typeof body.last_known_day === 'string' ? body.last_known_day : null,
      biddingZone: zone,
      modelVersion: typeof body.model_version === 'string' ? body.model_version : null,
      schemaVersion: schema,
      stale: body.stale === true,
      hours,
    },
  };
}

/**
 * Darf diese Prognose jetzt für den Schwanz genutzt werden?
 * @returns {{ok:boolean, reason:string|null}}
 *   reason: 'zone' (Antwort nicht DE-LU), 'too_old' (älter als maxAgeMs),
 *   'future' (Ausgabe liegt mehr als 1 h in der Zukunft — Uhr falsch?),
 *   'expired' (keine Stunde mehr in der Zukunft)
 */
export function outlookUsable(outlook, { nowMs = Date.now(), maxAgeMs = OUTLOOK_MAX_AGE_MS } = {}) {
  if (!outlook || !Array.isArray(outlook.hours)) return { ok: false, reason: 'none' };
  if (outlook.biddingZone !== OUTLOOK_ZONE) return { ok: false, reason: 'zone' };
  if (outlook.issuedMs > nowMs + HOUR_MS) return { ok: false, reason: 'future' };
  if (nowMs - outlook.issuedMs > maxAgeMs) return { ok: false, reason: 'too_old' };
  const last = outlook.hours[outlook.hours.length - 1];
  if (!last || last.ms + HOUR_MS <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, reason: null };
}

/**
 * Ende der echten Preise (ms, exklusiv) und ihre Slot-Länge. Die Länge kommt
 * aus den Daten (kleinster Abstand), damit Stundenpreise nicht als
 * Viertelstunden gelten. Ohne gültige Slots: end = -Infinity.
 */
export function realPriceCoverage(priceSlots) {
  const starts = [...new Set((Array.isArray(priceSlots) ? priceSlots : [])
    .filter((s) => s && Number.isFinite(Number(s.ctKwh)))
    .map((s) => Date.parse(s.start))
    .filter(Number.isFinite))].sort((a, b) => a - b);
  if (!starts.length) return { end: -Infinity, stepMs: SLOT_MS };
  let stepMs = Infinity;
  for (let i = 1; i < starts.length; i += 1) stepMs = Math.min(stepMs, starts[i] - starts[i - 1]);
  if (!Number.isFinite(stepMs) || stepMs <= 0) stepMs = SLOT_MS;
  return { end: starts[starts.length - 1] + stepMs, stepMs };
}

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * Preis-Slots (forecast.price.slots: {start, end, ctKwh}) hinter dem letzten
 * echten Slot bis `untilMs` mit P50 der Residuallast-Prognose verlängern.
 * Echte Slots bleiben unverändert; neue tragen `estimated: true`,
 * `priceSource: 'residual_load'` und das Band (`p10CtKwh`, `p90CtKwh`).
 *
 * Nur hinter echten Preisen, die
 * mindestens bis jetzt + 1 h 15 min reichen (MIN_REAL_AHEAD_MS), und in der
 * Slot-Länge der echten Preise — eine Reihe mit gemischter Kadenz liest EOS mit
 * Lücken (Gegenprüfung 8c050aae). Der Schwanz ist lückenlos: Er endet an der
 * ersten Stunde, die der Prognose fehlt; fehlt schon die erste, gibt es keinen.
 *
 * @param {Array<{start:string, ctKwh:number}>} priceSlots echte Slots
 * @param {object} opts
 * @param {object|null} opts.outlook  parseOutlook(...).outlook
 * @param {number} opts.untilMs  bis wohin (exklusiv) die Reihe reichen soll
 * @param {number} [opts.nowMs]
 * @returns {{slots:Array, estimate:null|object, reason:string|null}}
 *   reason (ohne Schwanz): 'no_real_prices', 'real_prices_short' (echte enden
 *   vor jetzt + 1 h 15 min), 'covered' (echte reichen schon bis untilMs),
 *   'no_outlook', 'gap' (die Prognose beginnt erst nach dem Ende der echten
 *   Preise)
 */
export function fillPriceSlotsFromOutlook(priceSlots, { outlook, untilMs, nowMs = Date.now() } = {}) {
  const list = Array.isArray(priceSlots) ? priceSlots : [];
  const real = list.filter((s) => s && s.start && Number.isFinite(Number(s.ctKwh)) && Number.isFinite(Date.parse(s.start)));
  const unchanged = (reason) => ({ slots: list, estimate: null, reason });
  if (!real.length) return unchanged('no_real_prices');
  const { end: fromMs, stepMs } = realPriceCoverage(real);
  if (fromMs < nowMs + MIN_REAL_AHEAD_MS) return unchanged('real_prices_short');
  if (!Number.isFinite(untilMs) || fromMs >= untilMs) return unchanged('covered');
  if (!outlook || !Array.isArray(outlook.hours) || !outlook.hours.length) return unchanged('no_outlook');
  const byHour = new Map(outlook.hours.map((h) => [h.ms, h]));
  const perSlot = Math.max(1, Math.round(stepMs / SLOT_MS));
  const added = [];
  for (let start = fromMs; start < untilMs; start += stepMs) {
    // Stundenwert je Viertelstunde; bei Stundenpreisen der Wert der Stunde.
    const quarters = [];
    for (let k = 0; k < perSlot; k += 1) {
      const q = start + k * SLOT_MS;
      const h = byHour.get(q - (((q % HOUR_MS) + HOUR_MS) % HOUR_MS));
      if (!h) break;
      quarters.push(h);
    }
    if (quarters.length < perSlot) break; // Lücke: Schwanz endet hier
    const mean = (key) => {
      const vals = quarters.map((h) => h[key]);
      return vals.every((v) => Number.isFinite(v)) ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
    };
    const p50 = mean('p50');
    const p10 = mean('p10');
    const p90 = mean('p90');
    added.push({
      start: new Date(start).toISOString(),
      end: new Date(start + stepMs).toISOString(),
      // €/MWh ÷ 10 = ct/kWh
      ctKwh: round2(p50 / 10),
      confidence: 0.5,
      estimated: true,
      priceSource: 'residual_load',
      p10CtKwh: p10 === null ? null : round2(p10 / 10),
      p90CtKwh: p90 === null ? null : round2(p90 / 10),
    });
  }
  if (!added.length) return unchanged('gap');
  const leads = outlook.hours.filter((h) => h.ms >= fromMs - HOUR_MS && h.ms < fromMs + added.length * stepMs)
    .map((h) => h.leadDays).filter(Number.isFinite);
  return {
    slots: [...list, ...added],
    estimate: {
      estimatedSlots: added.length,
      from: added[0].start,
      until: new Date(fromMs + added.length * stepMs).toISOString(),
      method: 'residual_load_p50',
      source: 'dvhub.online',
      issuedAt: outlook.issuedAt,
      lastKnownDay: outlook.lastKnownDay,
      modelVersion: outlook.modelVersion,
      leadDaysMax: leads.length ? Math.max(...leads) : null,
    },
    reason: null,
  };
}

/**
 * Bis wohin (ms, exklusiv) reicht die Prognose lückenlos ab der Stunde, in der
 * `fromMs` liegt? Wie der Schwanz (fillPriceSlotsFromOutlook): an der ersten
 * fehlenden Stunde ist Schluss. null, wenn schon die erste fehlt.
 */
export function outlookContiguousEndMs(outlook, fromMs) {
  if (!outlook || !Array.isArray(outlook.hours) || !Number.isFinite(fromMs)) return null;
  const have = new Set(outlook.hours.map((h) => h.ms));
  let h = fromMs - (((fromMs % HOUR_MS) + HOUR_MS) % HOUR_MS);
  if (!have.has(h)) return null;
  while (have.has(h)) h += HOUR_MS;
  return h;
}

/** Nächster Abruf-Termin nach `ms` (UTC-Termine + 10 min). */
export function nextScheduledFetchMs(ms) {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  for (let k = 0; k < 2; k += 1) {
    for (const [h, m] of OUTLOOK_UPDATE_TIMES_UTC) {
      const t = day + k * 86_400_000 + (h * 60 + m) * 60_000 + UPDATE_MARGIN_MS;
      if (t > ms) return t;
    }
  }
  return ms + OUTLOOK_REFRESH_MAX_MS;
}

/**
 * Ist ein Abruf fällig?
 * @param {object} s  { cache: {fetchedAt}|null, lastAttemptAt, lastAttemptOk }
 */
export function outlookFetchDue({ cache, lastAttemptAt, lastAttemptOk }, nowMs) {
  if (Number.isFinite(lastAttemptAt) && lastAttemptOk === false && nowMs - lastAttemptAt < OUTLOOK_RETRY_MS) return false;
  const fetchedAt = Number(cache?.fetchedAt);
  if (!cache || !Number.isFinite(fetchedAt)) return true;
  if (nowMs - fetchedAt >= OUTLOOK_REFRESH_MAX_MS) return true;
  return nowMs >= nextScheduledFetchMs(fetchedAt);
}

/**
 * Schalter „Preisprognose von dvhub.online“ (epex.priceOutlook, 1.0.11):
 * 'on', 'off' oder 'auto'. Fehlt das Feld oder ist es unbekannt: 'auto' — so
 * verhalten sich Configs von vor dem Schalter genau wie bisher.
 */
export function priceOutlookSetting(cfg) {
  const v = cfg?.epex?.priceOutlook;
  if (v === true) return 'on';
  if (v === false) return 'off';
  const t = String(v ?? '').trim().toLowerCase();
  return t === 'on' || t === 'off' ? t : 'auto';
}

/**
 * Warum DVhub die Prognose nicht abruft (null = ruft ab):
 *   'prices_off'    Börsenpreise abgeschaltet;
 *   'switched_off'  Schalter „Aus“;
 *   'source_public' Schalter „automatisch“ bei Preisquelle „Öffentlich
 *                   (Energy-Charts)“ — die heißt ausdrücklich „ohne
 *                   dvhub.online“; „An“ schaltet die Prognose trotzdem ein;
 *   'zone'          Preiszone nicht DE-LU (die Prognose gibt es nur dort).
 */
export function outlookDisabledReason(cfg) {
  const epex = cfg?.epex || {};
  if (epex.enabled === false) return 'prices_off';
  const setting = priceOutlookSetting(cfg);
  if (setting === 'off') return 'switched_off';
  if (setting === 'auto' && String(epex.priceSource || 'dvhub') === 'public') return 'source_public';
  if (String(epex.bzn || OUTLOOK_ZONE) !== OUTLOOK_ZONE) return 'zone';
  return null;
}

function readCacheFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return { cache: null, unavailableSince: null };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const parsed = raw?.body ? parseOutlook(raw.body) : { ok: false };
    // Number(null) wäre 0 — fehlende Werte bleiben null.
    const fetchedAt = finiteOrNull(raw?.fetchedAt);
    const unavailableSince = finiteOrNull(raw?.unavailableSince);
    return {
      cache: parsed.ok && fetchedAt !== null ? { outlook: parsed.outlook, body: raw.body, fetchedAt } : null,
      unavailableSince,
    };
  } catch {
    return { cache: null, unavailableSince: null };
  }
}

function writeCacheFile(file, data) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* Platte voll/schreibgeschützt: weiter mit dem Stand im Speicher */ }
}

/**
 * Dienst: holt die Prognose, prüft sie, hält die letzte gültige auf der Platte
 * und sagt, was gerade gilt.
 *
 * @param {object} deps
 * @param {() => object} deps.getCfg
 * @param {Function} [deps.fetchImpl]   fetch-ähnlich (Standard: outboundFetch, Namensprüfung)
 * @param {string|null} [deps.cacheFile]  JSON-Datei für die letzte gültige Prognose
 * @param {() => number} [deps.now]
 * @param {Function} [deps.pushLog]
 * @param {string} [deps.userAgent]     Kennung ohne persönliche Daten
 */
export function createPriceOutlookService({
  getCfg,
  fetchImpl = outboundFetch,
  cacheFile = null,
  now = () => Date.now(),
  pushLog = () => {},
  userAgent = 'DVhub',
} = {}) {
  const loaded = readCacheFile(cacheFile);
  let cache = loaded.cache; // { outlook, body, fetchedAt }
  let unavailableSince = loaded.unavailableSince;
  let lastAttemptAt = null;
  let lastAttemptOk = null;
  let lastError = null;
  let lastServerStale = false;
  let inflight = null;
  let timer = null;

  function baseUrl(cfg) {
    return String(cfg?.epex?.priceApiUrl || 'https://dvhub.online').replace(/\/+$/, '');
  }

  function persist() {
    writeCacheFile(cacheFile, { fetchedAt: cache?.fetchedAt ?? null, body: cache?.body ?? null, unavailableSince });
  }

  async function fetchOnce() {
    const cfg = getCfg?.() || {};
    const t = now();
    lastAttemptAt = t;
    try {
      const r = await fetchImpl(`${baseUrl(cfg)}${OUTLOOK_PATH}`, {
        headers: { accept: 'application/json', 'user-agent': userAgent },
        signal: AbortSignal.timeout(OUTLOOK_FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (text.length > MAX_BODY_BYTES) throw new Error('response_too_large');
      let body;
      try { body = JSON.parse(text); } catch { throw new Error('invalid_json'); }
      const parsed = parseOutlook(body);
      if (!parsed.ok) throw new Error(`invalid_outlook:${parsed.reason}`);
      if (parsed.outlook.biddingZone !== OUTLOOK_ZONE) throw new Error(`zone:${parsed.outlook.biddingZone}`);
      // Erst prüfen, dann übernehmen: eine unbrauchbare Antwort (z. B. Ausgabe in
      // der Zukunft) darf die gespeicherte gültige nicht verdrängen — sonst
      // gälten spätere richtige Antworten als „älter“ (Codex 27983aca, P2).
      const use = outlookUsable(parsed.outlook, { nowMs: t });
      if (!use.ok) throw new Error(`unusable_outlook:${use.reason}`);
      lastServerStale = parsed.outlook.stale;
      // Nie auf eine ältere Ausgabe zurückfallen (Server-Cache, Spiegel).
      if (!cache || parsed.outlook.issuedMs >= cache.outlook.issuedMs) {
        cache = { outlook: parsed.outlook, body, fetchedAt: t };
      } else {
        cache = { ...cache, fetchedAt: t };
      }
      lastAttemptOk = true;
      lastError = null;
      persist();
      return true;
    } catch (e) {
      lastAttemptOk = false;
      const msg = e?.message || String(e);
      if (msg !== lastError) pushLog('price_outlook_fetch_error', { error: msg });
      lastError = msg;
      return false;
    }
  }

  /** Abruf, wenn fällig (oder force); gleichzeitige Aufrufe teilen ihn. */
  async function ensureFresh({ force = false } = {}) {
    if (outlookDisabledReason(getCfg?.()) !== null) return false;
    if (inflight) return inflight;
    if (!force && !outlookFetchDue({ cache, lastAttemptAt, lastAttemptOk }, now())) return false;
    inflight = fetchOnce().finally(() => { inflight = null; });
    return inflight;
  }

  /**
   * Was gilt jetzt?
   * @returns {{status:'live'|'cached'|'unavailable'|'off', reason:string|null,
   *   outlook:object|null, issuedAt:string|null, fetchedAt:string|null,
   *   unavailableSince:string|null, lastError:string|null, serverStale:boolean}}
   *   live = jüngster Abruf gelang und der Server meldet die Prognose aktuell;
   *   cached = gültige Prognose, aber der letzte Abruf scheiterte oder der
   *   Server meldet sie veraltet (stale); unavailable = keine gültige; off =
   *   abgeschaltet (reason: prices_off, switched_off, source_public, zone).
   */
  function current(nowMs = now()) {
    const cfg = getCfg?.() || {};
    const off = outlookDisabledReason(cfg);
    const base = {
      issuedAt: cache?.outlook?.issuedAt ?? null,
      fetchedAt: Number.isFinite(cache?.fetchedAt) ? new Date(cache.fetchedAt).toISOString() : null,
      lastError,
      serverStale: lastServerStale,
    };
    if (off) return { ...base, status: 'off', reason: off, outlook: null, unavailableSince: null };
    const use = outlookUsable(cache?.outlook, { nowMs });
    if (use.ok) {
      if (unavailableSince !== null) { unavailableSince = null; persist(); }
      const live = lastAttemptOk !== false && !lastServerStale && !cache.outlook.stale;
      return { ...base, status: live ? 'live' : 'cached', reason: live ? null : (lastAttemptOk === false ? 'fetch_failed' : 'server_stale'), outlook: cache.outlook, unavailableSince: null };
    }
    if (unavailableSince === null) {
      // Seit wann: ab Ablauf der alten Prognose, sonst ab jetzt.
      const expiredAt = cache?.outlook ? Math.min(nowMs, cache.outlook.issuedMs + OUTLOOK_MAX_AGE_MS) : nowMs;
      unavailableSince = use.reason === 'too_old' ? expiredAt : nowMs;
      persist();
    }
    return {
      ...base,
      status: 'unavailable',
      reason: lastAttemptOk === false && use.reason === 'none' ? 'fetch_failed' : use.reason,
      outlook: null,
      unavailableSince: new Date(unavailableSince).toISOString(),
    };
  }

  /** Alle 5 min prüfen, ob ein Abruf fällig ist (Termine 4× täglich). */
  function start({ intervalMs = 5 * 60_000 } = {}) {
    if (timer) return;
    const tick = () => { ensureFresh().catch(() => {}); };
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { ensureFresh, current, start, stop, _fetchOnce: fetchOnce };
}

/**
 * Antwort für GET /api/price/outlook (Leitstand-Preiskurve, EOS-Karte).
 * Stunden nur hinter dem Ende der echten Preise (state.epex.data): echte
 * Preise haben Vorrang, die Anzeige zeigt nie beides für dieselbe Stunde.
 * Preise in ct/kWh (Börse, ohne Tarif-Bestandteile).
 */
export function buildPriceOutlookPayload({ state, cfg, priceOutlook, nowMs = Date.now() } = {}) {
  const rows = Array.isArray(state?.epex?.data) ? state.epex.data : [];
  const realSlots = rows
    .filter((r) => Number.isFinite(Number(r?.ts)) && Number.isFinite(Number(r?.ct_kwh)))
    .map((r) => ({ start: new Date(Number(r.ts)).toISOString(), ctKwh: Number(r.ct_kwh) }));
  const realEnd = realPriceCoverage(realSlots).end;
  let cur;
  try { cur = priceOutlook?.current?.(nowMs) || null; } catch { cur = null; }
  const zone = String(cfg?.epex?.bzn || OUTLOOK_ZONE);
  const hours = [];
  if (cur?.outlook) {
    for (const h of cur.outlook.hours) {
      if (h.ms + HOUR_MS <= nowMs) continue;
      if (Number.isFinite(realEnd) && h.ms < realEnd) continue;
      hours.push({
        ts: h.ms,
        p50: round2(h.p50 / 10),
        p10: h.p10 === null ? null : round2(h.p10 / 10),
        p90: h.p90 === null ? null : round2(h.p90 / 10),
        leadDays: h.leadDays,
      });
    }
  }
  const tail = state?.optimizer?.eosPriceTail || null;
  return {
    ok: true,
    status: cur?.status || 'unavailable',
    reason: cur ? cur.reason : 'no_service',
    zone,
    source: 'dvhub.online',
    unit: 'ct/kWh',
    issuedAt: cur?.issuedAt ?? null,
    fetchedAt: cur?.fetchedAt ?? null,
    unavailableSince: cur?.unavailableSince ?? null,
    lastKnownDay: cur?.outlook?.lastKnownDay ?? null,
    modelVersion: cur?.outlook?.modelVersion ?? null,
    realUntil: Number.isFinite(realEnd) ? new Date(realEnd).toISOString() : null,
    hours,
    eosTail: tail ? {
      used: tail.used === true,
      why: tail.why ?? null,
      from: tail.from ?? null,
      until: tail.until ?? null,
      slots: tail.slots ?? 0,
      at: Number.isFinite(tail.at) ? new Date(tail.at).toISOString() : null,
    } : null,
  };
}

/**
 * Preisschwanz des letzten EOS-Pushs (state.optimizer.eosPriceTail) für
 * /api/eos/plan — nur die Felder, die die Oberfläche zeigt.
 */
export function publicPriceTail(tail) {
  if (!tail || typeof tail !== 'object') return null;
  const look = tail.lookahead && typeof tail.lookahead === 'object' ? tail.lookahead : null;
  return {
    used: tail.used === true,
    status: tail.status ?? null,
    reason: tail.reason ?? null,
    why: tail.why ?? null,
    from: tail.from ?? null,
    until: tail.until ?? null,
    realUntil: tail.realUntil ?? null,
    issuedAt: tail.issuedAt ?? null,
    unavailableSince: tail.unavailableSince ?? null,
    source: tail.used === true ? 'dvhub.online' : null,
    lookahead: look ? {
      until: look.until ?? null,
      limitedBy: look.limitedBy ?? null,
      pvUntil: look.pvUntil ?? null,
      loadUntil: look.loadUntil ?? null,
      pricesUntil: look.pricesUntil ?? null,
      predictionUntil: look.predictionUntil ?? null,
      tailUntil: look.tailUntil ?? null,
    } : null,
    at: Number.isFinite(tail.at) ? new Date(tail.at).toISOString() : null,
  };
}
