// test/sungrow-inverter-view.test.js — Leitstand-Kachel „Wechselrichter" (zwei Sungrow-WR, Punkt 4 + Feld 15.11.).
// Reine Anzeige-Logik aus public/sungrow-inverter-view.js, geladen wie im Browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function load() {
  const file = fileURLToPath(new URL('../public/sungrow-inverter-view.js', import.meta.url));
  const sandbox = { window: {}, document: undefined };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'sungrow-inverter-view.js' });
  return sandbox.window.DVhubSungrowInverters;
}

const V = load();

test('ohne zweiten WR → Kachel versteckt', () => {
  assert.equal(V.view({}).hidden, true);
  assert.equal(V.view({ sungrowSecond: null }).hidden, true);
});

test('M7b: EMS-Zeile — Bedarf > 0, aber beide WR an der Grenze (Split 0/0) → „Bedarf X → 0 W (beide an der Grenze 11 %)"', () => {
  const status = {
    victron: { soc: 11, sungrowMasterSocPct: 11, device: { model: 'SH10RT', bdcRatedW: 10000, minSocPctDevice: 10, maxSocPctDevice: 100 } },
    sungrowSecond: { online: true, socPct: 11, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 10000, minSocPctDevice: 10, maxSocPctDevice: 100 },
    sungrowEms: {
      controlMode: 'forced', owns: true,
      decision: { mode: 'forced', command: 'discharge', powerW: 1990, split: { masterW: 0, slaveW: 0, strategy: 'soc-balance', charge: false, masterFloorPct: 11, slaveFloorPct: 11, masterCeilPct: 100, slaveCeilPct: 100 } },
    },
  };
  const vw = V.view(status);
  assert.match(vw.master.decision, /Bedarf 1990 W → 0 W/, vw.master.decision);
  assert.match(vw.master.decision, /an der Grenze 11 %/);
});

test('M28: Kachel zeigt „Master an der Grenze, Slave übernimmt" (und umgekehrt)', () => {
  const mk = (takeover) => ({
    victron: { soc: 12, sungrowMasterSocPct: 0.7, device: { model: 'SH10RT', bdcRatedW: 10000, minSocPctDevice: 10, maxSocPctDevice: 100 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 5.4, batteryPowerW: -1200, pvPowerW: 0, bdcRatedW: 10000, minSocPctDevice: 10, maxSocPctDevice: 100 },
    sungrowEms: {
      controlMode: 'forced', owns: true,
      decision: { mode: 'forced', command: 'discharge', powerW: 1200, split: { masterW: takeover === 'slave' ? 0 : 1200, slaveW: takeover === 'slave' ? 1200 : 0, strategy: 'soc-balance', charge: false, takeover } },
    },
  });
  const vw = V.view(mk('slave'));
  assert.equal(vw.master.takeover, 'Master an der Grenze, Slave übernimmt');
  assert.equal(vw.slave.takeover, null);
  const vw2 = V.view(mk('master'));
  assert.equal(vw2.slave.takeover, 'Slave an der Grenze, Master übernimmt');
  assert.equal(vw2.master.takeover, null);
  assert.equal(V.view(mk(null)).master.takeover, null);
});

test('M28 Grundsatz 0: Kachel zeigt Teil-Lieferung („liefert nur X von Y W") — mit und ohne Übernahme', () => {
  const st = (split) => ({
    victron: { soc: 30, sungrowMasterSocPct: 30, device: { model: 'SH10RT', bdcRatedW: 10000 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 34, batteryPowerW: -900, pvPowerW: 0, bdcRatedW: 10000 },
    sungrowEms: { controlMode: 'forced', owns: true, decision: { mode: 'forced', command: 'discharge', powerW: 1200, split: { strategy: 'soc-balance', charge: false, ...split } } },
  });
  // Master liefert 300 von 600 W, der Slave trägt die fehlenden 300 W.
  const a = V.view(st({ masterW: 600, slaveW: 900, masterBaseW: 600, slaveBaseW: 600, masterLimitW: 300, slaveLimitW: null, transferW: 300, takeover: 'slave', takeoverReason: 'partial' }));
  assert.equal(a.master.takeover, 'Master liefert nur 300 von 600 W, Slave übernimmt den Rest');
  assert.equal(a.slave.takeover, null);
  // Feldbeleg 12:31 nach der Erkennung: Master an der Grenze, Slave bekommt 1120 W, liefert aber nur 600 W.
  const b = V.view(st({ masterW: 0, slaveW: 1120, masterBaseW: 0, slaveBaseW: 1120, masterLimitW: null, slaveLimitW: 600, transferW: 0, masterOut: 'stalled', takeover: 'slave', takeoverReason: 'stalled' }));
  assert.equal(b.master.takeover, 'Master an der Grenze, Slave übernimmt');
  assert.equal(b.slave.takeover, 'Slave liefert nur 600 von 1120 W');
});

test('N5: Modbus-Gesundheit je WR — Takt, Anfragen/s, Antwortzeit, Fehler 24 h, letzter Fehler', () => {
  const status = {
    victron: { soc: 50, sungrowMasterSocPct: 50, device: { model: 'SH10RT', bdcRatedW: 10000 } },
    sungrowSecond: {
      online: true, socPct: 40, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 10000,
      tickMs: 5000, health: { requestsPerSec: 0.4, responseMs: 300, errors24h: 0, lastError: null },
    },
    sungrowEms: {
      controlMode: 'forced', owns: true, regulateEveryMs: 1000,
      health: { requestsPerSec: 2.1, responseMs: 240, errors24h: 3, lastError: { kind: 'timeout', at: new Date(2026, 10, 16, 14, 5).getTime() } },
      decision: { mode: 'forced', command: 'discharge', powerW: 1000 },
    },
  };
  const vw = V.view(status);
  // Master: Rate, Antwortzeit (Median), Fehlerzahl, letzter Fehler mit Zeit — der Takt steht separat (regulate).
  assert.match(vw.master.health, /2,1\/s/);
  assert.match(vw.master.health, /Antwort 240 ms/);
  assert.match(vw.master.health, /Fehler 24 h 3/);
  assert.match(vw.master.health, /zuletzt Timeout 14:05/);
  // Slave: Lesetakt 5000 ms, keine Fehler.
  assert.match(vw.slave.health, /Fehler 24 h 0/);
});

// N3 (Feld 19.11.): Der Slave hat keinen eigenen Regeltakt. DVhub schreibt ihn in jedem Master-Schritt mit (stepSplit →
// applyDirectCommand); seine Messwerte (SoC, Akku, PV) liest der Begleitdienst nur alle tickMs. Die Kachel zeigt den
// Master-Takt als Regelzyklus UND den Lesetakt — nicht den eigenen (ungenutzten) Rechenwert des Slave-Aktuators.
test('N3: Slave-Takt = Regelzyklus des Masters + eigener Lesetakt, beide benannt', () => {
  const status = {
    victron: { soc: 50, sungrowMasterSocPct: 50, device: { model: 'SH10RT', bdcRatedW: 10000 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 40, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 10000, tickMs: 5000 },
    sungrowEms: { controlMode: 'forced', owns: true, regulateEveryMs: 1000, decision: { mode: 'forced', command: 'discharge', powerW: 600, split: { masterW: 300, slaveW: 300, strategy: 'soc-balance' } } },
    // Feldstand vor N3: der Slave-Aktuator meldete seinen eigenen Rechenwert (5000), der nichts taktet.
    sungrowEmsSlave: { controlMode: 'forced', owns: true, regulateEveryMs: 5000, decision: { mode: 'forced', command: 'discharge', powerW: 300 } },
  };
  const vw = V.view(status);
  assert.equal(vw.slave.regulate, 'Regelzyklus 1000 ms (gleicher Takt wie Master) · Lesetakt 5000 ms');
  assert.equal(vw.master.regulate, 'Regelzyklus 1000 ms', 'Master unverändert');
  // Ohne Lesetakt nur der Regelzyklus; ohne beides ein Strich.
  assert.equal(V.view({ ...status, sungrowSecond: { ...status.sungrowSecond, tickMs: null } }).slave.regulate, 'Regelzyklus 1000 ms (gleicher Takt wie Master)');
  assert.equal(V.view({ ...status, sungrowSecond: { ...status.sungrowSecond, tickMs: null }, sungrowEms: { ...status.sungrowEms, regulateEveryMs: null } }).slave.regulate, '–');
  // render: die Slave-EMS-Zeile trägt beide Werte.
  const els = {};
  const doc = { getElementById: (id) => (els[id] || (els[id] = { id, textContent: '', hidden: false })) };
  V.render(status, doc);
  assert.match(els.sungrowWrSlaveEms.textContent, /Takt Regelzyklus 1000 ms \(gleicher Takt wie Master\) · Lesetakt 5000 ms$/);
});

test('External-Split: je WR EIGENER Anteil (nicht Summe), Akku mit Richtung, wirksame Grenze, Countdown in Modus 3', () => {
  const status = {
    victron: {
      soc: 60, sungrowMasterSocPct: 80, sungrowMasterBatteryW: -1000, sungrowMasterPvW: 0,
      sungrowSystemBatteryW: -2168, sungrowSystemPvW: 0, runningStateText: 'Externes EMS', emergencyCharge: false,
      device: { model: 'SH10RT-20', serial: 'A2351909042', bdcRatedW: 10000, maxChargeWDevice: 10600, maxDischargeWDevice: 10000, minSocPctDevice: 10, maxSocPctDevice: 100 },
    },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 20, batteryPowerW: -1168, pvPowerW: 0, bdcRatedW: 10000, maxChargeWDevice: 10000, maxDischargeWDevice: 10000, minSocPctDevice: 5, maxSocPctDevice: 100, runningStateText: 'Externes EMS', emergencyCharge: false },
    sungrowEms: { controlMode: 'external', owns: true, heartbeatTimeoutS: 30, heartbeatWorkingFc: 16, heartbeatSentS: 30, regulateEveryMs: 1000, responseMs: 420, modeBudgetLeft: 18, deviceFallbackAfterS: 31, deviceFallbackCount60s: 1, writesToday: { mode13050: 2, cmd13051: 3, power13052: 5, heartbeat13080: 40 }, decision: { mode: 'forced', command: 'discharge', powerW: 2168, split: { masterW: 1000, slaveW: 1168, strategy: 'soc-balance', charge: false, masterMaxW: 10000, slaveMaxW: 10000, masterFloorPct: 10, slaveFloorPct: 5, masterCeilPct: 100, slaveCeilPct: 100, slaveEmergencyCharge: false, slaveFellBack: false } } },
    sungrowEmsSlave: { controlMode: 'external', owns: true, heartbeatWorkingFc: 16, heartbeatSentS: 30, writesToday: { mode13050: 1, cmd13051: 2, power13052: 4, heartbeat13080: 40 }, modeBudgetLeft: 19, decision: { mode: 'forced', command: 'discharge', powerW: 1168 } },
  };
  const vw = V.view(status);
  assert.equal(vw.hidden, false);
  assert.equal(vw.mode, 'External EMS (3)');
  assert.equal(vw.showCountdown, true);
  // Master: eigener Anteil 1000 W (NICHT die Summe 2168), Akku mit Richtung.
  assert.equal(vw.master.role, 'Master – gesteuert');
  // M1: gemeldeter SoC + echter (Fenster 10–100): real = 10 + 80×0,9 = 82 %.
  assert.equal(vw.master.soc, '80 % · real 82 %');
  assert.equal(vw.master.battery, 'entlädt 1000 W');
  assert.equal(vw.master.command, 'Entladen 1000 W');
  assert.equal(vw.master.countdown, '30 s');
  // Grenze = min(Gerät, BDC): Laden min(10600,10000)=10 kW, Entladen 10 kW, SoC aus Anlage 10–100 %.
  assert.equal(vw.master.limit, 'Laden 10 kW · Entladen 10 kW · SoC 10–100 %');
  assert.equal(vw.master.limitDevice, 'Gerät Lad 10,6 kW'); // BDC deckelt → roher Gerätewert als Hinweis
  assert.equal(vw.master.emergencyCharge, false);
  // Slave: eigener Anteil 1168 W, Rolle schlicht „gesteuert".
  assert.equal(vw.slave.role, 'Slave – gesteuert');
  assert.equal(vw.slave.battery, 'entlädt 1168 W');
  assert.equal(vw.slave.command, 'Entladen 1168 W');
  assert.equal(vw.slave.limit, 'Laden 10 kW · Entladen 10 kW · SoC 5–100 %');
  assert.equal(vw.slave.limitDevice, ''); // Gerät 10 kW = BDC, kein Hinweis
  assert.equal(vw.slave.fellBack, false);
  // Advanced-Zeilen unverändert.
  assert.equal(vw.master.split, '1000 W/1168 W (soc-balance)');
  assert.equal(vw.master.regulate, 'Regelzyklus 1000 ms');
  assert.ok(vw.master.writes.indexOf('13050 2 (Rest 18)') >= 0, vw.master.writes);
  assert.equal(vw.master.fallback, '31 s · 1/min');
  // Summe (NUR hier die Systemsumme), Akku mit Richtung.
  assert.equal(vw.sum.battery, 'entlädt 2168 W');
  assert.equal(vw.sum.soc, '60 %');
});

test('Forced-Split laden: Modus 2, kein Countdown, Akku lädt, Slave-Notladung + Rückfall als Hinweis', () => {
  const status = {
    victron: { soc: 50, sungrowMasterSocPct: 50, sungrowMasterBatteryW: 1442, device: { model: 'SH10RT-20', bdcRatedW: 10000, maxChargeWDevice: 10600, maxDischargeWDevice: 5000, minSocPctDevice: 5, maxSocPctDevice: 100 }, emergencyCharge: false },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 8, batteryPowerW: 1442, bdcRatedW: 10000, maxChargeWDevice: 10600, maxDischargeWDevice: 5000, minSocPctDevice: 5, maxSocPctDevice: 100, emergencyCharge: true },
    sungrowEms: { controlMode: 'forced', owns: true, regulateEveryMs: 250, responseMs: 241, decision: { mode: 'forced', command: 'charge', powerW: 2884, split: { masterW: 2884, slaveW: 0, strategy: 'soc-balance', charge: true, masterFloorPct: 5, slaveFloorPct: 5, masterCeilPct: 100, slaveCeilPct: 100, slaveEmergencyCharge: true, slaveFellBack: true } } },
    sungrowEmsSlave: { controlMode: 'forced', owns: false, decision: { mode: 'self', command: 'stop', powerW: 0 } },
  };
  const vw = V.view(status);
  assert.equal(vw.mode, 'Forced-Split (2)');
  assert.equal(vw.showCountdown, false);
  assert.equal(vw.master.countdown, null, 'im Forced mode kein Countdown');
  assert.equal(vw.master.battery, 'lädt 1442 W');
  assert.equal(vw.master.command, 'Laden 2884 W');
  assert.equal(vw.master.limit, 'Laden 10 kW · Entladen 5 kW · SoC 5–100 %');
  // Slave: Notladung + Rückfall-Hinweis, Anteil 0 → Stopp.
  assert.equal(vw.slave.emergencyCharge, true);
  assert.equal(vw.slave.fellBack, true);
  assert.equal(vw.slave.command, 'Stopp');
  assert.equal(vw.master.regulate, 'Regelzyklus 250 ms');
});

test('Grenze zeigt die wirksame SoC-Spanne der Anlage (Min-/Max-SoC), nicht nur die Leistung', () => {
  const status = {
    victron: { soc: 50, sungrowMasterSocPct: 50, device: { model: 'SH10RT-20', bdcRatedW: 10000, maxChargeWDevice: 8000, maxDischargeWDevice: 8000, minSocPctDevice: 15, maxSocPctDevice: 95 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 50, bdcRatedW: 10000, maxChargeWDevice: 8000, maxDischargeWDevice: 8000, minSocPctDevice: 15, maxSocPctDevice: 95 },
    sungrowEms: { controlMode: 'forced', owns: true, decision: { mode: 'forced', command: 'discharge', powerW: 1000 } },
  };
  const vw = V.view(status);
  // Gerät 8 kW < BDC 10 kW → wirksam 8 kW (kein Geräte-Hinweis), SoC 15–95 %.
  assert.equal(vw.master.limit, 'Laden 8 kW · Entladen 8 kW · SoC 15–95 %');
  assert.equal(vw.master.limitDevice, '');
});

test('Countdown nur im echten Modus 3 — Modus 0 (Eigenverbrauch) zeigt keinen Countdown trotz External-Konfiguration', () => {
  const idle = V.view({
    victron: { soc: 60, device: { model: 'SH10RT-20', bdcRatedW: 10000 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', bdcRatedW: 10000 },
    sungrowEms: { controlMode: 'external', owns: false, heartbeatTimeoutS: 30, heartbeatSentS: 30, decision: { mode: 'self' } },
  });
  assert.equal(idle.master.countdown, null, 'Modus 0 → kein Countdown');
  assert.equal(idle.master.command, 'Eigenverbrauch');
  assert.equal(idle.showCountdown, false);
  // Gerät meldet Modus 0, obwohl DVhub (noch) besitzt → ebenfalls kein Countdown.
  const devSelf = V.view({
    victron: { soc: 60, device: { model: 'SH10RT-20', bdcRatedW: 10000 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', bdcRatedW: 10000 },
    sungrowEms: { controlMode: 'external', owns: true, heartbeatTimeoutS: 30, heartbeatSentS: 30, device: { mode: 0 }, decision: { mode: 'forced', command: 'discharge', powerW: 1000 } },
  });
  assert.equal(devSelf.master.countdown, null, 'Gerät in Modus 0 → kein Countdown');
});

test('Master-Notladung (victron.emergencyCharge) ergibt das Notladungs-Flag', () => {
  const vw = V.view({
    victron: { soc: 8, sungrowMasterSocPct: 8, emergencyCharge: true, device: { model: 'SH10RT-20', bdcRatedW: 10000 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 50, bdcRatedW: 10000 },
    sungrowEms: { controlMode: 'forced', owns: true, decision: { mode: 'forced', command: 'charge', powerW: 1000, split: { masterW: 1000, slaveW: 0 } } },
  });
  assert.equal(vw.master.emergencyCharge, true);
});

test('F1: Leerlauf (Eigenverbrauch) ohne Besitz → Modus „Eigenverbrauch (0)"', () => {
  const vw = V.view({ victron: { soc: 50, device: {} }, sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance' }, sungrowEms: { controlMode: 'forced', owns: false, decision: { mode: 'self' } } });
  assert.equal(vw.mode, 'Eigenverbrauch (0)');
  assert.equal(vw.master.command, 'Eigenverbrauch');
});

test('self-only: Slave „gelesen", offline → Nicht erreichbar, kein EMS', () => {
  const status = {
    victron: { soc: 60, device: { model: 'SH10RT-20', bdcRatedW: 10000 } },
    sungrowSecond: { online: false, strategyCharge: 'master-only', strategyDischarge: 'master-only', bdcRatedW: 10000 },
    sungrowEms: { controlMode: 'forced', owns: false, decision: { mode: 'self' } },
  };
  const vw = V.view(status);
  assert.equal(vw.slave.role, 'Slave – gelesen');
  assert.equal(vw.slave.online, false);
  assert.equal(vw.slave.command, '–');          // self-only → kein Slave-Befehl
  assert.equal(vw.master.heartbeat, 'Forced mode');
});

test('render: Badges + Countdown-Zeile schalten, Modus auf eigener Zeile, Akku-Name', () => {
  const els = {};
  const el = (id) => (els[id] || (els[id] = { id, textContent: '', hidden: false }));
  const doc = { getElementById: (id) => el(id) };
  // Forced-Split mit Slave-Notladung + Rückfall: Badges sichtbar, keine Countdown-Zeile.
  V.render({
    victron: { soc: 50, sungrowMasterSocPct: 50, sungrowMasterBatteryW: 1000, device: { model: 'SH10RT-20', bdcRatedW: 10000 }, emergencyCharge: false },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 8, batteryPowerW: 0, bdcRatedW: 10000, emergencyCharge: true },
    sungrowEms: { controlMode: 'forced', owns: true, decision: { mode: 'forced', command: 'charge', powerW: 1000, split: { masterW: 1000, slaveW: 0, slaveEmergencyCharge: true, slaveFellBack: true } } },
  }, doc);
  assert.equal(els.sungrowWrMode.textContent, 'Modus: Forced-Split (2)');
  assert.equal(els.sungrowWrCard.hidden, false);
  // Kann-3: Kopf einzeilig „Sungrow", Rollen als Untertitel darunter.
  assert.equal(els.batSourceName.textContent, 'Sungrow');
  assert.equal(els.batSourceSub.textContent, 'Master + Slave');
  assert.equal(els.batSourceSub.hidden, false);
  assert.equal(els.sungrowWrSlaveBadges.hidden, false);
  assert.equal(els.sungrowWrSlaveBadges.textContent, 'Notladung · Slave-Anteil am Master');
  assert.equal(els.sungrowWrMasterBadges.hidden, true); // Master keine Notladung
  assert.equal(els.sungrowWrMasterCountdownRow.hidden, true); // Modus 2 → Countdown-Zeile weg
  assert.equal(els.sungrowWrMasterCmd.textContent, 'Laden 1000 W');
  // Ohne zweiten WR → zurück auf Victron, Kachel versteckt.
  V.render({}, doc);
  assert.equal(els.batSourceName.textContent, 'Victron');
  assert.equal(els.batSourceSub.hidden, true);
  assert.equal(els.sungrowWrCard.hidden, true);
});

test('render: Modus 3 blendet die Countdown-Zeile ein', () => {
  const els = {};
  const el = (id) => (els[id] || (els[id] = { id, textContent: '', hidden: false }));
  const doc = { getElementById: (id) => el(id) };
  V.render({
    victron: { soc: 60, sungrowMasterSocPct: 60, sungrowMasterBatteryW: -500, device: { model: 'SH10RT-20', bdcRatedW: 10000 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 60, batteryPowerW: -500, bdcRatedW: 10000 },
    sungrowEms: { controlMode: 'external', owns: true, heartbeatSentS: 28, decision: { mode: 'forced', command: 'discharge', powerW: 1000, split: { masterW: 500, slaveW: 500 } } },
    sungrowEmsSlave: { controlMode: 'external', owns: true, heartbeatSentS: 28, decision: { mode: 'forced', command: 'discharge', powerW: 500 } },
  }, doc);
  assert.equal(els.sungrowWrMasterCountdownRow.hidden, false);
  assert.equal(els.sungrowWrMasterCountdown.textContent, '28 s');
  assert.equal(els.sungrowWrSlaveCountdownRow.hidden, false);
});

test('M22: Kachel nennt ECONNREFUSED „abgelehnt" statt „Timeout"', () => {
  const at = new Date(2026, 10, 19, 12, 31).getTime();
  const vw = V.view({
    victron: { soc: 30, sungrowMasterSocPct: 30, device: { model: 'SH10RT', bdcRatedW: 10000 } },
    sungrowSecond: { online: true, socPct: 20, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 10000, health: { requestsPerSec: 0.6, errors24h: 12, lastError: { kind: 'refused', code: 'ECONNREFUSED', at } } },
    sungrowEms: { controlMode: 'forced', owns: true, decision: { mode: 'forced', command: 'stop', powerW: 0 } },
  });
  assert.match(vw.slave.health, /zuletzt abgelehnt 12:31/);
});
