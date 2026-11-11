// Gemeinsame Sungrow-Testbausteine (T-0422): ausgeliefertes Profil laden, synthetisches SH10RT-Registerbild
// in Draht-Adressen (Doku − 1) und ein Modbus-Abbild mit FC-3/4-Lesen und FC-6-Schreiben.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../../config-model.js';
import { wire } from '../../services/inverter/sungrow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHIPPED = path.join(__dirname, '..', '..', 'hersteller', 'sungrow.json');

export function loadSungrowConfig(persisted = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sungrow-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(SHIPPED, path.join(rootDir, 'hersteller', 'sungrow.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: 'sungrow', updateChannel: 'dev', victron: { host: '192.0.2.50' }, ...persisted
  }));
  const loaded = loadConfigFile(configPath);
  assert.equal(loaded.manufacturerProfileError, null);
  return loaded.effectiveConfig;
}

// S32/U32 little-endian Wortreihenfolge (Doku Beispiel 4.2): [low, high].
const le32 = (v) => { const u = v >>> 0; return [u & 0xffff, u >>> 16]; };
const strRegs = (text, n) => {
  const b = Buffer.alloc(n * 2);
  b.write(text, 'utf8');
  return Array.from({ length: n }, (_, i) => b.readUInt16BE(i * 2));
};

/** Synthetisches SH10RT-Registerbild in Draht-Adressen. */
export function sungrowImage(over = {}) {
  const input = new Map();
  const set = (doc, words) => words.forEach((w, i) => input.set(wire(doc) + i, w & 0xffff));
  // Infoblock Doku 13000–13045 zuerst (er überdeckt SoC/Last/Einspeisung, die unten gesetzt werden).
  const info = new Array(46).fill(0);
  info[0] = 0x0000; info[1] = 0b11001; info[2] = 123; info[17] = 45; info[24] = 985; info[25] = (0x10000 - 25);
  info[26] = 61; info[36] = 72; info[40] = 88; info[45] = 99;
  set(13000, info);
  set(4990, strRegs('A2231234567', 10));          // SN
  set(5000, [0x0e03, 100]);                       // Typcode SH10RT, Nennleistung 10,0 kW
  set(5628, [100]);                               // BDC-Nennleistung 10,0 kW
  set(13023, [573]);                              // SoC 57,3 %
  set(5214, le32(-1500));                         // Akku −1500 W (Sungrow: negativ = Laden)
  set(5017, le32(70000));                         // PV 70 000 W (> 65 535: prüft die Wortreihenfolge)
  set(13008, le32(850));                          // Hauslast 850 W
  set(5601, [...le32(-2300), ...le32(-800), ...le32(-700), ...le32(-800)]); // Zähler: 2,3 kW Einspeisung
  set(13010, le32(2300));                         // Einspeiseleistung +2300 W (positiv = Einspeisung)
  const holding = new Map([
    [wire(13050), 0], [wire(13051), 0xcc], [wire(13052), 0],     // Self-consumption, Stopp
    [wire(13074), 5000], [wire(13087), 0xaa], [wire(13088), 700] // Installateur: 5 kW, an, 70 %
  ]);
  for (const [k, v] of Object.entries(over.input || {})) input.set(Number(k), v);
  for (const [k, v] of Object.entries(over.holding || {})) holding.set(Number(k), v);
  for (const a of over.dropInput || []) input.delete(a);
  for (const a of over.dropHolding || []) holding.delete(a);
  return { input, holding };
}

export function mockSungrow(image, { failWriteAt = null, ignoreWriteAt = null } = {}) {
  return {
    type: 'modbus',
    reads: [],
    writes: [],
    async mbRequest(conf) {
      const fc = Number(conf.fc);
      const img = fc === 4 ? image.input : image.holding;
      this.reads.push({ fc, address: Number(conf.address), quantity: Number(conf.quantity) });
      const regs = [];
      for (let i = 0; i < Number(conf.quantity ?? 1); i += 1) {
        const a = Number(conf.address) + i;
        if (!img.has(a)) throw new Error('modbus exception 2');
        regs.push(img.get(a));
      }
      return regs;
    },
    async mbWriteSingle({ address, value }) {
      this.writes.push({ fc: 6, address, value });
      if (address === failWriteAt) throw new Error('modbus timeout');
      if (!image.holding.has(address)) throw new Error('modbus exception 2');
      if (address !== ignoreWriteAt) image.holding.set(address, value & 0xffff);
      return { addr: address, value };
    },
    async mbWriteMultiple({ address, values }) { this.writes.push({ fc: 16, address, values }); }
  };
}
