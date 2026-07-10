// SunSpec-Fundament (B-1101/B-1112 Vorbereitung, dialekt-neutral): Float32-
// Codecs + dynamischer Modellketten-Scan. Der Scan ist die einzige zulässige
// Adressquelle künftiger SunSpec-Treiber (Fronius/SolarEdge/Kostal) — float-
// vs. int+SF-Layout verschiebt alle Adressen, hartkodierte Register sind ein
// Faktor-X-Steuerfehler am echten Gerät.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeSunspecFloat32,
  encodeSunspecFloat32,
  scanSunspecModels,
  resolveSunspecAddresses,
  SUNSPEC_BASE_ADDRESSES
} from '../services/inverter/sunspec.js';

// ── Float32-Codec ────────────────────────────────────────────────────────

test('float32 roundtrip: positive und negative Leistungswerte', () => {
  for (const v of [5000, -2500.5, 0, 0.01, 12345.678]) {
    const words = encodeSunspecFloat32(v);
    const back = decodeSunspecFloat32(words);
    assert.ok(Math.abs(back - v) < Math.max(1e-3, Math.abs(v) * 1e-6),
      `roundtrip ${v} → ${back}`);
  }
});

test('float32 roundtrip mit wordOrder le', () => {
  const words = encodeSunspecFloat32(-777.25, 'le');
  assert.equal(decodeSunspecFloat32(words, 'le'), -777.25);
  // le-Worte in be-Interpretation wären ein anderer Wert — Schutz vor
  // stillschweigend falscher Word-Order.
  assert.notEqual(decodeSunspecFloat32(words, 'be'), -777.25);
});

test('float32 decode: SunSpec-NaN-Sentinel (0x7FC0 0x0000) → null', () => {
  assert.equal(decodeSunspecFloat32([0x7fc0, 0x0000]), null);
});

test('float32 decode: ±Infinity → null, zu kurze Register → null', () => {
  assert.equal(decodeSunspecFloat32([0x7f80, 0x0000]), null); // +Inf
  assert.equal(decodeSunspecFloat32([0xff80, 0x0000]), null); // -Inf
  assert.equal(decodeSunspecFloat32([0x1234]), null);
  assert.equal(decodeSunspecFloat32(null), null);
});

test('float32 encode: nicht-endliche Werte werden abgelehnt', () => {
  assert.throws(() => encodeSunspecFloat32(NaN));
  assert.throws(() => encodeSunspecFloat32(Infinity));
  assert.throws(() => encodeSunspecFloat32('abc'));
});

// ── Modellketten-Scan ────────────────────────────────────────────────────

// Synthetisches Registerbild einer GEN24-artigen Kette @40000:
// "SunS", Model 1 (Common, len 66), Model 113 (Inverter float, len 60),
// Model 120 (len 26), Model 124 (Storage, len 24), Ende 0xFFFF.
function buildRegisterImage() {
  const image = new Map();
  const put = (addr, words) => words.forEach((w, i) => image.set(addr + i, w & 0xffff));
  put(40000, [0x5375, 0x6e53]);
  let cursor = 40002;
  for (const [id, len] of [[1, 66], [113, 60], [120, 26], [124, 24]]) {
    put(cursor, [id, len]);
    put(cursor + 2, new Array(len).fill(0));
    cursor += 2 + len;
  }
  put(cursor, [0xffff, 0]);
  return image;
}

function readerFor(image) {
  return async (address, quantity) => {
    const regs = [];
    for (let i = 0; i < quantity; i += 1) {
      if (!image.has(address + i)) throw new Error(`illegal read @${address + i}`);
      regs.push(image.get(address + i));
    }
    return regs;
  };
}

test('scanSunspecModels findet die Modellkette mit korrekten Datenadressen', async () => {
  const result = await scanSunspecModels(readerFor(buildRegisterImage()));
  assert.equal(result.base, 40000);
  assert.deepEqual(result.models.map((m) => m.id), [1, 113, 120, 124]);
  // Common Model 1: Header @40002, Daten ab 40004.
  assert.equal(result.byId.get(1)[0].address, 40004);
  // Model 113 folgt auf 1 (66 lang): Header @40070, Daten @40072.
  assert.equal(result.byId.get(113)[0].headerAddress, 40070);
  assert.equal(result.byId.get(113)[0].address, 40072);
  // Model 124 (Storage) — die Steueradressen, die B-1112 dynamisch braucht.
  const m124 = result.byId.get(124)[0];
  assert.equal(m124.headerAddress, 40160);
  assert.equal(m124.address, 40162);
  assert.equal(m124.length, 24);
});

test('scanSunspecModels probiert Basisadressen durch (Marker @0 statt 40000)', async () => {
  const image = new Map();
  const put = (addr, words) => words.forEach((w, i) => image.set(addr + i, w & 0xffff));
  put(0, [0x5375, 0x6e53]);
  put(2, [1, 4]);
  put(4, [0, 0, 0, 0]);
  put(8, [0xffff, 0]);
  const result = await scanSunspecModels(readerFor(image));
  assert.equal(result.base, 0);
  assert.equal(result.models.length, 1);
});

test('scanSunspecModels wirft ohne SunS-Marker (kein Steuern nach Adress-Müll)', async () => {
  const image = new Map();
  [40000, 40001, 50000, 50001, 0, 1].forEach((a) => image.set(a, 0x1234));
  await assert.rejects(
    () => scanSunspecModels(readerFor(image)),
    /marker "SunS" not found/
  );
});

test('scanSunspecModels wirft bei length-0-Modell (Endlosschleifen-Schutz)', async () => {
  const image = new Map();
  const put = (addr, words) => words.forEach((w, i) => image.set(addr + i, w & 0xffff));
  put(40000, [0x5375, 0x6e53]);
  put(40002, [113, 0]);
  await assert.rejects(() => scanSunspecModels(readerFor(image)), /zero length/);
});

test('scanSunspecModels bricht bei Ketten über maxModels ab', async () => {
  const image = new Map();
  const put = (addr, words) => words.forEach((w, i) => image.set(addr + i, w & 0xffff));
  put(40000, [0x5375, 0x6e53]);
  let cursor = 40002;
  for (let i = 0; i < 40; i += 1) { put(cursor, [10 + i, 1, 0]); cursor += 3; }
  await assert.rejects(
    () => scanSunspecModels(readerFor(image), { maxModels: 8 }),
    /exceeds 8 models/
  );
});

// ── Scan-basierte Punkt-Auflösung ────────────────────────────────────────

test('resolveSunspecAddresses löst sunspec-deklarierte Punkte gegen den Scan auf', async () => {
  const scan = await scanSunspecModels(readerFor(buildRegisterImage()));
  const { resolved, missing } = resolveSunspecAddresses({
    // Model 124 Daten @40162 (siehe Scan-Test): ChaState = Offset +6 → 40168.
    soc: { enabled: true, sunspec: { model: 124, offset: 6 }, scale: 0.01 },
    // Model 113 Daten @40072: W = Offset +2 → 40074.
    pvPowerW: { enabled: true, sunspec: { model: 113, offset: 2 }, readType: 'float32' },
    // Punkt ohne sunspec-Deklaration bleibt unangetastet (statische Adresse).
    legacyPoint: { enabled: true, address: 12345 }
  }, scan);
  assert.equal(missing.length, 0);
  assert.equal(resolved.soc.address, 40168);
  assert.equal(resolved.soc.scale, 0.01);
  assert.equal(resolved.pvPowerW.address, 40074);
  assert.equal(resolved.legacyPoint.address, 12345);
});

test('resolveSunspecAddresses deaktiviert Punkte fehlender Modelle statt Müll-Adressen', async () => {
  const scan = await scanSunspecModels(readerFor(buildRegisterImage()));
  const { resolved, missing } = resolveSunspecAddresses({
    // Model 203 (Smart Meter) ist im Inverter-Image nicht vorhanden.
    meterW: { enabled: true, sunspec: { model: 203, offset: 0 } }
  }, scan);
  assert.deepEqual(missing, [{ name: 'meterW', model: 203 }]);
  assert.equal(resolved.meterW.enabled, false);
  assert.equal(resolved.meterW.address, null);
});

test('SUNSPEC_BASE_ADDRESSES exportiert die Spez-Basen mit 40000 zuerst', () => {
  assert.equal(SUNSPEC_BASE_ADDRESSES[0], 40000);
  assert.ok(SUNSPEC_BASE_ADDRESSES.includes(0));
  assert.ok(SUNSPEC_BASE_ADDRESSES.includes(50000));
});
