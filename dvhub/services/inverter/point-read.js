// Lesepfad der Herstellerprofile: ein Lesepunkt (oder der Netzzähler als Punkt) aus Modbus-Registern.
//
// Ein Decoder für die Lesepunkte: Datentyp, Wortreihenfolge, Skala, Vorzeichen, Sentinels — und die
// Lese-Erweiterungen für die neuen Hersteller (Lese-Engine, 18.11.2026):
//   E4  combine   Summe/Differenz über beliebige Register, je eigener Typ/Skala/Vorzeichen (`sign`)
//   E5  sfAddress SunSpec-Skalenfaktor (sunssf) zur Laufzeit, im selben Takt gelesen
//   E8  direction Vorzeichen aus einem Richtungsregister (Betrag × ±1 je gemeldetem Rohwert, 19.11.2026)
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

// Jede Lesung dieses Moduls ist EIN Messzeitpunkt (ein Wert, Wert + Skalenfaktor, combineBlock): der Transport darf sie
// nicht nach maxRegistersPerRequest zerlegen (E7, Codex 742c52c9). Zweites Argument von read(); conf bleibt unberührt.
const ATOMIC = Object.freeze({ atomic: true });

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
// Verbindung, Unit-ID und Funktionscode wie der Wert.
// Konsistenz (Codex 2d7097cd): SF und Wert müssen zur selben Probe gehören — SolarEdge ändert W_SF je nach
// Leistungsbereich; (Rohwert 1000, SF 0) → (10000, SF −1) zwischen zwei Lesungen ergab 10000 W statt 1000 W.
//   • SF nah beim Wert (Spanne ≤ SF_BLOCK_SPAN Register, der übliche SunSpec-Aufbau): ein Block-Read für beide.
//   • sonst SF vorher, Wert, SF nachher: nur wenn der SF gleich bleibt, gehört das Paar zusammen; bis zu drei
//     Versuche, sonst Lesefehler. Der Takt-Cache (sfCache) liefert nur den „vorher“-Wert und hält den jüngsten SF.
const SF_BLOCK_SPAN = 8;
const SF_MAX_ATTEMPTS = 3;
const sfKeyOf = (conf) => `${conf.host ?? ''}|${conf.port ?? ''}|${conf.unitId ?? ''}|${conf.fc ?? ''}|${conf.sfAddress}`;

function decodeScaleFactor(word, address) {
  const sf = s16(word);
  if (sf === -32768) return null;
  if (sf < -10 || sf > 10) throw new Error(`Skalenfaktor @${address} = ${sf} liegt außerhalb −10…10`);
  return sf;
}

function assertSfAddress(conf) {
  if (!isAddress(conf.sfAddress)) throw new Error(`sfAddress ${conf.sfAddress} ist keine Registeradresse`);
}

function readScaleFactorFresh(conf, read, cache) {
  const address = conf.sfAddress;
  const pending = read({ ...conf, address, quantity: 1 }, ATOMIC).then((regs) => {
    if (!Array.isArray(regs) || regs.length < 1) throw new Error(`Skalenfaktor @${address}: keine Antwort`);
    return decodeScaleFactor(regs[0], address);
  });
  cache?.set(sfKeyOf(conf), pending);
  return pending;
}

function readScaleFactorBefore(conf, read, cache) {
  const key = sfKeyOf(conf);
  if (cache?.has(key)) return cache.get(key);
  return readScaleFactorFresh(conf, read, cache);
}

// SF vorher, Wert (readValue), SF nachher — Ergebnis { sf, value } nur bei unverändertem SF. sf null = unbekannt.
async function readWithStableScaleFactor(conf, read, cache, readValue) {
  let sf = await readScaleFactorBefore(conf, read, cache);
  for (let attempt = 0; attempt < SF_MAX_ATTEMPTS; attempt += 1) {
    if (sf === null) return { sf: null, value: null };
    const value = await readValue();
    const after = await readScaleFactorFresh(conf, read, cache);
    if (after === sf) return { sf, value };
    sf = after;
  }
  throw new Error(`Skalenfaktor @${conf.sfAddress} änderte sich bei jeder Lesung (${SF_MAX_ATTEMPTS} Versuche) — kein konsistenter Wert`);
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
    const regs = await read({ ...conf, address, quantity: 1 }, ATOMIC);
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

// E7 (18.11.2026): `combineBlock: true` liest alle combine-Einträge mit EINER Anfrage über ihre Spanne (ein Messzeitpunkt)
// statt je Eintrag einzeln. Nötig, wo Anfragen weit auseinander liegen müssen (SMA ≥ 10 s): Bezug − Einspeisung aus
// zwei Lesungen im Abstand von 10 s ergäbe bei einem Richtungswechsel einen erfundenen Wert. Alle Einträge teilen
// Verbindung und Funktionscode des Punkts; split und eigene Skalenfaktoren gibt es im Block nicht.
const COMBINE_BLOCK_CONNECTION = ['fc', 'host', 'port', 'unitId'];
const MAX_BLOCK_REGISTERS = 125;

async function readCombinedBlockTerms(conf, terms, read, ctx) {
  const termConfs = terms.map((term) => {
    if (term.split || term.sfAddress != null || term.sunspec != null || term.direction != null) {
      throw new Error('combineBlock: Einträge ohne split, sfAddress, sunspec und direction');
    }
    for (const k of COMBINE_BLOCK_CONNECTION) {
      if (term[k] !== undefined && term[k] !== conf[k]) throw new Error(`combineBlock: Eintrag mit eigenem ${k} — alle Einträge lesen über dieselbe Anfrage`);
    }
    return combineTermConf(conf, term);
  });
  const from = Math.min(...termConfs.map((t) => t.address));
  const to = Math.max(...termConfs.map((t) => t.address + quantityOf(t)));
  if (to - from > MAX_BLOCK_REGISTERS) throw new Error(`combineBlock: Spanne ${to - from} Register (höchstens ${MAX_BLOCK_REGISTERS})`);
  const blockConf = combineTermConf(conf, {});
  const regs = await read({ ...blockConf, address: from, quantity: to - from }, ATOMIC);
  if (!Array.isArray(regs) || regs.length < to - from) throw new Error(`combineBlock @${from}: unvollständige Antwort`);
  let sum = 0;
  for (const t of termConfs) {
    const v = decodePointRegs(regs.slice(t.address - from, t.address - from + quantityOf(t)), t, { exact: true });
    if (v == null) return null;
    sum += v;
  }
  return sum;
}

async function readCombined(conf, read, ctx) {
  const terms = conf.combine;
  if (!terms.length) throw new Error('combine braucht mindestens einen Eintrag');
  if (terms.length > MAX_COMBINE_TERMS) throw new Error(`combine: höchstens ${MAX_COMBINE_TERMS} Einträge`);
  for (const term of terms) {
    if (!term || typeof term !== 'object' || Array.isArray(term) || term.combine != null) {
      throw new Error('combine: Eintrag muss ein Register-Objekt sein (ohne verschachteltes combine)');
    }
    if (!term.split && !isAddress(term.address)) throw new Error(`combine: Registeradresse fehlt oder ist ungültig (${term.address})`);
  }
  const sumTerms = conf.combineBlock === true ? () => readCombinedBlockTerms(conf, terms, read, ctx) : async () => {
    let sum = 0;
    for (const term of terms) {
      const v = await readPointValue(combineTermConf(conf, term), read, { ...ctx, exact: true });
      // Ein Summand ohne Wert (Sentinel/NaN) macht die Summe unbekannt — nie mit einem stillen 0-W-Teil rechnen.
      if (v == null) return null;
      sum += v;
    }
    return sum;
  };
  let sf;
  let sum;
  if (conf.sfAddress != null) {
    assertSfAddress(conf);
    ({ sf, value: sum } = await readWithStableScaleFactor(conf, read, ctx.sfCache, sumTerms));
    if (sf === null) return null;
  } else {
    sum = await sumTerms();
  }
  if (sum == null) return null;
  return Number((sum * factorOf(conf, sf) + Number(conf.offset ?? 0)).toFixed(3));
}

// E8 (19.11.2026): Vorzeichen aus einem Richtungsregister, `direction: { address, values: { "<Rohwert>": 1 | -1 } }`.
// Anlass Solis (Akku 33149 „Vorzeichen mit 33135“, 0 = Laden / 1 = Entladen [SPEC]) und SolaX (0x16 mit BDCStatus
// 0x19, 0 = Entladen / 1 = Laden [SPEC]); ob das Leistungsregister selbst ein Vorzeichen trägt, ist in den Quellen
// strittig. Darum zählt nur der BETRAG des fertig dekodierten Werts (Skala, Skalenfaktor, Offset), das Vorzeichen
// kommt allein aus dem Richtungsregister — richtig für Betrag wie für vorzeichenbehafteten Wert. `sign` daneben wäre
// widersprüchlich und wird abgewiesen. Ein Rohwert, der nicht in `values` steht, macht den Punkt leer (Lesefehler mit
// Grund, kein gehaltener Altwert): nie raten. Das Richtungsregister ist ein U16 auf Verbindung und Funktionscode des
// Punkts.
// Ein Messzeitpunkt (wie E5): liegen Wert und Richtung höchstens DIRECTION_BLOCK_SPAN Register auseinander, kommen
// beide aus EINER atomaren Anfrage. Sonst — oder wenn das Gerät den Block abweist (Modbus-Ausnahme 1–3, lückenhafte
// Karte; der Bereich wird je Poller in derselben Merkliste wie E5 vermerkt) oder er über maxRegistersPerRequest der
// Verbindung liegt (E7) — Richtung vorher, Wert, Richtung nachher: nur bei gleicher Richtung gehört das Paar
// zusammen, bis zu drei Versuche, sonst Lesefehler. Andere Fehler des Blocks (Zeitüberschreitung) bleiben Lesefehler.
const DIRECTION_BLOCK_SPAN = 16;
const DIRECTION_MAX_ATTEMPTS = 3;
const CONNECTION_KEYS = ['fc', 'host', 'port', 'unitId', 'timeoutMs'];

function parseDirection(conf) {
  const d = conf.direction;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('direction muss ein Objekt { address, values } sein');
  if (!isAddress(d.address)) throw new Error(`direction.address ${d.address} ist keine Registeradresse`);
  const values = d.values;
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
    throw new Error('direction.values braucht mindestens einen Rohwert mit Faktor 1 oder -1');
  }
  const factors = new Map();
  for (const [raw, factor] of Object.entries(values)) {
    if (!/^\d+$/.test(raw) || Number(raw) > 0xffff) throw new Error(`direction.values: Rohwert „${raw}“ ist kein Registerwert 0…65535`);
    if (factor !== 1 && factor !== -1) throw new Error(`direction.values[${raw}] muss 1 oder -1 sein (ist ${JSON.stringify(factor)})`);
    factors.set(Number(raw), factor);
  }
  if (conf.sign != null) throw new Error('direction und sign schließen sich aus — das Vorzeichen kommt aus dem Richtungsregister');
  return { address: d.address, factors };
}

function applyDirection(value, raw, dir) {
  if (value == null) return null;
  const factor = dir.factors.get(raw);
  if (factor === undefined) {
    // valueUnknown: pollPoint leert den Punkt (statt den Altwert zu halten) und nennt den Grund.
    throw Object.assign(new Error(`Richtungsregister @${dir.address} meldet ${raw} — keine bekannte Richtung (bekannt: ${[...dir.factors.keys()].join(', ')}), Wert bleibt leer`), { valueUnknown: true });
  }
  return (Math.abs(value) * factor) || 0; // || 0: kein −0
}

// Block abgewiesen, aber einzeln lesbar: Modbus-Ausnahme 1–3 (Gerät kennt Register dazwischen nicht) oder die
// Verbindung erlaubt keine so große atomare Anfrage (E7 maxRegistersPerRequest).
const blockNotReadable = (e) => /^modbus exception [123]\b/.test(String(e?.message)) || e?.code === 'MODBUS_ATOMIC_OVER_CAP';

async function readWithDirection(conf, read, ctx) {
  const dir = parseDirection(conf);
  const inner = { ...conf };
  delete inner.direction;
  const plain = conf.combine == null && !conf.split && conf.sfAddress == null && isAddress(conf.address);
  if (plain) {
    const q = quantityOf(conf);
    const from = Math.min(conf.address, dir.address);
    const to = Math.max(conf.address + q, dir.address + 1);
    const blockKey = `${conf.host ?? ''}|${conf.port ?? ''}|${conf.unitId ?? ''}|${conf.fc ?? ''}|${from}|${to - from}`;
    if (to - from <= DIRECTION_BLOCK_SPAN && !ctx.sfBlockUnsupported?.has(blockKey)) {
      let block = null;
      try {
        block = await read({ ...inner, address: from, quantity: to - from }, ATOMIC);
      } catch (e) {
        if (!blockNotReadable(e)) throw e;
        ctx.sfBlockUnsupported?.add(blockKey);
      }
      if (block) {
        if (!Array.isArray(block) || block.length < to - from) throw new Error(`Wert/Richtung-Block @${from}: unvollständige Antwort`);
        const value = decodePointRegs(block.slice(conf.address - from, conf.address - from + q), inner, { exact: ctx.exact });
        return applyDirection(value, Number(block[dir.address - from]) & 0xffff, dir);
      }
    }
  }
  const connection = {};
  for (const k of CONNECTION_KEYS) if (conf[k] !== undefined) connection[k] = conf[k];
  const readDirection = async () => {
    const regs = await read({ ...connection, address: dir.address, quantity: 1 }, ATOMIC);
    if (!Array.isArray(regs) || regs.length < 1) throw new Error(`Richtung @${dir.address}: keine Antwort`);
    return Number(regs[0]) & 0xffff;
  };
  let before = await readDirection();
  for (let attempt = 0; attempt < DIRECTION_MAX_ATTEMPTS; attempt += 1) {
    const value = await readPointValue(inner, read, ctx);
    const after = await readDirection();
    if (after === before) return applyDirection(value, before, dir);
    before = after;
  }
  throw new Error(`Richtung @${dir.address} änderte sich bei jeder Lesung (${DIRECTION_MAX_ATTEMPTS} Versuche) — kein konsistenter Wert`);
}

/**
 * Liest einen Lesepunkt und dekodiert ihn. Ohne combine/split/sfAddress/direction genau ein read(conf) mit demselben
 * conf-Objekt wie bisher (bitgleich für die ausgelieferten Profile); nur ein fehlendes `quantity` wird ergänzt.
 * @param {object} conf - effektive Punkt-Config (host/port/unitId/fc schon aus applyVictronDefaults)
 * @param {(conf: object) => Promise<number[]>} read - transport.mbRequest
 * @param {{ exact?: boolean, sfCache?: Map, sfBlockUnsupported?: Set }} [ctx] - exact: ungerundet (combine-Summanden);
 *   sfCache: je Poll-Takt ein frischer Cache für Skalenfaktoren; sfBlockUnsupported: je Poller gemerkte Bereiche, in
 *   denen das Gerät keinen Wert+SF- bzw. Wert+Richtung-Block liefert (E5/E8)
 * @returns {Promise<number|null>}
 */
export async function readPointValue(conf, read, ctx = {}) {
  if (conf.direction != null) return readWithDirection(conf, read, ctx);
  if (Array.isArray(conf.combine)) return readCombined(conf, read, ctx);
  if (conf.combine != null) throw new Error('combine muss eine Liste sein');
  const decodeConf = conf.split ? { ...conf, wordOrder: 'be' } : conf;
  const readValue = () => (conf.split
    ? readSplitWords(conf, read)
    : read(conf.quantity == null ? { ...conf, quantity: quantityOf(conf) } : conf, ATOMIC));
  if (conf.sfAddress == null) return decodePointRegs(await readValue(), decodeConf, { exact: ctx.exact });
  assertSfAddress(conf);
  // SF nah beim Wert: ein Block für beide (eine Modbus-Antwort = eine Probe). Kennt das Gerät Register dazwischen
  // nicht (Modbus-Ausnahme 1–3, lückenhafte Karte, Codex 3ed66e9b), wird einzeln mit SF-Prüfung gelesen und der Block
  // für diesen Bereich nicht wieder versucht (ctx.sfBlockUnsupported, je Poller).
  const q = quantityOf(conf);
  if (!conf.split && isAddress(conf.address)) {
    const from = Math.min(conf.address, conf.sfAddress);
    const to = Math.max(conf.address + q, conf.sfAddress + 1);
    const blockKey = `${conf.host ?? ''}|${conf.port ?? ''}|${conf.unitId ?? ''}|${conf.fc ?? ''}|${from}|${to - from}`;
    if (to - from <= SF_BLOCK_SPAN && !ctx.sfBlockUnsupported?.has(blockKey)) {
      let block = null;
      try {
        block = await read({ ...conf, address: from, quantity: to - from }, ATOMIC);
      } catch (e) {
        if (!/^modbus exception [123]\b/.test(String(e?.message))) throw e;
        ctx.sfBlockUnsupported?.add(blockKey);
      }
      if (block) {
        if (!Array.isArray(block) || block.length < to - from) throw new Error(`Wert/Skalenfaktor-Block @${from}: unvollständige Antwort`);
        const sf = decodeScaleFactor(block[conf.sfAddress - from], conf.sfAddress);
        ctx.sfCache?.set(sfKeyOf(conf), Promise.resolve(sf));
        if (sf === null) return null;
        return decodePointRegs(block.slice(conf.address - from, conf.address - from + q), conf, { exact: ctx.exact, sf });
      }
    }
  }
  const { sf, value } = await readWithStableScaleFactor(conf, read, ctx.sfCache, readValue);
  if (sf === null) return null;
  return decodePointRegs(value, decodeConf, { exact: ctx.exact, sf });
}

// Wartet ein Eintrag (Punkt, Zähler, Phase) noch auf die SunSpec-Auflösung?
export function awaitsSunspec(conf) {
  return !!(conf && typeof conf === 'object' && conf.sunspec && conf.address == null);
}

// Registeradresse für die neuen Lesewege (Zähler-Layout "point", Phasen) prüfen — nie mit Müll-Adresse lesen.
export function assertReadableAddress(conf, label) {
  if (Array.isArray(conf?.combine) || conf?.split) return;
  if (!isAddress(conf?.address)) throw new Error(`${label}: Registeradresse fehlt oder ist ungültig (${conf?.address})`);
}
