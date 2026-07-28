// T-FREEZE — Einfrier-Wächter (2026-07-24, GX-Modbus-Zwischenfall).
//
// Das Ausfallbild, das KEIN bestehender Schutz sah: jeder Modbus-Read ERFOLGREICH,
// aber der Wert unverändert (halb-tote GX-Session). fieldUpdatedAt wurde gestempelt →
// T-0075 sah „frisch", die T-VERIFY-Rücklesung bestätigte den eingefrorenen Wert.
// Diese Tests sperren die zwei Detektoren, die Fehlalarm-Schranken (die einzige echte
// Gefahr eines solchen Wächters) und die Reaktion (Rückdatierung → Entlade-Boden,
// Reconnect, Alarm) fest.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFreezeState,
  evaluateFreeze,
  createFreezeWatchdog,
  resolveFreezeOptions
} from '../services/telemetry-freeze-watchdog.js';

const OPTS = resolveFreezeOptions({
  victron: { freezeWatchdog: { freezeMs: 60000, minSamples: 10, minPowerW: 25, minJitterFields: 2 } },
  optimizer: { batteryCapacityWh: 60000 }   // socStepPct 3 % → 1800 Wh, Band 10-95 %
});

/** N Zyklen à stepMs füttern; values darf pro Zyklus vom Index abhängen. */
function feed(state, { cycles, stepMs = 1000, t0 = 1_000_000, values }) {
  let last = null;
  for (let i = 0; i < cycles; i += 1) {
    last = evaluateFreeze(state, { nowMs: t0 + i * stepMs, values: values(i) }, OPTS);
  }
  return last;
}

test('lebende Anlage: jitternde Werte lösen nie aus', () => {
  const state = createFreezeState();
  feed(state, {
    cycles: 300,
    values: (i) => ({
      grid_total_w: -1200 + (i % 7),
      batteryPowerW: 2400 + (i % 3),
      pvTotalW: 5000 + (i % 11),
      soc: 60 + Math.floor(i / 100)
    })
  });
  assert.equal(state.active, false);
});

test('Anlage steht komplett still (alles exakt 0) ist KEIN Einfrierer', () => {
  const state = createFreezeState();
  feed(state, {
    cycles: 300,
    values: () => ({ grid_total_w: 0, batteryPowerW: 0, pvTotalW: 0, soc: 50 })
  });
  assert.equal(state.active, false, 'ein abgeschaltetes System darf keinen Alarm erzeugen');
});

test('identische Werte ≠ 0 über freezeMs → Einfrierer erkannt (Anker = letzter Wertwechsel)', () => {
  const state = createFreezeState();
  // 30 s normaler Betrieb, danach steht alles.
  const res = feed(state, {
    cycles: 200,
    values: (i) => (i < 30
      ? { grid_total_w: -1200 + i, batteryPowerW: 2400 + i, pvTotalW: 5000 + i, soc: 60 }
      : { grid_total_w: -1170, batteryPowerW: 2430, pvTotalW: 5030, soc: 60 })
  });
  assert.equal(state.active, true);
  assert.deepEqual(state.reasons, ['identical_values']);
  // Anker = erster Zyklus des Stillstands, also der Zeitpunkt, zu dem sich der Wert
  // ZULETZT geändert hat (danach kam nur noch derselbe Wert).
  assert.equal(state.anchorMs, 1_000_000 + 30 * 1000, 'Anker = Zeitpunkt der letzten echten Änderung');
  assert.equal(res.transition, null, 'Übergang wird nur EINMAL gemeldet');
});

test('Übergänge werden genau einmal gemeldet, Erholung räumt auf', () => {
  const state = createFreezeState();
  const transitions = [];
  for (let i = 0; i < 300; i += 1) {
    const frozen = i >= 20 && i < 200;
    const v = frozen
      ? { grid_total_w: -1000, batteryPowerW: 2000, pvTotalW: 3000, soc: 60 }
      : { grid_total_w: -1000 - i, batteryPowerW: 2000 + i, pvTotalW: 3000 + i, soc: 60 };
    const { transition } = evaluateFreeze(state, { nowMs: 1_000_000 + i * 1000, values: v }, OPTS);
    if (transition) transitions.push([transition, i]);
  }
  assert.deepEqual(transitions.map((t) => t[0]), ['freeze', 'clear']);
  assert.equal(transitions[0][1], 20 + 60, 'Alarm exakt nach freezeMs Stillstand');
  assert.equal(state.active, false);
  assert.equal(state.since, null);
});

test('langsames Polling: freezeMs erreicht, aber zu wenige Samples → kein Alarm', () => {
  const state = createFreezeState();
  // 30-s-Backoff-Kadenz: nach 5 min sind das erst 10 Samples … minSamples=10 wird
  // exakt erreicht, mit 9 Samples darf es NICHT auslösen.
  feed(state, {
    cycles: 9,
    stepMs: 30000,
    values: () => ({ grid_total_w: -1000, batteryPowerW: 2000, pvTotalW: 3000, soc: 60 })
  });
  assert.equal(state.active, false, '9 Samples < minSamples → Datenlage zu dünn');
  feed(state, {
    cycles: 1,
    t0: 1_000_000 + 9 * 30000,
    stepMs: 30000,
    values: () => ({ grid_total_w: -1000, batteryPowerW: 2000, pvTotalW: 3000, soc: 60 })
  });
  assert.equal(state.active, true);
});

test('nur ein einziges anwesendes Feld reicht nicht (minJitterFields)', () => {
  const state = createFreezeState();
  feed(state, { cycles: 300, values: () => ({ batteryPowerW: 2000 }) });
  assert.equal(state.active, false);
});

test('Teil-Einfrierer: SoC steht trotz gemeldetem Akku-Durchsatz', () => {
  const state = createFreezeState();
  // 3 kW Entladung, SoC klemmt bei 42 %. 1800 Wh Schwelle → nach 36 min erreicht.
  feed(state, {
    cycles: 2300,
    values: (i) => ({
      grid_total_w: -1200 + (i % 7),
      batteryPowerW: -3000 - (i % 5),
      pvTotalW: 0,
      soc: 42
    })
  });
  assert.equal(state.active, true);
  assert.deepEqual(state.reasons, ['soc_no_step']);
  assert.ok(state.soc.throughputWh >= 1800);
  assert.equal(state.stalledFields[0], 'soc');
});

// Der Fehlalarm-Fall aus den ECHTEN Anlagendaten (2026-07-24): oben im Band nimmt
// der Akku in Absorption/Float stundenlang Ladestrom auf, ohne dass der SoC steigt.
// Ohne SoC-Band hätte das in 5 Tagen ~9 Fehlalarme erzeugt.
test('Absorptionsphase bei 99 % SoC ist KEIN Einfrierer (SoC-Band)', () => {
  const state = createFreezeState();
  feed(state, {
    cycles: 4000,
    values: (i) => ({
      grid_total_w: -300 + (i % 7),
      batteryPowerW: 1200 + (i % 5),   // >4 kWh Ladung ohne SoC-Schritt
      pvTotalW: 4000 + (i % 11),
      soc: 99
    })
  });
  assert.equal(state.active, false);
});

test('Ruhe am Entlade-Boden (SoC 6 %) ist KEIN Einfrierer (SoC-Band)', () => {
  const state = createFreezeState();
  feed(state, {
    cycles: 4000,
    values: (i) => ({
      grid_total_w: 900 + (i % 7),
      batteryPowerW: -1500 - (i % 5),
      pvTotalW: 0,
      soc: 6
    })
  });
  assert.equal(state.active, false);
});

test('stehender SoC ohne Akku-Durchsatz ist normal (Ruhezustand)', () => {
  const state = createFreezeState();
  feed(state, {
    cycles: 3000,
    values: (i) => ({ grid_total_w: -500 + (i % 9), batteryPowerW: 0, pvTotalW: 0, soc: 42 })
  });
  assert.equal(state.active, false);
});

test('ohne bekannte Akkukapazität bleibt Detektor B aus', () => {
  const opts = resolveFreezeOptions({ victron: { freezeWatchdog: { freezeMs: 60000, minSamples: 10 } } });
  assert.equal(opts.socStepWh, 0);
  const state = createFreezeState();
  for (let i = 0; i < 2000; i += 1) {
    evaluateFreeze(state, {
      nowMs: 1_000_000 + i * 1000,
      values: { grid_total_w: -1200 + (i % 7), batteryPowerW: -3000, pvTotalW: 0, soc: 42 }
    }, opts);
  }
  assert.equal(state.active, false, 'lieber blind als geraten — eine falsche Schwelle alarmiert falsch');
});

// ── Reaktion (Fabrik) ─────────────────────────────────────────────────────────

function makeWatchdog({ transportType = 'modbus' } = {}) {
  const state = {
    meter: { ok: true, updatedAt: 0, grid_total_w: -1000, error: null },
    victron: { soc: 60, batteryPowerW: 2000, pvTotalW: 3000, fieldUpdatedAt: {} }
  };
  const logs = [];
  const notifications = [];
  let dropCount = 0;
  const ctx = {
    state,
    getCfg: () => ({
      victron: { freezeWatchdog: { freezeMs: 60000, minSamples: 10, reconnectMs: 60000 } },
      optimizer: { batteryCapacityWh: 60000 }
    }),
    transport: { type: transportType, dropConnections: () => { dropCount += 1; return 2; } },
    pushLog: (event, details, level) => logs.push({ event, details, level }),
    notificationService: { sendDirect: async (msg) => { notifications.push(msg); return { sent: 1 }; } },
    monitoringAlertPush: () => Promise.resolve()
  };
  const wd = createFreezeWatchdog(ctx);
  // Ein Poll-Zyklus wie in polling.js: Erfolgs-Stempel setzen, dann tick().
  const poll = (i, { frozen }) => {
    const now = 1_000_000 + i * 1000;
    state.meter.ok = true;
    state.meter.updatedAt = now;
    state.meter.error = null;
    state.meter.grid_total_w = frozen ? -1000 : -1000 - i;
    state.victron.batteryPowerW = frozen ? 2000 : 2000 + i;
    state.victron.pvTotalW = frozen ? 3000 : 3000 + i;
    state.victron.fieldUpdatedAt = { soc: now, batteryPowerW: now, pvPowerW: now };
    wd.tick(now);
    return now;
  };
  // Fehlgeschlagener Zyklus: pollMeter/pollPoint lassen Wert UND Erfolgs-Stempel
  // unangetastet (T-0075-Vertrag), state.meter.ok fällt.
  const pollFailed = (i) => {
    const now = 1_000_000 + i * 1000;
    state.meter.ok = false;
    state.meter.error = 'modbus timeout';
    wd.tick(now);
    return now;
  };
  return { state, logs, notifications, poll, pollFailed, dropped: () => dropCount };
}

test('Reaktion: Stempel-Rückdatierung, Meter-Abwertung, Alarm, Reconnect (throttled)', () => {
  const h = makeWatchdog();
  for (let i = 0; i < 20; i += 1) h.poll(i, { frozen: false });
  let now = 0;
  for (let i = 20; i < 200; i += 1) now = h.poll(i, { frozen: true });

  const freeze = h.state.victron.freeze;
  assert.equal(freeze.active, true);
  assert.equal(freeze.reason, 'identical_values');

  // Der Kern: die Frische-Stempel zeigen auf den letzten ECHTEN Wertwechsel —
  // damit greift der bestehende T-0075-Entlade-Boden-Schutz von selbst.
  const anchor = 1_000_000 + 20 * 1000;
  assert.equal(h.state.victron.fieldUpdatedAt.soc, anchor);
  assert.equal(h.state.victron.fieldUpdatedAt.batteryPowerW, anchor);
  assert.ok(now - h.state.victron.fieldUpdatedAt.soc > 90000, 'älter als telemetryMaxAgeMs → stale');

  assert.equal(h.state.meter.ok, false);
  assert.match(h.state.meter.error, /eingefroren/);

  const alarms = h.logs.filter((l) => l.event === 'telemetry_freeze_detected');
  assert.equal(alarms.length, 1, 'genau EIN Alarm pro Einfrier-Episode (kein Log-Sturm)');
  assert.equal(alarms[0].level, 'critical');
  assert.equal(h.notifications[0].level, 'critical');
  assert.match(h.notifications[0].title, /eingefroren/);

  // Reconnect: throttled auf reconnectMs (60 s) — 120 s Stillstand ⇒ 2 Versuche.
  assert.equal(h.dropped(), 2);
  assert.equal(h.logs.filter((l) => l.event === 'telemetry_freeze_reconnect').length, 2);
});

test('Erholung: Freeze-Flag fällt, Stempel werden nicht mehr angefasst', () => {
  const h = makeWatchdog();
  for (let i = 0; i < 20; i += 1) h.poll(i, { frozen: false });
  for (let i = 20; i < 120; i += 1) h.poll(i, { frozen: true });
  assert.equal(h.state.victron.freeze.active, true);
  const now = h.poll(120, { frozen: false });
  assert.equal(h.state.victron.freeze, null);
  assert.equal(h.state.victron.fieldUpdatedAt.soc, now, 'wieder echte Frische');
  assert.equal(h.logs.filter((l) => l.event === 'telemetry_freeze_cleared').length, 1);
});

test('fehlgeschlagene Reads (Stempel bewegt sich nicht) sind KEIN Einfrierer', () => {
  const h = makeWatchdog();
  for (let i = 0; i < 20; i += 1) h.poll(i, { frozen: false });
  // Comms-Ausfall: die Werte bleiben stehen, ABER die Erfolgs-Stempel auch —
  // buildSample nimmt solche Felder gar nicht erst auf.
  for (let i = 20; i < 300; i += 1) h.pollFailed(i);
  assert.equal(h.state.victron.freeze, null, 'dafür ist die normale T-0075-Frische zuständig');
  assert.equal(h.dropped(), 0, 'kein Reconnect-Sturm bei einem normalen Verbindungsausfall');
});

test('MQTT-Transport: Wächter ist ein No-op (on-change-Semantik)', () => {
  const h = makeWatchdog({ transportType: 'mqtt' });
  for (let i = 0; i < 300; i += 1) h.poll(i, { frozen: true });
  assert.equal(h.state.victron.freeze, null);
  assert.equal(h.logs.length, 0);
  assert.equal(h.dropped(), 0);
});

// Reconnect-Deckel: ein Abriss-/Neuaufbau-Karussell belastet die dbus-Kette des GX
// bis zum Watchdog-Reboot (Victron-Community, EVCS-Disconnect-Loop), und tote
// Sessions räumt der GX nicht ab. Nach maxReconnects bleibt nur der Alarm stehen.
test('Reconnect ist pro Einfrier-Episode gedeckelt (kein Verbindungs-Karussell)', () => {
  const h = makeWatchdog();
  for (let i = 0; i < 20; i += 1) h.poll(i, { frozen: false });
  // 40 min Dauer-Einfrierer: ohne Deckel wären das 40 Neuaufbauten.
  for (let i = 20; i < 2400; i += 1) h.poll(i, { frozen: true });
  assert.equal(h.dropped(), 3, 'maxReconnects=3');
  assert.equal(h.logs.filter((l) => l.event === 'telemetry_freeze_reconnect_exhausted').length, 1);
  assert.equal(h.state.victron.freeze.active, true, 'Alarm bleibt stehen');
});
