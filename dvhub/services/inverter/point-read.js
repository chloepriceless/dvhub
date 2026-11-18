// Lesepfad der Herstellerprofile: ein Lesepunkt (oder der Netzzähler als Punkt) aus Modbus-Registern.
//
// Ein Decoder für die Lesepunkte: Datentyp, Wortreihenfolge, Skala, Sentinels — und die Lese-Erweiterungen für die
// neuen Hersteller (Lese-Engine, 18.11.2026):
//   E14 wordOrder dieselben Schreibweisen wie der Schreibpfad (swap/swapped = Low-Wort zuerst)
// Nur Lesen: das Modul dekodiert Register und schreibt nie.
//
// decodePointRegs ist bitgenau die frühere polling.js pointFromRegs (Golden-Netz der ausgelieferten Profile); die
// neuen Schreibweisen greifen nur, wenn ein Profil sie setzt.

import { s16 } from '../../server-utils.js';
import { decodeSunspecFloat32 } from './sunspec.js';

// E14: Schreibpfad (schedule-eval normWordOrder) kennt le/little/swapped/swap als „Low-Wort zuerst“. Der Lesepfad
// nahm bisher alles, was mit „l“ beginnt — das bleibt (kein Bestandsprofil kippt um), swap/swapped kommen dazu.
export function isLowWordFirst(wordOrder) {
  const w = String(wordOrder || 'be').toLowerCase();
  return w.startsWith('l') || w === 'swap' || w === 'swapped';
}

const readTypeOf = (conf) => String(conf?.readType || '').toLowerCase();

/**
 * Rohregister → Engineering-Wert (null = kein Wert).
 * @param {number[]} regs
 * @param {object} conf - Punkt-Config (readType, wordOrder, signed, scale, offset, sumRegisters, Sentinels)
 * @returns {number|null}
 */
export function decodePointRegs(regs, conf) {
  if (!regs || !regs.length) return null;
  const scale = Number(conf.scale ?? 1);
  const offset = Number(conf.offset ?? 0);
  const readType = readTypeOf(conf);
  // SunSpec Float-Modus (B-1112 Fronius/SolarEdge/Kostal): zwei Register = IEEE-754-Float32. Der Codec liefert null
  // für das SunSpec-NaN-Sentinel ("not implemented") und ±Inf — null hält die T-0075-Unknown-Semantik aufrecht.
  if (readType === 'float32') {
    const value = decodeSunspecFloat32(regs, isLowWordFirst(conf.wordOrder) ? 'le' : 'be');
    if (value === null) return null;
    return Number((value * scale + offset).toFixed(3));
  }
  // notAvailableRaw (Sungrow, T-0422): Rohwerte, mit denen das Gerät „Register nicht vorhanden/kein Wert“ meldet
  // (U16 0xFFFF, S32 0x7FFFFFFF …) — vorzeichenlos gegen das rohe Wort bzw. Doppelwort verglichen, VOR Vorzeichen
  // und Skala. Ergebnis null (unbelegt) statt einer erfundenen Zahl.
  const notAvailable = Array.isArray(conf.notAvailableRaw) ? conf.notAvailableRaw.map(Number) : [];
  // T-0107: 32-bit-Wert über zwei Register. be (Standard) = High-Wort zuerst (regs[0]); le = Low-Wort zuerst.
  // `* 0x10000` (nicht <<16) vermeidet den 32-bit-Vorzeichenüberlauf von JS.
  if (regs.length >= 2 && (readType === 'int32' || readType === 'uint32')) {
    const le = isLowWordFirst(conf.wordOrder);
    const hi = le ? regs[1] : regs[0];
    const lo = le ? regs[0] : regs[1];
    let raw = ((hi & 0xffff) * 0x10000) + (lo & 0xffff);
    if (notAvailable.includes(raw)) return null;
    if (readType === 'int32' && raw > 0x7fffffff) raw -= 0x100000000;
    const v = raw * scale + offset;
    return Number(v.toFixed(3));
  }
  if (notAvailable.length && regs.some((r) => notAvailable.includes(Number(r) & 0xffff))) return null;
  if (conf.quantity > 1 && conf.sumRegisters) {
    let sum = 0;
    for (const r of regs) sum += conf.signed ? s16(r) : r;
    const v = sum * scale + offset;
    return Number(v.toFixed(3));
  }
  let v = regs[0];
  if (conf.signed) v = s16(v);
  // rawSentinels (2026-07-12, reg-2704-Scale-Fix): Sentinel-Rohwerte sind MODES (Victron 2704: -1 = unbegrenzt,
  // 0 = gesperrt) und werden NICHT skaliert — sonst würde -1 mit scale 10 als „-10 W“ angezeigt.
  const rawSentinels = Array.isArray(conf.rawSentinels) ? conf.rawSentinels.map(Number) : [];
  if (rawSentinels.includes(Number(v))) return Number(v);
  // rawSentinelMap: Rohwert, der für einen Mode-Wert steht (2704: 32767 = -1).
  if (conf.rawSentinelMap && typeof conf.rawSentinelMap === 'object') {
    const hit = Object.entries(conf.rawSentinelMap).find(([, raw]) => Number(raw) === Number(v));
    if (hit) return Number(hit[0]);
  }
  v = Number(v) * scale + offset;
  return Number(v.toFixed(3));
}
