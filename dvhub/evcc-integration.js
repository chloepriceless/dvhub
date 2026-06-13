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

// POST with an empty body (used for evcc's mode-set endpoint, which takes the
// mode in the URL path and ignores the request body).
function postEmpty(urlStr, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error(`invalid url: ${e.message}`)); }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'POST',
      timeout: timeoutMs,
      headers: { accept: 'application/json', 'content-length': 0 }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) { req.destroy(); reject(new Error('payload too large')); }
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('evcc timeout')));
    req.on('error', reject);
    req.end();
  });
}

// evcc charge modes (REST `/api/loadpoints/{id}/mode/{mode}`).
const EVCC_MODES = ['off', 'pv', 'minpv', 'now'];

/**
 * Map an evcc state into a compact loadpoint list for the Family Dashboard.
 * Loadpoints are exposed with 1-based ids to match evcc's REST API
 * (`/api/loadpoints/1/...`).
 */
function deriveLoadpoints(state) {
  const lps = Array.isArray(state?.loadpoints) ? state.loadpoints : [];
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return lps.map((lp, i) => ({
    id: i + 1,
    title: (lp && typeof lp.title === 'string' && lp.title) ? lp.title : `Ladepunkt ${i + 1}`,
    mode: (lp && EVCC_MODES.includes(lp.mode)) ? lp.mode : null,
    charging: !!(lp && lp.charging === true),
    connected: !!(lp && lp.connected === true),
    chargePowerW: n(lp?.chargePower),
    vehicleTitle: (lp && (lp.vehicleTitle || lp.vehicleName)) || null,
    vehicleSocPct: n(lp?.vehicleSoc),
    vehicleRangeKm: n(lp?.vehicleRange),
    limitSocPct: n(lp?.effectiveLimitSoc ?? lp?.limitSoc),
    phasesActive: n(lp?.phasesActive)
  }));
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
  let lastLoadpoints = [];   // compact list for the Family Dashboard (deriveLoadpoints)

  async function tick() {
    const c = getCfg();
    const url = c.url;
    if (!url) {
      lastError = 'no url configured';
      lastLoadpoints = [];
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

    // Dashboard read — kept regardless of the battery-protect `enabled` flag so
    // the Family EV panel can show/control the loadpoints whenever a URL is set.
    lastLoadpoints = deriveLoadpoints(state);

    const charging = anyCharging(state);
    lastChargePower = state?.loadpoints?.[0]?.chargePower ?? 0;
    lastBatterySoc = state?.battery?.soc ?? null;

    // Battery-protect WRITE is the only part gated on `enabled` — the operator
    // may want the dashboard/control without the auto battery-hold behaviour.
    if (c.enabled === false) return;

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

  /**
   * Set an evcc loadpoint's charge mode. lpId is 1-based (matches getLoadpoints
   * + evcc REST). mode ∈ {off, pv, minpv, now}. Returns { ok, mode } / { ok:false, error }.
   */
  async function setMode(lpId, mode) {
    const c = getCfg();
    const url = c.url;
    if (!url) return { ok: false, error: 'no url configured' };
    if (!EVCC_MODES.includes(mode)) return { ok: false, error: 'invalid mode' };
    const id = Number(lpId);
    if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'invalid loadpoint' };
    try {
      const target = new URL(`/api/loadpoints/${id}/mode/${mode}`, url).toString();
      await postEmpty(target, { timeoutMs: Number(c.requestTimeoutMs) || 5000 });
      ctx.pushLog?.('evcc_mode_set', { loadpoint: id, mode });
      // Optimistic local update so the dashboard reflects the change immediately,
      // then a fresh poll re-syncs the authoritative state.
      const lp = lastLoadpoints.find((x) => x.id === id);
      if (lp) lp.mode = mode;
      tick().catch(() => {});
      return { ok: true, mode };
    } catch (e) {
      ctx.pushLog?.('evcc_mode_set_error', { loadpoint: id, mode, error: e.message });
      return { ok: false, error: e.message };
    }
  }

  return {
    start() {
      const c = getCfg();
      const intervalMs = Math.max(5000, Number(c.pollIntervalMs) || 15000);
      // Poll whenever a URL is configured (dashboard read), independent of the
      // battery-protect `enabled` flag. First tick immediately so a freshly
      // started dvhub catches an already-charging EV / current loadpoint state.
      if (!c.url) { console.log('[evcc] no url configured — integration idle'); return; }
      tick();
      timer = safeInterval('evcc-integration.tick', tick, intervalMs);
      console.log(`[evcc] integration started, polling ${c.url} every ${intervalMs}ms (battery-protect ${c.enabled === false ? 'OFF' : 'ON'})`);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    getLoadpoints() {
      return lastLoadpoints.map((lp) => ({ ...lp }));
    },
    setMode,
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
        lastBatterySoc,
        loadpoints: lastLoadpoints.map((lp) => ({ ...lp }))
      };
    }
  };
}
