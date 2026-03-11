import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BUNDESNETZAGENTUR_BASE_URL = 'https://www.bundesnetzagentur.de';
const BUNDESNETZAGENTUR_ARCHIVE_URL = `${BUNDESNETZAGENTUR_BASE_URL}/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Foerderung/Archiv_VergSaetze/start.html`;

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function decodeXml(value) {
  return decodeHtml(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, numeric) => String.fromCodePoint(Number(numeric)));
}

function normalizeNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const numeric = Number(value.replace(',', '.'));
  return Number.isFinite(numeric) ? numeric : null;
}

function round2(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

function columnToNumber(columnLabel) {
  return String(columnLabel || '').split('').reduce((total, character) => {
    return (total * 26) + (character.charCodeAt(0) - 64);
  }, 0);
}

function parseSharedStringsXml(sharedStringsXml) {
  return Array.from(String(sharedStringsXml || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g), (match) => {
    const text = Array.from(match[1].matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g), (textMatch) => decodeXml(textMatch[1]));
    return text.join('').trim();
  });
}

function parseWorksheetRows(sheetXml, sharedStrings) {
  return Array.from(String(sheetXml || '').matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g), (rowMatch) => {
    const cells = {};
    for (const cellMatch of rowMatch[2].matchAll(/<c\b[^>]*r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const column = cellMatch[1];
      const attrs = cellMatch[2] || '';
      const inner = cellMatch[3] || '';
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
      const rawValue = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const inlineText = inner.match(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/)?.[1];
      if (type === 's') {
        const index = Number(rawValue);
        if (Number.isInteger(index) && index >= 0 && index < sharedStrings.length) cells[column] = sharedStrings[index];
        continue;
      }
      if (type === 'inlineStr' && inlineText != null) {
        cells[column] = decodeXml(inlineText).trim();
        continue;
      }
      if (rawValue != null) {
        cells[column] = decodeXml(rawValue).trim();
      }
    }
    return {
      row: Number(rowMatch[1]),
      cells
    };
  });
}

function parseTierLimit(label) {
  const match = String(label || '').match(/bis\s+(\d+(?:[.,]\d+)?)\s*(kW|kWp|MW)\b/i);
  if (!match) return null;
  const numeric = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(numeric)) return null;
  return match[2].toLowerCase() === 'mw' ? numeric * 1000 : numeric;
}

function parseMonthKeys(label) {
  const match = String(label || '').match(
    /ab\s+(\d{2})\.(\d{2})\.(\d{4})(?:\s+bis\s+(\d{2})\.(\d{2})\.(\d{4}))?/i
  );
  if (!match) return [];
  const startYear = Number(match[3]);
  const startMonth = Number(match[2]);
  const endYear = Number(match[6] || match[3]);
  const endMonth = Number(match[5] || match[2]);
  if (!Number.isInteger(startYear) || !Number.isInteger(startMonth) || !Number.isInteger(endYear) || !Number.isInteger(endMonth)) {
    return [];
  }

  const monthKeys = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    monthKeys.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
  }
  return monthKeys;
}

function isMarketPremiumHeading(value) {
  return /marktprämienmodell/i.test(String(value || ''));
}

function isSectionBoundary(value) {
  return /mieterstrom|feste einspeisevergütung|vergütungssätze/i.test(String(value || ''));
}

function isRoundedPartialFeedLabel(value) {
  return /teileinspeisung/i.test(String(value || '')) && /gerundet/i.test(String(value || ''));
}

function normalizeTierEntries(tiers) {
  return (Array.isArray(tiers) ? tiers : [])
    .map((entry) => ({
      upToKwp: normalizeNumber(entry?.upToKwp),
      ctKwh: round2(entry?.ctKwh)
    }))
    .filter((entry) => Number.isFinite(entry.upToKwp) && Number.isFinite(entry.ctKwh))
    .sort((left, right) => left.upToKwp - right.upToKwp);
}

function normalizeReferenceData(referenceData) {
  const applicableValueTiersByMonth = Object.entries(referenceData?.applicableValueTiersByMonth || {}).reduce((result, [monthKey, tiers]) => {
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return result;
    const normalizedTiers = normalizeTierEntries(tiers);
    if (normalizedTiers.length) result[monthKey] = normalizedTiers;
    return result;
  }, {});

  return {
    source: referenceData?.source || 'bundesnetzagentur',
    updatedAt: referenceData?.updatedAt || null,
    archiveUrl: referenceData?.archiveUrl || BUNDESNETZAGENTUR_ARCHIVE_URL,
    publications: Array.isArray(referenceData?.publications) ? referenceData.publications.map(String) : [],
    applicableValueTiersByMonth
  };
}

function readPersistedReferenceData(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) return normalizeReferenceData({});
  try {
    return normalizeReferenceData(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
  } catch {
    return normalizeReferenceData({});
  }
}

function writePersistedReferenceData(cachePath, referenceData) {
  if (!cachePath) return;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(referenceData, null, 2)}\n`, 'utf8');
}

function hasYear(referenceData, year) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear)) return Object.keys(referenceData?.applicableValueTiersByMonth || {}).length > 0;
  return Object.keys(referenceData?.applicableValueTiersByMonth || {}).some((monthKey) => monthKey.startsWith(`${numericYear}-`));
}

function selectApplicableValueCtKwh(referenceData, { commissionedAt, kwp } = {}) {
  const monthKey = typeof commissionedAt === 'string' ? commissionedAt.slice(0, 7) : '';
  const tiers = referenceData?.applicableValueTiersByMonth?.[monthKey];
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const numericKwp = normalizeNumber(kwp);
  if (!Number.isFinite(numericKwp) || numericKwp <= 0) return null;
  for (const tier of tiers) {
    if (numericKwp <= tier.upToKwp) return tier.ctKwh;
  }
  return tiers[tiers.length - 1]?.ctKwh ?? null;
}

function buildApplicableValueSummary(referenceData, { year, pvPlants = [] } = {}) {
  const applicableValueCtKwhByMonth = {};
  for (const plant of Array.isArray(pvPlants) ? pvPlants : []) {
    const monthKey = typeof plant?.commissionedAt === 'string' ? plant.commissionedAt.slice(0, 7) : '';
    if (!/^\d{4}-\d{2}$/.test(monthKey) || monthKey in applicableValueCtKwhByMonth) continue;
    const ctKwh = selectApplicableValueCtKwh(referenceData, plant);
    if (Number.isFinite(ctKwh)) applicableValueCtKwhByMonth[monthKey] = ctKwh;
  }
  if (Object.keys(applicableValueCtKwhByMonth).length === 0) {
    for (const [monthKey, tiers] of Object.entries(referenceData?.applicableValueTiersByMonth || {})) {
      if (Number.isInteger(Number(year)) && !monthKey.startsWith(`${Number(year)}-`)) continue;
      if (tiers[0] && Number.isFinite(tiers[0].ctKwh)) applicableValueCtKwhByMonth[monthKey] = tiers[0].ctKwh;
    }
  }

  return {
    source: referenceData?.source || 'bundesnetzagentur',
    updatedAt: referenceData?.updatedAt || null,
    publications: Array.isArray(referenceData?.publications) ? [...referenceData.publications] : [],
    applicableValueCtKwhByMonth,
    getApplicableValueCtKwh({ commissionedAt, kwp } = {}) {
      return selectApplicableValueCtKwh(referenceData, { commissionedAt, kwp });
    }
  };
}

function readZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      if (signature === 0x02014b50 || signature === 0x06054b50) break;
      offset += 1;
      continue;
    }

    const flags = buffer.readUInt16LE(offset + 6);
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraFieldLength = buffer.readUInt16LE(offset + 28);
    if ((flags & 0x08) !== 0) {
      throw new Error('ZIP entries with data descriptors are not supported');
    }

    const fileName = buffer.toString('utf8', offset + 30, offset + 30 + fileNameLength);
    const dataStart = offset + 30 + fileNameLength + extraFieldLength;
    const dataEnd = dataStart + compressedSize;
    const compressed = buffer.subarray(dataStart, dataEnd);
    let content;
    if (compressionMethod === 0) {
      content = compressed;
    } else if (compressionMethod === 8) {
      content = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod}`);
    }
    entries.set(fileName, content);
    offset = dataEnd;
  }

  return entries;
}

function findSheetXml(entries) {
  if (entries.has('xl/worksheets/sheet1.xml')) return entries.get('xl/worksheets/sheet1.xml');
  for (const [name, content] of entries.entries()) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) return content;
  }
  return null;
}

export function extractBundesnetzagenturApplicableValuePublicationLinks(
  html,
  { baseUrl = BUNDESNETZAGENTUR_BASE_URL } = {}
) {
  const links = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/href="([^"]+)"/g)) {
    const href = decodeHtml(match[1]);
    if (!/\.xlsx\b/i.test(href)) continue;
    if (!/(VergSaetze|DegressionsVergSaetze)/i.test(href)) continue;
    const absolute = new URL(href, baseUrl).toString();
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    links.push(absolute);
  }
  return links;
}

export function parseBundesnetzagenturApplicableValueSheet({ sharedStringsXml, sheetXml }) {
  const sharedStrings = parseSharedStringsXml(sharedStringsXml);
  const rows = parseWorksheetRows(sheetXml, sharedStrings);
  const applicableValueTiersByMonth = {};

  const sectionStart = rows.findIndex((row) => Object.values(row.cells).some(isMarketPremiumHeading));
  if (sectionStart < 0) return { applicableValueTiersByMonth };

  const rowsAfterSection = rows.slice(sectionStart + 1);
  const firstMonthRowIndex = rowsAfterSection.findIndex((row) => Object.values(row.cells).some((value) => parseMonthKeys(value).length > 0));
  const headerBlock = firstMonthRowIndex >= 0
    ? rowsAfterSection.slice(0, firstMonthRowIndex)
    : rowsAfterSection.slice(0, 5);
  const labelColumn = headerBlock
    .flatMap((row) => Object.entries(row.cells))
    .find(([, value]) => value === 'Monat' || value === 'Inbetriebnahme')?.[0];
  if (!labelColumn) return { applicableValueTiersByMonth };

  const tierColumns = headerBlock
    .flatMap((row) => Object.entries(row.cells))
    .map(([column, value]) => ({ column, upToKwp: parseTierLimit(value) }))
    .filter((entry) => Number.isFinite(entry.upToKwp))
    .filter((entry, index, items) => items.findIndex((candidate) => candidate.column === entry.column) === index)
    .sort((left, right) => columnToNumber(left.column) - columnToNumber(right.column));
  if (!tierColumns.length) return { applicableValueTiersByMonth };

  let currentMonthKey = null;
  for (const row of rows.slice(sectionStart + 1)) {
    const label = row.cells[labelColumn] || '';
    if (Object.values(row.cells).some(isSectionBoundary)) break;

    const monthKeys = parseMonthKeys(label);
    if (monthKeys.length > 0) {
      currentMonthKey = monthKeys;
      continue;
    }
    if (!currentMonthKey || !isRoundedPartialFeedLabel(label)) continue;

    const tiers = tierColumns.reduce((result, tierColumn) => {
      const ctKwh = round2(row.cells[tierColumn.column]);
      if (Number.isFinite(ctKwh)) {
        result.push({
          upToKwp: tierColumn.upToKwp,
          ctKwh
        });
      }
      return result;
    }, []);
    if (tiers.length) {
      for (const monthKey of currentMonthKey) {
        applicableValueTiersByMonth[monthKey] = tiers;
      }
    }
  }

  return { applicableValueTiersByMonth };
}

export async function fetchBundesnetzagenturApplicableValueReferenceData({
  archiveUrl = BUNDESNETZAGENTUR_ARCHIVE_URL,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }
  const archiveResponse = await fetchImpl(archiveUrl, {
    headers: { accept: 'text/html,application/xhtml+xml' }
  });
  if (!archiveResponse.ok) {
    throw new Error(`Bundesnetzagentur archive request failed: HTTP ${archiveResponse.status} for ${archiveUrl}`);
  }
  const archiveHtml = await archiveResponse.text();
  const publications = extractBundesnetzagenturApplicableValuePublicationLinks(archiveHtml);
  const applicableValueTiersByMonth = {};

  for (const publicationUrl of publications) {
    const publicationResponse = await fetchImpl(publicationUrl);
    if (!publicationResponse.ok) {
      throw new Error(`Bundesnetzagentur publication request failed: HTTP ${publicationResponse.status} for ${publicationUrl}`);
    }
    const workbookBuffer = Buffer.from(await publicationResponse.arrayBuffer());
    const entries = readZipEntries(workbookBuffer);
    const sharedStringsXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') || '';
    const sheetXml = findSheetXml(entries)?.toString('utf8') || '';
    const parsed = parseBundesnetzagenturApplicableValueSheet({ sharedStringsXml, sheetXml });
    Object.assign(applicableValueTiersByMonth, parsed.applicableValueTiersByMonth);
  }

  return normalizeReferenceData({
    source: 'bundesnetzagentur',
    archiveUrl,
    publications,
    applicableValueTiersByMonth
  });
}

export function createBundesnetzagenturApplicableValueService({
  cachePath = '',
  fetchImpl = globalThis.fetch,
  nowIso = () => new Date().toISOString(),
  fetchReferenceData = (options = {}) => fetchBundesnetzagenturApplicableValueReferenceData({
    ...options,
    fetchImpl
  })
} = {}) {
  let referenceData = readPersistedReferenceData(cachePath);
  let refreshPromise = null;

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = Promise.resolve(fetchReferenceData({}))
      .then((fetched) => {
        referenceData = normalizeReferenceData({
          ...fetched,
          updatedAt: nowIso()
        });
        writePersistedReferenceData(cachePath, referenceData);
        return referenceData;
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  }

  function getApplicableValueSummary({ year, pvPlants = [] } = {}) {
    if (!hasYear(referenceData, year) && !refreshPromise) {
      void refresh().catch(() => {});
    }
    return buildApplicableValueSummary(referenceData, { year, pvPlants });
  }

  return {
    refresh,
    getApplicableValueSummary
  };
}
