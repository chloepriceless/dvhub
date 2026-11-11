// Umwandlung der LUOX-Portal-Antworten (services/tariff-provider/luox-data.js):
// Day-Ahead €/MWh → DVhub-Preisformat inkl. Zeitumstellung (92/100 Punkte),
// Einspeise-Zeitreihe, Vertragsübersicht ohne personenbezogene Daten.
// Alle Daten sind erfunden.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  luoxDayAheadRows, parseLuoxLocalTimes, parseEnergyData, summarizeContracts, pickContract
} from '../services/tariff-provider/luox-data.js';

const Q = 900_000;

function seriesFromUtc(startIso, n, fmt, priceAt = (i) => 80 + i) {
  const start = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => {
    const s = new Date(start + i * Q);
    const e = new Date(start + (i + 1) * Q);
    return { start_time: fmt(s), end_time: fmt(e), price: priceAt(i) };
  });
}

// Ortszeit ohne Versatz, wie sie ein Django-Backend ohne USE_TZ ausgibt
function berlinNaive(d) {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
  return p.replace(' ', 'T');
}
function berlinWithOffset(d) {
  const naive = berlinNaive(d);
  const off = Math.round((Date.parse(`${naive}Z`) - d.getTime()) / 60000);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${naive}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

test('Day-Ahead mit Ortsversatz: 96 + 96 Viertelstunden, €/MWh → ct/kWh', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const json = {
    current_price: { start_time: 'x', end_time: 'y', price: 1 },
    today_data: seriesFromUtc('2026-11-10T23:00:00Z', 96, berlinWithOffset),
    tomorrow_data: seriesFromUtc('2026-11-11T23:00:00Z', 96, berlinWithOffset, (i) => -5 + i / 10)
  };
  const r = luoxDayAheadRows(json, { now });
  assert.equal(r.rows.length, 192);
  assert.equal(r.todayCount, 96);
  assert.equal(r.tomorrowCount, 96);
  assert.equal(r.rows[0].ts, Date.parse('2026-11-10T23:00:00Z'));
  assert.equal(r.rows[0].eurMwh, 80);
  assert.equal(r.rows[0].ctKwh, 8);
  assert.equal(r.rows[0].durationMs, Q);
  assert.equal(r.rows[96].ts, Date.parse('2026-11-11T23:00:00Z'));
  assert.equal(r.rows[96].ctKwh, -0.5, 'negative Preise bleiben negativ');
  for (let i = 1; i < r.rows.length; i++) assert.equal(r.rows[i].ts - r.rows[i - 1].ts, Q);
});

test('Day-Ahead in UTC (Z) und ohne Versatz (Ortszeit) ergeben dieselben Zeitpunkte', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const utc = luoxDayAheadRows({ today_data: seriesFromUtc('2026-11-10T23:00:00Z', 96, (d) => d.toISOString()), tomorrow_data: [] }, { now });
  const naive = luoxDayAheadRows({ today_data: seriesFromUtc('2026-11-10T23:00:00Z', 96, berlinNaive), tomorrow_data: [] }, { now });
  const spaced = luoxDayAheadRows({ today_data: seriesFromUtc('2026-11-10T23:00:00Z', 96, (d) => berlinNaive(d).replace('T', ' ')), tomorrow_data: [] }, { now });
  assert.deepEqual(naive.rows.map((r) => r.ts), utc.rows.map((r) => r.ts));
  assert.deepEqual(spaced.rows.map((r) => r.ts), utc.rows.map((r) => r.ts));
  assert.equal(naive.rows[0].ts, Date.parse('2026-11-10T23:00:00Z'));
});

test('Zeitumstellung Oktober (25.10.2026): 100 Viertelstunden, doppelte Ortszeit 02:xx richtig zugeordnet', () => {
  const now = Date.parse('2026-10-25T10:00:00Z');
  // 24.10. 22:00Z = 25.10. 00:00 MESZ … 25.10. 23:00Z = 26.10. 00:00 MEZ → 25 h
  const today = seriesFromUtc('2026-10-24T22:00:00Z', 100, berlinNaive);
  const naiveTimes = today.map((p) => p.start_time.slice(11, 16));
  assert.equal(naiveTimes.filter((t) => t === '02:00').length, 2, 'Testvoraussetzung: 02:00 kommt zweimal');
  const r = luoxDayAheadRows({ today_data: today, tomorrow_data: [] }, { now });
  assert.equal(r.rows.length, 100);
  assert.equal(r.todayCount, 100);
  for (let i = 1; i < r.rows.length; i++) assert.equal(r.rows[i].ts - r.rows[i - 1].ts, Q, `Abstand an Stelle ${i}`);
  assert.equal(r.rows[0].ts, Date.parse('2026-10-24T22:00:00Z'));
  assert.equal(r.rows[99].ts, Date.parse('2026-10-25T22:45:00Z'));
});

test('Zeitumstellung März (29.03.2026): 92 Viertelstunden, keine 02:xx', () => {
  const now = Date.parse('2026-03-29T10:00:00Z');
  const today = seriesFromUtc('2026-03-28T23:00:00Z', 92, berlinNaive);
  assert.ok(!today.some((p) => p.start_time.slice(11, 13) === '02'));
  const r = luoxDayAheadRows({ today_data: today, tomorrow_data: [] }, { now });
  assert.equal(r.rows.length, 92);
  for (let i = 1; i < r.rows.length; i++) assert.equal(r.rows[i].ts - r.rows[i - 1].ts, Q);
  assert.equal(r.rows[91].ts, Date.parse('2026-03-29T21:45:00Z'));
});

test('Nur Uhrzeit (HH:MM) mit dem Tag der Liste', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ start_time: `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`, price: 50 }));
  const r = luoxDayAheadRows({ today_data: mk(96), tomorrow_data: mk(96) }, { now });
  assert.equal(r.rows.length, 192);
  assert.equal(r.rows[0].ts, Date.parse('2026-11-10T23:00:00Z'));
  assert.equal(r.rows[96].ts, Date.parse('2026-11-11T23:00:00Z'));
});

test('Fehlende/kaputte Preise und Zeiten werden übersprungen, leere Listen sind kein Fehler', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const r = luoxDayAheadRows({
    today_data: [
      { start_time: '2026-11-11T00:00:00+01:00', price: null },
      { start_time: 'kaputt', price: 10 },
      { start_time: '2026-11-11T00:15:00+01:00', price: '12.5' },
      null
    ],
    tomorrow_data: null
  }, { now });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].eurMwh, 12.5);
  assert.deepEqual(luoxDayAheadRows({}, { now }).rows, []);
  assert.throws(() => luoxDayAheadRows('quatsch', { now }), (e) => e.code === 'format');
});

test('Ortszeit-Folge: Rückwärtssprung wählt die zweite Stunde, Lücke der Sommerzeit wird verworfen', () => {
  const ts = parseLuoxLocalTimes(['2026-10-25T02:45:00', '2026-10-25T02:00:00', '2026-03-29T02:30:00']);
  assert.equal(ts[0], Date.parse('2026-10-25T00:45:00Z'));
  assert.equal(ts[1], Date.parse('2026-10-25T01:00:00Z'));
  assert.equal(ts[2], null, '02:30 am 29.03. gibt es nicht');
});

test('Einspeise-Zeitreihe energy_data: Wh je Abschnitt, Zeiten wie die Preise', () => {
  const list = [
    { start: '2026-11-10T00:00:00+01:00', end: '2026-11-10T00:15:00+01:00', feed: 0 },
    { start: '2026-11-10T12:00:00+01:00', end: '2026-11-10T12:15:00+01:00', feed: 812 },
    { start: '2026-11-10T12:15:00+01:00', end: '2026-11-10T12:30:00+01:00', feed: null },
    { start: 'x', end: 'y', feed: 5 }
  ];
  const r = parseEnergyData(list);
  assert.equal(r.length, 2);
  assert.deepEqual(r[1], { ts: Date.parse('2026-11-10T11:00:00Z'), durationMs: Q, wh: 812 });
  assert.throws(() => parseEnergyData({ detail: 'x' }), (e) => e.code === 'format');
});

const CONTRACTS = {
  saas_customer_id: '90000001',
  first_name: 'Erika',
  username: 'kundin@example.invalid',
  partner: 'luox',
  consumer_delivering_points: [{
    saas_contract_id: 'C90000001-1', tariff_type: 'spot', deliv_status: 'pending_join', reg_status: 'registered',
    delivery_start: '2026-11-17', delivery_end: null, timeseries_category: 'other_then_LGS',
    meter_id: '1ABC0000000001', market_location: '50000000000', street: 'Musterweg', iban: 'DE00000000000000000000'
  }],
  producer_delivering_points: [{
    saas_contract_id: 'P90000001-1', tariff_type: 'direct_marketing', deliv_status: 'delivering', reg_status: 'registered',
    delivery_start: '2026-01-15', delivery_end: null, timeseries_category: 'other_then_LGS', meter_id: '1ABC0000000002'
  }]
};

test('Vertragsübersicht: nur Nummer, Art, Status, Lieferbeginn, Zeitreihen-Kategorie — keine Kundendaten', () => {
  const s = summarizeContracts(CONTRACTS);
  assert.equal(s.customerId, '90000001');
  assert.deepEqual(s.contracts.map((c) => [c.id, c.kind, c.status, c.deliveryStart, c.timeseriesCategory]), [
    ['C90000001-1', 'consumer', 'pending_join', '2026-11-17', 'other_then_LGS'],
    ['P90000001-1', 'producer', 'delivering', '2026-01-15', 'other_then_LGS']
  ]);
  const text = JSON.stringify(s);
  for (const secret of ['Erika', 'kundin@', 'Musterweg', 'DE0000', '1ABC', '50000000000']) assert.ok(!text.includes(secret), secret);
});

test('Vertragsauswahl: eingetragene Nummer, sonst der erste passende; fremde Nummer = no_contract', () => {
  const s = summarizeContracts(CONTRACTS);
  assert.equal(pickContract(s, 'consumer', '').id, 'C90000001-1');
  assert.equal(pickContract(s, 'producer', '').id, 'P90000001-1');
  assert.equal(pickContract(s, 'producer', 'P90000001-1').id, 'P90000001-1');
  assert.throws(() => pickContract(s, 'producer', 'P11111111-1'), (e) => e.code === 'no_contract');
  assert.throws(() => pickContract(s, 'producer', 'C90000001-1'), (e) => e.code === 'no_contract', 'Verbrauchsvertrag ist kein Erzeugervertrag');
  assert.throws(() => pickContract(summarizeContracts({ consumer_delivering_points: [] }), 'consumer', ''), (e) => e.code === 'no_contract');
});
