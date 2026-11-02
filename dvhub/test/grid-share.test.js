// test/grid-share.test.js — Netzstrom-Zähler im Akku (Christin 01./02.11.2026).
//
// Netz→Akku erhöht den Netzstrom-Anteil, Entladen senkt ihn anteilig (Anteil ×
// Entladung), Verluste anteilig. Solange der Anteil über der Schwelle liegt,
// darf der Akku nicht ins Netz entladen — Netzstrom darf rechnerisch nie mit
// Marktprämie verkauft werden.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GRID_SHARE_LOCK_THRESHOLD_WH,
  GRID_SHARE_EXPORT_MARGIN_W,
  GRID_SHARE_BUFFER_MAX_W,
  GRID_SHARE_DC_PV_AC_FACTOR,
  GRID_SHARE_STATE_FILE,
  GRID_SHARE_PROTOCOL_FILE,
  gridShareLockApplies,
  stepGridShare,
  gridShareExportCapW,
  createGridShareTracker,
  gridShareBatteryUncertain,
} from '../services/optimizer/grid-share.js';

const gridShareBatteryUncertainReasons = (v, nowMs, maxAgeMs) => gridShareBatteryUncertain(v, { nowMs, maxAgeMs });

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-grid-share-'));
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('Sperre gilt mit PV-Anlage ohne MiSpeL-Option, nicht im reinen Netzspeicher und nicht mit Option', () => {
  assert.equal(gridShareLockApplies({ optimizer: {} }), true);
  assert.equal(gridShareLockApplies({ optimizer: { gridChargeWithoutMispel: true, mispel: { mode: 'none' } } }), true);
  assert.equal(gridShareLockApplies({ optimizer: { gridStorageOnly: true } }), false);
  assert.equal(gridShareLockApplies({ optimizer: { mispel: { mode: 'pauschal' } } }), false);
  assert.equal(gridShareLockApplies({ optimizer: { mispel: { mode: 'abgrenzung' } } }), false);
});

test('Netz→Akku erhöht den Netzstrom-Anteil', () => {
  const r = stepGridShare(0, { dtMs: 3_600_000, gridToBatteryW: 10_000, socPct: 50, capacityWh: 77_000 });
  near(r.gridWh, 10_000);
  near(r.inWh, 10_000);
  assert.equal(r.toHomeWh, 0);
  assert.equal(r.toGridWh, 0);
});

test('Entladen ins Haus senkt den Anteil anteilig (Anteil × Entladung)', () => {
  // 20 kWh im Akku (Ladestand 26 % von 77 kWh = 20,02 kWh), davon 10 kWh Netzstrom.
  const r = stepGridShare(10_000, { dtMs: 3_600_000, batteryToHomeW: 2_000, socPct: 26, capacityWh: 77_000 });
  const share = 10_000 / (0.26 * 77_000);
  near(r.toHomeWh, share * 2_000);
  near(r.gridWh, 10_000 - share * 2_000);
  assert.equal(r.toGridWh, 0);
});

test('Akku→Netz wird als Netzstrom-Export gezählt (Nachweis)', () => {
  const r = stepGridShare(5_000, { dtMs: 3_600_000, batteryToGridW: 1_000, socPct: 10, capacityWh: 50_000 });
  near(r.toGridWh, 1_000);           // Anteil 100 %: 5 kWh Netzstrom bei 5 kWh im Akku
  near(r.gridWh, 4_000);
});

test('Verluste anteilig: der Anteil kann nie größer sein als der Akku-Inhalt (Ladestand + 1 % Rundung)', () => {
  // Akku-Inhalt laut Ladestand nur noch 10 % von 50 kWh (bis 11 % wegen ganzzahligem SoC).
  const r = stepGridShare(8_000, { dtMs: 1_000, socPct: 10, capacityWh: 50_000 });
  near(r.gridWh, 5_500);
  near(r.lossWh, 2_500);
  assert.equal(r.share, 1);
});

test('ohne Ladestand nimmt Entladen nichts vom Anteil (vorsichtig) und kappt nicht', () => {
  const r = stepGridShare(1_000, { dtMs: 3_600_000, batteryToHomeW: 500, socPct: null, capacityWh: 77_000 });
  near(r.gridWh, 1_000);
  assert.equal(r.toHomeWh, 0);
});

test('Ausfuhr-Deckel: nur der PV-Überschuss (DC-PV mit Wandlungsverlust, minus Abstand), mindestens der Puffer bis 100 W', () => {
  assert.equal(gridShareExportCapW({ pvAcW: 3_000, pvDcW: 0, loadW: 1_000, bufferW: 100 }), 2_000 - GRID_SHARE_EXPORT_MARGIN_W);
  // 15 kW DC-PV kommen nur zu ~92 % als Wechselstrom an.
  assert.equal(gridShareExportCapW({ pvAcW: 0, pvDcW: 15_000, loadW: 1_000, bufferW: 100 }),
    Math.round(15_000 * GRID_SHARE_DC_PV_AC_FACTOR - 1_000 - GRID_SHARE_EXPORT_MARGIN_W));
  assert.equal(gridShareExportCapW({ pvAcW: 0, pvDcW: 0, loadW: 1_000, bufferW: 100 }), 100);
  assert.equal(gridShareExportCapW({ pvAcW: 0, pvDcW: 0, loadW: 1_000, bufferW: 0 }), 0);
  assert.equal(gridShareExportCapW({ pvAcW: 0, pvDcW: 0, loadW: 1_000, bufferW: 2_000 }), GRID_SHARE_BUFFER_MAX_W, 'großer Puffer wird während der Sperre auf 100 W begrenzt');
  assert.equal(gridShareExportCapW({ pvAcW: null, pvDcW: 3_000, loadW: 500, bufferW: 100 }), 100, 'unbekannte PV → nur Puffer');
  assert.equal(gridShareExportCapW({ pvAcW: 0, pvDcW: 4_000, loadW: null, bufferW: 100 }), 100, 'unbekannte Last → nur Puffer');
});

test('Netz→Akku zählt höchstens den echten Netzbezug (Fronius: PV-AC nach dem Laden)', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.now();
    t.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 77_000 });
    t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 1_000, gridImportW: 0 }, socPct: 50, capacityWh: 77_000 });
    assert.equal(t.summary().gridWh, 0, 'ohne Netzbezug kein Netzstrom');
    t.tick({ nowMs: t0 + 120_000, victron: { gridToBatteryW: 6_000, gridImportW: 3_000 }, socPct: 50, capacityWh: 77_000 });
    near(t.summary().gridWh, 50, 0.01);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ohne „Netzladen erlaubt“ zählt der Zähler keinen Zufluss (keine Sperre durch Regelrauschen)', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: false }, schedule: { timezone: 'Europe/Berlin' } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.now();
    t.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 77_000 });
    t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 12_000, gridImportW: 12_000 }, socPct: 50, capacityWh: 77_000 });
    assert.equal(t.summary().gridWh, 0);
    assert.equal(t.isLocked(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('„Netzladen erlaubt“ an, aber ohne MiSpeL-Freigabe: Regelrauschen sperrt nicht (Gegenprüfung f4bcc3ba)', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: false, mispel: { mode: 'none' } }, schedule: { timezone: 'Europe/Berlin' } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.now();
    t.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 77_000 });
    for (let i = 1; i <= 200; i += 1) {
      t.tick({ nowMs: t0 + i * 60_000, victron: { gridToBatteryW: 2_000, gridImportW: 40 }, socPct: 50, capacityWh: 77_000 });
    }
    assert.equal(t.summary().gridWh, 0);
    assert.equal(t.isLocked(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Kappung am Ladestand erst, wenn er 60 s lang zu niedrig ist (einzelner Fehlwert kostet nichts)', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.now();
    t.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 8_000 });
    t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 12_000, gridImportW: 12_000 }, socPct: 50, capacityWh: 8_000 });
    near(t.summary().gridWh, 200, 0.01);
    t.tick({ nowMs: t0 + 65_000, victron: {}, socPct: 0, capacityWh: 8_000 });   // Fehlwert: 0 %
    near(t.summary().gridWh, 200, 0.01);
    t.tick({ nowMs: t0 + 70_000, victron: {}, socPct: 50, capacityWh: 8_000 });
    near(t.summary().gridWh, 200, 0.01);
    assert.equal(t.isLocked(), true);
    // Echt niedrig über 60 s: dann wird gekappt (Obergrenze 1 % von 8 kWh = 80 Wh).
    for (let i = 1; i <= 8; i++) t.tick({ nowMs: t0 + 70_000 + i * 10_000, victron: {}, socPct: 0, capacityWh: 8_000 });
    near(t.summary().gridWh, 80, 0.01);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Sperre mit Hysterese: an über 100 Wh, frei erst bei höchstens 50 Wh', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.now();
    t.tick({ nowMs: t0, victron: {}, socPct: 1, capacityWh: 10_000 });
    t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 6_600, gridImportW: 6_600 }, socPct: 1, capacityWh: 10_000 });
    assert.equal(t.isLocked(), true);   // 110 Wh
    // Anteil 100 % (110 Wh bei 100 Wh Inhalt): 30 Wh ins Haus → 80 Wh, bleibt gesperrt
    t.tick({ nowMs: t0 + 70_000, victron: { batteryDirectUseW: 10_800 }, socPct: 1, capacityWh: 10_000 });
    assert.ok(t.summary().gridWh < 100 && t.summary().gridWh > 50, `${t.summary().gridWh}`);
    assert.equal(t.isLocked(), true, 'zwischen 50 und 100 Wh bleibt die Sperre');
    t.tick({ nowMs: t0 + 80_000, victron: { batteryDirectUseW: 18_000 }, socPct: 1, capacityWh: 10_000 });
    assert.equal(t.isLocked(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Zurücksetzen nur ausdrücklich, mit Protokollzeile', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.now();
    t.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 77_000 });
    t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 12_000, gridImportW: 12_000 }, socPct: 50, capacityWh: 77_000 });
    assert.equal(t.isLocked(), true);
    const r = t.reset({ reason: 'Test', actor: 'test' });
    assert.equal(r.ok, true);
    assert.equal(t.summary().gridWh, 0);
    assert.equal(t.isLocked(), false);
    const lines = fs.readFileSync(path.join(dir, GRID_SHARE_PROTOCOL_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const reset = lines.find((l) => l.event === 'reset');
    assert.ok(reset);
    near(reset.gridKwh, 0.2, 0.001);
    // Nachweis für den Direktvermarkter: Grund und Auslöser stehen auch im CSV.
    const csv = t.protocolCsv().split('\n');
    assert.match(csv[0], /;Sperre gilt;Grund;Ausgelöst von$/);
    assert.ok(csv.some((l) => l.includes(';reset;') && l.endsWith(';Test;test')), csv.join('\n'));
    // Freitext wird nie zur Formel und bricht keine Zeile.
    t.tick({ nowMs: t0 + 120_000, victron: { gridToBatteryW: 12_000, gridImportW: 12_000 }, socPct: 50, capacityWh: 77_000 });
    t.reset({ reason: '=HYPERLINK("http://x")\rzwei', actor: 'test' });
    const csv2 = t.protocolCsv();
    assert.ok(csv2.includes(`"'=HYPERLINK(""http://x"")\rzwei"`), csv2);
    const ro = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir, readOnly: true });
    assert.equal(ro.reset({}).ok, false, 'nur der zählende Prozess setzt zurück');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Zähler: integriert, sperrt über der Schwelle, meldet den Wechsel und übersteht einen Neustart', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } };
    const changes = [];
    const logs = [];
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: (e, d) => logs.push({ e, d }), dataDir: dir, onLockChange: (l) => changes.push(l) });
    const t0 = Date.parse('2026-11-02T01:00:00Z');
    t.tick({ nowMs: t0, victron: { gridToBatteryW: 0, gridImportW: 0 }, socPct: 20, capacityWh: 77_000 });
    t.tick({ nowMs: t0 + 30_000, victron: { gridToBatteryW: 10_000, gridImportW: 10_000 }, socPct: 20, capacityWh: 77_000 });
    assert.ok(GRID_SHARE_LOCK_THRESHOLD_WH > 83.4, 'Schwelle über 83 Wh — 30 s Netzladen sperrt noch nicht');
    assert.equal(t.isLocked(), false);
    const live = t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 10_000, gridImportW: 10_000 }, socPct: 20, capacityWh: 77_000 });
    near(live.gridWh, 166.67, 0.1);
    assert.equal(t.isLocked(), true);
    assert.deepEqual(changes, [true]);
    assert.ok(logs.some((l) => l.e === 'grid_share_lock' && l.d.locked === true));

    // Neustart: neuer Zähler liest den gespeicherten Stand.
    const t2 = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    near(t2.summary().gridWh, 166.67, 0.1);
    assert.equal(t2.isLocked(), true);
    assert.ok(fs.existsSync(path.join(dir, GRID_SHARE_STATE_FILE)));
    const protocol = fs.readFileSync(path.join(dir, GRID_SHARE_PROTOCOL_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(protocol[0].event, 'lock_on');

    // Entladen ins Haus mit Akku-Inhalt 166,67 Wh (Ladestand-Kappung) → Anteil sinkt bis unter die Schwelle.
    t2.tick({ nowMs: t0 + 120_000, victron: {}, socPct: 20, capacityWh: 77_000 });
    for (let i = 1; i <= 120; i++) {
      t2.tick({ nowMs: t0 + 120_000 + i * 30_000, victron: { batteryDirectUseW: 20_000 }, socPct: 0, capacityWh: 77_000 });
    }
    assert.equal(t2.isLocked(), false, 'Akku leer → Anteil weg → Sperre frei');
    const s = t2.summary();
    assert.ok(s.today.batteryToHomeFromGridKwh > 0.16, `Akku→Haus aus Netzstrom ${s.today.batteryToHomeFromGridKwh}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Zähler: Lücken zählen höchstens 60 s, Tageswechsel schreibt eine Tageszeile ins Protokoll', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const a = Date.parse('2026-11-02T20:00:00Z');
    t.tick({ nowMs: a, victron: {}, socPct: 50, capacityWh: 77_000 });
    t.tick({ nowMs: a + 2 * 3_600_000, victron: { gridToBatteryW: 6_000, gridImportW: 6_000 }, socPct: 50, capacityWh: 77_000 });
    near(t.summary().gridWh, 100, 0.01);   // 6 kW × 60 s, nicht × 2 h
    // 23:59:50 → 00:00:10 Ortszeit
    t.tick({ nowMs: Date.parse('2026-11-02T22:59:50Z'), victron: {}, socPct: 50, capacityWh: 77_000 });
    t.tick({ nowMs: Date.parse('2026-11-02T23:00:10Z'), victron: {}, socPct: 50, capacityWh: 77_000 });
    const lines = fs.readFileSync(path.join(dir, GRID_SHARE_PROTOCOL_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const day = lines.find((l) => l.event === 'day');
    assert.ok(day, 'Tageszeile');
    assert.equal(day.date, '2026-11-02');
    near(day.gridToBatteryKwh, 0.1, 0.001);
    assert.equal(t.summary().today.date, '2026-11-03');
    const csv = t.protocolCsv();
    assert.match(csv.split('\n')[0], /^Zeit;Ereignis;Datum/);
    assert.match(csv, /2026-11-02/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Zähler ohne Schreibrecht (Web-Prozess) liest den Stand aus der Datei', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } };
    const w = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.now();
    w.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 77_000 });
    w.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 12_000, gridImportW: 12_000 }, socPct: 50, capacityWh: 77_000 });
    assert.equal(w.isLocked(), true);
    const r = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir, readOnly: true });
    assert.equal(r.isLocked(), true);
    near(r.summary().gridWh, 200, 0.1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Sperre folgt der Einstellung: mit MiSpeL-Option keine Sperre trotz Anteil', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: true, mispel: { mode: 'abgrenzung' } }, schedule: { timezone: 'Europe/Berlin' } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.now();
    t.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 77_000 });
    t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 12_000, gridImportW: 12_000 }, socPct: 50, capacityWh: 77_000 });
    assert.equal(t.isLocked(), false);
    assert.equal(t.summary().applies, false);
    near(t.summary().gridWh, 200, 0.1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Unsichere Akkuwerte: nie abbuchen (Gegenprüfung Release 1.0.9, P2) ─────────
//
// Fallen Akkuleistung oder Ladestand aus (Lesefehler, alter Stempel, Einfrier-
// Wächter, Kreuzprobe), behält polling.js den letzten Wert. Würde der Zähler
// damit weiter Entladung abbuchen, fiele die Akku-Einspeisesperre, obwohl
// niemand weiß, ob der Akku entladen hat. Zubuchen (Netz → Akku) zählt weiter.

const lockedCfg = () => ({ optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } });

/** Zähler mit 200 Wh Netzstrom im Akku (Sperre an), Stempel frisch zu t0 + 60 s. */
function charged200(dir, { logs = [] } = {}) {
  const t = createGridShareTracker({ getCfg: lockedCfg, pushLog: (e, d, l) => logs.push({ e, d, l }), dataDir: dir });
  const t0 = Date.parse('2026-11-02T08:00:00Z');
  t.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 10_000 });
  t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 12_000, gridImportW: 12_000 }, socPct: 50, capacityWh: 10_000 });
  near(t.summary().gridWh, 200, 0.01);
  assert.equal(t.isLocked(), true);
  return { t, t0: t0 + 60_000, logs };
}

test('Reproduktion: 74 min Entladung mit Lesefehler, altem Stempel und Einfrier-Wächter bucht nichts ab, Sperre bleibt', () => {
  const dir = mkDir();
  try {
    const { t, t0, logs } = charged200(dir);
    const old = t0 - 60_000;
    for (let i = 1; i <= 74; i += 1) {
      t.tick({
        nowMs: t0 + i * 60_000, socPct: 50, capacityWh: 10_000,
        victron: {
          batteryDirectUseW: 6_000,
          errors: { batteryPowerW: 'timeout', soc: 'timeout' },
          fieldUpdatedAt: { batteryPowerW: old, soc: old },
          freeze: { active: true },
        },
      });
    }
    near(t.summary().gridWh, 200, 0.01);
    assert.equal(t.isLocked(), true, 'Sperre darf bei unbekannter Entladung nicht fallen');
    assert.equal(t.summary().today.batteryToHomeFromGridKwh, 0);
    assert.equal(logs.filter((l) => l.e === 'grid_share_uncertain').length, 1, 'einmal je Episode, nicht je Takt');
    assert.equal(t.summary().today.uncertainMinutes, 74);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jedes Unsicherheits-Merkmal allein verhindert das Abbuchen — auch für den zweiten Akku; frische Werte buchen ab', () => {
  const cases = [
    ['Lesefehler Akkuleistung', (n) => ({ errors: { batteryPowerW: 'timeout' }, fieldUpdatedAt: { batteryPowerW: n, soc: n } })],
    ['Lesefehler Ladestand', (n) => ({ errors: { soc: 'timeout' }, fieldUpdatedAt: { batteryPowerW: n, soc: n } })],
    ['Einfrier-Wächter', (n) => ({ freeze: { active: true }, fieldUpdatedAt: { batteryPowerW: n, soc: n } })],
    ['Kreuzprobe widerspricht', (n) => ({ sourceMismatch: { active: true }, fieldUpdatedAt: { batteryPowerW: n, soc: n } })],
    ['Akkuleistung veraltet', (n) => ({ fieldUpdatedAt: { batteryPowerW: n - 120_000, soc: n } })],
    ['Ladestand veraltet', (n) => ({ fieldUpdatedAt: { batteryPowerW: n, soc: n - 120_000 } })],
    ['MQTT-Wert alt trotz frischem Abfrage-Stempel', (n) => ({ fieldUpdatedAt: { batteryPowerW: n, soc: n }, fieldSourceAt: { batteryPowerW: n - 120_000 } })],
  ];
  for (const [name, flags] of cases) {
    const dir = mkDir();
    try {
      const { t, t0 } = charged200(dir);
      const n = t0 + 60_000;
      t.tick({
        nowMs: n, socPct: 50, capacityWh: 10_000,
        victron: { batteryDirectUseW: 6_000, batteryToGridW: 3_000, secondBatteryDirectUseW: 2_000, secondBatteryToGridW: 2_000, ...flags(n) },
      });
      near(t.summary().gridWh, 200, 0.01);
      assert.equal(t.isLocked(), true, name);
      assert.equal(t.summary().toHomeW, 0, `${name}: keine Live-Leistung aus Netzstrom`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // Gegenprobe: dieselbe Entladung mit frischen Werten bucht ab.
  const dir = mkDir();
  try {
    const { t, t0 } = charged200(dir);
    const n = t0 + 60_000;
    t.tick({
      nowMs: n, socPct: 50, capacityWh: 10_000,
      victron: { batteryDirectUseW: 6_000, secondBatteryDirectUseW: 2_000, errors: {}, fieldUpdatedAt: { batteryPowerW: n - 5_000, soc: n - 5_000 }, fieldSourceAt: { batteryPowerW: n - 2_000 } },
    });
    assert.ok(t.summary().gridWh < 200, `${t.summary().gridWh}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unsicher: Zubuchen zählt weiter, der Ladestand kappt nicht', () => {
  const dir = mkDir();
  try {
    const { t, t0 } = charged200(dir);
    const bad = (n) => ({ errors: { soc: 'timeout' }, fieldUpdatedAt: { batteryPowerW: n, soc: n } });
    t.tick({ nowMs: t0 + 60_000, socPct: 50, capacityWh: 10_000, victron: { gridToBatteryW: 6_000, gridImportW: 6_000, ...bad(t0 + 60_000) } });
    near(t.summary().gridWh, 300, 0.01);
    // Ladestand 0 % (Fehlwert) über mehrere Minuten: keine Kappung.
    for (let i = 2; i <= 6; i += 1) t.tick({ nowMs: t0 + i * 60_000, socPct: 0, capacityWh: 10_000, victron: bad(t0 + i * 60_000) });
    near(t.summary().gridWh, 300, 0.01);
    assert.equal(t.summary().today.lossFromGridKwh, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('zweite Anlage einbezogen, aber ihre Werte veraltet: nichts abbuchen', () => {
  const dir = mkDir();
  try {
    const { t, t0 } = charged200(dir);
    const n = t0 + 60_000;
    t.tick({ nowMs: n, socPct: 50, capacityWh: 10_000, secondBatteryStale: true, victron: { batteryDirectUseW: 6_000, fieldUpdatedAt: { batteryPowerW: n, soc: n } } });
    near(t.summary().gridWh, 200, 0.01);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Episode: Ende erst nach 60 s sicherer Werte im Log, Tageszeile und CSV nennen die Minuten ohne Abbuchung', () => {
  const dir = mkDir();
  try {
    const { t, t0, logs } = charged200(dir);
    const bad = (n) => ({ errors: { batteryPowerW: 'timeout' }, fieldUpdatedAt: { batteryPowerW: n, soc: n } });
    const good = (n) => ({ errors: {}, fieldUpdatedAt: { batteryPowerW: n, soc: n } });
    // Flattern: unsicher, kurz sicher, wieder unsicher → eine Episode.
    t.tick({ nowMs: t0 + 30_000, socPct: 50, capacityWh: 10_000, victron: bad(t0 + 30_000) });
    t.tick({ nowMs: t0 + 40_000, socPct: 50, capacityWh: 10_000, victron: good(t0 + 40_000) });
    t.tick({ nowMs: t0 + 50_000, socPct: 50, capacityWh: 10_000, victron: bad(t0 + 50_000) });
    assert.equal(logs.filter((l) => l.e === 'grid_share_uncertain').length, 1);
    const start = logs.find((l) => l.e === 'grid_share_uncertain');
    assert.deepEqual(start.d.reasons, ['battery_power_error']);
    assert.equal(start.l, 'warn');
    for (let i = 1; i <= 7; i += 1) t.tick({ nowMs: t0 + 50_000 + i * 10_000, socPct: 50, capacityWh: 10_000, victron: good(t0 + 50_000 + i * 10_000) });
    assert.equal(logs.filter((l) => l.e === 'grid_share_uncertain_end').length, 1);
    // Tageswechsel → Tageszeile mit den Minuten ohne Abbuchung.
    t.tick({ nowMs: Date.parse('2026-11-02T23:00:10Z'), socPct: 50, capacityWh: 10_000, victron: good(Date.parse('2026-11-02T23:00:10Z')) });
    const day = fs.readFileSync(path.join(dir, GRID_SHARE_PROTOCOL_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.event === 'day');
    assert.ok(day);
    assert.ok(day.uncertainMinutes > 0, JSON.stringify(day));
    assert.match(t.protocolCsv().split('\n')[0], /Akkuwerte unsicher min/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MQTT-Weg: der Poller merkt sich das Alter des MQTT-Werts, der Zähler bucht mit altem Wert nicht ab', async () => {
  const { createMqttTransport } = await import('../transport-mqtt.js');
  const { createPoller } = await import('../polling.js');
  // staleMaxAgeMs 0 = Transport-Frische aus: der Wert wird geliefert und frisch
  // gestempelt, obwohl er 10 min alt ist.
  const tr = createMqttTransport({ host: '', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub', staleMaxAgeMs: 0 } });
  const old = Date.now() - 600_000;
  tr.ingest('grid_total', 0);
  tr.ingest('battery_power', -6_000, old);
  tr.ingest('battery_soc', 50);
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-02', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
  };
  const pcfg = {
    pollMs: 500, gridPositiveMeans: 'grid_import',
    points: { soc: { enabled: true }, batteryPowerW: { enabled: true } },
    epex: { timezone: 'UTC' }, userEnergyPricing: {}, dvControl: {},
  };
  const poller = createPoller({
    state, getCfg: () => pcfg, transport: tr, pushLog: () => {},
    energyPath: path.join(os.tmpdir(), 'grid-share-mqtt-test.json'), onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, -6_000);
  assert.ok(state.victron.batteryDirectUseW > 0, 'Entladung kommt im Fluss an');
  assert.ok(Date.now() - state.victron.fieldUpdatedAt.batteryPowerW < 5_000, 'Abfrage-Stempel ist frisch');
  assert.equal(state.victron.fieldSourceAt?.batteryPowerW, old, 'Alter des MQTT-Werts');

  const dir = mkDir();
  try {
    const t = createGridShareTracker({ getCfg: lockedCfg, pushLog: () => {}, dataDir: dir });
    const n = Date.now();
    t.tick({ nowMs: n - 60_000, victron: {}, socPct: 50, capacityWh: 10_000 });
    t.tick({ nowMs: n - 1, victron: { gridToBatteryW: 12_000, gridImportW: 12_000 }, socPct: 50, capacityWh: 10_000 });
    t.tick({ nowMs: n + 59_999, victron: { ...state.victron }, socPct: 50, capacityWh: 10_000 });
    near(t.summary().gridWh, 200, 0.01);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Gegenprüfung 4cf16a5a (Claude, Runde 1) ───────────────────────────────────

test('alte Ladeleistung bei frischem Ladestand: Zubuchen wird am Ladestand gekappt und im Protokoll als unsicher ausgewiesen (P2)', () => {
  const dir = mkDir();
  try {
    const { t, t0 } = charged200(dir);
    // Akkuleistung mit Lesefehler (alter Wert +6000 W), Haus zieht 1 kW aus dem
    // Netz, Ladestand frisch bei 50 % von 10 kWh → Obergrenze 5,1 kWh.
    // 6 h × 1 kW = 6 kWh + 200 Wh → ohne Kappung 6,2 kWh.
    for (let i = 1; i <= 360; i += 1) {
      const n = t0 + i * 60_000;
      t.tick({ nowMs: n, socPct: 50, capacityWh: 10_000, victron: { gridToBatteryW: 6_000, gridImportW: 1_000, errors: { batteryPowerW: 'timeout' }, fieldUpdatedAt: { batteryPowerW: t0, soc: n } } });
    }
    // Obergrenze 5,1 kWh; die Kappung wartet 60 s auf Bestätigung → höchstens
    // zwei Minuten Zufluss (je 16,7 Wh) darüber.
    assert.ok(t.summary().gridWh >= 5_100 - 0.01 && t.summary().gridWh <= 5_100 + 34, `${t.summary().gridWh}`);
    const s = t.summary();
    assert.ok(s.today.uncertainGridToBatteryKwh > 0, 'Zubuchen bei unsicheren Werten ist ausgewiesen');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('der Zähler wird nie größer als die Akkukapazität, auch ohne Ladestand (P2)', () => {
  const r = stepGridShare(9_900, { dtMs: 3_600_000, gridToBatteryW: 6_000, socPct: null, capacityWh: 10_000 });
  near(r.gridWh, 10_000);
  near(r.lossWh, 5_900);
  const dir = mkDir();
  try {
    const { t, t0 } = charged200(dir);
    const frozen = { freeze: { active: true } };
    for (let i = 1; i <= 180; i += 1) t.tick({ nowMs: t0 + i * 60_000, socPct: 50, capacityWh: 10_000, victron: { gridToBatteryW: 6_000, gridImportW: 6_000, ...frozen } });
    assert.ok(t.summary().gridWh <= 10_000 + 0.01, `${t.summary().gridWh}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Einfrier-Verdacht aus dem Stable-Kanal (freezeSuspect) verhindert das Abbuchen (P2)', () => {
  const dir = mkDir();
  try {
    const { t, t0 } = charged200(dir);
    const n = t0 + 60_000;
    t.tick({ nowMs: n, socPct: 50, capacityWh: 10_000, victron: { batteryDirectUseW: 6_000, freezeSuspect: { active: true }, fieldUpdatedAt: { batteryPowerW: n, soc: n } } });
    near(t.summary().gridWh, 200, 0.01);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MQTT-Wertalter mit eigener Frist: kurzes telemetryMaxAgeMs macht 30 s alte Keepalive-Werte nicht unsicher (P3)', () => {
  const dir = mkDir();
  try {
    const cfg = { ...lockedCfg(), victron: { telemetryMaxAgeMs: 20_000 } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.parse('2026-11-02T08:00:00Z');
    t.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 10_000 });
    t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 12_000, gridImportW: 12_000 }, socPct: 50, capacityWh: 10_000 });
    const n = t0 + 120_000;
    t.tick({ nowMs: n, socPct: 50, capacityWh: 10_000, victron: { batteryDirectUseW: 6_000, fieldUpdatedAt: { batteryPowerW: n, soc: n }, fieldSourceAt: { batteryPowerW: n - 2_000, soc: n - 30_000 } } });
    assert.ok(t.summary().gridWh < 200, `${t.summary().gridWh}`);
    assert.equal(gridShareBatteryUncertainReasons({ fieldUpdatedAt: { soc: n - 30_000 } }, n, 20_000).includes('soc_stale'), true, 'Abfrage-Stempel folgt weiter telemetryMaxAgeMs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
