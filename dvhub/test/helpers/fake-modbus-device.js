// Schein-Modbus-Gerät für Lesepfad-Tests (Herstellerprofile, E3–E14): ein Registerbild je (Unit-ID, Funktionscode),
// ein Anfrage-Protokoll und Bausteine für 16/32-bit-Werte, Float32 und eine SunSpec-Modellkette. Kein Netzwerk.
//
// mbRequest verhält sich an den Grenzen wie transport-modbus.js: nur FC 1–4, Adresse und Menge müssen Zahlen sein
// (der echte Transport wirft sonst beim Rahmenbau), fehlende Register = „modbus exception 2" (illegale Adresse).

import os from 'node:os';
import path from 'node:path';

import { createPoller } from '../../polling.js';

export function createRegisterDevice({ defaultUnitId = 1 } = {}) {
  const regs = new Map();
  const requests = [];
  const key = (unitId, fc, address) => `${unitId}:${fc}:${address}`;
  const words16 = (v) => Number(v) & 0xffff;

  const dev = {
    type: 'modbus',
    requests,
    writes: [],
    set(address, value, { unitId = defaultUnitId, fc = 3 } = {}) {
      regs.set(key(unitId, fc, address), words16(value));
      return dev;
    },
    setWords(address, words, opts = {}) {
      words.forEach((w, i) => dev.set(address + i, w, opts));
      return dev;
    },
    // 32-bit-Ganzzahl: be = High-Wort zuerst (an `address`), le = Low-Wort zuerst.
    set32(address, value, { wordOrder = 'be', ...opts } = {}) {
      const raw = value < 0 ? value + 0x100000000 : value;
      const hi = Math.floor(raw / 0x10000) & 0xffff;
      const lo = raw & 0xffff;
      return dev.setWords(address, wordOrder === 'le' ? [lo, hi] : [hi, lo], opts);
    },
    setFloat32(address, value, { wordOrder = 'be', ...opts } = {}) {
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(value, 0);
      const hi = buf.readUInt16BE(0);
      const lo = buf.readUInt16BE(2);
      return dev.setWords(address, wordOrder === 'le' ? [lo, hi] : [hi, lo], opts);
    },
    // SunSpec-Kette ab `base`: "SunS", dann je Modell [id, länge, …daten], Ende 0xFFFF. Gibt die Datenadressen zurück.
    setSunspecChain(base, models, opts = {}) {
      dev.setWords(base, [0x5375, 0x6e53], opts);
      let cursor = base + 2;
      const at = {};
      for (const { id, length, data = [] } of models) {
        dev.setWords(cursor, [id, length], opts);
        const words = Array.from({ length }, (_, i) => data[i] ?? 0);
        dev.setWords(cursor + 2, words, opts);
        (at[id] ??= []).push(cursor + 2);
        cursor += 2 + length;
      }
      dev.setWords(cursor, [0xffff, 0], opts);
      return at;
    },
    async mbRequest(conf) {
      const fc = Number(conf.fc);
      if (![1, 2, 3, 4].includes(fc)) throw new Error(`modbus read: fc ${conf.fc} ist keine Lese-Funktion`);
      if (typeof conf.address !== 'number' || typeof conf.quantity !== 'number') {
        throw new TypeError(`ungültige Anfrage (address=${conf.address}, quantity=${conf.quantity})`);
      }
      const unitId = conf.unitId ?? defaultUnitId;
      requests.push({ unitId, fc, address: conf.address, quantity: conf.quantity, port: conf.port, host: conf.host, timeoutMs: conf.timeoutMs });
      const out = [];
      for (let i = 0; i < conf.quantity; i += 1) {
        const v = regs.get(key(unitId, fc, conf.address + i));
        if (v === undefined) throw new Error('modbus exception 2');
        out.push(v);
      }
      return out;
    },
    async mbWriteSingle(w) { dev.writes.push({ fc: 6, ...w }); },
    async mbWriteMultiple(w) { dev.writes.push({ fc: 16, ...w }); },
  };
  return dev;
}

// Poller mit minimalem Zustand gegen ein Schein-Gerät. cfg wird ergänzt, nicht ersetzt (Tests prüfen danach cfg).
export function createPollerRig(cfg, transport, { logs = [] } = {}) {
  cfg.pollMs ??= 500;
  cfg.epex ??= { timezone: 'UTC' };
  cfg.userEnergyPricing ??= {};
  cfg.points ??= {};
  cfg.gridPositiveMeans ??= 'grid_import';
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-18', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
    ctrl: {},
  };
  const poller = createPoller({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: (event, data, level) => logs.push({ event, data, level }),
    energyPath: path.join(os.tmpdir(), 'dvhub-fake-modbus-device-test.json'),
    onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
    gridVoltagePoller: { onPoll: () => {} },
  });
  return { state, poller, logs };
}
