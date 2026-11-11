// Kleine XLSX-Datei für Tests bauen (ZIP mit deflate/stored, wie Excel und
// openpyxl sie schreiben). Nur das, was services/tariff-provider/xlsx-lite.js
// liest: Arbeitsmappe, Beziehungen, gemeinsame Zeichenketten, ein Blatt.
import zlib from 'node:zlib';

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

/** ZIP aus { name: string|Buffer }; method 8 (deflate) oder 0 (stored) je Eintrag. */
export function buildZip(files, { stored = [] } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const method = stored.includes(name) ? 0 : 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(0), u16(0x5b21),
      u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf, comp
    ]);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(0), u16(0x5b21),
      u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBuf
    ]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(central.length), u32(offset), u16(0)
  ]);
  return Buffer.concat([...locals, central, eocd]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * XLSX mit einem Blatt. rows: Array von Zeilen; Zelle = string | number | boolean | null
 * | { inline: string } (inlineStr) | { str: string } (Formel-Ergebnis als Text).
 * Zeichenketten gehen in sharedStrings.xml.
 */
export function buildXlsx(rows, { sheetPath = 'xl/worksheets/sheet1.xml', stored = [] } = {}) {
  const shared = [];
  const sharedIdx = new Map();
  const si = (s) => {
    if (!sharedIdx.has(s)) { sharedIdx.set(s, shared.length); shared.push(s); }
    return sharedIdx.get(s);
  };
  const rowXml = rows.map((row, r) => {
    const cells = row.map((v, c) => {
      if (v == null) return '';
      const ref = `${colName(c)}${r + 1}`;
      if (typeof v === 'number') return `<c r="${ref}" s="1"><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
      if (typeof v === 'object' && 'inline' in v) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v.inline)}</t></is></c>`;
      if (typeof v === 'object' && 'str' in v) return `<c r="${ref}" t="str"><f>A1</f><v>${esc(v.str)}</v></c>`;
      return `<c r="${ref}" t="s"><v>${si(String(v))}</v></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const target = sheetPath.replace(/^xl\//, '');
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Abrechnung" sheetId="1" r:id="rId7"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + `<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/>`
      + '</Relationships>',
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">`
      + shared.map((s, i) => (i % 2 ? `<si><r><t>${esc(s.slice(0, 2))}</t></r><r><t xml:space="preserve">${esc(s.slice(2))}</t></r></si>` : `<si><t>${esc(s)}</t></si>`)).join('')
      + '</sst>',
    [sheetPath]: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`
  }, { stored });
}
