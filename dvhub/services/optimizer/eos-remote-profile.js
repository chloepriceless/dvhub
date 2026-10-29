// services/optimizer/eos-remote-profile.js — wie sich die EOS-Fassade beim
// Fernbetrieb gegenüber DVhub ausgibt (GET /v1/config).
//
// Nur die Schlüssel, an denen eos-capabilities.js die Fassung und die
// Fähigkeiten abliest, plus die Standardwerte, die DVhub zurückliest. Gemessen
// an Akkudoktor-EOS v0.4.0rc3 (Quelltext des Images
// bikinibottomcapital/dvhub-eos:v0.4.0rc3, 28.10.2026).
//
// BEWUSST WEGGELASSEN, obwohl rc3 sie kennt:
//   - ems.notify_url: Die Fassade antwortet auf POST /v1/optimize erst, wenn
//     der Plan da ist; eine Fertig-Meldung braucht es nicht.
//   - optimization.genetic.fitness_cache_max_entries: Speicher und Laufzeit
//     verwaltet der Rechendienst, nicht die Box.
// Fehlen sie hier, schickt eos-config-sync sie gar nicht erst.

export const EOS_REMOTE_PROFILE = Object.freeze({
  general: { timezone_override: null },
  optimization: {
    algorithm: 'GENETIC',
    algorithms: ['GENETIC', 'GENETIC0'],
    self_consumption_interpolator: 'scipy',
    genetic: {
      interval_sec: 3600,
      horizon_hours: 24,
      individuals: 300,
      generations: 400,
      measurement_max_age_seconds: 300,
      tail_horizon_hours: 48,
    },
  },
  devices: {
    max_batteries: null,
    max_inverters: null,
    max_electric_vehicles: null,
    max_home_appliances: null,
    batteries: {},
    inverters: {},
    electric_vehicles: {},
    home_appliances: {},
  },
  ems: { mode: null, interval: null },
  pvforecast: { provider: null },
  load: { provider: null },
  elecprice: { provider: null },
  feedintariff: { provider: null, direct_marketing_enabled: false },
});

// So legt EOS ein Gerät an, wenn DVhub nur einen Teil der Felder schickt
// (unbelegte Felder kommen als null zurück — daran erkennt die
// Fähigkeitserkennung z. B. die Wirkungsgradkurve).
export const EOS_REMOTE_DEVICE_TEMPLATES = Object.freeze({
  batteries: { device_id: null, capacity_wh: null, charging_efficiency: null, discharging_efficiency: null, max_charge_power_w: null, min_soc_percentage: 0, max_soc_percentage: 100 },
  inverters: {
    device_id: null, max_power_w: null, battery_id: null, ac_to_dc_efficiency: 1.0, dc_to_ac_efficiency: 1.0,
    dc_to_ac_efficiency_curve: null, dc_to_ac_efficiency_reference_load_fraction: 1.0, max_ac_charge_power_w: null,
  },
  electric_vehicles: { device_id: null, capacity_wh: null, min_soc_percentage: 0, max_soc_percentage: 100, min_soc_deadline_datetime: null },
  home_appliances: { device_id: null, consumption_wh: null, duration_h: null, earliest_start_datetime: null, deadline_datetime: null },
});
