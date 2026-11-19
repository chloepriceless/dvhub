// EEG „anzulegende Werte“ (AW) der Bundesnetzagentur je Inbetriebnahmemonat
// und Leistungsstufe (Teil- und Volleinspeisung).
//
// Quelle seit 19.11.2026 (Christin), wählbar unter Einstellungen → Strompreise →
// Marktprämie (referenceData.applicableValueSource):
//   'dvhub'  (Standard) fertig geprüft von dvhub.online
//            (GET <epex.priceApiUrl>/v1/pv/eeg-applicable-values, Prüfsumme wird
//            nachgerechnet); scheitert das, direkt bei der BNetzA.
//   'public' direkt bei der BNetzA: Archivseite + jede verlinkte xlsx (heute 35).
// Vorher holte jede Box bei JEDEM Start alle Dateien direkt — und zusätzlich bei
// jedem Historie-Aufruf für ein Jahr ohne Werte (z. B. 2021) noch einmal. Eine
// Feldbox bekam am 19.11. HTTP 404 für die Archivseite (Drosselung der BNetzA).
//
// Geholt wird nur, wenn eine PV-Anlage mit kWp und Inbetriebnahme eingetragen ist
// (applicableValuesNeeded — alle Verbraucher rechnen je Anlage), dann wöchentlich
// ohne Neustart (tick), nach einem Fehlschlag frühestens nach 6 h (ohne Stand: 1 h).
//
// Der Parser ist auf dem Server (Hetzner-Docker price-api/eeg-applicable-values.js)
// bewusst kopiert; beide Seiten prüfen dieselben echten BNetzA-Dateien gegen
// dieselbe Erwartungsdatei (test/fixtures/eeg-applicable-values/expected.json).
// Ändert sich der Parser hier, dort nachziehen.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
// Sweep package 6: shared 2-decimal rounding helper (was a local round2 duplicate).
// nullOnInvalid:true preserves this file's original "return null on non-finite" behavior.
// All round2 call sites here operate on non-negative EEG applicable-value rates, so the
// shared sign-aware helper is behavior-equivalent to the previous plain Math.round body.
import { round2 as sharedRound2 } from './server-utils.js';
import { outboundFetch } from './services/outbound-fetch.js';
const round2 = (value) => sharedRound2(value, { nullOnInvalid: true });

const BUNDESNETZAGENTUR_BASE_URL = 'https://www.bundesnetzagentur.de';
const BUNDESNETZAGENTUR_ARCHIVE_URL = `${BUNDESNETZAGENTUR_BASE_URL}/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Foerderung/Archiv_VergSaetze/start.html`;

export const CENTRAL_APPLICABLE_VALUES_PATH = '/v1/pv/eeg-applicable-values';
const CENTRAL_TIMEOUT_MS = 20_000;
const DIRECT_TIMEOUT_MS = 60_000;
// Wöchentlich: neue Veröffentlichungen (Februar/August) kommen ohne Neustart an.
export const APPLICABLE_VALUE_REFRESH_MS = 7 * 24 * 3600_000;
// Nach einem Fehlschlag: mit gültigem Stand erst nach 6 h wieder, ohne nach 1 h.
export const APPLICABLE_VALUE_RETRY_MS = 6 * 3600_000;
export const APPLICABLE_VALUE_RETRY_EMPTY_MS = 3600_000;
// Takt der Prüfung „fällig?“ (billig, ohne Netz, solange nichts fällig ist).
export const APPLICABLE_VALUE_TICK_MS = 15 * 60_000;
// Web-Prozess ohne eigenen Abruf: Cache-Datei höchstens alle 30 s neu ansehen.
const DISK_RELOAD_MS = 30_000;
const VIA_CENTRAL = 'dvhub_online';
const VIA_DIRECT = 'bundesnetzagentur';

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

export function isRoundedFullFeedLabel(value) {
  return /volleinspeisung/i.test(String(value || '')) && /gerundet/i.test(String(value || ''));
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

  const fullFeedApplicableValueTiersByMonth = Object.entries(referenceData?.fullFeedApplicableValueTiersByMonth || {}).reduce((result, [monthKey, tiers]) => {
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
    // Woher die Box den Stand hat (Caches von vor 19.11.2026: immer direkt).
    via: referenceData?.via === VIA_CENTRAL ? VIA_CENTRAL : VIA_DIRECT,
    checksum: typeof referenceData?.checksum === 'string' ? referenceData.checksum : null,
    applicableValueTiersByMonth,
    fullFeedApplicableValueTiersByMonth
  };
}

// ── Prüfsumme (gleich auf dem Server, price-api/eeg-applicable-values.js) ────
// sha256 über die kanonische JSON-Form (Schlüssel sortiert, Reihenfolge der
// Stufen bleibt) der beiden Wertetabellen — unabhängig davon, wie die
// Datenbank (jsonb) die Schlüssel ordnet.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function applicableValueChecksum(data) {
  const body = canonicalJson({
    applicableValueTiersByMonth: data?.applicableValueTiersByMonth || {},
    fullFeedApplicableValueTiersByMonth: data?.fullFeedApplicableValueTiersByMonth || {},
  });
  return `sha256:${crypto.createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

// Abrufzustand neben den Werten in derselben Datei (refreshState). Caches von
// vor 19.11.2026 kennen ihn nicht: dort war updatedAt die Zeit des Abrufs.
function normalizeRefreshState(state, referenceData) {
  const iso = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);
  return {
    lastAttemptAt: iso(state?.lastAttemptAt),
    lastAttemptOk: typeof state?.lastAttemptOk === 'boolean' ? state.lastAttemptOk : null,
    lastAttemptSource: state?.lastAttemptSource === 'public' || state?.lastAttemptSource === 'dvhub' ? state.lastAttemptSource : null,
    lastSuccessAt: iso(state?.lastSuccessAt) || (state ? null : iso(referenceData?.updatedAt)),
    lastError: typeof state?.lastError === 'string' ? state.lastError.slice(0, 300) : null
  };
}

function readPersistedState(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) {
    const referenceData = normalizeReferenceData({});
    return { referenceData, refreshState: normalizeRefreshState(null, referenceData) };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const referenceData = normalizeReferenceData(raw);
    return { referenceData, refreshState: normalizeRefreshState(raw?.refreshState || null, referenceData) };
  } catch {
    const referenceData = normalizeReferenceData({});
    return { referenceData, refreshState: normalizeRefreshState(null, referenceData) };
  }
}

function writePersistedReferenceData(cachePath, referenceData, refreshState = undefined) {
  if (!cachePath) return;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  // Atomic write: temp file + rename prevents a partial/corrupt cache file on a
  // crash mid-write. No chmod — this is non-secret reference data.
  const tmpPath = cachePath + '.tmp';
  const body = refreshState ? { ...referenceData, refreshState } : referenceData;
  fs.writeFileSync(tmpPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, cachePath);
}

function monthKeys(referenceData) {
  return Object.keys(referenceData?.applicableValueTiersByMonth || {}).sort();
}

/**
 * Brauchen wir anzulegende Werte? Jeder Verbraucher rechnet je PV-Anlage
 * (Historie: gewichteter AW Teil-/Volleinspeisung, EOS: Marktprämie auf das
 * Einspeisesignal) — ohne Anlage mit kWp und Inbetriebnahme bleibt alles null.
 * Ein manueller AW (applicableValueOverrideCtKwh) ersetzt nur die
 * Teileinspeisung; die Volleinspeisung rechnet weiter mit den BNetzA-Werten.
 */
export function applicableValuesNeeded(cfg) {
  const plants = cfg?.userEnergyPricing?.pvPlants;
  return Array.isArray(plants) && plants.some((plant) => Number(plant?.kwp) > 0
    && /^\d{4}-\d{2}/.test(String(plant?.commissionedAt || '')));
}

export function normalizeApplicableValueSource(value) {
  return value === 'public' ? 'public' : 'dvhub';
}

// Zugangsdaten in einer eigenen priceApiUrl (https://user:pass@…) nie in Log
// oder Cache-Datei ablegen; Länge begrenzt.
function scrubError(error) {
  return String(error?.message || error || 'kein Abruf möglich').replace(/\/\/[^/\s@]+@/g, '//***@').slice(0, 300);
}

export function selectApplicableValueCtKwh(referenceData, { commissionedAt, kwp, feedType = 'partial' } = {}) {
  const monthKey = typeof commissionedAt === 'string' ? commissionedAt.slice(0, 7) : '';
  const tierMap = feedType === 'full'
    ? referenceData?.fullFeedApplicableValueTiersByMonth
    : referenceData?.applicableValueTiersByMonth;
  const tiers = tierMap?.[monthKey];
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const numericKwp = normalizeNumber(kwp);
  if (!Number.isFinite(numericKwp) || numericKwp <= 0) return null;

  // EEG §48 Stufentarif: each kWp earns the rate of the tier its position
  // falls into. A 29.7 kWp installation earns the 10 kWp-tier rate on its
  // first 10 kWp and the 40 kWp-tier rate on the remaining 19.7 kWp; the
  // overall AW is the capacity-weighted average.
  let weightedSumCt = 0;
  let prevUpTo = 0;
  for (const tier of tiers) {
    const tierTopKwp = Number(tier?.upToKwp);
    const tierCtKwh = Number(tier?.ctKwh);
    if (!Number.isFinite(tierTopKwp) || !Number.isFinite(tierCtKwh)) continue;
    const tierShareKwp = Math.max(0, Math.min(numericKwp, tierTopKwp) - prevUpTo);
    weightedSumCt += tierShareKwp * tierCtKwh;
    prevUpTo = tierTopKwp;
    if (numericKwp <= tierTopKwp) break;
  }
  if (numericKwp > prevUpTo) {
    const lastCtKwh = Number(tiers[tiers.length - 1]?.ctKwh);
    if (Number.isFinite(lastCtKwh)) {
      weightedSumCt += (numericKwp - prevUpTo) * lastCtKwh;
    }
  }
  return round2(weightedSumCt / numericKwp);
}

function buildApplicableValueSummary(referenceData, { year, pvPlants = [], feedType = 'partial' } = {}) {
  const applicableValueCtKwhByMonth = {};
  for (const plant of Array.isArray(pvPlants) ? pvPlants : []) {
    const monthKey = typeof plant?.commissionedAt === 'string' ? plant.commissionedAt.slice(0, 7) : '';
    if (!/^\d{4}-\d{2}$/.test(monthKey) || monthKey in applicableValueCtKwhByMonth) continue;
    const ctKwh = selectApplicableValueCtKwh(referenceData, { ...plant, feedType });
    if (Number.isFinite(ctKwh)) applicableValueCtKwhByMonth[monthKey] = ctKwh;
  }
  if (Object.keys(applicableValueCtKwhByMonth).length === 0) {
    const tierMap = feedType === 'full'
      ? referenceData?.fullFeedApplicableValueTiersByMonth
      : referenceData?.applicableValueTiersByMonth;
    for (const [monthKey, tiers] of Object.entries(tierMap || {})) {
      if (Number.isInteger(Number(year)) && !monthKey.startsWith(`${Number(year)}-`)) continue;
      if (tiers[0] && Number.isFinite(tiers[0].ctKwh)) applicableValueCtKwhByMonth[monthKey] = tiers[0].ctKwh;
    }
  }

  return {
    source: referenceData?.source || 'bundesnetzagentur',
    updatedAt: referenceData?.updatedAt || null,
    publications: Array.isArray(referenceData?.publications) ? [...referenceData.publications] : [],
    applicableValueCtKwhByMonth,
    getApplicableValueCtKwh({ commissionedAt, kwp, feedType: ft = feedType } = {}) {
      return selectApplicableValueCtKwh(referenceData, { commissionedAt, kwp, feedType: ft });
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
  const fullFeedApplicableValueTiersByMonth = {};

  const sectionStart = rows.findIndex((row) => Object.values(row.cells).some(isMarketPremiumHeading));
  if (sectionStart < 0) return { applicableValueTiersByMonth, fullFeedApplicableValueTiersByMonth };

  const rowsAfterSection = rows.slice(sectionStart + 1);
  const firstMonthRowIndex = rowsAfterSection.findIndex((row) => Object.values(row.cells).some((value) => parseMonthKeys(value).length > 0));
  const headerBlock = firstMonthRowIndex >= 0
    ? rowsAfterSection.slice(0, firstMonthRowIndex)
    : rowsAfterSection.slice(0, 5);
  const labelColumn = headerBlock
    .flatMap((row) => Object.entries(row.cells))
    .find(([, value]) => value === 'Monat' || value === 'Inbetriebnahme')?.[0];
  if (!labelColumn) return { applicableValueTiersByMonth, fullFeedApplicableValueTiersByMonth };

  const tierColumns = headerBlock
    .flatMap((row) => Object.entries(row.cells))
    .map(([column, value]) => ({ column, upToKwp: parseTierLimit(value) }))
    .filter((entry) => Number.isFinite(entry.upToKwp))
    .filter((entry, index, items) => items.findIndex((candidate) => candidate.column === entry.column) === index)
    .sort((left, right) => columnToNumber(left.column) - columnToNumber(right.column));
  if (!tierColumns.length) return { applicableValueTiersByMonth, fullFeedApplicableValueTiersByMonth };

  let currentMonthKey = null;
  for (const row of rows.slice(sectionStart + 1)) {
    const label = row.cells[labelColumn] || '';
    if (Object.values(row.cells).some(isSectionBoundary)) break;

    const monthKeys = parseMonthKeys(label);
    if (monthKeys.length > 0) {
      currentMonthKey = monthKeys;
      continue;
    }
    if (!currentMonthKey) continue;

    const isPartial = isRoundedPartialFeedLabel(label);
    const isFull = isRoundedFullFeedLabel(label);
    if (!isPartial && !isFull) continue;

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
      const targetMap = isFull ? fullFeedApplicableValueTiersByMonth : applicableValueTiersByMonth;
      for (const monthKey of currentMonthKey) {
        targetMap[monthKey] = tiers;
      }
    }
  }

  return { applicableValueTiersByMonth, fullFeedApplicableValueTiersByMonth };
}

// Eine xlsx (ZIP) → Monatswerte. Auf dem Server gleichnamig.
export function parseBundesnetzagenturApplicableValueWorkbook(workbookBuffer) {
  const entries = readZipEntries(workbookBuffer);
  const sharedStringsXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const sheetXml = findSheetXml(entries)?.toString('utf8') || '';
  return parseBundesnetzagenturApplicableValueSheet({ sharedStringsXml, sheetXml });
}

function withTimeout(options, ms) {
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
  return signal ? { ...options, signal } : options;
}

export async function fetchBundesnetzagenturApplicableValueReferenceData({
  archiveUrl = BUNDESNETZAGENTUR_ARCHIVE_URL,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }
  const archiveResponse = await fetchImpl(archiveUrl, withTimeout({
    headers: { accept: 'text/html,application/xhtml+xml' }
  }, DIRECT_TIMEOUT_MS));
  if (!archiveResponse.ok) {
    throw new Error(`Bundesnetzagentur archive request failed: HTTP ${archiveResponse.status} for ${archiveUrl}`);
  }
  const archiveHtml = await archiveResponse.text();
  const publications = extractBundesnetzagenturApplicableValuePublicationLinks(archiveHtml);
  const applicableValueTiersByMonth = {};
  const fullFeedApplicableValueTiersByMonth = {};

  // Seitenreihenfolge (neueste zuerst); spätere Dateien überschreiben frühere
  // Monate — der Server führt genauso zusammen.
  for (const publicationUrl of publications) {
    const publicationResponse = await fetchImpl(publicationUrl, withTimeout({}, DIRECT_TIMEOUT_MS));
    if (!publicationResponse.ok) {
      throw new Error(`Bundesnetzagentur publication request failed: HTTP ${publicationResponse.status} for ${publicationUrl}`);
    }
    const workbookBuffer = Buffer.from(await publicationResponse.arrayBuffer());
    const parsed = parseBundesnetzagenturApplicableValueWorkbook(workbookBuffer);
    Object.assign(applicableValueTiersByMonth, parsed.applicableValueTiersByMonth);
    Object.assign(fullFeedApplicableValueTiersByMonth, parsed.fullFeedApplicableValueTiersByMonth);
  }

  const normalized = normalizeReferenceData({
    source: 'bundesnetzagentur',
    archiveUrl,
    publications,
    via: VIA_DIRECT,
    applicableValueTiersByMonth,
    fullFeedApplicableValueTiersByMonth
  });
  return { ...normalized, checksum: applicableValueChecksum(normalized) };
}

/**
 * Fertiger Stand von dvhub.online (price-api-dev, 19.11.2026). Die Prüfsumme
 * wird über die EMPFANGENEN Tabellen nachgerechnet — weicht sie ab oder fehlt
 * sie, gilt der Stand als kaputt (Aufrufer fällt auf die BNetzA zurück).
 * updatedAt = zuletzt vom Server bei der BNetzA bestätigt.
 */
export async function fetchCentralApplicableValueReferenceData({ baseUrl, fetchImpl = outboundFetch } = {}) {
  if (!baseUrl) throw new Error('dvhub.online: keine Adresse (epex.priceApiUrl)');
  const url = `${String(baseUrl).replace(/\/+$/, '')}${CENTRAL_APPLICABLE_VALUES_PATH}`;
  const response = await fetchImpl(url, withTimeout({ headers: { accept: 'application/json' } }, CENTRAL_TIMEOUT_MS));
  if (!response.ok) throw new Error(`dvhub.online applicable values request failed: HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body?.checksum !== 'string' || !body.checksum) throw new Error('dvhub.online: Prüfsumme fehlt');
  const computed = applicableValueChecksum(body);
  if (computed !== body.checksum) throw new Error(`dvhub.online: Prüfsumme stimmt nicht (${computed.slice(0, 19)}… statt ${body.checksum.slice(0, 19)}…)`);
  const normalized = normalizeReferenceData({ ...body, via: VIA_CENTRAL, checksum: body.checksum });
  if (!monthKeys(normalized).length) throw new Error('dvhub.online: keine Werte');
  return normalized;
}

export function createBundesnetzagenturApplicableValueService({
  cachePath = '',
  fetchImpl = globalThis.fetch,
  // Abruf von dvhub.online mit Namensprüfung (epex.priceApiUrl kommt aus der Config).
  centralFetchImpl = outboundFetch,
  nowIso = () => new Date().toISOString(),
  // Gewählte Quelle (referenceData.applicableValueSource) und Basis-URL (epex.priceApiUrl).
  // Ohne Basis-URL nur direkt (Tests, ältere Aufrufer).
  getSource = () => 'dvhub',
  getCentralBaseUrl = () => null,
  isNeeded = () => true,
  // Eingetragene PV-Anlagen (Config) — der Takt erkennt damit eine neue
  // Inbetriebnahme auch ohne Historie- oder EOS-Aufruf.
  getPvPlants = () => null,
  // Nur der Laufzeit-Prozess holt (getrennter Betrieb); der Web-Prozess liest die Datei nach.
  ownsRefresh = true,
  pushLog = null,
  refreshIntervalMs = APPLICABLE_VALUE_REFRESH_MS,
  retryIntervalMs = APPLICABLE_VALUE_RETRY_MS,
  retryEmptyIntervalMs = APPLICABLE_VALUE_RETRY_EMPTY_MS,
  fetchReferenceData = (options = {}) => fetchBundesnetzagenturApplicableValueReferenceData({
    ...options,
    fetchImpl
  }),
  fetchCentralReferenceData = ({ baseUrl }) => fetchCentralApplicableValueReferenceData({
    baseUrl,
    fetchImpl: centralFetchImpl
  })
} = {}) {
  let { referenceData, refreshState } = readPersistedState(cachePath);
  let refreshPromise = null;
  let diskCheckedAtMs = null;
  let diskMtimeMs = fileMtimeMs();

  const nowMs = () => Date.parse(nowIso());
  const log = (event, details, level) => { try { pushLog?.(event, details, level); } catch { /* Log darf nie stören */ } };

  function fileMtimeMs() {
    try { return cachePath ? fs.statSync(cachePath).mtimeMs : null; } catch { return null; }
  }

  // Getrennter Betrieb: Der Web-Prozess holt nicht selbst, sondern liest nach,
  // was der Laufzeit-Prozess geschrieben hat (höchstens alle 30 s ein stat).
  function reloadFromDiskIfChanged() {
    if (ownsRefresh || !cachePath) return;
    const now = nowMs();
    if (diskCheckedAtMs != null && now - diskCheckedAtMs < DISK_RELOAD_MS) return;
    diskCheckedAtMs = now;
    const mtime = fileMtimeMs();
    if (mtime === diskMtimeMs) return;
    diskMtimeMs = mtime;
    ({ referenceData, refreshState } = readPersistedState(cachePath));
  }

  function effectiveSource() {
    return normalizeApplicableValueSource(getSource?.()) === 'dvhub' && getCentralBaseUrl?.() ? 'dvhub' : 'public';
  }

  function persist() {
    try {
      writePersistedReferenceData(cachePath, referenceData, refreshState);
      diskMtimeMs = fileMtimeMs();
    } catch (error) {
      log('applicable_value_cache_write_error', { error: error.message }, 'warn');
    }
  }

  const sinceMs = (iso, now) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? now - t : Infinity;
  };

  // Anlagen mit Inbetriebnahme nach dem letzten bekannten Monat (Aufruf und Config).
  function plantBeyondCache(pvPlants, months) {
    const lastMonth = months[months.length - 1];
    if (!lastMonth) return false;
    const configured = getPvPlants?.();
    const plants = [...(Array.isArray(pvPlants) ? pvPlants : []), ...(Array.isArray(configured) ? configured : [])];
    return plants.some((plant) => {
      const key = typeof plant?.commissionedAt === 'string' ? plant.commissionedAt.slice(0, 7) : '';
      return /^\d{4}-\d{2}$/.test(key) && key > lastMonth;
    });
  }

  /**
   * Ist ein Abruf fällig? null = nein, sonst der Grund. Reihenfolge:
   * Quelle umgestellt (sofort) → Pause nach Fehlschlag → kein Stand →
   * wöchentlich → eine Anlage mit Inbetriebnahme nach dem letzten bekannten
   * Monat (alle 6 h) → nach Rückfall/Umstieg wieder die gewählte Quelle (alle 6 h).
   */
  function dueReason({ pvPlants = null } = {}) {
    if (!ownsRefresh || refreshPromise || !isNeeded()) return null;
    const now = nowMs();
    const source = effectiveSource();
    const months = monthKeys(referenceData);
    const sinceAttempt = sinceMs(refreshState.lastAttemptAt, now);
    if (refreshState.lastAttemptSource && refreshState.lastAttemptSource !== source) return 'source_changed';
    if (refreshState.lastAttemptOk === false && sinceAttempt < (months.length ? retryIntervalMs : retryEmptyIntervalMs)) return null;
    if (!months.length) return 'empty';
    if (!(sinceMs(refreshState.lastSuccessAt, now) < refreshIntervalMs)) return 'weekly';
    if (sinceAttempt < retryIntervalMs) return null;
    if (plantBeyondCache(pvPlants, months)) return 'new_month';
    if (referenceData.via !== (source === 'dvhub' ? VIA_CENTRAL : VIA_DIRECT)) return 'preferred_source';
    return null;
  }

  function cacheSummary() {
    const months = monthKeys(referenceData);
    return { cacheMonths: months.length, cacheLastMonth: months[months.length - 1] || null, cacheUpdatedAt: referenceData.updatedAt || null, cacheVia: months.length ? referenceData.via : null };
  }

  // Normalisieren und prüfen: Werte da und kein Monat weniger als der eigene
  // Stand (z. B. dvhub.online einen Tag hinter einer neuen Veröffentlichung,
  // die die Box schon direkt hat, oder eine Datei fehlte auf der Archivseite).
  // Sonst wirft es — der Aufrufer behandelt das wie einen Fehlschlag der Quelle.
  function acceptFetched(fetched, via, attemptAt) {
    const label = via === VIA_CENTRAL ? 'dvhub.online' : 'Bundesnetzagentur';
    const next = normalizeReferenceData({
      ...fetched,
      via,
      // Direkt: Zeit des Abrufs. dvhub.online: zuletzt vom Server bestätigt.
      updatedAt: via === VIA_CENTRAL && fetched?.updatedAt ? fetched.updatedAt : attemptAt
    });
    if (!next.checksum) next.checksum = applicableValueChecksum(next);
    const nextMonths = new Set(monthKeys(next));
    if (!nextMonths.size) throw new Error(`${label}: keine Werte`);
    const nextFull = new Set(Object.keys(next.fullFeedApplicableValueTiersByMonth));
    const lost = monthKeys(referenceData).filter((key) => !nextMonths.has(key))
      .concat(Object.keys(referenceData.fullFeedApplicableValueTiersByMonth).filter((key) => !nextFull.has(key)))
      .sort();
    if (lost.length) throw new Error(`${label}: älterer Stand als der gespeicherte, ${lost.length} Monat(e) fehlen (z. B. ${lost[0]})`);
    return next;
  }

  async function runRefresh({ reason = 'manual' } = {}) {
    const source = effectiveSource();
    const attemptAt = nowIso();
    const months = monthKeys(referenceData);
    // Rückfall auf die BNetzA nur, wenn der Stand fehlt, fällig ist oder eine
    // Anlage einen Monat braucht, den er nicht hat — nicht, um nach einem
    // Rückfall alle 6 h zu prüfen, ob dvhub.online wieder da ist.
    const allowFallback = !months.length || reason === 'new_month'
      || !(sinceMs(refreshState.lastSuccessAt, Date.parse(attemptAt)) < refreshIntervalMs);
    let next = null;
    let via = null;
    let error = null;
    if (source === 'dvhub') {
      try {
        next = acceptFetched(await fetchCentralReferenceData({ baseUrl: getCentralBaseUrl() }), VIA_CENTRAL, attemptAt);
        via = VIA_CENTRAL;
      } catch (centralError) {
        error = centralError;
        if (allowFallback) log('applicable_value_central_fallback', { error: scrubError(centralError), reason }, 'warn');
      }
    }
    if (!next && (source === 'public' || allowFallback)) {
      try {
        next = acceptFetched(await fetchReferenceData({}), VIA_DIRECT, attemptAt);
        via = VIA_DIRECT;
      } catch (directError) {
        error = directError;
      }
    }
    if (next) {
      referenceData = next;
      refreshState = { lastAttemptAt: attemptAt, lastAttemptOk: true, lastAttemptSource: source, lastSuccessAt: attemptAt, lastError: null };
      persist();
      const keys = monthKeys(referenceData);
      log('applicable_value_refresh_ok', {
        via, reason, months: keys.length, firstMonth: keys[0], lastMonth: keys[keys.length - 1],
        updatedAt: referenceData.updatedAt, checksum: referenceData.checksum
      }, 'info');
      return referenceData;
    }
    // Zugangsdaten in einer eigenen priceApiUrl (https://user:pass@…) nie ablegen.
    // lastSuccessAt bleibt: ein abgelehnter oder gescheiterter Abruf verschiebt
    // den Wochenabruf nicht.
    const message = scrubError(error);
    refreshState = { ...refreshState, lastAttemptAt: attemptAt, lastAttemptOk: false, lastAttemptSource: source, lastError: message };
    persist();
    // Mit gültigem Stand rechnet DVhub weiter — nur eine Warnung. Ein Fehler ist
    // es erst, wenn nichts da ist, aber eine PV-Anlage die Werte braucht.
    if (months.length) log('applicable_value_refresh_stale', { error: message, source, reason, ...cacheSummary() }, 'warn');
    else log('applicable_value_refresh_error', { error: message, source, reason }, isNeeded() ? 'error' : 'warn');
    throw error || new Error(message);
  }

  // Sofort holen (Aufrufer bekommt Fehler); läuft schon einer, auf diesen warten.
  function refresh(options = {}) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = runRefresh(options).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  /** Regelmäßiger Takt (und Start): holt nur, wenn fällig. Wirft nie. */
  async function tick(options = {}) {
    if (refreshPromise) return refreshPromise.catch(() => null);
    const reason = dueReason(options);
    if (!reason) return null;
    return refresh({ reason }).catch(() => null);
  }

  function getApplicableValueSummary({ year, pvPlants = [] } = {}) {
    reloadFromDiskIfChanged();
    // Nur bei neuer Inbetriebnahme nach dem letzten bekannten Monat (oder ganz
    // ohne Stand) nachfragen — gedrosselt wie der Takt. Früher holte jeder
    // Historie-Aufruf für ein Jahr ohne Werte alle BNetzA-Dateien neu.
    if (dueReason({ pvPlants })) void tick({ pvPlants });
    return buildApplicableValueSummary(referenceData, { year, pvPlants });
  }

  /** Für Einstellungen/Status: Quelle, Stand, Monate, letzter Versuch. */
  function getStatus() {
    reloadFromDiskIfChanged();
    const months = monthKeys(referenceData);
    return {
      needed: !!isNeeded(),
      source: normalizeApplicableValueSource(getSource?.()),
      effectiveSource: effectiveSource(),
      via: months.length ? referenceData.via : null,
      updatedAt: months.length ? referenceData.updatedAt || null : null,
      checksum: months.length ? referenceData.checksum || null : null,
      months: {
        first: months[0] || null,
        last: months[months.length - 1] || null,
        count: months.length,
        fullFeedCount: Object.keys(referenceData.fullFeedApplicableValueTiersByMonth).length
      },
      lastAttemptAt: refreshState.lastAttemptAt,
      lastAttemptOk: refreshState.lastAttemptOk,
      lastSuccessAt: refreshState.lastSuccessAt,
      lastError: refreshState.lastError
    };
  }

  return {
    refresh,
    tick,
    getApplicableValueSummary,
    getStatus
  };
}
