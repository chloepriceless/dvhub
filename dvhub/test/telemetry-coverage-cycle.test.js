// Fable-Prüfung R3, P2-1 (10.11.2026): Die Abdeckung eines Slots ist die Summe
// der resolutionSeconds der Live-Proben. Der Schreibpuffer rundete jeden Abstand
// einzeln auf ganze Sekunden — bei einem Abfragezyklus von 5,3 s zählten 900 s
// echte Abdeckung als ~845 s, der eigene Slot galt nie als vollständig und
// „eigene Werte zuerst“ wirkte still nicht (Energie ebenso ~6 % zu niedrig).
// Die gerundeten Abstände müssen in Summe der echten Zeit folgen.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTelemetryWriteBuffer } from '../runtime-performance.js';
import { buildMaterializedEnergySlotWrites } from '../telemetry-store-pg.js';
import { isCompleteLocalSlotRow, localCoverageFromMeta } from '../energy-source-rule.js';

const SLOT_MS = 900_000;

// Lückenlose Abfragen im Takt cycleMs über `hours` Stunden, wie server.js:
// jede abgeschlossene Abfrage → capture + flush (Puffer drosselt auf 5 s).
function simulate(cycleMs, { hours = 3, powerW = 1000 } = {}) {
  const start = Date.UTC(2026, 10, 10, 0, 0, 0) + 137; // nicht auf Slotgrenze
  let now = start;
  const rows = [];
  const buffer = createTelemetryWriteBuffer({
    flushIntervalMs: 5000,
    now: () => now,
    buildSamples: (snap) => [{
      seriesKey: 'grid_import_w', ts: snap.ts, value: powerW, unit: 'W',
      resolutionSeconds: snap.resolutionSeconds, scope: 'live', source: 'local_poll', quality: 'raw', meta: null
    }],
    writeSamples: (r) => rows.push(...r)
  });
  const end = start + hours * 3600_000;
  // Gleitkomma-frei: Zeit in ganzen ms, Zyklus darf Bruchteile haben (Rest mitführen).
  let tick = 0;
  while (now < end) {
    buffer.capture({ ts: new Date(now).toISOString(), resolutionSeconds: Math.max(1, Math.round(cycleMs / 1000)) });
    buffer.flush();
    tick += 1;
    now = start + Math.round(tick * cycleMs);
  }
  return { rows, start, end };
}

function interiorSlots(rows, start, end) {
  const writes = buildMaterializedEnergySlotWrites(rows);
  const firstFull = Math.ceil(start / SLOT_MS) * SLOT_MS + SLOT_MS; // erster Slot nach dem Anlauf
  const lastFull = Math.floor(end / SLOT_MS) * SLOT_MS - SLOT_MS;
  return writes
    .filter((w) => w.seriesKey === 'grid_import_w')
    .filter((w) => {
      const t = Date.parse(w.slotStartUtc);
      return t >= firstFull && t < lastFull;
    })
    .map((w) => ({ ...w, source_kind: w.sourceKind, meta_json: w.meta }));
}

for (const cycleMs of [2000, 2150, 5300, 5600, 6400, 10300, 10600, 30000]) {
  test(`P2-1: lückenloser Abfragezyklus ${cycleMs / 1000} s → jeder volle eigene Slot gilt als vollständig`, () => {
    const { rows, start, end } = simulate(cycleMs);
    const slots = interiorSlots(rows, start, end);
    // Gespeichert wird höchstens alle 5 s: tatsächlicher Probenabstand.
    const spacingS = (Math.ceil(5000 / cycleMs) * cycleMs) / 1000;
    assert.ok(slots.length >= 8, `genug Slots (${slots.length})`);
    for (const slot of slots) {
      const cov = localCoverageFromMeta(slot.meta_json);
      assert.ok(isCompleteLocalSlotRow(slot),
        `${slot.slotStartUtc}: Abdeckung ${cov.coverageS} s aus ${cov.samples} Proben muss vollständig sein`);
      // Keine Überzählung, die eine Lücke verdecken könnte (5,6 s → 6 s zählte bis ~935 s).
      assert.ok(cov.coverageS <= 900 + spacingS + 1,
        `${slot.slotStartUtc}: Abdeckung ${cov.coverageS} s nicht überzählt`);
      // Energie: 1000 W über eine Viertelstunde = 0,25 kWh, höchstens ein Probenabstand daneben.
      const tolKwh = (1000 * (spacingS + 1)) / 3_600_000 + 1e-9;
      assert.ok(Math.abs(slot.valueNum - 0.25) <= tolKwh,
        `${slot.slotStartUtc}: Energie ${slot.valueNum.toFixed(4)} kWh statt 0,25 kWh`);
    }
  });
}

test('P2-1: Summe der gestempelten Sekunden folgt der echten Zeit (kein Rundungsdrift)', () => {
  for (const cycleMs of [5300, 6400, 10300]) {
    const { rows, start, end } = simulate(cycleMs, { hours: 2 });
    const total = rows.slice(1).reduce((s, r) => s + r.resolutionSeconds, 0);
    const lastTs = Date.parse(rows.at(-1).ts);
    const firstTs = Date.parse(rows[0].ts);
    assert.ok(Math.abs(total - (lastTs - firstTs) / 1000) <= 1,
      `${cycleMs} ms: gestempelt ${total} s, echt ${(lastTs - firstTs) / 1000} s (Start ${start}, Ende ${end})`);
    for (const r of rows) assert.ok(Number.isInteger(r.resolutionSeconds) && r.resolutionSeconds >= 1, 'ganze Sekunden ≥ 1 (Spalte INTEGER)');
  }
});

test('P2-1: echte Lücke bleibt erkennbar — 120 s Ausfall im Slot macht ihn unvollständig', () => {
  const start = Date.UTC(2026, 10, 10, 0, 0, 0);
  let now = start;
  const rows = [];
  const buffer = createTelemetryWriteBuffer({
    flushIntervalMs: 5000,
    now: () => now,
    buildSamples: (snap) => [{ seriesKey: 'grid_import_w', ts: snap.ts, value: 1000, resolutionSeconds: snap.resolutionSeconds, scope: 'live', source: 'local_poll', meta: null }],
    writeSamples: (r) => rows.push(...r)
  });
  for (let t = 0; t < 3 * SLOT_MS; t += 5300) {
    now = start + t;
    // Ausfall von 120 s im zweiten Slot (über der Lückengrenze von 90 s).
    if (t > SLOT_MS + 300_000 && t < SLOT_MS + 420_000) continue;
    buffer.capture({ ts: new Date(now).toISOString(), resolutionSeconds: 5 });
    buffer.flush();
  }
  const writes = buildMaterializedEnergySlotWrites(rows)
    .map((w) => ({ ...w, source_kind: w.sourceKind, meta_json: w.meta }));
  const second = writes.find((w) => Date.parse(w.slotStartUtc) === start + SLOT_MS);
  assert.equal(isCompleteLocalSlotRow(second), false);
});
