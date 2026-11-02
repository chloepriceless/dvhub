// services/tariff-provider/index.js — Bezugspreis vom Stromanbieter abholen.
//
// Christin 2026-10-21: Tibber- und LichtBlick-Kunden tragen ihre eigenen
// Zugangsdaten ein (Einstellungen → Strompreis → „Vom Stromanbieter“). Die Box
// holt nur die Preise des eigenen Vertrags, für die eigene Planung — es geht
// nichts an Dritte. Statt Schätzung aus dem Börsenpreis rechnen Live-Kosten,
// EOS und Historie dann mit genau dem Preis, den der Kunde bezahlt.
//
// Takt: beim Start, danach stündlich. Fehlen die Preise für morgen, ab deren
// Veröffentlichung (Tibber ~13 Uhr, LichtBlick IDA1 ~15 Uhr) alle 15 min. Nach
// Fehlern länger warten; abgelehnte Zugangsdaten sperren den Abruf 6 h (bis sie
// geändert werden), damit der Anbieter das Konto nicht sperrt.
//
// Ablage: Reihe `tariff_import_ct_kwh` (scope 'tariff', source = Anbieter) in
// timeseries_samples, beim Start zurück in den Speicher (price-store.js), damit
// die Historie auch nach einem Neustart den bezahlten Preis kennt.
//
// Mitloggen (Christin 01.11.2026): Je Viertelstunde eine Zeile (Upsert auf
// Reihe/Anbieter/Zeit), daneben liegt der Day-Ahead-Preis (price_ct_kwh). Neu
// geschrieben wird nur ein neuer oder geänderter Preis; meta_json hält die
// Abrufzeit (fetchedAt), die Lesart (priceBasis) und bei einer Änderung den
// vorigen Preis (previousCtKwh). Aufbewahrung wie die Börsenpreise: scope
// 'tariff' ist keine 5-s-Rohreihe — weder die Log-Verdichtung (14 Tage gilt nur
// für Protokolle) noch die Platz-Wache (nur scope 'live') entfernt sie; ~35 000
// Zeilen je Jahr. Auswertung gegen Day-Ahead: price-stats.js, stats().

import path from 'node:path';
import crypto from 'node:crypto';
import { fetchTibberPrices } from './tibber-client.js';
import { fetchLichtblickPrices } from './lichtblick-client.js';
import { providerModeInUse } from './provider-pricing.js';
import {
  putProviderSlots, providerSlotsBetween, setProviderEstimate, getProviderEstimate, fitProviderEstimate, providerSlotAt,
  markProviderPricesLoading, dropProviderSlotsFrom
} from './price-store.js';
import { localDateOf, addDaysToDate, localMidnight, localMinuteOfDay } from './common.js';
import { pairProviderWithMarket, computeProviderPriceStats, clampStatsDays } from './price-stats.js';

export const SERIES_KEY = 'tariff_import_ct_kwh';
export const SERIES_SCOPE = 'tariff';
const TICK_MS = 60_000;
const REFRESH_MS = 60 * 60 * 1000;
const TOMORROW_RETRY_MS = 15 * 60 * 1000;
const AUTH_BLOCK_MS = 6 * 60 * 60 * 1000;
const ESTIMATE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Wie weit zurück gemerkt wird, was schon in der Datenbank steht: Die Anbieter
// liefern heute und morgen, ältere Slots kommen nicht wieder.
const PERSISTED_KEEP_MS = 3 * DAY_MS;
const DB_WAIT_MS = 10_000;

// Auf die Datenbank höchstens `ms` warten: Der Pool kennt keine Abfrage-
// Zeitgrenze, ein hängender Abruf hielte sonst `inFlight` für immer.
// Ergebnis: true = fertig geworden, false = Zeit abgelaufen.
async function waitAtMost(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const TIME_ZONE = 'Europe/Berlin';

// Ab wann die Preise für morgen da sein sollten (Ortszeit, Minute des Tages).
export const PUBLISH_MINUTE = Object.freeze({ tibber: 13 * 60 + 5, lichtblick: 15 * 60 + 20 });

export const PROVIDER_LABELS = Object.freeze({ tibber: 'Tibber', lichtblick: 'LichtBlick' });

const MASK = '***';

// Welcher Vertrag: Anbieter + Konto/Zuhause (ohne Passwort/Schlüssel — ein neues
// Passwort ist derselbe Vertrag).
function contractIdentity(settings = {}) {
  const name = settings.name || '';
  return JSON.stringify(name === 'tibber'
    ? [name, settings.tibber?.homeId || '']
    : [name, String(settings.lichtblick?.email || '').toLowerCase(), settings.lichtblick?.contractId ?? null]);
}

function credentialFingerprint(settings = {}) {
  const name = settings.name || '';
  const parts = name === 'tibber'
    ? [name, settings.tibber?.token, settings.tibber?.homeId]
    : [name, settings.lichtblick?.email, settings.lichtblick?.password, settings.lichtblick?.contractId];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** Zugangsdaten vollständig? (für Anzeige und Takt) */
export function providerCredentialsComplete(settings = {}) {
  if (settings.name === 'tibber') return !!settings.tibber?.token;
  if (settings.name === 'lichtblick') return !!settings.lichtblick?.email && !!settings.lichtblick?.password;
  return false;
}

/**
 * Ist jetzt ein Abruf fällig? Rein, damit testbar.
 * @param {object} s  { nowMs, lastAttemptMs, lastSuccessMs, failures, authBlockedUntilMs, hasTomorrow, minuteOfDay, publishMinute }
 */
export function fetchDue(s) {
  if (s.authBlockedUntilMs && s.nowMs < s.authBlockedUntilMs) return false;
  if (s.failures > 0) {
    const waitMs = Math.min(60, 5 * 2 ** (s.failures - 1)) * 60_000;
    return s.nowMs - (s.lastAttemptMs || 0) >= waitMs;
  }
  if (!s.lastSuccessMs) return true;
  if (s.nowMs - s.lastSuccessMs >= REFRESH_MS) return true;
  if (!s.hasTomorrow && s.minuteOfDay >= s.publishMinute && s.nowMs - (s.lastAttemptMs || 0) >= TOMORROW_RETRY_MS) return true;
  return false;
}

/** Eingaben aus dem Test-Formular mit den gespeicherten Zugangsdaten auffüllen ('***' oder leer = gespeichert). */
export function mergeTestSettings(saved = {}, input = {}) {
  const pick = (value, fallback) => (value == null || value === '' || value === MASK ? (fallback ?? '') : value);
  const name = input.name || saved.name || '';
  return {
    name,
    priceBasis: input.priceBasis || saved.priceBasis || 'gross_total',
    tibber: {
      token: pick(input.tibber?.token, saved.tibber?.token),
      homeId: pick(input.tibber?.homeId, saved.tibber?.homeId)
    },
    lichtblick: {
      email: pick(input.lichtblick?.email, saved.lichtblick?.email),
      password: pick(input.lichtblick?.password, saved.lichtblick?.password),
      contractId: input.lichtblick?.contractId ?? saved.lichtblick?.contractId ?? null
    }
  };
}

function emptyPricesMessage(name, account) {
  const label = PROVIDER_LABELS[name] || name;
  const status = account?.status;
  return status && status !== 'running'
    ? `${label} liefert keine Preise (Vertragsstatus: ${status}).`
    : `${label} liefert noch keine Preise (vor dem Lieferbeginn normal).`;
}

function summarizeSlots(slots, nowMs) {
  const today = localDateOf(nowMs, TIME_ZONE);
  const tomorrow = addDaysToDate(today, 1);
  const count = (date) => slots.filter((s) => localDateOf(s.ts, TIME_ZONE) === date).length;
  const values = slots.map((s) => s.ctKwh);
  const current = slots.find((s) => s.ts <= nowMs && nowMs < s.ts + s.durationMs) || null;
  return {
    todaySlots: count(today),
    tomorrowSlots: count(tomorrow),
    resolutionMinutes: slots.length ? Math.round(slots[0].durationMs / 60000) : null,
    minCtKwh: values.length ? Math.min(...values) : null,
    maxCtKwh: values.length ? Math.max(...values) : null,
    currentCtKwh: current ? current.ctKwh : null,
    firstSlot: slots.length ? new Date(slots[0].ts).toISOString() : null,
    lastSlotEnd: slots.length ? new Date(slots[slots.length - 1].ts + slots[slots.length - 1].durationMs).toISOString() : null
  };
}

export function createTariffProviderService(ctx, deps = {}) {
  const now = deps.now || (() => Date.now());
  const fetchImpl = deps.fetch || globalThis.fetch;
  const dataDir = deps.dataDir || '/var/lib/dvhub';
  const dbWaitMs = deps.dbWaitMs || DB_WAIT_MS;
  const cacheFile = path.join(dataDir, 'tariff-provider', 'lichtblick-token.json');
  const clients = {
    tibber: deps.fetchTibber || ((s) => fetchTibberPrices({ token: s.tibber.token, homeId: s.tibber.homeId, fetchImpl })),
    // useCache=false für den Verbindungstest mit fremden Zugangsdaten: der
    // Zwischenspeicher der gespeicherten Zugangsdaten bleibt unberührt.
    lichtblick: deps.fetchLichtblick || ((s, { useCache = true } = {}) => fetchLichtblickPrices({
      email: s.lichtblick.email, password: s.lichtblick.password, contractId: s.lichtblick.contractId,
      cacheFile: useCache ? cacheFile : null, fetchImpl, now
    }))
  };

  const st = {
    provider: null, active: false, configured: false, running: false,
    ok: null, error: null, errorCode: null,
    lastAttemptAt: null, lastSuccessAt: null, authBlockedUntil: null,
    account: null, summary: null, storedFromDb: 0, dbLoaded: false
  };
  let lastAttemptMs = 0;
  let lastSuccessMs = 0;
  let failures = 0;
  let authBlockedUntilMs = 0;
  let fingerprint = null;
  let timer = null;
  let inFlight = null;
  let dbLoading = null;
  let loadTimeoutLogged = null;   // je hängendem Lesen nur eine Warnung
  let loadFailed = false;         // Laden aus der Datenbank gescheitert (Web-Prozess holt nach)
  let lastTestMs = 0;
  let identity = null;
  let reloadTimer = null;
  const TEST_MIN_GAP_MS = 10_000;
  // Was sicher in der Datenbank steht: `${Anbieter}|${Slotbeginn ms}` → ct/kWh.
  const persisted = new Map();

  const settings = () => ctx.getCfg?.()?.userEnergyPricing?.provider || {};
  const log = (event, data, level) => { try { ctx.pushLog?.(event, data, level); } catch { /* ignore */ } };

  function syncConfigState() {
    const cfg = ctx.getCfg?.() || {};
    const s = settings();
    const id = contractIdentity(s);
    if (identity !== null && id !== identity) {
      // Anderer Anbieter oder anderer Vertrag: künftige Preise und Schätzung des
      // alten gelten nicht mehr. Die laufende Stunde und alles davor bleiben.
      const nowMs = now();
      const dropped = dropProviderSlotsFrom(nowMs - (nowMs % 3_600_000) + 3_600_000);
      log('tariff_provider_contract_changed', { provider: s.name || null, dropped });
    }
    identity = id;
    const fp = credentialFingerprint(s);
    if (fp !== fingerprint) {
      // Neue Zugangsdaten oder anderer Anbieter: Sperre und Wartezeit aufheben.
      fingerprint = fp;
      failures = 0;
      authBlockedUntilMs = 0;
      st.authBlockedUntil = null;
      lastSuccessMs = 0;
      if (st.provider !== (s.name || null)) { st.account = null; st.summary = null; }
    }
    st.provider = s.name || null;
    st.configured = providerCredentialsComplete(s);
    st.active = st.configured && providerModeInUse(cfg.userEnergyPricing || {}, localDateOf(now(), TIME_ZONE));
    return s;
  }

  function hasTomorrow(nowMs) {
    const tomorrow = addDaysToDate(localDateOf(nowMs, TIME_ZONE), 1);
    const start = localMidnight(tomorrow, TIME_ZONE).ms;
    return providerSlotsBetween(start, start + 23 * 60 * 60 * 1000).length > 0;
  }

  async function loadFromDb() {
    const store = ctx.telemetryStore;
    if (st.dbLoaded || typeof store?.listSeriesSamples !== 'function') return;
    if (dbLoading) return dbLoading;
    dbLoading = (async () => {
      try {
        const rows = await store.listSeriesSamples({ seriesKey: SERIES_KEY, scope: SERIES_SCOPE });
        const bySource = new Map();
        const keepFrom = now() - PERSISTED_KEEP_MS;
        for (const row of rows) {
          const list = bySource.get(row.source) || [];
          list.push({ ts: row.ts, ctKwh: row.value, durationMs: Number(row.resolutionSeconds || 900) * 1000 });
          bySource.set(row.source, list);
          const tsMs = new Date(row.ts).getTime();
          if (tsMs >= keepFrom) persisted.set(`${row.source}|${tsMs}`, Number(row.value));
        }
        // Der eingestellte Anbieter zuletzt: Bei doppelten Slots gilt seiner.
        // Schon in diesem Prozess abgerufene Slots bleiben — sie sind neuer als
        // die Datenbank (Laden erst nach einem Abruf, z. B. nach Lesefehler).
        const current = settings().name;
        const inMemory = new Set(providerSlotsBetween(-Infinity, Infinity).map((x) => x.ts));
        let n = 0;
        for (const [source, list] of [...bySource].sort(([a], [b]) => (a === current) - (b === current))) {
          n += putProviderSlots(source, list.filter((x) => !inMemory.has(new Date(x.ts).getTime())));
        }
        st.storedFromDb = n;
        st.dbLoaded = true;
        await refreshEstimate();
      } catch (error) {
        loadFailed = true;
        log('tariff_provider_db_load_error', { error: error.message }, 'warn');
      } finally {
        dbLoading = null;
      }
    })();
    return dbLoading;
  }

  // Laden mit Zeitgrenze (Takt und Abruf): Takt und Abruf warten höchstens
  // dbWaitMs. Das Lesen selbst läuft weiter (kein zweites daneben, das Pool-
  // Verbindungen bände) und wird übernommen, sobald es fertig ist; bis dahin
  // wird nicht geschrieben (writeSamples), getState().logging = 'pending'.
  // Scheitert es, stellt der nächste Takt es neu. Kommt es nie zurück (halb
  // offene TCP-Verbindung zu einer entfernten Datenbank; über den Unix-Socket
  // nicht möglich), bleibt es bis zum Neustart 'pending' — sichtbar in den
  // Einstellungen. Eine Zeitgrenze auf der Abfrage selbst bräuchte eine eigene
  // Verbindung samt Fehler-Listener (Gegenprüfung 8e701a3e) und lohnt hier nicht.
  async function loadFromDbBounded() {
    if (st.dbLoaded || typeof ctx.telemetryStore?.listSeriesSamples !== 'function') return;
    const pending = loadFromDb();
    if (await waitAtMost(pending, dbWaitMs)) return;
    if (st.dbLoaded || loadTimeoutLogged === dbLoading) return;
    loadTimeoutLogged = dbLoading;
    log('tariff_provider_db_load_timeout', { waitedMs: dbWaitMs }, 'warn');
  }

  // Ausgleichsgerade Anbieterpreis ↔ Börsenpreis aus den letzten 7 Tagen.
  async function refreshEstimate() {
    const nowMs = now();
    const market = new Map();
    try {
      const store = ctx.telemetryStore;
      if (typeof store?.listPriceSlots === 'function') {
        const rows = await store.listPriceSlots({ start: new Date(nowMs - ESTIMATE_LOOKBACK_MS).toISOString(), end: new Date(nowMs + 2 * 86400000).toISOString(), bucketSeconds: 900 });
        for (const r of rows) {
          const ts = new Date(r.ts).getTime();
          if (Number.isFinite(ts) && Number.isFinite(Number(r.priceCtKwh))) market.set(ts, Number(r.priceCtKwh));
        }
      }
    } catch { /* Schätzung nur aus dem Speicher */ }
    for (const r of Array.isArray(ctx.state?.epex?.data) ? ctx.state.epex.data : []) {
      const ts = Number(r?.ts);
      if (Number.isFinite(ts) && Number.isFinite(Number(r.ct_kwh))) market.set(ts, Number(r.ct_kwh));
    }
    const pairs = [];
    for (const [ts, m] of market) {
      if (ts < nowMs - ESTIMATE_LOOKBACK_MS) continue;
      const slot = providerSlotAt(ts);
      if (slot) pairs.push({ market: m, provider: slot.ctKwh });
    }
    const model = fitProviderEstimate(pairs);
    setProviderEstimate(model ? { ...model, provider: settings().name || null } : getProviderEstimate());
  }

  // Nur neue oder geänderte Preise schreiben; gemerkt wird erst nach dem
  // erfolgreichen Schreiben — scheitert es, folgt es beim nächsten Abruf.
  function writeSamples(provider, slots, priceBasis) {
    if (!slots.length || typeof ctx.telemetrySafeWrite !== 'function') return null;
    // Datenbank lesbar, aber noch nicht abgeglichen (Lesen gescheitert): nicht
    // blind schreiben — der nächste Abruf lädt erneut und holt es nach.
    if (!st.dbLoaded && typeof ctx.telemetryStore?.listSeriesSamples === 'function') return null;
    const nowMs = now();
    for (const key of [...persisted.keys()]) {
      if (Number(key.slice(key.lastIndexOf('|') + 1)) < nowMs - PERSISTED_KEEP_MS) persisted.delete(key);
    }
    const fetchedAt = new Date(nowMs).toISOString();
    const rows = [];
    for (const s of slots) {
      const tsMs = Number(s.ts);
      const key = `${provider}|${tsMs}`;
      const before = persisted.get(key);
      if (before === s.ctKwh) continue;
      const meta = { fetchedAt, priceBasis };
      if (before !== undefined) meta.previousCtKwh = before;
      rows.push({
        seriesKey: SERIES_KEY,
        scope: SERIES_SCOPE,
        source: provider,
        quality: 'raw',
        ts: new Date(tsMs).toISOString(),
        resolutionSeconds: Math.round(s.durationMs / 1000),
        value: s.ctKwh,
        unit: 'ct/kWh',
        meta
      });
    }
    if (!rows.length) return null;
    return Promise.resolve(ctx.telemetrySafeWrite(async () => { await ctx.telemetryStore.writeSamples(rows); return true; }))
      .then((ok) => {
        if (ok !== true) return;
        for (const r of rows) persisted.set(`${provider}|${Date.parse(r.ts)}`, r.value);
      })
      .catch(() => { /* telemetrySafeWrite meldet selbst */ });
  }

  async function runFetch(s, reason) {
    const nowMs = now();
    lastAttemptMs = nowMs;
    st.lastAttemptAt = new Date(nowMs).toISOString();
    st.running = true;
    const hadTomorrow = hasTomorrow(nowMs);
    try {
      // Erst abgleichen, was schon in der Datenbank steht (Abruf beim Start
      // oder per Knopf vor dem Laden): sonst bekämen unveränderte Preise eine
      // neue Abrufzeit und geänderte keinen Vorwert. Vor dem Abruf, damit die
      // geladenen Preise die frischen im Speicher nicht überschreiben.
      await loadFromDbBounded();
      const result = await clients[s.name](s);
      const slots = result.slots || [];
      putProviderSlots(s.name, slots);
      // Auf das Schreiben warten (höchstens dbWaitMs), damit eine Auswertung
      // direkt nach „Jetzt abrufen“ die neuen Preise sieht.
      const write = writeSamples(s.name, slots, s.priceBasis === 'net_energy' ? 'net_energy' : 'gross_total');
      if (write) await waitAtMost(write, dbWaitMs);
      failures = 0;
      lastSuccessMs = now();
      st.lastSuccessAt = new Date(lastSuccessMs).toISOString();
      st.ok = true;
      st.account = result.account || null;
      st.summary = summarizeSlots(slots, nowMs);
      // Leere Antwort ist kein Fehler (z. B. vor dem ersten Liefertag), aber sichtbar.
      st.error = slots.length ? null : emptyPricesMessage(s.name, result.account);
      st.errorCode = slots.length ? null : 'no_prices';
      await waitAtMost(refreshEstimate(), dbWaitMs);
      log('tariff_provider_ok', { provider: s.name, reason, slots: slots.length, tomorrow: st.summary.tomorrowSlots });
      if (!hadTomorrow && hasTomorrow(now())) {
        log('tariff_provider_tomorrow_arrived', { provider: s.name, triggering: 'eos_bridge_push' });
        Promise.resolve(ctx.eosForecastBridge?.push?.())
          .then(() => ctx.optimizerService?.requestEosReplanIfSparse?.('tariff'))
          .catch((err) => log('eos_forecast_bridge_error', { phase: 'tariff_arrived', error: err?.message || String(err) }));
      }
      return { ok: true, slots: slots.length };
    } catch (error) {
      failures += 1;
      st.ok = false;
      st.errorCode = error.code || 'error';
      st.error = String(error.message || error);
      if (error.code === 'auth') {
        authBlockedUntilMs = now() + AUTH_BLOCK_MS;
        st.authBlockedUntil = new Date(authBlockedUntilMs).toISOString();
      }
      log('tariff_provider_error', { provider: s.name, reason, code: st.errorCode, error: st.error, failures }, 'warn');
      return { ok: false, code: st.errorCode, error: st.error };
    } finally {
      st.running = false;
    }
  }

  async function tick() {
    await loadFromDbBounded();
    const s = syncConfigState();
    if (!st.active || inFlight) return;
    const nowMs = now();
    const due = fetchDue({
      nowMs, lastAttemptMs, lastSuccessMs, failures, authBlockedUntilMs,
      hasTomorrow: hasTomorrow(nowMs),
      minuteOfDay: localMinuteOfDay(nowMs, TIME_ZONE),
      publishMinute: PUBLISH_MINUTE[s.name] ?? 15 * 60
    });
    if (!due) return;
    inFlight = runFetch(s, 'schedule').finally(() => { inFlight = null; });
    await inFlight;
  }

  /** Sofort abrufen (Knopf in den Einstellungen). Eine Sperre nach abgelehnten Zugangsdaten gilt auch hier. */
  async function refresh(reason = 'manual') {
    const s = syncConfigState();
    if (!st.configured) return { ok: false, code: 'not_configured', error: 'Anbieter und Zugangsdaten fehlen.' };
    if (authBlockedUntilMs && now() < authBlockedUntilMs) {
      return { ok: false, code: 'auth_blocked', error: `Zugangsdaten wurden abgelehnt — neuer Versuch ab ${new Date(authBlockedUntilMs).toISOString()} oder nach Änderung der Zugangsdaten.` };
    }
    if (inFlight) return inFlight;
    inFlight = runFetch(s, reason).finally(() => { inFlight = null; });
    return inFlight;
  }

  /** Zugangsdaten prüfen, ohne etwas zu speichern. Höchstens alle 10 s (Kontosperre beim Anbieter). */
  async function test(input = {}) {
    const s = mergeTestSettings(settings(), input);
    if (!clients[s.name]) return { ok: false, code: 'not_configured', error: 'Bitte einen Anbieter wählen.' };
    if (!providerCredentialsComplete(s)) return { ok: false, code: 'not_configured', error: 'Zugangsdaten fehlen.' };
    if (now() - lastTestMs < TEST_MIN_GAP_MS) return { ok: false, code: 'too_fast', error: 'Bitte ein paar Sekunden warten.' };
    lastTestMs = now();
    const useCache = credentialFingerprint(s) === credentialFingerprint(settings());
    try {
      const result = await clients[s.name](s, { useCache });
      return { ok: true, provider: s.name, account: result.account || null, summary: summarizeSlots(result.slots || [], now()) };
    } catch (error) {
      return { ok: false, provider: s.name, code: error.code || 'error', error: String(error.message || error) };
    }
  }

  /**
   * Kennzahlen Anbieterpreis ↔ Day-Ahead des eingestellten Anbieters über die
   * letzten `days` Tage (plus die schon bekannten Preise für morgen).
   */
  async function stats({ days } = {}) {
    const store = ctx.telemetryStore;
    if (typeof store?.listSeriesSamples !== 'function' || typeof store?.listPriceSlots !== 'function') {
      return { ok: false, code: 'no_store', error: 'Keine Datenbank — Auswertung nicht möglich.' };
    }
    const cfg = ctx.getCfg?.() || {};
    const s = settings();
    if (!s.name) return { ok: false, code: 'not_configured', error: 'Noch kein Anbieter gespeichert.' };
    const d = clampStatsDays(days);
    const nowMs = now();
    const start = new Date(nowMs - d * DAY_MS).toISOString();
    const end = new Date(nowMs + 2 * DAY_MS).toISOString();
    const [providerRows, marketSlots] = await Promise.all([
      store.listSeriesSamples({ seriesKey: SERIES_KEY, scope: SERIES_SCOPE, start, end }),
      store.listPriceSlots({ start, end, bucketSeconds: 900 })
    ]);
    const own = providerRows.filter((r) => r.source === s.name);
    const vatRaw = cfg.userEnergyPricing?.dynamicComponents?.vatPct;
    const vatPct = vatRaw == null || vatRaw === '' || !Number.isFinite(Number(vatRaw)) ? 19 : Number(vatRaw);
    return {
      ok: true,
      provider: s.name,
      providerLabel: PROVIDER_LABELS[s.name] || s.name,
      days: d,
      from: start,
      to: end,
      providerSlots: own.length,
      ...computeProviderPriceStats(pairProviderWithMarket(own, marketSlots), { vatPct, priceBasis: s.priceBasis })
    };
  }

  function getState() {
    syncConfigState();
    const estimate = getProviderEstimate();
    return {
      ...st,
      // 'pending': Abgleich mit der Datenbank steht aus — neue Preise werden
      // noch nicht geloggt (writeSamples).
      logging: st.dbLoaded || typeof ctx.telemetryStore?.listSeriesSamples !== 'function' ? 'ok' : 'pending',
      providerLabel: st.provider ? PROVIDER_LABELS[st.provider] || st.provider : null,
      hasTomorrow: hasTomorrow(now()),
      estimate: estimate ? { slope: estimate.slope, interceptCtKwh: estimate.intercept, pairs: estimate.n } : null
    };
  }

  // Gespeicherte Preise laden, sobald die Datenbank da ist (höchstens 2 min warten).
  async function loadWhenStoreReady() {
    const until = now() + 120_000;
    while (!st.dbLoaded && now() < until) {
      if (typeof ctx.telemetryStore?.listSeriesSamples === 'function') { await loadFromDb(); return; }
      if (ctx.getCfg?.()?.telemetry?.enabled === false) return;
      await new Promise((resolve) => { const t = setTimeout(resolve, 500); t.unref?.(); });
    }
  }

  function start() {
    if (timer) return;
    markProviderPricesLoading(loadWhenStoreReady());
    timer = setInterval(() => { tick().catch((e) => log('tariff_provider_error', { phase: 'tick', error: e.message }, 'warn')); }, deps.tickMs || TICK_MS);
    timer.unref?.();
    setTimeout(() => { tick().catch(() => {}); }, 2000).unref?.();
  }

  // Getrennter Web-Prozess (DVHUB_ENABLE_RUNTIME_WORKER): nur lesen, nicht
  // abrufen. Der Runtime-Prozess schreibt neue Preise in die Datenbank; hier
  // alle 15 min die letzten zwei Tage und alles Künftige nachlesen.
  async function reloadRecent() {
    const store = ctx.telemetryStore;
    if (typeof store?.listSeriesSamples !== 'function') return;
    // Ist das Laden beim Start gescheitert, hier alles nachholen (sonst fehlten
    // dem Web-Prozess die Preise älter als zwei Tage bis zum Neustart).
    if (!st.dbLoaded && loadFailed) {
      await loadFromDb();
      if (st.dbLoaded) return;
    }
    const rows = await store.listSeriesSamples({ seriesKey: SERIES_KEY, scope: SERIES_SCOPE, start: new Date(now() - 2 * 86_400_000).toISOString() });
    const current = settings().name;
    putProviderSlots(current, rows.filter((r) => r.source === current)
      .map((r) => ({ ts: r.ts, ctKwh: r.value, durationMs: Number(r.resolutionSeconds || 900) * 1000 })));
    await refreshEstimate();
  }

  function startReadOnly() {
    markProviderPricesLoading(loadWhenStoreReady());
    if (reloadTimer) return;
    reloadTimer = setInterval(() => { reloadRecent().catch(() => {}); }, 15 * 60_000);
    reloadTimer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (reloadTimer) clearInterval(reloadTimer);
    timer = null;
    reloadTimer = null;
  }

  return { start, startReadOnly, stop, tick, refresh, test, getState, loadFromDb, reloadRecent, stats };
}
