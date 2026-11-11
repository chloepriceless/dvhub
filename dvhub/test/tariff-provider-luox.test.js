// Anbieter „LUOX“ im Anbieterpreis-Dienst (services/tariff-provider/index.js):
// Zugangsdaten aus dem Block `luox`, Abruf über den LUOX-Dienst, Lesart des
// Preises geht mit, Ablage wie bei Tibber/LichtBlick. Alle Daten erfunden.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTariffProviderService, providerCredentialsComplete, mergeTestSettings, PUBLISH_MINUTE, PROVIDER_LABELS, SERIES_KEY
} from '../services/tariff-provider/index.js';
import { PROVIDER_NAMES } from '../services/tariff-provider/provider-pricing.js';
import { clearProviderPrices, providerSlotAt } from '../services/tariff-provider/price-store.js';

const LUOX = { email: 'kundin@example.invalid', password: 'pw', consumerContractId: '', endCustomerPrice: { enabled: false } };
const NOW = Date.parse('2026-11-11T13:30:00Z');

function slots(startIso, n, ct) {
  const start = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => ({ ts: start + i * 900_000, ctKwh: ct, durationMs: 900_000 }));
}

function makeCtx(provider, luox = LUOX) {
  const written = [];
  const ctx = {
    getCfg: () => ({ userEnergyPricing: { mode: 'provider', provider }, luox }),
    pushLog: () => {},
    telemetrySafeWrite: (fn) => Promise.resolve(fn()).then(() => true),
    telemetryStore: {
      writeSamples: async (rows) => { written.push(...rows); },
      listSeriesSamples: async () => []
    }
  };
  return { ctx, written };
}

test('LUOX ist ein wählbarer Anbieter mit Bezeichnung und Veröffentlichungszeit', () => {
  assert.ok(PROVIDER_NAMES.includes('luox'));
  assert.equal(PROVIDER_LABELS.luox, 'LUOX');
  assert.equal(PUBLISH_MINUTE.luox, 13 * 60 + 5, 'Day-Ahead; live 11.11.2026 um 13:59 schon da');
});

test('Zugangsdaten vollständig, wenn der LUOX-Block E-Mail und Passwort hat', () => {
  assert.equal(providerCredentialsComplete({ name: 'luox', luox: LUOX }), true);
  assert.equal(providerCredentialsComplete({ name: 'luox', luox: { email: 'a@b.c', password: '' } }), false);
  assert.equal(providerCredentialsComplete({ name: 'luox' }), false);
});

test('Verbindungstest nimmt die gespeicherten LUOX-Zugangsdaten', () => {
  const merged = mergeTestSettings({ name: 'luox', priceBasis: 'net_energy', luox: LUOX }, { name: 'luox' });
  assert.equal(merged.name, 'luox');
  assert.equal(merged.luox.email, LUOX.email);
  assert.equal(merged.priceBasis, 'net_energy');
});

test('Abruf über den LUOX-Dienst mit der Lesart des Preises; Ablage als Anbieter luox', async () => {
  clearProviderPrices();
  const seen = [];
  const { ctx, written } = makeCtx({ name: 'luox', priceBasis: 'net_energy' });
  ctx.luox = { fetchTariffSlots: async (q) => { seen.push(q); return { provider: 'luox', account: { label: 'LUOX Day-Ahead' }, slots: slots('2026-11-10T23:00:00Z', 96, 12.5) }; } };
  const svc = createTariffProviderService(ctx, { now: () => NOW, dbWaitMs: 50 });
  const r = await svc.refresh('manual');
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [{ priceBasis: 'net_energy' }]);
  assert.equal(providerSlotAt(Date.parse('2026-11-11T12:00:00Z')).ctKwh, 12.5);
  assert.equal(written.length, 96);
  assert.equal(written[0].seriesKey, SERIES_KEY);
  assert.equal(written[0].source, 'luox');
  assert.equal(written[0].meta.priceBasis, 'net_energy');
  assert.equal(svc.getState().providerLabel, 'LUOX');
  clearProviderPrices();
});

test('Endpreis ausgeschaltet: Fehler sichtbar, keine Sperre wie bei falschen Zugangsdaten', async () => {
  const { ctx } = makeCtx({ name: 'luox', priceBasis: 'gross_total' });
  ctx.luox = { fetchTariffSlots: async () => { throw Object.assign(new Error('Endkundenpreis „LUOX Dynamisch“ ist vorbereitet, aber ausgeschaltet'), { code: 'not_enabled' }); } };
  const svc = createTariffProviderService(ctx, { now: () => NOW, dbWaitMs: 50 });
  const r = await svc.refresh('manual');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_enabled');
  assert.equal(svc.getState().authBlockedUntil, null);
});

test('Ohne LUOX-Dienst: verständlicher Fehler statt Absturz', async () => {
  const { ctx } = makeCtx({ name: 'luox', priceBasis: 'net_energy' });
  const svc = createTariffProviderService(ctx, { now: () => NOW, dbWaitMs: 50 });
  const r = await svc.refresh('manual');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_configured');
});

test('Wechsel der Lesart (Endpreis an/aus) gilt als neue Zugangsdaten: Wartezeit aufgehoben', async () => {
  let provider = { name: 'luox', priceBasis: 'net_energy' };
  let luox = LUOX;
  const ctx = {
    getCfg: () => ({ userEnergyPricing: { mode: 'provider', provider }, luox }),
    pushLog: () => {},
    luox: { fetchTariffSlots: async () => { throw Object.assign(new Error('weg'), { code: 'network' }); } }
  };
  const svc = createTariffProviderService(ctx, { now: () => NOW });
  await svc.refresh('manual');
  assert.equal(svc.getState().ok, false);
  luox = { ...LUOX, endCustomerPrice: { enabled: true } };
  provider = { name: 'luox', priceBasis: 'gross_total' };
  ctx.luox.fetchTariffSlots = async () => ({ provider: 'luox', account: null, slots: slots('2026-11-10T23:00:00Z', 4, 30) });
  await svc.tick();
  assert.equal(svc.getState().ok, true, 'sofort neu abgerufen');
  clearProviderPrices();
});
