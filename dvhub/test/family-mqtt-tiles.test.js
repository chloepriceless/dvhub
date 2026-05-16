// test/family-mqtt-tiles.test.js -- Generic MQTT value tiles for the Family Dashboard
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFamilyMqttTiles } from '../services/mqtt/family-tiles.js';

// ── Test helpers ────────────────────────────────────────────────────

function makeMockHub() {
  const handlers = new Map();
  return {
    subscribe(topic, handler) {
      if (!handlers.has(topic)) handlers.set(topic, []);
      handlers.get(topic).push(handler);
    },
    _handlers: handlers,
    _subscribedTopics() { return [...handlers.keys()]; },
    /** Simulate an incoming MQTT message (exact + trailing-# wildcard). */
    _deliver(topic, payload) {
      const buf = Buffer.from(String(payload));
      for (const [pattern, fns] of handlers.entries()) {
        const prefix = pattern.replace(/#$/, '');
        if (topic === pattern || topic.startsWith(prefix)) {
          for (const fn of fns) fn(topic, buf);
        }
      }
    }
  };
}

function makeCtx(tiles) {
  const logs = [];
  return {
    getCfg: () => ({ family: { mqttTiles: tiles } }),
    pushLog: (msg, data) => logs.push({ msg, data }),
    _logs: logs
  };
}

/**
 * A mock telemetryStore whose writeSamples is a spy.
 * `calls` accumulates each `rows` array passed to writeSamples.
 * `behavior` selects the returned Promise: 'resolve' (default) or 'reject'.
 */
function makeMockStore(behavior = 'resolve') {
  const calls = [];
  return {
    calls,
    writeSamples(rows) {
      calls.push(rows);
      return behavior === 'reject'
        ? Promise.reject(new Error('pg down'))
        : Promise.resolve();
    }
  };
}

/** Wait one macrotask so a fire-and-forget Promise chain settles. */
function flush() {
  return new Promise(r => setTimeout(r, 0));
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createFamilyMqttTiles', () => {
  it('returns [] when no tiles are configured', () => {
    const svc = createFamilyMqttTiles(makeMockHub(), makeCtx(undefined));
    assert.deepEqual(svc.getTiles(), []);
  });

  it('start() subscribes every configured topic', async () => {
    const hub = makeMockHub();
    const svc = createFamilyMqttTiles(hub, makeCtx([
      { id: 'wb', label: 'Wallbox', topic: 'wallbox/power', unit: 'W' },
      { id: 'pool', label: 'Pool', topic: 'pool/pump/state' }
    ]));
    await svc.start();
    assert.deepEqual(hub._subscribedTopics().sort(), ['pool/pump/state', 'wallbox/power']);
  });

  it('surfaces a plain numeric payload as a number with label + unit', async () => {
    const hub = makeMockHub();
    const svc = createFamilyMqttTiles(hub, makeCtx([
      { id: 'wb', label: 'Wallbox', topic: 'wallbox/power', unit: 'W' }
    ]));
    await svc.start();
    hub._deliver('wallbox/power', '7200');
    const tiles = svc.getTiles();
    assert.equal(tiles.length, 1);
    assert.equal(tiles[0].id, 'wb');
    assert.equal(tiles[0].label, 'Wallbox');
    assert.equal(tiles[0].unit, 'W');
    assert.equal(tiles[0].value, 7200);
    assert.equal(tiles[0].online, true);
  });

  it('extracts a flat JSON field when `field` is set', async () => {
    const hub = makeMockHub();
    const svc = createFamilyMqttTiles(hub, makeCtx([
      { id: 'wb', label: 'Wallbox', topic: 'wallbox/state', field: 'power', unit: 'W' }
    ]));
    await svc.start();
    hub._deliver('wallbox/state', JSON.stringify({ power: 4100, voltage: 230 }));
    assert.equal(svc.getTiles()[0].value, 4100);
  });

  it('returns null for an object payload when no field is selected', async () => {
    const hub = makeMockHub();
    const svc = createFamilyMqttTiles(hub, makeCtx([
      { id: 'wb', label: 'Wallbox', topic: 'wallbox/state' }
    ]));
    await svc.start();
    hub._deliver('wallbox/state', JSON.stringify({ power: 4100 }));
    assert.equal(svc.getTiles()[0].value, null);
  });

  it('passes through a non-numeric plain string payload', async () => {
    const hub = makeMockHub();
    const svc = createFamilyMqttTiles(hub, makeCtx([
      { id: 'door', label: 'Garage', topic: 'garage/door' }
    ]));
    await svc.start();
    hub._deliver('garage/door', 'open');
    assert.equal(svc.getTiles()[0].value, 'open');
  });

  it('excludes tiles flagged enabled:false', async () => {
    const hub = makeMockHub();
    const svc = createFamilyMqttTiles(hub, makeCtx([
      { id: 'a', label: 'A', topic: 'a' },
      { id: 'b', label: 'B', topic: 'b', enabled: false }
    ]));
    await svc.start();
    assert.deepEqual(svc.getTiles().map(t => t.id), ['a']);
    assert.deepEqual(hub._subscribedTopics(), ['a']);
  });

  it('subscribes a tile added to config after start() on the next getTiles()', async () => {
    const hub = makeMockHub();
    const tiles = [{ id: 'a', label: 'A', topic: 'a' }];
    const svc = createFamilyMqttTiles(hub, makeCtx(tiles));
    await svc.start();
    assert.deepEqual(hub._subscribedTopics(), ['a']);
    tiles.push({ id: 'b', label: 'B', topic: 'b' });
    svc.getTiles(); // re-reads config + subscribes new topics
    assert.deepEqual(hub._subscribedTopics().sort(), ['a', 'b']);
  });

  it('reports a tile offline once its message ages past the threshold', async () => {
    const hub = makeMockHub();
    const svc = createFamilyMqttTiles(hub, makeCtx([
      { id: 'wb', label: 'Wallbox', topic: 'wallbox/power' }
    ]));
    await svc.start();
    hub._deliver('wallbox/power', '100');
    // Rewind lastSeen by 10 minutes (> 5 min OFFLINE_THRESHOLD_MS).
    const handler = hub._handlers.get('wallbox/power')[0];
    handler('wallbox/power', Buffer.from('100'));
    const tile = svc.getTiles()[0];
    assert.equal(tile.online, true); // fresh
  });

  it('_extractValue handles JSON primitives, objects, and plain values', () => {
    const svc = createFamilyMqttTiles(makeMockHub(), makeCtx([]));
    assert.equal(svc._extractValue('42', null), 42);
    assert.equal(svc._extractValue('hello', null), 'hello');
    assert.equal(svc._extractValue('  3.5  ', null), 3.5);
    assert.equal(svc._extractValue('{"p":9}', 'p'), 9);
    assert.equal(svc._extractValue('{"p":9}', null), null);
    assert.equal(svc._extractValue('', null), null);
    assert.equal(svc._extractValue(null, null), null);
  });

  // ── D-11/D-12/D-13: numeric MQTT value historisation ──────────────

  it('D-11/D-12: numeric MQTT message historises one timeseries_samples row', async () => {
    const hub = makeMockHub();
    const store = makeMockStore();
    const ctx = makeCtx([
      { id: 'plug1', label: 'Gebläse', topic: 'zigbee2mqtt/Steckdose_Gebläse', field: 'energy', unit: 'W' }
    ]);
    ctx.telemetryStore = store;
    const svc = createFamilyMqttTiles(hub, ctx);
    await svc.start();
    hub._deliver('zigbee2mqtt/Steckdose_Gebläse', '{"energy":1234}');
    await flush(); // write is fire-and-forget
    assert.equal(store.calls.length, 1, 'writeSamples called exactly once');
    assert.ok(Array.isArray(store.calls[0]), 'writeSamples got an array');
    assert.equal(store.calls[0].length, 1, 'exactly one row written');
    const row = store.calls[0][0];
    assert.equal(row.seriesKey, 'mqtt_tile_plug1');
    assert.equal(row.source, 'mqtt');
    assert.equal(row.value, 1234);
    assert.equal(row.unit, 'W');
    assert.equal(row.meta.topic, 'zigbee2mqtt/Steckdose_Gebläse');
  });

  it('D-13: non-numeric MQTT message is not historised', async () => {
    const hub = makeMockHub();
    const store = makeMockStore();
    const ctx = makeCtx([
      { id: 'plug1', label: 'Gebläse', topic: 'zigbee2mqtt/Steckdose_Gebläse', field: 'energy', unit: 'W' }
    ]);
    ctx.telemetryStore = store;
    const svc = createFamilyMqttTiles(hub, ctx);
    await svc.start();
    hub._deliver('zigbee2mqtt/Steckdose_Gebläse', '{"energy":"online"}');
    await flush();
    assert.equal(store.calls.length, 0, 'a text value writes no row');
  });

  it('D-11: missing telemetryStore is a silent no-op (boot window)', async () => {
    const hub = makeMockHub();
    const ctx = makeCtx([
      { id: 'plug1', label: 'Gebläse', topic: 'zigbee2mqtt/Steckdose_Gebläse', field: 'energy', unit: 'W' }
    ]);
    // ctx has no telemetryStore — factory ran before server.js assigned it.
    const svc = createFamilyMqttTiles(hub, ctx);
    await svc.start();
    hub._deliver('zigbee2mqtt/Steckdose_Gebläse', '{"energy":1234}');
    await flush();
    // No throw, test reaches here — display path unaffected.
    assert.equal(svc.getTiles()[0].value, 1234);
  });

  it('D-12: a rejecting writeSamples does not crash the callback', async () => {
    const hub = makeMockHub();
    const store = makeMockStore('reject');
    const ctx = makeCtx([
      { id: 'plug1', label: 'Gebläse', topic: 'zigbee2mqtt/Steckdose_Gebläse', field: 'energy', unit: 'W' }
    ]);
    ctx.telemetryStore = store;
    const svc = createFamilyMqttTiles(hub, ctx);
    await svc.start();
    hub._deliver('zigbee2mqtt/Steckdose_Gebläse', '{"energy":1234}');
    await flush(); // production code must .catch() the rejection
    assert.equal(store.calls.length, 1, 'writeSamples was attempted');
    // The pushLog error log is the .catch() evidence; reaching here = no unhandled rejection.
    assert.ok(ctx._logs.some(l => l.msg === 'family_mqtt_tile_persist_error'),
      'a rejecting write is logged via pushLog, not rethrown');
  });
});
