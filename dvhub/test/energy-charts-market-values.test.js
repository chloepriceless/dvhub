import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEnergyChartsMarketValueService,
  fetchEnergyChartsSolarMarketValues
} from '../energy-charts-market-values.js';

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
