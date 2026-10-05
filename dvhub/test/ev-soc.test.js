// test/ev-soc.test.js -- Ladestand des E-Autos fuer EOS und die Leitstand-Kachel.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEvSocPct, resolveEvPlugged, createEvPlugTracker } from '../services/optimizer/ev-soc.js';

const ctx = ({ tesla, lp, mqtt, source, charger }) => ({
  getCfg: () => ({ optimizer: { evEvccLoadpoint: 1, ...(source ? { evSocSource: source } : {}) } }),
  teslamateService: { getState: () => tesla || {} },
  evccIntegration: { getLoadpoints: () => (lp ? [{ id: 1, ...lp }] : []) },
  vehicleMqtt: { getState: () => mqtt || {} },
  chargerStatus: { fresh: () => charger || null }
});

describe('resolveEvSocPct', () => {
  test('TeslaMate geht vor', () => {
    assert.deepEqual(resolveEvSocPct(ctx({ tesla: { batteryLevel: 68 }, lp: { connected: true, vehicleSocPct: 40 } })), { pct: 68, source: 'teslamate' });
  });
  test('evcc nur bei angestecktem Auto', () => {
    assert.deepEqual(resolveEvSocPct(ctx({ lp: { connected: true, vehicleSocPct: 55 } })), { pct: 55, source: 'evcc' });
  });
  test('nicht angesteckt: evcc meldet 0 — das ist kein Ladestand', () => {
    assert.equal(resolveEvSocPct(ctx({ lp: { connected: false, vehicleSocPct: 0 } })), null);
  });
  test('ohne Quelle: null', () => {
    assert.equal(resolveEvSocPct(ctx({})), null);
  });
  test('MQTT liefert den Ladestand, wenn weder TeslaMate noch evcc einen haben', () => {
    assert.deepEqual(resolveEvSocPct(ctx({ mqtt: { socPct: 47 } })), { pct: 47, source: 'mqtt' });
    assert.deepEqual(resolveEvSocPct(ctx({ lp: { connected: true, vehicleSocPct: 55 }, mqtt: { socPct: 47 } })), { pct: 55, source: 'evcc' });
  });
  test('gewaehlte Quelle gilt allein — auch wenn eine andere einen Wert haette', () => {
    const all = { tesla: { batteryLevel: 68 }, lp: { connected: true, vehicleSocPct: 40 }, mqtt: { socPct: 47 } };
    assert.deepEqual(resolveEvSocPct(ctx({ ...all, source: 'mqtt' })), { pct: 47, source: 'mqtt' });
    assert.deepEqual(resolveEvSocPct(ctx({ ...all, source: 'evcc' })), { pct: 40, source: 'evcc' });
    assert.deepEqual(resolveEvSocPct(ctx({ ...all, source: 'teslamate' })), { pct: 68, source: 'teslamate' });
    assert.equal(resolveEvSocPct(ctx({ tesla: { batteryLevel: 68 }, source: 'mqtt' })), null);
  });
  test('unbekannte Einstellung verhaelt sich wie automatisch', () => {
    assert.deepEqual(resolveEvSocPct(ctx({ tesla: { batteryLevel: 68 }, source: 'quatsch' })), { pct: 68, source: 'teslamate' });
  });
});

describe('resolveEvPlugged', () => {
  test('angesteckt / nicht / unbekannt', () => {
    assert.equal(resolveEvPlugged(ctx({ lp: { connected: true } })), true);
    assert.equal(resolveEvPlugged(ctx({ lp: { connected: false } })), false);
    assert.equal(resolveEvPlugged(ctx({})), null);
  });
  test('MQTT nur, wenn weder Wallbox noch evcc es melden', () => {
    assert.equal(resolveEvPlugged(ctx({ mqtt: { plugged: true } })), true);
    assert.equal(resolveEvPlugged(ctx({ mqtt: { plugged: false } })), false);
    assert.equal(resolveEvPlugged(ctx({ lp: { connected: false }, mqtt: { plugged: true } })), false);
    assert.equal(resolveEvPlugged(ctx({ charger: { connected: true }, mqtt: { plugged: false } })), true);
  });
});

describe('createEvPlugTracker (Entprellung)', () => {
  test('erste Beobachtung setzt nur den Ausgangszustand', () => {
    const t = createEvPlugTracker({ stableTicks: 2 });
    assert.deepEqual(t.update(false), { changed: false, stable: false });
  });
  test('Wechsel zaehlt erst nach 2 gleichen Abfragen', () => {
    const t = createEvPlugTracker({ stableTicks: 2 });
    t.update(false);
    assert.equal(t.update(true).changed, false);
    assert.deepEqual(t.update(true), { changed: true, from: false, stable: true });
    assert.equal(t.update(true).changed, false, 'kein zweites Mal');
  });
  test('kurzes Flattern loest nichts aus', () => {
    const t = createEvPlugTracker({ stableTicks: 2 });
    t.update(false);
    t.update(true);
    t.update(false);
    assert.equal(t.update(true).changed, false);
    assert.equal(t.stable, false);
  });
  test('evcc weg (null) gilt als eigener Zustand', () => {
    const t = createEvPlugTracker({ stableTicks: 2 });
    t.update(true);
    t.update(null);
    assert.deepEqual(t.update(null), { changed: true, from: true, stable: null });
  });
});
