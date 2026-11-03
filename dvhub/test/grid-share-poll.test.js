// test/grid-share-poll.test.js — Netzstrom-Zähler im Poll-Pfad
// (services/optimizer/grid-share-poll.js, Gesamtprüfung Release 1.0.9).
//
// Befund 3: ohne eingestellte Akkukapazität rechnete der Zähler mit erfundenen
// 8000 Wh und kappte einen 40-kWh-Akku voller Netzstrom auf ~5,7 kWh.
// Befund 7: der Zähler hing am echten onPollComplete, der erst nach Datenbank,
// Migrationen und Snapshots eingehängt wird — bis dahin fehlte jede Netzladung.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGridShareTracker } from '../services/optimizer/grid-share.js';
import { createGridSharePollTick, gridShareCapacityInput } from '../services/optimizer/grid-share-poll.js';

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-grid-share-poll-'));

function setup({ capacityWh } = {}) {
  const dir = mkDir();
  const logs = [];
  const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true, ...(capacityWh ? { batteryCapacityWh: capacityWh } : {}) } };
  const state = { victron: { soc: 20 } };
  const ctx = { state, getCfg: () => cfg, pushLog: (event, data, level) => logs.push({ event, data, level }) };
  ctx.gridShare = createGridShareTracker({ getCfg: () => cfg, pushLog: ctx.pushLog, dataDir: dir });
  const tickPoll = createGridSharePollTick(ctx);
  return { dir, logs, state, ctx, tickPoll, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Ablauf aus dem Befund: 40-kWh-Akku, 20 kWh Netzstrom (20 % → 70 %), dann
// 6 kWh Entladung ins Netz. Sekündlich wie polling.js.
function chargeThenDischarge({ state, tickPoll }, t0) {
  let now = t0;
  // 20 kWh mit 10 kW = 2 h; der Ladestand steigt dabei von 20 auf 70 %.
  for (let s = 0; s <= 7200; s += 1) {
    now = t0 + s * 1000;
    state.victron.soc = Math.round(20 + 50 * (s / 7200));
    tickPoll({ gridToBatteryW: 10_000, gridImportW: 10_000, batteryPowerW: 10_000 }, now);
  }
  // 6 kWh mit 6 kW = 1 h Entladung (70 % → 55 %), danach 2 min Ruhe.
  for (let s = 1; s <= 3600; s += 1) {
    now += 1000;
    state.victron.soc = Math.round(70 - 15 * (s / 3600));
    tickPoll({ batteryToGridW: 6_000, batteryPowerW: -6_000 }, now);
  }
  for (let s = 1; s <= 120; s += 1) { now += 1000; tickPoll({ batteryPowerW: 0 }, now); }
}

test('Befund 3: Kapazität fehlt → keine Ersatzzahl, kein Kappen, kein Abbuchen, Sperre bleibt, Meldung in Log und Status', () => {
  assert.deepEqual(gridShareCapacityInput({ state: { victron: { soc: 50 } } }, { optimizer: {} }),
    { capacityWh: null, socPct: null, capacityMissing: true });
  const s = setup();
  try {
    chargeThenDischarge(s, Date.now() - 4 * 3600_000);
    const sum = s.ctx.gridShare.summary();
    // Mit den früheren 8000 Wh: auf (70 % + 1 %) × 8000 ≈ 5,7 kWh gekappt, danach
    // abgebucht — die Sperre fiel nach ~5,7 kWh, rund 14 kWh Netzstrom blieben
    // ungezählt im Akku.
    assert.ok(sum.gridWh >= 19_900, `Netzstrom bleibt gezählt: ${sum.gridWh} Wh`);
    assert.equal(sum.locked, true);
    assert.equal(sum.capacityMissing, true);
    assert.equal(sum.sharePct, null, 'ohne Kapazität kein Anteil');
    assert.equal(s.logs.filter((l) => l.event === 'grid_share_capacity_missing').length, 1, 'einmal gemeldet');
  } finally { s.cleanup(); }
});

test('Befund 3: echte Kapazität (40 kWh) → richtig gekappt und anteilig abgebucht', () => {
  const s = setup({ capacityWh: 40_000 });
  try {
    chargeThenDischarge(s, Date.now() - 4 * 3600_000);
    const sum = s.ctx.gridShare.summary();
    // 20 kWh Netzstrom bei 28 kWh Inhalt (70 %): Anteil ≈ 71 %, 6 kWh Entladung
    // nehmen ~4,3 kWh Netzstrom mit — es bleiben ~15,7 kWh, Sperre an.
    assert.ok(sum.gridWh > 15_000 && sum.gridWh < 16_500, `anteilig abgebucht: ${sum.gridWh} Wh`);
    assert.equal(sum.locked, true);
    assert.equal(sum.capacityMissing, false);
    assert.equal(s.logs.filter((l) => l.event === 'grid_share_capacity_missing').length, 0);
  } finally { s.cleanup(); }
});

test('Befund 3: Kapazität wird nachgetragen → Meldung endet, Zähler rechnet ab dann mit ihr', () => {
  const s = setup();
  try {
    const t0 = Date.now() - 600_000;
    s.tickPoll({}, t0);
    s.tickPoll({}, t0 + 1000);
    assert.equal(s.ctx.gridShare.summary().capacityMissing, true);
    s.ctx.getCfg().optimizer.batteryCapacityWh = 40_000;
    s.tickPoll({}, t0 + 2000);
    assert.equal(s.ctx.gridShare.summary().capacityMissing, false);
    assert.ok(s.logs.some((l) => l.event === 'grid_share_capacity_known'));
  } finally { s.cleanup(); }
});

test('Befund 7: der Poller zählt ab der ersten Abfrage — auch ohne echten onPollComplete', async () => {
  const { createPoller } = await import('../polling.js');
  const { createMqttTransport } = await import('../transport-mqtt.js');
  const tr = createMqttTransport({ host: '', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub', staleMaxAgeMs: 0 } });
  tr.ingest('grid_total', 6_000);
  tr.ingest('battery_power', 6_000);
  tr.ingest('battery_soc', 50);
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-03', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
  };
  const ticks = [];
  const poller = createPoller({
    state,
    getCfg: () => ({
      pollMs: 500, gridPositiveMeans: 'grid_import',
      points: { soc: { enabled: true }, batteryPowerW: { enabled: true } },
      epex: { timezone: 'UTC' }, userEnergyPricing: {}, dvControl: {},
    }),
    transport: tr, pushLog: () => {},
    energyPath: path.join(os.tmpdir(), `grid-share-poll-${process.pid}.json`),
    // Wie server.js vor der Datenbank: nur der leere Platzhalter.
    onPollComplete: () => {},
    gridSharePollTick: (victron) => { ticks.push({ ...victron }); return null; },
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  await poller.requestPoll();
  assert.equal(ticks.length, 1, 'Zähler-Schritt bei der ersten Abfrage');
  assert.ok(ticks[0].gridToBatteryW > 0, 'mit den Energieflüssen dieser Abfrage');
});

test('Befund 7: server.js hängt den Zähler-Schritt vor dem Poller ein, nicht in den echten onPollComplete', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const assign = src.indexOf('ctx.gridSharePollTick = createGridSharePollTick(ctx)');
  const poller = src.indexOf('const poller = createPoller(ctx)');
  assert.ok(assign > 0 && poller > 0 && assign < poller, 'vor createPoller');
  assert.equal(/ctx\.gridShare\?\.tick\?\.\(/.test(src), false, 'kein zweiter Zähler-Schritt im onPollComplete');
});

test('Befund 7: Sperrwechsel vor der Datenbank werden vorgemerkt und nach telemetryReady nachgetragen (Gegenprüfung 0bd0577a, P3)', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const queue = src.indexOf('const pendingGridShareEvents = []');
  const tracker = src.indexOf('ctx.gridShare = createGridShareTracker(');
  assert.ok(queue > 0 && queue < tracker, 'Vormerkliste vor dem Zähler angelegt');
  assert.match(src, /if \(!telemetryStore && !telemetryInitDone\) \{\s*if \(pendingGridShareEvents\.length < 20\) pendingGridShareEvents\.push\(event\);/);
  const ready = src.indexOf('telemetryStore = await createTelemetryStoreIfEnabled();');
  const flush = src.indexOf('for (const event of pendingGridShareEvents.splice(0))');
  assert.ok(ready > 0 && flush > ready, 'nachgetragen, sobald die Datenbank da ist');
});

test('Befund 3: das Börsenautomatik-Feld (Standard 30 kWh) gilt nicht als Akkukapazität', () => {
  const cfg = { optimizer: {}, schedule: { smallMarketAutomation: { batteryCapacityKwh: 30 } } };
  assert.equal(gridShareCapacityInput({ state: { victron: { soc: 50 } } }, cfg).capacityMissing, true);
});
