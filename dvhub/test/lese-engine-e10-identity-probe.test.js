// E10 (Lese-Engine, 19.11.2026): Kennungsprobe — antwortet das Gerät, für das die Registerkarte des Profils gilt?
// Profil: `victron.identityProbe = { checks: [{ fc, address, equals | range | prefix, … }], hideOnMismatch, everyMs }`.
// Ergebnis in state.victron.identityProbe, im Status (Hinweisleiste) und im Log. Passt die Kennung nicht, bleiben die
// unter hideOnMismatch genannten Werte leer statt falsch (kein Lesen am fremden Gerät). Keine Wirkung auf Writes oder
// das Schreibtor — kein Sperrzustand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

import {
  normalizeIdentityProbe, runIdentityProbe, decodeRegisterString,
} from '../services/inverter/identity-probe.js';
import { buildVictronSnapshot } from '../runtime-state.js';
import { createScheduleEvaluator } from '../schedule-eval.js';
import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';

const E3DC = 0xe3dc;
const PROBE = {
  checks: [{ label: 'E3/DC-Kennung', fc: 3, address: 40000, equals: [E3DC] }],
  hideOnMismatch: ['meter', 'pvPowerW', 'batteryPowerW', 'soc'],
};
const p = (address, extra = {}) => ({ enabled: true, fc: 3, unitId: 1, address, quantity: 1, scale: 1, offset: 0, ...extra });

// E3/DC-artiges Gerät: Kennung 40000, Zähler 40073 (int32), PV 40067, Akku 40069, SoC 40082; Gerätegrenze 500
// (nicht in hideOnMismatch).
function device({ magic = E3DC } = {}) {
  const dev = createRegisterDevice();
  if (magic != null) dev.set(40000, magic);
  return dev.set32(40073, 1200).set32(40067, 5400).set32(40069, -800).set(40082, 71).set(500, 4600);
}
function cfgWith(probe = PROBE) {
  return {
    victron: { host: '192.0.2.10', port: 502, unitId: 1, ...(probe ? { identityProbe: probe } : {}) },
    meter: { layout: 'point', fc: 3, unitId: 1, address: 40073, quantity: 2, readType: 'int32' },
    points: {
      pvPowerW: p(40067, { quantity: 2, readType: 'int32' }),
      batteryPowerW: p(40069, { quantity: 2, readType: 'int32' }),
      soc: p(40082),
      deviceMaxDischargeW: p(500),
    },
  };
}
const addrs = (dev) => dev.requests.map((r) => r.address);

// --- Profilblock -------------------------------------------------------------------------------------------------

test('E10: normalizeIdentityProbe — gültiger Block mit Standardwerten', () => {
  const n = normalizeIdentityProbe(PROBE);
  assert.equal(n.everyMs, 600000);
  assert.deepEqual(n.hideOnMismatch, ['meter', 'pvPowerW', 'batteryPowerW', 'soc']);
  assert.equal(n.checks[0].kind, 'equals');
  assert.equal(n.checks[0].quantity, 1);
  assert.deepEqual(normalizeIdentityProbe({ checks: [{ fc: 4, address: 5, range: [0, 0] }] }).hideOnMismatch, []);
});

test('E10: Profilfehler in der Kennungsprobe werden klar benannt', () => {
  const bad = (raw, re) => assert.throws(() => normalizeIdentityProbe(raw), re);
  bad(null, /identityProbe muss ein Objekt/);
  bad({}, /checks braucht mindestens eine Prüfung/);
  bad({ checks: [] }, /checks braucht mindestens eine Prüfung/);
  bad({ checks: [{ fc: 3, equals: [1] }] }, /checks\[0\]\.address/);
  bad({ checks: [{ address: 1, equals: [1] }] }, /checks\[0\]\.fc muss 3 oder 4/);
  bad({ checks: [{ fc: 6, address: 1, equals: [1] }] }, /fc muss 3 oder 4/);
  bad({ checks: [{ fc: 3, address: 1 }] }, /genau eine Bedingung/);
  bad({ checks: [{ fc: 3, address: 1, equals: [1], range: [0, 2] }] }, /genau eine Bedingung/);
  bad({ checks: [{ fc: 3, address: 1, equals: [] }] }, /equals muss eine nicht leere Liste/);
  bad({ checks: [{ fc: 3, address: 1, equals: ['1'] }] }, /equals muss eine nicht leere Liste/);
  bad({ checks: [{ fc: 3, address: 1, range: [5, 1] }] }, /range muss \[min, max\]/);
  bad({ checks: [{ fc: 3, address: 1, prefix: 'SolarEdge' }] }, /quantity .* fehlt/);
  bad({ checks: [{ fc: 3, address: 1, prefix: 'SolarEdge', quantity: 2 }] }, /länger als 2 Register/);
  bad({ checks: [{ fc: 3, address: 1, equals: [1], readType: 'float32' }] }, /nur uint32 oder int32/);
  bad({ checks: [{ fc: 3, address: 1, equals: [1], quantity: 2 }] }, /quantity 2 passt nicht/);
  bad({ checks: [{ fc: 3, address: 1, equals: [1], unitId: 300 }] }, /unitId 300/);
  bad({ ...PROBE, hideOnMismatch: 'meter' }, /hideOnMismatch muss eine Liste/);
  bad({ ...PROBE, hideOnMismatch: [''] }, /hideOnMismatch muss eine Liste/);
  bad({ ...PROBE, everyMs: 1000 }, /everyMs muss zwischen/);
  bad({ checks: Array.from({ length: 9 }, () => ({ fc: 3, address: 1, equals: [1] })) }, /höchstens 8/);
});

// --- Bewertung ---------------------------------------------------------------------------------------------------

test('E10: runIdentityProbe — equals, range, uint32, Text-Präfix; „passt nicht“ schlägt „nicht lesbar“', async () => {
  const dev = createRegisterDevice()
    .set(1, 7).set32(10, 70000).setWords(20, [0x536f, 0x6c61, 0x7245, 0x6467, 0x6520, 0x2000, 0, 0]); // "SolarEdge  "
  const read = (c) => dev.mbRequest(c);
  const ok = await runIdentityProbe(normalizeIdentityProbe({ checks: [
    { fc: 3, address: 1, range: [5, 9] },
    { fc: 3, address: 10, readType: 'uint32', equals: [70000] },
    { fc: 3, address: 20, quantity: 8, prefix: 'SolarEdge' },
  ] }), read);
  assert.equal(ok.status, 'ok', ok.text);
  assert.deepEqual(ok.checks.map((c) => c.value), [7, 70000, 'SolarEdge']);
  assert.deepEqual(ok.hidden, []);

  const mixed = await runIdentityProbe(normalizeIdentityProbe({ checks: [
    { fc: 3, address: 99, equals: [1] },                      // fehlt → nicht lesbar
    { fc: 3, address: 1, equals: [3, 4], label: 'Typ' },      // 7 → passt nicht
  ], hideOnMismatch: ['pvPowerW', 'meter'] }), read);
  assert.equal(mixed.status, 'mismatch');
  assert.deepEqual(mixed.hidden, ['pvPowerW', 'meter']);
  assert.match(mixed.text, /Typ: Register 1 = 7 \(0x0007\), erwartet 3 \(0x0003\) oder 4 \(0x0004\)/);
  assert.match(mixed.text, /nicht angezeigt: PV, Netz/);
  assert.equal(mixed.checks[0].ok, null);
  assert.match(mixed.checks[0].error, /exception 2/);

  const unreadable = await runIdentityProbe(normalizeIdentityProbe({ checks: [{ fc: 4, address: 1, equals: [7] }] }), read);
  assert.equal(unreadable.status, 'unreadable', 'FC 4 hat das Gerät nicht');
  assert.match(unreadable.text, /nicht lesbar .*ungeprüft angezeigt/);
});

test('E10: Registertext — High-Byte zuerst, endet am ersten NUL, Leerzeichen am Ende zählen nicht', () => {
  assert.equal(decodeRegisterString([0x4c47, 0x2045, 0x4c45, 0x4354, 0x2e00, 0x4141]), 'LG ELECT.');
  assert.equal(decodeRegisterString([0x4142, 0x2020]), 'AB');
  assert.equal(decodeRegisterString([0, 0x4142]), '');
});

// --- Poller ------------------------------------------------------------------------------------------------------

test('E10: Kennung passt → alle Werte, Probe einmal gelesen und nicht in jedem Takt', async () => {
  const dev = device();
  const { state, poller, logs } = createPollerRig(cfgWith(), dev);
  await poller.requestPoll();
  await poller.requestPoll();
  const id = state.victron.identityProbe;
  assert.equal(id.status, 'ok', id.text);
  assert.ok(id.checkedAt > 0);
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, 1200);
  assert.equal(state.victron.pvPowerW, 5400);
  assert.equal(state.victron.batteryPowerW, -800);
  assert.equal(state.victron.soc, 71);
  assert.equal(addrs(dev).filter((a) => a === 40000).length, 1, 'zweiter Takt ohne erneute Probe');
  assert.equal(addrs(dev)[0], 40000, 'die Probe kommt vor dem ersten Wert');
  assert.ok(logs.some((l) => l.event === 'identity_probe_ok'));
});

test('E10: Kennung passt nicht → genannte Werte leer statt falsch, nicht gelesen; Rest wie bisher; ein Log je Wechsel', async () => {
  const dev = device({ magic: 0x5375 }); // SunSpec-Mode: „SunS“ statt 0xE3DC
  const cfg = cfgWith();
  const { state, poller, logs } = createPollerRig(cfg, dev);
  // Vorher gelesene Werte (etwa aus einer Zeit vor einer Umstellung) dürfen nicht stehen bleiben.
  Object.assign(state.victron, { pvPowerW: 9999, soc: 50 });
  state.victron.fieldUpdatedAt.pvPowerW = Date.now();
  Object.assign(state.meter, { ok: true, grid_total_w: 777, consecutiveErrors: 2 });
  await poller.requestPoll();
  await poller.requestPoll();

  const id = state.victron.identityProbe;
  assert.equal(id.status, 'mismatch');
  assert.deepEqual(id.hidden, ['meter', 'pvPowerW', 'batteryPowerW', 'soc']);
  assert.match(id.text, /E3\/DC-Kennung: Register 40000 = 21365 \(0x5375\), erwartet 58332 \(0xE3DC\)/);
  assert.match(id.text, /nicht angezeigt: Netz, PV, Akku, Ladestand/);

  for (const k of ['pvPowerW', 'batteryPowerW', 'soc']) {
    assert.equal(state.victron[k], null, `${k} leer`);
    assert.match(state.victron.errors[k], /Kennungsprobe passt nicht/);
  }
  assert.equal(state.victron.fieldUpdatedAt.pvPowerW, undefined, 'kein Frische-Stempel für einen ausgeblendeten Wert');
  assert.equal(state.victron.deviceMaxDischargeW, 4600, 'nicht genannter Wert wird weiter gelesen');
  assert.equal(state.meter.ok, false);
  assert.match(state.meter.error, /Kennungsprobe passt nicht/);
  assert.deepEqual([state.meter.grid_total_w, state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [null, null, null, null]);
  assert.equal(state.meter.consecutiveErrors, 0, 'kein Verbindungsfehler — kein Backoff');
  assert.equal(state.victron.gridImportW, 0);
  assert.equal(state.victron.gridExportW, 0);
  assert.deepEqual([...new Set(addrs(dev))].sort((a, b) => a - b), [500, 40000],
    'am fremden Gerät nur Kennung und nicht genannte Register gelesen');
  assert.equal(logs.filter((l) => l.event === 'identity_probe_mismatch').length, 1);
  assert.equal(logs.find((l) => l.event === 'identity_probe_mismatch').level, 'warn');
});

test('E10: abgeleitete Hauslast (energy_balance) in hideOnMismatch → leer, keine Ableitung; ohne Nennung läuft sie', async () => {
  const cfg = cfgWith({ ...PROBE, hideOnMismatch: ['selfConsumptionW'] });
  cfg.points.selfConsumptionW = { enabled: false, derive: 'energy_balance' };
  const dev = device({ magic: 1 });
  const { state, poller } = createPollerRig(cfg, dev);
  state.victron.selfConsumptionW = 1234;
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'mismatch');
  assert.equal(state.victron.selfConsumptionW, null);
  assert.match(state.victron.errors.selfConsumptionW, /Kennungsprobe passt nicht/);
  assert.equal(state.victron.pvPowerW, 5400, 'nicht genannt → gelesen');

  cfg.victron.identityProbe = { ...PROBE, hideOnMismatch: ['soc'] };
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 7400, 'PV 5400 + Bezug 1200 − Akku (−800)');
  assert.equal(state.victron.errors.selfConsumptionW, undefined);
});

test('E10: nach „passt nicht“ alle 60 s neu; passt die Kennung wieder, sind die Werte sofort da', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const dev = device({ magic: 0x5375 });
  const { state, poller } = createPollerRig(cfgWith(), dev);
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'mismatch');
  dev.set(40000, E3DC);
  mock.timers.tick(30_000);
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'mismatch', 'vor Ablauf der 60 s keine neue Probe');
  mock.timers.tick(31_000);
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'ok');
  assert.equal(state.victron.pvPowerW, 5400);
  assert.equal(state.victron.errors.pvPowerW, undefined);
  assert.equal(state.meter.ok, true);
  assert.equal(state.meter.grid_total_w, 1200);
});

test('E10: nach „bestanden“ erst nach everyMs neu; ein nicht lesbarer Nachtest ändert ein festgestelltes Ergebnis nicht', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const dev = device();
  const { state, poller } = createPollerRig(cfgWith({ ...PROBE, everyMs: 120_000 }), dev);
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'ok');
  const probes = () => addrs(dev).filter((a) => a === 40000).length;
  mock.timers.tick(119_000);
  await poller.requestPoll();
  assert.equal(probes(), 1);
  mock.timers.tick(2_000);
  const orig = dev.mbRequest;
  dev.mbRequest = async (c) => (c.address === 40000 ? Promise.reject(new Error('modbus timeout')) : orig(c));
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'ok', 'Zeitüberschreitung beim Nachtest: bleibt bestanden');
  assert.match(state.victron.identityProbe.recheckError, /nicht lesbar.*modbus timeout/);
  assert.equal(state.victron.pvPowerW, 5400);
  dev.mbRequest = orig;
  dev.set(40000, 1);
  mock.timers.tick(61_000);
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'mismatch', 'Nachtest nach 60 s erkennt das fremde Gerät');
  assert.equal(state.victron.pvPowerW, null);
});

test('E10: noch nie lesbar → Hinweis „nicht lesbar“, Werte ungeprüft angezeigt (nichts ausgeblendet)', async () => {
  const dev = device({ magic: null });
  const { state, poller, logs } = createPollerRig(cfgWith(), dev);
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'unreadable');
  assert.equal(state.victron.pvPowerW, 5400);
  assert.equal(state.meter.ok, true);
  assert.ok(logs.some((l) => l.event === 'identity_probe_unreadable' && l.level === 'warn'));
});

test('E10: Adress- oder Profilwechsel → sofort neue Probe; ungültiger Block → Hinweis, nichts ausgeblendet', async () => {
  const dev = device({ magic: 0x5375 });
  const cfg = cfgWith();
  const { state, poller, logs } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'mismatch');
  cfg.victron.identityProbe = { ...PROBE, checks: [{ fc: 3, address: 40000, equals: [0x5375] }] };
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'ok', 'geänderter Block wird sofort geprüft');
  assert.equal(state.victron.pvPowerW, 5400);
  cfg.victron.identityProbe = { checks: [{ fc: 3, address: 40000 }], hideOnMismatch: ['pvPowerW'] };
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'invalid');
  assert.match(state.victron.identityProbe.text, /Kennungsprobe im Herstellerprofil ungültig: checks\[0\] braucht genau eine Bedingung/);
  assert.equal(state.victron.pvPowerW, 5400);
  assert.ok(logs.some((l) => l.event === 'identity_probe_invalid'));
  delete cfg.victron.identityProbe;
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe, undefined, 'Block entfernt → kein Ergebnis mehr');
});

test('E10: Probe auf eigener Unit-ID und FC 4; andere Verbindungsdaten von victron.*', async () => {
  const dev = createRegisterDevice().set(33000, 0x2030, { unitId: 7, fc: 4 }).setWords(900, [0, 0, 0]);
  const cfg = {
    victron: { host: '192.0.2.11', port: 1502, unitId: 1, timeoutMs: 1234, identityProbe: { checks: [{ fc: 4, unitId: 7, address: 33000, equals: [0x2030] }] } },
    meter: { fc: 3, address: 900, quantity: 3, unitId: 1 },
  };
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe.status, 'ok', state.victron.identityProbe.text);
  const req = dev.requests.find((r) => r.address === 33000);
  assert.deepEqual([req.unitId, req.fc, req.host, req.port, req.timeoutMs], [7, 4, '192.0.2.11', 1502, 1234]);
});

// --- Null-Änderung, Anzeige, Schreibwege --------------------------------------------------------------------------

test('E10: ohne Kennungsprobe keine zusätzliche Anfrage und kein Ergebnis; über MQTT keine Probe', async () => {
  const dev = device();
  const { state, poller } = createPollerRig(cfgWith(null), dev);
  await poller.requestPoll();
  assert.equal(state.victron.identityProbe, undefined);
  assert.ok(!addrs(dev).includes(40000));
  const mqtt = { type: 'mqtt', readPoint: async () => ({ mqttValue: 1 }), readGrid: () => ({ total: 0, l1: 0, l2: 0, l3: 0 }), mbRequest: async () => { throw new Error('kein Modbus'); } };
  const r = createPollerRig(cfgWith(), mqtt);
  await r.poller.requestPoll();
  assert.equal(r.state.victron.identityProbe, undefined);
});

test('E10: das Ergebnis reist im IPC-Schnappschuss', async () => {
  const { state, poller } = createPollerRig(cfgWith(), device({ magic: 1 }));
  await poller.requestPoll();
  const snap = buildVictronSnapshot(state.victron);
  assert.equal(snap.identityProbe.status, 'mismatch');
  assert.deepEqual(snap.identityProbe.hidden, ['meter', 'pvPowerW', 'batteryPowerW', 'soc']);
});

test('E10: keine Wirkung auf Writes — Evaluator schreibt mit „passt nicht“ genau dasselbe wie ohne Probe', async () => {
  const writesWith = async (identityProbe) => {
    const state = {
      victron: { soc: 55, ...(identityProbe ? { identityProbe } : {}) },
      meter: { ok: true, grid_total_w: -3000, updatedAt: Date.now() },
      ctrl: {},
      schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    };
    const writes = [];
    const cfg = {
      victron: { host: '192.0.2.12', port: 502, unitId: 1, identityProbe: PROBE },
      controlWrite: { gridSetpointW: { enabled: true, fc: 16, address: 1111, writeType: 'int16', scale: 1, offset: 0, host: '192.0.2.12', port: 502, unitId: 1 } },
      dvControl: { enabled: true },
    };
    const ev = createScheduleEvaluator({
      state, getCfg: () => cfg,
      transport: {
        type: 'modbus',
        async mbRequest({ quantity = 1 }) { return Array.from({ length: quantity }, () => 0); },
        async mbWriteSingle({ address, value }) { writes.push([address, value]); },
        async mbWriteMultiple({ address, values }) { writes.push([address, values]); },
      },
      pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {},
      epexNowNext: () => ({ current: { ct_kwh: 10 } }),
      regenerateSmallMarketAutomationRules: async () => {},
    });
    const r = await ev.applyControlTarget('gridSetpointW', -500, 'api');
    return { ok: r?.ok, writes };
  };
  const plain = await writesWith(null);
  const mismatch = await writesWith({ status: 'mismatch', hidden: ['meter', 'pvPowerW'], text: 'Kennungsprobe passt nicht' });
  assert.ok(plain.writes.length > 0, 'Prüfstand sieht den Write');
  assert.deepEqual(mismatch, plain);
});
