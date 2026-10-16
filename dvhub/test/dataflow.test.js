// test/dataflow.test.js — Datenfluss-Übersicht (2026-10-16, Feldfall BIGGE: Loxone per HTTP-Push).
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDataflow, plausibilityChecks } from '../services/dataflow.js';

const NOW = Date.parse('2026-10-16T12:00:00Z');

function pushTransport(status) {
  return { type: 'mqtt', schema: 'dvhub', brokerMode: 'push-only', staleMaxAgeMs: 90_000, inputStatus: () => status };
}

const cfgLoxone = {
  manufacturer: 'dvhub-mqtt',
  forecast: { pv: { totalKwp: 36 } },
  optimizer: { maxChargeW: 34000, maxDischargeW: 34000 },
  points: { selfConsumptionW: { enabled: true, derive: 'energy_balance' } },
};

test('Eingänge aus HTTP-Push: Feldname, Topic, Wert, frisch / veraltet / fehlt', () => {
  const df = buildDataflow({
    cfg: cfgLoxone,
    state: { victron: {}, meter: {} },
    transport: pushTransport({
      grid_total: { topic: 'dvhub/input/grid/total_w', value: -7, ageMs: 1900, fresh: true },
      pv_total: { topic: 'dvhub/input/pv/total_w', value: 10271, ageMs: 200_000, fresh: false },
      grid_l1: { topic: 'dvhub/input/grid/l1_w', value: null, ageMs: null, fresh: false },
    }),
    now: NOW,
  });
  assert.equal(df.in.source.kind, 'http_push');
  assert.equal(df.in.source.endpoint, '/api/input/push');
  const byKey = Object.fromEntries(df.in.inputs.map((i) => [i.key, i]));
  assert.equal(byKey.grid_total.pushField, 'grid_w');
  assert.equal(byKey.grid_total.label, 'Netz gesamt (Bezug +)');
  assert.equal(byKey.grid_total.fresh, true);
  assert.equal(byKey.pv_total.received, true);
  assert.equal(byKey.pv_total.fresh, false);
  assert.equal(byKey.grid_l1.received, false);
  assert.ok(df.checks.some((c) => c.key === 'pv_total' && /veraltet/.test(c.text)));
});

test('Prüfung: PV über 120 % der kWp → Warnung (die 33,5-kW-Sprünge bei 36 kWp liegen darunter, 52 kW darüber)', () => {
  const state = (pv) => ({ victron: { pvTotalW: pv } });
  assert.equal(plausibilityChecks({ cfg: cfgLoxone, state: state(33_500) }).some((c) => c.key === 'pvTotalW'), false);
  const warn = plausibilityChecks({ cfg: cfgLoxone, state: state(52_400) }).find((c) => c.key === 'pvTotalW');
  assert.equal(warn.level, 'warn');
  assert.match(warn.text, /36 kWp/);
});

test('Prüfung: Ladestand außerhalb 0–100 % ist ein Fehler, Akku-Leistung weit über der Grenze eine Warnung', () => {
  const checks = plausibilityChecks({ cfg: cfgLoxone, state: { victron: { soc: 655.35, batteryPowerW: 60_000 } } });
  assert.equal(checks.find((c) => c.key === 'soc').level, 'error');
  assert.equal(checks.find((c) => c.key === 'batteryPowerW').level, 'warn');
});

test('Prüfung: Energiebilanz nur bei gemessenem Hausverbrauch; Vorzeichenfehler fällt auf', () => {
  const cfgMeasured = { ...cfgLoxone, points: { selfConsumptionW: { enabled: true } } };
  // PV 10 kW, Akku lädt 9,7 kW, Haus 0,3 kW, Netz ±0 → passt.
  const ok = { victron: { pvTotalW: 10_000, gridImportW: 0, gridExportW: 0, batteryPowerW: 9_700, selfConsumptionW: 300 } };
  assert.equal(plausibilityChecks({ cfg: cfgMeasured, state: ok }).some((c) => c.key === 'balance'), false);
  // Akku-Vorzeichen vertauscht (−9,7 kW) → Bilanz liegt 19 kW daneben.
  const flipped = { victron: { ...ok.victron, batteryPowerW: -9_700 } };
  assert.equal(plausibilityChecks({ cfg: cfgMeasured, state: flipped }).find((c) => c.key === 'balance').level, 'warn');
  // Hausverbrauch aus der Bilanz berechnet → keine Bilanzprüfung (wäre immer 0).
  assert.equal(plausibilityChecks({ cfg: cfgLoxone, state: flipped }).some((c) => c.key === 'balance'), false);
});

test('Pflichtwerte Netz und SoC fehlen → Fehler', () => {
  const df = buildDataflow({
    cfg: cfgLoxone,
    state: { victron: {}, meter: {} },
    transport: pushTransport({
      grid_total: { topic: 'dvhub/input/grid/total_w', value: null, ageMs: null, fresh: false },
      battery_soc: { topic: 'dvhub/input/battery/soc_pct', value: null, ageMs: null, fresh: false },
    }),
    now: NOW,
  });
  assert.deepEqual(df.checks.filter((c) => c.level === 'error').map((c) => c.key).sort(), ['battery_soc', 'grid_total']);
});

test('Geräteprofil (Modbus): Zähler + aktive Punkte mit Fehlertext', () => {
  const df = buildDataflow({
    cfg: { manufacturer: 'fronius', victron: { host: '192.168.178.114', port: 502 }, points: { soc: { enabled: true }, pvPowerW: { enabled: true }, minSocPct: { enabled: false } } },
    state: {
      victron: { soc: 57, pvPowerW: null, errors: { pvPowerW: 'modbus exception 2' }, updatedAt: NOW - 3000 },
      meter: { ok: true, grid_total_w: -1477, updatedAt: NOW - 2000 },
    },
    transport: { type: 'modbus' },
    now: NOW,
  });
  assert.equal(df.in.source.kind, 'modbus');
  assert.equal(df.in.source.endpoint, '192.168.178.114:502');
  const keys = df.in.inputs.map((i) => i.key);
  assert.deepEqual(keys, ['meter', 'soc', 'pvPowerW']);
  assert.equal(df.in.inputs.find((i) => i.key === 'pvPowerW').error, 'modbus exception 2');
  assert.equal(df.in.inputs.find((i) => i.key === 'meter').ageMs, 2000);
});

test('Raus: Sollwerte mit Quelle, letzte Schreibvorgänge und Kanäle werden durchgereicht', () => {
  const df = buildDataflow({
    cfg: cfgLoxone,
    state: { victron: {}, meter: {}, ctrl: { forcedOff: false }, schedule: { lastWrite: { gridSetpointW: { value: -40, writeType: 'mqtt', source: 'default', at: NOW - 5000 }, feedExcessDcPv: null } } },
    transport: pushTransport({}),
    controlSnapshot: {
      source: 'eos', rule: null, updatedAt: '2026-10-16T11:59:00Z', paused: false,
      values: { gridSetpointW: { value: -9880, source: 'rule:eos-1', origin: 'active', at: NOW - 60_000 } },
    },
    channels: [{ kind: 'loxone_http', url: '/api/integration/loxone', lines: 40, bytes: 43000, controlByteOffset: 25 }],
    dvControlValue: 1,
    now: NOW,
  });
  assert.equal(df.out.control.source, 'eos');
  assert.equal(df.out.control.rows[0].label, 'Netz-Sollwert');
  assert.equal(df.out.control.rows[0].value, -9880);
  assert.deepEqual(df.out.lastWrites.map((w) => w.key), ['gridSetpointW']);
  assert.equal(df.out.dvSignal.value, 1);
  assert.equal(df.out.channels[0].controlByteOffset, 25);
});

test('Feldfall BIGGE: Profil „berechnen“, aber Loxone schickt den Hausverbrauch → Bilanz wird geprüft und fängt PV-Sprünge', () => {
  const inputs = [{ key: 'consumption_total', label: 'Hausverbrauch', received: true, fresh: true }];
  // 16.10. 06:57 UTC: PV 23,6 kW gemeldet, Akku 0, Einspeisung 1,4 kW, Haus 0,4 kW.
  const state = { victron: { pvTotalW: 23_609, gridImportW: 0, gridExportW: 1_437, batteryPowerW: 0, selfConsumptionW: 418 } };
  const bal = plausibilityChecks({ cfg: cfgLoxone, state, inputs }).find((c) => c.key === 'balance');
  assert.equal(bal.level, 'warn');
  assert.match(bal.text, /21754 W|21\.754|21754/);
});

test('Optionale Eingänge (Phasen) ohne Wert sind kein Fehler, Pflichtwerte schon', () => {
  const df = buildDataflow({
    cfg: cfgLoxone, state: { victron: {}, meter: {} },
    transport: pushTransport({
      grid_total: { topic: 't', value: 5, ageMs: 1000, fresh: true },
      grid_l1: { topic: 't1', value: null, ageMs: null, fresh: false },
      battery_soc: { topic: 's', value: 50, ageMs: 1000, fresh: true },
    }),
    now: NOW,
  });
  const byKey = Object.fromEntries(df.in.inputs.map((i) => [i.key, i]));
  assert.equal(byKey.grid_l1.optional, true);
  assert.equal(byKey.grid_total.optional, false);
  assert.equal(df.checks.length, 0);
});
