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
} from '../services/optimizer/grid-share.js';

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
