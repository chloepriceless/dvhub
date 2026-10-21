// Dienst „Preis vom Stromanbieter“ (services/tariff-provider/index.js): Takt,
// Sperre nach abgelehnten Zugangsdaten, Ablage, Neustart, EOS-Anstoß.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTariffProviderService, fetchDue, mergeTestSettings, SERIES_KEY } from '../services/tariff-provider/index.js';
import { clearProviderPrices, providerSlotAt, whenProviderPricesLoaded } from '../services/tariff-provider/price-store.js';
import { TariffProviderError, localMidnight } from '../services/tariff-provider/common.js';

const HOUR = 3_600_000;

function dayPrices(date, ct = 25) {
  const start = localMidnight(date).ms;
  return Array.from({ length: 96 }, (_, i) => ({ ts: start + i * 900_000, ctKwh: ct + i / 100, durationMs: 900_000 }));
}

function makeCtx(cfgOverride = {}) {
  const written = [];
  const logs = [];
  const ctx = {
    state: { epex: { data: [] } },
    getCfg: () => ({
      userEnergyPricing: {
        mode: 'provider',
        provider: { name: 'lichtblick', priceBasis: 'gross_total', lichtblick: { email: 'a@b.de', password: 'pw' }, tibber: {} },
        ...cfgOverride
      }
    }),
    pushLog: (event, data) => logs.push({ event, data }),
    telemetrySafeWrite: (fn) => fn(),
    telemetryStore: { writeSamples: async (rows) => { written.push(...rows); } },
    eosForecastBridge: { pushes: 0, push: async () => { ctx.eosForecastBridge.pushes += 1; } },
    optimizerService: { replans: [], requestEosReplanIfSparse: (r) => ctx.optimizerService.replans.push(r) }
  };
  return { ctx, written, logs };
}

test.beforeEach(() => clearProviderPrices());

test('fetchDue: stündlich, morgen-Lücke nach Veröffentlichung alle 15 min, Wartezeit nach Fehlern, Sperre', () => {
  const base = { nowMs: 10 * HOUR, lastAttemptMs: 0, lastSuccessMs: 0, failures: 0, authBlockedUntilMs: 0, hasTomorrow: true, minuteOfDay: 600, publishMinute: 920 };
  assert.equal(fetchDue(base), true, 'nie abgerufen');
  const fresh = { ...base, lastAttemptMs: 9.5 * HOUR, lastSuccessMs: 9.5 * HOUR };
  assert.equal(fetchDue(fresh), false);
  assert.equal(fetchDue({ ...fresh, nowMs: 10.5 * HOUR }), true, 'nach einer Stunde');
  assert.equal(fetchDue({ ...fresh, hasTomorrow: false }), false, 'vor 15:20 nicht öfter');
  assert.equal(fetchDue({ ...fresh, hasTomorrow: false, minuteOfDay: 930 }), true, 'ab Veröffentlichung, letzter Versuch ≥ 15 min her');
  assert.equal(fetchDue({ ...fresh, hasTomorrow: false, minuteOfDay: 930, lastAttemptMs: 10 * HOUR - 60_000 }), false);
  assert.equal(fetchDue({ ...base, failures: 1, lastAttemptMs: 10 * HOUR - 4 * 60_000 }), false, '1. Fehler: 5 min');
  assert.equal(fetchDue({ ...base, failures: 1, lastAttemptMs: 10 * HOUR - 5 * 60_000 }), true);
  assert.equal(fetchDue({ ...base, failures: 9, lastAttemptMs: 10 * HOUR - 59 * 60_000 }), false, 'höchstens 60 min');
  assert.equal(fetchDue({ ...base, authBlockedUntilMs: 11 * HOUR }), false, 'Sperre');
});

test('Abruf: Preise in Speicher und Datenbank, EOS einmal angestoßen, wenn morgen ankommt', async () => {
  let now = Date.parse('2026-11-01T14:30:00Z'); // 15:30 Berlin
  const { ctx, written } = makeCtx();
  let withTomorrow = false;
  const svc = createTariffProviderService(ctx, {
    now: () => now,
    fetchLichtblick: async () => ({
      provider: 'lichtblick', account: { contractId: 1, label: 'ÖkoStrom Dynamic' },
      slots: [...dayPrices('2026-11-01'), ...(withTomorrow ? dayPrices('2026-11-02', 20) : [])]
    })
  });
  await svc.tick();
  assert.equal(written.length, 96);
  assert.deepEqual(
    { k: written[0].seriesKey, scope: written[0].scope, source: written[0].source, res: written[0].resolutionSeconds, unit: written[0].unit },
    { k: SERIES_KEY, scope: 'tariff', source: 'lichtblick', res: 900, unit: 'ct/kWh' }
  );
  assert.equal(providerSlotAt(Date.parse('2026-11-01T14:30:00Z')).ctKwh, 25 + 62 / 100);
  assert.equal(ctx.eosForecastBridge.pushes, 0, 'heute allein ist kein neuer Tag');
  assert.equal(svc.getState().hasTomorrow, false);

  withTomorrow = true;
  now += 16 * 60_000; // morgen fehlt, nach 15:20 → nach 15 min erneut
  await svc.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.getState().hasTomorrow, true);
  assert.equal(svc.getState().summary.tomorrowSlots, 96);
  assert.equal(ctx.eosForecastBridge.pushes, 1);
  assert.deepEqual(ctx.optimizerService.replans, ['tariff']);

  now += 61 * 60_000;
  await svc.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.eosForecastBridge.pushes, 1, 'kein zweiter Anstoß');
});

test('Abgelehnte Zugangsdaten: 6 h Ruhe, neue Zugangsdaten heben die Sperre auf', async () => {
  let now = Date.parse('2026-11-01T09:00:00Z');
  let password = 'falsch';
  const { ctx } = makeCtx();
  ctx.getCfg = () => ({ userEnergyPricing: { mode: 'provider', provider: { name: 'lichtblick', lichtblick: { email: 'a@b.de', password } } } });
  let calls = 0;
  const svc = createTariffProviderService(ctx, {
    now: () => now,
    fetchLichtblick: async (s) => {
      calls += 1;
      if (s.lichtblick.password !== 'richtig') throw new TariffProviderError('auth', 'LichtBlick-Anmeldung abgelehnt (invalid_grant).');
      return { provider: 'lichtblick', account: null, slots: dayPrices('2026-11-01') };
    }
  });
  await svc.tick();
  assert.equal(calls, 1);
  assert.equal(svc.getState().errorCode, 'auth');
  assert.ok(svc.getState().authBlockedUntil);
  now += 5 * HOUR;
  await svc.tick();
  assert.equal(calls, 1, 'innerhalb der Sperre kein Versuch');
  assert.equal((await svc.refresh()).code, 'auth_blocked', 'auch der Knopf respektiert die Sperre');
  password = 'richtig';
  await svc.tick();
  assert.equal(calls, 2);
  assert.equal(svc.getState().ok, true);
  assert.equal(svc.getState().authBlockedUntil, null);
});

test('Ruhe ohne Anbieter-Modus oder ohne Zugangsdaten', async () => {
  let calls = 0;
  const fetchLichtblick = async () => { calls += 1; return { slots: [] }; };
  const a = makeCtx({ mode: 'fixed' });
  await createTariffProviderService(a.ctx, { fetchLichtblick }).tick();
  const b = makeCtx({ provider: { name: 'lichtblick', lichtblick: { email: 'a@b.de', password: '' } } });
  await createTariffProviderService(b.ctx, { fetchLichtblick }).tick();
  assert.equal(calls, 0);
});

test('Vor dem Lieferbeginn: leere Antwort ist kein Fehler, aber sichtbar', async () => {
  const { ctx } = makeCtx();
  const svc = createTariffProviderService(ctx, { now: () => Date.parse('2026-10-22T10:00:00Z'), fetchLichtblick: async () => ({ provider: 'lichtblick', account: null, slots: [] }) });
  await svc.tick();
  const st = svc.getState();
  assert.equal(st.ok, true);
  assert.equal(st.errorCode, 'no_prices');
  assert.match(st.error, /Lieferbeginn/);
});

test('Tibber-Konto mit beendetem Vertrag: Hinweis nennt den Status', async () => {
  const { ctx } = makeCtx({ provider: { name: 'tibber', tibber: { token: 't' } } });
  const svc = createTariffProviderService(ctx, { fetchTibber: async () => ({ provider: 'tibber', account: { homeId: 'h', status: 'ended' }, slots: [] }) });
  await svc.tick();
  assert.match(svc.getState().error, /Vertragsstatus: ended/);
});

test('Verbindungstest mit anderen LichtBlick-Zugangsdaten lässt den Token-Zwischenspeicher in Ruhe', async () => {
  const { ctx } = makeCtx();
  const seen = [];
  const svc = createTariffProviderService(ctx, { now: (() => { let t = 0; return () => (t += 20_000); })(),
    fetchLichtblick: async (s, opts) => { seen.push(opts?.useCache); return { provider: 'lichtblick', account: null, slots: [] }; } });
  await svc.test({ name: 'lichtblick', lichtblick: { email: '***', password: '***' } });
  await svc.test({ name: 'lichtblick', lichtblick: { email: 'neu@b.de', password: 'x' } });
  assert.deepEqual(seen, [true, false]);
});

test('Neustart: gespeicherte Preise kommen aus der Datenbank zurück, die Historie wartet darauf', async () => {
  const { ctx } = makeCtx();
  let release;
  const gate = new Promise((r) => { release = r; });
  ctx.telemetryStore.listSeriesSamples = async ({ seriesKey, scope }) => {
    assert.equal(seriesKey, SERIES_KEY);
    assert.equal(scope, 'tariff');
    await gate;
    return [
      { ts: '2026-10-31T23:00:00.000Z', source: 'lichtblick', resolutionSeconds: 900, value: 31.5 },
      { ts: '2026-10-31T23:00:00.000Z', source: 'tibber', resolutionSeconds: 900, value: 99 }
    ];
  };
  const svc = createTariffProviderService(ctx, { now: () => Date.parse('2026-11-01T10:00:00Z'), fetchLichtblick: async () => ({ slots: [] }), tickMs: 3_600_000 });
  svc.start();
  let waited = false;
  const history = whenProviderPricesLoaded().then(() => { waited = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(waited, false, 'Historie wartet');
  release();
  await history;
  svc.stop();
  assert.equal(providerSlotAt(Date.parse('2026-10-31T23:05:00Z')).ctKwh, 31.5, 'eingestellter Anbieter gewinnt');
  assert.equal(svc.getState().storedFromDb, 1);
});

test('Verbindungstest: gespeicherte Geheimnisse für ***, nichts wird gespeichert', async () => {
  assert.deepEqual(mergeTestSettings(
    { name: 'lichtblick', lichtblick: { email: 'alt@b.de', password: 'altpw' }, tibber: { token: 'tok' } },
    { name: 'lichtblick', lichtblick: { email: '***', password: 'neu' } }
  ).lichtblick, { email: 'alt@b.de', password: 'neu', contractId: null });

  const { ctx, written } = makeCtx();
  let seen = null;
  const svc = createTariffProviderService(ctx, {
    fetchTibber: async (s) => { seen = s; return { provider: 'tibber', account: { homeId: 'h', label: 'Haus' }, slots: dayPrices('2026-11-01') }; }
  });
  const r = await svc.test({ name: 'tibber', tibber: { token: 'neuer-token' } });
  assert.equal(r.ok, true);
  assert.equal(seen.tibber.token, 'neuer-token');
  assert.equal(r.account.label, 'Haus');
  assert.equal(written.length, 0);
  assert.equal(providerSlotAt(localMidnight('2026-11-01').ms), null);
  assert.equal((await svc.test({ name: 'tibber', tibber: { token: 'y' } })).code, 'too_fast', 'nicht im Sekundentakt');
  const fail = await createTariffProviderService(ctx, {
    fetchTibber: async () => { throw new TariffProviderError('auth', 'Tibber lehnt den Zugangsschlüssel ab.'); }
  }).test({ name: 'tibber', tibber: { token: 'x' } });
  assert.deepEqual({ ok: fail.ok, code: fail.code }, { ok: false, code: 'auth' });
  assert.equal(JSON.stringify(fail).includes('"x"'), false, 'Schlüssel nicht im Ergebnis');
});

test('Anbieterwechsel: künftige Preise und Schätzung des alten verfallen, Vergangenes bleibt (Codex 22.10.)', async () => {
  const now = Date.parse('2026-11-01T10:20:00Z');
  let cfgProvider = { name: 'tibber', tibber: { token: 't' } };
  const { ctx } = makeCtx();
  ctx.getCfg = () => ({ userEnergyPricing: { mode: 'provider', provider: cfgProvider } });
  const svc = createTariffProviderService(ctx, {
    now: () => now,
    fetchTibber: async () => ({ provider: 'tibber', account: null, slots: dayPrices('2026-11-01', 45) }),
    fetchLichtblick: async () => ({ provider: 'lichtblick', account: null, slots: [] })
  });
  await svc.tick();
  assert.equal(providerSlotAt(Date.parse('2026-11-01T15:00:00Z')).provider, 'tibber');
  cfgProvider = { name: 'lichtblick', lichtblick: { email: 'a@b.de', password: 'pw' } };
  await svc.tick();
  assert.equal(providerSlotAt(Date.parse('2026-11-01T15:00:00Z')), null, 'künftiger Tibber-Preis gilt nicht für LichtBlick');
  assert.equal(providerSlotAt(Date.parse('2026-11-01T08:00:00Z')).provider, 'tibber', 'bezahlte Vergangenheit bleibt');
  assert.equal(providerSlotAt(Date.parse('2026-11-01T10:30:00Z')).provider, 'tibber', 'laufende Stunde bleibt');
  // neues Passwort = derselbe Vertrag: nichts verwerfen
  await svc.tick();
  cfgProvider = { name: 'lichtblick', lichtblick: { email: 'A@b.de', password: 'neu' } };
  const { putProviderSlots } = await import('../services/tariff-provider/price-store.js');
  putProviderSlots('lichtblick', [{ ts: Date.parse('2026-11-01T16:00:00Z'), ctKwh: 30, durationMs: 900_000 }]);
  await svc.tick();
  assert.equal(providerSlotAt(Date.parse('2026-11-01T16:00:00Z')).ctKwh, 30);
});

test('getrennter Web-Prozess liest neue Preise aus der Datenbank nach (Codex 22.10.)', async () => {
  const { ctx } = makeCtx();
  let calls = 0;
  ctx.telemetryStore.listSeriesSamples = async ({ start }) => {
    calls += 1;
    assert.ok(start, 'nur ein Fenster, nicht alles');
    return [
      { ts: '2026-11-02T00:00:00.000Z', source: 'lichtblick', resolutionSeconds: 900, value: 22 },
      { ts: '2026-11-02T00:00:00.000Z', source: 'tibber', resolutionSeconds: 900, value: 99 }
    ];
  };
  const svc = createTariffProviderService(ctx, { now: () => Date.parse('2026-11-01T15:00:00Z') });
  await svc.reloadRecent();
  assert.equal(calls, 1);
  assert.equal(providerSlotAt(Date.parse('2026-11-02T00:05:00Z')).ctKwh, 22);
});
