// services/optimizer/eos-capabilities.js -- welche EOS-Fassung antwortet?
// (2026-09-15, Christin: beide Fassungen unterstützen, damit ein Umstieg
// später nur noch ein Umhängen des Branches ist.)
//
// Drei Fassungen sind im Umlauf, und sie unterscheiden sich in genau den
// Konfigurationsschlüsseln, die DVhub schreibt:
//
//   dv-fork       unser Fork (Basis EOS v0.3.0 + DV-Patches, läuft auf prod):
//                 `optimization.interval` (inkl. 15 Minuten, von uns gepatcht),
//                 KEIN `feedintariff.direct_marketing_enabled`.
//   upstream-dm   Maintainer-Branch feat/direct-marketing-battery-grid-export
//                 (gespiegelt als DV-EOS/dvhub-test; wird nach dem Merge das
//                 neue upstream-main): `optimization.interval` UND
//                 `feedintariff.direct_marketing_enabled`, dazu die Planung
//                 steuerbarer Geräte (`devices.home_appliances`).
//   upstream-main heutiges Upstream-main: Intervall liegt unter
//                 `optimization.genetic.interval_sec` und ist auf 3600 s
//                 festgenagelt; kein Direktvermarktungs-Schalter.
//
// Erkannt wird aus der Konfiguration selbst (GET /v1/config), nicht aus der
// Versionsnummer — die ist bei Entwicklungsständen nicht aussagekräftig
// (der Branch meldet ebenfalls 0.3.0.dev…). Im Zweifel `unknown`, und
// `unknown` verhält sich exakt wie der bisherige Code: nichts schreiben, was
// nicht sicher existiert.

export const EOS_FLAVOR = Object.freeze({
  DV_FORK: 'dv-fork',
  UPSTREAM_DM: 'upstream-dm',
  UPSTREAM_MAIN: 'upstream-main',
  UNKNOWN: 'unknown',
});

const INTERVAL_SECTION_DEFAULT = 'optimization/interval';
const INTERVAL_SECTION_GENETIC = 'optimization/genetic/interval_sec';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// `in` statt Wahrheitsprüfung: EOS liefert unbelegte Schlüssel als null aus —
// vorhanden-aber-null heißt „kennt den Schlüssel", nicht „kennt ihn nicht".
const hasKey = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);

/**
 * @param {object|null} config  Antwort von GET /v1/config
 * @param {{version?: string}} [health] Antwort von GET /v1/health
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
  const maxHomeAppliances = hasKey(devices, 'max_home_appliances');
  // Die Geräteplanung (Zeitfenster, Deadline, An/Aus-Instruktionen) kam mit
  // demselben Stand wie der Direktvermarktungs-Schalter — ein eigener Probe-
  // Aufruf lohnt dafür nicht.
  const applianceScheduling = directMarketingFlag && hasKey(devices, 'home_appliances');

  let flavor = EOS_FLAVOR.UNKNOWN;
  if (directMarketingFlag && optimizationInterval) flavor = EOS_FLAVOR.UPSTREAM_DM;
  else if (geneticIntervalSec && !optimizationInterval) flavor = EOS_FLAVOR.UPSTREAM_MAIN;
  else if (optimizationInterval) flavor = EOS_FLAVOR.DV_FORK;

  return {
    flavor,
    version: (isObj(health) && health.version) || null,
    reachable: !!cfg,
    detectedAt: Date.now(),
    // upstream-main nagelt das Intervall auf 3600 s fest; überall sonst sind
    // 15 Minuten möglich (unser Fork gepatcht, der Branch von Haus aus).
    intervalSection: flavor === EOS_FLAVOR.UPSTREAM_MAIN ? INTERVAL_SECTION_GENETIC : INTERVAL_SECTION_DEFAULT,
    supports: {
      directMarketingFlag,
      applianceScheduling,
      maxHomeAppliances,
      quarterHour: flavor !== EOS_FLAVOR.UPSTREAM_MAIN,
    },
  };
}

/**
 * Erkennung mit Gedächtnis. `request(baseUrl, method, path, body)` liefert
 * `{ ok, data, error }` (Signatur von eos-config-sync.eosHttpRequest).
 * Ein Fehlversuch wird NICHT gemerkt — sonst bliebe ein kurz nicht
 * erreichbares EOS für die ganze Frist als `unknown` hängen.
 */
export function createEosCapabilityProbe({ request, ttlMs = 5 * 60 * 1000 } = {}) {
  let cached = null;   // { baseUrl, at, caps }

  async function get(baseUrl) {
    const now = Date.now();
    if (cached && cached.baseUrl === baseUrl && (now - cached.at) < ttlMs) return cached.caps;
    const cfgRes = await request(baseUrl, 'GET', '/v1/config');
    if (!cfgRes || !cfgRes.ok) {
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
