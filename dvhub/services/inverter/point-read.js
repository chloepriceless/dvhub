// Lesepfad der Herstellerprofile: ein Lesepunkt (oder der Netzzähler als Punkt) aus Modbus-Registern.
//
// Ein Decoder für die Lesepunkte: Datentyp, Wortreihenfolge, Skala, Vorzeichen, Sentinels — und die
// Lese-Erweiterungen für die neuen Hersteller (Lese-Engine, 18.11.2026):
//   E4  combine   Summe/Differenz über beliebige Register, je eigener Typ/Skala/Vorzeichen (`sign`)
//   E5  sfAddress SunSpec-Skalenfaktor (sunssf) zur Laufzeit, im selben Takt gelesen
//   E9  split     32-bit-Wert aus zwei nicht benachbarten Registern (Low-/High-Wort)
//   E14 wordOrder dieselben Schreibweisen wie der Schreibpfad (swap/swapped = Low-Wort zuerst)
// Nur Lesen: das Modul bekommt eine read(conf)-Funktion (transport.mbRequest) und schreibt nie.
//
// decodePointRegs ist bitgenau die frühere polling.js pointFromRegs (Golden-Netz der ausgelieferten Profile); die
// neuen Schlüssel greifen nur, wenn ein Profil sie setzt.

import { s16 } from '../../server-utils.js';
import { decodeSunspecFloat32 } from './sunspec.js';

// E14: Schreibpfad (schedule-eval normWordOrder) kennt le/little/swapped/swap als „Low-Wort zuerst“. Der Lesepfad
// nahm bisher alles, was mit „l“ beginnt — das bleibt (kein Bestandsprofil kippt um), swap/swapped kommen dazu.
export function isLowWordFirst(wordOrder) {
  const w = String(wordOrder || 'be').toLowerCase();
  return w.startsWith('l') || w === 'swap' || w === 'swapped';
}

const WIDE_TYPES = new Set(['int32', 'uint32', 'float32']);
const readTypeOf = (conf) => String(conf?.readType || '').toLowerCase();

// Faktor aus scale × sign × 10^sf (`sign` < 0 dreht das Vorzeichen, sf = SunSpec-Skalenfaktor). Ohne sign/sf genau
// `scale` (bitgleich zum früheren Decoder).
function factorOf(conf, sf) {
  let k = Number(conf.scale ?? 1);
  if (conf.sign != null && Number(conf.sign) < 0) k = -k;
  if (sf != null) k *= 10 ** sf;
  return k;
}

// Ergebnis auf drei Nachkommastellen wie bisher. `exact` (Summanden von combine) rundet nicht: gerundet wird erst die
// Summe nach Skala, Vorzeichen und Offset des Punkts (Codex 9c17a409: 0,001234 + 0,002345 mit scale 1e6 ergab
// 3000 statt 3579).
const finish = (v, exact) => (exact ? v : Number(v.toFixed(3)));

/**
 * Rohregister → Engineering-Wert (null = kein Wert).
 * @param {number[]} regs
 * @param {object} conf - Punkt-Config (readType, wordOrder, signed, scale, sign, offset, sumRegisters, Sentinels)
 * @param {{ exact?: boolean, sf?: number }} [opts] - exact: ungerundet (nur für combine-Summanden); sf: zur Laufzeit
 *   gelesener SunSpec-Skalenfaktor
 * @returns {number|null}
 */
export function decodePointRegs(regs, conf, opts = {}) {
  if (!regs || !regs.length) return null;
  const exact = opts.exact === true;
  const scale = factorOf(conf, opts.sf);
  const offset = Number(conf.offset ?? 0);
  const readType = readTypeOf(conf);
  // SunSpec Float-Modus (B-1112 Fronius/SolarEdge/Kostal): zwei Register = IEEE-754-Float32. Der Codec liefert null
  // für das SunSpec-NaN-Sentinel ("not implemented") und ±Inf — null hält die T-0075-Unknown-Semantik aufrecht.
  if (readType === 'float32') {
    const value = decodeSunspecFloat32(regs, isLowWordFirst(conf.wordOrder) ? 'le' : 'be');
    if (value === null) return null;
    return finish(value * scale + offset, exact);
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
    return finish(v, exact);
  }
  if (notAvailable.length && regs.some((r) => notAvailable.includes(Number(r) & 0xffff))) return null;
  if (conf.quantity > 1 && conf.sumRegisters) {
    let sum = 0;
    for (const r of regs) sum += conf.signed ? s16(r) : r;
    const v = sum * scale + offset;
    return finish(v, exact);
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
  return finish(v, exact);
}

// Nur echte Zahlen: der Transport baut den Rahmen mit writeUInt16BE und wirft bei Text/undefined.
const isAddress = (a) => typeof a === 'number' && Number.isInteger(a) && a >= 0 && a <= 0xffff;

// Registerzahl eines Lesepunkts: ausdrücklich `quantity`, sonst 2 für 32-bit-Typen, sonst 1. (Ohne quantity warf der
// Transport bisher beim Rahmenbau; ein int32 ohne quantity hätte nur ein Wort gelesen.)
function quantityOf(conf) {
  const q = Number(conf.quantity);
  if (Number.isInteger(q) && q > 0) return q;
  return WIDE_TYPES.has(readTypeOf(conf)) ? 2 : 1;
}

// E5: SunSpec-Skalenfaktor (sunssf, int16, −10…10; 0x8000 = nicht implementiert → Wert unbekannt). Gleiche
// Verbindung, Unit-ID und Funktionscode wie der Wert. Je Takt höchstens einmal je Register gelesen (cache).
async function readScaleFactor(conf, read, cache) {
  if (!isAddress(conf.sfAddress)) throw new Error(`sfAddress ${conf.sfAddress} ist keine Registeradresse`);
  const address = conf.sfAddress;
  const key = `${conf.host ?? ''}|${conf.port ?? ''}|${conf.unitId ?? ''}|${conf.fc ?? ''}|${address}`;
  if (cache?.has(key)) return cache.get(key);
  const pending = read({ ...conf, address, quantity: 1 }).then((regs) => {
    if (!Array.isArray(regs) || regs.length < 1) throw new Error(`Skalenfaktor @${address}: keine Antwort`);
    const sf = s16(regs[0]);
    if (sf === -32768) return null;
    if (sf < -10 || sf > 10) throw new Error(`Skalenfaktor @${address} = ${sf} liegt außerhalb −10…10`);
    return sf;
  });
  cache?.set(key, pending);
  return pending;
}

// E9: 32-bit-Wert aus zwei getrennten Registern, `split: { low, high }` (je ein Wort, gleiche Verbindung/FC).
// Konsistenz (Codex 0f900d3c): zwischen zwei Einzel-Lesungen kann das Gerät den Wert erneuern — Low-Wort des alten
// und High-Wort des neuen Werts ergäben Unsinn (−1 W → 0 W als 65535 W). Darum High, Low, High: nur wenn das
// High-Wort um die Low-Lesung herum gleich bleibt, gehört das Paar zu einem Messwert. Bis zu drei Versuche, sonst
// Lesefehler statt eines erfundenen Werts.
const SPLIT_MAX_ATTEMPTS = 3;
async function readSplitWords(conf, read) {
  const { low, high } = conf.split || {};
  const rt = readTypeOf(conf);
  if (rt !== 'int32' && rt !== 'uint32') throw new Error(`split braucht readType int32 oder uint32 (ist ${conf.readType ?? 'leer'})`);
  if (!isAddress(low) || !isAddress(high)) throw new Error('split braucht die Registeradressen low und high');
  const word = async (address) => {
    const regs = await read({ ...conf, address, quantity: 1 });
    if (!Array.isArray(regs) || !regs.length) throw new Error(`split: Register ${address} ohne Antwort`);
    return Number(regs[0]) & 0xffff;
  };
  let hi = await word(high);
  for (let attempt = 0; attempt < SPLIT_MAX_ATTEMPTS; attempt += 1) {
    const lo = await word(low);
    const hiAfter = await word(high);
    if (hiAfter === hi) return [hi, lo];
    hi = hiAfter;
  }
  throw new Error(`split: High-Wort ${high} änderte sich bei jeder Lesung (${SPLIT_MAX_ATTEMPTS} Versuche) — kein konsistenter Wert`);
}

// E4: Felder, die ein combine-Eintrag vom umgebenden Punkt erbt. Skala, Vorzeichen, Offset und Skalenfaktor des
// Punkts gelten für die SUMME und werden nicht vererbt; Adresse, Typ und Wortreihenfolge setzt jeder Eintrag selbst
// (Typ/Wortreihenfolge/Vorzeichenbehaftung/Sentinels fallen auf den Punkt zurück, wenn der Eintrag sie nicht nennt).
const COMBINE_INHERIT = ['fc', 'host', 'port', 'unitId', 'timeoutMs', 'readType', 'wordOrder', 'signed', 'notAvailableRaw'];
const MAX_COMBINE_TERMS = 16;

function combineTermConf(parent, term) {
  const out = {};
  for (const k of COMBINE_INHERIT) if (parent[k] !== undefined) out[k] = parent[k];
  Object.assign(out, term);
  delete out.combine;
  return out;
}

async function readCombined(conf, read, ctx) {
  const terms = conf.combine;
  if (!terms.length) throw new Error('combine braucht mindestens einen Eintrag');
  if (terms.length > MAX_COMBINE_TERMS) throw new Error(`combine: höchstens ${MAX_COMBINE_TERMS} Einträge`);
  let sum = 0;
  for (const term of terms) {
    if (!term || typeof term !== 'object' || Array.isArray(term) || term.combine != null) {
      throw new Error('combine: Eintrag muss ein Register-Objekt sein (ohne verschachteltes combine)');
    }
    if (!term.split && !isAddress(term.address)) throw new Error(`combine: Registeradresse fehlt oder ist ungültig (${term.address})`);
    const v = await readPointValue(combineTermConf(conf, term), read, { ...ctx, exact: true });
    // Ein Summand ohne Wert (Sentinel/NaN) macht die Summe unbekannt — nie mit einem stillen 0-W-Teil rechnen.
    if (v == null) return null;
    sum += v;
  }
  const sf = conf.sfAddress != null ? await readScaleFactor(conf, read, ctx.sfCache) : undefined;
  if (sf === null) return null;
  return Number((sum * factorOf(conf, sf) + Number(conf.offset ?? 0)).toFixed(3));
}

/**
 * Liest einen Lesepunkt und dekodiert ihn. Ohne combine/split/sfAddress genau ein read(conf) mit demselben
 * conf-Objekt wie bisher (bitgleich für die ausgelieferten Profile); nur ein fehlendes `quantity` wird ergänzt.
 * @param {object} conf - effektive Punkt-Config (host/port/unitId/fc schon aus applyVictronDefaults)
 * @param {(conf: object) => Promise<number[]>} read - transport.mbRequest
 * @param {{ exact?: boolean, sfCache?: Map }} [ctx] - exact: ungerundet (combine-Summanden); sfCache: je Poll-Takt ein
 *   frischer Cache für Skalenfaktoren
 * @returns {Promise<number|null>}
 */
export async function readPointValue(conf, read, ctx = {}) {
  if (Array.isArray(conf.combine)) return readCombined(conf, read, ctx);
  if (conf.combine != null) throw new Error('combine muss eine Liste sein');
  const sf = conf.sfAddress != null ? await readScaleFactor(conf, read, ctx.sfCache) : undefined;
  if (sf === null) return null;
  if (conf.split) {
    const regs = await readSplitWords(conf, read);
    return decodePointRegs(regs, { ...conf, wordOrder: 'be' }, { exact: ctx.exact, sf });
  }
  const regs = await read(conf.quantity == null ? { ...conf, quantity: quantityOf(conf) } : conf);
  return decodePointRegs(regs, conf, { exact: ctx.exact, sf });
}

// Wartet ein Eintrag (Punkt, Zähler, Phase) noch auf die SunSpec-Auflösung?
export function awaitsSunspec(conf) {
  return !!(conf && typeof conf === 'object' && conf.sunspec && conf.address == null);
}
