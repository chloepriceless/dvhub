/**
 * evcc integration — protects the home battery while an EV is charging.
 *
 * Polls evcc's /api/state. When any loadpoint reports charging=true, writes
 * Cerbo MaxDischargePower=0 (HOLD) so the EV draws from the grid rather than
 * the battery. When charging stops, releases the cap (MaxDischargePower=-1).
 *
 * The cap can be customised per config: holdValueW (default 0). For Stage-2-style
 * use cases ("don't pull more than 8 kW from the battery") set holdValueW: 8000.
 *
 * Only writes on edge transitions (start/stop) to avoid log spam and to leave
 * room for manual operator overrides between events.
 */
import { safeInterval } from './services/safe-async.js';
import http from 'node:http';
import https from 'node:https';

const SOURCE_ID = 'evcc_battery_protect';

function fetchJson(urlStr, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error(`invalid url: ${e.message}`)); }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { timeout: timeoutMs, headers: { 'accept': 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 5_000_000) {
          req.destroy();
          reject(new Error('payload too large'));
        }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`json parse: ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('evcc timeout')));
    req.on('error', reject);
  });
}

function anyCharging(state) {
  const lps = Array.isArray(state?.loadpoints) ? state.loadpoints : [];
  // chargePower > 100 W gate filters phantom "charging" flags during handshake/disconnect.
  return lps.some((lp) => lp && lp.charging === true && Number(lp.chargePower) > 100);
}

export function createEvccIntegration(ctx) {
  const getCfg = () => (ctx.getCfg().evcc) || {};

  let timer = null;
  let lastCharging = false;
  let lastTransitionAt = 0;
  let lastPolledAt = 0;
  let lastError = null;
  let lastChargePower = 0;
  let lastBatterySoc = null;

  async function tick() {
    const c = getCfg();
    if (c.enabled === false) return;
    const url = c.url;
    if (!url) {
      lastError = 'no url configured';
      return;
    }

    let state;
    try {
      state = await fetchJson(new URL('/api/state', url).toString(), { timeoutMs: Number(c.requestTimeoutMs) || 5000 });
      lastPolledAt = Date.now();
      lastError = null;
    } catch (e) {
      lastError = e.message;
      ctx.pushLog?.('evcc_poll_error', { error: e.message });
      return;
    }

    const charging = anyCharging(state);
    lastChargePower = state?.loadpoints?.[0]?.chargePower ?? 0;
    lastBatterySoc = state?.battery?.soc ?? null;

    if (charging === lastCharging) return; // no edge → no write

    const holdValueW = Number.isFinite(Number(c.holdValueW)) ? Number(c.holdValueW) : 0;
    const releaseValueW = Number.isFinite(Number(c.releaseValueW)) ? Number(c.releaseValueW) : -1;
    const cap = charging ? holdValueW : releaseValueW;

    try {
      const result = await ctx.applyControlTarget('maxDischargeW', cap, SOURCE_ID);
      if (result?.ok) {
        lastCharging = charging;
        lastTransitionAt = Date.now();
        ctx.pushLog?.('evcc_battery_protect', {
          charging,
          cap,
          chargePower: lastChargePower,
          batterySoc: lastBatterySoc,
          loadpointTitle: state?.loadpoints?.[0]?.title ?? null
        });
      } else {
        ctx.pushLog?.('evcc_battery_protect_rejected', { charging, cap, error: result?.error });
      }
    } catch (e) {
      ctx.pushLog?.('evcc_battery_protect_error', { error: e.message });
    }
  }

  return {
    start() {
      const c = getCfg();
      if (c.enabled === false) return;
      const intervalMs = Math.max(5000, Number(c.pollIntervalMs) || 15000);
      // First tick immediately so a freshly-started dvhub catches an already-charging EV.
      tick();
      timer = safeInterval('evcc-integration.tick', tick, intervalMs);
      console.log(`[evcc] integration started, polling ${c.url} every ${intervalMs}ms`);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    getStatus() {
      const c = getCfg();
      return {
        enabled: c.enabled !== false,
        url: c.url || null,
        charging: lastCharging,
        lastPolledAt,
        lastTransitionAt,
        lastError,
        lastChargePower,
        lastBatterySoc
      };
    }
  };
}
