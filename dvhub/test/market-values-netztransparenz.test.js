// test/market-values-netztransparenz.test.js -- Monatsmarktwert Solar aus der
// amtlichen Quelle (Chrissi 21.10.2026: „kannst du die Quelle ändern“).
//
// Energy-Charts hatte am 21.10. für 2026 erst Jan–Aug und für Mai 3,163 statt
// des amtlichen 3,296 ct/kWh. netztransparenz.de (Übertragungsnetzbetreiber)
// hatte September seit 09.10. Jetzt: netztransparenz zuerst, Energy-Charts nur
// als Rückfall und für den Jahresmarktwert. Testdaten aus der echten Antwort.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchNetztransparenzSolarMarketValues,
  fetchSolarMarketValues,
  createEnergyChartsMarketValueService,
} from '../energy-charts-market-values.js';

const NT_URL = 'https://www.netztransparenz.de/DesktopModules/LotesCharts/Services/HighchartService.asmx/GetMarketpremiumData';
const OFFICIAL_2026 = [11.019, 7.717, 5.455, 1.317, 3.296, 6.19, 5.226, 6.359, 8.177];

function ntBody(year, solar) {
  const rows = ['Monat;Spotmarktpreis;MW Wind an Land;MW Wind auf See;MW Solar;MW'];
  for (let m = 0; m < 12; m++) {
    const ts = Date.UTC(year, m, 1);
    rows.push(solar[m] == null ? `${ts};;;;;` : `${ts};10.000;9.000;9.500;${solar[m].toFixed(3)};10.000`);
  }
  return { d: JSON.stringify({ chartData: rows.join('\r\n'), LastUpdated: '2026-10-09T08:51:17+02:00' }) };
}

function ecMonthly(values) {
  return [{ name: [{ de: 'Spotmarktpreis' }], xAxisValues: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], data: [1, 2, 3] },
    { name: [{ de: 'Marktwert Solar', en: 'Market value solar' }], data: values }];
}
const EC_ANNUAL = [{ name: [{ de: 'Jahresmarktwert Solar (JW Solar)' }], xAxisValues: [2024, 2025], data: [4.624, 4.508] }];

function fakeFetch({ nt = 'ok', ec = 'ok', ntSolar = OFFICIAL_2026 } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    if (String(url) === NT_URL) {
      if (nt === 'fail') throw new Error('ECONNRESET');
      if (nt === '500') return { ok: false, status: 500, json: async () => ({}) };
      const year = Number(/'dateFrom':'(\d{4})-01-01/.exec(opts.body || '')?.[1]);
      return { ok: true, status: 200, json: async () => ntBody(year, ntSolar) };
    }
    if (ec === 'fail') throw new Error('ENOTFOUND');
    if (String(url).includes('month_cent_kwh_')) return { ok: true, json: async () => ecMonthly([11.019, 7.717, 5.455, 1.317, 3.163, 6.19, 5.226, 6.359]) };
    if (String(url).includes('year_cent_kwh')) return { ok: true, json: async () => EC_ANNUAL };
    throw new Error(`unerwartete URL ${url}`);
  };
  return { impl, calls };
}

test('netztransparenz: POST an die ASMX-Schnittstelle, MW Solar je Monat, leere Monate fehlen', async () => {
  const f = fakeFetch();
  const r = await fetchNetztransparenzSolarMarketValues({ year: 2026, fetchImpl: f.impl });
  assert.equal(f.calls[0].url, NT_URL);
  assert.equal(f.calls[0].method, 'POST');
  assert.match(f.calls[0].body, /'dateFrom':'2026-01-01T00:00:00'/);
  assert.equal(r.monthlyCtKwhByMonth['2026-05'], 3.296);
  assert.equal(r.monthlyCtKwhByMonth['2026-09'], 8.177);
  assert.equal(r.monthlyCtKwhByMonth['2026-10'], undefined);
  assert.equal(Object.keys(r.monthlyCtKwhByMonth).length, 9);
});

test('beide Quellen: amtlicher Wert gewinnt (Mai korrigiert, September da), Jahreswert von Energy-Charts', async () => {
  const r = await fetchSolarMarketValues({ year: 2026, fetchImpl: fakeFetch().impl });
  assert.equal(r.monthlyCtKwhByMonth['2026-05'], 3.296);
  assert.equal(r.monthlyCtKwhByMonth['2026-09'], 8.177);
  assert.equal(r.monthlySourceByMonth['2026-05'], 'netztransparenz');
  assert.equal(r.annualCtKwhByYear[2025], 4.508);
  assert.equal(r.official, true);
});

test('netztransparenz nicht erreichbar oder Fehler: Rückfall auf Energy-Charts', async () => {
  for (const nt of ['fail', '500']) {
    const r = await fetchSolarMarketValues({ year: 2026, fetchImpl: fakeFetch({ nt }).impl });
    assert.equal(r.monthlyCtKwhByMonth['2026-05'], 3.163, nt);
    assert.equal(r.monthlySourceByMonth['2026-05'], 'energy_charts');
    assert.equal(r.official, false);
  }
});

test('Energy-Charts weg: Monate trotzdem amtlich, Jahreswert fehlt', async () => {
  const r = await fetchSolarMarketValues({ year: 2026, fetchImpl: fakeFetch({ ec: 'fail' }).impl });
  assert.equal(r.monthlyCtKwhByMonth['2026-09'], 8.177);
  assert.deepEqual(r.annualCtKwhByYear, {});
});

test('beide weg: Fehler', async () => {
  await assert.rejects(fetchSolarMarketValues({ year: 2026, fetchImpl: fakeFetch({ nt: 'fail', ec: 'fail' }).impl }));
});

// Speicher-Attrappe mit derselben Schnittstelle wie telemetry-store(-pg).
function fakeStore(initial = {}) {
  const rows = new Map(Object.entries(initial.rows || {}));
  const attempts = new Map(Object.entries(initial.attempts || {}));
  return {
    rows, attempts,
    async upsertSolarMarketValue(e) { rows.set(`${e.scope}:${e.key}`, { ctKwh: e.ctKwh, source: e.source }); },
    async markSolarMarketValueAttempt(e) { attempts.set(String(e.year), { lastAttemptAt: e.attemptedAt, status: e.status, cooldownUntil: e.cooldownUntil }); },
    async listSolarMarketValuesForYear({ year }) {
      const summary = { monthlyCtKwhByMonth: {}, annualCtKwhByYear: {} };
      for (const [k, v] of rows) {
        const [scope, key] = k.split(':');
        if (scope === 'monthly' && key.startsWith(`${year}-`)) summary.monthlyCtKwhByMonth[key] = v.ctKwh;
        if (scope === 'annual' && Number(key) <= year) summary.annualCtKwhByYear[key] = v.ctKwh;
      }
      const n = Object.keys(summary.monthlyCtKwhByMonth).length;
      const attempt = attempts.get(String(year)) || null;
      return { hasAny: n > 0, hasComplete: n === 12 && summary.annualCtKwhByYear[year] != null, summary, cooldownUntil: attempt?.cooldownUntil || null, attempt };
    },
    async hasCompleteSolarMarketValueYear({ year }) { return (await this.listSolarMarketValuesForYear({ year })).hasComplete; },
  };
}

test('Dienst speichert amtliche Werte mit Quelle und überschreibt den alten Mai-Wert', async () => {
  const store = fakeStore({ rows: { 'monthly:2026-05': { ctKwh: 3.163, source: 'energy_charts' } },
    attempts: { 2026: { lastAttemptAt: '2026-10-20T02:00:00Z', status: 'ready' } } });
  const svc = createEnergyChartsMarketValueService({ fetchImpl: fakeFetch().impl, marketValueStore: store, nowIso: () => '2026-10-21T12:00:00Z' });
  const s = await svc.getSolarMarketValueSummary({ year: 2026 });
  assert.equal(s.monthlyCtKwhByMonth['2026-09'], 8.177);
  assert.deepEqual(store.rows.get('monthly:2026-05'), { ctKwh: 3.296, source: 'netztransparenz' });
  assert.equal(store.attempts.get('2026').status, 'official');
});

function completeYear(year, source, status) {
  const rows = {};
  for (let m = 1; m <= 12; m++) rows[`monthly:${year}-${String(m).padStart(2, '0')}`] = { ctKwh: 5, source };
  rows[`annual:${year}`] = { ctKwh: 4.508, source: 'energy_charts' };
  return { rows, attempts: { [year]: { lastAttemptAt: '2026-03-11T11:23:28Z', status } } };
}

test('abgeschlossenes Jahr nur von Energy-Charts: einmal amtlich nachholen, danach nicht mehr', async () => {
  const store = fakeStore(completeYear(2025, 'energy_charts', 'ready'));
  const f = fakeFetch({ ntSolar: Array(12).fill(5.5) });
  const svc = createEnergyChartsMarketValueService({ fetchImpl: f.impl, marketValueStore: store, nowIso: () => '2026-10-21T12:00:00Z' });
  await svc.getSolarMarketValueSummary({ year: 2025 });
  assert.equal(store.rows.get('monthly:2025-06').source, 'netztransparenz');
  const n = f.calls.length;
  await svc.getSolarMarketValueSummary({ year: 2025 });
  assert.equal(f.calls.length, n, 'amtlich vorhanden → keine weitere Anfrage');
});

test('Nachholen für alte Jahre läuft auch über den Hintergrund-Abgleich', async () => {
  const store = fakeStore(completeYear(2024, 'energy_charts', 'ready'));
  const f = fakeFetch({ ntSolar: Array(12).fill(6.1) });
  const svc = createEnergyChartsMarketValueService({ fetchImpl: f.impl, marketValueStore: store, nowIso: () => '2026-10-21T12:00:00Z' });
  const r = await svc.backfillMissingSolarMarketValues({ years: [2024], waitImpl: async () => {} });
  assert.deepEqual(r.requestedYears, [2024]);
  assert.equal(store.rows.get('monthly:2024-01').source, 'netztransparenz');
});

// Zentral (Chrissi 21.10.2026): dvhub.online liefert amtliche Monate, JW Solar
// und den laufenden deutschlandweiten Jahreswert; die Box rechnet nicht selbst.
const CENTRAL = 'https://dvhub.online';
function centralFetch({ central = 'ok' } = {}) {
  const base = fakeFetch();
  const calls = base.calls;
  const impl = async (url, opts = {}) => {
    if (String(url).startsWith(`${CENTRAL}/v1/pv/solar-market-values`)) {
      calls.push({ url: String(url), method: 'GET' });
      if (central === 'fail') throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({
        year: 2026,
        monthlyCtKwhByMonth: Object.fromEntries(OFFICIAL_2026.map((v, i) => [`2026-${String(i + 1).padStart(2, '0')}`, v])),
        monthlySource: 'netztransparenz',
        annualCtKwh: null,
        annualCtKwhByYear: { 2024: 4.624, 2025: 4.508 },
        runningAnnualCtKwh: 5.301,
        runningMonths: 9,
        weighting: 'national_solar_generation',
      }) };
    }
    return base.impl(url, opts);
  };
  return { impl, calls };
}

test('zentral: eine Anfrage an dvhub.online, keine direkten Quellen', async () => {
  const f = centralFetch();
  const r = await fetchSolarMarketValues({ year: 2026, fetchImpl: f.impl, centralBaseUrl: CENTRAL });
  assert.deepEqual(f.calls.map((c) => c.url), [`${CENTRAL}/v1/pv/solar-market-values?year=2026`]);
  assert.equal(r.monthlyCtKwhByMonth['2026-09'], 8.177);
  assert.equal(r.runningAnnualCtKwh, 5.301);
  assert.equal(r.annualCtKwhByYear[2025], 4.508);
  assert.equal(r.official, true);
});

test('dvhub.online nicht erreichbar: direkt von netztransparenz/Energy-Charts, ohne laufenden Wert', async () => {
  const r = await fetchSolarMarketValues({ year: 2026, fetchImpl: centralFetch({ central: 'fail' }).impl, centralBaseUrl: CENTRAL });
  assert.equal(r.monthlyCtKwhByMonth['2026-09'], 8.177);
  assert.equal(r.runningAnnualCtKwh, null);
});

test('Dienst speichert den laufenden Jahreswert und gibt ihn zurück', async () => {
  const store = fakeStore();
  store.upsertSolarMarketValue = async (e) => { store.rows.set(`${e.scope}:${e.key}`, { ctKwh: e.ctKwh, source: e.source }); };
  const svc = createEnergyChartsMarketValueService({ fetchImpl: centralFetch().impl, marketValueStore: store,
    nowIso: () => '2026-10-21T12:00:00Z', getCentralBaseUrl: () => CENTRAL });
  const s = await svc.getSolarMarketValueSummary({ year: 2026 });
  assert.equal(s.runningAnnualCtKwh, 5.301);
  assert.deepEqual(store.rows.get('running:2026'), { ctKwh: 5.301, source: 'dvhub_online' });
});
