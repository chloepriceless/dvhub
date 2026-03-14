import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMispelTracker } from '../modules/optimizer/services/mispel-tracker.js';

/**
 * Helper: create a mock db with insertSamples and queryAggregates.
 */
function createMockDb({ aggregateResult = [] } = {}) {
  const insertedSamples = [];
  const queryCalls = [];
  return {
    insertSamples(samples) { insertedSamples.push(...samples); return Promise.resolve(); },
    queryAggregates(query) { queryCalls.push(query); return Promise.resolve(aggregateResult); },
    _insertedSamples: insertedSamples,
    _queryCalls: queryCalls
  };
}

describe('createMispelTracker', () => {
  it('returns object with recordEnergyFlow, getAnnualStatus, isEnabled methods', () => {
    const tracker = createMispelTracker({
      config: { enabled: false, pvPeakKwp: 10 },
      db: createMockDb()
    });
    assert.equal(typeof tracker.recordEnergyFlow, 'function');
    assert.equal(typeof tracker.getAnnualStatus, 'function');
    assert.equal(typeof tracker.isEnabled, 'function');
  });

  it('isEnabled returns false when config.mispel.enabled is false (default)', () => {
    const tracker1 = createMispelTracker({
      config: { enabled: false, pvPeakKwp: 10 },
      db: createMockDb()
    });
    assert.equal(tracker1.isEnabled(), false);

    // Default (no config)
    const tracker2 = createMispelTracker({ db: createMockDb() });
    assert.equal(tracker2.isEnabled(), false);
  });

  it('recordEnergyFlow calls db.insertSamples with three series keys', async () => {
    const db = createMockDb();
    const tracker = createMispelTracker({
      config: { enabled: true, pvPeakKwp: 10 },
      db
    });

    await tracker.recordEnergyFlow({
      timestamp: '2026-03-14T12:00:00Z',
      pvToStorageWh: 1000,
      gridToStorageWh: 500,
      storageToGridWh: 800
    });

    assert.equal(db._insertedSamples.length, 3);
    const keys = db._insertedSamples.map(s => s.seriesKey);
    assert.ok(keys.includes('mispel.pvToStorage'));
    assert.ok(keys.includes('mispel.gridToStorage'));
    assert.ok(keys.includes('mispel.storageToGrid'));

    // Verify values
    const pvSample = db._insertedSamples.find(s => s.seriesKey === 'mispel.pvToStorage');
    assert.equal(pvSample.valueNum, 1000);
    assert.equal(pvSample.unit, 'Wh');
    assert.equal(pvSample.ts, '2026-03-14T12:00:00Z');
  });

  it('getAnnualStatus calculates usedKwh from storageToGrid aggregation (Wh / 1000)', async () => {
    const db = createMockDb({ aggregateResult: [{ valueNum: 2500000 }] }); // 2500 kWh in Wh
    const tracker = createMispelTracker({
      config: { enabled: true, pvPeakKwp: 10, capKwhPerKwp: 500 },
      db
    });

    const status = await tracker.getAnnualStatus(2026);
    assert.equal(status.usedKwh, 2500);
  });

  it('getAnnualStatus calculates capKwh as pvPeakKwp * 500', async () => {
    const db = createMockDb({ aggregateResult: [] });
    const tracker = createMispelTracker({
      config: { enabled: true, pvPeakKwp: 10, capKwhPerKwp: 500 },
      db
    });

    const status = await tracker.getAnnualStatus(2026);
    assert.equal(status.capKwh, 5000); // 10 kWp * 500 kWh/kWp
  });

  it('getAnnualStatus calculates remainingKwh = max(0, capKwh - usedKwh)', async () => {
    const db = createMockDb({ aggregateResult: [{ valueNum: 2500000 }] });
    const tracker = createMispelTracker({
      config: { enabled: true, pvPeakKwp: 10, capKwhPerKwp: 500 },
      db
    });

    const status = await tracker.getAnnualStatus(2026);
    assert.equal(status.remainingKwh, 2500); // 5000 - 2500

    // Test clamping to 0 when over cap
    const db2 = createMockDb({ aggregateResult: [{ valueNum: 6000000 }] }); // 6000 kWh
    const tracker2 = createMispelTracker({
      config: { enabled: true, pvPeakKwp: 10, capKwhPerKwp: 500 },
      db: db2
    });
    const status2 = await tracker2.getAnnualStatus(2026);
    assert.equal(status2.remainingKwh, 0); // clamped to 0
  });

  it('getAnnualStatus calculates utilizationPct = (usedKwh / capKwh) * 100', async () => {
    const db = createMockDb({ aggregateResult: [{ valueNum: 2500000 }] });
    const tracker = createMispelTracker({
      config: { enabled: true, pvPeakKwp: 10, capKwhPerKwp: 500 },
      db
    });

    const status = await tracker.getAnnualStatus(2026);
    assert.equal(status.utilizationPct, 50); // 2500/5000 * 100
  });

  it('getAnnualStatus queries database with correct year boundaries', async () => {
    const db = createMockDb({ aggregateResult: [] });
    const tracker = createMispelTracker({
      config: { enabled: true, pvPeakKwp: 10 },
      db
    });

    await tracker.getAnnualStatus(2026);

    assert.equal(db._queryCalls.length, 1);
    const query = db._queryCalls[0];
    assert.deepEqual(query.seriesKeys, ['mispel.storageToGrid']);
    assert.equal(query.start.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(query.end.toISOString(), '2027-01-01T00:00:00.000Z');
    assert.equal(query.bucket, 'yearly');
  });

  it('recordEnergyFlow is a no-op when mispel.enabled is false', async () => {
    const db = createMockDb();
    const tracker = createMispelTracker({
      config: { enabled: false, pvPeakKwp: 10 },
      db
    });

    await tracker.recordEnergyFlow({
      timestamp: '2026-03-14T12:00:00Z',
      pvToStorageWh: 1000,
      gridToStorageWh: 500,
      storageToGridWh: 800
    });

    assert.equal(db._insertedSamples.length, 0, 'No samples should be inserted when disabled');
  });
});
