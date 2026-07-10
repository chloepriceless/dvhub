// SunSpec-Grundbausteine für die v1.1-Multi-Vendor-Treiber (B-1101/B-1112).
// Dialekt-neutral: Fronius (GEN24, Float-Modus), SolarEdge und Kostal sprechen
// alle SunSpec — die Register-BASISADRESSEN unterscheiden sich aber je Gerät
// und je Registerlayout (float vs. int+SF verschiebt bei Fronius ALLE Adressen
// um ±10). Deshalb ist der dynamische Modellketten-Scan hier die einzige
// erlaubte Adressquelle für SunSpec-Treiber — Modelladressen werden NIE
// hartkodiert (Backlog B-1112 §1, evcc macht es genauso).
//
// Kein I/O in diesem Modul: der Scan bekommt eine readRegisters-Funktion
// injiziert (Transport-agnostisch), Float32-Codecs sind pure. Factory-/
// Fehler-Konventionen der Codebase: Module werfen nur in klar deklarierten
// Vertragsverletzungen (Scan ohne SunS-Marker), Codecs liefern null statt NaN.

/**
 * Dekodiert zwei uint16-Register als IEEE-754-Float32 (SunSpec Float-Modus).
 * SunSpec signalisiert "not implemented" als NaN (0x7FC00000) — das und jeder
 * nicht-endliche Wert (±Inf) wird als null gemeldet, damit stromabwärts die
 * T-0075-Frische-/Unknown-Semantik greift statt eines giftigen NaN im State.
 *
 * @param {number[]} regs - mindestens zwei uint16-Registerworte
 * @param {string} [wordOrder='be'] - 'be' (SunSpec-Standard) oder 'le'
 * @returns {number|null}
 */
export function decodeSunspecFloat32(regs, wordOrder = 'be') {
  if (!Array.isArray(regs) || regs.length < 2) return null;
  const le = String(wordOrder || 'be').toLowerCase().startsWith('l');
  const hi = le ? regs[1] : regs[0];
  const lo = le ? regs[0] : regs[1];
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt16BE(hi & 0xffff, 0);
  buf.writeUInt16BE(lo & 0xffff, 2);
  const value = buf.readFloatBE(0);
  return Number.isFinite(value) ? value : null;
}

/**
 * Kodiert einen endlichen Zahlenwert als zwei uint16-Register (IEEE-754
 * Float32, SunSpec Float-Modus). Gegenstück zu decodeSunspecFloat32.
 *
 * @param {number} value
 * @param {string} [wordOrder='be']
 * @returns {[number, number]}
 */
export function encodeSunspecFloat32(value, wordOrder = 'be') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error('invalid float32 write value');
  const buf = Buffer.allocUnsafe(4);
  buf.writeFloatBE(numeric, 0);
  const words = [buf.readUInt16BE(0), buf.readUInt16BE(2)];
  if (String(wordOrder || 'be').toLowerCase().startsWith('l')) words.reverse();
  return words;
}

// "SunS"-Marker (0x53756E53) — steht an der Basisadresse jeder SunSpec-Map.
const SUNS_MARKER = [0x5375, 0x6e53];
// Zulässige Basisadressen laut SunSpec-Spezifikation, in Prüf-Reihenfolge.
// 40000 ist die in der Praxis dominante Basis (Fronius, SolarEdge, Kostal).
export const SUNSPEC_BASE_ADDRESSES = [40000, 50000, 0];
// Kettenende-Sentinel: Modell-ID 0xFFFF.
const END_MODEL_ID = 0xffff;

/**
 * Löst SunSpec-deklarierte Punkte gegen ein Scan-Ergebnis auf. Ein Vendor-
 * Profil (z. B. das künftige hersteller/fronius.json) deklariert Punkte OHNE
 * feste Adresse, dafür mit `sunspec: { model, offset, instance? }` — die
 * effektive Registeradresse entsteht erst hier aus der am Gerät gescannten
 * Modellkette. Punkte, deren Modell das Gerät nicht anbietet, werden
 * deaktiviert (enabled:false) und unter `missing` gemeldet, statt mit einer
 * Müll-Adresse zu lesen/schreiben.
 *
 * @param {Record<string, object>} pointsConf - Punkt-Configs (points/controlWrite-Form)
 * @param {{ byId: Map<number, Array<{address:number}>> }} scanResult - aus scanSunspecModels()
 * @returns {{ resolved: Record<string, object>, missing: Array<{name:string, model:number}> }}
 */
export function resolveSunspecAddresses(pointsConf, scanResult) {
  const resolved = {};
  const missing = [];
  for (const [name, conf] of Object.entries(pointsConf || {})) {
    if (!conf || typeof conf !== 'object' || !conf.sunspec || typeof conf.sunspec !== 'object') {
      resolved[name] = conf;
      continue;
    }
    const { model, offset, instance } = conf.sunspec;
    const entries = scanResult?.byId?.get(Number(model));
    const entry = entries?.[Number(instance) || 0];
    if (!entry || !Number.isFinite(Number(offset))) {
      missing.push({ name, model: Number(model) });
      resolved[name] = { ...conf, enabled: false, address: null };
      continue;
    }
    resolved[name] = { ...conf, address: entry.address + Number(offset) };
  }
  return { resolved, missing };
}

/**
 * Scannt die SunSpec-Modellkette eines Geräts und liefert die tatsächlichen
 * Registeradressen jedes Modells. Einzige zulässige Adressquelle für
 * SunSpec-Treiber (siehe Kopfkommentar).
 *
 * Kettenformat ab base+2: je Modell ein Header [modelId, length], gefolgt von
 * `length` Datenregistern; Ende bei modelId 0xFFFF.
 *
 * @param {(address: number, quantity: number) => Promise<number[]>} readRegisters
 *   Transport-Injektion: liest `quantity` Holding-Register ab `address`.
 * @param {object} [opts]
 * @param {number[]} [opts.baseAddresses] - zu probierende Basisadressen
 * @param {number} [opts.maxModels=32] - Kettenlimit gegen Endlos-/Müll-Ketten
 * @returns {Promise<{ base: number, models: Array<{id:number,length:number,address:number,headerAddress:number}>, byId: Map<number, Array<object>> }>}
 * @throws wenn an keiner Basisadresse der SunS-Marker gefunden wird oder die
 *   Kette strukturell ungültig ist (Schutz vor Steuern nach Adress-Müll).
 */
export async function scanSunspecModels(readRegisters, opts = {}) {
  const bases = Array.isArray(opts.baseAddresses) && opts.baseAddresses.length
    ? opts.baseAddresses
    : SUNSPEC_BASE_ADDRESSES;
  const maxModels = Number(opts.maxModels) > 0 ? Number(opts.maxModels) : 32;

  let base = null;
  for (const candidate of bases) {
    try {
      const marker = await readRegisters(candidate, 2);
      if (Array.isArray(marker)
        && (marker[0] & 0xffff) === SUNS_MARKER[0]
        && (marker[1] & 0xffff) === SUNS_MARKER[1]) {
        base = candidate;
        break;
      }
    } catch { /* Basis nicht lesbar → nächste Kandidatin */ }
  }
  if (base === null) {
    throw new Error(`SunSpec marker "SunS" not found at base addresses ${bases.join('/')}`);
  }

  const models = [];
  const byId = new Map();
  let cursor = base + 2;
  for (let i = 0; i < maxModels; i += 1) {
    const header = await readRegisters(cursor, 2);
    if (!Array.isArray(header) || header.length < 2) {
      throw new Error(`SunSpec model chain truncated at address ${cursor}`);
    }
    const id = header[0] & 0xffff;
    if (id === END_MODEL_ID) {
      return { base, models, byId };
    }
    const length = header[1] & 0xffff;
    // length 0 wäre eine Endlosschleife (cursor bewegt sich um nur 2) — bei
    // einem Common-Model-Header (id!=0xFFFF) ist das strukturell ungültig.
    if (length === 0) {
      throw new Error(`SunSpec model ${id} reports zero length at address ${cursor}`);
    }
    const entry = { id, length, headerAddress: cursor, address: cursor + 2 };
    models.push(entry);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(entry);
    cursor += 2 + length;
  }
  throw new Error(`SunSpec model chain exceeds ${maxModels} models — aborting scan`);
}
