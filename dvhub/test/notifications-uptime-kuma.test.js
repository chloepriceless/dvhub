// test/notifications-uptime-kuma.test.js -- Uptime Kuma alert-push integration.
//
// Phase 09.4 gap-closure (Gap 3): the standalone `uptime-kuma` notification
// provider was REMOVED — it duplicated the pre-existing `monitoring` block
// (config monitoring.pushUrl + server.js startMonitoringHeartbeat(), an
// HMAC-signed/SSRF-guarded heartbeat). Uptime Kuma is now driven solely by
// that single integration.
//
// What remains genuinely-new is the alert-push: when the notification service
// dispatches a notification it ALSO fires ONE Kuma push via the
// ctx.monitoringAlertPush(status, msg) hook (server.js routes that through the
// shared signed/guarded heartbeat send path). These tests exercise that hook
// from the notification service's evaluate() — i.e. the part that survived the
// de-duplication.
//
// Contract under test:
//   - evaluate() calls ctx.monitoringAlertPush(status, msg) once per dispatched
//     notification, with status='down' for level 'critical', else status='up'.
//   - The hook is optional: a service built without ctx.monitoringAlertPush
//     dispatches normally and never throws.
//   - Alert-push is fire-and-forget: a rejecting hook never breaks evaluate().
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createNotificationService } from '../services/notifications/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal fake provider — records the messages it was asked to notify().
function fakeProvider() {
  const sent = [];
  return {
    instance: { type: 'fake', notify: async (msg) => { sent.push(msg); return { ok: true }; } },
    sent
  };
}

function baseCfg(triggers) {
  return {
    notifications: {
      enabled: true,
      providers: { fake: { enabled: true } },
      throttle: { minIntervalSec: 0, quietHoursStart: '00:00', quietHoursEnd: '00:00' },
      triggers
    }
  };
}

describe('Uptime Kuma alert-push integration (notification service)', () => {
  it('evaluate() calls ctx.monitoringAlertPush with status=up for a non-critical alert', async () => {
    const calls = [];
    const cfg = baseCfg([
      { event: 'soc_low', threshold: 15, level: 'warn', channels: ['fake'] }
    ]);
    const ctx = {
      getCfg: () => cfg,
      pushLog: () => {},
      monitoringAlertPush: (status, msg) => { calls.push({ status, msg }); return Promise.resolve(); }
    };
    const svc = createNotificationService(ctx);
    const fp = fakeProvider();
    svc._setProviders({ fake: fp.instance });

    await svc.evaluate({ victron: { soc: 10 } }, Date.now());
    await sleep(20); // alert-push is fire-and-forget

    assert.equal(fp.sent.length, 1, 'the fake provider received the notification');
    assert.equal(calls.length, 1, 'monitoringAlertPush fired exactly once');
    assert.equal(calls[0].status, 'up', 'warn level -> status=up');
    assert.ok(calls[0].msg.includes('SOC'), 'alert message carries the trigger title');
  });

  it('evaluate() calls ctx.monitoringAlertPush with status=down for a critical alert', async () => {
    const calls = [];
    const cfg = baseCfg([
      { event: 'soc_low', threshold: 15, level: 'critical', channels: ['fake'] }
    ]);
    const ctx = {
      getCfg: () => cfg,
      pushLog: () => {},
      monitoringAlertPush: (status, msg) => { calls.push({ status, msg }); return Promise.resolve(); }
    };
    const svc = createNotificationService(ctx);
    svc._setProviders({ fake: fakeProvider().instance });

    await svc.evaluate({ victron: { soc: 5 } }, Date.now());
    await sleep(20);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 'down', 'critical level -> status=down');
  });

  it('dispatches normally when ctx.monitoringAlertPush is absent (hook is optional)', async () => {
    const cfg = baseCfg([
      { event: 'soc_low', threshold: 15, level: 'warn', channels: ['fake'] }
    ]);
    const ctx = { getCfg: () => cfg, pushLog: () => {} }; // no monitoringAlertPush
    const svc = createNotificationService(ctx);
    const fp = fakeProvider();
    svc._setProviders({ fake: fp.instance });

    await svc.evaluate({ victron: { soc: 10 } }, Date.now());
    await sleep(20);

    assert.equal(fp.sent.length, 1, 'notification still dispatched without the hook');
  });

  it('a rejecting monitoringAlertPush never breaks evaluate() (fire-and-forget)', async () => {
    const cfg = baseCfg([
      { event: 'soc_low', threshold: 15, level: 'warn', channels: ['fake'] }
    ]);
    const ctx = {
      getCfg: () => cfg,
      pushLog: () => {},
      monitoringAlertPush: () => Promise.reject(new Error('kuma unreachable'))
    };
    const svc = createNotificationService(ctx);
    const fp = fakeProvider();
    svc._setProviders({ fake: fp.instance });

    // Must resolve cleanly even though the hook rejects.
    await svc.evaluate({ victron: { soc: 10 } }, Date.now());
    await sleep(20);

    assert.equal(fp.sent.length, 1, 'notification dispatched despite the hook rejection');
  });

  it('does NOT fire monitoringAlertPush when no trigger matches', async () => {
    const calls = [];
    const cfg = baseCfg([
      { event: 'soc_low', threshold: 15, level: 'warn', channels: ['fake'] }
    ]);
    const ctx = {
      getCfg: () => cfg,
      pushLog: () => {},
      monitoringAlertPush: (status, msg) => { calls.push({ status, msg }); return Promise.resolve(); }
    };
    const svc = createNotificationService(ctx);
    svc._setProviders({ fake: fakeProvider().instance });

    await svc.evaluate({ victron: { soc: 50 } }, Date.now()); // soc above threshold
    await sleep(20);

    assert.equal(calls.length, 0, 'no alert-push when nothing fired');
  });
});
