// test/price-outlook.test.js — Preisschwanz für EOS aus der Residuallast-
// Prognose von dvhub.online (Christin 12.11.2026, 1.0.11).
//
// Fixture: echte Antwort von GET https://dvhub.online/v1/residual-load/outlook
// vom 12.11.2026 (issued_at 2026-11-11T22:52:48Z, last_known_day 2026-11-12,
// 120 Stunden ab 2026-11-12T23:00Z = 13.11. 00:00 Ortszeit).

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseOutlook,
  outlookUsable,
  fillPriceSlotsFromOutlook,
  createPriceOutlookService,
  outlookFetchDue,
  nextScheduledFetchMs,
  outlookDisabledReason,
  buildPriceOutlookPayload,
  OUTLOOK_MAX_AGE_MS,
  OUTLOOK_RETRY_MS,
  OUTLOOK_PATH,
} from '../services/optimizer/price-outlook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/residual-load-outlook-2026-11-12.json'), 'utf8'));
const H = 3_600_000;
const Q = 15 * 60_000;
const ISSUED = Date.parse('2026-11-11T22:52:48.852Z');
const FIRST = Date.parse('2026-11-12T23:00:00Z');

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Echte 15-min-Preise von `fromMs` bis `toMs` (exklusiv), konstant `ct`. */
function realSlots(fromMs, toMs, ct = 20, stepMs = Q) {
  const out = [];
  for (let ms = fromMs; ms < toMs; ms += stepMs) out.push({ start: new Date(ms).toISOString(), end: new Date(ms + stepMs).toISOString(), ctKwh: ct });
  return out;
}

// ── Antwortform (echte Antwort als Fixture) ─────────────────────────────────

test('parseOutlook: echte Antwort von dvhub.online wird angenommen', () => {
  const r = parseOutlook(FIXTURE);
  assert.equal(r.ok, true);
  const o = r.outlook;
  assert.equal(o.biddingZone, 'DE-LU');
  assert.equal(o.issuedMs, ISSUED);
  assert.equal(o.lastKnownDay, '2026-11-12');
  assert.equal(o.modelVersion, 'rl-1.1.0');
  assert.equal(o.hours.length, 120);
  assert.equal(o.hours[0].ms, FIRST);
  assert.equal(o.hours[0].p50, 135.5);
  assert.equal(o.hours[0].p10, 104.7);
  assert.equal(o.hours[0].p90, 174.4);
  assert.equal(o.hours[0].leadDays, 1);
  assert.equal(o.hours.at(-1).ms, FIRST + 119 * H);
});

test('parseOutlook: kaputte Antworten werden verworfen', () => {
  assert.equal(parseOutlook(null).ok, false);
  assert.equal(parseOutlook([]).ok, false);
  assert.equal(parseOutlook('x').ok, false);
  const noHours = clone(FIXTURE); delete noHours.hours;
  assert.deepEqual(parseOutlook(noHours), { ok: false, reason: 'invalid' });
  const emptyHours = clone(FIXTURE); emptyHours.hours = [];
  assert.deepEqual(parseOutlook(emptyHours), { ok: false, reason: 'empty' });
  const noIssued = clone(FIXTURE); delete noIssued.issued_at;
  assert.equal(parseOutlook(noIssued).ok, false);
  const schema2 = clone(FIXTURE); schema2.schema_version = 2;
  assert.deepEqual(parseOutlook(schema2), { ok: false, reason: 'schema' });
  // Ungültige Stunden fallen heraus (Lücke), unplausible Preise ebenso.
  const bad = clone(FIXTURE);
  bad.hours[3].price_eur_mwh.p50 = 'abc';
  bad.hours[4].price_eur_mwh.p50 = 50_000;
  bad.hours[5].ts = '2026-11-13T04:30:00Z'; // keine volle Stunde
  const r = parseOutlook(bad);
  assert.equal(r.ok, true);
  assert.equal(r.outlook.hours.length, 117);
  // Band, das P50 nicht einschließt: kein Band.
  const band = clone(FIXTURE); band.hours[0].price_eur_mwh.p10 = 200;
  assert.equal(parseOutlook(band).outlook.hours[0].p10, null);
  assert.equal(parseOutlook(band).outlook.hours[0].p90, null);
});

test('parseOutlook: neue Felder stören nicht (abwärtskompatibel)', () => {
  const more = clone(FIXTURE);
  more.live_score = { leads: {} };
  more.hours[0].actual_eur_mwh = 140;
  more.known_days = [{ date: '2026-11-12' }];
  assert.equal(parseOutlook(more).ok, true);
});

test('outlookUsable: Zone, Höchstalter 48 h, abgelaufen, Ausgabe in der Zukunft', () => {
  const o = parseOutlook(FIXTURE).outlook;
  assert.deepEqual(outlookUsable(o, { nowMs: ISSUED + H }), { ok: true, reason: null });
  assert.deepEqual(outlookUsable(o, { nowMs: ISSUED + OUTLOOK_MAX_AGE_MS }), { ok: true, reason: null });
  assert.deepEqual(outlookUsable(o, { nowMs: ISSUED + OUTLOOK_MAX_AGE_MS + 1 }), { ok: false, reason: 'too_old' });
  assert.equal(OUTLOOK_MAX_AGE_MS, 48 * H);
  assert.deepEqual(outlookUsable({ ...o, biddingZone: 'AT' }, { nowMs: ISSUED + H }), { ok: false, reason: 'zone' });
  assert.deepEqual(outlookUsable(o, { nowMs: ISSUED - 2 * H }), { ok: false, reason: 'future' });
  // Alle Stunden vorbei (bei großzügigem Höchstalter).
  assert.deepEqual(outlookUsable(o, { nowMs: FIRST + 120 * H, maxAgeMs: 30 * 86_400_000 }), { ok: false, reason: 'expired' });
  assert.deepEqual(outlookUsable(null), { ok: false, reason: 'none' });
});

// ── Schwanz an den echten Preisen ───────────────────────────────────────────

test('Schwanz: beginnt am Ende der echten Preise, P50 ÷ 10 = ct/kWh, Stundenwert je Viertelstunde', () => {
  const o = parseOutlook(FIXTURE).outlook;
  const now = Date.parse('2026-11-12T09:07:00Z');
  const real = realSlots(Date.parse('2026-11-11T23:00:00Z'), FIRST);
  const r = fillPriceSlotsFromOutlook(real, { outlook: o, untilMs: now + 72 * H, nowMs: now });
  assert.equal(r.reason, null);
  const added = r.slots.slice(real.length);
  assert.equal(added[0].start, new Date(FIRST).toISOString());
  assert.equal(added.length, r.estimate.estimatedSlots);
  // Viertelstunden der ersten Stunde tragen alle den Stundenwert 135,5 €/MWh.
  for (let k = 0; k < 4; k += 1) {
    assert.equal(added[k].ctKwh, 13.55);
    assert.equal(added[k].estimated, true);
    assert.equal(added[k].priceSource, 'residual_load');
    assert.equal(added[k].p10CtKwh, 10.47);
    assert.equal(added[k].p90CtKwh, 17.44);
  }
  assert.equal(added[4].ctKwh, 11.15); // 01:00 Ortszeit: 111,5 €/MWh
  // Bis untilMs (auf die Viertelstunde), echte Slots unverändert.
  assert.equal(Date.parse(r.estimate.until), FIRST + Math.ceil((now + 72 * H - FIRST) / Q) * Q);
  assert.deepEqual(r.slots.slice(0, real.length), real);
  assert.equal(r.estimate.method, 'residual_load_p50');
  assert.equal(r.estimate.issuedAt, new Date(ISSUED).toISOString());
  assert.equal(r.estimate.lastKnownDay, '2026-11-12');
});

test('Schwanz: echte Day-Ahead-Preise haben Vorrang — Prognose-Stunden darunter werden übersprungen', () => {
  const o = parseOutlook(FIXTURE).outlook;
  // Nach 13 Uhr: echte Preise für den 13.11. sind da (bis 13.11. 23:00Z),
  // die Prognose (Ausgabe vom Vorabend) beginnt aber schon am 13.11.
  const now = Date.parse('2026-11-12T13:30:00Z');
  const realEnd = FIRST + 24 * H;
  const real = realSlots(Date.parse('2026-11-11T23:00:00Z'), realEnd, 99);
  const r = fillPriceSlotsFromOutlook(real, { outlook: o, untilMs: now + 72 * H, nowMs: now });
  const added = r.slots.slice(real.length);
  assert.equal(added[0].start, new Date(realEnd).toISOString());
  assert.equal(added[0].ctKwh, o.hours[24].p50 / 10);
  assert.ok(r.slots.slice(0, real.length).every((s) => s.ctKwh === 99 && !s.estimated));
});

test('Schwanz: Stundenpreise (60 min) → Schwanz stündlich', () => {
  const o = parseOutlook(FIXTURE).outlook;
  const now = Date.parse('2026-11-12T09:00:00Z');
  const real = realSlots(Date.parse('2026-11-11T23:00:00Z'), FIRST, 20, H);
  const r = fillPriceSlotsFromOutlook(real, { outlook: o, untilMs: FIRST + 10 * H, nowMs: now });
  const added = r.slots.slice(real.length);
  assert.equal(added.length, 10);
  assert.equal(Date.parse(added[1].start) - Date.parse(added[0].start), H);
  assert.equal(added[0].ctKwh, 13.55);
});

test('Schwanz: Lücke in der Prognose → endet davor; beginnt die Prognose erst nach den echten Preisen → kein Schwanz', () => {
  const o = parseOutlook(FIXTURE).outlook;
  const now = Date.parse('2026-11-12T09:00:00Z');
  const real = realSlots(Date.parse('2026-11-11T23:00:00Z'), FIRST);
  const holey = { ...o, hours: o.hours.filter((h) => h.ms !== FIRST + 5 * H) };
  const r = fillPriceSlotsFromOutlook(real, { outlook: holey, untilMs: now + 72 * H, nowMs: now });
  assert.equal(r.estimate.estimatedSlots, 5 * 4, 'nur die 5 Stunden vor der Lücke');
  // Echte Preise enden einen Tag früher als die Prognose beginnt.
  const early = realSlots(Date.parse('2026-11-11T23:00:00Z'), FIRST - 10 * H);
  const g = fillPriceSlotsFromOutlook(early, { outlook: o, untilMs: now + 72 * H, nowMs: now });
  assert.equal(g.estimate, null);
  assert.equal(g.reason, 'gap');
  assert.equal(g.slots, early);
});

test('Schwanz: wie bisher nur hinter echten Preisen, die jetzt + 1 h 15 min decken', () => {
  const o = parseOutlook(FIXTURE).outlook;
  const real = realSlots(FIRST - 10 * H, FIRST);
  const r = fillPriceSlotsFromOutlook(real, { outlook: o, untilMs: FIRST + 48 * H, nowMs: FIRST - 60 * 60_000 });
  assert.equal(r.estimate, null);
  assert.equal(r.reason, 'real_prices_short');
  assert.equal(fillPriceSlotsFromOutlook([], { outlook: o, untilMs: FIRST + 48 * H, nowMs: FIRST - 5 * H }).reason, 'no_real_prices');
  assert.equal(fillPriceSlotsFromOutlook(real, { outlook: null, untilMs: FIRST + 48 * H, nowMs: FIRST - 5 * H }).reason, 'no_outlook');
  assert.equal(fillPriceSlotsFromOutlook(real, { outlook: o, untilMs: FIRST, nowMs: FIRST - 5 * H }).reason, 'covered');
});

test('Schwanz an Zeitumstellungstagen: 25.10.2026 hat 25 Ortsstunden = 100 Viertelstunden, 29.03.2026 hat 23 = 92', () => {
  for (const [day, utcMidnight, nextUtcMidnight, quarters] of [
    // 25.10.2026 00:00 MESZ = 24.10. 22:00Z, 26.10. 00:00 MEZ = 25.10. 23:00Z
    ['2026-10-25', Date.parse('2026-10-24T22:00:00Z'), Date.parse('2026-10-25T23:00:00Z'), 100],
    // 29.03.2026 00:00 MEZ = 28.03. 23:00Z, 30.03. 00:00 MESZ = 29.03. 22:00Z
    ['2026-03-29', Date.parse('2026-03-28T23:00:00Z'), Date.parse('2026-03-29T22:00:00Z'), 92],
  ]) {
    // Prognose stündlich in UTC, Preis = Stunde UTC (zum Nachprüfen).
    const hours = [];
    for (let ms = utcMidnight; ms < nextUtcMidnight + 24 * H; ms += H) hours.push({ ms, p10: null, p50: new Date(ms).getUTCHours() * 10, p90: null, leadDays: 1 });
    const outlook = { issuedAt: new Date(utcMidnight - 10 * H).toISOString(), issuedMs: utcMidnight - 10 * H, biddingZone: 'DE-LU', hours };
    const now = utcMidnight - 8 * H;
    const real = realSlots(now - 2 * H, utcMidnight);
    const r = fillPriceSlotsFromOutlook(real, { outlook, untilMs: nextUtcMidnight, nowMs: now });
    const added = r.slots.slice(real.length);
    assert.equal(added.length, quarters, day);
    // Jede Viertelstunde trägt den Wert ihrer UTC-Stunde — auch in der doppelten bzw. fehlenden Ortsstunde.
    for (const s of added) assert.equal(s.ctKwh, new Date(s.start).getUTCHours(), `${day} ${s.start}`);
    // Lückenlos.
    for (let i = 1; i < added.length; i += 1) assert.equal(Date.parse(added[i].start) - Date.parse(added[i - 1].start), Q);
  }
});

// ── Abruf, Speicher, Rückfall ───────────────────────────────────────────────

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-outlook-'));
  return path.join(dir, 'price_outlook_cache.json');
}

function fetchStub(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    if (typeof next === 'string') return { ok: true, status: 200, text: async () => next };
    if (next && next.status && next.status !== 200) return { ok: false, status: next.status, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  };
  impl.calls = calls;
  return impl;
}

const cfgDe = { epex: { enabled: true, bzn: 'DE-LU', priceSource: 'dvhub', priceApiUrl: 'https://dvhub.online' } };

test('Dienst: Abruf mit Frist und Kennung ohne persönliche Daten, gültige Prognose gilt „live“ und landet auf der Platte', async () => {
  const file = tmpFile();
  const now = ISSUED + 30 * 60_000;
  const fetchImpl = fetchStub([FIXTURE]);
  const svc = createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl, cacheFile: file, now: () => now, userAgent: 'DVhub/1.0.11 (price-outlook)' });
  assert.equal(await svc.ensureFresh(), true);
  assert.equal(fetchImpl.calls[0].url, `https://dvhub.online${OUTLOOK_PATH}`);
  assert.equal(fetchImpl.calls[0].init.headers['user-agent'], 'DVhub/1.0.11 (price-outlook)');
  assert.ok(fetchImpl.calls[0].init.signal, 'Abruf mit Frist');
  const cur = svc.current(now);
  assert.equal(cur.status, 'live');
  assert.equal(cur.outlook.hours.length, 120);
  assert.ok(fs.existsSync(file));
  // Nicht fällig: kein zweiter Abruf.
  assert.equal(await svc.ensureFresh(), false);
  assert.equal(fetchImpl.calls.length, 1);
});

test('Rückfall 1: Abruf scheitert → letzte gültige Prognose weiter („gespeichert“), auch nach einem Neustart', async () => {
  const file = tmpFile();
  let now = ISSUED + H;
  const first = createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl: fetchStub([FIXTURE]), cacheFile: file, now: () => now });
  await first.ensureFresh();
  // Neustart, dvhub.online nicht erreichbar.
  now = ISSUED + 30 * H;
  const fetchImpl = fetchStub([new Error('ECONNREFUSED')]);
  const svc = createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl, cacheFile: file, now: () => now });
  assert.equal(svc.current(now).status, 'live', 'vor dem ersten Abruf: gespeicherte Prognose');
  assert.equal(await svc.ensureFresh(), false);
  const cur = svc.current(now);
  assert.equal(cur.status, 'cached');
  assert.equal(cur.reason, 'fetch_failed');
  assert.equal(cur.outlook.issuedMs, ISSUED);
  // Nach einem Fehlschlag erst nach OUTLOOK_RETRY_MS wieder fragen.
  assert.equal(await svc.ensureFresh(), false);
  assert.equal(fetchImpl.calls.length, 1);
  now += OUTLOOK_RETRY_MS;
  await svc.ensureFresh();
  assert.equal(fetchImpl.calls.length, 2);
});

test('Rückfall 2: gespeicherte Prognose älter als 48 h → nicht verfügbar „seit“ (Ablauf), übersteht einen Neustart', async () => {
  const file = tmpFile();
  let now = ISSUED + H;
  await createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl: fetchStub([FIXTURE]), cacheFile: file, now: () => now }).ensureFresh();
  now = ISSUED + OUTLOOK_MAX_AGE_MS + 5 * H;
  const svc = createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl: fetchStub([new Error('offline')]), cacheFile: file, now: () => now });
  await svc.ensureFresh();
  const cur = svc.current(now);
  assert.equal(cur.status, 'unavailable');
  assert.equal(cur.reason, 'too_old');
  assert.equal(cur.outlook, null);
  assert.equal(cur.unavailableSince, new Date(ISSUED + OUTLOOK_MAX_AGE_MS).toISOString());
  // Neustart: „seit“ bleibt.
  now += 2 * H;
  const again = createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl: fetchStub([new Error('offline')]), cacheFile: file, now: () => now });
  assert.equal(again.current(now).unavailableSince, new Date(ISSUED + OUTLOOK_MAX_AGE_MS).toISOString());
  // Neue Prognose kommt → wieder live, „seit“ gelöscht.
  const fresh = clone(FIXTURE); fresh.issued_at = new Date(now - 10 * 60_000).toISOString();
  const back = createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl: fetchStub([fresh]), cacheFile: file, now: () => now });
  await back.ensureFresh({ force: true });
  assert.equal(back.current(now).status, 'live');
  assert.equal(back.current(now).unavailableSince, null);
});

test('Rückfall: Server meldet stale:true → Prognose gilt nur als „gespeichert“ (bis 48 h)', async () => {
  const stale = clone(FIXTURE); stale.stale = true;
  const now = ISSUED + 20 * H;
  const svc = createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl: fetchStub([stale]), cacheFile: null, now: () => now });
  await svc.ensureFresh();
  const cur = svc.current(now);
  assert.equal(cur.status, 'cached');
  assert.equal(cur.reason, 'server_stale');
  assert.ok(cur.outlook);
});

test('Rückfall: kaputte Antwort (kein JSON, falsche Form, andere Zone, HTTP 503) ersetzt die gespeicherte Prognose nicht', async () => {
  for (const broken of ['<html>', { hours: 'x', issued_at: '2026-11-12T08:00:00Z', bidding_zone: 'DE-LU' }, { ...clone(FIXTURE), bidding_zone: 'AT' }, { status: 503 }]) {
    const file = tmpFile();
    let now = ISSUED + H;
    const svc = createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl: fetchStub([FIXTURE, broken]), cacheFile: file, now: () => now });
    await svc.ensureFresh();
    now += 4 * H;
    await svc.ensureFresh();
    const cur = svc.current(now);
    assert.equal(cur.status, 'cached', JSON.stringify(broken).slice(0, 40));
    assert.equal(cur.outlook.issuedMs, ISSUED);
    assert.ok(cur.lastError);
  }
});

test('Rückfall: eine ältere Ausgabe verdrängt keine neuere', async () => {
  const older = clone(FIXTURE); older.issued_at = new Date(ISSUED - 6 * H).toISOString();
  let now = ISSUED + H;
  const svc = createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl: fetchStub([FIXTURE, older]), cacheFile: null, now: () => now });
  await svc.ensureFresh();
  now += 4 * H;
  await svc.ensureFresh();
  assert.equal(svc.current(now).outlook.issuedMs, ISSUED);
  assert.equal(svc.current(now).status, 'live');
});

test('Andere Preiszone oder „Öffentlich (Energy-Charts)“: kein Abruf, Zustand „aus“ mit Grund', async () => {
  for (const [cfg, reason] of [
    [{ epex: { bzn: 'AT', priceSource: 'dvhub' } }, 'zone'],
    [{ epex: { bzn: 'NL' } }, 'zone'],
    [{ epex: { bzn: 'DE-LU', priceSource: 'public' } }, 'source_public'],
    [{ epex: { enabled: false } }, 'prices_off'],
  ]) {
    const fetchImpl = fetchStub([FIXTURE]);
    const svc = createPriceOutlookService({ getCfg: () => cfg, fetchImpl, cacheFile: null, now: () => ISSUED + H });
    assert.equal(await svc.ensureFresh({ force: true }), false);
    assert.equal(fetchImpl.calls.length, 0);
    const cur = svc.current(ISSUED + H);
    assert.equal(cur.status, 'off');
    assert.equal(cur.reason, reason);
    assert.equal(cur.outlook, null);
  }
  assert.equal(outlookDisabledReason({}), null, 'Standard: DE-LU über dvhub.online');
  assert.equal(outlookDisabledReason({ epex: { priceSource: 'luox' } }), null, 'LUOX fällt auf dvhub.online zurück');
});

// ── Eigener Schalter „Preisprognose von dvhub.online“ (Christin 12.11.2026) ──
// Unabhängig von der Preisquelle: „automatisch“ (auch: Feld fehlt) = an bei
// DVhub und LUOX, aus bei „Öffentlich“ — wie vor dem Schalter. „An“ geht auch
// mit „Öffentlich“, „Aus“ auch mit DVhub. Nur DE-LU bleibt Bedingung.
test('Schalter Preisprognose: an/aus unabhängig von der Preisquelle, Feld fehlt = wie bisher', async () => {
  const cases = [
    [{}, null, 'Feld fehlt, Quelle DVhub'],
    [{ epex: { priceSource: 'luox' } }, null, 'Feld fehlt, LUOX'],
    [{ epex: { priceSource: 'public' } }, 'source_public', 'Feld fehlt, Öffentlich'],
    [{ epex: { priceSource: 'public', priceOutlook: 'auto' } }, 'source_public', 'automatisch, Öffentlich'],
    [{ epex: { priceSource: 'public', priceOutlook: 'on' } }, null, 'an, Öffentlich'],
    [{ epex: { priceSource: 'public', priceOutlook: true } }, null, 'an (true), Öffentlich'],
    [{ epex: { priceSource: 'dvhub', priceOutlook: 'off' } }, 'switched_off', 'aus, DVhub'],
    [{ epex: { priceSource: 'luox', priceOutlook: false } }, 'switched_off', 'aus (false), LUOX'],
    [{ epex: { priceSource: 'dvhub', priceOutlook: 'quatsch' } }, null, 'unbekannt = automatisch'],
    [{ epex: { priceSource: 'public', priceOutlook: 'on', bzn: 'AT' } }, 'zone', 'an, aber nicht DE-LU'],
    [{ epex: { priceOutlook: 'on', enabled: false } }, 'prices_off', 'an, Börsenpreise aus'],
  ];
  for (const [cfg, reason, label] of cases) {
    assert.equal(outlookDisabledReason(cfg), reason, label);
    const fetchImpl = fetchStub([FIXTURE]);
    const svc = createPriceOutlookService({ getCfg: () => cfg, fetchImpl, cacheFile: null, now: () => ISSUED + H });
    await svc.ensureFresh({ force: true });
    assert.equal(fetchImpl.calls.length, reason === null ? 1 : 0, `Abruf nur bei an — ${label}`);
    const cur = svc.current(ISSUED + H);
    assert.equal(cur.status, reason === null ? 'live' : 'off', label);
    if (reason !== null) assert.equal(cur.reason, reason, label);
  }
});

test('Schalter Preisprognose: Einstellung mit Standard „automatisch“, alte Configs unverändert', async () => {
  const { getConfigDefinition, normalizeConfigInput } = await import('../config-model.js');
  const field = getConfigDefinition().fields.find((f) => f.path === 'epex.priceOutlook');
  assert.ok(field, 'Feld epex.priceOutlook');
  assert.equal(field.label, 'Preisprognose von dvhub.online');
  assert.deepEqual(field.options.map((o) => o.value), ['auto', 'on', 'off']);
  assert.equal(field.default, 'auto');
  // Hilfe der Preisquelle verspricht nicht mehr „keine Preisprognose“ bei Öffentlich.
  const source = getConfigDefinition().fields.find((f) => f.path === 'epex.priceSource');
  assert.match(source.help, /einschalten/);
  for (const raw of [{}, { epex: { priceSource: 'public' } }, { epex: { priceSource: 'luox', bzn: 'DE-LU' } }]) {
    const { effectiveConfig } = normalizeConfigInput(raw);
    assert.equal(effectiveConfig.epex.priceOutlook, 'auto');
    assert.equal(outlookDisabledReason(effectiveConfig), raw.epex?.priceSource === 'public' ? 'source_public' : null);
  }
});

test('Abruf-Takt: 10 min nach den Prognose-Läufen (08:15/12:30/15:00/20:15 UTC), spätestens alle 3 h', () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(nextScheduledFetchMs(at('2026-11-12T07:00:00Z')), at('2026-11-12T08:25:00Z'));
  assert.equal(nextScheduledFetchMs(at('2026-11-12T08:25:00Z')), at('2026-11-12T12:40:00Z'));
  assert.equal(nextScheduledFetchMs(at('2026-11-12T21:00:00Z')), at('2026-11-13T08:25:00Z'));
  const cache = { fetchedAt: at('2026-11-12T09:00:00Z') };
  assert.equal(outlookFetchDue({ cache }, at('2026-11-12T11:00:00Z')), false);
  assert.equal(outlookFetchDue({ cache }, at('2026-11-12T12:40:00Z')), true);
  assert.equal(outlookFetchDue({ cache: { fetchedAt: at('2026-11-12T21:00:00Z') } }, at('2026-11-13T00:00:00Z')), true, '3 h ohne Termin');
  assert.equal(outlookFetchDue({ cache: null }, at('2026-11-12T11:00:00Z')), true);
  assert.equal(outlookFetchDue({ cache: null, lastAttemptAt: at('2026-11-12T10:55:00Z'), lastAttemptOk: false }, at('2026-11-12T11:00:00Z')), false);
});

test('API-Antwort: nur Stunden hinter den echten Preisen, in ct/kWh mit Band; Zustand und Ausgabezeit', () => {
  const now = Date.parse('2026-11-12T13:30:00Z');
  const o = parseOutlook(FIXTURE).outlook;
  const svc = { current: () => ({ status: 'live', reason: null, outlook: o, issuedAt: o.issuedAt, fetchedAt: o.issuedAt, unavailableSince: null }) };
  // Echte Preise bis 13.11. 23:00Z (Folgetag nach 13 Uhr bekannt).
  const data = [];
  for (let ms = Date.parse('2026-11-11T23:00:00Z'); ms < FIRST + 24 * H; ms += Q) data.push({ ts: ms, ct_kwh: 20 });
  const p = buildPriceOutlookPayload({ state: { epex: { data } }, cfg: cfgDe, priceOutlook: svc, nowMs: now });
  assert.equal(p.status, 'live');
  assert.equal(p.realUntil, new Date(FIRST + 24 * H).toISOString());
  assert.equal(p.hours[0].ts, FIRST + 24 * H);
  assert.equal(p.hours.length, 96);
  assert.equal(p.hours[0].p50, o.hours[24].p50 / 10);
  assert.ok(p.hours[0].p10 <= p.hours[0].p50 && p.hours[0].p50 <= p.hours[0].p90);
  assert.equal(p.issuedAt, o.issuedAt);
  // Ohne Dienst: nicht verfügbar.
  const none = buildPriceOutlookPayload({ state: {}, cfg: {}, priceOutlook: null, nowMs: now });
  assert.equal(none.status, 'unavailable');
  assert.deepEqual(none.hours, []);
});

test('publicPriceTail: nur die Felder für die Oberfläche', async () => {
  const { publicPriceTail } = await import('../services/optimizer/price-outlook.js');
  assert.equal(publicPriceTail(null), null);
  const t = publicPriceTail({ used: true, status: 'live', from: 'a', until: 'b', issuedAt: 'c', at: 0, lookahead: { until: 'd', limitedBy: 'pv' }, secret: 'x' });
  assert.equal(t.source, 'dvhub.online');
  assert.equal(t.lookahead.limitedBy, 'pv');
  assert.equal(t.secret, undefined);
  assert.equal(publicPriceTail({ used: false, status: 'unavailable', unavailableSince: 's' }).source, null);
});

// Codex 27983aca (P2): Eine Antwort mit Ausgabe in der Zukunft darf die
// gespeicherte gültige nicht ersetzen — sonst gälten spätere richtige Antworten
// als „älter“, und die Prognose bliebe aus, auch wenn der Server sich erholt.
test('Rückfall: Antwort mit Ausgabe in der Zukunft ersetzt die gültige Prognose nicht; die nächste richtige wird angenommen', async () => {
  const future = clone(FIXTURE); future.issued_at = new Date(ISSUED + 30 * H).toISOString();
  const later = clone(FIXTURE); later.issued_at = new Date(ISSUED + 5 * H).toISOString();
  let now = ISSUED + H;
  const svc = createPriceOutlookService({ getCfg: () => cfgDe, fetchImpl: fetchStub([FIXTURE, future, later]), cacheFile: tmpFile(), now: () => now });
  await svc.ensureFresh();
  now = ISSUED + 4 * H;
  await svc.ensureFresh({ force: true });
  let cur = svc.current(now);
  assert.equal(cur.status, 'cached');
  assert.equal(cur.outlook.issuedMs, ISSUED);
  assert.match(cur.lastError, /unusable_outlook:future/);
  now = ISSUED + 6 * H;
  await svc.ensureFresh({ force: true });
  cur = svc.current(now);
  assert.equal(cur.status, 'live');
  assert.equal(cur.outlook.issuedMs, ISSUED + 5 * H);
});
