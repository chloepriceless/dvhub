// test/notification-triggers.test.js -- Trigger evaluation unit tests (INTG-07)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createNotificationService, evaluateTrigger } from '../services/notifications/index.js';

// ---------- evaluateTrigger ----------

describe('evaluateTrigger', () => {

  it('negative_price: fires when ct_kwh < 0 (threshold null)', () => {
    const trigger = { event: 'negative_price', threshold: null, channels: ['telegram'] };
    const state = { epex: { data: [{ ts: 1, ct_kwh: -0.5 }, { ts: 2, ct_kwh: 3 }] } };
    assert.equal(evaluateTrigger(trigger, state, null), true);
  });

  it('negative_price: does NOT fire when all prices >= 0', () => {
    const trigger = { event: 'negative_price', threshold: null, channels: ['telegram'] };
    const state = { epex: { data: [{ ts: 1, ct_kwh: 0 }, { ts: 2, ct_kwh: 5 }] } };
    assert.equal(evaluateTrigger(trigger, state, null), false);
  });

  it('negative_price: fires when ct_kwh < threshold (non-null)', () => {
    const trigger = { event: 'negative_price', threshold: 2, channels: ['telegram'] };
    const state = { epex: { data: [{ ts: 1, ct_kwh: 1.5 }] } };
    assert.equal(evaluateTrigger(trigger, state, null), true);
  });

  it('negative_price: handles missing epex data', () => {
    const trigger = { event: 'negative_price', threshold: null, channels: ['telegram'] };
    assert.equal(evaluateTrigger(trigger, {}, null), false);
    assert.equal(evaluateTrigger(trigger, { epex: {} }, null), false);
  });

  it('soc_low: fires when soc < threshold', () => {
    const trigger = { event: 'soc_low', threshold: 15, channels: ['telegram'] };
    const state = { victron: { soc: 12 } };
    assert.equal(evaluateTrigger(trigger, state, null), true);
  });

  it('soc_low: does NOT fire when soc >= threshold', () => {
    const trigger = { event: 'soc_low', threshold: 15, channels: ['telegram'] };
    const state = { victron: { soc: 15 } };
    assert.equal(evaluateTrigger(trigger, state, null), false);
  });

  it('soc_low: returns false when soc is null', () => {
    const trigger = { event: 'soc_low', threshold: 15, channels: ['telegram'] };
    const state = { victron: { soc: null } };
    assert.equal(evaluateTrigger(trigger, state, null), false);
  });

  it('soc_high: fires when soc > threshold', () => {
    const trigger = { event: 'soc_high', threshold: 95, channels: ['telegram'] };
    const state = { victron: { soc: 98 } };
    assert.equal(evaluateTrigger(trigger, state, null), true);
  });

  it('soc_high: does NOT fire when soc <= threshold', () => {
    const trigger = { event: 'soc_high', threshold: 95, channels: ['telegram'] };
    const state = { victron: { soc: 95 } };
    assert.equal(evaluateTrigger(trigger, state, null), false);
  });

  it('schedule_change: fires when active schedule differs from previous', () => {
    const trigger = { event: 'schedule_change', threshold: null, channels: ['telegram'] };
    const state = { schedule: { active: { gridSetpointW: -5000 } } };
    const prevState = { schedule: { active: { gridSetpointW: 0 } } };
    assert.equal(evaluateTrigger(trigger, state, prevState), true);
  });

  it('schedule_change: does NOT fire when unchanged', () => {
    const trigger = { event: 'schedule_change', threshold: null, channels: ['telegram'] };
    const active = { gridSetpointW: -5000 };
    const state = { schedule: { active } };
    const prevState = { schedule: { active: { gridSetpointW: -5000 } } };
    assert.equal(evaluateTrigger(trigger, state, prevState), false);
  });

  it('schedule_change: fires when going from null to active', () => {
    const trigger = { event: 'schedule_change', threshold: null, channels: ['telegram'] };
    const state = { schedule: { active: { gridSetpointW: -5000 } } };
    const prevState = { schedule: { active: null } };
    assert.equal(evaluateTrigger(trigger, state, prevState), true);
  });

  it('device_offline: graceful no-op when deviceService is null', () => {
    const trigger = { event: 'device_offline', threshold: 300, channels: ['telegram'] };
    const state = {};
    // evaluateTrigger receives optional ctx; without deviceService it should return false
    assert.equal(evaluateTrigger(trigger, state, null, {}), false);
    assert.equal(evaluateTrigger(trigger, state, null, null), false);
  });

  it('unknown event type returns false', () => {
    const trigger = { event: 'unknown_event', threshold: null, channels: ['telegram'] };
    assert.equal(evaluateTrigger(trigger, {}, null), false);
  });
});

// ---------- createNotificationService ----------

describe('createNotificationService', () => {

  it('returns { start, close, evaluate }', () => {
    const svc = createNotificationService({
      getCfg: () => ({ notifications: { enabled: false, providers: {}, triggers: [], throttle: { minIntervalSec: 300, quietHoursStart: '22:00', quietHoursEnd: '07:00' } } }),
      pushLog: () => {},
      state: {}
    });
    assert.equal(typeof svc.start, 'function');
    assert.equal(typeof svc.close, 'function');
    assert.equal(typeof svc.evaluate, 'function');
  });

  it('evaluate dispatches to provider when trigger fires', async () => {
    const dispatched = [];
    const mockProvider = {
      type: 'telegram',
      notify: async (msg) => { dispatched.push(msg); return { ok: true }; }
    };

    const svc = createNotificationService({
      getCfg: () => ({
        notifications: {
          enabled: true,
          providers: { telegram: { enabled: true, botToken: 'tok', chatId: '1' } },
          triggers: [{ event: 'soc_low', threshold: 20, channels: ['telegram'], level: 'warning' }],
          throttle: { minIntervalSec: 0, quietHoursStart: '00:00', quietHoursEnd: '00:00' }
        }
      }),
      pushLog: () => {},
      state: {}
    });

    // Inject mock provider
    svc._setProviders({ telegram: mockProvider });

    const state = { victron: { soc: 10 } };
    await svc.evaluate(state, Date.now());

    assert.ok(dispatched.length >= 1, 'should dispatch at least one notification');
    assert.ok(dispatched[0].title || dispatched[0].body, 'notification should have content');
  });
});

// --- Review 2026-06-10 (B7): sendDirect ---------------------------------------

describe('B7 sendDirect', () => {
  it('dispatches to all providers, bypassing triggers/quiet-hours', async () => {
    const sent = [];
    const svc = createNotificationService({
      getCfg: () => ({ notifications: { enabled: true } }),
      pushLog: () => {}
    });
    svc._setProviders({
      telegram: { type: 'telegram', notify: async (m) => { sent.push(['tg', m]); return { ok: true }; } },
      pushover: { type: 'pushover', notify: async (m) => { sent.push(['po', m]); return { ok: true }; } }
    });
    const r = await svc.sendDirect({ event: 'support_tunnel', level: 'warning', title: 'Support-Tunnel ge\u00f6ffnet', body: 'x' });
    assert.equal(r.sent, 2);
    assert.equal(sent.length, 2);
    assert.equal(sent[0][1].title, 'Support-Tunnel ge\u00f6ffnet');
  });

  it('is a no-op when notifications are disabled', async () => {
    const svc = createNotificationService({ getCfg: () => ({ notifications: { enabled: false } }), pushLog: () => {} });
    svc._setProviders({ telegram: { type: 'telegram', notify: async () => { throw new Error('must not be called'); } } });
    const r = await svc.sendDirect({ title: 'x' });
    assert.equal(r.sent, 0);
  });

  it('survives a throwing provider and still counts the others', async () => {
    const svc = createNotificationService({ getCfg: () => ({ notifications: { enabled: true } }), pushLog: () => {} });
    svc._setProviders({
      broken: { type: 'broken', notify: async () => { throw new Error('boom'); } },
      ok: { type: 'ok', notify: async () => ({ ok: true }) }
    });
    const r = await svc.sendDirect({ title: 'x' });
    assert.equal(r.sent, 1);
  });
});
