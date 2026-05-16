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
});
