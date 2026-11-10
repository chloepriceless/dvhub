import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createParagraph14aService, resolveParagraph14aConfig, parseRelayPayload,
} from '../services/paragraph14a/index.js';

function setup({ p14a = {}, optimizer = {}, gridTotalW = -0, batteryPowerW = 0, eebusDevices = [], evcc = null, evccConnected, clock } = {}) {
  const cfg = {
    gridPositiveMeans: 'grid_import',
    optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000, maxChargeW: 10000, ...optimizer },
    wallbox: { type: 'evcc' },
    paragraph14a: p14a,
  };
  const state = { ctrl: {}, victron: { batteryPowerW }, meter: { grid_total_w: gridTotalW } };
  const logs = [];
  const plug = { connected: evccConnected };
  const subs = new Map();
  const applied = [];
  const ctx = {
    state,
    getCfg: () => cfg,
    pushLog: (e, d) => logs.push([e, d]),
    mqttHub: { subscribe: (topic, fn) => subs.set(topic, fn) },
    evccIntegration: { getStatus: () => ({ loadpoints: [{ chargePowerW: evcc ?? 0, connected: plug.connected }] }) },
    eebus: {
      consumptionDevices: () => eebusDevices,
      applyConsumptionShares: (shares, until) => applied.push({ shares, until }),
    },
  };
  const svc = createParagraph14aService(ctx, { setInterval: () => 0, clearInterval: () => {}, ...(clock ? { now: () => clock.t } : {}) });
  return { svc, state, cfg, logs, subs, applied, eebusDevices, setConnected: (v) => { plug.connected = v; } };
}

test('Konfiguration: Vorgaben und ungültige Geräte', () => {
  const c = resolveParagraph14aConfig({ paragraph14a: { devices: [
    { name: 'WP', kind: 'waermepumpe', powerW: 6000 },
    { kind: 'toaster', powerW: 2000 },
    { kind: 'klima', powerW: 0 },
  ] } });
  assert.equal(c.devices.length, 1);
  assert.equal(c.allocation, 'priority');
  assert.equal(c.demandFirst, true, 'nach Bedarf ist Standard, auch für alte Konfigurationen ohne den Schlüssel');
  assert.equal(resolveParagraph14aConfig({ paragraph14a: { demandFirst: false } }).demandFirst, false);
  assert.equal(c.usePvSurplus, true);
  assert.equal(c.relay.enabled, false, 'ohne Thema kein Relais');
});

test('Relais-Nutzlast: Zahlen, Wörter, Venus-JSON', () => {
  assert.equal(parseRelayPayload('1'), 'high');
  assert.equal(parseRelayPayload('0'), 'low');
  assert.equal(parseRelayPayload('ON'), 'high');
  assert.equal(parseRelayPayload('off'), 'low');
  assert.equal(parseRelayPayload('{"value": 1}'), 'high');
  assert.equal(parseRelayPayload('{"value": true}'), 'high');
  assert.equal(parseRelayPayload('kaputt'), null);
});

test('ohne Vorgabe: nichts begrenzt, Mindestleistung trotzdem berechnet', () => {
  const s = setup();
  s.svc.update();
  assert.equal(s.state.p14a.active, false);
  assert.equal(s.state.p14a.pminW, 7560, 'Wallbox + Speicher');
  assert.equal(s.state.ctrl.p14aBatteryGridW, null);
  assert.equal(s.state.ctrl.p14aWallboxCapW, null);
});

test('EEBUS-Grenze: Budget nach Vorrang auf Wärmepumpe, Wallbox, Speicher', () => {
  const s = setup({
    p14a: { demandFirst: false },
    gridTotalW: 1000, // 1 kW Netzbezug (Haus), keine SteuVE aktiv
    eebusDevices: [{ id: 'eebus:hp', kind: 'waermepumpe', maxW: 3000, powerW: 0 }],
  });
  s.state.ctrl.eebusConsumptionLimitW = 7560;
  s.state.ctrl.eebusConsumptionLimitUntil = 123;
  s.svc.update();
  assert.equal(s.state.p14a.active, true);
  assert.equal(s.state.p14a.source, 'eebus');
  assert.equal(s.state.p14a.budgetW, 7560, 'kein PV-Überschuss');
  assert.deepEqual(s.state.p14a.shares, { 'eebus:hp': 3000, wallbox: 4500, speicher: 0 });
  assert.equal(s.state.ctrl.p14aWallboxCapW, 4500);
  assert.equal(s.state.ctrl.p14aBatteryGridW, 0);
  assert.deepEqual(s.applied.at(-1), { shares: { 'eebus:hp': 3000 }, until: 123 });
});

test('PV-Überschuss kommt zum Budget dazu', () => {
  // Netz −3000 W (Einspeisung), Wallbox lädt 2 kW → ohne SteuVE wären 5 kW Überschuss
  const s = setup({ gridTotalW: -3000, evcc: 2000 });
  s.state.ctrl.eebusConsumptionLimitW = 4200;
  s.svc.update();
  assert.equal(s.state.p14a.budgetW, 4200 + 5000);
});

test('Relais: gedimmt → Mindestleistung nach Formel, anteilig wenn eingestellt', () => {
  const s = setup({ p14a: { relay: { enabled: true, topic: 'steuerbox/relais' }, allocation: 'proportional', usePvSurplus: false, demandFirst: false } });
  s.svc.update();
  assert.ok(s.subs.has('steuerbox/relais'));
  assert.equal(s.state.p14a.active, false, 'unbekannter Zustand: nicht gedimmt');
  s.subs.get('steuerbox/relais')('steuerbox/relais', '1');
  assert.equal(s.state.p14a.active, true);
  assert.equal(s.state.p14a.source, 'relay');
  assert.equal(s.state.p14a.limitW, 7560);
  // anteilig 11000 : 10000 → 3960 / 3600 (auf 100 W abgerundet)
  assert.deepEqual(s.state.p14a.shares, { wallbox: 3900, speicher: 3600 });
  s.subs.get('steuerbox/relais')('steuerbox/relais', '0');
  assert.equal(s.state.p14a.active, false);
  assert.ok(s.logs.some(([e]) => e === 'paragraph14a_released'));
});

test('Relais „aktiv bei offen“ und EEBUS gleichzeitig: die kleinere Grenze gilt', () => {
  const s = setup({ p14a: { relay: { enabled: true, topic: 'r', activeWhen: 'low' } } });
  s.state.ctrl.eebusConsumptionLimitW = 5000;
  s.svc.update();
  s.subs.get('r')('r', '0');
  assert.equal(s.state.p14a.source, 'eebus', 'EEBUS 5000 W < Pmin 7560 W');
  assert.equal(s.state.p14a.limitW, 5000);
});

test('Geräte von Hand zählen für die Mindestleistung, werden aber nicht gesteuert', () => {
  const s = setup({ p14a: { devices: [{ id: 'wp', name: 'WP Keller', kind: 'waermepumpe', powerW: 6000 }] } });
  s.state.ctrl.eebusConsumptionLimitW = 10500;
  s.svc.update();
  assert.equal(s.state.p14a.pminW, 10500, 'Wallbox + Speicher + WP: 4,2 + 2·0,75·4,2');
  assert.equal(s.state.p14a.shares.wp, undefined);
  assert.equal(s.svc.summary().devices.find((d) => d.id === 'wp').controllable, false);
});

test('kleine Schwankungen des Budgets erreichen die Geräte nicht', () => {
  const s = setup({ gridTotalW: -1000, optimizer: { maxChargeW: 0 } });
  s.state.ctrl.eebusConsumptionLimitW = 4200;
  s.svc.update();
  const first = s.state.p14a.shares.wallbox;
  s.state.meter.grid_total_w = -1150;
  s.svc.update();
  assert.equal(s.state.p14a.shares.wallbox, first, '150 W mehr Überschuss: Anteil bleibt');
  s.state.meter.grid_total_w = -2000;
  s.svc.update();
  assert.equal(s.state.p14a.shares.wallbox, first + 1000);
});

test('Vorgabe unter der Mindestleistung: wird eingehalten und gemeldet', () => {
  const s = setup();
  s.state.ctrl.eebusConsumptionLimitW = 3800;
  s.svc.update();
  assert.equal(s.state.p14a.limitW, 3800, 'DVhub hält die Vorgabe ein (Ziffer 4.6)');
  assert.equal(s.state.p14a.belowPmin, true, 'Pmin 7560 W');
  assert.ok(s.logs.some(([e]) => e === 'paragraph14a_below_minimum'));
});

test('Hysterese hebt die Summe der Anteile nie über das Budget', () => {
  // Anteilig 11 000 : 10 000. 7560 W → 3900 / 3600. Sinkt die Grenze auf 7200 W,
  // liegen beide neuen Anteile (3700 / 3400) je 200 W unter den alten — die
  // Hysterese allein würde 3900 + 3600 = 7500 W > 7200 W stehen lassen.
  const s = setup({ p14a: { allocation: 'proportional', usePvSurplus: false, demandFirst: false } });
  s.state.ctrl.eebusConsumptionLimitW = 7560;
  s.svc.update();
  assert.deepEqual(s.state.p14a.shares, { wallbox: 3900, speicher: 3600 });
  s.state.ctrl.eebusConsumptionLimitW = 7200;
  s.svc.update();
  const sum = Object.values(s.state.p14a.shares).reduce((a, w) => a + w, 0);
  assert.ok(sum <= 7200, `Summe ${sum} W über der Grenze 7200 W`);
});

// ── Nach Bedarf (pv magazine 09.11.2026): der Praxisfall mit Wärmepumpe und Wallbox ──
function articleSetup(extra = {}) {
  const clock = { t: 1_000_000 };
  const s = setup({
    clock,
    evcc: 4200,
    evccConnected: true,
    eebusDevices: [{ id: 'eebus:hp', kind: 'waermepumpe', maxW: 5500, powerW: 1500 }],
    ...extra,
  });
  // Haus 1 kW + Wärmepumpe 1,5 kW + Wallbox 4,2 kW aus dem Netz: kein PV-Überschuss
  s.state.meter.grid_total_w = 1000 + 1500 + 4200;
  s.state.ctrl.eebusConsumptionLimitW = 7560;
  return { ...s, clock };
}

test('nach Bedarf: Wärmepumpe mit 1,5 kW bekommt ihren Bedarf, nicht 5,5 kW — die Wallbox den Rest', () => {
  const s = articleSetup();
  s.svc.update();
  // WP 1500 + 550 Reserve; Wallbox 4200 + 1100; Speicher steht (Reserve 1000) bekommt den Rest
  assert.deepEqual(s.state.p14a.shares, { 'eebus:hp': 2000, wallbox: 5300, speicher: 200 });
  assert.equal(s.state.ctrl.p14aWallboxCapW, 5300);
  assert.equal(s.svc.summary().devices.find((d) => d.id === 'eebus:hp').needW, 2050);
  const sum = Object.values(s.state.p14a.shares).reduce((a, w) => a + w, 0);
  assert.ok(sum <= 7560);
});

test('nach Bedarf: steigt der Bedarf der Wärmepumpe, bekommt sie ihren Anteil im nächsten Takt zurück', () => {
  const s = articleSetup();
  s.svc.update();
  // WP läuft an ihrer Grenze (2 kW) → Bedarf 2,55 kW, Vorrang Wärme
  s.eebusDevices[0].powerW = 2000;
  s.state.meter.grid_total_w = 1000 + 2000 + 4200;
  s.clock.t += 5_000;
  s.svc.update();
  assert.equal(s.state.p14a.shares['eebus:hp'], 2500);
  assert.equal(s.state.p14a.shares.wallbox, 5000);
});

test('nach Bedarf: sinkender Bedarf wird erst nach 60 s weitergegeben (kein Flattern)', () => {
  const s = articleSetup();
  s.svc.update();
  s.eebusDevices[0].powerW = 300; // kurz abgetaut
  s.state.meter.grid_total_w = 1000 + 300 + 4200;
  s.clock.t += 5_000;
  s.svc.update();
  assert.equal(s.state.p14a.shares['eebus:hp'], 2000, 'Anteil bleibt');
  s.clock.t += 61_000;
  s.svc.update();
  // dann Anlaufreserve 30 % von 5,5 kW = 1650 W
  assert.equal(s.state.p14a.shares['eebus:hp'], 1600);
});

test('nach Bedarf: ohne Auto bekommt die Wallbox nichts vorab; steckt eins an, die Anlaufstufe 6 A', () => {
  const s = articleSetup({ evcc: 0, evccConnected: false, batteryPowerW: 3000 });
  s.state.meter.grid_total_w = 1000 + 1500 + 3000;
  s.svc.update();
  assert.equal(s.state.p14a.shares.wallbox, 0);
  assert.equal(s.state.p14a.shares.speicher, 4000, 'Speicher lädt 3 kW: Bedarf 4 kW');
  // Auto steckt an
  s.clock.t += 5_000;
  s.setConnected(true);
  s.svc.update();
  assert.ok(s.state.p14a.shares.wallbox >= 4100, `Wallbox ${s.state.p14a.shares.wallbox} W`);
});

test('nach Bedarf: Gerät ohne Messwert bekommt seine volle Leistung zugeteilt (wie bisher)', () => {
  const s = articleSetup({ eebusDevices: [{ id: 'eebus:hp', kind: 'waermepumpe', maxW: 5500, powerW: null }] });
  s.svc.update();
  assert.equal(s.state.p14a.shares['eebus:hp'], 5500);
});

test('EEBUS-Hauptwallbox zählt einmal als Ladepunkt, nicht zusätzlich als EEBUS-Gerät', () => {
  const SKI = 'e'.repeat(40);
  const s = setup({
    optimizer: { eosOptimizeEv: false },
    eebusDevices: [{ id: `eebus:${SKI}`, ski: SKI, kind: 'ladepunkt', maxW: 11000, powerW: 0 }],
  });
  s.cfg.wallbox = { type: 'eebus', eebus: { ski: SKI } };
  s.svc.update();
  const lp = s.svc.summary().devices.filter((d) => d.kind === 'ladepunkt');
  assert.deepEqual(lp.map((d) => d.id), ['wallbox'], 'eine Wallbox, eine SteuVE');
  // Wallbox + Speicher: 4,2 + 0,8 · 4,2 (nicht 10,5 kW mit einer dritten SteuVE)
  assert.equal(s.state.p14a.pminW, 7560);
});
