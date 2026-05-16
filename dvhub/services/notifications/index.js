// services/notifications/index.js -- Notification Service (INTG-07).
// Factory: createNotificationService(ctx) with trigger evaluation, throttle,
// quiet hours, SOC hysteresis, and fire-and-forget dispatch.
//
// Decisions:
//   - Plugin architecture: providers loaded dynamically from config
//   - Fire-and-forget: evaluate() never blocks the polling loop
//   - Throttle: per-event-type cooldown (configurable minIntervalSec)
//   - Quiet hours: suppress non-critical between configurable HH:MM range
//   - SOC hysteresis: prevents oscillation at threshold boundary (+/- 5%)
//   - device_offline: graceful no-op when deviceService not yet available
//   - No forecast_error trigger: state.forecast.lastError doesn't exist

import { createTelegramProvider } from './providers/telegram.js';
import { createPushoverProvider } from './providers/pushover.js';
import { createNtfyProvider } from './providers/ntfy.js';

// Phase 09.4 gap-closure: the `uptime-kuma` notification provider was removed.
// It duplicated the pre-existing `monitoring` block (config monitoring.pushUrl
// + server.js startMonitoringHeartbeat()). Uptime Kuma is now driven solely by
// that single HMAC-signed, SSRF-guarded heartbeat. Alert-push is wired through
// ctx.monitoringAlertPush (see server.js) — not a notification provider.
const PROVIDER_FACTORIES = {
  telegram: createTelegramProvider,
  pushover: createPushoverProvider,
  ntfy: createNtfyProvider
};

const HYSTERESIS_BAND = 5; // SOC percentage

// ---------- Pure functions (exported for testing) ----------

/**
 * Evaluate a single trigger against current state.
 *
 * @param {object} trigger - { event, threshold, channels, level }
 * @param {object} state - current DI state
 * @param {object|null} prevState - previous state snapshot
 * @param {object|null} ctx - optional context (for deviceService)
 * @returns {boolean}
 */
export function evaluateTrigger(trigger, state, prevState, ctx) {
  switch (trigger.event) {
    case 'negative_price': {
      const prices = state.epex?.data || [];
      return prices.some(s => s.ct_kwh < (trigger.threshold ?? 0));
    }
    case 'soc_low': {
      const soc = state.victron?.soc;
      if (soc == null) return false;
      return soc < trigger.threshold;
    }
    case 'soc_high': {
      const soc = state.victron?.soc;
      if (soc == null) return false;
      return soc > trigger.threshold;
    }
    case 'schedule_change': {
      return JSON.stringify(state.schedule?.active) !== JSON.stringify(prevState?.schedule?.active);
    }
    case 'device_offline': {
      // Graceful no-op: if deviceService not yet available, return false
      const devices = ctx?.deviceService?.getDevices?.() ?? [];
      return devices.some(d => !d.online && (Date.now() - (d.lastSeen || 0)) > (trigger.threshold || 300) * 1000);
    }
    default:
      return false;
  }
}

/**
 * Check if an event type is throttled.
 *
 * @param {string} eventType
 * @param {number} nowMs
 * @param {number} minIntervalSec
 * @param {Map<string,number>} lastFired
 * @returns {boolean}
 */
export function isThrottled(eventType, nowMs, minIntervalSec, lastFired) {
  const last = lastFired.get(eventType);
  if (last == null) return false;
  return (nowMs - last) < minIntervalSec * 1000;
}

/**
 * Check if current time is within quiet hours.
 *
 * @param {string} nowHHMM - "HH:MM"
 * @param {string} start - "HH:MM"
 * @param {string} end - "HH:MM"
 * @returns {boolean}
 */
export function isInQuietHours(nowHHMM, start, end) {
  if (start === end) return false; // disabled

  const toMin = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };

  const now = toMin(nowHHMM);
  const s = toMin(start);
  const e = toMin(end);

  if (s < e) {
    // Same-day range (e.g., 14:00-16:00)
    return now >= s && now < e;
  }
  // Cross-midnight range (e.g., 22:00-07:00)
  return now >= s || now < e;
}

// ---------- Service factory ----------

/**
 * Build a human-readable notification message for a trigger event.
 */
function buildMessage(trigger, state) {
  const event = trigger.event;
  const level = trigger.level || 'info';

  switch (event) {
    case 'negative_price': {
      const prices = state.epex?.data || [];
      const neg = prices.filter(s => s.ct_kwh < (trigger.threshold ?? 0));
      return {
        level,
        title: 'Negativpreis erkannt',
        body: `${neg.length} Slot(s) mit Preis unter ${trigger.threshold ?? 0} ct/kWh`
      };
    }
    case 'soc_low':
      return {
        level,
        title: 'SOC Niedrig',
        body: `Batterie bei ${state.victron?.soc}% (Schwelle: ${trigger.threshold}%)`
      };
    case 'soc_high':
      return {
        level,
        title: 'SOC Hoch',
        body: `Batterie bei ${state.victron?.soc}% (Schwelle: ${trigger.threshold}%)`
      };
    case 'schedule_change':
      return {
        level,
        title: 'Fahrplan geaendert',
        body: `Neuer aktiver Fahrplan: ${JSON.stringify(state.schedule?.active)}`
      };
    case 'device_offline':
      return {
        level,
        title: 'Geraet offline',
        body: 'Ein oder mehrere Geraete sind offline.'
      };
    default:
      return { level, title: event, body: '' };
  }
}

/**
 * Create the notification service.
 *
 * @param {object} ctx - { getCfg, pushLog, state, deviceService? }
 * @returns {{ start: Function, close: Function, evaluate: Function, _setProviders: Function }}
 */
export function createNotificationService(ctx) {
  const { getCfg, pushLog } = ctx;

  /** @type {Map<string, { type: string, notify: Function }>} */
  let providers = new Map();

  /** @type {Map<string, number>} last fired timestamp per event type */
  const lastFired = new Map();

  /** @type {Set<string>} events currently in active state (for hysteresis) */
  const activeEvents = new Set();

  /** @type {object|null} previous state snapshot for change detection */
  let prevState = null;

  async function start() {
    const cfg = getCfg();
    const nCfg = cfg.notifications;
    if (!nCfg?.enabled) return;

    providers = new Map();
    for (const [name, pCfg] of Object.entries(nCfg.providers || {})) {
      if (!pCfg.enabled) continue;
      const factory = PROVIDER_FACTORIES[name];
      if (!factory) continue;
      try {
        providers.set(name, factory(pCfg));
      } catch (err) {
        pushLog('notification_provider_error', { provider: name, error: err.message });
      }
    }
  }

  /**
   * Evaluate all configured triggers against current state.
   * Fire-and-forget: errors logged, never propagated.
   *
   * @param {object} state - current DI state
   * @param {number} nowMs - current timestamp (injectable for testing)
   */
  async function evaluate(state, nowMs) {
    try {
      const cfg = getCfg();
      const nCfg = cfg.notifications;
      if (!nCfg?.enabled) return;

      const triggers = nCfg.triggers || [];
      const throttleCfg = nCfg.throttle || {};
      const minIntervalSec = throttleCfg.minIntervalSec ?? 300;
      const quietStart = throttleCfg.quietHoursStart || '22:00';
      const quietEnd = throttleCfg.quietHoursEnd || '07:00';

      const nowDate = new Date(nowMs);
      const nowHHMM = `${String(nowDate.getHours()).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}`;

      for (const trigger of triggers) {
        const eventType = trigger.event;
        const level = trigger.level || 'info';
        const fired = evaluateTrigger(trigger, state, prevState, ctx);

        // SOC hysteresis handling
        if (eventType === 'soc_low' || eventType === 'soc_high') {
          if (!fired) {
            // Check if we should clear hysteresis
            const soc = state.victron?.soc;
            if (soc != null && activeEvents.has(eventType)) {
              if (eventType === 'soc_low' && soc >= trigger.threshold + HYSTERESIS_BAND) {
                activeEvents.delete(eventType);
              } else if (eventType === 'soc_high' && soc <= trigger.threshold - HYSTERESIS_BAND) {
                activeEvents.delete(eventType);
              }
            }
            continue;
          }

          // If already active (hysteresis), skip
          if (activeEvents.has(eventType)) continue;

          // Mark as active
          activeEvents.add(eventType);
        } else {
          if (!fired) continue;
        }

        // Throttle check
        if (isThrottled(eventType, nowMs, minIntervalSec, lastFired)) continue;

        // Quiet hours check (critical bypasses)
        if (level !== 'critical' && isInQuietHours(nowHHMM, quietStart, quietEnd)) continue;

        // Build message
        const msg = buildMessage(trigger, state);

        // Dispatch to channels
        const channels = trigger.channels || [];
        for (const channel of channels) {
          const provider = providers.get(channel);
          if (!provider) continue;
          try {
            const result = await provider.notify(msg);
            pushLog('notification_sent', { event: eventType, channel, ok: result.ok, error: result.error });
          } catch (err) {
            pushLog('notification_error', { event: eventType, channel, error: err.message });
          }
        }

        // Phase 09.4 gap-closure (Gap 3 step 3): also fire ONE Uptime Kuma
        // alert-push per notification, REUSING the existing monitoring
        // heartbeat's signed/SSRF-guarded send path (server.js exposes
        // ctx.monitoringAlertPush). A 'critical' level maps to status=down so
        // Kuma raises the monitor; everything else stays status=up. The hook
        // is a no-op when monitoring.pushUrl is unset — fire-and-forget, never
        // blocks or throws.
        if (typeof ctx.monitoringAlertPush === 'function') {
          try {
            const alertStatus = (msg.level === 'critical') ? 'down' : 'up';
            const alertMsg = `${msg.title || 'DVhub'}: ${msg.body || ''}`.slice(0, 200);
            // Intentionally not awaited — fire-and-forget.
            Promise.resolve(ctx.monitoringAlertPush(alertStatus, alertMsg)).catch(() => { /* noop */ });
          } catch (_) { /* noop */ }
        }

        // Mark as fired for throttle
        lastFired.set(eventType, nowMs);
      }

      // Update prevState for next evaluation
      prevState = state ? JSON.parse(JSON.stringify(state)) : null;
    } catch (err) {
      // Fire-and-forget: never propagate errors
      try { pushLog('notification_evaluate_error', { error: err.message }); } catch (_) { /* noop */ }
    }
  }

  function close() {
    providers.clear();
    lastFired.clear();
    activeEvents.clear();
    prevState = null;
  }

  /**
   * Test helper: inject mock providers.
   * @param {object} providerMap - { telegram: providerInstance, ... }
   */
  function _setProviders(providerMap) {
    providers = new Map(Object.entries(providerMap));
  }

  return { start, close, evaluate, _setProviders };
}
