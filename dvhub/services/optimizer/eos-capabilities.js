// services/optimizer/eos-capabilities.js -- antwortet ein EOS 0.4?
//
// DVhub unterstützt nur noch EOS 0.4 (DV-EOS-Tag dvhub-v0.4.0rc1.x = Upstream
// ab #1330 „complete GENETIC optimization", 17.09.2026). Ältere Stände (unser
// 0.3-Fork, der Maintainer-Branch, Upstream-main vor #1330) bekommen KEINE
// Konfiguration mehr geschrieben — sie werden nur noch erkannt, damit DVhub
// sagen kann, warum nichts passiert.
//
// Woran 0.4 zu erkennen ist (an v0.4.0rc1 gemessen):
//   - Intervall unter `optimization.genetic.interval_sec`, nicht unter
//     `optimization.interval`;
//   - Geräte als Abbildung nach `device_id` statt als Liste
//     (`devices.batteries` = {battery1: …}, `devices.electric_vehicles` = {}).
//
// Erkannt wird aus der Konfiguration selbst (GET /v1/config), nicht aus der
// Versionsnummer — die ist bei Entwicklungsständen nicht aussagekräftig.
// Die Fassungsnamen bleiben als Bezeichnung für Log und Status erhalten.

export const EOS_FLAVOR = Object.freeze({
  DV_FORK: 'dv-fork',
  UPSTREAM_DM: 'upstream-dm',
  UPSTREAM_MAIN: 'upstream-main',
  UPSTREAM_GENETIC: 'upstream-genetic',
  UNKNOWN: 'unknown',
});

export const EOS_UNSUPPORTED_REASON = 'EOS-Version wird nicht mehr unterstützt — DVhub braucht EOS 0.4';

// Die Abschnitte, in denen EOS Geräte führt. #1330 hat sie von Listen auf
// Abbildungen nach device_id umgestellt — an genau einer davon lässt sich die
// Fassung ablesen, ohne dass ein Gerät konfiguriert sein muss.
const DEVICE_SECTIONS = ['batteries', 'inverters', 'electric_vehicles', 'home_appliances'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// `in` statt Wahrheitsprüfung: EOS liefert unbelegte Schlüssel als null aus —
// vorhanden-aber-null heißt „kennt den Schlüssel", nicht „kennt ihn nicht".
const hasKey = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);

/**
 * @param {object|null} config  Antwort von GET /v1/config
 * @param {{version?: string}} [health] Antwort von GET /v1/health
 * @returns {{flavor: string, version: string|null, reachable: boolean,
 *   supported: boolean|null, reason: string|null, detectedAt: number}}
 *   `supported` ist null, solange EOS nicht erreichbar war.
 */
export function detectEosCapabilities(config, health = {}) {
  const cfg = isObj(config) ? config : null;
  const optimization = cfg && isObj(cfg.optimization) ? cfg.optimization : null;
  const genetic = optimization && isObj(optimization.genetic) ? optimization.genetic : null;
  const feedintariff = cfg && isObj(cfg.feedintariff) ? cfg.feedintariff : null;
  const devices = cfg && isObj(cfg.devices) ? cfg.devices : null;

  const directMarketingFlag = hasKey(feedintariff, 'direct_marketing_enabled');
  const optimizationInterval = hasKey(optimization, 'interval');
  const geneticIntervalSec = hasKey(genetic, 'interval_sec');
  // `isObj` schließt Arrays aus, eine leere Abbildung bleibt also erkennbar.
  const deviceMap = DEVICE_SECTIONS.some((k) => isObj(devices && devices[k]));

  let flavor = EOS_FLAVOR.UNKNOWN;
  if (directMarketingFlag && optimizationInterval) flavor = EOS_FLAVOR.UPSTREAM_DM;
  else if (geneticIntervalSec && !optimizationInterval) {
    flavor = (deviceMap || directMarketingFlag) ? EOS_FLAVOR.UPSTREAM_GENETIC : EOS_FLAVOR.UPSTREAM_MAIN;
  } else if (optimizationInterval) flavor = EOS_FLAVOR.DV_FORK;

  // Lastabhängige Wirkungsgradkurve (Akkudoktor-EOS PR #1375, in DV-EOS ab
  // dvhub-v0.4.0rc1.4): erkennbar am Feld im konfigurierten Wechselrichter —
  // EOS liefert unbelegte Felder als null mit aus. Ohne Wechselrichter in der
  // Config (allererster Sync) bleibt es false; der nächste Sync holt es nach.
  const inverters = devices && isObj(devices.inverters) ? Object.values(devices.inverters) : [];
  const inverterEfficiencyCurve = inverters.some((inv) => hasKey(inv, 'dc_to_ac_efficiency_curve'));
  // Fitness-Cache-Grenze (PR #1376) und feste Zeitzone (PR #1377), DV-EOS rc1.5.
  const fitnessCacheLimit = hasKey(genetic, 'fitness_cache_max_entries');
  const general = cfg && isObj(cfg.general) ? cfg.general : null;
  const timezoneOverride = hasKey(general, 'timezone_override');

  const reachable = !!cfg;
  const supported = reachable ? (flavor === EOS_FLAVOR.UPSTREAM_GENETIC && deviceMap) : null;

  return {
    flavor,
    version: (isObj(health) && health.version) || null,
    reachable,
    supported,
    reason: supported === false ? EOS_UNSUPPORTED_REASON : null,
    inverterEfficiencyCurve,
    fitnessCacheLimit,
    timezoneOverride,
    detectedAt: Date.now(),
  };
}

/**
 * Erkennung mit Gedächtnis. `request(baseUrl, method, path, body)` liefert
 * `{ ok, data, error }` (Signatur von eos-config-sync.eosHttpRequest).
 * Ein Fehlversuch wird NICHT gemerkt — sonst bliebe ein kurz nicht
 * erreichbares EOS für die ganze Frist als unerreichbar hängen.
 */
export function createEosCapabilityProbe({ request, ttlMs = 5 * 60 * 1000 } = {}) {
  let cached = null;   // { baseUrl, at, caps }

  async function get(baseUrl) {
    const now = Date.now();
    if (cached && cached.baseUrl === baseUrl && (now - cached.at) < ttlMs) return cached.caps;
    const cfgRes = await request(baseUrl, 'GET', '/v1/config');
    if (!cfgRes || !cfgRes.ok) {
      // EOS rechnet gerade (ein Kern) und antwortet nicht rechtzeitig: die
      // zuletzt erkannte Fassung gilt weiter. Sonst fiele ein Abgleich aus,
      // nur weil EOS beschäftigt ist (prod 2026-10-01).
      if (cached && cached.baseUrl === baseUrl) return cached.caps;
      return detectEosCapabilities(null, {});
    }
    let version = null;
    const healthRes = await request(baseUrl, 'GET', '/v1/health');
    if (healthRes && healthRes.ok && healthRes.data) version = healthRes.data.version || null;
    const caps = detectEosCapabilities(cfgRes.data, { version });
    cached = { baseUrl, at: now, caps };
    return caps;
  }

  return { get, reset: () => { cached = null; } };
}
