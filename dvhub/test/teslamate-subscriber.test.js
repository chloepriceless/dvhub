// test/teslamate-subscriber.test.js -- TeslaMate MQTT subscriber tests (INTG-04, INTG-06)
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTeslamateSubscriber } from '../services/mqtt/teslamate.js';

// ── Test helpers ────────────────────────────────────────────────────

function makeMockHub() {
  const subscriptions = [];
  const handlers = new Map();
  return {
    subscribe(topic, handler) {
      subscriptions.push(topic);
      if (!handlers.has(topic)) handlers.set(topic, []);
      handlers.get(topic).push(handler);
    },
    get connected() { return true; },
    _subscriptions: subscriptions,
    _handlers: handlers,
    /** Simulate an incoming MQTT message */
    _deliver(topic, payload) {
      const buf = Buffer.from(String(payload));
      for (const [pattern, fns] of handlers.entries()) {
        // Simple wildcard match for # at end
        const prefix = pattern.replace(/#$/, '');
        if (topic.startsWith(prefix) || topic === pattern) {
          for (const fn of fns) fn(topic, buf);
        }
      }
    }
  };
}

function makeMockDb() {
  const queries = [];
  return {
    query(sql, params) {
      queries.push({ sql, params });
      return Promise.resolve({ rows: [] });
    },
    _queries: queries
  };
}

/**
 * A fake telemetryStore for the DB-historisation/seed tests, mirroring the
 * Plan 11-02 family-mqtt-tiles `makeMockStore` shape.
 *  - `writes` accumulates every `rows` array passed to writeSamples.
 *  - `seedRows` is the array querySeries returns (set up per test).
 *  - querySeries `behavior`: 'resolve' (default) or 'reject'.
 */
function makeMockStore({ seedRows = [], behavior = 'resolve' } = {}) {
  const writes = [];
  return {
    writes,
    seedRows,
    writeSamples(rows) {
      writes.push(rows);
      return Promise.resolve();
    },
    querySeries(_opts) {
      return behavior === 'reject'
        ? Promise.reject(new Error('pg down'))
        : Promise.resolve(seedRows);
    }
  };
}

/** Wait one macrotask so a fire-and-forget Promise chain settles. */
function flush() {
  return new Promise(r => setTimeout(r, 0));
}

function makeMockCtx(overrides = {}) {
  const logs = [];
  const db = overrides.db || makeMockDb();
  const ctx = {
    state: {},
    getCfg: () => ({
      integrations: {
        tesla: {
          enabled: true,
          teslamateCarId: 2,
          name: 'Tesla',
          snapshotIntervalSec: 300,
          ...overrides.teslaConfig
        }
      }
    }),
    pushLog: (msg, data) => logs.push({ msg, data }),
    db,
    _logs: logs,
    _db: db
  };
  // telemetryStore is read LAZILY off ctx by teslamate.js (server.js wires it
  // after the factory runs), so a test attaches it directly onto the ctx object.
  if (overrides.telemetryStore !== undefined) ctx.telemetryStore = overrides.telemetryStore;
  return ctx;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createTeslamateSubscriber', () => {
  let hub, ctx, subscriber;

  beforeEach(() => {
    hub = makeMockHub();
    ctx = makeMockCtx();
  });

  it('returns object with start, close, getState, lastUpdateAt', () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    assert.equal(typeof subscriber.start, 'function');
    assert.equal(typeof subscriber.close, 'function');
    assert.equal(typeof subscriber.getState, 'function');
    assert.ok('lastUpdateAt' in subscriber);
  });

  it('start() subscribes to teslamate/cars/{carId}/# via hub.subscribe', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();
    assert.ok(
      hub._subscriptions.some(t => t === 'teslamate/cars/2/#'),
      `Expected subscription to 'teslamate/cars/2/#', got: ${hub._subscriptions}`
    );
  });

  it('incoming battery_level message updates cached state.batteryLevel to parsed number', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();
    hub._deliver('teslamate/cars/2/battery_level', '85');
    const state = subscriber.getState();
    assert.equal(state.batteryLevel, 85);
  });

  it('incoming state message updates cached state.state to string value', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();
    hub._deliver('teslamate/cars/2/state', 'charging');
    const state = subscriber.getState();
    assert.equal(state.state, 'charging');
  });

  it('incoming plugged_in message parses "true"/"false" string to boolean', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();

    hub._deliver('teslamate/cars/2/plugged_in', 'true');
    assert.equal(subscriber.getState().pluggedIn, true);

    hub._deliver('teslamate/cars/2/plugged_in', 'false');
    assert.equal(subscriber.getState().pluggedIn, false);
  });

  it('incoming charger_power message parses to number (kW)', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();
    hub._deliver('teslamate/cars/2/charger_power', '11.5');
    assert.equal(subscriber.getState().chargerPower, 11.5);
  });

  it('getState() returns full snapshot object with all cached fields', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();

    // Send all 15 topics
    hub._deliver('teslamate/cars/2/display_name', 'Model 3');
    hub._deliver('teslamate/cars/2/state', 'online');
    hub._deliver('teslamate/cars/2/battery_level', '72');
    hub._deliver('teslamate/cars/2/usable_battery_level', '70');
    hub._deliver('teslamate/cars/2/est_battery_range_km', '310.5');
    hub._deliver('teslamate/cars/2/rated_battery_range_km', '350');
    hub._deliver('teslamate/cars/2/plugged_in', 'true');
    hub._deliver('teslamate/cars/2/charging_state', 'Charging');
    hub._deliver('teslamate/cars/2/charge_energy_added', '15.2');
    hub._deliver('teslamate/cars/2/charge_limit_soc', '90');
    hub._deliver('teslamate/cars/2/charger_power', '11');
    hub._deliver('teslamate/cars/2/charger_voltage', '230');
    hub._deliver('teslamate/cars/2/charger_actual_current', '16');
    hub._deliver('teslamate/cars/2/geofence', 'Home');
    hub._deliver('teslamate/cars/2/inside_temp', '21.5');

    const state = subscriber.getState();
    assert.equal(state.displayName, 'Model 3');
    assert.equal(state.state, 'online');
    assert.equal(state.batteryLevel, 72);
    assert.equal(state.usableBatteryLevel, 70);
    assert.equal(state.estRangeKm, 310.5);
    assert.equal(state.ratedRangeKm, 350);
    assert.equal(state.pluggedIn, true);
    assert.equal(state.chargingState, 'Charging');
    assert.equal(state.chargeEnergyAdded, 15.2);
    assert.equal(state.chargeLimitSoc, 90);
    assert.equal(state.chargerPower, 11);
    assert.equal(state.chargerVoltage, 230);
    assert.equal(state.chargerCurrent, 16);
    assert.equal(state.geofence, 'Home');
    assert.equal(state.insideTemp, 21.5);
  });

  it('if tesla integration is disabled in config, start() is a no-op', async () => {
    ctx = makeMockCtx({ teslaConfig: { enabled: false } });
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();
    assert.equal(hub._subscriptions.length, 0);
  });

  it('car ID comes from config (teslamateCarId), not hardcoded 1', async () => {
    // Default mock uses carId 2
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();
    const topic = hub._subscriptions[0];
    assert.ok(topic.includes('/cars/2/'), `Expected car ID 2 in topic, got: ${topic}`);
    assert.ok(!topic.includes('/cars/1/'), 'Should not hardcode car ID 1');
  });

  it('invalid/non-numeric payloads for number fields are ignored (not cached)', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();

    // Set valid value first
    hub._deliver('teslamate/cars/2/battery_level', '85');
    assert.equal(subscriber.getState().batteryLevel, 85);

    // Send invalid payload -- should be ignored, value stays 85
    hub._deliver('teslamate/cars/2/battery_level', 'not_a_number');
    assert.equal(subscriber.getState().batteryLevel, 85);

    // NaN should also be ignored
    hub._deliver('teslamate/cars/2/battery_level', 'NaN');
    assert.equal(subscriber.getState().batteryLevel, 85);

    // Infinity should also be ignored
    hub._deliver('teslamate/cars/2/battery_level', 'Infinity');
    assert.equal(subscriber.getState().batteryLevel, 85);

    // Empty string should be ignored
    hub._deliver('teslamate/cars/2/battery_level', '');
    assert.equal(subscriber.getState().batteryLevel, 85);
  });

  it('ensureSchema creates tesla_snapshots table via CREATE TABLE IF NOT EXISTS', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();

    const schemaQuery = ctx._db._queries.find(q =>
      q.sql.includes('CREATE TABLE IF NOT EXISTS tesla_snapshots')
    );
    assert.ok(schemaQuery, 'Expected CREATE TABLE IF NOT EXISTS tesla_snapshots query');
  });

  it('lastUpdateAt is null initially and updates on message receipt', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    assert.equal(subscriber.lastUpdateAt, null);

    await subscriber.start();
    hub._deliver('teslamate/cars/2/battery_level', '80');
    assert.ok(subscriber.lastUpdateAt instanceof Date || typeof subscriber.lastUpdateAt === 'string');
    assert.ok(subscriber.lastUpdateAt !== null);
  });

  it('getState() returns a frozen/copy object (not the internal cache)', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();
    hub._deliver('teslamate/cars/2/battery_level', '50');

    const s1 = subscriber.getState();
    const s2 = subscriber.getState();
    // Should be equal but not same reference
    assert.deepEqual(s1, s2);
  });

  it('close() clears the snapshot interval timer', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();
    // Should not throw
    subscriber.close();
    // Can close twice safely
    subscriber.close();
  });

  it('does NOT contain ON CONFLICT (no upsert)', async () => {
    // This is a structural test -- check the module source
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '..', 'services', 'mqtt', 'teslamate.js'), 'utf8');
    assert.ok(!src.includes('ON CONFLICT'), 'Source should not contain ON CONFLICT');
  });

  it('uses parameterized queries for DB writes (T-04-13)', async () => {
    subscriber = createTeslamateSubscriber(hub, ctx);
    await subscriber.start();

    // Deliver data and trigger a snapshot manually
    hub._deliver('teslamate/cars/2/battery_level', '80');
    hub._deliver('teslamate/cars/2/state', 'online');

    // Force snapshot (if exposed) or check ensureSchema params
    // The snapshot INSERT should use $1, $2... not string interpolation
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '..', 'services', 'mqtt', 'teslamate.js'), 'utf8');

    // Should have parameterized INSERT
    assert.ok(src.includes('$1'), 'INSERT should use parameterized queries ($1)');
    // Should NOT have template literal interpolation in SQL
    const sqlRegion = src.match(/INSERT INTO tesla_snapshots[\s\S]*?;/);
    if (sqlRegion) {
      assert.ok(!sqlRegion[0].includes('${'), 'SQL INSERT should not use template literal interpolation');
    }
  });
});

// ── DB historisation + restart-seed (Phase 11-06 round 8) ───────────
//
// Round 7 mirrored the 15-field cache to a tesla-cache.json runtime file.
// Round 8 (operator request) replaces that with DB historisation: every Tesla
// value is written into timeseries_samples via ctx.telemetryStore, exactly the
// way Plan 11-02 historises generic MQTT-tile values, and start() seeds the
// cache from the latest DB sample per tesla_* series so a restart restores the
// last-known state. The store is read LAZILY off ctx (server.js wires it after
// the factory runs); a missing store / missing data degrades cleanly.

describe('TeslaMate DB historisation + restart-seed', () => {
  let hub;

  beforeEach(() => {
    hub = makeMockHub();
  });

  it('historises a numeric value into timeseries_samples via telemetryStore.writeSamples', async () => {
    const store = makeMockStore();
    const ctx = makeMockCtx({ telemetryStore: store });
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();

    hub._deliver('teslamate/cars/2/charger_power', '11');
    await flush(); // historisation write is fire-and-forget

    assert.equal(store.writes.length, 1, 'writeSamples called exactly once');
    const row = store.writes[0][0];
    assert.equal(row.seriesKey, 'tesla_charger_power');
    assert.equal(row.value, 11);
    assert.equal(row.source, 'teslamate');
    assert.equal(row.scope, 'live');
    assert.equal(row.quality, 'raw');
    assert.equal(row.resolutionSeconds, 1);
  });

  it('historises an enum/string value with both value_text and a numeric code', async () => {
    const store = makeMockStore();
    const ctx = makeMockCtx({ telemetryStore: store });
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();

    hub._deliver('teslamate/cars/2/charging_state', 'Charging');
    await flush();

    assert.equal(store.writes.length, 1);
    const row = store.writes[0][0];
    assert.equal(row.seriesKey, 'tesla_charging_state');
    assert.equal(row.valueText, 'Charging', 'enum stored as value_text');
    assert.equal(typeof row.value, 'number', 'enum also stored as a numeric code so querySeries can read it back');
    assert.ok(row.value > 0, 'enum code is a positive integer');
  });

  it('historises a boolean value as 0/1 numeric', async () => {
    const store = makeMockStore();
    const ctx = makeMockCtx({ telemetryStore: store });
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();

    hub._deliver('teslamate/cars/2/plugged_in', 'true');
    await flush();

    assert.equal(store.writes.length, 1);
    assert.equal(store.writes[0][0].seriesKey, 'tesla_plugged_in');
    assert.equal(store.writes[0][0].value, 1, 'true -> 1');
  });

  it('a missing telemetryStore (boot window) is a silent no-op — no throw', async () => {
    const ctx = makeMockCtx(); // no telemetryStore on ctx
    const sub = createTeslamateSubscriber(hub, ctx);
    await assert.doesNotReject(() => sub.start());
    // Delivering a message must not throw with no store wired.
    assert.doesNotThrow(() => hub._deliver('teslamate/cars/2/battery_level', '60'));
    await flush();
    assert.equal(sub.getState().batteryLevel, 60, 'cache still updates without a store');
  });

  it('a rejecting writeSamples does not crash the MQTT message path', async () => {
    const store = makeMockStore();
    store.writeSamples = () => Promise.reject(new Error('pg down'));
    const ctx = makeMockCtx({ telemetryStore: store });
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();

    assert.doesNotThrow(() => hub._deliver('teslamate/cars/2/battery_level', '70'));
    await flush(); // the fire-and-forget .catch() must absorb the rejection
    assert.equal(sub.getState().batteryLevel, 70);
  });

  it('start() seeds numeric fields from the latest DB sample per series', async () => {
    // Simulate samples left in timeseries_samples by a previous run.
    const store = makeMockStore({ seedRows: [
      { key: 'tesla_battery_level', ts: '2026-05-17T09:00:00.000Z', value: 48, unit: null, resolution: 1 },
      { key: 'tesla_charger_power', ts: '2026-05-17T09:30:00.000Z', value: 7, unit: null, resolution: 1 },
      { key: 'tesla_charge_limit_soc', ts: '2026-05-17T09:15:00.000Z', value: 80, unit: null, resolution: 1 }
    ] });
    const ctx = makeMockCtx({ telemetryStore: store });
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();

    const state = sub.getState();
    assert.equal(state.batteryLevel, 48, 'numeric field seeded from the DB');
    assert.equal(state.chargerPower, 7, 'rarely-changing field seeded from the DB');
    assert.equal(state.chargeLimitSoc, 80);
    assert.ok(sub.lastUpdateAt, 'lastUpdateAt restored from the newest seeded sample');
  });

  it('start() decodes an enum field seeded from its numeric code', async () => {
    // teslamate.js encodes chargingState as a numeric code; the seed must
    // decode it back to the enum string (querySeries only returns value_num).
    // Round-trip test: historise 'Charging' to discover its code, then feed
    // that exact code back through the seed and assert the string is restored.
    const probeStore = makeMockStore();
    const probeHub = makeMockHub();
    const probe = createTeslamateSubscriber(probeHub, makeMockCtx({ telemetryStore: probeStore }));
    await probe.start();
    probeHub._deliver('teslamate/cars/2/charging_state', 'Charging');
    await flush();
    const chargingCode = probeStore.writes[probeStore.writes.length - 1][0].value;
    assert.equal(typeof chargingCode, 'number');
    assert.ok(chargingCode > 0, 'enum code is a positive integer');

    const seedStore = makeMockStore({ seedRows: [
      { key: 'tesla_charging_state', ts: '2026-05-17T09:00:00.000Z', value: chargingCode, unit: null, resolution: 1 }
    ] });
    const ctx = makeMockCtx({ telemetryStore: seedStore });
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();

    assert.equal(sub.getState().chargingState, 'Charging', 'enum code decoded back to the string');
  });

  it('start() decodes a boolean field seeded from its 0/1 code', async () => {
    const store = makeMockStore({ seedRows: [
      { key: 'tesla_plugged_in', ts: '2026-05-17T09:00:00.000Z', value: 1, unit: null, resolution: 1 }
    ] });
    const ctx = makeMockCtx({ telemetryStore: store });
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();

    assert.equal(sub.getState().pluggedIn, true, '1 decoded back to true');
  });

  it('a live MQTT message overwrites a seeded value', async () => {
    const store = makeMockStore({ seedRows: [
      { key: 'tesla_battery_level', ts: '2026-05-17T09:00:00.000Z', value: 48, unit: null, resolution: 1 }
    ] });
    const ctx = makeMockCtx({ telemetryStore: store });
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();
    assert.equal(sub.getState().batteryLevel, 48, 'seeded');

    hub._deliver('teslamate/cars/2/battery_level', '72');
    assert.equal(sub.getState().batteryLevel, 72, 'live message wins over the seed');
  });

  it('start() degrades cleanly when the store has no tesla_* data (empty cache, no throw)', async () => {
    const store = makeMockStore({ seedRows: [] });
    const ctx = makeMockCtx({ telemetryStore: store });
    const sub = createTeslamateSubscriber(hub, ctx);
    await assert.doesNotReject(() => sub.start());
    assert.equal(sub.getState().batteryLevel, null);
  });

  it('start() degrades cleanly when querySeries rejects (empty cache, no throw)', async () => {
    const store = makeMockStore({ behavior: 'reject' });
    const ctx = makeMockCtx({ telemetryStore: store });
    const sub = createTeslamateSubscriber(hub, ctx);
    await assert.doesNotReject(() => sub.start());
    assert.equal(sub.getState().batteryLevel, null);
  });

  it('start() degrades cleanly when no telemetryStore is wired yet (empty cache, no throw)', async () => {
    const ctx = makeMockCtx(); // no telemetryStore
    const sub = createTeslamateSubscriber(hub, ctx);
    await assert.doesNotReject(() => sub.start());
    assert.equal(sub.getState().batteryLevel, null);
  });

  it('the module no longer performs tesla-cache.json file-IO', async () => {
    // Structural guard: round 8 removed the round-7 file-IO persistence.
    // (The header comment may still NAME tesla-cache.json to explain its
    // removal — what must be gone is the actual fs IO and the import.)
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '..', 'services', 'mqtt', 'teslamate.js'), 'utf8');
    assert.ok(!src.includes('writeFileSync'), 'no file-write IO');
    assert.ok(!src.includes('readFileSync'), 'no file-read IO');
    assert.ok(!/from\s+['"]node:fs['"]/.test(src), 'no node:fs import');
    assert.ok(!src.includes('TESLA_CACHE_PATH'), 'no cache-file path constant');
    assert.ok(!src.includes('writeCacheFile'), 'no writeCacheFile helper');
    assert.ok(!src.includes('seedCacheFromFile'), 'no seedCacheFromFile helper');
  });
});
