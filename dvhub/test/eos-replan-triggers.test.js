// Seltener EOS-Takt (Christin 2026-10-18, SPiNE EnergyLink: 2 Kerne → EOS alle
// 2 h): dazwischen rechnet EOS nur neu, wenn sich etwas ändert. Schon vorhanden:
// Auto an/ab, Auto-Einstellungen, Geräte, plan-relevante Einstellungen. Neu:
//   - neue Day-Ahead-Preise → sofort rechnen (nach dem Prognose-Push)
//   - Ladestand weicht deutlich vom Plan ab → neu rechnen
// Beides nur bei einem Takt über 15 min — bestehende Installationen (15 min)
// rechnen wie bisher.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  socDriftReplan, expectedSocPctAt, SOC_DRIFT_THRESHOLD_PCT, SOC_DRIFT_MIN_PLAN_AGE_MS, sparseEosCadence,
} from '../services/optimizer/eos-replan-triggers.js';
import { createEpexFetcher } from '../epex-fetch.js';
import { getConfigDefinition } from '../config-model.js';

const T0 = Date.parse('2026-10-19T10:00:00Z');
const SLOT = 15 * 60_000;
const rows = [0, 1, 2, 3].map((i) => ({ ts_utc: new Date(T0 + i * SLOT).toISOString(), socPct: 50 + i * 4 }));
const solution = { generatedAt: new Date(T0 - 20 * 60_000).toISOString(), rows };

test('Takt: erst über 15 min gilt als selten', () => {
  assert.equal(sparseEosCadence(900), false);
  assert.equal(sparseEosCadence(3600), true);
  assert.equal(sparseEosCadence(7200), true);
  assert.equal(sparseEosCadence(0), false);
});

test('Erwarteter Ladestand: zwischen zwei Slots linear', () => {
  assert.equal(expectedSocPctAt(rows, T0), 50);
  assert.equal(expectedSocPctAt(rows, T0 + SLOT / 2), 52);
  assert.equal(expectedSocPctAt(rows, T0 - 1), null, 'vor dem Plan');
  assert.equal(expectedSocPctAt(rows, T0 + 10 * SLOT), null, 'nach dem Plan');
  assert.equal(expectedSocPctAt([{ ts_utc: rows[0].ts_utc, socPct: null }, rows[1]], T0 + 60_000), null);
});

test('Schwelle und Mindestalter des Plans', () => {
  assert.equal(SOC_DRIFT_THRESHOLD_PCT, 10);
  assert.equal(SOC_DRIFT_MIN_PLAN_AGE_MS, 15 * 60_000);
});

test('Ladestand weicht ≥ 10 Prozentpunkte ab, Plan älter als 15 min, Takt 2 h → neu rechnen', () => {
  const r = socDriftReplan({ solution, liveSocPct: 40, nowMs: T0, intervalSec: 7200 });
  assert.equal(r.replan, true);
  assert.equal(r.expectedPct, 50);
  assert.equal(r.deltaPct, -10);
});

test('Kein Neuplan: kleine Abweichung, junger Plan, 15-min-Takt oder fehlende Werte', () => {
  assert.equal(socDriftReplan({ solution, liveSocPct: 41, nowMs: T0, intervalSec: 7200 }).replan, false, '9 Punkte');
  const young = { ...solution, generatedAt: new Date(T0 - 5 * 60_000).toISOString() };
  assert.equal(socDriftReplan({ solution: young, liveSocPct: 20, nowMs: T0, intervalSec: 7200 }).replan, false, 'Plan zu jung');
  assert.equal(socDriftReplan({ solution, liveSocPct: 20, nowMs: T0, intervalSec: 900 }).replan, false, '15-min-Takt');
  assert.equal(socDriftReplan({ solution, liveSocPct: null, nowMs: T0, intervalSec: 7200 }).replan, false, 'kein Live-SoC');
  assert.equal(socDriftReplan({ solution: null, liveSocPct: 20, nowMs: T0, intervalSec: 7200 }).replan, false, 'kein Plan');
  assert.equal(socDriftReplan({ solution: { rows }, liveSocPct: 20, nowMs: T0, intervalSec: 7200 }).replan, false, 'ohne Zeitstempel');
});

test('Einstellung „EOS Re-Planungs-Intervall“ bietet 2 Stunden an', () => {
  const field = getConfigDefinition().fields.find((f) => f.path === 'optimizer.eosEmsIntervalSec');
  assert.ok(field.options.some((o) => o.value === 7200 && /2 Stunden/.test(o.label)));
});

// ── Day-Ahead-Preise kommen an ──
// Ob der Takt selten ist, entscheidet der Optimierer (wirksamer Takt, auch bei
// „Automatisch“) — epex-fetch fragt nach dem Prognose-Push nur an.

function epexCtx() {
  const calls = [];
  const state = { epex: { ok: false, data: [], updatedAt: 0 } };
  const cfg = { epex: { enabled: true, bzn: 'DE-LU', timezone: 'Europe/Berlin', priceSource: 'public' } };
  const ctx = {
    state, getCfg: () => cfg, pushLog: () => {},
    telemetrySafeWrite: () => {}, telemetryStore: { writeSamples: () => {} },
    healthTracker: { recordSample: () => {} }, publishRuntimeSnapshot: () => {},
    eosForecastBridge: { push: async () => { calls.push('push'); } },
    optimizerService: { requestEosReplanIfSparse: (why) => { calls.push(`replan:${why}`); return true; } },
  };
  return { ctx, calls, state };
}

async function withPrices(days, fn) {
  const realFetch = globalThis.fetch;
  const now = Math.floor(Date.now() / 1000);
  const unix = days === 2 ? [now, now + 86400] : [now];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ unix_seconds: unix, price: unix.map(() => 50) }) });
  try { await fn(); } finally { globalThis.fetch = realFetch; }
}

test('Day-Ahead kommt an → erst Prognose-Push, dann Neuplan-Anfrage', async () => {
  const { ctx, calls } = epexCtx();
  await withPrices(2, () => createEpexFetcher(ctx).fetchEpexDay());
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ['push', 'replan:dayahead']);
});

test('Day-Ahead schon bekannt → keine Neuplan-Anfrage', async () => {
  const { ctx, calls } = epexCtx();
  const f = createEpexFetcher(ctx);
  await withPrices(2, () => f.fetchEpexDay());
  await new Promise((r) => setTimeout(r, 20));
  calls.length = 0;
  await withPrices(2, () => f.fetchEpexDay());
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, []);
});
