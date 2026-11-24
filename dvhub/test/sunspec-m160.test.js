// SunSpec Model 160 (Multiple MPPT Inverter Extension) — Per-MPPT/String-
// Telemetrie (T-MPPT-TELEMETRY). Testet den reinen Modul-Parser gegen das
// spec-verifizierte Layout: SFs +0..+3, N +6, Module à 20 ab +8, DCW am
// Modul-Relativ-Offset +11 (NICHT +3 — das war der Offset-Bug des alten
// Inline-Parsers, der mitten im IDStr las).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseM160Modules,
  m160ModuleDcw,
  m160PvStrings
} from '../services/inverter/sunspec.js';

const u16 = (n) => n & 0xffff; // int16/uint16 → Registerwort

// Baut einen Model-160-Datenblock (ab model.address, ohne den 2-Reg-Header).
// sfs: { dca, dcv, dcw, dcwh }; modules: [{ id, dca, dcv, dcw, dcwh }] (Rohwerte).
function buildM160({ sfs, modules }) {
  const regs = [];
  regs[0] = u16(sfs.dca);
  regs[1] = u16(sfs.dcv);
  regs[2] = u16(sfs.dcw);
  regs[3] = u16(sfs.dcwh);
  regs[4] = 0; regs[5] = 0;        // Evt
  regs[6] = modules.length;        // N
  regs[7] = 0;                     // TmsPer
  modules.forEach((m, i) => {
    const base = 8 + i * 20;
    for (let k = 0; k < 20; k += 1) regs[base + k] = 0;
    regs[base + 0] = u16(m.id ?? (i + 1));           // ID
    // IDStr +1..+8 bleibt 0 — stünde DCW fälschlich bei +3, läse man hier 0.
    regs[base + 3] = 0x4242;                          // Falle: +3 (IDStr) ≠ DCW
    regs[base + 9] = u16(m.dca ?? 0);                 // DCA
    regs[base + 10] = u16(m.dcv ?? 0);                // DCV
    regs[base + 11] = u16(m.dcw ?? 0);                // DCW (spec: +11)
    regs[base + 12] = u16(((m.dcwh ?? 0) >>> 16));    // DCWH acc32 hi
    regs[base + 13] = u16((m.dcwh ?? 0) & 0xffff);    // DCWH acc32 lo
  });
  return regs;
}

test('parseM160Modules liest DCW/DCV/DCA je Modul am spec-Offset +11', () => {
  const regs = buildM160({
    sfs: { dca: -2, dcv: -1, dcw: 0, dcwh: 0 },
    modules: [
      { id: 1, dca: 500, dcv: 4000, dcw: 3500, dcwh: 123456 }, // PV Süd
      { id: 2, dca: 300, dcv: 3900, dcw: 1800, dcwh: 60000 }   // PV Nord
    ]
  });
  const parsed = parseM160Modules(regs);
  assert.equal(parsed.n, 2);
  assert.equal(parsed.dcwSf, 0);
  assert.equal(parsed.modules.length, 2);
  const m1 = parsed.modules[0];
  assert.equal(m1.module, 1);
  assert.equal(m1.dcw, 3500);           // DCW_SF 0
  assert.equal(m1.dcv, 400);            // 4000 × 10^-1
  assert.equal(m1.dca, 5);              // 500 × 10^-2
  assert.equal(m1.dcwh, 123456);
  // Der +3-Fallenwert (0x4242 = 16962) darf NIRGENDS als Leistung auftauchen.
  assert.notEqual(m1.dcw, 16962);
  assert.equal(parsed.modules[1].dcw, 1800);
});

test('parseM160Modules: not-implemented-Sentinels → null statt Müll', () => {
  const regs = buildM160({
    sfs: { dca: 0, dcv: 0, dcw: 0, dcwh: 0 },
    modules: [{ id: 1, dca: 0xffff, dcv: 0xffff, dcw: 0xffff, dcwh: 0 }]
  });
  const parsed = parseM160Modules(regs);
  assert.equal(parsed.modules[0].dcw, null); // uint16 0xFFFF (DCW ist laut Model 160 uint16)
  assert.equal(parsed.modules[0].dcv, null); // uint16 0xFFFF
  assert.equal(parsed.modules[0].dca, null);
});

// Codex Integration 24.11. (P2): DCW ist in Model 160 uint16 — große Strings (Rohwert > 32767) bleiben positiv,
// 0x8000 ist ein gültiger Wert, nur 0xFFFF heißt „nicht implementiert“.
test('parseM160Modules: DCW als uint16 — 40000 mit SF −1 sind 4000 W, 0x8000 ist ein Wert', () => {
  const regs = buildM160({
    sfs: { dca: 0, dcv: 0, dcw: -1, dcwh: 0 },
    modules: [{ id: 1, dcw: 40000 }, { id: 2, dcw: 0x8000 }]
  });
  const parsed = parseM160Modules(regs);
  assert.equal(parsed.modules[0].dcw, 4000);
  assert.equal(parsed.modules[1].dcw, 3276.8);
});

test('parseM160Modules: unbekannter DCW_SF (0x8000) → dcw null', () => {
  const regs = buildM160({
    sfs: { dca: 0, dcv: 0, dcw: 0x8000, dcwh: 0 },
    modules: [{ id: 1, dcw: 3500 }]
  });
  const parsed = parseM160Modules(regs);
  assert.equal(parsed.dcwSf, null);
  assert.equal(parsed.modules[0].dcw, null);
});

test('parseM160Modules: N aus Müll (0xFFFF) → 0 Module, kein Durchlauf', () => {
  const regs = buildM160({ sfs: { dca: 0, dcv: 0, dcw: 0, dcwh: 0 }, modules: [{ dcw: 1 }] });
  regs[6] = 0xffff;
  const parsed = parseM160Modules(regs);
  assert.equal(parsed.n, 0);
  assert.equal(parsed.modules.length, 0);
});

test('parseM160Modules: zu kurzes Register-Material bricht sauber ab', () => {
  const regs = buildM160({
    sfs: { dca: 0, dcv: 0, dcw: 0, dcwh: 0 },
    modules: [{ dcw: 1000 }, { dcw: 2000 }]
  });
  regs.length = 8 + 20 + 11; // nur Modul 1 vollständig (bis dessen DCW)
  const parsed = parseM160Modules(regs);
  assert.equal(parsed.modules.length, 1);
  assert.equal(parsed.modules[0].dcw, 1000);
});

test('m160ModuleDcw: Akku-Derive liest genau das Lade-/Entlade-Modul (GEN24 3/4)', () => {
  // GEN24: Module 1/2 = PV, 3 = Laden, 4 = Entladen.
  const regs = buildM160({
    sfs: { dca: 0, dcv: 0, dcw: 0, dcwh: 0 },
    modules: [
      { id: 1, dcw: 3000 }, { id: 2, dcw: 1500 },
      { id: 3, dcw: 2200 }, { id: 4, dcw: 0 }
    ]
  });
  const parsed = parseM160Modules(regs);
  const charge = m160ModuleDcw(parsed, 3);
  const discharge = m160ModuleDcw(parsed, 4);
  assert.equal(charge, 2200);
  assert.equal(discharge, 0);
  assert.equal(charge - discharge, 2200); // batteryPowerW, positiv = Laden
  assert.equal(m160ModuleDcw(parsed, 9), null); // fehlendes Modul
});

test('m160PvStrings: Akku-Module ausgeschlossen, nur PV-Strings mit gültigem DCW', () => {
  const regs = buildM160({
    sfs: { dca: -2, dcv: -1, dcw: 0, dcwh: 0 },
    modules: [
      { id: 1, dcw: 3000, dcv: 4000, dca: 700, dcwh: 50000 },
      { id: 2, dcw: 1500 },
      { id: 3, dcw: 2200 }, // Akku laden
      { id: 4, dcw: 0 }     // Akku entladen
    ]
  });
  const parsed = parseM160Modules(regs);
  const strings = m160PvStrings(parsed, [3, 4]);
  assert.deepEqual(strings.map((s) => s.module), [1, 2]);
  assert.equal(strings[0].w, 3000);
  assert.equal(strings[0].v, 400);
  assert.equal(strings[1].w, 1500);
});

test('m160PvStrings: Modul mit not-implemented-DCW erzeugt keine Reihe', () => {
  const regs = buildM160({
    sfs: { dca: 0, dcv: 0, dcw: 0, dcwh: 0 },
    modules: [{ id: 1, dcw: 2000 }, { id: 2, dcw: 0xffff }]
  });
  const parsed = parseM160Modules(regs);
  const strings = m160PvStrings(parsed, []);
  assert.deepEqual(strings.map((s) => s.module), [1]);
});
