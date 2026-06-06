import test from 'node:test';
import assert from 'node:assert/strict';

import { mqttCacheEntryFresh } from '../transport-mqtt.js';

// T-0080 (P1 sweep): MQTT cache freshness. A frozen/stale cache value must NOT be
// served as fresh, or it defeats the T-0075 telemetry-freshness floor downstream.

const NOW = 1_000_000_000;
const MAX = 90_000; // 3 keepalive intervals

test('fresh entry within maxAge is fresh', () => {
  assert.equal(mqttCacheEntryFresh({ value: 42, ts: NOW - 1000 }, MAX, NOW), true);
});

test('stale entry beyond maxAge is NOT fresh', () => {
  assert.equal(mqttCacheEntryFresh({ value: 42, ts: NOW - (MAX + 1) }, MAX, NOW), false);
});

test('exactly at the boundary counts as fresh (<=)', () => {
  assert.equal(mqttCacheEntryFresh({ value: 42, ts: NOW - MAX }, MAX, NOW), true);
});

test('missing / null entry is NOT fresh', () => {
  assert.equal(mqttCacheEntryFresh(undefined, MAX, NOW), false);
  assert.equal(mqttCacheEntryFresh(null, MAX, NOW), false);
});

test('null value is NOT fresh, but 0 is a valid value', () => {
  assert.equal(mqttCacheEntryFresh({ value: null, ts: NOW }, MAX, NOW), false);
  assert.equal(mqttCacheEntryFresh({ value: 0, ts: NOW }, MAX, NOW), true, '0 W is a real reading');
});

test('maxAge <= 0 or non-finite disables staleness (always fresh if value present)', () => {
  assert.equal(mqttCacheEntryFresh({ value: 42, ts: NOW - 10_000_000 }, 0, NOW), true);
  assert.equal(mqttCacheEntryFresh({ value: 42, ts: NOW - 10_000_000 }, NaN, NOW), true);
});

test('missing ts is treated as epoch → stale under a finite maxAge', () => {
  assert.equal(mqttCacheEntryFresh({ value: 42 }, MAX, NOW), false);
});
