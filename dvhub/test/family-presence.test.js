// test/family-presence.test.js -- Unit tests for setPresence/getPresence (D-08, D-19).
// Covers presence webhook state machine in createFamilyService.
// Route handler tests live in family-routes.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFamilyService } from '../services/family/index.js';

function createMockCtx() {
  const logs = [];
  return {
    state: { victron: {}, meter: {}, epex: { ok: false, data: [] }, energy: {} },
    getCfg: () => ({ optimizer: { batteryCapacityWh: 10000 }, family: {} }),
    pushLog: (type, data) => logs.push({ type, data }),
    buildFallbackStatusPayload: () => ({
      victron: {},
      meter: {},
      epex: { ok: false, data: [] },
      costs: { netEur: 0, costEur: 0, revenueEur: 0 }
    }),
    forecastService: null,
    optimizerService: null,
    epexNowNext: () => null,
    costSummary: () => ({ netEur: 0, costEur: 0, revenueEur: 0 }),
    _logs: logs
  };
}

describe('setPresence / getPresence', () => {
  it('defaults to detected=false, source=null, updatedAt=0', () => {
    const svc = createFamilyService(createMockCtx());
    const p = svc.getPresence();
    assert.equal(p.detected, false);
    assert.equal(p.source, null);
    assert.equal(p.updatedAt, 0);
  });

  it('setPresence({ detected: true, source: "loxone" }) updates getPresence()', () => {
    const svc = createFamilyService(createMockCtx());
    svc.setPresence({ detected: true, source: 'loxone' });
    const p = svc.getPresence();
    assert.equal(p.detected, true);
    assert.equal(p.source, 'loxone');
    assert.ok(p.updatedAt > 0);
  });

  it('setPresence with missing source falls back to "unknown"', () => {
    const svc = createFamilyService(createMockCtx());
    svc.setPresence({ detected: true });
    const p = svc.getPresence();
    assert.equal(p.source, 'unknown');
  });

  it('setPresence with empty string source falls back to "unknown"', () => {
    const svc = createFamilyService(createMockCtx());
    svc.setPresence({ detected: true, source: '' });
    const p = svc.getPresence();
    assert.equal(p.source, 'unknown');
  });

  it('setPresence with non-string source falls back to "unknown"', () => {
    const svc = createFamilyService(createMockCtx());
    svc.setPresence({ detected: true, source: 123 });
    const p = svc.getPresence();
    assert.equal(p.source, 'unknown');
  });

  it('getPresence returns a copy — mutating result does not affect internal state', () => {
    const svc = createFamilyService(createMockCtx());
    svc.setPresence({ detected: true, source: 'mqtt' });
    const p1 = svc.getPresence();
    p1.detected = false;
    p1.source = 'hacked';
    const p2 = svc.getPresence();
    assert.equal(p2.detected, true, 'internal state must not be mutated');
    assert.equal(p2.source, 'mqtt');
  });

  it('setPresence(detected: truthy non-bool) coerces to boolean', () => {
    const svc = createFamilyService(createMockCtx());
    svc.setPresence({ detected: 1, source: 'ha' });
    const p = svc.getPresence();
    assert.equal(p.detected, true);
  });

  it('setPresence logs family_presence via pushLog', () => {
    const ctx = createMockCtx();
    const svc = createFamilyService(ctx);
    svc.setPresence({ detected: true, source: 'loxone' });
    const log = ctx._logs.find(l => l.type === 'family_presence');
    assert.ok(log, 'pushLog should have been called with family_presence');
    assert.equal(log.data.detected, true);
    assert.equal(log.data.source, 'loxone');
  });
});
