// services/tariff-provider/xlsx-lite.js — schlanker XLSX-Leser (erstes Blatt
// als Zeilen), ohne neue Abhängigkeit: ZIP über das Zentralverzeichnis, deflate
// mit node:zlib (Grenze je Eintrag gegen ZIP-Bomben, CRC-Prüfung), dazu die
// paar XML-Teile einer Arbeitsmappe (workbook.xml, Beziehungen,
// sharedStrings.xml, ein Arbeitsblatt). Formeln, Formate und Datumsstile
// werden nicht ausgewertet — Zahlen kommen als Zahl, Datumswerte als
// Excel-Datumszahl (Auswertung: luox-data.js).
//
// Gebraucht für den Abrechnungsschein der LUOX-Direktvermarktung
// (epex_price/{P…}/{von}/{bis}/producer/, eine Tabelle im 15-min-Takt).

import zlib from 'node:zlib';
import { TariffProviderError } from './common.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const DEFAULT_MAX_ENTRY_BYTES = 32 * 1024 * 1024;

function fail(message) {
  return new TariffProviderError('format', `XLSX nicht lesbar: ${message}`);
}

/**
 * Alle Einträge eines ZIP-Archivs (Name → Inhalt).
 * @param {Buffer} buf
 * @param {{maxEntryBytes?:number}} [opts]
 * @returns {Map<string, Buffer>}
 */
export function readZipEntries(buf, { maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw fail('keine ZIP-Datei');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw fail('keine ZIP-Datei');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) throw fail('Zentralverzeichnis beschädigt');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (size > maxEntryBytes) throw fail(`Eintrag ${name} zu groß`);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw fail('Eintrag beschädigt');
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (raw.length !== compSize) throw fail('Eintrag abgeschnitten');
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
      } catch {
        throw fail(`Eintrag ${name} nicht entpackbar oder zu groß`);
      }
    } else throw fail(`Kompression ${method} nicht unterstützt`);
    if (data.length !== size) throw fail(`Eintrag ${name} hat die falsche Länge`);
    if (typeof zlib.crc32 === 'function' && (zlib.crc32(data) >>> 0) !== crc) throw fail(`Prüfsumme von ${name} falsch`);
    out.set(name, data);
  }
  return out;
}

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Text aller <t>-Knoten eines Elements (auch Rich-Text <r><t>…</t></r>). */
function textOf(xml) {
  let out = '';
  for (const m of String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += m[1] ? decodeXml(m[1]) : '';
  return out;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`));
  return m ? decodeXml(m[2]) : null;
}

function colIndex(ref) {
  const letters = String(ref || '').match(/^[A-Z]+/)?.[0];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function firstSheetPath(entries) {
  const wb = entries.get('xl/workbook.xml')?.toString('utf8') || '';
  const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const sheetTag = wb.match(/<sheet\b[^>]*>/)?.[0];
  const rid = sheetTag ? (attr(sheetTag, 'r:id') || attr(sheetTag, 'id')) : null;
  if (rid) {
    for (const rel of rels.match(/<Relationship\b[^>]*>/g) || []) {
      if (attr(rel, 'Id') !== rid) continue;
      const target = attr(rel, 'Target') || '';
      const resolved = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      if (entries.has(resolved)) return resolved;
    }
  }
  if (entries.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
  const any = [...entries.keys()].find((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k));
  if (!any) throw fail('kein Arbeitsblatt');
  return any;
}

/**
 * Erstes Arbeitsblatt als Zeilen (Array von Zellwerten; Lücken = null).
 * @param {Buffer} buf  XLSX-Datei
 * @returns {Array<Array<string|number|boolean|null>>}
 */
export function readXlsxRows(buf, opts = {}) {
  const entries = readZipEntries(buf, opts);
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const sheet = entries.get(firstSheetPath(entries)).toString('utf8');
  const rows = [];
  let nextRow = 0;
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rAttr = attr(`<row${rm[1] ?? rm[3] ?? ''}>`, 'r');
    const rowIdx = rAttr ? Number(rAttr) - 1 : nextRow;
    nextRow = rowIdx + 1;
    const cells = [];
    let nextCol = 0;
    for (const cm of String(rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c${cm[1]}>`;
      const col = colIndex(attr(tag, 'r')) ?? nextCol;
      nextCol = col + 1;
      const inner = cm[2] || '';
      const type = attr(tag, 't');
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = null;
      if (type === 's') value = v != null ? (shared[Number(v)] ?? null) : null;
      else if (type === 'inlineStr') value = textOf(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] || '');
      else if (type === 'str' || type === 'e') value = v != null ? decodeXml(v) : null;
      else if (type === 'b') value = v != null ? v.trim() === '1' : null;
      else if (v != null && v.trim() !== '') {
        const num = Number(v);
        value = Number.isFinite(num) ? num : decodeXml(v);
      }
      cells[col] = value;
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = null;
    rows[rowIdx] = cells;
  }
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
  return rows;
}
