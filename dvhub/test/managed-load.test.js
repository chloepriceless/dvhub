import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeManagedLoad,
  DEFAULT_FRESHNESS_SECONDS,
  DEFAULT_HOME_GEOFENCE
} from '../managed-load.js';

// Anchors taken from the prod measurement in
// .planning/T-INC2-LAST-SEPARATION-DESIGN-2026-07-29.md §1:
// median house load while charging at home = 12,067 W at ~10.7 kW charge power.
const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const LOAD_WHILE_CHARGING_W = 12067;
const CHARGE_KW = 10.7;

const fresh = (secondsAgo = 5) => new Date(NOW - secondsAgo * 1000);

function teslaCharging(overrides = {}) {
  return {
    chargingState: 'Charging',
    geofence: DEFAULT_HOME_GEOFENCE,
    chargerPower: CHARGE_KW,
    ...overrides
  };
}

function stamps(overrides = {}) {
  return {
    chargingState: fresh(),
    geofence: fresh(),
    chargerPower: fresh(),
    ...overrides
  };
}

const run = (opts = {}) => computeManagedLoad({ nowMs: NOW, ...opts });

// ── EV share ────────────────────────────────────────────────────────────────

test('subtracts the EV share when charging at home with fresh samples', () => {
  const r = run({
    loadW: LOAD_WHILE_CHARGING_W,
    tesla: teslaCharging(),
    teslaUpdatedAt: stamps()
  });

  // 10.7 kW -> 10700 W; 12067 - 10700 = 1367 W residual house load, which is the
  // ~1.4 kW base load the B0 oracle predicted.
  assert.equal(r.evW, 10700);
  assert.equal(r.managedW, 10700);
  assert.equal(r.exManagedW, 1367);
  assert.equal(r.applied, true);
  assert.equal(r.reason, 'applied');
});

test('does NOT subtract when the car charges away from home', () => {
  // The regression the prod measurement exposed: 88 of 252 charge samples were
  // destination charging at ~11 kW. Without the geofence gate this would subtract
  // ~10.7 kW of load that was never in this house's meter.
  for (const geofence of ['', null, undefined, 'Arbeit']) {
    const r = run({
      loadW: 1488, // measured median load while charging away
      tesla: teslaCharging({ geofence }),
      teslaUpdatedAt: stamps()
    });
    assert.equal(r.managedW, 0, `geofence=${JSON.stringify(geofence)}`);
    assert.equal(r.exManagedW, 1488);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'ev_not_home');
  }
});

test('does NOT subtract a latched charger_power value (the 22.3 h tail)', () => {
  // Measured worst case: 80,273 s between samples. The value still reads 10.7 kW
  // but describes a charge that ended a day ago.
  const r = run({
    loadW: 800,
    tesla: teslaCharging(),
    teslaUpdatedAt: stamps({ chargerPower: new Date(NOW - 80_273 * 1000) })
  });

  assert.equal(r.managedW, 0);
  assert.equal(r.exManagedW, 800);
  assert.equal(r.reason, 'ev_power_stale');
});

test('rejects a stale charging_state and a stale geofence independently', () => {
  const stalePower = run({
    loadW: 5000,
    tesla: teslaCharging(),
    teslaUpdatedAt: stamps({ chargingState: new Date(NOW - 3600 * 1000) })
  });
  assert.equal(stalePower.reason, 'ev_charging_state_stale');
  assert.equal(stalePower.managedW, 0);

  const staleGeo = run({
    loadW: 5000,
    tesla: teslaCharging(),
    teslaUpdatedAt: stamps({ geofence: new Date(NOW - 3600 * 1000) })
  });
  assert.equal(staleGeo.reason, 'ev_geofence_stale');
  assert.equal(staleGeo.managedW, 0);
});

test('a missing timestamp counts as stale, never as fresh-by-default', () => {
  const r = run({
    loadW: 5000,
    tesla: teslaCharging(),
    teslaUpdatedAt: {} // nothing ever received
  });
  assert.equal(r.managedW, 0);
  assert.equal(r.exManagedW, 5000);

  const noStampsAtAll = run({
    loadW: 5000,
    tesla: teslaCharging(),
    teslaUpdatedAt: null
  });
  assert.equal(noStampsAtAll.managedW, 0);
});

test('does not subtract while plugged in but not actively charging', () => {
  for (const state of ['Complete', 'Stopped', 'Disconnected', 'NoPower', null]) {
    const r = run({
      loadW: 1400,
      tesla: teslaCharging({ chargingState: state }),
      teslaUpdatedAt: stamps()
    });
    assert.equal(r.managedW, 0, `state=${state}`);
    assert.equal(r.reason, 'ev_not_charging');
  }
});

test('ignores non-finite or non-positive charger power', () => {
  for (const p of [0, -3, NaN, null, 'abc']) {
    const r = run({
      loadW: 1400,
      tesla: teslaCharging({ chargerPower: p }),
      teslaUpdatedAt: stamps()
    });
    assert.equal(r.managedW, 0, `power=${p}`);
    assert.equal(r.reason, 'ev_power_unavailable');
  }
});

test('rejects a timestamp from the future beyond clock tolerance', () => {
  const r = run({
    loadW: 12067,
    tesla: teslaCharging(),
    teslaUpdatedAt: stamps({ chargerPower: new Date(NOW + 60_000) })
  });
  assert.equal(r.managedW, 0);
  assert.equal(r.reason, 'ev_power_stale');
});

// ── Device share ────────────────────────────────────────────────────────────

const device = (o = {}) => ({
  id: 'shelly-1', powerW: 300, online: true, managed: true, lastSeen: NOW - 5000, ...o
});

test('subtracts only devices that are managed, online, finite and fresh', () => {
  const r = run({
    loadW: 2000,
    devices: [
      device({ id: 'managed-ok', powerW: 300 }),
      device({ id: 'not-managed', managed: false, powerW: 900 }),
      device({ id: 'offline', online: false, powerW: 900 }),
      device({ id: 'stale', lastSeen: NOW - 3600 * 1000, powerW: 900 }),
      device({ id: 'no-reading', powerW: null }),
      device({ id: 'negative', powerW: -50 })
    ]
  });

  assert.equal(r.deviceW, 300);
  assert.deepEqual(r.deviceIds, ['managed-ok']);
  assert.equal(r.exManagedW, 1700);
  assert.equal(r.applied, true);
});

test('device share defaults to zero when nothing is marked managed', () => {
  // Today's prod reality: one Shelly, no coordinator, nothing marked managed.
  const r = run({ loadW: 1400, devices: [device({ managed: undefined })] });
  assert.equal(r.deviceW, 0);
  assert.equal(r.exManagedW, 1400);
  assert.equal(r.applied, false);
});

test('EV and device shares add up', () => {
  const r = run({
    loadW: LOAD_WHILE_CHARGING_W,
    tesla: teslaCharging(),
    teslaUpdatedAt: stamps(),
    devices: [device({ powerW: 67 })]
  });
  assert.equal(r.managedW, 10767);
  assert.equal(r.exManagedW, 1300);
});

// ── Invariant 2: no silent clamping ─────────────────────────────────────────

test('a negative result keeps the raw value and is flagged, never clamped to 0', () => {
  const r = run({
    loadW: 900, // house draws less than the claimed charge power
    tesla: teslaCharging(),
    teslaUpdatedAt: stamps()
  });

  assert.equal(r.applied, false);
  assert.equal(r.reason, 'implausible_negative');
  assert.equal(r.exManagedW, 900, 'falls back to the raw load, not to 0');
  assert.notEqual(r.exManagedW, 0);
  assert.equal(r.managedW, 10700, 'the rejected subtrahend stays visible for the log');
});

test('exactly zero residual is plausible and is applied', () => {
  const r = run({
    loadW: 10700,
    tesla: teslaCharging(),
    teslaUpdatedAt: stamps()
  });
  assert.equal(r.applied, true);
  assert.equal(r.exManagedW, 0);
});

// ── Raw load handling ───────────────────────────────────────────────────────

test('returns null when the raw load itself is unusable', () => {
  for (const loadW of [null, undefined, NaN, 'x']) {
    const r = run({ loadW, tesla: teslaCharging(), teslaUpdatedAt: stamps() });
    assert.equal(r.exManagedW, null, `loadW=${loadW}`);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'load_unavailable');
  }
});

test('with no controllable load at all the series mirrors the raw series', () => {
  const r = run({ loadW: 1234 });
  assert.equal(r.exManagedW, 1234);
  assert.equal(r.managedW, 0);
  assert.equal(r.applied, false);
});

// ── Configuration ───────────────────────────────────────────────────────────

test('freshness window is configurable and falls back to the default when invalid', () => {
  const at = { ...stamps(), chargerPower: new Date(NOW - 600 * 1000) }; // 10 min old

  const wide = run({
    loadW: LOAD_WHILE_CHARGING_W, tesla: teslaCharging(), teslaUpdatedAt: at,
    freshnessSeconds: 900
  });
  assert.equal(wide.applied, true, '10 min old passes a 15 min window');

  for (const bad of [0, -5, null, 'abc']) {
    const r = run({
      loadW: LOAD_WHILE_CHARGING_W, tesla: teslaCharging(), teslaUpdatedAt: at,
      freshnessSeconds: bad
    });
    assert.equal(r.applied, false, `freshnessSeconds=${bad} must fall back to the default`);
  }

  assert.equal(DEFAULT_FRESHNESS_SECONDS, 120);
});

test('home geofence label is configurable', () => {
  const r = run({
    loadW: LOAD_WHILE_CHARGING_W,
    tesla: teslaCharging({ geofence: 'Hof' }),
    teslaUpdatedAt: stamps(),
    homeGeofence: 'Hof'
  });
  assert.equal(r.applied, true);
  assert.equal(r.evW, 10700);
});
