// LUOX-Dienst (services/tariff-provider/luox-service.js): Day-Ahead (Partner-API
// vor Portal), Endkundenpreis hinter der Einstellung, Sperre nach abgelehnten
// Zugangsdaten, Vertragsauswahl, täglicher Direktvermarktungs-Abgleich und
// Bericht. Portal und Partner-API sind nachgebaut; alle Daten erfunden.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createLuoxService, settlementDue, energyDataCategory } from '../services/tariff-provider/luox-service.js';
import { TariffProviderError } from '../services/tariff-provider/common.js';
import { buildXlsx } from './helpers/xlsx-build.js';

const PRODUCTS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'luox', 'products-dynamisch.json'), 'utf8'));
const NOW = Date.parse('2026-11-11T13:30:00Z'); // 14:30 Ortszeit

function naiveSeries(dateLocal, n, price) {
  return Array.from({ length: n }, (_, i) => {
    const h = String(Math.floor(i / 4)).padStart(2, '0');
    const m = String((i % 4) * 15).padStart(2, '0');
    return { start_time: `${dateLocal}T${h}:${m}:00`, end_time: null, price: price(i) };
  });
}

const CONTRACTS = {
  saas_customer_id: '90000001', first_name: 'Erika', username: 'kundin@example.invalid',
  consumer_delivering_points: [{ saas_contract_id: 'C90000001-1', deliv_status: 'not_delivering', tariff_type: 'lumenaza_slp_spot_household_generic', timeseries_category: null, iban: 'DE00' }],
  producer_delivering_points: [{ saas_contract_id: 'P90000001-1', deliv_status: 'delivering', tariff_type: 'lumenaza_producer_dv_spot_generic', timeseries_category: 'SOL', meter_id: '1ABC' }]
};

function fakePortal({ fail = null } = {}) {
  const calls = [];
  const client = {
    async getJson(p) {
      calls.push(p);
      if (fail) throw fail;
      if (p === 'contracts') return CONTRACTS;
      if (p === 'epex_price_today/') return { today_data: naiveSeries('2026-11-11', 96, (i) => 100 + i), tomorrow_data: naiveSeries('2026-11-12', 96, () => -20), current_price: null };
      if (p.startsWith('products/')) return PRODUCTS;
      if (p.startsWith('energy_data/')) {
        return [
          { start: '2026-11-03T00:00:00Z', end: '2026-11-03T23:00:00Z', feed: 999 },
          { start: '2026-11-03T23:00:00Z', end: '2026-11-04T23:00:00Z', feed: 4200 },
          { start: '2026-11-04T23:00:00Z', end: '2026-11-05T23:00:00Z', feed: 3100 },
          { start: '2026-11-10T23:00:00Z', end: '2026-11-11T00:00:00Z', feed: 7 }
        ];
      }
      throw new Error(`unerwartet ${p}`);
    },
    async getBinary(p) {
      calls.push(p);
      if (fail) throw fail;
      // 2026-11-04 12:00 und 12:15 Ortszeit (Excel-Datumszahl)
      return buildXlsx([
        ['Zeitstempel', 'Einspeisung Messwerte (Wh)', 'DayAHead-Auktions Preis (€/MWh)', 'Vergütung (EUR)'],
        [46330.5, 800, 90, 0.072],
        [46330.5 + 1 / 96, 600, 100, 0.06]
      ]);
    }
  };
  const factory = (settings, opts) => { factory.created.push({ settings, opts }); return client; };
  factory.created = [];
  factory.calls = calls;
  return factory;
}

function fakePartner({ fail = null } = {}) {
  const calls = [];
  const client = {
    async epexDayAhead(q) {
      calls.push(['epex', q]);
      if (fail) throw fail;
      const start = Date.parse(q.from);
      return Array.from({ length: 192 }, (_, i) => ({ ts: start + i * 900_000, durationMs: 900_000, eurMwh: 50, ctKwh: 5 }));
    },
    async producerFeed(q) { calls.push(['feed', q]); return [{ ts: Date.parse('2026-11-04T11:00:00Z'), durationMs: 900_000, wh: 801 }]; }
  };
  const factory = () => client;
  factory.calls = calls;
  return factory;
}

function makeCtx(luox = {}, extra = {}) {
  const written = [];
  const logs = [];
  let cfg = {
    luox: {
      email: 'kundin@example.invalid', password: 'pw', consumerContractId: '', producerContractId: '',
      endCustomerPrice: { enabled: false }, dvSync: { enabled: false },
      partner: { enabled: false, environment: 'prod', clientId: '', clientSecret: '', userId: '' },
      ...luox
    },
    ...extra
  };
  const ctx = {
    getCfg: () => cfg,
    setCfg: (c) => { cfg = c; },
    pushLog: (event, data, level) => logs.push({ event, data, level }),
    telemetrySafeWrite: (fn) => Promise.resolve(fn()).then(() => true),
    telemetryStore: { writeSamples: async (rows) => { written.push(...rows); } }
  };
  return { ctx, written, logs };
}

test('Day-Ahead aus dem Portal: 96 + 96, Quelle und Stand im Zustand', async () => {
  const portal = fakePortal();
  const { ctx } = makeCtx();
  const svc = createLuoxService(ctx, { now: () => NOW, portalFactory: portal, partnerFactory: fakePartner() });
  const r = await svc.fetchDayAhead();
  assert.equal(r.source, 'luox_portal');
  assert.equal(r.rows.length, 192);
  assert.equal(r.tomorrowCount, 96);
  assert.equal(r.rows[0].ts, Date.parse('2026-11-10T23:00:00Z'));
  const st = svc.getState();
  assert.equal(st.dayAhead.source, 'luox_portal');
  assert.equal(st.dayAhead.tomorrowCount, 96);
  assert.ok(st.dayAhead.lastSuccessAt);
  assert.equal(portal.created[0].opts.useCache, true);
});

test('Partner-API eingeschaltet und Zugangsdaten da: sie geht vor; scheitert sie, springt das Portal ein', async () => {
  const portal = fakePortal();
  const partner = fakePartner();
  const { ctx } = makeCtx({ partner: { enabled: true, environment: 'test', clientId: 'id', clientSecret: 'sec', userId: 'u1' } });
  const svc = createLuoxService(ctx, { now: () => NOW, portalFactory: portal, partnerFactory: partner });
  const r = await svc.fetchDayAhead();
  assert.equal(r.source, 'luox_partner');
  assert.equal(partner.calls[0][1].from, '2026-11-10T23:00:00.000Z', 'von Ortsmitternacht heute (UTC)');
  assert.equal(partner.calls[0][1].to, '2026-11-12T23:00:00.000Z', 'bis Ortsmitternacht übermorgen');
  assert.equal(portal.calls.length, 0);

  const failing = fakePartner({ fail: new TariffProviderError('network', 'Lumenaza-Partner-API nicht erreichbar.') });
  const svc2 = createLuoxService(ctx, { now: () => NOW, portalFactory: portal, partnerFactory: failing });
  const r2 = await svc2.fetchDayAhead();
  assert.equal(r2.source, 'luox_portal');
  assert.match(svc2.getState().partner.error, /nicht erreichbar/);
});

test('Partner-API eingeschaltet ohne Zugangsdaten: Portal, ohne Partner-Abruf', async () => {
  const portal = fakePortal();
  const partner = fakePartner();
  const { ctx } = makeCtx({ partner: { enabled: true, clientId: '', clientSecret: '' } });
  const r = await createLuoxService(ctx, { now: () => NOW, portalFactory: portal, partnerFactory: partner }).fetchDayAhead();
  assert.equal(r.source, 'luox_portal');
  assert.equal(partner.calls.length, 0);
});

test('Ohne Zugangsdaten: not_configured, kein Abruf', async () => {
  const portal = fakePortal();
  const { ctx } = makeCtx({ email: '', password: '' });
  await assert.rejects(createLuoxService(ctx, { now: () => NOW, portalFactory: portal }).fetchDayAhead(), (e) => e.code === 'not_configured');
  assert.equal(portal.calls.length, 0);
});

test('Abgelehnte Zugangsdaten sperren 6 h (Konto-Schutz); neue Zugangsdaten heben die Sperre auf', async () => {
  let t = NOW;
  const bad = fakePortal({ fail: new TariffProviderError('auth', 'LUOX-Anmeldung abgelehnt (HTTP 400).') });
  const { ctx } = makeCtx();
  const svc = createLuoxService(ctx, { now: () => t, portalFactory: bad });
  await assert.rejects(svc.fetchDayAhead(), (e) => e.code === 'auth');
  const n = bad.calls.length;
  t += 60 * 60_000;
  await assert.rejects(svc.fetchDayAhead(), (e) => e.code === 'auth_blocked');
  assert.equal(bad.calls.length, n, 'gesperrt: kein weiterer Anmeldeversuch');
  assert.ok(svc.getState().authBlockedUntil);
  ctx.setCfg({ ...ctx.getCfg(), luox: { ...ctx.getCfg().luox, password: 'neu' } });
  await assert.rejects(svc.fetchDayAhead(), (e) => e.code === 'auth', 'neuer Versuch mit neuen Zugangsdaten');
  t += 7 * 60 * 60_000;
});

test('Anbieterpreis „nur Energie netto“: Spot in ct/kWh je Viertelstunde', async () => {
  const { ctx } = makeCtx();
  const r = await createLuoxService(ctx, { now: () => NOW, portalFactory: fakePortal() }).fetchTariffSlots({ priceBasis: 'net_energy' });
  assert.equal(r.provider, 'luox');
  assert.equal(r.slots.length, 192);
  assert.equal(r.slots[0].ctKwh, 10);
  assert.equal(r.slots[96].ctKwh, -2);
});

test('Endpreis brutto: nur mit eingeschalteter Einstellung; dann (Spot + 3 %) × MwSt + Bestandteile', async () => {
  const off = makeCtx();
  await assert.rejects(createLuoxService(off.ctx, { now: () => NOW, portalFactory: fakePortal() }).fetchTariffSlots({ priceBasis: 'gross_total' }),
    (e) => e.code === 'not_enabled' && /vorbereitet/.test(e.message));

  const portal = fakePortal();
  const on = makeCtx({ endCustomerPrice: { enabled: true } });
  const r = await createLuoxService(on.ctx, { now: () => NOW, portalFactory: portal }).fetchTariffSlots({ priceBasis: 'gross_total' });
  assert.ok(portal.calls.includes('products/C90000001-1/2026-11-11/2026-11-11'), 'Produkt des Stromliefervertrags, heutiger Tag');
  const fixedGross = 17.35734 + 0.42;
  assert.ok(Math.abs(r.slots[0].ctKwh - ((10 + 0.3) * 1.19 + fixedGross)) < 1e-3, String(r.slots[0].ctKwh));
  assert.ok(Math.abs(r.slots[96].ctKwh - ((-2 + 0.06) * 1.19 + fixedGross)) < 1e-3, 'morgen mit den heutigen Bestandteilen');
  assert.equal(r.account.label, 'LUOX Dynamisch');
  assert.equal(r.account.unverified, true);
});

test('Verträge für die Auswahl: Nummer + Status, ohne Kundendaten', async () => {
  const { ctx } = makeCtx();
  const svc = createLuoxService(ctx, { now: () => NOW, portalFactory: fakePortal() });
  const r = await svc.listContracts({ kind: 'producer' });
  assert.deepEqual(r.options.map((o) => o.value), ['', 'P90000001-1']);
  assert.match(r.options[1].label, /delivering/);
  const text = JSON.stringify(r);
  for (const s of ['Erika', 'kundin@', 'DE00', '1ABC']) assert.ok(!text.includes(s), s);
});

test('Zeitreihen-Kategorie im Pfad: LGS bleibt, alles andere (z. B. SOL) = other_then_LGS', () => {
  assert.equal(energyDataCategory('LGS'), 'LGS');
  assert.equal(energyDataCategory('SOL'), 'other_then_LGS');
  assert.equal(energyDataCategory(null), 'other_then_LGS');
});

test('Abgleich fällig: einmal täglich ab 10 Uhr, nach Fehlern höchstens stündlich, nur eingeschaltet', () => {
  const base = { enabled: true, todayLocal: '2026-11-11', minuteOfDay: 11 * 60, lastSuccessDate: null, lastAttemptMs: 0, nowMs: NOW };
  assert.equal(settlementDue(base), true);
  assert.equal(settlementDue({ ...base, enabled: false }), false);
  assert.equal(settlementDue({ ...base, minuteOfDay: 9 * 60 }), false);
  assert.equal(settlementDue({ ...base, lastSuccessDate: '2026-11-11' }), false);
  assert.equal(settlementDue({ ...base, lastAttemptMs: NOW - 30 * 60_000 }), false);
  assert.equal(settlementDue({ ...base, lastAttemptMs: NOW - 61 * 60_000 }), true);
});

test('Direktvermarktungs-Abgleich: Abrechnungs-XLSX und Tagessummen in die Datenbank (nur lesen, Erzeugervertrag)', async () => {
  const portal = fakePortal();
  const { ctx, written } = makeCtx({ dvSync: { enabled: true } });
  const svc = createLuoxService(ctx, { now: () => NOW, portalFactory: portal });
  const r = await svc.syncSettlement({ days: 7 });
  assert.equal(r.ok, true);
  assert.ok(portal.calls.includes('epex_price/P90000001-1/2026-11-04/2026-11-10/producer/'), portal.calls.join(' '));
  assert.ok(portal.calls.includes('energy_data/P90000001-1/prod/other_then_LGS/day/2026-11-03/2026-11-11/'));
  const byKey = (k) => written.filter((w) => w.seriesKey === k);
  assert.equal(byKey('luox_settlement_feed_wh').length, 2);
  assert.deepEqual(byKey('luox_settlement_feed_wh')[0], {
    seriesKey: 'luox_settlement_feed_wh', scope: 'settlement', source: 'luox', quality: 'raw',
    ts: '2026-11-04T11:00:00.000Z', resolutionSeconds: 900, value: 800, unit: 'Wh', meta: { contract: 'producer' }
  });
  assert.equal(byKey('luox_settlement_revenue_eur')[1].value, 0.06);
  assert.equal(byKey('luox_settlement_price_eur_mwh')[0].value, 90);
  // Nur volle Ortstage (Ortsmitternacht bis Ortsmitternacht): 04. und 05.11.
  assert.deepEqual(byKey('luox_feed_daily_wh').map((w) => [w.ts, w.value, w.resolutionSeconds]), [
    ['2026-11-03T23:00:00.000Z', 4200, 86400], ['2026-11-04T23:00:00.000Z', 3100, 86400]
  ]);
  const st = svc.getState().settlement;
  assert.equal(st.ok, true);
  assert.equal(st.rows, 2);
  assert.equal(st.totals.feedKwh, 1.4);
});

test('Abgleich ausgeschaltet oder ohne Erzeugervertrag: nichts abrufen', async () => {
  const portal = fakePortal();
  const { ctx } = makeCtx();
  const r = await createLuoxService(ctx, { now: () => NOW, portalFactory: portal }).syncSettlement();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_enabled');
  assert.equal(portal.calls.length, 0);
});

test('Bericht je Tag: LUOX-Einspeisung/Vergütung neben DVhubs eigener Einspeisung × Day-Ahead', async () => {
  const { ctx } = makeCtx({ dvSync: { enabled: true } });
  const samples = {
    luox_settlement_feed_wh: [{ ts: '2026-11-04T11:00:00.000Z', value: 800 }, { ts: '2026-11-04T11:15:00.000Z', value: 600 }],
    luox_settlement_revenue_eur: [{ ts: '2026-11-04T11:00:00.000Z', value: 0.072 }, { ts: '2026-11-04T11:15:00.000Z', value: 0.06 }],
    luox_feed_daily_wh: [{ ts: '2026-11-03T23:00:00.000Z', value: 4200 }]
  };
  ctx.telemetryStore = {
    listSeriesSamples: async ({ seriesKey }) => (samples[seriesKey] || []).map((s) => ({ ...s, source: 'luox', resolutionSeconds: 900 })),
    listMaterializedEnergySlots: async () => [{ ts: '2026-11-04T11:00:00.000Z', exportKwh: 0.75 }, { ts: '2026-11-04T11:15:00.000Z', exportKwh: 0.65 }],
    listPriceSlots: async () => [{ ts: '2026-11-04T11:00:00.000Z', priceCtKwh: 9 }, { ts: '2026-11-04T11:15:00.000Z', priceCtKwh: 10 }]
  };
  const r = await createLuoxService(ctx, { now: () => NOW }).settlementReport({ days: 14 });
  assert.equal(r.ok, true);
  const day = r.days.find((d) => d.date === '2026-11-04');
  assert.equal(day.luoxFeedKwh, 1.4);
  assert.equal(day.luoxRevenueEur, 0.132);
  assert.equal(day.luoxPortalDayKwh, 4.2);
  assert.equal(day.dvhubExportKwh, 1.4);
  assert.equal(day.dvhubRevenueEur, 0.1325);
  assert.equal(r.totals.luoxFeedKwh, 1.4);
});

test('Zustand enthält keine Zugangsdaten', async () => {
  const { ctx } = makeCtx({ partner: { enabled: true, clientId: 'cid-geheim', clientSecret: 'sec-geheim', userId: 'u' } });
  const svc = createLuoxService(ctx, { now: () => NOW, portalFactory: fakePortal(), partnerFactory: fakePartner() });
  await svc.fetchDayAhead();
  const text = JSON.stringify(svc.getState());
  for (const s of ['kundin@', '"pw"', 'cid-geheim', 'sec-geheim']) assert.ok(!text.includes(s), s);
  assert.equal(svc.getState().portal.configured, true);
  assert.equal(svc.getState().partner.configured, true);
  assert.match(svc.getState().notice, /inoffizielle/);
});

test('Verbindungstest: gespeicherte Zugangsdaten per ***, fremde ohne Token-Speicher, höchstens alle 10 s', async () => {
  let t = NOW;
  const portal = fakePortal();
  const { ctx } = makeCtx();
  const svc = createLuoxService(ctx, { now: () => t, portalFactory: portal, partnerFactory: fakePartner() });
  const a = await svc.test({ email: '***', password: '***' });
  assert.equal(a.ok, true);
  assert.equal(a.contracts.length, 2);
  assert.equal(portal.created.at(-1).opts.useCache, true);
  const b = await svc.test({ email: 'andere@example.invalid', password: 'x' });
  assert.equal(b.code, 'too_fast');
  t += 11_000;
  await svc.test({ email: 'andere@example.invalid', password: 'x' });
  assert.equal(portal.created.at(-1).opts.useCache, false);
  assert.equal(portal.created.at(-1).settings.email, 'andere@example.invalid');
});
