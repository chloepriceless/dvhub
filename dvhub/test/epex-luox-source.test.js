// Preisquelle „LUOX“ (epex.priceSource = 'luox', T-0417): Day-Ahead direkt aus
// dem LUOX-Kundenportal; liefert LUOX nicht, springt die bisherige öffentliche
// Quelle (dvhub.online → Energy-Charts) ein — auch nur für den fehlenden Tag.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEpexFetcher, epexRefreshDue, dayComplete } from '../epex-fetch.js';

const Q = 900_000;
// 11.11.2026 14:30 Ortszeit; heute ab 10.11. 23:00Z, morgen ab 11.11. 23:00Z
const NOW = Date.parse('2026-11-11T13:30:00Z');
const TODAY0 = Date.parse('2026-11-10T23:00:00Z');
const TOMORROW0 = Date.parse('2026-11-11T23:00:00Z');
const day = (start, eur) => Array.from({ length: 96 }, (_, i) => ({ ts: start + i * Q, eurMwh: eur, ctKwh: eur / 10, durationMs: Q }));

function makeCtx({ luox, priceSource = 'luox' } = {}) {
  const logs = [];
  const state = { epex: { ok: false, data: [], updatedAt: 0 } };
  const cfg = { epex: { enabled: true, bzn: 'DE-LU', timezone: 'Europe/Berlin', priceSource, priceApiUrl: 'https://dvhub.online' } };
  const ctx = {
    state,
    getCfg: () => cfg,
    pushLog: (event, data) => logs.push({ event, data }),
    telemetrySafeWrite: (fn) => { try { fn(); } catch { /* ignore */ } },
    telemetryStore: { writeSamples: () => {} },
    healthTracker: { recordSample: () => {} },
    publishRuntimeSnapshot: () => {},
    outboundFetch: (...a) => globalThis.fetch(...a),
    luox: luox === undefined ? undefined : luox
  };
  return { ctx, state, logs };
}

describe("epex.priceSource = 'luox'", () => {
  const realFetch = globalThis.fetch;
  let urls;
  function installFetch() {
    urls = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('dvhub.online')) {
        const data = [...day(TODAY0, 30), ...day(TOMORROW0, 40)].map((r) => ({ ts: new Date(r.ts).toISOString(), price: r.eurMwh }));
        return { ok: true, json: async () => ({ data }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
  }
  afterEach(() => { globalThis.fetch = realFetch; });

  it('LUOX liefert heute und morgen: keine öffentliche Quelle, Quelle je Tag = luox', async () => {
    installFetch();
    const { ctx, state, logs } = makeCtx({ luox: { fetchDayAhead: async () => ({ source: 'luox_portal', rows: [...day(TODAY0, 100), ...day(TOMORROW0, 110)] }) } });
    await createEpexFetcher(ctx, { now: () => NOW }).fetchEpexDay();
    assert.equal(urls.length, 0, 'kein Abruf bei dvhub.online/Energy-Charts');
    assert.equal(state.epex.ok, true);
    assert.equal(state.epex.data.length, 192);
    assert.equal(state.epex.data[0].eur_mwh, 100);
    assert.equal(state.epex.data[0].ct_kwh, 10);
    assert.equal(state.epex.data[0].day, '2026-11-11');
    assert.deepEqual(state.epex.sourceByDay, { '2026-11-11': 'luox', '2026-11-12': 'luox' });
    assert.ok(logs.some((l) => l.event === 'epex_refresh_ok' && l.data.activeSource === 'luox'));
  });

  it('LUOX scheitert: Rückfall auf dvhub.online, Meldung im Protokoll', async () => {
    installFetch();
    const { ctx, state, logs } = makeCtx({ luox: { fetchDayAhead: async () => { throw Object.assign(new Error('LUOX-Portal nicht erreichbar'), { code: 'network' }); } } });
    await createEpexFetcher(ctx, { now: () => NOW }).fetchEpexDay();
    assert.ok(urls[0].includes('dvhub.online'));
    assert.equal(state.epex.data.length, 192);
    assert.equal(state.epex.data[0].eur_mwh, 30);
    assert.deepEqual(state.epex.sourceByDay, { '2026-11-11': 'dvhub', '2026-11-12': 'dvhub' });
    assert.ok(logs.some((l) => l.event === 'epex_luox_fallback' && l.data.code === 'network'));
  });

  it('LUOX nur heute, nach 13 Uhr: morgen aus der öffentlichen Quelle, heute bleibt LUOX', async () => {
    installFetch();
    const { ctx, state } = makeCtx({ luox: { fetchDayAhead: async () => ({ source: 'luox_portal', rows: day(TODAY0, 100) }) } });
    await createEpexFetcher(ctx, { now: () => NOW }).fetchEpexDay();
    assert.equal(state.epex.data.length, 192);
    assert.equal(state.epex.data.find((r) => r.day === '2026-11-11').eur_mwh, 100);
    assert.equal(state.epex.data.find((r) => r.day === '2026-11-12').eur_mwh, 40);
    assert.deepEqual(state.epex.sourceByDay, { '2026-11-11': 'luox', '2026-11-12': 'dvhub' });
  });

  it('LUOX nur heute, vor 13 Uhr: kein Abruf der öffentlichen Quelle (morgen gibt es noch nirgends)', async () => {
    installFetch();
    const morning = Date.parse('2026-11-11T08:00:00Z');
    const { ctx, state } = makeCtx({ luox: { fetchDayAhead: async () => ({ source: 'luox_portal', rows: day(TODAY0, 100) }) } });
    await createEpexFetcher(ctx, { now: () => morning }).fetchEpexDay();
    assert.equal(urls.length, 0);
    assert.equal(state.epex.data.length, 96);
  });

  it('Fehlender Tag wird aus dem schon gehaltenen Stand übernommen, statt erneut öffentlich abzurufen', async () => {
    installFetch();
    let calls = 0;
    const { ctx, state } = makeCtx({ luox: { fetchDayAhead: async () => { calls += 1; return { source: 'luox_portal', rows: day(TODAY0, 100) }; } } });
    const f = createEpexFetcher(ctx, { now: () => NOW });
    await f.fetchEpexDay();
    const after1 = urls.length;
    await f.fetchEpexDay();
    assert.equal(calls, 2);
    assert.equal(urls.length, after1, 'zweiter Lauf: morgen aus dem Speicher');
    assert.equal(state.epex.data.length, 192);
  });

  it('LUOX fällt aus: gehaltener Stand wird weiter genutzt, kein erneuter öffentlicher Abruf', async () => {
    installFetch();
    let fail = false;
    const { ctx, state } = makeCtx({ luox: { fetchDayAhead: async () => {
      if (fail) throw Object.assign(new Error('weg'), { code: 'network' });
      return { source: 'luox_portal', rows: [...day(TODAY0, 100), ...day(TOMORROW0, 110)] };
    } } });
    const f = createEpexFetcher(ctx, { now: () => NOW });
    await f.fetchEpexDay();
    fail = true;
    await f.fetchEpexDay();
    assert.equal(urls.length, 0, 'kein Abruf bei dvhub.online');
    assert.equal(state.epex.data.length, 192);
    assert.equal(state.epex.data[0].eur_mwh, 100);
  });

  it('Andere Preiszone als DE-LU: LUOX wird nicht gefragt', async () => {
    installFetch();
    let asked = 0;
    const { ctx } = makeCtx({ luox: { fetchDayAhead: async () => { asked += 1; return { rows: [] }; } } });
    ctx.getCfg().epex.bzn = 'AT';
    await createEpexFetcher(ctx, { now: () => NOW }).fetchEpexDay();
    assert.equal(asked, 0);
    assert.ok(urls[0].includes('dvhub.online'));
  });

  it('Gehaltene Preise einer anderen Preiszone werden nicht übernommen', async () => {
    installFetch();
    const { ctx, state } = makeCtx({ luox: { fetchDayAhead: async () => { throw Object.assign(new Error('weg'), { code: 'network' }); } } });
    state.epex = { ok: true, date: '2026-11-11', bzn: 'AT', data: [...day(TODAY0, 1), ...day(TOMORROW0, 1)].map((r) => ({ ts: r.ts, day: r.ts >= TOMORROW0 ? '2026-11-12' : '2026-11-11', eur_mwh: 999, ct_kwh: 99.9 })), sourceByDay: {} };
    await createEpexFetcher(ctx, { now: () => NOW }).fetchEpexDay();
    assert.ok(urls[0].includes('dvhub.online'));
    assert.equal(state.epex.data[0].eur_mwh, 30, 'DE-LU neu abgerufen');
    assert.equal(state.epex.bzn, 'DE-LU');
  });

  it('Unvollständig gehaltener Tag wird beim nächsten Lauf neu abgerufen', async () => {
    installFetch();
    const { ctx, state } = makeCtx({ luox: { fetchDayAhead: async () => { throw Object.assign(new Error('weg'), { code: 'network' }); } } });
    state.epex = { ok: true, date: '2026-11-11', bzn: 'DE-LU', data: [{ ts: TODAY0, day: '2026-11-11', eur_mwh: 1, ct_kwh: 0.1 }, { ts: TOMORROW0, day: '2026-11-12', eur_mwh: 1, ct_kwh: 0.1 }], sourceByDay: {} };
    await createEpexFetcher(ctx, { now: () => NOW }).fetchEpexDay();
    assert.equal(urls.length, 1);
    assert.equal(state.epex.data.length, 192);
  });

  it('Vollständiger Rückfall-Tag (Stundenwerte) ersetzt einen unvollständigen gehaltenen Tag mit mehr Zeilen', async () => {
    urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      const hourly = Array.from({ length: 24 }, (_, i) => ({ ts: new Date(TODAY0 + i * 4 * Q).toISOString(), price: 55 }));
      return { ok: true, json: async () => ({ data: hourly }) };
    };
    const { ctx, state } = makeCtx({ luox: { fetchDayAhead: async () => { throw Object.assign(new Error('weg'), { code: 'network' }); } } });
    state.epex = { ok: true, date: '2026-11-11', bzn: 'DE-LU', data: day(TODAY0, 1).slice(0, 48).map((r) => ({ ts: r.ts, day: '2026-11-11', eur_mwh: 1, ct_kwh: 0.1 })), sourceByDay: {} };
    await createEpexFetcher(ctx, { now: () => NOW }).fetchEpexDay();
    assert.equal(state.epex.data.filter((r) => r.day === '2026-11-11').length, 24);
    assert.equal(state.epex.data[0].eur_mwh, 55);
  });

  it('LUOX fällt aus, vor 13 Uhr: was die öffentliche Quelle für morgen schon hat, wird übernommen', async () => {
    installFetch();
    const early = Date.parse('2026-11-11T11:50:00Z'); // 12:50 Ortszeit
    const { ctx, state } = makeCtx({ luox: { fetchDayAhead: async () => { throw Object.assign(new Error('weg'), { code: 'network' }); } } });
    await createEpexFetcher(ctx, { now: () => early }).fetchEpexDay();
    assert.equal(state.epex.data.length, 192);
  });

  it('Ohne LUOX-Dienst verhält sich „luox“ wie „dvhub“', async () => {
    installFetch();
    const { ctx, state } = makeCtx({ luox: null });
    await createEpexFetcher(ctx, { now: () => NOW }).fetchEpexDay();
    assert.ok(urls[0].includes('dvhub.online'));
    assert.equal(state.epex.data.length, 192);
  });
});

describe('epexRefreshDue', () => {
  const base = (over = {}) => ({
    state: { epex: { date: '2026-11-11', updatedAt: NOW - 60_000, data: [...day(TODAY0, 1), ...day(TOMORROW0, 1)].map((r) => ({ ts: r.ts, day: r.ts >= TOMORROW0 ? '2026-11-12' : '2026-11-11' })), sourceByDay: { '2026-11-11': 'luox', '2026-11-12': 'luox' }, ...over } },
    cfg: { epex: { timezone: 'Europe/Berlin', priceSource: 'luox' } }
  });
  it('alles da und frisch: nicht fällig', () => {
    const { state, cfg } = base();
    assert.equal(epexRefreshDue(state, cfg, NOW), false);
  });
  it('morgen nur aus der öffentlichen Quelle: bis 20 Uhr weiter bei LUOX nachfragen', () => {
    const { state, cfg } = base({ sourceByDay: { '2026-11-11': 'luox', '2026-11-12': 'dvhub' } });
    assert.equal(epexRefreshDue(state, cfg, NOW), true);
    const late = Date.parse('2026-11-11T19:30:00Z');
    assert.equal(epexRefreshDue({ epex: { ...state.epex, updatedAt: late - 60_000 } }, cfg, late), false, 'nach 20 Uhr Ruhe');
    assert.equal(epexRefreshDue(state, { epex: { ...cfg.epex, priceSource: 'dvhub' } }, NOW), false, 'andere Quelle: altes Verhalten');
  });
  it('Preiszone geändert: sofort neu abrufen', () => {
    const { state, cfg } = base({ bzn: 'AT' });
    assert.equal(epexRefreshDue(state, { epex: { ...cfg.epex, bzn: 'FR' } }, NOW), true);
    assert.equal(epexRefreshDue({ epex: { ...state.epex, bzn: 'FR', sourceByDay: { '2026-11-11': 'dvhub', '2026-11-12': 'dvhub' } } }, { epex: { ...cfg.epex, bzn: 'FR' } }, NOW), false);
  });
  it('Andere Preiszone als DE-LU: kein Nachfragen bei LUOX (normaler Takt)', () => {
    const { state, cfg } = base({ sourceByDay: { '2026-11-11': 'dvhub', '2026-11-12': 'dvhub' } });
    assert.equal(epexRefreshDue(state, { epex: { ...cfg.epex, bzn: 'AT' } }, NOW), false);
  });
  it('heute nicht von LUOX: bei LUOX weiter nachfragen', () => {
    const { state, cfg } = base({ sourceByDay: { '2026-11-11': 'dvhub', '2026-11-12': 'luox' } });
    assert.equal(epexRefreshDue(state, cfg, NOW), true);
  });
  it('bisherige Regeln bleiben: neuer Tag, 6 h alt, ab 13 Uhr ohne morgen', () => {
    const { state, cfg } = base();
    assert.equal(epexRefreshDue({ epex: { ...state.epex, date: '2026-11-10' } }, cfg, NOW), true);
    assert.equal(epexRefreshDue({ epex: { ...state.epex, updatedAt: NOW - 7 * 3600_000 } }, cfg, NOW), true);
    assert.equal(epexRefreshDue({ epex: { ...state.epex, data: state.epex.data.filter((r) => r.day === '2026-11-11') } }, { epex: { ...cfg.epex, priceSource: 'dvhub' } }, NOW), true);
  });
});

describe('dayComplete', () => {
  const rows = (start, n, step) => Array.from({ length: n }, (_, i) => ({ ts: start + i * step }));
  it('volle Tage: 96 Viertelstunden, 24 Stunden, 92/100 an Umstellungstagen', () => {
    assert.equal(dayComplete(rows(TODAY0, 96, Q), '2026-11-11'), true);
    assert.equal(dayComplete(rows(TODAY0, 24, 4 * Q), '2026-11-11'), true);
    assert.equal(dayComplete(rows(Date.parse('2026-10-24T22:00:00Z'), 100, Q), '2026-10-25'), true);
    assert.equal(dayComplete(rows(Date.parse('2026-03-28T23:00:00Z'), 92, Q), '2026-03-29'), true);
  });
  it('Lücken zählen nicht als voll (fehlendes 00:15, halber Tag, falscher Beginn)', () => {
    const gap = rows(TODAY0, 96, Q).filter((_, i) => i !== 1);
    assert.equal(dayComplete(gap, '2026-11-11'), false);
    const half = rows(TODAY0, 48, Q).filter((_, i) => i !== 1);
    assert.equal(dayComplete(half, '2026-11-11'), false);
    assert.equal(dayComplete(rows(TODAY0 + Q, 96, Q), '2026-11-11'), false);
    assert.equal(dayComplete([], '2026-11-11'), false);
  });
});
