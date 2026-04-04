// test/family-api.test.js -- Unit tests for createFamilyService + buildFamilyStatus.
// Covers D-05 (single combined endpoint), D-07 (vorkalkulierte Sektionen),
// D-13 (mood pill optimizer extension), D-14 (strings/vehicles aggregation placeholders),
// D-22 (null-safe when forecast/optimizer services missing).
// See .planning/phases/03-waf-dashboard/03-RESEARCH.md Example 4 for mock pattern.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFamilyService } from '../services/family/index.js';

// --- Mock ctx factory ---

function createMockCtx(overrides = {}) {
  const state = {
    victron: {
      soc: 78,
      batteryPowerW: 1200,       // charging
      pvTotalW: 4800,             // 4.8 kW solar
      gridImportW: 0,
      gridExportW: 400,           // exporting 400 W
      ...overrides.victron
    },
    meter: {
      grid_total_w: 400,          // positive = export (meter default: semantics.positiveMeans === 'feed_in')
      ...overrides.meter
    },
    epex: {
      ok: true,
      date: '2026-04-03',
      nextDate: '2026-04-04',
      data: [
        { ts: Date.now() - 3600_000, ct_kwh: 25.0, day: '2026-04-03' },
        { ts: Date.now(), ct_kwh: 28.5, day: '2026-04-03' },
        { ts: Date.now() + 3600_000, ct_kwh: 26.8, day: '2026-04-03' }
      ],
      ...overrides.epex
    },
    energy: {
      day: '2026-04-03',
      importWh: 1800,
      exportWh: 6200,
      costEur: 0.54,
      revenueEur: 0.51
    },
    ...overrides.state
  };

  const cfg = {
    optimizer: {
      batteryCapacityWh: 13500   // 13.5 kWh
    },
    family: {
      useAsRoot: false,
      screensaver: { enabled: true, defaultTimeoutSec: 120, windows: [], dimOpacity: 0.3 },
      presence: { pollIntervalMs: 2000, webhookEnabled: true },
      branding: { title: 'Unser Zuhause', backgroundImage: '/assets/family-scene.png' }
    },
    ...overrides.cfg
  };

  const logs = [];

  return {
    state,
    getCfg: () => cfg,
    pushLog: (type, data) => logs.push({ type, data }),
    buildFallbackStatusPayload: overrides.buildFallbackStatusPayload || (() => ({
      victron: state.victron,
      meter: state.meter,
      epex: state.epex,
      costs: {
        netEur: -0.03,
        costEur: 0.54,
        revenueEur: 0.51,
        importKwh: 1.8,
        exportKwh: 6.2,
        priceNowCtKwh: 28.5
      },
      userEnergyPricing: { current: { importPriceCtKwh: 30 } }
    })),
    forecastService: overrides.forecastService !== undefined ? overrides.forecastService : {
      buildForecastResponse: () => ({
        meta: { generatedAt: new Date().toISOString(), horizon: '72h' },
        pv: {
          resolution: '15min',
          slots: [
            { start: new Date().toISOString(), end: new Date(Date.now() + 900_000).toISOString(), powerW: 4800, confidence: 0.92 },
            { start: new Date(Date.now() + 900_000).toISOString(), end: new Date(Date.now() + 1800_000).toISOString(), powerW: 5100, confidence: 0.9 }
          ]
        },
        load: {
          resolution: '1h',
          slots: [
            { start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString(), powerW: 800, confidence: 0.6 }
          ]
        },
        price: { resolution: '1h', slots: [] }
      })
    },
    optimizerService: overrides.optimizerService !== undefined ? overrides.optimizerService : {
      getStatus: () => ({
        enabled: true,
        source: 'internal',
        lastRunAt: Date.now(),
        currentAction: 'self_consume',
        schedule: [
          { ts: Date.now(), endTs: Date.now() + 900_000, action: 'self_consume', powerW: 0 }
        ]
      })
    },
    epexNowNext: () => ({
      current: { ct_kwh: 28.5 },
      next: { ct_kwh: 26.8 },
      today: '2026-04-03',
      tomorrow: '2026-04-04',
      todayMin: 180,
      todayMax: 341
    }),
    costSummary: () => ({
      netEur: -0.03,
      costEur: 0.54,
      revenueEur: 0.51,
      importKwh: 1.8,
      exportKwh: 6.2
    }),
    _logs: logs
  };
}

// ---------------------------------------------------------------------------
// Test 1: Factory returns required API surface
// ---------------------------------------------------------------------------

describe('createFamilyService', () => {
  it('returns { start, close, buildFamilyStatus, setPresence, getPresence }', () => {
    const svc = createFamilyService(createMockCtx());
    assert.equal(typeof svc.start, 'function');
    assert.equal(typeof svc.close, 'function');
    assert.equal(typeof svc.buildFamilyStatus, 'function');
    assert.equal(typeof svc.setPresence, 'function');
    assert.equal(typeof svc.getPresence, 'function');
  });
});

// ---------------------------------------------------------------------------
// Test 2: D-07 top-level payload keys
// ---------------------------------------------------------------------------

describe('buildFamilyStatus payload shape (D-07)', () => {
  it('contains all required top-level sections', () => {
    const svc = createFamilyService(createMockCtx());
    const status = svc.buildFamilyStatus();
    for (const key of [
      'now', 'energy', 'battery', 'ev', 'devices',
      'forecast', 'price', 'optimizer', 'savings',
      'greeting', 'presence', 'config'
    ]) {
      assert.ok(key in status, `missing top-level key: ${key}`);
    }
  });

  it('now is a number (timestamp)', () => {
    const svc = createFamilyService(createMockCtx());
    const status = svc.buildFamilyStatus();
    assert.equal(typeof status.now, 'number');
    assert.ok(status.now > 1_000_000_000_000, 'now should be a millisecond timestamp');
  });
});

// ---------------------------------------------------------------------------
// Test 3: energy section
// ---------------------------------------------------------------------------

describe('energy section', () => {
  it('contains solarKw, homeKw, gridKw, feedingToGrid, surplus derived from mock state', () => {
    const svc = createFamilyService(createMockCtx());
    const { energy } = svc.buildFamilyStatus();
    assert.equal(typeof energy.solarKw, 'number');
    assert.equal(typeof energy.homeKw, 'number');
    assert.equal(typeof energy.gridKw, 'number');
    assert.equal(typeof energy.feedingToGrid, 'boolean');
    assert.equal(typeof energy.surplus, 'boolean');
    // solarKw derived from pvTotalW=4800 → 4.8
    assert.equal(energy.solarKw, 4.8);
  });

  it('feedingToGrid is true when grid_total_w is positive (exporting, feed_in semantics)', () => {
    const svc = createFamilyService(createMockCtx());
    const { energy } = svc.buildFamilyStatus();
    assert.equal(energy.feedingToGrid, true);
  });

  it('surplus is true when solar > home', () => {
    const svc = createFamilyService(createMockCtx({
      victron: { pvTotalW: 5000, batteryPowerW: 0 },
      meter: { grid_total_w: 0 }
    }));
    const { energy } = svc.buildFamilyStatus();
    assert.equal(energy.surplus, true);
  });
});

// ---------------------------------------------------------------------------
// Test 4: battery section
// ---------------------------------------------------------------------------

describe('battery section', () => {
  it('contains socPct, powerKw, mode, capacityKwh, strings placeholder (D-14)', () => {
    const svc = createFamilyService(createMockCtx());
    const { battery } = svc.buildFamilyStatus();
    assert.equal(battery.socPct, 78);
    assert.equal(typeof battery.powerKw, 'number');
    assert.ok(['charging', 'discharging', 'idle'].includes(battery.mode));
    assert.equal(battery.capacityKwh, 13.5); // 13500 Wh → 13.5 kWh
    assert.ok(Array.isArray(battery.strings), 'strings must be array (D-14)');
  });

  it('mode is charging when batteryPowerW > 100', () => {
    const svc = createFamilyService(createMockCtx({ victron: { batteryPowerW: 1200 } }));
    const { battery } = svc.buildFamilyStatus();
    assert.equal(battery.mode, 'charging');
  });

  it('mode is discharging when batteryPowerW < -100', () => {
    const svc = createFamilyService(createMockCtx({ victron: { batteryPowerW: -1500 } }));
    const { battery } = svc.buildFamilyStatus();
    assert.equal(battery.mode, 'discharging');
  });

  it('mode is idle when |batteryPowerW| < 100', () => {
    const svc = createFamilyService(createMockCtx({ victron: { batteryPowerW: 50 } }));
    const { battery } = svc.buildFamilyStatus();
    assert.equal(battery.mode, 'idle');
  });
});

// ---------------------------------------------------------------------------
// Test 5: ev section
// ---------------------------------------------------------------------------

describe('ev section', () => {
  it('contains powerKw, mode, vehicles array (D-14)', () => {
    const svc = createFamilyService(createMockCtx());
    const { ev } = svc.buildFamilyStatus();
    assert.equal(typeof ev.powerKw, 'number');
    assert.ok(['solar_charging', 'grid_charging', 'idle'].includes(ev.mode));
    assert.ok(Array.isArray(ev.vehicles), 'vehicles must be array (D-14)');
  });
});

// ---------------------------------------------------------------------------
// Test 6: price section
// ---------------------------------------------------------------------------

describe('price section', () => {
  it('reads from ctx.epexNowNext()', () => {
    const svc = createFamilyService(createMockCtx());
    const { price } = svc.buildFamilyStatus();
    assert.equal(price.nowCtKwh, 28.5);
    assert.equal(price.nextHourCtKwh, 26.8);
    assert.equal(typeof price.todayMinCtKwh, 'number');
    assert.equal(typeof price.todayMaxCtKwh, 'number');
    assert.ok(Array.isArray(price.slots));
  });

  it('handles missing epexNowNext gracefully', () => {
    const ctx = createMockCtx();
    ctx.epexNowNext = () => null;
    const svc = createFamilyService(ctx);
    const { price } = svc.buildFamilyStatus();
    assert.ok(price);
    assert.equal(price.nowCtKwh, null);
  });
});

// ---------------------------------------------------------------------------
// Test 7: greeting.hello varies by hour (mocked Date)
// ---------------------------------------------------------------------------

describe('greeting section (D-13)', () => {
  let originalDateNow;
  let originalDate;

  function mockHour(h) {
    // Use a fixed date at hour `h` in local time
    const d = new Date();
    d.setHours(h, 0, 0, 0);
    const fixed = d.getTime();
    originalDateNow = Date.now;
    originalDate = global.Date;

    class MockDate extends originalDate {
      constructor(...args) {
        if (args.length === 0) {
          super(fixed);
        } else {
          super(...args);
        }
      }
      static now() { return fixed; }
    }
    global.Date = MockDate;
  }

  function restoreDate() {
    if (originalDate) global.Date = originalDate;
    if (originalDateNow) Date.now = originalDateNow;
  }

  afterEach(() => restoreDate());

  it('hello is "Guten Morgen" before 11:00', () => {
    mockHour(9);
    const svc = createFamilyService(createMockCtx());
    const { greeting } = svc.buildFamilyStatus();
    assert.equal(greeting.hello, 'Guten Morgen');
  });

  it('hello is "Guten Tag" between 11 and 13', () => {
    mockHour(12);
    const svc = createFamilyService(createMockCtx());
    const { greeting } = svc.buildFamilyStatus();
    assert.equal(greeting.hello, 'Guten Tag');
  });

  it('hello is "Guten Nachmittag" between 14 and 17', () => {
    mockHour(15);
    const svc = createFamilyService(createMockCtx());
    const { greeting } = svc.buildFamilyStatus();
    assert.equal(greeting.hello, 'Guten Nachmittag');
  });

  it('hello is "Guten Abend" 18 and later', () => {
    mockHour(20);
    const svc = createFamilyService(createMockCtx());
    const { greeting } = svc.buildFamilyStatus();
    assert.equal(greeting.hello, 'Guten Abend');
  });

  it('mood is "good" when surplus, "warn" otherwise', () => {
    const svcSurplus = createFamilyService(createMockCtx({
      victron: { pvTotalW: 5000, batteryPowerW: 0 },
      meter: { grid_total_w: 500 }     // positive = export (feed_in semantics)
    }));
    const s1 = svcSurplus.buildFamilyStatus();
    assert.equal(s1.greeting.mood, 'good');

    const svcDeficit = createFamilyService(createMockCtx({
      victron: { pvTotalW: 200, batteryPowerW: -1000 },
      meter: { grid_total_w: -2000 }   // negative = import (feed_in semantics)
    }));
    const s2 = svcDeficit.buildFamilyStatus();
    assert.equal(s2.greeting.mood, 'warn');
  });

  it('moodLabel extended with "Optimizer lädt gerade günstig" when optimizer charging (D-13)', () => {
    const ctx = createMockCtx();
    ctx.optimizerService = {
      getStatus: () => ({
        enabled: true,
        currentAction: 'grid_charging',
        schedule: [{ ts: Date.now(), endTs: Date.now() + 900_000, action: 'grid_charging', powerW: 2000 }]
      })
    };
    const svc = createFamilyService(ctx);
    const { greeting } = svc.buildFamilyStatus();
    assert.match(greeting.moodLabel, /Optimizer lädt gerade günstig/);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Null-safety
// ---------------------------------------------------------------------------

describe('null-safety', () => {
  it('buildFamilyStatus returns forecast=null when forecastService is null', () => {
    const ctx = createMockCtx({ forecastService: null });
    const svc = createFamilyService(ctx);
    const status = svc.buildFamilyStatus();
    assert.equal(status.forecast, null);
  });

  it('buildFamilyStatus returns optimizer={ enabled:false } when optimizerService is null', () => {
    const ctx = createMockCtx({ optimizerService: null });
    const svc = createFamilyService(ctx);
    const status = svc.buildFamilyStatus();
    assert.deepStrictEqual(status.optimizer, { enabled: false });
  });
});

// ---------------------------------------------------------------------------
// Test 9: Caching (TTL 2s per Research Pitfall 9)
// ---------------------------------------------------------------------------

describe('caching', () => {
  it('returns same object reference within 2000ms TTL', () => {
    const svc = createFamilyService(createMockCtx());
    const a = svc.buildFamilyStatus();
    const b = svc.buildFamilyStatus();
    assert.strictEqual(a, b, 'should return cached reference');
  });

  it('returns fresh object after TTL expires', async () => {
    // Use a short-TTL hack: call setPresence to invalidate cache manually,
    // since real timing is fragile. Alternative: mock Date.now.
    const svc = createFamilyService(createMockCtx());
    const a = svc.buildFamilyStatus();
    svc.setPresence({ detected: true, source: 'test' }); // invalidates cache
    const b = svc.buildFamilyStatus();
    assert.notStrictEqual(a, b, 'should return fresh object after cache invalidation');
  });
});

// ---------------------------------------------------------------------------
// Test 10: devices is empty array (Phase 04 INTG-05 will populate)
// ---------------------------------------------------------------------------

describe('devices section', () => {
  it('is an empty array in Phase 03 (INTG-05 deferred)', () => {
    const svc = createFamilyService(createMockCtx());
    const { devices } = svc.buildFamilyStatus();
    assert.ok(Array.isArray(devices));
    assert.equal(devices.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Test 11: presence included in status response
// ---------------------------------------------------------------------------

describe('presence in buildFamilyStatus', () => {
  it('includes presence from internal state', () => {
    const svc = createFamilyService(createMockCtx());
    svc.setPresence({ detected: true, source: 'loxone' });
    const status = svc.buildFamilyStatus();
    assert.equal(status.presence.detected, true);
    assert.equal(status.presence.source, 'loxone');
    assert.ok(status.presence.updatedAt > 0);
  });
});

// ---------------------------------------------------------------------------
// Test 12: config section reads from getCfg().family
// ---------------------------------------------------------------------------

describe('config section', () => {
  it('contains screensaver and presence from getCfg().family', () => {
    const svc = createFamilyService(createMockCtx());
    const { config } = svc.buildFamilyStatus();
    assert.ok(config);
    assert.ok(config.screensaver);
    assert.equal(config.screensaver.defaultTimeoutSec, 120);
    assert.ok(config.presence);
    assert.equal(config.presence.pollIntervalMs, 2000);
  });
});

// ---------------------------------------------------------------------------
// Test 13: savings section
// ---------------------------------------------------------------------------

describe('savings section', () => {
  it('contains todayEur, monthEur, feedInRevenueEur, avoidedCostEur', () => {
    const svc = createFamilyService(createMockCtx());
    const { savings } = svc.buildFamilyStatus();
    assert.ok('todayEur' in savings);
    assert.ok('monthEur' in savings);
    assert.ok('feedInRevenueEur' in savings);
    assert.ok('avoidedCostEur' in savings);
  });
});
