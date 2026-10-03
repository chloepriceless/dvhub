import test from 'node:test';
import assert from 'node:assert/strict';

import { localDate, localParts, localMinutesOfDay, zoneOffsetMs } from '../tz-fast.js';

function intlParts(ms, timeZone) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) {
    if (x.type !== 'literal') p[x.type] = x.value;
  }
  return p;
}

for (const zone of ['Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Australia/Sydney']) {
  test(`stimmt mit Intl überein: ${zone}, 2024–2027 in 7-min-Schritten`, () => {
    const start = Date.UTC(2024, 0, 1);
    const end = Date.UTC(2027, 0, 1);
    let checked = 0;
    for (let ms = start; ms < end; ms += 7 * 60_000 + 13_337) {
      const p = intlParts(ms, zone);
      const want = `${p.year}-${p.month}-${p.day}`;
      assert.equal(localDate(ms, zone), want, `Datum ${new Date(ms).toISOString()}`);
      const lp = localParts(ms, zone);
      assert.equal(lp.hour, Number(p.hour), `Stunde ${new Date(ms).toISOString()}`);
      assert.equal(lp.minute, Number(p.minute));
      assert.equal(localMinutesOfDay(ms, zone), Number(p.hour) * 60 + Number(p.minute));
      checked += 1;
    }
    assert.ok(checked > 200_000);
  });
}

test('Zeitumstellung Berlin: 31.03.2024 01:00 UTC springt von +1 h auf +2 h', () => {
  assert.equal(zoneOffsetMs(Date.UTC(2024, 2, 31, 0, 59), 'Europe/Berlin'), 3_600_000);
  assert.equal(zoneOffsetMs(Date.UTC(2024, 2, 31, 1, 0), 'Europe/Berlin'), 7_200_000);
  assert.equal(localDate(Date.UTC(2024, 9, 26, 22, 30)), '2024-10-27', '23:30 UTC+? → Berliner Folgetag');
});

test('Eingaben: Date, ISO-Text, ungültig', () => {
  assert.equal(localDate(new Date('2026-06-30T22:30:00Z')), '2026-07-01');
  assert.equal(localDate('2026-06-30T21:30:00Z'), '2026-06-30');
  assert.equal(localDate('kaputt'), null);
  assert.equal(localMinutesOfDay(NaN), null);
});
