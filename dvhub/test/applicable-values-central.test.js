// Anzulegende Werte zentral von dvhub.online (19.11.2026): Quelle „DVhub“ mit
// Rückfall auf die Bundesnetzagentur, Quelle „Direkt“, Prüfsumme, Bedarf,
// wöchentliche Auffrischung, Log-Stufen und Parität mit dem Server-Parser
// (Hetzner-Docker price-api/eeg-applicable-values.js, gleiche Erwartungsdatei).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  APPLICABLE_VALUE_REFRESH_MS,
  APPLICABLE_VALUE_RETRY_MS,
  CENTRAL_APPLICABLE_VALUES_PATH,
  applicableValueChecksum,
  applicableValuesNeeded,
  createBundesnetzagenturApplicableValueService,
  extractBundesnetzagenturApplicableValuePublicationLinks,
  fetchBundesnetzagenturApplicableValueReferenceData,
  fetchCentralApplicableValueReferenceData,
  isEvaluatedPublication,
  parseBundesnetzagenturApplicableValueWorkbook,
  publicationPeriodEnd,
} from '../bundesnetzagentur-applicable-values.js';
import { createDefaultConfig, getConfigDefinition, normalizeConfigInput } from '../config-model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'eeg-applicable-values');
// Gleicher Wert wie in Hetzner-Docker price-api(-dev)/tests/eeg-applicable-values.test.js.
const EXPECTED_SHA256 = '1bfc9326cee946dbc15294949d225635a349837f2c9048516f7d32a732fe5cc4';
const EXPECTED_CHECKSUM = 'sha256:54f63ec6dc7e2c581833deec5ca79273b28a354641cbfda63feb401900ccd517';
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name));
const ARCHIVE_URL = 'https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Foerderung/Archiv_VergSaetze/start.html';
const BASE = 'https://dvhub.online';
const PLANTS = [{ kwp: 29.7, commissionedAt: '2026-01-15' }];

function fakeBnetzaFetch(files = expected.publicationOrder) {
  const calls = [];
  const html = files.map((f) => `<a href="/DE/x/_DL/${f}?__blob=publicationFile&amp;v=1">${f}</a>`).join('\n');
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === ARCHIVE_URL) return { ok: true, status: 200, text: async () => html };
    const buf = readFixture(decodeURIComponent(new URL(url).pathname.split('/').pop()));
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  return { fetchImpl, calls };
}

// Antwort von dvhub.online wie price-api-dev sie baut (jsonb: Stufen-Schlüssel umsortiert).
function centralBody(overrides = {}) {
  const flip = (map) => Object.fromEntries(Object.entries(map).map(([m, tiers]) => [m, tiers.map((t) => ({ ctKwh: t.ctKwh, upToKwp: t.upToKwp }))]));
  return {
    schemaVersion: 1,
    source: 'bundesnetzagentur',
    archiveUrl: ARCHIVE_URL,
    publications: expected.publicationOrder.map((f) => `https://www.bundesnetzagentur.de/DE/x/_DL/${f}?__blob=publicationFile&v=1`),
    applicableValueTiersByMonth: flip(expected.applicableValueTiersByMonth),
    fullFeedApplicableValueTiersByMonth: flip(expected.fullFeedApplicableValueTiersByMonth),
    months: { first: '2022-07', last: '2026-12', count: 54, fullFeedCount: 54 },
    updatedAt: '2026-11-19T05:40:00.000Z',
    publishedAt: '2026-11-19T05:40:00.000Z',
    checksum: EXPECTED_CHECKSUM,
    lastCheck: { at: '2026-11-19T05:40:00.000Z', ok: true },
    ...overrides,
  };
}

function fakeCentral({ status = 200, body = centralBody(), throws = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (throws) throw throws;
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  return { fetchImpl, calls };
}

function directData() {
  return {
    source: 'bundesnetzagentur',
    publications: ['https://www.bundesnetzagentur.de/direkt.xlsx'],
    applicableValueTiersByMonth: JSON.parse(JSON.stringify(expected.applicableValueTiersByMonth)),
    fullFeedApplicableValueTiersByMonth: JSON.parse(JSON.stringify(expected.fullFeedApplicableValueTiersByMonth)),
  };
}

// Prüfstand: Uhr, Cache-Datei, Quellen und Log in einer Hand.
function rig({ source = 'dvhub', plants = PLANTS, central = fakeCentral(), direct = async () => directData(), now = '2026-11-19T12:00:00.000Z', cache = null, cachePath = null, ownsRefresh = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-aw-central-'));
  const file = cachePath || path.join(dir, 'reference-data', 'bundesnetzagentur-applicable-values.json');
  if (cache) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache)); }
  const state = { now, source, plants, directCalls: 0, logs: [] };
  const service = createBundesnetzagenturApplicableValueService({
    cachePath: file,
    nowIso: () => state.now,
    getSource: () => state.source,
    getCentralBaseUrl: () => BASE,
    isNeeded: () => applicableValuesNeeded({ userEnergyPricing: { pvPlants: state.plants } }),
    getPvPlants: () => state.plants,
    centralFetchImpl: central.fetchImpl,
    fetchReferenceData: async () => { state.directCalls += 1; return direct(); },
    pushLog: (event, details, level) => state.logs.push({ event, details, level }),
    ownsRefresh,
  });
  return { service, state, file, central, advance(ms) { state.now = new Date(Date.parse(state.now) + ms).toISOString(); } };
}

const legacyCache = (updatedAt) => ({ source: 'bundesnetzagentur', updatedAt, publications: ['x'], ...directData() });
const events = (r) => r.state.logs.map((l) => `${l.event}:${l.level}`);

// ── Parität mit dem Server ───────────────────────────────────────────────────

test('Parität: echte BNetzA-Dateien → Erwartungsdatei (gleiche sha256 wie in Hetzner-Docker)', async () => {
  assert.equal(sha256(fs.readFileSync(path.join(FIXTURES, 'expected.json'))), EXPECTED_SHA256);
  for (const [name, hash] of Object.entries(expected.fixtures)) assert.equal(sha256(readFixture(name)), hash, name);
  const links = extractBundesnetzagenturApplicableValuePublicationLinks(readFixture('archive.html').toString('utf8'));
  assert.deepEqual(links, expected.archiveLinks);
  const { fetchImpl } = fakeBnetzaFetch();
  const parsed = await fetchBundesnetzagenturApplicableValueReferenceData({ fetchImpl });
  assert.deepEqual(parsed.applicableValueTiersByMonth, expected.applicableValueTiersByMonth);
  assert.deepEqual(parsed.fullFeedApplicableValueTiersByMonth, expected.fullFeedApplicableValueTiersByMonth);
  assert.equal(applicableValueChecksum(parsed), EXPECTED_CHECKSUM);
  assert.equal(parsed.checksum, EXPECTED_CHECKSUM);
  assert.deepEqual(parseBundesnetzagenturApplicableValueWorkbook(readFixture('DegressionsVergSaetzeAugbisOkt22EEGNovelle.xlsx')),
    { applicableValueTiersByMonth: {}, fullFeedApplicableValueTiersByMonth: {} });
});

// ── Linkfilter: nur Dateien, aus denen der Parser Werte liest ────────────────

const fileNameOf = (url) => decodeURIComponent(new URL(url).pathname.split('/').pop());

test('Linkfilter: von 35 Links auf der echten Archivseite nur die 7 auswertbaren, keine Wind-Dateien', () => {
  const links = extractBundesnetzagenturApplicableValuePublicationLinks(readFixture('archive.html').toString('utf8'));
  assert.deepEqual(links.map(fileNameOf), [
    'VergSaetzeAug26bisDez26.xlsx',
    'VergSaetzeFeb26bisJul26.xlsx',
    'VergSaetzeAug25bisJan26.xlsx',
    'VergSaetzeFebbisJul25.xlsx',
    'VergSaetzeAug24bisJan25.xlsx',
    'VergSaetzeFeb_bis_Juli2024.xlsx',
    'DegressionsVergSaetze1122bis0124.xlsx',
  ]);
  assert.ok(links.every((url) => !/Wind/i.test(url)));
  assert.deepEqual(links, expected.archiveLinks);
});

test('Linkfilter: Zeitraum-Ende aus dem Dateinamen, Grenze 11/2022; unbekanntes Schema wird geladen', () => {
  const cases = {
    'VergSaetzeAug26bisDez26.xlsx': [2026, 12, true],
    'VergSaetzeFeb_bis_Juli2024.xlsx': [2024, 7, true],
    'DegressionsVergSaetze1122bis0124.xlsx': [2024, 1, true],
    // gerundete Teil-/Volleinspeisungs-Zeilen gibt es darin nicht (geprüft 19.11.2026)
    'DegressionsVergSaetze_08bis1022.xlsx': [2022, 10, false],
    'DegressionsVergSaetzeAugbisOkt22EEGNovelle.xlsx': [2022, 10, false],
    'DegressionsVergSaetze_05bis0722.xlsx': [2022, 7, false],
    'DegressionsVergSaetze_01121bis0122.xlsx': [2022, 1, false],
    'DegressionsVergSaetze_11-01_21.xlsx': [2021, 1, false],
    'DegressionsVergSaetze_Feb18-April18.xlsx': [2018, 4, false],
    'DegressionsVergSaetze_Aug-Okt2017.xlsx': [2017, 10, false],
  };
  for (const [name, [year, month, evaluated]] of Object.entries(cases)) {
    assert.deepEqual(publicationPeriodEnd(name), { year, month }, name);
    assert.equal(isEvaluatedPublication(name), evaluated, name);
  }
  // Wind-Ausschreibungen tragen „VergSaetze“ nur im Pfad, nicht im Dateinamen.
  assert.equal(isEvaluatedPublication('EE_Foerderung_Wind_10_2018.xlsx'), false);
  // Neues, unbekanntes Namensschema → lieber laden als einen Monat verlieren.
  assert.equal(publicationPeriodEnd('VergSaetze_2027_Teil1.xlsx'), null);
  assert.equal(isEvaluatedPublication('VergSaetze_2027_Teil1.xlsx'), true);
  assert.equal(isEvaluatedPublication('VergSaetzeFeb27bisJul27.xlsx'), true);
  assert.equal(isEvaluatedPublication('VergSaetzeFeb27bisJul27.pdf'), false);
});

// ── Abruf von dvhub.online ───────────────────────────────────────────────────

test('dvhub.online: GET /v1/pv/eeg-applicable-values, Prüfsumme stimmt, Format wie der Cache', async () => {
  assert.equal(CENTRAL_APPLICABLE_VALUES_PATH, '/v1/pv/eeg-applicable-values');
  const central = fakeCentral();
  const data = await fetchCentralApplicableValueReferenceData({ baseUrl: `${BASE}/`, fetchImpl: central.fetchImpl });
  assert.equal(central.calls[0].url, 'https://dvhub.online/v1/pv/eeg-applicable-values');
  assert.equal(central.calls[0].opts.headers.accept, 'application/json');
  assert.equal(data.via, 'dvhub_online');
  assert.equal(data.updatedAt, '2026-11-19T05:40:00.000Z');
  assert.equal(data.checksum, EXPECTED_CHECKSUM);
  assert.equal(data.publications.length, 2);
  assert.deepEqual(data.applicableValueTiersByMonth, expected.applicableValueTiersByMonth);
  assert.deepEqual(data.fullFeedApplicableValueTiersByMonth, expected.fullFeedApplicableValueTiersByMonth);
});

test('dvhub.online: falsche Prüfsumme, fehlende Prüfsumme, leer oder HTTP-Fehler → abgelehnt', async () => {
  const tampered = centralBody();
  tampered.applicableValueTiersByMonth['2026-01'][0].ctKwh = 9.26;
  await assert.rejects(fetchCentralApplicableValueReferenceData({ baseUrl: BASE, fetchImpl: fakeCentral({ body: tampered }).fetchImpl }), /Prüfsumme/);
  await assert.rejects(fetchCentralApplicableValueReferenceData({ baseUrl: BASE, fetchImpl: fakeCentral({ body: centralBody({ checksum: undefined }) }).fetchImpl }), /Prüfsumme/);
  const empty = centralBody({ applicableValueTiersByMonth: {}, fullFeedApplicableValueTiersByMonth: {} });
  empty.checksum = applicableValueChecksum(empty);
  await assert.rejects(fetchCentralApplicableValueReferenceData({ baseUrl: BASE, fetchImpl: fakeCentral({ body: empty }).fetchImpl }), /keine Werte/);
  await assert.rejects(fetchCentralApplicableValueReferenceData({ baseUrl: BASE, fetchImpl: fakeCentral({ status: 503 }).fetchImpl }), /HTTP 503/);
});

// ── Quelle, Rückfall, Prüfsumme im Dienst ────────────────────────────────────

test('Quelle DVhub: holt bei dvhub.online, nicht bei der BNetzA; Stand und Prüfsumme im Cache', async () => {
  const r = rig();
  await r.service.tick();
  assert.equal(r.central.calls.length, 1);
  assert.equal(r.state.directCalls, 0);
  const st = r.service.getStatus();
  assert.equal(st.via, 'dvhub_online');
  assert.equal(st.updatedAt, '2026-11-19T05:40:00.000Z');
  assert.equal(st.checksum, EXPECTED_CHECKSUM);
  assert.deepEqual(st.months, { first: '2022-07', last: '2026-12', count: 54, fullFeedCount: 54 });
  assert.equal(st.lastAttemptOk, true);
  const persisted = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(persisted.via, 'dvhub_online');
  assert.equal(persisted.checksum, EXPECTED_CHECKSUM);
  // 29,7 kWp, IBN 01/2026: (10 × 8,26 + 19,7 × 7,20) / 29,7 = 7,557 → 7,56 ct/kWh
  const summary = r.service.getApplicableValueSummary({ year: 2026, pvPlants: PLANTS });
  assert.equal(summary.getApplicableValueCtKwh({ commissionedAt: '2026-01-15', kwp: 29.7 }), 7.56);
  assert.deepEqual(events(r), ['applicable_value_refresh_ok:info']);
});

test('Quelle Direkt: kein Kontakt zu dvhub.online, Werte von der BNetzA', async () => {
  const r = rig({ source: 'public' });
  await r.service.tick();
  assert.equal(r.central.calls.length, 0);
  assert.equal(r.state.directCalls, 1);
  assert.equal(r.service.getStatus().via, 'bundesnetzagentur');
  assert.equal(r.service.getStatus().checksum, EXPECTED_CHECKSUM);
});

test('Rückfall: dvhub.online nicht erreichbar (503 / Netzfehler) → direkt bei der BNetzA, Warnung', async () => {
  for (const central of [fakeCentral({ status: 503 }), fakeCentral({ throws: new Error('getaddrinfo ENOTFOUND dvhub.online') })]) {
    const r = rig({ central });
    await r.service.tick();
    assert.equal(r.central.calls.length, 1);
    assert.equal(r.state.directCalls, 1);
    assert.equal(r.service.getStatus().via, 'bundesnetzagentur');
    assert.deepEqual(events(r), ['applicable_value_central_fallback:warn', 'applicable_value_refresh_ok:info']);
  }
});

test('Prüfsumme falsch → Stand verworfen, Rückfall; scheitert auch die BNetzA, bleibt der Cache unverändert', async () => {
  const tampered = centralBody();
  tampered.fullFeedApplicableValueTiersByMonth['2025-05'][0].ctKwh = 14;
  const old = legacyCache('2026-11-01T08:00:00.000Z');   // 18 Tage alt → fällig
  const r = rig({ central: fakeCentral({ body: tampered }), cache: old });
  await r.service.tick();
  assert.equal(r.state.directCalls, 1);
  assert.equal(r.service.getStatus().via, 'bundesnetzagentur');
  assert.notEqual(r.service.getApplicableValueSummary({ pvPlants: PLANTS }).getApplicableValueCtKwh({ commissionedAt: '2025-05-01', kwp: 5, feedType: 'full' }), 14);
  assert.match(r.state.logs[0].details.error, /Prüfsumme/);

  const r2 = rig({ central: fakeCentral({ body: tampered }), cache: old, direct: async () => { throw new Error('Bundesnetzagentur archive request failed: HTTP 404'); } });
  const before = fs.readFileSync(r2.file, 'utf8');
  await r2.service.tick();
  const after = JSON.parse(fs.readFileSync(r2.file, 'utf8'));
  assert.deepEqual(after.applicableValueTiersByMonth, JSON.parse(before).applicableValueTiersByMonth);
  assert.equal(after.updatedAt, '2026-11-01T08:00:00.000Z');
  assert.equal(r2.service.getApplicableValueSummary({ pvPlants: PLANTS }).getApplicableValueCtKwh({ commissionedAt: '2025-05-01', kwp: 5, feedType: 'full' }), 13);
  assert.deepEqual(events(r2), ['applicable_value_central_fallback:warn', 'applicable_value_refresh_stale:warn']);
});

function shorterCentral() {
  const shorter = centralBody();
  delete shorter.applicableValueTiersByMonth['2026-12'];
  delete shorter.fullFeedApplicableValueTiersByMonth['2026-12'];
  shorter.checksum = applicableValueChecksum(shorter);
  return fakeCentral({ body: shorter });
}

test('Monate verloren gegenüber dem Cache, Cache fällig → zentraler Stand verworfen, Rückfall direkt', async () => {
  const r = rig({ central: shorterCentral(), cache: legacyCache('2026-11-01T08:00:00.000Z') });
  await r.service.tick();
  assert.equal(r.state.directCalls, 1);
  assert.equal(r.service.getStatus().months.last, '2026-12');
  assert.equal(r.service.getStatus().via, 'bundesnetzagentur');
  assert.equal(r.service.getStatus().lastSuccessAt, '2026-11-19T12:00:00.000Z');
  assert.deepEqual(events(r), ['applicable_value_central_fallback:warn', 'applicable_value_refresh_ok:info']);
  assert.match(r.state.logs[0].details.error, /älterer Stand.*2026-12/);
});

test('Monate verloren, Cache frisch → Cache bleibt; der Wochenabruf wird dadurch nicht verschoben (Codex ead6ef31)', async () => {
  // Cache direkt geholt, 2 Tage alt; dvhub.online ist einen Monat hinterher.
  const r = rig({ central: shorterCentral(), cache: legacyCache('2026-11-17T12:00:00.000Z') });
  await r.service.tick();
  assert.equal(r.state.directCalls, 0);
  assert.equal(r.service.getStatus().months.last, '2026-12');
  assert.equal(r.service.getStatus().lastSuccessAt, '2026-11-17T12:00:00.000Z');
  assert.deepEqual(events(r), ['applicable_value_refresh_stale:warn']);
  // alle 6 h dvhub.online, Erfolgszeit bleibt → spätestens nach einer Woche direkt
  for (let i = 0; i < 24; i++) { r.advance(6 * 3600_000); await r.service.tick(); }
  assert.ok(r.state.directCalls >= 1, 'Wochenabruf direkt bei der BNetzA');
  assert.equal(r.service.getStatus().via, 'bundesnetzagentur');
  assert.ok(Date.parse(r.service.getStatus().lastSuccessAt) > Date.parse('2026-11-24T00:00:00.000Z'));
});

// ── Bedarf ───────────────────────────────────────────────────────────────────

test('Bedarf: nur mit PV-Anlage (kWp + Inbetriebnahme) — sonst kein Abruf, auch nicht über die Historie', async () => {
  assert.equal(applicableValuesNeeded({ userEnergyPricing: { pvPlants: PLANTS } }), true);
  assert.equal(applicableValuesNeeded({ userEnergyPricing: { pvPlants: [] } }), false);
  assert.equal(applicableValuesNeeded({ userEnergyPricing: { pvPlants: [{ kwp: 10 }] } }), false);
  assert.equal(applicableValuesNeeded({ userEnergyPricing: { pvPlants: [{ kwp: 0, commissionedAt: '2024-01-01' }] } }), false);
  assert.equal(applicableValuesNeeded({}), false);
  const r = rig({ plants: [] });
  await r.service.tick();
  r.service.getApplicableValueSummary({ year: 2026, pvPlants: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.central.calls.length, 0);
  assert.equal(r.state.directCalls, 0);
  assert.equal(r.service.getStatus().needed, false);
  r.state.plants = PLANTS;
  await r.service.tick();
  assert.equal(r.central.calls.length, 1);
});

// ── Auffrischung ─────────────────────────────────────────────────────────────

test('Auffrischung: wöchentlich ohne Neustart; dazwischen kein Abruf', async () => {
  assert.equal(APPLICABLE_VALUE_REFRESH_MS, 7 * 24 * 3600_000);
  const r = rig();
  await r.service.tick();
  r.advance(3 * 24 * 3600_000);
  await r.service.tick();
  assert.equal(r.central.calls.length, 1);
  r.advance(4 * 24 * 3600_000);
  await r.service.tick();
  assert.equal(r.central.calls.length, 2);
});

test('Auffrischung nach Fehlschlag: Pause 6 h (mit Cache), dann neuer Versuch', async () => {
  assert.equal(APPLICABLE_VALUE_RETRY_MS, 6 * 3600_000);
  const r = rig({ central: fakeCentral({ status: 503 }), direct: async () => { throw new Error('HTTP 404'); }, cache: legacyCache('2026-11-01T08:00:00.000Z') });
  await r.service.tick();
  assert.equal(r.central.calls.length, 1);
  r.advance(3600_000);
  await r.service.tick();
  assert.equal(r.central.calls.length, 1);
  r.advance(5 * 3600_000);
  await r.service.tick();
  assert.equal(r.central.calls.length, 2);
  assert.equal(r.state.directCalls, 2);
});

test('Bestandscache von früher (direkt geholt, 2 Tage alt) → einmal dvhub.online, kein BNetzA-Abruf als Rückfall', async () => {
  const r = rig({ central: fakeCentral({ status: 503 }), cache: legacyCache('2026-11-17T08:00:00.000Z') });
  await r.service.tick();
  assert.equal(r.central.calls.length, 1);
  assert.equal(r.state.directCalls, 0);
  assert.deepEqual(events(r), ['applicable_value_refresh_stale:warn']);
  // erst nach 6 h wieder dvhub.online
  r.advance(30 * 60_000);
  await r.service.tick();
  assert.equal(r.central.calls.length, 1);
  r.advance(6 * 3600_000);
  await r.service.tick();
  assert.equal(r.central.calls.length, 2);
});

test('Quelle umgestellt → sofort neu holen (auch nach frischem Abruf)', async () => {
  const r = rig();
  await r.service.tick();
  r.state.source = 'public';
  r.advance(15 * 60_000);
  await r.service.tick();
  assert.equal(r.state.directCalls, 1);
  assert.equal(r.service.getStatus().via, 'bundesnetzagentur');
  r.state.source = 'dvhub';
  r.advance(15 * 60_000);
  await r.service.tick();
  assert.equal(r.central.calls.length, 2);
  assert.equal(r.service.getStatus().via, 'dvhub_online');
});

test('Gleichzeitige Takte → ein Abruf', async () => {
  const r = rig();
  await Promise.all([r.service.tick(), r.service.tick(), r.service.tick()]);
  assert.equal(r.central.calls.length, 1);
});

test('Neue Inbetriebnahme nach dem letzten Monat → einmal nachfragen, höchstens alle 6 h', async () => {
  const r = rig();
  await r.service.tick();
  const plants = [{ kwp: 8, commissionedAt: '2027-02-10' }];
  r.service.getApplicableValueSummary({ year: 2027, pvPlants: plants });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(r.central.calls.length, 1);   // eben erst geholt → Pause
  r.advance(6 * 3600_000);
  r.service.getApplicableValueSummary({ year: 2027, pvPlants: plants });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(r.central.calls.length, 2);
  r.service.getApplicableValueSummary({ year: 2027, pvPlants: plants });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(r.central.calls.length, 2);
  // Ältere Jahre ohne Werte (vor 07/2022) lösen keinen Abruf aus.
  r.advance(7 * 3600_000);
  r.service.getApplicableValueSummary({ year: 2021, pvPlants: [{ kwp: 5, commissionedAt: '2021-04-01' }, ...PLANTS] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(r.central.calls.length, 2);
});

test('Neue Inbetriebnahme, dvhub.online nicht erreichbar → Rückfall direkt, obwohl der Cache frisch ist (Codex ead6ef31)', async () => {
  const r = rig({ central: fakeCentral({ status: 503 }), cache: legacyCache('2026-11-19T00:00:00.000Z') });
  // Cache von heute (direkt), also nur die Bevorzugung von dvhub.online offen → kein Rückfall.
  await r.service.tick();
  assert.equal(r.state.directCalls, 0);
  r.advance(6 * 3600_000);
  r.service.getApplicableValueSummary({ year: 2027, pvPlants: [{ kwp: 8, commissionedAt: '2027-02-10' }] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(r.state.directCalls, 1);
});

test('Takt ohne Historie-Aufruf erkennt eine neue Inbetriebnahme aus der Config (getPvPlants, Codex ead6ef31)', async () => {
  const r = rig();
  await r.service.tick();
  r.state.plants = [...PLANTS, { kwp: 8, commissionedAt: '2027-02-10' }];
  r.advance(6 * 3600_000);
  await r.service.tick();
  assert.equal(r.central.calls.length, 2);
});

// Codex 2bd0bf21 (P2): dvhub.online liefert einen gültigen Stand, dem der Monat einer
// eingetragenen Anlage noch fehlt (Server hinter einer neuen Veröffentlichung). Bisher
// nahm die Box ihn an und fragte nie direkt nach — die Anlage blieb ohne Wert.
function directDataWith(...months) {
  const data = directData();
  for (const month of months) {
    data.applicableValueTiersByMonth[month] = JSON.parse(JSON.stringify(expected.applicableValueTiersByMonth['2026-12']));
    data.fullFeedApplicableValueTiersByMonth[month] = JSON.parse(JSON.stringify(expected.fullFeedApplicableValueTiersByMonth['2026-12']));
  }
  return data;
}

test('dvhub.online ohne den Monat der Anlage → zusätzlich direkt nachsehen; reicht die BNetzA weiter, gilt ihr Stand (Codex 2bd0bf21)', async () => {
  const plants = [...PLANTS, { kwp: 8, commissionedAt: '2027-02-10' }];
  const r = rig({ plants, direct: async () => directDataWith('2027-01', '2027-02') });
  await r.service.tick();
  assert.equal(r.central.calls.length, 1);
  assert.equal(r.state.directCalls, 1);
  const saved = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.ok(saved.applicableValueTiersByMonth['2027-02'], 'Monat der Anlage ist jetzt da');
  assert.ok(saved.fullFeedApplicableValueTiersByMonth['2027-02']);
  assert.equal(saved.via, 'bundesnetzagentur');
  assert.deepEqual(events(r).filter((e) => e.startsWith('applicable_value_central_incomplete')), ['applicable_value_central_incomplete:warn']);
});

test('dvhub.online ohne den Monat, BNetzA auch nicht → zentraler Stand bleibt; direkt höchstens einmal am Tag (Codex 2bd0bf21)', async () => {
  const plants = [...PLANTS, { kwp: 8, commissionedAt: '2027-02-10' }];
  const r = rig({ plants });
  await r.service.tick();
  assert.equal(r.state.directCalls, 1);
  const saved = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(saved.via, 'dvhub_online');
  assert.equal(Object.keys(saved.applicableValueTiersByMonth).sort().at(-1), '2026-12');
  // alle 6 h fragt die Box dvhub.online erneut, die BNetzA aber nicht
  r.advance(6 * 3600_000);
  await r.service.tick();
  r.advance(6 * 3600_000);
  await r.service.tick();
  assert.equal(r.central.calls.length, 3);
  assert.equal(r.state.directCalls, 1);
  // nach einem Tag einmal wieder
  r.advance(13 * 3600_000);
  await r.service.tick();
  assert.equal(r.central.calls.length, 4);
  assert.equal(r.state.directCalls, 2);
});

test('dvhub.online ohne den Monat, BNetzA scheitert → zentraler Stand bleibt, nur Warnung (Codex 2bd0bf21)', async () => {
  const plants = [...PLANTS, { kwp: 8, commissionedAt: '2027-02-10' }];
  const r = rig({ plants, direct: async () => { throw new Error('HTTP 404'); } });
  await r.service.tick();
  const saved = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(saved.via, 'dvhub_online');
  assert.equal(saved.refreshState.lastAttemptOk, true);
  assert.ok(events(r).includes('applicable_value_direct_completion_failed:warn'));
  assert.ok(!events(r).some((e) => e.endsWith(':error')));
});

test('BNetzA reicht nur teilweise weiter (01/2027, Anlage braucht 02/2027) → Stand bleibt erweitert, direkt trotzdem nur einmal am Tag (Codex 6aac82b2)', async () => {
  const plants = [...PLANTS, { kwp: 8, commissionedAt: '2027-02-10' }];
  const r = rig({ plants, direct: async () => directDataWith('2027-01') });
  await r.service.tick();
  assert.equal(r.state.directCalls, 1);
  const lastMonth = () => Object.keys(JSON.parse(fs.readFileSync(r.file, 'utf8')).applicableValueTiersByMonth).sort().at(-1);
  assert.equal(lastMonth(), '2027-01');
  // dvhub.online endet weiter bei 12/2026 und wird abgelehnt — aber kein neuer BNetzA-Abruf
  for (let i = 0; i < 3; i += 1) {
    r.advance(6 * 3600_000);
    await r.service.tick();
  }
  assert.equal(r.state.directCalls, 1);
  assert.equal(lastMonth(), '2027-01');
  assert.ok(!events(r).some((e) => e.endsWith(':error')));
  // nach einem Tag einmal wieder
  r.advance(7 * 3600_000);
  await r.service.tick();
  assert.equal(r.state.directCalls, 2);
});

test('dvhub.online deckt alle Anlagen ab → kein zusätzlicher BNetzA-Abruf', async () => {
  const r = rig();
  await r.service.tick();
  assert.equal(r.state.directCalls, 0);
});

// ── Log-Stufen ───────────────────────────────────────────────────────────────

test('Log: Fehlschlag ohne Cache mit PV-Anlage = error; mit gültigem Cache nur warn', async () => {
  const fail = { central: fakeCentral({ status: 503 }), direct: async () => { throw new Error('HTTP 404'); } };
  const r = rig(fail);
  await r.service.tick();
  assert.deepEqual(events(r), ['applicable_value_central_fallback:warn', 'applicable_value_refresh_error:error']);
  assert.equal(r.service.getStatus().lastAttemptOk, false);
  const r2 = rig({ ...fail, cache: legacyCache('2026-11-01T08:00:00.000Z') });
  await r2.service.tick();
  assert.deepEqual(events(r2), ['applicable_value_central_fallback:warn', 'applicable_value_refresh_stale:warn']);
  assert.ok(!r2.state.logs.some((l) => l.level === 'error'));
  // Direkt-Quelle ohne Cache: genauso error
  const r3 = rig({ source: 'public', direct: fail.direct });
  await r3.service.tick();
  assert.deepEqual(events(r3), ['applicable_value_refresh_error:error']);
});

// ── Zwei Prozesse ────────────────────────────────────────────────────────────

test('Web-Prozess (ohne Abruf) liest den vom Laufzeit-Prozess geschriebenen Cache nach', async () => {
  const owner = rig();
  const reader = rig({ cachePath: owner.file, ownsRefresh: false });
  assert.equal(reader.service.getStatus().months.count, 0);
  await owner.service.tick();
  reader.advance(60_000);
  assert.equal(reader.service.getStatus().via, 'dvhub_online');
  assert.equal(reader.service.getApplicableValueSummary({ pvPlants: PLANTS }).getApplicableValueCtKwh({ commissionedAt: '2026-01-15', kwp: 29.7 }), 7.56);
  await reader.service.tick();
  assert.equal(reader.central.calls.length, 0);
});

// ── Einstellung ──────────────────────────────────────────────────────────────

test('Einstellung referenceData.applicableValueSource: Preise → Marktprämie, Standard DVhub', () => {
  const field = getConfigDefinition().fields.find((f) => f.path === 'referenceData.applicableValueSource');
  assert.ok(field);
  assert.equal(field.section, 'pricing');
  assert.equal(field.group, 'marketPremium');
  assert.equal(field.type, 'select');
  assert.equal(field.default, 'dvhub');
  assert.deepEqual(field.options.map((o) => [o.value, o.label]), [['dvhub', 'DVhub (dvhub.online)'], ['public', 'Direkt von der Bundesnetzagentur']]);
  assert.equal(createDefaultConfig().referenceData.applicableValueSource, 'dvhub');
  assert.equal(normalizeConfigInput({}).effectiveConfig.referenceData.applicableValueSource, 'dvhub');
  assert.equal(normalizeConfigInput({ referenceData: { applicableValueSource: 'public' } }).effectiveConfig.referenceData.applicableValueSource, 'public');
  const bad = normalizeConfigInput({ referenceData: { applicableValueSource: 'irgendwas' } });
  assert.equal(bad.effectiveConfig.referenceData.applicableValueSource, 'dvhub');
  assert.ok(bad.warnings.some((w) => w.startsWith('referenceData.applicableValueSource')));
});

test('Einstellung: wer die Börsenpreise ohne dvhub.online holt, bekommt ohne eigene Wahl auch die Werte direkt', () => {
  assert.equal(normalizeConfigInput({ epex: { priceSource: 'public' } }).effectiveConfig.referenceData.applicableValueSource, 'public');
  assert.equal(normalizeConfigInput({ epex: { priceSource: 'public' } }).rawConfig.referenceData.applicableValueSource, 'public');
  assert.equal(normalizeConfigInput({ epex: { priceSource: 'luox' } }).effectiveConfig.referenceData.applicableValueSource, 'dvhub');
  assert.equal(normalizeConfigInput({ epex: { priceSource: 'public' }, referenceData: { applicableValueSource: 'dvhub' } }).effectiveConfig.referenceData.applicableValueSource, 'dvhub');
  // Ohne öffentliche Preisquelle bleibt die Config, wie sie ist (kein neuer Schlüssel).
  assert.equal(normalizeConfigInput({ epex: { priceSource: 'dvhub' } }).rawConfig.referenceData, undefined);
});
