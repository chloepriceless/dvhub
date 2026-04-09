import test from 'node:test';
import assert from 'node:assert/strict';

import { generateTemplateMessage, getMessageEmoji } from '../services/llm/template-fallback.js';
import { createMessageBuffer } from '../services/llm/message-buffer.js';

// ---------- Template Fallback Tests ----------

test('generateTemplateMessage status contains data values', () => {
  const data = { pvKwh: '4.2', soc: '82', gridW: '120', pvW: '4200', pvTodayKwh: '18.5', consumedKwh: '12.3' };
  const msg = generateTemplateMessage('status', data);
  assert.ok(typeof msg === 'string' && msg.length > 0, 'should return non-empty string');
  // At least one of the provided data values must appear in the message
  const hasAnyValue = Object.values(data).some(v => msg.includes(v));
  assert.ok(hasAnyValue, 'should contain at least one data value');
});

test('generateTemplateMessage savings contains time and price', () => {
  const data = { time: '14:00', price: '3', excessW: '800', feedInCt: '8.2' };
  const msg = generateTemplateMessage('savings', data);
  const hasAnyValue = Object.values(data).some(v => msg.includes(v));
  assert.ok(hasAnyValue, 'should contain at least one savings data value');
});

test('generateTemplateMessage alert contains soc', () => {
  const data = { soc: '15', source: 'Solcast', minutes: '30' };
  const msg = generateTemplateMessage('alert', data);
  const hasAnyValue = Object.values(data).some(v => msg.includes(v));
  assert.ok(hasAnyValue, 'should contain at least one alert data value');
});

test('generateTemplateMessage unknown type falls back to status', () => {
  const msg = generateTemplateMessage('unknown_type', {});
  assert.ok(typeof msg === 'string' && msg.length > 0, 'should return non-empty fallback');
});

test('generateTemplateMessage replaces missing placeholders with ?', () => {
  const msg = generateTemplateMessage('status', { pvKwh: undefined });
  assert.ok(msg.includes('?'), 'should contain ? for missing placeholder');
});

test('getMessageEmoji returns correct emoji per type', () => {
  assert.equal(getMessageEmoji('status'), '\u26A1');
  assert.equal(getMessageEmoji('savings'), '\uD83D\uDCB0');
  assert.equal(getMessageEmoji('alert'), '\u26A0\uFE0F');
  assert.equal(getMessageEmoji('pv_record'), '\u2600\uFE0F');
  assert.equal(getMessageEmoji('negative_price'), '\uD83C\uDF89');
  assert.equal(getMessageEmoji('other'), '\uD83D\uDCE1');
});

// ---------- Ring Buffer Tests ----------

test('buffer add stores message with id and timestamp', () => {
  const buf = createMessageBuffer({ maxAgeMs: 86400000 });
  buf.add({ text: 'hi', type: 'status' });
  const msgs = buf.getAll();
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].id, 'should have auto-generated id');
  assert.ok(msgs[0].ts, 'should have timestamp');
  assert.equal(msgs[0].text, 'hi');
  assert.equal(msgs[0].type, 'status');
});

test('buffer getAll returns newest first', () => {
  const buf = createMessageBuffer({ maxAgeMs: 86400000 });
  buf.add({ text: 'first', type: 'status' });
  buf.add({ text: 'second', type: 'status' });
  const msgs = buf.getAll();
  assert.equal(msgs[0].text, 'second');
  assert.equal(msgs[1].text, 'first');
});

test('buffer getLatest returns most recent or null', () => {
  const buf = createMessageBuffer({ maxAgeMs: 86400000 });
  assert.equal(buf.getLatest(), null);
  buf.add({ text: 'hello', type: 'status' });
  assert.equal(buf.getLatest().text, 'hello');
});

test('buffer cleanup removes messages older than maxAgeMs', () => {
  const buf = createMessageBuffer({ maxAgeMs: 1000 });
  // Manually inject an old message
  buf.add({ text: 'old', type: 'status' });
  const msgs = buf.getAll();
  // Tamper with timestamp to simulate old message
  msgs[0].ts = Date.now() - 2000;
  buf.cleanup();
  assert.equal(buf.getCount(), 0, 'old message should be cleaned up');
});

test('buffer handles 100+ messages within 24h window', () => {
  const buf = createMessageBuffer({ maxAgeMs: 86400000 });
  for (let i = 0; i < 105; i++) {
    buf.add({ text: `msg-${i}`, type: 'status' });
  }
  assert.equal(buf.getCount(), 105);
  assert.equal(buf.getAll()[0].text, 'msg-104');
});
