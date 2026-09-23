// test/ev-soc.test.js -- Ladestand des E-Autos fuer EOS und die Leitstand-Kachel.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEvSocPct } from '../services/optimizer/ev-soc.js';

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
