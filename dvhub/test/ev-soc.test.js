// test/ev-soc.test.js -- Ladestand des E-Autos fuer EOS und die Leitstand-Kachel.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEvSocPct, resolveEvPlugged, createEvPlugTracker } from '../services/optimizer/ev-soc.js';

const ctx = ({ tesla, lp }) => ({
  getCfg: () => ({ optimizer: { evEvccLoadpoint: 1 } }),
  teslamateService: { getState: () => tesla || {} },
  evccIntegration: { getLoadpoints: () => (lp ? [{ id: 1, ...lp }] : []) }
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
});

describe('resolveEvPlugged', () => {
  test('angesteckt / nicht / unbekannt', () => {
    assert.equal(resolveEvPlugged(ctx({ lp: { connected: true } })), true);
    assert.equal(resolveEvPlugged(ctx({ lp: { connected: false } })), false);
    assert.equal(resolveEvPlugged(ctx({})), null);
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
