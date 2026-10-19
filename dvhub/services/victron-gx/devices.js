// services/victron-gx/devices.js — Geräte am Victron GX (2026-10-20).
//
// Seit Venus OS 3.80 koppelt der GX EEBUS-Wärmepumpen und -Wallboxen selbst
// (Einstellungen → Integrationen → EEBUS) und legt sie als eigene Dienste an —
// genauso wie Victrons eigene Wallbox (EV Charging Station) und gemessene
// AC-Lasten (Zähler in der Rolle „AC-Last“):
//   com.victronenergy.evcharger  Register 3800–3840
//   com.victronenergy.heatpump   Register 5500–5510
//   com.victronenergy.acload     Register 3900–3940
// (CCGX-Modbus-TCP-register-list; D-Bus-Pfade github.com/victronenergy/venus/wiki/dbus)
//
// Der Modbus-TCP-Server des GX vergibt die Unit-IDs dynamisch (seit Venus 2.60).
// DVhub sucht sie deshalb selbst: je Unit-ID ein Register je Dienstart. Ein
// unbekanntes Gerät beantwortet der GX sofort mit Ausnahme 10, die Suche ist
// also kurz. Alles NUR lesend (FC3); gesteuert wird allein die Victron-Wallbox,
// und das über den Wallbox-Adapter (services/wallbox/adapters.js).
//
// Quelle wie bei der Ortsnetz-Auslastung: Victron über Modbus (manufacturer
// victron, Transport modbus). Über MQTT gibt es diese Dienste hier nicht.

export const GX_SCAN_UNITS = Object.freeze(Array.from({ length: 247 }, (_, i) => i + 1));
export const GX_PROBES = Object.freeze([
  { kind: 'evcharger', address: 3800 },
  { kind: 'heatpump', address: 5500 },
  { kind: 'acload', address: 3900 }
]);
export const GX_DEVICES_REFRESH_MS = 15_000;
export const GX_DEVICES_RESCAN_MS = 6 * 60 * 60_000;
const FIRST_SCAN_DELAY_MS = 45_000;
const TIMEOUT_MS = 1500;

export const KIND_LABELS = Object.freeze({ evcharger: 'Wallbox', heatpump: 'Wärmepumpe', acload: 'AC-Last' });

// Register 3824 /Status (Victron EVCS)
const EVCS_STATUS = Object.freeze({
  0: 'nicht angesteckt', 1: 'angesteckt', 2: 'lädt', 3: 'geladen', 4: 'wartet auf Sonne',
  5: 'wartet auf RFID', 6: 'wartet auf Start', 7: 'Akku-Ladestand zu niedrig', 8: 'Fehler Erdungstest',
  9: 'Fehler Schweißkontakt', 10: 'Fehler CP-Eingang', 11: 'Fehlerstrom erkannt', 12: 'Unterspannung',
  13: 'Überspannung', 14: 'Übertemperatur', 20: 'Ladegrenze', 21: 'startet', 22: 'schaltet auf 3 Phasen',
  23: 'schaltet auf 1 Phase', 24: 'stoppt'
});
// Status mit angestecktem Auto (Fehler 8–14 → unbekannt).
const EVCS_CONNECTED = new Set([1, 2, 3, 4, 5, 6, 7, 20, 21, 22, 23, 24]);
const EVCS_CHARGING = new Set([2, 21, 22, 23]);
const EVCS_ERROR = new Set([8, 9, 10, 11, 12, 13, 14]);
// Register 5501 /State
const HEATPUMP_STATE = Object.freeze({ 0: 'aus', 1: 'Fehler', 2: 'startet', 3: 'heizt', 4: 'kühlt' });

const u16 = (v) => (v == null || v === 0xffff ? null : v);
const u32 = (hi, lo) => {
  if (hi == null || lo == null) return null;
  const v = hi * 0x10000 + lo;
  return v === 0xffffffff ? null : v;
};
const i32 = (hi, lo) => {
  const v = u32(hi, lo);
  if (v == null) return null;
  return v >= 0x80000000 ? v - 0x100000000 : v;
};
const i16 = (v) => (v == null || v === 0xffff ? null : (v >= 0x8000 ? v - 0x10000 : v));
const scaled = (v, div) => (v == null ? null : Math.round((v / div) * 100) / 100);
const sumOrNull = (xs) => (xs.some((x) => x != null) ? xs.reduce((a, x) => a + (x || 0), 0) : null);

function regsOf(r) { return Array.isArray(r) ? r : r?.values; }

async function read(mbRequest, base, address, quantity) {
  const regs = regsOf(await mbRequest({ ...base, fc: 3, address, quantity }));
  if (!Array.isArray(regs) || regs.length < quantity) throw new Error(`short read ${address}`);
  return regs;
}
async function tryRead(mbRequest, base, address, quantity) {
  try { return await read(mbRequest, base, address, quantity); } catch { return null; }
}

function baseOf({ host, port, unitId, timeoutMs }) {
  return { host, port: port || 502, unitId, timeoutMs: timeoutMs || TIMEOUT_MS };
}

/** Victron-Text (stringN, 2 Zeichen je Register) → String ohne Nullen. */
function regsToText(regs) {
  if (!regs) return null;
  const s = regs.map((w) => String.fromCharCode((w >> 8) & 0xff, w & 0xff)).join('').replace(/\0.*$/s, '').trim();
  return s || null;
}

/**
 * Sucht Wallbox, Wärmepumpe und AC-Lasten am GX.
 * @returns {Promise<Array<{kind:string,unitId:number}>>}
 */
export async function scanGxServices(mbRequest, { host, port, timeoutMs, units = GX_SCAN_UNITS } = {}) {
  const found = [];
  let silent = 0; // Antworten ohne Modbus-Ausnahme (Zeitüberschreitung, Verbindung weg)
  for (const unitId of units) {
    for (const p of GX_PROBES) {
      try {
        await read(mbRequest, baseOf({ host, port, unitId, timeoutMs }), p.address, 1);
        found.push({ kind: p.kind, unitId });
        silent = 0;
      } catch (e) {
        if (/exception/.test(String(e?.message))) { silent = 0; continue; }
        // Ein GX, der gar nicht antwortet, soll die Suche nicht 247 × 3 Mal
        // aussitzen — nach drei stummen Anfragen in Folge abbrechen.
        if (++silent >= 3) throw new Error(`gx_unreachable: ${e?.message || e}`, { cause: e });
      }
    }
  }
  return found;
}

/** Wallbox (com.victronenergy.evcharger). */
export async function readEvcharger(mbRequest, opts) {
  const base = baseOf(opts);
  // 3814–3829 am Stück: Maximalstrom … Sitzungsdauer.
  const b = await tryRead(mbRequest, base, 3814, 16);
  let status;
  let out;
  if (b) {
    status = u16(b[10]);
    out = {
      maxCurrentA: u16(b[0]),
      mode: u16(b[1]),
      sessionEnergyKwh: scaled(u32(b[2], b[3]), 100),
      phasesW: [u16(b[4]), u16(b[5]), u16(b[6])],
      powerW: u16(b[7]),
      currentA: u16(b[9]),
      setCurrentA: u16(b[11]),
      startStop: u16(b[12]),
      position: u16(b[13]),
      sessionTimeS: u32(b[14], b[15]),
      controllable: u16(b[1]) != null
    };
  } else {
    // Ohne Steuerregister (z. B. über EEBUS gekoppelt): Leistung + Status einzeln.
    const p = await read(mbRequest, base, 3821, 1);
    const s = await tryRead(mbRequest, base, 3824, 1);
    status = s ? u16(s[0]) : null;
    out = {
      maxCurrentA: null, mode: null, sessionEnergyKwh: null, phasesW: [null, null, null],
      powerW: u16(p[0]), currentA: null, setCurrentA: null, startStop: null, position: null,
      sessionTimeS: null, controllable: false
    };
  }
  const e = await tryRead(mbRequest, base, 3836, 2);
  return {
    ...out,
    status,
    statusText: status == null ? null : (EVCS_STATUS[status] || `Status ${status}`),
    connected: status == null || EVCS_ERROR.has(status) ? null : EVCS_CONNECTED.has(status),
    charging: status == null ? null : EVCS_CHARGING.has(status),
    error: EVCS_ERROR.has(status) ? (EVCS_STATUS[status] || 'Fehler') : null,
    energyKwh: e ? scaled(u32(e[0], e[1]), 100) : null
  };
}

/** Wärmepumpe (com.victronenergy.heatpump). */
export async function readHeatpump(mbRequest, opts) {
  const base = baseOf(opts);
  const b = await tryRead(mbRequest, base, 5500, 8);
  if (!b) {
    const p = await read(mbRequest, base, 5502, 2);
    return { state: null, stateText: null, powerW: u32(p[0], p[1]), energyKwh: null, temperatureC: null, targetTemperatureC: null };
  }
  const state = u16(b[1]);
  return {
    state,
    stateText: state == null ? null : (HEATPUMP_STATE[state] || `Zustand ${state}`),
    powerW: u32(b[2], b[3]),
    energyKwh: scaled(u32(b[4], b[5]), 100),
    temperatureC: scaled(i16(b[6]), 10),
    targetTemperatureC: scaled(i16(b[7]), 10)
  };
}

/** AC-Last (com.victronenergy.acload). */
export async function readAcload(mbRequest, opts) {
  const base = baseOf(opts);
  let phases;
  const p32 = await tryRead(mbRequest, base, 3924, 6);
  if (p32) phases = [i32(p32[0], p32[1]), i32(p32[2], p32[3]), i32(p32[4], p32[5])];
  else {
    const p16 = await read(mbRequest, base, 3900, 3);
    phases = p16.map(u16);
  }
  const e = await tryRead(mbRequest, base, 3916, 6);
  const energy = e ? [u32(e[0], e[1]), u32(e[2], e[3]), u32(e[4], e[5])] : null;
  return {
    phasesW: phases,
    powerW: sumOrNull(phases),
    energyKwh: energy ? scaled(sumOrNull(energy), 100) : null
  };
}

const READERS = { evcharger: readEvcharger, heatpump: readHeatpump, acload: readAcload };
// Name (CustomName, string[8]) je Dienstart.
const NAME_REG = { evcharger: 3840, heatpump: 5510, acload: 3940 };

/**
 * Der Dienst: sucht nach dem Start und alle 6 h (oder auf Knopfdruck), liest
 * die gefundenen Geräte alle 15 s.
 */
export function createVictronGxDevices(ctx, deps = {}) {
  const now = deps.now || (() => Date.now());
  const timers = deps.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const st = { scannedAt: null, scanning: false, scanError: null, devices: [] };
  let refreshTimer = null;
  let scanTimer = null;
  let firstTimer = null;
  let refreshing = false;

  function source() {
    const cfg = ctx.getCfg?.() || {};
    if (cfg.manufacturer && cfg.manufacturer !== 'victron') return null;
    const v = cfg.victron || {};
    const transport = deps.getTransport?.() || null;
    if (!v.host || !transport || transport.type === 'mqtt' || typeof transport.mbRequest !== 'function') return null;
    return { mbRequest: transport.mbRequest, host: v.host, port: v.port || 502, timeoutMs: v.timeoutMs };
  }

  async function scan() {
    const src = source();
    if (!src) return { skipped: 'source_unsupported' };
    if (st.scanning) return { skipped: 'busy' };
    st.scanning = true;
    try {
      const found = await scanGxServices(src.mbRequest, src);
      const prev = new Map(st.devices.map((d) => [`${d.kind}:${d.unitId}`, d]));
      const devices = [];
      for (const f of found) {
        const old = prev.get(`${f.kind}:${f.unitId}`);
        let name = old?.name ?? null;
        if (name == null) name = regsToText(await tryRead(src.mbRequest, baseOf({ ...src, unitId: f.unitId }), NAME_REG[f.kind], 8));
        devices.push({ ...(old || {}), kind: f.kind, unitId: f.unitId, label: KIND_LABELS[f.kind], name });
      }
      const before = st.devices.map((d) => `${d.kind}:${d.unitId}`).join(',');
      st.devices = devices;
      st.scannedAt = new Date(now()).toISOString();
      st.scanError = null;
      const after = devices.map((d) => `${d.kind}:${d.unitId}`).join(',');
      if (before !== after) ctx.pushLog?.('victron_gx_devices_found', { devices: after || 'keine' });
      return { ok: true, devices: devices.length };
    } catch (e) {
      st.scanError = e?.message || String(e);
      return { ok: false, error: st.scanError };
    } finally {
      st.scanning = false;
    }
  }

  async function refresh() {
    const src = source();
    if (!src || refreshing || !st.devices.length) return;
    refreshing = true;
    try {
      for (const d of st.devices) {
        try {
          const v = await READERS[d.kind](src.mbRequest, { ...src, unitId: d.unitId });
          Object.assign(d, v, { at: new Date(now()).toISOString(), error: v.error ?? null });
        } catch (e) {
          d.error = e?.message || String(e);
        }
      }
    } finally {
      refreshing = false;
    }
  }

  function status() {
    return {
      supported: Boolean(source()),
      scannedAt: st.scannedAt,
      scanning: st.scanning,
      scanError: st.scanError,
      devices: st.devices.map((d) => ({ ...d, phasesW: d.phasesW ? [...d.phasesW] : undefined }))
    };
  }

  /** Unit-ID des ersten Geräts dieser Art (für den Wallbox-Adapter). */
  function findUnit(kind) {
    return st.devices.find((d) => d.kind === kind)?.unitId ?? null;
  }

  function start() {
    firstTimer = timers.setTimeout(() => { scan().then(refresh).catch(() => {}); }, FIRST_SCAN_DELAY_MS);
    refreshTimer = timers.setInterval(() => { refresh().catch(() => {}); }, GX_DEVICES_REFRESH_MS);
    scanTimer = timers.setInterval(() => { scan().catch(() => {}); }, GX_DEVICES_RESCAN_MS);
  }
  function stop() {
    if (firstTimer) timers.clearTimeout(firstTimer);
    if (refreshTimer) timers.clearInterval(refreshTimer);
    if (scanTimer) timers.clearInterval(scanTimer);
    firstTimer = refreshTimer = scanTimer = null;
  }

  return { scan, refresh, status, findUnit, start, stop };
}
