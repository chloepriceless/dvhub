// services/tariff-provider/luox-service.js — LUOX/Lumenaza als Datenquelle
// (T-0417, Christin 11.11.2026).
//
// Drei Nutzungen mit denselben Zugangsdaten (Einstellungsblock `luox`):
//   1. Day-Ahead-Viertelstundenpreise direkt von LUOX (epex.priceSource
//      'luox', epex-fetch.js) — Rückfall auf die öffentliche Quelle macht der
//      Abrufer.
//   2. Anbieterpreis „LUOX Dynamisch“ (userEnergyPricing.provider.name 'luox',
//      index.js): nur Energie netto = Spot; Endpreis brutto aus den
//      Produktbestandteilen nur mit luox.endCustomerPrice.enabled
//      (VORBEREITET, UNGEPRÜFT bis zur ersten Abrechnung).
//   3. Direktvermarktung (luox.dvSync.enabled): einmal täglich Abrechnungs-
//      XLSX (Einspeisung × Day-Ahead → Vergütung, 15 min) und Tagessummen der
//      Einspeisung des Erzeugervertrags in die Datenbank (scope 'settlement')
//      — nur zum Abgleich mit DVhubs Historie/Erlösrechnung, nie zum Steuern.
//
// Quelle: Ist die offizielle Lumenaza-Partner-API eingeschaltet und mit
// Zugangsdaten versehen (luox.partner.*, VORBEREITET), geht sie vor; sonst das
// inoffizielle Kundenportal (luox-client.js). Die Abrechnungs-XLSX gibt es nur
// im Portal.
//
// Konto-Schutz: Lehnt das Portal die Zugangsdaten ab, ruht jeder Portal-Abruf
// 6 h (oder bis die Zugangsdaten geändert werden) — sonst sperrt LUOX das Konto.
// Zustand und Meldungen enthalten nie Zugangsdaten oder Tokens.

import path from 'node:path';
import crypto from 'node:crypto';
import { createLuoxPortalClient } from './luox-client.js';
import { createLumenazaPartnerClient } from './luox-partner-client.js';
import { luoxDayAheadRows, parseEnergyData, summarizeContracts, pickContract, parseSettlementXlsx } from './luox-data.js';
import { extractLuoxTariff, luoxEndCustomerGrossCtKwh } from './luox-pricing.js';
import { TariffProviderError, localDateOf, addDaysToDate, localMidnight, localMinuteOfDay } from './common.js';

const TIME_ZONE = 'Europe/Berlin';
const AUTH_BLOCK_MS = 6 * 60 * 60 * 1000;
const CONTRACTS_TTL_MS = 6 * 60 * 60 * 1000;
const TARIFF_TTL_MS = 6 * 60 * 60 * 1000;
const SETTLEMENT_START_MINUTE = 10 * 60;
const SETTLEMENT_RETRY_MS = 60 * 60 * 1000;
const TEST_MIN_GAP_MS = 10_000;
const MASK = '***';

export const SETTLEMENT_SCOPE = 'settlement';
export const SETTLEMENT_SOURCE = 'luox';
export const SETTLEMENT_SERIES = Object.freeze({
  feed: 'luox_settlement_feed_wh',
  price: 'luox_settlement_price_eur_mwh',
  revenue: 'luox_settlement_revenue_eur',
  dailyFeed: 'luox_feed_daily_wh',
  partnerFeed: 'luox_feed_wh'
});

export const LUOX_NOTICE = 'LUOX-Kundenportal: inoffizielle Portal-Schnittstelle — sie kann sich ohne Ankündigung ändern.';

/** Pfad-Kategorie für energy_data: nur 'LGS' ist eigen, alles andere (z. B. 'SOL') = other_then_LGS. */
export function energyDataCategory(timeseriesCategory) {
  return timeseriesCategory === 'LGS' ? 'LGS' : 'other_then_LGS';
}

/** Ist der tägliche Abgleich fällig? Rein, damit testbar. */
export function settlementDue({ enabled, todayLocal, minuteOfDay, lastSuccessDate, lastAttemptMs, nowMs }) {
  if (!enabled) return false;
  if (minuteOfDay < SETTLEMENT_START_MINUTE) return false;
  if (lastSuccessDate === todayLocal) return false;
  return nowMs - (lastAttemptMs || 0) >= SETTLEMENT_RETRY_MS;
}

const portalConfigured = (s) => !!s?.email && !!s?.password;
const partnerConfigured = (s) => !!s?.partner?.clientId && !!s?.partner?.clientSecret;
const partnerActive = (s) => s?.partner?.enabled === true && partnerConfigured(s);

function fingerprint(s = {}) {
  return crypto.createHash('sha256').update(JSON.stringify([String(s.email || '').toLowerCase(), s.password || ''])).digest('hex').slice(0, 16);
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

export function createLuoxService(ctx, deps = {}) {
  const now = deps.now || (() => Date.now());
  const fetchImpl = deps.fetch || globalThis.fetch;
  const dataDir = deps.dataDir || '/var/lib/dvhub';
  const cacheFile = path.join(dataDir, 'tariff-provider', 'luox-token.json');
  const portalFactory = deps.portalFactory || ((s, { useCache }) => createLuoxPortalClient({
    email: s.email, password: s.password, cacheFile: useCache ? cacheFile : null, fetchImpl, now
  }));
  let partnerKey = null;
  let partnerInstance = null;
  const partnerFactory = deps.partnerFactory || ((p) => {
    const key = JSON.stringify([p.environment, p.clientId, p.clientSecret]);
    if (key !== partnerKey) {
      partnerKey = key;
      partnerInstance = createLumenazaPartnerClient({ clientId: p.clientId, clientSecret: p.clientSecret, environment: p.environment === 'test' ? 'test' : 'prod', fetchImpl, now });
    }
    return partnerInstance;
  });

  const settings = () => ctx.getCfg?.()?.luox || {};
  const log = (event, data, level) => { try { ctx.pushLog?.(event, data, level); } catch { /* ignore */ } };

  const st = {
    dayAhead: { lastAttemptAt: null, lastSuccessAt: null, source: null, todayCount: null, tomorrowCount: null, error: null, errorCode: null },
    partnerError: null,
    contracts: null, // { at, list }
    tariff: null, // Zusammenfassung des Endkundenpreises
    settlement: { lastAttemptAt: null, lastSuccessAt: null, lastSuccessDate: null, ok: null, error: null, rows: null, from: null, to: null, totals: null, dailyDays: null }
  };
  let authBlockedUntilMs = 0;
  let fp = null;
  let contractsCache = null; // { at, summary }
  let tariffCache = null; // { at, date, contractId, tariff }
  let lastSettlementAttemptMs = 0;
  let lastTestMs = 0;
  let timer = null;
  let syncInFlight = null;

  function syncFingerprint() {
    const next = fingerprint(settings());
    if (next !== fp) {
      fp = next;
      authBlockedUntilMs = 0;
      contractsCache = null;
      tariffCache = null;
    }
  }

  function portal({ useCache = true, override = null } = {}) {
    const s = override || settings();
    if (!portalConfigured(s)) throw new TariffProviderError('not_configured', 'E-Mail und Passwort des LUOX-Kundenportals fehlen (Einstellungen → Strompreise → LUOX).');
    return portalFactory(s, { useCache });
  }

  /** Portal-Aufruf mit Konto-Schutz (gespeicherte Zugangsdaten). */
  async function guarded(fn) {
    syncFingerprint();
    if (authBlockedUntilMs && now() < authBlockedUntilMs) {
      throw new TariffProviderError('auth_blocked', `LUOX hat die Zugangsdaten abgelehnt — neuer Versuch ab ${new Date(authBlockedUntilMs).toISOString()} oder nach Änderung der Zugangsdaten.`);
    }
    try {
      return await fn(portal());
    } catch (error) {
      if (error?.code === 'auth') {
        authBlockedUntilMs = now() + AUTH_BLOCK_MS;
        log('luox_auth_blocked', { until: new Date(authBlockedUntilMs).toISOString() }, 'warn');
      }
      throw error;
    }
  }

  async function contractSummary({ fresh = false } = {}) {
    if (!fresh && contractsCache && now() - contractsCache.at < CONTRACTS_TTL_MS) return contractsCache.summary;
    const summary = summarizeContracts(await guarded((c) => c.getJson('contracts')));
    contractsCache = { at: now(), summary };
    st.contracts = { at: new Date(now()).toISOString(), list: summary.contracts };
    return summary;
  }

  /** Day-Ahead heute + morgen (Partner-API vor Portal). */
  async function fetchDayAhead() {
    const s = settings();
    const nowMs = now();
    st.dayAhead.lastAttemptAt = new Date(nowMs).toISOString();
    try {
      let result = null;
      if (partnerActive(s)) {
        try {
          const today = localDateOf(nowMs, TIME_ZONE);
          const from = new Date(localMidnight(today, TIME_ZONE).ms).toISOString();
          const to = new Date(localMidnight(addDaysToDate(today, 2), TIME_ZONE).ms).toISOString();
          const rows = await partnerFactory(s.partner).epexDayAhead({ from, to, aggregation: 'raw' });
          const tomorrow = addDaysToDate(today, 1);
          result = {
            source: 'luox_partner',
            rows,
            todayCount: rows.filter((r) => localDateOf(r.ts, TIME_ZONE) === today).length,
            tomorrowCount: rows.filter((r) => localDateOf(r.ts, TIME_ZONE) === tomorrow).length
          };
          st.partnerError = null;
        } catch (error) {
          st.partnerError = String(error.message || error);
          log('luox_partner_error', { phase: 'day_ahead', code: error.code || 'error', error: st.partnerError }, 'warn');
          if (!portalConfigured(s)) throw error;
        }
      }
      if (!result) {
        if (!portalConfigured(s)) throw new TariffProviderError('not_configured', 'LUOX-Zugangsdaten fehlen.');
        const json = await guarded((c) => c.getJson('epex_price_today/'));
        const parsed = luoxDayAheadRows(json, { now: nowMs });
        result = { source: 'luox_portal', rows: parsed.rows, todayCount: parsed.todayCount, tomorrowCount: parsed.tomorrowCount };
      }
      Object.assign(st.dayAhead, {
        lastSuccessAt: new Date(now()).toISOString(), source: result.source,
        todayCount: result.todayCount, tomorrowCount: result.tomorrowCount, error: null, errorCode: null
      });
      return result;
    } catch (error) {
      st.dayAhead.error = String(error.message || error);
      st.dayAhead.errorCode = error.code || 'error';
      throw error;
    }
  }

  async function currentTariff() {
    const s = settings();
    const today = localDateOf(now(), TIME_ZONE);
    const summary = await contractSummary();
    const contract = pickContract(summary, 'consumer', s.consumerContractId || '');
    if (tariffCache && tariffCache.date === today && tariffCache.contractId === contract.id && now() - tariffCache.at < TARIFF_TTL_MS) return { tariff: tariffCache.tariff, contract };
    const json = await guarded((c) => c.getJson(`products/${contract.id}/${today}/${today}`));
    const tariff = extractLuoxTariff(json, { date: today });
    tariffCache = { at: now(), date: today, contractId: contract.id, tariff };
    st.tariff = {
      at: new Date(now()).toISOString(), displayName: tariff.displayName, complete: tariff.complete,
      percentOfSpot: tariff.percentOfSpot, vatPct: tariff.vatPct, perKwh: tariff.perKwh,
      perKwhItems: tariff.perKwhItems, notes: tariff.notes, unverified: true
    };
    return { tariff, contract };
  }

  /**
   * Anbieterpreis „LUOX Dynamisch“ je Viertelstunde (für index.js).
   * net_energy = Spot (ct/kWh); gross_total = Endpreis (nur mit Einstellung).
   */
  async function fetchTariffSlots({ priceBasis = 'net_energy' } = {}) {
    const s = settings();
    const da = await fetchDayAhead();
    if (priceBasis !== 'gross_total') {
      return {
        provider: 'luox',
        account: { label: 'LUOX Day-Ahead (Energiepreis netto)', source: da.source },
        slots: da.rows.map((r) => ({ ts: r.ts, ctKwh: r.ctKwh, durationMs: r.durationMs }))
      };
    }
    if (s.endCustomerPrice?.enabled !== true) {
      throw new TariffProviderError('not_enabled', 'Endkundenpreis „LUOX Dynamisch“ ist vorbereitet, aber ausgeschaltet (ungeprüft bis zur ersten Abrechnung). Einschalten unter LUOX → Endkundenpreis, oder „nur der Energiepreis netto“ wählen.');
    }
    const { tariff, contract } = await currentTariff();
    if (!tariff.complete) throw new TariffProviderError('format', `Endkundenpreis LUOX nicht berechenbar: ${tariff.notes[0] || 'Produktangaben unvollständig'}`);
    return {
      provider: 'luox',
      account: { label: tariff.displayName || 'LUOX', status: contract.status, source: da.source, unverified: true },
      // Für morgen kennt das Portal noch keine Bestandteile (Produktangaben nur bis heute): heutige gelten weiter.
      slots: da.rows.map((r) => ({ ts: r.ts, ctKwh: luoxEndCustomerGrossCtKwh(r.ctKwh, tariff), durationMs: r.durationMs }))
        .filter((x) => x.ctKwh != null)
    };
  }

  /** Verträge für die Auswahl in den Einstellungen. */
  async function listContracts({ kind = '', fresh = false } = {}) {
    const summary = await contractSummary({ fresh });
    const list = summary.contracts.filter((c) => !kind || c.kind === kind);
    return {
      ok: true,
      contracts: list,
      options: [
        { value: '', label: 'automatisch (erster liefernder)' },
        ...list.map((c) => ({ value: c.id, label: `${c.id} — ${c.kind === 'producer' ? 'Erzeugung' : 'Bezug'}, ${c.status || 'Status unbekannt'}` }))
      ]
    };
  }

  function writeRows(rows) {
    if (!rows.length || typeof ctx.telemetrySafeWrite !== 'function' || typeof ctx.telemetryStore?.writeSamples !== 'function') return Promise.resolve(false);
    return Promise.resolve(ctx.telemetrySafeWrite(async () => { await ctx.telemetryStore.writeSamples(rows); return true; }))
      .then((ok) => ok === true)
      .catch(() => false);
  }

  const sample = (seriesKey, ts, resolutionSeconds, value, unit) => ({
    seriesKey, scope: SETTLEMENT_SCOPE, source: SETTLEMENT_SOURCE, quality: 'raw',
    ts: new Date(ts).toISOString(), resolutionSeconds, value, unit, meta: { contract: 'producer' }
  });

  /** Täglicher Direktvermarktungs-Abgleich (nur lesen, nie steuern). */
  async function syncSettlement({ days = 7, reason = 'schedule' } = {}) {
    const s = settings();
    if (s.dvSync?.enabled !== true) return { ok: false, code: 'not_enabled', error: 'Direktvermarktungs-Abgleich ist ausgeschaltet.' };
    if (syncInFlight) return syncInFlight;
    syncInFlight = (async () => {
      const nowMs = now();
      lastSettlementAttemptMs = nowMs;
      st.settlement.lastAttemptAt = new Date(nowMs).toISOString();
      try {
        const n = Math.min(62, Math.max(1, Math.round(Number(days) || 7)));
        const today = localDateOf(nowMs, TIME_ZONE);
        const from = addDaysToDate(today, -n);
        const to = addDaysToDate(today, -1);
        const summary = await contractSummary();
        const producer = pickContract(summary, 'producer', s.producerContractId || '');
        const rows = [];

        const sheet = parseSettlementXlsx(await guarded((c) => c.getBinary(`epex_price/${producer.id}/${from}/${to}/producer/`)));
        for (const r of sheet.rows) {
          if (r.feedWh != null) rows.push(sample(SETTLEMENT_SERIES.feed, r.ts, 900, r.feedWh, 'Wh'));
          if (r.priceEurMwh != null) rows.push(sample(SETTLEMENT_SERIES.price, r.ts, 900, r.priceEurMwh, 'EUR/MWh'));
          if (r.revenueEur != null) rows.push(sample(SETTLEMENT_SERIES.revenue, r.ts, 900, r.revenueEur, 'EUR'));
        }

        // Tagessummen (Tagesansicht schneidet an Ortsmitternacht, Zeiten in UTC):
        // nur volle Ortstage übernehmen. Ende exklusiv → bis heute anfragen.
        const segments = parseEnergyData(await guarded((c) => c.getJson(
          `energy_data/${producer.id}/prod/${energyDataCategory(producer.timeseriesCategory)}/day/${addDaysToDate(from, -1)}/${today}/`
        )));
        let dailyDays = 0;
        for (const seg of segments) {
          const date = localDateOf(seg.ts, TIME_ZONE);
          const start = localMidnight(date, TIME_ZONE).ms;
          const end = localMidnight(addDaysToDate(date, 1), TIME_ZONE).ms;
          if (seg.ts !== start || seg.ts + seg.durationMs !== end || date >= today) continue;
          rows.push(sample(SETTLEMENT_SERIES.dailyFeed, seg.ts, Math.round(seg.durationMs / 1000), seg.wh, 'Wh'));
          dailyDays += 1;
        }

        // Partner-API (vorbereitet): Einspeisung im Rohtakt, wenn eingeschaltet
        if (partnerActive(s) && s.partner.userId) {
          try {
            const feed = await partnerFactory(s.partner).producerFeed({
              userId: s.partner.userId, contractId: producer.id,
              start: new Date(localMidnight(from, TIME_ZONE).ms).toISOString(),
              end: new Date(localMidnight(today, TIME_ZONE).ms).toISOString(),
              aggregation: 'raw'
            });
            for (const f of feed) rows.push(sample(SETTLEMENT_SERIES.partnerFeed, f.ts, Math.round(f.durationMs / 1000), f.wh, 'Wh'));
          } catch (error) {
            st.partnerError = String(error.message || error);
            log('luox_partner_error', { phase: 'feed', code: error.code || 'error', error: st.partnerError }, 'warn');
          }
        }

        const stored = await writeRows(rows);
        Object.assign(st.settlement, {
          lastSuccessAt: new Date(now()).toISOString(), lastSuccessDate: today, ok: true, error: null,
          rows: sheet.rows.length, from, to, totals: sheet.totals, dailyDays, stored
        });
        log('luox_settlement_ok', { reason, rows: sheet.rows.length, dailyDays, stored });
        return { ok: true, rows: sheet.rows.length, dailyDays, from, to, totals: sheet.totals, stored };
      } catch (error) {
        Object.assign(st.settlement, { ok: false, error: String(error.message || error) });
        log('luox_settlement_error', { reason, code: error.code || 'error', error: st.settlement.error }, 'warn');
        return { ok: false, code: error.code || 'error', error: st.settlement.error };
      } finally {
        syncInFlight = null;
      }
    })();
    return syncInFlight;
  }

  /** Bericht je Ortstag: LUOX-Abrechnung neben DVhubs eigener Einspeisung × Day-Ahead. */
  async function settlementReport({ days = 30 } = {}) {
    const store = ctx.telemetryStore;
    if (typeof store?.listSeriesSamples !== 'function') return { ok: false, code: 'no_store', error: 'Keine Datenbank — Abgleich nicht möglich.' };
    const n = Math.min(366, Math.max(1, Math.round(Number(days) || 30)));
    const today = localDateOf(now(), TIME_ZONE);
    const start = new Date(localMidnight(addDaysToDate(today, -n), TIME_ZONE).ms).toISOString();
    const end = new Date(localMidnight(today, TIME_ZONE).ms).toISOString();
    const read = (seriesKey) => store.listSeriesSamples({ seriesKey, scope: SETTLEMENT_SCOPE, start, end })
      .then((rows) => rows.filter((r) => !r.source || r.source === SETTLEMENT_SOURCE));
    const [feed, revenue, daily, energy, prices] = await Promise.all([
      read(SETTLEMENT_SERIES.feed), read(SETTLEMENT_SERIES.revenue), read(SETTLEMENT_SERIES.dailyFeed),
      typeof store.listMaterializedEnergySlots === 'function' ? store.listMaterializedEnergySlots({ start, end }).catch(() => []) : [],
      typeof store.listPriceSlots === 'function' ? store.listPriceSlots({ start, end, bucketSeconds: 900 }).catch(() => []) : []
    ]);
    const byDay = new Map();
    const day = (ts) => {
      const d = localDateOf(new Date(ts).getTime(), TIME_ZONE);
      if (!byDay.has(d)) byDay.set(d, { date: d, luoxFeedKwh: null, luoxRevenueEur: null, luoxPortalDayKwh: null, dvhubExportKwh: null, dvhubRevenueEur: null });
      return byDay.get(d);
    };
    const add = (obj, key, v) => { obj[key] = (obj[key] ?? 0) + v; };
    for (const r of feed) add(day(r.ts), 'luoxFeedKwh', r.value / 1000);
    for (const r of revenue) add(day(r.ts), 'luoxRevenueEur', r.value);
    for (const r of daily) add(day(r.ts), 'luoxPortalDayKwh', r.value / 1000);
    const price = new Map(prices.map((p) => [new Date(p.ts).getTime(), Number(p.priceCtKwh)]));
    for (const e of energy) {
      const kwh = Number(e.exportKwh);
      if (!Number.isFinite(kwh)) continue;
      const d = day(e.ts);
      add(d, 'dvhubExportKwh', kwh);
      const ct = price.get(new Date(e.ts).getTime());
      if (Number.isFinite(ct)) add(d, 'dvhubRevenueEur', (kwh * ct) / 100);
    }
    const out = [...byDay.values()]
      .filter((d) => d.luoxFeedKwh != null || d.luoxPortalDayKwh != null)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        ...d,
        luoxFeedKwh: d.luoxFeedKwh == null ? null : round(d.luoxFeedKwh, 3),
        luoxRevenueEur: d.luoxRevenueEur == null ? null : round(d.luoxRevenueEur, 4),
        luoxPortalDayKwh: d.luoxPortalDayKwh == null ? null : round(d.luoxPortalDayKwh, 3),
        dvhubExportKwh: d.dvhubExportKwh == null ? null : round(d.dvhubExportKwh, 3),
        dvhubRevenueEur: d.dvhubRevenueEur == null ? null : round(d.dvhubRevenueEur, 4)
      }));
    const total = (key, digits) => {
      const vals = out.map((d) => d[key]).filter((v) => v != null);
      return vals.length ? round(vals.reduce((a, b) => a + b, 0), digits) : null;
    };
    return {
      ok: true, days: out, from: start, to: end,
      totals: {
        luoxFeedKwh: total('luoxFeedKwh', 3), luoxRevenueEur: total('luoxRevenueEur', 4),
        dvhubExportKwh: total('dvhubExportKwh', 3), dvhubRevenueEur: total('dvhubRevenueEur', 4)
      },
      note: 'LUOX-Abrechnung aus dem Portal (Einspeisung × Day-Ahead, vor Gebühren). Nur zum Abgleich — DVhub steuert nicht danach.'
    };
  }

  /** Verbindung prüfen (Einstellungen), ohne etwas zu speichern; '***' = gespeichert. */
  async function test(input = {}) {
    const saved = settings();
    const pick = (v, fallback) => (v == null || v === '' || v === MASK ? (fallback ?? '') : v);
    const override = { ...saved, email: pick(input.email, saved.email), password: pick(input.password, saved.password) };
    if (!portalConfigured(override)) return { ok: false, code: 'not_configured', error: 'E-Mail und Passwort fehlen.' };
    if (now() - lastTestMs < TEST_MIN_GAP_MS) return { ok: false, code: 'too_fast', error: 'Bitte ein paar Sekunden warten.' };
    lastTestMs = now();
    const same = fingerprint(override) === fingerprint(saved);
    try {
      const run = async (client) => summarizeContracts(await client.getJson('contracts'));
      const summary = same ? await guarded(run) : await run(portal({ useCache: false, override }));
      if (same) {
        contractsCache = { at: now(), summary };
        st.contracts = { at: new Date(now()).toISOString(), list: summary.contracts };
      }
      return { ok: true, contracts: summary.contracts, notice: LUOX_NOTICE };
    } catch (error) {
      return { ok: false, code: error.code || 'error', error: String(error.message || error) };
    }
  }

  /** „Jetzt abrufen“: Verträge, Day-Ahead, Endkundenpreis (falls an), Abgleich (falls an). */
  async function refresh() {
    const s = settings();
    const out = {};
    try { await contractSummary({ fresh: true }); out.contracts = true; } catch (e) { out.contractsError = e.message; }
    try { const d = await fetchDayAhead(); out.dayAhead = { source: d.source, today: d.todayCount, tomorrow: d.tomorrowCount }; } catch (e) { out.dayAheadError = e.message; }
    if (s.endCustomerPrice?.enabled === true) {
      try { tariffCache = null; await currentTariff(); out.tariff = true; } catch (e) { out.tariffError = e.message; }
    }
    if (s.dvSync?.enabled === true) out.settlement = await syncSettlement({ reason: 'manual' });
    return { ok: !out.dayAheadError, ...out };
  }

  async function tick() {
    const s = settings();
    const nowMs = now();
    if (!portalConfigured(s)) return;
    const due = settlementDue({
      enabled: s.dvSync?.enabled === true,
      todayLocal: localDateOf(nowMs, TIME_ZONE),
      minuteOfDay: localMinuteOfDay(nowMs, TIME_ZONE),
      lastSuccessDate: st.settlement.lastSuccessDate,
      lastAttemptMs: lastSettlementAttemptMs,
      nowMs
    });
    if (due) await syncSettlement({ reason: 'schedule' });
  }

  function getState() {
    syncFingerprint();
    const s = settings();
    return {
      notice: LUOX_NOTICE,
      portal: { configured: portalConfigured(s) },
      partner: { enabled: s.partner?.enabled === true, configured: partnerConfigured(s), environment: s.partner?.environment === 'test' ? 'test' : 'prod', active: partnerActive(s), error: st.partnerError },
      endCustomerPrice: { enabled: s.endCustomerPrice?.enabled === true, unverified: true },
      dvSync: { enabled: s.dvSync?.enabled === true },
      authBlockedUntil: authBlockedUntilMs && now() < authBlockedUntilMs ? new Date(authBlockedUntilMs).toISOString() : null,
      dayAhead: { ...st.dayAhead },
      contracts: st.contracts,
      tariff: st.tariff,
      settlement: { ...st.settlement }
    };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((e) => log('luox_tick_error', { error: e.message }, 'warn')); }, deps.tickMs || 10 * 60_000);
    timer.unref?.();
  }

  function startReadOnly() { /* Web-Prozess: nur Abrufe auf Anfrage (Einstellungen). */ }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, startReadOnly, stop, tick, fetchDayAhead, fetchTariffSlots, listContracts, syncSettlement, settlementReport, test, refresh, getState };
}
