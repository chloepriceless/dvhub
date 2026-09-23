/**
 * evcc integration — evcc ist nur Durchreiche zur Wallbox.
 *
 * Liest evcc's /api/state (Ladepunkte, Fahrzeug, Ladeleistung) und setzt auf
 * Anweisung Modus/Ladestrom (setMode/setMaxCurrent, genutzt von der EOS-Bruecke
 * und dem Family-Dashboard). Der Hausakku wird hier NICHT angefasst: ob das
 * Auto aus Akku, Netz oder anteilig geladen wird, entscheidet EOS.
 * (Der fruehere Akkuschutz — maxDischargeW=0 waehrend des Ladens — ist
 * 2026-09-23 entfallen; er uebersteuerte EOS' Plan.)
 */
import { safeInterval } from './services/safe-async.js';
import http from 'node:http';
import https from 'node:https';


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
    // Fuer die EOS-Bruecke: was der Ladepunkt kann (Einstellungen in evcc).
    minCurrentA: n(lp?.minCurrent),
    maxCurrentA: n(lp?.maxCurrent),
    phasesConfigured: n(lp?.phasesConfigured),
    vehicleRangeKm: n(lp?.vehicleRange),
    limitSocPct: n(lp?.effectiveLimitSoc ?? lp?.limitSoc),
    phasesActive: n(lp?.phasesActive)
  }));
}

export function createEvccIntegration(ctx) {
  const getCfg = () => (ctx.getCfg().evcc) || {};

  let timer = null;
  let lastCharging = false;
  let lastPolledAt = 0;
  let lastError = null;
  let lastChargePower = 0;
  let lastBatterySoc = null;
  let lastLoadpoints = [];   // compact list for the Family Dashboard (deriveLoadpoints)
  // Fehler, die evcc selbst meldet (z.B. Wallbox nicht anlegbar) — ohne sie
  // sieht "0 Ladepunkte" aus wie "nicht erreichbar".
  let lastFatal = [];

  async function tick() {
    const c = getCfg();
    const url = c.url;
    if (!url) {
      lastError = 'no url configured';
      lastLoadpoints = [];
      lastFatal = [];
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
    lastFatal = (Array.isArray(state?.fatal) ? state.fatal : [])
      .map((f) => ({ class: f?.class || null, device: f?.device || null, error: String(f?.error || '').slice(0, 300) }))
      .slice(0, 10);

    lastCharging = anyCharging(state);
    lastChargePower = state?.loadpoints?.[0]?.chargePower ?? 0;
    lastBatterySoc = state?.battery?.soc ?? null;
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

  /**
   * Set an evcc loadpoint's maximum charge current (A per phase). Used by the
   * EOS → evcc bridge to pass EOS' planned charge rate on. lpId is 1-based.
   */
  async function setMaxCurrent(lpId, currentA) {
    const c = getCfg();
    const url = c.url;
    if (!url) return { ok: false, error: 'no url configured' };
    const id = Number(lpId);
    if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'invalid loadpoint' };
    const a = Number(currentA);
    // 6 A ist das Norm-Minimum (IEC 61851), 63 A die groesste AC-Wallbox.
    if (!Number.isFinite(a) || a < 6 || a > 63) return { ok: false, error: 'invalid current' };
    try {
      const target = new URL(`/api/loadpoints/${id}/maxcurrent/${a}`, url).toString();
      await postEmpty(target, { timeoutMs: Number(c.requestTimeoutMs) || 5000 });
      ctx.pushLog?.('evcc_maxcurrent_set', { loadpoint: id, currentA: a });
      return { ok: true, currentA: a };
    } catch (e) {
      ctx.pushLog?.('evcc_maxcurrent_set_error', { loadpoint: id, currentA: a, error: e.message });
      return { ok: false, error: e.message };
    }
  }

  return {
    start() {
      const c = getCfg();
      const intervalMs = Math.max(5000, Number(c.pollIntervalMs) || 15000);
      // Poll whenever a URL is configured. First tick immediately so a freshly
      // started dvhub has the current loadpoint state.
      // Der Takt laeuft auch ohne URL: tick() prueft sie jedes Mal. Sonst
      // wirkt eine spaeter in den Integrationen eingetragene Adresse erst nach
      // einem Neustart.
      tick();
      timer = safeInterval('evcc-integration.tick', tick, intervalMs);
      console.log(c.url
        ? `[evcc] integration started, polling ${c.url} every ${intervalMs}ms`
        : '[evcc] no url configured yet — polling starts once one is set');
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    getLoadpoints() {
      return lastLoadpoints.map((lp) => ({ ...lp }));
    },
    setMode,
    setMaxCurrent,
    getStatus() {
      const c = getCfg();
      return {
        url: c.url || null,
        charging: lastCharging,
        lastPolledAt,
        lastError,
        lastChargePower,
        lastBatterySoc,
        fatal: lastFatal.map((f) => ({ ...f })),
        loadpoints: lastLoadpoints.map((lp) => ({ ...lp }))
      };
    }
  };
}
