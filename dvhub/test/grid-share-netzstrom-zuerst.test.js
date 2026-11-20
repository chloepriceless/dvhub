// test/grid-share-netzstrom-zuerst.test.js — Zählregel „Netzstrom zuerst ins Haus“
// (Entscheidung Christin 20.11.2026).
//
// Christin: „Netzstrom zuerst ins Haus, halten darf auch dann aktiv sein und
// muss nicht ausgesetzt werden, halten macht ja genau das, deckt den
// Eigenverbrauch aus dem Netz“.
//
// Bis dahin senkte jede Entladung den Netzstrom-Anteil G im Akku ANTEILIG
// (G / Inhalt × Entladung). Auf Prod stand die Sperre so seit 05.11. ohne
// Unterbrechung: In einer Nacht gingen 12,9 kWh aus dem Akku ins Haus, G sank
// nur von 2,29 auf 1,63 kWh (Anteil 5,1 %). Neu:
//   - Akku→Haus senkt G 1:1 — der Netzstrom wird zuerst im Haus verbraucht;
//   - Akku→Netz nimmt zuerst den Teil des Inhalts, der kein Netzstrom ist (PV),
//     und erst Netzstrom, wenn der aufgebraucht ist (rechnerisch nie Netzstrom
//     verkaufen);
//   - Reihenfolge innerhalb eines Schritts: erst Haus, dann Netz.
// Unverändert: ohne sicheren Ladestand oder ohne Kapazität bucht Entladen
// nichts ab (Sperre im Zweifel an), M21-Kappung am Inhalt über dem Boden,
// M10-Boden-Reset, Zubuchen, Hysterese.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GRID_SHARE_STATE_FILE,
  GRID_SHARE_PROTOCOL_FILE,
  stepGridShare,
  createGridShareTracker,
} from '../services/optimizer/grid-share.js';

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-grid-share-haus-zuerst-'));
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const lockedCfg = () => ({ optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } });
const HOUR = 3_600_000;

/** Zähler mit gespeichertem Stand (gesperrt), wie nach einem Neustart auf der Anlage. */
function trackerWith(dir, gridWh, logs = []) {
  fs.writeFileSync(path.join(dir, GRID_SHARE_STATE_FILE), JSON.stringify({ version: 1, gridWh, locked: true }) + '\n');
  return createGridShareTracker({ getCfg: lockedCfg, pushLog: (e, d, l) => logs.push({ e, d, l }), dataDir: dir });
}

// ── Akku→Haus: 1:1 ────────────────────────────────────────────────────────────

test('Akku→Haus senkt den Netzstrom 1:1: 3 kWh Netzstrom im 30-kWh-Akku, 3 kWh ins Haus → 0', () => {
  // Inhalt 80 % von 30 kWh = 24 kWh, davon 3 kWh Netzstrom (12,5 %). Anteilig wären nur 375 Wh abgebucht worden.
  const r = stepGridShare(3_000, { dtMs: HOUR, batteryToHomeW: 3_000, socPct: 80, capacityWh: 30_000 });
  near(r.toHomeWh, 3_000);
  near(r.gridWh, 0);
  assert.equal(r.toGridWh, 0);
  assert.equal(r.lossWh, 0);
});

test('Akku→Haus über den Netzstrom hinaus: abgebucht wird höchstens, was an Netzstrom drin ist', () => {
  const r = stepGridShare(1_000, { dtMs: HOUR, batteryToHomeW: 3_000, socPct: 80, capacityWh: 30_000 });
  near(r.toHomeWh, 1_000);
  assert.equal(r.gridWh, 0);
});

test('Zähler: 3 kWh Netzstrom im 30-kWh-Akku, eine Stunde 3 kW ins Haus → Netzstrom 0, die Sperre fällt', () => {
  const dir = mkDir();
  try {
    const logs = [];
    const t = trackerWith(dir, 3_000, logs);
    const t0 = Date.parse('2026-11-20T00:00:00Z');
    t.tick({ nowMs: t0, victron: {}, socPct: 90, capacityWh: 30_000 });
    assert.equal(t.isLocked(), true, 'vorher gesperrt');
    // Ladestand sinkt mit: 3 kWh von 30 kWh = 10 Prozentpunkte in der Stunde.
    for (let s = 10; s <= 3_600; s += 10) {
      t.tick({ nowMs: t0 + s * 1_000, victron: { batteryDirectUseW: 3_000 }, socPct: 90 - 10 * s / 3_600, capacityWh: 30_000 });
    }
    const sum = t.summary();
    near(sum.gridWh, 0, 0.5);
    assert.equal(t.isLocked(), false, 'Netzstrom im Haus verbraucht → Sperre frei');
    near(sum.today.batteryToHomeFromGridKwh, 3, 0.001);
    assert.equal(sum.today.lossFromGridKwh, 0, 'kein Verlust: alles regulär im Haus verbraucht');
    const protocol = fs.readFileSync(path.join(dir, GRID_SHARE_PROTOCOL_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(protocol.some((e) => e.event === 'lock_off'), 'Sperrwechsel steht im Nachweis');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Akku→Netz: zuerst der PV-Teil ─────────────────────────────────────────────

test('Akku→Netz mit PV-Teil im Inhalt bucht keinen Netzstrom ab, solange der PV-Teil reicht', () => {
  // 24 kWh Inhalt, 3 kWh Netzstrom → 21 kWh PV. 5 kWh ins Netz kommen ganz aus dem PV-Teil.
  const r = stepGridShare(3_000, { dtMs: HOUR, batteryToGridW: 5_000, socPct: 80, capacityWh: 30_000 });
  assert.equal(r.toGridWh, 0);
  near(r.gridWh, 3_000);
});

test('Akku→Netz: erst wenn der PV-Teil aufgebraucht ist, zählt Netzstrom (Nachweis)', () => {
  // 3,6 kWh Inhalt (12 % von 30 kWh), 3 kWh Netzstrom → 0,6 kWh PV. 1 kWh ins Netz: 0,6 PV + 0,4 Netzstrom.
  const r = stepGridShare(3_000, { dtMs: HOUR, batteryToGridW: 1_000, socPct: 12, capacityWh: 30_000 });
  near(r.toGridWh, 400);
  near(r.gridWh, 2_600);
});

test('Akku→Netz: der PV-Teil zählt nur über dem Entlade-Boden (M10)', () => {
  // 21 % bei Boden 11 % von 30 kWh → 3 kWh nutzbar, alles Netzstrom: kein PV-Teil, 1 kWh ins Netz ist Netzstrom.
  const r = stepGridShare(3_000, { dtMs: HOUR, batteryToGridW: 1_000, socPct: 21, floorPct: 11, capacityWh: 30_000 });
  near(r.storedWh, 3_000);
  near(r.toGridWh, 1_000);
  near(r.gridWh, 2_000);
});

// Codex 885ac894 P2: Victron meldet den Ladestand ganzzahlig — der Inhalt laut Lesung bleibt über viele Messungen
// gleich. Leitete jeder Schritt den PV-Teil neu aus „Inhalt − G“ ab, erschien jede schon gebuchte Netzstrom-Ausfuhr
// im nächsten Schritt als PV: von 500 Wh Ausfuhr aus einem reinen Netzstrom-Akku zählten nur ~25 Wh als Netzstrom,
// der Rest kam beim nächsten Ladestands-Sprung als Verlust (M21) — falscher Nachweis.
test('ganzzahliger Ladestand: Ausfuhr aus einem reinen Netzstrom-Akku zählt ganz als Netzstrom, nicht als Verlust', () => {
  const dir = mkDir();
  try {
    const t = trackerWith(dir, 5_000);
    const t0 = Date.parse('2026-11-20T03:00:00Z');
    // 10 kWh, 50 % → 5 kWh Inhalt, alles Netzstrom. 6 kW ins Netz, alle 5 s, 300 s = 500 Wh.
    t.tick({ nowMs: t0, victron: {}, socPct: 50, capacityWh: 10_000 });
    for (let s = 5; s <= 300; s += 5) {
      t.tick({ nowMs: t0 + s * 1_000, victron: { batteryToGridW: 6_000 }, socPct: Math.round(50 - 5 * s / 300), capacityWh: 10_000 });
    }
    const sum = t.summary();
    near(sum.today.batteryToGridFromGridKwh, 0.5, 0.01);
    // Verlust höchstens die Rundung der Lesung (halber Prozentschritt = 50 Wh, M21 beim ersten Sprung 50 → 49 %),
    // nicht mehr die ganze Ausfuhr (vorher ~0,41 kWh).
    assert.ok(sum.today.lossFromGridKwh <= 0.05, `kein Verlust statt Ausfuhr: ${sum.today.lossFromGridKwh} kWh`);
    near(sum.gridWh, 4_500, 50);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Codex df71923b P1: lud PV den Akku bei gleicher Lesung nach, wuchs der mitgeführte PV-Teil nicht mit — wechselten
// Ausfuhr und PV-Ladung, ohne dass sich der ganzzahlige Ladestand änderte, sank G bis 0 und die Sperre fiel.
test('ganzzahliger Ladestand: PV-Ladung füllt den PV-Teil wieder auf — Ausfuhr und Ladung im Wechsel lassen G stehen', () => {
  const dir = mkDir();
  try {
    const t = trackerWith(dir, 3_000);
    const t0 = Date.parse('2026-11-20T12:00:00Z');
    // 10 kWh, 50 % → 5 kWh Inhalt: 3 kWh Netzstrom, 2 kWh PV. Je Runde 20 Wh ins Netz, dann 20 Wh PV in den Akku.
    const p = { socPct: 50, capacityWh: 10_000 };
    t.tick({ nowMs: t0, victron: {}, ...p });
    let n = t0;
    for (let i = 0; i < 250; i += 1) {
      n += 5_000;
      t.tick({ nowMs: n, victron: { batteryToGridW: 14_400 }, ...p });
      n += 5_000;
      t.tick({ nowMs: n, victron: { solarToBatteryW: 14_400 }, ...p });
    }
    const sum = t.summary();
    near(sum.gridWh, 3_000);
    assert.equal(sum.today.batteryToGridFromGridKwh, 0, 'die Ausfuhr kam aus PV');
    assert.equal(t.isLocked(), true, 'Sperre bleibt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stepGridShare: der mitgeführte Inhalt gilt nur bei unveränderter Lesung, Laden erhöht ihn', () => {
  const p = { dtMs: HOUR, batteryToGridW: 1_000, socPct: 50, capacityWh: 10_000 };
  // Lesung 5 kWh, G 4 kWh, mitgeführter Inhalt 4 kWh (PV schon ausgeführt): 1 kWh ins Netz ist Netzstrom.
  const same = stepGridShare(4_000, { ...p, contentCarry: { storedWh: 5_000, contentWh: 4_000 } });
  near(same.toGridWh, 1_000);
  near(same.contentWh, 3_000);
  // Neue Lesung (anderer Inhalt): Inhalt wieder aus der Messung, 1 kWh PV → kein Netzstrom.
  const changed = stepGridShare(4_000, { ...p, contentCarry: { storedWh: 5_100, contentWh: 4_000 } });
  assert.equal(changed.toGridWh, 0);
  near(changed.contentWh, 4_000);
  // Laden (PV oder Netz) erhöht den mitgeführten Inhalt — erst für den nächsten Schritt.
  const charged = stepGridShare(4_000, { dtMs: HOUR, batteryChargeW: 500, socPct: 50, capacityWh: 10_000, contentCarry: { storedWh: 5_000, contentWh: 4_000 } });
  near(charged.contentWh, 4_500);
  // Nie mehr als der Akku über dem Boden fasst.
  const full = stepGridShare(0, { dtMs: HOUR, batteryChargeW: 9_000, socPct: 50, capacityWh: 10_000, floorPct: 10, contentCarry: { storedWh: 4_000, contentWh: 4_000 } });
  near(full.contentWh, 9_000);
});

// ── Reihenfolge im Schritt: erst Haus, dann Netz ──────────────────────────────

test('Haus und Netz im selben Schritt: das Haus nimmt den Netzstrom, das Netz den PV-Teil', () => {
  // 5 kWh Inhalt, 1 kWh Netzstrom: 0,5 kWh ins Haus (Netzstrom), 2 kWh ins Netz (PV).
  const a = stepGridShare(1_000, { dtMs: HOUR, batteryToHomeW: 500, batteryToGridW: 2_000, socPct: 50, capacityWh: 10_000 });
  near(a.toHomeWh, 500);
  assert.equal(a.toGridWh, 0);
  near(a.gridWh, 500);
  // Mehr ins Haus als Netzstrom drin ist: das Haus nimmt allen Netzstrom, der Rest des Hauses und das Netz kommen aus PV.
  const b = stepGridShare(1_000, { dtMs: HOUR, batteryToHomeW: 2_000, batteryToGridW: 2_500, socPct: 50, capacityWh: 10_000 });
  near(b.toHomeWh, 1_000);
  assert.equal(b.toGridWh, 0);
  assert.equal(b.gridWh, 0);
});

test('Reihenfolge erst Haus, dann Netz: bei unstimmigen Werten (Entladung größer als der Inhalt) geht weniger Netzstrom ins Netz', () => {
  // 2 kWh Inhalt (Lesung hinkt), 1 kWh Netzstrom, 0,5 kWh ins Haus und 2 kWh ins Netz im selben Schritt.
  // Erst Haus: 0,5 kWh Netzstrom ins Haus; PV-Teil danach 2 − 1 = 1 kWh fürs Netz, dann 0,5 kWh Netzstrom.
  // (Erst Netz hätte 1 kWh Netzstrom ins Netz gebucht und keinen ins Haus.)
  const r = stepGridShare(1_000, { dtMs: HOUR, batteryToHomeW: 500, batteryToGridW: 2_000, socPct: 20, capacityWh: 10_000 });
  near(r.toHomeWh, 500);
  near(r.toGridWh, 500);
  assert.equal(r.gridWh, 0);
});

// ── Unverändert: ohne sicheren Ladestand oder Kapazität nichts abbuchen ─────

test('ohne Ladestand oder ohne Kapazität bucht Entladen weiterhin nichts ab (Sperre im Zweifel an)', () => {
  const flows = { dtMs: HOUR, batteryToHomeW: 3_000, batteryToGridW: 1_000 };
  const noSoc = stepGridShare(3_000, { ...flows, socPct: null, capacityWh: 30_000 });
  near(noSoc.gridWh, 3_000);
  assert.equal(noSoc.toHomeWh, 0);
  assert.equal(noSoc.toGridWh, 0);
  const noCap = stepGridShare(3_000, { ...flows, socPct: 80, capacityWh: null });
  near(noCap.gridWh, 3_000);
  assert.equal(noCap.toHomeWh, 0);
  assert.equal(noCap.toGridWh, 0);
});

// ── Live-Anzeige nach derselben Regel ─────────────────────────────────────────

test('Live-Leistung aus Netzstrom folgt der Regel: ganze Hausentladung, Einspeisung aus dem PV-Teil zählt nicht', () => {
  const dir = mkDir();
  try {
    const t = trackerWith(dir, 3_000);
    const t0 = Date.parse('2026-11-20T01:00:00Z');
    const p = { socPct: 80, capacityWh: 30_000 };
    t.tick({ nowMs: t0, victron: {}, ...p });
    t.tick({ nowMs: t0 + 10_000, victron: { batteryDirectUseW: 3_000, batteryToGridW: 2_000 }, ...p });
    assert.equal(t.summary().toHomeW, 3_000, 'die Hausentladung kommt ganz aus dem Netzstrom');
    assert.equal(t.summary().toGridW, 0, 'die Einspeisung kommt aus dem PV-Teil');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Live-Leistung: ist der Netzstrom aufgebraucht, kommt nichts mehr aus Netzstrom', () => {
  const dir = mkDir();
  try {
    const t = trackerWith(dir, 5);
    const t0 = Date.parse('2026-11-20T02:00:00Z');
    const p = { socPct: 80, capacityWh: 30_000 };
    t.tick({ nowMs: t0, victron: {}, ...p });
    // 10 s × 3 kW = 8,3 Wh, nur 5 Wh Netzstrom drin: im Mittel 1800 W aus Netzstrom.
    t.tick({ nowMs: t0 + 10_000, victron: { batteryDirectUseW: 3_000 }, ...p });
    assert.equal(t.summary().toHomeW, 1_800);
    t.tick({ nowMs: t0 + 20_000, victron: { batteryDirectUseW: 3_000 }, ...p });
    assert.equal(t.summary().gridWh, 0);
    assert.equal(t.summary().toHomeW, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
