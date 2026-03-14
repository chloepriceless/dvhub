/**
 * EVCC Bridge Service
 *
 * Polls the EVCC REST API (/api/state) and publishes normalized loadpoint state
 * via RxJS BehaviorSubject. Handles both v0.207+ flat JSON and legacy
 * result-wrapped response formats.
 *
 * Factory function pattern matching plan-engine.js and optimizer adapters.
 */

import { BehaviorSubject } from 'rxjs';

/**
 * Normalize a raw EVCC loadpoint object to a consistent schema.
 * @param {object} raw - Raw loadpoint from EVCC API
 * @returns {object} Normalized loadpoint
 */
function normalizeLoadpoint(raw) {
  return {
    mode: raw.mode || 'off',
    chargePower: raw.chargePower || 0,
    chargedEnergy: raw.chargedEnergy || 0,
    charging: Boolean(raw.charging),
    connected: Boolean(raw.connected),
    enabled: Boolean(raw.enabled),
    planActive: Boolean(raw.planActive),
    vehicleSoc: raw.vehicleSoc ?? null,
    vehicleRange: raw.vehicleRange ?? null,
    minSoc: raw.minSoc ?? 0,
    phasesActive: raw.phasesActive ?? 0,
  };
}

/**
 * Create an EVCC bridge that polls loadpoint state and publishes via BehaviorSubject.
 * @param {object} options
 * @param {string} options.baseUrl - EVCC base URL (e.g. http://evcc.local:7070)
 * @param {number} [options.pollIntervalMs=30000] - Poll interval in ms
 * @param {object} [options.log] - Pino-compatible logger
 * @returns {{ start, stop, getState, getState$ }}
 */
export function createEvccBridge({ baseUrl, pollIntervalMs = 30000, log }) {
  const state$ = new BehaviorSubject(null);
  let timer = null;

  /**
   * Poll EVCC /api/state and update BehaviorSubject.
   * Handles both v0.207+ format (data.loadpoints) and legacy (data.result.loadpoints).
   */
  async function poll() {
    try {
      const res = await fetch(`${baseUrl}/api/state`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`EVCC HTTP ${res.status}`);
      const data = await res.json();

      // Dual-format handling: v0.207+ flat vs legacy result-wrapped
      const loadpoints = data.loadpoints || data.result?.loadpoints || [];
      const battery = data.battery || data.result?.battery || [];
      const grid = data.grid || data.result?.grid || {};
      const tariff = data.tariff || data.result?.tariff || {};

      state$.next({
        loadpoints: loadpoints.map(normalizeLoadpoint),
        battery,
        grid,
        tariff,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      log?.warn({ err: err.message }, 'EVCC poll failed');
    }
  }

  /**
   * Start polling. Calls poll() immediately, then sets interval.
   */
  function start() {
    poll();
    timer = setInterval(poll, pollIntervalMs);
    timer.unref();
  }

  /**
   * Stop polling and complete the BehaviorSubject stream.
   */
  function stop() {
    clearInterval(timer);
    state$.complete();
  }

  /**
   * Get current state synchronously.
   * @returns {object|null}
   */
  function getState() {
    return state$.getValue();
  }

  /**
   * Get observable state stream.
   * @returns {Observable}
   */
  function getState$() {
    return state$.asObservable();
  }

  return { start, stop, getState, getState$ };
}
