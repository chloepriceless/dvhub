// managed-load.js -- Inc 2: separation of controllable load from the learned load curve.
//
// WHY (see .planning/T-INC2-LAST-SEPARATION-DESIGN-2026-07-29.md):
// The load forecast learns from `load_power_w` = Victron `selfConsumptionW`, i.e. the
// WHOLE-HOUSE draw. Controllable loads (EV charging, switched devices) sit inside it.
// EOS then adds planned controllable load on top, strictly additive
// (eos-vendor genetic.py:378-383) -- so the same kilowatt is counted twice, and the
// night bias corrector cements the error. This module computes the subtrahend for a
// second, cleaned series (`load_power_w_ex_managed`); the raw series stays untouched.
//
// Measured on prod (.66, 17.05.-29.07.2026, PostgreSQL timeseries_samples):
//   - The wallbox IS inside selfConsumptionW: median load while charging at home
//     12,067 W vs. a predicted ~12,100 W (n=164) -- but ONLY when filtered by
//     geofence. Unfiltered, 88 away-from-home charge samples (destination chargers,
//     also ~11 kW) drag the median to 1,771 W and it looks like the wallbox is NOT
//     in there. Without the geofence filter this module would subtract ~10.7 kW of
//     phantom load every time the car charges somewhere else.
//   - `charger_power` LATCHES: gap to the next sample after a >8 kW reading had a
//     median of 20 s but a maximum of 80,273 s = 22.3 h (n=422). Hence the freshness
//     gate is load-bearing, not belt-and-braces.
//
// Two invariants hold everything together:
//   (1) POSITIVE CONFIRMATION ONLY. A contribution is subtracted only when every
//       condition is affirmatively true. Anything unknown, stale or unparsable
//       contributes 0 -- never an estimate. Uncertainty means ex_managed == raw.
//   (2) NO SILENT CLAMPING. If the subtraction would go negative, the ASSUMPTION is
//       wrong, not the meter. We then do not subtract at all and say so. A
//       `max(0, ...)` would hide exactly the failure the gate exists to catch.

export const DEFAULT_FRESHNESS_SECONDS = 120;
export const DEFAULT_HOME_GEOFENCE = 'Zuhause';

/**
 * Strict numeric coercion. `Number(null)` and `Number('')` are 0, not NaN -- so a
 * plain `Number.isFinite(Number(x))` check silently turns "no reading at all" into
 * a confirmed 0 W. Under invariant 1 that is the wrong direction: absence must never
 * become an affirmative measurement. (Caught by the unit tests, not by reading it.)
 */
function strictNumber(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'boolean') return NaN;
  return Number(value);
}

/**
 * True only if `at` is a usable timestamp within `freshnessSeconds` of `nowMs`.
 * Missing/unparsable => false (invariant 1). Future stamps beyond the window are
 * also rejected: a clock that runs ahead is a broken source, not a fresh one.
 */
function isFresh(at, nowMs, freshnessSeconds) {
  if (at == null) return false;
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(ms)) return false;
  const ageMs = nowMs - ms;
  return ageMs >= -1000 && ageMs <= freshnessSeconds * 1000;
}

/**
 * EV share of the current house load, in W.
 *
 * All four must hold, else 0:
 *   charging_state === 'Charging'  (plugged-in-but-idle draws nothing)
 *   geofence === home             (away charging is not our house load)
 *   charger_power finite and > 0
 *   all three fields fresh         (the 22.3 h latch, see header)
 *
 * The geofence stamp is checked too: geofence is event-sampled and can itself go
 * stale -- if the car leaves without a sampled transition, the cached value still
 * reads "Zuhause". Requiring charging_state to be *concurrently* fresh is the
 * second lock on that door; residual risk is reported in `reason`, not defined away.
 *
 * TeslaMate publishes charger_power in kW (see routes-api.js:2794) -> x1000.
 */
function evShareW(tesla, updatedAt, nowMs, freshnessSeconds, homeGeofence) {
  if (!tesla) return { w: 0, reason: 'ev_no_data' };

  const fresh = k => isFresh(updatedAt?.[k], nowMs, freshnessSeconds);

  if (tesla.chargingState !== 'Charging') return { w: 0, reason: 'ev_not_charging' };
  if (!fresh('chargingState')) return { w: 0, reason: 'ev_charging_state_stale' };
  if (tesla.geofence !== homeGeofence) return { w: 0, reason: 'ev_not_home' };
  if (!fresh('geofence')) return { w: 0, reason: 'ev_geofence_stale' };

  const kw = strictNumber(tesla.chargerPower);
  if (!Number.isFinite(kw) || kw <= 0) return { w: 0, reason: 'ev_power_unavailable' };
  if (!fresh('chargerPower')) return { w: 0, reason: 'ev_power_stale' };

  return { w: kw * 1000, reason: 'ev_applied' };
}

/**
 * Managed-device share, in W. Only devices dvhub actually controls (`managed`),
 * that are online, carry a finite non-negative reading, and were seen recently.
 *
 * Today this is effectively 0 on prod: exactly one Shelly is configured and nothing
 * marks it managed yet (no coordinator). The path is built and tested so that Inc 1/3
 * light it up without touching the telemetry core again -- stated plainly rather than
 * sold as present-day value.
 */
function deviceShareW(devices, nowMs, freshnessSeconds) {
  if (!Array.isArray(devices) || devices.length === 0) return { w: 0, ids: [] };
  let w = 0;
  const ids = [];
  for (const d of devices) {
    if (!d || d.managed !== true || d.online !== true) continue;
    const p = strictNumber(d.powerW);
    if (!Number.isFinite(p) || p < 0) continue;
    if (!isFresh(d.lastSeen, nowMs, freshnessSeconds)) continue;
    w += p;
    ids.push(d.id);
  }
  return { w, ids };
}

/**
 * Compute the cleaned load value for one poll cycle.
 *
 * @returns {{
 *   managedW: number,      // total subtrahend that qualified
 *   exManagedW: number|null, // value to store; null only when raw load is unusable
 *   applied: boolean,      // true iff a subtraction actually happened
 *   reason: string,        // why it did or did not -- goes into the log event
 *   evW: number,
 *   deviceW: number,
 *   deviceIds: string[]
 * }}
 *
 * `exManagedW` equals the raw load whenever nothing qualifies. The series is written
 * on EVERY cycle, gap-free, because the forecast learns from a continuous curve --
 * a series that vanished whenever the gate closed would be worse than no series.
 */
export function computeManagedLoad({
  loadW,
  tesla = null,
  teslaUpdatedAt = null,
  devices = [],
  nowMs = Date.now(),
  freshnessSeconds = DEFAULT_FRESHNESS_SECONDS,
  homeGeofence = DEFAULT_HOME_GEOFENCE
} = {}) {
  const raw = strictNumber(loadW);
  const configuredWindow = strictNumber(freshnessSeconds);
  const window = Number.isFinite(configuredWindow) && configuredWindow > 0
    ? configuredWindow
    : DEFAULT_FRESHNESS_SECONDS;

  const ev = evShareW(tesla, teslaUpdatedAt, nowMs, window, homeGeofence);
  const dev = deviceShareW(devices, nowMs, window);
  const managedW = ev.w + dev.w;

  // No usable raw load -> nothing to write. Returning null (not 0) keeps a missing
  // input from being recorded as a real 0 W house.
  if (!Number.isFinite(raw)) {
    return {
      managedW, exManagedW: null, applied: false, reason: 'load_unavailable',
      evW: ev.w, deviceW: dev.w, deviceIds: dev.ids
    };
  }

  if (managedW <= 0) {
    return {
      managedW: 0, exManagedW: raw, applied: false, reason: ev.reason,
      evW: 0, deviceW: 0, deviceIds: []
    };
  }

  const candidate = raw - managedW;

  // Invariant 2: a negative result falsifies the assumption "this load is inside
  // that meter reading" for this cycle -- stale value, wrong car, a second meter.
  // Keep the raw value and surface it; do not clamp.
  if (candidate < 0) {
    return {
      managedW, exManagedW: raw, applied: false, reason: 'implausible_negative',
      evW: ev.w, deviceW: dev.w, deviceIds: dev.ids
    };
  }

  return {
    managedW, exManagedW: candidate, applied: true, reason: 'applied',
    evW: ev.w, deviceW: dev.w, deviceIds: dev.ids
  };
}
