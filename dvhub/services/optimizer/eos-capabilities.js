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
//   upstream-main Upstream-main VOR dem GENETIC-Umbau (Stand 15.09.2026):
//                 Intervall liegt unter `optimization.genetic.interval_sec`
//                 und ist auf 3600 s festgenagelt; kein
//                 Direktvermarktungs-Schalter.
//   upstream-genetic  Upstream ab #1330 „complete GENETIC optimization"
//                 (17.09.2026, enthalten in v0.4.0rc1): Intervall ebenfalls
//                 unter `optimization.genetic.interval_sec`, aber 15 Minuten
//                 sind nativ erlaubt (`ems.py` lässt nur noch {900, 3600} zu).
//                 Dazu: Geräte als Abbildung nach `device_id` statt als Liste,
//                 `levelized_cost_of_storage_amt_kwh` statt `..._kwh`, zwei
//                 Algorithmen nebeneinander (GENETIC neu, GENETIC0 alt) und
//                 kein `elecprice.charges_kwh`/`vat_rate` mehr.
//
// Der Unterschied zwischen den beiden letzten ist keine Geschmacksfrage: auf
// `upstream-genetic` sind 15 Minuten möglich, auf `upstream-main` nicht. Wer
// beide gleich behandelt, stuft entweder still auf Stundenslots herab oder
// lässt den PUT auflaufen.
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
  UPSTREAM_GENETIC: 'upstream-genetic',
  UNKNOWN: 'unknown',
});

// Die Abschnitte, in denen EOS Geräte führt. #1330 hat sie von Listen auf
// Abbildungen nach device_id umgestellt — an genau einer davon lässt sich die
// Fassung ablesen, ohne dass ein Gerät konfiguriert sein muss.
const DEVICE_SECTIONS = ['batteries', 'inverters', 'electric_vehicles', 'home_appliances'];

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
  const elecprice = cfg && isObj(cfg.elecprice) ? cfg.elecprice : null;

  const directMarketingFlag = hasKey(feedintariff, 'direct_marketing_enabled');
  const optimizationInterval = hasKey(optimization, 'interval');
  const geneticIntervalSec = hasKey(genetic, 'interval_sec');
  const maxHomeAppliances = hasKey(devices, 'max_home_appliances');
  // Geräte als Abbildung statt als Liste (#1330). `isObj` schließt Arrays aus,
  // eine leere Abbildung bleibt also erkennbar — an v0.4.0rc1 gemessen:
  // `devices.batteries` = {battery1: …}, `devices.electric_vehicles` = {}.
  const deviceMap = DEVICE_SECTIONS.some((k) => isObj(devices && devices[k]));
  // GENETIC0 ist die alte Engine, die #1330 neben die neue gestellt hat. Wo es
  // sie gibt, wollen wir GENETIC ausdrücklich wählen statt den Vorgabewert
  // stillschweigend zu erben.
  const algorithmChoice = hasKey(optimization, 'genetic0') || Array.isArray(optimization && optimization.algorithms);
  // 0.3.x rechnete Abgaben und Steuer selbst auf den Börsenpreis; in main sind
  // beide Schlüssel gelöscht (dort gibt es das elecfee-Framework). DVhub
  // braucht keines von beidem, weil die Bridge bereits den aufgelösten
  // Endkundenpreis schickt — siehe eos-config-sync.js.
  const elecPriceCharges = hasKey(elecprice, 'charges_kwh');
  // Die Geräteplanung (Zeitfenster, Deadline, An/Aus-Instruktionen) kam mit
  // demselben Stand wie der Direktvermarktungs-Schalter — ein eigener Probe-
  // Aufruf lohnt dafür nicht.
  const applianceScheduling = directMarketingFlag && hasKey(devices, 'home_appliances');

  let flavor = EOS_FLAVOR.UNKNOWN;
  if (directMarketingFlag && optimizationInterval) flavor = EOS_FLAVOR.UPSTREAM_DM;
  else if (geneticIntervalSec && !optimizationInterval) {
    // Beide tragen das Intervall unter `genetic`. Auseinander hält sie, was
    // #1330 mitgebracht hat: die Geräte-Abbildung und der
    // Direktvermarktungs-Schalter (an v0.4.0rc1 gemessen, beide vorhanden).
    flavor = (deviceMap || directMarketingFlag) ? EOS_FLAVOR.UPSTREAM_GENETIC : EOS_FLAVOR.UPSTREAM_MAIN;
  } else if (optimizationInterval) flavor = EOS_FLAVOR.DV_FORK;

  return {
    flavor,
    version: (isObj(health) && health.version) || null,
    reachable: !!cfg,
    detectedAt: Date.now(),
    // Wo das Intervall steht, hängt an der Fassung, nicht an der Slot-Länge:
    // beide Upstream-Stände führen es unter `genetic`, Fork und
    // Maintainer-Branch unter `optimization`.
    intervalSection: (flavor === EOS_FLAVOR.UPSTREAM_MAIN || flavor === EOS_FLAVOR.UPSTREAM_GENETIC)
      ? INTERVAL_SECTION_GENETIC
      : INTERVAL_SECTION_DEFAULT,
    supports: {
      directMarketingFlag,
      applianceScheduling,
      maxHomeAppliances,
      deviceMap,
      algorithmChoice,
      elecPriceCharges,
      // Nur upstream-main (vor #1330) nagelt das Intervall auf 3600 s fest.
      // Unser Fork ist dafür gepatcht, der Maintainer-Branch kann es von Haus
      // aus, und ab #1330 lässt EOS ohnehin nur noch {900, 3600} zu —
      // 900 s auf v0.4.0rc1 gemessen (PUT 200).
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
