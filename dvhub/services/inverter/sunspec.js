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

// ── SunSpec Model 160 (Multiple MPPT Inverter Extension) ───────────────────
// Per-MPPT/String-Telemetrie (T-MPPT-TELEMETRY). Ein GEN24/Kostal/SolarEdge/SMA
// legt die DC-Eingänge (PV-Strings UND — bei Fronius-Hybrid — die Akku-Kanäle)
// als Model-160-Module ab. Layout spec-verifiziert (SunSpec Information Model
// 160, Fixblock + 20-Register-Wiederholblock, evcc/gosunspec identisch):
//
//   Datenbereich (ab model.address = headerAddress+2):
//     +0 DCA_SF  +1 DCV_SF  +2 DCW_SF  +3 DCWH_SF   (int16-Skalenfaktoren)
//     +4..+5 Evt (bitfield32)   +6 N (Modulzahl)    +7 TmsPer
//   Modul m (1-basiert), Basis = 8 + (m-1)*20, Relativ-Offsets:
//     +0 ID   +1..+8 IDStr(16)   +9 DCA   +10 DCV   +11 DCW
//     +12..+13 DCWH(acc32)   +14..+15 Tms   +16 Tmp   +17 DCSt   +18..+19 DCEvt
//
// WICHTIG (Offset-Korrektur 2026-11-15): Ein früherer Inline-Parser in
// polling.js las DCW am Modul-Relativ-Offset +3 — das liegt MITTEN im 16-Zeichen-
// IDStr und lieferte Müll. Der spec-korrekte DCW-Offset ist +11. Diese Funktion
// ist ab jetzt die EINZIGE M160-Modulquelle (Akku-Derive UND MPPT-Logging), am
// Gerät noch zu verifizieren (keine Live-M160-Auslesung verfügbar).
const M160_SF_DCA = 0;
const M160_SF_DCV = 1;
const M160_SF_DCW = 2;
const M160_SF_DCWH = 3;
const M160_N_OFFSET = 6;
const M160_MODULE_BASE = 8;
const M160_MODULE_STRIDE = 20;
// Modul-interne Relativ-Offsets (siehe Layout oben).
const M160_MOD_ID = 0;
const M160_MOD_DCA = 9;
const M160_MOD_DCV = 10;
const M160_MOD_DCW = 11;
const M160_MOD_DCWH = 12; // acc32 → +12/+13
const M160_NOT_IMPL_I16 = -32768; // 0x8000
const M160_NOT_IMPL_U16 = 0xffff;

function m160Int16(w) {
  const n = Number(w) & 0xffff;
  return n > 0x7fff ? n - 0x10000 : n;
}
function m160Uint16(w) {
  return Number(w) & 0xffff;
}
function m160Acc32(hi, lo) {
  return ((m160Uint16(hi) * 0x10000) + m160Uint16(lo)) >>> 0;
}
// Skalenfaktor anwenden: rawValue × 10^sf. sf===null (not-implemented) → null,
// damit ein unbekannter Faktor nie einen falsch skalierten Wert erzeugt.
function m160Scale(raw, sf) {
  if (raw === null || sf === null) return null;
  return raw * (10 ** sf);
}

/**
 * Dekodiert einen SunSpec-Model-160-Datenblock in seine DC-Module.
 *
 * Reine Funktion (kein I/O): `regs` ist der bereits gelesene Datenbereich ab
 * model.address (NICHT inkl. des 2-Register-Headers). Fehlt Register-Material
 * für ein Modul, wird es ausgelassen statt mit Müll gefüllt. `not-implemented`-
 * Sentinels (int16 0x8000, uint16 0xFFFF) und ein unbekannter Skalenfaktor
 * ergeben `null` für das betroffene Feld — nie einen falschen Zahlenwert.
 *
 * @param {number[]} regs - Model-160-Datenregister ab model.address
 * @param {object} [opts]
 * @param {number} [opts.maxModules=16] - Obergrenze gegen Müll-N
 * @returns {{ n:number, dcwSf:(number|null), modules: Array<{
 *   module:number, id:(number|null), dcw:(number|null), dcv:(number|null),
 *   dca:(number|null), dcwh:(number|null) }> }}
 */
export function parseM160Modules(regs, opts = {}) {
  const out = { n: 0, dcwSf: null, modules: [] };
  if (!Array.isArray(regs) || regs.length < M160_MODULE_BASE) return out;
  const maxModules = Number(opts.maxModules) > 0 ? Number(opts.maxModules) : 16;

  const sfOrNull = (idx) => {
    const raw = m160Int16(regs[idx]);
    return raw === M160_NOT_IMPL_I16 ? null : raw;
  };
  const dcaSf = sfOrNull(M160_SF_DCA);
  const dcvSf = sfOrNull(M160_SF_DCV);
  const dcwSf = sfOrNull(M160_SF_DCW);
  const dcwhSf = sfOrNull(M160_SF_DCWH);
  out.dcwSf = dcwSf;

  const nRaw = m160Uint16(regs[M160_N_OFFSET]);
  const n = nRaw === M160_NOT_IMPL_U16 ? 0 : Math.min(nRaw, maxModules);
  out.n = n;

  const i16OrNull = (v) => {
    const r = m160Int16(v);
    return r === M160_NOT_IMPL_I16 ? null : r;
  };
  const u16OrNull = (v) => {
    const r = m160Uint16(v);
    return r === M160_NOT_IMPL_U16 ? null : r;
  };

  for (let m = 1; m <= n; m += 1) {
    const base = M160_MODULE_BASE + (m - 1) * M160_MODULE_STRIDE;
    // Mindestens bis DCW (+11) muss das gelesene Material reichen.
    if (regs.length < base + M160_MOD_DCW + 1) break;
    const hasWh = regs.length >= base + M160_MOD_DCWH + 2;
    out.modules.push({
      module: m,
      id: u16OrNull(regs[base + M160_MOD_ID]),
      dcw: m160Scale(i16OrNull(regs[base + M160_MOD_DCW]), dcwSf),
      dcv: m160Scale(u16OrNull(regs[base + M160_MOD_DCV]), dcvSf),
      dca: m160Scale(u16OrNull(regs[base + M160_MOD_DCA]), dcaSf),
      dcwh: hasWh ? m160Scale(m160Acc32(regs[base + M160_MOD_DCWH], regs[base + M160_MOD_DCWH + 1]), dcwhSf) : null
    });
  }
  return out;
}

/**
 * Leistung (DCW, W) eines einzelnen M160-Moduls — für den Akku-Derive, der
 * genau das Lade-/Entlade-Modul braucht. `null`, wenn das Modul fehlt oder
 * keinen gültigen Wert meldet.
 * @param {ReturnType<typeof parseM160Modules>} parsed
 * @param {number} moduleNumber - 1-basierte Modulnummer
 * @returns {number|null}
 */
export function m160ModuleDcw(parsed, moduleNumber) {
  const hit = parsed?.modules?.find((x) => x.module === Number(moduleNumber));
  return hit ? hit.dcw : null;
}

/**
 * Welche M160-Module sind PV-Strings (nicht die Akku-Kanäle)? GEN24: Module
 * 1/2 = PV, 3/4 = Akku laden/entladen. `exclude` nennt die Akku-Module; alles
 * andere mit gültigem DCW ist ein PV-String. Für das Per-MPPT-Logging.
 * @param {ReturnType<typeof parseM160Modules>} parsed
 * @param {number[]} [exclude=[]] - Modulnummern, die KEINE PV-Strings sind
 * @returns {Array<{ module:number, w:number, v:(number|null), a:(number|null), wh:(number|null) }>}
 */
export function m160PvStrings(parsed, exclude = []) {
  const skip = new Set((Array.isArray(exclude) ? exclude : []).map(Number));
  const out = [];
  for (const mod of parsed?.modules || []) {
    if (skip.has(mod.module)) continue;
    if (mod.dcw === null) continue; // kein gültiger Wert → keine Reihe (nie Müll)
    out.push({ module: mod.module, w: mod.dcw, v: mod.dcv, a: mod.dca, wh: mod.dcwh });
  }
  return out;
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
