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
    [wire(13080), 20], [wire(13081), 0xffff],                     // External-EMS-Herzschlag 20 s; 2. Wort 0xFFFF (Feld #3, Menge-2-Lesung)
    [wire(13074), 5000], [wire(13087), 0xaa], [wire(13088), 700] // Installateur: 5 kW, an, 70 %
  ]);
  for (const [k, v] of Object.entries(over.input || {})) input.set(Number(k), v);
  for (const [k, v] of Object.entries(over.holding || {})) holding.set(Number(k), v);
  for (const a of over.dropInput || []) input.delete(a);
  for (const a of over.dropHolding || []) holding.delete(a);
  return { input, holding };
}

// Draht-Adresse des External-EMS-Herzschlags (Doku 13080). Feld #3 (am Gerät gemessen): mit Menge 1 gelesen
// liefert 13080 IMMER einen falschen Festwert (am SH10RT-20: 600), erst ab Menge 2 kommt der echte Countdown,
// das zweite Wort ist 0xFFFF (nicht belegtes Register). Das Abbild modelliert das, damit ein Menge-1-Lesen im
// Code auffällt (falscher Wert) und nur das Menge-2-Lesen den echten Wert sieht.
const HB_ADDR = wire(13080);

export function mockSungrow(image, { failWriteAt = null, ignoreWriteAt = null, applyThenFailAt = null, failReadOnce = null, onRead = null, hbQty1Bogus = 600, hbReadDelta = 0 } = {}) {
  let readFailed = false;
  return {
    type: 'modbus',
    reads: [],
    writes: [],
    async mbRequest(conf) {
      const fc = Number(conf.fc);
      const img = fc === 4 ? image.input : image.holding;
      const address = Number(conf.address);
      const quantity = Number(conf.quantity ?? 1);
      this.reads.push({ fc, address, quantity });
      if (onRead) onRead({ fc, address });
      if (failReadOnce === address && !readFailed) { readFailed = true; throw new Error('modbus timeout'); }
      // Feld #3: Herzschlag 13080 nur ab Menge 2 echt; Menge 1 = Festwert. Fehlt das Register, Exception 2
      // (Firmware zu alt) — wie jedes fehlende Register.
      if (fc === 3 && address === HB_ADDR) {
        if (quantity <= 1) return [hbQty1Bogus & 0xffff];
        if (!image.holding.has(HB_ADDR)) throw new Error('modbus exception 2');
        const shown = Math.max(0, (image.holding.get(HB_ADDR) & 0xffff) - hbReadDelta);
        const regs = [shown & 0xffff, 0xffff];
        return regs.slice(0, quantity);
      }
      const regs = [];
      for (let i = 0; i < quantity; i += 1) {
        const a = address + i;
        if (!img.has(a)) throw new Error('modbus exception 2');
        regs.push(img.get(a));
      }
      return regs;
    },
    async mbWriteSingle({ address, value }) {
      this.writes.push({ fc: 6, address, value });
      if (address === failWriteAt) throw new Error('modbus timeout');
      // Gerät übernimmt den Wert, die Bestätigung geht verloren (einmalig).
      if (address === applyThenFailAt && !this.ackLost) { this.ackLost = true; image.holding.set(address, value & 0xffff); throw new Error('modbus timeout'); }
      if (!image.holding.has(address)) throw new Error('modbus exception 2');
      if (address !== ignoreWriteAt) image.holding.set(address, value & 0xffff);
      return { addr: address, value };
    },
    async mbWriteMultiple({ address, values }) { this.writes.push({ fc: 16, address, values }); }
  };
}

/** Erkanntes Gerät wie von polling.js, gebunden an die Verbindung aus loadSungrowConfig. */
export const SUNGROW_ENDPOINT = '192.0.2.50:502:1';
export function sungrowDevice(over = {}) {
  return { vendor: 'sungrow', supported: true, bdcRatedW: 10000, endpointKey: SUNGROW_ENDPOINT, ...over };
}
