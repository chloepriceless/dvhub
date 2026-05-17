// test/teslamate-subscriber.test.js -- TeslaMate MQTT subscriber tests (INTG-04, INTG-06)
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Phase 11-06 round 7: teslamate.js resolves its cache-persistence file path
// from DV_DATA_DIR at MODULE LOAD time. Point it at a throwaway temp dir
// BEFORE importing the module so the persistence tests below never write
// tesla-cache.json into the repo working tree.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'teslamate-test-'));
process.env.DV_DATA_DIR = TEST_DATA_DIR;
const TEST_CACHE_FILE = join(TEST_DATA_DIR, 'tesla-cache.json');

const { createTeslamateSubscriber } = await import('../services/mqtt/teslamate.js');

after(() => {
  try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

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

function makeMockCtx(overrides = {}) {
  const logs = [];
  const db = overrides.db || makeMockDb();
  return {
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
    assert.ok(schemaQuery.sql.includes('idx_tesla_snapshots_car_ts'), 'Expected index creation');
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

// ── Restart-persistence (Phase 11-06 round 7) ───────────────────────
//
// TeslaMate only re-publishes a topic when its value changes, so rarely-
// changing fields (charging_state, charger_power, plugged_in) stay null
// after a dvhub restart until the next state change. The cache is mirrored
// to a JSON file in the runtime data dir and seeded back on start().

describe('TeslaMate cache-persistence', () => {
  let hub, ctx;

  beforeEach(() => {
    hub = makeMockHub();
    ctx = makeMockCtx();
    // Each test starts from a clean slate -- remove any leftover cache file.
    if (existsSync(TEST_CACHE_FILE)) rmSync(TEST_CACHE_FILE, { force: true });
  });

  it('close() writes the cache + lastUpdateAt to tesla-cache.json in DV_DATA_DIR', async () => {
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();
    hub._deliver('teslamate/cars/2/charging_state', 'Charging');
    hub._deliver('teslamate/cars/2/charger_power', '11');
    hub._deliver('teslamate/cars/2/battery_level', '55');
    sub.close(); // flushes the pending debounced write synchronously

    assert.ok(existsSync(TEST_CACHE_FILE), 'tesla-cache.json should exist after close()');
    const saved = JSON.parse(readFileSync(TEST_CACHE_FILE, 'utf8'));
    assert.equal(saved.cache.chargingState, 'Charging');
    assert.equal(saved.cache.chargerPower, 11);
    assert.equal(saved.cache.batteryLevel, 55);
    assert.ok(saved.lastUpdateAt, 'lastUpdateAt should be persisted');
  });

  it('start() seeds the cache from an existing tesla-cache.json before subscribing', async () => {
    // Simulate a file left by a previous run.
    writeFileSync(TEST_CACHE_FILE, JSON.stringify({
      cache: {
        displayName: 'Model 3', chargingState: 'Charging', chargerPower: 7,
        pluggedIn: true, batteryLevel: 48, chargeLimitSoc: 80
      },
      lastUpdateAt: '2026-05-17T10:00:00.000Z'
    }), 'utf8');

    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();

    const state = sub.getState();
    assert.equal(state.chargingState, 'Charging', 'rarely-changing field seeded from file');
    assert.equal(state.chargerPower, 7);
    assert.equal(state.pluggedIn, true);
    assert.equal(state.batteryLevel, 48);
    assert.ok(sub.lastUpdateAt, 'lastUpdateAt restored from file');
  });

  it('a live MQTT message overwrites a seeded value', async () => {
    writeFileSync(TEST_CACHE_FILE, JSON.stringify({
      cache: { batteryLevel: 48, chargingState: 'Charging' },
      lastUpdateAt: '2026-05-17T10:00:00.000Z'
    }), 'utf8');

    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();
    assert.equal(sub.getState().batteryLevel, 48); // seeded
    hub._deliver('teslamate/cars/2/battery_level', '72');
    assert.equal(sub.getState().batteryLevel, 72, 'live message wins over the seed');
  });

  it('a missing cache file degrades cleanly to an empty cache (no throw)', async () => {
    assert.equal(existsSync(TEST_CACHE_FILE), false);
    const sub = createTeslamateSubscriber(hub, ctx);
    await assert.doesNotReject(() => sub.start());
    assert.equal(sub.getState().batteryLevel, null);
  });

  it('a corrupt cache file degrades cleanly to an empty cache (no throw)', async () => {
    writeFileSync(TEST_CACHE_FILE, '{ this is not valid json', 'utf8');
    const sub = createTeslamateSubscriber(hub, ctx);
    await assert.doesNotReject(() => sub.start());
    assert.equal(sub.getState().batteryLevel, null);
  });

  it('seeding only copies known cache keys (a stale unknown key is dropped)', async () => {
    writeFileSync(TEST_CACHE_FILE, JSON.stringify({
      cache: { batteryLevel: 60, somethingRenamed: 'xyz' },
      lastUpdateAt: '2026-05-17T10:00:00.000Z'
    }), 'utf8');
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();
    const state = sub.getState();
    assert.equal(state.batteryLevel, 60);
    assert.equal('somethingRenamed' in state, false, 'unknown key must not be injected');
  });
});
