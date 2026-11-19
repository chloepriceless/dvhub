// services/forecast/pv-provider-setup.js — EINE Regel, wann ein PV-Prognosedienst eingerichtet ist.
//
// Christin 19.11.2026: „Wenn pv forecast provider nicht konfiguriert sind dann bitte auch nicht ins
// Ensemble aufnehmen.“ Bisher entschied pv-forecast.js je Dienst mit eigenen, teils fehlenden Prüfungen:
// Im Ensemble-Modus („both“) liefen Solcast und pvnode auch ohne API-Key, „Solcast aktiv = aus“ wurde nie
// gelesen, VRM lief schon mit dem Token allein, und die Gratis-Dienste meldeten ihr Fehlen jeden Lauf neu.
//
// Hier steht je Dienst, was er WIRKLICH braucht — abgeleitet aus seinem eigenen Client, damit Regel und
// Abruf nicht auseinanderlaufen. Dieselbe Regel steuert den Abruf (pv-forecast.js, alle Modi) und die
// Anzeige (inspector.js → Leitstand-Karte, Prognose-Inspektor der Einstellungen).
//
//   configured — die eigenen Einstellungen des Dienstes sind vollständig
//   eligible   — eingerichtet UND für diese Anlage verwendbar (Forecast.Solar: nicht bei gespreizter
//                Mehrflächen-Anlage, M13b). Nur eligible-Dienste werden abgerufen.
//   reason     — Maschinen-Code, warum nicht (null = ok)
//   hint       — kurzer deutscher Text für die Oberfläche
//
// Pure Funktionen: kein I/O, keine Zeit, nur cfg + ob die Python-Bridge da ist.

import { resolveForecastSolarParams, forecastSolarLocation, forecastSolarKwp } from './forecast-solar.js';
import { openMeteoSolarKwp } from './open-meteo-solar.js';
import { resolveLocation as resolvePvnodeLocation, resolvePlants as resolvePvnodePlants } from './pvnode-client.js';
import { resolveWeatherLocation } from './weather-fetch.js';
import { effectivePvKwp } from './effective-pv.js';

/** Alle PV-Prognosedienste des Ensembles (Reihenfolge = Anzeige-/Abrufreihenfolge). */
export const PV_PROVIDERS = ['pvnode', 'solcast', 'pvlib', 'vrm', 'forecast_solar', 'open_meteo'];

/** „Automatisch“: alle Dienste außer dem lokalen pvlib (Label in config-model.js). */
const AUTO_PROVIDERS = PV_PROVIDERS.filter((k) => k !== 'pvlib');

/** forecast.pv.model-Werte, die genau EINEN Dienst meinen („Nur …“, Diagnose). */
export const SINGLE_PROVIDER_MODELS = ['solcast', 'pvnode', 'pvlib', 'forecast_solar', 'open_meteo'];

export const PV_PROVIDER_LABELS = {
  pvnode: 'pvnode', solcast: 'Solcast', pvlib: 'pvlib', vrm: 'VRM',
  forecast_solar: 'Forecast.Solar', open_meteo: 'Open-Meteo',
};

const MODEL_LABELS = {
  both: '„Ensemble — alle aktiven Dienste“',
  auto: '„Automatisch“',
  solcast: '„Nur Solcast“', pvnode: '„Nur pvnode“', pvlib: '„Nur pvlib“',
  forecast_solar: '„Nur Forecast.Solar“', open_meteo: '„Nur Open-Meteo“',
};

const WHERE_PROVIDERS = 'Integrationen → PV-Forecast-Provider';
const WHERE_PLANT = 'Einstellungen → Meine Anlage';

const HINTS = {
  solcast: {
    disabled: 'Solcast ist ausgeschaltet (Einstellungen → Prognosen → Solcast aktiv)',
    missing_api_key: `kein API-Key hinterlegt (${WHERE_PROVIDERS} → Solcast)`,
    missing_site_id: `keine Site-ID hinterlegt (${WHERE_PROVIDERS} → Solcast)`,
  },
  pvnode: {
    missing_api_key: `kein API-Key hinterlegt (${WHERE_PROVIDERS} → pvnode)`,
    missing_location: `weder Standort-ID noch Standort für die Inline-Prognose (${WHERE_PLANT} → Standort)`,
    no_plants: `weder Standort-ID noch eine PV-Fläche mit kWp, Neigung und Richtung (${WHERE_PLANT})`,
  },
  pvlib: {
    no_python: 'die lokale Python-Umgebung für pvlib ist auf diesem Gerät nicht installiert',
    missing_location: `kein Standort eingetragen (${WHERE_PLANT} → Standort)`,
    no_kwp: `keine PV-Größe (kWp) eingetragen (${WHERE_PLANT})`,
  },
  vrm: {
    missing_token: 'kein VRM-Token hinterlegt (Integrationen → VRM Cloud)',
    missing_portal_id: 'keine VRM-Portal- oder Site-ID hinterlegt (Integrationen → VRM Cloud)',
    disabled: 'VRM-Anbindung ist ausgeschaltet (Integrationen → VRM Cloud: „History Import aktiv“)',
  },
  forecast_solar: {
    missing_location: `kein Standort eingetragen (${WHERE_PLANT} → Standort)`,
    no_kwp: `keine PV-Größe (kWp) eingetragen (${WHERE_PLANT})`,
    multi_plane_detailed: 'Dachflächen zeigen in verschiedene Richtungen — die Gratis-Abfrage von Forecast.Solar rechnet nur eine Fläche',
  },
  open_meteo: {
    no_kwp: `keine PV-Größe (kWp) eingetragen (${WHERE_PLANT})`,
    missing_location: `kein Standort für die Wetterdaten eingetragen (${WHERE_PLANT} → Standort)`,
  },
};

function ok() {
  return { configured: true, eligible: true, reason: null, hint: null };
}
function missing(provider, reason) {
  return { configured: false, eligible: false, reason, hint: HINTS[provider]?.[reason] ?? null };
}
function notApplicable(provider, reason) {
  return { configured: true, eligible: false, reason, hint: HINTS[provider]?.[reason] ?? null };
}
function filled(v) {
  return v != null && String(v).trim() !== '';
}
function finiteCoord(v) {
  return v != null && String(v).trim() !== '' && Number.isFinite(Number(v));
}

// Solcast (solcast-client.js fetchPvForecast): API-Key UND Site-ID, sonst kein Abruf. Der Schalter
// „Solcast aktiv“ (forecast.solcast.enabled) zählt, wenn er ausdrücklich false ist; fehlt er (ältere
// Configs), gilt Solcast mit Key + Site-ID als eingeschaltet (so lief es bisher).
function solcastSetup(cfg) {
  const sc = cfg?.forecast?.solcast || {};
  if (sc.enabled === false) return missing('solcast', 'disabled');
  if (!filled(sc.apiKey)) return missing('solcast', 'missing_api_key');
  if (!filled(sc.siteId)) return missing('solcast', 'missing_site_id');
  return ok();
}

// pvnode (pvnode-client.js fetchForecast): API-Key. Mit Standort-ID GET auf die gespeicherte Site,
// ohne POST /v2/forecast/inline — dafür braucht es Standort und mindestens eine PV-Fläche.
function pvnodeSetup(cfg) {
  const pn = cfg?.forecast?.pvnode || {};
  if (!filled(pn.apiKey)) return missing('pvnode', 'missing_api_key');
  if (String(pn.siteId ?? '').trim()) return ok();
  const c = cfg || {};
  if (!resolvePvnodeLocation(c)) return missing('pvnode', 'missing_location');
  if (resolvePvnodePlants(c).length === 0) return missing('pvnode', 'no_plants');
  return ok();
}

// pvlib (pv-forecast.js buildPvlibInput): Python-Bridge (venv), forecast.location (ohne SMA-Rückfall —
// buildPvlibInput liest nur forecast.location) und eine PV-Größe.
function pvlibSetup(cfg, pvlibAvailable) {
  if (!pvlibAvailable) return missing('pvlib', 'no_python');
  const loc = cfg?.forecast?.location;
  if (!finiteCoord(loc?.latitude) || !finiteCoord(loc?.longitude)) return missing('pvlib', 'missing_location');
  if (!effectivePvKwp(cfg, cfg?.forecast?.pv?.totalKwp)) return missing('pvlib', 'no_kwp');
  return ok();
}

// VRM: die Tabelle vrm_forecasts füllt nur epex-fetch.js fetchVrmForecast, und das nur mit
// telemetry.historyImport.enabled + vrmPortalId + vrmToken. vrm-forecast.isAvailable() prüfte bloß den
// Token — ohne Portal-ID oder bei ausgeschaltetem Import mischten alte Zeilen aus der Tabelle mit.
function vrmSetup(cfg) {
  const hi = cfg?.telemetry?.historyImport || {};
  if (!filled(hi.vrmToken)) return missing('vrm', 'missing_token');
  if (!filled(hi.vrmPortalId)) return missing('vrm', 'missing_portal_id');
  if (!hi.enabled) return missing('vrm', 'disabled');
  return ok();
}

// Forecast.Solar (forecast-solar.js resolveForecastSolarParams): Standort + kWp. Gespreizte
// Detail-Anlage → eingerichtet, aber nicht verwendbar (M13b).
function forecastSolarSetup(cfg) {
  if (!forecastSolarLocation(cfg)) return missing('forecast_solar', 'missing_location');
  if (!forecastSolarKwp(cfg)) return missing('forecast_solar', 'no_kwp');
  const params = resolveForecastSolarParams(cfg);
  if (params?.skip) return notApplicable('forecast_solar', params.skip);
  return ok();
}

// Open-Meteo-Schätzung (open-meteo-solar.js generateForecast): kWp + Wetterzeilen. Die Wetterzeilen
// holt weather-fetch.js nur mit Standort; alternativ liefert sie eine MQTT-Wetterstation.
function openMeteoSetup(cfg) {
  if (!openMeteoSolarKwp(cfg)) return missing('open_meteo', 'no_kwp');
  const mqttWeather = cfg?.forecast?.weather?.provider === 'mqtt';
  if (!mqttWeather && !resolveWeatherLocation(cfg)) return missing('open_meteo', 'missing_location');
  return ok();
}

/**
 * Einrichtungs-Stand aller PV-Prognosedienste.
 * @param {object} cfg - wirksame Config
 * @param {{pvlibAvailable?: boolean}} [opts] - pvlibAvailable: Python-Bridge vorhanden
 * @returns {Record<string, {configured:boolean, eligible:boolean, reason:string|null, hint:string|null}>}
 */
export function pvProviderSetup(cfg, { pvlibAvailable = false } = {}) {
  return {
    pvnode: pvnodeSetup(cfg),
    solcast: solcastSetup(cfg),
    pvlib: pvlibSetup(cfg, pvlibAvailable),
    vrm: vrmSetup(cfg),
    forecast_solar: forecastSolarSetup(cfg),
    open_meteo: openMeteoSetup(cfg),
  };
}

/**
 * Welche Dienste ein Prognose-Lauf abruft — je Modus (forecast.pv.model), nur eingerichtete.
 *
 *   both    → alle eingerichteten Dienste
 *   auto    → alle eingerichteten außer pvlib (auch für fehlende/unbekannte Werte)
 *   „Nur X“ → genau X, ohne andere Dienste (bisher mischte VRM immer mit). Ist X nicht eingerichtet,
 *             wird X nicht abgerufen; der Lauf nimmt dann „Automatisch“, damit die Anlage nicht ohne
 *             PV-Prognose dasteht (fallback nennt Modus und Grund).
 *
 * @returns {{ requestedModel:string, model:string, fallback:null|{model:string, reason:string|null, hint:string|null},
 *             fetch:string[], providers:Record<string, object>, modelLabel:string }}
 */
export function planPvProviders(cfg, { pvlibAvailable = false } = {}) {
  const setup = pvProviderSetup(cfg, { pvlibAvailable });
  const requestedModel = String(cfg?.forecast?.pv?.model || 'auto');
  let model;
  let candidates;
  let fallback = null;
  if (requestedModel === 'both') {
    model = 'both';
    candidates = PV_PROVIDERS;
  } else if (SINGLE_PROVIDER_MODELS.includes(requestedModel)) {
    if (setup[requestedModel].eligible) {
      model = requestedModel;
      candidates = [requestedModel];
    } else {
      model = 'auto';
      candidates = AUTO_PROVIDERS;
      fallback = { model: requestedModel, reason: setup[requestedModel].reason, hint: setup[requestedModel].hint };
    }
  } else {
    model = 'auto';
    candidates = AUTO_PROVIDERS;
  }
  const fetch = candidates.filter((k) => setup[k].eligible);
  const modelLabel = MODEL_LABELS[model] || MODEL_LABELS.auto;
  const providers = {};
  for (const k of PV_PROVIDERS) {
    const s = setup[k];
    const selected = candidates.includes(k);
    let reason = s.reason;
    let hint = s.hint;
    if (s.eligible && !selected) {
      reason = 'mode_excludes';
      hint = `nicht Teil der gewählten PV-Prognose-Quelle ${modelLabel} (Einstellungen → Meine Anlage → PV-Prognose-Quelle)`;
    }
    providers[k] = { ...s, selected, willFetch: selected && s.eligible, reason, hint };
  }
  return { requestedModel, model, fallback, fetch, providers, modelLabel };
}
