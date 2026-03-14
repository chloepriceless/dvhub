/**
 * EVCC Bridge Service Tests
 *
 * Tests the EVCC REST API polling bridge with BehaviorSubject state stream.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createEvccBridge } from '../modules/optimizer/services/evcc-bridge.js';

// Helper: build a mock EVCC response in v0.207+ format (flat JSON)
function makeEvccResponseV207(loadpoints = [], extras = {}) {
  return {
    loadpoints,
    battery: extras.battery || [],
    grid: extras.grid || { power: 100 },
    tariff: extras.tariff || { currency: 'EUR' },
  };
}

// Helper: build a mock EVCC response in legacy format (result wrapper)
function makeEvccResponseLegacy(loadpoints = [], extras = {}) {
  return {
    result: {
      loadpoints,
      battery: extras.battery || [],
      grid: extras.grid || { power: 200 },
      tariff: extras.tariff || { currency: 'EUR' },
    },
  };
}

// Sample loadpoint raw data
const sampleLoadpoint = {
  mode: 'pv',
  chargePower: 7400,
  chargedEnergy: 12.5,
  charging: true,
  connected: true,
  enabled: true,
  planActive: false,
  vehicleSoc: 65,
  vehicleRange: 180,
  minSoc: 20,
  phasesActive: 3,
};

describe('EVCC Bridge Service', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('Test 1: createEvccBridge returns object with start, stop, getState, getState$ methods', () => {
    const bridge = createEvccBridge({ baseUrl: 'http://localhost:7070' });
    assert.equal(typeof bridge.start, 'function');
    assert.equal(typeof bridge.stop, 'function');
    assert.equal(typeof bridge.getState, 'function');
    assert.equal(typeof bridge.getState$, 'function');
  });

  it('Test 2: poll() fetches from ${baseUrl}/api/state with AbortSignal.timeout(5000)', async () => {
    let capturedUrl = null;
    let capturedSignal = null;

    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedSignal = opts?.signal;
      return {
        ok: true,
        json: async () => makeEvccResponseV207([sampleLoadpoint]),
      };
    };

    const bridge = createEvccBridge({ baseUrl: 'http://evcc.local:7070', pollIntervalMs: 60000 });
    bridge.start();
    // Give poll() time to execute
    await new Promise(r => setTimeout(r, 50));
    bridge.stop();

    assert.equal(capturedUrl, 'http://evcc.local:7070/api/state');
    // AbortSignal should be present
    assert.ok(capturedSignal, 'fetch should receive an AbortSignal');
  });

  it('Test 3: Normalizes loadpoint with v0.207+ format (flat JSON)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => makeEvccResponseV207([sampleLoadpoint]),
    });

    const bridge = createEvccBridge({ baseUrl: 'http://localhost:7070', pollIntervalMs: 60000 });
    bridge.start();
    await new Promise(r => setTimeout(r, 50));
    bridge.stop();

    const state = bridge.getState();
    assert.ok(state, 'State should not be null after successful poll');
    assert.equal(state.loadpoints.length, 1);
    assert.equal(state.loadpoints[0].mode, 'pv');
    assert.equal(state.loadpoints[0].chargePower, 7400);
  });

  it('Test 4: Normalizes loadpoint with legacy format (data.result.loadpoints)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => makeEvccResponseLegacy([sampleLoadpoint]),
    });

    const bridge = createEvccBridge({ baseUrl: 'http://localhost:7070', pollIntervalMs: 60000 });
    bridge.start();
    await new Promise(r => setTimeout(r, 50));
    bridge.stop();

    const state = bridge.getState();
    assert.ok(state, 'State should not be null for legacy format');
    assert.equal(state.loadpoints.length, 1);
    assert.equal(state.loadpoints[0].mode, 'pv');
    // Legacy format grid
    assert.deepEqual(state.grid, { power: 200 });
  });

  it('Test 5: Falls back gracefully when loadpoints array is missing (empty array)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ someOtherField: true }),
    });

    const bridge = createEvccBridge({ baseUrl: 'http://localhost:7070', pollIntervalMs: 60000 });
    bridge.start();
    await new Promise(r => setTimeout(r, 50));
    bridge.stop();

    const state = bridge.getState();
    assert.ok(state);
    assert.deepEqual(state.loadpoints, []);
  });

  it('Test 6: Poll failure logs warning but does not throw or crash timer', async () => {
    const warnings = [];
    const log = { warn: (obj, msg) => warnings.push({ obj, msg }) };

    globalThis.fetch = async () => { throw new Error('Connection refused'); };

    const bridge = createEvccBridge({ baseUrl: 'http://localhost:7070', pollIntervalMs: 60000, log });
    bridge.start();
    await new Promise(r => setTimeout(r, 50));
    bridge.stop();

    // Should have logged a warning, not crashed
    assert.ok(warnings.length >= 1, 'Should log at least one warning');
    assert.ok(warnings[0].msg.includes('EVCC poll failed'));
  });

  it('Test 7: getState() returns null before first successful poll', () => {
    const bridge = createEvccBridge({ baseUrl: 'http://localhost:7070' });
    assert.equal(bridge.getState(), null);
  });

  it('Test 8: stop() clears interval and completes BehaviorSubject', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => makeEvccResponseV207([sampleLoadpoint]),
    });

    const bridge = createEvccBridge({ baseUrl: 'http://localhost:7070', pollIntervalMs: 60000 });
    bridge.start();
    await new Promise(r => setTimeout(r, 50));

    // Subscribe to observable to detect completion
    let completed = false;
    const sub = bridge.getState$().subscribe({
      complete: () => { completed = true; },
    });

    bridge.stop();
    assert.ok(completed, 'BehaviorSubject should complete on stop()');
    sub.unsubscribe();
  });

  it('Test 9: normalizeLoadpoint maps all expected fields', async () => {
    const rawLoadpoint = {
      mode: 'minpv',
      chargePower: 3600,
      chargedEnergy: 5.2,
      charging: false,
      connected: true,
      enabled: true,
      planActive: true,
      vehicleSoc: 42,
      vehicleRange: 120,
      minSoc: 15,
      phasesActive: 1,
    };

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => makeEvccResponseV207([rawLoadpoint]),
    });

    const bridge = createEvccBridge({ baseUrl: 'http://localhost:7070', pollIntervalMs: 60000 });
    bridge.start();
    await new Promise(r => setTimeout(r, 50));
    bridge.stop();

    const lp = bridge.getState().loadpoints[0];
    assert.equal(lp.mode, 'minpv');
    assert.equal(lp.chargePower, 3600);
    assert.equal(lp.chargedEnergy, 5.2);
    assert.equal(lp.charging, false);
    assert.equal(lp.connected, true);
    assert.equal(lp.enabled, true);
    assert.equal(lp.planActive, true);
    assert.equal(lp.vehicleSoc, 42);
    assert.equal(lp.vehicleRange, 120);
    assert.equal(lp.minSoc, 15);
    assert.equal(lp.phasesActive, 1);
  });
});
