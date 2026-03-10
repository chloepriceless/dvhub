const ENERGY_CHARTS_MARKET_VALUES_BASE = 'https://www.energy-charts.info/charts/market_values/data/de';

function localizedNames(field) {
  const values = Array.isArray(field) ? field : [field];
  return values.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object') return Object.values(entry);
    return [];
  }).map((value) => String(value || '').toLowerCase());
}

function findSeriesByName(series, matcher) {
  return (Array.isArray(series) ? series : []).find((entry) => matcher(localizedNames(entry?.name)));
}

function isMonthlySolarSeries(names) {
  return names.some((name) => name.includes('marktwert solar') || name.includes('market value solar'))
    && !names.some((name) => name.includes('jahres') || name.includes('annual'));
}

function isAnnualSolarSeries(names) {
  return names.some((name) => name.includes('jahresmarktwert solar') || name.includes('annual market value solar'));
}

function monthlyMap(year, series) {
  const data = Array.isArray(series?.data) ? series.data : [];
  const months = Array.isArray(series?.xAxisValues) && series.xAxisValues.length > 0
    ? series.xAxisValues
    : data.map((_, index) => index + 1);
  return months.reduce((out, monthValue, index) => {
    const month = Number(monthValue);
    const ctKwh = Number(data[index]);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isFinite(ctKwh)) return out;
    out[`${year}-${String(month).padStart(2, '0')}`] = ctKwh;
    return out;
  }, {});
}

function annualMap(series, requestedYear) {
  const data = Array.isArray(series?.data) ? series.data : [];
  const currentYear = new Date().getUTCFullYear();
  const latestCompleteYear = Math.min(
    Number.isInteger(Number(requestedYear)) ? Number(requestedYear) : currentYear - 1,
    currentYear - 1
  );
  const years = Array.isArray(series?.xAxisValues) && series.xAxisValues.length > 0
    ? series.xAxisValues
    : data.map((_, index) => latestCompleteYear - data.length + index + 1);
  return years.reduce((out, yearValue, index) => {
    const year = Number(yearValue);
    const ctKwh = Number(data[index]);
    if (!Number.isInteger(year) || !Number.isFinite(ctKwh)) return out;
    out[year] = ctKwh;
    return out;
  }, {});
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Energy Charts market value request failed: HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

export async function fetchEnergyChartsSolarMarketValues({ year, fetchImpl = globalThis.fetch } = {}) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear)) {
    throw new Error('year must be an integer');
  }
  const [monthlyPayload, annualPayload] = await Promise.all([
    fetchJson(`${ENERGY_CHARTS_MARKET_VALUES_BASE}/month_cent_kwh_${numericYear}.json`, fetchImpl),
    fetchJson(`${ENERGY_CHARTS_MARKET_VALUES_BASE}/year_cent_kwh.json`, fetchImpl)
  ]);
  const monthlySeries = findSeriesByName(monthlyPayload, isMonthlySolarSeries);
  const annualSeries = findSeriesByName(annualPayload, isAnnualSolarSeries);
  return {
    monthlyCtKwhByMonth: monthlyMap(numericYear, monthlySeries),
    annualCtKwhByYear: annualMap(annualSeries, numericYear)
  };
}

export function createEnergyChartsMarketValueService({ fetchImpl = globalThis.fetch } = {}) {
  const cache = new Map();

  async function getSolarMarketValueSummary({ year }) {
    const numericYear = Number(year);
    if (!Number.isInteger(numericYear)) {
      return { monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} };
    }
    if (!cache.has(numericYear)) {
      cache.set(numericYear, fetchEnergyChartsSolarMarketValues({
        year: numericYear,
        fetchImpl
      }).catch((error) => {
        cache.delete(numericYear);
        throw error;
      }));
    }
    return cache.get(numericYear);
  }

  return {
    getSolarMarketValueSummary
  };
}
