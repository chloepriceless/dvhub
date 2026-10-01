// test/charger-status.test.js — Steckzustand direkt von OpenEVSE / go-e statt
// nur aus evcc. Anlass prod 2026-10-01: evcc lief nicht (ECONNREFUSED), das Auto
// hing an der OpenEVSE und lud — DVhub meldete „Steckzustand unbekannt“ und das
// Auto wurde bei EOS nicht angemeldet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargerStatusPoller, CHARGER_STATUS_MAX_AGE_MS } from '../services/wallbox/charger-status.js';
import { resolveEvPlugged } from '../services/optimizer/ev-soc.js';

function setup({ type = 'openevse', status } = {}) {
  let t = 1_000_000;
  let reply = status || { ok: true, connected: true, charging: true, powerW: 10597.7, currentA: 15, vehicleSocPct: null };
  const cfg = { wallbox: { type }, optimizer: { evEvccLoadpoint: 1 } };
  const poller = createChargerStatusPoller({
    getCfg: () => cfg,
    getAdapter: () => ({ isConfigured: () => true, status: async () => (reply instanceof Error ? Promise.reject(reply) : reply) }),
    now: () => t,
  });
  return { poller, cfg, advance: (ms) => { t += ms; }, setReply: (r) => { reply = r; } };
}

test('OpenEVSE: steckt + lädt + Leistung kommen direkt von der Wallbox', async () => {
  const { poller } = setup();
  await poller.poll();
  assert.deepEqual(
    (({ connected, charging, powerW, type }) => ({ connected, charging, powerW, type }))(poller.fresh()),
    { connected: true, charging: true, powerW: 10598, type: 'openevse' });
});

test('resolveEvPlugged: Wallbox-Zustand hat Vorrang; evcc nicht erreichbar stört nicht', async () => {
  const { poller, cfg } = setup();
  await poller.poll();
  const ctx = { getCfg: () => cfg, chargerStatus: poller, evccIntegration: { getLoadpoints: () => [] } };
  assert.equal(resolveEvPlugged(ctx), true, 'vorher: null („Steckzustand unbekannt (evcc)“)');
});

test('Wallbox antwortet nicht mehr → nach 90 s veraltet → Rückfall auf evcc', async () => {
  const { poller, cfg, advance, setReply } = setup();
  await poller.poll();
  setReply({ ok: false, error: 'timeout' });
  advance(CHARGER_STATUS_MAX_AGE_MS - 1000); await poller.poll();
  assert.ok(poller.fresh(), 'kurzer Aussetzer: letzter gültiger Zustand gilt noch');
  advance(2000); await poller.poll();
  assert.equal(poller.fresh(), null);
  const ctx = { getCfg: () => cfg, chargerStatus: poller, evccIntegration: { getLoadpoints: () => [{ id: 1, connected: false }] } };
  assert.equal(resolveEvPlugged(ctx), false, 'evcc als Ersatzquelle');
  setReply(new Error('ECONNREFUSED')); await poller.poll();
  assert.equal(poller.raw().error, 'ECONNREFUSED');
});

test('evcc als Wallbox: kein eigener Abruf, Quelle bleibt evcc', async () => {
  const { poller, cfg } = setup({ type: 'evcc' });
  assert.equal(await poller.poll(), null);
  const ctx = { getCfg: () => cfg, chargerStatus: poller, evccIntegration: { getLoadpoints: () => [{ id: 1, connected: true }] } };
  assert.equal(resolveEvPlugged(ctx), true);
});

test('Wallbox-Typ gewechselt → alter Zustand gilt nicht mehr', async () => {
  const { poller, cfg } = setup();
  await poller.poll();
  cfg.wallbox.type = 'goe';
  assert.equal(poller.fresh(), null);
});
