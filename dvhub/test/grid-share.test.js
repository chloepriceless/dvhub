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

test('Ausfuhr-Deckel: nur der PV-Überschuss (minus Sicherheitsabstand), mindestens der Puffer', () => {
  assert.equal(gridShareExportCapW({ pvW: 3_000, loadW: 1_000, bufferW: 100 }), 2_000 - GRID_SHARE_EXPORT_MARGIN_W);
  assert.equal(gridShareExportCapW({ pvW: 0, loadW: 1_000, bufferW: 100 }), 100);
  assert.equal(gridShareExportCapW({ pvW: 0, loadW: 1_000, bufferW: 0 }), 0);
  assert.equal(gridShareExportCapW({ pvW: null, loadW: 500, bufferW: 100 }), 100, 'unbekannte PV → nur Puffer');
  assert.equal(gridShareExportCapW({ pvW: 4_000, loadW: null, bufferW: 100 }), 100, 'unbekannte Last → nur Puffer');
});

test('Zähler: integriert, sperrt über der Schwelle, meldet den Wechsel und übersteht einen Neustart', () => {
  const dir = mkDir();
  try {
    const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } };
    const changes = [];
    const logs = [];
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: (e, d) => logs.push({ e, d }), dataDir: dir, onLockChange: (l) => changes.push(l) });
    const t0 = Date.parse('2026-11-02T01:00:00Z');
    t.tick({ nowMs: t0, victron: { gridToBatteryW: 0 }, socPct: 20, capacityWh: 77_000 });
    t.tick({ nowMs: t0 + 30_000, victron: { gridToBatteryW: 10_000 }, socPct: 20, capacityWh: 77_000 });
    assert.ok(GRID_SHARE_LOCK_THRESHOLD_WH > 83.4, 'Schwelle über 83 Wh — 30 s Netzladen sperrt noch nicht');
    assert.equal(t.isLocked(), false);
    const live = t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 10_000 }, socPct: 20, capacityWh: 77_000 });
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
    const cfg = { optimizer: {}, schedule: { timezone: 'Europe/Berlin' } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const a = Date.parse('2026-11-02T20:00:00Z');
    t.tick({ nowMs: a, victron: {}, socPct: 50, capacityWh: 77_000 });
    t.tick({ nowMs: a + 2 * 3_600_000, victron: { gridToBatteryW: 6_000 }, socPct: 50, capacityWh: 77_000 });
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
    const cfg = { optimizer: {}, schedule: { timezone: 'Europe/Berlin' } };
    const w = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.now();
    w.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 77_000 });
    w.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 12_000 }, socPct: 50, capacityWh: 77_000 });
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
    const cfg = { optimizer: { mispel: { mode: 'abgrenzung' } }, schedule: { timezone: 'Europe/Berlin' } };
    const t = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: dir });
    const t0 = Date.now();
    t.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 77_000 });
    t.tick({ nowMs: t0 + 60_000, victron: { gridToBatteryW: 12_000 }, socPct: 50, capacityWh: 77_000 });
    assert.equal(t.isLocked(), false);
    assert.equal(t.summary().applies, false);
    near(t.summary().gridWh, 200, 0.1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
