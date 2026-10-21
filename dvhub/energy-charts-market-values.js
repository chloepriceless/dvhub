// Monatsmarktwert Solar (MW Solar) und Jahresmarktwert (JW Solar).
//
// Quelle seit 21.10.2026 (Chrissi): netztransparenz.de, die Veröffentlichung der
// Übertragungsnetzbetreiber — amtlich und meist Wochen vor Energy-Charts. Am
// 21.10. fehlte dort der September (amtlich seit 09.10.: 8,177 ct/kWh), und für
// Mai stand 3,163 statt des amtlichen 3,296 ct/kWh. Energy-Charts bleibt Rückfall
// für die Monate und liefert den Jahresmarktwert (deckt sich mit dem amtlichen).
// netztransparenz geht ohne Zugangsdaten über die Diagramm-Schnittstelle der
// Marktwertübersicht (Merkel: „netztransparenz Monats-Marktwert Solar (MW Solar)
// credential-frei holen — ASMX GetMarketpremiumData“).
const ENERGY_CHARTS_MARKET_VALUES_BASE = 'https://www.energy-charts.info/charts/market_values/data/de';
const NETZTRANSPARENZ_MARKET_VALUES_URL = 'https://www.netztransparenz.de/DesktopModules/LotesCharts/Services/HighchartService.asmx/GetMarketpremiumData';
const NETZTRANSPARENZ_TIMEOUT_MS = 20_000;
const DEFAULT_FETCH_COOLDOWN_MS = 6 * 3600_000;
// Versuchs-Status eines Jahres: 'official' = Monate von netztransparenz,
// 'ready' = nur Energy-Charts (wird für abgeschlossene Jahre einmal nachgeholt).
const OFFICIAL_STATUS = 'official';

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

/**
 * Amtliche Monatsmarktwerte eines Jahres von netztransparenz. Antwort {d: JSON},
 * darin chartData als Semikolon-CSV „Monat;Spotmarktpreis;MW Wind an Land;MW Wind
 * auf See;MW Solar;MW“, Monat = Unix-ms des Monatsersten, Werte ct/kWh mit Punkt.
 * Noch nicht veröffentlichte Monate sind leer und fehlen im Ergebnis.
 */
export async function fetchNetztransparenzSolarMarketValues({ year, fetchImpl = globalThis.fetch } = {}) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear)) throw new Error('year must be an integer');
  // ASP.NET-JSON mit einfachen Anführungszeichen, Werte wie im Diagramm der Seite.
  const body = `{'dateFrom':'${numericYear}-01-01T00:00:00','asImage':false,'diagramType':'line','highChartType':'2',`
    + `'columnColors':null,'template':'D:/root/Websites/dnn_unb_ext02_relaunch/Web/DesktopModules/LotesCharts/Templates/ExcelTemplate.xlsx',`
    + `'title':'Monatsmarktwerte','timezone':'Europe/Berlin'}`;
  const response = await fetchImpl(NETZTRANSPARENZ_MARKET_VALUES_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
    body,
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(NETZTRANSPARENZ_TIMEOUT_MS) : undefined
  });
  if (!response.ok) throw new Error(`netztransparenz market value request failed: HTTP ${response.status}`);
  const outer = await response.json();
  const inner = typeof outer?.d === 'string' ? JSON.parse(outer.d) : outer?.d;
  const lines = String(inner?.chartData || '').split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = (lines.shift() || '').split(';').map((h) => h.trim().toLowerCase());
  const col = header.indexOf('mw solar');
  if (col < 0) throw new Error('netztransparenz: Spalte „MW Solar“ fehlt');
  const monthlyCtKwhByMonth = {};
  for (const line of lines) {
    const cells = line.split(';');
    const ts = Number(cells[0]);
    const raw = String(cells[col] ?? '').trim();
    if (!Number.isFinite(ts) || raw === '') continue;
    const ctKwh = Number(raw.replace(',', '.'));
    if (!Number.isFinite(ctKwh)) continue;
    // +12 h: egal ob der Zeitstempel UTC- oder Berliner Mitternacht ist.
    const d = new Date(ts + 12 * 3600_000);
    if (d.getUTCFullYear() !== numericYear) continue;
    monthlyCtKwhByMonth[`${numericYear}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`] = ctKwh;
  }
  return { monthlyCtKwhByMonth };
}

/**
 * Zentral von dvhub.online (price-api /v1/pv/solar-market-values, 21.10.2026):
 * amtliche Monate, JW Solar und der laufende Jahreswert, gewichtet mit der
 * bundesweiten Solarerzeugung — die Box rechnet den Jahreswert nicht mehr selbst.
 */
export async function fetchCentralSolarMarketValues({ year, baseUrl, fetchImpl = globalThis.fetch } = {}) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear)) throw new Error('year must be an integer');
  const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/pv/solar-market-values?year=${numericYear}`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(NETZTRANSPARENZ_TIMEOUT_MS) : undefined
  });
  if (!response.ok) throw new Error(`dvhub.online market value request failed: HTTP ${response.status}`);
  const body = await response.json();
  const monthlyCtKwhByMonth = {};
  const monthlySourceByMonth = {};
  for (const [key, value] of Object.entries(body?.monthlyCtKwhByMonth || {})) {
    const ct = Number(value);
    if (!/^\d{4}-\d{2}$/.test(key) || !Number.isFinite(ct)) continue;
    monthlyCtKwhByMonth[key] = ct;
    monthlySourceByMonth[key] = 'netztransparenz';
  }
  const annualCtKwhByYear = {};
  for (const [key, value] of Object.entries(body?.annualCtKwhByYear || {})) {
    const ct = Number(value);
    if (Number.isInteger(Number(key)) && Number.isFinite(ct) && ct > 0) annualCtKwhByYear[Number(key)] = ct;
  }
  const running = Number(body?.runningAnnualCtKwh);
  return {
    monthlyCtKwhByMonth,
    monthlySourceByMonth,
    annualCtKwhByYear,
    runningAnnualCtKwh: body?.runningAnnualCtKwh != null && Number.isFinite(running) ? running : null,
    official: Object.keys(monthlyCtKwhByMonth).length > 0
  };
}

/**
 * Erst zentral von dvhub.online (wenn die Box ihre Preise dort holt), sonst
 * direkt: Monate amtlich (netztransparenz), sonst Energy-Charts; Jahresmarktwert
 * von Energy-Charts. Wirft nur, wenn keine Quelle etwas liefert.
 */
export async function fetchSolarMarketValues({ year, fetchImpl = globalThis.fetch, centralBaseUrl = null } = {}) {
  if (centralBaseUrl) {
    try {
      const central = await fetchCentralSolarMarketValues({ year, baseUrl: centralBaseUrl, fetchImpl });
      if (central.official || Object.keys(central.annualCtKwhByYear).length > 0) return central;
    } catch {
      // dvhub.online nicht erreichbar → direkte Quellen
    }
  }
  const [nt, ec] = await Promise.allSettled([
    fetchNetztransparenzSolarMarketValues({ year, fetchImpl }),
    fetchEnergyChartsSolarMarketValues({ year, fetchImpl })
  ]);
  const official = nt.status === 'fulfilled' && Object.keys(nt.value.monthlyCtKwhByMonth).length > 0;
  if (!official && ec.status !== 'fulfilled') {
    throw (ec.reason || nt.reason || new Error('no market value source available'));
  }
  const monthlyCtKwhByMonth = {};
  const monthlySourceByMonth = {};
  for (const [key, value] of Object.entries(ec.status === 'fulfilled' ? ec.value.monthlyCtKwhByMonth : {})) {
    monthlyCtKwhByMonth[key] = value;
    monthlySourceByMonth[key] = 'energy_charts';
  }
  if (official) {
    for (const [key, value] of Object.entries(nt.value.monthlyCtKwhByMonth)) {
      monthlyCtKwhByMonth[key] = value;
      monthlySourceByMonth[key] = 'netztransparenz';
    }
  }
  return {
    monthlyCtKwhByMonth,
    monthlySourceByMonth,
    annualCtKwhByYear: ec.status === 'fulfilled' ? ec.value.annualCtKwhByYear : {},
    // Den deutschlandweiten laufenden Wert gibt es nur zentral.
    runningAnnualCtKwh: null,
    official
  };
}

async function persistSummary(summary, marketValueStore) {
  if (!marketValueStore?.upsertSolarMarketValue) return;
  for (const [key, ctKwh] of Object.entries(summary?.monthlyCtKwhByMonth || {})) {
    await marketValueStore.upsertSolarMarketValue({
      scope: 'monthly',
      key,
      ctKwh,
      source: summary?.monthlySourceByMonth?.[key] || 'energy_charts'
    });
  }
  // Laufender Jahreswert von dvhub.online (scope 'running', key = Jahr).
  if (summary?.year != null && Number.isFinite(Number(summary?.runningAnnualCtKwh))) {
    await marketValueStore.upsertSolarMarketValue({
      scope: 'running',
      key: String(summary.year),
      ctKwh: Number(summary.runningAnnualCtKwh),
      source: 'dvhub_online'
    });
  }
  for (const [key, ctKwh] of Object.entries(summary?.annualCtKwhByYear || {})) {
    await marketValueStore.upsertSolarMarketValue({
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
  fetchCooldownMs = DEFAULT_FETCH_COOLDOWN_MS,
  // Basis-URL der Preis-API (dvhub.online), wenn die Box ihre Börsenpreise dort
  // holt; null = nur direkte Quellen.
  getCentralBaseUrl = () => null
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

    // Abgeschlossenes Jahr: vollständig UND amtlich → nie wieder. Vollständig nur
    // von Energy-Charts (vor dem 21.10.2026) → einmal amtlich nachholen.
    if (persisted?.hasComplete !== false && persisted?.attempt?.status === OFFICIAL_STATUS) return false;
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
        cache.set(numericYear, fetchSolarMarketValues({
          year: numericYear,
          fetchImpl,
          centralBaseUrl: getCentralBaseUrl()
        }).catch((error) => {
          cache.delete(numericYear);
          throw error;
        }));
      }
      return cache.get(numericYear);
    }

    const persisted = await marketValueStore.listSolarMarketValuesForYear?.({ year: numericYear }) || null;
    const attemptedAt = nowIso();
    if (!needsRefresh({ year: numericYear, persisted, nowValue: attemptedAt })) {
      return persisted?.summary || emptySummary();
    }
    if (!pendingByYear.has(numericYear)) {
      pendingByYear.set(numericYear, Promise.resolve(fetchSolarMarketValues({
        year: numericYear,
        fetchImpl,
        centralBaseUrl: getCentralBaseUrl()
      })).then(async (summary) => {
        await persistSummary({ ...summary, year: numericYear }, marketValueStore);
        await marketValueStore?.markSolarMarketValueAttempt?.({
          year: numericYear,
          attemptedAt,
          status: summary.official ? OFFICIAL_STATUS : 'ready',
          error: null,
          cooldownUntil: null
        });
        return { ok: true, summary };
      }).catch(async (error) => {
        await marketValueStore?.markSolarMarketValueAttempt?.({
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
      // Dieselbe Regel wie beim Abruf: vollständige amtliche Jahre überspringen,
      // reine Energy-Charts-Jahre einmal nachholen. (await: der PG-Speicher ist
      // asynchron — vorher war das Promise immer „wahr“ und jedes Jahr übersprungen.)
      const persisted = marketValueStore ? (await marketValueStore.listSolarMarketValuesForYear?.({ year }) || null) : null;
      if (marketValueStore && !needsRefresh({ year, persisted, nowValue: nowIso() })) continue;

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
