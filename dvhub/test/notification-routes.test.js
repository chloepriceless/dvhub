// test/notification-routes.test.js — Benachrichtigungs-Provider (ntfy,
// Telegram, Pushover) über createApiRoutes().handleRequest (2026-10-15). Die
// Quelltext-Tests notification-providers-*-route.test.js prüfen die Form der
// Blöcke; diese hier das Verhalten und dass der Bereich verdrahtet ist.
// Test-Versand nur bis zur Eingabeprüfung — kein echter Netzaufruf.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mockCtx, call } from './helpers/api-routes-harness.js';

const BASE = '/api/notifications/providers';
const stored = (providers) => mockCtx({ raw: { notifications: { providers } } });

describe('ntfy', () => {
  it('GET zeigt das Token nur als ***', async () => {
    const r = await call(stored({ ntfy: { enabled: true, topicUrl: 'https://ntfy.sh/x', token: 'geheim' } }), `${BASE}/ntfy`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, enabled: true, topicUrl: 'https://ntfy.sh/x', token: '***' });
  });

  it('POST mit *** behält das gespeicherte Token', async () => {
    const ctx = stored({ ntfy: { enabled: false, topicUrl: 'https://ntfy.sh/x', token: 'geheim' } });
    const r = await call(ctx, `${BASE}/ntfy`, { method: 'POST', body: { enabled: true, topicUrl: 'https://ntfy.sh/y', token: '***' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(ctx.saved.length, 1);
    assert.deepEqual(ctx.saved[0].notifications.providers.ntfy, { enabled: true, topicUrl: 'https://ntfy.sh/y', token: 'geheim' });
  });

  it('Test ohne Ziel-Adresse → 400 missing_topicurl', async () => {
    const r = await call(mockCtx(), `${BASE}/ntfy/test`, { method: 'POST', body: {} });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, error: 'missing_topicurl' });
  });
});

describe('Telegram', () => {
  it('GET zeigt Bot-Token und Chat-ID nur als ***', async () => {
    const r = await call(stored({ telegram: { enabled: false, botToken: 'b', chatId: 'c' } }), `${BASE}/telegram`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, enabled: false, botToken: '***', chatId: '***' });
  });

  it('POST: *** behält das Bot-Token, neue Chat-ID wird übernommen', async () => {
    const ctx = stored({ telegram: { enabled: false, botToken: 'b', chatId: 'c' } });
    const r = await call(ctx, `${BASE}/telegram`, { method: 'POST', body: { enabled: true, botToken: '***', chatId: '99' } });
    assert.equal(r.status, 200);
    assert.deepEqual(ctx.saved[0].notifications.providers.telegram, { enabled: true, botToken: 'b', chatId: '99' });
  });

  it('Test ohne Zugangsdaten → 400 missing_credentials', async () => {
    const r = await call(mockCtx(), `${BASE}/telegram/test`, { method: 'POST', body: {} });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, error: 'missing_credentials' });
  });
});

describe('Pushover', () => {
  it('GET zeigt App-Token und User-Key nur als ***', async () => {
    const r = await call(stored({ pushover: { enabled: true, appToken: 'a', userKey: 'u' } }), `${BASE}/pushover`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, enabled: true, appToken: '***', userKey: '***' });
  });

  it('POST: *** behält beide Schlüssel', async () => {
    const ctx = stored({ pushover: { enabled: false, appToken: 'a', userKey: 'u' } });
    const r = await call(ctx, `${BASE}/pushover`, { method: 'POST', body: { enabled: true, appToken: '***', userKey: '***' } });
    assert.equal(r.status, 200);
    assert.deepEqual(ctx.saved[0].notifications.providers.pushover, { enabled: true, appToken: 'a', userKey: 'u' });
  });

  it('Test ohne Zugangsdaten → 400 missing_credentials', async () => {
    const r = await call(mockCtx(), `${BASE}/pushover/test`, { method: 'POST', body: {} });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, error: 'missing_credentials' });
  });
});
