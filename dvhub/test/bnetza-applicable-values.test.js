import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createBundesnetzagenturApplicableValueService,
  extractBundesnetzagenturApplicableValuePublicationLinks,
  parseBundesnetzagenturApplicableValueSheet
} from '../bundesnetzagentur-applicable-values.js';

test('extractBundesnetzagenturApplicableValuePublicationLinks keeps unique xlsx publication links in page order', () => {
  const html = `
    <a href="/foo/not-used.pdf">pdf</a>
    <a href="/DE/Fachthemen/.../VergSaetzeFeb26bisJul26.xlsx?__blob=publicationFile&amp;v=2">neu</a>
    <a href="/DE/Fachthemen/.../VergSaetzeAug25bisJan26.xlsx?__blob=publicationFile&amp;v=2">alt</a>
    <a href="/DE/Fachthemen/.../VergSaetzeFeb26bisJul26.xlsx?__blob=publicationFile&amp;v=2">dupe</a>
  `;

  const links = extractBundesnetzagenturApplicableValuePublicationLinks(html);

  assert.deepEqual(links, [
    'https://www.bundesnetzagentur.de/DE/Fachthemen/.../VergSaetzeFeb26bisJul26.xlsx?__blob=publicationFile&v=2',
    'https://www.bundesnetzagentur.de/DE/Fachthemen/.../VergSaetzeAug25bisJan26.xlsx?__blob=publicationFile&v=2'
  ]);
});

test('parseBundesnetzagenturApplicableValueSheet reads rounded market premium tiers by month', () => {
  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <si><t>Anzulegende Werte in Cent/kWh - Marktprämienmodell:</t></si>
      <si><t>Monat</t></si>
      <si><t>bis 10 kW</t></si>
      <si><t>bis 40 kW</t></si>
      <si><t>bis 750 kW</t></si>
      <si><t>ab 01.08.2025</t></si>
      <si><t>Teileinspeisung (gerundet)</t></si>
      <si><t>ab 01.09.2025</t></si>
    </sst>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="2">
          <c r="J2" t="s"><v>0</v></c>
        </row>
        <row r="3">
          <c r="J3" t="s"><v>1</v></c>
          <c r="K3" t="s"><v>2</v></c>
          <c r="L3" t="s"><v>3</v></c>
          <c r="M3" t="s"><v>4</v></c>
        </row>
        <row r="4">
          <c r="J4" t="s"><v>5</v></c>
          <c r="K4"><v>12.34</v></c>
          <c r="L4"><v>11.22</v></c>
          <c r="M4"><v>9.87</v></c>
        </row>
        <row r="5">
          <c r="J5" t="s"><v>6</v></c>
          <c r="K5"><v>12.3</v></c>
          <c r="L5"><v>11.2</v></c>
          <c r="M5"><v>9.9</v></c>
        </row>
        <row r="6">
          <c r="J6" t="s"><v>7</v></c>
          <c r="K6"><v>12.1</v></c>
          <c r="L6"><v>10.9</v></c>
          <c r="M6"><v>9.4</v></c>
        </row>
        <row r="7">
          <c r="J7" t="s"><v>6</v></c>
          <c r="K7"><v>12.1</v></c>
          <c r="L7"><v>10.9</v></c>
          <c r="M7"><v>9.4</v></c>
        </row>
      </sheetData>
    </worksheet>`;

  const parsed = parseBundesnetzagenturApplicableValueSheet({ sharedStringsXml, sheetXml });

  assert.deepEqual(parsed.applicableValueTiersByMonth, {
    '2025-08': [
      { upToKwp: 10, ctKwh: 12.3 },
      { upToKwp: 40, ctKwh: 11.2 },
      { upToKwp: 750, ctKwh: 9.9 }
    ],
    '2025-09': [
      { upToKwp: 10, ctKwh: 12.1 },
      { upToKwp: 40, ctKwh: 10.9 },
      { upToKwp: 750, ctKwh: 9.4 }
    ]
  });
});

test('parseBundesnetzagenturApplicableValueSheet also accepts real workbook headers with Inbetriebnahme', () => {
  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <si><t>Anzulegende Werte in Cent/kWh - Marktprämienmodell:</t></si>
      <si><t>Inbetriebnahme</t></si>
      <si><t>bis 10 kW</t></si>
      <si><t>bis 40 kW</t></si>
      <si><t>bis 750 kW</t></si>
      <si><t>ab 01.02.2026</t></si>
      <si><t>Teileinspeisung (gerundet)</t></si>
    </sst>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="2">
          <c r="B2" t="s"><v>0</v></c>
        </row>
        <row r="3">
          <c r="B3" t="s"><v>1</v></c>
        </row>
        <row r="4">
          <c r="B4" s="1"/>
          <c r="C4" t="s"><v>2</v></c>
          <c r="D4" t="s"><v>3</v></c>
          <c r="E4" t="s"><v>4</v></c>
        </row>
        <row r="5">
          <c r="B5" t="s"><v>5</v></c>
          <c r="C5"><v>8.18</v></c>
          <c r="D5"><v>7.13</v></c>
          <c r="E5"><v>5.9</v></c>
        </row>
        <row r="6">
          <c r="B6" t="s"><v>6</v></c>
          <c r="C6"><v>8.18</v></c>
          <c r="D6"><v>7.13</v></c>
          <c r="E6"><v>5.9</v></c>
        </row>
      </sheetData>
    </worksheet>`;

  const parsed = parseBundesnetzagenturApplicableValueSheet({ sharedStringsXml, sheetXml });

  assert.deepEqual(parsed.applicableValueTiersByMonth, {
    '2026-02': [
      { upToKwp: 10, ctKwh: 8.18 },
      { upToKwp: 40, ctKwh: 7.13 },
      { upToKwp: 750, ctKwh: 5.9 }
    ]
  });
});

test('parseBundesnetzagenturApplicableValueSheet expands period labels to all covered months', () => {
  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <si><t>Anzulegende Werte in Cent/kWh - Marktprämienmodell:</t></si>
      <si><t>Inbetriebnahme</t></si>
      <si><t>bis 10 kW</t></si>
      <si><t>bis 40 kW</t></si>
      <si><t>bis 750 kW</t></si>
      <si><t>ab 01.02.2026 bis 31.07.2026</t></si>
      <si><t>Teileinspeisung (gerundet)</t></si>
    </sst>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="2">
          <c r="B2" t="s"><v>0</v></c>
        </row>
        <row r="3">
          <c r="B3" t="s"><v>1</v></c>
        </row>
        <row r="4">
          <c r="C4" t="s"><v>2</v></c>
          <c r="D4" t="s"><v>3</v></c>
          <c r="E4" t="s"><v>4</v></c>
        </row>
        <row r="5">
          <c r="B5" t="s"><v>5</v></c>
          <c r="C5"><v>8.18</v></c>
          <c r="D5"><v>7.13</v></c>
          <c r="E5"><v>5.9</v></c>
        </row>
        <row r="6">
          <c r="B6" t="s"><v>6</v></c>
          <c r="C6"><v>8.18</v></c>
          <c r="D6"><v>7.13</v></c>
          <c r="E6"><v>5.9</v></c>
        </row>
      </sheetData>
    </worksheet>`;

  const parsed = parseBundesnetzagenturApplicableValueSheet({ sharedStringsXml, sheetXml });

  assert.deepEqual(Object.keys(parsed.applicableValueTiersByMonth), [
    '2026-02',
    '2026-03',
    '2026-04',
    '2026-05',
    '2026-06',
    '2026-07'
  ]);
});

test('createBundesnetzagenturApplicableValueService persists fetched reference data and resolves values by plant size', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-applicable-values-'));
  const cachePath = path.join(tempDir, 'applicable-values.json');
  let fetches = 0;
  const service = createBundesnetzagenturApplicableValueService({
    cachePath,
    nowIso: () => '2026-03-10T12:00:00.000Z',
    fetchReferenceData: async () => {
      fetches += 1;
      return {
        source: 'bundesnetzagentur',
        publications: ['https://example.invalid/values.xlsx'],
        applicableValueTiersByMonth: {
          '2023-09': [
            { upToKwp: 10, ctKwh: 8.2 },
            { upToKwp: 40, ctKwh: 7.1 },
            { upToKwp: 750, ctKwh: 5.8 }
          ],
          '2024-02': [
            { upToKwp: 10, ctKwh: 8.11 },
            { upToKwp: 40, ctKwh: 7.03 },
            { upToKwp: 750, ctKwh: 5.72 }
          ]
        }
      };
    }
  });

  await service.refresh();

  const first = service.getApplicableValueSummary({
    year: 2023,
    pvPlants: [
      { kwp: 5, commissionedAt: '2023-09-01' },
      { kwp: 50, commissionedAt: '2023-09-20' }
    ]
  });
  const second = service.getApplicableValueSummary({
    year: 2024,
    pvPlants: [
      { kwp: 8, commissionedAt: '2024-02-01' }
    ]
  });

  assert.equal(fetches, 1);
  assert.equal(first.getApplicableValueCtKwh({ commissionedAt: '2023-09-01', kwp: 5 }), 8.2);
  assert.equal(first.getApplicableValueCtKwh({ commissionedAt: '2023-09-20', kwp: 50 }), 5.8);
  assert.equal(second.getApplicableValueCtKwh({ commissionedAt: '2024-02-01', kwp: 8 }), 8.11);
  assert.ok(fs.existsSync(cachePath));

  const persisted = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(persisted.updatedAt, '2026-03-10T12:00:00.000Z');
  assert.deepEqual(persisted.applicableValueTiersByMonth['2023-09'][0], { upToKwp: 10, ctKwh: 8.2 });
});
