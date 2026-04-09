import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createEnergyChartsMarketValueService,
  fetchEnergyChartsSolarMarketValues
} from '../energy-charts-market-values.js';
import { createTelemetryStore } from '../telemetry-store.js';

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-market-values-'));
  return path.join(dir, 'telemetry.sqlite');
}

async function successfulFetchFixture(url) {
  if (String(url).includes('month_cent_kwh_2026.json')) {
    return {
      ok: true,
      async json() {
        return [
          {
            name: [{ en: 'Market value solar', de: 'Marktwert Solar' }],
            xAxisValues: [1, 2, 3],
            data: [11.5, 9.4, 5.0]
          }
        ];
      }
    };
  }
  return {
    ok: true,
    async json() {
      return [
        {
          name: [{ en: 'Annual market value solar (JW Solar)', de: 'Jahresmarktwert Solar (JW Solar)' }],
          xAxisValues: [2024, 2025, 2026],
          data: [4.624, 4.508, null]
        }
      ];
    }
  };
}

test('fetchEnergyChartsSolarMarketValues parses monthly and annual solar market values', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes('month_cent_kwh_2026.json')) {
      return {
        ok: true,
        async json() {
          return [
            {
              name: [{ en: 'Market value solar', de: 'Marktwert Solar' }],
              xAxisValues: [1, 2, 3],
              data: [11.5, 9.4, 5.0]
            }
          ];
        }
      };
    }
    return {
      ok: true,
      async json() {
        return [
          {
            name: [{ en: 'Annual market value solar (JW Solar)', de: 'Jahresmarktwert Solar (JW Solar)' }],
            xAxisValues: [2024, 2025, 2026],
            data: [4.624, 4.508, null]
          }
        ];
      }
    };
  };

  const summary = await fetchEnergyChartsSolarMarketValues({ year: 2026, fetchImpl });

  assert.equal(calls.length, 2);
  assert.equal(summary.monthlyCtKwhByMonth['2026-01'], 11.5);
  assert.equal(summary.monthlyCtKwhByMonth['2026-03'], 5);
  assert.equal(summary.annualCtKwhByYear[2024], 4.624);
  assert.equal(summary.annualCtKwhByYear[2025], 4.508);
});

test('fetchEnergyChartsSolarMarketValues infers axes when Energy Charts omits xAxisValues', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('month_cent_kwh_2026.json')) {
      return {
        ok: true,
        async json() {
          return [
            {
              name: [{ en: 'Market value solar', de: 'Marktwert Solar' }],
              data: [11.5, 9.4, 5.0]
            }
          ];
        }
      };
    }
    return {
      ok: true,
      async json() {
        return [
          {
            name: [{ en: 'Annual market value solar (JW Solar)', de: 'Jahresmarktwert Solar (JW Solar)' }],
            data: [4.624, 4.508, null]
          }
        ];
      }
    };
  };

  const summary = await fetchEnergyChartsSolarMarketValues({ year: 2026, fetchImpl });

  assert.equal(summary.monthlyCtKwhByMonth['2026-01'], 11.5);
  assert.equal(summary.monthlyCtKwhByMonth['2026-03'], 5);
  assert.equal(summary.annualCtKwhByYear[2023], 4.624);
  assert.equal(summary.annualCtKwhByYear[2024], 4.508);
});

test('energy charts market value service caches per year', async () => {
  let calls = 0;
  const service = createEnergyChartsMarketValueService({
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        async json() {
          return [
            {
              name: [{ en: calls === 1 ? 'Market value solar' : 'Annual market value solar (JW Solar)' }],
              xAxisValues: calls === 1 ? [1] : [2025],
              data: [5]
            }
          ];
        }
      };
    }
  });

  const first = await service.getSolarMarketValueSummary({ year: 2026 });
  const second = await service.getSolarMarketValueSummary({ year: 2026 });

  assert.equal(calls, 2);
  assert.deepEqual(second, first);
});

test('market value service returns locally persisted values without re-fetching the same year', async () => {
  let calls = 0;
  const service = createEnergyChartsMarketValueService({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('should not fetch');
    },
    marketValueStore: {
      listSolarMarketValuesForYear({ year }) {
        assert.equal(year, 2025);
        return {
          hasAny: true,
          hasComplete: true,
          summary: {
            monthlyCtKwhByMonth: {
              '2025-01': 5,
              '2025-02': 5,
              '2025-03': 5,
              '2025-04': 5,
              '2025-05': 5,
              '2025-06': 5,
              '2025-07': 5,
              '2025-08': 5,
              '2025-09': 5,
              '2025-10': 5,
              '2025-11': 5,
              '2025-12': 5
            },
            annualCtKwhByYear: { 2025: 4.508 }
          }
        };
      }
    }
  });

  const summary = await service.getSolarMarketValueSummary({ year: 2025 });

  assert.equal(calls, 0);
  assert.equal(summary.monthlyCtKwhByMonth['2025-03'], 5);
  assert.equal(summary.annualCtKwhByYear[2025], 4.508);
});

test('market value service persists fetched monthly and annual values into the local store', async () => {
  const writes = [];
  const service = createEnergyChartsMarketValueService({
    fetchImpl: successfulFetchFixture,
    marketValueStore: {
      listSolarMarketValuesForYear() {
        return null;
      },
      upsertSolarMarketValue(entry) {
        writes.push(entry);
      }
    }
  });

  await service.getSolarMarketValueSummary({ year: 2026 });

  assert.ok(writes.some((entry) => entry.scope === 'monthly' && entry.key === '2026-03'));
  assert.ok(writes.some((entry) => entry.scope === 'annual' && entry.key === '2025'));
});

test('market value service records cooldown metadata when the Energy Charts fetch fails', async () => {
  const attempts = [];
  const service = createEnergyChartsMarketValueService({
    fetchImpl: async () => {
      throw new Error('HTTP 429');
    },
    marketValueStore: {
      listSolarMarketValuesForYear() {
        return null;
      },
      markSolarMarketValueAttempt(entry) {
        attempts.push(entry);
      }
    },
    nowIso: () => '2026-03-11T11:00:00.000Z'
  });

  const summary = await service.getSolarMarketValueSummary({ year: 2026 });

  assert.deepEqual(summary, { monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} });
  assert.deepEqual(attempts, [
    {
      year: 2026,
      attemptedAt: '2026-03-11T11:00:00.000Z',
      status: 'error',
      error: 'HTTP 429',
      cooldownUntil: '2026-03-11T17:00:00.000Z'
    }
  ]);
});

test('market value service skips refetching a cooled-down year after an API failure', async () => {
  let calls = 0;
  const service = createEnergyChartsMarketValueService({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('HTTP 429');
    },
    marketValueStore: {
      listSolarMarketValuesForYear({ year }) {
        assert.equal(year, 2026);
        return {
          hasAny: false,
          summary: { monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} },
          cooldownUntil: '2026-03-11T12:00:00.000Z'
        };
      }
    },
    nowIso: () => '2026-03-11T11:00:00.000Z'
  });

  const summary = await service.getSolarMarketValueSummary({ year: 2026 });

  assert.equal(calls, 0);
  assert.deepEqual(summary, { monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} });
});

test('market value service refreshes an incomplete current year from the local store and persists new months', async () => {
  const dbPath = createTempDbPath();
  const store = createTelemetryStore({
    dbPath,
    rawRetentionDays: 30,
    rollupIntervals: [300, 900, 3600]
  });

  try {
    store.upsertSolarMarketValue({
      scope: 'monthly',
      key: '2026-01',
      ctKwh: 11.5,
      source: 'energy_charts',
      fetchedAt: '2026-01-15T00:00:00.000Z',
      lastAttemptAt: '2026-01-15T00:00:00.000Z'
    });
    store.markSolarMarketValueAttempt({
      year: 2026,
      attemptedAt: '2026-01-15T00:00:00.000Z',
      cooldownUntil: null,
      status: 'ready',
      error: null
    });

    const service = createEnergyChartsMarketValueService({
      fetchImpl: successfulFetchFixture,
      marketValueStore: store,
      nowIso: () => '2026-03-11T10:00:00.000Z'
    });

    const summary = await service.getSolarMarketValueSummary({ year: 2026 });

    assert.equal(summary.monthlyCtKwhByMonth['2026-01'], 11.5);
    assert.equal(summary.monthlyCtKwhByMonth['2026-03'], 5);
    assert.equal(store.getSolarMarketValue({ scope: 'monthly', key: '2026-03' }).ctKwh, 5);
  } finally {
    store.close();
  }
});

test('a fresh market value service instance reuses persisted values from the telemetry store', async () => {
  const dbPath = createTempDbPath();
  const firstStore = createTelemetryStore({
    dbPath,
    rawRetentionDays: 30,
    rollupIntervals: [300, 900, 3600]
  });

  try {
    const firstService = createEnergyChartsMarketValueService({
      fetchImpl: successfulFetchFixture,
      marketValueStore: firstStore
    });
    await firstService.getSolarMarketValueSummary({ year: 2026 });
  } finally {
    firstStore.close();
  }

  const secondStore = createTelemetryStore({
    dbPath,
    rawRetentionDays: 30,
    rollupIntervals: [300, 900, 3600]
  });

  try {
    let calls = 0;
    const secondService = createEnergyChartsMarketValueService({
      fetchImpl: async () => {
        calls += 1;
        throw new Error('should not fetch after restart');
      },
      marketValueStore: secondStore
    });

    const summary = await secondService.getSolarMarketValueSummary({ year: 2026 });

    assert.equal(calls, 0);
    assert.equal(summary.monthlyCtKwhByMonth['2026-03'], 5);
    assert.equal(summary.annualCtKwhByYear[2025], 4.508);
  } finally {
    secondStore.close();
  }
});

test('automatic market value backfill only fetches missing historical years in small batches', async () => {
  const requestedYears = [];
  const service = createEnergyChartsMarketValueService({
    fetchImpl: async (url) => {
      const match = String(url).match(/month_cent_kwh_(\d{4})\.json/);
      if (match) requestedYears.push(Number(match[1]));
      return successfulFetchFixture(url);
    },
    marketValueStore: {
      hasCompleteSolarMarketValueYear({ year }) {
        return year === 2025;
      },
      listSolarMarketValuesForYear() {
        return null;
      },
      upsertSolarMarketValue() {}
    },
    nowIso: () => '2026-03-11T10:00:00.000Z'
  });

  await service.backfillMissingSolarMarketValues({
    years: [2023, 2024, 2025],
    maxYearsPerRun: 2,
    waitImpl: async () => {}
  });

  assert.deepEqual(requestedYears.sort(), [2023, 2024]);
});

test('market value service does not retry again on the same day after a failed fetch when the store records the attempt', async () => {
  const dbPath = createTempDbPath();
  const store = createTelemetryStore({
    dbPath,
    rawRetentionDays: 30,
    rollupIntervals: [300, 900, 3600]
  });

  try {
    let calls = 0;
    const service = createEnergyChartsMarketValueService({
      fetchImpl: async () => {
        calls += 1;
        throw new Error('offline');
      },
      marketValueStore: store,
      nowIso: () => '2026-03-11T11:00:00.000Z'
    });

    const first = await service.getSolarMarketValueSummary({ year: 2026 });
    const second = await service.getSolarMarketValueSummary({ year: 2026 });

    assert.deepEqual(first, { monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} });
    assert.deepEqual(second, first);
    assert.equal(calls, 2);
  } finally {
    store.close();
  }
});
