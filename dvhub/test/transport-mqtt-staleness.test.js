import test from 'node:test';
import assert from 'node:assert/strict';

import { mqttCacheEntryFresh, buildVenusTopicMaps } from '../transport-mqtt.js';

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

// ---------------------------------------------------------------------------
// T-MQTT-CONSUMPTION (2026-07-04): Summen-Punkt selfConsumptionW = L1+L2+L3.
// Live-Fund (Deye-Bridge-Praxistest): der Poller fragt den Summen-Punkt ab,
// das MQTT-Mapping kannte nur die Phasen-Topics → loadW fehlte komplett.
// ---------------------------------------------------------------------------

import { sumConsumptionEntries } from '../transport-mqtt.js';

test('consumption sum: three fresh phases are summed, ts = newest', () => {
  const r = sumConsumptionEntries([
    { value: 450, ts: NOW - 1000 },
    { value: 300, ts: NOW - 2000 },
    { value: 210, ts: NOW - 500 },
  ], MAX, NOW);
  assert.deepEqual(r, { value: 960, ts: NOW - 500 });
});

test('consumption sum: a never-seen phase counts as 0 (1-/2-phasige Anlagen)', () => {
  const r = sumConsumptionEntries([{ value: 450, ts: NOW }, undefined, undefined], MAX, NOW);
  assert.deepEqual(r, { value: 450, ts: NOW });
});

test('consumption sum: a SEEN but stale phase makes the whole sum stale (null)', () => {
  const r = sumConsumptionEntries([
    { value: 450, ts: NOW },
    { value: 300, ts: NOW - (MAX + 1) },   // eingefrorenes L2
    { value: 210, ts: NOW },
  ], MAX, NOW);
  assert.equal(r, null);
});

test('consumption sum: no phase seen at all -> null (kein erfundener 0-Verbrauch)', () => {
  assert.equal(sumConsumptionEntries([undefined, undefined, undefined], MAX, NOW), null);
});

test('consumption sum: 0-W-Phasen sind gültige Werte', () => {
  const r = sumConsumptionEntries([
    { value: 0, ts: NOW }, { value: 0, ts: NOW }, { value: 0, ts: NOW },
  ], MAX, NOW);
  assert.deepEqual(r, { value: 0, ts: NOW });
});

// --- T-VERIFY Contract: jedes Write-Target hat ein Read-Topic ----------------
// Die Write-Verifikation (schedule-eval) liest jedes geschriebene Setting per
// readPointSince zurück — das geht nur, wenn READ_TOPICS jeden WRITE_TOPICS-Key
// abdeckt. Vorher fehlten chargeCurrentA/maxDischargeW/feedExcessDcPv/
// dontFeedExcessAcPv auf der Lese-Seite.
test('T-VERIFY: READ_TOPICS deckt jeden WRITE_TOPICS-Key ab (readback-fähig)', () => {
  const { READ_TOPICS, WRITE_TOPICS } = buildVenusTopicMaps('portal-x');
  for (const key of Object.keys(WRITE_TOPICS)) {
    assert.ok(READ_TOPICS[key], `Write-Target '${key}' braucht ein N/-Read-Topic für die Verifikation`);
    assert.equal(
      READ_TOPICS[key].replace(/^N\//, 'W/'), WRITE_TOPICS[key],
      `'${key}': Read- und Write-Topic müssen denselben Settings-Pfad adressieren`
    );
  }
});
