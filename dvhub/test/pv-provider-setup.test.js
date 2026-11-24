// test/pv-provider-setup.test.js — Christin 19.11.2026: „Wenn pv forecast provider nicht konfiguriert
// sind dann bitte auch nicht ins Ensemble aufnehmen.“
//
// Eine Regel (services/forecast/pv-provider-setup.js) entscheidet je Dienst, ob er eingerichtet ist.
// Sie steuert den Abruf in ALLEN Modi (both / auto / „Nur X“), den pvnode-15-min-Takt und die Anzeige
// (Inspector → Leitstand-Karte, Prognose-Inspektor der Einstellungen). Vorher liefen im Ensemble-Modus
// Solcast und pvnode ohne Key, „Solcast aktiv = aus“ wurde nie gelesen, VRM lief mit dem Token allein,
// „Nur Solcast“ mischte VRM bei, und die Leitstand-Karte zählte alle Modelle mit Zeilen („6 Modelle“,
// obwohl 4 im Ensemble waren).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { createPvForecast } from '../services/forecast/pv-forecast.js';
import { pvProviderSetup, planPvProviders } from '../services/forecast/pv-provider-setup.js';
import { createInspector } from '../services/forecast/inspector.js';
import { createForecastSolar } from '../services/forecast/forecast-solar.js';
import { createPvnodeClient } from '../services/forecast/pvnode-client.js';
import { normalizeConfigInput } from '../config-model.js';

const T0 = '2026-11-19T12:00:00.000Z';
const T1 = '2026-11-19T12:15:00.000Z';
const rows = (w) => [{ ts_utc: T0, power_w: w }, { ts_utc: T1, power_w: w + 100 }];

// Anlage mit zwei Dachflächen in verschiedene Richtungen (Forecast.Solar gratis = nur eine Fläche).
function prodLikeCfg(over = {}) {
  return {
    forecast: {
      location: { latitude: 51.5, longitude: 7.4 },
      pv: {
        model: 'both', configLevel: 'detailed', totalKwp: 27,
        strings: [{ kwp: 18, tiltDeg: 40, azimuthDeg: 180 }, { kwp: 9, tiltDeg: 25, azimuthDeg: 0 }],
      },
      solcast: { enabled: true, apiKey: 'test-key', siteId: 'test-site' },
      pvnode: { apiKey: 'test-key', siteId: 'site-1', plan: 'plus' },
      ...(over.forecast || {}),
    },
    telemetry: { historyImport: { enabled: true, vrmPortalId: '123456', vrmToken: 'test-token' } },
    ...(over.root || {}),
  };
}

function makeStore() {
  const stored = [];
  return {
    stored,
    insertPvForecast: async (r) => { stored.push(r); },
    insertPvForecastBatch: async (rs) => { if (Array.isArray(rs)) stored.push(...rs); },
    getLatestWeather: async () => [],
    getForecastAccuracyRow: async () => null, // → gleiche Gewichte
  };
}

// Jeder Dienst liefert Daten, sobald er gefragt wird — die Mocks kennen keine Einrichtung.
// Wer im Ensemble landet, entscheidet also allein die Regel im Prognose-Lauf.
function makeDeps(calls, extra = {}) {
  const count = (k) => { calls[k] = (calls[k] || 0) + 1; };
  return {
    store: makeStore(),
    pythonBridge: null,
    solcastClient: { fetchPvForecast: async () => { count('solcast'); return rows(2000); } },
    forecastSolar: { fetchForecast: async () => { count('forecast_solar'); return rows(3000); } },
    vrmForecast: { isAvailable: () => true, readPvForecast: async () => { count('vrm'); return rows(4000); } },
    openMeteoSolar: { generateForecast: async () => { count('open_meteo'); return rows(5000); } },
    pvnodeClient: { isConfigured: true, fetchForecast: async () => { count('pvnode'); return rows(6000); } },
    ...extra,
  };
}

function makeCtx(cfgRef, logs = []) {
  return {
    state: { forecast: { pv: {} } },
    getCfg: () => cfgRef.cfg,
    pushLog: (type, data, level) => logs.push({ type, data, level }),
    bumpForecastVersion: () => {},
  };
}

test('Prod-Fall: Ensemble = pvnode, Solcast, VRM, Open-Meteo — Forecast.Solar (Mehrflächen) und pvlib (kein Python) bleiben draußen', async () => {
  const calls = {};
  const cfgRef = { cfg: prodLikeCfg() };
  const ctx = makeCtx(cfgRef);
  const pv = createPvForecast(ctx, makeDeps(calls));
  await pv.runForecast();
  assert.deepEqual(Object.keys(ctx.state.forecast.pv.ensembleWeights).sort(), ['open_meteo', 'pvnode', 'solcast', 'vrm']);
  assert.equal(calls.forecast_solar, undefined, 'Forecast.Solar wird bei gespreizter Anlage gar nicht erst abgefragt');
  pv.close();
});

test('Ensemble-Modus: Solcast und pvnode ohne API-Key werden nicht abgerufen und nicht gewichtet', async () => {
  const calls = {};
  const cfgRef = { cfg: prodLikeCfg({ forecast: { solcast: {}, pvnode: { plan: 'plus' } } }) };
  const ctx = makeCtx(cfgRef);
  const pv = createPvForecast(ctx, makeDeps(calls));
  await pv.runForecast();
  assert.equal(calls.solcast, undefined, 'Solcast ohne Key nicht abgerufen');
  assert.equal(calls.pvnode, undefined, 'pvnode ohne Key nicht abgerufen');
  const w = ctx.state.forecast.pv.ensembleWeights;
  assert.ok(!('solcast' in w) && !('pvnode' in w), JSON.stringify(w));
  pv.close();
});

test('„Solcast aktiv = aus“ mit Key + Site-ID: Solcast bleibt draußen (Ensemble und Automatisch)', async () => {
  for (const model of ['both', 'auto']) {
    const calls = {};
    const cfg = prodLikeCfg({ forecast: { solcast: { enabled: false, apiKey: 'test-key', siteId: 'test-site' } } });
    cfg.forecast.pv.model = model;
    const ctx = makeCtx({ cfg });
    const pv = createPvForecast(ctx, makeDeps(calls));
    await pv.runForecast();
    assert.equal(calls.solcast, undefined, `${model}: Solcast ausgeschaltet → kein Abruf`);
    assert.ok(!('solcast' in (ctx.state.forecast.pv.ensembleWeights || {})), model);
    pv.close();
  }
});

test('VRM: Token allein reicht nicht — ohne „History Import aktiv“ oder Portal-ID kein VRM im Ensemble', async () => {
  for (const hi of [
    { enabled: false, vrmPortalId: '123456', vrmToken: 'test-token' },
    { enabled: true, vrmPortalId: '', vrmToken: 'test-token' },
  ]) {
    const calls = {};
    const ctx = makeCtx({ cfg: prodLikeCfg({ root: { telemetry: { historyImport: hi } } }) });
    const pv = createPvForecast(ctx, makeDeps(calls));
    await pv.runForecast();
    assert.equal(calls.vrm, undefined, JSON.stringify(hi));
    assert.ok(!('vrm' in ctx.state.forecast.pv.ensembleWeights));
    pv.close();
  }
});

test('pvlib: Python da, aber kein Standort → nicht aufgerufen, kein pv_pvlib_error je Lauf', async () => {
  const calls = {};
  const logs = [];
  const cfg = prodLikeCfg();
  delete cfg.forecast.location;
  cfg.schedule = { smallMarketAutomation: { location: { latitude: 51.5, longitude: 7.4 } } }; // die anderen haben einen Rückfall
  const bridge = { call: async () => { calls.pvlib = (calls.pvlib || 0) + 1; return rows(1000); } };
  const ctx = makeCtx({ cfg }, logs);
  const pv = createPvForecast(ctx, makeDeps(calls, { pythonBridge: bridge }));
  await pv.runForecast();
  await pv.runForecast();
  assert.equal(calls.pvlib, undefined);
  assert.ok(!logs.some((l) => l.type === 'pv_pvlib_error'), 'kein Fehler je Lauf');
  pv.close();
});

test('„Nur Solcast“ eingerichtet: nur Solcast, VRM mischt nicht mehr bei', async () => {
  const calls = {};
  const cfg = prodLikeCfg();
  cfg.forecast.pv.model = 'solcast';
  const ctx = makeCtx({ cfg });
  const pv = createPvForecast(ctx, makeDeps(calls));
  await pv.runForecast();
  assert.equal(ctx.state.forecast.pv.model, 'solcast');
  assert.equal(ctx.state.forecast.pv.ensembleWeights ?? null, null);
  assert.equal(calls.vrm, undefined, 'VRM nicht abgefragt');
  pv.close();
});

test('„Nur Solcast“ ohne Key: kein Solcast-Abruf, Lauf wie „Automatisch“, Warnung nur einmal', async () => {
  const calls = {};
  const logs = [];
  const cfg = prodLikeCfg({ forecast: { solcast: { enabled: true } } });
  cfg.forecast.pv.model = 'solcast';
  const ctx = makeCtx({ cfg }, logs);
  const pv = createPvForecast(ctx, makeDeps(calls));
  await pv.runForecast();
  await pv.runForecast();
  assert.equal(calls.solcast, undefined);
  assert.deepEqual(Object.keys(ctx.state.forecast.pv.ensembleWeights).sort(), ['open_meteo', 'pvnode', 'vrm']);
  const warns = logs.filter((l) => l.type === 'pv_forecast_model_fallback');
  assert.equal(warns.length, 1, 'Hinweis einmal, nicht je Lauf');
  assert.equal(warns[0].level, 'warn');
  assert.equal(warns[0].data.reason, 'missing_api_key');
  pv.close();
});

test('Nicht eingerichtete Dienste melden sich nicht mehr jeden Lauf (echte Clients: pvnode, Forecast.Solar)', async () => {
  const logs = [];
  const cfg = prodLikeCfg({ forecast: { pvnode: { plan: 'plus' } } }); // pvnode ohne Key
  const ctx = makeCtx({ cfg }, logs);
  const deps = makeDeps({}, {
    pvnodeClient: createPvnodeClient(ctx, {}),
    forecastSolar: createForecastSolar(ctx, { store: { writePvForecasts: async () => {} } }),
  });
  const pv = createPvForecast(ctx, deps);
  await pv.runForecast();
  await pv.runForecast();
  assert.ok(!logs.some((l) => l.type === 'pvnode_skip'), 'kein pvnode_skip je Lauf');
  assert.ok(!logs.some((l) => l.type === 'forecast_solar_skip'), 'kein forecast_solar_skip je Lauf');
  assert.equal(logs.filter((l) => l.type === 'pv_forecast_providers').length, 1, 'Einrichtung einmal protokolliert');
  pv.close();
});

test('pvnode-15-min-Takt: ein seit dem letzten Lauf ausgetragener Dienst fällt sofort aus dem Ensemble', async () => {
  const calls = {};
  const cfgRef = { cfg: prodLikeCfg() };
  const ctx = makeCtx(cfgRef);
  const pv = createPvForecast(ctx, makeDeps(calls));
  await pv.runForecast();
  assert.ok('solcast' in ctx.state.forecast.pv.ensembleWeights);
  // Solcast wird ausgeschaltet; pvnode liefert unverändert (der alte Takt hätte nichts getan).
  cfgRef.cfg = prodLikeCfg({ forecast: { solcast: { enabled: false, apiKey: 'test-key', siteId: 'test-site' } } });
  await pv.refreshPvnodeOnly();
  assert.ok(!('solcast' in ctx.state.forecast.pv.ensembleWeights), JSON.stringify(ctx.state.forecast.pv.ensembleWeights));
  pv.close();
});

test('Regel je Dienst: Bedingungen und Gründe', () => {
  const base = prodLikeCfg();
  const s = pvProviderSetup(base, { pvlibAvailable: false });
  assert.deepEqual(
    Object.fromEntries(Object.entries(s).map(([k, v]) => [k, [v.configured, v.eligible, v.reason]])),
    {
      pvnode: [true, true, null], solcast: [true, true, null], pvlib: [false, false, 'no_python'],
      vrm: [true, true, null], forecast_solar: [true, false, 'multi_plane_detailed'], open_meteo: [true, true, null],
    },
  );
  // Solcast: fehlendes enabled (ältere Configs) = an; Site-ID fehlt → nicht eingerichtet.
  assert.equal(pvProviderSetup({ forecast: { solcast: { apiKey: 'k', siteId: 's' } } }).solcast.eligible, true);
  assert.equal(pvProviderSetup({ forecast: { solcast: { apiKey: 'k' } } }).solcast.reason, 'missing_site_id');
  // pvnode: ohne Standort-ID braucht die Inline-Prognose Standort + Fläche.
  assert.equal(pvProviderSetup({ forecast: { pvnode: { apiKey: 'k' } } }).pvnode.reason, 'missing_location');
  assert.equal(pvProviderSetup({ forecast: { pvnode: { apiKey: 'k' }, location: { latitude: 51, longitude: 7 } } }).pvnode.reason, 'no_plants');
  assert.equal(pvProviderSetup({ forecast: { pvnode: { apiKey: 'k' }, location: { latitude: 51, longitude: 7 }, pv: { totalKwp: 5 } } }).pvnode.eligible, true);
  // Gratis-Dienste: Standort + kWp.
  assert.equal(pvProviderSetup({ forecast: { pv: { totalKwp: 5 } } }).forecast_solar.reason, 'missing_location');
  assert.equal(pvProviderSetup({ forecast: { location: { latitude: 51, longitude: 7 } } }).open_meteo.reason, 'no_kwp');
  assert.equal(pvProviderSetup({ forecast: { pv: { totalKwp: 5 } } }).open_meteo.reason, 'missing_location');
  assert.equal(pvProviderSetup({ forecast: { pv: { totalKwp: 5 }, weather: { provider: 'mqtt' } } }).open_meteo.eligible, true);
  // pvlib: Python + forecast.location + kWp.
  assert.equal(pvProviderSetup({ forecast: { location: { latitude: 51, longitude: 7 }, pv: { totalKwp: 5 } } }, { pvlibAvailable: true }).pvlib.eligible, true);
  assert.equal(pvProviderSetup({ forecast: { location: { latitude: null, longitude: 7 }, pv: { totalKwp: 5 } } }, { pvlibAvailable: true }).pvlib.reason, 'missing_location');
  // Modus: „Automatisch“ ohne pvlib, „Nur X“ genau X.
  const auto = planPvProviders({ ...base, forecast: { ...base.forecast, pv: { ...base.forecast.pv, model: 'auto' } } }, { pvlibAvailable: true });
  assert.ok(!auto.fetch.includes('pvlib'));
  const only = planPvProviders({ ...base, forecast: { ...base.forecast, pv: { ...base.forecast.pv, model: 'pvnode' } } });
  assert.deepEqual(only.fetch, ['pvnode']);
  assert.equal(only.providers.vrm.reason, 'mode_excludes');
});

// ── Anzeige ─────────────────────────────────────────────────────────────────

function prodInspector(cfg = prodLikeCfg()) {
  // Zeilen im Fenster: 4 Mitglieder + combined + alte forecast_solar-Zeilen (wie Prod 19.11. 14:10).
  const fetched = new Date('2026-11-19T12:00:00Z');
  const dbRows = [];
  for (const m of ['pvnode', 'solcast', 'vrm', 'open_meteo', 'combined', 'forecast_solar']) {
    dbRows.push({ ts_utc: new Date(T0), model: m, power_w: 1000, confidence: 0.5, fetched_at: m === 'forecast_solar' ? new Date('2026-11-18T23:50:00Z') : fetched });
  }
  const ensembleWeights = { pvnode: 0.3, solcast: 0.2, vrm: 0.25, open_meteo: 0.25 };
  return createInspector(
    { state: { forecast: { pv: { model: 'combined', ensembleWeights } } }, getCfg: () => cfg, pushLog: () => {} },
    { store: { getLatestPvForecast: async () => dbRows } },
  );
}

test('Inspector: „N Modelle“ = Ensemble-Mitglieder (4), nicht alle Modelle mit Zeilen (6)', async () => {
  const out = await prodInspector().getPvProviders({ from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' });
  assert.equal(out.meta.modelCount, 6, 'modelCount bleibt wie bisher (Rückwärtskompatibilität)');
  assert.equal(out.meta.ensembleMemberCount, 4);
  assert.deepEqual(out.ensembleMembers.sort(), ['open_meteo', 'pvnode', 'solcast', 'vrm']);
  assert.equal(out.providerStatus.forecast_solar.status, 'not_applicable');
  assert.match(out.providerStatus.forecast_solar.hint, /Gratis-Abfrage von Forecast\.Solar rechnet nur eine Fläche/);
  assert.equal(out.providerStatus.pvlib.status, 'not_configured');
  assert.equal(out.providerStatus.solcast.status, 'member');
  assert.equal(out.providerStatus.solcast.weight, 0.2);
});

test('Inspector: noch gewichteter, inzwischen ausgetragener Dienst heißt „leaving“', async () => {
  const cfg = prodLikeCfg({ forecast: { solcast: { enabled: false, apiKey: 'k', siteId: 's' } } });
  const out = await prodInspector(cfg).getPvProviders({ from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' });
  assert.equal(out.providerStatus.solcast.status, 'leaving');
  assert.match(out.providerStatus.solcast.hint, /fällt beim nächsten Lauf heraus — Solcast ist ausgeschaltet/);
});

function loadLeitstand() {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/leitstand-charts.js'), 'utf8');
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map,
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
    window: {}, setInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'leitstand-charts.js' });
  return sandbox.window.DVhubLeitstand;
}

test('Leitstand-Karte: „Ensemble: aktiv · 4 Modelle“, Forecast.Solar gedimmt mit Grund, ohne Werte', async () => {
  const j = { ok: true, ...(await prodInspector().getPvProviders({ from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' })) };
  const view = loadLeitstand().forecastProvidersView(JSON.parse(JSON.stringify(j)), Date.parse('2026-11-19T12:30:00Z'));
  assert.equal(view.ensembleText, 'Ensemble: aktiv · 4 Modelle');
  const fs1 = view.rows.find((r) => r.key === 'forecast_solar');
  assert.equal(fs1.active, false);
  assert.equal(fs1.showValues, false, 'alte Zeilen eines nicht verwendbaren Dienstes zeigen keine Werte');
  assert.equal(fs1.showCurve, false);
  assert.match(fs1.note, /^nicht im Ensemble – Dachflächen zeigen in verschiedene Richtungen/);
  const sc = view.rows.find((r) => r.key === 'solcast');
  assert.equal(sc.active, true);
  assert.equal(sc.note, 'im Ensemble · Gewicht 20 %');
  // pvlib: nicht eingerichtet und ohne Zeilen → gar nicht in der Karte.
  assert.equal(view.rows.find((r) => r.key === 'pvlib'), undefined);
  // Ensemble-Zeile vorn.
  assert.equal(view.rows[0].key, 'combined');
});

test('Einstellungen: Hinweis „Nicht im Ensemble“ nennt Dienst und Grund', async () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../public/settings.js'), 'utf8');
  const stub = () => {};
  const sandbox = {
    console,
    window: { DVhubCommon: { escapeHtml: (v) => String(v ?? '') }, addEventListener: stub, setTimeout: stub },
    document: { getElementById: () => null, createElement: () => ({ appendChild: stub, setAttribute: stub, style: {}, classList: { add: stub, remove: stub } }), addEventListener: stub },
    setTimeout: stub, location: {}, localStorage: { getItem: () => null, setItem: stub },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(source, sandbox); } catch { /* Bootstrap braucht einen Browser */ }
  const out = await prodInspector().getPvProviders({ from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' });
  const outOf = Object.values(out.providerStatus).filter((s) => s.status !== 'member');
  const lines = sandbox.pvProvidersOutOfEnsembleLines(out, outOf);
  assert.equal(lines[0], 'Nicht im Ensemble:');
  assert.ok(lines.some((l) => l.startsWith('Forecast.Solar: nicht im Ensemble – Dachflächen')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('pvlib: nicht eingerichtet – die lokale Python-Umgebung')), lines.join('\n'));
});

// ── „Solcast aktiv“: ältere Configs bleiben, wie sie liefen ──────────────────

test('Config: still gespeichertes enabled:false (Integrationen-Fenster) wird einmal zu true, ein späteres „aus“ bleibt', () => {
  const legacy = normalizeConfigInput({ forecast: { solcast: { enabled: false, apiKey: 'k', siteId: 's' } } });
  assert.equal(legacy.effectiveConfig.forecast.solcast.enabled, true, 'bisher lief Solcast trotz false — so bleibt es');
  assert.equal(legacy.rawConfig.forecast.solcast.enabledHonored, true);
  const later = normalizeConfigInput({ forecast: { solcast: { enabled: false, apiKey: 'k', siteId: 's', enabledHonored: true } } });
  assert.equal(later.effectiveConfig.forecast.solcast.enabled, false, 'nach der Umstellung gilt „aus“');
  const noKey = normalizeConfigInput({ forecast: { solcast: { enabled: false } } });
  assert.equal(noKey.effectiveConfig.forecast.solcast.enabled, false);
});

test('Integrationen-Fenster schreibt beim Speichern kein stilles enabled:false mehr', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../routes-api.js'), 'utf8');
  assert.match(src, /next\.forecast\.solcast\.enabled = \(body\.enabled === undefined\) \? \(prev\.enabled !== false\) : !!body\.enabled;/);
});

// ── Codex 78f50e77 ──────────────────────────────────────────────────────────

test('Codex 78f50e77 (P2): ist kein Dienst mehr eingerichtet, gilt die alte Prognose nicht weiter', async () => {
  const cfgRef = { cfg: prodLikeCfg() };
  let bumps = 0;
  const ctx = { ...makeCtx(cfgRef), bumpForecastVersion: () => { bumps++; } };
  const pv = createPvForecast(ctx, makeDeps({}));
  await pv.runForecast();
  assert.equal(ctx.state.forecast.pv.model, 'combined');
  // Alle Dienste ausgetragen: kein Standort, keine kWp, keine Keys, kein VRM.
  cfgRef.cfg = { forecast: { pv: { model: 'both' } } };
  const before = bumps;
  await pv.runForecast();
  assert.equal(ctx.state.forecast.pv.data, null, 'keine Werte nicht eingerichteter Dienste mehr an EOS');
  assert.equal(ctx.state.forecast.pv.model, null);
  assert.equal(ctx.state.forecast.pv.ensembleWeights ?? null, null);
  assert.equal(bumps, before + 1, 'Optimierer erfährt es (Versionssprung)');
  await pv.runForecast();
  assert.equal(bumps, before + 1, 'nur beim Wechsel, nicht jeden Lauf');
  pv.close();
});

test('Codex 78f50e77 (P2): „Nur Solcast“ speichert die echten Solcast-Werte (powerW), nicht 0', async () => {
  const cfg = prodLikeCfg();
  cfg.forecast.pv.model = 'solcast';
  const ctx = makeCtx({ cfg });
  const deps = makeDeps({}, {
    // Form des echten Clients (solcast-client.js parseSolcastResponse): { ts, powerW, confidence }.
    solcastClient: { fetchPvForecast: async () => [{ ts: T0, powerW: 4000, confidence: 0.6 }, { ts: T1, powerW: 4100, confidence: 0.6 }] },
  });
  const pv = createPvForecast(ctx, deps);
  await pv.runForecast();
  const stored = deps.store.stored.filter((r) => r.model === 'solcast');
  assert.deepEqual(stored.map((r) => r.power_w), [4000, 4100]);
  pv.close();
});
