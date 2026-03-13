const ENERGY_CHARTS_MARKET_VALUES_BASE = 'https://www.energy-charts.info/charts/market_values/data/de';
const DEFAULT_FETCH_COOLDOWN_MS = 6 * 3600_000;

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

function persistSummary(summary, marketValueStore) {
  if (!marketValueStore?.upsertSolarMarketValue) return;
  for (const [key, ctKwh] of Object.entries(summary?.monthlyCtKwhByMonth || {})) {
    marketValueStore.upsertSolarMarketValue({
      scope: 'monthly',
      key,
      ctKwh,
      source: 'energy_charts'
    });
  }
  for (const [key, ctKwh] of Object.entries(summary?.annualCtKwhByYear || {})) {
    marketValueStore.upsertSolarMarketValue({
      scope: 'annual',
      key: String(key),
      ctKwh,
      source: 'energy_charts'
    });
  }
}

function emptySummary() {
  return {
    monthlyCtKwhByMonth: {},
    annualCtKwhByYear: {}
  };
}

function monthlyEntryCount(summary) {
  return Object.keys(summary?.monthlyCtKwhByMonth || {}).length;
}

function isCooldownActive(cooldownUntil, nowValue) {
  const untilMs = Date.parse(cooldownUntil || '');
  const nowMs = Date.parse(nowValue || '');
  if (!Number.isFinite(untilMs) || !Number.isFinite(nowMs)) return false;
  return untilMs > nowMs;
}

function utcDateKey(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  return new Date(time).toISOString().slice(0, 10);
}

function wasAttemptedToday(lastAttemptAt, nowValue) {
  const attemptedDay = utcDateKey(lastAttemptAt);
  return attemptedDay !== '' && attemptedDay === utcDateKey(nowValue);
}

function yearFromIso(value) {
  const year = Number(String(value || '').slice(0, 4));
  return Number.isInteger(year) ? year : null;
}

function currentMonthFromIso(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return null;
  return new Date(time).getUTCMonth() + 1;
}

function normalizeBackfillYears(years = []) {
  return [...new Set(
    (Array.isArray(years) ? years : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value))
  )].sort((left, right) => left - right);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createEnergyChartsMarketValueService({
  fetchImpl = globalThis.fetch,
  marketValueStore = null,
  nowIso = () => new Date().toISOString(),
  fetchCooldownMs = DEFAULT_FETCH_COOLDOWN_MS
} = {}) {
  const cache = new Map();
  const pendingByYear = new Map();

  function needsRefresh({ year, persisted, nowValue }) {
    if (!marketValueStore) return !cache.has(year);

    if (!persisted?.hasAny) {
      return !isCooldownActive(persisted?.cooldownUntil, nowValue);
    }

    const currentYear = yearFromIso(nowValue);
    const currentMonth = currentMonthFromIso(nowValue);
    const monthlyValues = monthlyEntryCount(persisted?.summary);
    if (currentYear != null && currentMonth != null && year === currentYear) {
      if (monthlyValues >= currentMonth) return false;
      if (isCooldownActive(persisted?.cooldownUntil, nowValue)) return false;
      return !wasAttemptedToday(persisted?.attempt?.lastAttemptAt, nowValue);
    }

    if (persisted?.hasComplete !== false) return false;
    if (isCooldownActive(persisted?.cooldownUntil, nowValue)) return false;
    return !wasAttemptedToday(persisted?.attempt?.lastAttemptAt, nowValue);
  }

  async function getSolarMarketValueSummary({ year, throwOnError = false }) {
    const numericYear = Number(year);
    if (!Number.isInteger(numericYear)) {
      return emptySummary();
    }
    if (!marketValueStore) {
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

    const persisted = marketValueStore.listSolarMarketValuesForYear?.({ year: numericYear }) || null;
    const attemptedAt = nowIso();
    if (!needsRefresh({ year: numericYear, persisted, nowValue: attemptedAt })) {
      return persisted?.summary || emptySummary();
    }
    if (!pendingByYear.has(numericYear)) {
      pendingByYear.set(numericYear, Promise.resolve(fetchEnergyChartsSolarMarketValues({
        year: numericYear,
        fetchImpl
      })).then((summary) => {
        persistSummary(summary, marketValueStore);
        marketValueStore?.markSolarMarketValueAttempt?.({
          year: numericYear,
          attemptedAt,
          status: 'ready',
          error: null,
          cooldownUntil: null
        });
        return { ok: true, summary };
      }).catch((error) => {
        marketValueStore?.markSolarMarketValueAttempt?.({
          year: numericYear,
          attemptedAt,
          status: 'error',
          error: error.message,
          cooldownUntil: new Date(Date.parse(attemptedAt) + fetchCooldownMs).toISOString()
        });
        return {
          ok: false,
          summary: persisted?.summary || emptySummary(),
          error
        };
      }).finally(() => {
        pendingByYear.delete(numericYear);
      }));
    }
    const result = await pendingByYear.get(numericYear);
    if (!result.ok && throwOnError) throw result.error;
    return result.summary;
  }

  async function backfillMissingSolarMarketValues({
    years = [],
    maxYearsPerRun = 2,
    pauseMs = 1500,
    waitImpl = wait
  } = {}) {
    const candidateYears = normalizeBackfillYears(years);
    const fetchedYears = [];

    for (const year of candidateYears) {
      if (fetchedYears.length >= Math.max(1, Number(maxYearsPerRun || 1))) break;
      if (marketValueStore?.hasCompleteSolarMarketValueYear?.({ year })) continue;

      const persisted = marketValueStore?.listSolarMarketValuesForYear?.({ year }) || null;
      if (isCooldownActive(persisted?.cooldownUntil, nowIso())) continue;

      try {
        await getSolarMarketValueSummary({ year, throwOnError: true });
        fetchedYears.push(year);
      } catch {
        continue;
      }

      if (fetchedYears.length < Math.max(1, Number(maxYearsPerRun || 1))) {
        await waitImpl(pauseMs);
      }
    }

    return {
      requestedYears: fetchedYears,
      fetchedCount: fetchedYears.length
    };
  }

  return {
    getSolarMarketValueSummary,
    backfillMissingSolarMarketValues
  };
}
