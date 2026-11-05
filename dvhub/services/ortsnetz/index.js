// services/ortsnetz/index.js — Ortsnetz-Auslastung (www.ortsnetz-auslastung.de)
//
// Freiwillige Teilnahme an der Karte der Netzspannungen im Ortsnetz
// (Projekt github.com/thomaslehmann1234/datenerfassung-ortsnetz-auslastung):
// alle 5 Minuten L1/L2/L3-Spannung und Netzfrequenz des Netzzählers am
// Übergabepunkt plus ungefährer Standort an die öffentliche API. Kein Schlüssel.
// Die Antwort liefert eine Ampel je Phase und eine Speicherempfehlung
// (charge bei Über-, discharge bei Unterspannung) — hier nur angezeigt.
//
// Opt-in (ortsnetz.enabled, ab Werk aus). Quelle seit 05.11.2026: nur noch die
// zentralen Netzwerte des Pollers (state.victron.gridVoltage, services/
// grid-voltage.js) — keine eigene Modbus-Leseverbindung mehr. Damit läuft es
// mit jeder Quelle, die Spannungen liefert (Victron Modbus mit Unit-Suche,
// Victron MQTT, SPiNE EnergyLink). Werte älter als 2 min werden nicht gesendet.
// Regeln wie in den offiziellen Integrationen: Spannung nur 150–300 V (sonst
// wird NICHT gesendet), Frequenz nur 45–55 Hz (sonst weggelassen).

import { freshGridVoltage, GRID_VOLTAGE_MAX_AGE_MS } from '../grid-voltage.js';

export const ORTSNETZ_API_URL = 'https://www.ortsnetz-auslastung.de/v1/measurements';
export const ORTSNETZ_INTERVAL_MS = 5 * 60_000;
const FORECAST_TTL_MS = 60 * 60_000;
const SMARTMETER_MODELS = {
  victron_modbus: 'Victron GX Netzzähler',
  victron_mqtt: 'Victron GX Netzzähler',
  spine_http: 'SPiNE EnergyLink Netzzähler',
};

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/**
 * Pure: Messwerte → API-Payload (oder Grund, warum nicht gesendet wird).
 * @returns {{ ok: true, payload: object } | { ok: false, reason: string }}
 */
export function buildPayload({ nowMs, latitude, longitude, l1, l2, l3, frequencyHz, plantKwp, pvForecastKwh, model, version }) {
  if (!isNum(latitude) || !isNum(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return { ok: false, reason: 'location_missing' };
  }
  const volts = [l1, l2, l3];
  if (!volts.every(isNum)) return { ok: false, reason: 'voltage_missing' };
  if (!volts.every((v) => v >= 150 && v <= 300)) return { ok: false, reason: 'voltage_out_of_range' };
  const payload = {
    observed_at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    latitude: round(Number(latitude), 6),
    longitude: round(Number(longitude), 6),
    l1_v: round(Number(l1), 1),
    l2_v: round(Number(l2), 1),
    l3_v: round(Number(l3), 1),
  };
  if (isNum(frequencyHz) && frequencyHz >= 45 && frequencyHz <= 55) payload.grid_frequency_hz = round(Number(frequencyHz), 2);
  if (isNum(plantKwp) && plantKwp > 0 && plantKwp <= 1000) payload.plant_capacity_kwp = round(Number(plantKwp), 2);
  if (isNum(pvForecastKwh) && pvForecastKwh >= 0 && pvForecastKwh <= 100000) payload.pv_forecast_kwh = round(Number(pvForecastKwh), 2);
  if (model) payload.smartmeter_model = String(model).slice(0, 120);
  if (version) payload.integration_version = String(version).slice(0, 32);
  return { ok: true, payload };
}

export function createOrtsnetz(ctx, deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
  const now = deps.now || (() => Date.now());
  const pushLog = (event, data) => ctx.pushLog?.(event, data);
  let timer = null;
  let running = false;
  const forecastCache = { at: 0, kwh: null };
  const st = {
    lastAttemptAt: null, lastSentAt: null, lastError: null, lastSkip: null,
    lastMeasurement: null, lastResponse: null, sentCount: 0,
  };

  const cfgOf = () => (ctx.getCfg?.() || {});
  const settings = () => cfgOf().ortsnetz || {};

  // Standort: eigene Angabe, sonst Prognose-Standort, sonst Standort der Börsenautomatik.
  function location() {
    const c = cfgOf(); const o = settings();
    if (isNum(o.latitude) && isNum(o.longitude)) return { latitude: Number(o.latitude), longitude: Number(o.longitude), source: 'ortsnetz' };
    for (const [src, l] of [['forecast', c.forecast?.location], ['schedule', c.schedule?.smallMarketAutomation?.location]]) {
      if (l && isNum(l.latitude) && isNum(l.longitude)) return { latitude: Number(l.latitude), longitude: Number(l.longitude), source: src };
    }
    return null;
  }

  function plantKwp() {
    try {
      const s = ctx.licenseService?.getState?.();
      if (isNum(s?.system_kwp) && s.system_kwp > 0) return Number(s.system_kwp);
    } catch { /* optional */ }
    const plants = cfgOf().userEnergyPricing?.pvPlants;
    const sum = Array.isArray(plants) ? plants.reduce((a, p) => a + (Number(p?.kwp) || 0), 0) : 0;
    return sum > 0 ? sum : null;
  }

  async function pvForecastKwh() {
    if (settings().sendPvForecast === false) return null;
    if (now() - forecastCache.at < FORECAST_TTL_MS) return forecastCache.kwh;
    forecastCache.at = now();
    try {
      const r = await ctx.forecastService?.buildForecastResponse?.();
      forecastCache.kwh = isNum(r?.dailyTotals?.today?.pvKwh) ? Number(r.dailyTotals.today.pvKwh) : null;
    } catch { forecastCache.kwh = null; }
    return forecastCache.kwh;
  }

  // Zentrale Netzwerte (Poller) mit Frische-Prüfung.
  const getGridVoltage = deps.getGridVoltage || (() => ctx.state?.victron?.gridVoltage ?? null);
  function source() {
    return freshGridVoltage(getGridVoltage(), now(), GRID_VOLTAGE_MAX_AGE_MS);
  }

  async function tick() {
    if (running) return { skipped: 'busy' };
    if (settings().enabled !== true) return { skipped: 'disabled' };
    running = true;
    st.lastAttemptAt = new Date(now()).toISOString();
    try {
      const src = source();
      if (!src.ok) {
        st.lastSkip = src.reason;
        // Grund des zentralen Lesers (z. B. grid_meter_not_found) sichtbar machen.
        st.lastError = src.error || null;
        return { skipped: src.reason };
      }
      const loc = location();
      const m = { l1: src.l1, l2: src.l2, l3: src.l3, frequencyHz: src.frequencyHz };
      st.lastMeasurement = { ...m, at: new Date(src.updatedAt).toISOString() };
      const built = buildPayload({
        nowMs: now(), latitude: loc?.latitude, longitude: loc?.longitude,
        l1: m.l1, l2: m.l2, l3: m.l3, frequencyHz: m.frequencyHz,
        plantKwp: plantKwp(), pvForecastKwh: await pvForecastKwh(),
        model: SMARTMETER_MODELS[src.source] || 'Netzzähler',
        version: `dvhub-${ctx.getAppVersion?.()?.version || 'unknown'}`,
      });
      if (!built.ok) { st.lastSkip = built.reason; return { skipped: built.reason }; }
      const res = await fetchImpl(ORTSNETZ_API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(built.payload),
        signal: AbortSignal.timeout(15_000),
      });
      let j = null;
      try { j = await res.json(); } catch { /* kein JSON */ }
      if (res.status !== 202 && res.status !== 200) {
        st.lastError = res.status === 403 ? 'standort_gesperrt' : `http_${res.status}`;
        pushLog('ortsnetz_send_failed', { status: res.status });
        return { ok: false, status: res.status };
      }
      st.lastSentAt = st.lastAttemptAt;
      st.lastError = null;
      st.lastSkip = null;
      st.sentCount += 1;
      st.lastResponse = {
        status: j?.status || null,
        storageRecommendation: j?.storage_recommendation || null,
      };
      return { ok: true };
    } catch (e) {
      st.lastError = String(e?.message || e).slice(0, 160);
      return { ok: false, error: st.lastError };
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      // erster Versuch nach 60 s (Poller hat dann Netzwerte), dann alle 5 min
      const first = setTimeout(() => { tick().catch(() => {}); }, deps.firstDelayMs ?? 60_000);
      first.unref?.();
      timer = setInterval(() => { tick().catch(() => {}); }, ORTSNETZ_INTERVAL_MS);
      timer.unref?.();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick,
    status() {
      const loc = location();
      return {
        enabled: settings().enabled === true,
        sendPvForecast: settings().sendPvForecast !== false,
        location: loc,
        source: (() => { const src = source(); return src.ok ? src.source : src.reason; })(),
        ...st,
      };
    },
  };
}
